import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { siteFiles } from "@/db/schema";
import type { AuthUser } from "./auth";
import { fileStore, moveFilesToBucket } from "./files";
import { deleteMedia, readMediaFile, replaceImage, uploadImage } from "./media";
import { createTestWorld, expectOk, NOW, type TestWorld } from "./testing";

/**
 * The website's pictures and fonts in Neon's storage (the owners' word of 2026-11-23; question 78 in ProjectLibrary.md),
 * with the bucket stood in for by a map: what the site writes, reads and removes there, the files of the database read
 * until they are moved, and nothing removed before the change that let go of it is committed.
 */
let world: TestWorld;
let owner: AuthUser;
const bucket = new Map<string, { bytes: Uint8Array; contentType: string }>();
let failDeletes = false;

const settings = {
  FILES_BUCKET: "site-files",
  NEON_STORAGE_ENDPOINT: "https://branch.storage.example.test",
  NEON_STORAGE_REGION: "us-east-1",
  NEON_STORAGE_KEY_ID: "test-key-id",
  NEON_STORAGE_SECRET: "test-secret",
};

const missing = (name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  bucket.clear();
  failDeletes = false;
  Object.assign(process.env, settings);
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body, ContentType } = command.input;
      expect(Bucket).toBe("site-files");
      bucket.set(Key!, { bytes: new Uint8Array(Body as Uint8Array), contentType: ContentType! });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const file = bucket.get(command.input.Key!);
      if (!file) throw missing("NoSuchKey");
      return { ContentType: file.contentType, Body: { transformToByteArray: async () => file.bytes } };
    }
    if (command instanceof HeadObjectCommand) {
      const file = bucket.get(command.input.Key!);
      if (!file) throw missing("NotFound");
      return { ContentLength: file.bytes.byteLength };
    }
    if (command instanceof DeleteObjectCommand) {
      if (failDeletes) throw new Error("The storage did not answer.");
      bucket.delete(command.input.Key!);
      return {};
    }
    throw new Error("Not a command the site sends.");
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of Object.keys(settings)) delete process.env[name];
});

const picture = async (colour = "#aa7744") => new Uint8Array(await sharp({ create: { width: 30, height: 20, channels: 3, background: colour } }).jpeg().toBuffer());
const rows = async () => (await world.db.select({ key: siteFiles.key }).from(siteFiles)).map((row) => row.key);

describe("the website's files in Neon's bucket, once it is set up", () => {
  it("keeps an uploaded picture in the bucket, not the database, and serves it at the same address", async () => {
    const shown = expectOk(await uploadImage(world.db, owner, { bytes: await picture(), filename: "front.jpg" }, NOW)).picture;
    expect([...bucket.keys()]).toEqual([expect.stringMatching(/^pictures\/[0-9a-f-]+\.jpg$/)]);
    expect(await rows()).toEqual([]);
    const file = await readMediaFile(world.db, shown.id);
    expect(file?.contentType).toBe("image/jpeg");
    expect(file?.bytes).toEqual([...bucket.values()][0].bytes);
  });

  it("still reads a file from the database until it is moved, and the move empties the database", async () => {
    // Uploaded before the bucket was set up.
    for (const name of Object.keys(settings)) delete process.env[name];
    const before = expectOk(await uploadImage(world.db, owner, { bytes: await picture("#123456"), filename: "old.jpg" }, NOW)).picture;
    const [key] = await rows();
    Object.assign(process.env, settings);

    expect((await readMediaFile(world.db, before.id))?.bytes.byteLength).toBeGreaterThan(0);
    expect(await fileStore(world.db).sizeOf(key)).toBeGreaterThan(0);

    const counted = await moveFilesToBucket(world.db, { apply: false });
    expect(counted).toMatchObject({ waiting: { files: 1 }, moved: 0 });
    expect(bucket.size).toBe(0);

    const moved = await moveFilesToBucket(world.db, { apply: true });
    expect(moved.moved).toBe(1);
    expect(await rows()).toEqual([]);
    expect([...bucket.keys()]).toEqual([key]);
    expect((await readMediaFile(world.db, before.id))?.bytes).toEqual(bucket.get(key)!.bytes);
    expect(await moveFilesToBucket(world.db, { apply: true })).toMatchObject({ waiting: { files: 0 }, moved: 0 });
  });

  it("removes a replaced picture's old file, and a deleted picture's, from the bucket", async () => {
    const one = expectOk(await uploadImage(world.db, owner, { bytes: await picture(), filename: "a.jpg" }, NOW)).picture;
    const [first] = [...bucket.keys()];
    expectOk(await replaceImage(world.db, owner, one.id, { bytes: await picture("#00ff00"), filename: "b.jpg" }, NOW));
    expect(bucket.has(first)).toBe(false);
    expect(bucket.size).toBe(1);
    expect(await deleteMedia(world.db, owner, one.id)).toEqual({ ok: true });
    expect(bucket.size).toBe(0);
  });

  it("lets a replacement stand when the old file cannot be removed: the site shows the new one", async () => {
    const one = expectOk(await uploadImage(world.db, owner, { bytes: await picture(), filename: "a.jpg" }, NOW)).picture;
    failDeletes = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const replaced = expectOk(await replaceImage(world.db, owner, one.id, { bytes: await picture("#00ff00"), filename: "b.jpg" }, NOW)).picture;
    expect(replaced.url).not.toBe(one.url);
    expect(bucket.size).toBe(2);
    const shown = await readMediaFile(world.db, one.id);
    expect(shown).toMatchObject({ filename: "b.jpg", version: 2 });
  });

  it("does not take a storage that fails for a file that is not there", async () => {
    vi.mocked(S3Client.prototype.send).mockRejectedValue(new Error("The storage did not answer."));
    await expect(fileStore(world.db).get("pictures/x.jpg")).rejects.toThrow("did not answer");
  });
});
