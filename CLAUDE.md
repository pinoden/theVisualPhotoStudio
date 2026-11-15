# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Two codebases live here while the site is being rebuilt.

- **`web/`** is the new site: Next.js 16, TypeScript, PostgreSQL. All new work goes here. It is developed on the `rebuild` branch.
- **The repository root** (`app/`, `run.py`, `config.py`, `seed.py`, `migrations/`) is the earlier Flask prototype. It is kept as a reference for page design and copy only. Do not add features to it. It has known unfixed defects: card payments cannot succeed, the browser can skip payment, and double booking is possible.

The decisions behind the rebuild, and what is still open, are recorded under "Rebuild decisions" at the end of this file.

## New site (`web/`)

### Commands

Node.js is installed with nvm. A shell that did not load the login profile needs `. ~/.nvm/nvm.sh` first.

```bash
cd web
npm install
npm run dev          # http://localhost:3000 with an embedded database and a pretend card processor
npm test             # every test (vitest)
npx vitest run src/server/bookings.test.ts            # one file
npx vitest run -t "refuses a second booking"          # tests whose name matches
npm run typecheck    # generates Next.js route types, then runs tsc
npm run lint
npm run build
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
  - `payments.ts` defines a `PaymentProvider` with a Square implementation (plain HTTPS calls, no SDK) and a mock.
  - `tz.ts` is the only place that converts between studio wall-clock time (America/New_York) and instants.
  - `settings.ts` has the default business rules; rows in the `settings` table override them.
  - `cached.ts` exposes `getCatalog()` with `'use cache'` and the tag `catalog` for prerendered pages.
- **`src/db/`**: `schema.ts` (Drizzle), `client.ts` (`getDb()` picks PostgreSQL or PGlite; `createMemoryDb()` for tests), `seed.ts` (starting catalog, taken from the studio's live price list).
- **Double booking is prevented by the database.** Every span of time a studio is taken is a row in `studio_holds`, written by bookings and by owner blocks. An exclusion constraint in `drizzle/0001_constraints.sql` rejects two active holds that overlap on one studio. A hold covers the booking plus the studio's clean-up buffer.
- **Booking order in `createBooking`**: validate and price on the server, hold the slot (status `pending_payment`), charge the card with the booking id as idempotency key, then confirm. A failed charge releases the slot. Unpaid holds expire after `holdMinutes`; `releaseExpiredHolds` runs before every availability read and booking attempt, so there is no scheduler.
- **Prices** are a table of studio × day type (weekday or weekend) × duration in `price_rules`. Only durations with a price can be booked. `special_dates` reprices a date as the other day type. Booking several studios applies the `multiStudioPercent` setting.
- **The two booking flows** (studio first, time first) are the same steps in a different order in `src/components/BookingFlow.tsx`. Both read one endpoint, `GET /api/availability?date=`, and compute slots in the browser with the domain functions.
- **Routes**: pages `/`, `/studios`, `/rates`, `/policies`, `/book`, `/booking/[ref]?t=<secret>`; API `GET /api/availability`, `GET /api/booking-config`, `POST /api/bookings`.
- **Payment mode** is chosen in `resolvePayments`: Square when its three credentials are set; the mock when `PAYMENTS_MODE=mock` or outside production; otherwise bookings that cost money are refused. A booking is never confirmed free because payment is unconfigured.
- **Emails are only queued.** `createBooking` writes the confirmation to `email_outbox`. Nothing sends those rows yet.
- **Tables without code yet**: `users`, `login_codes`, `sessions`, `staff_shifts`, `promo_codes`, `refunds`, `blocks`. They were designed for requirements 2, 3, 5, 7 and 8 below.

### Conventions and gotchas

- **Next.js 16 differs from older versions.** Read the bundled guide in `web/node_modules/next/dist/docs/` before using an API you have not verified there (`web/AGENTS.md` says the same).
- **Cache Components is on.** A page that reads uncached data must put it behind `<Suspense>` or cache it with `'use cache'`. A page rendered per request (see `src/app/booking/[ref]/page.tsx`) calls `await connection()` first. Never cache bookings or availability.
- **The linter rejects `setState` called synchronously in an effect.** Derive values during render, or set state from event handlers and promise callbacks.
- **Money is integer cents. Times in the database are `timestamptz`.** Domain functions work with a `YYYY-MM-DD` date and minutes from local midnight.
- **Never trust totals from the browser.** `POST /api/bookings` recomputes the price and compares it with `expectedTotalCents`, so a customer is never charged an amount they did not see.
- **Constraints written by hand are not in `schema.ts`.** Add new ones with `npx drizzle-kit generate --custom --name <name>`.
- **PGlite's data folder can be opened by one process at a time.** Stop `npm run dev` before running anything else against `web/.data`. `next build` without `DATABASE_URL` prerenders from an in-memory copy of the starting catalog.
- **Tests**: domain unit tests, server tests against an in-memory PGlite (the real constraint is exercised), and component tests of the booking screen in jsdom. There is no real-browser test yet, and Square has never been called with real credentials.
- Next.js telemetry was turned off on this machine with `npx next telemetry disable`.

## Flask prototype (repository root, reference only)

Flask website with public marketing pages, a multi-step booking wizard with Square payments, email confirmations and a login-protected admin dashboard. SQLite by default (`instance/studio.db`). It has no test suite or linter.

### Commands

```bash
source venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env                           # then fill in values (see README for the variable table)

