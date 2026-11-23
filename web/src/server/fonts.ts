import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { siteDocuments, siteFontFiles, siteFonts } from "@/db/schema";
import type { Db, DbLike } from "@/db/client";
import { can } from "@/lib/abilities";
import { customFontFamily, customFontId, FONT_FORMATS, weightsOf, type CustomFont, type FontFormat, type FontGroup } from "@/lib/site/fonts";
import type { AuthUser } from "./auth";
import { fileStore, removeFiles } from "./files";
import { loadSettings } from "./settings";

/**
 * Fonts of the owners' own: a brand font that no library has, uploaded as
 * files. Once a font has a file, the design can use it like a font of the
 * library (src/lib/site/fonts.ts).
 *
 * A font may only be on a website with a licence that covers one. The site
 * cannot check that, so it asks: a font is added with the owners' own words
 * on the licence they hold, which are kept beside it.
 *
 * A file is checked to be a font file by how it begins, whatever it was
 * called. A font the design uses, published or in a draft, cannot be deleted.
 */

export const FONT_LIMITS = {
  /** Font files are small: a whole family is rarely over a megabyte. */
  fileBytes: 3 * 1024 * 1024,
  name: 40,
  licence: 500,
  files: 12,
} as const;

const CONTENT_TYPES: Record<FontFormat, string> = { woff2: "font/woff2", woff: "font/woff", truetype: "font/ttf", opentype: "font/otf" };
const ENDINGS: Record<FontFormat, string> = { woff2: "woff2", woff: "woff", truetype: "ttf", opentype: "otf" };

/** What kind of font file this is, read from its first four bytes. Null when it is not one. */
export function detectFontFormat(bytes: Uint8Array): FontFormat | null {
  if (bytes.byteLength < 12) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "opentype";
  if (tag === "true" || (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00)) return "truetype";
  return null;
}

const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isGroup = (value: unknown): value is FontGroup => value === "serif" || value === "sans" || value === "display" || value === "script";
const oneLine = (value: string, limit: number) => value.replace(/\s+/g, " ").trim().slice(0, limit).trim();

/** Who may add the owners' own fonts: whoever may change the website's design. */
export async function mayEditFonts(db: DbLike, viewer: { role: string }): Promise<boolean> {
  return can(viewer, "editDesign", await loadSettings(db));
}

type FontRow = typeof siteFonts.$inferSelect;
type FileRow = typeof siteFontFiles.$inferSelect;

const fileUrl = (font: FontRow, file: FileRow) =>
  `/font-files/${file.id}/${customFontFamily(font.id)}-${file.weight}${file.italic ? "i" : ""}.${ENDINGS[file.format]}`;

function toCustomFont(font: FontRow, files: FileRow[]): CustomFont {
  return {
    id: customFontId(font.id),
    name: font.name,
    group: font.kind,
    weights: weightsOf(files),
    family: customFontFamily(font.id),
    files: files.map((file) => ({ url: fileUrl(font, file), format: file.format, weight: file.weight, weightMax: file.weightMax, italic: file.italic })),
  };
}

async function rows(db: DbLike): Promise<{ font: FontRow; files: FileRow[] }[]> {
  const [fonts, files] = await Promise.all([
    db.select().from(siteFonts).orderBy(asc(siteFonts.name), asc(siteFonts.id)),
    db.select().from(siteFontFiles).orderBy(asc(siteFontFiles.weight), asc(siteFontFiles.italic)),
  ]);
  return fonts.map((font) => ({ font, files: files.filter((file) => file.fontId === font.id) }));
}

/** The owners' fonts, as the design needs them. Not a secret: every page that uses one names its files. */
export async function loadCustomFonts(db: DbLike): Promise<CustomFont[]> {
  return (await rows(db)).map(({ font, files }) => toCustomFont(font, files));
}

export interface FontDetails extends CustomFont {
  /** The font's own id, for the forms that change it. */
  key: string;
  licence: string;
  uploadedBy: string;
  createdAt: string;
  fileList: { id: string; format: FontFormat; weight: number; weightMax: number | null; italic: boolean; size: number }[];
  /** True while the design uses it, published or in a draft. */
  inUse: boolean;
}

