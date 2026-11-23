import Image from "next/image";
import type { CSSProperties } from "react";
import { PictureRow } from "@/components/site/PictureRow";
import { VideoPlayer } from "@/components/site/VideoPlayer";
import type { Picture as LibraryPicture } from "@/server/media";
import { parseVideo, VIDEO_SERVICE_NAMES, VIDEO_SERVICES } from "../video";
import { cssVars, defineBlock } from "./block";
import { EditorNote, SiteAnchor } from "./shared";

/** The blocks that are pictures: one picture, a gallery of them, a slideshow, a row of logos, and a video. */

/** The shapes a picture can be cropped to, as width over height. "original" keeps the picture's own. */
const SHAPES = { original: "As it is", wide: "Wide (16:9)", photo: "Photo (3:2)", standard: "Standard (4:3)", square: "Square", tall: "Tall (4:5)" } as const;
const RATIO: Record<Exclude<keyof typeof SHAPES, "original">, string> = { wide: "16 / 9", photo: "3 / 2", standard: "4 / 3", square: "1 / 1", tall: "4 / 5" };
/** What stays in view of a picture that is cropped: a word CSS's `object-position` takes as it is. */
export const FOCUS = { center: "The middle", top: "The top", bottom: "The bottom", left: "The left", right: "The right" } as const;

const ratioOf = (shape: keyof typeof SHAPES, picture: LibraryPicture) => (shape === "original" ? `${picture.width} / ${picture.height}` : RATIO[shape]);

export const Picture = defineBlock({
  label: "Picture",
  group: "pictures",
  fields: {
    picture: { kind: "picture", label: "Picture" },
    shape: { kind: "choice", label: "Shape", options: SHAPES, start: "original", phone: true },
    focus: { kind: "choice", label: "What stays in view when it is cropped", options: FOCUS, start: "center", phone: true },
    size: { kind: "choice", label: "How wide", options: { full: "As wide as its place", large: "Three quarters", half: "Half" }, start: "full" },
    corners: { kind: "choice", label: "Corners", options: { square: "Square", soft: "Slightly rounded", round: "Rounded" }, start: "square" },
    caption: { kind: "toggle", label: "Show the words written for it in the library", start: false },
    link: { kind: "link", label: "Where pressing it leads (optional)", start: "" },
  },
  render: ({ picture, shape, shapePhone, focus, focusPhone, size, corners, caption, link, site, editing }) => {
    const found = site.pictures[picture];
    if (!found) return <EditorNote editing={editing}>{picture ? "This picture is no longer in the library. Choose another." : "Picture: choose one in the panel."}</EditorNote>;
    const style = {
      "--ratio": ratioOf(shape, found),
      ...(shapePhone ? { "--ratio-phone": ratioOf(shapePhone, found) } : {}),
      "--focus": focus,
      ...(focusPhone ? { "--focus-phone": focusPhone } : {}),
    } as CSSProperties;
    const image = (
      <Image
        src={found.url}
        width={found.width}
        height={found.height}
        alt={found.alt}
        sizes={size === "half" ? "(max-width: 640px) 100vw, 600px" : "(max-width: 1200px) 100vw, 1200px"}
        quality={85}
      />
    );
    return (
      <figure className={`blk blk-picture blk-corners-${corners}`} data-size={size} style={style}>
        {link ? (
          <SiteAnchor href={link} editing={editing}>
            {image}
          </SiteAnchor>
        ) : (
          image
        )}
        {caption && found.caption && <figcaption>{found.caption}</figcaption>}
      </figure>
    );
  },
});

