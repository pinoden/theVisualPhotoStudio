import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, DEFAULT_DESIGN, designCss, designVariables, fontNotes, parseColor, parseDesign, readabilityChecks, type Design } from "./design";
import { findFont, FONT_LIBRARY, fontStack, fontVariable, nearestWeight } from "./fonts";

/** The owner's requirement 21: global design and fonts, saved as global styles. */

const clone = (design: Design): Design => JSON.parse(JSON.stringify(design));

describe("the design the site was built with", () => {
  it("is what the stylesheet holds by itself, so a site whose design was never touched looks the same", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const block = /:root\s*\{([^}]*)\}/.exec(css)![1].replace(/\/\*[\s\S]*?\*\//g, "");
    const inFile = Object.fromEntries(
      block
        .split(";")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
    const { all, phone } = designVariables(DEFAULT_DESIGN);
    expect(inFile).toEqual(all);
    expect(phone).toEqual({});
  });

  it("is a valid design, and reading it changes nothing", () => {
    expect(parseDesign(DEFAULT_DESIGN)).toEqual(DEFAULT_DESIGN);
    expect(parseDesign(undefined)).toEqual(DEFAULT_DESIGN);
    expect(parseDesign("nonsense")).toEqual(DEFAULT_DESIGN);
    expect(parseDesign({ colors: 7, fonts: [], headings: null, body: "x", buttons: 1, spacing: false })).toEqual(DEFAULT_DESIGN);
  });
});

describe("reading a design that was stored or sent", () => {
  it("keeps what is valid and takes the default for the rest", () => {
    const design = parseDesign({
      colors: { accent: "#AB12CD", background: "#fff", text: "red", heading: "#12345", border: 5 },
      fonts: { heading: "bebas-neue", body: "comic-sans" },
      buttons: { radius: 12, uppercase: false, padX: "wide" },
    });
    expect(design.colors.accent).toBe("#ab12cd");
    expect(design.colors.background).toBe("#ffffff");
    expect(design.colors.text).toBe(DEFAULT_DESIGN.colors.text);
    expect(design.colors.heading).toBe(DEFAULT_DESIGN.colors.heading);
    expect(design.colors.border).toBe(DEFAULT_DESIGN.colors.border);
    expect(design.fonts).toEqual({ ...DEFAULT_DESIGN.fonts, heading: "bebas-neue" });
    expect(design.buttons).toEqual({ ...DEFAULT_DESIGN.buttons, radius: 12, uppercase: false });
  });

  it("keeps every number inside its range and on its step", () => {
    const design = parseDesign({
      headings: { h1: { scale: 500, scaleMobile: 1, letterSpacing: 0.123, lineHeight: 1.234 } },
      body: { size: 3, sizeMobile: 17.4, lineHeight: 99, letterSpacing: Number.NaN },
      buttons: { size: 15.5, radius: -3, padY: 1000, letterSpacing: Infinity },
      spacing: { section: 81, sectionMobile: 20 },
    });
    expect(design.headings.h1).toMatchObject({ scale: 160, scaleMobile: 70, letterSpacing: 0.12, lineHeight: 1.25 });
    expect(design.body).toMatchObject({ size: 14, sizeMobile: 17, lineHeight: 2.2, letterSpacing: 0 });
    expect(design.buttons).toMatchObject({ size: 16, radius: 0, padY: 22, letterSpacing: DEFAULT_DESIGN.buttons.letterSpacing });
    expect(design.spacing).toEqual({ section: 80, sectionMobile: 32 });
  });

  it("moves a weight the chosen font does not come in to the nearest one it has", () => {
    // Bebas Neue comes in one weight; Lato in 300, 400 and 700.
    const design = parseDesign({
      fonts: { heading: "bebas-neue", subheading: "lato", body: "lato", button: "poppins" },
      headings: { h1: { weight: 300 }, h2: { weight: 900 }, h3: { weight: 500 } },
      body: { weight: 600 },
      buttons: { weight: 900 },
    });
    expect(design.headings.h1.weight).toBe(400);
    expect(design.headings.h2.weight).toBe(400);
    expect(design.headings.h3.weight).toBe(400);
    expect(design.body.weight).toBe(700);
    expect(design.buttons.weight).toBe(600);
    expect(nearestWeight(findFont("lato")!, 550)).toBe(400);
    expect(nearestWeight(findFont("montserrat")!, 0)).toBe(100);
  });

  it("reads a colour written in six or three digits, and nothing else", () => {
    expect(parseColor(" #C8A882 ")).toBe("#c8a882");
    expect(parseColor("#fa0")).toBe("#ffaa00");
    for (const bad of ["c8a882", "#c8a88", "#c8a8822", "rgb(1,2,3)", "red", "", null, 12, "#gggggg", "#fff;}body{display:none"]) {
      expect(parseColor(bad), String(bad)).toBeNull();
    }
  });
});

