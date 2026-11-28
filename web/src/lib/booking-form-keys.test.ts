import { describe, expect, it } from "vitest";
import { initialsKey, initialsOf } from "./booking-form-keys";

describe("a client's initials, from their full name (the owner, 2026-11-27)", () => {
  it("takes the first letter of each word, in capitals", () => {
    expect(initialsOf("Jane Smith")).toBe("JS");
    expect(initialsOf("  jane   smith ")).toBe("JS");
    expect(initialsOf("Madonna")).toBe("M");
    expect(initialsOf("Mary Jane Watson")).toBe("MJW");
    // A hyphen or an apostrophe joins: one word, one letter.
    expect(initialsOf("Mary-Jane O'Neil")).toBe("MO");
    expect(initialsOf("Élodie de la Çroix")).toBe("ÉDLÇ");
    expect(initialsOf("Олена Шевченко")).toBe("ОШ");
  });

  it("keeps at most four letters: of a longer name the first three and the last", () => {
    expect(initialsOf("Ana María de la Cruz García")).toBe("AMDG");
  });

  it("skips what stands before a word's first letter, and leaves no name without initials", () => {
    expect(initialsOf("(Dr.) \"Jay\" Smith")).toBe("DJS");
    expect(initialsOf("J. 2nd")).toBe("J2");
    expect(initialsOf("!! ??")).toBe("!?");
    expect(initialsOf("   ")).toBe("");
  });
});

describe("the key of a statement initialed", () => {
  it("is the same for the same words, and another for other words or another statement", () => {
    const key = initialsKey("11111111-1111-4111-8111-111111111111", "I understand that I am renting studio space only.");
    expect(key).toMatch(/^initials:11111111-1111-4111-8111-111111111111:[0-9a-f]{8}$/);
    expect(initialsKey("11111111-1111-4111-8111-111111111111", "I understand that I am renting studio space only.")).toBe(key);
    expect(initialsKey("11111111-1111-4111-8111-111111111111", "I understand that I am renting studio space only!")).not.toBe(key);
    expect(initialsKey("22222222-2222-4222-8222-222222222222", "I understand that I am renting studio space only.")).not.toBe(key);
    // Short enough for the booking's list of what was accepted (100 characters each).
    expect(key.length).toBeLessThan(100);
  });
});
