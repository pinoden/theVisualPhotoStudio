import { expect, test } from "@playwright/test";
import {
  accessibilityProblems,
  agreeToPolicies,
  bookStudioFirstToPayment,
  byLabel,
  byText,
  confirmAndGetRef,
  dateAhead,
  fillDetails,
  frameworkNoise,
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
const FAR = dateAhead(15); // refundable: more than 7 days ahead
const LATER = dateAhead(21);
const SATURDAY = dateAhead(3, "saturday");
const DOOR_DAY = dateAhead(24); // a day no other test books
const WITHDRAWN_DAY = dateAhead(31); // likewise, for the add-on withdrawn during checkout
const MOVE_FROM = dateAhead(38); // and for the discounted booking that is moved
const MOVE_TO = dateAhead(45);
const FREE_HOUR_DAY = dateAhead(52); // and for the bookings made with a free hour
const PHOTO_DAY = dateAhead(59); // and for the photography sessions
const LOST_DAY = dateAhead(66); // and for the booking whose answer is lost on the way
const REFUSED_DAY = dateAhead(73); // and for the booking whose refund the card processor refuses
const EMAIL_DAY = dateAhead(129); // and for the booking whose confirmation the owners reworded
const MEMBER_DAY = dateAhead(143); // and for the booking a membership's hours pay for

const jane = { name: "Jane Smith", email: "jane.e2e@example.com", phone: "407-555-0100" };
const bob = { name: "Bob Brown", email: "bob.e2e@example.com", phone: "407-555-0111" };
const OWNER = "owner@studio.test";
// The first owner has used up the three sign-in codes an address may ask for in 15 minutes.
const SECOND_OWNER = "owner2@studio.test";
// And so has the second, by the end of the run.
const THIRD_OWNER = "owner3@studio.test";
// And the third. This one looks customers up.
const FIFTH_OWNER = "owner5@studio.test";
// This one rewords an email, changes a membership plan and gives a member an hour.
const EMAILS_OWNER = "owner13@studio.test";
const STAFF = "sam.e2e@studio.test";
const MANAGER = "mia.e2e@studio.test";

let rescheduleCode = "";
// Three free hours the owner hands Jane: two are used in a later test, the third stays available.
let freeHourCodes: string[] = [];

// Any error the browser reports (a script error, a mismatch between the
// server's HTML and the page) fails the test that caused it.
let browserProblems: string[] = [];
test.beforeEach(({ page }) => {
  browserProblems = [];
  page.on("pageerror", (error) => {
    if (!frameworkNoise(error.message)) browserProblems.push(`script error: ${error.message}`);
  });
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
  // For search engines and shared links: the studio as a business, from the admin's details, and the page's own title.
  const business = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}");
  expect(business).toMatchObject({ "@type": "LocalBusiness", name: "The Visuals Photo Studio", telephone: "(407) 663-6109" });
  expect(business.address).toMatchObject({ addressLocality: "Winter Park", addressRegion: "FL", postalCode: "32792" });
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "The Visuals Photo Studio | Winter Park, FL");
  // The website's own address, made whole with SITE_URL.
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /^http:\/\/localhost:\d+\/?$/);

  await page.goto("/rates");
  await expect(page.getByRole("heading", { name: "Studio Rates" })).toBeVisible();
  const blanche = page.locator(".rate-card", { hasText: "Studio Blanche" });
  await expect(blanche.getByRole("columnheader", { name: /Mon–Fri/i })).toBeVisible();
  await expect(blanche.getByRole("columnheader", { name: /Sat–Sun/i })).toBeVisible();
  await expect(blanche.getByRole("row", { name: /1\.5 hours/ })).toContainText("$142.50");
  await expect(blanche.getByRole("row", { name: /4 hours/ })).toContainText("$320");
  await expect(blanche.getByRole("row", { name: /4 hours/ })).toContainText("$345");
  await expect(page.locator(".rate-card", { hasText: "Studio Dayglow" }).getByRole("row", { name: /8 hours/ })).toContainText("$540");
  await shot(page, "02-rates");

  await page.goto("/policies");
  const afterHours = byText(page, /After-hours bookings are available by request/);
  await expect(afterHours.getByRole("link", { name: "contact form" })).toHaveAttribute("href", "/contact");
  // The terms follow the settings: 7 days for a rental (the owner's answer of 2026-11-17) and a 5% fee.
  await expect(byText(page, /Cancellations made 7 days \(168 hours\) or more before the appointment/)).toBeVisible();
  // Food and drinks stay outside the studios (the same answers).
  await expect(byText(page, "Food and drinks are not allowed inside the studios.")).toBeVisible();
  await expect(byText(page, /excluding the non-refundable payment processing fee \(5%\)/)).toBeVisible();
  await expect(byText(page, /Sessions are booked at least 14 days ahead\./)).toBeVisible();
  await expect(byText(page, /A pet fee of \$40 applies per reservation.* If your pet does not come, the fee is returned to you as\s+studio credit/)).toBeVisible();
  await page.goto("/studios");
  await expect(page.getByRole("heading", { name: "Studio Paris" })).toBeVisible();

  // Photography sessions are described, and booked online.
  await page.goto("/services");
  await expect(page.getByRole("heading", { name: "Professional Photography" })).toBeVisible();
  await expect(page.getByRole("row", { name: /2 hours/ })).toContainText("30");
  await expect(byText(page, /Please book at least 14 days ahead\./)).toBeVisible();
  await shot(page, "02a-photography");
  await page.getByRole("link", { name: "Book a Photographer" }).click();
  await expect(page.getByRole("heading", { name: "Book a Photographer" })).toBeVisible();
});

test("guest information answers with the current rules and prices", async ({ page }) => {
  await page.goto("/faq");
  await expect(page.getByRole("heading", { name: "Guest Information" })).toBeVisible();
  // A link to it, shared, says what it is.
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Guest Information");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/faq$/);

  // Answers are closed until asked for.
  const refunds = page.locator("details.faq-item", { hasText: "Can I cancel, and do I get a refund?" });
  await expect(refunds.locator(".faq-answer")).toBeHidden();
  await refunds.locator("summary").click();
  await expect(refunds.locator(".faq-answer")).toContainText("Cancel 7 days (168 hours) or more before your start time");
  await expect(refunds.locator(".faq-answer")).toContainText("less the 5% payment processing fee");

  const moving = page.locator("details.faq-item", { hasText: "Can I move my booking to another time?" });
  await moving.locator("summary").click();
  await expect(moving.locator(".faq-answer")).toContainText("Yes, until 24 hours before it starts.");
  await expect(moving.locator(".faq-answer")).toContainText("You can move a booking once free of charge. Moving it again costs $20 each time, which is taken off the code.");

  const loyalty = page.locator("details.faq-item", { hasText: "Do returning guests get anything?" });
  await loyalty.locator("summary").click();
  await expect(loyalty.locator(".faq-answer")).toContainText(
    "When you have visited us 5 times, on separate days, we email you a code for one free hour in any studio.",
  );
  await expect(loyalty.locator(".faq-answer")).toContainText("It is valid for 90 days.");
  await expect(loyalty.locator(".faq-answer")).toContainText("and neither does a photography session with our photographer");

  const pets = page.locator("details.faq-item", { hasText: "Can I bring my pet?" });
  await pets.locator("summary").click();
  await expect(pets.locator(".faq-answer")).toContainText("Pets are welcome in Studio Dayglow only.");
  await expect(pets.locator(".faq-answer")).toContainText("The other studios and all common areas are pet-free.");
  await expect(pets.locator(".faq-answer")).toContainText("A pet fee of $40 applies");
  await shot(page, "02b-guest-information");

  // The menu leads here.
  await page.goto("/");
  await page.getByRole("button", { name: "Info" }).click();
  await page.getByRole("link", { name: "Guest Information" }).first().click();
  await expect(page).toHaveURL(/\/faq$/);
});

