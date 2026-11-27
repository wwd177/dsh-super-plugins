# Changelog

## v0.20.0-dsh.1 (SuperAgent `1.25.0-dsh.1` / Super Teams `0.17.0-dsh.1` / Shared Core `0.19.1` / Installer Skill `1.4.0`)

Hardens installer lock coordination, control-plane session semantics, bounded auto-recovery loops, and manual slot resolution across both hosts (real host regressions verified on Windows; POSIX installer/process-birth logic implemented and script-ready pending live macOS/Linux execution):

- **SQLite Lock Guard, Live-PID Safety & Profile-Only Purge (`scripts/install.mjs`)**:
  - Coordinates installs/uninstalls per canonical physical `dshHome` via `.dsh-super-plugins.lock-guard.sqlite` (`PRAGMA busy_timeout = 1500; BEGIN EXCLUSIVE`) with precomputed cross-platform `getProcessBirth(pid)` (Win32 ticks, Linux `/proc/<pid>/stat` field 22, macOS `ps -o lstart=`), eliminating the unsafe `ageMs > 60000` live-PID eviction and treating unverifiable live birth fail-closed as alive (`DSH_LOCK_WAIT_MS` default `30000`, unlock nonce checked inside the guard DB).
  - Replaces synchronous blocking CLI execution with async `runDshCli` (`DSH_CLI_TIMEOUT_MS` default `120000`) and full process-tree cleanup (`taskkill /T /F` / `-pid` `SIGKILL`), rolls back fresh `stageRoot` on initial install failure when no sibling profile references exist, and scopes `--uninstall --purge-data` strictly to the target profile directory while preserving legacy `<dshHome>/plugin-data/dsh-super-teams`.
- **Control-Plane Session Affinity & Error Preservation (`dsh-http.mjs`, `engine.mjs`)**:
  - Enforces online session preflight (`onlyIfUnbound: true, verifyOnline: true`) on `POST /api/teams/:id/control` specifically when `action === 'resume'` with `sessionId` (propagating errors cleanly), while keeping `pause`/`cancel` offline-safe.
  - Fixes `_pump()` secondary `preflightSession` failure & catch handling so offline sessions record `blockReason: 'session-unavailable'` and `blockCode: 'SESSION_UNAVAILABLE'`.
- **Bounded Auto-Recovery & `expectedAttemptId`-Pinned Manual Release (`engine.mjs`, `dsh-http.mjs`, `overview.mjs`, `definitions.mjs`, `runtime.mjs`, `recovery-guidance.mjs`)**:
  - Adds `MAX_AUTO_RECOVERY_TRIES = 12` persisted per `attemptId` across restarts, sets `recoveryTerminal` (`stopCertified: false`) immediately on matched `turn.status === 'interrupted'`, halts background polling, guards post-`await` writes against close/attempt swaps, exposes `status().exhaustedReconciliations` while excluding stopped tasks from `nextRecoveryAt`, and surfaces conditional `manualRelease` guidance.
  - Adds `resolve_unresolved` + optional `expectedAttemptId` to `engine_control` (preserving the exact 8-tool contract), `POST /api/tasks/:id/resolve-unresolved`, and `overview.mjs` (`unresolvedResolution`, pruned first under tight byte budgets).
- **Live External-Repo Blind Benchmark (`docs/benchmarks/live-benchmark-v0.20.0.md`)**:
  - Documents real-model external-repo blind screening methodology and observed Windows results (preserving honest sample boundaries).

## v0.19.1-dsh.1 (SuperAgent `1.24.1-dsh.1` / Super Teams `0.16.1-dsh.1` / Shared Core `0.19.1` / Installer Skill `1.3.1`)

Addresses multi-profile installation safety, strict multi-chat dispatch affinity, graph-exact critical path scheduling, Windows `MAX_PATH` isolation hardening, and 100% release manifest consistency across both hosts:

- **Multi-Profile Reference-Safe & Locked Installer/Uninstaller (`scripts/install.mjs`)**:
  - Serializes installs and uninstalls per canonical physical `dshHome` via `.dsh-super-plugins.lock` (`wx` + PID/nonce ownership + stale lock cleanup).
  - Fail-closed scan across `<dshHome>/profiles/*` using filesystem object identity (`dev:ino` + `realpath`), ancestor symlink/junction checks, `node_modules/@local/dsh-super*` detection, and strict manifest JSON validation: preserves shared `skills/` and `local-packages/dsh-super-plugins` whenever any sibling profile references the plugins or has an unreadable/corrupt manifest (`sharedAssetsPreserved: true`).
