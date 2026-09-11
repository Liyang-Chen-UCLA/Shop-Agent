import type { AgentTool } from "@earendil-works/pi-agent-core";
import { isDeepStrictEqual } from "node:util";
import { validateJsonSchema } from "./schema.ts";
import type { ContractStateConfig, JsonSchema } from "./types.ts";

export const GET_STATE_TOOL = "get_state";
export const PATCH_STATE_TOOL = "patch_state";
export const PATCH_STATE_BATCH_TOOL = "patch_state_batch";
export const FINALIZE_STATE_TOOL = "finalize_state";
export const CONTRACT_STATE_TOOL_NAMES = [GET_STATE_TOOL, PATCH_STATE_TOOL, PATCH_STATE_BATCH_TOOL, FINALIZE_STATE_TOOL] as const;

export type ContractStateKind = "criterion" | "attribute";
export type ContractItem = Record<string, unknown>;
export type ContractState = {
  criteria: ContractItem[];
  attributes: ContractItem[];
};

export type ContractStateFinalizeHook = (state: ContractState) => void | Promise<void>;
export type ContractStateUpsertRuntimeHook = (
  kind: ContractStateKind,
  item: ContractItem,
  existing?: ContractItem,
) => Record<string, unknown> | void;
export type ContractStateToolOptions = {
  onFinalize?: ContractStateFinalizeHook;
  runtime?: {
    onUpsert?: ContractStateUpsertRuntimeHook;
  };
};

type UpsertPatch = {
  op: "upsert";
  kind: ContractStateKind;
  item: ContractItem;
};

type RemovePatch = {
  op: "remove";
  item_id: string;
};

export type ContractPatch = UpsertPatch | RemovePatch;

export type ContractPatchReceiptItem =
  | { op: "upsert"; kind: ContractStateKind; item_id: string }
  | { op: "remove"; item_id: string };

export type ContractPatchReceipt = {
  ok: true;
  applied: ContractPatchReceiptItem[];
  criteria_count: number;
  attribute_count: number;
};

const NO_ARGUMENTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function collectionFor(kind: ContractStateKind): "criteria" | "attributes" {
  return kind === "criterion" ? "criteria" : "attributes";
}

function schemaFor(config: ContractStateConfig, kind: ContractStateKind): JsonSchema {
  return kind === "criterion" ? config.itemSchemas.criterion : config.itemSchemas.attribute;
}

function runtimeProperties(config: ContractStateConfig): Record<string, JsonSchema> {
  const properties = config.runtimeItemSchema?.properties;
  if (!isRecord(properties)) return {};
  return properties as Record<string, JsonSchema>;
}

function runtimeFieldNames(config: ContractStateConfig): Set<string> {
  return new Set(Object.keys(runtimeProperties(config)));
}