/** Whether the design names this font, in what is published or in the draft. */
async function designUses(db: DbLike, fontId: string): Promise<boolean> {
  const found = await db
    .select({ id: siteDocuments.id })
    .from(siteDocuments)
    .where(
      and(
        eq(siteDocuments.kind, "design"),
        sql`(coalesce(${siteDocuments.draft}::text, '') || coalesce(${siteDocuments.published}::text, '')) like ${`%${customFontId(fontId)}%`}`,
      ),
    )
    .limit(1);
  return found.length > 0;
}

/** The owners' fonts as the admin lists them. Null for someone who may not change the design. */
export async function listFonts(db: DbLike, viewer: { role: string }): Promise<FontDetails[] | null> {
  if (!(await mayEditFonts(db, viewer))) return null;
  return Promise.all(
    (await rows(db)).map(async ({ font, files }) => ({
      ...toCustomFont(font, files),
      key: font.id,
      licence: font.licence,
      uploadedBy: font.uploadedBy,
      createdAt: font.createdAt.toISOString(),
      fileList: files.map((file) => ({ id: file.id, format: file.format, weight: file.weight, weightMax: file.weightMax, italic: file.italic, size: file.size })),
      inUse: await designUses(db, font.id),
    })),
  );
}

export type FontResult = { ok: true; id: string } | { ok: false; message: string };

const CANNOT = "You cannot change the website's fonts.";
const NOT_FOUND = "That font was not found.";

/** Add a font, without files yet. `holdsLicence` is the owners' word that they may use it on a website. */
export async function addFont(
  db: Db,
  viewer: AuthUser,
  input: { name: string; group: string; licence: string; holdsLicence: boolean },
  now: Date,
): Promise<FontResult> {
  if (!(await mayEditFonts(db, viewer))) return { ok: false, message: CANNOT };
  const name = oneLine(input.name, FONT_LIMITS.name);
  const licence = oneLine(input.licence, FONT_LIMITS.licence);
  if (!name) return { ok: false, message: "Give the font its name." };
  if (!isGroup(input.group)) return { ok: false, message: "Say what kind of font it is." };
  if (!input.holdsLicence || licence.length < 3) {
    return { ok: false, message: "A font may only be on a website with a licence for that. Tick the box and say which licence you hold." };
  }
  const [row] = await db.insert(siteFonts).values({ name, kind: input.group, licence, uploadedBy: viewer.email, createdAt: now }).returning({ id: siteFonts.id });
  return { ok: true, id: row.id };
}

const isWeight = (value: number) => Number.isInteger(value) && value >= 100 && value <= 900 && value % 100 === 0;

/**
 * Add one file to a font: one weight, upright or italic. For a variable
 * font, which is one file for a range of weights, `weightMax` is the heaviest.
 * A file for a weight and style the font already has takes the old one's place.
 */
export async function addFontFile(
  db: Db,
  viewer: AuthUser,
  fontId: string,
  input: { bytes: Uint8Array; weight: number; weightMax: number | null; italic: boolean },
  now: Date,
): Promise<FontResult> {
  if (!(await mayEditFonts(db, viewer))) return { ok: false, message: CANNOT };
  if (!isUuid(fontId)) return { ok: false, message: NOT_FOUND };
  if (input.bytes.byteLength === 0) return { ok: false, message: "Choose a font file." };
  if (input.bytes.byteLength > FONT_LIMITS.fileBytes) {
    return { ok: false, message: `That file is too large for a font: ${Math.round(FONT_LIMITS.fileBytes / 1024 / 1024)} MB at most.` };
  }
  const format = detectFontFormat(input.bytes);
  if (!format) return { ok: false, message: `That is not a font file. Use ${Object.values(FONT_FORMATS).join(", ")}.` };
  if (!isWeight(input.weight) || (input.weightMax !== null && (!isWeight(input.weightMax) || input.weightMax <= input.weight))) {
    return { ok: false, message: "Choose the weight the file holds; for a variable font, its lightest and its heaviest." };
  }
  const fileKey = `fonts/${randomUUID()}.${ENDINGS[format]}`;
  const outcome = await db.transaction(async (tx): Promise<{ result: FontResult; gone?: string }> => {
    const [font] = await tx.select().from(siteFonts).where(eq(siteFonts.id, fontId)).for("update").limit(1);
    if (!font) return { result: { ok: false, message: NOT_FOUND } };
    const existing = await tx.select().from(siteFontFiles).where(eq(siteFontFiles.fontId, fontId));
    const replaced = existing.find((file) => file.weight === input.weight && file.italic === input.italic);
    if (!replaced && existing.length >= FONT_LIMITS.files) return { result: { ok: false, message: `A font takes ${FONT_LIMITS.files} files at most.` } };
    await fileStore(tx).put(fileKey, input.bytes, CONTENT_TYPES[format]);
    if (replaced) await tx.delete(siteFontFiles).where(eq(siteFontFiles.id, replaced.id));
    await tx.insert(siteFontFiles).values({
      fontId,
      fileKey,
      format,
      weight: input.weight,
      weightMax: input.weightMax,
      italic: input.italic,
      size: input.bytes.byteLength,
      createdAt: now,
    });
    return { result: { ok: true, id: fontId }, gone: replaced?.fileKey };
  });
  if (outcome.gone) await removeFiles(db, [outcome.gone]);
  return outcome.result;
}

