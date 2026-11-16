import { expect, test, type Browser, type Page } from "@playwright/test";
import { byLabel, byText, onScreen, shot, signIn } from "./helpers";

/**
 * The website's editor (the owner's requirements 21, 25 and 27, and the
 * website part of 28): the design and the header, menu and footer are changed
 * as a draft, previewed, published, and brought back from the history.
 *
 * Runs after site.spec.ts and before z-mobile.spec.ts, on the same database.
 * It ends with the website as it was built, so the phone tests that follow
 * measure the site's own design.
 */
test.describe.configure({ mode: "serial" });

// The owner addresses of the other files have used their sign-in codes: three per address in 15 minutes.
const OWNER = "owner6@studio.test";
const MANAGER = "wes.e2e@studio.test";

let browserProblems: string[] = [];
const watch = (page: Page) => {
  page.on("pageerror", (error) => browserProblems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    // Pages that deliberately answer "not found" log a failed request; that is expected.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      browserProblems.push(`console error: ${message.text().slice(0, 400)}`);
    }
  });
};
test.beforeEach(({ page }) => {
  browserProblems = [];
  watch(page);
});
test.afterEach(() => {
  expect(browserProblems, "errors reported by the browser").toEqual([]);
});

/** A second browser with no cookies: what anyone who is not signed in sees. */
async function visitor(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  watch(page);
  return page;
}

/** A value of the design as the page in front of us has it. */
const designValue = (page: Page, name: string) =>
  page.evaluate((variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), name);

const saved = (page: Page) => expect(byText(page, /Draft saved at .+ Visitors do not see it yet\./)).toBeVisible();
const nothingToPublish = (page: Page) => expect(byText(page, "Nothing to publish: the website shows exactly this.")).toBeVisible();
const preview = (page: Page) => page.frameLocator('iframe[title="Preview of the website"]');
const group = (page: Page, title: string) =>
  onScreen(page.locator("details.editor-group")).filter({ has: page.locator("summary", { hasText: new RegExp(`^${title}$`) }) });

test("the owner changes the design as a draft, sees it in the preview, and visitors get it only once it is published", async ({ page, browser }) => {
  await signIn(page, OWNER, "/admin/website");
  await expect(page.getByRole("heading", { name: "Website", level: 1 })).toBeVisible();
  await expect(byText(page, "As the site was built. Nothing has been changed here yet.")).toHaveCount(2);
  await shot(page, "40-admin-website");

  await page.getByRole("link", { name: "Edit the design" }).click();
  await expect(page.getByRole("heading", { name: "Design", level: 1 })).toBeVisible();
  await nothingToPublish(page);
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  // The preview is the website itself.
  await expect(preview(page).getByRole("heading", { name: /Where Every Frame/ })).toBeVisible();
  // The editor says what can and cannot be read, without refusing anything.
  await expect(onScreen(page.locator(".editor-checks"))).toContainText("Words on a button in the accent colour");
  await expect(onScreen(page.locator(".editor-checks li.low").first())).toBeVisible();

  // A colour, a font and the corners of the buttons.
  await byLabel(page, "Accent, as a colour code").fill("#336699");
  await group(page, "Fonts").locator("summary").click();
  await byLabel(page, "Headings").selectOption({ label: "Bebas Neue" });
  await group(page, "Buttons").locator("summary").click();
  // A slider's label carries its value ("Rounded corners 2px"), so it is found by how it starts.
  await onScreen(page.getByLabel(/^Rounded corners/)).fill("24");
  // The preview shows it at once, before anything is saved, at every screen size.
  await expect.poll(() => preview(page).locator("html").evaluate((html) => getComputedStyle(html).getPropertyValue("--color-rose").trim())).toBe("#336699");
  await expect.poll(() => preview(page).locator("h1").first().evaluate((h1) => getComputedStyle(h1).fontFamily)).toMatch(/Bebas.Neue/i);
  await page.getByText("Small phone", { exact: true }).click();
  await expect(onScreen(page.locator(".editor-preview"))).toContainText("320px wide");
  await page.getByText("Computer", { exact: true }).click();
  await saved(page);
  await shot(page, "41-admin-website-design");

  // Nobody else sees a draft.
  const guest = await visitor(browser);
  await guest.goto("/");
  expect(await designValue(guest, "--color-rose")).toBe("#c8a882");
  await expect(guest.getByText("This shows changes that are not published yet")).toHaveCount(0);

  // The owner does, on the website itself, with a bar that says it is a preview, until they leave it.
  await page.goto("/rates");
  await expect(byText(page, "This shows changes that are not published yet. Visitors do not see them.")).toBeVisible();
  expect(await designValue(page, "--color-rose")).toBe("#336699");
  await page.getByRole("button", { name: "Leave the preview" }).click();
  await page.waitForURL(/\/rates$/);
  await expect(page.getByRole("heading", { name: "Studio Rates" })).toBeVisible();
  await expect(page.getByText("This shows changes that are not published yet")).toHaveCount(0);
  expect(await designValue(page, "--color-rose")).toBe("#c8a882");

  // The draft waited. Published, it is on the website for everyone.
  await page.goto("/admin/website");
  await expect(byText(page, "Unpublished changes.")).toBeVisible();
  await page.getByRole("link", { name: "Edit the design" }).click();
  await expect(byLabel(page, "Accent, as a colour code")).toHaveValue("#336699");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(byText(page, "Published. Visitors see it now.")).toBeVisible();
  await nothingToPublish(page);
  await expect(onScreen(page.locator(".editor-history"))).toContainText("Version 1 · on the website now");
  await expect(onScreen(page.locator(".editor-history"))).toContainText(`by ${OWNER}`);

  await guest.goto("/");
  expect(await designValue(guest, "--color-rose")).toBe("#336699");
  expect(await designValue(guest, "--btn-radius")).toBe("24px");
  expect(await guest.locator("h1").first().evaluate((h1) => getComputedStyle(h1).fontFamily)).toMatch(/Bebas.Neue/i);
  // The booking steps follow the colours and fonts too, and still work.
  await guest.goto("/book");
  await expect(guest.getByRole("heading", { name: "Reserve Your Studio" })).toBeVisible();
  expect(await onScreen(guest.locator("a.btn-primary")).first().evaluate((button) => getComputedStyle(button).backgroundColor)).toBe("rgb(51, 102, 153)");
  await shot(guest, "42-website-new-design");
  await guest.context().close();
});

