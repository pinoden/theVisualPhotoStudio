# When something goes wrong: the owners' runbook

What to do, in order, when the booking site misbehaves. One page, for the owners and whoever runs the studio that day. Lines marked **(at go-live)** are filled in once the host, the web address and the email service are chosen (questions 1 to 4 of "Questions for the owners" in `ProjectLibrary.md`).

## Who to call

| For | Who | How |
| --- | --- | --- |
| The website itself: a page, a booking, an email that is wrong | The builder | **(at go-live)** |
| The site does not open at all | The host, and the builder | **(at go-live)**: the host is not chosen yet |
| Card payments, refunds, payouts | Square | The support options under Help in the Square Dashboard |
| Emails that never arrive, for anyone | The email service, and the builder | **(at go-live)** |
| The web address does not lead to the site | Whoever holds the domain | **(at go-live)** |

## Every morning: two minutes

1. Open **Admin → Overview**.
   - A box headed **Set-up still needed** should not be there once the site is live. If it says the scheduled tasks have not run for more than 15 minutes, reminders, free hours, review requests, refund retries and membership months are waiting: tell the builder. If it says card payments are in **test mode** or go to **Square's sandbox**, no card is being charged: call the builder at once.
   - **Refunds that need attention**: the site tries each one again by itself. If one keeps failing, see "A refund failed" below.
2. Read the site's emails to the studio. A subject that begins **ACTION NEEDED** or **CHECK SQUARE** says what to do and where.

## The site does not open, or bookings fail

1. Open the site's health page: **(at go-live: the address)**`/api/health`. A page that begins `{"ok":true` means the site and its database work. Anything else, or no page at all: call the host and the builder.
2. Meanwhile, send clients to the old Acuity booking page, by phone, email or Instagram: the go-live plan keeps it open for the first weeks after launch for this.
3. Nothing is half-made: a booking is either made, and its confirmation emailed, or not made, and its card not charged.

## A client says they were charged but have no booking

The site never keeps money for a booking it did not make: an amount it only reserved on the card is given back, though the client's bank may show it as pending for a few days. Look the payment up in Square (**Transactions**, by the client's name or the last four digits of the card). A payment that shows as completed with no booking: refund it in Square, and tell the builder.

## A refund failed

On **Admin → Overview**, under **Refunds that need attention**, each one shows Square's reason. The site tries it again by itself. If it keeps failing, refund that payment in Square (Transactions, the payment, Issue refund), then press **Refunded it in Square** beside it: the site stops trying, and the client's receipt shows the refund.

## A booking needs money back or more money

On the booking's page in the admin (from the calendar or **Bookings**), the **Payment** card shows what was paid, what is still owed and any remaining credit. Money still owed is taken at the studio (**Mark as paid**) or by **Email a payment link**. Remaining credit, after a move to a day that costs less, is the client's: refund it to the card from that card, or give it back at the studio and record it against the payment. **Receipt in Square** beside a card payment opens Square's receipt of it, whose receipt number finds the payment in Square's Transactions.

## A price, the hours or a page is wrong

Prices (**Admin → Prices**), opening hours (**Hours**) and the rules under **Settings** change at once for new bookings; a booking already made keeps the terms it was made under. Pages and the menu change once **Published** under **Website**. To undo a page published by mistake, open it in its editor: under **History**, **Bring back** an earlier version, which comes back as a draft, then **Publish**.

## Putting back the previous version of the site

**(at go-live)** The host keeps every release of the site: the builder can put the previous one back in minutes. That does not undo changes to the database, which only the builder handles.

## Restoring the data

**(at go-live)** The database provider keeps a restore window, and a copy is made each day elsewhere. A restore replaces everything since the moment restored to, bookings and payments included: decide it with the builder, never alone, and check Square for payments made in between.
