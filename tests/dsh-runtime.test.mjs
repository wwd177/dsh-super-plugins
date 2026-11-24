import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DshAdapter } from '../packages/super-teams/src/engine/dsh-adapter.mjs';
import { DshSuperTeamsRuntime } from '../packages/super-teams/src/runtime.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeDshHost({ allowFlash = true, rejectEffort = false, noSessions = false, runner = null } = {}) {
  const childSessions = new Map();
  const rootSession = {
    header: { cwd: os.tmpdir(), origin: 'user' },
    snapshotEvents: () => [
      { type: 'model-selection/change', data: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'medium' } },
      ...(allowFlash
        ? [{
            type: 'subagent/model-selection-policy',
            data: {
              allowedModels: [
                { provider: 'deepseek-account', model: 'deepseek-reasoner' },
                { provider: 'deepseek-account', model: 'deepseek-flash' },
              ],
            },
          }]
        : []),
    ],
  };
  const rootAgent = {
    id: 'session-root-1',
    options: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'medium' },
    session: rootSession,
  };

  const agentsMap = new Map();
  if (!noSessions) agentsMap.set(rootAgent.id, rootAgent);

  const startedSpecs = [];
  const interruptedIds = [];

  const services = {
    agents: {
      get: id => agentsMap.get(id),
      list: () => [...agentsMap.values()],
    },
    workingDirectory: {
      get: session => session?.header?.cwd ?? os.tmpdir(),
    },
    llm: {
      resolveModelInfo: async (_provider, model) => ({
        reasoningEfforts: model.includes('flash') ? [] : ['low', 'medium', 'high'],
        supportsReasoningEffort: !model.includes('flash') && !rejectEffort,
      }),
      resolveCallConfig: async cfg => {
        if ((rejectEffort || cfg.model.includes('flash')) && cfg.reasoningEffort !== undefined) {
          throw new Error(`Model ${cfg.model} does not accept reasoningEffort`);
        }
        return cfg;
      },
      listProviders: () => [
        { id: 'deepseek-account', models: ['deepseek-reasoner', 'deepseek-flash'] },
      ],
    },
    subagents: {
      getProvider: name => (name === 'spawn' ? { name: 'spawn' } : undefined),
      rootOf: agent => (agent === rootAgent || agent?.root === rootAgent ? rootAgent : agent),
      resolveMaxDepth: () => 2,
      interrupt: id => { interruptedIds.push(id); },
      startActivation: async spec => {
        startedSpecs.push(spec);
        const childId = `child-${randomUUID()}`;
        const childEvents = [
          { type: 'tool/start', data: { name: 'str_replace_editor' } },
        ];
        const childAgent = {
          id: childId,
          root: rootAgent,
          session: {
            header: { cwd: spec.cwd, origin: 'subagent' },
            snapshotEvents: () => childEvents,
          },
        };
        agentsMap.set(childId, childAgent);
        const resultPromise = (async () => {
          const custom = runner ? await runner(spec, { childId, childEvents }) : null;
          childEvents.push({
            type: 'message/assistant',
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: custom?.text ?? 'Completed task cleanly.' }],
              },
              usage: custom?.usage ?? { inputTokens: 120, outputTokens: 45, cachedInputTokens: 20 },
            },
          });
          childSessions.set(childId, [...childEvents, { type: 'turn/end', data: { reason: { kind: custom?.stopReason === 'error' ? 'error' : 'completed' } } }]);
          return {
            stopReason: custom?.stopReason ?? 'completed',
            output: [{ type: 'text', text: custom?.text ?? 'Completed task cleanly.' }],
            ...(custom?.diagnostic ? { diagnostic: custom.diagnostic } : {}),
          };
        })();
        return {
          childId,
          messageId: `msg-${randomUUID()}`,
          name: `subagent-${startedSpecs.length}`,
          result: resultPromise,
          dispose: async () => { agentsMap.delete(childId); },
        };
      },
    },
    sessionQuery: {
      observeSession: async id => ({
        events: childSessions.get(id) ?? [],
        async [Symbol.asyncDispose]() {},
      }),
    },
  };

  return {
    ctx: { get: name => services[name], ...services },
    rootAgent,
    startedSpecs,
    interruptedIds,
    childSessions,
  };
}

