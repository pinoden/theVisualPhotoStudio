import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

const STUDIO_TZ = "America/New_York";
// The same folder name as outputDir in playwright.config.ts, so a second run keeps its own pictures.
const SHOTS_DIR = `test-results${/^[a-z0-9]{1,20}$/.test(process.env.E2E_NAME ?? "") ? `-${process.env.E2E_NAME}` : ""}/shots`;

function isoInStudio(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: STUDIO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Today's date where the studio is. */
export const todayInStudio = () => isoInStudio(new Date());

/** A studio-local date at least `minDays` ahead that is a weekday, or a Saturday. */
export function dateAhead(minDays: number, kind: "weekday" | "saturday" = "weekday"): string {
  for (let i = minDays; i < minDays + 14; i++) {
    const iso = isoInStudio(new Date(Date.now() + i * 86_400_000));
    const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (kind === "weekday" ? day >= 1 && day <= 5 : day === 6) return iso;
  }
  throw new Error("no matching date");
}

/**
 * Errors of the development build's own tooling, not of the site. A production
 * build has none of it. The browser tests leave out these messages; any other
 * error the browser reports fails the test.
 * - React's performance timeline sometimes measures a part of a page from
 *   before it started ("'\u200bBookings [Prerender]' cannot have a negative
 *   time stamp", seen when a signed-in client or staff member opens an owner's
 *   page).
 * - Next's development tools in WebKit, once (2026-11-20, during the font
 *   test of website.spec.ts; not brought about again): the chunk of their own
 *   hot-reload client failed to load ("ChunkLoadError: Failed to load chunk
 *   /_next/static/chunks/%5Bturbopack%5D_browser_dev_hmr-client_..."), and the
 *   development overlay's request for that error's stack was refused
 *   (".../__nextjs_original-stack-frames due to access control checks.").
 */
const frameworkNoise = (text: string) =>
  /^Failed to execute 'measure' on 'Performance': '.*' cannot have a negative time stamp\.?$/.test(text) ||
  /^ChunkLoadError: Failed to load chunk \/_next\/static\/chunks\/%5Bturbopack%5D_browser_dev_/.test(text) ||
  /\/__nextjs_original-stack-frames due to access control checks\.$/.test(text);

/**
 * WebKit's words for a request of the page that was cut off ("TypeError: Load
 * failed"). It reports one as an error of the page when the page is left while
 * the request is still coming in, such as the rest of a server action's answer
 * after its result is shown (2026-11-20: "Saved." was on the page, the test
 * opened the next one 450 ms later, and the answer was still streaming).
 * Chromium says nothing then. While the page is being left, it is the browser
 * leaving, not the site failing; at any other moment it fails the test.
 */
const CUT_OFF = "Load failed";

/**
 * A part of the site's own code that the page was still loading when it was left: WebKit cancels the download ("Load
 * request cancelled" in the trace), and the loader reports "Failed to load chunk /_next/static/chunks/… from module …"
 * as an error of the page, while the next page is on its way. Seen in CI's `webkit` on 2026-11-21: the page editor,
 * made a moment before, was still loading its text editor's code (prosemirror-view) when the test opened `/admin`, and
 * brought about again on 2026-11-22 in one run of three. Chromium says nothing then. Like `CUT_OFF`, it is left out
 * only while the page is being left.
 */
const cutOffChunk = (message: string) => /^(ChunkLoadError: )?Failed to load chunk \/_next\/static\/chunks\/\S+ from module /.test(message);

/**
 * WebKit's words for a fetch that a page started and then left before all of
 * its answer had come in: "Fetch API cannot load <address> due to access
 * control checks." (Playwright's WebKit cuts the message at the address's first
 * colon, so it starts "/localhost:<port>/".) A production build prefetches the
 * pages linked from the one shown, their page data (`?_rsc=`), and a test that
 * opens the next page at once cuts some off (2026-11-20: a prefetch answered
 * 200 was cut off by the next page, and reported 1.8 s later, once that page
 * had arrived). So it is not tied to leaving; it is kept to the framework's
 * page data from the site's own address. Chromium says nothing then.
 */
const cutOffPageData = (message: string) => /^\/?\/?localhost:\d+\/\S*[?&]_rsc=\S* due to access control checks\.$/.test(message);

/**
 * Watch a page for what its browser says went wrong, and report each problem:
 * errors of its scripts, and errors in its console (unless `consoleErrors` is
 * false). Left out: the development build's own (`frameworkNoise`), requests
 * the console says failed (pages that answer "not found" on purpose log one,
 * and the tests check what the page shows), and a request or a part of the
 * site's code cut off by leaving the page for another (`CUT_OFF`,
 * `cutOffChunk`, `cutOffPageData`). `where` follows "script
 * error" in a report: " on an iPad".
 */
export function watchBrowser(page: Page, report: (problem: string) => void, { where = "", consoleErrors = true } = {}) {
  // From the request for the next document until it is shown, the page is being left.
  let leaving = false;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) leaving = true;
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) leaving = false;
  });
  page.on("pageerror", (error) => {
    if (frameworkNoise(error.message) || cutOffPageData(error.message) || (leaving && (error.message === CUT_OFF || cutOffChunk(error.message)))) return;
    report(`script error${where}: ${error.message}`);
  });
  if (!consoleErrors) return;
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      report(`console error${where}: ${message.text().slice(0, 400)}`);
    }
  });
}

