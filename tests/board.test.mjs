import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execute } from '../packages/super-teams/src/board/board.mjs';

const temp = process.env.SUPER_TEAMS_TEST_ROOT || os.tmpdir();
fs.mkdirSync(temp, { recursive: true });
function setup() {
  const workspace = fs.mkdtempSync(path.join(temp, 'board-'));
  const team = execute('teams_create', { workspace, title: 'Test project', request_id: randomUUID() });
  const common = { workspace, team_id: team.team_id };
  const read = extra => execute('teams_read', { ...common, ...extra });
  const change = (name, extra = {}) => execute(name, { ...common, expected_revision: read().revision, request_id: randomUUID(), ...extra });
  const create = (extra = {}) => change('teams_task_create', { subject: 'Task', acceptance: 'A verifiable result', ...extra }).task;
  const update = (task, action, extra = {}) => change('teams_task_update', { task_id: task.id, action, ...extra });
  return { workspace, common, read, change, create, update };
}

test('dependencies, current evidence and acceptance criteria control completion', () => {
  const h = setup(), first = h.create({ subject: 'Implement' }), second = h.create({ blocked_by: [first.id] });
  assert.throws(() => h.update(second, 'claim', { owner: 'worker-2' }), /not ready/);
  h.update(first, 'claim', { owner: 'worker-1' });
  assert.throws(() => h.update(first, 'complete'), /checkpoint/);
  assert.throws(() => h.update(first, 'checkpoint', { outcome: 'ready', summary: 'done', evidence: [] }), /evidence/);
  h.update(first, 'checkpoint', { outcome: 'ready', summary: 'done', evidence: ['test: passed'] });
  h.update(first, 'edit', { acceptance: 'New acceptance criterion' });
  assert.throws(() => h.update(first, 'complete'), /checkpoint/);
  h.update(first, 'checkpoint', { task_version: 2, outcome: 'ready', summary: 'new criterion tested', evidence: ['test 2: passed'] });
  h.update(first, 'complete');
  assert.equal(h.read({ task_id: second.id }).tasks[0].ready, true);
  h.update(second, 'claim', { owner: 'worker-2' });
  assert.throws(() => h.update(first, 'reopen'), /dependents/);
});

test('dependency cycles and unknown references roll back completely', () => {
  const h = setup(), a = h.create(), b = h.create({ blocked_by: [a.id] });
  const before = h.read({ task_id: a.id });
  assert.throws(() => h.update(a, 'edit', { blocked_by: [b.id] }), /CYCLE/);
  assert.throws(() => h.update(a, 'edit', { blocked_by: ['missing'] }), /not found/);
  assert.deepEqual(h.read({ task_id: a.id }), before);
});

test('retry after lost response is idempotent and rejects reused IDs with changed arguments', () => {
  const h = setup();
  const args = { ...h.common, subject: 'once', acceptance: 'one task only', expected_revision: h.read().revision, request_id: randomUUID() };
  const first = execute('teams_task_create', args);
  h.create();
  const retry = execute('teams_task_create', args);
  assert.equal(retry.replayed, true); assert.equal(retry.task.id, first.task.id);
  assert.equal(h.read().total, 2);
  assert.throws(() => execute('teams_task_create', { ...args, subject: 'different' }), /REUSED/);
});

test('two separate processes cannot both commit a stale team revision', async () => {
  const h = setup(), revision = h.read().revision;
  const module = new URL('../packages/super-teams/src/board/board.mjs', import.meta.url).href;
  const launch = async subject => {
    const args = { ...h.common, expected_revision: revision, request_id: randomUUID(), subject, acceptance: 'valid' };
    const code = `import {execute} from ${JSON.stringify(module)};try{execute('teams_task_create',${JSON.stringify(args)});console.log('committed')}catch(e){console.log(e.message)}`;
    return (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code])).stdout;
  };
  const results = await Promise.all([launch('one'), launch('two')]);
  assert.equal(results.filter(x => x.includes('committed')).length, 1);
  assert.equal(results.filter(x => x.includes('STALE_REVISION')).length, 1);
  assert.equal(h.read().total, 1);
});

test('inactive and stale observations remain snapshots and never complete work', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'actual-id-1' });
  h.change('teams_observe', { agent_id: 'actual-id-1', status: 'running', observed_at: new Date(Date.now() - 180000).toISOString(), source: 'native list_agents fixture' });
  assert(h.read().tasks[0].issues.includes('runtime_observation_stale'));
  h.change('teams_observe', { agent_id: 'actual-id-1', status: 'inactive', observed_at: new Date().toISOString(), source: 'native list_agents fixture' });
  assert(h.read().tasks[0].issues.includes('owner_needs_check'));
  assert.equal(h.read().tasks[0].status, 'in_progress');
  assert.throws(() => h.change('teams_observe', { agent_id: 'actual-id-1', status: 'running', observed_at: '2000-01-01', source: 'older snapshot' }), /older/);
});

test('scope overlaps warn without pretending to lock files; release requires stopped writes', () => {
  const h = setup(), a = h.create({ write_scopes: ['src/UI'] }), b = h.create({ write_scopes: ['src/ui/button.js'] });
  h.update(a, 'claim', { owner: 'a' }); h.update(b, 'claim', { owner: 'b' });
  assert(h.read().tasks.every(task => task.issues.includes('write_scope_overlap')));
  assert.throws(() => h.update(a, 'release'), /stopped/);
  h.update(a, 'release', { stopped: true });
  assert.equal(h.read().tasks[0].owner, '');
  for (const write_scopes of [['../escape'], ['C:/elsewhere'], ['src/*'], ['/etc']]) assert.throws(() => h.create({ write_scopes }), /relative/);
});

test('board reads are compact, detailed on request, and survive database reopening', () => {
  const h = setup(), task = h.create(); h.create();
  const compact = h.read({ limit: 1 });
  assert.equal(compact.next_cursor, 1); assert.equal(compact.tasks[0].acceptance, undefined);
  assert.equal(h.read({ task_id: task.id }).tasks[0].acceptance, 'A verifiable result');
  assert.equal(h.read({ history: true }).history.length, 3);
  assert.equal(h.read({ cursor: 1 }).tasks.length, 1);
});

test('read and unknown-tool failures do not create workspace state', () => {
  const workspace = fs.mkdtempSync(path.join(temp, 'empty-'));
  assert.throws(() => execute('teams_read', { workspace }), /No team board/);
  assert.throws(() => execute('unknown', { workspace }), /Unknown/);
  assert.equal(fs.existsSync(path.join(workspace, '.super-teams')), false);
});

function readyResult(task, extra = {}) {
  return { task_id: task.id, task_version: 1, outcome: 'ready', summary: 'Verified implementation',
    artifacts: [{ ref: 'outputs/result.txt', version: 'sha256:fixture' }],
    checks: [{ name: 'regression', status: 'passed', evidence: 'work/test.log: all passed' }],
    review: 'self', risks: [], ...extra };
}
const packet = (h, task) => execute('teams_task_packet', { ...h.common, task_id: task.id });

