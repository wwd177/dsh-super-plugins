---
name: superagent-workflow
metadata:
  version: 1.23.0-dsh.1
  host: DeepSeek Harness
description: 负责复杂任务的目标拆解、原话必达门禁冻结（R2）、不可变交付候选与增量修订编排（R3-R6）、只读 GitHub PR 对账（R7-R8）及最终集成验收；多成员编排运行在 SuperAgent 统一共享持久内核（Engine 0.18.0-dsh.1）与内置审阅工作台。单一简单任务直接处理。
---

# SuperAgent 协作与交付（DeepSeek Harness 适配版 · 1.23.0-dsh.1）

让用户以最少注意力获得经过真实行为核验的交付。**产品定位（v0.18 单入口收敛）**：对外统一为 **SuperAgent**，`superagent-workflow` 负责执行协议与目标验收方法论，`Super Teams` 作为内置审阅与人工干预工作台，共用同一锁定版本的共享候选内核 `engine-core 0.18.0`（Engine `0.18.0-dsh.1`）与单一调度所有者，不存在第二套手工镜像板。能力、权限与模型范围以当前 DeepSeek Harness 会话为准。

## 1. 先定边界与最小行为验证

- 明确使用者、最终交付、可观察行为条件及必须保留项；信息足够就推进，仅询问会改变结果的缺口。关机、发布、交易按当前请求确认。
- 先用最小完整闭环验证关键路线（输入 → 动作 → 真实行为结果）；失败后依据新证据换路，不盲目同条件重试。复杂诊断读 [证据驱动的选路](references/reasoning.md)。
- **开发查源码优先 GitHub**：查实现、接口或上游修复时，优先定位公开组件的 GitHub 官方仓库对应 tag/commit 的源码与测试，再用本机 schema 与回归验证适用性（仅检索公开信息，私密日志与凭据留本地）。

## 2. 选择执行模式（简单任务直接做，复杂任务单一持久引擎）

- **直接执行**：简单、紧耦合或单轮闭环可完成的任务，不建队、不读多余参考。
- **轻量原生子代理勘查**：仅需当前回合内短暂并行只读勘查或独立评审、无需跨重启持久任务图时，使用宿主原生 `subagent`（默认独立上下文，显式传入最小任务包与最新授权/纠正；仅在确需继承母会话历史时才用 `subagent_fork`），配合 `send_message`、`wait_agent`、`list_agents`、`interrupt_agent`。详见 [协作与评审](references/collaboration.md) 与 [Harness 原生接线](references/deepseek-harness.md)。
- **统一 SQLite 持久引擎模式（多成员依赖编排唯一入口）**：
  - **支持两种工作区模式**：
    1. `workspaceMode: "isolated"`（默认隔离沙盒目录）：适合调研、文档、原型或非 Git 项目；
    2. `workspaceMode: "git-worktree"` + `repoPath`（强化的 Git Worktree 协作模式）：面向真实本地 Git 仓库，建队即固定 `baseCommit`，每个任务在独立 detached worktree 中开发，下游自动按拓扑顺序重放全部上游传递闭环补丁；可通过 `engine_team({action:"prepare"|"create", workspaceMode:"git-worktree", repoPath, ...})` **或直接在右侧「团队工作台」的「新建团队」表单中选择「Git Worktree（真实仓库隔离分支）」并填写仓库路径**创建。
  - **原子筹备与会话隔离**：调用 `engine_team({action:"prepare", requestId, name, goal, members, tasks, workspaceMode?, repoPath?})` 一次原子落盘并在当前会话的右侧栏展开「团队工作台」；多聊天并行时严格按 `sessionId` 隔离路由，不会把聊天 B 的团队串切到聊天 A 已挂载的面板。详见 [团队筹备与右侧工作台](references/execution-engine.md)。
  - **`writeScopes` 双重写入锁与双树 Diff 审计**：为每项任务声明相对 `writeScopes`；调度器在运行时对重叠范围自动施加互斥锁（`write-scope-lock`）。任务完成后，隔离目录模式做测前/测后目录扫描，`git-worktree` 模式以独立临时索引封存 `candidateCommit` 并对 `<attemptStartCommit>..<candidateCommit>` 做双树 `--raw --find-renames -z` 审计，拦截越界修改、重命名、删除、符号链接与 Windows 目录联结（`write_scope_guard`）。
  - **分级行为测试门禁（`node_test` vs `command_test`）**：
    - `node_test`（不可变受信 CommonJS 断言，支持内联 `testScript` 或 `sourceId+sha256`）：在独立 `.git`-free 导出目录中运行，退出码 0 方可放行；**开启 `autoAccept: true` 必须至少包含一条 `node_test`**（仅用 `file_exists`、`file_contains`、`json_equals` 或 `command_test` 开启自动验收会被引擎拒绝）。
    - `command_test`（多语言结构化测试门禁，支持 `node --test`、`pytest`、`python -m pytest|unittest`、`cargo test`、`go test`、`dotnet test`、`npm test` / `npm run test[:*]`）：在 `.git`-free 导出目录运行并拦截零用例假绿与危险注入标志；通过后进入 `checked` 状态，须由主线/人工显式 `accept` / `accept_checked` 验收，防止仓库内测试脚手架自改放行。
  - 确认 `engine_team({action:"graph", teamId})` 波次与关键路径合理后调用 `engine_team({action:"resume", teamId})` 启动；跨成员接口/架构裁决写入 `engine_source({teamId, kind:"ruling", label, text})`；重启恢复或巡检统一调 `engine_overview({teamId, attentionOnly:true})`（或只读同源视图 `teams_engine`）。

