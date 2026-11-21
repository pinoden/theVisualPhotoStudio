/**
 * The emails the site sends by itself, to clients and to the studio, as templates the owners change under Admin → Emails (question 33,
 * answered 2026-11-17). Each email has a subject and a text in which the parts the site fills in are written in double
 * braces, `{{name}}`. Until the owners change an email, the template below is what is sent: word for word what the site
 * sent before there were templates. Once they change it, their wording is sent instead (`src/server/email-templates.ts`),
 * with the same parts filled in.
 *
 * The site still writes what each part says: a refund, a code or what is left to pay is the site's sentence, written
 * for the case at hand. The owners decide everything around the parts, and which parts an email has, except the parts
 * it cannot do without (`required`).
 *
 * Shared by the server, which writes the emails, and the admin's editor, which previews them as the owners type.
 */

export interface EmailPart {
  /** Written `{{key}}` in a template. */
  readonly key: string;
  /** What it holds, for the owners. */
  readonly label: string;
  /** Set for a part that only some of these emails have, saying which ("Only for …"). A line holding nothing else is left out of the others. */
  readonly only?: string;
  /** The site writes it on several lines: it can go in the text, not in the subject. */
  readonly lines?: true;
  /** The email cannot do its job without it: a template that leaves it out is refused. */
  readonly required?: true;
  /** A link on this site: the preview puts the site's address before the sample. */
  readonly link?: true;
  /** What the preview shows for it. */
  readonly sample: string;
}

