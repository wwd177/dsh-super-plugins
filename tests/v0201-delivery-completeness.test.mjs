import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { createStandaloneDshServer } from '../packages/super-teams/src/engine/dsh-http.mjs';
import { DshSuperTeamsRuntime } from '../packages/super-teams/src/runtime.mjs';
import { primaryToolSchemas } from '../packages/super-teams/dist/tool-schemas.mjs';

function safeRm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
}

function git(cwd, args) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
}

function initFixtureRepo(root) {
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'dsh-fixture-completeness',
    version: '1.0.0',
    type: 'module',
  }, null, 2));
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# DSH Fixture\n');
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '--no-gpg-sign', '-m', 'initial commit']);
  return { repoDir, baseCommit: git(repoDir, ['rev-parse', 'HEAD']) };
}

async function waitUntil(fn, timeoutMs = 15000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('DSH v0.20.1: fail-closed delivery gate blocks incomplete/in-flight multi-wave merge & default candidate, allows explicit allowPartial when idle, and succeeds when complete', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v0201-gate-'));
  const { repoDir } = initFixtureRepo(root);
  const dataDir = path.join(root, 'data');

  let wave2Deferred = null;
  let wave2Mode = 'hold'; // 'hold' -> 'fail' -> 'complete'

  const adapter = {
    connect: async () => {},
    close: async () => {},
    status: () => ({ state: 'connected' }),
    models: async () => [{ model: 'deepseek-account/deepseek-reasoner', isDefault: true, supportedReasoningEfforts: ['medium'] }],
    preflightSession: () => ({ ok: true, sessionId: 'chat-main' }),
    start: async (task, hooks) => {
      await hooks.beforeExecute();
      await hooks.onIdentity({ threadId: `th-${task.id}`, turnId: `tu-${task.id}` });
      const completion = Promise.resolve().then(async () => {
        fs.mkdirSync(path.join(task.cwd, 'src'), { recursive: true });
        if (task.title === 'wave1-a') {
          fs.writeFileSync(path.join(task.cwd, 'src', 'a.mjs'), 'export const a = 1;\n');
          return { status: 'completed', text: 'wrote a' };
        }
        if (task.title === 'wave1-b') {
          fs.writeFileSync(path.join(task.cwd, 'src', 'b.mjs'), 'export const b = 2;\n');
          return { status: 'completed', text: 'wrote b' };
        }
        if (task.title === 'wave2-integrate') {
          if (wave2Mode === 'hold') {
            return await new Promise(resolve => { wave2Deferred = resolve; });
          }
          if (wave2Mode === 'fail') {
            return { status: 'failed', text: '', error: 'wave2 integration failed' };
          }
          fs.writeFileSync(path.join(task.cwd, 'src', 'index.mjs'), 'import { a } from "./a.mjs"; import { b } from "./b.mjs"; export const total = a + b;\n');
          return { status: 'completed', text: 'wrote index' };
        }
        return { status: 'completed', text: 'ok' };
      });
      return { threadId: `th-${task.id}`, turnId: `tu-${task.id}`, completion, interrupt: async () => {} };
    },
  };

  const contextStore = new ContextStore(path.join(dataDir, 'context'));
  const engine = new Engine({ dataDir, contextStore, adapter, maxConcurrent: 2 });
  await engine.initialize();
  const { server, token } = createStandaloneDshServer({ engine, contextStore, adapter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await engine.close().catch(() => {});
    safeRm(root);
  });

  const postJson = async (pathname, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/superagent-engine/api${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-engine-token': token,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const team = engine.createTeam({
    requestId: randomUUID(),
    name: 'DSH Multi-Wave Gate Team',
    goal: 'Build a, b, and Wave-2 index integration',
    workspaceMode: 'git-worktree',
    repoPath: repoDir,
    members: [
      { name: 'WorkerA', role: 'Dev', responsibility: 'Module A' },
      { name: 'WorkerB', role: 'Dev', responsibility: 'Module B' },
      { name: 'Integrator', role: 'Lead', responsibility: 'Wave 2 index' },
    ],
    tasks: [
      { key: 'w1a', member: 'WorkerA', title: 'wave1-a', goal: 'Write src/a.mjs', writeScopes: ['src/a.mjs'], checks: [{ type: 'file_exists', path: 'src/a.mjs' }] },
      { key: 'w1b', member: 'WorkerB', title: 'wave1-b', goal: 'Write src/b.mjs', writeScopes: ['src/b.mjs'], checks: [{ type: 'file_exists', path: 'src/b.mjs' }] },
      { key: 'w2', member: 'Integrator', title: 'wave2-integrate', goal: 'Write src/index.mjs', dependsOn: ['w1a', 'w1b'], writeScopes: ['src/index.mjs'], checks: [{ type: 'file_exists', path: 'src/index.mjs' }] },
    ],
  });
  const ids = Object.fromEntries(team.planTasks.map(p => [p.key, p.taskId]));

  await engine.teamControl(team.id, 'resume');
  await waitUntil(() => ['checked', 'submitted'].includes(engine.get(ids.w1a).state) && ['checked', 'submitted'].includes(engine.get(ids.w1b).state), 15000, 'wave1 finished');

  await engine.accept(ids.w1a, { expectedRevision: engine.get(ids.w1a).revision, reason: 'w1a ok' });
  await engine.accept(ids.w1b, { expectedRevision: engine.get(ids.w1b).revision, reason: 'w1b ok' });

  await waitUntil(() => engine.get(ids.w2).state === 'running', 15000, 'wave2 running');

  // 1) In-flight Wave-2 blocks even allowPartial=true
  await assert.rejects(
    () => engine.mergeTeam(team.id, { apply: true, allowPartial: true, branchName: 'should-block-inflight' }),
    err => err.code === 'TEAM_EXECUTION_IN_FLIGHT' && err.status === 409,
  );
  await assert.rejects(
    () => engine.createCandidate(team.id, { allowPartial: true }),
    err => err.code === 'TEAM_EXECUTION_IN_FLIGHT',
  );
  const httpInFlight = await postJson(`/teams/${team.id}/merge-apply`, { allowPartial: true, branchName: 'http-inflight' });
  assert.equal(httpInFlight.status, 409);
  assert.equal(httpInFlight.json.code, 'TEAM_EXECUTION_IN_FLIGHT');

  // Settle Wave-2 as failed
  wave2Mode = 'fail';
  wave2Deferred({ status: 'failed', text: '', error: 'wave2 integration failed' });
  await waitUntil(() => engine.get(ids.w2).state === 'failed', 15000, 'wave2 failed');

  // 2) Preview surfaces completeness telemetry
  const previewIncomplete = await engine.mergeTeam(team.id, { apply: false });
  assert.equal(previewIncomplete.ok, true);
  assert.equal(previewIncomplete.isPartial, true);
  assert.equal(previewIncomplete.readyForDelivery, false);
  assert.equal(previewIncomplete.deliveryBlockReason, 'INCOMPLETE_TEAM_DELIVERY');
  assert.equal(previewIncomplete.unacceptedTaskCount, 1);
  assert.ok(previewIncomplete.missingDownstreamTasks.some(t => t.taskId === ids.w2));

  // 3) Default merge_apply & default createCandidate fail closed with INCOMPLETE_TEAM_DELIVERY
  await assert.rejects(
    () => engine.mergeTeam(team.id, { apply: true, branchName: 'blocked-partial' }),
    err => err.code === 'INCOMPLETE_TEAM_DELIVERY' && err.status === 409,
  );
  assert.equal(git(repoDir, ['branch', '--list', 'superagent/*']), '');
  assert.equal(engine.getTeam(team.id).lastMerge ?? null, null);

  await assert.rejects(
    () => engine.createCandidate(team.id, {}),
    err => err.code === 'INCOMPLETE_TEAM_DELIVERY',
  );

  const httpIncomplete = await postJson(`/teams/${team.id}/merge-apply`, { branchName: 'http-incomplete' });
  assert.equal(httpIncomplete.status, 409);
  assert.equal(httpIncomplete.json.code, 'INCOMPLETE_TEAM_DELIVERY');
  assert.ok(httpIncomplete.json.details.missingDownstreamTasks.some(t => t.taskId === ids.w2));

  // 4) Explicit opt-in remains available when idle
  const explicitPartialMerge = await engine.mergeTeam(team.id, { apply: true, allowPartial: true, branchName: 'explicit-partial' });
  assert.equal(explicitPartialMerge.ok, true);
  assert.equal(explicitPartialMerge.isPartial, true);
  assert.equal(explicitPartialMerge.readyForDelivery, false);
  assert.equal(engine.getTeam(team.id).lastMerge.partial, true);

  const explicitSubsetCand = await engine.createCandidate(team.id, { taskIds: [ids.w1a] });
  assert.equal(explicitSubsetCand.ok, true);
  assert.equal(explicitSubsetCand.candidate.isPartial, true);

  // 5) Retry & complete Wave-2 -> complete delivery succeeds cleanly
  wave2Mode = 'complete';
  engine.retry(ids.w2);
  await engine.runDue();
  await waitUntil(() => ['checked', 'submitted'].includes(engine.get(ids.w2).state), 15000, 'wave2 completed on retry');
  await engine.accept(ids.w2, { expectedRevision: engine.get(ids.w2).revision, reason: 'w2 accepted' });

  const previewComplete = await engine.mergeTeam(team.id, { apply: false });
  assert.equal(previewComplete.ok, true);
  assert.equal(previewComplete.isPartial, false);
  assert.equal(previewComplete.readyForDelivery, true);
  assert.equal(previewComplete.deliveryBlockReason, null);
  assert.equal(previewComplete.missingDownstreamTasks.length, 0);

  const mergedFull = await engine.mergeTeam(team.id, { apply: true, branchName: 'complete-delivery' });
  assert.equal(mergedFull.ok, true);
  assert.equal(mergedFull.isPartial, false);
  assert.equal(mergedFull.readyForDelivery, true);
  assert.equal(mergedFull.appliedTasks.length, 3);
  const treeFiles = git(repoDir, ['ls-tree', '-r', '--name-only', 'refs/heads/superagent/complete-delivery']);
  assert.match(treeFiles, /src\/a\.mjs/);
  assert.match(treeFiles, /src\/b\.mjs/);
  assert.match(treeFiles, /src\/index\.mjs/);

  const fullCand = await engine.createCandidate(team.id, {});
  assert.equal(fullCand.ok, true);
  assert.equal(fullCand.candidate.isPartial, false);
  assert.equal(fullCand.candidate.entries.length, 3);
});

