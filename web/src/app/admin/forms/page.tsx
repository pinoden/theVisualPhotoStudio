import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { shortStudioName } from "@/lib/domain/appointment-look";
import { isIsoDate, longDateLabel } from "@/lib/domain/time";
import { appliesTo, currentPolicies, listAgreements, listQuestions, QUESTION_KINDS, type Applies, type QuestionView } from "@/server/booking-forms";
import { loadCatalog, type CatalogStudio } from "@/server/catalog";
import { requireOwner } from "@/server/session";
import { formatInstant, localDateOf } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../frame";
import { agreementAction, questionAction, saveAgreementAction, saveQuestionAction } from "./actions";

export const metadata: Metadata = { title: "Booking Forms & Agreements", robots: { index: false } };

export default function FormsPage(props: PageProps<"/admin/forms">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Forms searchParams={props.searchParams} />
    </Suspense>
  );
}

/** "Every studio · Rentals and photography · Dec 1, 2026 – Jan 2, 2027". */
function appliesText(item: Applies & { startsOn?: string | null; endsOn?: string | null }, studios: CatalogStudio[]): string {
  const where = item.studioIds.length === 0 ? "Every studio" : studios.filter((studio) => item.studioIds.includes(studio.id)).map((studio) => shortStudioName(studio.name)).join(", ");
  const what = item.forRentals && item.forPhotography ? "Rentals and photography" : item.forRentals ? "Rentals" : "Photography sessions";
  const day = (date: string) => longDateLabel(date).replace(/^\w+, /, "");
  const when = item.startsOn || item.endsOn ? ` · ${item.startsOn ? day(item.startsOn) : "Until"}${item.endsOn ? ` – ${day(item.endsOn)}` : " on"}` : "";
  return `${where} · ${what}${when}`;
}

/** The studios and types a question or an agreement applies to, as boxes to tick. */
function AppliesFields({ item, studios, prefix }: { item: Applies | null; studios: CatalogStudio[]; prefix: string }) {
  return (
    <>
      <fieldset className="admin-fieldset">
        <legend className="form-label">Studios</legend>
        {studios.map((studio) => (
          <label key={studio.id} className="avail-check">
            <input type="checkbox" name="studio" value={studio.id} defaultChecked={item?.studioIds.includes(studio.id) ?? false} /> {studio.name}
          </label>
        ))}
        <p className="avail-hint">None ticked: every studio. A bundle with one of those ticked counts.</p>
      </fieldset>
      <fieldset className="admin-fieldset">
        <legend className="form-label">Bookings</legend>
        <label className="avail-check">
          <input type="checkbox" name="forRentals" value="1" id={`${prefix}-rentals`} defaultChecked={item?.forRentals ?? true} /> Studio rentals
        </label>
        <label className="avail-check">
          <input type="checkbox" name="forPhotography" value="1" id={`${prefix}-photography`} defaultChecked={item?.forPhotography ?? true} /> Photography sessions
        </label>
      </fieldset>
    </>
  );
}

