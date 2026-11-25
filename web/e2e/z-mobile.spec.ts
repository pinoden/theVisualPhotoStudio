import { expect, test, type Page } from "@playwright/test";
import {
  accessibilityProblems,
  agreeToPolicies,
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
  watchBrowser,
  pickLength,
} from "./helpers";
import {
  brokenWords as brokenWordsIn,
  hardToTouch as hardToTouchIn,
  tooSmallToRead as tooSmallToReadIn,
  widerThanScreen as widerThanScreenIn,
} from "../src/lib/site/phone-checks";

/**
 * The owner's requirement 13: the whole site on a phone. Runs after
 * site.spec.ts (the file name sorts last), on the database that suite left,
 * so the admin pages have real bookings to lay out. It books on days of its
 * own, with customers of its own.
 *
 * Sizes are CSS pixels, as the phones report them.
 */
const SIZES = [
  { name: "iPhone SE, 1st generation (the smallest still in use)", width: 320, height: 568 },
  { name: "Galaxy Z Fold, folded", width: 344, height: 882 },
  { name: "Android phone", width: 360, height: 800 },
  { name: "iPhone mini and iPhone SE", width: 375, height: 667 },
  { name: "iPhone", width: 390, height: 844 },
  { name: "iPhone Plus", width: 428, height: 926 },
  { name: "iPhone Pro Max", width: 430, height: 932 },
  { name: "iPad, and a foldable opened", width: 768, height: 1024 },
] as const;

const PUBLIC_PAGES = ["/", "/studios", "/rates", "/services", "/faq", "/policies", "/memberships", "/contact", "/book", "/book/photography", "/account/sign-in"];

// The owner addresses of site.spec.ts have each used the three sign-in codes an address may ask for.
const OWNER = "owner4@studio.test";
/** The owner who measures the admin on a tablet: their sign-in codes are their own. */
const IPAD_OWNER = "owner12@studio.test";
/** An add-on's name of one word as long as the field allows a word to be: longer than a line on the smallest phone. */
const LONG_ADDON = "Seamlesspaperbackdroprollwithstands";
/** A font's name of one long word, as long as its field takes on a phone. */
const LONG_FONT = "Horizonextendedcondenseddisplaygrotesque";
/** A client's name with one long word, which fits a phone's line from 375px on. */
const LONG_CLIENT = "Bartholomewmaximilianchristophersonthethird Smith";
const mia = { name: "Mia Mobile", email: "mia.mobile@example.com", phone: "407-555-0177" };

let browserProblems: string[] = [];
test.beforeEach(({ page }) => {
  browserProblems = [];
  watchBrowser(page, (problem) => browserProblems.push(problem));
});
test.afterEach(() => {
  expect(browserProblems, "errors reported by the browser").toEqual([]);
});

/** What is wider than the screen, controls hard to use by touch, and text too small to read: the page editor runs the same checks before it publishes a page. */
// Each is sent into the page as it is written, and called there with no argument: it then reads the page's own document.
const widerThanScreen = (page: Page) => page.evaluate(widerThanScreenIn as () => string[]);
const hardToTouch = (page: Page) => page.evaluate(hardToTouchIn as () => string[]);
const tooSmallToRead = (page: Page) => page.evaluate(tooSmallToReadIn as () => string[]);
const brokenWords = (page: Page) => page.evaluate(brokenWordsIn as () => string[]);

/** Nothing wider than the screen, and no word broken in two that would have fitted on its line. */
async function expectFits(page: Page, where: string): Promise<void> {
  expect(await widerThanScreen(page), `${where}: wider than the screen`).toEqual([]);
  expect(await brokenWords(page), `${where}: words broken in two`).toEqual([]);
}

test("the check for what is wider than the screen names words that run out of their box", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  const word = "Holidayminisessionsforfamiliesandpetsarenowopen";
  const box = (style: string) =>
    `<!doctype html><html><body style="margin:0;font:16px/1.4 monospace"><div style="width:272px;${style}">${word}: book before December</div></body></html>`;
  await page.setContent(box(""));
  const found = await widerThanScreen(page);
  expect(found.some((line) => line.startsWith('"Holidayminisessions') && / reaches \d+px$/.test(line)), found.join(" | ")).toBe(true);
  // In a box that clips it, nothing shows past the box, and nothing is named.
  await page.setContent(box("overflow:hidden"));
  expect(await widerThanScreen(page)).toEqual([]);
});

