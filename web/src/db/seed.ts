import { eq } from "drizzle-orm";
import { addons, membershipPlans, membershipPlanStudios, photoPackages, photographerHours, photographers, priceRules, studioHours, studios } from "./schema";
import type { Db } from "./client";

/**
 * Starting catalog, taken from the studio's live price list (read 2026-11-14
 * from its public scheduling page), with the owner's approved weekend prices.
 * Owners can change the prices in Admin.
 */
const h = (hours: number) => Math.round(hours * 60);

/**
 * The memberships (follow-up 3): the owners' table of 2026-11-17, 5 or 10 hours a month in one studio or a bundle.
 * The single studios' words are the live site's (its scheduling page, read 2026-11-18). Migration
 * `0042_membership_plans` gives a database that already has the studios the same plans.
 */
export const STARTING_PLANS: readonly { studios: readonly ("blanche" | "dayglow" | "paris")[]; name: string; hours: number; dollars: number; description: string }[] = [
  { studios: ["dayglow"], name: "Studio Dayglow, 5 hours a month", hours: 5, dollars: 330, description: "Get creative in Studio Dayglow, the perfect space for vibrant, high-energy shoots." },
  {
    studios: ["dayglow"],
    name: "Studio Dayglow, 10 hours a month",
    hours: 10,
    dollars: 600,
    description: "Enjoy flexible, affordable access to Studio Dayglow, where every session feels vibrant, modern, and full of energy.",
  },
  {
    studios: ["paris"],
    name: "Studio Paris, 5 hours a month",
    hours: 5,
    dollars: 300,
    description: "Capture timeless, light-filled moments in Studio Paris, your go-to space for soft, elegant, and modern photography.",
  },
  {
    studios: ["paris"],
    name: "Studio Paris, 10 hours a month",
    hours: 10,
    dollars: 550,
    description: "Enjoy the charm and versatility of Studio Paris, a beautifully curated space designed for elegant portraits and creative storytelling.",
  },
  {
    studios: ["blanche"],
    name: "Studio Blanche, 5 hours a month",
    hours: 5,
    dollars: 380,
    description: "Create freely in Studio Blanche, a bright, modern space perfect for content, portraits, and inspiration.",
  },
  {
    studios: ["blanche"],
    name: "Studio Blanche, 10 hours a month",
    hours: 10,
    dollars: 700,
    description: "Enjoy consistent, flexible access to Studio Blanche, the perfect space to create whenever inspiration strikes.",
  },
  { studios: ["paris", "dayglow"], name: "Paris and Dayglow, 5 hours a month", hours: 5, dollars: 520, description: "Use your hours in Studio Paris, in Studio Dayglow, or in both booked together." },
  { studios: ["paris", "dayglow"], name: "Paris and Dayglow, 10 hours a month", hours: 10, dollars: 950, description: "Use your hours in Studio Paris, in Studio Dayglow, or in both booked together." },
  { studios: ["paris", "blanche"], name: "Paris and Blanche, 5 hours a month", hours: 5, dollars: 660, description: "Use your hours in Studio Paris, in Studio Blanche, or in both booked together." },
  { studios: ["paris", "blanche"], name: "Paris and Blanche, 10 hours a month", hours: 10, dollars: 1200, description: "Use your hours in Studio Paris, in Studio Blanche, or in both booked together." },
  { studios: ["paris", "dayglow", "blanche"], name: "All three studios, 5 hours a month", hours: 5, dollars: 780, description: "Use your hours in any of the three studios, or in several booked together." },
  { studios: ["paris", "dayglow", "blanche"], name: "All three studios, 10 hours a month", hours: 10, dollars: 1450, description: "Use your hours in any of the three studios, or in several booked together." },
];

/** What a photography session includes, by its length in hours. The same in every studio. */
const SESSION_INCLUDES: Record<number, string> = {
  1: "1–2 outfits, 20 edited images",
  2: "2–3 outfits, 30 edited images",
  3: "3–4 outfits, 40 edited images",
  4: "4–5 outfits, 50 edited images",
};

