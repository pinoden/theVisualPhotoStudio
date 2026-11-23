# Working on this repository

Instructions for every coding tool that works here (Codex, Claude Code, others). Codex loads this file by itself. Claude Code loads it through `CLAUDE.md`, which imports it. Keep it short: both tools load it in every session, and Codex stops reading project instructions at 32 KiB.

## What this is

The website and booking system of The Visuals Photo Studio, a photo-studio rental in Winter Park, FL with three studios (Blanche, Dayglow, Paris). It replaces a Squarespace site with Acuity Scheduling.

- `web/` holds all the code: Next.js 16, TypeScript, PostgreSQL (PGlite locally).
- `web/AGENTS.md` is written by Next.js. Leave its block as it is and commit it when `next dev` changes it.
- The site is not deployed. It has no host, email service or live payment keys yet.

## Three files to know

| File | What it holds | When to read it |
| --- | --- | --- |
| `HANDOFF.md` | Where the work stands now: last commit, what is verified, what is in progress, what is next, what waits on the owners | At the start of every session. Update it before you stop. |
| `ProjectLibrary.md` | The full guide to the code and the record of every decision. About 290,000 characters. | In parts, as a task needs them. Never whole. `grep -n '^##' ProjectLibrary.md` lists its sections. |
| `AGENTS.md` (this file) | The rules both tools follow | Loaded automatically |

Sections of `ProjectLibrary.md` worth knowing:

- "Commands", "Architecture" and "Conventions and gotchas" under "The site (`web/`)": read the last one before changing code, and the part of "Architecture" for the area you touch.
- "Rebuild decisions": requirements, the owners' answers, defaults chosen while building, known gaps, and the decision log.
- "Katya's answers to the 16 follow-up questions": the owner-approved work list, with the status of each item.

## Start of a session

1. `git fetch`, `git status`, `git log -5`. The last commit may be another tool's.
2. Read `HANDOFF.md`.
3. If the tree has uncommitted changes you did not make, leave them alone. `HANDOFF.md` should say whose they are. If it does not, ask the owner before touching them.

## End of a session, and each checkpoint

1. Verify (see "Verification").
2. Record what was decided or built in `ProjectLibrary.md`: under its subject, and as a dated line in the decision log.
3. Rewrite `HANDOFF.md` so that it describes the tree as you leave it. Do not append to it: it is a snapshot, not a log.
4. Commit and push to `rebuild`. Do not leave verified work uncommitted. If you must stop with unfinished changes in the tree, say so under "In progress" in `HANDOFF.md`.

## Two tools, one checkout

- One tool works in this checkout at a time. To work at the same time, give the second tool its own git worktree and its own `npm install`.
- Never edit files under `web/` while a browser-test run or a tester pass is going: its server reads the working tree, and the run reports failures that are not real.
- One process per build folder and per local database. A second browser-test run needs its own name and port: `E2E_NAME=<name> E2E_PORT=<port> npm run test:e2e`. Ports in use: 3000 (dev), 3211 (browser tests), 3213 (the tester), 3214 (WebKit), 3215 (a production build).
- Create a migration only on an up-to-date tree, so that two tools never take the same number.
- End each commit message with a line that names the tool that wrote it (Claude Code adds `Co-Authored-By`; Codex adds `Tool: Codex`), so the history shows whose work a commit is.
- What one tool learns that the other needs goes in this file or in `ProjectLibrary.md`. A tool's private memory or notes are invisible to the other.

## Git

- Work on `rebuild`. `master` changes only through a pull request, and a pull request is merged only when the owner says so for that one, and only once CI has passed (GitHub refuses it before).
- Commit and push to `rebuild` at each verified checkpoint without asking. Never force-push.
- Check staged files for keys and local data before each commit. `.env*` files are ignored and stay that way.
- The repository is public. Do not write personal details, addresses or keys into any file.
- GitHub's `gh` is at `~/.local/bin/gh`, which is not on every shell's PATH.

## Commands

Run from `web/`. A shell that did not load the login profile needs `. ~/.nvm/nvm.sh` first. `web/.nvmrc` holds the one Node version (CI reads it too): `nvm use` in `web/` picks it.

```bash
DATABASE_URL="" npm run dev   # http://localhost:3000, embedded database, pretend card processor (see below)
npm test             # unit and integration tests (vitest), about a minute
npm run typecheck
npm run lint
npm run knip         # files, exports and packages nothing uses (web/knip.jsonc)
npm run test:e2e     # browser tests (Playwright), about 11 minutes, own server on port 3211
E2E_NAME=webkit E2E_PORT=3214 npx playwright test --browser=webkit   # the same in WebKit, Safari's engine (`npx playwright install webkit` once)
E2E_BUILD=1 E2E_NAME=prod E2E_PORT=3215 npx playwright test --browser=webkit   # the same against a production build, over HTTPS
npm run db:generate  # after editing src/db/schema.ts
npx drizzle-kit generate --custom --name <name>   # a migration written by hand
npm run check:square # the Square code against Square's sandbox; needs web/.env.square-sandbox
```

