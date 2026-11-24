# Platform Paths & Custom Locations

`scripts/install.mjs`, `install.ps1`, and `install.sh` automatically search standard locations across Windows, macOS, and Linux. Read this reference only when automatic discovery fails or the user has a custom installation path.

## Default Discovery Matrix

| OS | Default `DSH_HOME` | Auto-Discovered `dsh` CLI Locations | Bundled Node Fallback (`ELECTRON_RUN_AS_NODE=1`) |
| --- | --- | --- | --- |
| **Windows** | `%USERPROFILE%\.dsh` | `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`<br>`%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`<br>`dsh.cmd` on `PATH` | `<InstallDir>\DeepSeek Harness.exe` |
| **macOS** | `$HOME/.dsh` | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`<br>`~/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`<br>`dsh` on `PATH` | `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` |
| **Linux** | `$HOME/.dsh` | `/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh`<br>`/opt/deepseek-harness/resources/runtime/cli/bin/dsh`<br>`/usr/lib/deepseek-harness/resources/runtime/cli/bin/dsh`<br>`~/.local/share/deepseek-harness/resources/runtime/cli/bin/dsh`<br>`dsh` on `PATH` | `/opt/DeepSeek Harness/deepseek-harness` or `/opt/deepseek-harness/deepseek-harness` |

## Passing Explicit Paths

When DeepSeek Harness is installed on another drive (for example `D:\Apps\DeepSeek Harness` on Windows or a custom AppImage extracted directory on Linux), pass explicit flags instead of editing scripts:

### Windows PowerShell
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -DshInstallPath "D:\Apps\DeepSeek Harness" `
  -DshHome "C:\Users\<User>\.dsh" `
  -Profile "desktop" `
  -Json
```

### macOS / Linux
```bash
DSH_INSTALL_DIR="/custom/path/to/DeepSeek Harness.app" \
sh ./install.sh \
  --dsh-install-dir "/custom/path/to/DeepSeek Harness.app" \
  --dsh-home "$HOME/.dsh" \
  --profile desktop \
  --json
```

## Installed File Layout Inside `<dshHome>`

After a successful install, everything lives cleanly inside `<dshHome>`:

- `<dshHome>/local-packages/dsh-super-plugins/superagent` — self-contained `@local/dsh-superagent-menu` package
- `<dshHome>/local-packages/dsh-super-plugins/super-teams` — self-contained `@local/dsh-super-teams` package
- `<dshHome>/local-packages/dsh-super-plugins/skill-lock.json` — SHA-256 manifest of installed skill files
- `<dshHome>/skills/{superagent-workflow,workflow-quality,development-handoff,super-teams}` — regular directories (no symlinks/junctions)
- `<dshHome>/profiles/<profile>/plugin-data/dsh-super-teams/engine.sqlite` — created lazily on first engine run (WAL mode, persistent across restarts)
- `<dshHome>/profile-backups/dsh-super-plugins/<timestamp>` — automatic rollback snapshot (retains latest 2 backups)
