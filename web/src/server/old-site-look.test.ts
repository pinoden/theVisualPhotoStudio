import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { StoredBlock } from "@/lib/site/blocks/fields";
import { eachBlock, parsePage } from "@/lib/site/page";
import type { AuthUser } from "./auth";
import { addToCollection, createCollection } from "./collections";
import { describeMedia, uploadImage } from "./media";
import { CHRISTMAS_UNTIL, CHRISTMAS_WORDS, HOME_GALLERY, LOOK_PHOTOS, applyOldSiteLook, homeLook } from "./old-site-look";
import { ensureBuiltInPages, listPages, loadPageForEditing, publishPage, savePageDraft } from "./pages";
import { createTestWorld, expectOk, NOW, type TestWorld } from "./testing";

/** The old website's pictures shown the way it showed them, on the home, photography and price pages (2026-11-19). */
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

/** A picture of one colour in the library, under a name the old site's import gave it. */
async function libraryPhoto(name: string): Promise<string> {
  const kind = name.endsWith(".webp") ? "webp" : name.endsWith(".png") ? "png" : "jpeg";
  const bytes = new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: "#cccccc" } }).toFormat(kind).toBuffer());
  const added = await uploadImage(world.db, owner, { bytes, filename: name }, NOW);
  if (!added.ok) throw new Error(added.message);
  expectOk(await describeMedia(world.db, owner, added.picture.id, { alt: `What ${name} shows`, caption: "" }, NOW));
  return added.picture.id;
}

async function pageId(slug: string): Promise<string> {
  return (await listPages(world.db, owner))!.find((page) => page.slug === slug)!.id;
}

/** Change a page as the owners would, and publish it. */
async function publishAs(slug: string, change: (blocks: StoredBlock[]) => StoredBlock[]): Promise<void> {
  const id = await pageId(slug);
  const state = (await loadPageForEditing(world.db, owner, id, NOW))!;
  const saved = expectOk(await savePageDraft(world.db, owner, id, { ...state.content, blocks: change(state.content.blocks) }, { basedOn: state.revision, now: NOW }));
  expectOk(await publishPage(world.db, owner, id, NOW, saved.revision));
}

async function draftOf(slug: string): Promise<StoredBlock[]> {
  const state = (await loadPageForEditing(world.db, owner, await pageId(slug), NOW))!;
  return state.content.blocks;
}

const find = (blocks: StoredBlock[], test: (block: StoredBlock) => boolean) => {
  let found: StoredBlock | undefined;
  eachBlock(blocks, (block) => {
    if (!found && test(block)) found = block;
  });
  return found;
};

/** Everything the changes place: the photos by their library names, the home gallery, and the portfolio on the photography page. */
async function oldSiteLibrary(except: string[] = []): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const name of Object.values(LOOK_PHOTOS)) if (!except.includes(name)) ids[name] = await libraryPhoto(name);
  const gallery = expectOk(await createCollection(world.db, owner, HOME_GALLERY));
  expectOk(await addToCollection(world.db, owner, gallery.id!, [await libraryPhoto("home-gallery-01.jpg")]));
  ids[HOME_GALLERY] = gallery.id!;
  const portfolio = expectOk(await createCollection(world.db, owner, "Photography portfolio"));
  ids.portfolio = portfolio.id!;
  // As the old site's import put it there: in a section of its own, as a grid of three.
  await publishAs("services", (blocks) => [
    ...blocks,
    { type: "Section", props: { id: "old-site-photos-1", content: [{ type: "Gallery", props: { id: "old-site-gallery-1", source: "collection", collection: portfolio.id, columns: 3, shape: "tall" } }] } },
  ]);
  return ids;
}

