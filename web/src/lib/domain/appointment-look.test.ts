import { describe, expect, it } from "vitest";
import { appointmentLook, calendarColumns, deeper, hoursText, lanesOf, shortStudioName } from "./appointment-look";

const blanche = { id: "b", slug: "blanche", name: "Studio Blanche", color: "#3b8f55" };
const dayglow = { id: "d", slug: "dayglow", name: "Studio Dayglow", color: "#2f6fc2" };
const paris = { id: "p", slug: "paris", name: "Studio Paris", color: "#7a4fc2" };

describe("how an appointment looks in the admin (the owner's admin brief of 2026-11-22)", () => {
  it("is in its studio's colour, or in its bundle's, with the owner's names for the bundles", () => {
    expect(appointmentLook([dayglow], false)).toEqual({ name: "Dayglow", color: "#2f6fc2", bundle: false });
    expect(appointmentLook([paris, dayglow], false)).toEqual({ name: "Paris + Dayglow", color: "#c63f76", bundle: true });
    expect(appointmentLook([blanche, paris], false).name).toBe("Paris + Blanche");
    expect(appointmentLook([dayglow, blanche, paris], false).name).toBe("Paris + Dayglow + Blanche");
    // The three bundles and the three studios have six colours.
    const colours = [[blanche], [dayglow], [paris], [paris, dayglow], [paris, blanche], [paris, dayglow, blanche]].map((held) => appointmentLook(held, false).color);
    expect(new Set(colours).size).toBe(6);
  });

  it("is a deeper shade of the same colour for a photography session", () => {
    expect(appointmentLook([blanche], true)).toEqual({ name: "Blanche", color: deeper("#3b8f55"), bundle: false });
    expect(deeper("#3b8f55")).toBe("#265d37");
    expect(deeper("#ffffff", 0.5)).toBe("#808080");
    expect(deeper("not a colour")).toBe("not a colour");
  });

  it("names a combination it does not know by its studios, in its studio's colour", () => {
    const fourth = { id: "s", slug: "sunroom", name: "Studio Sunroom", color: "#999999" };
    expect(appointmentLook([fourth, paris], false)).toEqual({ name: "Sunroom + Paris", color: "#999999", bundle: true });
    expect(shortStudioName("Studio Paris")).toBe("Paris");
    expect(shortStudioName("The Loft")).toBe("The Loft");
  });

  it("puts Paris in the middle column, so that every bundle is side by side", () => {
    const columns = calendarColumns([blanche, dayglow, paris]);
    expect(columns.map((studio) => studio.slug)).toEqual(["blanche", "paris", "dayglow"]);
    expect(lanesOf(["p", "d"], columns)).toEqual([{ lane: 1, span: 2 }]);
    expect(lanesOf(["b", "p"], columns)).toEqual([{ lane: 0, span: 2 }]);
    expect(lanesOf(["b", "d", "p"], columns)).toEqual([{ lane: 0, span: 3 }]);
    expect(lanesOf(["d"], columns)).toEqual([{ lane: 2, span: 1 }]);
    // Apart, when the columns do not allow better.
    expect(lanesOf(["b", "d"], columns)).toEqual([{ lane: 0, span: 1 }, { lane: 2, span: 1 }]);
    // One or two studios keep the owners' order.
    expect(calendarColumns([dayglow, paris]).map((studio) => studio.slug)).toEqual(["dayglow", "paris"]);
  });

  it("gives a length as the owner wrote it", () => {
    expect(hoursText(60)).toBe("1 hour");
    expect(hoursText(90)).toBe("1.5 hours");
    expect(hoursText(120)).toBe("2 hours");
    expect(hoursText(75)).toBe("1.25 hours");
    expect(hoursText(45)).toBe("45 minutes");
  });
});
