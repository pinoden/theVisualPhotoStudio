"use server";

import { updateTag } from "next/cache";
import { deleteVideo, describeVideo } from "@/server/videos";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { CATALOG_TAG, WEBSITE_TAG } from "@/server/cached";
import { addToCollection, createCollection, deleteCollection, moveInCollection, removeFromCollection, saveCollection } from "@/server/collections";
import { deleteMedia, describeMedia, listMedia } from "@/server/media";
import { getCurrentUser, requireManager } from "@/server/session";

/**
 * What the media library's pages ask of the server. Like the admin's other
 * forms, each finishes by going back to the page with a short message in the
 * address. Each looks the viewer up, and the service it calls checks what
 * that viewer may do.
 */
function done(path: string, notice: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}`);
}

function failed(path: string, error: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error)}`);
}

const text = (formData: FormData, name: string) => formText(formData.get(name));

const LIBRARY = "/admin/website/media";
const COLLECTIONS = "/admin/website/media/collections";

/** Where to go back to: the library as it was filtered, or a collection's page. Nothing else is accepted. */
function back(formData: FormData, fallback: string): string {
  const path = text(formData, "back");
  return /^\/admin\/website\/media(\/collections(\/[0-9a-f-]{36})?)?(\?[A-Za-z0-9=&%_.+-]*)?$/.test(path) ? path : fallback;
}

/** What is published may show any picture or collection, so a change here refreshes the cached pages. */
function refresh(): void {
  updateTag(WEBSITE_TAG);
  updateTag(CATALOG_TAG);
}

// ── Pictures ─────────────────────────────────────────────────────────────────

export async function describeMediaAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIBRARY);
  const result = await describeMedia(await getDb(), viewer, text(formData, "id"), { alt: text(formData, "alt"), caption: text(formData, "caption") }, new Date());
  if (!result.ok) failed(back(formData, LIBRARY), result.message);
  refresh();
  done(back(formData, LIBRARY), "Saved.");
}

export async function deleteMediaAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIBRARY);
  const result = await deleteMedia(await getDb(), viewer, text(formData, "id"));
  if (!result.ok) failed(back(formData, LIBRARY), result.message);
  done(back(formData, LIBRARY), "The picture was deleted.");
}

// ── Videos (question 77) ─────────────────────────────────────────────────────

/** Back to the library's videos, the message before the anchor so that the page reads it. */
const toVideos = (kind: "notice" | "error", text: string): never => redirect(`${LIBRARY}?${kind}=${encodeURIComponent(text)}#videos`);

export async function describeVideoAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIBRARY);
  if (!(await describeVideo(await getDb(), viewer, text(formData, "id"), text(formData, "title")))) toVideos("error", "That video was not found.");
  refresh();
  toVideos("notice", "Saved.");
}

export async function deleteVideoAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIBRARY);
  const result = await deleteVideo(await getDb(), viewer, text(formData, "id"));
  if (!result.ok) toVideos("error", result.message);
  toVideos("notice", "The video was deleted.");
}

/** A picture as the chooser shows it. */
export interface ChoosablePicture {
  id: string;
  url: string;
  width: number;
  height: number;
  alt: string;
  /** The words under it in a gallery. */
  caption: string;
  filename: string;
}

/**
 * The library for the picture chooser, newest first. Called by the chooser
 * itself, so it answers with the pictures and does not redirect. Null for
 * someone who may not use the library.
 */
export async function choosablePicturesAction(q: string): Promise<ChoosablePicture[] | null> {
  const viewer = await getCurrentUser();
  if (!viewer) return null;
  const items = await listMedia(await getDb(), viewer, { q: String(q ?? "") });
  return items === null ? null : items.map(({ id, url, width, height, alt, caption, filename }) => ({ id, url, width, height, alt, caption, filename }));
}

// ── Collections ──────────────────────────────────────────────────────────────

export async function createCollectionAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(COLLECTIONS);
  const result = await createCollection(await getDb(), viewer, text(formData, "name"));
  if (!result.ok) failed(COLLECTIONS, result.message);
  done(`${COLLECTIONS}/${result.id}`, "Collection made. Add its pictures.");
}

export async function saveCollectionAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(COLLECTIONS);
  const id = text(formData, "id");
  const result = await saveCollection(await getDb(), viewer, id, {
    name: text(formData, "name"),
    description: text(formData, "description"),
    startsOn: text(formData, "startsOn"),
    endsOn: text(formData, "endsOn"),
  });
  if (!result.ok) failed(back(formData, COLLECTIONS), result.message);
  refresh();
  done(back(formData, COLLECTIONS), "Saved.");
}

export async function deleteCollectionAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(COLLECTIONS);
  const result = await deleteCollection(await getDb(), viewer, text(formData, "id"));
  if (!result.ok) failed(back(formData, COLLECTIONS), result.message);
  refresh();
  done(COLLECTIONS, "The collection was deleted. Its pictures are still in the library.");
}

export async function addToCollectionAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(COLLECTIONS);
  const result = await addToCollection(await getDb(), viewer, text(formData, "id"), text(formData, "mediaIds").split(","));
  if (!result.ok) failed(back(formData, COLLECTIONS), result.message);
  refresh();
  done(back(formData, COLLECTIONS), "Added.");
}

export async function removeFromCollectionAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(COLLECTIONS);
  const result = await removeFromCollection(await getDb(), viewer, text(formData, "id"), text(formData, "mediaId"));
  if (!result.ok) failed(back(formData, COLLECTIONS), result.message);
  refresh();
  done(back(formData, COLLECTIONS), "Taken out of the collection. The picture is still in the library.");
}

async function move(formData: FormData, by: -1 | 1): Promise<void> {
  const viewer = await requireManager(COLLECTIONS);
  const result = await moveInCollection(await getDb(), viewer, text(formData, "id"), text(formData, "mediaId"), by);
  if (!result.ok) failed(back(formData, COLLECTIONS), result.message);
  refresh();
  redirect(back(formData, COLLECTIONS));
}

export async function moveEarlierInCollectionAction(formData: FormData): Promise<void> {
  await move(formData, -1);
}

export async function moveLaterInCollectionAction(formData: FormData): Promise<void> {
  await move(formData, 1);
}
