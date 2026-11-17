import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres range of instants. Written with `tstzrange(a, b, '[)')`, read with lower()/upper(). */
export const tstzrange = customType<{ data: string }>({
  dataType() {
    return "tstzrange";
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => ts("created_at").notNull().defaultNow();

/** `staff` is a Studio Attendant and `manager` a Studio Manager: see src/lib/abilities.ts. Owners are not stored: they are the addresses in OWNER_EMAILS. */
export const userRole = pgEnum("user_role", ["customer", "staff", "owner", "manager"]);
export const dayType = pgEnum("day_type", ["weekday", "weekend"]);
export const bookingStatus = pgEnum("booking_status", [
  "pending_payment", // slot held, card not charged yet
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
  "expired", // payment never completed, slot released
]);
/** `voided`: a payment recorded by hand in error, and taken back by an owner. */
/**
 * A card payment of a booking is `pending` while it is on its way, then
 * `authorized` (the amount reserved on the card), then `succeeded` once the
 * money is taken; `failed` when it is refused or given back. `voided`: a
 * payment recorded at the studio by mistake, struck out.
 */
export const paymentStatus = pgEnum("payment_status", ["pending", "authorized", "succeeded", "failed", "voided"]);
export const refundStatus = pgEnum("refund_status", ["pending", "succeeded", "failed"]);
export const paymentLinkStatus = pgEnum("payment_link_status", ["open", "paid", "cancelled"]);
export const promoKind = pgEnum("promo_kind", ["percent", "amount", "free_hour"]);
/** `pet_fee`: the pet fee of a booking, given back as studio credit because the pet did not come. */
export const promoSource = pgEnum("promo_source", ["loyalty", "reschedule", "manual", "pet_fee"]);
export const cancelReason = pgEnum("cancel_reason", ["customer", "rescheduled", "owner"]);
/** A label an administrator puts on a confirmed booking. See src/lib/domain/labels.ts. */
export const bookingLabel = pgEnum("booking_label", ["checked_in", "reschedule_pending", "rescheduled"]);

// ── People ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: id(),
  /** Always stored lowercase. */
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  role: userRole("role").notNull().default("customer"),
  createdAt: createdAt(),
});

/** One-time sign-in codes sent by email. Only a hash of the code is stored. */
export const loginCodes = pgTable(
  "login_codes",
  {
    id: id(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: ts("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("login_codes_email_idx").on(t.email)],
);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

/** Dates a staff member is allowed to see. Staff see nothing outside these. */
export const staffShifts = pgTable(
  "staff_shifts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

// ── Catalog ──────────────────────────────────────────────────────────────────

export const studios = pgTable("studios", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  description: text("description").notNull().default(""),
  /** Guests included in the price. */
  includedGuests: integer("included_guests").notNull().default(6),
  /**
   * Minutes kept free after every booking, so that appointments are at least this far apart.
   * 15 is the owner's rule: 7 minutes before and 7 after each appointment, drawn so in the calendar.
   */
  bufferMinutes: integer("buffer_minutes").notNull().default(15),
  /** The studio's colour in the admin calendar, the same in every view. A hex colour. */
  color: text("color").notNull().default("#8a7f72"),
  /** Its size, ceiling, light, cyclorama, what comes with it and a floor plan: see src/lib/studio-facts.ts. Read through `parseStudioFacts`. */
  facts: jsonb("facts").notNull().default({}),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

/** Opening hours. No row for a weekday means the studio is closed that day. */
export const studioHours = pgTable(
  "studio_hours",
  {
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    /** ISO weekday: 1 = Monday ... 7 = Sunday. */
    weekday: integer("weekday").notNull(),
    openMinute: integer("open_minute").notNull(),
    closeMinute: integer("close_minute").notNull(),
  },
  (t) => [primaryKey({ columns: [t.studioId, t.weekday] })],
);

// ── Photography ──────────────────────────────────────────────────────────────

/**
 * A photographer who can be booked together with a studio. A resource like a
 * studio: one photographer cannot be in two places at once, whatever the
 * studios. The site starts with one, the in-house photographer.
 */
export const photographers = pgTable("photographers", {
  id: id(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

/**
 * The limits of a photographer's availability: the hours they are ready to
 * work, by weekday. A missing weekday means they do not work that day.
 */
export const photographerHours = pgTable(
  "photographer_hours",
  {
    photographerId: uuid("photographer_id")
      .notNull()
      .references(() => photographers.id, { onDelete: "cascade" }),
    /** ISO weekday: 1 = Monday ... 7 = Sunday. */
    weekday: integer("weekday").notNull(),
    openMinute: integer("open_minute").notNull(),
    closeMinute: integer("close_minute").notNull(),
  },
  (t) => [primaryKey({ columns: [t.photographerId, t.weekday] })],
);

/**
 * A photography session on sale: one studio, one length, one price. The
 * price includes the studio. Taken from the studio's live price list.
 */
export const photoPackages = pgTable(
  "photo_packages",
  {
    id: id(),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    durationMinutes: integer("duration_minutes").notNull(),
    priceCents: integer("price_cents").notNull(),
    /** What the session includes, as the customer reads it: "1-2 outfits, 20 edited images". */
    includes: text("includes").notNull().default(""),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("photo_packages_studio_duration_idx").on(t.studioId, t.durationMinutes)],
);

/** Price of one studio for one duration on a weekday or weekend day. */
export const priceRules = pgTable(
  "price_rules",
  {
    id: id(),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    dayType: dayType("day_type").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    priceCents: integer("price_cents").notNull(),
  },
  (t) => [uniqueIndex("price_rules_unique").on(t.studioId, t.dayType, t.durationMinutes)],
);

/** Dates priced as a different day type than the calendar says (holidays). */
export const specialDates = pgTable("special_dates", {
  day: date("day", { mode: "string" }).primaryKey(),
  dayType: dayType("day_type").notNull(),
  note: text("note").notNull().default(""),
});

export const addons = pgTable("addons", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  priceCents: integer("price_cents").notNull(),
  /** null = any booking; otherwise only bookings that include this studio. */
  studioId: uuid("studio_id").references(() => studios.id, { onDelete: "cascade" }),
  maxQuantity: integer("max_quantity").notNull().default(1),
  /**
   * What the add-on is for. The guest information page reads it to say whether
   * larger groups and pets can be booked, so those answers follow what is
   * offered and not what an add-on happens to be called.
   */
  kind: text("kind", { enum: ["people", "pet", "other"] }).notNull().default("other"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

/** Business rules the owner can change. Defaults live in src/server/settings.ts. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

// ── Bookings ─────────────────────────────────────────────────────────────────

export const promoCodes = pgTable("promo_codes", {
  id: id(),
  code: text("code").notNull().unique(),
  kind: promoKind("kind").notNull(),
  /** percent: 1-100. amount: cents still available. free_hour: the minutes that are free (60). */
  value: integer("value").notNull(),
  /** When set, only this customer email may use the code. */
  email: text("email"),
  source: promoSource("source").notNull().default("manual"),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: ts("expires_at"),
  /**
   * For reschedule credits: how many times the money behind this code has
   * already been moved. A booking paid with the code inherits this count.
   */
  rescheduleGeneration: integer("reschedule_generation").notNull().default(0),
  /** The booking this code was issued for (the visit rewarded, or the booking moved). */
  originBookingId: uuid("origin_booking_id"),
  /**
   * For a free hour earned by visits: which one of this customer's it is (1 for their first, 2 for their
   * second). The database allows each number once per customer, so the same reward cannot be sent twice,
   * also when it was earned through a correction and no single visit stands for it.
   */
  loyaltySeq: integer("loyalty_seq"),
  /** Set when the owner cancels a code. */
  voidedAt: ts("voided_at"),
  /**
   * `value` when the code was issued. For a code of credit, what was used of
   * it is this less what is left (`value`), whatever became of the bookings it
   * paid for: a pet fee's credit can be only part of the fee.
   */
  issuedCents: integer("issued_cents"),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
});

/**
 * What an administrator changed by hand in a customer's loyalty: stamps added
 * or taken away, a reward cancelled or given back. One row per change, with
 * who made it, when and why; nothing here is ever edited or removed. Stamps
 * earned by visits are not stored: they are counted from the completed visits
 * themselves, so one visit can never give two. See src/server/loyalty.ts.
 */
export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: id(),
    /** The customer, by the email address their visits are counted under. Lowercase. */
    email: text("email").notNull(),
    kind: text("kind", { enum: ["stamps", "reward_cancelled", "reward_restored"] }).notNull(),
    /** For `stamps`: how many were added (positive) or taken away (negative). 0 for the other kinds. */
    stamps: integer("stamps").notNull().default(0),
    /** For the reward kinds: the code that was cancelled or given back. */
    codeId: uuid("code_id").references(() => promoCodes.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    /** The administrator who made the change. */
    actor: text("actor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("loyalty_ledger_email_idx").on(t.email)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    /** Short human reference, e.g. VS-7K2M9Q. */
    ref: text("ref").notNull().unique(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone").notNull().default(""),
    notes: text("notes").notNull().default(""),

    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    status: bookingStatus("status").notNull().default("pending_payment"),
    /** Set by an administrator while the booking is confirmed; it keeps holding its time. */
    label: bookingLabel("label"),
    /** While pending_payment, the slot is released after this moment. */
    holdExpiresAt: ts("hold_expires_at"),

    studiosSubtotalCents: integer("studios_subtotal_cents").notNull(),
    multiStudioDiscountCents: integer("multi_studio_discount_cents").notNull().default(0),
    addonsCents: integer("addons_cents").notNull().default(0),
    promoDiscountCents: integer("promo_discount_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    promoCodeId: uuid("promo_code_id").references(() => promoCodes.id, { onDelete: "set null" }),
    /**
     * The part of promoDiscountCents that was money the customer had already
     * paid (a reschedule credit), as opposed to a discount.
     */
    creditAppliedCents: integer("credit_applied_cents").notNull().default(0),

    /** A booking that has been moved can no longer be refunded. */
    rescheduledCount: integer("rescheduled_count").notNull().default(0),
    /** Set on a photography session: the photographer it holds. */
    photographerId: uuid("photographer_id").references(() => photographers.id, { onDelete: "set null" }),
    /** What the session includes, as it was sold: kept with the booking when the package changes later. */
    photoIncludes: text("photo_includes"),
    /**
     * The administrator's address when the booking was made in the admin for a client. Null for a
     * booking the customer made online. Nothing is charged online for an administrator's booking.
     */
    madeBy: text("made_by"),
    /**
     * The kind of money the booking is, from the card processor set up when it was made: `test` with the pretend
     * processor or Square's sandbox, `live` with Square's live account or with none. Everything the booking makes is
     * that kind of money too: its payments, recorded by hand or not, its refunds, links and codes. See
     * src/server/test-mode.ts.
     */
    moneyKind: text("money_kind", { enum: ["test", "live"] }).notNull(),
    cancelReason: cancelReason("cancel_reason"),
    /** Hash of the secret in the customer's manage link. */
    manageTokenHash: text("manage_token_hash").notNull(),
    /**
     * The SHA-256 of the id the booking screen gave this attempt to book.
     * The screen sends the id again when it got no answer, so that a booking
     * made and paid whose answer was lost is found, not made or charged
     * twice. Only its hash is kept: the id works like a password for the
     * booking. Null for a booking made in the admin, and for older ones.
     */
    requestKey: text("request_key"),
    /** Hash of the secret of a second manage link, given to the screen that asked again for a booking it had made. */
    retryTokenHash: text("retry_token_hash"),
    termsAcceptedAt: ts("terms_accepted_at"),
    /** When this completed visit was counted for loyalty (a free hour may or may not have followed). */
    loyaltyIssuedAt: ts("loyalty_issued_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("bookings_email_idx").on(t.customerEmail),
    index("bookings_start_idx").on(t.startAt),
    uniqueIndex("bookings_request_key").on(t.requestKey).where(sql`${t.requestKey} is not null`),
    check("bookings_money_kind", sql`${t.moneyKind} in ('test', 'live')`),
  ],
);

/**
 * The history of a booking's status label: one row for every change, with who
 * made it and when. Written by the same transaction as the change itself.
 */
export const bookingEvents = pgTable(
  "booking_events",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    at: ts("at").notNull(),
    /** Labels as in LABEL_TEXT: confirmed, checked_in, completed, rescheduled, no_show, reschedule_pending, cancelled. */
    fromLabel: text("from_label").notNull(),
    toLabel: text("to_label").notNull(),
    /** An administrator's email address, or "customer", or "system". */
    actor: text("actor").notNull(),
    /** What else happened, for example the old and the new time of a move. */
    note: text("note").notNull().default(""),
    /** The clock when the line was written. It orders two changes that carry the same `at`. */
    recordedAt: ts("recorded_at").notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index("booking_events_booking_idx").on(t.bookingId, t.at)],
);

/** An owner-made block of time (maintenance, private event). */
export const blocks = pgTable("blocks", {
  id: id(),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
});

/**
 * Every span of time during which a studio is taken, by a booking or a block.
 * A database exclusion constraint (added in a hand-written migration) forbids
 * two active holds on the same studio from overlapping, so a double booking
 * cannot be stored no matter how requests interleave.
 */
export const studioHolds = pgTable(
  "studio_holds",
  {
    id: id(),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
    /** Booking time plus the studio's clean-up buffer. */
    occupied: tstzrange("occupied").notNull(),
    active: boolean("active").notNull().default(true),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    blockId: uuid("block_id").references(() => blocks.id, { onDelete: "cascade" }),
    /** Price of this studio within the booking. */
    priceCents: integer("price_cents").notNull().default(0),
  },
  (t) => [index("studio_holds_booking_idx").on(t.bookingId)],
);

/**
 * Every span of time during which a photographer is taken: by a photography
 * session (with the gap kept after it), or blocked in the admin (time off).
 * An exclusion constraint, added by hand in the migration, forbids two active
 * holds of one photographer from overlapping, as for studios: the same
 * photographer cannot be booked twice for the same time, whatever the studio.
 */
export const photographerHolds = pgTable(
  "photographer_holds",
  {
    id: id(),
    photographerId: uuid("photographer_id")
      .notNull()
      .references(() => photographers.id, { onDelete: "restrict" }),
    occupied: tstzrange("occupied").notNull(),
    active: boolean("active").notNull().default(true),
    /** The session that holds the photographer. Null for time blocked in the admin. */
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    /** Why the time is blocked, when it is. */
    note: text("note").notNull().default(""),
  },
  (t) => [index("photographer_holds_booking_idx").on(t.bookingId)],
);

export const bookingAddons = pgTable(
  "booking_addons",
  {
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    addonId: uuid("addon_id")
      .notNull()
      .references(() => addons.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull(),
    unitCents: integer("unit_cents").notNull(),
    /**
     * What the add-on was for when it was booked (see `addons.kind`). Kept with the booking like its name
     * and price: the pet fee is refunded by its own rule, whatever the add-on is called or becomes later.
     */
    kind: text("kind", { enum: ["people", "pet", "other"] }).notNull().default("other"),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.addonId] })],
);

export const payments = pgTable("payments", {
  id: id(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "restrict" }),
  /** 'square' | 'mock' for a card charged through the site, 'manual' for money taken at the studio and recorded by hand. */
  provider: text("provider").notNull(),
  providerPaymentId: text("provider_payment_id"),
  amountCents: integer("amount_cents").notNull(),
  refundedCents: integer("refunded_cents").notNull().default(0),
  status: paymentStatus("status").notNull().default("pending"),
  error: text("error"),
  /** For a payment recorded by hand: how the money was taken. See src/lib/payment-methods.ts. Null for a card charged through the site. */
  method: text("method"),
  /** For a payment recorded by hand: the administrator who recorded it. */
  recordedBy: text("recorded_by"),
  /** What the administrator wrote beside it. */
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
});

/**
 * A request for payment emailed to a client: a page of the card processor
 * where they pay, by card, what a booking made in the admin still owes. Once
 * paid it becomes an ordinary row in `payments`. A booking has at most one
 * open link (an index written by hand in the migration), and while one is
 * open no payment can be recorded by hand: the client could pay twice.
 * See src/server/pay-links.ts.
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(), // 'square' | 'mock'
    /** The processor's ids of the link and of the order it stands for. The order says whether it was paid. */
    providerLinkId: text("provider_link_id").notNull(),
    providerOrderId: text("provider_order_id").notNull(),
    /** The processor's page where the client pays. */
    url: text("url").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: paymentLinkStatus("status").notNull().default("open"),
    /** The administrator who sent it. */
    createdBy: text("created_by").notNull(),
    /** The payment it became, once paid. */
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    paidAt: ts("paid_at"),
    cancelledAt: ts("cancelled_at"),
    /** When the processor was last asked about it, whatever it answered: the scheduled task asks about the longest unasked first. */
    checkedAt: ts("checked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("payment_links_booking_idx").on(t.bookingId)],
);

export const refunds = pgTable("refunds", {
  id: id(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payments.id, { onDelete: "restrict" }),
  amountCents: integer("amount_cents").notNull(),
  /** pending until the processor confirms; failed ones need the owner's attention. */
  status: refundStatus("status").notNull().default("pending"),
  providerRefundId: text("provider_refund_id"),
  reason: text("reason").notNull().default(""),
  /** True when the system refunded by policy without the owner's involvement. */
  automatic: boolean("automatic").notNull().default(false),
  error: text("error"),
  /**
   * When the processor said the refund was complete. A refund it accepted as
   * pending has none until the scheduled task asks again; one it rejects
   * then becomes failed (`checkUnsettledRefunds` in manage.ts).
   */
  settledAt: ts("settled_at"),
  createdAt: createdAt(),
});

/** Every email the system wants to send. A sender delivers the unsent rows. */
export const emailOutbox = pgTable("email_outbox", {
  id: id(),
  toEmail: text("to_email").notNull(),
  /** Where a reply should go when that is not the site's own address (messages from the contact form). */
  replyTo: text("reply_to"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  kind: text("kind").notNull(),
  sentAt: ts("sent_at"),
  /** Delivery attempts so far; a row is given up on after a few failures. */
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  createdAt: createdAt(),
});

// ── The website's content ────────────────────────────────────────────────────

/**
 * What the owners edit on the public website: the design, the frame around
 * every page (header, menu, footer, announcement, the studio's contact
 * details) and each page. A document has the copy the public sees
 * (`published`) and, while someone is working on it, a copy nobody else sees
 * (`draft`). Publishing makes the draft public and keeps a copy in
 * `site_versions`. See src/server/website.ts.
 */
export const siteDocuments = pgTable(
  "site_documents",
  {
    id: id(),
    /** `design` and `frame` exist once each; a `page` once per address. */
    kind: text("kind", { enum: ["design", "frame", "page"] }).notNull(),
    /** For a page: its address without the leading slash ("" is the home page). "" for the other two. */
    slug: text("slug").notNull().default(""),
    /** For a page: its name in the admin. */
    title: text("title").notNull().default(""),
    /** Changes that are not public yet. Null when there are none. */
    draft: jsonb("draft"),
    /** Counts every change of the draft, so two people editing at once are noticed. */
    draftRevision: integer("draft_revision").notNull().default(0),
    draftBy: text("draft_by"),
    draftAt: ts("draft_at"),
    /** What the public sees. Null for something that was never published, or was taken offline. */
    published: jsonb("published"),
    publishedBy: text("published_by"),
    publishedAt: ts("published_at"),
    /** A deleted page waits in the trash. */
    deletedAt: ts("deleted_at"),
    /**
     * For a page the website was built with (src/lib/site/built-in-pages.ts):
     * which one. Null for every other page. It is how a database knows it had
     * the page once, whatever was done to it since.
     */
    builtIn: text("built_in"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_documents_kind_slug").on(t.kind, t.slug).where(sql`${t.deletedAt} is null`),
    uniqueIndex("site_documents_built_in").on(t.builtIn).where(sql`${t.builtIn} is not null`),
  ],
);

/** A full copy of a document as it was published, kept so that an earlier version can be brought back. */
export const siteVersions = pgTable(
  "site_versions",
  {
    id: id(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => siteDocuments.id, { onDelete: "cascade" }),
    /** 1 for the first time a document was published, then 2, 3 and so on. */
    number: integer("number").notNull(),
    content: jsonb("content").notNull(),
    publishedBy: text("published_by").notNull(),
    /** Set when the publish was not an ordinary one: "Restored from version 3". */
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("site_versions_document_number").on(t.documentId, t.number)],
);

// ── Files, pictures and fonts ────────────────────────────────────────────────

/** Bytes in a column. node-postgres gives a Buffer back and PGlite a Uint8Array: both come out as a Uint8Array. */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
});

/**
 * The files the owners upload: pictures and fonts. They are kept in the
 * database until a host is chosen, behind `FileStore` (src/server/files.ts),
 * so that moving them to a host's own file storage changes one function.
 */
export const siteFiles = pgTable("site_files", {
  key: text("key").primaryKey(),
  contentType: text("content_type").notNull(),
  bytes: bytea("bytes").notNull(),
  size: integer("size").notNull(),
  createdAt: createdAt(),
});

/**
 * A picture of the media library. Whatever shows a picture names it by its
 * `id`, never by its address, so replacing the file (`fileKey`, `version`)
 * changes it everywhere it is shown. See src/server/media.ts.
 */
export const media = pgTable(
  "media",
  {
    id: id(),
    fileKey: text("file_key").notNull(),
    /** Counts the files this picture has had. Part of its address, so a replaced picture is never served from a cache. */
    version: integer("version").notNull().default(1),
    /** The name it was uploaded with, made safe for an address: "studio-blanche.jpg". */
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** What the picture shows, for someone who cannot see it. */
    alt: text("alt").notNull().default(""),
    /** Shown under the picture in a gallery. */
    caption: text("caption").notNull().default(""),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("media_created_idx").on(t.createdAt)],
);

/**
 * A named set of pictures, in an order: a season's sets, a studio's decor.
 * With dates it is shown only from its first day to its last, on the
 * studio's clock.
 */
export const mediaCollections = pgTable("media_collections", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  createdAt: createdAt(),
});

export const mediaCollectionItems = pgTable(
  "media_collection_items",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => mediaCollections.id, { onDelete: "cascade" }),
    /** A picture that is in a collection cannot be deleted: it is taken out of the collection first. */
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.mediaId] })],
);

/** The photos of a studio, in the order they are shown. The first is the one on the studio's card. */
export const studioPhotos = pgTable(
  "studio_photos",
  {
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.studioId, t.mediaId] })],
);

