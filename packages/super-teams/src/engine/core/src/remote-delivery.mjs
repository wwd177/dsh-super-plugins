import { createHash, randomUUID } from 'node:crypto';
import { ZERO_OID, runGit, sanitizeSuperagentBranch } from './git-worktree.mjs';
import { assertApprovalValid } from './delivery-candidate.mjs';
import { reconcileGitHubPrReadOnly, createGhReadOnlyTransport, validateRepoSlug } from './github-readonly.mjs';

const now = () => new Date().toISOString();
const INTENT_TAG_PREFIX = 'superagent-intent';
const OID_RE = /^[a-f0-9]{40,64}$/;
const UNRESOLVED_PR_STATUSES = new Set(['pending_create', 'receipt_unknown', 'unknown']);
const CONFIRMED_PR_STATUSES = new Set(['confirmed', 'confirmed_recovered', 'manually_bound']);

const hashKey = text => createHash('sha256').update(String(text)).digest('hex');

function validateRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string') {
    throw Object.assign(new Error('remoteUrl is required for remote push'), { code: 'INVALID_REMOTE_URL' });
  }
  const trimmed = remoteUrl.trim();
  if (!trimmed || trimmed.startsWith('-') || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw Object.assign(new Error('remoteUrl is invalid or begins with "-"'), { code: 'INVALID_REMOTE_URL' });
  }
  return trimmed;
}

function resolveRemoteTargetRef(stableBranch, fallbackId, teamId) {
  if (stableBranch !== undefined && stableBranch !== null && String(stableBranch).trim() !== '') {
    const raw = String(stableBranch).trim();
    if (raw.startsWith('refs/')) {
      if (!raw.startsWith('refs/heads/superagent/')) {
        throw Object.assign(
          new Error(`Remote targetRef must stay under refs/heads/superagent/* (got "${raw}")`),
          { code: 'REMOTE_TARGET_REF_FORBIDDEN' },
        );
      }
    } else if (raw.includes('/') && !raw.startsWith('superagent/')) {
      throw Object.assign(
        new Error(`Remote target branch must stay under superagent/* (got "${raw}")`),
        { code: 'REMOTE_TARGET_REF_FORBIDDEN' },
      );
    }
    return sanitizeSuperagentBranch(raw, teamId);
  }
  return sanitizeSuperagentBranch(fallbackId, teamId);
}

function parseExpectedOldOid(expectedOldOid) {
  if (expectedOldOid === undefined || expectedOldOid === null || String(expectedOldOid).trim() === '') {
    return ZERO_OID;
  }
  const cleaned = String(expectedOldOid).trim();
  if (!OID_RE.test(cleaned)) {
    throw Object.assign(new Error(`Invalid expectedOldOid: "${cleaned}"`), { code: 'INVALID_EXPECTED_OLD_OID' });
  }
  return cleaned;
}

function buildIsolatedPublisherEnv(publisherEnv = {}) {
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [k, v] of Object.entries(publisherEnv ?? {})) {
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  return env;
}

async function lsRemoteBranchOid({ remoteUrl, ref, repoPath, publisherEnv }) {
  const safeUrl = validateRemoteUrl(remoteUrl);
  const res = await runGit(['ls-remote', '--heads', '--', safeUrl, ref], {
    cwd: repoPath,
    env: buildIsolatedPublisherEnv(publisherEnv),
    timeoutMs: 20000,
  });
  if (res.code !== 0) {
    throw new Error(`git ls-remote failed: ${(res.stderr || '').trim()}`);
  }
  const line = res.stdout.toString('utf8').split(/\r?\n/).find(l => l.trim().endsWith(ref) || l.trim().endsWith(`refs/heads/${ref.replace(/^refs\/heads\//, '')}`));
  if (!line) return ZERO_OID;
  const oid = line.trim().split(/\s+/)[0];
  return OID_RE.test(oid) ? oid : ZERO_OID;
}

