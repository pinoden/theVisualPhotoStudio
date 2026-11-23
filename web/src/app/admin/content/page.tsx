import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminLoading } from "../frame";
import { ServiceAdmin } from "../photography/ServiceAdmin";

export const metadata: Metadata = { title: "Content Creation", robots: { index: false } };

/**
 * The content creator's hours, days off and sessions on sale (the owner's answer of 2026-11-23, question 69 in
 * ProjectLibrary.md): the Photography page's, for content creation (`ServiceAdmin`).
 */
export default function ContentAdminPage(props: PageProps<"/admin/content">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <ServiceAdmin service="content" searchParams={props.searchParams} />
    </Suspense>
  );
}
