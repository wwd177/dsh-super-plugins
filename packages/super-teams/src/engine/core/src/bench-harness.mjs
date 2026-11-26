import fs from 'node:fs';
import path from 'node:path';
import { exportCandidateForTesting } from './git-worktree.mjs';

const normalizePath = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

function isSameOrInside(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * 校验盲评配置，杜绝评测题库泄漏进被测仓库或选用引擎自身代码库自测作弊。
 */
export function validateBenchmarkConfig({ evalRoot, repos = [], engineRepoRoots = [] }) {
  if (!evalRoot || typeof evalRoot !== 'string') throw new Error('evalRoot is required');
  const resolvedEval = path.resolve(evalRoot);
  for (const repo of repos) {
    if (!repo?.repoPath) throw new Error(`Repo ${repo?.id ?? 'unknown'} requires repoPath`);
    const rp = path.resolve(repo.repoPath);
    if (isSameOrInside(resolvedEval, rp) || isSameOrInside(rp, resolvedEval)) {
      throw new Error(`Benchmark evalRoot (${resolvedEval}) must not overlap with target repo (${rp})`);
    }
    for (const engineRoot of engineRepoRoots) {
      const er = path.resolve(engineRoot);
      if (isSameOrInside(rp, er) || isSameOrInside(er, rp)) {
        throw new Error(`Benchmark target repo (${rp}) must not be the engine repository itself (${er})`);
      }
    }
  }
}

function nCk(n, k) {
  if (k < 0 || k > n) return 0;
  let num = 1;
  let den = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) {
    num *= n - i + 1;
    den *= i;
  }
  return num / den;
}

/**
 * 单侧精确二项符号检验（如 5/6 胜出 => 7/64 = 0.109375）。
 */
export function exactOneSidedSignTestPValue(wins, discordantPairs) {
  if (!Number.isInteger(discordantPairs) || discordantPairs <= 0) return 1;
  let sum = 0;
  for (let i = wins; i <= discordantPairs; i++) {
    sum += nCk(discordantPairs, i);
  }
  return sum / (2 ** discordantPairs);
}

function rotatedArmsForTask(arms, taskIndex) {
  const offset = taskIndex % arms.length;
  return [...arms.slice(offset), ...arms.slice(0, offset)];
}

/**
 * 执行预注册的 2 仓合计 6 题 × 3 臂 = 18 次筛查评测（Phase 0.4）。
 * - 隐藏评分套件仅由独立评分器持有，交付冻结后按 commitOid 导出至干净环境盲评；
 * - 唯一主指标：fixed_budget_no_rescue_hidden_pass；
 * - 轮换三臂顺序消除缓存与时段混杂；
 * - 可观察事件故障注入（含对单 Agent 等价事件）。
 */
