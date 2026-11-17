// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { broughtBy, pageDrawn, pagesListed, partStillComing } from "./phone-check";

/** A page as the server sends it, in the test's document: its window is the one that styles it. */
function page(main: string, header = `<nav class="site-nav" style="position: fixed"></nav>`): Document {
  document.body.innerHTML = `${header}<main>${main}</main>`;
  return document;
}

const drawn = (doc: Document) => pageDrawn(doc, window);

describe("the phone check's wait for a page", () => {
  it("waits while a part the server streams is on its way, or has arrived and waits to be shown", () => {
    expect(partStillComing(page(`<!--$?--><template id="B:0"></template><p>Loading</p><!--/$-->`))).toBe(true);
    expect(partStillComing(page(`<!--$~--><p>Here</p><!--/$-->`))).toBe(true);
    expect(partStillComing(page(`<!--$--><p>Here</p><!--/$-->`))).toBe(false);
    expect(drawn(page(`<!--$?--><template id="B:0"></template><!--/$-->`))).toBe(false);
  });

  it("counts a page with nothing on it as drawn: an empty page fits any phone", () => {
    expect(drawn(page(`<div class="blk-root"></div>`))).toBe(true);
    expect(drawn(page(``))).toBe(true);
  });

  it("waits for the site's stylesheet, which fixes the header", () => {
    expect(drawn(page(`<p>Text</p>`, `<nav class="site-nav"></nav>`))).toBe(false);
    expect(drawn(page(`<p>Text</p>`, ``))).toBe(false);
  });
});

describe("the pages a problem is found on", () => {
  it("are named, a few at a time", () => {
    expect(pagesListed(["the home page"], 10)).toBe("the home page");
    expect(pagesListed(["the home page", "/rates"], 10)).toBe("the home page and /rates");
    expect(pagesListed(["/a", "/b", "/c", "/d"], 10)).toBe("/a, /b, /c and /d");
    expect(pagesListed(["/a", "/b", "/c", "/d", "/e", "/f"], 10)).toBe("/a, /b, /c and 3 other pages");
  });

  it("are every page when the problem is on all of them, as a header's is", () => {
    expect(pagesListed(["/a", "/b", "/c", "/d", "/e"], 5)).toBe("every page");
    // At the wider width only two pages are checked: they are named.
    expect(pagesListed(["the home page", "the booking page"], 2)).toBe("the home page and the booking page");
  });
});

describe("what a change brings to a page that did not fit a phone before it", () => {
  const before = ['"BOOK A STUDIO" reaches 336px', "the page scrolls sideways (336px wide on a 320px screen)"];

  it("is nothing when the page has the same problems, moved or reworded, and is no wider", () => {
    // Capitals switched off: the same button, narrower.
    const after = ['"Book a Studio" reaches 330px', "the page scrolls sideways (330px wide on a 320px screen)"];
    expect(broughtBy(after, before)).toEqual({ brought: [], had: before });
  });

  it("is all of it when the page is wider than it was", () => {
    const after = ['"BOOK A STUDIO" reaches 509px', "the page scrolls sideways (509px wide on a 320px screen)"];
    expect(broughtBy(after, before)).toEqual({ brought: after, had: [] });
  });

  it("is all of it when it brings a kind of problem the page did not have", () => {
    const after = [...before, '"Send" is 30px tall'];
    expect(broughtBy(after, before).brought).toEqual(after);
  });

  it("is all of it on a page that was fine, and nothing on a page that still is", () => {
    expect(broughtBy(before, [])).toEqual({ brought: before, had: [] });
    expect(broughtBy([], before)).toEqual({ brought: [], had: [] });
  });
});
