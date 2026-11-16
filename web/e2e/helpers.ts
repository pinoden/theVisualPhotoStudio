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

export const agreeToPolicies = (page: Page) => page.getByRole("checkbox", { name: /I have read and agree/ }).check();

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
