# 来源与适配范围（0.13.0-dsh.1）

本包将 SQLite WAL 持久科学编排引擎（`0.16.0-dsh.1`）与右侧团队工作台（`0.13.0-dsh.1`）原生适配至 DeepSeek Harness `0.2.x`（Windows / macOS / Linux）（官方仓库 `https://github.com/deepseek-ai/deepseek-harness`，兼容 `>=0.2.0-rc.1 <0.3.0-0` 全平台版本）：

- **宿主接口依据**：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`（纯 JSON Schema 无损投影校验与 `isConcurrencySafe`）、`@deepseek-ai/dsh-subagent`（`spawn` 进程内隔离上下文子代理与 `delivery:"caller"` 结算回执）、`@deepseek-ai/dsh-host-webserver`（`connection.requestRejection` 同源请求栅栏）、`@deepseek-ai/dsh-client-ui-sidebar-right` 及社区 `dsh-better-sidebar` 双侧栏扩展接口。
- **v0.16.0-dsh.1 架构收敛与门禁强化**：
  1. **单一持久状态源**：默认暴露 8 个统一工具（7 个 `engine_*` + 只读同源视图 `teams_engine`），统一落盘 `engine.sqlite`（WAL）跨重启持久恢复；旧 `.super-teams` 写工具仅在 `DSH_SUPER_TEAMS_LEGACY=1` 兼容模式下启用。
  2. **`autoAccept` 行为测试强门禁**：禁止仅靠 `file_exists`/`file_contains`/`json_equals` 开启 `autoAccept: true`，强制要求至少一条 `node_test`（支持内联 `testScript` 并在 `ELECTRON_RUN_AS_NODE=1` 下执行）。
  3. **`writeScopes` 双重强约束**：调度器运行时互斥锁（`write-scope-lock`）防止并发互踩 + 盘后工作区越界文件扫描拦截（`write_scope_guard`）。
  4. **全自包含打包**：插件与技能全部以实体目录安装于 `~/.dsh` 内，消除开发目录软链与路径分裂。
- **验证边界说明**：本机单元测试、跨重启持久化测试、真实 DSH 原生管线集成检查与 Chromium 工作台冒烟测试用于证明协议、权限栅栏、调度状态机与 UI 交互正确，不等同于特定业务提示词下的模型推理质量或操作系统内核沙箱隔离。
