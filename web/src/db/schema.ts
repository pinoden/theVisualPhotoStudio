import { sql } from "drizzle-orm";
import { SERVICES } from "../lib/domain/services";
import {
  type AnyPgColumn,
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
/** What a client asked for that waits for the card processor (`bookings.endRequest`): a cancellation, or a release for a reschedule code. */
export const endRequest = pgEnum("end_request", ["cancel", "reschedule"]);
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

/**
 * How many requests a key (an IP address with what it asked for) made in one window of time: the rate limits, kept in
 * the database so that every server copy counts against the same limit (src/server/rate-limit.ts). Old windows are
 * removed by the scheduled task.
 */
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    key: text("key").notNull(),
    windowStart: ts("window_start").notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limit_hits_window_idx").on(t.windowStart)],
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

/**
 * Who opened a customer's page or one of their receipts, and when: the access log the owner asked for on 2026-11-18
 * (question 27). The viewer is kept by address, name and role as they were, so that a line still reads right after a
 * staff member leaves. Shown to the owners on the customer's page; older lines go with the retention period
 * (src/server/customer-views.ts, src/server/retention.ts).
 */
export const customerViews = pgTable(
  "customer_views",
  {
    id: id(),
    /** The customer, by the address their records are kept under. */
    customerEmail: text("customer_email").notNull(),
    viewerEmail: text("viewer_email").notNull(),
    viewerName: text("viewer_name").notNull().default(""),
    viewerRole: text("viewer_role").notNull(),
    /** What was opened: `page`, a `receipt` (its booking's ref in `detail`) or a `year` of receipts (the year in `detail`). */
    what: text("what").notNull(),
    detail: text("detail").notNull().default(""),
    viewedAt: ts("viewed_at").notNull(),
  },
  (t) => [index("customer_views_customer_idx").on(t.customerEmail, t.viewedAt), index("customer_views_viewed_idx").on(t.viewedAt)],
);

/**
 * A client's change of their own email address (question 27, answered 2026-11-18: "customers may change their own
 * email address"). A code is emailed to the new address, and only a hash of it is kept, as for signing in. Once the
 * code is given, every record kept under the old address moves to the new one (src/server/email-change.ts), and the row
 * stays as the record of the change: from what, to what, when.
 */
export const emailChanges = pgTable(
  "email_changes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    oldEmail: text("old_email").notNull(),
    newEmail: text("new_email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** When the code was given and the records moved. */
    consumedAt: ts("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("email_changes_user_idx").on(t.userId, t.createdAt), index("email_changes_new_idx").on(t.newEmail)],
);

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
  /** Guests that can come beyond those included, each paid as an extra guest (an add-on of kind `people`). */
  extraGuests: integer("extra_guests").notNull().default(0),
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
export const photographers = pgTable(
  "photographers",
  {
    id: id(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Which sessions this person gives: photography, or content creation (question 69 in ProjectLibrary.md). A
     * booking that holds them is a session of that kind. Each lookup names the service it wants.
     */
    service: text("service", { enum: SERVICES }).notNull().default("photography"),
  },
  (t) => [check("photographers_service", sql`${t.service} in ('photography', 'content')`)],
);

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
    /** Photography, or content creation: whose sessions these are. */
    service: text("service", { enum: SERVICES }).notNull().default("photography"),
  },
  (t) => [
    uniqueIndex("photo_packages_service_studio_duration_idx").on(t.service, t.studioId, t.durationMinutes),
    check("photo_packages_service", sql`${t.service} in ('photography', 'content')`),
  ],
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
   * How many of a prop there are (the owner's admin brief of 2026-11-22, item 10: one pair of angel wings). Bookings
   * whose times overlap can hold at most this many between them; null for an add-on with no such limit (a pet fee).
   * See src/server/props.ts.
   */
  stock: integer("stock"),
  /**
   * What the add-on is for. The guest information page reads it to say whether
   * larger groups and pets can be booked, so those answers follow what is
   * offered and not what an add-on happens to be called.
   */
  kind: text("kind", { enum: ["people", "pet", "other"] }).notNull().default("other"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  /** Its picture, from the media library (the admin brief of 2026-11-22, item 10: each prop with an image). */
  mediaId: uuid("media_id").references(() => media.id, { onDelete: "restrict" }),
  /**
   * The days, both included, on which a prop cannot be booked (item 10: "mark unavailable for a while"), such as the
   * angel wings away for repair. Both set or neither. Bookings made before keep it: Props & Resources lists them.
   */
  awayFrom: date("away_from", { mode: "string" }),
  awayTo: date("away_to", { mode: "string" }),
}, (t) => [check("addons_away", sql`(${t.awayFrom} is null) = (${t.awayTo} is null) and (${t.awayFrom} is null or ${t.awayFrom} <= ${t.awayTo})`)]);

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
  photographyOnly: boolean("photography_only").notNull().default(false),
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
    /**
     * A booking paid with membership minutes (follow-up 3): the membership, the minutes it took, and the part of the
     * studio price they paid. `total_cents` is what is left to pay after them.
     */
    membershipId: uuid("membership_id").references((): AnyPgColumn => memberships.id, { onDelete: "restrict" }),
    membershipMinutes: integer("membership_minutes").notNull().default(0),
    membershipCents: integer("membership_cents").notNull().default(0),
    /**
     * The kind of day the booking is priced as: its day's kind when it was made, or the new day's when a move priced it
     * again (follow-up 5). A move compares the new day with this, not with what the owners make the old day later (a
     * special date added since). Null for a booking made before it was kept (migration 0046 filled those in).
     */
    pricedAs: dayType("priced_as"),

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
    /**
     * The terms the booking was made under (`BookingTerms` in src/server/terms.ts): its refund window and fee, how
     * long and how often it can be moved and for what fee, and how long the credit it gives stays valid. A booking
     * keeps them when the owners change the settings (question 10). Null for one made before they were kept.
     */
    terms: jsonb("terms"),
    /** When this completed visit was counted for loyalty (a free hour may or may not have followed). */
    loyaltyIssuedAt: ts("loyalty_issued_at"),
    /** When the review request was queued, or the rollout skipped an older appointment. */
    reviewRequestedAt: ts("review_requested_at"),
    /**
     * When the reminder before the visit was queued (`queueReminders` in tasks.ts). Set at once, with nothing sent, for
     * a booking moved by the studio to a time closer than the reminder: the email about the move tells the new time.
     */
    reminderSentAt: ts("reminder_sent_at"),
    /**
     * For a booking imported from another booking system, where it came from: `acuity:<Acuity's appointment id>`
     * (src/server/acuity-import.ts). One booking per appointment, so a second import of the same export adds nothing.
     * Null for a booking made on this site.
     */
    importedFrom: text("imported_from"),
    /**
     * A client's cancellation, or release for a reschedule code, that waits: asked for while the card processor could
     * not say whether the booking's payment link was paid (the owners' answer of 2026-11-20 to question 23). The booking
     * stays confirmed and keeps its time until the site knows; it is then ended under its terms as they stood at
     * `endRequestedAt` (`finishWaitingEnd` in src/server/manage.ts). Both null otherwise, set and cleared together.
     */
    endRequest: endRequest("end_request"),
    endRequestedAt: ts("end_requested_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("bookings_email_idx").on(t.customerEmail),
    index("bookings_start_idx").on(t.startAt),
    uniqueIndex("bookings_request_key").on(t.requestKey).where(sql`${t.requestKey} is not null`),
    uniqueIndex("bookings_imported_from").on(t.importedFrom).where(sql`${t.importedFrom} is not null`),
    // The scheduled task's look at the requests that wait (`finishWaitingEnds`).
    index("bookings_end_requested_idx").on(t.endRequestedAt).where(sql`${t.endRequestedAt} is not null`),
    check("bookings_money_kind", sql`${t.moneyKind} in ('test', 'live')`),
    check("bookings_end_request", sql`(${t.endRequest} is null) = (${t.endRequestedAt} is null)`),
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
export const blocks = pgTable(
  "blocks",
  {
    id: id(),
    note: text("note").notNull().default(""),
    /**
     * Why the time is blocked (the owner's admin brief of 2026-11-22, item 12): "maintenance", "holiday" (Holiday
     * Closure), "private_event" or "other"; empty when none was given. See src/server/blocked-time.ts.
     */
    reason: text("reason").notNull().default(""),
    /**
     * The blocks made together, one for each day of a range or of a weekly repeat: they are listed, changed and removed
     * as one. Null for a block of one day made alone.
     */
    seriesId: uuid("series_id"),
    createdAt: createdAt(),
  },
  (t) => [index("blocks_series_idx").on(t.seriesId)],
);

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
    /**
     * An owner saved this hold over another's time, having read what it passes over in a pop-up (question 79 in
     * ProjectLibrary.md): the no-overlap constraint leaves it out. Set again each time the booking is moved or changed.
     */
    overlapAllowed: boolean("overlap_allowed").notNull().default(false),
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
    /** An owner saved this session over the person's other time, as on `studio_holds` (question 79). */
    overlapAllowed: boolean("overlap_allowed").notNull().default(false),
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
}, (t) => [
  // A booking's payments are read on nearly every page that shows money (migration 0050).
  index("payments_booking_idx").on(t.bookingId),
]);

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

/**
 * What an appointment costs beyond its price, added by the studio once it has started (follow-up 13): overtime, at a
 * quarter of the studio's hourly rate for each 15 minutes started, and cleaning or damage, at an amount typed each time.
 * An active charge adds to what the booking owes (`owedCentsByBooking`), so it is paid at the studio or through a
 * payment link like the rest. One added by mistake is taken back (`voidedAt`), never deleted. See src/server/charges.ts.
 */
export const bookingCharges = pgTable(
  "booking_charges",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }), // removed with a test-mode booking, as its holds are
    kind: text("kind", { enum: ["overtime", "cleaning", "damage"] }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** Overtime only: the minutes the client stayed past the end. */
    minutes: integer("minutes"),
    /** Overtime only: the hourly rate it was worked out from, as it was then. */
    hourlyCents: integer("hourly_cents"),
    note: text("note").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    voidedAt: ts("voided_at"),
    voidedBy: text("voided_by"),
  },
  (t) => [
    index("booking_charges_booking_idx").on(t.bookingId),
    check("booking_charges_kind", sql`${t.kind} in ('overtime', 'cleaning', 'damage')`),
    check("booking_charges_amount", sql`${t.amountCents} > 0`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    /** pending until the processor confirms; failed ones need the owner's attention. */
    status: refundStatus("status").notNull().default("pending"),
    providerRefundId: text("provider_refund_id"),
    reason: text("reason").notNull().default(""),
    /**
     * The part of this refund that gave back what the booking was paid beyond its price then (its remaining credit, after
     * a move to a day that costs less: follow-up 5). That part is money paid back, not a gift: should the price go up
     * again, the booking owes it again. The rest of a refund (goodwill, a cancellation's) never makes a booking owe.
     */
    creditCents: integer("credit_cents").notNull().default(0),
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
  },
  (t) => [
    check("refunds_credit_cents", sql`${t.creditCents} >= 0 and ${t.creditCents} <= ${t.amountCents}`),
    // A payment's refunds are read with the payment (migration 0050).
    index("refunds_payment_idx").on(t.paymentId),
  ],
);

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
  /**
   * When the message is no longer any use, for one that is (a sign-in code, which lasts minutes): one still waiting
   * then is not sent. Null for the others, which are sent however late.
   */
  expiresAt: ts("expires_at"),
  error: text("error"),
  createdAt: createdAt(),
});

