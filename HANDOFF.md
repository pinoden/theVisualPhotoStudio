# Handoff

Where the work stands. A snapshot, rewritten at each checkpoint by whichever tool worked last (see `AGENTS.md`). The history is in `git log` and in the decision log of `ProjectLibrary.md`.

**Last updated:** 2026-11-18, by Claude Code.

## State of the tree

- Branch `rebuild`, pushed. The commit that holds this file is the state described here. Nothing is uncommitted.
- `master` is at pull request #8 (2026-11-17). Everything newer on `rebuild` waits for the owner's word to merge.
- Migrations run from `0000` to `0045`. No deployment and no production migration has ever been run.

## In progress

Nothing. No tool has unfinished changes in the tree.

## Verified

On the tree of this commit, 2026-11-18:

- `npm run typecheck` and `npm run lint`: clean.
- `npm test`: 995 tests pass.
- `npm run test:e2e`: the whole browser suite, 62 cases, passes (11 minutes), with the new cases for the emails' templates, the membership plans and a membership bought, spent and cancelled (the old address, the plans, the checkout, the code by email, an hour in Paris paid with it and no card, the account showing 4 hours left, cancelling), and the new pages in the accessibility scan and the phone checks.
- Memberships, step 4 (each month): five tests of their own (a month recorded once, with its minutes and email, and Square asked at most once an hour; a month not paid told once the day after, then recorded when paid; payments Square stopped and a cancellation made at Square; a membership left half-bought carried on, and one never paid given up with the studio told; only the processor set up now asked). Migration `0045` on a copy of a browser-test database: the column added, a second run changes nothing.
- Memberships, step 3 (spending minutes): sixteen tests of their own (the price in full, in part and at weekends with the switch on and off; a bundle's studios one at a time and together; refusals for another studio, another client, a session and the other kind of money; a refused card and an expired hold giving the minutes back; two bookings never spending the same minutes; cancelling 48 hours or more ahead and later; the studio's cancellation; moves refused; a member's visit counting for loyalty). Migration `0044` on a copy of a browser-test database with 26 bookings: they keep no minutes, an unknown membership is refused, and a second run changes nothing.
- Memberships, step 2 (buying online, cancelling): every call to Square in its sandbox through the site's own code (`npm run check:square`, all steps pass): a customer, the first month, its card kept, a plan and a second price, a subscription from next month (pending, cancelled before billing) and one from today (Square charged the kept card by itself, read back as paid, cancelled to the end of the month). Then in a real browser with Square's own card form on a server holding the sandbox keys in its environment only (port 3216): a membership bought, seen in the account, cancelled; the site's database and Square agree (Square: pending until December 18, cancelled on that day, so it never bills). A booking through `/book` with Square's card form also went through after the card form's loader was changed. The pages used on a separate server at 1280 and 390 pixels wide: nothing wider than the screen, no browser errors.
- Memberships, step 1 (the plans): Admin → Memberships used in a real browser on a separate server (port 3215) at 1280 and 390 pixels wide: the twelve plans, a plan added for Paris, the six choices of studios (no Blanche with Dayglow without Paris); nothing wider than the screen, no browser errors.
- The emails' templates: every email to a client was compared word for word with the builders of commit `29e6202` over every branch of each (about 500 combinations), by a check written for the purpose and removed afterwards: identical. The two pages of Admin → Emails were used in a real browser on a separate server (port 3215), at 1280 and 390 pixels wide: a part put in where the cursor was, a part the email does not have refused as it was typed, a save, the list showing whose wording, and going back to the site's; nothing wider than the screen, no browser errors. The accessibility scan covers both pages.
- Migration `0043` (memberships) on a copy of a browser-test database with 26 bookings: the four tables added empty, `/studio-memberships` redirected to `/memberships` while an owner's own redirect stays, an unknown status, a repeated code, zero minutes and deleting a plan with members refused, and a second run changes nothing. Migration `0042` (the membership plans) on a copy of a browser-test database holding 26 bookings: the twelve plans of the owners' table with their 20 studios, zero minutes refused, and a second run changes nothing. Migration `0041` (the emails' templates) on a copy of a browser-test database holding 25 bookings: the table is added empty, a subject without a text is refused, and a second run changes nothing. Earlier: `0035` and `0036` on copies of two browser-test databases; `0037` on a copy with 25 bookings; `0038` on a copy whose owners had changed Paris's guests and renamed a tier (kept); `0039` on a copy with 25 bookings; `0035` to `0040` together on an older database (at `0034`, 16 bookings). `0030` to `0033` were checked against older data by Codex.
- One browser run on 2026-11-18 failed once at the header editor's "Discard changes" (`website.spec.ts`, the font and logo case): the discard was still running when the 20-second wait ran out, with the dev server busy. Every run since has passed. If it comes back, look at how long a discard takes under load.
- Follow-up 13 (extra charges) was used in a real browser with a booking moved into the past; the browser suite has no case for it, because it cannot reach an appointment that has started (it runs on the real clock).
- CI on GitHub passed both jobs on every push of 2026-11-18, the last checked being `0e85990` (spending minutes). Branch protection on `master` requires both jobs, for everyone, and refuses direct pushes.

Tester pass (2026-11-18, `.claude/agents/tester.md`) on follow-ups 6 and 9, the 7-day refund window, the food rule, the Settings fee field and `/api/health`: four low defects, all fixed in commit `3a76abc`.

Not yet through an independent tester pass: follow-ups 1, 2, 4, 7, 8, 12, 13 and 15, the reminder email, bookings keeping their terms, asking the studio to move a booking, the emails' templates, and memberships so far (the plans, buying, cancelling, spending minutes, each month).

## Done from the owner's 16 follow-up answers

Details and status of each are under "Katya's answers to the 16 follow-up questions" in `ProjectLibrary.md`.

| # | Subject | Status |
| --- | --- | --- |
| 1 | Weekend prices for longer bookings | Built |
| 2 | Extra people, $5 each with a quantity | Built; the bundle limit confirmed 2026-11-18 (question 37) |
| 3 | Memberships | **Being built.** Rules answered 2026-11-18; the plan is under follow-up 3. Steps 1 to 4 done (the plans, buying and cancelling, spending minutes, each month); step 5 (the owners' members' pages) next; questions 41 to 46 open |
| 4 | Unused pet fee as credit, issued by hand | Built |
| 5 | Changes made by the studio: repricing, payment section | Repricing on a new time only, as confirmed 2026-11-17. The payment section is **to build** |
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

- [x] 995 unit and integration tests and 62 browser tests.
- [x] CI on GitHub (`.github/workflows/ci.yml`): type check, lint, unit tests and the browser suite on every pull request and every push to `rebuild`.
- [x] Branch protection on `master`: pull requests only, both CI jobs must pass, no exception for administrators, no force-push or deletion.
- [x] Payments that cannot be charged twice, prices recomputed on the server, double bookings refused by the database, background jobs safe to run late or twice, an email queue that retries.

**Can be done now (no decision needed)**

- [x] Dependabot: monthly update pull requests into `rebuild` (`.github/dependabot.yml`), and security alerts switched on.
- [x] One Node version everywhere: `web/.nvmrc` (26), read by CI. The host must use the same, or `.nvmrc` changes to the host's.
- [x] A scheduler heartbeat: each scheduled run is recorded. `GET /api/health` answers 503 when the database does not answer or, in production, the scheduler has not run for 15 minutes. The admin overview says when the scheduler stopped.
- [x] Security alerts looked at (2026-11-17): `npm audit --omit=dev` finds nothing in what the live site runs. Two medium alerts stay open, both in development tools only (`esbuild` inside `drizzle-kit`, `minimatch` inside ESLint); both go once those tools move on.
- [ ] A tester pass over everything built since 2026-11-17. Done for follow-ups 6 and 9, the refund window, the food rule and the heartbeat; still to do for the list under "Verified" above.
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

1. **Follow-up 3: memberships**, by the plan under follow-up 3 in `ProjectLibrary.md`. Steps 1 to 4 are done: the plans, buying online and cancelling, spending minutes, and each month (`runMembershipBilling` in the scheduled task). Next, step 5, the owners' side: Admin → Memberships gets a list of members (plan, state, minutes left, next billing date, a problem if any) and a member's page (their payments, every change to their minutes with its reason, an owner's correction of the minutes with a reason, as stamps are corrected, and cancelling for the member). Then a tester pass over memberships and the other work not yet through one.
2. A tester pass over the work not yet through one (see "Verified").
3. The owners' runbook.

## Waiting on the owners

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
