# The Visuals Photo Studio: website

The studio's public site and booking system. Next.js 16, TypeScript, PostgreSQL.

## Run it locally

You need a current Node.js LTS (22.22 or newer; it was built on Node 26). Nothing else: no database to install and no accounts to create.

```bash
npm install
npm run dev
```

Open http://localhost:3000. The first start creates a local database in `.data/` with the three studios and the current price list.

Locally nothing leaves your machine:

- **Payments** run in test mode, which the payment step says on screen. No card is charged.
- **Emails** are not sent. Every message the site would send, including sign-in codes, is listed at http://localhost:3000/dev/outbox.
- **Scheduled work** (marking visits completed, sending the free hours that visits earned) does not run by itself. The "Run scheduled tasks now" button on `/dev/outbox` runs it.

To see the owner's admin at `/admin`, create `.env.local` containing `OWNER_EMAILS=you@example.com`, restart, and sign in with that address at `/account`. The same address receives the messages sent from the contact page; without it the form refuses messages.

To start over with a clean database, stop the server and delete `.data/`.

## Check your changes

```bash
npm test            # unit and integration tests
npm run test:e2e    # the site clicked through in a real browser
npm run typecheck
npm run lint
npm run build
```

`npm run check:square` runs the site's own payment code against Square's sandbox: a charge, refused cards and refunds. No money moves. It needs sandbox keys in `.env.square-sandbox` (four `SQUARE_` lines, as in `.env.example`) and refuses any other kind of key. It is not part of `npm test`.

The browser tests need Playwright's browser once: `npx playwright install chromium`. They start their own server with their own database and build folder, so they can run while `npm run dev` is running. A second run can go on at the same time: `E2E_NAME=tester E2E_PORT=3213 npm run test:e2e` uses its own port, database, build and results folders.

Run only one dev server per folder. If every page starts reloading in a loop, stop the servers and delete `.next/dev`.

## Production settings

Copy `.env.example` to `.env.local` and fill it in. Each variable is explained there.

- `DATABASE_URL`: a PostgreSQL connection string. Run `npm run db:migrate` and then `npm run db:seed` once against a new database.
- `SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`: without all three a production server refuses paid bookings. Which of Square's accounts they are for is read from the application id; `SQUARE_ENVIRONMENT` can be left empty, and when set must agree with it.
- Going live: each booking records whether it was made in test mode. Once the live keys are set, the site refuses to open a database that holds test mode's bookings. `DATABASE_URL=... npm run db:clear-test-mode` lists what it would remove (test mode's bookings and what they made) and what it keeps (every other booking, the website, studios, prices, settings, staff, the owners' own codes and changes of stamps); add `-- --yes` to remove it. Or start from a new database. Stop every server running in test mode on that database first, and keep demos and staging off the live database: what they book is test mode's. Clear it before the first build with the live keys, not only before the first start: `next build` with `DATABASE_URL` opens the database too, and is refused like the site.
- `RESEND_API_KEY`, `EMAIL_FROM`: without them no email is sent, so nobody can sign in.
- `OWNER_EMAILS`: who can open `/admin`. The first address also receives refund notices and messages from the contact page, unless `OWNER_NOTIFY_EMAIL` names another.
- `CRON_SECRET`: for the scheduler that must call `GET /api/cron/tick` every few minutes.
- `SITE_URL`: the public address, used in email links.

## Where things are

- `src/lib/domain/`: the rules for prices, free time, refunds and rescheduling, as plain functions with tests. Start here to change how a price is calculated or when a slot is offered.
- `src/server/`: bookings, payments, sign-in, codes, cancelling and refunds, staff access, the owner's functions, email, scheduled tasks.
- `src/db/`: the table definitions, and the starting data in `seed.ts`.
- `src/app/`: pages, their `actions.ts` files, and API routes. `src/components/BookingFlow.tsx` is the booking screen.
- `e2e/`: browser tests.
- `drizzle/`: database migrations. After changing `src/db/schema.ts`, run `npm run db:generate`.

Open decisions and known gaps are listed in `ProjectLibrary.md` at the repository root, under "Rebuild decisions".
