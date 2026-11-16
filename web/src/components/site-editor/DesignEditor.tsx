"use client";

import { useState } from "react";
import {
  DESIGN_LIMITS,
  designCss,
  fontNotes,
  parseDesign,
  readabilityChecks,
  type Design,
  type HeadingStyle,
} from "@/lib/site/design";
import { findFont, FONT_LIBRARY, fontStack, type FontGroup } from "@/lib/site/fonts";
import type { EditingState, VersionSummary } from "@/server/website";
import { CheckField, ColorField, EditorBar, Group, History, PreviewPane, RangeField, SelectField } from "./parts";
import { useDocumentEditor } from "./useDocumentEditor";

const COLORS: { key: keyof Design["colors"]; label: string; help: string }[] = [
  { key: "accent", label: "Accent", help: "Links, the small headings above titles, and the buttons that ask to book." },
  { key: "accentHover", label: "Accent, under the pointer", help: "What an accent button or a link turns into when the pointer is on it." },
  { key: "accentSoft", label: "Accent, pale", help: "Soft highlights." },
  { key: "onAccent", label: "Words on the accent", help: "The words of a button that is filled with the accent colour." },
  { key: "background", label: "Page", help: "Behind everything." },
  { key: "surface", label: "Cards", help: "Cards, and every second section of a page." },
  { key: "heading", label: "Headings and dark parts", help: "Headings, the dark buttons and the footer." },
  { key: "text", label: "Running text", help: "Paragraphs and lists." },
  { key: "border", label: "Lines", help: "Borders and dividing lines." },
];

const FONT_ROLES: { key: keyof Design["fonts"]; label: string; help: string; sample: string }[] = [
  { key: "heading", label: "Headings", help: "The main heading of a page and the heading of each section. Also the logo.", sample: "Where Every Frame Tells a Story" },
  { key: "subheading", label: "Subheadings", help: "The smaller headings inside a section and on cards.", sample: "Studio Blanche" },
  { key: "body", label: "Running text", help: "Paragraphs, lists, forms and the menu.", sample: "Three natural-light studios, available by the hour." },
  { key: "button", label: "Buttons", help: "The words on every button.", sample: "Book a Studio" },
];

const GROUP_NAMES: Record<FontGroup, string> = { serif: "Serif", sans: "Sans serif", display: "Display, for headings", script: "Script, for a few words" };
const FONT_OPTIONS = FONT_LIBRARY.map((font) => ({ value: font.id, label: font.name, group: GROUP_NAMES[font.group] }));

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi-bold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};
const weightOptions = (fontId: string) =>
  (findFont(fontId)?.weights ?? [400]).map((weight) => ({ value: weight, label: `${WEIGHT_NAMES[weight] ?? weight} (${weight})` }));

const HEADINGS: { key: keyof Design["headings"]; title: string; font: keyof Design["fonts"] }[] = [
  { key: "h1", title: "Main headings: the title of a page", font: "heading" },
  { key: "h2", title: "Section headings", font: "heading" },
  { key: "h3", title: "Smaller headings", font: "subheading" },
];

const percent = (value: number) => `${value}%`;
const pixels = (value: number) => `${value}px`;
const ems = (value: number) => (value === 0 ? "none" : `${value.toFixed(2)} em`);
const times = (value: number) => `${value.toFixed(2)}×`;

export interface DesignEditorProps {
  initial: EditingState<Design>;
  versions: VersionSummary[];
}

/**
 * The design editor: colours, fonts, text styles, buttons and spacing, with
 * the website itself beside the form showing every change as it is made.
 * Nothing reaches visitors until Publish.
 */
export function DesignEditor(props: DesignEditorProps) {
  // Kept here, outside the part that starts again after a publish, so that "Published." stays on screen.
  const [notice, setNotice] = useState("");
  return <DesignForm key={props.initial.revision} {...props} notice={notice} report={setNotice} />;
}

