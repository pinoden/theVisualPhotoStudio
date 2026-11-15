import { addons, priceRules, studioHours, studios } from "./schema";
import type { Db } from "./client";

/**
 * Starting catalog, taken from the studio's live price list (read 2026-11-14
 * from its public scheduling page). Weekend prices start equal to weekday
 * prices until the owner sets them. Everything here is editable data, not code.
 */
const h = (hours: number) => Math.round(hours * 60);

const STUDIOS = [
  {
    slug: "blanche",
    name: "Studio Blanche",
    tagline: "A modern, all-white space with sleek design.",
    description:
      "A bright, modern canvas for creative work. Featuring a 10×15 ft seamless white cyclorama wall, a wall-mounted paper backdrop system, large southeast-facing windows and a minimalist aesthetic designed for portraits, branding sessions and editorial work. Shoes come off or get covered here to keep the space white.",
    includedGuests: 6,
    // hours -> dollars
    prices: { 1: 88, 1.5: 132, 2: 176, 3: 264, 4: 320, 5: 385, 8: 605, 10: 720 },
  },
  {
    slug: "dayglow",
    name: "Studio Dayglow",
    tagline: "A natural, boho-style studio with warm vibes.",
    description:
      "A warm, natural-light studio with a boho feel. The paper backdrop on a floor stand can be switched out during your session. Dayglow is our only pet-friendly studio.",
    includedGuests: 6,
    prices: { 1: 78, 1.5: 117, 2: 156, 3: 234, 4: 285, 5: 350, 8: 540 },
  },
  {
    slug: "paris",
    name: "Studio Paris",
    tagline: "A romantic space with vintage charm.",
    description:
      "A romantic, elegant space for timeless visuals. Classic details, a white vintage couch, a fireplace mantel, gold mirrors and soft natural light from large southeast-facing windows. Styled with seasonal setups through the year.",
    includedGuests: 4,
    prices: { 1: 68, 1.5: 102, 2: 136, 3: 195, 4: 245, 5: 300 },
  },
] as const;

/** Inserts the starting catalog if the database has no studios yet. */
export async function seed(db: Db): Promise<boolean> {
  const existing = await db.select({ id: studios.id }).from(studios).limit(1);
  if (existing.length > 0) return false;

  await db.transaction(async (tx) => {
    const ids: Record<string, string> = {};
    for (const [index, s] of STUDIOS.entries()) {
      const [row] = await tx
        .insert(studios)
        .values({
          slug: s.slug,
          name: s.name,
          tagline: s.tagline,
          description: s.description,
          includedGuests: s.includedGuests,
          bufferMinutes: 15,
          sortOrder: index,
        })
        .returning({ id: studios.id });
      ids[s.slug] = row.id;

      // Mon-Fri 9:00-19:00, Sat-Sun 8:00-20:00
      await tx.insert(studioHours).values(
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          studioId: row.id,
          weekday,
          openMinute: weekday <= 5 ? h(9) : h(8),
          closeMinute: weekday <= 5 ? h(19) : h(20),
        })),
      );

      await tx.insert(priceRules).values(
        (["weekday", "weekend"] as const).flatMap((dayType) =>
          Object.entries(s.prices).map(([hours, dollars]) => ({
            studioId: row.id,
            dayType,
            durationMinutes: h(Number(hours)),
            priceCents: dollars * 100,
          })),
        ),
      );
    }

    await tx.insert(addons).values([
      {
        slug: "extra-people-1-2",
        name: "1 to 2 extra people",
        description: "For groups larger than the number of guests included with the studio.",
        priceCents: 3000,
        studioId: null,
        kind: "people",
        sortOrder: 0,
      },
      {
        slug: "extra-people-3-5",
        name: "3 to 5 extra people",
        description: "For groups larger than the number of guests included with the studio.",
        priceCents: 5000,
        studioId: null,
        kind: "people",
        sortOrder: 1,
      },
      {
        slug: "pet-fee",
        name: "Pet fee",
        description: "Required when bringing a pet. Pets are welcome in Studio Dayglow only.",
        priceCents: 4000,
        studioId: ids.dayglow,
        kind: "pet",
        sortOrder: 2,
      },
    ]);
  });
  return true;
}
