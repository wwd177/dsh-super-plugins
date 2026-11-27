import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { createDshEngineRouter } from '../packages/super-teams/src/engine/dsh-http.mjs';
import { DshAdapter } from '../packages/super-teams/src/engine/dsh-adapter.mjs';
import { validateCommandTest } from '../packages/super-teams/src/engine/verification.mjs';
import { buildIsolatedTestEnv } from '../packages/super-teams/src/engine/core/src/process-isolation.mjs';
import {
  primaryToolSchemas,
  legacyToolSchemas,
  toolSchemas,
  parseToolInput,
  executeStandaloneBoard,
} from '../packages/super-teams/dist/tool-schemas.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function safeRm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
}

function initGitRepo(rootDir, files = { 'README.md': '# DSH v0.20.3 Bug Hunt\n' }) {
  fs.mkdirSync(rootDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: rootDir, stdio: 'pipe' });
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
    async models() { return [{ model: 'deepseek/deepseek-reasoner', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'] }]; },
    preflightSession() { return { ok: true, rootId: 'sess-root' }; },
    async start(task, hooks) {
      await hooks.beforeExecute();
      const id = ++seq;
      const threadId = `dsh-thread-${id}`;
      const turnId = `dsh-turn-${id}`;
      await hooks.onIdentity({ threadId, turnId });
      const res = await handler(task, { threadId, turnId });
      return {
        threadId,
        turnId,
        pid: res?.pid ?? null,
        pids: res?.pids ?? null,
        interrupt: res?.interrupt ?? (async () => {}),
        completion: res?.completion ?? Promise.resolve(res),
      };
    },
  };
}

async function waitUntil(pred, timeoutMs = 8000, label = 'condition', diag = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  const extra = diag ? ` (${JSON.stringify(diag())})` : '';
  throw new Error(`Timed out waiting for ${label}${extra}`);
}

test('v0.20.3 DSH Engine: createTeam budget tx/fp, preflight zero orphan worktree, watchdog, rework & refusal cap', async t => {
  const tmp = makeTempDir('dsh-v0203-eng-');
  const dataDir = path.join(tmp, 'data');
  const repoDir = path.join(tmp, 'repo');
  initGitRepo(repoDir);

  let spawnedPid = null;
  const adapter = createScriptedAdapter(async task => {
    if (task.title === 'Hanging NoPid') {
      return { completion: new Promise(() => {}) };
    }
    if (task.title === 'Hanging ChildPid') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      spawnedPid = child.pid;
      return { pid: child.pid, completion: new Promise(() => {}) };
    }
    if (task.title === 'Fail Once') {
      return { status: 'failed', text: 'err out', error: 'transient crash', usage: { totalTokens: 25 } };
    }
    return { status: 'completed', text: 'ok', usage: { totalTokens: 10 } };
  });

  const engine = new Engine({ dataDir, adapter, contextStore: new ContextStore(path.join(dataDir, 'context')), retryBaseDelayMs: 20 });
  await engine.initialize();
  t.after(async () => {
    await engine.close().catch(() => {});
    if (spawnedPid) try { process.kill(spawnedPid, 'SIGKILL'); } catch {}
    safeRm(tmp);
  });

  // createTeam budget tx + fingerprint check
  const reqId = randomUUID();
  const tBudget = engine.createTeam({
    requestId: reqId,
    name: 'DSH Budget FP',
    goal: 'Verify atomic budget and fingerprint',
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
    budget: { maxTeamAttempts: 3 },
    allowedRemoteRepos: ['octocat/a'],
  });
  assert.equal(engine.getTeamBudget(tBudget.id).config.maxTeamAttempts, 3);
  assert.throws(
    () => engine.createTeam({
      requestId: reqId,
      name: 'DSH Budget FP',
      goal: 'Verify atomic budget and fingerprint',
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
      budget: { maxTeamAttempts: 4 },
      allowedRemoteRepos: ['octocat/a'],
    }),
    /different parameters/i,
  );

  // Watchdog without PID -> unknown, executionUnresolved: true, retains slot until abandon + resolveUnresolved
  const wdTeam = engine.createTeam({
    requestId: randomUUID(),
    name: 'DSH Watchdog NoPid',
    goal: 'Uncertified duration timeout',
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Hang' }],
    budget: { maxTaskDurationMs: 120, maxInFlight: 1 },
  });
  const wdTask = engine.submit({
    requestId: randomUUID(),
    teamId: wdTeam.id,
    memberId: wdTeam.members[0].id,
    title: 'Hanging NoPid',
    goal: 'Hang without PID',
    maxRetries: 2,
  });
  await engine.teamControl(wdTeam.id, 'resume');
  await waitUntil(() => engine.get(wdTask.id).state === 'unknown', 8000, 'no-pid unknown', () => engine.get(wdTask.id));
  const afterWd = engine.get(wdTask.id);
  assert.equal(afterWd.executionUnresolved, true);
  assert.equal(afterWd.durationTimedOut, true);
  assert.equal(afterWd.retryCount ?? 0, 0);
  assert.equal(engine.getTeamBudget(wdTeam.id).inFlightAttemptIds.length, 1);

  const blockedTask = engine.submit({
    requestId: randomUUID(),
    teamId: wdTeam.id,
    memberId: wdTeam.members[0].id,
    title: 'Blocked By Slot',
    goal: 'Wait cleanly without workspace leak',
  });
  await engine.runDue();
  assert.equal(fs.existsSync(path.join(dataDir, 'workspaces', blockedTask.id)), false);

  const ab = engine.abandon(wdTask.id, {
    expectedRevision: afterWd.revision,
    reason: 'Timed out subagent without local PID',
    evidence: 'watchdog',
    actor: 'operator',
  });
  engine.resolveUnresolved(wdTask.id, {
    expectedRevision: ab.revision,
    expectedAttemptId: ab.attemptId,
    reason: 'Confirmed inactive',
    evidence: 'session check',
    actor: 'operator',
  });
  assert.equal(engine.getTeamBudget(wdTeam.id).inFlightAttemptIds.length, 0);
  await waitUntil(() => ['submitted', 'accepted'].includes(engine.get(blockedTask.id).state), 8000, 'second finishes');

  // Watchdog with child PID -> failed, executionUnresolved: false, no autoRetry
  const pidTeam = engine.createTeam({
    requestId: randomUUID(),
    name: 'DSH Watchdog Pid',
    goal: 'Certified kill on child PID',
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Child' }],
    budget: { maxTaskDurationMs: 120 },
  });
  const pidTask = engine.submit({
    requestId: randomUUID(),
    teamId: pidTeam.id,
    memberId: pidTeam.members[0].id,
    title: 'Hanging ChildPid',
    goal: 'Child hang',
    maxRetries: 2,
  });
  await engine.teamControl(pidTeam.id, 'resume');
  await waitUntil(() => engine.get(pidTask.id).state === 'failed', 8000, 'child pid failed', () => engine.get(pidTask.id));
  assert.equal(engine.get(pidTask.id).executionUnresolved, false);
  assert.equal(engine.get(pidTask.id).durationTimedOut, true);
  assert.equal(engine.get(pidTask.id).retryCount ?? 0, 0);

  // maxTeamAttempts preflight blocks before creating worktree and sets frozenReason
  const wtTeam = engine.createTeam({
    requestId: randomUUID(),
    name: 'DSH Preflight WT',
    goal: 'Zero orphan worktree',
    workspaceMode: 'git-worktree',
    repoPath: repoDir,
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Work' }],
    budget: { maxTeamAttempts: 1 },
  });
  const wt1 = engine.submit({ requestId: randomUUID(), teamId: wtTeam.id, memberId: wtTeam.members[0].id, title: 'W1', goal: 'Run 1' });
  await engine.teamControl(wtTeam.id, 'resume');
  await waitUntil(() => engine.get(wt1.id).state === 'submitted', 8000, 'wt1 submitted');
  const wt2 = engine.submit({ requestId: randomUUID(), teamId: wtTeam.id, memberId: wtTeam.members[0].id, title: 'W2', goal: 'Run 2' });
  await engine.runDue();
  assert.equal(engine.get(wt2.id).state, 'blocked');
  assert.equal(engine.get(wt2.id).blockReason, 'budget');
  assert.equal(fs.existsSync(path.join(dataDir, 'workspaces', wt2.id)), false);
  assert.equal(engine.getTeamBudget(wtTeam.id).frozenReason, 'budget_exceeded:attempts');

  // Rework clears stale fields + 500 refusal log cap
  const rwTeam = engine.createTeam({
    requestId: randomUUID(),
    name: 'DSH Rework Clean',
    goal: 'Clear stale attempt fields',
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
  });
  const rwTask = engine.submit({ requestId: randomUUID(), teamId: rwTeam.id, memberId: rwTeam.members[0].id, title: 'Fail Once', goal: 'Fail' });
  await engine.teamControl(rwTeam.id, 'resume');
  await waitUntil(() => engine.get(rwTask.id).state === 'failed', 8000, 'fail once');
  await engine.teamControl(rwTeam.id, 'pause');
  const rw = await engine.rework(rwTask.id, { expectedRevision: engine.get(rwTask.id).revision, feedback: 'Try again cleanly', actor: 'reviewer' });
  assert.equal(rw.summary, null);
  assert.equal(rw.usage, null);
  assert.equal(rw.durationMs, null);
  assert.equal(rw.durationTimedOut, false);

  for (let i = 0; i < 510; i++) {
    engine.recordRefusal('tool', `act-${i}`, 'refused', { blob: i === 509 ? 'Y'.repeat(6000) : 'ok' });
  }
  const refusals = engine.listRefusals(600);
  assert.equal(refusals.length, 500);
  assert.equal(refusals[0].payload.truncated, true);
});

