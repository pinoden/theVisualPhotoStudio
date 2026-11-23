import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { media, siteDocuments } from "@/db/schema";
import type { AuthUser } from "./auth";
import { deleteMedia, listMedia } from "./media";
import { ensureBuiltInPages, loadPublishedPage } from "./pages";
import {
  addPhotographyPhotos,
  loadPhotographyPhotos,
  movePhotographyPhoto,
  pagesShowingPhotographyPhotos,
  PHOTOGRAPHY_PHOTO_LIMIT,
  removePhotographyPhoto,
  showsPhotographyPhotos,
} from "./photography-photos";
import { createTestWorld, NOW, type TestWorld } from "./testing";

/** The photos the site shows for photography, chosen under Admin → Photography (question 73 in ProjectLibrary.md). */
describe("Photography's photos", () => {
  let world: TestWorld;
  let owner: AuthUser;
  let manager: AuthUser;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(async () => {
    await world.reset();
    owner = await world.addUser("owner@studio.test", "owner");
    manager = await world.addUser("manager@studio.test", "manager");
  });

  const addPicture = async (alt: string, name = "shoot.jpg") =>
    (
      await world.db
        .insert(media)
        .values({ fileKey: `test/${name}`, filename: name, contentType: "image/jpeg", size: 1000, width: 800, height: 1000, alt, uploadedBy: "owner@studio.test" })
        .returning({ id: media.id })
    )[0].id;
  const order = async () => (await loadPhotographyPhotos(world.db)).map((picture) => picture.alt);

  it("are the owners' to add, order and take off, each saying what it shows", async () => {
    const [a, b, c] = [await addPicture("A family session in Blanche"), await addPicture("A maternity portrait"), await addPicture("Twins in Paris")];
    expect(await addPhotographyPhotos(world.db, owner, [a, b])).toEqual({ ok: true });
    expect(await addPhotographyPhotos(world.db, owner, [b, c, "not-an-id"])).toEqual({ ok: true }); // b is there already
    expect(await order()).toEqual(["A family session in Blanche", "A maternity portrait", "Twins in Paris"]);

    expect(await movePhotographyPhoto(world.db, owner, c, -1)).toEqual({ ok: true });
    expect(await movePhotographyPhoto(world.db, owner, a, -1)).toEqual({ ok: true }); // already first
    expect(await order()).toEqual(["A family session in Blanche", "Twins in Paris", "A maternity portrait"]);
    expect(await removePhotographyPhoto(world.db, owner, a)).toEqual({ ok: true });
    expect(await order()).toEqual(["Twins in Paris", "A maternity portrait"]);

    // Used here, a picture cannot be deleted from the library; taken off, it can.
    expect((await listMedia(world.db, owner))!.find((item) => item.id === c)!.uses).toEqual([{ where: "photography", name: "photos" }]);
    expect(await deleteMedia(world.db, owner, c)).toMatchObject({ ok: false, message: "This picture is shown in the photography photos. Take it out there first, then delete it." });
    expect(await deleteMedia(world.db, owner, a)).toMatchObject({ ok: true });
  });

  it("refuses a picture that says nothing, more than the limit, and anyone but an owner", async () => {
    const blank = await addPicture("  ", "untitled.jpg");
    expect(await addPhotographyPhotos(world.db, owner, [blank])).toEqual({
      ok: false,
      message: "Say what the picture untitled.jpg shows first, in the media library. Then add it here.",
    });
    expect(await addPhotographyPhotos(world.db, owner, [])).toEqual({ ok: false, message: "Choose at least one picture." });
    const many = [];
    for (let n = 0; n <= PHOTOGRAPHY_PHOTO_LIMIT; n++) many.push(await addPicture(`Session ${n}`, `s${n}.jpg`));
    expect(await addPhotographyPhotos(world.db, owner, many)).toEqual({ ok: false, message: `Photography takes ${PHOTOGRAPHY_PHOTO_LIMIT} photos at most.` });
    expect(await addPhotographyPhotos(world.db, owner, many.slice(0, PHOTOGRAPHY_PHOTO_LIMIT))).toEqual({ ok: true });

    const one = many[0];
    expect(await addPhotographyPhotos(world.db, manager, [one])).toEqual({ ok: false, message: "Only an owner can change the photography photos." });
    expect(await removePhotographyPhoto(world.db, manager, one)).toMatchObject({ ok: false });
    expect(await movePhotographyPhoto(world.db, manager, one, 1)).toMatchObject({ ok: false });
    expect(await loadPhotographyPhotos(world.db)).toHaveLength(PHOTOGRAPHY_PHOTO_LIMIT);
  });

  it("show on the Photography page the site starts with, and wherever a Gallery is set to them", async () => {
    await ensureBuiltInPages(world.db, NOW);
    const first = await addPicture("A newborn session");
    await addPhotographyPhotos(world.db, owner, [first]);

    const page = (await loadPublishedPage(world.db, "services", NOW))!;
    expect(showsPhotographyPhotos(page.content.blocks)).toBe(true);
    expect(page.site.photography).toEqual([first]);
    expect(page.site.pictures[first]).toMatchObject({ alt: "A newborn session" });
    expect(await pagesShowingPhotographyPhotos(world.db)).toEqual([{ title: expect.any(String), slug: "services" }]);
    // A page with no such gallery does not read them.
    expect((await loadPublishedPage(world.db, "rates", NOW))!.site.photography).toBeUndefined();

    // A Gallery inside a section of another page.
    const gallery = { type: "Gallery", props: { id: "Gallery-1", source: "photography" } };
    await world.db.insert(siteDocuments).values({
      kind: "page",
      slug: "portfolio",
      title: "Portfolio",
      published: { meta: {}, blocks: [{ type: "Section", props: { id: "Section-1", content: [gallery] } }] },
      publishedBy: "owner@studio.test",
      publishedAt: NOW,
    });
    expect((await pagesShowingPhotographyPhotos(world.db)).map((shown) => shown.slug).sort()).toEqual(["portfolio", "services"]);
    expect(showsPhotographyPhotos([{ type: "Gallery", props: { id: "Gallery-2", source: "collection" } }])).toBe(false);
  });
});
