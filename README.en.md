# SuperAgent & Super Teams for DeepSeek Harness

[中文说明](README.md) · [AI Agent Installer Skill](skills/dsh-super-plugins-installer/SKILL.md) · [Changelog](CHANGELOG.md)

Native multi-agent critical-path DAG orchestration engine, behavioral test gate, runtime write-scope mutex, and right-sidebar **Team Workbench** for **DeepSeek Harness (`0.2.x` on Windows, macOS, and Linux)**.

Runs directly inside the DeepSeek Harness Cordis host process — **zero external daemons, zero separate MCP subprocesses, and zero global npm installs required**.

---

## Components

| Component | Package & Version | Role |
| --- | --- | --- |
| **SuperAgent Workflow & Delivery** | `@local/dsh-superagent-menu` (`1.21.1-dsh.1`) | Task decomposition, evidence-based routing, behavioral verification gates, and final integration methodology; includes `superagent-workflow`, `workflow-quality`, and `development-handoff` skills plus `+` menu actions |
| **Super Teams Persistent Engine** | `@local/dsh-super-teams` (`0.13.1-dsh.1`) | Unified SQLite WAL critical-path DAG engine (`0.16.1-dsh.1`), 8 native tools, adaptive right-sidebar Team Workbench, and the `super-teams` skill |
| **AI Agent Installer Skill** | [`dsh-super-plugins-installer`](skills/dsh-super-plugins-installer/SKILL.md) (`1.0.1`) | Dedicated skill allowing any AI coding agent (DeepSeek Harness, Claude Code, Codex, Cursor, Windsurf, Antigravity, etc.) to safely install, verify, or uninstall both plugins |

---

## Highlights

- **Single Unified Persistent Store (`engine.sqlite` WAL)**: Teams, DAG waves, `ruling` decision ledgers, and SHA-256 artifact snapshots persist across DeepSeek Harness restarts with turn-correlated resident & historical reconciliation and a clean 8-tool surface (`7 engine_*` + read-only `teams_engine`).
- **Behavioral `autoAccept` Gate**: Blocks shallow `file_exists` / `file_contains` / `json_equals` checks from triggering `autoAccept: true`; requires at least one executable `node_test` check (supports inline `testScript` with isolated temp dir and minimal env) exiting `0` before freezing snapshots.
- **Full-Lifecycle `writeScopes` Enforcement**: Combines a runtime scheduler mutex (`write-scope-lock`, serializing overlapping and unscoped tasks within scope-managed teams) with pre-check and post-check workspace verification (`write_scope_guard`, rejecting undeclared out-of-scope files and symlinks).
- **Dual Right-Sidebar & Strict CSP Support**: Integrates natively with both stock `sidebarRightTabs` and `dsh-better-sidebar` using Shadow DOM + Constructable `CSSStyleSheet`, zero dropped cold-start auto-open events, and automatic dark/light theme sync.

---

## Installation

### Option 1: Ask Any AI Agent to Install It for You

Paste this prompt into your AI coding assistant (DeepSeek Harness, Claude Code, Codex, Cursor, Antigravity, etc.):

```text
Read skills/dsh-super-plugins-installer/SKILL.md from https://github.com/wwd177/dsh-super-plugins.git and follow its playbook to install and verify both SuperAgent and Super Teams into my local DeepSeek Harness.
```

You can also install the reusable installer skill via `npx skills add wwd177/dsh-super-plugins` or import the repository in `dsh-skills-manager`.

### Option 2: One-Command Cross-Platform Install (Works Even Without System Node.js)

Clone or extract this repository, then run from the repository root (automatically uses system `node >=22` or falls back to DeepSeek Harness's bundled runtime):

- **Windows (PowerShell)**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
  ```
- **macOS / Linux**:
  ```bash
  sh ./install.sh
  ```

Restart **DeepSeek Harness** once after installation. Because packages and skills are atomically staged into `~/.dsh/local-packages/dsh-super-plugins` and `~/.dsh/skills`, you may freely move or delete the cloned checkout afterwards.

---

## Verify, Upgrade & Uninstall

```bash
# Non-destructive health & SHA-256 parity check
node ./scripts/install.mjs --verify

# Clean uninstall (preserves engine.sqlite history unless --purge-data is passed)
node ./scripts/install.mjs --uninstall

# Run unit, persistence, behavioral gate & write-scope mutex regression suites
node --test ./tests/dsh-runtime.test.mjs ./tests/board.test.mjs
```

## License

Released under the [MIT License](LICENSE). Third-party notices are included under `packages/super-teams/THIRD_PARTY_LICENSES`.
