"use server";

import { updateTag } from "next/cache";
import { getDb } from "@/db/client";
import { WEBSITE_TAG } from "@/server/cached";
import { getCurrentUser } from "@/server/session";
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

/** Make the draft public. The cached pages are refreshed, so visitors see it at their next page. */
export async function publishAction(kind: DocumentKind): Promise<PublishResult> {
  const [user, spec] = [await getCurrentUser(), specOf(kind)];
  if (!user || !spec) return { ok: false, message: NOT_ALLOWED };
  const result = await publishDraft(await getDb(), user, spec, new Date());
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
