# DeepSeek Harness 原生子代理与会话接线

本文说明 SuperAgent（`1.21.0-dsh.1`）与 Super Teams（`0.13.0-dsh.1` / Engine `0.16.0-dsh.1`）在 DeepSeek Harness（`0.2.x` 通用版）中的宿主原生能力边界、模型路由规则与会话关联方式。

## 1. 两种分工粒度（职责正交，单一持久状态源）

1. **SQLite WAL 持久引擎编排（`engine_*` + 只读 `teams_engine`，所有多成员/多波次任务唯一持久入口）**：
   - 状态实时写入 `~/.dsh/profiles/desktop/plugin-data/dsh-super-teams/engine.sqlite`（跨重启完整保留），不再维护第二套项目手工记板。
   - 引擎通过宿主 `ctx.subagents.startActivation({ provider: "spawn", delivery: "caller", ... })` 在当前活跃根会话下创建隔离上下文子代理；重叠 `writeScopes` 由调度器互斥锁（`write-scope-lock`）串行保护，越界产物由盘后校验（`write_scope_guard`）拦截。
   - 每个任务尝试拥有独立工作目录（`workspaces/<taskId>/<attemptId>`），上游已验收依赖的冻结快照与团队 `ruling`/来源自动物化到该目录并校验 SHA-256；`autoAccept: true` 强制要求通过至少一条 `node_test` 行为测试。
2. **宿主原生工具临时直调（`subagent` / `subagent_fork`，仅限当轮无需持久状态的小型并行勘查或评审）**：
   - `subagent`：默认独立上下文（不复制母会话冗长历史），必须显式传入当前目标、最新授权/纠正、负责文件与验收标准。
   - `subagent_fork`：继承母会话已有上下文，仅在短消息和文件引用确实不足以传达背景时使用。
   - 协同控制：用 `list_agents` 查看协作者名称，用 `send_message` 发送补充指令，用 `wait_agent` 等待结果，用 `interrupt_agent` 请求停止在途子代理。

## 2. 模型与推理强度适配原则

- **绝不改动主会话设置**：主代理的模型与推理强度始终由用户在界面手动选择。
- **严守会话子代理允许列表（`subagentModelSelectionPolicy`）**：
  - 当会话未设置额外允许列表时，引擎与子代理严格沿用当前根会话选定的 `provider/model`。
  - 当会话已授权多模型允许列表时，`low` 难度任务可优先选用列表中存在的轻量模型（如 `deepseek-flash`、`qwen3.8-flash` 等），`medium`/`high` 选用主力推理模型。
- **推理强度（`reasoningEffort`）自动预检回退**：
  - 引擎在派发前调用宿主 `llm.resolveCallConfig` 预检，若目标模型不支持显式 `reasoningEffort` 档位则自动省略该字段，避免因协议差异导致 400 报错。

## 3. 会话关联、重启恢复与安全停止边界

- 从主聊天调用 `engine_team`、`engine_submit` 或 `engine_workspace` 时，引擎自动记录当前根会话 ID；从右侧「团队工作台」直接新建或启动团队时，前端自动附带当前侧栏所属的 `sessionId`。
- 宿主重启后，通过 `teams_engine({action:"list"})` 或工作台即可直接恢复同一份 `engine.sqlite` 持久团队；未决运行态任务先调 `engine_control({taskId, action:"reconcile"})` 只读对账会话日志。
- 暂停或取消运行中的任务会调用宿主 `subagents.interrupt` 与 `dispose`，但取消信号被受理并不等同于外部子进程已立即停写；重新分配同一写入范围前仍须核实无残留写入。
