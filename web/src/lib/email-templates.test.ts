import { describe, expect, it } from "vitest";
import {
  BODY_MAX,
  EMAIL_TEMPLATES,
  firstNameOf,
  renderEmail,
  sampleParts,
  STUDIO_PARTS,
  SUBJECT_MAX,
  TEMPLATE_KEYS,
  templateProblems,
  tidyTemplate,
} from "./email-templates";

const confirmation = EMAIL_TEMPLATES.booking_confirmation;
const render = (body: string, parts: Record<string, string>, subject = "S") => renderEmail({ subject, body }, parts);

describe("filling a template in", () => {
  it("puts each part in its place, once, in any case and with spaces inside the braces", () => {
    expect(render("Hi {{name}}, {{ NAME }} and {{Name}}.", { name: "Jane" }).body).toBe("Hi Jane, Jane and Jane.");
    // What a part holds is not read for parts: a client's message that looks like one stays as written.
    expect(render("{{message}}", { message: "Use {{code}} or {{name}}", code: "X", name: "Y" }).body).toBe("Use {{code}} or {{name}}");
    // A part the email does not have comes out empty, also one named like something every object has.
    expect(render("A{{nothing}}B{{constructor}}C", {}).body).toBe("ABC");
  });

  it("leaves out a line that holds nothing but parts, all of them empty, and keeps one with words besides", () => {
    const body = "Studio: {{studios}}\n{{photography}}\n{{payment}}\nGetting in: {{getting_in}}";
    expect(render(body, { studios: "Paris", photography: "", payment: "Total: $72", getting_in: "" }).body).toBe("Studio: Paris\nTotal: $72\nGetting in: ");
    expect(render("{{a}} {{b}}\nnext", { a: "", b: "" }).body).toBe("next");
    expect(render("{{a}} {{b}}\nnext", { a: "", b: "x" }).body).toBe(" x\nnext");
  });

  it("never leaves two empty lines in a row, nor any at the start or the end, while a part keeps its own", () => {
    const body = "\n\nOne\n\n{{gone}}\n\nTwo\n   \n\n{{block}}\n\n";
    expect(render(body, { gone: "", block: "a\n\n\nb" }).body).toBe("One\n\nTwo\n\na\n\n\nb");
    expect(render("One\r\nTwo  \r\n", {}).body).toBe("One\nTwo");
  });

  it("keeps the studio's name and address marked for when the email is queued, unless it is given them", () => {
    expect(render("{{studio_name}}\n{{studio_address}}", {}).body).toBe("{{studio_name}}\n{{studio_address}}");
    expect(render("{{studio_name}}\n{{studio_address}}", { studio_name: "The Studio", studio_address: "1 Main St" }).body).toBe("The Studio\n1 Main St");
  });

  it("writes the subject on one line", () => {
    expect(renderEmail({ subject: "  Booking {{reference}}  ", body: "x" }, { reference: "VS-1" }).subject).toBe("Booking VS-1");
    expect(renderEmail({ subject: "{{x}}", body: "x" }, { x: "two\nlines" }).subject).toBe("two lines");
  });

  it("takes a client's first name from their name", () => {
    expect(firstNameOf("  Jane   Smith ")).toBe("Jane");
    expect(firstNameOf("Cher")).toBe("Cher");
  });
});