/**
 * Wait until the page has asked the server for nothing for a moment, as a person does without thinking between one
 * "Save" and the next. A production build prefetches the pages a screen links to each time that screen is drawn
 * again, so a second save pressed a tenth of a second after the first lands while the public pages are being drawn
 * for those prefetches. One drawn before the second save is written can be kept after it, with the old values, for
 * about a minute ("Known gaps" in ProjectLibrary.md; `webkit-production` failed on it twice on 2026-11-21). A test
 * that saves twice and then reads a public page calls this between the two. The development server prefetches
 * nothing, and this returns after `quietMs`.
 */
export async function requestsSettled(page: Page, quietMs = 500): Promise<void> {
  let last = Date.now();
  const seen = () => {
    last = Date.now();
  };
  page.on("request", seen);
  page.on("requestfinished", seen);
  page.on("requestfailed", seen);
  try {
    await expect.poll(() => Date.now() - last >= quietMs, { timeout: 15_000, intervals: [100] }).toBe(true);
  } finally {
    page.off("request", seen);
    page.off("requestfinished", seen);
    page.off("requestfailed", seen);
  }
}

/**
 * Follow a link to a page drawn when it is asked for, and wait for all of it,
 * as a person waits for a page to load. A production build shows such a page
 * as soon as its first part has come, and its address changes at once, while
 * the rest is still on its way (the framework fetches it with `RSC: 1`; a
 * prefetch adds `Next-Router-Prefetch`). WebKit cuts that off when the test
 * leaves at once with `page.goto`, and the framework then loads the page again
 * in full, over the one the test asked for ("Navigation ... is interrupted by
 * another navigation", 2026-11-20). Chromium says nothing then.
 */
export async function followLink(page: Page, link: Locator): Promise<void> {
  const href = await link.getAttribute("href");
  if (!href) throw new Error("followLink: the link has no address");
  const path = new URL(href, page.url()).pathname;
  const rest = page.waitForResponse((response) => {
    const headers = response.request().headers();
    return headers["rsc"] === "1" && !headers["next-router-prefetch"] && new URL(response.url()).pathname === path;
  });
  await link.click();
  await (await rest).finished();
}

type Answer = { status(): number; headers(): Record<string, string>; text(): Promise<string> } | null;

