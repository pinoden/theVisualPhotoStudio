# CLAUDE.md

The project guide and the record of decisions are in [`ProjectLibrary.md`](ProjectLibrary.md). It is about 290,000 characters, so it is not loaded automatically. Read the parts a task needs, not the whole file. `grep -n '^##' ProjectLibrary.md` lists its sections.

- **At the start of a session:** read "Handoff for the next coding session" and the last entries of "Decision log", then run `git log -5` and `git status`. More than one coding tool works in this checkout, so the last commit may not be yours.
- **Before changing code:** read "Commands" and "Conventions and gotchas" under "The site (`web/`)", and the part of "Architecture" for the area you touch.
- **Before building a feature:** read its subject under "Rebuild decisions", "Katya's answers to the 16 follow-up questions" and "Known gaps in what is built".
- **After a decision or a build:** record it in `ProjectLibrary.md` (under its subject, in the decision log and in the handoff), not only in chat.

The site is in `web/` (Next.js 16, TypeScript, PostgreSQL). Work happens on the `rebuild` branch and reaches `master` through pull requests.
