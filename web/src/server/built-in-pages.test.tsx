import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import { addons, photoPackages, settings, siteDocuments, siteVersions } from "@/db/schema";
import { builtInPages } from "@/lib/site/built-in-pages";
import { CONDITIONS } from "@/lib/site/conditions";
import { liveValues } from "@/lib/site/live-values";
import { parsePage } from "@/lib/site/page";
import type { AuthUser } from "./auth";
import { loadCatalog } from "./catalog";
import {
  AS_BUILT,
  BUILT_VERSION,
  createPage,
  deletePage,
  duplicatePage,
  emptyOldTrash,
  ensureBuiltInPages,
  linksToPage,
  listPages,
  listPageVersions,
  loadPageForEditing,
  loadPublishedPage,
  restorePage,
  restorePageVersion,
  savePageDraft,
  savePageSettings,
  TRASH_DAYS,
  unpublishPage,
} from "./pages";
import { saveAccessInstructions } from "./settings";
import { createTestWorld, daysAfter, expectOk, NOW, type TestWorld } from "./testing";
import { loadBusiness } from "./website";

/**
 * The public pages that were written in the code, made pages of the admin
 * (requirement 29's content inventory): they start with the wording they had,
 * read the settings as they did, and follow a change of the settings as the
 * code did, while every word of them is the owners' to change.
 */
let world: TestWorld;
let owner: AuthUser;

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  await ensureBuiltInPages(world.db, NOW);
});

const setting = (key: string, value: unknown) => world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

