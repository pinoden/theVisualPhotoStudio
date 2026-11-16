import { defineBlock } from "./block";
import { paragraphs } from "../paragraphs";
import { ALIGN, EditorNote, SiteAnchor } from "./shared";

/** The blocks that are words: a heading, running text, buttons, small cards, and questions with their answers. */

export const BUTTON_LOOKS = { dark: "Dark", accent: "Accent colour", outline: "Outline", ghost: "Outline in the accent colour" } as const;
export const BUTTON_CLASS: Record<keyof typeof BUTTON_LOOKS, string> = { dark: "btn-dark", accent: "btn-primary", outline: "btn-outline", ghost: "btn-ghost" };

export const Heading = defineBlock({
  label: "Heading",
  group: "text",
  fields: {
    text: { kind: "text", label: "Heading", max: 200, start: "A new heading", inline: true },
    level: {
      kind: "choice",
      label: "What kind of heading",
      options: { h2: "Heading of a section", h1: "Title of the page (one on a page)", h3: "Smaller heading", h4: "Smallest heading" },
      start: "h2",
    },
    size: { kind: "choice", label: "Size", options: { normal: "Normal", small: "Smaller, as within running text", large: "Larger" }, start: "normal" },
    eyebrow: { kind: "text", label: "A few small words above it", max: 80, start: "" },
    line: { kind: "toggle", label: "A short line under it", start: false },
    align: { kind: "choice", label: "Where it sits", options: ALIGN, start: "center", phone: true },
  },
  render: ({ text, level: Level, size, eyebrow, line, align, alignPhone }) => (
    <div className="blk blk-heading" data-size={size} data-align={align} data-align-phone={alignPhone || undefined}>
      {eyebrow && <p className="section-eyebrow">{eyebrow}</p>}
      <Level>{text}</Level>
      {line && <div className="divider" />}
    </div>
  ),
});

export const Text = defineBlock({
  label: "Text",
  group: "text",
  fields: {
    text: { kind: "rich", label: "Text", start: paragraphs("Write here. Mark words to make them bold or a link.") },
    size: { kind: "choice", label: "Size", options: { normal: "Normal", small: "Small", large: "Large" }, start: "normal" },
    width: { kind: "choice", label: "How wide it may be", options: { full: "As wide as its place", narrow: "Narrow, for reading" }, start: "full" },
  },
  render: ({ text, size, width }) => (
    <div className={`blk blk-text blk-text-${size}`} data-width={width}>
      {text}
    </div>
  ),
});

export const Buttons = defineBlock({
  label: "Buttons",
  group: "text",
  fields: {
    buttons: {
      kind: "list",
      label: "Buttons",
      max: 4,
      title: "label",
      of: {
        label: { kind: "text", label: "Words on the button", max: 40, start: "Book a Studio" },
        link: { kind: "link", label: "Where it leads", start: "/book" },
        look: { kind: "choice", label: "Look", options: BUTTON_LOOKS, start: "dark" },
      },
      start: [{}],
    },
    align: { kind: "choice", label: "Where they sit", options: ALIGN, start: "center", phone: true },
  },
  render: ({ buttons, align, alignPhone, editing }) => {
    const shown = buttons.filter((button) => button.label !== "" && (button.link !== "" || editing));
    if (shown.length === 0) return <EditorNote editing={editing}>Buttons: none has both its words and a link yet.</EditorNote>;
    return (
      <div className="blk blk-buttons" data-align={align} data-align-phone={alignPhone || undefined}>
        {shown.map((button, index) => (
          <SiteAnchor key={index} href={button.link} editing={editing} className={`btn ${BUTTON_CLASS[button.look]}`}>
            {button.label}
          </SiteAnchor>
        ))}
      </div>
    );
  },
});

