"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Escape closes the appointment's pop-up over the calendar, as its × does: back to the calendar's own address. */
export function CloseOnEscape({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") router.push(href, { scroll: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [href, router]);
  return null;
}
