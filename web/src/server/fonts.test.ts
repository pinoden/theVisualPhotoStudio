import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settings, siteFiles } from "@/db/schema";
import { DEFAULT_DESIGN, designCss, parseDesign } from "@/lib/site/design";
import { customFontFamily, customFontId, findFont, fontFaceCss, fontStack, weightsOf, type CustomFont } from "@/lib/site/fonts";
import type { AuthUser } from "./auth";
import { addFont, addFontFile, deleteFont, detectFontFormat, FONT_LIMITS, listFonts, loadCustomFonts, readFontFile, removeFontFile } from "./fonts";
import { createTestWorld, expectOk, NOW, type TestWorld } from "./testing";
import { DESIGN_DOC, discardDraft, loadDraftOrPublished, loadPublished, publishDraft, saveDraft } from "./website";

/**
 * The owner's requirement 21, the part about a font of their own: "upload
 * licensed font files". Horizon, the brand font, is such a font.
 */
let world: TestWorld;
let owner: AuthUser;
let mia: AuthUser;

// Two real font files that come with the framework, so that no font has to be kept with the tests.
const WOFF2 = new Uint8Array(readFileSync("node_modules/next/dist/next-devtools/server/font/geist-latin.woff2"));
const TTF = new Uint8Array(readFileSync("node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"));

beforeAll(async () => {
  world = await createTestWorld();
});
afterAll(() => world.close());
beforeEach(async () => {
  await world.reset();
  owner = await world.addUser("owner@studio.test", "owner", "Olivia");
  mia = await world.addUser("mia@studio.test", "manager", "Mia");
});

const HORIZON = { name: "Horizon", group: "display", licence: "Web licence from the maker, bought in 2025", holdsLicence: true };
const horizon = async () => expectOk(await addFont(world.db, owner, HORIZON, NOW)).id;
const file = (bytes: Uint8Array, weight = 400, extra: { weightMax?: number | null; italic?: boolean } = {}) => ({ bytes, weight, weightMax: extra.weightMax ?? null, italic: extra.italic ?? false });
const fileCount = async () => (await world.db.select({ key: siteFiles.key }).from(siteFiles)).length;

