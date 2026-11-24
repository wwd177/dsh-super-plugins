# DeepSeek Harness 原生接线（Super Teams 0.13.0-dsh.1 / Engine 0.16.0-dsh.1）

本包基于 DeepSeek Harness `0.2.x`（Windows / macOS / Linux） 原生 `ctx.tools.register`、`ctx.subagents` 与 `ctx.webServer` 接口运行，无需启动外部 MCP 子进程或后台守护程序。所有状态持久存储于 `~/.dsh/profiles/desktop/plugin-data/dsh-super-teams/engine.sqlite`（SQLite WAL 模式）及 `artifact-snapshots/` 快照目录，重启桌面端后状态完整保留。

## 默认工具矩阵（共 8 个原生工具，单一持久状态源）

1. **`engine_workspace`**：绑定当前活跃根会话并在右侧栏自动展开「团队工作台」（同时兼容官方 `sidebarRightTabs` 与 `dsh-better-sidebar`）。
2. **`engine_team`**：`prepare`（1–24 项 DAG 任务原子筹备，支持内联 `node_test.testScript`）、`create`、`list`、`overview`（支持 `attentionOnly`）、`graph`（CPM 关键路径波次与 `writeScopes` 重叠检测）、`accept_checked`（批量验收已通过检查的任务）、`pause`、`resume`、`cancel`、`archive`、`unarchive`。
3. **`engine_submit`**：向已有团队追加单条任务（同样支持 `writeScopes`、内联 `testScript` 与行为门禁校验）。
4. **`engine_overview`**：按 UTF-8 字节预算分页读取团队或任务决策摘要。
5. **`engine_control`**：`inspect`、`pause`、`resume`、`cancel`、`retry`、`rework`（打回返工并自动附带失败检查明细）、`verify`、`accept`、`freeze`、`reconcile`（重启/中断后只读对账）、`abandon`。
6. **`engine_source`**：登记团队上下文约束、`ruling` 架构/接口裁决账本或独立受信测试脚本。
7. **`engine_evidence`**：按字节偏移分页读取经 SHA-256 校验的任务结果或来源原文。
8. **`teams_engine`**：面向同一 `engine.sqlite` 持久引擎的只读快捷视图（支持 `action: "list" | "overview" | "graph" | "task" | "evidence" | "events"`），标记 `store: "engine.sqlite"` 与 `audit_independence: "same_engine_store"`，供习惯 `teams_*` 查询语义的流程零歧义读取同一份持久状态。

> 兼容选项：旧版项目目录 `.super-teams/teams.sqlite` 的 7 个手工记板工具默认隐藏；仅当显式开启 `enableLegacyBoard: true` 或 `DSH_SUPER_TEAMS_LEGACY=1` 时才会额外挂载。

## 强约束门禁与诚实边界

- **`autoAccept` 行为门禁**：开启 `autoAccept: true` 必须包含至少一条 `node_test` 行为测试；仅靠 `file_exists` / `file_contains` / `json_equals` 静态检查会被引擎拒绝，且测试退出码非 0 绝不自动冻结放行。
- **`writeScopes` 双层门禁与 OS 边界**：调度器在派发层对重叠 `writeScopes` 施加运行时互斥锁（`write-scope-lock`），并在每个子代理独立工作目录完结后通过 `verifyArtifacts` 拦截声明范围外的新增产物（`write_scope_guard`）；但 Node 子进程执行并非操作系统内核沙箱，若任务被授予宿主全盘写工具且绕过自身工作目录直写外部绝对路径，仍需由主线在最终集成时把关。
- **真实用量统计**：仅在能从宿主会话事件取得真实调用统计时记录 `usage`；缺失记未知，不从字符数推算 Token 或费用。