- **Strict Multi-Chat Session Affinity & Transactional Rebind (`dsh-adapter.mjs`, `engine.mjs`, `dsh-http.mjs`, `runtime.mjs`, `definitions.mjs`)**:
  - Removes silent fallback to `preferredSessionId` or `_liveRoots().at(-1)` whenever a task or team is bound to an explicit chat session (`resolveRootAgent` / `preflightSession`). Refuses dispatching into another online chat, avoids reserving budget or leaving orphan attempt directories, and prevents `models()` / `sessionSnapshot()` from leaking another chat's route selection when the bound chat is offline.
  - Prevents background UI/sidebar `control` or `engine_workspace` calls from silently hijacking an already-bound team (`onlyIfUnbound: true`).
  - Adds `engine_team({ action: 'rebind_session', teamId })` and `POST /api/teams/:id/rebind-session` (preserving the 8-tool contract) with atomic `REBIND_CONFLICT` guards against in-flight/unresolved executions and automatic wakeup of inherited `blocked(session-unavailable)` tasks.
- **Exact Active-Subgraph Critical Path Scheduling (`scheduler.mjs` on Codex & DSH)**:
  - Computes a monotonic fixed point `schedulableActive` seeded from `accepted` tasks over raw dependencies, strictly restricting `computeCritical`, `computeDownstream`, `maxCriticalWeight`, `criticalPathIds`, `scopeOverlaps`, and `remainingTasks` to active unblocked tasks along direct original edges (`cancelled`/`abandoned` nodes, downstream deadlocked tasks, and transitive bridges across intermediate `accepted` nodes are excluded cleanly).
- **Windows Deep-Path Isolation Hardening (`core/src/process-isolation.mjs`, `core/src/env-recipe.mjs`, `verification.mjs`)**:
  - Moves ephemeral verification tmp/home roots out of nested `attempts/<uuid>/<uuid>` directories into short `os.tmpdir()` prefixes (`sa-v-*` / `sa-h-*`) with length-budget guards (`AppData\Roaming` & `.gitconfig.lock`), 48-bit hex short evidence log names with `EEXIST` retry, automatic mid-init rollback, and `cleanup()` hooks in both `verification.mjs` and `WorktreeEnvManager`.
- **100% Release Manifest & Line-Ending Parity (`.gitattributes`, `build-release.mjs`, `scripts/verify-release-manifest.mjs`, `docs/ci-workflow.example.yml`)**:
  - Enforces LF line endings via `.gitattributes`, normalizes text files before generating `SHA256SUMS.json`, relocates the reference CI workflow template to `docs/ci-workflow.example.yml`, adds `scripts/verify-release-manifest.mjs` proving 100% SHA-256 identity across `HEAD` git blobs, working tree, ZIP archive, and remote ref, and clarifies deterministic fixture scope for the 18-run `v0.20` benchmark screening test.

## v0.19.0-dsh.1 (SuperAgent `1.24.0-dsh.1` / Super Teams `0.16.0-dsh.1` / Shared Core `0.19.0` / Installer Skill `1.3.0`)

Hardens execution security isolation, transactional budget/breaker control, lease-checked remote Git/PR delivery, per-worktree environment recipes, and full UI E2E verification across both hosts on the byte-identical shared `engine-core 0.19.0`:

- **Verification Child Isolation, Process-Tree Termination & Truthful Host Posture (`core/src/process-isolation.mjs`)**:
  - `buildIsolatedTestEnv` strips secret/credential env vars and redirects `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`, and `NPM_CONFIG_USERCONFIG` into ephemeral per-run roots; verified by canary leak checks across live child processes.
  - `killProcessTree` terminates entire parent+descendant trees across Windows (`taskkill /T /F`) and POSIX process groups (`-pid`).
  - `probeHostIsolationPosture` truthfully reports `env_and_config_isolated_same_os_user` vs `os_account_isolated` alongside live host toolchain checks.
- **Transactional Budget Guard & Breaker Control (`core/src/budget-guard.mjs`)**:
  - Atomic SQLite CAS reservation for hard attempt limits (`maxTeamAttempts`) and concurrency (`maxInFlight`), preventing dual-worker overspend races.
  - Monotonic idempotent per-`(attemptId, threadId)` token snapshot tracking (`maxTeamTokensSoft` soft pause with `inFlightExposureAtBreach`), hard `maxTaskDurationMs` watchdog kills, and `sameErrorBreakerThreshold` pause preservation (`_writeChange` preserves `blockReason: 'same_error_breaker'`).
