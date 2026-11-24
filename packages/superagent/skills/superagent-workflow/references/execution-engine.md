# DeepSeek Harness 团队筹备与右侧工作台

当前发行组合为持久编排引擎 Engine `0.16.0-dsh.1`、SuperAgent `1.21.0-dsh.1`、Super Teams `0.13.0-dsh.1`（适配 DeepSeek Harness `0.2.x`（Windows / macOS / Linux））。所有引擎状态、上下文库与产物快照统一持久存储在 `~/.dsh/profiles/desktop/plugin-data/dsh-super-teams/engine.sqlite`（SQLite WAL 模式），跨 DeepSeek Harness 重启后团队、DAG 进度、裁决账本与已冻结快照 100% 保留，无需外部后台服务或第二套手工任务板。

## 核心科学编排与强门禁能力（v0.16.0-dsh.1）

- **关键路径（CPM）与优先级调度**：调度器按 `priority`（`critical`/`high`/`normal`/`low`）→ 关键路径（`onCriticalPath`）→ 剩余加权深度 → 下游解锁数 → FIFO 自动排序，优先推进会阻塞下游的核心任务，缩短整体完工时间（makespan）。
- **`writeScopes` 双层强约束（运行时互斥锁 + 盘后越界拦截）**：
  1. **静态波次图提示**：通过 `engine_team({action:"graph", teamId})` 或工作台「执行波次图」查看拓扑波次、关键路径与同波次范围重叠提示；
  2. **运行时调度互斥锁（`write-scope-lock`）**：同一团队中声明重叠 `writeScopes` 的并行任务不会同时派发，后序任务自动进入 `等待同范围写入锁释放` 状态，待持锁任务完成后自动唤醒；
  3. **盘后工作区越界核验（`write_scope_guard`）**：任务结束时自动扫描任务工作区，若生成了落在声明 `writeScopes` 之外的新文件，验证直接判定失败并阻止自动放行。
- **行为级受控自动验收（`autoAccept: true` 强制 `node_test` 门禁）**：
  - 仅配置 `file_exists`、`file_contains`、`json_equals` 等静态检查的任务**禁止开启 `autoAccept: true`**（引擎直接报错拒绝），从源头拦截“生成了占位文件但功能未实现”的假阳性；
  - 开启 `autoAccept: true` 必须包含至少一条 `type: "node_test"` 可执行行为测试（可在 `prepare` 或 `engine_submit` 的 check 中直接内联传入 `testScript`，引擎自动登记 SHA-256 并以 `ELECTRON_RUN_AS_NODE=1` 纯 Node 模式运行断言），全部检查通过才自动冻结 SHA-256 快照并解锁下游波次。
- **瞬态失败指数退避重试（`maxRetries: 0..3`）**：仅对已知终态 `failed` 且非检查失败的瞬态错误自动指数退避重试，严禁对 `unknown` 未确认执行自动重跑。
- **团队决策账本（`kind: "ruling"`）与一键返工（`rework`）**：`engine_source({teamId, kind:"ruling", label, text})` 自动向后续同队任务注入架构/接口裁决；`engine_control({taskId, action:"rework", reason:"修改意见", expectedRevision})` 自动携带上轮失败检查明细打回重做。

延伸阅读：
- [注册检查、验收、冻结、导出与放弃未知任务](engine-acceptance.md)
- [DeepSeek Harness 原生子代理、会话树与模型允许列表](deepseek-harness.md)
- [概览、分页取证、任务控制与上下文预算](engine-evidence.md)
- [安装、诊断、备份与设计依据](engine-maintenance.md)

## 原生右侧团队工作台（双侧栏自适应）

本插件同时注入 DeepSeek Harness 官方右侧栏（`sidebarRightTabs`）与社区增强侧栏（`dsh-better-sidebar`），并在聊天输入框「＋」菜单提供一键打开入口：

1. **自动唤起**：在聊天中调用 `engine_team({action:"prepare", ...})` 或 `engine_workspace({teamId?})` 时，宿主会向当前会话推送 `open-workbench` 事件，客户端自动展开右侧「团队工作台」并定位到目标团队。
2. **手动唤起**：点击右侧栏「团队工作台」标签页，或从聊天框「＋」选择「SuperAgent 团队工作台」。
3. **主题与窄屏兼容**：工作台运行于独立 Shadow DOM 内，自动跟随 DeepSeek Harness 深色/浅色皮肤切换（亦支持手动切换「自动/深色/浅色」），内置 4 套科学建队模板、实时波次 DAG 图、产物在线预览与结果复制。

## 先筹备，再统一开工

1. **原子筹备（推荐）**：当成员与 DAG 任务明确时，调用一次 `engine_team({action:"prepare", requestId, name, goal, members, tasks})`：
   - 每项任务填写 `key, member, title, goal`，可选 `difficulty`（`low`/`medium`/`high`）、`dependsOn`（引用本计划 `key`）、`priority`、`writeScopes`、`autoAccept`、`maxRetries`、`checks`（`file_exists`、`file_contains`、`json_equals`、`node_test`；其中 `node_test` 支持内联 `testScript` 或引用已登记 `sourceId + sha256`）。
   - 一次可原子创建 1–24 项任务（初始为 `pause` 态）；任一字段或门禁校验失败则整批回滚不落库；相同 `requestId` 与参数重试幂等返回原团队。
2. **分步筹备**：也可先用 `engine_team({action:"create", ...})` 创建暂停态团队，再用 `engine_source` 登记长文本约束或共享测试脚本，随后调用 `engine_submit` 追加任务。
3. **统一开工与跨重启恢复**：
   - 调用 `engine_team({action:"resume", teamId})` 启动调度；
   - 用 `engine_overview({teamId, attentionOnly:true})`（或 `teams_engine({action:"overview", team_id: teamId})`）巡检需决策项，结合 `engine_evidence` 检查结果后调用 `engine_control({taskId, action:"accept"|"rework"})` 或 `engine_team({action:"accept_checked", teamId})` 收口；宿主重启后同样从该 `engine.sqlite` 直接恢复。