test('structured acceptance requires passed checks tied to exact submitted artifact versions', () => {
  const h = setup(), criteria = [{ id: 'title', description: 'Preserve title' }, { id: 'source', description: 'Verify source' }];
  const task = h.create({ criteria }); const claim = h.update(task, 'claim', { owner: 'coverage-worker' });
  assert.deepEqual(claim.packet.criteria, criteria);
  const artifact = { ref: 'outputs/result.txt', version: 'sha256:fixture' };
  const check = { name: 'Title and source', status: 'passed', evidence: 'detail-coverage-check-marker', criterion_ids: ['title', 'source'], artifacts: [artifact] };
  for (const invalid of [
    { ...check, criterion_ids: ['title'] }, { ...check, criterion_ids: ['unknown'] },
    { ...check, criterion_ids: ['title', 'title'] }, { ...check, artifacts: [] },
    { ...check, artifacts: [{ ...artifact, version: 'old-version' }] },
    { ...check, artifacts: [{ ...artifact, ref: 'missing.txt' }] }, { ...check, artifacts: [{ ref: artifact.ref }] },
  ]) assert.throws(() => h.change('teams_submit_result', readyResult(task, { checks: [invalid] })), /coverage|criterion|artifact|version/i);
  assert.throws(() => h.change('teams_submit_result', readyResult(task)), /coverage/i);
  h.change('teams_submit_result', readyResult(task, { checks: [check] }));
  assert.deepEqual(packet(h, task).result.coverage, { required: 2, passed: 2, missing: 0, missing_ids: [] });
  const split = [{ ...check, criterion_ids: ['title'] }, { ...check, name: 'Title repeat and source', criterion_ids: ['title', 'source'] }];
  h.change('teams_submit_result', readyResult(task, { checks: split }));
  assert.equal(packet(h, task).result.coverage.passed, 2);
  h.change('teams_submit_result', readyResult(task, { outcome: 'blocked', next: 'Run source verification',
    checks: [{ ...check, criterion_ids: ['title'] }, { ...check, status: 'failed', criterion_ids: ['source'] }, { ...check, status: 'not_run', criterion_ids: ['source'] }] }));
  const coverage = { required: 2, passed: 1, missing: 1, missing_ids: ['source'] };
  assert.deepEqual(packet(h, task).result.coverage, coverage);
  assert.deepEqual(h.read({ view: 'overview', task_id: task.id }).tasks[0].coverage, coverage);
  const compact = h.read({ view: 'results', task_id: task.id });
  assert.deepEqual(compact.tasks[0].result.coverage, coverage);
  assert.equal(JSON.stringify(compact).includes('detail-coverage-check-marker'), false);
  const detail = h.read({ task_id: task.id }).tasks[0].result;
  assert.deepEqual(detail.checks[0].criterion_ids, ['title']); assert.deepEqual(detail.checks[0].artifacts, [artifact]);
  assert.equal(detail.checks[0].evidence, 'detail-coverage-check-marker');
});

test('criteria changes invalidate results and structured completion cannot use a legacy checkpoint or forged coverage count', () => {
  const h = setup(), task = h.create({ criteria: [{ id: 'a', description: 'Verify a' }] }); h.update(task, 'claim', { owner: 'versioned-coverage' });
  assert.throws(() => h.update(task, 'checkpoint', { outcome: 'ready', summary: 'Legacy shortcut', evidence: ['work/old.log'] }), /submit_result/);
  h.update(task, 'checkpoint', { outcome: 'progress', summary: 'Work saved', next: 'Run verification' });
  h.update(task, 'checkpoint', { outcome: 'blocked', summary: 'Need input', next: 'Provide input' });
  const legacyDb = new DatabaseSync(path.join(h.workspace, '.super-teams', 'teams.sqlite'));
  const legacyTeam = JSON.parse(legacyDb.prepare('SELECT document FROM teams WHERE id=?').get(h.common.team_id).document);
  legacyTeam.tasks[0].checkpoint.outcome = 'ready';
  legacyDb.prepare('UPDATE teams SET document=? WHERE id=?').run(JSON.stringify(legacyTeam), h.common.team_id); legacyDb.close();
  assert.throws(() => h.update(task, 'complete'), /submit_result|coverage/);
  const result = readyResult(task, { checks: [{ name: 'Acceptance a', status: 'passed', evidence: 'work/a.log:1', criterion_ids: ['a'], artifacts: [{ ref: 'outputs/result.txt', version: 'sha256:fixture' }] }] });
  h.change('teams_submit_result', result);
  h.update(task, 'edit', { criteria: [{ id: 'b', description: 'Verify current b' }] });
  assert.equal(packet(h, task).task_version, 2); assert.equal(packet(h, task).result, null);
  assert.throws(() => h.change('teams_submit_result', result), /STALE_TASK_VERSION/);
  assert.throws(() => h.update(task, 'complete'), /checkpoint|coverage/i);
  h.change('teams_submit_result', { ...result, task_version: 2, checks: [{ ...result.checks[0], criterion_ids: ['b'] }] });
  const db = new DatabaseSync(path.join(h.workspace, '.super-teams', 'teams.sqlite'));
  const team = JSON.parse(db.prepare('SELECT document FROM teams WHERE id=?').get(h.common.team_id).document);
  team.tasks[0].result.checks[0].criterion_ids = [];
  db.prepare('UPDATE teams SET document=? WHERE id=?').run(JSON.stringify(team), h.common.team_id); db.close();
  assert.throws(() => h.update(task, 'complete'), /coverage/i);
  h.change('teams_submit_result', { ...result, task_version: 2, checks: [{ ...result.checks[0], criterion_ids: ['b'] }] });
  h.update(task, 'complete'); assert.equal(packet(h, task).status, 'completed');
});

test('criteria and explicit mappings validate without changing legacy checkpoint and result paths', () => {
  const h = setup();
  for (const criteria of [[{ id: '', description: 'Empty id' }], [{ id: 'same', description: 'a' }, { id: 'same', description: 'b' }],
    [{ id: 'a', description: '' }], Array.from({ length: 13 }, (_, n) => ({ id: String(n), description: 'Too many' }))]) {
    assert.throws(() => h.create({ criteria }), /criteria|criterion/i);
  }
  const legacy = h.create(); h.update(legacy, 'claim', { owner: 'legacy-coverage' });
  assert.deepEqual(packet(h, legacy).criteria, []);
  const mapped = { name: 'Legacy explicit map', status: 'passed', evidence: 'work/legacy.log', artifacts: [{ ref: 'outputs/result.txt', version: 'invalid' }] };
  assert.throws(() => h.change('teams_submit_result', readyResult(legacy, { checks: [mapped] })), /artifact/i);
  assert.throws(() => h.change('teams_submit_result', readyResult(legacy, { checks: [{ ...mapped, artifacts: [], criterion_ids: ['unknown'] }] })), /criterion/i);
  h.change('teams_submit_result', readyResult(legacy)); h.update(legacy, 'complete');
  const checkpoint = h.create(); h.update(checkpoint, 'claim', { owner: 'legacy-checkpoint' });
  h.update(checkpoint, 'checkpoint', { outcome: 'ready', summary: 'Legacy evidence', evidence: ['work/legacy.log'] });
  h.update(checkpoint, 'complete');
});