python -m flask --app run db upgrade           # apply migrations (migrations/ is Alembic via Flask-Migrate)
python -m flask --app run db migrate -m "msg"  # generate a migration after changing app/models.py
python seed.py                                 # creates the base tables, then seeds studios, hours, admin user

python run.py                                  # dev server on :5000 (debug, stat reloader); USE_SSL=true for adhoc HTTPS
```

Use `python -m flask` and `python -m pip`, not the bare `flask` / `pip` commands: the launcher scripts in the local `venv/bin` point at a `venv3/` path that no longer exists and fail with "bad interpreter".

Admin panel is at `/admin`. Use `SQUARE_ENVIRONMENT=sandbox` for development.

### Architecture

- **App factory** in [app/__init__.py](app/__init__.py): `create_app()` wires the extensions (`db`, `migrate`, `login_manager`, `mail`) and registers four blueprints: `main` (public pages), `booking` (`/book`, `/book/create`, `/booking/confirmation/<ref>`), `admin` (prefix `/admin`), `api` (prefix `/api`). All settings come from [config.py](config.py), which reads `.env`.
- **Booking flow**: the wizard in `templates/book.html` (JS is inline, there is no `static/js`) calls `/api/availability` and `/api/price` for live data, then POSTs once to `/book/create`. That endpoint re-validates everything server-side, in this order: availability, then price, then the Square charge, then the `Booking` row, then emails. Emails are best-effort. Failures are logged and do not fail the booking.
- **Business logic lives in [app/utils.py](app/utils.py)**, not in routes: `calculate_price` (bundle discount, deposit, per-service hourly rates), `get_available_slots` (combines per-studio `StudioHours`, existing bookings, `BlockedSlot`s and `SLOT_INCREMENT_MINUTES`), and `charge_square`.
- **Models** ([app/models.py](app/models.py)): `Studio`, `StudioHours`, `Booking` (many-to-many with studios via `booking_studio`), `BlockedSlot`, `Announcement`, `AdminUser`. `Booking.service_type`, `payment_status`, and `status` are plain strings with the allowed values listed in comments, not enums.
- **Admin** ([app/routes/admin.py](app/routes/admin.py), the largest file): bookings, calendar, customers (derived from bookings, not a separate table), reports, availability blocking, studio/hours editing, announcements, settings. It also serves an iCal feed at `/admin/ical/<ICAL_TOKEN>.ics`, which is token-authenticated rather than login-protected.
- **Templates**: Jinja2, all public pages extend `base.html` and admin pages extend `admin/base_admin.html`. Brand styling is CSS variables at the top of `static/css/style.css`. The new site reuses this stylesheet as `web/src/app/globals.css`.

### Gotchas

- `.env` is gitignored and contains real secrets. Edit `.env.example` for documentation of new variables.
- `Config` falls back to insecure defaults (`SECRET_KEY`, `ADMIN_PASSWORD`, `ICAL_TOKEN`) when env vars are missing, so a missing `.env` will not fail loudly.
- The README's migration steps start with `db init`, but `migrations/` already exists, so only run `db upgrade`.
- The migration history is incomplete: its single migration creates only the `announcement` table. Every other table is created by `db.create_all()` inside `seed.py`. On a fresh database run `db upgrade` first and `seed.py` second. The reverse order fails because `announcement` already exists.

## Rebuild decisions

The record of what was decided for the rebuild, what was built, and what still needs an answer.

Record each outcome here, with the date, when it is decided. Change a line's status from **Open** to **Decided** and write the outcome, or to **Superseded** and name the replacement. Do not leave outcomes only in chat.

Live reference: the public site is Squarespace, with Acuity Scheduling for bookings. Acuity's full price list and policy text are public at `https://app.acuityscheduling.com/schedule.php?owner=28681884`.

