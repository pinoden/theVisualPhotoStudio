import { findFont, fontStack, nearestWeight, type LibraryFont } from "./fonts";

/**
 * The website's design: the colours, fonts, text styles and buttons that the
 * owners set under Admin, Website, Design. It is stored as a document (a
 * draft and a published copy, see src/server/website.ts) and reaches the
 * browser as CSS variables that `designCss` writes into every page.
 *
 * Nothing here is free text. Every value is a colour, a font of the library
 * or a number inside a range, and `parseDesign` turns whatever was stored or
 * sent into a complete, valid design, so a design cannot break a page or
 * carry anything but a design into the stylesheet.
 *
 * Colours, fonts and buttons apply to the whole site, the booking steps and
 * the admin included. Text sizes, weights and spacing apply to the public
 * pages only (`.site-page` in globals.css): the booking steps, the account
 * and the admin keep the sizes they were built and tested with.
 */

export interface HeadingStyle {
  /** Size on a computer and a tablet, in percent of the size the page gives it. */
  scale: number;
  /** The same on a phone. */
  scaleMobile: number;
  weight: number;
  /** Space between letters, in em. */
  letterSpacing: number;
  lineHeight: number;
  uppercase: boolean;
}

export interface Design {
  colors: {
    /** Links, small headings above titles, and the buttons that ask to book. */
    accent: string;
    /** The accent when the pointer is on it. */
    accentHover: string;
    /** A pale accent, for soft highlights. */
    accentSoft: string;
    /** Text on something filled with the accent. */
    onAccent: string;
    /** The page. */
    background: string;
    /** Cards and every second section. */
    surface: string;
    /** Headings, the dark buttons and the footer. */
    heading: string;
    /** Running text. */
    text: string;
    /** Lines and borders. */
    border: string;
  };
  /** Each is the id of a font of the library (src/lib/site/fonts.ts). */
  fonts: { heading: string; subheading: string; body: string; button: string };
  /** `h1` and `h2` are set in the heading font; `h3` is every smaller heading, in the subheading font. */
  headings: { h1: HeadingStyle; h2: HeadingStyle; h3: HeadingStyle };
  body: {
    /** In pixels at the browser's usual text size. */
    size: number;
    sizeMobile: number;
    weight: number;
    lineHeight: number;
    letterSpacing: number;
  };
  buttons: {
    size: number;
    weight: number;
    letterSpacing: number;
    uppercase: boolean;
    /** Corner radius in pixels. 0 is square; 40 makes a pill. */
    radius: number;
    /** Space above and below the words, and left and right of them, in pixels. */
    padY: number;
    padX: number;
  };
  spacing: {
    /** Space above and below each section of a page, in pixels. */
    section: number;
    sectionMobile: number;
  };
}

const HEADING: HeadingStyle = { scale: 100, scaleMobile: 100, weight: 300, letterSpacing: 0, lineHeight: 1.2, uppercase: false };

/** The site as it was designed. A design that was never changed is this one. */
export const DEFAULT_DESIGN: Design = {
  colors: {
    accent: "#c8a882",
    accentHover: "#a88760",
    accentSoft: "#e8d5bb",
    onAccent: "#ffffff",
    background: "#f9f5f0",
    surface: "#fdfaf6",
    heading: "#2c2420",
    text: "#7a6e68",
    border: "#e8e0d8",
  },
  fonts: { heading: "cormorant-garamond", subheading: "cormorant-garamond", body: "lato", button: "lato" },
  headings: { h1: { ...HEADING }, h2: { ...HEADING }, h3: { ...HEADING } },
  body: { size: 16, sizeMobile: 16, weight: 400, lineHeight: 1.7, letterSpacing: 0 },
  buttons: { size: 14, weight: 400, letterSpacing: 0.1, uppercase: true, radius: 2, padY: 12, padX: 32 },
  spacing: { section: 80, sectionMobile: 80 },
};

