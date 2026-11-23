import { and, asc, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { agreements, agreementVersions, bookingAcceptances, bookingAnswers, intakeQuestions, siteDocuments, siteVersions, studios } from "@/db/schema";
import { agreementKey, policiesKey, type QuestionKind } from "@/lib/booking-form-keys";
import { isIsoDate, type IsoDate } from "@/lib/domain/time";

/**
 * Booking Forms & Agreements (the owner's brief of 2026-11-22, items 6 and 7, and the admin brief's item 8): the
 * intake questions and the agreements a client meets at checkout, which the owners write and change themselves, and
 * the record of both on each booking. The studio policies are the website's Policies page, edited in the page editor
 * with its drafts, preview, publishing and history; the other agreements (a waiver, a photography agreement) have
 * texts and versions of their own here. What the builder read into the briefs is question 66 in ProjectLibrary.md.
 */

export const QUESTION_KINDS: Record<QuestionKind, string> = {
  text: "Text",
  checkbox: "Tick box",
  dropdown: "Dropdown",
  choice: "Multiple choice",
};
const isKind = (value: string): value is QuestionKind => Object.hasOwn(QUESTION_KINDS, value);

const LABEL_MAX = 200;
const HELP_MAX = 500;
const OPTION_MAX = 120;
const OPTIONS_MAX = 20;
const ANSWER_MAX = 1000;
const TITLE_MAX = 120;
const BODY_MAX = 20000;

/** What a booking is, for the questions and agreements that apply to it. */
export interface FormContext {
  studioIds: string[];
  photography: boolean;
  date: IsoDate;
}

/** To whom a question or an agreement applies. */
export interface Applies {
  /** Empty: every studio. Otherwise a booking that holds any one of them, in a bundle too. */
  studioIds: string[];
  forRentals: boolean;
  forPhotography: boolean;
}

/** Whether a question or an agreement applies to a booking: its studios, its type, and for a question its days. */
export function appliesTo(item: Applies & { startsOn?: string | null; endsOn?: string | null }, context: FormContext): boolean {
  if (context.photography ? !item.forPhotography : !item.forRentals) return false;
  if (item.studioIds.length > 0 && !context.studioIds.some((id) => item.studioIds.includes(id))) return false;
  if (item.startsOn && context.date < item.startsOn) return false;
  if (item.endsOn && context.date > item.endsOn) return false;
  return true;
}

export interface QuestionView extends Applies {
  id: string;
  label: string;
  help: string;
  kind: QuestionKind;
  options: string[];
  required: boolean;
  /** Shown to clients. Off while the owners are still writing it. */
  active: boolean;
  startsOn: IsoDate | null;
  endsOn: IsoDate | null;
}

/** The agreement as a client reads it: its published version. */
export interface AgreementShown {
  agreementId: string;
  versionId: string;
  number: number;
  title: string;
  body: string;
}

/** The website's Policies page as published: the version a client accepts. */
export interface PoliciesVersion {
  versionId: string;
  number: number;
  title: string;
  /** The page's address, without its slash. */
  slug: string;
  documentId: string;
  publishedAt: Date;
}


const questionView = (row: typeof intakeQuestions.$inferSelect): QuestionView => ({
  id: row.id,
  label: row.label,
  help: row.help,
  kind: row.kind,
  options: row.options,
  required: row.required,
  active: row.active,
  studioIds: row.studioIds,
  forRentals: row.forRentals,
  forPhotography: row.forPhotography,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
});

/** Every question, in the owners' order. */
export async function listQuestions(db: DbLike): Promise<QuestionView[]> {
  const rows = await db.select().from(intakeQuestions).orderBy(asc(intakeQuestions.sortOrder), asc(intakeQuestions.createdAt));
  return rows.map(questionView);
}

/** The Policies page's newest published version, or null when the site has none. */
export async function currentPolicies(db: DbLike): Promise<PoliciesVersion | null> {
  const [row] = await db
    .select({ versionId: siteVersions.id, number: siteVersions.number, title: siteDocuments.title, slug: siteDocuments.slug, documentId: siteDocuments.id, publishedAt: siteVersions.createdAt })
    .from(siteVersions)
    .innerJoin(siteDocuments, eq(siteDocuments.id, siteVersions.documentId))
    .where(and(eq(siteDocuments.builtIn, "policies"), isNull(siteDocuments.deletedAt), isNotNull(siteDocuments.published)))
    .orderBy(desc(siteVersions.number))
    .limit(1);
  return row ?? null;
}

/** Every agreement that is on and has a published version, as clients read it, in the owners' order. */
async function publishedAgreements(db: DbLike): Promise<(AgreementShown & Applies)[]> {
  const rows = await db.select().from(agreements).where(eq(agreements.active, true)).orderBy(asc(agreements.sortOrder), asc(agreements.createdAt));
  if (rows.length === 0) return [];
  const versions = await db
    .select()
    .from(agreementVersions)
    .where(inArray(agreementVersions.agreementId, rows.map((row) => row.id)))
    .orderBy(desc(agreementVersions.number));
  return rows.flatMap((row) => {
    const latest = versions.find((version) => version.agreementId === row.id);
    return latest
      ? [{ agreementId: row.id, versionId: latest.id, number: latest.number, title: latest.title, body: latest.body, studioIds: row.studioIds, forRentals: row.forRentals, forPhotography: row.forPhotography }]
      : [];
  });
}

export interface CheckoutForms {
  /** The questions this booking is asked, published ones only. */
  questions: QuestionView[];
  /** The agreements beside the policies that apply to it, as published. */
  agreements: AgreementShown[];
}

/** What a booking of these studios, of this type, on this day, is asked and must accept beside the studio policies. */
export async function checkoutForms(db: DbLike, context: FormContext): Promise<CheckoutForms> {
  const [questions, shown] = await Promise.all([listQuestions(db), publishedAgreements(db)]);
  return {
    questions: questions.filter((question) => question.active && appliesTo(question, context)),
    agreements: shown.filter((agreement) => appliesTo(agreement, context)).map(({ agreementId, versionId, number, title, body }) => ({ agreementId, versionId, number, title, body })),
  };
}

// ── At checkout ──────────────────────────────────────────────────────────────

export type FormsProblem = { code: "policies_changed"; message: string } | { code: "answers"; message: string };

export interface CheckedForms {
  acceptances: { kind: "policies_page" | "agreement"; title: string; siteVersionId: string | null; agreementVersionId: string | null; versionNumber: number }[];
  answers: { questionId: string; label: string; answer: string; sortOrder: number }[];
}

/**
 * Check what a client sent with a booking: every version they must accept, accepted (`accepted`, the keys of the
 * versions they were shown), and every question that applies answered as it allows. A version published since they
 * read it, or a question added, sends them back to read again. Answers to questions that do not apply are left out.
 */
export async function checkForms(
  db: DbLike,
  context: FormContext,
  sent: { accepted: string[]; answers: Record<string, unknown> },
): Promise<{ ok: true; forms: CheckedForms } | { ok: false; problem: FormsProblem }> {
  const [forms, policies] = await Promise.all([checkoutForms(db, context), currentPolicies(db)]);
  const accepted = new Set(sent.accepted);
  const changed = { ok: false as const, problem: { code: "policies_changed" as const, message: "The studio's policies or booking forms changed while you were booking. Please read them again and confirm." } };
  if (policies && !accepted.has(policiesKey(policies.versionId))) return changed;
  if (forms.agreements.some((agreement) => !accepted.has(agreementKey(agreement.versionId)))) return changed;

  const answers: CheckedForms["answers"] = [];
  for (const [index, question] of forms.questions.entries()) {
    const raw = sent.answers[question.id];
    const answer =
      question.kind === "checkbox"
        ? raw === true || raw === "yes"
          ? "Yes"
          : ""
        : typeof raw === "string"
          ? raw.replace(/\r\n?/g, "\n").trim().slice(0, ANSWER_MAX)
          : "";
    if (answer === "") {
      if (question.required) return { ok: false, problem: { code: "answers", message: `Please answer: ${question.label}` } };
      continue;
    }
    if ((question.kind === "dropdown" || question.kind === "choice") && !question.options.includes(answer)) {
      return { ok: false, problem: { code: "answers", message: `Please choose one of the answers offered: ${question.label}` } };
    }
    answers.push({ questionId: question.id, label: question.label, answer, sortOrder: index });
  }
  return {
    ok: true,
    forms: {
      acceptances: [
        ...(policies ? [{ kind: "policies_page" as const, title: policies.title, siteVersionId: policies.versionId, agreementVersionId: null, versionNumber: policies.number }] : []),
        ...forms.agreements.map((agreement) => ({ kind: "agreement" as const, title: agreement.title, siteVersionId: null, agreementVersionId: agreement.versionId, versionNumber: agreement.number })),
      ],
      answers,
    },
  };
}

/** Keep what was accepted and answered with a booking, inside the transaction that makes it. */
export async function recordForms(tx: DbLike, bookingId: string, forms: CheckedForms, acceptedAt: Date): Promise<void> {
  if (forms.acceptances.length > 0) {
    await tx.insert(bookingAcceptances).values(forms.acceptances.map((acceptance) => ({ ...acceptance, bookingId, acceptedAt })));
  }
  if (forms.answers.length > 0) await tx.insert(bookingAnswers).values(forms.answers.map((answer) => ({ ...answer, bookingId })));
}

export interface BookingForms {
  answers: { label: string; answer: string }[];
  acceptances: { kind: "policies_page" | "agreement"; title: string; versionNumber: number; acceptedAt: string; siteVersionId: string | null; agreementVersionId: string | null }[];
}

/** What a booking's client accepted and answered at checkout, for the appointment's page and pop-up. */
export async function formsOfBooking(db: DbLike, bookingId: string): Promise<BookingForms> {
  const [answers, acceptances] = await Promise.all([
    db.select().from(bookingAnswers).where(eq(bookingAnswers.bookingId, bookingId)).orderBy(asc(bookingAnswers.sortOrder)),
    db.select().from(bookingAcceptances).where(eq(bookingAcceptances.bookingId, bookingId)).orderBy(asc(bookingAcceptances.acceptedAt)),
  ]);
  return {
    answers: answers.map((row) => ({ label: row.label, answer: row.answer })),
    acceptances: acceptances.map((row) => ({
      kind: row.kind,
      title: row.title,
      versionNumber: row.versionNumber,
      acceptedAt: row.acceptedAt.toISOString(),
      siteVersionId: row.siteVersionId,
      agreementVersionId: row.agreementVersionId,
    })),
  };
}

// ── The owners' questions ────────────────────────────────────────────────────

export interface QuestionInput extends Applies {
  label: string;
  help: string;
  kind: string;
  options: string[];
  required: boolean;
  startsOn: string;
  endsOn: string;
}

export type SaveResult = { ok: true; id: string } | { ok: false; message: string };

async function checkApplies(db: DbLike, applies: Applies): Promise<string | null> {
  if (!applies.forRentals && !applies.forPhotography) return "Choose rentals, photography sessions or both.";
  const ids = [...new Set(applies.studioIds)];
  if (ids.length > 0 && (await db.select({ id: studios.id }).from(studios).where(inArray(studios.id, ids))).length !== ids.length) return "Unknown studio.";
  return null;
}

/** A question as the owners wrote it, checked: its words, its kind, its choices, its days. */
async function checkedQuestion(db: DbLike, input: QuestionInput): Promise<Omit<typeof intakeQuestions.$inferInsert, "id"> | string> {
  const label = input.label.trim();
  if (label.length < 2 || label.length > LABEL_MAX) return `Write the question in 2 to ${LABEL_MAX} characters.`;
  if (!isKind(input.kind)) return "Choose the kind of question.";
  const options = [...new Set(input.options.map((option) => option.trim()).filter(Boolean))];
  if ((input.kind === "dropdown" || input.kind === "choice") && options.length < 2) return "Give at least two answers to choose from, one on each line.";
  if (options.length > OPTIONS_MAX || options.some((option) => option.length > OPTION_MAX)) return `At most ${OPTIONS_MAX} answers, each up to ${OPTION_MAX} characters.`;
  const startsOn = input.startsOn.trim() || null;
  const endsOn = input.endsOn.trim() || null;
  if ((startsOn && !isIsoDate(startsOn)) || (endsOn && !isIsoDate(endsOn))) return "Choose valid days.";
  if (startsOn && endsOn && endsOn < startsOn) return "The last day must be on or after the first.";
  const applies = await checkApplies(db, input);
  if (applies) return applies;
  return {
    label,
    help: input.help.trim().slice(0, HELP_MAX),
    kind: input.kind,
    options: input.kind === "dropdown" || input.kind === "choice" ? options : [],
    required: input.required,
    studioIds: [...new Set(input.studioIds)],
    forRentals: input.forRentals,
    forPhotography: input.forPhotography,
    startsOn,
    endsOn,
  };
}

/** Add a question, off until published, at the end of the form; or change one, as it stands. */
export async function saveQuestion(db: DbLike, id: string | null, input: QuestionInput): Promise<SaveResult> {
  const values = await checkedQuestion(db, input);
  if (typeof values === "string") return { ok: false, message: values };
  if (id) {
    const changed = await db.update(intakeQuestions).set(values).where(eq(intakeQuestions.id, id)).returning({ id: intakeQuestions.id });
    return changed.length > 0 ? { ok: true, id } : { ok: false, message: "That question was deleted meanwhile." };
  }
  const [last] = await db.select({ order: max(intakeQuestions.sortOrder) }).from(intakeQuestions);
  const [row] = await db
    .insert(intakeQuestions)
    .values({ ...values, active: false, sortOrder: (last?.order ?? 0) + 1 })
    .returning({ id: intakeQuestions.id });
  return { ok: true, id: row.id };
}

/** Publish a question (clients are asked it) or take it off. */
export async function setQuestionActive(db: DbLike, id: string, active: boolean): Promise<boolean> {
  return (await db.update(intakeQuestions).set({ active }).where(eq(intakeQuestions.id, id)).returning({ id: intakeQuestions.id })).length > 0;
}

/** Move a question one place up or down the form. */
export async function moveQuestion(db: DbLike, id: string, by: -1 | 1): Promise<boolean> {
  const all = await listQuestions(db);
  const at = all.findIndex((question) => question.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= all.length) return false;
  const order = all.map((question) => question.id);
  [order[at], order[to]] = [order[to], order[at]];
  for (const [index, questionId] of order.entries()) await db.update(intakeQuestions).set({ sortOrder: index + 1 }).where(eq(intakeQuestions.id, questionId));
  return true;
}

/** Delete a question. The answers given to it stay on their bookings, with its words. */
export async function deleteQuestion(db: DbLike, id: string): Promise<boolean> {
  return (await db.delete(intakeQuestions).where(eq(intakeQuestions.id, id)).returning({ id: intakeQuestions.id })).length > 0;
}

// ── The owners' agreements ───────────────────────────────────────────────────

export interface AgreementInput extends Applies {
  title: string;
  draft: string;
}

export interface AgreementView extends Applies {
  id: string;
  title: string;
  draft: string;
  active: boolean;
  /** Its versions, the newest first. */
  versions: { id: string; number: number; title: string; body: string; publishedAt: string; publishedBy: string }[];
}

/** Every agreement with its versions, in the owners' order. */
export async function listAgreements(db: DbLike): Promise<AgreementView[]> {
  const rows = await db.select().from(agreements).orderBy(asc(agreements.sortOrder), asc(agreements.createdAt));
  if (rows.length === 0) return [];
  const versions = await db
    .select()
    .from(agreementVersions)
    .where(inArray(agreementVersions.agreementId, rows.map((row) => row.id)))
    .orderBy(desc(agreementVersions.number));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    draft: row.draft,
    active: row.active,
    studioIds: row.studioIds,
    forRentals: row.forRentals,
    forPhotography: row.forPhotography,
    versions: versions
      .filter((version) => version.agreementId === row.id)
      .map((version) => ({ id: version.id, number: version.number, title: version.title, body: version.body, publishedAt: version.publishedAt.toISOString(), publishedBy: version.publishedBy })),
  }));
}

