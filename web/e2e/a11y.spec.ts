import { expect, test } from "@playwright/test";
import { accessibilityProblems, byLabel, dateAhead, fillDetails, next, pickStudio, signIn, watchBrowser } from "./helpers";

/**
 * Accessibility: what a screen reader, a keyboard and a person who enlarges
 * the text need, checked with axe-core against WCAG 2.1, levels A and AA, on
 * the public pages, on every step of a booking, on a customer's account and
 * on the pages of the admin.
 *
 * Colour contrast is left out. The brand's tan accent is known to fall short
 * as the colour of links and under white words on a button, and the colours
 * are the owners' choice: the design editor's readability list advises them.
 *
 * This file sorts first, so it runs on the database as the site was built. It
 * books nothing (the booking stops before it is paid), and signs in a
 * customer of its own and the eleventh owner, whom no other test uses.
 */

let browserProblems: string[] = [];
test.beforeEach(({ page }) => {
  browserProblems = [];
  watchBrowser(page, (problem) => browserProblems.push(problem));
});
test.afterEach(() => {
  expect(browserProblems, "errors reported by the browser").toEqual([]);
});

const PUBLIC_PAGES = ["/", "/studios", "/rates", "/services", "/faq", "/policies", "/memberships", "/contact", "/book", "/book/photography", "/account/sign-in"];

test("the public pages can be used with a screen reader and a keyboard", async ({ page }) => {
  test.setTimeout(180_000);
  for (const path of PUBLIC_PAGES) {
    await page.goto(path);
    await expect(page.locator("main h1, main h2").first()).toBeVisible();
    expect(await accessibilityProblems(page), path).toEqual([]);
  }
  // On a phone the menu folds behind a button, which opens it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(await accessibilityProblems(page), "the home page on a phone").toEqual([]);
  await page.locator(".site-nav").getByRole("button", { name: "Menu" }).click();
  expect(await accessibilityProblems(page), "the home page on a phone, with the menu open").toEqual([]);
});

test("every step of a booking can be used with a screen reader and a keyboard", async ({ page }) => {
  const check = async (step: string) => expect(await accessibilityProblems(page), step).toEqual([]);
  await page.goto("/book");
  await check("choosing the studios");
  await pickStudio(page, "Studio Blanche");
  await next(page);
  await byLabel(page, "Date").fill(dateAhead(73));
  await page.getByRole("button", { name: "2 hr", exact: true }).click();
  await check("choosing the date and the length");
  await next(page);
  await page.getByRole("button", { name: "11:00 AM", exact: true }).click();
  await check("choosing the time");
  await next(page);
  await fillDetails(page, { name: "Ada Access", email: "ada.access@example.com", phone: "407-555-0190" });
  await check("the client's details");
  // The policies step: the policies read to the end from the keyboard, and agreed to with the space bar.
  await next(page);
  await expect(page.getByRole("heading", { name: "Policies & booking form" })).toBeVisible();
  await check("the policies and the booking form");
  const agree = page.getByRole("checkbox", { name: /I have read and agree/ });
  await expect(agree).toBeDisabled();
  await page.getByRole("region", { name: "Studio policies and booking terms" }).focus();
  await page.keyboard.press("End");
  await expect(agree).toBeEnabled();
  await agree.focus();
  await page.keyboard.press("Space");
  await expect(agree).toBeChecked();
  await next(page);
  await expect(page.getByRole("button", { name: /^Confirm & pay/ })).toBeVisible();
  await check("the summary and the payment");
});

const ACCOUNT_PAGES = ["/account", "/account/appointments", "/account/rewards", "/account/membership", "/account/receipts"];
/**
 * Every page of the admin with nothing to choose first, and the day sheet. The
 * pages that need something chosen first (a booking, an appointment, a
 * customer, a receipt, a payment link, a collection, the page editor around
 * Puck's own canvas) are scanned where the other tests have made it, with
 * `accessibilityProblems`.
 */
const ADMIN_PAGES = [
  "/admin",
  "/admin/calendar",
  "/admin/calendar?view=week",
  "/admin/calendar?view=month",
  "/admin/calendar/new",
  "/admin/bookings",
  "/admin/customers",
  "/admin/prices",
  "/admin/studios",
  "/admin/hours",
  "/admin/availability",
  "/admin/staff",
  "/admin/codes",
  "/admin/memberships",
  "/admin/settings",
  "/admin/emails",
  "/admin/emails/booking_confirmation",
  "/admin/photography",
  "/admin/website",
  "/admin/website/design",
  "/admin/website/navigation",
  "/admin/website/media",
  "/admin/website/media/collections",
  "/admin/website/fonts",
  "/admin/website/pages",
  "/staff",
];

test("a customer's account and the admin can be used with a screen reader and a keyboard", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, "ada.access@example.com", "/account");
  for (const path of ACCOUNT_PAGES) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    expect(await accessibilityProblems(page), path).toEqual([]);
  }
  await page.context().clearCookies();
  await signIn(page, "owner11@studio.test", "/admin");
  for (const path of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    expect(await accessibilityProblems(page), path).toEqual([]);
  }
});
