import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import { EMPTY_SITE } from "./block";
import { startProps, type StoredBlock } from "./fields";
import { BLOCKS } from "./registry";

/** The Video block with an Instagram reel (the owner's answer of 2026-11-23: "the reels are played directly from IG"). */
const video = (props: Record<string, unknown>): StoredBlock => ({ type: "Video", props: { ...startProps(BLOCKS.Video.fields), ...props, id: "Video-1" } });
const drawn = (blocks: StoredBlock[]) => renderToStaticMarkup(<PageBlocks blocks={blocks} site={EMPTY_SITE} />);

describe("a reel of Instagram in the Video block", () => {
  it("is a button until the visitor presses play: nothing of Instagram loads with the page", () => {
    const html = drawn([video({ address: "https://www.instagram.com/reel/C9xYz_ab-12/", title: "A day in Studio Paris", shape: "tall" })]);
    expect(html).toContain('<div class="blk blk-video" data-shape="tall">');
    expect(html).toContain("Play the video: A day in Studio Paris");
    expect(html).toContain("It is played by Instagram.");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("instagram.com");
  });

  it("is nothing for visitors when the address is not a video of the three services", () => {
    expect(drawn([video({ address: "https://www.instagram.com/some.account/" })])).toBe("");
  });
});
