import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './goal-criteria.mjs';

const hashText = text => createHash('sha256').update(String(text)).digest('hex');

export const APPROVAL_PURPOSES = Object.freeze(['local_publish', 'remote_push', 'draft_pr', 'request_merge']);

/**
 * 规范化交付候选条目清单，保证双宿主（Codex 与 DSH）对相同输入产出完全一致的清单与摘要（R1 + R3）。
 */
export function canonicalizeCandidateEntries(entries = []) {
  return entries.map(item => ({
    kind: item.kind === 'integration_revision' ? 'integration_revision' : 'task',
    taskId: String(item.taskId),
    title: String(item.title ?? ''),
    snapshotId: String(item.snapshotId),
    patchSha256: String(item.patchSha256),
    ...(item.parentCandidateId ? { parentCandidateId: String(item.parentCandidateId) } : {}),
    ...(Array.isArray(item.affectedTaskIds) && item.affectedTaskIds.length
      ? { affectedTaskIds: [...item.affectedTaskIds].map(String).sort() }
      : {}),
  }));
}

export function computeCandidateManifestHash({
  repoPath,
  targetRef,
  baseCommit,
  parentCandidateId = null,
  criteriaRevision = null,
  gateHash = null,
  entries = [],
}) {
  const normalized = canonicalJson({
    repoPath: String(repoPath ?? ''),
    targetRef: String(targetRef ?? ''),
    baseCommit: String(baseCommit ?? ''),
    parentCandidateId: parentCandidateId ? String(parentCandidateId) : null,
    criteriaRevision: criteriaRevision ?? null,
    gateHash: gateHash ?? null,
    entries: canonicalizeCandidateEntries(entries),
  });
  return hashText(JSON.stringify(normalized));
}

/**
 * 判断候选构建是走增量修订路径（C1 + R1）还是从基线重组路径（R5）。
 * 规则：仅当 parentCandidate 存在、其全部 entries 是新清单的精确前缀、
 * 且尾部新增条目全部为针对该 parentCandidate 的 integration_revision 时，才走增量叠加。
 * 若发生任务快照替换（如 A1 -> A2）或撤回，则必须从基线按新清单重组，避免残留旧文件。
 */
export function planCandidateAssembly({ parentCandidate = null, entries = [] }) {
  const normalized = canonicalizeCandidateEntries(entries);
  if (!parentCandidate || !Array.isArray(parentCandidate.entries) || !parentCandidate.commitOid) {
    return { mode: 'full_replay', incrementalEntries: normalized, fullEntries: normalized };
  }
  const prev = canonicalizeCandidateEntries(parentCandidate.entries);
  if (normalized.length <= prev.length) {
    return { mode: 'full_replay', incrementalEntries: normalized, fullEntries: normalized };
  }
  for (let i = 0; i < prev.length; i++) {
    if (
      prev[i].taskId !== normalized[i].taskId
      || prev[i].snapshotId !== normalized[i].snapshotId
      || prev[i].patchSha256 !== normalized[i].patchSha256
      || prev[i].kind !== normalized[i].kind
    ) {
      return { mode: 'full_replay', incrementalEntries: normalized, fullEntries: normalized };
    }
  }
  const tail = normalized.slice(prev.length);
  const allBoundToParent = tail.every(
    item => item.kind === 'integration_revision' && item.parentCandidateId === parentCandidate.id,
  );
  if (!allBoundToParent) {
    return { mode: 'full_replay', incrementalEntries: normalized, fullEntries: normalized };
  }
  return {
    mode: 'incremental_revision',
    parentCandidateId: parentCandidate.id,
    parentCommitOid: parentCandidate.commitOid,
    incrementalEntries: tail,
    fullEntries: normalized,
  };
}

/**
 * 创建与特定候选、用途、目标位置和门禁版本强绑定的批准记录（R3）。
 */
