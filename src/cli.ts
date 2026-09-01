#!/usr/bin/env node
import { createShopAgent } from "./framework/index.ts";
import { ShopAgentTui } from "./tui/tui.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const app = await createShopAgent({
    cwd: process.cwd(),
    configPath: argument("--config"),
  });

  if (process.argv.includes("--check")) {
    process.stdout.write(`Shop Agent configuration is valid.\n`);
    process.stdout.write(`Provider: opencode-go\n`);
    process.stdout.write(`Model: ${app.currentSession.model}\n`);
    process.stdout.write(`Agents: ${app.listAgents().map((agent) => agent.id).join(", ")}\n`);
    process.stdout.write(`Python: ${app.config.python.executable}\n`);
    return;
  }

  const tui = new ShopAgentTui(app, process.argv.includes("--debug"));
  await tui.run();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Shop Agent failed to start: ${message}\n`);
  process.exitCode = 1;
});
