/**
 * Import the appointments still to come from an appointments export of Acuity
 * Scheduling, the old website's booking system (src/server/acuity-import.ts):
 * each becomes a booking here that holds its studios and the photographer,
 * with Acuity's price and what was paid there, so that the site books around
 * it. Step 5 of the plan in HANDOFF.md.
 *
 *   npx tsx scripts/import-acuity.ts <export.csv> [--as owner@address] [--money live|test] [--remind] [--write]
 *
 * With --history it brings in the past visits of the export instead (step 7,
 * src/server/acuity-history.ts): read-only bookings that hold no time, count
 * for no loyalty stamp and send nothing, so that clients' accounts and the
 * admin show the visits made before this site. The two imports never bring in
 * one appointment twice, so both can run on the same export.
 *
 * Without --write it is a rehearsal: everything is worked out against the
 * database, the report is printed, and nothing is written. Read the report,
 * then run it again with --write. A second run imports only what is new.
 *
 * The export: in Acuity, Reports → Import/Export, the dates from today on,
 * then Export appointments (a CSV file). Acuity's export has a Canceled
 * column (the owners' of 2026-11-20 did), which the import reads: the
 * cancelled appointments it lists are left out. A file without that column
 * must not list them, or they would be imported as booked. Keep the file out
 * of this repository: it holds clients' details. The report names
 * appointments by Acuity's id, their row in the file, their time and type,
 * never a client.
 *
 * Which database: DATABASE_URL when it is set (staging, production), otherwise
 * the local one in web/.data/<PGLITE_DATA_NAME or pglite>, which no running
 * server may have open. Who imports: --as, which must be one of OWNER_EMAILS
 * when that is set; it is kept as who made the bookings. What kind of money
 * they are: that of the card processor set up where this runs (the SQUARE_
 * settings), or --money when none is: live for the real site, test for
 * staging; given both, they must agree. Reminders: Acuity, which still holds
 * the appointments, sends its own; with --remind the site sends its reminder
 * before each visit as well.
 */
