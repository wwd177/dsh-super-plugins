import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContextStore, compactResult } from './engine/context.mjs';
import { Engine } from './engine/engine.mjs';
import { DshAdapter } from './engine/dsh-adapter.mjs';
import { PendingApprovalManager } from './engine/approvals.mjs';
import { buildOverview, buildTeamList, buildInspection } from './engine/overview.mjs';
import { analyzeTaskGraph, serializeTaskGraph } from './engine/scheduler.mjs';
import { createDshEngineRouter } from './engine/dsh-http.mjs';
import { ENGINE_VERSION } from './engine/version.mjs';
import { primaryToolSchemas, legacyToolSchemas, toolSchemas, parseToolInput, executeStandaloneBoard } from '../dist/tool-schemas.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isEngineReference = value => typeof value === 'string' && (value.startsWith('engine:') || UUID_RE.test(value));
const stripEnginePrefix = value => String(value ?? '').replace(/^engine:/, '');

export function defaultDshEngineDataDir(ctx = null) {
  if (process.env.DSH_SUPERAGENT_DATA_DIR) return path.resolve(process.env.DSH_SUPERAGENT_DATA_DIR);
  const profileHome = ctx?.profileContext?.home || ctx?.profileContext?.dir;
  if (typeof profileHome === 'string' && profileHome.trim()) {
    return path.join(profileHome, 'plugin-data', 'dsh-super-teams');
  }
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profileName = process.env.DSH_PROFILE || 'desktop';
  return path.join(dshHome, 'profiles', profileName, 'plugin-data', 'dsh-super-teams');
}

function callerSessionInfo(ctx, exec) {
  const caller = exec?.agent;
  if (!caller?.id) return { sessionId: null, rootSessionId: null, cwd: null };
  let root = caller;
  try {
    const subagents = ctx?.get?.('subagents') ?? ctx?.subagents;
    if (subagents?.rootOf) root = subagents.rootOf(caller);
  } catch { /* fallback to caller */ }
  let cwd = root?.session?.header?.cwd ?? null;
  try {
    const wd = ctx?.get?.('workingDirectory') ?? ctx?.workingDirectory;
    if (wd?.get && root?.session) cwd = wd.get(root.session) ?? cwd;
  } catch { /* ignore */ }
  return { sessionId: caller.id, rootSessionId: root?.id ?? caller.id, cwd };
}

function computeBoardWaveGraph(boardReadResult) {
  const tasks = Array.isArray(boardReadResult?.tasks) ? boardReadResult.tasks : [];
  const mapped = tasks.map((t, idx) => ({
    id: t.id,
    title: t.subject ?? t.id,
    state: t.status === 'completed' ? 'accepted' : t.status === 'in_progress' ? 'running' : 'queued',
    dependsOn: Array.isArray(t.blocked_by) ? t.blocked_by : [],
    difficulty: 'medium',
    priority: 'normal',
    writeScopes: Array.isArray(t.write_scopes) ? t.write_scopes : [],
    createdAt: t.created_at ?? new Date(idx * 1000).toISOString(),
  }));
  return {
    team_id: boardReadResult?.team_id ?? null,
    revision: boardReadResult?.revision ?? null,
    title: boardReadResult?.title ?? null,
    graph: serializeTaskGraph(analyzeTaskGraph(mapped)),
  };
}

export class DshSuperTeamsRuntime {
  constructor({ ctx = null, dataDir = null, mockRunner = null, publicDir = undefined } = {}) {
    this.ctx = ctx;
    this.dataDir = path.resolve(dataDir || defaultDshEngineDataDir(ctx));
    this.mockRunner = mockRunner;
    this.publicDir = publicDir;
    this.approvals = new PendingApprovalManager();
    this.adapter = new DshAdapter({ ctx, mockRunner });
    this.contextStore = null;
    this.engine = null;
    this.router = null;
    this.initPromise = null;
    this.closed = false;
  }

