import { execFile } from 'node:child_process';

const INTENT_MARKER_RE = /<!--\s*superagent-intent:([a-zA-Z0-9._:-]+)\s*-->/;
const MAX_PAGES = 10;
const REPO_SEG_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[a-f0-9]{7,64}$/i;

export function validateRepoSlug(repo) {
  if (typeof repo !== 'string') {
    throw Object.assign(new Error('repo must be in "owner/name" format'), { code: 'INVALID_REPO' });
  }
  const trimmed = repo.trim();
  const parts = trimmed.split('/');
  if (
    parts.length !== 2 ||
    parts.some(seg => !REPO_SEG_RE.test(seg) || seg === '.' || seg === '..')
  ) {
    throw Object.assign(new Error('repo must be in strict "owner/name" format without path traversal'), { code: 'INVALID_REPO' });
  }
  return trimmed;
}

export function validateCommitSha(sha) {
  const trimmed = typeof sha === 'string' ? sha.trim() : '';
  if (!SHA_RE.test(trimmed)) {
    throw Object.assign(new Error('sha must be a 7..64-character hexadecimal commit hash'), { code: 'INVALID_SHA' });
  }
  return trimmed;
}

export function extractIntentMarker(body) {
  const match = INTENT_MARKER_RE.exec(String(body ?? ''));
  return match ? match[1] : null;
}

/**
 * 创建仅允许只读查询的 GitHub CLI 传输层（R8：v0.18 严格零写请求）。
 */
