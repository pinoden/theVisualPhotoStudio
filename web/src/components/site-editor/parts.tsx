"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { VersionSummary } from "@/server/website";
import type { DocumentEditor } from "./useDocumentEditor";

/** The parts every editor of the website shares: the bar with its buttons, the preview, the history and the form fields. */

const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const dayAndClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Where a preview starts: the route that switches the preview on, then the page. */
export const previewUrl = (path: string) => `/admin/website/preview?to=${encodeURIComponent(path)}`;

// ── The bar ──────────────────────────────────────────────────────────────────

function statusText<T>(editor: DocumentEditor<T>): string {
  switch (editor.status) {
    case "waiting":
    case "saving":
      return "Saving the draft…";
    case "error":
      return "Not saved.";
    case "conflict":
      return "Not saved: changed somewhere else.";
    default:
      if (!editor.hasDraft) return "Nothing to publish: the website shows exactly this.";
      return editor.savedAt ? `Draft saved at ${clock.format(new Date(editor.savedAt))}. Visitors do not see it yet.` : "Draft saved. Visitors do not see it yet.";
  }
}

/**
 * Always on screen while editing: what state the work is in, and the buttons
 * that save it, show it, publish it or throw it away, each with plain words
 * for what it does.
 */
export function EditorBar<T>({
  editor,
  notice,
  previewPath,
  canDiscard = true,
}: {
  editor: DocumentEditor<T>;
  notice: string;
  previewPath: string;
  /** False for a page that was never published: there is nothing to go back to. */
  canDiscard?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const unsaved = editor.status === "waiting" || editor.status === "saving" || editor.status === "error";

  const openPreview = async () => {
    // Opened at once, so the browser sees it as this click's window; pointed at the preview once the draft is saved.
    const tab = window.open("about:blank", "_blank");
    const saved = await editor.saveNow();
    if (!tab) return;
    if (saved) tab.location.href = previewUrl(previewPath);
    else tab.close();
  };

  return (
    <div className="editor-bar">
      <p className="editor-status" role="status">
        {statusText(editor)}
      </p>
      <div className="editor-actions">
        <button type="button" className="btn btn-outline btn-small" disabled={editor.busy || !unsaved} onClick={() => void editor.saveNow()}>
          Save draft
        </button>
        <button type="button" className="btn btn-outline btn-small" disabled={editor.busy} onClick={() => void openPreview()}>
          Preview
        </button>
        {editor.mayPublish && (
          <button
            type="button"
            className="btn btn-dark btn-small"
            disabled={editor.busy || (!editor.hasDraft && !unsaved) || editor.status === "conflict"}
            onClick={() => void editor.publish()}
          >
            Publish
          </button>
        )}
        {!canDiscard ? null : confirming ? (
          <span className="editor-confirm">
            Throw the unpublished changes away?{" "}
            <button
              type="button"
              className="btn btn-outline btn-small"
              disabled={editor.busy}
              onClick={() => {
                setConfirming(false);
                void editor.discard();
              }}
            >
              Yes, discard them
            </button>{" "}
            <button type="button" className="btn btn-outline btn-small" onClick={() => setConfirming(false)}>
              Keep them
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-outline btn-small"
            disabled={editor.busy || (!editor.hasDraft && !unsaved && editor.status !== "conflict")}
            onClick={() => setConfirming(true)}
          >
            Discard changes
          </button>
        )}
      </div>
      {!editor.mayPublish && <p className="editor-hint">You can prepare changes as a draft. An owner publishes them.</p>}
      {notice && (
        <div className="flash flash-success" role="status">
          {notice}
        </div>
      )}
      {editor.problem && (
        <div className="flash flash-error" role="alert">
          {editor.problem}
        </div>
      )}
      {editor.conflict && (
        <div className="flash flash-error" role="alert">
          This was changed somewhere else
          {editor.conflict.by && ` by ${editor.conflict.by}`}
          {editor.conflict.at && ` at ${clock.format(new Date(editor.conflict.at))}`} since you opened it, so your changes were
          not saved.{" "}
          <button type="button" className="btn btn-outline btn-small" onClick={editor.reload}>
            Load that version
          </button>{" "}
          <button type="button" className="btn btn-outline btn-small" onClick={() => void editor.overwrite()}>
            Save mine over it
          </button>
        </div>
      )}
    </div>
  );
}

// ── The preview ──────────────────────────────────────────────────────────────

/** The screens a preview can imitate. The widths are the ones the phone tests measure. */
const DEVICES = [
  { key: "computer", label: "Computer", width: 1280 },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "phone-large", label: "Large phone", width: 430 },
  { key: "phone", label: "Phone", width: 390 },
  { key: "phone-small", label: "Small phone", width: 320 },
] as const;
type DeviceKey = (typeof DEVICES)[number]["key"];

