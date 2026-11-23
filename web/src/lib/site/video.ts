/**
 * A video on a page is played by the service that keeps it: nothing is
 * uploaded to this site, and nothing can be embedded from anywhere else.
 * `parseVideo` reads the address of a video on one of the services below and
 * gives the address of that service's player; anything else is not a video
 * here.
 */

export const VIDEO_SERVICES = { youtube: "YouTube", vimeo: "Vimeo", instagram: "Instagram" } as const;

/** "YouTube, Vimeo or Instagram". */
export const VIDEO_SERVICE_NAMES = (() => {
  const names: string[] = Object.values(VIDEO_SERVICES);
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
})();
export type VideoService = keyof typeof VIDEO_SERVICES;

export interface Video {
  service: VideoService;
  id: string;
  /** The player to put in a frame. YouTube's is the one that sets no cookie until the video is played. */
  player: string;
}

/** The video an address names, or null when it is not a video of a service the site plays. */
export function parseVideo(address: unknown): Video | null {
  if (typeof address !== "string") return null;
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  let youtube: string | null = null;
  if (host === "youtu.be") youtube = parts[0] ?? null;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") youtube = url.searchParams.get("v");
    else if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") youtube = parts[1] ?? null;
  }
  if (youtube && /^[A-Za-z0-9_-]{6,20}$/.test(youtube)) {
    return { service: "youtube", id: youtube, player: `https://www.youtube-nocookie.com/embed/${youtube}?autoplay=1&rel=0` };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = parts.find((part) => /^\d{6,12}$/.test(part));
    if (id) return { service: "vimeo", id, player: `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1` };
  }

  // A reel or a post of Instagram (the owners' third video source, question 22; the owner's answer of 2026-11-23 on
  // videos: "the reels are played directly from IG"): Instagram's own embed of it, played on the page, from Instagram.
  if (host === "instagram.com" || host === "instagr.am") {
    const kind = parts[0] === "reel" || parts[0] === "reels" || parts[0] === "tv" ? "reel" : parts[0] === "p" ? "p" : null;
    const code = parts[1] ?? "";
    if (kind && /^[A-Za-z0-9_-]{5,40}$/.test(code)) return { service: "instagram", id: code, player: `https://www.instagram.com/${kind}/${code}/embed/` };
  }
  return null;
}