/** The range of every number, and the step it moves in. The editor's fields and `parseDesign` share them. */
export const DESIGN_LIMITS = {
  headingScale: { min: 70, max: 160, step: 5 },
  headingLetterSpacing: { min: -0.05, max: 0.4, step: 0.01 },
  headingLineHeight: { min: 0.9, max: 1.8, step: 0.05 },
  bodySize: { min: 14, max: 20, step: 1 },
  bodyLineHeight: { min: 1.2, max: 2.2, step: 0.05 },
  bodyLetterSpacing: { min: -0.02, max: 0.1, step: 0.01 },
  buttonSize: { min: 12, max: 18, step: 1 },
  buttonLetterSpacing: { min: 0, max: 0.3, step: 0.01 },
  buttonRadius: { min: 0, max: 40, step: 1 },
  buttonPadY: { min: 6, max: 22, step: 1 },
  buttonPadX: { min: 12, max: 56, step: 1 },
  section: { min: 32, max: 160, step: 8 },
} as const;

type Limit = { min: number; max: number; step: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** "#C8A882" or "#c8a" -> "#c8a882". Null for anything that is not a colour written that way. */
export function parseColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  return null;
}

/** A number inside its range, on its step. The fallback for anything that is not a number. */
function inRange(value: unknown, limit: Limit, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(limit.max, Math.max(limit.min, value));
  const stepped = limit.min + Math.round((clamped - limit.min) / limit.step) * limit.step;
  // Steps such as 0.05 leave 1.2000000000000002 behind; four decimals are more than any step has.
  return Math.min(limit.max, Number(stepped.toFixed(4)));
}

function parseHeading(value: unknown, fallback: HeadingStyle, font: LibraryFont): HeadingStyle {
  const raw = isRecord(value) ? value : {};
  return {
    scale: inRange(raw.scale, DESIGN_LIMITS.headingScale, fallback.scale),
    scaleMobile: inRange(raw.scaleMobile, DESIGN_LIMITS.headingScale, fallback.scaleMobile),
    weight: nearestWeight(font, typeof raw.weight === "number" && Number.isFinite(raw.weight) ? raw.weight : fallback.weight),
    letterSpacing: inRange(raw.letterSpacing, DESIGN_LIMITS.headingLetterSpacing, fallback.letterSpacing),
    lineHeight: inRange(raw.lineHeight, DESIGN_LIMITS.headingLineHeight, fallback.lineHeight),
    uppercase: typeof raw.uppercase === "boolean" ? raw.uppercase : fallback.uppercase,
  };
}

/**
 * A complete, valid design from whatever was stored or sent. A value that is
 * missing or not acceptable takes the default; a weight the chosen font does
 * not come in becomes the nearest one it has.
 */