test('claim returns the complete transaction packet while replay preserves its historical input', t => {
  const clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const h = setup(), dependency = h.create({ subject: 'Accepted upstream' });
  const initialClaim = h.update(dependency, 'claim', { owner: 'packet-worker' });
  assert.equal(initialClaim.packet.task_id, dependency.id);
  const result = h.change('teams_submit_result', readyResult(dependency, { risks: ['Report only; parent verifies artifacts'] }));
  assert.equal(result.packet, undefined);
  assert.equal(h.update(dependency, 'complete').packet, undefined);
  const context = { inputs: [{ ref: 'work/spec.md', version: 'v6' }], constraints: ['Keep original title', 'Do not publish'], skills: ['$SuperAgent'] };
  const created = h.change('teams_task_create', { subject: 'Full current input', acceptance: 'Verify title and source',
    context, blocked_by: [dependency.id], write_scopes: ['src/title.mjs'] });
  assert.equal(created.packet, undefined);
  const task = created.task;
  assert.equal(h.change('teams_observe', { agent_id: 'packet-worker', status: 'running', observed_at: new Date(clock).toISOString(), source: 'native fixed snapshot' }).packet, undefined);
  const args = { ...h.common, task_id: task.id, action: 'claim', owner: 'packet-worker', expected_revision: h.read().revision, request_id: randomUUID() };
  const claimed = execute('teams_task_update', args);
  assert.deepEqual(claimed.packet, packet(h, task));
  assert.equal(claimed.packet.revision, claimed.revision);
  assert.equal(claimed.packet.status, 'in_progress'); assert.equal(claimed.packet.owner, 'packet-worker');
  assert.equal(claimed.packet.can_dispatch, false); assert.equal(claimed.packet.acceptance, 'Verify title and source');
  assert.deepEqual(claimed.packet.context, context); assert.deepEqual(claimed.packet.write_scopes, ['src/title.mjs']);
  assert.equal(claimed.packet.dependencies[0].result.artifacts[0].ref, 'outputs/result.txt');
  assert.deepEqual(claimed.packet.dependencies[0].result.risks, ['Report only; parent verifies artifacts']);
  assert.equal(claimed.packet.result_contract.task_version, claimed.packet.task_version);
  assert.equal(claimed.packet.runtime_observation.status, 'running');
  assert.match(claimed.affected_tasks[0].next, /included packet/i);
  const edit = h.update(task, 'edit', { acceptance: 'Revised input after claim' });
  assert.equal(edit.packet, undefined);
  const replay = execute('teams_task_update', args);
  assert.equal(replay.replayed, true); assert.match(replay.next, /read.*current revision/i);
  assert.deepEqual(replay.packet, claimed.packet);
  assert.equal(replay.packet.task_version, 1); assert.equal(packet(h, task).task_version, 2);
  assert.equal(replay.packet.acceptance, 'Verify title and source');
  assert.equal(h.update(task, 'release', { stopped: true }).packet, undefined);
});

test('fresh running cannot hide 20m36s without progress or an overdue delivered instruction', t => {
  let clock = Date.now() - 1236000; t.mock.method(Date, 'now', () => clock);
  const h = setup(), ordinary = h.create(), task = h.create(); h.update(task, 'claim', { owner: 'waiting-worker' });
  const first = new Date(clock).toISOString(), deadline = new Date(clock + 60000).toISOString();
  const observe = extra => h.change('teams_observe', { task_id: task.id, task_version: 1, agent_id: 'waiting-worker',
    status: 'running', observed_at: new Date(clock).toISOString(), source: 'native original-call-17', ...extra });
  observe({ progress: { at: first, summary: 'Last saved edit', evidence: ['work/edit.log:1'] },
    instruction: { id: 'instruction-17', state: 'delivered', evidence: [] } });
  assert.equal(packet(h, task).next_action.action, 'schedule_recheck');
  observe({ recheck: { at: deadline, reason: 'Check original call-17', next_owner: 'parent', evidence: ['detail-recheck-only-marker'] } });
  assert.equal(packet(h, task).next_action.action, 'await_running_owner');
  clock += 1236000;
  assert.equal(packet(h, task).next_action.action, 'verify_native_status');
  observe({ instruction: { id: 'instruction-17', state: 'delivered', evidence: [] } });
  const p = packet(h, task);
  assert.equal(p.runtime_observation.fresh, true); assert.equal(p.observation.progress_age_seconds, 1236);
  assert.equal(p.observation.instruction.first_delivered_at, first);
  assert.equal(p.observation.recheck.scheduled_at, first);
  assert.equal(p.next_action.action, 'verify_instruction_application');
  assert.equal(p.next_action.deadline, deadline); assert.equal(p.next_action.next_owner, 'parent');
  assert.match(p.next_action.instruction, /call.*side effects/i);
  const overview = h.read({ view: 'overview', limit: 1 });
  assert.equal(overview.tasks[0].id, task.id); assert.equal(overview.overview_counts.recheck_due, 1);
  assert.equal(h.read().tasks.find(row => row.id === ordinary.id).status, 'pending');
  for (const compact of [p, h.read().tasks.find(row => row.id === task.id), overview.tasks[0]]) {
    assert.equal(compact.observation.recheck.evidence_count, 1);
    assert.equal(JSON.stringify(compact).includes('detail-recheck-only-marker'), false);
  }
  assert.deepEqual(h.read({ task_id: task.id }).tasks[0].observation.recheck.evidence, ['detail-recheck-only-marker']);
  observe({ status: 'unknown' });
  assert.equal(packet(h, task).next_action.action, 'verify_native_status');
  observe({ control: { state: 'paused', evidence: ['chat:pause'] } });
  h.change('teams_submit_result', readyResult(task));
  assert.equal(packet(h, task).next_action.action, 'wait_for_user_resume');
  assert.equal(h.read({ view: 'overview' }).overview_counts.recheck_due, 0);
  observe({ control: { state: 'resumed', evidence: ['chat:resume'] } });
  assert.equal(packet(h, task).next_action.action, 'accept_result');
  h.update(task, 'complete');
  assert.equal(packet(h, task).next_action.action, 'none');
  assert.equal(h.read({ view: 'overview' }).overview_counts.recheck_due, 0);
});

test('recheck extension requires a later observation and new diagnostic evidence; delivery never downgrades application', t => {
  let clock = Date.now() - 10000; t.mock.method(Date, 'now', () => clock);
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'downloader' });
  const first = new Date(clock).toISOString(), initial = new Date(clock + 30000).toISOString();
  const observe = extra => h.change('teams_observe', { task_id: task.id, task_version: 1, agent_id: 'downloader', status: 'running',
    observed_at: new Date(clock).toISOString(), source: 'native download-12', ...extra });
  const recheck = { at: initial, reason: 'Download pending', next_owner: 'parent', evidence: ['work/download.log:1'] };
  observe({ wait: { reason: 'tool', next: 'Inspect download-12', next_owner: 'parent' }, recheck,
    instruction: { id: 'download-12', state: 'delivered', evidence: [] } });
  const later = new Date(clock + 90000).toISOString();
  assert.throws(() => observe({ recheck: { ...recheck, at: later, evidence: ['work/new.log:2'] } }), /later observation/);
  clock += 1000;
  observe({ instruction: { id: 'download-12', state: 'delivered', evidence: [] } });
  assert.equal(packet(h, task).observation.recheck.at, initial);
  assert.equal(packet(h, task).observation.instruction.first_delivered_at, first);
  assert.throws(() => observe({ recheck: { ...recheck, at: later } }), /new evidence/);
  observe({ recheck: { ...recheck, at: later, evidence: [...recheck.evidence, 'work/download-bytes.log:2'] } });
  assert.equal(packet(h, task).observation.recheck.at, later);
  for (const at of [later, initial]) {
    assert.throws(() => observe({ recheck: { ...recheck, at } }), /retain prior evidence/);
  }
  assert.equal(packet(h, task).observation.recheck.at, later);
  assert.equal(packet(h, task).observation.recheck.evidence_count, 2);
  assert.equal(packet(h, task).next_action.action, 'wait_for_tool');
  assert.throws(() => observe({ recheck: null }), /clear recheck/);
  observe({ instruction: { id: 'download-12', state: 'applied', evidence: ['outputs/download.zip:sha256'] }, recheck: null });
  assert.equal(packet(h, task).observation.recheck, null);
  assert.equal(packet(h, task).observation.instruction.first_delivered_at, first);
  observe({ instruction: { id: 'download-12', state: 'delivered', evidence: [] } });
  assert.equal(packet(h, task).observation.instruction.state, 'applied');
  assert.deepEqual(h.read({ task_id: task.id }).tasks[0].observation.instruction.evidence, ['outputs/download.zip:sha256']);
  clock += 1000;
  observe({ instruction: { id: 'new-input', state: 'delivered', evidence: [] } });
  assert.equal(packet(h, task).observation.instruction.first_delivered_at, new Date(clock).toISOString());
  observe({ recheck });
  clock += 60000; observe({});
  assert.equal(packet(h, task).next_action.action, 'verify_instruction_application');
  h.update(task, 'edit', { acceptance: 'Current version' });
  assert.equal(packet(h, task).observation, null);
  assert.throws(() => observe({ recheck }), /STALE_TASK_VERSION/);
});

