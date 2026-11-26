import { createHash, randomUUID } from 'node:crypto';

const hashText = text => createHash('sha256').update(String(text)).digest('hex');

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalJson(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * 将用户原始目标文本拆解为稳定、可追溯的需求原文段落（R2）。
 * 保证每段有意义的原始需求都能追踪到是否存在覆盖条件，避免 AI 拆解静默漏项。
 */
export function extractRequirementSegments(rawGoal) {
  const normalized = String(rawGoal ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const rawChunks = normalized
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[。！？；;])\s*|\s*(?:^|\s)(?=\d+[.)、]\s)/))
    .map(chunk => chunk.replace(/^[-*•\d.)、\s]+/, '').trim())
    .filter(chunk => chunk.length >= 2);
  const seen = new Set();
  const segments = [];
  for (const text of rawChunks) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = `seg-${segments.length + 1}`;
    segments.push({ id, text, sha256: hashText(text).slice(0, 16) });
  }
  return segments;
}

function normalizeTextForMatch(str) {
  return String(str ?? '').toLowerCase().replace(/[\s`'"“”‘’.,;:!?，。；：！？()（）[\]【】]/g, '');
}

function segmentMatchesCriterion(segment, criterion) {
  if (Array.isArray(criterion.sourceSegmentIds) && criterion.sourceSegmentIds.includes(segment.id)) return true;
  if (typeof criterion.sourceQuote === 'string' && criterion.sourceQuote.trim()) {
    const q = normalizeTextForMatch(criterion.sourceQuote);
    const s = normalizeTextForMatch(segment.text);
    if (q && s && (s.includes(q) || q.includes(s))) return true;
  }
  const reqNorm = normalizeTextForMatch(criterion.requirementText);
  const segNorm = normalizeTextForMatch(segment.text);
  if (!reqNorm || !segNorm) return false;
  if (reqNorm.includes(segNorm) || segNorm.includes(reqNorm)) return true;
  return false;
}

/**
 * 生成筹备期可审阅的目标与验收策略草案，显式暴露所有未覆盖的用户原话段落（R2）。
 */
export function buildCriteriaDraft({ rawGoal, criteria = [], dispositions = [] }) {
  const segments = extractRequirementSegments(rawGoal);
  const segIds = new Set(segments.map(s => s.id));
  const normalizedCriteria = [];
  const seenIds = new Set();

  for (let i = 0; i < criteria.length; i++) {
    const item = criteria[i];
    if (!item || typeof item !== 'object') throw new Error(`Criterion at index ${i} must be an object`);
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `crit-${i + 1}`;
    if (seenIds.has(id)) throw new Error(`Duplicate criterion id: ${id}`);
    seenIds.add(id);
    const requirementText = String(item.requirementText ?? item.title ?? '').trim();
    if (!requirementText) throw new Error(`Criterion ${id} requires non-empty requirementText`);
    const mandatory = item.mandatory !== false;
    const verificationMode = item.verificationMode ?? (item.checkId || item.checkSpec ? 'check' : 'human_signoff');
    if (!['check', 'human_signoff'].includes(verificationMode)) {
      throw new Error(`Criterion ${id} verificationMode must be "check" or "human_signoff"`);
    }
    const sourceSegmentIds = Array.isArray(item.sourceSegmentIds)
      ? item.sourceSegmentIds.filter(sid => segIds.has(sid))
      : [];
    const sourceQuote = typeof item.sourceQuote === 'string' && item.sourceQuote.trim()
      ? item.sourceQuote.trim()
      : null;
    if (verificationMode === 'check') {
      const hasBinding = Boolean(
        (typeof item.checkId === 'string' && item.checkId.trim())
        || (item.checkSpec && typeof item.checkSpec === 'object' && typeof item.checkSpec.type === 'string')
        || (typeof item.taskId === 'string' && item.taskId.trim())
      );
      if (!hasBinding) {
        throw new Error(`Criterion ${id} with verificationMode="check" must specify checkId, checkSpec, or taskId`);
      }
    }
    normalizedCriteria.push({
      id,
      requirementText,
      mandatory,
      verificationMode,
      sourceSegmentIds,
      sourceQuote,
      checkId: typeof item.checkId === 'string' && item.checkId.trim() ? item.checkId.trim() : null,
      checkSpec: item.checkSpec ?? null,
      taskId: typeof item.taskId === 'string' && item.taskId.trim() ? item.taskId.trim() : null,
      signoffRole: typeof item.signoffRole === 'string' && item.signoffRole.trim() ? item.signoffRole.trim() : (verificationMode === 'human_signoff' ? 'maintainer' : null),
    });
  }

  const dispMap = new Map();
  for (const d of dispositions ?? []) {
    if (!d || typeof d.segmentId !== 'string' || !segIds.has(d.segmentId)) continue;
    if (!['deferred', 'out_of_scope', 'merged_into_criterion'].includes(d.action)) {
      throw new Error(`Invalid disposition action for ${d.segmentId}: ${d.action}`);
    }
    if (typeof d.reason !== 'string' || !d.reason.trim()) {
      throw new Error(`Disposition for ${d.segmentId} requires a non-empty reason`);
    }
    dispMap.set(d.segmentId, {
      segmentId: d.segmentId,
      action: d.action,
      reason: d.reason.trim(),
      ...(d.criterionId ? { criterionId: String(d.criterionId).trim() } : {}),
    });
  }

  const unmappedSegments = [];
  const mappedSegments = [];
  for (const seg of segments) {
    const matchedBy = normalizedCriteria.filter(c => segmentMatchesCriterion(seg, c)).map(c => c.id);
    const disp = dispMap.get(seg.id) ?? null;
    if (matchedBy.length > 0 || disp) {
      mappedSegments.push({ ...seg, matchedCriteriaIds: matchedBy, disposition: disp });
    } else {
      unmappedSegments.push({ ...seg, warning: '该段用户原话尚未映射到任何必达/选做条件，也未记录明确处置说明' });
    }
  }

  const gateMaterial = canonicalJson({
    rawGoal: String(rawGoal ?? '').trim(),
    criteria: normalizedCriteria,
    dispositions: [...dispMap.values()],
  });
  const gateHash = hashText(JSON.stringify(gateMaterial));

  return {
    rawGoal: String(rawGoal ?? '').trim(),
    segments,
    mappedSegments,
    unmappedSegments,
    criteria: normalizedCriteria,
    dispositions: [...dispMap.values()],
    gateHash,
  };
}

/**
 * 显式冻结目标和验收策略，生成递增的不可变 criteriaRevision（R2）。
 */
export function freezeGoalCriteria({
  teamId,
  rawGoal,
  criteria = [],
  dispositions = [],
  confirmedBy,
  priorRevision = 0,
  allowUnmappedDraft = false,
}) {
  if (typeof confirmedBy !== 'string' || !confirmedBy.trim()) {
    throw new Error('Freezing goal criteria requires a non-empty confirmedBy identity');
  }
  const draft = buildCriteriaDraft({ rawGoal, criteria, dispositions });
  if (!allowUnmappedDraft && draft.unmappedSegments.length > 0) {
    // 仍允许冻结并在工作台暴露未处置原文，但明确标记 hasUnmappedRequirements=true，目标门禁无法自动变绿
  }
  const revision = Number.isInteger(priorRevision) && priorRevision >= 0 ? priorRevision + 1 : 1;
  return {
    id: randomUUID(),
    teamId,
    revision,
    ...draft,
    hasUnmappedRequirements: draft.unmappedSegments.length > 0,
    confirmedBy: confirmedBy.trim(),
    confirmedAt: new Date().toISOString(),
  };
}

/**
 * 校验单条行为测试证据是否构成有效通过（R2：空测试、跳过、neutral、旧 SHA 绿灯均不满足必达项）。
 */
export function isValidBehavioralEvidence(evidence, expectedCommitOid = null) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (evidence.passed !== true) return false;
  const status = String(evidence.status ?? 'passed').toLowerCase();
  if (['skipped', 'neutral', 'pending', 'cancelled', 'timed_out', 'not_verified', 'empty'].includes(status)) {
    return false;
  }
  if (typeof evidence.testsRun === 'number' && evidence.testsRun <= 0) return false;
  if (expectedCommitOid && evidence.commitOid && evidence.commitOid !== expectedCommitOid) {
    return false;
  }
  return true;
}

/**
 * 按 R2 + R7 对给定候选评估全部必达/选做目标条件。
 * 区分：可供审阅（部分成果）、目标已验收（全必达满足且无未处置原话）、远端合入（由外部核实）。
 */
export function evaluateGoalCriteria({
  frozenCriteria,
  candidate = null,
  tasks = [],
  checkEvidence = {},
  signoffs = [],
}) {
  const candidateId = candidate?.id ?? null;
  const commitOid = candidate?.commitOid ?? null;
  const taskById = new Map((tasks ?? []).map(t => [t.id, t]));
  const signoffByCriterion = new Map();
  for (const s of signoffs ?? []) {
    if (!s || typeof s.criterionId !== 'string' || typeof s.signer !== 'string' || !s.signer.trim()) continue;
    if (candidateId && s.candidateId && s.candidateId !== candidateId) continue;
    if (frozenCriteria?.revision && s.criteriaRevision && s.criteriaRevision !== frozenCriteria.revision) continue;
    signoffByCriterion.set(s.criterionId, s);
  }

  if (!frozenCriteria) {
    return {
      criteriaRevision: null,
      gateHash: null,
      goalPassed: false,
      readyForReview: Boolean(candidate),
      readyToRequestMerge: false,
      unmappedSegments: [],
      missingMandatory: [{ id: 'criteria-unfrozen', reason: '目标与验收策略尚未显式冻结' }],
      itemResults: [],
    };
  }

  const itemResults = [];
  const missingMandatory = [];

  for (const crit of frozenCriteria.criteria ?? []) {
    let satisfied = false;
    let status = 'missing';
    let detail = null;

    if (crit.verificationMode === 'human_signoff') {
      const signoff = signoffByCriterion.get(crit.id);
      if (signoff) {
        satisfied = true;
        status = 'signed_off';
        detail = { signer: signoff.signer, at: signoff.at, note: signoff.note ?? null };
      } else {
        status = 'awaiting_signoff';
        detail = { requiredRole: crit.signoffRole ?? 'maintainer' };
      }
    } else {
      // verificationMode === 'check'
      const directEv = (crit.checkId && checkEvidence[crit.checkId]) || checkEvidence[crit.id] || null;
      if (directEv) {
        if (isValidBehavioralEvidence(directEv, commitOid)) {
          satisfied = true;
          status = 'verified';
          detail = directEv;
        } else {
          status = directEv.status && ['skipped', 'neutral'].includes(String(directEv.status).toLowerCase())
            ? `rejected_${String(directEv.status).toLowerCase()}`
            : 'check_failed_or_stale';
          detail = directEv;
        }
      } else if (crit.taskId) {
        const task = taskById.get(crit.taskId);
        const includedInCandidate = !candidate
          || (candidate.entries ?? []).some(e => e.taskId === crit.taskId && e.snapshotId === task?.acceptance?.snapshotId);
        const hasRealBehavioralCheck = Boolean(
          task?.state === 'accepted'
          && task?.verification?.passed === true
          && task?.verification?.status === 'passed'
          && Array.isArray(task?.checks)
          && task.checks.some(c => c.type === 'node_test' || c.type === 'command_test')
        );
        if (task && includedInCandidate && hasRealBehavioralCheck) {
          satisfied = true;
          status = 'verified_by_task';
          detail = { taskId: task.id, snapshotId: task.acceptance?.snapshotId ?? null };
        } else if (task && !includedInCandidate) {
          status = 'task_not_in_candidate';
          detail = { taskId: task.id, taskState: task.state };
        } else {
          status = 'missing_behavioral_evidence';
          detail = { taskId: crit.taskId, taskState: task?.state ?? 'missing' };
        }
      }
    }

    itemResults.push({
      id: crit.id,
      requirementText: crit.requirementText,
      mandatory: crit.mandatory,
      verificationMode: crit.verificationMode,
      satisfied,
      status,
      detail,
    });

    if (crit.mandatory && !satisfied) {
      missingMandatory.push({
        id: crit.id,
        requirementText: crit.requirementText,
        status,
        detail,
      });
    }
  }

  const unmappedSegments = frozenCriteria.unmappedSegments ?? [];
  const goalPassed = unmappedSegments.length === 0 && missingMandatory.length === 0 && (frozenCriteria.criteria?.length ?? 0) > 0;

  return {
    criteriaRevision: frozenCriteria.revision,
    gateHash: frozenCriteria.gateHash,
    goalPassed,
    readyForReview: Boolean(candidate),
    readyToRequestMerge: Boolean(candidate && goalPassed),
    unmappedSegments,
    missingMandatory,
    itemResults,
  };
}
