"use client";

import Image from "next/image";
import { useId, useState } from "react";
import type { ChoosablePicture } from "@/app/admin/website/media/actions";
import { PictureChooser } from "@/components/media/PictureChooser";
import {
  ANNOUNCEMENT_STYLES,
  BOOK_BUTTON_STYLES,
  FRAME_LIMITS,
  MENU_POSITIONS,
  parseHref,
  SOCIAL_NETWORKS,
  type MenuItem,
  type SiteFrame,
  type SiteLink,
  type SocialNetwork,
} from "@/lib/site/frame";
import type { EditingState, VersionSummary } from "@/server/website";
import { CheckField, EditorBar, Group, History, PreviewPane, SelectField, TextArea, TextField } from "./parts";
import { useStarted } from "@/components/use-started";
import { useDocumentEditor } from "./useDocumentEditor";

/** The site's own screens a link can lead to, offered as suggestions beside the pages of the admin. */
const PAGES: [path: string, name: string][] = [
  ["/book", "Book a studio"],
  ["/book/photography", "Book a photographer"],
  ["/account", "My Bookings"],
];

const options = <T extends string>(choices: Record<T, string>) => (Object.keys(choices) as T[]).map((value) => ({ value, label: choices[value] }));

const moved = <T,>(list: T[], index: number, by: -1 | 1): T[] => {
  const to = index + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
};
const without = <T,>(list: T[], index: number): T[] => list.filter((_, position) => position !== index);
const replaced = <T,>(list: T[], index: number, item: T): T[] => list.map((current, position) => (position === index ? item : current));

/** Why a link is left out, in words for the person typing it. Empty when it is fine. */
function linkProblem(href: string): string {
  if (href.trim() === "") return "Needs a link.";
  return parseHref(href) === null ? "Not a link the site can show. A page of this site starts with /, any other address with https://" : "";
}