// ── Memberships ──────────────────────────────────────────────────────────────

/**
 * A membership the studio sells (follow-up 3): studio minutes each month for a monthly price, in one studio or in the
 * studios of a bundle (`membership_plan_studios`). The owners add plans, change them and switch them on and off under
 * Admin → Memberships. See src/server/memberships.ts.
 */
export const membershipPlans = pgTable(
  "membership_plans",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** The studio minutes it gives each month: 300 for 5 hours. */
    minutes: integer("minutes").notNull(),
    /** What it costs each month. */
    priceCents: integer("price_cents").notNull(),
    /** False when it is no longer offered. A plan is never deleted. */
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [check("membership_plans_minutes", sql`${t.minutes} > 0`), check("membership_plans_price", sql`${t.priceCents} > 0`)],
);

/** The studios a plan's minutes are for: one, or the studios of a bundle, each of which they can be spent in alone too. */
export const membershipPlanStudios = pgTable(
  "membership_plan_studios",
  {
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id, { onDelete: "cascade" }),
    studioId: uuid("studio_id")
      .notNull()
      .references(() => studios.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.planId, t.studioId] })],
);

/**
 * A plan's price at the card processor (Square's subscription plan and its variation): made the first time a
 * membership is bought at that price, and reused after. A new price is a new variation, so members keep theirs.
 */
