import Link from "next/link";

const TABS = [
  { href: "/admin/website", label: "Overview" },
  { href: "/admin/website/design", label: "Design" },
  { href: "/admin/website/navigation", label: "Header, menu & footer" },
  { href: "/admin/website/media", label: "Pictures" },
  { href: "/admin/website/media/collections", label: "Collections" },
  { href: "/admin/website/fonts", label: "Your fonts" },
] as const;

export type WebsiteTab = (typeof TABS)[number]["href"];

/** The parts of the website's editor, on every one of its pages. */
export function WebsiteTabs({ active }: { active: WebsiteTab }) {
  return (
    <nav className="tab-row" aria-label="Parts of the website">
      {TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={tab.href === active ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
