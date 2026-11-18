import { describe, expect, it } from "vitest";
import { CONDITIONS, markerOf, shownWords, WHEN_OPTIONS, whenHolds, whenWords } from "./conditions";

/** What a page shows only at times: the guarantee the pages written in code gave, kept now that their text is the owners'. */
describe("conditions", () => {
  it("offer each one, and its opposite, as a block's Show it, after Always", () => {
    const keys = Object.keys(WHEN_OPTIONS);
    expect(keys[0]).toBe("");
    expect(WHEN_OPTIONS[""]).toBe("Always");
    expect(keys).toHaveLength(1 + 2 * Object.keys(CONDITIONS).length);
    expect(WHEN_OPTIONS.pets).toBe("Only while pets can come (a pet fee is offered)");
    expect(WHEN_OPTIONS["not moving"]).toBe("Only while a booking cannot be moved");
    expect(whenWords("not moving")).toBe("Only while a booking cannot be moved");
    expect(whenWords("")).toBe("");
    expect(whenWords("unicorns")).toBe("");
  });

  it("show a thing always, only while its condition holds, or only while it does not", () => {
    const holds = { pets: true, moving: false };
    expect(whenHolds("", holds)).toBe(true);
    expect(whenHolds("pets", holds)).toBe(true);
    expect(whenHolds("not pets", holds)).toBe(false);
    expect(whenHolds("moving", holds)).toBe(false);
    expect(whenHolds("not moving", holds)).toBe(true);
  });

  it("show it when what holds is not known, or the condition is not one", () => {
    expect(whenHolds("pets", undefined)).toBe(true);
    expect(whenHolds("not pets", undefined)).toBe(true);
    expect(whenHolds("photography", { pets: true })).toBe(true);
    expect(whenHolds("unicorns", { pets: false })).toBe(true);
    expect(whenHolds(7, { pets: false })).toBe(true);
  });

  it("are read from the start of some words, and the marker never shows", () => {
    expect(markerOf("{if pets}Can I bring my pet?")).toEqual({ whens: ["pets"], rest: "Can I bring my pet?" });
    expect(markerOf("  {if not moving}  Not refunded.")).toEqual({ whens: ["not moving"], rest: "Not refunded." });
    expect(markerOf("{if several studios offer}You get it.")).toEqual({ whens: ["several studios offer"], rest: "You get it." });
    expect(markerOf("{if add-ons}Extras")).toEqual({ whens: ["add-ons"], rest: "Extras" });
    expect(shownWords("{if pets}Can I bring my pet?", { pets: true })).toBe("Can I bring my pet?");
    expect(shownWords("{if pets}Can I bring my pet?", { pets: false })).toBeNull();
    expect(shownWords("{if not pets}Pets are not permitted.", { pets: false })).toBe("Pets are not permitted.");
    expect(shownWords("Is there parking?", { pets: false })).toBe("Is there parking?");
  });

  it("can stand several in a row, and then must all hold", () => {
    const text = "{if pets} {if pet free studios} Pets in some studios only.";
    expect(markerOf(text)).toEqual({ whens: ["pets", "pet free studios"], rest: "Pets in some studios only." });
    expect(shownWords(text, { pets: true, "pet free studios": true })).toBe("Pets in some studios only.");
    expect(shownWords(text, { pets: true, "pet free studios": false })).toBeNull();
    expect(shownWords(text, { pets: false, "pet free studios": true })).toBeNull();
    // One of them that is no condition makes none of them a marker.
    expect(markerOf("{if pets}{if unicorns}Hello")).toBeNull();
  });

  it("leave a marker that is not one as it was typed, so the mistake can be seen", () => {
    for (const text of ["{if unicorns}Hello", "Hello {if pets}", "{If pets}Hello", "{if  pets}Hello", "{ifpets}Hello", "{if pets Hello"]) {
      expect(markerOf(text), text).toBeNull();
      expect(shownWords(text, { pets: false }), text).toBe(text);
    }
  });
});
