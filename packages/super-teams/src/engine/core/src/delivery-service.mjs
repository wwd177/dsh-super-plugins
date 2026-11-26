import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CORE_VERSION,
  CORE_PROTOCOL,
} from './core-version.mjs';
import {
  buildCriteriaDraft,
  freezeGoalCriteria,
  evaluateGoalCriteria,
} from './goal-criteria.mjs';
import {
  canonicalizeCandidateEntries,
  computeCandidateManifestHash,
  createApprovalRecord,
  assertApprovalValid,
  reconcileLocalPublishIntent,
} from './delivery-candidate.mjs';
import {
  ZERO_OID,
  sanitizeSuperagentBranch,
  assembleCandidateCommit,
  publishFrozenCandidateRef,
  inspectLocalRef,
  probeBaseDrift,
} from './git-worktree.mjs';
import {
  createGhReadOnlyTransport,
  reconcileGitHubPrReadOnly,
} from './github-readonly.mjs';

const now = () => new Date().toISOString();

/**
 * 共享交付候选、目标门禁、本地原子发布与只读 GitHub PR 对账服务（v0.18 R1-R8）。
 * 由 Codex Engine 与 DeepSeek Harness Engine 共同持有同一锁定版本，保证双宿主行为严格一致。
 */
export class DeliveryService {
  constructor({
    engine,
    runStandaloneCheck,
    validateCheck,
    isBehavioralCheck,
  }) {
    this.engine = engine;
    this.runStandaloneCheck = runStandaloneCheck;
    this.validateCheck = validateCheck;
    this.isBehavioralCheck = isBehavioralCheck;
  }

  get store() { return this.engine.store; }
  get dataDir() { return this.engine.dataDir; }

  _team(teamId) {
    return this.engine._team(teamId);
  }

  _saveTeam(team, type) {
    return this.engine._saveTeam(team, type);
  }

  // ==================== R2：目标与验收策略显式冻结 ====================

  previewGoalCriteria(teamId, { rawGoal = null, criteria = [], dispositions = [] } = {}) {
    const team = this._team(teamId);
    const goalText = rawGoal !== null && rawGoal !== undefined ? String(rawGoal) : team.goal;
    const draft = buildCriteriaDraft({ rawGoal: goalText, criteria, dispositions });
    const latest = this.store.latestGoalCriteria(team.id);
    return {
      teamId: team.id,
      coreVersion: CORE_VERSION,
      protocol: CORE_PROTOCOL,
      latestFrozenRevision: latest?.revision ?? 0,
      draft,
    };
  }

  freezeCriteria(teamId, { rawGoal = null, criteria = [], dispositions = [], confirmedBy = 'maintainer' } = {}) {
    const team = this._team(teamId);
    const goalText = rawGoal !== null && rawGoal !== undefined ? String(rawGoal) : team.goal;
    const latest = this.store.latestGoalCriteria(team.id);
    const frozen = freezeGoalCriteria({
      teamId: team.id,
      rawGoal: goalText,
      criteria,
      dispositions,
      confirmedBy,
      priorRevision: latest?.revision ?? 0,
      allowUnmappedDraft: true,
    });
    this.store.saveGoalCriteria(frozen);
    // R3：当目标门禁改变产生新版本时，记录事件（历史批准保留原 gateHash，后续校验会自动拦截漂移）
    const freshTeam = this._team(team.id);
    freshTeam.criteriaRevision = frozen.revision;
    freshTeam.criteriaGateHash = frozen.gateHash;
    this._saveTeam(freshTeam, 'criteria-frozen');
    return frozen;
  }

  getLatestCriteria(teamId) {
    const team = this._team(teamId);
    const frozen = this.store.latestGoalCriteria(team.id);
    const signoffs = this.store.criteriaSignoffs(team.id);
    if (!frozen) {
      return {
        teamId: team.id,
        frozen: null,
        draft: buildCriteriaDraft({ rawGoal: team.goal, criteria: [], dispositions: [] }),
        signoffs,
      };
    }
    return { teamId: team.id, frozen, signoffs };
  }

