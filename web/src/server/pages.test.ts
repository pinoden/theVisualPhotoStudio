import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { settings, siteDocuments, siteVersions } from "@/db/schema";
import { eachBlock, parsePage, type PageContent } from "@/lib/site/page";
import type { AuthUser } from "./auth";
import { addToCollection, createCollection, saveCollection } from "./collections";
import { deleteMedia, describeMedia, uploadImage } from "./media";
import {
  addRedirect,
  createPage,
  deletePage,
  discardPageDraft,
  duplicatePage,
  emptyOldTrash,
  findRedirect,
  linkablePages,
  listedPages,
  listPages,
  listPageVersions,
  listRedirects,
  listTrash,
  loadPageForEditing,
  loadPagePreview,
  loadPublishedPage,
  pageCounts,
  publishedSlugs,
  publishPage,
  removeRedirect,
  restorePage,
  restorePageVersion,
  savePageDraft,
  savePageSettings,
  websiteCheckPaths,
  TRASH_DAYS,
  unpublishPage,
} from "./pages";
import { createTestWorld, daysAfter, expectOk, minutesAfter, NOW, type TestWorld } from "./testing";

/**
 * The owner's requirement 22: create, edit, duplicate, hide, publish,
 * unpublish and delete pages; rename them and change their addresses; and
 * requirement 27 for pages: drafts, publishing and a history of versions.
 */
let world: TestWorld;
let owner: AuthUser;
let mia: AuthUser; // Studio Manager
let sam: AuthUser; // Studio Attendant

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  mia = await world.addUser("mia@studio.test", "manager", "Mia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
});

const allow = (key: string) => world.db.insert(settings).values({ key, value: true }).onConflictDoUpdate({ target: settings.key, set: { value: true } });
const make = async (title = "Gift Cards", slug?: string) => expectOk(await createPage(world.db, owner, { title, slug }, NOW)).id;
const state = async (id: string) => (await loadPageForEditing(world.db, owner, id, NOW))!;
const heading = (text: string): PageContent => parsePage({ blocks: [{ type: "Section", props: { content: [{ type: "Heading", props: { text, level: "h1" } }] } }] });
/** Save `content` as the page's draft, on top of whatever is there. */
const draft = async (id: string, content: PageContent, viewer: AuthUser = owner) =>
  savePageDraft(world.db, viewer, id, content, { basedOn: (await state(id)).revision, now: NOW });
const titleOf = (content: PageContent) => {
  let text = "";
  eachBlock(content.blocks, (block) => {
    if (block.type === "Heading") text = String(block.props.text);
  });
  return text;
};
const published = async (slug: string) => {
  const page = await loadPublishedPage(world.db, slug, NOW);
  return page ? titleOf(page.content) : null;
};
const picture = async (name: string, alt = "") => {
  const bytes = new Uint8Array(await sharp({ create: { width: 60, height: 40, channels: 3, background: "#888888" } }).jpeg().toBuffer());
  const { id } = expectOk(await uploadImage(world.db, owner, { bytes, filename: name }, NOW)).picture;
  if (alt) expectOk(await describeMedia(world.db, owner, id, { alt, caption: "" }, NOW));
  return id;
};

describe("a new page", () => {
  it("starts as a draft with its name as its title, at an address made from the name", async () => {
    const id = await make("Gift Cards & More");
    const page = await state(id);
    expect(page).toMatchObject({ slug: "gift-cards-more", path: "/gift-cards-more", title: "Gift Cards & More", hasDraft: true, isLive: false, revision: 1, draftBy: owner.email });
    expect(titleOf(page.content)).toBe("Gift Cards & More");
    expect(await listPages(world.db, owner)).toMatchObject([{ title: "Gift Cards & More", state: "draft" }]);
    // Not on the website until it is published.
    expect(await loadPublishedPage(world.db, "gift-cards-more", NOW)).toBeNull();
    expect(await publishedSlugs(world.db)).toEqual([]);
    expect((await loadPagePreview(world.db, "gift-cards-more", NOW))!.title).toBe("Gift Cards & More");
  });

  it("takes the address that was typed for it, when that is free and not the site's own", async () => {
    await make("Decor", "studios-decor/winter");
    expect((await listPages(world.db, owner))![0].path).toBe("/studios-decor/winter");
    expect(await createPage(world.db, owner, { title: "Again", slug: "studios-decor/winter" }, NOW)).toMatchObject({ ok: false, message: "Another page already has the address /studios-decor/winter." });
    for (const taken of ["admin", "book/gift", "staff", "account"]) {
      const result = await createPage(world.db, owner, { title: "X", slug: taken }, NOW);
      expect(!result.ok && result.message, taken).toContain("the site uses that itself");
    }
    expect(await createPage(world.db, owner, { title: "X", slug: "Gift Cards" }, NOW)).toMatchObject({ ok: false });
    expect(await createPage(world.db, owner, { title: "   " }, NOW)).toMatchObject({ ok: false, message: "Give the page a name." });
  });

  it("gets a free address when its name gives one that is taken", async () => {
    await make("Gift Cards");
    await make("Gift Cards");
    await make("Gift Cards");
    expect((await listPages(world.db, owner))!.map((page) => page.slug).sort()).toEqual(["gift-cards", "gift-cards-2", "gift-cards-3"]);
    // A name that would give one of the site's own addresses gets another.
    expect((await state(await make("Book"))).slug).toBe("book-page");
  });
});

