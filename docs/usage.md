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

Validate configuration, authentication visibility, profiles, model metadata, Python, and tool manifests without opening the TUI:

```powershell
.\start.ps1 -Check
```

Show full error stacks in the TUI and write diagnostics to `.shop-agent/logs/shop-agent.log`:

```powershell
.\start.ps1 -DebugMode
```

No npm command, package publication, link, or compilation step is part of this workflow.

The Python business tools require the packages pinned in `shop/requirements.txt`, installed into `D:\App\miniforge3\envs\shop-agent`.

```powershell
& 'D:\App\miniforge3\envs\shop-agent\python.exe' -m pip install -r shop\requirements.txt
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
- `/runs` lists subagent runs created in the current process.
- `/abort` cancels the current model, subagent, or Python tool run.
- `/exit` saves and exits.

Pressing `Ctrl+C` aborts active work. Pressing it while idle exits.

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

The orchestrator has narrow task-state tools plus `delegate_agent`. The `route_agent` can access only taxonomy tools, the `product_analyst` is tool-free, and the general `delegate` remains tool-free. Add future Python tool names to a profile's explicit `tools` allowlist in `shop/agents.ts`.