describe("the design as CSS", () => {
  it("writes each value under the name the stylesheet reads", () => {
    const design = clone(DEFAULT_DESIGN);
    design.colors.accent = "#112233";
    design.fonts.heading = "bebas-neue";
    design.headings.h1 = { ...design.headings.h1, scale: 120, weight: 400, letterSpacing: 0.05, uppercase: true };
    design.buttons = { ...design.buttons, radius: 24, padY: 10, padX: 20, uppercase: false, size: 16 };
    const css = designCss(parseDesign(design));
    expect(css).toContain("--color-rose:#112233;");
    expect(css).toContain(`--font-heading:var(--font-bebas-neue), ${fontStack(findFont("bebas-neue")!).split(", ").slice(1).join(", ")};`);
    expect(css).toContain("--h1-scale:1.2;--h1-weight:400;--h1-spacing:.05em;--h1-line:1.2;--h1-transform:uppercase;");
    expect(css).toContain("--btn-size:1rem;");
    expect(css).toContain("--btn-transform:none;--btn-radius:24px;--btn-pad:.625rem 1.25rem;");
    // Stronger than the stylesheet's own ":root", wherever the browser places the two.
    expect(css.startsWith("html:root{")).toBe(true);
  });

  it("gives a phone its own values only where they differ", () => {
    expect(designCss(DEFAULT_DESIGN)).not.toContain("@media");
    const design = clone(DEFAULT_DESIGN);
    design.headings.h1.scaleMobile = 80;
    design.body.sizeMobile = 18;
    design.spacing.sectionMobile = 48;
    expect(designCss(design)).toContain("@media (max-width:640px){html:root{--h1-scale:0.8;--body-size:1.125rem;--section-pad:3rem}}");
  });

  it("lets nothing but colours, numbers and the library's fonts into the stylesheet", () => {
    const attack = "red;}</style><script>alert(1)</script><style>body{background:url(javascript:alert(1))";
    const hostile = {
      colors: Object.fromEntries(Object.keys(DEFAULT_DESIGN.colors).map((key) => [key, attack])),
      fonts: { heading: attack, subheading: attack, body: attack, button: attack },
      headings: { h1: { scale: attack, weight: attack, uppercase: attack }, h2: attack, h3: [attack] },
      body: { size: attack, weight: attack },
      buttons: { radius: attack, uppercase: attack },
      spacing: { section: attack },
      [attack]: attack,
    };
    expect(parseDesign(hostile)).toEqual(DEFAULT_DESIGN);
    const css = designCss(parseDesign(hostile));
    expect(css).toBe(designCss(DEFAULT_DESIGN));
    expect(css).toMatch(/^html:root\{(--[a-z0-9-]+:[#a-zA-Z0-9 .,'()-]+;?)+\}$/);
  });
});

describe("whether a design can be read", () => {
  it("measures contrast as the accessibility guidelines do", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5); // the well-known lightest grey that passes on white
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("says which text stands out enough, and which does not", () => {
    const checks = readabilityChecks(DEFAULT_DESIGN);
    const of = (start: string) => checks.find((check) => check.what.startsWith(start))!;
    expect(of("Running text on the page").ok).toBe(true);
    expect(of("Headings on the page").ok).toBe(true);
    // The site as built: white words on the tan accent are hard to read. The editor says so; it does not refuse.
    expect(of("Words on a button in the accent colour")).toMatchObject({ ok: false, needed: 4.5 });
    expect(of("Words on a button in the accent colour").ratio).toBeLessThan(3);
    const fixed = clone(DEFAULT_DESIGN);
    fixed.colors.onAccent = "#2c2420";
    expect(readabilityChecks(fixed).find((check) => check.what.startsWith("Words on a button"))!.ok).toBe(true);
  });

  it("points out a font that makes running text hard to read", () => {
    expect(fontNotes(DEFAULT_DESIGN)).toEqual([]);
    expect(fontNotes(parseDesign({ fonts: { body: "bebas-neue" } }))[0]).toContain("Bebas Neue has capital letters only");
    expect(fontNotes(parseDesign({ fonts: { body: "great-vibes" } }))[0]).toContain("handwriting");
    // The same font as a heading is what it is for.
    expect(fontNotes(parseDesign({ fonts: { heading: "bebas-neue" } }))).toEqual([]);
  });
});

describe("the font library", () => {
  it("has the owner's brand font that is free to use, Bebas Neue", () => {
    expect(findFont("bebas-neue")).toMatchObject({ name: "Bebas Neue", group: "display" });
    expect(findFont("horizon")).toBeNull(); // needs the owner's licensed files
    expect(findFont(undefined)).toBeNull();
  });

  it("declares every one of its fonts for the browser, and nothing else", () => {
    const declared = [...readFileSync("src/app/fonts.ts", "utf8").matchAll(/variable: "(--font-[a-z0-9-]+)"/g)].map((match) => match[1]);
    expect([...declared].sort()).toEqual(FONT_LIBRARY.map(fontVariable).sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(new Set(FONT_LIBRARY.map((font) => font.id)).size).toBe(FONT_LIBRARY.length);
  });

  it("gives every font at least one weight, lightest first", () => {
    for (const font of FONT_LIBRARY) {
      expect(font.weights.length, font.name).toBeGreaterThan(0);
      expect([...font.weights].sort((a, b) => a - b), font.name).toEqual(font.weights);
    }
  });
});
