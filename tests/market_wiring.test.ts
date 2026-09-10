import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/framework/config.ts";
import { discoverPythonTools } from "../src/framework/python-tools.ts";
import { discoverNativeTools } from "../src/framework/native-tools.ts";
import { composeSystemPrompt } from "../src/framework/system-prompt.ts";
import { createDelegationTool } from "../src/framework/subagents/tool.ts";

const cwd = path.resolve(import.meta.dirname, "..");

test("wires the narrow market profile, repo skill, dataset config, and tools", async () => {
  const config = await loadConfig(cwd);
  assert.deepEqual(config.paths, {
    dataset: "data/taobao-product-context/data/products.parquet",
    runtimeData: ".shop-agent",
  });
  assert.equal(config.datasetPath, path.resolve(cwd, "data/taobao-product-context/data/products.parquet"));
  assert.equal(config.dataDirectory, path.resolve(cwd, ".shop-agent"));
  assert.equal(config.maxDistinctProducts, 5);
  const market = config.agents.find((agent) => agent.id === "market_agent");
  assert.ok(market);
  const research = config.agents.find((agent) => agent.id === "research_agent");
  assert.equal(research?.timeoutMs, 600_000);
  assert.match(research?.systemPrompt ?? "", /Direction is always a JSON object, never a bare string/);
  assert.match(research?.systemPrompt ?? "", /"type":"larger_better"/);
  assert.match(research?.systemPrompt ?? "", /"type":"target_range","unit":"小时"/);
  assert.match(research?.systemPrompt ?? "", /"type":"partial_order","better_than"/);
  assert.match(research?.systemPrompt ?? "", /attributes use the same common\/type-specific fields but must omit `direction` entirely/i);
  assert.equal(research?.outputValidator, undefined);
  assert.equal(research?.outputSchema, undefined);
  assert.deepEqual(research?.tools, ["web_search", "get_state", "patch_state", "finalize_state", "report_developer_issue"]);
  assert.ok(research?.contractState);
  assert.doesNotMatch(composeSystemPrompt(research!), /submit the final structured result using the `submit_result` tool/);
  assert.match(research?.systemPrompt ?? "", /call `finalize_state`/);
  assert.doesNotMatch(research?.systemPrompt ?? "", /submit the final structured result using the `submit_result` tool/);
  const routeAgent = config.agents.find((agent) => agent.id === "route_agent");
  assert.equal(routeAgent?.model, undefined);
  assert.equal(routeAgent?.thinking, undefined);
  assert.match(routeAgent?.systemPrompt ?? "", /submitted\s+result must use exactly this wrapper/);
  assert.match(routeAgent?.systemPrompt ?? "", /"results": \[\s+\{\s+"product": "\.\.\."/);
  assert.match(routeAgent?.systemPrompt ?? "", /even when there is only one product/i);
  assert.match(routeAgent?.systemPrompt ?? "", /When complete, call `submit_result` with the final result/);
  assert.match(routeAgent?.systemPrompt ?? "", /resolved_nodes.*candidates.*children/s);
  assert.match(routeAgent?.systemPrompt ?? "", /exactly `node_id`, `node_name`, and `node_path`/);
  assert.match(routeAgent?.systemPrompt ?? "", /never copy `parent_id`, `level`/);
  const orchestrator = config.agents.find((agent) => agent.id === "orchestrator");
  assert.match(orchestrator?.systemPrompt ?? "", /exactly one research-agent delegation in that user turn/);
  assert.match(orchestrator?.systemPrompt ?? "", /do not manually call `delegate_agent` for `research_agent` again in the same turn/);
  assert.equal(market?.webSearchPolicy, "market");
  assert.equal(market?.model, undefined);
  assert.equal(market?.thinking, undefined);
  assert.equal(market?.outputValidator, undefined);
  assert.equal(market?.outputSchema, undefined);
  assert.deepEqual(market?.tools, ["shopping_env", "extract_product", "semantic_match_batch", "get_state", "patch_state", "finalize_state", "web_search", "report_developer_issue"]);
  assert.ok(market?.contractState);
  assert.deepEqual(market?.contractState?.runtimeItemDefaults, { observed_product_ids: [] });
  assert.deepEqual(market?.contractState?.runtimeMutableFields, ["aliases", "observed_product_ids"]);
  assert.match(market?.systemPrompt ?? "", /one-product transaction/i);
  assert.match(market?.systemPrompt ?? "", /extract_product/);
  assert.match(market?.systemPrompt ?? "", /semantic_match_batch/);
  assert.match(market?.systemPrompt ?? "", /call `finalize_state`/);
  assert.doesNotMatch(market?.systemPrompt ?? "", /submit the final structured result/);
  assert.doesNotMatch(composeSystemPrompt(market!), /submit_result/);
  assert.match(market?.skillPrompt ?? "", /Product transaction/);
  assert.match(market?.skillPrompt ?? "", /extract_product/);
  assert.match(market?.skillPrompt ?? "", /semantic_match_batch/);
  assert.match(market?.skillPrompt ?? "", /finalize_state/);
  assert.doesNotMatch(market?.skillPrompt ?? "", /market_alignment|observed_product_count|web_evidence/);
  assert.doesNotMatch(composeSystemPrompt(market!), /submit_result/);

  const definitions = await discoverPythonTools(cwd, ["shop/tools"]);
  assert.ok(definitions.has("load_base"));
  assert.ok(definitions.has("shopping_env"));
  assert.equal(definitions.get("shopping_env")?.inputSchema.additionalProperties, false);
  const shoppingInput = definitions.get("shopping_env")?.inputSchema as { properties?: Record<string, unknown> };
  assert.deepEqual(shoppingInput.properties, {});
  assert.doesNotMatch(definitions.get("shopping_env")?.description ?? "", /reread/);
  assert.match(definitions.get("shopping_env")?.description ?? "", /extract_product/);
  const shoppingOutput = definitions.get("shopping_env")?.outputSchema as { properties?: Record<string, { description?: string }> };
  assert.match(shoppingOutput.properties?.dataset_category?.description ?? "", /extract_product/);
  assert.match(shoppingOutput.properties?.sample_index?.description ?? "", /sample_limit/);
  assert.ok(discoverNativeTools().has("extract_product"));
  assert.ok(discoverNativeTools().has("semantic_match_batch"));
  assert.equal(discoverNativeTools().has("semantic_match"), false);
});

test("does not permit direct get or run delegation to the internal market stage", async () => {
  const config = await loadConfig(cwd);
  const delegation = createDelegationTool(config.agents, {} as any, () => ({}));
  await assert.rejects(
    () => delegation.execute("market-get", { action: "get", agent: "market_agent" }),
    /internal stage/,
  );
  await assert.rejects(
    () => delegation.execute("market-run", { action: "run", agent: "market_agent", task: "{}" }),
    /internal stage/,
  );
});
