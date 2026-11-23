import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookingAcceptances, bookingAnswers, bookings } from "@/db/schema";
import {
  acceptedText,
  appliesTo,
  checkoutForms,
  currentPolicies,
  deleteQuestion,
  formsOfBooking,
  listAgreements,
  listQuestions,
  moveQuestion,
  publishAgreement,
  saveAgreement,
  saveQuestion,
  setAgreementActive,
  setQuestionActive,
  type QuestionInput,
} from "./booking-forms";
import { agreementKey, policiesKey } from "@/lib/booking-form-keys";
import { PDFDocument } from "@cantoo/pdf-lib";
import { DEFAULT_FRAME } from "@/lib/site/frame";
import { pageTextHtml } from "@/lib/site/page-text";
import { acceptedLines, acceptedPdf } from "./receipt-pdf";
import { toBookingViews } from "./bookings";
import { ensureBuiltInPages, loadPublishedPage } from "./pages";
import { createTestWorld, expectOk, NOW, type TestWorld } from "./testing";

const h = (hours: number) => hours * 60;

describe("Booking Forms & Agreements (the owner's brief of 2026-11-22, items 6 and 7)", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await createTestWorld();
  });
  afterAll(() => world.close());
  beforeEach(() => world.reset());

  const question = (overrides: Partial<QuestionInput>): QuestionInput => ({
    label: "Is anyone in your group under 18?",
    help: "",
    kind: "dropdown",
    options: ["No", "Yes"],
    required: true,
    studioIds: [],
    forRentals: true,
    forPhotography: true,
    startsOn: "",
    endsOn: "",
    ...overrides,
  });

  it("asks a question of the bookings it applies to: its studios, its type and its days", () => {
    const decor = { studioIds: ["dayglow"], forRentals: true, forPhotography: false, startsOn: "2026-12-01", endsOn: "2027-01-02" };
    expect(appliesTo(decor, { studioIds: ["dayglow"], photography: false, date: "2026-12-20" })).toBe(true);
    expect(appliesTo(decor, { studioIds: ["paris", "dayglow"], photography: false, date: "2026-12-20" })).toBe(true); // a bundle with Dayglow
    expect(appliesTo(decor, { studioIds: ["blanche"], photography: false, date: "2026-12-20" })).toBe(false);
    expect(appliesTo(decor, { studioIds: ["dayglow"], photography: true, date: "2026-12-20" })).toBe(false);
    expect(appliesTo(decor, { studioIds: ["dayglow"], photography: false, date: "2027-01-03" })).toBe(false);
    expect(appliesTo(decor, { studioIds: ["dayglow"], photography: false, date: "2026-11-30" })).toBe(false);
    expect(appliesTo({ studioIds: [], forRentals: true, forPhotography: true }, { studioIds: ["paris"], photography: true, date: "2026-12-20" })).toBe(true);
  });

  it("keeps a new question off until it is published, and orders, changes and deletes questions", async () => {
    const first = expectOk(await saveQuestion(world.db, null, question({})));
    const second = expectOk(await saveQuestion(world.db, null, question({ label: "Anything we should know?", kind: "text", options: [], required: false })));
    const context = { studioIds: [world.ids.paris], photography: false, date: "2026-11-18" };
    expect((await checkoutForms(world.db, context)).questions).toEqual([]);
    await setQuestionActive(world.db, first.id, true);
    await setQuestionActive(world.db, second.id, true);
    expect((await checkoutForms(world.db, context)).questions.map((q) => q.label)).toEqual(["Is anyone in your group under 18?", "Anything we should know?"]);
    expect(await moveQuestion(world.db, second.id, -1)).toBe(true);
    expect(await moveQuestion(world.db, second.id, -1)).toBe(false);
    expect((await listQuestions(world.db)).map((q) => q.label)).toEqual(["Anything we should know?", "Is anyone in your group under 18?"]);
    expect(await deleteQuestion(world.db, second.id)).toBe(true);
    expect((await listQuestions(world.db)).map((q) => q.id)).toEqual([first.id]);
  });

  it("refuses a question it cannot ask", async () => {
    const refusal = async (overrides: Partial<QuestionInput>) => {
      const result = await saveQuestion(world.db, null, question(overrides));
      return result.ok ? null : result.message;
    };
    expect(await refusal({ label: "?" })).toBe("Write the question in 2 to 200 characters.");
    expect(await refusal({ kind: "essay" })).toBe("Choose the kind of question.");
    expect(await refusal({ options: ["Only one", " Only one "] })).toBe("Give at least two answers to choose from, one on each line.");
    expect(await refusal({ startsOn: "2026-12-10", endsOn: "2026-12-01" })).toBe("The last day must be on or after the first.");
    expect(await refusal({ forRentals: false, forPhotography: false })).toBe("Choose rentals, photography sessions or both.");
    expect(await refusal({ studioIds: ["00000000-0000-4000-8000-000000000000"] })).toBe("Unknown studio.");
  });

  it("publishes an agreement's draft as numbered versions, keeps them, and shows clients the newest", async () => {
    const waiver = expectOk(await saveAgreement(world.db, null, { title: "Photography release", draft: "You allow us to share the photos.", studioIds: [], forRentals: false, forPhotography: true }));
    const rental = { studioIds: [world.ids.paris], photography: false, date: "2026-11-18" };
    const session = { ...rental, photography: true };
    expect((await checkoutForms(world.db, session)).agreements).toEqual([]); // nothing published yet
    expect(await publishAgreement(world.db, waiver.id, "owner@studio.test", NOW)).toEqual({ ok: true, number: 1 });
    expect(await publishAgreement(world.db, waiver.id, "owner@studio.test", NOW)).toEqual({ ok: false, message: "Nothing changed since the version published last." });
    expect((await checkoutForms(world.db, rental)).agreements).toEqual([]); // not for rentals
    expectOk(await saveAgreement(world.db, waiver.id, { title: "Photography release", draft: "You allow us to share the photos, with your name only if you agree.", studioIds: [], forRentals: false, forPhotography: true }));
    // The draft is not what clients read until it is published.
    expect((await checkoutForms(world.db, session)).agreements.map((a) => [a.number, a.body])).toEqual([[1, "You allow us to share the photos."]]);
    expect(await publishAgreement(world.db, waiver.id, "owner@studio.test", NOW)).toEqual({ ok: true, number: 2 });
    const [view] = await listAgreements(world.db);
    expect(view.versions.map((version) => version.number)).toEqual([2, 1]);
    await setAgreementActive(world.db, waiver.id, false);
    expect((await checkoutForms(world.db, session)).agreements).toEqual([]);
  });

  it("books only with the policies as published accepted, and keeps what was accepted and answered", async () => {
    await ensureBuiltInPages(world.db, NOW);
    const policies = (await currentPolicies(world.db))!;
    expect(policies.number).toBe(1);
    // The Christmas decor acknowledgment, for Dayglow in December, required.
    const decor = expectOk(
      await saveQuestion(world.db, null, question({ label: "I understand the Christmas decor stays in place.", kind: "checkbox", options: [], studioIds: [world.ids.dayglow], startsOn: "2026-12-01", endsOn: "2027-01-02" })),
    );
    await setQuestionActive(world.db, decor.id, true);
    const groups = expectOk(await saveQuestion(world.db, null, question({ label: "How many people are coming?", options: ["1–5", "6–10"], required: true })));
    await setQuestionActive(world.db, groups.id, true);

    const dayglowInDecember = { studioIds: [world.ids.dayglow], date: "2026-12-21", startMinute: h(10), durationMinutes: 60 };
    // Without the policies accepted, nothing is booked.
    expect(await world.book({ ...dayglowInDecember, answers: { [groups.id]: "1–5", [decor.id]: true } })).toMatchObject({ ok: false, code: "policies_changed", status: 409 });
    const accepted = [policiesKey(policies.versionId)];
    expect(await world.book({ ...dayglowInDecember, accepted, answers: { [groups.id]: "1–5" } })).toMatchObject({
      ok: false,
      code: "invalid_input",
      message: "Please answer: I understand the Christmas decor stays in place.",
    });
    expect(await world.book({ ...dayglowInDecember, accepted, answers: { [groups.id]: "20", [decor.id]: true } })).toMatchObject({
      ok: false,
      message: "Please choose one of the answers offered: How many people are coming?",
    });
    const booked = expectOk(await world.book({ ...dayglowInDecember, accepted, answers: { [groups.id]: "1–5", [decor.id]: true } }));
    const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));
    const forms = await formsOfBooking(world.db, row.id);
    expect(forms.answers).toEqual([
      { label: "I understand the Christmas decor stays in place.", answer: "Yes" },
      { label: "How many people are coming?", answer: "1–5" },
    ]);
    expect(forms.acceptances).toEqual([
      { id: expect.any(String), kind: "policies_page", title: "Studio Policies", versionNumber: 1, acceptedAt: NOW.toISOString(), siteVersionId: policies.versionId, agreementVersionId: null },
    ]);

    // Changed or deleted later, the question's words stay as the client answered them.
    expectOk(await saveQuestion(world.db, groups.id, question({ label: "How many guests?", options: ["1–5", "6–10"] })));
    await deleteQuestion(world.db, decor.id);
    expect((await formsOfBooking(world.db, row.id)).answers.map((answer) => answer.label)).toEqual(["I understand the Christmas decor stays in place.", "How many people are coming?"]);

    // Blanche in December is not asked about the decor; an agreement published meanwhile sends the client back to read it.
    const terms = expectOk(await saveAgreement(world.db, null, { title: "Equipment terms", draft: "Handle the lights with care.", studioIds: [], forRentals: true, forPhotography: true }));
    await publishAgreement(world.db, terms.id, "owner@studio.test", NOW);
    const blanche = { studioIds: [world.ids.blanche], date: "2026-12-21", startMinute: h(14), durationMinutes: 60, answers: { [groups.id]: "6–10" } };
    expect(await world.book({ ...blanche, accepted })).toMatchObject({ ok: false, code: "policies_changed" });
    const [shown] = (await checkoutForms(world.db, { studioIds: [world.ids.blanche], photography: false, date: "2026-12-21" })).agreements;
    const second = expectOk(await world.book({ ...blanche, accepted: [...accepted, agreementKey(shown.versionId)] }));
    const [other] = await world.db.select().from(bookings).where(eq(bookings.ref, second.ref));
    expect((await world.db.select().from(bookingAcceptances).where(eq(bookingAcceptances.bookingId, other.id))).map((a) => [a.kind, a.title, a.versionNumber])).toEqual([
      ["policies_page", "Studio Policies", 1],
      ["agreement", "Equipment terms", 1],
    ]);
    expect((await world.db.select().from(bookingAnswers).where(eq(bookingAnswers.bookingId, other.id))).map((a) => a.answer)).toEqual(["6–10"]);
  });

  it("keeps the Policies page's words as the client read them, and gives each acceptance back to read again", async () => {
    await ensureBuiltInPages(world.db, NOW);
    const policies = (await currentPolicies(world.db))!;
    const terms = expectOk(await saveAgreement(world.db, null, { title: "Equipment terms", draft: "Handle the lights with care.\n\nTell us of any damage.", studioIds: [], forRentals: true, forPhotography: true }));
    await publishAgreement(world.db, terms.id, "owner@studio.test", NOW);
    const [shown] = (await checkoutForms(world.db, { studioIds: [world.ids.blanche], photography: false, date: "2026-11-18" })).agreements;
    const booked = expectOk(await world.book({ accepted: [policiesKey(policies.versionId), agreementKey(shown.versionId)] }));
    const [row] = await world.db.select().from(bookings).where(eq(bookings.ref, booked.ref));

    // The client's pages list what was accepted.
    const [view] = await toBookingViews(world.db, [row], NOW);
    expect(view.accepted.map((item) => [item.title, item.versionNumber, item.acceptedAt])).toEqual([
      ["Studio Policies", 1, NOW.toISOString()],
      ["Equipment terms", 1, NOW.toISOString()],
    ]);
    const [policiesItem, termsItem] = view.accepted;

    // The policies' words are the page's as the policies step showed them then, kept with the booking.
    const page = (await loadPublishedPage(world.db, policies.slug, NOW))!;
    const words = (await acceptedText(world.db, row.id, policiesItem.id, NOW))!;
    expect(words.html).toBe(pageTextHtml(page.content.blocks, page.site));
    expect(words.html!.length).toBeGreaterThan(100);
    expect(words.note).toBeNull();
    // An agreement's, in its paragraphs.
    expect(await acceptedText(world.db, row.id, termsItem.id, NOW)).toMatchObject({ title: "Equipment terms", paragraphs: ["Handle the lights with care.", "Tell us of any damage."], html: null, note: null });
    // An acceptance from before the words were kept is shown from the page's history, and says so.
    await world.db.update(bookingAcceptances).set({ shownHtml: null }).where(eq(bookingAcceptances.id, policiesItem.id));
    const older = (await acceptedText(world.db, row.id, policiesItem.id, NOW))!;
    expect(older.html).toBe(words.html);
    expect(older.note).toMatch(/^This version was accepted before the site kept its very words/);
    // Nobody reads one booking's acceptance through another booking.
    const other = expectOk(await world.book({ startMinute: h(15), accepted: [policiesKey(policies.versionId), agreementKey(shown.versionId)], customer: { name: "Bob Brown", email: "bob@example.com", phone: "407-555-0101" } }));
    const [otherRow] = await world.db.select().from(bookings).where(eq(bookings.ref, other.ref));
    expect(await acceptedText(world.db, otherRow.id, policiesItem.id, NOW)).toBeNull();
    expect(await acceptedText(world.db, row.id, "not-an-id", NOW)).toBeNull();

    // As a PDF file, to download (the admin brief's item 8): the words, who accepted them, for which booking.
    const file = await acceptedPdf(words, { ref: booked.ref, customerName: "Jane Smith" }, DEFAULT_FRAME.business);
    expect(Buffer.from(file.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect((await PDFDocument.load(file)).getTitle()).toBe(`Studio Policies, version 1, ${booked.ref}`);
    const lines = acceptedLines(words.html!);
    expect(lines[0]).toEqual({ kind: "heading", text: "Cancellations & Rescheduling" });
    expect(lines.some((line) => line.kind === "item" && line.text === "Children must be supervised by an adult at all times.")).toBe(true);
  });

  it("reads the site's HTML of the policies as lines for a PDF, every word kept", () => {
    expect(
      acceptedLines('<h3>Fees &amp; Refunds</h3><p>A <strong>$20</strong> fee,<br>then none.</p><ul><li><p>One</p></li><li>Two &#8211; &rsquo;three&rsquo;</li></ul><div>Loose words</div>'),
    ).toEqual([
      { kind: "heading", text: "Fees & Refunds" },
      { kind: "paragraph", text: "A $20 fee," },
      { kind: "paragraph", text: "then none." },
      { kind: "item", text: "One" },
      { kind: "item", text: "Two – ’three’" },
      { kind: "paragraph", text: "Loose words" },
    ]);
  });

  it("asks nothing of a booking the studio makes for a client", async () => {
    await ensureBuiltInPages(world.db, NOW);
    expectOk(await world.book({ paymentToken: undefined }, { madeBy: "owner@studio.test" }));
  });
});
