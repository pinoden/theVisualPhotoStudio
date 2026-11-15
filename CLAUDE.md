# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

- **`web/`** is the site: Next.js 16, TypeScript, PostgreSQL. All code lives there. Work happens on the `rebuild` branch and reaches `master` through pull requests.
- **The repository root** holds only this file, a short `README.md` and `.gitignore`.

The site replaced an earlier Flask prototype that lived at the repository root (`app/`, `run.py`, `config.py`, `seed.py`, `migrations/`). It was deleted on 2026-11-15 at the owner's request. Its last version is commit `f1420bc`: list its files with `git ls-tree -r --name-only f1420bc app` and read one with `git show f1420bc:app/templates/faq.html`. It is a reference for page design and copy only. It had unfixed defects: card payments could not succeed, the browser could skip payment, and double booking was possible.

The decisions behind the rebuild, and what is still open, are recorded under "Rebuild decisions" at the end of this file.

## The site (`web/`)

### Commands

Node.js is installed with nvm. A shell that did not load the login profile needs `. ~/.nvm/nvm.sh` first.

```bash
cd web
npm install
npm run dev          # http://localhost:3000 with an embedded database and a pretend card processor
npm test             # every test (vitest)
npx vitest run src/server/bookings.test.ts            # one file
npx vitest run -t "refuses a second booking"          # tests whose name matches
npm run test:e2e     # browser tests (Playwright); starts its own server on port 3211
E2E_SHOTS=1 npm run test:e2e                          # also saves full-page pictures to test-results/shots
E2E_NAME=tester E2E_PORT=3213 npm run test:e2e        # a second run at the same time: its own port, database, build and results folders
npx playwright test -g "staff see the day sheet"      # one browser test by name (they build on each other; see below)
npm run typecheck    # generates Next.js route types, then runs tsc
npm run lint
npm run build
npm run check:square # the site's own Square code against Square's sandbox; reads web/.env.square-sandbox; no money moves
npm run db:generate  # after editing src/db/schema.ts: writes a migration into drizzle/
DATABASE_URL=postgres://... npm run db:migrate        # real PostgreSQL only
DATABASE_URL=postgres://... npm run db:seed           # real PostgreSQL only
```

Local development needs no database install and no credentials. Without `DATABASE_URL` the app uses PGlite (PostgreSQL compiled to WebAssembly) stored in `web/.data`, migrates it on start and seeds the starting catalog. Delete `web/.data` to reset local data. `web/.env.example` lists the variables for production.

### Architecture

- **Business rules are pure functions in `src/lib/domain/`** (`time.ts`, `pricing.ts`, `availability.ts`). The browser uses them for instant previews and the server uses the same code as the only authority. A new rule about prices or free time belongs there with a test, never in a component or a route.
- **`src/server/`** holds everything that touches the database or the outside world:
  - `catalog.ts` loads studios, opening hours, price rules, add-ons and settings as one serializable `Catalog`.
  - `availability.ts` turns stored holds into per-studio taken time for one day and decides which dates are bookable.
  - `bookings.ts` is the booking service (`createBooking`, `getBookingByToken`).
  - `payments.ts` defines a `PaymentProvider` with a Square implementation (plain HTTPS calls, no SDK) and a mock. A request to Square times out after 10 seconds and is sent again, up to three times; the idempotency key makes a repeat safe. A refused card gets a sentence for the customer from `CARD_PROBLEMS`, and Square's own words go on the payment record. A charge that never gets an answer comes back as `unknown`: the booking is not made, the customer is told the charge cannot be confirmed, and the owner is emailed.
  - `tz.ts` is the only place that converts between studio wall-clock time (America/New_York) and instants.
  - `settings.ts` has the default business rules; rows in the `settings` table override them. It also keeps the getting-in text (`loadAccessInstructions`, `saveAccessInstructions`), which is deliberately not part of `Settings`: `Settings` goes to every browser inside the catalog, and that text can hold the code for the building door. The catalog carries only the fact that it is set (`accessInfoSent`).
  - `cached.ts` exposes `getCatalog()` with `'use cache'` and the tag `catalog` for prerendered pages.
