import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { media, settings, siteDocuments, siteFiles } from "@/db/schema";
import { DEFAULT_FRAME } from "@/lib/site/frame";
import type { AuthUser } from "./auth";
import { loadCatalog } from "./catalog";
import {
  addToCollection,
  collectionShows,
  createCollection,
  deleteCollection,
  listCollections,
  loadCollection,
  moveInCollection,
  removeFromCollection,
  saveCollection,
  showsInWords,
} from "./collections";
import {
  deleteMedia,
  describeMedia,
  listMedia,
  loadPictures,
  MEDIA_LIMITS,
  mediaUses,
  prepareImage,
  readMediaFile,
  replaceImage,
  safeFilename,
  uploadImage,
  usesInWords,
} from "./media";
import { addStudioPhotos, moveStudioPhoto, removeStudioPhoto, setStudioFloorPlan, STUDIO_PHOTO_LIMIT } from "./studio-photos";
import { saveStudioDetails } from "./admin";
import { createTestWorld, expectOk, minutesAfter, NOW, type TestWorld } from "./testing";
import { FRAME_DOC, saveDraft } from "./website";

/**
 * The owner's requirement 26: a media library to upload, organise, replace
 * and delete pictures; studio photos; seasonal collections; descriptions;
 * the order of photos; alt text; replacing a picture without touching the
 * pages that show it.
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

type Kind = "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff";
/** A picture of one colour, made here: no file has to be kept with the tests. */
async function picture(width: number, height: number, kind: Kind = "jpeg", colour = "#aa7744"): Promise<Uint8Array> {
  const made = sharp({ create: { width, height, channels: 3, background: colour } });
  return new Uint8Array(await made.toFormat(kind).toBuffer());
}
// Each picture a minute after the one before, so that "newest first" has one answer.
let uploads = 0;
const upload = async (name = "photo.jpg", viewer: AuthUser = owner, bytes?: Uint8Array) =>
  uploadImage(world.db, viewer, { bytes: bytes ?? (await picture(300, 200)), filename: name }, minutesAfter(NOW, uploads++));
const added = async (name?: string) => expectOk(await upload(name)).picture;
const described = async (name: string, alt: string) => {
  const one = await added(name);
  return expectOk(await describeMedia(world.db, owner, one.id, { alt, caption: "" }, NOW)).picture;
};
const fileCount = async () => (await world.db.select({ key: siteFiles.key }).from(siteFiles)).length;
const allow = (key: string) => world.db.insert(settings).values({ key, value: true }).onConflictDoUpdate({ target: settings.key, set: { value: true } });

