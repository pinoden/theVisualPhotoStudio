import { hardToTouch, tooSmallToRead, widerThanScreen } from "@/lib/site/phone-checks";

/**
 * The page editor's guard rails (requirement 24): before a page is published
 * its draft is drawn as visitors would get it, out of sight, at the width of
 * the smallest phone still in use and of an iPhone, and measured with the
 * same checks the phone tests use (src/lib/site/phone-checks.ts). A page
 * with a problem is not published; the editor says what the problem is.
 *
 * In the browser only. It is a guard against a page that would break on a
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

/** `url` loaded in a frame `width` CSS pixels wide, out of sight; what the checks find in it. */
async function checkAt(url: string, width: number): Promise<string[]> {
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
    // is on screen, drawn by the site's stylesheet (`.blk-root` is a flow-root there), before measuring it.
    await until(
      () => {
        const page = doc.querySelector("[data-phone-check]");
        return page !== null && page.getClientRects().length > 0 && view.getComputedStyle(page).display === "flow-root";
      },
      LOAD_MS,
      "The page could not be drawn for its check.",
    );
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
  for (const width of CHECK_WIDTHS) {
    const problems = await checkAt(url, width);
    if (problems.length > 0) sentences.push(`At ${width}px: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? `; and ${problems.length - 4} more` : ""}.`);
  }
  return sentences;
}
