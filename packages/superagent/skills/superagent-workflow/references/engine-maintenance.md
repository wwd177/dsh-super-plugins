# 安装、诊断、完整备份与维护（DeepSeek Harness 版）

## 架构概览

DeepSeek Harness 适配版（Engine `0.17.1-dsh.1` / SuperAgent `1.22.1-dsh.1` / Super Teams `0.14.1-dsh.1`）采用宿主原生 Cordis 插件架构与 `~/.dsh` 全自包含安装布局：

- `@local/dsh-superagent-menu`（`1.22.1-dsh.1`）：提供聊天「＋」菜单快捷入口（插入 `/superagent-workflow`）及方法论技能包（`superagent-workflow`、`workflow-quality`、`development-handoff`）。
- `@local/dsh-super-teams`（`0.14.1-dsh.1`）：在宿主进程内挂载 SQLite WAL 持久编排引擎 `Engine 0.17.1-dsh.1`、`DshAdapter`、8 个默认原生工具（7 个 `engine_*` + 只读同源视图 `teams_engine`）与 `/superagent-engine/*` 鉴权路由，并在官方右侧栏（`sidebarRightTabs`）及 `dsh-better-sidebar` 同时注册按会话隔离的「团队工作台」面板。

## 自包含目录位置与持久数据布局

- **自包含插件包目录**：`~/.dsh/local-packages/dsh-super-plugins/{superagent,super-teams}`（桌面 profile 通过 `file:` 协议直接绑定本机 `.dsh` 内部副本，不依赖外部开发目录）。
- **独立实体技能目录**：`~/.dsh/skills/{superagent-workflow,workflow-quality,development-handoff,super-teams}`（由 `scripts/install.mjs` 复制为无软链/无 Junction 的独立常规目录，并在 `local-packages/dsh-super-plugins/skill-lock.json` 记录版本与逐文件 SHA-256）。
- **引擎完整持久数据目录**：`~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/`（默认 profile 为 `desktop`），内部由以下不可分割的目录与文件共同组成：
  - `engine.sqlite`（及运行期 `engine.sqlite-wal`、`engine.sqlite-shm`）：团队、成员、任务元数据、revision、事件日志与快照/补丁哈希索引；
  - `artifact-snapshots/`：所有 `accepted` 任务的不可变 SHA-256 交付文件副本与完整结果文本；
  - `git-patches/`：`git-worktree` 团队已验收任务的 SHA-256 校验增量补丁文件（`changes.patch`）；
  - `context/`：通过 `engine_source` 登记的长文本来源、`ruling` 架构裁决与不可变 `node_test` 脚本；
  - `attempts/`（及历史 `workspaces/`、`worktrees/`）：运行中或未冻结任务的尝试目录、日志与隔离工作树。
- **安装回滚备份**：每次运行 `scripts/install.mjs` 自动将桌面 profile 配置与旧技能快照备份至 `~/.dsh/profile-backups/dsh-super-plugins/<timestamp>`（仅保留最近 2 份有效回滚点），绝不改动 `~/.dsh/.credentials.yaml`、`~/.dsh/.env` 或用户主聊天记录。

## 完整备份与恢复注意事项（重要）

> **切勿只复制 `engine.sqlite`！**
> `engine.sqlite` 仅存放元数据与哈希索引，**不包含交付文件正文、冻结产物快照、Git 增量补丁或上下文源文件**。如果只备份了 `engine.sqlite` 而漏掉同目录的 `artifact-snapshots/`、`git-patches/`、`context/` 与 `attempts/`，恢复后虽然能看到历史团队记录，但导出成果 ZIP、查看快照文件或执行 `merge_preview`/`merge_apply` 都会因缺失底层文件而失败。

安全备份步骤：
1. **先完全退出 DeepSeek Harness**（或确认无活动运行任务），确保 SQLite WAL 日志已刷盘，避免热拷贝造成 `engine.sqlite` 与 `-wal`/`-shm` 不一致。
2. **整目录复制** `~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/` 到目标备份路径（保留 `engine.sqlite`、`engine.sqlite-wal`、`engine.sqlite-shm`、`artifact-snapshots/`、`git-patches/`、`context/`、`attempts/` 的相对结构）。
3. 恢复时同样在退出 DeepSeek Harness 的状态下将完整目录还原至原位置，再启动 DeepSeek Harness；若恢复前存在未决任务，启动后先调用 `engine_control({taskId, action:"reconcile"})` 对账，勿盲目重跑。

## 常见问题排查

1. **右侧工作台提示「请先在 DeepSeek Harness 打开或选中一个活跃主聊天会话」**：
   - 子代理需要挂载在活跃的根会话（Root Session）下以继承工作区权限与模型允许列表。新建或点选任意聊天会话后再点击「开始执行 / 恢复团队」即可自动派发。
2. **宿主重启后如何恢复团队任务**：
   - 打开「团队工作台」或调用 `teams_engine({action:"list"})` / `engine_overview({teamId, attentionOnly:true})` 即可直接读取持久团队、快照与裁决；若有未决任务先调 `engine_control({taskId, action:"reconcile"})` 对账。
3. **验证与自检**：
   - 运行 `node ./scripts/install.mjs --verify` 或 `tests/verify-native.mjs` 可在真实 DeepSeek Harness `0.2.x`（Windows / macOS / Linux）管线中验证 8 个默认工具（及兼容开关 15 工具）、`autoAccept` 行为门禁、`writeScopes` 互斥锁、双聊天会话隔离、跨重启持久化及 `~/.dsh/skills` 实体目录哈希一致性。
