import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageBlocks } from "@/components/site/PageBlocks";
import { EMPTY_SITE } from "./block";
import { startProps } from "./fields";
import { BLOCKS } from "./registry";

const table = (props: Record<string, unknown>) =>
  renderToStaticMarkup(<PageBlocks blocks={[{ type: "Table", props: { ...startProps(BLOCKS.Table.fields), ...props, id: "t" } }]} site={EMPTY_SITE} />);

describe("the table block", () => {
  it("can be scrolled with the keyboard when it is wider than a phone, and says what it holds", () => {
    const html = table({
      columns: "4",
      first: "Studio",
      second: "Weekday",
      third: "Weekend",
      fourth: "",
      rows: [{ a: "Studio Blanche", b: "$88 an hour", c: "$110 an hour", d: "6 guests" }],
    });
    expect(html).toContain('<div class="blk blk-table-wrap" tabindex="0" role="region" aria-label="Table: Studio, Weekday, Weekend">');
    expect(table({ rows: [{ a: "One", b: "Two", c: "Three", d: "" }] })).toContain('aria-label="Table"');
  });
});
