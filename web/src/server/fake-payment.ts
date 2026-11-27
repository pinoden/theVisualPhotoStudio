/**
 * FAKE PAYMENT (temporary, for testing; see src/lib/fake-payment.ts).
 *
 * Two parts. The card processor in test mode learns the button's token, and answers for everything that follows from
 * such a payment (taking it, refunding it, a membership's billing) by itself, so that the real processor is never
 * asked about it. Everything else goes to the real processor as before. And no email about what was paid this way is
 * sent. Only a processor that moves no money is wrapped (`resolvePayments`): with Square's live account there is no
 * button, and its token is refused like any other card token Square does not know.
 */
import { and, eq, or, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { bookings, membershipPayments, memberships, payments } from "@/db/schema";
import { FAKE_ID_PREFIX, FAKE_PAYMENT_TOKEN } from "@/lib/fake-payment";
import type { MembershipBilling, PaymentProvider, SubscriptionState } from "./payments";

const isFake = (id: string) => id.startsWith(FAKE_ID_PREFIX);

/**
 * `real` with the Fake Payment button's payments answered here. `pretend` is the pretend processor's memberships,
 * which keep nothing and bill each month that has come: a fake membership is billed by them, its first day and price
 * carried in its ids from the first payment to the subscription.
 */
export function withFakePayments(real: PaymentProvider, pretend: MembershipBilling): PaymentProvider {
  const done = { ok: true as const };
  /** The pretend processor's id behind one of a fake subscription or its month. */
  const behind = (id: string) => `mock_${id.slice(FAKE_ID_PREFIX.length)}`;
  const memberships: MembershipBilling = {
    createCustomer: (input) => real.memberships.createCustomer(input),
    createPlanPrice: (input) => real.memberships.createPlanPrice(input),
    async saveCard(input) {
      if (!isFake(input.paymentId)) return real.memberships.saveCard(input);
      const price = /^fake_(\d+)_/.exec(input.paymentId)?.[1] ?? "0";
      return { ok: true, cardId: `${FAKE_ID_PREFIX}card_${price}_${input.idempotencyKey}` };
    },
    async subscribe(input) {
      if (!isFake(input.cardId)) return real.memberships.subscribe(input);
      const price = /^fake_card_(\d+)_/.exec(input.cardId)?.[1] ?? "0";
      return { ok: true, subscriptionId: `${FAKE_ID_PREFIX}sub_${input.startDate}_${price}_${input.idempotencyKey}` };
    },
    async cancelSubscription(subscriptionId) {
      return isFake(subscriptionId) ? { ok: true, endsOn: null } : real.memberships.cancelSubscription(subscriptionId);
    },
    async subscriptionState(subscriptionId): Promise<SubscriptionState> {
      if (!isFake(subscriptionId)) return real.memberships.subscriptionState(subscriptionId);
      const state = await pretend.subscriptionState(behind(subscriptionId));
      if (state.state === "unknown") return state;
      return { ...state, invoices: state.invoices.map((invoice) => ({ ...invoice, id: invoice.id.replace(/^mock_/, FAKE_ID_PREFIX) })) };
    },
  };

  return {
    ...real,
    offersFakePayment: true,
    memberships,
    async charge(request) {
      if (request.token !== FAKE_PAYMENT_TOKEN) return real.charge(request);
      return { ok: true, paymentId: `${FAKE_ID_PREFIX}${request.amountCents}_${request.idempotencyKey}` };
    },
    async refund(request) {
      if (!isFake(request.paymentId)) return real.refund(request);
      return { ok: true, refundId: `${FAKE_ID_PREFIX}refund_${request.idempotencyKey}`, settled: true };
    },
    capture: async (paymentId) => (isFake(paymentId) ? done : real.capture(paymentId)),
    release: async (paymentId) => (isFake(paymentId) ? done : real.release(paymentId)),
    refundState: async (refundId) => (isFake(refundId) ? { state: "completed" } : real.refundState(refundId)),
    async receiptOf(paymentId) {
      if (!isFake(paymentId)) return real.receiptOf(paymentId);
      return { ok: false, message: "This was a Fake Payment, made for testing: no card was charged, so there is no receipt." };
    },
  };
}

/** Why an email is not sent: what stays on its row in the outbox. */
export const NOT_SENT_FAKE_PAYMENT = "Not sent: it is about a Fake Payment, made for testing.";

/** Codes a person asks for to sign in or to change their address: sent whoever asks, or no one could look at their account. */
const ASKED_FOR = ["login_code", "email_change_code"];

/**
 * Whether an email is about something paid with the button, and so is not sent: it goes to a client who has a booking
 * or a membership paid that way, or it names such a booking's reference or membership's code, as a notice to the
 * studio does. A client who used the button once gets no later email either, whatever it is about, but the codes they
 * ask for: free hours, reminders and review requests name no payment to tell them apart by.
 */
export async function isFakePaymentEmail(db: DbLike, mail: { toEmail: string; subject: string; body: string; kind: string }): Promise<boolean> {
  if (ASKED_FOR.includes(mail.kind)) return false;
  const text = `${mail.subject}\n${mail.body}`;
  const [booking] = await db
    .select({ id: payments.id })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(
      and(
        sql`starts_with(${payments.providerPaymentId}, ${FAKE_ID_PREFIX})`,
        or(sql`lower(${bookings.customerEmail}) = ${mail.toEmail}`, sql`strpos(${text}, ${bookings.ref}) > 0`),
      ),
    )
    .limit(1);
  if (booking) return true;
  const [membership] = await db
    .select({ id: membershipPayments.id })
    .from(membershipPayments)
    .innerJoin(memberships, eq(memberships.id, membershipPayments.membershipId))
    .where(
      and(
        sql`starts_with(${membershipPayments.processorId}, ${FAKE_ID_PREFIX})`,
        or(sql`lower(${memberships.email}) = ${mail.toEmail}`, sql`strpos(${text}, ${memberships.code}) > 0`),
      ),
    )
    .limit(1);
  return membership !== undefined;
}
