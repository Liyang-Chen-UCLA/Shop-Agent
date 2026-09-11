import assert from "node:assert/strict";
import test from "node:test";
import { MarketProductTransaction } from "../src/framework/subagents/market-product-transaction.ts";

const criterion = (id: string) => ({ id });
const attribute = (id: string) => ({ id });

test("patch accepts an id from the current extract_product result", () => {
  const transaction = new MarketProductTransaction();
  transaction.sampled("product-vibration");
  transaction.extracted("product-vibration", {
    criteria: [],
    attributes: [attribute("vibration")],
  }, { criteria: [], attributes: [] });

  assert.doesNotThrow(() => {
    transaction.assertPatchAllowed("attribute", attribute("vibration"), { criteria: [], attributes: [] });
  });
});

test("patch rejects an id absent from current get_state and extract_product", () => {
  const transaction = new MarketProductTransaction();
  transaction.sampled("product-vibration");
  transaction.extracted("product-vibration", {
    criteria: [],
    attributes: [attribute("vibration")],
  }, { criteria: [], attributes: [] });

  assert.throws(
    () => transaction.assertPatchAllowed("attribute", attribute("has_vibration"), { criteria: [], attributes: [] }),
    /Invalid market field id 'has_vibration'.\s+Expected an id from current get_state or extract_product\./,
  );
});

test("semantic match rejects source ids outside extract_product and target ids outside get_state", () => {
  const createTransaction = () => {
    const transaction = new MarketProductTransaction();
    transaction.sampled("product-semantic");
    transaction.extracted("product-semantic", {
      criteria: [],
      attributes: [attribute("vibration")],
    }, { criteria: [], attributes: [attribute("canonical-vibration")] });
    return transaction;
  };
  const match = (candidateId: string, canonicalId: string) => ({
    active_product_id: "product-semantic",
    matched: [{
      active_product_id: "product-semantic",
      candidate: attribute(candidateId),
      canonical_item_id: canonicalId,
      kind: "attribute" as const,
      matched: true,
      method: "id" as const,
    }],
    unmatched: [],
  });
  const state = { criteria: [], attributes: [attribute("canonical-vibration")] };

  assert.throws(
    () => createTransaction().resolved(match("has_vibration", "canonical-vibration"), state),
    /Invalid market field id 'has_vibration'/,
  );
  assert.throws(
    () => createTransaction().resolved(match("vibration", "invented-canonical"), state),
    /Invalid market field id 'invented-canonical'/,
  );
});

test("empty criteria and attribute kinds allow direct patching", () => {
  const transaction = new MarketProductTransaction();
  transaction.sampled("product-1");
  transaction.extracted("product-1", {
    criteria: [criterion("criterion-1")],
    attributes: [attribute("attribute-1")],
  }, { criteria: [], attributes: [] });

  transaction.assertPatchAllowed("criterion", criterion("criterion-1"), { criteria: [], attributes: [] });
  transaction.upsertApplied(criterion("criterion-1"));
  assert.equal(transaction.complete, false);
  transaction.assertPatchAllowed("attribute", attribute("attribute-1"), { criteria: [], attributes: [] });
  transaction.upsertApplied(attribute("attribute-1"));

  assert.equal(transaction.batchResolved, true);
  assert.equal(transaction.outstandingCandidateIds.size, 0);
  assert.equal(transaction.complete, true);
});

test("multiple candidates from one empty kind are all consumed before transaction completion", () => {
  const transaction = new MarketProductTransaction();
  transaction.sampled("product-2");
  transaction.extracted("product-2", {
    criteria: [criterion("criterion-1"), criterion("criterion-2")],
    attributes: [],
  }, { criteria: [], attributes: [attribute("existing-attribute")] });

  transaction.assertPatchAllowed("criterion", criterion("criterion-1"), { criteria: [], attributes: [attribute("existing-attribute")] });
  transaction.upsertApplied(criterion("criterion-1"));
  assert.deepEqual([...transaction.outstandingCandidateIds], ["criterion-2"]);
  assert.equal(transaction.complete, false);

  transaction.assertPatchAllowed("criterion", criterion("criterion-2"), { criteria: [], attributes: [attribute("existing-attribute")] });
  transaction.upsertApplied(criterion("criterion-2"));
  assert.equal(transaction.outstandingCandidateIds.size, 0);
  assert.equal(transaction.complete, true);
});

test("non-empty kinds still require semantic matching and unmatched patches", () => {
  const transaction = new MarketProductTransaction();
  transaction.sampled("product-3");
  transaction.extracted("product-3", {
    criteria: [criterion("new-criterion")],
    attributes: [],
  }, { criteria: [criterion("existing-criterion")], attributes: [] });

  assert.throws(
    () => transaction.assertPatchAllowed("criterion", criterion("new-criterion"), { criteria: [criterion("existing-criterion")], attributes: [] }),
    /requires semantic_match_batch/,
  );
  transaction.resolved({
    active_product_id: "product-3",
    matched: [],
    unmatched: [{
      active_product_id: "product-3",
      candidate: criterion("new-criterion"),
      kind: "criterion",
      matched: false,
    }],
  }, { criteria: [criterion("existing-criterion")], attributes: [] });
  assert.equal(transaction.complete, false);
  transaction.assertPatchAllowed("criterion", criterion("new-criterion"), { criteria: [criterion("existing-criterion")], attributes: [] });
  transaction.upsertApplied(criterion("new-criterion"));
  assert.equal(transaction.complete, true);
});

test("mixed extraction completes only after semantic and direct candidates are consumed", () => {
  const transaction = new MarketProductTransaction();
  transaction.sampled("product-4");
  transaction.extracted("product-4", {
    criteria: [criterion("direct-criterion")],
    attributes: [attribute("matched-attribute"), attribute("unmatched-attribute")],
  }, { criteria: [], attributes: [attribute("existing-attribute")] });

  transaction.resolved({
    active_product_id: "product-4",
    matched: [{
      active_product_id: "product-4",
      candidate: attribute("matched-attribute"),
      canonical_item_id: "existing-attribute",
      kind: "attribute",
      matched: true,
      method: "id",
    }],
    unmatched: [{
      active_product_id: "product-4",
      candidate: attribute("unmatched-attribute"),
      kind: "attribute",
      matched: false,
    }],
  }, { criteria: [], attributes: [attribute("existing-attribute")] });
  assert.deepEqual(
    [...transaction.outstandingCandidateIds].sort(),
    ["direct-criterion", "unmatched-attribute"],
  );

  transaction.assertPatchAllowed("attribute", attribute("unmatched-attribute"), { criteria: [], attributes: [attribute("existing-attribute")] });
  transaction.upsertApplied(attribute("unmatched-attribute"));
  assert.equal(transaction.complete, false);
  transaction.assertPatchAllowed("criterion", criterion("direct-criterion"), { criteria: [], attributes: [attribute("existing-attribute")] });
  transaction.upsertApplied(criterion("direct-criterion"));
  assert.equal(transaction.complete, true);
});