/** Add an agreement, or change one's title, draft and whom it applies to. Clients read only what is published. */
export async function saveAgreement(db: DbLike, id: string | null, input: AgreementInput): Promise<SaveResult> {
  const title = input.title.trim();
  if (title.length < 2 || title.length > TITLE_MAX) return { ok: false, message: `Give it a title of 2 to ${TITLE_MAX} characters.` };
  const draft = input.draft.replace(/\r\n?/g, "\n").trim();
  if (draft.length > BODY_MAX) return { ok: false, message: `The text can be at most ${BODY_MAX} characters.` };
  const applies = await checkApplies(db, input);
  if (applies) return { ok: false, message: applies };
  const values = { title, draft, studioIds: [...new Set(input.studioIds)], forRentals: input.forRentals, forPhotography: input.forPhotography };
  if (id) {
    const changed = await db.update(agreements).set(values).where(eq(agreements.id, id)).returning({ id: agreements.id });
    return changed.length > 0 ? { ok: true, id } : { ok: false, message: "That agreement is gone." };
  }
  const [last] = await db.select({ order: max(agreements.sortOrder) }).from(agreements);
  const [row] = await db.insert(agreements).values({ ...values, sortOrder: (last?.order ?? 0) + 1 }).returning({ id: agreements.id });
  return { ok: true, id: row.id };
}