export function createGhReadOnlyTransport({ execFn = execFile, timeoutMs = 15000 } = {}) {
  const runGhJson = args => new Promise((resolve, reject) => {
    execFn('gh', args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(stderr || err.message || '').trim()}`));
        return;
      }
      try { resolve(JSON.parse(String(stdout || 'null'))); }
      catch (parseErr) { reject(new Error(`Invalid JSON from gh: ${parseErr.message}`)); }
    });
  });

  return {
    async getPullRequest({ repo, prNumber }) {
      const safeRepo = validateRepoSlug(repo);
      if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('prNumber must be a positive integer');
      const pr = await runGhJson(['api', '--method', 'GET', `repos/${safeRepo}/pulls/${prNumber}`]);
      return normalizeGitHubPr(pr);
    },
    async listPullRequests({ repo, state = 'all', head = null, base = null, page = 1, perPage = 50 }) {
      const safeRepo = validateRepoSlug(repo);
      const params = new URLSearchParams({ state, page: String(page), per_page: String(perPage) });
      if (head) params.set('head', head);
      if (base) params.set('base', base);
      const list = await runGhJson(['api', '--method', 'GET', `repos/${safeRepo}/pulls?${params.toString()}`]);
      return Array.isArray(list) ? list.map(normalizeGitHubPr) : [];
    },
    async listCheckRuns({ repo, sha }) {
      if (!sha) return [];
      const safeRepo = validateRepoSlug(repo);
      const safeSha = validateCommitSha(sha);
      const data = await runGhJson(['api', '--method', 'GET', `repos/${safeRepo}/commits/${safeSha}/check-runs`]);
      const runs = Array.isArray(data?.check_runs) ? data.check_runs : (Array.isArray(data) ? data : []);
      return runs.map(normalizeCheckRun);
    },
  };
}

export function normalizeGitHubPr(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const merged = Boolean(raw.merged || raw.merged_at || raw.state === 'merged');
  const prState = merged ? 'merged' : String(raw.state ?? 'unknown').toLowerCase();
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ''),
    url: String(raw.html_url ?? raw.url ?? ''),
    state: prState,
    draft: Boolean(raw.draft),
    merged,
    mergeCommitSha: raw.merge_commit_sha ?? raw.mergeCommitSha ?? null,
    headSha: raw.head?.sha ?? raw.headSha ?? null,
    headRef: raw.head?.ref ?? raw.headRef ?? null,
    headRepo: raw.head?.repo?.full_name ?? raw.headRepo ?? null,
    baseRef: raw.base?.ref ?? raw.baseRef ?? null,
    baseRepo: raw.base?.repo?.full_name ?? raw.baseRepo ?? null,
    body: String(raw.body ?? ''),
    updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
  };
}

export function normalizeCheckRun(raw) {
  return {
    name: String(raw?.name ?? 'check'),
    status: String(raw?.status ?? 'unknown').toLowerCase(),
    conclusion: raw?.conclusion ? String(raw.conclusion).toLowerCase() : null,
    headSha: raw?.head_sha ?? raw?.headSha ?? null,
    url: raw?.html_url ?? raw?.url ?? null,
  };
}

function summarizeRemoteChecks(checks = [], expectedHeadSha = null) {
  const list = Array.isArray(checks) ? checks : [];
  const relevant = expectedHeadSha
    ? list.filter(c => !c.headSha || c.headSha === expectedHeadSha)
    : list;
  const staleIgnored = list.length - relevant.length;
  const skippedOrNeutral = relevant.filter(c => ['skipped', 'neutral'].includes(String(c.conclusion ?? '').toLowerCase()));
  const failing = relevant.filter(c => ['failure', 'timed_out', 'action_required', 'cancelled', 'stale'].includes(String(c.conclusion ?? '').toLowerCase()));
  const pending = relevant.filter(c => c.status !== 'completed');
  const passed = relevant.filter(c => c.status === 'completed' && c.conclusion === 'success');
  return {
    total: relevant.length,
    passedCount: passed.length,
    failingCount: failing.length,
    pendingCount: pending.length,
    skippedOrNeutralCount: skippedOrNeutral.length,
    staleIgnoredCount: staleIgnored,
    hasSkippedOrNeutral: skippedOrNeutral.length > 0,
    allStrictlyPassed: relevant.length > 0 && failing.length === 0 && pending.length === 0 && skippedOrNeutral.length === 0,
    items: relevant,
  };
}

/**
 * 严格只读的 GitHub PR 关联与断线查证（R7 + R8）。
 *
 * 铁律：
 * 1. 绝不发起任何写请求（writeRequestsMade 恒为 0）。
 * 2. 已持久化 (repo, prNumber) 绑定时，直接按 ID 查证，即使 PR 正文 marker 被人工删除也能找回。
 * 3. 未绑定时，必须显式查 state="all" 并覆盖分页，按源仓、目标仓、head/base 分支与 marker 综合判定；
 *    归属证据不足（如关闭且 marker 被删且分支名不唯一/缺失）时保持 status="unknown"，绝不猜测或补发。
 * 4. 远端 PR 状态/合入事实、受审 head SHA 与本地目标验收严格分离展示：
 *    PR 已合入 B 但本地仅验收 A 时，同时呈现两项事实与版本差异，目标绝不自动变绿。
 */
export async function reconcileGitHubPrReadOnly({
  repo,
  prNumber = null,
  headRepo = null,
  headBranch = null,
  baseBranch = null,
  expectedIntentId = null,
  candidate = null,
  goalEvaluation = null,
  transport,
}) {
  const safeRepo = validateRepoSlug(repo);
  repo = safeRepo;
  if (!transport || typeof transport.getPullRequest !== 'function' || typeof transport.listPullRequests !== 'function') {
    throw new Error('A read-only GitHub transport (getPullRequest, listPullRequests) is required');
  }

  let pr = null;
  let lookupMode = 'unbound_search';
  let bodyMarker = null;
  let bodyMarkerMissing = false;
  let ambiguityReason = null;
  let pagesScanned = 0;

  if (Number.isInteger(prNumber) && prNumber > 0) {
    lookupMode = 'bound_id';
    const raw = await transport.getPullRequest({ repo, prNumber });
    pr = normalizeGitHubPr(raw);
    if (pr) {
      bodyMarker = extractIntentMarker(pr.body);
      if (expectedIntentId && bodyMarker !== expectedIntentId) {
        bodyMarkerMissing = true;
      }
    }
  } else {
    // 未绑定状态：必须显式查询 state='all'（覆盖 open / closed / merged）并分页扫描
    const collected = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await transport.listPullRequests({ repo, state: 'all', page, perPage: 50 });
      pagesScanned++;
      if (!Array.isArray(batch) || batch.length === 0) break;
      collected.push(...batch.map(normalizeGitHubPr).filter(Boolean));
      if (batch.length < 50) break;
    }

    const candidates = collected.filter(item => {
      if (headBranch && item.headRef !== headBranch) return false;
      if (baseBranch && item.baseRef !== baseBranch) return false;
      if (headRepo && item.headRepo && item.headRepo.toLowerCase() !== headRepo.toLowerCase()) return false;
      if (item.baseRepo && item.baseRepo.toLowerCase() !== repo.toLowerCase()) return false;
      return true;
    });

    if (expectedIntentId) {
      const markerMatches = candidates.filter(item => extractIntentMarker(item.body) === expectedIntentId);
      if (markerMatches.length === 1) {
        pr = markerMatches[0];
        bodyMarker = expectedIntentId;
      } else if (markerMatches.length > 1) {
        ambiguityReason = `Multiple PRs (${markerMatches.map(m => '#' + m.number).join(', ')}) matched intent marker ${expectedIntentId}`;
      } else {
        // marker 不存在（可能被删或不属于本次意图）：未绑定状态下，关闭/合入 PR 缺少 marker 归属证据时诚实保持 unknown
        const openUnique = candidates.filter(item => item.state === 'open');
        const closedOrMerged = candidates.filter(item => item.state !== 'open');
        if (closedOrMerged.length > 0) {
          ambiguityReason = `Found ${closedOrMerged.length} closed/merged PR(s) on branch "${headBranch ?? ''}" without intent marker ${expectedIntentId}; ownership cannot be proven without prior PR binding`;
        } else if (openUnique.length === 1 && candidate?.commitOid && openUnique[0].headSha === candidate.commitOid) {
          pr = openUnique[0];
          bodyMarkerMissing = true;
        } else {
          ambiguityReason = candidates.length === 0
            ? 'No matching PR found across open/closed/merged states'
            : `Ambiguous ownership among ${candidates.length} PR(s) without verified marker or head SHA match`;
        }
      }
    } else if (candidates.length === 1) {
      pr = candidates[0];
      bodyMarker = extractIntentMarker(pr.body);
    } else if (candidates.length > 1) {
      ambiguityReason = `Multiple PRs matched (${candidates.map(m => '#' + m.number).join(', ')}); pass an explicit prNumber to bind`;
    } else {
      ambiguityReason = 'No matching PR found across open/closed/merged states';
    }
  }

  const localCandidateCommit = candidate?.commitOid ?? null;
  const localGoalPassed = Boolean(goalEvaluation?.goalPassed);

  if (!pr) {
    return {
      ok: false,
      status: 'unknown',
      readOnly: true,
      writeRequestsMade: 0,
      lookupMode,
      pagesScanned,
      repo,
      pr: null,
      ambiguityReason: ambiguityReason ?? 'Pull request could not be verified',
      remoteMerged: false,
      versionMismatch: false,
      externalDrift: false,
      localFacts: {
        candidateId: candidate?.id ?? null,
        candidateCommitOid: localCandidateCommit,
        goalPassed: localGoalPassed,
        isPartial: Boolean(candidate?.isPartial),
        missingMandatoryCount: goalEvaluation?.missingMandatory?.length ?? 0,
      },
      observedAt: new Date().toISOString(),
    };
  }

  let checkRuns = [];
  if (typeof transport.listCheckRuns === 'function' && pr.headSha) {
    try {
      const rawChecks = await transport.listCheckRuns({ repo, sha: pr.headSha });
      checkRuns = Array.isArray(rawChecks) ? rawChecks.map(normalizeCheckRun) : [];
    } catch {
      checkRuns = [];
    }
  }
  const checksSummary = summarizeRemoteChecks(checkRuns, pr.headSha);
  const versionMismatch = Boolean(localCandidateCommit && pr.headSha && pr.headSha !== localCandidateCommit);
  const externalDrift = Boolean(versionMismatch);

  // R7 硬不变量：PR 已合入 B 但本地只验收 A，界面同时呈现两个事实，目标绝不能自动变绿
  const effectiveGoalPassed = localGoalPassed
    && !versionMismatch
    && !checksSummary.hasSkippedOrNeutral
    && checksSummary.failingCount === 0
    && checksSummary.pendingCount === 0;

  return {
    ok: true,
    status: externalDrift ? 'external_drift' : 'linked',
    readOnly: true,
    writeRequestsMade: 0,
    lookupMode,
    pagesScanned,
    repo,
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      draft: pr.draft,
      merged: pr.merged,
      mergeCommitSha: pr.mergeCommitSha,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      bodyMarker,
      bodyMarkerMissing,
      updatedAt: pr.updatedAt,
    },
    checksSummary,
    remoteMerged: pr.merged,
    versionMismatch,
    externalDrift,
    localFacts: {
      candidateId: candidate?.id ?? null,
      candidateCommitOid: localCandidateCommit,
      goalPassed: localGoalPassed,
      effectiveGoalPassed,
      isPartial: Boolean(candidate?.isPartial),
      missingMandatoryCount: goalEvaluation?.missingMandatory?.length ?? 0,
    },
    summaryNote: pr.merged && versionMismatch
      ? `远端 PR #${pr.number} 已合入（head ${pr.headSha?.slice(0, 12)}），但本地仅验收候选 ${localCandidateCommit?.slice(0, 12)}；目标验收不会自动变绿。`
      : externalDrift
        ? `检测到远端分支外部漂移（远端 head ${pr.headSha?.slice(0, 12)} ≠ 本地候选 ${localCandidateCommit?.slice(0, 12)}）；已记录只读观察，未执行任何写入。`
        : pr.merged
          ? `已核实远端 PR #${pr.number} 已合入 ${pr.baseRef}（合入提交 ${pr.mergeCommitSha?.slice(0, 12) ?? '未知'}）。`
          : `已只读关联 PR #${pr.number}（状态 ${pr.state}${pr.draft ? ' · 草稿' : ''}，head ${pr.headSha?.slice(0, 12) ?? '未知'}）。`,
    observedAt: new Date().toISOString(),
  };
}