  recordCriterionSignoff(teamId, { criterionId, candidateId = null, signer, note = null } = {}) {
    const team = this._team(teamId);
    const frozen = this.store.latestGoalCriteria(team.id);
    if (!frozen) throw new Error('Goal criteria must be frozen before recording sign-off');
    if (typeof signer !== 'string' || !signer.trim()) throw new Error('signer must be a non-empty named identity');
    const crit = (frozen.criteria ?? []).find(c => c.id === criterionId);
    if (!crit) throw new Error(`Unknown criterionId: ${criterionId}`);
    if (candidateId) {
      const cand = this.store.candidate(candidateId);
      if (!cand || cand.teamId !== team.id) throw new Error(`Candidate not found in team: ${candidateId}`);
    }
    const signoff = {
      id: randomUUID(),
      teamId: team.id,
      criterionId,
      criteriaRevision: frozen.revision,
      candidateId: candidateId ?? null,
      signer: signer.trim().slice(0, 200),
      note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null,
      at: now(),
    };
    this.store.saveCriteriaSignoff(signoff);
    return signoff;
  }

  // ==================== R3 + R5：不可变交付候选与增量修订 ====================

  async createCandidate(teamId, {
    taskIds = null,
    parentCandidateId = null,
    targetRef = null,
    integrationCheck = null,
    verifyFullReplayEquivalence = true,
  } = {}) {
    const team = this._team(teamId);
    if (team.workspaceMode !== 'git-worktree' || !team.repoPath || !team.baseCommit) {
      throw new Error('Delivery candidates require a workspaceMode="git-worktree" team');
    }
    if (integrationCheck !== undefined && integrationCheck !== null) {
      this.validateCheck(integrationCheck);
      if (!this.isBehavioralCheck(integrationCheck)) {
        throw new Error('integrationCheck must be a behavioral command_test or node_test');
      }
    }

    const allTasks = this.store.teamTasks(team.id);
    const acceptedPool = allTasks.filter(t => t.state === 'accepted');
    let selectedTasks;
    if (Array.isArray(taskIds) && taskIds.length > 0) {
      const idSet = new Set(taskIds.map(String));
      const found = [];
      for (const id of taskIds) {
        const task = allTasks.find(t => t.id === id);
        if (!task) throw new Error(`Task not found in team: ${id}`);
        if (task.state !== 'accepted') throw new Error(`Task ${id} is in state "${task.state}", must be "accepted"`);
        found.push(task);
      }
      // 保留显式传入的修订尾序，但确保普通依赖任务满足拓扑序
      const regular = this.engine._topoSortTasks(found.filter(t => !t.revisionOfCandidateId));
      const revisions = found.filter(t => Boolean(t.revisionOfCandidateId));
      selectedTasks = [...regular, ...revisions];
      // 若调用方传入了显式 taskIds 集合，确保无遗漏
      if (selectedTasks.length !== idSet.size) {
        selectedTasks = found;
      }
    } else {
      const regular = this.engine._topoSortTasks(acceptedPool.filter(t => !t.revisionOfCandidateId));
      const revisions = acceptedPool
        .filter(t => Boolean(t.revisionOfCandidateId))
        .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
      selectedTasks = [...regular, ...revisions];
    }

    if (!selectedTasks.length) {
      throw new Error('No accepted git-worktree tasks are ready to build a delivery candidate');
    }

    let parentCandidate = null;
    if (parentCandidateId) {
      parentCandidate = this.store.candidate(parentCandidateId);
      if (!parentCandidate || parentCandidate.teamId !== team.id) {
        throw new Error(`Parent candidate not found in team: ${parentCandidateId}`);
      }
    } else {
      const revParentIds = [...new Set(selectedTasks.map(t => t.revisionOfCandidateId).filter(Boolean))];
      if (revParentIds.length === 1) {
        const maybe = this.store.candidate(revParentIds[0]);
        if (maybe && maybe.teamId === team.id) parentCandidate = maybe;
      }
    }

    const frozenCriteria = this.store.latestGoalCriteria(team.id);
    const resolvedTargetRef = targetRef
      ? String(targetRef).trim()
      : (team.baseBranch ? `refs/heads/${team.baseBranch}` : 'HEAD');
    const candidateId = `cand-${randomUUID().slice(0, 12)}`;
    const evidenceDir = path.join(this.dataDir, 'merge-evidence', team.id, candidateId);
    fs.mkdirSync(evidenceDir, { recursive: true });

    const assembled = await assembleCandidateCommit({
      repoPath: team.repoPath,
      baseCommit: team.baseCommit,
      teamId: team.id,
      candidateId,
      parentCandidate,
      orderedAcceptedTasks: selectedTasks,
      dataDir: this.dataDir,
      integrationCheck: integrationCheck ?? null,
      sourceStore: integrationCheck?.type === 'node_test' && integrationCheck.sourceId
        ? this.engine.contextForTeam(team.id)
        : null,
      evidenceDir,
      runIntegrationCheck: this.runStandaloneCheck,
      verifyFullReplayEquivalence,
    });

    if (!assembled.ok && assembled.conflict) {
      return {
        ok: false,
        teamId: team.id,
        assemblyMode: assembled.assemblyMode,
        conflict: assembled.conflict,
      };
    }

    const canonicalEntries = canonicalizeCandidateEntries(assembled.entries);
    const manifestHash = computeCandidateManifestHash({
      repoPath: assembled.repoPath,
      targetRef: resolvedTargetRef,
      baseCommit: team.baseCommit,
      parentCandidateId: assembled.parentCandidateId,
      criteriaRevision: frozenCriteria?.revision ?? null,
      gateHash: frozenCriteria?.gateHash ?? null,
      entries: canonicalEntries,
    });

    const unacceptedTasks = allTasks
      .filter(t => !selectedTasks.some(s => s.id === t.id))
      .map(t => ({ taskId: t.id, title: t.title, state: t.state, executionUnresolved: Boolean(t.executionUnresolved) }));

    const checkEvidence = {};
    if (assembled.integrationCheck) {
      checkEvidence.__integration__ = assembled.integrationCheck;
      if (integrationCheck?.id) checkEvidence[integrationCheck.id] = assembled.integrationCheck;
      for (const crit of frozenCriteria?.criteria ?? []) {
        if (crit.verificationMode === 'check' && crit.checkId === 'integration') {
          checkEvidence[crit.checkId] = assembled.integrationCheck;
        }
      }
    }

    const candidateDraft = {
      id: candidateId,
      teamId: team.id,
      coreVersion: CORE_VERSION,
      repoPath: assembled.repoPath,
      targetRef: resolvedTargetRef,
      baseCommit: team.baseCommit,
      parentCandidateId: assembled.parentCandidateId,
      parentCommitOid: assembled.parentCommitOid,
      assemblyMode: assembled.assemblyMode,
      criteriaRevision: frozenCriteria?.revision ?? null,
      gateHash: frozenCriteria?.gateHash ?? null,
      manifestHash,
      entries: canonicalEntries,
      treeOid: assembled.treeOid,
      commitOid: assembled.commitOid,
      pinRef: assembled.pinRef,
      replayTreeVerified: assembled.replayTreeVerified,
      diffStat: assembled.diffStat,
      incrementalDiffStat: assembled.incrementalDiffStat,
      changedFiles: assembled.changedFiles,
      integrationCheck: assembled.integrationCheck ?? null,
      isPartial: unacceptedTasks.length > 0,
      unacceptedTaskCount: unacceptedTasks.length,
      unacceptedTasks,
      localPublish: null,
      baseDrift: null,
      createdAt: now(),
    };

    const signoffs = this.store.criteriaSignoffs(team.id);
    const goalEvaluation = evaluateGoalCriteria({
      frozenCriteria,
      candidate: candidateDraft,
      tasks: allTasks,
      checkEvidence,
      signoffs,
    });

    const candidate = {
      ...candidateDraft,
      goalEvaluation,
      status: goalEvaluation.goalPassed ? 'goal_verified' : 'ready_for_review',
    };

    this.store.saveCandidate(candidate);
    const freshTeam = this._team(team.id);
    freshTeam.latestCandidateId = candidate.id;
    this._saveTeam(freshTeam, 'candidate-created');

    return { ok: assembled.ok, candidate };
  }

