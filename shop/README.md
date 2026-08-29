# Shop workspace

This directory is the only place for Shop Agent business extensions:

- `agents.ts` registers orchestrator and subagent profiles plus explicit tool allowlists.
- `prompts/` contains the role instructions referenced by those profiles.
- `tools/` contains manifest-based Python tools.
- `data/` contains the canonical product taxonomy used by the route agent.
- `requirements.txt` pins the Python packages required by the business tools.

The orchestrator maintains one minimal category-analysis task per taxonomy node. The route agent progressively resolves product names through the taxonomy, and the product analyst turns the resolved category plus flat preferences into evaluation criteria and a comparison checklist.

Framework runtime code belongs in `src/framework/`; TUI presentation belongs in `src/tui/`.
