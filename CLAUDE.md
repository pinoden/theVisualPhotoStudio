@AGENTS.md

## Claude Code

- The shared rules are in `AGENTS.md`, imported above. Change them there, not here, so that Codex gets them too.
- The tester is a subagent: `.claude/agents/tester.md`. Ask for it by name, or run `claude --agent tester`. It works on port 3213 with its own database and build folder.
- Memory notes are private to Claude Code. Anything in them that Codex also needs belongs in `AGENTS.md` or `ProjectLibrary.md`.
- Do not `@`-import `ProjectLibrary.md`: it would load about 75,000 tokens into every session.
