import { describe, expect, it } from "vitest";
import { handPaidPlace, handPaymentWords } from "./payment-methods";

describe("money recorded by hand, in words", () => {
  it("says where it was paid: at the studio, through Acuity before this website, or both", () => {
    expect(handPaidPlace({ atStudio: true, throughAcuity: false })).toBe("at the studio");
    expect(handPaidPlace({ atStudio: false, throughAcuity: true })).toBe("through Acuity");
    expect(handPaidPlace({ atStudio: true, throughAcuity: true })).toBe("at the studio and through Acuity");
    // Nothing kept of either: the words for the studio, as before Acuity's appointments were imported.
    expect(handPaidPlace({ atStudio: false, throughAcuity: false })).toBe("at the studio");
  });

  it("says how a payment was taken, on a receipt", () => {
    expect(handPaymentWords("cash")).toBe("At the studio: cash");
    expect(handPaymentWords("acuity")).toBe("Through Acuity, before this website");
    expect(handPaymentWords(null)).toBe("At the studio: payment");
  });
});
