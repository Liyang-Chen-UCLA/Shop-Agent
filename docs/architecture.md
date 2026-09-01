# Architecture

Shop Agent keeps the product-facing business workspace separate from the reusable runtime without introducing packages, compilation, or a monorepo.

## Repository boundaries

```text
root
├─ start.ps1                 user launch entry
├─ shop-agent.config.ts      thin configuration entry
├─ shop/                     business extension workspace
│  ├─ agents.ts              profiles and tool allowlists
│  ├─ criteria_contract.py   authoritative criteria Pydantic contract
│  ├─ data/                  canonical business datasets
│  ├─ prompts/               role instructions
│  └─ tools/                 Python tool manifests and implementations
├─ src/
│  ├─ cli.ts                 process entry
│  ├─ framework/             Agent runtime and public API
│  │  └─ subagents/          isolated child-runner protocol
│  └─ tui/                   terminal interaction
├─ tests/                    framework tests and fixtures
└─ docs/                     usage, architecture, and backlog
```

The root stays focused on launching and navigating the product. New shopping behavior belongs under `shop/`; framework mechanics belong under `src/framework/`; terminal presentation belongs under `src/tui/`.

## Main conversation flow

```text
PowerShell start.ps1
  → src/cli.ts
  → load shop-agent.config.ts
  → create OpenCode Go model runtime
  → create orchestrator Agent
  → render and stream through the TUI
  → append session messages under .shop-agent/sessions/
```

`src/framework/index.ts` is the framework's public source entry. Business configuration should import public helpers and types from this file rather than reaching into runtime internals.

## Delegation flow

The orchestrator sees only the `delegate_agent` framework tool by default. It can list profiles, inspect one profile, or run one foreground subagent.

Each run starts `src/framework/subagents/child-runner.ts` in an independent Node process. The child receives a fresh task rather than the parent transcript, loads only its profile allowlist, streams JSON Lines events to the parent, and stores its full transcript under `.shop-agent/runs/`. Subagents cannot delegate again in the current design.

Native tools are resolved through the same explicit profile allowlists as Python
tools. `web_search` is available only to `criteria_agent`; it runs one isolated
OpenCode/pi model request per query with the fixed `muse-spark-1.2-contributor`
model at low thinking and returns research text only. `report_developer_issue`
is explicitly allowlisted for the orchestrator, route agent, and criteria agent;
it appends bounded records with framework-injected session/agent metadata to
`.shop-agent/developer-feedback/issues.jsonl`.

## Python tool boundary

Python tools are discovered from `shop/tools/**/tool.json`, but discovery does not expose them automatically. A profile in `shop/agents.ts` must explicitly include the tool name.

Every call starts the configured Python executable in UTF-8 mode, sends one JSON request over stdin, and validates the JSON response against the manifest output schema. Set `SHOP_AGENT_PYTHON` to select the executable; the default is `python` from `PATH`. Python receives only the Windows runtime variables and explicitly allowlisted business variables; it does not inherit `OPENCODE_API_KEY` by default.

For tools used by the main orchestrator, the framework injects a trusted runtime context containing the current session ID and data-directory path. These values are outside the model-authored arguments. LangGraph state tools use that session ID as the SQLite checkpoint thread key, preventing a model from choosing another session's state.

## Product-analysis flow

```text
user request
  → orchestrator extracts product category names and flat preferences
  → route_agent queries a small taxonomy frontier through Python tools
  → user resolves cross-category, ambiguous, or direct-child choices
  → orchestrator upserts one canonical category task
  → criteria_agent researches the confirmed route and constructs transient criteria/attributes
```

Criteria output is first checked against the profile JSON Schema and then passed
to `shop/criteria_contract.py`, whose Pydantic v2 models enforce all direction,
reference, namespace-collision, and partial-order DAG invariants. The child
runner uses Pi's `shouldStopAfterTurn` hook: tool-call turns are ignored, one
invalid final JSON is repaired with `Agent.steer()` in the same context, and a
second failure becomes the normal child error. Preferences are not sent to this
agent and criteria results are not persisted.

The canonical taxonomy is `shop/data/google_product_taxonomy_zh-CN.jsonl`. Tools may index the full file internally, but disclose only search matches, requested nodes, or direct children to the route agent.

## Persistent data

`.shop-agent/` is runtime-only and ignored by Git:

- `sessions/` contains main transcripts as JSONL plus metadata.
- `runs/` contains subagent events, transcripts, outputs, and status.
- `logs/` contains redacted diagnostics.
- `developer-feedback/issues.jsonl` contains bounded developer-only diagnostics.
- `checkpoints/task-state.sqlite3` contains LangGraph checkpoints for minimal product-analysis task state.

Deferred concurrency, background runs, FleetView, and a persistent Python worker are documented in [`backlog/`](./backlog/).
