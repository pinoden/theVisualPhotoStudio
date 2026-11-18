import { describe, expect, it, vi } from "vitest";
import { paragraphs, plainText, RICH_TEXT_MAX, sanitizeRichText, showRichText } from "./rich-text";

/** Formatted text from the page editor: "never raw HTML" (the owner's requirement 23). */
describe("formatted text", () => {
  it("keeps what the editor offers", () => {
    const html =
      '<h2 style="text-align: center">Our decor</h2><p>A <strong>bright</strong>, <em>modern</em> and <u>calm</u> space.<br>Come and see.</p>' +
      '<ul><li><p>White walls</p></li><li><p>Tall windows</p></li></ul><ol><li><p>Book</p></li></ol><blockquote><p>Lovely.</p></blockquote>' +
      '<h3>Details</h3><h4>More</h4><p style="text-align: right">Right</p>';
    // Exactly as the editor wrote it: text that was not changed is not changed by being saved.
    expect(sanitizeRichText(html)).toBe(html);
  });

  it("keeps a link to a page of this site, and marks a link that leaves the site", () => {
    expect(sanitizeRichText('<p><a href="/rates">Rates</a> and <a href="/studios#paris" target="_top" onclick="x()">Paris</a></p>')).toBe(
      '<p><a href="/rates">Rates</a> and <a href="/studios#paris">Paris</a></p>',
    );
    expect(sanitizeRichText('<a href="https://instagram.com/thevisuals">Instagram</a>')).toBe(
      '<a href="https://instagram.com/thevisuals" target="_blank" rel="noopener noreferrer">Instagram</a>',
    );
    expect(sanitizeRichText('<a href="mailto:hello@example.com">Write</a> <a href="tel:+14076636109">Call</a>')).toContain('href="tel:+14076636109"');
  });

  it("turns a link that is not a link into its words", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "//evil.example", "vbscript:x", " java\tscript:alert(1)", ""]) {
      const out = sanitizeRichText(`<p><a href="${href}">Click me</a></p>`);
      expect(out, href).toBe("<p>Click me</p>");
    }
  });

  it("drops everything that could run or load something", () => {
    const attacks = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      '<svg onload="alert(1)"><circle /></svg>',
      '<iframe src="https://evil.example"></iframe>',
      '<p onclick="alert(1)" style="background:url(javascript:alert(1));text-align:center">Hi</p>',
      '<style>body{display:none}</style><link rel="stylesheet" href="https://evil.example/x.css">',
      '<form action="https://evil.example"><input name="card"><button>Pay</button></form>',
      '<object data="x"></object><embed src="x">',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<a href="/rates" style="position:fixed;inset:0">cover</a>',
      "<p>ok</p><!-- a comment --><template><script>alert(1)</script></template>",
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>',
    ];
    for (const attack of attacks) {
      const out = sanitizeRichText(attack);
      expect(out, attack).not.toMatch(/<script|<img|<svg|<iframe|<style|<link|<form|<input|<button|<object|<embed|<math|<template|<noscript|onerror|onclick|onload|javascript:|position:|background|<!--/i);
    }
    expect(sanitizeRichText(attacks[4])).toBe('<p style="text-align: center">Hi</p>');
    expect(sanitizeRichText(attacks[9])).toBe('<a href="/rates">cover</a>');
  });

  it("keeps words written with signs that mean something in HTML as words", () => {
    expect(sanitizeRichText("<p>Tom &amp; Jerry &lt;3 a &gt; b</p>")).toBe("<p>Tom &amp; Jerry &lt;3 a &gt; b</p>");
    expect(sanitizeRichText("2 < 3 and <b>bold")).toBe("2 &lt; 3 and <strong>bold</strong>");
  });

  it("keeps no style but an alignment, written anew, whatever the style held", () => {
    expect(sanitizeRichText('<p style="color:red;TEXT-ALIGN : Right ; font-size:90px">x</p>')).toBe('<p style="text-align: right">x</p>');
    expect(sanitizeRichText('<h1 style="text-align:center;position:fixed">T</h1><h6 style="position:fixed">S</h6>')).toBe('<h2 style="text-align: center">T</h2><h4>S</h4>');
    expect(sanitizeRichText('<p style="text-align: justify">x</p><p style="text-align:center&quot;onclick=&quot;x">y</p>')).toBe("<p>x</p><p>y</p>");
    expect(sanitizeRichText('<li style="text-align:center">x</li><strong style="text-align:center">y</strong>')).toBe("<li>x</li><strong>y</strong>");
  });

  it("never draws a random number, which Next.js refuses while it prerenders a page", () => {
    const random = vi.spyOn(Math, "random");
    sanitizeRichText('<p style="text-align: center">A</p><h2 style="text-align:right">B</h2>');
    showRichText('<p style="text-align: center">{if pets}A</p>', { pets: true });
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it("demotes headings that belong to the page, not to its text", () => {
    expect(sanitizeRichText("<h1>Title</h1><h5>Small</h5><h6>Smaller</h6>")).toBe("<h2>Title</h2><h4>Small</h4><h4>Smaller</h4>");
  });

  it("is the same after being cleaned twice", () => {
    const once = sanitizeRichText('<p style="text-align: center">A <b>b</b> <a href="https://example.org">c</a></p><ul><li>d</li></ul>');
    expect(sanitizeRichText(once)).toBe(once);
  });

  it("takes only text, and only so much of it", () => {
    for (const not of [undefined, null, 7, {}, ["<p>x</p>"]]) expect(sanitizeRichText(not)).toBe("");
    expect(sanitizeRichText(`<p>${"x".repeat(RICH_TEXT_MAX * 2)}</p>`).length).toBeLessThanOrEqual(RICH_TEXT_MAX + 10);
  });

  it("makes paragraphs from plain lines, and plain words from formatted text", () => {
    expect(paragraphs("Tom & Jerry <3", "Second line")).toBe("<p>Tom &amp; Jerry &lt;3</p><p>Second line</p>");
    expect(plainText('<h2>Our decor</h2><p>A <strong>bright</strong> space &amp; more.</p><ul><li>One</li></ul>')).toBe("Our decorA bright space & more.One");
  });
});

