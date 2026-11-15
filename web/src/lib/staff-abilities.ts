/**
 * What the second level of the admin, the staff, can do. Each is a switch in
 * the settings that the owners set on the Staff page, so it changes at once
 * and without a deploy. Owners can always do all of it.
 */
export const STAFF_ABILITIES = {
  staffSetsLabels: "Change the status label of an appointment",
  staffSeesAllDays: "See every day, not only the days assigned to them",
  staffSeesContact: "See customers' phone numbers and email addresses",
  staffSeesPrices: "See what a booking cost",
  staffMovesBookings: "Move a booking to a new time",
  staffCreatesBookings: "Make a booking for a client",
  staffRecordsPayments: "Record a payment taken at the studio, and email a payment link (this shows them what the booking still owes)",
  staffSetsPhotographerTimes: "Set the hours the photographer works, and block their time",
} as const;

export type StaffAbility = keyof typeof STAFF_ABILITIES;
export const STAFF_ABILITY_KEYS = Object.keys(STAFF_ABILITIES) as StaffAbility[];

/** True when someone with this role may use the ability. */
export function can(viewer: { role: string }, ability: StaffAbility, settings: Record<StaffAbility, boolean>): boolean {
  if (viewer.role === "owner") return true;
  return viewer.role === "staff" && settings[ability] === true;
}
