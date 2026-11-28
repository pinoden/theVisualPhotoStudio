import { formatCents } from "@/lib/domain/pricing";

/**
 * A price, with the usual one crossed out before it while a sale lowers it (the owner, 2026-11-27: "I want the price
 * be crossed out, like not 78 but 65"). A screen reader is told which is which: a line through a number says nothing
 * to it. Without a usual price, or with one that is no higher, just the price.
 */
export function SalePrice({ cents, usual }: { cents: number; usual?: number | null }) {
  if (usual === undefined || usual === null || usual <= cents) return <>{formatCents(cents)}</>;
  return (
    <>
      <span className="visually-hidden">Usual price </span>
      <s className="price-usual">{formatCents(usual)}</s> <span className="visually-hidden">now </span>
      <span className="price-on-sale">{formatCents(cents)}</span>
    </>
  );
}