function withRuntimeSchema(schema: JsonSchema, config: ContractStateConfig): JsonSchema {
  const runtimeSchema = config.runtimeItemSchema;
  if (!runtimeSchema) return schema;
  if (Array.isArray(schema.anyOf)) {
    return {
      ...schema,
      anyOf: schema.anyOf.map((candidate) => (
        isRecord(candidate) ? withRuntimeSchema(candidate as JsonSchema, config) : candidate
      )),
    };
  }
  if (Array.isArray(schema.oneOf)) {
    return {
      ...schema,
      oneOf: schema.oneOf.map((candidate) => (
        isRecord(candidate) ? withRuntimeSchema(candidate as JsonSchema, config) : candidate
      )),
    };
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  const runtimeRequired = Array.isArray(runtimeSchema.required)
    ? runtimeSchema.required.filter((key): key is string => typeof key === "string")
    : [];
  return {
    ...schema,
    properties: { ...properties, ...runtimeProperties(config) },
    required: [...new Set([...required, ...runtimeRequired])],
  };
}

function stateSchemaFor(config: ContractStateConfig, kind: ContractStateKind): JsonSchema {
  return withRuntimeSchema(schemaFor(config, kind), config);
}

function runtimeDefaults(config: ContractStateConfig): Record<string, unknown> {
  return config.runtimeItemDefaults ? clone(config.runtimeItemDefaults) : {};
}

function addRuntimeDefaults(config: ContractStateConfig, state: ContractState): ContractState {
  const defaults = runtimeDefaults(config);
  if (!Object.keys(defaults).length) return clone(state);
  return {
    criteria: state.criteria.map((item) => ({ ...clone(defaults), ...clone(item) })),
    attributes: state.attributes.map((item) => ({ ...clone(defaults), ...clone(item) })),
  };
}

function runtimeMetadata(config: ContractStateConfig, item: ContractItem): Record<string, unknown> {
  const fields = runtimeFieldNames(config);
  return Object.fromEntries(Object.entries(item).filter(([key]) => fields.has(key)));
}

function validateRuntimeConfig(config: ContractStateConfig): void {
  if (config.runtimeItemSchema !== undefined) {
    if (!isRecord(config.runtimeItemSchema) || config.runtimeItemSchema.type !== "object" || !isRecord(config.runtimeItemSchema.properties)) {
      throw new Error("contractState.runtimeItemSchema must be an object schema with properties.");
    }
    if (config.runtimeItemSchema.additionalProperties !== false) {
      throw new Error("contractState.runtimeItemSchema must set additionalProperties to false.");
    }
    if (Array.isArray(config.runtimeItemSchema.required) && config.runtimeItemSchema.required.some((key) => typeof key !== "string")) {
      throw new Error("contractState.runtimeItemSchema.required must contain strings.");
    }
  }
  if (config.runtimeItemDefaults !== undefined && !isRecord(config.runtimeItemDefaults)) {
    throw new Error("contractState.runtimeItemDefaults must be an object.");
  }
  if (config.runtimeMutableFields !== undefined && (
    !Array.isArray(config.runtimeMutableFields) || config.runtimeMutableFields.some((field) => typeof field !== "string" || !field.trim())
  )) {
    throw new Error("contractState.runtimeMutableFields must contain non-empty strings.");
  }
}

function itemId(item: ContractItem): string {
  if (typeof item.id !== "string") throw new Error("contract state items require a string id.");
  return item.id;
}

export function emptyContractState(): ContractState {
  return { criteria: [], attributes: [] };
}

export function isContractStateToolName(name: string): boolean {
  return (CONTRACT_STATE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Validate the generic opt-in configuration without knowing any Shop item fields. */
export function validateContractStateConfig(value: unknown): asserts value is ContractStateConfig {
  if (!isRecord(value) || !isRecord(value.itemSchemas)) {
    throw new Error("contractState.itemSchemas must be an object.");
  }
  for (const kind of ["criterion", "attribute"] as const) {
    const schema = value.itemSchemas[kind];
    if (!isRecord(schema)) throw new Error(`contractState.itemSchemas.${kind} must be a JSON schema object.`);
  }
  validateRuntimeConfig(value as ContractStateConfig);
}

function validateItem(
  config: ContractStateConfig,
  kind: ContractStateKind,
  value: unknown,
  path: string,
  includeRuntimeMetadata = false,
): ContractItem {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const validation = validateJsonSchema(
    includeRuntimeMetadata ? stateSchemaFor(config, kind) : schemaFor(config, kind),
    value,
    path,
  );
  if (!validation.valid) throw new Error(validation.error);
  itemId(value);
  return clone(value);
}

/** Validate and clone a complete working state. State metadata is intentionally excluded. */
export function validateContractState(config: ContractStateConfig, value: unknown): ContractState {
  validateContractStateConfig(config);
  if (!isRecord(value)) throw new Error("contract state must be an object.");
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "attributes" || keys[1] !== "criteria") {
    throw new Error("contract state must contain only criteria and attributes.");
  }
  if (!Array.isArray(value.criteria) || !Array.isArray(value.attributes)) {
    throw new Error("contract state criteria and attributes must be arrays.");
  }

  const ids = new Set<string>();
  const criteria = value.criteria.map((item, index) => {
    const validated = validateItem(config, "criterion", item, `$.criteria[${index}]`, true);
    const id = itemId(validated);
    if (ids.has(id)) throw new Error(`contract state item id '${id}' is duplicated.`);
    ids.add(id);
    return validated;
  });
  const attributes = value.attributes.map((item, index) => {
    const validated = validateItem(config, "attribute", item, `$.attributes[${index}]`, true);
    const id = itemId(validated);
    if (ids.has(id)) throw new Error(`contract state item id '${id}' is duplicated.`);
    ids.add(id);
    return validated;
  });
  return { criteria, attributes };
}

function patchSchema(config: ContractStateConfig): JsonSchema {
  const upsert = (kind: ContractStateKind): JsonSchema => ({
    type: "object",
    properties: {
      op: { const: "upsert" },
      kind: { const: kind },
      item: schemaFor(config, kind),
    },
    required: ["op", "kind", "item"],
    additionalProperties: false,
  });
  return {
    oneOf: [
      upsert("criterion"),
      upsert("attribute"),
      {
        type: "object",
        properties: { op: { const: "remove" }, item_id: { type: "string" } },
        required: ["op", "item_id"],
        additionalProperties: false,
      },
    ],
  };
}

function patchBatchSchema(config: ContractStateConfig): JsonSchema {
  return {
    type: "object",
    properties: {
      patches: { type: "array", items: patchSchema(config) },
    },
    required: ["patches"],
    additionalProperties: false,
  };
}

function stateResult(tool: string, state: ContractState): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(state) }],
    details: { tool, state: clone(state) },
  };
}