  getCandidate(teamId, candidateId) {
    const team = this._team(teamId);
    const cand = this.store.candidate(candidateId);
    if (!cand || cand.teamId !== team.id) throw new Error(`Candidate not found: ${candidateId}`);
    const frozenCriteria = this.store.latestGoalCriteria(team.id);
    const allTasks = this.store.teamTasks(team.id);
    const signoffs = this.store.criteriaSignoffs(team.id);
    const checkEvidence = {};
    if (cand.integrationCheck) {
      checkEvidence.__integration__ = cand.integrationCheck;
      checkEvidence.integration = cand.integrationCheck;
    }
    const liveEvaluation = evaluateGoalCriteria({
      frozenCriteria,
      candidate: cand,
      tasks: allTasks,
      checkEvidence,
      signoffs,
    });
    const approvals = this.store.candidateApprovals(cand.id);
    return { ...cand, liveGoalEvaluation: liveEvaluation, approvals };
  }

  listCandidates(teamId) {
    const team = this._team(teamId);
    const list = this.store.teamCandidates(team.id);
    const intents = this.store.teamPublishIntents(team.id);
    const prLinks = this.store.teamPrLinks(team.id);
    return {
      teamId: team.id,
      coreVersion: CORE_VERSION,
      candidates: list,
      publishIntents: intents,
      prLinks,
    };
  }