/** A stylesheet laid over a page in the frame, and the text it holds, for each page the frame has shown. */
type Overlays = WeakMap<Document, { sheet: CSSStyleSheet; css: string }>;

/**
 * Lay the design being edited over the page in the frame. It goes in as a
 * stylesheet that belongs to no element (`adoptedStyleSheets`), which comes
 * after the page's own in the cascade and so wins. The page's own elements are
 * not touched: the page is a React page, and changing one of its elements
 * while it is still starting up makes React report that the page differs from
 * what the server sent.
 */
function overlayCss(frame: HTMLIFrameElement | null, css: string | undefined, overlays: Overlays): void {
  const page = frame?.contentDocument;
  const view = frame?.contentWindow as (Window & { CSSStyleSheet: typeof CSSStyleSheet }) | null | undefined;
  if (css === undefined || !page || !view) return;
  try {
    let overlay = overlays.get(page);
    if (!overlay) {
      // Made by the frame's own window: a stylesheet cannot be shared between two documents.
      overlay = { sheet: new view.CSSStyleSheet(), css: "" };
      page.adoptedStyleSheets = [...page.adoptedStyleSheets, overlay.sheet];
      overlays.set(page, overlay);
    }
    if (overlay.css !== css) {
      overlay.sheet.replaceSync(css);
      overlay.css = css;
    }
  } catch {
    // A browser too old for this shows the change once the draft is saved and the preview loaded again.
  }
}

/**
 * The website itself, with the unpublished changes, beside the form. It is
 * the real page in a frame, at the width of the chosen screen and scaled down
 * to fit, so what is seen is what a visitor with that screen will get.
 *
 * `css` is the design as it stands in the form: it is laid over the page's
 * design the moment a value changes, before anything is saved. `reload` loads
 * the page again when it changes, for edits that are part of the page's
 * content.
 */
