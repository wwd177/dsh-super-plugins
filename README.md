# SuperAgent & Super Teams for DeepSeek Harness

[English README](README.en.md) · [AI 智能体自动安装 Skill](skills/dsh-super-plugins-installer/SKILL.md) · [更新日志](CHANGELOG.md)

面向 **DeepSeek Harness (`0.2.x`，支持 Windows / macOS / Linux 全平台)** 的原生多智能体关键路径波次编排引擎、Git Worktree 协作与原子分支发布、多语言行为测试验收门禁、写入范围互斥锁与会话隔离右侧「团队工作台」套件。

直接运行于 DeepSeek Harness 宿主 Cordis 进程内，**零外部守护服务、零独立 MCP 子进程、零全局 npm 依赖安装**。

---

## 组件一览

| 组件 | 包名与版本 | 核心职责 |
| --- | --- | --- |
| **SuperAgent 协作与交付** | `@local/dsh-superagent-menu` (`1.23.0-dsh.1`) | 对外统一为 **SuperAgent** 产品执行协议：目标拆解、原话必达门禁（R2）、证据选路、多语言行为测试与 Git Worktree 集成方法论；内置 3 套技能与聊天「＋」入口 |
| **Super Teams 审阅工作台与共享内核** | `@local/dsh-super-teams` (`0.15.0-dsh.1`) | 搭载与 Codex 字节级锁定的共享内核 `engine-core 0.18.0`（Engine `0.18.0-dsh.1`）：单调度所有者、不可变冻结交付候选与绑定批准、增量集成修订、基线漂移三方试合、只读 GitHub PR 对账与会话隔离右侧审阅工作台 |
| **AI 智能体专用安装 Skill** | [`dsh-super-plugins-installer`](skills/dsh-super-plugins-installer/SKILL.md) (`1.2.0`) | 供其他 AI 智能体自动完成全平台检测、备份、单入口自包含安装与逐文件 SHA-256 校验 |

---

## 核心特性

1. **单一团队、单一持久数据目录（跨重启精确对账恢复）**：
   - 团队与任务元数据、事件日志存储于 `~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/engine.sqlite`（SQLite WAL 模式），而冻结交付文件快照、Git 增量补丁、登记来源与运行工作区分别存储在同目录的 `artifact-snapshots/`、`git-patches/`、`context/` 与 `attempts/` 中；重启后支持驻留/历史会话双分支 `turnId` 精确对账恢复。
   - 默认仅暴露 **8 个统一工具**（`engine_workspace`、`engine_team`、`engine_submit`、`engine_overview`、`engine_control`、`engine_source`、`engine_evidence` 及同源只读视图 `teams_engine`），避免双任务板分裂。
2. **强化 `git-worktree` 协作模式与侧栏建队/合并入口**：
   - 支持在工具（`workspaceMode: "git-worktree"` + `repoPath`）**以及右侧工作台「新建团队」标准表单**中直接创建 Git Worktree 团队：建队锁定 `baseCommit`，任务在独立 detached worktree 中并行开发并按传递闭环自动重放上游增量补丁。
   - 工作台概览内置「预览 Git 合并（`merge_preview`）」与「原子发布到新分支（`merge_apply` → 仅新建 `superagent/<slug>` 分支，绝不改写当前活工作树或既有分支）」，导出 ZIP 自动包含 `DELIVERY.md`、`HANDOFF.md` 与 `changes.patch`。
3. **分级可执行行为测试门禁（`node_test` + 多语言 `command_test`）**：
   - 禁止仅靠 `file_exists` / `file_contains` / `json_equals` 等静态检查或 `command_test` 开启 `autoAccept: true`；自动验收必须至少配有一条不可变 `ContextStore` 托管的 `node_test` 行为断言（支持内联 `testScript`）。
   - 支持结构化多语言 `command_test`（`node --test`、`pytest`、`python -m pytest|unittest`、`cargo test`、`go test`、`dotnet test`、`npm test` / `npm run test[:*]`），在 `.git`-free 导出目录运行并拦截危险注入标志与零用例假绿，通过后进入 `checked` 供显式 `accept` 复核。
4. **`writeScopes` 全链路强约束（同队互斥锁 + 测前/测后或双树 Diff 越界拦截）**：
   - 启用 `writeScopes` 的团队自动对重叠范围及未声明范围任务施加运行时互斥锁（`write-scope-lock`）串行排队；隔离模式执行测前/测后双重扫描，`git-worktree` 模式以临时索引封存 `candidateCommit` 并对 `<attemptStartCommit>..<candidateCommit>` 做 `--raw --find-renames -z` 双树审计，拦截越界改动、重命名、删除、符号链接与 Windows 目录联结（`write_scope_guard`）。
