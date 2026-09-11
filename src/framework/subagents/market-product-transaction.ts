import type { ContractItem, ContractState, ContractStateKind } from "../contract-state.ts";
import type { SemanticMatchBatchToolResult } from "../semantic-matcher.ts";

function candidateEntries(output: Pick<ContractState, "criteria" | "attributes">): Array<[string, ContractStateKind]> {
  return [
    ...output.criteria.map((item) => [String(item.id), "criterion"] as const),
    ...output.attributes.map((item) => [String(item.id), "attribute"] as const),
  ];
}

function stateIds(state: ContractState): Set<string> {
  return new Set(candidateEntries(state).map(([id]) => id));
}

function invalidFieldId(id: string): Error {
  return new Error(`Invalid market field id '${id}'.\nExpected an id from current get_state or extract_product.`);
}

export class MarketProductTransaction {
  sampledProductId?: string;
  activeProductId?: string;
  readonly candidateKinds = new Map<string, ContractStateKind>();
  readonly directPatchCandidateIds = new Set<string>();
  readonly semanticCandidateIds = new Set<string>();
  readonly outstandingCandidateIds = new Set<string>();
  batchResolved = false;
  complete = true;

  sampled(itemId: string): void {
    this.sampledProductId = itemId;
    this.activeProductId = undefined;
    this.resetCandidates();
    this.complete = false;
  }

  extracted(itemId: string, output: Pick<ContractState, "criteria" | "attributes">, state: ContractState): void {
    this.activeProductId = itemId;
    this.resetCandidates();
    const emptyKinds = new Set<ContractStateKind>([
      ...(state.criteria.length === 0 ? ["criterion" as const] : []),
      ...(state.attributes.length === 0 ? ["attribute" as const] : []),
    ]);
    for (const [id, kind] of candidateEntries(output)) {
      this.candidateKinds.set(id, kind);
      if (emptyKinds.has(kind)) {
        this.directPatchCandidateIds.add(id);
        this.outstandingCandidateIds.add(id);
      } else {
        this.semanticCandidateIds.add(id);
      }
    }
    this.batchResolved = this.semanticCandidateIds.size === 0;
    this.updateComplete();
  }

  assertPatchAllowed(kind: ContractStateKind, item: ContractItem, state: ContractState): void {
    if (!this.activeProductId) throw new Error("market_agent patch_state requires a successfully extracted active product.");
    const id = String(item.id);
    if (!this.candidateKinds.has(id) && !stateIds(state).has(id)) throw invalidFieldId(id);
    const isDirectCandidate = this.directPatchCandidateIds.has(id)
      && this.candidateKinds.get(id) === kind;
    if (this.directPatchCandidateIds.has(id) && !isDirectCandidate) {
      throw new Error(`market_agent patch_state candidate '${id}' must keep its extracted kind.`);
    }
    if (!isDirectCandidate && !this.batchResolved) {
      throw new Error("market_agent patch_state requires semantic_match_batch to resolve the current product first unless its extracted kind was empty.");
    }
  }

  upsertApplied(item: ContractItem): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (id !== undefined) this.outstandingCandidateIds.delete(id);
    this.updateComplete();
  }

  resolved(result: SemanticMatchBatchToolResult, state: ContractState): void {
    if (this.batchResolved) throw new Error("semantic_match_batch may be called at most once for each product.");
    if (result.active_product_id !== this.activeProductId) {
      throw new Error("semantic_match_batch resolved a product other than the current extract_product result.");
    }
    const resolvedIds = new Set<string>();
    const extractedIds = new Set(this.candidateKinds.keys());
    const canonicalIds = stateIds(state);
    for (const entry of result.matched) {
      const id = String(entry.candidate.id);
      if (!extractedIds.has(id)) throw invalidFieldId(id);
      const canonicalId = String(entry.canonical_item_id);
      if (!canonicalIds.has(canonicalId)) throw invalidFieldId(canonicalId);
    }
    for (const entry of result.unmatched) {
      const id = String(entry.candidate.id);
      if (!extractedIds.has(id)) throw invalidFieldId(id);
    }
    for (const entry of [...result.matched, ...result.unmatched]) {
      const id = String(entry.candidate.id);
      if (!this.semanticCandidateIds.has(id)) {
        throw new Error(`semantic_match_batch candidate '${id}' was not eligible for matching in the current extract_product call.`);
      }
      if (resolvedIds.has(id)) throw new Error(`semantic_match_batch returned duplicate candidate '${id}'.`);
      resolvedIds.add(id);
    }
    if (resolvedIds.size !== this.semanticCandidateIds.size) {
      throw new Error("semantic_match_batch must resolve every candidate from each non-empty kind in the current extract_product call.");
    }
    for (const entry of result.unmatched) this.outstandingCandidateIds.add(String(entry.candidate.id));
    this.batchResolved = true;
    this.updateComplete();
  }

  private resetCandidates(): void {
    this.candidateKinds.clear();
    this.directPatchCandidateIds.clear();
    this.semanticCandidateIds.clear();
    this.outstandingCandidateIds.clear();
    this.batchResolved = false;
  }

  private updateComplete(): void {
    this.complete = this.batchResolved && this.outstandingCandidateIds.size === 0;
  }
}
