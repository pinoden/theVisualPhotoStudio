"use client";

import Image from "next/image";
import { SERVICE_WORDS, sessionsOf, type Service } from "@/lib/domain/services";
import { useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, type UIEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  availabilityGrid,
  combinedStarts,
  afterBusinessDays,
  businessDaysInWords,
  noticeHours,
  studiosFreeAt,
  type SlotOptions,
} from "@/lib/domain/availability";
import { bundleOffer, extraGuestsFor, multiStudioSaving, shownLengths, studioCombinationError } from "@/lib/catalog-view";
import { MonthCalendar } from "./MonthCalendar";
import { WaitlistJoin } from "./WaitlistJoin";
import {
  bookableDurations,
  bundleList,
  findPrice,
  studioPriceLines,
  unpriced,
  formatCents,
  promoMisfitText,
  quote,
  taxLabel,
  taxRuleFor,
  type Quote,
} from "@/lib/domain/pricing";
import {
  addDays,
  defaultDayType,
  durationLabel,
  isIsoDate,
  longDateLabel,
  minutesToLabel,
  studioToday,
  type DayType,
} from "@/lib/domain/time";
import { EMAIL_FIELD, EMAIL_RULE, hasPhoneDigits } from "@/lib/parse";
import { hintsSignedIn } from "@/lib/signed-in-hint";
import { keptText, readKept, stepHash, stepOfHash, stepToShowAgain, type AppliedCode, type BookingMode, type BookingStep, type KeptBooking } from "@/lib/booking-progress";
import { count, hoursInWords } from "@/lib/words";
import type { DayAvailability } from "@/server/availability";
import { agreementKey, initialsKey, initialsOf, policiesKey, type QuestionKind } from "@/lib/booking-form-keys";
import { bookingSale, listsOnSale, saleCodesWords, salesInForce, saleWords } from "@/lib/domain/sale";
import type { Catalog } from "@/server/catalog";
import type { OwnDetails } from "@/server/own-details";
import { SalePrice } from "./SalePrice";
import { buyerVerification, useCardForm } from "./square-card";
import { FAKE_PAYMENT_LABEL, FAKE_PAYMENT_NOTE, FAKE_PAYMENT_TOKEN } from "@/lib/fake-payment"; // FAKE PAYMENT

type Mode = BookingMode;
type Step = BookingStep;

/**
 * The two booking paths are the same steps in a different order. The day and its start times are one step (the owner's
 * brief of 2026-11-24, item 3: "Display the available start times on the same page as the monthly calendar"): the times
 * of the day chosen appear beside the calendar on a computer and below it on a phone, and another day is chosen there.
 */
const ORDER: Record<Mode, Step[]> = {
  studio: ["studios", "when", "details", "policies", "pay"],
  time: ["when", "studios", "details", "policies", "pay"],
};
const STEP_LABEL: Record<Step, string> = {
  studios: "Studios",
  when: "Date & time",
  details: "Details",
  policies: "Policies",
  pay: "Payment",
};