test('recheck validation, explicit clearing, uncertain native status and ownership preserve existing guards', t => {
  let clock = Date.now() - 5000; t.mock.method(Date, 'now', () => clock);
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'bounded-worker' });
  const observe = extra => h.change('teams_observe', { task_id: task.id, task_version: 1, agent_id: 'bounded-worker', status: 'running',
    observed_at: new Date(clock).toISOString(), source: 'native bounded-call', ...extra });
  const recheck = { at: new Date(clock + 60000).toISOString(), reason: 'Check call', next_owner: 'parent', evidence: ['work/call.log:1'] };
  for (const fields of [{ at: 'invalid' }, { at: new Date(clock).toISOString() }, { reason: '' }, { next_owner: '' }, { evidence: [] }]) {
    assert.throws(() => observe({ recheck: { ...recheck, ...fields } }), /recheck/);
  }
  assert.throws(() => observe({ task_version: undefined, recheck }), /task_version/);
  assert.throws(() => observe({ agent_id: 'other-owner', recheck }), /owner/);
  observe({ recheck: null });
  observe({ recheck });
  assert.throws(() => observe({ recheck: null, progress: { at: new Date(clock - 1000).toISOString(), summary: 'Historical action reported late', evidence: ['work/history.log:1'] } }), /clear recheck/);
  observe({ recheck, progress: { at: new Date(clock - 1000).toISOString(), summary: 'Saved state', evidence: ['work/edit.log:1'] },
    wait: { reason: 'tool', next: 'Wait for call', next_owner: 'parent' } });
  observe({ status: 'unknown' });
  assert.equal(packet(h, task).next_action.action, 'verify_native_status');
  assert.throws(() => observe({ recheck: null, progress: { at: new Date(clock - 1000).toISOString(), summary: 'Same action', evidence: ['work/edit.log:1'] } }), /clear recheck/);
  clock += 1;
  observe({ recheck: null, progress: { at: new Date(clock).toISOString(), summary: 'New saved action', evidence: ['work/edit.log:2'] } });
  assert.equal(packet(h, task).observation.recheck, null);
  observe({ instruction: { id: 'old-applied', state: 'applied', evidence: ['work/applied.log:1'] }, recheck });
  assert.throws(() => observe({ instruction: { id: 'old-applied', state: 'applied', evidence: ['work/applied.log:1'] }, recheck: null }), /clear recheck/);
  observe({ instruction: { id: 'old-applied', state: 'applied', evidence: ['work/applied.log:1', 'work/applied.log:2'] }, recheck: null });
  assert.equal(packet(h, task).observation.recheck, null);
  observe({ recheck });
  observe({ instruction: { id: 'new-applied', state: 'applied', evidence: ['work/applied.log:1'] }, recheck: null });
  assert.equal(packet(h, task).observation.recheck, null);
  observe({ recheck });
  observe({ recheck: null, control: { state: 'paused', evidence: ['chat:pause'] } });
  observe({ control: { state: 'resumed', evidence: ['chat:resume'] }, recheck });
  assert.throws(() => observe({ control: { state: 'resumed', evidence: ['chat:resume'] }, recheck: null }), /clear recheck/);
  observe({ control: { state: 'resumed', evidence: ['chat:resume', 'chat:new-authorization'] }, recheck: null });
  assert.equal(packet(h, task).observation.recheck, null);
  observe({ recheck });
  h.change('teams_submit_result', readyResult(task));
  observe({ recheck: null });
  assert.equal(packet(h, task).next_action.action, 'accept_result');
  observe({ instruction: { id: 'applied-first', state: 'applied', evidence: ['outputs/current.txt:1'] } });
  assert.equal(packet(h, task).observation.instruction.first_delivered_at, null);
  clock += 1000;
  observe({ instruction: { id: 'applied-first', state: 'delivered', evidence: [] } });
  assert.equal(packet(h, task).observation.instruction.state, 'applied');
  assert.equal(packet(h, task).observation.instruction.first_delivered_at, null);
  h.update(task, 'release', { stopped: true });
  h.update(task, 'claim', { owner: 'replacement' });
  assert.equal(packet(h, task).observation.recheck, undefined);
});

test('task observations isolate progress from owner liveness, preserve increments and reject stale evidence', () => {
  const h = setup(), a = h.create(), b = h.create();
  for (const task of [a, b]) h.update(task, 'claim', { owner: 'shared-owner' });
  const at = new Date(Date.now() - 180000).toISOString(), observed_at = new Date(Date.now() - 2000).toISOString();
  const observe = extra => h.change('teams_observe', { agent_id: 'shared-owner', status: 'running', observed_at,
    source: 'native fixture', task_id: a.id, task_version: 1, ...extra });
  observe({ progress: { at, summary: 'Saved actual edit', evidence: ['work/edit.log:4'] },
    instruction: { id: 'req-1', state: 'delivered', evidence: [] } });
  assert.equal(packet(h, a).observation.progress.at, at);
  assert.equal(packet(h, b).observation, null);
  observe({ progress: { at, summary: 'Same action, supplemented evidence', evidence: ['work/edit.log:4', 'work/review.log:2'] } });
  assert.equal(packet(h, a).observation.progress.at, at);
  assert.equal(packet(h, a).observation.progress.evidence_count, 2);
  assert.equal(h.read({ task_id: a.id }).tasks[0].observation.progress.evidence.length, 2);
  h.change('teams_observe', { agent_id: 'shared-owner', status: 'running', observed_at, source: 'native fixture', task_id: b.id, task_version: 1 });
  h.change('teams_observe', { agent_id: 'shared-owner', status: 'running', observed_at, source: 'native fixture', task_id: b.id, task_version: 1,
    progress: { at, summary: 'Supplement saved action at the same observation time', evidence: ['work/b.log:1'] } });
  assert.equal(packet(h, b).observation.progress.summary, 'Supplement saved action at the same observation time');
  assert.equal(packet(h, a).observation.progress.summary, 'Same action, supplemented evidence');
  h.change('teams_observe', { agent_id: 'shared-owner', status: 'running', observed_at: new Date().toISOString(), source: 'legacy call' });
  assert.equal(packet(h, a).observation.progress.at, at);
  assert(packet(h, a).observation.progress_age_seconds >= 180);
  assert(packet(h, a).runtime_observation.age_seconds < 10);
  assert.equal(h.read({ view: 'overview', task_id: a.id }).tasks[0].observation.instruction.state, 'delivered');
  const current = new Date().toISOString();
  assert.throws(() => observe({ observed_at: current, instruction: { id: 'req-1', state: 'applied', evidence: [] } }), /evidence/);
  assert.throws(() => observe({ observed_at: current, progress: { at: current, summary: 'Unsupported claim', evidence: [] } }), /evidence/);
  assert.throws(() => observe({ observed_at: current, progress: { at: '2000-01-01', summary: 'old', evidence: [] } }), /older/);
  assert.throws(() => observe({ observed_at: current, progress: { at: new Date(Date.now() + 4000).toISOString(), summary: 'future', evidence: [] } }), /progress.at/);
  assert.throws(() => observe({ task_version: 2, observed_at: current }), /STALE_TASK_VERSION/);
  assert.throws(() => observe({ task_version: undefined, observed_at: current }), /task_version/);
  assert.throws(() => observe({ agent_id: 'wrong-owner', observed_at: current }), /owner/);
  observe({ observed_at: current, instruction: { id: 'req-1', state: 'applied', evidence: ['outputs/result.txt:12'] },
    wait: { reason: 'review', next: 'Verify saved result', next_owner: 'parent' } });
  assert.equal(packet(h, a).next_action.action, 'schedule_recheck');
  assert.equal(packet(h, a).next_action.next_owner, 'parent');
  observe({ observed_at: new Date().toISOString(), wait: null });
  assert.equal(packet(h, a).observation.wait, null);
  assert.equal(packet(h, a).observation.instruction.state, 'applied');
  h.update(a, 'edit', { acceptance: 'Changed criterion' });
  assert.equal(packet(h, a).observation, null);
  observe({ task_version: 2, observed_at: new Date().toISOString(), wait: { reason: 'tool', next: 'Wait for check output', next_owner: 'shared-owner' } });
  assert.equal(packet(h, a).next_action.action, 'schedule_recheck');
  h.update(a, 'checkpoint', { task_version: 2, outcome: 'ready', summary: 'Checks returned', evidence: ['work/check.log:2'] });
  assert.equal(packet(h, a).observation.wait.reason, 'tool');
  assert.equal(packet(h, a).next_action.action, 'accept_result');
  h.change('teams_submit_result', readyResult(a, { task_version: 2, outcome: 'failed', error: 'Check failed', next: 'Fix check' }));
  assert.equal(packet(h, a).next_action.action, 'resolve_failure');
  h.update(a, 'checkpoint', { task_version: 2, outcome: 'blocked', summary: 'Need user input', next: 'Provide input' });
  assert.equal(packet(h, a).next_action.action, 'resolve_blocker');
});