### Stack

- **Language and framework** — **Decided (2026-11-14):** TypeScript, Next.js (React), PostgreSQL. Alternative considered and rejected: Python with Django.
- **Where the new code lives** — **Decided (2026-11-14):** `web/` in this repository, on the `rebuild` branch. The Flask code stays untouched as a reference.
- **Node.js** — **Decided (2026-11-14):** installed with nvm (current LTS).
- **Database access** — **Decided (2026-11-14, by Claude):** Drizzle ORM with SQL migrations in `web/drizzle/`. PGlite for local development and tests so nothing has to be installed; PostgreSQL through `DATABASE_URL` in production. No production database has been chosen or created yet.
- **Payments** — **Open.** Built as proposed: Square behind a provider interface, called over HTTPS, with a mock for development. The owner has not confirmed Square, and no real Square credentials have been tried.
- **Hosting** — **Open.** Not discussed yet.

### Requirements from the owner (received 2026-11-14)

1. **Several studios in one booking** — **Built (2026-11-14); discount Open.** Any set of studios can be booked together for the same time. The discount is a setting keyed by studio count. Placeholder: 20% for 2 studios, 22% for 3, chosen to sit near today's bundle prices, which are 10% to 27% below the single-studio sum. Needs the owner's numbers.
2. **Loyalty codes after a visit** — **Open, not built.** Proposed: single-use codes emailed a few hours after a completed visit, redeemed at checkout. SMS deferred, since it needs US carrier registration and customer opt-in. Needs the reward and how long it lasts. The `promo_codes` table and promo support in `pricing.ts` exist.
3. **Staff see only their day** — **Open, not built.** Proposed: owner and staff roles. Staff see a day sheet for dates the owner assigns (times, studio, customer name, headcount, add-ons, notes), never revenue or the customer list. Needs: today only or any assigned date; whether phone numbers are shown. The `staff_shifts` table exists.
4. **Weekday and weekend prices** — **Built (2026-11-14); prices Open.** Prices are stored per studio, day type and duration, and a date can be repriced as the other day type for holidays. Weekend prices were seeded equal to weekday prices. Needs the weekend prices and which days count as weekend (currently Saturday and Sunday). There is no admin screen for editing prices yet.
5. **Admin and customer accounts** — **Open, not built.** Proposed: one user table with customer, staff and owner roles. Sign-in by emailed one-time code, no passwords. Guest checkout stays. Needs confirmation of passwordless sign-in. Today a customer reaches a booking through the secret link in the confirmation email.
6. **Two ways to book** — **Built (2026-11-14).** `/book` offers "I know which studio I want" and "I know when I want to come". The second shows, for a date and duration, how many studios are free at each time, then which ones.
7. **Reschedule code** — **Open, not built.** Proposed: a Reschedule button in the confirmation email and the account page. It either moves the booking or issues a single-use credit for the amount paid. A rescheduled booking is never refundable, as the current policy says. Needs: how late and how often a booking can move; how long a credit lasts.
8. **Automatic refunds** — **Open, not built.** Proposed: refunds through the Square API. Automatic only when cancelled 7 or more days ahead and never rescheduled. Owner emailed each time. Every other case is a one-click refund in admin. Needs: keep the 5% processing fee or not.

