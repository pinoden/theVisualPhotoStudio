import { describe, expect, it } from "vitest";
import { hasVisibleText } from "./visible-text";

describe("visible text", () => {
  it("is anything a reader can see, in any script", () => {
    for (const text of ["A", "7", "é", "✦", "ß", "日本", "😀", "👨\u200D👩\u200D👧", "  a  "]) expect(hasVisibleText(text), text).toBe(true);
  });

  it("is not spaces, nor characters that take no room or show nothing", () => {
    // Zero-width space and joiners, word joiner, soft hyphen, marks of direction, the combining grapheme joiner,
    // the Mongolian vowel separator, the Hangul filler, invisible times, a byte-order mark, a blank braille cell.
    const nothing = ["", " \t\n", "\u3000", "\u200B", "\u200C\u200D", "\u2060", "\u00AD", "\u200E\u200F", "\u034F", "\u180E", "\u3164", "\u2062", "\uFEFF", "\u2800"];
    for (const text of nothing) expect(hasVisibleText(text), JSON.stringify(text)).toBe(false);
  });
});