/*
 * On Vercel, and from the development server, an address with no page answers
 * at once with its own status code: 404, or 308 for an address that moved. A
 * production build that Next.js serves itself (E2E_BUILD, and `next start`
 * alike) sends a page's shell first, with a 200, and streams the "not found"
 * or the redirect after it (Next.js's guide, "Status codes": "Sending the
 * shell starts the response with a 200"). A missing page answers 404 from its
 * cache after that; an old address, 200 again, or from the cache a 308 with no
 * Location (Next.js 16.4.6, 2026-11-20). These two accept those, and nothing
 * else.
 */

/** Whether an answer is the website's "not found" page: never the page itself. */
export async function isNotFoundPage(answer: Answer): Promise<boolean> {
  if (!answer) return false;
  if (answer.status() === 404) return true;
  if (process.env.E2E_BUILD !== "1" || answer.status() !== 200) return false;
  const body = await answer.text();
  return body.includes('<meta name="robots" content="noindex"') && body.includes("This page could not be found.");
}

/**
 * Whether an answer sends the browser on to `to` for good: a 308 to it, or (E2E_BUILD) a page carrying the
 * framework's own permanent redirect to it, which its router follows in the browser. Follow it with a browser too.
 */
export async function isPermanentRedirect(answer: Answer, to: string): Promise<boolean> {
  if (!answer) return false;
  if (answer.status() === 308 && answer.headers()["location"] === to) return true;
  if (process.env.E2E_BUILD !== "1" || ![200, 308].includes(answer.status())) return false;
  return (await answer.text()).includes(`NEXT_REDIRECT;replace;${to};308;`);
}

/*
 * After an in-app navigation the framework keeps the previous pages in the
 * document, hidden, so their state survives going back. A plain text or label
 * locator would also match those hidden copies. These helpers only see what
 * is on screen. Role locators (getByRole) already ignore hidden elements.
 */
type Scope = Page | Locator;
export const onScreen = (locator: Locator) => locator.filter({ visible: true });
export const byLabel = (scope: Scope, label: string) => onScreen(scope.getByLabel(label, { exact: true }));
export const byText = (scope: Scope, text: string | RegExp) => onScreen(scope.getByText(text));

/**
 * What axe-core finds wrong on the page as it is now, against WCAG 2.1 A and
 * AA, one line for each kind of problem, naming up to three places. Colour
 * contrast is left out: see e2e/a11y.spec.ts. `exclude` leaves out parts of
 * the page that are not the site's own (the page editor's canvas is Puck's).
 */
