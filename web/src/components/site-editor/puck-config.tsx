"use client";

import { FieldLabel, type Config, type Data, type Field as PuckField } from "@puckeditor/core";
import Image from "next/image";
import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from "react";
import type { ChoosablePicture } from "@/app/admin/website/media/actions";
import { PictureChooser } from "@/components/media/PictureChooser";
import { BLOCK_GROUPS, type BlockSpec, type SiteContext } from "@/lib/site/blocks/block";
import { hasPhone, startProps, type Field, type Fields } from "@/lib/site/blocks/fields";
import { BLOCK_NAMES, BLOCKS } from "@/lib/site/blocks/registry";
import { parseHref } from "@/lib/site/frame";
import type { PageContent } from "@/lib/site/page";

/**
 * The page editor's link to Puck. Puck is given a configuration made from the
 * site's own block descriptions (src/lib/site/blocks): one form field for
 * each of a block's fields, the block's starting values, and its drawing. A
 * page therefore holds nothing the site did not describe, and the server
 * checks every page it is sent all the same (`parsePage`).
 *
 * Puck's data is `{ root: { props }, content }`, and a place for blocks holds
 * its blocks inline as `{ type, props }`, which is the shape the site stores.
 * Only two things differ, and `toPuckData` and `fromPuckData` turn one into
 * the other: the page's settings for search engines are the root's values,
 * and a number for phones that is "as on a computer" is stored as null and
 * shown by Puck as an empty choice.
 */

type Props = Record<string, unknown>;

// ── What blocks read besides their own values ────────────────────────────────

interface SiteState {
  site: SiteContext;
  /** Pictures chosen while editing, so that a block shows them at once. */
  addPictures(pictures: ChoosablePicture[]): void;
}

const SiteStateContext = createContext<SiteState | null>(null);

/** Holds the pictures and collections the page's blocks show, around the whole editor. */
export function SiteProvider({ initial, children }: { initial: SiteContext; children: ReactNode }) {
  const [site, setSite] = useState(initial);
  const addPictures = useCallback(
    (pictures: ChoosablePicture[]) =>
      setSite((current) => ({
        ...current,
        pictures: {
          ...current.pictures,
          ...Object.fromEntries(pictures.map((p) => [p.id, { id: p.id, url: p.url, width: p.width, height: p.height, alt: p.alt, caption: p.caption }])),
        },
      })),
    [],
  );
  const value = useMemo(() => ({ site, addPictures }), [site, addPictures]);
  return <SiteStateContext.Provider value={value}>{children}</SiteStateContext.Provider>;
}

function useSite(): SiteState {
  const value = useContext(SiteStateContext);
  if (!value) throw new Error("The page editor's blocks need a SiteProvider around them.");
  return value;
}

// ── Puck's data and the site's ───────────────────────────────────────────────

const isRecord = (value: unknown): value is Props => typeof value === "object" && value !== null && !Array.isArray(value);

/** A number as a form field may give it: 16, or "16". */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** A block's values for Puck (`toPuck`), or Puck's values for the site. The blocks inside it are turned too. */
function convert(fields: Fields, props: Props, toPuck: boolean): Props {
  const out: Props = { ...props };
  for (const [name, field] of Object.entries(fields)) {
    const value = props[name];
    if (field.kind === "number") {
      if (!toPuck) out[name] = asNumber(value) ?? value;
      if (hasPhone(field)) {
        const onPhone = props[`${name}Phone`];
        out[`${name}Phone`] = toPuck ? (onPhone ?? "") : (asNumber(onPhone) ?? null);
      }
    } else if (field.kind === "toggle" && !toPuck) {
      out[name] = value === "true" ? true : value === "false" ? false : value;
    } else if (field.kind === "slot" && Array.isArray(value)) {
      out[name] = value.map((item) => convertBlock(item, toPuck));
    } else if (field.kind === "list" && Array.isArray(value)) {
      out[name] = value.map((item) => (isRecord(item) ? convert(field.of, item, toPuck) : item));
    }
  }
  return out;
}

