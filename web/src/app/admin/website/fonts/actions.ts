"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import { WEBSITE_TAG } from "@/server/cached";
import { addFont, deleteFont, removeFontFile } from "@/server/fonts";
import { requireManager } from "@/server/session";

/**
 * What the page of the owners' own fonts asks of the server, apart from a
 * font's files, which go to the upload address beside this file. Each
 * finishes by going back to the page with a short message.
 */
const PAGE = "/admin/website/fonts";

function done(notice: string): never {
  redirect(`${PAGE}?notice=${encodeURIComponent(notice)}`);
}

function failed(error: string): never {
  redirect(`${PAGE}?error=${encodeURIComponent(error)}`);
}

const text = (formData: FormData, name: string) => formText(formData.get(name));

export async function addFontAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(PAGE);
  const result = await addFont(
    await getDb(),
    viewer,
    { name: text(formData, "name"), group: text(formData, "kind"), licence: text(formData, "licence"), holdsLicence: formData.get("holdsLicence") !== null },
    new Date(),
  );
  if (!result.ok) failed(result.message);
  done("Font added. Now add its files: one for each weight you use.");
}

export async function removeFontFileAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(PAGE);
  const result = await removeFontFile(await getDb(), viewer, text(formData, "fileId"));
  if (!result.ok) failed(result.message);
  updateTag(WEBSITE_TAG);
  done("The file was removed.");
}

export async function deleteFontAction(formData: FormData): Promise<void> {
  const viewer = await requireManager(PAGE);
  const result = await deleteFont(await getDb(), viewer, text(formData, "fontId"));
  if (!result.ok) failed(result.message);
  updateTag(WEBSITE_TAG);
  done("The font was deleted.");
}
