"use client";

import { useId, useState, type FormEvent } from "react";
import type { Service } from "@/lib/domain/services";
import { EMAIL_FIELD } from "@/lib/parse";
import { durationLabel, longDateLabel, minutesToLabel } from "@/lib/domain/time";

/**
 * "Join the waitlist" on the booking page (the owner's brief of 2026-11-22, item 4): for a client who did not find the
 * time they want on the day chosen. They give a range of that day the whole appointment should lie in, their first and
 * last name and their email, and are emailed once if a time that fits opens up (`/api/waitlist`). Nothing is booked.
 */
export function WaitlistJoin({
  studioIds,
  photography,
  service = "photography",
  durationMinutes,
  date,
  openMinute,
  closeMinute,
  onFreeNow,
}: {
  studioIds: string[];
  photography: boolean;
  /** Whose session, in the session flow (question 69). */
  service?: Service;
  durationMinutes: number;
  date: string;
  /** The day's opening hours across the studios chosen: the range is chosen inside them. */
  openMinute: number;
  closeMinute: number;
  /** A time that fits is free after all: the page reads the day's times again. */
  onFreeNow: () => void;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(openMinute);
  const [to, setTo] = useState(Math.min(closeMinute, openMinute + Math.max(durationMinutes, 180)));
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; message: string } | null>(null);
  const steps: number[] = [];
  for (let minute = openMinute; minute <= closeMinute; minute += 30) steps.push(minute);

  async function join(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setAnswer(null);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studioIds, photography, service, durationMinutes, date, fromMinute: from, toMinute: to, firstName, lastName, email }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; code?: string; message?: string };
      if (response.ok && data.ok) {
        setAnswer({ ok: true, message: `You are on the waitlist. We will email ${email.trim()} if a time opens up between ${minutesToLabel(from)} and ${minutesToLabel(to)}.` });
      } else {
        setAnswer({ ok: false, message: data.message ?? "You could not be put on the waitlist. Please try again." });
        if (data.code === "free_now") onFreeNow();
      }
    } catch {
      setAnswer({ ok: false, message: "We could not reach the studio's server. Please check your connection and try again." });
    } finally {
      setSending(false);
    }
  }

  if (answer?.ok) {
    return (
      <div className="waitlist-join" role="status">
        <p>{answer.message}</p>
      </div>
    );
  }
  return (
    <div className="waitlist-join">
      {!open ? (
        <p>
          Not the time you want?{" "}
          <button type="button" className="btn btn-outline btn-small" onClick={() => setOpen(true)}>
            Join the waitlist
          </button>
        </p>
      ) : (
        <form onSubmit={join} aria-labelledby={`${ids}-title`}>
          <h4 id={`${ids}-title`}>Join the waitlist</h4>
          <p className="waitlist-note">
            We email you once if a time of {durationLabel(durationMinutes)} opens up on {longDateLabel(date)} within the hours you choose. Nothing is
            booked for you: the time goes to whoever books it first.
          </p>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor={`${ids}-from`}>
                Between
              </label>
              <select id={`${ids}-from`} className="form-control" value={from} onChange={(event) => setFrom(Number(event.target.value))}>
                {steps.slice(0, -1).map((minute) => (
                  <option key={minute} value={minute}>
                    {minutesToLabel(minute)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`${ids}-to`}>
                And
              </label>
              <select id={`${ids}-to`} className="form-control" value={to} onChange={(event) => setTo(Number(event.target.value))}>
                {steps.slice(1).map((minute) => (
                  <option key={minute} value={minute}>
                    {minutesToLabel(minute)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`${ids}-first`}>
                First name
              </label>
              <input id={`${ids}-first`} className="form-control" maxLength={80} autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`${ids}-last`}>
                Last name
              </label>
              <input id={`${ids}-last`} className="form-control" maxLength={80} autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`${ids}-email`}>
                Email address
              </label>
              <input id={`${ids}-email`} className="form-control" {...EMAIL_FIELD} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </div>
          </div>
          {answer && (
            <p className="flash flash-error" role="alert">
              {answer.message}
            </p>
          )}
          <button type="submit" className="btn btn-dark btn-small" disabled={sending}>
            {sending ? "Sending…" : "Put me on the waitlist"}
          </button>
        </form>
      )}
    </div>
  );
}