/** Take one file off a font. The last file of a font the design uses stays: the design would lose its font. */
export async function removeFontFile(db: Db, viewer: AuthUser, fileId: string): Promise<FontResult> {
  if (!(await mayEditFonts(db, viewer))) return { ok: false, message: CANNOT };
  if (!isUuid(fileId)) return { ok: false, message: "That file was not found." };
  const outcome = await db.transaction(async (tx): Promise<{ result: FontResult; gone?: string }> => {
    const [file] = await tx.select().from(siteFontFiles).where(eq(siteFontFiles.id, fileId)).for("update").limit(1);
    if (!file) return { result: { ok: false, message: "That file was not found." } };
    const others = await tx.select({ id: siteFontFiles.id }).from(siteFontFiles).where(eq(siteFontFiles.fontId, file.fontId));
    if (others.length === 1 && (await designUses(tx, file.fontId))) {
      return { result: { ok: false, message: "This is the font's only file and the design uses the font. Choose another font in the design first." } };
    }
    await tx.delete(siteFontFiles).where(eq(siteFontFiles.id, fileId));
    return { result: { ok: true, id: file.fontId }, gone: file.fileKey };
  });
  if (outcome.gone) await removeFiles(db, [outcome.gone]);
  return outcome.result;
}

/** Delete a font and its files. One the design uses, published or in a draft, stays. */
export async function deleteFont(db: Db, viewer: AuthUser, fontId: string): Promise<FontResult> {
  if (!(await mayEditFonts(db, viewer))) return { ok: false, message: CANNOT };
  if (!isUuid(fontId)) return { ok: false, message: NOT_FOUND };
  const outcome = await db.transaction(async (tx): Promise<{ result: FontResult; gone: string[] }> => {
    const [font] = await tx.select().from(siteFonts).where(eq(siteFonts.id, fontId)).for("update").limit(1);
    if (!font) return { result: { ok: false, message: NOT_FOUND }, gone: [] };
    if (await designUses(tx, fontId)) {
      return { result: { ok: false, message: `The design uses ${font.name}, in what is published or in a draft. Choose another font there first.` }, gone: [] };
    }
    const files = await tx.select().from(siteFontFiles).where(eq(siteFontFiles.fontId, fontId));
    await tx.delete(siteFonts).where(eq(siteFonts.id, fontId));
    return { result: { ok: true, id: fontId }, gone: files.map((file) => file.fileKey) };
  });
  await removeFiles(db, outcome.gone);
  return outcome.result;
}

/** The file behind a font file's address. Null when there is none. */
export async function readFontFile(db: DbLike, fileId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!isUuid(fileId)) return null;
  const [file] = await db.select().from(siteFontFiles).where(eq(siteFontFiles.id, fileId)).limit(1);
  if (!file) return null;
  const stored = await fileStore(db).get(file.fileKey);
  return stored ? { bytes: stored.bytes, contentType: CONTENT_TYPES[file.format] } : null;
}
