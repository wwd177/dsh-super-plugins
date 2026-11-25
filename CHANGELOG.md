# Changelog

## v0.16.1-dsh.1 (SuperAgent `1.21.1-dsh.1` / Super Teams `0.13.1-dsh.1`)

- **Reconciliation & Lifecycle Hardening**:
  - Fixed post-restart and mid-flight turn identity reconciliation (`DshAdapter.inspect` + `Engine._inspectAttempt`) across both resident (`live.session`) and historical (`sessionQuery.observeSession`) sessions when `messageId !== childId`, preventing completed tasks from remaining stuck in `unknown` and holding concurrency/write-scope locks.
  - Fixed Cordis runtime async startup/disposal race (`DshSuperTeamsRuntime.ensureStarted` / `close`) so aborted initializations clean up immediately without leaking router timers, and transient startup failures reset `initPromise` for clean retry.
- **Verification & `writeScopes` Security Hardening**:
  - Enforced `write_scope_guard` workspace verification both **before** and **after** `node_test` execution so undeclared files generated during test runs cannot bypass `writeScopes` into `autoAccept`, while providing an isolated per-test `TMP`/`TEMP`/`TMPDIR` and sanitized minimal environment.
  - Extended runtime `write-scope-lock` mutex so unscoped tasks inside scope-managed teams serialize safely as `['*']` rather than bypassing active scoped teammates; raised workspace scan depth bound to 32 with explicit fail-closed checks and unconditional symlink rejection.
- **Workbench UI, HTTP Fence & Atomic Installer**:
  - Fixed cold-start `since=-1 -> 0` change-stream cursor initialization in `client.js` and `dsh-http.mjs` so the very first `open-workbench` signal is never dropped, with serialized abortable polling and session-scoped multi-window filtering.
  - Added cross-origin `Origin` host verification for state-mutating HTTP requests even inside fenced mode.
  - Hardened `scripts/install.mjs` with atomic temporary staging + rollback for packages and skills, collision-free profile-scoped backup directories, and single-pass environment-variable invocation for Windows `.cmd` wrappers.

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
