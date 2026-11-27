/**
 * FAKE PAYMENT (temporary, for testing; to be removed before the site takes real bookings).
 *
 * The "Fake Payment" button beside a payment button pays like a card, with no card and no money, and the site sends
 * no email about what it paid for. How to remove it is in the studio's go-live notes; every line of it outside its
 * own files is marked "FAKE PAYMENT".
 */

/** What the button sends in a card token's place. Only a test processor knows it (`withFakePayments`). */
export const FAKE_PAYMENT_TOKEN = "fake-payment";

/** What the processor's ids of a fake payment, and of what follows from it, begin with. */
export const FAKE_ID_PREFIX = "fake_";

export const FAKE_PAYMENT_LABEL = "Fake Payment";

/** What the pages say under the button. */
export const FAKE_PAYMENT_NOTE = "Fake Payment is for testing only: it needs no card, takes no money, and no email about it is sent.";
