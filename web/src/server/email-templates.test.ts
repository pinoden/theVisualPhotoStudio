import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { emailOutbox, emailTemplates } from "@/db/schema";
import { EMAIL_TEMPLATES, TEMPLATE_KEYS } from "@/lib/email-templates";
import { DEFAULT_FRAME } from "@/lib/site/frame";
import * as emails from "./email";
import { getEmailTemplate, listEmailTemplates, ownersWording, saveEmailTemplate, TEMPLATE_CHANGED } from "./email-templates";
import { BASE_URL, createTestWorld, expectOk, FAR, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

/** Question 33, the owner's answer of 2026-11-17: the owners change the wording of the emails the site sends. */
let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const OWNER = { email: OWNER_EMAIL, role: "owner" };
const SITE = EMAIL_TEMPLATES.booking_confirmation;
const STUDIO = DEFAULT_FRAME.business.name;

describe("the owners' wording of an email", () => {
  it("is sent from the moment it is saved, with the parts filled in, until the site's wording is brought back", async () => {
    expectOk(await world.book({ date: FAR }));
    expect((await world.emails("booking_confirmation"))[0].body).toContain(`Your booking at ${STUDIO} is confirmed.`);

    const body = [
      "Hello {{first_name}}!",
      "",
      "{{when}} in {{studios}}.",
      "{{photography}}",
      "{{payment}}",
      "",
      "Your booking: {{booking_link}}",
      "",
      "{{getting_in}}",
      "",
      "See you soon,",
      "{{studio_name}}, {{studio_address}}",
    ].join("\n");
    expect(await saveEmailTemplate(world.db, OWNER, "booking_confirmation", { subject: "{{first_name}}, you're booked: {{reference}}", body }, 0, NOW)).toMatchObject({
      ok: true,
      revision: 1,
      wording: "owners",
    });

    const second = expectOk(await world.book({ date: FAR, studioIds: [world.ids.paris] }));
    const mail = (await world.emails("booking_confirmation"))[1];
    expect(mail.subject).toBe(`Jane, you're booked: ${second.ref}`);
    expect(mail.body).toMatch(/^Hello Jane!\n\n\w{3}, Dec 9, 2026, 10:00 AM in Studio Paris\.\nTotal: \$[\d,.]+\n\nYour booking: /);
    expect(mail.body).toContain(`Your booking: ${BASE_URL}/booking/${second.ref}?t=`);
    // No photography and no getting-in text for this booking: their lines are left out, and no empty lines pile up.
    expect(mail.body.endsWith(`?t=${encodeURIComponent(second.manageToken)}\n\nSee you soon,\n${STUDIO}, ${DEFAULT_FRAME.business.addressLine1}, ${DEFAULT_FRAME.business.addressLine2}`)).toBe(true);

    expect(await saveEmailTemplate(world.db, OWNER, "booking_confirmation", null, 1, NOW)).toEqual({ ok: true, revision: 2, wording: "site", subject: SITE.subject, body: SITE.body });
    expectOk(await world.book({ date: FAR, studioIds: [world.ids.dayglow] }));
    const third = (await world.emails("booking_confirmation"))[2];
    expect(third.subject).toMatch(/^Booking confirmed: VS-/);
    expect(third.body).toContain(`Your booking at ${STUDIO} is confirmed.`);
  });

  it("is kept as the site's when it is the site's word for word, and is not saved when the site could not send it", async () => {
    const asTyped = { subject: `  ${SITE.subject} `, body: `\r\n${SITE.body.replaceAll("\n", "\r\n")}\r\n\r\n` };
    expect(await saveEmailTemplate(world.db, OWNER, "booking_confirmation", asTyped, 0, NOW)).toMatchObject({ ok: true, wording: "site" });
    expect(await getEmailTemplate(world.db, "booking_confirmation")).toMatchObject({ wording: "site", revision: 1, updatedBy: OWNER_EMAIL, subject: SITE.subject });

    expect(await saveEmailTemplate(world.db, OWNER, "booking_confirmation", { subject: "Hi {{nmae}}", body: "{{payment}}" }, 1, NOW)).toEqual({
      ok: false,
      code: "invalid",
      message: "Not saved. {{nmae}} is not one of this email's parts. The parts it has are listed beside the text. {{booking_link}} must stay in this email.",
    });
    expect(await getEmailTemplate(world.db, "booking_confirmation")).toMatchObject({ wording: "site", revision: 1 });
  });

  it("is changed by an owner only, and never over a save someone else made after the editor was opened", async () => {
    const wording = { subject: "Thanks, {{first_name}}", body: "Tell us how it went." };
    expect(await saveEmailTemplate(world.db, { email: "m@studio.test", role: "manager" }, "review_request", wording, 0, NOW)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await saveEmailTemplate(world.db, OWNER, "no_such_email", wording, 0, NOW)).toMatchObject({ ok: false, code: "not_found" });

    expect(await saveEmailTemplate(world.db, OWNER, "review_request", wording, 0, NOW)).toMatchObject({ ok: true, revision: 1 });
    const other = { email: "owner2@studio.test", role: "owner" };
    expect(await saveEmailTemplate(world.db, other, "review_request", { ...wording, body: "Mine." }, 0, NOW)).toEqual({ ok: false, code: "changed", message: TEMPLATE_CHANGED });
    expect(await saveEmailTemplate(world.db, other, "review_request", { ...wording, body: "Mine." }, 1, NOW)).toMatchObject({ ok: true, revision: 2 });
    expect(await saveEmailTemplate(world.db, OWNER, "review_request", null, 1, NOW)).toMatchObject({ ok: false, code: "changed" });
    expect(await ownersWording(world.db, "review_request")).toEqual({ subject: "Thanks, {{first_name}}", body: "Mine." });
    expect(await getEmailTemplate(world.db, "review_request")).toMatchObject({ wording: "owners", revision: 2, updatedBy: "owner2@studio.test" });
  });

  it("is not used once the site could not send it, and the admin says why", async () => {
    // As if a part had been taken away from the email after the owners used it.
    await world.db.insert(emailTemplates).values({ key: "review_request", subject: "Hi {{name}}", body: "{{gone}} Thanks", revision: 1, updatedBy: OWNER_EMAIL, updatedAt: NOW });
    expect(await ownersWording(world.db, "review_request")).toBeNull();
    expect(await getEmailTemplate(world.db, "review_request")).toMatchObject({
      wording: "unusable",
      subject: "Hi {{name}}",
      body: "{{gone}} Thanks",
      problems: ["{{gone}} is not one of this email's parts. The parts it has are listed beside the text."],
    });
    await emails.queueEmail(world.db, emails.reviewRequestEmail({ email: "jane@example.com", name: "Jane Smith", ref: "VS-1" }));
    expect((await world.emails("review_request"))[0].subject).toBe(`How was your visit to ${STUDIO}?`);
  });

  it("is the wording of a waiting message put right too", async () => {
    const wording = { subject: "Cancelled: {{reference}}", body: "Dear {{name}},\n\n{{outcome}}\n\n{{pet_credit}}\n\nThe team" };
    expectOk(await saveEmailTemplate(world.db, OWNER, "booking_cancelled", wording, 0, NOW));
    const notice = { to: "jane@example.com", name: "Jane Smith", ref: "VS-1", when: "W", lines: [], refund: { cents: 1000, feeCents: 0, state: "sent" as const } };
    const id = await emails.queueEmail(world.db, emails.cancellationEmail(notice));
    expect(await emails.replaceQueuedEmail(world.db, id, emails.cancellationEmail({ ...notice, refund: { ...notice.refund, state: "not_yet" } }))).toBe(true);
    expect(await world.emails("booking_cancelled")).toMatchObject([
      {
        subject: "Cancelled: VS-1",
        body: "Dear Jane Smith,\n\nA refund of $10 is due to your card, and has not reached it yet: the studio has been told, and will see that it does.\n\nThe team",
      },
    ]);
  });

  it("is listed with every other email to clients, each in the site's wording to begin with", async () => {
    expectOk(await saveEmailTemplate(world.db, OWNER, "login_code", { subject: "Code: {{code}}", body: "Your code is {{code}}." }, 0, NOW));
    const list = await listEmailTemplates(world.db);
    expect(list.map((item) => item.spec.key)).toEqual([...TEMPLATE_KEYS]);
    expect(list.filter((item) => item.wording !== "site").map((item) => item.spec.key)).toEqual(["login_code"]);
  });
});

describe("a notice to the studio (question 40, answered 2026-11-18: every email can be changed)", () => {
  it("is sent in the owners' wording once they change it, still answering the visitor, and keeps what it cannot do without", async () => {
    const notice = () => emails.contactMessageEmail({ to: OWNER_EMAIL, name: "Ann Lee", email: "ann@example.com", topic: "After-hours booking", message: "Friday at 9 p.m.?\n\nThanks" });
    await emails.queueEmail(world.db, notice());
    expect((await world.emails("contact_message"))[0].subject).toBe("Website message from Ann Lee: After-hours booking");

    // A notice cannot leave out what it is for, or name a money amount it does not have.
    expect(await saveEmailTemplate(world.db, OWNER, "contact_message", { subject: "From {{name}}", body: "Someone wrote." }, 0, NOW)).toMatchObject({
      ok: false,
      code: "invalid",
      message: "Not saved. {{message}} must stay in this email.",
    });
    expect(await saveEmailTemplate(world.db, OWNER, "owner_reservation_lapsed", { subject: "{{reference}} lapsed", body: "{{amount}} lapsed for {{customer}}." }, 0, NOW)).toMatchObject({
      ok: false,
      message: "Not saved. {{due}} must stay in this email.",
    });

    const body = "{{first_name}} ({{email}}) asks about: {{topic}}\n\n{{message}}\n\nAnswer by replying.";
    expectOk(await saveEmailTemplate(world.db, OWNER, "contact_message", { subject: "[{{topic}}] {{name}}", body }, 0, NOW));
    await emails.queueEmail(world.db, notice());
    const mail = (await world.emails("contact_message"))[1];
    expect(mail.subject).toBe("[After-hours booking] Ann Lee");
    expect(mail.body).toBe("Ann (ann@example.com) asks about: After-hours booking\n\nFriday at 9 p.m.?\n\nThanks\n\nAnswer by replying.");
    const replies = await world.db.select({ replyTo: emailOutbox.replyTo }).from(emailOutbox).where(eq(emailOutbox.kind, "contact_message"));
    expect(replies.map((row) => row.replyTo)).toEqual(["ann@example.com", "ann@example.com"]);
    expect((await listEmailTemplates(world.db)).find((item) => item.spec.key === "contact_message")).toMatchObject({ wording: "owners", spec: { group: "Notices to the studio" } });
  });
});

describe("every email to a client", () => {
  it("is written from its template, with every part its template lists", () => {
    const visit = { to: "a@x.test", name: "Jane Smith", ref: "VS-1", studios: "Paris", when: "W", duration: "1 hour" };
    const written: emails.QueuedEmail[] = [
      emails.bookingConfirmationEmail({ ...visit, totalCents: 100, creditCents: 0, cardCents: 100, manageUrl: "U" }),
      emails.bookingReminderEmail({ ...visit, dueCents: 0, atStudio: false }),
      emails.reviewRequestEmail({ email: "a@x.test", name: "Jane", ref: "VS-1" }),
      emails.bookingMovedEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", studios: "Paris", was: "A", now: "B", duration: "1 hour" }),
      emails.moveRequestReceivedEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", when: "W", message: "M" }),
      emails.rescheduleCodeEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", code: "C", valueCents: 100, expires: "E", bookUrl: "U" }),
      emails.cancellationEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", when: "W", lines: [] }),
      emails.cancellationEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", when: "W", lines: [], byStudio: true }),
      emails.refundNotYetEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", cents: 100, feeCents: 0 }),
      emails.payLinkEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", when: "W", amountCents: 100, payUrl: "U" }),
      emails.paymentReceivedEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", when: "W", amountCents: 100, method: "Cash", dueCents: 0 }),
      emails.reservationLapsedEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", when: "W", dueCents: 100 }),
      emails.codeRefundEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", code: "C", cents: 100, leftCents: 0, usable: true, byHand: false }),
      emails.latePaymentEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", amountCents: 100, released: false, state: "sent" }),
      emails.latePaymentEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", amountCents: 100, released: false, state: "not_yet" }),
      emails.petCreditEmail({ to: "a@x.test", name: "Jane", ref: "VS-1", code: "C", cents: 100, expires: "E", bookUrl: "U" }),
      emails.freeHourEmail({ to: "a@x.test", name: "Jane", code: "C", visits: 10, expires: "E", bookUrl: "U" }),
      emails.loginCodeEmail("a@x.test", "123456", 10),
      emails.emailChangeCodeEmail({ to: "b@x.test", name: "Jane", code: "123456", minutes: 10 }),
      emails.emailChangedEmail({ to: "a@x.test", name: "Jane", newEmail: "b@x.test" }),
      emails.membershipStartedEmail({ to: "a@x.test", name: "Jane", planName: "P", minutes: 300, priceCents: 100, code: "C", nextBilling: "2026-12-14", bookUrl: "U", accountUrl: "A" }),
      emails.membershipCancelledEmail({ to: "a@x.test", name: "Jane", planName: "P", code: "C", endsOn: null, minutesLeft: 0, bookUrl: "U" }),
      emails.membershipMonthPaidEmail({ to: "a@x.test", name: "Jane", planName: "P", minutes: 300, priceCents: 100, code: "C", minutesLeft: 300, nextBilling: "2027-01-14", accountUrl: "A" }),
      emails.membershipProblemEmail({ to: "a@x.test", name: "Jane", planName: "P", problem: "It did not go through.", code: "C", minutesLeft: 0 }),
      // The notices to the studio (question 40, answered 2026-11-18: every email can be changed).
      emails.moveRequestStudioEmail({ to: "o@x.test", client: { name: "Jane", email: "j@x.test", phone: "" }, ref: "VS-1", studios: "Paris", when: "W", duration: "1 hour", message: "M", appointmentUrl: "U" }),
      emails.contactMessageEmail({ to: "o@x.test", name: "N", email: "n@x.test", topic: "T", message: "M" }),
      emails.ownerHandRefundNotice({ to: "o@x.test", ref: "VS-1", customer: "Jane", paidCents: 100, feePercent: 5 }),
      emails.ownerRefundNotice({ to: "o@x.test", ref: "VS-1", customer: "Jane", amountCents: 100, automatic: true }),
      emails.ownerRefundNotice({ to: "o@x.test", ref: "VS-1", customer: "Jane", amountCents: 100, automatic: true, failedReason: "R" }),
      emails.ownerRefundWaitingNotice({ to: "o@x.test", ref: "VS-1", customer: "Jane", amountCents: 100, reason: "R" }),
      emails.ownerCaptureNotice({ to: "o@x.test", ref: "VS-1", customer: "Jane", amountCents: 100, reason: "R", givenBackAt: new Date("2026-12-20T15:00:00Z") }),
      emails.ownerReservationLapsedNotice({ to: "o@x.test", ref: "VS-1", customer: "Jane", amountCents: 100, dueCents: 100 }),
      emails.ownerUnseenLinkNotice({ to: "o@x.test", ref: "VS-1", customer: "Jane", linkCents: 100, asked: "cancel", kind: "unseen" }),
      emails.loyaltyProgressEmail({ to: "j@x.test", name: "Jane", stamps: 3, visits: 5, bookUrl: "https://site.test/book" }),
      emails.ownerMembershipRefundNotice({ to: "o@x.test", code: "C", customer: "Jane", amountCents: 100, reason: "R" }),
      emails.ownerMembershipProblemNotice({ to: "o@x.test", code: "C", customer: "Jane", planName: "P", problem: "It did not go through." }),
      emails.ownerMembershipUnfinishedNotice({ to: "o@x.test", code: "C", customer: "Jane", planName: "P", amountCents: 100 }),
    ];
    expect(written.map((message) => message.template?.key).sort()).toEqual([...TEMPLATE_KEYS].sort());
    for (const message of written) {
      const spec = EMAIL_TEMPLATES[message.template!.key];
      expect(Object.keys(message.template!.parts).sort(), spec.key).toEqual(spec.parts.map((part) => part.key).sort());
    }
  });
});
