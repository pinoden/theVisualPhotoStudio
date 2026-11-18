"use client";

import { useActionState, useRef, useState } from "react";
import { saveEmailTemplateAction, type TemplateFormState } from "@/app/admin/emails/actions";
import {
  BODY_MAX,
  EMAIL_TEMPLATES,
  renderEmail,
  sampleParts,
  STUDIO_PARTS,
  SUBJECT_MAX,
  templateProblems,
  tidyTemplate,
  type EmailPart,
  type TemplateKey,
} from "@/lib/email-templates";

/**
 * The editor of one email's wording (Admin → Emails): its subject and text, the parts the site fills in, and a
 * preview with made-up details that follows the typing. The checks the server makes on saving run here as the owner
 * types, so that wording the site could not send is never saved.
 */
export function EmailTemplateEditor(props: {
  templateKey: TemplateKey;
  /** The wording the editor opens with: the owners' when saved, otherwise the site's. */
  subject: string;
  body: string;
  revision: number;
  /** True when the owners' wording is saved, so that the site's can be brought back. */
  own: boolean;
  studioName: string;
  studioAddress: string;
  baseUrl: string;
}) {
  const spec = EMAIL_TEMPLATES[props.templateKey];
  const opened: TemplateFormState = { status: "idle", message: "", revision: props.revision, own: props.own, wording: { subject: props.subject, body: props.body } };
  const [state, action, pending] = useActionState(saveEmailTemplateAction, opened);
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.body);
  const [saved, setSaved] = useState({ subject: props.subject, body: props.body });
  const [plain, setPlain] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // After a save the fields show what was saved: the site's wording after going back to it.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    setConfirming(false);
    if (state.wording) {
      setSubject(state.wording.subject);
      setBody(state.wording.body);
      setSaved(state.wording);
    }
  }

  const subjectField = useRef<HTMLInputElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<"subject" | "body">("body");

  const problems = templateProblems(spec, { subject, body });
  const typed = tidyTemplate({ subject, body });
  const unsaved = typed.subject !== tidyTemplate(saved).subject || typed.body !== tidyTemplate(saved).body;
  const isSites = typed.subject === spec.subject && typed.body === spec.body;
  const preview = renderEmail(
    { subject, body },
    sampleParts(spec, { plain, baseUrl: props.baseUrl, studioName: props.studioName, studioAddress: props.studioAddress }),
  );

  /** Put a part where the cursor is in the field used last: a part of several lines always goes in the text. */
  function insert(part: EmailPart) {
    const inSubject = lastField.current === "subject" && !part.lines;
    const field = inSubject ? subjectField.current : bodyField.current;
    if (!field) return;
    const mark = `{{${part.key}}}`;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    (inSubject ? setSubject : setBody)(field.value.slice(0, start) + mark + field.value.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + mark.length, start + mark.length);
    });
  }

  return (
    <div className="email-editor">
      <form action={action} className="admin-card email-editor-form">
        <input type="hidden" name="key" value={spec.key} />
        <input type="hidden" name="revision" value={state.revision} />
        <div className="form-group">
          <label className="form-label" htmlFor="email-subject">
            Subject
          </label>
          <input
            id="email-subject"
            ref={subjectField}
            name="subject"
            className="form-control"
            value={subject}
            maxLength={SUBJECT_MAX}
            onChange={(event) => setSubject(event.target.value)}
            onFocus={() => (lastField.current = "subject")}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="email-body">
            Text
          </label>
          <textarea
            id="email-body"
            ref={bodyField}
            name="body"
            className="form-control email-body"
            rows={20}
            value={body}
            maxLength={BODY_MAX}
            onChange={(event) => setBody(event.target.value)}
            onFocus={() => (lastField.current = "body")}
          />
        </div>
        {problems.length > 0 && (
          <div className="flash flash-error" role="alert">
            This wording cannot be sent:
            <ul className="email-problems">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        {state.message && (
          <div className={`flash ${state.status === "error" ? "flash-error" : "flash-success"}`} role={state.status === "error" ? "alert" : "status"}>
            {state.message}
          </div>
        )}
        <div className="email-editor-actions">
          <button type="submit" name="intent" value="save" className="btn btn-dark btn-small" disabled={pending || problems.length > 0}>
            Save
          </button>
          {unsaved && <span className="email-unsaved">Not saved yet</span>}
          {state.own &&
            (confirming ? (
              <span className="editor-confirm">
                Send this email in the site&apos;s wording again? Yours is not kept.{" "}
                <button type="submit" name="intent" value="restore" className="btn btn-outline btn-small" disabled={pending}>
                  Yes, use the site&apos;s wording
                </button>{" "}
                <button type="button" className="btn btn-outline btn-small" onClick={() => setConfirming(false)}>
                  Keep mine
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn-outline btn-small" disabled={pending} onClick={() => setConfirming(true)}>
                Use the site&apos;s wording
              </button>
            ))}
        </div>
        {!isSites && (
          <details className="email-site-wording">
            <summary>The site&apos;s wording of this email</summary>
            <p>To copy from. Saving it as it is sends the email in the site&apos;s wording again.</p>
            <pre>{`${spec.subject}\n\n${spec.body}`}</pre>
          </details>
        )}
      </form>

      <section className="admin-card email-preview" aria-labelledby="email-preview-title">
        <h3 id="email-preview-title">Preview</h3>
        <label className="email-preview-switch">
          <input type="checkbox" checked={!plain} onChange={(event) => setPlain(!event.target.checked)} /> Show the parts only some of these emails
          have
        </label>
        <p className="email-preview-note">With made-up details. Each email has its own booking&apos;s.</p>
        <div className="email-preview-subject">{preview.subject || "(no subject)"}</div>
        <pre className="email-preview-body" data-testid="email-preview">
          {preview.body}
        </pre>
      </section>

      <section className="admin-card email-parts" aria-labelledby="email-parts-title">
        <h3 id="email-parts-title">What the site fills in</h3>
        <p>
          Write a part with its double braces wherever it should go, or press it to put it where the cursor is. A line
          that holds nothing but parts this email has nothing for is left out, with its empty line.
        </p>
        <ul>
          {[...spec.parts, ...STUDIO_PARTS].map((part) => (
            <li key={part.key}>
              <button type="button" className="email-part" onClick={() => insert(part)} aria-label={`Put {{${part.key}}} in: ${part.label}`}>
                {`{{${part.key}}}`}
              </button>
              {part.required && <span className="badge badge-pending">Must stay</span>}
              <div>
                {part.label}.{part.only ? ` ${part.only}.` : ""}
                {part.lines ? " Several lines: in the text, not in the subject." : ""}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
