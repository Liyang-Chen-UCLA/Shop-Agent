export type ItemKind = "criteria" | "attribute";

export type TaxonomyNode = {
  id: string;
  name: string;
  path: string[];
};

export type CriteriaItem = {
  id: string;
  name: string;
  description?: string;
  aliases: string[];
  type: string;
  direction?: unknown;
  units?: string[];
  values?: string[];
  value_domain?: string;
  [key: string]: unknown;
};

export type MarketPredictionItem = CriteriaItem & {
  observed_product_ids: string[];
};

export type CriteriaDocument = {
  node: TaxonomyNode;
  criteria: CriteriaItem[];
  attributes: CriteriaItem[];
  [key: string]: unknown;
};

export type MarketPredictionDocument = Omit<CriteriaDocument, "criteria" | "attributes"> & {
  criteria: MarketPredictionItem[];
  attributes: MarketPredictionItem[];
};

export type EvaluatedItem = {
  ref: string;
  kind: ItemKind;
  item: CriteriaItem;
};

export type MatchMethod = "id" | "name" | "alias" | "semantic";

export type ItemPairing = {
  gold: EvaluatedItem;
  pred: EvaluatedItem;
  method: MatchMethod;
};

export type SemanticMatchInput = {
  gold: EvaluatedItem[];
  pred: EvaluatedItem[];
};

export type SemanticPairing = {
  gold_ref: string;
  pred_ref: string;
};

export interface SemanticMatcher {
  match(input: SemanticMatchInput): Promise<SemanticPairing[]>;
}

export type DefinitionJudgeInput = {
  gold: EvaluatedItem;
  pred: EvaluatedItem;
};

export type DefinitionFieldJudgment = {
  field: FieldDiff["field"];
  equivalent: boolean;
  reason: string;
};

export type DefinitionResult = {
  rule_diffs: FieldDiff[];
  final_diffs: FieldDiff[];
  judgments: DefinitionFieldJudgment[];
};

export interface DefinitionJudge {
  judge(input: DefinitionJudgeInput): Promise<DefinitionResult>;
}

export type SessionMetrics = {
  route_correctness: number;
  criteria_precision: number;
  criteria_recall: number;
  criteria_f1: number;
  attribute_precision: number;
  attribute_recall: number;
  attribute_f1: number;
  matched_item_field_accuracy: number;
};

export type DiffType = "missing" | "extra" | "wrong_kind" | "wrong_definition";
export type RootCause = "route_error" | "criteria_error" | "market_error" | "unresolved";
export type EarliestDivergence = "route" | "criteria" | "market" | "unresolved";
export type RepairTarget =
  | "route prompt / taxonomy tools"
  | "research-agent prompt / research policy"
  | "market-agent prompt / market-alignment skill"
  | null;

export type ItemSnapshot = CriteriaItem & { kind: ItemKind };

export type FieldDiff = {
  field: "type" | "direction" | "units" | "values" | "value_domain";
  gold: unknown;
  pred: unknown;
};

export type FailureUnit = {
  gold_item: ItemSnapshot | null;
  pred_item: ItemSnapshot | null;
  diff_type: DiffType;
  field_diffs?: FieldDiff[];
  earliest_divergence: EarliestDivergence;
  root_cause: RootCause;
  repair_target: RepairTarget;
};

export type EvalResult = {
  case_id: string;
  session_id: string;
  node: TaxonomyNode;
  metrics: SessionMetrics;
  pairings: Array<{
    gold_ref: string;
    pred_ref: string;
    method: MatchMethod;
  }>;
  failures: FailureUnit[];
};

export type EvaluationInput = {
  caseId: string;
  sessionId: string;
  gold: CriteriaDocument;
  prediction: CriteriaDocument;
  base?: CriteriaDocument;
};

export type SessionScorePayload = {
  id: string;
  sessionId: string;
  name: keyof SessionMetrics;
  value: number;
  dataType: "NUMERIC";
  comment: string;
  metadata: { caseId: string; nodeId: string };
};

export interface SessionScoreWriter {
  write(scores: SessionScorePayload[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface EvalTelemetry {
  withBenchmark(input: EvaluationInput, run: () => Promise<EvalResult>): Promise<EvalResult>;
  observeSemanticMatch<T>(input: SemanticMatchInput, run: () => Promise<T>): Promise<T>;
  observeDefinitionJudge(
    input: DefinitionJudgeInput,
    ruleDiffs: readonly FieldDiff[],
    run: () => Promise<DefinitionResult>,
  ): Promise<DefinitionResult>;
  recordFailure(failure: FailureUnit): Promise<void>;
  writeSessionScores(result: EvalResult): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
