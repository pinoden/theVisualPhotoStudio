import { describe, expect, it } from "vitest";
import { emailField, lineField, textField } from "./input-fields";

describe("what a client types", () => {
  it("keeps a name and a phone number on one line", () => {
    const name = lineField(2, 120);
    // A line break would begin a paragraph of the typist's own in the emails that greet the client by name.
    expect(name.parse("Anna\r\n\r\nYour booking is cancelled. Call 555-0100.")).toBe("Anna Your booking is cancelled. Call 555-0100.");
    expect(name.parse("  José\tHernández \n")).toBe("José Hernández");
    expect(name.parse("Liam O'Connor")).toBe("Liam O'Connor");
    expect(name.parse("A\u0000B")).toBe("AB");
    // The limits count what is left.
    expect(name.safeParse(" \n A \n ").success).toBe(false);
    expect(name.safeParse("N".repeat(121)).success).toBe(false);
    expect(lineField(7, 40).parse("407-555-0100\n407-555-0101")).toBe("407-555-0100 407-555-0101");
  });

  it("keeps the lines of notes, with each line break counted once", () => {
    const notes = textField(0, 2000);
    expect(notes.parse(" two outfits\r\nand a dog ")).toBe("two outfits\nand a dog");
    expect(notes.safeParse("n".repeat(2001)).success).toBe(false);
  });

  it("takes one email address, in small letters, and nothing after it", () => {
    expect(emailField.parse("  Maya@Example.COM ")).toBe("maya@example.com");
    for (const bad of ["maya@example.com\r\nBcc: other@example.com", "maya@example.com, other@example.com", "Maya <maya@example.com>", "maya@example", "maya example@example.com"]) {
      expect(emailField.safeParse(bad).success, bad).toBe(false);
    }
  });
});
