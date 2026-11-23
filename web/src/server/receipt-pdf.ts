import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import { durationLabel } from "@/lib/domain/time";
import type { Business } from "@/lib/site/frame";
import type { AcceptedText } from "./booking-forms";
import { RECEIPT_STATUS_TEXT, REFUND_STATE_WORDS, type Receipt, type YearStatement } from "./receipts";
import { formatDay, formatInstant, formatRange } from "./tz";

/**
 * Receipts as PDF files: one receipt, or every receipt of a calendar year
 * behind a page that sums the year up. Drawn from the same `Receipt` the
 * screen shows, so a file and the page can never disagree. And the policies or
 * an agreement a client accepted at checkout, from the same words its page shows.
 *
 * The fonts are the ones every PDF reader has built in, which keeps the files
 * small and needs nothing installed on the server. They know Western European
 * letters only, so `pdfSafe` writes anything else as its plain letter, or as a
 * question mark.
 */

const PAGE = { width: 612, height: 792 }; // US Letter, in points
const MARGIN = 54;
const WIDTH = PAGE.width - 2 * MARGIN;
const INK = rgb(0.17, 0.14, 0.13);
const SOFT = rgb(0.48, 0.43, 0.41);
const LINE = rgb(0.85, 0.82, 0.78);

/** The punctuation and letters of Windows-1252 that sit outside Latin-1. */
const ALSO_KNOWN = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
/** Letters that are not a plain letter with a mark, so nothing takes the mark off for us. */
const PLAIN_LETTER: Record<string, string> = { Ł: "L", ł: "l", Đ: "D", đ: "d", ı: "i", Ħ: "H", ħ: "h", Ŧ: "T", ŧ: "t" };

/** Text the built-in fonts can draw: an unknown letter keeps its base letter, anything else becomes "?". */
export function pdfSafe(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += " ";
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || ALSO_KNOWN.includes(char)) out += char;
    else if (code === 0xa0) out += " ";
    else if (PLAIN_LETTER[char]) out += PLAIN_LETTER[char];
    else {
      // Take the marks off a letter (U+0300 to U+036F are the combining marks).
      const plain = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      out += plain !== "" && [...plain].every((letter) => letter >= " " && letter <= "~") ? plain : "?";
    }
  }
  return out;
}