  // ==================== R3：绑定候选、用途与目标位置的批准 ====================

  approveCandidate(teamId, {
    candidateId,
    purpose = 'local_publish',
    branchName = null,
    targetRef = null,
    actor = 'user',
    note = null,
  } = {}) {
    const team = this._team(teamId);
    const candidate = this.store.candidate(candidateId);
    if (!candidate || candidate.teamId !== team.id) {
      throw new Error(`Candidate not found in team: ${candidateId}`);
    }
    const frozenCriteria = this.store.latestGoalCriteria(team.id);
    if (frozenCriteria && candidate.gateHash && frozenCriteria.gateHash !== candidate.gateHash) {
      throw Object.assign(
        new Error('Goal criteria gate changed after this candidate was built; create a new candidate before approving'),
        { code: 'CANDIDATE_GATE_STALE' },
      );
    }
    let resolvedTargetRef = targetRef ? String(targetRef).trim() : null;
    if (purpose === 'local_publish') {
      const sanitized = sanitizeSuperagentBranch(branchName ?? (resolvedTargetRef || null), team.id);
      resolvedTargetRef = sanitized.ref;
    } else if (!resolvedTargetRef) {
      resolvedTargetRef = candidate.targetRef;
    }

    const approval = createApprovalRecord({
      candidate,
      purpose,
      targetRef: resolvedTargetRef,
      actor,
      note,
    });
    this.store.saveCandidateApproval(approval);
    return approval;
  }

  revokeApproval(teamId, { approvalId, reason = 'revoked by reviewer' } = {}) {
    const team = this._team(teamId);
    const approval = this.store.candidateApproval(approvalId);
    if (!approval || approval.teamId !== team.id) throw new Error(`Approval not found: ${approvalId}`);
    if (!approval.revokedAt) {
      approval.revokedAt = now();
      approval.revokeReason = String(reason || 'revoked').slice(0, 500);
      this.store.saveCandidateApproval(approval);
    }
    return approval;
  }

  // ==================== R4：仅用冻结提交执行原子本地发布与崩溃恢复 ====================

