import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emailOutbox } from "@/db/schema";
import { CONTACT_LIMITS } from "@/lib/contact";
import { sendContactMessage } from "./contact";
import { deliverPendingEmails, queueEmail, resendTransport, type EmailTransport } from "./email";
import { createTestWorld, NOW, OWNER_EMAIL, type TestWorld } from "./testing";

let world: TestWorld;
beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(() => world.reset());

const MESSAGE = {
  name: "Jane Smith",
  email: " Jane@Example.com ",
  topic: "photography",
  message: "Do you photograph newborns?\nThank you.",
};
const TO_OWNER = { ownerEmail: OWNER_EMAIL };
const queued = () => world.db.select().from(emailOutbox);

describe("a message from the contact page", () => {
  it("becomes one email to the owner, with the visitor's address for the reply", async () => {
    expect(await sendContactMessage(world.db, MESSAGE, TO_OWNER)).toEqual({ ok: true });

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toEmail: OWNER_EMAIL,
      replyTo: "jane@example.com",
      kind: "contact_message",
      subject: "Website message from Jane Smith: Photography session",
    });
    expect(rows[0].body).toContain("Jane Smith <jane@example.com> wrote through the contact page.");
    expect(rows[0].body).toContain("Do you photograph newborns?\nThank you.");
  });

  it("keeps the name on one line, so it cannot add lines to the subject", async () => {
    await sendContactMessage(world.db, { ...MESSAGE, name: "  Jane\r\nSmith \t Bcc: someone@example.com " }, TO_OWNER);
    const [row] = await queued();
    expect(row.subject).toBe("Website message from Jane Smith Bcc: someone@example.com: Photography session");
    expect(row.subject).not.toMatch(/[\r\n]/);
  });

  it("is refused, and nothing is queued, when a field is missing or wrong", async () => {
    const result = await sendContactMessage(
      world.db,
      { name: "  ", email: "jane@nowhere", topic: "something-else-entirely", message: " \n " },
      TO_OWNER,
    );
    expect(result).toEqual({
      ok: false,
      code: "invalid",
      fields: {
        name: "Please enter your name.",
        email: "Please enter a valid email address.",
        topic: "Please choose a topic.",
        message: "Please write a message of up to 4,000 characters.",
      },
    });
    expect(await queued()).toHaveLength(0);
  });

  it("is refused when a field was left out altogether or the message is too long", async () => {
    expect(await sendContactMessage(world.db, {}, TO_OWNER)).toMatchObject({ ok: false, code: "invalid" });
    const long = await sendContactMessage(
      world.db,
      { ...MESSAGE, message: "x".repeat(CONTACT_LIMITS.message + 1) },
      TO_OWNER,
    );
    expect(long).toEqual({
      ok: false,
      code: "invalid",
      fields: { message: "Please write a message of up to 4,000 characters." },
    });
    expect(await queued()).toHaveLength(0);
  });

  it("is dropped when the hidden field was filled in, and the sender is told it was sent", async () => {
    expect(await sendContactMessage(world.db, { ...MESSAGE, trap: "https://example.com" }, TO_OWNER)).toEqual({ ok: true });
    expect(await queued()).toHaveLength(0);
  });

  it("is refused when nobody is set up to receive messages", async () => {
    expect(await sendContactMessage(world.db, MESSAGE, { ownerEmail: null })).toEqual({ ok: false, code: "unavailable" });
    expect(await queued()).toHaveLength(0);
  });

  it("is refused when the sender has sent too many, and only real messages count", async () => {
    let asked = 0;
    const deps = {
      ...TO_OWNER,
      allowSend: () => {
        asked++;
        return asked <= 1;
      },
    };
    await sendContactMessage(world.db, { ...MESSAGE, email: "not an address" }, deps);
    await sendContactMessage(world.db, { ...MESSAGE, trap: "filled" }, deps);
    expect(asked).toBe(0);

    expect(await sendContactMessage(world.db, MESSAGE, deps)).toEqual({ ok: true });
    expect(await sendContactMessage(world.db, MESSAGE, deps)).toEqual({ ok: false, code: "too_many" });
    expect(await queued()).toHaveLength(1);
  });
});

describe("the reply address on delivery", () => {
  it("is handed to the mail service for a contact message and left out for other mail", async () => {
    const handed: { to: string; replyTo?: string; hasReplyTo: boolean }[] = [];
    const transport: EmailTransport = {
      name: "test",
      async send(message) {
        handed.push({ to: message.to, replyTo: message.replyTo, hasReplyTo: "replyTo" in message });
        return { ok: true };
      },
    };
    await sendContactMessage(world.db, MESSAGE, TO_OWNER);
    await queueEmail(world.db, { to: "customer@example.com", subject: "Hello", body: "Body", kind: "test" });

    expect(await deliverPendingEmails(world.db, transport, NOW)).toEqual({ sent: 2, failed: 0 });
    expect(handed).toContainEqual({ to: OWNER_EMAIL, replyTo: "jane@example.com", hasReplyTo: true });
    expect(handed).toContainEqual({ to: "customer@example.com", replyTo: undefined, hasReplyTo: false });
  });

  describe("in the request to Resend", () => {
    afterEach(() => vi.unstubAllGlobals());

    const sendThroughResend = async (replyTo?: string) => {
      const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
        async () => new Response("{}", { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const transport = resendTransport({ apiKey: "test-key", from: "Studio <studio@example.com>" });
      const result = await transport.send({ to: "owner@example.com", subject: "Subject", text: "Text", replyTo });
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.resend.com/emails");
      return JSON.parse(String(init?.body)) as Record<string, unknown>;
    };

    it("is sent as reply_to", async () => {
      expect(await sendThroughResend("jane@example.com")).toEqual({
        from: "Studio <studio@example.com>",
        to: ["owner@example.com"],
        subject: "Subject",
        text: "Text",
        reply_to: "jane@example.com",
      });
    });

    it("is absent when there is none", async () => {
      expect(await sendThroughResend()).toEqual({
        from: "Studio <studio@example.com>",
        to: ["owner@example.com"],
        subject: "Subject",
        text: "Text",
      });
    });
  });
});