## 3. 模型、子代理边界与引擎强校验

- **主模型不动，子模型严守允许列表**：保留用户手选的主会话模型与推理强度；子代理默认继承当前会话 `provider/model`，仅在会话允许列表（`subagentModelSelectionPolicy`）授权时为简单任务选用轻量 `flash/lite/mini` 模型，并自动预检推理强度支持情况，绝不改写全局配置或凭据。
- **引擎强校验边界**：
  - 预算以 UTF-8 字节计，超限时按分项账单拆解；`critical:true` 来源逐字保留。
  - 宿主子代理完成、程序检查（无 checks 保持 `not_verified`）与调用方 `accept`（冻结 `nlink === 1` 的 SHA-256 独立文件快照；`git-worktree` 模式同步持久化 SHA-256 校验的 `changes.patch`）三者独立判断；接受宿主失败的产物须显式 `acknowledgeHostFailure:true` + 理由。
  - 产物不满意时用 `engine_control({taskId, action:"rework", reason:"修改意见", expectedRevision})` 打回返工（自动附带上轮失败检查明细），避免另起孤立任务。
  - 重启后遇到未知态任务先只读 `reconcile` 对账，不可盲重跑；确需结束业务跟进时用 `abandon`（带理由与证据）。细节见 [验收与未知任务](references/engine-acceptance.md) 与 [概览与证据](references/engine-evidence.md)。

## 4. 证据验收、Git 合并与完整备份提醒

- 沿「输入 → 生效规则 → 生产入口 → 输出 → 消费者」定位首次偏差并修源头；复杂根因与回归按需用 [workflow-quality](../workflow-quality/SKILL.md)。
- **目标项目集成与 v0.18 冻结交付候选（R2–R8）**：
  - 建队筹备期可用 `engine_team({action:"criteria_preview"|"criteria_freeze", ...})` 冻结用户原话与必达清单，任何未映射的原话段落都会显式暴露，禁止空测试/跳过（`skipped`/`neutral`）或待签认满足必达项；
  - `git-worktree` 团队用 `engine_team({action:"candidate_create", ...})` 生成抗 GC 的不可变冻结候选（含 `treeOid`/`commitOid`/`manifestHash`），再经 `candidate_approve` + `candidate_publish_local` 严格按绑定候选发布本地 `superagent/<slug>` 分支（批准 A 绝不能漂移发布 A+B，崩溃后用 `publish_reconcile` 精确对账，绝不改动活工作树或既有分支）；
  - 远端/集成发现接口冲突时，保留原已验收任务快照不变，用 `engine_submit({revisionOfCandidateId, affectedTaskIds, ...})` 新建集成修订 `R1`，再生成 `C2 = C1 + R1.patch`（增量叠加并校验与全量重放同树）；用 `candidate_base_drift` 三方试合检测目标分支前进冲突；用 `pr_reconcile` 只读关联核实 GitHub PR（严格零写请求，远端合入事实与本地目标验收分离呈现）。详见 [最终集成](references/integration.md)。
  - 无论隔离模式还是 `git-worktree` 模式，子任务 `accepted` 快照均不替代目标项目最终集成行为终检。
- **完整备份警告（切勿只复制 `engine.sqlite`）**：`engine.sqlite` 仅保存元数据、事件序列与状态索引，真实交付产物快照、Git 增量补丁、登记来源与运行目录分别落盘在 `artifact-snapshots/`、`git-patches/`、`context/` 与 `attempts/`。迁移或备份历史交付时**必须完整备份整个 `~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/` 目录**（含 `engine.sqlite` 及其 `-wal`/`-shm` 文件），仅复制 `engine.sqlite` 会丢失所有已冻结交付文件与补丁。详见 [安装、诊断与完整备份](references/engine-maintenance.md)。
- 跨轮长任务用 [development-handoff](../development-handoff/SKILL.md) 维护紧凑交接；上下文与运行等待恢复见 [运行恢复](references/runtime-recovery.md)。来源与取舍见 [来源与取舍](references/sources.md)。
