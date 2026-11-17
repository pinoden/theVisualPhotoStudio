import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { settings, siteDocuments, siteVersions } from "@/db/schema";
import { DEFAULT_DESIGN, type Design } from "@/lib/site/design";
import { DEFAULT_FRAME, type SiteFrame } from "@/lib/site/frame";
import { requestLoginCode, type AuthUser } from "./auth";
import { createTestWorld, expectOk, hoursAfter, minutesAfter, NOW, type TestWorld } from "./testing";
import {
  DESIGN_DOC,
  discardDraft,
  FRAME_DOC,
  listVersions,
  loadBusiness,
  loadDraftOrPublished,
  loadForEditing,
  loadPublished,
  publishDraft,
  restoreVersion,
  saveDraft,
  websiteAbilities,
} from "./website";

/**
 * The owner's requirement 27: drafts, publishing and a history of versions,
 * and the part of requirement 28 that is about the website: who may change
 * it, and who may publish.
 */
let world: TestWorld;
let owner: AuthUser;
let mia: AuthUser; // Studio Manager
let sam: AuthUser; // Studio Attendant
let jane: AuthUser; // a customer

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  mia = await world.addUser("mia@studio.test", "manager", "Mia");
  sam = await world.addUser("sam@studio.test", "staff", "Sam");
  jane = await world.addUser("jane@example.com", "customer", "Jane");
});

const allow = (key: string, value = true) =>
  world.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });

const design = (accent: string): Design => ({ ...DEFAULT_DESIGN, colors: { ...DEFAULT_DESIGN.colors, accent } });
/** Save a design as the owner's draft, on top of whatever is there. */
async function draft(accent: string, viewer: AuthUser = owner, now = NOW) {
  const state = await loadForEditing(world.db, owner, DESIGN_DOC);
  return saveDraft(world.db, viewer, DESIGN_DOC, design(accent), { basedOn: state!.revision, now });
}
const publishedAccent = async () => (await loadPublished(world.db, DESIGN_DOC)).colors.accent;

describe("a website nobody has changed", () => {
  it("shows the site as it was built, with nothing stored", async () => {
    expect(await loadPublished(world.db, DESIGN_DOC)).toEqual(DEFAULT_DESIGN);
    expect(await loadPublished(world.db, FRAME_DOC)).toEqual(DEFAULT_FRAME);
    expect(await loadDraftOrPublished(world.db, DESIGN_DOC)).toEqual(DEFAULT_DESIGN);
    expect(await world.db.select().from(siteDocuments)).toEqual([]);
    const state = (await loadForEditing(world.db, owner, DESIGN_DOC))!;
    expect(state).toMatchObject({ hasDraft: false, revision: 0, draftAt: null, publishedAt: null, publishedBy: null, may: { publish: true } });
    expect(state.content).toEqual(DEFAULT_DESIGN);
    expect(state.original).toEqual(DEFAULT_DESIGN);
    expect(await listVersions(world.db, owner, DESIGN_DOC)).toEqual([]);
  });
});

