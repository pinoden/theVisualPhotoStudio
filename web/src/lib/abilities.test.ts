import { describe, expect, it } from "vitest";
import { can, isAdminLevel, MANAGER_SWITCH_KEYS, ATTENDANT_SWITCH_KEYS, roleTitle, type Ability, type AbilitySettings } from "./abilities";

const ALL: Ability[] = [
  "setLabels",
  "seeAllDays",
  "seeContact",
  "seePrices",
  "moveBookings",
  "createBookings",
  "recordPayments",
  "setPhotographerTimes",
  "seeCustomers",
  "correctLoyalty",
  "refund",
  "blockTime",
];
const every = (value: boolean) => Object.fromEntries([...ATTENDANT_SWITCH_KEYS, ...MANAGER_SWITCH_KEYS].map((key) => [key, value])) as AbilitySettings;
const allowed = (role: string, settings: AbilitySettings) => ALL.filter((ability) => can({ role }, ability, settings));

/** The owner's three levels (2026-11-15): owners, Studio Managers, Studio Attendants. */
describe("what each level of the admin may do", () => {
  it("lets an owner do everything, whatever the switches say", () => {
    expect(allowed("owner", every(false))).toEqual(ALL);
  });

  it("lets a customer, or anyone unknown, do nothing, whatever the switches say", () => {
    expect(allowed("customer", every(true))).toEqual([]);
    expect(allowed("", every(true))).toEqual([]);
    expect(allowed("admin", every(true))).toEqual([]);
  });

  it("gives a manager what running the calendar needs, with every switch off", () => {
    expect(allowed("manager", every(false))).toEqual(["setLabels", "seeAllDays", "seeContact", "moveBookings", "createBookings", "setPhotographerTimes"]);
  });

  it("gives a manager the rest switch by switch", () => {
    const only = (key: (typeof MANAGER_SWITCH_KEYS)[number]) => allowed("manager", { ...every(false), [key]: true }).filter((ability) => !allowed("manager", every(false)).includes(ability));
    expect(only("managerSeesPrices")).toEqual(["seePrices"]);
    expect(only("managerRecordsPayments")).toEqual(["recordPayments"]);
    expect(only("managerRefunds")).toEqual(["refund"]);
    expect(only("managerSeesCustomers")).toEqual(["seeCustomers"]);
    expect(only("managerCorrectsLoyalty")).toEqual(["correctLoyalty"]);
    expect(only("managerBlocksTime")).toEqual(["blockTime"]);
    expect(allowed("manager", every(true))).toEqual(ALL);
  });

  it("gives an attendant nothing with every switch off, and never what only a manager can be given", () => {
    expect(allowed("staff", every(false))).toEqual([]);
    expect(allowed("staff", every(true))).toEqual([
      "setLabels",
      "seeAllDays",
      "seeContact",
      "seePrices",
      "moveBookings",
      "createBookings",
      "recordPayments",
      "setPhotographerTimes",
    ]);
  });

  it("keeps the two sets of switches apart: a manager's switch does nothing for an attendant, and the other way round", () => {
    const managersOnly = { ...every(false), ...Object.fromEntries(MANAGER_SWITCH_KEYS.map((key) => [key, true])) } as AbilitySettings;
    expect(allowed("staff", managersOnly)).toEqual([]);
    const attendantsOnly = { ...every(false), ...Object.fromEntries(ATTENDANT_SWITCH_KEYS.map((key) => [key, true])) } as AbilitySettings;
    expect(allowed("manager", attendantsOnly)).toEqual(allowed("manager", every(false)));
  });

  it("names the levels as the owner does", () => {
    expect(roleTitle("owner")).toBe("Owner");
    expect(roleTitle("manager")).toBe("Studio Manager");
    expect(roleTitle("staff")).toBe("Studio Attendant");
    expect(roleTitle("customer")).toBe("Customer");
    expect(isAdminLevel("manager")).toBe(true);
    expect(isAdminLevel("owner")).toBe(false);
  });
});
