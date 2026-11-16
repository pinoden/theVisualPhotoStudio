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
  type ChargeRequest,
  type PayLinkRequest,
  type PayLinkState,
  type PaymentProvider,
  type RefundRequest,
} from "./payments";

/** A payment link the test processor was asked to make, and what the test says became of it. */
export interface TestPayLink {
  request: PayLinkRequest;
  linkId: string;
  orderId: string;
  /** What the processor answers when asked about it. A test sets this to say "the client paid". */
  state: PayLinkState;
}

/** Saturday 2026-11-14, 10:00 in Winter Park (EST, UTC-5). */
export const NOW = new Date("2026-11-14T15:00:00Z");
/** Wednesday, 4 days ahead: inside the 14-day refund window, outside the 24-hour notice. */
export const NEAR = "2026-11-18";
/** Wednesday, 25 days ahead: refundable. */
export const FAR = "2026-12-09";
export const OWNER_EMAIL = "owner@studio.test";
export const BASE_URL = "https://studio.test";

export const h = (hours: number) => hours * 60;
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
  /** Payment links made so far, oldest first. */
  links: TestPayLink[];
  /** While set, the processor refuses to make or cancel a link, with this message. */
  failLinks: string | null;
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
    links: [],
    failLinks: null,
    provider: {
      name: "mock",
      async charge(request) {
        const result = await mockProvider.charge(request);
        if (result.ok) world.charges.push(request);
        return result;
      },
      async refund(request) {
        world.refundCalls.push(request);
        if (world.failRefunds) return { ok: false, message: world.failRefunds };
        return mockProvider.refund(request);
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
    },

    async reset() {
      await db.execute(sql`
        truncate email_outbox, payment_links, refunds, payments, booking_addons, studio_holds, blocks, bookings,
          promo_codes, special_dates, settings, sessions, login_codes, staff_shifts, users,
          price_rules, studio_hours, addons, studios, photographers, site_versions, site_documents cascade
      `);
      await seed(db);
      const rows = await db.select({ id: studios.id, slug: studios.slug }).from(studios);
      for (const key of Object.keys(world.ids)) delete world.ids[key];
      for (const row of rows) world.ids[row.slug] = row.id;
      world.charges.length = 0;
      world.refundCalls.length = 0;
      world.failRefunds = null;
      world.links.length = 0;
      world.failLinks = null;
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
