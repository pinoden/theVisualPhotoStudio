import { expect, test } from "@playwright/test";
import {
  agreeToPolicies,
  bookStudioFirstToPayment,
  byLabel,
  byText,
  confirmAndGetRef,
  dateAhead,
  fillDetails,
  latestEmail,
  next,
  onScreen,
  pickStudio,
  shot,
  signIn,
  totalRow,
} from "./helpers";

/**
 * The site clicked through in a real browser, in the order a business day
 * might go. Tests share one database and build on each other, so they run
 * serially and a failure skips the rest.
 */
test.describe.configure({ mode: "serial" });

const NEAR = dateAhead(3); // inside the 7-day refund window
const FAR = dateAhead(10); // refundable
const LATER = dateAhead(17);
const SATURDAY = dateAhead(3, "saturday");
const DOOR_DAY = dateAhead(24); // a day no other test books

const jane = { name: "Jane Smith", email: "jane.e2e@example.com", phone: "407-555-0100" };
const bob = { name: "Bob Brown", email: "bob.e2e@example.com", phone: "407-555-0111" };
const OWNER = "owner@studio.test";
// The first owner has used up the three sign-in codes an address may ask for in 15 minutes.
const SECOND_OWNER = "owner2@studio.test";
const STAFF = "sam.e2e@studio.test";

let rescheduleCode = "";

// Any error the browser reports (a script error, a mismatch between the
// server's HTML and the page) fails the test that caused it.
let browserProblems: string[] = [];
test.beforeEach(({ page }) => {
  browserProblems = [];
  page.on("pageerror", (error) => browserProblems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    // Pages that deliberately answer "not found" log a failed request; that is expected.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      browserProblems.push(`console error: ${message.text().slice(0, 400)}`);
    }
  });
});
test.afterEach(() => {
  expect(browserProblems, "errors reported by the browser").toEqual([]);
});

test("public pages show the studios and the live price list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Where Every Frame/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Studio Blanche" })).toBeVisible();
  await expect(byText(page, "From $88/hour")).toBeVisible();
  await shot(page, "01-home");

  await page.goto("/rates");
  await expect(page.getByRole("heading", { name: "Studio Rates" })).toBeVisible();
  const blanche = page.locator(".rate-card", { hasText: "Studio Blanche" });
  await expect(blanche.getByRole("row", { name: /4 hours/ })).toContainText("$320");
  await expect(page.locator(".rate-card", { hasText: "Studio Dayglow" }).getByRole("row", { name: /8 hours/ })).toContainText("$540");
  await shot(page, "02-rates");

  await page.goto("/policies");
  await expect(byText(page, /7 or more days \(168 hours\)/)).toBeVisible();
  await page.goto("/studios");
  await expect(page.getByRole("heading", { name: "Studio Paris" })).toBeVisible();

  // Photography sessions are described, and asked for by message.
  await page.goto("/services");
  await expect(page.getByRole("heading", { name: "Professional Photography" })).toBeVisible();
  await expect(page.getByRole("row", { name: /2 hours/ })).toContainText("30");
  await shot(page, "02a-photography");
  await page.getByRole("link", { name: "Ask About a Session" }).click();
  await expect(page.getByRole("heading", { name: "Contact Us" })).toBeVisible();
});

test("guest information answers with the current rules and prices", async ({ page }) => {
  await page.goto("/faq");
  await expect(page.getByRole("heading", { name: "Guest Information" })).toBeVisible();

  // Answers are closed until asked for.
  const refunds = page.locator("details.faq-item", { hasText: "Can I cancel, and do I get a refund?" });
  await expect(refunds.locator(".faq-answer")).toBeHidden();
  await refunds.locator("summary").click();
  await expect(refunds.locator(".faq-answer")).toContainText("Cancel 7 days (168 hours) or more before your start time");
  await expect(refunds.locator(".faq-answer")).toContainText("less the 5% payment processing fee");

  const moving = page.locator("details.faq-item", { hasText: "Can I move my booking to another time?" });
  await moving.locator("summary").click();
  await expect(moving.locator(".faq-answer")).toContainText("Yes, once, until 24 hours before it starts.");

  const pets = page.locator("details.faq-item", { hasText: "Can I bring my pet?" });
  await pets.locator("summary").click();
  await expect(pets.locator(".faq-answer")).toContainText("Pets are welcome in Studio Dayglow only.");
  await expect(pets.locator(".faq-answer")).toContainText("A $40 pet fee applies");
  await shot(page, "02b-guest-information");

  // The menu leads here.
  await page.goto("/");
  await page.getByRole("link", { name: "Info ▾" }).click();
  await page.getByRole("link", { name: "Guest Information" }).first().click();
  await expect(page).toHaveURL(/\/faq$/);
});

