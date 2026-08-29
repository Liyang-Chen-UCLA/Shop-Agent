# Shop Agent

Windows 上可直接交互的多 Agent TUI。主 Agent 负责理解和编排任务，独立子 Agent 负责完成聚焦工作；业务角色、Prompt 与 Python tools 集中在 `shop/` 中。

## 启动

先确保系统环境变量中存在 `OPENCODE_API_KEY`，然后打开一个新的 PowerShell：

```powershell
.\start.ps1
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
