# 团队状态、证据与上下文预算（DeepSeek Harness）

## 唯一持久状态入口与同源视图边界

多成员编排模式下，团队、成员、任务、依赖、裁决账本与产物快照唯一持久保存在 DeepSeek Harness 插件数据目录 `~/.dsh/profiles/desktop/plugin-data/dsh-super-teams/engine.sqlite`（SQLite WAL 模式，跨宿主重启完整保留）。默认使用 `engine_overview`、`engine_evidence` 与 `engine_control` 推进，不再另建 `.super-teams` 副本镜像同一团队。`teams_engine` 读取的是同一个 `engine.sqlite` 持久库（标记 `store: "engine.sqlite"`、`audit_independence: "same_engine_store"`），不构成第二份独立验证证据，修改操作统一通过 `engine_team` / `engine_control` 执行。

每个任务 attempt 拥有独立工作目录及经 SHA-256 校验的原文与上游依赖快照；非 `critical` 普通文档超出预算时保留前缀，日志类（`log`/`stdout`/`stderr`）采用 20%/80% 头尾节选并标注省略字节区间，子代理可通过目录内 `context-sources/read-source.cjs` 或主线 `engine_evidence` 分页核验全文。团队级 `kind:"ruling"` 裁决与 `critical:true` 约束自动附带。

必传内容超过 16 KiB 预算时会拒绝派发并返回 `budgetDetails`（`budgetBytes`、`requiredBytes`、`overByBytes` 与 `budgetBreakdown`）；此时应拆分任务或收敛必传项，不裁剪关键验收标准硬绕上限。真实 token 用量仅取自宿主会话事件，缺失记未知，不按字节换算。

## 概览、取证与控制入口

- `engine_workspace({teamId?})`：绑定当前活跃根会话并自动唤起 DeepSeek Harness 右侧「团队工作台」定位到该团队。
- `engine_team`：支持 `prepare`、`create`、`list`、`overview`（支持 `attentionOnly:true`）、`graph`（拓扑波次、CPM 关键路径、`writeScopes` 并行重叠告警）、`accept_checked`（一键批量验收已通过检查的任务）、`pause`、`resume`、`cancel`、`archive`、`unarchive`。
- `engine_overview({teamId?, attentionOnly?, cursor?, limit?, budgetBytes?})`：按 UTF-8 字节窗口返回任务摘要与 `needsDecision`/`nextStep` 决策提示。
- `engine_evidence({kind:"result"|"source", id, teamId?, offset?, limit?})`：分页读取并校验 SHA-256 的任务结果或原始来源，避免将大日志全量灌入主会话。
- `engine_control`：
  - `inspect`：返回 16 KiB 有界检查摘要（区分宿主完成状态、程序检查与调用方验收）；
  - `pause` / `resume` / `cancel`：控制单任务并请求中断在途子代理（中断受理不等于外部子进程已确认停写）；
  - `rework`：携带 `reason`（评审修改意见）与上轮失败检查明细打回重做；
  - `verify`：在已知终态尝试上重跑已登记客观检查（`node_test` 自动启用 `ELECTRON_RUN_AS_NODE=1` 纯 Node 模式运行）；
  - `accept` / `freeze`：复核产物无篡改后冻结硬链接防御（`nlink === 1`）的 SHA-256 快照（参数详见 [注册检查与验收](engine-acceptance.md)）；
  - `reconcile` / `abandon`：只读核对 `unknown` 未决子代理会话日志，或在保留占槽告警的前提下结束业务跟进。

## 快照配额与健康横幅

快照默认配额为单任务最多 128 个登记产物、单文件 64 MiB、单快照总量 256 MiB、清单 1 MiB；`json_equals` 与 `file_contains` 单文件上限 1 MiB（更大产物可登记受信 `node_test`）。`systemHealthBanner` 汇总全局 `unresolvedSlotsUsed` 与快照磁盘占用（约 60 秒异步缓存），便于及时发现未决执行。
