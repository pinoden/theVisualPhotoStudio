import { Fragment, type ReactNode } from "react";
import type { SiteContext } from "@/lib/site/blocks/block";
import type { Fields, StoredBlock } from "@/lib/site/blocks/fields";
import { blockSpec } from "@/lib/site/blocks/registry";
import { fillLiveValues } from "@/lib/site/live-values";
import { sanitizeRichText } from "@/lib/site/rich-text";

/**
 * A page's blocks, drawn for visitors. A server component: the blocks'
 * drawings run here, and only their result reaches the browser.
 *
 * Each block gets its stored values with two changes, the same ones the page
 * editor makes: formatted text arrives as a ready element holding the cleaned
 * HTML (cleaned again here, whatever is stored), and a place for other
 * blocks arrives as something to render, which draws those blocks. And the
 * live values named in its text (`{refund window}`) are put in place, which
 * the editor does not do: there the owner sees the names they typed.
 */
function shownValues(fields: Fields, props: Record<string, unknown>, site: SiteContext): Record<string, unknown> {
  const out: Record<string, unknown> = { ...props };
  const values = site.values ?? {};
  for (const [name, field] of Object.entries(fields)) {
    const value = props[name];
    if (field.kind === "rich") {
      out[name] = <div className="rich-text" dangerouslySetInnerHTML={{ __html: fillLiveValues(sanitizeRichText(value), values, true) }} />;
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
      out[name] = Array.isArray(value) ? value.map((item) => shownValues(field.of, item as Record<string, unknown>, site)) : [];
    }
  }
  return out;
}

export function PageBlocks({ blocks, site }: { blocks: StoredBlock[]; site: SiteContext }): ReactNode {
  return blocks.map((block) => {
    const spec = blockSpec(block.type);
    if (!spec) return null;
    const values = { ...shownValues(spec.fields, block.props, site), id: block.props.id, site, editing: false };
    return <Fragment key={block.props.id}>{spec.render(values as never)}</Fragment>;
  });
}
