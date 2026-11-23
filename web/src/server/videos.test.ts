import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { siteDocuments, videos } from "@/db/schema";
import { parseVideo } from "@/lib/site/video";
import type { AuthUser } from "./auth";
import { createTestWorld, NOW, type TestWorld } from "./testing";
import { DATABASE_VIDEO_MAX_BYTES, videoStore } from "./video-store";
import { deleteVideo, describeVideo, dropUnfinishedVideos, finishVideoUpload, listVideos, receiveDatabaseUpload, startVideoUpload, videoForPlayer } from "./videos";

/** The media library's video files (question 77 in ProjectLibrary.md), with no Neon storage set up: in the database. */
describe("videos of the media library", () => {
  let world: TestWorld;
  let owner: AuthUser;
  let customer: AuthUser;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(async () => {
    await world.reset();
    owner = await world.addUser("owner@studio.test", "owner");
    customer = await world.addUser("jane@example.com", "customer");
  });

  const clip = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 1, 2, 3, 4, 5, 6, 7, 8]);
  const upload = async (bytes = clip, filename = "Studio Tour (final).MP4") => {
    const started = await startVideoUpload(world.db, owner, { filename, contentType: "video/mp4", size: bytes.byteLength }, NOW);
    if (!started.ok) throw new Error(started.message);
    return started;
  };

  it("is uploaded in three steps, kept whole, listed and played by its own address", async () => {
    const started = await upload();
    expect(started.upload).toEqual({ url: `/api/videos/${started.id}/upload`, method: "PUT", headers: { "content-type": "video/mp4" } });
    // Not shown before the upload is finished.
    expect(await listVideos(world.db, owner)).toEqual([]);
    expect(await videoForPlayer(world.db, started.id)).toBeNull();

    expect(await receiveDatabaseUpload(world.db, owner, started.id, clip)).toEqual({ ok: true });
    expect(await finishVideoUpload(world.db, owner, started.id)).toEqual({ ok: true });
    const [item] = (await listVideos(world.db, owner))!;
    expect(item).toMatchObject({ id: started.id, filename: "studio-tour-final.mp4", size: clip.byteLength, address: `/videos/${started.id}`, title: "", shownOn: [] });
    expect(await videoForPlayer(world.db, started.id)).toEqual({ bytes: clip, contentType: "video/mp4" });
    expect(parseVideo(item.address)).toEqual({ service: "file", id: started.id, player: `/videos/${started.id}` });

    expect(await describeVideo(world.db, owner, started.id, "  A tour of   Studio Paris ")).toBe(true);
    expect((await listVideos(world.db, owner))![0].title).toBe("A tour of Studio Paris");
  });

  it("refuses what is not a video, too large or empty, a part of a file, and anyone outside the library", async () => {
    expect(await startVideoUpload(world.db, owner, { filename: "a.gif", contentType: "image/gif", size: 10 }, NOW)).toEqual({ ok: false, message: "That is not a video the site takes: an MP4, a MOV or a WebM file." });
    expect(await startVideoUpload(world.db, owner, { filename: "a.mp4", contentType: "video/mp4", size: DATABASE_VIDEO_MAX_BYTES + 1 }, NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/^That video is too large/) });
    expect(await startVideoUpload(world.db, owner, { filename: "a.mp4", contentType: "video/mp4", size: 0 }, NOW)).toEqual({ ok: false, message: "That file is empty." });
    expect(await startVideoUpload(world.db, customer, { filename: "a.mp4", contentType: "video/mp4", size: 10 }, NOW)).toEqual({ ok: false, message: "You cannot add videos to the website." });

    const started = await upload();
    expect(await receiveDatabaseUpload(world.db, owner, started.id, clip.subarray(0, 5))).toEqual({ ok: false, message: "The video did not arrive whole. Please try again." });
    // Finished without its file: dropped.
    expect(await finishVideoUpload(world.db, owner, started.id)).toEqual({ ok: false, message: "The video did not arrive whole. Please try again." });
    expect(await world.db.select().from(videos)).toEqual([]);
    expect(await listVideos(world.db, customer)).toBeNull();
  });

  it("is not deleted while a page shows it, and an upload never finished is dropped a day on", async () => {
    const started = await upload();
    await receiveDatabaseUpload(world.db, owner, started.id, clip);
    await finishVideoUpload(world.db, owner, started.id);
    await world.db.insert(siteDocuments).values({
      kind: "page",
      slug: "tour",
      title: "Tour",
      published: { meta: {}, blocks: [{ type: "Video", props: { id: "Video-1", address: `/videos/${started.id}`, title: "Tour", shape: "wide" } }] },
      publishedBy: "owner@studio.test",
      publishedAt: NOW,
    });
    expect((await listVideos(world.db, owner))![0].shownOn).toEqual(["Tour"]);
    expect(await deleteVideo(world.db, owner, started.id)).toEqual({ ok: false, message: "This video is shown on Tour. Take it out there first, then delete it." });
    await world.db.delete(siteDocuments).where(eq(siteDocuments.slug, "tour"));
    expect(await deleteVideo(world.db, owner, started.id)).toEqual({ ok: true });
    expect(await videoStore(world.db).sizeOf(`${started.id}/studio-tour-final.mp4`)).toBeNull();

    const left = await upload();
    expect(await dropUnfinishedVideos(world.db, NOW)).toBe(0); // not yet a day
    expect(await dropUnfinishedVideos(world.db, new Date(NOW.getTime() + 2 * 86_400_000))).toBe(1);
    expect(await world.db.select().from(videos).where(eq(videos.id, left.id))).toEqual([]);
  });
});

describe("Neon's storage for videos, once it is set up", () => {
  const settings = {
    VIDEO_BUCKET: "videos",
    NEON_STORAGE_ENDPOINT: "https://branch.storage.example.test",
    NEON_STORAGE_REGION: "us-east-1",
    NEON_STORAGE_KEY_ID: "test-key-id",
    NEON_STORAGE_SECRET: "test-secret",
  };
  beforeEach(() => Object.assign(process.env, settings));
  afterEach(() => {
    for (const name of Object.keys(settings)) delete process.env[name];
  });

  it("gives the browser a signed upload address in the bucket, and reads it there", async () => {
    const store = videoStore({} as never);
    expect(store.kind).toBe("neon");
    const address = await store.uploadAddress({ id: "x", key: "abc/studio-tour.mp4", contentType: "video/mp4" });
    const url = new URL(address.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://branch.storage.example.test/videos/abc/studio-tour.mp4");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^test-key-id\//);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(address).toMatchObject({ method: "PUT", headers: { "content-type": "video/mp4" } });
    expect(store.readAddress("abc/studio tour.mp4")).toBe("https://branch.storage.example.test/videos/abc/studio%20tour.mp4");
  });
});
