import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { FONT_FORMATS, fontFaceCss, fontStack } from "@/lib/site/fonts";
import { count } from "@/lib/words";
import { FONT_LIMITS, listFonts } from "@/server/fonts";
import { requireManager } from "@/server/session";
import { loadSettings } from "@/server/settings";
import { AdminFrame, AdminLoading } from "../../frame";
import { WebsiteTabs } from "../tabs";
import { addFontAction, deleteFontAction, removeFontFileAction } from "./actions";

export const metadata: Metadata = { title: "Your fonts", robots: { index: false } };

export default function FontsPage(props: PageProps<"/admin/website/fonts">) {
  return (
    <Suspense fallback={<AdminLoading />}>
      <Fonts searchParams={props.searchParams} />
    </Suspense>
  );
}

const KINDS = [
  { value: "display", label: "Display: strong shapes, for headings" },
  { value: "serif", label: "Serif: classic, with small strokes at the ends of the letters" },
  { value: "sans", label: "Sans serif: plain and modern" },
  { value: "script", label: "Script: handwriting" },
] as const;

const WEIGHTS = [
  [100, "Thin"],
  [200, "Extra light"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semi-bold"],
  [700, "Bold"],
  [800, "Extra bold"],
  [900, "Black"],
] as const;
const weightName = (weight: number) => `${WEIGHTS.find(([value]) => value === weight)?.[1] ?? weight} (${weight})`;

/**
 * Fonts of the owners' own, such as a brand font that no library has. For an
 * owner, or a manager who may change the design. Anyone else gets "not found".
 */
async function Fonts({ searchParams }: Pick<PageProps<"/admin/website/fonts">, "searchParams">) {
  await connection();
  const viewer = await requireManager("/admin/website/fonts");
  const db = await getDb();
  const [fonts, settings] = await Promise.all([listFonts(db, viewer), loadSettings(db)]);
  if (!fonts) notFound();

  return (
    <AdminFrame active="/admin/website" title="Your fonts" query={await searchParams} viewer={viewer} settings={settings}>
      <WebsiteTabs active="/admin/website/fonts" viewer={viewer} />
      {/* So that each font below can be shown in itself. Made from the fonts' ids and file ids only. */}
      <style>{fonts.map(fontFaceCss).join("")}</style>

      <div className="admin-card">
        <p style={{ margin: 0, fontSize: ".9rem" }}>
          The design chooses from a library of fonts that are free to use. A font of your own, such as a brand font,
          is added here as files and can then be chosen in the design like any other. A font may only be on a website
          with a licence that covers a website: a licence for print or for one computer does not.
        </p>
      </div>

      {fonts.map((font) => (
        <section className="admin-card" key={font.key} aria-labelledby={`font-${font.key}`}>
          <h3 id={`font-${font.key}`}>{font.name}</h3>
          {font.weights.length > 0 ? (
            <p className="editor-sample" style={{ fontFamily: fontStack(font), margin: "0 0 .75rem" }}>
              The Visuals Photo Studio 0123456789
            </p>
          ) : (
            <p className="media-needs">It has no file yet, so the design cannot use it. Add one below.</p>
          )}
          <p className="media-facts">
            Licence, in your words: {font.licence} · Added by {font.uploadedBy}
            {font.inUse && " · The design uses this font."}
          </p>

          {font.fileList.length > 0 && (
            <div className="data-table-wrap">
            <table className="data-table" style={{ margin: "1rem 0" }}>
              <thead>
                <tr>
                  <th>Weight</th>
                  <th>Style</th>
                  <th>File</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {font.fileList.map((file) => (
                  <tr key={file.id}>
                    <td>{file.weightMax === null ? weightName(file.weight) : `Every weight from ${file.weight} to ${file.weightMax}`}</td>
                    <td>{file.italic ? "Italic" : "Upright"}</td>
                    <td>
                      {FONT_FORMATS[file.format]}, {Math.max(1, Math.round(file.size / 1024))} KB
                    </td>
                    <td>
                      <form action={removeFontFileAction}>
                        <input type="hidden" name="fileId" value={file.id} />
                        <button type="submit" className="btn btn-outline btn-small">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          {/* A plain form with a file: it posts to the upload address, which sends the browser back here. */}
          <form action="/admin/website/fonts/upload" method="post" encType="multipart/form-data" className="admin-form-row">
            <input type="hidden" name="fontId" value={font.key} />
            <div className="form-group" style={{ flex: "2 1 14rem" }}>
              <label className="form-label" htmlFor={`file-${font.key}`}>
                Add a file of {font.name}
              </label>
              <input id={`file-${font.key}`} name="file" type="file" className="form-control" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`weight-${font.key}`}>
                Weight it holds
              </label>
              <select id={`weight-${font.key}`} name="weight" className="form-control" defaultValue="400">
                {WEIGHTS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name} ({value})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor={`max-${font.key}`}>
                A variable font? Its heaviest weight
              </label>
              <select id={`max-${font.key}`} name="weightMax" className="form-control" defaultValue="">
                <option value="">Not a variable font</option>
                {WEIGHTS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name} ({value})
                  </option>
                ))}
              </select>
            </div>
            <label style={{ fontSize: ".9rem", alignSelf: "center" }}>
              <input type="checkbox" name="italic" /> Italic
            </label>
            <button type="submit" className="btn btn-dark btn-small">
              Add the file
            </button>
          </form>
          <p className="editor-hint">
            WOFF2 is the smallest and the best for a website; WOFF, TTF and OTF work too. Up to {count(FONT_LIMITS.files, "file")}, one for each
            weight and style you use.
          </p>

          <details className="media-delete">
            <summary>Delete {font.name}</summary>
            {font.inUse ? (
              <p className="editor-hint">The design uses it, in what is published or in a draft. Choose another font there first.</p>
            ) : (
              <form action={deleteFontAction}>
                <input type="hidden" name="fontId" value={font.key} />
                <p className="editor-hint">The font and its files are removed. This cannot be undone.</p>
                <button type="submit" className="btn btn-outline btn-small">
                  Yes, delete {font.name}
                </button>
              </form>
            )}
          </details>
        </section>
      ))}

      <form action={addFontAction} className="admin-card">
        <h3>Add a font</h3>
        <div className="admin-form-row">
          <div className="form-group" style={{ flex: "2 1 14rem" }}>
            <label className="form-label" htmlFor="font-name">
              Name of the font
            </label>
            <input id="font-name" name="name" className="form-control" maxLength={FONT_LIMITS.name} placeholder="Horizon" required />
          </div>
          <div className="form-group" style={{ flex: "2 1 14rem" }}>
            <label className="form-label" htmlFor="font-kind">
              What kind of font it is
            </label>
            <select id="font-kind" name="kind" className="form-control" defaultValue="display">
              {KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="font-licence">
            The licence you hold for it
          </label>
          <textarea id="font-licence" name="licence" className="form-control" rows={2} maxLength={FONT_LIMITS.licence} minLength={3} required />
          <div className="editor-hint">In your own words: where you bought it and what it covers. For example: web licence from the maker, bought in 2025.</div>
        </div>
        <label style={{ display: "block", fontSize: ".9rem", margin: "0 0 1rem" }}>
          <input type="checkbox" name="holdsLicence" required /> I hold a licence that allows this font on a website
        </label>
        <button type="submit" className="btn btn-dark btn-small">
          Add the font
        </button>
        <p className="editor-hint">Its files are added in the next step.</p>
      </form>
    </AdminFrame>
  );
}
