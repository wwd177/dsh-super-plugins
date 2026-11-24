# Troubleshooting & Rollback

## 1. `DeepSeek Harness profile "desktop" not found`
- **Cause**: DeepSeek Harness was just installed and has never been launched, or the user uses a custom `DSH_HOME`.
- **Fix**: Ask the user to launch DeepSeek Harness once so it creates `~/.dsh/profiles/desktop/package.json`, then re-run Step 3.

## 2. `Could not locate DeepSeek Harness CLI (dsh / dsh.cmd)`
- **Cause**: DeepSeek Harness is installed in a custom directory (portable folder, non-C: drive on Windows, or custom Linux AppImage extract).
- **Fix**: Locate `DeepSeek Harness.exe` / `DeepSeek Harness.app` / `deepseek-harness` on disk and pass `--dsh-install-dir "<dir>"` (or `-DshInstallPath "<dir>"` in `install.ps1`). Never guess or synthesize `pnpm` commands against `~/.dsh/profiles/desktop` without `dsh plugin add`, because `dsh plugin add` updates `dsh.profile.bundles` and `cordis.yml` atomically.

## 3. PowerShell `PSSecurityException` (`running scripts is disabled on this system`)
- **Fix**: Always invoke `install.ps1` with `-ExecutionPolicy Bypass`:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Json
  ```

## 4. `dsh CLI exited with status ...` due to profile lock
- **Cause**: Another `dsh plugin` operation is running concurrently in DeepSeek Harness Settings → Plugins.
- **Fix**: Wait a few seconds for the in-app plugin manager operation to finish (or ask the user to close DeepSeek Harness Settings), then re-run the exact same install command.

## 5. DeepSeek Harness Compatibility Range Mismatch
- These packages declare `"engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0", "node": ">=22.13.0" }`.
- If the user is on an older `0.1.x` build of DeepSeek Harness, advise upgrading DeepSeek Harness to `0.2.x` rather than forcing an incompatible manifest edit.

## 6. Instant Rollback / Clean Uninstall
- Run `--uninstall` to remove both plugins and all 4 skills cleanly:
  ```bash
  node ./scripts/install.mjs --uninstall --json
  ```
- Every install also writes a full profile snapshot (`package.json`, `pnpm-lock.yaml`, `cordis.patch.yml`, `cordis.yml`, and `previous-skills.json`) into `<dshHome>/profile-backups/dsh-super-plugins/<timestamp>`.
