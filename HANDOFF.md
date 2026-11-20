# Project handoff

- **Project:** The Visuals Photo Studio
- **Updated:** 2026-11-20
- **Branch:** `rebuild`

## Current state

- **Hosted preview:** https://the-visual-photo-studio.vercel.app, on Vercel (Hobby plan, team "The Visuals Photo Studio"). It deploys every change to `master` by itself. Its database is the Neon staging project below, with Square's sandbox keys. Owners sign in with emailed codes, through Resend.
- **`master`** is at PR #20 (`ed70625`, 2026-11-19): the home page's slideshow (below). Before it came PR #19 (the old website's look and the editors' `Group` fix) and PR #18 (the security review's fixes). `rebuild` is ahead by the Acuity import (below) and these notes, which go to `master` with the next pull request, on the owner's word.
- **Scheduled tasks on the preview** run once a day (`web/vercel.json`, at 12:00 UTC), the most the Hobby plan allows. Between runs `/api/health` answers 503 and the admin overview says the tasks are late: expected until Vercel Pro, where they run every five minutes (step 10). Emails go out right after whatever queued them; reminders, free hours, review requests, refund retries and membership months wait for the daily run.
- **Email:** Resend's domain `thevisualsphotostudio.com` is not verified yet. Until it is, `EMAIL_FROM` is Resend's test sender (`onboarding@resend.dev`), which delivers only to the Resend account's own address. Once Resend shows the domain verified, set `EMAIL_FROM` to `The Visuals Photo Studio <bookings@thevisualsphotostudio.com>` and redeploy.
- **The owners' answers are all built:** questions 40, 41 and 48 (2026-11-18), and question 49 (2026-11-20), which confirmed the Acuity import as built (see "Owner decisions"). Migrations run from `0000` to `0049`; staging has all of them.
- **Importing Acuity's appointments still to come (step 5, 2026-11-19, in `rebuild`, not on `master` yet):**
  - **What it is:** `scripts/import-acuity.ts` turns each upcoming appointment of an Acuity export into a booking that holds its studios and the photographer. A booking keeps Acuity's price and what was paid there. Nothing is charged and no email is sent.
  - **Rehearsal first:** without `--write`, the script writes nothing and prints what it would do. A second run adds only what is new.
  - **The readings it is built on** (question 49 in `ProjectLibrary.md`) were confirmed by the owner as built on 2026-11-20.
  - **Waiting on the owners:** a real export, or just its first line (the column names), to confirm the column names and time formats the reader expects. It stops and names the columns it found if one it needs is missing.
  - **Tried** on a Neon branch of staging, with a made-up export (see "Verification").
  - **Migration `0049_acuity_import`:** it adds `bookings.imported_from` and was applied to staging (2026-11-19). The column is invisible to `master`'s code, and the merge needs it.