function specOf(type: unknown): BlockSpec<Fields> | undefined {
  return typeof type === "string" && Object.hasOwn(BLOCKS, type) ? (BLOCKS[type as keyof typeof BLOCKS] as unknown as BlockSpec<Fields>) : undefined;
}

function convertBlock(item: unknown, toPuck: boolean): unknown {
  if (!isRecord(item)) return item;
  const spec = specOf(item.type);
  const props = isRecord(item.props) ? item.props : {};
  return { type: item.type, props: spec ? convert(spec.fields, props, toPuck) : props };
}

export function toPuckData(content: PageContent): Data {
  return {
    root: { props: { title: content.meta.title, description: content.meta.description, hidden: content.meta.hidden } },
    content: content.blocks.map((block) => convertBlock(block, true)),
  } as Data;
}

export function fromPuckData(data: Data): PageContent {
  const rawRoot: unknown = data.root;
  const root: Props = isRecord(rawRoot) && isRecord(rawRoot.props) ? rawRoot.props : {};
  return {
    meta: {
      title: typeof root.title === "string" ? root.title : "",
      description: typeof root.description === "string" ? root.description : "",
      hidden: root.hidden === true || root.hidden === "true",
    },
    blocks: (Array.isArray(data.content) ? data.content : []).map((item) => convertBlock(item, false)) as PageContent["blocks"],
  };
}

// ── The fields of the side panel ─────────────────────────────────────────────

/** What the editor offers to choose from: the collections, and the pages a link can lead to. */
export interface EditorLists {
  collections: { id: string; name: string }[];
  links: { path: string; title: string }[];
}

/** The site's own pages, offered as link suggestions beside the pages made in the admin. */
const SITE_LINKS: { path: string; title: string }[] = [
  { path: "/", title: "Home" },
  { path: "/studios", title: "Our Studios" },
  { path: "/rates", title: "Rates" },
  { path: "/services", title: "Photography" },
  { path: "/faq", title: "Guest Information" },
  { path: "/policies", title: "Policies" },
  { path: "/contact", title: "Contact" },
  { path: "/book", title: "Book a studio" },
  { path: "/book/photography", title: "Book a photographer" },
  { path: "/account", title: "My Bookings" },
];

/** What formatted text may hold: what the cleaner keeps (src/lib/site/rich-text.ts), and nothing it would drop. */
const RICH_TEXT_OPTIONS = {
  code: false,
  codeBlock: false,
  strike: false,
  horizontalRule: false,
  heading: { levels: [2, 3, 4] },
  textAlign: { alignments: ["left", "center", "right"] },
};

function LinkInput({ id, label, value, onChange, readOnly, links }: { id: string; label: string; value: unknown; onChange: (value: string) => void; readOnly?: boolean; links: EditorLists["links"] }) {
  const listId = useId();
  const text = typeof value === "string" ? value : "";
  const problem = text.trim() !== "" && parseHref(text) === null ? "Not a link the site can show. A page of this site starts with /, any other address with https://" : "";
  return (
    <FieldLabel label={label} el="label" readOnly={readOnly}>
      <input
        id={id}
        className="pe-input"
        list={listId}
        value={text}
        readOnly={readOnly}
        placeholder="/book, or https://…"
        aria-invalid={problem ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {[...SITE_LINKS, ...links].map((link) => (
          <option key={link.path} value={link.path}>
            {link.title}
          </option>
        ))}
      </datalist>
      {problem && <span className="pe-problem">{problem}</span>}
    </FieldLabel>
  );
}

function Thumb({ id }: { id: string }) {
  const { site } = useSite();
  const picture = site.pictures[id];
  if (!picture) return <span className="pe-hint">This picture is no longer in the library.</span>;
  return <Image className="pe-thumb" src={picture.url} width={picture.width} height={picture.height} alt={picture.alt || "A picture without a description"} sizes="120px" />;
}

function PictureInput({ label, value, onChange, readOnly }: { label: string; value: unknown; onChange: (value: string) => void; readOnly?: boolean }) {
  const { site, addPictures } = useSite();
  const id = typeof value === "string" ? value : "";
  const picture = id ? site.pictures[id] : undefined;
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly}>
      <div className="pe-picture">
        {id ? <Thumb id={id} /> : <span className="pe-hint">No picture chosen.</span>}
        {picture && !picture.alt && <span className="pe-problem">It has no description yet. Describe it under Pictures before publishing the page.</span>}
        {!readOnly && (
          <span className="pe-buttons">
            <PictureChooser
              label={id ? "Choose another" : "Choose a picture"}
              onChoose={([chosen]) => {
                addPictures([chosen]);
                onChange(chosen.id);
              }}
            />
            {id && (
              <button type="button" className="btn btn-outline btn-small" onClick={() => onChange("")}>
                Remove
              </button>
            )}
          </span>
        )}
      </div>
    </FieldLabel>
  );
}