test("a visitor's message reaches the owner, who can reply straight to the visitor", async ({ page }) => {
  await page.goto("/book");
  await byText(page, /After-hours bookings are available by request/).getByRole("link", { name: "contact form" }).click();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(page.getByRole("heading", { name: "Contact Us" })).toBeVisible();
  await expect(byText(page, "Mon–Fri: 9:00 AM – 7:00 PM")).toBeVisible();

  // An address the server would refuse is refused by the browser first, by the same rule: the form is not sent.
  await byLabel(page, "Your name").fill("Vera Visitor");
  const email = byLabel(page, "Email address");
  await email.fill("vera@nowhere");
  await byLabel(page, "Topic").selectOption({ label: "Photography session" });
  await byLabel(page, "Message").fill("Do you photograph newborns?");
  await page.getByRole("button", { name: "Send Message" }).click();
  expect(await email.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
  // Sent all the same, as a browser without that check would: the server refuses it, and nothing typed is lost.
  await email.evaluate((input: HTMLInputElement) => input.removeAttribute("pattern"));
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
  await byLabel(page, "Topic").selectOption({ label: "After-hours booking" });
  await byLabel(page, "Message").fill(long);
  await page.getByRole("button", { name: "Send Message" }).click();
  await expect(page.getByRole("heading", { name: "Message Sent" })).toBeVisible();
  const request = await latestEmail(page, "contact_message", OWNER);
  expect(request.subject).toBe("Website message from Vera Visitor: After-hours booking");
  expect(request.body).toContain("x".repeat(3600));
});

test("books two studios together, starting from the studios", async ({ page }) => {
  await page.goto("/book");
  await shot(page, "03-book-start");
  await pickStudio(page, "Studio Blanche");
  await pickStudio(page, "Studio Dayglow");
  await next(page);
  await expect(byText(page, /add Paris or choose a different combination/)).toBeVisible();
  await pickStudio(page, "Studio Blanche");
  await pickStudio(page, "Studio Paris");
  await next(page);

  await byLabel(page, "Date").fill(NEAR);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  // ($78 + $68) less the 20% two-studio discount
  await expect(totalRow(page)).toContainText("$116.80");
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
  const ref = await confirmAndGetRef(page, "Confirm & pay $116.80");
  expect(ref).toMatch(/^VS-[0-9A-Z]{6}$/);
  const card = page.locator(".confirmation-card");
  await expect(card.getByText("Studio Paris", { exact: true })).toBeVisible();
  await expect(card.getByText("Studio Dayglow", { exact: true })).toBeVisible();
  await expect(totalRow(card)).toContainText("$116.80");
  await shot(page, "06-confirmation");
  expect(await accessibilityProblems(page), "the client's booking page").toEqual([]);

  const mail = await latestEmail(page, "booking_confirmation", jane.email);
  expect(mail.subject).toBe(`Booking confirmed: ${ref}`);
  expect(mail.body).toContain("Studio Dayglow + Studio Paris");
});

test("a taken time is no longer offered, nor any time within 15 minutes of it", async ({ page }) => {
  await page.goto("/book");
  await pickStudio(page, "Studio Dayglow");
  await next(page);
  await byLabel(page, "Date").fill(NEAR);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await expect(page.getByRole("button", { name: "12:00 PM", exact: true })).toBeVisible();
  // Dayglow is booked from 10:00 to 11:00. An hour that overlaps it is not offered.
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

  // Dayglow and Paris are booked at 10:00, so only Blanche is free then.
  await expect(page.getByRole("button", { name: /^10:00 AM/ })).toContainText("1 studio free");
  await expect(page.getByRole("button", { name: /^2:00 PM/ })).toContainText("3 studios free");
  await shot(page, "07-times-time-first");
  await page.getByRole("button", { name: /^10:00 AM/ }).click();
  await next(page);

  const option = (name: string) => onScreen(page.locator("label.studio-option", { hasText: name }));
  await expect(option("Studio Paris")).toContainText("Not available at this time");
  await expect(option("Studio Dayglow")).toContainText("Not available at this time");
  await expect(option("Studio Blanche")).toContainText("$88 for 1 hour");
  await shot(page, "08-studios-time-first");
  await pickStudio(page, "Studio Blanche");
  await next(page);

  await fillDetails(page, bob);
  await agreeToPolicies(page);
  await next(page);
  await confirmAndGetRef(page, "Confirm & pay $88");
});

test("a customer signs in, sees their booking, and turns it into a reschedule code", async ({ page }) => {
  // The account opens on an overview: the next appointment, the stamps towards a free hour, and the ways on.
  await signIn(page, jane.email);
  await expect(byText(page, `Signed in as ${jane.email}`)).toBeVisible();
  const nextUp = onScreen(page.locator(".account-card", { hasText: "Your next appointment" }));
  await expect(nextUp).toContainText("Studio Dayglow + Studio Paris");
  await expect(nextUp).toContainText("10:00 AM – 11:00 AM (1 hour)");
  const loyalty = onScreen(page.locator(".account-card", { hasText: "My Loyalty Rewards" }));
  await expect(loyalty).toContainText("0 / 5");
  await expect(loyalty).toContainText("five more stamps until your free studio hour");
  const book = onScreen(page.locator(".account-book"));
  await expect(book.getByRole("link", { name: "Book a studio", exact: true })).toBeVisible();
  await expect(book.getByRole("link", { name: "Book a photographer", exact: true })).toBeVisible();
  await shot(page, "09-account");
  expect(await accessibilityProblems(page), "the account's overview, with an appointment").toEqual([]);

  // My Appointments: everything still to come, with its details and the ways to change it.
  await page.getByRole("link", { name: "View all appointments" }).click();
  await expect(page.getByRole("heading", { name: "My Appointments" })).toBeVisible();
  const card = onScreen(page.locator(".admin-card", { hasText: "Studio Dayglow + Studio Paris" }));
  await expect(card).toBeVisible();
  await expect(card).toContainText("Confirmed");
  // Bob's booking is not shown to Jane.
  await expect(byText(page.locator("main .container-sm"), "Studio Blanche")).toHaveCount(0);
  await shot(page, "09a-account-appointments");
  expect(await accessibilityProblems(page), "My Appointments, with an appointment").toEqual([]);

  await card.getByRole("button", { name: "Reschedule" }).click();
  await expect(byText(card, /you will get a code worth \$116\.80, valid for 90 days/)).toBeVisible();
  await card.getByRole("button", { name: "Yes, release it and send my code" }).click();
  await expect(byText(card, /Your code is worth \$116\.80/)).toBeVisible();
  rescheduleCode = (await card.locator(".booking-ref").innerText()).trim();
  expect(rescheduleCode).toMatch(/^MOVE-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await shot(page, "10-reschedule-code");

  const mail = await latestEmail(page, "reschedule_code", jane.email);
  expect(mail.body).toContain(`Reschedule code: ${rescheduleCode}`);

  // The booking that was released keeps its record, under Past, and can be found by its status.
  await page.getByRole("link", { name: /^Past/ }).click();
  await expect(page.getByRole("link", { name: "Past (1)" })).toBeVisible();
  const released = onScreen(page.locator("details.past-item", { hasText: "Studio Dayglow + Studio Paris" }));
  await expect(released).toContainText("Released for rescheduling");
  await byLabel(page, "Status").selectOption({ label: "Completed" });
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(byText(page, "No past appointment matches. Change the dates, the studio or the status.")).toBeVisible();
  await byLabel(page, "Status").selectOption({ label: "Rescheduled" });
  await byLabel(page, "Studio").selectOption({ label: "Studio Dayglow" });
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(byText(page, "1 appointment of 1 shown.")).toBeVisible();
  await expect(onScreen(page.locator("details.past-item"))).toHaveCount(1);
  expect(await accessibilityProblems(page), "past appointments, filtered").toEqual([]);

  // The code is listed in the account from now on: it is credit, not a reward.
  await page.getByRole("link", { name: "My Rewards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My Rewards", level: 1 })).toBeVisible();
  await expect(byText(page, rescheduleCode)).toBeVisible();
  await expect(byText(page, "$116.80 credit from a rescheduled booking")).toBeVisible();
  await expect(byText(page, /You have not earned a reward yet\. Your first free studio hour comes with your 5th stamp\./)).toBeVisible();
  expect(await accessibilityProblems(page), "My Rewards, with credit").toEqual([]);

  // What she paid has a receipt, on the screen and as a PDF file, and the year's payments are added up.
  await page.getByRole("link", { name: "Receipts & Payments", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Receipts & Payments", level: 1 })).toBeVisible();
  const year = todayInStudio().slice(0, 4);
  const summary = onScreen(page.locator(".admin-card", { hasText: `Your payments in ${year}` }));
  await expect(summary).toContainText("$116.80");
  await shot(page, "10a-account-receipts");
  expect(await accessibilityProblems(page), "Receipts & Payments, with a payment").toEqual([]);
  await page.getByRole("link", { name: "View", exact: true }).click();
  const receipt = onScreen(page.locator("article.receipt"));
  await expect(receipt).toContainText("Studio Dayglow");
  await expect(receipt).toContainText("Discount for booking several studios");
  await expect(receipt).toContainText("-$29.20");
  await expect(receipt).toContainText("Card, online");
  await expect(receipt).toContainText("Released for rescheduling");
  await shot(page, "10b-account-receipt");
  expect(await accessibilityProblems(page), "a receipt").toEqual([]);
  const ref = /VS-[0-9A-Z]{6}/.exec(page.url())![0];
  for (const path of [`/account/receipts/${ref}/pdf`, `/account/receipts/year/${year}/pdf`]) {
    const file = await page.request.get(path);
    expect(file.status(), path).toBe(200);
    expect(file.headers()["content-type"], path).toBe("application/pdf");
    expect((await file.body()).subarray(0, 5).toString("latin1"), path).toBe("%PDF-");
  }
  // Nobody else's receipt can be opened, and a year with no payments has no file.
  expect((await page.request.get("/account/receipts/VS-NOPE22/pdf")).status()).toBe(404);
  expect((await page.request.get("/account/receipts/year/1999/pdf")).status()).toBe(404);
});

test("the released time is bookable again, and the code pays for a new booking with no card", async ({ page }) => {
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Dayglow", "Studio Paris"],
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

  // Three weeks ahead would normally be refundable. A moved booking is not.
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(byText(page, "No refund is due, because this booking was made with a reschedule code.")).toBeVisible();
  await page.getByRole("button", { name: "Keep my booking" }).click();
  // Moving it again is offered for the $20 fee, which comes off the new code (the owner's answer of 2026-11-17).
  await page.getByRole("button", { name: "Reschedule" }).click();
  await expect(
    byText(page, /you will get a code worth \$[\d.,]+, valid for 90 days, to book a new time\. That is what you paid less the \$20 fee for moving a booking again\./),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, release it and send my code" })).toBeEnabled();
  await page.getByRole("button", { name: "Keep my booking" }).click();
  // Or she asks the studio to move it (question 20 of 2026-11-17): it keeps its time, marked Reschedule Pending.
  await page.getByRole("button", { name: "Ask the studio to move it" }).click();
  await byLabel(page, "When would suit you?").fill("Any weekday afternoon the week after");
  await page.getByRole("button", { name: "Send my request" }).click();
  await expect(byText(page, /Your request was sent\. The studio will contact you to agree a new time/)).toBeVisible();
  expect((await latestEmail(page, "move_request_received", jane.email)).body).toContain("Any weekday afternoon the week after");
  const toStudio = await latestEmail(page, "move_request_studio", OWNER);
  expect(toStudio.replyTo).toBe(jane.email);
  expect(toStudio.body).toContain("Any weekday afternoon the week after");
  await page.reload();
  await expect(byText(page, "You have asked the studio to move this booking. The studio will contact you to agree a new time.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask the studio to move it" })).toHaveCount(0);

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
  // Answered in a few milliseconds, but once, on the tester's busy machine, in 21 seconds (2026-11-16): the development
  // server can stall for a moment, and every test after this one in the file waits on it.
  await expect(byText(page, "That code has already been used.")).toBeVisible({ timeout: 60_000 });
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
  await expect(byText(page, "Your booking is cancelled. You will be refunded $64.60 to your card. The 5% processing fee ($3.40) is not refundable.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking Cancelled" })).toBeVisible();

  const toOwner = await latestEmail(page, "owner_refund_notice", OWNER);
  expect(toOwner.body).toContain("An automatic refund of $64.60 was sent");
});

test("a pet fee is not refunded to the card: it comes back as studio credit", async ({ page }) => {
  // Bob books Studio Dayglow with his dog, more than two weeks ahead: $78 for the hour and $40 for the pet.
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Dayglow"],
    date: FAR,
    duration: "1 hr",
    time: "3:00 PM",
    customer: bob,
    addons: ["Pet fee"],
  });
  await confirmAndGetRef(page, "Confirm & pay $118");

  // Cancelled in time: the studio's $78 goes back to the card less the fee, and the $40 comes back as credit.
  await page.getByRole("button", { name: "Cancel booking" }).click();
  await expect(
    byText(
      page,
      "You will be refunded $74.10 to your card. The 5% processing fee ($3.90) is not refundable. The pet fee ($40) is not refunded to your card: it is returned as studio credit, and we email you the code.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(
    byText(
      page,
      "Your booking is cancelled. You will be refunded $74.10 to your card. The 5% processing fee ($3.90) is not refundable. The pet fee ($40) is not refunded to your card: it is returned as studio credit, and we email you the code.",
    ),
  ).toBeVisible();
  const mail = await latestEmail(page, "booking_cancelled", bob.email);
  expect(mail.body).toContain("The pet fee of $40 is not refunded to a card. It is returned to you as studio credit:");
  const petCode = /Code: (PET-[0-9A-Z]{4}-[0-9A-Z]{4})/.exec(mail.body)?.[1];
  expect(petCode).toBeTruthy();

  // The credit pays for part of his next booking: Studio Paris for an hour is $68, so $28 is left to pay.
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: FAR, duration: "1 hr", time: "3:00 PM", customer: bob, code: petCode });
  await expect(byText(page, `Studio credit, code ${petCode}`)).toBeVisible();
  await expect(totalRow(page)).toContainText("$28");

  // Jane books the near date with her dog. The owner will find that the dog did not come (see the calendar test).
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Dayglow"],
    date: NEAR,
    duration: "1 hr",
    time: "12:15 PM",
    customer: jane,
    addons: ["Pet fee"],
  });
  await confirmAndGetRef(page, "Confirm & pay $118");
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
  await expect(byText(page, "Staff member added as Studio Attendant.")).toBeVisible();

  const sam = onScreen(page.locator(".admin-card", { hasText: STAFF }));
  await expect(byText(sam, "No days assigned: this person sees nothing.")).toBeVisible();
  await byLabel(sam, "Assign a day").fill(NEAR);
  await sam.getByRole("button", { name: "Assign" }).click();
  await expect(byText(page, "Day assigned.")).toBeVisible();
  await shot(page, "14-admin-staff");

  // The owner's bookings list shows money; staff will not see any of it.
  await page.getByRole("link", { name: "Bookings", exact: true }).click();
  await expect(page.getByRole("row", { name: /Bob Brown/ }).first()).toContainText("$88");
  await shot(page, "15-admin-bookings");
});