export function PreviewPane({ path, css, reload }: { path: string; css?: string; reload: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [device, setDevice] = useState<DeviceKey>("computer");
  /** The room the stylesheet gives the pretend screen, in the editor's own pixels. */
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const groupName = useId();

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const overlays = useRef<Overlays>(new WeakMap());
  // After every change of the form, and again whenever the frame shows a new page.
  const applyCss = () => overlayCss(frame.current, css, overlays.current);
  useEffect(applyCss);

  const loaded = useRef(reload);
  useEffect(() => {
    if (loaded.current === reload) return;
    loaded.current = reload;
    frame.current?.contentWindow?.location.reload();
  }, [reload]);

  const width = DEVICES.find((entry) => entry.key === device)!.width;
  const scale = room.width > 0 ? Math.min(1, room.width / width) : 1;

  return (
    <div className="editor-preview">
      <div className="editor-devices" role="radiogroup" aria-label="Screen to preview">
        {DEVICES.map((entry) => (
          <label key={entry.key} className={entry.key === device ? "chosen" : undefined}>
            <input type="radio" name={groupName} checked={entry.key === device} onChange={() => setDevice(entry.key)} />
            {entry.label}
          </label>
        ))}
      </div>
      <div className="editor-screen" ref={box}>
        <iframe
          ref={frame}
          title="Preview of the website"
          src={previewUrl(path)}
          onLoad={applyCss}
          // The page is laid out at the screen's real width, then shrunk to fit: so a computer's page is shown whole in a narrow column.
          style={{ width, height: room.height > 0 ? room.height / scale : undefined, transform: `scale(${scale})` }}
        />
      </div>
      <p className="editor-hint">
        The website with your unpublished changes, {width}px wide. Links work, so you can look at any page.
      </p>
    </div>
  );
}

// ── The history ──────────────────────────────────────────────────────────────

/** The versions that were published, each of which can be brought back as the draft. */
export function History<T>({ editor, versions, onOriginal }: { editor: DocumentEditor<T>; versions: VersionSummary[]; onOriginal?: () => void }) {
  return (
    <section className="admin-card editor-history" aria-labelledby="editor-history-title">
      <h3 id="editor-history-title">History</h3>
      <p className="editor-hint">
        Every time this is published, a copy is kept. Bringing a version back puts it here as a draft: visitors see it
        only once you publish it.
      </p>
      {versions.length === 0 ? (
        <p className="editor-hint">Nothing has been published yet: the website shows it as it was built.</p>
      ) : (
        <ul>
          {versions.map((version) => (
            <li key={version.id}>
              <span>
                <strong>Version {version.number}</strong>
                {version.current && <em> · on the website now</em>}
                <br />
                {dayAndClock.format(new Date(version.publishedAt))}, by {version.publishedBy}
              </span>
              {!version.current && (
                <button type="button" className="btn btn-outline btn-small" disabled={editor.busy} onClick={() => void editor.restore(version.id)}>
                  Bring back version {version.number}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {onOriginal && (
        <p className="editor-original">
          <button type="button" className="btn btn-outline btn-small" disabled={editor.busy} onClick={onOriginal}>
            Start again from the site as it was built
          </button>
        </p>
      )}
    </section>
  );
}

// ── Form fields ──────────────────────────────────────────────────────────────

/** A group of fields that folds away. */
export function Group({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="admin-card editor-group" open={open}>
      <summary>{title}</summary>
      <div className="editor-fields">{children}</div>
    </details>
  );
}

export function TextField({
  label,
  value,
  onChange,
  maxLength,
  help,
  problem,
  list,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  help?: string;
  /** Said under the field while its value is not one the site can use. */
  problem?: string;
  /** The id of a `<datalist>` with suggestions. */
  list?: string;
  type?: "text" | "url" | "tel" | "date";
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="form-control"
        type={type}
        value={value}
        maxLength={maxLength}
        list={list}
        placeholder={placeholder}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem || help ? `${id}-note` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {(problem || help) && (
        <div id={`${id}-note`} className={problem ? "editor-problem" : "editor-hint"}>
          {problem || help}
        </div>
      )}
    </div>
  );
}

export function TextArea({ label, value, onChange, maxLength, help }: { label: string; value: string; onChange: (value: string) => void; maxLength?: number; help?: string }) {
  const id = useId();
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <textarea id={id} className="form-control" rows={3} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} />
      {help && <div className="editor-hint">{help}</div>}
    </div>
  );
}

export function SelectField<V extends string | number>({
  label,
  value,
  onChange,
  options,
  help,
}: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string; group?: string }[];
  help?: string;
}) {
  const id = useId();
  const groups = [...new Set(options.map((option) => option.group ?? ""))];
  const pick = (raw: string) => onChange(options.find((option) => String(option.value) === raw)!.value);
  const items = (group: string) =>
    options
      .filter((option) => (option.group ?? "") === group)
      .map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ));
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="form-control" value={String(value)} onChange={(event) => pick(event.target.value)}>
        {groups.map((group) =>
          group === "" ? (
            items(group)
          ) : (
            <optgroup key={group} label={group}>
              {items(group)}
            </optgroup>
          ),
        )}
      </select>
      {help && <div className="editor-hint">{help}</div>}
    </div>
  );
}

/** A number on a slider, with its value written beside it. */
export function RangeField({
  label,
  value,
  onChange,
  limit,
  show,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  limit: { min: number; max: number; step: number };
  /** How the value reads: "110%", "0.04 em". */
  show: (value: number) => string;
}) {
  const id = useId();
  return (
    <div className="form-group editor-range">
      <label className="form-label" htmlFor={id}>
        {label} <output htmlFor={id}>{show(value)}</output>
      </label>
      <input
        id={id}
        type="range"
        min={limit.min}
        max={limit.max}
        step={limit.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

export function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="editor-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}
    </label>
  );
}

/** A colour: the browser's picker, and the same colour as text for someone who has its code. */
export function ColorField({ label, value, onChange, help }: { label: string; value: string; onChange: (value: string) => void; help?: string }) {
  const id = useId();
  // What is being typed, which is only a colour once it is complete.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <div className="form-group editor-color">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <div>
        <input id={id} type="color" value={value} onChange={(event) => onChange(event.target.value.toLowerCase())} />
        <input
          className="form-control"
          aria-label={`${label}, as a colour code`}
          value={typed ?? value}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => {
            const text = event.target.value.trim();
            setTyped(text);
            if (/^#[0-9a-f]{6}$/i.test(text)) onChange(text.toLowerCase());
          }}
          onBlur={() => setTyped(null)}
        />
      </div>
      {help && <div className="editor-hint">{help}</div>}
    </div>
  );
}