test("a visitor's message reaches the owner, who can reply straight to the visitor", async ({ page }) => {
  await page.goto("/contact");
  await expect(page.getByRole("heading", { name: "Contact Us" })).toBeVisible();
  await expect(byText(page, "Mon–Fri: 9:00 AM – 7:00 PM")).toBeVisible();

  // An address the browser accepts and the server does not: nothing typed is lost.
  await byLabel(page, "Your name").fill("Vera Visitor");
  await byLabel(page, "Email address").fill("vera@nowhere");
  await byLabel(page, "Topic").selectOption({ label: "Photography session" });
  await byLabel(page, "Message").fill("Do you photograph newborns?");
  await page.getByRole("button", { name: "Send Message" }).click();
  await expect(onScreen(page.locator(".field-error"))).toHaveText("Please enter a valid email address.");
  await expect(byLabel(page, "Your name")).toHaveValue("Vera Visitor");
  await expect(byLabel(page, "Topic")).toHaveValue("photography");
  await expect(byLabel(page, "Message")).toHaveValue("Do you photograph newborns?");
  await shot(page, "02c-contact");

  await byLabel(page, "Email address").fill("vera.e2e@example.com");
  await page.getByRole("button", { name: "Send Message" }).click();
  await expect(page.getByRole("heading", { name: "Message Sent" })).toBeVisible();

  const mail = await latestEmail(page, "contact_message", OWNER);
  expect(mail.subject).toBe("Website message from Vera Visitor: Photography session");
  expect(mail.body).toContain("Vera Visitor <vera.e2e@example.com> wrote through the contact page.");
  expect(mail.body).toContain("Do you photograph newborns?");
  expect(mail.replyTo).toBe("vera.e2e@example.com");

  // The form can be used again.
  await page.getByRole("button", { name: "Send another message" }).click();
  await expect(byLabel(page, "Your name")).toHaveValue("");
});

test("books two studios together, starting from the studios", async ({ page }) => {
  await page.goto("/book");
  await shot(page, "03-book-start");
  await pickStudio(page, "Studio Blanche");
  await pickStudio(page, "Studio Dayglow");
  await next(page);

  await byLabel(page, "Date").fill(NEAR);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  // ($88 + $78) less the 20% two-studio discount
  await expect(totalRow(page)).toContainText("$132.80");
  await next(page);

  await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeVisible();
  await shot(page, "04-times-studio-first");
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await next(page);

  // Nothing is submitted until the customer has agreed to the policies.
  await fillDetails(page, jane);
  await next(page);
  await expect(onScreen(page.locator(".flash-error"))).toHaveText("Please agree to the studio policies to continue.");
  await agreeToPolicies(page);
  await shot(page, "05-details");
  await next(page);

  await expect(byText(page, /No card processor is connected/)).toBeVisible();
  const ref = await confirmAndGetRef(page, "Confirm & pay $132.80");
  expect(ref).toMatch(/^VS-[0-9A-Z]{6}$/);
  const card = page.locator(".confirmation-card");
  await expect(card.getByText("Studio Blanche", { exact: true })).toBeVisible();
  await expect(card.getByText("Studio Dayglow", { exact: true })).toBeVisible();
  await expect(totalRow(card)).toContainText("$132.80");
  await shot(page, "06-confirmation");

  const mail = await latestEmail(page, "booking_confirmation", jane.email);
  expect(mail.subject).toBe(`Booking confirmed: ${ref}`);
  expect(mail.body).toContain("Studio Blanche + Studio Dayglow");
});