export const TEMPLATE_KEYS = [
  "booking_confirmation",
  "booking_reminder",
  "review_request",
  "booking_moved",
  "move_request_received",
  "reschedule_code",
  "booking_cancelled",
  "booking_cancelled_by_studio",
  "refund_not_yet",
  "payment_link",
  "payment_received",
  "reservation_lapsed",
  "reschedule_code_refund",
  "late_payment_refunded",
  "late_payment_due",
  "pet_credit",
  "loyalty_code",
  "login_code",
  "membership_started",
  "membership_month_paid",
  "membership_payment_problem",
  "membership_cancelled",
  "move_request_studio",
  "contact_message",
  "owner_hand_refund",
  "owner_refund_sent",
  "owner_refund_failed",
  "owner_refund_waiting",
  "owner_capture_failed",
  "owner_reservation_lapsed",
  "owner_unseen_link",
  "owner_membership_refund",
  "owner_membership_problem",
  "owner_membership_unfinished",
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

export interface EmailTemplateSpec {
  readonly key: TemplateKey;
  /** Its name in the admin. */
  readonly title: string;
  /** Where the admin lists it. */
  readonly group: (typeof TEMPLATE_GROUPS)[number];
  /** When it is sent, in a sentence. */
  readonly when: string;
  /** The site's own wording. */
  readonly subject: string;
  readonly body: string;
  /** The parts the site fills in, in the order the editor lists them; the studio's name and address (`STUDIO_PARTS`) besides. */
  readonly parts: readonly EmailPart[];
}

export const TEMPLATE_GROUPS = ["Bookings", "Moving and cancelling", "Payments", "Codes and signing in", "Memberships", "Notices to the studio"] as const;

/** Parts every email has: the studio's name and address as the website publishes them, filled in when it is queued. */
export const STUDIO_PARTS: readonly EmailPart[] = [
  { key: "studio_name", label: "The studio's name, as the website shows it (Website → Header, menu & footer)", sample: "" },
  { key: "studio_address", label: "The studio's address on one line, as the website shows it", sample: "" },
];

const STUDIO_KEYS = new Set(STUDIO_PARTS.map((part) => part.key));

// ── The parts several emails share ───────────────────────────────────────────

const NAME: EmailPart = { key: "name", label: "The client's name, as they gave it", sample: "Jane Smith" };
const FIRST_NAME: EmailPart = { key: "first_name", label: "The client's first name: the first word of their name", sample: "Jane" };
const REFERENCE: EmailPart = { key: "reference", label: "The booking's reference", sample: "VS-7K2M9Q" };
const STUDIOS: EmailPart = { key: "studios", label: "The studio booked, or the studios booked together", sample: "Blanche" };
const WHEN: EmailPart = { key: "when", label: "The day and start time", sample: "Sat, Dec 12, 2026, 10:00 AM" };
const DURATION: EmailPart = { key: "duration", label: "How long the booking lasts", sample: "2 hours" };
const VALID_UNTIL: EmailPart = { key: "valid_until", label: "Until when the code can be used", sample: "Thu, Mar 11, 2027, 10:00 AM" };
const BOOK_LINK: EmailPart = { key: "book_link", label: "The link to the booking page", link: true, sample: "/book" };
const GETTING_IN: EmailPart = {
  key: "getting_in",
  label: "How to get into the building, under the line “Getting in:”, as set under Settings → Getting in",
  only: "Only when a getting-in text is set",
  lines: true,
  sample: "Getting in:\nThe door code is 1234. The studios are on the second floor.",
};
const CLIENT: readonly EmailPart[] = [NAME, FIRST_NAME, REFERENCE];

const lines = (...text: string[]) => text.join("\n");
const SIGN_OFF = ["{{studio_name}}", "{{studio_address}}"];
const ARRIVAL = "Your booking begins at the scheduled start time. Please arrive no more than five minutes early.";

const TEMPLATES: readonly EmailTemplateSpec[] = [
  {
    key: "booking_confirmation",
    title: "Booking confirmed",
    group: "Bookings",
    when: "Right after a booking is made: by the client online, or by the studio for a client.",
    subject: "Booking confirmed: {{reference}}",
    body: lines(
      "Hi {{name}},",
      "",
      "Your booking at {{studio_name}} is confirmed.",
      "",
      "Reference: {{reference}}",
      "Studio: {{studios}}",
      "When: {{when}} ({{duration}})",
      "{{photography}}",
      "{{payment}}",
      "",
      "View, cancel or move your booking: {{booking_link}}",
      "",
      "{{getting_in}}",
      "",
      ARRIVAL,
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      STUDIOS,
      WHEN,
      DURATION,
      {
        key: "photography",
        label: "What the photography session includes, and when the edited images are delivered",
        only: "Only for a photography session",
        lines: true,
        sample: "Photography session with our in-house photographer, studio included: 1–2 outfits, 20 edited images.\nYour edited images are delivered within 7 to 14 days.",
      },
      {
        key: "payment",
        label:
          "What the booking costs: “Total”, or “To pay at the studio” for a booking the studio made; and, when a code paid part of it, what the code paid and the card was charged",
        lines: true,
        required: true,
        sample: "Total: $176",
      },
      { key: "booking_link", label: "The link where the client views, cancels or moves the booking", link: true, required: true, sample: "/booking/VS-7K2M9Q?t=…" },
      GETTING_IN,
    ],
  },
  {
    key: "booking_reminder",
    title: "Reminder before a visit",
    group: "Bookings",
    when: "The hours set under Settings (“Reminder email”) before the visit, for a booking made before then.",
    subject: "Reminder: your booking at {{studio_name}}, {{when}}",
    body: lines(
      "Hi {{name}},",
      "",
      "This is a reminder of your booking at {{studio_name}}.",
      "",
      "Reference: {{reference}}",
      "Studio: {{studios}}",
      "When: {{when}} ({{duration}})",
      "{{photography}}",
      "{{to_pay}}",
      "Address: {{studio_address}}",
      "",
      "{{getting_in}}",
      "",
      ARRIVAL,
      "",
      "The link in your confirmation email opens your booking. If you cannot come, please reply to this email or call us.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      STUDIOS,
      WHEN,
      DURATION,
      {
        key: "photography",
        label: "What the photography session includes",
        only: "Only for a photography session",
        sample: "Photography session with our in-house photographer, studio included: 1–2 outfits, 20 edited images.",
      },
      {
        key: "to_pay",
        label: "What is left to pay: “Still to pay”, or “To pay at the studio” for a booking the studio made",
        only: "Only when something is left to pay",
        required: true,
        sample: "To pay at the studio: $176",
      },
      GETTING_IN,
    ],
  },
  {
    key: "review_request",
    title: "Review request",
    group: "Bookings",
    when: "24 hours after a visit ends, once the visit is marked completed.",
    subject: "How was your visit to {{studio_name}}?",
    body: lines(
      "Hi {{name}},",
      "",
      "Thank you for visiting {{studio_name}}. We'd love to hear about your experience.",
      "",
      "Leave a Google review: https://g.page/r/CTQ9ea1fatgnEBM/review",
      "",
      "Booking reference: {{reference}}",
      "",
      ...SIGN_OFF,
    ),
    parts: CLIENT,
  },
  {
    key: "booking_moved",
    title: "Booking moved by the studio",
    group: "Moving and cancelling",
    when: "When the studio moves a booking to a new time on the appointment's page.",
    subject: "Your booking {{reference}} has a new time",
    body: lines(
      "Hi {{name}},",
      "",
      "Your booking at {{studio_name}} has been moved.",
      "",
      "Reference: {{reference}}",
      "Studio: {{studios}}",
      "New time: {{when}} ({{duration}})",
      "It was: {{old_time}}",
      "",
      "{{price_note}}",
      "",
      "{{reschedule_note}}",
      "",
      "The link in your confirmation email still opens this booking. If the new time does not suit you, please reply to this email or call us.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      STUDIOS,
      { ...WHEN, label: "The new day and start time" },
      DURATION,
      { key: "old_time", label: "The day and start time it had before", sample: "Fri, Dec 11, 2026, 2:00 PM" },
      {
        key: "price_note",
        label:
          "The booking's new total when its new day is priced differently (a weekday for a weekend, or the other way round), and what follows: what is still to pay, what is refunded, or what went back on the client's code",
        only: "Only when the new day changed the price",
        lines: true,
        required: true,
        sample: "Its new day is priced as a weekend day, so its total is now $190 instead of $176.\nStill to pay: $14, at the studio or with a payment link we email you.",
      },
      {
        key: "reschedule_note",
        label: "That the move counts as the client's reschedule, so the booking is no longer refunded, and what moving it again costs",
        only: "Only when the studio moved it at the client's request",
        required: true,
        sample:
          "As you asked for this change, it counts as a reschedule under the rental terms: if the booking is cancelled now, it is not refunded. Moving it again online costs $20.",
      },
    ],
  },
  {
    key: "move_request_received",
    title: "Request to move a booking: the client's copy",
    group: "Moving and cancelling",
    when: "When a client asks the studio to move their booking. The studio gets its own notice, with a reply that reaches the client.",
    subject: "We have your request to move booking {{reference}}",
    body: lines(
      "Hi {{name}},",
      "",
      "We have your request to move your booking {{reference}}, now {{when}}. The studio will contact you to agree a new time. Until then your booking stays as it is.",
      "",
      "What you wrote:",
      "{{message}}",
      "",
      ...SIGN_OFF,
    ),
    parts: [...CLIENT, WHEN, { key: "message", label: "What the client wrote", lines: true, sample: "Any weekday afternoon next week, please." }],
  },
  {
    key: "reschedule_code",
    title: "Reschedule code",
    group: "Moving and cancelling",
    when: "When a client moves a booking online: the booking is released, and what they paid becomes a code for a new booking.",
    subject: "Your reschedule code for booking {{reference}}",
    body: lines(
      "Hi {{name}},",
      "",
      "{{credit}}",
      "",
      "{{link_note}}",
      "",
      "Reschedule code: {{code}}",
      "Valid until: {{valid_until}}",
      "",
      "Book your new time at {{book_link}} and enter the code at checkout, with this email address. If the new booking costs more, you pay only the difference. If it costs less, the rest stays on the code.",
      "",
      "A booking made with a reschedule code cannot be refunded.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      {
        key: "credit",
        label: "That the booking was released, and the credit it became: what was paid, with any discount and less any fee for a further move",
        required: true,
        sample: "Your booking VS-7K2M9Q has been released, and what you paid is now a credit of $176.",
      },
      // Not needed: {{credit}}, which this email cannot do without, states the same amount.
      { key: "value", label: "The credit on the code", sample: "$176" },
      {
        key: "link_note",
        label: "When the client asked, for a release that waited until the site knew whether the booking's payment link was paid",
        only: "Only when the release waited for the card processor",
        required: true,
        sample:
          "You asked for this on Tuesday, January 12, 2027 at 11:00 AM. It waited until we could confirm with the card processor whether the payment link for this booking was paid.",
      },
      { key: "code", label: "The reschedule code", required: true, sample: "MOVE-4K7P2X" },
      VALID_UNTIL,
      BOOK_LINK,
    ],
  },
  {
    key: "booking_cancelled",
    title: "Booking cancelled",
    group: "Moving and cancelling",
    when: "When a client cancels a booking, on its page or in their account.",
    subject: "Booking cancelled: {{reference}}",
    body: lines(
      "Hi {{name}},",
      "",
      "Your booking {{reference}} on {{when}} has been cancelled.",
      "",
      "{{outcome}}",
      "",
      "{{pet_credit}}",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      WHEN,
      {
        key: "outcome",
        label: "What the cancellation does: the refund and when the card shows it, or why nothing is refunded, and any code given back",
        lines: true,
        required: true,
        sample: "A refund of $167.20 is on its way to your card ($8.80 processing fee kept). Banks usually show it within 5 to 10 business days.",
      },
      {
        key: "pet_credit",
        label: "The pet fee, returned as studio credit: the code, until when it can be used, and how to use it",
        only: "Only when the pet fee is returned as studio credit",
        lines: true,
        required: true,
        sample:
          "The pet fee of $25 is not refunded to a card. It is returned to you as studio credit:\n\nCode: PET-8M3Q2Z\nValid until: Thu, Mar 11, 2027, 10:00 AM\n\nBook at https://…/book and enter the code at checkout, with this email address. What you do not spend stays on the code.",
      },
    ],
  },
  {
    key: "booking_cancelled_by_studio",
    title: "Booking cancelled by the studio",
    group: "Moving and cancelling",
    when: "When the studio cancels a booking on the appointment's page.",
    subject: "Booking cancelled: {{reference}}",
    body: lines(
      "Hi {{name}},",
      "",
      "Your booking {{reference}} on {{when}} has been cancelled by the studio.",
      "",
      "{{outcome}}",
      "Please contact us with any questions.",
      "",
      "{{pet_credit}}",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      WHEN,
      {
        key: "outcome",
        label: "What the cancellation does: the refund the studio chose and when the card shows it, what was paid at the studio, and any code given back",
        only: "Only when there is a refund, or more to say about the money",
        lines: true,
        required: true,
        sample: "A refund of $176 is on its way to your card. Banks usually show it within 5 to 10 business days.",
      },
      {
        key: "pet_credit",
        label: "The pet fee, returned as studio credit: the code, until when it can be used, and how to use it",
        only: "Only when the pet fee is returned as studio credit",
        lines: true,
        required: true,
        sample:
          "The pet fee of $25 is not refunded to a card. It is returned to you as studio credit:\n\nCode: PET-8M3Q2Z\nValid until: Thu, Mar 11, 2027, 10:00 AM\n\nBook at https://…/book and enter the code at checkout, with this email address. What you do not spend stays on the code.",
      },
    ],
  },
  {
    key: "refund_not_yet",
    title: "Refund not through yet",
    group: "Moving and cancelling",
    when: "When a card refund that the cancellation email said was on its way has not gone through, and that email had already been sent.",
    subject: "Your refund for booking {{reference}}",
    body: lines("Hi {{name}},", "", "About your cancelled booking {{reference}}: {{refund}}", "", ...SIGN_OFF),
    parts: [
      ...CLIENT,
      {
        key: "refund",
        label: "The refund, and that the studio has been told it has not reached the card yet",
        required: true,
        sample: "A refund of $167.20 is due to your card ($8.80 processing fee kept), and has not reached it yet: the studio has been told, and will see that it does.",
      },
    ],
  },
  {
    key: "payment_link",
    title: "Payment link",
    group: "Payments",
    when: "When the studio emails a client a link to pay by card what a booking still owes.",
    subject: "Pay for your booking {{reference}}",
    body: lines(
      "Hi {{name}},",
      "",
      "You can pay for your booking {{reference}} on {{when}} by card here:",
      "",
      "{{pay_link}}",
      "",
      "Amount: {{amount}}",
      "{{charges}}",
      "",
      "The card payment page is run by Square, our card processor: your card details never reach us. If you would rather pay at the studio, you still can.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      WHEN,
      { key: "pay_link", label: "The link to pay by card", link: true, required: true, sample: "/pay/4f9c2a1e" },
      { key: "amount", label: "The amount to pay", required: true, sample: "$176" },
      {
        key: "charges",
        label: "The extra charges the amount includes (overtime, cleaning, damage), each with what it is for",
        only: "Only when the booking has extra charges",
        lines: true,
        required: true,
        sample: "It includes the extra charges of your visit:\nDamage charge: Broken light stand, $100",
      },
    ],
  },
  {
    key: "payment_received",
    title: "Payment received",
    group: "Payments",
    when: "When the studio records a payment taken at the studio, or a client pays through a payment link.",
    subject: "Payment received for booking {{reference}}",
    body: lines(
      "Hi {{name}},",
      "",
      "We received your payment of {{amount}} for booking {{reference}} on {{when}}.",
      "",
      "{{paid_how}}",
      "{{balance}}",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      WHEN,
      { key: "amount", label: "The amount paid", required: true, sample: "$100" },
      { key: "paid_how", label: "How it was paid: “Paid at the studio: Cash”, or “Paid by: Card, through the payment link”", sample: "Paid at the studio: Cash" },
      { key: "balance", label: "What is still to pay, or “Your booking is paid in full.”", required: true, sample: "Still to pay: $76" },
    ],
  },
  {
    key: "reservation_lapsed",
    title: "Card not charged",
    group: "Payments",
    when: "When the amount reserved on a client's card lapsed before the site could take it: the booking stands, and is still to pay.",
    subject: "Booking {{reference}}: your card was not charged",
    body: lines(
      "Hi {{name}},",
      "",
      "The amount reserved on your card for booking {{reference}} on {{when}} could not be taken, and has been released: your card was not charged.",
      "",
      "Nothing else about your booking changes, and {{due}} is still to pay. The studio will be in touch about how to pay it. If you have a question, please reply to this email or call us.",
      "",
      ...SIGN_OFF,
    ),
    parts: [...CLIENT, WHEN, { key: "due", label: "What is still to pay", required: true, sample: "$176" }],
  },
  {
    key: "reschedule_code_refund",
    title: "Refund taken off a reschedule code",
    group: "Payments",
    when: "When the studio refunds a booking that was released for a reschedule code: the refund comes off the code.",
    subject: "A refund for booking {{reference}}",
    body: lines("Hi {{name}},", "", "{{refund}}", "", ...SIGN_OFF),
    parts: [
      ...CLIENT,
      { key: "code", label: "The reschedule code", sample: "MOVE-4K7P2X" },
      {
        key: "refund",
        label: "The refund, how it was given back, and what is left on the code",
        required: true,
        sample: "A refund of $50 to your card for booking VS-7K2M9Q came off your reschedule code MOVE-4K7P2X, which now has $126 left.",
      },
    ],
  },
  {
    key: "late_payment_refunded",
    title: "Late payment refunded",
    group: "Payments",
    when: "When a payment through a payment link reaches the site after its booking was cancelled, or released for a reschedule code: it is refunded in full.",
    subject: "Your payment for booking {{reference}} is refunded",
    body: lines("Hi {{name}},", "", "{{refund}}", "", ...SIGN_OFF),
    parts: [
      ...CLIENT,
      // Not needed: {{refund}}, which this email cannot do without, states the payment.
      { key: "amount", label: "The amount paid", sample: "$176" },
      {
        key: "refund",
        label: "The payment, why it is refunded, and when the card shows it",
        required: true,
        sample:
          "Your payment of $176 through the payment link for booking VS-7K2M9Q was recorded after the booking was cancelled, so it is refunded to your card in full. Banks usually show a refund within 5 to 10 business days.",
      },
    ],
  },
  {
    key: "late_payment_due",
    title: "Late payment not refunded yet",
    group: "Payments",
    when: "The same as “Late payment refunded”, when the refund has not gone through yet.",
    subject: "Your payment for booking {{reference}} is due back to your card",
    body: lines("Hi {{name}},", "", "{{refund}}", "", ...SIGN_OFF),
    parts: [
      ...CLIENT,
      // Not needed: {{refund}}, which this email cannot do without, states the payment.
      { key: "amount", label: "The amount paid", sample: "$176" },
      {
        key: "refund",
        label: "The payment, why it is due back, and that the studio has been told it has not reached the card yet",
        required: true,
        sample:
          "Your payment of $176 through the payment link for booking VS-7K2M9Q was recorded after the booking was cancelled, so it is due back to your card in full. It has not reached your card yet: the studio has been told, and will see that it does.",
      },
    ],
  },
  {
    key: "pet_credit",
    title: "Pet fee returned as credit",
    group: "Codes and signing in",
    when: "When the studio records that a pet did not come (Admin → Codes): the pet fee becomes studio credit.",
    subject: "Your pet fee for booking {{reference}} is now studio credit",
    body: lines(
      "Hi {{name}},",
      "",
      "Your pet did not come to booking {{reference}}, so the pet fee of {{amount}} is returned to you as studio credit.",
      "",
      "Code: {{code}}",
      "Valid until: {{valid_until}}",
      "",
      "Book at {{book_link}} and enter the code at checkout, with this email address. What you do not spend stays on the code.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      ...CLIENT,
      { key: "amount", label: "The pet fee returned", required: true, sample: "$25" },
      { key: "code", label: "The code that holds the credit", required: true, sample: "PET-8M3Q2Z" },
      VALID_UNTIL,
      BOOK_LINK,
    ],
  },
  {
    key: "loyalty_code",
    title: "Free hour earned",
    group: "Codes and signing in",
    when: "When a client's visits earn a free hour (Settings → Loyalty).",
    subject: "You have earned a free hour in the studio",
    body: lines(
      "Hi {{name}},",
      "",
      "Thank you for shooting with us {{visits}} times. Your next hour is on us.",
      "",
      "Code: {{code}}",
      "Valid until: {{valid_until}}",
      "",
      "Book any one studio at {{book_link}} and enter the code at checkout, with this email address. It works once.",
      "",
      "The price of one hour comes off your booking: a one-hour booking is free, and a longer one costs the rest. The free hour is for one studio, so it cannot be used when several studios are booked together, and it does not pay for add-ons.",
      "",
      "Every {{visits}} visits, on separate days, earn another free hour. A visit made with a free hour does not count, and neither does a photography session with our photographer.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      NAME,
      FIRST_NAME,
      { key: "visits", label: "How many visits earn a free hour", sample: "10" },
      { key: "code", label: "The free hour's code", required: true, sample: "FREE-6T2W9K" },
      VALID_UNTIL,
      BOOK_LINK,
    ],
  },
  {
    key: "login_code",
    title: "Sign-in code",
    group: "Codes and signing in",
    when: "When someone asks for a code to sign in: a client to their account, or the studio's team to the admin.",
    subject: "Your sign-in code: {{code}}",
    body: lines(
      "Your sign-in code for {{studio_name}} is {{code}}.",
      "",
      "It works once and expires in {{minutes}} minutes. If you did not ask for it, you can ignore this email.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      { key: "code", label: "The 6-digit code", required: true, sample: "482913" },
      { key: "minutes", label: "How many minutes the code works", sample: "15" },
    ],
  },
  {
    key: "membership_started",
    title: "Membership started",
    group: "Memberships",
    when: "When a client buys a membership on the site, once its first month is paid.",
    subject: "Your membership: {{plan}}",
    body: lines(
      "Hi {{name}},",
      "",
      "Thank you for joining {{studio_name}}. Your membership is {{plan}}: {{hours}} of studio time each month, for {{price}} a month.",
      "",
      "Your membership code: {{code}}",
      "",
      "Book at {{book_link}} and enter the code at checkout, with this email address. Each month paid adds its hours to the code, and the hours you do not use carry over.",
      "",
      "The first month is paid. The next is billed to the same card on {{next_billing}}, then each month on the same day, until you cancel. You can cancel at any time in your account: {{account_link}}",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      NAME,
      FIRST_NAME,
      { key: "plan", label: "The membership's name", sample: "Studio Paris, 5 hours a month" },
      { key: "hours", label: "The studio time each month", sample: "5 hours" },
      { key: "price", label: "What it costs a month", required: true, sample: "$300" },
      { key: "code", label: "The membership code the member books with", required: true, sample: "MEMBER-4K7P-2XQ9" },
      BOOK_LINK,
      { key: "next_billing", label: "The day the next month is billed", sample: "Friday, December 18, 2026" },
      { key: "account_link", label: "The link to the member's account, where they see their hours and cancel", link: true, sample: "/account/membership" },
    ],
  },
  {
    key: "membership_month_paid",
    title: "A month paid",
    group: "Memberships",
    when: "When Square has taken a month's payment of a membership, and the month's hours are added to its code.",
    subject: "Your membership: {{hours}} added",
    body: lines(
      "Hi {{name}},",
      "",
      "This month's payment for your membership {{plan}} went through ({{price}}), and its {{hours}} are on your code {{code}}. You have {{hours_left}} in all.",
      "",
      "The next month is billed on {{next_billing}}. You can cancel at any time in your account: {{account_link}}",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      NAME,
      FIRST_NAME,
      { key: "plan", label: "The membership's name", sample: "Studio Paris, 5 hours a month" },
      { key: "hours", label: "The studio time the month adds", sample: "5 hours" },
      { key: "price", label: "What the month cost", required: true, sample: "$300" },
      { key: "code", label: "The membership code", required: true, sample: "MEMBER-4K7P-2XQ9" },
      { key: "hours_left", label: "The studio time on the code now, this month's with what was left", sample: "6 hours 30 minutes" },
      { key: "next_billing", label: "The day the next month is billed", sample: "Monday, January 18, 2027" },
      { key: "account_link", label: "The link to the member's account", link: true, sample: "/account/membership" },
    ],
  },
  {
    key: "membership_payment_problem",
    title: "A membership's payment did not go through",
    group: "Memberships",
    when: "When Square could not take a month's payment by the day after it was due, or stopped the monthly payments. Sent once for each.",
    subject: "Your membership {{plan}}: a payment did not go through",
    body: lines(
      "Hi {{name}},",
      "",
      "{{problem}} The hours already on your code {{code}} stay yours to use: {{hours_left}}.",
      "",
      "The studio will be in touch about it. If you have a question, please reply to this email or call us.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      NAME,
      FIRST_NAME,
      { key: "plan", label: "The membership's name", sample: "Studio Paris, 5 hours a month" },
      {
        key: "problem",
        label: "What went wrong: a month's payment that did not go through, or the monthly payments stopped",
        required: true,
        sample: "The payment of $300 for the month from Monday, January 18, 2027 did not go through.",
      },
      { key: "code", label: "The membership code", sample: "MEMBER-4K7P-2XQ9" },
      { key: "hours_left", label: "The studio time left on the code", sample: "2 hours" },
    ],
  },
  {
    key: "membership_cancelled",
    title: "Membership cancelled",
    group: "Memberships",
    when: "When a member cancels their membership in their account, or the studio cancels it for them.",
    subject: "Your membership is cancelled: {{plan}}",
    body: lines(
      "Hi {{name}},",
      "",
      "Your membership {{plan}} is cancelled, and no more monthly payments will be taken.",
      "",
      "{{ends}}",
      "",
      "The hours left on your code {{code}} stay yours to use: {{hours_left}}. Book at {{book_link}} and enter the code at checkout, as before.",
      "",
      ...SIGN_OFF,
    ),
    parts: [
      NAME,
      FIRST_NAME,
      { key: "plan", label: "The membership's name", sample: "Studio Paris, 5 hours a month" },
      {
        key: "ends",
        label: "Until when the month paid for runs, or that none was paid for after it",
        required: true,
        sample: "The month you paid for runs until Monday, December 14, 2026.",
      },
      { key: "code", label: "The membership code", required: true, sample: "MEMBER-4K7P-2XQ9" },
      { key: "hours_left", label: "The studio time left on the code", sample: "3 hours 30 minutes" },
      BOOK_LINK,
    ],
  },
];