test("the check for broken words sees a word squeezed in a table, at any depth of its cell, and nothing else", async ({ page }) => {
  // Made-up layouts. The other column has room to give: its words are short and many, so a word squeezed beside it
  // would have fitted.
  const filler = "and some short words that can wrap at their spaces ".repeat(4);
  const row = (first: string) =>
    `<table style="border-collapse:collapse"><tr><td style="padding:4px">${first}</td><td style="padding:4px">${filler}</td></tr></table>`;
  const squeezed = 'style="overflow-wrap:anywhere;white-space:normal;font:inherit"';
  // Each layout with the word the check must report there, or null where it must report nothing.
  const layouts: [string, string, string | null][] = [
    ["a button in a cell", row(`<button ${squeezed}>Refunded it in Square</button>`), "Refunded"],
    ["a button in a row of buttons in a cell", row(`<div style="display:flex"><button ${squeezed}>Refunded it in Square</button></div>`), "Refunded"],
    ["a summary in a details in a cell", row(`<details><summary ${squeezed}>Refunded it in Square</summary></details>`), "Refunded"],
    ["a paragraph in a box in a cell", row(`<div><p ${squeezed}>Refunded it in Square</p></div>`), "Refunded"],
    ["words that keep whole", row("<button>Refunded it in Square</button>"), null],
    [
      "a table given a width its words cannot fit",
      `<table style="width:120px;border-collapse:collapse"><tr><td style="padding:4px"><button ${squeezed}>Refunded it in Square</button></td><td style="padding:4px">some words</td></tr></table>`,
      null,
    ],
    [
      // Too narrow for the word within the table's own width, wide enough within the row it is in.
      "a table in a box of a flex row",
      `<div style="display:flex"><table style="border-collapse:collapse;flex:0 1 170px"><tr><td style="padding:4px"><button ${squeezed}>Refunded</button></td><td style="padding:4px">${"photograph studio rental ".repeat(4)}</td></tr></table><div style="flex:1 1 0">beside</div></div>`,
      "Refunded",
    ],
    [
      // A grid's track sets the width of what is in it, as a width given to a column does.
      "a table in one of two grid columns",
      `<div style="display:grid;grid-template-columns:1fr 1fr"><table style="border-collapse:collapse"><tr><td style="padding:4px"><button ${squeezed}>Refunded</button></td><td style="padding:4px">${"photograph studio rental ".repeat(4)}</td></tr></table><div>beside</div></div>`,
      null,
    ],
    ["a table inside an inline element", `<span>${row(`<button ${squeezed}>Refunded it in Square</button>`)}</span>`, "Refunded"],
    [
      "a paragraph in a box of a flex row",
      `<div style="display:flex"><div><p ${squeezed}>Refunded it in Square</p></div><div style="flex:0 0 300px">${filler}</div></div>`,
      "Refunded",
    ],
    [
      // Its column is the second: the first is taken by a cell of the row above that spans both rows.
      "a table whose cell spanning rows leaves another column little room",
      `<table style="border-collapse:collapse"><tr><td rowspan="2" style="padding:4px">Averyveryverylongwordindeed</td><td style="padding:4px">a</td></tr><tr><td style="padding:4px"><button ${squeezed}>Refunded it in Square</button></td></tr></table>`,
      null,
    ],
    [
      "a table made with CSS whose other column is made wide by another row",
      `<div style="display:table"><div style="display:table-row"><div style="display:table-cell;padding:4px"><button ${squeezed}>Refunded it in Square</button></div><div style="display:table-cell;padding:4px">short</div></div><div style="display:table-row"><div style="display:table-cell;padding:4px">x</div><div style="display:table-cell;padding:4px">Averyveryverylongwordindeed</div></div></div>`,
      null,
    ],
    [
      "a table whose other column holds a wide field",
      `<table style="border-collapse:collapse"><tr><td style="padding:4px"><button ${squeezed}>Refunded it in Square</button></td><td style="padding:4px"><input style="width:240px;font:inherit" aria-label="Note"></td></tr></table>`,
      null,
    ],
    [
      "a table whose other column is made wide by another row",
      `<table style="border-collapse:collapse"><tr><td style="padding:4px"><button ${squeezed}>Refunded it in Square</button></td><td style="padding:4px">short</td></tr><tr><td style="padding:4px">x</td><td style="padding:4px">Averyveryverylongwordindeed</td></tr></table>`,
      null,
    ],
  ];
  for (const [name, html, word] of layouts) {
    await page.setContent(`<!doctype html><html><body style="margin:0;font:16px/1.4 monospace"><main style="width:340px">${html}</main></body></html>`);
    const found = await brokenWords(page);
    if (word) expect(found, name).toContain(`"${word}" is broken in two`);
    else expect(found, name).toEqual([]);
  }
});

