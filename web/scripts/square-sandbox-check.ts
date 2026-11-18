/**
 * Runs the site's own Square code against Square's SANDBOX: a charge, the
 * same charge sent twice, declined cards, refunds, and a payment link that is
 * made, read and withdrawn. No money moves.
 * Usage: npm run check:square
 *
 * The keys come from the environment or, when they are not set there, from
 * web/.env.square-sandbox. The check refuses to run with anything but
 * sandbox keys, and it never prints them.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { squareProvider } from "../src/server/payments";

const KEYS_FILE = ".env.square-sandbox";
const SANDBOX = "https://connect.squareupsandbox.com";

function readKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  if (existsSync(KEYS_FILE)) {
    for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
      const match = /^\s*(SQUARE_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) keys[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const name of ["SQUARE_ENVIRONMENT", "SQUARE_APPLICATION_ID", "SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]) {
    if (process.env[name]) keys[name] = process.env[name]!;
  }
  return keys;
}

let failures = 0;
function report(passed: boolean, step: string, detail: string) {
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"}  ${step}\n      ${detail}`);
}

async function main() {
  const keys = readKeys();
  const { SQUARE_ACCESS_TOKEN: accessToken, SQUARE_LOCATION_ID: locationId, SQUARE_APPLICATION_ID: applicationId } = keys;
  if (!accessToken || !locationId || !applicationId) {
    console.error(`No Square keys found. Put the four SQUARE_ lines in web/${KEYS_FILE} or in the environment.`);
    process.exit(1);
  }
  if (keys.SQUARE_ENVIRONMENT !== "sandbox" || !applicationId.startsWith("sandbox-")) {
    console.error("These are not sandbox keys. This check only ever runs against Square's sandbox.");
    process.exit(1);
  }

  // ── The account and location the keys belong to ──
  const locationResponse = await fetch(`${SANDBOX}/v2/locations/${locationId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const locationData = (await locationResponse.json().catch(() => ({}))) as {
    location?: { status?: string; currency?: string; country?: string; capabilities?: string[] };
    errors?: { code?: string; detail?: string }[];
  };
  const location = locationData.location;
  report(
    locationResponse.ok && location?.status === "ACTIVE" && location.currency === "USD",
    "the keys are accepted and the location takes US dollars",
    location
      ? `status ${location.status}, currency ${location.currency}, country ${location.country}, can: ${(location.capabilities ?? []).join(", ") || "nothing listed"}`
      : `HTTP ${locationResponse.status}: ${locationData.errors?.map((e) => e.detail ?? e.code).join("; ") ?? "no details"}`,
  );
  if (!locationResponse.ok) {
    console.log("\nStopping: Square did not accept the keys.");
    process.exit(1);
  }

  const square = squareProvider({ accessToken, locationId, environment: "sandbox" });
  const charge = (token: string, idempotencyKey: string, amountCents = 8800) =>
    square.charge({
      amountCents,
      token,
      idempotencyKey,
      reference: "VS-CHECK1",
      note: "VS-CHECK1 sandbox check",
      buyerEmail: "sandbox-check@example.com",
    });

  // ── Charging ──
  const chargeKey = randomUUID();
  const paid = await charge("cnon:card-nonce-ok", chargeKey);
  report(paid.ok, "a good card is charged $88.00", paid.ok ? `payment ${paid.paymentId}` : paid.message);

  const again = await charge("cnon:card-nonce-ok", chargeKey);
  report(
    paid.ok && again.ok && again.paymentId === paid.paymentId,
    "sending the same charge again does not charge twice",
    again.ok ? `same payment returned: ${paid.ok && again.paymentId === paid.paymentId}` : again.message,
  );

  for (const [token, what] of [
    ["cnon:card-nonce-declined", "a declined card"],
    ["cnon:card-nonce-rejected-cvv", "a wrong security code"],
    ["cnon:card-nonce-rejected-postalcode", "a wrong postal code"],
    ["cnon:card-nonce-rejected-expiration", "a wrong expiry date"],
  ] as const) {
    const refused = await charge(token, randomUUID());
    report(
      !refused.ok && !refused.unknown,
      `${what} is refused`,
      refused.ok ? "it was charged" : `the customer would read: "${refused.message}" (Square said: ${refused.detail ?? "nothing"})`,
    );
  }

  // ── Reserving, then taking or giving back ──
  // How a booking is paid: the amount is reserved, the booking is confirmed, then the amount is taken.
  const reserve = (idempotencyKey: string) =>
    square.charge({
      amountCents: 6800,
      token: "cnon:card-nonce-ok",
      idempotencyKey,
      reference: "VS-CHECK2",
      note: "VS-CHECK2 sandbox check",
      buyerEmail: "sandbox-check@example.com",
      reserve: true,
    });
  const held = await reserve(randomUUID());
  report(held.ok, "$68.00 is reserved on a good card, not taken", held.ok ? `payment ${held.paymentId}` : held.message);
  if (held.ok) {
    const taken = await square.capture(held.paymentId);
    report(taken.ok, "the reserved amount is taken", taken.ok ? "Square completed the payment" : taken.message);
    const takenAgain = await square.capture(held.paymentId);
    report(takenAgain.ok, "taking it again changes nothing and is not an error", takenAgain.ok ? "counted as done" : takenAgain.message);
    const late = await square.release(held.paymentId);
    report(!late.ok, "an amount already taken cannot be given back (a refund is needed)", late.ok ? "it was given back" : late.message);
    const refunded = await square.refund({ paymentId: held.paymentId, amountCents: 6800, idempotencyKey: randomUUID(), reason: "Sandbox check" });
    report(refunded.ok, "an amount taken that way is refunded like any payment", refunded.ok ? `refund ${refunded.refundId}` : refunded.message);
  }
  const heldThenFreed = await reserve(randomUUID());
  if (heldThenFreed.ok) {
    const freed = await square.release(heldThenFreed.paymentId);
    report(freed.ok, "a reserved amount is given back", freed.ok ? "Square cancelled the payment" : freed.message);
    const freedAgain = await square.release(heldThenFreed.paymentId);
    report(freedAgain.ok, "giving it back again changes nothing and is not an error", freedAgain.ok ? "counted as done" : freedAgain.message);
    const tooLate = await square.capture(heldThenFreed.paymentId);
    report(!tooLate.ok, "an amount given back can no longer be taken", tooLate.ok ? "it was taken" : tooLate.message);
  } else {
    report(false, "a second amount is reserved", heldThenFreed.message);
  }
  const declinedHold = await square.charge({
    amountCents: 6800,
    token: "cnon:card-nonce-declined",
    idempotencyKey: randomUUID(),
    reference: "VS-CHECK3",
    note: "VS-CHECK3 sandbox check",
    buyerEmail: "sandbox-check@example.com",
    reserve: true,
  });
  report(!declinedHold.ok && !declinedHold.unknown, "a declined card is refused when reserving too", declinedHold.ok ? "it was reserved" : declinedHold.message);

  // ── Refunding ──
  if (paid.ok) {
    const refund = (amountCents: number, idempotencyKey: string, paymentId = paid.paymentId) =>
      square.refund({ paymentId, amountCents, idempotencyKey, reason: "Sandbox check" });

    const firstKey = randomUUID();
    const half = await refund(4400, firstKey);
    report(half.ok, "half of the payment is refunded", half.ok ? `refund ${half.refundId}, ${half.settled ? "completed at once" : "accepted as pending"}` : half.message);

    // What the scheduled task asks about a refund Square accepted without completing it.
    if (half.ok) {
      const state = await square.refundState(half.refundId);
      report(state.state === "pending" || state.state === "completed", "the refund is read back from Square", JSON.stringify(state));
    }
    const nowhere = await square.refundState("no-such-refund");
    report(nowhere.state === "unknown", "an unknown refund is read as unknown, not as rejected", JSON.stringify(nowhere));

    const halfAgain = await refund(4400, firstKey);
    report(
      half.ok && halfAgain.ok && halfAgain.refundId === half.refundId,
      "sending the same refund again does not refund twice",
      halfAgain.ok ? `same refund returned: ${half.ok && halfAgain.refundId === half.refundId}` : halfAgain.message,
    );

    const rest = await refund(4400, randomUUID());
    report(rest.ok, "the other half is refunded", rest.ok ? `refund ${rest.refundId}` : rest.message);

    const tooMuch = await refund(100, randomUUID());
    report(!tooMuch.ok, "refunding more than was paid is refused", tooMuch.ok ? "it was refunded" : tooMuch.message);

    const unknown = await refund(100, randomUUID(), "no-such-payment");
    report(!unknown.ok, "refunding an unknown payment is refused", unknown.ok ? "it was refunded" : unknown.message);
  }

  // ── A payment link ──
  // Paying one needs a person, or a browser, on the sandbox's own test page. That was done by hand on
  // 2026-11-15: the order became OPEN with one tender, whose payment the Refunds API then refunded.
  const linkKey = randomUUID();
  const link = await square.createPayLink({
    amountCents: 6800,
    idempotencyKey: linkKey,
    title: "Booking VS-CHECK1: sandbox check",
    note: "VS-CHECK1 sandbox check",
    returnUrl: "https://example.com/pay/sandbox-check",
  });
  report(link.ok, "a payment link for $68.00 is made", link.ok ? `link ${link.linkId}, at ${link.url}` : link.message);
  if (link.ok) {
    const sameLink = await square.createPayLink({
      amountCents: 6800,
      idempotencyKey: linkKey,
      title: "Booking VS-CHECK1: sandbox check",
      note: "VS-CHECK1 sandbox check",
      returnUrl: "https://example.com/pay/sandbox-check",
    });
    report(
      sameLink.ok && sameLink.linkId === link.linkId,
      "asking for the same link again does not make a second one",
      sameLink.ok ? `same link returned: ${sameLink.linkId === link.linkId}` : sameLink.message,
    );

    const unpaid = await square.payLinkState(link);
    report(unpaid.state === "open", "a link nobody has paid is reported as open", `state: ${unpaid.state}`);

    const withdrawn = await square.cancelPayLink(link.linkId);
    report(withdrawn.ok, "the link is withdrawn", withdrawn.ok ? "Square deleted it" : withdrawn.message);

    const afterwards = await square.payLinkState(link);
    report(afterwards.state === "cancelled", "a withdrawn link is reported as cancelled", `state: ${afterwards.state}`);

    const twice = await square.cancelPayLink(link.linkId);
    report(twice.ok, "withdrawing it a second time is not an error", twice.ok ? "already gone" : twice.message);
  }

  await checkMemberships(square);

  console.log(failures === 0 ? "\nAll steps behaved as expected." : `\n${failures} step(s) did not behave as expected.`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * A membership's billing (follow-up 3): a customer, the first month charged and its card kept, a plan with a price, a
 * subscription that starts billing a month later, and cancelling it. A second subscription starts at once, to see
 * Square charge the kept card by itself. The customer's address is on the studio's own domain: Square stops a
 * subscription whose customer has an address it refuses (an example.com one, on 2026-11-18), and the sandbox sends no
 * email.
 */