const STUDIOS = [
  {
    slug: "blanche",
    color: "#3b8f55",
    name: "Studio Blanche",
    tagline: "A modern, all-white space with sleek design.",
    description:
      "A bright, modern canvas for creative work. Featuring a white cyclorama wall, natural light, and a minimalist aesthetic designed for portraits, branding sessions, and editorial work.",
    // The original website's studio page, in its words (the owner's brief of 2026-11-24, item 1; migration 0069).
    sections: [
      { title: "Furniture", text: "- Brown leather statement couch\n- Modern console with props\n- Black fabric chair\n- Black TOGO chair\n- White boucle chair\n- Metal side table\n- Large arched mirror\n- Irregular shape wall mirror\n- White side table" },
      { title: "Paper backdrops", text: "Studio Blanche features a wall-mounted paper backdrop system with three seamless backdrops available at all times. Colors are rotated periodically, so feel free to reach out to confirm the current selection before your session." },
      { title: "Cyclorama wall", text: "A 10×15 ft seamless white cyclorama wall offers a clean, distraction-free backdrop for editorial, branding, and commercial shoots." },
      { title: "Window layout", text: "Large southeast-facing windows along one wall provide consistent directional natural light throughout the morning and into early afternoon." },
      { title: "Shoe covering policy", text: "Studio Blanche is a bright, all-white space that we take pride in keeping clean for every guest. To help maintain its pristine look, we kindly ask that all visitors either remove their shoes or wear provided shoe covers while inside the studio.\nFor photos where footwear is part of the look, you may also cover the soles with painter’s tape for a seamless, unnoticeable appearance in images." },
      { title: "Additional amenities", text: "To help your session run smoothly and comfortably, the studio includes:\n- Clothing steamer\n- Alexa speaker for music\n- Clothing rack\n- Free Wi-Fi\n- Dedicated makeup area with a makeup mirror with lights\nThere is a changing area located just before the studio entrance. Please note: if you are only booking Studio Blanche, the changing area may be shared with guests from Studio Paris." },
      { title: "Pets", text: "Pets are not allowed in Studio Blanche." },
    ],
    includedGuests: 6,
    extraGuests: 6,
    // hours -> dollars
    prices: {
      weekday: { 1: 88, 1.5: 132, 2: 176, 3: 264, 4: 320, 5: 385, 8: 605, 10: 720 },
      weekend: { 1: 95, 1.5: 142.5, 2: 190, 3: 285, 4: 345, 5: 416, 8: 653, 10: 777 },
    },
    // Photography sessions, studio included: hours -> dollars
    sessions: { 1: 375, 2: 575, 3: 730, 4: 840 },
  },
  {
    slug: "dayglow",
    color: "#2f6fc2",
    name: "Studio Dayglow",
    tagline: "A natural, boho-style studio with warm vibes.",
    description:
      "A textured, natural space filled with light. Featuring textured walls, soft drapery, and beautiful natural light, Dayglow offers a warm and organic setting for portraits, branding sessions, and creative work.",
    // The original website's studio page, in its words (the owner's brief of 2026-11-24, item 1; migration 0069).
    sections: [
      { title: "Furniture", text: "- Green couch\n- Stone side table\n- Irregular shape coffee table\n- Arched mirror\n- Irregular shape fabric mirror\n- Blue chair\n- Beige TOGO chair\n- Grey plastic kids chair" },
      { title: "Paper backdrops", text: "Studio Dayglow includes a movable floor paper backdrop stand with a selection of colors such as red, pink, white, black, and tan. Backdrops can be changed during your appointment to give you more variety within your session." },
      { title: "Window layout", text: "Studio Dayglow features two interconnected rooms, each with its own natural light characteristics.\nRoom One faces southeast and west, receiving natural light from the morning through sunset. The dual exposure keeps the space bright and dynamic throughout the day.\nRoom Two faces west and receives direct sunlight from early afternoon (around 1-2 PM) through sunset, creating warm, glowing light ideal for golden-hour sessions." },
      { title: "Seasonal setups", text: "Throughout the year, this studio is styled for special seasonal installations. In the past, we’ve featured Christmas and Valentine’s Day setups, transforming the space to match the season." },
      { title: "Additional amenities", text: "To help your session run smoothly and comfortably, the studio includes:\n- Clothing steamer\n- Alexa speaker for music\n- Clothing rack\n- Free Wi-Fi\n- Dedicated makeup area with a makeup mirror with lights\n- Inflatable air mattress (available by request only)\nThere is a changing area located just before the studio entrance." },
      { title: "Pets", text: "Studio Dayglow is our pet-friendly studio! You’re welcome to bring your furry friend along for your photoshoot.\nPets must be added to your reservation in advance, and a $40 pet fee applies.\nPlease note that Studio Blanche and Studio Paris remain pet-free." },
    ],
    includedGuests: 6,
    extraGuests: 6,
    prices: {
      weekday: { 1: 78, 1.5: 117, 2: 156, 3: 234, 4: 285, 5: 350, 8: 540 },
      weekend: { 1: 82, 1.5: 123, 2: 164, 3: 246, 4: 300, 5: 368, 8: 568 },
    },
    // Photography sessions, studio included: hours -> dollars
    sessions: { 1: 315, 2: 515, 3: 670, 4: 775 },
  },
  {
    slug: "paris",
    color: "#7a4fc2",
    name: "Studio Paris",
    tagline: "A romantic space with vintage charm.",
    description:
      "A romantic, elegant space for timeless visuals. Featuring classic details, soft natural light, and curated furnishings, Studio Paris creates an elegant setting for portraits, branding sessions, and creative work.",
    // The original website's studio page, in its words (the owner's brief of 2026-11-24, item 1; migration 0069).
    sections: [
      { title: "Furniture", text: "- White vintage couch\n- Fireplace mantel\n- Gold vintage wall mirror\n- Gold vintage floor mirror\n- Black wooden desk\n- Wall art\n- Vintage side table" },
      { title: "Paper backdrops", text: "Ceiling-mounted paper backdrops coming soon!" },
      { title: "Window layout", text: "Large southeast-facing windows bring in a lot of natural light from early morning through the afternoon. The space stays bright and airy, making it ideal for naturally lit portraits and lifestyle sessions." },
      { title: "Seasonal setups", text: "Throughout the year, this studio is styled for special seasonal installations. In the past, we’ve featured Christmas and Valentine’s Day setups, transforming the space to match the season." },
      { title: "Additional amenities", text: "To help your session run smoothly and comfortably, the studio includes:\n- Clothing steamer\n- Alexa speaker for music\n- Clothing rack\n- Free Wi-Fi\n- Dedicated makeup area with a makeup mirror with lights\nThere is a changing area located just before the studio entrance. Please note: if you are only booking Studio Paris, the changing area may be shared with guests from Studio Blanche." },
      { title: "Pets", text: "Pets are not allowed in Studio Paris." },
    ],
    includedGuests: 4,
    extraGuests: 4,
    prices: {
      weekday: { 1: 68, 1.5: 102, 2: 136, 3: 195, 4: 245, 5: 300 },
      weekend: { 1: 72, 1.5: 108, 2: 144, 3: 206, 4: 259, 5: 318 },
    },
    // Photography sessions, studio included: hours -> dollars
    sessions: { 1: 315, 2: 515, 3: 670 },
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
          extraGuests: s.extraGuests,
          bufferMinutes: 15,
          color: s.color,
          facts: { sections: s.sections },
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
          Object.entries(s.prices[dayType]).map(([hours, dollars]) => ({
            studioId: row.id,
            dayType,
            durationMinutes: h(Number(hours)),
            priceCents: dollars * 100,
          })),
        ),
      );
    }

    await tx.insert(photoPackages).values(
      STUDIOS.flatMap((s) =>
        Object.entries(s.sessions).map(([hours, dollars]) => ({
          studioId: ids[s.slug],
          durationMinutes: h(Number(hours)),
          priceCents: dollars * 100,
          includes: SESSION_INCLUDES[Number(hours)] ?? "",
        })),
      ),
    );

    // The in-house photographer. The migration that added photography creates one; this is for a
    // database that has none. They work 9 am to 5 pm (the owner, 2026-11-15), so the last one-hour
    // session starts at 4 pm. The owner changes the hours, and switches days off, under Admin, Photography.
    const [someone] = await tx.select({ id: photographers.id }).from(photographers).where(eq(photographers.service, "photography")).limit(1);
    if (!someone) {
      const [photographer] = await tx.insert(photographers).values({ name: "In-house photographer" }).returning({ id: photographers.id });
      await tx.insert(photographerHours).values(
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          photographerId: photographer.id,
          weekday,
          openMinute: h(9),
          closeMinute: h(17),
        })),
      );
    }

    // The in-house content creator (question 69), as migration 0063 makes one: 9 am to 5 pm every day, after the
    // photographer in order, with no session on sale until the owners add one under Admin, Content Creation.
    const [creator] = await tx.select({ id: photographers.id }).from(photographers).where(eq(photographers.service, "content")).limit(1);
    if (!creator) {
      const [made] = await tx
        .insert(photographers)
        .values({ name: "In-house content creator", sortOrder: 1, service: "content" })
        .returning({ id: photographers.id });
      await tx.insert(photographerHours).values([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ photographerId: made.id, weekday, openMinute: h(9), closeMinute: h(17) })));
    }

    await tx.insert(addons).values([
      {
        // $5 for each guest beyond those included (follow-up 2, the owner's answer of 2026-11-17). How many a booking
        // can take is each studio's `extraGuests`, and the settings' limits for studios booked together.
        slug: "extra-guest",
        name: "Extra guest",
        description: "For each guest beyond those included with the studio.",
        priceCents: 500,
        studioId: null,
        maxQuantity: 20,
        kind: "people",
        sortOrder: 0,
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

    for (const [index, plan] of STARTING_PLANS.entries()) {
      const [row] = await tx
        .insert(membershipPlans)
        .values({ name: plan.name, description: plan.description, minutes: h(plan.hours), priceCents: plan.dollars * 100, sortOrder: index })
        .returning({ id: membershipPlans.id });
      await tx.insert(membershipPlanStudios).values(plan.studios.map((slug) => ({ planId: row.id, studioId: ids[slug] })));
    }
  });
  return true;
}
