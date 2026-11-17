import { hardToTouch, tooSmallToRead, widerThanScreen } from "@/lib/site/phone-checks";
import { WEBSITE_CHECK_PARAM } from "@/lib/site/website-check";
import { previewUrl } from "./parts";

/**
 * The website editor's guard rails (requirement 24): before a change is
 * published it is drawn as visitors would get it, out of sight, at the width
 * of the smallest phone still in use and of an iPhone, and measured with the
 * same checks the phone tests use (src/lib/site/phone-checks.ts). A change
 * with a problem is not published; the editor says what the problem is.
 *
 * A page is checked by itself (`checkOnPhones`). A change of the design, or
 * of the header, menu and footer, reaches every page: it is checked on every
 * published page, the booking screens and the account, which the server lists
 * (`websiteCheckPaths`), with `checkWebsiteOnPhones`. Each is drawn as it
 * will be once this one change is published: with its draft, and everything
 * else as published, whatever other drafts are waiting
 * (src/lib/site/website-check.ts).
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

/**
 * Whether a part the server sends after the rest of the page has still to be
 * shown. React marks its place with a comment until it is: "$?" while it is on
 * its way, "$~" once it has arrived and waits to be shown with others. Once
 * every part is shown, each such comment reads "$".
 */
export function partStillComing(doc: Document): boolean {
  const walker = doc.createTreeWalker(doc.body ?? doc, 128 /* NodeFilter.SHOW_COMMENT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const mark = (node as Comment).data;
    if (mark === "$?" || mark === "$~") return true;
  }
  return false;
}

/**
 * Any page of the website, drawn: its header is fixed to the top by the site's
 * stylesheet, every part the server streams is shown, and nothing is still on
 * its way in the browser (a part still to come shows a `.spinner` in its place:
 * the booking screens draw themselves there). A page with nothing on it is
 * drawn too: an empty page fits any phone.
 */
export const pageDrawn: Drawn = (doc, view) => {
  const header = doc.querySelector(".site-nav");
  const main = doc.querySelector("main");
  if (!header || view.getComputedStyle(header).position !== "fixed" || !main) return false;
  if (partStillComing(doc)) return false;
  return !Array.from(main.querySelectorAll(".spinner")).some((spinner) => spinner.getClientRects().length > 0);
};

/**
 * `url` loaded in a frame `width` CSS pixels wide, out of sight; what the
 * checks find in it once it is `drawn`. A page that does not arrive in time is
 * asked for once more: a busy server is not a problem of the page. One that
 * fails twice is named (`name`) in what is thrown.
 */
async function checkAt(url: string, width: number, drawn: Drawn, name = "The page"): Promise<string[]> {
  try {
    return await checkOnce(url, width, drawn, name);
  } catch {
    try {
      return await checkOnce(url, width, drawn, name);
    } catch {
      throw new Error(`${name} did not finish loading for its check, twice.`);
    }
  }
}

async function checkOnce(url: string, width: number, drawn: Drawn, name: string): Promise<string[]> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = `The page at ${width}px, being checked`;
  // Inside the window, behind the editor and fully transparent: nothing of it shows, and the browser still draws it.
  // (A frame out of sight, or hidden, may not be drawn at all, and then its page never finishes showing itself.)
  frame.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:800px;border:0;opacity:0;z-index:-1;pointer-events:none`;
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} took too long to load for its check.`)), LOAD_MS);
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
    if (!doc || !view) throw new Error(`${name} could not be drawn for its check.`);
    // The page arrives in parts, and a part is shown by a script after the frame has loaded: wait until the page
    // is on screen, drawn by the site's stylesheet, before measuring it.
    await until(() => drawn(doc, view), LOAD_MS, `${name} could not be drawn for its check.`);
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

/** What the editor calls the pages that have a name of their own; any other is called by its address. */
const PAGE_NAMES: Record<string, string> = {
  "/": "the home page",
  "/book": "the booking page",
  "/book/photography": "the photography booking page",
  "/account": "the account",
};
const nameOf = (path: string) => PAGE_NAMES[path] ?? path;

