import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { createStandaloneDshServer } from '../packages/super-teams/src/engine/dsh-http.mjs';
import { buildInspection } from '../packages/super-teams/src/engine/overview.mjs';
import { recoveryGuidance } from '../packages/super-teams/src/engine/recovery-guidance.mjs';
import { primaryToolSchemas, parseToolInput } from '../packages/super-teams/dist/tool-schemas.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'install.mjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function createFakeDshCli(dir, { hangMs = 0 } = {}) {
  const runnerPath = path.join(dir, 'fake-dsh.mjs');
  const script = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const hangMs = ${Number(hangMs) || 0};
if (hangMs > 0) {
  setTimeout(() => {}, hangMs);
  await new Promise(resolve => setTimeout(resolve, hangMs));
  process.exit(0);
}
if (args[0] === 'plugin') {
  const pIdx = args.indexOf('--profile');
  const profile = pIdx >= 0 ? args[pIdx + 1] : 'desktop';
  const actionIdx = pIdx >= 0 ? pIdx + 2 : 1;
  const action = args[actionIdx];
  const dshHome = process.env.DSH_HOME;
  const profDir = path.join(dshHome, 'profiles', profile);
  const pkgFile = path.join(profDir, 'package.json');
  fs.mkdirSync(profDir, { recursive: true });
  let pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, 'utf8')) : { name: 'profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
  if (action === 'add') {
    const specs = args.slice(actionIdx + 1);
    for (const spec of specs) {
      const target = spec.replace(/^(?:file|link):/, '');
      const mPkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
      pkg.dependencies[mPkg.name] = spec;
      if (!pkg.dsh.profile.bundles.includes(mPkg.name)) pkg.dsh.profile.bundles.push(mPkg.name);
    }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\\n');
    process.exit(0);
  }
  if (action === 'remove') {
    const names = args.slice(actionIdx + 1);
    for (const name of names) {
      delete pkg.dependencies[name];
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== name);
    }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\\n');
    process.exit(0);
  }
}
process.exit(0);
`;
  fs.writeFileSync(runnerPath, script, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = path.join(dir, 'dsh.cmd');
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${runnerPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = path.join(dir, 'dsh');
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${runnerPath}" "$@"\n`, 'utf8');
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

function readBirthForTest(pid) {
  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const res = spawnSync(
      ps,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return res.status === 0 ? res.stdout.trim() : null;
  }
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    return rp >= 0 ? (stat.slice(rp + 2).trim().split(/\s+/)[19] || null) : null;
  }
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0 ? res.stdout.trim() : null;
}

