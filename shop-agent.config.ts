import { defineConfig } from "./src/framework/index.ts";
import { agents } from "./shop/agents.ts";

export default defineConfig({
  orchestrator: "orchestrator",
  agents,
  toolDirectories: ["shop/tools"],
  paths: {
    dataset: "data/taobao-product-context/data/products.parquet",
    runtimeData: ".shop-agent",
  },
  runtime: {
    llm: {
      default: {
        model: "mimo-v2.5",
        thinking: "off",
      },

      agents: {
        orchestrator: {},
        route_agent: {},
        research_agent: {},
        market_agent: {},
        delegate: {},
      },

      tools: {
        webSearch: {
          model: "mimo-v2.5",
          thinking: "off",
        },
        productExtractor: {
          model: "hy3",
          thinking: "off",
        },
      },

      eval: {
        semanticMatcher: {},
        definitionJudge: {},
      },
    },

    timeout: {
      subagentDefaultMs: 120_000,
      agents: {
        market_agent: 900_000,
      },
    },

    market: {
      maxDistinctProducts: 1,
    },
  },
});
