import Link from "next/link";
import type { ReactNode } from "react";
import { can, type AbilitySettings } from "@/lib/abilities";

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
  { href: "/admin/memberships", label: "Memberships" },
  { href: "/admin/website", label: "Website" },
  { href: "/admin/emails", label: "Emails" },
  { href: "/admin/settings", label: "Settings" },
] as const;

export type AdminQuery = Record<string, string | string[] | undefined>;

/**
 * The menu of a manager or an attendant: the pages this person can open, as
 * the owners have set the switches. Every other admin page answers "not
 * found" for them. The order is the owners' menu's.
 */
function linksFor(viewer: { role: string }, settings: AbilitySettings): { href: (typeof LINKS)[number]["href"]; label: string }[] {
  const pages: Partial<Record<(typeof LINKS)[number]["href"], boolean>> = {
    "/admin/calendar": true,
    "/staff": true,
    "/admin/bookings": can(viewer, "refund", settings),
    "/admin/customers": can(viewer, "seeCustomers", settings),
    "/admin/hours": can(viewer, "blockTime", settings),
    "/admin/photography": can(viewer, "setPhotographerTimes", settings),
    "/admin/website": can(viewer, "editDesign", settings) || can(viewer, "editPages", settings),
  };
  return LINKS.filter((link) => pages[link.href] === true);
}

/**
 * The admin sidebar and page frame. Rendered by each admin page after its own
 * check (`requireOwner`, or `requireStaff` or `requireManager` on the pages
 * the levels share), never from a layout, so nothing about the admin area
 * reaches someone who may not see it. On a shared page pass `viewer` and the
 * settings: a manager or an attendant then gets their own, shorter menu.
 */
export function AdminFrame({
  active,
  title,
  query,
  viewer,
  settings,
  wide = false,
  children,
}: {
  active: (typeof LINKS)[number]["href"];
  title: string;
  /** The page's search parameters; `notice` and `error` are shown as messages. */
  query: AdminQuery;
  /** Who is looking, on a page that a manager or an attendant can open too. Left out on the owners' own pages. */
  viewer?: { role: string };
  /** The settings, which decide the menu of a manager or an attendant. Needed whenever `viewer` is given. */
  settings?: AbilitySettings;
  /** For the page editor: on a wide screen the menu folds away, to give the editor the whole width. */
  wide?: boolean;
  children: ReactNode;
}) {
  const links = viewer && viewer.role !== "owner" && settings ? linksFor(viewer, settings) : viewer && viewer.role !== "owner" ? [] : LINKS;
  const notice = typeof query.notice === "string" ? query.notice : "";
  const error = typeof query.error === "string" ? query.error : "";
  return (
    <div className={`admin-layout${wide ? " admin-layout-wide" : ""}`}>
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
          {wide && links.length > 0 && (
            <Link href={links[0].href} className="admin-wide-menu">
              Admin menu
            </Link>
          )}
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