describe("a font file", () => {
  it("is known by how it begins, whatever it is called", () => {
    expect(detectFontFormat(WOFF2)).toBe("woff2");
    expect(detectFontFormat(TTF)).toBe("truetype");
    expect(detectFontFormat(new TextEncoder().encode("wOFFand the rest of a WOFF file"))).toBe("woff");
    expect(detectFontFormat(new TextEncoder().encode("OTTOand the rest of an OpenType file"))).toBe("opentype");
    expect(detectFontFormat(new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectFontFormat(new Uint8Array([0x77, 0x4f]))).toBeNull();
    expect(detectFontFormat(new Uint8Array(0))).toBeNull();
  });
});

describe("adding a font of one's own", () => {
  it("needs the owners' word, and their words, on the licence", async () => {
    expect(await addFont(world.db, owner, { ...HORIZON, holdsLicence: false }, NOW)).toMatchObject({ ok: false });
    expect(await addFont(world.db, owner, { ...HORIZON, licence: "  " }, NOW)).toMatchObject({ ok: false });
    const refused = await addFont(world.db, owner, { ...HORIZON, licence: "" }, NOW);
    expect(!refused.ok && refused.message).toContain("A font may only be on a website with a licence for that.");
    expect(await addFont(world.db, owner, { ...HORIZON, name: "" }, NOW)).toMatchObject({ ok: false, message: "Give the font its name." });
    expect(await addFont(world.db, owner, { ...HORIZON, group: "wingdings" }, NOW)).toMatchObject({ ok: false });
    expect(await listFonts(world.db, owner)).toEqual([]);

    await horizon();
    expect(await listFonts(world.db, owner)).toMatchObject([{ name: "Horizon", group: "display", licence: HORIZON.licence, uploadedBy: owner.email, weights: [], inUse: false }]);
  });

  it("cannot be chosen until it has a file", async () => {
    const id = await horizon();
    const fonts = await loadCustomFonts(world.db);
    expect(findFont(customFontId(id), fonts)).toBeNull();
    expect(parseDesign({ fonts: { heading: customFontId(id) } }, fonts).fonts.heading).toBe(DEFAULT_DESIGN.fonts.heading);
  });

  it("takes files that are fonts, one for each weight and style", async () => {
    const id = await horizon();
    expectOk(await addFontFile(world.db, owner, id, file(WOFF2, 400), NOW));
    expectOk(await addFontFile(world.db, owner, id, file(TTF, 700), NOW));
    expectOk(await addFontFile(world.db, owner, id, file(TTF, 400, { italic: true }), NOW));
    const [font] = await loadCustomFonts(world.db);
    expect(font).toMatchObject({ id: customFontId(id), name: "Horizon", group: "display", weights: [400, 700], family: customFontFamily(id) });
    expect(font.files.map((entry) => [entry.format, entry.weight, entry.italic])).toEqual([
      ["woff2", 400, false],
      ["truetype", 400, true],
      ["truetype", 700, false],
    ]);
    expect(font.files[0].url).toMatch(/^\/font-files\/[0-9a-f-]{36}\/uf-[0-9a-f]{12}-400\.woff2$/);
    expect(font.files[1].url).toMatch(/-400i\.ttf$/);

    // The bytes that come back are the bytes that went in.
    const stored = (await readFontFile(world.db, font.files[0].url.split("/")[2]))!;
    expect(stored.contentType).toBe("font/woff2");
    expect(Buffer.from(stored.bytes).equals(Buffer.from(WOFF2))).toBe(true);
    expect(await readFontFile(world.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await readFontFile(world.db, "../etc/passwd")).toBeNull();
  });

  it("puts a new file in the place of one for the same weight and style", async () => {
    const id = await horizon();
    expectOk(await addFontFile(world.db, owner, id, file(TTF, 400), NOW));
    expectOk(await addFontFile(world.db, owner, id, file(WOFF2, 400), NOW));
    const [font] = await loadCustomFonts(world.db);
    expect(font.files).toHaveLength(1);
    expect(font.files[0].format).toBe("woff2");
    expect(await fileCount()).toBe(1);
  });

  it("knows a variable font: one file for every weight in a range", async () => {
    const id = await horizon();
    expectOk(await addFontFile(world.db, owner, id, file(WOFF2, 300, { weightMax: 800 }), NOW));
    const [font] = await loadCustomFonts(world.db);
    expect(font.weights).toEqual([300, 400, 500, 600, 700, 800]);
    expect(fontFaceCss(font)).toContain("font-weight:300 800;");
    expect(weightsOf([{ weight: 400, weightMax: null }, { weight: 600, weightMax: 900 }])).toEqual([400, 600, 700, 800, 900]);
  });

  it("refuses what is not a font, a weight that is not one, and a file that is too large", async () => {
    const id = await horizon();
    const refused = async (input: ReturnType<typeof file>) => {
      const result = await addFontFile(world.db, owner, id, input, NOW);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.message;
    };
    expect(await refused(file(new TextEncoder().encode("<svg onload=alert(1)>not a font</svg>")))).toContain("That is not a font file.");
    expect(await refused(file(new Uint8Array(0)))).toBe("Choose a font file.");
    expect(await refused(file(WOFF2, 450))).toContain("Choose the weight");
    expect(await refused(file(WOFF2, 1000))).toContain("Choose the weight");
    expect(await refused(file(WOFF2, 700, { weightMax: 400 }))).toContain("Choose the weight");
    const huge = new Uint8Array(FONT_LIMITS.fileBytes + 1);
    huge.set(WOFF2.slice(0, 16));
    expect(await refused(file(huge))).toContain("too large for a font");
    expect(await fileCount()).toBe(0);
    expect(await addFontFile(world.db, owner, "00000000-0000-4000-8000-000000000000", file(WOFF2), NOW)).toMatchObject({ ok: false, message: "That font was not found." });
  });

  it("is for whoever may change the design", async () => {
    const id = await horizon();
    expect(await listFonts(world.db, mia)).toBeNull();
    expect(await addFont(world.db, mia, HORIZON, NOW)).toMatchObject({ ok: false });
    expect(await addFontFile(world.db, mia, id, file(WOFF2), NOW)).toMatchObject({ ok: false });
    expect(await deleteFont(world.db, mia, id)).toMatchObject({ ok: false });
    await world.db.insert(settings).values({ key: "managerEditsDesign", value: true });
    expect(await addFontFile(world.db, mia, id, file(WOFF2), NOW)).toMatchObject({ ok: true });
  });
});

describe("the design with a font of the owners' own", () => {
  let id: string;
  let fonts: CustomFont[];
  beforeEach(async () => {
    id = await horizon();
    expectOk(await addFontFile(world.db, owner, id, file(WOFF2, 400), NOW));
    expectOk(await addFontFile(world.db, owner, id, file(TTF, 700), NOW));
    fonts = await loadCustomFonts(world.db);
  });
  const withHorizon = () => ({ ...DEFAULT_DESIGN, fonts: { ...DEFAULT_DESIGN.fonts, heading: customFontId(id) } });

  it("can name it like a font of the library, with its own weights", async () => {
    const design = parseDesign({ ...withHorizon(), headings: { h1: { weight: 300 }, h2: { weight: 900 } } }, fonts);
    expect(design.fonts.heading).toBe(customFontId(id));
    expect(design.headings.h1.weight).toBe(400);
    expect(design.headings.h2.weight).toBe(700);
    expect(fontStack(findFont(design.fonts.heading, fonts)!)).toBe(`'${customFontFamily(id)}', system-ui, -apple-system, 'Segoe UI', Arial, sans-serif`);
    // Someone who does not know the owners' fonts reads the same design with the default font in its place.
    expect(parseDesign(withHorizon()).fonts.heading).toBe(DEFAULT_DESIGN.fonts.heading);
  });

  it("tells a browser where the files are, for the fonts it uses and no others", async () => {
    const other = expectOk(await addFont(world.db, owner, { ...HORIZON, name: "Unused" }, NOW)).id;
    expectOk(await addFontFile(world.db, owner, other, file(WOFF2, 400), NOW));
    const all = await loadCustomFonts(world.db);
    const css = designCss(parseDesign(withHorizon(), all), all);
    const family = customFontFamily(id);
    expect(css).toContain(`@font-face{font-family:'${family}';src:url(/font-files/`);
    expect(css).toContain("format('woff2');font-weight:400;font-style:normal;font-display:swap}");
    expect(css).toContain("format('truetype');font-weight:700;");
    expect(css).toContain(`--font-heading:'${family}', `);
    expect(css).not.toContain(customFontFamily(other));
    expect(designCss(DEFAULT_DESIGN, all)).not.toContain("@font-face");
  });

  it("lets nothing a person typed into the stylesheet: the name the browser gets is made from the font's id", async () => {
    const evil = expectOk(await addFont(world.db, owner, { ...HORIZON, name: "x';}</style><script>alert(1)</script>" }, NOW)).id;
    expectOk(await addFontFile(world.db, owner, evil, file(WOFF2, 400), NOW));
    const all = await loadCustomFonts(world.db);
    const css = designCss(parseDesign({ fonts: { heading: customFontId(evil) } }, all), all);
    expect(css).not.toContain("script");
    expect(css).not.toContain("<");
    expect(css).toContain(customFontFamily(evil));
    // A file address that is not one of this site's font files is left out altogether.
    const forged: CustomFont = { ...all[0], files: [{ url: "https://evil.example/x.woff2);} body{display:none", format: "woff2", weight: 400, weightMax: null, italic: false }] };
    expect(fontFaceCss(forged)).toBe("");
  });

  it("is stored, published and read back with the font in place", async () => {
    expectOk(await saveDraft(world.db, owner, DESIGN_DOC, withHorizon(), { basedOn: 0, now: NOW }));
    expect((await loadDraftOrPublished(world.db, DESIGN_DOC)).fonts.heading).toBe(customFontId(id));
    expect((await loadPublished(world.db, DESIGN_DOC)).fonts.heading).toBe(DEFAULT_DESIGN.fonts.heading);
    expectOk(await publishDraft(world.db, owner, DESIGN_DOC, NOW));
    expect((await loadPublished(world.db, DESIGN_DOC)).fonts.heading).toBe(customFontId(id));
    expect((await listFonts(world.db, owner))![0].inUse).toBe(true);
  });

  it("keeps a font the design uses, in a draft too: it cannot be deleted, nor lose its last file", async () => {
    expectOk(await saveDraft(world.db, owner, DESIGN_DOC, withHorizon(), { basedOn: 0, now: NOW }));
    const refused = await deleteFont(world.db, owner, id);
    expect(!refused.ok && refused.message).toBe("The design uses Horizon, in what is published or in a draft. Choose another font there first.");
    const [first, second] = (await listFonts(world.db, owner))![0].fileList;
    expect(await removeFontFile(world.db, owner, first.id)).toMatchObject({ ok: true });
    const last = await removeFontFile(world.db, owner, second.id);
    expect(!last.ok && last.message).toContain("the font's only file and the design uses the font");

    expectOk(await discardDraft(world.db, owner, DESIGN_DOC));
    expect(await deleteFont(world.db, owner, id)).toMatchObject({ ok: true });
    expect(await loadCustomFonts(world.db)).toEqual([]);
    expect(await fileCount()).toBe(0);
  });
});
