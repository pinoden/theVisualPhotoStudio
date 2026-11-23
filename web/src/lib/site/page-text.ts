import type { SiteContext } from "./blocks/block";
import type { StoredBlock } from "./blocks/fields";
import { blockSpec } from "./blocks/registry";
import { whenHolds } from "./conditions";
import { fillLiveValues } from "./live-values";
import { showRichText } from "./rich-text";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A page's words as HTML, for reading them elsewhere than on the page: its headings and its formatted text, with the
 * live values filled in and the parts whose condition does not hold left out, as the page shows them (`PageBlocks`).
 * Pictures, buttons and banners are left out. The booking pages' policies step reads the Policies page this way (the
 * owner's brief of 2026-11-22, item 6): as one string, it reaches the booking screen whole, where a tree of the page's
 * blocks would lose their keys on the way (React's warning, 2026-11-22). The formatted text is the page's own,
 * cleaned when it was saved (src/lib/site/rich-text.ts).
 */
export function pageTextHtml(blocks: StoredBlock[], site: SiteContext): string {
  const values = site.values ?? {};
  let html = "";
  for (const block of blocks) {
    const spec = blockSpec(block.type);
    if (!spec || block.type === "Banner" || !whenHolds(block.props.when, site.conditions)) continue;
    if (block.type === "Heading") {
      const text = fillLiveValues(typeof block.props.text === "string" ? block.props.text : "", values).trim();
      if (text) html += `<h3>${escape(text)}</h3>`;
      continue;
    }
    for (const [name, field] of Object.entries(spec.fields)) {
      const value = block.props[name];
      if (field.kind === "rich") html += fillLiveValues(showRichText(value, site.conditions), values, true);
      else if (field.kind === "slot" && Array.isArray(value)) html += pageTextHtml(value as StoredBlock[], site);
    }
  }
  return html;
}
