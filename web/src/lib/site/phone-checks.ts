/**
 * The phone checks: what makes a page hard to use on a phone. The owner's
 * rules for the whole site (requirement 13): nothing wider than the screen,
 * controls at least 40px tall, no field with text under 16px (an iPhone
 * zooms the page in on one), and no text under 11px.
 *
 * Each function reads a document laid out at a phone's width and says, in
 * words, what is wrong; an empty list means nothing is. They run in a
 * browser, in two places: the phone tests (e2e/z-mobile.spec.ts) hand them
 * to Playwright for every page of the site, and the page editor runs them on
 * a page's draft before it lets the page be published (requirement 24's
 * guard rails, src/components/site-editor/phone-check.ts).
 *
 * So that Playwright can send them into a page, each is complete in itself:
 * it uses nothing of this module or of any other, and reads the document it
 * is given, or the page's own when it is given none.
 */

/** What is wider than the screen. A box that scrolls sideways on purpose (a wide table inside its own frame) is allowed; the page itself is not. */
export function widerThanScreen(doc: Document = document): string[] {
  const view = doc.defaultView!;
  const limit = doc.documentElement.clientWidth + 1;
  const found: string[] = [];
  if (doc.documentElement.scrollWidth > limit) {
    found.push(`the page scrolls sideways (${doc.documentElement.scrollWidth}px wide on a ${limit - 1}px screen)`);
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("body *"))) {
    if (el.closest("nextjs-portal")) continue; // the development tools' own button
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right <= limit && rect.left >= -1) continue;
    const style = view.getComputedStyle(el);
    if (style.position === "fixed" || style.clipPath !== "none") continue; // overlays, and text kept for screen readers only
    let box = el.parentElement;
    let scrolls = false;
    while (box && !scrolls) {
      scrolls = /(auto|scroll|hidden)/.test(view.getComputedStyle(box).overflowX);
      box = box.parentElement;
    }
    if (scrolls) continue;
    // Named by its own words when it has some, as a person reads it; otherwise by its tag and classes.
    const words = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const what = words ? `"${words}"` : `<${el.tagName.toLowerCase()} class="${el.className}">`;
    found.push(rect.left < -1 ? `${what} starts ${Math.round(-rect.left)}px left of the screen` : `${what} reaches ${Math.round(rect.right)}px`);
  }
  return [...new Set(found)].slice(0, 6);
}

/**
 * Controls that are hard to use on a phone: shorter than 40px, or a text
 * field with text under 16px, which makes an iPhone zoom the whole page when
 * the field is touched and leave it zoomed.
 */
export function hardToTouch(doc: Document = document): string[] {
  const view = doc.defaultView!;
  const found: string[] = [];
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && view.getComputedStyle(el).visibility !== "hidden";
  };
  const name = (el: Element) =>
    (el.getAttribute("aria-label") || (el as HTMLElement).innerText || (el as HTMLInputElement).name || el.id || el.tagName).trim().slice(0, 40);
  for (const el of Array.from(doc.querySelectorAll("main button, main a.btn, main select, main textarea, main input, .site-nav button, .site-nav a"))) {
    if (!visible(el) || el.closest("nextjs-portal")) continue;
    const input = el as HTMLInputElement;
    if (el.tagName === "INPUT" && ["hidden", "checkbox", "radio"].includes(input.type)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 40) found.push(`"${name(el)}" is ${Math.round(rect.height)}px tall`);
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && parseFloat(view.getComputedStyle(el).fontSize) < 16) {
      found.push(`"${name(el)}" has ${view.getComputedStyle(el).fontSize} text: an iPhone zooms in on it`);
    }
  }
  return [...new Set(found)].slice(0, 10);
}

/** Text too small to read without zooming. */
export function tooSmallToRead(doc: Document = document): string[] {
  const view = doc.defaultView!;
  const found: string[] = [];
  // 4 is NodeFilter.SHOW_TEXT, written as the number so that nothing outside this function is needed.
  const walker = doc.createTreeWalker(doc.querySelector("main") ?? doc.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const el = node.parentElement;
    if (!el || text.length < 2 || el.closest("nextjs-portal")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const size = parseFloat(view.getComputedStyle(el).fontSize);
    if (size < 11) found.push(`"${text.slice(0, 30)}" is ${size}px`);
  }
  return [...new Set(found)].slice(0, 6);
}