function patchReceipt(tool: string, receipt: ContractPatchReceipt): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(receipt) }],
    details: { tool, ...receipt },
  };
}

function preparePatchArgument(value: unknown): unknown {
  if (!isRecord(value) || value.op !== "upsert" || typeof value.item !== "string") return value;
  try {
    const item = JSON.parse(value.item) as unknown;
    return isRecord(item) ? { ...value, item } : value;
  } catch {
    return value;
  }
}

function preparePatchBatchArguments(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.patches)) return value;
  let changed = false;
  const patches = value.patches.map((patch) => {
    const prepared = preparePatchArgument(patch);
    if (prepared !== patch) changed = true;
    return prepared;
  });
  return changed ? { ...value, patches } : value;
}

type AppliedPatch = ContractPatchReceiptItem;

type ContractStateMutation = {
  state: ContractState;
  applied: AppliedPatch[];
};

export class ContractStateStore {
  readonly config: ContractStateConfig;
  readonly patchSchema: JsonSchema;
  readonly patchBatchSchema: JsonSchema;
  private current: ContractState;
  private finalizedState?: ContractState;
  private readonly onFinalize?: ContractStateFinalizeHook;
  private readonly onUpsert?: ContractStateUpsertRuntimeHook;

  constructor(
    config: ContractStateConfig,
    initialState: ContractState = emptyContractState(),
    options: ContractStateToolOptions = {},
  ) {
    validateContractStateConfig(config);
    this.config = config;
    this.patchSchema = patchSchema(config);
    this.patchBatchSchema = patchBatchSchema(config);
    this.current = validateContractState(config, addRuntimeDefaults(config, initialState));
    this.onFinalize = options.onFinalize;
    this.onUpsert = options.runtime?.onUpsert;
  }

  get(): ContractState {
    return clone(this.current);
  }

  get isFinalized(): boolean {
    return this.finalizedState !== undefined;
  }

  finalized(): ContractState | undefined {
    return this.finalizedState ? clone(this.finalizedState) : undefined;
  }

  private assertMutable(): void {
    if (this.isFinalized) throw new Error("contract state is already finalized.");
  }

  private normalizePatch(value: unknown, path: string, tool: string): ContractPatch {
    const validation = validateJsonSchema(this.patchSchema, value, path);
    if (!validation.valid) throw new Error(`${tool} arguments do not match the contract schema: ${validation.error}`);
    if (!isRecord(value)) throw new Error(`${path} must be an object.`);
    if (value.op === "remove") {
      return { op: "remove", item_id: value.item_id as string };
    }
    return {
      op: value.op as "upsert",
      kind: value.kind as ContractStateKind,
      item: validateItem(this.config, value.kind as ContractStateKind, value.item, `${path}.item`),
    };
  }