test('pause survives results, edits, release, reassignment and dependency invalidation until explicit resume', () => {
  const h = setup(), upstream = h.create(), task = h.create();
  h.update(task, 'claim', { owner: 'old-owner' });
  const observe = extra => h.change('teams_observe', { task_id: task.id, task_version: packet(h, task).task_version,
    agent_id: packet(h, task).owner, status: 'running', observed_at: new Date().toISOString(), source: 'native fixture', ...extra });
  observe({ control: { state: 'paused', evidence: ['chat:user:pause-1'] },
    instruction: { id: 'old-input', state: 'applied', evidence: ['work/old.log:1'] } });
  h.change('teams_submit_result', readyResult(task));
  observe({});
  assert.equal(packet(h, task).next_action.action, 'wait_for_user_resume');
  assert.equal(packet(h, task).can_dispatch, false);
  assert.throws(() => h.update(task, 'complete'), /paused/i);
  h.update(task, 'edit', { acceptance: 'Revised while paused' });
  assert.equal(packet(h, task).observation.control.state, 'paused');
  assert.equal(packet(h, task).observation.instruction, undefined);
  h.update(task, 'release', { stopped: true });
  h.update(task, 'edit', { blocked_by: [upstream.id] });
  h.update(upstream, 'claim', { owner: 'source-owner' });
  h.change('teams_submit_result', readyResult(upstream)); h.update(upstream, 'complete');
  assert.equal(packet(h, task).observation.control.state, 'paused');
  assert.equal(packet(h, task).next_action.action, 'wait_for_user_resume');
  assert.throws(() => h.update(task, 'claim', { owner: 'new-owner' }), /paused/i);
  // Only control-only resume from the original control agent is allowed after release.
  assert.throws(() => h.change('teams_observe', { task_id: task.id, task_version: packet(h, task).task_version,
    agent_id: 'old-owner', status: 'inactive', observed_at: new Date().toISOString(), source: 'native',
    control: { state: 'resumed', evidence: ['chat:user:resume-1'] },
    instruction: { id: 'stale', state: 'applied', evidence: ['old.log'] } }), /owner/);
  h.change('teams_observe', { task_id: task.id, task_version: packet(h, task).task_version,
    agent_id: 'old-owner', status: 'inactive', observed_at: new Date().toISOString(), source: 'native',
    control: { state: 'resumed', evidence: ['chat:user:resume-1'] } });
  h.update(task, 'claim', { owner: 'new-owner' });
  assert.equal(packet(h, task).observation.owner, 'new-owner');
  assert.equal(packet(h, task).observation.instruction, undefined);
  assert.equal(packet(h, task).observation.control.state, 'resumed');
});

test('explicit user resume permits completion and task observe retains CAS and idempotency', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'worker' });
  const args = { ...h.common, expected_revision: h.read().revision, request_id: randomUUID(), task_id: task.id,
    task_version: 1, agent_id: 'worker', status: 'running', observed_at: new Date().toISOString(), source: 'native',
    progress: { at: new Date(Date.now() - 1000).toISOString(), summary: 'Saved action', evidence: ['detail-progress-only-marker'] },
    instruction: { id: 'compact-check', state: 'delivered', evidence: ['detail-instruction-only-marker'] },
    control: { state: 'paused', evidence: ['detail-control-only-marker'] } };
  execute('teams_observe', args);
  for (const compact of [packet(h, task), h.read().tasks[0], h.read({ view: 'overview' }).tasks[0]]) {
    assert.equal(compact.observation.progress.evidence_count, 1);
    assert.equal(compact.observation.instruction.evidence_count, 1);
    assert.equal(compact.observation.control.evidence_count, 1);
    assert.equal(compact.observation.progress.summary, 'Saved action');
    assert.equal(compact.observation.control.source, 'native');
    assert.equal(compact.observation.instruction.id, 'compact-check');
    assert.equal(JSON.stringify(compact).includes('only-marker'), false);
  }
  const detail = h.read({ task_id: task.id }).tasks[0].observation;
  for (const key of ['progress', 'instruction', 'control']) {
    assert.deepEqual(detail[key].evidence, args[key].evidence);
    assert.equal(detail[key].evidence_count, undefined);
  }
  assert.equal(execute('teams_observe', args).replayed, true);
  assert.throws(() => execute('teams_observe', { ...args, request_id: randomUUID() }), /STALE_REVISION/);
  h.change('teams_submit_result', readyResult(task));
  h.change('teams_observe', { ...args, expected_revision: h.read().revision, request_id: randomUUID(), observed_at: new Date().toISOString(),
    control: { state: 'resumed', evidence: ['chat:user:resume'] } });
  h.update(task, 'complete'); assert.equal(packet(h, task).status, 'completed');
});

test('task packets isolate context and completed dependency results without dispatching active owners', () => {
  const h = setup(), dependency = h.create(), context = {
    inputs: [{ ref: 'work/spec.md', version: 'v2' }], constraints: ['Do not publish'], skills: ['$token-efficiency'],
  };
  h.update(dependency, 'claim', { owner: 'upstream' });
  h.change('teams_submit_result', readyResult(dependency));
  h.update(dependency, 'complete');
  const task = h.create({ blocked_by: [dependency.id], context, write_scopes: ['src/button.js'] });
  const before = h.read({ history: true });
  const p = packet(h, task);
  assert.deepEqual(p.context, context);
  assert.equal(p.task_version, 1); assert.equal(p.can_dispatch, true);
  assert.equal(p.dependencies[0].result.summary, 'Verified implementation');
  assert.equal(JSON.stringify(p).includes('work/test.log'), false);
  assert.deepEqual(h.read({ history: true }), before);
  h.update(task, 'claim', { owner: 'worker' });
  assert.equal(packet(h, task).can_dispatch, false);
  assert.equal(packet(h, task).owner, 'worker');
});