/** The three small buttons beside a row of a list. */
function RowButtons({ name, index, count, onMove, onRemove }: { name: string; index: number; count: number; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  return (
    <span className="editor-row-buttons">
      <button type="button" className="btn btn-outline btn-small" disabled={index === 0} aria-label={`Move ${name} up`} onClick={() => onMove(-1)}>
        ↑
      </button>
      <button type="button" className="btn btn-outline btn-small" disabled={index === count - 1} aria-label={`Move ${name} down`} onClick={() => onMove(1)}>
        ↓
      </button>
      <button type="button" className="btn btn-outline btn-small" aria-label={`Remove ${name}`} onClick={onRemove}>
        Remove
      </button>
    </span>
  );
}

/** A list of links: each a name and an address, with buttons to reorder and remove, and one to add. */
function LinkRows({
  links,
  onChange,
  max,
  what,
  pages,
}: {
  links: SiteLink[];
  onChange: (links: SiteLink[]) => void;
  max: number;
  /** What one row is, for the buttons: "link". */
  what: string;
  pages: string;
}) {
  return (
    <div className="editor-rows">
      {links.map((link, index) => {
        const name = link.label.trim() || `${what} ${index + 1}`;
        return (
          <div className="editor-row" key={index}>
            <TextField
              label="Name"
              value={link.label}
              maxLength={FRAME_LIMITS.label}
              problem={link.label.trim() === "" ? "Needs a name." : ""}
              onChange={(label) => onChange(replaced(links, index, { ...link, label }))}
            />
            <TextField
              label="Leads to"
              value={link.href}
              maxLength={FRAME_LIMITS.href}
              list={pages}
              problem={linkProblem(link.href)}
              onChange={(href) => onChange(replaced(links, index, { ...link, href }))}
            />
            <RowButtons name={name} index={index} count={links.length} onMove={(by) => onChange(moved(links, index, by))} onRemove={() => onChange(without(links, index))} />
          </div>
        );
      })}
      {links.length < max ? (
        <button type="button" className="btn btn-outline btn-small" onClick={() => onChange([...links, { label: "", href: "" }])}>
          Add a {what}
        </button>
      ) : (
        <p className="editor-hint">That is as many as fit here ({max}).</p>
      )}
    </div>
  );
}

export interface FrameEditorProps {
  initial: EditingState<SiteFrame>;
  versions: VersionSummary[];
  /** The pages of the admin, the home page among them, offered as link suggestions beside the site's own screens. */
  pages: { path: string; title: string }[];
  /** The pictures the draft names (the logo's, the sharing picture): the frame itself only holds their ids. */
  pictures: ChoosablePicture[];
}

/**
 * The editor for what surrounds every page: the studio's details, the logo,
 * the menu, the booking button, the announcement bar, the footer and the
 * social links. The preview beside it loads again after each save of the
 * draft. Nothing reaches visitors until Publish.
 */
export function FrameEditor(props: FrameEditorProps) {
  const [notice, setNotice] = useState("");
  return <FrameForm key={props.initial.revision} {...props} notice={notice} report={setNotice} />;
}

function FrameForm({ initial, versions, pictures, pages: madePages, notice, report }: FrameEditorProps & { notice: string; report: (notice: string) => void }) {
  const editor = useDocumentEditor<SiteFrame>("frame", initial, report);
  const started = useStarted();
  const frame = editor.value;
  const pages = useId();
  // The pictures this editor has seen, to show the ones the frame names by their ids.
  const [seen, setSeen] = useState<ChoosablePicture[]>(pictures);
  const logoShown = seen.find((picture) => picture.id === frame.logo.image);
  const shareShown = seen.find((picture) => picture.id === frame.search.image);
  const set = <K extends keyof SiteFrame>(key: K, value: SiteFrame[K]) => editor.change({ ...frame, [key]: value });
  const { business, logo, menu, bookButton, footer, social, announcement, search } = frame;
  const setMenuItem = (index: number, item: MenuItem) => set("menu", replaced(menu, index, item));

  return (
    <div className="site-editor">
      <datalist id={pages}>
        {[...PAGES, ...madePages.map((page): [string, string] => [page.path, page.title])].map(([path, name]) => (
          <option key={path} value={path}>
            {name}
          </option>
        ))}
      </datalist>
      <EditorBar editor={editor} notice={notice} previewPath="/" />
      <div className="editor-grid">
        {/* Its fields wait until the page has started: what is typed before would not reach the editor. */}
        <fieldset className="editor-form" inert={editor.busy} disabled={!started}>
          <Group title="The studio: name, address and phone" open>
            <p className="editor-hint">
              Shown in the footer and on the contact page, and printed in every email and on every receipt the site
              sends.
            </p>
            <TextField label="Name of the studio" value={business.name} maxLength={80} onChange={(name) => set("business", { ...business, name })} />
            <TextField label="Address, first line" value={business.addressLine1} maxLength={FRAME_LIMITS.line} onChange={(addressLine1) => set("business", { ...business, addressLine1 })} />
            <TextField label="Address, second line" value={business.addressLine2} maxLength={FRAME_LIMITS.line} onChange={(addressLine2) => set("business", { ...business, addressLine2 })} />
            <TextField label="Phone number" type="tel" value={business.phone} maxLength={30} help="As you want it shown. On a phone, pressing it dials the number." onChange={(phone) => set("business", { ...business, phone })} />
            <TextField
              label="Link to the studio on a map"
              type="url"
              value={business.mapsUrl}
              maxLength={FRAME_LIMITS.href}
              problem={/^https?:\/\//i.test(business.mapsUrl.trim()) && parseHref(business.mapsUrl) ? "" : "Needs a web address that starts with https://"}
              onChange={(mapsUrl) => set("business", { ...business, mapsUrl })}
            />
            <TextField label="A short line under the contact details" value={business.note} maxLength={FRAME_LIMITS.line} help="For example: By appointment only. Leave it empty to show nothing." onChange={(note) => set("business", { ...business, note })} />
          </Group>

          <Group title="Logo">
            <TextField label="Logo text" value={logo.text} maxLength={FRAME_LIMITS.label} onChange={(text) => set("logo", { ...logo, text })} />
            <TextField label="Second part, in the accent colour" value={logo.accent} maxLength={FRAME_LIMITS.label} help="Leave it empty for a logo in one colour." onChange={(accent) => set("logo", { ...logo, accent })} />
            <h4 className="editor-subtitle">A logo that is a picture</h4>
            <p className="editor-hint">
              With a picture, the header shows it in place of the text above, which stays in the footer. A PNG with a
              see-through background sits best on the header.
            </p>
            {logo.image !== "" && (
              <p className="editor-logo">
                {logoShown ? (
                  <Image src={logoShown.url} width={logoShown.width} height={logoShown.height} alt={logoShown.alt || logoShown.filename} sizes="240px" />
                ) : (
                  <span className="editor-hint">A picture is chosen.</span>
                )}
              </p>
            )}
            <div className="editor-row-buttons">
              <PictureChooser
                label={logo.image === "" ? "Choose a picture for the logo" : "Choose another picture"}
                onChoose={([picture]) => {
                  setSeen((current) => [...current.filter((entry) => entry.id !== picture.id), picture]);
                  set("logo", { ...logo, image: picture.id });
                }}
              />
              {logo.image !== "" && (
                <button type="button" className="btn btn-outline btn-small" onClick={() => set("logo", { ...logo, image: "" })}>
                  Go back to the text logo
                </button>
              )}
            </div>
          </Group>

          <Group title="Menu" open>
            <SelectField
              label="Where the menu sits in the header"
              value={frame.header.menuPosition}
              options={options(MENU_POSITIONS)}
              help="On a phone, and on any screen too narrow for the whole menu, it folds behind a Menu button by itself."
              onChange={(menuPosition) => set("header", { menuPosition })}
            />
            <div className="editor-rows">
              {menu.map((item, index) => {
                const name = item.label.trim() || `item ${index + 1}`;
                const isList = item.children.length > 0;
                return (
                  <div className="editor-row editor-menu-item" key={index}>
                    <TextField label="Name" value={item.label} maxLength={FRAME_LIMITS.label} problem={item.label.trim() === "" ? "Needs a name." : ""} onChange={(label) => setMenuItem(index, { ...item, label })} />
                    {!isList && (
                      <TextField label="Leads to" value={item.href} maxLength={FRAME_LIMITS.href} list={pages} problem={linkProblem(item.href)} onChange={(href) => setMenuItem(index, { ...item, href })} />
                    )}
                    <CheckField
                      label="Opens a list of links instead of leading somewhere"
                      checked={isList}
                      onChange={(list) => setMenuItem(index, list ? { ...item, children: [{ label: "", href: "" }] } : { ...item, children: [] })}
                    />
                    <RowButtons name={name} index={index} count={menu.length} onMove={(by) => set("menu", moved(menu, index, by))} onRemove={() => set("menu", without(menu, index))} />
                    {isList && (
                      <div className="editor-sub">
                        <p className="editor-hint">The links in the list under “{name}”:</p>
                        <LinkRows links={item.children} max={FRAME_LIMITS.menuChildren} what="link" pages={pages} onChange={(children) => setMenuItem(index, { ...item, children })} />
                      </div>
                    )}
                  </div>
                );
              })}
              {menu.length < FRAME_LIMITS.menuItems ? (
                <button type="button" className="btn btn-outline btn-small" onClick={() => set("menu", [...menu, { label: "", href: "", children: [] }])}>
                  Add a menu item
                </button>
              ) : (
                <p className="editor-hint">That is as many as the menu takes ({FRAME_LIMITS.menuItems}). Put the rest in a list under one of them.</p>
              )}
            </div>
            <p className="editor-hint">A row that is not complete is left out of the website until it has a name and a link.</p>

            <h4 className="editor-subtitle">The booking button</h4>
            <p className="editor-hint">It closes the menu and always leads to the booking page, so that booking cannot be broken from here.</p>
            <TextField label="Words on the button" value={bookButton.label} maxLength={24} onChange={(label) => set("bookButton", { ...bookButton, label })} />
            <SelectField label="Look" value={bookButton.style} options={options(BOOK_BUTTON_STYLES)} onChange={(style) => set("bookButton", { ...bookButton, style })} />
          </Group>

          <Group title="Announcement bar">
            <p className="editor-hint">One message across the top of every page, under the header. A visitor can close it.</p>
            <CheckField label="Show the announcement" checked={announcement.enabled} onChange={(enabled) => set("announcement", { ...announcement, enabled })} />
            <TextArea label="Message" value={announcement.text} maxLength={FRAME_LIMITS.announcement} onChange={(text) => set("announcement", { ...announcement, text })} />
            <TextField label="Link after the message: its words" value={announcement.linkLabel} maxLength={FRAME_LIMITS.label} help="Optional. For example: Book now." onChange={(linkLabel) => set("announcement", { ...announcement, linkLabel })} />
            <TextField
              label="Link after the message: where it leads"
              value={announcement.linkHref}
              maxLength={FRAME_LIMITS.href}
              list={pages}
              problem={announcement.linkLabel.trim() !== "" || announcement.linkHref.trim() !== "" ? linkProblem(announcement.linkHref) : ""}
              onChange={(linkHref) => set("announcement", { ...announcement, linkHref })}
            />
            <TextField label="First day it shows" type="date" value={announcement.from} help="Optional. Leave empty to show it from now." onChange={(from) => set("announcement", { ...announcement, from })} />
            <TextField
              label="Last day it shows"
              type="date"
              value={announcement.until}
              help="Optional. Leave empty to show it until you switch it off."
              problem={announcement.from && announcement.until && announcement.until < announcement.from ? "This is before the first day, so it is ignored." : ""}
              onChange={(until) => set("announcement", { ...announcement, until })}
            />
            <SelectField label="Colour" value={announcement.style} options={options(ANNOUNCEMENT_STYLES)} onChange={(style) => set("announcement", { ...announcement, style })} />
          </Group>

          <Group title="Footer">
            <TextArea label="A few words about the studio, beside the logo" value={footer.tagline} maxLength={FRAME_LIMITS.tagline} onChange={(tagline) => set("footer", { ...footer, tagline })} />
            {footer.columns.map((column, index) => {
              const name = column.title.trim() || `column ${index + 1}`;
              const setColumn = (next: typeof column) => set("footer", { ...footer, columns: replaced(footer.columns, index, next) });
              return (
                <div className="editor-row editor-menu-item" key={index}>
                  <TextField label="Heading of the column" value={column.title} maxLength={FRAME_LIMITS.label} problem={column.title.trim() === "" ? "Needs a heading." : ""} onChange={(title) => setColumn({ ...column, title })} />
                  <RowButtons
                    name={name}
                    index={index}
                    count={footer.columns.length}
                    onMove={(by) => set("footer", { ...footer, columns: moved(footer.columns, index, by) })}
                    onRemove={() => set("footer", { ...footer, columns: without(footer.columns, index) })}
                  />
                  <div className="editor-sub">
                    <LinkRows links={column.links} max={FRAME_LIMITS.footerLinks} what="link" pages={pages} onChange={(links) => setColumn({ ...column, links })} />
                  </div>
                </div>
              );
            })}
            {footer.columns.length < FRAME_LIMITS.footerColumns && (
              <button
                type="button"
                className="btn btn-outline btn-small"
                onClick={() => set("footer", { ...footer, columns: [...footer.columns, { title: "", links: [{ label: "", href: "" }] }] })}
              >
                Add a column of links
              </button>
            )}
            <TextField label="Heading above the address and phone" value={footer.contactTitle} maxLength={FRAME_LIMITS.label} onChange={(contactTitle) => set("footer", { ...footer, contactTitle })} />
            <TextField
              label="The last line, after the studio's name"
              value={footer.copyright}
              maxLength={FRAME_LIMITS.line}
              help={`It reads: © ${business.name.trim() || "the studio's name"}. ${footer.copyright}`}
              onChange={(copyright) => set("footer", { ...footer, copyright })}
            />
          </Group>

          <Group title="Social links">
            <p className="editor-hint">Shown in the footer, under the words about the studio. With none, nothing is shown.</p>
            <div className="editor-rows">
              {social.map((entry, index) => (
                <div className="editor-row" key={index}>
                  <SelectField
                    label="Network"
                    value={entry.network}
                    options={options(SOCIAL_NETWORKS)}
                    onChange={(network: SocialNetwork) => set("social", replaced(social, index, { ...entry, network }))}
                  />
                  <TextField
                    label="Address of your page there"
                    type="url"
                    value={entry.url}
                    maxLength={FRAME_LIMITS.href}
                    placeholder="https://"
                    problem={/^https:\/\//i.test(entry.url.trim()) && parseHref(entry.url) ? "" : "Needs an address that starts with https://"}
                    onChange={(url) => set("social", replaced(social, index, { ...entry, url }))}
                  />
                  <RowButtons
                    name={SOCIAL_NETWORKS[entry.network]}
                    index={index}
                    count={social.length}
                    onMove={(by) => set("social", moved(social, index, by))}
                    onRemove={() => set("social", without(social, index))}
                  />
                </div>
              ))}
              {social.length < FRAME_LIMITS.social && (
                <button type="button" className="btn btn-outline btn-small" onClick={() => set("social", [...social, { network: "instagram", url: "" }])}>
                  Add a social link
                </button>
              )}
            </div>
          </Group>

          <Group title="Search engines and browser tabs">
            <TextField
              label="Title of the website"
              value={search.title}
              maxLength={FRAME_LIMITS.searchTitle}
              help="The title of the home page in a search result and on the browser's tab. Every other page shows its own name, then the studio's."
              onChange={(title) => set("search", { ...search, title })}
            />
            <TextArea
              label="Description of the website"
              value={search.description}
              maxLength={FRAME_LIMITS.searchDescription}
              help="One or two sentences a search engine may show under the title."
              onChange={(description) => set("search", { ...search, description })}
            />
            <h4 className="editor-subtitle">The picture shown when the website is shared</h4>
            <p className="editor-hint">
              A link to the website sent in a message or posted on Facebook shows this picture beside the title and the
              description. Without one, the first photo of the first studio is shown. A wide photograph suits it best.
            </p>
            {search.image !== "" && (
              <p className="editor-logo">
                {shareShown ? (
                  <Image src={shareShown.url} width={shareShown.width} height={shareShown.height} alt={shareShown.alt || shareShown.filename} sizes="240px" />
                ) : (
                  <span className="editor-hint">A picture is chosen.</span>
                )}
              </p>
            )}
            <div className="editor-row-buttons">
              <PictureChooser
                label={search.image === "" ? "Choose a picture for sharing" : "Choose another picture"}
                onChoose={([picture]) => {
                  setSeen((current) => [...current.filter((entry) => entry.id !== picture.id), picture]);
                  set("search", { ...search, image: picture.id });
                }}
              />
              {search.image !== "" && (
                <button type="button" className="btn btn-outline btn-small" onClick={() => set("search", { ...search, image: "" })}>
                  Use the first studio photo
                </button>
              )}
            </div>
          </Group>

          <History editor={editor} versions={versions} onOriginal={() => editor.change(initial.original)} />
        </fieldset>
        <PreviewPane path="/" reload={editor.saves} />
      </div>
    </div>
  );
}
