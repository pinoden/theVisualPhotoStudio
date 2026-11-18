# Handoff

Where the work stands. A snapshot, rewritten at each checkpoint by whichever tool worked last (see `AGENTS.md`). The history is in `git log` and in the decision log of `ProjectLibrary.md`.

**Last updated:** 2026-11-18, by Claude Code.

## State of the tree

- Branch `rebuild`, pushed. The commit that holds this file is the state described here. Nothing is uncommitted.
- `master` is at pull request #8 (2026-11-17). Everything newer on `rebuild` waits for the owner's word to merge.
- Migrations run from `0000` to `0045`. No deployment and no production migration has ever been run. Follow-up 5 added none.

## In progress

Nothing. No tool has unfinished changes in the tree.

## Verified

On the tree of this commit, 2026-11-18:

- `npm run typecheck` and `npm run lint`: clean.
- `npm test`: 1,008 tests pass.
- `npm run test:e2e`: the whole browser suite, 63 cases, passes (11.5 minutes), with the new case for follow-up 5. Near its end the development server logged "Worker terminated due to reaching memory limit: JS heap out of memory" from one of its worker processes, three times, after about eleven minutes of compiling every page; the run went on and its last test passed. None of the eight earlier full runs of 2026-11-18 logged it; the tester's long session once did (a known gap in `ProjectLibrary.md`). It is the development server's, not the site's: if it comes back on CI or on a quiet machine, look at it (the browser tests run `next dev`, never a production build).
- Follow-up 5 (repricing a booking the studio moves, the payment card): nine tests of their own (a day of the same kind keeps the price even after the prices changed; a weekend costs more and is owed, and moving back owes nothing; a weekday costs less, the difference is Remaining credit until the owner refunds it to the card; a percent code and a free hour on the new price; credit back on its code, never taken again; membership minutes with the weekend switch on and off; a day with no price refused, two kinds priced alike unchanged; a photography session never repriced; a card payment's receipt, and who may open it), and a summary test for "To be refunded". The browser suite has a new case: a Saturday booking moved to a weekday, the price shown before the move, the payment card, the client's email and booking page, and the refund of the difference to the card. `npm run check:square` (all steps pass) now asks Square's sandbox for a payment's receipt: none while the amount is only reserved, `https://squareupsandbox.com/receipt/preview/…` once it is taken.
- Memberships (follow-up 3, steps 1 to 5): verified at their commits, as recorded in the decision log of `ProjectLibrary.md`: their own tests, migrations `0041` to `0045` on copies of browser-test databases, every call to Square in its sandbox, and a membership bought, spent and cancelled with Square's own card form on a server holding the sandbox keys in its environment only.
- Three page-editor steps of `website.spec.ts` have each failed once on 2026-11-18 and passed on the rerun, each time in Puck's editor, never in what the site itself does: the header editor's "Discard changes" still running when its 20-second wait ran out; two "Delete" buttons on the canvas at once after a block was clicked; and a block dragged into a column that did not land. The last two came while a macOS system process (`ANECompilerService`) held a whole core. If one of them comes back on a quiet machine, look at it: `dragBlock` already drags again, more slowly, when Puck misses; the "Delete" click could wait for one action bar.
- Follow-up 13 (extra charges) was used in a real browser with a booking moved into the past; the browser suite has no case for it, because it cannot reach an appointment that has started (it runs on the real clock).
- CI on GitHub passed both jobs on every push of 2026-11-18, the last checked being `99fa77c` (memberships, step 5). Branch protection on `master` requires both jobs, for everyone, and refuses direct pushes.

Tester pass (2026-11-18, `.claude/agents/tester.md`) on follow-ups 6 and 9, the 7-day refund window, the food rule, the Settings fee field and `/api/health`: four low defects, all fixed in commit `3a76abc`.

Not yet through an independent tester pass: follow-ups 1, 2, 4, 5, 7, 8, 12, 13 and 15, the reminder email, bookings keeping their terms, asking the studio to move a booking, the emails' templates, and memberships (the plans, buying, cancelling, spending minutes, each month, the owners' pages).

## Done from the owner's 16 follow-up answers

Details and status of each are under "Katya's answers to the 16 follow-up questions" in `ProjectLibrary.md`.

| # | Subject | Status |
| --- | --- | --- |
| 1 | Weekend prices for longer bookings | Built |
| 2 | Extra people, $5 each with a quantity | Built; the bundle limit confirmed 2026-11-18 (question 37) |
| 3 | Memberships | Built (2026-11-18), in five steps. Questions 41 to 46 wait on the owners |
| 4 | Unused pet fee as credit, issued by hand | Built |
| 5 | Changes made by the studio: repricing, payment section | **Built (2026-11-18)**: a move to a day of the other kind reprices at today's prices; the payment card shows Paid, Outstanding balance and Remaining credit, refunds the credit to the card, and links Square payments to their receipts. Readings: question 47 |
| 6 | $20 for each reschedule after the free one | Built |
| 7 | Review request 24 hours after a visit | Built |
| 8 | No Blanche + Dayglow without Paris | Built |
| 9 | Loyalty starts over when switched on again | Built |
| 10 | Photographer's last start at 4 p.m. | Already built, verified |
| 11 | Photography needs 336 hours of notice | Already built, verified |
| 12 | Photography-only codes | Built |
| 13 | Overtime, cleaning and damage charges | Built; confirmed 2026-11-18 (question 36) |
| 14 | Instagram feed on the home page | **Waits on the owner** (connecting the account) |
| 15 | After-hours requests through the contact form | Built |
| 16 | Discount by yearly spend | Decided: not offered |

