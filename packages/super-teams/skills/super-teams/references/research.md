# 来源与适配范围（0.14.1-dsh.1）

本包将 SQLite WAL 持久科学编排引擎（`0.17.1-dsh.1`）与右侧团队工作台（`0.14.1-dsh.1`）原生适配至 DeepSeek Harness `0.2.x`（Windows / macOS / Linux）（官方仓库 `https://github.com/deepseek-ai/deepseek-harness`，兼容 `>=0.2.0-rc.1 <0.3.0-0` 全平台版本）：

- **宿主接口依据**：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`（纯 JSON Schema 无损投影校验与 `isConcurrencySafe`）、`@deepseek-ai/dsh-subagent`（`spawn` 进程内隔离上下文子代理与 `delivery:"caller"` 结算回执）、`@deepseek-ai/dsh-host-webserver`（`connection.requestRejection` 同源请求栅栏）、`@deepseek-ai/dsh-client-ui-sidebar-right` 及社区 `dsh-better-sidebar` 双侧栏扩展接口。
- **v0.17.1-dsh.1 架构演进与门禁强化**：
  1. **单一持久数据目录**：默认暴露 8 个统一工具（7 个 `engine_*` + 只读同源视图 `teams_engine`），元数据落盘 `engine.sqlite`（WAL），冻结产物、增量补丁与登记来源落盘同目录 `artifact-snapshots/`、`git-patches/`、`context/`、`attempts/`；旧 `.super-teams` 写工具仅在 `DSH_SUPER_TEAMS_LEGACY=1` 兼容模式下启用。
  2. **强化 `git-worktree` 协作 + 侧栏建队/合并 UI**：支持工具与右侧栏标准表单直接创建 `git-worktree` 团队，提供传递闭环补丁重放、双树 diff `writeScopes` 审计、`.git`-free 导出验证以及 `merge_preview` / `merge_apply` 原子分支发布。
  3. **分级行为测试门禁**：`autoAccept: true` 严格绑定不可变 `ContextStore` 托管的 `node_test`；多语言结构化 `command_test` 门禁提供 `checked` 态复核保护并拦截危险参数与零用例假绿。
  4. **三层会话隔离与全自包含打包**：服务端 SSE/changes、`client.js` 与 `app.js` 三层按 `sessionId` 隔离防止双聊天串切；插件与技能以无软链实体目录安装于 `~/.dsh` 内。
- **验证边界说明**：本机单元测试、跨重启持久化测试、真实 DSH 原生管线集成检查与 Chromium 工作台冒烟测试用于证明协议、权限栅栏、调度状态机与 UI 交互正确，不等同于特定业务提示词下的模型推理质量或操作系统内核沙箱隔离。