export const membershipPlanPrices = pgTable(
  "membership_plan_prices",
  {
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id, { onDelete: "restrict" }),
    /** Which processor, as `payments.provider`: a price made in the sandbox is unknown to the live account. */
    provider: text("provider").notNull(),
    priceCents: integer("price_cents").notNull(),
    processorPlanId: text("processor_plan_id").notNull(),
    variationId: text("variation_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.planId, t.provider, t.priceCents] })],
);

export const MEMBERSHIP_STATUSES = ["starting", "active", "cancelled", "stopped", "failed"] as const;

/**
 * A membership a client bought (follow-up 3). Its first month is paid when it is bought; the processor's subscription
 * bills the same card each month after, from the same day of the next month. The member keeps the plan's name, minutes
 * and price as they were when they joined.
 *
 * `status`: `starting` while it is being bought (the card form was sent: the first month and the subscription are
 * being set up, and pressing again finds it); `active`, billed each month; `cancelled`, billed no more, the month paid
 * for running to `ends_on`; `stopped`, the processor stopped billing it; `failed`, never bought (the card was refused,
 * or the billing could not be set up, and the first month was given back). The minutes stay usable in every state but
 * `failed`. See src/server/memberships.ts.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    /** The client, by their email address, always lowercase, as their bookings are. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull().default(""),
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id, { onDelete: "restrict" }),
    planName: text("plan_name").notNull(),
    minutesPerMonth: integer("minutes_per_month").notNull(),
    priceCents: integer("price_cents").notNull(),
    /** What the member books with. */
    code: text("code").notNull().unique(),
    status: text("status", { enum: MEMBERSHIP_STATUSES }).notNull(),
    /** The buying page's own key: pressing again finds this membership instead of buying a second. */
    requestKey: text("request_key").notNull().unique(),
    /** Which processor bills it, as `payments.provider`. */
    provider: text("provider").notNull(),
    customerId: text("customer_id"),
    cardId: text("card_id"),
    subscriptionId: text("subscription_id"),
    /** The day it was bought, the studio's day. */
    startedOn: date("started_on", { mode: "string" }).notNull(),
    /** The first day not paid for yet: the day the next month is billed while it is active. */
    paidThrough: date("paid_through", { mode: "string" }),
    cancelledAt: ts("cancelled_at"),
    /** Once cancelled: the day the month paid for ends, with no charge after it. */
    endsOn: date("ends_on", { mode: "string" }),
    /** Why it failed or was stopped, or what went wrong with a month's payment, for the owners. */
    problem: text("problem"),
    /** When the scheduled task last asked the processor about its months: at most once an hour (`runMembershipBilling`). */
    billingCheckedAt: ts("billing_checked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("memberships_email_idx").on(t.email),
    check("memberships_status", sql`${t.status} in ('starting', 'active', 'cancelled', 'stopped', 'failed')`),
    check("memberships_minutes", sql`${t.minutesPerMonth} > 0`),
    check("memberships_price", sql`${t.priceCents} > 0`),
  ],
);

