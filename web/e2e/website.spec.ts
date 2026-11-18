import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { accessibilityProblems, byLabel, byText, frameworkNoise, onScreen, shot, signIn } from "./helpers";

/**
 * The website's editor (the owner's requirements 21, 25, 26 and 27, and the
 * website part of 28): the design and the header, menu and footer are changed
 * as a draft, previewed, published, and brought back from the history; and
 * the media library takes pictures and fonts.
 *
 * Runs after site.spec.ts and before z-mobile.spec.ts, on the same database.
 * It ends with the design, the menu and the footer as the site was built, so
 * the phone tests that follow measure the site's own design. The two photos,
 * the facts and the floor plan it gives Studio Blanche stay, so those tests
 * also measure a studio that has all of them.
 */
test.describe.configure({ mode: "serial" });

// The owner addresses of the other files have used their sign-in codes: three per address in 15 minutes.
const OWNER = "owner6@studio.test";
const MANAGER = "wes.e2e@studio.test";

let browserProblems: string[] = [];
const watch = (page: Page) => {
  page.on("pageerror", (error) => {
    if (!frameworkNoise(error.message)) browserProblems.push(`script error: ${error.message}`);
  });
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
/**
 * Published. A page is measured on a phone first (the editor's phone check), which on the development server
 * can take longer than the usual wait: it draws the page twice, and resizes its pictures the first time.
 */
const published = (page: Page) => expect(byText(page, "Published. Visitors see it now.")).toBeVisible({ timeout: 90_000 });
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
  // Changed in another window meanwhile, and nothing in this one: Publish says so and shows the draft as it is now,
  // before anything is checked or published in this window's name, and offers nothing to save over it.
  const other = await page.context().newPage();
  watch(other);
  await other.goto("/admin/website/design");
  await byLabel(other, "Accent, as a colour code").fill("#225588");
  await saved(other);
  await other.close();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(byText(page, /^Not published: this was changed somewhere else by .+ since you opened it\. It is shown here now/)).toBeVisible();
  await expect(byLabel(page, "Accent, as a colour code")).toHaveValue("#225588");
  await expect(page.getByRole("button", { name: "Save mine over it" })).toHaveCount(0);
  await byLabel(page, "Accent, as a colour code").fill("#336699");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
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
  await published(page);

  // Visitors: the new item leads somewhere, the phone number is everywhere, the announcement can be closed.
  await guest.goto("/");
  await expect(guest.getByText("Holiday sets are up until January 5.")).toBeVisible();
  await expect(guest.locator(".site-announcement").getByRole("link", { name: "Book now" })).toHaveAttribute("href", "/book");
  await expect(guest.locator(".site-footer")).toContainText("(407) 555-0142");
  await expect(guest.locator(".site-footer")).not.toContainText("(407) 663-6109");
  await shot(guest, "44-website-new-menu");
  await guest.locator(".site-nav").getByRole("link", { name: "Gift Cards" }).click();
  await expect(guest.getByRole("heading", { name: "Contact Us" })).toBeVisible();
  await expect(onScreen(guest.locator(".blk-contact"))).toContainText("(407) 555-0142");
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
  await published(page);
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
  await published(page);
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

// ── The media library and the owners' own fonts (requirement 26, and the rest of 21) ──

// A seventh owner: the sixth has used its three sign-in codes above.
const PICTURES_OWNER = "owner7@studio.test";

/** A picture of one colour, made here, as a browser would send it. */
async function pictureFile(name: string, width: number, height: number, colour: string) {
  const png = name.endsWith(".png");
  const made = sharp({ create: { width, height, channels: 3, background: colour } });
  return { name, mimeType: png ? "image/png" : "image/jpeg", buffer: await (png ? made.png() : made.jpeg()).toBuffer() };
}

/** True once the picture has arrived and the browser could draw it. */
const drawn = (image: Locator) => expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);

