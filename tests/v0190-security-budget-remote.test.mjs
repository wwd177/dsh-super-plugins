import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { DshSuperTeamsRuntime } from '../packages/super-teams/src/runtime.mjs';
import { buildIsolatedTestEnv, killProcessTree, isProcessAlive, probeHostIsolationPosture } from '../packages/super-teams/src/engine/core/src/process-isolation.mjs';
import { ZERO_OID } from '../packages/super-teams/src/engine/core/src/git-worktree.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(rootDir, files = { 'README.md': '# DSH v019 Demo\n', 'feature.txt': 'v0\n' }) {
  fs.mkdirSync(rootDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'DSH User'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'dsh@example.invalid'], { cwd: rootDir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: rootDir, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
}

function createScriptedAdapter(handler) {
  let seq = 0;
  return {
    async connect() {},
    async close() {},
    status() { return { state: 'connected' }; },
    async models() { return [{ model: 'deepseek-test', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'] }]; },
    authorizeThread() {},
    async start(task, hooks) {
      await hooks.beforeExecute();
      const id = ++seq;
      const threadId = `dsh-thread-${id}`;
      const turnId = `dsh-turn-${id}`;
      await hooks.onIdentity({ threadId, turnId });
      const custom = typeof handler === 'function' ? await handler(task, hooks, id) : null;
      if (custom && custom.completion) return { threadId, turnId, ...custom };
      const completion = Promise.resolve().then(async () => (custom || { status: 'completed', text: `Done ${task.title}`, usage: { inputTokens: 20, outputTokens: 20, totalTokens: 40 } }));
      return { threadId, turnId, completion, interrupt: async () => {} };
    },
  };
}

async function waitUntil(fn, timeoutMs = 12000, label = 'condition', diagFn = null) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 30));
  }
  const diag = typeof diagFn === 'function' ? diagFn() : '';
  throw new Error(`Timeout waiting for ${label}${diag ? `: ${typeof diag === 'string' ? diag : JSON.stringify(diag)}` : ''}`);
}