/** A month a membership paid: the first, paid when it was bought, then each the processor billed. */
export const membershipPayments = pgTable(
  "membership_payments",
  {
    id: id(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    /** The processor's payment (the first month) or invoice (a month it billed): each is recorded once. */
    processorId: text("processor_id").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    /** The first day of the month it pays for. */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    paidAt: ts("paid_at").notNull(),
    /** Set when it was given back: a first month whose membership could not be set up. */
    refundedAt: ts("refunded_at"),
  },
  (t) => [
    check("membership_payments_amount", sql`${t.amountCents} > 0`),
    // A membership's months, read for its pages and its billing (migration 0050).
    index("membership_payments_membership_idx").on(t.membershipId),
  ],
);

/**
 * Every change to a membership's minutes: the balance is their sum. `month`: a paid month's minutes; `booking`: spent
 * on a booking (negative); `returned`: given back by a cancellation; `correction`: an owner's, with a note.
 */
export const membershipMinutes = pgTable(
  "membership_minutes",
  {
    id: id(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    minutes: integer("minutes").notNull(),
    kind: text("kind", { enum: ["month", "booking", "returned", "correction"] }).notNull(),
    /** The month that added them: at most once each. */
    paymentId: uuid("payment_id")
      .unique()
      .references(() => membershipPayments.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "restrict" }),
    note: text("note").notNull().default(""),
    /** Who: "the site", or the owner who corrected them. */
    actor: text("actor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("membership_minutes_membership_idx").on(t.membershipId),
    // A booking's minutes, given back when it is cancelled (migration 0050).
    index("membership_minutes_booking_idx").on(t.bookingId),
    check("membership_minutes_kind", sql`${t.kind} in ('month', 'booking', 'returned', 'correction')`),
    check("membership_minutes_not_zero", sql`${t.minutes} <> 0`),
  ],
);

/**
 * The owners' wording of an email the site sends to clients (Admin → Emails): a row for each email they have changed
 * or set back. No subject and text: the site's own wording again. `revision` goes up with each save, so that a save
 * from an editor opened before someone else's is noticed. See src/server/email-templates.ts.
 */
export const emailTemplates = pgTable(
  "email_templates",
  {
    /** Which email: a key of `EMAIL_TEMPLATES` in src/lib/email-templates.ts. */
    key: text("key").primaryKey(),
    subject: text("subject"),
    body: text("body"),
    revision: integer("revision").notNull().default(1),
    updatedBy: text("updated_by").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [check("email_templates_wording", sql`(${t.subject} is null) = (${t.body} is null)`)],
);

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
 * Video files the owners upload (the owners' note 7 of 2026-11-22: videos wherever photos are added; "let's start with
 * files", and "Set up neon", 2026-11-23; question 77 in ProjectLibrary.md). The file itself is in Neon's object storage
 * (the `videos` bucket) on the host, or in `site_files` where none is set up (a computer of the builder's, the tests),
 * under `storageKey`. A page shows one through its own address on the site, `/videos/<id>`.
 */
export const videos = pgTable(
  "videos",
  {
    id: id(),
    storageKey: text("storage_key").notNull().unique(),
    /** The name it was uploaded with, made safe for an address: "studio-tour.mp4". */
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    /** What the video shows, for someone who cannot see it: the title of its player. */
    title: text("title").notNull().default(""),
    /** `uploading` until the browser's upload is confirmed whole; only a `ready` one is shown. */
    status: text("status", { enum: ["uploading", "ready"] }).notNull().default("uploading"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("videos_status", sql`${t.status} in ('uploading', 'ready')`), check("videos_size", sql`${t.size} > 0`)],
);

/**
 * The photos the site shows for photography (the owners' note of 2026-11-22: "under Admin → Photography the owners
 * should be able to add and edit photos without a deployment"; question 73 in ProjectLibrary.md): pictures of the media
 * library, in the owners' order. A page shows them through a Gallery set to "The photos chosen under Admin → Photography".
 */
export const photographyPhotos = pgTable("photography_photos", {
  mediaId: uuid("media_id")
    .primaryKey()
    .references(() => media.id, { onDelete: "restrict" }),
  position: integer("position").notNull().default(0),
});

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

// ── Booking Forms & Agreements ───────────────────────────────────────────────
// The owner's brief of 2026-11-22, items 6 and 7: the questions a client answers and the agreements they accept at
// checkout, which the owners write and change themselves, and the record of both on each booking.
// See src/server/booking-forms.ts.

/**
 * A question of the intake form. It is asked of the bookings it applies to: its studios (none listed: every studio),
 * rentals or photography sessions or both, and a booking's day between `startsOn` and `endsOn` when they are set (a
 * seasonal question, such as the Christmas decor acknowledgment). A question being written stays off (`active`) until
 * the owners publish it; the form can be previewed before.
 */
export const intakeQuestions = pgTable("intake_questions", {
  id: id(),
  label: text("label").notNull(),
  help: text("help").notNull().default(""),
  kind: text("kind", { enum: ["text", "checkbox", "dropdown", "choice"] }).notNull(),
  /** The choices of a dropdown or of multiple choice, in order. */
  options: jsonb("options").$type<string[]>().notNull().default([]),
  required: boolean("required").notNull().default(false),
  active: boolean("active").notNull().default(false),
  studioIds: jsonb("studio_ids").$type<string[]>().notNull().default([]),
  forRentals: boolean("for_rentals").notNull().default(true),
  forPhotography: boolean("for_photography").notNull().default(true),
  startsOn: date("starts_on", { mode: "string" }),
  endsOn: date("ends_on", { mode: "string" }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

/**
 * An agreement, policy or waiver beside the studio policies (which are the website's Policies page), applied like a
 * question. Its text is written as a draft and published as a new version; each booking keeps the version accepted.
 * An agreement with versions is taken off (`active`), never deleted.
 */
export const agreements = pgTable("agreements", {
  id: id(),
  title: text("title").notNull(),
  draft: text("draft").notNull().default(""),
  active: boolean("active").notNull().default(true),
  studioIds: jsonb("studio_ids").$type<string[]>().notNull().default([]),
  forRentals: boolean("for_rentals").notNull().default(true),
  forPhotography: boolean("for_photography").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

/** A published version of an agreement: never changed or removed, so an accepted one can always be read again. */
export const agreementVersions = pgTable(
  "agreement_versions",
  {
    id: id(),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreements.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    publishedBy: text("published_by").notNull(),
    publishedAt: ts("published_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agreement_versions_number").on(t.agreementId, t.number)],
);

/** A client's answer to a question at checkout, with the question's words as asked: it outlives a change or a deletion. */
export const bookingAnswers = pgTable(
  "booking_answers",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").references(() => intakeQuestions.id, { onDelete: "set null" }),
    label: text("label").notNull(),
    answer: text("answer").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("booking_answers_booking_idx").on(t.bookingId)],
);

/**
 * What a client accepted at checkout, and when: the website's Policies page as published then (`siteVersionId`, its
 * version `number`), or a version of an agreement. The title is kept as it was.
 */
export const bookingAcceptances = pgTable(
  "booking_acceptances",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["policies_page", "agreement"] }).notNull(),
    title: text("title").notNull(),
    siteVersionId: uuid("site_version_id").references(() => siteVersions.id, { onDelete: "set null" }),
    agreementVersionId: uuid("agreement_version_id").references(() => agreementVersions.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    acceptedAt: ts("accepted_at").notNull(),
    /**
     * The Policies page's words as the client read them, as HTML (since 2026-11-23): its live values, such as prices,
     * as they were, and kept when the page's history is not. Null for an agreement, whose versions never change, and
     * for an acceptance made before.
     */
    shownHtml: text("shown_html"),
  },
  (t) => [index("booking_acceptances_booking_idx").on(t.bookingId)],
);

/**
 * A client waiting for a time (the owner's brief of 2026-11-22, item 4): the studios or the photography session, the
 * length, the day and the range of time the appointment should lie in. The scheduled task emails the client once,
 * when a time that fits frees up; nothing is held for them. See src/server/waitlist.ts.
 */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: id(),
    studioIds: jsonb("studio_ids").$type<string[]>().notNull(),
    photography: boolean("photography").notNull().default(false),
    /** Whose session, for a session: the photographer's or the content creator's (question 69). */
    service: text("service", { enum: SERVICES }).notNull().default("photography"),
    durationMinutes: integer("duration_minutes").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    /** The range of the studio's day the whole appointment should lie in, in minutes from midnight. */
    fromMinute: integer("from_minute").notNull(),
    toMinute: integer("to_minute").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    createdAt: createdAt(),
    /** When the client was emailed that a time fits. */
    notifiedAt: ts("notified_at"),
    removedAt: ts("removed_at"),
    removedBy: text("removed_by"),
  },
  (t) => [index("waitlist_entries_day_idx").on(t.day), index("waitlist_entries_email_idx").on(t.email)],
);