/** A published page as a visitor reads it: its words, without the HTML. */
async function words(slug: string): Promise<string> {
  const page = await loadPublishedPage(world.db, slug, NOW);
  expect(page, slug).not.toBeNull();
  const html = renderToStaticMarkup(<PageBlocks blocks={page!.content.blocks} site={page!.site} />);
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const idOf = async (slug: string) => (await world.db.select({ id: siteDocuments.id }).from(siteDocuments).where(eq(siteDocuments.slug, slug)))[0].id;

describe("the pages the website was built with", () => {
  it("are put into a database once, published, each with its first version", async () => {
    const pages = await listPages(world.db, owner);
    expect(pages!.map((page) => page.path).sort()).toEqual(["/", "/contact", "/faq", "/policies", "/rates", "/services", "/studios"]);
    expect(pages!.every((page) => page.state === "live" && page.builtIn)).toBe(true);
    expect(pages!.find((page) => page.home)!.title).toBe("Home");
    const versions = await listPageVersions(world.db, owner, await idOf("faq"));
    expect(versions).toMatchObject([{ number: 1, publishedBy: AS_BUILT, current: true }]);
    // A second time, nothing is added.
    expect(await ensureBuiltInPages(world.db, NOW)).toBe(0);
    expect(await world.db.select().from(siteDocuments)).toHaveLength(7);
  });

  it("are stored exactly as written: every block and value is one the site knows", async () => {
    for (const page of builtInPages()) {
      expect(parsePage(page.content), page.key).toEqual(page.content);
      const [row] = await world.db.select().from(siteDocuments).where(eq(siteDocuments.builtIn, page.key));
      expect(row.published, page.key).toEqual(page.content);
    }
  });

  it("name only live values and conditions that exist", async () => {
    const names = new Set(liveValues(await loadCatalog(world.db), await loadBusiness(world.db)).map((value) => value.name));
    for (const page of builtInPages()) {
      for (const [, inside] of JSON.stringify(page.content).matchAll(/\{([^{}"]+)\}/g)) {
        const condition = /^if (?:not )?(.+)$/.exec(inside)?.[1];
        expect(condition ? Object.hasOwn(CONDITIONS, condition) : names.has(inside), `${page.key}: {${inside}}`).toBe(true);
      }
    }
  });

  it("read as the pages written in the code did, with the settings as they are", async () => {
    const faq = await words("faq");
    expect(faq).toContain("Guest Information");
    expect(faq).toContain("We are at 7457 Aloma Ave, Suite 301, Winter Park, FL 32792. The studios are on the 3rd floor.");
    expect(faq).toContain("Bookings open 180 days ahead and close 24 hours before the start time.");
    expect(faq).toContain("Cancel 7 days (168 hours) or more before your start time and your payment is refunded to your card automatically, less the 5% payment processing fee.");
    expect(faq).toContain("Yes, once, until 24 hours before it starts.");
    expect(faq).toContain("The code is valid for 90 days.");
    expect(faq).toContain("You get 20% off when you book 2, 22% off when you book 3 or more.");
    expect(faq).toContain("Pets are welcome in Studio Dayglow only. The other studios and all common areas are pet-free.");
    expect(faq).not.toContain("Pets are welcome in every studio.");
    expect(faq).toContain("A pet fee of $40 applies per reservation");
    expect(faq).toContain("Studio Blanche up to 6, Studio Dayglow up to 6 and Studio Paris up to 4");
    expect(faq).toContain("When you have visited us 5 times, on separate days");
    // Nobody has written how to get in yet, so the question about it is not there; and no marker or name in braces shows.
    expect(faq).not.toContain("How do I get into the building?");
    expect(faq).not.toMatch(/\{[a-z]/);

    const policies = await words("policies");
    expect(policies).toContain("Cancellations made 7 days (168 hours) or more before the appointment are eligible for a full refund, excluding the non-refundable payment processing fee (5%).");
    expect(policies).toContain("may be rescheduled at no additional charge until 24 hours before the appointment.");
    expect(policies).toContain("Sessions are booked at least 14 days ahead.");
    expect(policies).toContain("Pets are permitted in Studio Dayglow only");
    expect(policies).toContain("Pets (Studio Dayglow only)");
    expect(policies).toContain("A pet fee of $40 applies per reservation and must be added when booking.");
    expect(policies).not.toContain("Pets are permitted in every studio");
    expect(policies).toContain("A minimum $70 cleaning fee may be charged");
    expect(policies).toContain("The Visuals Photo Studio reserves the right to end a session");
    expect(policies).not.toContain("Pets are not permitted.");
    expect(policies).not.toMatch(/\{[a-z]/);

    const services = await words("services");
    expect(services).toContain("Sessions start at $315. Please book at least 14 days ahead.");
    expect(services).toContain("Book a Photographer");
    expect(services).not.toContain("Ask About a Session");

    const rates = await words("rates");
    expect(rates).toContain("Book Studio Bundles");
    expect(rates).toContain("Add-ons");

    const home = await words("");
    expect(home).toContain("Where Every Frame Tells a Story");
    expect(home).toContain("Studio Blanche");
    expect(home).toContain("(407) 663-6109");
  });

  it("follow a change of the settings by themselves", async () => {
    await setting("maxReschedules", 0);
    await world.db.update(addons).set({ active: false }).where(eq(addons.kind, "pet"));
    await world.db.update(photoPackages).set({ active: false });
    await saveAccessInstructions(world.db, "Ring 301 at the door.");
    await setting("multiStudioPercent", {});

    const faq = await words("faq");
    expect(faq).not.toContain("Can I move my booking to another time?");
    expect(faq).not.toContain("You can move the booking instead");
    expect(faq).not.toContain("Can I bring my pet?");
    expect(faq).not.toContain("You get");
    expect(faq).toContain("How do I get into the building?");
    // The door code itself is never on a public page.
    expect(faq).not.toContain("Ring 301");

    const policies = await words("policies");
    expect(policies).toContain("Cancellations made less than 7 days before the appointment are non-refundable.");
    expect(policies).not.toContain("may be rescheduled");
    expect(policies).not.toContain("Once an appointment has been rescheduled");
    expect(policies).toContain("Pets are not permitted.");
    expect(policies).not.toContain("Pets (");
    expect(policies).not.toContain("Photography sessions with our in-house photographer");

    const services = await words("services");
    expect(services).toContain("Ask About a Session");
    expect(services).not.toContain("Book a Photographer");

    expect(await words("rates")).not.toContain("Book Studio Bundles");
  });

  it("name each studio's pet fee when they differ, and say so when every studio takes pets", async () => {
    const [dayglowFee] = await world.db.select().from(addons).where(eq(addons.kind, "pet"));
    await world.db.insert(addons).values({ slug: "pet-fee-paris", name: "Pet fee", description: "", priceCents: 3000, kind: "pet", studioId: world.ids.paris });
    let faq = await words("faq");
    expect(faq).toContain("Pets are welcome in Studio Dayglow and Studio Paris only.");
    expect(faq).toContain("A pet fee of $40 for Studio Dayglow and $30 for Studio Paris applies per reservation");
    expect(dayglowFee.priceCents).toBe(4000);

    // A pet fee for any booking: every studio takes pets.
    await world.db.update(addons).set({ studioId: null }).where(eq(addons.id, dayglowFee.id));
    faq = await words("faq");
    expect(faq).toContain("Pets are welcome in every studio. The common areas are pet-free.");
    expect(faq).not.toContain("only. The other studios");
    const policies = await words("policies");
    expect(policies).toContain("Pets are permitted in every studio and must be added to the reservation in advance.");
    expect(policies).not.toContain("Pets (");
    expect(policies).toContain("Pets A maximum of 2 pets per reservation");
  });

  it("never come back by themselves once deleted, and wait in the trash for good", async () => {
    const faq = await idOf("faq");
    expectOk(await deletePage(world.db, owner, faq, NOW));
    expect(await ensureBuiltInPages(world.db, NOW)).toBe(0);
    expect(await loadPublishedPage(world.db, "faq", NOW)).toBeNull();
    // An address freed by a deleted page is the owners' to use.
    const own = expectOk(await createPage(world.db, owner, { title: "Questions", slug: "faq" }, NOW)).id;
    expect(own).not.toBe(faq);
    expect(await emptyOldTrash(world.db, daysAfter(NOW, TRASH_DAYS + 5))).toBe(0);
    expect(await world.db.select().from(siteDocuments).where(eq(siteDocuments.id, faq))).toHaveLength(1);
    // Brought back while the address is taken, it gets one of its own.
    expect(await restorePage(world.db, owner, faq)).toMatchObject({ ok: true, path: "/faq-2" });
  });

  it("say where the website links to one, before it leaves the website", async () => {
    expect(await linksToPage(world.db, await idOf("faq"))).toEqual(["the menu (Info, Guest Information)", "the footer (Guest Information)", "the page \u201cContact\u201d"]);
    expect(await linksToPage(world.db, await idOf("policies"))).toEqual(["the menu (Info, Policies)", "the footer (Policies)", "the page \u201cGuest Information\u201d"]);
    // A page nothing links to.
    const made = expectOk(await createPage(world.db, owner, { title: "Gift Cards" }, NOW)).id;
    expect(await linksToPage(world.db, made)).toEqual([]);
  });

  it("start again from how they were built", async () => {
    const faq = await idOf("faq");
    const state = (await loadPageForEditing(world.db, owner, faq, NOW))!;
    expect(state.builtIn).toBe(true);
    const changed = { ...state.content, blocks: state.content.blocks.slice(0, 1) };
    expectOk(await savePageDraft(world.db, owner, faq, changed, { basedOn: state.revision, now: NOW }));
    expectOk(await restorePageVersion(world.db, owner, faq, BUILT_VERSION, NOW));
    const again = (await loadPageForEditing(world.db, owner, faq, NOW))!;
    expect(again.content).toEqual(builtInPages().find((page) => page.key === "faq")!.content);
    expect(again.hasDraft).toBe(false);
    // A page made in the admin has no such beginning.
    const made = expectOk(await createPage(world.db, owner, { title: "Gift Cards" }, NOW)).id;
    expect(await restorePageVersion(world.db, owner, made, BUILT_VERSION, NOW)).toMatchObject({ ok: false });
  });
});

describe("the home page", () => {
  it("keeps its address and stays on the website", async () => {
    const home = await idOf("");
    expect(await unpublishPage(world.db, owner, home, NOW)).toMatchObject({ ok: false, message: expect.stringContaining("cannot be taken off") });
    expect(await deletePage(world.db, owner, home, NOW)).toMatchObject({ ok: false, message: expect.stringContaining("cannot be deleted") });
    // Its name changes; an address sent with it is not taken.
    expectOk(await savePageSettings(world.db, owner, home, { title: "Welcome", slug: "welcome" }));
    const state = (await loadPageForEditing(world.db, owner, home, NOW))!;
    expect(state).toMatchObject({ title: "Welcome", slug: "", path: "/", home: true });
    expect(await loadPublishedPage(world.db, "", NOW)).not.toBeNull();
  });

  it("is copied to an address of its own", async () => {
    const copy = expectOk(await duplicatePage(world.db, owner, await idOf(""), NOW)).id;
    expect((await loadPageForEditing(world.db, owner, copy, NOW))!).toMatchObject({ slug: "home-copy", home: false, builtIn: false, isLive: false });
    expect(await world.db.select().from(siteVersions).where(eq(siteVersions.documentId, copy))).toHaveLength(0);
  });
});
