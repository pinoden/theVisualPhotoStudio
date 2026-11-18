# Handoff

Where the work stands. A snapshot, rewritten at each checkpoint by whichever tool worked last (see `AGENTS.md`). The history is in `git log` and in the decision log of `ProjectLibrary.md`.

**Last updated:** 2026-11-17, evening, by Claude Code.

## State of the tree

- Branch `rebuild`, pushed. The commit that holds this file is the state described here. Nothing is uncommitted.
- `master` is at pull request #7 (2026-11-17). Everything after it is on `rebuild` only and waits for the owner's word to merge.
- Migrations run from `0000` to `0036`. No deployment and no production migration has ever been run.

## In progress

Nothing. No tool has unfinished changes in the tree.

## Verified

On the tree of this commit, 2026-11-17:

- `npm run typecheck` and `npm run lint`: clean.
- `npm test`: 896 tests pass.
- `npm run test:e2e`: the whole browser suite, 59 cases, passes.
- Migrations `0035` and `0036` were each tried on copies of two browser-test databases. `0030` to `0033` were checked against older data by Codex.

Not yet through an independent tester pass: the follow-ups built on 2026-11-17 (1, 4, 6, 7, 8, 9, 12, 15), the 7-day refund window and the food rule.

## Done from the owner's 16 follow-up answers

Details and status of each are under "Katya's answers to the 16 follow-up questions" in `ProjectLibrary.md`.

| # | Subject | Status |
| --- | --- | --- |
| 1 | Weekend prices for longer bookings | Built |
| 2 | Extra people, $5 each with a quantity | **To build.** Bundle limits wait on the owner |
| 3 | Memberships (5 and 10 hours a month, Square subscriptions) | **To build.** The largest item |
| 4 | Unused pet fee as credit, issued by hand | Built |
| 5 | Changes made by the studio: repricing, payment section | **Waits on the owner** (which changes reprice) |
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

## Next, in this order

1. **Follow-up 13: overtime, cleaning and damage charges.** Overtime at the studio's hourly rate in 15-minute blocks, each started block a quarter of the rate. Cleaning and damage as an amount an administrator types. Paid at the studio or by payment link.
2. **Follow-up 2: extra people.** One $5 add-on taken in a quantity, in place of the two add-ons of today. Blanche and Dayglow include 6 guests and allow 6 more, Paris includes 4 and allows 4 more. Build the single-studio part; the bundle limits wait on the owner.
3. **Reminder email 24 hours before an appointment** (question 29 of the answers of 2026-11-17). The review request after a visit is its model: `queueReviewRequests` in `web/src/server/tasks.ts`.
4. **Each booking keeps the terms in effect when it was made** (question 10).
5. **A client asks the studio to move a booking** (question 20).
6. **Follow-up 3: memberships.** Plan it before building: it needs Square's subscriptions.
7. **The admin's email templates** (question 33).

## Waiting on the owners

- **Follow-up 2:** do the limits of 10 people for a two-studio bundle and 20 for all three count every guest, or only the additional ones?
- **Follow-up 5:** which changes by the studio reprice a booking: only a new time, or also the length, the studios and the add-ons?
- **Follow-up 6, question 35:** the $20 for a further reschedule is taken off the reschedule code. Should the card be charged at the moment of the move instead?
- **Follow-up 14:** the Instagram account has to be connected by an owner.
- **To go live:** hosting, the web address, the email service, live Square keys, a privacy policy and the sales-tax answer. Questions 1 to 6 of "Questions for the owners" in `ProjectLibrary.md`.

## Before deploying

- Apply migrations `0030` through `0036`. Keep the owners' customised prices when the weekend-price migration runs.
- Set up the scheduled task and the email service: review requests, free hours and refund retries depend on them.
- Run the whole browser suite once more.
