import { studioCombinationError } from "@/lib/catalog-view";

/**
 * How an appointment looks in the admin (the owner's admin brief of 2026-11-22, items 2 to 4): one colour for each
 * studio, kept in the database with the studio (Dayglow blue, Paris purple, Blanche green); one for each bundle, which
 * is one appointment holding several studios; a deeper shade of either for a photography session; and its name and
 * length in words ("Paris + Dayglow · 1.5 hours").
 */

export interface LookStudio {
  id: string;
  slug: string;
  name: string;
  color: string;
}

export interface AppointmentLook {
  /** "Dayglow", "Paris + Dayglow". */
  name: string;
  /** The colour it is drawn in: the studio's or the bundle's, deeper for a photography session. */
  color: string;
  bundle: boolean;
}

/**
 * The three bundles the owner named, in their words, with the colours the builder chose for them: apart from the
 * studios' blue, purple and green, and from one another. Keyed by the studios' slugs in alphabetical order.
 */
const BUNDLES: Record<string, { name: string; color: string }> = {
  "dayglow+paris": { name: "Paris + Dayglow", color: "#c63f76" },
  "blanche+paris": { name: "Paris + Blanche", color: "#d9791c" },
  "blanche+dayglow+paris": { name: "Paris + Dayglow + Blanche", color: "#a88524" },
};

/** "Studio Dayglow" is "Dayglow" where the calendar has little room. */
export const shortStudioName = (name: string) => name.replace(/^Studio\s+/i, "");

/** A colour `share` of the way to black: a deeper shade of the same colour. */
export function deeper(hex: string, share = 0.35): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * (1 - share));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

/** A colour `share` of the way to white: a lighter shade of the same colour, for a content creation session. */
function lighter(hex: string, share = 0.4): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) + (255 - ((value >> shift) & 255)) * share);
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The name and colour of an appointment holding `held` (in any order): a studio rental (false), a photography session
 * (true, or "photography") in a deeper shade, a content creation session ("content") in a lighter one (question 69).
 */
export function appointmentLook(held: readonly LookStudio[], photography: boolean | "photography" | "content" | null): AppointmentLook {
  const sorted = [...held].sort((a, b) => a.slug.localeCompare(b.slug));
  const known = sorted.length > 1 ? BUNDLES[sorted.map((studio) => studio.slug).join("+")] : undefined;
  const base =
    held.length === 1
      ? { name: shortStudioName(held[0].name), color: held[0].color }
      : known ?? { name: held.map((studio) => shortStudioName(studio.name)).join(" + "), color: held[0]?.color ?? "#8a7f72" };
  const color = photography === "content" ? lighter(base.color) : photography ? deeper(base.color) : base.color;
  return { name: base.name, color, bundle: held.length > 1 };
}

/**
 * The studios in the order of the calendar's columns, so that every bundle is side by side and can be drawn as one
 * appointment. A studio that every bundle needs (Paris: Blanche and Dayglow go together only with it) goes in the
 * middle; the others keep the owners' order around it. With no such studio, the owners' order stays.
 */
export function calendarColumns<T extends { id: string; slug: string }>(studios: readonly T[]): T[] {
  if (studios.length < 3) return [...studios];
  const hub = studios.find((candidate) =>
    studios.every((a) => studios.every((b) => a === b || a === candidate || b === candidate || studioCombinationError(studios, [a.id, b.id]) !== null)),
  );
  if (!hub) return [...studios];
  const others = studios.filter((studio) => studio !== hub);
  const middle = Math.floor(studios.length / 2);
  return [...others.slice(0, middle), hub, ...others.slice(middle)];
}

/** Where an appointment goes among the columns: each run of columns side by side that it holds, as a first lane and a width. */
export function lanesOf(heldIds: readonly string[], columns: readonly { id: string }[]): { lane: number; span: number }[] {
  const runs: { lane: number; span: number }[] = [];
  columns.forEach((column, index) => {
    if (!heldIds.includes(column.id)) return;
    const last = runs.at(-1);
    if (last && last.lane + last.span === index) last.span++;
    else runs.push({ lane: index, span: 1 });
  });
  return runs;
}

/** "1 hour", "1.5 hours", "45 minutes": a length as the owner wrote it ("Dayglow · 1.5 hours"). */
export function hoursText(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
