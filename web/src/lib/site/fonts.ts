/**
 * The fonts the website's design can use: the library the owners choose from.
 *
 * Each font is declared for the browser in `src/app/fonts.ts` (with
 * `next/font`, which downloads it when the site is built and serves it from
 * the site itself) under the CSS variable `--font-<id>`. The two files are
 * kept in step by a test. A browser fetches a font only when a page uses it,
 * so a long library costs a visitor nothing.
 *
 * To add a font: add it here and declare it in `src/app/fonts.ts`.
 */

export type FontGroup = "serif" | "sans" | "display" | "script";

export const FONT_GROUPS: Record<FontGroup, string> = {
  serif: "Serif: classic, with small strokes at the ends of the letters",
  sans: "Sans serif: plain and modern",
  display: "Display: strong shapes, for headings",
  script: "Script: handwriting, for a few words",
};

export interface LibraryFont {
  id: string;
  name: string;
  group: FontGroup;
  /** The weights the font comes in, lightest first. 400 is regular, 700 bold. */
  weights: number[];
  /** Capital letters only: fine for headings and buttons, hard to read as running text. */
  capsOnly?: boolean;
}

/** Every hundred from `from` to `to`. */
function weights(from: number, to: number): number[] {
  const all: number[] = [];
  for (let weight = from; weight <= to; weight += 100) all.push(weight);
  return all;
}

export const FONT_LIBRARY: readonly LibraryFont[] = [
  { id: "cormorant-garamond", name: "Cormorant Garamond", group: "serif", weights: weights(300, 700) },
  { id: "playfair-display", name: "Playfair Display", group: "serif", weights: weights(400, 900) },
  { id: "lora", name: "Lora", group: "serif", weights: weights(400, 700) },
  { id: "eb-garamond", name: "EB Garamond", group: "serif", weights: weights(400, 800) },
  { id: "bodoni-moda", name: "Bodoni Moda", group: "serif", weights: weights(400, 900) },
  { id: "italiana", name: "Italiana", group: "serif", weights: [400] },
  { id: "marcellus", name: "Marcellus", group: "serif", weights: [400] },
  { id: "cinzel", name: "Cinzel", group: "serif", weights: weights(400, 900), capsOnly: true },

  { id: "lato", name: "Lato", group: "sans", weights: [300, 400, 700] },
  { id: "montserrat", name: "Montserrat", group: "sans", weights: weights(100, 900) },
  { id: "inter", name: "Inter", group: "sans", weights: weights(100, 900) },
  { id: "raleway", name: "Raleway", group: "sans", weights: weights(100, 900) },
  { id: "open-sans", name: "Open Sans", group: "sans", weights: weights(300, 800) },
  { id: "jost", name: "Jost", group: "sans", weights: weights(100, 900) },
  { id: "josefin-sans", name: "Josefin Sans", group: "sans", weights: weights(100, 700) },
  { id: "dm-sans", name: "DM Sans", group: "sans", weights: weights(100, 900) },
  { id: "poppins", name: "Poppins", group: "sans", weights: [300, 400, 500, 600] },

  { id: "bebas-neue", name: "Bebas Neue", group: "display", weights: [400], capsOnly: true },
  { id: "oswald", name: "Oswald", group: "display", weights: weights(200, 700) },
  { id: "unbounded", name: "Unbounded", group: "display", weights: weights(200, 900) },
  { id: "syne", name: "Syne", group: "display", weights: weights(400, 800) },
  { id: "michroma", name: "Michroma", group: "display", weights: [400] },
  { id: "krona-one", name: "Krona One", group: "display", weights: [400] },

  { id: "great-vibes", name: "Great Vibes", group: "script", weights: [400] },
  { id: "dancing-script", name: "Dancing Script", group: "script", weights: weights(400, 700) },
];

/** What the browser shows until the font has arrived, and for a letter the font lacks. */
const FALLBACK: Record<FontGroup, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
  display: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
  script: "'Brush Script MT', cursive",
};

export function findFont(id: unknown): LibraryFont | null {
  return typeof id === "string" ? (FONT_LIBRARY.find((font) => font.id === id) ?? null) : null;
}

/** The CSS variable a font is declared under. */
export function fontVariable(font: LibraryFont): string {
  return `--font-${font.id}`;
}

/** The value of `font-family` for a font of the library. */
export function fontStack(font: LibraryFont): string {
  return `var(${fontVariable(font)}), ${FALLBACK[font.group]}`;
}

/** The weight a font has that is nearest to the one asked for; the lighter of two equally near. */
export function nearestWeight(font: LibraryFont, weight: number): number {
  return font.weights.reduce((best, candidate) => (Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best));
}
