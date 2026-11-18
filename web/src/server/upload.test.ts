import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFormData } from "./upload";

// The two upload addresses, run with a signed-in visitor of the test's choosing and the test's database.
const state = vi.hoisted(() => ({ db: undefined as unknown, user: null as unknown }));
vi.mock("@/server/session", () => ({ getCurrentUser: async () => state.user, sameSiteRequest: () => true }));
vi.mock("@/db/client", async (original) => ({ ...(await original<typeof import("@/db/client")>()), getDb: async () => state.db }));
import { POST as uploadPicture } from "@/app/admin/website/media/upload/route";
import { POST as uploadFont } from "@/app/admin/website/fonts/upload/route";
import { createTestWorld, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
  state.db = world.db;
});
afterAll(() => world.close());
beforeEach(() => world.reset());

/** A body sent in parts with no length, as a chunked request does, which counts the parts asked of it. */
function chunked(parts: number, size: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= parts) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(size));
    },
  });
  return { body, pulled: () => pulled };
}

const post = (body: ReadableStream<Uint8Array> | FormData, headers: Record<string, string> = {}) =>
  new Request("http://localhost/upload", {
    method: "POST",
    body,
    headers: body instanceof FormData ? headers : { "content-type": "multipart/form-data; boundary=x", ...headers },
    duplex: "half",
  } as RequestInit);

describe("reading an upload", () => {
  it("stops a body sent with no length as soon as it is over the limit, without reading the rest", async () => {
    const stream = chunked(1000, 64 * 1024); // 64 MB, read whole
    expect(await readFormData(post(stream.body), 1024 * 1024)).toEqual({ ok: false, problem: "too_large" });
    expect(stream.pulled()).toBeLessThan(40);
  });

  it("refuses a body that says it is too large without reading it", async () => {
    const stream = chunked(1000, 64 * 1024);
    expect(await readFormData(post(stream.body, { "content-length": String(20 * 1024 * 1024) }), 1024 * 1024)).toEqual({ ok: false, problem: "too_large" });
    expect(stream.pulled()).toBeLessThanOrEqual(1);
  });

  it("gives the form of a body within the limit", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    form.set("replace", "x");
    const read = await readFormData(post(form), 1024 * 1024);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect((read.form.get("file") as File).size).toBe(3);
    expect(read.form.get("replace")).toBe("x");
  });
});

describe("the upload addresses", () => {
  it("refuse a visitor who may not add pictures or fonts before reading anything they send", async () => {
    state.user = await world.addUser("cleo@example.com", "customer", "Cleo");
    for (const upload of [uploadPicture, uploadFont]) {
      const stream = chunked(1000, 64 * 1024);
      expect((await upload(post(stream.body))).status).toBe(403);
      expect(stream.pulled()).toBeLessThanOrEqual(1);
    }
  });

  it("stop an owner's picture sent with no length as soon as it is over the limit", async () => {
    state.user = await world.addUser("owner@studio.test", "owner", "Olivia");
    const stream = chunked(1000, 256 * 1024); // 256 MB, read whole
    const response = await uploadPicture(post(stream.body));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, message: "That file is too large: 15 MB at most." });
    // 15 MB and a little over is about 61 parts.
    expect(stream.pulled()).toBeLessThan(70);
  });
});