test("a taken time is no longer offered, including the clean-up time around it", async ({ page }) => {
  await page.goto("/book");
  await pickStudio(page, "Studio Blanche");
  await next(page);
  await byLabel(page, "Date").fill(NEAR);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await expect(page.getByRole("button", { name: "12:00 PM", exact: true })).toBeVisible();
  for (const taken of ["9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM"]) {
    await expect(page.getByRole("button", { name: taken, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "9:00 AM", exact: true })).toHaveCount(0); // would end with no clean-up time
  await expect(page.getByRole("button", { name: "11:30 AM", exact: true })).toBeVisible();
});

test("starting from the time shows which studios are free, and books one", async ({ page }) => {
  await page.goto("/book");
  await page.getByRole("radio", { name: /I know when I want to come/ }).click();
  await byLabel(page, "Date").fill(NEAR);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);

  // Blanche and Dayglow are booked at 10:00, so only Paris is free then.
  await expect(page.getByRole("button", { name: /^10:00 AM/ })).toContainText("1 studio free");
  await expect(page.getByRole("button", { name: /^2:00 PM/ })).toContainText("3 studios free");
  await shot(page, "07-times-time-first");
  await page.getByRole("button", { name: /^10:00 AM/ }).click();
  await next(page);

  const option = (name: string) => onScreen(page.locator("label.studio-option", { hasText: name }));
  await expect(option("Studio Blanche")).toContainText("Not available at this time");
  await expect(option("Studio Dayglow")).toContainText("Not available at this time");
  await expect(option("Studio Paris")).toContainText("$68 for 1 hour");
  await shot(page, "08-studios-time-first");
  await pickStudio(page, "Studio Paris");
  await next(page);

  await fillDetails(page, bob);
  await agreeToPolicies(page);
  await next(page);
  await confirmAndGetRef(page, "Confirm & pay $68");
});

test("a customer signs in, sees their booking, and turns it into a reschedule code", async ({ page }) => {
  await signIn(page, jane.email);
  await expect(byText(page, `Signed in as ${jane.email}`)).toBeVisible();
  const card = onScreen(page.locator(".admin-card", { hasText: "Studio Blanche + Studio Dayglow" }));
  await expect(card).toBeVisible();
  // Bob's booking is not shown to Jane.
  await expect(byText(page.locator("main .container-sm"), "Studio Paris")).toHaveCount(0);
  await shot(page, "09-account");

  await card.getByRole("button", { name: "Reschedule" }).click();
  await expect(byText(card, /you will get a code worth \$132\.80, valid for 90 days/)).toBeVisible();
  await card.getByRole("button", { name: "Yes, release it and send my code" }).click();
  await expect(byText(card, /Your code is worth \$132\.80/)).toBeVisible();
  rescheduleCode = (await card.locator(".booking-ref").innerText()).trim();
  expect(rescheduleCode).toMatch(/^MOVE-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await shot(page, "10-reschedule-code");

  const mail = await latestEmail(page, "reschedule_code", jane.email);
  expect(mail.body).toContain(`Reschedule code: ${rescheduleCode}`);

  // The code is listed in the account from now on.
  await page.reload();
  await expect(byText(page, rescheduleCode)).toBeVisible();
  await expect(byText(page, "$132.80 credit from a rescheduled booking")).toBeVisible();
});

test("the released time is bookable again, and the code pays for a new booking with no card", async ({ page }) => {
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Blanche", "Studio Dayglow"],
    date: LATER,
    duration: "1 hr",
    time: "2:00 PM",
    customer: jane,
    code: rescheduleCode,
  });
  await expect(byText(page, "Nothing to pay: your code covers this booking. No card is needed.")).toBeVisible();
  await expect(totalRow(page)).toContainText("$0");
  await shot(page, "11-pay-with-code");
  await confirmAndGetRef(page, "Confirm booking");
  await expect(byText(page, "Paid with reschedule code")).toBeVisible();

  // Seventeen days ahead would normally be refundable. A moved booking is not.
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(byText(page, "No refund is due, because this booking was made with a reschedule code.")).toBeVisible();
  await page.getByRole("button", { name: "Keep my booking" }).click();
  await page.getByRole("button", { name: "Reschedule" }).click();
  await expect(byText(page, /already moved and cannot be moved again online/)).toBeVisible();

  // The code is spent.
  await page.goto("/book");
  await pickStudio(page, "Studio Paris");
  await next(page);
  await byLabel(page, "Date").fill(LATER);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await page.getByRole("button", { name: "9:00 AM", exact: true }).click();
  await next(page);
  await fillDetails(page, jane);
  await byLabel(page, "Have a code?").fill(rescheduleCode);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(byText(page, "That code has already been used.")).toBeVisible();
});

