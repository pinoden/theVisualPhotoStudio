// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { pageDrawn, pagesListed, partStillComing } from "./phone-check";

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