/** The pages checked at an iPhone's width as well: the two with the most on them. Every page is checked at the narrowest. */
const ALSO_WIDER = new Set(["/", "/book"]);

/** Run `work` on every item, `at` at a time, keeping their order. */
async function inTurns<T, R>(items: T[], at: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(at, items.length) }, worker));
  return results;
}

/** What a change would break on phones (`problems`), and what pages already had wrong without it (`already`), in sentences. */
export interface WebsiteCheck {
  problems: string[];
  already: string[];
}

/** A problem without its numbers: the same problem when a change only moves it a few pixels. */
const kindOf = (problem: string) => problem.replace(/\d+(\.\d+)?/g, "#");

/**
 * What would be wrong on a phone once this change of the design (`design`)
 * or of the header, menu and footer (`frame`) is published: a sentence for
 * each width and set of pages with the same problems, "At 320px, on the home
 * page and the booking page: ...". The header and the footer are on every
 * page, so their problems are said once, for every page that has them.
 *
 * A page with a problem is measured again as visitors have it now: what it
 * had already is not the change's doing, and does not keep the change from
 * being published (`already`). Only what the change brings is in `problems`.
 */
export async function checkWebsiteOnPhones(scope: "design" | "frame", paths: readonly string[]): Promise<WebsiteCheck> {
  const jobs = CHECK_WIDTHS.flatMap((width) => paths.filter((path) => width === CHECK_WIDTHS[0] || ALSO_WIDER.has(path)).map((path) => ({ width, path })));
  const measure = (job: { width: number; path: string }, as: string) => {
    const name = nameOf(job.path);
    return checkAt(previewUrl(`${job.path}?${WEBSITE_CHECK_PARAM}=${as}`), job.width, pageDrawn, name.charAt(0).toUpperCase() + name.slice(1));
  };
  // Three at a time: each is a whole page in a frame of its own.
  const found = await inTurns(jobs, 3, (job) => measure(job, scope));
  const troubled = jobs.map((job, index) => ({ job, index })).filter(({ index }) => found[index].length > 0);
  const before = await inTurns(troubled, 3, ({ job }) => measure(job, "published"));
  const brought: string[][] = found.map(() => []);
  const had: string[][] = found.map(() => []);
  troubled.forEach(({ index }, at) => {
    const kinds = new Set(before[at].map(kindOf));
    for (const problem of found[index]) (kinds.has(kindOf(problem)) ? had : brought)[index].push(problem);
  });
  return { problems: grouped(jobs, brought), already: grouped(jobs, had) };
}

/** The problems found on each page, as a sentence for each width and set of pages that have the same ones. */
function grouped(jobs: { width: number; path: string }[], found: string[][]): string[] {
  const sentences: string[] = [];
  for (const width of CHECK_WIDTHS) {
    const checked = jobs.filter((job) => job.width === width).length;
    const groups: { problems: string[]; pages: string[] }[] = [];
    jobs.forEach((job, index) => {
      if (job.width !== width || found[index].length === 0) return;
      const same = groups.find((group) => group.problems.join("\n") === found[index].join("\n"));
      if (same) same.pages.push(nameOf(job.path));
      else groups.push({ problems: found[index], pages: [nameOf(job.path)] });
    });
    for (const group of groups) sentences.push(...said(`At ${width}px, on ${pagesListed(group.pages, checked)}`, group.problems));
  }
  return sentences;
}

/**
 * The pages a problem was found on, in a few words: "the home page and /rates";
 * "every page" when it is on all of them (a header is); "/a, /b, /c and 7 other
 * pages" when there are many.
 */
export function pagesListed(names: string[], checked: number): string {
  if (names.length > 2 && names.length === checked) return "every page";
  if (names.length > 4) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} other pages`;
  return listed(names);
}

/** "a", "a and b", "a, b and c". */
function listed(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The problems found at one place, as one sentence that starts with `where`; nothing when there are none. */
function said(where: string, problems: string[]): string[] {
  if (problems.length === 0) return [];
  return [`${where}: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? `; and ${problems.length - 4} more` : ""}.`];
}
