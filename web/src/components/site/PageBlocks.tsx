import { Fragment, type ReactNode } from "react";
import type { SiteContext } from "@/lib/site/blocks/block";
import type { Fields, StoredBlock } from "@/lib/site/blocks/fields";
import { blockSpec } from "@/lib/site/blocks/registry";
import { shownWords, whenHolds } from "@/lib/site/conditions";
import { fillLiveValues } from "@/lib/site/live-values";
import { showRichText } from "@/lib/site/rich-text";

/**
 * A page's blocks, drawn for visitors. A server component: the blocks'
 * drawings run here, and only their result reaches the browser.
 *
 * Each block gets its stored values with two changes, the same ones the page
 * editor makes: formatted text arrives as a ready element holding the cleaned
 * HTML (cleaned again here, whatever is stored), and a place for other
 * blocks arrives as something to render, which draws those blocks. Then two
 * things the editor does not do, where the owner sees what they typed: the
 * live values named in the text (`{refund window}`) are put in place, and
 * what shows only at times (src/lib/site/conditions.ts) is left out while its
 * condition does not hold: a block by its "Show it", a piece of formatted
 * text, or an item of a list (a question, a card, a button, a row) by the
 * marker its words start with.
 */
function shownValues(fields: Fields, props: Record<string, unknown>, site: SiteContext): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  const values = site.values ?? {};
  for (const [name, field] of Object.entries(fields)) {
    const value = props[name];
    if (field.kind === "rich") {
      out[name] = <div className="rich-text" dangerouslySetInnerHTML={{ __html: fillLiveValues(showRichText(value, site.conditions), values, true) }} />;
    } else if (field.kind === "text" && typeof value === "string") {
      out[name] = fillLiveValues(value, values);
    } else if (field.kind === "slot") {
      const inner = Array.isArray(value) ? (value as StoredBlock[]) : [];
      out[name] = function Slot({ className }: { className?: string }) {
        return (
          <div className={className}>
            <PageBlocks blocks={inner} site={site} />
          </div>
        );
      };
    } else if (field.kind === "list") {
      const items: Record<string, unknown>[] = [];
      for (const item of Array.isArray(value) ? (value as Record<string, unknown>[]) : []) {
        // An item whose title starts with a marker shows only while its condition holds, and never shows the marker.
        const title = item[field.title];
        const words = typeof title === "string" ? shownWords(title, site.conditions) : title;
        if (words === null) continue;
        items.push(shownValues(field.of, { ...item, [field.title]: words }, site));
      }
      out[name] = items;
    }
  }
  return out;
}

export function PageBlocks({ blocks, site }: { blocks: StoredBlock[]; site: SiteContext }): ReactNode {
  return blocks.map((block) => {
    const spec = blockSpec(block.type);
    if (!spec || !whenHolds(block.props.when, site.conditions)) return null;
    const values = { ...shownValues(spec.fields, block.props, site), id: block.props.id, site, editing: false };
    return <Fragment key={block.props.id}>{spec.render(values as never)}</Fragment>;
  });
}
