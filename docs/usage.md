# Shop Agent TUI

## Start

Create the repo-local `.env` from the template, fill in `OPENCODE_API_KEY` and any
optional Langfuse credentials, then run:

```powershell
Copy-Item .env.example .env
.\start.ps1
```

The direct equivalent is:

```powershell
node --env-file-if-exists=.env src/cli.ts
```

Run the fixed three-turn phone workflow (create a task, update a preference,
then refine the route to unlocked phones) with the same app instance for every
turn:

```powershell
node --env-file-if-exists=.env src/cli.ts --multi-turn-test
```

This mode requires `OPENCODE_API_KEY`, a provisioned repo-local `.venv`, and
the normal taxonomy tools because it exercises the real model chain. It emits
one JSON Lines record per turn containing the user input, final assistant text,
and `app.getTaskState()` result. The offline node:test fake-app coverage does
not create a model or require credentials.

Run the backend environment workflow for dog food, table-tennis paddles, and
phone fill lights. It preflights the trusted `task_state_upsert` and
`shopping_env` tools in isolated UUID contexts, then sends the same three
category prompts through one real app instance and verifies the published
market artifacts:

```powershell
node --env-file-if-exists=.env src/cli.ts --backend-env-test
```

The backend-env mode also requires `OPENCODE_API_KEY`, a provisioned repo-local `.venv`,
and the configured product dataset. Its JSON Lines output includes only each environment sample's
category, item id, rank, and sample index (never the full OCR text). A missing
or mismatched market artifact causes a non-zero exit.

Validate configuration, authentication visibility, profiles, model metadata, `.venv` dependencies, and tool manifests without opening the TUI. The check may verify that uv is installed but does not execute it:

```powershell
.\start.ps1 -Check
```

Show full error stacks in the TUI and write diagnostics to `.shop-agent/logs/shop-agent.log`:

```powershell
.\start.ps1 -DebugMode
```

No npm package publication, link, or compilation step is part of the interactive workflow.

## Benchmark eval

Evaluate one explicit taxonomy case against the final market artifact associated
with its Gold node and attach the results to an existing real Session:

```powershell
npm run eval -- --case gamepad --session <session-id>
```

The case resolves only to `eval/cases/<case-id>/gold.json`; the command never
modifies Gold. Prediction and deterministic attribution inputs are read from
`<runtimeData>/market-criteria/<node_id>/market.json` and `base.json`. Gold and
prediction node IDs must match. The command creates a separate
`benchmark-eval` Langfuse trace under the supplied Session and writes eight
numeric Session Scores; it does not create a local eval output artifact.

This command loads `.env` and requires OpenCode credentials when unmatched
items need semantic matching, plus Langfuse public/secret keys for the primary
eval output.

Python dependencies are declared in `pyproject.toml` and locked in `uv.lock`. Provision the repo-local environment with uv. Normal startup never invokes uv; tools, trusted validators, and task state calls reuse the one `.venv` worker owned by the app.

```powershell
uv sync --locked
```

## Commands

- `/help` shows the command reference.
- `/new` saves the current conversation and starts a new session.
- `/sessions` lists project sessions.
- `/resume` opens a session picker; `/resume <id>` resumes by ID prefix.
- `/clear` clears visible output without changing model context.
- `/model` opens the OpenCode Go model picker.
- `/model <model>` changes the orchestrator for this session.
- `/model <agent> <model>` overrides a subagent for this session.
- `/thinking <level>` changes orchestrator reasoning.
- `/thinking <agent> <level>` overrides a subagent.
- `/agents` lists configured profiles and their tool allowlists.
- `/runs` opens a picker for subagent runs created in the current process; `/runs <id>` opens the full execution timeline.
- `/tasks` shows the active product-analysis task; `/tasks all` shows every task in the current session.
- `/abort` cancels the current model, subagent, or Python tool run.
- `/exit` saves and exits.

Pressing `Ctrl+C` aborts active work. Pressing it while idle exits.

Foreground subagent work appears inline as a persistent execution card. The card shows the delegated task, progress stages, tool arguments and result summaries, completion state, and elapsed time. Sensitive-looking fields are redacted and long summaries are truncated. Full run details intentionally omit raw reasoning text; use the arrow, Page Up/Down, Home, and End keys to scroll their overlay.

## Project layout

- `shop-agent.config.ts` is the thin project configuration entry.
- `shop/agents.ts` defines the orchestrator and subagent profiles.
- `shop/prompts/` contains role prompts.
- `shop/tools/**/tool.json` declares Python tools.
- `src/framework/` contains the reusable Agent runtime.
- `src/tui/` contains the interactive terminal UI.
- `.shop-agent/sessions/` stores main sessions as JSONL plus metadata.
- `.shop-agent/runs/` stores child events, transcripts, outputs, and status.
- `.shop-agent/logs/` stores redacted diagnostics.
- `.shop-agent/checkpoints/task-state.sqlite3` stores session-isolated product-analysis state.
- `docs/backlog/` records intentionally deferred framework capabilities.

The orchestrator has narrow task-state tools plus `delegate_agent` and an explicit developer-diagnostic tool. The `route_agent` can access taxonomy tools plus that diagnostic tool. `criteria_agent` receives only confirmed route facts, must use its isolated `web_search` tool before producing transient criteria and distinguishing attributes, and is validated by the trusted Pydantic contract. The general `delegate` remains tool-free. Add future tool names to a profile's explicit `tools` allowlist in `shop/agents.ts`.
