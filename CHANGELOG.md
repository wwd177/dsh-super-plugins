# Changelog

## v0.16.0-dsh.1 (SuperAgent `1.21.0-dsh.1` / Super Teams `0.13.0-dsh.1`)

- **Universal DeepSeek Harness `0.2.x` Edition (Windows / macOS / Linux)**:
  - Broadened plugin compatibility range to `"dsh": ">=0.2.0-rc.1 <0.3.0-0"` and `"node": ">=22.13.0"`.
  - Added native plugin SVG icons (`assets/icon.svg`) and bilingual metadata (`locale/zh.json`, `locale/en.json`).
  - Registered native `ctx.skills` bundled skill providers (`rank: 600`) inside both plugins alongside self-contained `~/.dsh/skills` installation.
  - Added zero-dependency cross-platform installer, verifier, and uninstaller (`scripts/install.mjs`, `install.ps1`, `install.sh`) with automatic fallback to DeepSeek Harness's bundled runtime (`ELECTRON_RUN_AS_NODE=1`).
  - Added dedicated AI-agent installer skill (`skills/dsh-super-plugins-installer/SKILL.md`) and `AGENTS.md` so any AI coding agent can autonomously install and verify both plugins.
- **Architectural & Safety Hardening**:
  - Unified durable SQLite WAL store (`engine.sqlite`) surviving restarts; hid legacy `.super-teams` write tools behind `DSH_SUPER_TEAMS_LEGACY=1` (8 clean tools by default).
  - Enforced behavioral `node_test` gate (with inline `testScript` support) for `autoAccept: true`, blocking shallow `file_exists` / `file_contains` false positives.
  - Upgraded `writeScopes` with a runtime scheduler mutex (`write-scope-lock`) plus post-run out-of-scope file verification (`write_scope_guard`).
  - Upgraded Shadow DOM workbench mounting to Constructable `CSSStyleSheet` (`adoptedStyleSheets`) for strict CSP compatibility and zero horizontal overflow at `390px–400px` sidebar widths.
