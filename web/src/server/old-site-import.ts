import type { Db } from "@/db/client";
import { mediaCollections, studios } from "@/db/schema";
import { startProps, type StoredBlock } from "@/lib/site/blocks/fields";
import { BLOCKS, type BlockName } from "@/lib/site/blocks/registry";
import { eachBlock } from "@/lib/site/page";
import type { AuthUser } from "./auth";
import { addToCollection, COLLECTION_LIMITS, createCollection, saveCollection } from "./collections";
import { describeMedia, uploadImage } from "./media";
import { listPages, loadPageForEditing, publishPage, savePageDraft } from "./pages";
import { addStudioPhotos, setStudioFloorPlan, STUDIO_PHOTO_LIMIT } from "./studio-photos";

/**
 * The photos of the old website (Squarespace, thevisualsphotostudio.com) put
 * into this site's media library, where the owners' own uploads go: the same
 * checks, the same processing and the same file store (`uploadImage`). Then
 * each is put where the old site showed it, as far as this site has a place
 * for it: a studio's photos and floor plan, a collection (with the dates of a
 * season's set), and a gallery on a page.
 *
 * What goes where is a manifest written from the old site's pages, kept with
 * the downloaded photos outside the repository: their file names hold the
 * names of the studio's clients. `scripts/import-old-site-photos.ts` runs it.
 *
 * It runs once per database: every collection it makes says it was imported,
 * and a database that has one is refused. A page that has changes waiting for
 * the owners gets the gallery in that draft, and is never published here.
 */

export const IMPORTED_MARK = "Imported from the old website";

export interface OldSitePhoto {
  /** The downloaded file, as the reader is asked for it (relative to the manifest). */
  file: string;
  /** Its name in the library and in its address, "studio-blanche-01.jpg": the ending follows what the file really is. */
  name: string;
  alt: string;
  caption?: string;
  /** The old site's pages it was on, for the record. */
  from?: string[];
}

export interface OldSiteManifest {
  /** The old website, named in each collection's description. */
  source: string;
  photos: OldSitePhoto[];
  /** By the studio's slug: its photos, in order (the first is its card's), and its floor plan. Indexes into `photos`. */
  studios: { slug: string; photos: number[]; floorPlan?: number }[];
  collections: { name: string; description: string; startsOn?: string; endsOn?: string; photos: number[] }[];
  /** A gallery of one of the collections above, put on a page in a section of its own after the section with this heading. */
  pageGalleries: { slug: string; afterHeading: string; collection: string; columns: number; shape: "square" | "photo" | "tall" | "wide" }[];
}

export interface ImportReport {
  uploaded: number;
  /** Photos that could not be added, with why. */
  failed: { name: string; why: string }[];
  /** What was put where, in words. */
  placed: string[];
  /** What could not be put where it was meant to go, with why. */
  notPlaced: string[];
}

export type ImportResult = { ok: true; report: ImportReport } | { ok: false; message: string };

/** What is wrong with a manifest before anything is changed: none for one that can be imported. */
export function manifestProblems(manifest: OldSiteManifest): string[] {
  const problems: string[] = [];
  const count = manifest.photos.length;
  const index = (where: string, n: number | undefined) => {
    if (n !== undefined && (!Number.isInteger(n) || n < 0 || n >= count)) problems.push(`${where}: photo ${n} is not in the list of ${count}.`);
  };
  manifest.photos.forEach((photo, n) => {
    if (!photo.file || !photo.name) problems.push(`Photo ${n} has no file or no name.`);
    if (!photo.alt.trim()) problems.push(`Photo ${n} (${photo.name}) does not say what it shows.`);
  });
  for (const studio of manifest.studios) {
    studio.photos.forEach((n) => index(`Studio ${studio.slug}`, n));
    index(`Studio ${studio.slug}'s floor plan`, studio.floorPlan);
    if (studio.photos.length > STUDIO_PHOTO_LIMIT) problems.push(`Studio ${studio.slug} has ${studio.photos.length} photos: a studio takes ${STUDIO_PHOTO_LIMIT} at most.`);
  }
  for (const set of manifest.collections) {
    set.photos.forEach((n) => index(`Collection ${set.name}`, n));
    if (set.name.length > COLLECTION_LIMITS.name) problems.push(`The collection name "${set.name}" is longer than ${COLLECTION_LIMITS.name} characters.`);
    if (describe(manifest, set.description, new Date(0)).length > COLLECTION_LIMITS.description) problems.push(`The description of "${set.name}" is too long.`);
  }
  for (const gallery of manifest.pageGalleries) {
    if (!manifest.collections.some((set) => set.name === gallery.collection)) problems.push(`The gallery on /${gallery.slug} names a collection that is not in the manifest: ${gallery.collection}.`);
  }
  return problems;
}

