import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { BookingSummary, statusLabel } from "@/components/BookingSummary";
import { ManageBooking } from "@/components/ManageBooking";
import { getDb } from "@/db/client";
import { formatCents } from "@/lib/domain/pricing";
import { listBookingsForEmail } from "@/server/bookings";
import { getManageChoices } from "@/server/manage";
import { listCodesForEmail } from "@/server/promos";
import { requireUser } from "@/server/session";
import { formatInstant, formatRange } from "@/server/tz";

export const metadata: Metadata = { title: "My Account", robots: { index: false } };

export default function AccountPage() {
  return (
    <>
      <div className="page-banner">
        <p className="section-eyebrow">My Account</p>
        <h1>Your Bookings</h1>
      </div>
      <section className="section section-cream">
        <div className="container-sm">
          <Suspense fallback={<div className="spinner" />}>
            <Account />
          </Suspense>
        </div>
      </section>
    </>
  );
}

async function Account() {
  await connection();
  const user = await requireUser("/account");
  const db = await getDb();
  const now = new Date();
  const [all, codes] = await Promise.all([listBookingsForEmail(db, user.email), listCodesForEmail(db, user.email, now)]);

  const upcoming = all.filter((b) => b.status === "confirmed" && new Date(b.endAt) > now).reverse();
  const earlier = all.filter((b) => !upcoming.includes(b));
  const choices = await Promise.all(
    upcoming.map((b) => getManageChoices(db, b.ref, { kind: "customer", email: user.email }, now)),
  );

  return (
    <>
      <div className="notice" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
        <span>
          Signed in as <strong>{user.email}</strong>
          {user.role === "staff" && (
            <>
              {" · "}
              <Link href="/staff">Staff day sheet</Link>
            </>
          )}
          {user.role === "owner" && (
            <>
              {" · "}
              <Link href="/admin">Admin</Link>
              {" · "}
              <Link href="/staff">Day sheet</Link>
            </>
          )}
        </span>
        {/* A plain post, so the browser loads a new document: see account/sign-out/route.ts. */}
        <form action="/account/sign-out" method="post">
          <button type="submit" className="btn btn-outline" style={{ padding: ".4rem 1rem", fontSize: ".75rem" }}>
            Sign out
          </button>
        </form>
      </div>

      {codes.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.6rem" }}>Your codes</h2>
          <table className="price-table" style={{ marginBottom: "2rem" }}>
            <tbody>
              {codes.map((code) => (
                <tr key={code.code}>
                  <td>
                    <strong style={{ color: "var(--color-dark)", letterSpacing: ".05em" }}>{code.code}</strong>
                    <br />
                    {code.kind === "percent"
                      ? `${code.value}% off your next studio rental`
                      : `${formatCents(code.value)} credit from a rescheduled booking`}
                    {code.expiresAt ? `, valid until ${formatInstant(new Date(code.expiresAt))}` : ""}
                  </td>
                  <td>
                    <Link href="/book">Use it</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2 style={{ fontSize: "1.6rem" }}>Upcoming</h2>
      {upcoming.length === 0 && (
        <p>
          You have no upcoming bookings. <Link href="/book">Book a studio</Link>.
        </p>
      )}
      {upcoming.map((booking, i) => (
        <div className="admin-card" key={booking.ref} style={{ border: "1px solid var(--color-border)" }}>
          <h3>
            {booking.studios.map((s) => s.name).join(" + ")}{" "}
            <span style={{ fontFamily: "var(--font-sans)", fontSize: ".8rem", color: "var(--color-muted)" }}>{booking.ref}</span>
          </h3>
          <BookingSummary booking={booking} />
          <ManageBooking bookingRef={booking.ref} choices={choices[i]} keepInPlace />
        </div>
      ))}

      {earlier.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.6rem", marginTop: "2.5rem" }}>Earlier bookings</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Studio</th>
                <th>Status</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {earlier.map((booking) => {
                const when = formatRange(new Date(booking.startAt), new Date(booking.endAt));
                return (
                  <tr key={booking.ref}>
                    <td>
                      {when.day}
                      <br />
                      {when.time}
                    </td>
                    <td>{booking.studios.map((s) => s.name).join(" + ")}</td>
                    <td>{statusLabel(booking)}</td>
                    <td>{booking.ref}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
