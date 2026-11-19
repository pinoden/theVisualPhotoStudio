import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { media, mediaCollectionItems, mediaCollections, studioPhotos, studios } from "@/db/schema";
import { eachBlock, parsePage, type PageContent } from "@/lib/site/page";
import { parseStudioFacts } from "@/lib/studio-facts";
import type { AuthUser } from "./auth";
import { IMPORTED_MARK, importOldSitePhotos, manifestProblems, type OldSiteManifest } from "./old-site-import";
import { createPage, loadPageForEditing, loadPublishedPage, publishPage, savePageDraft } from "./pages";
import { addStudioPhotos } from "./studio-photos";
import { uploadImage, describeMedia } from "./media";
import { createTestWorld, expectOk, NOW, type TestWorld } from "./testing";

/** The old website's photos, put into the media library and where the old site showed them (2026-11-19). */
let world: TestWorld;
let owner: AuthUser;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
});

/** A picture of one colour, made here, under the name the manifest gives it. */
const files = new Map<string, Uint8Array>();
async function file(name: string, colour: string, kind: "jpeg" | "png" | "webp" = "jpeg") {
  files.set(name, new Uint8Array(await sharp({ create: { width: 80, height: 60, channels: 3, background: colour } }).toFormat(kind).toBuffer()));
  return name;
}
const read = async (name: string) => {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`no file ${name}`);
  return bytes;
};

/** A photography page like the built-in one: a section headed "What’s Included", then one for booking. */
async function photographyPage(): Promise<string> {
  const { id } = expectOk(await createPage(world.db, owner, { title: "Professional Photography", slug: "services" }, NOW));
  const content: PageContent = parsePage({
    blocks: [
      { type: "Section", props: { id: "included", content: [{ type: "Heading", props: { id: "h-included", text: "What’s Included" } }] } },
      { type: "Section", props: { id: "booking", content: [{ type: "Heading", props: { id: "h-booking", text: "How to Book" } }] } },
    ],
  });
  const state = (await loadPageForEditing(world.db, owner, id, NOW))!;
  expectOk(await savePageDraft(world.db, owner, id, content, { basedOn: state.revision, now: NOW }));
  expectOk(await publishPage(world.db, owner, id, NOW));
  return id;
}

async function manifest(): Promise<OldSiteManifest> {
  return {
    source: "https://www.thevisualsphotostudio.com",
    photos: [
      { file: await file("a.jpg", "#ffffff"), name: "studio-paris-01.jpg", alt: "Studio Paris: a cream sofa", from: ["/paris"] },
      { file: await file("b.jpg", "#eeeeee"), name: "studio-paris-02.jpg", alt: "Studio Paris: a gold mirror", from: ["/paris"] },
      { file: await file("c.png", "#dddddd", "png"), name: "studio-paris-floor-plan.png", alt: "Floor plan of Studio Paris", from: ["/paris"] },
      { file: await file("d.webp", "#aa2222", "webp"), name: "christmas-2026-studio-paris-01.webp", alt: "Christmas 2026 in Studio Paris", from: ["/christmas-2026-paris"] },
      { file: await file("e.jpg", "#333333"), name: "photography-portfolio-01.jpg", alt: "Branding portrait", caption: "Photography Package", from: ["/services-2-1"] },
    ],
    studios: [{ slug: "paris", photos: [0, 1], floorPlan: 2 }],
    collections: [
      { name: "Christmas 2026: Studio Paris", description: "The Christmas 2026 set in Studio Paris.", startsOn: "2026-10-05", endsOn: "2027-01-02", photos: [3] },
      { name: "Photography portfolio", description: "Sessions by the studio's photographer.", photos: [4] },
    ],
    pageGalleries: [{ slug: "services", afterHeading: "What's Included", collection: "Photography portfolio", columns: 3, shape: "tall" }],
  };
}

const galleriesOn = (content: PageContent) => {
  const found: { at: number; collection: unknown }[] = [];
  content.blocks.forEach((block, at) =>
    eachBlock([block], (inner) => {
      if (inner.type === "Gallery") found.push({ at, collection: inner.props.collection });
    }),
  );
  return found;
};

