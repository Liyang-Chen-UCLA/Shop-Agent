#!/usr/bin/env node
import { loadConfig } from "../../src/framework/config.ts";
import { createModelRuntime } from "../../src/framework/model-runtime.ts";
import { TaxonomySemanticMatchCache } from "../../src/framework/semantic-match-cache.ts";
import { SessionStore } from "../../src/framework/session-store.ts";
import { ModelDefinitionJudge } from "./definition-judge.ts";
import { loadEvalCase, loadPredictionArtifacts } from "./loaders.ts";
import { runEvaluation } from "./pipeline.ts";
import { ModelSemanticMatcher } from "./semantic-matcher.ts";
import { createLangfuseEvalTelemetry } from "./telemetry.ts";
import type { EvalResult } from "./types.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`Missing required argument ${name}.`);
  return value;
}

function formatSummary(result: EvalResult): string {
  const metricLines = Object.entries(result.metrics)
    .map(([name, value]) => `  ${name}: ${value.toFixed(3)}`)
    .join("\n");
  const failureCounts = new Map<string, number>();
  for (const failure of result.failures) {
    failureCounts.set(failure.diff_type, (failureCounts.get(failure.diff_type) ?? 0) + 1);
  }
  const failures = failureCounts.size
    ? [...failureCounts.entries()].map(([type, count]) => `${type}=${count}`).join(", ")
    : "none";
  return [
    `Eval case: ${result.case_id}`,
    `Session: ${result.session_id}`,
    `Node: ${result.node.id} ${result.node.name}`,
    "Metrics:",
    metricLines,
    `FailureUnits: ${result.failures.length} (${failures})`,
    "Langfuse: benchmark-eval observations and Session Scores flushed",
  ].join("\n");
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const caseId = requiredArgument("--case");
  const requestedSessionId = requiredArgument("--session");
  const config = await loadConfig(projectRoot, argument("--config"));
  const gold = await loadEvalCase(projectRoot, caseId);
  const session = await new SessionStore(config.dataDirectory).load(requestedSessionId);
  const { prediction, base } = await loadPredictionArtifacts(config.dataDirectory, gold.node.id);

  if (gold.node.id !== prediction.node.id) {
    throw new Error(
      `Taxonomy node mismatch: gold.node.id '${gold.node.id}' != prediction.node.id '${prediction.node.id}'.`,
    );
  }

  const { telemetry, tracing } = createLangfuseEvalTelemetry();
  try {
    const runtime = createModelRuntime(tracing);
    const matcher = new ModelSemanticMatcher(
      runtime,
      config.defaultModel,
      session.metadata.id,
      config.defaultThinking,
      {
        cache: new TaxonomySemanticMatchCache({
          runtimeData: config.dataDirectory,
          nodeId: gold.node.id,
          mode: "readOnly",
        }),
      },
    );
    const definitionJudge = new ModelDefinitionJudge(
      runtime,
      config.defaultModel,
      session.metadata.id,
      config.defaultThinking,
    );
    const result = await runEvaluation({
      caseId,
      sessionId: session.metadata.id,
      gold,
      prediction,
      base,
    }, matcher, telemetry, definitionJudge);
    await telemetry.flush();
    process.stdout.write(`${formatSummary(result)}\n`);
  } finally {
    await telemetry.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Shop Agent eval failed: ${message}\n`);
  process.exitCode = 1;
});