/**
 * A font of the owners' own, uploaded as files: the brand font that no
 * library has. The design can use it like a font of the library
 * (src/lib/site/fonts.ts). See src/server/fonts.ts.
 */
export const siteFonts = pgTable("site_fonts", {
  id: id(),
  /** The name the owners know it by: "Horizon". */
  name: text("name").notNull(),
  /** What kind of font it is, which decides what a browser shows until it has loaded. */
  kind: text("kind", { enum: ["serif", "sans", "display", "script"] }).notNull().default("display"),
  /** The owners' own words on the licence they hold for using it on a website. */
  licence: text("licence").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: createdAt(),
});

/** One file of an uploaded font: one weight, upright or italic. A variable font is one file for a range of weights. */
export const siteFontFiles = pgTable(
  "site_font_files",
  {
    id: id(),
    fontId: uuid("font_id")
      .notNull()
      .references(() => siteFonts.id, { onDelete: "cascade" }),
    fileKey: text("file_key").notNull(),
    format: text("format", { enum: ["woff2", "woff", "truetype", "opentype"] }).notNull(),
    /** 400 is regular, 700 bold. */
    weight: integer("weight").notNull().default(400),
    /** For a variable font: the heaviest weight the file holds. Null for a file of one weight. */
    weightMax: integer("weight_max"),
    italic: boolean("italic").notNull().default(false),
    size: integer("size").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("site_font_files_one_per_style").on(t.fontId, t.weight, t.italic)],
);

/**
 * An address that used to lead to a page, and where it leads now. Written
 * when a published page's address is changed, so that links and search
 * results that still name the old address keep working, and by the owners for
 * addresses of the website this one replaced. See src/server/pages.ts.
 */
export const siteRedirects = pgTable("site_redirects", {
  /** The old address, as a path: "/guestinfo". */
  fromPath: text("from_path").primaryKey(),
  /** Where it leads: a path of this site, or a whole web address. */
  toPath: text("to_path").notNull(),
  createdAt: createdAt(),
});
