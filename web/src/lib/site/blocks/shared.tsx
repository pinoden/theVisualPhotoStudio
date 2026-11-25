import Link from "next/link";
import type { ReactNode } from "react";
import { isInternalHref } from "../frame";

/** Pieces several blocks share. Plain components: they are drawn on the server for a page and in the browser for the editor. */

/**
 * A link on a page. A page of this site opens through the router; anything
 * else opens in a new tab. In the editor it leads nowhere, so that pressing
 * it to change its words does not leave the editor.
 */
export function SiteAnchor({ href, className, editing, label, children }: { href: string; className?: string; editing: boolean; label?: string; children: ReactNode }) {
  if (editing || href === "") return <span className={className}>{children}</span>;
  if (isInternalHref(href)) {
    return (
      <Link href={href} className={className} aria-label={label}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
    </a>
  );
}

/** A name that can stand after "#" in an address: "Our Decor!" -> "our-decor". Nothing when there is none. */
export function anchorId(name: string): string | undefined {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id === "" ? undefined : id;
}

/** What the editor shows where a block has nothing to show yet. The website itself shows nothing there. */
export function EditorNote({ editing, children }: { editing: boolean; children: ReactNode }) {
  return editing ? <div className="blk blk-note">{children}</div> : null;
}

/** "start" | "center" | "end" for the three alignments a block offers. */
export const ALIGN = { center: "Centred", start: "Left", end: "Right" } as const;