  async publishCandidateLocal(teamId, {
    candidateId,
    approvalId,
    branchName = null,
    expectedOldOid = ZERO_OID,
    _testCrashAfterGitUpdateRef = false,
  } = {}) {
    const team = this._team(teamId);
    const candidate = this.store.candidate(candidateId);
    if (!candidate || candidate.teamId !== team.id) {
      throw new Error(`Candidate not found in team: ${candidateId}`);
    }
    const approval = this.store.candidateApproval(approvalId);
    const targetRef = branchName
      ? sanitizeSuperagentBranch(branchName, team.id).ref
      : approval?.targetRef;
    if (!targetRef) {
      throw new Error('targetRef or branchName is required for local publish');
    }

    const frozenCriteria = this.store.latestGoalCriteria(team.id);
    assertApprovalValid({
      approval,
      candidate,
      purpose: 'local_publish',
      targetRef,
      currentCriteriaRevision: frozenCriteria?.revision ?? null,
      currentGateHash: frozenCriteria?.gateHash ?? null,
    });

    // R4：先持久化本地发布意图（用于崩溃后按 intentId + 实际 OID 精确恢复）
    const existingPending = this.store.teamPublishIntents(team.id)
      .find(i => i.targetRef === targetRef && i.status === 'pending_git');
    if (existingPending) {
      throw Object.assign(
        new Error(`Target ref ${targetRef} already has an unresolved publish intent (${existingPending.id}); run reconcile first`),
        { code: 'PUBLISH_INTENT_IN_FLIGHT', intentId: existingPending.id },
      );
    }

    const intent = {
      id: `pub-${randomUUID().slice(0, 12)}`,
      teamId: team.id,
      candidateId: candidate.id,
      approvalId: approval.id,
      repoPath: candidate.repoPath,
      targetRef,
      branch: targetRef.slice('refs/heads/'.length),
      expectedOldOid: expectedOldOid || ZERO_OID,
      targetOid: candidate.commitOid,
      status: 'pending_git',
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.savePublishIntent(intent);

    let published;
    try {
      published = await publishFrozenCandidateRef({
        repoPath: candidate.repoPath,
        targetRef,
        commitOid: candidate.commitOid,
        expectedOldOid: intent.expectedOldOid,
      });
    } catch (err) {
      intent.status = 'failed';
      intent.error = err.message;
      intent.updatedAt = now();
      this.store.savePublishIntent(intent);
      throw err;
    }

    if (_testCrashAfterGitUpdateRef === true) {
      throw Object.assign(
        new Error('Simulated crash after git update-ref before database receipt persistence'),
        { code: 'SIMULATED_CRASH_AFTER_GIT_UPDATE_REF', intentId: intent.id, targetRef, commitOid: candidate.commitOid },
      );
    }

    return this._finalizeLocalPublishReceipt({ team, candidate, intent, published });
  }

  _finalizeLocalPublishReceipt({ team, candidate, intent, published }) {
    const ts = now();
    intent.status = 'published';
    intent.publishedAt = ts;
    intent.updatedAt = ts;
    this.store.savePublishIntent(intent);

    const freshCandidate = this.store.candidate(candidate.id) ?? candidate;
    freshCandidate.localPublish = {
      intentId: intent.id,
      approvalId: intent.approvalId,
      branch: published.branch,
      ref: published.ref,
      commitOid: published.commitOid,
      at: ts,
      scope: 'local_branch_only',
    };
    this.store.saveCandidate(freshCandidate);

    const freshTeam = this._team(team.id);
    freshTeam.lastLocalPublish = {
      at: ts,
      candidateId: freshCandidate.id,
      intentId: intent.id,
      branch: published.branch,
      ref: published.ref,
      commitOid: published.commitOid,
      baseCommit: freshCandidate.baseCommit,
      taskIds: freshCandidate.entries.map(e => e.taskId),
      isPartial: freshCandidate.isPartial,
      goalPassed: Boolean(freshCandidate.goalEvaluation?.goalPassed),
      remoteMerged: false,
    };
    // 兼容历史字段名，但明确标注仅代表本地分支已创建，绝非远端 PR 已合入
    freshTeam.lastMerge = {
      at: ts,
      branch: published.branch,
      ref: published.ref,
      mergedCommit: published.commitOid,
      baseCommit: freshCandidate.baseCommit,
      taskIds: freshCandidate.entries.map(e => e.taskId),
      candidateId: freshCandidate.id,
      localBranchOnly: true,
    };
    this._saveTeam(freshTeam, 'candidate-published-local');

    return {
      ok: true,
      scope: 'local_branch_only',
      remoteMerged: false,
      intentId: intent.id,
      candidateId: freshCandidate.id,
      branch: published.branch,
      ref: published.ref,
      commitOid: published.commitOid,
      treeOid: freshCandidate.treeOid,
      isPartial: freshCandidate.isPartial,
      goalPassed: Boolean(freshCandidate.goalEvaluation?.goalPassed),
      note: `已仅使用冻结候选 ${freshCandidate.id} 原子创建本地分支 ${published.branch}（${published.commitOid.slice(0, 12)}）。本地分支创建不代表远端 PR 已合入，活动工作树与既有用户分支未受改动。`,
    };
  }

  async reconcilePublishIntents(teamId) {
    const team = this._team(teamId);
    const pending = this.store.teamPublishIntents(team.id).filter(i => i.status === 'pending_git');
    const results = [];
    for (const intent of pending) {
      const observedOid = await inspectLocalRef({ repoPath: intent.repoPath, ref: intent.targetRef });
      const ruling = reconcileLocalPublishIntent({ intent, observedOid, zeroOid: ZERO_OID });
      if (ruling.outcome === 'confirmed_recovered') {
        const cand = this.store.candidate(intent.candidateId);
        const receipt = this._finalizeLocalPublishReceipt({
          team,
          candidate: cand,
          intent,
          published: { ref: intent.targetRef, branch: intent.branch, commitOid: intent.targetOid },
        });
        results.push({ intentId: intent.id, ...ruling, receipt });
      } else {
        intent.status = ruling.status;
        intent.observedOid = ruling.observedOid;
        intent.reconcileMessage = ruling.message;
        intent.updatedAt = now();
        this.store.savePublishIntent(intent);
        results.push({ intentId: intent.id, ...ruling });
      }
    }
    return { teamId: team.id, reconciledCount: results.length, results };
  }

  // ==================== R6：目标基线移动三方试合对账 ====================

  async checkCandidateBaseDrift(teamId, { candidateId, targetRef = null } = {}) {
    const team = this._team(teamId);
    const candidate = this.store.candidate(candidateId);
    if (!candidate || candidate.teamId !== team.id) {
      throw new Error(`Candidate not found in team: ${candidateId}`);
    }
    const refToCheck = targetRef || candidate.targetRef || (team.baseBranch ? `refs/heads/${team.baseBranch}` : 'HEAD');
    const drift = await probeBaseDrift({
      repoPath: candidate.repoPath,
      baseCommit: candidate.baseCommit,
      targetRef: refToCheck,
      candidateCommit: candidate.commitOid,
    });
    const record = { ...drift, checkedAt: now() };
    candidate.baseDrift = record;
    this.store.saveCandidate(candidate);
    return { teamId: team.id, candidateId: candidate.id, ...record };
  }

  // ==================== R7 + R8：只读 GitHub PR 关联与断线对账 ====================

  async reconcileGitHubPr(teamId, {
    repo,
    prNumber = null,
    headRepo = null,
    headBranch = null,
    baseBranch = null,
    expectedIntentId = null,
    candidateId = null,
    linkId = null,
    transport = null,
  } = {}) {
    const team = this._team(teamId);
    const existing = linkId ? this.store.prLink(linkId) : null;
    if (existing && existing.teamId !== team.id) throw new Error(`PR link not found in team: ${linkId}`);

    const resolvedRepo = repo ?? existing?.repo;
    const resolvedPrNumber = prNumber ?? existing?.prNumber ?? null;
    const resolvedCandidateId = candidateId ?? existing?.candidateId ?? team.latestCandidateId ?? null;
    const candidate = resolvedCandidateId ? this.store.candidate(resolvedCandidateId) : null;

    const frozenCriteria = this.store.latestGoalCriteria(team.id);
    const allTasks = this.store.teamTasks(team.id);
    const signoffs = this.store.criteriaSignoffs(team.id);
    const checkEvidence = {};
    if (candidate?.integrationCheck) {
      checkEvidence.__integration__ = candidate.integrationCheck;
      checkEvidence.integration = candidate.integrationCheck;
    }
    const goalEvaluation = evaluateGoalCriteria({
      frozenCriteria,
      candidate,
      tasks: allTasks,
      checkEvidence,
      signoffs,
    });

    const ghTransport = transport ?? createGhReadOnlyTransport();
    const observation = await reconcileGitHubPrReadOnly({
      repo: resolvedRepo,
      prNumber: resolvedPrNumber,
      headRepo: headRepo ?? existing?.headRepo ?? null,
      headBranch: headBranch ?? existing?.headBranch ?? candidate?.localPublish?.branch ?? null,
      baseBranch: baseBranch ?? existing?.baseBranch ?? team.baseBranch ?? null,
      expectedIntentId: expectedIntentId ?? existing?.expectedIntentId ?? null,
      candidate,
      goalEvaluation,
      transport: ghTransport,
    });

    const savedLink = {
      id: existing?.id ?? `pr-${randomUUID().slice(0, 12)}`,
      teamId: team.id,
      repo: resolvedRepo,
      prNumber: observation.pr?.number ?? resolvedPrNumber,
      headRepo: headRepo ?? existing?.headRepo ?? null,
      headBranch: headBranch ?? existing?.headBranch ?? observation.pr?.headRef ?? candidate?.localPublish?.branch ?? null,
      baseBranch: baseBranch ?? existing?.baseBranch ?? observation.pr?.baseRef ?? team.baseBranch ?? null,
      expectedIntentId: expectedIntentId ?? existing?.expectedIntentId ?? null,
      candidateId: candidate?.id ?? null,
      status: observation.status,
      remoteMerged: observation.remoteMerged,
      versionMismatch: observation.versionMismatch,
      externalDrift: observation.externalDrift,
      lastObservation: observation,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.store.savePrLink(savedLink);
    return { link: savedLink, observation };
  }
}
