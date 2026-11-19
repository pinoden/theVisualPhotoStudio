"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Pictures in one row that scrolls sideways, as the old website showed a
 * studio's photos and the photography portfolio: a finger swipes it, the
 * arrows move it on by a picture (from the last back to the first), and the
 * keyboard reaches each picture's link, which brings it into view.
 *
 * `columns` and `columnsPhone` say how many pictures show at once; a part of
 * one (3.3) shows that there are more. The arrows show only when there are
 * more pictures than show at once. The list is marked as made to scroll
 * sideways, so the phone check does not take its hidden pictures for a page
 * that is wider than the screen (src/lib/site/phone-checks.ts).
 */
export function PictureRow({
  label,
  columns,
  columnsPhone,
  ratio,
  gap = "normal",
  count,
  listClassName,
  children,
}: {
  /** What a screen reader calls the row. */
  label: string;
  columns: number;
  columnsPhone: number;
  /** Each picture's shape, as CSS writes it: "1 / 1". */
  ratio: string;
  gap?: "normal" | "small" | "none";
  /** How many pictures there are. */
  count: number;
  listClassName?: string;
  /** The pictures, each an `<li>`. */
  children: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);

  const move = (direction: 1 | -1) => {
    const row = list.current;
    if (!row) return;
    const first = row.firstElementChild;
    const step = first ? first.getBoundingClientRect().width + (parseFloat(getComputedStyle(row).columnGap) || 0) : row.clientWidth;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const atStart = row.scrollLeft <= 1;
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
    if (direction === 1 && atEnd) row.scrollTo({ left: 0, behavior });
    else if (direction === -1 && atStart) row.scrollTo({ left: row.scrollWidth, behavior });
    else row.scrollBy({ left: direction * step, behavior });
  };

  const style = { "--cols": columns, "--cols-phone": columnsPhone, "--ratio": ratio } as CSSProperties;
  return (
    <div className="picture-row" data-arrows={count > columns ? "" : undefined} data-arrows-phone={count > columnsPhone ? "" : undefined} style={style}>
      <ul ref={list} className={`picture-row-list${listClassName ? ` ${listClassName}` : ""}`} data-gap={gap} data-scrolls-sideways="" aria-label={label}>
        {children}
      </ul>
      <button type="button" className="picture-row-arrow" data-side="back" aria-label="Previous pictures" onClick={() => move(-1)}>
        <span aria-hidden="true">←</span>
      </button>
      <button type="button" className="picture-row-arrow" data-side="next" aria-label="Next pictures" onClick={() => move(1)}>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