  private normalizeBatch(value: unknown): ContractPatch[] {
    const validation = validateJsonSchema(this.patchBatchSchema, value);
    if (!validation.valid) throw new Error(`patch_state_batch arguments do not match the contract schema: ${validation.error}`);
    if (!isRecord(value) || !Array.isArray(value.patches)) throw new Error("patch_state_batch patches must be an array.");
    return value.patches.map((patch, index) => this.normalizePatch(patch, `$.patches[${index}]`, PATCH_STATE_BATCH_TOOL));
  }

  private applyPatch(next: ContractState, patch: ContractPatch): AppliedPatch {
    if (patch.op === "remove") {
      next.criteria = next.criteria.filter((item) => itemId(item) !== patch.item_id);
      next.attributes = next.attributes.filter((item) => itemId(item) !== patch.item_id);
      return { op: "remove", item_id: patch.item_id };
    }

    const collection = collectionFor(patch.kind);
    const otherCollection = collection === "criteria" ? "attributes" : "criteria";
    const definition = clone(patch.item);
    const id = itemId(definition);
    const existing = [...next.criteria, ...next.attributes].find((candidate) => itemId(candidate) === id);
    const runtime = {
      ...runtimeDefaults(this.config),
      ...(existing ? runtimeMetadata(this.config, existing) : {}),
    };
    const updates = this.onUpsert?.(patch.kind, clone(definition), existing ? clone(existing) : undefined);
    if (updates !== undefined) {
      if (!isRecord(updates)) throw new Error("contract state runtime upsert metadata must be an object.");
      const fields = runtimeFieldNames(this.config);
      const invalid = Object.keys(updates).find((key) => !fields.has(key));
      if (invalid) throw new Error(`contract state runtime upsert cannot modify definition field '${invalid}'.`);
      Object.assign(runtime, clone(updates));
    }
    const item = { ...definition, ...runtime };
    const targetIndex = next[collection].findIndex((existing) => itemId(existing) === id);
    if (targetIndex >= 0) next[collection][targetIndex] = item;
    else {
      next[otherCollection] = next[otherCollection].filter((existing) => itemId(existing) !== id);
      next[collection].push(item);
    }
    return { op: "upsert", kind: patch.kind, item_id: id };
  }

  private commitPatches(patches: readonly ContractPatch[]): ContractStateMutation {
    this.assertMutable();
    let next = clone(this.current);
    const applied: AppliedPatch[] = [];
    for (const patch of patches) {
      applied.push(this.applyPatch(next, patch));
      next = validateContractState(this.config, next);
    }
    const state = next;
    this.current = state;
    return { state: this.get(), applied };
  }

  patch(value: unknown): ContractState {
    this.assertMutable();
    const patch = this.normalizePatch(value, "$", PATCH_STATE_TOOL);
    return this.commitPatches([patch]).state;
  }

  patchWithReceipt(value: unknown): ContractPatchReceipt {
    this.assertMutable();
    const patch = this.normalizePatch(value, "$", PATCH_STATE_TOOL);
    const result = this.commitPatches([patch]);
    return {
      ok: true,
      applied: result.applied,
      criteria_count: result.state.criteria.length,
      attribute_count: result.state.attributes.length,
    };
  }

  patchBatch(value: unknown): ContractState {
    this.assertMutable();
    const patches = this.normalizeBatch(value);
    return this.commitPatches(patches).state;
  }

  patchBatchWithReceipt(value: unknown): ContractPatchReceipt {
    this.assertMutable();
    const patches = this.normalizeBatch(value);
    const result = this.commitPatches(patches);
    return {
      ok: true,
      applied: result.applied,
      criteria_count: result.state.criteria.length,
      attribute_count: result.state.attributes.length,
    };
  }