/** A random id for one attempt to book (see `requestId` in src/server/bookings.ts). */
function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // An address that is not https (a phone trying the site on the local network) has no randomUUID: the same, by hand.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "Studio Blanche or Studio Paris". */
const orList = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`);

/** Today's date is only known in the browser, on the studio's clock wherever the device is; the server renders without it. */
const browserToday = () => studioToday();
const subscribeNever = () => () => {};
const serverToday = () => "";

/**
 * After a booking is made the browser loads the confirmation page as a fresh
 * document. An in-app navigation would keep this screen alive in the
 * background with its finished selection, and coming back to book again
 * would show the old, already-paid choices.
 */
function loadPage(url: string): void {
  window.location.assign(url);
}

/**
 * The times offered are one stop of the keyboard, as a group of choices is: the keyboard-only booking of 2026-11-21
 * pressed Tab up to 40 times from a chosen time to "Next". Tab reaches one time (`timeStop`), the arrow keys move to
 * the next or the one before, as in a group of radio buttons, Home and End to the first and the last, and Enter or
 * Space chooses, as a click does.
 */
function moveAmongTimes(event: KeyboardEvent<HTMLDivElement>): void {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const at = buttons.indexOf(event.target as HTMLButtonElement);
  if (at < 0) return;
  const moves: Record<string, number> = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 };
  if (!Object.hasOwn(moves, event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  buttons[Math.min(Math.max(moves[event.key], 0), buttons.length - 1)].focus();
}

/** A question of the intake form, as the booking page asks it (`/api/checkout-forms`). */
interface FormQuestion {
  id: string;
  label: string;
  help: string;
  kind: QuestionKind;
  options: string[];
  required: boolean;
}

/** An agreement beside the studio policies, as published (`/api/checkout-forms`). */
interface FormAgreement {
  versionId: string;
  number: number;
  title: string;
  body: string;
}

/** The studio policies a client reads and accepts at checkout: the website's Policies page as published, and its version. */
export interface CheckoutPolicies {
  versionId: string;
  title: string;
  /** The page's headings and text as HTML (`pageTextHtml`), cleaned as the page's own. */
  html: string;
}

/** What the tab kept for each booking screen, read once when the screen is first drawn in the browser. */
const keptAtStart = new WeakMap<object, KeptBooking | null>();
/** Whether a booking screen was drawn already since the document was loaded: a later one was reached inside the site. */
let screenDrawnBefore = false;

/** Whether the browser brought the document back, by a refresh or its Back and Forward buttons, rather than opened it by a link or a typed address. */
function documentCameBack(): boolean {
  const entry = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.type === "reload" || entry?.type === "back_forward";
}

function storedBooking(storageKey: string): KeptBooking | null {
  try {
    return readKept(window.sessionStorage.getItem(storageKey), Date.now());
  } catch {
    return null; // storage switched off in the browser: nothing was kept
  }
}

/** Keep the booking in the making in the tab, or take it away (null, or nothing worth keeping). */
function storeBooking(storageKey: string, kept: KeptBooking | null): void {
  try {
    const text = kept ? keptText(kept) : null;
    if (text === null) window.sessionStorage.removeItem(storageKey);
    else window.sessionStorage.setItem(storageKey, text);
  } catch {
    // Storage switched off in the browser: nothing is kept, and the booking goes on as before.
  }
}

/**
 * What the tab kept of a booking in the making (src/lib/booking-progress.ts), for a screen that is shown where it was
 * left: on an entry of the history marked as one of its steps, or in a document the browser brought back by a refresh
 * or its Back and Forward buttons. A screen opened afresh, by a link or a typed address, starts empty: null.
 * Undefined on the server and while the page starts, when it has not been read yet: the server draws an empty screen,
 * and the page has to start as that one.
 */
function useKeptBooking(storageKey: string): KeptBooking | null | undefined {
  const [screen] = useState(() => ({}));
  return useSyncExternalStore(
    subscribeNever,
    () => {
      if (!keptAtStart.has(screen)) {
        const first = !screenDrawnBefore;
        screenDrawnBefore = true;
        const marked = /^#step-/.test(window.location.hash);
        const kept = marked || (first && documentCameBack()) ? storedBooking(storageKey) : null;
        // A screen that starts afresh is a new booking: what an earlier one left in the tab is taken away, here, where
        // it was decided. The screen itself writes nothing until something on it changes (see its effect): while the
        // page starts, the empty screen the server drew is on show, and this is read only after its effects have run.
        if (!kept) storeBooking(storageKey, null);
        keptAtStart.set(screen, kept);
      }
      return keptAtStart.get(screen) ?? null;
    },
    () => undefined,
  );
}

interface BookingFlowProps {
  catalog: Catalog;
  /**
   * The studio policies of the policies step (the owner's brief of 2026-11-22, item 6), drawn by the booking page from
   * the website's Policies page. Null when the site has none published: the step then shows only the agreements.
   */
  policies?: CheckoutPolicies | null;
  navigate?: (url: string) => void;
  /**
   * The photography flow: a session with the in-house photographer in one
   * studio. The same steps as renting a studio, with a package in place of a
   * duration, and with times at which the photographer is free too.
   */
  photography?: boolean;
  /** Whose sessions, in the session flow: the photographer's or the content creator's (question 69). */
  service?: Service;
}

/**
 * The booking screen. What a client chose and typed is kept in the tab while the booking is in the making, so that a
 * refresh, or the browser's Back button from another page, brings it back (src/lib/booking-progress.ts). With something
 * kept, the screen is made anew from it once the page has started: the server drew it empty.
 */
export function BookingFlow(props: BookingFlowProps) {
  const storageKey = `booking-in-the-making:${props.photography ? (props.service ?? "photography") : "rental"}`;
  const kept = useKeptBooking(storageKey);
  return <BookingWizard key={kept ? "kept" : "new"} kept={kept ?? null} ready={kept !== undefined} storageKey={storageKey} {...props} />;
}

function BookingWizard({
  catalog,
  navigate = loadPage,
  photography = false,
  service = "photography",
  policies = null,
  kept,
  ready,
  storageKey,
}: BookingFlowProps & {
  /** What the tab kept of this booking, to start from; null for a screen that starts empty. */
  kept: KeptBooking | null;
  /**
   * Whether what the tab kept has been read. Not while the page starts: the screen on show is then the empty one the
   * server drew, and it leaves the address and the browser's history alone, or it would take away the step's mark
   * before the screen made from what was kept reads it (the development server's runs of 2026-11-27).
   */
  ready: boolean;
  storageKey: string;
}) {
  const words = SERVICE_WORDS[service];
  const router = useRouter();
  const searchParams = useSearchParams();

  // `?by=date` opens the date-first path, as the home page's "Know the time?" does (the owner's brief of 2026-11-24, item 2).
  const [mode, setMode] = useState<Mode>(() => (photography ? "studio" : kept ? kept.mode : searchParams.get("by") === "date" ? "time" : "studio"));
  // With something kept, the step the address marks, as far as what was kept answers the steps before it.
  const [stepIndex, setStepIndex] = useState(() => {
    if (!kept) return 0;
    const steps = ORDER[photography ? "studio" : kept.mode];
    return stepToShowAgain(kept, Math.max(0, stepOfHash(window.location.hash, steps)), steps);
  });
  /** Whether the lengths behind "More" are shown. */
  const [moreLengths, setMoreLengths] = useState(kept?.moreLengths ?? false);
  // A link can choose the studios, the day and the length: `?studio=paris,dayglow&date=…&duration=120`, as the
  // waitlist's email does (src/server/waitlist.ts).
  const [studioIds, setStudioIds] = useState<string[]>(() => {
    const slugs = (searchParams.get("studio") ?? "").split(",");
    const chosen = catalog.studios.filter((s) => (kept ? kept.studioIds.includes(s.id) : slugs.includes(s.slug))).map((s) => s.id);
    return photography ? chosen.slice(0, 1) : chosen;
  });
  /** What the date field holds. While a date is typed it passes through values such as 0002-12-28. */
  const [dateInput, setDateInput] = useState(() => {
    if (kept) return kept.date;
    const linked = searchParams.get("date") ?? "";
    return isIsoDate(linked) ? linked : "";
  });
  /** The date chosen: what the field holds, once that is a real date. */
  const date = isIsoDate(dateInput) ? dateInput : "";
  const [durationChoice, setDuration] = useState(() => (kept ? kept.duration : Number(searchParams.get("duration")) || 0));
  const [start, setStart] = useState<number | null>(kept?.start ?? null);
  /** The time the keyboard last reached: the times' one Tab stop (`moveAmongTimes`). */
  const [timeFocus, setTimeFocus] = useState<number | null>(null);
  /** How many of each add-on: 1 for one ticked, more for one taken in a quantity (an extra guest). */
  const [addonCounts, setAddonCounts] = useState<Record<string, number>>(() =>
    // An add-on the owners took away since is not brought back.
    Object.fromEntries(Object.entries(kept?.addonCounts ?? {}).filter(([id]) => catalog.addons.some((addon) => addon.id === id))),
  );
  const [name, setName] = useState(kept?.name ?? "");
  const [email, setEmail] = useState(kept?.email ?? "");
  const [phone, setPhone] = useState(kept?.phone ?? "");
  /** A signed-in client's own details were asked for (`fetchOwnDetails`): once for each screen. */
  const ownAsked = useRef(false);
  const [notes, setNotes] = useState(kept?.notes ?? "");
  // The agreement to the policies is not kept: it is given again after a refresh.
  const [terms, setTerms] = useState(false);
  /** The questions and agreements of the policies step, for the booking they were read for (`key`). */
  const [forms, setForms] = useState<{ key: string; questions: FormQuestion[]; agreements: FormAgreement[] } | null>(null);
  /** The client's answers to the intake questions, by question. */
  const [answers, setAnswers] = useState<Record<string, string | boolean>>(kept?.answers ?? {});
  /**
   * The statements the client initialed (the owner, 2026-11-27), by statement: the initials they clicked in, and the
   * words they stood beside. One counts only while both are still so: another name gives other initials, and other
   * words are another statement. Like the agreement, not kept through a refresh.
   */
  const [initialed, setInitialed] = useState<Record<string, { initials: string; words: string }>>({});
  /** Whether the client has scrolled to the end of the policies: the agreement can be ticked only then. */
  const [readToEnd, setReadToEnd] = useState(false);
  const policiesBox = useRef<HTMLDivElement>(null);
  /** How many of each prop are free at the chosen time (the owner's admin brief of 2026-11-22, item 10), for `key`. */
  const [propsFreeNow, setPropsFreeNow] = useState<{ key: string; free: Record<string, number>; away: string[] } | null>(null);
  const [codeInput, setCodeInput] = useState(kept?.codeInput ?? "");
  const [applied, setApplied] = useState<AppliedCode | null>(kept?.applied ?? null);
  const [codeError, setCodeError] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);

  const today = useSyncExternalStore(subscribeNever, browserToday, serverToday);
  const [availability, setAvailability] = useState<DayAvailability | null>(null);
  /** The month the calendar shows, once the client has moved it; until then, the chosen date's or the first open one's. */
  const [shownMonth, setShownMonth] = useState("");
  /** Which days of a month the chosen length fits on, for the studios chosen (`key`): from `/api/availability/month`. */
  const [monthDays, setMonthDays] = useState<{ key: string; days: Record<string, boolean> } | null>(null);
  /** The latest month asked for: an answer to an earlier question is not shown over it. */
  const monthRequest = useRef(0);
  const [loadingSlots, setLoadingSlots] = useState(false);
  /** The day whose times were asked for last (`fetchAvailability`). */
  const askedDateRef = useRef("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  /**
   * The id of the attempt to book on its way. Sent again with a retry that
   * follows no answer at all (the connection dropped), so that a booking that
   * was made and paid is found and not made again; any answer, and any step
   * back, ends the attempt.
   */
  const requestIdRef = useRef<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  // A new step takes the keyboard's focus to its heading. The button that was pressed goes away with its step, so
  // without this the next Tab starts again from the top of the page, and a screen reader says nothing of the change.
  // Not on the first one: the page has only just opened.
  const shownStep = useRef(stepIndex);
  useEffect(() => {
    if (shownStep.current === stepIndex) return;
    shownStep.current = stepIndex;
    topRef.current?.querySelector<HTMLElement>(".wizard-panel h3")?.focus({ preventScroll: true });
  }, [stepIndex]);

  const steps = ORDER[mode];
  const step = steps[stepIndex];

  // ── The browser's history, and what the tab keeps (src/lib/booking-progress.ts) ──
  /**
   * How many entries of the browser's history, right below this one, are earlier steps of this booking: what "← Back"
   * goes back through. 0 when the screen cannot tell (it was opened on this step): "← Back" then changes this entry.
   */
  const depth = useRef(kept?.depth ?? 0);
  /** The moves through the history that the screen made itself, each of which the browser reports once: they need no answer. */
  const ownMoves = useRef(0);
  /** The address of the page the screen is on: an entry of another page is the router's to show. */
  const ownPath = useRef("");
  /** The booking was made: nothing is kept of it any more. */
  const made = useRef(false);
  /** What a step reads when it is reached was read for the step the screen started on. */
  const startRead = useRef(false);
  // What the browser's events call, as it is on the latest drawing of the screen (set below, after those functions).
  const onShown = useRef(() => {});
  const onHistory = useRef(() => {});
  // Kept in the tab as it changes, until the booking is made. Nothing is written while the screen is as it started:
  // the empty screen the server drew is on show while the page starts, before what the tab kept is read
  // (`useKeptBooking`), and writing then would take that away (the development server's and WebKit's runs of
  // 2026-11-27, where a refresh brought nothing back).
  const startedAs = useRef<string | null>(null);
  useEffect(() => {
    if (made.current) return;
    const now = {
      mode,
      studioIds,
      date: isIsoDate(dateInput) ? dateInput : "",
      duration: durationChoice,
      start,
      moreLengths,
      addonCounts: Object.fromEntries(Object.entries(addonCounts).filter(([, count]) => count > 0)),
      name,
      email,
      phone,
      notes,
      answers,
      codeInput,
      applied,
    };
    const state = JSON.stringify([stepIndex, now]);
    startedAs.current ??= state;
    if (startedAs.current === state) return;
    // Changed once, it is written from then on, also when it comes back to how it started.
    startedAs.current = "";
    storeBooking(storageKey, { ...now, at: Date.now(), depth: depth.current });
  }, [storageKey, mode, stepIndex, studioIds, dateInput, durationChoice, start, moreLengths, addonCounts, name, email, phone, notes, answers, codeInput, applied]);
  const { settings, rules, bundlePrices } = catalog;
  // The sales on now (src/lib/domain/sale.ts), by the studio's day: for the day chosen, and before one is chosen for
  // any day, as a price list shows them. A session has a price of its own and is never on sale. The server works the
  // same out again for what it charges.
  const salesNow = useMemo(() => (photography ? [] : salesInForce(catalog.sales, today, date || null)), [photography, catalog.sales, today, date]);
  const sale = useMemo(() => bookingSale(salesNow, catalog.studios.map((studio) => studio.id)), [salesNow, catalog.studios]);
  /** The studios' prices as the sale lowers them, to show beside the usual ones. */
  const saleRules = useMemo(() => listsOnSale(rules, bundlePrices, sale).rules, [rules, bundlePrices, sale]);
  /** The sale of the studios chosen, as the server works it out (`saleFor`): what the booking is priced under. */
  const ownSale = useMemo(() => bookingSale(salesNow, studioIds), [salesNow, studioIds]);

  const dayType: DayType = date ? (catalog.specialDates[date] ?? defaultDayType(date)) : "weekday";
  /**
   * How far ahead this kind of booking has to be made. A session with the photographer needs more notice; content
   * creation's is business days (question 69), from the start of its first day.
   */
  const contentNotice = photography && service === "content";
  const leadHours = contentNotice ? 0 : noticeHours(settings, photography);
  const noticeWords = contentNotice ? businessDaysInWords(settings.contentNoticeBusinessDays) : hoursInWords(leadHours);
  /** The first date that can have a free time at all: whole days of notice from today. */
  const firstDate = today ? (contentNotice ? afterBusinessDays(today, settings.contentNoticeBusinessDays) : addDays(today, Math.floor(leadHours / 24))) : "";
  // The month calendar (the owner's brief of 2026-11-22, item 3): from the first month with a day that can be booked to
  // the month bookings open up to.
  const firstMonth = firstDate.slice(0, 7);
  const lastMonth = today ? addDays(today, settings.maxAdvanceDays).slice(0, 7) : "";
  const month = shownMonth || (date ? date.slice(0, 7) : firstMonth);
  const monthKeyOf = (forMonth: string, minutes: number) => `${forMonth}|${studioIds.join(",")}|${minutes}|${photography ? service : 0}`;

  // ── What can be chosen ─────────────────────────────────────────────────────
  /** The session packages of the chosen studio, shortest first. Only in the photography flow. */
  const packages = useMemo(
    () =>
      photography
        ? sessionsOf(catalog.photoPackages, service)
            .filter((p) => p.studioId === studioIds[0])
            .sort((a, b) => a.durationMinutes - b.durationMinutes)
        : [],
    [photography, service, catalog.photoPackages, studioIds],
  );

  const durations = useMemo(() => {
    if (photography) return packages.map((p) => p.durationMinutes);
    if (mode === "studio") {
      // The length is chosen before the day: every length the studios are priced for on some kind of day. Once a day is
      // chosen, those of its kind of day, which the month calendar only offers days for.
      if (date) return bookableDurations(studioIds, dayType, rules, bundlePrices);
      return [...new Set([...bookableDurations(studioIds, "weekday", rules, bundlePrices), ...bookableDurations(studioIds, "weekend", rules, bundlePrices)])].sort((a, b) => a - b);
    }
    // The time first: every length a studio or a bundle is priced for on that kind of day.
    const all = new Set([...rules.filter((r) => r.dayType === dayType), ...bundlePrices].map((r) => r.durationMinutes));
    return [...all].sort((a, b) => a - b);
  }, [photography, packages, mode, studioIds, date, dayType, rules, bundlePrices]);

  /** The chosen studios' own price list together, when the owners gave them one: the same on every day. */
  const together = useMemo(() => (photography ? [] : bundleList(studioIds, bundlePrices)), [photography, studioIds, bundlePrices]);
  /**
   * The owners' first lengths as buttons, and the rest behind "More" (the owner, 2026-11-25: "remove 5 hours so 1, 2, 3,
   * 4, 6 more"): `shownLengths`.
   */
  const firstShown = catalog.settings.shownLengthsMinutes;
  const { shown: shownDurations, more: moreDurations } = useMemo(() => shownLengths(durations, firstShown), [durations, firstShown]);
  /** A chosen duration stops counting once the current selection no longer offers it. */
  const duration = durations.includes(durationChoice) ? durationChoice : 0;
  /** A length chosen from behind "More" keeps them shown. */
  const moreChosen = moreDurations.includes(duration);
  const moreOpen = moreLengths || moreChosen;
  const shownDays = monthDays && monthDays.key === monthKeyOf(month, duration) ? monthDays.days : null;
  const session = photography ? (packages.find((p) => p.durationMinutes === duration) ?? null) : null;

  const slotOptions: SlotOptions | null = useMemo(
    () =>
      availability && duration > 0
        ? {
            durationMinutes: duration,
            incrementMinutes: settings.slotIncrementMinutes,
            earliestStartMinute: availability.earliestStartMinute,
          }
        : null,
    [availability, duration, settings.slotIncrementMinutes],
  );

  /** Studios that have a price for the chosen duration on this kind of day: their own, or one with other studios. */
  const pricedStudioIds = useMemo(
    () =>
      catalog.studios
        .filter((s) => findPrice(s.id, dayType, duration, rules) !== null || bundlePrices.some((price) => price.durationMinutes === duration && price.studioIds.includes(s.id)))
        .map((s) => s.id),
    [catalog.studios, dayType, duration, rules, bundlePrices],
  );

  const grid = useMemo(() => {
    if (!availability || !slotOptions || availability.problem) return null;
    return availabilityGrid(
      availability.days.filter((d) => pricedStudioIds.includes(d.studioId)),
      slotOptions,
    );
  }, [availability, slotOptions, pricedStudioIds]);

  const startsForChosenStudios = useMemo(() => {
    if (!availability || !slotOptions || availability.problem) return [];
    const days = studioIds.map((id) => availability.days.find((d) => d.studioId === id));
    if (days.length === 0 || days.some((d) => !d)) return [];
    if (photography) {
      // A session needs the photographer as well: only times at which both are free.
      if (!availability.photographer) return [];
      days.push(availability.photographer);
    }
    return combinedStarts(days as NonNullable<(typeof days)[number]>[], slotOptions);
  }, [availability, slotOptions, studioIds, photography]);

  const offeredTimes = mode === "studio" ? startsForChosenStudios : (grid?.times ?? []);
  // Join the waitlist (the owner's brief of 2026-11-22, item 4): in the studio-first flow, for a day that can be booked,
  // inside the hours every chosen studio is open.
  const waitlistHours = (() => {
    if (mode !== "studio" || !availability || availability.problem || duration <= 0 || studioIds.length === 0) return null;
    const days = studioIds.map((id) => availability.days.find((day) => day.studioId === id));
    if (days.some((day) => !day || day.openMinute === null || day.closeMinute === null)) return null;
    const open = Math.max(...days.map((day) => day!.openMinute!));
    const close = Math.min(...days.map((day) => day!.closeMinute!));
    return close - open >= duration ? { open, close } : null;
  })();
  // The times' one Tab stop: the time the keyboard last reached, else the chosen one, else the first.
  const timeStop =
    timeFocus !== null && offeredTimes.includes(timeFocus) ? timeFocus : start !== null && offeredTimes.includes(start) ? start : (offeredTimes[0] ?? null);

  const freeAtStart = useMemo(
    () => (grid && start !== null ? studiosFreeAt(grid, start) : []),
    [grid, start],
  );

  const availableAddons = catalog.addons.filter((a) => a.studioId === null || studioIds.includes(a.studioId));
  // Extra guests these studios can take: each studio's own, and the owners' limit for studios booked together.
  const guestsAllowed = extraGuestsFor(catalog, studioIds);
  /** The most of an add-on this booking can take. */
  /** The time the props' free counts were read for. */
  const propsKey = `${date}|${start}|${duration}`;
  /** How many of a prop are free at the chosen time; undefined for an add-on with no limit, or before they are read. */
  const freeOf = (addonId: string) => (propsFreeNow && propsFreeNow.key === propsKey ? propsFreeNow.free[addonId] : undefined);
  /** Whether a prop is away on the chosen day (marked unavailable for a while in Props & Resources). */
  const awayOf = (addonId: string) => propsFreeNow !== null && propsFreeNow.key === propsKey && propsFreeNow.away.includes(addonId);
  /** Why a prop cannot be taken, or fewer of it, at the chosen time. */
  const takenText = (addonId: string) => (awayOf(addonId) ? "Not available on this day." : "Already reserved at this time.");
  const mostOf = (addon: (typeof catalog.addons)[number]) =>
    Math.min(addon.kind === "people" ? Math.min(addon.maxQuantity, guestsAllowed) : addon.maxQuantity, freeOf(addon.id) ?? Number.POSITIVE_INFINITY);
  const studioOffer = multiStudioSaving(catalog) || bundleOffer(catalog);
  const combinationError = studioCombinationError(catalog.studios, studioIds);

  // A code is tied to an email address, so it stops applying if the address changes.
  const normalizedEmail = email.trim().toLowerCase();
  const current = applied && applied.email === normalizedEmail ? applied : null;
  const promo = current && !current.membership ? current : null;
  // A membership's hours pay only for the studios of its plan, never a photography session: chosen otherwise after the
  // code was applied, they are left out of the price, and the screen says why (the tester's finding of 2026-11-18).
  const memberApplied = current?.membership ? current : null;
  const memberFits = memberApplied !== null && !photography && studioIds.every((id) => memberApplied.membership!.studioIds.includes(id));
  const member = memberFits ? memberApplied : null;

  const price: Quote | null = useMemo(() => {
    if (studioIds.length === 0 || duration <= 0 || combinationError) return null;
    if (photography && !session) return null;
    try {
      return quote({
        studioIds,
        dayType,
        durationMinutes: duration,
        rules,
        bundlePrices,
        multiStudioPercent: settings.multiStudioPercent,
        addonCatalog: catalog.addons,
        extraGuestsAllowed: guestsAllowed,
        // A number chosen before the studios changed is kept within what the booking can now take.
        addons: availableAddons
          .map((addon) => ({ addonId: addon.id, quantity: Math.min(addonCounts[addon.id] ?? 0, mostOf(addon)) }))
          .filter((selection) => selection.quantity > 0),
        promo,
        bookingDay: date ? { date, special: date in catalog.specialDates } : null,
        membership: member?.membership ?? null,
        photoPackage: session ? { priceCents: session.priceCents, service: session.service } : null,
        tax: taxRuleFor(settings, Boolean(session)),
        sale: ownSale,
      });
    } catch {
      return null;
    }
    // availableAddons, guestsAllowed and mostOf are derived from studioIds and the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioIds, date, dayType, duration, rules, bundlePrices, ownSale, settings.multiStudioPercent, catalog.addons, addonCounts, promo, member, photography, session, combinationError]);

  const needsCard = price !== null && price.totalCents > 0;
  // The payment configuration and Square's card form, on the payment step of a booking that costs money.
  const cardForm = useCardForm(step === "pay" && needsCard, "card-container");

  // ── Loading data ───────────────────────────────────────────────────────────
  const fetchAvailability = useCallback(async (forDate: string) => {
    // Days are chosen one after another on the calendar: only the answer for the last one asked about is shown.
    askedDateRef.current = forDate;
    setLoadingSlots(true);
    try {
      const response = await fetch(`/api/availability?date=${encodeURIComponent(forDate)}${photography ? `&photography=1&service=${service}` : ""}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const answer = (await response.json()) as DayAvailability;
      if (askedDateRef.current === forDate) setAvailability(answer);
    } catch {
      if (askedDateRef.current === forDate) setError("Could not load availability. Please try again.");
    } finally {
      if (askedDateRef.current === forDate) setLoadingSlots(false);
    }
  }, [photography, service]);

  async function applyCode() {
    const code = codeInput.trim();
    if (!code || !price || checkingCode) return;
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      setCodeError("Enter your email address first: codes are tied to the address they were sent to.");
      return;
    }
    setCodeError("");
    setCheckingCode(true);
    try {
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studioIds,
          date,
          durationMinutes: duration,
          addons: price.addonLines.map((line) => ({ addonId: line.addonId, quantity: line.quantity })),
          promoCode: code,
          email: normalizedEmail,
          photography,
          service,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        promo?: Omit<AppliedCode, "email"> | null;
        membership?: { code: string; minutesLeft: number; weekendDifference: boolean; studioIds: string[]; studioNames: string[] } | null;
      };
      if (response.ok && data.ok && data.membership) {
        const { code: memberCode, ...membership } = data.membership;
        setApplied({ code: memberCode, kind: "amount", value: 0, membership, email: normalizedEmail });
        setCodeInput("");
      } else if (response.ok && data.ok && data.promo) {
        setApplied({ ...data.promo, email: normalizedEmail });
        setCodeInput("");
      } else {
        setCodeError(data.message || "That code could not be applied.");
      }
    } catch {
      setCodeError("Could not check the code. Please try again.");
    } finally {
      setCheckingCode(false);
    }
  }

  /** Read which days of a month a booking of the chosen studios fits on, for `minutes`. */
  async function fetchMonth(forMonth: string, minutes: number) {
    if (mode !== "studio" || !forMonth || minutes <= 0 || studioIds.length === 0) return;
    const request = ++monthRequest.current;
    const key = monthKeyOf(forMonth, minutes);
    try {
      const response = await fetch(
        `/api/availability/month?month=${forMonth}&studios=${studioIds.join(",")}&duration=${minutes}${photography ? `&photography=1&service=${service}` : ""}`,
        { cache: "no-store" },
      );
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; days?: Record<string, boolean> };
      if (request === monthRequest.current) setMonthDays({ key, days: response.ok && data.ok && data.days ? data.days : {} });
    } catch {
      if (request === monthRequest.current) setMonthDays({ key, days: {} });
    }
  }

  /** The booking the policies step's questions and agreements were read for. */
  const formsKey = `${studioIds.join(",")}|${date}|${photography ? 1 : 0}`;
  const studioName = (id: string) => catalog.studios.find((s) => s.id === id)?.name ?? "";
  const chosenNames = studioIds.map(studioName).join(" + ");
  /** The client's initials, from the full name they gave at the details. */
  const initials = initialsOf(name);
  /** The statements of the booking's form that are initialed, apart from its questions. */
  const statements = (forms?.questions ?? []).filter((question) => question.kind === "initials");
  const isInitialed = (statement: FormQuestion) => initials !== "" && initialed[statement.id]?.initials === initials && initialed[statement.id]?.words === statement.label;

  /** Read how many of each prop are free at the chosen time (`/api/props-free`). The booking checks again. */
  async function fetchPropsFree() {
    if (!date || start === null || duration <= 0) return;
    const key = propsKey;
    try {
      const response = await fetch(`/api/props-free?date=${date}&start=${start}&duration=${duration}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; free?: Record<string, number>; away?: string[] };
      if (response.ok && data.ok) setPropsFreeNow({ key, free: data.free ?? {}, away: data.away ?? [] });
    } catch {
      // Without the counts the add-ons are offered as usual, and the booking says if a prop is taken.
    }
  }

  /**
   * A signed-in client's own name, email address and phone number, into the fields that are still empty, so that they
   * are not typed again (`/api/own-details`; the owners' decision of 2026-11-27). Asked once, when the details are
   * first reached, and only when the menu's cookie says someone is signed in: the page is the same for everyone. Not
   * as the page opens: WebKit reports a request still on its way when a page is left as an error of that page. And not
   * with the page itself: drawn for each request, the screen came late, and a link pressed meanwhile led nowhere
   * (React's error #412; CI's WebKit jobs of 2026-11-27).
   */
  async function fetchOwnDetails() {
    if (ownAsked.current || !hintsSignedIn(document.cookie)) return;
    ownAsked.current = true;
    try {
      const response = await fetch("/api/own-details", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { details?: OwnDetails | null };
      const own = response.ok ? data.details : null;
      if (!own) return;
      // Only what is still empty: what the client typed, or what a refresh brought back, stays.
      setName((typed) => typed || own.name);
      setEmail((typed) => typed || own.email);
      setPhone((typed) => typed || own.phone);
    } catch {
      // Without an answer the fields stay empty, as they were before.
    }
  }

  /** Read the questions and agreements a booking of these studios on this day meets (`/api/checkout-forms`). */
  async function fetchForms() {
    const key = formsKey;
    try {
      const response = await fetch(`/api/checkout-forms?studios=${studioIds.join(",")}&date=${date}${photography ? `&service=${service}` : ""}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; questions?: FormQuestion[]; agreements?: FormAgreement[] };
      if (!response.ok || !data.ok) throw new Error();
      setForms({ key, questions: data.questions ?? [], agreements: data.agreements ?? [] });
    } catch {
      setError("Could not load the studio's booking form. Please try again.");
    }
  }

  /** Whether the policies box is read to its end, or so short that there is nothing to scroll. */
  function noticeEnd(box: HTMLDivElement | null) {
    if (box && box.scrollTop + box.clientHeight >= box.scrollHeight - 4) setReadToEnd(true);
  }

  function showMonth(next: string) {
    setShownMonth(next);
    void fetchMonth(next, duration);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  /** What a step shows that is read when the step is reached. */
  function readFor(target: Step, options: { refetch?: boolean } = {}) {
    // Availability is read fresh whenever the customer reaches a step that shows it.
    if ((target === "when" || target === "studios") && date && (options.refetch || availability?.date !== date)) {
      void fetchAvailability(date);
    }
    // The month calendar is read fresh on each arrival too: bookings change while the client looks.
    if (target === "when" && duration > 0) void fetchMonth(month, duration);
    // The props free at the chosen time are read on each arrival at the details, where the add-ons are.
    if (target === "details") {
      void fetchPropsFree();
      void fetchOwnDetails();
    }
    // The booking form and agreements are read again for each booking they are shown for.
    if (target === "policies" && (options.refetch || forms?.key !== formsKey)) void fetchForms();
  }

  /** Show a step. The browser's history is the caller's to move: `next`, `back` and `fromHistory`. */
  function go(index: number, options: { refetch?: boolean } = {}) {
    requestIdRef.current = null;
    cardForm.newAttempt();
    setError("");
    setStepIndex(index);
    readFor(steps[index], options);
    topRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  /**
   * To an earlier step, by "← Back" or after the server refused the booking: shown at once, and the browser's history
   * goes back through this booking's own entries, where they are below this one. Where they are not (the screen was
   * opened on this step), this entry takes the earlier step's mark.
   */
  function back(index: number, options: { refetch?: boolean } = {}) {
    const by = stepIndex - index;
    go(index, options);
    if (by <= 0) return;
    if (depth.current >= by) {
      depth.current -= by;
      ownMoves.current += 1;
      window.history.go(-by);
    } else {
      depth.current = 0;
      window.history.replaceState(null, "", stepHash(steps[index]));
    }
  }

  /** The screen is on show (see the effect before `next`): its entry of the history marks the step it shows, and a screen that started from what was kept reads what its step needs. */
  function shown() {
    ownPath.current = window.location.pathname;
    const marked = stepOfHash(window.location.hash, steps);
    const below = marked - stepIndex;
    if (ownMoves.current > 0) {
      // A move of the screen's own through the history is on its way: React's development mode runs every effect
      // twice, and the second run would go back once more. The entry it arrives at is looked at there (`fromHistory`).
    } else if (below > 0 && depth.current >= below) {
      // An earlier step than this entry marks: the policies, after a refresh on the payment step. The history goes back
      // to that step's own entry, so that the browser's Back button then shows the step before it.
      depth.current = Math.min(depth.current - below, stepIndex);
      ownMoves.current += 1;
      window.history.go(-below);
    } else if (marked !== stepIndex && (marked !== -1 || stepIndex > 0)) {
      // Not the step this entry marked, and the screen does not know of its own entries below: nothing kept answered the
      // steps before it, or the router brought this screen back on an entry of its own. The entry takes the step's mark.
      depth.current = 0;
      window.history.replaceState(null, "", stepIndex > 0 ? stepHash(steps[stepIndex]) : `${window.location.pathname}${window.location.search}`);
    } else {
      depth.current = Math.min(depth.current, stepIndex);
    }
    if (kept && !startRead.current) {
      startRead.current = true;
      // Once this drawing is done: what it reads sets state.
      void Promise.resolve().then(() => readFor(steps[stepIndex], { refetch: true }));
    }
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setStart(null);
    if (next === "time") setStudioIds([]);
    setError("");
    setStepIndex(0);
    // The other path begins at its own first step: the history goes back to this booking's first entry, where the
    // screen knows of it, and that entry takes the first step's mark (`fromHistory`, or here when it is this one).
    if (stepIndex > 0 && depth.current >= stepIndex) {
      depth.current = 0;
      ownMoves.current += 1;
      window.history.go(-stepIndex);
    } else {
      depth.current = 0;
      if (stepIndex > 0 || stepOfHash(window.location.hash, steps) !== -1) window.history.replaceState(null, "", stepHash(ORDER[next][0]));
    }
  }

  function toggleStudio(id: string) {
    setError("");
    if (photography) {
      // A session is in one studio: choosing another replaces the choice.
      setStudioIds([id]);
      setStart(null);
      return;
    }
    setStudioIds((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      // Keep the catalog's order so prices and names always list the same way.
      return catalog.studios.map((s) => s.id).filter((x) => next.includes(x));
    });
    if (mode === "studio") setStart(null);
  }

  function chooseDate(value: string) {
    setDateInput(value);
    // A date typed in another month moves the calendar there.
    if (isIsoDate(value) && value.slice(0, 7) !== month) {
      setShownMonth(value.slice(0, 7));
      void fetchMonth(value.slice(0, 7), duration);
    }
    setStart(null);
    setAvailability(null);
    if (mode === "time") setStudioIds([]);
    // Its times, at once, beside the calendar.
    if (step === "when") readTimes(value);
  }

  /** The start times of a day, read for the date step. A past day, or a date still being typed, has none: said without asking. */
  function readTimes(forDate: string) {
    if (!isIsoDate(forDate)) return;
    if (today && forDate < today) {
      askedDateRef.current = forDate;
      setLoadingSlots(false);
      return;
    }
    void fetchAvailability(forDate);
  }

  function chooseDuration(minutes: number) {
    setDuration(minutes);
    setStart(null);
    void fetchMonth(month, minutes);
    if (mode === "time") setStudioIds([]);
  }

  function chooseStart(minute: number) {
    setStart(minute);
    // The time chosen becomes the times' Tab stop: Safari gives a clicked button no focus of its own.
    setTimeFocus(minute);
    if (mode === "time") setStudioIds([]);
  }

  function validate(current: Step): string {
    switch (current) {
      case "studios":
        if (studioIds.length === 0) return "Please select at least one studio.";
        if (combinationError) return combinationError;
        // The time first: the length was chosen before the studios, and not every studio or bundle is sold for it.
        if (!photography && mode === "time" && duration > 0 && unpriced(studioIds, dayType, duration, rules, bundlePrices)) {
          return `${chosenNames} ${studioIds.length > 1 ? "are not offered together" : "is not offered by itself"} for ${durationLabel(duration)}. Choose other studios, or go back and choose another length.`;
        }
        return "";
      case "when":
        if (!date) return "Please select a date.";
        if (!duration) return "Please select a duration.";
        return start === null ? "Please select a time." : "";
      case "details":
        if (name.trim().length < 2) return "Please enter your name.";
        // The booking's own rule (src/lib/parse.ts): an address taken here is never refused at "Confirm & pay".
        if (!EMAIL_RULE.test(email.trim())) return "Please enter a valid email address.";
        if (!hasPhoneDigits(phone)) return "Please enter a phone number with at least 7 digits.";
        return "";
      case "policies": {
        if (!forms || forms.key !== formsKey) return "The studio's booking form is still loading.";
        const missing = forms.questions.find(
          (question) => question.kind !== "initials" && question.required && (question.kind === "checkbox" ? answers[question.id] !== true : !String(answers[question.id] ?? "").trim()),
        );
        if (missing) return `Please answer: ${missing.label}`;
        if (!readToEnd) return "Please read the policies to the end.";
        if (!statements.every(isInitialed)) return "Please add your initials to each statement.";
        if (!terms) return "Please agree to the studio policies to continue.";
        return "";
      }
      default:
        return "";
    }
  }

  /**
   * The browser moved to another entry of its history, by its Back or Forward button: the screen shows that entry's
   * step. Forward only as far as what is chosen now answers the steps on the way: the client may have changed
   * something after going back.
   */
  function fromHistory() {
    if (window.location.pathname !== ownPath.current) return;
    const marked = stepOfHash(window.location.hash, steps);
    if (ownMoves.current > 0) {
      ownMoves.current -= 1;
      // The entry it came to shows the step the screen shows: after the path was switched, its first step is another.
      if (marked !== stepIndex && (marked !== -1 || stepIndex > 0)) window.history.replaceState(null, "", stepHash(steps[stepIndex]));
      return;
    }
    // An entry with no mark is the booking's first.
    const target = Math.max(0, marked);
    if (target === stepIndex) return;
    if (submitting) {
      // A booking is on its way: the screen waits for its answer where it is, and the history comes back to it.
      ownMoves.current += 1;
      window.history.go(stepIndex - target);
      return;
    }
    if (target < stepIndex) {
      depth.current = Math.max(0, depth.current - (stepIndex - target));
      go(target, { refetch: true });
      return;
    }
    let reach = stepIndex;
    while (reach < target && !validate(steps[reach])) reach += 1;
    depth.current += target - stepIndex;
    if (reach !== stepIndex) go(reach, { refetch: true });
    if (reach !== target) {
      // This entry now shows an earlier step than the ones below it: "← Back" changes it, and does not go back through them.
      depth.current = 0;
      window.history.replaceState(null, "", stepHash(steps[reach]));
    }
  }

  useEffect(() => {
    onShown.current = shown;
    onHistory.current = fromHistory;
  });
  // The screen is on show: when it is first drawn, and again when the router brings back a page it kept (a page that was
  // left stays in the document, hidden, and its effects end until it shows again).
  useEffect(() => {
    if (!ready) return;
    onShown.current();
    const moved = () => onHistory.current();
    window.addEventListener("popstate", moved);
    return () => window.removeEventListener("popstate", moved);
  }, [ready]);

  function next() {
    const problem = validate(step);
    if (problem) return setError(problem);
    // Each step is an entry of the browser's history, so that its Back button goes a step back (the owners' decision of
    // 2026-11-27). The first one gets its mark as it is left: `/book` itself stays a booking that has not begun.
    if (stepIndex === 0 && stepOfHash(window.location.hash, steps) !== 0) window.history.replaceState(null, "", stepHash(steps[0]));
    go(stepIndex + 1);
    depth.current += 1;
    window.history.pushState(null, "", stepHash(steps[stepIndex + 1]));
  }

  async function submit(fake = false) {
    // FAKE PAYMENT: `fake` is the test button, which pays with no card.
    if (!price || start === null || submitting) return;
    setError("");
    setSubmitting(true);
    let leaving = false;
    try {
      let paymentToken: string | undefined;
      if (price.totalCents > 0 && fake) {
        paymentToken = FAKE_PAYMENT_TOKEN; // FAKE PAYMENT
      } else if (price.totalCents > 0) {
        // The card's bank may check the client here, on this page, before Square gives the token (3-D Secure). A press
        // after no answer sends the same token again: it is the same attempt (`useCardForm`).
        const card = await cardForm.token(buyerVerification({ amountCents: price.totalCents, intent: "CHARGE", name, email }));
        if (!card.ok) {
          setError(card.message);
          return;
        }
        paymentToken = card.token;
      }

      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studioIds,
          date,
          startMinute: start,
          durationMinutes: duration,
          customer: { name: name.trim(), email: email.trim(), phone: phone.trim() },
          notes: notes.trim(),
          addons: price.addonLines.map((line) => ({ addonId: line.addonId, quantity: line.quantity })),
          // A code that does not fit this selection is not used, which the summary says.
          promoCode: member ? member.code : promo && !price.promoMisfit ? promo.code : undefined,
          photography,
          service,
          acceptTerms: true,
          // The versions read on the policies step, and the answers given there (the owner's brief of 2026-11-22, item 6).
          // And the statements initialed, each with the words it stood beside.
          accepted: [
            ...(policies ? [policiesKey(policies.versionId)] : []),
            ...(forms?.agreements ?? []).map((agreement) => agreementKey(agreement.versionId)),
            ...statements.filter(isInitialed).map((statement) => initialsKey(statement.id, statement.label)),
          ],
          answers: Object.fromEntries(Object.entries(answers).filter(([id]) => forms?.questions.some((question) => question.id === id && question.kind !== "initials"))),
          paymentToken,
          expectedTotalCents: price.totalCents,
          requestId: (requestIdRef.current ??= newRequestId()),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        ref?: string;
        manageToken?: string;
        code?: string;
        message?: string;
      };
      if (response.ok && data.ok && data.ref && data.manageToken) {
        // Leave the button disabled: the page is about to be replaced.
        leaving = true;
        // Made: nothing of it is kept in the tab, and a later visit starts a new booking.
        made.current = true;
        storeBooking(storageKey, null);
        navigate(`/booking/${data.ref}?t=${encodeURIComponent(data.manageToken)}`);
        return;
      }
      // An answer: this attempt is over, and the next press is a new one. Unless it is still on its way.
      if (data.code !== "in_progress") {
        requestIdRef.current = null;
        cardForm.newAttempt();
      }
      if (data.code === "slot_taken") {
        setStart(null);
        back(steps.indexOf("when"), { refetch: true });
      }
      // Prices and add-ons on screen came with the page. When they have
      // changed since (a new price, an add-on withdrawn, a duration no longer
      // sold), reload them so the customer reviews what is offered now.
      const offerChanged = data.code === "price_changed" || data.code === "invalid_price";
      if (offerChanged) router.refresh();
      if (data.code === "invalid_code") {
        setApplied(null);
        back(steps.indexOf("details"));
      }
      // A prop chosen was taken by another booking at that time: back to the add-ons, with what is free now.
      if (data.code === "prop_taken") back(steps.indexOf("details"));
      // The policies or an agreement were published again meanwhile: the page shows them as they are now, read again.
      if (data.code === "policies_changed") {
        router.refresh();
        setTerms(false);
        setInitialed({});
        setReadToEnd(false);
        back(steps.indexOf("policies"), { refetch: true });
      }
      setError(
        data.code === "invalid_price"
          ? `${data.message || "Part of your selection is no longer offered."} This page now shows what is offered: please review your booking and confirm again.`
          : data.message || "Something went wrong. Please try again.",
      );
    } catch {
      // No answer at all: the attempt may have gone through. It keeps its id, so pressing again finds it if it did.
      setError(
        "We could not reach the studio's server, so we cannot tell whether your booking went through. Check your connection and press the button again: if it went through, you will see it, and your card is not charged twice.",
      );
    } finally {
      if (!leaving) setSubmitting(false);
    }
  }

  // ── Pieces of UI ───────────────────────────────────────────────────────────

  // Studios with one price together are one line (`studioPriceLines`).
  const studioLines = price ? studioPriceLines(price.studioLines.map((line) => ({ name: studioName(line.studioId), priceCents: line.priceCents })), price.multiStudioDiscountCents) : [];
  // Under a sale, the same lines at the usual prices, to cross out beside them.
  const usualLines = price?.usualStudioLines
    ? studioPriceLines(price.usualStudioLines.map((line) => ({ name: studioName(line.studioId), priceCents: line.priceCents })), price.multiStudioDiscountCents)
    : null;

  /** The sales tax, where the owners charge one: a line of its own, as the prices leave it out. */
  const taxLine = price && price.taxCents > 0 && (
    <div className="price-row price-tax">
      <span>{taxLabel(price.taxBasisPoints)}</span>
      <span>{formatCents(price.taxCents)}</span>
    </div>
  );
  const codeLine = price && promo && price.promoDiscountCents > 0 && (
    <div className="price-row price-discount">
      <span>
        {promo.kind === "percent"
          ? `Code ${promo.code} (${promo.value}% off ${photography ? "session" : "rental"})`
          : promo.kind === "free_hour"
            ? `Free hour, code ${promo.code}`
            : promo.source === "reschedule" || promo.source === undefined
              ? `Reschedule code ${promo.code}`
              : `Studio credit, code ${promo.code}`}
      </span>
      <span>{formatCents(-price.promoDiscountCents)}</span>
    </div>
  );

  const summary = price && start !== null && (
    <div className="price-summary">
      <div className="price-row">
        <span>When</span>
        <span>
          {longDateLabel(date)}, {minutesToLabel(start)} – {minutesToLabel(start + duration)}
        </span>
      </div>
      {studioLines.map((line, index) => (
        <div className="price-row" key={line.name}>
          <span>
            {session && `${words.Session}, `}
            {line.name}, {durationLabel(duration)}
            {session && (
              <>
                <br />
                <small>Studio included. {session.includes}.</small>
              </>
            )}
          </span>
          <span>
            <SalePrice cents={line.priceCents} usual={usualLines?.[index]?.priceCents} />
          </span>
        </div>
      ))}
      {price.saleCents !== undefined && ownSale && (
        <div className="price-row price-sale-note">
          <span>
            {ownSale.name}: {formatCents(price.saleCents)} off the usual price
          </span>
        </div>
      )}
      {price.multiStudioDiscountCents > 0 && (
        <div className="price-row price-discount">
          <span>Multi-studio discount ({price.multiStudioPercent}%)</span>
          <span>{formatCents(-price.multiStudioDiscountCents)}</span>
        </div>
      )}
      {price.addonLines.map((line) => (
        <div className="price-row" key={line.addonId}>
          <span>
            {line.name}
            {line.quantity > 1 ? ` × ${line.quantity}` : ""}
          </span>
          <span>{formatCents(line.totalCents)}</span>
        </div>
      ))}
      {/* A discount comes off before the tax. Credit is money paid before: it pays the total, tax included. */}
      {promo?.kind !== "amount" && codeLine}
      {member && price.membershipCents > 0 && (
        <div className="price-row price-discount">
          <span>
            Membership hours, code {member.code} ({durationLabel(price.membershipMinutes)})
          </span>
          <span>{formatCents(-price.membershipCents)}</span>
        </div>
      )}
      {taxLine}
      {promo?.kind === "amount" && codeLine}
      <div className="price-row total">
        <span>{promo || member ? "To pay" : "Total"}</span>
        <span>{formatCents(price.totalCents)}</span>
      </div>
      {session && (
        <p style={{ fontSize: ".8rem", margin: ".75rem 0 0" }}>
          A {words.session} is refunded when it is cancelled {hoursInWords(settings.photoRefundWindowHours)} or more
          before it starts{settings.refundFeePercent > 0 ? `, less the ${settings.refundFeePercent}% payment processing fee` : ""}.
        </p>
      )}
      {/* A sale and a discount code are not combined (the owner, 2026-11-28): the one that leaves less to pay is used. */}
      {promo && price.saleSetAside && ownSale && (
        <p className="price-sale-note" role="status" style={{ margin: ".75rem 0 0" }}>
          Code {promo.code} takes more off than the {ownSale.name} price would, so the code is used and the usual prices are shown: a discount code is not used on top of a
          sale&rsquo;s price.
        </p>
      )}
      {promo && price.promoMisfit && (
        <p className="field-error" role="status" style={{ margin: ".75rem 0 0" }}>
          {promoMisfitText(price.promoMisfit, promo, date ? { date, special: date in catalog.specialDates } : null)} Code {promo.code} is not used on this booking and stays yours.
        </p>
      )}
      {memberApplied && !member && (
        <p className="field-error" role="status" style={{ margin: ".75rem 0 0" }}>
          {photography
            ? `Membership hours are for studio rentals: they cannot pay for a ${words.session}.`
            : `The hours of membership ${memberApplied.code} are for ${orList(memberApplied.membership!.studioNames)}: they cannot pay for these studios.`}{" "}
          They are not used on this booking and stay yours.
        </p>
      )}
    </div>
  );

  const actions = (nextLabel?: string) => (
    <div className="wizard-actions">
      {stepIndex > 0 ? (
        <button type="button" className="btn btn-outline" onClick={() => back(stepIndex - 1)} disabled={submitting}>
          ← Back
        </button>
      ) : (
        <span />
      )}
      {nextLabel && (
        <button type="button" className="btn btn-dark" onClick={next}>
          {nextLabel} →
        </button>
      )}
    </div>
  );

  const nextLabelFor = (current: Step) => {
    const following = steps[steps.indexOf(current) + 1];
    return following ? `Next: ${STEP_LABEL[following]}` : undefined;
  };

  // The date step's two choices, which the studio-first flow shows length first (the owner's brief of 2026-11-22: Select
  // Studio, then Duration, then Date & Time) and the time-first flow date first.
  const dateField = (
    <div className="form-group">
      <label className="form-label" htmlFor="booking-date">
        Date
      </label>
      <input
        id="booking-date"
        type="date"
        className="form-control"
        value={dateInput}
        min={firstDate || undefined}
        max={today ? addDays(today, settings.maxAdvanceDays) : undefined}
        onChange={(event) => chooseDate(event.target.value)}
      />
    </div>
  );
  const lengthChoice = photography ? (
    <div className="form-group">
      <span className="form-label">Session</span>
      <div className="package-list">
        {packages.map((pack) => (
          <button
            type="button"
            key={pack.id}
            className={`package-btn${duration === pack.durationMinutes ? " selected" : ""}`}
            aria-pressed={duration === pack.durationMinutes}
            onClick={() => chooseDuration(pack.durationMinutes)}
          >
            <strong>
              {durationLabel(pack.durationMinutes)} · {formatCents(pack.priceCents)}
            </strong>
            <span>Studio included. {pack.includes}.</span>
          </button>
        ))}
        {packages.length === 0 && <p style={{ fontSize: ".85rem" }}>No sessions are offered in this studio.</p>}
      </div>
      {service === "photography" && (
        <p style={{ fontSize: ".8rem", margin: ".75rem 0 0" }}>
          Every session is shot on a professional camera by our in-house photographer. Your edited images are delivered
          within 7 to 14 days.
        </p>
      )}
    </div>
  ) : (
    <div className="form-group">
      <span className="form-label">Duration</span>
      <div className="duration-grid">
        {[...shownDurations, ...(moreOpen ? moreDurations : [])].map((minutes) => (
          <button
            type="button"
            key={minutes}
            className={`duration-btn${duration === minutes ? " selected" : ""}`}
            aria-pressed={duration === minutes}
            onClick={() => chooseDuration(minutes)}
          >
            {durationLabel(minutes).replace(" hours", " hr").replace(" hour", " hr").replace(/ minutes?/, " min")}
          </button>
        ))}
        {moreDurations.length > 0 && !moreChosen && (
          <button type="button" className="duration-btn duration-more" aria-expanded={moreOpen} onClick={() => setMoreLengths(!moreOpen)}>
            {moreOpen ? "Fewer" : "More"}
          </button>
        )}
        {durations.length === 0 && <p style={{ fontSize: ".85rem" }}>No durations are offered for this selection.</p>}
      </div>
    </div>
  );

  /**
   * The start times of the day chosen, on the date step (the owner's brief of 2026-11-24, item 3): beside the calendar on
   * a computer, below it on a phone; choosing another day shows its times here at once.
   */
  const timesPanel = (
    <section className="form-group when-times" aria-labelledby="when-times-title" aria-busy={loadingSlots || undefined}>
      <span className="form-label" id="when-times-title">
        {date ? `Start times, ${longDateLabel(date)}` : "Start times"}
      </span>
      {!date ? (
        <p className="month-cal-wait">{mode === "studio" ? "Choose a day to see its start times." : "Choose a date to see its start times."}</p>
      ) : today && date < today ? (
        <div className="notice">That date has already passed.</div>
      ) : duration <= 0 ? (
        <p className="month-cal-wait">Choose {photography ? "a session" : "a duration"} to see the start times.</p>
      ) : (
        <>
          {loadingSlots && (
            <div style={{ textAlign: "center", padding: "1.5rem" }}>
              <div className="spinner" />
              <p style={{ marginTop: "1rem", fontSize: ".9rem" }}>Checking availability…</p>
            </div>
          )}
          {!loadingSlots && availability && (
            <>
              <div className="time-slots" role="group" aria-label="Start times" onKeyDown={moveAmongTimes}>
                {offeredTimes.map((minute) => {
                  const freeCount = mode === "time" && grid ? studiosFreeAt(grid, minute).length : 0;
                  return (
                    <button
                      type="button"
                      key={minute}
                      className={`time-slot-btn${start === minute ? " selected" : ""}`}
                      aria-pressed={start === minute}
                      tabIndex={minute === timeStop ? 0 : -1}
                      onFocus={() => setTimeFocus(minute)}
                      onClick={() => chooseStart(minute)}
                    >
                      {minutesToLabel(minute)}
                      {mode === "time" && (
                        <small>
                          {freeCount} {freeCount === 1 ? "studio" : "studios"} free
                        </small>
                      )}
                    </button>
                  );
                })}
              </div>
              {offeredTimes.length === 0 && (
                <div className="notice" style={{ textAlign: "center" }}>
                  {availability.problem === "past"
                    ? "That date has already passed."
                    : availability.problem === "too_far"
                      ? `Bookings open ${count(settings.maxAdvanceDays, "day")} ahead.`
                      : firstDate && date < firstDate
                        ? `${photography ? `${words.Session}s` : "Bookings"} are made at least ${noticeWords} ahead. Please choose a later date.`
                        : mode === "studio" && studioIds.length > 1
                          ? "These studios are not free together on this date. Try another day, or fewer studios."
                          : "No times are available on this date. Please try another day."}
                </div>
              )}
            </>
          )}
          {/* Outside the times, which are read again while it stays: it keeps what it says when they reload. */}
          {waitlistHours && (
            <WaitlistJoin
              key={`${studioIds.join(",")}|${date}|${duration}`}
              studioIds={studioIds}
              photography={photography}
              service={service}
              durationMinutes={duration}
              date={date}
              openMinute={waitlistHours.open}
              closeMinute={waitlistHours.close}
              onFreeNow={() => void fetchAvailability(date)}
            />
          )}
        </>
      )}
    </section>
  );

  return (
    <div className="wizard-container" ref={topRef} style={{ scrollMarginTop: 90 }}>
      {salesNow.map((on) => (
        <p className="sale-banner" key={on.id}>
          <strong>{on.name}:</strong> {saleWords(on, catalog.studios)}.{saleCodesWords(on)}
        </p>
      ))}
      {!photography && (
        <div className="mode-toggle" role="radiogroup" aria-label="How would you like to book?">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "studio"}
            className={`mode-option${mode === "studio" ? " selected" : ""}`}
            onClick={() => switchMode("studio")}
          >
            <strong>I know which studio I want</strong>
            Choose studios, then see when they are free.
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "time"}
            className={`mode-option${mode === "time" ? " selected" : ""}`}
            onClick={() => switchMode("time")}
          >
            <strong>I want to choose the date first</strong>
            Choose a time, then see which studios are free.
          </button>
        </div>
      )}

      <div className="wizard-progress">
        {steps.map((s, i) => (
          <span key={s} style={{ display: "contents" }}>
            {i > 0 && <span className="wizard-connector" />}
            <span className={`wizard-step-label${i === stepIndex ? " active" : i < stepIndex ? " completed" : ""}`}>
              <span className="wizard-step-name">{STEP_LABEL[s]}</span>
            </span>
          </span>
        ))}
      </div>

      {error && (
        <div className="flash flash-error" role="alert">
          {error}
        </div>
      )}

      {/* ── Studios ── */}
      {step === "studios" && (
        <div className="wizard-panel active">
          <h3 tabIndex={-1} style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>
            {photography ? "Choose your studio" : mode === "time" ? "Studios free at your time" : "Select studio(s)"}
          </h3>
          <p className="text-muted mb-3">
            {photography
              ? "Your session takes place in one studio. The price of a session includes the studio."
              : mode === "time" && start !== null
                ? `${longDateLabel(date)}, ${minutesToLabel(start)} – ${minutesToLabel(start + duration)}. Choose one or more.`
                : "Choose one studio or a bundle for the same time."}
          </p>
          {mode === "time" && loadingSlots && <p>Checking availability…</p>}
          <div className="studio-selector">
            {catalog.studios.map((studio) => {
              const sessions = photography ? sessionsOf(catalog.photoPackages, service).filter((p) => p.studioId === studio.id) : [];
              const unavailable = photography ? sessions.length === 0 : mode === "time" && !freeAtStart.includes(studio.id);
              const cents = photography
                ? sessions.length > 0
                  ? Math.min(...sessions.map((p) => p.priceCents))
                  : null
                : mode === "time"
                  ? findPrice(studio.id, dayType, duration, saleRules)
                  : findPrice(studio.id, "weekday", 60, saleRules);
              // What it costs without the sale, to cross out.
              const usual = photography ? null : mode === "time" ? findPrice(studio.id, dayType, duration, rules) : findPrice(studio.id, "weekday", 60, rules);
              return (
                <label className={`studio-option${unavailable ? " disabled" : ""}`} key={studio.id}>
                  <input
                    type={photography ? "radio" : "checkbox"}
                    name={photography ? "session-studio" : undefined}
                    checked={studioIds.includes(studio.id)}
                    disabled={unavailable}
                    onChange={() => toggleStudio(studio.id)}
                  />
                  <div className="studio-option-card">
                    <div className="studio-check-mark">✓</div>
                    <h4>{studio.name}</h4>
                    <p style={{ fontSize: ".82rem", margin: ".35rem 0 .6rem" }}>{studio.tagline}</p>
                    <div className="studio-option-rate">
                      {photography
                        ? cents === null
                          ? "No sessions in this studio"
                          : `Sessions from ${formatCents(cents)}`
                        : unavailable
                          ? "Not available at this time"
                          : cents === null
                            ? mode === "time" && pricedStudioIds.includes(studio.id)
                              ? `For ${durationLabel(duration)}, in a bundle only`
                              : ""
                            : mode === "time" ? (
                              <>
                                <SalePrice cents={cents} usual={usual} /> for {durationLabel(duration)}
                              </>
                            ) : (
                              <>
                                From <SalePrice cents={cents} usual={usual} /> / hour
                              </>
                            )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          {!photography && together.length > 0 && price && mode === "time" ? (
            <p style={{ fontSize: ".85rem" }} role="status">
              {chosenNames} together: {formatCents(price.studiosSubtotalCents)} for {durationLabel(duration)}.
            </p>
          ) : (
            !photography && studioOffer && <p style={{ fontSize: ".85rem" }}>{studioOffer}.</p>
          )}
          {actions(nextLabelFor("studios"))}
        </div>
      )}

      {/* ── Date and duration ── */}
      {step === "when" && (
        <div className="wizard-panel active">
          <h3 tabIndex={-1} style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>{photography ? "Select date, session & time" : "Select date, duration & time"}</h3>
          <p className="text-muted mb-3">
            {mode === "studio" && chosenNames ? `${chosenNames}. ` : ""}
            {leadHours > 0 || contentNotice
              ? `${photography ? "Sessions" : "Bookings"} open ${noticeWords} to ${count(settings.maxAdvanceDays, "day")} ahead.`
              : `Bookings open up to ${count(settings.maxAdvanceDays, "day")} ahead.`}{" "}
            Times are Eastern Time.
          </p>
          {mode === "studio" ? (
            <div className="when-studio">
              <div className="when-length">{lengthChoice}</div>
              <div className="form-group when-day">
                <span className="form-label">Day</span>
                {duration > 0 && month ? (
                  <MonthCalendar month={month} firstMonth={firstMonth} lastMonth={lastMonth} days={shownDays} selected={date} onMonth={showMonth} onChoose={chooseDate} />
                ) : (
                  <p className="month-cal-wait">Choose {photography ? "a session" : "a duration"} to see the days it fits on.</p>
                )}
              </div>
              {timesPanel}
              <div className="month-cal-typed">
                <p>Or type the date:</p>
                {dateField}
              </div>
            </div>
          ) : (
            <>
              <div className="form-grid">
                {dateField}
                {lengthChoice}
              </div>
              {timesPanel}
            </>
          )}
          {mode === "studio" && price && (
            <div className="price-summary">
              {studioLines.map((line) => (
                <div className="price-row" key={line.name}>
                  <span>
                    {session && `${words.Session}, `}
                    {line.name}, {durationLabel(duration)}
                    {/* A bundle's own prices are the same on every day. */}
                    {date && !session && together.length === 0 ? ` (${dayType})` : ""}
                  </span>
                  <span>{formatCents(line.priceCents)}</span>
                </div>
              ))}
              {price.multiStudioDiscountCents > 0 && (
                <div className="price-row price-discount">
                  <span>Multi-studio discount ({price.multiStudioPercent}%)</span>
                  <span>{formatCents(-price.multiStudioDiscountCents)}</span>
                </div>
              )}
              {taxLine}
              <div className="price-row total">
                <span>Estimated total</span>
                <span>{formatCents(price.totalCents)}</span>
              </div>
            </div>
          )}
          {actions(nextLabelFor("when"))}
        </div>
      )}

      {/* ── Details ── */}
      {step === "details" && (
        <div className="wizard-panel active">
          <h3 tabIndex={-1} style={{ fontSize: "1.6rem", marginBottom: "1rem" }}>Your details</h3>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor="customer-name">
                Full name *
              </label>
              <input
                id="customer-name"
                className="form-control"
                autoComplete="name"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="customer-email">
                Email address *
              </label>
              <input
                id="customer-email"
                {...EMAIL_FIELD}
                className="form-control"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="customer-phone">
                Phone number *
              </label>
              <input
                id="customer-phone"
                type="tel"
                className="form-control"
                autoComplete="tel"
                maxLength={40}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="customer-notes">
              Notes / studio items you would like to use
            </label>
            <textarea
              id="customer-notes"
              className="form-control"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          {availableAddons.length > 0 && (
            <div className="price-summary">
              <span className="form-label">Add-ons</span>
              {availableAddons.map((addon) =>
                addon.maxQuantity > 1 ? (
                  // Taken in a quantity: how many, from none to what this booking can take.
                  <div className="addon-row addon-quantity" key={addon.id}>
                    <select
                      id={`addon-${addon.id}`}
                      className="form-control addon-count"
                      value={Math.min(addonCounts[addon.id] ?? 0, mostOf(addon))}
                      disabled={mostOf(addon) === 0}
                      aria-describedby={`addon-${addon.id}-limit`}
                      onChange={(event) => setAddonCounts((current) => ({ ...current, [addon.id]: Number(event.target.value) }))}
                    >
                      {Array.from({ length: mostOf(addon) + 1 }, (_, n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    {addon.picture && <AddonPicture picture={addon.picture} />}
                    <span className="addon-text">
                      <span className="addon-head">
                        <label htmlFor={`addon-${addon.id}`}>
                          <strong>{addon.name}</strong>
                        </label>
                        <span className="addon-price">{formatCents(addon.priceCents)} each</span>
                      </span>
                      {addon.description && <span className="addon-description">{addon.description}</span>}
                      <span className="addon-description" id={`addon-${addon.id}-limit`}>
                        {freeOf(addon.id) !== undefined && freeOf(addon.id)! < addon.maxQuantity
                          ? freeOf(addon.id) === 0
                            ? takenText(addon.id)
                            : `Up to ${freeOf(addon.id)}: the others are reserved at this time.`
                          : addon.kind !== "people"
                          ? `Up to ${addon.maxQuantity}.`
                          : guestsAllowed > 0
                            ? `Up to ${count(guestsAllowed, "extra guest")} with ${studioIds.length > 1 ? "these studios" : "this studio"}.`
                            : studioIds.length > 1
                              ? `No extra guests with these studios together: ${count(studioIds.length === 2 ? settings.twoStudioGuestLimit : settings.threeStudioGuestLimit, "guest")} at most in all, and their prices include that many.`
                              : "No extra guests with this studio."}
                      </span>
                    </span>
                  </div>
                ) : (
                <label className="addon-row" key={addon.id}>
                  <input
                    type="checkbox"
                    checked={Math.min(addonCounts[addon.id] ?? 0, mostOf(addon)) > 0}
                    disabled={mostOf(addon) === 0}
                    onChange={(event) => setAddonCounts((current) => ({ ...current, [addon.id]: event.target.checked ? 1 : 0 }))}
                  />
                  {addon.picture && <AddonPicture picture={addon.picture} />}
                  {/* The name and its price on one line, which puts the price under the name when both do not fit; the description below. */}
                  <span className="addon-text">
                    <span className="addon-head">
                      <strong>{addon.name}</strong>
                      <span className="addon-price">{formatCents(addon.priceCents)}</span>
                    </span>
                    {addon.description && <span className="addon-description">{addon.description}</span>}
                    {freeOf(addon.id) === 0 && <span className="addon-description addon-taken">{takenText(addon.id)}</span>}
                  </span>
                </label>
                ),
              )}
            </div>
          )}

          <div className="price-summary">
            <label className="form-label" htmlFor="promo-code">
              Have a code?
            </label>
            {current ? (
              <div className="price-row">
                <span>
                  Code <strong>{current.code}</strong> applied.
                  {member && price && price.membershipMinutes < duration && (
                    <>
                      {" "}
                      It has {durationLabel(member.membership!.minutesLeft)} left: the rest of the time is paid.
                    </>
                  )}
                </span>
                <button type="button" className="link-button" onClick={() => setApplied(null)}>
                  Remove
                </button>
              </div>
            ) : (
              <div className="code-row">
                <input
                  id="promo-code"
                  className="form-control"
                  placeholder={photography ? (service === "photography" ? "Photography code" : "Session code") : "Discount, reward, credit or membership code"}
                  autoCapitalize="characters"
                  autoComplete="off"
                  value={codeInput}
                  onChange={(event) => setCodeInput(event.target.value)}
                  // Enter does what "Apply" does: a code typed and entered is not left unchecked.
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void applyCode();
                  }}
                />
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={applyCode}
                  disabled={checkingCode || codeInput.trim() === ""}
                >
                  {checkingCode ? "Checking…" : "Apply"}
                </button>
              </div>
            )}
            {codeError && (
              <p className="field-error" role="alert">
                {codeError}
              </p>
            )}
            {applied && !current && (
              <p className="field-error">The code was removed because the email address changed. Apply it again.</p>
            )}
          </div>

          {summary}
          {actions(nextLabelFor("details"))}
        </div>
      )}

      {/* ── Policies and the booking form (the owner's brief of 2026-11-22, item 6) ── */}
      {step === "policies" && (
        <div className="wizard-panel active">
          <h3 tabIndex={-1} style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>
            Policies &amp; booking form
          </h3>
          {!forms || forms.key !== formsKey ? (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              <div className="spinner" />
            </div>
          ) : (
            <>
              {forms.questions.length > statements.length && (
                <fieldset className="intake-form">
                  <legend>A few questions</legend>
                  {forms.questions.filter((question) => question.kind !== "initials").map((question) => (
                    <IntakeField
                      key={question.id}
                      question={question}
                      value={answers[question.id]}
                      onChange={(value) => {
                        setAnswers((current) => ({ ...current, [question.id]: value }));
                        setError("");
                      }}
                    />
                  ))}
                </fieldset>
              )}
              <p className="text-muted" style={{ marginBottom: ".5rem" }}>
                Please read the studio policies and booking terms to the end.
              </p>
              <div
                className="policies-box"
                ref={(box) => {
                  policiesBox.current = box;
                  noticeEnd(box);
                }}
                onScroll={(event: UIEvent<HTMLDivElement>) => noticeEnd(event.currentTarget)}
                tabIndex={0}
                role="region"
                aria-label="Studio policies and booking terms"
              >
                {policies && <div className="rich-text" dangerouslySetInnerHTML={{ __html: policies.html }} />}
                {forms.agreements.map((agreement) => (
                  <section key={agreement.versionId} className="policies-agreement">
                    <h4>{agreement.title}</h4>
                    {agreement.body.split(/\n{2,}/).map((paragraph, index) => (
                      <p key={index}>{paragraph}</p>
                    ))}
                  </section>
                ))}
              </div>
              {statements.length > 0 && (
                <fieldset className="initials-form">
                  <legend>Please add your initials</legend>
                  <p className="initials-hint">
                    One click beside each statement adds your initials{initials && <>, <strong>{initials}</strong></>}, taken from the full name you gave.
                  </p>
                  {statements.map((statement) => {
                    const done = isInitialed(statement);
                    return (
                      <label key={statement.id} className={`initials-item${done ? " initialed" : ""}`}>
                        <input
                          type="checkbox"
                          checked={done}
                          onChange={(event) => {
                            setInitialed((current) => ({ ...current, [statement.id]: { initials: event.target.checked ? initials : "", words: statement.label } }));
                            setError("");
                          }}
                        />
                        {/* The box is the tick box as it looks: what it says is the box's own state. */}
                        <span className="initials-box" aria-hidden="true">
                          {done ? initials : "Initial"}
                        </span>
                        <span>
                          {statement.label}
                          {statement.help && <span className="intake-help">{statement.help}</span>}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}
              <label className={`policies-agree${readToEnd ? "" : " policies-agree-locked"}`}>
                <input
                  type="checkbox"
                  checked={terms}
                  disabled={!readToEnd}
                  onChange={(event) => {
                    setTerms(event.target.checked);
                    setError(""); // the usual reason an error is showing on this step
                  }}
                />
                <span>I have read and agree to The Visuals Photo Studio&rsquo;s policies and booking terms.</span>
              </label>
              {!readToEnd && <p className="policies-hint">Scroll to the end of the policies to agree.</p>}
            </>
          )}
          {actions(nextLabelFor("policies"))}
        </div>
      )}

      {/* ── Payment ── */}
      {step === "pay" && (
        <div className="wizard-panel active">
          <h3 tabIndex={-1} style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>Payment</h3>
          {summary}
          {!needsCard && price && (
            <div className="notice">Nothing to pay: your code covers this booking. No card is needed.</div>
          )}
          {needsCard && !cardForm.config && !cardForm.problem && <p>Loading payment form…</p>}
          {needsCard && cardForm.config?.mode === "mock" && (
            <div className="notice notice-warning">
              <strong>Test mode.</strong> No card processor is connected, so no card will be charged. The booking
              will be created as if payment succeeded.
            </div>
          )}
          {needsCard && cardForm.config?.mode === "disabled" && (
            <div className="notice notice-warning">
              Online payment is not available right now. Please contact the studio to book.
            </div>
          )}
          {needsCard && cardForm.config?.mode === "square" && (
            <>
              <span className="form-label" style={{ marginBottom: ".5rem" }}>
                Card details
              </span>
              <div id="card-container" />
              <p style={{ fontSize: ".75rem", marginTop: ".5rem" }}>
                Secured by Square. Card details never reach our servers.
              </p>
            </>
          )}
          {needsCard && cardForm.problem && (
            <div className="flash flash-error" role="alert">
              {cardForm.problem}
            </div>
          )}
          <div className="wizard-actions">
            <button type="button" className="btn btn-outline" onClick={() => back(stepIndex - 1)} disabled={submitting}>
              ← Back
            </button>
            {/* FAKE PAYMENT: the wrapper holds the test button beside the real one. */}
            <div className="wizard-actions-pay">
              <button
                type="button"
                className="btn btn-dark"
                onClick={() => submit()}
                disabled={
                  submitting ||
                  !price ||
                  (needsCard &&
                    (!cardForm.config || cardForm.config.mode === "disabled" || (cardForm.config.mode === "square" && !cardForm.ready)))
                }
              >
                {submitting
                  ? "Processing…"
                  : needsCard && price
                    ? `Confirm & pay ${formatCents(price.totalCents)}`
                    : "Confirm booking"}
              </button>
              {needsCard && cardForm.config?.fakePayment && (
                <button type="button" className="btn btn-outline" onClick={() => submit(true)} disabled={submitting || !price}>
                  {FAKE_PAYMENT_LABEL}
                </button>
              )}
            </div>
          </div>
          {needsCard && cardForm.config?.fakePayment && <p className="fake-payment-note">{FAKE_PAYMENT_NOTE}</p>}
        </div>
      )}
    </div>
  );
}

/** One question of the intake form, as its kind asks it. */
function IntakeField({ question, value, onChange }: { question: FormQuestion; value: string | boolean | undefined; onChange: (value: string | boolean) => void }) {
  const id = `intake-${question.id}`;
  const label = (
    <>
      {question.label}
      {question.required && " *"}
    </>
  );
  const help = question.help ? <span className="intake-help">{question.help}</span> : null;
  if (question.kind === "checkbox") {
    return (
      <label className="intake-check">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>
          {label}
          {help}
        </span>
      </label>
    );
  }
  if (question.kind === "choice") {
    return (
      <fieldset className="intake-choice">
        <legend>{label}</legend>
        {help}
        {question.options.map((option) => (
          <label key={option} className="intake-option">
            <input type="radio" name={id} value={option} checked={value === option} onChange={() => onChange(option)} /> {option}
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      {help}
      {question.kind === "dropdown" ? (
        <select id={id} className="form-control" value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {question.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <textarea id={id} className="form-control" rows={2} maxLength={1000} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />
      )}
    </div>
  );
}

/** An add-on's picture beside its name (Props & Resources), small: the name and price stay the row's first words. */
function AddonPicture({ picture }: { picture: NonNullable<Catalog["addons"][number]["picture"]> }) {
  return <Image className="addon-picture" src={picture.url} width={picture.width} height={picture.height} alt={picture.alt} sizes="64px" />;
}
