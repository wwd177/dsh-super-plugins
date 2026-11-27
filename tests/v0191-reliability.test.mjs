import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveDshCli } from '../scripts/install.mjs';
import { analyzeTaskGraph, rankReadyCandidates } from '../packages/super-teams/src/engine/scheduler.mjs';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { DshAdapter } from '../packages/super-teams/src/engine/dsh-adapter.mjs';
import { DshSuperTeamsRuntime } from '../packages/super-teams/src/runtime.mjs';
import { buildIsolatedTestEnv } from '../packages/super-teams/src/engine/core/src/process-isolation.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runNodeScript(scriptPath, args = [], extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function runDshCliCommand(dshCli, args, dshHome) {
  const cleanEnv = { ...process.env, DSH_HOME: dshHome };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshCli)) {
    cleanEnv.DSH_CLI_BIN = dshCli;
    const argRefs = args.map((v, i) => {
      const k = `DSH_T_ARG_${i}`;
      cleanEnv[k] = String(v);
      return `"%${k}%"`;
    });
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"\"%DSH_CLI_BIN%\" ${argRefs.join(' ')}"`], {
      env: cleanEnv,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: 'pipe',
    });
  }
  return execFileSync(dshCli, args, { env: cleanEnv, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
}

async function waitUntil(fn, timeoutMs = 15000, label = 'condition', diagFn = null) {
  const start = Date.now();
  const dl = start + timeoutMs;
  let polls = 0;
  while (Date.now() < dl) {
    polls++;
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 30));
  }
  const diag = typeof diagFn === 'function' ? diagFn() : '';
  throw new Error(`Timeout waiting for ${label} after ${Date.now() - start}ms (${polls} polls)${diag ? `: ${typeof diag === 'string' ? diag : JSON.stringify(diag)}` : ''}`);
}

test('DSH v0.19.1 P0: multi-profile uninstall preserves sibling refs, handles corrupt profiles fail-closed, and coordinates concurrent installs', async t => {
  const root = makeTempDir('dsh-multiprofile-');
  const dshHome = path.join(root, 'dsh-home');
  const installScript = path.resolve(import.meta.dirname, '../scripts/install.mjs');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let dshCli;
  let usingMockCli = false;
  try {
    dshCli = resolveDshCli({});
  } catch {
    // Fallback cross-platform shim when running CI in environments without DeepSeek Harness desktop installed
    usingMockCli = true;
    const mockCli = path.join(root, process.platform === 'win32' ? 'dsh-mock.cmd' : 'dsh-mock.sh');
    const handlerJs = path.join(root, 'dsh-mock.mjs');
    fs.writeFileSync(handlerJs, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const dshHome = process.env.DSH_HOME;
const pIdx = args.indexOf('--profile');
const profile = pIdx >= 0 ? args[pIdx + 1] : 'desktop';
const profDir = path.join(dshHome, 'profiles', profile);
const pkgPath = path.join(profDir, 'package.json');
fs.mkdirSync(profDir, { recursive: true });
let pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : { name: profile, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
pkg.dependencies ||= {};
pkg.dsh ||= { profile: { bundles: [] } };
pkg.dsh.profile ||= { bundles: [] };
if (args.includes('add')) {
  for (const spec of args.slice(args.indexOf('add') + 1)) {
    const subPkg = JSON.parse(fs.readFileSync(path.join(spec.replace(/^link:/, ''), 'package.json'), 'utf8'));
    pkg.dependencies[subPkg.name] = spec;
    if (!pkg.dsh.profile.bundles.includes(subPkg.name)) pkg.dsh.profile.bundles.push(subPkg.name);
  }
} else if (args.includes('remove')) {
  for (const name of args.slice(args.indexOf('remove') + 1)) {
    delete pkg.dependencies[name];
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== name);
  }
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n', 'utf8');
console.log('ok');
`, 'utf8');
    if (process.platform === 'win32') {
      fs.writeFileSync(mockCli, `@echo off\r\n"${process.execPath}" "${handlerJs}" %*\r\n`, 'utf8');
    } else {
      fs.writeFileSync(mockCli, `#!/bin/sh\nexec "${process.execPath}" "${handlerJs}" "$@"\n`, { mode: 0o755 });
    }
    dshCli = mockCli;
  }

  for (const prof of ['audita', 'auditb', 'auditd']) {
    runDshCliCommand(dshCli, ['plugin', '--profile', prof, 'list'], dshHome);
  }

  // Install audita & auditb
  const instA = await runNodeScript(installScript, ['--profile', 'audita', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']);
  assert.equal(instA.code, 0, instA.stderr);
  assert.equal(JSON.parse(instA.stdout).ok, true);

  const instB = await runNodeScript(installScript, ['--profile', 'auditb', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']);
  assert.equal(instB.code, 0, instB.stderr);
  assert.equal(JSON.parse(instB.stdout).ok, true);

  const verA = await runNodeScript(installScript, ['--profile', 'audita', '--verify', '--dsh-home', dshHome, '--json']);
  const verB = await runNodeScript(installScript, ['--profile', 'auditb', '--verify', '--dsh-home', dshHome, '--json']);
  assert.equal(verA.code, 0, verA.stderr);
  assert.equal(verB.code, 0, verB.stderr);

  // Leave historical plugin-data marker in audita
  const markerFile = path.join(dshHome, 'profiles', 'audita', 'plugin-data', 'dsh-super-teams', 'history.txt');
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, 'preserve-me\n', 'utf8');

  // Uninstall audita: auditb MUST stay healthy and shared assets preserved!
  const unA = await runNodeScript(installScript, ['--profile', 'audita', '--uninstall', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']);
  assert.equal(unA.code, 0, unA.stderr);
  const unARes = JSON.parse(unA.stdout);
  assert.equal(unARes.ok, true);
  assert.equal(unARes.purgedData, false);
  assert.equal(unARes.sharedAssetsPreserved, true);
  assert.ok(unARes.remainingProfiles.includes('auditb'), JSON.stringify(unARes));
  assert.equal(fs.readFileSync(markerFile, 'utf8').trim(), 'preserve-me');

  const verBAfterA = await runNodeScript(installScript, ['--profile', 'auditb', '--verify', '--dsh-home', dshHome, '--json']);
  assert.equal(verBAfterA.code, 0, `auditb verify MUST pass after audita uninstall: ${verBAfterA.stdout} ${verBAfterA.stderr}`);
  assert.equal(JSON.parse(verBAfterA.stdout).ok, true);

  // Fail-closed test: corrupt sibling profile auditc prevents shared deletion even when uninstalling auditb
  const auditcDir = path.join(dshHome, 'profiles', 'auditc');
  fs.mkdirSync(auditcDir, { recursive: true });
  fs.writeFileSync(path.join(auditcDir, 'package.json'), '{not-valid-json', 'utf8');

  const unBWithCorrupt = await runNodeScript(installScript, ['--profile', 'auditb', '--uninstall', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']);
  assert.equal(unBWithCorrupt.code, 0, unBWithCorrupt.stderr);
  const unBCorruptRes = JSON.parse(unBWithCorrupt.stdout);
  assert.equal(unBCorruptRes.sharedAssetsPreserved, true);
  assert.ok(unBCorruptRes.unknownProfiles.includes('auditc'), JSON.stringify(unBCorruptRes));
  assert.ok(fs.existsSync(path.join(dshHome, 'local-packages', 'dsh-super-plugins')));

  // Remove corrupt profile, reinstall auditb, then run concurrent install(auditd) + uninstall(auditb) against shared lock
  fs.rmSync(auditcDir, { recursive: true, force: true });
  const reinstB = await runNodeScript(installScript, ['--profile', 'auditb', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']);
  assert.equal(reinstB.code, 0, reinstB.stderr);

  const [concInstD, concUnB] = await Promise.all([
    runNodeScript(installScript, ['--profile', 'auditd', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']),
    runNodeScript(installScript, ['--profile', 'auditb', '--uninstall', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']),
  ]);
  assert.equal(concInstD.code, 0, `Concurrent install(auditd) failed: ${concInstD.stdout} ${concInstD.stderr}`);
  assert.equal(concUnB.code, 0, `Concurrent uninstall(auditb) failed: ${concUnB.stdout} ${concUnB.stderr}`);

  const verD = await runNodeScript(installScript, ['--profile', 'auditd', '--verify', '--dsh-home', dshHome, '--json']);
  assert.equal(verD.code, 0, `auditd must verify cleanly after concurrent lock test: ${verD.stderr}`);

  // Last referencing profile auditd uninstalls -> shared assets MUST be cleaned up while audita data marker persists
  const unDLast = await runNodeScript(installScript, ['--profile', 'auditd', '--uninstall', '--dsh-home', dshHome, '--dsh-cli', dshCli, '--json']);
  assert.equal(unDLast.code, 0, unDLast.stderr);
  const unDRes = JSON.parse(unDLast.stdout);
  assert.equal(unDRes.sharedAssetsPreserved, false);
  assert.equal(fs.existsSync(path.join(dshHome, 'local-packages', 'dsh-super-plugins')), false);
  for (const sName of ['superagent-workflow', 'workflow-quality', 'development-handoff', 'super-teams']) {
    assert.equal(fs.existsSync(path.join(dshHome, 'skills', sName)), false, `Expected ${sName} cleaned up`);
  }
  assert.equal(fs.existsSync(markerFile), true, 'audita data directory must remain untouched unless --purge-data');
  if (process.env.DSH_REQUIRE_REAL_CLI === '1') {
    assert.equal(usingMockCli, false, 'Expected real Windows DSH CLI on this host');
  }
});

test('DSH v0.19.1 P0: strict multi-chat dispatch blocks when bound chat closes (zero drift to live chat B) & rebind_session wakes cleanly', async t => {
  const root = makeTempDir('dsh-chat-isolation-');
  const dataDir = path.join(root, 'engine-data');
  let rt = null;
  t.after(async () => {
    try { await rt?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  const makeRootAgent = (id, modelName) => ({
    id,
    options: { provider: 'deepseek-account', model: modelName, reasoningEffort: 'medium' },
    session: {
      header: { cwd: root, origin: 'user' },
      snapshotEvents: () => [
        { type: 'model-selection/change', data: { provider: 'deepseek-account', model: modelName, reasoningEffort: 'medium' } },
        {
          type: 'subagent/model-selection-policy',
          data: { allowedModels: [{ provider: 'deepseek-account', model: modelName }] },
        },
      ],
    },
  });

  const chatA = makeRootAgent('chat-A', 'model-A-exclusive');
  const chatB = makeRootAgent('chat-B', 'model-B-exclusive');
  const agentsMap = new Map([[chatA.id, chatA], [chatB.id, chatB]]);
  const activations = [];
  let dropChatAOnCallConfig = false;

  const services = {
    agents: { get: id => agentsMap.get(id), list: () => [...agentsMap.values()] },
    workingDirectory: { get: s => s?.header?.cwd ?? root },
    llm: {
      resolveModelInfo: async () => ({ reasoningEfforts: ['medium'], supportsReasoningEffort: true }),
      resolveCallConfig: async cfg => {
        if (dropChatAOnCallConfig && agentsMap.has('chat-A')) {
          agentsMap.delete('chat-A');
        }
        return cfg;
      },
    },
    subagents: {
      getProvider: n => (n === 'spawn' ? { name: 'spawn' } : undefined),
      rootOf: a => (a?.root ? a.root : a),
      resolveMaxDepth: () => 2,
      startActivation: async spec => {
        activations.push({ parentId: spec.parent.id, label: spec.label, cwd: spec.cwd });
        fs.writeFileSync(path.join(spec.cwd, 'deliverable.txt'), `executed-in-${spec.parent.id}\n`, 'utf8');
        return {
          childId: `child-${randomUUID()}`,
          messageId: `msg-${randomUUID()}`,
          name: spec.label,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }),
          async dispose() {},
        };
      },
    },
  };
  const ctx = {
    get: name => services[name],
    connection: null,
    webServer: null,
    logger: { warn() {}, error() {}, info() {} },
  };

  rt = new DshSuperTeamsRuntime({ ctx, dataDir });
  await rt.ensureStarted();

  const prepared = await rt.executeTool('engine_team', {
    action: 'prepare',
    requestId: 'prep-strict-1',
    name: 'Chat A Team',
    goal: 'Do not drift to chat B',
    members: [{ name: 'Dev', role: 'Engineer', responsibility: 'Write deliverable.txt' }],
    tasks: [{ key: 't1', member: 'Dev', title: 'Task 1', goal: 'Write deliverable.txt', writeScopes: ['deliverable.txt'] }],
  }, { agent: chatA });

  // Also add an explicit chat-C task and verify a dirty whitespace task.sessionId = '   ' never bypasses team.sessionId!
  const explicitTask = await rt.executeTool('engine_submit', {
    requestId: 'sub-explicit-c',
    teamId: prepared.id,
    memberId: prepared.members[0].id,
    title: 'Explicit C task',
    goal: 'Pinned to C',
  }, { agent: chatA });
  const explicitTaskId = explicitTask.taskId;
  const rawExplicit = rt.engine.store.get(explicitTaskId);
  rawExplicit.sessionId = 'chat-C';
  rawExplicit.sessionBinding = 'explicit';
  rt.engine.store.save(rawExplicit);

  const dirtyWsTask = rt.engine.store.get(prepared.planTasks[0].taskId);
  dirtyWsTask.sessionId = '   '; // Dirty whitespace must NOT shadow team.sessionId = 'chat-A'
  rt.engine.store.save(dirtyWsTask);

  // Close chat A while chat B stays open and active!
  agentsMap.delete('chat-A');
  rt.adapter.rememberSession('chat-B');

  // Calling pause/workspace from chat B MUST NOT hijack chat A's team binding
  await rt.executeTool('engine_workspace', { teamId: prepared.id }, { agent: chatB });
  assert.equal(rt.engine.getTeam(prepared.id).sessionId, 'chat-A');

  const snapA = rt.adapter.sessionSnapshot('chat-A');
  assert.equal(snapA.available, false);
  assert.equal(snapA.requestedSessionOnline, false);
  const modelsA = await rt.adapter.models({ sessionId: 'chat-A' });
  assert.equal(modelsA.some(m => m.model.includes('model-B-exclusive')), false, 'Offline chat A model query must not leak chat B routes');

  await rt.executeTool('engine_team', { action: 'resume', teamId: prepared.id }, { agent: chatB });
  await waitUntil(() => rt.engine.get(dirtyWsTask.id).state === 'blocked', 8000, 'task blocked on offline chat-A');
  const blockedT1 = rt.engine.get(dirtyWsTask.id);
  assert.equal(blockedT1.blockReason, 'session-unavailable');
  assert.equal(blockedT1.executionUnresolved, false);
  assert.equal(activations.length, 0, 'chat-B must NEVER receive chat-A dispatches');
  assert.equal(rt.engine.getTeam(prepared.id).sessionId, 'chat-A');
  const wsEntries = fs.existsSync(path.join(dataDir, 'workspaces')) ? fs.readdirSync(path.join(dataDir, 'workspaces')) : [];
  assert.equal(wsEntries.length, 0, 'Session preflight block must leave zero orphan workspaces');
  const budgetAfterBlock = rt.engine.getTeamBudget(prepared.id);
  assert.equal(budgetAfterBlock.attemptsReserved, 0);

  // Race test: bring chat-A back, then drop chat-A mid-start before startActivation!
  agentsMap.set('chat-A', chatA);
  const tRace = await rt.executeTool('engine_submit', {
    requestId: 'sub-race-a',
    teamId: prepared.id,
    memberId: prepared.members[0].id,
    title: 'Race close task',
    goal: 'Produce race.txt',
  }, { agent: chatA });
  const tRaceId = tRace.taskId;
  dropChatAOnCallConfig = true;
  await rt.engine.runDue();
  await waitUntil(() => rt.engine.get(tRaceId).state === 'blocked' && rt.engine.get(tRaceId).blockReason === 'session-unavailable', 8000, 'race task blocked instead of failed');
  dropChatAOnCallConfig = false;
  assert.equal(activations.length, 0);
  assert.equal(rt.engine.getTeamBudget(prepared.id).attemptsReserved, 0);

  // REBIND_CONFLICT when an unresolved/running task exists
  const synthUnresolved = rt.engine.store.get(tRaceId);
  synthUnresolved.executionUnresolved = true;
  synthUnresolved.state = 'unknown';
  rt.engine.store.save(synthUnresolved);
  await assert.rejects(
    () => rt.executeTool('engine_team', { action: 'rebind_session', teamId: prepared.id }, { agent: chatB }),
    err => err.code === 'REBIND_CONFLICT'
  );
  // Restore blocked state for clean rebind
  synthUnresolved.executionUnresolved = false;
  synthUnresolved.state = 'blocked';
  synthUnresolved.blockReason = 'session-unavailable';
  synthUnresolved.blockCode = 'SESSION_UNAVAILABLE';
  rt.engine.store.save(synthUnresolved);

  // Refuse spoofed cross-chat rebind when callerSid !== requested sessionId
  await assert.rejects(
    () => rt.executeTool('engine_team', { action: 'rebind_session', teamId: prepared.id, sessionId: 'chat-B' }, { agent: { id: 'chat-Z', session: { header: { cwd: root } } } }),
    /Refusing cross-chat session rebind/
  );

  // Run inherited tasks in chat-B while verifying explicit chat-C binding stays untouched
  const rebindRes = await rt.executeTool('engine_team', { action: 'rebind_session', teamId: prepared.id }, { agent: chatB });
  assert.equal(rebindRes.rebound, true);
  assert.equal(rebindRes.previousSessionId, 'chat-A');
  assert.equal(rebindRes.sessionId, 'chat-B');
  assert.ok(rebindRes.wokenTaskIds.includes(dirtyWsTask.id));
  assert.ok(rebindRes.preservedExplicitTaskIds.includes(explicitTaskId));
  assert.equal(rt.engine.get(explicitTaskId).sessionId, 'chat-C');

  await waitUntil(() => rt.engine.get(dirtyWsTask.id).state === 'submitted' && rt.engine.get(tRaceId).state === 'submitted', 10000, 'rebound tasks executed in chat-B');
  assert.ok(activations.length >= 2);
  assert.ok(activations.every(a => a.parentId === 'chat-B'), JSON.stringify(activations));

  // Idempotent second rebind_session must NOT dispatch duplicates
  const beforeCount = activations.length;
  const secondRebind = await rt.executeTool('engine_team', { action: 'rebind_session', teamId: prepared.id }, { agent: chatB });
  assert.equal(secondRebind.rebound, false);
  assert.equal(secondRebind.wokenTaskIds.length, 0);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(activations.length, beforeCount);
});

test('DSH v0.19.1 P1: CPM scheduler excludes cancelled/abandoned, blocked downstream diamond, and accepted middle bridges', () => {
  // 1. Audit reproduction: cancelled(high) + queued(low)
  const g1 = analyzeTaskGraph([
    { id: 'cancelled', title: 'C', state: 'cancelled', difficulty: 'high', dependsOn: [] },
    { id: 'queued', title: 'Q', state: 'queued', difficulty: 'low', dependsOn: [] },
  ]);
  assert.deepEqual(g1.criticalPathIds, ['queued']);
  assert.equal(g1.criticalPathWeight, 1);
  assert.equal(g1.remainingTasks, 1);

  const g2 = analyzeTaskGraph([
    { id: 'cancelled', title: 'C', state: 'cancelled', difficulty: 'high', dependsOn: [] },
  ]);
  assert.deepEqual(g2.criticalPathIds, []);
  assert.equal(g2.criticalPathWeight, 0);
  assert.equal(g2.remainingTasks, 0);

  // 2. Astra Diamond Counterexample: X(2) -> C(cancelled) -> Y(high), X -> D(3) -> Y, plus R1(3)->R2(3)
  const diamond = [
    { id: 'X', title: 'X', state: 'queued', difficulty: 'medium', dependsOn: [], createdAt: '2026-01-01T00:00:01Z' },
    { id: 'C', title: 'C', state: 'cancelled', difficulty: 'high', dependsOn: ['X'] },
    { id: 'D', title: 'D', state: 'queued', difficulty: 'high', dependsOn: ['X'] },
    { id: 'Y', title: 'Y', state: 'queued', difficulty: 'high', dependsOn: ['C', 'D'] },
    { id: 'R1', title: 'R1', state: 'queued', difficulty: 'high', dependsOn: [], createdAt: '2026-01-01T00:00:02Z' },
    { id: 'R2', title: 'R2', state: 'queued', difficulty: 'high', dependsOn: ['R1'] },
  ];
  const g3 = analyzeTaskGraph(diamond);
  assert.deepEqual(g3.criticalPathIds, ['R1', 'R2']);
  assert.equal(g3.criticalPathWeight, 6);
  assert.equal(g3.nodes.get('X').criticalWeight, 5);
  assert.equal(g3.nodes.get('X').downstreamCount, 1);
  assert.equal(g3.nodes.get('Y').criticalWeight, 0);

  // 3. Astra Middle Accepted Counterexample: X(2, queued) -> A(accepted) -> Y(3, queued)
  const middleAccepted = [
    { id: 'X', title: 'X', state: 'queued', difficulty: 'medium', dependsOn: [], createdAt: '2026-01-01T00:00:01Z' },
    { id: 'A', title: 'A', state: 'accepted', difficulty: 'high', dependsOn: ['X'] },
    { id: 'Y', title: 'Y', state: 'queued', difficulty: 'high', dependsOn: ['A'], createdAt: '2026-01-01T00:00:02Z' },
  ];
  const g4 = analyzeTaskGraph(middleAccepted);
  assert.deepEqual(g4.criticalPathIds, ['Y']);
  assert.equal(g4.criticalPathWeight, 3);
  const rankedReady = rankReadyCandidates([middleAccepted[0], middleAccepted[2]], middleAccepted);
  assert.deepEqual(rankedReady.map(t => t.id), ['Y', 'X']);

  // 4. All active tasks deadlocked behind cancelled/abandoned or missing deps
  const allBlocked = analyzeTaskGraph([
    { id: 'C', title: 'C', state: 'abandoned', difficulty: 'high', dependsOn: [] },
    { id: 'Y', title: 'Y', state: 'queued', difficulty: 'high', dependsOn: ['C'] },
    { id: 'Z', title: 'Z', state: 'queued', difficulty: 'high', dependsOn: ['missing-id'] },
  ]);
  assert.deepEqual(allBlocked.criticalPathIds, []);
  assert.equal(allBlocked.criticalPathWeight, 0);
  assert.equal(allBlocked.remainingTasks, 2);
});

test('DSH v0.19.1 P1: deep Windows dataDir (>275 char isolated-home/.gitconfig) runs git config --list cleanly without leaking host gitconfig', async t => {
  const deepBase = makeTempDir('dsh-deep-');
  const padLen = Math.max(16, 118 - deepBase.length - 6);
  const nestedDataDir = path.join(deepBase, 'p'.repeat(padLen), 'data');
  const predictedLegacyGitCfg = path.join(
    nestedDataDir,
    'attempts',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    'node-test-00000000-0000-0000-0000-000000000003-tmp',
    'isolated-home',
    '.gitconfig'
  );
  assert.ok(predictedLegacyGitCfg.length > 275, `Expected legacy path >275 chars, got ${predictedLegacyGitCfg.length}`);

  const hostGitCfg = path.join(deepBase, 'canary.gitconfig');
  fs.writeFileSync(hostGitCfg, '[canary]\n\tsecret = DEEP_PATH_CANARY\n', 'utf8');
  const prevGitCfg = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = hostGitCfg;

  const engine = new Engine({
    dataDir: nestedDataDir,
    contextStore: new ContextStore(path.join(nestedDataDir, 'ctx')),
    adapter: {
      async connect() {},
      async close() {},
      status() { return { state: 'connected' }; },
      async models() { return [{ model: 'dsh-test', isDefault: true, supportedReasoningEfforts: ['medium'] }]; },
      authorizeThread() {},
      async start(task, hooks) {
        await hooks.beforeExecute();
        await hooks.onIdentity({ threadId: 't-deep', turnId: 'turn-deep' });
        fs.writeFileSync(path.join(task.cwd, 'ok.txt'), 'ok\n', 'utf8');
        return {
          threadId: 't-deep',
          turnId: 'turn-deep',
          completion: Promise.resolve({ status: 'completed', text: 'ok' }),
          interrupt: async () => {},
        };
      },
    },
  });
  await engine.initialize();
  t.after(async () => {
    if (prevGitCfg === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGitCfg;
    await engine.close();
    fs.rmSync(deepBase, { recursive: true, force: true });
  });

  // Also test concurrent buildIsolatedTestEnv + cleanup isolation when direct deep path (>220 chars) is passed
  const veryDeepDir = path.join(nestedDataDir, 'extra-long-dir-segment-for-fallback-check-01234567890123456789');
  const isoA = buildIsolatedTestEnv(path.join(veryDeepDir, 'iso-a'));
  const isoB = buildIsolatedTestEnv(path.join(veryDeepDir, 'iso-b'));
  assert.ok(isoA.emptyGitConfig.length < 220, `Shortened gitconfig exceeded 220: ${isoA.emptyGitConfig}`);
  assert.ok(fs.existsSync(isoA.isolatedRoot) && fs.existsSync(isoB.isolatedRoot));
  isoA.cleanup();
  assert.equal(fs.existsSync(isoA.isolatedRoot), false);
  assert.equal(fs.existsSync(isoB.isolatedRoot), true, 'Cleaning isoA must not affect concurrent isoB');
  isoB.cleanup();

  const submitted = engine.submit({
    requestId: 'deep-git-check-1',
    title: 'Deep Git Config Check',
    goal: 'Run git config --list under isolated HOME without hitting MAX_PATH',
    writeScopes: ['ok.txt'],
    checks: [{
      type: 'node_test',
      path: 'ok.txt',
      testScript: [
        'const { execFileSync } = require("node:child_process");',
        'const out = execFileSync("git", ["config", "--list"], { encoding: "utf8" });',
        'if (out.includes("DEEP_PATH_CANARY")) throw new Error("Leaked host gitconfig");',
        'if ((process.env.GIT_CONFIG_GLOBAL || "").length >= 248) throw new Error("GIT_CONFIG_GLOBAL too long");',
      ].join('\n'),
    }],
  });

  await waitUntil(() => ['checked', 'failed'].includes(engine.get(submitted.id).state), 10000, 'deep path git verification', () => engine.get(submitted.id));
  const done = engine.get(submitted.id);
  assert.equal(done.state, 'checked', JSON.stringify(done.verification));
  assert.equal(done.verification.passed, true);
});
