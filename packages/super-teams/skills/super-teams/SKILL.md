---
name: super-teams
metadata:
  version: 0.13.0-dsh.1
  host: DeepSeek Harness
description: 在 DeepSeek Harness 中提供统一的 SQLite WAL 持久关键路径 DAG 编排引擎（0.16.0-dsh.1）与右侧团队工作台，内置行为测试自动验收门禁与写入范围运行时互斥锁，跨重启持久恢复。简单任务直接处理。
---

# Super Teams 持久编排引擎与工作台（0.13.0-dsh.1）

**职责边界（单一团队、单一持久状态源）**：
- `superagent-workflow` 负责目标拆解、选路方法与交付标准；
- `super-teams` 提供**唯一的团队持久状态库**（`~/.dsh/profiles/desktop/plugin-data/dsh-super-teams/engine.sqlite` WAL 模式 + `artifact-snapshots/` SHA-256 快照库）与右侧「团队工作台」。默认仅注册 **8 个统一工具**（7 个 `engine_*` 核心编排工具 + 1 个同源只读查询工具 `teams_engine`），避免两套任务板概念混用。

## 1. 标准筹备、锁保护与行为门禁流程

1. **原子筹备（`prepare`）**：
   - 调用 `engine_team({action:"prepare", requestId, name, goal, members, tasks})` 一次创建暂停态团队、成员与 1–24 项 DAG 任务，并在右侧栏自动打开「团队工作台」。
   - 为每项任务声明相对路径 `writeScopes`（例如 `["src/parser.mjs", "tests/parser.test.mjs"]`）与 `priority`（`critical`/`high`/`normal`/`low`）。
2. **`writeScopes` 运行时互斥锁 + 盘后越界拦截**：
   - 建队后可调 `engine_team({action:"graph", teamId})`（或 `teams_engine({action:"graph", team_id: teamId})`）查看拓扑波次、CPM 关键路径与并行范围重叠提示。
   - 即使两项同波次并行任务声明了重叠的 `writeScopes`，调度器也会在运行时自动施加**写入范围互斥锁**：先入任务执行期间，重叠任务自动处于 `blocked (write-scope-lock)` 等待锁释放，绝不并发互踩；且任务结束后引擎会扫描任务工作区，若生成了声明 `writeScopes` 之外的文件则直接触发 `write_scope_guard` 验证失败。
3. **`autoAccept: true` 强制可执行行为测试门禁**：
   - `file_exists`、`file_contains`、`json_equals` 仅可作为辅助结构检查，**单独使用此类静态检查开启 `autoAccept: true` 会被引擎直接拒绝**。
   - 若需中间波次自动冻结快照并放行下游，必须在任务 `checks` 中至少配置一条 `type: "node_test"` 可执行行为测试（支持直接在 check 内传入 `testScript: "const assert = require('node:assert/strict'); ..."`，引擎自动存入受信上下文库并在 `ELECTRON_RUN_AS_NODE=1` 下实跑校验退出码 0）。
4. **启动、裁决与返工收口**：
   - 调用 `engine_team({action:"resume", teamId})` 启动执行；跨成员共享接口裁决用 `engine_source({teamId, kind:"ruling", label, text})` 持久登记。
   - 用 `engine_overview({teamId, attentionOnly:true})` 巡检待决策项；对非自动验收任务核对 `engine_evidence` 后调用 `engine_control({taskId, action:"accept"|"rework"})` 或 `engine_team({action:"accept_checked", teamId})` 收口。

## 2. 跨会话 / 跨宿主重启持久恢复叙事

引擎所有元数据、事件序列、来源文本与产物快照均实时落盘在 `engine.sqlite`（SQLite WAL）中，**重启 DeepSeek Harness 不会丢失任何团队状态**：

1. 重启或新开聊天会话后，调用 `teams_engine({action:"list"})`（或 `engine_team({action:"list"})`）查看持久保存的团队列表，并用 `engine_workspace({teamId})` 在右侧栏打开该团队工作台。
2. 调用 `engine_overview({teamId, attentionOnly:true})` 查看中断前进度：已完成并 `accepted` 的上游快照直接复用、无需重跑；若存在重启中断导致的 `unknown` 未决任务，先调用 `engine_control({taskId, action:"reconcile"})` 只读对账会话日志，再按实际状态 `resume`、`retry` 或 `rework`。

## 3. 遗留 `.super-teams` 兼容说明（默认关闭）

早期项目目录 `<workspace>/.super-teams/teams.sqlite` 手工记板工具（`teams_create`、`teams_task_create` 等 7 个旧工具）默认**不注册**，确保新老用户面对唯一清晰的持久引擎入口。仅当维护历史遗留 `.super-teams` 仓库且显式设置插件配置 `enableLegacyBoard: true` 或环境变量 `DSH_SUPER_TEAMS_LEGACY=1` 时才会挂载旧工具（旧协议归档见 [任务包与结果包（兼容归档）](references/packets.md)）。宿主接线与架构依据见 [Harness 接线](references/deepseek-harness.md) 与 [来源与适配范围](references/research.md)。
