"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { formText } from "@/lib/parse";
import {
  deleteQuestion,
  moveQuestion,
  publishAgreement,
  saveAgreement,
  saveQuestion,
  setAgreementActive,
  setQuestionActive,
  type Applies,
} from "@/server/booking-forms";
import { requireOwner } from "@/server/session";

/** Booking Forms & Agreements' forms (src/server/booking-forms.ts). The owners' only. */

const PAGE = "/admin/forms";
const text = (formData: FormData, name: string) => formText(formData.get(name));
const done = (notice: string, anchor = ""): never => redirect(`${PAGE}?notice=${encodeURIComponent(notice)}${anchor}`);
const failed = (error: string, query = ""): never => redirect(`${PAGE}?error=${encodeURIComponent(error)}${query}`);

/** Whom a question or an agreement applies to, from the form: no studio ticked is every studio. */
function appliesFrom(formData: FormData): Applies {
  return {
    studioIds: formData.getAll("studio").filter((value): value is string => typeof value === "string"),
    forRentals: formData.get("forRentals") === "1",
    forPhotography: formData.get("forPhotography") === "1",
  };
}

export async function saveQuestionAction(formData: FormData): Promise<void> {
  await requireOwner(PAGE);
  const id = text(formData, "id") || null;
  const result = await saveQuestion(await getDb(), id, {
    ...appliesFrom(formData),
    label: text(formData, "label"),
    help: text(formData, "help"),
    kind: text(formData, "kind"),
    options: text(formData, "options").split("\n"),
    required: formData.get("required") === "1",
    startsOn: text(formData, "startsOn"),
    endsOn: text(formData, "endsOn"),
  });
  if (!result.ok) failed(result.message, id ? `&question=${id}#question-form` : "#question-form");
  done(id ? "Question saved." : "Question added. It is a draft: clients are asked it once you publish it.", "#questions");
}

export async function questionAction(formData: FormData): Promise<void> {
  await requireOwner(PAGE);
  const db = await getDb();
  const id = text(formData, "id");
  switch (text(formData, "intent")) {
    case "publish":
      await setQuestionActive(db, id, true);
      return done("Published: clients are asked it from now on.", "#questions");
    case "unpublish":
      await setQuestionActive(db, id, false);
      return done("Taken off: clients are no longer asked it. The answers already given stay on their bookings.", "#questions");
    case "up":
    case "down":
      await moveQuestion(db, id, text(formData, "intent") === "up" ? -1 : 1);
      return done("Moved.", "#questions");
    case "delete":
      await deleteQuestion(db, id);
      return done("Deleted. The answers already given stay on their bookings, with the question as it was.", "#questions");
    default:
      return failed("Choose what to do.");
  }
}

export async function saveAgreementAction(formData: FormData): Promise<void> {
  await requireOwner(PAGE);
  const id = text(formData, "id") || null;
  const result = await saveAgreement(await getDb(), id, { ...appliesFrom(formData), title: text(formData, "title"), draft: text(formData, "draft") });
  if (!result.ok) failed(result.message, id ? `&agreement=${id}#agreement-form` : "#agreement-form");
  done("Saved as a draft. Clients read the version published last until you publish this one.", `&agreement=${result.ok ? result.id : ""}#agreement-form`);
}

export async function agreementAction(formData: FormData): Promise<void> {
  const owner = await requireOwner(PAGE);
  const db = await getDb();
  const id = text(formData, "id");
  switch (text(formData, "intent")) {
    case "publish": {
      const published = await publishAgreement(db, id, owner.email, new Date());
      if (!published.ok) return failed(published.message, "#agreements");
      return done(`Published as version ${published.number}. Clients accept it from now on; those who accepted a version before keep theirs.`, "#agreements");
    }
    case "off":
      await setAgreementActive(db, id, false);
      return done("Taken off: clients no longer accept it. Its versions, and what was accepted, stay.", "#agreements");
    case "on":
      await setAgreementActive(db, id, true);
      return done("Put back: clients accept its published version again.", "#agreements");
    default:
      return failed("Choose what to do.");
  }
}