function DesignForm({ initial, versions, notice, report }: DesignEditorProps & { notice: string; report: (notice: string) => void }) {
  const editor = useDocumentEditor<Design>("design", initial, report);
  const design = editor.value;
  // Every change goes through parseDesign: it keeps numbers in range and moves a weight the newly chosen font lacks to the nearest it has.
  const update = (next: Design) => editor.change(parseDesign(next));
  const setHeading = (level: keyof Design["headings"], patch: Partial<HeadingStyle>) =>
    update({ ...design, headings: { ...design.headings, [level]: { ...design.headings[level], ...patch } } });
  const setBody = (patch: Partial<Design["body"]>) => update({ ...design, body: { ...design.body, ...patch } });
  const setButtons = (patch: Partial<Design["buttons"]>) => update({ ...design, buttons: { ...design.buttons, ...patch } });
  const setSpacing = (patch: Partial<Design["spacing"]>) => update({ ...design, spacing: { ...design.spacing, ...patch } });

  const checks = readabilityChecks(design);
  const notes = fontNotes(design);

  return (
    <div className="site-editor">
      <EditorBar editor={editor} notice={notice} previewPath="/" />
      <div className="editor-grid">
        <div className="editor-form">
          <Group title="Colours" open>
            {COLORS.map((color) => (
              <ColorField
                key={color.key}
                label={color.label}
                help={color.help}
                value={design.colors[color.key]}
                onChange={(value) => update({ ...design, colors: { ...design.colors, [color.key]: value } })}
              />
            ))}
          </Group>

          <Group title="Can it be read?" open>
            <p className="editor-hint">
              How strongly each kind of text stands out from what is behind it. Higher is easier to read; the number
              in brackets is what is usually asked for. This is advice: nothing here stops you from publishing.
            </p>
            <ul className="editor-checks">
              {checks.map((check) => (
                <li key={check.what} className={check.ok ? "ok" : "low"}>
                  <span>{check.what}</span>
                  <strong>
                    {check.ratio.toFixed(1)} to 1 {check.ok ? "· fine" : `· low (${check.needed} to 1 or more)`}
                  </strong>
                </li>
              ))}
              {notes.map((note) => (
                <li key={note} className="low">
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </Group>

          <Group title="Fonts">
            {FONT_ROLES.map((role) => {
              const font = findFont(design.fonts[role.key]);
              return (
                <div key={role.key} className="editor-font">
                  <SelectField
                    label={role.label}
                    help={role.help}
                    value={design.fonts[role.key]}
                    options={FONT_OPTIONS}
                    onChange={(value) => update({ ...design, fonts: { ...design.fonts, [role.key]: value } })}
                  />
                  {font && (
                    <p className="editor-sample" style={{ fontFamily: fontStack(font) }} aria-hidden="true">
                      {role.sample}
                    </p>
                  )}
                </div>
              );
            })}
            <p className="editor-hint">
              The fonts are served by this website itself. A font of your own, such as Horizon, can be added once you
              have its web font files and a licence that covers a website.
            </p>
          </Group>

          {HEADINGS.map((heading) => {
            const style = design.headings[heading.key];
            return (
              <Group title={heading.title} key={heading.key}>
                <RangeField label="Size on a computer" value={style.scale} limit={DESIGN_LIMITS.headingScale} show={percent} onChange={(scale) => setHeading(heading.key, { scale })} />
                <RangeField label="Size on a phone" value={style.scaleMobile} limit={DESIGN_LIMITS.headingScale} show={percent} onChange={(scaleMobile) => setHeading(heading.key, { scaleMobile })} />
                <SelectField label="Weight" value={style.weight} options={weightOptions(design.fonts[heading.font])} onChange={(weight) => setHeading(heading.key, { weight })} />
                <RangeField label="Space between letters" value={style.letterSpacing} limit={DESIGN_LIMITS.headingLetterSpacing} show={ems} onChange={(letterSpacing) => setHeading(heading.key, { letterSpacing })} />
                <RangeField label="Line height" value={style.lineHeight} limit={DESIGN_LIMITS.headingLineHeight} show={times} onChange={(lineHeight) => setHeading(heading.key, { lineHeight })} />
                <CheckField label="All capital letters" checked={style.uppercase} onChange={(uppercase) => setHeading(heading.key, { uppercase })} />
                <p className="editor-hint">100% is the size the page was designed with. These apply to the public pages; the booking steps and the admin keep their own sizes.</p>
              </Group>
            );
          })}

          <Group title="Running text">
            <RangeField label="Size on a computer" value={design.body.size} limit={DESIGN_LIMITS.bodySize} show={pixels} onChange={(size) => setBody({ size })} />
            <RangeField label="Size on a phone" value={design.body.sizeMobile} limit={DESIGN_LIMITS.bodySize} show={pixels} onChange={(sizeMobile) => setBody({ sizeMobile })} />
            <SelectField label="Weight" value={design.body.weight} options={weightOptions(design.fonts.body)} onChange={(weight) => setBody({ weight })} />
            <RangeField label="Line height" value={design.body.lineHeight} limit={DESIGN_LIMITS.bodyLineHeight} show={times} onChange={(lineHeight) => setBody({ lineHeight })} />
            <RangeField label="Space between letters" value={design.body.letterSpacing} limit={DESIGN_LIMITS.bodyLetterSpacing} show={ems} onChange={(letterSpacing) => setBody({ letterSpacing })} />
          </Group>

          <Group title="Buttons">
            <RangeField label="Text size" value={design.buttons.size} limit={DESIGN_LIMITS.buttonSize} show={pixels} onChange={(size) => setButtons({ size })} />
            <SelectField label="Weight" value={design.buttons.weight} options={weightOptions(design.fonts.button)} onChange={(weight) => setButtons({ weight })} />
            <RangeField label="Space between letters" value={design.buttons.letterSpacing} limit={DESIGN_LIMITS.buttonLetterSpacing} show={ems} onChange={(letterSpacing) => setButtons({ letterSpacing })} />
            <CheckField label="All capital letters" checked={design.buttons.uppercase} onChange={(uppercase) => setButtons({ uppercase })} />
            <RangeField label="Rounded corners" value={design.buttons.radius} limit={DESIGN_LIMITS.buttonRadius} show={(value) => (value === 0 ? "square" : pixels(value))} onChange={(radius) => setButtons({ radius })} />
            <RangeField label="Space above and below the words" value={design.buttons.padY} limit={DESIGN_LIMITS.buttonPadY} show={pixels} onChange={(padY) => setButtons({ padY })} />
            <RangeField label="Space left and right of the words" value={design.buttons.padX} limit={DESIGN_LIMITS.buttonPadX} show={pixels} onChange={(padX) => setButtons({ padX })} />
            <p className="editor-hint">On a phone a button is never shorter than a finger needs, whatever is set here.</p>
          </Group>

          <Group title="Spacing">
            <RangeField label="Space above and below each section, on a computer" value={design.spacing.section} limit={DESIGN_LIMITS.section} show={pixels} onChange={(section) => setSpacing({ section })} />
            <RangeField label="The same on a phone" value={design.spacing.sectionMobile} limit={DESIGN_LIMITS.section} show={pixels} onChange={(sectionMobile) => setSpacing({ sectionMobile })} />
          </Group>

          <History editor={editor} versions={versions} onOriginal={() => update(initial.original)} />
        </div>
        <PreviewPane path="/" css={designCss(design)} reload={0} />
      </div>
    </div>
  );
}
