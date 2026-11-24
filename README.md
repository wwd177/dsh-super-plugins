# SuperAgent & Super Teams for DeepSeek Harness

[English README](README.en.md) · [AI 智能体自动安装 Skill](skills/dsh-super-plugins-installer/SKILL.md) · [更新日志](CHANGELOG.md)

面向 **DeepSeek Harness (`0.2.x`，支持 Windows / macOS / Linux 全平台)** 的原生多智能体关键路径波次编排引擎、行为测试验收门禁、写入范围互斥锁与右侧「团队工作台」套件。

直接运行于 DeepSeek Harness 宿主 Cordis 进程内，**零外部守护服务、零独立 MCP 子进程、零全局 npm 依赖安装**。

---

## 组件一览

| 组件 | 包名与版本 | 核心职责 |
| --- | --- | --- |
| **SuperAgent 协作与交付** | `@local/dsh-superagent-menu` (`1.21.0-dsh.1`) | 复杂任务拆解、证据选路、行为测试门禁设计与最终集成方法论；内置 `superagent-workflow`、`workflow-quality`、`development-handoff` 3 套技能与聊天「＋」快捷菜单 |
| **Super Teams 持久编排引擎** | `@local/dsh-super-teams` (`0.13.0-dsh.1`) | 内置 SQLite WAL 持久关键路径 DAG 编排引擎 (`0.16.0-dsh.1`)、8 个统一原生工具、双右侧栏自适应「团队工作台」与 `super-teams` 技能 |
| **AI 智能体专用安装 Skill** | [`dsh-super-plugins-installer`](skills/dsh-super-plugins-installer/SKILL.md) (`1.0.0`) | 供其他 AI 智能体（DeepSeek Harness / Claude Code / Codex / Cursor / Antigravity 等）自动完成全平台检测、备份、自包含安装与哈希校验 |

---

## 核心特性

1. **单一团队、单一持久状态库（跨重启 100% 恢复）**：
   - 团队、DAG 波次、成员结果、`ruling` 架构裁决账本与 SHA-256 产物快照统一落盘于 `~/.dsh/profiles/desktop/plugin-data/dsh-super-teams/engine.sqlite`（SQLite WAL 模式），关闭或重启桌面端后状态完整保留。
   - 默认仅暴露 **8 个统一工具**（`engine_workspace`、`engine_team`、`engine_submit`、`engine_overview`、`engine_control`、`engine_source`、`engine_evidence` 及同源只读视图 `teams_engine`），避免双任务板分裂。
2. **`autoAccept: true` 强制可执行行为测试门禁**：
   - 禁止仅靠 `file_exists` / `file_contains` / `json_equals` 等静态检查开启自动放行；必须至少配有一条 `node_test` 行为断言（支持在 `prepare` / `engine_submit` 中直接内联 `testScript`），退出码 `0` 才冻结快照并解锁下游波次，杜绝“生成了空壳文件但逻辑未实现”的假阳性。
3. **`writeScopes` 双层强约束（运行时互斥锁 + 盘后越界拦截）**：
   - 同队并行任务若声明重叠 `writeScopes`，调度器自动施加运行时互斥锁（`write-scope-lock`）串行排队；任务结束时自动扫描工作区，拦截落在声明 `writeScopes` 之外的新增产物文件（`write_scope_guard`）。
4. **双右侧栏无缝兼容与窄屏自适应**：
   - 同时支持官方右侧栏（`sidebarRightTabs`）与社区 `dsh-better-sidebar`，采用 Shadow DOM + Constructable `CSSStyleSheet` 隔离样式，自动跟随 DeepSeek Harness 深色/浅色主题切换。
5. **模型允许列表尊重与推理档位预检**：
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

克隆或解压本仓库后，在仓库根目录执行（脚本会自动检测系统 `node >=22` 或直接复用 DeepSeek Harness 内置运行时，并将包自包含复制到 `~/.dsh/local-packages`）：

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
2. 当主代理调用 `engine_team({action:"prepare", ...})` 时，右侧栏会自动展开 **「团队工作台」**，展示拓扑波次图、关键路径（CPM）、成员实时活动、产物预览、一键打回返工（`rework`）与 ZIP 交付包导出。

---

## 校验、升级与卸载

```bash
# 无损完整性校验（验证插件挂载、实体技能目录与逐文件 SHA-256）
node ./scripts/install.mjs --verify

# 干净卸载插件与 4 套技能（默认保留 engine.sqlite 历史团队数据；加 --purge-data 连同数据一并清理）
node ./scripts/install.mjs --uninstall

# 运行单元、跨重启持久化、行为门禁与写入互斥锁回归测试（需 Node >=22.13）
node --test ./tests/dsh-runtime.test.mjs ./tests/board.test.mjs
```

> **安全与验证边界说明**：每次安装会自动在 `~/.dsh/profile-backups/dsh-super-plugins/` 生成回滚快照，绝不触碰 `.credentials.yaml`、`.env` 或其他已装插件。`node_test` 与工作区 `writeScopes` 扫描运行于当前用户权限下，不构成操作系统内核级沙箱。

## 开源许可

本项目基于 [MIT License](LICENSE) 开源；内嵌第三方组件许可详见 `packages/super-teams/THIRD_PARTY_LICENSES`。
