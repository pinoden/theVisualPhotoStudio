import { isIsoDate, STUDIO_TIME_ZONE, type IsoDate } from "./domain/time";

/**
 * Reading an appointments export of Acuity Scheduling, the old website's
 * booking system, for the import of the appointments still to come
 * (src/server/acuity-import.ts). Acuity exports a CSV file (Reports →
 * Import/Export → Export appointments).
 *
 * The columns are found by their names, never their order, so a column added
 * or moved changes nothing. A column the import needs that is missing stops
 * it before anything is read, with the names the file has; a row whose time
 * or amount cannot be read is set aside with the reason, and the others are
 * read. Acuity's times are on the studio's clock (America/New_York, the same
 * as the site's), so they are kept as a date and the minutes past midnight;
 * the export's Timezone column says so for each row, and a row in another
 * time zone is set aside. Acuity's Email field holds the client's own address
 * first, then any the client asked Acuity to copy its emails to: the first is
 * the client's (`email`), the rest are kept apart (`otherEmails`). The real
 * export of 2026-11-20 had all these columns: see "Importing Acuity's
 * appointments still to come" in ProjectLibrary.md.
 *
 * Nothing here touches the database: it turns text into appointments, and an
 * appointment's type into the studios it books.
 */

/** A date and time on the studio's clock. */
export interface WallTime {
  date: IsoDate;
  minute: number;
}

/** One appointment of the export, as the import needs it. */
export interface AcuityAppointment {
  /** Acuity's id of the appointment, kept with the booking: a second import of the same export adds nothing. */
  id: string;
  /** Its row in the file, the column names being row 1, for a person to find it. */
  row: number;
  start: WallTime;
  end: WallTime;
  name: string;
  /** The client's own address: the first of Acuity's Email field. */
  email: string;
  /** The other addresses of Acuity's Email field, which Acuity copied its emails to, as the export writes them. */
  otherEmails: string[];
  phone: string;
  /** The appointment type's name, which says the studios it books: "Blanche + Paris (2 hr)". */
  type: string;
  calendar: string;
  /** What the appointment costs, as Acuity has it. */
  priceCents: number;
  /** "Paid?" says yes: paid in full in Acuity, by whatever means. */
  markedPaid: boolean;
  /** What the client paid by card online when booking. */
  paidOnlineCents: number;
  /** A package, gift certificate or subscription code that paid for it, if any. */
  certificate: string;
  notes: string;
  /** When the client booked it, as the export writes it. */
  scheduled: string;
  /** Cancelled in Acuity: an export can list cancelled appointments too. */
  canceled: boolean;
}

/** A row that could not be read, and why. */
export interface UnreadableRow {
  row: number;
  id: string;
  problem: string;
}

export type ExportReading =
  | { ok: true; appointments: AcuityAppointment[]; unreadable: UnreadableRow[] }
  | { ok: false; message: string };

/** The columns the import reads: the names Acuity gives each, and whether the import cannot do without it. */
const COLUMNS = {
  id: { names: ["Appointment ID", "ID"], required: true },
  start: { names: ["Start Time"], required: true },
  end: { names: ["End Time"], required: true },
  firstName: { names: ["First Name"], required: true },
  lastName: { names: ["Last Name"], required: true },
  email: { names: ["Email"], required: true },
  type: { names: ["Type", "Appointment Type"], required: true },
  price: { names: ["Appointment Price", "Price"], required: true },
  phone: { names: ["Phone"], required: false },
  calendar: { names: ["Calendar"], required: false },
  paid: { names: ["Paid?", "Paid"], required: false },
  paidOnline: { names: ["Amount Paid Online"], required: false },
  certificate: { names: ["Certificate Code"], required: false },
  notes: { names: ["Notes"], required: false },
  scheduled: { names: ["Date Scheduled"], required: false },
  canceled: { names: ["Canceled", "Cancelled", "Canceled?", "Cancelled?"], required: false },
  timeZone: { names: ["Timezone", "Time Zone"], required: false },
} as const satisfies Record<string, { names: readonly string[]; required: boolean }>;

type Column = keyof typeof COLUMNS;

