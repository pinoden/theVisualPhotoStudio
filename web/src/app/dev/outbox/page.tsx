import { desc } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { emailOutbox } from "@/db/schema";
import { formatInstant } from "@/server/tz";
import { runTasksNowAction } from "./actions";

export const metadata: Metadata = { title: "Development: emails", robots: { index: false } };

/**
 * Development aid. No email service is connected locally, so every message
 * the site would send (sign-in codes, confirmations, loyalty and reschedule
 * codes) can be read here. The page does not exist in production.
 */
export default function OutboxPage(props: PageProps<"/dev/outbox">) {
  return (
    <section className="section section-cream">
      <div className="container-sm">
        <Suspense fallback={<div className="spinner" />}>
          <Outbox searchParams={props.searchParams} />
        </Suspense>
      </div>
    </section>
  );
}

async function Outbox({ searchParams }: Pick<PageProps<"/dev/outbox">, "searchParams">) {
  await connection();
  if (process.env.NODE_ENV === "production") notFound();
  const query = await searchParams;
  const db = await getDb();
  const rows = await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(50);

  return (
    <>
      <h1 style={{ fontSize: "2rem" }}>Emails (development)</h1>
      <p>
        Local development sends no email. The newest 50 messages the site queued are listed here, newest first. This
        page is not available in production.
      </p>
      <form action={runTasksNowAction} style={{ marginBottom: "1.5rem" }}>
        <button type="submit" className="btn btn-outline btn-small">
          Run scheduled tasks now
        </button>
        <span style={{ fontSize: ".8rem", marginLeft: ".75rem" }}>
          Completes past visits, sends the free hours they earned, retries refunds.
        </span>
      </form>
      {typeof query.ran === "string" && <div className="flash flash-success">Tasks ran: {query.ran}</div>}
      {rows.length === 0 && <div className="notice">Nothing has been queued yet.</div>}
      {rows.map((row) => (
        <div className="admin-card" key={row.id} style={{ border: "1px solid var(--color-border)" }}>
          <div style={{ fontSize: ".8rem" }}>
            To {row.toEmail} · {row.kind} · {formatInstant(row.createdAt)}
            {row.replyTo && <div>Replies go to {row.replyTo}</div>}
          </div>
          <h3 style={{ margin: ".5rem 0" }}>{row.subject}</h3>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: ".875rem", margin: 0 }}>{row.body}</pre>
        </div>
      ))}
    </>
  );
}
