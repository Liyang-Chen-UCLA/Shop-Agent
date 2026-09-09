import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/framework/config.ts";
import { discoverPythonTools } from "../src/framework/python-tools.ts";
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
  assert.deepEqual(research?.outputValidator, { id: "criteria_v1" });
  assert.match(composeSystemPrompt(research!), /submit the final structured result using the `submit_result` tool/);
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
  assert.deepEqual(market?.outputValidator, { id: "market_v1" });
  assert.deepEqual(market?.tools, ["load_base", "shopping_env", "web_search", "report_developer_issue"]);
  assert.match(market?.systemPrompt ?? "", /exactly these seven top-level keys/);
  assert.match(market?.systemPrompt ?? "", /Every product object has exactly four keys/);
  assert.match(market?.systemPrompt ?? "", /copy the exact\s+`dataset_category` value returned by the first `shopping_env` response/);
  assert.match(market?.systemPrompt ?? "", /Never use the\s+taxonomy route's `node\.name`\/`node_name` as `dataset_category`/);
  assert.match(market?.systemPrompt ?? "", /never stop after four products/i);
  assert.match(market?.systemPrompt ?? "", /tool error is not a\s+sample/);
  assert.match(market?.systemPrompt ?? "", /tool accepts no arguments: every advancing call must be exactly\s+`shopping_env\(\{\}\)`/);
  assert.doesNotMatch(market?.systemPrompt ?? "", /reread/);
  assert.match(market?.systemPrompt ?? "", /each value should\s+explicitly include `raw_value`,\s+`normalized_value`,\s+`unit`,\s+`qualifier`,\s+`evidence`,\s+and\s+`ocr_page_id`/);
  assert.match(composeSystemPrompt(market!), /submit the final structured result using the `submit_result` tool/);
  assert.match(market?.skillPrompt ?? "", /market-alignment/);
  assert.match(market?.skillPrompt ?? "", /Copy the exact\s+`dataset_category` returned by `shopping_env`/);
  assert.match(market?.skillPrompt ?? "", /do not finalize with only four products/i);
  assert.match(market?.skillPrompt ?? "", /tool accepts no arguments: every advancing call must be exactly\s+`shopping_env\(\{\}\)`/);
  assert.doesNotMatch(market?.skillPrompt ?? "", /reread/);
  assert.match(market?.skillPrompt ?? "", /exactly seven top-level keys/);
  assert.match(market?.skillPrompt ?? "", /exactly four required keys/);
  assert.match(market?.skillPrompt ?? "", /both extraction arrays must be present,\s+even\s+when empty/);
  assert.match(composeSystemPrompt(market!), /added_from_market/);

  const definitions = await discoverPythonTools(cwd, ["shop/tools"]);
  assert.ok(definitions.has("load_base"));
  assert.ok(definitions.has("shopping_env"));
  assert.equal(definitions.get("shopping_env")?.inputSchema.additionalProperties, false);
  const shoppingInput = definitions.get("shopping_env")?.inputSchema as { properties?: Record<string, unknown> };
  assert.deepEqual(shoppingInput.properties, {});
  assert.doesNotMatch(definitions.get("shopping_env")?.description ?? "", /reread|item_id/);
  assert.match(definitions.get("shopping_env")?.description ?? "", /copy the returned dataset_category exactly/);
  const shoppingOutput = definitions.get("shopping_env")?.outputSchema as { properties?: Record<string, { description?: string }> };
  assert.match(shoppingOutput.properties?.dataset_category?.description ?? "", /copy verbatim/);
  assert.match(shoppingOutput.properties?.sample_index?.description ?? "", /until this equals sample_limit/);
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