test('v0.20.3 DSH HTTP, Adapter, Dist Tool Schemas, Verification & Installer hardening', async t => {
  const tmp = makeTempDir('dsh-v0203-http-');
  t.after(() => safeRm(tmp));

  // Windows case-variant Path env strip
  const prevPath = process.env.PATH;
  const prevLower = process.env.Path;
  let iso = null;
  try {
    if (process.platform === 'win32') process.env.Path = 'C:\\Windows;C:\\bad-case';
    iso = buildIsolatedTestEnv(tmp, { stripPersonalPathEntries: false });
    if (process.platform === 'win32') {
      assert.deepEqual(Object.keys(iso.env).filter(k => k.toUpperCase() === 'PATH'), ['PATH']);
    }
  } finally {
    iso?.cleanup?.();
    if (prevPath !== undefined) process.env.PATH = prevPath;
    if (prevLower !== undefined) process.env.Path = prevLower;
    else if (process.platform === 'win32') delete process.env.Path;
  }

  // Verification dotnet/npm guards
  assert.throws(() => validateCommandTest({ type: 'command_test', command: 'dotnet', args: ['test', '/p:Exec=1'] }), /forbids flag/i);
  assert.throws(() => validateCommandTest({ type: 'command_test', command: 'npm', args: ['test', '--', 'x|calc'] }), /metacharacters/i);

  // Zero-dependency compiled dist/tool-schemas.mjs verification
  assert.equal(primaryToolSchemas.length, 8);
  assert.ok(Array.isArray(legacyToolSchemas) && legacyToolSchemas.length >= 1);
  assert.ok(Array.isArray(toolSchemas));
  assert.equal(typeof parseToolInput, 'function');
  assert.equal(typeof executeStandaloneBoard, 'function');
  const parsedTeam = parseToolInput('engine_team', {
    action: 'remote_drift_resolve',
    teamId: 'team-1',
    headSha: 'a'.repeat(40),
    resolveAction: 'adopt_as_candidate',
  });
  assert.equal(parsedTeam.resolveAction, 'adopt_as_candidate');
  assert.equal(parsedTeam.headSha, 'a'.repeat(40));

  // DshAdapter models fallback not cached + closed rejects start
  const mockCtx = {
    get() { return undefined; },
  };
  const dshAdapter = new DshAdapter({ ctx: mockCtx });
  const fallbackModels = await dshAdapter.models({ sessionId: 'offline-s1' });
  assert.equal(fallbackModels[0].model, 'dsh-inherit/session-default');
  assert.equal(dshAdapter._modelsCacheMap?.size ?? 0, 0, 'fallback model list must not be cached');
  await dshAdapter.close();
  await assert.rejects(() => dshAdapter.start({ id: 't1', prompt: 'hi' }), /closed/i);

  // HTTP router checks (501 pr-create, 403 cross-origin fenced, api prefix guard)
  const dataDir = path.join(tmp, 'http-data');
  const eng = new Engine({
    dataDir,
    adapter: createScriptedAdapter(async () => ({ status: 'completed', text: 'ok' })),
    contextStore: new ContextStore(path.join(dataDir, 'context')),
  });
  await eng.initialize();
  t.after(async () => { await eng.close().catch(() => {}); });
  const httpTeam = eng.createTeam({
    requestId: randomUUID(),
    name: 'HTTP Team',
    goal: 'Check HTTP',
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
    allowedRemoteRepos: ['octocat/repo'],
  });
  const router = createDshEngineRouter({
    engine: eng,
    contextStore: eng.contextStore,
    adapter: { status: () => ({ state: 'connected' }), models: async () => [] },
    fence: () => true,
  });

  const invokeRouter = ({ method = 'GET', url, headers = {}, body = null }) => new Promise((resolve, reject) => {
    const chunks = [];
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1', ...headers },
      destroyed: false,
      destroy() { this.destroyed = true; },
      async *[Symbol.asyncIterator]() {
        if (body !== null) yield Buffer.from(JSON.stringify(body), 'utf8');
      },
    };
    const res = {
      statusCode: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      writeHead(code, hdrs = {}) {
        this.statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v);
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        resolve({ status: this.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      },
    };
    Promise.resolve(router.handler(req, res)).catch(reject);
  });

  const prRes = await invokeRouter({
    method: 'POST',
    url: `/superagent-engine/api/teams/${encodeURIComponent(httpTeam.id)}/remote/pr-create`,
    headers: { origin: 'dsh-app://app' },
    body: { candidateId: 'c1', approvalId: 'a1', repo: 'octocat/repo', headBranch: 'superagent/h', baseBranch: 'main', title: 'PR' },
  });
  assert.equal(prRes.status, 501);
  assert.equal(JSON.parse(prRes.text).code, 'REMOTE_PR_TRANSPORT_UNAVAILABLE');

  const evilOrigin = await invokeRouter({
    method: 'POST',
    url: `/superagent-engine/api/teams/${encodeURIComponent(httpTeam.id)}/control`,
    headers: { origin: 'https://evil.invalid' },
    body: { action: 'pause' },
  });
  assert.equal(evilOrigin.status, 403);

  const nonApiSource = await invokeRouter({ method: 'GET', url: '/superagent-engine/v2/sources/missing' });
  assert.equal(nonApiSource.status, 404);

  // Installer profile validation & stray skill file detection
  const badProfile = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'install.mjs'), '--verify', '--profile', '../evil', '--json'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(badProfile.status, 0);
  assert.match(`${badProfile.stdout}\n${badProfile.stderr}`, /Invalid profile/i);

  // Synthetic verify root with stray file inside skill dir
  const synHome = path.join(tmp, 'syn-dsh');
  const stageBase = path.join(synHome, 'local-packages', 'dsh-super-plugins');
  const profDir = path.join(synHome, 'profiles', 'desktop');
  fs.mkdirSync(profDir, { recursive: true });
  const pkgAgentStage = path.join(stageBase, 'superagent');
  const pkgTeamsStage = path.join(stageBase, 'super-teams');
  for (const [pkg, skills] of [
    [pkgAgentStage, ['superagent-workflow', 'workflow-quality', 'development-handoff']],
    [pkgTeamsStage, ['super-teams']],
  ]) {
    for (const sk of skills) {
      const stagedSk = path.join(pkg, 'skills', sk);
      const liveSk = path.join(synHome, 'skills', sk);
      fs.mkdirSync(stagedSk, { recursive: true });
      fs.mkdirSync(liveSk, { recursive: true });
      fs.writeFileSync(path.join(stagedSk, 'SKILL.md'), `# ${sk}\n`, 'utf8');
      fs.writeFileSync(path.join(liveSk, 'SKILL.md'), `# ${sk}\n`, 'utf8');
    }
  }
  fs.writeFileSync(path.join(synHome, 'skills', 'superagent-workflow', 'stray.txt'), 'unwanted\n', 'utf8');
  fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({
    name: 'profile-desktop',
    dependencies: {
      '@local/dsh-superagent-menu': `file:${pkgAgentStage}`,
      '@local/dsh-super-teams': `file:${pkgTeamsStage}`,
    },
    dsh: { profile: { bundles: ['@local/dsh-superagent-menu', '@local/dsh-super-teams'] } },
  }, null, 2), 'utf8');

  const strayRes = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'install.mjs'), '--verify', '--dsh-home', synHome, '--profile', 'desktop', '--json'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(strayRes.status, 0);
  assert.match(`${strayRes.stdout}\n${strayRes.stderr}`, /inventory mismatch.*stray\.txt/i);
});