// ── The notices to the studio ────────────────────────────────────────────────
// Sent to the studio's own address when something needs it (the owner's answer of 2026-11-18 to question 40: every
// email can be changed). What the site did and what needs doing are parts the site writes, which a notice must keep.

const CUSTOMER: EmailPart = { key: "customer", label: "The client's name", sample: "Jane Smith" };
const NOTICE_REFERENCE: EmailPart = { key: "reference", label: "The booking's reference", required: true, sample: "VS-7K2M9Q" };
const AMOUNT = (label: string, sample: string): EmailPart => ({ key: "amount", label, required: true, sample });
const MEMBER_CODE: EmailPart = { key: "code", label: "The membership's code", required: true, sample: "MEMBER-4K7P-2XQ9" };
const PLAN: EmailPart = { key: "plan", label: "The membership's name", sample: "Studio Paris, 5 hours a month" };

const NOTICES: readonly EmailTemplateSpec[] = [
  {
    key: "move_request_studio",
    title: "A client asks to move a booking",
    group: "Notices to the studio",
    when: "When a client asks the studio to move their booking, with what they wrote. A reply reaches the client.",
    subject: "{{client_name}} asks to move booking {{reference}}",
    body: lines(
      "{{client_name}} asked the studio to move their booking. It is marked Reschedule Pending, and keeps its time until it is moved.",
      "",
      "Reference: {{reference}}",
      "Studio: {{studios}}",
      "Now: {{when}} ({{duration}})",
      "Client: {{client}}",
      "",
      "What they wrote:",
      "{{message}}",
      "",
      "Open the appointment to move it: {{appointment_link}}",
      "A reply to this email reaches the client.",
    ),
    parts: [
      { key: "client_name", label: "The client's name", sample: "Jane Smith" },
      NOTICE_REFERENCE,
      STUDIOS,
      WHEN,
      DURATION,
      { key: "client", label: "The client's name, email address and phone number", sample: "Jane Smith, jane@example.com, 407-555-0100" },
      { key: "message", label: "What the client wrote", lines: true, required: true, sample: "Could we move to the same time next Saturday?" },
      { key: "appointment_link", label: "The link to the appointment in the admin", link: true, required: true, sample: "/admin/appointments/VS-7K2M9Q" },
    ],
  },
  {
    key: "contact_message",
    title: "A message from the contact page",
    group: "Notices to the studio",
    when: "When a visitor writes through the contact page, with their message. A reply reaches the visitor.",
    subject: "Website message from {{name}}: {{topic}}",
    body: lines("{{name}} <{{email}}> wrote through the contact page.", "Topic: {{topic}}", "", "{{message}}", "", "Reply to this email to answer {{name}}."),
    parts: [
      { key: "name", label: "The visitor's name, as they gave it", sample: "Ann Lee" },
      { key: "first_name", label: "The visitor's first name: the first word of their name", sample: "Ann" },
      { key: "email", label: "The visitor's email address", sample: "ann@example.com" },
      { key: "topic", label: "The topic they chose", sample: "After-hours booking" },
      { key: "message", label: "What the visitor wrote", lines: true, required: true, sample: "Hi, could we book Blanche from 9 to 11 p.m. on a Friday?" },
    ],
  },
  {
    key: "owner_hand_refund",
    title: "A refund to give back by hand",
    group: "Notices to the studio",
    when: "When a booking paid at the studio is cancelled early enough to be refunded.",
    subject: "ACTION NEEDED: refund by hand for {{reference}}",
    body: lines("{{customer}} cancelled booking {{reference}} early enough to be refunded.", "", "{{refund}}", "Refund the customer by hand, then record the refund on the appointment's page."),
    parts: [
      CUSTOMER,
      NOTICE_REFERENCE,
      {
        key: "refund",
        label: "How much of what was paid at the studio is refunded, by the rental terms",
        required: true,
        sample: "Of what was paid at the studio, $136.50 is refunded by the rental terms, less the 5% fee: $129.68. The site cannot send that back.",
      },
    ],
  },
  {
    key: "owner_refund_sent",
    title: "A refund was sent",
    group: "Notices to the studio",
    when: "When a refund reaches the card processor.",
    subject: "Refund {{amount}} for {{reference}}",
    body: "{{refund}}",
    parts: [
      AMOUNT("The amount refunded", "$99.05"),
      NOTICE_REFERENCE,
      CUSTOMER,
      {
        key: "refund",
        label: "The refund in a sentence: how much, whether it was automatic, the booking, the client and what it was for",
        required: true,
        sample: "An automatic refund of $99.05 was sent for booking VS-7K2M9Q (Jane Smith).",
      },
    ],
  },
  {
    key: "owner_refund_failed",
    title: "A refund failed",
    group: "Notices to the studio",
    when: "When a card refund could not be sent. The site tries it again by itself.",
    subject: "ACTION NEEDED: refund failed for {{reference}}",
    body: lines(
      "A refund of {{amount}} for booking {{reference}} ({{customer}}) could not be sent.",
      "",
      "Reason: {{reason}}",
      "",
      "The site tries it again by itself. If it keeps failing, refund the payment in Square, then press “Refunded it in Square” beside it on the admin's overview, so that the site stops trying.",
    ),
    parts: [
      AMOUNT("The amount to refund", "$99"),
      NOTICE_REFERENCE,
      CUSTOMER,
      { key: "reason", label: "Why the card processor refused it", sample: "The card has expired." },
    ],
  },
  {
    key: "owner_refund_waiting",
    title: "A refund is waiting",
    group: "Notices to the studio",
    when: "When a refund cannot be sent with the card processor set up now.",
    subject: "A refund for {{reference}} is waiting",
    body: lines(
      "A refund of {{amount}} for booking {{reference}} ({{customer}}) has not been sent.",
      "",
      "{{reason}}",
      "",
      "The client was told it has not reached their card yet. It is listed on the admin's overview until it goes through.",
    ),
    parts: [
      AMOUNT("The amount to refund", "$20"),
      NOTICE_REFERENCE,
      CUSTOMER,
      { key: "reason", label: "Why it cannot be sent now", required: true, sample: "The payment was made in test mode, and the site now uses the live account." },
    ],
  },
  {
    key: "owner_capture_failed",
    title: "A card payment not taken yet",
    group: "Notices to the studio",
    when: "When the amount reserved on a client's card could not be taken yet. The site keeps trying.",
    subject: "Payment not taken yet for {{reference}}",
    body: lines(
      "The card for booking {{reference}} ({{customer}}) has {{amount}} reserved on it, and the booking is confirmed, but taking the money did not go through.",
      "",
      "Reason: {{reason}}",
      "",
      "The site tries again every time its scheduled task runs. If the money has not been taken by {{given_back}}, Square gives the amount back to the card and the booking is unpaid: then take the payment at the studio, or cancel the booking.",
    ),
    parts: [
      AMOUNT("The amount reserved on the card", "$144"),
      NOTICE_REFERENCE,
      CUSTOMER,
      { key: "reason", label: "Why the card processor did not take it", sample: "The card was declined." },
      { key: "given_back", label: "When Square gives the reserved amount back to the card", required: true, sample: "Sun, Dec 20, 2026, 10:00 AM" },
    ],
  },
  {
    key: "owner_reservation_lapsed",
    title: "A reserved amount lapsed",
    group: "Notices to the studio",
    when: "When the amount reserved on a card lapsed before it could be taken, and the booking is still to pay.",
    subject: "ACTION NEEDED: {{reference}} was not paid",
    body: lines(
      "The {{amount}} reserved on the card for booking {{reference}} ({{customer}}) lapsed before it could be taken: Square gave it back to the card, and nothing was charged.",
      "",
      "The booking still stands, and {{due}} is still to pay. Take the payment at the studio and record it on the appointment's page, or email the client a payment link from there, or cancel the booking. The client was told that their card was not charged and that the studio will be in touch.",
    ),
    parts: [
      AMOUNT("The amount that was reserved on the card", "$144"),
      NOTICE_REFERENCE,
      CUSTOMER,
      { key: "due", label: "What the booking still has to pay", required: true, sample: "$176" },
    ],
  },
  {
    key: "owner_unseen_link",
    title: "A payment link to check",
    group: "Notices to the studio",
    when: "When a client asks to cancel a booking, or to release it for a reschedule code, and it waits because the site cannot tell whether the booking's payment link was paid.",
    subject: "CHECK THE PAYMENT LINK of {{reference}}",
    body: "{{what_happened}}",
    parts: [
      NOTICE_REFERENCE,
      CUSTOMER,
      {
        key: "what_happened",
        label: "What the client asked for, why the site cannot tell whether the link was paid, what happens next, and what to do in Square and on the appointment's page",
        lines: true,
        required: true,
        sample:
          "Jane Smith asked to cancel their booking VS-7K2M9Q while the card processor could not say whether its payment link for $40 had been paid.\n\nNothing has been done yet: the booking stays confirmed, and keeps its time, until the site knows whether the link was paid. It is then cancelled under its terms as they stood when the client asked, counting the link's payment if there was one, and the client is emailed.\n\nThe site keeps asking, and finishes it by itself once the processor answers.",
      },
    ],
  },
  {
    key: "owner_membership_refund",
    title: "A membership's first month to refund",
    group: "Notices to the studio",
    when: "When a membership could not be set up after its first month was paid, and the refund did not go through.",
    subject: "ACTION NEEDED: refund the first month of membership {{code}}",
    body: lines(
      "{{customer}} paid {{amount}} for the first month of membership {{code}}, but the monthly payments could not be set up with the card, so the membership was not started.",
      "",
      "The refund of that payment did not go through either: {{reason}}",
      "",
      "Refund the payment in Square by hand. The client was told that the studio will refund it.",
    ),
    parts: [
      CUSTOMER,
      AMOUNT("The first month's payment", "$300"),
      MEMBER_CODE,
      { key: "reason", label: "Why the refund did not go through", sample: "The card was declined." },
    ],
  },
  {
    key: "owner_membership_problem",
    title: "A membership's payment did not go through",
    group: "Notices to the studio",
    when: "When Square could not take a month's payment, or stopped a membership's monthly payments.",
    subject: "ACTION NEEDED: membership {{code}} was not paid",
    body: lines(
      "{{customer}}'s membership {{code}} ({{plan}}): {{problem}}",
      "",
      "No hours were added for it. The member was told that the studio will be in touch. A month Square takes later is recorded, and its hours added, by itself.",
    ),
    parts: [
      CUSTOMER,
      MEMBER_CODE,
      PLAN,
      { key: "problem", label: "What went wrong", required: true, sample: "The payment of $300 for the month from Monday, January 18, 2027 did not go through." },
    ],
  },
  {
    key: "owner_membership_unfinished",
    title: "A membership not finished",
    group: "Notices to the studio",
    when: "When a client pressed to join and no answer came about their card, so the membership was not started: Square may hold a payment to refund.",
    subject: "CHECK SQUARE: membership {{code}} was not finished",
    body: lines(
      "{{customer}} pressed to join {{plan}} ({{amount}} a month), and no answer came from the card processor about their card, so the membership was not started.",
      "",
      "Look in Square for a payment of {{amount}} with the reference {{code}}. If there is one, refund it there: the client was told they would not be charged twice, not that they were not charged.",
    ),
    parts: [CUSTOMER, PLAN, AMOUNT("The monthly price", "$300"), MEMBER_CODE],
  },
];

