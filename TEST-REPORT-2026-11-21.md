# Preview booking test report

November 21, 2026. Prepared for the studio's owners. The same report is a private doc on claude.ai.

Thirty-nine made-up customers hold 48 bookings on the hosted preview, made on November 20 and 21, 2026. Every rule checked held, and no card was needed. 42 bookings stay confirmed on 34 days, from November 22 to May 20, for you to look at as an owner, an employee and a customer. A second and a third round tried customers at the same moment, the employee side, the public pages and the sign-in limits. A fourth tried what people do with a browser and a keyboard, phones, other time zones, and the site's defences.

## How to look at it

Use a separate browser window for each role, so one sign-in does not replace another: a normal window, a private window, and a second browser.

**As an owner.** Sign in at [the preview](https://the-visual-photo-studio.vercel.app/account) with your owner address, then open the admin.

- **Calendar:** Sunday, November 22 has four bookings in three studios. Saturday, November 28 has all three studios booked together, then Dayglow alone.
- **Bookings and Customers:** the 39 test people, each with their bookings. Maya Rivera has five visits on five days.
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

The test found thirteen things for the owners: eight on the customer's side, four on the employee's and one for search engines. None of them stopped a booking. The fourth round also found six small faults that needed no decision. They are fixed in the code and listed after the thirteen.

1. **A booking that cost nothing cannot be moved online.** A client who booked with a 100% code or a free hour presses Reschedule and reads: "Nothing was paid for this booking, so there is no credit to move. You can cancel it and book again." Cancelling gives the code back, and "Ask the studio to move it" stays available. This covers loyalty free hours too. Decide whether that is what you want.
2. **"Getting in" is empty.** Confirmation emails and booking pages give the address, but not how to enter the building. Write it under Admin, Settings, "Getting in". Confirmations include it from then on.
3. **The confirmation email gives only the total.** One email said "Total: $220" and "Paid with your studio credit: $220", with no line for the six extra guests. The booking's own page lists them, and a pet fee too. Decide whether the email should list add-ons.
4. **Two studios together take no extra guests.** Your limit for two studios is 10 people. Paris with Dayglow, or Paris with Blanche, already includes 10, so "Extra guest" offers only 0. Raise "Most guests for two studios together" in Settings if a bundle should allow more.
5. **A discount code comes back after any cancellation.** One client cancelled two days ahead, inside the seven days when nothing is refunded. The page said the code "can be used again". That suits a promotion. Decide whether it suits a one-off gift.
6. **"The client asked for this move" starts ticked.** When staff move a booking, this box is ticked to begin with. Left ticked, the move uses up the client's one free reschedule, and the booking is no longer refunded automatically. Staff have to untick it for a change the studio needs. Decide whether it should start unticked.
7. **A manager who opens the admin's first page reads "This page could not be found."** That page, the Overview, is the owners'. Managers reach the calendar from a link on their account page instead. Sending them straight to the calendar would be a small change.
8. **A manager sees the price while booking for a client.** The screen says "$88 … to be paid at the studio", though "See what bookings cost" is switched off for managers. They need the price to tell the client. Decide whether that is right with the switch off.
9. **A signed-in customer types their details again.** The booking screen starts empty even when the client is signed in. Filling in their name, email and phone would be a small change, if you want it.
10. **The site promises a refund that nobody is prompted to make.** A manager moved a paid Saturday booking back to a weekday. The client's email said: "You have paid $7 more than that: we will refund it to you." The manager, with prices switched off, saw no payment section, and the history read "(amount not shown)". No notice went to an owner. An owner sees "Remaining credit" only by opening that appointment. Booking VS-64G3XT is left in this state. Decide who should be told.
11. **Eight pages share one description for search engines.** Each page can have its own, in the page editor's search settings.
12. **The browser's Back button leaves the booking.** On the second step, Back went to the home page, not to the first step. A refresh starts the booking again with nothing kept, and closing the tab asks no question. The screen's own "← Back" button works. Decide whether the browser's Back button should go one step back.
13. **The phone number field takes any words.** It accepts anything from 7 to 40 characters, such as "no phone". Decide whether it should need digits.

Six faults from the fourth round are fixed in the code. They reach the preview with the next merge.

- **The booking pages' address for search engines.** `/book` and `/book/photography` now give a canonical address, and a shared link to either shows that page's own title.
- **Choosing a studio with the keyboard.** The three studio choices showed no sign of which one the keyboard was on. The card now gets a dark outline.
- **Moving between steps with the keyboard.** After "Next", the keyboard's place was lost: the next press of Tab started from the top of the page, and a screen reader said nothing. The focus now moves to the new step's heading.
- **Enter in the code field.** It did nothing. It now applies the code, as "Apply" does.
- **A name or phone number with line breaks.** Typed that way, a name could start paragraphs of its own in the emails that greet the client. Both are now kept on one line.
- **Links on an employee's account page.** "Studio calendar" and "Day sheet", beside "Signed in as", differed from the words around them by colour alone. They are now underlined.

Two more for a later change, neither urgent: a keyboard user presses Tab up to 40 times to get from a chosen time to "Next", and no page has a "skip to the content" link.

One measurement for a change you already asked for on November 20, the slightly darker tan: gold text on cream has a contrast of 2.1 to 1, and white on the gold buttons 2.2 to 1. Accessibility guidelines ask for 4.5 to 1 at these sizes. That work has not started.

## Test emails

Fifteen test emails reached hello@ before the instruction to stop. None has reached a real inbox since.

- **What arrived:** 13 booking confirmations, one cancellation and one reschedule code, between 11:49 and 11:57 PM on November 20. They went to hello+name@thevisualsphotostudio.com, which Gmail delivers to hello@. A search for "Booking confirmed: VS-" finds the confirmations.
- **Since then:** every test customer has an address like delivered+maya@resend.dev, [Resend's test address](https://resend.com/docs/dashboard/emails/send-test-emails). It takes an email and delivers it to nobody. The 13 bookings already made were moved to it.
- **Sent to the test address so far:** 35 confirmations, 3 cancellations, 3 notices of a moved booking, 3 payment confirmations, one reschedule code and 9 sign-in codes. That is 54 emails, all accepted. A script read all of them for stray words, broken links and leftover code, and found nothing.
- **Still to come, to the test address only:** a reminder before each visit, a review request the day after it, and Maya's free-hour code once her fifth visit is over on December 3.
- **Owners:** no owner received a test email.
- **One limit:** Resend counts test emails toward the account's sending limit, like any other.

## The bookings in the calendar

The calendar holds 42 confirmed bookings and 6 cancelled or released ones, made by 39 people. All times are Eastern Time, and every booking is a test.

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
| Wed Dec 16, 12:00 PM, 1 hr | Blanche | Ruth Alvarez | Booked by the test manager for a client and paid at the desk. Later moved to a Saturday and back, so $95 is paid for an $88 booking | Confirmed | VS-64G3XT |
| Thu Dec 17, 10:00 AM, 1 hr | Blanche | Quinn Adler | Notes that hold HTML | Confirmed | VS-V669PM |
| Fri Dec 18, 2:00 PM, 1 hr | Paris + Dayglow | Nina Petrova | Won against a customer who wanted Paris alone at the same moment | Confirmed | VS-ZTS68E |
| Sat Dec 19, 11:00 AM, 1 hr | Dayglow | Lucy Ward | Won against a customer who wanted Paris + Dayglow | Confirmed | VS-YE3MTJ |
| Mon Dec 21, 3:00 PM, 1 hr | Blanche | Jack Moreno | Won against a second customer for the same studio and time | Confirmed | VS-NNGG9Y |
| Tue Dec 22, 10:00 AM, 1 hr | Paris | Elena Fischer | A photography session, won against one in Blanche at the same time | Confirmed | VS-DNHVBR |
| Sun Mar 14, 2027, 8:00 AM, 1 hr | Paris | Dana Whitfield | The morning the clocks go forward | Confirmed | VS-P5TTNP |
| Thu May 20, 2027, 12:00 PM, 1 hr | Dayglow | Felix Novak | The last day that can be booked | Confirmed | VS-Y6YGT3 |

The third round, on the new version, added eight more.

| When | Studio | Customer | What it shows | Status | Reference |
| --- | --- | --- | --- | --- | --- |
| Wed Dec 23, 10:00 AM, 1 hr | Paris | Paula Jensen | Confirm pressed twice: one booking | Confirmed | VS-B488YN |
| Wed Dec 23, 3:00 PM, 1 hr | Dayglow | Amy Tran | Won among six customers at the same moment | Confirmed | VS-5JKTUT |
| Wed Dec 23, 3:00 PM, 1 hr | Blanche | Lea Wolf | Won among six customers at the same moment | Confirmed | VS-N82RVB |
| Mon Dec 28, 2:00 PM, 1.5 hr | Paris | Hugo Laurent | Paid with studio credit, then cancelled: the credit came back | Cancelled | VS-CUXFTP |
| Tue Dec 29, 9:00 AM, 10 hr | Blanche | Carmen Ortiz | The whole day, the longest booking sold | Confirmed | VS-UT8WST |
| Tue Jan 5, 2027, 10:00 AM, 2 hr | Paris | Irene Costa | Paid with studio credit, then released for a $136 code | Released | VS-6NTDSJ |
| Thu Jan 7, 2027, 10:00 AM, 1 hr | Paris | Irene Costa | Paid with half of that code | Confirmed | VS-7VQS9Y |
| Fri Jan 8, 2027, 10:00 AM, 1 hr | Paris | Irene Costa | Paid with the other half | Confirmed | VS-7EFJ7W |

The fourth round added five.

| When | Studio | Customer | What it shows | Status | Reference |
| --- | --- | --- | --- | --- | --- |
| Tue Jan 12, 2027, 11:00 AM, 1 hr | Paris | Kira Bolt | Booked with the keyboard alone, never the mouse | Confirmed | VS-7CMJKX |
| Wed Jan 13, 2027, 10:00 AM, 1 hr | Paris | Owen Blake | The answer to "Confirm booking" was lost on the way back. Pressing again found the booking | Confirmed | VS-PU9F2X |
| Thu Jan 14, 2027, 11:00 AM, 1 hr | Blanche | Tara Quinn | The connection dropped at the code and again at "Confirm booking" | Confirmed | VS-9SWWYB |
| Fri Jan 15, 2027, 2:00 PM, 1 hr | Dayglow | Uma Reyes | Open in two tabs, confirmed in both: one booking | Confirmed | VS-7EH6EQ |
| Fri Jan 15, 2027, 3:00 PM, 1 hr | Blanche | Vera Stone | Open in two tabs: the second tab was told the time had gone | Confirmed | VS-WCXZ8Z |

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

The third round ran after the pull request was merged, on the version the preview runs now.

| Rule | What the site did |
| --- | --- |
| The new version | Vercel deployed it one minute after the merge. All 11 public pages answered. |
| Confirm pressed twice | One booking, not two. |
| Twelve customers confirm at once, for two studios | One booking for each studio. Seven read that the time was gone: "no longer available" or "was just taken". Three read "Too many requests. Please wait a moment.", the limit of ten booking requests a minute from one visitor. |
| Lengths on offer | Blanche up to 10 hours, Dayglow up to 8, Paris up to 5. Studios together offer only the lengths each of them sells, so up to 5 hours. |
| A whole day | Blanche for 10 hours could start only at 9:00 AM, for $720. |
| Studio credit after a cancellation | $102 went back onto the credit code, to the cent. |
| A reschedule code spent in parts | A $136 code paid for two $68 bookings and then held $0. |
| A manager moves a booking to a dearer day | Saturday made it $95: the page showed $88 paid and $7 still to pay. |
| A manager moves it back to a cheaper day | The client's email said the total is $88 again and "You have paid $7 more than that: we will refund it to you." |
| A manager blocks the photographer | With 10:00 AM to 12:00 PM blocked, sessions were offered only from noon. The block was removed afterwards. |
| A membership's checkout | Showed the plan, its terms and Square's card form. Nothing was typed or paid. |
| What search engines see | A robots file, a sitemap of 10 pages, a title and a sharing picture on every page, and the business's details on the home page. An address with no page answers 404. The old addresses /guestinfo and /rates-1 redirect to the new pages. |

The fourth round tried what people do with a browser, a keyboard and a phone, and what a stranger can get out of the site.

| What was tried | What the site did |
| --- | --- |
| A booking with the keyboard alone | Booked with Tab, Space, Enter and typing. Three gaps on the way are fixed in the code, as listed above. |
| Six time zones and four languages | A computer set to Hawaii, California, New York, Germany, Japan or the far side of the date line saw the same days, times, booking pages, calendar and day sheet. The first day on offer was November 22 for each, though it was still November 20 in Hawaii. |
| The answer to "Confirm booking" is lost | The page said it could not tell whether the booking went through, and to press again. Pressing again opened the booking: one booking, one email. |
| No connection | Each step said so in words: "Could not load availability. Please try again." and "Could not check the code. Please try again." Nothing was booked until the connection came back, and then once. |
| The browser's Back button after booking | A new, empty booking screen. Nothing could be sent twice. |
| The same booking in two tabs | The first tab booked. The second read "That time is no longer available. Please choose another.", returned to the times with that one gone, and kept the name, email, phone and code. |
| An employee's pages on a phone | The manager's ten pages and the attendant's five fit an iPhone and an Android phone. Wide tables scroll inside their own box. |
| The narrowest phone, 320 points wide | The nine public pages, the booking steps and two booking pages fit. |
| A customer's account on a phone | The four pages fit, and the accessibility scan found nothing. |
| Who can open what | Signed out, every private page led to the sign-in form. A booking without its key read "Booking not found", the same for a reference that exists and one that does not. A signed-in customer read "This page could not be found." on every employee page and on another customer's receipt. |
| A sign-in link that asks to continue on another website | Landed on the account page. |
| Requests wrong in one way each | 9 for availability, 15 for a price and 30 for a booking: a past date, a time when the studio is closed, a total of $0 claimed by the browser, a made-up card token. None was booked, and each got a message, never an error of the site's own. |
| Text made to look like an attack | Tried on the site's own request check, off line. An email address with a second address or a line break is refused. A script or a database command typed as a name is stored and shown as plain text. |
| Files and headers | Private files such as `/.env` are not served. Browsers are told to use HTTPS only, and not to show the site inside another website. The daily task's address refuses a caller without its password. Another website cannot send a booking from a visitor's browser. |
| Private pages and search engines | The admin, account, employee, booking and payment pages are closed in the robots file and marked "noindex". |
| Vercel's own firewall | After about 45 probing requests in under a minute, some of them for private files, Vercel showed its "Security Checkpoint" page to everything coming from the test computer, a real browser included. About ten minutes later it let the computer back in by itself. |

## Not tested

Four things were left out, each for a reason.

- **Paying by card.** You asked to skip payment, so every booking was free or paid with a code. That leaves out a part discount such as TEST-20, buying a membership, and the bank's own check of the card.
- **Two steps that email an owner.** "Ask the studio to move it" and the contact form each send a notice to an owner's inbox, so neither was run.
- **The owners' own pages.** Prices, codes, settings, the website editor, refunds and the list of bookings need an owner's sign-in, and that code goes to an owner's inbox. A manager's and an attendant's pages were tested in the second round.
- **A real phone and real Safari.** The phone booking used a phone-sized browser window, and the Safari booking used Safari's engine on a computer.

What happens after a visit will show by itself from November 22: visits marked completed, stamps counted, and review requests sent to the test address. The preview runs these tasks once a day, between 7:00 and 8:00 AM Eastern, the most its free plan allows. So a reminder there goes out on the morning of the visit, not 24 hours before. The paid plan runs them every five minutes.

## Test codes and clean-up

Six codes were made for the test. They work only on the preview, until February 19, 2027, and you can use them for bookings of your own.

| Code | What it does | Used so far |
| --- | --- | --- |
| TEST-FREE | 100% off a studio rental, 100 uses | 30 uses |
| TEST-PHOTO | 100% off a photography session, 20 uses | 3 uses |
| TEST-20 | 20% off a studio rental, 20 uses | None |
| TEST-CREDIT | $5,000 of studio credit, for any booking and its add-ons | $1,222.86 |
| TEST-ONCE | 100% off a studio rental, one use | Used |
| TEST-HOUR-HANNAH | One free hour, for Hannah Kim's address only | Used |

The code names are typed by hand. Since the merge on November 21, the version the preview runs has that field too: Admin, Codes, "Code (optional)". It is an owners' page, so it was not opened during the test.

Nothing here carries over to the real site: at launch it gets a new, empty database of its own. Until then:

- **To stop a code:** Admin, Codes, "Cancel code".
- **To empty the preview:** ask Claude to remove the test bookings, customers and codes. They are all marked by their delivered+name@resend.dev addresses and TEST names.

Two more things to remove when you are done: the two test staff members, under Admin, Staff, and the blocked time in Blanche on December 15, under Hours & blocks.
