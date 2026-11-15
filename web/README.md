# The Visuals Photo Studio: website

The studio's public site and booking system. Next.js 16, TypeScript, PostgreSQL.

## Run it locally

You need a current Node.js LTS (22.22 or newer; it was built on Node 26). Nothing else: no database to install and no accounts to create.

```bash
npm install
npm run dev
```

Open http://localhost:3000. The first start creates a local database in `.data/` with the three studios and the current price list. Payments run in test mode, which the payment step says on screen: no card is charged.

To start over with a clean database, stop the server and delete `.data/`.

## Check your changes

```bash
npm test            # all tests
npm run typecheck
npm run lint
npm run build
```

## Production settings

Copy `.env.example` to `.env.local` and fill it in.

- `DATABASE_URL`: a PostgreSQL connection string. Required in production. Run `npm run db:migrate` and then `npm run db:seed` once against a new database.
- `SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT`: Square credentials. Without all of them a production server refuses paid bookings.
- `SITE_URL`: the public address, used in email links.

## Where things are

- `src/lib/domain/`: the rules for prices and free time, as plain functions with tests. Start here to change how a price is calculated or when a slot is offered.
- `src/server/`: the booking service, payments, time zone handling and database reads.
- `src/db/`: the table definitions, and the starting data in `seed.ts`.
- `src/app/`: pages and API routes. `src/components/BookingFlow.tsx` is the booking screen.
- `drizzle/`: database migrations. After changing `src/db/schema.ts`, run `npm run db:generate`.

Open decisions and known gaps are listed in `CLAUDE.md` at the repository root, under "Rebuild decisions".
