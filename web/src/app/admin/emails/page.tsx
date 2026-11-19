import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { STUDIO_NOTICES, TEMPLATE_GROUPS } from "@/lib/email-templates";
import { listEmailTemplates } from "@/server/email-templates";
import { requireOwner } from "@/server/session";
import { AdminFrame, AdminLoading } from "../frame";
import { WordingNote } from "./wording-note";

export const metadata: Metadata = { title: "Emails", robots: { index: false } };

export default function EmailsPage(props: PageProps<"/admin/emails">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <EmailList searchParams={props.searchParams} />
    </Suspense>
  );
}

async function EmailList({ searchParams }: Pick<PageProps<"/admin/emails">, "searchParams">) {
  await connection();
  await requireOwner("/admin/emails");
  const templates = await listEmailTemplates(await getDb());

  return (
    <AdminFrame active="/admin/emails" title="Emails" query={await searchParams}>
      <p className="admin-intro">
        The emails the site sends clients by itself. Each is sent in the site&apos;s own wording until you change it, and
        in yours from then on: a change reaches the emails sent after you save it. The site fills in each booking&apos;s
        details, such as the client&apos;s name, the time and what was paid, wherever you put them.
      </p>
      {TEMPLATE_GROUPS.map((group) => (
        <div className="admin-card" key={group}>
          <h3>{group}</h3>
          <div className="data-table-wrap">
            <table className="data-table email-list">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>When it is sent</th>
                  <th>Wording</th>
                </tr>
              </thead>
              <tbody>
                {templates
                  .filter((template) => template.spec.group === group)
                  .map((template) => (
                    <tr key={template.spec.key}>
                      <td>
                        <Link href={`/admin/emails/${template.spec.key}`}>
                          <strong>{template.spec.title}</strong>
                        </Link>
                      </td>
                      <td>{template.spec.when}</td>
                      <td>
                        <WordingNote template={template} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="admin-card">
        <h3>Notices to the studio</h3>
        <p className="admin-intro">
          The site also emails the studio when something needs it. These keep the site&apos;s wording, as they say what
          the site did and what to do next.
        </p>
        <ul className="email-notices">
          {STUDIO_NOTICES.map((notice) => (
            <li key={notice.title}>
              <strong>{notice.title}.</strong> {notice.when}
            </li>
          ))}
        </ul>
      </div>
    </AdminFrame>
  );
}
