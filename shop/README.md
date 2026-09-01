# Shop workspace

This directory is the only place for Shop Agent business extensions:

- `agents.ts` registers orchestrator and subagent profiles plus explicit tool allowlists.
- `prompts/` contains the role instructions referenced by those profiles.
- `criteria_contract.py` contains the authoritative Pydantic contract for transient criteria results.
- `tools/` contains manifest-based Python tools.
- `data/` contains the canonical product taxonomy used by the route agent.
- `requirements.txt` pins the Python packages required by the business tools.

The orchestrator maintains one minimal category-analysis task per taxonomy node. The route agent progressively resolves product names through the taxonomy, and `criteria_agent` researches the resolved route to produce transient evaluation criteria and distinguishing attributes; task preferences are not passed to that agent.

Framework runtime code belongs in `src/framework/`; TUI presentation belongs in `src/tui/`.
