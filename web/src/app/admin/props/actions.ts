"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { CATALOG_TAG } from "@/server/cached";
import { setPropAway, setPropPicture, type PropChangeResult } from "@/server/props";
import { requireOwner } from "@/server/session";

/** Back to the prop's card on Props & Resources, with the answer as the page's message. */
function answer(result: PropChangeResult, slug: string): never {
  const anchor = /^[a-z0-9-]{1,80}$/.test(slug) ? `#prop-${slug}` : "";
  redirect(`/admin/props?${result.ok ? "notice" : "error"}=${encodeURIComponent(result.message)}${anchor}`);
}

/** Choose a prop's picture from the media library. `mediaIds` is the chooser's answer: one id. */
export async function setPropPictureAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/props");
  const result = await setPropPicture(await getDb(), viewer, formText(formData.get("addonId")), formText(formData.get("mediaIds")).split(",")[0] ?? "");
  if (result.ok) updateTag(CATALOG_TAG); // the booking page's add-ons carry their pictures
  answer(result, formText(formData.get("slug")));
}

export async function removePropPictureAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/props");
  const result = await setPropPicture(await getDb(), viewer, formText(formData.get("addonId")), "");
  if (result.ok) updateTag(CATALOG_TAG);
  answer(result, formText(formData.get("slug")));
}

/** Mark a prop unavailable from one day to another, both included. */
export async function setPropAwayAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/props");
  const away = { from: formText(formData.get("from")), to: formText(formData.get("to")) || formText(formData.get("from")) };
  answer(await setPropAway(await getDb(), viewer, formText(formData.get("addonId")), away, new Date()), formText(formData.get("slug")));
}

/** A prop that was away can be booked again on every day. */
export async function clearPropAwayAction(formData: FormData): Promise<void> {
  const viewer = await requireOwner("/admin/props");
  answer(await setPropAway(await getDb(), viewer, formText(formData.get("addonId")), null, new Date()), formText(formData.get("slug")));
}