test("no public page is wider than the screen, and its text can be read, on any phone", async ({ page }) => {
  test.setTimeout(300_000);
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const path of PUBLIC_PAGES) {
      await page.goto(path);
      await expect(page.locator("main h1, main h2").first()).toBeVisible();
      await expectFits(page, `${path} on ${size.name} (${size.width}px)`);
      expect(await tooSmallToRead(page), `${path} on ${size.name}: text too small to read`).toEqual([]);
    }
  }
});

test("the menu opens and leads somewhere on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  const menu = page.locator(".site-nav");
  await expect(menu.getByRole("link", { name: "Rates", exact: true })).toBeHidden();
  await menu.getByRole("button", { name: "Menu" }).click();
  expect(await hardToTouch(page), "the open menu: hard to use by touch").toEqual([]);
  await menu.getByRole("link", { name: "Rates", exact: true }).click();
  await expect(page).toHaveURL(/\/rates$/);
  await expect(page.getByRole("heading", { name: "Studio Rates" })).toBeVisible();
  // The menu closes after a choice, and can be opened again.
  await expect(menu.getByRole("link", { name: "Contact", exact: true })).toBeHidden();
  await menu.getByRole("button", { name: "Menu" }).click();
  await menu.getByRole("link", { name: "Contact", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Contact Us" })).toBeVisible();
  await expectFits(page, "/contact with the menu used");
});

// A whole booking on four iPhones, from the smallest to the largest. Each on a day of its own.
const BOOKING_SIZES = [SIZES[0], SIZES[3], SIZES[4], SIZES[6]];
for (const [index, size] of BOOKING_SIZES.entries()) {
  test(`a whole booking can be made on ${size.name} (${size.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const date = dateAhead(70 + index * 7);
    const step = async (name: string) => {
      await expectFits(page, `the ${name} step`);
      expect(await hardToTouch(page), `the ${name} step: hard to use by touch`).toEqual([]);
      expect(await tooSmallToRead(page), `the ${name} step: text too small`).toEqual([]);
    };

    await page.goto("/book");
    await step("studios");
    await pickStudio(page, "Studio Paris");
    await next(page);

    await byLabel(page, "Date").fill(date);
    await pickLength(page, "1.5 hr");
    await step("date");

    // Every start time is a button that can be tapped: a quarter of an hour apart.
    await expect(page.getByRole("button", { name: "9:15 AM", exact: true })).toBeVisible();
    await step("time");
    await shot(page, `m-${size.width}-time`);
    await page.getByRole("button", { name: "9:15 AM", exact: true }).click();
    await next(page);

    await fillDetails(page, mia);
    await agreeToPolicies(page);
    await step("details");
    await shot(page, `m-${size.width}-details`);
    await next(page);

    await expect(totalRow(page)).toContainText("$102");
    await step("payment");
    await confirmAndGetRef(page, "Confirm & pay $102");
    await expectFits(page, "the booking page");
    await expect(onScreen(page.locator(".price-row", { hasText: "Studio Paris" }))).toBeVisible();
  });
}

test("the booking summary keeps its words and amounts whole on the smallest phone, however long it is", async ({ page }) => {
  // An add-on with a name of one long word and a web address in its description: words longer than a phone's line.
  // It stays, so every booking and account after this one is measured with it too.
  await signIn(page, OWNER, "/admin/studios");
  await onScreen(page.locator("#addon-new-name")).fill(LONG_ADDON);
  await onScreen(page.locator("#addon-new-price")).fill("10");
  await onScreen(page.locator("#addon-new-description")).fill("Choose yours first at https://www.thevisualsphotostudio.com/backdropcolours");
  await page.getByRole("button", { name: "Add add-on" }).click();
  await expect(byText(page, "Add-on added.")).toBeVisible();

  // Three studios for the longest time they share, with every add-on: the longest summary the booking screen draws.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/rates");
  await expect(page.getByRole("cell", { name: new RegExp(LONG_ADDON) })).toBeVisible();
  await expectFits(page, "/rates with an add-on of long words");
  await page.goto("/book");
  for (const studio of ["Studio Blanche", "Studio Dayglow", "Studio Paris"]) await pickStudio(page, studio);
  await next(page);
  await byLabel(page, "Date").fill(dateAhead(150));
  await page.getByRole("button", { name: "5 hr", exact: true }).click();
  await page.getByRole("button", { name: "9:00 AM", exact: true }).click();
  await next(page);
  await fillDetails(page, mia);
  // Every add-on offered, whatever the tests before have made of them (site.spec.ts renames the pet fee).
  const addons = onScreen(page.locator("label.addon-row input[type=checkbox]"));
  await expect(addons.first()).toBeVisible();
  for (const addon of await addons.all()) await addon.check();
  await expectFits(page, "the details step with every add-on");
  // On wider phones a long name fits its line: it is not broken there either.
  for (const width of [390, 414, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expectFits(page, `the details step with every add-on at ${width}px`);
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await agreeToPolicies(page);
  await next(page);
  await expect(totalRow(page)).toBeVisible();
  await expectFits(page, "the payment step of three studios with every add-on");
  await shot(page, "m-320-long-summary");
  // Booked, for Mia: her booking page, and later her appointments and receipts, show it too.
  await confirmAndGetRef(page, /^Confirm & pay/);
  await expect(onScreen(page.locator(".price-row", { hasText: LONG_ADDON }))).toBeVisible();
  await expectFits(page, "the booking page of three studios with every add-on");
});

test("a photographer can be booked on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const date = dateAhead(101);
  await page.goto("/book");
  // The way to the photography flow is on the first screen, and its button is easy to hit.
  const callout = page.getByRole("complementary", { name: "Don’t have a photographer?" });
  await expect(callout).toBeInViewport();
  await expectFits(page, "/book");
  await shot(page, "m-375-book-with-photographer-section");
  await callout.getByRole("link", { name: "Book a Photographer" }).click();
  await expect(page.getByRole("heading", { name: "Book a Photographer" })).toBeVisible();

  await pickStudio(page, "Studio Dayglow");
  await next(page);
  await byLabel(page, "Date").fill(date);
  await page.getByRole("button", { name: /2 hours · \$515/ }).click();
  await expectFits(page, "the session step");
  await shot(page, "m-375-session");
  expect(await hardToTouch(page), "the session step: hard to use by touch").toEqual([]);
  await page.getByRole("button", { name: "1:00 PM", exact: true }).click();
  await next(page);
  await fillDetails(page, mia);
  await agreeToPolicies(page);
  await next(page);
  await expect(totalRow(page)).toContainText("$515");
  await expectFits(page, "the payment step");
  await confirmAndGetRef(page, "Confirm & pay $515");
  await expect(byText(page, /Photography session, Studio Dayglow/)).toBeVisible();
  await expectFits(page, "the booking page of a session");
});

test("a customer's account fits a phone: overview, appointments, rewards and receipts", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  // Mia has made every phone booking above, each paid by card.
  await signIn(page, mia.email);
  const fits = async (where: string) => {
    await expectFits(page, where);
    expect(await hardToTouch(page), `${where}: hard to use by touch`).toEqual([]);
    expect(await tooSmallToRead(page), `${where}: text too small`).toEqual([]);
  };
  await expect(onScreen(page.locator(".account-card", { hasText: "Your next appointment" }))).toContainText("Studio Paris");
  await expect(onScreen(page.locator(".stamp-row"))).toBeVisible();
  await fits("the account's overview");
  await shot(page, "m-375-account");

  await page.getByRole("link", { name: "My Appointments", exact: true }).click();
  await expect(onScreen(page.locator(".appointment-card")).first()).toBeVisible();
  await fits("my appointments");
  await shot(page, "m-375-appointments");
  await page.getByRole("link", { name: /^Past/ }).click();
  await expect(byLabel(page, "Status")).toBeVisible();
  await fits("my past appointments, with their filter");

  await page.getByRole("link", { name: "My Rewards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My Loyalty Rewards" })).toBeVisible();
  await fits("my rewards");

  await page.getByRole("link", { name: "Receipts & Payments", exact: true }).click();
  await expect(onScreen(page.locator(".receipt-list li")).first()).toBeVisible();
  await fits("receipts and payments");
  await shot(page, "m-375-receipts");
  await page.getByRole("link", { name: "View", exact: true }).first().click();
  await expect(onScreen(page.locator("article.receipt"))).toContainText("Card, online");
  await fits("a receipt");
  await shot(page, "m-375-receipt");

  // The narrowest phone as well.
  await page.setViewportSize({ width: 320, height: 568 });
  for (const path of ["/account", "/account/appointments", "/account/rewards", "/account/receipts"]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expectFits(page, `${path} at 320px`);
  }
});

test("starting from the time works on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const date = dateAhead(108);
  await page.goto("/book");
  await page.getByRole("radio", { name: /I want to choose the date first/ }).click();
  await byLabel(page, "Date").fill(date);
  await page.getByRole("button", { name: "1 hr", exact: true }).click();
  await page.getByRole("button", { name: /^10:00 AM/ }).click();
  await expectFits(page, "the time step, starting from the time");
  expect(await hardToTouch(page), "the time step: hard to use by touch").toEqual([]);
  await next(page);
  await pickStudio(page, "Studio Blanche");
  await expectFits(page, "the studios step, starting from the time");
  await next(page);
  await fillDetails(page, mia);
  await agreeToPolicies(page);
  await next(page);
  await confirmAndGetRef(page, "Confirm & pay $88");
});

test("a tablet's touch screen gets the touch rules: controls a finger can press, fields an iPad does not zoom", async ({ browser }) => {
  test.setTimeout(300_000);
  // An iPad: touch, so its pointer is coarse, at a width where the phones' layout no longer applies; then held sideways,
  // wide enough for the whole menu.
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  // Its errors go where the other tests' go, and fail the test after it.
  watchBrowser(page, (problem) => browserProblems.push(problem), { where: " on an iPad" });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "an iPad's pointer is coarse").toBe(true);
  const touchable = async (where: string) => {
    expect(await hardToTouch(page), `${where} on an iPad: hard to use by touch`).toEqual([]);
    expect(await tooSmallToRead(page), `${where} on an iPad: text too small`).toEqual([]);
  };
  const OWNER_PAGES = ["/admin", "/admin/calendar", "/admin/calendar/new", "/admin/bookings", "/admin/customers", "/admin/prices", "/admin/studios", "/admin/hours", "/admin/codes", "/admin/settings", "/admin/website/pages", "/account", "/account/appointments?tab=past"];
  for (const size of [
    { width: 768, height: 1024 },
    // Held sideways: an iPad Air or Pro, and the smaller iPads (the owners' note of 2026-11-22: the front desk's iPad).
    { width: 1180, height: 820 },
    { width: 1080, height: 810 },
  ]) {
    await page.setViewportSize(size);
    for (const path of PUBLIC_PAGES) {
      await page.goto(path);
      await expect(page.locator("main h1, main h2").first()).toBeVisible();
      await touchable(`${path} at ${size.width}px`);
    }
    // Made taller for a finger, the logo and a menu item that opens more links keep the space inside their words,
    // which a flex box would drop ("The VisualPhoto Studio", "Info▾"): in the menu folded at 768px, beside it at 1180px.
    await page.goto("/");
    if (size.width <= 1000) await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.locator(".nav-more").first()).toBeVisible();
    const spaces = await page.evaluate(() => {
      /** From the end of the box's own words to the start of the part of them in an element. */
      const spaceBefore = (box: Element | null) => {
        const part = box?.querySelector("span");
        const words = [...(box?.childNodes ?? [])].find((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
        if (!part || !words) return null;
        const range = document.createRange();
        range.setStart(words, 0);
        range.setEnd(words, (words.textContent ?? "").trimEnd().length);
        return part.getBoundingClientRect().left - range.getBoundingClientRect().right;
      };
      return { logo: spaceBefore(document.querySelector(".site-logo")), more: spaceBefore(document.querySelector(".nav-more")) };
    });
    expect(spaces.logo, `the space inside the logo at ${size.width}px`).toBeGreaterThan(2);
    expect(spaces.more, `the space before "Info"'s arrow at ${size.width}px`).toBeGreaterThan(2);
    if (size.width === 768) await signIn(page, IPAD_OWNER, "/admin");
    for (const path of OWNER_PAGES) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      await touchable(`${path} at ${size.width}px`);
    }
    // What the front desk's iPad is used for most (the owners' note of 2026-11-22): the calendar's day and week with
    // every studio, on the day the phones booked above, and an appointment opened over the calendar.
    const busyDay = dateAhead(70);
    for (const path of [`/admin/calendar?view=week&date=${busyDay}`, `/admin/calendar?view=day&date=${busyDay}`]) {
      await page.goto(path);
      await expect(page.getByRole("link", { name: /Mia Mobile/ }).first()).toBeVisible();
      await touchable(`${path} at ${size.width}px`);
    }
    await page.getByRole("link", { name: /Mia Mobile/ }).first().click();
    await expect(page.getByRole("dialog", { name: /Mia Mobile/ })).toBeVisible();
    await touchable(`an appointment's pop-up at ${size.width}px`);
  }
  await context.close();
});

