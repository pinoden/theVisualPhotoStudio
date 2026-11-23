import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadContactInbox, loadSettings, saveContactInbox, saveSetting } from "./settings";
import { createTestWorld, type TestWorld } from "./testing";

describe("where the contact form's messages go (the owners' note of 2026-11-22)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  it("is empty until the owners set it, takes an email address, and goes back to empty", async () => {
    expect(await loadContactInbox(world.db)).toBe("");
    expect(await saveContactInbox(world.db, "  Hello@TheVisualsPhotoStudio.com ")).toBe(true);
    expect(await loadContactInbox(world.db)).toBe("hello@thevisualsphotostudio.com");
    expect(await saveContactInbox(world.db, "not an address")).toBe(false);
    expect(await saveContactInbox(world.db, `${"x".repeat(200)}@example.com`)).toBe(false);
    expect(await loadContactInbox(world.db)).toBe("hello@thevisualsphotostudio.com");
    expect(await saveContactInbox(world.db, "")).toBe(true);
    expect(await loadContactInbox(world.db)).toBe("");
  });

  it("is not one of the settings every browser gets, and cannot be saved as one", async () => {
    await saveContactInbox(world.db, "hello@thevisualsphotostudio.com");
    expect(JSON.stringify(await loadSettings(world.db))).not.toContain("hello@");
    expect(await saveSetting(world.db, "contactInbox", "other@example.com")).toBe(false);
  });
});
