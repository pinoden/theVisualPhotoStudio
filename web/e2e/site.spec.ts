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
  todayInStudio,
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
const WITHDRAWN_DAY = dateAhead(31); // likewise, for the add-on withdrawn during checkout
const MOVE_FROM = dateAhead(38); // and for the discounted booking that is moved
const MOVE_TO = dateAhead(45);
const FREE_HOUR_DAY = dateAhead(52); // and for the bookings made with a free hour
const PHOTO_DAY = dateAhead(59); // and for the photography sessions

const jane = { name: "Jane Smith", email: "jane.e2e@example.com", phone: "407-555-0100" };
const bob = { name: "Bob Brown", email: "bob.e2e@example.com", phone: "407-555-0111" };
const OWNER = "owner@studio.test";
// The first owner has used up the three sign-in codes an address may ask for in 15 minutes.
const SECOND_OWNER = "owner2@studio.test";
// And so has the second, by the end of the run.
const THIRD_OWNER = "owner3@studio.test";
const STAFF = "sam.e2e@studio.test";

let rescheduleCode = "";
let freeHourCode = "";

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

  // Photography sessions are described, and booked online.
  await page.goto("/services");
  await expect(page.getByRole("heading", { name: "Professional Photography" })).toBeVisible();
  await expect(page.getByRole("row", { name: /2 hours/ })).toContainText("30");
  await shot(page, "02a-photography");
  await page.getByRole("link", { name: "Book a Photographer" }).click();
  await expect(page.getByRole("heading", { name: "Book a Photographer" })).toBeVisible();
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

  const loyalty = page.locator("details.faq-item", { hasText: "Do returning guests get anything?" });
  await loyalty.locator("summary").click();
  await expect(loyalty.locator(".faq-answer")).toContainText(
    "When you have visited us 5 times, on separate days, we email you a code for one free hour in any studio.",
  );
  await expect(loyalty.locator(".faq-answer")).toContainText("It is valid for 60 days.");

  const pets = page.locator("details.faq-item", { hasText: "Can I bring my pet?" });
  await pets.locator("summary").click();
  await expect(pets.locator(".faq-answer")).toContainText("Pets are welcome in Studio Dayglow only.");
  await expect(pets.locator(".faq-answer")).toContainText("Studio Blanche, Studio Paris and all common areas are pet-free.");
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

  // A message with paragraphs that fills the box to its limit is accepted whole. The browser sends each
  // line break as two characters, which once made the server refuse it and cut its end off.
  const long = "Hello.\n\n".repeat(50) + "x".repeat(3600);
  expect(long).toHaveLength(4000);
  await byLabel(page, "Your name").fill("Vera Visitor");
  await byLabel(page, "Email address").fill("vera.e2e@example.com");
  await byLabel(page, "Topic").selectOption({ label: "Photography session" });
  await byLabel(page, "Message").fill(long);
  await page.getByRole("button", { name: "Send Message" }).click();
  await expect(page.getByRole("heading", { name: "Message Sent" })).toBeVisible();
  expect((await latestEmail(page, "contact_message", OWNER)).body).toContain(`${"x".repeat(3600)}`);
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

