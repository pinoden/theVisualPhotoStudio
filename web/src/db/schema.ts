import { sql } from "drizzle-orm";
import {
  boolean,
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

export const userRole = pgEnum("user_role", ["customer", "staff", "owner"]);
export const dayType = pgEnum("day_type", ["weekday", "weekend"]);
export const bookingStatus = pgEnum("booking_status", [
  "pending_payment", // slot held, card not charged yet
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
  "expired", // payment never completed, slot released
]);
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed"]);
export const refundStatus = pgEnum("refund_status", ["pending", "succeeded", "failed"]);
export const promoKind = pgEnum("promo_kind", ["percent", "amount", "free_hour"]);
export const promoSource = pgEnum("promo_source", ["loyalty", "reschedule", "manual"]);
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
  /** Set when the owner cancels a code. */
  voidedAt: ts("voided_at"),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
});

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
    cancelReason: cancelReason("cancel_reason"),
    /** Hash of the secret in the customer's manage link. */
    manageTokenHash: text("manage_token_hash").notNull(),
    termsAcceptedAt: ts("terms_accepted_at"),
    /** When this completed visit was counted for loyalty (a free hour may or may not have followed). */
    loyaltyIssuedAt: ts("loyalty_issued_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [index("bookings_email_idx").on(t.customerEmail), index("bookings_start_idx").on(t.startAt)],
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
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.addonId] })],
);

export const payments = pgTable("payments", {
  id: id(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(), // 'square' | 'mock'
  providerPaymentId: text("provider_payment_id"),
  amountCents: integer("amount_cents").notNull(),
  refundedCents: integer("refunded_cents").notNull().default(0),
  status: paymentStatus("status").notNull().default("pending"),
  error: text("error"),
  createdAt: createdAt(),
});

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
