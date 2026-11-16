"use client";

import { useState } from "react";
import { VIDEO_SERVICES, type Video } from "@/lib/site/video";

/**
 * A video on a page. Nothing is fetched from the video service until the
 * visitor presses play: until then it is a box with a button, so opening the
 * page tells YouTube or Vimeo nothing about the visitor, and costs nothing.
 */
export function VideoPlayer({ video, title }: { video: Video; title: string }) {
  const [playing, setPlaying] = useState(false);
  const service = VIDEO_SERVICES[video.service];
  if (!playing) {
    return (
      <button type="button" className="blk-video-start" onClick={() => setPlaying(true)}>
        <span className="blk-video-play" aria-hidden="true">
          ▶
        </span>
        <span>{title ? `Play the video: ${title}` : "Play the video"}</span>
        <small>It is played by {service}.</small>
      </button>
    );
  }
  return (
    <iframe
      src={video.player}
      title={title || `Video on ${service}`}
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}