function PicturesInput({ label, value, onChange, readOnly, max }: { label: string; value: unknown; onChange: (value: string[]) => void; readOnly?: boolean; max: number }) {
  const { site, addPictures } = useSite();
  const ids = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };
  return (
    <FieldLabel label={label} el="div" readOnly={readOnly}>
      {ids.length === 0 ? (
        <p className="pe-hint">No pictures chosen.</p>
      ) : (
        <ol className="pe-pictures">
          {ids.map((id, index) => (
            <li key={id}>
              <Thumb id={id} />
              <span className="pe-hint">{site.pictures[id]?.alt || "No description yet"}</span>
              {!readOnly && (
                <span className="pe-buttons">
                  <button type="button" className="btn btn-outline btn-small" disabled={index === 0} aria-label={`Move picture ${index + 1} earlier`} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button type="button" className="btn btn-outline btn-small" disabled={index === ids.length - 1} aria-label={`Move picture ${index + 1} later`} onClick={() => move(index, 1)}>
                    ↓
                  </button>
                  <button type="button" className="btn btn-outline btn-small" aria-label={`Take picture ${index + 1} out`} onClick={() => onChange(ids.filter((entry) => entry !== id))}>
                    ×
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {!readOnly && ids.length < max && (
        <PictureChooser
          label="Add pictures"
          multiple
          onChoose={(chosen) => {
            addPictures(chosen);
            onChange([...ids, ...chosen.map((picture) => picture.id).filter((id) => !ids.includes(id))].slice(0, max));
          }}
        />
      )}
    </FieldLabel>
  );
}

/** The value a list item is named by in the panel: its title field, cut short. */
function summaryOf(item: unknown, title: string): string {
  const value = isRecord(item) ? item[title] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 40) : "New";
}

function puckField(field: Field, lists: EditorLists, nested: boolean): PuckField {
  switch (field.kind) {
    case "text":
      // Words of a heading are typed on the page itself; inside a list they are typed in the panel.
      return { type: field.lines ? "textarea" : "text", label: field.label, contentEditable: field.inline === true && !nested };
    case "rich":
      return { type: "richtext", label: field.label, contentEditable: !nested, options: RICH_TEXT_OPTIONS } as PuckField;
    case "choice":
      return { type: "select", label: field.label, options: Object.entries(field.options).map(([value, label]) => ({ label, value })) };
    case "toggle":
      return {
        type: "radio",
        label: field.label,
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
      };
    case "number":
      return { type: "number", label: field.label, min: field.min, max: field.max, step: field.step ?? 1 };
    case "link":
      return {
        type: "custom",
        label: field.label,
        render: ({ id, value, onChange, readOnly }) => <LinkInput id={id} label={field.label} value={value} onChange={onChange} readOnly={readOnly} links={lists.links} />,
      };
    case "picture":
      return { type: "custom", label: field.label, render: ({ value, onChange, readOnly }) => <PictureInput label={field.label} value={value} onChange={onChange} readOnly={readOnly} /> };
    case "pictures":
      return {
        type: "custom",
        label: field.label,
        render: ({ value, onChange, readOnly }) => <PicturesInput label={field.label} value={value} onChange={onChange} readOnly={readOnly} max={field.max} />,
      };
    case "collection":
      return {
        type: "select",
        label: field.label,
        options: [
          { label: lists.collections.length > 0 ? "Choose a collection" : "No collections yet: make one under Collections", value: "" },
          ...lists.collections.map((collection) => ({ label: collection.name, value: collection.id })),
        ],
      };
    case "list":
      return {
        type: "array",
        label: field.label,
        arrayFields: puckFields(field.of, lists, true),
        defaultItemProps: convert(field.of, startProps(field.of), true),
        getItemSummary: (item: unknown) => summaryOf(item, field.title),
        max: field.max,
      } as PuckField;
    case "slot":
      return { type: "slot", ...(field.allow ? { allow: [...field.allow] } : {}) };
  }
}

/** The second field of a value that can differ on a phone. Its first choice keeps the computer's value. */
function phoneField(field: Field): PuckField | null {
  if (!hasPhone(field)) return null;
  const same = { label: "As on a computer", value: "" };
  if (field.kind === "choice") {
    return { type: "select", label: `${field.label}, on a phone`, options: [same, ...Object.entries(field.options).map(([value, label]) => ({ label, value }))] };
  }
  const steps: { label: string; value: number }[] = [];
  for (let value = field.min; value <= field.max; value += field.step ?? 1) steps.push({ label: String(value), value });
  return { type: "select", label: `${field.label}, on a phone`, options: [same, ...steps] };
}

function puckFields(fields: Fields, lists: EditorLists, nested: boolean): Record<string, PuckField> {
  const out: Record<string, PuckField> = {};
  for (const [name, field] of Object.entries(fields)) {
    out[name] = puckField(field, lists, nested);
    const onPhone = phoneField(field);
    if (onPhone) out[`${name}Phone`] = onPhone;
  }
  return out;
}

// ── The blocks on the canvas ─────────────────────────────────────────────────

/** A block as the editor draws it: the site's own drawing, with Puck's values turned into the site's. */
function EditorBlock({ spec, props }: { spec: BlockSpec<Fields>; props: Props }) {
  const { site } = useSite();
  const values: Props = { ...props };
  delete values.puck;
  delete values.editMode;
  const id = typeof values.id === "string" ? values.id : "";
  return <>{spec.render({ ...convert(spec.fields, values, false), id, site, editing: true } as never)}</>;
}

/** Puck's configuration: every block, sorted into the editor's groups, and the page's own settings as the root's. */
export function buildPuckConfig(lists: EditorLists): Config {
  const components: Record<string, unknown> = {};
  for (const name of BLOCK_NAMES) {
    const spec = specOf(name)!;
    components[name] = {
      label: spec.label,
      fields: puckFields(spec.fields, lists, false),
      defaultProps: convert(spec.fields, startProps(spec.fields), true),
      render: (props: Props) => <EditorBlock spec={spec} props={props} />,
    };
  }
  const categories = Object.fromEntries(
    Object.entries(BLOCK_GROUPS).map(([group, title]) => [group, { title, components: BLOCK_NAMES.filter((name) => BLOCKS[name].group === group) }]),
  );
  return {
    components,
    categories,
    root: {
      label: "Page",
      fields: {
        title: { type: "text", label: "Title in search results and on the browser's tab (empty: the page's name)" },
        description: { type: "textarea", label: "Description a search engine may show under the title" },
        hidden: {
          type: "radio",
          label: "Ask search engines not to list this page",
          options: [
            { label: "Yes", value: true },
            { label: "No", value: false },
          ],
        },
      },
      defaultProps: { title: "", description: "", hidden: false },
      render: ({ children }: { children: ReactNode }) => <div className="site-page blk-root">{children}</div>,
    },
  } as unknown as Config;
}
