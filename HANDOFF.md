# Handoff

Where the work stands. A snapshot, rewritten at each checkpoint by whichever tool worked last (see `AGENTS.md`). The history is in `git log` and in the decision log of `ProjectLibrary.md`.

**Last updated:** 2026-11-18, by Claude Code.

## State of the tree

- Branch `rebuild`, pushed. The commit that holds this file is the state described here. Nothing is uncommitted.
- `master` is at pull request #8 (2026-11-17), which holds everything up to the commit before this one. Anything newer on `rebuild` waits for the owner's word to merge.
- Migrations run from `0000` to `0036`. No deployment and no production migration has ever been run.

## In progress

Nothing. No tool has unfinished changes in the tree.

## Verified

On the tree of this commit, 2026-11-17:

- `npm run typecheck` and `npm run lint`: clean.
- `npm test`: 903 tests pass.
- `npm run test:e2e`: the whole browser suite, 59 cases, passes (rerun on this commit, 2026-11-18).
- Migrations `0035` and `0036` were each tried on copies of two browser-test databases. `0030` to `0033` were checked against older data by Codex.
- CI on GitHub: the first run (commit `ae4cc99`, Node 24, UTC) passed both jobs: `checks` in 3 minutes, `browser` (59 cases) in 14 minutes. The run on `58007de`, the first with Node 26 from `web/.nvmrc`, passed both jobs too (`browser` in 10 minutes).
- Branch protection on `master` requires the CI jobs `checks` and `browser` to pass, for everyone, and refuses direct pushes (set 2026-11-17).

Tester pass (2026-11-18, `.claude/agents/tester.md`) on follow-ups 6 and 9, the 7-day refund window, the food rule, the Settings fee field and `/api/health`: four low defects, all fixed in this commit (see the decision log). Not covered by it: the 503 answer of `/api/health` in a production build, migrations `0035` and `0036` on an older database (checked by hand earlier), photography reschedule fees, staff-role views, keyboard and screen-reader use.

Not yet through an independent tester pass: follow-ups 1, 4, 7, 8, 12 and 15.

## Done from the owner's 16 follow-up answers

Details and status of each are under "Katya's answers to the 16 follow-up questions" in `ProjectLibrary.md`.

| # | Subject | Status |
| --- | --- | --- |
| 1 | Weekend prices for longer bookings | Built |
| 2 | Extra people, $5 each with a quantity | **To build.** Bundle limits wait on the owner |
| 3 | Memberships (5 and 10 hours a month, Square subscriptions) | **To build.** The largest item |
| 4 | Unused pet fee as credit, issued by hand | Built |
| 5 | Changes made by the studio: repricing, payment section | Repricing on a new time only, as confirmed 2026-11-17. The payment section is **to build** |
| 6 | $20 for each reschedule after the free one | Built |
| 7 | Review request 24 hours after a visit | Built |
| 8 | No Blanche + Dayglow without Paris | Built |
| 9 | Loyalty starts over when switched on again | Built |
| 10 | Photographer's last start at 4 p.m. | Already built, verified |
| 11 | Photography needs 336 hours of notice | Already built, verified |
| 12 | Photography-only codes | Built |
| 13 | Overtime, cleaning and damage charges | **To build** |
| 14 | Instagram feed on the home page | **Waits on the owner** (connecting the account) |
| 15 | After-hours requests through the contact form | Built |
| 16 | Discount by yearly spend | Decided: not offered |

Also built from the answers of 2026-11-17: rentals refunded when cancelled 7 days ahead (photography 14), and no food or drinks inside the studios.

## Go-live plan: keeping the site from failing

Agreed with the owner on 2026-11-17. Each item is done once it is checked off here.

**Already in place**

- [x] 896 unit and integration tests and 59 browser tests.
- [x] CI on GitHub (`.github/workflows/ci.yml`): type check, lint, unit tests and the browser suite on every pull request and every push to `rebuild`.
- [x] Branch protection on `master`: pull requests only, both CI jobs must pass, no exception for administrators, no force-push or deletion.
- [x] Payments that cannot be charged twice, prices recomputed on the server, double bookings refused by the database, background jobs safe to run late or twice, an email queue that retries.

**Can be done now (no decision needed)**

