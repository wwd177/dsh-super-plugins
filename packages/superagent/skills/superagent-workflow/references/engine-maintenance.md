# 安装、诊断、备份与维护（DeepSeek Harness 版）

## 架构概览

DeepSeek Harness 适配版（Engine `0.16.0-dsh.1` / SuperAgent `1.21.0-dsh.1` / Super Teams `0.13.0-dsh.1`）采用宿主原生 Cordis 插件架构与 `~/.dsh` 全自包含安装布局：

- `@local/dsh-superagent-menu`（`1.21.0-dsh.1`）：提供聊天「＋」菜单快捷入口（插入 `/superagent-workflow`）及方法论技能包（`superagent-workflow`、`workflow-quality`、`development-handoff`）。
- `@local/dsh-super-teams`（`0.13.0-dsh.1`）：在宿主进程内挂载 SQLite WAL 持久编排引擎 `Engine 0.16.0-dsh.1`、`DshAdapter`、8 个默认原生工具（7 个 `engine_*` + 只读同源视图 `teams_engine`）与 `/superagent-engine/*` 鉴权路由，并在官方右侧栏（`sidebarRightTabs`）及 `dsh-better-sidebar` 同时注册「团队工作台」面板。

## 自包含目录位置与持久数据策略

- **自包含插件包目录**：`~/.dsh/local-packages/dsh-super-plugins/{superagent,super-teams}`（桌面 profile 通过 `file:` 协议直接绑定本机 `.dsh` 内部副本，不依赖外部开发目录）。
- **独立实体技能目录**：`~/.dsh/skills/{superagent-workflow,workflow-quality,development-handoff,super-teams}`（由 `scripts/install.mjs` 复制为无软链/无 Junction 的独立常规目录，并在 `local-packages/dsh-super-plugins/skill-lock.json` 记录版本与逐文件 SHA-256）。
- **引擎持久数据（跨重启保留）**：`~/.dsh/profiles/desktop/plugin-data/dsh-super-teams`（含 `engine.sqlite` WAL 数据库、`context/`、`workspaces/`、`artifact-snapshots/`）。
- **安装备份**：每次运行 `scripts/install.mjs` 自动将桌面 profile 配置与旧技能快照备份至 `~/.dsh/profile-backups/dsh-super-plugins/<timestamp>`（仅保留最近 2 份有效回滚点），绝不改动 `~/.dsh/.credentials.yaml`、`~/.dsh/.env` 或用户主聊天记录。

## 常见问题排查

1. **右侧工作台提示「请先在 DeepSeek Harness 打开或选中一个活跃主聊天会话」**：
   - 子代理需要挂载在活跃的根会话（Root Session）下以继承工作区权限与模型允许列表。新建或点选任意聊天会话后再点击「开始执行 / 恢复团队」即可自动派发。
2. **宿主重启后如何恢复团队任务**：
   - 打开「团队工作台」或调用 `teams_engine({action:"list"})` / `engine_overview({teamId, attentionOnly:true})` 即可直接读取 `engine.sqlite` 中的持久团队、快照与裁决；若有未决任务先调 `engine_control({taskId, action:"reconcile"})` 对账。
3. **验证与自检**：
   - 运行 `node ./scripts/install.mjs --verify` 或 `tests/verify-native.mjs` 可在真实 DeepSeek Harness `0.2.x`（Windows / macOS / Linux）管线中验证 8 个默认工具（及兼容开关 15 工具）、`autoAccept` 行为门禁、`writeScopes` 互斥锁、跨重启持久化及 `~/.dsh/skills` 实体目录哈希一致性。
