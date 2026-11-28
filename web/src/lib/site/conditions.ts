import { sessionsOf } from "@/lib/domain/services";
import { multiStudioOffer, petPolicy } from "@/lib/catalog-view";
import type { Catalog } from "@/server/catalog";

/**
 * Conditions: what a page shows only at times. Each is a fact about what the
 * site offers now, which the owners change on the admin's other pages: pets
 * come with a pet add-on, moving a booking is a setting, photography is on
 * offer while a session can be booked. A page written once keeps matching
 * the site: switch moving off under Settings, and the question about moving
 * leaves the guest information by itself.
 *
 * Two ways to use one:
 *  - a block's "Show it" choice (`when`, on every block): the whole block
 *    shows only while the condition holds, or only while it does not;
 *  - words that start with `{if pets}`, or `{if not pets}`: a paragraph, a
 *    list item, a heading or a quote of formatted text, and a question, a
 *    card, a button or a row of a table. Several markers in a row must all
 *    hold: `{if pets}{if pet free studios}`. A marker is never shown.
 *
 * A marker that names no condition is not one, and stays on the page as it
 * was typed, so a mistake can be seen. Plain data and functions: the editor
 * uses them in the browser, and the server when it draws a page.
 */
export const CONDITIONS = {
  pets: { yes: "pets can come (a pet fee is offered)", no: "pets cannot come" },
  "pet free studios": { yes: "some studio does not take pets", no: "every studio takes pets" },
  "extra people": { yes: "extra people can be added to a booking", no: "extra people cannot be added" },
  "add-ons": { yes: "an add-on is offered", no: "no add-on is offered" },
  moving: { yes: "a booking can be moved", no: "a booking cannot be moved" },
  "reschedule fee": { yes: "a further move of a booking costs a fee", no: "a further move of a booking costs no fee, or moving is switched off" },
  "codes kept late": { yes: "a code or credit comes back after any cancellation", no: "a late cancellation uses up the code or credit" },
  "cancel code": { yes: "a late cancellation gets a credit code", no: "a late cancellation gets nothing" },
  "weekday moves": { yes: "a booking made for a weekday is moved to a weekday only", no: "a booking is moved to any day, or moving is switched off" },
  "free hours": { yes: "returning guests earn free hours", no: "free hours are switched off" },
  "getting in": { yes: "how to get in is written under Settings", no: "how to get in is not written yet" },
  photography: { yes: "a photography session can be booked", no: "no photography session can be booked" },
  "several studios offer": { yes: "booking several studios together costs less", no: "booking several studios together costs the same" },
  "bundle prices": { yes: "bundles have prices of their own", no: "no bundle has prices of its own" },
} as const;

export type ConditionName = keyof typeof CONDITIONS;

/** Which conditions hold now. */
export type Holds = Partial<Record<string, boolean>>;

export function conditionsOf(catalog: Catalog): Record<ConditionName, boolean> {
  const s = catalog.settings;
  const pets = petPolicy(catalog);
  return {
    pets: pets.studios.length > 0,
    "pet free studios": pets.petFreeStudios.length > 0,
    "extra people": catalog.addons.some((addon) => addon.kind === "people"),
    "add-ons": catalog.addons.length > 0,
    moving: s.maxReschedules > 0,
    "reschedule fee": s.maxReschedules > 0 && s.rescheduleFeeCents > 0,
    "codes kept late": s.lateCancelKeepsCode,
    "weekday moves": s.maxReschedules > 0 && s.weekdayCodeOnWeekdays,
    "cancel code": s.cancelCodeEnabled && s.cancelCodeUntilHours < s.refundWindowHours,
    "free hours": s.loyaltyEnabled,
    "getting in": catalog.accessInfoSent,
    photography: sessionsOf(catalog.photoPackages, "photography").length > 0,
    "several studios offer": multiStudioOffer(catalog) !== "",
    "bundle prices": catalog.bundlePrices.length > 0,
  };
}

const isCondition = (name: string): name is ConditionName => Object.hasOwn(CONDITIONS, name);

/** The choices of a block's "Show it": "" (always), a condition's name, or "not " and the name. */
export const WHEN_OPTIONS: Readonly<Record<string, string>> = {
  "": "Always",
  ...Object.fromEntries(
    (Object.entries(CONDITIONS) as [ConditionName, { yes: string; no: string }][]).flatMap(([name, words]) => [
      [name, `Only while ${words.yes}`],
      [`not ${name}`, `Only while ${words.no}`],
    ]),
  ),
};

/** "Only while pets can come", for a `when` that is set; "" for always. */
export function whenWords(when: string): string {
  return when !== "" && Object.hasOwn(WHEN_OPTIONS, when) ? WHEN_OPTIONS[when] : "";
}

/**
 * Whether something with this `when` shows now. Always when it is "" or not
 * a condition, and when what holds is not known (a page drawn without the
 * studio's data).
 */
export function whenHolds(when: unknown, holds: Holds | undefined): boolean {
  if (typeof when !== "string" || when === "") return true;
  const negated = when.startsWith("not ");
  const name = negated ? when.slice(4) : when;
  if (!isCondition(name) || !holds || typeof holds[name] !== "boolean") return true;
  return holds[name] !== negated;
}

/** One marker: `{if pets}` or `{if not pets}`. */
const ONE_MARKER = /\{if (not )?([a-z][a-z -]{0,40}[a-z])\}/g;

/** The markers some words start with, one or several in a row, with the spaces around them. */
const MARKERS = /^\s*((?:\{if (?:not )?[a-z][a-z -]{0,40}[a-z]\}\s*)+)/;

/**
 * The conditions some words start with, as `when`s, and the words without
 * them. Null when they start with no marker, or with one that names no
 * condition: then nothing about them is a marker.
 */
export function markerOf(text: string): { whens: string[]; rest: string } | null {
  const match = MARKERS.exec(text);
  if (!match) return null;
  const found = [...match[1].matchAll(ONE_MARKER)];
  if (!found.every((marker) => isCondition(marker[2]))) return null;
  return { whens: found.map((marker) => `${marker[1] ? "not " : ""}${marker[2]}`), rest: text.slice(match[0].length) };
}

/** Whether every one of some `when`s holds now. */
export function allHold(whens: string[], holds: Holds | undefined): boolean {
  return whens.every((when) => whenHolds(when, holds));
}

/**
 * Words that may start with markers, as a visitor gets them: null when one
 * of their conditions does not hold now, else the words without the markers.
 */
export function shownWords(text: string, holds: Holds | undefined): string | null {
  const marker = markerOf(text);
  if (!marker) return text;
  return allHold(marker.whens, holds) ? marker.rest : null;
}