export const Gallery = defineBlock({
  label: "Gallery",
  group: "pictures",
  fields: {
    source: {
      kind: "choice",
      label: "Which pictures",
      options: { chosen: "The pictures I choose here", collection: "A collection of the library", photography: "The photos chosen under Admin → Photography" },
      start: "chosen",
    },
    pictures: { kind: "pictures", label: "Pictures", max: 60 },
    collection: { kind: "collection", label: "Collection" },
    layout: {
      kind: "choice",
      label: "How they are laid out",
      options: { grid: "In rows, all of them at once", row: "In one row that scrolls sideways, with arrows" },
      start: "grid",
    },
    columns: { kind: "number", label: "How many side by side", min: 1, max: 6, start: 3, phone: true },
    shape: { kind: "choice", label: "Shape of each picture", options: { square: "Square", photo: "Photo (3:2)", tall: "Tall (4:5)", wide: "Wide (16:9)" }, start: "square" },
    gap: { kind: "choice", label: "Space between them", options: { normal: "Normal", small: "Small", none: "None" }, start: "normal" },
    captions: { kind: "toggle", label: "Show the words written for each in the library", start: false },
  },
  render: ({ source, pictures, collection, layout, columns, columnsPhone, shape, gap, captions, site, editing }) => {
    const set = source === "collection" ? site.collections[collection] : undefined;
    if (source === "collection" && !set) {
      return <EditorNote editing={editing}>{collection ? "This collection is no longer in the library. Choose another." : "Gallery: choose a collection in the panel."}</EditorNote>;
    }
    // A collection outside its dates shows nothing to visitors. The editor shows it, with a note, so it can be arranged ahead of time.
    if (set && !set.shows && !editing) return null;
    const photography = source === "photography";
    const ids = photography ? (site.photography ?? []) : set ? set.pictures : pictures;
    const shown = ids.map((id) => site.pictures[id]).filter((picture): picture is LibraryPicture => picture !== undefined);
    if (shown.length === 0) {
      return (
        <EditorNote editing={editing}>
          {photography ? "No photos are chosen under Admin → Photography yet." : set ? `The collection ${set.name} has no pictures yet.` : "Gallery: choose its pictures in the panel."}
        </EditorNote>
      );
    }
    // On a phone: as many side by side as was chosen for phones; otherwise two at most in rows, and one at a time in a
    // row that scrolls, as the old website showed its portfolio.
    const onPhone = columnsPhone ?? (layout === "row" ? 1 : Math.min(columns, 2));
    const items = shown.map((picture) => (
      <li key={picture.id}>
        <figure>
          <SiteAnchor href={picture.url} editing={editing}>
            <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes={`(max-width: 640px) ${Math.round(100 / onPhone)}vw, ${Math.round(1200 / columns)}px`} />
          </SiteAnchor>
          {captions && picture.caption && <figcaption>{picture.caption}</figcaption>}
        </figure>
      </li>
    ));
    return (
      <div className="blk blk-gallery-wrap">
        {set && !set.shows && <p className="blk-note">The collection {set.name} is outside its dates: visitors do not see this gallery now.</p>}
        {layout === "row" ? (
          <PictureRow label={set ? set.name : photography ? "Photography" : "Pictures"} columns={columns} columnsPhone={onPhone} ratio={RATIO[shape]} gap={gap} count={shown.length} listClassName="blk-gallery-row">
            {items}
          </PictureRow>
        ) : (
          <ul className="blk-gallery" data-gap={gap} style={{ "--cols": columns, "--cols-phone": onPhone, "--ratio": RATIO[shape] } as CSSProperties}>
            {items}
          </ul>
        )}
      </div>
    );
  },
});

/**
 * Pictures across the page one at a time, each with its own words and button
 * over it, and arrows to go from one to the next: the old website's home page
 * opened with its three studios this way (the owner, 2026-11-19). It is the
 * sideways row (`PictureRow`) with one slide in view, so a finger swipes it
 * on a phone, and the arrows go from the last slide back to the first. It
 * does not move by itself, as the old one did not.
 */