/** Pieces of formatted text that show only at times (src/lib/site/conditions.ts). */
describe("formatted text as a visitor gets it", () => {
  const list = "<ul><li>{if pets}Pets are welcome.</li><li>{if not pets}Pets are not permitted.</li><li>Children are welcome.</li></ul>";

  it("leaves out a list item whose condition does not hold, and never shows a marker", () => {
    expect(showRichText(list, { pets: true })).toBe("<ul><li>Pets are welcome.</li><li>Children are welcome.</li></ul>");
    expect(showRichText(list, { pets: false })).toBe("<ul><li>Pets are not permitted.</li><li>Children are welcome.</li></ul>");
  });

  it("does the same for paragraphs, headings and quotes, and leaves the rest alone", () => {
    const html = '<h2>{if moving}Moving</h2><p style="text-align: center">{if moving}Move it once.</p><blockquote><p>{if not moving}It stays.</p></blockquote><p>Always.</p>';
    expect(showRichText(html, { moving: false })).toBe("<blockquote><p>It stays.</p></blockquote><p>Always.</p>");
    expect(showRichText(html, { moving: true })).toBe('<h2>Moving</h2><p style="text-align: center">Move it once.</p><p>Always.</p>');
  });

  it("leaves out a list or a quote when nothing in it is left", () => {
    expect(showRichText("<p>Pets:</p><ul><li>{if pets}Dogs.</li><li>{if pets}Cats.</li></ul><p>End.</p>", { pets: false })).toBe("<p>Pets:</p><p>End.</p>");
    expect(showRichText("<ol><li>{if pets}Dogs.</li></ol>", { pets: true })).toBe("<ol><li>Dogs.</li></ol>");
  });

  it("leaves out a piece unless every one of its markers holds", () => {
    const html = "<ul><li>{if pets}{if pet free studios}Pets in Dayglow only.</li><li>{if pets}{if not pet free studios}Pets everywhere.</li></ul>";
    expect(showRichText(html, { pets: true, "pet free studios": true })).toBe("<ul><li>Pets in Dayglow only.</li></ul>");
    expect(showRichText(html, { pets: true, "pet free studios": false })).toBe("<ul><li>Pets everywhere.</li></ul>");
    expect(showRichText(html, { pets: false, "pet free studios": true })).toBe("");
  });

  it("reads a marker made bold or turned into a link like any other", () => {
    expect(showRichText("<p><strong>{if pets}</strong>Bring your dog.</p><p>Rest.</p>", { pets: false })).toBe("<p>Rest.</p>");
    expect(showRichText('<p><a href="/rates">{if pets}Pet fee</a></p>', { pets: true })).toBe('<p><a href="/rates">Pet fee</a></p>');
  });

  it("shows a marker that names no condition, or stands inside a sentence, as it was typed", () => {
    for (const html of ["<p>{if unicorns}Hello</p>", "<p>Hello {if pets} there</p>", "<p>{If pets}Hello</p>"]) {
      expect(showRichText(html, { pets: false }), html).toBe(html);
    }
  });

  it("is cleaned first, whatever it holds", () => {
    expect(showRichText('<p onclick="x()">{if pets}<script>bad()</script>Hi</p><img src=x onerror=alert(1)>', { pets: true })).toBe("<p>Hi</p>");
  });

  it("shows everything, without markers, when what holds is not known", () => {
    expect(showRichText(list, undefined)).toBe("<ul><li>Pets are welcome.</li><li>Pets are not permitted.</li><li>Children are welcome.</li></ul>");
  });

  it("is the cleaned text itself when it has no marker", () => {
    const html = '<p style="text-align: center">A <strong>b</strong><br>c <a href="https://example.org">d</a></p>';
    expect(showRichText(html, { pets: false })).toBe(sanitizeRichText(html));
  });
});
