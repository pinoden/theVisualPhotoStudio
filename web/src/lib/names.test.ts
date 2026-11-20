import { describe, expect, it } from "vitest";
import { splitName } from "./names";

describe("a name split for the card processor", () => {
  it("is the first word, then the rest", () => {
    expect(splitName("Jane Smith")).toEqual({ given: "Jane", family: "Smith" });
    expect(splitName("  Ana  Maria   Lopez ")).toEqual({ given: "Ana", family: "Maria Lopez" });
  });

  it("keeps one word as the given name, and an empty name empty", () => {
    expect(splitName("Cher")).toEqual({ given: "Cher", family: "" });
    expect(splitName("   ")).toEqual({ given: "", family: "" });
  });
});