  ensureStarted() {
    if (this.closed) throw new Error('DshSuperTeamsRuntime is closed');
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._start();
    return this.initPromise;
  }

  async _start() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let maxConcurrent = 2;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'engine-settings.json'), 'utf8'));
      if (Number.isInteger(settings?.maxConcurrent) && settings.maxConcurrent >= 1 && settings.maxConcurrent <= 8) {
        maxConcurrent = settings.maxConcurrent;
      }
    } catch { /* default 2 */ }
    this.contextStore = new ContextStore(path.join(this.dataDir, 'context'));
    this.engine = new Engine({
      dataDir: this.dataDir,
      adapter: this.adapter,
      contextStore: this.contextStore,
      maxConcurrent,
    });
    await this.engine.initialize({ connectInBackground: true });
    const connection = this.ctx?.get?.('connection') ?? this.ctx?.connection;
    const fence = connection?.requestRejection
      ? req => connection.requestRejection(req) === undefined
      : null;
    this.router = createDshEngineRouter({
      engine: this.engine,
      contextStore: this.contextStore,
      adapter: this.adapter,
      approvals: this.approvals,
      ...(this.publicDir ? { publicDir: this.publicDir } : {}),
      basePrefix: '/superagent-engine',
      fence,
    });
    return this;
  }

  async executeTool(name, rawArgs, exec = {}) {
    exec.signal?.throwIfAborted?.();
    const args = parseToolInput(name, rawArgs ?? {});
    const caller = callerSessionInfo(this.ctx, exec);
    if (caller.rootSessionId) {
      this.adapter.rememberSession(caller.rootSessionId, caller.cwd);
    }

    if (name === 'teams_engine') {
      await this.ensureStarted();
      return this._executeTeamsEngineView(args);
    }

    if (name.startsWith('teams_')) {
      return this._executeTeamsTool(name, args);
    }

    await this.ensureStarted();
    return this._executeEngineTool(name, args, caller);
  }

  _executeTeamsEngineView(a) {
    const engine = this.engine;
    const action = a.action;
    if (a.attentionOnly !== undefined && action !== 'overview') {
      throw new Error('attentionOnly is supported only for action=overview');
    }
    if (action === 'list') {
      if (a.team_id !== undefined || a.task_id !== undefined) {
        throw new Error('team_id and task_id are not supported for action=list');
      }
      return {
        source: 'superagent-engine-dsh',
        store: 'engine.sqlite',
        audit_independence: 'same_engine_store',
        action,
        data: buildTeamList(engine.listTeams(), {
          cursor: a.cursor ?? 0,
          limit: Math.min(a.limit ?? 20, 50),
          budgetBytes: a.budgetBytes ?? 16384,
        }),
      };
    }
    if (action === 'overview') {
      if (a.task_id !== undefined) throw new Error('task_id is not supported for action=overview');
      const team = a.team_id ? engine.getTeam(stripEnginePrefix(a.team_id)) : undefined;
      return {
        source: 'superagent-engine-dsh',
        store: 'engine.sqlite',
        audit_independence: 'same_engine_store',
        action,
        data: buildOverview(team ? team.tasks : engine.list(), {
          cursor: a.cursor ?? 0,
          limit: Math.min(a.limit ?? 20, 50),
          budgetBytes: a.budgetBytes ?? 16384,
          attentionOnly: a.attentionOnly === true,
          team,
        }),
      };
    }
    if (action === 'graph') {
      if (!a.team_id || a.task_id !== undefined) throw new Error('Supply team_id only for action=graph');
      return {
        source: 'superagent-engine-dsh',
        store: 'engine.sqlite',
        audit_independence: 'same_engine_store',
        action,
        data: engine.getTeamGraph(stripEnginePrefix(a.team_id)),
      };
    }
    if (['task', 'evidence', 'events'].includes(action)) {
      if (!a.task_id) throw new Error(`task_id is required for action=${action}`);
      const taskId = stripEnginePrefix(a.task_id);
      const task = engine.get(taskId);
      if (a.team_id && task.teamId !== stripEnginePrefix(a.team_id)) {
        throw new Error('Task does not belong to the requested engine team');
      }
      if (action === 'task') {
        return {
          source: 'superagent-engine-dsh',
          store: 'engine.sqlite',
          audit_independence: 'same_engine_store',
          action,
          data: buildInspection(task, { budgetBytes: a.budgetBytes ?? 16384 }),
        };
      }
      if (action === 'evidence') {
        return engine.result(taskId, {
          offset: a.offset ?? 0,
          limit: Math.min(Math.max(a.limit ?? 8192, 4), 65536),
        }).then(data => ({
          source: 'superagent-engine-dsh',
          store: 'engine.sqlite',
          audit_independence: 'same_engine_store',
          action,
          data,
        }));
      }
      return {
        source: 'superagent-engine-dsh',
        store: 'engine.sqlite',
        audit_independence: 'same_engine_store',
        action,
        data: engine.events(taskId, {
          after: a.after ?? 0,
          limit: Math.min(Math.max(a.limit ?? 20, 1), 200),
        }),
      };
    }
    throw new Error(`Unknown teams_engine action: ${action}`);
  }

  async _executeTeamsTool(name, args) {
    const engineRef = isEngineReference(args.team_id) || isEngineReference(args.task_id);
    if (engineRef) {
      if (!['teams_read', 'teams_task_packet'].includes(name)) {
        throw new Error('ENGINE_READ_ONLY: Use engine_team / engine_control to modify engine-owned teams and tasks.');
      }
      await this.ensureStarted();
      if (name === 'teams_task_packet' || args.task_id) {
        const taskId = stripEnginePrefix(args.task_id);
        const task = this.engine.get(taskId);
        if (args.team_id && task.teamId !== stripEnginePrefix(args.team_id)) {
          throw new Error('Task does not belong to the requested engine team');
        }
        return {
          source: 'superagent-engine-dsh',
          audit_independence: 'same_engine_store',
          action: 'task',
          data: buildInspection(task, { budgetBytes: 16384 }),
        };
      }
      const teamId = stripEnginePrefix(args.team_id);
      if (args.view === 'graph') {
        return {
          source: 'superagent-engine-dsh',
          audit_independence: 'same_engine_store',
          action: 'graph',
          data: this.engine.getTeamGraph(teamId),
        };
      }
      const team = this.engine.getTeam(teamId);
      return {
        source: 'superagent-engine-dsh',
        audit_independence: 'same_engine_store',
        action: 'overview',
        data: buildOverview(team.tasks, {
          cursor: args.cursor ?? 0,
          limit: Math.min(args.limit ?? 20, 50),
          budgetBytes: 16384,
          team,
        }),
      };
    }

    if (!args.workspace) {
      throw new Error('workspace (absolute path of user-authorized project) is required for .super-teams project board operations');
    }
    if (name === 'teams_read' && args.view === 'graph') {
      if (!args.team_id) throw new Error('team_id is required for view=graph');
      const graphSource = executeStandaloneBoard('teams_read', {
        workspace: args.workspace,
        team_id: args.team_id,
        view: 'graph',
      });
      return computeBoardWaveGraph(graphSource);
    }
    return executeStandaloneBoard(name, args);
  }

  async _executeEngineTool(name, a, caller) {
    const engine = this.engine;
    const actor = `dsh-agent:${caller.rootSessionId ?? 'unknown'}`;
    const windowOpts = () => ({
      cursor: a.cursor ?? 0,
      limit: a.limit ?? 20,
      budgetBytes: a.budgetBytes ?? 16384,
    });

    if (name === 'engine_workspace') {
      if (a.teamId) {
        engine.getTeam(a.teamId);
        if (caller.rootSessionId) engine.bindTeamSession(a.teamId, caller.rootSessionId);
      }
      this.router?.notifyWorkbenchOpen({
        sessionId: caller.rootSessionId ?? null,
        teamId: a.teamId ?? null,
      });
      return {
        service: 'SuperAgent 团队工作台 (DeepSeek Harness)',
        version: ENGINE_VERSION,
        host: 'deepseek-harness',
        openedInSidebar: true,
        tabKind: 'superagent-workbench',
        routePrefix: '/superagent-engine',
        teamId: a.teamId ?? null,
        sessionId: caller.rootSessionId ?? null,
        adapter: this.adapter.status(),
      };
    }

    if (name === 'engine_team') {
      if (a.attentionOnly !== undefined && a.action !== 'overview') {
        throw new Error('attentionOnly requires action=overview');
      }
      if (a.tasks !== undefined && a.action !== 'prepare') {
        throw new Error('Use action=prepare to create a team with tasks');
      }
      if (a.action === 'list') {
        if (a.teamId !== undefined) throw new Error('Use action=overview for a specific team');
        return buildTeamList(engine.listTeams(), windowOpts());
      }
      if (a.action === 'create' || a.action === 'prepare') {
        if (a.teamId !== undefined) throw new Error('A new team cannot specify an existing teamId');
        const created = engine.createTeam({
          requestId: a.requestId,
          name: a.name,
          goal: a.goal,
          members: a.members,
          ...(a.action === 'prepare' ? { tasks: a.tasks } : {}),
          ...(caller.rootSessionId ? { sessionId: caller.rootSessionId } : {}),
        });
        this.router?.notifyWorkbenchOpen({
          sessionId: caller.rootSessionId ?? null,
          teamId: created.id,
        });
        if (a.action === 'prepare') {
          return {
            id: created.id,
            name: created.name,
            control: created.control,
            sessionId: created.sessionId ?? null,
            openedInSidebar: true,
            members: created.members.map(({ id, name, role }) => ({ id, name, role })),
            planTasks: created.planTasks,
            graphSummary: {
              waveCount: created.graph?.waves?.length ?? 0,
              criticalPathIds: created.graph?.criticalPathIds ?? [],
              scopeOverlaps: created.graph?.scopeOverlaps ?? [],
            },
          };
        }
        return {
          id: created.id,
          name: created.name,
          control: created.control,
          sessionId: created.sessionId ?? null,
          openedInSidebar: true,
          members: created.members.map(m => ({ id: m.id, name: m.name, role: m.role })),
          next: 'Assign tasks with teamId/memberId and team-scoped sources; resume the team after preparation.',
        };
      }
      if (!a.teamId) throw new Error('teamId is required');
      if (a.action === 'overview') {
        const team = engine.getTeam(a.teamId);
        return buildOverview(team.tasks, {
          ...windowOpts(),
          attentionOnly: a.attentionOnly === true,
          team,
        });
      }
      if (a.action === 'graph') return engine.getTeamGraph(a.teamId);
      if (a.action === 'accept_checked') return engine.acceptAllChecked(a.teamId, { actor });
      if (a.action === 'archive' || a.action === 'unarchive') {
        return engine.archiveTeam(a.teamId, a.action === 'archive');
      }
      if (caller.rootSessionId) {
        try { engine.bindTeamSession(a.teamId, caller.rootSessionId); } catch {}
      }
      const result = await engine.teamControl(a.teamId, a.action);
      const counts = {};
      for (const o of result.outcomes) counts[o.status] = (counts[o.status] ?? 0) + 1;
      const value = {
        teamId: result.team.id,
        control: result.team.control,
        counts: result.team.counts,
        outcomeCounts: counts,
        outcomes: [],
        omitted: result.outcomes.length,
      };
      for (const o of [...result.outcomes].sort((x, y) => Number(y.status === 'failed') - Number(x.status === 'failed'))) {
        value.outcomes.push({
          taskId: o.taskId,
          status: o.status,
          ...(o.error ? { error: compactResult({ text: String(o.error), maxBytes: 256 }).text } : {}),
        });
        value.omitted--;
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > (a.budgetBytes ?? 16384)) {
          value.outcomes.pop();
          value.omitted++;
          break;
        }
      }
      return value;
    }

    if (name === 'engine_submit') {
      const task = engine.submit({
        ...a,
        ...(caller.rootSessionId ? { sessionId: caller.rootSessionId } : {}),
      });
      return {
        taskId: task.id,
        teamId: task.teamId ?? null,
        memberId: task.memberId ?? null,
        state: task.state,
        control: task.control,
        revision: task.revision,
        priority: task.priority ?? 'normal',
        autoAccept: Boolean(task.autoAccept),
        maxRetries: task.maxRetries ?? 0,
      };
    }

    if (name === 'engine_overview') {
      const team = a.teamId ? engine.getTeam(a.teamId) : undefined;
      return buildOverview(team ? team.tasks : engine.list(), {
        ...windowOpts(),
        attentionOnly: a.attentionOnly === true,
        team,
      });
    }

    if (name === 'engine_control') {
      const id = a.taskId;
      if (a.action === 'inspect') {
        return buildInspection(engine.get(id), { budgetBytes: 16384 });
      }
      if (['pause', 'resume', 'cancel'].includes(a.action)) {
        const t = await engine.control(id, a.action);
        return buildInspection(t, { budgetBytes: 16384 });
      }
      if (a.action === 'verify') return buildInspection(await engine.verify(id), { budgetBytes: 16384 });
      if (a.action === 'reconcile') return buildInspection(await engine.reconcile(id), { budgetBytes: 16384 });
      if (a.action === 'retry') return buildInspection(engine.retry(id), { budgetBytes: 16384 });
      if (a.action === 'rework') {
        if (!a.reason) throw new Error('reason (reviewer feedback) is required for action=rework');
        const t = engine.rework(id, { expectedRevision: a.expectedRevision, feedback: a.reason, actor });
        return buildInspection(t, { budgetBytes: 16384 });
      }
      if (a.action === 'accept') {
        const t = await engine.accept(id, {
          expectedRevision: a.expectedRevision,
          reason: a.reason,
          acknowledgeHostFailure: a.acknowledgeHostFailure === true,
          actor,
        });
        return buildInspection(t, { budgetBytes: 16384 });
      }
      if (a.action === 'freeze') {
        const t = await engine.freeze(id, { expectedRevision: a.expectedRevision, actor });
        return buildInspection(t, { budgetBytes: 16384 });
      }
      if (a.action === 'abandon') {
        const t = engine.abandon(id, {
          expectedRevision: a.expectedRevision,
          reason: a.reason,
          evidence: a.evidence,
          actor,
        });
        return buildInspection(t, { budgetBytes: 16384 });
      }
      throw new Error(`Unsupported control action: ${a.action}`);
    }

    if (name === 'engine_source') {
      const store = a.teamId ? engine.contextForTeam(a.teamId) : this.contextStore;
      return store.addSource({
        text: a.text,
        label: a.label,
        critical: a.critical === true,
        kind: a.kind ?? 'document',
      });
    }

    if (name === 'engine_evidence') {
      if (a.kind === 'result') {
        const task = engine.get(a.id);
        if (a.teamId && task.teamId !== a.teamId) throw new Error('Task does not belong to the requested team');
        return engine.result(a.id, { offset: a.offset ?? 0, limit: a.limit ?? 8192 });
      }
      const store = a.teamId ? engine.contextForTeam(a.teamId) : this.contextStore;
      return store.readSource(a.id, { offset: a.offset ?? 0, limit: a.limit ?? 8192 });
    }

    throw new Error(`Unsupported engine tool: ${name}`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.router?.dispose(); } catch {}
    try { this.approvals?.close(); } catch {}
    if (this.engine) {
      try { await this.engine.close(); } catch {}
    }
    try { await this.adapter?.close(); } catch {}
  }
}

export { primaryToolSchemas, legacyToolSchemas, toolSchemas };
