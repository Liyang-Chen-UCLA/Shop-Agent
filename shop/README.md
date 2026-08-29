# Shop workspace

This directory is the only place for Shop Agent business extensions:

- `agents.ts` registers orchestrator and subagent profiles plus explicit tool allowlists.
- `prompts/` contains the role instructions referenced by those profiles.
- `tools/` contains manifest-based Python tools.

Framework runtime code belongs in `src/framework/`; TUI presentation belongs in `src/tui/`.