describe("a page's draft and what is published", () => {
  it("goes onto the website only when it is published, and keeps a copy of each publish", async () => {
    const id = await make();
    expectOk(await draft(id, heading("Gift cards for every occasion")));
    expect(await published("gift-cards")).toBeNull();

    expect(await publishPage(world.db, owner, id, minutesAfter(NOW, 5))).toEqual({ ok: true, version: 1, path: "/gift-cards" });
    expect(await published("gift-cards")).toBe("Gift cards for every occasion");
    expect(await state(id)).toMatchObject({ hasDraft: false, isLive: true, publishedBy: owner.email });
    expect((await listPages(world.db, owner))![0].state).toBe("live");
    expect(await publishedSlugs(world.db)).toEqual(["gift-cards"]);

    // A change waits as a draft: visitors keep seeing what was published.
    expectOk(await draft(id, heading("Gift cards, new wording")));
    expect(await published("gift-cards")).toBe("Gift cards for every occasion");
    expect((await listPages(world.db, owner))![0].state).toBe("changed");
    expect(titleOf((await loadPagePreview(world.db, "gift-cards", NOW))!.content)).toBe("Gift cards, new wording");
    expect(await publishPage(world.db, owner, id, minutesAfter(NOW, 9))).toMatchObject({ ok: true, version: 2 });
    expect(await published("gift-cards")).toBe("Gift cards, new wording");
    expect((await listPageVersions(world.db, owner, id))!.map((version) => [version.number, version.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(await publishPage(world.db, owner, id, NOW)).toMatchObject({ ok: false });
  });

  it("drops a draft that is the same as what is published, and discards one on request", async () => {
    const id = await make();
    expectOk(await publishPage(world.db, owner, id, NOW));
    const original = (await state(id)).content;
    expectOk(await draft(id, heading("Changed")));
    expect((await state(id)).hasDraft).toBe(true);
    expectOk(await draft(id, original));
    expect((await state(id)).hasDraft).toBe(false);

    expectOk(await draft(id, heading("Changed again")));
    expectOk(await discardPageDraft(world.db, owner, id));
    expect(titleOf((await state(id)).content)).toBe("Gift Cards");
    expect((await state(id)).hasDraft).toBe(false);
    // With no draft stored, a discard still moves the revision on: the editor starts again without a change it had not saved yet.
    const before = (await state(id)).revision;
    expectOk(await discardPageDraft(world.db, owner, id));
    expect((await state(id)).revision).toBe(before + 1);
  });

  it("has nothing to discard while it was never published", async () => {
    const id = await make();
    const refused = await discardPageDraft(world.db, owner, id);
    expect(!refused.ok && refused.message).toContain("there is nothing to go back to");
    expect((await state(id)).hasDraft).toBe(true);
  });

  it("can be taken off the website, keeping everything that was on it", async () => {
    const id = await make();
    expectOk(await draft(id, heading("Gift cards")));
    expectOk(await publishPage(world.db, owner, id, NOW));
    expectOk(await draft(id, heading("Gift cards, half written")));
    expect(await unpublishPage(world.db, owner, id, NOW)).toEqual({ ok: true, path: "/gift-cards" });
    expect(await published("gift-cards")).toBeNull();
    // The changes that were waiting are what stays, not the older published copy.
    expect(await state(id)).toMatchObject({ hasDraft: true, isLive: false });
    expect(titleOf((await state(id)).content)).toBe("Gift cards, half written");
    expect(await unpublishPage(world.db, owner, id, NOW)).toMatchObject({ ok: false, message: "This page is not on the website." });
    // Its history is kept, and it can go back on.
    expect(await listPageVersions(world.db, owner, id)).toHaveLength(1);
    expect(await publishPage(world.db, owner, id, NOW)).toMatchObject({ ok: true, version: 2 });
  });

  it("brings an earlier version back as the draft", async () => {
    const id = await make();
    expectOk(await draft(id, heading("First")));
    expectOk(await publishPage(world.db, owner, id, NOW));
    expectOk(await draft(id, heading("Second")));
    expectOk(await publishPage(world.db, owner, id, minutesAfter(NOW, 1)));
    const first = (await listPageVersions(world.db, owner, id))!.find((version) => version.number === 1)!;
    expect(await restorePageVersion(world.db, owner, id, first.id, NOW)).toEqual({ ok: true, number: 1 });
    expect(await published("gift-cards")).toBe("Second");
    expect(titleOf((await state(id)).content)).toBe("First");
    // A version of another page is not found.
    const other = await make("Other");
    expect(await restorePageVersion(world.db, owner, other, first.id, NOW)).toMatchObject({ ok: false });
  });

  it("notices two people editing at once", async () => {
    await allow("managerEditsPages");
    const id = await make();
    const opened = (await state(id)).revision;
    expectOk(await savePageDraft(world.db, mia, id, heading("Mia's"), { basedOn: opened, now: NOW }));
    const refused = await savePageDraft(world.db, owner, id, heading("Mine"), { basedOn: opened, now: NOW });
    expect(refused).toMatchObject({ ok: false, reason: "conflict", by: mia.email });
    expectOk(await savePageDraft(world.db, owner, id, heading("Mine"), { basedOn: opened, force: true, now: NOW }));
    expect(titleOf((await state(id)).content)).toBe("Mine");
  });

  it("stores only a valid page, whatever is sent", async () => {
    const id = await make();
    expectOk(
      await savePageDraft(
        world.db,
        owner,
        id,
        { blocks: [{ type: "Text", props: { text: '<p>Hi<script>alert(1)</script> <a href="javascript:x">there</a></p>' } }, { type: "Evil", props: {} }], extra: 1 },
        { basedOn: 1, now: NOW },
      ),
    );
    const [row] = await world.db.select().from(siteDocuments);
    expect(JSON.stringify(row.draft)).not.toMatch(/<script|javascript:|Evil|"extra"/);
    expect(await savePageDraft(world.db, owner, "00000000-0000-4000-8000-000000000000", {}, { basedOn: 0, now: NOW })).toMatchObject({ ok: false, reason: "missing" });
  });
});

describe("pictures on a page", () => {
  it("are loaded with the page, and a collection outside its dates is marked as not showing", async () => {
    const [a, b] = [await picture("a.jpg", "A tree"), await picture("b.jpg", "A sleigh")];
    const christmas = expectOk(await createCollection(world.db, owner, "Christmas")).id;
    expectOk(await addToCollection(world.db, owner, christmas, [b]));
    expectOk(await saveCollection(world.db, owner, christmas, { name: "Christmas", description: "", startsOn: "2020-12-01", endsOn: "2020-12-26" }));
    const id = await make("Decor");
    expectOk(
      await draft(
        id,
        parsePage({ blocks: [{ type: "Picture", props: { picture: a } }, { type: "Gallery", props: { source: "collection", collection: christmas } }, { type: "Picture", props: { picture: "00000000-0000-4000-8000-000000000000" } }] }),
      ),
    );
    const { site } = await state(id);
    expect(Object.keys(site.pictures).sort()).toEqual([a, b].sort());
    expect(site.pictures[a].alt).toBe("A tree");
    expect(site.collections[christmas]).toEqual({ name: "Christmas", pictures: [b], shows: false });
  });

  it("must all say what they show before the page is published", async () => {
    const silent = await picture("no-words.jpg");
    const id = await make("Decor");
    expectOk(await draft(id, parsePage({ blocks: [{ type: "Picture", props: { picture: silent } }] })));
    const refused = await publishPage(world.db, owner, id, NOW);
    expect(!refused.ok && refused.message).toBe("Not published: the picture no-words.jpg does not say what it shows. Describe it under Pictures, then publish.");
    expect(await published("decor")).toBeNull();
    expectOk(await describeMedia(world.db, owner, silent, { alt: "The winter set", caption: "" }, NOW));
    expect(await publishPage(world.db, owner, id, NOW)).toMatchObject({ ok: true });
    // And a picture that a page shows, even only in a draft, cannot be deleted.
    const refusedDelete = await deleteMedia(world.db, owner, silent);
    expect(!refusedDelete.ok && refusedDelete.message).toContain("the page Decor");
  });
});

describe("a page's name and address", () => {
  it("change at once, and a published page's old address is sent on to the new one", async () => {
    const id = await make();
    expectOk(await publishPage(world.db, owner, id, NOW));
    expect(await savePageSettings(world.db, owner, id, { title: "Gift Vouchers", slug: "gift-vouchers" })).toEqual({ ok: true, path: "/gift-vouchers" });
    expect(await state(id)).toMatchObject({ title: "Gift Vouchers", slug: "gift-vouchers" });
    expect(await published("gift-cards")).toBeNull();
    expect(await published("gift-vouchers")).toBe("Gift Cards");
    expect(await findRedirect(world.db, "/gift-cards")).toBe("/gift-vouchers");

    // Moved again: both old addresses lead to where the page is now.
    expectOk(await savePageSettings(world.db, owner, id, { title: "Gift Vouchers", slug: "vouchers" }));
    expect(await findRedirect(world.db, "/gift-cards")).toBe("/vouchers");
    expect(await findRedirect(world.db, "/gift-vouchers")).toBe("/vouchers");
    // Moved back: nothing leads away from the address it has.
    expectOk(await savePageSettings(world.db, owner, id, { title: "Gift Vouchers", slug: "gift-cards" }));
    expect(await findRedirect(world.db, "/gift-cards")).toBeNull();
    expect(await findRedirect(world.db, "/vouchers")).toBe("/gift-cards");
  });

  it("publish only the draft that was checked on phones", async () => {
    const id = await make();
    const checked = (await state(id)).revision;
    expectOk(await draft(id, heading("Changed after the check")));
    expect(await publishPage(world.db, owner, id, NOW, checked)).toMatchObject({ ok: false, message: expect.stringMatching(/changed somewhere else/) });
    expect(await published("gift-cards")).toBeNull();
    expectOk(await publishPage(world.db, owner, id, NOW, (await state(id)).revision));
  });

  it("take the place on the page with them: an old address's #section and ?query stay when its page moves", async () => {
    const id = await make("Rates Four", "four-rates");
    expectOk(await publishPage(world.db, owner, id, NOW));
    expectOk(await addRedirect(world.db, owner, { from: "/four-weekend", to: "/four-rates#weekend" }));
    expectOk(await addRedirect(world.db, owner, { from: "/four-flyer", to: "/four-rates?utm_source=flyer" }));
    expectOk(await savePageSettings(world.db, owner, id, { title: "Rates Four", slug: "four-prices" }));
    expect(await findRedirect(world.db, "/four-weekend")).toBe("/four-prices#weekend");
    expect(await findRedirect(world.db, "/four-flyer")).toBe("/four-prices?utm_source=flyer");
    expect(await findRedirect(world.db, "/four-rates")).toBe("/four-prices");
  });

  it("leave no redirect behind for a page nobody could have visited", async () => {
    const id = await make();
    expectOk(await savePageSettings(world.db, owner, id, { title: "Gift Cards", slug: "vouchers" }));
    expect(await findRedirect(world.db, "/gift-cards")).toBeNull();
  });

  it("cannot be another page's, the site's own, or nothing", async () => {
    const id = await make();
    await make("Decor");
    expect(await savePageSettings(world.db, owner, id, { title: "Gift Cards", slug: "decor" })).toMatchObject({ ok: false, message: "Another page already has the address /decor." });
    expect(await savePageSettings(world.db, owner, id, { title: "Gift Cards", slug: "admin/x" })).toMatchObject({ ok: false });
    expect(await savePageSettings(world.db, owner, id, { title: "", slug: "gift-cards" })).toMatchObject({ ok: false, message: "Give the page a name." });
    expect(await savePageSettings(world.db, owner, id, { title: "Gift Cards", slug: "" })).toMatchObject({ ok: false });
    expect((await state(id)).slug).toBe("gift-cards");
  });
});

describe("copying and deleting", () => {
  it("copies a page as a draft with an address of its own", async () => {
    const id = await make();
    expectOk(await draft(id, heading("Gift cards for every occasion")));
    expectOk(await publishPage(world.db, owner, id, NOW));
    const copy = expectOk(await duplicatePage(world.db, owner, id, NOW)).id;
    expect(await state(copy)).toMatchObject({ title: "Copy of Gift Cards", slug: "gift-cards-copy", isLive: false, hasDraft: true });
    expect(titleOf((await state(copy)).content)).toBe("Gift cards for every occasion");
    expect(await published("gift-cards-copy")).toBeNull();
    expect((await state(expectOk(await duplicatePage(world.db, owner, id, NOW)).id)).slug).toBe("gift-cards-copy-2");
  });

  it("puts a deleted page in the trash: off the website at once, its address free, and able to come back", async () => {
    const id = await make();
    expectOk(await publishPage(world.db, owner, id, NOW));
    expect(await deletePage(world.db, owner, id, NOW)).toEqual({ ok: true, path: "/gift-cards" });
    expect(await published("gift-cards")).toBeNull();
    expect(await listPages(world.db, owner)).toEqual([]);
    expect(await listTrash(world.db, owner)).toMatchObject([{ title: "Gift Cards", state: "draft" }]);
    expect(await loadPageForEditing(world.db, owner, id, NOW)).toBeNull();

    // Its address can be used by a new page meanwhile; brought back, the old one gets a free address.
    await make("Gift Cards");
    expect(await restorePage(world.db, owner, id)).toEqual({ ok: true, path: "/gift-cards-2" });
    expect(await state(id)).toMatchObject({ slug: "gift-cards-2", isLive: false, hasDraft: true });
    expect(await listTrash(world.db, owner)).toEqual([]);
    expect(await restorePage(world.db, owner, id)).toMatchObject({ ok: false, message: "That page is not in the trash." });
    // Its history came back with it.
    expect(await listPageVersions(world.db, owner, id)).toHaveLength(1);
  });

  it("empties the trash of what has been in it for a month, with its history", async () => {
    const [old, recent] = [await make("Old"), await make("Recent")];
    expectOk(await publishPage(world.db, owner, old, NOW));
    expectOk(await deletePage(world.db, owner, old, NOW));
    expectOk(await deletePage(world.db, owner, recent, daysAfter(NOW, TRASH_DAYS - 1)));
    const kept = await make("Kept");
    expect(await emptyOldTrash(world.db, daysAfter(NOW, TRASH_DAYS))).toBe(0);
    expect(await emptyOldTrash(world.db, daysAfter(NOW, TRASH_DAYS + 1))).toBe(1);
    expect((await listTrash(world.db, owner))!.map((page) => page.title)).toEqual(["Recent"]);
    expect(await world.db.select().from(siteVersions)).toEqual([]);
    expect(await state(kept)).toBeTruthy();
  });
});

describe("who may change pages", () => {
  it("is the owners, until they let a manager in; an attendant never", async () => {
    const id = await make();
    await allow("managerEditsDesign");
    await allow("managerPublishesWebsite");
    for (const viewer of [mia, sam]) {
      expect(await listPages(world.db, viewer)).toBeNull();
      expect(await listTrash(world.db, viewer)).toBeNull();
      expect(await listRedirects(world.db, viewer)).toBeNull();
      expect(await loadPageForEditing(world.db, viewer, id, NOW)).toBeNull();
      expect(await createPage(world.db, viewer, { title: "X" }, NOW)).toMatchObject({ ok: false });
      expect(await savePageDraft(world.db, viewer, id, {}, { basedOn: 1, now: NOW })).toMatchObject({ ok: false, reason: "forbidden" });
      expect(await publishPage(world.db, viewer, id, NOW)).toMatchObject({ ok: false });
      expect(await deletePage(world.db, viewer, id, NOW)).toMatchObject({ ok: false });
      expect(await duplicatePage(world.db, viewer, id, NOW)).toMatchObject({ ok: false });
      expect(await savePageSettings(world.db, viewer, id, { title: "X", slug: "x" })).toMatchObject({ ok: false });
    }
  });

  it("lets a manager who may edit pages prepare them, and leaves what changes the website to who may publish", async () => {
    await allow("managerEditsPages");
    const id = await make();
    expectOk(await publishPage(world.db, owner, id, NOW));
    expect((await loadPageForEditing(world.db, mia, id, NOW))!.may).toEqual({ publish: false });
    expectOk(await savePageDraft(world.db, mia, id, heading("Mia's wording"), { basedOn: (await state(id)).revision, now: NOW }));
    const own = expectOk(await createPage(world.db, mia, { title: "Mia's page" }, NOW)).id;

    // What would change the website is refused.
    expect(await publishPage(world.db, mia, id, NOW)).toMatchObject({ ok: false, message: "You cannot change what is published on the website. An owner can." });
    expect(await unpublishPage(world.db, mia, id, NOW)).toMatchObject({ ok: false });
    expect(await deletePage(world.db, mia, id, NOW)).toMatchObject({ ok: false });
    expect(await savePageSettings(world.db, mia, id, { title: "Gift Cards", slug: "elsewhere" })).toMatchObject({ ok: false });
    expect(await addRedirect(world.db, mia, { from: "/old", to: "/gift-cards" })).toMatchObject({ ok: false });
    expect(await published("gift-cards")).toBe("Gift Cards");
    // What does not is allowed: a new name for the page, and anything with a page that is not published.
    expect(await savePageSettings(world.db, mia, id, { title: "Gift cards!", slug: "gift-cards" })).toMatchObject({ ok: true });
    expect(await savePageSettings(world.db, mia, own, { title: "Mia's page", slug: "mias" })).toMatchObject({ ok: true });
    expect(await deletePage(world.db, mia, own, NOW)).toMatchObject({ ok: true });

    await allow("managerPublishesWebsite");
    expect(await publishPage(world.db, mia, id, NOW)).toMatchObject({ ok: true });
    expect(await published("gift-cards")).toBe("Mia's wording");
  });
});

describe("the pages a change of the design is measured on", () => {
  it("are every published page, hidden ones too, the booking screens and the account, and no draft", async () => {
    const shown = await make("Gift Cards");
    expectOk(await publishPage(world.db, owner, shown, NOW));
    const hidden = await make("Private Offer");
    const content = (await state(hidden)).content;
    expectOk(await draft(hidden, { ...content, meta: { ...content.meta, hidden: true } }));
    expectOk(await publishPage(world.db, owner, hidden, NOW));
    await make("Still a Draft");
    expect(await websiteCheckPaths(world.db)).toEqual(["/", "/gift-cards", "/private-offer", "/book", "/book/photography", "/account"]);
  });
});

describe("old addresses", () => {
  it("are sent on to where the owners say", async () => {
    expect(await addRedirect(world.db, owner, { from: " /Guestinfo/ ", to: "/faq" })).toEqual({ ok: true });
    expect(await addRedirect(world.db, owner, { from: "rates-1", to: "https://example.org/rates" })).toEqual({ ok: true });
    expect(await listRedirects(world.db, owner)).toEqual([
      { from: "/guestinfo", to: "/faq" },
      { from: "/rates-1", to: "https://example.org/rates" },
    ]);
    expect(await findRedirect(world.db, "/guestinfo")).toBe("/faq");
    expect(await findRedirect(world.db, "/nowhere")).toBeNull();
    // Written again, an address leads to the new place.
    expectOk(await addRedirect(world.db, owner, { from: "/guestinfo", to: "/contact" }));
    expect(await findRedirect(world.db, "/guestinfo")).toBe("/contact");
    expectOk(await removeRedirect(world.db, owner, "/guestinfo"));
    expect(await findRedirect(world.db, "/guestinfo")).toBeNull();
  });

  it("of the website this one replaced are sent on by migration 0074, except where the owners have decided otherwise", async () => {
    // The owners have made a page at one of the old addresses, and given another a destination of their own.
    await make("Events", "events");
    expectOk(await addRedirect(world.db, owner, { from: "/store", to: "/gift-cards" }));
    const migration = readFileSync(path.join(process.cwd(), "drizzle", "0074_old_addresses.sql"), "utf8");
    await world.db.execute(sql.raw(migration));
    const after = new Map((await listRedirects(world.db, owner))!.map((redirect) => [redirect.from, redirect.to]));
    expect(Object.fromEntries(after)).toEqual({
      "/appointments": "/book",
      "/blanche-1": "/studios#blanche",
      "/dayglow-1": "/studios#dayglow",
      "/paris": "/studios#paris",
      "/membership": "/memberships",
      "/home-1": "/",
      "/christmas-2026-dayglow": "/",
      "/christmas-2026-paris": "/",
      "/styled-setups": "/studios",
      "/privacy-policy": "/policies",
      // Theirs stays, and a page's own address leads nowhere else.
      "/store": "/gift-cards",
    });
    // Each is an address the site's own form would take, so the owners can change it there.
    for (const [from, to] of after) expect(await addRedirect(world.db, owner, { from, to }), from).toEqual({ ok: true });
    // Run again, it changes nothing.
    await world.db.execute(sql.raw(migration));
    expect((await listRedirects(world.db, owner))!).toHaveLength(after.size);
  });

  it("of the old website's shop lead to Guest Information since migration 0082, where /store still led home (the owner, 2026-11-28)", async () => {
    // Asked where /events and /store should lead: "Review the docs - I don't know either". On the old website /store
    // sells one thing, the free "Studio Guest Guide", and /events is an empty page.
    const read = (name: string) => readFileSync(path.join(process.cwd(), "drizzle", name), "utf8");
    const run = async (migration: string) => {
      for (const statement of migration.split("--> statement-breakpoint")) await world.db.execute(sql.raw(statement));
    };
    await run(read("0074_old_addresses.sql"));
    expect(await findRedirect(world.db, "/store")).toBe("/");
    await run(read("0082_store_leads_to_guest_information.sql"));
    expect(await findRedirect(world.db, "/store")).toBe("/faq");
    expect(await findRedirect(world.db, "/store/p/studio-guest-guide-free-download")).toBe("/faq");
    expect(await findRedirect(world.db, "/events")).toBe("/contact");
    // The guide's address is one the site's own form would take, so the owners can change it there.
    expect(await addRedirect(world.db, owner, { from: "/store/p/studio-guest-guide-free-download", to: "/faq" })).toEqual({ ok: true });
    // A destination the owners gave /store since is kept; run again, nothing changes.
    expectOk(await addRedirect(world.db, owner, { from: "/store", to: "/gift-cards" }));
    const before = await listRedirects(world.db, owner);
    await run(read("0082_store_leads_to_guest_information.sql"));
    expect(await listRedirects(world.db, owner)).toEqual(before);
    expect(await findRedirect(world.db, "/store")).toBe("/gift-cards");
  });

  it("cannot be a page's own address, the site's own, or lead nowhere", async () => {
    await make();
    const refused = async (from: string, to: string) => {
      const result = await addRedirect(world.db, owner, { from, to });
      expect(result.ok, `${from} -> ${to}`).toBe(false);
      return result.ok ? "" : result.message;
    };
    expect(await refused("/gift-cards", "/faq")).toContain("is the address of a page here");
    expect(await refused("/admin/x", "/faq")).toContain("Give the old address");
    expect(await refused("/", "/faq")).toContain("Give the old address");
    expect(await refused("/old page", "/faq")).toContain("Give the old address");
    expect(await refused("/old", "javascript:alert(1)")).toContain("Give where it should lead");
    expect(await refused("/old", "mailto:a@b.co")).toContain("Give where it should lead");
    expect(await refused("/old", "/old")).toBe("An address cannot lead to itself.");
    // The public route goes by the path alone, and the website takes off a slash at the end: these lead to themselves as well.
    expect(await refused("/old", "/old?from=menu")).toBe("An address cannot lead to itself.");
    expect(await refused("/old", "/old/")).toBe("An address cannot lead to itself.");
    // Nor through "." and ".." segments or escapes, which a browser and the website read as the same page.
    for (const to of ["/./old", "/x/../old", "/%2e/old", "/%6Fld"]) expect(await refused("/old", to), to).toBe("An address cannot lead to itself.");
    // So does the website's own full address, with or without "www.".
    const own = "https://thevisuals.example";
    for (const to of ["https://thevisuals.example/old", "http://www.thevisuals.example/old/"]) {
      expect((await addRedirect(world.db, owner, { from: "/old", to }, [own])).ok, to).toBe(false);
    }
    expectOk(await addRedirect(world.db, owner, { from: "/old", to: "https://example.org/old" }, [own]));
    expectOk(await removeRedirect(world.db, owner, "/old"));
    expect(await listRedirects(world.db, owner)).toEqual([]);
  });

  it("cannot send visitors round in a circle through other old addresses", async () => {
    await make();
    // In two steps, the second written with a "." segment.
    expectOk(await addRedirect(world.db, owner, { from: "/two-1", to: "/two-2" }));
    expect((await addRedirect(world.db, owner, { from: "/two-2", to: "/./two-1" })).ok).toBe(false);
    expectOk(await removeRedirect(world.db, owner, "/two-1"));
    expectOk(await addRedirect(world.db, owner, { from: "/ring-1", to: "/ring-2" }));
    expectOk(await addRedirect(world.db, owner, { from: "/ring-2", to: "/ring-3#top" }));
    expect(await addRedirect(world.db, owner, { from: "/ring-3", to: "/ring-1" })).toEqual({
      ok: false,
      message: "That would send visitors round in a circle: /ring-2 already leads back to /ring-3.",
    });
    // A chain that ends at a page is no circle, nor is one that leaves the site.
    expectOk(await addRedirect(world.db, owner, { from: "/ring-3", to: "/gift-cards" }));
    expectOk(await addRedirect(world.db, owner, { from: "/gift-cards-old", to: "/ring-1" }));
    expectOk(await addRedirect(world.db, owner, { from: "/away", to: "https://example.org/ring-1" }));
    expect((await listRedirects(world.db, owner))!.map((redirect) => redirect.from)).toEqual(["/away", "/gift-cards-old", "/ring-1", "/ring-2", "/ring-3"]);
  });

  it("go round through a page that is only a draft: a draft does not answer, so visitors are sent on", async () => {
    expectOk(await addRedirect(world.db, owner, { from: "/draft-a", to: "/onward-a" }));
    await make("Draft A", "draft-a"); // not published
    expect(await addRedirect(world.db, owner, { from: "/onward-a", to: "/draft-a" })).toMatchObject({ ok: false, message: expect.stringMatching(/round in a circle/) });
  });

  it("keep leading on while a draft page moved onto their address is not published", async () => {
    expectOk(await addRedirect(world.db, owner, { from: "/legacy-z", to: "/faq" }));
    const id = await make("Legacy", "legacy-draft");
    expectOk(await savePageSettings(world.db, owner, id, { title: "Legacy", slug: "legacy-z" }));
    expect(await findRedirect(world.db, "/legacy-z")).toBe("/faq");
    // Published, the page answers there and the old address is dropped.
    expectOk(await publishPage(world.db, owner, id, NOW));
    expect(await findRedirect(world.db, "/legacy-z")).toBeNull();
  });

  it("never go round when a draft page moves onto an old address that led to it", async () => {
    // In one step: /old-x led to the draft page, which now takes /old-x itself.
    const one = await make("Draft X", "draft-x");
    expectOk(await addRedirect(world.db, owner, { from: "/old-x", to: "/draft-x" }));
    expectOk(await savePageSettings(world.db, owner, one, { title: "Draft X", slug: "old-x" }));
    expect(await findRedirect(world.db, "/old-x")).toBeNull();
    // In two steps: /c led to /a, which led to the draft page, which now takes /c.
    const two = await make("Draft Two", "draft-two");
    expectOk(await addRedirect(world.db, owner, { from: "/a", to: "/draft-two" }));
    expectOk(await addRedirect(world.db, owner, { from: "/c", to: "/a" }));
    expectOk(await savePageSettings(world.db, owner, two, { title: "Draft Two", slug: "c" }));
    expect(await findRedirect(world.db, "/a")).toBe("/c");
    expect(await findRedirect(world.db, "/c")).toBeNull();
    // What led to the page's old address follows it, however it was written.
    const three = await make("Draft Three", "draft-three");
    expectOk(await addRedirect(world.db, owner, { from: "/to-three", to: "https://thevisuals.example/draft-three/" }, ["https://thevisuals.example"]));
    expectOk(await savePageSettings(world.db, owner, three, { title: "Draft Three", slug: "three" }, ["https://thevisuals.example"]));
    expect(await findRedirect(world.db, "/to-three")).toBe("/three");
  });

  it("know the site's own address written another way: with a dot at the end, or another name of the same computer", async () => {
    const own = ["http://localhost:3213"];
    for (const to of ["http://127.0.0.1:3213/own", "http://localhost.:3213/own", "http://LOCALHOST:3213/own/", "http://127.0.0.2:3213/./own"]) {
      expect(await addRedirect(world.db, owner, { from: "/own", to }, own), to).toEqual({ ok: false, message: "An address cannot lead to itself." });
    }
    // Another port is another server.
    expectOk(await addRedirect(world.db, owner, { from: "/own", to: "http://localhost:3000/own" }, own));
    // Any of the addresses the site is known by counts: the configured one and the one the owner is using.
    const both = ["https://thevisuals.example", "https://thevisuals-studio.vercel.app"];
    for (const to of ["https://thevisuals-studio.vercel.app/away", "https://thevisuals.example./away"]) {
      expect((await addRedirect(world.db, owner, { from: "/away", to }, both)).ok, to).toBe(false);
    }
  });

  it("are dropped from a page's own address once it is published, so taking it off leaves no circle", async () => {
    expectOk(await addRedirect(world.db, owner, { from: "/gifts-b", to: "/shop-b" }));
    const id = await make("Gifts B", "gifts-b");
    expectOk(await publishPage(world.db, owner, id, NOW));
    expect(await findRedirect(world.db, "/gifts-b")).toBeNull();
    // Leading to the page is fine while it is on the website...
    expectOk(await addRedirect(world.db, owner, { from: "/shop-b", to: "/gifts-b" }));
    // ...and taken off, it answers "not found" instead of sending visitors round.
    expectOk(await unpublishPage(world.db, owner, id, NOW));
    expect(await findRedirect(world.db, "/gifts-b")).toBeNull();
    expect(await findRedirect(world.db, "/shop-b")).toBe("/gifts-b");
  });
});

describe("what the rest of the site asks about pages", () => {
  it("lists the pages a link can lead to, a search engine may list, and how many are waiting", async () => {
    const [live, hidden, waiting] = [await make("Gift Cards"), await make("Private Offer"), await make("Half Written")];
    expectOk(await publishPage(world.db, owner, live, NOW));
    expectOk(await draft(hidden, parsePage({ meta: { hidden: true }, blocks: (await state(hidden)).content.blocks })));
    expectOk(await publishPage(world.db, owner, hidden, NOW));
    expect(await linkablePages(world.db)).toEqual([
      { path: "/gift-cards", title: "Gift Cards", live: true },
      { path: "/half-written", title: "Half Written", live: false },
      { path: "/private-offer", title: "Private Offer", live: true },
    ]);
    expect((await listedPages(world.db)).map((page) => page.path)).toEqual(["/gift-cards"]);
    expect((await listPages(world.db, owner))!.find((page) => page.id === hidden)!.hidden).toBe(true);
    expect(await pageCounts(world.db)).toEqual({ all: 3, waiting: 1 });
    expect(waiting).toBeTruthy();
  });
});
