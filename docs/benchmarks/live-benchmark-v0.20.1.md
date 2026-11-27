# External-Repo Live-Model Blind Benchmark (`v0.20.1`)

- **Generated At**: `2026-11-27T12:42:37.749Z`
- **Host OS**: Windows (10.0.26200)
- **Locked Model / Effort**: `gpt-6.2-sol` / `effort=medium` (identical across `single_agent` and `codex_superagent`)
- **Sample Size**: 4 paired tasks across 2 isolated external ESM repositories (`repo-ledger`, `repo-queue`)
- **Leakage & Fairness Controls**: Crossed execution order (AB / BA), zero hidden tests on disk until both arms committed and exported to `.git`-free `blind-eval/` directories, isolated `buildIsolatedTestEnv` evaluation, zero manual rescue, full end-to-end accounting (Lead Planner + Workers + retries + wall clock).

## Arm Summary

| Arm | Primary Pass (`fixed_budget_no_rescue_hidden_pass`) | Planner Tokens | Worker Tokens | Total Tokens | End-to-End Wall Time |
|---|---:|---:|---:|---:|---:|
| `single_agent` | **3/4** (75.0%) | 0 | 1308941 | 1308941 | 559.5s |
| `codex_superagent` | **1/4** (25.0%) | 137090 | 2687917 | 2825007 | 1240.6s |

- **Exact One-Sided Binomial Sign Test (`codex_superagent` vs `single_agent`)**: wins=0, losses=2, ties=2, discordantPairs=2, `p = 1`.
- **DSH Headless Arm Probe**: `skipped` (exit=1, wallMs=4124) — note: `{"type":"session","sessionId":"session-b34beacb-6831-4233-81bb-863f75cb1df1","cwd":"<local-path>"} {"type":"status","phase":"turn_start","turn":1} {"type":"status","phase":"step_start","turn":1,"step":1} {"type":"status","phase":"step_end","turn":1,"step":1} {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment","code":"MISSING_CREDENTIAL"}}} {"type":`.

## Per-Task Ledger

| Task | Order | Single Pass (Tests) | Single Tokens / Time | SuperAgent Pass (Tests) | SuperAgent Planner+Worker Tokens / Time | Failure Stage (if any) |
|---|---|---|---:|---|---:|---|
| `ledger-tax-refund` | single_agent -> codex_superagent | PASS (3/3) | 403006 tok / 171.7s | PASS (3/3) | 34331+737106=771437 tok / 270.9s | none |
| `ledger-batch-reconcile` | codex_superagent -> single_agent | PASS (3/3) | 270707 tok / 123.0s | FAIL (2/3) | 34175+720630=754805 tok / 220.7s | team:hidden_eval_failed |
| `queue-rate-dlq` | single_agent -> codex_superagent | PASS (3/3) | 368767 tok / 126.3s | FAIL (0/1) | 34263+503122=537385 tok / 513.8s | team:merge_failed |
| `queue-dag-runner` | codex_superagent -> single_agent | FAIL (1/2) | 266461 tok / 138.4s | FAIL (1/2) | 34321+727059=761380 tok / 235.2s | single:hidden_eval_failed, team:hidden_eval_failed |

## Statistical Scope & Limitations

- At `n = 4` paired tasks, even 4/4 discordant wins yields `p = 0.0625`; therefore this live screening benchmark establishes real end-to-end executability, token/wall-time accounting, and honest task-level deltas rather than a statistically powered claim of universal team speedup or cost savings across all workloads.
- Executed live on Windows with real Codex `app-server`; `dsh_headless` was probed directly without fabricating unavailable provider runs.
