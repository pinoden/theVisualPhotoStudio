"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  availabilityGrid,
  combinedStarts,
  noticeHours,
  studiosFreeAt,
  type SlotOptions,
} from "@/lib/domain/availability";
import { extraGuestsFor, multiStudioOffer, studioCombinationError } from "@/lib/catalog-view";
import {
  bookableDurations,
  findPrice,
  formatCents,
  PROMO_MISFIT_TEXT,
  quote,
  type PromoKind,
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
import { EMAIL_FIELD, EMAIL_RULE } from "@/lib/parse";
import { count, hoursInWords } from "@/lib/words";
import type { DayAvailability } from "@/server/availability";
import type { Catalog } from "@/server/catalog";
import type { PaymentClientConfig } from "@/server/payments";
import { loadScript, squareScript, type SquareCard } from "./square-card";

type Mode = "studio" | "time";
type Step = "studios" | "when" | "time" | "details" | "pay";

/** The two booking paths are the same steps in a different order. */
const ORDER: Record<Mode, Step[]> = {
  studio: ["studios", "when", "time", "details", "pay"],
  time: ["when", "time", "studios", "details", "pay"],
};
const STEP_LABEL: Record<Step, string> = {
  studios: "Studios",
  when: "Date",
  time: "Time",
  details: "Details",
  pay: "Payment",
};

const MOCK_TOKEN = "mock-card-ok";

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

/** A code the server accepted for one email address. */
interface AppliedCode {
  code: string;
  kind: PromoKind;
  value: number;
  photographyOnly?: boolean;
  /** Where the code came from: "reschedule" for a moved booking's money. */
  source?: string;
  /**
   * A membership's code (follow-up 3): the minutes left on it, and whether weekends pay the difference. It pays with
   * minutes, never as a discount: `kind` and `value` are not used then.
   */
  membership?: { minutesLeft: number; weekendDifference: boolean };
  email: string;
}

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

export function BookingFlow({
  catalog,
  navigate = loadPage,
  photography = false,
}: {
  catalog: Catalog;
  navigate?: (url: string) => void;
  /**
   * The photography flow: a session with the in-house photographer in one
   * studio. The same steps as renting a studio, with a package in place of a
   * duration, and with times at which the photographer is free too.
   */
  photography?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<Mode>("studio");
  const [stepIndex, setStepIndex] = useState(0);
  const [studioIds, setStudioIds] = useState<string[]>(() => {
    const slug = searchParams.get("studio");
    const match = catalog.studios.find((s) => s.slug === slug);
    return match ? [match.id] : [];
  });
  /** What the date field holds. While a date is typed it passes through values such as 0002-12-28. */
  const [dateInput, setDateInput] = useState("");
  /** The date chosen: what the field holds, once that is a real date. */
  const date = isIsoDate(dateInput) ? dateInput : "";
  const [durationChoice, setDuration] = useState(0);
  const [start, setStart] = useState<number | null>(null);
  /** How many of each add-on: 1 for one ticked, more for one taken in a quantity (an extra guest). */
  const [addonCounts, setAddonCounts] = useState<Record<string, number>>({});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [applied, setApplied] = useState<AppliedCode | null>(null);
  const [codeError, setCodeError] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);

  const today = useSyncExternalStore(subscribeNever, browserToday, serverToday);
  const [availability, setAvailability] = useState<DayAvailability | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [config, setConfig] = useState<PaymentClientConfig | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const cardRef = useRef<SquareCard | null>(null);
  /**
   * The id of the attempt to book on its way. Sent again with a retry that
   * follows no answer at all (the connection dropped), so that a booking that
   * was made and paid is found and not made again; any answer, and any step
   * back, ends the attempt.
   */
  const requestIdRef = useRef<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const steps = ORDER[mode];
  const step = steps[stepIndex];
  const { settings, rules } = catalog;

  const dayType: DayType = date ? (catalog.specialDates[date] ?? defaultDayType(date)) : "weekday";
  /** How far ahead this kind of booking has to be made. A session with the photographer needs more notice. */
  const leadHours = noticeHours(settings, photography);
  /** The first date that can have a free time at all: whole days of notice from today. */
  const firstDate = today ? addDays(today, Math.floor(leadHours / 24)) : "";

  // ── What can be chosen ─────────────────────────────────────────────────────
  /** The session packages of the chosen studio, shortest first. Only in the photography flow. */
  const packages = useMemo(
    () =>
      photography
        ? catalog.photoPackages.filter((p) => p.studioId === studioIds[0]).sort((a, b) => a.durationMinutes - b.durationMinutes)
        : [],
    [photography, catalog.photoPackages, studioIds],
  );

  const durations = useMemo(() => {
    if (photography) return packages.map((p) => p.durationMinutes);
    if (mode === "studio") return bookableDurations(studioIds, dayType, rules);
    const all = new Set(rules.filter((r) => r.dayType === dayType).map((r) => r.durationMinutes));
    return [...all].sort((a, b) => a - b);
  }, [photography, packages, mode, studioIds, dayType, rules]);

  /** A chosen duration stops counting once the current selection no longer offers it. */
  const duration = durations.includes(durationChoice) ? durationChoice : 0;
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

  /** Studios that have a price for the chosen duration on this kind of day. */
  const pricedStudioIds = useMemo(
    () => catalog.studios.filter((s) => findPrice(s.id, dayType, duration, rules) !== null).map((s) => s.id),
    [catalog.studios, dayType, duration, rules],
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

  const freeAtStart = useMemo(
    () => (grid && start !== null ? studiosFreeAt(grid, start) : []),
    [grid, start],
  );

  const availableAddons = catalog.addons.filter((a) => a.studioId === null || studioIds.includes(a.studioId));
  // Extra guests these studios can take: each studio's own, and the owners' limit for studios booked together.
  const guestsAllowed = extraGuestsFor(catalog, studioIds);
  /** The most of an add-on this booking can take. */
  const mostOf = (addon: (typeof catalog.addons)[number]) => (addon.kind === "people" ? Math.min(addon.maxQuantity, guestsAllowed) : addon.maxQuantity);
  const studioOffer = multiStudioOffer(catalog);
  const combinationError = studioCombinationError(catalog.studios, studioIds);

  // A code is tied to an email address, so it stops applying if the address changes.
  const normalizedEmail = email.trim().toLowerCase();
  const current = applied && applied.email === normalizedEmail ? applied : null;
  const promo = current && !current.membership ? current : null;
  const member = current?.membership ? current : null;

  const price: Quote | null = useMemo(() => {
    if (studioIds.length === 0 || duration <= 0 || combinationError) return null;
    if (photography && !session) return null;
    try {
      return quote({
        studioIds,
        dayType,
        durationMinutes: duration,
        rules,
        multiStudioPercent: settings.multiStudioPercent,
        addonCatalog: catalog.addons,
        extraGuestsAllowed: guestsAllowed,
        // A number chosen before the studios changed is kept within what the booking can now take.
        addons: availableAddons
          .map((addon) => ({ addonId: addon.id, quantity: Math.min(addonCounts[addon.id] ?? 0, mostOf(addon)) }))
          .filter((selection) => selection.quantity > 0),
        promo,
        membership: member?.membership ?? null,
        photoPackage: session ? { priceCents: session.priceCents } : null,
      });
    } catch {
      return null;
    }
    // availableAddons, guestsAllowed and mostOf are derived from studioIds and the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioIds, dayType, duration, rules, settings.multiStudioPercent, catalog.addons, addonCounts, promo, member, photography, session, combinationError]);

  const needsCard = price !== null && price.totalCents > 0;

  // ── Loading data ───────────────────────────────────────────────────────────
  const fetchAvailability = useCallback(async (forDate: string) => {
    setLoadingSlots(true);
    try {
      const response = await fetch(`/api/availability?date=${encodeURIComponent(forDate)}${photography ? "&photography=1" : ""}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      setAvailability((await response.json()) as DayAvailability);
    } catch {
      setError("Could not load availability. Please try again.");
    } finally {
      setLoadingSlots(false);
    }
  }, [photography]);

  useEffect(() => {
    if (step !== "pay" || config) return;
    fetch("/api/booking-config", { cache: "no-store" })
      .then((r) => r.json())
      .then((c: PaymentClientConfig) => setConfig(c))
      .catch(() => setError("Could not load the payment form. Please refresh the page."));
  }, [step, config]);

  useEffect(() => {
    if (step !== "pay" || config?.mode !== "square" || !needsCard) return;
    let cancelled = false;
    (async () => {
      await loadScript(squareScript(config));
      if (cancelled || !window.Square) return;
      const card = await window.Square.payments(config.squareApplicationId!, config.squareLocationId!).card();
      if (cancelled) return void card.destroy();
      await card.attach("#card-container");
      cardRef.current = card;
      setCardReady(true);
    })().catch(() => setError("The card form failed to load. Please refresh the page."));
    return () => {
      cancelled = true;
      setCardReady(false);
      void cardRef.current?.destroy();
      cardRef.current = null;
    };
  }, [step, config, needsCard]);

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
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        promo?: Omit<AppliedCode, "email"> | null;
        membership?: { code: string; minutesLeft: number; weekendDifference: boolean } | null;
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

  // ── Navigation ─────────────────────────────────────────────────────────────
  function go(index: number, options: { refetch?: boolean } = {}) {
    requestIdRef.current = null;
    setError("");
    setStepIndex(index);
    // Availability is read fresh whenever the customer reaches a step that shows it.
    const target = steps[index];
    if ((target === "time" || target === "studios") && date && (options.refetch || availability?.date !== date)) {
      void fetchAvailability(date);
    }
    topRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setStart(null);
    if (next === "time") setStudioIds([]);
    setError("");
    setStepIndex(0);
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
    setStart(null);
    setAvailability(null);
    if (mode === "time") setStudioIds([]);
  }

  function chooseDuration(minutes: number) {
    setDuration(minutes);
    setStart(null);
    if (mode === "time") setStudioIds([]);
  }

  function chooseStart(minute: number) {
    setStart(minute);
    if (mode === "time") setStudioIds([]);
  }

  function validate(current: Step): string {
    switch (current) {
      case "studios":
        return studioIds.length === 0 ? "Please select at least one studio." : (combinationError ?? "");
      case "when":
        if (!date) return "Please select a date.";
        if (!duration) return "Please select a duration.";
        return "";
      case "time":
        return start === null ? "Please select a time." : "";
      case "details":
        if (name.trim().length < 2) return "Please enter your name.";
        // The booking's own rule (src/lib/parse.ts): an address taken here is never refused at "Confirm & pay".
        if (!EMAIL_RULE.test(email.trim())) return "Please enter a valid email address.";
        if (phone.trim().length < 7) return "Please enter your phone number.";
        if (!terms) return "Please agree to the studio policies to continue.";
        return "";
      default:
        return "";
    }
  }

  function next() {
    const problem = validate(step);
    if (problem) return setError(problem);
    go(stepIndex + 1);
  }

  async function submit() {
    if (!price || start === null || submitting) return;
    setError("");
    setSubmitting(true);
    let leaving = false;
    try {
      let paymentToken: string | undefined;
      if (price.totalCents > 0) {
        if (config?.mode === "mock") {
          paymentToken = MOCK_TOKEN;
        } else if (config?.mode === "square" && cardRef.current) {
          const result = await cardRef.current.tokenize();
          if (result.status !== "OK" || !result.token) {
            setError(`Card error: ${(result.errors ?? []).map((e) => e.message).join(", ") || "please check your card details."}`);
            return;
          }
          paymentToken = result.token;
        } else {
          setError("Online payment is not available right now. Please contact the studio.");
          return;
        }
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
          acceptTerms: true,
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
        navigate(`/booking/${data.ref}?t=${encodeURIComponent(data.manageToken)}`);
        return;
      }
      // An answer: this attempt is over, and the next press is a new one. Unless it is still on its way.
      if (data.code !== "in_progress") requestIdRef.current = null;
      if (data.code === "slot_taken") {
        setStart(null);
        go(steps.indexOf("time"), { refetch: true });
      }
      // Prices and add-ons on screen came with the page. When they have
      // changed since (a new price, an add-on withdrawn, a duration no longer
      // sold), reload them so the customer reviews what is offered now.
      const offerChanged = data.code === "price_changed" || data.code === "invalid_price";
      if (offerChanged) router.refresh();
      if (data.code === "invalid_code") {
        setApplied(null);
        go(steps.indexOf("details"));
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
  const studioName = (id: string) => catalog.studios.find((s) => s.id === id)?.name ?? "";
  const chosenNames = studioIds.map(studioName).join(" + ");

  const summary = price && start !== null && (
    <div className="price-summary">
      <div className="price-row">
        <span>When</span>
        <span>
          {longDateLabel(date)}, {minutesToLabel(start)} – {minutesToLabel(start + duration)}
        </span>
      </div>
      {price.studioLines.map((line) => (
        <div className="price-row" key={line.studioId}>
          <span>
            {session && "Photography session, "}
            {studioName(line.studioId)}, {durationLabel(duration)}
            {session && (
              <>
                <br />
                <small>Studio included. {session.includes}.</small>
              </>
            )}
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
      {price.addonLines.map((line) => (
        <div className="price-row" key={line.addonId}>
          <span>
            {line.name}
            {line.quantity > 1 ? ` × ${line.quantity}` : ""}
          </span>
          <span>{formatCents(line.totalCents)}</span>
        </div>
      ))}
      {promo && price.promoDiscountCents > 0 && (
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
      )}
      {member && price.membershipCents > 0 && (
        <div className="price-row price-discount">
          <span>
            Membership hours, code {member.code} ({durationLabel(price.membershipMinutes)})
          </span>
          <span>{formatCents(-price.membershipCents)}</span>
        </div>
      )}
      <div className="price-row total">
        <span>{promo || member ? "To pay" : "Total"}</span>
        <span>{formatCents(price.totalCents)}</span>
      </div>
      {session && (
        <p style={{ fontSize: ".8rem", margin: ".75rem 0 0" }}>
          A photography session is refunded when it is cancelled {hoursInWords(settings.photoRefundWindowHours)} or more
          before it starts{settings.refundFeePercent > 0 ? `, less the ${settings.refundFeePercent}% payment processing fee` : ""}.
        </p>
      )}
      {promo && price.promoMisfit && (
        <p className="field-error" role="status" style={{ margin: ".75rem 0 0" }}>
          {PROMO_MISFIT_TEXT[price.promoMisfit]} Code {promo.code} is not used on this booking and stays yours.
        </p>
      )}
    </div>
  );

  const actions = (nextLabel?: string) => (
    <div className="wizard-actions">
      {stepIndex > 0 ? (
        <button type="button" className="btn btn-outline" onClick={() => go(stepIndex - 1)} disabled={submitting}>
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

  return (
    <div className="wizard-container" ref={topRef} style={{ scrollMarginTop: 90 }}>
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
            <strong>I know when I want to come</strong>
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
          <h3 style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>
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
              const sessions = photography ? catalog.photoPackages.filter((p) => p.studioId === studio.id) : [];
              const unavailable = photography ? sessions.length === 0 : mode === "time" && !freeAtStart.includes(studio.id);
              const cents = photography
                ? sessions.length > 0
                  ? Math.min(...sessions.map((p) => p.priceCents))
                  : null
                : mode === "time"
                  ? findPrice(studio.id, dayType, duration, rules)
                  : findPrice(studio.id, "weekday", 60, rules);
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
                            ? ""
                            : mode === "time"
                              ? `${formatCents(cents)} for ${durationLabel(duration)}`
                              : `From ${formatCents(cents)} / hour`}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          {!photography && (
            <p style={{ fontSize: ".85rem" }}>
              Paris is included in every bundle. {studioOffer && `${studioOffer}.`}
            </p>
          )}
          {actions(nextLabelFor("studios"))}
        </div>
      )}

      {/* ── Date and duration ── */}
      {step === "when" && (
        <div className="wizard-panel active">
          <h3 style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>{photography ? "Select date & session" : "Select date & duration"}</h3>
          <p className="text-muted mb-3">
            {mode === "studio" && chosenNames ? `${chosenNames}. ` : ""}
            {leadHours > 0
              ? `${photography ? "Sessions" : "Bookings"} open ${hoursInWords(leadHours)} to ${count(settings.maxAdvanceDays, "day")} ahead.`
              : `Bookings open up to ${count(settings.maxAdvanceDays, "day")} ahead.`}
          </p>
          <div className="form-grid">
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
            {photography && (
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
                <p style={{ fontSize: ".8rem", margin: ".75rem 0 0" }}>
                  Every session is shot on a professional camera by our in-house photographer. Your edited images are
                  delivered within 7 to 14 days.
                </p>
              </div>
            )}
            {!photography && (
              <div className="form-group">
                <span className="form-label">Duration</span>
                <div className="duration-grid">
                  {durations.map((minutes) => (
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
                  {durations.length === 0 && <p style={{ fontSize: ".85rem" }}>No durations are offered for this selection.</p>}
                </div>
              </div>
            )}
          </div>
          {mode === "studio" && price && (
            <div className="price-summary">
              {price.studioLines.map((line) => (
                <div className="price-row" key={line.studioId}>
                  <span>
                    {session && "Photography session, "}
                    {studioName(line.studioId)}, {durationLabel(duration)}
                    {date && !session ? ` (${dayType})` : ""}
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
              <div className="price-row total">
                <span>Estimated total</span>
                <span>{formatCents(price.totalCents)}</span>
              </div>
            </div>
          )}
          {actions(nextLabelFor("when"))}
        </div>
      )}

      {/* ── Time ── */}
      {step === "time" && (
        <div className="wizard-panel active">
          <h3 style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>Choose a time</h3>
          <p className="text-muted mb-3">
            {longDateLabel(date)}, {durationLabel(duration)}
            {mode === "studio" && chosenNames ? `, ${chosenNames}` : ""}. Times are Eastern Time.
          </p>
          {loadingSlots && (
            <div style={{ textAlign: "center", padding: "3rem" }}>
              <div className="spinner" />
              <p style={{ marginTop: "1rem", fontSize: ".9rem" }}>Checking availability…</p>
            </div>
          )}
          {!loadingSlots && availability && (
            <>
              <div className="time-slots">
                {(mode === "studio" ? startsForChosenStudios : (grid?.times ?? [])).map((minute) => {
                  const freeCount = mode === "time" && grid ? studiosFreeAt(grid, minute).length : 0;
                  return (
                    <button
                      type="button"
                      key={minute}
                      className={`time-slot-btn${start === minute ? " selected" : ""}`}
                      aria-pressed={start === minute}
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
              {(mode === "studio" ? startsForChosenStudios.length : (grid?.times.length ?? 0)) === 0 && (
                <div className="notice" style={{ textAlign: "center" }}>
                  {availability.problem === "past"
                    ? "That date has already passed."
                    : availability.problem === "too_far"
                      ? `Bookings open ${count(settings.maxAdvanceDays, "day")} ahead.`
                      : firstDate && date < firstDate
                        ? `${photography ? "Photography sessions" : "Bookings"} are made at least ${hoursInWords(leadHours)} ahead. Please choose a later date.`
                        : mode === "studio" && studioIds.length > 1
                          ? "These studios are not free together on this date. Try another day, or fewer studios."
                          : "No times are available on this date. Please try another day."}
                </div>
              )}
            </>
          )}
          {actions(nextLabelFor("time"))}
        </div>
      )}

      {/* ── Details ── */}
      {step === "details" && (
        <div className="wizard-panel active">
          <h3 style={{ fontSize: "1.6rem", marginBottom: "1rem" }}>Your details</h3>
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
                    <span className="addon-text">
                      <span className="addon-head">
                        <label htmlFor={`addon-${addon.id}`}>
                          <strong>{addon.name}</strong>
                        </label>
                        <span className="addon-price">{formatCents(addon.priceCents)} each</span>
                      </span>
                      {addon.description && <span className="addon-description">{addon.description}</span>}
                      <span className="addon-description" id={`addon-${addon.id}-limit`}>
                        {addon.kind !== "people"
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
                    checked={(addonCounts[addon.id] ?? 0) > 0}
                    onChange={(event) => setAddonCounts((current) => ({ ...current, [addon.id]: event.target.checked ? 1 : 0 }))}
                  />
                  {/* The name and its price on one line, which puts the price under the name when both do not fit; the description below. */}
                  <span className="addon-text">
                    <span className="addon-head">
                      <strong>{addon.name}</strong>
                      <span className="addon-price">{formatCents(addon.priceCents)}</span>
                    </span>
                    {addon.description && <span className="addon-description">{addon.description}</span>}
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
                  placeholder={photography ? "Photography code" : "Discount, reward, credit or membership code"}
                  autoCapitalize="characters"
                  autoComplete="off"
                  value={codeInput}
                  onChange={(event) => setCodeInput(event.target.value)}
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

          <label className="addon-row" style={{ borderBottom: "none" }}>
            <input
              type="checkbox"
              checked={terms}
              onChange={(event) => {
                setTerms(event.target.checked);
                setError(""); // the usual reason an error is showing on this step
              }}
            />
            <span>
              I have read and agree to the{" "}
              <Link href="/policies" target="_blank">
                studio policies
              </Link>
              , including the cancellation and rescheduling rules. I will check the date and time in my confirmation
              email; the studio is open by appointment only.
            </span>
          </label>
          {actions(nextLabelFor("details"))}
        </div>
      )}

      {/* ── Payment ── */}
      {step === "pay" && (
        <div className="wizard-panel active">
          <h3 style={{ fontSize: "1.6rem", marginBottom: ".5rem" }}>Payment</h3>
          {summary}
          {!needsCard && price && (
            <div className="notice">Nothing to pay: your code covers this booking. No card is needed.</div>
          )}
          {needsCard && !config && <p>Loading payment form…</p>}
          {needsCard && config?.mode === "mock" && (
            <div className="notice notice-warning">
              <strong>Test mode.</strong> No card processor is connected, so no card will be charged. The booking
              will be created as if payment succeeded.
            </div>
          )}
          {needsCard && config?.mode === "disabled" && (
            <div className="notice notice-warning">
              Online payment is not available right now. Please contact the studio to book.
            </div>
          )}
          {needsCard && config?.mode === "square" && (
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
          <div className="wizard-actions">
            <button type="button" className="btn btn-outline" onClick={() => go(stepIndex - 1)} disabled={submitting}>
              ← Back
            </button>
            <button
              type="button"
              className="btn btn-dark"
              onClick={submit}
              disabled={
                submitting ||
                !price ||
                (needsCard && (!config || config.mode === "disabled" || (config.mode === "square" && !cardReady)))
              }
            >
              {submitting
                ? "Processing…"
                : needsCard && price
                  ? `Confirm & pay ${formatCents(price.totalCents)}`
                  : "Confirm booking"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