describe("a picture as it is stored", () => {
  it("keeps its kind, and is saved again whatever arrived", async () => {
    for (const kind of ["jpeg", "png", "webp", "avif"] as const) {
      const prepared = await prepareImage(await picture(120, 80, kind));
      expect(prepared, kind).toMatchObject({ ok: true, width: 120, height: 80 });
      if (!prepared.ok) continue;
      const facts = await sharp(prepared.bytes).metadata();
      expect(facts.format === "heif" ? "avif" : facts.format, kind).toBe(kind);
      expect(prepared.contentType, kind).toBe(`image/${kind}`);
    }
  });

  it("is made no larger than a screen can use, in its own shape, and never enlarged", async () => {
    expect(await prepareImage(await picture(5000, 2500))).toMatchObject({ ok: true, width: MEDIA_LIMITS.edge, height: MEDIA_LIMITS.edge / 2 });
    expect(await prepareImage(await picture(1000, 4000, "png"))).toMatchObject({ ok: true, width: MEDIA_LIMITS.edge / 4, height: MEDIA_LIMITS.edge });
    expect(await prepareImage(await picture(40, 30))).toMatchObject({ ok: true, width: 40, height: 30 });
  });

  it("is turned the way the camera held it, and loses what the camera wrote into the file", async () => {
    // A camera held upright stores a wide picture and a note to turn it. It also stores where it was.
    const fromCamera = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#336699" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "Jane Smith", Make: "PhoneCo" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "28/1 35/1 0/1" } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = await sharp(fromCamera).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();

    const prepared = await prepareImage(new Uint8Array(fromCamera));
    expect(prepared).toMatchObject({ ok: true, width: 200, height: 400 });
    if (!prepared.ok) return;
    const after = await sharp(prepared.bytes).metadata();
    expect(after.orientation).toBeUndefined();
    expect(after.exif).toBeUndefined();
    expect(Buffer.from(prepared.bytes).includes("Jane Smith")).toBe(false);
    expect(Buffer.from(prepared.bytes).includes("PhoneCo")).toBe(false);
  });

  it("is refused when it is not a picture the website can show", async () => {
    const refused = async (bytes: Uint8Array) => {
      const result = await prepareImage(bytes);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.message;
    };
    expect(await refused(new Uint8Array(0))).toBe("That file is empty.");
    expect(await refused(new TextEncoder().encode("just some words, not a picture at all"))).toContain("could not be read as a picture");
    expect(await refused(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toContain("JPEG, PNG, WebP or AVIF");
    expect(await refused(await picture(20, 20, "gif"))).toContain("JPEG, PNG, WebP or AVIF");
    expect(await refused(await picture(20, 20, "tiff"))).toContain("JPEG, PNG, WebP or AVIF");
    expect(await refused(new Uint8Array(MEDIA_LIMITS.uploadBytes + 1))).toContain("too large");
    // A real picture's first bytes with the rest cut off.
    expect(await refused((await picture(300, 200)).slice(0, 200))).toContain("could not be read");
  });

  it("gets a name that is safe in an address, with the ending of what it really is", () => {
    expect(safeFilename("IMG 0042 (final).JPG", "jpg")).toBe("img-0042-final.jpg");
    expect(safeFilename("C:\\Users\\Jane\\Été à Paris.png", "webp")).toBe("ete-a-paris.webp");
    expect(safeFilename("../../etc/passwd", "jpg")).toBe("passwd.jpg");
    expect(safeFilename("???", "png")).toBe("picture.png");
    expect(safeFilename(`${"long".repeat(60)}.jpeg`, "jpg")).toHaveLength(64);
  });
});

describe("the library", () => {
  it("takes a picture from an owner, and keeps its file", async () => {
    const one = await added("Studio Blanche (wide).JPG");
    expect(one).toMatchObject({ width: 300, height: 200, alt: "", caption: "" });
    expect(one.url).toBe(`/media/${one.id}/1/studio-blanche-wide.jpg`);
    const file = (await readMediaFile(world.db, one.id))!;
    expect(file).toMatchObject({ contentType: "image/jpeg", version: 1, filename: "studio-blanche-wide.jpg" });
    expect((await sharp(file.bytes).metadata()).width).toBe(300);
    expect(await readMediaFile(world.db, "not-an-id")).toBeNull();
    expect(await readMediaFile(world.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("is for whoever may change the website: not an attendant, and a manager only when the owners say so", async () => {
    for (const viewer of [sam, mia]) {
      expect(await upload("x.jpg", viewer)).toMatchObject({ ok: false });
      expect(await listMedia(world.db, viewer)).toBeNull();
    }
    expect(await fileCount()).toBe(0);
    const one = await added();
    expect(await describeMedia(world.db, mia, one.id, { alt: "x", caption: "" }, NOW)).toMatchObject({ ok: false });
    expect(await deleteMedia(world.db, mia, one.id)).toMatchObject({ ok: false });
    expect(await replaceImage(world.db, mia, one.id, { bytes: await picture(10, 10), filename: "y.jpg" }, NOW)).toMatchObject({ ok: false });

    await allow("managerEditsDesign");
    expect(await upload("x.jpg", mia)).toMatchObject({ ok: true });
    expect(await listMedia(world.db, mia)).toHaveLength(2);
    expect(await listMedia(world.db, sam)).toBeNull();
  });

  it("does not store what is not a picture", async () => {
    expect(await upload("notes.jpg", owner, new TextEncoder().encode("not a picture"))).toMatchObject({ ok: false });
    expect(await world.db.select().from(media)).toEqual([]);
    expect(await fileCount()).toBe(0);
  });

  it("describes a picture once, for wherever it is shown", async () => {
    const one = await added();
    const saved = expectOk(await describeMedia(world.db, owner, one.id, { alt: "  Studio Blanche,\n all white  ", caption: `Winter set ${"x".repeat(500)}` }, NOW)).picture;
    expect(saved.alt).toBe("Studio Blanche, all white");
    expect(saved.caption).toHaveLength(MEDIA_LIMITS.caption);
    expect((await loadPictures(world.db, [one.id])).get(one.id)!.alt).toBe("Studio Blanche, all white");
    expect(await describeMedia(world.db, owner, "00000000-0000-4000-8000-000000000000", { alt: "x", caption: "" }, NOW)).toMatchObject({ ok: false });
  });

  it("replaces a picture's file in place: the same picture, a new address, the old file gone", async () => {
    const one = await described("old.jpg", "The white studio");
    const replaced = expectOk(await replaceImage(world.db, owner, one.id, { bytes: await picture(640, 480, "png"), filename: "New Shot.png" }, NOW)).picture;
    expect(replaced).toMatchObject({ id: one.id, width: 640, height: 480, alt: "The white studio" });
    expect(replaced.url).toBe(`/media/${one.id}/2/new-shot.png`);
    expect((await readMediaFile(world.db, one.id))!.contentType).toBe("image/png");
    expect(await fileCount()).toBe(1);
    // What is not a picture replaces nothing.
    expect(await replaceImage(world.db, owner, one.id, { bytes: new Uint8Array([1, 2, 3]), filename: "x.jpg" }, NOW)).toMatchObject({ ok: false });
    expect((await loadPictures(world.db, [one.id])).get(one.id)!.url).toBe(replaced.url);
    expect(await fileCount()).toBe(1);
  });

  it("lists pictures newest first, and narrows the list by words, by description and by use", async () => {
    const blanche = await described("blanche.jpg", "Studio Blanche, all white");
    const paris = await added("paris.jpg");
    expectOk(await addStudioPhotos(world.db, owner, world.ids.blanche, [blanche.id]));
    const names = async (options?: Parameters<typeof listMedia>[2]) => (await listMedia(world.db, owner, options))!.map((item) => item.filename);
    expect(await names()).toEqual(["paris.jpg", "blanche.jpg"]);
    expect(await names({ q: "WHITE" })).toEqual(["blanche.jpg"]);
    expect(await names({ q: "paris" })).toEqual(["paris.jpg"]);
    expect(await names({ filter: "undescribed" })).toEqual(["paris.jpg"]);
    expect(await names({ filter: "unused" })).toEqual(["paris.jpg"]);
    expect((await listMedia(world.db, owner))!.find((item) => item.id === blanche.id)!.uses).toEqual([{ where: "studio", name: "Studio Blanche" }]);
    expect(paris.alt).toBe("");
  });

  it("gives whatever shows pictures only the ones that exist", async () => {
    const one = await added();
    const found = await loadPictures(world.db, [one.id, one.id, "00000000-0000-4000-8000-000000000000", "junk", null, 7]);
    expect([...found.keys()]).toEqual([one.id]);
    expect(await loadPictures(world.db, [])).toEqual(new Map());
  });
});

describe("deleting a picture", () => {
  it("removes one that nothing shows, with its file", async () => {
    const one = await added();
    expect(await deleteMedia(world.db, owner, one.id)).toEqual({ ok: true });
    expect(await world.db.select().from(media)).toEqual([]);
    expect(await fileCount()).toBe(0);
    expect(await deleteMedia(world.db, owner, one.id)).toMatchObject({ ok: false, message: "That picture was not found." });
  });

  it("is refused while a studio, a collection or the header shows it, and says where", async () => {
    const one = await described("shown.jpg", "The white studio");
    expectOk(await addStudioPhotos(world.db, owner, world.ids.blanche, [one.id]));
    const christmas = expectOk(await createCollection(world.db, owner, "Christmas"));
    expectOk(await addToCollection(world.db, owner, christmas.id, [one.id]));
    // The header's logo, in a draft that is not even published: deleting the picture would still leave a hole.
    expectOk(await saveDraft(world.db, owner, FRAME_DOC, { ...DEFAULT_FRAME, logo: { ...DEFAULT_FRAME.logo, image: one.id } }, { basedOn: 0, now: NOW }));

    const refused = await deleteMedia(world.db, owner, one.id);
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.message).toBe("This picture is shown in the studio Studio Blanche, the collection Christmas and the header. Take it out there first, then delete it.");
    expect(await fileCount()).toBe(1);
    expect(usesInWords((await mediaUses(world.db, [one.id])).get(one.id)!)).toBe("the studio Studio Blanche, the collection Christmas and the header");

    expectOk(await removeStudioPhoto(world.db, owner, world.ids.blanche, one.id));
    expectOk(await removeFromCollection(world.db, owner, christmas.id, one.id));
    expect(await deleteMedia(world.db, owner, one.id)).toMatchObject({ ok: false });
    await world.db.delete(siteDocuments);
    expect(await deleteMedia(world.db, owner, one.id)).toEqual({ ok: true });
  });

  it("is refused while a page shows it, by the page's name", async () => {
    const one = await added();
    await world.db.insert(siteDocuments).values({ kind: "page", slug: "decor", title: "Our decor", published: { blocks: [{ type: "Image", picture: one.id }] } });
    const refused = await deleteMedia(world.db, owner, one.id);
    expect(!refused.ok && refused.message).toContain("the page Our decor");
    // A page in the trash shows nothing.
    await world.db.update(siteDocuments).set({ deletedAt: NOW });
    expect(await deleteMedia(world.db, owner, one.id)).toEqual({ ok: true });
  });
});

describe("a studio's facts and floor plan", () => {
  const blanche = async () => (await loadCatalog(world.db)).studios.find((studio) => studio.slug === "blanche")!;
  const details = { tagline: "A modern, all-white space.", description: "Bright.", includedGuests: 6, bufferMinutes: 15 };

  it("are written by the owners, and customers get them with the studio", async () => {
    expect(
      await saveStudioDetails(world.db, world.ids.blanche, {
        ...details,
        facts: { size: "850 sq ft", ceiling: "14 ft", light: "Windows facing southeast", cyclorama: "10 × 15 ft", included: ["Paper backdrops", "C-stands"] },
      }),
    ).toBe(true);
    expect((await blanche()).facts).toEqual({ size: "850 sq ft", ceiling: "14 ft", light: "Windows facing southeast", cyclorama: "10 × 15 ft", included: ["Paper backdrops", "C-stands"], floorPlan: "" });
  });

  it("take a floor plan that is described, keep it when the facts are saved again, and let it go", async () => {
    const silent = await added("plan-silent.jpg");
    expect(await setStudioFloorPlan(world.db, owner, world.ids.blanche, silent.id)).toMatchObject({
      ok: false,
      message: "Say what the picture plan-silent.jpg shows first, in the media library. Then choose it here.",
    });
    const plan = await described("plan.png", "Floor plan of Studio Blanche: 25 by 34 feet, windows on the long side");
    expectOk(await setStudioFloorPlan(world.db, owner, world.ids.blanche, plan.id));
    expect((await blanche()).floorPlan).toMatchObject({ id: plan.id, alt: "Floor plan of Studio Blanche: 25 by 34 feet, windows on the long side" });
    // Saving the studio's text keeps the floor plan, which is chosen on its own.
    expect(await saveStudioDetails(world.db, world.ids.blanche, { ...details, facts: { size: "850 sq ft", ceiling: "", light: "", cyclorama: "", included: [] } })).toBe(true);
    expect((await blanche()).facts).toMatchObject({ size: "850 sq ft", floorPlan: plan.id });
    // In use, it cannot be deleted from the library.
    expect(usesInWords((await mediaUses(world.db, [plan.id])).get(plan.id)!)).toBe("the studio Studio Blanche");
    expect(await deleteMedia(world.db, owner, plan.id)).toMatchObject({ ok: false });

    expectOk(await setStudioFloorPlan(world.db, owner, world.ids.blanche, ""));
    expect((await blanche()).floorPlan).toBeNull();
    expect((await mediaUses(world.db, [plan.id])).get(plan.id)).toEqual([]);
  });

  it("are the owners' to change", async () => {
    const plan = await described("plan.png", "A floor plan");
    for (const viewer of [mia, sam]) {
      expect(await setStudioFloorPlan(world.db, viewer, world.ids.blanche, plan.id)).toMatchObject({ ok: false, message: "Only an owner can change a studio's photos." });
    }
  });
});

describe("a studio's photos", () => {
  it("are pictures of the library in the owners' order, and customers get them with the studio", async () => {
    const [a, b, c] = [await described("a.jpg", "The cyclorama wall"), await described("b.jpg", "The window side"), await described("c.jpg", "The dressing area")];
    expectOk(await addStudioPhotos(world.db, owner, world.ids.blanche, [a.id, b.id]));
    expectOk(await addStudioPhotos(world.db, owner, world.ids.blanche, [b.id, c.id])); // b is there already: it stays where it is
    const photos = async () => (await loadCatalog(world.db)).studios.find((studio) => studio.slug === "blanche")!.photos.map((photo) => photo.alt);
    expect(await photos()).toEqual(["The cyclorama wall", "The window side", "The dressing area"]);

    expectOk(await moveStudioPhoto(world.db, owner, world.ids.blanche, c.id, -1));
    expect(await photos()).toEqual(["The cyclorama wall", "The dressing area", "The window side"]);
    expectOk(await moveStudioPhoto(world.db, owner, world.ids.blanche, a.id, -1)); // already first: nothing moves
    expectOk(await moveStudioPhoto(world.db, owner, world.ids.blanche, a.id, 1));
    expect(await photos()).toEqual(["The dressing area", "The cyclorama wall", "The window side"]);

    expectOk(await removeStudioPhoto(world.db, owner, world.ids.blanche, a.id));
    expect(await photos()).toEqual(["The dressing area", "The window side"]);
    // The other studios have none, and say so with an empty list.
    expect((await loadCatalog(world.db)).studios.find((studio) => studio.slug === "paris")!.photos).toEqual([]);
  });

  it("need a description first: a studio's photo says nothing to someone who cannot see it otherwise", async () => {
    const silent = await added("silent.jpg");
    const refused = await addStudioPhotos(world.db, owner, world.ids.blanche, [silent.id]);
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.message).toBe("Say what the picture silent.jpg shows first, in the media library. Then add it here.");
    expect((await loadCatalog(world.db)).studios.find((studio) => studio.slug === "blanche")!.photos).toEqual([]);
  });

  it("are the owners' to change, and at most twelve to a studio", async () => {
    const one = await described("a.jpg", "A wall");
    await allow("managerEditsDesign");
    for (const viewer of [mia, sam]) {
      expect(await addStudioPhotos(world.db, viewer, world.ids.blanche, [one.id])).toMatchObject({ ok: false, message: "Only an owner can change a studio's photos." });
      expect(await removeStudioPhoto(world.db, viewer, world.ids.blanche, one.id)).toMatchObject({ ok: false });
      expect(await moveStudioPhoto(world.db, viewer, world.ids.blanche, one.id, 1)).toMatchObject({ ok: false });
    }
    const many = [];
    for (let index = 0; index < STUDIO_PHOTO_LIMIT + 1; index++) many.push((await described(`p${index}.jpg`, `Photo ${index}`)).id);
    expect(await addStudioPhotos(world.db, owner, world.ids.blanche, many)).toMatchObject({ ok: false, message: "A studio takes 12 photos at most." });
    expectOk(await addStudioPhotos(world.db, owner, world.ids.blanche, many.slice(0, STUDIO_PHOTO_LIMIT)));
    expect(await addStudioPhotos(world.db, owner, "00000000-0000-4000-8000-000000000000", [one.id])).toMatchObject({ ok: false, message: "That studio was not found." });
  });
});

describe("collections", () => {
  it("hold pictures in an order that can be changed", async () => {
    const [a, b, c] = [await described("a.jpg", "Tree"), await described("b.jpg", "Fireplace"), await described("c.jpg", "Sleigh")];
    const { id } = expectOk(await createCollection(world.db, owner, "  Christmas   sets "));
    expectOk(await addToCollection(world.db, owner, id, [a.id, b.id, c.id, "junk", "00000000-0000-4000-8000-000000000000"]));
    const order = async () => (await loadCollection(world.db, id))!.pictures.map((one) => one.alt);
    expect((await loadCollection(world.db, id))!.name).toBe("Christmas sets");
    expect(await order()).toEqual(["Tree", "Fireplace", "Sleigh"]);
    expectOk(await moveInCollection(world.db, owner, id, c.id, -1));
    expectOk(await moveInCollection(world.db, owner, id, c.id, -1));
    expectOk(await moveInCollection(world.db, owner, id, c.id, -1)); // already first
    expect(await order()).toEqual(["Sleigh", "Tree", "Fireplace"]);
    expectOk(await removeFromCollection(world.db, owner, id, a.id));
    expect(await order()).toEqual(["Sleigh", "Fireplace"]);
    expect(await listCollections(world.db, owner)).toMatchObject([{ name: "Christmas sets", count: 2, cover: { alt: "Sleigh" } }]);
    expect(await moveInCollection(world.db, owner, id, a.id, 1)).toMatchObject({ ok: false, message: "That picture is not in the collection." });
  });

  it("show between their first and last day, or all year without dates", async () => {
    const { id } = expectOk(await createCollection(world.db, owner, "Christmas"));
    expect(collectionShows((await loadCollection(world.db, id))!, "2026-07-01")).toBe(true);
    expectOk(await saveCollection(world.db, owner, id, { name: "Christmas", description: "Sets for the season", startsOn: "2026-12-01", endsOn: "2026-12-26" }));
    const collection = (await loadCollection(world.db, id))!;
    expect(collection).toMatchObject({ description: "Sets for the season", startsOn: "2026-12-01", endsOn: "2026-12-26" });
    expect(collectionShows(collection, "2026-11-30")).toBe(false);
    expect(collectionShows(collection, "2026-12-01")).toBe(true);
    expect(collectionShows(collection, "2026-12-26")).toBe(true);
    expect(collectionShows(collection, "2026-12-27")).toBe(false);
    expect(showsInWords(collection, "2026-12-10")).toBe("Shown from Dec 1, 2026 to Dec 26, 2026: showing now.");
    expect(showsInWords(collection, "2027-01-10")).toBe("Shown from Dec 1, 2026 to Dec 26, 2026: not showing now.");
    expect(showsInWords({ startsOn: null, endsOn: null }, "2026-12-10")).toBe("Shown all year.");
  });

  it("refuse dates that are not dates, a last day before the first, and an empty name", async () => {
    const { id } = expectOk(await createCollection(world.db, owner, "Christmas"));
    const save = (input: Partial<Parameters<typeof saveCollection>[3]>) => saveCollection(world.db, owner, id, { name: "Christmas", description: "", startsOn: "", endsOn: "", ...input });
    expect(await save({ startsOn: "soon" })).toMatchObject({ ok: false, message: "Choose valid dates, or leave them empty." });
    expect(await save({ endsOn: "2026-02-30" })).toMatchObject({ ok: false });
    expect(await save({ startsOn: "2026-12-10", endsOn: "2026-12-01" })).toMatchObject({ ok: false, message: "The last day is before the first day." });
    expect(await save({ name: "   " })).toMatchObject({ ok: false, message: "Give the collection a name." });
    expect(await createCollection(world.db, owner, "")).toMatchObject({ ok: false });
    expect(await save({})).toMatchObject({ ok: true });
  });

  it("are for whoever may change the website", async () => {
    const { id } = expectOk(await createCollection(world.db, owner, "Christmas"));
    const one = await added();
    for (const viewer of [mia, sam]) {
      expect(await listCollections(world.db, viewer)).toBeNull();
      expect(await createCollection(world.db, viewer, "Mine")).toMatchObject({ ok: false });
      expect(await addToCollection(world.db, viewer, id, [one.id])).toMatchObject({ ok: false });
      expect(await deleteCollection(world.db, viewer, id)).toMatchObject({ ok: false });
    }
    await allow("managerEditsDesign");
    expect(await addToCollection(world.db, mia, id, [one.id])).toMatchObject({ ok: true });
  });

  it("can be deleted, which leaves the pictures in the library, unless a page shows the collection", async () => {
    const one = await added();
    const { id } = expectOk(await createCollection(world.db, owner, "Christmas"));
    expectOk(await addToCollection(world.db, owner, id, [one.id]));
    await world.db.insert(siteDocuments).values({ kind: "page", slug: "christmas", title: "Christmas", draft: { blocks: [{ type: "Gallery", collection: id }] } });
    expect(await deleteCollection(world.db, owner, id)).toMatchObject({ ok: false, message: "This collection is shown on Christmas. Take it off there first." });
    await world.db.delete(siteDocuments);
    expect(await deleteCollection(world.db, owner, id)).toMatchObject({ ok: true });
    expect(await loadCollection(world.db, id)).toBeNull();
    expect((await loadPictures(world.db, [one.id])).size).toBe(1);
    expect(await deleteMedia(world.db, owner, one.id)).toEqual({ ok: true });
  });
});