  /** Apply a trusted runtime-only mutation; LLM patch inputs never use this path. */
  updateRuntimeItem(itemIdValue: string, updater: (item: ContractItem, kind: ContractStateKind) => ContractItem): ContractState {
    if (this.isFinalized) throw new Error("contract state is already finalized.");
    const locations: Array<{ collection: "criteria" | "attributes"; index: number; kind: ContractStateKind }> = [
      ...this.current.criteria.map((_, index) => ({ collection: "criteria" as const, index, kind: "criterion" as const })),
      ...this.current.attributes.map((_, index) => ({ collection: "attributes" as const, index, kind: "attribute" as const })),
    ];
    const location = locations.find(({ collection, index }) => itemId(this.current[collection][index]) === itemIdValue);
    if (!location) throw new Error(`contract state item id '${itemIdValue}' was not found.`);
    const before = clone(this.current[location.collection][location.index]);
    const updated = updater(clone(before), location.kind);
    if (!isRecord(updated)) throw new Error("contract state runtime update must return an object.");
    const mutable = new Set(this.config.runtimeMutableFields ?? []);
    const keys = new Set([...Object.keys(before), ...Object.keys(updated)]);
    for (const key of keys) {
      if (!mutable.has(key) && !isDeepStrictEqual(before[key], updated[key])) {
        throw new Error(`contract state runtime update cannot modify definition field '${key}'.`);
      }
    }
    const next = clone(this.current);
    next[location.collection][location.index] = clone(updated);
    this.current = validateContractState(this.config, next);
    return this.get();
  }

  async finalize(): Promise<ContractState> {
    if (this.finalizedState) return clone(this.finalizedState);
    const state = this.get();
    await this.onFinalize?.(state);
    this.finalizedState = state;
    return clone(this.finalizedState);
  }
}

export type ContractStateToolSet = {
  tools: AgentTool<any>[];
  store: ContractStateStore;
};

export function createContractStateTools(
  config: ContractStateConfig,
  initialState: ContractState = emptyContractState(),
  options: ContractStateToolOptions = {},
): ContractStateToolSet {
  const store = new ContractStateStore(config, initialState, options);
  const tools: AgentTool<any>[] = [
    {
      name: GET_STATE_TOOL,
      label: GET_STATE_TOOL,
      description: "Read the current framework-owned contract state.",
      parameters: NO_ARGUMENTS_SCHEMA,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const validation = validateJsonSchema(NO_ARGUMENTS_SCHEMA, params);
        if (!validation.valid) throw new Error(`get_state arguments do not match the tool schema: ${validation.error}`);
        return stateResult(GET_STATE_TOOL, store.get());
      },
    },
    {
      name: PATCH_STATE_TOOL,
      label: PATCH_STATE_TOOL,
      description: "Upsert one complete contract item or remove one item by its global id.",
      parameters: store.patchSchema,
      prepareArguments(args) {
        return preparePatchArgument(args) as any;
      },
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        return patchReceipt(PATCH_STATE_TOOL, store.patchWithReceipt(params));
      },
    },
    {
      name: PATCH_STATE_BATCH_TOOL,
      label: PATCH_STATE_BATCH_TOOL,
      description: "Atomically upsert or remove multiple complete contract items.",
      parameters: store.patchBatchSchema,
      prepareArguments(args) {
        return preparePatchBatchArguments(args) as any;
      },
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        return patchReceipt(PATCH_STATE_BATCH_TOOL, store.patchBatchWithReceipt(params));
      },
    },
    {
      name: FINALIZE_STATE_TOOL,
      label: FINALIZE_STATE_TOOL,
      description: "Publish the current framework-owned contract state.",
      parameters: NO_ARGUMENTS_SCHEMA,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const validation = validateJsonSchema(NO_ARGUMENTS_SCHEMA, params);
        if (!validation.valid) throw new Error(`finalize_state arguments do not match the tool schema: ${validation.error}`);
        const state = await store.finalize();
        return { ...stateResult(FINALIZE_STATE_TOOL, state), terminate: true };
      },
    },
  ];
  return { tools, store };
}
