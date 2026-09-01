# Shop Agent TUI

## Start

Open a new PowerShell terminal after setting the system `OPENCODE_API_KEY`, then run:

```powershell
.\start.ps1
```

The direct equivalent is:

```powershell
node src/cli.ts
```

Run the fixed three-turn phone workflow (create a task, update a preference,
then refine the route to unlocked phones) with the same app instance for every
turn:

```powershell
$env:SHOP_AGENT_PYTHON = "D:\App\miniforge3\envs\shop-agent\python.exe"
node src/cli.ts --multi-turn-test
```

This mode requires `OPENCODE_API_KEY`, the configured Python environment, and
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
$env:SHOP_AGENT_PYTHON = "D:\App\miniforge3\envs\shop-agent\python.exe"
node src/cli.ts --backend-env-test
```

The backend-env mode also requires `OPENCODE_API_KEY` and the configured
product dataset. Its JSON Lines output includes only each environment sample's
category, item id, rank, and sample index (never the full OCR text). A missing
or mismatched market artifact causes a non-zero exit.

Validate configuration, authentication visibility, profiles, model metadata, Python, and tool manifests without opening the TUI:

```powershell
.\start.ps1 -Check
```

Show full error stacks in the TUI and write diagnostics to `.shop-agent/logs/shop-agent.log`:

```powershell
.\start.ps1 -DebugMode
```

No npm command, package publication, link, or compilation step is part of this workflow.

The Python business tools require the packages pinned in `shop/requirements.txt`, installed into the Python environment selected for the project.

The interpreter is configurable. Set `SHOP_AGENT_PYTHON` to a Python command or executable path; otherwise the runtime uses `python` from `PATH`. The `-Python` parameter on `start.ps1` applies the setting for one launch.

```powershell
$env:SHOP_AGENT_PYTHON = "D:\venvs\shop-agent\Scripts\python.exe"
& $env:SHOP_AGENT_PYTHON -m pip install -r shop\requirements.txt
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
