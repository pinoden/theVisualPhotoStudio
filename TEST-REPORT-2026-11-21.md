# Preview booking test report

November 21, 2026. Prepared for the studio's owners. The same report is a private doc on claude.ai.

Twenty-eight made-up customers hold 35 bookings on the hosted preview, made on November 20 and 21, 2026. Every rule checked held, and no card was needed. 31 bookings stay confirmed on 27 days, from November 22 to May 20, for you to look at as an owner, an employee and a customer. A second round tried two customers at the same moment, the employee side, the public pages and the sign-in limits.

## How to look at it

Use a separate browser window for each role, so one sign-in does not replace another: a normal window, a private window, and a second browser.

**As an owner.** Sign in at [the preview](https://the-visual-photo-studio.vercel.app/account) with your owner address, then open the admin.

- **Calendar:** Sunday, November 22 has four bookings in three studios. Saturday, November 28 has all three studios booked together, then Dayglow alone.
- **Bookings and Customers:** the 28 test people, each with their bookings. Maya Rivera has five visits on five days.
- **Codes:** the six TEST codes and one reschedule code.

**As an employee.** Today hello@ is a customer on the preview. An owner makes it staff:

1. Open Admin, then Staff, and find "Add a staff member".
2. Enter hello@thevisualsphotostudio.com, a name, and a Level: Studio Manager or Studio Attendant.
3. Press Add.
4. In a private window, sign in with hello@. Its sign-in code arrives in that inbox.

A Studio Manager sees every day and runs the appointments. A Studio Attendant sees only the days assigned on that page under "Assign a day", and nothing until one is assigned. The switches on the Staff page decide the rest. Today managers record payments, open customers and block time, but see no prices. Attendants see contact details and change status labels.

Two test staff members are on the Staff page already: a manager and an attendant, both on test addresses. The second round used them. Remove them whenever you like.

**As a customer.** There are two ways.

- **Your own view:** sign in with an address that is neither an owner's nor hello@. Book with the code TEST-FREE, then open My Bookings.
- **A test customer's view:** at sign-in, type delivered+maya@resend.dev and press "Email me a code". That address reaches no inbox, so ask Claude for the code. Maya's account shows five upcoming bookings and 0 of 5 stamps.

## What to decide or fix

The test found eight things for the owners: five on the customer's side and three on the employee's. None of them stopped a booking.

1. **A booking that cost nothing cannot be moved online.** A client who booked with a 100% code or a free hour presses Reschedule and reads: "Nothing was paid for this booking, so there is no credit to move. You can cancel it and book again." Cancelling gives the code back, and "Ask the studio to move it" stays available. This covers loyalty free hours too. Decide whether that is what you want.
2. **"Getting in" is empty.** Confirmation emails and booking pages give the address, but not how to enter the building. Write it under Admin, Settings, "Getting in". Confirmations include it from then on.
3. **The confirmation email gives only the total.** One email said "Total: $220" and "Paid with your studio credit: $220", with no line for the six extra guests. The booking's own page lists them, and a pet fee too. Decide whether the email should list add-ons.
4. **Two studios together take no extra guests.** Your limit for two studios is 10 people. Paris with Dayglow, or Paris with Blanche, already includes 10, so "Extra guest" offers only 0. Raise "Most guests for two studios together" in Settings if a bundle should allow more.
5. **A discount code comes back after any cancellation.** One client cancelled two days ahead, inside the seven days when nothing is refunded. The page said the code "can be used again". That suits a promotion. Decide whether it suits a one-off gift.
6. **"The client asked for this move" starts ticked.** When staff move a booking, this box is ticked to begin with. Left ticked, the move uses up the client's one free reschedule, and the booking is no longer refunded automatically. Staff have to untick it for a change the studio needs. Decide whether it should start unticked.
7. **A manager who opens the admin's first page reads "This page could not be found."** That page, the Overview, is the owners'. Managers reach the calendar from a link on their account page instead. Sending them straight to the calendar would be a small change.
8. **A manager sees the price while booking for a client.** The screen says "$88 … to be paid at the studio", though "See what bookings cost" is switched off for managers. They need the price to tell the client. Decide whether that is right with the switch off.

## Test emails

Fifteen test emails reached hello@ before the instruction to stop. None has reached a real inbox since.

- **What arrived:** 13 booking confirmations, one cancellation and one reschedule code, between 11:49 and 11:57 PM on November 20. They went to hello+name@thevisualsphotostudio.com, which Gmail delivers to hello@. A search for "Booking confirmed: VS-" finds the confirmations.
- **Since then:** every test customer has an address like delivered+maya@resend.dev, [Resend's test address](https://resend.com/docs/dashboard/emails/send-test-emails). It takes an email and delivers it to nobody. The 13 bookings already made were moved to it.
- **Sent to the test address so far:** 22 confirmations, 2 cancellations, one notice of a moved booking, 2 payment confirmations and 7 sign-in codes. That is 34 emails, all accepted.
- **Still to come, to the test address only:** a reminder before each visit, a review request the day after it, and Maya's free-hour code once her fifth visit is over on December 3.
- **Owners:** no owner received a test email.
- **One limit:** Resend counts test emails toward the account's sending limit, like any other.

## The bookings in the calendar

The calendar holds 31 confirmed bookings and 4 cancelled ones, made by 28 people. All times are Eastern Time, and every booking is a test.

| When | Studio | Customer | What it shows | Status | Reference |
| --- | --- | --- | --- | --- | --- |
| Sun Nov 22, 10:00 AM, 1 hr | Paris | Maya Rivera | The first of her five visits | Confirmed | VS-RWB7A6 |
| Sun Nov 22, 11:15 AM, 1 hr | Paris | Noah Bennett | The earliest time after Maya's, with the 15-minute gap | Confirmed | VS-K27NBV |
| Sun Nov 22, 1:00 PM, 2 hr | Paris + Dayglow | Daniel Okafor | Two studios together, 20% off | Confirmed | VS-NTMMXC |
| Sun Nov 22, 1:00 PM, 1 hr | Blanche | Ethan Brooks | Booked by time first, when only Blanche was free | Confirmed | VS-6VWJ8X |
| Mon Nov 23, 3:00 PM, 1 hr | Dayglow | Ava Thompson | Cancelled two days ahead | Cancelled | VS-52FVCH |
| Tue Nov 24, 2:00 PM, 1.5 hr | Dayglow | Maya Rivera | Her second visit | Confirmed | VS-YQ6GGS |
| Wed Nov 25, 4:00 PM, 1 hr | Paris | Liam O'Connor | A free booking he could not move, so he cancelled it | Cancelled | VS-2A9BVK |
| Fri Nov 27, 11:00 AM, 2 hr | Blanche | Maya Rivera | Her third visit | Confirmed | VS-DC8VGW |
| Sat Nov 28, 10:00 AM, 3 hr | Blanche + Dayglow + Paris | Sofia Marchetti | All three studios, 22% off, 4 extra guests, paid with studio credit | Confirmed | VS-HK2ZVT |
| Sat Nov 28, 2:00 PM, 2 hr | Dayglow | Aiko Tanaka | A pet fee, paid with studio credit | Confirmed | VS-P6TRYD |
| Sun Nov 29, 12:00 PM, 1 hr | Dayglow | Chloe Dubois | Booked on a phone-sized screen | Confirmed | VS-RBYH99 |
| Mon Nov 30, 9:00 AM, 1 hr | Paris | Maya Rivera | Her fourth visit, at opening time | Confirmed | VS-B86HPP |
| Tue Dec 1, 10:00 AM, 5 hr | Blanche | José Hernández | A five-hour booking, with accents in the name and the notes | Confirmed | VS-UJQD3C |
| Wed Dec 2, 5:00 PM, 1 hr | Paris | Liam O'Connor | Paid with studio credit, then released for a reschedule code | Released | VS-VR4XZ4 |
| Thu Dec 3, 3:00 PM, 2 hr | Paris + Dayglow | Maya Rivera | Her fifth visit | Confirmed | VS-UMM7TJ |
| Sat Dec 5, 9:00 AM, 1.5 hr | Paris + Blanche | Marcus Reed | Booked in Safari's engine | Confirmed | VS-7DD54E |
| Sun Dec 6, 8:00 AM, 1 hr | Blanche | Grace Wilson | The first time of a weekend day | Confirmed | VS-96P4Y2 |
| Mon Dec 7, 1:00 PM, 1 hr | Blanche | Hannah Kim | Paid with a free hour that is hers alone | Confirmed | VS-WDN6NT |
| Tue Dec 8, 10:00 AM, 1 hr | Dayglow | Priya Nair | A photography session | Confirmed | VS-5AKPGH |
| Wed Dec 9, 11:00 AM, 1 hr | Dayglow | Emma Lindqvist | Cancelled 18 days ahead | Cancelled | VS-3JAQ9Q |
| Wed Dec 9, 11:00 AM, 1 hr | Dayglow | Ben Carter | Took the time and the code Emma gave up | Confirmed | VS-J8PS8A |
| Thu Dec 10, 1:00 PM, 2 hr | Blanche | Isabella Rossi | A two-hour photography session | Confirmed | VS-6N8499 |
| Fri Dec 11, 2:00 PM, 2 hr | Paris | Oliver Grant | Moved by the test manager from 10:00 AM to 2:00 PM | Confirmed | VS-3UB6FK |
| Sat Dec 12, 4:00 PM, 2 hr | Blanche | Zoe Papadopoulos | 6 extra guests, paid with studio credit | Confirmed | VS-5DAXY5 |
| Sun Dec 13, 12:00 PM, 2 hr | Blanche + Dayglow + Paris | Mia Chen | All three studios on a weekend | Confirmed | VS-7XESJ7 |
| Mon Dec 14, 6:00 PM, 1 hr | Paris | Grace Wilson | The last time of a weekday | Confirmed | VS-X6RRFH |
| Wed Dec 16, 5:00 PM, 1 hr | Paris | Liam O'Connor | Paid with his reschedule code | Confirmed | VS-MK3CNQ |

The second round added eight bookings.

| When | Studio | Customer | What it shows | Status | Reference |
| --- | --- | --- | --- | --- | --- |
| Tue Dec 15, 11:00 AM, 1 hr | Blanche | Ruth Alvarez | Booked by the test manager for a client, then paid at the desk: $50 cash and $38 by card reader | Confirmed | VS-64G3XT |
| Thu Dec 17, 10:00 AM, 1 hr | Blanche | Quinn Adler | Notes that hold HTML | Confirmed | VS-V669PM |
| Fri Dec 18, 2:00 PM, 1 hr | Paris + Dayglow | Nina Petrova | Won against a customer who wanted Paris alone at the same moment | Confirmed | VS-ZTS68E |
| Sat Dec 19, 11:00 AM, 1 hr | Dayglow | Lucy Ward | Won against a customer who wanted Paris + Dayglow | Confirmed | VS-YE3MTJ |
| Mon Dec 21, 3:00 PM, 1 hr | Blanche | Jack Moreno | Won against a second customer for the same studio and time | Confirmed | VS-NNGG9Y |
| Tue Dec 22, 10:00 AM, 1 hr | Paris | Elena Fischer | A photography session, won against one in Blanche at the same time | Confirmed | VS-DNHVBR |
| Sun Mar 14, 2027, 8:00 AM, 1 hr | Paris | Dana Whitfield | The morning the clocks go forward | Confirmed | VS-P5TTNP |
| Thu May 20, 2027, 12:00 PM, 1 hr | Dayglow | Felix Novak | The last day that can be booked | Confirmed | VS-Y6YGT3 |

Blanche is also blocked on December 15 from 2:00 to 4:00 PM, as a test of blocked time.

Your own booking on December 4 and your code were left as they are.

## What was checked

Every rule below behaved as the owners decided it. Each customer used the live preview in a browser of their own, and the results were then compared with the database.

| Rule | What the site did |
| --- | --- |
| Weekday and weekend prices | Right in every booking. Paris for one hour was $68 on a Monday and $72 on a Sunday. |
| Discount for studios together | 20% off two studios and 22% off three, taken off before any code. |
| Blanche and Dayglow without Paris | Refused: "To book Blanche and Dayglow together, add Paris or choose a different combination." |
| A time that is taken | Not offered, with 15 minutes kept free on both sides. After two bookings, Paris on November 22 offered 8:00 to 8:45, 11:15 to 11:45, and 3:15 onwards. |
| Booking by time first | At 1:00 PM on November 22 only Blanche could be chosen. Paris and Dayglow read "Not available at this time". |
| 24 hours' notice | Saturday, November 21: "No times are available on this date. Please try another day." |
| Opening hours | First time 8:00 AM on a weekend. Last start 6:00 PM for one hour on a weekday, and 2:00 PM for five hours. |
| Extra guests, $5 each | Up to 4 with Paris, 6 with Blanche or Dayglow, 4 with all three, none with two studios. |
| Pet fee, $40 | Offered whenever Dayglow is in the booking. |
| Photography: 14 days' notice | A session 13 days ahead was refused: "Photography sessions are made at least 14 days ahead." |
| Photography: one photographer | While a session ran in Blanche from 1:00 to 3:00 PM, Paris offered sessions only until 11:45 AM and from 3:15 PM. |
| Photography: hours | Sessions start between 9:00 AM and 4:00 PM. |
| A rental code on a session | Refused: "That code is for studio rentals. It cannot be used for a photography session." |
| A 20% code | $72 became $57.60. Not booked, because the rest needs a card. |
| A code with one use | The second person read "That code has already been used." After the first person cancelled, it worked again. |
| A code tied to one person | Someone else read "That code belongs to a different email address." |
| A free hour on two studios | Refused: "A free hour is for one studio." |
| Studio credit | Paid for studio time, extra guests and the pet fee. $1,086.86 of the $5,000 was used, matching the four bookings exactly. |
| A client moves a paid booking | A code worth $68, valid 90 days, shown on the page and emailed. It paid for the new booking. |
| Moving the same booking again | The offer was $48: "what you paid less the $20 fee for moving a booking again". |
| Cancelling a free booking | "Nothing was charged to a card for this booking, so there is nothing to refund." |
| Cancelling a booking made with a reschedule code | "No refund is due, because this booking was made with a reschedule code." |
| A customer's account | Maya's showed her next appointment, all five bookings with their buttons, 0 of 5 stamps, and no receipts for free bookings. |
| A phone-sized screen, and Safari's engine | Both booked. Nothing was wider than the phone screen. |
| Names with accents and apostrophes | José Hernández and Liam O'Connor were stored and shown correctly. |
| The confirmation email | Reference, studio, time, total, how it was paid, and a link to view, cancel or move the booking. |
| Speed | A whole booking took 4 to 7 seconds when the test computer was not busy. Pages answered in about 0.3 seconds. |

The second round checked what happens under pressure, what employees can do, and the public pages.

| Rule | What the site did |
| --- | --- |
| Two customers confirm at the same moment | Tried four times. Exactly one got the booking each time. The other read "That time is no longer available. Please choose another." |
| One photographer, two sessions at the same moment | One session was booked. The other customer read "Our photographer is not free at that time. Please choose another." |
| The third studio beside a booked bundle | With Paris and Dayglow booked at 2:00 PM, Blanche was still offered at every time. |
| A manager's pages | Calendar, Customers, Day sheet, Hours & blocks and Photography opened. Every owner page read "This page could not be found." |
| A manager moves a booking | Moved from 10:00 AM to 2:00 PM. The page said "The client has been emailed", the label became Rescheduled, and the history names who moved it. |
| A manager books for a client | Booked with $88 "to be paid at the studio". The client was emailed a confirmation. |
| A manager records money taken at the desk | $50 in cash, then $38 on the card reader: "The booking is paid in full." |
| A manager blocks time | The public screen then offered Blanche until 12:45 PM and again from 4:00 PM. |
| An attendant's pages | Only the two assigned days. Another day read "is not assigned to you", and its appointment could not be opened. Customers, blocks and new bookings were closed. |
| Checking a client in too early | The "Checked In" button was switched off a day ahead. |
| The morning the clocks change | March 14, 2027 at 8:00 AM was stored at exactly that time. |
| The last day | May 20, 2027 could be booked. The next day read "Bookings open 180 days ahead." |
| HTML typed into the notes | Shown to staff as plain text on the appointment and the day sheet. Nothing ran. |
| Sign-in limits | The fifth wrong code read "Too many wrong codes", and the right code was then refused. A fourth code within 15 minutes was refused too. |
| The 11 public pages, on a computer and a phone | Every page answered with no error. All 84 pictures loaded, each with a description. Nothing was wider than the phone. The accessibility scan found nothing. |
| Links to book one studio | Each opened the booking screen with that studio chosen. |

## Not tested

Four things were left out, each for a reason.

- **Paying by card.** You asked to skip payment, so every booking was free or paid with a code. That leaves out a part discount such as TEST-20, buying a membership, and the bank's own check of the card.
- **Two steps that email an owner.** "Ask the studio to move it" and the contact form each send a notice to an owner's inbox, so neither was run.
- **The owners' own pages.** Prices, codes, settings, the website editor, refunds and the list of bookings need an owner's sign-in, and that code goes to an owner's inbox. A manager's and an attendant's pages were tested in the second round.
- **A real phone and real Safari.** The phone booking used a phone-sized browser window, and the Safari booking used Safari's engine on a computer.

What happens after a visit will show by itself from November 22: visits marked completed, stamps counted, and review requests sent to the test address. The preview runs these tasks once a day, at 7:00 AM Eastern.

## Test codes and clean-up

Six codes were made for the test. They work only on the preview, until February 19, 2027, and you can use them for bookings of your own.

| Code | What it does | Used so far |
| --- | --- | --- |
| TEST-FREE | 100% off a studio rental, 100 uses | 21 uses |
| TEST-PHOTO | 100% off a photography session, 20 uses | 3 uses |
| TEST-20 | 20% off a studio rental, 20 uses | None |
| TEST-CREDIT | $5,000 of studio credit, for any booking and its add-ons | $1,086.86 |
| TEST-ONCE | 100% off a studio rental, one use | Used |
| TEST-HOUR-HANNAH | One free hour, for Hannah Kim's address only | Used |

The code names are typed by hand, which the preview's admin cannot do yet. That field reaches the preview with the next merge into the main branch.

Nothing here carries over to the real site: at launch it gets a new, empty database of its own. Until then:

- **To stop a code:** Admin, Codes, "Cancel code".
- **To empty the preview:** ask Claude to remove the test bookings, customers and codes. They are all marked by their delivered+name@resend.dev addresses and TEST names.

Two more things to remove when you are done: the two test staff members, under Admin, Staff, and the blocked time in Blanche on December 15, under Hours & blocks.
