import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bookings } from "@/db/schema";
import { askStudioToMove, type Actor } from "@/server/manage";
import { BASE_URL, createTestWorld, expectOk, FAR, NOW, OWNER_EMAIL, type TestWorld } from "@/server/testing";

/**
 * The booking page's action of asking the studio to move a booking (question 20), with the app's database and runtime
 * those of the test world: the tester's finding of 2026-11-18, that a message the box allowed was refused for its line
 * breaks, which a browser sends as two characters each.
 */
let world: TestWorld;

vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("@/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/db/client")>()), getDb: async () => world.db }));
vi.mock("@/server/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime")>()),
  manageDeps: async () => world.manageDeps(),
  flushEmailsSoon: () => {},
}));
vi.mock("@/server/session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/session")>()), getCurrentUser: async () => null }));

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

/** Ten lines of 99 characters: 999 as the box counts them (it allows 1,000). */
const tenLines = (lineBreak: string) => Array.from({ length: 10 }, (_, i) => `Line ${i} `.padEnd(99, "x")).join(lineBreak);

describe("asking the studio to move a booking, from the booking page", () => {
  it("takes a message the box accepted, line breaks and all, and keeps each break as one", async () => {
    const { askStudioToMoveAction } = await import("./actions");
    const booked = expectOk(await world.book({ date: FAR }));
    const form = new FormData();
    form.set("ref", booked.ref);
    form.set("token", booked.manageToken);
    form.set("message", tenLines("\r\n"));
    expect(await askStudioToMoveAction({ status: "idle", message: "" }, form)).toMatchObject({ status: "requested" });
    const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
    expect(row.label).toBe("reschedule_pending");
    // What the studio reads has plain line breaks.
    const [notice] = await world.emails("move_request_studio");
    expect(notice.body).toContain(tenLines("\n"));
    expect(notice.body).not.toContain("\r");
  });

  it("is refused by the service only above 1,000 characters as the box counts them", async () => {
    const booked = expectOk(await world.book({ date: FAR }));
    const actor: Actor = { kind: "token", token: booked.manageToken };
    expect(await askStudioToMove(world.db, booked.ref, actor, tenLines("\n"), { now: NOW, ownerEmail: OWNER_EMAIL, baseUrl: BASE_URL })).toEqual({ ok: true });
  });
});
