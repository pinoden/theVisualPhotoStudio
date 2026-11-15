import Link from "next/link";
import type { ReactNode } from "react";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/calendar", label: "Calendar" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/staff", label: "Day sheet" },
  { href: "/admin/staff", label: "Staff" },
  { href: "/admin/prices", label: "Prices" },
  { href: "/admin/studios", label: "Studios & add-ons" },
  { href: "/admin/hours", label: "Hours & blocks" },
  { href: "/admin/photography", label: "Photography" },
  { href: "/admin/codes", label: "Codes" },
  { href: "/admin/settings", label: "Settings" },
] as const;

/** The second level of the admin: what a member of staff can open. Everything else answers "not found" for them. */
const STAFF_LINKS = [
  { href: "/admin/calendar", label: "Calendar" },
  { href: "/staff", label: "Day sheet" },
] as const;
/** Shown to staff only when the owners have switched the ability on. */
const STAFF_PHOTOGRAPHY = { href: "/admin/photography", label: "Photography" } as const;

export type AdminQuery = Record<string, string | string[] | undefined>;

/**
 * The admin sidebar and page frame. Rendered by each admin page after its own
 * check (`requireOwner`, or `requireStaff` on the pages both levels share),
 * never from a layout, so nothing about the admin area reaches someone who
 * may not see it. Pass `viewer` on a shared page: staff then get their own,
 * shorter menu.
 */
export function AdminFrame({
  active,
  title,
  query,
  viewer,
  settings,
  children,
}: {
  active: (typeof LINKS)[number]["href"];
  title: string;
  /** The page's search parameters; `notice` and `error` are shown as messages. */
  query: AdminQuery;
  /** Who is looking, on a page that staff can open too. Left out on the owners' own pages. */
  viewer?: { role: string };
  /** The settings, when the page has them: staff then get a link to each page an ability opens for them. */
  settings?: { staffSetsPhotographerTimes: boolean };
  children: ReactNode;
}) {
  const links =
    viewer && viewer.role !== "owner"
      ? [...STAFF_LINKS, ...(settings?.staffSetsPhotographerTimes ? [STAFF_PHOTOGRAPHY] : [])]
      : LINKS;
  const notice = typeof query.notice === "string" ? query.notice : "";
  const error = typeof query.error === "string" ? query.error : "";
  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-logo">Studio Admin</div>
        <nav className="admin-nav">
          {links.map((link) => (
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
