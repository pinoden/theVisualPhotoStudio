import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminLoading } from "../frame";
import { ServiceAdmin } from "./ServiceAdmin";

export const metadata: Metadata = { title: "Photography", robots: { index: false } };

/** The photographer's hours, days off and sessions on sale, and Photography's photos: `ServiceAdmin`. */
export default function PhotographyAdminPage(props: PageProps<"/admin/photography">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <ServiceAdmin service="photography" searchParams={props.searchParams} />
    </Suspense>
  );
}
