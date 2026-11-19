import type { TemplateState } from "@/server/email-templates";
import { formatInstant } from "@/server/tz";

/** Whose wording an email is sent in, in a few words. */
export function WordingNote({ template }: { template: TemplateState }) {
  if (template.wording === "site") return <>The site&apos;s wording</>;
  const saved = `${template.updatedAt ? `, saved ${formatInstant(template.updatedAt)}` : ""}${template.updatedBy ? ` by ${template.updatedBy}` : ""}`;
  if (template.wording === "owners") return <>Your wording{saved}</>;
  return (
    <>
      <span className="badge badge-cancelled">Yours cannot be sent</span> The site&apos;s wording is sent instead.
    </>
  );
}
