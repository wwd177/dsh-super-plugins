# SuperAgent & Super Teams for DeepSeek Harness

[中文说明](README.md) · [AI Agent Installer Skill](skills/dsh-super-plugins-installer/SKILL.md) · [Changelog](CHANGELOG.md)

Native multi-agent critical-path DAG orchestration engine, hardened `git-worktree` collaboration & atomic branch publishing, polyglot behavioral test gates, runtime write-scope mutex, and session-isolated right-sidebar **Team Workbench** for **DeepSeek Harness (`0.2.x` on Windows, macOS, and Linux)**.

Runs directly inside the DeepSeek Harness Cordis host process — **zero external daemons, zero separate MCP subprocesses, and zero global npm installs required**.

---

## Components

| Component | Package & Version | Role |
| --- | --- | --- |
| **SuperAgent Workflow & Protocol** | `@local/dsh-superagent-menu` (`1.25.0-dsh.1`) | Unified **SuperAgent** execution protocol: goal criteria freezing (R2), evidence-based routing, polyglot verification gates, and Git worktree delivery methodology; includes 3 skills plus `+` menu actions |
| **Super Teams Review Workbench & Shared Core** | `@local/dsh-super-teams` (`0.17.0-dsh.1`) | Powered by SHA-256 locked shared `engine-core 0.19.1` (`Engine 0.20.0-dsh.1`): isolated test environments with Windows long-path defense, exact active-subgraph critical-path scheduling, bounded auto-recovery (`recoveryTerminal` + 12-try cap), `expectedAttemptId`-pinned `resolve_unresolved`, strict multi-chat session affinity & transactional rebinding, budget guards, and lease-checked remote delivery |
| **AI Agent Installer Skill** | [`dsh-super-plugins-installer`](skills/dsh-super-plugins-installer/SKILL.md) (`1.4.0`) | Dedicated skill for any AI coding agent to safely install, verify, or multi-profile-safely uninstall via SQLite lock guard and profile-only purge protection |

---

## Highlights

- **Unified Persistent Engine Data Directory**: Metadata and event logs live in `~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/engine.sqlite` (SQLite WAL), while frozen SHA-256 deliverables, verified Git patches, registered sources, and active run directories live alongside it in `artifact-snapshots/`, `git-patches/`, `context/`, and `attempts/`.
- **Hardened `git-worktree` Mode & Sidebar UI Controls**: Create `git-worktree` teams either via tool parameters (`workspaceMode: "git-worktree"`, `repoPath`) or directly in the right-sidebar **New Team** modal, then run `merge_preview` and atomic create-only `merge_apply` (`superagent/<slug>`) directly from the overview without touching the user's active working tree.
- **Tiered Behavioral Gates (`node_test` + Polyglot `command_test`)**: Blocks shallow static checks and mutable repo commands from triggering `autoAccept: true`; `autoAccept` requires an immutable `ContextStore`-hosted `node_test`, while structured polyglot `command_test` runners (`node --test`, `pytest`, `cargo test`, `go test`, `dotnet test`, `npm test`) verify behavior to `checked` for explicit review.
- **Full-Lifecycle `writeScopes` Enforcement**: Combines a runtime scheduler mutex (`write-scope-lock`) with pre/post workspace checks (isolated mode) and two-tree `<attemptStartCommit>..<candidateCommit>` diff certification (`git-worktree` mode), rejecting undeclared files, renames, deletions, symlinks, and Windows junctions.
- **Dual Right-Sidebar & Strict Multi-Chat Isolation**: Integrates natively with stock `sidebarRightTabs` and `dsh-better-sidebar` using Shadow DOM + Constructable `CSSStyleSheet`. Server SSE/changes streams, `client.js`, and `app.js` all isolate `open-workbench` events by `sessionId` so opening chat B's team never hijacks chat A's mounted workbench.

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

## Verify, Backup & Uninstall

```bash
# Non-destructive health & SHA-256 parity check
node ./scripts/install.mjs --verify

# Clean uninstall (preserves plugin-data/dsh-super-teams/ unless --purge-data is passed, preserves legacy root plugin-data/dsh-super-teams, and preserves shared packages/skills while any sibling profile still references them)
node ./scripts/install.mjs --uninstall

# Run all 8 unit, persistence, bounded recovery, behavioral gate, security isolation, long-path, multi-profile SQLite lock, critical-path, remote delivery & parity suites
npm test
```

> **Important Backup Note (Do NOT Copy Only `engine.sqlite`)**: `engine.sqlite` stores metadata, event logs, and hash indexes only — it does **not** embed frozen deliverable files or Git patches. To preserve deliverables and patches safely, close DeepSeek Harness first and back up the **entire `~/.dsh/profiles/<profile>/plugin-data/dsh-super-teams/` directory** (`engine.sqlite`, `-wal`/`-shm`, `artifact-snapshots/`, `git-patches/`, `context/`, and `attempts/`).
>
> **Benchmark, Platform & CI Transparency Note**: External-repo live-model blind benchmark results and methodology are published at [`docs/benchmarks/live-benchmark-v0.20.0.md`](docs/benchmarks/live-benchmark-v0.20.0.md). The 18 (`6×3`) screening runs inside [`tests/v0200-env-bench-parity.test.mjs`](tests/v0200-env-bench-parity.test.mjs) use deterministic fixtures to test the harness pipeline and exact binomial sign test. Live regression runs were executed on Windows; POSIX (`macOS`/`Linux`) process-birth and installer logic are implemented and ready but remain unverified on live macOS/Linux hosts. A reference GitHub Actions workflow template is provided at [`docs/ci-workflow.example.yml`](docs/ci-workflow.example.yml).

## License

Released under the [MIT License](LICENSE). Third-party notices are included under `packages/super-teams/THIRD_PARTY_LICENSES`.
