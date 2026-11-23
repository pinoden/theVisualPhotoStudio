"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hintsSignedIn } from "@/lib/signed-in-hint";
import { BOOK_PATH, isInternalHref, menuLabel, type SiteFrame, type SiteLink } from "@/lib/site/frame";

/** What the header needs of the frame (src/lib/site/frame.ts). */
export type SiteNavProps = Pick<SiteFrame, "logo" | "menu" | "bookButton"> & {
  menuPosition: SiteFrame["header"]["menuPosition"];
  /** The logo's picture, when the owners chose one. It is shown in place of the logo's text. */
  logoPicture: { url: string; width: number; height: number } | null;
  /** What the logo's picture stands for, for someone who cannot see it. */
  studioName: string;
};

/** A link of the menu: a page of this site through the router, anything else as an ordinary link. */
function MenuLink({ link, onChoose, className }: { link: SiteLink; onChoose: () => void; className?: string }) {
  // Only the link to the client's pages can change its words. It reads the page's address to know when to look at the
  // cookie again, and a component that does may wait for the address on a page drawn ahead of time: so it waits alone,
  // showing the owners' words meanwhile, and the rest of the menu does not (Next.js 16's guide to `usePathname`).
  const label =
    link.href === "/account" ? (
      <Suspense fallback={link.label}>
        <AccountLabel link={link} />
      </Suspense>
    ) : (
      link.label
    );
  return isInternalHref(link.href) ? (
    <Link href={link.href} className={className} onClick={onChoose}>
      {label}
    </Link>
  ) : (
    <a href={link.href} className={className} onClick={onChoose}>
      {label}
    </a>
  );
}

const noSubscription = () => () => {};

/**
 * The words of the link to the client's pages: "My Account" once the visitor is signed in, by the cookie set beside the
 * session (src/lib/signed-in-hint.ts). The server draws them for everyone as signed out; the browser reads the cookie
 * once the page is its own, and again after each move to another page, since signing in and out each lead to one.
 */
function AccountLabel({ link }: { link: SiteLink }) {
  usePathname();
  const signedIn = useSyncExternalStore(noSubscription, () => hintsSignedIn(document.cookie), () => false);
  return menuLabel(link, signedIn);
}

/**
 * The header: the logo, the menu with its dropdowns and the booking button,
 * all as the owners set them under Admin, Website.
 *
 * On a screen of 1000px or less the menu folds behind a button (a rule of the
 * stylesheet, so a phone never sees the wide menu first). The owners can make
 * the menu longer than the designer's, so the header also measures itself: on
 * any screen where the logo and the links do not fit side by side, it folds
 * the same way.
 */
export function SiteNav({ logo, logoPicture, studioName, menu, bookButton, menuPosition }: SiteNavProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  /** Which dropdown is open: the position of its item in the menu. */
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [folded, setFolded] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const logoRef = useRef<HTMLAnchorElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // A click anywhere else, or Escape, closes an open dropdown.
  useEffect(() => {
    if (openItem === null) return;
    const onClick = (event: MouseEvent) => {
      if (!(event.target as Element).closest?.("[data-nav-item]")) setOpenItem(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenItem(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openItem]);

  // Fold the menu when it does not fit. The width the row needs can only be measured while the row is
  // shown, so the last measurement is kept for the time the menu is folded.
  useEffect(() => {
    const nav = navRef.current;
    const list = listRef.current;
    const logoEl = logoRef.current;
    if (!nav || !list || !logoEl) return;
    let needed = 0;
    const measure = () => {
      if (window.matchMedia("(max-width: 1000px)").matches) return setFolded(false); // the stylesheet folds it
      if (list.offsetParent !== null && nav.dataset.folded === undefined) {
        const padding = parseFloat(getComputedStyle(nav).paddingLeft) + parseFloat(getComputedStyle(nav).paddingRight);
        // The links themselves and the gaps between them: the list's own box may be stretched across the header.
        const items = Array.from(list.children) as HTMLElement[];
        const gaps = (parseFloat(getComputedStyle(list).columnGap) || 0) * Math.max(0, items.length - 1);
        const row = items.reduce((sum, item) => sum + item.offsetWidth, 0) + gaps;
        needed = logoEl.offsetWidth + row + padding + 32;
      }
      setFolded(needed > nav.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    observer.observe(list);
    return () => observer.disconnect();
  }, [menu, logo, logoPicture, bookButton.label]);

  const close = () => {
    setMenuOpen(false);
    setOpenItem(null);
  };

  return (
    <nav
      className="site-nav"
      ref={navRef}
      data-menu={menuPosition}
      // Present only while the menu is folded for lack of room, so the stylesheet can tell.
      data-folded={folded ? "" : undefined}
    >
      <Link href="/" className="site-logo" onClick={close} ref={logoRef}>
        {logoPicture ? (
          <Image
            className="site-logo-picture"
            src={logoPicture.url}
            width={logoPicture.width}
            height={logoPicture.height}
            alt={studioName}
            sizes="240px"
            loading="eager"
          />
        ) : (
          <>
            {logo.text}
            {logo.accent && (
              <>
                {" "}
                <span>{logo.accent}</span>
              </>
            )}
          </>
        )}
      </Link>

      <button className="nav-toggle" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
        <span />
        <span />
        <span />
      </button>

      <ul className={`nav-links${menuOpen ? " open" : ""}`} ref={listRef}>
        {menu.map((item, index) =>
          item.children.length === 0 ? (
            <li key={`${index}-${item.label}`}>
              <MenuLink link={item} onChoose={close} />
            </li>
          ) : (
            <li key={`${index}-${item.label}`} className="nav-has-sub" data-nav-item>
              <button
                type="button"
                className="nav-more"
                aria-expanded={openItem === index}
                aria-controls={`nav-sub-${index}`}
                onClick={() => setOpenItem((open) => (open === index ? null : index))}
              >
                {item.label} <span aria-hidden="true">▾</span>
              </button>
              {openItem === index && (
                <ul className="nav-dropdown" id={`nav-sub-${index}`}>
                  {item.children.map((child, childIndex) => (
                    <li key={`${childIndex}-${child.label}`}>
                      <MenuLink link={child} onChoose={close} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ),
        )}
        <li className="nav-book">
          <Link href={BOOK_PATH} className={`btn-book-nav btn-book-${bookButton.style}`} onClick={close}>
            {bookButton.label}
          </Link>
        </li>
      </ul>
    </nav>
  );
}
