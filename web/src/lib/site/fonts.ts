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
 *
 * Beside the library there are the owners' own fonts, uploaded as files
 * (`CustomFont`, kept by src/server/fonts.ts): a brand font that no library
 * has. The design can use either kind, so the functions below take the list
 * of the owners' fonts where one could be meant.
 */

export type FontGroup = "serif" | "sans" | "display" | "script";

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

export const FONT_FORMATS = { woff2: "WOFF2", woff: "WOFF", truetype: "TrueType (.ttf)", opentype: "OpenType (.otf)" } as const;
export type FontFormat = keyof typeof FONT_FORMATS;

/** One file of a font of the owners' own. */
export interface CustomFontFile {
  /** Its address on this site. */
  url: string;
  format: FontFormat;
  /** The weight the file holds; for a variable font, the lightest. */
  weight: number;
  /** For a variable font, the heaviest weight the file holds. */
  weightMax: number | null;
  italic: boolean;
}

/** A font of the owners' own, as the design uses it. */
export interface CustomFont {
  /** "custom:" and the font's id, so that it can never be mistaken for a font of the library. */
  id: string;
  name: string;
  group: FontGroup;
  weights: number[];
  /** The name the browser knows it by. Made from the font's id: nothing a person typed reaches the stylesheet. */
  family: string;
  files: CustomFontFile[];
}

export type AnyFont = LibraryFont | CustomFont;

export const isCustomFont = (font: AnyFont): font is CustomFont => "family" in font;

/** The id the design stores for an uploaded font, and the name the browser knows that font by. */
export const customFontId = (uuid: string) => `custom:${uuid}`;
export const customFontFamily = (uuid: string) => `uf-${uuid.replace(/-/g, "").slice(0, 12)}`;

/** The weights a set of files offers: each file's own, and every hundred a variable file spans. */
export function weightsOf(files: Pick<CustomFontFile, "weight" | "weightMax">[]): number[] {
  const all = new Set<number>();
  for (const file of files) {
    if (file.weightMax === null) all.add(file.weight);
    else for (let weight = Math.ceil(file.weight / 100) * 100; weight <= file.weightMax; weight += 100) all.add(weight);
  }
  return [...all].sort((a, b) => a - b);
}

/** What the browser shows until the font has arrived, and for a letter the font lacks. */
const FALLBACK: Record<FontGroup, string> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
  display: "system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
  script: "'Brush Script MT', cursive",
};

/** The font with this id: one of the library, or one of the owners' own when their list is given. */
export function findFont(id: unknown, custom: readonly CustomFont[] = []): AnyFont | null {
  if (typeof id !== "string") return null;
  return FONT_LIBRARY.find((font) => font.id === id) ?? custom.find((font) => font.id === id && font.weights.length > 0) ?? null;
}

/** The CSS variable a font of the library is declared under. */
export function fontVariable(font: LibraryFont): string {
  return `--font-${font.id}`;
}

/** The value of `font-family` for a font. */
export function fontStack(font: AnyFont): string {
  return isCustomFont(font) ? `'${font.family}', ${FALLBACK[font.group]}` : `var(${fontVariable(font)}), ${FALLBACK[font.group]}`;
}

/**
 * The rules that tell a browser where the files of an uploaded font are.
 * Every piece is made here from a fixed list or a number: the family from the
 * font's id, the format from `FONT_FORMATS`, the address from the file's id.
 */
export function fontFaceCss(font: CustomFont): string {
  return font.files
    .filter((file) => /^\/font-files\/[0-9a-f-]{36}\/[a-z0-9.-]+$/.test(file.url) && file.format in FONT_FORMATS)
    .map((file) => {
      const weight = file.weightMax === null ? String(Math.round(file.weight)) : `${Math.round(file.weight)} ${Math.round(file.weightMax)}`;
      return `@font-face{font-family:'${font.family}';src:url(${file.url}) format('${file.format}');font-weight:${weight};font-style:${file.italic ? "italic" : "normal"};font-display:swap}`;
    })
    .join("");
}

/** The weight a font has that is nearest to the one asked for; the lighter of two equally near. */
export function nearestWeight(font: AnyFont, weight: number): number {
  return font.weights.reduce((best, candidate) => (Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best));
}