test("a code only works for the person it was sent to", async ({ page }) => {
  await page.goto("/book");
  await pickStudio(page, "Studio Paris");
  await next(page);
  await byLabel(page, "Date").fill(LATER);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await page.getByRole("button", { name: "9:00 AM", exact: true }).click();
  await next(page);
  await fillDetails(page, bob);
  await byLabel(page, "Have a code?").fill(rescheduleCode);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(byText(page, /belongs to a different email address/)).toBeVisible();
});

test("cancelling a week or more ahead refunds the card automatically", async ({ page }) => {
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: FAR, duration: "1 hr", time: "10:00 AM", customer: bob });
  await confirmAndGetRef(page, "Confirm & pay $68");

  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(
    byText(page, "You will be refunded $64.60 to your card. The 5% processing fee ($3.40) is not refundable."),
  ).toBeVisible();
  await shot(page, "12-cancel-confirm");
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(byText(page, "Your booking is cancelled. A refund of $64.60 is on its way to your card.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking Cancelled" })).toBeVisible();

  const toOwner = await latestEmail(page, "owner_refund_notice", OWNER);
  expect(toOwner.body).toContain("An automatic refund of $64.60 was sent");
});

test("the owner adds a staff member and assigns one day", async ({ page }) => {
  await signIn(page, OWNER, "/admin");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(byText(page, /Card payments are in test mode/)).toBeVisible();
  await shot(page, "13-admin-overview");

  await page.getByRole("link", { name: "Staff", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Staff", exact: true })).toBeVisible();
  await byLabel(page, "Email").fill(STAFF);
  await byLabel(page, "Name").fill("Sam");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(byText(page, "Staff member added.")).toBeVisible();

  const sam = onScreen(page.locator(".admin-card", { hasText: STAFF }));
  await expect(byText(sam, "No days assigned: this person sees nothing.")).toBeVisible();
  await byLabel(sam, "Assign a day").fill(NEAR);
  await sam.getByRole("button", { name: "Assign" }).click();
  await expect(byText(page, "Day assigned.")).toBeVisible();
  await shot(page, "14-admin-staff");

  // The owner's bookings list shows money; staff will not see any of it.
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  await expect(page.getByRole("row", { name: /Bob Brown/ }).first()).toContainText("$68");
  await shot(page, "15-admin-bookings");
});

test("staff see the day sheet of their assigned day and nothing else", async ({ page }) => {
  await signIn(page, STAFF);
  await page.getByRole("link", { name: "Staff day sheet" }).click();
  await expect(page.getByRole("heading", { name: "Day Sheet" })).toBeVisible();

  // The assigned day opens by default and lists Bob's Paris booking.
  const row = page.getByRole("row", { name: /Bob Brown/ });
  await expect(row).toContainText("10:00 AM – 11:00 AM");
  await expect(row).toContainText("Studio Paris");
  await shot(page, "16-staff-day-sheet");

  // No prices, no contact details.
  const table = await onScreen(page.locator("table.data-table")).innerText();
  expect(table).not.toContain("$");
  expect(table).not.toContain(bob.email);
  expect(table).not.toContain(bob.phone);

  // Any other day is refused, and so are the owner's pages.
  await page.goto(`/staff?date=${FAR}`);
  await expect(onScreen(page.locator(".flash-error"))).toContainText("is not assigned to you");
  await expect(byText(page, "Bob Brown")).toHaveCount(0);
  for (const path of ["/admin", "/admin/bookings", "/admin/prices", "/admin/staff"]) {
    await page.goto(path);
    await expect(byText(page, /could not be found/i)).toBeVisible();
    await expect(byText(page, "Studio Admin")).toHaveCount(0);
  }
});

test("a customer cannot open the staff or owner areas", async ({ page }) => {
  await signIn(page, bob.email);
  for (const path of ["/admin", "/admin/codes", "/staff"]) {
    await page.goto(path);
    await expect(byText(page, /could not be found/i)).toBeVisible();
  }
  // Signed out, the same pages ask to sign in instead of showing anything.
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.goto("/admin/bookings");
  await page.waitForURL(/\/account\/sign-in\?next=%2Fadmin%2Fbookings/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("the owner sets a weekend price and the booking screen charges it on Saturday only", async ({ page }) => {
  await signIn(page, OWNER, "/admin/prices");
  await byLabel(page, "Studio Blanche 1 hour weekend price").fill("120");
  await page.getByRole("button", { name: "Save Studio Blanche prices" }).click();
  await expect(byText(page, "Prices saved.")).toBeVisible();
  await expect(byLabel(page, "Studio Blanche 1 hour weekend price")).toHaveValue("120");
  await shot(page, "17-admin-prices");

  await page.goto("/book");
  await pickStudio(page, "Studio Blanche");
  await next(page);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await byLabel(page, "Date").fill(SATURDAY);
  await expect(totalRow(page)).toContainText("$120");
  await byLabel(page, "Date").fill(FAR);
  await expect(totalRow(page)).toContainText("$88");

  await page.goto("/rates");
  await expect(page.locator(".rate-card", { hasText: "Studio Blanche" }).getByRole("row", { name: /1 hour/ })).toContainText("$120");
});

test("the owner cancels a booking with a full refund and blocks a morning", async ({ page }) => {
  await signIn(page, OWNER, "/admin/bookings");
  const row = page.getByRole("row", { name: /Bob Brown/ }).first(); // Bob's Paris booking on the near date
  await row.getByText("Cancel", { exact: true }).click();
  await expect(byLabel(row, "Refund to card ($)")).toHaveValue("68");
  await row.getByRole("button", { name: "Cancel booking" }).click();
  await expect(byText(page, "Booking cancelled. $68 refunded to the card.")).toBeVisible();

  await page.getByRole("link", { name: "Hours & blocks" }).click();
  await expect(page.getByRole("heading", { name: "Hours & blocks" })).toBeVisible();
  await byLabel(page, "Studio Paris").check();
  await byLabel(page, "Date").fill(NEAR);
  await byLabel(page, "From").fill("09:00");
  await byLabel(page, "To").fill("12:00");
  await byLabel(page, "Note").fill("Repainting");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(byText(page, "Time blocked.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Repainting/ })).toContainText("Studio Paris");

  // The blocked morning is gone from the booking screen.
  await page.goto("/book");
  await pickStudio(page, "Studio Paris");
  await next(page);
  await byLabel(page, "Date").fill(NEAR);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await expect(page.getByRole("button", { name: "12:00 PM", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "11:30 AM", exact: true })).toHaveCount(0);
});

test("the owner sets how to get in, and only a customer with a confirmed booking is told", async ({ page }) => {
  const GETTING_IN = "Door code 4821#. Third floor, suite 301.";
  await signIn(page, SECOND_OWNER, "/admin/settings");
  await byLabel(page, "How customers get into the building").fill(GETTING_IN);
  await page.getByRole("button", { name: "Save getting-in text" }).click();
  await expect(byText(page, /Saved\. New confirmation emails/)).toBeVisible();

  // Public pages say that the email explains it, and never contain the text itself.
  await page.goto("/faq");
  await expect(byText(page, "How do I get into the building?")).toBeVisible();
  expect(await page.content()).not.toContain("4821");
  await page.goto("/book");
  await expect(page.getByRole("heading", { name: "Reserve Your Studio" })).toBeVisible();
  expect(await page.content()).not.toContain("4821");

  // A new booking's page and its confirmation email carry it.
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: DOOR_DAY, duration: "1 hr", time: "3:00 PM", customer: jane });
  await confirmAndGetRef(page, "Confirm & pay $68");
  await expect(byText(page, GETTING_IN)).toBeVisible();
  await shot(page, "18-getting-in");
  const mail = await latestEmail(page, "booking_confirmation", jane.email);
  expect(mail.body).toContain(`Getting in:\n${GETTING_IN}`);

  // Once the booking is cancelled, its page no longer shows it.
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page.getByRole("heading", { name: "Booking Cancelled" })).toBeVisible();
  await expect(byText(page, GETTING_IN)).toHaveCount(0);
});