describe("what stops a template from being used", () => {
  const check = (subject: string, body: string) => templateProblems(confirmation, { subject, body });
  const fine = "{{payment}} {{booking_link}}";

  it("accepts the site's own wording of every email", () => {
    for (const key of TEMPLATE_KEYS) expect(templateProblems(EMAIL_TEMPLATES[key], EMAIL_TEMPLATES[key])).toEqual([]);
  });

  it("needs a subject on one line and a text, within their lengths", () => {
    expect(check(" ", fine)).toEqual(["The subject is empty."]);
    expect(check("One\nTwo", fine)).toEqual(["The subject must be on one line."]);
    expect(check("x".repeat(SUBJECT_MAX + 1), fine)).toEqual([`The subject is longer than ${SUBJECT_MAX} characters.`]);
    expect(check("S", "  \n ")).toContain("The email has no text.");
    expect(check("S", fine + "x".repeat(BODY_MAX))).toEqual(["The text is longer than 10,000 characters."]);
  });

  it("names a part the email does not have, and braces that are not a part", () => {
    expect(check("S {{nmae}}", fine)).toEqual(["{{nmae}} is not one of this email's parts. The parts it has are listed beside the text."]);
    expect(check("S", `${fine} {{code}}`)).toEqual(["{{code}} is not one of this email's parts. The parts it has are listed beside the text."]);
    for (const stray of ["{{name}", "{{ first name }}", "{name}}", "{{}}"]) {
      expect(check("S", `${fine} ${stray}`)).toEqual([
        "A part is written with two braces on each side and only letters, numbers and _ between them, for example {{name}}.",
      ]);
    }
    expect(check("S {{Studio_Name}}", `${fine} {{STUDIOS}}`)).toEqual([]);
  });

  it("keeps a part of several lines out of the subject, and a part the email needs in it", () => {
    expect(check("{{payment}}", "{{booking_link}}")).toEqual(["{{payment}} can be several lines long, so it can go in the text but not in the subject."]);
    expect(check("S", "Hi {{name}}")).toEqual(["{{payment}} must stay in this email.", "{{booking_link}} must stay in this email."]);
    // In the subject is in the email.
    expect(templateProblems(EMAIL_TEMPLATES.login_code, { subject: "Code {{code}}", body: "Hello" })).toEqual([]);
  });

  it("keeps every part that states money (question 40; the tester's finding of 2026-11-18)", () => {
    const money = [
      ["booking_reminder", "to_pay"],
      // reschedule_code states its value in {{credit}}, which it keeps already.
      ["reschedule_code", "credit"],
      ["payment_link", "amount"],
      ["payment_link", "charges"],
      ["payment_received", "amount"],
      ["payment_received", "balance"],
      ["reservation_lapsed", "due"],
      // The late payment's emails state it in {{refund}}, which they keep already.
      ["late_payment_refunded", "refund"],
      ["late_payment_due", "refund"],
      ["pet_credit", "amount"],
      ["membership_started", "price"],
      ["membership_month_paid", "price"],
    ] as const;
    for (const [key, part] of money) {
      const spec = EMAIL_TEMPLATES[key];
      const without = { subject: spec.subject, body: spec.body.split("\n").filter((line) => !line.includes(`{{${part}}}`)).join("\n") };
      expect(templateProblems(spec, without), `${key} without {{${part}}}`).toContain(`{{${part}}} must stay in this email.`);
    }
  });
});

describe("the templates", () => {
  it("each name their parts once, with a sample, and the parts only some emails have say when", () => {
    for (const key of TEMPLATE_KEYS) {
      const spec = EMAIL_TEMPLATES[key];
      expect(spec.key).toBe(key);
      const keys = spec.parts.map((part) => part.key);
      expect(new Set(keys).size, key).toBe(keys.length);
      for (const part of spec.parts) {
        expect(part.key, key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(part.sample, `${key}.${part.key}`).not.toBe("");
        expect(STUDIO_PARTS.some((studio) => studio.key === part.key)).toBe(false);
      }
      // A part named in the subject is never one of several lines, and every part the email needs is in its own wording.
      expect(templateProblems(spec, spec)).toEqual([]);
    }
  });

  it("keep their text as written: one kind of line break, no empty lines around it", () => {
    expect(tidyTemplate({ subject: "  Hi  ", body: "\r\n \r\nOne\r\n\r\nTwo\r\n  \r\n" })).toEqual({ subject: "Hi", body: "One\n\nTwo" });
  });

  it("are previewed with their samples, links on the site's address, and without the parts only some emails have when asked", () => {
    const options = { baseUrl: "https://studio.test/", studioName: "The Studio", studioAddress: "1 Main St, Winter Park" };
    const full = sampleParts(confirmation, { ...options, plain: false });
    expect(full).toMatchObject({ booking_link: "https://studio.test/booking/VS-7K2M9Q?t=…", studio_name: "The Studio", payment: "Total: $176" });
    expect(full.photography).toContain("Photography session");
    const plain = sampleParts(confirmation, { ...options, plain: true });
    expect(plain).toMatchObject({ photography: "", getting_in: "", payment: "Total: $176" });
    const preview = renderEmail(confirmation, plain);
    expect(preview.subject).toBe("Booking confirmed: VS-7K2M9Q");
    expect(preview.body).toContain("When: Sat, Dec 12, 2026, 10:00 AM (2 hours)\nTotal: $176\n\nView, cancel or move your booking: https://studio.test/booking/VS-7K2M9Q?t=…\n\nYour booking begins");
    expect(preview.body.endsWith("The Studio\n1 Main St, Winter Park")).toBe(true);
    expect(sampleParts(EMAIL_TEMPLATES.booking_cancelled, { ...options, plain: false }).pet_credit).toContain("Book at https://studio.test/book and");
  });
});
