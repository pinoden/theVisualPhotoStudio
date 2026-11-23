import Link from "next/link";
import type { AcceptedItem, AcceptedText } from "@/server/booking-forms";
import { formatInstant } from "@/server/tz";

/**
 * The policies and agreements a client accepted at checkout, each with a link to read it again (the November 20
 * brief: the acceptance shown in the admin and in the customer's own account). `hrefOf` gives each one's page, which
 * differs with who reads it: the client from their booking's link or their account, or the studio.
 */
export function AcceptedList({ accepted, hrefOf }: { accepted: AcceptedItem[]; hrefOf: (id: string) => string }) {
  if (accepted.length === 0) return null;
  return (
    <ul className="accepted-list">
      {accepted.map((item) => (
        <li key={item.id}>
          <Link href={hrefOf(item.id)}>{item.title}</Link>, version {item.versionNumber}, accepted {formatInstant(new Date(item.acceptedAt))}
        </li>
      ))}
    </ul>
  );
}

/**
 * The words accepted, as the client read them: the Policies page's as the site built them (its own HTML, made from the
 * page's blocks with everything escaped: src/lib/site/page-text.ts), or an agreement's paragraphs.
 */
export function AcceptedWords({ text }: { text: AcceptedText }) {
  return (
    <article className="accepted-words">
      <p className="accepted-when">
        Version {text.versionNumber}, accepted {formatInstant(new Date(text.acceptedAt))}.
      </p>
      {text.note && <p className="notice">{text.note}</p>}
      {text.html !== null && <div className="rich-text" dangerouslySetInnerHTML={{ __html: text.html }} />}
      {text.paragraphs?.map((paragraph, index) => (
        <p key={index} style={{ whiteSpace: "pre-wrap" }}>
          {paragraph}
        </p>
      ))}
    </article>
  );
}
