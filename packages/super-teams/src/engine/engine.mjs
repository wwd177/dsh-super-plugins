import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { ContextStore } from './context.mjs';
import { artifactFiles, hashArtifact, secureFile, validateCheck, validateTestSource, verifyArtifacts } from './verification.mjs';
import { freezeSnapshot, readSnapshot, verifySnapshot, copySnapshot, readSnapshotResult, readVerifiedFilePage } from './artifact-snapshots.mjs';
import { VALID_PRIORITIES, analyzeTaskGraph, rankReadyCandidates, serializeTaskGraph, taskScopesOverlap } from './scheduler.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const errorText = value => typeof value === 'string' ? value : value instanceof Error ? value.message : JSON.stringify(value);
const executing = new Set(['dispatching', 'running', 'pausing', 'cancelling']);
const teamPreserved = new Set(['accepted', 'checked', 'submitted', 'failed', 'cancelled', 'abandoned']);
const memberStatePriority = ['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed', 'failed', 'running', 'dispatching', 'pausing', 'cancelling', 'submitted', 'checked', 'blocked', 'queued', 'paused', 'cancelled', 'accepted'];
const countsOf = tasks => tasks.reduce((counts, task) => { counts[task.state] = (counts[task.state] ?? 0) + 1; return counts; }, {});
const taskSummaryFields = ['id', 'title', 'teamId', 'memberId', 'sessionId', 'teamPauseOrigin', 'revision', 'state', 'blockReason', 'control', 'dependsOn', 'difficulty', 'priority', 'writeScopes', 'autoAccept', 'maxRetries', 'retryCount', 'nextRetryAt', 'cwd', 'threadId', 'turnId', 'attemptId', 'model', 'effort', 'modelReason', 'summary', 'error', 'runtimeError', 'completionStatus', 'executionUnresolved', 'reworkCount', 'reworkFeedback', 'startedAt', 'finishedAt', 'durationMs', 'usage', 'createdAt', 'updatedAt'];
const taskSummary = (task, liveActivity = null) => ({
  ...Object.fromEntries(taskSummaryFields.map(key => [key, task[key]])),
  ...(liveActivity ? { lastActivity: liveActivity } : {}),
});
function summarizeHostEvent(raw) {
  const method = raw?.method;
  const params = raw?.params ?? {};
  if (!method) return null;
  if (method === 'turn/started') return { text: '已启动执行回合', persist: true };
  if (method === 'turn/completed') return { text: `回合结束（${params.turn?.status ?? 'unknown'}）`, persist: true };
  if (method === 'adapter/interactiveRequestApproved') return { text: `已人工允许：${params.requestMethod ?? '审批请求'}`, persist: true };
  if (method === 'adapter/interactiveRequestDenied') return { text: `已拒绝交互请求：${params.requestMethod ?? '审批请求'}`, persist: true };
  if (method === 'thread/tokenUsage/updated') return { text: '已更新模型用量统计', persist: true };
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item ?? {};
    const type = item.type ?? 'step';
    const done = method === 'item/completed';
    if (type === 'commandExecution' || type === 'local_shell_call') {
      const cmd = Array.isArray(item.command) ? item.command.join(' ') : typeof item.command === 'string' ? item.command : '';
      return { text: `${done ? '完成命令' : '正在执行命令'}${cmd ? `：${cmd.slice(0, 120)}` : ''}`, persist: true };
    }
    if (type === 'fileChange' || type === 'patch') {
      return { text: done ? '已完成文件修改' : '正在修改文件', persist: true };
    }
    if (type === 'mcpToolCall' || type === 'toolCall') {
      const tool = item.tool ?? item.name ?? '';
      return { text: `${done ? '完成工具调用' : '正在调用工具'}${tool ? `：${tool}` : ''}`, persist: true };
    }
    if (type === 'agentMessage') {
      return { text: done ? '已输出阶段回复' : '正在撰写回复…', persist: done };
    }
    if (type === 'reasoning') {
      return { text: done ? '完成阶段思考' : '正在分析与推理…', persist: false };
    }
    return { text: `${done ? '完成步骤' : '进行中'}：${type}`, persist: true };
  }
  if (/Delta$|\/delta$/i.test(method)) return { text: null, persist: false };
  return { text: `宿主事件：${method}`, persist: true };
}
function bounded(text, maxBytes) {
  const bytes = Buffer.from(String(text));
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), bytes: bytes.length, truncated: end < bytes.length };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function taskInput({ title, goal, dependsOn = [], sourceIds = [], difficulty = 'medium', checks = [], priority, writeScopes, autoAccept, maxRetries }) {
  if ([goal, title].some(value => typeof value !== 'string' || !value.trim())) throw new Error('requestId, title and goal are required');
  if (!['low', 'easy', 'medium', 'high', 'hard'].includes(difficulty)) throw new Error('Unsupported difficulty');
  if (!Array.isArray(dependsOn) || !Array.isArray(sourceIds) || !Array.isArray(checks)) throw new Error('Invalid task arrays');
  checks.forEach(validateCheck);
  const input = { title, goal, dependsOn, sourceIds, difficulty, checks };
  if (priority !== undefined) {
    if (!VALID_PRIORITIES.includes(priority)) throw new Error('Unsupported priority');
    input.priority = priority;
  }
  if (writeScopes !== undefined) {
    if (!Array.isArray(writeScopes) || writeScopes.length > 16 || writeScopes.some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 240 || scope.includes('\0') || scope.split(/[\\/]/).includes('..'))) {
      throw new Error('writeScopes must be an array of up to 16 safe non-empty relative path strings');
    }
    input.writeScopes = writeScopes.map(scope => scope.trim());
  }
  if (autoAccept !== undefined) {
    if (typeof autoAccept !== 'boolean') throw new Error('autoAccept must be boolean');
    if (autoAccept === true && !checks.some(check => check?.type === 'node_test')) {
      throw new Error('autoAccept=true requires at least one behavioral node_test check; structural checks (file_exists, file_contains, json_equals) only reach "checked" state and require explicit review/accept');
    }
    input.autoAccept = autoAccept;
  }
  if (maxRetries !== undefined) {
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw new Error('maxRetries must be an integer between 0 and 3');
    input.maxRetries = maxRetries;
  }
  return input;
}
function materializeInlineChecks(checks, contextStore) {
  return checks.map(check => {
    if (check.type !== 'node_test' || typeof check.testScript !== 'string' || !check.testScript.trim()) return check;
    const saved = contextStore.addSource({
      text: check.testScript,
      kind: 'trusted-acceptance-test',
      label: `inline-node-test:${check.path}`.slice(0, 120),
    });
    const out = { type: 'node_test', path: check.path, sourceId: saved.id, sha256: saved.sha256 };
    if (check.timeoutMs !== undefined) out.timeoutMs = check.timeoutMs;
    return out;
  });
}
function validateSources({ sourceIds, checks }, contextStore) {
  const known = new Set(contextStore?.listSources().map(source => source.id));
  if (sourceIds.some(id => !known.has(id))) throw new Error('Unknown source');
  for (const check of checks.filter(check => check.type === 'node_test')) {
    if (contextStore === null && typeof check.testScript === 'string' && check.testScript.trim()) continue;
    if (!known.has(check.sourceId)) throw new Error('Unknown node_test source in task scope');
    validateTestSource(contextStore, check);
  }
}
function newTask(input, team, id = randomUUID()) {
  const task = { id, ...clone(input), revision: 0, state: 'queued', control: 'run', cwd: null, threadId: null, turnId: null, attemptId: null, model: null, effort: null, summary: null, verification: null, error: null, runtimeError: null, executionUnresolved: false, createdAt: now(), updatedAt: now() };
  if (team && team.control !== 'run') {
    task.control = team.control; task.state = team.control === 'pause' ? 'paused' : 'cancelled';
    if (team.control === 'pause') task.teamPauseOrigin = { teamId: team.id, priorControl: 'run' };
  }
  return task;
}
function teamPlan(tasks, members) {
  if (!Array.isArray(tasks) || tasks.length > 24) throw new Error('Plan tasks must be an array of up to 24 tasks');
  const names = new Set(members.map(member => member.name));
  if (tasks.length && names.size !== members.length) throw new Error('Plan member names must be unique');
  const allowed = new Set(['key', 'member', 'title', 'goal', 'dependsOn', 'difficulty', 'checks', 'priority', 'writeScopes', 'autoAccept', 'maxRetries']);
  const dependencies = new Map();
  const plan = Array.from(tasks, entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !allowed.has(key))) throw new Error('Invalid plan task fields');
    const { key, member } = entry;
    if (typeof key !== 'string' || !key.trim() || key.length > 100) throw new Error('Plan task key must have 1..100 characters');
    if (dependencies.has(key)) throw new Error(`Duplicate plan task key: ${key}`);
    if (!names.has(member)) throw new Error(`Unknown plan task member for ${key}`);
    const input = taskInput(entry);
    validateSources(input, null); // A new team has no registered sources.
    if (new Set(input.dependsOn).size !== input.dependsOn.length) throw new Error(`Duplicate plan dependency for ${key}`);
    dependencies.set(key, input.dependsOn);
    return { key, member, ...input };
  });
  const visiting = new Set(), done = new Set();
  function visit(key) {
    if (done.has(key)) return;
    if (!dependencies.has(key)) throw new Error('Unknown plan task dependency');
    if (visiting.has(key)) throw new Error(`Cyclic plan dependency at ${key}`);
    visiting.add(key);
    for (const dependency of dependencies.get(key)) visit(dependency);
    visiting.delete(key); done.add(key);
  }
  for (const key of dependencies.keys()) visit(key);
  return plan;
}