test("the admin fits a phone: the calendar in its three views, an appointment, and every page of the owners", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const day = dateAhead(70); // the day of the first phone booking above
  await signIn(page, OWNER, `/admin/calendar?view=day&date=${day}`);

  // A client whose name is one long word, booked for the same day from the calendar: the week's list keeps the name
  // whole beside its status where the name fits a line of its own.
  await page.getByRole("link", { name: "New booking" }).click();
  await page.getByRole("checkbox", { name: "Studio Blanche" }).check();
  await byLabel(page, "Length").selectOption({ label: "1 hour" });
  await page.getByRole("button", { name: "Show free times" }).click();
  await page.getByLabel("Free start times").selectOption({ label: "3:00 PM – 4:00 PM" });
  await page.getByLabel("Client’s name").fill(LONG_CLIENT);
  await page.getByLabel("Client’s email").fill("long.name@example.com");
  await page.getByLabel("Client’s phone").fill("407-555-0199");
  await page.getByRole("button", { name: "Book for the client" }).click();
  await expect(page.getByRole("heading", { name: LONG_CLIENT })).toBeVisible();
  await page.goto(`/admin/calendar?view=week&date=${day}`);

  // The week on a phone is a list, day by day, with each appointment a row that can be tapped.
  const row = onScreen(page.locator(".cal-agenda li", { hasText: "Mia Mobile" }));
  await expect(row).toContainText("9:15 AM – 10:45 AM");
  await expect(row).toContainText("Paris · 1.5 hours");
  await expect(row).toContainText("Confirmed");
  await expectFits(page, "the calendar's week");
  await shot(page, "m-390-calendar-week");
  expect(await hardToTouch(page), "the calendar's week: hard to use by touch").toEqual([]);

  // The month: tapping a day opens it.
  await page.getByRole("navigation", { name: "Calendar view" }).getByRole("link", { name: "Month" }).click();
  await expect(page).toHaveURL(/view=month/);
  await expectFits(page, "the calendar's month");
  const dayName = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  await page.getByRole("link", { name: dayName, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`view=day&date=${day}`));
  // The day keeps a column for each studio.
  const appointment = page.getByRole("link", { name: /Mia Mobile/ });
  await expect(appointment).toBeVisible();
  await expectFits(page, "the calendar's day");
  expect(await tooSmallToRead(page), "the calendar's day: text too small").toEqual([]);

  // Both from the phone (the owner, 2026-11-23): the agenda, two weeks as a list from the day, and back to the day's grid.
  await page.getByRole("navigation", { name: "Calendar view" }).getByRole("link", { name: "Agenda" }).click();
  await expect(page).toHaveURL(new RegExp(`view=agenda&date=${day}`));
  // Mia's first appointment is on the day the agenda starts from; another of hers comes later in the two weeks.
  const listed = onScreen(page.locator(".cal-agenda-view li", { hasText: "Mia Mobile" })).first();
  await expect(listed).toContainText("9:15 AM – 10:45 AM");
  await expect(onScreen(page.locator(".cal-agenda-view li", { hasText: LONG_CLIENT })).first()).toBeVisible();
  await expect(onScreen(page.locator(".cal-count"))).toHaveText(/^\d+ appointments? in these 14 days$/);
  await expectFits(page, "the calendar's agenda");
  expect(await hardToTouch(page), "the calendar's agenda: hard to use by touch").toEqual([]);
  expect(await tooSmallToRead(page), "the calendar's agenda: text too small").toEqual([]);
  await shot(page, "m-390-calendar-agenda");
  await page.getByRole("navigation", { name: "Calendar view" }).getByRole("link", { name: "Day" }).click();
  await expect(page).toHaveURL(new RegExp(`view=day&date=${day}`));
  await expect(appointment).toBeVisible();

  // An appointment: first over the calendar, then its page, with the label buttons and the form to move it.
  await appointment.click();
  const popup = page.getByRole("dialog", { name: /Mia Mobile/ });
  await expect(popup).toBeVisible();
  await expectFits(page, "an appointment's pop-up");
  expect(await hardToTouch(page), "an appointment's pop-up: hard to use by touch").toEqual([]);
  expect(await tooSmallToRead(page), "an appointment's pop-up: text too small").toEqual([]);
  await shot(page, "m-390-appointment-popup");
  await popup.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Mia Mobile", level: 1 })).toBeVisible();
  await expectFits(page, "an appointment");
  await shot(page, "m-390-appointment");
  expect(await hardToTouch(page), "an appointment: hard to use by touch").toEqual([]);
  await page.getByRole("button", { name: "Reschedule Pending", exact: true }).click();
  await expect(byText(page, "Marked Reschedule Pending.")).toBeVisible();

  // A booking made for a client on the phone. They pay by card, through a payment link emailed to them.
  await page.goto("/admin/calendar/new");
  await page.getByRole("checkbox", { name: "Studio Paris" }).check();
  await byLabel(page, "Date").fill(dateAhead(115));
  await byLabel(page, "Length").selectOption({ label: "1 hour" });
  await page.getByRole("button", { name: "Show free times" }).click();
  await page.getByLabel("Free start times").selectOption({ label: "11:00 AM – 12:00 PM" });
  await page.getByLabel("Client’s name").fill("Pat Phone");
  await page.getByLabel("Client’s email").fill("pat.phone@example.com");
  await page.getByLabel("Client’s phone").fill("407-555-0188");
  await page.getByRole("button", { name: "Book for the client" }).click();
  await expect(page.getByRole("heading", { name: "Pat Phone" })).toBeVisible();
  await expect(byText(page, "$68 is still to pay.")).toBeVisible();
  await expectFits(page, "an appointment that is still to pay");
  expect(await hardToTouch(page), "the form that marks a booking as paid: hard to use by touch").toEqual([]);
  await shot(page, "m-390-mark-as-paid");
  await page.getByRole("button", { name: "Email a payment link for $68" }).click();
  await expect(byText(page, /A payment link for \$68 was emailed to the client\./)).toBeVisible();
  await expect(onScreen(page.locator("#payment-link"))).toContainText("It has not been paid yet.");
  await expectFits(page, "an appointment with an open payment link");
  expect(await hardToTouch(page), "the payment link's buttons: hard to use by touch").toEqual([]);
  // While the link is open, money cannot be recorded by hand as well: the client could pay twice.
  await expect(page.getByRole("button", { name: "Record payment" })).toHaveCount(0);

  // The client opens the link from their email, on their own phone, and pays. (Test mode: no card is charged.)
  const linkMail = await latestEmail(page, "payment_link", "pat.phone@example.com");
  expect(linkMail.subject).toMatch(/^Pay for your booking VS-/);
  const payPath = new URL(/https?:\/\/\S+\/pay\/[0-9a-f-]{36}/.exec(linkMail.body)![0]).pathname;
  const client = await page.context().newPage();
  watchBrowser(client, (problem) => browserProblems.push(problem), { consoleErrors: false });
  await client.setViewportSize({ width: 390, height: 844 });
  await client.goto(payPath);
  await expect(client.getByRole("heading", { name: "Pay for Your Booking" })).toBeVisible();
  await expect(onScreen(client.locator(".price-row.total"))).toContainText("$68");
  await expectFits(client, "the page a payment link leads to");
  expect(await hardToTouch(client), "the page a payment link leads to: hard to use by touch").toEqual([]);
  expect(await accessibilityProblems(client), "the page a payment link leads to").toEqual([]);
  await shot(client, "m-390-pay-link");
  await client.getByRole("button", { name: "Pay $68 (test mode)" }).click();
  await expect(client.getByRole("heading", { name: "Payment Received" })).toBeVisible();
  expect(await accessibilityProblems(client), "the page a payment link leads to, once paid").toEqual([]);
  await expectFits(client, "the page a payment link leads to, once paid");
  await client.close();
  expect((await latestEmail(page, "payment_received", "pat.phone@example.com")).body).toContain("Paid by: Card, through the payment link");

  // Back in the admin the payment is on the booking, with nobody having typed it in.
  await page.reload();
  await expect(onScreen(page.locator("#payment"))).toContainText("Paid in full.");
  await expect(page.getByRole("row", { name: /\$68 · Card, through the payment link/ })).toBeVisible();
  await expectFits(page, "an appointment paid through a link");
  expect(await hardToTouch(page), "an appointment paid through a link: hard to use by touch").toEqual([]);

  // A font of the owners' own with a name of one long word, which its page repeats in a label above its file.
  await page.goto("/admin/website/fonts");
  await byLabel(page, "Name of the font").fill(LONG_FONT);
  await byLabel(page, "The licence you hold for it").fill("Web licence from the maker");
  await page.getByRole("checkbox", { name: "I hold a licence that allows this font on a website" }).check();
  await page.getByRole("button", { name: "Add the font" }).click();
  await expect(byText(page, "Font added. Now add its files: one for each weight you use.")).toBeVisible();
  // And a page named so, which the list of pages repeats on its buttons. It is made on a computer: making a page opens
  // its editor, which is made for a wider screen.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/website/pages");
  await byLabel(page, "Name of a new page").fill(LONG_ADDON);
  await page.getByRole("button", { name: "Make the page" }).click();
  await expect(byText(page, "Page made. It is a draft: visitors see it once you publish it.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  for (const path of [
    "/admin",
    "/admin/calendar/new",
    "/admin/bookings",
    "/admin/customers",
    `/admin/customers/${encodeURIComponent(mia.email)}`,
    "/staff",
    "/admin/staff",
    "/admin/prices",
    "/admin/studios",
    "/admin/hours",
    "/admin/availability",
    "/admin/photography",
    "/admin/content",
    "/admin/codes",
    "/admin/settings",
    "/admin/website",
    "/admin/website/design",
    "/admin/website/navigation",
    "/admin/website/media",
    "/admin/website/media/collections",
    "/admin/website/fonts",
    "/admin/website/pages",
    "/account",
  ]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expectFits(page, path);
    expect(await hardToTouch(page), `${path}: hard to use by touch`).toEqual([]);
  }

  // The smallest phone too, for the pages an administrator uses on the floor, and the pages that show names the owners
  // typed (the add-on of long words that the booking test above added is on Studios & add-ons and in a new booking).
  await page.setViewportSize({ width: 320, height: 568 });
  for (const path of [
    `/admin/calendar?view=day&date=${day}`,
    `/admin/calendar?view=week&date=${day}`,
    `/staff?date=${day}`,
    "/admin/calendar/new",
    "/admin",
    "/admin/bookings",
    "/admin/prices",
    "/admin/studios",
    "/admin/hours",
    "/admin/availability",
    "/admin/codes",
    "/admin/website/fonts",
    "/admin/website/pages",
  ]) {
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await expectFits(page, `${path} at 320px`);
  }
});