- **Security review of 2026-11-19:** its high and medium findings and the missing headers are fixed and live (see the decision log in `ProjectLibrary.md`). Checked on the hosted preview after the deploy: the new headers are sent and `X-Powered-By` is not, the open-redirect probe stays on the site, and the database rate limit counted an empty booking request, which was refused with no booking made. The limit on asking for sign-in codes has counted a request there; the limit on tries waits for a code to be entered (step 3). Still open: shorter sessions for owners and staff, Square's buyer verification and risk rules before the live keys, Vercel deployment protection for previews, and two-factor sign-in on GitHub, Resend, Square and the inboxes in `OWNER_EMAILS` (Vercel's is on).
- **Photos:** the 102 photos of the old website are in the staging database's media library, on the studios, in collections and on the photography page (`scripts/import-old-site-photos.ts`; see `ProjectLibrary.md`). The photo files are kept nowhere else but the old website. The manifest of what goes where is in `/old-site-photos/` (ignored by Git: its file names hold clients' names).
- **The old website's look (2026-11-19, `bea27c1`, merged in PR #19):** asked by the owner, since the pictures looked too different. The blocks can now put a picture behind a title, lay a gallery out in one row that scrolls sideways, show the studios as arches, and show each studio's photos large in such a row. `scripts/match-old-site-look.ts` placed the photos that way on staging's home, photography and price pages. It ran on a Neon branch first, then on staging, and the pages were published through the page editor's phone check. The versions replaced, which each page's history brings back, are home 1 (then 2, and 3 since the slideshow), photography 2 (now 4) and rates 1 (now 2). Photography's version 3 gave its gallery one photo a line on phones, which the code then on `master` drew as 25 photos one under another. Version 4 leaves that number to the row (`old-site-look.ts` no longer sets it). Since PR #19 deployed, the hosted preview shows it all: the photo behind the home page's title and the price page's band, the studios as arches, each studio's photos in a row, and the photography row (checked after the deploy: see "Verification"). The home page's Christmas section keeps the old site's words and must be taken off by hand after January 2, 2027: no condition goes by date. The Neon branch `look-trial` was deleted afterwards.
- **The home page's slideshow (2026-11-19, merged in PR #20, live on the hosted preview):** the owner asked for the old home page's three studios turning with arrows. The `Slideshow` block shows them one at a time, edge to edge, with the old site's words and a pale veil, arrows that go round, and swiping on a phone.
  - It was tried first on a Neon branch of staging (`slideshow-trial`, deleted afterwards).
  - After the merge deployed, `scripts/match-old-site-look.ts` put it at the top of staging's home page. It also turned the title band under it into words only.
  - The page was published through the page editor's phone check, from a local server on staging's database with email off.
  - Home is version 3, and its history brings back version 2.
  - The hosted preview showed it a minute later, with no redeploy (see "Verification").
- **GitHub:** the repository is private on the Free plan, so `master`'s branch protection no longer applies (the owner chose this for now). Changes still reach `master` only through a pull request after CI passes. Four Dependabot pull requests into `rebuild` are open: #10 (GitHub Actions) and #14 (`@types/node` 26) pass CI; #11 (minor and patch updates) needs its cancelled browser job run again; #13 (TypeScript 7) fails the type check. GitHub's two moderate security alerts are in development tools only, never in the deployed site: esbuild 0.18 under `drizzle-kit` (its dev server, which nothing here runs) and minimatch 10 under `typescript-eslint`. They clear when those packages update.
- **Tools signed in on the builder's Mac:** GitHub (`gh`), Vercel CLI (account `pinoden`) and the Neon CLI. Nothing of them is in the repository.
- Follow-up 14 (Instagram feed) is connected once the site is on its host. Follow-up 16 was declined. The other follow-ups are built. See the [Project Library](ProjectLibrary.md).

## Neon staging

- **Target.** `thevisualsphotostudio-staging` (`orange-mode-34735663`), AWS US East 1 (N. Virginia), PostgreSQL 18. The branch named `production` is the default branch inside this staging project. Postgres was the only service configured.
- **CLI setup.** Installed Neon CLI 9.7.2 with `npm i -g neon@latest`. From an isolated copy of `web/`, ran `neon init -y --org-id org-sparkling-feather-88850154 --project-id orange-mode-34735663 --branch production --services postgres`. The CLI generated the project link and `neon.ts`, installed `@neon/config` and `@neon/env`, and installed its agent tooling.
- **Sign-in and provisioning.** The first `neon deploy` could not start browser sign-in from a noninteractive shell. Retrying in a terminal completed browser authorization. The deployment confirmed the branch already matched the Postgres policy and pulled its environment variables into `web/.env.local`.
- **App connection.** Kept the existing Drizzle and node-postgres driver. The app uses pooled `DATABASE_URL`. For `npm run db:migrate` and `npm run db:seed`, the verification run supplied `DATABASE_URL_UNPOOLED` as the scripts' `DATABASE_URL`; the scripts read the process environment. The initially empty staging database was migrated and seeded, including eight built-in pages and the three studios. The generated config, package dependencies, and ignore rule were then installed in the studio checkout. The private `web/.env.local` and the CLI link `web/.neon` are Git-ignored.
- **Verification.** Used committed revision `5580cde` with the generated Neon configuration in an isolated checkout. `npm run build` compiled successfully and generated 61 of 61 pages. The local production server returned the results below. The PostgreSQL driver emitted a future SSL-mode compatibility warning during build; the runtime smoke test used `sslmode=verify-full`.

