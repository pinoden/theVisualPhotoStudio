"use client";

import { useActionState } from "react";
import { sendMessageAction, type ContactState } from "@/app/contact/actions";
import { CONTACT_LIMITS, CONTACT_TOPICS } from "@/lib/contact";

const START: ContactState = {
  status: "idle",
  error: "",
  fields: {},
  values: { name: "", email: "", topic: "", message: "" },
  attempt: 0,
};

export function ContactForm() {
  const [state, action, pending] = useActionState(sendMessageAction, START);

  if (state.status === "sent") {
    return (
      <div className="contact-card" style={{ textAlign: "center" }}>
        <h3>Message Sent</h3>
        <p role="status">Thank you for reaching out. We will reply by email.</p>
        <form action={action}>
          <input type="hidden" name="intent" value="restart" />
          <button type="submit" className="btn btn-outline btn-small" disabled={pending}>
            Send another message
          </button>
        </form>
      </div>
    );
  }

  const describedBy = (name: keyof ContactState["fields"]) =>
    state.fields[name] ? { "aria-invalid": true, "aria-describedby": `contact-${name}-problem` } : {};
  const problem = (name: keyof ContactState["fields"]) =>
    state.fields[name] && (
      <p className="field-error" id={`contact-${name}-problem`}>
        {state.fields[name]}
      </p>
    );

  return (
    <form action={action} className="contact-card">
      <h3>Send a Message</h3>

      {state.error && (
        <div className="flash flash-error" role="alert">
          {state.error}
        </div>
      )}

      {/* Redrawn after every answer so the fields start from what was typed. */}
      <div key={state.attempt}>
        <div className="form-group">
          <label className="form-label" htmlFor="contact-name">
            Your name
          </label>
          <input
            id="contact-name"
            name="name"
            className="form-control"
            autoComplete="name"
            maxLength={CONTACT_LIMITS.name}
            defaultValue={state.values.name}
            required
            {...describedBy("name")}
          />
          {problem("name")}
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="contact-email">
            Email address
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            className="form-control"
            autoComplete="email"
            maxLength={CONTACT_LIMITS.email}
            defaultValue={state.values.email}
            required
            {...describedBy("email")}
          />
          {problem("email")}
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="contact-topic">
            Topic
          </label>
          <select
            id="contact-topic"
            name="topic"
            className="form-control"
            defaultValue={state.values.topic}
            required
            {...describedBy("topic")}
          >
            <option value="">Select a topic…</option>
            {Object.entries(CONTACT_TOPICS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {problem("topic")}
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="contact-message">
            Message
          </label>
          <textarea
            id="contact-message"
            name="message"
            className="form-control"
            rows={6}
            maxLength={CONTACT_LIMITS.message}
            defaultValue={state.values.message}
            required
            {...describedBy("message")}
          />
          {problem("message")}
        </div>

        {/* Not for people: hidden from sight, the keyboard and screen readers. See sendContactMessage. */}
        <div className="visually-hidden" aria-hidden="true">
          <label htmlFor="contact-leave-blank">Leave this field empty</label>
          <input id="contact-leave-blank" name="leave_blank" type="text" tabIndex={-1} autoComplete="off" />
        </div>
      </div>

      <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={pending}>
        {pending ? "Sending…" : "Send Message"}
      </button>
    </form>
  );
}
