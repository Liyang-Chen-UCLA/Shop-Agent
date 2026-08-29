# Shop Agent workspace

- This project runs on Windows with Node.js 22.19 or newer.
- Run the interactive application directly with `node src/cli.ts`.
- Do not add npm publishing, package binaries, npm scripts, or a TypeScript build step unless the user explicitly asks for them.
- The only Python environment available to this project is `D:\App\miniforge3\envs\shop-agent`.
- Use `D:\App\miniforge3\envs\shop-agent\python.exe` for every Python tool. Do not use the system Python or create another environment.
- Model credentials come from the system environment. Never write `OPENCODE_API_KEY` or other secrets into repository files or logs.
- Runtime sessions, subagent runs, and logs belong under `.shop-agent/` and must not be committed.
- LLM-visible tools are allowlisted per agent profile. Do not add filesystem, shell, or generic HTTP tools to the orchestrator.
