import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { probeRepoEnvironment, approveEnvRecipe, WorktreeEnvManager } from '../packages/super-teams/src/engine/core/src/env-recipe.mjs';
import { isProcessAlive } from '../packages/super-teams/src/engine/core/src/process-isolation.mjs';
import { validateBenchmarkConfig, exactOneSidedSignTestPValue, runScreeningBenchmark } from '../packages/super-teams/src/engine/core/src/bench-harness.mjs';
import { CORE_VERSION } from '../packages/super-teams/src/engine/core/src/core-version.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(rootDir, files = { 'README.md': '# DSH Demo\n', 'src/app.js': 'module.exports = { v: 1 };\n' }) {
  fs.mkdirSync(rootDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'DSH Bench User'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'dsh-bench@example.invalid'], { cwd: rootDir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: rootDir, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
}

function createScriptedAdapter(handlers) {
  let seq = 0;
  return {
    async connect() {},
    async close() {},
    status() { return { state: 'connected' }; },
    async models() { return [{ model: 'deepseek-test', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'] }]; },
    authorizeThread() {},
    async start(task, hooks) {
      await hooks.beforeExecute();
      const n = ++seq;
      const threadId = `dsh-th-${n}`;
      const turnId = `dsh-tu-${n}`;
      await hooks.onIdentity({ threadId, turnId });
      const completion = Promise.resolve().then(async () => {
        const fn = handlers[task.title];
        if (typeof fn === 'function') await fn(task);
        return { status: 'completed', text: `Completed ${task.title}`, usage: { inputTokens: 15, outputTokens: 15, totalTokens: 30 } };
      });
      return { threadId, turnId, completion, interrupt: async () => {} };
    },
  };
}

async function waitForState(engine, taskId, state, timeoutMs = 15000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    const t = engine.get(taskId);
    if (t.state === state) return t;
    await new Promise(r => setTimeout(r, 30));
  }
  const cur = engine.get(taskId);
  throw new Error(`Timeout waiting for ${taskId} -> ${state}, got ${cur.state} (${cur.error || ''})`);
}

test('DSH v0.20 env-recipe: probe lists candidate commands without auto-selecting and WorktreeEnvManager isolates concurrent services', async t => {
  const root = makeTempDir('dsh-v020-env-');
  const repoDir = path.join(root, 'repo');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
  const pkgJson = JSON.stringify({
    name: 'dsh-polyglot-demo',
    scripts: { test: 'node --test', 'test:quick': 'node --test tests/smoke.test.mjs' },
  });
  initGitRepo(repoDir, {
    'package.json': pkgJson,
    'package-lock.json': '{}',
    'Cargo.toml': '[package]\nname="x"\n',
    'Cargo.lock': '',
  });

  const engine = new Engine({ dataDir, adapter: createScriptedAdapter({}), contextStore: new ContextStore(path.join(dataDir, 'context')) });
  await engine.initialize();

  const wtManager = new WorktreeEnvManager();
  t.after(async () => {
    await wtManager.closeAll();
    await engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const probe = probeRepoEnvironment(repoDir);
  assert.equal(probe.autoSelected, false);
  assert.ok(probe.ecosystems.includes('node'));
  assert.ok(probe.ecosystems.includes('rust'));
  assert.ok(probe.candidateCommands.some(c => c.id === 'npm:test'));

  const team = engine.createTeam({
    requestId: randomUUID(),
    name: 'DSH Env Recipe Team',
    goal: 'Approve env recipe',
    workspaceMode: 'git-worktree',
    repoPath: repoDir,
    members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
  });

  const approved = approveEnvRecipe(engine.store, team.id, {
    repoPath: repoDir,
    selectedCommands: ['npm test'],
    setupCommand: 'npm ci',
    approvedBy: 'maintainer-alice',
  });
  assert.equal(approved.approved, true);
  assert.equal(engine.listEnvRecipes(team.id).length, 1);

  const serverScript = path.join(root, 'svc.mjs');
  fs.writeFileSync(serverScript, [
    "import http from 'node:http';",
    "const port = Number(process.env.PORT);",
    "const wid = process.env.WORKTREE_ID;",
    "const srv = http.createServer((req, res) => {",
    "  res.writeHead(200, { 'Content-Type': 'application/json' });",
    "  res.end(JSON.stringify({ ok: true, wid, port }));",
    "});",
    "srv.listen(port, '127.0.0.1');",
  ].join('\n'), 'utf8');

  const wt1Dir = path.join(root, 'wt1');
  const wt2Dir = path.join(root, 'wt2');
  fs.mkdirSync(wt1Dir, { recursive: true });
  fs.mkdirSync(wt2Dir, { recursive: true });

  const svc1 = await wtManager.startWorktreeService({ worktreeId: 'dsh-wt-1', cwd: wt1Dir, command: process.execPath, args: [serverScript], readyUrl: 'http://127.0.0.1:{port}/health', recipeHash: approved.recipeHash });
  const svc2 = await wtManager.startWorktreeService({ worktreeId: 'dsh-wt-2', cwd: wt2Dir, command: process.execPath, args: [serverScript], readyUrl: 'http://127.0.0.1:{port}/health', recipeHash: approved.recipeHash });

  assert.notEqual(svc1.port, svc2.port);
  await wtManager.cancelWorktree('dsh-wt-1');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && isProcessAlive(svc1.pid)) {
    await new Promise(r => setTimeout(r, 40));
  }
  assert.equal(isProcessAlive(svc1.pid), false);
  await assert.rejects(() => fetch(svc1.url, { signal: AbortSignal.timeout(500) }));
  assert.equal(isProcessAlive(svc2.pid), true);
  assert.equal((await (await fetch(svc2.url)).json()).wid, 'dsh-wt-2');
});

test('DSH v0.20 benchmark harness: config guard, exact sign test p=7/64, and 6x3=18 blind commit export screening', async t => {
  const root = makeTempDir('dsh-v020-bench-');
  const repoA = path.join(root, 'repos', 'repo-a');
  const repoB = path.join(root, 'repos', 'repo-b');
  const evalRoot = path.join(root, 'eval-suite');
  const commitA = initGitRepo(repoA);
  const commitB = initGitRepo(repoB);
  const engineRoot = path.resolve(import.meta.dirname, '..');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => validateBenchmarkConfig({ evalRoot: path.join(repoA, 'leak'), repos: [{ id: 'a', repoPath: repoA }], engineRepoRoots: [engineRoot] }),
    /must not overlap/i,
  );
  assert.equal(exactOneSidedSignTestPValue(5, 6), 7 / 64);

  const repos = [
    { id: 'repoA', repoPath: repoA, baseCommit: commitA },
    { id: 'repoB', repoPath: repoB, baseCommit: commitB },
  ];
  const tasks = [
    { id: 't1', repoId: 'repoA', marker: 'dsh-a1' },
    { id: 't2', repoId: 'repoA', marker: 'dsh-a2' },
    { id: 't3', repoId: 'repoA', marker: 'dsh-a3' },
    { id: 't4', repoId: 'repoB', marker: 'dsh-b1' },
    { id: 't5', repoId: 'repoB', marker: 'dsh-b2' },
    { id: 't6', repoId: 'repoB', marker: 'dsh-b3' },
  ];

  const makeArmCommit = ({ task, repo, arm }) => {
    const wt = path.join(root, 'wt-bench', `${task.id}-${arm}`);
    fs.rmSync(wt, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', wt, repo.baseCommit], { cwd: repo.repoPath, stdio: 'pipe' });
    const shouldPass = arm !== 'single_agent' || task.id === 't1';
    fs.writeFileSync(path.join(wt, 'result.txt'), shouldPass ? task.marker : 'wrong', 'utf8');
    execFileSync('git', ['add', 'result.txt'], { cwd: wt, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `${task.id} ${arm}`], { cwd: wt, stdio: 'pipe' });
    const commitOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo.repoPath, stdio: 'pipe' });
    return { commitOid, repoPath: repo.repoPath, totalTokens: 1500, rescueMinutes: 0, withinBudget: true };
  };

  const summary = await runScreeningBenchmark({
    evalRoot,
    repos,
    tasks,
    engineRepoRoots: [engineRoot],
    runnerByArm: {
      codex_superagent: args => makeArmCommit(args),
      dsh_superagent: args => makeArmCommit(args),
      single_agent: args => makeArmCommit(args),
    },
    evaluator: async ({ task, evalDir }) => {
      assert.equal(fs.existsSync(path.join(evalDir, '.git')), false);
      const actual = fs.readFileSync(path.join(evalDir, 'result.txt'), 'utf8').trim();
      return { passed: actual === task.marker, detail: actual };
    },
  });

  assert.equal(summary.totalRuns, 18);
  assert.equal(summary.comparisons.dsh_superagent.wins, 5);
  assert.equal(summary.gate2Decision, 'advance_to_holdout_confirm');
});

test('DSH v0.20 parity: core-lock integrity check and deterministic candidate/approval/refusal replay', async t => {
  const dshCore = path.resolve(import.meta.dirname, '../packages/super-teams/src/engine/core');
  const dshLock = JSON.parse(fs.readFileSync(path.join(dshCore, 'core-lock.json'), 'utf8'));
  assert.equal(dshLock.coreVersion, CORE_VERSION);
  for (const [rel, expectedSha] of Object.entries(dshLock.files)) {
    const actualSha = createHash('sha256').update(fs.readFileSync(path.join(dshCore, rel))).digest('hex');
    assert.equal(actualSha, expectedSha, `DSH core file hash mismatch: ${rel}`);
  }

  const root = makeTempDir('dsh-v020-parity-');
  const repoDir = path.join(root, 'repo-parity');
  initGitRepo(repoDir, { 'README.md': '# Parity\n', 'feature.txt': 'v0\n' });
  const data1 = path.join(root, 'd1');
  const data2 = path.join(root, 'd2');

  const mkHandlers = () => ({
    'Parity Task': async task => {
      fs.writeFileSync(path.join(task.cwd, 'feature.txt'), 'v1-parity\n', 'utf8');
    },
  });

  const e1 = new Engine({ dataDir: data1, adapter: createScriptedAdapter(mkHandlers()), contextStore: new ContextStore(path.join(data1, 'ctx')) });
  await e1.initialize();

  let e2 = null;
  const codexRoot = path.resolve(import.meta.dirname, '../../superagent-execution-engine');
  if (fs.existsSync(path.join(codexRoot, 'src/engine.mjs'))) {
    const codexLock = JSON.parse(fs.readFileSync(path.join(codexRoot, 'src/core/core-lock.json'), 'utf8'));
    assert.equal(codexLock.bundleSha256, dshLock.bundleSha256);
    const { Engine: CodexEngine } = await import(new URL(`file:///${path.join(codexRoot, 'src/engine.mjs').replace(/\\/g, '/')}`).href);
    const { ContextStore: CodexContextStore } = await import(new URL(`file:///${path.join(codexRoot, 'src/context.mjs').replace(/\\/g, '/')}`).href);
    e2 = new CodexEngine({ dataDir: data2, adapter: createScriptedAdapter(mkHandlers()), contextStore: new CodexContextStore(path.join(data2, 'ctx')) });
  } else {
    e2 = new Engine({ dataDir: data2, adapter: createScriptedAdapter(mkHandlers()), contextStore: new ContextStore(path.join(data2, 'ctx')) });
  }
  await e2.initialize();

  t.after(async () => {
    await e1.close();
    await e2.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runFlow = async (eng, tag) => {
    const team = eng.createTeam({
      requestId: `dsh-parity-${tag}`,
      name: 'Parity Team',
      goal: '实现特性X。',
      workspaceMode: 'git-worktree',
      repoPath: repoDir,
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
    });
    const task = eng.submit({
      requestId: `dsh-task-${tag}`,
      teamId: team.id,
      memberId: team.members[0].id,
      title: 'Parity Task',
      goal: 'Write feature.txt',
      writeScopes: ['feature.txt'],
      checks: [{ type: 'file_contains', path: 'feature.txt', value: 'v1-parity' }],
    });
    await eng.teamControl(team.id, 'resume');
    const done = await waitForState(eng, task.id, 'checked');
    const acc = await eng.accept(done.id, { expectedRevision: done.revision, reason: 'Parity accept' });
    const cand = (await eng.createCandidate(team.id, { taskIds: [acc.id] })).candidate;
    const app = eng.approveCandidate(team.id, { candidateId: cand.id, purpose: 'local_publish', branchName: `dsh-p-${tag}`, actor: 'parity-bot' });
    let wrongErrCode = null;
    try {
      await eng.publishCandidateLocal(team.id, { candidateId: cand.id, approvalId: app.id, branchName: `wrong-${tag}` });
    } catch (e) { wrongErrCode = e.code; }
    const pub = await eng.publishCandidateLocal(team.id, { candidateId: cand.id, approvalId: app.id });
    return { treeOid: cand.treeOid, status: cand.status, wrongErrCode, pubTree: execFileSync('git', ['rev-parse', `${pub.commitOid}^{tree}`], { cwd: repoDir, encoding: 'utf8' }).trim() };
  };

  const out1 = await runFlow(e1, 'dsh1');
  const out2 = await runFlow(e2, 'peer');
  assert.equal(out1.treeOid, out2.treeOid);
  assert.equal(out1.status, out2.status);
  assert.equal(out1.wrongErrCode, 'APPROVAL_TARGET_MISMATCH');
  assert.equal(out2.wrongErrCode, 'APPROVAL_TARGET_MISMATCH');
  assert.equal(out1.pubTree, out2.pubTree);
});