/** "$176.00": a receipt always shows the cents. */
export function money(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100).toLocaleString("en-US");
  return `${cents < 0 ? "-" : ""}$${whole}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

/** A sheet of paper being written from the top down. Adds a page when it runs out. */
class Sheet {
  private page: PDFPage;
  private y = 0;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = this.newPage();
  }

  newPage(): PDFPage {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
    return this.page;
  }

  /** Make sure `height` points are left on the page. */
  private room(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  space(points: number): void {
    this.y -= points;
  }

  /** Break text into lines no wider than `width`. A word longer than a line is cut. */
  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of pdfSafe(text).split(/ +/)) {
      let piece = word;
      while (font.widthOfTextAtSize(piece, size) > width && piece.length > 1) {
        let cut = piece.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(piece.slice(0, cut), size) > width) cut--;
        if (line) lines.push(line);
        lines.push(piece.slice(0, cut));
        line = "";
        piece = piece.slice(cut);
      }
      const candidate = line ? `${line} ${piece}` : piece;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else {
        if (line) lines.push(line);
        line = piece;
      }
    }
    if (line) lines.push(line);
    return lines.length > 0 ? lines : [""];
  }

  text(text: string, options: { size?: number; bold?: boolean; soft?: boolean; indent?: number } = {}): void {
    const size = options.size ?? 10;
    const font = options.bold ? this.bold : this.regular;
    const indent = options.indent ?? 0;
    for (const line of this.wrap(text, font, size, WIDTH - indent)) {
      this.room(size + 4);
      this.y -= size;
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font, color: options.soft ? SOFT : INK });
      this.y -= 4;
    }
  }

  /** A label on the left and an amount against the right margin. */
  row(label: string, amount: string, options: { bold?: boolean; soft?: boolean; indent?: number; size?: number } = {}): void {
    const size = options.size ?? 10;
    const font = options.bold ? this.bold : this.regular;
    const indent = options.indent ?? 0;
    const right = pdfSafe(amount);
    const rightWidth = font.widthOfTextAtSize(right, size);
    const lines = this.wrap(label, font, size, WIDTH - indent - rightWidth - 16);
    this.room(lines.length * (size + 4));
    for (const [index, line] of lines.entries()) {
      this.y -= size;
      const color = options.soft ? SOFT : INK;
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font, color });
      if (index === 0) this.page.drawText(right, { x: MARGIN + WIDTH - rightWidth, y: this.y, size, font, color });
      this.y -= 4;
    }
  }

  /** Two pieces of text on one line: one at the left margin, one against the right. */
  ends(left: string, right: string, options: { size?: number; bold?: boolean; soft?: boolean } = {}): void {
    this.row(left, right, options);
  }

  rule(): void {
    this.room(10);
    this.y -= 4;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + WIDTH, y: this.y }, thickness: 0.75, color: LINE });
    this.y -= 6;
  }
}

function letterhead(sheet: Sheet, title: string, business: Business): void {
  sheet.ends(business.name, title, { size: 16, bold: true });
  sheet.text(`${business.addressLine1}, ${business.addressLine2}`, { soft: true });
  sheet.text(business.phone, { soft: true });
  sheet.space(10);
  sheet.rule();
  sheet.space(4);
}

function drawReceipt(sheet: Sheet, receipt: Receipt, business: Business): void {
  const when = formatRange(new Date(receipt.visitStart), new Date(receipt.visitEnd));
  letterhead(sheet, "RECEIPT", business);
  sheet.ends(`Receipt for booking ${receipt.ref}`, `Paid ${formatDay(new Date(receipt.paidAt))}`, { size: 12, bold: true });
  sheet.space(6);
  sheet.text(`Customer: ${receipt.customerName}, ${receipt.customerEmail}`);
  sheet.text(`Appointment: ${when.day}, ${when.time} (${durationLabel(receipt.durationMinutes)})`);
  sheet.text(`Studio: ${receipt.studios}${receipt.photography ? `, ${receipt.photography}` : ""}`);
  sheet.text(`Booking status: ${receipt.bookingStatus}`);
  sheet.space(12);

  sheet.text("What was booked", { bold: true, size: 11 });
  sheet.space(2);
  for (const line of receipt.lines) sheet.row(line.label, money(line.cents));
  sheet.rule();
  sheet.row("Total", money(receipt.totalCents), { bold: true });
  sheet.space(14);

  sheet.text("Payments", { bold: true, size: 11 });
  sheet.space(2);
  for (const payment of receipt.payments) {
    sheet.row(`${formatInstant(new Date(payment.at))}  ${payment.how}`, money(payment.amountCents));
    for (const refund of payment.refunds) {
      sheet.row(
        `Refund ${formatDay(new Date(refund.at))}${REFUND_STATE_WORDS[refund.state]}${refund.reason ? `: ${refund.reason}` : ""}`,
        money(-refund.amountCents),
        { indent: 14, soft: true },
      );
    }
  }
  sheet.rule();
  sheet.row("Paid", money(receipt.paidCents), { bold: true });
  if (receipt.refundedCents > 0) {
    sheet.row("Refunded", money(-receipt.refundedCents));
    sheet.row("Paid, less refunds", money(receipt.netCents), { bold: true });
  }
  if (receipt.dueCents > 0) sheet.row("Still to pay", money(receipt.dueCents));
  sheet.row("Payment status", RECEIPT_STATUS_TEXT[receipt.status], { soft: true });
  sheet.space(18);
  sheet.text(
    "This receipt shows the booking at its prices, and what was actually paid and given back for it. Amounts are in US dollars. Times are Eastern Time.",
    { soft: true, size: 8.5 },
  );
}

function drawStatement(sheet: Sheet, statement: YearStatement, customer: { name: string; email: string }, business: Business): void {
  letterhead(sheet, "PAYMENT SUMMARY", business);
  sheet.text(`Payments in ${statement.year}`, { size: 12, bold: true });
  sheet.space(6);
  sheet.text(`Customer: ${customer.name ? `${customer.name}, ` : ""}${customer.email}`);
  sheet.text(`Every payment and refund dated in ${statement.year}, newest first. The receipt of each booking follows.`, { soft: true });
  sheet.space(12);

  if (statement.transactions.length === 0) sheet.text(`Nothing was paid or refunded in ${statement.year}.`);
  for (const transaction of statement.transactions) {
    sheet.row(
      `${formatDay(new Date(transaction.at))}  ${transaction.kind === "payment" ? "Payment" : `Refund${transaction.pending ? " (on its way)" : ""}`}, booking ${transaction.ref}, ${transaction.studios}`,
      money(transaction.cents),
    );
    sheet.text(
      `Appointment ${formatInstant(new Date(transaction.visitStart))}${transaction.detail ? `. ${transaction.detail}` : ""}`,
      { indent: 14, soft: true, size: 8.5 },
    );
  }
  sheet.rule();
  sheet.row(`Paid in ${statement.year}`, money(statement.paidCents), { bold: true });
  sheet.row(`Refunded in ${statement.year}`, money(-statement.refundedCents));
  sheet.row("Paid, less refunds", money(statement.netCents), { bold: true });
  sheet.space(18);
  sheet.text(
    "A payment counts in the year it was made, and a refund in the year it was made, whenever the appointment itself was. Amounts are in US dollars.",
    { soft: true, size: 8.5 },
  );
}

async function build(draw: (sheet: Sheet) => void, title: string, business: Business): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(title));
  doc.setAuthor(pdfSafe(business.name));
  doc.setCreator(pdfSafe(business.name));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  draw(new Sheet(doc, regular, bold));
  return doc.save();
}

/** One receipt as a PDF file. `business` is the studio's name and address for the top of the page. */
export function receiptPdf(receipt: Receipt, business: Business): Promise<Uint8Array> {
  return build((sheet) => drawReceipt(sheet, receipt, business), `Receipt ${receipt.ref}`, business);
}

/** A year's summary, then each of that year's receipts on a page of its own. */
export function yearPdf(statement: YearStatement, customer: { name: string; email: string }, business: Business): Promise<Uint8Array> {
  return build(
    (sheet) => {
      drawStatement(sheet, statement, customer, business);
      for (const receipt of statement.receipts) {
        sheet.newPage();
        drawReceipt(sheet, receipt, business);
      }
    },
    `Payments ${statement.year}`,
    business,
  );
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

/**
 * The lines of the HTML the site builds for the Policies page (src/lib/site/page-text.ts), for a PDF: each heading,
 * list item and paragraph a line of its own, every word of the text kept, the tags left out.
 */
export function acceptedLines(html: string): { kind: "heading" | "item" | "paragraph"; text: string }[] {
  const marked = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\u0001")
    .replace(/<li\b[^>]*>/gi, "\n\u0002")
    .replace(/<\/(p|h[1-6]|li|ul|ol|div|section|blockquote|article|header|footer|table|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
  return marked
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.replace(/[\u0001\u0002]/g, "").trim() !== "")
    .map((line) =>
      line.startsWith("\u0001")
        ? { kind: "heading" as const, text: line.slice(1).trim() }
        : line.startsWith("\u0002")
          ? { kind: "item" as const, text: line.slice(1).trim() }
          : { kind: "paragraph" as const, text: line },
    );
}

/** The policies or an agreement as a client accepted them, with who accepted them, for which booking and when. */
export function acceptedPdf(text: AcceptedText, booking: { ref: string; customerName: string }, business: Business): Promise<Uint8Array> {
  return build(
    (sheet) => {
      letterhead(sheet, "Accepted at checkout", business);
      sheet.text(text.title, { size: 14, bold: true });
      sheet.text(`Version ${text.versionNumber}, accepted by ${booking.customerName} for booking ${booking.ref}, ${formatInstant(new Date(text.acceptedAt))}.`, { soft: true });
      if (text.note) sheet.text(text.note, { soft: true });
      sheet.space(6);
      sheet.rule();
      for (const paragraph of text.paragraphs ?? []) {
        sheet.text(paragraph);
        sheet.space(6);
      }
      for (const line of text.html === null ? [] : acceptedLines(text.html)) {
        if (line.kind === "heading") {
          sheet.space(8);
          sheet.text(line.text, { size: 12, bold: true });
        } else if (line.kind === "item") {
          sheet.text(`•  ${line.text}`, { indent: 10 });
        } else {
          sheet.text(line.text);
          sheet.space(4);
        }
      }
    },
    `${text.title}, version ${text.versionNumber}, ${booking.ref}`,
    business,
  );
}
