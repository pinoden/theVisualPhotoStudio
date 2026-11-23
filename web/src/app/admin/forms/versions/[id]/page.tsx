import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { agreementVersion } from "@/server/booking-forms";
import { requireStaff } from "@/server/session";
import { formatInstant } from "@/server/tz";
import { AdminFrame, AdminLoading } from "../../../frame";

export const metadata: Metadata = { title: "Agreement", robots: { index: false } };

export default function VersionPage(props: PageProps<"/admin/forms/versions/[id]">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Version params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

/**
 * One published version of an agreement, as a client accepted it (the owner's admin brief of 2026-11-22, item 8):
 * versions are never changed or removed, so this is the text a booking's client agreed to. For whoever works in the
 * admin, as the appointment it is linked from.
 */
async function Version({ params, searchParams }: Pick<PageProps<"/admin/forms/versions/[id]">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  const viewer = await requireStaff(`/admin/forms/versions/${encodeURIComponent(id)}`);
  const version = await agreementVersion(await getDb(), id);
  if (!version) notFound();
  return (
    <AdminFrame active="/admin/calendar" title={version.title} query={await searchParams} viewer={viewer}>
      <div className="admin-card">
        <p className="avail-hint">
          Version {version.number}, published {formatInstant(new Date(version.publishedAt))}.
        </p>
        {version.body.split(/\n{2,}/).map((paragraph, index) => (
          <p key={index} style={{ whiteSpace: "pre-wrap" }}>
            {paragraph}
          </p>
        ))}
        <p>
          <Link href="/admin/calendar">Back to the calendar</Link>
        </p>
      </div>
    </AdminFrame>
  );
}