test('DSH v0.19 security isolation & runtime tools: canary/gitconfig stripped, process tree killed, truthful posture & tool schema actions', async t => {
  const root = makeTempDir('dsh-v019-sec-');
  const dataDir = path.join(root, 'data');
  const rtDir = path.join(root, 'rt');
  const repoDir = path.join(root, 'repo');
  initGitRepo(repoDir, { 'package.json': JSON.stringify({ name: 'dsh-demo', scripts: { test: 'node --test' } }), 'package-lock.json': '{}' });

  const hostGitCfg = path.join(root, 'host-global.gitconfig');
  fs.writeFileSync(hostGitCfg, '[canary]\n\tsecret = DSH_NO_LEAK\n', 'utf8');
  const savedEnv = {
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    SUPERAGENT_OS_ISOLATED: process.env.SUPERAGENT_OS_ISOLATED,
  };
  process.env.AWS_SECRET_ACCESS_KEY = 'DSH_CANARY_AWS';
  process.env.GITHUB_TOKEN = 'DSH_CANARY_GH';
  process.env.DEEPSEEK_API_KEY = 'DSH_CANARY_DS';
  process.env.GIT_CONFIG_GLOBAL = hostGitCfg;
  delete process.env.SUPERAGENT_OS_ISOLATED;

  t.after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { env: isoEnv } = buildIsolatedTestEnv(path.join(root, 'iso'), { preserveElectronAsNode: true });
  assert.equal(isoEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(isoEnv.GITHUB_TOKEN, undefined);
  assert.equal(isoEnv.DEEPSEEK_API_KEY, undefined);
  assert.equal(isoEnv.ELECTRON_RUN_AS_NODE, '1');

  const engine = new Engine({
    dataDir,
    adapter: createScriptedAdapter(async task => {
      fs.writeFileSync(path.join(task.cwd, 'check.txt'), 'ok', 'utf8');
      return { status: 'completed', text: 'done' };
    }),
    contextStore: new ContextStore(path.join(dataDir, 'ctx')),
  });
  await engine.initialize();
  try {
    const task = engine.submit({
      requestId: randomUUID(),
      title: 'DSH Isolation Test',
      goal: 'Verify child env and git config isolation',
      writeScopes: ['check.txt'],
      checks: [{
        type: 'node_test',
        path: 'check.txt',
        testScript: [
          'const { execFileSync } = require("child_process");',
          'if (process.env.AWS_SECRET_ACCESS_KEY || process.env.GITHUB_TOKEN || process.env.DEEPSEEK_API_KEY) process.exit(2);',
          'const cfg = execFileSync("git", ["config", "--list"], { encoding: "utf8" });',
          'if (cfg.includes("DSH_NO_LEAK")) process.exit(3);',
        ].join(' '),
      }],
    });
    await engine.runDue();
    await waitUntil(() => engine.get(task.id).state === 'checked', 15000, 'dsh isolation check', () => engine.get(task.id));
  } finally {
    await engine.close();
  }

  // Grandchild tree termination
  const treeScript = path.join(root, 'tree.mjs');
  fs.writeFileSync(treeScript, [
    "import { spawn } from 'node:child_process';",
    "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "process.stdout.write('GC=' + gc.pid + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join('\n'), 'utf8');
  const p = spawn(process.execPath, [treeScript], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  let gcPid = null;
  let out = '';
  p.stdout.on('data', d => { out += d.toString('utf8'); const m = /GC=(\d+)/.exec(out); if (m) gcPid = Number(m[1]); });
  await waitUntil(() => Number.isInteger(gcPid) && gcPid > 0, 5000, 'dsh grandchild pid');
  killProcessTree(p.pid);
  await waitUntil(() => !isProcessAlive(p.pid) && !isProcessAlive(gcPid), 6000, 'dsh tree dead');
  assert.equal(isProcessAlive(p.pid), false);
  assert.equal(isProcessAlive(gcPid), false);

  // Runtime engine_team new v0.19 actions parity
  const rt = new DshSuperTeamsRuntime({ dataDir: rtDir, mockRunner: async () => ({ status: 'completed', text: 'ok' }) });
  try {
    const execCtx = { sessionId: 'sess-1', agentName: 'coordinator' };
    const posture = await rt.executeTool('engine_team', { action: 'security_posture' }, execCtx);
    assert.equal(posture.isolationLevel, 'env_and_config_isolated_same_os_user');
    const probe = await rt.executeTool('engine_team', { action: 'repo_probe', repoPath: repoDir }, execCtx);
    assert.equal(probe.autoSelected, false);
    const created = await rt.executeTool('engine_team', {
      action: 'create',
      requestId: randomUUID(),
      name: 'RT Budget Team',
      goal: 'Test runtime v0.19 schema',
      workspaceMode: 'git-worktree',
      repoPath: repoDir,
      budget: { maxTeamAttempts: 5, maxTeamTokensSoft: 50000 },
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
    }, execCtx);
    const budget = await rt.executeTool('engine_team', { action: 'budget_get', teamId: created.id }, execCtx);
    assert.equal(budget.config.maxTeamAttempts, 5);
    const rec = await rt.executeTool('engine_team', { action: 'env_recipe_approve', teamId: created.id, repoPath: repoDir, selectedCommands: ['npm test'], approvedBy: 'alice' }, execCtx);
    assert.equal(rec.approved, true);
  } finally {
    await rt.close();
  }
});

test('DSH v0.19 budget guard & watchdogs: concurrent CAS attempt race, monotonic tokens, duration kill, same-error breaker', async t => {
  const root = makeTempDir('dsh-v019-budget-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const d0 = path.join(root, 'd0');
  const e0 = new Engine({ dataDir: d0, adapter: createScriptedAdapter(), contextStore: new ContextStore(path.join(d0, 'ctx')) });
  await e0.initialize();
  try {
    const team0 = e0.createTeam({
      requestId: randomUUID(),
      name: 'DSH CAS Team',
      goal: 'Test CAS and monotonic tokens',
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
      budget: { maxTeamAttempts: 1, maxTeamTokensSoft: 1000 },
    });
    const race = await Promise.allSettled([
      Promise.resolve().then(() => e0.budgetGuard.reserveAttempt(team0.id, 'dsh-att-1')),
      Promise.resolve().then(() => e0.budgetGuard.reserveAttempt(team0.id, 'dsh-att-2')),
    ]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(race.filter(r => r.status === 'rejected' && r.reason?.code === 'BUDGET_EXCEEDED_ATTEMPTS').length, 1);

    const winnerId = e0.getTeamBudget(team0.id).inFlightAttemptIds[0];
    assert.equal(e0.budgetGuard.recordUsageSnapshot(team0.id, winnerId, 't1', { totalTokens: 600 }).totalTokens, 600);
    assert.equal(e0.budgetGuard.recordUsageSnapshot(team0.id, winnerId, 't1', { totalTokens: 600 }).dedupedOrStale, true);
    assert.equal(e0.budgetGuard.recordUsageSnapshot(team0.id, winnerId, 't1', { totalTokens: 300 }).totalTokens, 600);
    const breach = e0.budgetGuard.recordUsageSnapshot(team0.id, winnerId, 't1', { totalTokens: 1200 });
    assert.equal(breach.softLimitExceeded, true);
    assert.equal(e0.getTeamBudget(team0.id).inFlightExposureAtBreach, 1);
  } finally {
    await e0.close();
  }

  let wdPid = null;
  let breakerAttempts = 0;
  const d1 = path.join(root, 'd1');
  const engine = new Engine({
    dataDir: d1,
    retryBaseDelayMs: 20,
    contextStore: new ContextStore(path.join(d1, 'ctx')),
    adapter: createScriptedAdapter(async task => {
      if (task.title === 'Hanging Task') {
        const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        wdPid = s.pid;
        return { pid: s.pid, completion: new Promise(() => {}), interrupt: async () => {} };
      }
      if (task.title === 'Identical Failure') {
        breakerAttempts += 1;
        return { status: 'failed', error: `DB deadlock at 2026-11-26T21:10:0${breakerAttempts}.000Z (${randomUUID()})` };
      }
      return { status: 'completed', text: 'ok' };
    }),
  });
  await engine.initialize();
  try {
    const wdTeam = engine.createTeam({
      requestId: randomUUID(), name: 'DSH Watchdog', goal: 'Timeout task',
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
      budget: { maxTaskDurationMs: 220 },
    });
    const wdTask = engine.submit({ requestId: randomUUID(), teamId: wdTeam.id, memberId: wdTeam.members[0].id, title: 'Hanging Task', goal: 'Hang' });
    await engine.teamControl(wdTeam.id, 'resume');
    await waitUntil(() => engine.get(wdTask.id).state === 'failed', 10000, 'dsh watchdog fail');
    assert.match(engine.get(wdTask.id).error, /budget_exceeded:duration/);
    await waitUntil(() => wdPid && !isProcessAlive(wdPid), 5000, 'dsh watchdog pid gone');

    const brTeam = engine.createTeam({
      requestId: randomUUID(), name: 'DSH Breaker', goal: 'Trip on repeat errors',
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
      budget: { sameErrorBreakerThreshold: 2 },
    });
    const brTask = engine.submit({ requestId: randomUUID(), teamId: brTeam.id, memberId: brTeam.members[0].id, title: 'Identical Failure', goal: 'Fail twice', maxRetries: 3 });
    await engine.teamControl(brTeam.id, 'resume');
    await waitUntil(() => engine.get(brTask.id).state === 'paused', 10000, 'dsh breaker paused');
    assert.equal(engine.get(brTask.id).blockReason, 'same_error_breaker');
    assert.equal(breakerAttempts, 2);
  } finally {
    await engine.close();
  }
});

test('DSH v0.19 candidate gates + real git init --bare remote delivery: allowlist, rewind freeze, PR reconcile, single active revision', async t => {
  const root = makeTempDir('dsh-v019-remote-');
  const repoDir = path.join(root, 'repo');
  const bareDir = path.join(root, 'remote.git');
  const dataDir = path.join(root, 'data');
  const baseCommit = initGitRepo(repoDir, { 'README.md': '# DSH Remote\n', 'app.txt': 'v0\n' });
  execFileSync('git', ['init', '--bare', bareDir], { stdio: 'pipe' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const engine = new Engine({
    dataDir,
    contextStore: new ContextStore(path.join(dataDir, 'ctx')),
    adapter: createScriptedAdapter(async task => {
      if (task.title === 'Task V1') fs.writeFileSync(path.join(task.cwd, 'app.txt'), 'dsh-v1\n', 'utf8');
      if (task.title === 'Task V2') fs.writeFileSync(path.join(task.cwd, 'app.txt'), 'dsh-v2\n', 'utf8');
      return { status: 'completed', text: 'ok' };
    }),
  });
  await engine.initialize();
  try {
    const team = engine.createTeam({
      requestId: randomUUID(),
      name: 'DSH Remote Team',
      goal: '实现远端交付。',
      workspaceMode: 'git-worktree',
      repoPath: repoDir,
      allowedRemoteRepos: ['org/dsh-allowed'],
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
    });

    const t1 = engine.submit({
      requestId: 'dsh-v1', teamId: team.id, memberId: team.members[0].id,
      title: 'Task V1', goal: 'Write v1', writeScopes: ['app.txt'],
      checks: [{ type: 'file_contains', path: 'app.txt', value: 'dsh-v1' }],
    });
    await engine.teamControl(team.id, 'resume');
    await waitUntil(() => engine.get(t1.id).state === 'checked', 10000, 'dsh t1 checked');
    const t1Acc = await engine.accept(t1.id, { expectedRevision: engine.get(t1.id).revision, reason: 'ok' });

    const badCand = await engine.createCandidate(team.id, {
      taskIds: [t1Acc.id],
      integrationCheck: { type: 'node_test', path: 'app.txt', testScript: 'process.exit(1);' },
    });
    assert.equal(badCand.candidate.status, 'verification_failed');
    assert.throws(
      () => engine.approveCandidate(team.id, { candidateId: badCand.candidate.id, purpose: 'local_publish', branchName: 'nope', actor: 'alice' }),
      err => err.code === 'CANDIDATE_VERIFICATION_FAILED',
    );

    const c1 = (await engine.createCandidate(team.id, { taskIds: [t1Acc.id] })).candidate;
    const appRev = engine.approveCandidate(team.id, { candidateId: c1.id, purpose: 'local_publish', branchName: 'rev-branch', actor: 'alice' });
    engine.revokeApproval(team.id, { approvalId: appRev.id, reason: 'test revoke' });
    await assert.rejects(() => engine.publishCandidateLocal(team.id, { candidateId: c1.id, approvalId: appRev.id }), err => err.code === 'APPROVAL_REVOKED');

    const appR1 = engine.approveCandidate(team.id, { candidateId: c1.id, purpose: 'remote_push', targetRef: 'refs/heads/superagent/dsh-r1', actor: 'alice' });
    await assert.rejects(
      () => engine.pushCandidateRemote(team.id, { deliveryStreamId: 's1', candidateId: c1.id, approvalId: appR1.id, repo: 'org/other', remoteUrl: bareDir, stableBranch: 'superagent/dsh-r1', expectedOldOid: ZERO_OID, purpose: 'remote_push' }),
      err => err.code === 'REMOTE_REPO_NOT_ALLOWED',
    );
    const p1 = await engine.pushCandidateRemote(team.id, { deliveryStreamId: 's1', candidateId: c1.id, approvalId: appR1.id, repo: 'org/dsh-allowed', remoteUrl: bareDir, stableBranch: 'superagent/dsh-r1', expectedOldOid: ZERO_OID, purpose: 'remote_push' });
    assert.equal(p1.ok, true);

    const t2 = engine.submit({
      requestId: 'dsh-v2', teamId: team.id, memberId: team.members[0].id,
      title: 'Task V2', goal: 'Write v2', writeScopes: ['app.txt'],
      checks: [{ type: 'file_contains', path: 'app.txt', value: 'dsh-v2' }],
    });
    await engine.teamControl(team.id, 'resume');
    await waitUntil(() => engine.get(t2.id).state === 'checked', 10000, 'dsh t2 checked');
    const t2Acc = await engine.accept(t2.id, { expectedRevision: engine.get(t2.id).revision, reason: 'ok2' });
    const c2 = (await engine.createCandidate(team.id, { taskIds: [t2Acc.id] })).candidate;
    const appR2 = engine.approveCandidate(team.id, { candidateId: c2.id, purpose: 'remote_push', targetRef: 'refs/heads/superagent/dsh-r1', actor: 'alice' });

    execFileSync('git', [`--git-dir=${bareDir}`, 'update-ref', 'refs/heads/superagent/dsh-r1', baseCommit], { stdio: 'pipe' });
    const pRewind = await engine.pushCandidateRemote(team.id, { deliveryStreamId: 's1', candidateId: c2.id, approvalId: appR2.id, repo: 'org/dsh-allowed', remoteUrl: bareDir, stableBranch: 'superagent/dsh-r1', expectedOldOid: c1.commitOid, purpose: 'remote_push' });
    assert.equal(pRewind.ok, false);
    assert.equal(pRewind.code, 'REMOTE_LEASE_MISMATCH_FROZEN');
    assert.equal(pRewind.stream.state, 'frozen_external_drift');
    assert.equal(execFileSync('git', [`--git-dir=${bareDir}`, 'rev-parse', 'refs/heads/superagent/dsh-r1'], { encoding: 'utf8' }).trim(), baseCommit);

    engine.resolveExternalDrift(team.id, { deliveryStreamId: 's1', action: 'redirect_new_branch', newBranch: 'superagent/dsh-r2', actor: 'alice' });
    const appPr = engine.approveCandidate(team.id, { candidateId: c2.id, purpose: 'draft_pr', targetRef: 'refs/heads/superagent/dsh-r2', actor: 'alice' });
    const remotePrs = [];
    let calls = 0;
    const lostTransport = {
      async createPullRequest({ repo, head, base, title, body }) {
        calls += 1;
        remotePrs.push({ number: 77, title, url: `https://github.com/${repo}/pull/77`, state: 'open', merged: false, head: { sha: c2.commitOid, ref: head, repo: { full_name: repo } }, base: { ref: base, repo: { full_name: repo } }, body });
        throw new Error('502 Bad Gateway after remote PR created');
      },
      async listPullRequests() { return remotePrs; },
      async getPullRequest({ prNumber }) { return remotePrs.find(x => x.number === prNumber) || null; },
      async listCheckRuns() { return []; },
    };
    const prLost = await engine.createPullRequestIdempotent(team.id, { deliveryStreamId: 's1', candidateId: c2.id, approvalId: appPr.id, repo: 'org/dsh-allowed', headBranch: 'superagent/dsh-r2', baseBranch: 'main', title: 'DSH PR', draft: true, transport: lostTransport });
    assert.equal(prLost.status, 'receipt_unknown');
    assert.equal(calls, 1);
    const rec = await engine.reconcileRemoteIntents(team.id, { deliveryStreamId: 's1', repo: 'org/dsh-allowed', transport: lostTransport });
    assert.equal(rec.writeRequestsMade, 0);
    assert.equal(rec.results[0].outcome, 'confirmed_recovered');
    assert.equal(rec.results[0].prNumber, 77);
    assert.equal(calls, 1);

    // Dual check signatures -> single active revision task
    const f1 = engine.ingestRemoteFailureEvent(team.id, { deliveryStreamId: 's1', candidateId: c2.id, repo: 'org/dsh-allowed', prNumber: 77, headSha: c2.commitOid, checkSignature: 'lint', failureSummary: 'err1' });
    const fDup = engine.ingestRemoteFailureEvent(team.id, { deliveryStreamId: 's1', candidateId: c2.id, repo: 'org/dsh-allowed', prNumber: 77, headSha: c2.commitOid, checkSignature: 'lint', failureSummary: 'err1' });
    const f2 = engine.ingestRemoteFailureEvent(team.id, { deliveryStreamId: 's1', candidateId: c2.id, repo: 'org/dsh-allowed', prNumber: 77, headSha: c2.commitOid, checkSignature: 'test', failureSummary: 'err2' });
    assert.equal(f1.createdNewRevision, true);
    assert.equal(fDup.dedupedEvent, true);
    assert.equal(f2.reusedActiveRevision, true);
    assert.equal(f2.revisionTaskId, f1.revisionTaskId);
    assert.equal(engine.get(f1.revisionTaskId).remoteFailureEvidence.length, 2);
  } finally {
    await engine.close();
  }
});
