import type { Catalog } from "@/server/catalog";
import type { Business } from "./frame";

/**
 * What the home page tells search engines about the studio as a business, in
 * schema.org's words (JSON-LD): its name, address, phone, opening hours and a
 * picture. This is what a map or a local search result can show beside the
 * link. Everything comes from the admin: the header and footer's contact
 * details, and the studios' opening hours.
 */

const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** "Winter Park, FL 32792" as its parts; null when the line is not written that way. */
function cityStateZip(line: string): { addressLocality: string; addressRegion: string; postalCode: string } | null {
  const match = /^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(line.trim());
  return match ? { addressLocality: match[1], addressRegion: match[2], postalCode: match[3] } : null;
}

/**
 * The hours the studio is open on each day: from the earliest opening to the
 * latest closing of any of its studios, with the days that have the same
 * hours together.
 */
function openingHours(catalog: Pick<Catalog, "studios">): { "@type": "OpeningHoursSpecification"; dayOfWeek: string[]; opens: string; closes: string }[] {
  const byHours = new Map<string, string[]>();
  for (let weekday = 1; weekday <= 7; weekday++) {
    const open = catalog.studios.map((studio) => studio.hours[weekday]).filter((hours) => hours !== undefined);
    if (open.length === 0) continue;
    const key = `${clock(Math.min(...open.map((hours) => hours.openMinute)))}-${clock(Math.max(...open.map((hours) => hours.closeMinute)))}`;
    byHours.set(key, [...(byHours.get(key) ?? []), DAYS[weekday]]);
  }
  return [...byHours.entries()].map(([key, days]) => {
    const [opens, closes] = key.split("-");
    return { "@type": "OpeningHoursSpecification", dayOfWeek: days, opens, closes };
  });
}

export function localBusiness(input: {
  business: Business;
  catalog: Pick<Catalog, "studios">;
  /** The website's own address, "https://...", when it is known. */
  url: string | null;
  /** The address of a picture of the studio, when there is one. */
  image: string | null;
}): Record<string, unknown> {
  const { business } = input;
  const place = cityStateZip(business.addressLine2);
  return {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: business.name,
    ...(input.url ? { url: input.url } : {}),
    ...(input.image ? { image: input.image } : {}),
    telephone: business.phone,
    address: {
      "@type": "PostalAddress",
      streetAddress: business.addressLine1,
      ...(place ?? { addressLocality: business.addressLine2 }),
      addressCountry: "US",
    },
    hasMap: business.mapsUrl,
    openingHoursSpecification: openingHours(input.catalog),
  };
}

/** JSON-LD to put in a page as it is: `<` is written as an escape, so no text of the owners' can end the script it sits in. */
export function jsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
