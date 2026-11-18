"use client";

import { useRef, useState } from "react";

/**
 * A code with a button that copies it, for a reward or a credit. Where the
 * browser will not copy (an old one, or a page not served securely), the code
 * is selected instead, so that the usual copy shortcut takes it.
 */
export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    let done = false;
    try {
      await navigator.clipboard.writeText(code);
      done = true;
    } catch {
      const node = text.current;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    setCopied(done);
    if (timer.current) clearTimeout(timer.current);
    if (done) timer.current = setTimeout(() => setCopied(false), 2500);
  }

  return (
    <span className="copy-code">
      <span className="copy-code-text" ref={text}>
        {code}
      </span>
      <button type="button" className="btn btn-outline btn-small" onClick={copy} aria-label={`Copy code ${code}`}>
        {copied ? "Copied" : "Copy code"}
      </button>
      <span className="visually-hidden" role="status">
        {copied ? `Code ${code} copied.` : ""}
      </span>
    </span>
  );
}
