import { describe, expect, it } from "vitest";
import { safeNextPath } from "./session";

describe("where the site goes after sign-in (security review, 2026-11-19)", () => {
  it("follows a path of this site", () => {
    for (const path of ["/account", "/admin/calendar?view=day&date=2026-12-10", "/booking/VS-ABC123?t=abc_DEF-123", "/studios#paris"]) expect(safeNextPath(path)).toBe(path);
  });

  it("never another site, however the address is disguised", () => {
    for (const path of ["https://evil.example", "//evil.example", "/\t/evil.example", "/%09/evil.example".replace("%09", "\t"), "/\n/evil.example", "/\r\n/evil.example", "/\\evil.example", "/ /evil.example", "/\u0000/evil.example", "evil", "", "/" + "a".repeat(400)]) {
      expect(safeNextPath(path)).toBe("/account");
    }
    expect(safeNextPath(undefined)).toBe("/account");
  });
});
