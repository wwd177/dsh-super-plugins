# DeepSeek Harness 团队筹备与右侧工作台

当前发行组合为持久编排引擎 Engine `0.17.1-dsh.1`、SuperAgent `1.22.1-dsh.1`、Super Teams `0.14.1-dsh.1`（适配 DeepSeek Harness `0.2.x`，Windows / macOS / Linux）。所有引擎状态、上下文库、Git 增量补丁与不可变产物快照统一持久存储在 `~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/`（默认 profile 为 `desktop`，包含 `engine.sqlite` WAL 数据库及 `artifact-snapshots/`、`git-patches/`、`context/`、`attempts/` 子目录），跨 DeepSeek Harness 重启后团队、DAG 进度、裁决账本、补丁与已冻结快照 100% 保留，无需外部后台服务或第二套手工任务板。

## 核心科学编排、Git Worktree 与强门禁能力（v0.17.1-dsh.1）

- **双工作区模式（隔离目录 + 强化 `git-worktree` 模式）**：
  - `workspaceMode: "isolated"`（默认）：为每项任务创建独立隔离目录，并按冻结快照物化上游依赖文件；
  - `workspaceMode: "git-worktree"` + `repoPath`：建队时锁定本地 Git 仓库的 `baseCommit`，每项尝试在独立 detached worktree 中工作；依赖任务自动计算传递祖先闭环并按拓扑顺序重放上游已验收 `changes.patch`；支持 `merge_preview`（临时 detached staging worktree 预览冲突与 diffStat）与 `merge_apply`（原子 create-only 创建全新 `superagent/<slug>` 分支，绝不触碰用户当前活工作树或已有分支）。
- **关键路径（CPM）与优先级调度**：调度器按 `priority`（`critical`/`high`/`normal`/`low`）→ 关键路径（`onCriticalPath`）→ 剩余加权深度 → 下游解锁数 → FIFO 自动排序，优先推进会阻塞下游的核心任务，缩短整体完工时间（makespan）。
- **`writeScopes` 全链路强约束（运行时互斥锁 + 双重/双树越界拦截）**：
  1. **静态波次图提示**：通过 `engine_team({action:"graph", teamId})` 或工作台「执行波次图」查看拓扑波次、关键路径与同波次范围重叠提示；
  2. **运行时调度互斥锁（`write-scope-lock`）**：同一团队中声明重叠 `writeScopes` 的并行任务（及开启范围治理团队中未声明范围的任务）不会同时派发，自动进入 `等待同范围写入锁释放` 排队；
  3. **盘后越界核验（`write_scope_guard`）**：隔离模式下执行测前/测后双重工作区扫描；`git-worktree` 模式下以独立临时索引封存 `candidateCommit` 并对 `<attemptStartCommit>..<candidateCommit>` 做双树 `--raw --find-renames -z` 审计，拦截越界修改、重命名、删除、符号链接与 Windows 目录联结。
- **分级行为验收门禁（`node_test` + 多语言 `command_test`）**：
  - 仅配置 `file_exists`、`file_contains`、`json_equals` 等静态检查的任务**禁止开启 `autoAccept: true`**（引擎直接报错拒绝）；
  - 开启 `autoAccept: true` 必须包含至少一条不可变 `type: "node_test"` 行为断言（支持内联 `testScript` 或 `sourceId + sha256`，自动在 `.git`-free 导出目录中以 `ELECTRON_RUN_AS_NODE=1` 实跑）；
  - 多语言项目支持 `type: "command_test"`（`node --test`、`pytest`、`python -m pytest|unittest`、`cargo test`、`go test`、`dotnet test`、`npm test` / `npm run test[:*]`），拒绝危险注入标志与零用例假绿；通过后停在 `checked`，需显式 `accept` / `accept_checked` 复核放行。
- **瞬态失败指数退避重试（`maxRetries: 0..3`）**：仅对已知终态 `failed` 且非检查失败的瞬态错误自动指数退避重试，严禁对 `unknown` 未确认执行自动重跑。
- **团队决策账本（`kind: "ruling"`）与一键返工（`rework`）**：`engine_source({teamId, kind:"ruling", label, text})` 自动向后续同队任务注入架构/接口裁决；`engine_control({taskId, action:"rework", reason:"修改意见", expectedRevision})` 自动携带上轮失败检查明细打回重做。