/** Publish an agreement's draft as its next version: from then on clients accept that one. The ones before stay. */
export async function publishAgreement(db: DbLike, id: string, by: string, now: Date): Promise<{ ok: true; number: number } | { ok: false; message: string }> {
  const [row] = await db.select().from(agreements).where(eq(agreements.id, id)).limit(1);
  if (!row) return { ok: false, message: "That agreement is gone." };
  if (row.draft.trim() === "") return { ok: false, message: "Write the agreement's text before publishing it." };
  const [latest] = await db.select().from(agreementVersions).where(eq(agreementVersions.agreementId, id)).orderBy(desc(agreementVersions.number)).limit(1);
  if (latest && latest.body === row.draft && latest.title === row.title) return { ok: false, message: "Nothing changed since the version published last." };
  const number = (latest?.number ?? 0) + 1;
  await db.insert(agreementVersions).values({ agreementId: id, number, title: row.title, body: row.draft, publishedBy: by, publishedAt: now });
  return { ok: true, number };
}

/** Take an agreement off (clients no longer accept it) or put it back. Its versions, and what was accepted, stay. */
export async function setAgreementActive(db: DbLike, id: string, active: boolean): Promise<boolean> {
  return (await db.update(agreements).set({ active }).where(eq(agreements.id, id)).returning({ id: agreements.id })).length > 0;
}

/** One published version of an agreement, to read again. */
export async function agreementVersion(db: DbLike, versionId: string): Promise<{ title: string; number: number; body: string; publishedAt: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return null;
  const [row] = await db.select().from(agreementVersions).where(eq(agreementVersions.id, versionId)).limit(1);
  return row ? { title: row.title, number: row.number, body: row.body, publishedAt: row.publishedAt.toISOString() } : null;
}
