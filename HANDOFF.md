# Project handoff

- **Project:** The Visuals Photo Studio
- **Updated:** 2026-11-18
- **Branch:** `rebuild`

## Current state

- The local checkout and cached `origin/rebuild` and `origin/master` refs are at `e90d224` (PR #9). The fourth tester pass fixes are in the working tree. Their commit, push and PR are pending verification.
- The fourth pass addressed charge allocation, charge refunds and reversals, payment links, booking moves with charges, and lapsed-card messaging. The latest rules allocate payments to the booking price first, then to charges in the order they were added. Bookings with charges cannot be moved. Owner acceptance is pending under question 48.
- The project has never been deployed. Migrations run from `0000` through `0046`. The fourth pass adds no migration.
- Follow-up 14 (Instagram feed) awaits account connection. Follow-up 16 (discount by yearly spend) was declined. The other follow-ups are built or previously verified, with the open decisions below. See [Project Library](ProjectLibrary.md) for the full follow-up list and decision history.

## Verification

| Check | Reported status |
| --- | --- |
| Type check and lint | Clean on the fourth-pass working tree |
| Unit and integration tests | 1,056 passed across 77 files on the fourth-pass working tree |
| Browser tests | Latest result unrecorded. The prior recorded run passed 63 cases. |
| GitHub CI | Both jobs passed on `47e6402` according to the previous handoff. CI for the fourth-pass changes is unverified. |
| Square sandbox | Payment receipt behavior verified. Earlier membership purchase, use and cancellation checks used the sandbox card form. |
| Database migrations | `0046` verified on copies of browser-test databases. Production migrations are pending. |

The browser suite uses `next dev`. A development worker repeatedly reached its JS heap limit late in earlier runs that passed. Page-editor tests have also been flaky around discarding edits, deleting blocks and dragging into columns.

Independent coverage still due includes the fourth-pass fixes, monthly Square billing, clearing test-mode data on PostgreSQL, daylight-saving transitions, Safari and real phones. The browser suite runs on the real clock and currently has no case for the move screen of an appointment that has already started.

## Next steps

1. Record the fourth-pass browser result against the exact revision. Run an independent pass on charge reversals, payment-link charges, the move screen for a booking with charges, and lapsed-card wording.
2. Verify the commit and PR status. Obtain the owner's approval and passing CI before merging the fourth-pass fixes.
3. Confirm the client-facing price summary after a goodwill refund. The current wording can show the original booking cost under “Paid by card and at the studio.”
4. Set up staging on Vercel and Neon with a separate database and Square sandbox keys. Configure the scheduler, transactional email, monitoring and backups, and fill in the launch details in the [runbook](RUNBOOK.md).
5. Use `npm run db:migrate` against the intended database. A fresh database needs the full migration sequence. An existing database gets its pending migrations. Preserve customized prices if the weekend-price migration runs on a database that already contains them. Run the browser suite again before launch.
6. Switch to live Square keys as the final launch step. Coordinate the live booking, receipt-link check and refund with Katya. Confirm whether Acuity will stay available during the transition.

## Owner decisions

### Confirmed direction

- Vercel and Neon are acceptable. Keep the existing domain. Start sign-in with emailed codes and consider Google sign-in later.
- Customers should be able to update their email address. Log access to customer pages. Support merging duplicate accounts if the effort is small.
- Test extensively with Square sandbox and run multiple independent passes before launch. Import as much historical Acuity and Square data as practical.
- Design, navigation and page edits require Publish. Pricing, opening hours and booking rules take effect immediately. Keep deleted pages in trash for 30 days.
- Support YouTube, Vimeo and Instagram as video sources. Owners should be able to rename, add and remove studios without a deployment and edit email wording in admin.

### Open decisions

| Area | Decision needed |
| --- | --- |
| Launch | Acuity's role during and after migration, Squarespace DNS options and ownership, transactional email provider and sender address, privacy policy and sales tax |
| Memberships, questions 41–46 | Weekend eligibility, pricing the extra portion of longer bookings, rescheduling, Blanche tier prices, checkout rules and monthly billing behavior |
| Extra charges, question 48 | Approve payment allocation, charge refund handling and the restriction on moving bookings with charges |
| Email templates, question 40 | Approve owner-only editing of client emails and system-managed language for money, codes and refunds |
| Policies | Clarify how the free reschedule and the fee for later reschedules are described together |
| Integrations and content | Instagram account connection, Apple Wallet loyalty scope, newsletter provider and signup, and what a seasonal collection should include |
