import { defineConfig } from "./src/framework/index.ts";
import { agents } from "./shop/agents.ts";

export default defineConfig({
  orchestrator: "orchestrator",
  agents,
  toolDirectories: ["shop/tools"],
});
