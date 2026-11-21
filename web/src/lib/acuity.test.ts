import { describe, expect, it } from "vitest";
import { parseCsv, readAcuityExport, readCents, readWallTime, studiosOfAppointment, type NamedStudio } from "./acuity";

/** Reading Acuity's appointments export, for the import of the appointments still to come (src/server/acuity-import.ts). */

const COLUMNS = [
  "Start Time",
  "End Time",
  "First Name",
  "Last Name",
  "Phone",
  "Email",
  "Type",
  "Calendar",
  "Appointment Price",
  "Paid?",
  "Amount Paid Online",
  "Certificate Code",
  "Notes",
  "Date Scheduled",
  "Label",
  "Scheduled By",
  "Appointment ID",
];

const csv = (rows: string[][]) => rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(",")).join("\r\n");

describe("a CSV file", () => {
  it("is read field by field, quotes, commas and line breaks inside a field included", () => {
    expect(parseCsv('﻿a,b,c\r\n1,"two, and ""three""","line one\nline two"\n\n4,,6\n')).toEqual([
      ["a", "b", "c"],
      ["1", 'two, and "three"', "line one\nline two"],
      ["4", "", "6"],
    ]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("only")).toEqual([["only"]]);
  });
});

describe("Acuity's export", () => {
  it("is read by its columns' names, in any order, and each row becomes an appointment", () => {
    const text = csv([
      COLUMNS,
      [
        "November 20, 2026 10:00am",
        "November 20, 2026 12:00pm",
        "Ana",
        "Lima",
        "(407) 555-0100",
        "ana@client.test",
        " Blanche + Paris (2 hr)",
        "Paris",
        "$245.00",
        "no",
        "50.00",
        "",
        "Bringing a dog, and a ring light",
        "November 1, 2026 9:15am",
        "",
        "client",
        "1234567890",
      ],
    ]);
    const reading = readAcuityExport(text);
    expect(reading).toEqual({
      ok: true,
      unreadable: [],
      appointments: [
        {
          id: "1234567890",
          row: 2,
          start: { date: "2026-11-20", minute: 600 },
          end: { date: "2026-11-20", minute: 720 },
          name: "Ana Lima",
          email: "ana@client.test",
          otherEmails: [],
          phone: "(407) 555-0100",
          type: "Blanche + Paris (2 hr)",
          calendar: "Paris",
          priceCents: 24500,
          markedPaid: false,
          paidOnlineCents: 5000,
          certificate: "",
          notes: "Bringing a dog, and a ring light",
          scheduled: "November 1, 2026 9:15am",
          canceled: false,
          label: "",
        },
      ],
    });
    // The same columns in another order, with other capitals.
    const shuffled = [...COLUMNS].reverse().map((name) => name.toUpperCase());
    const row = [...["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]];
    row[shuffled.indexOf("APPOINTMENT ID")] = "42";
    row[shuffled.indexOf("START TIME")] = "2026-11-20 10:00";
    row[shuffled.indexOf("END TIME")] = "2026-11-20 11:30";
    row[shuffled.indexOf("FIRST NAME")] = "Bo";
    row[shuffled.indexOf("EMAIL")] = "bo@client.test";
    row[shuffled.indexOf("TYPE")] = "Studio Paris Booking (1.5 hr)";
    row[shuffled.indexOf("APPOINTMENT PRICE")] = "102";
    row[shuffled.indexOf("PAID?")] = "yes";
    const again = readAcuityExport(csv([shuffled, row]));
    expect(again.ok && again.appointments[0]).toMatchObject({ id: "42", end: { minute: 690 }, name: "Bo", priceCents: 10200, markedPaid: true, paidOnlineCents: 0 });
  });

  it("reads a column by its first name the file has, wherever it is: an intake question called Price or ID to its left is not it", () => {
    // An intake form's questions are columns too, and could be called "Price" or "ID" (the review of 2026-11-20).
    const names = ["ID", "Price", "Appointment ID", "Start Time", "End Time", "First Name", "Last Name", "Email", "Type", "Appointment Price"];
    const reading = readAcuityExport(csv([names, ["form-7", "$999.00", "42", "2026-11-20 10:00", "2026-11-20 11:00", "C", "D", "c@client.test", "Studio Dayglow Booking (1 hr)", "$78.00"]]));
    expect(reading.ok && reading.appointments[0]).toMatchObject({ id: "42", priceCents: 7800 });
    // A file with only the shorter names is read by them.
    const short = readAcuityExport(csv([["ID", "Start Time", "End Time", "First Name", "Last Name", "Email", "Type", "Price"], ["43", "2026-11-20 10:00", "2026-11-20 11:00", "C", "D", "c@client.test", "Studio Dayglow Booking (1 hr)", "$78.00"]]));
    expect(short.ok && short.appointments[0]).toMatchObject({ id: "43", priceCents: 7800 });
  });

  it("stops at a missing column the import needs, and names the columns the file has", () => {
    const reading = readAcuityExport(csv([COLUMNS.filter((name) => name !== "Appointment ID" && name !== "Email"), []]));
    expect(reading).toEqual({ ok: false, message: expect.stringContaining('The file has no column "Appointment ID", "Email", which the import needs. Its columns are: "Start Time", "End Time"') });
    expect(readAcuityExport("")).toEqual({ ok: false, message: "The file is empty." });
    // A column it can do without is read as empty.
    const few = readAcuityExport(csv([["Appointment ID", "Start Time", "End Time", "First Name", "Last Name", "Email", "Type", "Appointment Price"], ["7", "2026-11-20 10:00", "2026-11-20 11:00", "C", "D", "c@client.test", "Studio Dayglow Booking (1 hr)", "78"]]));
    expect(few.ok && few.appointments[0]).toMatchObject({ phone: "", calendar: "", markedPaid: false, paidOnlineCents: 0, certificate: "", canceled: false });
  });

  it("sets aside a row whose time or amount cannot be read, with the reason, and reads the others", () => {
    const good = ["2026-11-20 10:00", "2026-11-20 11:00", "C", "D", "", "c@client.test", "Studio Dayglow Booking (1 hr)", "Dayglow", "78", "", "", "", "", "", "", "", "9"];
    const reading = readAcuityExport(
      csv([
        COLUMNS,
        good,
        ["soon", ...good.slice(1, -1), "10"],
        [good[0], "later", ...good.slice(2, -1), "11"],
        [...good.slice(0, 8), "free", ...good.slice(9, -1), "12"],
        [...good.slice(0, -1), ""],
      ]),
    );
    expect(reading.ok && reading.appointments.map((appointment) => appointment.id)).toEqual(["9"]);
    expect(reading.ok && reading.unreadable).toEqual([
      { row: 3, id: "10", problem: 'its start time cannot be read ("soon")' },
      { row: 4, id: "11", problem: 'its end time cannot be read ("later")' },
      { row: 5, id: "12", problem: 'its price cannot be read ("free")' },
      { row: 6, id: "", problem: "it has no appointment ID" },
    ]);
  });

  it("reads the columns of Acuity's real export: the client's own address first in Email, those copied apart, the time zone and the cancelled", () => {
    // The columns of the owners' export of 2026-11-20, in its order; the values are made up.
    const names = [
      "Start Time", "End Time", "Timezone", "First Name", "Last Name", "Phone", "Email", "Type", "Calendar", "Appointment Price",
      "Paid?", "Amount Paid Online", "Certificate Code", "Notes", "Date Scheduled", "Label", "Scheduled By", "Date Rescheduled",
      "Canceled", "Date Canceled", "Appointment ID",
    ];
    const row = (cells: Record<string, string>) => names.map((name) => cells[name] ?? "");
    const base = {
      "Start Time": "March 3, 2027 9:20 am",
      "End Time": "March 3, 2027 12:20 pm",
      Timezone: "America/New_York",
      "First Name": "Ana",
      "Last Name": "Lima",
      Email: "ana@client.test, bo@client.test",
      Type: "Studio Paris + Studio Dayglow (3 hr)",
      Calendar: "Paris",
      "Appointment Price": "300.00",
      "Paid?": "yes",
      "Amount Paid Online": "300.00",
      "Date Scheduled": "2027-02-01",
      "Appointment ID": "1769000001",
      Label: "Completed",
    };
    const reading = readAcuityExport(
      csv([
        names,
        row(base),
        row({ ...base, "Appointment ID": "1769000002", Email: "Cy@Client.test;dee@client.test  eve@client.test,", Label: "No-show" }),
        row({ ...base, "Appointment ID": "1769000003", Timezone: "America/Los_Angeles" }),
        row({ ...base, "Appointment ID": "1769000004", Canceled: "canceled", "Date Canceled": "2026-11-02", Label: "" }),
      ]),
    );
    expect(reading.ok && reading.appointments.map((a) => [a.id, a.email, a.otherEmails, a.start, a.end, a.canceled, a.label])).toEqual([
      ["1769000001", "ana@client.test", ["bo@client.test"], { date: "2027-03-03", minute: 560 }, { date: "2027-03-03", minute: 740 }, false, "Completed"],
      ["1769000002", "Cy@Client.test", ["dee@client.test", "eve@client.test"], { date: "2027-03-03", minute: 560 }, { date: "2027-03-03", minute: 740 }, false, "No-show"],
      ["1769000004", "ana@client.test", ["bo@client.test"], { date: "2027-03-03", minute: 560 }, { date: "2027-03-03", minute: 740 }, true, ""],
    ]);
    // A row in another time zone would be read at the wrong time: it is set aside.
    expect(reading.ok && reading.unreadable).toEqual([
      { row: 4, id: "1769000003", problem: "its times are in America/Los_Angeles, not on the studio's clock (America/New_York)" },
    ]);
  });
});

describe("a time in the export", () => {
  it("is read in the ways Acuity writes it, on the studio's clock", () => {
    const at = (date: string, hour: number, minute = 0) => ({ date, minute: hour * 60 + minute });
    expect(readWallTime("November 20, 2026 10:00am")).toEqual(at("2026-11-20", 10));
    expect(readWallTime("Nov 20, 2026 1:30 PM")).toEqual(at("2026-11-20", 13, 30));
    expect(readWallTime("Friday, November 20, 2026 12:00pm")).toEqual(at("2026-11-20", 12));
    expect(readWallTime("Sept 3, 2026 12:15 a.m.")).toEqual(at("2026-09-03", 0, 15));
    expect(readWallTime("11/20/2026 10:00 AM")).toEqual(at("2026-11-20", 10));
    expect(readWallTime("2026-11-20 18:45:00")).toEqual(at("2026-11-20", 18, 45));
    expect(readWallTime("2026-11-20T09:05")).toEqual(at("2026-11-20", 9, 5));
    // A time alone is on the day given: an end time can be written so.
    expect(readWallTime("1:00pm", "2026-11-20")).toEqual(at("2026-11-20", 13));
    expect(readWallTime("1:00pm")).toBeNull();
    // Not a time, or not a day of the calendar.
    for (const value of ["", "tomorrow", "February 30, 2026 10:00am", "13:00 pm", "2026-11-20 24:00", "Smarch 3, 2026 10:00"]) {
      expect(readWallTime(value), value).toBeNull();
    }
  });

  it("and an amount, in cents", () => {
    expect(readCents("$1,500.00")).toBe(150000);
    expect(readCents("136")).toBe(13600);
    expect(readCents("19.5")).toBe(1950);
    expect(readCents(" ")).toBe(0);
    expect(readCents("-5")).toBeNull();
    expect(readCents("free")).toBeNull();
  });
});

describe("the studios an appointment books", () => {
  const STUDIOS: NamedStudio[] = [
    { id: "b", slug: "blanche", name: "Studio Blanche" },
    { id: "d", slug: "dayglow", name: "Studio Dayglow" },
    { id: "p", slug: "paris", name: "Studio Paris" },
  ];
  const of = (type: string, calendar = "") => studiosOfAppointment(type, calendar, STUDIOS);

  it("are read from the type's name, as Acuity names its types (all on Paris's calendar for a bundle)", () => {
    expect(of("Studio Dayglow Booking (1.5 hr)", "Dayglow")).toEqual({ studioIds: ["d"], photography: false });
    expect(of("Studio Blanche Booking (2  hr)", "Blanche")).toEqual({ studioIds: ["b"], photography: false });
    expect(of("Studio Paris Booking (5 hr)", "Paris")).toEqual({ studioIds: ["p"], photography: false });
    expect(of("Blanche + Paris (8 hr)", "Paris")).toEqual({ studioIds: ["b", "p"], photography: false });
    expect(of("Blanche + Paris + Dayglow (10 hr)", "Paris")).toEqual({ studioIds: ["b", "d", "p"], photography: false });
    expect(of("Studio Paris + Studio Dayglow (1.5 hr)", "Paris")).toEqual({ studioIds: ["d", "p"], photography: false });
    expect(of("Photography DAYGLOW (1 hr)", "Dayglow")).toEqual({ studioIds: ["d"], photography: true });
    expect(of("Photography PARIS (3 hr)", "Paris")).toEqual({ studioIds: ["p"], photography: true });
  });

  it("are the calendar's studio when the type names none, and none when neither does", () => {
    expect(of("Hourly rental (1 hr)", "Blanche")).toEqual({ studioIds: ["b"], photography: false });
    expect(of("Gift card", "")).toBeNull();
    expect(of("Gift card", "Any available")).toBeNull();
    // A word that only contains a studio's name is not it.
    expect(of("Parisian evening", "")).toBeNull();
  });

  it("follow the studios as the owners have named them, and their slugs", () => {
    const renamed = [{ id: "p", slug: "paris", name: "Studio Rose" }];
    expect(studiosOfAppointment("Rose (1 hr)", "", renamed)).toEqual({ studioIds: ["p"], photography: false });
    expect(studiosOfAppointment("Studio Paris Booking (1 hr)", "", renamed)).toEqual({ studioIds: ["p"], photography: false });
  });
});
