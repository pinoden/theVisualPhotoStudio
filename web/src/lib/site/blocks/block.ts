import type { CSSProperties, ReactNode } from "react";
import type { Catalog } from "@/server/catalog";
import type { Picture } from "@/server/media";
import { WHEN_OPTIONS, type Holds } from "../conditions";
import type { Business } from "../frame";
import type { ChoiceField, Fields, Shown } from "./fields";

/**
 * A block of a page: what it is called, what it is made of (its fields), and
 * how it is drawn. The blocks are listed in `registry.ts`; everything else
 * about a block follows from its description here (see `fields.ts`).
 */

/** The groups the editor sorts the blocks into. */
export const BLOCK_GROUPS = {
  layout: "Layout",
  text: "Text",
  pictures: "Pictures and video",
  site: "From the studio's data",
} as const;
export type BlockGroup = keyof typeof BLOCK_GROUPS;

/**
 * What a block can read besides its own values when it is drawn. It is plain
 * data, made on the server for a page (src/server/pages.ts) and handed to
 * the editor in the browser as it is, so a block looks the same in both.
 */
export interface SiteContext {
  /** The pictures the page names, by id. One that was deleted is simply not there. */
  pictures: Record<string, Picture>;
  /** The collections the page names, by id: their pictures in order, and whether today is inside their dates. */
  collections: Record<string, { name: string; pictures: string[]; shows: boolean }>;
  /** The photos chosen under Admin → Photography, in order, when the page shows them (question 73). */
  photography?: string[];
  /** The studios, their prices, hours and add-ons, and the settings: for the blocks that show the studio's data. */
  catalog?: Catalog;
  /** The studio's name and contact details. */
  business?: Business;
  /** The live values a page's text can name (src/lib/site/live-values.ts), by name. */
  values?: Record<string, string>;
  /** Which conditions hold now (src/lib/site/conditions.ts), by name. */
  conditions?: Holds;
}

export const EMPTY_SITE: SiteContext = { pictures: {}, collections: {} };

/** What every block gets besides its own values. */
export interface BlockExtras {
  id: string;
  site: SiteContext;
  /** True in the page editor. A block then shows a note where it would otherwise show nothing, and its links lead nowhere. */
  editing: boolean;
}

export interface BlockSpec<F extends Fields = Fields> {
  label: string;
  group: BlockGroup;
  fields: F;
  render: (props: Shown<F> & BlockExtras) => ReactNode;
}

/**
 * The field every block has besides its own, last in its panel: whether it
 * shows always, or only while a condition holds (src/lib/site/conditions.ts).
 * It is the page's business, not the block's: `PageBlocks` leaves out a block
 * whose condition does not hold, and the editor marks it.
 */
const WHEN_FIELD = { kind: "choice", label: "Show it", options: WHEN_OPTIONS, start: "" } as const satisfies ChoiceField;

type WithWhen<F extends Fields> = F & { when: typeof WHEN_FIELD };

/** Describe a block. The fields are read exactly as written, which is what lets the drawing know its values' types. */
export function defineBlock<const F extends Fields>(spec: BlockSpec<F>): BlockSpec<WithWhen<F>> {
  return { ...spec, fields: { ...spec.fields, when: WHEN_FIELD } } as unknown as BlockSpec<WithWhen<F>>;
}

/**
 * CSS variables for values that may differ on a phone. Each entry gives
 * `--name`, and `--name-phone` when a value for phones was set; the
 * stylesheet uses the second on a phone and falls back to the first
 * (the rules under "Blocks of a page" in globals.css).
 */
export function cssVars(values: Record<string, [value: string | number, onPhone?: string | number | null]>): CSSProperties {
  const style: Record<string, string | number> = {};
  for (const [name, [value, onPhone]] of Object.entries(values)) {
    style[`--${name}`] = value;
    if (onPhone !== undefined && onPhone !== null && onPhone !== "") style[`--${name}-phone`] = onPhone;
  }
  return style as CSSProperties;
}