| Check | Observed result |
| --- | --- |
| `GET /book` | HTTP 200 |
| `GET /api/availability` | HTTP 200, three studios read from Neon |
| `GET /api/cron/tick` | HTTP 200, scheduler heartbeat written |
| `GET /api/health` | HTTP 200, database OK and scheduler heartbeat fresh |
| Direct Neon query | Stored heartbeat matched the timestamp returned by the app |

The localhost check used mock payments and sent no email. The hosted Vercel preview, Square sandbox configuration on that preview, and production cutover remain pending.

## Verification

| Check | Status |
| --- | --- |
| Type check and lint | Clean on the commit that recorded question 49 (2026-11-20), which changed only notes and one comment, and before it on the commit that added the Acuity import (2026-11-19) |
| Unit and integration tests | 1,106 passed across 83 files on both commits |
| Browser tests (local) | 63 passed on the Acuity import's commit (10.7 min), none retried |
| GitHub CI | Both jobs (`checks`, `browser`) passed on `322c745` (2026-11-19), the Acuity import's last commit, and on PR #20 (`11250a6`), which merged the slideshow. They passed before on `bba0800`, PR #19 and `49a14b0`. |
| The slideshow on staging's content | First on a Neon branch of staging, then on staging after the merge. Each time, the script changed only the home page and the page editor published it after its phone check. Staging's outbox was the same before and after. |
| Hosted preview | Checked in Chromium at 1280px and 390px after PR #20 deployed (`ed70625`) and the home page was published:<br>• the slideshow's three slides and photos loaded<br>• the arrows went 1, 2, 3, back to 1, and from 1 back to 3, at the sides on a desktop and under the words on a phone<br>• no page was wider than the screen, and the console showed no error<br>• the home, studios, photography and rates pages answer 200, with no broken picture<br>• the studios page draws three rows and the photography page one, and each row's next arrow moves it<br>After PR #19 (`4a96095`), every picture in those rows (33 and 25) loaded once scrolled into view, with no image request refused. |
| Acuity import | Tried on a Neon branch of staging (`acuity-trial`, deleted afterwards), with a made-up export of seven rows:<br>• migration `0049` applied<br>• the rehearsal wrote nothing; it reported three to import, one over, two refused with their reasons (one taken by the site's clean-up gap after another appointment of the export) and one row it could not read<br>• the real run made the three bookings (four studio holds, three payments through Acuity, no email), and a second run added nothing<br>• on a local server on the branch, the appointment's page, the calendar, the client's account and receipts showed them |
| Square sandbox | Payment receipts verified. Earlier membership purchase, use and cancellation checks used the sandbox card form. |
| Database migrations | `0047` was tried on a copy of the browser suite's database, and `0048` and `0049` on Neon branches of staging. All three were then applied to staging; after `0049`, the hosted preview still answered on `master`'s code. No production migration has run. |

The browser suite uses `next dev`. Page-editor cases have been flaky around discarding edits, deleting blocks, dragging into columns and now taking a page off the website. Each failure has passed on a rerun, and CI passed them all. If `website.spec.ts:743` fails again on a quiet machine, look at it. A click made before a page has loaded can also fail a test, through React's hydration warning, as the Logo group's did: see "Conventions and gotchas" in `ProjectLibrary.md`.

Not yet covered by an independent tester pass: the fourth pass's fixes, questions 40 and 41, the photo import, the security fixes, the old website's look and the home page's slideshow, the Acuity import, monthly Square billing, clearing test-mode data on PostgreSQL, daylight-saving transitions, Safari and real phones. The browser suite runs on the real clock and has no case for the move screen of an appointment that has already started.

## Next steps

### Now

1. **Verify the Resend domain** (owner: DNS records where the domain is managed), then switch `EMAIL_FROM` back as above.
2. **A tester pass** over the fourth pass's fixes, questions 40 and 41, the photo import, the security fixes, the old website's look and the home page's slideshow (both on the hosted preview), and the hosted preview on a real phone.
3. **Sign in once on the hosted preview with a new code** (sign out first), to see the limit on tries counted there. Until the Resend domain is verified, only the Resend account's own address receives a code. Resend refuses every other address, the other owners' included, with a 403 that the site records in `email_outbox.error`, while the page still shows the code screen.
4. **Vercel Preview environment:** its `OWNER_EMAILS` still holds the first list; set it as Production's if branch previews are used.

### Before cutover (tools not built yet)

5. **Import upcoming appointments from Acuity.** Built (2026-11-19), with its readings confirmed by the owner (2026-11-20): `scripts/import-acuity.ts`. Read an Acuity export into bookings that hold their rooms and photographer like any other booking, with nothing charged and no email sent. Refuse and list any that clash. Each row is matched by Acuity's ID, so a second run of the same export adds nothing. Still to do:
   - **The owners:** export the appointments and save the file outside the project folder, never in it: it holds clients' details. In Acuity: Reports → Import/Export, dates from today on, cancelled appointments not included, then Export appointments, which gives a CSV file. A file that listed cancelled ones without saying so would import them as booked.
   - **Then:** run a rehearsal against staging, adjust the reader if the columns differ, and rehearse the real import (item 9). Run it with `--money live` on the production database at cutover.
6. **Carry over active members.** The site's memberships are billed by Square subscriptions that the site creates. A member billed today by Acuity or Squarespace cannot be moved onto one. Two ways, for the owners to choose: the member joins again on the site with their card, and the old subscription is cancelled; or the site imports the member's balance as a membership without billing, which the old provider keeps billing until it is cancelled.
7. **Import past records, read-only.** Past Acuity appointments and Square payments, for the client pages and loyalty stamps, matched by provider and ID.

### Rehearsal and cutover

8. **Production database:** its own Neon project (never the staging one, which holds test-mode bookings), migrated with `npm run db:migrate`, and the photos imported again or copied from staging.
9. **Rehearse the imports** (items 5 to 7), and reconcile counts, credits and member balances with the owners.
10. **Cut over** with the owner's word: Vercel Pro with the scheduled tasks every five minutes (`web/vercel.json`), the domain pointed at Vercel, live Square keys last.

## Launch plan

### What Katya needs from scheduling

- **Find and book a slot.** Clients start from a studio or from a date and time, on a phone too. Paris + Dayglow, Paris + Blanche and all three are each a single reservation. Blanche + Dayglow requires Paris. Rooms not booked stay available, the same photographer is never booked in two rooms at once, and the site respects 15-minute starts and cleanup gaps.
- **Run the calendar and handle changes.** Staff need day, week and month views with studio filters, status and history. Staff bookings follow the same availability rules as online bookings. A pending move keeps the original slot. After a confirmed move, staff can see what was paid in Square, what is still due and what credit remains. A booking keeps its original terms. A customer gets one free reschedule at least 24 hours ahead, and $20 for each later one.
- **Apply prices and member balances.** Weekday and weekend rates, and $5 per extra guest within capacity. A member's minutes cover the time they pay for, on weekends in full (question 41). A member with 60 minutes left uses them toward a two-hour booking and pays for the other hour. Unused minutes carry over and stay available after the membership is cancelled. A cancellation 48 hours ahead gives the minutes back, and a bundle member can book any single room the plan covers.

The early site audit also found membership prices that differed between the website and checkout, and refund copy that promised 100% while the terms kept 5%. Check that what customers see and pay matches the approved rules. See the [original requirements and Katya's follow-ups](ProjectLibrary.md#requirements-from-the-owner-received-2026-11-14).

### Booking and payments

**Launch direction: the site's own scheduler, with Square for payments.** Acuity stays live until the hosted preview and the import rehearsal pass. Only one scheduler takes bookings at any time, so that a room or the photographer is never booked in both.

- **What Acuity can cover.** The live menu already lists the three approved bundles. Acuity's resources can make one appointment hold several rooms and a shared photographer, padding included. The live resource assignments have not been checked. [Acuity resource rules](https://help.acuityscheduling.com/hc/en-us/articles/16676949567757-Use-resources-to-limit-bookings).
- **Why Acuity cannot do what Katya asked.** These were checked against Acuity's help center on 2026-11-18:
  - A minutes-based package or subscription code can't be used at all when its balance doesn't cover the whole appointment. Katya wants a member with 60 minutes left to use them on a two-hour booking and pay the rest.
  - A dollar-based code can pay part of an appointment, but the member's minutes then become a cash balance.
  - A subscription can roll unused value over. Once cancelled, it can be redeemed only until its next renewal date would have been. Katya wants unused minutes to stay available after a cancellation.
  - Acuity gives a code's value back on any cancellation, unless the appointment is marked as a no-show. Katya's rule is 48 hours ahead.

  [Code redemption](https://help.acuityscheduling.com/hc/en-us/articles/29268134579085-Redeeming-package-gift-certificate-or-subscription-codes) · [Subscription cancellation](https://help.acuityscheduling.com/hc/en-us/articles/28615961734797-Managing-client-subscriptions) · [Creating subscriptions](https://help.acuityscheduling.com/hc/en-us/articles/28615820183309-Creating-subscriptions).

  The remaining claims could not be checked because Acuity's help pages refuse automated readers: the no-show exception, and that Acuity sends staff to Square for refunds and leaves those refunds out of its reports. Open those [refund pages](https://help.acuityscheduling.com/hc/en-us/articles/28052155599885-Handling-refunds-and-price-adjustments) in a browser before quoting them to the owners.
- **The site's scheduler** already has the studio bundles, database-enforced room and photographer holds, partial minutes, weekend pricing and membership billing. Demonstrate these to Katya in the hosted preview with the Square sandbox, and check that staff can book, move and cancel from their normal workflow.
- **Cutover decision.** Switch only if the preview passes and future reservations and active memberships reconcile. For each member, confirm their unused minutes, their next billing date and who bills them from now on (item 6 of "Next steps"). No member is billed by two providers. If the transition cannot be reconciled, keep Acuity live and defer the rules it cannot follow.

### Preview, cutover and rollback

1. **Inventory.** With the owners, list current bills, future appointments, active subscriptions, outstanding credits, unredeemed codes and which provider bills each membership. Track Squarespace Commerce subscriptions separately from Acuity memberships. Keep the current site and booking link available during the rehearsal.
2. **Preview.** Set up Vercel and a separate Neon database with sample clients and Square sandbox keys. Confirm the deployment can read the repository, which is private now. Katya tests the studio admin role. Configure the transactional email sender without touching the Gmail DNS records. Check the scheduled tasks and `/api/health`. Set up monitoring and backups, and fill in the contacts and rollback steps in the [runbook](RUNBOOK.md). Done by 2026-11-19: Vercel, the Neon staging database, Square's sandbox keys, deploying from the private repository, the daily scheduled tasks and `/api/health`. Still to do: the sender's domain in Resend, Katya's test, monitoring, backups and the runbook.
3. **Rehearse the import.** Export Acuity appointments and Square payment history to a restricted location, and import them into a restricted database separate from the shared preview, with outgoing email and payments switched off. Past records stay read-only. Rehearse carrying upcoming appointments into the calendar with the right room and photographer holds. Reconcile counts, open credits and member balances with the owners. Measure database size, indexes included, with about 10,000 bookings, and compute over a representative week. Photos stay in object storage. Card details and credentials stay out of exports and Git.
4. **Pass the booking checks.** Book on a real phone. Send Paris + Dayglow and Paris-only requests for the same time in both orders: the shared room is never double-booked and Blanche stays available. The photographer cannot be booked in two rooms at once. Book two weekend hours with only 60 membership minutes left: the minutes cover one hour, with no weekend difference, and the member pays for the other. Check that cancellations and refunds reconcile, and that the confirmation with the door code and the 24-hour reminder each arrive once. Record which flows passed and any staff workaround accepted.
5. **Cut over.** Close online booking in Acuity, take a final export and import what changed since the rehearsal. Save the current DNS values. From `web/`, run `npm run db:migrate` against the production database: a fresh database gets the whole sequence, an existing one its pending migrations. If the weekend-price migration applies, keep the owners' customized prices. Run the browser suite. Point the domain and `www` to Vercel, keep the mail records, and check both addresses on a phone. Switch to live Square keys last. With Katya, make one small real booking and refund it, then check the calendar entry, the email, the Square payment and its receipt link.
6. **Keep a fallback.** Record who can restore DNS and reopen Acuity's online booking. Before reopening Acuity, carry the bookings, holds and payments made on the site since the switch back into it. Once booking and email work on the live domain, cancel only the Squarespace website plan, after checking what that does to Commerce subscriptions. Keep the domain registration and the studio mailbox. Keep Acuity through the agreed rollback period, then cancel it. Cancelling the Acuity plan cancels the subscriptions sold to clients through it, so every member must have moved first.

### Budget and recovery

- The November 2026 estimate is **$47–$54/month** for one Vercel Pro seat and Acuity Standard at about 208 bookings a month, with Neon on its free tier. Under this plan, Acuity is paid only until the rollback period ends. The Neon Launch example (**about $15/month**) is needed, not optional, because the site holds live reservations, credits and membership balances. After the rollback period the core cost is Vercel Pro plus Neon Launch. Confirm the studio's actual Acuity tier, provider prices and processing fees before buying. Domain renewal, the mailbox, taxes, processing fees and usage overages are outside this estimate. Compare it with today's bill after subtracting only the Squarespace website plan.
- Use the free database tier for the rehearsal, and measure storage and compute before choosing a paid plan. Before the site holds live balances or reservations, require point-in-time recovery, a separate encrypted export and a successful restore rehearsal.
- Set a Vercel spend alert, and review Neon usage weekly in the first month. Check the first bill against the budget, peak daily email volume and photo delivery included. Upgrade based on measured limits and recovery needs.

## Owner decisions

### Confirmed (2026-11-20 and before)

- Question 49 (the Acuity import, 2026-11-20): as built. Acuity's price stands, weekends included. What was paid in Acuity counts as paid; a refund of it is made in Square or Acuity and recorded by hand. The site's terms of the day apply. The site sends no reminder while Acuity sends its own, and the review request and the loyalty stamp follow the site's rules. The site's 15-minute clean-up gap stands, so an appointment Acuity put closer after another is listed for the owners. Add-ons stay inside Acuity's price, and what is left on a code stays in Acuity until step 6.
- Vercel and Neon are acceptable. Keep the existing domain. Sign-in starts with emailed codes; Google sign-in may come later.
- Question 48 (extra charges): the price is paid first, then the charges; a paid charge is given back as a refund; a booking with charges is not moved. As built.
- Questions 42, 43, 45 and 46 (memberships): as built. Question 44: Blanche's plans are $380 and $700, as built.
- Question 41: a membership looks only at the time balance, not the price. The minutes cover weekend time in full. Built.
- Question 40: the site's wording stays the default, and the owners can customize every email, the notices to the studio included. Built.
- Follow-up 14: the owners connect the Instagram account once the site is on its host.
- Customers can update their email address. Access to customer pages is logged. Duplicate accounts can be merged if the effort is small.
- Test extensively with the Square sandbox and run several independent passes before launch. Import as much historical Acuity and Square data as practical.
- Design, navigation and page edits need Publish. Prices, opening hours and booking rules take effect immediately. Deleted pages stay in the trash for 30 days.
- YouTube, Vimeo and Instagram are the video sources. Owners rename, add and remove studios without a deployment, and edit the email wording in the admin.

### Open decisions

| Area | Decision needed |
| --- | --- |
| The old website's look | Whether to add more of the old site: a page for each studio with its Christmas photos, its Styled Setups page, the reviews on its home page ("What Our Customers Say"), and its colours, fonts and spacing (left as they are). The Christmas section comes off the home page after January 2, 2027. |
| Members at cutover | Each current member joins again on the site, or is carried over as a balance while the old provider keeps billing until it is cancelled (next step 6) |
| Launch | Approve the cutover after the hosted preview and the import rehearsal. DNS ownership, the transactional email provider and sender address, the privacy policy and sales tax |
| Price summary after a goodwill refund | Its line still reads "Paid by card and at the studio" with the original amount. Keep it, or say what was refunded |
| Policies | How the free reschedule and the fee for later reschedules are described together |
| Integrations and content | Apple Wallet loyalty scope, the newsletter provider and signup, and what a seasonal collection should include |