/** A collection's description: the manifest's words, and that it was imported, from where and when. */
function describe(manifest: OldSiteManifest, words: string, now: Date): string {
  return `${words} ${IMPORTED_MARK} (${manifest.source}) on ${now.toISOString().slice(0, 10)}.`.trim();
}

const plain = (text: string) => text.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

function makeBlock(type: BlockName, id: string, props: Record<string, unknown>): StoredBlock {
  return { type, props: { ...startProps(BLOCKS[type].fields), ...props, id } };
}

export async function importOldSitePhotos(
  db: Db,
  viewer: AuthUser,
  manifest: OldSiteManifest,
  readPhoto: (file: string) => Promise<Uint8Array>,
  options: { publish: boolean; now: Date; log?: (line: string) => void },
): Promise<ImportResult> {
  const log = options.log ?? (() => {});
  if (viewer.role !== "owner") return { ok: false, message: "Only an owner can import the old website's photos." };
  const problems = manifestProblems(manifest);
  if (problems.length > 0) return { ok: false, message: `The manifest cannot be imported: ${problems.join(" ")}` };
  const done = (await db.select({ name: mediaCollections.name, description: mediaCollections.description }).from(mediaCollections)).find((set) =>
    set.description.includes(IMPORTED_MARK),
  );
  if (done) return { ok: false, message: `The old website's photos were imported into this database already (the collection "${done.name}" says so). Nothing was changed.` };

  const report: ImportReport = { uploaded: 0, failed: [], placed: [], notPlaced: [] };

  // 1. Every photo into the library, with what it shows.
  const ids: (string | undefined)[] = [];
  for (const [n, photo] of manifest.photos.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = await readPhoto(photo.file);
    } catch (error) {
      report.failed.push({ name: photo.name, why: `the file could not be read (${error instanceof Error ? error.message : String(error)})` });
      continue;
    }
    const added = await uploadImage(db, viewer, { bytes, filename: photo.name }, options.now);
    if (!added.ok) {
      report.failed.push({ name: photo.name, why: added.message });
      continue;
    }
    const described = await describeMedia(db, viewer, added.picture.id, { alt: photo.alt, caption: photo.caption ?? "" }, options.now);
    if (!described.ok) report.failed.push({ name: photo.name, why: `added, but not described: ${described.message}` });
    ids[n] = added.picture.id;
    report.uploaded++;
    if ((n + 1) % 10 === 0) log(`${n + 1} of ${manifest.photos.length} photos added`);
  }
  const idsOf = (list: number[]) => list.map((n) => ids[n]).filter((id): id is string => id !== undefined);

  // 2. The studios' photos and floor plans.
  const studioRows = await db.select({ id: studios.id, slug: studios.slug, name: studios.name }).from(studios);
  for (const wanted of manifest.studios) {
    const studio = studioRows.find((row) => row.slug === wanted.slug);
    if (!studio) {
      report.notPlaced.push(`Studio ${wanted.slug}: there is no studio with that address here, so its ${wanted.photos.length} photos are only in the library.`);
      continue;
    }
    const photos = idsOf(wanted.photos);
    if (photos.length > 0) {
      const added = await addStudioPhotos(db, viewer, studio.id, photos);
      if (added.ok) report.placed.push(`${studio.name}: ${photos.length} photos.`);
      else report.notPlaced.push(`${studio.name}'s photos: ${added.message}`);
    }
    const plan = wanted.floorPlan === undefined ? undefined : ids[wanted.floorPlan];
    if (plan) {
      const set = await setStudioFloorPlan(db, viewer, studio.id, plan);
      if (set.ok) report.placed.push(`${studio.name}: its floor plan.`);
      else report.notPlaced.push(`${studio.name}'s floor plan: ${set.message}`);
    }
  }

  // 3. The collections, with the dates of a season's set.
  const collectionIds = new Map<string, string>();
  for (const wanted of manifest.collections) {
    const made = await createCollection(db, viewer, wanted.name);
    if (!made.ok || !made.id) {
      report.notPlaced.push(`The collection ${wanted.name}: ${made.ok ? "it was not made" : made.message}`);
      continue;
    }
    const saved = await saveCollection(db, viewer, made.id, {
      name: wanted.name,
      description: describe(manifest, wanted.description, options.now),
      startsOn: wanted.startsOn ?? "",
      endsOn: wanted.endsOn ?? "",
    });
    if (!saved.ok) report.notPlaced.push(`The collection ${wanted.name}'s details: ${saved.message}`);
    const photos = idsOf(wanted.photos);
    if (photos.length > 0) {
      const added = await addToCollection(db, viewer, made.id, photos);
      if (!added.ok) report.notPlaced.push(`The collection ${wanted.name}'s photos: ${added.message}`);
    }
    collectionIds.set(wanted.name, made.id);
    const dates = wanted.startsOn || wanted.endsOn ? `, shown from ${wanted.startsOn || "now"} to ${wanted.endsOn || "no end"}` : "";
    report.placed.push(`The collection ${wanted.name}: ${photos.length} photos${dates}.`);
  }

  // 4. The galleries on pages: in the draft, published only when nothing else was waiting there.
  const pages = (await listPages(db, viewer)) ?? [];
  for (const wanted of manifest.pageGalleries) {
    const page = pages.find((row) => row.slug === wanted.slug);
    const collection = collectionIds.get(wanted.collection);
    if (!page || !collection) {
      report.notPlaced.push(`The gallery for /${wanted.slug}: ${!page ? "there is no such page here" : `the collection ${wanted.collection} was not made`}.`);
      continue;
    }
    const state = await loadPageForEditing(db, viewer, page.id, options.now);
    if (!state) {
      report.notPlaced.push(`The gallery for /${wanted.slug}: the page could not be opened for editing.`);
      continue;
    }
    const taken = new Set<string>();
    eachBlock(state.content.blocks, (block) => taken.add(block.props.id));
    let n = 1;
    while (taken.has(`old-site-gallery-${n}`) || taken.has(`old-site-photos-${n}`)) n++;
    const gallery = makeBlock("Gallery", `old-site-gallery-${n}`, { source: "collection", collection, columns: wanted.columns, shape: wanted.shape });
    const section = makeBlock("Section", `old-site-photos-${n}`, { background: "page", content: [gallery] });

    const blocks = [...state.content.blocks];
    let after = -1;
    blocks.forEach((block, at) => {
      let found = false;
      eachBlock([block], (inner) => {
        if (inner.type === "Heading" && plain(String(inner.props.text ?? "")) === plain(wanted.afterHeading)) found = true;
      });
      if (found && after === -1) after = at;
    });
    blocks.splice(after === -1 ? blocks.length : after + 1, 0, section);
    const waiting = state.hasDraft && state.isLive;
    const saved = await savePageDraft(db, viewer, page.id, { ...state.content, blocks }, { basedOn: state.revision, now: options.now });
    if (!saved.ok) {
      report.notPlaced.push(`The gallery for /${wanted.slug}: ${saved.message}`);
      continue;
    }
    const where = after === -1 ? `at the end of /${wanted.slug} (the heading "${wanted.afterHeading}" was not found)` : `on /${wanted.slug}, after "${wanted.afterHeading}"`;
    if (options.publish && !waiting) {
      const published = await publishPage(db, viewer, page.id, options.now, saved.revision);
      if (published.ok) report.placed.push(`A gallery of ${wanted.collection} ${where}, published.`);
      else report.notPlaced.push(`The gallery ${where} is in the page's draft, but was not published: ${published.message}`);
    } else {
      report.placed.push(
        `A gallery of ${wanted.collection} ${where}, in the page's draft for the owners to publish${waiting ? " (the page already had changes waiting, so it was not published here)" : ""}.`,
      );
    }
  }
  return { ok: true, report };
}
