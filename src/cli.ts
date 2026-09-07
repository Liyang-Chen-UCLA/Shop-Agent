#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { createShopAgent } from "./framework/index.ts";
import { formatBackendEnvTestTurn, runBackendEnvTest } from "./backend-env-test.ts";
import { formatMultiTurnTestTurn, runMultiTurnTest } from "./multi-turn-test.ts";
import { ShopAgentTui } from "./tui/tui.ts";

async function checkDatasetFile(datasetPath: string): Promise<void> {
  try {
    const details = await stat(datasetPath);
    if (!details.isFile()) throw new Error("path is not a file");
  } catch (error) {
    const reason = error instanceof Error ? ` (${error.message})` : "";
    throw new Error(`Configured product dataset is unavailable: ${datasetPath}${reason}`);
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  let app: Awaited<ReturnType<typeof createShopAgent>> | undefined;
  try {
    app = await createShopAgent({ cwd: process.cwd(), configPath: argument("--config") });

    if (process.argv.includes("--check")) {
      await checkDatasetFile(app.config.datasetPath);
      process.stdout.write(`Shop Agent configuration is valid.\n`);
      process.stdout.write(`Provider: opencode-go\n`);
      process.stdout.write(`Model: ${app.currentSession.model}\n`);
      process.stdout.write(`Agents: ${app.listAgents().map((agent) => agent.id).join(", ")}\n`);
      process.stdout.write(`Python: .venv persistent worker\n`);
      process.stdout.write(`Dataset: ${app.config.datasetPath}\n`);
      return;
    }

    if (process.argv.includes("--multi-turn-test")) {
      await runMultiTurnTest(app, {
        onTurn: (turn) => {
          process.stdout.write(`${formatMultiTurnTestTurn(turn)}\n`);
        },
      });
      return;
    }

    if (process.argv.includes("--backend-env-test")) {
      await runBackendEnvTest(app, {
        onTurn: (turn) => {
          process.stdout.write(`${formatBackendEnvTestTurn(turn)}\n`);
        },
      });
      return;
    }

    const tui = new ShopAgentTui(app, process.argv.includes("--debug"));
    await tui.run();
  } finally {
    await app?.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Shop Agent failed to start: ${message}\n`);
  process.exitCode = 1;
});