- **`src/db/`**: `schema.ts` (Drizzle), `client.ts` (`getDb()` picks PostgreSQL or PGlite; `createMemoryDb()` for tests), `seed.ts` (starting catalog, taken from the studio's live price list).
- **Double booking is prevented by the database.** Every span of time a studio is taken is a row in `studio_holds`, written by bookings and by owner blocks. An exclusion constraint in `drizzle/0001_constraints.sql` rejects two active holds that overlap on one studio. A hold covers the booking plus the studio's clean-up buffer.
- **Booking order in `createBooking`**: validate and price on the server, hold the slot (status `pending_payment`), charge the card with the booking id as idempotency key, then confirm. A failed charge releases the slot and gives back any code that was spent. Unpaid holds expire after `holdMinutes`; `releaseExpiredHolds` runs before every availability read and booking attempt, so freeing slots does not depend on the scheduler. After a successful booking the browser loads the booking page as a new document (`navigate` in `BookingFlow`), not through the router, so the finished selection is not kept alive behind it.
- **Prices** are a table of studio × day type (weekday or weekend) × duration in `price_rules`. Only durations with a price can be booked. `special_dates` reprices a date as the other day type. Booking several studios applies the `multiStudioPercent` setting.
- **The two booking flows** (studio first, time first) are the same steps in a different order in `src/components/BookingFlow.tsx`. Both read one endpoint, `GET /api/availability?date=`, and compute slots in the browser with the domain functions.
- **Routes**: pages `/`, `/studios`, `/rates`, `/policies`, `/faq` (guest information), `/services` (photography sessions), `/contact`, `/book`, `/booking/[ref]?t=<secret>`, `/account`, `/account/sign-in`, `/staff`, `/admin` (with sub-pages for bookings, prices, studios and add-ons, hours, staff, codes, settings), `/dev/outbox`; API `GET /api/availability`, `GET /api/booking-config`, `POST /api/quote`, `POST /api/bookings`, `GET /api/cron/tick`. Everything a signed-in person changes goes through server actions (`actions.ts` next to the pages).
- **Payment mode** is chosen in `resolvePayments`: Square when its three credentials are set; the mock when `PAYMENTS_MODE=mock` or outside production; otherwise bookings that cost money are refused. A booking is never confirmed free because payment is unconfigured.
- **Access control lives in each page and each action**, never in a layout: `requireUser`, `requireStaff` and `requireOwner` in `src/server/session.ts`. Someone without the role gets the ordinary not-found page. The admin sidebar (`src/app/admin/frame.tsx`) is rendered by each admin page after its check for the same reason. The services in `staff.ts` and `manage.ts` check the viewer or actor again themselves; the functions in `admin.ts` do not, so every caller must run `requireOwner` first.
- **`src/server/runtime.ts`** is the glue for requests: site address, which processor and mail service to use, who gets refund notices, and `flushEmailsSoon()` (delivers queued mail after the response).
- **`src/server/auth.ts`** implements passwordless sign-in: emailed six-digit codes, rate-limited to 3 per 15 minutes, hashed in the database. Sessions are 30-day tokens (SHA-256 hashed). `OWNER_EMAILS` controls the owner role; adding or removing an address takes effect at the next request.
- **`src/server/manage.ts`** handles post-booking changes: customer cancellation (with automatic refund by policy), reschedule codes (release the booking and issue a credit), and owner cancel/refund. Refunds are recorded, then sent to the processor with the refund id as idempotency key; failures are retried by the scheduled task.
- **`src/server/staff.ts`** serves the staff day sheet: bookings on assigned days only, with contact details controlled by `staffSeesContact`. Attendance marking (came / no-show) is allowed after a booking starts.
- **`src/server/promos.ts`** manages promo codes: loyalty (percent off, single use), reschedule credits (amount, decremented as spent), and manual codes created by the owner. Redemption is atomic with the booking.
- **`src/server/tasks.ts`** runs the recurring work: release expired holds, flag payments whose result was never recorded (the owner is emailed), mark visits complete, issue loyalty codes, retry open refunds, deliver queued email. Called by `GET /api/cron/tick`.
- **`src/server/email.ts`** queues all mail in `email_outbox` (same transaction as the change it reports). Delivery happens right after the response and again from the scheduled task: through Resend when `RESEND_API_KEY` and `EMAIL_FROM` are set, to the server log outside production, and not at all in production without those two (mail then waits in the table). A message can carry a reply address (`reply_to`).
- **`src/server/contact.ts`** takes messages from the contact page. A message is not stored on its own: it becomes one queued email to the owner (`OWNER_NOTIFY_EMAIL`, else the first of `OWNER_EMAILS`) with the visitor's address as the reply address. Nothing is ever emailed to the address a visitor typed. With no owner address the form refuses messages and gives the phone number.
- **`src/server/admin.ts`** holds what only the owner can do: staff and shifts, prices, special dates, opening hours, blocked time, the bookings list, codes, each studio's text, guest number and clean-up time, and the add-ons.
- **`src/server/rate-limit.ts`** is an in-memory sliding-window limiter used by the booking endpoint.
- **`/dev/outbox`** lists queued emails, including sign-in codes, and can run the scheduled tasks on demand. It answers "not found" in production. Never expose a non-production build to the internet.

### Conventions and gotchas

- **Next.js 16 differs from older versions.** Read the bundled guide in `web/node_modules/next/dist/docs/` before using an API you have not verified there (`web/AGENTS.md` says the same).
- **Cache Components is on.** A page that reads uncached data must put it behind `<Suspense>` or cache it with `'use cache'`. A page rendered per request (see `src/app/booking/[ref]/page.tsx`) calls `await connection()` first. Never cache bookings or availability.
- **The linter rejects `setState` called synchronously in an effect.** Derive values during render, or set state from event handlers and promise callbacks.
- **Money is integer cents. Times in the database are `timestamptz`.** Domain functions work with a `YYYY-MM-DD` date and minutes from local midnight.
- **Never trust totals from the browser.** `POST /api/bookings` recomputes the price and compares it with `expectedTotalCents`, so a customer is never charged an amount they did not see.
- **Constraints written by hand are not in `schema.ts`.** Add new ones with `npx drizzle-kit generate --custom --name <name>`.
- **PGlite's data folder can be opened by one process at a time.** Stop `npm run dev` before running anything else against `web/.data`. `next build` without `DATABASE_URL` prerenders from an in-memory copy of the starting catalog.
- **Tests** come in four kinds: domain unit tests; server tests against an in-memory PGlite, set up by `src/server/testing.ts` (the real constraints are exercised); component tests of the booking screen in jsdom; and browser tests in `web/e2e/`. Resend has never been called. Square has been called in its sandbox only, by `npm run check:square`, which is not part of `npm test`.
- **Browser tests** start their own dev server on port 3211 with a throwaway database (`.data/e2e`), their own build folder (`.next-e2e`), the mock processor and two owners (`owner@studio.test`, `owner2@studio.test`). Sign-in codes are limited to three per address in 15 minutes, so a fourth owner sign-in in one run has to use the second address. They read sign-in codes from `/dev/outbox`. They share one database and run in order, so a single test run with `-g` only works if it does not depend on an earlier one. Any error in the browser console fails the test. A second run can go on at the same time under its own name: `E2E_NAME=tester E2E_PORT=3213` gives it `.data/e2e-tester`, `.next-e2e-tester` and `test-results-tester`. `tsconfig.json` already lists the `tester` build folder; with another name Next.js would add lines there on its first start.
- **Earlier pages stay in the document, hidden.** With Cache Components, the router keeps recently visited pages mounted (`display: none`) so their state survives going back. Client state therefore outlives navigation: reset it deliberately where that matters. In browser tests use role locators, or `byLabel`, `byText` and `onScreen` from `e2e/helpers.ts`; a plain text or label locator also matches the hidden copies.
- **One build folder, one process.** A dev server started on a build folder that another process is still writing to corrupts the cache, and every page then reloads in a loop (about 30 times a second, with nothing in the log but "Compiled"). It happened twice: with two sessions active, and when a server was started within a second of killing the previous one. Wait for the old process to exit before starting a new one. To recover, stop the servers and delete `web/.next/dev`. The browser tests avoid it by building into their own folder, `.next-e2e` (`NEXT_DIST_DIR`), which they delete at every start.
- **More than one Claude Code session may be working in this checkout.** Before committing, run `git status` and `git log -5`, and commit only what you changed and verified.
- **A button whose `formAction` is a server action cannot have a `name`.** React overrides it and logs an error, which fails the browser tests. Give each button its own action (see the two add-on actions in `src/app/admin/actions.ts`).
- **One stylesheet.** `src/app/globals.css` was carried over from the Flask prototype. Brand colours and fonts are CSS variables at its top.
- Next.js telemetry was turned off on this machine with `npx next telemetry disable`.

## Agents

`.claude/agents/tester.md` defines a second agent, the **tester**. It runs the test suites, uses the site in a real browser as a customer, a staff member and the owner, and reports defects with steps to reproduce. It does not change application code, commit or push: fixing what it finds is the builder's job.

- Ask for it by name ("use the tester agent to test the contact form") or with `@agent-tester`. `claude --agent tester` runs a whole session as the tester.
- It works on port 3213 with its own database, build and results folders (see "Browser tests" above), so it can run while a dev server or the usual browser tests are running.
- Claude Code picks up a changed agent file within seconds. A session that started before `.claude/agents/` existed has to be restarted once to see it.
- Agent definitions are in git. The rest of `.claude/` is personal and ignored.

## Rebuild decisions

The record of what was decided for the rebuild, what was built, and what still needs an answer.

Record each outcome here, with the date, when it is decided. Change a line's status from **Open** to **Decided** and write the outcome, or to **Superseded** and name the replacement. Do not leave outcomes only in chat.

Live reference: the public site is Squarespace, with Acuity Scheduling for bookings. Acuity's full price list and policy text are public at `https://app.acuityscheduling.com/schedule.php?owner=28681884`.

### Stack

- **Language and framework** — **Decided (2026-11-14):** TypeScript, Next.js (React), PostgreSQL. Alternative considered and rejected: Python with Django.
- **Where the new code lives** — **Decided (2026-11-14):** `web/` in this repository, on the `rebuild` branch.
- **What happens to the Flask prototype** — **Superseded (2026-11-15).** Decided 2026-11-14: it stays untouched as a reference. Replaced 2026-11-15: the owner had it deleted from the repository and from the development machine. It remains in git history; its last version is commit `f1420bc`.
- **Node.js** — **Decided (2026-11-14):** installed with nvm (current LTS).
- **Database access** — **Decided (2026-11-14, by Claude):** Drizzle ORM with SQL migrations in `web/drizzle/`. PGlite for local development and tests so nothing has to be installed; PostgreSQL through `DATABASE_URL` in production. No production database has been chosen or created yet.
- **Payments** — **Open.** Built as proposed: Square behind a provider interface, called over HTTPS, with a mock for development. The owner has not confirmed Square as the processor. It works in Square's sandbox (verified 2026-11-15, see the decision log); production keys have never been used. The sandbox keys from the prototype's settings file are kept on the development machine in `web/.env.square-sandbox`. Git ignores that file and the site does not read it; `npm run check:square` does. To see the real card form locally, copy its four lines into `web/.env.local`. The browser tests then fail, because they expect the pretend processor.
- **Hosting** — **Open.** Not discussed yet.

### Requirements from the owner (received 2026-11-14)

1. **Several studios in one booking** — **Built (2026-11-14); discount Open.** Any set of studios can be booked together for the same time. The discount is a setting keyed by studio count. Placeholder: 20% for 2 studios, 22% for 3, chosen to sit near today's bundle prices, which are 10% to 27% below the single-studio sum. Needs the owner's numbers.
2. **Loyalty codes after a visit** — **Built (2026-11-14); reward Open.** Single-use percent-off codes emailed automatically after a completed visit. The scheduled task (`runScheduledTasks`) marks visits complete after `loyaltyDelayHours`, then issues and emails the code. Redeemed at checkout like any promo code, by the customer it was sent to only. Placeholder: 10% off the studio rental, valid 60 days, sent 2 hours after the visit ends, switched by the `loyaltyEnabled` setting. It only happens if something calls `GET /api/cron/tick` on a schedule, which is not set up yet. SMS deferred (US carrier registration needed). Needs the owner's reward percentage and validity period.
3. **Staff see only their day** — **Built (2026-11-14); contact visibility Open.** Owner and staff roles with passwordless sign-in. Staff see a day sheet at `/staff` for dates the owner assigns (times, studio, customer name, add-ons, notes), never revenue or other dates. The owner assigns days in `/admin/staff`. The `staffSeesContact` setting controls whether phone and email are shown. Staff can mark attendance (came / no-show) after a booking's start time. Needs: whether phone numbers are shown by default.
4. **Weekday and weekend prices** — **Built (2026-11-14); prices Open.** Prices are stored per studio, day type and duration, and a date can be repriced as the other day type for holidays. The owner edits prices in `/admin/prices`. Weekend prices were seeded equal to weekday prices. Needs the weekend prices and which days count as weekend (currently Saturday and Sunday).
5. **Admin and customer accounts** — **Built (2026-11-14).** One user table with customer, staff and owner roles. Sign-in by emailed six-digit one-time code, no passwords. The first sign-in creates the account; `OWNER_EMAILS` controls who is the owner. Guest checkout stays (the secret link in the confirmation email still works). Customer account at `/account` shows bookings, codes and cancel/reschedule actions.
6. **Two ways to book** — **Built (2026-11-14).** `/book` offers "I know which studio I want" and "I know when I want to come". The second shows, for a date and duration, how many studios are free at each time, then which ones.
7. **Reschedule code** — **Built (2026-11-14); cutoffs Open.** Reschedule button on the confirmation page and the account page. Releases the booking and issues a single-use credit code for the amount paid, emailed to the customer. The customer books a new time and enters the code at checkout; if the new booking costs more they pay the difference, if less the rest stays on the code. A rescheduled booking cannot be refunded and cannot be moved again (one move per booking, `maxReschedules`). Placeholder: cutoff 24 hours before start, credit valid 90 days. Needs: how late and how often a booking can move; how long a credit lasts.
8. **Automatic refunds** — **Built (2026-11-14); fee Open.** Cancelling 7+ days ahead automatically refunds to the card minus the 5% processing fee, via the Square refund API (or recorded for retry when the processor is not configured). The owner is emailed on every refund, and once when a refund first fails. Cancelling inside the window or after a reschedule gives no refund, and the customer is told so before confirming. The owner can cancel any booking and choose the refund amount in `/admin/bookings`, or issue a partial refund without cancelling. Failed refunds are retried by the scheduled task. Needs: keep the 5% processing fee or not.

### Defaults chosen while building (placeholders until the owner decides)

All of these are data or settings, not code, unless noted.

- **Payment at booking** — the full amount is charged when booking, as on the live site. The prototype's 30% deposit option was dropped.
- **Durations** — only the durations on the live price list can be booked (for example Paris stops at 5 hours).
- **Notice and horizon** — bookings open 24 hours to 180 days ahead (`minLeadHours`, `maxAdvanceDays`). The live site asks for 24 hours' notice.
- **Slots and clean-up** — start times every 30 minutes (`slotIncrementMinutes`); 10 minutes of clean-up after every booking in every studio. The live site uses 7 to 20 minutes depending on the product.
- **Included guests** — Blanche 6, Dayglow 6, Paris 4. Shown as information; not enforced.
- **Add-ons** — "1 to 2 extra people" $30 and "3 to 5 extra people" $50 for any studio, pet fee $40 for bookings that include Dayglow. The live site varies the extra-people tiers by studio.
- **Cancelling and moving** — refund when cancelled 168 hours or more ahead, less a 5% fee (`refundWindowHours`, `refundFeePercent`); a reschedule code can be requested until 24 hours before the start (`rescheduleCutoffHours`), once per booking (`maxReschedules`), and is valid 90 days (`creditValidDays`). The first two follow the live terms; the last three are guesses.
- **Loyalty** — 10% off the next rental, valid 60 days, sent 2 hours after a visit ends (`loyaltyPercent`, `loyaltyValidDays`, `loyaltyDelayHours`).
- **Staff** — do not see customers' phone numbers or emails (`staffSeesContact` is off); they see any day the owner assigns, not only today.
- **Sign-in** — codes last 10 minutes, lock after 5 wrong tries, at most 3 per address in 15 minutes; sessions last 30 days. These are constants in `src/server/auth.ts`, not settings.
- **Owners** — the addresses in the `OWNER_EMAILS` environment variable, and nobody else.
- **Policies page** — carries the live rental terms (7-day window, 5% fee). Its text is written by hand: it does not follow the settings, so change both together.
- **Guest information page** (`/faq`) — follows the live site's guest information page, adapted to what this site does (automatic refunds, reschedule codes, two ways to book). Every number that is a setting or a price is read from the catalog, so it follows the admin. The house rules are written by hand, as on the policies page: change both together.
- **Contact page** — address, phone and opening hours (read from the catalog) and a message form. At most 5 messages in 10 minutes per address. No copy goes to the visitor. Topics: studio rental, photography session, membership, my booking, something else. The page shows no email address, as on the live site.
- **Menu** — "Contact" was added, so the links need about 960px. The menu switches to its compact form at 1000px and below (it was 768px).
- **Services page** (`/services`) — describes the photography sessions as the live page does: what is included, outfits and edited pictures by session length, delivery in 7 to 14 days. It shows no prices and does not name the photographer. A session is asked for through the contact page, because photography cannot be booked on this site yet. The live page's Christmas mini sessions were left out.
- **Not carried over yet** — booking a photography session online, memberships, seasonal-setup notices and seasonal mini sessions, the waitlist, and the privacy policy page.

### Policies and facts to confirm with the owner

- **Cancellation window** — **Open.** The deleted prototype's policy pages said 24 hours. The live terms say 7 days for rentals and 14 days for photography.
- **Refund amount** — **Open.** The live guest information says "100% refund", but the live terms keep a 5% processing fee.
- **Pets** — **Open.** Dayglow allows up to 2 pets, up to 70 lb each, for a $40 fee. The live guest-information page also says it does not allow pets in the studio. Confirm which applies.
- **Membership prices** — **Open.** The memberships page shows Dayglow at $280 and $520 a month, but its buy buttons charge $330 and $600. Paris shows $270 and $500 as "Coming soon", while its Acuity products are $300 and $550.
- **Newsletter** — **Open.** The sign-up form has no storage configured, so sign-ups appear not to be saved.
- **Social links** — **Open.** The footer icons link to Squarespace's own accounts, not the studio's.
- **Photography sessions** — **Open.** On the live site they are booked online like a studio, with their own prices and a 14-day cancellation window. Here they are asked for by message and the page gives no prices. Decide whether they should be bookable online; that needs the price for each studio and session length, and a way to know when the photographer is free. The live page also spells the photographer's name two ways.
- **Door access code** — **Built (2026-11-15); the text is Open.** The live guest information says the confirmation email includes the access code for the building door. The owner now types how to get in under Settings, "Getting in". Customers with a confirmed booking get that text in the confirmation email and see it on their booking page. Public pages only say that the email explains it, and only once the text is set. It is empty until the owner fills it in. After a change, earlier customers see the new text on their booking page but keep the old email. Needs: the text itself.
- **Food and drinks** — **Open.** The live guest information says they are not allowed in the studios. The live rental terms say not on furniture. The new site says "not on furniture" on both the policies and the guest information page.
- **Pet fee on a refund** — **Open.** The live terms call the $40 pet fee non-refundable, and the policies page repeats that. The site refunds the whole card payment, pet fee included, when a booking is cancelled in time. The guest information page does not call the fee non-refundable.
- **Names of the lights** — **Open.** The live page lists the continuous lights as "Amaram 150, Godos, and Neewer". The new page says Amaran 150, Godox and Neewer, on the assumption that the first two were misspelt.

### Known gaps in what is built

Not connected to the outside world yet:

- **Square is verified in its sandbox only.** Through the site's own code: a charge, the same charge sent twice, four kinds of refused card, partial and full refunds. In a browser: Square's card form, a refused card, a paid booking and its refund. Never done: a payment with production keys. The browser tests still use the pretend processor, so the card form is checked by hand, not by a test that runs every time.
- **No email has ever been sent.** The Resend transport is written but untried. In production, without `RESEND_API_KEY` and `EMAIL_FROM`, nothing goes out, including sign-in codes, so nobody could sign in.
- **Nothing calls the scheduled tasks.** `GET /api/cron/tick` must be called every few minutes by a scheduler (with `CRON_SECRET`). Until then visits are not marked completed, no loyalty codes go out, and failed refunds are not retried.
- **No production database, hosting or domain** has been chosen.

Known weaknesses:

- The contact form has no CAPTCHA. A hidden field that only programs fill in, and the limit of 5 messages in 10 minutes, are its only protection against automated spam.
- `POST /api/bookings` is rate-limited to 10 requests a minute per address, in memory. The contact form's limit works the same way. That is per server process, keyed by the `x-forwarded-for` header (everyone shares one bucket when it is missing), and nothing else is limited by address.
- A customer whose connection drops after paying sees a network error; retrying is safe (the slot is theirs, so the retry is refused and the card is not charged again) but the message is confusing. A client request id would fix it.
- A card can be charged without a booking being made in two rare cases: the server stops between the charge and confirming the booking, or Square takes the payment but its answer never arrives after three attempts. In both the slot is released and the owner is emailed to look for the payment in Square and refund it by hand (in the first case by the scheduled task, once the hold has expired). Nothing refunds it automatically. Reserving the amount first and taking it only once the booking is confirmed (Square's delayed capture) would remove both cases.
- A refund that Square accepts as pending is recorded as done. If Square rejects it afterwards, nothing notices.
- A loyalty code can reach a customer whom staff mark as a no-show later than `loyaltyDelayHours` after the visit. The owner can cancel the code in `/admin/codes`.
- The owner can edit each studio's tagline, description, guest number and clean-up time, and the add-ons, under "Studios & add-ons" (2026-11-15). Not yet from the admin: a studio's name, photos, and adding or removing a studio; those are database rows. The Flask prototype's admin had a calendar, reports, a customer list, announcements and an iCal feed; none of them were carried over.
- Studio photos are placeholders (tinted boxes).
- The browser tests run against the development server with the mock processor, not a production build.

### Decision log

- 2026-11-14: Stack and the eight requirements proposed.
- 2026-11-14: Language and framework decided: TypeScript, Next.js (React), PostgreSQL.
- 2026-11-14: Owner said to start the rebuild. Node.js installed with nvm. New app scaffolded in `web/` on branch `rebuild`.
- 2026-11-14: First milestone built: data model, prices by weekday and weekend, availability, booking any set of studios, both booking flows, payment through a provider interface. Requirements 1, 4 and 6 are built with placeholder numbers.
- 2026-11-14: All eight requirements built with placeholder settings. Passwordless sign-in, customer accounts, staff day sheet, loyalty codes, reschedule codes, automatic refunds and retry, email delivery via Resend, owner admin dashboard (bookings, prices, hours, staff, codes, settings). Rate limiting on the booking endpoint. Playwright e2e test suite. 210 unit/integration tests passing.
- 2026-11-15: Verified in a real browser: all 13 browser tests pass from a cold start, with any browser console error failing the test. Found and fixed on the way: the booking screen kept its finished selection after paying (it now loads the booking page as a new document); two processes sharing one build folder corrupted it and made every page reload in a loop (the browser tests now build into `.next-e2e`). Two Claude Code sessions worked in this checkout at the same time that night; the three commits `8a1ab9e`, `54035c1` and `b1de4cd` came from the other one.
- 2026-11-15: The owner asked to delete everything old and keep only what the new site needs. Removed from the repository: the Flask prototype (`app/`, `migrations/`, `run.py`, `config.py`, `seed.py`, `requirements.txt`, the root `.env.example`) and its README, which a short one replaces. Removed from the development machine: the Python environment, the seed database (it held no bookings) and the old settings file. Kept from that settings file: its four Square sandbox lines, now in `web/.env.square-sandbox`. Git history was not rewritten, so the prototype can still be read at commit `f1420bc`.
- 2026-11-15: Added the guest information page (`/faq`) and the contact page with a message form (`/contact`), both following the live site. Queued email can now carry a reply address (migration `0004_email_reply_to`). The menu switches to its compact form at 1000px. Reading the live guest information raised four questions for the owner, listed under "Policies and facts to confirm": the door access code, food and drinks, the pet fee on a refund, and the names of the lights. 220 unit and integration tests and 15 browser tests pass.
- 2026-11-15: Added the services page (`/services`). It describes the photography sessions and sends people to the contact page to ask for one, because photography cannot be booked online here yet. Whether it should be is a new question for the owner.
- 2026-11-15: First run against Square's sandbox, with the sandbox keys carried over from the prototype. The owner was asked whether to test with them and answered "keep going". `npm run check:square`: a charge, the same charge sent twice, four kinds of refused card, a partial and a full refund, a refund larger than the payment and a refund of an unknown payment all behaved as expected. In a browser: Square's card form appeared, a wrong security code was refused, a test card paid for a booking, and cancelling it refunded $64.60 through Square. Fixed on the way: a refused card showed Square's code instead of a sentence; requests to Square had no time limit and no retry; a charge with no answer told the customer the card was not charged. 239 unit and integration tests and 15 browser tests pass.
- 2026-11-15: Added the getting-in text: the owner sets it in Settings, and customers with a confirmed booking get it by email and on their booking page. It is kept out of the public catalog because it can hold the door code. 245 unit and integration tests and 16 browser tests pass.
- 2026-11-15: The scheduled task now notices a payment whose result was never recorded, which is what a server stopping in the middle of a charge leaves behind, and emails the owner to check it in Square.
- 2026-11-15: Added "Studios & add-ons" to the admin: the owner can change each studio's tagline, description, guest number and clean-up time, and add, change or stop offering add-ons. Bookings already made keep the add-on name and price they were made with. 254 unit and integration tests and 17 browser tests pass.
- 2026-11-15: Added a tester agent (`.claude/agents/tester.md`) at the owner's request. So that it can work beside other sessions in this checkout, a second browser-test run can now use its own port and folders. Two runs side by side both passed all 17 tests.
