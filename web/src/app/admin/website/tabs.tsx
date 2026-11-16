import Link from "next/link";
import { getDb } from "@/db/client";
import { websiteAbilities } from "@/server/website";

const TABS = [
  { href: "/admin/website", label: "Overview", part: "any" },
  { href: "/admin/website/pages", label: "Pages", part: "pages" },
  { href: "/admin/website/design", label: "Design", part: "design" },
  { href: "/admin/website/navigation", label: "Header, menu & footer", part: "design" },
  { href: "/admin/website/media", label: "Pictures", part: "any" },
  { href: "/admin/website/media/collections", label: "Collections", part: "any" },
  { href: "/admin/website/fonts", label: "Your fonts", part: "design" },
] as const;

export type WebsiteTab = (typeof TABS)[number]["href"];

/**
 * The parts of the website's editor, on every one of its pages: the ones this
 * viewer may open. The pictures serve both the design and the pages, so they
 * are there for anyone who may change either.
 */
export async function WebsiteTabs({ active, viewer }: { active: WebsiteTab; viewer: { role: string } }) {
  const may = await websiteAbilities(await getDb(), viewer);
  const shown = TABS.filter((tab) => tab.part === "any" || (tab.part === "design" ? may.editDesign : may.editPages));
  return (
    <nav className="tab-row" aria-label="Parts of the website">
      {shown.map((tab) => (
        <Link key={tab.href} href={tab.href} aria-current={tab.href === active ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
