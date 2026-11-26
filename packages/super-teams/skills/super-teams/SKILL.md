---
name: super-teams
metadata:
  version: 0.15.0-dsh.1
  host: DeepSeek Harness
description: SuperAgent 内置审阅工作台与共享持久内核（Engine 0.18.0-dsh.1 / Shared Core 0.18.0）：提供目标原话必达门禁、不可变交付候选与绑定批准、增量集成修订、基线漂移试合、只读 GitHub PR 对账及会话隔离右侧工作台。简单任务直接处理。
---

# Super Teams 审阅工作台与共享引擎内核（0.15.0-dsh.1）

**职责边界（单产品单入口、单一调度所有者）**：
- 对外统一为 **SuperAgent**，`superagent-workflow` 负责执行协议与目标验收标准；
- `super-teams` 负责**审阅、人工干预右侧工作台与共享持久数据目录**（`~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/`，默认 profile 为 `desktop`，搭载与 Codex 字节级锁定的共享 `engine-core 0.18.0`），同数据目录单一调度所有者，支持 `criteria_*`、`candidate_*`、`publish_reconcile`、`pr_reconcile` 等全部 v0.18 动作。默认仅注册 **8 个统一工具**（7 个 `engine_*` 核心工具 + 1 个同源只读查询工具 `teams_engine`），避免两套任务板概念混用。

## 1. 标准筹备、Git Worktree 协作与行为门禁流程

1. **原子筹备（支持隔离目录与 Git Worktree 双模式）**：
   - 调用 `engine_team({action:"prepare", requestId, name, goal, members, tasks, workspaceMode?, repoPath?})` 一次创建暂停态团队、成员与 1–24 项 DAG 任务，并在**当前会话**的右侧栏打开「团队工作台」（多聊天严格按 `sessionId` 隔离，聊天 B 不会串切聊天 A 已挂载的工作台）。
   - **Git Worktree 模式**：在工具中传入 `workspaceMode: "git-worktree"` 与本地 Git 仓库 `repoPath`，或直接在右侧工作台「新建团队」表单中将工作区模式切换为 **「Git Worktree（真实仓库隔离分支）」** 并填写仓库路径（自动尝试带入当前会话 `cwd`）。引擎建队即固定 `baseCommit`，为每次尝试分配独立 detached worktree，下游自动按拓扑顺序重放上游全部传递闭环已验收补丁。
   - 为每项任务声明相对路径 `writeScopes`（例如 `["src/parser.mjs", "tests/parser.test.mjs"]`）与 `priority`（`critical`/`high`/`normal`/`low`）。
2. **`writeScopes` 运行时互斥锁 + 盘后越界拦截**：
   - 建队后可调 `engine_team({action:"graph", teamId})`（或 `teams_engine({action:"graph", team_id: teamId})`）查看拓扑波次、CPM 关键路径与并行范围重叠提示。
   - 同波次重叠 `writeScopes`（以及启用了范围治理的团队内未声明范围的任务）由调度器自动施加运行时互斥锁（`write-scope-lock`）串行排队；验收阶段在隔离模式下执行测前/测后目录扫描，在 `git-worktree` 模式下封存 `candidateCommit` 并对 `<attemptStartCommit>..<candidateCommit>` 做双树 `--raw --find-renames -z` 审计，拦截任何越界修改、重命名、删除、符号链接或 Windows 目录联结（`write_scope_guard`）。
3. **分级可执行行为测试门禁（`node_test` vs `command_test`）**：
   - `file_exists`、`file_contains`、`json_equals` 仅作辅助结构检查，**单独使用此类静态检查开启 `autoAccept: true` 会被引擎直接拒绝**。
   - **`node_test`（支持 `autoAccept: true`）**：支持在 check 中直接内联 `testScript` 或引用已登记 `sourceId + sha256`，引擎将其固化在不可变上下文库并在独立 `.git`-free 导出目录中以 `ELECTRON_RUN_AS_NODE=1` 运行断言；开启 `autoAccept: true` 必须至少配有一条 `node_test`。
   - **`command_test`（多语言结构化测试门禁）**：支持 `node --test`、`pytest`、`python/python3 -m pytest|unittest`、`cargo test`、`go test`、`dotnet test`、`npm test` / `npm run test[:*]`，拒绝危险 eval/preload 参数、路径穿越与零用例假绿；通过后停在 `checked`，须由调用方显式 `accept` / `accept_checked` 放行。