describe("a draft", () => {
  it("is kept apart from what visitors see", async () => {
    const saved = expectOk(await draft("#112233"));
    expect(saved).toMatchObject({ revision: 1, hasDraft: true, savedAt: NOW.toISOString() });
    expect(await publishedAccent()).toBe(DEFAULT_DESIGN.colors.accent);
    expect((await loadDraftOrPublished(world.db, DESIGN_DOC)).colors.accent).toBe("#112233");
    const state = (await loadForEditing(world.db, owner, DESIGN_DOC))!;
    expect(state).toMatchObject({ hasDraft: true, revision: 1, draftBy: owner.email, draftAt: NOW.toISOString(), publishedAt: null });
    expect(state.content.colors.accent).toBe("#112233");
    expect(state.published).toEqual(DEFAULT_DESIGN);
    // The other document is untouched.
    expect((await loadForEditing(world.db, owner, FRAME_DOC))!.hasDraft).toBe(false);
  });

  it("is stored valid, whatever was sent", async () => {
    const state = (await loadForEditing(world.db, owner, DESIGN_DOC))!;
    const saved = expectOk(
      await saveDraft(
        world.db,
        owner,
        DESIGN_DOC,
        { colors: { accent: "#ABCDEF", text: "red;}body{display:none" }, buttons: { radius: 9999 }, extra: "<script>" },
        { basedOn: state.revision, now: NOW },
      ),
    );
    expect(saved.content).toEqual({ ...DEFAULT_DESIGN, colors: { ...DEFAULT_DESIGN.colors, accent: "#abcdef" }, buttons: { ...DEFAULT_DESIGN.buttons, radius: 40 } });
    const [row] = await world.db.select().from(siteDocuments);
    expect(row.draft).toEqual(saved.content);
  });

  it("that is the same as what is published is no draft at all", async () => {
    expectOk(await draft("#112233"));
    const back = expectOk(await draft(DEFAULT_DESIGN.colors.accent));
    expect(back.hasDraft).toBe(false);
    expect((await loadForEditing(world.db, owner, DESIGN_DOC))!).toMatchObject({ hasDraft: false, draftBy: null, draftAt: null });
  });

  it("can be thrown away, which leaves the website and its history alone", async () => {
    expectOk(await draft("#112233"));
    expectOk(await publishDraft(world.db, owner, DESIGN_DOC, NOW));
    expectOk(await draft("#445566"));
    expect(await discardDraft(world.db, owner, DESIGN_DOC)).toEqual({ ok: true });
    const state = (await loadForEditing(world.db, owner, DESIGN_DOC))!;
    expect(state.hasDraft).toBe(false);
    expect(state.content.colors.accent).toBe("#112233");
    expect(await publishedAccent()).toBe("#112233");
    expect(await listVersions(world.db, owner, DESIGN_DOC)).toHaveLength(1);
    // Discarding when there is nothing to discard is not an error. It moves the revision on all the same, so that an
    // editor holding a change it had not saved yet starts again from what is published.
    const before = state.revision;
    expect(await discardDraft(world.db, owner, DESIGN_DOC)).toEqual({ ok: true });
    expect((await loadForEditing(world.db, owner, DESIGN_DOC))!.revision).toBe(before + 1);
  });
});

