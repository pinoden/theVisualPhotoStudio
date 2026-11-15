import Link from "next/link";
import { SITE } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-grid">
        <div>
          <div className="footer-logo">
            The Visuals <span>Photo Studio</span>
          </div>
          <p className="footer-tagline">
            Natural-light photography studios in Winter Park, FL. Designed for photographers, content creators,
            brands and families.
          </p>
        </div>
        <div className="footer-col">
          <h4>Studios</h4>
          <ul>
            <li>
              <Link href="/studios#blanche">Studio Blanche</Link>
            </li>
            <li>
              <Link href="/studios#dayglow">Studio Dayglow</Link>
            </li>
            <li>
              <Link href="/studios#paris">Studio Paris</Link>
            </li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>Info</h4>
          <ul>
            <li>
              <Link href="/rates">Rates</Link>
            </li>
            <li>
              <Link href="/services">Photography</Link>
            </li>
            <li>
              <Link href="/faq">Guest Information</Link>
            </li>
            <li>
              <Link href="/policies">Policies</Link>
            </li>
            <li>
              <Link href="/contact">Contact</Link>
            </li>
            <li>
              <Link href="/book">Book a studio</Link>
            </li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>Visit Us</h4>
          <p style={{ fontSize: ".875rem" }}>
            {SITE.addressLine1}
            <br />
            {SITE.addressLine2}
          </p>
          <p style={{ fontSize: ".875rem", marginTop: ".75rem" }}>
            <a href={SITE.phoneHref}>{SITE.phoneDisplay}</a>
          </p>
          <p style={{ fontSize: ".8rem", marginTop: ".75rem", color: "rgba(255,255,255,.4)" }}>By appointment only</p>
        </div>
      </div>
      <div className="footer-bottom">
        <p>&copy; {SITE.name}. All rights reserved.</p>
      </div>
    </footer>
  );
}
