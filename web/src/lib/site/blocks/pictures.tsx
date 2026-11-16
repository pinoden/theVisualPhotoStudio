import Image from "next/image";
import type { CSSProperties } from "react";
import { VideoPlayer } from "@/components/site/VideoPlayer";
import type { Picture as LibraryPicture } from "@/server/media";
import { parseVideo, VIDEO_SERVICES } from "../video";
import { defineBlock } from "./block";
import { EditorNote, SiteAnchor } from "./shared";

/** The blocks that are pictures: one picture, a gallery of them, and a video. */

/** The shapes a picture can be cropped to, as width over height. "original" keeps the picture's own. */
const SHAPES = { original: "As it is", wide: "Wide (16:9)", photo: "Photo (3:2)", standard: "Standard (4:3)", square: "Square", tall: "Tall (4:5)" } as const;
const RATIO: Record<Exclude<keyof typeof SHAPES, "original">, string> = { wide: "16 / 9", photo: "3 / 2", standard: "4 / 3", square: "1 / 1", tall: "4 / 5" };
const FOCUS = { center: "The middle", top: "The top", bottom: "The bottom", left: "The left", right: "The right" } as const;

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
    source: { kind: "choice", label: "Which pictures", options: { chosen: "The pictures I choose here", collection: "A collection of the library" }, start: "chosen" },
    pictures: { kind: "pictures", label: "Pictures", max: 60 },
    collection: { kind: "collection", label: "Collection" },
    columns: { kind: "number", label: "How many side by side", min: 1, max: 6, start: 3, phone: true },
    shape: { kind: "choice", label: "Shape of each picture", options: { square: "Square", photo: "Photo (3:2)", tall: "Tall (4:5)", wide: "Wide (16:9)" }, start: "square" },
    gap: { kind: "choice", label: "Space between them", options: { normal: "Normal", small: "Small", none: "None" }, start: "normal" },
    captions: { kind: "toggle", label: "Show the words written for each in the library", start: false },
  },
  render: ({ source, pictures, collection, columns, columnsPhone, shape, gap, captions, site, editing }) => {
    const set = source === "collection" ? site.collections[collection] : undefined;
    if (source === "collection" && !set) {
      return <EditorNote editing={editing}>{collection ? "This collection is no longer in the library. Choose another." : "Gallery: choose a collection in the panel."}</EditorNote>;
    }
    // A collection outside its dates shows nothing to visitors. The editor shows it, with a note, so it can be arranged ahead of time.
    if (set && !set.shows && !editing) return null;
    const shown = (set ? set.pictures : pictures).map((id) => site.pictures[id]).filter((picture): picture is LibraryPicture => picture !== undefined);
    if (shown.length === 0) return <EditorNote editing={editing}>{set ? `The collection ${set.name} has no pictures yet.` : "Gallery: choose its pictures in the panel."}</EditorNote>;
    // On a phone: as many side by side as was chosen for phones, otherwise two at most.
    const style = { "--cols": columns, "--cols-phone": columnsPhone ?? Math.min(columns, 2), "--ratio": RATIO[shape] } as CSSProperties;
    return (
      <div className="blk blk-gallery-wrap">
        {set && !set.shows && <p className="blk-note">The collection {set.name} is outside its dates: visitors do not see this gallery now.</p>}
        <ul className="blk-gallery" data-gap={gap} style={style}>
          {shown.map((picture) => (
            <li key={picture.id}>
              <figure>
                <SiteAnchor href={picture.url} editing={editing}>
                  <Image src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes={`(max-width: 640px) ${Math.round(100 / (columnsPhone ?? Math.min(columns, 2)))}vw, ${Math.round(1200 / columns)}px`} />
                </SiteAnchor>
                {captions && picture.caption && <figcaption>{picture.caption}</figcaption>}
              </figure>
            </li>
          ))}
        </ul>
      </div>
    );
  },
});

export const Video = defineBlock({
  label: "Video",
  group: "pictures",
  fields: {
    address: { kind: "text", label: "Address of the video on YouTube or Vimeo", max: 300, start: "" },
    title: { kind: "text", label: "What the video shows, in a few words", max: 120, start: "" },
    shape: { kind: "choice", label: "Shape", options: { wide: "Wide (16:9)", standard: "Standard (4:3)", tall: "Upright (9:16)" }, start: "wide" },
  },
  render: ({ address, title, shape, editing }) => {
    const video = parseVideo(address);
    if (!video) {
      return (
        <EditorNote editing={editing}>
          {address ? `That is not the address of a video on ${Object.values(VIDEO_SERVICES).join(" or ")}.` : "Video: paste its address in the panel."}
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
            <small>It is played by {VIDEO_SERVICES[video.service]}. Visitors press play to start it.</small>
          </div>
        ) : (
          <VideoPlayer video={video} title={title} />
        )}
      </div>
    );
  },
});