describe("showing the old website's pictures its way", () => {
  it("changes the home, photography and price pages' drafts, and the website shows them as they were until each is published", async () => {
    const ids = await oldSiteLibrary();
    const result = await applyOldSiteLook(world.db, owner, NOW);
    if (!result.ok) throw new Error(result.message);
    expect(result.missing).toEqual([]);
    expect(result.pages.map((page) => [page.path, page.changes.length > 0, page.skipped])).toEqual([
      ["/", true, undefined],
      ["/services", true, undefined],
      ["/rates", true, undefined],
    ]);
    // What the website showed before, for the page's history.
    expect(result.pages.every((page) => page.versionBefore! >= 1)).toBe(true);

    const home = await draftOf("");
    expect(home[0].type).toBe("Banner");
    expect(home[0].props.picture).toBe(ids[LOOK_PHOTOS.homeHero]);
    expect(find(home, (block) => block.type === "StudioCards")!.props.look).toBe("arches");
    // The Christmas setups right under the title, a photo either side of the old site's words.
    expect(home[1].props.id).toBe("old-site-look-christmas");
    const christmas = find(home, (block) => block.type === "Columns" && block.props.id.startsWith("old-site-look-christmas"))!;
    expect((christmas.props.one as StoredBlock[])[0].props.picture).toBe(ids[LOOK_PHOTOS.christmasLeft]);
    expect((christmas.props.two as StoredBlock[])[0].props.text).toContain("<strong>Studio Paris</strong> will feature");
    expect((christmas.props.three as StoredBlock[])[0].props.picture).toBe(ids[LOOK_PHOTOS.christmasRight]);
    // The home gallery just before the address.
    const galleryAt = home.findIndex((block) => block.props.id === "old-site-look-instagram");
    expect(find([home[galleryAt + 1]], (block) => block.type === "ContactDetails")).toBeDefined();
    expect(find([home[galleryAt]], (block) => block.type === "Gallery")!.props).toMatchObject({ collection: ids[HOME_GALLERY], columns: 4, columnsPhone: 2, shape: "tall" });

    const services = await draftOf("services");
    expect(services[1].props.id).toBe("old-site-look-lead");
    expect(find(services, (block) => block.type === "Picture")!.props).toMatchObject({ picture: ids[LOOK_PHOTOS.servicesLead], shape: "standard", size: "large" });
    expect(find(services, (block) => block.props.id === "old-site-gallery-1")!.props).toMatchObject({ layout: "row", columns: 3, columnsPhone: 1 });

    expect((await draftOf("rates"))[0].props.picture).toBe(ids[LOOK_PHOTOS.ratesBand]);

    // Nothing was published here: the editor publishes, after its check on phones.
    const live = await world.db.query.siteDocuments.findMany();
    for (const row of live.filter((row) => ["", "services", "rates"].includes(row.slug))) {
      expect(row.draft).not.toBeNull();
      expect(JSON.stringify(parsePage(row.published))).not.toContain("old-site-look");
    }
  });

  it("changes nothing a second time, once the pages are published", async () => {
    await oldSiteLibrary();
    const first = await applyOldSiteLook(world.db, owner, NOW);
    if (!first.ok) throw new Error(first.message);
    for (const page of first.pages) expectOk(await publishPage(world.db, owner, page.id!, NOW, page.revision));
    const again = await applyOldSiteLook(world.db, owner, NOW);
    if (!again.ok) throw new Error(again.message);
    expect(again.pages.map((page) => page.changes)).toEqual([[], [], []]);
    expect(again.pages.every((page) => page.skipped === undefined)).toBe(true);
  });

  it("leaves a page with the owners' changes waiting as it is, and keeps a picture the owners chose", async () => {
    const ids = await oldSiteLibrary();
    const theirs = await libraryPhoto("their-own-hero.jpg");
    await publishAs("", (blocks) => blocks.map((block) => (block.type === "Banner" ? { ...block, props: { ...block.props, picture: theirs } } : block)));
    // A change of the rates page the owners have not published yet.
    const rates = await pageId("rates");
    const state = (await loadPageForEditing(world.db, owner, rates, NOW))!;
    expectOk(await savePageDraft(world.db, owner, rates, { ...state.content, meta: { ...state.content.meta, title: "Our prices" } }, { basedOn: state.revision, now: NOW }));

    const result = await applyOldSiteLook(world.db, owner, NOW);
    if (!result.ok) throw new Error(result.message);
    expect(result.pages.find((page) => page.path === "/rates")!.skipped).toBe("the page has changes waiting for the owners: nothing was changed");
    expect((await loadPageForEditing(world.db, owner, rates, NOW))!.content.meta.title).toBe("Our prices");
    const home = await draftOf("");
    expect(home[0].props.picture).toBe(theirs);
    expect(home[0].props.picture).not.toBe(ids[LOOK_PHOTOS.homeHero]);
    expect(result.pages.find((page) => page.path === "/")!.changes).not.toContain("Studio Paris's first photo across the top, behind the title");
  });

  it("says which photos are not in the library, and places the others", async () => {
    await oldSiteLibrary([LOOK_PHOTOS.ratesBand, LOOK_PHOTOS.christmasLeft]);
    const result = await applyOldSiteLook(world.db, owner, NOW);
    if (!result.ok) throw new Error(result.message);
    expect(result.missing).toEqual([`the photo ${LOOK_PHOTOS.christmasLeft}`, `the photo ${LOOK_PHOTOS.ratesBand}`]);
    expect(result.pages.find((page) => page.path === "/rates")!.changes).toEqual([]);
    // Without one of its two photos, the Christmas section is not added; the rest of the home page is.
    const home = await draftOf("");
    expect(home.some((block) => block.props.id === "old-site-look-christmas")).toBe(false);
    expect(home.some((block) => block.props.id === "old-site-look-instagram")).toBe(true);
  });

  it("is for owners only", async () => {
    const staff = await world.addUser("staff@studio.test", "staff", "Sam");
    const result = await applyOldSiteLook(world.db, staff, NOW);
    expect(result.ok).toBe(false);
  });
});

describe("the home page's Christmas setups", () => {
  const library = { photos: { christmasLeft: "left", christmasRight: "right" } };
  const page: StoredBlock[] = [{ type: "Banner", props: { id: "home-1", look: "hero", title: "Welcome" } }];

  it("are added until the old site's last day for them, and not after", () => {
    expect(homeLook(page, library, CHRISTMAS_UNTIL).changes).toContain("the Christmas setups under the title, until January 2");
    expect(homeLook(page, library, "2027-01-03").changes).toEqual([]);
  });

  it("keep the old site's words as they were", () => {
    const text = find(homeLook(page, library, "2026-11-19").blocks, (block) => block.type === "Text")!.props.text;
    expect(text).toBe(CHRISTMAS_WORDS.text);
    expect(text).toContain("Available October 1 - January 2, 2027");
  });
});