export const EMAIL_TEMPLATES: Readonly<Record<TemplateKey, EmailTemplateSpec>> = Object.fromEntries(
  [...TEMPLATES, ...NOTICES].map((template) => [template.key, template]),
) as Record<TemplateKey, EmailTemplateSpec>;

// ── Filling a template in ────────────────────────────────────────────────────

/** A part as written in a template: letters, numbers and _ between double braces, in any case, with spaces allowed inside. */
const PART = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

function partsNamed(text: string): string[] {
  return [...text.matchAll(PART)].map((match) => match[1].toLowerCase());
}

/**
 * The email a template gives with these parts filled in.
 *
 *  - A line that holds nothing but parts, all of them empty in this email, is left out: a studio rental's confirmation
 *    has no photography line.
 *  - Never two empty lines in a row, and none at the start or the end.
 *  - The studio's name and address stay marked, for `queueEmail` to fill in from the website's published details,
 *    unless `parts` gives them (the editor's preview does). A part the email does not have comes out empty.
 *
 * Parts are put in once: what a part holds is never read for parts of its own.
 */
export function renderEmail(template: { subject: string; body: string }, parts: Readonly<Record<string, string>>): { subject: string; body: string } {
  const value = (key: string): string => {
    const name = key.toLowerCase();
    if (Object.hasOwn(parts, name)) return parts[name];
    return STUDIO_KEYS.has(name) ? `{{${name}}}` : "";
  };
  const fill = (text: string) => text.replace(PART, (_match, key: string) => value(key));

  const kept: string[] = [];
  for (const raw of template.body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const named = partsNamed(line);
    if (named.length > 0 && line.replace(PART, "").trim() === "" && named.every((key) => value(key) === "")) continue;
    const blank = line === "";
    if (blank && (kept.length === 0 || kept[kept.length - 1] === "")) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();

  return {
    subject: fill(template.subject).replace(/\s*\n\s*/g, " ").trim(),
    body: kept.map(fill).join("\n"),
  };
}

export const SUBJECT_MAX = 200;
export const BODY_MAX = 10_000;

/** A template's text as it is kept: one kind of line break, no empty lines at the start or the end, no spaces around the subject. */
export function tidyTemplate(text: { subject: string; body: string }): { subject: string; body: string } {
  const body = text.body.replace(/\r\n?/g, "\n").split("\n");
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  return { subject: text.subject.trim(), body: body.join("\n") };
}

/**
 * What stops a template from being used, in words for the owners: none for one the site can send. The same checks run
 * in the editor as the owners type, when they save, and before a saved template is used.
 */
export function templateProblems(spec: EmailTemplateSpec, text: { subject: string; body: string }): string[] {
  const problems: string[] = [];
  const known = new Map([...STUDIO_PARTS, ...spec.parts].map((part) => [part.key, part]));
  const inSubject = partsNamed(text.subject);
  const inBody = partsNamed(text.body);

  if (text.subject.trim() === "") problems.push("The subject is empty.");
  else if (/[\r\n]/.test(text.subject)) problems.push("The subject must be on one line.");
  if (text.subject.length > SUBJECT_MAX) problems.push(`The subject is longer than ${SUBJECT_MAX} characters.`);
  if (text.body.trim() === "") problems.push("The email has no text.");
  if (text.body.length > BODY_MAX) problems.push(`The text is longer than ${BODY_MAX.toLocaleString("en-US")} characters.`);

  const unknown = [...new Set([...inSubject, ...inBody])].filter((key) => !known.has(key));
  for (const key of unknown) problems.push(`{{${key}}} is not one of this email's parts. The parts it has are listed beside the text.`);
  if (/\{\{|\}\}/.test(text.subject.replace(PART, "") + text.body.replace(PART, ""))) {
    problems.push("A part is written with two braces on each side and only letters, numbers and _ between them, for example {{name}}.");
  }
  for (const key of new Set(inSubject)) {
    if (known.get(key)?.lines) problems.push(`{{${key}}} can be several lines long, so it can go in the text but not in the subject.`);
  }
  for (const part of spec.parts) {
    if (part.required && !inSubject.includes(part.key) && !inBody.includes(part.key)) problems.push(`{{${part.key}}} must stay in this email.`);
  }
  return problems;
}

/** The part `first_name`, from the client's name: its first word. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * What the preview fills a template with: each part's sample, links on the site's own address, and the studio's name
 * and address as the website shows them. `plain` leaves out the parts only some emails have, to show the common case.
 */
export function sampleParts(spec: EmailTemplateSpec, options: { plain: boolean; baseUrl: string; studioName: string; studioAddress: string }): Record<string, string> {
  const parts: Record<string, string> = { studio_name: options.studioName, studio_address: options.studioAddress };
  const base = options.baseUrl.replace(/\/$/, "");
  for (const part of spec.parts) {
    const sample = part.sample.replaceAll("https://…", base);
    parts[part.key] = options.plain && part.only ? "" : part.link ? `${base}${sample}` : sample;
  }
  return parts;
}
