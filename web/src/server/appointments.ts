import { eq } from "drizzle-orm";
import { bookings } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import {
  LABEL_BLOCK_TEXT,
  labelChange,
  labelOf,
  SETTABLE_LABELS,
  type LabelBlock,
  type LabelKey,
  type SettableLabel,
} from "@/lib/domain/labels";
import { can, type StaffAbility } from "@/lib/staff-abilities";
import type { AuthUser } from "./auth";
import { isBookingRef, toBookingViews, type BookingView } from "./bookings";
import { listEvents, recordEvent, type BookingEvent } from "./history";
import { loadSettings } from "./settings";
import { canViewDay } from "./staff";
import { localDateOf } from "./tz";

/**
 * One appointment as the admin sees it, for both of its levels: the owners,
 * and the staff with whatever the owners have switched on for them
 * (src/lib/staff-abilities.ts). Every function here checks the viewer itself:
 * the role, the ability, and for staff whether the day is one they may see.
 */

export interface Appointment {
  ref: string;
  label: LabelKey;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  studios: string[];
  customerName: string;
  /** Null unless the viewer may see contact details. */
  customerPhone: string | null;
  customerEmail: string | null;
  notes: string;
  addons: { name: string; quantity: number }[];
  /** The booking with its amounts. Null unless the viewer may see prices. */
  money: BookingView | null;
  history: BookingEvent[];
  /** Each label that can be set by hand, and whether it can be set right now. */
  labelChoices: { key: SettableLabel; allowed: boolean; why: string }[];
  /** What this viewer may do with the appointment. */
  may: Record<"setLabels" | "move", boolean>;
}

/** The viewer may see this booking: owners always, staff on the days they may see. */
async function maySee(db: DbLike, viewer: AuthUser, startAt: Date): Promise<boolean> {
  return canViewDay(db, viewer, localDateOf(startAt));
}

export async function getAppointment(db: DbLike, viewer: AuthUser, ref: string, now: Date): Promise<Appointment | null> {
  if (!isBookingRef(ref)) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.ref, ref)).limit(1);
  // An abandoned checkout is not an appointment.
  if (!booking || booking.status === "pending_payment" || booking.status === "expired") return null;
  if (!(await maySee(db, viewer, booking.startAt))) return null;

  const settings = await loadSettings(db);
  const may = (ability: StaffAbility) => can(viewer, ability, settings);
  const [view] = await toBookingViews(db, [booking]);
  const active = ["confirmed", "completed", "no_show"].includes(booking.status);

  return {
    ref: booking.ref,
    label: labelOf(booking),
    startAt: view.startAt,
    endAt: view.endAt,
    durationMinutes: booking.durationMinutes,
    studios: view.studios.map((studio) => studio.name),
    customerName: booking.customerName,
    customerPhone: may("staffSeesContact") ? booking.customerPhone : null,
    customerEmail: may("staffSeesContact") ? booking.customerEmail : null,
    notes: booking.notes,
    addons: view.addons.map((addon) => ({ name: addon.name, quantity: addon.quantity })),
    money: may("staffSeesPrices") ? view : null,
    history: await listEvents(db, booking.id),
    labelChoices: SETTABLE_LABELS.map((key) => {
      const change = labelChange(booking, key, now);
      return { key, allowed: change.ok, why: change.ok ? "" : LABEL_BLOCK_TEXT[change.reason] };
    }),
    may: {
      setLabels: active && may("staffSetsLabels"),
      move: booking.status === "confirmed" && now.getTime() < booking.endAt.getTime() && may("staffMovesBookings"),
    },
  };
}

export type SetLabelResult =
  | { ok: true; label: LabelKey }
  | { ok: false; reason: "forbidden" | "not_found" | LabelBlock };

/**
 * Put a status label on a booking, by hand. The history gets a line with the
 * viewer's address and the time.
 */
export async function setLabel(db: Db, viewer: AuthUser, ref: string, target: SettableLabel, now: Date): Promise<SetLabelResult> {
  if (!isBookingRef(ref)) return { ok: false, reason: "not_found" };
  const settings = await loadSettings(db);
  if (!can(viewer, "staffSetsLabels", settings)) return { ok: false, reason: "forbidden" };

  return db.transaction(async (tx): Promise<SetLabelResult> => {
    // Locked, so two people changing the label at once write two honest history lines.
    const [booking] = await tx.select().from(bookings).where(eq(bookings.ref, ref)).for("update").limit(1);
    // Staff are told "forbidden" for an unknown reference too, so they cannot probe for bookings.
    if (!booking) return { ok: false, reason: viewer.role === "owner" ? "not_found" : "forbidden" };
    if (!(await maySee(tx, viewer, booking.startAt))) return { ok: false, reason: "forbidden" };

    const change = labelChange(booking, target, now);
    if (!change.ok) return change;

    await tx.update(bookings).set({ status: change.status, label: change.label }).where(eq(bookings.id, booking.id));
    await recordEvent(tx, { bookingId: booking.id, from: labelOf(booking), to: target, actor: viewer.email, at: now });
    return { ok: true, label: target };
  });
}
