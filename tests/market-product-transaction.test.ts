import assert from "node:assert/strict";
import test from "node:test";
import { MarketProductTransaction } from "../src/framework/subagents/market-product-transaction.ts";

const criterion = (id: string) => ({ id });
const attribute = (id: string) => ({ id });

test("empty criteria and attribute kinds allow direct patching", () => {
  const transaction = new MarketProductTransaction();
  transaction.sampled("product-1");
  transaction.extracted("product-1", {
    criteria: [criterion("criterion-1")],
    attributes: [attribute("attribute-1")],
  }, { criteria: [], attributes: [] });

  transaction.assertUpsertAllowed("criterion", criterion("criterion-1"));
  transaction.upsertApplied(criterion("criterion-1"));
  assert.equal(transaction.complete, false);
  transaction.assertUpsertAllowed("attribute", attribute("attribute-1"));
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

  transaction.assertUpsertAllowed("criterion", criterion("criterion-1"));
  transaction.upsertApplied(criterion("criterion-1"));
  assert.deepEqual([...transaction.outstandingCandidateIds], ["criterion-2"]);
  assert.equal(transaction.complete, false);

  transaction.assertUpsertAllowed("criterion", criterion("criterion-2"));
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
    () => transaction.assertUpsertAllowed("criterion", criterion("new-criterion")),
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
  });
  assert.equal(transaction.complete, false);
  transaction.assertUpsertAllowed("criterion", criterion("new-criterion"));
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
  });
  assert.deepEqual(
    [...transaction.outstandingCandidateIds].sort(),
    ["direct-criterion", "unmatched-attribute"],
  );

  transaction.assertUpsertAllowed("attribute", attribute("unmatched-attribute"));
  transaction.upsertApplied(attribute("unmatched-attribute"));
  assert.equal(transaction.complete, false);
  transaction.assertUpsertAllowed("criterion", criterion("direct-criterion"));
  transaction.upsertApplied(criterion("direct-criterion"));
  assert.equal(transaction.complete, true);
});
