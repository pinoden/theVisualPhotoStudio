"use client";

import { useId, useState, type FormEvent } from "react";
import type { CodeBalance } from "@/server/code-balance";

type Answer =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "found"; balance: CodeBalance }
  | { kind: "not_found"; code: string }
  | { kind: "problem"; message: string };

const STATUS_TEXT: Record<CodeBalance["status"], string> = {
  usable: "Valid",
  used: "Already used",
  expired: "Expired",
};

/**
 * "Check Code Balance" on the booking pages (the owner's brief of 2026-11-22, item 5): a client enters a code and sees
 * what it is worth, before or while booking. Checking spends nothing (`/api/code-balance`).
 */
export function CodeBalanceCheck() {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [answer, setAnswer] = useState<Answer>({ kind: "none" });

  async function check(event: FormEvent) {
    event.preventDefault();
    const typed = code.trim();
    if (!typed) {
      setAnswer({ kind: "problem", message: "Enter a code to check." });
      return;
    }
    setAnswer({ kind: "checking" });
    try {
      const response = await fetch("/api/code-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: typed }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; found?: boolean; balance?: CodeBalance; message?: string };
      if (!response.ok || !data.ok) setAnswer({ kind: "problem", message: data.message ?? "The balance could not be checked. Please try again." });
      else if (data.found && data.balance) setAnswer({ kind: "found", balance: data.balance });
      else setAnswer({ kind: "not_found", code: typed.toUpperCase() });
    } catch {
      setAnswer({ kind: "problem", message: "The balance could not be checked. Please check your connection and try again." });
    }
  }

  return (
    <div className="code-balance">
      <button
        type="button"
        className="btn btn-outline code-balance-toggle"
        aria-expanded={open}
        aria-controls={`${ids}-panel`}
        onClick={() => setOpen(!open)}
      >
        Check Code Balance
      </button>
      {open && (
        <div className="code-balance-panel" id={`${ids}-panel`}>
          <form className="code-balance-form" onSubmit={check}>
            <label className="form-label" htmlFor={`${ids}-code`}>
              Your code: studio credit, reschedule, reward, discount or membership
            </label>
            <div className="code-balance-row">
              <input
                id={`${ids}-code`}
                className="form-control"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={40}
              />
              <button type="submit" className="btn btn-dark" disabled={answer.kind === "checking"}>
                {answer.kind === "checking" ? "Checking…" : "Check balance"}
              </button>
            </div>
            <p className="code-balance-note">Checking a code does not use it.</p>
          </form>
          <div role="status" aria-live="polite">
            {answer.kind === "found" && <BalanceCard balance={answer.balance} />}
            {answer.kind === "not_found" && (
              <p className="flash flash-error">We could not find the code {answer.code}. Please check it and try again.</p>
            )}
            {answer.kind === "problem" && <p className="flash flash-error">{answer.message}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function BalanceCard({ balance }: { balance: CodeBalance }) {
  return (
    <div className={`code-balance-result code-balance-${balance.status}`}>
      <p className="code-balance-title">
        <strong>{balance.title}</strong> · <span className="code-balance-code">{balance.code}</span>
      </p>
      <p className="code-balance-status">
        {STATUS_TEXT[balance.status]}
        {balance.status === "expired" && balance.expires ? ` on ${balance.expires}` : ""}
      </p>
      <p className="code-balance-remaining">{balance.remaining}</p>
      {balance.status === "usable" && <p>{balance.expires ? `Valid until ${balance.expires}` : "Does not expire"}</p>}
      <ul className="code-balance-restrictions">
        {balance.restrictions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