### Defaults chosen while building (placeholders until the owner decides)

All of these are data or settings, not code, unless noted.

- **Payment at booking** — the full amount is charged when booking, as on the live site. The prototype's 30% deposit option was dropped.
- **Durations** — only the durations on the live price list can be booked (for example Paris stops at 5 hours).
- **Notice and horizon** — bookings open 24 hours to 180 days ahead (`minLeadHours`, `maxAdvanceDays`). The live site asks for 24 hours' notice.
- **Slots and clean-up** — start times every 30 minutes (`slotIncrementMinutes`); 10 minutes of clean-up after every booking in every studio. The live site uses 7 to 20 minutes depending on the product.
- **Included guests** — Blanche 6, Dayglow 6, Paris 4. Shown as information; not enforced.
- **Add-ons** — "1 to 2 extra people" $30 and "3 to 5 extra people" $50 for any studio, pet fee $40 for bookings that include Dayglow. The live site varies the extra-people tiers by studio.
- **Policies page** — carries the live rental terms (7-day window, 5% fee). It changes when the two policy items below are decided.
- **Not carried over yet** — photography packages, memberships, seasonal-setup notices, the waitlist, and the pages for FAQ, contact and services.

### Policies and facts to confirm with the owner

- **Cancellation window** — **Open.** The prototype's policy pages say 24 hours. The live terms say 7 days for rentals and 14 days for photography.
- **Refund amount** — **Open.** The live guest information says "100% refund", but the live terms keep a 5% processing fee.
- **Pets** — **Open.** Dayglow allows up to 2 pets, up to 70 lb each, for a $40 fee. The live guest-information page also says it does not allow pets in the studio. Confirm which applies.
- **Membership prices** — **Open.** The memberships page shows Dayglow at $280 and $520 a month, but its buy buttons charge $330 and $600. Paris shows $270 and $500 as "Coming soon", while its Acuity products are $300 and $550.
- **Newsletter** — **Open.** The sign-up form has no storage configured, so sign-ups appear not to be saved.
- **Social links** — **Open.** The footer icons link to Squarespace's own accounts, not the studio's.

### Known gaps in what is built

- No email is sent; confirmations wait in `email_outbox`.
- No rate limiting on `POST /api/bookings`.
- A customer whose connection drops after paying sees a network error; retrying is safe (the slot is theirs, so the retry is refused and the card is not charged again) but the message is confusing. A client request id would fix it.
- If the server stops between a successful charge and confirming the booking, the booking stays `pending_payment` and its slot is released when the hold expires. Nothing reconciles that case yet.
- The booking screen has automated tests but has not been clicked through in a real browser.

### Decision log

- 2026-11-14: Stack and the eight requirements proposed.
- 2026-11-14: Language and framework decided: TypeScript, Next.js (React), PostgreSQL.
- 2026-11-14: Owner said to start the rebuild. Node.js installed with nvm. New app scaffolded in `web/` on branch `rebuild`.
- 2026-11-14: First milestone built: data model, prices by weekday and weekend, availability, booking any set of studios, both booking flows, payment through a provider interface. Requirements 1, 4 and 6 are built with placeholder numbers.
