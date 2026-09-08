import { defineConfig } from "./src/framework/index.ts";
import { agents } from "./shop/agents.ts";

export default defineConfig({
  defaultModel: "mimo-v2.5",
  defaultThinking: "off",
  orchestrator: "orchestrator",
  agents,
  toolDirectories: ["shop/tools"],
  paths: {
    dataset: "data/taobao-product-context/data/products.parquet",
    runtimeData: ".shop-agent",
  },
  maxDistinctProducts: 5,
});
