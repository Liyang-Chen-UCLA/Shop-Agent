import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateJsonSchema } from "./schema.ts";
import type { ContractStateConfig, JsonSchema } from "./types.ts";

export const GET_STATE_TOOL = "get_state";
export const PATCH_STATE_TOOL = "patch_state";
export const FINALIZE_STATE_TOOL = "finalize_state";

export type ContractStateKind = "criterion" | "attribute";
export type ContractItem = Record<string, unknown>;
export type ContractState = {
  criteria: ContractItem[];
  attributes: ContractItem[];
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

type ContractPatch = UpsertPatch | RemovePatch;

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

function itemId(item: ContractItem): string {
  if (typeof item.id !== "string") throw new Error("contract state items require a string id.");
  return item.id;
}

export function emptyContractState(): ContractState {
  return { criteria: [], attributes: [] };
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
}

function validateItem(config: ContractStateConfig, kind: ContractStateKind, value: unknown, path: string): ContractItem {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const validation = validateJsonSchema(schemaFor(config, kind), value, path);
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
    const validated = validateItem(config, "criterion", item, `$.criteria[${index}]`);
    const id = itemId(validated);
    if (ids.has(id)) throw new Error(`contract state item id '${id}' is duplicated.`);
    ids.add(id);
    return validated;
  });
  const attributes = value.attributes.map((item, index) => {
    const validated = validateItem(config, "attribute", item, `$.attributes[${index}]`);
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

function stateResult(tool: string, state: ContractState): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(state) }],
    details: { tool, state: clone(state) },
  };
}

export class ContractStateStore {
  readonly config: ContractStateConfig;
  readonly patchSchema: JsonSchema;
  private current: ContractState;
  private finalizedState?: ContractState;

  constructor(config: ContractStateConfig, initialState: ContractState = emptyContractState()) {
    validateContractStateConfig(config);
    this.config = config;
    this.patchSchema = patchSchema(config);
    this.current = validateContractState(config, initialState);
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

  patch(value: unknown): ContractState {
    if (this.isFinalized) throw new Error("contract state is already finalized.");
    const validation = validateJsonSchema(this.patchSchema, value);
    if (!validation.valid) throw new Error(`patch_state arguments do not match the contract schema: ${validation.error}`);
    const patch = value as ContractPatch;
    const next = clone(this.current);

    if (patch.op === "remove") {
      next.criteria = next.criteria.filter((item) => itemId(item) !== patch.item_id);
      next.attributes = next.attributes.filter((item) => itemId(item) !== patch.item_id);
    } else {
      const collection = collectionFor(patch.kind);
      const otherCollection = collection === "criteria" ? "attributes" : "criteria";
      const item = validateItem(this.config, patch.kind, patch.item, `$.item`);
      const id = itemId(item);
      const targetIndex = next[collection].findIndex((existing) => itemId(existing) === id);
      if (targetIndex >= 0) next[collection][targetIndex] = item;
      else {
        next[otherCollection] = next[otherCollection].filter((existing) => itemId(existing) !== id);
        next[collection].push(item);
      }
    }

    this.current = validateContractState(this.config, next);
    return this.get();
  }

  finalize(): ContractState {
    if (!this.finalizedState) this.finalizedState = this.get();
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
): ContractStateToolSet {
  const store = new ContractStateStore(config, initialState);
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
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        return stateResult(PATCH_STATE_TOOL, store.patch(params));
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
        return { ...stateResult(FINALIZE_STATE_TOOL, store.finalize()), terminate: true };
      },
    },
  ];
  return { tools, store };
}
