import { hardToTouch, tooSmallToRead, widerThanScreen } from "@/lib/site/phone-checks";
import { previewUrl } from "./parts";

/**
 * The website editor's guard rails (requirement 24): before a change is
 * published it is drawn as visitors would get it, out of sight, at the width
 * of the smallest phone still in use and of an iPhone, and measured with the
 * same checks the phone tests use (src/lib/site/phone-checks.ts). A change
 * with a problem is not published; the editor says what the problem is.
 *
 * A page is checked by itself (`checkOnPhones`). A change of the design, or
 * of the header, menu and footer, reaches every page: it is checked on the
 * home page and the booking page, drawn with the drafts as a preview draws
 * them (`checkWebsiteOnPhones`).
 *
 * In the browser only. It is a guard against a change that would break on a
 * phone, not a lock: the server publishes what an editor sends it.
 */

/** The widths a page is checked at: the first iPhone SE, and an iPhone. */
export const CHECK_WIDTHS = [320, 390] as const;

/** How long a page may take to load in its frame before the check gives up. */
const LOAD_MS = 30_000;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** Wait, a little at a time, until `ready` says so; give up with `failure` after `ms`. */
async function until(ready: () => boolean, ms: number, failure: string): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(failure);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Whether the page in a frame is drawn, by the site's stylesheet, and can be measured. */
type Drawn = (doc: Document, view: Window) => boolean;

const onScreen = (element: Element | null): element is Element => element !== null && element.getClientRects().length > 0;

/** A page's draft on the page editor's check route: `.blk-root` is a flow-root once the site's stylesheet applies. */
const draftDrawn: Drawn = (doc, view) => {
  const page = doc.querySelector("[data-phone-check]");
  return onScreen(page) && view.getComputedStyle(page).display === "flow-root";
};

/** A page of the website: its header, which the site's stylesheet fixes to the top, and `content`, on screen. */
const pageDrawn =
  (content: string): Drawn =>
  (doc, view) => {
    const header = doc.querySelector(".site-nav");
    return header !== null && view.getComputedStyle(header).position === "fixed" && onScreen(doc.querySelector(content));
  };

/** `url` loaded in a frame `width` CSS pixels wide, out of sight; what the checks find in it once it is `drawn`. */
async function checkAt(url: string, width: number, drawn: Drawn): Promise<string[]> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = `The page at ${width}px, being checked`;
  // Inside the window, behind the editor and fully transparent: nothing of it shows, and the browser still draws it.
  // (A frame out of sight, or hidden, may not be drawn at all, and then its page never finishes showing itself.)
  frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:800px;border:0;opacity:0;z-index:-1;pointer-events:none`;
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The page took too long to load for its check.")), LOAD_MS);
      frame.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    frame.src = url;
    document.body.appendChild(frame);
    await loaded;
    const doc = frame.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) throw new Error("The page could not be drawn for its check.");
    // The page arrives in parts, and a part is shown by a script after the frame has loaded: wait until the page
    // is on screen, drawn by the site's stylesheet, before measuring it.
    await until(() => drawn(doc, view), LOAD_MS, "The page could not be drawn for its check.");
    await doc.fonts.ready;
    await nextFrame();
    return [...widerThanScreen(doc), ...hardToTouch(doc), ...tooSmallToRead(doc)];
  } finally {
    frame.remove();
  }
}

/**
 * What would be wrong with the page at `url` on a phone: a sentence for each
 * width with a problem, "At 320px: ...". Empty when nothing is wrong. A
 * check that cannot be made throws.
 */
export async function checkOnPhones(url: string): Promise<string[]> {
  const sentences: string[] = [];
  for (const width of CHECK_WIDTHS) sentences.push(...said(`At ${width}px`, await checkAt(url, width, draftDrawn)));
  return sentences;
}

/**
 * The pages a change that reaches every page is checked on. Between them they
 * show every part of the design that can break a phone (headings, running
 * text, buttons, fields, cards), and the header and the footer.
 */
const WEBSITE_PAGES = [
  { path: "/", name: "the home page", drawn: pageDrawn(".blk-root") },
  // The booking screen draws itself in the browser: its first step is there once the choice of how to book is.
  { path: "/book", name: "the booking page", drawn: pageDrawn(".wizard-container .mode-toggle") },
] as const;

/**
 * What would be wrong on a phone with the website as its drafts make it (the
 * design, the header, menu and footer, and the pages): a sentence for each
 * page and width with a problem, "At 320px, on the home page: ...".
 */
export async function checkWebsiteOnPhones(): Promise<string[]> {
  const sentences: string[] = [];
  for (const width of CHECK_WIDTHS) {
    // The header and the footer are on every page: the same problems on both pages are said once, for both.
    const groups: { problems: string[]; pages: string[] }[] = [];
    for (const page of WEBSITE_PAGES) {
      const problems = await checkAt(previewUrl(page.path), width, page.drawn);
      if (problems.length === 0) continue;
      const same = groups.find((group) => group.problems.join("\n") === problems.join("\n"));
      if (same) same.pages.push(page.name);
      else groups.push({ problems, pages: [page.name] });
    }
    for (const group of groups) sentences.push(...said(`At ${width}px, on ${group.pages.join(" and ")}`, group.problems));
  }
  return sentences;
}

/** The problems found at one place, as one sentence that starts with `where`; nothing when there are none. */
function said(where: string, problems: string[]): string[] {
  if (problems.length === 0) return [];
  return [`${where}: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? `; and ${problems.length - 4} more` : ""}.`];
}
