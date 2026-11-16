import { describe, expect, it } from "vitest";
import { paragraphs, plainText, RICH_TEXT_MAX, sanitizeRichText } from "./rich-text";

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
