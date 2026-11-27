import { expect, test, type Page } from "@playwright/test";
import {
  accessibilityProblems,
  bookStudioFirstToPayment,
  byLabel,
  byText,
  confirmAndGetRef,
  dateAhead,
  latestEmail,
  onScreen,
  shot,
  signIn,
  watchBrowser,
} from "./helpers";
import { widerThanScreen as widerThanScreenIn } from "../src/lib/site/phone-checks";

/**
 * FAKE PAYMENT (temporary): the "Fake Payment" button in the three places a client pays, and what it leaves on the
 * owner's calendar. Delete this file with the button, and its owner in playwright.config.ts. It runs last (its name
 * sorts last) and books a day of its own.
 */
const OWNER = "owner18@studio.test";
const DAY = dateAhead(176);

let browserProblems: string[] = [];
test.beforeEach(({ page }) => {
  browserProblems = [];
  watchBrowser(page, (problem) => browserProblems.push(problem));
});
test.afterEach(() => {
  expect(browserProblems, "errors reported by the browser").toEqual([]);
});

const widerThanScreen = (page: Page) => page.evaluate(widerThanScreenIn as () => string[]);
const fakeButton = (page: Page) => page.getByRole("button", { name: "Fake Payment", exact: true });

test("a client books with the Fake Payment button, on a phone too, and the booking is on the owner's calendar, paid", async ({ page }) => {
  const fran = { name: "Fran Fake", email: "fran.fake.e2e@example.com", phone: "407-555-0141" };
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: DAY, duration: "2 hr", time: "10:00 AM", customer: fran });
  await expect(page.getByRole("button", { name: /^Confirm & pay/ })).toBeVisible();
  await expect(fakeButton(page)).toBeVisible();
  await expect(byText(page, /Fake Payment is for testing only/)).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
  await shot(page, "fake-payment-checkout");
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(fakeButton(page)).toBeVisible();
  expect(await widerThanScreen(page)).toEqual([]);
  await shot(page, "fake-payment-checkout-320");
  await page.setViewportSize({ width: 1280, height: 900 });
  const ref = await confirmAndGetRef(page, "Fake Payment");

  // The time is taken: the same day offers it no more.
  await page.goto("/book");
  await onScreen(page.locator("label.studio-option", { hasText: "Studio Paris" })).click();
  await page.getByRole("button", { name: /^Next/ }).click();
  await byLabel(page, "Date").fill(DAY);
  await page.getByRole("button", { name: "2 hr", exact: true }).click();
  await expect(page.getByRole("button", { name: "2:00 PM", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toHaveCount(0);

  await signIn(page, OWNER, `/admin/calendar?view=day&date=${DAY}`);
  await expect(page.getByRole("link", { name: /Fran Fake/ })).toBeVisible();
  await page.goto(`/admin/appointments/${ref}`);
  await expect(onScreen(page.locator("#payment"))).toContainText("Paid in full.");
});

test("a membership is bought with the Fake Payment button, and its hours pay for a booking", async ({ page }) => {
  const max = { name: "Mel Fakemember", email: "mel.fakemember.e2e@example.com", phone: "407-555-0142" };
  await page.goto("/memberships");
  await page.getByRole("link", { name: "Join: Studio Paris, 5 hours a month" }).click();
  await byLabel(page, "Full name *").fill(max.name);
  await byLabel(page, "Email address *").fill(max.email);
  await byLabel(page, "Phone number *").fill(max.phone);
  await page.getByRole("checkbox", { name: /membership terms/ }).check();
  expect(await accessibilityProblems(page)).toEqual([]);
  await fakeButton(page).click();
  await expect(page.getByRole("heading", { name: "Welcome! Your membership has started." })).toBeVisible();
  const code = (await onScreen(page.locator(".copy-code-text")).innerText()).trim();

  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: DAY, duration: "1 hr", time: "4:00 PM", customer: max, code });
  // Nothing is left to pay, so there is no payment to fake.
  await expect(byText(page, "Nothing to pay: your code covers this booking. No card is needed.")).toBeVisible();
  await expect(fakeButton(page)).toHaveCount(0);
});

test("a payment link is paid with the Fake Payment button", async ({ page }) => {
  await signIn(page, OWNER, "/admin/calendar/new");
  await page.getByRole("checkbox", { name: "Studio Blanche" }).check();
  await byLabel(page, "Date").fill(DAY);
  await byLabel(page, "Length").selectOption({ label: "1 hour" });
  await page.getByRole("button", { name: "Show free times" }).click();
  await page.getByLabel("Free start times").selectOption({ label: "11:00 AM – 12:00 PM" });
  await page.getByLabel("Client’s name").fill("Lee Link");
  await page.getByLabel("Client’s email").fill("lee.link.e2e@example.com");
  await page.getByLabel("Client’s phone").fill("407-555-0143");
  await page.getByRole("button", { name: "Book for the client" }).click();
  await expect(page.getByRole("heading", { name: "Lee Link" })).toBeVisible();
  await page.getByRole("button", { name: /^Email a payment link for/ }).click();
  await expect(byText(page, /A payment link for .* was emailed to the client\./)).toBeVisible();
  const mail = await latestEmail(page, "payment_link", "lee.link.e2e@example.com");
  const payPath = new URL(/https?:\/\/\S+\/pay\/[0-9a-f-]{36}/.exec(mail.body)![0]).pathname;

  await page.goto(payPath);
  await expect(page.getByRole("heading", { name: "Pay for Your Booking" })).toBeVisible();
  await expect(fakeButton(page)).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
  await shot(page, "fake-payment-link");
  await fakeButton(page).click();
  await expect(page.getByRole("heading", { name: "Payment Received" })).toBeVisible();
});
