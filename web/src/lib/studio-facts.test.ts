import { describe, expect, it } from "vitest";
import { hasFacts, includedList, NO_FACTS, parseStudioFacts, sectionList, sectionParts, STUDIO_FACT_LIMITS } from "./studio-facts";

/** A studio's facts as they are stored: what photographers choose a studio by. */
describe("a studio's facts", () => {
  it("come out complete from whatever was stored", () => {
    for (const nothing of [null, undefined, "x", 7, [], {}]) expect(parseStudioFacts(nothing)).toEqual(NO_FACTS);
    expect(hasFacts(NO_FACTS)).toBe(false);
  });

  it("are lines of text, tidied and cut to their limits", () => {
    const facts = parseStudioFacts({ size: "  850   sq ft ", ceiling: "14 ft\u0000", light: "x".repeat(500), cyclorama: 12 });
    expect(facts).toMatchObject({ size: "850 sq ft", ceiling: "14 ft", cyclorama: "" });
    expect(facts.light).toHaveLength(STUDIO_FACT_LIMITS.line);
    expect(hasFacts(facts)).toBe(true);
  });

  it("list what comes with the studio, one thing a line, without empty lines", () => {
    expect(includedList("Paper backdrops\r\n\n  C-stands  \nSteamer\n")).toEqual(["Paper backdrops", "C-stands", "Steamer"]);
    expect(includedList(["A", "", 7, "B"])).toEqual(["A", "B"]);
    expect(includedList(Array.from({ length: 30 }, (_, index) => `Thing ${index}`))).toHaveLength(STUDIO_FACT_LIMITS.included);
  });

  it("keep sections under titles, as the original website's studio pages had them (brief of 2026-11-24)", () => {
    expect(sectionList([{ title: "Pets", text: "Not allowed.\u0000" }, { title: "  ", text: "No title" }, "x", { title: "Window layout" }])).toEqual([
      { title: "Pets", text: "Not allowed." },
      { title: "Window layout", text: "" },
    ]);
    expect(sectionList(Array.from({ length: 20 }, (_, index) => ({ title: `Section ${index}`, text: "" })))).toHaveLength(STUDIO_FACT_LIMITS.sections);
    expect(sectionList([{ title: "x".repeat(100), text: "y".repeat(3000) }])[0]).toMatchObject({ title: "x".repeat(STUDIO_FACT_LIMITS.sectionTitle), text: "y".repeat(STUDIO_FACT_LIMITS.sectionText) });
    expect(hasFacts({ ...NO_FACTS, sections: [{ title: "Pets", text: "" }] })).toBe(true);
  });

  it("show a section's lines starting \"- \" or \"• \" as a list, and the others as paragraphs", () => {
    expect(sectionParts("The studio includes:\n- Steamer\n• Rack\n-\n\nThere is a changing area.")).toEqual([
      { kind: "paragraph", text: "The studio includes:" },
      { kind: "list", items: ["Steamer", "Rack"] },
      { kind: "paragraph", text: "There is a changing area." },
    ]);
  });

  it("name a floor plan only by a picture's id", () => {
    const id = "0b2c4d6e-8f10-4a2b-9c3d-4e5f6a7b8c9d";
    expect(parseStudioFacts({ floorPlan: id.toUpperCase() }).floorPlan).toBe(id);
    for (const bad of ["/media/x.png", "javascript:alert(1)", 7]) expect(parseStudioFacts({ floorPlan: bad }).floorPlan).toBe("");
  });
});
