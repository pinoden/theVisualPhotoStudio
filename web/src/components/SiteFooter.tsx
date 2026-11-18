import Link from "next/link";
import type { CSSProperties } from "react";
import { copyrightLine, isInternalHref, SOCIAL_NETWORKS, telHref, type SiteFrame, type SiteLink } from "@/lib/site/frame";

function FooterLink({ link }: { link: SiteLink }) {
  return isInternalHref(link.href) ? <Link href={link.href}>{link.label}</Link> : <a href={link.href}>{link.label}</a>;
}

/** The footer of every page, as the owners set it under Admin, Website (src/lib/site/frame.ts). */
export function SiteFooter({ frame }: { frame: SiteFrame }) {
  const { business, logo, footer, social } = frame;
  return (
    <footer className="site-footer">
      <div className="footer-grid" style={{ "--footer-cols": footer.columns.length + 1 } as CSSProperties}>
        <div>
          <div className="footer-logo">
            {logo.text}
            {logo.accent && (
              <>
                {" "}
                <span>{logo.accent}</span>
              </>
            )}
          </div>
          {footer.tagline && <p className="footer-tagline">{footer.tagline}</p>}
          {social.length > 0 && (
            <ul className="footer-social" aria-label="Social media">
              {social.map((entry) => (
                <li key={`${entry.network}-${entry.url}`}>
                  <a href={entry.url} target="_blank" rel="noopener noreferrer">
                    {SOCIAL_NETWORKS[entry.network]}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        {footer.columns.map((column, index) => (
          <div className="footer-col" key={`${index}-${column.title}`}>
            <h4>{column.title}</h4>
            <ul>
              {column.links.map((link, linkIndex) => (
                <li key={`${linkIndex}-${link.label}`}>
                  <FooterLink link={link} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="footer-col">
          <h4>{footer.contactTitle}</h4>
          <p>
            {business.addressLine1}
            <br />
            {business.addressLine2}
          </p>
          <p>
            <a href={telHref(business.phone)}>{business.phone}</a>
          </p>
          {business.note && <p className="footer-note">{business.note}</p>}
        </div>
      </div>
      <div className="footer-bottom">
        <p>{copyrightLine(frame)}</p>
      </div>
    </footer>
  );
}