describe("the old website's photos", () => {
  it("go into the library described, onto the studio after its own photos, into dated collections, and into a gallery on the page", async () => {
    const pageId = await photographyPage();
    // A photo the owners put on Paris before: it stays first, so it stays on the studio's card.
    const bytes = new Uint8Array(await sharp({ create: { width: 60, height: 40, channels: 3, background: "#123456" } }).jpeg().toBuffer());
    const theirs = expectOk(await uploadImage(world.db, owner, { bytes, filename: "theirs.jpg" }, NOW)).picture.id;
    expectOk(await describeMedia(world.db, owner, theirs, { alt: "Their own photo of Paris", caption: "" }, NOW));
    expectOk(await addStudioPhotos(world.db, owner, world.ids.paris, [theirs]));

    const { report } = expectOk(await importOldSitePhotos(world.db, owner, await manifest(), read, { publish: true, now: NOW }));
    expect(report).toMatchObject({ uploaded: 5, failed: [], notPlaced: [] });

    const library = await world.db.select().from(media);
    expect(library).toHaveLength(6);
    expect(library.find((row) => row.filename === "photography-portfolio-01.jpg")).toMatchObject({ alt: "Branding portrait", caption: "Photography Package", uploadedBy: owner.email });
    // The ending follows what the file is: the floor plan stays a PNG, the Christmas photo a WebP.
    expect(library.map((row) => row.filename).sort()).toContain("studio-paris-floor-plan.png");
    expect(library.map((row) => row.filename).sort()).toContain("christmas-2026-studio-paris-01.webp");

    const paris = await world.db.select({ mediaId: studioPhotos.mediaId, position: studioPhotos.position }).from(studioPhotos).where(eq(studioPhotos.studioId, world.ids.paris));
    const nameOf = (id: string) => library.find((row) => row.id === id)!.filename;
    expect(paris.sort((a, b) => a.position - b.position).map((row) => nameOf(row.mediaId))).toEqual(["theirs.jpg", "studio-paris-01.jpg", "studio-paris-02.jpg"]);
    const [studio] = await world.db.select({ facts: studios.facts }).from(studios).where(eq(studios.id, world.ids.paris));
    expect(nameOf(parseStudioFacts(studio.facts).floorPlan!)).toBe("studio-paris-floor-plan.png");

    const sets = await world.db.select().from(mediaCollections);
    const christmas = sets.find((set) => set.name === "Christmas 2026: Studio Paris")!;
    expect(christmas).toMatchObject({ startsOn: "2026-10-05", endsOn: "2027-01-02" });
    expect(christmas.description).toBe(`The Christmas 2026 set in Studio Paris. ${IMPORTED_MARK} (https://www.thevisualsphotostudio.com) on ${NOW.toISOString().slice(0, 10)}.`);
    const portfolio = sets.find((set) => set.name === "Photography portfolio")!;
    expect(await world.db.select().from(mediaCollectionItems).where(eq(mediaCollectionItems.collectionId, portfolio.id))).toHaveLength(1);

    // The gallery is in a section of its own, right after "What’s Included", and on the website.
    const shown = (await loadPublishedPage(world.db, "services", NOW))!;
    expect(galleriesOn(shown.content)).toEqual([{ at: 1, collection: portfolio.id }]);
    expect((await loadPageForEditing(world.db, owner, pageId, NOW))!.hasDraft).toBe(false);
    expect(report.placed).toContain("A gallery of Photography portfolio on /services, after \"What's Included\", published.");
  });

  it("runs once: a database that has them is refused, and nothing changes", async () => {
    await photographyPage();
    expectOk(await importOldSitePhotos(world.db, owner, await manifest(), read, { publish: false, now: NOW }));
    const before = (await world.db.select().from(media)).length;
    const again = await importOldSitePhotos(world.db, owner, await manifest(), read, { publish: false, now: NOW });
    expect(again).toEqual({ ok: false, message: expect.stringContaining("were imported into this database already") });
    expect((await world.db.select().from(media)).length).toBe(before);
  });

  it("leaves the gallery in the draft, unpublished, when the page has the owners' changes waiting or no publishing was asked", async () => {
    const pageId = await photographyPage();
    const state = (await loadPageForEditing(world.db, owner, pageId, NOW))!;
    const changed = parsePage({ ...state.content, blocks: [...state.content.blocks, { type: "Section", props: { id: "theirs", content: [{ type: "Heading", props: { id: "h-theirs", text: "Coming soon" } }] } }] });
    expectOk(await savePageDraft(world.db, owner, pageId, changed, { basedOn: state.revision, now: NOW }));

    const { report } = expectOk(await importOldSitePhotos(world.db, owner, await manifest(), read, { publish: true, now: NOW }));
    expect(report.placed.find((line) => line.startsWith("A gallery"))).toContain("the page already had changes waiting, so it was not published here");
    expect(galleriesOn((await loadPublishedPage(world.db, "services", NOW))!.content)).toEqual([]);
    const draft = (await loadPageForEditing(world.db, owner, pageId, NOW))!;
    expect(galleriesOn(draft.content)).toHaveLength(1);
    // The owners' own change is still in the draft.
    let theirs = false;
    eachBlock(draft.content.blocks, (block) => (theirs ||= block.props.id === "theirs"));
    expect(theirs).toBe(true);
  });

  it("refuses a manifest that breaks the library's rules before changing anything, and reports a file it cannot read", async () => {
    const tooMany = await manifest();
    tooMany.studios[0].photos = Array.from({ length: 13 }, () => 0);
    tooMany.photos[1].alt = " ";
    tooMany.collections[0].photos = [9];
    expect(manifestProblems(tooMany)).toEqual([
      "Photo 1 (studio-paris-02.jpg) does not say what it shows.",
      "Studio paris has 13 photos: a studio takes 12 at most.",
      "Collection Christmas 2026: Studio Paris: photo 9 is not in the list of 5.",
    ]);
    expect(await importOldSitePhotos(world.db, owner, tooMany, read, { publish: false, now: NOW })).toMatchObject({ ok: false });
    expect(await world.db.select().from(media)).toEqual([]);

    const missing = await manifest();
    missing.photos[4].file = "gone.jpg";
    const { report } = expectOk(await importOldSitePhotos(world.db, owner, missing, read, { publish: false, now: NOW }));
    expect(report.uploaded).toBe(4);
    expect(report.failed).toEqual([{ name: "photography-portfolio-01.jpg", why: "the file could not be read (no file gone.jpg)" }]);
  });

  it("is for owners only", async () => {
    const mia = await world.addUser("mia@studio.test", "manager", "Mia");
    expect(await importOldSitePhotos(world.db, mia, await manifest(), read, { publish: false, now: NOW })).toEqual({ ok: false, message: "Only an owner can import the old website's photos." });
  });
});
