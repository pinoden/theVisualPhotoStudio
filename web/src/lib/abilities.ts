/**
 * What each level of the admin can do. The owner's three levels (2026-11-15):
 *
 *  - Owners (the addresses in OWNER_EMAILS): everything.
 *  - Studio Managers: appointments and clients. A manager can always do what
 *    running the calendar needs; the rest is a set of switches of their own.
 *  - Studio Attendants (the role stored as `staff`): the calendar, check-ins
 *    and status labels, on the days assigned to them, plus whatever the
 *    owners switch on for them. Never design, prices or settings.
 *
 * The switches are settings that the owners set on the Staff page, so a
 * change applies at the next request, with nothing redeployed. Prices,
 * settings, staff and codes stay with the owners: no switch opens them.
 *
 * The website is the owners' too, unless they give a manager part of it:
 * one switch lets managers change the design and the header, menu and footer
 * as a draft, one lets them edit pages as a draft, and one lets them publish.
 * Either of the first two opens the library of pictures. An attendant never
 * can.
 */

/** The switches for attendants. Each is a setting of the same name. */
export const ATTENDANT_SWITCHES = {
  staffSetsLabels: "Change the status label of an appointment",
  staffSeesAllDays: "See every day, not only the days assigned to them",
  staffSeesContact: "See customers' phone numbers and email addresses",
  staffSeesPrices: "See what a booking cost",
  staffMovesBookings: "Move a booking to a new time",
  staffCreatesBookings: "Make a booking for a client",
  staffRecordsPayments: "Record a payment taken at the studio, and email a payment link (this shows them what a booking still owes, until it is paid)",
  staffSetsPhotographerTimes: "Set the hours the photographer and the content creator work, and block their time",
} as const;

/** The switches for managers. Each is a setting of the same name. */
export const MANAGER_SWITCHES = {
  managerSeesPrices: "See what bookings cost, and customers' payments and receipts",
  managerRecordsPayments: "Record a payment taken at the studio, and email a payment link (this shows them what a booking still owes, until it is paid)",
  managerRefunds: "Cancel a booking and refund a card payment, in the bookings list",
  managerSeesCustomers: "Open the list of customers, and each customer's appointments, stamps and rewards",
  managerCorrectsLoyalty: "Add or take away loyalty stamps, and cancel a reward or give it back",
  managerBlocksTime: "Block time in a studio",
  managerEditsDesign: "Change the website's design, header, menu and footer. What they change stays a draft until it is published",
  managerEditsPages: "Add and edit the website's pages. What they change stays a draft until it is published",
  managerPublishesWebsite: "Publish changes to the website, take a page offline, and bring an earlier version back",
} as const;

export type AttendantSwitch = keyof typeof ATTENDANT_SWITCHES;
export type ManagerSwitch = keyof typeof MANAGER_SWITCHES;
export const ATTENDANT_SWITCH_KEYS = Object.keys(ATTENDANT_SWITCHES) as AttendantSwitch[];
export const MANAGER_SWITCH_KEYS = Object.keys(MANAGER_SWITCHES) as ManagerSwitch[];

/** Something a person in the admin may or may not do. */
export type Ability =
  | "setLabels"
  | "seeAllDays"
  | "seeContact"
  | "seePrices"
  | "moveBookings"
  | "createBookings"
  | "recordPayments"
  | "setPhotographerTimes"
  | "seeCustomers"
  | "correctLoyalty"
  | "refund"
  | "blockTime"
  | "editDesign"
  | "editPages"
  | "publishWebsite";

/** For an attendant: the switch that allows it, or false when no switch does. */
const ATTENDANT_RULE: Record<Ability, AttendantSwitch | false> = {
  setLabels: "staffSetsLabels",
  seeAllDays: "staffSeesAllDays",
  seeContact: "staffSeesContact",
  seePrices: "staffSeesPrices",
  moveBookings: "staffMovesBookings",
  createBookings: "staffCreatesBookings",
  recordPayments: "staffRecordsPayments",
  setPhotographerTimes: "staffSetsPhotographerTimes",
  seeCustomers: false,
  correctLoyalty: false,
  refund: false,
  blockTime: false,
  editDesign: false,
  editPages: false,
  publishWebsite: false,
};

/** For a manager: true when every manager may, otherwise the switch that allows it. */
const MANAGER_RULE: Record<Ability, ManagerSwitch | true> = {
  setLabels: true,
  seeAllDays: true,
  seeContact: true,
  seePrices: "managerSeesPrices",
  moveBookings: true,
  createBookings: true,
  recordPayments: "managerRecordsPayments",
  setPhotographerTimes: true,
  seeCustomers: "managerSeesCustomers",
  correctLoyalty: "managerCorrectsLoyalty",
  refund: "managerRefunds",
  blockTime: "managerBlocksTime",
  editDesign: "managerEditsDesign",
  editPages: "managerEditsPages",
  publishWebsite: "managerPublishesWebsite",
};

export type AbilitySettings = Record<AttendantSwitch | ManagerSwitch, boolean>;

/** True when someone with this role may use the ability, as the owners have set the switches. */
export function can(viewer: { role: string }, ability: Ability, settings: AbilitySettings): boolean {
  if (viewer.role === "owner") return true;
  if (viewer.role === "manager") {
    const rule = MANAGER_RULE[ability];
    return rule === true || settings[rule] === true;
  }
  if (viewer.role === "staff") {
    const rule = ATTENDANT_RULE[ability];
    return rule !== false && settings[rule] === true;
  }
  return false;
}

/** The roles that work in the admin, and what each is called there. */
export const ADMIN_LEVELS = { manager: "Studio Manager", staff: "Studio Attendant" } as const;
export type AdminLevel = keyof typeof ADMIN_LEVELS;

export function isAdminLevel(value: unknown): value is AdminLevel {
  return value === "manager" || value === "staff";
}

/** What a person's role is called: "Owner", "Studio Manager", "Studio Attendant". */
export function roleTitle(role: string): string {
  return role === "owner" ? "Owner" : isAdminLevel(role) ? ADMIN_LEVELS[role] : "Customer";
}