test('DshAdapter honors allowlist, preflights reasoningEffort fallback, and blocks cleanly when no session is open', async () => {
  const emptyHost = createFakeDshHost({ noSessions: true });
  const emptyAdapter = new DshAdapter({ ctx: emptyHost.ctx });
  await assert.rejects(
    () => emptyAdapter.start({ id: 't0', title: 'Test', cwd: os.tmpdir(), prompt: 'hi' }),
    err => err.executionNotStarted === true && err.blockReason === 'preflight' && /主聊天会话/.test(err.message)
  );
  await emptyAdapter.close();

  const host = createFakeDshHost({ allowFlash: true, rejectEffort: true });
  const adapter = new DshAdapter({ ctx: host.ctx });
  const models = await adapter.models();
  assert.equal(models.length, 2);
  assert.equal(models[0].model, 'deepseek-account/deepseek-reasoner');
  assert.equal(models[1].model, 'deepseek-account/deepseek-flash');

  const events = [];
  const handle = await adapter.start(
    { id: 't1', title: 'Low difficulty task', cwd: os.tmpdir(), model: 'deepseek-account/deepseek-flash', effort: 'low', prompt: 'produce output' },
    { onEvent: ev => events.push(ev) }
  );
  const res = await handle.completion;
  assert.equal(res.status, 'completed');
  assert.equal(res.text, 'Completed task cleanly.');
  assert.equal(res.usage?.totalTokens, 165);
  assert.equal(host.startedSpecs.length, 1);
  assert.deepEqual(host.startedSpecs[0].agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash' });
  await adapter.close();
});

test('Unified persistent SQLite WAL engine survives full restart and exposes consistent teams_engine views + hardlink defense', async () => {
  const dataDir = makeTempDir('dsh-rt-persist-');
  const host = createFakeDshHost({
    runner: async spec => {
      const prompt = spec.prompt[0].text;
      if (prompt.includes('Design API schema')) {
        fs.writeFileSync(path.join(spec.cwd, 'schema.json'), JSON.stringify({ version: 2, endpoints: ['/health'] }));
        return { text: 'Schema v2 generated.' };
      }
      if (prompt.includes('Implement endpoint')) {
        assert.match(prompt, /Use snake_case keys/, 'Ruling source must be auto-attached');
        const hasFeedback = prompt.includes('REWORK FEEDBACK FROM REVIEWER');
        fs.writeFileSync(
          path.join(spec.cwd, 'impl.cjs'),
          hasFeedback
            ? 'module.exports = { get_health: () => ({ status_ok: true, revised: true }) };\n'
            : 'module.exports = { get_health: () => ({ status_ok: true, revised: false }) };\n'
        );
        return { text: hasFeedback ? 'Endpoint revised.' : 'Initial endpoint implemented.' };
      }
      return { text: 'Done.' };
    },
  });

  let teamId;
  let designTaskId;
  let implTaskId;
  let designSnapshotId;
  let rulingSourceId;

  const runtime1 = new DshSuperTeamsRuntime({ ctx: host.ctx, dataDir });
  try {
    const execCtx = { agent: host.rootAgent };
    const prepared = await runtime1.executeTool('engine_team', {
      action: 'prepare',
      requestId: 'prep-persist-1',
      name: 'DSH Persistent Wave Team',
      goal: 'Ship schema and endpoint across restart',
      members: [
        { name: 'Architect', role: 'Architect', responsibility: 'Design schema' },
        { name: 'Coder', role: 'Engineer', responsibility: 'Implement endpoint' },
      ],
      tasks: [
        {
          key: 'design',
          member: 'Architect',
          title: 'Design schema',
          goal: 'Design API schema',
          difficulty: 'low',
          priority: 'critical',
          writeScopes: ['schema.json'],
          autoAccept: true,
          checks: [
            {
              type: 'node_test',
              path: 'schema.json',
              testScript: 'const fs = require("fs"); const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (s.version !== 2 || !Array.isArray(s.endpoints) || s.endpoints.length === 0) process.exit(1);',
            },
          ],
        },
        {
          key: 'impl',
          member: 'Coder',
          title: 'Implement endpoint',
          goal: 'Implement endpoint from schema',
          difficulty: 'high',
          dependsOn: ['design'],
          writeScopes: ['impl.cjs'],
          checks: [{ type: 'file_contains', path: 'impl.cjs', value: 'status_ok' }],
        },
      ],
    }, execCtx);

    teamId = prepared.id;
    designTaskId = prepared.planTasks.find(p => p.key === 'design').taskId;
    implTaskId = prepared.planTasks.find(p => p.key === 'impl').taskId;

    const rulingSrc = await runtime1.executeTool('engine_source', {
      teamId,
      kind: 'ruling',
      label: 'Naming convention',
      text: 'Use snake_case keys across all endpoints.',
    }, execCtx);
    rulingSourceId = rulingSrc.id;

    await runtime1.executeTool('engine_team', { action: 'resume', teamId }, execCtx);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const insp = await runtime1.executeTool('engine_control', { taskId: implTaskId, action: 'inspect' }, execCtx);
      if (insp.state === 'checked' || insp.state === 'failed') break;
      await new Promise(r => setTimeout(r, 80));
    }

    const designInsp = await runtime1.executeTool('engine_control', { taskId: designTaskId, action: 'inspect' }, execCtx);
    assert.equal(designInsp.state, 'accepted', 'Wave 1 task with passing behavioral node_test + autoAccept=true must auto-accept');
    designSnapshotId = designInsp.snapshotId;
    assert.ok(designSnapshotId && designSnapshotId !== 'unknown');

    const implInsp1 = await runtime1.executeTool('engine_control', { taskId: implTaskId, action: 'inspect' }, execCtx);
    assert.equal(implInsp1.state, 'checked');

    await runtime1.executeTool('engine_control', {
      taskId: implTaskId,
      action: 'rework',
      expectedRevision: implInsp1.revision,
      reason: 'Please set revised: true in impl.cjs',
    }, execCtx);

    const deadline2 = Date.now() + 8000;
    while (Date.now() < deadline2) {
      const insp = await runtime1.executeTool('engine_control', { taskId: implTaskId, action: 'inspect' }, execCtx);
      if (insp.state === 'checked' && insp.revision > implInsp1.revision + 1) break;
      await new Promise(r => setTimeout(r, 80));
    }

    const batch = await runtime1.executeTool('engine_team', { action: 'accept_checked', teamId }, execCtx);
    assert.equal(batch.accepted.length, 1);
    assert.equal(batch.accepted[0].taskId, implTaskId);
  } finally {
    await runtime1.close();
  }

  // Simulate full DeepSeek Harness restart: instantiate brand-new runtime on the same dataDir
  const runtime2 = new DshSuperTeamsRuntime({ ctx: host.ctx, dataDir });
  try {
    const execCtx = { agent: host.rootAgent };
    const listView = await runtime2.executeTool('teams_engine', { action: 'list' }, execCtx);
    assert.equal(listView.store, 'engine.sqlite');
    assert.equal(listView.audit_independence, 'same_engine_store');
    assert.equal(listView.data.teams.length, 1);
    assert.equal(listView.data.teams[0].id, teamId);

    const graphView = await runtime2.executeTool('teams_engine', { action: 'graph', team_id: teamId }, execCtx);
    assert.equal(graphView.data.waveCount, 2);

    const overviewView = await runtime2.executeTool('teams_engine', { action: 'overview', team_id: teamId }, execCtx);
    assert.equal(overviewView.data.total, 2);
    assert.equal(overviewView.data.items.length, 2);
    assert.ok(overviewView.data.items.every(t => t.state === 'accepted'));

    const persistedDesign = await runtime2.executeTool('engine_control', { taskId: designTaskId, action: 'inspect' }, execCtx);
    assert.equal(persistedDesign.snapshotId, designSnapshotId);

    const persistedRuling = await runtime2.executeTool('engine_evidence', {
      kind: 'source',
      id: rulingSourceId,
      teamId,
    }, execCtx);
    assert.match(persistedRuling.text, /Use snake_case keys/);

    // Verify hardlink defense still rejects linked files on isolated workspace
    const secretFile = path.join(dataDir, 'secret-probe.txt');
    fs.writeFileSync(secretFile, 'top-secret');
    const hostWithLink = createFakeDshHost({
      runner: async spec => {
        fs.writeFileSync(path.join(spec.cwd, 'good.json'), JSON.stringify({ ok: true }));
        fs.linkSync(secretFile, path.join(spec.cwd, 'hardlink.txt'));
        return { text: 'Produced good.json and attempted hardlink.' };
      },
    });
    const rtLink = new DshSuperTeamsRuntime({ ctx: hostWithLink.ctx, dataDir: makeTempDir('dsh-rt-link-') });
    try {
      const sub = await rtLink.executeTool('engine_submit', {
        requestId: 'sub-nt-link',
        title: 'Run inline node_test',
        goal: 'Generate good.json',
        checks: [{
          type: 'node_test',
          path: 'good.json',
          testScript: 'const fs = require("fs"); const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (j.ok !== true) process.exit(1);',
          timeoutMs: 10000,
        }],
      }, { agent: hostWithLink.rootAgent });
      const dl = Date.now() + 8000;
      while (Date.now() < dl) {
        const st = await rtLink.executeTool('engine_control', { taskId: sub.taskId, action: 'inspect' }, { agent: hostWithLink.rootAgent });
        if (st.state === 'checked' || st.state === 'failed') break;
        await new Promise(r => setTimeout(r, 80));
      }
      const files = await rtLink.engine.listTaskFiles(sub.taskId);
      assert.ok(!files.files.some(f => f.path === 'hardlink.txt'), 'Hardlinked file must be omitted from listTaskFiles');
      await assert.rejects(() => rtLink.engine.readTaskFile(sub.taskId, 'hardlink.txt'), /independent regular file/);
    } finally {
      const dlDir = rtLink.dataDir;
      await rtLink.close();
      fs.rmSync(dlDir, { recursive: true, force: true });
    }
  } finally {
    await runtime2.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('autoAccept behavioral gate blocks shallow file_exists/file_contains checks and blocks stub implementations', async () => {
  const dataDir = makeTempDir('dsh-rt-autoaccept-');
  let shouldProduceStub = true;

  const host = createFakeDshHost({
    runner: async spec => {
      if (shouldProduceStub) {
        // Stub passes file_exists AND file_contains('export'), but fails actual behavioral calculation!
        fs.writeFileSync(path.join(spec.cwd, 'calc.cjs'), 'module.exports = { sum: () => 0 }; // TODO stub\n');
        return { text: 'Wrote stub calc.cjs' };
      }
      fs.writeFileSync(path.join(spec.cwd, 'calc.cjs'), 'module.exports = { sum: (a, b) => a + b };\n');
      return { text: 'Implemented working sum(a, b)' };
    },
  });

  const runtime = new DshSuperTeamsRuntime({ ctx: host.ctx, dataDir });
  try {
    const execCtx = { agent: host.rootAgent };

    // 1. Shallow checks alone MUST be rejected when autoAccept: true
    for (const shallowCheck of [
      { type: 'file_exists', path: 'calc.cjs' },
      { type: 'file_contains', path: 'calc.cjs', value: 'module.exports' },
      { type: 'json_equals', path: 'pkg.json', pointer: '/ok', expected: true },
    ]) {
      await assert.rejects(
        () => runtime.executeTool('engine_submit', {
          requestId: 'shallow-' + shallowCheck.type,
          title: 'Shallow autoAccept attempt',
          goal: 'Should be rejected at submission',
          autoAccept: true,
          checks: [shallowCheck],
        }, execCtx),
        /autoAccept=true requires at least one behavioral node_test check/
      );
    }

    // 2. Behavioral node_test catches stub output (even though file_exists & file_contains pass!) and prevents false-positive freeze
    const sub = await runtime.executeTool('engine_submit', {
      requestId: 'behavioral-gate-1',
      title: 'Implement sum()',
      goal: 'Implement calc.cjs with sum(a, b)',
      writeScopes: ['calc.cjs'],
      autoAccept: true,
      checks: [
        { type: 'file_contains', path: 'calc.cjs', value: 'module.exports' },
        {
          type: 'node_test',
          path: 'calc.cjs',
          testScript: 'const assert = require("node:assert/strict"); const mod = require(process.argv[1]); assert.equal(mod.sum(2, 3), 5); assert.equal(mod.sum(-4, 10), 6);',
        },
      ],
    }, execCtx);

    const deadline1 = Date.now() + 8000;
    while (Date.now() < deadline1) {
      const insp = await runtime.executeTool('engine_control', { taskId: sub.taskId, action: 'inspect' }, execCtx);
      if (insp.state === 'failed' || insp.state === 'accepted' || insp.state === 'checked') break;
      await new Promise(r => setTimeout(r, 80));
    }

    const stubInsp = await runtime.executeTool('engine_control', { taskId: sub.taskId, action: 'inspect' }, execCtx);
    assert.equal(stubInsp.state, 'failed', 'Stub implementation failing node_test must NOT autoAccept');
    assert.equal(stubInsp.snapshotId, 'unknown', 'Failed behavioral test must NOT freeze a snapshot');

    // 3. Rework with real implementation -> behavioral node_test passes -> autoAccept freezes snapshot!
    shouldProduceStub = false;
    await runtime.executeTool('engine_control', {
      taskId: sub.taskId,
      action: 'rework',
      expectedRevision: stubInsp.revision,
      reason: 'Implement real addition instead of returning 0',
    }, execCtx);

    const deadline2 = Date.now() + 8000;
    while (Date.now() < deadline2) {
      const insp = await runtime.executeTool('engine_control', { taskId: sub.taskId, action: 'inspect' }, execCtx);
      if (insp.state === 'accepted' || (insp.state === 'failed' && insp.revision > stubInsp.revision + 1)) break;
      await new Promise(r => setTimeout(r, 80));
    }

    const fixedInsp = await runtime.executeTool('engine_control', { taskId: sub.taskId, action: 'inspect' }, execCtx);
    assert.equal(fixedInsp.state, 'accepted', 'Real implementation passing behavioral node_test must autoAccept');
    assert.ok(fixedInsp.snapshotId && fixedInsp.snapshotId !== 'unknown');
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('writeScopes enforces runtime scheduler mutex (write-scope-lock) and rejects out-of-scope workspace files', async () => {
  const dataDir = makeTempDir('dsh-rt-scopes-');
  let activeInSharedScope = 0;
  let maxConcurrentInSharedScope = 0;
  let sawWriteScopeLockState = false;
  let runtimeRef = null;
  let taskBId = null;

  const host = createFakeDshHost({
    runner: async spec => {
      const prompt = spec.prompt[0].text;
      if (prompt.includes('Task A shared writer') || prompt.includes('Task B overlapping writer')) {
        activeInSharedScope++;
        maxConcurrentInSharedScope = Math.max(maxConcurrentInSharedScope, activeInSharedScope);
        if (prompt.includes('Task A shared writer') && runtimeRef && taskBId) {
          await new Promise(r => setTimeout(r, 90));
          const bState = runtimeRef.engine.get(taskBId);
          if (bState?.state === 'blocked' && bState?.blockReason === 'write-scope-lock') {
            sawWriteScopeLockState = true;
          }
          await new Promise(r => setTimeout(r, 90));
        } else {
          await new Promise(r => setTimeout(r, 60));
        }
        fs.mkdirSync(path.join(spec.cwd, 'shared'), { recursive: true });
        fs.writeFileSync(path.join(spec.cwd, 'shared/config.json'), JSON.stringify({ writer: prompt.slice(0, 20) }));
        activeInSharedScope--;
        return { text: 'Updated shared/config.json safely.' };
      }
      if (prompt.includes('Task C out-of-scope writer')) {
        fs.mkdirSync(path.join(spec.cwd, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(spec.cwd, 'docs/readme.md'), '# Docs\n');
        fs.writeFileSync(path.join(spec.cwd, 'src-sneaky.js'), 'console.log("undeclared write!");\n');
        return { text: 'Wrote docs/readme.md plus undeclared src-sneaky.js' };
      }
      return { text: 'Done' };
    },
  });

  const runtime = new DshSuperTeamsRuntime({ ctx: host.ctx, dataDir });
  runtimeRef = runtime;
  try {
    const execCtx = { agent: host.rootAgent };
    await runtime.ensureStarted();
    runtime.engine.setMaxConcurrent(3);
    const prepared = await runtime.executeTool('engine_team', {
      action: 'prepare',
      requestId: 'prep-mutex-1',
      name: 'Scope Mutex Team',
      goal: 'Serialize overlapping writeScopes and catch undeclared files',
      members: [
        { name: 'WorkerA', role: 'Dev', responsibility: 'Config A' },
        { name: 'WorkerB', role: 'Dev', responsibility: 'Config B' },
        { name: 'WorkerC', role: 'Docs', responsibility: 'Docs only' },
      ],
      tasks: [
        {
          key: 'a',
          member: 'WorkerA',
          title: 'Write shared config A',
          goal: 'Task A shared writer',
          priority: 'high',
          writeScopes: ['shared/config.json'],
          checks: [{ type: 'file_exists', path: 'shared/config.json' }],
        },
        {
          key: 'b',
          member: 'WorkerB',
          title: 'Write shared dir B',
          goal: 'Task B overlapping writer',
          priority: 'normal',
          writeScopes: ['shared'],
          checks: [{ type: 'file_exists', path: 'shared/config.json' }],
        },
        {
          key: 'c',
          member: 'WorkerC',
          title: 'Write docs only',
          goal: 'Task C out-of-scope writer',
          priority: 'normal',
          writeScopes: ['docs/**'],
          checks: [{ type: 'file_exists', path: 'docs/readme.md' }],
        },
      ],
    }, execCtx);

    const taskAId = prepared.planTasks.find(p => p.key === 'a').taskId;
    taskBId = prepared.planTasks.find(p => p.key === 'b').taskId;
    const taskCId = prepared.planTasks.find(p => p.key === 'c').taskId;

    await runtime.executeTool('engine_team', { action: 'resume', teamId: prepared.id }, execCtx);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const a = runtime.engine.get(taskAId);
      const b = runtime.engine.get(taskBId);
      const c = runtime.engine.get(taskCId);
      const done = [a, b, c].every(t => t.state === 'checked' || t.state === 'failed');
      if (done) break;
      await new Promise(r => setTimeout(r, 40));
    }

    assert.equal(maxConcurrentInSharedScope, 1, 'Overlapping writeScopes must NEVER execute concurrently');
    assert.equal(sawWriteScopeLockState, true, 'Second overlapping task must enter blocked(write-scope-lock) while first holds mutex');
    assert.equal(runtime.engine.get(taskAId).state, 'checked');
    assert.equal(runtime.engine.get(taskBId).state, 'checked');

    const cInsp = await runtime.executeTool('engine_control', { taskId: taskCId, action: 'inspect' }, execCtx);
    assert.equal(cInsp.state, 'failed', 'Out-of-scope workspace file must fail verification');
    const cFull = runtime.engine.get(taskCId);
    const guardCheck = cFull.verification.checks.find(ch => ch.type === 'write_scope_guard');
    assert.ok(guardCheck && guardCheck.passed === false);
    assert.match(guardCheck.error, /src-sneaky\.js/);
  } finally {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
