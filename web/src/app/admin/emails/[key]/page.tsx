import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmailTemplateEditor } from "@/components/EmailTemplateEditor";
import { getDb } from "@/db/client";
import { getEmailTemplate } from "@/server/email-templates";
import { siteUrl } from "@/server/runtime";
import { requireOwner } from "@/server/session";
import { formatInstant } from "@/server/tz";
import { loadBusiness } from "@/server/website";
import { AdminFrame, AdminLoading } from "../../frame";

export const metadata: Metadata = { title: "Email", robots: { index: false } };

export default function EmailTemplatePage(props: PageProps<"/admin/emails/[key]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <EmailTemplateDetails params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

async function EmailTemplateDetails({ params, searchParams }: Pick<PageProps<"/admin/emails/[key]">, "params" | "searchParams">) {
  await connection();
  const { key } = await params;
  await requireOwner(`/admin/emails/${encodeURIComponent(key)}`);
  const db = await getDb();
  const template = await getEmailTemplate(db, key);
  if (!template) notFound();
  const business = await loadBusiness(db);
  const baseUrl = await siteUrl();

  return (
    <AdminFrame active="/admin/emails" title={template.spec.title} query={await searchParams}>
      <p>
        <Link href="/admin/emails">← All emails</Link>
      </p>
      <p className="admin-intro">
        {template.spec.when}{" "}
        {template.wording === "owners"
          ? `It is sent in your wording, saved ${template.updatedAt ? formatInstant(template.updatedAt) : ""}${template.updatedBy ? ` by ${template.updatedBy}` : ""}.`
          : "It is sent in the site's wording."}
      </p>
      {template.wording === "unusable" && (
        <div className="flash flash-warning" role="status">
          Your saved wording of this email cannot be sent, as the parts the site fills in have changed since you saved
          it, so the site&apos;s wording is sent instead. Put yours right below, or use the site&apos;s wording.
        </div>
      )}
      <EmailTemplateEditor
        templateKey={template.spec.key}
        subject={template.subject}
        body={template.body}
        revision={template.revision}
        own={template.wording !== "site"}
        studioName={business.name}
        studioAddress={`${business.addressLine1}, ${business.addressLine2}`}
        baseUrl={baseUrl}
      />
    </AdminFrame>
  );
}
