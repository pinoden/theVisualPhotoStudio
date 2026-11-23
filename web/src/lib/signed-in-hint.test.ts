import { describe, expect, it } from "vitest";
import { hintsSignedIn, SIGNED_IN_HINT } from "./signed-in-hint";

describe("the cookie that tells the menu a visitor is signed in", () => {
  it("is read among the page's other cookies, and only with its own value", () => {
    expect(hintsSignedIn(`${SIGNED_IN_HINT}=1`)).toBe(true);
    expect(hintsSignedIn(`theme=dark; ${SIGNED_IN_HINT}=1; other=2`)).toBe(true);
    expect(hintsSignedIn("")).toBe(false);
    expect(hintsSignedIn(`${SIGNED_IN_HINT}=0`)).toBe(false);
    expect(hintsSignedIn(`x${SIGNED_IN_HINT}=1`)).toBe(false);
  });
});
