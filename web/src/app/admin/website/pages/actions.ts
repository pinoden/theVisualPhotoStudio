"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { WEBSITE_TAG } from "@/server/cached";
import {
  addRedirect,
  createPage,
  deletePage,
  discardPageDraft,
  duplicatePage,
  publishPage,
  removeRedirect,
  restorePage,
  restorePageVersion,
  savePageDraft,
  savePageSettings,
  unpublishPage,
  type PageChangeResult,
  type PublishPageResult,
  type SavePageResult,
} from "@/server/pages";
import { siteOrigins } from "@/server/runtime";
import { getCurrentUser, requireManager } from "@/server/session";

/**
 * What the pages of the website editor ask of the server. The forms of the
 * list and of a page's settings go back to their page with a short message,
 * as the admin's forms do. The editor's own four (save, publish, discard,
 * bring back) answer with a result instead, because the editor stays open.
 * Every action looks the viewer up, and the service checks what that viewer
 * may do: an action can be called by anyone who knows its name.
 */

const LIST = "/admin/website/pages";
const editorOf = (id: string) => `${LIST}/${encodeURIComponent(id)}`;

function done(path: string, notice: string): never {
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

function failed(path: string, error: string): never {
  redirect(`${path}?error=${encodeURIComponent(error)}`);
}

const text = (formData: FormData, name: string) => formText(formData.get(name));
const NOT_SIGNED_IN = "You cannot change the website's pages. Please sign in again.";

// ── The list ─────────────────────────────────────────────────────────────────

export async function createPageAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const result = await createPage(await getDb(), viewer, { title: text(formData, "title"), slug: text(formData, "slug") }, new Date());
  if (!result.ok) failed(LIST, result.message);
  done(editorOf(result.id), "Page made. It is a draft: visitors see it once you publish it.");
}

export async function duplicatePageAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const result = await duplicatePage(await getDb(), viewer, text(formData, "id"), new Date());
  if (!result.ok) failed(LIST, result.message);
  done(editorOf(result.id), "Copied. The copy is a draft, at an address of its own.");
}

export async function restorePageAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const result = await restorePage(await getDb(), viewer, text(formData, "id"));
  if (!result.ok) failed(LIST, result.message);
  done(LIST, `Brought back as a draft, at ${result.path}.`);
}

export async function addRedirectAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const result = await addRedirect(await getDb(), viewer, { from: text(formData, "from"), to: text(formData, "to") }, await siteOrigins());
  if (!result.ok) failed(LIST, result.message);
  updateTag(WEBSITE_TAG);
  done(LIST, "Saved. That old address now leads there.");
}

export async function removeRedirectAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const result = await removeRedirect(await getDb(), viewer, text(formData, "from"));
  if (!result.ok) failed(LIST, result.message);
  updateTag(WEBSITE_TAG);
  done(LIST, "Removed. That old address now leads nowhere.");
}

// ── One page: its settings ───────────────────────────────────────────────────

/** Where a page's form goes back to: its editor, or the list once it is gone. */
async function afterChange(id: string, result: PageChangeResult, notice: string, to?: string): Promise<never> {
  if (!result.ok) failed(editorOf(id), result.message);
  updateTag(WEBSITE_TAG);
  done(to ?? editorOf(id), notice);
}

export async function savePageSettingsAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const id = text(formData, "id");
  const result = await savePageSettings(await getDb(), viewer, id, { title: text(formData, "title"), slug: text(formData, "slug") }, await siteOrigins());
  await afterChange(id, result, result.ok ? `Saved. The page's address is ${result.path}.` : "");
}

export async function unpublishPageAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const id = text(formData, "id");
  await afterChange(id, await unpublishPage(await getDb(), viewer, id, new Date()), "Taken off the website. It is kept here as a draft.");
}

export async function deletePageAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(LIST);
  const id = text(formData, "id");
  await afterChange(id, await deletePage(await getDb(), viewer, id, new Date()), "The page is in the trash, below. It can be brought back for 30 days.", LIST);
}

// ── One page: the editor ─────────────────────────────────────────────────────

export async function savePageDraftAction(id: string, content: unknown, basedOn: number, force: boolean): Promise<SavePageResult> {
  const viewer = await getCurrentUser();
  if (!viewer) return { ok: false, reason: "forbidden", message: NOT_SIGNED_IN };
  return savePageDraft(await getDb(), viewer, String(id), content, { basedOn: Number.isInteger(basedOn) ? basedOn : -1, force: force === true, now: new Date() });
}

/** Publish the page's draft, if it is still the revision the editor checked on phones (`basedOn`). */
export async function publishPageAction(id: string, basedOn: number): Promise<PublishPageResult> {
  const viewer = await getCurrentUser();
  if (!viewer) return { ok: false, message: NOT_SIGNED_IN };
  const result = await publishPage(await getDb(), viewer, String(id), new Date(), Number.isInteger(basedOn) ? basedOn : -1);
  if (result.ok) updateTag(WEBSITE_TAG);
  return result;
}

export async function discardPageDraftAction(id: string): Promise<PageChangeResult> {
  const viewer = await getCurrentUser();
  if (!viewer) return { ok: false, message: NOT_SIGNED_IN };
  return discardPageDraft(await getDb(), viewer, String(id));
}

export async function restorePageVersionAction(id: string, versionId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const viewer = await getCurrentUser();
  if (!viewer) return { ok: false, message: NOT_SIGNED_IN };
  return restorePageVersion(await getDb(), viewer, String(id), String(versionId), new Date());
}
