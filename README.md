# Shop Agent

Windows 上可直接交互的多 Agent TUI。主 Agent 负责理解和编排任务，独立子 Agent 负责完成聚焦工作；业务角色、Prompt 与 Python tools 集中在 `shop/` 中。

## 启动

先确保系统环境变量中存在 `OPENCODE_API_KEY`，然后打开一个新的 PowerShell：

```powershell
.\start.ps1
```

### Python 环境

Python 默认使用 PATH 中的 `python`。如需切换 Python 环境，可设置项目环境变量，或仅为本次启动传入路径。项目会优先使用配置文件中的 `python.executable`，其次使用 `SHOP_AGENT_PYTHON`，最后回退到 PATH 中的 `python`。

当前已知的项目环境有以下两个，请按所在机器的实际路径二选一：

- `D:\App\miniforge3\envs\shop-agent\python.exe`
- `F:\Anaconda3\envs\shop-agent\python.exe`

例如，在当前机器上使用 `F:` 盘环境：

```powershell
$env:SHOP_AGENT_PYTHON = "F:\Anaconda3\envs\shop-agent\python.exe"
.\start.ps1

# 或
.\start.ps1 -Python "F:\Anaconda3\envs\shop-agent\python.exe"
```

安装 Python tools 依赖时，请使用同一个解释器：

```powershell
$env:SHOP_AGENT_PYTHON = "F:\Anaconda3\envs\shop-agent\python.exe"
& $env:SHOP_AGENT_PYTHON -m pip install -r shop\requirements.txt
```

检查配置但不打开 TUI：

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

默认使用 OpenCode Go 的 `muse-spark-1.2-contributor`。在 TUI 中输入 `/help` 查看命令，使用 `/model` 切换模型。

市场分析阶段使用 `shop-agent.config.ts` 中的固定 parquet 数据集和
`maxDistinctProducts`（默认值为 `5`）。结果缓存于 `.shop-agent/market-criteria/<node_id>/`：
先生成 `base.json`，再生成配置数量的 `products/<item_id>.json`，最后发布
`market.json`。已有 `market.json` 会直接复用；只有 `base.json` 时跳过标准
阶段。采样按 `rank` 升序、`item_id` 升序，`shopping_env({})` 取下一个商品，
按 `item_id` 重读不会推进游标。
