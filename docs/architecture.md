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
│  ├─ skills/                repo-local market alignment instructions
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
tools. `web_search` is available to `criteria_agent` and `market_agent`; it
runs one isolated OpenCode/pi model request per query with the fixed
`muse-spark-1.2-contributor` model at low thinking and returns research text
only. Criteria keeps its required four-query plus one-follow-up cap; market has
no numeric cap and is instructed to search only for conflicts or OCR-new
definitions. `report_developer_issue` is explicitly allowlisted for the
orchestrator, route agent, criteria agent, and market agent; it appends bounded
records with framework-injected session/agent metadata to
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
  → criteria_agent researches the confirmed route and constructs base criteria/attributes
  → market_agent loads base, samples the configured number of mapped-category products (default five), aligns and extracts
  → trusted Python validator publishes products then market.json
```

Criteria output is first checked against the profile JSON Schema and then passed
to `shop/criteria_contract.py`, whose Pydantic v2 models enforce all direction,
reference, namespace-collision, and partial-order DAG invariants. A trusted
post-stage persists `base.json`; then the manager automatically runs
`market_agent`. Its repo-local `market-alignment` skill is appended to the
child system prompt. The market child sees only `load_base`, `shopping_env`,
and native web search/diagnostics. `shopping_env` resolves the active task
route through a hard-coded mapping and stores a trusted per-run cursor; it
returns complete `context_text` as `ocr_text`, takes products in rank/item-id
order, and permits rereads only for already selected ids. The market output is
checked against the profile JSON Schema and `shop/market_contract.py`: every
final item covers every configured sample product, statuses/value invariants are enforced,
frequencies are recomputed per product, and product files are written before
`market.json` is atomically published. One invalid final JSON is repaired with
`Agent.steer()` in the same context. Preferences are not sent to either
specialist.

The canonical taxonomy is `shop/data/google_product_taxonomy_zh-CN.jsonl`. Tools may index the full file internally, but disclose only search matches, requested nodes, or direct children to the route agent.

## Persistent data

`.shop-agent/` is runtime-only and ignored by Git:

- `sessions/` contains main transcripts as JSONL plus metadata.
- `runs/` contains subagent events, transcripts, outputs, and status.
- `logs/` contains redacted diagnostics.
- `developer-feedback/issues.jsonl` contains bounded developer-only diagnostics.
- `checkpoints/task-state.sqlite3` contains LangGraph checkpoints for minimal product-analysis task state.
- `market-criteria/<node_id>/base.json` contains the criteria-stage contract;
  `products/<item_id>.json` contains each final product extraction and
  `market.json` is the last-published validated market index. Existing market
  artifacts are reused, and a base-only directory skips the criteria stage.

Deferred concurrency, background runs, FleetView, and a persistent Python worker are documented in [`backlog/`](./backlog/).