/**
 * v0.19 授权远端交付服务：
 * 1. 发布身份与仓库白名单显式隔离（绝不共享测试子进程目录或凭据）；
 * 2. 推送提交与创建 PR 分离为两阶段持久化意图；
 * 3. 远端分支强制服务端预期旧 OID 原子对比（--force-with-lease=ref:<oid> 或 : 表示不存在），绝不回退普通快进推送；
 * 4. 外部 head 漂移立即冻结该交付流写入；
 * 5. 事件去重键与活动修订任务唯一键分离：按 (deliveryStreamId, candidateId) 原子复用唯一活动集成修订任务。
 */
export class RemoteDeliveryService {
  constructor({
    store,
    engine,
    allowedRepos = null,
    publisherIdentity = 'isolated-publisher',
  }) {
    this.store = store;
    this.engine = engine;
    this.defaultAllowedRepos = Array.isArray(allowedRepos) ? allowedRepos.map(r => r.toLowerCase()) : null;
    this.publisherIdentity = publisherIdentity;
  }

  _assertRepoAllowed(team, repo) {
    const safeRepo = validateRepoSlug(repo);
    const norm = safeRepo.toLowerCase();
    const teamAllowed = Array.isArray(team.allowedRemoteRepos) ? team.allowedRemoteRepos.map(r => String(r).toLowerCase()) : null;
    const allowList = teamAllowed ?? this.defaultAllowedRepos;
    if (!allowList || !allowList.length || !allowList.includes(norm)) {
      throw Object.assign(
        new Error(`Remote repository "${safeRepo}" is not in the authorized write allowlist`),
        { code: 'REMOTE_REPO_NOT_ALLOWED' },
      );
    }
    return safeRepo;
  }

