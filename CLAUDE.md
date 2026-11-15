# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Flask website for The Visuals Photo Studio: public marketing pages, a multi-step booking wizard with Square payments, email confirmations, and a login-protected admin dashboard. SQLite by default (`instance/studio.db`). There is no test suite or linter configured.

## Commands

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

## Architecture

- **App factory** in [app/__init__.py](app/__init__.py): `create_app()` wires the extensions (`db`, `migrate`, `login_manager`, `mail`) and registers four blueprints: `main` (public pages), `booking` (`/book`, `/book/create`, `/booking/confirmation/<ref>`), `admin` (prefix `/admin`), `api` (prefix `/api`). All settings come from [config.py](config.py), which reads `.env`.
- **Booking flow**: the wizard in `templates/book.html` (JS is inline, there is no `static/js`) calls `/api/availability` and `/api/price` for live data, then POSTs once to `/book/create`. That endpoint re-validates everything server-side, in this order: availability, then price, then the Square charge, then the `Booking` row, then emails. Emails are best-effort. Failures are logged and do not fail the booking.
- **Business logic lives in [app/utils.py](app/utils.py)**, not in routes: `calculate_price` (bundle discount, deposit, per-service hourly rates), `get_available_slots` (combines per-studio `StudioHours`, existing bookings, `BlockedSlot`s and `SLOT_INCREMENT_MINUTES`), and `charge_square`. Change pricing or availability here so the API, booking, and admin routes stay consistent.
- **Models** ([app/models.py](app/models.py)): `Studio`, `StudioHours`, `Booking` (many-to-many with studios via `booking_studio`, so one booking can span a bundle of studios), `BlockedSlot`, `Announcement`, `AdminUser`. `Booking.service_type`, `payment_status`, and `status` are plain strings with the allowed values listed in comments, not enums.
- **Admin** ([app/routes/admin.py](app/routes/admin.py), the largest file): bookings, calendar, customers (derived from bookings, not a separate table), reports, availability blocking, studio/hours editing, announcements, settings. It also serves an iCal feed at `/admin/ical/<ICAL_TOKEN>.ics`, which is token-authenticated rather than login-protected.
- **Config values duplicated in the DB**: studio hourly rates and business hours live in the DB and are edited in the admin UI. `DEFAULT_*` hours in `Config` are only fallbacks. `BUNDLE_DISCOUNT_PCT`, `DEPOSIT_PCT`, and `SLOT_INCREMENT_MINUTES` are env-driven.
- **Templates**: Jinja2, all public pages extend `base.html` and admin pages extend `admin/base_admin.html`. Brand styling is CSS variables at the top of `static/css/style.css`.

## Gotchas

- `.env` is gitignored and contains real secrets. Edit `.env.example` for documentation of new variables.
- `Config` falls back to insecure defaults (`SECRET_KEY`, `ADMIN_PASSWORD`, `ICAL_TOKEN`) when env vars are missing, so a missing `.env` will not fail loudly.
- The README's migration steps start with `db init`, but `migrations/` already exists, so only run `db upgrade`.
- The migration history is incomplete: its single migration creates only the `announcement` table. Every other table is created by `db.create_all()` inside `seed.py`. On a fresh database run `db upgrade` first and `seed.py` second. The reverse order fails because `announcement` already exists.

## Rebuild decisions

Decisions for a planned rebuild of the public site. The Flask code above is the current prototype and is not changed by these until the rebuild starts.

Record each outcome here, with the date, when it is decided. Change a line's status from **Open** to **Decided** and write the outcome, or to **Superseded** and name the replacement. Do not leave outcomes only in chat.

Live reference: the public site is Squarespace, with Acuity Scheduling for bookings. Acuity's full price list and policy text are public at `https://app.acuityscheduling.com/schedule.php?owner=28681884`.

### Stack

- **Language and framework** — **Decided (2026-11-14):** TypeScript, Next.js (React), PostgreSQL. Alternative considered and rejected: Python with Django.
- **Payments** — **Open.** Proposed: keep Square. Its Web Payments SDK runs in the browser, and its server SDK handles charges and refunds.

### Requirements from the owner (received 2026-11-14)

1. **Several studios in one booking** — **Open.** Proposed: one multi-studio price rule instead of fixed bundle products. Needs the discount. Today's bundle prices are 10% to 27% below the single-studio sum, so a flat 10% would raise most of them.
2. **Loyalty codes after a visit** — **Open.** Proposed: single-use codes emailed a few hours after a completed visit, redeemed at checkout. SMS deferred, since it needs US carrier registration and customer opt-in. Needs the reward and how long it lasts.
3. **Staff see only their day** — **Open.** Proposed: owner and staff roles. Staff see a day sheet for dates the owner assigns (times, studio, customer name, headcount, add-ons, notes), never revenue or the customer list. Needs: today only or any assigned date; whether phone numbers are shown.
4. **Weekday and weekend prices** — **Open.** Proposed: a price table by studio, day type and duration, editable in admin, with holiday overrides. Needs the weekend prices and which days count as weekend.
5. **Admin and customer accounts** — **Open.** Proposed: one user table with customer, staff and owner roles. Sign-in by emailed one-time code, no passwords. Guest checkout stays. Needs confirmation of passwordless sign-in.
6. **Two ways to book** — **Open.** Proposed: one availability engine with two views: pick a studio, then see times; or pick a date and duration, then see the free studios with prices.
7. **Reschedule code** — **Open.** Proposed: a Reschedule button in the confirmation email and the account page. It either moves the booking or issues a single-use credit for the amount paid. A rescheduled booking is never refundable, as the current policy says. Needs: how late and how often a booking can move; how long a credit lasts.
8. **Automatic refunds** — **Open.** Proposed: refunds through the Square API. Automatic only when cancelled 7 or more days ahead and never rescheduled. Owner emailed each time. Every other case is a one-click refund in admin. Needs: keep the 5% processing fee or not.

### Policies and facts to confirm with the owner

- **Cancellation window** — **Open.** The prototype's policy pages say 24 hours. The live terms say 7 days for rentals and 14 days for photography.
- **Refund amount** — **Open.** The live guest information says "100% refund", but the live terms keep a 5% processing fee.
- **Pets** — **Open.** Dayglow allows up to 2 pets, up to 70 lb each, for a $40 fee. The live guest-information page also says it does not allow pets in the studio. Confirm which applies.
- **Membership prices** — **Open.** The memberships page shows Dayglow at $280 and $520 a month, but its buy buttons charge $330 and $600. Paris shows $270 and $500 as "Coming soon", while its Acuity products are $300 and $550.
- **Newsletter** — **Open.** The sign-up form has no storage configured, so sign-ups appear not to be saved.
- **Social links** — **Open.** The footer icons link to Squarespace's own accounts, not the studio's.

### Decision log

- 2026-11-14: Stack and the eight requirements proposed.
- 2026-11-14: Language and framework decided: TypeScript, Next.js (React), PostgreSQL. All other items still open.