export const Slideshow = defineBlock({
  label: "Slideshow",
  group: "pictures",
  fields: {
    slides: {
      kind: "list",
      label: "Slides",
      max: 8,
      title: "title",
      of: {
        picture: { kind: "picture", label: "Picture" },
        focus: { kind: "choice", label: "What stays in view of the picture", options: FOCUS, start: "center" },
        title: { kind: "text", label: "Title", max: 80, start: "" },
        text: { kind: "text", label: "Words under the title, in italics: each line on its own", max: 200, start: "", lines: true },
        buttonLabel: { kind: "text", label: "Words on the button", max: 40, start: "Book Now" },
        buttonLink: { kind: "link", label: "Where it leads", start: "/book" },
      },
      start: [],
    },
    shade: {
      kind: "choice",
      label: "Over the pictures",
      options: { light: "A pale veil, with dark words", dark: "A dark shade, with white words" },
      start: "light",
    },
  },
  render: ({ slides, shade, site, editing }) => {
    // A slide whose picture left the library is not shown.
    const shown = slides.flatMap((slide) => {
      const picture = slide.picture ? site.pictures[slide.picture] : undefined;
      return picture ? [{ ...slide, picture }] : [];
    });
    if (shown.length === 0) return <EditorNote editing={editing}>Slideshow: add its slides in the panel, each with a picture.</EditorNote>;
    return (
      <section className="blk blk-slideshow" data-shade={shade}>
        <PictureRow
          label="Slideshow"
          columns={1}
          columnsPhone={1}
          ratio="auto"
          gap="none"
          count={shown.length}
          listClassName="slideshow-list"
          backLabel="Previous slide"
          nextLabel="Next slide"
        >
          {shown.map((slide, index) => (
            <li key={index} className="slide" aria-label={`${index + 1} of ${shown.length}`}>
              {/* Every slide's picture is asked for at once, so that the next is there when an arrow moves to it; the first before the others. */}
              <Image
                className="slide-picture"
                src={slide.picture.url}
                alt={slide.picture.alt}
                fill
                sizes="100vw"
                quality={75}
                loading="eager"
                fetchPriority={index === 0 ? "high" : undefined}
                style={cssVars({ focus: [slide.focus] })}
              />
              <div className="slide-content">
                {slide.title && <h2>{slide.title}</h2>}
                {slide.text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "")
                  .map((line, n) => (
                    <p key={n}>
                      <em>{line}</em>
                    </p>
                  ))}
                {slide.buttonLabel && (slide.buttonLink !== "" || editing) && (
                  <SiteAnchor href={slide.buttonLink} editing={editing} className="btn btn-outline">
                    {slide.buttonLabel}
                  </SiteAnchor>
                )}
              </div>
            </li>
          ))}
        </PictureRow>
      </section>
    );
  },
});

/**
 * The logos of the brands the studio has worked for, all as tall as each
 * other, in a row that wraps on a narrow screen. Each is a picture of the
 * library, named by what the library says it shows: the brand's name.
 */
export const Logos = defineBlock({
  label: "Logos",
  group: "pictures",
  fields: {
    logos: { kind: "pictures", label: "Logos, from the library", max: 24 },
    height: { kind: "choice", label: "How tall", options: { medium: "Medium", small: "Small", large: "Large" }, start: "medium" },
    look: { kind: "choice", label: "Colours", options: { own: "Their own colours", grey: "In grey" }, start: "own" },
  },
  render: ({ logos, height, look, site, editing }) => {
    const shown = logos.map((id) => site.pictures[id]).filter((picture): picture is LibraryPicture => picture !== undefined);
    if (shown.length === 0) {
      return <EditorNote editing={editing}>Logos: choose their pictures in the panel. In the library, say what each shows: the brand&rsquo;s name.</EditorNote>;
    }
    return (
      <ul className="blk blk-logos" data-height={height} data-look={look}>
        {shown.map((picture) => (
          <li key={picture.id}>
            <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes="(max-width: 640px) 45vw, 320px" />
          </li>
        ))}
      </ul>
    );
  },
});

export const Video = defineBlock({
  label: "Video",
  group: "pictures",
  fields: {
    address: {
      kind: "text",
      label: "Address of the video on YouTube, Vimeo or Instagram (a reel or a post), or of a video of the media library (/videos/…)",
      max: 300,
      start: "",
    },
    title: { kind: "text", label: "What the video shows, in a few words", max: 120, start: "" },
    shape: { kind: "choice", label: "Shape", options: { wide: "Wide (16:9)", standard: "Standard (4:3)", tall: "Upright (9:16)" }, start: "wide" },
  },
  render: ({ address, title, shape, editing }) => {
    const video = parseVideo(address);
    if (!video) {
      return (
        <EditorNote editing={editing}>
          {address ? `That is not the address of a video on ${VIDEO_SERVICE_NAMES}, nor of one of the media library's videos.` : "Video: paste its address in the panel."}
        </EditorNote>
      );
    }
    return (
      <div className="blk blk-video" data-shape={shape}>
        {editing ? (
          <div className="blk-video-start">
            <span className="blk-video-play" aria-hidden="true">
              ▶
            </span>
            <span>{title || "A video"}</span>
            <small>{video.service === "file" ? "A video of the media library." : `It is played by ${VIDEO_SERVICES[video.service]}.`} Visitors press play to start it.</small>
          </div>
        ) : (
          <VideoPlayer video={video} title={title} />
        )}
      </div>
    );
  },
});
