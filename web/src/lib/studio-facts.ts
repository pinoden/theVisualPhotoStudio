/**
 * The facts of a studio that photographers choose a studio by: its size, the
 * height of its ceiling, its light (which way the windows face), its
 * cyclorama, what comes with it, and a floor plan. The owners write them
 * under Studios & add-ons; the studios page shows the ones that are written.
 * An idea taken from another studio's website (see "Ideas from another
 * studio's website" in CLAUDE.md).
 *
 * Kept in one JSON column, `studios.facts`, and always read through
 * `parseStudioFacts`, so that whatever is stored comes out complete and
 * within its limits.
 */
export interface StudioFacts {
  /** "850 sq ft". */
  size: string;
  /** "14 ft". */
  ceiling: string;
  /** "Floor-to-ceiling windows facing southeast". */
  light: string;
  /** "10 × 15 ft white cyclorama wall". */
  cyclorama: string;
  /** What comes with the studio, one thing a line: "Paper backdrops", "C-stands". */
  included: string[];
  /** The id of a picture of the media library that is the studio's floor plan, or "". */
  floorPlan: string;
}

export const STUDIO_FACT_LIMITS = { line: 120, included: 20, includedLine: 80 } as const;

export const NO_FACTS: StudioFacts = { size: "", ceiling: "", light: "", cyclorama: "", included: [], floorPlan: "" };

/** What each fact is called where it is shown, in the order it is shown. */
export const FACT_LABELS = { size: "Size", ceiling: "Ceiling", light: "Light", cyclorama: "Cyclorama" } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One line of text: control characters out, spaces tidied, cut to `max`. */
function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** The things that come with a studio, from a list or from text with one thing a line. Empty lines are dropped. */
export function includedList(value: unknown): string[] {
  const lines = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r\n?|\n/) : [];
  return lines
    .map((entry) => line(entry, STUDIO_FACT_LIMITS.includedLine))
    .filter((entry) => entry !== "")
    .slice(0, STUDIO_FACT_LIMITS.included);
}

/** Complete, valid facts from whatever was stored or sent. */
export function parseStudioFacts(raw: unknown): StudioFacts {
  const source = isRecord(raw) ? raw : {};
  const floorPlan = source.floorPlan;
  return {
    size: line(source.size, STUDIO_FACT_LIMITS.line),
    ceiling: line(source.ceiling, STUDIO_FACT_LIMITS.line),
    light: line(source.light, STUDIO_FACT_LIMITS.line),
    cyclorama: line(source.cyclorama, STUDIO_FACT_LIMITS.line),
    included: includedList(source.included),
    floorPlan: typeof floorPlan === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(floorPlan) ? floorPlan.toLowerCase() : "",
  };
}

/** True when there is anything to show. */
export function hasFacts(facts: StudioFacts): boolean {
  return Boolean(facts.size || facts.ceiling || facts.light || facts.cyclorama || facts.included.length > 0 || facts.floorPlan);
}
