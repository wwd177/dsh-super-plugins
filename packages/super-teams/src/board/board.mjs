import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isEngineReference } from './engine-view.mjs';

function text(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}: non-empty text, max ${max} characters`);
  return value.trim();
}
function strings(value = [], label, max = 32) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}: array, max ${max} entries`);
  return [...new Set(value.map(item => text(item, label, 2000)))];
}
function references(value, label) {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label}: array, max 12 entries`);
  return value.map(item => ({ ref: text(item?.ref, `${label}.ref`), version: text(item?.version, `${label}.version`, 200) }));
}
function criterionIds(value = [], label = 'criterion_ids') {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${label}: array, max 12 entries`);
  const ids = value.map(id => text(id, label, 200));
  if (new Set(ids).size !== ids.length) throw new Error(`${label}: duplicate criterion id`);
  return ids;
}
function criteria(value = []) {
  if (!Array.isArray(value) || value.length > 12) throw new Error('criteria: array, max 12 entries');
  const entries = value.map(item => ({ id: text(item?.id, 'criteria.id', 200), description: text(item?.description, 'criteria.description') }));
  criterionIds(entries.map(item => item.id), 'criteria');
  return entries;
}
function resultCoverage(task, result) {
  const required = task.criteria.map(item => item.id), passed = new Set();
  for (const check of result.checks) {
    const ids = criterionIds(check.criterion_ids), artifacts = references(check.artifacts ?? [], 'checks.artifacts');
    for (const id of ids) if (!required.includes(id)) throw new Error(`Unknown criterion id: ${id}`);
    for (const artifact of artifacts) {
      if (!result.artifacts.some(item => item.ref === artifact.ref && item.version === artifact.version)) {
        throw new Error('checks.artifacts must reference an exact ref/version in this result.artifacts');
      }
    }
    if (check.status === 'passed' && artifacts.length) ids.forEach(id => passed.add(id));
  }
  const missing_ids = required.filter(id => !passed.has(id));
  return { required: required.length, passed: passed.size, missing: missing_ids.length, missing_ids };
}
function context(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('context must be an object');
  return { inputs: references(value.inputs ?? [], 'context.inputs'),
    constraints: strings(value.constraints, 'context.constraints', 16), skills: strings(value.skills, 'context.skills', 16) };
}
function structuredResult(args, task) {
  if (!['ready', 'blocked', 'failed'].includes(args.outcome)) throw new Error('Invalid outcome');
  if (!['self', 'independent'].includes(args.review)) throw new Error('Invalid review');
  if (!Array.isArray(args.risks)) throw new Error('risks must be an explicit array');
  strings(args.risks, 'risks', 12);
  const artifacts = references(args.artifacts, 'artifacts');
  if (!Array.isArray(args.checks) || args.checks.length > 12) throw new Error('checks: array, max 12 entries');
  const checks = args.checks.map(check => {
    if (!['passed', 'failed', 'not_run'].includes(check?.status)) throw new Error('Invalid check status');
    text(check.evidence, 'checks.evidence');
    return { name: text(check.name, 'checks.name', 200), status: check.status, evidence: check.evidence,
      ...(check.criterion_ids !== undefined ? { criterion_ids: criterionIds(check.criterion_ids) } : {}),
      ...(check.artifacts !== undefined ? { artifacts: references(check.artifacts, 'checks.artifacts') } : {}) };
  });
  if (args.outcome === 'ready' && (!artifacts.length || !checks.length || checks.some(check => check.status !== 'passed'))) {
    throw new Error('Ready requires artifacts and at least one check; all checks must be passed');
  }
  let error = null;
  if (args.outcome === 'failed' || args.error !== undefined) {
    text(args.error, 'error');
    error = args.error;
  }
  let usage = null;
  if (args.usage !== undefined) {
    const reported = args.usage;
    if (!reported || typeof reported !== 'object' || Array.isArray(reported)) throw new Error('usage must be an object');
    usage = { source: text(reported.source, 'usage.source', 1000) };
    for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens']) {
      if (key === 'cached_input_tokens' && reported[key] === undefined) continue;
      if (!Number.isSafeInteger(reported[key]) || reported[key] < 0) throw new Error(`usage.${key} must be a non-negative safe integer`);
      usage[key] = reported[key];
    }
    if (usage.cached_input_tokens > usage.input_tokens) throw new Error('usage.cached_input_tokens cannot exceed input_tokens');
  }
  const result = { task_version: args.task_version, outcome: args.outcome, summary: text(args.summary, 'summary', 1200),
    artifacts, checks, review: args.review, risks: [...args.risks],
    next: args.outcome === 'ready' && args.next === undefined ? '' : text(args.next, 'next'),
    error,
    usage, at: now(), evidence_basis: 'reported' };
  const coverage = resultCoverage(task, result);
  if (args.outcome === 'ready' && coverage.missing) throw new Error(`Incomplete acceptance coverage: ${coverage.missing_ids.join(', ')}`);
  if (task.criteria.length) result.coverage = coverage;
  return result;
}
function resultView(result, compact = false) {
  const checks = { passed: 0, failed: 0, not_run: 0 };
  result.checks.forEach(check => checks[check.status]++);
  const brief = { ...result, checks };
  const size = value => {
    const json = JSON.stringify(value);
    return { characters: json.length, utf8_bytes: Buffer.byteLength(json, 'utf8') };
  };
  return { ...(compact ? brief : result), output_sizes: { detail: size(result), compact: size(brief),
    measurement: 'JSON.stringify(result), excluding output_sizes; caller-reported usage is not measured here' } };
}
function checkpointView(checkpoint) {
  if (!checkpoint) return null;
  const { evidence, ...brief } = checkpoint;
  return { ...brief, evidence_refs: evidence ?? [], evidence_count: evidence?.length ?? 0 };
}
function runtimeObservation(team, task) {
  const observed = team.observations[task.owner];
  if (!observed) return null;
  const age = Date.now() - Date.parse(observed.observed_at);
  return { ...observed, age_seconds: Number.isFinite(age) ? Math.max(0, Math.floor(age / 1000)) : null,
    fresh: Number.isFinite(age) && age >= -5000 && age <= 120000 };
}
function taskObservation(task) {
  if (!task.observation) return null;
  const age = value => Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  return { ...task.observation, age_seconds: age(task.observation.observed_at),
    progress_age_seconds: task.observation.progress ? age(task.observation.progress.at) : null };
}
function compactObservation(observation) {
  if (!observation) return null;
  const compact = { ...observation };
  for (const key of ['progress', 'instruction', 'control', 'recheck']) {
    if (!observation[key]) continue;
    const { evidence, ...brief } = observation[key];
    compact[key] = { ...brief, evidence_count: evidence?.length ?? 0 };
  }
  return compact;
}
function resetTaskObservation(task) {
  const control = task.observation?.control;
  task.observation = control ? { task_version: task.task_version, owner: task.owner,
    observed_at: task.observation.observed_at, source: task.observation.source, evidence_basis: 'reported', control } : null;
}
function paused(task) { return task.observation?.control?.state === 'paused'; }
function observationEvidence(value, label, required = false) {
  const evidence = strings(value, label, 12);
  if (required && !evidence.length) throw new Error(`${label}: non-empty evidence references required`);
  return evidence;
}
function assertTaskVersion(task, version, legacy = false) {
  if (legacy && version === undefined && task.task_version === 1) return;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('task_version must be supplied as a positive safe integer; request a fresh task packet');
  if (version !== task.task_version) throw new Error('STALE_TASK_VERSION: request a fresh task packet after edits or reassignment');
}
function scopes(value) {
  return strings(value, 'write_scopes').map(item => {
    const normalized = item.replaceAll('\\', '/').replace(/\/$/, '');
    if (!normalized || normalized.startsWith('/') || normalized.includes(':')
        || normalized.split('/').some(p => !p || p === '.' || p === '..') || /[*?\[\]]/.test(normalized)) {
      throw new Error('write_scopes must be workspace-relative file/directory prefixes, without glob or traversal');
    }
    return normalized;
  });
}
const nextId = prefix => `${prefix}-${randomUUID()}`;
const now = () => new Date().toISOString();