test('task versions reject edited or reassigned packets while unrelated revisions keep packets valid', () => {
  const h = setup(), task = h.create();
  h.update(task, 'claim', { owner: 'first' });
  const original = packet(h, task);
  h.create({ subject: 'Unrelated task' });
  h.change('teams_submit_result', readyResult(task, { task_version: original.task_version }));
  h.update(task, 'edit', { context: { constraints: ['New scope'] } });
  assert.equal(packet(h, task).task_version, 2);
  assert.equal(h.read({ task_id: task.id }).tasks[0].result, null);
  assert.throws(() => h.change('teams_submit_result', readyResult(task)), /STALE_TASK_VERSION/);
  h.update(task, 'release', { stopped: true });
  h.update(task, 'claim', { owner: 'second' });
  assert.equal(packet(h, task).task_version, 3);
  assert.throws(() => h.change('teams_submit_result', readyResult(task, { task_version: 2 })), /STALE_TASK_VERSION/);
  h.change('teams_submit_result', readyResult(task, { task_version: 3 }));
  h.update(task, 'complete'); h.update(task, 'reopen');
  assert.equal(packet(h, task).task_version, 4);
  assert.equal(h.read({ task_id: task.id }).tasks[0].result, null);
});

test('ready result requires artifacts and passed checks and never completes automatically', () => {
  const h = setup(), task = h.create();
  assert.throws(() => h.change('teams_submit_result', readyResult(task)), /in-progress/);
  h.update(task, 'claim', { owner: 'worker' });
  const before = h.read({ task_id: task.id, history: true });
  for (const extra of [{ artifacts: [] }, { checks: [] },
    { checks: [{ name: 'needed', status: 'failed', evidence: 'failure.log' }] },
    { checks: [{ name: 'needed', status: 'not_run', evidence: 'unavailable' }] }]) {
    assert.throws(() => h.change('teams_submit_result', readyResult(task, extra)), /Ready requires/);
  }
  assert.deepEqual(h.read({ task_id: task.id, history: true }), before);
  h.change('teams_submit_result', readyResult(task));
  const detail = h.read({ task_id: task.id }).tasks[0];
  assert.equal(detail.status, 'in_progress'); assert.equal(detail.checkpoint.outcome, 'ready');
});

test('blocked and failed structured results retain the exact reported risks and failure details', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'worker' });
  const risks = ['Risk '.repeat(300), '未进行真实手机验收'];
  assert.throws(() => h.change('teams_submit_result', readyResult(task, { outcome: 'blocked' })), /next/);
  assert.throws(() => h.change('teams_submit_result', readyResult(task, { outcome: 'failed', next: 'Fix' })), /error/);
  h.change('teams_submit_result', readyResult(task, { outcome: 'failed', next: 'Retry after restoring service',
    error: 'ECONNREFUSED: local fixture endpoint', risks, artifacts: [],
    checks: [{ name: 'integration', status: 'failed', evidence: 'work/error.log' }] }));
  const brief = h.read({ view: 'results' }).tasks[0].result;
  assert.deepEqual(brief.risks, risks); assert.equal(brief.error, 'ECONNREFUSED: local fixture endpoint');
  assert.equal(brief.next, 'Retry after restoring service'); assert.equal(brief.checks.failed, 1);
  assert.equal(h.read({ task_id: task.id }).tasks[0].checkpoint.outcome, 'blocked');
  assert.throws(() => h.update(task, 'complete'), /checkpoint/);
});

test('structured result retry is idempotent but changed requests and stale team revisions are rejected', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'worker' });
  const args = { ...h.common, expected_revision: h.read().revision, request_id: randomUUID(), ...readyResult(task) };
  const receipt = execute('teams_submit_result', args);
  h.create();
  assert.equal(execute('teams_submit_result', args).replayed, true);
  assert.equal(h.read({ history: true }).history.filter(row => row.action === 'teams_submit_result').length, 1);
  assert.equal(receipt.task.task_version, 1);
  assert.throws(() => execute('teams_submit_result', { ...args, summary: 'different' }), /REQUEST_ID_REUSED/);
  assert.throws(() => execute('teams_submit_result', { ...args, request_id: randomUUID() }), /STALE_REVISION/);
});

test('results view omits complete evidence and reports measured JSON sizes without estimating tokens', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'worker' });
  const evidence = '验证日志 '.repeat(250);
  h.change('teams_submit_result', readyResult(task, { checks: [{ name: 'unicode', status: 'passed', evidence }],
    usage: { source: 'caller fixture, per-task delta', input_tokens: 100, output_tokens: 25, cached_input_tokens: 60 } }));
  const detail = h.read({ task_id: task.id }).tasks[0].result;
  const compact = h.read({ view: 'results', task_id: task.id }).tasks[0].result;
  assert.equal(detail.checks[0].evidence, evidence); assert.equal(JSON.stringify(compact).includes(evidence), false);
  assert.deepEqual(compact.checks, { passed: 1, failed: 0, not_run: 0 });
  assert.deepEqual(compact.usage, detail.usage);
  for (const [kind, value] of [['detail', detail], ['compact', compact]]) {
    const { output_sizes, ...payload } = value;
    assert.equal(output_sizes[kind].characters, JSON.stringify(payload).length);
    assert.equal(output_sizes[kind].utf8_bytes, Buffer.byteLength(JSON.stringify(payload), 'utf8'));
    assert.equal('estimated_tokens' in output_sizes, false);
  }
  assert(compact.output_sizes.compact.utf8_bytes < compact.output_sizes.detail.utf8_bytes);
  assert.equal(h.read().tasks[0].result, undefined);
  h.update(task, 'checkpoint', { outcome: 'progress', summary: 'Rechecking', next: 'Run again' });
  assert.equal(h.read({ task_id: task.id }).tasks[0].result, null);
});

test('new structured fields enforce limits without silently truncating invalid data', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'worker' });
  for (const extra of [{ summary: 'a'.repeat(1201) }, { risks: Array(13).fill('risk') }, { risks: undefined },
    { risks: ['r'.repeat(2001)] }, { checks: [{ name: 'bad', status: 'unknown', evidence: 'x' }] },
    { artifacts: [{ ref: 'x', version: '' }] }, { task_version: 0 },
    { usage: { source: 'fixture', input_tokens: 1, output_tokens: -1 } },
    { usage: { source: 'fixture', input_tokens: 1, output_tokens: 0, cached_input_tokens: 2 } }]) {
    assert.throws(() => h.change('teams_submit_result', readyResult(task, extra)));
  }
  assert.throws(() => h.create({ context: { inputs: Array(13).fill({ ref: 'x', version: '1' }) } }), /inputs/);
  assert.throws(() => h.create({ context: { skills: Array(17).fill('x') } }), /skills/);
  assert.equal(h.read({ task_id: task.id }).tasks[0].result, null);
});