/** A question as a client sees it, for the preview: nothing in it can be sent. */
function QuestionPreview({ question }: { question: QuestionView }) {
  const label = `${question.label}${question.required ? " *" : ""}${question.active ? "" : " (draft)"}`;
  return (
    <div className="form-group forms-preview-question">
      {question.kind === "checkbox" ? (
        <label className="intake-check">
          <input type="checkbox" disabled /> <span>{label}</span>
        </label>
      ) : (
        <>
          <span className="form-label">{label}</span>
          {question.kind === "dropdown" && (
            <select className="form-control" disabled aria-label={question.label}>
              <option>Choose…</option>
              {question.options.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          )}
          {question.kind === "choice" &&
            question.options.map((option) => (
              <label key={option} className="intake-option">
                <input type="radio" disabled /> {option}
              </label>
            ))}
          {question.kind === "text" && <textarea className="form-control" rows={2} disabled aria-label={question.label} />}
        </>
      )}
      {question.help && <span className="intake-help">{question.help}</span>}
    </div>
  );
}

/**
 * Booking Forms & Agreements (the owner's brief of 2026-11-22, item 7): the intake questions and the agreements a
 * client meets at checkout, changed by the owners themselves, with no deployment. The studio policies are the
 * website's Policies page, which the page editor changes, previews and publishes.
 */
async function Forms({ searchParams }: Pick<PageProps<"/admin/forms">, "searchParams">) {
  await connection();
  await requireOwner("/admin/forms");
  const db = await getDb();
  const query = await searchParams;
  const [catalog, questions, agreementsList, policies] = await Promise.all([loadCatalog(db), listQuestions(db), listAgreements(db), currentPolicies(db)]);
  const editingQuestion = typeof query.question === "string" ? (questions.find((question) => question.id === query.question) ?? null) : null;
  const editingAgreement = typeof query.agreement === "string" ? (agreementsList.find((agreement) => agreement.id === query.agreement) ?? null) : null;

  // The preview: the form as a booking of this studio, this type and this day would be asked it, drafts included.
  const today = localDateOf(new Date());
  const previewStudio = typeof query.previewStudio === "string" && catalog.studios.some((studio) => studio.id === query.previewStudio) ? query.previewStudio : (catalog.studios[0]?.id ?? "");
  const previewDate = typeof query.previewDate === "string" && isIsoDate(query.previewDate) ? query.previewDate : today;
  const previewPhotography = query.previewType === "photography";
  const context = { studioIds: [previewStudio], photography: previewPhotography, date: previewDate };
  const previewed = questions.filter((question) => appliesTo(question, context));
  const previewedAgreements = agreementsList.filter((agreement) => agreement.active && appliesTo(agreement, context));

  return (
    <AdminFrame active="/admin/forms" title="Booking Forms & Agreements" query={query}>
      <div className="admin-card">
        <h3>Studio policies</h3>
        {policies ? (
          <p style={{ fontSize: ".9rem" }}>
            At checkout every client reads the website&rsquo;s {policies.title} page to its end and agrees to it: version {policies.number}, published{" "}
            {formatInstant(policies.publishedAt)}. Each booking keeps the version its client accepted. Change it in the page editor, with its preview and
            history: <Link href={`/admin/website/pages/${policies.documentId}`}>edit the {policies.title} page</Link>.
          </p>
        ) : (
          <p>No Policies page is published: clients accept only the agreements below.</p>
        )}
      </div>

      <div className="admin-card" id="questions">
        <h3>Intake questions</h3>
        <p style={{ fontSize: ".875rem" }}>
          Asked at checkout, on the policies step, of the bookings each applies to. A new question is a draft until you publish it: preview it below first.
        </p>
        {questions.length === 0 ? (
          <p>No questions yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Kind</th>
                  <th>Asked of</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {questions.map((question, index) => (
                  <tr key={question.id}>
                    <td>
                      {question.label}
                      {question.required && " *"}
                    </td>
                    <td>{QUESTION_KINDS[question.kind]}</td>
                    <td>{appliesText(question, catalog.studios)}</td>
                    <td>{question.active ? "Published" : "Draft"}</td>
                    <td>
                      <form action={questionAction} className="forms-row-actions">
                        <input type="hidden" name="id" value={question.id} />
                        <Link href={`/admin/forms?question=${question.id}#question-form`} className="btn btn-outline btn-small">
                          Edit
                        </Link>
                        <button type="submit" name="intent" value="up" className="btn btn-outline btn-small" disabled={index === 0} aria-label={`Move up: ${question.label}`}>
                          ↑
                        </button>
                        <button type="submit" name="intent" value="down" className="btn btn-outline btn-small" disabled={index === questions.length - 1} aria-label={`Move down: ${question.label}`}>
                          ↓
                        </button>
                        <button type="submit" name="intent" value={question.active ? "unpublish" : "publish"} className="btn btn-outline btn-small">
                          {question.active ? "Take off" : "Publish"}
                        </button>
                        <button type="submit" name="intent" value="delete" className="btn btn-outline btn-small">
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* A form of its own for each question changed: one already on screen keeps what its fields held, not their new defaults. */}
      <form action={saveQuestionAction} className="admin-card" id="question-form" key={`question-${editingQuestion?.id ?? "new"}`}>
        <h3>{editingQuestion ? "Change this question" : "Add a question"}</h3>
        {editingQuestion && <input type="hidden" name="id" value={editingQuestion.id} />}
        <div className="admin-form-row">
          <div className="form-group" style={{ flex: "2 1 18rem" }}>
            <label className="form-label" htmlFor="question-label">
              Question
            </label>
            <input id="question-label" name="label" className="form-control" maxLength={200} defaultValue={editingQuestion?.label ?? ""} required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="question-kind">
              Kind
            </label>
            <select id="question-kind" name="kind" className="form-control" defaultValue={editingQuestion?.kind ?? "text"}>
              {Object.entries(QUESTION_KINDS).map(([kind, name]) => (
                <option key={kind} value={kind}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="question-help">
            Help under it (optional)
          </label>
          <input id="question-help" name="help" className="form-control" maxLength={500} defaultValue={editingQuestion?.help ?? ""} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="question-options">
            Answers to choose from
          </label>
          <textarea id="question-options" name="options" className="form-control" rows={3} defaultValue={editingQuestion?.options.join("\n") ?? ""} />
          <p className="avail-hint">For a dropdown or multiple choice: one answer on each line.</p>
        </div>
        <label className="avail-check">
          <input type="checkbox" name="required" value="1" defaultChecked={editingQuestion?.required ?? false} /> Required
        </label>
        <AppliesFields item={editingQuestion} studios={catalog.studios} prefix="question" />
        <div className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="question-starts">
              From (optional)
            </label>
            <input id="question-starts" name="startsOn" type="date" className="form-control" defaultValue={editingQuestion?.startsOn ?? ""} />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="question-ends">
              Until (optional)
            </label>
            <input id="question-ends" name="endsOn" type="date" className="form-control" defaultValue={editingQuestion?.endsOn ?? ""} />
          </div>
        </div>
        <p className="avail-hint">For a seasonal question, such as the Christmas decor acknowledgment: asked of bookings on those days only.</p>
        <div className="avail-actions">
          <button type="submit" className="btn btn-dark btn-small">
            {editingQuestion ? "Save the question" : "Add the question"}
          </button>
          {editingQuestion && (
            <Link href="/admin/forms#questions" className="btn btn-outline btn-small">
              Cancel
            </Link>
          )}
        </div>
      </form>

      <div className="admin-card" id="preview">
        <h3>Preview the booking form</h3>
        <form method="get" action="/admin/forms#preview" className="admin-form-row">
          <div className="form-group">
            <label className="form-label" htmlFor="preview-studio">
              Studio
            </label>
            <select id="preview-studio" name="previewStudio" className="form-control" defaultValue={previewStudio}>
              {catalog.studios.map((studio) => (
                <option key={studio.id} value={studio.id}>
                  {studio.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="preview-type">
              Booking
            </label>
            <select id="preview-type" name="previewType" className="form-control" defaultValue={previewPhotography ? "photography" : "rental"}>
              <option value="rental">Studio rental</option>
              <option value="photography">Photography session</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="preview-date">
              Day
            </label>
            <input id="preview-date" name="previewDate" type="date" className="form-control" defaultValue={previewDate} />
          </div>
          <button type="submit" className="btn btn-outline btn-small">
            Show
          </button>
        </form>
        <div className="forms-preview" aria-label="The booking form as a client sees it">
          {previewed.length === 0 ? <p>No question is asked of this booking.</p> : previewed.map((question) => <QuestionPreview key={question.id} question={question} />)}
          <p className="avail-hint">
            Then the {policies?.title ?? "studio policies"}
            {previewedAgreements.length > 0 && ` and ${previewedAgreements.map((agreement) => agreement.title).join(", ")}`}, read to the end, and the box to tick.
            Questions marked &ldquo;(draft)&rdquo; are not asked until they are published.
          </p>
        </div>
      </div>

      <div className="admin-card" id="agreements">
        <h3>Agreements and waivers</h3>
        <p style={{ fontSize: ".875rem" }}>
          Beside the studio policies: a waiver, a photography agreement. Clients read the version published last, and each booking keeps the one its client
          accepted. An agreement is taken off, never deleted, so that what was accepted can always be read again.
        </p>
        {agreementsList.length === 0 ? (
          <p>No agreements yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Agreement</th>
                  <th>Accepted by</th>
                  <th>Status</th>
                  <th>Versions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {agreementsList.map((agreement) => {
                  const latest = agreement.versions[0];
                  const changed = latest ? latest.body !== agreement.draft || latest.title !== agreement.title : agreement.draft !== "";
                  return (
                    <tr key={agreement.id}>
                      <td>{agreement.title}</td>
                      <td>{appliesText(agreement, catalog.studios)}</td>
                      <td>
                        {!agreement.active ? "Off" : latest ? `Version ${latest.number}` : "Not published"}
                        {changed && agreement.draft && " · changes not published"}
                      </td>
                      <td>
                        {agreement.versions.length === 0
                          ? "None"
                          : agreement.versions.map((version, index) => (
                              <span key={version.id}>
                                {index > 0 && ", "}
                                <Link href={`/admin/forms/versions/${version.id}`}>{version.number}</Link>
                              </span>
                            ))}
                      </td>
                      <td>
                        <form action={agreementAction} className="forms-row-actions">
                          <input type="hidden" name="id" value={agreement.id} />
                          <Link href={`/admin/forms?agreement=${agreement.id}#agreement-form`} className="btn btn-outline btn-small">
                            Edit
                          </Link>
                          {changed && agreement.draft && (
                            <button type="submit" name="intent" value="publish" className="btn btn-dark btn-small">
                              Publish
                            </button>
                          )}
                          <button type="submit" name="intent" value={agreement.active ? "off" : "on"} className="btn btn-outline btn-small">
                            {agreement.active ? "Take off" : "Put back"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form action={saveAgreementAction} className="admin-card" id="agreement-form" key={`agreement-${editingAgreement?.id ?? "new"}`}>
        <h3>{editingAgreement ? `Change ${editingAgreement.title}` : "Add an agreement"}</h3>
        {editingAgreement && <input type="hidden" name="id" value={editingAgreement.id} />}
        <div className="form-group">
          <label className="form-label" htmlFor="agreement-title">
            Title
          </label>
          <input id="agreement-title" name="title" className="form-control" maxLength={120} defaultValue={editingAgreement?.title ?? ""} required />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="agreement-draft">
            Text
          </label>
          <textarea id="agreement-draft" name="draft" className="form-control" rows={10} maxLength={20000} defaultValue={editingAgreement?.draft ?? ""} />
          <p className="avail-hint">An empty line between paragraphs. Saved as a draft: clients read it once you publish it.</p>
        </div>
        <AppliesFields item={editingAgreement} studios={catalog.studios} prefix="agreement" />
        <div className="avail-actions">
          <button type="submit" className="btn btn-dark btn-small">
            Save the draft
          </button>
          {editingAgreement && (
            <Link href="/admin/forms#agreements" className="btn btn-outline btn-small">
              Cancel
            </Link>
          )}
        </div>
        {editingAgreement && editingAgreement.draft && (
          <div className="forms-preview" aria-label="The draft as a client reads it">
            <h4>{editingAgreement.title}</h4>
            {editingAgreement.draft.split(/\n{2,}/).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        )}
      </form>
    </AdminFrame>
  );
}