test("staff see the day sheet of their assigned day and nothing else", async ({ page }) => {
  await signIn(page, STAFF);
  await page.getByRole("link", { name: "Staff day sheet" }).click();
  await expect(page.getByRole("heading", { name: "Day Sheet" })).toBeVisible();

  // The assigned day opens by default and lists Bob's Blanche booking.
  const row = page.getByRole("row", { name: /Bob Brown/ });
  await expect(row).toContainText("10:00 AM – 11:00 AM");
  await expect(row).toContainText("Studio Blanche");
  await shot(page, "16-staff-day-sheet");

  // No prices. Phone numbers and emails are shown to staff unless the owners switch that off.
  const table = await onScreen(page.locator("table.data-table")).innerText();
  expect(table).not.toContain("$");
  expect(table).toContain(bob.phone);

  // Staff can change the status label, from the day sheet. Bob has asked to move his booking.
  await row.getByRole("combobox", { name: "Status label for Bob Brown" }).selectOption({ label: "Reschedule Pending" });
  await row.getByRole("button", { name: "Set" }).click();
  await expect(byText(page, "Marked Reschedule Pending.")).toBeVisible();
  await expect(onScreen(page.locator(".status-reschedule_pending"))).toHaveText("Reschedule Pending");
  // A visit that has not started cannot be marked as finished.
  await page.getByRole("row", { name: /Bob Brown/ }).getByRole("combobox").selectOption({ label: "Completed" });
  await page.getByRole("row", { name: /Bob Brown/ }).getByRole("button", { name: "Set" }).click();
  await expect(onScreen(page.locator(".flash-error"))).toContainText("can be set once the appointment has started");

  // The appointment page: details, the label, and the history of its changes. Still no price.
  await page.getByRole("link", { name: "Bob Brown" }).click();
  await expect(page.getByRole("heading", { name: "Bob Brown" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Booked/ })).toContainText("The customer");
  await expect(page.getByRole("row", { name: /Confirmed → Reschedule Pending/ })).toContainText(STAFF);
  const appointment = await onScreen(page.locator(".admin-main")).innerText();
  expect(appointment).not.toContain("$");
  expect(appointment).toContain(bob.email);
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
  const bobsPage = `/admin/customers/${encodeURIComponent(bob.email)}`;
  for (const path of ["/admin", "/admin/bookings", "/admin/prices", "/admin/staff", "/admin/customers", bobsPage]) {
    await page.goto(path);
    await expect(byText(page, /could not be found/i)).toBeVisible();
    await expect(byText(page, "Studio Admin")).toHaveCount(0);
  }
  // A customer's payments are not for staff to see, as a page or as a file.
  expect((await page.request.get(`${bobsPage}/receipts/year/${todayInStudio().slice(0, 4)}/pdf`)).status()).toBe(404);
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
  await expect(onScreen(page.locator(".admin-main"))).toContainText("$88");
  await expect(onScreen(page.locator(".admin-main"))).toContainText(bob.email);

  // Two switches: contact details off (they are on by default), and prices on.
  await page.getByRole("link", { name: "Staff", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "See customers' phone numbers and email addresses" })).toBeChecked();
  await page.getByRole("checkbox", { name: "See customers' phone numbers and email addresses" }).uncheck();
  await page.getByRole("checkbox", { name: "See what a booking cost" }).check();
  await page.getByRole("button", { name: "Save what attendants can do" }).click();
  await expect(byText(page, "Saved. It applies to every Studio Attendant from now on.")).toBeVisible();
  await shot(page, "17b-admin-staff-abilities");

  // Staff see both the next time they look. Nothing was redeployed.
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await signIn(page, STAFF, `/staff?date=${NEAR}`);
  await expect(page.getByRole("row", { name: /Bob Brown/ })).toBeVisible();
  expect(await onScreen(page.locator("table.data-table")).innerText()).not.toContain(bob.phone);
  await page.getByRole("link", { name: "Bob Brown" }).click();
  await expect(page.getByRole("heading", { name: "Bob Brown" })).toBeVisible();
  await expect(onScreen(page.locator(".admin-main"))).toContainText("$88");
  expect(await onScreen(page.locator(".admin-main")).innerText()).not.toContain(bob.email);

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

  // The day: a column for each studio, and Bob's hour in Studio Blanche with its time and its status.
  const bobs = page.getByRole("link", { name: /Bob Brown/ });
  await expect(bobs).toContainText("10:00 AM – 11:00 AM");
  await expect(bobs).toContainText("Confirmed");
  for (const studio of ["Studio Blanche", "Studio Dayglow", "Studio Paris"]) {
    await expect(onScreen(page.locator(".cal-head")).getByText(studio)).toBeVisible();
  }
  await shot(page, "17c-calendar-day");

  // One studio at a time, or all of them.
  const filter = page.getByRole("navigation", { name: "Studio" });
  await filter.getByRole("link", { name: "Studio Paris" }).click();
  await expect(page).toHaveURL(/studio=paris/);
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toHaveCount(0);
  await filter.getByRole("link", { name: "Studio Blanche" }).click();
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

  // A booking made for a client, from the calendar, with their dog: no card, and the price is paid at the studio.
  await page.goto(`/admin/calendar?view=day&date=${NEAR}`);
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toContainText("2:00 PM – 3:00 PM");
  await page.getByRole("link", { name: "New booking" }).click();
  await page.getByRole("checkbox", { name: "Studio Blanche" }).check();
  await page.getByRole("checkbox", { name: "Studio Dayglow" }).check();
  await byLabel(page, "Length").selectOption({ label: "1 hour" });
  await page.getByRole("button", { name: "Show free times" }).click();
  await expect(byText(page, /add Paris or choose a different combination/)).toBeVisible();
  await expect(page.getByLabel("Free start times")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Studio Blanche" }).uncheck();
  await page.getByRole("button", { name: "Show free times" }).click();
  await page.getByLabel("Free start times").selectOption({ label: "4:00 PM – 5:00 PM" });
  await page.getByLabel("Client’s name").fill("Dana Diaz");
  await page.getByLabel("Client’s email").fill("dana.e2e@example.com");
  await page.getByLabel("Client’s phone").fill("407-555-0142");
  // The add-ons of the booking screen are offered: those for any booking, and Dayglow's pet fee.
  // Dayglow alone takes 6 extra guests, at $5 each.
  await expect(page.getByRole("spinbutton", { name: "Extra guest" })).toHaveAttribute("max", "6");
  await expect(byText(page, "Up to 6 with this studio.")).toBeVisible();
  await page.getByRole("checkbox", { name: /Pet fee/ }).check();
  await page.getByRole("button", { name: "Book for the client" }).click();
  await expect(page.getByRole("heading", { name: "Dana Diaz" })).toBeVisible();
  await expect(byText(page, /Nothing was charged: the price is paid at the studio\./)).toBeVisible();
  await expect(onScreen(page.locator(".price-row.total"))).toContainText("To pay at the studio");
  expect((await latestEmail(page, "booking_confirmation", "dana.e2e@example.com")).body).toContain("To pay at the studio: $118");

  // Dana pays in cash at the studio, $78 for the hour and $40 for the dog, and the owner marks the booking as paid.
  await expect(byText(page, "$118 is still to pay.")).toBeVisible();
  await expect(byLabel(page, "Amount paid ($)")).toHaveValue("118");
  await byLabel(page, "How it was paid").selectOption({ label: "Cash" });
  await byLabel(page, "Note (optional)").fill("Paid at the desk");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(byText(page, /\$118 recorded\. The booking is paid in full\. The client has been emailed a confirmation\./)).toBeVisible();
  await expect(onScreen(page.locator("#payment"))).toContainText("Paid in full.");
  await expect(onScreen(page.locator(".price-row.total"))).toContainText("Paid at the studio");
  expect(await accessibilityProblems(page), "an appointment with a payment recorded and its history").toEqual([]);
  await expect(page.getByRole("row", { name: /\$118 · Cash/ })).toContainText(THIRD_OWNER);
  await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0); // nothing is owed any more
  const receipt = await latestEmail(page, "payment_received", "dana.e2e@example.com");
  expect(receipt.body).toContain("We received your payment of $118");
  expect(receipt.body).toContain("Your booking is paid in full.");
  await shot(page, "17g-marked-as-paid");

  // It is on the calendar, in Studio Dayglow's column, like any other booking.
  await page.goto(`/admin/calendar?view=day&date=${NEAR}&studio=dayglow`);
  await expect(page.getByRole("link", { name: /Dana Diaz/ })).toContainText("4:00 PM – 5:00 PM");
  await expect(page.getByRole("link", { name: /Bob Brown/ })).toHaveCount(0);

  // Jane booked this day with her dog, and the dog is not coming: the owner returns the pet fee as studio credit.
  await page.getByRole("link", { name: /Jane Smith/ }).click();
  await expect(page.getByRole("heading", { name: "Jane Smith" })).toBeVisible();
  await expect(byText(page, /This booking has a pet fee of \$40\. It is not refunded to a card\./)).toBeVisible();
  const appointmentPath = new URL(page.url()).pathname;
  await expect(page.getByRole("button", { name: /The pet did not come/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Go to Codes" }).click();
  await expect(byLabel(page, "Booking reference")).toHaveValue(appointmentPath.split("/").at(-1)!);
  await page.getByRole("button", { name: "Issue studio credit" }).click();
  await expect(page).toHaveURL((url) => url.pathname === appointmentPath);
  await expect(byText(page, /The pet fee of \$40 is now studio credit\. The client has been emailed the code PET-/)).toBeVisible();
  await expect(byText(page, /was returned to the client as studio credit, code/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Codes" })).toHaveCount(0);
  expect((await latestEmail(page, "pet_credit", jane.email)).body).toContain("the pet fee of $40 is returned to you as studio credit");
});

test("the owner sets a weekend price and the booking screen charges it on Saturday only", async ({ page }) => {
  await signIn(page, OWNER, "/admin/prices");
  await expect(byLabel(page, "Studio Blanche 1 hour weekend price")).toHaveValue("95");
  await expect(byLabel(page, "Studio Blanche 1.5 hours weekend price")).toHaveValue("142.50");
  await byLabel(page, "Studio Blanche 1 hour weekend price").fill("120");
  await page.getByRole("button", { name: "Save Studio Blanche prices" }).click();
  await expect(byText(page, "Prices saved.")).toBeVisible();
  await expect(byLabel(page, "Studio Blanche 1 hour weekend price")).toHaveValue("120");
  await shot(page, "17-admin-prices");
  // A price above the most a price can be ($100,000): the browser stops the form before it is sent, so nothing is
  // saved and nothing typed is lost. (The server refuses such a form whole too, naming the price.)
  await byLabel(page, "Studio Blanche 1 hour weekday price").fill("89");
  const tooMuch = byLabel(page, "Studio Blanche 1.5 hours weekday price");
  await tooMuch.fill("150000");
  await page.getByRole("button", { name: "Save Studio Blanche prices" }).click();
  expect(await tooMuch.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await expect(byLabel(page, "Studio Blanche 1 hour weekday price")).toHaveValue("89");

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
  const row = page.getByRole("row", { name: /Bob Brown/ }).first(); // Bob's Blanche booking on the near date
  await row.getByText("Cancel", { exact: true }).click();
  await expect(byLabel(row, "Refund to card ($)")).toHaveValue("88");
  await row.getByRole("button", { name: "Cancel booking" }).click();
  await expect(byText(page, "Booking cancelled. $88 refunded to the card.")).toBeVisible();

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

  // Public pages say that the email explains it, and never contain the text itself. (The code alone, 4821, can
  // turn up by chance inside one of the random ids a page carries; the text as written cannot.)
  await page.goto("/faq");
  await expect(byText(page, "How do I get into the building?")).toBeVisible();
  expect(await page.content()).not.toContain("Door code 4821#");
  await page.goto("/book");
  await expect(page.getByRole("heading", { name: "Reserve Your Studio" })).toBeVisible();
  expect(await page.content()).not.toContain("Door code 4821#");

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

test("the owners change an email's wording, and the next one is written in it until they go back to the site's", async ({ page }) => {
  const erin = { name: "Erin Hale", email: "erin.e2e@example.com", phone: "407-555-0122" };
  await signIn(page, EMAILS_OWNER, "/admin/emails");
  await expect(page.getByRole("row", { name: /Booking confirmed/ })).toContainText("The site's wording");
  await page.getByRole("link", { name: "Booking confirmed" }).click();
  await expect(page.getByRole("heading", { name: "Booking confirmed" })).toBeVisible();
  const text = byLabel(page, "Text");
  const preview = page.getByTestId("email-preview");
  await expect(preview).toContainText("Your booking at The Visuals Photo Studio is confirmed.");
  const original = await text.inputValue();
  const opening = "Your booking at {{studio_name}} is confirmed.";

  // A part the email does not have is named as it is typed, and nothing is saved until it is put right.
  await text.fill(original.replace(opening, `Thank you, {{frist_name}}! ${opening}`));
  await expect(byText(page, "{{frist_name}} is not one of this email's parts. The parts it has are listed beside the text.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await text.fill(original.replace(opening, `Thank you, {{first_name}}! ${opening}`));
  await expect(preview).toContainText("Thank you, Jane! Your booking at The Visuals Photo Studio is confirmed.");
  await shot(page, "19-email-editor");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(byText(page, "Saved. Emails sent from now on use this wording.")).toBeVisible();
  await expect(byText(page, /It is sent in your wording, saved .* by owner13@studio\.test\./)).toBeVisible();

  // The next confirmation is written in it, with the client's own details.
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: EMAIL_DAY, duration: "1 hr", time: "3:00 PM", customer: erin });
  const ref = await confirmAndGetRef(page, /^Confirm & pay \$/);
  const mail = await latestEmail(page, "booking_confirmation", erin.email);
  expect(mail.body).toContain(`Thank you, Erin! ${opening.replace("{{studio_name}}", "The Visuals Photo Studio")}`);
  expect(mail.body).toContain(`Reference: ${ref}`);

  // Back to the site's wording, which the emails after it are written in.
  await page.goto("/admin/emails/booking_confirmation");
  await page.getByRole("button", { name: "Use the site's wording" }).click();
  await page.getByRole("button", { name: "Yes, use the site's wording" }).click();
  await expect(byText(page, "Done. This email is sent in the site's wording again.")).toBeVisible();
  await expect(text).toHaveValue(original);
  await page.goto("/admin/emails");
  await expect(page.getByRole("row", { name: /Booking confirmed/ })).toContainText("The site's wording");
});

test("the owners change a membership plan, and stop offering it and offer it again", async ({ page }) => {
  const NAME = "Studio Paris, 5 hours a month";
  const plan = () => page.locator("form.membership-plan", { hasText: `Save ${NAME}` });
  await signIn(page, EMAILS_OWNER, "/admin/memberships");
  await expect(plan()).toContainText("Studio Paris: $300 a month for 5 hours");
  await byLabel(plan(), "Hours a month").fill("5.5");
  await byLabel(plan(), "Price a month ($)").fill("310");
  await plan().getByRole("button", { name: `Save ${NAME}` }).click();
  await expect(byText(page, "Plan saved. A new price or number of hours applies to members who join after it.")).toBeVisible();
  await expect(plan()).toContainText("Studio Paris: $310 a month for 5.5 hours");

  await plan().getByRole("button", { name: `Stop offering ${NAME}` }).click();
  await expect(byText(page, "The plan is no longer offered. Its members keep it.")).toBeVisible();
  await expect(plan()).toContainText("Not offered");
  await plan().getByRole("button", { name: `Offer ${NAME} again` }).click();
  await expect(byText(page, "The plan is offered again.")).toBeVisible();

  // Back as it was, for the tests after this one.
  await byLabel(plan(), "Hours a month").fill("5");
  await byLabel(plan(), "Price a month ($)").fill("300");
  await plan().getByRole("button", { name: `Save ${NAME}` }).click();
  await expect(plan()).toContainText("Studio Paris: $300 a month for 5 hours");
});

test("a client buys a membership, gets its code, sees it in their account and cancels it", async ({ page }) => {
  const max = { name: "Max Member", email: "max.member.e2e@example.com", phone: "407-555-0133" };
  // The live site's address for memberships leads to the new page.
  await page.goto("/studio-memberships");
  await page.waitForURL((url) => url.pathname === "/memberships");
  await expect(page.getByRole("heading", { name: "Studio Memberships" })).toBeVisible();
  const plan = page.locator(".rate-card", { hasText: "Studio Paris, 5 hours a month" });
  await expect(plan).toContainText("$300");
  await expect(plan).toContainText("5 hours of studio time each month");
  await plan.getByRole("link", { name: "Join" }).click();

  await expect(page.getByRole("heading", { name: "Studio Paris, 5 hours a month" })).toBeVisible();
  await byLabel(page, "Full name *").fill(max.name);
  await byLabel(page, "Email address *").fill(max.email);
  await byLabel(page, "Phone number *").fill(max.phone);
  await expect(byText(page, /No card processor is connected/)).toBeVisible();
  await page.getByRole("checkbox", { name: /membership terms/ }).check();
  expect(await accessibilityProblems(page)).toEqual([]);
  await page.getByRole("button", { name: "Pay $300 and join" }).click();
  await expect(page.getByRole("heading", { name: "Welcome! Your membership has started." })).toBeVisible();
  const code = (await onScreen(page.locator(".copy-code-text")).innerText()).trim();
  expect(code).toMatch(/^MEMBER-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const welcome = await latestEmail(page, "membership_started", max.email);
  expect(welcome.subject).toBe("Your membership: Studio Paris, 5 hours a month");
  expect(welcome.body).toContain(`Your membership code: ${code}`);

  // The code pays for an hour in Paris: nothing to pay, no card.
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: MEMBER_DAY, duration: "1 hr", time: "11:00 AM", customer: max, code });
  await expect(byText(page, "Nothing to pay: your code covers this booking. No card is needed.")).toBeVisible();
  await expect(totalRow(page)).toContainText("$0");
  await confirmAndGetRef(page, "Confirm booking");
  await expect(byText(page, "Membership hours (1 hour)")).toBeVisible();

  // The owners see the member and the hour the booking took, and give an hour back.
  await signIn(page, EMAILS_OWNER, "/admin/memberships");
  await page.getByRole("link", { name: max.name }).click();
  await expect(page.getByRole("heading", { name: max.name })).toBeVisible();
  await expect(page.locator(".history-table")).toContainText("Booking VS-");
  await byLabel(page, "Hours to add (a minus takes away)").fill("1");
  await byLabel(page, "Why").fill("A gift for the first visit");
  await page.getByRole("button", { name: "Change the hours" }).click();
  await expect(byText(page, "Hours changed. The member sees them in their account.")).toBeVisible();
  await expect(page.locator(".reward-facts dd").first()).toHaveText("5 hours");
  await expect(page.locator(".history-table")).toContainText("A gift for the first visit");
  expect(await accessibilityProblems(page)).toEqual([]);

  // Signed out of the owner's account first: signed in, the sign-in page goes straight on to the account.
  await page.context().clearCookies();
  await signIn(page, max.email, "/account/membership");
  const card = page.locator(".membership-card", { hasText: "Studio Paris, 5 hours a month" });
  await expect(card).toContainText("Active. The next month is billed on");
  await expect(card).toContainText(code);
  await expect(card.locator(".reward-facts dd").first()).toHaveText("5 hours");
  await card.getByRole("button", { name: "Cancel membership" }).click();
  await card.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(card).toContainText("Cancelled: no more monthly payments.");
  await expect(card.getByRole("button", { name: "Cancel membership" })).toHaveCount(0);
  const goodbye = await latestEmail(page, "membership_cancelled", max.email);
  expect(goodbye.body).toContain(`The hours left on your code ${code} stay yours to use: 5 hours.`);
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
  await expect(pets.locator(".faq-answer")).toContainText("A pet fee of $45 applies");

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
  await expect(pets.locator(".faq-answer")).toContainText("The other studios and all common areas are pet-free.");
  await expect(pets.locator(".faq-answer")).toContainText("A pet fee of $45 for Studio Dayglow and $30 for Studio Paris applies");

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

  // While signed in: three free hours for Jane, for the next tests. The site sends one by itself after
  // five visits; the owner can also hand one out. A free hour is a reward, and a reward is used once.
  for (let made = 1; made <= 3; made++) {
    await onScreen(page.locator("#code-kind")).selectOption({ label: "One free hour (one studio)" });
    await onScreen(page.locator("#code-email")).fill(jane.email);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("row", { name: /1 hour free/ })).toHaveCount(made);
  }
  const rows = await page.getByRole("row", { name: /1 hour free/ }).allInnerTexts();
  freeHourCodes = rows.map((row) => /VS-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(row)![0]);
  expect(new Set([...freeHourCodes, discountCode]).size).toBe(4);
  for (const row of rows) {
    expect(row).toContain(jane.email);
    expect(row).toContain("0 of 1");
  }

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
  await pickStudio(page, "Studio Paris");
  await next(page);
  await byLabel(page, "Date").fill(FREE_HOUR_DAY);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
  await next(page);
  await fillDetails(page, jane);
  await byLabel(page, "Have a code?").fill(freeHourCodes[0]);
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
    code: freeHourCodes[0],
  });
  await expect(byText(page, `Free hour, code ${freeHourCodes[0]}`)).toBeVisible();
  await expect(totalRow(page)).toContainText("$44");
  await confirmAndGetRef(page, "Confirm & pay $44");
  await expect(page.locator(".price-row", { hasText: "Free hour" })).toContainText("-$88");
  await shot(page, "20-free-hour");

  // A reward is used once: the same code is refused for a second booking.
  await page.goto("/book");
  await pickStudio(page, "Studio Paris");
  await next(page);
  await byLabel(page, "Date").fill(FREE_HOUR_DAY);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await next(page);
  await page.getByRole("button", { name: "2:00 PM", exact: true }).click();
  await next(page);
  await fillDetails(page, jane);
  await byLabel(page, "Have a code?").fill(freeHourCodes[0]);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(byText(page, "That code has already been used.")).toBeVisible();

  // One studio for one hour, with her second free hour: nothing to pay, and no card is asked for.
  await bookStudioFirstToPayment(page, {
    studios: ["Studio Paris"],
    date: FREE_HOUR_DAY,
    duration: "1 hr",
    time: "2:00 PM",
    customer: jane,
    code: freeHourCodes[1],
  });
  await expect(byText(page, "Nothing to pay: your code covers this booking. No card is needed.")).toBeVisible();
  await expect(totalRow(page)).toContainText("$0");
  await confirmAndGetRef(page, "Confirm booking");
});

test("the account lists every reward with its status, and a code is copied with one press", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, jane.email, "/account/rewards");
  await expect(page.getByRole("heading", { name: "My Rewards", level: 1 })).toBeVisible();

  // Three rewards: two were used, each for a named appointment, and one can still be used.
  const rewards = onScreen(page.locator("li.reward"));
  await expect(rewards).toHaveCount(3);
  await expect(onScreen(page.locator("li.reward-redeemed"))).toHaveCount(2);
  for (const used of freeHourCodes.slice(0, 2)) {
    const reward = onScreen(page.locator("li.reward", { hasText: used }));
    await expect(reward).toContainText("Free Studio Hour");
    await expect(reward).toContainText("Redeemed");
    await expect(reward).toContainText(/Used on .+ for your appointment on .+ \(VS-[0-9A-Z]{6}\)\./);
    await expect(reward.getByRole("button")).toHaveCount(0); // a used code is not offered for copying
  }
  const spare = onScreen(page.locator("li.reward", { hasText: freeHourCodes[2] }));
  await expect(spare).toContainText("Available");
  await expect(spare).toContainText(/Issued/);
  await expect(spare).toContainText(/Expires/);
  await shot(page, "20a-account-rewards");

  // Copy Code puts the code on the clipboard and says so.
  await spare.getByRole("button", { name: `Copy code ${freeHourCodes[2]}` }).click();
  await expect(spare.getByRole("button", { name: `Copy code ${freeHourCodes[2]}` })).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(freeHourCodes[2]);

  // The overview offers the same reward, and the appointments made with the others.
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  const usable = onScreen(page.locator(".account-card", { hasText: "Rewards you can use" }));
  await expect(usable).toContainText(freeHourCodes[2]);
  await expect(usable).not.toContainText(freeHourCodes[0]);
  await expect(onScreen(page.locator(".account-card", { hasText: "Your next appointment" }))).toContainText("upcoming appointments in all");
});

test("the owners look a customer up, see what they paid, and correct their stamps and rewards", async ({ page }) => {
  await signIn(page, FIFTH_OWNER, "/admin/customers");
  await expect(page.getByRole("heading", { name: "Customers", exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /Bob Brown/ })).toBeVisible();

  // Found by a part of the name, and opened.
  await byLabel(page, "Name or email").fill("jane");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(byText(page, /1 customer for "jane"/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Bob Brown/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Jane Smith" }).click();
  await expect(page.getByRole("heading", { name: "Jane Smith", level: 1 })).toBeVisible();
  await expect(onScreen(page.locator(".admin-card", { hasText: "Contact" }))).toContainText(jane.email);

  // Everything she paid this year, added up, with a receipt for each booking; and the file of the year.
  const year = todayInStudio().slice(0, 4);
  const payments = onScreen(page.locator("#payments"));
  await expect(payments).toContainText(`${year}: $346.80 paid, $64.60 refunded`);
  await expect(payments.locator(".receipt-list li")).toHaveCount(4);
  const janesPage = `/admin/customers/${encodeURIComponent(jane.email)}`;
  const file = await page.request.get(`${janesPage}/receipts/year/${year}/pdf`);
  expect(file.status()).toBe(200);
  expect((await file.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // Her appointments, each a link to its own page, and whether each reward was used.
  await expect(onScreen(page.locator("#appointments"))).toContainText("Released for rescheduling");
  const rewards = onScreen(page.locator("#rewards"));
  await expect(rewards.locator("li.reward")).toHaveCount(3);
  await expect(rewards.locator("li.reward", { hasText: freeHourCodes[0] })).toContainText(/Redeemed on .+ for the appointment on/);
  // The pet fee the owners returned to her is listed as credit, not as a reward.
  await expect(onScreen(page.locator(".admin-card", { hasText: "Credit and discount codes" }))).toContainText("A pet fee returned");
  await shot(page, "20b-admin-customer");
  expect(await accessibilityProblems(page), "a customer's page, with appointments, payments and rewards").toEqual([]);

  // Five visits she made before the site counted them: five stamps, which complete a free hour at once.
  await byLabel(page, "What to do").selectOption({ label: "Add stamps" });
  await byLabel(page, "How many").fill("5");
  await byLabel(page, "Why").fill("Five visits on the old booking system");
  await page.getByRole("button", { name: "Change stamps" }).click();
  await expect(
    byText(page, "5 stamps added. The customer now has 5 stamps. That completed 1 free hour, emailed to the customer just now."),
  ).toBeVisible();
  await expect(rewards.locator("li.reward")).toHaveCount(4);
  await expect(rewards.locator("li.reward", { hasText: /THANKS-/ })).toContainText("Available");
  await expect(onScreen(page.locator("#loyalty"))).toContainText(`5 stamps added by ${FIFTH_OWNER}. Five visits on the old booking system`);
  const earned = await latestEmail(page, "loyalty_code", jane.email);
  expect(earned.subject).toBe("You have earned a free hour in the studio");

  // A stamp cannot be changed without saying why: the browser asks for the reason before anything is sent.
  await byLabel(page, "How many").fill("1");
  await page.getByRole("button", { name: "Change stamps" }).click();
  await expect(onScreen(page.locator("#stamp-reason:invalid"))).toHaveCount(1);

  // The free hour that was handed out once too often is cancelled, with a reason, and then given back.
  const spare = rewards.locator("li.reward", { hasText: freeHourCodes[2] });
  await byLabel(spare, "Why it is cancelled").fill("Handed out once too often");
  await spare.getByRole("button", { name: "Cancel this reward" }).click();
  await expect(byText(page, `Reward ${freeHourCodes[2]} cancelled. It can no longer be used, and the customer sees it as Canceled.`)).toBeVisible();
  await expect(spare).toContainText("Canceled");
  await byLabel(spare, "Why it is given back").fill("It was the right number after all");
  await spare.getByRole("button", { name: "Give this reward back" }).click();
  await expect(byText(page, `Reward ${freeHourCodes[2]} given back.`)).toBeVisible();
  await expect(spare).toContainText("Available");
  await expect(rewards).toContainText(`${freeHourCodes[2]} cancelled by ${FIFTH_OWNER}. Handed out once too often`);
  await expect(rewards).toContainText(`${freeHourCodes[2]} given back by ${FIFTH_OWNER}. It was the right number after all`);

  // From an appointment, the client's name leads to this page.
  await onScreen(page.locator("#appointments")).getByRole("link").first().click();
  await expect(page.getByRole("heading", { name: "Jane Smith", level: 1 })).toBeVisible();
  await onScreen(page.locator(".detail-list")).getByRole("link", { name: "Jane Smith" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/customers/${encodeURIComponent(jane.email).replace(/[.]/g, "\\.")}`));

  // Loyalty switched off and on again starts every client's stamps over, and the free hours they hold stay valid
  // (the owner's answer of 2026-11-17). The fee for a further reschedule is on the same page, in dollars.
  await page.goto("/admin/settings");
  await expect(byLabel(page, "Fee for each further reschedule ($)")).toHaveValue("20");
  const loyaltySwitch = page.getByRole("checkbox", { name: /Email a free hour to customers/ });
  await expect(loyaltySwitch).toBeChecked();
  await loyaltySwitch.uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(byText(page, "Settings saved.")).toBeVisible();
  await page.goto(janesPage);
  await expect(onScreen(page.locator("#loyalty"))).toContainText("Loyalty is switched off in Settings, so no stamps are counted and none can be changed.");
  await page.goto("/admin/settings");
  await expect(loyaltySwitch).not.toBeChecked();
  await expect(byText(page, /Stamps are counted from/)).toHaveCount(0);
  await loyaltySwitch.check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(byText(page, "Settings saved.")).toBeVisible();
  await expect(byText(page, /Free hours already\s+sent stay valid\. Stamps are counted from \w+, \w+ \d+, \d{4}, \d+:\d\d [AP]M\./)).toBeVisible();
  await expect(byLabel(page, "Fee for each further reschedule ($)")).toHaveValue("20");
  await page.goto(janesPage);
  const loyalty = onScreen(page.locator("#loyalty"));
  await expect(loyalty).toContainText("when loyalty was switched on again");
  await expect(loyalty.locator(".stamp-facts div", { hasText: "Stamps in all" })).toContainText("0");
  // The five stamps added before are still on record, marked as not counted, and her free hours are as they were.
  await expect(loyalty).toContainText("Five visits on the old booking system (Before loyalty started again: not counted.)");
  await expect(rewards.locator("li.reward")).toHaveCount(4);
  await expect(rewards.locator("li.reward", { hasText: /THANKS-/ })).toContainText("Available");
});

test("a Studio Manager runs the calendar and looks clients up, and sees no prices until the owners say so", async ({ page }) => {
  // The owners add a manager. (The second sign-in code of the fifth owner.)
  await signIn(page, FIFTH_OWNER, "/admin/staff");
  await byLabel(page, "Email").fill(MANAGER);
  await byLabel(page, "Name").fill("Mia");
  await onScreen(page.locator("#staff-level")).selectOption({ label: "Studio Manager" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(byText(page, "Staff member added as Studio Manager.")).toBeVisible();
  const mia = onScreen(page.locator(".admin-card", { hasText: MANAGER }));
  await expect(mia).toContainText("Studio Manager");
  await expect(mia).toContainText("A manager sees every day: none has to be assigned.");
  await shot(page, "20c-admin-staff-levels");
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/");

  // The manager signs in. Her menu is the pages she can open, and no more.
  await signIn(page, MANAGER);
  await page.getByRole("link", { name: "Studio calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  await expect(onScreen(page.locator(".admin-nav"))).toHaveText("CalendarCustomersDay sheetHours & blocksPhotography");

  // She sees a day nobody assigned to her, with the client's contact details, and no price.
  await page.goto(`/admin/calendar?view=day&date=${NEAR}`);
  await page.getByRole("link", { name: /Jane Smith/ }).click();
  await expect(page.getByRole("heading", { name: "Jane Smith", level: 1 })).toBeVisible();
  const appointment = onScreen(page.locator(".admin-main"));
  await expect(appointment).toContainText(jane.email);
  expect(await appointment.innerText()).not.toContain("$");
  await expect(page.getByRole("button", { name: "Reschedule Pending", exact: true })).toBeEnabled();

  // The client's name leads to their page: appointments, stamps and rewards, and nothing about money.
  await onScreen(page.locator(".detail-list")).getByRole("link", { name: "Jane Smith" }).click();
  await expect(onScreen(page.locator("#appointments"))).toContainText("Released for rescheduling");
  await expect(onScreen(page.locator("#rewards li.reward"))).toHaveCount(4);
  await expect(page.locator("#payments")).toHaveCount(0);
  expect(await onScreen(page.locator(".admin-main")).innerText()).not.toContain("$");
  await expect(page.getByRole("button", { name: "Change stamps" })).toHaveCount(0); // not switched on for managers

  // She can block time in a studio, and cannot touch opening hours.
  await page.getByRole("link", { name: "Hours & blocks" }).click();
  await expect(page.getByRole("heading", { name: "Blocked time", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Block", exact: true })).toBeVisible();
  await expect(byText(page, /opening hours/)).toHaveCount(0);

  // What the owners keep, and what they have not switched on for managers, cannot be found.
  for (const path of ["/admin", "/admin/bookings", "/admin/prices", "/admin/studios", "/admin/staff", "/admin/codes", "/admin/settings"]) {
    await page.goto(path);
    await expect(byText(page, /could not be found/i)).toBeVisible();
    await expect(byText(page, "Studio Admin")).toHaveCount(0);
  }
  const janesPage = `/admin/customers/${encodeURIComponent(jane.email)}`;
  expect((await page.request.get(`${janesPage}/receipts/year/${todayInStudio().slice(0, 4)}/pdf`)).status()).toBe(404);
});

test("a client without a photographer books a session, and the photographer cannot be booked twice", async ({ page }) => {
  // The third and last sign-in code of this address. Create a discount for sessions only.
  await signIn(page, THIRD_OWNER, "/admin/codes");
  await byLabel(page, "Kind").selectOption({ label: "Percent off a photography session" });
  await byLabel(page, "Percent off (1 to 100)").fill("20");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const discount = byText(page, /Code created: VS-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  await expect(discount).toBeVisible();
  const discountCode = /VS-[0-9A-Z]{4}-[0-9A-Z]{4}/.exec(await discount.innerText())![0];
  await expect(page.getByRole("row", { name: new RegExp(discountCode) })).toContainText("Photography sessions");

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
  await byLabel(page, "Have a code?").fill(discountCode);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(byText(page, `Code ${discountCode} (20% off session)`)).toBeVisible();
  await agreeToPolicies(page);
  await next(page);
  await expect(byText(page, /Photography session, Studio Blanche, 1 hour/)).toBeVisible();
  await expect(totalRow(page)).toContainText("$300");
  await shot(page, "21-photography-pay");
  await confirmAndGetRef(page, "Confirm & pay $300");
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

  // The owners block the photographer's afternoon.
  await page.goto("/admin/photography");
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

test("a booking whose answer is lost on the way is found when the customer presses again, and is charged once", async ({ page }) => {
  const lena = { name: "Lena Lost", email: "lena.lost@example.com", phone: "407-555-0166" };
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: LOST_DAY, duration: "1 hr", time: "10:00 AM", customer: lena });
  // The booking reaches the server, which makes it and charges the card; its answer never reaches the phone.
  let lost = false;
  await page.route("**/api/bookings", async (route) => {
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Confirm & pay $68" }).click();
  await expect(onScreen(page.locator(".flash-error"))).toContainText("we cannot tell whether your booking went through");

  // Pressed again, the same attempt: the customer is taken to the booking that was made.
  const ref = await confirmAndGetRef(page, "Confirm & pay $68");
  await expect(totalRow(page)).toContainText("$68");
  // One booking, one confirmation, one charge.
  const outbox = await page.context().newPage();
  await outbox.goto("/dev/outbox");
  const confirmations = outbox.locator(".admin-card", { hasText: `To ${lena.email} · booking_confirmation` });
  await expect(confirmations).toHaveCount(1);
  await expect(confirmations).toContainText(ref);
  await outbox.close();
});

test("a refund the card processor refuses is shown to the owner, who records it once it is made by hand in Square", async ({ page }) => {
  const rita = { name: "Rita Refused", email: "rita.refused@example.com", phone: "407-555-0177" };
  await bookStudioFirstToPayment(page, { studios: ["Studio Paris"], date: REFUSED_DAY, duration: "1 hr", time: "10:00 AM", customer: rita });
  // Paid with a pretend card whose refunds are all refused (the pretend processor's MOCK_TOKEN_REFUNDS_REFUSED).
  await page.route("**/api/bookings", (route) =>
    route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), paymentToken: "mock-card-refunds-refused" }) }),
  );
  const ref = await confirmAndGetRef(page, "Confirm & pay $68");
  await page.unroute("**/api/bookings");

  // The fifth owner's third sign-in code. A refund of $20 for goodwill: the processor refuses it.
  await signIn(page, FIFTH_OWNER, `/admin/bookings?from=${REFUSED_DAY}&to=${REFUSED_DAY}`);
  const row = page.getByRole("row", { name: /Rita Refused/ });
  await row.getByText("Refund", { exact: true }).click();
  await byLabel(row, "Amount ($)").fill("20");
  await byLabel(row, "Reason").fill("Goodwill");
  await row.getByRole("button", { name: "Send refund" }).click();
  await expect(byText(page, "$20 refund recorded; it has not gone through yet and will be retried.")).toBeVisible();

  // The overview shows it first, with Square's reason. Once the owner has refunded it in Square, they record it there.
  await page.goto("/admin");
  const problem = onScreen(page.locator(".admin-card", { hasText: "Refunds that need attention" })).getByRole("row", { name: new RegExp(ref) });
  await expect(problem).toContainText("Failed");
  await expect(problem).toContainText("The card account is closed (test mode).");
  expect(await accessibilityProblems(page), "the overview with a refund that failed").toEqual([]);
  await problem.getByText("Refunded it in Square", { exact: true }).click();
  await problem.getByRole("button", { name: "Yes, I refunded $20 in Square" }).click();
  await expect(byText(page, "Recorded: the refund was made in Square. The site no longer tries to make it.")).toBeVisible();
  await expect(onScreen(page.locator(".admin-card", { hasText: "Refunds that need attention" }))).toHaveCount(0);
  // The booking's history says who recorded it.
  await page.goto(`/admin/appointments/${ref}`);
  await expect(byText(page, "A refund of $20 that the site could not make was made by hand in Square")).toBeVisible();
});