test('legacy documents gain task version and empty context on reads without rewriting the database', () => {
  const h = setup(), task = h.create();
  const file = path.join(h.workspace, '.super-teams', 'teams.sqlite');
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT document FROM teams WHERE id=?').get(h.common.team_id);
  const old = JSON.parse(row.document);
  delete old.tasks[0].task_version; delete old.tasks[0].context; delete old.tasks[0].result; delete old.tasks[0].criteria;
  const document = JSON.stringify(old);
  db.prepare('UPDATE teams SET document=? WHERE id=?').run(document, h.common.team_id); db.close();
  assert.equal(packet(h, task).task_version, 1);
  assert.deepEqual(packet(h, task).context, { inputs: [], constraints: [], skills: [] });
  const verify = new DatabaseSync(file, { readOnly: true });
  assert.equal(verify.prepare('SELECT document FROM teams WHERE id=?').get(h.common.team_id).document, document);
  verify.close();
  h.update(task, 'claim', { owner: 'legacy-worker' });
  h.change('teams_submit_result', readyResult(task)); h.update(task, 'complete');
});

test('packet reads never create missing boards', () => {
  const workspace = fs.mkdtempSync(path.join(temp, 'packet-empty-'));
  assert.throws(() => execute('teams_task_packet', { workspace, team_id: 'missing', task_id: 'missing' }), /No team board/);
  assert.equal(fs.existsSync(path.join(workspace, '.super-teams')), false);
});

test('changed dependency results invalidate direct and transitive pending packets but not unrelated tasks', () => {
  const h = setup(), upstream = h.create(), child = h.create({ blocked_by: [upstream.id] }),
    descendant = h.create({ blocked_by: [child.id] }), unrelated = h.create();
  h.update(upstream, 'claim', { owner: 'source' });
  h.change('teams_submit_result', readyResult(upstream)); h.update(upstream, 'complete');
  const first = packet(h, child), indirect = packet(h, descendant), outside = packet(h, unrelated);
  h.update(upstream, 'reopen');
  assert(packet(h, child).task_version > first.task_version);
  assert(packet(h, descendant).task_version > indirect.task_version);
  h.update(upstream, 'edit', { context: { inputs: [{ ref: 'work/new-spec.md', version: '2' }] } });
  h.update(upstream, 'claim', { owner: 'source-2' });
  h.change('teams_submit_result', readyResult(upstream, { task_version: packet(h, upstream).task_version,
    summary: 'Replacement dependency artifact', artifacts: [{ ref: 'outputs/v2.txt', version: '2' }] }));
  h.update(upstream, 'complete'); h.update(child, 'claim', { owner: 'consumer' });
  assert.throws(() => h.change('teams_submit_result', readyResult(child, { task_version: first.task_version })), /STALE_TASK_VERSION/);
  h.change('teams_submit_result', readyResult(child, { task_version: packet(h, child).task_version }));
  assert.equal(packet(h, unrelated).task_version, outside.task_version);
});

test('packets fetched before dependencies are ready cannot be reused after upstream completion', () => {
  const h = setup(), upstream = h.create(), child = h.create({ blocked_by: [upstream.id] });
  const blocked = packet(h, child);
  assert.equal(blocked.can_dispatch, false);
  h.update(upstream, 'claim', { owner: 'source' });
  h.change('teams_submit_result', readyResult(upstream));
  const beforeCompletion = packet(h, child);
  h.update(upstream, 'complete');
  assert(packet(h, child).task_version > beforeCompletion.task_version);
  h.update(child, 'claim', { owner: 'consumer' });
  assert.throws(() => h.change('teams_submit_result', readyResult(child, { task_version: blocked.task_version })), /STALE_TASK_VERSION/);
  assert.throws(() => h.change('teams_submit_result', readyResult(child, { task_version: beforeCompletion.task_version })), /STALE_TASK_VERSION/);
});

test('legacy checkpoint-only results retain the next step without pretending to be structured verification', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'legacy' });
  h.update(task, 'checkpoint', { outcome: 'blocked', summary: 'Service offline', next: 'Restore local server', evidence: ['work/private-evidence.log'] });
  const brief = h.read({ view: 'results' }).tasks[0];
  assert.equal(brief.result, null);
  assert.deepEqual(brief.legacy_checkpoint, { outcome: 'blocked', summary: 'Service offline', next: 'Restore local server', evidence_available: true });
  assert.equal(JSON.stringify(brief).includes('private-evidence'), false);
  h.change('teams_submit_result', readyResult(task));
  assert.equal(h.read({ view: 'results' }).tasks[0].legacy_checkpoint, null);
});

test('failed result preserves the complete original error string', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'worker' });
  const error = '  Error: service unavailable\n    at run (worker.mjs:42)\n';
  h.change('teams_submit_result', readyResult(task, { outcome: 'failed', next: 'Restore service', error }));
  assert.equal(h.read({ task_id: task.id }).tasks[0].result.error, error);
  assert.equal(h.read({ view: 'results' }).tasks[0].result.error, error);
});

test('dependency invalidation visits diamond descendants once and idempotent replay never invalidates again', () => {
  const h = setup(), upstream = h.create(), left = h.create({ blocked_by: [upstream.id] }),
    right = h.create({ blocked_by: [upstream.id] }), leaf = h.create({ blocked_by: [left.id, right.id] });
  h.update(upstream, 'claim', { owner: 'source' });
  const before = packet(h, leaf).task_version;
  const args = { ...h.common, expected_revision: h.read().revision, request_id: randomUUID(), ...readyResult(upstream) };
  execute('teams_submit_result', args);
  assert.equal(packet(h, leaf).task_version, before + 1);
  const revision = h.read().revision;
  assert.equal(execute('teams_submit_result', args).replayed, true);
  assert.equal(h.read().revision, revision);
  assert.equal(packet(h, leaf).task_version, before + 1);
});

test('edited task checkpoints reject old and omitted versions and completion requires the saved current version', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'original-worker' });
  h.update(task, 'edit', { acceptance: 'Updated requirement' });
  const checkpoint = { outcome: 'ready', summary: 'Old worker finished', evidence: ['old.log'] };
  const before = h.read({ task_id: task.id, history: true });
  for (const task_version of [undefined, 1, 0, 1.5]) {
    assert.throws(() => h.update(task, 'checkpoint', { ...checkpoint, task_version }), /TASK_VERSION|task_version/);
  }
  assert.deepEqual(h.read({ task_id: task.id, history: true }), before);
  h.update(task, 'checkpoint', { ...checkpoint, task_version: 2 });
  assert.equal(packet(h, task).checkpoint.task_version, 2);
  h.update(task, 'complete');
});

test('legacy version-one checkpoints can complete but missing or old versions on later tasks require refresh', () => {
  for (const [taskVersion, checkpointVersion, accepted] of [[1, undefined, true], [2, undefined, false], [2, 1, false]]) {
    const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'legacy' });
    h.update(task, 'checkpoint', { outcome: 'ready', summary: 'Legacy result', evidence: ['legacy.log'] });
    const db = new DatabaseSync(path.join(h.workspace, '.super-teams', 'teams.sqlite'));
    const team = JSON.parse(db.prepare('SELECT document FROM teams WHERE id=?').get(h.common.team_id).document);
    team.tasks[0].task_version = taskVersion;
    delete team.tasks[0].checkpoint.task_version;
    if (checkpointVersion !== undefined) team.tasks[0].checkpoint.task_version = checkpointVersion;
    db.prepare('UPDATE teams SET document=? WHERE id=?').run(JSON.stringify(team), h.common.team_id); db.close();
    if (accepted) h.update(task, 'complete');
    else {
      assert.throws(() => h.update(task, 'complete'), /STALE_TASK_VERSION/);
      h.update(task, 'checkpoint', { task_version: taskVersion, outcome: 'ready', summary: 'Refreshed', evidence: ['new.log'] });
      h.update(task, 'complete');
    }
    assert.equal(h.read({ task_id: task.id }).tasks[0].status, 'completed');
  }
});

