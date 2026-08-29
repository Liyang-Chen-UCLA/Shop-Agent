# Architecture

Shop Agent keeps the product-facing business workspace separate from the reusable runtime without introducing packages, compilation, or a monorepo.

## Repository boundaries

```text
root
├─ start.ps1                 user launch entry
├─ shop-agent.config.ts      thin configuration entry
├─ shop/                     business extension workspace
│  ├─ agents.ts              profiles and tool allowlists
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

## Python tool boundary

Python tools are discovered from `shop/tools/**/tool.json`, but discovery does not expose them automatically. A profile in `shop/agents.ts` must explicitly include the tool name.

Every call starts `D:\App\miniforge3\envs\shop-agent\python.exe`, sends one JSON request over stdin, and validates the JSON response against the manifest output schema. Python receives only the Windows runtime variables and explicitly allowlisted business variables; it does not inherit `OPENCODE_API_KEY` by default.

## Persistent data

`.shop-agent/` is runtime-only and ignored by Git:

- `sessions/` contains main transcripts as JSONL plus metadata.
- `runs/` contains subagent events, transcripts, outputs, and status.
- `logs/` contains redacted diagnostics.

Deferred concurrency, background runs, FleetView, and a persistent Python worker are documented in [`backlog/`](./backlog/).