5. **双右侧栏无缝兼容与多聊天会话严格隔离**：
   - 同时支持官方右侧栏（`sidebarRightTabs`）与社区 `dsh-better-sidebar`，采用 Shadow DOM + Constructable `CSSStyleSheet` 隔离样式、跟随深浅色主题切换。
   - 服务端 SSE/变更流、宿主壳层与工作台三层均按 `sessionId` 严格路由，多聊天并行打开各自团队时绝不串切已挂载面板。
6. **模型允许列表尊重与推理档位预检**：
   - 绝不改动用户主会话模型与推理设置；子代理严格遵循会话 `subagentModelSelectionPolicy` 允许列表，并通过 `llm.resolveCallConfig` 自动预检回退不支持 `reasoningEffort` 的模型。

---

## 安装方式

### 方式一：交给任意 AI 智能体自动安装（最省心）

你可以直接把以下口令发给你的 AI 编程助手（DeepSeek Harness、Claude Code、Codex、Cursor、Windsurf、Antigravity 等）：

```text
请读取仓库 https://github.com/wwd177/dsh-super-plugins.git 中的 skills/dsh-super-plugins-installer/SKILL.md，按其中的安全步骤帮我把 SuperAgent 和 Super Teams 两个插件及配套技能安装到本机 DeepSeek Harness 并完成校验。
```

也可以将该安装 Skill 导入你的智能体技能库反复复用：
- 技能路径：[`skills/dsh-super-plugins-installer/SKILL.md`](skills/dsh-super-plugins-installer/SKILL.md)（兼容 `npx skills add wwd177/dsh-super-plugins` 与 `dsh-skills-manager` 仓库导入）。

### 方式二：手动一键脚本安装（即使本机没装 Node.js 也能运行）

克隆或解压本仓库后，在仓库根目录执行（脚本会自动检测系统 `node >=22` 或直接复用 DeepSeek Harness 内置运行时，并将包原子暂存复制到 `~/.dsh/local-packages`）：

- **Windows (PowerShell)**：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
  ```
- **macOS / Linux**：
  ```bash
  sh ./install.sh
  ```

安装完成后，**重启一次 DeepSeek Harness** 即可生效。安装完成后可随时移动或删除克隆目录，不影响已安装的插件与技能。

---

## 快速上手

1. 在聊天输入框输入 `/superagent-workflow` 或 `/super-teams`（也可点击输入框左侧 **「＋」** 选择 **「SuperAgent 协作与交付」** 或 **「SuperAgent 团队工作台」**）：
   ```text
   /superagent-workflow 组建团队完成以下目标：设计接口契约、实现核心模块并通过行为测试验收
   ```
2. 当主代理调用 `engine_team({action:"prepare", ...})` 时，当前会话右侧栏会自动展开 **「团队工作台」**；你也可以直接在工作台点击 **「新建团队」**，选择 **隔离工作目录** 或 **Git Worktree（真实仓库隔离分支）** 模式。

---

## 校验、完整备份与卸载

```bash
# 无损完整性校验（验证插件挂载、实体技能目录与逐文件 SHA-256）
node ./scripts/install.mjs --verify

# 干净卸载插件与 4 套技能（默认保留整个 plugin-data/dsh-super-teams/ 历史数据目录；加 --purge-data 连同数据一并清理）
node ./scripts/install.mjs --uninstall

# 运行单元、跨重启对账、行为门禁、Git Worktree 与多语言测试回归套件（需 Node >=22.13）
node --test ./tests/dsh-runtime.test.mjs ./tests/board.test.mjs ./tests/v0170-worktree-polyglot.test.mjs
```

> **完整备份警告（切勿只复制 `engine.sqlite`）**：`engine.sqlite` 仅保存团队与任务元数据及哈希索引；真实已验收交付快照、Git 补丁、登记来源与任务工作区分别存放在同目录的 `artifact-snapshots/`、`git-patches/`、`context/` 与 `attempts/` 中。备份或迁移数据时，请先退出 DeepSeek Harness，再**完整复制整个 `~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/` 目录**（包含 `engine.sqlite` 及 `-wal`/`-shm` 与全部子目录），仅复制单个 SQLite 文件会丢失所有交付文件。
>
> **安全与验证边界说明**：每次安装会自动在 `~/.dsh/profile-backups/dsh-super-plugins/` 生成独立回滚快照，绝不触碰 `.credentials.yaml`、`.env` 或其他已装插件。`node_test`、`command_test` 与工作区 `writeScopes` 扫描运行于当前用户权限下，不构成操作系统内核级沙箱。

## 开源许可

本项目基于 [MIT License](LICENSE) 开源；内嵌第三方组件许可详见 `packages/super-teams/THIRD_PARTY_LICENSES`。
