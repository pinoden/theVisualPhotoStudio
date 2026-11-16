import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME, parseFrame } from "./frame";
import { jsonLd, localBusiness } from "./structured-data";

/** What the home page tells search engines about the studio as a business. */
describe("the studio as a business, for search engines", () => {
  const weekdays = { openMinute: 9 * 60, closeMinute: 19 * 60 };
  const weekend = { openMinute: 8 * 60, closeMinute: 20 * 60 };
  const studio = (hours: Record<number, { openMinute: number; closeMinute: number }>) => ({ hours }) as never;
  const sameHours = { 1: weekdays, 2: weekdays, 3: weekdays, 4: weekdays, 5: weekdays, 6: weekend, 7: weekend };

  it("names the studio, its address, phone and map, from the header and footer's details", () => {
    const data = localBusiness({ business: DEFAULT_FRAME.business, catalog: { studios: [studio(sameHours)] }, url: "https://studio.example", image: "https://studio.example/media/x/1/a.jpg" });
    expect(data).toMatchObject({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "The Visuals Photo Studio",
      url: "https://studio.example",
      image: "https://studio.example/media/x/1/a.jpg",
      telephone: "(407) 663-6109",
      address: { "@type": "PostalAddress", streetAddress: "7457 Aloma Ave, Suite 301", addressLocality: "Winter Park", addressRegion: "FL", postalCode: "32792", addressCountry: "US" },
      hasMap: DEFAULT_FRAME.business.mapsUrl,
    });
  });

  it("gives the hours of each day, the days with the same hours together", () => {
    const data = localBusiness({ business: DEFAULT_FRAME.business, catalog: { studios: [studio(sameHours)] }, url: null, image: null });
    expect(data.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "09:00", closes: "19:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Saturday", "Sunday"], opens: "08:00", closes: "20:00" },
    ]);
    // Without the site's address or a picture, it names neither.
    expect(data).not.toHaveProperty("url");
    expect(data).not.toHaveProperty("image");
  });

  it("counts the studio open from the earliest opening to the latest closing of any of its studios, and leaves out a day all are closed", () => {
    const early = studio({ 1: { openMinute: 7 * 60 + 30, closeMinute: 12 * 60 } });
    const late = studio({ 1: { openMinute: 10 * 60, closeMinute: 21 * 60 }, 3: weekdays });
    const data = localBusiness({ business: DEFAULT_FRAME.business, catalog: { studios: [early, late] }, url: null, image: null });
    expect(data.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday"], opens: "07:30", closes: "21:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Wednesday"], opens: "09:00", closes: "19:00" },
    ]);
  });

  it("keeps an address written another way as it is", () => {
    const data = localBusiness({ business: { ...DEFAULT_FRAME.business, addressLine2: "London SW1A 1AA" }, catalog: { studios: [] }, url: null, image: null });
    expect(data.address).toMatchObject({ addressLocality: "London SW1A 1AA" });
  });

  it("cannot be ended early by anything the owners typed", () => {
    const text = jsonLd(localBusiness({ business: { ...DEFAULT_FRAME.business, name: "Studio</script><script>alert(1)</script>" }, catalog: { studios: [] }, url: null, image: null }));
    expect(text).not.toContain("</script>");
    expect(JSON.parse(text).name).toBe("Studio</script><script>alert(1)</script>");
  });
});

describe("the picture shown when the website is shared", () => {
  it("is a picture of the library by its id, or none", () => {
    expect(DEFAULT_FRAME.search.image).toBe("");
    const id = "0b2c4d6e-8f10-4a2b-9c3d-4e5f6a7b8c9d";
    expect(parseFrame({ search: { image: id.toUpperCase() } }).search.image).toBe(id);
    for (const bad of ["javascript:alert(1)", "/media/x.jpg", 7, null]) expect(parseFrame({ search: { image: bad } }).search.image).toBe("");
  });
});