Also built from the answers of 2026-11-17: rentals refunded when cancelled 7 days ahead (photography 14), no food or drinks inside the studios, the reminder before a visit (question 29, confirmed as question 38), bookings keeping their terms (question 10), asking the studio to move a booking (question 20, confirmed as question 39), and the emails' templates (question 33, Admin → Emails).

## Go-live plan: keeping the site from failing

Agreed with the owner on 2026-11-17. Each item is done once it is checked off here.

**Already in place**

- [x] 1,008 unit and integration tests and 63 browser tests.
- [x] CI on GitHub (`.github/workflows/ci.yml`): type check, lint, unit tests and the browser suite on every pull request and every push to `rebuild`.
- [x] Branch protection on `master`: pull requests only, both CI jobs must pass, no exception for administrators, no force-push or deletion.
- [x] Payments that cannot be charged twice, prices recomputed on the server, double bookings refused by the database, background jobs safe to run late or twice, an email queue that retries.

**Can be done now (no decision needed)**

- [x] Dependabot: monthly update pull requests into `rebuild` (`.github/dependabot.yml`), and security alerts switched on.
- [x] One Node version everywhere: `web/.nvmrc` (26), read by CI. The host must use the same, or `.nvmrc` changes to the host's.
- [x] A scheduler heartbeat: each scheduled run is recorded. `GET /api/health` answers 503 when the database does not answer or, in production, the scheduler has not run for 15 minutes. The admin overview says when the scheduler stopped.
- [x] Security alerts looked at (2026-11-17): `npm audit --omit=dev` finds nothing in what the live site runs. Two medium alerts stay open, both in development tools only (`esbuild` inside `drizzle-kit`, `minimatch` inside ESLint); both go once those tools move on.
- [ ] A tester pass over everything built since 2026-11-17. Done for follow-ups 6 and 9, the refund window, the food rule and the heartbeat; still to do for the list under "Verified" above.
- [x] A one-page runbook for the owners: `RUNBOOK.md` (2026-11-18): who to call, the morning check, what to do when the site or a payment misbehaves, rolling back and restoring.

**Needs the hosting choice first**

- [ ] A staging copy: the same host, its own database branch, Square's sandbox. Every change goes there before production.
- [ ] Fill in the lines of `RUNBOOK.md` marked "(at go-live)": who to call, the site's address, how the host rolls back and the database restores.
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

1. **A tester pass** (`.claude/agents/tester.md`) over what has not had one, memberships and follow-up 5 first: buying a membership in the sandbox and in test mode, spending its minutes (in full, in part, at weekends), cancelling bookings either side of 48 hours, cancelling the membership, the owners' pages and corrections, the scheduled task a month on; then moving bookings between weekdays and weekends with codes, credit and minutes, the payment card and its refund. Then the rest of the list under "Verified". It needs the owner's go-ahead to start the tester agent.
2. On the first real booking at go-live (go-live question 4), open its "Receipt in Square" link once with the live keys, and fill in the runbook's "(at go-live)" lines.

## Waiting on the owners

- **Question 47 (follow-up 5, as built):** a move to a day of the same kind keeps the price, one to the other kind takes that day's price at today's prices; codes, credit and minutes pay the same part again, credit no longer needed goes back on its code; the difference is owed, or refunded only when the studio agrees; a card payment's link opens Square's receipt (Square documents no address of a payment in its Dashboard). An "OK" settles it.
- **Questions 41 to 46 (memberships):** 41, weekends, is a switch the owners set themselves (Settings → Memberships), on as decided on 2026-11-17: they only need to say whether to switch it off. 42 and 43 are built on the builder's readings (the rest of a longer booking pays its share; a member's booking is not moved online, but cancelled and booked again, or moved by the studio): an "OK" settles each. 44: are Blanche's plans $380 and $700 (the table) or $370 and $670 (the live site)? 45: the readings of buying one (no account needed, more than one per client, the studio not emailed for each new member, the page not put into the menu). 46: each month as built (a month's hours come once Square has taken it; a month late or failed is told to the member and the studio once; Square, not the site, tries the card again).
- **Question 40 (the emails' templates):** built on readings: only the emails to clients can be changed (the studio's notices keep the site's wording), only by owners, and the site still writes the parts that state money, codes and refunds. An "OK" settles it.
- **Follow-up 14:** the Instagram account has to be connected by an owner. It blocks nothing else and can wait until go-live.
- **Policies wording:** the line "Cancellations made less than {refund window} before the appointment are non-refundable, but may be rescheduled at no additional charge until {reschedule cutoff} before the appointment" sits above the $20 line for further reschedules, and reads as if every reschedule were free. It is the owners' text: they choose the new wording.
- **To go live:** hosting, the web address, the email service, live Square keys, a privacy policy and the sales-tax answer. Questions 1 to 6 of "Questions for the owners" in `ProjectLibrary.md`.

## Before deploying

- Apply migrations `0030` through `0045`. Keep the owners' customised prices when the weekend-price migration runs.
- Set up the scheduled task and the email service: reminders, review requests, free hours and refund retries depend on them.
- Put the Memberships page into the site's menu if the owners want it there (Website → Header, menu & footer).
- Run the whole browser suite once more.
