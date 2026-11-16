import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { byLabel, byText, onScreen, shot, signIn } from "./helpers";

/**
 * The website's editor (the owner's requirements 21, 25, 26 and 27, and the
 * website part of 28): the design and the header, menu and footer are changed
 * as a draft, previewed, published, and brought back from the history; and
 * the media library takes pictures and fonts.
 *
 * Runs after site.spec.ts and before z-mobile.spec.ts, on the same database.
 * It ends with the design, the menu and the footer as the site was built, so
 * the phone tests that follow measure the site's own design. The two photos
 * it gives Studio Blanche stay, so those tests also measure pages with photos.
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
  await expect(byText(page, "Published. Visitors see it now.")).toBeVisible();
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
  await expect(byText(page, "Published. Visitors see it now.")).toBeVisible();
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