test("the owner adds pictures, describes them, puts them on a studio, replaces one in place, and cannot delete one that is shown", async ({ page, browser }) => {
  await signIn(page, PICTURES_OWNER, "/admin/website/media");
  await expect(page.getByRole("heading", { name: "Pictures", level: 1 })).toBeVisible();
  await expect(byText(page, "No pictures yet. Add the first with the button above.")).toBeVisible();

  // Two pictures at once. A file that is not a picture is refused with the reason, and the others still arrive.
  await expect(page.getByLabel("Add pictures", { exact: true })).toBeEnabled();
  await page.getByLabel("Add pictures", { exact: true }).setInputFiles([
    await pictureFile("Blanche Wide (final).JPG", 1600, 1000, "#d9d2c5"),
    { name: "notes.jpg", mimeType: "image/jpeg", buffer: Buffer.from("these are words, not a picture") },
    await pictureFile("blanche-window.png", 900, 1200, "#c9b8a3"),
  ]);
  const sent = onScreen(page.locator(".media-sent"));
  await expect(sent.locator("li.added")).toHaveCount(2);
  await expect(sent.locator("li.refused")).toContainText("notes.jpg");
  await expect(sent.locator("li.refused")).toContainText("could not be read as a picture");
  const cards = onScreen(page.locator(".media-card"));
  await expect(cards).toHaveCount(2);
  await expect(byText(page, "Needs a description before it can be shown.")).toHaveCount(2);
  const wide = cards.filter({ hasText: "blanche-wide-final.jpg" });
  await expect(wide).toContainText("1600 × 1000");
  await expect(wide).toContainText("Not shown anywhere yet.");
  await drawn(wide.locator(".media-thumb img"));
  const address = (await wide.locator("a.media-thumb").getAttribute("href"))!;
  expect(address).toMatch(/^\/media\/[0-9a-f-]{36}\/1\/blanche-wide-final\.jpg$/);
  await shot(page, "45-admin-media");

  // One gets its description.
  await wide.getByLabel("What the picture shows").fill("Studio Blanche: the white cyclorama wall");
  await wide.getByRole("button", { name: "Save" }).click();
  await expect(byText(page, "Saved.")).toBeVisible();
  await expect(byText(page, "Needs a description before it can be shown.")).toHaveCount(1);
  // The library with pictures in it, as the accessibility scan sees it.
  expect(await accessibilityProblems(page)).toEqual([]);

  // A studio's photos come from the library. A picture that says nothing about itself is not taken.
  await page.goto("/admin/studios");
  await page.getByRole("button", { name: "Add photos of Studio Blanche" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose from the media library" });
  await chooser.getByRole("button", { name: /white cyclorama wall/ }).click();
  await chooser.getByRole("button", { name: /blanche-window\.png/ }).click();
  await chooser.getByRole("button", { name: "Use these 2 pictures" }).click();
  await expect(byText(page, "Say what the picture blanche-window.png shows first, in the media library. Then add it here.")).toBeVisible();

  await page.goto("/admin/website/media?show=undescribed");
  await expect(onScreen(page.locator(".media-card"))).toHaveCount(1);
  await byLabel(page, "What the picture shows").fill("Studio Blanche: the window side");
  await byLabel(page, "Words under it in a gallery").fill("Morning light");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(byText(page, "Saved.")).toBeVisible();
  await expect(byText(page, /No picture matches\./)).toBeVisible();

  await page.goto("/admin/studios");
  await page.getByRole("button", { name: "Add photos of Studio Blanche" }).click();
  await chooser.getByRole("button", { name: /white cyclorama wall/ }).click();
  await chooser.getByRole("button", { name: /the window side/ }).click();
  await chooser.getByRole("button", { name: "Use these 2 pictures" }).click();
  await expect(byText(page, "Photos added. Customers see them now.")).toBeVisible();
  const blanche = onScreen(page.locator(".admin-card", { hasText: "Photos of Studio Blanche" }));
  await expect(blanche.locator(".media-ordered li")).toHaveCount(2);
  await expect(blanche.locator(".media-ordered li").first()).toContainText("the white cyclorama wall");
  // The second becomes the first: the one on the studio's card.
  await page.getByRole("button", { name: "Move photo 2 of Studio Blanche earlier" }).click();
  await expect(blanche.locator(".media-ordered li").first()).toContainText("the window side");
  await shot(page, "46-admin-studio-photos");

  // Customers see the photo in place of the tinted box, at a size made for their screen.
  const guest = await visitor(browser);
  // A picture's own address serves it as it is stored, to be kept for a year; an address that names an
  // older file of it is kept only for a minute. Nobody who is not signed in can add a picture.
  const stored = await guest.request.get(address);
  expect(stored.status()).toBe(200);
  expect(stored.headers()["content-type"]).toBe("image/jpeg");
  expect(stored.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await guest.request.get(address.replace("/1/", "/9/"))).headers()["cache-control"]).toBe("public, max-age=60");
  expect((await guest.request.get("/media/00000000-0000-4000-8000-000000000000/1/none.jpg")).status()).toBe(404);
  const uninvited = await guest.request.post("/admin/website/media/upload", { multipart: { file: await pictureFile("x.jpg", 10, 10, "#000000") } });
  expect(uninvited.status()).toBe(401);
  await guest.goto("/");
  const card = onScreen(guest.locator(".studio-card", { hasText: "Studio Blanche" }));
  const photo = card.locator("img.studio-photo");
  await expect(photo).toHaveAttribute("alt", "Studio Blanche: the window side");
  await drawn(photo);
  expect(await photo.evaluate((element: HTMLImageElement) => element.currentSrc)).toMatch(/\/_next\/image\?url=%2Fmedia%2F[0-9a-f-]{36}%2F1%2Fblanche-window\.png/);
  await expect(card.locator(".studio-placeholder-text")).toHaveCount(0);
  await expect(onScreen(guest.locator(".studio-card", { hasText: "Studio Paris" })).locator(".studio-placeholder-text")).toBeVisible();
  await guest.goto("/studios");
  await drawn(guest.locator("#blanche img.studio-photo"));
  await expect(guest.locator("#blanche .studio-photo-strip img")).toHaveAttribute("alt", "Studio Blanche: the white cyclorama wall");
  await shot(guest, "47-studios-with-photos");

  // A new file in a picture's place: nobody edits a page, and the page shows the new file.
  await page.goto("/admin/website/media");
  const shown = onScreen(page.locator(".media-card")).filter({ hasText: "blanche-window.png" });
  await expect(shown).toContainText("Shown in the studio Studio Blanche.");
  await expect(shown.getByLabel(/^Replace the file of/)).toBeEnabled();
  await shown.getByLabel(/^Replace the file of/).setInputFiles(await pictureFile("window-retouched.jpg", 1000, 1000, "#8fa3b8"));
  const replaced = onScreen(page.locator(".media-card")).filter({ hasText: "window-retouched.jpg" });
  await expect(replaced).toContainText("1000 × 1000");
  await expect(replaced.getByLabel("What the picture shows")).toHaveValue("Studio Blanche: the window side");
  await guest.goto("/");
  await drawn(photo);
  expect(await photo.evaluate((element: HTMLImageElement) => element.currentSrc)).toMatch(/%2F2%2Fwindow-retouched\.jpg/);

  // A picture that is shown cannot be deleted, and the library says where it is shown.
  await replaced.locator("summary", { hasText: "Delete this picture" }).click();
  await expect(replaced).toContainText("It is shown in the studio Studio Blanche. Take it out there first.");
  await expect(replaced.getByRole("button", { name: "Yes, delete it" })).toHaveCount(0);

  // A collection with dates in the past: it holds its picture and shows nothing now.
  await page.goto("/admin/website/media/collections");
  await byLabel(page, "Name of a new collection").fill("Christmas sets");
  await page.getByRole("button", { name: "Make the collection" }).click();
  await expect(page.getByRole("heading", { name: "Christmas sets", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Add pictures from the library" }).click();
  await chooser.getByRole("button", { name: /white cyclorama wall/ }).click();
  await chooser.getByRole("button", { name: "Use this picture" }).click();
  await expect(byText(page, "Added.")).toBeVisible();
  await expect(onScreen(page.locator(".media-ordered li"))).toHaveCount(1);
  expect(await accessibilityProblems(page)).toEqual([]);
  await byLabel(page, "First day it shows").fill("2020-12-01");
  await byLabel(page, "Last day it shows").fill("2020-12-26");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(byText(page, "Saved.")).toBeVisible();
  await expect(byText(page, /Shown from Dec 1, 2020 to Dec 26, 2020: not showing now\./)).toBeVisible();
  await page.goto("/admin/website");
  await expect(onScreen(page.locator(".website-cards"))).toContainText("2 pictures. 1 collection.");
  await guest.context().close();
});

test("the owner adds a font of their own and uses it in the design, and gives the header a logo that is a picture", async ({ page, browser }) => {
  await signIn(page, PICTURES_OWNER, "/admin/website/fonts");
  await expect(page.getByRole("heading", { name: "Your fonts", level: 1 })).toBeVisible();

  // A font needs the owners' word on its licence.
  await byLabel(page, "Name of the font").fill("Horizon Test");
  await byLabel(page, "The licence you hold for it").fill("Web licence from the maker, bought in 2025");
  await page.getByRole("checkbox", { name: "I hold a licence that allows this font on a website" }).check();
  await page.getByRole("button", { name: "Add the font" }).click();
  await expect(byText(page, "Font added. Now add its files: one for each weight you use.")).toBeVisible();
  await expect(byText(page, "It has no file yet, so the design cannot use it. Add one below.")).toBeVisible();

  // Its file: a real font that comes with the framework. A file that is not a font is refused.
  await byLabel(page, "Add a file of Horizon Test").setInputFiles({ name: "horizon.woff2", mimeType: "font/woff2", buffer: Buffer.from("not a font at all, just words") });
  await page.getByRole("button", { name: "Add the file" }).click();
  await expect(byText(page, /That is not a font file\./)).toBeVisible();
  await byLabel(page, "Add a file of Horizon Test").setInputFiles("node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf");
  await page.getByRole("button", { name: "Add the file" }).click();
  await expect(byText(page, "File added. The font can now be chosen in the design.")).toBeVisible();
  await expect(onScreen(page.locator(".data-table"))).toContainText("Regular (400)");
  await shot(page, "48-admin-fonts");

  // The design offers it beside the library, the preview shows it at once, and visitors get it once it is published.
  await page.goto("/admin/website/design");
  await group(page, "Fonts").locator("summary").click();
  await byLabel(page, "Headings").selectOption({ label: "Horizon Test" });
  await expect.poll(() => preview(page).locator("h1").first().evaluate((h1) => getComputedStyle(h1).fontFamily)).toMatch(/^"?uf-[0-9a-f]{12}/);
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
  const guest = await visitor(browser);
  await guest.goto("/");
  expect(await guest.locator("h1").first().evaluate((h1) => getComputedStyle(h1).fontFamily)).toMatch(/^"?uf-[0-9a-f]{12}/);
  // The font's file arrives from this website and the browser accepts it as a font.
  await expect.poll(() => guest.evaluate(() => [...document.fonts].some((face) => face.family.includes("uf-") && face.status === "loaded"))).toBe(true);

  // While the design uses it, it cannot be deleted.
  await page.goto("/admin/website/fonts");
  await expect(byText(page, /The design uses this font\./)).toBeVisible();
  await page.locator("summary", { hasText: "Delete Horizon Test" }).click();
  await expect(byText(page, "The design uses it, in what is published or in a draft. Choose another font there first.")).toBeVisible();

  // Back to the site as it was built, so the tests that follow measure its own design. Then the font can go.
  await page.goto("/admin/website/design");
  await page.getByRole("button", { name: "Start again from the site as it was built" }).click();
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
  await page.goto("/admin/website/fonts");
  await page.locator("summary", { hasText: "Delete Horizon Test" }).click();
  await page.getByRole("button", { name: "Yes, delete Horizon Test" }).click();
  await expect(byText(page, "The font was deleted.")).toBeVisible();
  await guest.goto("/");
  expect(await guest.locator("h1").first().evaluate((h1) => getComputedStyle(h1).fontFamily)).toMatch(/Cormorant/i);
  await guest.context().close();

  // A logo that is a picture, chosen from the library: seen in the preview, then put back.
  await page.goto("/admin/website/navigation");
  await group(page, "Logo").locator("summary").click();
  await page.getByRole("button", { name: "Choose a picture for the logo" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose from the media library" });
  await chooser.getByRole("button", { name: /white cyclorama wall/ }).click();
  await chooser.getByRole("button", { name: "Use this picture" }).click();
  await saved(page);
  const logo = preview(page).locator(".site-nav img.site-logo-picture");
  await expect(logo).toHaveAttribute("alt", "The Visuals Photo Studio");
  await drawn(logo);
  await expect(page.getByRole("button", { name: "Go back to the text logo" })).toBeVisible();
  // The library knows the header shows it, although only in a draft.
  await page.goto("/admin/website/media?q=cyclorama");
  await expect(onScreen(page.locator(".media-card"))).toContainText("the header");
  await page.goto("/admin/website/navigation");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("button", { name: "Yes, discard them" }).click();
  await expect(byText(page, "The changes were discarded.")).toBeVisible();
  await expect(preview(page).locator(".site-nav .site-logo")).toContainText("The Visuals");

  await page.goto("/");
  await page.getByRole("button", { name: "Leave the preview" }).click();
  await expect(page.getByText("This shows changes that are not published yet")).toHaveCount(0);
});

/** A floor plan drawn as a picture: the walls, the windows along one long side, and the cyclorama's curve in a corner. */
async function floorPlanFile(name: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="840" viewBox="0 0 1200 840">
    <rect width="1200" height="840" fill="#ffffff"/>
    <rect x="60" y="60" width="1080" height="720" fill="none" stroke="#222222" stroke-width="14"/>
    <rect x="240" y="52" width="720" height="16" fill="#8fb3d9"/>
    <path d="M 760 780 L 760 560 Q 760 500 820 500 L 1140 500" fill="none" stroke="#999999" stroke-width="8"/>
  </svg>`;
  return { name, mimeType: "image/png", buffer: await sharp(Buffer.from(svg)).png().toBuffer() };
}

test("the owner writes what photographers choose a studio by and gives it a floor plan, and visitors see them on the studios page", async ({ page, browser }) => {
  // The seventh owner's third sign-in.
  await signIn(page, PICTURES_OWNER, "/admin/studios");
  const blanche = onScreen(page.locator(".admin-card").filter({ has: page.getByRole("heading", { name: "Studio Blanche", level: 3, exact: true }) }));
  await expect(byText(blanche, /^None yet\. A drawing of the room/)).toBeVisible();
  await byLabel(blanche, "Size").fill("850 sq ft");
  await byLabel(blanche, "Ceiling height").fill("14 ft");
  await byLabel(blanche, "Light").fill("Floor-to-ceiling windows facing southeast");
  await byLabel(blanche, "Cyclorama").fill("10 × 15 ft white cyclorama wall");
  await byLabel(blanche, "What comes with it, one thing a line").fill("Paper backdrops\n\n  C-stands and sandbags  \nClothing rack and steamer\n");
  await page.getByRole("button", { name: "Save Studio Blanche" }).click();
  await expect(byText(page, "Studio saved.")).toBeVisible();
  // What is kept: one thing a line, without the empty line and the spaces around a thing.
  await page.goto("/admin/studios");
  await expect(byLabel(blanche, "What comes with it, one thing a line")).toHaveValue("Paper backdrops\nC-stands and sandbags\nClothing rack and steamer");

  // A floor plan is a picture of the library, described like any other.
  await page.goto("/admin/website/media");
  await expect(page.getByLabel("Add pictures", { exact: true })).toBeEnabled();
  await page.getByLabel("Add pictures", { exact: true }).setInputFiles([await floorPlanFile("blanche-plan.png")]);
  await expect(onScreen(page.locator(".media-sent")).locator("li.added")).toHaveCount(1);
  const plan = onScreen(page.locator(".media-card")).filter({ hasText: "blanche-plan.png" });
  await plan.getByLabel("What the picture shows").fill("Floor plan of Studio Blanche: 25 by 34 feet, the windows along the long wall");
  await plan.getByRole("button", { name: "Save" }).click();
  await expect(byText(page, "Saved.")).toBeVisible();

  await page.goto("/admin/studios");
  await page.getByRole("button", { name: "Choose a floor plan for Studio Blanche" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose from the media library" });
  await chooser.getByRole("button", { name: /Floor plan of Studio Blanche/ }).click();
  await chooser.getByRole("button", { name: "Use this picture" }).click();
  await expect(byText(page, "Floor plan chosen. Customers see it now.")).toBeVisible();
  await drawn(blanche.getByRole("img", { name: /^Floor plan of Studio Blanche/ }));
  await expect(page.getByRole("button", { name: "Take the floor plan of Studio Blanche away" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose another floor plan for Studio Blanche" })).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
  await shot(page, "46b-admin-studio-facts");

  // Visitors get the facts that are written, in their order, and the floor plan under the studio's photo.
  const guest = await visitor(browser);
  await guest.goto("/studios");
  const shown = guest.locator("#blanche");
  await expect(shown.locator("dl.studio-facts dt")).toHaveText(["Size", "Ceiling", "Light", "Cyclorama"]);
  await expect(shown.locator("dl.studio-facts dd")).toHaveText(["850 sq ft", "14 ft", "Floor-to-ceiling windows facing southeast", "10 × 15 ft white cyclorama wall"]);
  await expect(shown.locator(".studio-included li")).toHaveText(["Paper backdrops", "C-stands and sandbags", "Clothing rack and steamer"]);
  const drawing = shown.locator(".studio-floor-plan img");
  await expect(drawing).toHaveAttribute("alt", "Floor plan of Studio Blanche: 25 by 34 feet, the windows along the long wall");
  await drawn(drawing);
  await expect(shown.locator(".studio-floor-plan figcaption")).toHaveText("Floor plan of Studio Blanche");
  // A studio with none of them shows no empty list.
  await expect(guest.locator("#paris").locator(".studio-facts, .studio-included, .studio-floor-plan")).toHaveCount(0);
  expect(await accessibilityProblems(guest)).toEqual([]);
  await shot(guest, "47b-studios-with-facts");

  // A fact taken out is no longer shown.
  await byLabel(blanche, "Cyclorama").fill("");
  await page.getByRole("button", { name: "Save Studio Blanche" }).click();
  await expect(byText(page, "Studio saved.")).toBeVisible();
  await guest.reload();
  await expect(guest.locator("#blanche dl.studio-facts dt")).toHaveText(["Size", "Ceiling", "Light"]);
  await guest.context().close();
});

// ── Pages made of blocks (requirements 22, 23 and 24) ──

// An eighth owner: the sixth and seventh have used their sign-in codes above.
const PAGES_OWNER = "owner8@studio.test";

const canvasOf = (page: Page) => page.frameLocator("iframe#preview-frame");

/**
 * Where an element of the page drawn in the editor is on the screen. The
 * editor draws the page smaller than it is, to fit (its zoom), and
 * `boundingBox` does not count that: the element's place inside its frame
 * is scaled here as the frame is.
 */
async function onCanvas(page: Page, element: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const frame = (await page.locator("iframe#preview-frame").boundingBox())!;
  const inside = await element.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, frameWidth: el.ownerDocument.defaultView!.innerWidth };
  });
  const scale = frame.width / inside.frameWidth;
  return { x: frame.x + inside.x * scale, y: frame.y + inside.y * scale, width: inside.width * scale, height: inside.height * scale };
}

/**
 * Drag a block from the editor's list of blocks onto the page drawn in the
 * editor: at the bottom of `onto`, which puts it after that block, or in the
 * middle of `onto`, which puts it into an empty place for blocks.
 *
 * On a busy machine the editor can miss a drag altogether: no place to drop
 * is ever shown, and the block stays in the air after the mouse lets go (the
 * tester's run of 2026-11-17, twice, with the machine's load at 7 to 12). So
 * the drag is judged by its outcome, a block more on the page, and one the
 * editor missed is let go of and made again, more slowly.
 */
async function dragBlock(page: Page, name: string, onto: Locator, where: "bottom" | "middle" = "bottom") {
  const onPage = canvasOf(page).locator("[data-puck-component]");
  const before = await onPage.count();
  for (let attempt = 1; ; attempt++) {
    await dragBlockOnce(page, name, onto, where, attempt);
    const landed = await expect
      .poll(() => onPage.count(), { timeout: 5_000 })
      .toBeGreaterThan(before)
      .then(
        () => true,
        () => false,
      );
    // The third time is left to the test's own check, which says what is missing.
    if (landed || attempt === 3) return;
    await page.keyboard.press("Escape");
    await page.mouse.move(8, 8, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
}

/** One drag of `dragBlock`; `slowly` is 1 the first time and more when the editor missed the drag before. */
async function dragBlockOnce(page: Page, name: string, onto: Locator, where: "bottom" | "middle", slowly: number) {
  await page.locator(".page-editor-canvas").scrollIntoViewIfNeeded();
  const source = page.locator("[data-puck-drawer-item]").filter({ has: page.getByText(name, { exact: true }) }).first();
  await source.scrollIntoViewIfNeeded();
  // In the middle of the list of blocks, which scrolls on its own: a drag that starts at an edge of it makes the
  // editor scroll by itself, and the drop then lands somewhere else. The window itself is not scrolled.
  await source.evaluate((element) => {
    let list = element.parentElement;
    while (list && list !== document.documentElement && list.scrollHeight <= list.clientHeight) list = list.parentElement;
    if (!list || list === document.documentElement) return;
    // Room below the last block, so that it too can be brought to the middle ("Contact form" is last).
    list.style.paddingBottom = `${Math.round(list.clientHeight / 2)}px`;
    const off = element.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop += off - (list.clientHeight - element.clientHeight) / 2;
  });
  const from = (await source.boundingBox())!;
  const target = where === "middle" ? await onCanvas(page, onto) : (await onto.boundingBox())!;
  const to = { x: target.x + target.width / 2, y: where === "middle" ? target.y + target.height / 2 : target.y + target.height - 2 };
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // The editor takes the press for a drag once the mouse has moved a little: it is given the time to.
  await page.waitForTimeout(100 * slowly);
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 * slowly });
  await page.waitForTimeout(100 * slowly);
  await page.mouse.move(to.x, to.y, { steps: 30 * slowly });
  await page.waitForTimeout(400 * slowly);
  await page.mouse.move(to.x, to.y + 3, { steps: 5 });
  await page.waitForTimeout(100 * slowly);
  await page.mouse.up();
}

test("the owner makes a page from blocks, previews it, and visitors see it at its address once it is published", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await signIn(page, PAGES_OWNER, "/admin/website/pages");
  await expect(page.getByRole("heading", { name: "Pages", level: 1 })).toBeVisible();
  // The pages the website was built with are there already, the home page first.
  await expect(page.locator(".page-list h3").first()).toHaveText("Home");
  // The old addresses of the live site are already sent on.
  await expect(onScreen(page.locator(".trash-list"))).toContainText("/guestinfo → /faq");

  await byLabel(page, "Name of a new page").fill("Gift Cards");
  await page.getByRole("button", { name: "Make the page" }).click();
  await expect(byText(page, "Page made. It is a draft: visitors see it once you publish it.")).toBeVisible();
  await expect(page.locator(".page-editor-where")).toContainText("/gift-cards · Draft: not on the website");
  const canvas = canvasOf(page);
  await expect(canvas.locator("h1")).toHaveText("Gift Cards");

  // Words are changed in the panel of the block that is pressed, and the page in the editor follows.
  await canvas.locator("h1").click();
  await page.getByRole("textbox", { name: "Heading" }).fill("Gift cards for every occasion");
  await expect(canvas.locator("h1")).toHaveText("Gift cards for every occasion");
  // A block is dragged onto the page from the list.
  await dragBlock(page, "Buttons", canvas.locator(".blk-text"));
  await expect(canvas.locator(".blk-buttons")).toContainText("Book a Studio");
  await expect(byText(page, /Draft saved at .+ Visitors do not see it yet\./)).toBeVisible();
  await shot(page, "48-admin-page-editor");
  // The editor around the page: its bar, the page's settings and the lists beside it. The canvas is Puck's own.
  expect(await accessibilityProblems(page, { exclude: [".page-editor-canvas"] }), "the page editor").toEqual([]);

  // Not on the website yet.
  const guest = await visitor(browser);
  expect((await guest.goto("/gift-cards"))?.status()).toBe(404);

  // The preview shows the draft, on the website itself, to the owner alone.
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Preview" }).click();
  const preview = await opened;
  await preview.waitForURL(/\/gift-cards$/);
  await expect(preview.getByRole("heading", { name: "Gift cards for every occasion", level: 1 })).toBeVisible();
  await expect(preview.getByText("This shows changes that are not published yet. Visitors do not see them.")).toBeVisible();
  await preview.getByRole("button", { name: "Leave the preview" }).click();
  // Out of the preview, the draft is not there.
  await expect(byText(preview, /could not be found/i)).toBeVisible();
  await preview.close();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
  await expect(page.locator(".page-editor-where")).toContainText("/gift-cards · On the website");

  // A visitor finds it at its address, with the studio's name after the page's on the tab.
  expect((await guest.goto("/gift-cards"))?.status()).toBe(200);
  await expect(guest.getByRole("heading", { name: "Gift cards for every occasion", level: 1 })).toBeVisible();
  await expect(guest.locator(".blk-buttons").getByRole("link", { name: "Book a Studio" })).toHaveAttribute("href", "/book");
  expect(await guest.title()).toBe("Gift Cards | The Visuals Photo Studio");
  await shot(guest, "49-website-made-page");
  // Search engines are told about it, and an address that is no page answers "not found".
  expect(await (await guest.request.get("/sitemap.xml")).text()).toContain("/gift-cards</loc>");
  expect((await guest.request.get("/no-such-page")).status()).toBe(404);
  // An old address of the live site leads to its page here.
  const old = await guest.request.get("/guestinfo", { maxRedirects: 0 });
  expect(old.status()).toBe(308);
  expect(old.headers()["location"]).toBe("/faq");
  await guest.context().close();
});

test("a page shows a picture shaped differently on a phone, and its address can change without breaking old links", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await signIn(page, PAGES_OWNER, "/admin/website/pages");
  await page.getByRole("link", { name: "Edit Gift Cards" }).click();
  const canvas = canvasOf(page);
  await expect(canvas.locator("h1")).toHaveText("Gift cards for every occasion");

  // A picture from the library, square on a phone and as it is on a computer.
  await dragBlock(page, "Picture", canvas.locator(".blk-buttons"));
  await expect(canvas.locator(".blk-note")).toContainText("Picture: choose one in the panel.");
  await page.getByRole("button", { name: "Choose a picture" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose from the media library" });
  await chooser.getByRole("button", { name: /white cyclorama wall/ }).click();
  await chooser.getByRole("button", { name: "Use this picture" }).click();
  await expect(canvas.locator(".blk-picture img")).toHaveAttribute("alt", "Studio Blanche: the white cyclorama wall");
  await page.getByRole("combobox", { name: "Shape, on a phone" }).selectOption({ label: "Square" });
  await expect(byText(page, /Draft saved at/)).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);

  const guest = await visitor(browser);
  await guest.goto("/gift-cards");
  const picture = guest.locator(".blk-picture img");
  await drawn(picture);
  const ratio = () => picture.evaluate((image) => image.getBoundingClientRect().width / image.getBoundingClientRect().height);
  expect(await ratio()).toBeCloseTo(1.6, 1);
  await guest.setViewportSize({ width: 390, height: 844 });
  await expect.poll(ratio).toBeCloseTo(1, 1);
  await shot(guest, "50-website-page-phone");

  // A new address: the old one is sent on to it.
  await byLabel(page, "Address").fill("gift-vouchers");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(byText(page, "Saved. The page's address is /gift-vouchers.")).toBeVisible();
  const moved = await guest.request.get("/gift-cards", { maxRedirects: 0 });
  expect(moved.status()).toBe(308);
  expect(moved.headers()["location"]).toBe("/gift-vouchers");
  await guest.goto("/gift-cards");
  await guest.waitForURL(/\/gift-vouchers$/);
  await expect(guest.getByRole("heading", { name: "Gift cards for every occasion", level: 1 })).toBeVisible();

  // A copy is a draft at an address of its own.
  await page.goto("/admin/website/pages");
  await page.getByRole("button", { name: "Copy Gift Cards" }).click();
  await expect(byText(page, "Copied. The copy is a draft, at an address of its own.")).toBeVisible();
  await expect(page.locator(".page-editor-where")).toContainText("/gift-vouchers-copy · Draft: not on the website");
  expect((await guest.request.get("/gift-vouchers-copy")).status()).toBe(404);

  // Taken off the website, then deleted and brought back: a draft again, with everything on it.
  await page.goto("/admin/website/pages");
  await page.getByRole("link", { name: "Edit Gift Cards" }).click();
  await page.getByRole("button", { name: "Take Gift Cards off the website" }).click();
  await expect(byText(page, "Taken off the website. It is kept here as a draft.")).toBeVisible();
  expect((await guest.request.get("/gift-vouchers")).status()).toBe(404);
  await page.locator("summary", { hasText: "Delete this page" }).click();
  await page.getByRole("button", { name: "Yes, delete Gift Cards" }).click();
  await expect(byText(page, "The page is in the trash, below. It can be brought back for 30 days.")).toBeVisible();
  await page.getByRole("button", { name: "Bring back Gift Cards" }).click();
  await expect(byText(page, "Brought back as a draft, at /gift-vouchers.")).toBeVisible();
  await page.getByRole("link", { name: "Edit Gift Cards" }).click();
  await expect(canvasOf(page).locator(".blk-picture img")).toBeVisible();
  await guest.context().close();
});

test("a manager who may edit pages prepares one as a draft, and an owner publishes it", async ({ page, browser }) => {
  await signIn(page, PAGES_OWNER, "/admin/staff");
  await page.getByRole("checkbox", { name: /Add and edit the website's pages/ }).check();
  await page.getByRole("button", { name: "Save what managers can do" }).click();
  await expect(byText(page, "Saved. It applies to every Studio Manager from now on.")).toBeVisible();

  const wes = await visitor(browser);
  await wes.setViewportSize({ width: 1440, height: 1200 });
  await signIn(wes, MANAGER, "/admin/website/pages");
  await byLabel(wes, "Name of a new page").fill("Winter Offer");
  await wes.getByRole("button", { name: "Make the page" }).click();
  await expect(canvasOf(wes).locator("h1")).toHaveText("Winter Offer");
  await expect(byText(wes, "You can prepare changes as a draft. An owner publishes them.")).toBeVisible();
  await expect(wes.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await wes.context().close();

  await page.goto("/admin/website/pages");
  await expect(onScreen(page.locator(".page-list"))).toContainText(`Last changed`);
  await page.getByRole("link", { name: "Edit Winter Offer" }).click();
  await expect(canvasOf(page).locator("h1")).toHaveText("Winter Offer");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
  const guest = await visitor(browser);
  await guest.goto("/winter-offer");
  await expect(guest.getByRole("heading", { name: "Winter Offer", level: 1 })).toBeVisible();
  await guest.context().close();
});

// ── Blocks that show the studio's own data, and live values (requirements 22 and 29) ──

// A ninth owner: the eighth has used its sign-in codes above.
const DATA_OWNER = "owner9@studio.test";

test("a page shows the studios, prices, contact details and form from the studio's data, and its text follows the settings", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await signIn(page, DATA_OWNER, "/admin/website/pages");
  await byLabel(page, "Name of a new page").fill("Visit Us");
  await page.getByRole("button", { name: "Make the page" }).click();
  const canvas = canvasOf(page);
  await expect(canvas.locator("h1")).toHaveText("Visit Us");

  // A live value is typed into the heading: the editor shows its name.
  await canvas.locator("h1").click();
  await page.getByRole("textbox", { name: "Heading" }).fill("Cancel {refund window} ahead");
  await expect(canvas.locator("h1")).toHaveText("Cancel {refund window} ahead");
  // The blocks that show the studio's data, dragged onto the page.
  await dragBlock(page, "Studio cards", canvas.locator(".blk-text"));
  await expect(canvas.locator(".studio-card")).toHaveCount(3);
  await dragBlock(page, "Address, phone and hours", canvas.locator(".studios-grid"));
  await expect(canvas.locator(".blk-contact")).toContainText("(407) 663-6109");
  await dragBlock(page, "Contact form", canvas.locator(".blk-contact"));
  await expect(canvas.getByText("The contact form. Visitors write to you here")).toBeVisible();
  await expect(byText(page, /Draft saved at/)).toBeVisible();
  // The list of live values beside the editor says what each shows now.
  await page.locator("summary", { hasText: "Live values" }).click();
  await expect(onScreen(page.locator("#live-values"))).toContainText("{refund window}");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);

  const guest = await visitor(browser);
  await guest.goto("/visit-us");
  await expect(guest.getByRole("heading", { name: "Cancel 14 days ahead", level: 1 })).toBeVisible();
  await expect(guest.locator(".studio-card")).toHaveCount(3);
  await expect(guest.locator(".studio-card", { hasText: "Studio Paris" })).toContainText(/From \$\d+\/hour/);
  await expect(guest.locator(".studio-card", { hasText: "Studio Paris" }).getByRole("link", { name: "Book Now" })).toHaveAttribute("href", "/book?studio=paris");
  await expect(guest.locator(".blk-contact").getByRole("link", { name: "(407) 663-6109" })).toHaveAttribute("href", "tel:+14076636109");
  await expect(guest.getByRole("button", { name: "Send Message" })).toBeVisible();
  await shot(guest, "51-website-page-with-studio-data");

  // A change of the settings shows on the page by itself.
  await page.goto("/admin/settings");
  await byLabel(page, "Refund window (hours before start)").fill("240");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(byText(page, /saved/i).first()).toBeVisible();
  await guest.reload();
  await expect(guest.getByRole("heading", { name: "Cancel 10 days ahead", level: 1 })).toBeVisible();
  // Back as it was, for the tests that follow.
  await page.goto("/admin/settings");
  await byLabel(page, "Refund window (hours before start)").fill("336");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(byText(page, /saved/i).first()).toBeVisible();
  await guest.context().close();
});

// ── The website's own pages, made pages of the admin (requirement 29's content inventory) ──

test("the website's own pages are edited like any other: the home page keeps its address, and a page starts again from how it was built", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  // The ninth owner's second sign-in code.
  await signIn(page, DATA_OWNER, "/admin/website/pages");
  // The home page first, then the others by name: the pages the website was built with are all there, on the website.
  await expect(page.locator(".page-list h3").first()).toHaveText("Home");
  for (const name of ["Our Studios", "Rates", "Professional Photography", "Guest Information", "Studio Policies", "Contact"]) {
    await expect(onScreen(page.locator(".page-list li", { hasText: name }).first())).toContainText("On the website");
  }

  // The home page keeps the website's own address, and can neither leave the website nor be deleted.
  await page.getByRole("link", { name: "Edit Home" }).click();
  await expect(page.locator(".page-editor-where")).toContainText("/ · On the website");
  await expect(canvasOf(page).locator(".hero h1")).toContainText("Where Every Frame");
  await expect(page.locator("#page-address")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /off the website/ })).toHaveCount(0);
  await expect(page.getByText("Delete this page", { exact: true })).toHaveCount(0);

  // The photography page holds both ways to book; the editor shows both, and says which visitors see now.
  await page.goto("/admin/website/pages");
  await page.getByRole("link", { name: "Edit Professional Photography" }).click();
  const canvas = canvasOf(page);
  await expect(canvas.locator(".blk-when[data-shown='true']")).toContainText("Only while a photography session can be booked: visitors see it now.");
  await expect(canvas.locator(".blk-when[data-shown='false']")).toContainText("Only while no photography session can be booked: visitors do not see it now.");
  await page.locator("summary", { hasText: "Shown only at times" }).click();
  await expect(onScreen(page.locator("#page-conditions"))).toContainText("{if photography}");
  await shot(page, "52-admin-built-in-page");
  // Before it could leave the website, the editor says what links to it.
  await page.locator("summary", { hasText: "Delete this page" }).click();
  await expect(onScreen(page.locator(".media-delete"))).toContainText("Links lead here from the menu (Info, Photography) and the footer (Photography).");

  // Its words change like those of any page.
  await canvas.locator(".page-banner h1").click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Photography Sessions");
  await expect(canvas.locator(".page-banner h1")).toHaveText("Photography Sessions");
  await expect(byText(page, /Draft saved at/)).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
  const guest = await visitor(browser);
  await guest.goto("/services");
  await expect(guest.getByRole("heading", { name: "Photography Sessions", level: 1 })).toBeVisible();
  // The part for when no session can be booked is not there for visitors.
  await expect(guest.getByRole("link", { name: "Ask About a Session" })).toHaveCount(0);
  await expect(guest.getByRole("link", { name: "Book a Photographer" })).toBeVisible();

  // And it starts again from how it was built, which the website shows once it is published.
  await page.getByRole("button", { name: "Start again from the page as it was built" }).click();
  await expect(byText(page, "That version is now the draft. Look at it, then publish it or discard it.")).toBeVisible();
  await expect(canvasOf(page).locator(".page-banner h1")).toHaveText("Professional Photography");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
  await guest.goto("/services");
  await expect(guest.getByRole("heading", { name: "Professional Photography", level: 1 })).toBeVisible();
  await guest.context().close();
});

// ── The page editor's guard rails (requirement 24) ──

// A tenth owner: the ninth has used two of its sign-in codes above, and the guard rails want one of their own.
const GUARD_OWNER = "owner10@studio.test";

test("a page that would be wider than a phone is not published, and is once it fits", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await signIn(page, GUARD_OWNER, "/admin/website/pages");
  await byLabel(page, "Name of a new page").fill("Side by Side");
  await page.getByRole("button", { name: "Make the page" }).click();
  const canvas = canvasOf(page);
  await expect(canvas.locator("h1")).toHaveText("Side by Side");
  // Its address, as the editor says it: /side-by-side, or another when that one is taken.
  const path = /\/side-by-side(-\d+)?/.exec(await page.locator(".page-editor-where").innerText())![0];

  // The editor is ready once a block can be chosen.
  await canvas.locator("h1").click();
  await expect(page.getByRole("textbox", { name: "Heading" })).toHaveValue("Side by Side");

  // Four columns kept side by side on a phone, with a button in the last: on a phone, the button is past the screen's edge.
  await dragBlock(page, "Columns", canvas.locator(".blk-text"));
  await expect(canvas.locator(".blk-columns")).toHaveCount(1);
  await canvas.locator(".blk-columns").click({ position: { x: 5, y: 5 } });
  // One choice at a time: each shows on the page before the next is made.
  await page.getByRole("combobox", { name: "How many columns" }).selectOption({ label: "Four" });
  await expect(canvas.locator(".blk-columns")).toHaveAttribute("data-count", "4");
  await page.getByRole("combobox", { name: "On a phone" }).selectOption({ label: "Side by side" });
  await expect(canvas.locator(".blk-columns")).toHaveAttribute("data-phone", "keep");
  await dragBlock(page, "Buttons", canvas.locator(".blk-columns > .blk-stack").nth(3), "middle");
  await expect(canvas.locator(".blk-columns .blk-buttons")).toHaveCount(1);
  await expect(byText(page, /Draft saved at/)).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(byText(page, /Not published: on a phone, this page would be hard to use\./)).toBeVisible({ timeout: 90_000 });
  await expect(byText(page, /At 320px: .*"BOOK A STUDIO" reaches \d+px/i)).toBeVisible();
  await shot(page, "53-admin-page-phone-check");
  const guest = await visitor(browser);
  expect((await guest.goto(path))?.status()).toBe(404);

  // Stacked on a phone, it fits, and is published.
  await canvas.locator(".blk-columns").click({ position: { x: 5, y: 5 } });
  await page.getByRole("combobox", { name: "On a phone" }).selectOption({ label: "One under the other" });
  await expect(canvas.locator(".blk-columns")).toHaveAttribute("data-phone", "stack");
  await expect(byText(page, /Draft saved at/)).toBeVisible();
  // While the check runs (held back here, as on a slow connection), the editor's undo key, which works on the whole
  // document, changes nothing: what is published is what was checked.
  await page.route(/\/admin\/website\/pages\/[^/]+\/check/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.fallback();
  });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(byText(page, "Checking the page at the width of a phone…")).toBeVisible();
  // Undo, and Delete and Backspace with the columns chosen: each would change the page in the editor's own hands.
  for (const key of ["ControlOrMeta+z", "Delete", "Backspace"]) await page.keyboard.press(key);
  await published(page);
  await expect(canvas.locator(".blk-columns")).toHaveCount(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect((await guest.goto(path))?.status()).toBe(200);
  await expect(guest.locator(".blk-columns")).toHaveAttribute("data-phone", "stack");
  await guest.context().close();
});

test("a header that would be wider than a phone is not published, whatever other drafts wait: each change is checked as it will be published", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  // The tenth owner's second sign-in code. A design with narrower headings first, left as a draft.
  await signIn(page, GUARD_OWNER, "/admin/website/design");
  await group(page, "Fonts").locator("summary").click();
  await byLabel(page, "Headings").selectOption({ label: "Bebas Neue" });
  await saved(page);

  // A logo that fits a phone in those narrow letters, and not in the design that is published.
  await page.goto("/admin/website/navigation");
  await group(page, "Logo").locator("summary").click();
  await byLabel(page, "Logo text").fill("The Visuals Atelier");
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const refused = byText(page, /^Not published: on a phone, the website with this header, menu and footer would be hard to use\./);
  await expect(refused).toBeVisible({ timeout: 90_000 });
  // Measured with the published design, on every page, and said once for all of them: the header is the same everywhere.
  await expect(refused).toContainText(/At 320px, on every page: "The Visuals Atelier[^"]*" reaches \d+px; "Menu" reaches \d+px\./);
  await shot(page, "53a-admin-header-phone-check");
  // Visitors still have the header as it was.
  const guest = await visitor(browser);
  await guest.goto("/");
  await expect(guest.locator(".site-nav .site-logo")).toHaveText(/^The Visuals\s*Photo Studio$/);
  await guest.context().close();

  // A page of the owners' at an address that starts like the booking screen's, with nothing on it: the check measures it
  // as any other page, and an empty page fits any phone.
  await page.goto("/admin/website/pages");
  await byLabel(page, "Name of a new page").fill("Book a Shoot");
  await page.getByRole("button", { name: "Make the page" }).click();
  const canvas = canvasOf(page);
  await expect(canvas.locator("h1")).toHaveText("Book a Shoot");
  for (const block of [canvas.locator("h1"), canvas.locator(".blk-text")]) {
    await block.click();
    await canvas.locator('button[title="Delete"]').click();
    await expect(block).toHaveCount(0);
  }
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);

  // The design is checked with the header as it is published, not with that draft, and on that page too: it is published.
  await page.goto("/admin/website/design");
  // On a slow connection the editor, drawn again after the publish, arrives late: a change made as soon as "Published"
  // shows is kept all the same, for the editor says so only once it has started again from what is stored.
  await page.route("**/admin/website/design**", async (route) => {
    if (route.request().method() === "GET" && route.request().headers()["rsc"] === "1") await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fallback();
  });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);

  // Back to the site as it was built, for the tests that follow: the design, then the header.
  await page.getByRole("button", { name: "Start again from the site as it was built" }).click();
  await saved(page);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto("/admin/website/navigation");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("button", { name: "Yes, discard them" }).click();
  await expect(byText(page, "The changes were discarded.")).toBeVisible();
});

// ── Reviews and logos (ideas taken from another studio's website) ──

/** A logo drawn as a picture: a coloured mark beside a bar, on white. */
async function logoFile(name: string, colour: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160" viewBox="0 0 480 160">
    <rect width="480" height="160" fill="#ffffff"/>
    <circle cx="80" cy="80" r="56" fill="${colour}"/>
    <rect x="160" y="60" width="280" height="40" rx="8" fill="${colour}"/>
  </svg>`;
  return { name, mimeType: "image/png", buffer: await sharp(Buffer.from(svg)).png().toBuffer() };
}

test("a page shows what clients wrote, with their stars, and the logos of brands the studio worked for", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  // The tenth owner's third sign-in code. Two logos first, each described by the brand's name.
  await signIn(page, GUARD_OWNER, "/admin/website/media");
  await expect(page.getByLabel("Add pictures", { exact: true })).toBeEnabled();
  await page.getByLabel("Add pictures", { exact: true }).setInputFiles([await logoFile("logo-north.png", "#1f3b5a"), await logoFile("logo-bloom.png", "#b0526e")]);
  await expect(onScreen(page.locator(".media-sent")).locator("li.added")).toHaveCount(2);
  for (const [file, words] of [
    ["logo-north.png", "Logo of North Apparel"],
    ["logo-bloom.png", "Logo of Bloom Beauty"],
  ]) {
    const card = onScreen(page.locator(".media-card")).filter({ hasText: file });
    await card.getByLabel("What the picture shows").fill(words);
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card).not.toContainText("Needs a description before it can be shown.");
  }

  await page.goto("/admin/website/pages");
  await byLabel(page, "Name of a new page").fill("Kind Words");
  await page.getByRole("button", { name: "Make the page" }).click();
  const canvas = canvasOf(page);
  await expect(canvas.locator("h1")).toHaveText("Kind Words");
  const path = /\/kind-words(-\d+)?/.exec(await page.locator(".page-editor-where").innerText())![0];
  await canvas.locator("h1").click();
  await expect(page.getByRole("textbox", { name: "Heading" })).toHaveValue("Kind Words");

  // A review block starts with no words, so nothing a client did not write can be published by mistake.
  await dragBlock(page, "Reviews", canvas.locator(".blk-text"));
  const reviewsNote = canvas.locator(".blk-note", { hasText: "Reviews: write the first one in the panel" });
  await expect(reviewsNote).toBeVisible();
  await reviewsNote.click();
  // The review in the panel's list, opened to write it. The editor keeps a copy of its panel out of sight: the one on screen is pressed.
  await onScreen(page.locator('[class*="ArrayFieldItem-summary"]', { hasText: "New" })).first().click();
  // One field at a time, each seen on the page before the next.
  await page.getByRole("textbox", { name: "What they wrote, in their words" }).fill("The light in Blanche is unreal. We shot a whole lookbook in three hours.");
  await expect(canvas.locator(".blk-review blockquote")).toHaveText("The light in Blanche is unreal. We shot a whole lookbook in three hours.");
  await page.getByRole("textbox", { name: "Their name, as they agreed to show it" }).fill("Ana R.");
  await expect(canvas.locator(".blk-review figcaption")).toHaveText("Ana R.");
  await page.getByRole("textbox", { name: "Where they wrote it (optional), such as Google" }).fill("Google");
  await expect(canvas.locator(".blk-review cite")).toHaveText("Google");
  await page.getByRole("combobox", { name: "Stars they gave" }).selectOption({ label: "5 of 5" });
  await expect(canvas.locator(".blk-review-stars")).toContainText("5 out of 5 stars");

  // The logos, from the library.
  await dragBlock(page, "Logos", canvas.locator(".blk-reviews"));
  const logosNote = canvas.locator(".blk-note", { hasText: "Logos: choose their pictures in the panel" });
  await expect(logosNote).toBeVisible();
  await logosNote.click();
  await page.getByRole("button", { name: "Add pictures" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose from the media library" });
  await chooser.getByRole("button", { name: /Logo of North Apparel/ }).click();
  await chooser.getByRole("button", { name: /Logo of Bloom Beauty/ }).click();
  await chooser.getByRole("button", { name: "Use these 2 pictures" }).click();
  await expect(canvas.locator(".blk-logos img")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Colours" }).selectOption({ label: "In grey" });
  await expect(canvas.locator(".blk-logos")).toHaveAttribute("data-look", "grey");
  await expect(byText(page, /Draft saved at/)).toBeVisible();
  // Publishing measures the page on a phone first: both blocks fit.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await published(page);

  const guest = await visitor(browser);
  expect((await guest.goto(path))?.status()).toBe(200);
  const review = guest.locator(".blk-review");
  await expect(review.locator("blockquote")).toHaveText("The light in Blanche is unreal. We shot a whole lookbook in three hours.");
  await expect(review.locator("figcaption")).toHaveText("Ana R., Google");
  await expect(review.locator(".blk-review-stars")).toHaveText("★★★★★5 out of 5 stars");
  const logos = guest.locator(".blk-logos img");
  await expect(logos).toHaveCount(2);
  await expect(logos.nth(0)).toHaveAttribute("alt", "Logo of North Apparel");
  await expect(logos.nth(1)).toHaveAttribute("alt", "Logo of Bloom Beauty");
  await drawn(logos.nth(0));
  expect(await accessibilityProblems(guest)).toEqual([]);
  await shot(guest, "53b-website-reviews-and-logos");
  await guest.context().close();
});