export function createApprovalRecord({
  candidate,
  purpose = 'local_publish',
  targetRef,
  actor = 'user',
  note = null,
}) {
  if (!candidate?.id || !candidate?.commitOid) {
    throw new Error('Cannot create approval without a frozen candidate');
  }
  if (!APPROVAL_PURPOSES.includes(purpose)) {
    throw new Error(`Invalid approval purpose: ${purpose}`);
  }
  if (typeof targetRef !== 'string' || !targetRef.trim()) {
    throw new Error('Approval must bind an explicit targetRef');
  }
  return {
    id: randomUUID(),
    teamId: candidate.teamId,
    candidateId: candidate.id,
    candidateCommitOid: candidate.commitOid,
    candidateManifestHash: candidate.manifestHash,
    purpose,
    targetRef: targetRef.trim(),
    criteriaRevision: candidate.criteriaRevision ?? null,
    gateHash: candidate.gateHash ?? null,
    actor: String(actor || 'user').slice(0, 200),
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    revokeReason: null,
  };
}

/**
 * 严格核验批准是否可用于本次操作（R3：候选、批准用途、目标位置、门禁版本均不可漂移）。
 */
export function assertApprovalValid({
  approval,
  candidate,
  purpose,
  targetRef,
  currentCriteriaRevision = null,
  currentGateHash = null,
}) {
  if (!approval) {
    throw Object.assign(new Error('Approval record not found'), { code: 'APPROVAL_NOT_FOUND' });
  }
  if (approval.revokedAt) {
    throw Object.assign(
      new Error(`Approval ${approval.id} was revoked: ${approval.revokeReason ?? 'policy changed'}`),
      { code: 'APPROVAL_REVOKED' },
    );
  }
  if (approval.candidateId !== candidate?.id || approval.candidateCommitOid !== candidate?.commitOid) {
    throw Object.assign(
      new Error(`Approval ${approval.id} is bound to candidate ${approval.candidateId}, not ${candidate?.id}`),
      { code: 'APPROVAL_CANDIDATE_MISMATCH' },
    );
  }
  if (approval.purpose !== purpose) {
    throw Object.assign(
      new Error(`Approval ${approval.id} is restricted to purpose="${approval.purpose}", cannot execute "${purpose}"`),
      { code: 'APPROVAL_PURPOSE_MISMATCH' },
    );
  }
  if (approval.targetRef !== targetRef) {
    throw Object.assign(
      new Error(`Approval ${approval.id} is bound to targetRef="${approval.targetRef}", not "${targetRef}"`),
      { code: 'APPROVAL_TARGET_MISMATCH' },
    );
  }
  if (currentGateHash && approval.gateHash !== currentGateHash) {
    throw Object.assign(
      new Error(`Goal criteria gate changed (approval gate=${String(approval.gateHash ?? 'none').slice(0, 12)}, current=${currentGateHash.slice(0, 12)}); re-approval required`),
      { code: 'APPROVAL_GATE_DRIFT' },
    );
  }
  if (currentCriteriaRevision !== null && currentCriteriaRevision !== undefined && approval.criteriaRevision !== currentCriteriaRevision) {
    throw Object.assign(
      new Error(`Goal criteria revision changed (${approval.criteriaRevision ?? 'none'} -> ${currentCriteriaRevision}); re-approval required`),
      { code: 'APPROVAL_CRITERIA_DRIFT' },
    );
  }
  return true;
}

/**
 * 本地发布意图崩溃对账裁决（R4）。
 * 区分“Git 已更新但数据库记账前中断（匹配本意图 → 补收据）”与“被外部提交占用（external-drift → 停写）”。
 */
export function reconcileLocalPublishIntent({ intent, observedOid, zeroOid = '0'.repeat(40) }) {
  const actual = observedOid || zeroOid;
  if (actual === intent.targetOid) {
    return {
      outcome: 'confirmed_recovered',
      status: 'published',
      observedOid: actual,
      message: `Local ref ${intent.targetRef} matches planned frozen commit ${intent.targetOid.slice(0, 12)}; receipt recorded.`,
    };
  }
  if (actual === (intent.expectedOldOid || zeroOid)) {
    return {
      outcome: 'not_applied',
      status: 'aborted_before_git',
      observedOid: actual,
      message: `Local ref ${intent.targetRef} was not modified before crash; safe to retry with a new explicit action.`,
    };
  }
  return {
    outcome: 'external_drift',
    status: 'external_drift',
    observedOid: actual,
    message: `Local ref ${intent.targetRef} now points to unexpected commit ${actual.slice(0, 12)} (expected ${intent.expectedOldOid.slice(0, 12)} or ${intent.targetOid.slice(0, 12)}); writes halted.`,
  };
}
