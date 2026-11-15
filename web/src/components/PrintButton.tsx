"use client";

/** Opens the browser's own print window, which can also save the page as a PDF. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-outline btn-small no-print" onClick={() => window.print()}>
      {label}
    </button>
  );
}
