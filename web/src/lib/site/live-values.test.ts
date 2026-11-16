import { describe, expect, it } from "vitest";
import { fillLiveValues } from "./live-values";

/** Live values in a page's text: the requirement 22 proposal, "live value" tokens, so a page cannot disagree with the settings. */
describe("live values in text", () => {
  const values = { "refund window": "14 days", "studio name": "Tom & Jerry's <Studio>" };

  it("are put in place of their names", () => {
    expect(fillLiveValues("Cancel {refund window} ahead.", values)).toBe("Cancel 14 days ahead.");
    expect(fillLiveValues("{refund window}, {refund window}", values)).toBe("14 days, 14 days");
  });

  it("are escaped in formatted text, and only there", () => {
    expect(fillLiveValues("<p>{studio name}</p>", values, true)).toBe("<p>Tom &amp; Jerry's &lt;Studio&gt;</p>");
    expect(fillLiveValues("{studio name}", values)).toBe("Tom & Jerry's <Studio>");
  });

  it("leave a name that is not one of theirs as it was typed", () => {
    for (const text of ["{nothing here}", "{Refund window}", "{ refund window }", "{x}", "{refund_window}", "{}", "{refund window"]) {
      expect(fillLiveValues(text, values), text).toBe(text);
    }
  });
});
