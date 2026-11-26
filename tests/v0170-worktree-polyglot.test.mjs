import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { validateCheck } from '../packages/super-teams/src/engine/verification.mjs';
import { createDeliveryExport } from '../packages/super-teams/src/engine/delivery-export.mjs';
import { DshSuperTeamsRuntime } from '../packages/super-teams/src/runtime.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
  fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'ignored-tracked.txt\n');
  fs.writeFileSync(path.join(repoDir, 'ignored-tracked.txt'), 'tracked-despite-gitignore\n');
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'fixture-repo',
    version: '1.0.0',
    scripts: { test: 'node --test tests/smoke.test.mjs' },
  }, null, 2));
  fs.writeFileSync(path.join(repoDir, 'src', 'base.js'), 'exports.base = 1;\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'b.js'), 'exports.b = 0;\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'shared.js'), 'exports.line = "initial";\n');
  fs.writeFileSync(path.join(repoDir, 'tests', 'smoke.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke', () => { assert.equal(1 + 1, 2); });\n`);
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['add', '-A']);
  git(repoDir, ['add', '-f', 'ignored-tracked.txt']);
  git(repoDir, ['commit', '--no-gpg-sign', '-m', 'initial commit']);
  const baseCommit = git(repoDir, ['rev-parse', 'HEAD']);
  return { repoDir, baseCommit };
}

async function waitUntil(fn, timeoutMs = 20000, label = 'condition', diagFn = null) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastErr = null;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    try {
      if (await fn()) return;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  const elapsed = Date.now() - startedAt;
  const diag = typeof diagFn === 'function' ? (() => { try { return diagFn(); } catch (e) { return e.message; } })() : '';
  throw new Error(`Timed out waiting for ${label} after ${elapsed}ms (${polls} polls)${lastErr ? ` | lastErr=${lastErr.message}` : ''}${diag ? ` | diag=${typeof diag === 'string' ? diag : JSON.stringify(diag)}` : ''}`);
}

function createScriptedAdapter(handler) {
  let seq = 0;
  return {
    connect: async () => {},
    close: async () => {},
    models: async () => [{ model: 'mock-model', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'] }],
    start: async (task, hooks) => {
      await hooks.beforeExecute();
      const id = ++seq;
      await hooks.onIdentity({ threadId: `t-${id}`, turnId: `turn-${id}` });
      const completion = Promise.resolve().then(() => handler(task));
      return { threadId: `t-${id}`, turnId: `turn-${id}`, completion, interrupt: async () => {} };
    },
  };
}

test('DSH v0.17.0 command_test validation rejects npx, inline eval, unsafe flags, and 0-test bypasses', async t => {
  const rejected = [
    { type: 'command_test', command: 'npx', args: ['vitest'] },
    { type: 'command_test', command: 'node', args: ['-e', 'process.exit(0)'] },
    { type: 'command_test', command: 'node', args: ['--test', '--eval=process.exit(0)'] },
    { type: 'command_test', command: 'node', args: ['--test', '--require', './x.js'] },
    { type: 'command_test', command: 'python', args: ['-c', 'print(1)'] },
    { type: 'command_test', command: 'python3', args: ['-m', 'http.server'] },
    { type: 'command_test', command: 'go', args: ['test', '-exec', 'sh'] },
    { type: 'command_test', command: 'cargo', args: ['test', '--config', 'build.rustc-wrapper="sh"'] },
    { type: 'command_test', command: 'npm', args: ['run', 'build'] },
    { type: 'command_test', command: 'npm', args: ['test', '--script-shell=sh'] },
    { type: 'command_test', command: 'node', args: ['--test', '../outside.test.mjs'] },
  ];
  for (const check of rejected) {
    assert.throws(() => validateCheck(check), `Should reject ${JSON.stringify(check)}`);
  }

  const root = makeTempDir('dsh-v0170-zerotest-');
  const dataDir = path.join(root, 'data');
  const adapter = createScriptedAdapter(async task => {
    fs.writeFileSync(path.join(task.cwd, 'empty.test.mjs'), `import test from 'node:test';\ntest('all skipped trap', { skip: true }, () => {});\n`);
    return { status: 'completed', text: 'wrote skipped test' };
  });
  const engine = new Engine({ dataDir, contextStore: new ContextStore(path.join(dataDir, 'context')), adapter });
  await engine.initialize();
  t.after(async () => { await engine.close(); safeRm(root); });
  assert.throws(() => engine.submit({
    requestId: randomUUID(),
    title: 'Command-only autoAccept forbidden',
    goal: 'Must reject command_test-only autoAccept',
    autoAccept: true,
    checks: [{ type: 'command_test', command: 'node', args: ['--test', 'empty.test.mjs'] }],
  }), /autoAccept=true requires at least one behavioral node_test check/);

  const task = engine.submit({
    requestId: randomUUID(),
    title: 'Zero test trap',
    goal: 'Should fail on 0 passed tests',
    checks: [{ type: 'command_test', command: 'node', args: ['--test', 'empty.test.mjs'] }],
  });
  await engine.runDue();
  await waitUntil(() => engine.get(task.id).state === 'failed', 10000, 'zero-test failure');
  assert.match(engine.get(task.id).error, /0 tests/i);
});

test('DSH v0.17.0 git-worktree catches detached-HEAD out-of-scope commits, rename escapes, and Windows junctions', async t => {
  const root = makeTempDir('dsh-v0170-scope-');
  const outsideDir = path.join(root, 'outside-secret');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP-SECRET');

  const { repoDir, baseCommit } = initFixtureRepo(root);
  const dataDir = path.join(root, 'data');

  const adapter = createScriptedAdapter(async task => {
    if (task.title === 'sneaky-commit') {
      fs.writeFileSync(path.join(task.cwd, 'src', 'base.js'), 'exports.base = 2;\n');
      fs.writeFileSync(path.join(task.cwd, 'src', 'b.js'), 'exports.b = 999;\n');
      git(task.cwd, ['add', '-A']);
      git(task.cwd, ['commit', '--no-gpg-sign', '-m', 'sneaky out-of-scope commit']);
      assert.equal(git(task.cwd, ['status', '--porcelain']), '');
      return { status: 'completed', text: 'sneaky commit done' };
    }
    if (task.title === 'sneaky-rename') {
      fs.renameSync(path.join(task.cwd, 'src', 'b.js'), path.join(task.cwd, 'src', 'base.js'));
      return { status: 'completed', text: 'renamed b into base' };
    }
    if (task.title === 'junction-escape') {
      const linkPath = path.join(task.cwd, 'src', 'linked-dir');
      fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return { status: 'completed', text: 'created junction' };
    }
    return { status: 'completed', text: 'ok' };
  });

  const engine = new Engine({ dataDir, contextStore: new ContextStore(path.join(dataDir, 'context')), adapter, maxConcurrent: 1 });
  await engine.initialize();
  t.after(async () => { await engine.close(); safeRm(root); });

  const team = engine.createTeam({
    requestId: randomUUID(),
    name: 'DSH Worktree Scope Audit',
    goal: 'Verify two-tree diff enforcement',
    workspaceMode: 'git-worktree',
    repoPath: repoDir,
    members: [{ name: 'Dev', role: 'Engineer', responsibility: 'Code' }],
    tasks: [
      { key: 't1', member: 'Dev', title: 'sneaky-commit', goal: 'Commit out-of-scope file', writeScopes: ['src/base.js'] },
      { key: 't2', member: 'Dev', title: 'sneaky-rename', goal: 'Rename out-of-scope file into scope', writeScopes: ['src/base.js'] },
      { key: 't3', member: 'Dev', title: 'junction-escape', goal: 'Create directory junction', writeScopes: ['src/'] },
    ],
  });
  await engine.teamControl(team.id, 'resume');
  const ids = Object.fromEntries(team.planTasks.map(p => [p.key, p.taskId]));
  await waitUntil(() => ['t1', 't2', 't3'].every(k => engine.get(ids[k]).state === 'failed'), 20000, 'all scope violations fail');

  assert.match(engine.get(ids.t1).error, /two-tree diff.*src\/b\.js/i);
  assert.match(engine.get(ids.t2).error, /two-tree diff.*src\/b\.js/i);
  assert.match(engine.get(ids.t3).error, /symlink|junction/i);
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), baseCommit);
});

test('DSH v0.17.0 runtime tool end-to-end: diamond git-worktree DAG, self-modified test autoAccept guard, .git-free tests, atomic merge_apply race, and HANDOFF delivery', async t => {
  const root = makeTempDir('dsh-v0170-e2e-');
  const { repoDir, baseCommit } = initFixtureRepo(root);
  const dataDir = path.join(root, 'data');

  const runtime = new DshSuperTeamsRuntime({
    dataDir,
    mockRunner: async task => {
      if (task.title === 'task-a') {
        fs.writeFileSync(path.join(task.cwd, 'src', 'base.js'), 'exports.base = 10;\n');
        return { status: 'completed', text: 'updated base=10' };
      }
      if (task.title === 'task-b') {
        assert.match(fs.readFileSync(path.join(task.cwd, 'src', 'base.js'), 'utf8'), /base = 10/);
        fs.writeFileSync(path.join(task.cwd, 'src', 'mod-b.js'), 'const { base } = require("./base.js");\nexports.valB = base + 5;\n');
        return { status: 'completed', text: 'added mod-b' };
      }
      if (task.title === 'task-c') {
        assert.match(fs.readFileSync(path.join(task.cwd, 'src', 'base.js'), 'utf8'), /base = 10/);
        fs.writeFileSync(path.join(task.cwd, 'src', 'mod-c.js'), 'const { base } = require("./base.js");\nexports.valC = base * 3;\n');
        return { status: 'completed', text: 'added mod-c' };
      }
      if (task.title === 'task-d') {
        assert.ok(fs.existsSync(path.join(task.cwd, 'ignored-tracked.txt')));
        fs.writeFileSync(path.join(task.cwd, 'src', 'sum.js'), 'const { valB } = require("./mod-b.js");\nconst { valC } = require("./mod-c.js");\nexports.total = valB + valC;\n');
        fs.writeFileSync(path.join(task.cwd, 'tests', 'diamond.test.mjs'), [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          "import { createRequire } from 'node:module';",
          "const require = createRequire(import.meta.url);",
          "test('isolated .git-free export and diamond calculation', () => {",
          "  assert.equal(fs.existsSync(path.join(process.cwd(), '.git')), false);",
          "  const { total } = require(path.join(process.cwd(), 'src', 'sum.js'));",
          "  assert.equal(total, 45);",
          "});",
        ].join('\n'));
        return { status: 'completed', text: 'integrated diamond sum=45' };
      }
      return { status: 'completed', text: 'ok' };
    },
  });
  t.after(async () => { await runtime.close(); safeRm(root); });

  const prepared = await runtime.executeTool('engine_team', {
    action: 'prepare',
    requestId: randomUUID(),
    name: 'DSH Diamond Worktree Team',
    goal: 'Full tool schema & runtime test',
    workspaceMode: 'git-worktree',
    repoPath: repoDir,
    members: [
      { name: 'Lead', role: 'Lead', responsibility: 'Base & integration' },
      { name: 'Worker1', role: 'Dev', responsibility: 'Mod B' },
      { name: 'Worker2', role: 'Dev', responsibility: 'Mod C' },
    ],
    tasks: [
      { key: 'a', member: 'Lead', title: 'task-a', goal: 'Set base=10', writeScopes: ['src/base.js'], checks: [{ type: 'command_test', command: 'node', args: ['--test', 'tests/smoke.test.mjs'] }] },
      { key: 'b', member: 'Worker1', title: 'task-b', goal: 'Add mod-b', dependsOn: ['a'], writeScopes: ['src/mod-b.js'], autoAccept: true, checks: [{ type: 'node_test', path: 'src/mod-b.js', testScript: 'const assert=require("node:assert/strict"); assert.equal(require(process.argv[1]).valB, 15);' }] },
      { key: 'c', member: 'Worker2', title: 'task-c', goal: 'Add mod-c', dependsOn: ['a'], writeScopes: ['src/mod-c.js'], autoAccept: true, checks: [{ type: 'node_test', path: 'src/mod-c.js', testScript: 'const assert=require("node:assert/strict"); assert.equal(require(process.argv[1]).valC, 30);' }] },
      { key: 'd', member: 'Lead', title: 'task-d', goal: 'Combine B+C and write diamond test', dependsOn: ['b', 'c'], writeScopes: ['src/sum.js', 'tests/diamond.test.mjs'], checks: [{ type: 'command_test', path: 'src/sum.js', command: 'node', args: ['--test', 'tests/diamond.test.mjs'] }] },
    ],
  });
  assert.equal(prepared.workspaceMode, 'git-worktree');
  assert.equal(prepared.baseCommit, baseCommit);

  await runtime.executeTool('engine_team', { action: 'resume', teamId: prepared.id });
  const ids = Object.fromEntries(prepared.planTasks.map(p => [p.key, p.taskId]));
  await waitUntil(() => runtime.engine.get(ids.a).state === 'checked', 20000, 'task-a checked via command_test');
  await runtime.executeTool('engine_control', { taskId: ids.a, action: 'accept', expectedRevision: runtime.engine.get(ids.a).revision, reason: 'Reviewed task-a' });
  await waitUntil(() => ['b', 'c'].every(k => runtime.engine.get(ids[k]).state === 'accepted') && runtime.engine.get(ids.d).state === 'checked', 30000, 'b/c accepted and d checked');

  const dChecked = runtime.engine.get(ids.d);
  await runtime.executeTool('engine_control', { taskId: ids.d, action: 'accept', expectedRevision: dChecked.revision, reason: 'Reviewed diamond.test.mjs' });

  const integrationCheck = { type: 'command_test', command: 'node', args: ['--test', 'tests/diamond.test.mjs'] };
  const preview = await runtime.executeTool('engine_team', { action: 'merge_preview', teamId: prepared.id, integrationCheck });
  assert.equal(preview.ok, true);
  assert.equal(preview.integrationCheck.passed, true);

  const race = await Promise.allSettled([
    runtime.executeTool('engine_team', { action: 'merge_apply', teamId: prepared.id, branchName: 'dsh-race', integrationCheck }),
    runtime.executeTool('engine_team', { action: 'merge_apply', teamId: prepared.id, branchName: 'dsh-race', integrationCheck }),
  ]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(race.filter(r => r.status === 'rejected').length, 1);
  assert.equal(git(repoDir, ['rev-parse', 'HEAD']), baseCommit);

  const delivery = await createDeliveryExport({ engine: runtime.engine, teamId: prepared.id });
  try {
    assert.ok(delivery.manifest.files.some(f => f.path === 'HANDOFF.md'));
    assert.ok(delivery.manifest.files.some(f => f.path === `artifacts/${ids.d}/changes.patch`));
  } finally {
    await delivery.cleanup();
  }
});