4. **启动、返工与 Git 原子合并发布**：
   - 调用 `engine_team({action:"resume", teamId})` 启动执行；跨成员共享接口裁决用 `engine_source({teamId, kind:"ruling", label, text})` 持久登记。
   - 用 `engine_overview({teamId, attentionOnly:true})` 巡检待决策项；对非自动验收任务核对 `engine_evidence` 后调用 `engine_control({taskId, action:"accept"|"rework"})` 或 `engine_team({action:"accept_checked", teamId})` 收口。
   - 对 `git-worktree` 团队，可在工具或工作台概览中调用 `engine_team({action:"merge_preview", teamId})` 预览拓扑补丁重放结果，再调用 `engine_team({action:"merge_apply", teamId, branchName?, integrationCheck?})` 原子创建全新 `superagent/<slug>` 分支（create-only，绝不改写当前活工作树或已有分支）；导出 ZIP 同时包含 `DELIVERY.md`、`HANDOFF.md` 与 `artifacts/<taskId>/changes.patch`。

## 2. 跨重启持久恢复与完整备份目录边界（重要）

引擎持久化分布在 **`~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/` 整个数据目录**内（默认 profile 为 `desktop`），重启 DeepSeek Harness 不会丢失任何团队状态：

- `engine.sqlite`（及运行期 `engine.sqlite-wal`、`engine.sqlite-shm`）：仅存储团队/成员/任务元数据、revision、事件序列与快照/补丁索引；
- `artifact-snapshots/`：存放所有已验收任务的不可变 SHA-256 冻结文件快照与完整结果文本；
- `git-patches/`：存放 `git-worktree` 模式已验收任务的 SHA-256 校验增量 `changes.patch`；
- `context/`：存放通过 `engine_source` 登记的长文本约束、`ruling` 裁决与不可变 `node_test` 脚本；
- `attempts/`（及历史 `workspaces/`）：存放尚未冻结或进行中的任务工作区与执行日志。

> **备份警告：绝不能只复制 `engine.sqlite`！** 仅复制 `engine.sqlite` 会丢失所有已冻结交付文件（`artifact-snapshots/`）、Git 补丁（`git-patches/`）与登记来源（`context/`），恢复后将无法导出成果包或重放补丁。进行迁移或手动备份前，请先关闭 DeepSeek Harness（确保 WAL 已落盘）并**完整复制整个 `plugin-data/dsh-super-teams/` 目录**。

重启或新开聊天会话后的恢复步骤：
1. 调用 `teams_engine({action:"list"})`（或 `engine_team({action:"list"})`）查看持久保存的团队列表，并用 `engine_workspace({teamId})` 在当前会话右侧栏打开该团队工作台。
2. 调用 `engine_overview({teamId, attentionOnly:true})` 查看中断前进度：已完成并 `accepted` 的上游快照/补丁直接复用、无需重跑；若存在重启中断导致的 `unknown` 未决任务，先调用 `engine_control({taskId, action:"reconcile"})` 只读对账会话日志，再按实际状态 `resume`、`retry` 或 `rework`。

## 3. 遗留 `.super-teams` 兼容说明（默认关闭）

早期项目目录 `<workspace>/.super-teams/teams.sqlite` 手工记板工具（`teams_create`、`teams_task_create` 等 7 个旧工具）默认**不注册**，确保新老用户面对唯一清晰的持久引擎入口。仅当维护历史遗留 `.super-teams` 仓库且显式设置插件配置 `enableLegacyBoard: true` 或环境变量 `DSH_SUPER_TEAMS_LEGACY=1` 时才会挂载旧工具（旧协议归档见 [任务包与结果包（兼容归档）](references/packets.md)）。宿主接线与架构依据见 [Harness 接线](references/deepseek-harness.md) 与 [来源与适配范围](references/research.md)。
