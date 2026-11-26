# Changelog

## v0.17.1-dsh.1 (SuperAgent `1.22.1-dsh.1` / Super Teams `0.14.1-dsh.1` / Installer Skill `1.1.1`)

- **Strict Multi-Chat Workbench Session Isolation (Fixes Dual-Panel Cross-Talk)**:
  - Fixed all four cross-chat leakage points when chat A already has a mounted right-sidebar workbench and chat B requests opening its own team:
    1. `dsh-http.mjs` now tracks per-client `sessionId` on `/api/stream?sessionId=` and filters both SSE push and `/api/changes?since=&sessionId=` so `open-workbench` events for chat B are never delivered to chat A's subscribed workbench.
    2. `client.js` replaced the single global `window.__DSH_SUPERAGENT_LAST_TEAM__` slot with a per-session map (`lastTeamBySession`) and enforces exact `sessionId` matching inside `WorkbenchHost`'s `FOCUS_TEAM_EVENT` listener.
    3. `client.js` `openInRightSidebar(sessionId)` now prioritizes the explicit `sessionId` over `commandTarget(document.activeElement)` so opening chat B's tab never hijacks chat A's focused dock.
    4. `public/app.js` enforces strict `sessionId` matching inside `handleLiveEvent('open-workbench')`, passes `sessionId` on SSE/changes requests and manual `POST /api/teams`, and reconnects streams when `setSessionId` updates.
- **Right-Sidebar Git Worktree Team Creation & Merge Controls**:
  - Added `workspaceMode` (`isolated` | `git-worktree`) and conditional `repoPath` input (auto-prefilled from the active session's `cwd` when available) directly to the standard **New Team** modal in both DSH (`template.html`/`index.html`/`app.js`) and Codex (`index.html`/`app.js`).
  - Team overview now displays a `Git Worktree` badge, pinned `baseCommit`/`baseBranch`/`lastMerge` metadata, and interactive **Preview Git Merge** (`merge_preview`) & **Atomic Publish to New Branch** (`merge_apply`) controls.
- **Complete Companion Skill Sync & Explicit Full-Directory Backup Guidance**:
  - Synchronized all 4 DSH companion skills (`superagent-workflow` + all references, `workflow-quality`, `development-handoff`, `super-teams`) and READMEs with `v0.17.x` capabilities (`git-worktree`, `command_test`, `merge_preview`/`merge_apply`, `HANDOFF.md` + `changes.patch`).
  - Corrected misleading SQLite-only persistence wording across skills and docs to make clear that **copying only `engine.sqlite` does NOT preserve frozen deliverables or Git patches** — complete backups must copy the full `plugin-data/dsh-super-teams/` directory (`engine.sqlite` + `-wal`/`-shm`, `artifact-snapshots/`, `git-patches/`, `context/`, `attempts/`).

## v0.17.0-dsh.1 (SuperAgent `1.22.0-dsh.1` / Super Teams `0.14.0-dsh.1`)

- **Hardened `git-worktree` Collaboration Mode (`workspaceMode: "git-worktree"`)**:
  - Teams can now target a real local Git repository via `workspaceMode: "git-worktree"` + `repoPath`, pinning `baseCommit` at team creation while keeping every task attempt in an isolated detached Git worktree.
  - **Transitive Diamond-DAG Incremental Patch Replay**: Dependent tasks compute the transitive ancestor closure, deduplicate by `(taskId, snapshotId)`, sort topologically, and replay each accepted ancestor's verified incremental `changes.patch` cleanly (failing preflight with conflicting `taskId`/`snapshotId` references on patch conflict).
  - **Two-Tree Diff `writeScopes` Certification**: Candidates are sealed via an isolated temporary `GIT_INDEX_FILE` into an immutable `candidateCommit` and audited by `git diff --raw --find-renames -z <attemptStartCommit> <candidateCommit>` (catching detached-HEAD commits, rename old/new paths, deletions, mode `120000`/`160000`, symlinks, and Windows directory junctions).
  - **Isolated `.git`-Free Test & Freeze Execution**: Behavioral verification and snapshot freezing operate on a clean exported copy of `candidateCommit` with no `.git` metadata and full process-tree cleanup on timeout/exit.
  - **Safe `merge_preview` & Atomic Create-Only `merge_apply`**: Replays all accepted task patches in topological order inside a temporary detached staging worktree, runs optional behavioral `integrationCheck` on an exported `.git`-free tree, and atomically publishes `refs/heads/superagent/<slug>` via `git update-ref <ref> <oid> 0000...0000` without touching the user's active working tree or existing branches.
- **Polyglot Structured `command_test` Acceptance Gate**:
  - Added `command_test` as a polyglot behavioral check reaching `checked` state (requiring explicit `accept` / `accept_checked` review, while `autoAccept: true` remains strictly bound to immutable `ContextStore`-frozen `node_test` scripts to prevent transitive test-helper tampering), supporting structured local test runners (`node --test`, `pytest`, `python/python3 -m pytest|unittest`, `cargo test`, `go test`, `dotnet test`, `npm test` / `npm run test[:*]`).
  - Explicitly forbids `npx`, inline eval/preload flags (`-e`, `--eval`, `-p`, `-r`, `--require`, `python -c`, `go test -exec`, `cargo --config`, `npm --script-shell`), parent-directory traversal, host absolute paths, and zero-test false positives (`# tests 0` / `Ran 0 tests`).
- **Delivery Handoff Enhancement**:
  - `delivery.zip` exports now include SHA-256 verified `artifacts/<taskId>/changes.patch` and a sanitized `HANDOFF.md` integration checklist for `git-worktree` teams.

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
