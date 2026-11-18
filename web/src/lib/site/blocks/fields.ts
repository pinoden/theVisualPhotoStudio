import type { ReactNode } from "react";

/**
 * What a block of a page is made of. A block (a heading, a picture, a row of
 * columns) is described once, as a set of fields, and three things follow
 * from that one description:
 *
 *  - the form the page editor shows for the block (`puck-fields.tsx`);
 *  - what a new block starts with (`startProps`);
 *  - the check that turns whatever was stored or sent into valid values
 *    (`parseProps`, in check.ts): text is cut to its length, formatted text is
 *    cleaned, a link that is not a link is left out, a choice that is not
 *    offered takes the first one. Nothing else about a block is ever stored.
 *
 * A field marked `phone: true` has a second value for phones, stored under
 * the field's name with "Phone" after it: "" or null means "the same as on a
 * computer". That is how a page looks different on a phone without anything
 * changing on a computer.
 *
 * This file is plain data and functions, with no React in it. It goes to the
 * browser with the page editor; the check (check.ts) stays on the server,
 * because the HTML cleaner it uses is not for browsers.
 */

export interface TextField {
  kind: "text";
  label: string;
  max: number;
  start: string;
  /** Several lines, kept as lines. */
  lines?: boolean;
  /** Typed straight onto the page in the editor, not into the side panel. */
  inline?: boolean;
}

export interface RichField {
  kind: "rich";
  label: string;
  /** Formatted text, as HTML the cleaner accepts. */
  start: string;
}

export interface ChoiceField<Options extends Readonly<Record<string, string>> = Readonly<Record<string, string>>> {
  kind: "choice";
  label: string;
  /** value -> what the editor calls it. The first is the fallback. */
  options: Options;
  start: keyof Options & string;
  phone?: boolean;
}

export interface ToggleField {
  kind: "toggle";
  label: string;
  start: boolean;
}

export interface NumberField {
  kind: "number";
  label: string;
  min: number;
  max: number;
  step?: number;
  start: number;
  phone?: boolean;
}

export interface LinkField {
  kind: "link";
  label: string;
  start: string;
}

/** One picture of the media library, by its id. "" for none. */
export interface PictureField {
  kind: "picture";
  label: string;
}

/** Several pictures of the media library, in order. */
export interface PicturesField {
  kind: "pictures";
  label: string;
  max: number;
}

/** A collection of the media library, by its id. "" for none. */
export interface CollectionField {
  kind: "collection";
  label: string;
}

export interface ListField<Of extends Fields = Fields> {
  kind: "list";
  label: string;
  of: Of;
  max: number;
  start: Record<string, unknown>[];
  /** The field of an item that names it in the editor's list. */
  title: keyof Of & string;
}

/** A place inside a block that holds other blocks. `allow` limits which. */
export interface SlotField {
  kind: "slot";
  allow?: readonly string[];
}

export type Field =
  | TextField
  | RichField
  | ChoiceField
  | ToggleField
  | NumberField
  | LinkField
  | PictureField
  | PicturesField
  | CollectionField
  | ListField
  | SlotField;

export type Fields = Readonly<Record<string, Field>>;

/** A block as a page stores it. */
export interface StoredBlock {
  type: string;
  props: Record<string, unknown> & { id: string };
}

// ── What a block's values are, worked out from its fields ────────────────────

type StoredValue<F extends Field> = F extends ChoiceField<infer Options>
  ? keyof Options & string
  : F extends ToggleField
    ? boolean
    : F extends NumberField
      ? number
      : F extends PicturesField
        ? string[]
        : F extends ListField<infer Of>
          ? Stored<Of>[]
          : F extends SlotField
            ? StoredBlock[]
            : string;

/** The names of the fields that have a second value for phones. */
type PhoneNames<F extends Fields> = { [K in keyof F & string]: F[K] extends { phone: true } ? K : never }[keyof F & string];

type PhoneValue<F extends Field> = F extends ChoiceField<infer Options> ? (keyof Options & string) | "" : number | null;

/** The values of a block as they are stored. */
export type Stored<F extends Fields> = { [K in keyof F]: StoredValue<F[K]> } & { [K in PhoneNames<F> as `${K}Phone`]: PhoneValue<F[K]> };

/** What a place for other blocks is when a block is drawn: something to render where they go. */
export type SlotView = (props?: { className?: string }) => ReactNode;

type ShownValue<F extends Field> = F extends RichField
  ? ReactNode
  : F extends TextField
    ? F extends { inline: true }
      ? ReactNode
      : string
    : F extends SlotField
      ? SlotView
      : F extends ListField<infer Of>
        ? Shown<Of>[]
        : StoredValue<F>;

/**
 * The values of a block as its drawing gets them. The same as stored, except
 * that formatted text and text typed onto the page arrive ready to place
 * (in the editor they are the fields themselves), and a place for other
 * blocks arrives as something to render.
 */
export type Shown<F extends Fields> = { [K in keyof F]: ShownValue<F[K]> } & { [K in PhoneNames<F> as `${K}Phone`]: PhoneValue<F[K]> };

// ── Starting values ──────────────────────────────────────────────────────────

export const hasPhone = (field: Field): field is (ChoiceField | NumberField) & { phone: true } =>
  (field.kind === "choice" || field.kind === "number") && field.phone === true;

export function startValue(field: Field): unknown {
  switch (field.kind) {
    case "text":
    case "rich":
    case "choice":
    case "toggle":
    case "number":
    case "link":
      return field.start;
    case "picture":
    case "collection":
      return "";
    case "pictures":
    case "slot":
      return [];
    case "list":
      return field.start.map((item) => ({ ...startProps(field.of), ...item }));
  }
}

/** What a new block starts with. */
export function startProps(fields: Fields): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    props[name] = startValue(field);
    if (hasPhone(field)) props[`${name}Phone`] = field.kind === "choice" ? "" : null;
  }
  return props;
}
