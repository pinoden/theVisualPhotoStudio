import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "./catalog";
import { MOCK_TOKEN_DECLINED } from "./payments";
import {
  ACCESS_INSTRUCTIONS_MAX,
  DEFAULT_SETTINGS,
  loadAccessInstructions,
  loadSettings,
  saveAccessInstructions,
  saveSetting,
} from "./settings";
import { createTestWorld, expectOk, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const GETTING_IN = "Door code 4821#.\nTake the elevator to the 3rd floor, suite 301.";

describe("how to get into the building", () => {
  it("is empty until the owner sets it, and can be cleared again", async () => {
    expect(await loadAccessInstructions(world.db)).toBe("");
    expect(await saveAccessInstructions(world.db, GETTING_IN)).toBe(true);
    expect(await loadAccessInstructions(world.db)).toBe(GETTING_IN);
    expect(await saveAccessInstructions(world.db, "   ")).toBe(true);
    expect(await loadAccessInstructions(world.db)).toBe("");
  });

  it("is stored with plain line breaks and no space around it, and refused when too long", async () => {
    await saveAccessInstructions(world.db, "  Door code 4821#.\r\nThird floor.\r\n  ");
    expect(await loadAccessInstructions(world.db)).toBe("Door code 4821#.\nThird floor.");

    expect(await saveAccessInstructions(world.db, "x".repeat(ACCESS_INSTRUCTIONS_MAX + 1))).toBe(false);
    expect(await loadAccessInstructions(world.db)).toBe("Door code 4821#.\nThird floor.");
  });

  it("never enters the catalog that goes to every browser: only the fact that it is set does", async () => {
    expect((await loadCatalog(world.db)).accessInfoSent).toBe(false);
    await saveAccessInstructions(world.db, GETTING_IN);

    const catalog = await loadCatalog(world.db);
    expect(catalog.accessInfoSent).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain("4821");
    expect(catalog.settings).toEqual(DEFAULT_SETTINGS);
    expect(await loadSettings(world.db)).toEqual(DEFAULT_SETTINGS);
  });

  it("cannot be written through the ordinary settings", async () => {
    expect(await saveSetting(world.db, "accessInstructions", GETTING_IN)).toBe(false);
    expect(await loadAccessInstructions(world.db)).toBe("");
  });

  it("is in the confirmation email of a confirmed booking", async () => {
    await saveAccessInstructions(world.db, GETTING_IN);
    expectOk(await world.book());
    const [mail] = await world.emails("booking_confirmation");
    expect(mail.body).toContain(`\nGetting in:\n${GETTING_IN}\n`);
  });

  it("is left out of the email when the owner has not set it, and nothing is sent when the card is refused", async () => {
    expectOk(await world.book());
    const [mail] = await world.emails("booking_confirmation");
    expect(mail.body).not.toContain("Getting in");

    await world.reset();
    await saveAccessInstructions(world.db, GETTING_IN);
    expect((await world.book({ paymentToken: MOCK_TOKEN_DECLINED })).ok).toBe(false);
    expect(await world.emails()).toHaveLength(0);
  });
});
