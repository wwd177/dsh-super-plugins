# External-Repo Live-Model Blind Benchmark (`v0.20.0`)

- **Generated At**: `2026-11-27T11:38:53.849Z`
- **Host OS**: Windows (10.0.26200)
- **Locked Model / Effort**: `gpt-6.2-sol` / `effort=medium` (identical across `single_agent` and `codex_superagent`)
- **Sample Size**: 4 paired tasks across 2 isolated external ESM repositories (`repo-ledger`, `repo-queue`)
- **Leakage & Fairness Controls**: Crossed execution order (AB / BA), zero hidden tests on disk until both arms committed and exported to `.git`-free `blind-eval/` directories, isolated `buildIsolatedTestEnv` evaluation, zero manual rescue, full end-to-end accounting (Lead Planner + Workers + retries + wall clock).

## Arm Summary

| Arm | Primary Pass (`fixed_budget_no_rescue_hidden_pass`) | Planner Tokens | Worker Tokens | Total Tokens | End-to-End Wall Time |
|---|---:|---:|---:|---:|---:|
| `single_agent` | **2/4** (50.0%) | 0 | 974503 | 974503 | 446.2s |
| `codex_superagent` | **0/4** (0.0%) | 132979 | 1720704 | 1853683 | 585.6s |

- **Exact One-Sided Binomial Sign Test (`codex_superagent` vs `single_agent`)**: wins=0, losses=2, ties=2, discordantPairs=2, `p = 1`.
- **DSH Headless Arm Probe**: `skipped` (exit=1, wallMs=1516) — `MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment`.

## Per-Task Ledger

| Task | Order | Single Pass (Tests) | Single Tokens / Time | SuperAgent Pass (Tests) | SuperAgent Planner+Worker Tokens / Time | Failure Stage (if any) |
|---|---|---|---:|---|---:|---|
| `ledger-tax-refund` | single_agent -> codex_superagent | PASS (3/3) | 267380 tok / 124.9s | FAIL (0/1) | 34513+516343=550856 tok / 168.1s | team:hidden_eval_failed |
| `ledger-batch-reconcile` | codex_superagent -> single_agent | FAIL (2/3) | 189177 tok / 102.4s | FAIL (0/1) | 32176+550953=583129 tok / 178.8s | single:hidden_eval_failed, team:hidden_eval_failed |
| `queue-rate-dlq` | single_agent -> codex_superagent | PASS (3/3) | 267206 tok / 96.8s | FAIL (0/1) | 34261+459528=493789 tok / 113.6s | team:hidden_eval_failed |
| `queue-dag-runner` | codex_superagent -> single_agent | FAIL (1/2) | 250740 tok / 122.1s | FAIL (0/1) | 32029+193880=225909 tok / 125.0s | single:hidden_eval_failed, team:hidden_eval_failed |

## Statistical Scope & Limitations

- At `n = 4` paired tasks, even 4/4 discordant wins yields `p = 0.0625`; therefore this live screening benchmark establishes real end-to-end executability, token/wall-time accounting, and honest task-level deltas rather than a statistically powered claim of universal team speedup or cost savings across all workloads.
- In this run (`gpt-6.2-sol`, `effort=medium`), `single_agent` passed **2/4** tasks (9/11 sub-tests passed, 974,503 tokens, 446.2s), while `codex_superagent` passed **0/4** tasks (1,853,683 total tokens = 132,979 planner + 1,720,704 worker; 585.6s). In all 4 multi-agent runs, `blind-eval` hidden tests hit `ERR_MODULE_NOT_FOUND` on Wave-2 integration modules (`report.mjs`, `summary.mjs`, `dispatcher.mjs`, `executor.mjs`) because partial `mergeTeam` published only accepted Wave-1 subsets without blocking on unaccepted downstream tasks. No manual rescue was applied.
- Executed live on Windows with real Codex `app-server`; `dsh_headless` was probed directly without fabricating unavailable provider runs.
