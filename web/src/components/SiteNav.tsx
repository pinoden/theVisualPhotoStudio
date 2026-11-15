"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function SiteNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLLIElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!infoOpen) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!infoRef.current?.contains(target) && !dropdownRef.current?.contains(target)) setInfoOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [infoOpen]);

  const close = () => {
    setMenuOpen(false);
    setInfoOpen(false);
  };

  return (
    <>
      <nav className="site-nav">
        <Link href="/" className="site-logo" onClick={close}>
          The Visuals <span>Photo Studio</span>
        </Link>

        <button
          className="nav-toggle"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>

        <ul className={`nav-links${menuOpen ? " open" : ""}`}>
          <li>
            <Link href="/studios" onClick={close}>
              Our Studios
            </Link>
          </li>
          <li>
            <Link href="/rates" onClick={close}>
              Rates
            </Link>
          </li>
          <li ref={infoRef}>
            <a
              href="#"
              aria-expanded={infoOpen}
              onClick={(event) => {
                event.preventDefault();
                setInfoOpen((open) => !open);
              }}
            >
              Info ▾
            </a>
          </li>
          <li>
            <Link href="/contact" onClick={close}>
              Contact
            </Link>
          </li>
          <li>
            <Link href="/account" onClick={close}>
              My Bookings
            </Link>
          </li>
          <li>
            <Link href="/book" className="btn-book-nav" onClick={close}>
              Book Now
            </Link>
          </li>
        </ul>
      </nav>

      {infoOpen && (
        <div className="nav-dropdown" ref={dropdownRef}>
          <ul>
            <li>
              <Link href="/faq" onClick={close}>
                Guest Information
              </Link>
            </li>
            <li>
              <Link href="/policies" onClick={close}>
                Policies
              </Link>
            </li>
            <li>
              <Link href="/rates" onClick={close}>
                Rates
              </Link>
            </li>
          </ul>
        </div>
      )}
    </>
  );
}