async function checkMemberships(square: ReturnType<typeof squareProvider>) {
  const billing = square.memberships;
  const key = randomUUID();
  const customer = await billing.createCustomer({ email: "sandbox-member@thevisualsphotostudio.com", name: "Sandbox Member", idempotencyKey: `${key}-customer` });
  report(customer.ok, "a membership: a customer is made", customer.ok ? `customer ${customer.customerId}` : customer.message);
  if (!customer.ok) return;

  const first = await square.charge({
    amountCents: 30000,
    token: "cnon:card-nonce-ok",
    idempotencyKey: `${key}-first`,
    reference: "MEMBER-CHECK",
    note: "Membership sandbox check: the first month",
    buyerEmail: "sandbox-member@thevisualsphotostudio.com",
    customerId: customer.customerId,
  });
  report(first.ok, "the first month, $300.00, is charged", first.ok ? `payment ${first.paymentId}` : first.message);
  if (!first.ok) return;

  const card = await billing.saveCard({ paymentId: first.paymentId, customerId: customer.customerId, idempotencyKey: `${key}-card` });
  report(card.ok, "the card of that payment is kept by Square", card.ok ? `card ${card.cardId}` : card.message);
  const price = await billing.createPlanPrice({ planName: "Sandbox check: Paris, 5 hours a month", processorPlanId: null, priceCents: 30000, idempotencyKey: `${key}-price` });
  report(price.ok, "a plan is made with a price of $300.00 a month", price.ok ? `plan ${price.processorPlanId}, price ${price.variationId}` : price.message);
  if (!card.ok || !price.ok) return;
  const raised = await billing.createPlanPrice({ planName: "Sandbox check: Paris, 5 hours a month", processorPlanId: price.processorPlanId, priceCents: 31000, idempotencyKey: `${key}-raised` });
  report(
    raised.ok && raised.processorPlanId === price.processorPlanId && raised.variationId !== price.variationId,
    "a new price of the same plan is a new price at Square, under the same plan",
    raised.ok ? `price ${raised.variationId}` : raised.message,
  );

  const nextMonth = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10);
  const later = await billing.subscribe({ customerId: customer.customerId, cardId: card.cardId, variationId: price.variationId, startDate: nextMonth, idempotencyKey: `${key}-later` });
  report(later.ok, `a subscription is made that starts billing on ${nextMonth}`, later.ok ? `subscription ${later.subscriptionId}` : later.message);
  if (later.ok) {
    const again = await billing.subscribe({ customerId: customer.customerId, cardId: card.cardId, variationId: price.variationId, startDate: nextMonth, idempotencyKey: `${key}-later` });
    report(again.ok && again.subscriptionId === later.subscriptionId, "asking for it again does not make a second one", again.ok ? `same subscription: ${again.subscriptionId === later.subscriptionId}` : again.message);
    const pending = await billing.subscriptionState(later.subscriptionId);
    report(pending.state === "pending", "it is pending until its first day, with nothing billed", JSON.stringify(pending));
    const cancelled = await billing.cancelSubscription(later.subscriptionId);
    report(cancelled.ok && cancelled.endsOn === nextMonth, "cancelled, it ends on its first day, before billing anything", cancelled.ok ? `ends on ${cancelled.endsOn}` : cancelled.message);
    const twice = await billing.cancelSubscription(later.subscriptionId);
    report(twice.ok, "cancelling it a second time is not an error", twice.ok ? `ends on ${twice.endsOn}` : twice.message);
    const after = await billing.subscriptionState(later.subscriptionId);
    report(after.state === "cancelled", "and it is read back as cancelled", JSON.stringify(after));
  }

  const today = new Date().toISOString().slice(0, 10);
  const now = await billing.subscribe({ customerId: customer.customerId, cardId: card.cardId, variationId: price.variationId, startDate: today, idempotencyKey: `${key}-now` });
  report(now.ok, "a subscription is made that starts billing today", now.ok ? `subscription ${now.subscriptionId}` : now.message);
  if (now.ok) {
    let state = await billing.subscriptionState(now.subscriptionId);
    for (let wait = 0; wait < 6 && !(state.state === "active" && state.invoices.some((invoice) => invoice.paid)); wait++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      state = await billing.subscriptionState(now.subscriptionId);
    }
    report(
      state.state === "active" && state.invoices.length === 1 && state.invoices[0].paid && state.invoices[0].amountCents === 30000 && state.paidThrough !== null,
      "Square charges the kept card by itself, and the month is read back as paid",
      JSON.stringify(state),
    );
    const cancelled = await billing.cancelSubscription(now.subscriptionId);
    report(cancelled.ok && cancelled.endsOn !== null && cancelled.endsOn > today, "cancelled, it runs to the end of the month paid for", cancelled.ok ? `ends on ${cancelled.endsOn}` : cancelled.message);
    const after = await billing.subscriptionState(now.subscriptionId);
    report(after.state === "cancelled" && after.endsOn === (cancelled.ok ? cancelled.endsOn : null), "and it is read back as cancelled, with that day", JSON.stringify(after));
  }
  const nowhere = await billing.subscriptionState("no-such-subscription");
  report(nowhere.state === "unknown", "an unknown subscription is read as unknown", JSON.stringify(nowhere));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