// One database per explicitly selected workspace. Opening a read never creates it.
export function openBoard(workspace, create = false) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new Error('workspace must be an absolute path');
  const root = fs.realpathSync(workspace);
  if (!fs.statSync(root).isDirectory()) throw new Error('workspace must be an existing directory');
  const directory = path.join(root, '.super-teams');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('.super-teams cannot be a symlink or junction');
  if (create) fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'teams.sqlite');
  if (!create && !fs.existsSync(file)) throw new Error('No team board exists in this workspace. Use teams_create first.');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Team database cannot be a symlink');
  const db = new DatabaseSync(file, { readOnly: !create });
  db.exec('PRAGMA busy_timeout=5000');
  if (create) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    db.exec('CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS history (team_id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, task_id TEXT, PRIMARY KEY(team_id,revision))');
  }
  return db;
}
function load(db, id) {
  text(id, 'team_id', 100);
  const row = db.prepare('SELECT document FROM teams WHERE id=?').get(id);
  if (!row) throw new Error('Team not found');
  const team = JSON.parse(row.document);
  for (const task of team.tasks) {
    task.task_version ??= 1;
    task.context ??= context();
    task.result ??= null;
    task.observation ??= null;
    task.criteria ??= [];
  }
  return team;
}
function operation(db, name, args, fn) {
  text(args.request_id, 'request_id', 200);
  const fingerprint = createHash('sha256').update(JSON.stringify([name, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare('SELECT fingerprint,receipt FROM operations WHERE id=?').get(args.request_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('REQUEST_ID_REUSED: use a new request_id for a different operation');
      db.exec('COMMIT');
      return { ...JSON.parse(prior.receipt), replayed: true, next: 'Read the board for its current revision; this is the original receipt.' };
    }
    const receipt = fn();
    db.prepare('INSERT INTO operations VALUES (?,?,?)').run(args.request_id, fingerprint, JSON.stringify(receipt));
    db.prepare('INSERT INTO history VALUES (?,?,?,?,?)').run(receipt.team_id, receipt.revision, args.action ?? name, now(), receipt.task?.id ?? null);
    db.exec('COMMIT');
    return receipt;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function mutate(db, name, args, fn) {
  return operation(db, name, args, () => {
    const team = load(db, args.team_id);
    if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision !== team.revision) {
      throw new Error('STALE_REVISION: read the board before retrying; do not repeat external side effects');
    }
    fn(team);
    const invalidated = args.task_id && ['teams_task_update', 'teams_submit_result'].includes(name)
      ? invalidatePendingDependents(team, args.task_id) : [];
    team.revision++;
    team.updated_at = now();
    db.prepare('UPDATE teams SET revision=?, document=? WHERE id=?').run(team.revision, JSON.stringify(team), team.id);
    const changed = args.task_id ? taskOf(team, args.task_id) : name === 'teams_task_create' ? team.tasks.at(-1) : null;
    const claimed = name === 'teams_task_update' && args.action === 'claim';
    const affected = changed ? [changed, ...invalidated] : name === 'teams_observe'
      ? team.tasks.filter(task => task.owner === args.agent_id) : [];
    return { team_id: team.id, revision: team.revision, replayed: false,
      affected_tasks: affected.map(task => {
        const downstream = invalidated.includes(task);
        const notify = task.owner !== '' && args.action === 'edit' && !downstream;
        return { task_id: task.id, task_version: task.task_version, status: task.status, owner: task.owner,
          reason: downstream ? 'upstream_changed' : args.action ?? name,
          notification_required: notify,
          next: downstream ? 'Refresh this task packet before dispatch or submission; upstream input changed.'
            : notify ? 'Parent must notify the native owner of the changed version and refresh its task packet. This receipt did not notify or stop any agent.'
            : claimed ? 'Use included packet on first success; refresh on replay. No agent was started or notified.'
            : 'Read the current task packet before the next action; this receipt did not notify or stop any agent.' };
      }),
      task: changed ? { id: changed.id, subject: changed.subject, status: changed.status, owner: changed.owner,
        task_version: changed.task_version, checkpoint: changed.checkpoint?.outcome ?? null } : null,
      ...(claimed ? { packet: taskPacket(team, changed) } : {}) };
  });
}
function taskOf(team, id) {
  const task = team.tasks.find(task => task.id === id);
  if (!task) throw new Error('Task not found');
  return task;
}
function ready(team, task) {
  return task.blocked_by.every(id => taskOf(team, id).status === 'completed');
}
function invalidatePendingDependents(team, taskId) {
  const changed = [taskId], visited = new Set(changed), invalidated = [];
  for (let index = 0; index < changed.length; index++) {
    for (const task of team.tasks) {
      if (visited.has(task.id) || !task.blocked_by.includes(changed[index])) continue;
      visited.add(task.id); changed.push(task.id);
      if (task.status === 'pending') {
        task.task_version++; task.result = null; task.checkpoint = null;
        resetTaskObservation(task);
        invalidated.push(task);
      }
    }
  }
  return invalidated;
}
function overlap(a, b) {
  // Windows checkouts are commonly case-insensitive; conservative on other hosts too.
  a = a.toLowerCase(); b = b.toLowerCase();
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
function assertDag(team) {
  const visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('DEPENDENCY_CYCLE');
    if (done.has(id)) return;
    visiting.add(id);
    taskOf(team, id).blocked_by.forEach(visit);
    visiting.delete(id); done.add(id);
  }
  team.tasks.forEach(task => visit(task.id));
}
export function view(team) {
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  const tasks = team.tasks.map(task => {
    counts[task.status]++;
    const issues = [];
    const available = ready(team, task);
    if (task.status !== 'completed' && !available) issues.push('dependencies_pending');
    if (task.status === 'pending' && available) issues.push('ready_unassigned');
    const observed = runtimeObservation(team, task);
    if (task.status === 'in_progress' && (!observed || observed.status !== 'running')) issues.push('owner_needs_check');
    if (task.status === 'in_progress' && observed && !observed.fresh) issues.push('runtime_observation_stale');
    const conflicts = task.status !== 'in_progress' ? [] : team.tasks.filter(other => other.id !== task.id
      && other.status === 'in_progress' && task.write_scopes.some(a => other.write_scopes.some(b => overlap(a, b)))).map(other => other.id);
    if (conflicts.length) issues.push('write_scope_overlap');
    if (task.checkpoint?.outcome === 'blocked') issues.push('reported_blocked');
    if (paused(task)) issues.push('user_paused');
    if (task.observation?.instruction?.state === 'delivered') issues.push('instruction_application_unverified');
    return { ...task, observation: taskObservation(task), ready: available, issues, conflicts,
      runtime_observation: observed };
  });
  return { ...team, counts, tasks, runtime_source: 'Reported snapshot; query native Codex collaboration tools for current activity.' };
}

function overviewRow(team, task) {
  const result = task.result, checkpoint = task.checkpoint, observed = task.runtime_observation;
  const outcome = result?.outcome ?? checkpoint?.outcome;
  const blocked_by = task.blocked_by.filter(id => taskOf(team, id).status !== 'completed');
  let action = 'none', instruction = 'No pending action; accepted completion remains recorded.';
  if (task.status === 'in_progress') {
    if (!observed || !observed.fresh || observed.status === 'unknown') {
      action = 'verify_native_status'; instruction = 'Parent must query native collaboration tools before resuming, releasing or reassigning; this snapshot does not establish current activity.';
    } else if (outcome === 'failed') {
      action = 'resolve_failure'; instruction = 'Parent should inspect the reported error and next step with the existing owner; do not automatically reassign.';
    } else if (outcome === 'ready') {
      action = 'accept_result'; instruction = 'Parent should verify the evidence against current acceptance criteria before completing the task.';
    } else if (outcome === 'blocked') {
      action = 'resolve_blocker'; instruction = 'Parent should resolve the reported blocker with the existing owner; the observation does not release ownership.';
    } else if (observed.status === 'running') {
      action = 'await_running_owner'; instruction = 'Owner was observed running; keep the assignment and use native tools for current progress. Do not dispatch a duplicate.';
    } else {
      action = 'review_inactive_owner'; instruction = 'Inspect saved work and confirm stopped writes before release; an inactive snapshot does not release ownership.';
    }
  } else if (task.status === 'pending') {
    action = blocked_by.length ? 'await_dependencies' : 'dispatch';
    instruction = blocked_by.length ? 'Wait for the listed dependencies to be accepted, then refresh the task packet.'
      : 'Parent may dispatch the current packet with native tools; the board does not spawn an agent.';
  }
  const observation = task.observation;
  let next_owner, deadline;
  const hasOutcome = ['ready', 'failed', 'blocked'].includes(outcome);
  const recheck_due = task.status === 'in_progress' && !paused(task) && !hasOutcome
    && !!observation?.recheck && Date.parse(observation.recheck.at) <= Date.now();
  if (paused(task)) {
    action = 'wait_for_user_resume'; instruction = 'User pause remains in force; wait for explicit user resume evidence before advancing this task.';
  } else if (task.status === 'in_progress' && !hasOutcome) {
    deadline = observation?.recheck?.at;
    next_owner = observation?.recheck?.next_owner ?? observation?.wait?.next_owner ?? task.owner;
    if (action !== 'verify_native_status') {
      if (observation?.wait) {
        action = `wait_for_${observation.wait.reason}`; instruction = observation.wait.next;
      }
      if (recheck_due) {
        action = observation.instruction?.state === 'delivered' ? 'verify_instruction_application' : 'investigate_wait';
        instruction = 'Recheck deadline has passed. Inspect the original native call ID, arguments, response and side effects with the existing owner before retrying; do not blindly repeat a call or dispatch a duplicate.';
      } else if (!observation?.recheck && (observation?.wait || observation?.instruction?.state === 'delivered' || observed?.status === 'running')) {
        action = 'schedule_recheck'; instruction = 'Record an evidence-backed recheck deadline and next owner after checking native activity; running or delivery alone does not establish progress.';
      }
    }
  }
  if (observation?.instruction?.state === 'delivered') instruction += ' Instruction delivery is recorded; application remains unverified.';
  const evidence_refs = result ? result.artifacts.map(artifact => artifact.ref) : checkpoint?.evidence ?? [];
  return { id: task.id, subject: task.subject, status: task.status, owner: task.owner, task_version: task.task_version,
    summary: result?.summary ?? checkpoint?.summary ?? '', next: result?.next ?? checkpoint?.next ?? '',
    error: result?.error ?? null, risks: result?.risks ?? [], outcome: outcome ?? null, coverage: result?.coverage ?? null,
    ready: task.ready, blocked_by, issues: task.issues, conflicts: task.conflicts,
    evidence_refs, evidence_count: evidence_refs.length, check_counts: result ? resultView(result, true).checks : null,
    runtime_observation: observed, observation: compactObservation(observation), recheck_due,
    can_dispatch: task.status === 'pending' && task.ready && !paused(task),
    next_action: { action, instruction, ...(deadline ? { deadline } : {}), ...(next_owner ? { next_owner } : {}) } };
}
function overview(tasks, team) {
  const counts = { attention: 0, awaiting_acceptance: 0, failed: 0, blocked: 0,
    dependencies_pending: 0, owner_needs_check: 0, runtime_observation_stale: 0, ready_unassigned: 0, recheck_due: 0 };
  const priority = { wait_for_user_resume: -1, resolve_failure: 0, resolve_blocker: 1, accept_result: 2, verify_native_status: 3,
    review_inactive_owner: 4, dispatch: 5, await_dependencies: 6, await_running_owner: 7, none: 8 };
  const rows = tasks.map(task => {
    const row = overviewRow(team, task);
    if (row.recheck_due) counts.recheck_due++;
    if (!['none', 'await_running_owner'].includes(row.next_action.action) || task.conflicts.length) counts.attention++;
    if (task.status === 'in_progress') {
      if (row.outcome === 'ready') counts.awaiting_acceptance++;
      if (row.outcome === 'failed') counts.failed++;
      if (row.outcome === 'blocked') counts.blocked++;
      if (row.next_action.action === 'verify_native_status' || row.next_action.action === 'review_inactive_owner') counts.owner_needs_check++;
    }
    for (const issue of ['dependencies_pending', 'runtime_observation_stale', 'ready_unassigned']) {
      if (task.issues.includes(issue)) counts[issue]++;
    }
    return row;
  });
  rows.sort((a, b) => {
    // Reported failures/ready results remain visible even when their owner needs a native-status check first.
    const rank = row => row.next_action.action === 'wait_for_user_resume' ? -1 : row.status === 'completed' ? 20 : row.outcome === 'failed' ? 0
      : row.outcome === 'blocked' ? 1 : row.outcome === 'ready' ? 2 : row.recheck_due ? 3 : row.conflicts.length ? 4 : (priority[row.next_action.action] ?? 6) + 2;
    return rank(a) - rank(b);
  });
  return { counts, rows };
}

function taskPacket(team, task) {
  const row = overviewRow(team, view(team).tasks.find(item => item.id === task.id));
  return { team_id: team.id, revision: team.revision, task_id: task.id, task_version: task.task_version,
    subject: task.subject, acceptance: task.acceptance, criteria: task.criteria, context: task.context, write_scopes: task.write_scopes,
    status: task.status, owner: task.owner, can_dispatch: row.can_dispatch,
    observation: row.observation, next_action: row.next_action, recheck_due: row.recheck_due,
    checkpoint: checkpointView(task.checkpoint), result: task.result ? resultView(task.result, true) : null,
    runtime_observation: runtimeObservation(team, task),
    runtime_source: 'Reported snapshot; query native Codex collaboration tools for current activity.',
    dependencies: task.blocked_by.map(id => {
      const dependency = taskOf(team, id);
      return { id, subject: dependency.subject, status: dependency.status,
        result: dependency.result ? resultView(dependency.result, true) : null,
        checkpoint: dependency.checkpoint ? { outcome: dependency.checkpoint.outcome, summary: dependency.checkpoint.summary, next: dependency.checkpoint.next } : null };
    }),
    result_contract: { tool: 'teams_submit_result', task_version: task.task_version,
      required: ['expected_revision', 'request_id', 'task_version', 'outcome', 'summary', 'artifacts', 'checks', 'review', 'risks'],
      ready: 'At least one artifact and one check; all listed checks must pass. Caller reports evidence; parent verifies before completion.'
        + (task.criteria.length ? ' Every criterion ID must be covered by a passed check with criterion_ids and artifacts referencing exact ref/version entries in this result.artifacts; use teams_submit_result, not a ready checkpoint.' : ''),
      non_ready: 'next is required; failed also requires error. Submit does not complete the task.',
      concurrency: 'Read the current team revision before submitting; task_version must still match this packet.' } };
}

export function execute(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  if (!['teams_create', 'teams_read', 'teams_task_create', 'teams_task_update', 'teams_observe', 'teams_task_packet', 'teams_submit_result'].includes(name)) throw new Error('Unknown tool');
  const readOnly = name === 'teams_read' || name === 'teams_task_packet';
  if (isEngineReference(args.team_id) || isEngineReference(args.task_id)) throw new Error('ENGINE_READ_ONLY: Use teams_engine to read and engine_control / engine task tools to change engine-owned records.');
  const db = openBoard(args.workspace, !readOnly);
  try {
    if (name === 'teams_create') return operation(db, name, args, () => {
      const team = { id: nextId('team'), title: text(args.title, 'title', 200), revision: 1,
        created_at: now(), updated_at: now(), tasks: [], observations: {} };
      db.prepare('INSERT INTO teams VALUES (?, ?, ?)').run(team.id, team.revision, JSON.stringify(team));
      return { team_id: team.id, title: team.title, revision: team.revision, replayed: false, affected_tasks: [] };
    });
    if (name === 'teams_task_packet') {
      const team = load(db, args.team_id), task = taskOf(team, args.task_id);
      return taskPacket(team, task);
    }
    if (name === 'teams_read') {
      if (args.view !== undefined && !['status', 'results', 'overview', 'graph'].includes(args.view)) throw new Error('Invalid view');
      if (!args.team_id) return { teams: db.prepare('SELECT document FROM teams ORDER BY rowid DESC LIMIT 100').all().map(row => {
        const team = JSON.parse(row.document); return { id: team.id, title: team.title, revision: team.revision, updated_at: team.updated_at };
      }), limit: 100 };
      const team = view(load(db, args.team_id));
      if (args.view === 'graph') {
        return {
          team_id: team.id,
          title: team.title,
          revision: team.revision,
          tasks: team.tasks.map(t => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
            blocked_by: t.blocked_by ?? [],
            write_scopes: t.write_scopes ?? [],
            created_at: t.created_at ?? null,
          })),
        };
      }
      const summary = args.view === 'overview' ? overview(team.tasks, team) : null;
      const allTasks = summary?.rows ?? team.tasks;
      const selected = args.task_id ? allTasks.filter(task => task.id === args.task_id) : allTasks;
      if (args.task_id && !selected.length) throw new Error('Task not found');
      const cursor = args.cursor ?? 0, limit = args.limit ?? 20;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid cursor or limit');
      const page = selected.slice(cursor, cursor + limit).map(task => args.view === 'overview' ? task : args.view === 'results' ? {
        id: task.id, subject: task.subject, status: task.status, owner: task.owner, task_version: task.task_version,
        checkpoint: task.checkpoint?.outcome ?? null, result: task.result ? resultView(task.result, true) : null,
        legacy_checkpoint: !task.result && task.checkpoint ? { outcome: task.checkpoint.outcome,
          summary: task.checkpoint.summary, next: task.checkpoint.next, evidence_available: !!task.checkpoint.evidence?.length } : null,
      } : args.task_id ? { ...task, result: task.result ? resultView(task.result) : null } : {
        id: task.id, subject: task.subject, status: task.status, owner: task.owner, ready: task.ready,
        task_version: task.task_version,
        issues: task.issues, conflicts: task.conflicts, checkpoint: task.checkpoint?.outcome ?? null,
        next: task.checkpoint?.next ?? '', runtime_observation: task.runtime_observation, observation: compactObservation(task.observation),
      });
      return { ...team, observations: undefined, tasks: page, total: selected.length,
        ...(summary ? { overview_counts: summary.counts } : {}),
        ...(cursor + limit < selected.length ? { next_cursor: cursor + limit } : {}),
        history: args.history ? db.prepare('SELECT revision,action,at,task_id FROM history WHERE team_id=? ORDER BY revision DESC LIMIT 30').all(args.team_id) : undefined };
    }
    if (name === 'teams_task_create') return mutate(db, name, args, team => {
      if (team.tasks.length >= 128) throw new Error('Team task limit: 128');
      const task = { id: nextId('task'), subject: text(args.subject, 'subject', 200),
        acceptance: text(args.acceptance, 'acceptance', 4000), status: 'pending', owner: '',
        blocked_by: strings(args.blocked_by, 'blocked_by'), write_scopes: scopes(args.write_scopes),
        context: context(args.context), criteria: criteria(args.criteria), task_version: 1, checkpoint: null, result: null, observation: null };
      task.blocked_by.forEach(id => taskOf(team, id));
      team.tasks.push(task);
    });
    if (name === 'teams_submit_result') return mutate(db, name, args, team => {
      const task = taskOf(team, args.task_id);
      assertTaskVersion(task, args.task_version);
      if (task.status !== 'in_progress') throw new Error('Result submission requires an in-progress task');
      const result = structuredResult(args, task);
      task.result = result;
      task.checkpoint = { task_version: task.task_version, outcome: result.outcome === 'ready' ? 'ready' : 'blocked', summary: result.summary,
        evidence: result.artifacts.map(artifact => artifact.ref), next: result.next, at: result.at, evidence_basis: 'reported' };
    });
    if (name === 'teams_observe') return mutate(db, name, args, team => {
      const agent = text(args.agent_id, 'agent_id', 200);
      const hasTaskFields = ['progress', 'wait', 'instruction', 'control', 'recheck'].some(key => args[key] !== undefined);
      let task = null;
      if (args.task_id !== undefined || args.task_version !== undefined || hasTaskFields) {
        task = taskOf(team, text(args.task_id, 'task_id', 100));
        assertTaskVersion(task, args.task_version);
        const unownedResume = !task.owner && paused(task) && task.observation.control.agent_id === agent
          && args.control?.state === 'resumed' && !['progress', 'wait', 'instruction', 'recheck'].some(key => args[key] !== undefined);
        if (task.owner !== agent && !unownedResume) throw new Error('Task observation requires the current owner');
      }
      if (!task && !team.tasks.some(task => task.owner === agent)) throw new Error('Observe an owner recorded on this board');
      if (!['running', 'inactive', 'unknown'].includes(args.status)) throw new Error('Invalid observed status');
      const timestamp = Date.parse(args.observed_at);
      if (!Number.isFinite(timestamp) || timestamp > Date.now() + 5000) throw new Error('observed_at must be the actual observation time, not in the future');
      if (team.observations[agent] && timestamp < Date.parse(team.observations[agent].observed_at)) throw new Error('Observation is older than the saved snapshot');
      const source = text(args.source, 'source', 1000), observed_at = new Date(timestamp).toISOString();
      if (task) {
        const previous = task.observation;
        if (previous && timestamp < Date.parse(previous.observed_at)) throw new Error('Task observation is older than the saved snapshot');
        const observation = { ...previous, task_version: task.task_version, owner: task.owner, observed_at, source, evidence_basis: 'reported' };
        if (args.progress !== undefined) {
          const at = Date.parse(args.progress?.at);
          if (!Number.isFinite(at) || at > timestamp) throw new Error('progress.at must be an actual action time at or before observed_at');
          if (previous?.progress && at < Date.parse(previous.progress.at)) throw new Error('Progress is older than the saved action');
          const progress = { at: new Date(at).toISOString(), summary: text(args.progress.summary, 'progress.summary'),
            evidence: observationEvidence(args.progress.evidence, 'progress.evidence', true) };
          observation.progress = progress;
        }
        if (args.wait !== undefined) {
          if (args.wait === null) observation.wait = null;
          else {
            if (!['model_response', 'tool', 'user', 'dependency', 'review', 'unknown'].includes(args.wait?.reason)) throw new Error('Invalid wait.reason');
            observation.wait = { reason: args.wait.reason, next: text(args.wait.next, 'wait.next'), next_owner: text(args.wait.next_owner, 'wait.next_owner', 200) };
          }
        }
        if (args.instruction !== undefined) {
          if (!['delivered', 'applied'].includes(args.instruction?.state)) throw new Error('Invalid instruction.state');
          const id = text(args.instruction.id, 'instruction.id', 200);
          const evidence = observationEvidence(args.instruction.evidence, 'instruction.evidence', args.instruction.state === 'applied');
          const prior = previous?.instruction?.id === id ? previous.instruction : null;
          const first_delivered_at = prior?.first_delivered_at ?? (args.instruction.state === 'delivered' ? observed_at : null);
          observation.instruction = prior?.state === 'applied' && args.instruction.state === 'delivered'
            ? prior
            : { id, state: args.instruction.state, task_version: task.task_version, first_delivered_at, evidence };
        }
        if (args.control !== undefined) {
          if (!['paused', 'resumed'].includes(args.control?.state)) throw new Error('Invalid control.state');
          observation.control = { state: args.control.state, evidence: observationEvidence(args.control.evidence, 'control.evidence', true),
            agent_id: agent, observed_at, source };
        }
        if (args.recheck !== undefined) {
          if (args.recheck === null) {
            const progressFloor = Math.max(previous?.progress ? Date.parse(previous.progress.at) : -Infinity,
              previous?.recheck ? Date.parse(previous.recheck.scheduled_at) : -Infinity);
            const newProgress = args.progress !== undefined && Date.parse(observation.progress.at) > progressFloor;
            const applied = args.instruction?.state === 'applied' && (previous?.instruction?.id !== observation.instruction.id
              || previous.instruction.state !== 'applied' || observation.instruction.evidence.some(ref => !previous.instruction.evidence.includes(ref)));
            const controlled = args.control !== undefined && (previous?.control?.state !== observation.control.state
              || observation.control.evidence.some(ref => !previous.control.evidence.includes(ref)));
            const outcome = task.result?.outcome ?? task.checkpoint?.outcome;
            if (previous?.recheck && !newProgress && !applied && !controlled && !['ready', 'blocked', 'failed'].includes(outcome)) {
              throw new Error('Cannot clear recheck without new progress, applied instruction evidence, explicit user control or a reported result');
            }
            observation.recheck = null;
          } else {
            const at = Date.parse(args.recheck?.at);
            if (typeof args.recheck?.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(args.recheck.at) || !Number.isFinite(at) || at <= timestamp) {
              throw new Error('recheck.at must be a valid ISO deadline after observed_at');
            }
            const evidence = observationEvidence(args.recheck.evidence, 'recheck.evidence', true);
            const prior = previous?.recheck;
            if (prior && at > Date.parse(prior.at)) {
              if (timestamp <= Date.parse(prior.scheduled_at)) throw new Error('Recheck extension requires a later observation');
              if (!evidence.some(ref => !prior.evidence.includes(ref))) throw new Error('Recheck extension requires new evidence references');
            }
            if (prior && at <= Date.parse(prior.at) && prior.evidence.some(ref => !evidence.includes(ref))) {
              throw new Error('Recheck with the same or earlier deadline must retain prior evidence references');
            }
            observation.recheck = { at: new Date(at).toISOString(), reason: text(args.recheck.reason, 'recheck.reason'),
              next_owner: text(args.recheck.next_owner, 'recheck.next_owner', 200), evidence,
              scheduled_at: prior && at === Date.parse(prior.at) ? prior.scheduled_at : observed_at };
          }
        }
        task.observation = observation;
      }
      team.observations[agent] = { status: args.status, observed_at: new Date(timestamp).toISOString(),
        source, recorded_at: now() };
    });
    if (name === 'teams_task_update') return mutate(db, name, args, team => {
      const task = taskOf(team, args.task_id);
      switch (args.action) {
        case 'claim':
          if (paused(task)) throw new Error('Task is paused; record explicit user resume evidence first');
          if (task.status !== 'pending' || !ready(team, task)) throw new Error('Task is not ready to claim');
          task.owner = text(args.owner, 'owner', 200);
          task.status = 'in_progress'; task.checkpoint = null; task.result = null;
          resetTaskObservation(task);
          break;
        case 'edit':
          if (task.status === 'completed') throw new Error('Reopen before editing a completed task');
          if (args.subject === undefined && args.acceptance === undefined && args.blocked_by === undefined && args.write_scopes === undefined && args.context === undefined && args.criteria === undefined) throw new Error('No task fields supplied');
          if (args.subject !== undefined) task.subject = text(args.subject, 'subject', 200);
          if (args.acceptance !== undefined) task.acceptance = text(args.acceptance, 'acceptance', 4000);
          if (args.blocked_by !== undefined) task.blocked_by = strings(args.blocked_by, 'blocked_by');
          if (args.write_scopes !== undefined) task.write_scopes = scopes(args.write_scopes);
          if (args.context !== undefined) task.context = context(args.context);
          if (args.criteria !== undefined) task.criteria = criteria(args.criteria);
          assertDag(team);
          if (task.status === 'in_progress' && !ready(team, task)) throw new Error('Release the task before adding incomplete dependencies');
          task.checkpoint = null; task.result = null; task.task_version++;
          resetTaskObservation(task);
          break;
        case 'checkpoint': {
          if (task.status !== 'in_progress') throw new Error('Checkpoint requires an in-progress task');
          assertTaskVersion(task, args.task_version, true);
          if (!['progress', 'blocked', 'ready'].includes(args.outcome)) throw new Error('Invalid outcome');
          if (task.criteria.length && args.outcome === 'ready') throw new Error('Structured criteria require teams_submit_result with complete acceptance coverage');
          const evidence = strings(args.evidence, 'evidence', 12);
          if (args.outcome === 'ready' && !evidence.length) throw new Error('Ready requires evidence references and observed results');
          task.checkpoint = { task_version: task.task_version, outcome: args.outcome, summary: text(args.summary, 'summary'), evidence,
            next: args.outcome === 'ready' && !args.next ? '' : text(args.next, 'next'), at: now(), evidence_basis: 'reported' };
          task.result = null;
          break;
        }
        case 'complete':
          if (paused(task)) throw new Error('Task is paused; record explicit user resume evidence first');
          if (task.criteria.length) {
            if (!task.result || task.result.task_version !== task.task_version || task.result.outcome !== 'ready'
                || task.result.checks.some(check => check.status !== 'passed') || resultCoverage(task, task.result).missing) {
              throw new Error('Completion requires a current ready teams_submit_result with complete acceptance coverage');
            }
          }
          if (task.status !== 'in_progress' || !ready(team, task) || task.checkpoint?.outcome !== 'ready') throw new Error('Completion requires an in-progress ready task and current ready checkpoint');
          if ((task.checkpoint.task_version ?? (task.task_version === 1 ? 1 : null)) !== task.task_version) throw new Error('STALE_TASK_VERSION: refresh the ready checkpoint for the current task version before completion');
          task.status = 'completed';
          break;
        case 'release':
          if (task.status !== 'in_progress' || args.stopped !== true) throw new Error('Release requires an in-progress task and confirmation that the previous owner stopped writing');
          task.status = 'pending'; task.owner = ''; task.checkpoint = null; task.result = null; task.task_version++;
          resetTaskObservation(task);
          break;
        case 'reopen':
          if (task.status !== 'completed') throw new Error('Only a completed task can reopen');
          if (team.tasks.some(other => other.id !== task.id && other.status !== 'pending' && other.blocked_by.includes(task.id))) throw new Error('Reopen or release active/completed dependents first');
          task.status = 'pending'; task.owner = ''; task.checkpoint = null; task.result = null; task.task_version++;
          resetTaskObservation(task);
          break;
        default: throw new Error('Unknown task action');
      }
    });
    throw new Error('Unknown tool');
  } finally { db.close(); }
}