export class Engine extends EventEmitter {
  constructor({ dataDir, adapter, contextStore, maxConcurrent = 2, packetBudgetBytes = 16384, resultBudgetBytes = 4096, retryBaseDelayMs = 1500 }) {
    super();
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be a positive integer');
    this.dataDir = path.resolve(dataDir); this.adapter = adapter; this.contextStore = contextStore;
    this.maxConcurrent = maxConcurrent; this.packetBudgetBytes = packetBudgetBytes; this.resultBudgetBytes = resultBudgetBytes;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.handles = new Map(); this.closed = false;
    this.recoveryInFlight = new Map();
    this.teamContexts = new Map();
    this.verifying = new Map();
    this.finishing = new Map();
    this.liveActivity = new Map();
  }
  setMaxConcurrent(value) {
    this._ready();
    if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error('maxConcurrent must be an integer between 1 and 8');
    this.maxConcurrent = value;
    const file = path.join(this.dataDir, 'engine-settings.json');
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, maxConcurrent: value, updatedAt: now() }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    this.emit('change', { type: 'settings-updated', maxConcurrent: value });
    this.runDue().catch(() => {});
    return { maxConcurrent: value };
  }
  archiveTeam(id, archived = true) {
    if (typeof archived !== 'boolean') throw new Error('archived must be boolean');
    const team = this._team(id);
    team.archived = archived;
    this._saveTeam(team, archived ? 'team-archived' : 'team-unarchived');
    return this.getTeam(id);
  }
  bindTeamSession(id, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 180) throw new Error('Valid sessionId is required');
    const team = this._team(id);
    const clean = sessionId.trim();
    if (team.sessionId === clean) return this.getTeam(id);
    team.sessionId = clean;
    this._saveTeam(team, 'team-session-bound');
    return this.getTeam(id);
  }
  async initialize({ connectInBackground = false } = {}) {
    if (this.store) return this;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dataDir = fs.realpathSync(this.dataDir);
    this.store = new Store(this.dataDir);
    try {
      for (const task of this.store.tasks()) {
        if (task.threadId && task.executionKind !== 'native') this.adapter.authorizeThread?.(task.threadId);
        if (executing.has(task.state)) {
          task.state = 'unknown'; task.executionUnresolved = true;
          task.error = 'Engine restarted with unresolved execution; inspect before any retry';
          this._save(task, 'restart-unknown');
        }
      }
      await this._syncTeamIntents();
      // Local state and the dashboard remain available while the host handshakes.
      this.initialConnection = (async () => {
        try { await this.adapter.connect(); this.connectionError = null; }
        catch (error) { this.connectionError = error.message; }
      })();
      if (!connectInBackground) await this.initialConnection;
      this.timer = setInterval(() => { this.runDue().catch(error => this.emit('diagnostic', { error: error.message })); }, 250);
      this.timer.unref();
      return this;
    } catch (error) { this.store.close(); this.store = null; throw error; }
  }
  _ready() { if (!this.store || this.closed) throw new Error('Engine is not open'); }
  _task(id) { this._ready(); const task = this.store.get(id); if (!task) throw new Error('Task not found'); return task; }
  _team(id) { this._ready(); const team = this.store.team(id); if (!team) throw new Error('Team not found'); return team; }
  contextForTeam(teamId) {
    this._team(teamId);
    if (!this.teamContexts.has(teamId)) this.teamContexts.set(teamId, new ContextStore(path.join(this.contextStore.rootDir, 'teams', teamId)));
    return this.teamContexts.get(teamId);
  }
  _contextForTask(task) { return task.teamId ? this.contextForTeam(task.teamId) : this.contextStore; }
  _mayRun(task) { return task.control === 'run' && (!task.teamId || this.store.team(task.teamId)?.control === 'run'); }
  _saveTeam(team, type) {
    team.revision++; team.updatedAt = now(); this.store.saveTeam(team);
    this.emit('change', { teamId: team.id, revision: team.revision, type, control: team.control });
  }
  createTeam({ requestId, name, goal, members, tasks, sessionId }) {
    this._ready();
    if ([requestId, name, goal].some(value => typeof value !== 'string' || !value.trim())) throw new Error('Team requestId, name and goal are required');
    if (name.length > 200 || goal.length > 16000) throw new Error('Team name or goal exceeds the supported length');
    if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 180)) throw new Error('Invalid sessionId');
    if (!Array.isArray(members) || members.length < 1 || members.length > 12 || members.some(member => !member || ['name', 'role', 'responsibility'].some(key => typeof member[key] !== 'string' || !member[key].trim()) || member.name.length > 100 || member.role.length > 200 || member.responsibility.length > 8000)) throw new Error('Team requires 1..12 members with bounded name, role and responsibility');
    const input = { name, goal, members: members.map(({ name, role, responsibility }) => ({ name, role, responsibility })) };
    const plan = tasks === undefined ? undefined : teamPlan(tasks, input.members);
    const fingerprint = hash(JSON.stringify(canonical(plan === undefined ? input : { ...input, tasks: plan })));
    const prior = this.store.teamRequest(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Team requestId already used with different parameters');
      return this.getTeam(prior.teamId);
    }
    const cleanSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    const team = { id: randomUUID(), requestId, ...clone(input), ...(cleanSessionId ? { sessionId: cleanSessionId } : {}), members: input.members.map(member => ({ id: randomUUID(), ...member })), control: 'pause', revision: 1, createdAt: now(), updatedAt: now() };
    let planned = [];
    if (plan !== undefined) {
      const taskIds = new Map(plan.map(({ key }) => [key, randomUUID()]));
      const memberIds = new Map(team.members.map(({ name, id }) => [name, id]));
      let teamStore = null;
      const ensureTeamStore = () => {
        if (!teamStore) {
          teamStore = new ContextStore(path.join(this.contextStore.rootDir, 'teams', team.id));
          this.teamContexts.set(team.id, teamStore);
        }
        return teamStore;
      };
      team.planTasks = plan.map(({ key, member }) => ({ key, taskId: taskIds.get(key), memberId: memberIds.get(member) }));
      planned = plan.map(({ key, member, dependsOn, ...fields }) => {
        const hasInline = fields.checks?.some(c => c.type === 'node_test' && typeof c.testScript === 'string');
        const resolvedChecks = hasInline ? materializeInlineChecks(fields.checks, ensureTeamStore()) : fields.checks;
        const resolvedFields = { ...fields, checks: resolvedChecks };
        if (hasInline) validateSources(resolvedFields, ensureTeamStore());
        const created = newTask({
          ...resolvedFields, teamId: team.id, memberId: memberIds.get(member), dependsOn: dependsOn.map(key => taskIds.get(key)),
        }, team, taskIds.get(key));
        if (cleanSessionId) created.sessionId = cleanSessionId;
        return created;
      });
    }
    const changes = this.store.transaction(() => {
      this.store.saveTeam(team);
      this.store.addTeamRequest(requestId, fingerprint, team.id);
      return planned.map(task => this._writeChange(task, 'submitted-to-queue'));
    });
    this.emit('change', { teamId: team.id, revision: team.revision, type: 'team-created', control: team.control });
    for (const change of changes) this.emit('change', change);
    return this.getTeam(team.id);
  }
  getTeam(id) {
    const team = this._team(id);
    const rawTasks = this.store.teamTasks(id);
    const tasks = rawTasks.map(task => taskSummary(task, this.liveActivity.get(task.id) ?? null));
    const graph = serializeTaskGraph(analyzeTaskGraph(rawTasks));
    const members = team.members.map(member => {
      const assigned = tasks.filter(task => task.memberId === member.id);
      const state = memberStatePriority.find(state => assigned.some(task => task.state === state)) ?? assigned[0]?.state ?? 'unassigned';
      const active = assigned.filter(task => executing.has(task.state) || task.executionUnresolved);
      const representative = active.length === 1 ? active[0] : active.length > 1 ? null : assigned.filter(task => task.state === state).at(-1);
      return { ...member, taskIds: assigned.map(task => task.id), activeTaskIds: active.map(task => task.id), tasks: assigned, state, model: representative?.model ?? null, effort: representative?.effort ?? null };
    });
    return { ...team, archived: Boolean(team.archived), members, tasks, counts: countsOf(tasks), graph };
  }
  getTeamGraph(id) {
    this._team(id);
    return serializeTaskGraph(analyzeTaskGraph(this.store.teamTasks(id)));
  }
  listTeams() {
    this._ready(); const counts = this.store.teamStateCounts();
    return this.store.teams().map(({ id, name, control, archived, revision, createdAt, updatedAt, members }) => ({ id, name, control, archived: Boolean(archived), revision, createdAt, updatedAt, memberCount: members.length, counts: counts.get(id) ?? {} }));
  }
  async teamControl(id, action) {
    const team = this._team(id);
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('Unsupported team control action');
    if (team.control === 'cancel' && action !== 'cancel') throw new Error('Cancelled teams cannot be resumed or paused');
    if (team.control !== 'cancel') {
      team.control = action === 'resume' ? 'run' : action;
      this._saveTeam(team, `team-control-${action}`);
    }
    const outcomes = await this._applyTeamIntent(id, false);
    if (action === 'resume') this.runDue().catch(() => {});
    return { team: this.getTeam(id), outcomes };
  }
  async _applyTeamIntent(id, background) {
    const outcomes = [];
    let team = this._team(id);
    for (const original of this.store.teamTasks(id)) {
      let quickAction;
      if (!teamPreserved.has(original.state)) {
        if (team.control === 'pause' && original.control === 'run') quickAction = 'pause';
        if (team.control === 'cancel' && original.control !== 'cancel') quickAction = 'cancel';
        if (team.control === 'run' && original.control === 'pause' && original.teamPauseOrigin?.teamId === id && !(background && original.executionUnresolved)) quickAction = 'resume';
      }
      if (!quickAction) { outcomes.push({ taskId: original.id, status: 'skipped' }); continue; }
      const task = this.store.get(original.id);
      team = this._team(id);
      let action;
      if (!teamPreserved.has(task.state)) {
        if (team.control === 'pause' && task.control === 'run') action = 'pause';
        if (team.control === 'cancel' && task.control !== 'cancel') action = 'cancel';
        if (team.control === 'run' && task.control === 'pause' && task.teamPauseOrigin?.teamId === id && !(background && task.executionUnresolved)) action = 'resume';
      }
      if (!action) { outcomes.push({ taskId: task.id, status: 'skipped' }); continue; }
      try { await this.control(task.id, action, { teamId: id }); outcomes.push({ taskId: task.id, status: 'applied' }); }
      catch (error) { outcomes.push({ taskId: task.id, status: 'failed', error: error.message }); }
    }
    return outcomes;
  }
  async _syncTeamIntents() { for (const team of this.store.teams()) await this._applyTeamIntent(team.id, true); }
  _writeChange(task, type, detail) {
    if (task.state !== 'blocked') task.blockReason = null;
    task.updatedAt = now(); task.revision++;
    this.store.save(task);
    const event = this.store.event(task.id, { type, at: task.updatedAt, state: task.state, blockReason: task.blockReason ?? null, error: task.error ?? null, attemptId: task.attemptId, ...detail });
    return { taskId: task.id, revision: task.revision, seq: event.seq, type, state: task.state };
  }
  _save(task, type, detail = {}) {
    const change = this.store.transaction(() => this._writeChange(task, type, detail));
    this.emit('change', change);
    return clone(task);
  }
  submit({ requestId, teamId, memberId, sessionId, ...fields }) {
    this._ready();
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('requestId, title and goal are required');
    if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 180)) throw new Error('Invalid sessionId');
    const input = taskInput(fields);
    let team;
    if (teamId !== undefined || memberId !== undefined) {
      if (typeof teamId !== 'string' || typeof memberId !== 'string') throw new Error('teamId and memberId must be supplied together');
      team = this._team(teamId);
      if (!team.members.some(member => member.id === memberId)) throw new Error('Member does not belong to team');
      Object.assign(input, { teamId, memberId });
    }
    const fingerprint = hash(JSON.stringify(canonical(input)));
    const prior = this.store.request(requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('requestId already used with different parameters'); return this.get(prior.taskId); }
    if (team?.control === 'cancel') throw new Error('Cancelled teams cannot accept new tasks');
    for (const id of input.dependsOn) if (this._task(id).teamId !== teamId) throw new Error('Dependencies must belong to the same team or legacy scope');
    const targetContext = this._contextForTask(input);
    if (input.checks.some(c => c.type === 'node_test' && typeof c.testScript === 'string')) {
      input.checks = materializeInlineChecks(input.checks, targetContext);
    }
    validateSources(input, targetContext);
    const task = newTask(input, team);
    const cleanSession = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : (team?.sessionId ?? null);
    if (cleanSession) task.sessionId = cleanSession;
    if (teamId && this.nativeCoordinator?.list(teamId).some(binding => binding.role === 'member' && binding.memberId === memberId)) task.executionKind = 'native';
    const change = this.store.transaction(() => {
      this.store.addRequest(requestId, fingerprint, task.id);
      return this._writeChange(task, 'submitted-to-queue');
    });
    this.emit('change', change);
    return clone(task);
  }
  list() {
    this._ready();
    return this.store.tasks().map(task => taskSummary(task, this.liveActivity.get(task.id) ?? null));
  }
  get(id) {
    const task = this._task(id);
    const live = this.liveActivity.get(id);
    return live ? { ...task, lastActivity: live } : task;
  }
  unresolvedTasks() { this._ready(); return this.store.unresolvedTasks(); }
  status(unresolved = this.unresolvedTasks()) {
    this._ready();
    const pending = unresolved.filter(task => task.executionUnresolved && !executing.has(task.state));
    const eligible = pending.filter(task => task.threadId && (task.turnId || task.executionKind === 'native' && task.nativeMarker));
    const errors = pending.filter(task => task.recovery?.error).sort((a, b) => b.recovery.at.localeCompare(a.recovery.at));
    return {
      maxConcurrent: this.maxConcurrent,
      activeSlots: unresolved.length,
      pendingReconciliations: pending.length,
      uninspectableReconciliations: pending.length - eligible.length,
      recovering: this.recoveryInFlight.size,
      nextRecoveryAt: eligible.length ? new Date(Math.min(...eligible.map(task => task.recovery?.nextAt ?? Date.now()))).toISOString() : null,
      lastRecoveryError: errors[0]?.recovery.error ?? null,
      recoveryErrorCount: errors.length,
      connectionError: this.connectionError ?? null,
    };
  }
  events(id, { after = 0, limit = 100 } = {}) {
    this._task(id);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid event page');
    const items = this.store.events(id, after, limit);
    return { items, nextAfter: items.at(-1)?.seq ?? after };
  }
  async result(id, { offset = 0, limit = 8192 } = {}) {
    const task = this._task(id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 4 || limit > 65536) throw new Error('Invalid result page');
    if (!task.resultFile) return { text: '', offset, nextOffset: null, totalBytes: 0 };
    const page = task.acceptance?.snapshotId
      ? await readSnapshotResult({ root: path.join(this.dataDir, 'artifact-snapshots'), id: task.acceptance.snapshotId, offset, limit })
      : await readVerifiedFilePage({ filename: secureFile(this.dataDir, task.resultFile), sha256: task.resultSha256, offset, limit });
    if (page.sha256 !== task.resultSha256) throw new Error('Stored result hash mismatch');
    return page;
  }
  async runDue() {
    this._ready();
    if (this.pumping) { this.pumpAgain = true; return this.pumping; }
    this.pumping = (async () => {
      do {
        this.pumpAgain = false;
        await this._syncTeamIntents(); if (this.closed) return;
        this._recoverDue(); await this._pump();
      } while (this.pumpAgain && !this.closed);
    })();
    try { await this.pumping; }
    finally {
      this.pumping = null;
      if (this.pumpAgain && !this.closed) { this.pumpAgain = false; this.runDue().catch(() => {}); }
    }
  }
  async _pump() {
    const allTasks = this.store.tasks();
    const byId = new Map(allTasks.map(task => [task.id, task]));
    const teamControlMap = new Map(this.store.teams().map(team => [team.id, team.control]));
    const mayRunSnap = task => task.control === 'run' && (!task.teamId || teamControlMap.get(task.teamId) === 'run');
    const nowMs = Date.now();
    for (const task of allTasks) {
      if (!['queued', 'blocked'].includes(task.state) || !mayRunSnap(task)) continue;
      if (task.dependsOn.every(id => byId.get(id)?.state === 'accepted')) continue;
      const dependencyReason = task.dependsOn.some(id => byId.get(id)?.state === 'abandoned') ? 'dependency-abandoned' : 'dependency';
      if (task.state !== 'blocked' || task.blockReason !== dependencyReason) {
        task.state = 'blocked'; task.blockReason = dependencyReason; task.error = null;
        byId.set(task.id, this._save(task, 'dependency-wait'));
      }
    }
    const candidates = allTasks.filter(task => ['queued', 'blocked'].includes(task.state) && mayRunSnap(task) && task.dependsOn.every(id => byId.get(id)?.state === 'accepted') && !(task.nextRetryAt && task.nextRetryAt > nowMs));
    if (!candidates.length) return;
    if (allTasks.filter(task => executing.has(task.state) || task.executionUnresolved).length >= this.maxConcurrent) return;
    const ordered = rankReadyCandidates(candidates, allTasks);
    let defaultModels;
    try { defaultModels = await this.adapter.models(); this.connectionError = null; }
    catch (error) { defaultModels = []; this.connectionError = error.message; }
    if (this.closed) return;
    const sessionModelsCache = new Map();
    const activeScopeHolders = allTasks.filter(item => (executing.has(item.state) || item.executionUnresolved) && item.writeScopes?.length);
    for (const candidate of ordered) {
      let task = this.store.get(candidate.id);
      if (!['queued', 'blocked'].includes(task.state) || !this._mayRun(task)) continue;
      if (task.nextRetryAt && task.nextRetryAt > Date.now()) continue;
      if (!task.dependsOn.every(id => this.store.get(id)?.state === 'accepted')) continue;
      const occupied = this.store.tasks().filter(item => executing.has(item.state) || item.executionUnresolved).length;
      if (occupied >= this.maxConcurrent) break;
      if (task.writeScopes?.length) {
        const teamScopeKey = task.teamId ?? '__legacy__';
        const conflictHolder = activeScopeHolders.find(holder => holder.id !== task.id && (holder.teamId ?? '__legacy__') === teamScopeKey && taskScopesOverlap(holder.writeScopes, task.writeScopes));
        if (conflictHolder) {
          if (task.state !== 'blocked' || task.blockReason !== 'write-scope-lock') {
            task.state = 'blocked'; task.blockReason = 'write-scope-lock'; task.error = null;
            this._save(task, 'write-scope-wait', { lockedByTaskId: conflictHolder.id });
          }
          continue;
        }
      }
      const effectiveSessionId = task.sessionId ?? (task.teamId ? this.store.team(task.teamId)?.sessionId : null) ?? null;
      let models = defaultModels;
      if (effectiveSessionId) {
        if (!sessionModelsCache.has(effectiveSessionId)) {
          try { sessionModelsCache.set(effectiveSessionId, await this.adapter.models({ sessionId: effectiveSessionId })); }
          catch { sessionModelsCache.set(effectiveSessionId, defaultModels); }
        }
        models = sessionModelsCache.get(effectiveSessionId) ?? defaultModels;
      }
      let native = null;
      try {
        const bound = task.teamId && task.memberId && this.nativeCoordinator?.list(task.teamId).some(binding => binding.role === 'member' && binding.memberId === task.memberId);
        if (bound || task.executionKind === 'native') {
          if (task.executionKind !== 'native') { task.executionKind = 'native'; this._save(task, 'native-routing-selected'); }
          if (!this.nativeAdapter) throw new Error('Native execution adapter is unavailable; no independent execution fallback');
          native = await this.nativeAdapter.preflight(task);
          if (this.store.tasks().some(other => other.id !== task.id && other.executionUnresolved && other.executionKind === 'native' && (other.nativeBindingId === native.binding.id || other.nativeThreadId === native.binding.threadId && (other.nativeHostId ?? 'local') === (native.binding.hostId ?? 'local')))) throw Object.assign(new Error('Native binding still has an unresolved execution'), { blockReason: 'preflight' });
          task = this.store.get(task.id);
          if (!['queued', 'blocked'].includes(task.state) || !this._mayRun(task)) continue;
        }
      } catch (error) {
        task = this.store.get(task.id);
        if (!['queued', 'blocked'].includes(task.state) || !this._mayRun(task)) continue;
        const blockReason = error.blockReason ?? 'preflight';
        if (task.state !== 'blocked' || task.error !== error.message || task.blockReason !== blockReason) { task.state = 'blocked'; task.blockReason = blockReason; task.error = error.message; this._save(task, 'native-blocked'); }
        continue;
      }
      const selection = this._chooseModel(models, task.difficulty);
      if (!selection) { if (task.error !== 'No usable model and reasoning effort returned by adapter.models' || task.blockReason !== 'preflight') { task.state = 'blocked'; task.blockReason = 'preflight'; task.error = 'No usable model and reasoning effort returned by adapter.models'; this._save(task, 'model-blocked'); } continue; }
      const preparationRevision = task.revision;
      let preparedWorkspace = null, preserveWorkspace = false;
      try {
        const dependencyContext = await this._dependencyContext(task);
        if (this.closed || this.store.get(task.id)?.revision !== preparationRevision || !this._mayRun(this.store.get(task.id))) continue;
        const context = this._contextForTask(task);
        const registeredSources = context.listSources();
        const sourceIds = [...new Set([...task.sourceIds, ...dependencyContext.sourceIds, ...registeredSources.filter(source => source.critical || source.kind === 'ruling').map(source => source.id)])];
        context.verifySources(sourceIds);
        const acceptance = task.checks.length ? `\n\nREQUIRED ARTIFACT ACCEPTANCE CHECKS\nProduce these files within this attempt workspace and satisfy every exact check below. These checks are required and are not excerpts.\n${JSON.stringify(task.checks)}\nEND REQUIRED ARTIFACT ACCEPTANCE CHECKS\n` : '';
        const team = task.teamId ? this._team(task.teamId) : null;
        const assignment = team ? `\n\nTEAM ASSIGNMENT\n${JSON.stringify({ id: team.id, name: team.name, goal: team.goal, member: team.members.find(member => member.id === task.memberId) })}\nEND TEAM ASSIGNMENT\n` : '';
        const scopeSection = task.writeScopes?.length ? `\n\nWRITE SCOPE OWNERSHIP\nPrefer restricting edits and generated artifacts to your declared write scopes: ${JSON.stringify(task.writeScopes)}. Avoid modifying files owned by parallel teammates unless explicitly required.\nEND WRITE SCOPE OWNERSHIP\n` : '';
        const goal = task.goal;
        const priorFailureItems = (task.reworkPriorFailures ?? []).slice(0, 6).map(item => `- [${item.type}] ${item.path}: ${String(item.error ?? 'failed').slice(0, 180)}`);
        const priorFailureBlock = priorFailureItems.length ? `\nPrior verification failures to fix:\n${bounded(priorFailureItems.join('\n'), 1200).text}` : '';
        const reworkSection = task.reworkFeedback ? `\n\nREWORK FEEDBACK FROM REVIEWER (Revision #${task.reworkCount ?? 1})\nAddress every item below carefully in this new attempt workspace:\n${task.reworkFeedback}${priorFailureBlock}\nEND REWORK FEEDBACK\n` : '';
        const requiredSections = [{ id: 'team', text: assignment }, { id: 'write-scopes', text: scopeSection }, ...dependencyContext.sections, { id: 'rework', text: reworkSection }, { id: 'checks', text: acceptance }].filter(section => section.text);
        // The fixed materialization schema permits an exact budget preflight
        // before creating directories. Budget failures must not create a new
        // orphan workspace on every scheduler poll.
        const plannedManifest = sourceIds.length ? { version: 1, root: 'context-sources', sources: sourceIds.map(id => ({ ...registeredSources.find(source => source.id === id), path: `context-sources/${id}.txt` })) } : undefined;
        const plannedPacket = context.buildPacket({ goal, requiredSections, sourceIds, budgetBytes: this.packetBudgetBytes, manifest: plannedManifest });
        const attemptId = randomUUID();
        const relative = path.join('workspaces', task.id, attemptId);
        const cwd = path.join(this.dataDir, relative);
        // Reject a replaced ancestor before creating an attempt directory.
        let current = this.dataDir;
        for (const segment of relative.split(path.sep)) {
          current = path.join(current, segment);
          if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Workspace ancestor is a symbolic link');
          if (current === cwd) { fs.mkdirSync(current); const info = fs.lstatSync(current); preparedWorkspace = { cwd, relative, dev: info.dev, ino: info.ino }; }
          else fs.mkdirSync(current, { recursive: true });
        }
        const contextManifest = sourceIds.length ? context.materializeSources(sourceIds, cwd) : null;
        const dependencyManifest = await this._materializeDependencies(dependencyContext, cwd);
        this._assertDependencyBindings(task, dependencyContext.versions);
        const packet = contextManifest ? context.buildPacket({ goal, requiredSections, sourceIds, budgetBytes: this.packetBudgetBytes, manifest: contextManifest }) : plannedPacket;
        task = this.store.get(task.id);
        if (this.closed || task.revision !== preparationRevision || !this._mayRun(task) || !['queued', 'blocked'].includes(task.state)) continue;
        Object.assign(task, { state: 'dispatching', attemptId, cwd, ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}), threadId: null, turnId: null, ...selection, dependencyVersions: dependencyContext.versions, dependencyManifest, contextManifest, packetBytes: packet.bytes, packetRequiredBytes: packet.requiredBytes, budgetBreakdown: packet.budgetBreakdown, budgetDetails: null, error: null, runtimeError: null, executionUnresolved: true, verification: null, summary: null, resultFile: null, resultSha256: null, completionStatus: null, recovery: null, nextRetryAt: null, startedAt: now(), finishedAt: null, durationMs: null });
        if (native) Object.assign(task, { executionKind: 'native', nativeBindingId: native.binding.id, nativeBindingRevision: native.binding.revision,
          nativeThreadId: native.binding.threadId, nativeHostId: native.binding.hostId ?? 'local', nativeOriginThreadId: native.binding.originThreadId,
          nativeMarker: `[SUPERAGENT_NATIVE_TASK:${task.id}:${attemptId}]`, nativeAfterCursor: native.snapshot.cursor ?? null,
          threadId: native.binding.threadId, modelReason: selection.modelReason + '; requested native settings only, effective chat configuration unverified' });
        // Preserve the workspace once persistence is attempted: a failed return
        // cannot prove that no dispatch intent was committed.
        preserveWorkspace = true;
        this._save(task, 'dispatch-intent', { packetBytes: packet.bytes, sourceIds });
        if (task.writeScopes?.length) activeScopeHolders.push(task);
        // This call immediately invokes adapter.start; no awaited gap after permission.
        this._dispatch(task, packet.text);
      } catch (error) {
        if (this.closed || this.store.get(task.id)?.revision !== preparationRevision) continue;
        task = this.store.get(task.id);
        if (task.state !== 'blocked' || task.error !== error.message || task.blockReason !== 'preflight') {
          task.state = 'blocked'; task.blockReason = 'preflight'; task.error = error.message;
          task.budgetDetails = error.code === 'CONTEXT_BUDGET_EXCEEDED' ? Object.fromEntries(['code', 'budgetBytes', 'requiredBytes', 'overByBytes', 'budgetBreakdown'].map(key => [key, error[key]])) : null;
          this._save(task, 'preflight-blocked');
        }
      } finally {
        if (preparedWorkspace && !preserveWorkspace && fs.existsSync(preparedWorkspace.cwd)) {
          try {
            const expected = path.resolve(this.dataDir, preparedWorkspace.relative);
            if (expected !== preparedWorkspace.cwd || path.relative(this.dataDir, expected) !== preparedWorkspace.relative) throw new Error('Unsafe prepared workspace cleanup path');
            let current = this.dataDir;
            for (const segment of preparedWorkspace.relative.split(path.sep)) {
              current = path.join(current, segment);
              const info = fs.lstatSync(current);
              if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Prepared workspace cleanup path was replaced');
            }
            if (fs.realpathSync(expected) !== expected) throw new Error('Prepared workspace cleanup path was linked');
            const info = fs.lstatSync(expected);
            if (info.dev !== preparedWorkspace.dev || info.ino !== preparedWorkspace.ino) throw new Error('Prepared workspace cleanup identity changed');
            fs.rmSync(expected, { recursive: true });
          } catch (error) { this.emit('diagnostic', { error: `Unused prepared workspace retained: ${error.message}` }); }
        }
      }
    }
  }
  _chooseModel(models, difficulty) {
    const usable = (Array.isArray(models) ? models : []).filter(model => typeof model.model === 'string' && model.model && Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length);
    if (!usable.length) return null;
    const ranked = [...usable].sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false));
    const light = ranked.find(model => /(?:^|[-_. /])(?:flash|lite|mini|nano|luna)(?:$|[-_. /])/i.test(model.model));
    const model = ['low', 'easy'].includes(difficulty) && light ? light : ranked[0];
    const efforts = model.supportedReasoningEfforts.map(item => typeof item === 'string' ? item : item.reasoningEffort).filter(Boolean);
    const preferences = ['low', 'easy'].includes(difficulty) ? ['low', 'minimal', 'medium', 'high', 'default'] : ['high', 'hard'].includes(difficulty) ? ['high', 'xhigh', 'medium', 'low', 'default'] : ['medium', 'low', 'high', 'minimal', 'default'];
    const effort = preferences.find(value => efforts.includes(value)) ?? efforts[0];
    return effort ? { model: model.model, effort, modelReason: model === light && ['low', 'easy'].includes(difficulty) ? 'Low difficulty: lightweight model explicitly present in host model list; supported effort selected' : 'Host default/first usable model; difficulty selects a supported reasoning effort' } : null;
  }
  async _dependencyContext(task) {
    const versions = [], sourceIds = [], manifests = [], snapshots = [];
    for (const id of task.dependsOn) {
      const parent = this.store.get(id);
      if (parent?.state !== 'accepted') throw new Error('Dependency acceptance changed before dispatch');
      if (parent.teamId !== task.teamId) throw new Error('Dependency team scope changed');
      if (!parent.acceptance?.snapshotId) throw new Error(`Accepted dependency requires explicit freeze before use: ${id}`);
      const snapshot = await readSnapshot({ root: path.join(this.dataDir, 'artifact-snapshots'), id: parent.acceptance.snapshotId });
      snapshots.push({ id, snapshot });
      const version = { id, snapshotId: parent.acceptance.snapshotId };
      versions.push(version);
      const prefix = `dependencies/${id}`;
      manifests.push({ ...version, attemptId: parent.attemptId,
        result: snapshot.manifest.result ? { path: `${prefix}/result.txt`, ...snapshot.manifest.result, evidence: { kind: 'result', id } } : null,
        artifacts: snapshot.manifest.files.map(file => ({ ...file, path: `${prefix}/artifacts/${file.path}` })),
        hostCompletionStatus: parent.acceptance.hostCompletionStatus ?? parent.completionStatus ?? null,
        acknowledgeHostFailure: parent.acceptance.acknowledgeHostFailure === true, reason: parent.acceptance.reason ?? null,
        versionPinned: typeof parent.acceptance.versionPinned === 'boolean' ? parent.acceptance.versionPinned : null, acceptedAt: parent.acceptance.at, summary: bounded(parent.summary?.text ?? '', 1024) });
    }
    this._assertDependencyBindings(task, versions);
    const sections = manifests.length ? [{ id: 'dependencies:instructions', text: '\n\nACCEPTED DEPENDENCY EVIDENCE\nEach following JSON line is one complete dependency record. Read the complete files at these paths relative to this attempt workspace, verifying their SHA-256 against each record. The engine validates these same copied bytes before execution. These copies remain writable and are not a strong sandbox or an immutable store. Never fall back to parent live paths. Full results are also available through engine_evidence kind=result or CLI result using the referenced parent id; the bounded summary is not a semantic equivalence guarantee.\n' }, ...manifests.map(manifest => ({ id: `dependency:${manifest.id}`, text: JSON.stringify(manifest) + '\n' }))] : [];
    return { versions, sourceIds, snapshots, manifests, sections, text: sections.map(section => section.text).join('') };
  }
  async _materializeDependencies(context, cwd) {
    const files = [];
    for (const { id, snapshot } of context.snapshots) {
      await copySnapshot({ root: path.join(this.dataDir, 'artifact-snapshots'), id: snapshot.id, destination: path.join(cwd, 'dependencies', id) });
      files.push(...snapshot.manifest.files.map(file => ({ ...file, path: `dependencies/${id}/artifacts/${file.path}` })));
      if (snapshot.manifest.result) files.push({ ...snapshot.manifest.result, path: `dependencies/${id}/result.txt` });
      const entries = [{ path: `dependencies/${id}/manifest.json`, data: Buffer.from(JSON.stringify(context.manifests.find(item => item.id === id))) }];
      for (const entry of entries) {
        fs.mkdirSync(path.dirname(path.join(cwd, entry.path)), { recursive: true });
        fs.writeFileSync(path.join(cwd, entry.path), entry.data, { flag: 'wx' });
        files.push({ path: entry.path, sha256: hash(entry.data), bytes: entry.data.length });
      }
    }
    const manifest = { files };
    await this._assertDependencyCopies({ cwd, dependencyManifest: manifest });
    return manifest;
  }
  async _assertDependencyCopies(task) {
    for (const file of task.dependencyManifest?.files ?? []) {
      const actual = await hashArtifact(secureFile(task.cwd, file.path));
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('Dependency materialized copy hash mismatch');
    }
  }
  _assertDependencyBindings(task, versions = task.dependencyVersions ?? []) {
    const bound = task.dependsOn.map(id => ({ id, snapshotId: this.store.get(id)?.acceptance?.snapshotId }));
    if (JSON.stringify(canonical(bound)) !== JSON.stringify(canonical(versions))) throw new Error('Dependency versions changed since dispatch; a new attempt is required');
    for (const id of task.dependsOn) {
      const parent = this.store.get(id);
      if (parent?.state !== 'accepted' || parent.teamId !== task.teamId) throw new Error('Dependency acceptance or team scope changed');
    }
  }
  async _assertDependencyVersions(task) {
    this._assertDependencyBindings(task);
    for (const version of task.dependencyVersions ?? []) await verifySnapshot({ root: path.join(this.dataDir, 'artifact-snapshots'), id: version.snapshotId });
    await this._assertDependencyCopies(task);
    this._assertDependencyBindings(task);
  }
  async _assertResultVersion(task) {
    if (task.resultFile && (await hashArtifact(secureFile(this.dataDir, task.resultFile))).sha256 !== task.resultSha256) throw new Error('Stored result hash mismatch');
  }
  _current(id, attemptId) {
    if (this.closed || !this.store) return null;
    const task = this.store.get(id);
    return task?.attemptId === attemptId && task.executionUnresolved && (executing.has(task.state) || task.state === 'abandoned' || ['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed'].includes(task.state)) ? task : null;
  }
  async _dispatch(task, prompt) {
    const { id, attemptId } = task;
    try {
      const permission = this._current(id, attemptId);
      if (!permission) return;
      if (!this._mayRun(permission)) {
        this._inheritTeamControl(permission);
        permission.executionUnresolved = false;
        permission.attemptId = null; permission.cwd = null;
        permission.state = permission.control === 'pause' ? 'paused' : 'cancelled';
        this._save(permission, 'dispatch-permission-withdrawn');
        return;
      }
      const executionAdapter = task.executionKind === 'native' ? this.nativeAdapter : this.adapter;
      if (!executionAdapter) throw Object.assign(new Error('Native execution adapter is unavailable'), { executionNotStarted: true, nativeBlocked: true });
      const handle = await executionAdapter.start({ ...task, prompt }, {
        assertNativePermission: () => {
          const current = this._current(id, attemptId);
          if (current?.state !== 'dispatching' || !this._mayRun(current)) throw new Error('Native execution permission withdrawn before send');
        },
        beforeExecute: async () => {
          if (task.executionKind === 'native') await this.nativeAdapter.preflight(task, { bindingId: task.nativeBindingId, bindingRevision: task.nativeBindingRevision });
          const current = this._current(id, attemptId);
          if (!current || !this._mayRun(current)) throw new Error('Execution permission withdrawn before turn start');
          await this._assertDependencyVersions(current);
          const checked = this._current(id, attemptId);
          if (!checked || checked.revision !== current.revision || !this._mayRun(checked)) throw new Error('Execution permission withdrawn during dependency verification');
          if (current.contextManifest) this._contextForTask(current).verifyMaterializedSources(current.contextManifest, current.cwd);
          // Persist the final permission point independently of thread creation.
          this._save(current, 'execution-permitted');
          const stillCurrent = this._current(id, attemptId);
          if (!stillCurrent || !this._mayRun(stillCurrent)) throw new Error('Execution permission withdrawn before turn start');
        },
        onIdentity: async identity => {
          const current = this._current(id, attemptId);
          if (!current) return;
          if (identity.threadId) current.threadId = identity.threadId;
          if (identity.turnId) current.turnId = identity.turnId;
          this._save(current, 'host-identity');
        },
        onEvent: raw => {
          const current = this._current(id, attemptId); if (!current) return;
          const full = JSON.stringify(raw);
          // A worker may create links; never follow them when persisting host data, and cap raw log at 32 MiB per attempt.
          const logDir = this._attemptMetadata(id, attemptId);
          const logFile = path.join(logDir, 'host-events.jsonl');
          const maxHostLogBytes = 32 * 1024 * 1024;
          let appendAllowed = true;
          if (fs.existsSync(logFile)) {
            const logStat = fs.lstatSync(logFile, { bigint: true });
            if (logStat.isSymbolicLink() || !logStat.isFile() || logStat.nlink !== 1n) throw new Error('Host log was linked');
            if (logStat.size >= BigInt(maxHostLogBytes)) appendAllowed = false;
          }
          if (appendAllowed) {
            const line = `${full}\n`;
            fs.appendFileSync(logFile, line);
            const afterStat = fs.lstatSync(logFile, { bigint: true });
            if (afterStat.size >= BigInt(maxHostLogBytes)) {
              fs.appendFileSync(logFile, `${JSON.stringify({ truncated: true, reason: 'host-events log capped at 32 MiB' })}\n`);
            }
          }
          const parsed = summarizeHostEvent(raw);
          if (parsed?.text) {
            this.liveActivity.set(id, { text: parsed.text, at: now() });
            this.emit('activity', { taskId: id, teamId: current.teamId ?? null, text: parsed.text, at: now() });
          }
          if (parsed && parsed.persist === false) return;
          const preview = bounded(full, 2048);
          this.store.event(id, { at: now(), type: 'host-event', attemptId, ...(parsed?.text ? { message: parsed.text } : {}), preview: preview.text, bytes: preview.bytes, truncated: preview.truncated, rawFile: path.relative(this.dataDir, path.join(logDir, 'host-events.jsonl')) });
        }
      });
      let current = this._current(id, attemptId);
      if (!current) { await handle.interrupt().catch(() => {}); return; }
      this.handles.set(id, { attemptId, handle });
      this._inheritTeamControl(current);
      current.threadId ||= handle.threadId ?? null; current.turnId ||= handle.turnId ?? null;
      if (current.control === 'run' && current.state !== 'abandoned') current.state = 'running';
      this._save(current, 'host-started');
      if (current.control !== 'run' && current.state !== 'abandoned') this._interrupt(current);
      const result = await handle.completion;
      current = this._current(id, attemptId); if (!current) return;
      await this._finish(current, result);
    } catch (error) {
      const current = this._current(id, attemptId); if (!current) return;
      this._inheritTeamControl(current);
      current.executionUnresolved = !error.executionNotStarted;
      current.completionStatus = error.executionNotStarted ? 'not-started' : null;
      if (current.state !== 'abandoned') current.state = current.control === 'pause' ? (error.executionNotStarted ? 'paused' : 'paused-unconfirmed') : current.control === 'cancel' ? (error.executionNotStarted ? 'cancelled' : 'cancelled-unconfirmed') : error.executionNotStarted ? 'failed' : 'unknown';
      if (error.nativeBlocked && current.control === 'run') { current.state = 'blocked'; current.blockReason = error.blockReason ?? 'preflight'; }
      current.error = `${error.executionNotStarted ? 'Execution did not start' : 'Execution outcome unknown'}: ${error.message}`;
      current.runtimeError = current.error;
      this._save(current, error.executionNotStarted ? 'execution-not-started' : 'execution-unknown');
    } finally {
      if (this.handles.get(id)?.attemptId === attemptId) this.handles.delete(id);
    }
  }
  _attemptMetadata(id, attemptId) {
    let dirname = this.dataDir;
    for (const segment of ['attempts', id, attemptId]) {
      dirname = path.join(dirname, segment);
      if (fs.existsSync(dirname) && fs.lstatSync(dirname).isSymbolicLink()) throw new Error('Attempt metadata directory was linked');
      fs.mkdirSync(dirname, { recursive: true });
    }
    return dirname;
  }
  async _finish(task, result) {
    const key = `${task.id}:${task.attemptId}`;
    if (this.finishing.has(key)) return this.finishing.get(key);
    const pending = Promise.resolve().then(() => this._finishOnce(task, result));
    this.finishing.set(key, pending);
    try { return await pending; } finally { this.finishing.delete(key); }
  }
  async _finishOnce(task, result) {
    const text = String(result.text ?? '');
    const dirname = this._attemptMetadata(task.id, task.attemptId);
    const filename = path.join(dirname, `result-${randomUUID()}.txt`);
    fs.writeFileSync(filename, text, { flag: 'wx' });
    task.resultFile = path.relative(this.dataDir, filename); task.resultSha256 = hash(text);
    task.summary = bounded(text, this.resultBudgetBytes); task.summary.limitations = 'Byte-bounded excerpt, not a semantic equivalence guarantee';
    task.usage = result.usage ?? null;
    task.completionStatus = result.status;
    task.executionUnresolved = !['completed', 'failed'].includes(result.status);
    task.runtimeError = result.error ? errorText(result.error) : null;
    task.error = task.runtimeError;
    if (task.state === 'abandoned') { /* Preserve business abandonment while recording runtime evidence. */ }
    else if (task.control === 'pause') task.state = task.executionUnresolved ? 'paused-unconfirmed' : 'paused';
    else if (task.control === 'cancel') task.state = task.executionUnresolved ? 'cancelled-unconfirmed' : 'cancelled';
    else if (result.status === 'completed') {
      try { task.verification = await this._verify(task); task.state = task.checks.length ? 'checked' : 'submitted'; }
      catch (error) { task.verification = error.verification ?? null; task.state = 'failed'; task.error = error.message; }
    } else task.state = result.status === 'failed' ? 'failed' : 'unknown';
    const finishedAt = now();
    task.finishedAt = finishedAt;
    task.durationMs = task.startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(task.startedAt)) : null;
    if (this.closed) return;
    const current = this._task(task.id);
    if (current.attemptId !== task.attemptId || !current.executionUnresolved || ![...executing, 'unknown', 'paused-unconfirmed', 'cancelled-unconfirmed', 'abandoned'].includes(current.state)) return;
    const abandoned = current.state === 'abandoned';
    // Retain newer control/reconciliation metadata; only this attempt's result may be merged.
    for (const key of ['resultFile', 'resultSha256', 'summary', 'usage', 'completionStatus', 'executionUnresolved', 'runtimeError', 'error', 'verification', 'state', 'finishedAt', 'durationMs']) current[key] = task[key];
    task = current;
    if (abandoned) task.state = 'abandoned';
    else if (task.control === 'pause') task.state = task.executionUnresolved ? 'paused-unconfirmed' : 'paused';
    else if (task.control === 'cancel') task.state = task.executionUnresolved ? 'cancelled-unconfirmed' : 'cancelled';
    this.liveActivity.delete(task.id);
    const willAutoRetry = !this.closed && !abandoned && result.status === 'failed' && !task.executionUnresolved && !task.verification && task.control === 'run' && task.state === 'failed' && (task.maxRetries ?? 0) > (task.retryCount ?? 0) && this._mayRun(task);
    this._save(task, 'execution-result', { status: result.status, ...(willAutoRetry ? { autoRetryPending: true } : {}) });
    if (!this.closed && !abandoned && task.autoAccept === true && result.status === 'completed' && !task.executionUnresolved && this._mayRun(task) && task.state === 'checked' && task.checks.length > 0 && task.checks.some(check => check.type === 'node_test') && task.verification?.passed === true) {
      try {
        await this.accept(task.id, {
          expectedRevision: task.revision,
          actor: 'engine:auto-verified',
          reason: 'Auto-accepted after all registered verification checks passed',
        });
        return;
      } catch (error) {
        this.emit('diagnostic', { taskId: task.id, error: `Auto-accept skipped: ${error.message}` });
      }
    }
    if (willAutoRetry && !this.closed && this._mayRun(task)) {
      const attemptNum = (task.retryCount ?? 0) + 1;
      const backoffMs = Math.min(30000, this.retryBaseDelayMs * (2 ** (attemptNum - 1)));
      const lastFailure = task.error;
      task.retryCount = attemptNum;
      task.nextRetryAt = Date.now() + backoffMs;
      task.state = 'queued';
      task.blockReason = null;
      task.error = null;
      this._save(task, 'auto-retry-scheduled', { retryCount: attemptNum, maxRetries: task.maxRetries, backoffMs, lastError: lastFailure, nextRetryAt: new Date(task.nextRetryAt).toISOString() });
    }
    this.runDue().catch(() => {});
  }
  async _verify(task) {
    if (this.verifying.has(task.id)) throw new Error('Task verification is already running');
    const pending = verifyArtifacts({ task, sourceStore: this._contextForTask(task), evidenceDir: task.checks.some(check => check.type === 'node_test') ? this._attemptMetadata(task.id, task.attemptId) : null });
    this.verifying.set(task.id, pending);
    try { return await pending; } finally { this.verifying.delete(task.id); }
  }
  _verificationFailure(task, error) {
    if (this.closed || this.verifying.has(task.id) || this._task(task.id).revision !== task.revision) return;
    task.state = 'failed'; task.error = error.message;
    task.verification = error.verification ?? { at: now(), status: 'failed', passed: false, files: [], checks: [], error: error.message };
    this._save(task, 'verification-failed');
  }
  async verify(id) {
    const task = this._task(id);
    if (task.control !== 'run' || task.executionUnresolved || !['failed', 'submitted', 'checked'].includes(task.state) || !task.cwd) throw new Error('Artifact recheck requires a known terminal attempt with run control');
    if (!task.checks.length) throw new Error('Artifact recheck requires built-in checks');
    let verification;
    try { verification = await this._verify(task); }
    catch (error) { this._verificationFailure(task, error); throw error; }
    if (this._task(id).revision !== task.revision) throw new Error('Task changed during verification; recheck required');
    // Preserve host failure even when the existing artifact passes all checks.
    if (task.completionStatus === 'failed') task.runtimeError ??= task.error;
    task.error = task.runtimeError ?? null;
    task.verification = verification; task.state = 'checked';
    return this._save(task, 'artifacts-rechecked', { hostCompletionStatus: task.completionStatus, artifactOnly: verification.artifactOnly });
  }
  async accept(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Acceptance options must be an object');
    const { expectedRevision, acknowledgeHostFailure = false } = options;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('expectedRevision must be a non-negative safe integer');
    if (typeof acknowledgeHostFailure !== 'boolean') throw new Error('acknowledgeHostFailure must be boolean');
    if (options.reason != null && (typeof options.reason !== 'string' || !options.reason.trim() || options.reason.length > 2000)) throw new Error('Acceptance reason must be non-empty and at most 2000 characters');
    if (options.actor !== undefined && (typeof options.actor !== 'string' || !options.actor.trim() || options.actor.length > 200)) throw new Error('Acceptance actor must be non-empty and at most 200 characters');
    const reason = options.reason?.trim() ?? null, actor = options.actor?.trim() ?? 'unknown';
    const task = this._task(id);
    if (expectedRevision !== undefined && expectedRevision !== task.revision) throw new Error('Task revision changed; refresh before acceptance');
    if (!['checked', 'submitted'].includes(task.state) || task.executionUnresolved || task.control !== 'run') throw new Error('Task is not ready for acceptance');
    if (task.checks.length && task.verification?.passed !== true) throw new Error('Task is not ready for acceptance: checks have not passed');
    if (task.completionStatus === 'failed' && !acknowledgeHostFailure) throw new Error('Failed host completion requires acknowledgeHostFailure: true and a reason');
    if (task.completionStatus === 'failed' && !reason) throw new Error('Failed host completion acceptance requires a reason');
    let verification, snapshot;
    try {
      await this._assertDependencyVersions(task);
      await this._assertResultVersion(task);
      if (JSON.stringify(await artifactFiles(task)) !== JSON.stringify(task.verification?.files ?? [])) throw new Error('Artifact hashes changed after verification');
      verification = await this._verify(task);
      if (JSON.stringify(verification.files) !== JSON.stringify(task.verification?.files ?? [])) throw new Error('Artifact hashes changed after verification');
      if (JSON.stringify(await artifactFiles(task)) !== JSON.stringify(verification.files)) throw new Error('Artifact hashes changed during acceptance');
      await this._assertResultVersion(task);
      snapshot = await this._freezeTask(task, verification.files);
      await this._assertDependencyVersions(task);
      await this._assertResultVersion(task);
    } catch (error) { this._verificationFailure(task, error); throw error; }
    if (this._task(id).revision !== task.revision) throw new Error('Task changed during verification; recheck required');
    task.verification = verification; task.state = 'accepted';
    task.acceptance = { at: now(), kind: actor === 'engine:auto-verified' ? 'auto-verified-acceptance' : 'explicit-caller-acceptance', independentQualityGuarantee: false,
      actor, actorAssurance: 'caller-reported', reason, acknowledgeHostFailure, expectedRevision: expectedRevision ?? null, observedRevision: task.revision,
      versionPinned: expectedRevision !== undefined, snapshotId: snapshot.id,
      hostCompletionStatus: task.completionStatus ?? null, attemptId: task.attemptId, resultFile: task.resultFile ?? null, resultSha256: task.resultSha256 ?? null,
      artifacts: clone(verification.files), checks: clone(verification.checks), checkDefinitions: clone(task.checks), verifiedAt: verification.at,
      dependencyVersions: clone(task.dependencyVersions ?? []) };
    const value = this._save(task, 'accepted'); this.runDue().catch(() => {}); return value;
  }
  async acceptAllChecked(teamId, { actor = 'local-http:unidentified' } = {}) {
    const team = this._team(teamId);
    const tasks = this.store.teamTasks(team.id);
    const accepted = [], skipped = [], failed = [];
    for (const task of tasks) {
      if (task.state !== 'checked' || task.executionUnresolved || task.control !== 'run' || task.completionStatus === 'failed' || task.verification?.passed !== true) {
        skipped.push({ taskId: task.id, state: task.state, reason: task.state === 'accepted' ? 'already-accepted' : 'not-verified-eligible' });
        continue;
      }
      try {
        const updated = await this.accept(task.id, {
          expectedRevision: task.revision,
          actor,
          reason: 'Batch-accepted verified task from team overview',
        });
        accepted.push({ taskId: updated.id, title: updated.title, revision: updated.revision, snapshotId: updated.acceptance?.snapshotId ?? null });
      } catch (error) {
        failed.push({ taskId: task.id, title: task.title, error: error.message });
      }
    }
    return { teamId: team.id, accepted, skipped, failed };
  }
  _freezeTask(task, files) {
    return freezeSnapshot({ root: path.join(this.dataDir, 'artifact-snapshots'), cwd: task.cwd,
      resultFile: task.resultFile ? secureFile(this.dataDir, task.resultFile) : null, resultSha256: task.resultSha256,
      files: [...new Map(files.map(file => [file.path, file])).values()] });
  }
  async freeze(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Freeze options must be an object');
    const { expectedRevision } = options;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('expectedRevision must be a non-negative safe integer');
    if (options.actor !== undefined && (typeof options.actor !== 'string' || !options.actor.trim() || options.actor.length > 200)) throw new Error('Freeze actor must be non-empty and at most 200 characters');
    const task = this._task(id);
    if (expectedRevision !== undefined && expectedRevision !== task.revision) throw new Error('Task revision changed; refresh before freeze');
    if (task.state !== 'accepted' || task.executionUnresolved || !task.acceptance) throw new Error('Freeze requires an accepted terminal task');
    if (task.acceptance.snapshotId) {
      await verifySnapshot({ root: path.join(this.dataDir, 'artifact-snapshots'), id: task.acceptance.snapshotId });
      if (this._task(id).revision !== task.revision) throw new Error('Task changed during freeze; refresh required');
      return task;
    }
    const files = task.acceptance.artifacts;
    if (!Array.isArray(files) || task.acceptance.resultSha256 !== task.resultSha256 || task.acceptance.attemptId !== task.attemptId) throw new Error('Recorded acceptance version changed; cannot freeze');
    if (JSON.stringify(await artifactFiles(task, files)) !== JSON.stringify(files)) throw new Error('Recorded acceptance artifact hashes changed; cannot freeze');
    await this._assertResultVersion(task);
    const snapshot = await this._freezeTask(task, files);
    if (this._task(id).revision !== task.revision) throw new Error('Task changed during freeze; refresh required');
    task.acceptance.snapshotId = snapshot.id;
    task.acceptance.snapshotFreeze = { at: now(), actor: options.actor?.trim() ?? 'unknown', actorAssurance: 'caller-reported', observedRevision: task.revision, versionPinned: expectedRevision !== undefined, originalChecksReplayed: false };
    const value = this._save(task, 'snapshot-frozen'); this.runDue().catch(() => {}); return value;
  }
  abandon(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Abandon options must be an object');
    const { expectedRevision } = options;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('expectedRevision must be a non-negative safe integer');
    for (const [key, limit] of [['reason', 2000], ['evidence', 4000]]) if (typeof options[key] !== 'string' || !options[key].trim() || options[key].length > limit) throw new Error(`Abandon ${key} must be non-empty and at most ${limit} characters`);
    if (options.actor !== undefined && (typeof options.actor !== 'string' || !options.actor.trim() || options.actor.length > 200)) throw new Error('Abandon actor must be non-empty and at most 200 characters');
    const task = this._task(id);
    if (expectedRevision !== undefined && expectedRevision !== task.revision) throw new Error('Task revision changed; refresh before abandonment');
    if (!task.executionUnresolved || !['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed'].includes(task.state)) throw new Error('Abandon requires an unknown unresolved execution');
    task.abandonment = { at: now(), actor: options.actor?.trim() ?? 'unknown', actorAssurance: 'caller-reported', reason: options.reason.trim(), evidence: options.evidence.trim(), observedRevision: task.revision, versionPinned: expectedRevision !== undefined };
    task.state = 'abandoned'; task.control = 'cancel'; delete task.teamPauseOrigin;
    const value = this._save(task, 'abandoned', { executionUnresolved: task.executionUnresolved, abandonment: clone(task.abandonment) }); this.runDue().catch(() => {}); return value;
  }
  _inheritTeamControl(task) {
    if (task.state === 'abandoned') return;
    if (!task.teamId) return;
    const team = this._team(task.teamId);
    if (team.control === 'pause' && task.control === 'run') {
      task.control = 'pause'; task.teamPauseOrigin = { teamId: team.id, priorControl: 'run' };
    } else if (team.control === 'cancel') { task.control = 'cancel'; delete task.teamPauseOrigin; }
  }
  async control(id, action, { teamId: originTeamId } = {}) {
    const task = this._task(id);
    if (task.state === 'abandoned') throw new Error('Abandoned tasks cannot be controlled');
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('Unsupported control action');
    if (action === 'resume') {
      if (task.teamId && this._team(task.teamId).control !== 'run') throw new Error('Team must be running before a task can resume');
      if (task.executionUnresolved) throw new Error('Unresolved attempt requires read-only reconciliation before resume');
      if (task.control !== 'pause') throw new Error('Task is not paused');
      task.control = 'run';
      if (!task.attemptId) task.state = 'queued';
      else if (task.state === 'paused') {
        if (task.completionStatus === 'not-started') task.state = 'queued';
        else if (task.resultFile && task.completionStatus === 'completed') { task.verification = await this._verify(task); task.state = task.checks.length ? 'checked' : 'submitted'; }
        else if (task.completionStatus === 'failed') task.state = 'failed';
        else throw new Error('Attempt needs explicit retry');
      }
    } else {
      if (task.state === 'accepted') throw new Error('Accepted tasks cannot be controlled');
      task.control = action;
      if (task.executionUnresolved) task.state = executing.has(task.state) ? (action === 'pause' ? 'pausing' : 'cancelling') : (action === 'pause' ? 'paused-unconfirmed' : 'cancelled-unconfirmed');
      else task.state = action === 'pause' ? 'paused' : 'cancelled';
    }
    if (this._task(id).revision !== task.revision) throw new Error('Task changed during control; retry required');
    task.nextRetryAt = null;
    if (action === 'pause' && originTeamId === task.teamId && originTeamId) task.teamPauseOrigin = { teamId: originTeamId, priorControl: 'run' };
    else delete task.teamPauseOrigin;
    const value = this._save(task, `control-${action}`);
    if (action !== 'resume' && task.executionUnresolved) this._interrupt(task);
    if (action === 'resume' && !originTeamId) this.runDue().catch(() => {});
    return value;
  }
  _interrupt(task) {
    if (task.state === 'abandoned') return;
    const active = this.handles.get(task.id);
    if (active?.attemptId !== task.attemptId) return;
    Promise.resolve().then(() => active.handle.interrupt()).then(() => {
      const current = this._current(task.id, task.attemptId);
      if (current) this._save(current, 'interrupt-request-acknowledged', { stopCertified: false });
    }).catch(error => {
      const current = this._current(task.id, task.attemptId);
      if (current) {
        if (current.executionKind === 'native' && current.state !== 'abandoned') { current.state = current.control === 'pause' ? 'paused-unconfirmed' : 'cancelled-unconfirmed'; current.error = error.message; }
        this._save(current, 'interrupt-request-failed', { error: error.message, stopCertified: false });
      }
    });
  }
  retry(id) {
    const task = this._task(id);
    if (task.teamId && this._team(task.teamId).control !== 'run') throw new Error('Team must be running before retry');
    if (task.executionUnresolved || executing.has(task.state)) throw new Error('Cannot retry an unresolved execution');
    if (!['failed', 'cancelled', 'blocked'].includes(task.state)) throw new Error('Task is not eligible for explicit retry');
    task.control = 'run'; task.state = 'queued'; task.error = null; task.runtimeError = null; task.retryCount = 0; task.nextRetryAt = null;
    return this._save(task, 'explicit-retry');
  }
  rework(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Rework options must be an object');
    const { expectedRevision } = options;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('expectedRevision must be a non-negative safe integer');
    if (typeof options.feedback !== 'string' || !options.feedback.trim() || options.feedback.length > 4000) throw new Error('Rework feedback must be non-empty and at most 4000 characters');
    if (options.actor !== undefined && (typeof options.actor !== 'string' || !options.actor.trim() || options.actor.length > 200)) throw new Error('Rework actor must be non-empty and at most 200 characters');
    const task = this._task(id);
    if (expectedRevision !== undefined && expectedRevision !== task.revision) throw new Error('Task revision changed; refresh before requesting rework');
    if (task.teamId && this._team(task.teamId).control === 'cancel') throw new Error('Cancelled teams cannot request rework');
    if (task.executionUnresolved || executing.has(task.state)) throw new Error('Cannot rework an unresolved execution');
    if (!['submitted', 'checked', 'failed'].includes(task.state)) throw new Error('Task must be submitted, checked, or failed to request rework');
    const feedback = options.feedback.trim();
    const actor = options.actor?.trim() ?? 'unknown';
    const failedChecks = (task.verification?.checks ?? []).filter(check => check.passed === false).map(check => ({ type: check.type, path: check.path, error: check.error ?? 'failed' }));
    if (!failedChecks.length && task.state === 'failed' && task.error) {
      failedChecks.push({ type: 'failure', path: 'verification', error: String(task.error).slice(0, 500) });
    }
    const history = Array.isArray(task.reworkHistory) ? [...task.reworkHistory] : [];
    history.push({ at: now(), actor, priorAttemptId: task.attemptId ?? null, priorState: task.state, priorRevision: task.revision, feedback });
    if (history.length > 10) history.splice(0, history.length - 10);
    task.reworkHistory = history;
    task.reworkCount = (task.reworkCount ?? 0) + 1;
    task.reworkFeedback = feedback;
    task.reworkPriorFailures = failedChecks;
    task.retryCount = 0;
    task.nextRetryAt = null;
    task.control = task.teamId && this._team(task.teamId).control === 'pause' ? 'pause' : 'run';
    task.state = task.control === 'pause' ? 'paused' : 'queued';
    if (task.control === 'pause' && task.teamId) task.teamPauseOrigin = { teamId: task.teamId, priorControl: 'run' };
    task.error = null; task.runtimeError = null; task.verification = null;
    this.liveActivity.delete(task.id);
    const saved = this._save(task, 'rework-requested', { reworkCount: task.reworkCount, actor });
    if (task.control === 'run') this.runDue().catch(() => {});
    return saved;
  }
  async listTaskFiles(id) {
    const task = this._task(id);
    if (task.acceptance?.snapshotId) {
      const snapshot = await readSnapshot({ root: path.join(this.dataDir, 'artifact-snapshots'), id: task.acceptance.snapshotId });
      return { source: 'snapshot', snapshotId: snapshot.id, files: snapshot.manifest.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) };
    }
    if (!task.cwd || !fs.existsSync(task.cwd)) return { source: 'workspace', files: [] };
    const root = fs.realpathSync(task.cwd);
    if (path.resolve(task.cwd) !== root) throw new Error('Workspace path was replaced or linked');
    const skip = new Set(['context-sources', 'dependencies', 'node_modules', '.git']);
    const files = [];
    const walk = (dir, rel, depth) => {
      if (depth > 6 || files.length >= 200) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (files.length >= 200) break;
        if (depth === 0 && skip.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        let stat;
        try { stat = fs.lstatSync(full, { bigint: true }); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(full, childRel, depth + 1);
        else if (stat.isFile() && stat.nlink === 1n) files.push({ path: childRel, bytes: Number(stat.size) });
      }
    };
    walk(root, '', 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { source: 'workspace', files };
  }
  async readTaskFile(id, relativePath, { offset = 0, limit = 16384 } = {}) {
    const task = this._task(id);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 4 || limit > 65536) throw new Error('Invalid file preview window');
    if (typeof relativePath !== 'string' || !relativePath.trim()) throw new Error('File path is required');
    let filename, expectedSha = null;
    if (task.acceptance?.snapshotId) {
      const snapshot = await readSnapshot({ root: path.join(this.dataDir, 'artifact-snapshots'), id: task.acceptance.snapshotId });
      const normalized = relativePath.replace(/\\/g, '/');
      const found = snapshot.manifest.files.find(file => file.path.replace(/\\/g, '/') === normalized);
      if (!found) throw new Error('File not found in frozen snapshot');
      filename = path.join(this.dataDir, 'artifact-snapshots', snapshot.id, 'blobs', found.sha256);
      expectedSha = found.sha256;
    } else {
      if (!task.cwd) throw new Error('Task has no workspace yet');
      filename = secureFile(task.cwd, relativePath);
    }
    const stat = fs.lstatSync(filename, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) throw new Error('Target must be an independent regular file without links');
    const totalSize = Number(stat.size);
    const probeLen = Math.min(totalSize, 4096);
    if (probeLen > 0) {
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Target identity changed while opening');
        const probe = Buffer.alloc(probeLen);
        fs.readSync(fd, probe, 0, probeLen, 0);
        if (probe.includes(0)) return { path: relativePath, binary: true, totalBytes: totalSize, text: '', offset: 0, nextOffset: null };
      } finally { fs.closeSync(fd); }
    }
    const pageSha = expectedSha ?? (await hashArtifact(filename)).sha256;
    const page = await readVerifiedFilePage({ filename, sha256: pageSha, offset, limit });
    return { path: relativePath, binary: false, ...page };
  }
  _recoverDue() {
    if (this.closed) return;
    for (const task of this.store.unresolvedTasks()) {
      if (this.recoveryInFlight.size >= 2) break;
      if (!task.executionUnresolved || executing.has(task.state) || !task.threadId || (!task.turnId && task.executionKind !== 'native') || (task.recovery?.nextAt ?? 0) > Date.now()) continue;
      const key = `${task.id}:${task.attemptId}`;
      if (!this.recoveryInFlight.has(key)) this.reconcile(task.id).catch(() => {});
    }
  }
  reconcile(id) {
    const task = this._task(id);
    if (!task.executionUnresolved || !task.threadId) throw new Error('No known unresolved host thread to inspect');
    const key = `${task.id}:${task.attemptId}`;
    if (this.recoveryInFlight.has(key)) return this.recoveryInFlight.get(key);
    // Install the promise before starting any adapter work so explicit and
    // background inspections cannot overlap for one persisted attempt.
    const inspection = Promise.resolve().then(() => this._inspectAttempt(task));
    const tracked = inspection.then(value => { this._recordRecovery(task, null); return value; }, error => { this._recordRecovery(task, error); throw error; }).finally(() => { this.recoveryInFlight.delete(key); });
    this.recoveryInFlight.set(key, tracked);
    return tracked;
  }
  _recordRecovery(task, error) {
    if (this.closed || !this.store) return;
    const current = this.store.get(task.id);
    if (current?.attemptId !== task.attemptId || !current.executionUnresolved) return;
    const tries = (current.recovery?.tries ?? 0) + 1;
    const delayMs = Math.min(60000, 1000 * 2 ** Math.min(tries - 1, 6));
    current.recovery = { attemptId: task.attemptId, tries, at: now(), nextAt: Date.now() + delayMs, error: error ? bounded(errorText(error), 1024).text : null };
    this._save(current, 'recovery-deferred', { delayMs, readOnly: true });
  }
  async _inspectAttempt(task) {
    const snapshot = task.executionKind === 'native' ? await this.nativeAdapter.inspectAttempt(task) : await this.adapter.inspect(task.threadId);
    const current = this._task(task.id);
    if (current.attemptId !== task.attemptId || !current.executionUnresolved) return current;
    if (current.executionKind === 'native' && snapshot.turnId && !current.turnId) {
      current.turnId = snapshot.turnId;
      this._save(current, 'host-identity-recovered');
    }
    current.reconciliation = { at: now(), evidence: bounded(JSON.stringify(snapshot), 8192), stopCertified: false };
    this._save(current, 'runtime-inspected');
    // A matching completed turn can recover a lost final response. A generic
    // thread status or interrupted turn cannot certify an unresolved attempt.
    const turn = snapshot?.id === current.threadId && current.turnId
      ? snapshot.turns?.find(item => item.id === current.turnId) : null;
    if (turn && ['completed', 'failed'].includes(turn.status)) {
      const text = (turn.items ?? []).filter(item => item.type === 'agentMessage').map(item => item.text ?? '').join('\n\n');
      await this._finish(current, { status: turn.status, text, error: turn.error });
    }
    return this.get(task.id);
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    await Promise.allSettled(this.verifying.values());
    if (this.pumping) await this.pumping.catch(() => {});
    if (this.store) {
      for (const task of this.store.tasks()) if (executing.has(task.state)) { task.state = 'unknown'; task.executionUnresolved = true; task.error = 'Engine closed before execution was resolved'; this._save(task, 'close-unknown'); }
      await this.adapter.close().catch(() => {});
      await this.nativeAdapter?.close().catch(() => {});
      this.store.close(); this.store = null;
    }
  }
}