test("the owner changes the menu, the phone number and the announcement, and brings earlier versions back", async ({ page, browser }) => {
  await signIn(page, OWNER, "/admin/website/navigation");
  await expect(page.getByRole("heading", { name: "Header, menu & footer", level: 1 })).toBeVisible();
  await expect(preview(page).getByRole("link", { name: "Our Studios" })).toBeVisible();

  // The phone number, a new menu item and an announcement.
  await byLabel(page, "Phone number").fill("(407) 555-0142");
  const menu = group(page, "Menu");
  await menu.getByRole("button", { name: "Add a menu item" }).click();
  const added = menu.locator(".editor-menu-item").last();
  await expect(added).toContainText("Needs a name.");
  await added.getByLabel("Name", { exact: true }).fill("Gift Cards");
  await added.getByLabel("Leads to", { exact: true }).fill("javascript:alert(1)");
  await expect(added).toContainText("Not a link the site can show.");
  await added.getByLabel("Leads to", { exact: true }).fill("/contact");
  await expect(added.locator(".editor-problem")).toHaveCount(0);
  await group(page, "Announcement bar").locator("summary").click();
  await page.getByRole("checkbox", { name: "Show the announcement" }).check();
  await byLabel(page, "Message").fill("Holiday sets are up until January 5.");
  await byLabel(page, "Link after the message: its words").fill("Book now");
  await byLabel(page, "Link after the message: where it leads").fill("/book");
  await saved(page);
  // The preview loads again with the draft in it.
  await expect(preview(page).locator(".site-nav").getByRole("link", { name: "Gift Cards" })).toBeVisible();
  await expect(preview(page).getByText("Holiday sets are up until January 5.")).toBeVisible();
  await shot(page, "43-admin-website-navigation");

  const guest = await visitor(browser);
  await guest.goto("/");
  await expect(guest.locator(".site-nav").getByRole("link", { name: "Gift Cards" })).toHaveCount(0);
  await expect(guest.locator(".site-footer")).toContainText("(407) 663-6109");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(byText(page, "Published. Visitors see it now.")).toBeVisible();

  // Visitors: the new item leads somewhere, the phone number is everywhere, the announcement can be closed.
  await guest.goto("/");
  await expect(guest.getByText("Holiday sets are up until January 5.")).toBeVisible();
  await expect(guest.locator(".site-announcement").getByRole("link", { name: "Book now" })).toHaveAttribute("href", "/book");
  await expect(guest.locator(".site-footer")).toContainText("(407) 555-0142");
  await expect(guest.locator(".site-footer")).not.toContainText("(407) 663-6109");
  await shot(guest, "44-website-new-menu");
  await guest.locator(".site-nav").getByRole("link", { name: "Gift Cards" }).click();
  await expect(guest.getByRole("heading", { name: "Contact Us" })).toBeVisible();
  await expect(onScreen(guest.locator(".contact-grid"))).toContainText("(407) 555-0142");
  await guest.getByRole("button", { name: "Close this announcement" }).click();
  await expect(guest.getByText("Holiday sets are up until January 5.")).toHaveCount(0);
  await guest.locator(".site-nav").getByRole("link", { name: "Rates", exact: true }).click();
  await expect(guest.getByRole("heading", { name: "Studio Rates" })).toBeVisible();
  await expect(guest.getByText("Holiday sets are up until January 5.")).toHaveCount(0);
  // The dropdown of the designer's menu still opens, now as part of the menu.
  await guest.locator(".site-nav").getByRole("button", { name: "Info" }).click();
  await guest.locator(".site-nav").getByRole("link", { name: "Policies" }).click();
  await expect(guest.getByRole("heading", { name: "Studio Policies" })).toBeVisible();

  // Back to the site as it was built: a draft first, then published as version 2.
  await page.getByRole("button", { name: "Start again from the site as it was built" }).click();
  await expect(byLabel(page, "Phone number")).toHaveValue("(407) 663-6109");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(byText(page, "Published. Visitors see it now.")).toBeVisible();
  const history = onScreen(page.locator(".editor-history"));
  await expect(history).toContainText("Version 2 · on the website now");
  await guest.goto("/");
  await expect(guest.locator(".site-nav").getByRole("link", { name: "Gift Cards" })).toHaveCount(0);
  await expect(guest.locator(".site-footer")).toContainText("(407) 663-6109");
  await expect(guest.locator(".site-announcement")).toHaveCount(0);

  // Version 1 comes back as a draft, which changes nothing for visitors, and is thrown away again.
  await history.getByRole("button", { name: "Bring back version 1" }).click();
  await expect(byText(page, "That version is now the draft. Look at it, then publish it or discard it.")).toBeVisible();
  await expect(byLabel(page, "Phone number")).toHaveValue("(407) 555-0142");
  await guest.reload();
  await expect(guest.locator(".site-footer")).toContainText("(407) 663-6109");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("button", { name: "Yes, discard them" }).click();
  await expect(byText(page, "The changes were discarded.")).toBeVisible();
  await expect(byLabel(page, "Phone number")).toHaveValue("(407) 663-6109");
  await nothingToPublish(page);

  // The design too goes back to the site as it was built, for the tests that follow.
  await page.goto("/admin/website/design");
  await page.getByRole("button", { name: "Start again from the site as it was built" }).click();
  await expect(byLabel(page, "Accent, as a colour code")).toHaveValue("#c8a882");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(byText(page, "Published. Visitors see it now.")).toBeVisible();
  await guest.goto("/");
  expect(await designValue(guest, "--color-rose")).toBe("#c8a882");
  expect(await guest.locator("h1").first().evaluate((h1) => getComputedStyle(h1).fontFamily)).toMatch(/Cormorant/i);
  await guest.context().close();
});

