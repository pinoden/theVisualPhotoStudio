/**
 * Shared set-up for server tests: an in-memory PostgreSQL (PGlite) with the
 * real migrations and starting catalog, a fixed "now", and a card processor
 * that records what it was asked to do. Not used by the application.
 */
import { desc, eq, sql } from "drizzle-orm";
import { createMemoryDb, type Db } from "@/db/client";
import { emailOutbox, studios, users } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Role } from "./auth";
import { createBooking, type BookingDeps, type BookingInput } from "./bookings";
import type { ManageDeps } from "./manage";
import {
  MOCK_TOKEN_OK,
  mockProvider,
  monthsAfter,
  type ChargeRequest,
  type PayLinkRequest,
  type PayLinkState,
  type PaymentProvider,
  type RefundRequest,
  type RefundState,
} from "./payments";

/** A payment link the test processor was asked to make, and what the test says became of it. */
export interface TestPayLink {
  request: PayLinkRequest;
  linkId: string;
  orderId: string;
  /** What the processor answers when asked about it. A test sets this to say "the client paid". */
  state: PayLinkState;
}

/**
 * A membership's subscription at the test processor (follow-up 3). It bills nothing by itself: a test bills its
 * months (`world.billMonth`), paid or not, and says when it was stopped.
 */
export interface TestSubscription {
  id: string;
  customerId: string;
  cardId: string;
  variationId: string;
  startDate: string;
  idempotencyKey: string;
  /** The day it ends, once cancelled. */
  endsOn: string | null;
  stopped: boolean;
  /** The months billed, oldest first. */
  invoices: { id: string; paid: boolean; amountCents: number; day: string }[];
}

/** Which step of a membership's billing the test processor refuses, while `failMembership` is set. */
export type MembershipStep = "customer" | "card" | "price" | "subscribe" | "cancel" | "state";

/** Saturday 2026-11-14, 10:00 in Winter Park (EST, UTC-5). */
export const NOW = new Date("2026-11-14T15:00:00Z");
/** Wednesday, 4 days ahead: inside the 14-day refund window, outside the 24-hour notice. */
export const NEAR = "2026-11-18";
/** Wednesday, 25 days ahead: refundable. */
export const FAR = "2026-12-09";
export const OWNER_EMAIL = "owner@studio.test";
export const BASE_URL = "https://studio.test";

export const h = (hours: number) => hours * 60;
/**
 * An amount in cents as a value of its own in serialized data (`"totalCents":7800`), never four digits inside a random
 * id (`…-7800-…` in a uuid): a test that an amount is absent would otherwise fail now and then by chance.
 */
export const asAmount = (cents: number) => new RegExp(`(?<![\\w-])${cents}(?![\\w-])`);
export const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
export const hoursAfter = (date: Date, hours: number) => minutesAfter(date, hours * 60);
export const daysAfter = (date: Date, days: number) => hoursAfter(date, days * 24);

export interface TestWorld {
  db: Db;
  close(): Promise<void>;
  /** Studio ids by slug: blanche, dayglow, paris. Refreshed by reset(). */
  ids: Record<string, string>;
  charges: ChargeRequest[];
  refundCalls: RefundRequest[];
  /** While set, every refund fails with this message. */
  failRefunds: string | null;
  /** While true, the processor accepts refunds as pending, as Square mostly does, instead of completing them at once. */
  pendingRefunds: boolean;
  /** What the processor says when asked about a refund it accepted. */
  refundAnswer: RefundState;
  /** The processor's payment ids it was asked to take, and to give back, after reserving them. */
  captures: string[];
  releases: string[];
  /** While set, taking a reserved amount fails with this message. */
  failCaptures: string | null;
  /** Payment links made so far, oldest first. */
  links: TestPayLink[];
  /** While set, the processor refuses to make or cancel a link, with this message. */
  failLinks: string | null;
  /** Memberships' subscriptions, oldest first. */
  subscriptions: TestSubscription[];
  /** Prices made for plans, by their idempotency key. */
  planPrices: Map<string, { processorPlanId: string; variationId: string; priceCents: number }>;
  /** While set, the processor refuses this step of a membership's billing, with the message. */
  failMembership: { step: MembershipStep; message: string } | null;
  /** Bill a subscription's next month, at its variation's price: paid unless `paid` is false. */
  billMonth(subscriptionId: string, paid?: boolean): TestSubscription;
  provider: PaymentProvider;
  /** Wipe all data and restore the starting catalog. */
  reset(): Promise<void>;
  book(overrides?: Partial<BookingInput>, deps?: Partial<BookingDeps>): ReturnType<typeof createBooking>;
  /** Dependencies for the functions in manage.ts, with the recording processor. */
  manageDeps(overrides?: Partial<ManageDeps>): ManageDeps;
  /** Emails queued so far, oldest first, optionally of one kind. */
  emails(kind?: string): Promise<{ toEmail: string; subject: string; body: string; kind: string }[]>;
  addUser(email: string, role: Role, name?: string): Promise<{ id: string; email: string; name: string; role: Role }>;
}