test('DSH v0.20.0 P0: SQLite lock guard refuses live PID eviction >60s, serializes concurrent runs, cleans timed-out CLI + fresh stage, and scopes purge-data to profile only', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v0200-inst-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const dshHome = path.join(tmp, 'dsh-home');
  const cliBinDir = path.join(tmp, 'cli-ok');
  const hangBinDir = path.join(tmp, 'cli-hang');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(cliBinDir, { recursive: true });
  fs.mkdirSync(hangBinDir, { recursive: true });
  for (const prof of ['desktop', 'other']) {
    const profDir = path.join(dshHome, 'profiles', prof);
    fs.mkdirSync(profDir, { recursive: true });
    fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${prof}`,
      private: true,
      dependencies: { '@deepseek-ai/dsh-core': '0.2.2' },
      dsh: { profile: { bundles: [] } },
    }, null, 2) + '\n', 'utf8');
  }

  const okCli = createFakeDshCli(cliBinDir);
  const hangCli = createFakeDshCli(hangBinDir, { hangMs: 20_000 });

  // 1) Hanging CLI timeout triggers process-tree cleanup, releases lock, and removes fresh stageRoot on failure
  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      [INSTALL_SCRIPT, '--dsh-home', dshHome, '--dsh-cli', hangCli, '--profile', 'desktop', '--json'],
      { env: { ...process.env, DSH_CLI_TIMEOUT_MS: '600' }, windowsHide: true },
    ),
    /timed out after 600ms/i,
  );
  assert.equal(fs.existsSync(path.join(dshHome, '.dsh-super-plugins.lock')), false, 'lock must be released after CLI timeout');
  assert.equal(fs.existsSync(path.join(dshHome, 'local-packages', 'dsh-super-plugins')), false, 'fresh failed install must roll back stageRoot');

  // 2) Concurrent installs serialize cleanly via SQLite lock guard
  const [resA, resB] = await Promise.all([
    execFileAsync(process.execPath, [INSTALL_SCRIPT, '--dsh-home', dshHome, '--dsh-cli', okCli, '--profile', 'desktop', '--json'], { windowsHide: true }),
    execFileAsync(process.execPath, [INSTALL_SCRIPT, '--dsh-home', dshHome, '--dsh-cli', okCli, '--profile', 'other', '--json'], { windowsHide: true }),
  ]);
  assert.equal(JSON.parse(resA.stdout).ok, true);
  assert.equal(JSON.parse(resB.stdout).ok, true);
  assert.equal(fs.existsSync(path.join(dshHome, '.dsh-super-plugins.lock')), false);

  // 3) Live PID with stale timestamp (>60s old) MUST NOT be evicted
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { holder.kill(); } catch {} });
  const holderBirth = readBirthForTest(holder.pid);
  const lockFile = path.join(dshHome, '.dsh-super-plugins.lock');
  fs.writeFileSync(lockFile, JSON.stringify({
    pid: holder.pid,
    birth: holderBirth,
    nonce: 'live-holder-nonce',
    mode: 'install',
    profile: 'desktop',
    startedAt: new Date(Date.now() - 600_000).toISOString(),
  }) + '\n', 'utf8');
  const oldTime = new Date(Date.now() - 600_000);
  fs.utimesSync(lockFile, oldTime, oldTime);

  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      [INSTALL_SCRIPT, '--dsh-home', dshHome, '--dsh-cli', okCli, '--profile', 'desktop', '--json'],
      { env: { ...process.env, DSH_LOCK_WAIT_MS: '600' }, windowsHide: true },
    ),
    /Timed out waiting for DSH installation lock/i,
  );
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'live-holder-nonce', 'live PID lock must remain intact');

  // Killing the holder process makes the lock stale and subsequent mutating install reclaims it cleanly
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));
  const installAfterReclaim = await execFileAsync(
    process.execPath,
    [INSTALL_SCRIPT, '--dsh-home', dshHome, '--dsh-cli', okCli, '--profile', 'desktop', '--json'],
    { env: { ...process.env, DSH_LOCK_WAIT_MS: '5000' }, windowsHide: true },
  );
  assert.equal(JSON.parse(installAfterReclaim.stdout).ok, true);
  assert.equal(fs.existsSync(lockFile), false);

  // 4) --uninstall --purge-data deletes ONLY target profile plugin-data, preserving legacy root and sibling profile data
  const legacyData = path.join(dshHome, 'plugin-data', 'dsh-super-teams');
  const desktopData = path.join(dshHome, 'profiles', 'desktop', 'plugin-data', 'dsh-super-teams');
  const siblingData = path.join(dshHome, 'profiles', 'other', 'plugin-data', 'dsh-super-teams');
  fs.mkdirSync(legacyData, { recursive: true });
  fs.mkdirSync(desktopData, { recursive: true });
  fs.mkdirSync(siblingData, { recursive: true });
  fs.writeFileSync(path.join(legacyData, 'legacy.txt'), 'keep-legacy');
  fs.writeFileSync(path.join(desktopData, 'desktop.txt'), 'purge-me');
  fs.writeFileSync(path.join(siblingData, 'sibling.txt'), 'keep-sibling');

  const unOut = await execFileAsync(
    process.execPath,
    [INSTALL_SCRIPT, '--uninstall', '--purge-data', '--dsh-home', dshHome, '--dsh-cli', okCli, '--profile', 'desktop', '--json'],
    { windowsHide: true },
  );
  const unJson = JSON.parse(unOut.stdout);
  assert.equal(unJson.ok, true);
  assert.equal(unJson.dataScope, 'profile-only');
  assert.equal(unJson.purgedData, true);
  assert.equal(unJson.purgedDataPath, path.resolve(desktopData));
  assert.equal(unJson.legacySharedDataPreserved, path.resolve(legacyData));
  assert.equal(unJson.sharedAssetsPreserved, true);
  assert.equal(fs.existsSync(desktopData), false, 'target profile data must be purged');
  assert.equal(fs.readFileSync(path.join(legacyData, 'legacy.txt'), 'utf8'), 'keep-legacy');
  assert.equal(fs.readFileSync(path.join(siblingData, 'sibling.txt'), 'utf8'), 'keep-sibling');
});

function createDshHarness(t, { inspectImpl, preflightImpl, liveSessions = new Set(['sid-live']) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v0200-eng-'));
  const calls = [];
  const inspectCalls = [];
  const adapter = {
    liveSessions,
    rememberSession() {},
    sessionSnapshot() { return { sessionId: [...liveSessions][0] ?? null }; },
    status() { return { state: 'connected', available: true }; },
    connect: async () => {},
    close: async () => {},
    models: async () => [{ model: 'deepseek-chat', supportedReasoningEfforts: ['medium'] }],
    resolveRootAgent: sid => (sid && liveSessions.has(sid) ? { id: sid } : null),
    preflightSession: sid => {
      if (preflightImpl) return preflightImpl(sid);
      if (sid && !liveSessions.has(sid)) {
        throw Object.assign(new Error(`Session offline: ${sid}`), {
          executionNotStarted: true,
          blocked: true,
          blockReason: 'session-unavailable',
          code: 'SESSION_UNAVAILABLE',
        });
      }
      return { ok: true, sessionId: sid ?? null };
    },
    inspect: async threadId => {
      inspectCalls.push(threadId);
      if (inspectImpl) return await inspectImpl(threadId, inspectCalls.length);
      return { id: threadId, turns: [] };
    },
    start: async (input, callbacks) => {
      await callbacks.beforeExecute();
      const attemptNum = calls.length + 1;
      await callbacks.onIdentity({ threadId: `dsh-thread-${attemptNum}`, turnId: `dsh-turn-${attemptNum}` });
      let resolve;
      const completion = new Promise(done => { resolve = done; });
      const entry = { input, resolve, callbacks, interrupts: 0 };
      calls.push(entry);
      return { completion, interrupt: async () => { entry.interrupts++; } };
    },
  };
  const contextStore = new ContextStore(path.join(root, 'context'));
  let engine = null;
  t.after(async () => {
    if (engine) await engine.close().catch(() => {});
    fs.rmSync(root, { force: true, recursive: true });
  });
  return {
    root,
    calls,
    inspectCalls,
    adapter,
    contextStore,
    async init() {
      engine = new Engine({ dataDir: root, adapter, contextStore, maxConcurrent: 2 });
      await engine.initialize();
      clearInterval(engine.timer);
      return engine;
    },
    async restart() {
      if (engine) await engine.close();
      engine = new Engine({ dataDir: root, adapter, contextStore, maxConcurrent: 2 });
      await engine.initialize();
      clearInterval(engine.timer);
      return engine;
    },
    get engine() {
      return engine;
    },
  };
}

test('DSH v0.20.0 P0/P1: team control resume checks online session, pause/cancel work offline, and _pump secondary preflight blocks cleanly', async t => {
  let preflightCount = 0;
  const h = createDshHarness(t, {
    preflightImpl: sid => {
      preflightCount++;
      if (sid === 'sid-mid-drop' && preflightCount >= 2) {
        throw Object.assign(new Error('Session disconnected before dispatch'), {
          executionNotStarted: true,
          blocked: true,
          blockReason: 'session-unavailable',
          code: 'SESSION_UNAVAILABLE',
        });
      }
      if (sid && !h.adapter.liveSessions.has(sid)) {
        throw Object.assign(new Error(`Session offline: ${sid}`), {
          executionNotStarted: true,
          blocked: true,
          blockReason: 'session-unavailable',
          code: 'SESSION_UNAVAILABLE',
        });
      }
      return { ok: true, sessionId: sid ?? null };
    },
  });
  h.adapter.liveSessions.add('sid-mid-drop');
  const engine = await h.init();
  const { server, token } = createStandaloneDshServer({ engine, contextStore: h.contextStore, adapter: h.adapter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const port = server.address().port;

  const post = (route, body) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'x-engine-token': token, 'Content-Type': 'application/json' } },
      res => {
        let txt = '';
        res.setEncoding('utf8');
        res.on('data', c => { txt += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(txt) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  // 1) Bound team whose session went offline: pause & cancel must succeed offline
  const boundTeam = engine.createTeam({
    requestId: randomUUID(),
    name: 'Offline Control Team',
    goal: 'Test pause/cancel while offline',
    sessionId: 'sid-live',
    members: [{ name: 'worker', role: 'Dev', responsibility: 'Code' }],
  });
  await engine.teamControl(boundTeam.id, 'resume');
  h.adapter.liveSessions.delete('sid-live');

  const paused = await post(`/api/teams/${boundTeam.id}/control`, { action: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.team.control, 'pause');

  const cancelled = await post(`/api/teams/${boundTeam.id}/control`, { action: 'cancel' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.team.control, 'cancel');

  // 2) Unbound team + offline sessionId + resume must return 400 error (not swallowed)
  const unboundTeam = engine.createTeam({
    requestId: randomUUID(),
    name: 'Unbound Resume Check',
    goal: 'Reject offline resume',
    members: [{ name: 'worker', role: 'Dev', responsibility: 'Code' }],
  });
  const badResume = await post(`/api/teams/${unboundTeam.id}/control`, { action: 'resume', sessionId: 'sid-offline' });
  assert.equal(badResume.status, 400);
  assert.match(badResume.body.error, /offline|unavailable|不在线/i);
  assert.equal(engine.getTeam(unboundTeam.id).control, 'pause');
  assert.equal(engine.getTeam(unboundTeam.id).sessionId ?? null, null);

  // 3) Secondary preflightSession failure inside _pump() blocks task with SESSION_UNAVAILABLE & releases budget reservation
  const dropTeam = engine.createTeam({
    requestId: randomUUID(),
    name: 'Mid-prepare drop team',
    goal: 'Test secondary preflight failure',
    sessionId: 'sid-mid-drop',
    members: [{ name: 'worker', role: 'Dev', responsibility: 'Code' }],
  });
  const tDrop = engine.submit({
    requestId: randomUUID(),
    teamId: dropTeam.id,
    memberId: dropTeam.members[0].id,
    title: 'Drop mid preflight',
    goal: 'Should block cleanly',
  });
  preflightCount = 0;
  await engine.teamControl(dropTeam.id, 'resume');
  await tick();
  const afterDrop = engine.get(tDrop.id);
  assert.equal(afterDrop.state, 'blocked');
  assert.equal(afterDrop.blockReason, 'session-unavailable');
  assert.equal(afterDrop.blockCode, 'SESSION_UNAVAILABLE');
  assert.equal(h.calls.length, 0, 'task must not start after secondary preflight failure');
});

test('DSH v0.20.0 P1/P2: bounded auto-recovery (interrupted + 12-try restart cap), resolve_unresolved expectedAttemptId, overview pruning & 8-tool schema', async t => {
  // Verify compiled 8-tool schema parity
  assert.equal(primaryToolSchemas.length, 8);
  const parsed = parseToolInput('engine_control', {
    taskId: 't-1',
    action: 'resolve_unresolved',
    expectedRevision: 3,
    expectedAttemptId: 'att-1',
    reason: 'Stopped confirmed',
    evidence: 'Exit verified',
  });
  assert.equal(parsed.expectedAttemptId, 'att-1');

  let mode = 'interrupted';
  const h = createDshHarness(t, {
    inspectImpl: async (threadId, count) => {
      if (mode === 'interrupted') {
        return { id: threadId, turns: [{ id: 'dsh-turn-1', status: 'interrupted', items: [] }] };
      }
      if (mode === 'throw') throw new Error('adapter inspect blip');
      return { id: threadId, turns: [{ id: threadId.replace('dsh-thread-', 'dsh-turn-'), status: 'inProgress', items: [] }] };
    },
  });
  let engine = await h.init();
  const t1 = engine.submit({ requestId: randomUUID(), title: 'DSH Interrupted Task', goal: 'Test interrupted stop' });
  await engine.runDue();
  await tick();

  engine = await h.restart();
  const r1 = await engine.reconcile(t1.id);
  assert.equal(r1.recoveryTerminal.reason, 'host-turn-interrupted');
  assert.equal(r1.recoveryTerminal.stopCertified, false);
  assert.equal(r1.recovery.exhausted, true);
  assert.equal(r1.recovery.nextAt, null);
  assert.equal(engine.status().exhaustedReconciliations, 1);
  assert.equal(engine.status().nextRecoveryAt, null);
  assert.equal(recoveryGuidance(r1).manualRelease.prerequisiteAction, 'abandon');

  const countBeforeIdle = h.inspectCalls.length;
  engine._recoverDue();
  await tick();
  assert.equal(h.inspectCalls.length, countBeforeIdle);

  // HTTP resolve-unresolved tests expectedAttemptId guard and overview projection
  const { server, token } = createStandaloneDshServer({ engine, contextStore: h.contextStore, adapter: h.adapter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const port = server.address().port;

  const post = (route, body) => new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'x-engine-token': token, 'Content-Type': 'application/json' } },
      res => {
        let txt = '';
        res.setEncoding('utf8');
        res.on('data', c => { txt += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(txt) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });

  const ab1 = engine.abandon(t1.id, { expectedRevision: engine.get(t1.id).revision, reason: 'Operator abandon', evidence: 'ev' });
  const wrongAtt = await post(`/api/tasks/${t1.id}/resolve-unresolved`, {
    expectedRevision: ab1.revision,
    expectedAttemptId: 'wrong-attempt',
    reason: 'Operator release',
    evidence: 'ev',
  });
  assert.equal(wrongAtt.status, 400);

  const rightAtt = await post(`/api/tasks/${t1.id}/resolve-unresolved`, {
    expectedRevision: ab1.revision,
    expectedAttemptId: ab1.attemptId,
    reason: 'Operator confirmed stopped',
    evidence: 'ev-clean-' + 'x'.repeat(600),
  });
  assert.equal(rightAtt.status, 200);
  assert.equal(rightAtt.body.executionUnresolved, false);
  assert.equal(rightAtt.body.unresolvedResolution.stopCertified, false);

  const inspFull = buildInspection(rightAtt.body, { budgetBytes: 8192 });
  assert.equal(inspFull.unresolvedResolution.reason, 'Operator confirmed stopped');
  const inspTight = buildInspection(rightAtt.body, { budgetBytes: 1024 });
  assert.equal(inspTight.unresolvedResolution, undefined);
  assert.ok(inspTight.omittedFields.includes('unresolvedResolution'));

  // 12-try cross-restart exhaustion
  mode = 'inProgress';
  const t2 = engine.submit({ requestId: randomUUID(), title: 'DSH 12-try Task', goal: 'Test 12 try cap' });
  await engine.runDue();
  await tick();
  engine = await h.restart();

  for (let i = 1; i <= 11; i++) {
    await engine.reconcile(t2.id);
    assert.equal(engine.get(t2.id).recovery.exhausted, false);
  }
  mode = 'throw';
  await assert.rejects(() => engine.reconcile(t2.id), /adapter inspect blip/);
  const at12 = engine.get(t2.id);
  assert.equal(at12.recovery.tries, 12);
  assert.equal(at12.recovery.exhausted, true);
  assert.equal(at12.recovery.nextAt, null);

  engine = await h.restart();
  const c2 = h.inspectCalls.length;
  engine._recoverDue();
  await tick();
  assert.equal(h.inspectCalls.length, c2);
  assert.equal(engine.status().exhaustedReconciliations, 1);
});
