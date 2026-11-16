import { parseHref } from "../frame";
import { sanitizeRichText } from "../rich-text";
import { hasPhone, startValue, type Field, type Fields, type NumberField, type StoredBlock } from "./fields";

/**
 * The check of a block's values: whatever was stored or sent becomes valid
 * values, as the block's fields describe them (fields.ts). Server only: it
 * cleans formatted text with the HTML cleaner, which browsers never get.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Text of one line, or of several when `lines`: control characters out, spaces tidied, cut to `max`. */
export function cleanText(value: unknown, max: number, lines = false): string {
  if (typeof value !== "string") return "";
  const text = lines
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, "")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
    : value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ");
  return text.trim().slice(0, max).trim();
}

function inRange(value: unknown, field: NumberField, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const step = field.step ?? 1;
  const stepped = field.min + Math.round((Math.min(field.max, Math.max(field.min, value)) - field.min) / step) * step;
  return Math.min(field.max, Number(stepped.toFixed(4)));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks the blocks inside a place for blocks. Given by whoever knows the whole set of blocks. */
export type ParseSlot = (items: unknown, allow: readonly string[] | undefined) => StoredBlock[];

function parseValue(field: Field, value: unknown, slot: ParseSlot): unknown {
  switch (field.kind) {
    case "text":
      // Typed onto the page, text can arrive with the editor's own wrapping; only its words are kept.
      return typeof value === "string" ? cleanText(value, field.max, field.lines) : field.start;
    case "rich":
      return typeof value === "string" ? sanitizeRichText(value) : field.start;
    case "choice":
      return typeof value === "string" && Object.hasOwn(field.options, value) ? value : field.start;
    case "toggle":
      return typeof value === "boolean" ? value : field.start;
    case "number":
      return inRange(value, field, field.start);
    case "link":
      return parseHref(value) ?? "";
    case "picture":
    case "collection":
      return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : "";
    case "pictures":
      return Array.isArray(value)
        ? [...new Set(value.filter((id): id is string => typeof id === "string" && UUID.test(id)).map((id) => id.toLowerCase()))].slice(0, field.max)
        : [];
    case "list":
      return Array.isArray(value)
        ? value
            .filter(isRecord)
            .slice(0, field.max)
            .map((item) => parseProps(field.of, item, slot))
        : (startValue(field) as unknown[]);
    case "slot":
      return slot(value, field.allow);
  }
}

/**
 * The valid values of a block, from whatever was stored or sent. Only the
 * block's own fields come back: anything else that was in `raw` is dropped.
 */
export function parseProps(fields: Fields, raw: unknown, slot: ParseSlot): Record<string, unknown> {
  const source = isRecord(raw) ? raw : {};
  const props: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    props[name] = parseValue(field, source[name], slot);
    if (!hasPhone(field)) continue;
    const onPhone = source[`${name}Phone`];
    props[`${name}Phone`] =
      field.kind === "choice"
        ? typeof onPhone === "string" && Object.hasOwn(field.options, onPhone)
          ? onPhone
          : ""
        : typeof onPhone === "number" && Number.isFinite(onPhone)
          ? inRange(onPhone, field, field.start)
          : null;
  }
  return props;
}

/** The pictures and collections a block's own values name. The blocks inside it are not looked into: see `eachBlock` in page.ts. */
export function referencedIds(fields: Fields, props: Record<string, unknown>, into: { pictures: Set<string>; collections: Set<string> }): void {
  for (const [name, field] of Object.entries(fields)) {
    const value = props[name];
    if (field.kind === "picture" && typeof value === "string" && value) into.pictures.add(value);
    if (field.kind === "collection" && typeof value === "string" && value) into.collections.add(value);
    if (field.kind === "pictures" && Array.isArray(value)) for (const id of value) into.pictures.add(id as string);
    if (field.kind === "list" && Array.isArray(value)) for (const item of value) referencedIds(field.of, item as Record<string, unknown>, into);
  }
}