延伸阅读：
- [注册检查、验收、冻结、导出与放弃未知任务](engine-acceptance.md)
- [DeepSeek Harness 原生子代理、会话树与模型允许列表](deepseek-harness.md)
- [概览、分页取证、任务控制与上下文预算](engine-evidence.md)
- [安装、诊断、完整备份与维护](engine-maintenance.md)

## 原生右侧团队工作台（双侧栏自适应 + 多聊天严格隔离）

本插件同时注入 DeepSeek Harness 官方右侧栏（`sidebarRightTabs`）与社区增强侧栏（`dsh-better-sidebar`），并在聊天输入框「＋」菜单提供一键打开入口：

1. **会话级自动唤起（杜绝双聊天串切）**：在聊天中调用 `engine_team({action:"prepare", ...})` 或 `engine_workspace({teamId?})` 时，宿主推送带 `sessionId` 的 `open-workbench` 事件。服务端（`/api/stream?sessionId=`、`/api/changes?sessionId=`）、宿主壳层（`client.js` 按 `sessionId` 维护独立焦点映射并定向打开目标会话侧栏）与工作台（`app.js`）三层均校验 `sessionId`，确保聊天 B 打开自己的团队时，**绝不会串切聊天 A 已挂载的团队工作台**。
2. **手动建队与 Git Worktree 表单入口**：点击右侧栏「新建团队」即可在标准建队弹窗中直接选择工作区模式（**「隔离工作目录」** 或 **「Git Worktree（真实仓库隔离分支）」**）并填写本地 Git 仓库路径（切换为 Git 模式时自动尝试填充当前活跃会话的 `cwd`）。`git-worktree` 团队概览自动显示 `Git Worktree` 徽标、`baseCommit` / 最近发布分支，并提供「预览 Git 合并」与「原子发布到新分支」交互入口。
3. **主题与窄屏兼容**：工作台运行于独立 Shadow DOM 内（Constructable `CSSStyleSheet`），自动跟随 DeepSeek Harness 深色/浅色皮肤切换（亦支持手动切换「自动/深色/浅色」），内置 4 套科学建队模板、实时波次 DAG 图、产物在线预览、结果复制与 ZIP（含 `DELIVERY.md` + `HANDOFF.md` + `changes.patch`）导出。

## 先筹备，再统一开工

1. **原子筹备（推荐）**：当成员与 DAG 任务明确时，调用一次 `engine_team({action:"prepare", requestId, name, goal, members, tasks, workspaceMode?, repoPath?})`：
   - 每项任务填写 `key, member, title, goal`，可选 `difficulty`（`low`/`medium`/`high`）、`dependsOn`（引用本计划 `key`）、`priority`、`writeScopes`、`autoAccept`、`maxRetries`、`checks`（`file_exists`、`file_contains`、`json_equals`、`node_test`、`command_test`）。
   - 一次可原子创建 1–24 项任务（初始为 `pause` 态）；任一字段或门禁校验失败则整批回滚不落库；相同 `requestId` 与参数重试幂等返回原团队。
2. **分步筹备**：也可先用 `engine_team({action:"create", workspaceMode?, repoPath?, ...})` 或侧栏「新建团队」创建暂停态团队，再用 `engine_source` 登记长文本约束或共享测试脚本，随后调用 `engine_submit` 追加任务。
3. **统一开工、验收与合并收口**：
   - 调用 `engine_team({action:"resume", teamId})` 启动调度；
   - 用 `engine_overview({teamId, attentionOnly:true})`（或 `teams_engine({action:"overview", team_id: teamId})`）巡检需决策项，结合 `engine_evidence` 检查结果后调用 `engine_control({taskId, action:"accept"|"rework"})` 或 `engine_team({action:"accept_checked", teamId})` 收口；
   - `git-worktree` 团队最后调用 `merge_preview` + `merge_apply` 发布全新 `superagent/<slug>` 分支并做目标仓库终检。
