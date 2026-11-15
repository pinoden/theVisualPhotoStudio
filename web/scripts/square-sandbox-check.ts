/**
 * Runs the site's own Square code against Square's SANDBOX: a charge, the
 * same charge sent twice, declined cards, and refunds. No money moves.
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

  // ── Refunding ──
  if (paid.ok) {
    const refund = (amountCents: number, idempotencyKey: string, paymentId = paid.paymentId) =>
      square.refund({ paymentId, amountCents, idempotencyKey, reason: "Sandbox check" });

    const firstKey = randomUUID();
    const half = await refund(4400, firstKey);
    report(half.ok, "half of the payment is refunded", half.ok ? `refund ${half.refundId}` : half.message);

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

  console.log(failures === 0 ? "\nAll steps behaved as expected." : `\n${failures} step(s) did not behave as expected.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
