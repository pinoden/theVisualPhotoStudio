import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AccountFrame } from "@/components/AccountFrame";
import { PrintButton } from "@/components/PrintButton";
import { ReceiptView } from "@/components/ReceiptView";
import { getDb } from "@/db/client";
import { getReceipt } from "@/server/receipts";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Receipt", robots: { index: false } };

export default function ReceiptPage(props: PageProps<"/account/receipts/[ref]">) {
  return (
    <section className="section section-cream">
      <div className="container-sm">
        <Suspense fallback={<div className="spinner" />}>
          <OneReceipt params={props.params} />
        </Suspense>
      </div>
    </section>
  );
}

/** One receipt, for the customer it belongs to. Anyone else gets "not found". */
async function OneReceipt({ params }: Pick<PageProps<"/account/receipts/[ref]">, "params">) {
  await connection();
  const { ref } = await params;
  const user = await requireUser(`/account/receipts/${encodeURIComponent(ref)}`);
  const receipt = await getReceipt(await getDb(), user.email, ref);
  if (!receipt) notFound();

  return (
    <AccountFrame user={user} active="/account/receipts">
      <div className="receipt-actions no-print">
        <Link href="/account/receipts">← All receipts</Link>
        <span>
          <PrintButton />{" "}
          <a href={`/account/receipts/${receipt.ref}/pdf`} className="btn btn-dark btn-small">
            Download PDF
          </a>
        </span>
      </div>
      <ReceiptView receipt={receipt} />
    </AccountFrame>
  );
}