export function parseDesign(input: unknown): Design {
  const raw = isRecord(input) ? input : {};
  const d = DEFAULT_DESIGN;

  const rawColors = isRecord(raw.colors) ? raw.colors : {};
  const colors = { ...d.colors };
  for (const key of Object.keys(colors) as (keyof Design["colors"])[]) colors[key] = parseColor(rawColors[key]) ?? d.colors[key];

  const rawFonts = isRecord(raw.fonts) ? raw.fonts : {};
  const fonts = { ...d.fonts };
  for (const key of Object.keys(fonts) as (keyof Design["fonts"])[]) fonts[key] = findFont(rawFonts[key])?.id ?? d.fonts[key];
  const font = (role: keyof Design["fonts"]) => findFont(fonts[role])!;

  const rawHeadings = isRecord(raw.headings) ? raw.headings : {};
  const rawBody = isRecord(raw.body) ? raw.body : {};
  const rawButtons = isRecord(raw.buttons) ? raw.buttons : {};
  const rawSpacing = isRecord(raw.spacing) ? raw.spacing : {};
  const weight = (value: unknown, fallback: number, role: keyof Design["fonts"]) =>
    nearestWeight(font(role), typeof value === "number" && Number.isFinite(value) ? value : fallback);

  return {
    colors,
    fonts,
    headings: {
      h1: parseHeading(rawHeadings.h1, d.headings.h1, font("heading")),
      h2: parseHeading(rawHeadings.h2, d.headings.h2, font("heading")),
      h3: parseHeading(rawHeadings.h3, d.headings.h3, font("subheading")),
    },
    body: {
      size: inRange(rawBody.size, DESIGN_LIMITS.bodySize, d.body.size),
      sizeMobile: inRange(rawBody.sizeMobile, DESIGN_LIMITS.bodySize, d.body.sizeMobile),
      weight: weight(rawBody.weight, d.body.weight, "body"),
      lineHeight: inRange(rawBody.lineHeight, DESIGN_LIMITS.bodyLineHeight, d.body.lineHeight),
      letterSpacing: inRange(rawBody.letterSpacing, DESIGN_LIMITS.bodyLetterSpacing, d.body.letterSpacing),
    },
    buttons: {
      size: inRange(rawButtons.size, DESIGN_LIMITS.buttonSize, d.buttons.size),
      weight: weight(rawButtons.weight, d.buttons.weight, "button"),
      letterSpacing: inRange(rawButtons.letterSpacing, DESIGN_LIMITS.buttonLetterSpacing, d.buttons.letterSpacing),
      uppercase: typeof rawButtons.uppercase === "boolean" ? rawButtons.uppercase : d.buttons.uppercase,
      radius: inRange(rawButtons.radius, DESIGN_LIMITS.buttonRadius, d.buttons.radius),
      padY: inRange(rawButtons.padY, DESIGN_LIMITS.buttonPadY, d.buttons.padY),
      padX: inRange(rawButtons.padX, DESIGN_LIMITS.buttonPadX, d.buttons.padX),
    },
    spacing: {
      section: inRange(rawSpacing.section, DESIGN_LIMITS.section, d.spacing.section),
      sectionMobile: inRange(rawSpacing.sectionMobile, DESIGN_LIMITS.section, d.spacing.sectionMobile),
    },
  };
}

// ── The design as CSS ────────────────────────────────────────────────────────

/** Pixels as rem, so a visitor who made their browser's text larger keeps that. 14 -> ".875rem". */
function rem(pixels: number): string {
  const value = Number((pixels / 16).toFixed(4));
  return value === 0 ? "0" : `${String(value).replace(/^0\./, ".")}rem`;
}

const em = (value: number) => (value === 0 ? "0" : `${String(Number(value.toFixed(3))).replace(/^(-?)0\./, "$1.")}em`);

/** The width up to which the phone values apply. */
export const DESIGN_PHONE_WIDTH = 640;

/**
 * The design as CSS variables, in two groups: the values for every screen,
 * and the ones a phone replaces. The names are the ones globals.css reads; its
 * own `:root` block holds the same defaults, and a test keeps the two equal.
 */
