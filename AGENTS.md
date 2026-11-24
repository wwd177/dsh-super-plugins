# AI Agent Instructions (`dsh-super-plugins`)

If the user asked you to **install, upgrade, verify, repair, or uninstall** the DeepSeek Harness plugins in this repository (`SuperAgent` + `Super Teams`):

1. Read and follow **[`skills/dsh-super-plugins-installer/SKILL.md`](skills/dsh-super-plugins-installer/SKILL.md)** step by step.
2. Always invoke the cross-platform installer with `--json` (`node ./scripts/install.mjs --json`, `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Json`, or `sh ./install.sh --json`) followed by `--verify --json`.
3. Never modify `~/.dsh/.credentials.yaml`, `~/.dsh/.env`, user chat transcripts, or unrelated plugins/skills.