export async function runScreeningBenchmark({
  evalRoot,
  repos,
  tasks,
  arms = ['codex_superagent', 'dsh_superagent', 'single_agent'],
  runnerByArm,
  evaluator,
  engineRepoRoots = [],
  minDiscordantWinAdvantage = 4,
}) {
  validateBenchmarkConfig({ evalRoot, repos, engineRepoRoots });
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Benchmark requires at least one task');
  const repoMap = new Map(repos.map(r => [r.id, r]));
  fs.mkdirSync(evalRoot, { recursive: true });

  const ledger = [];
  for (let tIdx = 0; tIdx < tasks.length; tIdx++) {
    const taskSpec = tasks[tIdx];
    const repo = repoMap.get(taskSpec.repoId);
    if (!repo) throw new Error(`Unknown repoId ${taskSpec.repoId} in benchmark task ${taskSpec.id}`);
    const orderedArms = rotatedArmsForTask(arms, tIdx);

    for (let aIdx = 0; aIdx < orderedArms.length; aIdx++) {
      const arm = orderedArms[aIdx];
      const runner = runnerByArm?.[arm];
      if (typeof runner !== 'function') throw new Error(`Missing benchmark runner for arm: ${arm}`);

      const runWorkDir = path.join(evalRoot, 'runs', `${taskSpec.id}-${arm}`);
      fs.rmSync(runWorkDir, { recursive: true, force: true });
      fs.mkdirSync(runWorkDir, { recursive: true });

      const startedAt = Date.now();
      const runResult = await runner({
        task: taskSpec,
        repo,
        arm,
        runIndex: aIdx,
        runWorkDir,
      });
      const wallMs = runResult?.wallMs ?? (Date.now() - startedAt);

      let hiddenPassed = false;
      let evalDetail = null;
      if (runResult?.commitOid) {
        const blindDir = path.join(evalRoot, 'blind-eval', `${taskSpec.id}-${arm}`);
        fs.rmSync(blindDir, { recursive: true, force: true });
        try {
          await exportCandidateForTesting({
            cwd: runResult.repoPath ?? repo.repoPath,
            candidateCommit: runResult.commitOid,
            destDir: blindDir,
          });
          const evalRes = await evaluator({ task: taskSpec, arm, evalDir: blindDir, commitOid: runResult.commitOid });
          hiddenPassed = Boolean(evalRes?.passed);
          evalDetail = evalRes?.detail ?? null;
        } finally {
          fs.rmSync(blindDir, { recursive: true, force: true });
        }
      }

      const rescueMinutes = Number(runResult?.rescueMinutes ?? 0);
      const unauthorizedWrite = Boolean(runResult?.unauthorizedWrite);
      const withinBudget = runResult?.withinBudget !== false;
      const cancelledOrAbandoned = Boolean(runResult?.cancelled || runResult?.abandoned);
      const primaryPass = Boolean(
        hiddenPassed && withinBudget && rescueMinutes === 0 && !unauthorizedWrite && !cancelledOrAbandoned,
      );

      ledger.push({
        taskId: taskSpec.id,
        repoId: taskSpec.repoId,
        arm,
        orderPosition: aIdx,
        primaryPass,
        hiddenPassed,
        withinBudget,
        rescueMinutes,
        totalTokens: Number(runResult?.totalTokens ?? 0),
        wallMs,
        failureStage: primaryPass ? null : (runResult?.failureStage ?? (hiddenPassed ? 'budget_or_rescue' : 'hidden_eval_failed')),
        unauthorizedWrite,
        cancelledOrAbandoned,
        evalDetail,
      });
    }
  }

  const byArm = {};
  for (const arm of arms) {
    const rows = ledger.filter(r => r.arm === arm);
    const passes = rows.filter(r => r.primaryPass).length;
    byArm[arm] = {
      runs: rows.length,
      primaryPassCount: passes,
      primaryPassRate: rows.length ? passes / rows.length : 0,
      totalRescueMinutes: rows.reduce((s, r) => s + r.rescueMinutes, 0),
      totalTokens: rows.reduce((s, r) => s + r.totalTokens, 0),
      totalWallMs: rows.reduce((s, r) => s + r.wallMs, 0),
      unauthorizedWrites: rows.filter(r => r.unauthorizedWrite).length,
    };
  }

  const baselineArm = arms.includes('single_agent') ? 'single_agent' : arms[arms.length - 1];
  const multiArms = arms.filter(a => a !== baselineArm);
  const comparisons = {};
  for (const mArm of multiArms) {
    let wins = 0;
    let losses = 0;
    for (const taskSpec of tasks) {
      const mRow = ledger.find(r => r.taskId === taskSpec.id && r.arm === mArm);
      const bRow = ledger.find(r => r.taskId === taskSpec.id && r.arm === baselineArm);
      if (mRow?.primaryPass && !bRow?.primaryPass) wins++;
      else if (!mRow?.primaryPass && bRow?.primaryPass) losses++;
    }
    const discordant = wins + losses;
    comparisons[mArm] = {
      baselineArm,
      wins,
      losses,
      ties: tasks.length - discordant,
      discordantPairs: discordant,
      oneSidedSignTestPValue: exactOneSidedSignTestPValue(wins, discordant),
    };
  }

  const anyStrongSignal = Object.values(comparisons).some(c => c.wins - c.losses >= minDiscordantWinAdvantage);
  const totalRuns = ledger.length;
  const gate2Decision = anyStrongSignal ? 'advance_to_holdout_confirm' : 'fix_and_retest_holdout';

  const ledgerPath = path.join(evalRoot, 'ledger.jsonl');
  fs.writeFileSync(ledgerPath, ledger.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const mdLines = [
    '# SuperAgent Screening Benchmark Ledger',
    '',
    `- Total runs: ${totalRuns} (${tasks.length} tasks × ${arms.length} arms, rotated order)`,
    `- Primary outcome: \`fixed_budget_no_rescue_hidden_pass\``,
    `- Gate 2 Decision: **${gate2Decision}** (screening batch only; holdout confirmation required before remote write enablement)`,
    '',
    '## Arm Summary',
    '',
    '| Arm | Runs | Primary Pass | Pass Rate | Rescue Min | Tokens | Unauthorized Writes |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...arms.map(arm => {
      const s = byArm[arm];
      return `| ${arm} | ${s.runs} | ${s.primaryPassCount} | ${(s.primaryPassRate * 100).toFixed(1)}% | ${s.totalRescueMinutes} | ${s.totalTokens} | ${s.unauthorizedWrites} |`;
    }),
    '',
    '## Paired Sign Test vs Single-Agent Baseline',
    '',
    ...Object.entries(comparisons).map(([arm, c]) => (
      `- **${arm}** vs \`${c.baselineArm}\`: wins=${c.wins}, losses=${c.losses}, ties=${c.ties}, discordant=${c.discordantPairs}, exact one-sided sign-test p=${c.oneSidedSignTestPValue.toFixed(6)}`
    )),
  ];
  const reportPath = path.join(evalRoot, 'report.md');
  fs.writeFileSync(reportPath, mdLines.join('\n') + '\n', 'utf8');

  return {
    totalRuns,
    byArm,
    comparisons,
    gate2Decision,
    ledgerPath,
    reportPath,
    ledger,
  };
}
