# Shop Agent workspace

- This project runs on Windows with Node.js 22.19 or newer.
- Run the interactive application directly with `node src/cli.ts`.
- Do not add npm publishing, package binaries, npm scripts, or a TypeScript build step unless the user explicitly asks for them.
- The project Python environment is available at either `D:\App\miniforge3\envs\shop-agent` or `F:\Anaconda3\envs\shop-agent`, depending on the machine. Use the path that exists locally.
- Use the selected environment's `python.exe` for every Python tool. Do not use the system Python or create another environment.
- Model credentials come from the system environment. Never write `OPENCODE_API_KEY` or other secrets into repository files or logs.
- Runtime sessions, subagent runs, and logs belong under `.shop-agent/` and must not be committed.
- LLM-visible tools are allowlisted per agent profile. Do not add filesystem, shell, or generic HTTP tools to the orchestrator.

## Product-analysis task model

- The shopping workflow constructs evaluation criteria and analysis guidance for a product category. It does not model a task as one specific SKU purchase.
- A session can contain multiple tasks and has one active task. Within a session, at most one task may target the same taxonomy node; revisiting that node updates and activates the existing task.
- A task keeps only an independent task ID, the current normalized product name, a flat preference dictionary, and the resolved taxonomy route (`node_id`, `node_name`, and `node_path`). Do not add task lifecycle status or graph-control fields to the task state.
- Brand, model, budget, exclusions, and other user requirements are preferences. Preference keys are created as needed, but semantically equivalent requirements must reuse one key. New values replace old values, and an explicit “unlimited/does not matter” removes the corresponding key.
- Multiple brands or models inside one product category are alternative candidates in the same task. Inputs spanning multiple categories require the user to choose one category before a task is created; unselected categories are not persisted.
- The orchestrator extracts the normalized product name and preferences. The route agent maps that product to the canonical taxonomy node and progressively discloses only relevant candidates and direct children through allowlisted taxonomy tools.
- Route refinement from a parent node to a direct child keeps the same task ID and updates both the product name and route. Let the user stop at a non-leaf node; do not guess a deeper category without evidence.
- Persist canonical task state with a Python LangGraph SQLite checkpointer keyed by the trusted session ID. Full transcript recovery handles conversational confirmations in the current design.
- Keep taxonomy lookup and task-state business logic in Python. TypeScript should only provide the minimal runtime bridge required by the existing Node.js CLI and agent framework.

<!-- codex-execution-mode:start -->
## Active Codex Execution Mode: Sol -> Luna -> Sol

For this project, GPT-5.6 Sol owns architecture, the concise plan, acceptance criteria, and final review. Small work may remain in Sol. For substantial implementation, Sol must delegate bulk implementation and routine validation to exactly one built-in `worker` explicitly configured with `model = "gpt-5.6-luna"`, `model_reasoning_effort = "max"`, `fork_turns = "none"`, and task label `luna_executor`; then Sol must inspect the diff and results and return narrowly scoped corrections to that same worker when needed. Do not use an unconfigured worker, a full-history fork, a custom-agent file, or overlapping write-heavy agents. A later explicit user instruction overrides this mode.

Before claiming this mode is active, establish that the primary session is GPT-5.6 Sol from exposed runtime metadata, an exact applicable Codex model configuration with no known conflicting override, or an explicit launcher or user statement. Report the evidence used and note that a hidden UI or CLI override can supersede static configuration. If evidence conflicts or remains insufficient, stop and ask the user to switch to GPT-5.6 Sol.
<!-- codex-execution-mode:end -->