  _getOrCreateStream(teamId, deliveryStreamId, defaults = {}) {
    const id = deliveryStreamId || `stream-${teamId}`;
    let stream = this.store.deliveryStream?.(id);
    if (!stream) {
      stream = {
        id,
        teamId,
        repo: defaults.repo ?? null,
        stableBranch: defaults.stableBranch ?? null,
        state: 'active',
        frozenReason: null,
        actualRemoteHead: null,
        lastConfirmedPushOid: null,
        boundPrNumber: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.saveDeliveryStream(stream);
    }
    return stream;
  }

  /**
   * 原子核验批准 + 预期旧 OID 服务端原子推送（禁用普通快进覆盖）。
   */
  async pushCandidateRemote(teamId, {
    deliveryStreamId = null,
    candidateId,
    approvalId,
    repo,
    remoteUrl,
    stableBranch,
    expectedOldOid = ZERO_OID,
    purpose = 'remote_push',
    publisherEnv = {},
  } = {}) {
    const team = this.engine._team(teamId);
    const allowedRepo = this._assertRepoAllowed(team, repo);
    const safeRemoteUrl = validateRemoteUrl(remoteUrl);
    const sanitized = resolveRemoteTargetRef(stableBranch, candidateId, team.id);
    const targetBranch = sanitized.branch;
    const targetRef = sanitized.ref;
    const expectedOld = parseExpectedOldOid(expectedOldOid);
    const streamId = deliveryStreamId || `stream-${team.id}-${targetBranch}`;

    const prepared = this.store.transaction(() => {
      const candidate = this.store.candidate(candidateId);
      if (!candidate || candidate.teamId !== team.id) {
        throw new Error(`Candidate not found in team: ${candidateId}`);
      }
      const stream = this._getOrCreateStream(team.id, streamId, { repo: allowedRepo, stableBranch: targetBranch });
      if (stream.repo && stream.repo.toLowerCase() !== allowedRepo.toLowerCase()) {
        throw Object.assign(
          new Error(`Delivery stream ${stream.id} is bound to repo "${stream.repo}", cannot write "${allowedRepo}"`),
          { code: 'STREAM_REPO_MISMATCH' },
        );
      }
      if (stream.state === 'frozen_external_drift') {
        throw Object.assign(
          new Error(`Delivery stream ${stream.id} is frozen due to external drift (observed head ${stream.actualRemoteHead}); resolve drift before writing`),
          { code: 'STREAM_FROZEN_EXTERNAL_DRIFT', stream },
        );
      }
      const pendingPush = (this.store.teamRemotePushIntents?.(team.id) ?? [])
        .find(i => i.deliveryStreamId === stream.id && i.status === 'pending_remote');
      if (pendingPush) {
        throw Object.assign(
          new Error(`Delivery stream ${stream.id} already has an unresolved remote push intent (${pendingPush.id}); run reconcileRemoteIntents first`),
          { code: 'REMOTE_PUSH_IN_FLIGHT', intentId: pendingPush.id },
        );
      }
      const approval = this.store.candidateApproval(approvalId);
      const frozenCriteria = this.store.latestGoalCriteria(team.id);
      assertApprovalValid({
        approval,
        candidate,
        purpose,
        targetRef,
        currentCriteriaRevision: frozenCriteria?.revision ?? null,
        currentGateHash: frozenCriteria?.gateHash ?? null,
      });

      const intent = {
        id: `rpush-${randomUUID().slice(0, 12)}`,
        teamId: team.id,
        deliveryStreamId: stream.id,
        candidateId: candidate.id,
        approvalId: approval.id,
        repo: allowedRepo,
        remoteUrl: safeRemoteUrl,
        stableBranch: targetBranch,
        targetRef,
        expectedOldOid: expectedOld,
        targetOid: candidate.commitOid,
        publisherIdentity: this.publisherIdentity,
        status: 'pending_remote',
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.saveRemotePushIntent(intent);
      return { candidate, stream, intent };
    });

    // Git CLI lease syntax:
    // - empty after colon means "expect ref does not exist on remote"
    // - :<oid> means "expect remote ref equals exact <oid>" (rejects both forward drift AND ancestor rewind!)
    const leaseSpec = expectedOld === ZERO_OID
      ? `--force-with-lease=${targetRef}:`
      : `--force-with-lease=${targetRef}:${expectedOld}`;

    const pushRes = await runGit(
      ['push', leaseSpec, '--', safeRemoteUrl, `${prepared.candidate.commitOid}:${targetRef}`],
      {
        cwd: prepared.candidate.repoPath,
        env: buildIsolatedPublisherEnv(publisherEnv),
        timeoutMs: 30000,
      },
    );

    if (pushRes.code !== 0) {
      const actualRemoteHead = await lsRemoteBranchOid({
        remoteUrl: safeRemoteUrl,
        ref: targetRef,
        repoPath: prepared.candidate.repoPath,
        publisherEnv,
      }).catch(() => null);
      const stderr = (pushRes.stderr || '').trim();
      const isLeaseMismatch = /stale info|rejected|non-fast-forward|failed to lock/i.test(stderr)
        || (actualRemoteHead && actualRemoteHead !== expectedOld);

      return this.store.transaction(() => {
        const intent = prepared.intent;
        intent.status = isLeaseMismatch ? 'rejected_external_drift' : 'failed';
        intent.actualRemoteHead = actualRemoteHead;
        intent.error = stderr.slice(0, 1000);
        intent.updatedAt = now();
        this.store.saveRemotePushIntent(intent);

        const stream = this._getOrCreateStream(team.id, streamId, { repo: allowedRepo, stableBranch: targetBranch });
        if (isLeaseMismatch) {
          stream.state = 'frozen_external_drift';
          stream.frozenReason = `Expected old OID ${expectedOld}, but remote had ${actualRemoteHead ?? 'unknown'}`;
          stream.actualRemoteHead = actualRemoteHead;
          stream.updatedAt = now();
          this.store.saveDeliveryStream(stream);
        }
        return {
          ok: false,
          code: isLeaseMismatch ? 'REMOTE_LEASE_MISMATCH_FROZEN' : 'REMOTE_PUSH_FAILED',
          intent,
          stream,
          actualRemoteHead,
          error: stderr,
        };
      });
    }

    return this.store.transaction(() => {
      const intent = prepared.intent;
      intent.status = 'pushed';
      intent.pushedAt = now();
      intent.updatedAt = now();
      this.store.saveRemotePushIntent(intent);

      const stream = this._getOrCreateStream(team.id, streamId, { repo: allowedRepo, stableBranch: targetBranch });
      stream.repo = allowedRepo;
      stream.stableBranch = targetBranch;
      stream.lastConfirmedPushOid = prepared.candidate.commitOid;
      stream.actualRemoteHead = prepared.candidate.commitOid;
      stream.updatedAt = now();
      this.store.saveDeliveryStream(stream);
      return { ok: true, intent, stream };
    });
  }

  resolveExternalDrift(teamId, { deliveryStreamId, action, newBranch = null, actor = 'maintainer' } = {}) {
    const team = this.engine._team(teamId);
    if (!['adopt_as_candidate', 'redirect_new_branch'].includes(action)) {
      throw new Error('action must be "adopt_as_candidate" or "redirect_new_branch"');
    }
    let resolvedNewBranch = null;
    if (action === 'redirect_new_branch') {
      if (!newBranch || typeof newBranch !== 'string' || !newBranch.trim()) {
        throw new Error('newBranch is required for redirect_new_branch');
      }
      resolvedNewBranch = resolveRemoteTargetRef(newBranch, team.id, team.id).branch;
    }
    return this.store.transaction(() => {
      const stream = this.store.deliveryStream(deliveryStreamId);
      if (!stream || stream.teamId !== team.id) throw new Error(`Delivery stream not found: ${deliveryStreamId}`);
      stream.state = 'active';
      stream.frozenReason = null;
      stream.lastDriftResolution = {
        action,
        previousHead: stream.actualRemoteHead,
        ...(resolvedNewBranch ? { newBranch: resolvedNewBranch } : {}),
        actor,
        at: now(),
      };
      if (action === 'redirect_new_branch' && resolvedNewBranch) {
        stream.stableBranch = resolvedNewBranch;
        stream.boundPrNumber = null;
      }
      stream.updatedAt = now();
      this.store.saveDeliveryStream(stream);
      return stream;
    });
  }

  /**
   * 幂等建 PR（独立意图；若回执丢失绝不盲目二次创建；支持显式 intentId 幂等重放）。
   */
  async createPullRequestIdempotent(teamId, {
    deliveryStreamId,
    candidateId,
    approvalId,
    repo,
    headBranch,
    baseBranch,
    title,
    body = '',
    draft = true,
    intentId: explicitIntentId = null,
    transport,
  } = {}) {
    const team = this.engine._team(teamId);
    const allowedRepo = this._assertRepoAllowed(team, repo);
    if (!transport || typeof transport.createPullRequest !== 'function') {
      throw new Error('Authorized write transport.createPullRequest is required');
    }
    const cleanHeadBranch = String(headBranch ?? '').replace(/^refs\/heads\//, '').trim();
    const cleanBaseBranch = String(baseBranch ?? '').replace(/^refs\/heads\//, '').trim();
    if (!cleanHeadBranch || !cleanBaseBranch) {
      throw new Error('headBranch and baseBranch are required');
    }

    const intentId = typeof explicitIntentId === 'string' && explicitIntentId.trim()
      ? explicitIntentId.trim()
      : `printent-${randomUUID().slice(0, 12)}`;
    const markerComment = `<!-- ${INTENT_TAG_PREFIX}:${intentId} -->`;
    const bodyWithMarker = `${String(body || '').trim()}\n\n${markerComment}`.trim();

    const prepared = this.store.transaction(() => {
      const stream = this._getOrCreateStream(team.id, deliveryStreamId, { repo: allowedRepo, stableBranch: cleanHeadBranch });
      if (stream.repo && stream.repo.toLowerCase() !== allowedRepo.toLowerCase()) {
        throw Object.assign(
          new Error(`Delivery stream ${stream.id} is bound to repo "${stream.repo}", cannot create PR on "${allowedRepo}"`),
          { code: 'STREAM_REPO_MISMATCH' },
        );
      }

      if (typeof explicitIntentId === 'string' && explicitIntentId.trim()) {
        const priorIntent = this.store.prCreateIntent?.(intentId);
        if (priorIntent) {
          if (priorIntent.teamId !== team.id || priorIntent.deliveryStreamId !== stream.id || priorIntent.candidateId !== candidateId) {
            throw Object.assign(
              new Error(`PR intentId ${intentId} already used with different team/stream/candidate parameters`),
              { code: 'PR_INTENT_ID_CONFLICT' },
            );
          }
          if (CONFIRMED_PR_STATUSES.has(priorIntent.status)) {
            return { replayResult: { ok: true, idempotentReplay: true, status: priorIntent.status, intent: priorIntent, stream } };
          }
          if (UNRESOLVED_PR_STATUSES.has(priorIntent.status)) {
            throw Object.assign(
              new Error(`PR create intent ${priorIntent.id} is still unresolved (${priorIntent.status}); reconcile before retrying`),
              { code: 'PR_CREATE_INTENT_UNRESOLVED', intent: priorIntent },
            );
          }
        }
      }

      const unresolvedPr = (this.store.teamPrCreateIntents?.(team.id) ?? [])
        .find(i => i.deliveryStreamId === stream.id && UNRESOLVED_PR_STATUSES.has(i.status));
      if (unresolvedPr) {
        throw Object.assign(
          new Error(`Delivery stream ${stream.id} already has an unresolved PR creation intent (${unresolvedPr.id}, status=${unresolvedPr.status}); reconcile first`),
          { code: 'PR_CREATE_INTENT_UNRESOLVED', intent: unresolvedPr },
        );
      }

      const candidate = this.store.candidate(candidateId);
      if (!candidate || candidate.teamId !== team.id) throw new Error(`Candidate not found: ${candidateId}`);
      if (stream.state === 'frozen_external_drift') {
        throw Object.assign(new Error(`Delivery stream ${stream.id} is frozen due to external drift`), { code: 'STREAM_FROZEN_EXTERNAL_DRIFT' });
      }
      const approval = this.store.candidateApproval(approvalId);
      const frozenCriteria = this.store.latestGoalCriteria(team.id);
      assertApprovalValid({
        approval,
        candidate,
        purpose: draft ? 'draft_pr' : 'request_merge',
        targetRef: `refs/heads/${cleanHeadBranch}`,
        currentCriteriaRevision: frozenCriteria?.revision ?? null,
        currentGateHash: frozenCriteria?.gateHash ?? null,
      });

      const intent = {
        id: intentId,
        teamId: team.id,
        deliveryStreamId: stream.id,
        candidateId: candidate.id,
        approvalId: approval.id,
        repo: allowedRepo,
        headBranch: cleanHeadBranch,
        baseBranch: cleanBaseBranch,
        draft: Boolean(draft),
        expectedOid: candidate.commitOid,
        status: 'pending_create',
        prNumber: null,
        prUrl: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.store.savePrCreateIntent(intent);
      return { intent, candidate, stream };
    });

    if (prepared.replayResult) {
      return prepared.replayResult;
    }

    try {
      const created = await transport.createPullRequest({
        repo: allowedRepo,
        head: cleanHeadBranch,
        base: cleanBaseBranch,
        title,
        body: bodyWithMarker,
        draft: Boolean(draft),
        intentId,
      });
      return this.store.transaction(() => {
        const intent = prepared.intent;
        intent.status = 'confirmed';
        intent.prNumber = Number(created.number);
        intent.prUrl = String(created.html_url ?? created.url ?? '');
        intent.updatedAt = now();
        this.store.savePrCreateIntent(intent);

        const stream = this._getOrCreateStream(team.id, prepared.stream.id);
        stream.boundPrNumber = intent.prNumber;
        stream.updatedAt = now();
        this.store.saveDeliveryStream(stream);
        return { ok: true, status: 'confirmed', intent, stream };
      });
    } catch (err) {
      return this.store.transaction(() => {
        const intent = prepared.intent;
        intent.status = 'receipt_unknown';
        intent.error = err.message;
        intent.updatedAt = now();
        this.store.savePrCreateIntent(intent);
        return {
          ok: false,
          status: 'receipt_unknown',
          retryBlocked: true,
          intent,
          error: err.message,
          nextStep: 'Run reconcileRemoteIntents to inspect GitHub read-only before deciding next action.',
        };
      });
    }
  }

  /**
   * 断线重启后只读查证丢失回执的建 PR 与推送意图（零写请求）。
   */
  async reconcileRemoteIntents(teamId, { deliveryStreamId = null, repo = null, transport = null, publisherEnv = {} } = {}) {
    const team = this.engine._team(teamId);
    const prIntents = this.store.teamPrCreateIntents(team.id)
      .filter(i => (i.status === 'receipt_unknown' || i.status === 'pending_create') && (!deliveryStreamId || i.deliveryStreamId === deliveryStreamId));
    const pushIntents = (this.store.teamRemotePushIntents?.(team.id) ?? [])
      .filter(i => i.status === 'pending_remote' && (!deliveryStreamId || i.deliveryStreamId === deliveryStreamId));
    const roTransport = prIntents.length > 0 ? (transport ?? createGhReadOnlyTransport()) : null;
    const results = [];
    const pushResults = [];

    for (const pushIntent of pushIntents) {
      const candidate = this.store.candidate(pushIntent.candidateId);
      const repoPath = candidate?.repoPath ?? team.repoPath;
      let observedOid = null;
      let probeErr = null;
      try {
        observedOid = await lsRemoteBranchOid({
          remoteUrl: pushIntent.remoteUrl,
          ref: pushIntent.targetRef,
          repoPath,
          publisherEnv,
        });
      } catch (err) {
        probeErr = err.message;
      }
      this.store.transaction(() => {
        const stream = this.store.deliveryStream(pushIntent.deliveryStreamId);
        if (probeErr !== null) {
          pushIntent.status = 'unknown';
          pushIntent.error = probeErr;
          pushIntent.updatedAt = now();
          this.store.saveRemotePushIntent(pushIntent);
          pushResults.push({ intentId: pushIntent.id, outcome: 'unknown', error: probeErr, writeRequestsMade: 0 });
          return;
        }
        if (observedOid === pushIntent.targetOid) {
          pushIntent.status = 'pushed_recovered';
          pushIntent.actualRemoteHead = observedOid;
          pushIntent.updatedAt = now();
          this.store.saveRemotePushIntent(pushIntent);
          if (stream) {
            stream.lastConfirmedPushOid = observedOid;
            stream.actualRemoteHead = observedOid;
            stream.updatedAt = now();
            this.store.saveDeliveryStream(stream);
          }
          pushResults.push({ intentId: pushIntent.id, outcome: 'confirmed_recovered', actualRemoteHead: observedOid, writeRequestsMade: 0 });
        } else if (observedOid === (pushIntent.expectedOldOid || ZERO_OID)) {
          pushIntent.status = 'aborted_before_remote';
          pushIntent.actualRemoteHead = observedOid;
          pushIntent.updatedAt = now();
          this.store.saveRemotePushIntent(pushIntent);
          pushResults.push({ intentId: pushIntent.id, outcome: 'not_applied', actualRemoteHead: observedOid, writeRequestsMade: 0 });
        } else {
          pushIntent.status = 'rejected_external_drift';
          pushIntent.actualRemoteHead = observedOid;
          pushIntent.updatedAt = now();
          this.store.saveRemotePushIntent(pushIntent);
          if (stream) {
            stream.state = 'frozen_external_drift';
            stream.frozenReason = `Expected old OID ${pushIntent.expectedOldOid}, but remote had ${observedOid}`;
            stream.actualRemoteHead = observedOid;
            stream.updatedAt = now();
            this.store.saveDeliveryStream(stream);
          }
          pushResults.push({ intentId: pushIntent.id, outcome: 'external_drift', actualRemoteHead: observedOid, writeRequestsMade: 0 });
        }
      });
    }

    for (const intent of prIntents) {
      const candidate = this.store.candidate(intent.candidateId);
      const stream = this.store.deliveryStream(intent.deliveryStreamId);
      const obs = await reconcileGitHubPrReadOnly({
        repo: repo ?? intent.repo,
        prNumber: stream?.boundPrNumber ?? null,
        headBranch: intent.headBranch,
        baseBranch: intent.baseBranch,
        expectedIntentId: intent.id,
        candidate,
        goalEvaluation: candidate?.goalEvaluation ?? null,
        transport: roTransport,
      });

      this.store.transaction(() => {
        const latest = this.store.prCreateIntent(intent.id);
        if (obs.ok && obs.pr?.number) {
          latest.status = 'confirmed_recovered';
          latest.prNumber = obs.pr.number;
          latest.prUrl = obs.pr.url;
          latest.updatedAt = now();
          this.store.savePrCreateIntent(latest);
          if (stream) {
            stream.boundPrNumber = obs.pr.number;
            stream.updatedAt = now();
            this.store.saveDeliveryStream(stream);
          }
          results.push({ intentId: latest.id, outcome: 'confirmed_recovered', prNumber: obs.pr.number, writeRequestsMade: 0 });
        } else {
          latest.status = 'unknown';
          latest.ambiguityReason = obs.ambiguityReason;
          latest.updatedAt = now();
          this.store.savePrCreateIntent(latest);
          results.push({ intentId: latest.id, outcome: 'unknown', ambiguityReason: obs.ambiguityReason, writeRequestsMade: 0 });
        }
      });
    }

    return {
      teamId: team.id,
      reconciledCount: results.length,
      pushReconciledCount: pushResults.length,
      writeRequestsMade: 0,
      results,
      pushResults,
    };
  }

  resolveUnknownPrIntent(teamId, { intentId, action, prNumber = null, actor = 'maintainer', note = null } = {}) {
    const team = this.engine._team(teamId);
    if (!['bind_existing', 'abandon'].includes(action)) {
      throw new Error('action must be "bind_existing" or "abandon"');
    }
    return this.store.transaction(() => {
      const intent = this.store.prCreateIntent(intentId);
      if (!intent || intent.teamId !== team.id) throw new Error(`PR create intent not found: ${intentId}`);
      if (action === 'bind_existing') {
        if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('prNumber >= 1 is required for bind_existing');
        intent.status = 'manually_bound';
        intent.prNumber = prNumber;
        const stream = this.store.deliveryStream(intent.deliveryStreamId);
        if (stream) {
          stream.boundPrNumber = prNumber;
          stream.updatedAt = now();
          this.store.saveDeliveryStream(stream);
        }
      } else {
        intent.status = 'manually_abandoned';
      }
      intent.resolution = { action, actor, note, at: now() };
      intent.updatedAt = now();
      this.store.savePrCreateIntent(intent);
      return intent;
    });
  }

  /**
   * 远端 Check/Review 失败事件去重，并严格按 (deliveryStreamId, candidateId) 原子复用唯一活动修订任务。
   */
  ingestRemoteFailureEvent(teamId, {
    deliveryStreamId,
    candidateId,
    repo,
    prNumber,
    headSha,
    checkSignature,
    failureSummary,
    memberId = null,
  } = {}) {
    const team = this.engine._team(teamId);
    if (!deliveryStreamId || !candidateId || !repo || !headSha || !checkSignature) {
      throw new Error('deliveryStreamId, candidateId, repo, headSha, and checkSignature are required');
    }
    const dedupeKey = hashKey(`${repo.toLowerCase()}|${prNumber ?? ''}|${headSha}|${checkSignature}`);

    return this.store.transaction(() => {
      const existingEvent = this.store.remoteEvent(dedupeKey);
      if (existingEvent) {
        return {
          dedupedEvent: true,
          reusedActiveRevision: true,
          revisionTaskId: existingEvent.revisionTaskId,
          event: existingEvent,
        };
      }

      const candidate = this.store.candidate(candidateId);
      if (!candidate || candidate.teamId !== team.id) {
        throw new Error(`Candidate not found in team: ${candidateId}`);
      }

      // Check active revision uniqueness scoped to (deliveryStreamId, candidateId), independent of checkSignature!
      const terminalStates = new Set(['accepted', 'abandoned', 'cancelled']);
      const existingTeamEvents = this.store.teamRemoteEvents(team.id)
        .filter(e => e.deliveryStreamId === deliveryStreamId && e.candidateId === candidateId);

      let activeRevisionTask = null;
      for (const ev of existingTeamEvents) {
        const maybeTask = this.store.get(ev.revisionTaskId);
        if (maybeTask && !terminalStates.has(maybeTask.state)) {
          activeRevisionTask = maybeTask;
          break;
        }
      }
      if (!activeRevisionTask) {
        activeRevisionTask = this.store.teamTasks(team.id).find(
          t => t.revisionOfCandidateId === candidateId && t.deliveryStreamId === deliveryStreamId && !terminalStates.has(t.state),
        ) ?? null;
      }

      let revisionTaskId;
      let createdNewRevision = false;
      if (activeRevisionTask) {
        revisionTaskId = activeRevisionTask.id;
        activeRevisionTask.remoteFailureEvidence = [
          ...(activeRevisionTask.remoteFailureEvidence ?? []),
          { checkSignature, failureSummary: String(failureSummary ?? ''), headSha, prNumber, at: now() },
        ];
        activeRevisionTask.goal = `${activeRevisionTask.goal}\n- [${checkSignature}] ${String(failureSummary ?? '').slice(0, 400)}`;
        activeRevisionTask.updatedAt = now();
        activeRevisionTask.revision += 1;
        this.store.save(activeRevisionTask);
      } else {
        const targetMember = memberId || team.members[0]?.id;
        if (!targetMember) throw new Error('Team has no members to assign remote revision task');
        const baseReqId = `remote-rev-${deliveryStreamId}-${candidateId}`;
        let revRequestId = baseReqId;
        if (this.store.request?.(revRequestId)) {
          let round = 2;
          while (this.store.request?.(`${baseReqId}-r${round}`)) {
            round += 1;
          }
          revRequestId = `${baseReqId}-r${round}`;
        }
        const created = this.engine.submit({
          requestId: revRequestId,
          teamId: team.id,
          memberId: targetMember,
          title: `集成修订：修复远端检查 (${candidateId})`,
          goal: `基于候选 ${candidateId}（PR #${prNumber ?? '?'} @ ${headSha.slice(0, 12)}）修复远端检查失败：\n- [${checkSignature}] ${String(failureSummary ?? '')}`,
          revisionOfCandidateId: candidateId,
        });
        const storedTask = this.store.get(created.id);
        storedTask.deliveryStreamId = deliveryStreamId;
        storedTask.remoteFailureEvidence = [
          { checkSignature, failureSummary: String(failureSummary ?? ''), headSha, prNumber, at: now() },
        ];
        this.store.save(storedTask);
        revisionTaskId = storedTask.id;
        createdNewRevision = true;
      }

      const eventRecord = {
        dedupeKey,
        teamId: team.id,
        deliveryStreamId,
        candidateId,
        repo,
        prNumber: prNumber ?? null,
        headSha,
        checkSignature,
        failureSummary: String(failureSummary ?? ''),
        revisionTaskId,
        at: now(),
      };
      this.store.saveRemoteEvent(eventRecord);

      return {
        dedupedEvent: false,
        createdNewRevision,
        reusedActiveRevision: !createdNewRevision,
        revisionTaskId,
        event: eventRecord,
      };
    });
  }
}