/** A CSV file as rows of fields (RFC 4180): a field in double quotes may hold commas, line breaks and quotes written twice. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines, a last line break among them, are not rows.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const header = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** Read an export: its appointments, and the rows that could not be read. */
export function readAcuityExport(text: string): ExportReading {
  const [names, ...rows] = parseCsv(text);
  if (!names) return { ok: false, message: "The file is empty." };
  const found = names.map(header);
  const at = {} as Record<Column, number>;
  const missing: string[] = [];
  for (const [column, { names: options, required }] of Object.entries(COLUMNS) as [Column, (typeof COLUMNS)[Column]][]) {
    // Its names in their order, wherever each column is: "Appointment Price" before a column called just "Price", which
    // an intake form's question could be, even to its left (the review of 2026-11-20).
    at[column] = options.map((option) => found.indexOf(header(option))).find((index) => index !== -1) ?? -1;
    if (at[column] === -1 && required) missing.push(`"${options[0]}"`);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message: `The file has no column ${missing.join(", ")}, which the import needs. Its columns are: ${names.map((name) => `"${name.trim()}"`).join(", ")}.`,
    };
  }

  const appointments: AcuityAppointment[] = [];
  const unreadable: UnreadableRow[] = [];
  rows.forEach((cells, index) => {
    const row = index + 2;
    const cell = (column: Column) => (at[column] === -1 ? "" : (cells[at[column]] ?? "").trim());
    const id = cell("id");
    const problem = (text: string) => unreadable.push({ row, id, problem: text });
    if (id === "") return problem("it has no appointment ID");
    const zone = cell("timeZone");
    if (zone !== "" && zone !== STUDIO_TIME_ZONE) return problem(`its times are in ${zone}, not on the studio's clock (${STUDIO_TIME_ZONE})`);
    const start = readWallTime(cell("start"));
    if (!start) return problem(`its start time cannot be read ("${cell("start")}")`);
    const end = readWallTime(cell("end"), start.date);
    if (!end) return problem(`its end time cannot be read ("${cell("end")}")`);
    const priceCents = readCents(cell("price"));
    if (priceCents === null) return problem(`its price cannot be read ("${cell("price")}")`);
    const paidOnlineCents = readCents(cell("paidOnline"));
    if (paidOnlineCents === null) return problem(`what was paid online cannot be read ("${cell("paidOnline")}")`);
    // "ana@client.test, bo@client.test": Acuity separates them with commas; no address holds a comma, a semicolon or a space.
    const [email = "", ...otherEmails] = cell("email").split(/[\s,;]+/).filter((part) => part !== "");
    appointments.push({
      id,
      row,
      start,
      end,
      name: `${cell("firstName")} ${cell("lastName")}`.trim().replace(/\s+/g, " "),
      email,
      otherEmails,
      phone: cell("phone"),
      type: cell("type").replace(/\s+/g, " "),
      calendar: cell("calendar"),
      priceCents,
      markedPaid: isYes(cell("paid")),
      paidOnlineCents,
      certificate: cell("certificate"),
      notes: cell("notes"),
      scheduled: cell("scheduled"),
      canceled: isYes(cell("canceled")),
    });
  });
  return { ok: true, appointments, unreadable };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The month of a name or its short form ("November", "Nov", "Sept"), from 1; 0 when it is none. */
function monthOf(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3)) + 1;
}

/**
 * A date and time as an export writes them: "November 20, 2026 10:00am",
 * "Nov 20, 2026 10:00 AM", "Friday, November 20, 2026 10:00am",
 * "11/20/2026 10:00 AM" or "2026-11-20 10:00", with or without seconds,
 * on a 12-hour or 24-hour clock. A time alone ("1:00pm", as an end time can
 * be written) is on `sameDay`. Null when it cannot be read.
 */
export function readWallTime(value: string, sameDay?: IsoDate): WallTime | null {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*([ap])\.?m\.?$/, " $1m");
  const time = String.raw`(\d{1,2}):(\d{2})(?::\d{2})? ?(am|pm)?`;
  let m = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})[ t]${time}$`).exec(text);
  if (m) return wall(+m[1], +m[2], +m[3], +m[4], +m[5], m[6]);
  m = new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4}),? ${time}$`).exec(text);
  if (m) return wall(+m[3], +m[1], +m[2], +m[4], +m[5], m[6]);
  m = new RegExp(String.raw`^(?:[a-z]+,? )?([a-z]+)\.? (\d{1,2}),? (\d{4}),? (?:at )?${time}$`).exec(text);
  if (m && monthOf(m[1]) > 0) return wall(+m[3], monthOf(m[1]), +m[2], +m[4], +m[5], m[6]);
  m = new RegExp(String.raw`^${time}$`).exec(text);
  if (m && sameDay) {
    const [year, month, day] = sameDay.split("-").map(Number);
    return wall(year, month, day, +m[1], +m[2], m[3]);
  }
  return null;
}

function wall(year: number, month: number, day: number, hour: number, minute: number, half: string | undefined): WallTime | null {
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isIsoDate(date) ? { date, minute: hour * 60 + minute } : null;
}

/** An amount as an export writes it ("$1,500.00", "136", empty for none) in cents; null when it is not an amount. */
export function readCents(value: string): number | null {
  const text = value.trim().replace(/[$,\s]/g, "");
  if (text === "") return 0;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function isYes(value: string): boolean {
  return /^(yes|y|true|1|paid|canceled|cancelled)$/i.test(value.trim());
}

/** What the import needs to know of a studio of the site to find it in a type's name. */
export interface NamedStudio {
  id: string;
  slug: string;
  name: string;
}

/** The words that name a studio: its short name ("Studio Blanche" is "blanche") and its slug. */
function namesOf(studio: NamedStudio): string[] {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return [...new Set([plain(studio.name.replace(/^\s*studio\s+/i, "")), plain(studio.slug)])].filter((name) => name !== "");
}

/**
 * The studios an appointment books, in the site's order, and whether it is a
 * session with the photographer. They are read from the type's name ("Blanche
 * + Paris (2 hr)", "Photography DAYGLOW (1 hr)"): Acuity books every bundle on
 * one calendar, Paris's, so the calendar cannot say. A type that names no
 * studio books the one its calendar is named after. Null when neither names a
 * studio of the site.
 */
export function studiosOfAppointment(
  type: string,
  calendar: string,
  studios: readonly NamedStudio[],
): { studioIds: string[]; photography: boolean } | null {
  const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const named = (text: string) => studios.filter((studio) => namesOf(studio).some((name) => words(text).includes(` ${name} `)));
  const chosen = named(type).length > 0 ? named(type) : named(calendar);
  if (chosen.length === 0 || (named(type).length === 0 && chosen.length > 1)) return null;
  return { studioIds: chosen.map((studio) => studio.id), photography: /photograph/i.test(type) };
}