export const Cards = defineBlock({
  label: "Cards",
  group: "text",
  fields: {
    cards: {
      kind: "list",
      label: "Cards",
      max: 12,
      title: "title",
      of: {
        symbol: { kind: "text", label: "A sign above it", max: 4, start: "✦" },
        title: { kind: "text", label: "Title", max: 80, start: "A title" },
        text: { kind: "text", label: "Text", max: 400, start: "A sentence or two.", lines: true },
      },
      start: [{}, {}, {}],
    },
    columns: { kind: "number", label: "How many side by side", min: 1, max: 4, start: 3, phone: true },
    look: { kind: "choice", label: "Look", options: { plain: "Plain", boxed: "In boxes" }, start: "plain" },
  },
  render: ({ cards, columns, columnsPhone, look, editing }) => {
    if (cards.length === 0) return <EditorNote editing={editing}>Cards: add the first one in the panel.</EditorNote>;
    return (
      <div className={`blk blk-cards blk-cards-${look}`} style={{ "--cols": columns, ...(columnsPhone === null ? {} : { "--cols-phone": columnsPhone }) } as React.CSSProperties}>
        {cards.map((card, index) => (
          <div className="blk-card" key={index}>
            {card.symbol && (
              <div className="blk-card-symbol" aria-hidden="true">
                {card.symbol}
              </div>
            )}
            {card.title && <h4>{card.title}</h4>}
            {card.text && <p>{card.text}</p>}
          </div>
        ))}
      </div>
    );
  },
});

export const Questions = defineBlock({
  label: "Questions and answers",
  group: "text",
  fields: {
    questions: {
      kind: "list",
      label: "Questions",
      max: 60,
      title: "question",
      of: {
        question: { kind: "text", label: "Question", max: 200, start: "A question?" },
        answer: { kind: "rich", label: "Answer", start: paragraphs("Its answer.") },
      },
      start: [{}],
    },
  },
  render: ({ questions, editing }) => {
    if (questions.length === 0) return <EditorNote editing={editing}>Questions and answers: add the first one in the panel.</EditorNote>;
    return (
      <div className="blk blk-questions">
        {questions.map((entry, index) => (
          // In the editor every answer is open, so that it can be read and changed.
          <details className="faq-item" key={index} open={editing || undefined}>
            <summary className="faq-question">
              {entry.question}
              <span className="faq-icon" aria-hidden="true">
                +
              </span>
            </summary>
            <div className="faq-answer">{entry.answer}</div>
          </details>
        ))}
      </div>
    );
  },
});

export const Table = defineBlock({
  label: "Table",
  group: "text",
  fields: {
    columns: { kind: "choice", label: "How many columns", options: { "3": "Three", "2": "Two", "4": "Four" }, start: "3" },
    first: { kind: "text", label: "Heading of the first column", max: 40, start: "" },
    second: { kind: "text", label: "Heading of the second column", max: 40, start: "" },
    third: { kind: "text", label: "Heading of the third column", max: 40, start: "" },
    fourth: { kind: "text", label: "Heading of the fourth column", max: 40, start: "" },
    rows: {
      kind: "list",
      label: "Rows",
      max: 40,
      title: "a",
      of: {
        a: { kind: "text", label: "First column", max: 120, start: "" },
        b: { kind: "text", label: "Second column", max: 120, start: "" },
        c: { kind: "text", label: "Third column", max: 120, start: "" },
        d: { kind: "text", label: "Fourth column", max: 120, start: "" },
      },
      start: [{}],
    },
  },
  render: ({ columns, first, second, third, fourth, rows, editing }) => {
    const count = Number(columns);
    const heads = [first, second, third, fourth].slice(0, count);
    const shown = rows.filter((row) => [row.a, row.b, row.c, row.d].slice(0, count).some((cell) => cell !== ""));
    if (shown.length === 0) return <EditorNote editing={editing}>Table: write its rows in the panel.</EditorNote>;
    return (
      <div className="blk blk-table-wrap">
        <table className="price-table blk-table">
          {heads.some((head) => head !== "") && (
            <thead>
              <tr>
                {heads.map((head, index) => (
                  <th scope="col" key={index}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                {[row.a, row.b, row.c, row.d].slice(0, count).map((cell, column) => (
                  <td key={column}>{column === 0 ? <strong style={{ color: "var(--color-dark)" }}>{cell}</strong> : cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});
