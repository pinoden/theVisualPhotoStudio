"use client";

import { useState } from "react";
import { CREDIT_FIELD } from "@/lib/parse";

type Kind = "percent" | "photo_percent" | "amount" | "free_hour";

/**
 * The kind of a new code and its value, which the kind decides: a whole
 * percent from 1 to 100, an amount in dollars, or nothing for a free hour
 * (always the price of one hour). The value field takes the check the server
 * makes for the kind chosen, so the browser stops what the server would
 * refuse, before anything typed on the form is lost.
 */
export function CodeKindAndValue() {
  const [kind, setKind] = useState<Kind>("percent");
  const isPercent = kind === "percent" || kind === "photo_percent";
  return (
    <>
      <div className="form-group">
        <label className="form-label" htmlFor="code-kind">
          Kind
        </label>
        <select id="code-kind" name="kind" className="form-control" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
          <option value="percent">Percent off the rental</option>
          <option value="photo_percent">Percent off a session (photography or content creation)</option>
          <option value="amount">Credit in dollars</option>
          <option value="free_hour">One free hour (one studio)</option>
        </select>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="code-value">
          {isPercent ? "Percent off (1 to 100)" : kind === "amount" ? "Amount ($)" : "Value (none for a free hour)"}
        </label>
        {isPercent && <input id="code-value" key="percent" name="value" className="form-control" type="number" min={1} max={100} step={1} required />}
        {kind === "amount" && <input id="code-value" key="amount" name="value" className="form-control" {...CREDIT_FIELD} required />}
        {kind === "free_hour" && <input id="code-value" key="free" className="form-control" disabled placeholder="The price of one hour" />}
      </div>
    </>
  );
}
