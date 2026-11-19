import { and, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { emailTemplates } from "@/db/schema";
import {
  EMAIL_TEMPLATES,
  isTemplateKey,
  TEMPLATE_KEYS,
  templateProblems,
  tidyTemplate,
  type EmailTemplateSpec,
  type TemplateKey,
} from "@/lib/email-templates";

/**
 * The owners' wording of the emails to clients (question 33 of 2026-11-16, answered 2026-11-17): Admin → Emails. An
 * email is sent in the site's wording (`EMAIL_TEMPLATES`) until an owner changes it, and in theirs from then on;
 * `queueEmail` puts it in. Only owners change them, as they do the settings and the prices: the emails state the
 * studio's terms and what clients pay.
 */

type Wording = { subject: string; body: string };
type Row = typeof emailTemplates.$inferSelect;

/**
 * The owners' wording of this email when the site can send it. None when they have not changed it, and none when what
 * they saved no longer passes the checks: a part it names was taken away, or a part it must keep was added since. The
 * site's wording is sent then, and the admin says why.
 */
export async function ownersWording(db: DbLike, key: TemplateKey): Promise<Wording | null> {
  const [row] = await db.select({ subject: emailTemplates.subject, body: emailTemplates.body }).from(emailTemplates).where(eq(emailTemplates.key, key));
  if (!row || row.subject === null || row.body === null) return null;
  const wording = { subject: row.subject, body: row.body };
  return templateProblems(EMAIL_TEMPLATES[key], wording).length === 0 ? wording : null;
}

export interface TemplateState {
  spec: EmailTemplateSpec;
  /** What the editor opens with: the owners' wording when they have changed the email, otherwise the site's. */
  subject: string;
  body: string;
  /** Whose wording is sent. `unusable`: the owners' is saved but cannot be sent (`problems`), so the site's is. */
  wording: "site" | "owners" | "unusable";
  problems: string[];
  /** What a save sends back, 0 before the first: a save made over someone else's is refused. */
  revision: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

function stateOf(spec: EmailTemplateSpec, row: Row | undefined): TemplateState {
  const own = row && row.subject !== null && row.body !== null ? { subject: row.subject, body: row.body } : null;
  const problems = own ? templateProblems(spec, own) : [];
  return {
    spec,
    ...(own ?? { subject: spec.subject, body: spec.body }),
    wording: !own ? "site" : problems.length > 0 ? "unusable" : "owners",
    problems,
    revision: row?.revision ?? 0,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Every email to clients, in the admin's order, with whose wording it is sent in. */
export async function listEmailTemplates(db: DbLike): Promise<TemplateState[]> {
  const rows = new Map((await db.select().from(emailTemplates)).map((row) => [row.key, row]));
  return TEMPLATE_KEYS.map((key) => stateOf(EMAIL_TEMPLATES[key], rows.get(key)));
}

export async function getEmailTemplate(db: DbLike, key: string): Promise<TemplateState | null> {
  if (!isTemplateKey(key)) return null;
  const [row] = await db.select().from(emailTemplates).where(eq(emailTemplates.key, key));
  return stateOf(EMAIL_TEMPLATES[key], row);
}

export type SaveTemplateResult =
  | { ok: true; revision: number; wording: "site" | "owners"; subject: string; body: string }
  | { ok: false; code: "forbidden" | "not_found" | "invalid" | "changed"; message: string };

export const TEMPLATE_CHANGED =
  "Not saved: someone else saved this email after you opened it. Copy what you wrote if you want to keep it, then open the email again to see theirs.";

/**
 * Save the owners' wording of an email; with `wording` null, go back to the site's. Wording that is the site's, word
 * for word, is kept as the site's, so that a later change to the site's wording reaches the email. `revision` is the
 * one the editor was opened with: when someone else has saved since, nothing is saved.
 */
export async function saveEmailTemplate(
  db: DbLike,
  viewer: { email: string; role: string },
  key: string,
  wording: Wording | null,
  revision: number,
  now: Date,
): Promise<SaveTemplateResult> {
  if (viewer.role !== "owner") return { ok: false, code: "forbidden", message: "Only an owner can change the emails." };
  if (!isTemplateKey(key)) return { ok: false, code: "not_found", message: "There is no such email." };
  const spec = EMAIL_TEMPLATES[key];
  const tidy = wording ? tidyTemplate(wording) : null;
  const problems = tidy ? templateProblems(spec, tidy) : [];
  if (problems.length > 0) return { ok: false, code: "invalid", message: `Not saved. ${problems.join(" ")}` };

  const own = tidy && (tidy.subject !== spec.subject || tidy.body !== spec.body) ? tidy : null;
  const values = { subject: own?.subject ?? null, body: own?.body ?? null, updatedBy: viewer.email, updatedAt: now };
  const saved =
    revision === 0
      ? await db
          .insert(emailTemplates)
          .values({ key, ...values, revision: 1 })
          .onConflictDoNothing()
          .returning({ revision: emailTemplates.revision })
      : await db
          .update(emailTemplates)
          .set({ ...values, revision: sql`${emailTemplates.revision} + 1` })
          .where(and(eq(emailTemplates.key, key), eq(emailTemplates.revision, revision)))
          .returning({ revision: emailTemplates.revision });
  if (saved.length === 0) return { ok: false, code: "changed", message: TEMPLATE_CHANGED };
  return { ok: true, revision: saved[0].revision, wording: own ? "owners" : "site", ...(own ?? { subject: spec.subject, body: spec.body }) };
}
