---
name: superagent-workflow
metadata:
  version: 1.21.0-dsh.1
  host: DeepSeek Harness
description: 负责复杂任务的目标拆解、证据驱动选路、行为测试门禁设计与最终集成验收；需要多成员依赖编排时，交由 Super Teams 统一 SQLite 持久引擎与右侧团队工作台执行。单一简单任务直接处理。
---

# SuperAgent 协作与交付（DeepSeek Harness 适配版 · 1.21.0-dsh.1）

让用户以最少注意力获得经过真实行为核验的交付。**职责分工**：本技能定义**目标拆解、选路诊断、验收门禁与最终整合方法论**；多成员持久任务图与右侧「团队工作台」统一由 `super-teams` 的 **SQLite WAL 持久编排引擎（`engine.sqlite`）** 承载，不存在第二套手工镜像板。能力、权限与模型范围以当前 DeepSeek Harness 会话为准。

## 1. 先定边界与最小行为验证

- 明确使用者、最终交付、可观察行为条件及必须保留项；信息足够就推进，仅询问会改变结果的缺口。关机、发布、交易按当前请求确认。
- 先用最小完整闭环验证关键路线（输入 → 动作 → 真实行为结果）；失败后依据新证据换路，不盲目同条件重试。复杂诊断读 [证据驱动的选路](references/reasoning.md)。
- **开发查源码优先 GitHub**：查实现、接口或上游修复时，优先定位公开组件的 GitHub 官方仓库对应 tag/commit 的源码与测试，再用本机 schema 与回归验证适用性（仅检索公开信息，私密日志与凭据留本地）。

## 2. 选择执行模式（简单任务直接做，复杂任务单一持久引擎）

- **直接执行**：简单、紧耦合或单轮闭环可完成的任务，不建队、不读多余参考。
- **轻量原生子代理勘查**：仅需当前回合内短暂并行只读勘查或独立评审、无需跨重启持久任务图时，使用宿主原生 `subagent`（默认独立上下文，显式传入最小任务包与最新授权/纠正；仅在确需继承母会话历史时才用 `subagent_fork`），配合 `send_message`、`wait_agent`、`list_agents`、`interrupt_agent`。详见 [协作与评审](references/collaboration.md) 与 [Harness 原生接线](references/deepseek-harness.md)。
- **统一 SQLite 持久引擎模式（多成员依赖编排唯一入口）**：
  - 建队调用 `engine_team({action:"prepare", requestId, name, goal, members, tasks})` 一次原子写入 `engine.sqlite`（WAL 模式持久落盘，**跨宿主重启完整保留团队、波次进度、裁决与 SHA-256 快照**），并在右侧栏自动展开「团队工作台」。详见 [团队筹备与右侧工作台](references/execution-engine.md)。
  - **`writeScopes` 双重写入锁**：为每项任务声明相对 `writeScopes`；调度器在运行时自动对重叠范围加互斥锁（并发冲突任务自动进入 `write-scope-lock` 排队等待），且任务完成后自动核验工作区，任何落在声明 `writeScopes` 之外的新增产物文件直接判定 `write_scope_guard` 失败。
  - **`autoAccept: true` 强制行为测试门禁**：仅含 `file_exists`、`file_contains`、`json_equals` 等静态浅检查的任务**严禁开启 `autoAccept: true`**（引擎直接拒绝）；开启自动放行必须至少配有一条 `node_test` 可执行行为断言（支持在 `prepare`/`engine_submit` 的 check 中直接内联 `testScript`，自动注入受信快照执行），杜绝“文件生成了但功能是空壳”的假阳性冻结。
  - 确认 `engine_team({action:"graph", teamId})` 波次与关键路径合理后调用 `engine_team({action:"resume", teamId})` 启动；跨成员接口/架构裁决写入 `engine_source({teamId, kind:"ruling", label, text})`；重启恢复或巡检统一调 `engine_overview({teamId, attentionOnly:true})`（或只读同源视图 `teams_engine`）。

## 3. 模型、子代理边界与引擎强校验

- **主模型不动，子模型严守允许列表**：保留用户手选的主会话模型与推理强度；子代理默认继承当前会话 `provider/model`，仅在会话允许列表（`subagentModelSelectionPolicy`）授权时为简单任务选用轻量 `flash/lite/mini` 模型，并自动预检推理强度支持情况，绝不改写全局配置或凭据。
- **引擎强校验边界**：
  - 预算以 UTF-8 字节计，超限时按分项账单拆解；`critical:true` 来源逐字保留。
  - 宿主子代理完成、程序检查（无 checks 保持 `not_verified`）与调用方 `accept`（冻结 `nlink === 1` 的 SHA-256 独立文件快照）三者独立判断；接受宿主失败的产物须显式 `acknowledgeHostFailure:true` + 理由。
  - 产物不满意时用 `engine_control({taskId, action:"rework", reason:"修改意见", expectedRevision})` 打回返工（自动附带上轮失败检查明细），避免另起孤立任务。
  - 重启后遇到未知态任务先只读 `reconcile` 对账，不可盲重跑；确需结束业务跟进时用 `abandon`（带理由与证据）。细节见 [验收与未知任务](references/engine-acceptance.md) 与 [概览与证据](references/engine-evidence.md)。

## 4. 证据验收与集成收口

- 沿「输入 → 生效规则 → 生产入口 → 输出 → 消费者」定位首次偏差并修源头；复杂根因与回归按需用 [workflow-quality](../workflow-quality/SKILL.md)。
- 多成员改动需整合进目标项目时，按 [最终集成](references/integration.md) 落实唯一整合负责人与目标目录终检；子任务隔离工作区的 `accepted` 快照不替代目标项目最终集成验证。
- 用真实生产入口验收（图片/页面实际查看，测试使用隔离数据）；大日志与媒体原件落盘，回包仅附摘要、产物版本、检查证据与风险，真实 token 用量缺失记未知、不按字符换算。
- 跨轮长任务用 [development-handoff](../development-handoff/SKILL.md) 维护紧凑交接；上下文与运行等待恢复见 [运行恢复](references/runtime-recovery.md)。维护与架构说明见 [安装与维护](references/engine-maintenance.md) 及 [来源与取舍](references/sources.md)。
