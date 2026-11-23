import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pageTextHtml } from "@/lib/site/page-text";
import { ensureBuiltInPages, loadPublishedPage } from "./pages";
import { createTestWorld, NOW, type TestWorld } from "./testing";

describe("a page's words as HTML, for the booking pages' policies step", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  it("gives the Policies page's headings and text, its live values filled in, without its banner", async () => {
    await ensureBuiltInPages(world.db, NOW);
    const page = (await loadPublishedPage(world.db, "policies", NOW))!;
    const html = pageTextHtml(page.content.blocks, page.site);
    expect(html).toContain("<h2>Cancellations &amp; Rescheduling</h2>");
    expect(html).toContain("Cancellations made 7 days (168 hours) or more before the appointment are eligible for a full refund");
    expect(html).not.toMatch(/\{[a-z ]+\}/); // no live value or condition left unfilled
    expect(html).not.toContain("page-banner");
    expect(html).not.toMatch(/<script|on\w+=/i);
  });
});