export async function accessibilityProblems(page: Page, options: { exclude?: string[] } = {}): Promise<string[]> {
  // After a form is sent, the framework draws the page and puts its title back a moment later. Scanned in between,
  // a page that is about to have a title is reported without one; a page that never gets one fails here instead.
  await expect.poll(() => page.title(), { message: "the page has a title" }).not.toBe("");
  let builder = new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(["color-contrast"])
    // The development server's own button, which visitors never get.
    .exclude("nextjs-portal");
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const result = await builder.analyze();
  // The scan finishes in a blank page of its own, which it then closes. In WebKit a press 1 ms after that did nothing
  // (the membership test, 2026-11-21, HANDOFF.md "Now" 5), so the page under test is made the active one again first.
  await page.bringToFront();
  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}. At ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(" "))
        .join(", ")}${violation.nodes.length > 3 ? ` and ${violation.nodes.length - 3} more` : ""}`,
  );
}

/**
 * Save a full-page picture for a person to look at. Only when E2E_SHOTS is
 * set, and never allowed to fail a test: the pictures are a review aid.
 */
export async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.E2E_SHOTS) return;
  try {
    // caret "initial": the default hides the text cursor by editing the page's
    // inputs, which the framework then reports as a mismatch with the server's HTML.
    await page.screenshot({ path: `${SHOTS_DIR}/${name}.png`, fullPage: true, timeout: 15_000, caret: "initial" });
  } catch (error) {
    console.warn(`screenshot ${name} skipped:`, error instanceof Error ? error.message.split("\n")[0] : error);
  }
}

/** Read the newest email of one kind sent to an address, from the development outbox. */
export async function latestEmail(
  page: Page,
  kind: string,
  to: string,
): Promise<{ subject: string; body: string; replyTo: string | null }> {
  const outbox = await page.context().newPage();
  try {
    await outbox.goto("/dev/outbox");
    const card = outbox.locator(".admin-card", { hasText: `To ${to} · ${kind}` }).first();
    await expect(card).toBeVisible();
    return {
      subject: (await card.locator("h3").innerText()).trim(),
      body: await card.locator("pre").innerText(),
      replyTo: /Replies go to (\S+)/.exec(await card.innerText())?.[1] ?? null,
    };
  } finally {
    await outbox.close();
  }
}

/** Sign in with an emailed one-time code, the way a person would. */
export async function signIn(page: Page, email: string, next = "/account"): Promise<void> {
  await page.goto(`/account/sign-in?next=${encodeURIComponent(next)}`);
  await byLabel(page, "Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(byText(page, `We sent a 6-digit code to ${email}.`)).toBeVisible();
  const mail = await latestEmail(page, "login_code", email);
  const code = /code: (\d{6})/.exec(mail.subject)?.[1];
  if (!code) throw new Error(`no code in "${mail.subject}"`);
  await byLabel(page, "6-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

export const next = (page: Page) => page.getByRole("button", { name: /^Next/ }).click();
export const pickStudio = (page: Page, name: string) => onScreen(page.locator("label.studio-option", { hasText: name })).click();
/** The total row of the price summary currently on screen. */
export const totalRow = (scope: Scope) => onScreen(scope.locator(".price-row.total"));

export async function fillDetails(page: Page, customer: { name: string; email: string; phone: string }): Promise<void> {
  await byLabel(page, "Full name *").fill(customer.name);
  await byLabel(page, "Email address *").fill(customer.email);
  await byLabel(page, "Phone number *").fill(customer.phone);
}

/**
 * The policies step (the owner's brief of 2026-11-22, item 6): on to it from the details when not there yet, the
 * policies read to their end (the agreement cannot be ticked before), and agreed to.
 */
export async function agreeToPolicies(page: Page): Promise<void> {
  const step = page.getByRole("heading", { name: "Policies & booking form" });
  if (!(await step.isVisible())) await next(page);
  await expect(step).toBeVisible();
  const box = page.getByRole("region", { name: "Studio policies and booking terms" });
  await box.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  const agree = page.getByRole("checkbox", { name: /I have read and agree/ });
  await expect(agree).toBeEnabled();
  await agree.check();
}

/** Finish checkout and land on the booking page. Returns the booking reference. */
export async function confirmAndGetRef(page: Page, buttonName: RegExp | string): Promise<string> {
  await page.getByRole("button", { name: buttonName }).click();
  await page.waitForURL(/\/booking\/VS-[0-9A-Z]{6}\?t=/);
  await expect(page.getByRole("heading", { name: "Booking Confirmed" })).toBeVisible();
  return (await onScreen(page.locator(".booking-ref")).first().innerText()).trim();
}

/** The whole studio-first flow up to the payment step. */
export async function bookStudioFirstToPayment(
  page: Page,
  options: {
    studios: string[];
    date: string;
    duration: string;
    time: string;
    customer: { name: string; email: string; phone: string };
    code?: string;
    /** Add-ons to tick, by name: "Pet fee". */
    addons?: string[];
  },
): Promise<void> {
  await page.goto("/book");
  for (const studio of options.studios) await pickStudio(page, studio);
  await next(page);
  await byLabel(page, "Date").fill(options.date);
  await page.getByRole("button", { name: options.duration, exact: true }).click();
  await next(page);
  await page.getByRole("button", { name: options.time, exact: true }).click();
  await next(page);
  await fillDetails(page, options.customer);
  for (const addon of options.addons ?? []) await page.getByRole("checkbox", { name: new RegExp(addon) }).check();
  if (options.code) {
    await byLabel(page, "Have a code?").fill(options.code);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(byText(page, `Code ${options.code} applied.`)).toBeVisible();
  }
  await agreeToPolicies(page);
  await next(page);
}