test("a taken time is no longer offered, nor any time within 15 minutes of it", async ({ page }) => {
  await page.goto("/book");
  await pickStudio(page, "Studio Blanche");
  await next(page);
  await byLabel(page, "Date").fill(NEAR);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await expect(page.getByRole("button", { name: "12:00 PM", exact: true })).toBeVisible();
  // Blanche is booked from 10:00 to 11:00. An hour that overlaps it is not offered.
  for (const taken of ["9:15 AM", "10:00 AM", "10:45 AM"]) {
    await expect(page.getByRole("button", { name: taken, exact: true })).toHaveCount(0);
  }
  // Nor one that would leave less than 15 minutes between the two appointments.
  await expect(page.getByRole("button", { name: "9:00 AM", exact: true })).toHaveCount(0); // would end as the next begins
  await expect(page.getByRole("button", { name: "11:00 AM", exact: true })).toHaveCount(0); // would begin as the last ends
  // Start times come every 15 minutes: the first free one is a quarter past.
  await expect(page.getByRole("button", { name: "11:15 AM", exact: true })).toBeVisible();
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
  await expect(byText(page, /0 of 5 visits towards your next free hour/)).toBeVisible();
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

  // Staff can change the status label, from the day sheet. Bob has asked to move his booking.
  await row.getByRole("combobox", { name: "Status label for Bob Brown" }).selectOption({ label: "Reschedule Pending" });
  await row.getByRole("button", { name: "Set" }).click();
  await expect(byText(page, "Marked Reschedule Pending.")).toBeVisible();
  await expect(onScreen(page.locator(".status-reschedule_pending"))).toHaveText("Reschedule Pending");
  // A visit that has not started cannot be marked as finished.
  await page.getByRole("row", { name: /Bob Brown/ }).getByRole("combobox").selectOption({ label: "Completed" });
  await page.getByRole("row", { name: /Bob Brown/ }).getByRole("button", { name: "Set" }).click();
  await expect(onScreen(page.locator(".flash-error"))).toContainText("can be set once the appointment has started");

  // The appointment page: details, the label, and the history of its changes. Still no price and no contact details.
  await page.getByRole("link", { name: "Bob Brown" }).click();
  await expect(page.getByRole("heading", { name: "Bob Brown" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Booked/ })).toContainText("The customer");
  await expect(page.getByRole("row", { name: /Confirmed → Reschedule Pending/ })).toContainText(STAFF);
  const appointment = await onScreen(page.locator(".admin-main")).innerText();
  expect(appointment).not.toContain("$");
  expect(appointment).not.toContain(bob.email);
  // The second level of the admin has its own short menu.
  await expect(onScreen(page.locator(".admin-nav"))).toHaveText("CalendarDay sheet");
  await shot(page, "16b-staff-appointment");
  await page.getByRole("button", { name: "Confirmed", exact: true }).click();
  await expect(byText(page, "Marked Confirmed.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Reschedule Pending → Confirmed/ })).toContainText(STAFF);

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
  await expect(byText(page, bob.email)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  // Signing out loads a new document: nothing of the pages just visited stays behind, not even hidden.
  await expect(page.getByRole("link", { name: "Book Now" }).first()).toBeVisible();
  await expect(page.getByText(bob.email)).toHaveCount(0);
  await page.goto("/admin/bookings");
  await page.waitForURL(/\/account\/sign-in\?next=%2Fadmin%2Fbookings/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("the owners switch on what staff can do, and it applies at once", async ({ page }) => {
  await signIn(page, THIRD_OWNER, "/admin/staff");
  // What staff did is in the booking's history, with their address.
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  await page.getByRole("link", { name: "Bob Brown" }).first().click();
  await expect(page.getByRole("row", { name: /Confirmed → Reschedule Pending/ })).toContainText(STAFF);
  await expect(onScreen(page.locator(".admin-main"))).toContainText("$68");
  await expect(onScreen(page.locator(".admin-main"))).toContainText(bob.email);

  // Two switches: contact details and prices.
  await page.getByRole("link", { name: "Staff", exact: true }).click();
  await page.getByRole("checkbox", { name: "See customers' phone numbers and email addresses" }).check();
  await page.getByRole("checkbox", { name: "See what a booking cost" }).check();
  await page.getByRole("button", { name: "Save what staff can do" }).click();
  await expect(byText(page, "Saved. It applies to every member of staff from now on.")).toBeVisible();
  await shot(page, "17b-admin-staff-abilities");

  // Staff see both the next time they look. Nothing was redeployed.
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await signIn(page, STAFF, `/staff?date=${NEAR}`);
  await expect(page.getByRole("row", { name: /Bob Brown/ })).toContainText(bob.phone);
  await page.getByRole("link", { name: "Bob Brown" }).click();
  await expect(page.getByRole("heading", { name: "Bob Brown" })).toBeVisible();
  await expect(onScreen(page.locator(".admin-main"))).toContainText("$68");
  await expect(onScreen(page.locator(".admin-main"))).toContainText(bob.email);

  // Their calendar shows the days they may see, and says so for the others.
  await page.goto(`/admin/calendar?view=day&date=${NEAR}`);
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toBeVisible();
  await page.goto(`/admin/calendar?view=day&date=${FAR}`);
  await expect(byText(page, /None of these days is assigned to you/)).toBeVisible();
  await expect(page.getByRole("link", { name: "New booking" })).toHaveCount(0); // not switched on for staff
});

test("the calendar shows a day, a week and a month, one studio or all, and a booking is moved and made from it", async ({ page }) => {
  await signIn(page, THIRD_OWNER, `/admin/calendar?view=day&date=${NEAR}`);
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();

  // The day: a column for each studio, and Bob's hour in Studio Paris with its time and its status.
  const bobs = page.getByRole("link", { name: /Bob Brown/ });
  await expect(bobs).toContainText("10:00 AM – 11:00 AM");
  await expect(bobs).toContainText("Confirmed");
  for (const studio of ["Studio Blanche", "Studio Dayglow", "Studio Paris"]) {
    await expect(onScreen(page.locator(".cal-head")).getByText(studio)).toBeVisible();
  }
  await shot(page, "17c-calendar-day");

  // One studio at a time, or all of them.
  const filter = page.getByRole("navigation", { name: "Studio" });
  await filter.getByRole("link", { name: "Studio Blanche" }).click();
  await expect(page).toHaveURL(/studio=blanche/);
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toHaveCount(0);
  await filter.getByRole("link", { name: "Studio Paris" }).click();
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toBeVisible();
  await filter.getByRole("link", { name: "All studios" }).click();
  await expect(page).not.toHaveURL(/studio=/);

  // The week and the month show the same appointment.
  const views = page.getByRole("navigation", { name: "Calendar view" });
  await views.getByRole("link", { name: "Week" }).click();
  await expect(page).toHaveURL(/view=week/);
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toBeVisible();
  await shot(page, "17d-calendar-week");
  await views.getByRole("link", { name: "Month" }).click();
  await expect(page).toHaveURL(/view=month/);
  await expect(page.getByRole("link", { name: /Bob Brown/ }).first()).toBeVisible();
  await shot(page, "17e-calendar-month");

  // Forward a month, and back to today.
  const [year, month] = NEAR.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  await page.getByRole("link", { name: "Next month" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${nextMonth}`));
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`date=${todayInStudio()}`));

  // Open Bob's appointment from the calendar and move it to the afternoon. The studio needs the change,
  // so it does not count as Bob's own reschedule.
  await page.goto(`/admin/calendar?view=day&date=${NEAR}`);
  await page.getByRole("link", { name: /Bob Brown/ }).click();
  await expect(page.getByRole("heading", { name: "Bob Brown" })).toBeVisible();
  await byLabel(page, "New date").fill(NEAR);
  await page.getByRole("button", { name: "Show free times" }).click();
  await page.getByLabel(/Free start times on/).selectOption({ label: "2:00 PM – 3:00 PM" });
  await page.getByRole("checkbox", { name: /The client asked for this move/ }).uncheck();
  await page.getByRole("button", { name: "Move booking" }).click();
  await expect(byText(page, /Moved to .* The client has been emailed\./)).toBeVisible();
  await expect(onScreen(page.locator(".admin-card h3 .status-badge"))).toHaveText("Rescheduled");
  await expect(page.getByRole("row", { name: /Confirmed → Rescheduled/ })).toContainText("Moved from");
  expect((await latestEmail(page, "booking_moved", bob.email)).body).toContain("New time: ");
  await shot(page, "17f-appointment-moved");

  // A booking made for a client, from the calendar: no card, and the price is paid at the studio.
  await page.goto(`/admin/calendar?view=day&date=${NEAR}`);
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toContainText("2:00 PM – 3:00 PM");
  await page.getByRole("link", { name: "New booking" }).click();
  await page.getByRole("checkbox", { name: "Studio Dayglow" }).check();
  await byLabel(page, "Length").selectOption({ label: "1 hour" });
  await page.getByRole("button", { name: "Show free times" }).click();
  await page.getByLabel("Free start times").selectOption({ label: "4:00 PM – 5:00 PM" });
  await page.getByLabel("Client’s name").fill("Dana Diaz");
  await page.getByLabel("Client’s email").fill("dana.e2e@example.com");
  await page.getByLabel("Client’s phone").fill("407-555-0142");
  await page.getByRole("button", { name: "Book for the client" }).click();
  await expect(page.getByRole("heading", { name: "Dana Diaz" })).toBeVisible();
  await expect(byText(page, /Nothing was charged: the price is paid at the studio\./)).toBeVisible();
  await expect(onScreen(page.locator(".price-row.total"))).toContainText("To pay at the studio");
  expect((await latestEmail(page, "booking_confirmation", "dana.e2e@example.com")).body).toContain("To pay at the studio: $78");

  // It is on the calendar, in Studio Dayglow's column, like any other booking.
  await page.goto(`/admin/calendar?view=day&date=${NEAR}&studio=dayglow`);
  await expect(page.getByRole("link", { name: /Dana Diaz/ })).toContainText("4:00 PM – 5:00 PM");
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toHaveCount(0);
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

test("the owner changes an add-on's price and a studio's guest number, and customers see both", async ({ page }) => {
  await signIn(page, SECOND_OWNER, "/admin/studios");
  await expect(page.getByRole("heading", { name: "Studios & add-ons" })).toBeVisible();

  // A decimal comma is pointed out by the browser before anything is sent: it is never saved as $1,250.
  await onScreen(page.locator("#addon-pet-fee-price")).fill("12,50");
  await page.getByRole("button", { name: "Save Pet fee" }).click();
  await expect(onScreen(page.locator("#addon-pet-fee-price:invalid"))).toHaveCount(1);
  await expect(byText(page, "Add-on saved.")).toHaveCount(0);

  await onScreen(page.locator("#addon-pet-fee-price")).fill("45");
  await page.getByRole("button", { name: "Save Pet fee" }).click();
  await expect(byText(page, "Add-on saved.")).toBeVisible();

  // A description of several paragraphs, at the box's limit of 2,000 characters, is saved and keeps its paragraphs.
  const opening = "A vintage Parisian apartment.\n\nNatural light all day.\n\n";
  const description = opening + "x".repeat(2000 - opening.length);
  await onScreen(page.locator("#studio-paris-description")).fill(description);
  await onScreen(page.locator("#studio-paris-guests")).fill("5");
  await page.getByRole("button", { name: "Save Studio Paris" }).click();
  await expect(byText(page, "Studio saved.")).toBeVisible();
  await shot(page, "19-admin-studios");
  await page.goto("/studios");
  await expect(page.locator("p", { hasText: "A vintage Parisian apartment." })).toHaveCSS("white-space", "pre-line");

  await page.goto("/rates");
  await expect(page.getByRole("row", { name: /Pet fee/ })).toContainText("$45");
  await expect(page.locator(".rate-card", { hasText: "Studio Paris" })).toContainText("Up to 5 guests included.");
  await page.goto("/faq");
  const pets = page.locator("details.faq-item", { hasText: "Can I bring my pet?" });
  await pets.locator("summary").click();
  await expect(pets.locator(".faq-answer")).toContainText("A $45 pet fee applies");

  // The answer about pets follows what the owner says an add-on is for, whatever it is called.
  await page.goto("/admin/studios");
  await onScreen(page.locator("#addon-new-name")).fill("Animal guest");
  await onScreen(page.locator("#addon-new-price")).fill("30");
  await onScreen(page.locator("#addon-new-kind")).selectOption({ label: "Bringing a pet" });
  await onScreen(page.locator("#addon-new-studio")).selectOption({ label: "Studio Paris only" });
  await page.getByRole("button", { name: "Add add-on" }).click();
  await expect(byText(page, "Add-on added.")).toBeVisible();
  await page.goto("/faq");
  await pets.locator("summary").click();
  await expect(pets.locator(".faq-answer")).toContainText("Pets are welcome in Studio Dayglow and Studio Paris only.");
  await expect(pets.locator(".faq-answer")).toContainText("Studio Blanche and all common areas are pet-free.");
  await expect(pets.locator(".faq-answer")).toContainText("$45 for Studio Dayglow and $30 for Studio Paris");

  // A customer reaches the payment step with the pet fee on their booking...
  const shop = await page.context().newPage();
  await shop.goto("/book");
  await pickStudio(shop, "Studio Dayglow");
  await next(shop);
  await byLabel(shop, "Date").fill(WITHDRAWN_DAY);
  await shop.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(shop);
  await shop.getByRole("button", { name: "11:00 AM", exact: true }).click();
  await next(shop);
  await fillDetails(shop, bob);
  await shop.getByRole("checkbox", { name: /Pet fee/ }).check();
  await agreeToPolicies(shop);
  await next(shop);
  await expect(shop.getByRole("button", { name: "Confirm & pay $123" })).toBeVisible();

  // ...when the owner stops offering it. It disappears for customers, and stays in the admin.
  await page.goto("/admin/studios");
  await page.getByRole("button", { name: "Stop offering Pet fee" }).click();
  await expect(byText(page, /The add-on is no longer offered/)).toBeVisible();
  await expect(byText(page, "Not offered at the moment.")).toBeVisible();

  // The customer is told why, sees what is offered now, and books without it: they are not left stuck.
  await shop.getByRole("button", { name: "Confirm & pay $123" }).click();
  await expect(onScreen(shop.locator(".flash-error"))).toContainText("An add-on you chose is no longer offered.");
  await shop.getByRole("button", { name: "Confirm & pay $78" }).click();
  await shop.waitForURL(/\/booking\/VS-[0-9A-Z]{6}\?t=/);
  await expect(shop.getByRole("heading", { name: "Booking Confirmed" })).toBeVisible();
  await expect(totalRow(shop)).toContainText("$78");
  await shop.close();
  await page.goto("/rates");
  await expect(page.getByRole("heading", { name: "Studio Rates" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Pet fee/ })).toHaveCount(0);
  await page.goto("/faq");
  await pets.locator("summary").click();
  await expect(pets.locator(".faq-answer")).toContainText("Pets are welcome in Studio Paris only.");
});

test("a booking made with a discount code is moved without paying the discount a second time", async ({ page }) => {
  // The third and last sign-in code this address may ask for in one run.
  await signIn(page, SECOND_OWNER, "/admin/codes");
  await onScreen(page.locator("#code-value")).fill("10");
  await onScreen(page.locator("#code-email")).fill(bob.email);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const created = byText(page, /Code created: VS-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  await expect(created).toBeVisible();
  const discountCode = /VS-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(await created.innerText())![0];

  // While signed in: a free hour for Jane, usable twice, for the next test. The site sends one by itself
  // after five visits; the owner can also hand one out.
  await onScreen(page.locator("#code-kind")).selectOption({ label: "One free hour (one studio)" });
  await onScreen(page.locator("#code-email")).fill(jane.email);
  await onScreen(page.locator("#code-uses")).fill("2");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("row", { name: /1 hour free/ })).toContainText(jane.email);
  freeHourCode = /VS-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(await page.getByRole("row", { name: /1 hour free/ }).innerText())![0];
  expect(freeHourCode).not.toBe(discountCode);

  // Studio Paris for an hour is $68. The code takes 10% off: $61.20 is paid.
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Paris"],
    date: MOVE_FROM,
    duration: "1 hr",
    time: "3:00 PM",
    customer: bob,
    code: discountCode,
  });
  await expect(totalRow(page)).toContainText("$61.20");
  await confirmAndGetRef(page, "Confirm & pay $61.20");

  // Moving it gives a code for the whole $68: the discount code is used up and checkout takes one code.
  await page.getByRole("button", { name: "Reschedule" }).click();
  await expect(
    byText(page, /you will get a code worth \$68, valid for 90 days.* That is what you paid plus the \$6\.80 your discount code took off\./),
  ).toBeVisible();
  await page.getByRole("button", { name: "Yes, release it and send my code" }).click();
  await expect(byText(page, /Your code is worth \$68 /)).toBeVisible();
  const moveCode = (await onScreen(page.locator(".notice .booking-ref")).innerText()).trim();
  expect(moveCode).toMatch(/^MOVE-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  // The same booking a week later costs nothing more.
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Paris"],
    date: MOVE_TO,
    duration: "1 hr",
    time: "3:00 PM",
    customer: bob,
    code: moveCode,
  });
  await expect(byText(page, "Nothing to pay: your code covers this booking. No card is needed.")).toBeVisible();
  await expect(totalRow(page)).toContainText("$0");
  await confirmAndGetRef(page, "Confirm booking");
});

test("a free hour takes one hour off a booking of one studio, and is not for several studios", async ({ page }) => {
  // Two studios together: the code is refused, with the reason.
  await page.goto("/book");
  await pickStudio(page, "Studio Blanche");
  await pickStudio(page, "Studio Dayglow");
  await next(page);
  await byLabel(page, "Date").fill(FREE_HOUR_DAY);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await next(page);
  await fillDetails(page, jane);
  await byLabel(page, "Have a code?").fill(freeHourCode);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(
    byText(page, "A free hour is for one studio. It cannot be used when several studios are booked together."),
  ).toBeVisible();

  // One studio for an hour and a half: the hour is free ($88) and the other half hour is paid ($132 less $88).
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Blanche"],
    date: FREE_HOUR_DAY,
    duration: "1.5 hr",
    time: "10:00 AM",
    customer: jane,
    code: freeHourCode,
  });
  await expect(byText(page, `Free hour, code ${freeHourCode}`)).toBeVisible();
  await expect(totalRow(page)).toContainText("$44");
  await confirmAndGetRef(page, "Confirm & pay $44");
  await expect(page.locator(".price-row", { hasText: "Free hour" })).toContainText("-$88");
  await shot(page, "20-free-hour");

  // One studio for one hour: nothing to pay, and no card is asked for.
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Paris"],
    date: FREE_HOUR_DAY,
    duration: "1 hr",
    time: "2:00 PM",
    customer: jane,
    code: freeHourCode,
  });
  await expect(byText(page, "Nothing to pay: your code covers this booking. No card is needed.")).toBeVisible();
  await expect(totalRow(page)).toContainText("$0");
  await confirmAndGetRef(page, "Confirm booking");
});

test("a client without a photographer books a session, and the photographer cannot be booked twice", async ({ page }) => {
  // The way in is on the studio booking page.
  await page.goto("/book");
  const callout = page.getByRole("complementary", { name: "Don’t have a photographer?" });
  await expect(callout).toContainText(
    "No problem! You can book a professional photoshoot with our in-house photographer, including studio rental.",
  );
  await callout.getByRole("link", { name: "Book a Photographer" }).click();
  await expect(page.getByRole("heading", { name: "Book a Photographer" })).toBeVisible();

  // A session in Studio Blanche: its length, its price and what it includes.
  await pickStudio(page, "Studio Blanche");
  await next(page);
  await byLabel(page, "Date").fill(PHOTO_DAY);
  const oneHour = page.getByRole("button", { name: /1 hour · \$375/ });
  await expect(oneHour).toContainText("Studio included. 1–2 outfits, 20 edited images.");
  await oneHour.click();
  await next(page);
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await next(page);
  await fillDetails(page, jane);
  await agreeToPolicies(page);
  await next(page);
  await expect(byText(page, /Photography session, Studio Blanche, 1 hour/)).toBeVisible();
  await expect(totalRow(page)).toContainText("$375");
  await shot(page, "21-photography-pay");
  await confirmAndGetRef(page, "Confirm & pay $375");
  await expect(byText(page, /With our in-house photographer, studio included/)).toBeVisible();
  const mail = await latestEmail(page, "booking_confirmation", jane.email);
  expect(mail.body).toContain("Photography session with our in-house photographer, studio included: 1–2 outfits, 20 edited images.");

  // The photographer is taken from 10:00 to 11:00 and for 15 minutes after, whatever the studio.
  await page.goto("/book/photography");
  await pickStudio(page, "Studio Paris");
  await next(page);
  await byLabel(page, "Date").fill(PHOTO_DAY);
  await page.getByRole("button", { name: /1 hour · \$315/ }).click();
  await next(page);
  await expect(page.getByRole("button", { name: "11:15 AM", exact: true })).toBeVisible();
  for (const taken of ["9:15 AM", "10:00 AM", "11:00 AM"]) {
    await expect(page.getByRole("button", { name: taken, exact: true })).toHaveCount(0);
  }

  // Studio Paris itself is free at 10:00, for someone who brings their own photographer.
  await page.goto("/book");
  await pickStudio(page, "Studio Paris");
  await next(page);
  await byLabel(page, "Date").fill(PHOTO_DAY);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await expect(page.getByRole("button", { name: "10:00 AM", exact: true })).toBeVisible();

  // The owners block the photographer's afternoon. (The third and last sign-in code of this address.)
  await signIn(page, THIRD_OWNER, "/admin/photography");
  await byLabel(page, "Date").fill(PHOTO_DAY);
  await byLabel(page, "From").fill("13:00");
  await byLabel(page, "To").fill("16:00");
  await byLabel(page, "Note").fill("Wedding");
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(byText(page, "Time blocked. No session can be booked in it.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Wedding/ })).toContainText("1:00 PM");
  await shot(page, "22-admin-photography");

  // The session is on the calendar, marked as photography.
  await page.goto(`/admin/calendar?view=day&date=${PHOTO_DAY}`);
  await expect(page.getByRole("link", { name: /Jane Smith/ })).toContainText("Photography");

  // The blocked afternoon is gone from the sessions on offer, in a studio that is itself free all day.
  await page.goto("/book/photography");
  await pickStudio(page, "Studio Dayglow");
  await next(page);
  await byLabel(page, "Date").fill(PHOTO_DAY);
  await page.getByRole("button", { name: /1 hour · \$315/ }).click();
  await next(page);
  await expect(page.getByRole("button", { name: "11:45 AM", exact: true })).toBeVisible();
  for (const blocked of ["1:00 PM", "2:30 PM", "3:45 PM"]) {
    await expect(page.getByRole("button", { name: blocked, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "4:00 PM", exact: true })).toBeVisible();
});