- **Authorized Remote Delivery & Recovery (`core/src/remote-delivery.mjs`)**:
  - Strict `allowedRemoteRepos` allowlist checks, failed verification candidates (`status === 'verification_failed'`) blocked from approval (`CANDIDATE_VERIFICATION_FAILED`), and transactional mutual exclusion between `revokeApproval` and publish.
  - Remote branch push enforces `--force-with-lease=<ref>:<expectedOldOid>` (rejecting ancestor rewinds and freezing streams to `frozen_external_drift`) plus `resolveExternalDrift`, lost-receipt idempotent draft PR recovery (`reconcileRemoteIntents` / `resolveUnknownPrIntent`), and single active revision reuse per `(deliveryStreamId, candidateId)` across distinct remote failure signatures.
- **Repo Environment Recipes, Concurrent Worktree Services & Blind Benchmark (`core/src/env-recipe.mjs`, `core/src/bench-harness.mjs`)**:
  - Read-only `probeRepoEnvironment` (`autoSelected: false`), explicitly approved `recipeHash` persistence, isolated dynamic-port `WorktreeEnvManager` service lifecycle, and 6-task × 3-arm screening benchmark harness with exact one-sided binomial sign test.
- **Workbench UI & Headless Chromium E2E Coverage**:
  - Upgraded both Codex and DSH workbenches with candidate selector auto-clearing `selectedApprovalId` on switch, decoupled approve/revoke/publish/revise actions, criteria freeze + human signoff UI, read-only 3-state PR reconciliation pills, live budget progress card, repo probe dialog, security posture & refusal audit views, verified in headless Chromium/Edge CDP E2E at `390px`/`400px`/`1320px`.

## v0.18.0-dsh.1 (SuperAgent `1.23.0-dsh.1` / Super Teams `0.15.0-dsh.1` / Shared Core `0.18.0` / Installer Skill `1.2.0`)

Implements all 8 v0.18 architecture rulings (`R1`–`R8`) across both DeepSeek Harness and Codex on a single SHA-256 locked shared `engine-core`:

- **R1 — Unified Product Entry & Locked Shared `engine-core` (`0.18.0`)**:
  - Extracted shared `goal-criteria`, `delivery-candidate`, `git-worktree`, `github-readonly`, and `delivery-service` into a locked shared core synchronized byte-for-byte with Codex (`core-lock.json` SHA-256 parity).
  - Enforced a single scheduler owner per `dataDir` inside DSH (`activeRuntimeOwners` registry) while preserving transparent backward compatibility for legacy entrypoints and existing `0.17.1` databases.
- **R2 — Frozen Goal Criteria & Unmapped User Requirement Visibility**:
  - Added `criteria_preview` / `criteria_freeze` / `criteria_get` / `criteria_signoff` actions; splits raw user goals into traceable segments and explicitly highlights any user requirement not covered by a mandatory check or named human sign-off (rejecting `skipped`, `neutral`, empty tests, or pending sign-offs).
- **R3 & R4 — Immutable Delivery Candidates, Bound Approvals & Crash-Safe Local Publish**:
  - Eliminated TOCTOU drift between preview and publish: approvals bind strictly to `(candidateId, commitOid, purpose, targetRef, criteriaRevision, gateHash)` — approving Candidate A can never publish A+B or survive revoked/drifted criteria.
  - Pinned frozen candidate commits under `refs/superagent/candidates/<candidateId>` to survive `git gc --prune=now` and engine restarts.
  - Added persistent `publish_intents` and `publish_reconcile` to distinguish crash-after-`git update-ref` (recovers matching receipt) from external branch occupation (`external_drift`, halts writes), while separating `local_branch_only` status from remote PR merge.
- **R5 & R6 — Immutable Accepted Snapshots, Incremental Integration Revisions & Base-Drift Reconciliation**:
  - Added `revisionOfCandidateId` + `affectedTaskIds` on `engine_submit` so integration revisions start cleanly from `C1.commitOid` without mutating accepted `A`/`B` records; `C2 = C1 + R1.patch` verifies tree OID equivalence against full replay from `baseCommit`, while replacing a snapshot (e.g., `A1 -> A2`) cleanly rebuilds from base so removed files disappear.
  - Added `candidate_base_drift` using isolated three-way `git merge-tree --write-tree` to report clean drift vs `integration_conflict` with exact `mergeBase`, `targetCommit`, `candidateCommit`, and `conflictPaths` without blindly re-dispatching tasks.
- **R7 & R8 — Three-Layer Status Separation & Read-Only GitHub PR Reconciliation**:
  - Added `pr_reconcile` (`writeRequestsMade: 0`) querying `state=all` across pages, preserving known PR IDs even when body markers are deleted, reporting `unknown` honestly when unbound closed PR ownership cannot be proven, and strictly separating remote merge status from local goal acceptance (`PR merged B` while locally verified `A` never auto-greens the goal).

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
