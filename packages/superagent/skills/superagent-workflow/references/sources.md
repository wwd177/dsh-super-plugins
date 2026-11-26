# 来源与设计取舍

SuperAgent（`1.22.1-dsh.1`）与持久编排引擎（`0.17.1-dsh.1` / Super Teams `0.14.1-dsh.1`）融合了多智能体软件工程实践与 DeepSeek Harness（`deepseek-ai/deepseek-harness`）的 Cordis 插件化宿主设计：

- **单一持久数据目录与关键路径调度**：参考关键路径法（CPM）与开源多代理任务系统（`obra/superpowers`、`gastownhall/beads`、`BloopAI/vibe-kanban`、`eyaltoledano/claude-task-master`），统一由 `plugin-data/dsh-super-teams/`（`engine.sqlite` WAL + `artifact-snapshots/` + `git-patches/` + `context/` + `attempts/`）跨重启持久保存团队、拓扑波次、关键路径排序与 `ruling` 决策账本，收敛工具表面（默认隐藏旧手工记板，仅保留 7 个 `engine_*` + 1 个只读 `teams_engine`），消除双状态分裂。
- **强化 `git-worktree` 协作、分级行为门禁与运行时写入锁**：支持隔离目录与 `git-worktree` 双模式（工具参数或侧栏标准建队表单均可直建，配合 `merge_preview` / `merge_apply` 原子发布全新 `superagent/<slug>` 分支）；`autoAccept: true` 严格绑定不可变 `ContextStore` 托管的 `node_test`，多语言 `command_test` 停在 `checked` 供显式复核；`writeScopes` 同时具备运行时互斥锁与双树 diff / 测前测后越界拦截。
- **DeepSeek Harness 原生融合与多聊天隔离**：直接构建在宿主 `ToolsService`、`SubagentRuntime`、`WebServer`（`connection.requestRejection` 同源鉴权）及双右侧栏之上，并在服务端 SSE/changes、`client.js` 与 `app.js` 三层实施 `sessionId` 严格隔离，采用 `~/.dsh` 全自包含实体文件安装；客观检查、工作区范围扫描与 SHA-256 快照不等同于操作系统内核级沙箱或主观业务质量保证，最终整合与生产入口验收仍由主线负责。