To show the owner the site: `DATABASE_URL="" OWNER_EMAILS=owner@studio.test npm run dev -- --hostname localhost`, then sign in at `/account` with that address. The sign-in code is at `/dev/outbox`.

## Verification

Before a commit of code: `npm run typecheck`, `npm run lint`, `npm run knip` and `npm test`, all clean. Before a pull request, and after any change to pages, forms or booking: the whole browser suite too. Read the last lines of a test log before saying it passed. Say in `HANDOFF.md` exactly what was run.

A migration is tried on a copy of a database that holds real rows before it is committed (see "Conventions and gotchas").

GitHub runs the same checks (`.github/workflows/ci.yml`) on every pull request into `master` and every push to `rebuild`:
- the job `checks`: type check, lint, unused code (`knip`), unit and integration tests;
- the job `browser`: the whole browser suite in Chromium;
- the job `webkit`: the same suite in WebKit, Safari's engine;
- the job `webkit-production`: the same suite in WebKit against a production build, served over HTTPS (since 2026-11-20).

Branch protection on `master` requires all four jobs to pass before a pull request can be merged (`webkit` and `webkit-production` since 2026-11-20, each after five runs in a row passed), for everyone, the owner included, and refuses direct pushes to `master`. A failed browser run keeps its screenshots and traces as an artifact for 14 days. CI retries no failed test (`playwright.config.ts` says why) and refuses a `test.only`. Read a failure before running the job again (`gh run rerun <id> --failed`). One that does not come back was a flake: record it in `HANDOFF.md` and fix its cause. The repository is public, so CI's minutes are free. Dependabot opens update pull requests into `rebuild` once a month (`.github/dependabot.yml`); CI runs on them too, and they are merged like any other change. CI runs in UTC, as the host will. Running the suites locally before pushing is still expected: CI is the gate, not the first check.

## Rules that are easy to break

- **Next.js 16 is not the Next.js you know.** Read the guide in `web/node_modules/next/dist/docs/` before using an API you have not verified there.
- **`web/.env.local` points at staging.** `neon link` wrote staging's `DATABASE_URL` there, and `next dev`, `next build` and `next start` read it. Since 2026-11-23 it also holds staging's object-storage credential under the AWS names (`neon deploy` wrote them): the site never reads those (its video storage reads `NEON_STORAGE_*` and `VIDEO_BUCKET`, set on Vercel's Production only), so a local server and the tests keep videos in their own database. Never copy them into another file or print them. A local server started without `DATABASE_URL=""` writes to the database that the hosted preview shares: on 2026-11-20 a scratch server made test bookings there. The browser tests blank it themselves (`playwright.config.ts`). Reach staging only on purpose.
- **A migration that was pushed is never edited.** Correct it with a new one. A migration must also be right for a database that already holds values and pages the owners changed.
- **Money is integer cents.** The server recomputes every price: never trust a total from the browser.
- **Business rules are settings or data, not constants.** Prices, hours, windows and fees are changed by the owners in the admin. A new rule gets a setting, and the public pages read it through live values.
- **Text on the public pages belongs to the owners.** Change the starting text in `built-in-pages.ts`, and replace only the original sentence in stored pages, with a migration.
- **Do not decide business rules.** When an answer from the owners is missing, build nothing on a guess without recording it under "Rules built on the builder's reading" in `ProjectLibrary.md`, and put the question in `HANDOFF.md`.
- **Never print or commit keys.** Square's sandbox keys are in `web/.env.square-sandbox`. Production keys are typed into the host by the owner, never into a message or a file here.
- **Do not start a deployment or run a production migration.** Each needs the owner's word.
- **Do not probe the hosted preview like a scanner.** Vercel's firewall stands in front of it. On 2026-11-21 about 45 quick requests, some for paths such as `/.env`, made it refuse everything from the builder's Mac for ten minutes, a real browser included. Send odd requests from a browser page of the site, a few seconds apart, and try attack-like text on the code off line (`bookingInput.safeParse`), not on the preview.
- **The hosted preview sends real email** (through Resend, to any address, since 2026-11-20). A test customer there gets Resend's test address, `delivered+<name>@resend.dev`, which reaches no inbox. Never an address at the studio's domain: `hello+<name>@` lands in the studio's inbox, as 15 test emails did on 2026-11-20. Never an owner's address, and never a made-up one, which bounces. A step that notifies an owner (the contact form, a client's request to move a booking) needs the owner's word.

## An independent test pass

`.claude/agents/tester.md` holds the instructions of the tester: run the suites, use the site in a real browser as a customer, a staff member and an owner, and report defects without changing code. Claude Code runs it as a subagent. Another tool can follow the same file in a fresh session. Work that has not had such a pass is listed in `HANDOFF.md`.
