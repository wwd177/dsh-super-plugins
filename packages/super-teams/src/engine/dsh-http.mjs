import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOverview, buildTeamList, buildInspection, buildSystemHealthBanner } from './overview.mjs';
import { scanSnapshotStorage } from './artifact-snapshots.mjs';
import { sendDeliveryExport } from './delivery-export.mjs';
import { ENGINE_VERSION } from './version.mjs';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const integer = (value, fallback, max) => {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error('分页参数无效');
  return n;
};

const MAX_SSE_CLIENTS = 24;
const MAX_SSE_BUFFER_BYTES = 512 * 1024;
const MAX_CHANGE_LOG = 256;

const validLoopbackHost = host => {
  const m = /^127\.0\.0\.1(?::(\d{1,5}))?$/.exec(host);
  if (!m) return false;
  if (m[1] === undefined) return true;
  const p = Number(m[1]);
  return p >= 1 && p <= 65535;
};

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0, timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      reject(new Error('读取请求体超时'));
    }, 15000);
    timer.unref?.();
  });
  try {
    await Promise.race([
      (async () => {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) throw new Error('请求超过 2 MiB，请拆分原文');
          chunks.push(chunk);
        }
      })().catch(error => { if (!req.destroyed) throw error; }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed;
}

export function createDshEngineRouter({
  engine,
  contextStore,
  adapter,
  approvals = null,
  publicDir = join(pkgDir, 'public'),
  basePrefix = '/superagent-engine',
  fence = null,
  token = randomBytes(32).toString('hex'),
}) {
  let activeFence = typeof fence === 'function' ? fence : null;
  const setFence = nextFence => {
    activeFence = typeof nextFence === 'function' ? nextFence : null;
  };
  let closing = false;
  let disk = {}, diskRefreshAt = 0, diskFlight = null;
  let changeSeq = 0;
  const changeLog = [];
  const sseClients = new Map();

  const shouldDeliverEvent = (event, payload, clientSessionId) => {
    if (event !== 'open-workbench') return true;
    const targetSid = payload?.sessionId ?? null;
    if (clientSessionId) return Boolean(targetSid) && targetSid === clientSessionId;
    return true;
  };

  const recordAndBroadcast = (event, payload) => {
    const entry = { seq: ++changeSeq, event, payload, at: new Date().toISOString() };
    changeLog.push(entry);
    if (changeLog.length > MAX_CHANGE_LOG) changeLog.splice(0, changeLog.length - MAX_CHANGE_LOG);
    if (!sseClients.size) return entry;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [client, meta] of [...sseClients.entries()]) {
      if (client.destroyed || client.writableEnded || client.writableLength > MAX_SSE_BUFFER_BYTES) {
        sseClients.delete(client);
        try { client.destroy(); } catch {}
        continue;
      }
      if (!shouldDeliverEvent(event, payload, meta?.sessionId ?? null)) continue;
      try { client.write(frame); } catch { sseClients.delete(client); }
    }
    return entry;
  };

  const onEngineChange = change => recordAndBroadcast('change', change);
  const onEngineActivity = activity => recordAndBroadcast('activity', activity);
  const onApprovalChange = event => recordAndBroadcast('approval', event);
  engine.on?.('change', onEngineChange);
  engine.on?.('activity', onEngineActivity);
  approvals?.on?.('change', onApprovalChange);

  const notifyWorkbenchOpen = ({ sessionId = null, teamId = null } = {}) => {
    return recordAndBroadcast('open-workbench', { sessionId, teamId, at: new Date().toISOString() });
  };

  const heartbeat = setInterval(() => {
    for (const client of [...sseClients.keys()]) {
      if (client.destroyed || client.writableEnded || client.writableLength > MAX_SSE_BUFFER_BYTES) {
        sseClients.delete(client);
        try { client.destroy(); } catch {}
        continue;
      }
      try { client.write(': keepalive\n\n'); } catch { sseClients.delete(client); }
    }
  }, 15000);
  heartbeat.unref?.();

  const health = async () => {
    if (engine.dataDir && !diskFlight && Date.now() >= diskRefreshAt) {
      diskRefreshAt = Date.now() + 60000;
      diskFlight = scanSnapshotStorage({ root: join(engine.dataDir, 'artifact-snapshots') })
        .then(value => { disk = { bytes: value.bytes, measuredAt: Date.now() }; })
        .catch(error => { disk = { ...disk, error: error.message }; })
        .finally(() => { diskFlight = null; });
    }
    const tasks = engine.unresolvedTasks ? engine.unresolvedTasks() : await engine.list();
    return {
      service: 'superagent-engine-dsh',
      host: 'deepseek-harness',
      version: ENGINE_VERSION,
      pid: process.pid,
      adapter: adapter.status?.() ?? { state: 'unknown' },
      scheduler: engine.status?.(tasks) ?? {},
      pendingApprovals: approvals?.list().length ?? 0,
      dshSession: adapter.sessionSnapshot?.() ?? null,
      systemHealthBanner: buildSystemHealthBanner({ tasks, bindings: [], disk }),
    };
  };

  const normalizePathname = rawPathname => {
    if (basePrefix && (rawPathname === basePrefix || rawPathname.startsWith(`${basePrefix}/`))) {
      const stripped = rawPathname.slice(basePrefix.length);
      return stripped || '/';
    }
    return rawPathname || '/';
  };

  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    try {
      const fencedMode = typeof activeFence === 'function';
      if (fencedMode) {
        if (!activeFence(req)) return send(403, { error: 'DeepSeek Harness 会话鉴权未通过' });
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers?.origin && req.headers.origin !== 'null') {
          let allowedOrigin = false;
          try {
            const o = new URL(req.headers.origin);
            if (o.protocol === 'dsh-app:' && o.host === 'app') allowedOrigin = true;
            else if ((o.protocol === 'http:' || o.protocol === 'https:') && req.headers?.host && o.host === req.headers.host) allowedOrigin = true;
          } catch {}
          if (!allowedOrigin) return send(403, { error: '跨站写请求被拒绝' });
        }
      } else {
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const host = req.headers.host || '';
        if (!validLoopbackHost(host)) return send(403, { error: '仅允许本机 127.0.0.1' });
        if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(403, { error: '跨站请求被拒绝' });
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = normalizePathname(url.pathname);

      if (req.method === 'GET' && ['/', '/app.js', '/delivery-download.js', '/style.css', '/template.html'].includes(pathname)) {
        const name = pathname === '/' ? 'index.html' : pathname.slice(1);
        let content = readFileSync(join(publicDir, name));
        if (name === 'index.html') {
          content = Buffer.from(content.toString('utf8').replace('__ENGINE_TOKEN__', fencedMode ? 'dsh-fenced' : token));
        }
        res.writeHead(200, {
          'Content-Type': name.endsWith('html')
            ? 'text/html; charset=utf-8'
            : name.endsWith('js')
              ? 'text/javascript; charset=utf-8'
              : 'text/css; charset=utf-8',
        });
        res.end(content);
        return;
      }

      if (!fencedMode && !same(req.headers['x-engine-token'], token)) {
        return send(401, { error: '请从本机工作台打开，或提供有效实例令牌' });
      }

      const input = req.method === 'POST' ? await readJsonBody(req) : undefined;
      if (closing) return send(503, { error: '服务正在停止' });

      const parts = pathname.split('/').filter(Boolean);
      const query = Object.fromEntries(url.searchParams);
      if (query.sessionId && typeof query.sessionId === 'string' && query.sessionId.trim()) {
        adapter.rememberSession?.(query.sessionId.trim());
      }
      if (input?.sessionId && typeof input.sessionId === 'string' && input.sessionId.trim()) {
        adapter.rememberSession?.(input.sessionId.trim());
      }
      if (query.teamId !== undefined && !query.teamId.trim()) {
        return send(400, { error: '请提供有效的团队 ID，或省略 teamId' });
      }

      if (req.method === 'GET' && pathname === '/api/health') return send(200, await health());

      if (req.method === 'GET' && pathname === '/api/changes') {
        const rawSince = query.since !== undefined ? Number(query.since) : -1;
        if (!Number.isSafeInteger(rawSince) || rawSince < -1 || rawSince > 2e9) {
          throw new Error('分页参数无效');
        }
        const clientSessionId = typeof query.sessionId === 'string' && query.sessionId.trim() ? query.sessionId.trim() : null;
        const items = rawSince < 0
          ? []
          : changeLog.filter(item => item.seq > rawSince && shouldDeliverEvent(item.event, item.payload, clientSessionId));
        return send(200, { seq: changeSeq, items });
      }

      if (req.method === 'GET' && pathname === '/api/stream') {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          const oldest = sseClients.keys().next().value;
          sseClients.delete(oldest);
          try { oldest.end(); } catch {}
        }
        const clientSessionId = typeof query.sessionId === 'string' && query.sessionId.trim() ? query.sessionId.trim() : null;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ version: ENGINE_VERSION, pid: process.pid, seq: changeSeq })}\n\n`);
        sseClients.set(res, { sessionId: clientSessionId });
        req.on('close', () => { sseClients.delete(res); });
        return;
      }

      if (pathname === '/api/settings') {
        if (req.method === 'GET') return send(200, { maxConcurrent: engine.maxConcurrent ?? 2 });
        if (req.method === 'POST') return send(200, engine.setMaxConcurrent(input.maxConcurrent));
      }

      if (pathname === '/api/approvals' && req.method === 'GET') {
        return send(200, { approvals: approvals?.list() ?? [] });
      }
      if (parts[0] === 'api' && parts[1] === 'approvals' && parts[2] && parts[3] === 'decide' && req.method === 'POST') {
        if (!approvals) throw new Error('Interactive approval queue is not enabled');
        return send(200, approvals.decide(decodeURIComponent(parts[2]), input.decision, { reason: input.reason }));
      }

      if (pathname === '/api/dsh/session') {
        if (req.method === 'GET') return send(200, adapter.sessionSnapshot?.(query.sessionId ?? null) ?? { available: false });
        if (req.method === 'POST') {
          if (typeof input.sessionId === 'string' && input.sessionId.trim()) {
            adapter.rememberSession?.(input.sessionId.trim(), input.cwd ?? null);
          }
          if (input.teamId && typeof input.sessionId === 'string' && input.sessionId.trim()) {
            engine.bindTeamSession?.(input.teamId, input.sessionId.trim(), { onlyIfUnbound: true, verifyOnline: false, actor: 'dsh-workbench:auto' });
          }
          return send(200, adapter.sessionSnapshot?.(input.sessionId ?? null) ?? { available: true });
        }
      }

      if (pathname === '/api/native/status' && req.method === 'GET') {
        const snap = adapter.sessionSnapshot?.(query.sessionId ?? null) ?? { available: false };
        return send(200, {
          available: snap.available,
          canSend: snap.available,
          host: 'deepseek-harness',
          originThreadId: snap.activeSessionId ?? null,
          ...snap,
          ...(snap.available ? {} : { error: '请先在 DeepSeek Harness 打开一个聊天会话，子代理将在该会话树下自动创建。' }),
        });
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        if (query.summary === '1' || query.summary === 'true' || req.headers['x-summary-only'] === '1') {
          return send(200, { version: ENGINE_VERSION, health: await health(), pid: process.pid, seq: changeSeq });
        }
        return send(200, {
          version: ENGINE_VERSION,
          tasks: await engine.list(),
          sources: contextStore.listSources(),
          health: await health(),
          pid: process.pid,
          seq: changeSeq,
        });
      }

      if (req.method === 'GET' && pathname === '/api/refusals') return send(200, { refusals: engine.listRefusals(integer(query.limit, 50, 200)) });
      if (req.method === 'GET' && pathname === '/api/security/posture') return send(200, engine.getIsolationPosture());
      if (req.method === 'POST' && pathname === '/api/repo/probe') return send(200, engine.probeRepoEnvironment(input.repoPath));
      if (req.method === 'GET' && pathname === '/api/overview') {
        if (query.attentionOnly !== undefined && !['true', 'false'].includes(query.attentionOnly)) {
          throw new Error('attentionOnly must be true or false');
        }
        const team = query.teamId ? await engine.getTeam(query.teamId) : undefined;
        return send(200, buildOverview(team ? team.tasks : await engine.list(), {
          cursor: integer(query.cursor, 0, 1e9),
          limit: integer(query.limit, 20, 50),
          budgetBytes: integer(query.budgetBytes, 16384, 65536),
          attentionOnly: query.attentionOnly === 'true',
          health: await health(),
          team,
        }));
      }

      if (req.method === 'POST' && pathname === '/api/teams/plan') {
        if (!Array.isArray(input?.tasks) || !input.tasks.length) {
          throw new Error('Provide at least one task to prepare a team plan');
        }
        const team = await engine.createTeam(input);
        return send(201, {
          id: team.id,
          name: team.name,
          control: team.control,
          workspaceMode: team.workspaceMode ?? 'isolated',
          ...(team.baseCommit ? { baseCommit: team.baseCommit } : {}),
          sessionId: team.sessionId ?? null,
          members: team.members.map(({ id, name, role }) => ({ id, name, role })),
          planTasks: team.planTasks,
        });
      }

      if (pathname === '/api/teams') {
        if (req.method === 'GET') {
          if (query.teamId !== undefined) return send(400, { error: '请使用 /api/overview?teamId=... 查询指定团队' });
          const teams = await engine.listTeams();
          return send(200, ['cursor', 'limit', 'budgetBytes'].some(key => query[key] !== undefined)
            ? buildTeamList(teams, {
                cursor: integer(query.cursor, 0, 1e9),
                limit: integer(query.limit, 20, 50),
                budgetBytes: integer(query.budgetBytes, 16384, 65536),
              })
            : { teams });
        }
        if (req.method === 'POST') return send(201, await engine.createTeam(input));
      }

      if (parts[0] === 'api' && parts[1] === 'teams' && parts[2]) {
        const teamId = decodeURIComponent(parts[2]);
        if (req.method === 'GET' && parts[3] === 'delivery.zip' && parts.length === 4) {
          try { await sendDeliveryExport({ engine, teamId, req, res }); }
          catch (error) { if (!res.headersSent && !res.destroyed) send(error.status ?? 400, { error: error.message }); }
          return;
        }
        if (req.method === 'GET' && !parts[3]) return send(200, await engine.getTeam(teamId));
        if (req.method === 'GET' && parts[3] === 'graph' && parts.length === 4) return send(200, await engine.getTeamGraph(teamId));
        if (req.method === 'POST' && parts[3] === 'accept-checked' && parts.length === 4) {
          return send(200, await engine.acceptAllChecked(teamId, { actor: input?.actor ?? 'dsh-workbench:user' }));
        }
        if (req.method === 'POST' && parts[3] === 'merge-preview' && parts.length === 4) {
          return send(200, await engine.mergeTeam(teamId, { apply: false, integrationCheck: input?.integrationCheck ?? null }));
        }
        if (req.method === 'POST' && parts[3] === 'merge-apply' && parts.length === 4) {
          return send(200, await engine.mergeTeam(teamId, { apply: true, branchName: input?.branchName ?? null, integrationCheck: input?.integrationCheck ?? null, candidateId: input?.candidateId ?? null, approvalId: input?.approvalId ?? null, ...(input?.allowPartial !== undefined ? { allowPartial: input.allowPartial } : {}) }));
        }
        if (parts[3] === 'criteria') {
          if (req.method === 'GET' && parts.length === 4) return send(200, engine.getLatestCriteria(teamId));
          if (req.method === 'POST' && parts[4] === 'preview') return send(200, engine.previewGoalCriteria(teamId, input));
          if (req.method === 'POST' && parts[4] === 'freeze') return send(201, engine.freezeCriteria(teamId, input));
          if (req.method === 'POST' && parts[4] === 'signoff') return send(201, engine.recordCriterionSignoff(teamId, input));
        }
        if (parts[3] === 'candidates') {
          if (req.method === 'GET' && parts.length === 4) return send(200, engine.listCandidates(teamId));
          if (req.method === 'POST' && parts.length === 4) return send(201, await engine.createCandidate(teamId, input));
          if (parts[4]) {
            const candId = decodeURIComponent(parts[4]);
            if (req.method === 'GET' && parts.length === 5) return send(200, engine.getCandidate(teamId, candId));
            if (req.method === 'POST' && parts[5] === 'approve') return send(201, engine.approveCandidate(teamId, { ...input, candidateId: candId }));
            if (req.method === 'POST' && parts[5] === 'publish-local') return send(200, await engine.publishCandidateLocal(teamId, { ...input, candidateId: candId }));
            if (req.method === 'POST' && parts[5] === 'base-drift') return send(200, await engine.checkCandidateBaseDrift(teamId, { ...input, candidateId: candId }));
          }
        }
        if (parts[3] === 'budget') {
          if (req.method === 'GET') return send(200, engine.getTeamBudget(teamId));
          if (req.method === 'POST') return send(200, engine.setTeamBudget(teamId, input));
        }
        if (parts[3] === 'env-recipes') {
          if (req.method === 'GET') return send(200, { recipes: engine.listEnvRecipes(teamId) });
          if (req.method === 'POST') return send(201, engine.approveEnvRecipe(teamId, input));
        }
        if (parts[3] === 'remote') {
          if (req.method === 'POST' && parts[4] === 'push') return send(200, await engine.pushCandidateRemote(teamId, input));
          if (req.method === 'POST' && parts[4] === 'pr-create') {
            try { return send(200, await engine.createPullRequestIdempotent(teamId, input)); }
            catch (error) {
              if (error.code === 'REMOTE_PR_TRANSPORT_UNAVAILABLE' || /REMOTE_PR_TRANSPORT_UNAVAILABLE|Authorized write transport\.createPullRequest is required|transport unavailable|No PR transport/i.test(error.message || '')) {
                error.status = 501;
                error.code = 'REMOTE_PR_TRANSPORT_UNAVAILABLE';
              }
              throw error;
            }
          }
          if (req.method === 'POST' && parts[4] === 'reconcile') return send(200, await engine.reconcileRemoteIntents(teamId, input));
          if (req.method === 'POST' && parts[4] === 'unknown' && parts[5] === 'resolve') return send(200, engine.resolveUnknownPrIntent(teamId, input));
          if (req.method === 'POST' && parts[4] === 'events') return send(200, engine.ingestRemoteFailureEvent(teamId, input));
          if (req.method === 'POST' && parts[4] === 'drift' && parts[5] === 'resolve') return send(200, engine.resolveExternalDrift(teamId, input));
        }
        if (req.method === 'POST' && parts[3] === 'approvals' && parts[4] && parts[5] === 'revoke') {
          return send(200, engine.revokeApproval(teamId, { ...input, approvalId: decodeURIComponent(parts[4]) }));
        }
        if (req.method === 'POST' && parts[3] === 'publish-intents' && parts[4] === 'reconcile') {
          return send(200, await engine.reconcilePublishIntents(teamId));
        }
        if (req.method === 'POST' && parts[3] === 'pr' && parts[4] === 'reconcile') {
          return send(200, await engine.reconcileGitHubPr(teamId, input));
        }
        if ((req.method === 'POST' && parts[3] === 'session' && parts.length === 4) || (req.method === 'POST' && parts[3] === 'rebind-session' && parts.length === 4)) {
          return send(200, engine.bindTeamSession(teamId, input.sessionId, { verifyOnline: true, actor: input?.actor ?? 'dsh-workbench:user' }));
        }
        if (req.method === 'POST' && parts[3] === 'control') {
          if (input?.action === 'resume' && input?.sessionId && typeof input.sessionId === 'string' && input.sessionId.trim()) {
            engine.bindTeamSession(teamId, input.sessionId.trim(), { onlyIfUnbound: true, verifyOnline: true, actor: 'dsh-workbench:control' });
          }
          return send(200, await engine.teamControl(teamId, input.action));
        }
        if (req.method === 'POST' && parts[3] === 'archive') {
          return send(200, await engine.archiveTeam(teamId, input.archived !== false));
        }
        if (parts[3] === 'native') {
          const t = engine.getTeam(teamId);
          return send(200, { bindings: t.sessionId ? [{ id: `dsh:${t.sessionId}`, role: 'parent', threadId: t.sessionId, allowMessages: true }] : [] });
        }
        if (parts[3] === 'sources') {
          const scoped = engine.contextForTeam(teamId);
          if (req.method === 'GET' && parts[4]) {
            return send(200, scoped.readSource(decodeURIComponent(parts[4]), { offset: integer(query.offset, 0, 1e9), limit: integer(query.limit, 8192, 65536) }));
          }
          if (req.method === 'GET') return send(200, { sources: scoped.listSources() });
          if (req.method === 'POST') {
            if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('原文不能为空');
            return send(201, scoped.addSource(input));
          }
        }
      }

      if (req.method === 'GET' && pathname === '/api/models') {
        return send(200, { models: await adapter.models({ sessionId: query.sessionId ?? null }) });
      }
      if (req.method === 'POST' && pathname === '/api/sources') {
        if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('原文不能为空');
        return send(201, contextStore.addSource(input));
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'sources' && parts[2]) {
        return send(200, contextStore.readSource(decodeURIComponent(parts[2]), { offset: integer(query.offset, 0, 1e9), limit: integer(query.limit, 8192, 65536) }));
      }
      if (req.method === 'POST' && pathname === '/api/tasks') {
        if (typeof input.goal !== 'string' || !input.goal.trim()) throw new Error('请填写任务目标');
        return send(201, await engine.submit(input));
      }
      if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        if (req.method === 'GET' && query.teamId && (await engine.get(id)).teamId !== query.teamId) {
          throw new Error('Task does not belong to the requested team');
        }
        if (req.method === 'GET' && !parts[3]) return send(200, await engine.get(id));
        if (req.method === 'GET' && parts[3] === 'inspection') {
          const task = await engine.get(id);
          if (query.teamId && task.teamId !== query.teamId) throw new Error('Task does not belong to the requested team');
          return send(200, buildInspection(task, { budgetBytes: integer(query.budgetBytes, 16384, 65536) }));
        }
        if (req.method === 'GET' && parts[3] === 'events') return send(200, await engine.events(id, { after: integer(query.after, 0, 1e9), limit: integer(query.limit, 60, 200) }));
        if (req.method === 'GET' && parts[3] === 'result') return send(200, await engine.result(id, { offset: integer(query.offset, 0, 1e9), limit: integer(query.limit, 8192, 65536) }));
        if (req.method === 'GET' && parts[3] === 'files') return send(200, await engine.listTaskFiles(id));
        if (req.method === 'GET' && parts[3] === 'file') return send(200, await engine.readTaskFile(id, query.path, { offset: integer(query.offset, 0, 1e9), limit: integer(query.limit, 16384, 65536) }));
        if (req.method === 'POST') {
          const actor = input.actor ?? 'dsh-workbench:user';
          if (parts[3] === 'control') return send(200, await engine.control(id, input.action));
          if (parts[3] === 'accept') return send(200, await engine.accept(id, { expectedRevision: input.expectedRevision, reason: input.reason, actor, acknowledgeHostFailure: input.acknowledgeHostFailure }));
          if (parts[3] === 'freeze') return send(200, await engine.freeze(id, { expectedRevision: input.expectedRevision, actor }));
          if (parts[3] === 'abandon') return send(200, await engine.abandon(id, { expectedRevision: input.expectedRevision, reason: input.reason, evidence: input.evidence, actor }));
          if (parts[3] === 'resolve-unresolved') return send(200, engine.resolveUnresolved(id, { expectedRevision: input.expectedRevision, expectedAttemptId: input.expectedAttemptId, reason: input.reason, evidence: input.evidence, actor }));
          if (parts[3] === 'rework') return send(200, await engine.rework(id, { expectedRevision: input.expectedRevision, feedback: input.feedback, actor }));
          if (parts[3] === 'verify') return send(200, await engine.verify(id));
          if (parts[3] === 'reconcile') return send(200, await engine.reconcile(id));
          if (parts[3] === 'retry') return send(200, await engine.retry(id));
        }
      }

      send(404, { error: '没有该操作' });
    } catch (error) {
      engine.recordRefusal?.('http', req.url || '', error.message || String(error), { method: req.method, code: error.code ?? null });
      if (!res.headersSent) {
        send(Number.isInteger(error.status) ? error.status : 400, {
          error: error.message || String(error),
          ...(error.code ? { code: error.code } : {}),
          ...(error.details ? { details: error.details } : {}),
          ...(error.code === 'CONTEXT_BUDGET_EXCEEDED'
            ? Object.fromEntries(['budgetBytes', 'requiredBytes', 'overByBytes', 'budgetBreakdown'].map(key => [key, error[key]]))
            : {}),
        });
      } else {
        res.end();
      }
    }
  };

  const dispose = () => {
    closing = true;
    clearInterval(heartbeat);
    engine.off?.('change', onEngineChange);
    engine.off?.('activity', onEngineActivity);
    approvals?.off?.('change', onApprovalChange);
    for (const client of [...sseClients.keys()]) {
      try { client.end(); } catch {}
    }
    sseClients.clear();
  };

  return { handler, notifyWorkbenchOpen, setFence, dispose, token };
}

export function createStandaloneDshServer(options) {
  const router = createDshEngineRouter({ ...options, fence: null });
  const server = http.createServer(router.handler);
  server.headersTimeout = 15000;
  server.requestTimeout = 130000;
  server.keepAliveTimeout = 10000;
  server.on('close', () => router.dispose());
  return { server, token: router.token, notifyWorkbenchOpen: router.notifyWorkbenchOpen, dispose: router.dispose };
}
