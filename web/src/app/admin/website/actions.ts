"use server";

import { updateTag } from "next/cache";
import { getDb } from "@/db/client";
import { can } from "@/lib/abilities";
import { WEBSITE_TAG } from "@/server/cached";
import { websiteCheckPaths } from "@/server/pages";
import { getCurrentUser } from "@/server/session";
import { loadSettings } from "@/server/settings";
import {
  DESIGN_DOC,
  discardDraft,
  FRAME_DOC,
  publishDraft,
  restoreVersion,
  saveDraft,
  type DocumentSpec,
  type PublishResult,
  type RestoreResult,
  type SaveDraftResult,
} from "@/server/website";

/**
 * What the website's editors ask of the server. Unlike the admin's forms,
 * these are called from the editor while the person keeps working, so each
 * answers with a result and never redirects. Every one of them looks the
 * viewer up itself, and the service it calls checks what that viewer may do:
 * a server action can be called by anyone who knows its name.
 */

const DOCUMENTS = { design: DESIGN_DOC, frame: FRAME_DOC } as const;
export type DocumentKind = keyof typeof DOCUMENTS;

const specOf = (kind: unknown): DocumentSpec<unknown> | null =>
  kind === "design" || kind === "frame" ? (DOCUMENTS[kind] as DocumentSpec<unknown>) : null;

const NOT_ALLOWED = "You cannot change the website. Please sign in again.";

/** Store the editor's content as the draft. Nothing changes for visitors. */
export async function saveDraftAction(kind: DocumentKind, content: unknown, basedOn: number, force: boolean): Promise<SaveDraftResult<unknown>> {
  const [user, spec] = [await getCurrentUser(), specOf(kind)];
  if (!user || !spec) return { ok: false, reason: "forbidden", message: NOT_ALLOWED };
  return saveDraft(await getDb(), user, spec, content, {
    basedOn: Number.isInteger(basedOn) ? basedOn : -1,
    force: force === true,
    now: new Date(),
  });
}

/**
 * Make the draft public, if it is still the revision the editor checked
 * (`basedOn`). The cached pages are refreshed, so visitors see it at their
 * next page.
 */
export async function publishAction(kind: DocumentKind, basedOn: number): Promise<PublishResult> {
  const [user, spec] = [await getCurrentUser(), specOf(kind)];
  if (!user || !spec) return { ok: false, message: NOT_ALLOWED };
  const result = await publishDraft(await getDb(), user, spec, new Date(), Number.isInteger(basedOn) ? basedOn : -1);
  if (result.ok) updateTag(WEBSITE_TAG);
  return result;
}

/** Throw the draft away. */
export async function discardAction(kind: DocumentKind): Promise<{ ok: true } | { ok: false; message: string }> {
  const [user, spec] = [await getCurrentUser(), specOf(kind)];
  if (!user || !spec) return { ok: false, message: NOT_ALLOWED };
  return discardDraft(await getDb(), user, spec);
}

/** Bring an earlier version back as the draft, to look at and then publish or discard. */
export async function restoreVersionAction(kind: DocumentKind, versionId: string): Promise<RestoreResult> {
  const [user, spec] = [await getCurrentUser(), specOf(kind)];
  if (!user || !spec) return { ok: false, message: NOT_ALLOWED };
  return restoreVersion(await getDb(), user, spec, String(versionId), new Date());
}

/**
 * The pages a change of the design, or of the header, menu and footer, is
 * measured on before it is published: every published page as they are now,
 * the booking screens and the account (`websiteCheckPaths`). Asked for at
 * the moment of publishing, so that a page published meanwhile is measured.
 */
export async function checkPathsAction(kind: DocumentKind): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const [user, spec] = [await getCurrentUser(), specOf(kind)];
  if (!user || !spec) return { ok: false, message: NOT_ALLOWED };
  const db = await getDb();
  if (!can(user, spec.ability, await loadSettings(db))) return { ok: false, message: NOT_ALLOWED };
  return { ok: true, paths: await websiteCheckPaths(db) };
}