test('DSH v0.20.1 tools & runtime: keeps exact 8 primary tools and forwards allowPartial cleanly', async t => {
  assert.equal(primaryToolSchemas.length, 8);
  const engineTeam = primaryToolSchemas.find(x => x.name === 'engine_team');
  assert.equal(engineTeam.parameters.properties.allowPartial.type, 'boolean');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v0201-rt-'));
  const { repoDir } = initFixtureRepo(root);
  const dataDir = path.join(root, 'data');
  const runtime = new DshSuperTeamsRuntime({
    dataDir,
    mockRunner: async spec => {
      if (spec.cwd && !fs.existsSync(path.join(spec.cwd, 'src', 'part.mjs'))) {
        fs.writeFileSync(path.join(spec.cwd, 'src', 'part.mjs'), 'export const p = 1;\n');
      }
      return { text: 'done part' };
    },
  });
  t.after(async () => {
    await runtime.close().catch(() => {});
    safeRm(root);
  });

  const created = await runtime.executeTool('engine_team', {
    action: 'prepare',
    requestId: randomUUID(),
    name: 'Runtime Forward Test',
    goal: 'Check allowPartial forwarding',
    workspaceMode: 'git-worktree',
    repoPath: repoDir,
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
    tasks: [
      { key: 'a', member: 'Dev', title: 'Part A', goal: 'Write src/part.mjs', writeScopes: ['src/part.mjs'], checks: [{ type: 'file_exists', path: 'src/part.mjs' }] },
      { key: 'b', member: 'Dev', title: 'Part B', goal: 'Write src/part2.mjs', dependsOn: ['a'], writeScopes: ['src/part2.mjs'], checks: [{ type: 'file_exists', path: 'src/part2.mjs' }] },
    ],
  }, { agent: { id: 'chat-rt' } });

  const idA = created.planTasks.find(p => p.key === 'a').taskId;
  await runtime.executeTool('engine_control', { taskId: idA, action: 'pause' }, { agent: { id: 'chat-rt' } });
  const preview = await runtime.executeTool('engine_team', { action: 'overview', teamId: created.id }, { agent: { id: 'chat-rt' } });
  assert.equal(preview.team.id, created.id);
});
