import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DshSuperTeamsRuntime } from '../packages/super-teams/src/runtime.mjs';
import { apply as applySuperTeams } from '../packages/super-teams/index.js';
import { CORE_VERSION } from '../packages/super-teams/src/engine/core/src/core-version.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(rootDir, files = { 'README.md': '# DSH Demo\n', 'config.txt': 'x=0\n' }) {
  fs.mkdirSync(rootDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'DSH Test'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'dsh@example.invalid'], { cwd: rootDir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: rootDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: rootDir, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();
}

async function waitForState(engine, taskId, states, timeoutMs = 10000) {
  const dl = Date.now() + timeoutMs;
  const set = new Set(Array.isArray(states) ? states : [states]);
  while (Date.now() < dl) {
    const t = engine.get(taskId);
    if (set.has(t.state)) return t;
    await new Promise(r => setTimeout(r, 40));
  }
  throw new Error(`Timeout waiting for ${taskId} -> ${JSON.stringify(states)}, got ${engine.get(taskId).state} (${engine.get(taskId).error || ''})`);
}

test('DSH v0.18 R1: single scheduler owner across dual entrypoints & locked core parity', async () => {
  const dshLock = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../packages/super-teams/src/engine/core/core-lock.json'), 'utf8'));
  assert.equal(dshLock.coreVersion, CORE_VERSION);

  // Opening the same dataDir through two Cordis plugin attachments shares a single runtime owner
  const dir = makeTempDir('dsh-v018-r1-owner-');
  const disposers = [];
  const toolSets = [[], []];
  const makeCtx = idx => ({
    tools: { register: def => toolSets[idx].push(def) },
    effect: fn => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    inject: () => {},
  });
  try {
    applySuperTeams(makeCtx(0), { dataDir: dir });
    applySuperTeams(makeCtx(1), { dataDir: dir });
    const execTeam0 = toolSets[0].find(t => t.name === 'engine_team');
    const execTeam1 = toolSets[1].find(t => t.name === 'engine_team');
    const created = await execTeam0.execute({
      action: 'create',
      requestId: 'r1-shared-team',
      name: 'Shared Owner Team',
      goal: 'Verify single scheduler owner',
      members: [{ name: 'Dev', role: 'Dev', responsibility: 'Code' }],
    }, {});
    // Second entrypoint immediately sees the exact same team via the shared owner without lock failure
    const listed = await execTeam1.execute({ action: 'list' }, {});
    const teamRows = listed.teams ?? listed.items ?? [];
    assert.ok(teamRows.some(t => t.id === created.id));
  } finally {
    for (const d of disposers) await d();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DSH v0.18 R2-R8: full runtime tool & delivery candidate rulings suite', async () => {
  const root = makeTempDir('dsh-v018-rulings-');
  const dataDir = path.join(root, 'data');
  const repoDir = path.join(root, 'repo');
  const baseCommit = initGitRepo(repoDir, { 'README.md': '# DSH R\n', 'config.txt': 'x=0\n' });

  const mockRunner = async task => {
    if (task.title === 'Task A1') {
      fs.writeFileSync(path.join(task.cwd, 'a.txt'), 'a-v1\n', 'utf8');
      fs.writeFileSync(path.join(task.cwd, 'old.txt'), 'old-only\n', 'utf8');
    } else if (task.title === 'Task A2') {
      fs.writeFileSync(path.join(task.cwd, 'new.txt'), 'new-only\n', 'utf8');
    } else if (task.title === 'Task B') {
      fs.writeFileSync(path.join(task.cwd, 'b.txt'), 'b-v1\n', 'utf8');
    } else if (task.title === 'Task Config') {
      fs.writeFileSync(path.join(task.cwd, 'config.txt'), 'x=2\n', 'utf8');
    } else if (task.title === 'Integration Fix R1') {
      assert.equal(fs.readFileSync(path.join(task.cwd, 'a.txt'), 'utf8').trim(), 'a-v1');
      assert.equal(fs.readFileSync(path.join(task.cwd, 'b.txt'), 'utf8').trim(), 'b-v1');
      fs.writeFileSync(path.join(task.cwd, 'a.txt'), 'a-fixed\n', 'utf8');
      fs.writeFileSync(path.join(task.cwd, 'b.txt'), 'b-fixed\n', 'utf8');
    }
    return { status: 'completed', text: `Done ${task.title}` };
  };

  let rt = new DshSuperTeamsRuntime({ dataDir, mockRunner });
  await rt.ensureStarted();
  const execCtx = { agent: { id: 'chat-r', session: { header: { cwd: repoDir } } } };

  try {
    const team = await rt.executeTool('engine_team', {
      action: 'create',
      requestId: 'dsh-r-team',
      name: 'DSH Rulings Team',
      goal: '交付接口A。交付接口B。兼容旧数据。',
      workspaceMode: 'git-worktree',
      repoPath: repoDir,
      members: [
        { name: 'DevA', role: 'Dev', responsibility: 'A' },
        { name: 'DevB', role: 'Dev', responsibility: 'B' },
      ],
    }, execCtx);
    const mA = team.members[0].id;
    const mB = team.members[1].id;

    const subA1 = await rt.executeTool('engine_submit', {
      requestId: 'dsh-a1',
      teamId: team.id,
      memberId: mA,
      title: 'Task A1',
      goal: 'Create a.txt and old.txt',
      writeScopes: ['a.txt', 'old.txt'],
      checks: [{ type: 'node_test', path: 'a.txt', testScript: 'const fs=require("fs"); if(!fs.readFileSync(process.argv[1],"utf8").includes("a-v1")) process.exit(1);' }],
    }, execCtx);
    const subB = await rt.executeTool('engine_submit', {
      requestId: 'dsh-b',
      teamId: team.id,
      memberId: mB,
      title: 'Task B',
      goal: 'Create b.txt',
      writeScopes: ['b.txt'],
      checks: [{ type: 'node_test', path: 'b.txt', testScript: 'const fs=require("fs"); if(!fs.readFileSync(process.argv[1],"utf8").includes("b-v1")) process.exit(1);' }],
    }, execCtx);

    // R2: AI 草案漏掉“兼容旧数据”
    const crit1 = await rt.executeTool('engine_team', {
      action: 'criteria_freeze',
      teamId: team.id,
      confirmedBy: 'dsh-maintainer',
      criteria: [
        { id: 'c-a', requirementText: '交付接口A', mandatory: true, verificationMode: 'check', taskId: subA1.taskId },
        { id: 'c-b', requirementText: '交付接口B', mandatory: true, verificationMode: 'check', taskId: subB.taskId },
      ],
    }, execCtx);
    assert.equal(crit1.hasUnmappedRequirements, true);
    assert.ok(crit1.unmappedSegments.some(s => s.text.includes('兼容旧数据')));

    await rt.executeTool('engine_team', { action: 'resume', teamId: team.id }, execCtx);
    const a1Done = await waitForState(rt.engine, subA1.taskId, 'checked');
    const bDone = await waitForState(rt.engine, subB.taskId, 'checked');
    await rt.executeTool('engine_control', { taskId: a1Done.id, action: 'accept', expectedRevision: a1Done.revision, reason: 'Accept A1' }, execCtx);

    // R3: 冻结候选 A 并批准 -> 之后验收 B，旧批准仍只能发 A，绝不能发 A+B
    const candARes = await rt.executeTool('engine_team', { action: 'candidate_create', teamId: team.id, taskIds: [a1Done.id] }, execCtx);
    const candA = candARes.candidate;
    const appA = await rt.executeTool('engine_team', { action: 'candidate_approve', teamId: team.id, candidateId: candA.id, purpose: 'local_publish', branchName: 'dsh-rel-a' }, execCtx);

    await rt.executeTool('engine_control', { taskId: bDone.id, action: 'accept', expectedRevision: bDone.revision, reason: 'Accept B' }, execCtx);
    const candAB = (await rt.executeTool('engine_team', { action: 'candidate_create', teamId: team.id, taskIds: [a1Done.id, bDone.id] }, execCtx)).candidate;
    assert.equal(candAB.goalEvaluation.goalPassed, false, 'R2: unmapped segment must keep goalPassed=false');

    await assert.rejects(
      () => rt.executeTool('engine_team', { action: 'candidate_publish_local', teamId: team.id, candidateId: candAB.id, approvalId: appA.id, branchName: 'dsh-rel-a' }, execCtx),
      /bound to candidate/i,
    );
    const pubA = await rt.executeTool('engine_team', { action: 'candidate_publish_local', teamId: team.id, candidateId: candA.id, approvalId: appA.id }, execCtx);
    assert.equal(pubA.scope, 'local_branch_only');
    assert.equal(pubA.remoteMerged, false);
    assert.doesNotMatch(execFileSync('git', ['ls-tree', '-r', '--name-only', 'refs/heads/superagent/dsh-rel-a'], { cwd: repoDir, encoding: 'utf8' }), /b\.txt/);

    // R3: GC + 重启后仍可读回候选 A
    execFileSync('git', ['gc', '--prune=now'], { cwd: repoDir, stdio: 'pipe' });
    await rt.close();
    rt = new DshSuperTeamsRuntime({ dataDir, mockRunner });
    await rt.ensureStarted();
    const gotA = await rt.executeTool('engine_team', { action: 'candidate_get', teamId: team.id, candidateId: candA.id }, execCtx);
    assert.equal(gotA.commitOid, candA.commitOid);

    // R4: 模拟 Git 更新后 DB 记账前崩溃 -> publish_reconcile 认领匹配意图
    const appCrash = await rt.executeTool('engine_team', { action: 'candidate_approve', teamId: team.id, candidateId: candAB.id, purpose: 'local_publish', branchName: 'dsh-crash' }, execCtx);
    await assert.rejects(
      () => rt.engine.publishCandidateLocal(team.id, { candidateId: candAB.id, approvalId: appCrash.id, _testCrashAfterGitUpdateRef: true }),
      err => err.code === 'SIMULATED_CRASH_AFTER_GIT_UPDATE_REF',
    );
    const rec = await rt.executeTool('engine_team', { action: 'publish_reconcile', teamId: team.id }, execCtx);
    assert.equal(rec.results[0].outcome, 'confirmed_recovered');
    assert.equal(rec.results[0].receipt.remoteMerged, false);

    // R5: 提交基于 candAB 的集成修订 R1 -> 增量与全量重放同树；用 A2 替换 A1 -> old.txt 消失
    const subR1 = await rt.executeTool('engine_submit', {
      requestId: 'dsh-r1',
      teamId: team.id,
      memberId: mA,
      title: 'Integration Fix R1',
      goal: 'Fix interface between A and B',
      revisionOfCandidateId: candAB.id,
      affectedTaskIds: [a1Done.id, bDone.id],
      writeScopes: ['a.txt', 'b.txt'],
      checks: [{ type: 'file_contains', path: 'a.txt', value: 'a-fixed' }],
    }, execCtx);
    const r1Done = await waitForState(rt.engine, subR1.taskId, 'checked');
    await rt.executeTool('engine_control', { taskId: r1Done.id, action: 'accept', expectedRevision: r1Done.revision, reason: 'Accept R1' }, execCtx);
    const c2 = (await rt.executeTool('engine_team', { action: 'candidate_create', teamId: team.id, parentCandidateId: candAB.id, taskIds: [a1Done.id, bDone.id, r1Done.id] }, execCtx)).candidate;
    assert.equal(c2.assemblyMode, 'incremental_revision');
    assert.equal(c2.treeOid, c2.replayTreeVerified);

    const subA2 = await rt.executeTool('engine_submit', {
      requestId: 'dsh-a2',
      teamId: team.id,
      memberId: mA,
      title: 'Task A2',
      goal: 'Create new.txt only',
      writeScopes: ['new.txt'],
      checks: [{ type: 'file_contains', path: 'new.txt', value: 'new-only' }],
    }, execCtx);
    const a2Done = await waitForState(rt.engine, subA2.taskId, 'checked');
    await rt.executeTool('engine_control', { taskId: a2Done.id, action: 'accept', expectedRevision: a2Done.revision, reason: 'Accept A2' }, execCtx);
    const c3 = (await rt.executeTool('engine_team', { action: 'candidate_create', teamId: team.id, parentCandidateId: candAB.id, taskIds: [a2Done.id, bDone.id] }, execCtx)).candidate;
    assert.equal(c3.assemblyMode, 'full_replay');
    const c3Files = execFileSync('git', ['ls-tree', '-r', '--name-only', c3.commitOid], { cwd: repoDir, encoding: 'utf8' });
    assert.match(c3Files, /new\.txt/);
    assert.doesNotMatch(c3Files, /old\.txt/);

    // R6: 基线前进冲突对账
    const subCfg = await rt.executeTool('engine_submit', {
      requestId: 'dsh-cfg',
      teamId: team.id,
      memberId: mB,
      title: 'Task Config',
      goal: 'Change config.txt to x=2',
      writeScopes: ['config.txt'],
      checks: [{ type: 'file_contains', path: 'config.txt', value: 'x=2' }],
    }, execCtx);
    const cfgDone = await waitForState(rt.engine, subCfg.taskId, 'checked');
    await rt.executeTool('engine_control', { taskId: cfgDone.id, action: 'accept', expectedRevision: cfgDone.revision, reason: 'Accept cfg' }, execCtx);
    const candCfg = (await rt.executeTool('engine_team', { action: 'candidate_create', teamId: team.id, taskIds: [cfgDone.id] }, execCtx)).candidate;
    fs.writeFileSync(path.join(repoDir, 'config.txt'), 'x=1\n', 'utf8');
    execFileSync('git', ['add', 'config.txt'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'main conflict'], { cwd: repoDir, stdio: 'pipe' });
    const drift = await rt.executeTool('engine_team', { action: 'candidate_base_drift', teamId: team.id, candidateId: candCfg.id, targetRef: 'refs/heads/main' }, execCtx);
    assert.equal(drift.ok, false);
    assert.equal(drift.status, 'integration_conflict');
    assert.deepEqual(drift.conflictPaths, ['config.txt']);

    // R7 + R8: 只读 PR 关联（squash 合入差异 + 关闭且删 marker 连续恢复两次零写请求）
    const statesSeen = [];
    const transport = {
      async getPullRequest({ prNumber }) {
        return {
          number: prNumber, title: 'Merged B', url: 'https://github.com/org/repo/pull/7',
          state: 'closed', merged: true, merge_commit_sha: 'd'.repeat(40),
          head: { sha: 'e'.repeat(40), ref: 'superagent/dsh-crash', repo: { full_name: 'org/repo' } },
          base: { ref: 'main', repo: { full_name: 'org/repo' } }, body: 'No marker',
        };
      },
      async listPullRequests({ state }) {
        statesSeen.push(state);
        return [{
          number: 7, title: 'Closed without marker', url: 'https://github.com/org/repo/pull/7',
          state: 'closed', merged: false,
          head: { sha: candAB.commitOid, ref: 'superagent/dsh-crash', repo: { full_name: 'org/repo' } },
          base: { ref: 'main', repo: { full_name: 'org/repo' } }, body: 'Deleted marker',
        }];
      },
      async listCheckRuns() { return []; },
    };
    const r7 = await rt.engine.reconcileGitHubPr(team.id, { repo: 'org/repo', prNumber: 7, candidateId: candAB.id, transport });
    assert.equal(r7.observation.remoteMerged, true);
    assert.equal(r7.observation.versionMismatch, true);
    assert.equal(r7.observation.localFacts.effectiveGoalPassed, false);
    assert.equal(r7.observation.writeRequestsMade, 0);

    const r8a = await rt.engine.reconcileGitHubPr(team.id, { repo: 'org/repo', headBranch: 'superagent/dsh-crash', baseBranch: 'main', expectedIntentId: 'lost-7', candidateId: candAB.id, transport });
    const r8b = await rt.engine.reconcileGitHubPr(team.id, { repo: 'org/repo', headBranch: 'superagent/dsh-crash', baseBranch: 'main', expectedIntentId: 'lost-7', candidateId: candAB.id, linkId: r8a.link.id, transport });
    assert.ok(statesSeen.every(s => s === 'all'));
    assert.equal(r8a.observation.status, 'unknown');
    assert.equal(r8b.observation.status, 'unknown');
    assert.equal(r8a.observation.writeRequestsMade + r8b.observation.writeRequestsMade, 0);
    assert.ok(baseCommit.length >= 40);
  } finally {
    await rt.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