export async function createTestWorld(): Promise<TestWorld> {
  const { db, close } = await createMemoryDb();

  const world: TestWorld = {
    db,
    close,
    ids: {},
    charges: [],
    refundCalls: [],
    failRefunds: null,
    pendingRefunds: false,
    refundAnswer: { state: "completed" },
    captures: [],
    releases: [],
    failCaptures: null,
    links: [],
    failLinks: null,
    subscriptions: [],
    planPrices: new Map(),
    failMembership: null,
    billMonth(subscriptionId, paid = true) {
      const subscription = world.subscriptions.find((candidate) => candidate.id === subscriptionId);
      if (!subscription) throw new Error(`No subscription ${subscriptionId}`);
      const price = [...world.planPrices.values()].find((made) => made.variationId === subscription.variationId)?.priceCents ?? 0;
      const day = monthsAfter(subscription.startDate, subscription.invoices.length);
      subscription.invoices.push({ id: `${subscriptionId}_invoice_${subscription.invoices.length + 1}`, paid, amountCents: price, day });
      return subscription;
    },
    provider: {
      name: "mock",
      memberships: {
        async createCustomer(input) {
          if (world.failMembership?.step === "customer") return { ok: false, message: world.failMembership.message };
          return { ok: true, customerId: `customer_${input.idempotencyKey}` };
        },
        async saveCard(input) {
          if (world.failMembership?.step === "card") return { ok: false, message: world.failMembership.message };
          if (!world.charges.some((charge) => `mock_${charge.idempotencyKey}` === input.paymentId)) return { ok: false, message: "No such payment." };
          return { ok: true, cardId: `card_${input.idempotencyKey}` };
        },
        async createPlanPrice(input) {
          if (world.failMembership?.step === "price") return { ok: false, message: world.failMembership.message };
          const made = world.planPrices.get(input.idempotencyKey) ?? {
            processorPlanId: input.processorPlanId ?? `plan_${world.planPrices.size + 1}`,
            variationId: `price_${world.planPrices.size + 1}`,
            priceCents: input.priceCents,
          };
          world.planPrices.set(input.idempotencyKey, made);
          return { ok: true, processorPlanId: made.processorPlanId, variationId: made.variationId };
        },
        async subscribe(input) {
          if (world.failMembership?.step === "subscribe") return { ok: false, message: world.failMembership.message };
          const again = world.subscriptions.find((subscription) => subscription.idempotencyKey === input.idempotencyKey);
          if (again) return { ok: true, subscriptionId: again.id };
          const subscription: TestSubscription = { id: `sub_${world.subscriptions.length + 1}`, ...input, endsOn: null, stopped: false, invoices: [] };
          world.subscriptions.push(subscription);
          return { ok: true, subscriptionId: subscription.id };
        },
        async cancelSubscription(subscriptionId) {
          if (world.failMembership?.step === "cancel") return { ok: false, message: world.failMembership.message };
          const subscription = world.subscriptions.find((candidate) => candidate.id === subscriptionId);
          if (!subscription) return { ok: false, message: "No such subscription." };
          // As Square does: the month paid for runs to its end, and one that has not started ends on its first day.
          subscription.endsOn ??= monthsAfter(subscription.startDate, subscription.invoices.filter((invoice) => invoice.paid).length);
          return { ok: true, endsOn: subscription.endsOn };
        },
        async subscriptionState(subscriptionId) {
          if (world.failMembership?.step === "state") return { state: "unknown", message: world.failMembership.message };
          const subscription = world.subscriptions.find((candidate) => candidate.id === subscriptionId);
          if (!subscription) return { state: "unknown", message: "No such subscription." };
          const paid = subscription.invoices.filter((invoice) => invoice.paid).length;
          return {
            state: subscription.stopped ? "stopped" : subscription.endsOn ? "cancelled" : subscription.invoices.length > 0 ? "active" : "pending",
            paidThrough: paid > 0 ? monthsAfter(subscription.startDate, paid) : null,
            endsOn: subscription.endsOn,
            invoices: [...subscription.invoices].reverse(),
          };
        },
      },
      async charge(request) {
        const result = await mockProvider.charge(request);
        if (result.ok) world.charges.push(request);
        return result;
      },
      async refund(request) {
        world.refundCalls.push(request);
        if (world.failRefunds) return { ok: false, message: world.failRefunds };
        const result = await mockProvider.refund(request);
        return result.ok ? { ...result, settled: !world.pendingRefunds } : result;
      },
      async refundState() {
        return world.refundAnswer;
      },
      async capture(paymentId) {
        world.captures.push(paymentId);
        if (world.failCaptures) return { ok: false, message: world.failCaptures };
        return mockProvider.capture(paymentId);
      },
      async release(paymentId) {
        world.releases.push(paymentId);
        return mockProvider.release(paymentId);
      },
      // A processor with a page of its own, as Square has: the test decides when a link is paid.
      async createPayLink(request) {
        if (world.failLinks) return { ok: false, message: world.failLinks };
        const again = world.links.find((link) => link.request.idempotencyKey === request.idempotencyKey);
        const n = world.links.length + 1;
        const link = again ?? { request, linkId: `link_${n}`, orderId: `order_${n}`, state: { state: "open" } as PayLinkState };
        if (!again) world.links.push(link);
        return { ok: true, linkId: link.linkId, orderId: link.orderId, url: `https://pay.test/${link.linkId}` };
      },
      async payLinkState({ linkId }) {
        return world.links.find((link) => link.linkId === linkId)?.state ?? { state: "unknown", message: "No such link" };
      },
      async cancelPayLink(linkId) {
        if (world.failLinks) return { ok: false, message: world.failLinks };
        const link = world.links.find((candidate) => candidate.linkId === linkId);
        if (link) link.state = { state: "cancelled" };
        return { ok: true };
      },
      // A processor with receipts of its own, as Square has.
      async receiptOf(paymentId) {
        return { ok: true, url: `https://squareup.test/receipt/preview/${paymentId}` };
      },
    },

    async reset() {
      await db.execute(sql`
        truncate videos, waitlist_entries, booking_answers, booking_acceptances, agreement_versions, agreements, intake_questions, email_outbox, email_templates, membership_plans, booking_charges, payment_links, refunds, payments, booking_addons, studio_holds, blocks, bookings,
          promo_codes, special_dates, settings, sessions, login_codes, rate_limit_hits, customer_views, staff_shifts, users,
          price_rules, studio_hours, addons, studios, photographers, site_versions, site_documents,
          media_collection_items, media_collections, studio_photos, media, site_font_files, site_fonts, site_files, site_redirects cascade
      `);
      await seed(db);
      const rows = await db.select({ id: studios.id, slug: studios.slug }).from(studios);
      for (const key of Object.keys(world.ids)) delete world.ids[key];
      for (const row of rows) world.ids[row.slug] = row.id;
      world.charges.length = 0;
      world.refundCalls.length = 0;
      world.failRefunds = null;
      world.pendingRefunds = false;
      world.refundAnswer = { state: "completed" };
      world.captures.length = 0;
      world.releases.length = 0;
      world.failCaptures = null;
      world.links.length = 0;
      world.failLinks = null;
      world.subscriptions.length = 0;
      world.planPrices.clear();
      world.failMembership = null;
    },

    book(overrides = {}, deps = {}) {
      const input: BookingInput = {
        studioIds: [world.ids.blanche],
        date: NEAR,
        startMinute: h(10),
        durationMinutes: 120,
        customer: { name: "Jane Smith", email: "jane@example.com", phone: "407-555-0100" },
        acceptTerms: true,
        paymentToken: MOCK_TOKEN_OK,
        ...overrides,
      };
      return createBooking(db, input, { now: NOW, payments: world.provider, baseUrl: BASE_URL, ...deps });
    },

    manageDeps(overrides = {}) {
      return { now: NOW, payments: world.provider, ownerEmail: OWNER_EMAIL, baseUrl: BASE_URL, ...overrides };
    },

    async emails(kind) {
      const rows = await db
        .select({
          toEmail: emailOutbox.toEmail,
          subject: emailOutbox.subject,
          body: emailOutbox.body,
          kind: emailOutbox.kind,
          createdAt: emailOutbox.createdAt,
        })
        .from(emailOutbox)
        .where(kind ? eq(emailOutbox.kind, kind) : undefined)
        .orderBy(desc(emailOutbox.createdAt));
      return rows.reverse();
    },

    async addUser(email, role, name = "") {
      const [row] = await db.insert(users).values({ email, role, name }).returning();
      return { id: row.id, email: row.email, name: row.name, role: row.role };
    },
  };

  await world.reset();
  return world;
}

/** Narrow a result to its success branch, failing the test with the message otherwise. */
export function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`Expected success, got: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}