import { readFileSync } from "node:fs";
import { getDb } from "../src/db/client";
import { readAcuityExport } from "../src/lib/acuity";
import { formatCents } from "../src/lib/domain/pricing";
import { importAcuityHistory } from "../src/server/acuity-history";
import { importAcuityAppointments, type ReportLine } from "../src/server/acuity-import";
import { resolvePayments } from "../src/server/payments";
import { moneyKindOf, type MoneyKind } from "../src/server/test-mode";

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const file = args.find((arg, index) => !arg.startsWith("--") && !["--as", "--money"].includes(args[index - 1] ?? ""));
  if (!file) stop("Name the export: npx tsx scripts/import-acuity.ts <export.csv> [--history] [--as owner@address] [--money live|test] [--remind] [--write]");

  const owners = (process.env.OWNER_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  const as = (valueOf("--as") ?? owners[0])?.trim().toLowerCase();
  if (!as || !as.includes("@")) stop("Say who imports: --as owner@address (or set OWNER_EMAILS).");
  if (owners.length > 0 && !owners.includes(as)) stop(`${as} is not one of OWNER_EMAILS: only an owner imports bookings.`);

  // The processor set up here, when all three of its settings are: never the pretend one a script gets without them.
  const squareSet = Boolean(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID && process.env.SQUARE_APPLICATION_ID);
  const processor = squareSet ? (resolvePayments().provider?.name ?? null) : null;
  if (squareSet && !processor) stop("The Square settings here disagree with each other (see SQUARE_ENVIRONMENT), so the kind of money is unknown.");
  const asked = valueOf("--money");
  if (asked !== undefined && asked !== "live" && asked !== "test") stop("--money is live (the real site) or test (staging).");
  const fromProcessor = processor ? moneyKindOf(processor) : null;
  if (fromProcessor && asked && fromProcessor !== asked) stop(`The card processor set up here (${processor}) moves ${fromProcessor} money, not ${asked}.`);
  const moneyKind: MoneyKind | undefined = fromProcessor ?? (asked as MoneyKind | undefined);
  if (!moneyKind) stop("No card processor is set up here: say what kind of money these bookings are, --money live for the real site or --money test for staging.");

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    stop(`Cannot read ${file}.`);
  }
  const reading = readAcuityExport(text);
  if (!reading.ok) stop(reading.message);

  const write = args.includes("--write");
  const where = process.env.DATABASE_URL ? "the database in DATABASE_URL" : `the local database web/.data/${process.env.PGLITE_DATA_NAME || "pglite"}`;
  console.log(
    `${write ? "Importing into" : "Rehearsal against"} ${where}, as ${as}, as ${moneyKind} money${write ? "" : ": nothing is written"}. ${reading.appointments.length} appointment(s) read from the file.`,
  );
  const db = await getDb();
  const named = (line: ReportLine) => `row ${line.row}, appointment ${line.id}, ${line.when}, "${line.type}"`;
  /** A reason as a sentence: a question keeps its own mark. */
  const sentence = (reason: string) => (/[.?!]$/.test(reason) ? reason : `${reason}.`);
  const unreadable = () => {
    if (reading.unreadable.length === 0) return;
    console.log(`  Rows that could not be read: ${reading.unreadable.length}.`);
    for (const row of reading.unreadable) console.log(`    row ${row.row}${row.id ? `, appointment ${row.id}` : ""}: ${row.problem}.`);
  };

  if (args.includes("--history")) {
    const history = await importAcuityHistory(db, reading.appointments, { now: new Date(), actor: as, moneyKind, write });
    console.log(
      `  ${write ? "Imported" : "Would import"}: ${history.imported} past visit(s), ${history.noShows} of them no-shows. They hold no time, count for no loyalty stamp, and send nothing.`,
    );
    if (history.already > 0) console.log(`  Imported before, left as they are: ${history.already}.`);
    console.log(`  Not over yet (the import without --history takes them): ${history.notOver}. Cancelled in Acuity: ${history.cancelled}.`);
    if (history.setAside.length > 0) {
      console.log(`  NOT imported: ${history.setAside.length}. Each needs a person.`);
      for (const line of history.setAside) console.log(`    ${named(line)}: ${sentence(line.reason)}`);
    }
    unreadable();
    if (!write && history.imported > 0) console.log("Nothing was written. Run it again with --write to import.");
    process.exit(history.setAside.length > 0 || reading.unreadable.length > 0 ? 1 : 0);
  }

  const report = await importAcuityAppointments(db, reading.appointments, {
    now: new Date(),
    actor: as,
    moneyKind,
    write,
    remind: args.includes("--remind"),
  });

  console.log(`  ${write ? "Imported" : "Would import"}: ${report.imported.length}.`);
  for (const line of report.imported) console.log(`    ${named(line)}: ${line.ref}`);
  if (report.imported.length > 0) {
    const { priceCents, paidCents, dueCents } = report.totals;
    console.log(`    In all ${formatCents(priceCents)}: ${formatCents(paidCents)} paid in Acuity, ${formatCents(dueCents)} to pay at the studio.`);
  }
  if (report.already.length > 0) console.log(`  Imported before, left as they are: ${report.already.length}.`);
  console.log(`  Over already: ${report.past}. Cancelled in Acuity: ${report.cancelled}.`);
  if (report.refused.length > 0) {
    console.log(`  NOT imported: ${report.refused.length}. Each needs a person: in Acuity, or entered in the admin by hand.`);
    for (const line of report.refused) console.log(`    ${named(line)}: ${sentence(line.reason)}`);
  }
  unreadable();
  if (!write && report.imported.length > 0) console.log("Nothing was written. Run it again with --write to import.");
  process.exit(report.refused.length > 0 || reading.unreadable.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