test('recovery packet retains own checkpoint, compact failed result, risks and observation without changing state', () => {
  const h = setup(), task = h.create(); h.update(task, 'claim', { owner: 'recovering-worker' });
  h.change('teams_submit_result', readyResult(task, { outcome: 'failed', summary: 'Partial implementation saved',
    next: 'Restore service then run integration', error: 'ECONNRESET: retained cause', risks: ['现场验收待做'],
    checks: [{ name: 'integration', status: 'failed', evidence: 'detail-only-recovery-marker '.repeat(30) }] }));
  h.change('teams_observe', { agent_id: 'recovering-worker', status: 'inactive', observed_at: new Date().toISOString(), source: 'native snapshot fixture' });
  const before = h.read({ history: true }), p = packet(h, task);
  assert.equal(p.checkpoint.summary, 'Partial implementation saved');
  assert.equal(p.checkpoint.task_version, 1);
  assert.equal(p.result.error, 'ECONNRESET: retained cause');
  assert.deepEqual(p.result.risks, ['现场验收待做']);
  assert.equal(p.result.next, 'Restore service then run integration');
  assert.equal(p.result.checks.failed, 1);
  assert.equal(JSON.stringify(p).includes('detail-only-recovery-marker'), false);
  assert.equal(p.runtime_observation.status, 'inactive'); assert.equal(p.runtime_observation.fresh, true);
  assert.equal(p.can_dispatch, false);
  assert.deepEqual(h.read({ history: true }), before);
  assert.equal(h.read({ task_id: task.id }).tasks[0].result.checks[0].evidence.includes('detail-only-recovery-marker'), true);
});

test('overview surfaces later exceptions before pagination and preserves global counts and evidence references', () => {
  const h = setup();
  for (let n = 0; n < 4; n++) h.create({ subject: `Ordinary ${n}` });
  const task = h.create({ subject: 'Failure beyond original first page' }); h.update(task, 'claim', { owner: 'failed-worker' });
  h.change('teams_submit_result', readyResult(task, { outcome: 'failed', summary: 'Backend unavailable',
    error: 'EHOSTUNREACH', next: 'Restore network', risks: ['Validation incomplete'],
    checks: [{ name: 'network', status: 'failed', evidence: 'private-full-log '.repeat(50) }] }));
  h.change('teams_observe', { agent_id: 'failed-worker', status: 'inactive', observed_at: new Date().toISOString(), source: 'native fixture' });
  const page = h.read({ view: 'overview', limit: 2 });
  assert.equal(page.total, 5); assert.equal(page.next_cursor, 2);
  assert.deepEqual(page.counts, { pending: 4, in_progress: 1, completed: 0 });
  assert.equal(page.overview_counts.failed, 1); assert.equal(page.overview_counts.attention, 5);
  assert.equal(page.tasks[0].id, task.id); assert.equal(page.tasks[0].summary, 'Backend unavailable');
  assert.equal(page.tasks[0].error, 'EHOSTUNREACH'); assert.equal(page.tasks[0].next, 'Restore network');
  assert.equal(page.tasks[0].next_action.action, 'resolve_failure');
  assert.deepEqual(page.tasks[0].evidence_refs, ['outputs/result.txt']);
  assert.equal(page.tasks[0].evidence_count, 1);
  assert.equal(page.tasks[0].check_counts.failed, 1);
  assert.equal(JSON.stringify(page).includes('private-full-log'), false);
  const later = h.read({ view: 'overview', cursor: 2, limit: 2 });
  assert.deepEqual(later.overview_counts, page.overview_counts); assert.deepEqual(later.counts, page.counts);
  assert.equal(later.tasks.some(row => row.id === task.id), false);
});

test('overview actions distinguish unknown, stale, running, inactive, ready, blocked and dependencies', () => {
  const h = setup();
  const unknown = h.create(), stale = h.create(), running = h.create(), inactive = h.create(), ready = h.create(), blocked = h.create();
  const waiting = h.create({ blocked_by: [unknown.id] });
  for (const [task, owner] of [[unknown, 'unknown'], [stale, 'stale'], [running, 'running'], [inactive, 'inactive'], [ready, 'ready'], [blocked, 'blocked']]) {
    h.update(task, 'claim', { owner });
    if (owner !== 'unknown') h.change('teams_observe', { agent_id: owner, status: owner === 'inactive' ? 'inactive' : 'running',
      observed_at: new Date(Date.now() - (owner === 'stale' ? 180000 : 0)).toISOString(), source: 'native fixture' });
  }
  h.change('teams_submit_result', readyResult(ready));
  h.update(blocked, 'checkpoint', { outcome: 'blocked', summary: 'Missing credentials', next: 'Provide test service' });
  const rows = Object.fromEntries(h.read({ view: 'overview' }).tasks.map(row => [row.id, row]));
  assert.equal(rows[unknown.id].next_action.action, 'verify_native_status');
  assert.equal(rows[stale.id].next_action.action, 'verify_native_status');
  assert.equal(rows[stale.id].runtime_observation.fresh, false);
  assert.equal(rows[running.id].next_action.action, 'schedule_recheck');
  assert.equal(rows[inactive.id].next_action.action, 'review_inactive_owner');
  assert.equal(rows[inactive.id].owner, 'inactive'); assert.equal(rows[inactive.id].status, 'in_progress');
  assert.equal(rows[ready.id].next_action.action, 'accept_result');
  assert.equal(rows[blocked.id].next_action.action, 'resolve_blocker');
  assert.equal(rows[blocked.id].summary, 'Missing credentials');
  assert.equal(rows[waiting.id].next_action.action, 'await_dependencies');
  assert.deepEqual(rows[waiting.id].blocked_by, [unknown.id]);
  h.change('teams_observe', { agent_id: 'running', status: 'unknown', observed_at: new Date().toISOString(), source: 'native unknown fixture' });
  assert.equal(h.read({ view: 'overview', task_id: running.id }).tasks[0].next_action.action, 'verify_native_status');
});

test('mutation receipts identify direct and transitive invalidations and retain original impact on replay', () => {
  const h = setup(), upstream = h.create(), child = h.create({ blocked_by: [upstream.id] }),
    descendant = h.create({ blocked_by: [child.id] }), unrelated = h.create();
  h.update(upstream, 'claim', { owner: 'native-owner' });
  const args = { ...h.common, expected_revision: h.read().revision, request_id: randomUUID(),
    task_id: upstream.id, action: 'edit', acceptance: 'Changed production input' };
  const receipt = execute('teams_task_update', args);
  assert.deepEqual(receipt.affected_tasks.map(row => row.task_id), [upstream.id, child.id, descendant.id]);
  const own = receipt.affected_tasks[0];
  assert.equal(own.task_version, 2); assert.equal(own.status, 'in_progress'); assert.equal(own.owner, 'native-owner');
  assert.equal(own.notification_required, true); assert.match(own.next, /parent|native/i);
  assert.equal(receipt.affected_tasks[1].reason, 'upstream_changed');
  assert.equal(receipt.affected_tasks[1].task_version, 3);
  assert.equal(receipt.affected_tasks.some(row => row.task_id === unrelated.id), false);
  const replay = execute('teams_task_update', args);
  assert.deepEqual(replay.affected_tasks, receipt.affected_tasks); assert.equal(replay.replayed, true);
  assert.equal(packet(h, child).task_version, 3);
});

