import { expect, type Page } from "@playwright/test";

const STUDIO_TZ = "America/New_York";

function isoInStudio(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: STUDIO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

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
 * Save a full-page picture for a person to look at. Only when E2E_SHOTS is
 * set, and never allowed to fail a test: the pictures are a review aid.
 */
export async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.E2E_SHOTS) return;
  try {
    await page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true, timeout: 15_000 });
  } catch (error) {
    console.warn(`screenshot ${name} skipped:`, error instanceof Error ? error.message.split("\n")[0] : error);
  }
}

/** Read the newest email of one kind sent to an address, from the development outbox. */
export async function latestEmail(page: Page, kind: string, to: string): Promise<{ subject: string; body: string }> {
  const outbox = await page.context().newPage();
  try {
    await outbox.goto("/dev/outbox");
    const card = outbox.locator(".admin-card", { hasText: `To ${to} · ${kind}` }).first();
    await expect(card).toBeVisible();
    return { subject: (await card.locator("h3").innerText()).trim(), body: await card.locator("pre").innerText() };
  } finally {
    await outbox.close();
  }
}

/** Sign in with an emailed one-time code, the way a person would. */
export async function signIn(page: Page, email: string, next = "/account"): Promise<void> {
  await page.goto(`/account/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByText(`We sent a 6-digit code to ${email}.`)).toBeVisible();
  const mail = await latestEmail(page, "login_code", email);
  const code = /code: (\d{6})/.exec(mail.subject)?.[1];
  if (!code) throw new Error(`no code in "${mail.subject}"`);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}

export const next = (page: Page) => page.getByRole("button", { name: /^Next/ }).click();
export const pickStudio = (page: Page, name: string) => page.locator("label.studio-option", { hasText: name }).click();

export async function fillDetails(page: Page, customer: { name: string; email: string; phone: string }): Promise<void> {
  await page.getByLabel("Full name *").fill(customer.name);
  await page.getByLabel("Email address *").fill(customer.email);
  await page.getByLabel("Phone number *").fill(customer.phone);
}

export const agreeToPolicies = (page: Page) => page.getByRole("checkbox", { name: /I have read and agree/ }).check();

/** Finish checkout and land on the booking page. Returns the booking reference. */
export async function confirmAndGetRef(page: Page, buttonName: RegExp | string): Promise<string> {
  await page.getByRole("button", { name: buttonName }).click();
  await page.waitForURL(/\/booking\/VS-[0-9A-Z]{6}\?t=/);
  await expect(page.getByRole("heading", { name: "Booking Confirmed" })).toBeVisible();
  return (await page.locator(".booking-ref").first().innerText()).trim();
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
  },
): Promise<void> {
  await page.goto("/book");
  for (const studio of options.studios) await pickStudio(page, studio);
  await next(page);
  await page.getByLabel("Date").fill(options.date);
  await page.getByRole("button", { name: options.duration, exact: true }).click();
  await next(page);
  await page.getByRole("button", { name: options.time, exact: true }).click();
  await next(page);
  await fillDetails(page, options.customer);
  if (options.code) {
    await page.getByLabel("Have a code?").fill(options.code);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(`Code ${options.code} applied.`)).toBeVisible();
  }
  await agreeToPolicies(page);
  await next(page);
}
