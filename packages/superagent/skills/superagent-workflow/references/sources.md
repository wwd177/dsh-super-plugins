# 来源与设计取舍

SuperAgent（`1.21.0-dsh.1`）与持久编排引擎（`0.16.0-dsh.1` / Super Teams `0.13.0-dsh.1`）融合了多智能体软件工程实践与 DeepSeek Harness（`deepseek-ai/deepseek-harness`）的 Cordis 插件化宿主设计：

- **单一持久状态源与关键路径调度**：参考关键路径法（CPM）与开源多代理任务系统（`obra/superpowers`、`gastownhall/beads`、`BloopAI/vibe-kanban`、`eyaltoledano/claude-task-master`），统一由 `engine.sqlite`（SQLite WAL）跨重启持久保存团队、拓扑波次、关键路径排序与 `ruling` 决策账本，收敛工具表面（默认隐藏旧手工记板，仅保留 7 个 `engine_*` + 1 个只读 `teams_engine`），消除双状态分裂。
- **行为级验收与运行时写入锁**：强制 `autoAccept: true` 必须绑定至少一条可执行 `node_test`（支持内联 `testScript`），拒绝 `file_exists`/`file_contains` 浅层假阳性；将 `writeScopes` 从静态图告警升级为调度器运行时互斥锁（`write-scope-lock`）+ 盘后越界产物拦截（`write_scope_guard`）。
- **DeepSeek Harness 原生融合与诚实边界**：直接构建在宿主 `ToolsService`、`SubagentRuntime`、`WebServer`（`connection.requestRejection` 同源鉴权）及双右侧栏之上，采用 `~/.dsh` 全自包含实体文件安装；客观检查、工作区范围扫描与 SHA-256 硬链接防御快照不等同于操作系统内核级沙箱或主观业务质量保证，最终整合与生产入口验收仍由主线负责。
