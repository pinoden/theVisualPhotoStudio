import Link from "next/link";
import type { ReactNode } from "react";

/** The pages of a customer's account. */
export const ACCOUNT_TABS = [
  { href: "/account", label: "Overview" },
  { href: "/account/appointments", label: "My Appointments" },
  { href: "/account/rewards", label: "My Rewards" },
  { href: "/account/membership", label: "My Membership" },
  { href: "/account/receipts", label: "Receipts & Payments" },
] as const;

/**
 * The top of every account page: who is signed in, the way out, and the
 * account's own menu. Rendered by each page after its own `requireUser`, never
 * from a layout, so nothing of an account reaches someone who is not signed in.
 */
export function AccountFrame({
  user,
  active,
  children,
}: {
  user: { email: string; role: string };
  active: (typeof ACCOUNT_TABS)[number]["href"];
  children: ReactNode;
}) {
  return (
    <>
      <div className="notice account-who">
        <span>
          Signed in as <strong>{user.email}</strong>
          {user.role === "staff" && (
            <>
              {" · "}
              <Link href="/staff">Staff day sheet</Link>
            </>
          )}
          {user.role === "manager" && (
            <>
              {" · "}
              <Link href="/admin/calendar">Studio calendar</Link>
              {" · "}
              <Link href="/staff">Day sheet</Link>
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
          <button type="submit" className="btn btn-outline btn-small">
            Sign out
          </button>
        </form>
      </div>
      <nav className="account-tabs" aria-label="My account">
        {ACCOUNT_TABS.map((tab) => (
          <Link key={tab.href} href={tab.href} aria-current={tab.href === active ? "page" : undefined}>
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