- [x] Dependabot: monthly update pull requests into `rebuild` (`.github/dependabot.yml`), and security alerts switched on.
- [x] One Node version everywhere: `web/.nvmrc` (26), read by CI. The host must use the same, or `.nvmrc` changes to the host's.
- [x] A scheduler heartbeat: each scheduled run is recorded. `GET /api/health` answers 503 when the database does not answer or, in production, the scheduler has not run for 15 minutes. The admin overview says when the scheduler stopped.
- [x] Security alerts looked at (2026-11-17): `npm audit --omit=dev` finds nothing in what the live site runs. Two medium alerts stay open, both in development tools only: `esbuild` 0.18 inside `drizzle-kit`'s old loader (the flaw is in esbuild's development server, which it does not use), and `minimatch` inside ESLint (the patched version has another API and would break ESLint). Both go once `drizzle-kit` and ESLint move on; Dependabot will offer it.
- [ ] A tester pass over everything built since 2026-11-17. Done for follow-ups 6 and 9, the refund window, the food rule and the heartbeat (2026-11-18); still to do for follow-ups 1, 4, 7, 8, 12 and 15.
- [ ] A one-page runbook for the owners: who to call, how to roll back, how to restore.

**Needs the hosting choice first**

- [ ] A staging copy: the same host, its own database branch, Square's sandbox. Every change goes there before production.
- [ ] Monitoring that alerts a phone: an uptime check on `/` and `/api/health`, and error tracking on bookings and payments.
- [ ] Backups: the provider's point-in-time restore, plus a daily export to a second provider. A practice restore before launch, then each quarter.
- [ ] `DATABASE_URL` through the database's connection pooler: a serverless host opens many connections.
- [ ] Database migrations as a step of each release: back up, migrate, then deploy.
- [ ] Two-factor sign-in on GitHub, the host, the database, Square, the email service and the domain registrar, with at least two owners able to get in.

**At launch and after**

- [ ] Keep the Acuity booking page running for the first weeks, so customers can book if the new site has to be switched off.
- [ ] Deploy Monday to Wednesday mornings, never before or during a weekend; watch the site for 30 minutes after each deploy.
- [ ] Monthly: merge Dependabot's update pull request once CI passes. Security fixes as soon as they come.
- [ ] After every incident: a short note, and a test that reproduces it.

## Next, in this order

1. **Follow-up 13: overtime, cleaning and damage charges.** Overtime at the studio's hourly rate in 15-minute blocks, each started block a quarter of the rate. Cleaning and damage as an amount an administrator types. Paid at the studio or by payment link.
2. **Follow-up 2: extra people (bundle limits confirmed 2026-11-17: every guest counts).** One $5 add-on taken in a quantity, in place of the two add-ons of today. Blanche and Dayglow include 6 guests and allow 6 more, Paris includes 4 and allows 4 more. Build the single-studio part; the bundle limits wait on the owner.
3. **Reminder email 24 hours before an appointment** (question 29 of the answers of 2026-11-17). The review request after a visit is its model: `queueReviewRequests` in `web/src/server/tasks.ts`.
4. **Each booking keeps the terms in effect when it was made** (question 10).
5. **A client asks the studio to move a booking** (question 20).
6. **Follow-up 3: memberships.** Plan it before building: it needs Square's subscriptions.
7. **The admin's email templates** (question 33).

## Waiting on the owners

- **Follow-up 14:** the Instagram account has to be connected by an owner.
- **Policies wording:** the line "Cancellations made less than {refund window} before the appointment are non-refundable, but may be rescheduled at no additional charge until {reschedule cutoff} before the appointment" now sits above the $20 line for further reschedules, and reads as if every reschedule were free. It is the owners' text: they choose the new wording (for example "…may be rescheduled until …, the first time at no charge").
- **To go live:** hosting, the web address, the email service, live Square keys, a privacy policy and the sales-tax answer. Questions 1 to 6 of "Questions for the owners" in `ProjectLibrary.md`.

## Before deploying

- Apply migrations `0030` through `0036`. Keep the owners' customised prices when the weekend-price migration runs.
- Set up the scheduled task and the email service: review requests, free hours and refund retries depend on them.
- Run the whole browser suite once more.
