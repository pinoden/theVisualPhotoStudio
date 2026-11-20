import { describe, expect, it, vi } from "vitest";
import { buyerVerification, cardTokenOf, NOT_CONFIRMED, tokenizeCard, type SquareCard } from "./square-card";

describe("what the card's bank is told of a payment (3-D Secure)", () => {
  it("gives the amount charged, in dollars, the client's name and email, and that the client paid themselves", () => {
    expect(buyerVerification({ amountCents: 11680, intent: "CHARGE", name: "Jane Smith", email: "jane@client.test" })).toEqual({
      amount: "116.80",
      currencyCode: "USD",
      intent: "CHARGE",
      billingContact: { givenName: "Jane", familyName: "Smith", email: "jane@client.test" },
      customerInitiated: true,
      sellerKeyedIn: false,
    });
    expect(buyerVerification({ amountCents: 8800, intent: "CHARGE", name: "Jane Smith", email: "jane@client.test" }).amount).toBe("88");
    expect(buyerVerification({ amountCents: 5, intent: "CHARGE", name: "Jane Smith", email: "jane@client.test" }).amount).toBe("0.05");
  });

  it("says when the card is kept to be billed again: a membership's first month", () => {
    expect(buyerVerification({ amountCents: 30000, intent: "CHARGE_AND_STORE", name: "Jane Smith", email: "jane@client.test" })).toMatchObject({
      amount: "300",
      intent: "CHARGE_AND_STORE",
    });
  });

  it("splits the name as typed, keeps one name as the given name, and leaves out what is empty", () => {
    expect(buyerVerification({ amountCents: 100, intent: "CHARGE", name: "  Ana  Maria   Lopez ", email: " ana@client.test " }).billingContact).toEqual({
      givenName: "Ana",
      familyName: "Maria Lopez",
      email: "ana@client.test",
    });
    expect(buyerVerification({ amountCents: 100, intent: "CHARGE", name: "Cher", email: "" }).billingContact).toEqual({ givenName: "Cher" });
  });

  it("gives no phone number and no address: the site keeps none it could vouch for", () => {
    const contact = buyerVerification({ amountCents: 100, intent: "CHARGE", name: "Jane Smith", email: "jane@client.test" }).billingContact;
    expect(Object.keys(contact).sort()).toEqual(["email", "familyName", "givenName"]);
  });
});

describe("Square's answer from its card form", () => {
  it("is the token when Square made one", () => {
    expect(cardTokenOf({ status: "OK", token: "cnon:abc" })).toEqual({ ok: true, token: "cnon:abc" });
  });

  it("is Square's reason in words otherwise, or a general one", () => {
    expect(cardTokenOf({ status: "Invalid", errors: [{ message: "Card number is not valid" }, { message: "CVV is not valid" }] })).toEqual({
      ok: false,
      message: "Card error: Card number is not valid, CVV is not valid",
    });
    expect(cardTokenOf({ status: "Cancel" })).toEqual({ ok: false, message: "Card error: please check your card details." });
    expect(cardTokenOf({ status: "OK" })).toEqual({ ok: false, message: "Card error: please check your card details." });
  });
});

describe("asking the card form for a token", () => {
  const verification = buyerVerification({ amountCents: 6800, intent: "CHARGE", name: "Jane Smith", email: "jane@client.test" });
  const cardThat = (tokenize: SquareCard["tokenize"]): SquareCard => ({ attach: async () => {}, destroy: async () => {}, tokenize });

  it("gives the form the payment's verification, and the token it makes", async () => {
    const tokenize = vi.fn(async () => ({ status: "OK", token: "cnon:abc" }));
    expect(await tokenizeCard(cardThat(tokenize), verification)).toEqual({ ok: true, token: "cnon:abc" });
    expect(tokenize).toHaveBeenCalledWith(verification);
  });

  it("reads a form that throws, as Square's does when the client closes the bank's check, as a payment not confirmed", async () => {
    const card = cardThat(async () => {
      throw new Error("Verification cancelled");
    });
    expect(await tokenizeCard(card, verification)).toEqual({ ok: false, message: NOT_CONFIRMED });
  });
});
