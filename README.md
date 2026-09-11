# Shop Agent

Windows 上可直接交互的多 Agent TUI。主 Agent 负责理解和编排任务，独立子 Agent 负责完成聚焦工作；业务角色、Prompt 与 Python tools 集中在 `shop/` 中。

## 启动

新设备首次准备时，在项目根目录执行：

```powershell
uv sync --locked
Copy-Item .env.example .env
# 编辑 .env，填写 OPENCODE_API_KEY 和可选 Langfuse credentials

uvx --from huggingface-hub hf download Helios1208/taobao-product-context `
  --repo-type dataset `
  --local-dir data/taobao-product-context

.\start.ps1 -Check
.\start.ps1
```

```text
.env          本机 secrets/config，不提交
.env.example  配置模板，提交到 repo
```

项目使用 [uv](https://docs.astral.sh/uv/) 管理 Python 环境和依赖。运行时只使用 repo-local `.venv` 中的持久 Python Worker；`uv` 仅负责 setup 和依赖管理。

数据集配置统一位于 [`shop-agent.config.ts`](./shop-agent.config.ts) 的 `paths` 字段，运行时会自动解析为当前仓库的绝对路径，无需修改机器相关路径。

检查配置、`.venv`、Python 依赖、数据集和认证但不打开 TUI：

```powershell
.\start.ps1 -Check
```

不需要 npm 命令、编译或发布步骤。

## 常用入口

- [`shop/`](./shop/)：Shop Agent 业务 profiles、Prompt 与 Python tools。
- [`shop-agent.config.ts`](./shop-agent.config.ts)：项目配置入口。
- [`src/framework/`](./src/framework/)：通用 Agent framework。
- [`src/tui/`](./src/tui/)：终端交互界面。
- [`docs/usage.md`](./docs/usage.md)：命令与使用说明。
- [`docs/architecture.md`](./docs/architecture.md)：架构边界与运行流程。
- [`docs/backlog/`](./docs/backlog/)：明确暂缓的后续能力。

默认使用 `shop-agent.config.ts` 中 `runtime.llm.default` 配置的模型（当前为 `mimo-v2.5`），思考级别为 `off`。在 TUI 中输入 `/help` 查看命令，使用 `/model` 切换模型。

市场分析阶段使用 `shop-agent.config.ts` 中的固定 parquet 数据集和
`runtime.market.maxDistinctProducts`（默认值为 `5`）。结果缓存于 `.shop-agent/market-criteria/<node_id>/`：
先生成 `base.json`，再生成配置数量的 `products/<item_id>.json`，最后发布
`market.json`。已有 `market.json` 会直接复用；只有 `base.json` 时跳过标准
阶段。采样按 `rank` 升序、`item_id` 升序，`shopping_env({})` 取下一个商品，
按 `item_id` 重读不会推进游标。
