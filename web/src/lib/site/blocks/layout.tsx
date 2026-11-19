import Image from "next/image";
import { cssVars, defineBlock } from "./block";
import { FOCUS } from "./pictures";
import { anchorId, SiteAnchor } from "./shared";
import { BUTTON_CLASS, BUTTON_LOOKS } from "./text";

/** The blocks that arrange a page: a title band, a section across it, columns side by side, and space between things. */

export const Banner = defineBlock({
  label: "Title band",
  group: "layout",
  fields: {
    look: {
      kind: "choice",
      label: "Look",
      options: { page: "A page's title band, across the top", hero: "Large, filling the screen: for the home page" },
      start: "page",
    },
    eyebrow: { kind: "text", label: "A few small words above the title", max: 80, start: "" },
    title: { kind: "text", label: "Title", max: 120, start: "The page's title", inline: true },
    accent: { kind: "text", label: "Words on a line of their own under the title, in italics", max: 120, start: "" },
    text: { kind: "text", label: "A sentence or two under it", max: 400, start: "", lines: true },
    buttons: {
      kind: "list",
      label: "Buttons",
      max: 3,
      title: "label",
      of: {
        label: { kind: "text", label: "Words on the button", max: 40, start: "Book a Studio" },
        link: { kind: "link", label: "Where it leads", start: "/book" },
        look: { kind: "choice", label: "Look", options: BUTTON_LOOKS, start: "dark" },
      },
      start: [],
    },
    // A picture across the whole band, the words over it, as the old website's home page and price page had: the band
    // is then darkened under the words, which turn white.
    picture: { kind: "picture", label: "A picture behind it (optional)" },
    focus: { kind: "choice", label: "What stays in view of the picture", options: FOCUS, start: "center", phone: true },
  },
  render: ({ look, eyebrow, title, accent, text, buttons, picture, focus, focusPhone, site, editing }) => {
    const shown = buttons.filter((button) => button.label !== "" && (button.link !== "" || editing));
    const behind = picture ? site.pictures[picture] : undefined;
    // The first thing a visitor sees: asked for at once, not when it is scrolled to.
    const backdrop = behind && (
      <Image
        className="blk-banner-picture"
        src={behind.url}
        alt={behind.alt}
        fill
        sizes="100vw"
        quality={80}
        loading="eager"
        fetchPriority="high"
        style={cssVars({ focus: [focus, focusPhone || null] })}
      />
    );
    const inside = (
      <>
        {eyebrow && <p className={look === "hero" ? "hero-eyebrow" : "section-eyebrow"}>{eyebrow}</p>}
        <h1>
          {title}
          {accent && (
            <>
              <br />
              <em>{accent}</em>
            </>
          )}
        </h1>
        {text && <p className="blk-banner-text">{text}</p>}
        {shown.length > 0 && (
          <div className="blk-buttons">
            {shown.map((button, index) => (
              <SiteAnchor key={index} href={button.link} editing={editing} className={`btn ${BUTTON_CLASS[button.look]}`}>
                {button.label}
              </SiteAnchor>
            ))}
          </div>
        )}
      </>
    );
    const pictured = backdrop ? " has-picture" : "";
    return look === "hero" ? (
      <section className={`blk blk-banner hero${pictured}`}>
        {backdrop}
        <div className="hero-content">{inside}</div>
      </section>
    ) : (
      <div className={`blk blk-banner page-banner${pictured}`}>
        {backdrop}
        {backdrop ? <div className="page-banner-content">{inside}</div> : inside}
      </div>
    );
  },
});

export const Section = defineBlock({
  label: "Section",
  group: "layout",
  fields: {
    content: { kind: "slot" },
    background: {
      kind: "choice",
      label: "Background",
      options: { page: "The page's colour", card: "The cards' colour", soft: "Pale accent", dark: "Dark" },
      start: "page",
    },
    width: {
      kind: "choice",
      label: "How wide what is inside may be",
      options: { wide: "Wide", narrow: "Narrow, for reading", full: "Edge to edge" },
      start: "wide",
    },
    space: {
      kind: "choice",
      label: "Space above and below",
      options: { normal: "As the design sets it", small: "Less", large: "More", none: "None" },
      start: "normal",
      phone: true,
    },
    anchor: { kind: "text", label: "A name to link to: what comes after # in an address", max: 40, start: "" },
  },
  render: ({ content: Content, background, width, space, spacePhone, anchor }) => (
    <section id={anchorId(anchor)} className={`section blk-section blk-bg-${background}`} data-space={space} data-space-phone={spacePhone || undefined}>
      <Content className={`blk-stack blk-width-${width}`} />
    </section>
  ),
});

export const Columns = defineBlock({
  label: "Columns",
  group: "layout",
  fields: {
    count: { kind: "choice", label: "How many columns", options: { "2": "Two", "3": "Three", "4": "Four" }, start: "2" },
    shape: {
      kind: "choice",
      label: "Their widths",
      options: { even: "All the same", first: "The first wider", last: "The last wider" },
      start: "even",
    },
    gap: { kind: "choice", label: "Space between them", options: { normal: "Normal", small: "Small", large: "Large", none: "None" }, start: "normal" },
    middle: {
      kind: "choice",
      label: "Where a shorter column sits",
      options: { start: "At the top", center: "In the middle", end: "At the bottom" },
      start: "start",
    },
    onPhone: {
      kind: "choice",
      label: "On a phone",
      options: { stack: "One under the other", reverse: "One under the other, the last first", keep: "Side by side" },
      start: "stack",
    },
    one: { kind: "slot" },
    two: { kind: "slot" },
    three: { kind: "slot" },
    four: { kind: "slot" },
  },
  // A column that is not shown keeps what was put into it, for when the number of columns goes up again.
  render: ({ count, shape, gap, middle, onPhone, one: One, two: Two, three: Three, four: Four }) => (
    <div className="blk blk-columns" data-count={count} data-shape={shape} data-gap={gap} data-middle={middle} data-phone={onPhone}>
      <One className="blk-stack" />
      <Two className="blk-stack" />
      {count !== "2" && <Three className="blk-stack" />}
      {count === "4" && <Four className="blk-stack" />}
    </div>
  ),
});

export const Spacer = defineBlock({
  label: "Space",
  group: "layout",
  fields: {
    height: { kind: "number", label: "Height, in pixels", min: 8, max: 240, step: 8, start: 48, phone: true },
  },
  render: ({ height, heightPhone }) => <div className="blk blk-spacer" aria-hidden="true" style={cssVars({ h: [`${height}px`, heightPhone === null ? null : `${heightPhone}px`] })} />,
});

export const Divider = defineBlock({
  label: "Line",
  group: "layout",
  fields: {
    look: { kind: "choice", label: "Look", options: { accent: "A short line in the accent colour", full: "A thin line across" }, start: "accent" },
  },
  render: ({ look }) => <div className={`blk blk-divider blk-divider-${look}`} role="separator" />,
});
