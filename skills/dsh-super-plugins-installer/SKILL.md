---
name: dsh-super-plugins-installer
metadata:
  version: 1.0.1
  targets: DeepSeek Harness (>=0.2.0-rc.1 <0.3.0-0)
description: Install, upgrade, verify, or uninstall the SuperAgent (@local/dsh-superagent-menu) and Super Teams (@local/dsh-super-teams) plugins plus their 4 companion skills into DeepSeek Harness on Windows, macOS, or Linux. Use whenever a user asks an AI agent to install, update, repair, check, or remove SuperAgent / Super Teams / dsh-super-plugins for DeepSeek Harness.
---

# DeepSeek Harness · SuperAgent & Super Teams Installer Skill

Follow this deterministic, non-destructive playbook to install **both** plugins (`@local/dsh-superagent-menu` `1.21.1-dsh.1` and `@local/dsh-super-teams` `0.13.1-dsh.1`, powered by persistent SQLite WAL Engine `0.16.1-dsh.1`) and their **4 companion skills** (`superagent-workflow`, `workflow-quality`, `development-handoff`, `super-teams`) into a user's local **DeepSeek Harness** (`0.2.x`) installation on **Windows, macOS, or Linux**.

## Mandatory Safety Guardrails

1. **Never touch user secrets or active settings**: Do NOT read, edit, or delete `~/.dsh/.credentials.yaml`, `~/.dsh/.env`, `~/.dsh/cordis.patch.yml`, user chat transcripts, or main-session model settings.
2. **Preserve all existing plugins and skills**: Never overwrite or remove unrelated entries in `~/.dsh/profiles/<profile>/package.json` or `~/.dsh/skills/`.
3. **Self-contained installation only**: Always use the repository's `scripts/install.mjs` (or `./install.ps1` / `./install.sh`), which copies version-locked packages into `<dshHome>/local-packages/dsh-super-plugins` via `file:` protocol and copies regular non-symlink skill directories into `<dshHome>/skills`. Do NOT manually wire `link:` paths to temporary directories or create broken symlinks/junctions.
4. **Zero extra global installs**: If system `node` (`>=22`) is not installed on the user's machine, use `./install.ps1` (Windows) or `./install.sh` (macOS/Linux), which automatically executes `scripts/install.mjs` using DeepSeek Harness's own bundled Electron runtime (`ELECTRON_RUN_AS_NODE=1`).

---

## Step-by-Step Execution Playbook

### Step 1: Locate or Acquire the Repository Source

Check where `scripts/install.mjs` is located before cloning anything:

1. **Already inside the repository checkout**: Check `./scripts/install.mjs` in the current working directory.
2. **Running from an installed copy of this skill inside the repository**: Check `../../scripts/install.mjs` relative to this `SKILL.md` file.
3. **Standalone skill only (repository not yet on disk)**:
   - Use the GitHub repository URL provided by the user, or default to `https://github.com/wwd177/dsh-super-plugins.git`:
   - Clone into a fresh temporary directory:
     ```bash
     git clone --depth 1 https://github.com/wwd177/dsh-super-plugins.git "<TEMP_DIR>/dsh-super-plugins"
     ```
   - Verify that `<REPO_ROOT>/packages/superagent/package.json`, `<REPO_ROOT>/packages/super-teams/package.json`, and `<REPO_ROOT>/scripts/install.mjs` all exist before continuing.

### Step 2: Pre-Flight Host & Profile Check

Verify that DeepSeek Harness has been initialized on this machine:

- Default `DSH_HOME` is `~/.dsh` (`%USERPROFILE%\.dsh` on Windows, `$HOME/.dsh` on macOS/Linux) unless `$DSH_HOME` is set or the user specifies another directory.
- Default profile is `desktop` (`<dshHome>/profiles/desktop/package.json`).
- **If `<dshHome>/profiles/desktop/package.json` does not exist**:
  - Check whether DeepSeek Harness is installed in a non-standard location (see [Platform Paths & Custom Locations](references/platform-paths.md)).
  - Tell the user to launch DeepSeek Harness Desktop once so it initializes `~/.dsh/profiles/desktop`, then resume Step 3.

### Step 3: Run the Self-Contained Installer (`--json`)

Run from `<REPO_ROOT>` and capture the JSON output:

- **Windows (PowerShell / pwsh — works with or without system Node.js)**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Json
  ```
- **macOS / Linux (POSIX sh — works with or without system Node.js)**:
  ```bash
  sh ./install.sh --json
  ```
- **Direct Node (`>=22.13.0`) on any OS**:
  ```bash
  node ./scripts/install.mjs --json
  ```

*(Optional flags if the user has a custom setup: `--dsh-home "<dir>"`, `--dsh-install-dir "<appDir>"`, `--dsh-cli "<pathToDsh>"`, `--profile "<name>"`; see [Platform Paths](references/platform-paths.md).)*

Confirm the JSON response contains `"ok": true`. If `"ok": false` or non-zero exit code occurs, consult [Troubleshooting & Rollback](references/troubleshooting.md) instead of improvising manual edits to `pnpm-lock.yaml`.

### Step 4: Mandatory Post-Install Verification

Immediately run the non-destructive verifier and parse its JSON output:

- **Windows**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Verify -Json
  ```
- **macOS / Linux**:
  ```bash
  sh ./install.sh --verify --json
  ```

Verify all 3 conditions from the JSON output before declaring success:
1. `"ok": true`
2. Both `@local/dsh-superagent-menu` and `@local/dsh-super-teams` appear in `"plugins"` with self-contained specs (`link:` / `file:`) pointing inside `<dshHome>/local-packages/dsh-super-plugins`.
3. `"skills"` lists all 4 skills (`superagent-workflow`, `workflow-quality`, `development-handoff`, `super-teams`) verified against SHA-256 locks.

### Step 5: Clean Up Temporary Clone & Report to User

1. If you created a temporary `git clone` directory in Step 1, remove that temporary directory now (the installed plugins and skills inside `~/.dsh` are 100% self-contained and do not depend on the checkout directory).
2. Report concisely to the user:
   - **Installed components**: `SuperAgent 1.21.1-dsh.1`, `Super Teams 0.13.1-dsh.1` (SQLite WAL `Engine 0.16.1-dsh.1`), and 4 verified skills.
   - **Backup directory**: Path from `"backup"` in Step 3's JSON output.
   - **Next action required from user**: **Restart DeepSeek Harness once** to load the new plugins and right-sidebar「团队工作台」(Team Workbench), then type `/superagent-workflow` or click `+` → `SuperAgent 团队工作台` in any chat session.

---

## Upgrade & Uninstall Commands

- **Upgrade**: Pull or download the newer release and re-run Step 3 + Step 4 (`scripts/install.mjs` idempotently backs up the prior state, updates `local-packages`, refreshes all 4 skills, and preserves existing `engine.sqlite` team data).
- **Clean Uninstall (preserves team history in `engine.sqlite`)**:
  - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Json`
  - macOS / Linux: `sh ./install.sh --uninstall --json`
  - *(Only pass `-PurgeData` / `--purge-data` if the user explicitly asks to delete all saved teams and snapshots in `plugin-data/dsh-super-teams`.)*
