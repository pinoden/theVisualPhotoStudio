import Link from "next/link";
import type { ReactNode } from "react";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/staff", label: "Day sheet" },
  { href: "/admin/staff", label: "Staff" },
  { href: "/admin/prices", label: "Prices" },
  { href: "/admin/hours", label: "Hours & blocks" },
  { href: "/admin/codes", label: "Codes" },
  { href: "/admin/settings", label: "Settings" },
] as const;

export type AdminQuery = Record<string, string | string[] | undefined>;

/**
 * The admin sidebar and page frame. Rendered by each admin page after its
 * `requireOwner()` check, never from a layout, so nothing about the admin
 * area reaches someone who is not the owner.
 */
export function AdminFrame({
  active,
  title,
  query,
  children,
}: {
  active: (typeof LINKS)[number]["href"];
  title: string;
  /** The page's search parameters; `notice` and `error` are shown as messages. */
  query: AdminQuery;
  children: ReactNode;
}) {
  const notice = typeof query.notice === "string" ? query.notice : "";
  const error = typeof query.error === "string" ? query.error : "";
  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-logo">Studio Admin</div>
        <nav className="admin-nav">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={link.href === active ? "active" : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="admin-main">
        <div className="admin-header">
          <h1>{title}</h1>
        </div>
        {notice && (
          <div className="flash flash-success" role="status">
            {notice}
          </div>
        )}
        {error && (
          <div className="flash flash-error" role="alert">
            {error}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function AdminLoading() {
  return (
    <div style={{ padding: "4rem", textAlign: "center" }}>
      <div className="spinner" />
    </div>
  );
}