export function designVariables(design: Design): { all: Record<string, string>; phone: Record<string, string> } {
  const { colors, fonts, headings, body, buttons, spacing } = design;
  const stack = (id: string) => fontStack(findFont(id) ?? findFont(DEFAULT_DESIGN.fonts.body)!);
  const all: Record<string, string> = {
    "--color-rose": colors.accent,
    "--color-rose-dark": colors.accentHover,
    "--color-rose-light": colors.accentSoft,
    "--on-accent": colors.onAccent,
    "--color-cream": colors.background,
    "--color-ivory": colors.surface,
    "--color-dark": colors.heading,
    "--color-muted": colors.text,
    "--color-border": colors.border,
    "--font-heading": stack(fonts.heading),
    "--font-subheading": stack(fonts.subheading),
    "--font-body": stack(fonts.body),
    "--font-button": stack(fonts.button),
  };
  const phone: Record<string, string> = {};
  for (const level of ["h1", "h2", "h3"] as const) {
    const style = headings[level];
    all[`--${level}-scale`] = String(style.scale / 100);
    all[`--${level}-weight`] = String(style.weight);
    all[`--${level}-spacing`] = em(style.letterSpacing);
    all[`--${level}-line`] = String(style.lineHeight);
    all[`--${level}-transform`] = style.uppercase ? "uppercase" : "none";
    if (style.scaleMobile !== style.scale) phone[`--${level}-scale`] = String(style.scaleMobile / 100);
  }
  all["--body-size"] = rem(body.size);
  all["--body-weight"] = String(body.weight);
  all["--body-line"] = String(body.lineHeight);
  all["--body-spacing"] = em(body.letterSpacing);
  if (body.sizeMobile !== body.size) phone["--body-size"] = rem(body.sizeMobile);
  all["--btn-size"] = rem(buttons.size);
  all["--btn-weight"] = String(buttons.weight);
  all["--btn-spacing"] = em(buttons.letterSpacing);
  all["--btn-transform"] = buttons.uppercase ? "uppercase" : "none";
  all["--btn-radius"] = `${buttons.radius}px`;
  all["--btn-pad"] = `${rem(buttons.padY)} ${rem(buttons.padX)}`;
  all["--section-pad"] = rem(spacing.section);
  if (spacing.sectionMobile !== spacing.section) phone["--section-pad"] = rem(spacing.sectionMobile);
  return { all, phone };
}

/**
 * The design as a piece of stylesheet, for the `<style>` element of every
 * page. The selector is `html:root`, which outweighs the plain `:root` of
 * globals.css, so these values win wherever the browser places the two.
 */
export function designCss(design: Design): string {
  const { all, phone } = designVariables(design);
  const block = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
  const phoneBlock = Object.keys(phone).length > 0 ? `@media (max-width:${DESIGN_PHONE_WIDTH}px){html:root{${block(phone)}}}` : "";
  return `html:root{${block(all)}}${phoneBlock}`;
}

// ── Can it be read? ──────────────────────────────────────────────────────────

/** How bright a colour is to the eye, 0 (black) to 1 (white), as WCAG defines it. */
function luminance(color: string): number {
  const channel = (index: number) => {
    const value = parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** The contrast between two colours, from 1 (the same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export interface ReadabilityCheck {
  /** What is being read on what. */
  what: string;
  /** Contrast, to one decimal: 4.6 means 4.6 to 1. */
  ratio: number;
  /** What it should be at least. */
  needed: number;
  ok: boolean;
}

/**
 * Whether the design's text can be read on what is behind it. The numbers are
 * the usual ones: 4.5 to 1 for text of ordinary size, 3 to 1 for large text
 * such as headings. A design that fails is not refused: the owners decide,
 * and the editor shows them this list.
 */
export function readabilityChecks(design: Design): ReadabilityCheck[] {
  const c = design.colors;
  const check = (what: string, text: string, behind: string, needed: number): ReadabilityCheck => {
    const ratio = contrastRatio(text, behind);
    return { what, ratio: Math.floor(ratio * 10) / 10, needed, ok: ratio >= needed };
  };
  return [
    check("Running text on the page", c.text, c.background, 4.5),
    check("Running text on cards", c.text, c.surface, 4.5),
    check("Headings on the page", c.heading, c.background, 3),
    check("Links and small headings in the accent colour, on the page", c.accent, c.background, 3),
    check("Words on a button in the accent colour", c.onAccent, c.accent, 4.5),
    check("White words on a dark button, and in the footer", "#ffffff", c.heading, 4.5),
  ];
}

/** Things about the chosen fonts that an owner would want to know before publishing. */
export function fontNotes(design: Design): string[] {
  const notes: string[] = [];
  const body = findFont(design.fonts.body);
  if (body?.capsOnly) notes.push(`${body.name} has capital letters only, so running text set in it is hard to read.`);
  if (body?.group === "script") notes.push(`${body.name} is a handwriting font: fine for a few words, tiring as running text.`);
  return notes;
}
