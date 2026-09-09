import { createHash } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import { createTracing, type Tracing } from "../../src/framework/tracing/index.ts";
import type {
  EvalResult,
  EvalTelemetry,
  EvaluationInput,
  FailureUnit,
  SemanticMatchInput,
  SessionScorePayload,
  SessionScoreWriter,
} from "./types.ts";

function scoreId(sessionId: string, caseId: string, name: string): string {
  const hash = createHash("sha256").update(`shop-agent-eval:${sessionId}:${caseId}:${name}`).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

type ScoreClient = {
  score: { create(payload: SessionScorePayload): void };
  flush(): Promise<unknown>;
  shutdown(): Promise<unknown>;
};

export class LangfuseSessionScoreWriter implements SessionScoreWriter {
  private readonly client: ScoreClient;

  constructor(client: ScoreClient) {
    this.client = client;
  }

  async write(scores: SessionScorePayload[]): Promise<void> {
    for (const score of scores) this.client.score.create(score);
  }

  async flush(): Promise<void> {
    await this.client.flush();
  }

  async close(): Promise<void> {
    await this.client.shutdown();
  }
}

function semanticSnapshot(input: SemanticMatchInput): unknown {
  const snapshot = (item: SemanticMatchInput["gold"][number]) => ({
    ref: item.ref,
    kind: item.kind,
    id: item.item.id,
    name: item.item.name,
    aliases: item.item.aliases,
    description: item.item.description,
  });
  return { gold: input.gold.map(snapshot), pred: input.pred.map(snapshot) };
}

export class LangfuseEvalTelemetry implements EvalTelemetry {
  private readonly tracing: Tracing;
  private readonly scores: SessionScoreWriter;

  constructor(
    tracing: Tracing,
    scores: SessionScoreWriter,
  ) {
    this.tracing = tracing;
    this.scores = scores;
  }

  withBenchmark(input: EvaluationInput, run: () => Promise<EvalResult>): Promise<EvalResult> {
    return this.tracing.withObservation("benchmark-eval", "chain", {
      input: {
        case_id: input.caseId,
        session_id: input.sessionId,
        gold_node: input.gold.node,
        prediction_node: input.prediction.node,
      },
      metadata: { caseId: input.caseId, nodeId: input.gold.node.id },
    }, async (observation) => {
      const result = await run();
      observation?.update({
        output: {
          metrics: result.metrics,
          failure_count: result.failures.length,
          pairing_count: result.pairings.length,
        },
      });
      return result;
    }, input.sessionId, { name: "benchmark-eval", tags: ["shop-agent", "benchmark-eval"] });
  }

  observeSemanticMatch<T>(input: SemanticMatchInput, run: () => Promise<T>): Promise<T> {
    return this.tracing.withObservation("semantic-match", "chain", {
      input: semanticSnapshot(input),
      metadata: { oneToOne: true, goldCount: input.gold.length, predCount: input.pred.length },
    }, async (observation) => {
      const result = await run();
      observation?.update({ output: result });
      return result;
    });
  }

  async recordFailure(failure: FailureUnit): Promise<void> {
    await this.tracing.withObservation("failure-unit", "span", {
      input: { gold_item: failure.gold_item, pred_item: failure.pred_item },
      output: {
        diff_type: failure.diff_type,
        field_diffs: failure.field_diffs,
        earliest_divergence: failure.earliest_divergence,
        root_cause: failure.root_cause,
        repair_target: failure.repair_target,
      },
      metadata: { diffType: failure.diff_type, rootCause: failure.root_cause },
    }, async () => undefined);
  }

  async writeSessionScores(result: EvalResult): Promise<void> {
    const payloads = Object.entries(result.metrics).map(([name, value]) => ({
      id: scoreId(result.session_id, result.case_id, name),
      sessionId: result.session_id,
      name: name as keyof EvalResult["metrics"],
      value,
      dataType: "NUMERIC" as const,
      comment: `Shop Agent benchmark eval case '${result.case_id}'.`,
      metadata: { caseId: result.case_id, nodeId: result.node.id },
    }));
    await this.scores.write(payloads);
  }

  async flush(): Promise<void> {
    await this.scores.flush();
    await this.tracing.flush();
  }

  async close(): Promise<void> {
    try {
      await this.scores.close();
    } finally {
      await this.tracing.shutdown();
    }
  }
}

export function createLangfuseEvalTelemetry(): { telemetry: LangfuseEvalTelemetry; tracing: Tracing } {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    throw new Error("Langfuse credentials are required for eval: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.");
  }
  const tracing = createTracing({ exportMode: "immediate" });
  if (!tracing.enabled) {
    throw new Error("Langfuse tracing is disabled; benchmark-eval observations cannot be recorded.");
  }
  const client = new LangfuseClient({
    publicKey,
    secretKey,
    ...(process.env.LANGFUSE_BASE_URL?.trim() ? { baseUrl: process.env.LANGFUSE_BASE_URL.trim().replace(/\/$/, "") } : {}),
  });
  return { telemetry: new LangfuseEvalTelemetry(tracing, new LangfuseSessionScoreWriter(client)), tracing };
}