describe("publishing", () => {
  it("makes the draft what visitors see, and keeps a copy as a version", async () => {
    expectOk(await draft("#112233"));
    const later = hoursAfter(NOW, 2);
    expect(await publishDraft(world.db, owner, DESIGN_DOC, later)).toEqual({ ok: true, version: 1 });
    expect(await publishedAccent()).toBe("#112233");
    const state = (await loadForEditing(world.db, owner, DESIGN_DOC))!;
    expect(state).toMatchObject({ hasDraft: false, draftBy: null, publishedBy: owner.email, publishedAt: later.toISOString() });
    const versions = (await listVersions(world.db, owner, DESIGN_DOC))!;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ number: 1, publishedBy: owner.email, publishedAt: later.toISOString(), current: true });
  });

  it("is refused when there is nothing to publish", async () => {
    const nothing = await publishDraft(world.db, owner, DESIGN_DOC, NOW);
    expect(nothing).toMatchObject({ ok: false });
    expect(!nothing.ok && nothing.message).toContain("nothing to publish");
    expect(await world.db.select().from(siteVersions)).toEqual([]);
  });

  it("numbers the versions, newest first, and marks the one that is on the website", async () => {
    for (const [index, accent] of ["#111111", "#222222", "#333333"].entries()) {
      expectOk(await draft(accent, owner, minutesAfter(NOW, index)));
      expectOk(await publishDraft(world.db, owner, DESIGN_DOC, minutesAfter(NOW, index)));
    }
    const versions = (await listVersions(world.db, owner, DESIGN_DOC))!;
    expect(versions.map((version) => [version.number, version.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
  });

  it("keeps the two documents apart: publishing the design does not publish the menu", async () => {
    expectOk(await draft("#112233"));
    const frame = (await loadForEditing(world.db, owner, FRAME_DOC))!;
    const menu: SiteFrame = { ...DEFAULT_FRAME, menu: [{ label: "Gift Cards", href: "/contact", children: [] }] };
    expectOk(await saveDraft(world.db, owner, FRAME_DOC, menu, { basedOn: frame.revision, now: NOW }));
    expectOk(await publishDraft(world.db, owner, DESIGN_DOC, NOW));
    expect(await publishedAccent()).toBe("#112233");
    expect(await loadPublished(world.db, FRAME_DOC)).toEqual(DEFAULT_FRAME);
    expect((await loadDraftOrPublished(world.db, FRAME_DOC)).menu).toEqual(menu.menu);
    expect(await listVersions(world.db, owner, FRAME_DOC)).toEqual([]);
  });
});

describe("the history", () => {
  beforeEach(async () => {
    expectOk(await draft("#111111"));
    expectOk(await publishDraft(world.db, owner, DESIGN_DOC, NOW));
    expectOk(await draft("#222222"));
    expectOk(await publishDraft(world.db, owner, DESIGN_DOC, minutesAfter(NOW, 5)));
  });

  it("brings an earlier version back as a draft, which changes nothing for visitors until it is published", async () => {
    const versions = (await listVersions(world.db, owner, DESIGN_DOC))!;
    const first = versions.find((version) => version.number === 1)!;
    expect(await restoreVersion(world.db, owner, DESIGN_DOC, first.id, minutesAfter(NOW, 9))).toEqual({ ok: true, number: 1, hasDraft: true });
    expect(await publishedAccent()).toBe("#222222");
    const state = (await loadForEditing(world.db, owner, DESIGN_DOC))!;
    expect(state).toMatchObject({ hasDraft: true, draftBy: owner.email });
    expect(state.content.colors.accent).toBe("#111111");

    // Published, it becomes a new version: nothing of the history is rewritten.
    expect(await publishDraft(world.db, owner, DESIGN_DOC, minutesAfter(NOW, 10))).toEqual({ ok: true, version: 3 });
    expect(await publishedAccent()).toBe("#111111");
    const after = (await listVersions(world.db, owner, DESIGN_DOC))!;
    expect(after.map((version) => [version.number, version.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
  });

  it("replaces a draft that was there, and leaves no draft when the version is what is published", async () => {
    expectOk(await draft("#999999"));
    const [second] = (await listVersions(world.db, owner, DESIGN_DOC))!;
    expect(await restoreVersion(world.db, owner, DESIGN_DOC, second.id, NOW)).toEqual({ ok: true, number: 2, hasDraft: false });
    expect((await loadForEditing(world.db, owner, DESIGN_DOC))!.hasDraft).toBe(false);
  });

  it("does not find a version of another document, or something that is not a version", async () => {
    const [second] = (await listVersions(world.db, owner, DESIGN_DOC))!;
    expect(await restoreVersion(world.db, owner, FRAME_DOC, second.id, NOW)).toMatchObject({ ok: false, message: "That version was not found." });
    expect(await restoreVersion(world.db, owner, DESIGN_DOC, "1; drop table site_versions", NOW)).toMatchObject({ ok: false });
    expect(await restoreVersion(world.db, owner, DESIGN_DOC, "00000000-0000-4000-8000-000000000000", NOW)).toMatchObject({ ok: false });
    expect(await publishedAccent()).toBe("#222222");
  });
});

describe("two people editing at once", () => {
  it("does not let one overwrite the other without knowing", async () => {
    await allow("managerEditsDesign");
    const opened = (await loadForEditing(world.db, owner, DESIGN_DOC))!.revision;
    // Mia saves first.
    expectOk(await saveDraft(world.db, mia, DESIGN_DOC, design("#aaaaaa"), { basedOn: opened, now: NOW }));
    // The owner, who opened the editor before that, is told and nothing is stored.
    const refused = await saveDraft(world.db, owner, DESIGN_DOC, design("#bbbbbb"), { basedOn: opened, now: minutesAfter(NOW, 1) });
    expect(refused).toMatchObject({ ok: false, reason: "conflict", by: mia.email, at: NOW.toISOString() });
    expect((await loadDraftOrPublished(world.db, DESIGN_DOC)).colors.accent).toBe("#aaaaaa");
    // They can decide to save theirs over it.
    expectOk(await saveDraft(world.db, owner, DESIGN_DOC, design("#bbbbbb"), { basedOn: opened, force: true, now: minutesAfter(NOW, 1) }));
    expect((await loadDraftOrPublished(world.db, DESIGN_DOC)).colors.accent).toBe("#bbbbbb");
  });

  it("notices a publish and a discard made in the meantime as well", async () => {
    const opened = expectOk(await draft("#aaaaaa")).revision;
    expectOk(await publishDraft(world.db, owner, DESIGN_DOC, NOW));
    expect(await saveDraft(world.db, owner, DESIGN_DOC, design("#bbbbbb"), { basedOn: opened, now: NOW })).toMatchObject({ ok: false, reason: "conflict" });
    const again = expectOk(await draft("#cccccc")).revision;
    expectOk(await discardDraft(world.db, owner, DESIGN_DOC));
    expect(await saveDraft(world.db, owner, DESIGN_DOC, design("#dddddd"), { basedOn: again, now: NOW })).toMatchObject({ ok: false, reason: "conflict" });
  });

  it("counts a save that changes nothing as no change", async () => {
    const first = expectOk(await draft("#aaaaaa"));
    const same = expectOk(await saveDraft(world.db, owner, DESIGN_DOC, design("#aaaaaa"), { basedOn: first.revision, now: minutesAfter(NOW, 3) }));
    expect(same.revision).toBe(first.revision);
    expect(same.savedAt).toBe(NOW.toISOString());
  });
});

describe("who may change the website", () => {
  it("is the owners, until they let a manager in; an attendant and a customer never", async () => {
    for (const viewer of [mia, sam, jane]) {
      expect(await websiteAbilities(world.db, viewer)).toEqual({ editDesign: false, editPages: false, publish: false });
      expect(await loadForEditing(world.db, viewer, DESIGN_DOC)).toBeNull();
      expect(await listVersions(world.db, viewer, DESIGN_DOC)).toBeNull();
      expect(await saveDraft(world.db, viewer, DESIGN_DOC, design("#123456"), { basedOn: 0, now: NOW })).toMatchObject({ ok: false, reason: "forbidden" });
      expect(await discardDraft(world.db, viewer, DESIGN_DOC)).toMatchObject({ ok: false });
      expect(await publishDraft(world.db, viewer, DESIGN_DOC, NOW)).toMatchObject({ ok: false });
      expect(await restoreVersion(world.db, viewer, DESIGN_DOC, "00000000-0000-4000-8000-000000000000", NOW)).toMatchObject({ ok: false });
    }
    expect(await world.db.select().from(siteDocuments)).toEqual([]);

    // Every switch on: still nothing for an attendant or a customer.
    await allow("managerEditsDesign");
    await allow("managerPublishesWebsite");
    for (const viewer of [sam, jane]) {
      expect(await websiteAbilities(world.db, viewer)).toEqual({ editDesign: false, editPages: false, publish: false });
      expect(await saveDraft(world.db, viewer, FRAME_DOC, DEFAULT_FRAME, { basedOn: 0, now: NOW })).toMatchObject({ ok: false, reason: "forbidden" });
    }
  });

  it("lets a manager prepare a draft with one switch, and publish only with the other", async () => {
    await allow("managerEditsDesign");
    expect((await loadForEditing(world.db, mia, DESIGN_DOC))!.may).toEqual({ publish: false });
    expectOk(await saveDraft(world.db, mia, DESIGN_DOC, design("#123456"), { basedOn: 0, now: NOW }));
    const refused = await publishDraft(world.db, mia, DESIGN_DOC, NOW);
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.message).toContain("An owner can");
    expect(await publishedAccent()).toBe(DEFAULT_DESIGN.colors.accent);

    await allow("managerPublishesWebsite");
    expect((await loadForEditing(world.db, mia, DESIGN_DOC))!.may).toEqual({ publish: true });
    expect(await publishDraft(world.db, mia, DESIGN_DOC, NOW)).toEqual({ ok: true, version: 1 });
    expect((await listVersions(world.db, mia, DESIGN_DOC))![0].publishedBy).toBe(mia.email);
  });

  it("does not let the publish switch alone open the editor", async () => {
    await allow("managerPublishesWebsite");
    expect(await loadForEditing(world.db, mia, DESIGN_DOC)).toBeNull();
    expectOk(await draft("#123456"));
    expect(await publishDraft(world.db, mia, DESIGN_DOC, NOW)).toMatchObject({ ok: false });
  });
});

describe("what is stored is never trusted", () => {
  it("reads a damaged row as a valid design", async () => {
    await world.db.insert(siteDocuments).values({
      kind: "design",
      published: { colors: { accent: "#010203", text: "red;}</style><script>alert(1)</script>" }, fonts: { heading: "no-such-font" }, more: [1, 2] },
      draft: "not even an object",
    });
    expect(await loadPublished(world.db, DESIGN_DOC)).toEqual({ ...DEFAULT_DESIGN, colors: { ...DEFAULT_DESIGN.colors, accent: "#010203" } });
    expect(await loadDraftOrPublished(world.db, DESIGN_DOC)).toEqual(DEFAULT_DESIGN);
  });

  it("keeps one row for each document, however often it is saved", async () => {
    for (const accent of ["#111111", "#222222", "#333333"]) expectOk(await draft(accent));
    expectOk(await publishDraft(world.db, owner, DESIGN_DOC, NOW));
    expectOk(await draft("#444444"));
    expect(await world.db.select().from(siteDocuments).where(eq(siteDocuments.kind, "design"))).toHaveLength(1);
  });
});

describe("the studio's name and address", () => {
  const moved: SiteFrame = {
    ...DEFAULT_FRAME,
    business: { ...DEFAULT_FRAME.business, name: "Studio Nine", addressLine1: "9 Main St", addressLine2: "Orlando, FL 32801", phone: "(321) 555-0199" },
  };
  const signOff = async () => (await world.emails("login_code")).at(-1)!.body;

  it("are printed in emails from the published contact details, never from a draft", async () => {
    expectOk(await requestLoginCode(world.db, "jane@example.com", NOW));
    expect(await signOff()).toContain("Your sign-in code for The Visuals Photo Studio is");
    expect(await signOff()).toContain("The Visuals Photo Studio\n7457 Aloma Ave, Suite 301, Winter Park, FL 32792");

    expectOk(await saveDraft(world.db, owner, FRAME_DOC, moved, { basedOn: 0, now: NOW }));
    expectOk(await requestLoginCode(world.db, "bob@example.com", NOW));
    expect(await signOff()).toContain("The Visuals Photo Studio\n7457 Aloma Ave");
    expect((await loadBusiness(world.db)).name).toBe("The Visuals Photo Studio");

    expectOk(await publishDraft(world.db, owner, FRAME_DOC, NOW));
    expectOk(await requestLoginCode(world.db, "carol@example.com", NOW));
    expect(await signOff()).toContain("Your sign-in code for Studio Nine is");
    expect(await signOff()).toContain("Studio Nine\n9 Main St, Orlando, FL 32801");
    expect(await signOff()).not.toContain("{{");
    expect(await loadBusiness(world.db)).toMatchObject({ name: "Studio Nine", phone: "(321) 555-0199" });
  });

  it("leave no mark in any email the site sends", async () => {
    expectOk(await world.book());
    for (const email of await world.emails()) {
      expect(`${email.subject}\n${email.body}`, email.kind).not.toMatch(/\{\{|\}\}/);
    }
    expect((await world.emails("booking_confirmation"))[0].body).toContain("Your booking at The Visuals Photo Studio is confirmed.");
  });
});