test("a manager cannot open the website until the owners let them, and then prepares drafts that an owner publishes", async ({ page, browser }) => {
  await signIn(page, OWNER, "/admin/staff");
  await byLabel(page, "Email").fill(MANAGER);
  await byLabel(page, "Name").fill("Wes");
  await onScreen(page.locator("#staff-level")).selectOption({ label: "Studio Manager" });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(byText(page, "Staff member added as Studio Manager.")).toBeVisible();

  const wes = await visitor(browser);
  await signIn(wes, MANAGER);
  for (const path of ["/admin/website", "/admin/website/design", "/admin/website/navigation"]) {
    await wes.goto(path);
    await expect(byText(wes, /could not be found/i)).toBeVisible();
  }
  expect((await wes.request.get("/admin/website/preview?to=%2F", { maxRedirects: 0 })).status()).toBe(404);

  // The owners switch it on, for drafts only.
  await page.getByRole("checkbox", { name: /Change the website's design, header, menu and footer/ }).check();
  await page.getByRole("button", { name: "Save what managers can do" }).click();
  await expect(byText(page, "Saved. It applies to every Studio Manager from now on.")).toBeVisible();

  await wes.goto("/admin/website");
  await expect(wes.getByRole("heading", { name: "Website", level: 1 })).toBeVisible();
  await expect(byText(wes, /You can prepare drafts; an owner publishes them\./)).toBeVisible();
  await expect(onScreen(wes.locator(".admin-nav"))).toContainText("Website");
  await wes.getByRole("link", { name: "Edit the design" }).click();
  await byLabel(wes, "Accent, as a colour code").fill("#884422");
  await saved(wes);
  await expect(wes.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await expect(byText(wes, "You can prepare changes as a draft. An owner publishes them.")).toBeVisible();
  await wes.context().close();

  // The owner finds the manager's draft, and decides. Here it is thrown away.
  await page.goto("/admin/website");
  await expect(onScreen(page.locator(".website-cards"))).toContainText(`by ${MANAGER}`);
  await page.getByRole("link", { name: "Edit the design" }).click();
  await expect(byLabel(page, "Accent, as a colour code")).toHaveValue("#884422");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("button", { name: "Yes, discard them" }).click();
  await expect(byText(page, "The changes were discarded.")).toBeVisible();
  await expect(byLabel(page, "Accent, as a colour code")).toHaveValue("#c8a882");

  // Leaving the preview the editor switched on, so that this browser ends on the published website.
  await page.goto("/");
  await page.getByRole("button", { name: "Leave the preview" }).click();
  await expect(page.getByText("This shows changes that are not published yet")).toHaveCount(0);
});
