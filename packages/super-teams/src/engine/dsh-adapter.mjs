import { randomUUID } from 'node:crypto';

const DEFAULT_EFFORTS = ['low', 'medium', 'high'];

function extractTextBlocks(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text);
  }
  return parts.join('\n\n');
}

function extractSessionUsageAndText(events = []) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let hasUsage = false;
  let lastAssistantText = '';
  for (const ev of events) {
    const data = ev?.data ?? ev;
    const msg = data?.message ?? (data?.role === 'assistant' ? data : null);
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      const txt = extractTextBlocks(msg.content);
      if (txt) lastAssistantText = txt;
    }
    const u = data?.usage ?? msg?.usage ?? data?.metrics?.usage;
    if (u && typeof u === 'object') {
      const inp = Number(u.inputTokens ?? u.input_tokens ?? u.prompt_tokens);
      const out = Number(u.outputTokens ?? u.output_tokens ?? u.completion_tokens);
      const cached = Number(u.cachedInputTokens ?? u.cached_input_tokens ?? u.cacheReadInputTokens ?? 0);
      if (Number.isFinite(inp) && inp >= 0 && Number.isFinite(out) && out >= 0) {
        inputTokens += inp;
        outputTokens += out;
        if (Number.isFinite(cached) && cached >= 0) cachedInputTokens += cached;
        hasUsage = true;
      }
    }
  }
  const usage = hasUsage
    ? {
        source: 'deepseek-harness-session',
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
      }
    : null;
  return { usage, lastAssistantText };
}

function summarizeDshSessionEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const type = String(ev.type ?? '');
  const data = ev.data ?? {};
  if (type.includes('tool') && (data.name || data.toolName || data.call?.name)) {
    const toolName = data.name ?? data.toolName ?? data.call?.name;
    const done = /end|complete|result|finish/i.test(type);
    return {
      method: done ? 'item/completed' : 'item/started',
      params: { item: { type: 'toolCall', name: String(toolName) } },
    };
  }
  const msg = data.message ?? (data.role ? data : null);
  if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if ((part?.type === 'tool_call' || part?.type === 'tool-call' || part?.type === 'toolUse') && part.name) {
        return {
          method: 'item/started',
          params: { item: { type: 'toolCall', name: String(part.name) } },
        };
      }
    }
    if (msg.content.some(part => part?.type === 'text' && part.text)) {
      return {
        method: 'item/completed',
        params: { item: { type: 'agentMessage' } },
      };
    }
  }
  return null;
}

function readParentSelectionFromEvents(events = []) {
  let selected = null;
  let allowedRoutes = null;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'subagent/model-selection-policy' && Array.isArray(ev.data?.allowedModels) && allowedModelsValid(ev.data.allowedModels)) {
      if (allowedRoutes === null) {
        allowedRoutes = ev.data.allowedModels.map(r => ({ provider: r.provider, model: r.model }));
      }
    }
    if ((ev.type === 'model-selection/change' || ev.type === 'agent/model-selection') && ev.data?.provider && ev.data?.model) {
      selected = {
        provider: String(ev.data.provider),
        model: String(ev.data.model),
        ...(ev.data.reasoningEffort ? { reasoningEffort: String(ev.data.reasoningEffort) } : {}),
      };
    }
  }
  return { selected, allowedRoutes };
}

function allowedModelsValid(routes) {
  return Array.isArray(routes) && routes.length > 0 && routes.every(r => r && typeof r.provider === 'string' && r.provider && typeof r.model === 'string' && r.model);
}

function snapshotEventsSafe(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents() ?? [];
    if (Array.isArray(session?.events)) return session.events;
  } catch { /* ignore transient snapshot errors */ }
  return [];
}

function formatStopFailure(result) {
  if (!result) return 'DeepSeek Harness subagent stopped without result';
  const diag = result.diagnostic;
  if (typeof diag === 'string' && diag.trim()) return diag.trim();
  if (diag && typeof diag === 'object') {
    const msg = diag.message ?? diag.error ?? JSON.stringify(diag);
    if (msg) return String(msg);
  }
  return `Subagent ended with stopReason=${result.stopReason ?? 'error'}`;
}

export class DshAdapter {
  constructor({ ctx = null, mockRunner = null, onDiagnostic = () => {}, providerName = 'spawn', modelsCacheTtlMs = 15_000 } = {}) {
    this.ctx = ctx;
    this.mockRunner = typeof mockRunner === 'function' ? mockRunner : null;
    this.onDiagnostic = onDiagnostic;
    this.providerName = providerName;
    this.modelsCacheTtlMs = modelsCacheTtlMs;
    this._modelsCache = null;
    this.ownedThreads = new Set();
    this.tasks = new Map();
    this.preferredSessionId = null;
    this.closed = false;
    this.lastError = null;
  }

  bindContext(ctx) {
    this.ctx = ctx;
    this._modelsCache = null;
  }

  rememberSession(sessionId, workspaceCwd = null) {
    if (typeof sessionId === 'string' && sessionId.trim()) {
      this.preferredSessionId = sessionId.trim();
    }
    if (typeof workspaceCwd === 'string' && workspaceCwd.trim()) {
      this.preferredWorkspaceCwd = workspaceCwd.trim();
    }
  }

  authorizeThread(threadId) {
    if (typeof threadId === 'string' && threadId) this.ownedThreads.add(threadId);
  }

  async connect() {
    if (this.closed) throw new Error('DshAdapter is closed');
    return { host: 'deepseek-harness', provider: this.providerName };
  }

  _services() {
    const get = name => {
      try { return this.ctx?.get?.(name) ?? this.ctx?.[name] ?? undefined; }
      catch { return undefined; }
    };
    return {
      subagents: get('subagents'),
      agents: get('agents'),
      llm: get('llm'),
      sessionController: get('sessionController'),
      sessionQuery: get('sessionQuery'),
      workingDirectory: get('workingDirectory'),
    };
  }

  _liveRoots() {
    const { agents, subagents } = this._services();
    if (!agents || typeof agents.list !== 'function') return [];
    const list = agents.list();
    const roots = [];
    for (const agent of list) {
      if (!agent?.id) continue;
      if (!subagents || typeof subagents.rootOf !== 'function') {
        if (agent.session?.header?.origin !== 'subagent') roots.push(agent);
        continue;
      }
      try {
        const root = subagents.rootOf(agent);
        if (root === agent) roots.push(agent);
      } catch { /* skip non-root or detached agents */ }
    }
    return roots;
  }

  resolveRootAgent(requestedSessionId = null) {
    const { agents, subagents } = this._services();
    if (!agents || typeof agents.get !== 'function') return null;
    const candidates = [requestedSessionId, this.preferredSessionId].filter(id => typeof id === 'string' && id.trim());
    for (const id of candidates) {
      const found = agents.get(id);
      if (!found) continue;
      if (subagents && typeof subagents.rootOf === 'function') {
        try { return subagents.rootOf(found); } catch { continue; }
      }
      return found;
    }
    const roots = this._liveRoots();
    return roots.at(-1) ?? null;
  }

  sessionSnapshot(requestedSessionId = null) {
    const root = this.resolveRootAgent(requestedSessionId);
    const { workingDirectory } = this._services();
    const roots = this._liveRoots();
    if (!root) {
      return {
        available: Boolean(this.mockRunner) || roots.length > 0,
        activeSessionId: this.preferredSessionId ?? null,
        cwd: this.preferredWorkspaceCwd ?? null,
        liveSessionCount: roots.length,
        sessions: [],
      };
    }
    let cwd = root.session?.header?.cwd ?? this.preferredWorkspaceCwd ?? null;
    try {
      if (workingDirectory?.get && root.session) cwd = workingDirectory.get(root.session) ?? cwd;
    } catch { /* ignore */ }
    const events = snapshotEventsSafe(root.session);
    const { selected } = readParentSelectionFromEvents(events);
    const provider = selected?.provider ?? root.options?.provider ?? null;
    const model = selected?.model ?? root.options?.model ?? null;
    return {
      available: true,
      activeSessionId: root.id,
      cwd,
      provider,
      model,
      liveSessionCount: roots.length,
      sessions: roots.map(item => ({
        sessionId: item.id,
        cwd: (workingDirectory?.get && item.session ? workingDirectory.get(item.session) : null) ?? item.session?.header?.cwd ?? null,
      })),
    };
  }

  status() {
    if (this.closed) {
      return { state: 'closed', connected: false, reconnecting: false, closed: true, host: 'deepseek-harness', error: this.lastError };
    }
    if (this.mockRunner) {
      return { state: 'connected', connected: true, reconnecting: false, closed: false, host: 'deepseek-harness', mode: 'mock', activeRuns: this.tasks.size, error: null };
    }
    const { subagents, agents } = this._services();
    const hasProvider = Boolean(subagents?.getProvider?.(this.providerName));
    const connected = Boolean(subagents && agents && hasProvider);
    const roots = connected ? this._liveRoots() : [];
    return {
      state: connected ? 'connected' : this.ctx ? 'connecting' : 'disconnected',
      connected,
      reconnecting: false,
      closed: false,
      host: 'deepseek-harness',
      provider: this.providerName,
      liveSessions: roots.length,
      activeSessionId: roots.at(-1)?.id ?? this.preferredSessionId ?? null,
      activeRuns: this.tasks.size,
      error: this.lastError,
    };
  }

  async _probeSupportedEfforts(llm, provider, model) {
    if (!llm || !provider || !model) return ['default'];
    try {
      if (typeof llm.resolveModelInfo === 'function') {
        const info = await llm.resolveModelInfo(provider, model);
        if (Array.isArray(info?.reasoningEfforts) && info.reasoningEfforts.length) {
          return info.reasoningEfforts.map(String);
        }
        if (info?.reasoning === false || info?.supportsReasoningEffort === false) {
          return ['default'];
        }
      }
    } catch { /* fall through to call-config probe */ }
    if (typeof llm.resolveCallConfig === 'function') {
      const supported = [];
      for (const effort of DEFAULT_EFFORTS) {
        try {
          await llm.resolveCallConfig({ provider, model, reasoningEffort: effort });
          supported.push(effort);
        } catch { /* effort not supported on this route */ }
      }
      if (supported.length) return supported;
    }
    return ['default'];
  }

  async models({ sessionId } = {}) {
    if (this.closed) throw new Error('DshAdapter is closed');
    if (this.mockRunner) {
      return [
        { model: 'deepseek-account/deepseek-reasoner', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'] },
        { model: 'deepseek-account/deepseek-flash', isDefault: false, supportedReasoningEfforts: ['default', 'low', 'medium'] },
      ];
    }
    const root = this.resolveRootAgent(sessionId);
    const cacheKey = root?.id ?? '__catalog__';
    if (this._modelsCache && this._modelsCache.key === cacheKey && Date.now() < this._modelsCache.expiresAt) {
      return structuredClone(this._modelsCache.models);
    }
    const { llm, sessionController } = this._services();
    const list = [];
    if (root) {
      const events = snapshotEventsSafe(root.session);
      const { selected, allowedRoutes } = readParentSelectionFromEvents(events);
      const parentProvider = selected?.provider ?? root.options?.provider;
      const parentModel = selected?.model ?? root.options?.model;
      if (parentProvider && parentModel) {
        const efforts = await this._probeSupportedEfforts(llm, parentProvider, parentModel);
        list.push({
          model: `${parentProvider}/${parentModel}`,
          provider: parentProvider,
          modelId: parentModel,
          isDefault: true,
          supportedReasoningEfforts: efforts,
        });
      }
      if (Array.isArray(allowedRoutes)) {
        for (const route of allowedRoutes) {
          const full = `${route.provider}/${route.model}`;
          if (list.some(item => item.model === full)) continue;
          try {
            if (llm?.resolveCallConfig) await llm.resolveCallConfig({ provider: route.provider, model: route.model });
            const efforts = await this._probeSupportedEfforts(llm, route.provider, route.model);
            list.push({
              model: full,
              provider: route.provider,
              modelId: route.model,
              isDefault: false,
              supportedReasoningEfforts: efforts,
            });
          } catch { /* skip unavailable route */ }
        }
      }
    }
    if (!list.length && sessionController?.modelCatalog) {
      try {
        const catalog = await sessionController.modelCatalog();
        const def = catalog?.default;
        if (def?.provider && def?.model) {
          const efforts = await this._probeSupportedEfforts(llm, def.provider, def.model);
          list.push({
            model: `${def.provider}/${def.model}`,
            provider: def.provider,
            modelId: def.model,
            isDefault: true,
            supportedReasoningEfforts: efforts,
          });
        }
        for (const group of catalog?.groups ?? []) {
          const provider = group?.provider ?? group?.id;
          for (const m of group?.models ?? []) {
            const modelId = m?.id ?? m?.model;
            if (!provider || !modelId) continue;
            const full = `${provider}/${modelId}`;
            if (list.some(item => item.model === full)) continue;
            list.push({
              model: full,
              provider,
              modelId,
              isDefault: false,
              supportedReasoningEfforts: ['default'],
            });
            if (list.length >= 12) break;
          }
          if (list.length >= 12) break;
        }
      } catch { /* ignore catalog error */ }
    }
    if (!list.length && llm?.listProviders) {
      try {
        for (const p of llm.listProviders() ?? []) {
          const pid = p?.id;
          const pModels = Array.isArray(p?.models) ? p.models : [];
          for (const m of pModels) {
            const mid = typeof m === 'string' ? m : (m?.id ?? m?.model);
            if (!pid || !mid) continue;
            list.push({
              model: `${pid}/${mid}`,
              provider: pid,
              modelId: mid,
              isDefault: list.length === 0,
              supportedReasoningEfforts: ['default'],
            });
            if (list.length >= 8) break;
          }
          if (list.length >= 8) break;
        }
      } catch { /* ignore */ }
    }
    if (!list.length) {
      list.push({
        model: 'dsh-inherit/session-default',
        isDefault: true,
        supportedReasoningEfforts: ['default'],
      });
    }
    this._modelsCache = { key: cacheKey, expiresAt: Date.now() + this.modelsCacheTtlMs, models: structuredClone(list) };
    return list;
  }

  async _buildChildAgentOptions(root, task, signal) {
    const { llm } = this._services();
    const events = snapshotEventsSafe(root.session);
    const { selected, allowedRoutes } = readParentSelectionFromEvents(events);
    const parentProvider = selected?.provider ?? root.options?.provider;
    const parentModel = selected?.model ?? root.options?.model;
    let targetProvider = parentProvider;
    let targetModel = parentModel;

    if (typeof task.model === 'string' && task.model && task.model !== 'dsh-inherit/session-default') {
      const slash = task.model.indexOf('/');
      if (slash > 0) {
        const candProvider = task.model.slice(0, slash);
        const candModel = task.model.slice(slash + 1);
        const sameAsParent = candProvider === parentProvider && candModel === parentModel;
        const allowedByPolicy = Array.isArray(allowedRoutes) && allowedRoutes.some(r => r.provider === candProvider && r.model === candModel);
        if (sameAsParent || allowedByPolicy) {
          targetProvider = candProvider;
          targetModel = candModel;
        }
      }
    }

    const options = {};
    const routeChanged = targetProvider && targetModel && (targetProvider !== parentProvider || targetModel !== parentModel);
    if (routeChanged) {
      options.provider = targetProvider;
      options.model = targetModel;
    }

    const effort = typeof task.effort === 'string' && task.effort && task.effort !== 'default' ? task.effort : undefined;
    if (effort && targetProvider && targetModel && llm?.resolveCallConfig) {
      try {
        await llm.resolveCallConfig({ provider: targetProvider, model: targetModel, reasoningEffort: effort }, signal);
        options.reasoningEffort = effort;
      } catch {
        this._diagnostic({ type: 'effort-fallback', model: `${targetProvider}/${targetModel}`, skippedEffort: effort });
      }
    } else if (effort && !llm) {
      options.reasoningEffort = effort;
    }

    return Object.keys(options).length ? options : undefined;
  }

  _diagnostic(event) {
    try { this.onDiagnostic(event); } catch { /* ignore */ }
  }

  async start(task, { beforeExecute = async () => {}, onIdentity = async () => {}, onEvent = () => {} } = {}) {
    if (this.closed) {
      throw Object.assign(new Error('DshAdapter is closed'), { executionNotStarted: true });
    }
    if (this.mockRunner) {
      await beforeExecute();
      const threadId = `dsh-mock-${randomUUID()}`;
      const turnId = `turn-${randomUUID()}`;
      this.ownedThreads.add(threadId);
      await onIdentity({ threadId, turnId });
      onEvent({ method: 'turn/started', params: { threadId, turnId } });
      let interrupted = false;
      const ac = new AbortController();
      const completion = Promise.resolve()
        .then(() => this.mockRunner(task, { signal: ac.signal, onEvent, threadId, turnId }))
        .then(res => {
          onEvent({ method: 'turn/completed', params: { turn: { id: turnId, status: res?.status ?? 'completed' } } });
          return {
            status: interrupted ? 'interrupted' : (res?.status ?? 'completed'),
            text: res?.text ?? '',
            usage: res?.usage ?? null,
            error: res?.error ?? null,
          };
        })
        .catch(err => ({
          status: interrupted || ac.signal.aborted ? 'interrupted' : 'failed',
          text: '',
          usage: null,
          error: err.message,
        }))
        .finally(() => {
          this.tasks.delete(task.id);
        });
      const entry = {
        threadId,
        turnId,
        interrupt: async () => {
          interrupted = true;
          ac.abort();
        },
      };
      this.tasks.set(task.id, entry);
      return { threadId, turnId, completion, interrupt: entry.interrupt };
    }

    const { subagents, agents } = this._services();
    if (!subagents || !agents || !subagents.getProvider?.(this.providerName)) {
      throw Object.assign(
        new Error('DeepSeek Harness 子代理服务（subagents/spawn）尚未就绪'),
        { executionNotStarted: true, blockReason: 'preflight' }
      );
    }
    const root = this.resolveRootAgent(task.sessionId ?? null);
    if (!root) {
      throw Object.assign(
        new Error('请先在 DeepSeek Harness 打开或选中一个活跃主聊天会话，随后再启动或恢复团队执行'),
        { executionNotStarted: true, blockReason: 'preflight' }
      );
    }

    const startupAbort = new AbortController();
    let agentOptions;
    try {
      agentOptions = await this._buildChildAgentOptions(root, task, startupAbort.signal);
      await beforeExecute();
    } catch (error) {
      throw Object.assign(error, { executionNotStarted: true });
    }

    let maxDepth;
    try {
      maxDepth = subagents.resolveMaxDepth?.();
    } catch { maxDepth = undefined; }

    let receipt;
    try {
      receipt = await subagents.startActivation({
        provider: this.providerName,
        parent: root,
        cwd: task.cwd,
        label: String(task.title || 'SuperAgent Task').slice(0, 80),
        prompt: [{ type: 'text', text: task.prompt }],
        ...(agentOptions ? { agentOptions } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        delivery: 'caller',
        signal: startupAbort.signal,
      });
    } catch (error) {
      const code = error?.code ?? '';
      const preStartCodes = new Set([
        'NO_PROVIDER',
        'UNSUPPORTED_CAPABILITY',
        'UNAUTHORIZED',
        'DUPLICATE_CHILD',
        'PROVIDER_CHANGED',
        'PERSISTENCE_UNAVAILABLE',
        'CONTINUATION_UNAVAILABLE',
      ]);
      const notStarted = startupAbort.signal.aborted || preStartCodes.has(code) || /max.*depth|not running|already exists|capability/i.test(error?.message ?? '');
      if (notStarted) error.executionNotStarted = true;
      this.lastError = error.message;
      throw error;
    }

    this.lastError = null;
    const threadId = String(receipt.childId);
    const turnId = String(receipt.messageId ?? receipt.childId);
    this.ownedThreads.add(threadId);
    await onIdentity({ threadId, turnId });
    onEvent({ method: 'turn/started', params: { threadId, turnId, subagentName: receipt.name } });

    let seenEventCount = 0;
    const pollEvents = () => {
      try {
        const child = agents.get(receipt.childId);
        if (!child?.session) return;
        const events = snapshotEventsSafe(child.session);
        if (events.length <= seenEventCount) return;
        const delta = events.slice(seenEventCount);
        seenEventCount = events.length;
        for (const ev of delta) {
          const mapped = summarizeDshSessionEvent(ev);
          if (mapped) onEvent(mapped);
        }
      } catch { /* ignore observer errors */ }
    };
    const observerTimer = setInterval(pollEvents, 400);
    observerTimer.unref?.();

    let interruptedByCaller = false;
    const interrupt = async () => {
      interruptedByCaller = true;
      startupAbort.abort();
      try { subagents.interrupt?.(receipt.childId, { kind: 'user' }); } catch { /* ignore */ }
      try { await receipt.dispose?.(); } catch { /* ignore */ }
    };

    const completion = Promise.resolve(receipt.result)
      .then(async settled => {
        clearInterval(observerTimer);
        pollEvents();
        let sessionEvents = [];
        try {
          const liveChild = agents.get(receipt.childId);
          if (liveChild?.session) sessionEvents = snapshotEventsSafe(liveChild.session);
          else {
            const { sessionQuery } = this._services();
            if (sessionQuery?.observeSession) {
              const observed = await sessionQuery.observeSession(receipt.childId, { signal: AbortSignal.timeout(3000) });
              try { sessionEvents = observed?.events ?? []; }
              finally { await observed?.[Symbol.asyncDispose]?.().catch?.(() => {}); observed?.[Symbol.dispose]?.(); }
            }
          }
        } catch { /* ignore */ }

        const { usage, lastAssistantText } = extractSessionUsageAndText(sessionEvents);
        const directText = extractTextBlocks(settled?.output);
        const text = directText || lastAssistantText || '';
        const stopReason = settled?.stopReason ?? 'error';
        onEvent({ method: 'turn/completed', params: { turn: { id: turnId, status: stopReason } } });

        if (stopReason === 'completed') {
          return { status: 'completed', text, usage, error: null };
        }
        if (stopReason === 'aborted' && interruptedByCaller) {
          return { status: 'interrupted', text, usage, error: 'Subagent interrupted by caller' };
        }
        return {
          status: 'failed',
          text,
          usage,
          error: formatStopFailure(settled),
        };
      })
      .catch(error => {
        clearInterval(observerTimer);
        return {
          status: interruptedByCaller ? 'interrupted' : 'failed',
          text: '',
          usage: null,
          error: error?.message ?? String(error),
        };
      })
      .finally(async () => {
        clearInterval(observerTimer);
        this.tasks.delete(task.id);
        try { await receipt.dispose?.(); } catch { /* ignore */ }
      });

    this.tasks.set(task.id, { threadId, turnId, interrupt });
    return { threadId, turnId, completion, interrupt };
  }

  async inspect(threadId) {
    if (!this.ownedThreads.has(threadId)) {
      throw new Error('Refusing to inspect a session not started by this SuperAgent engine');
    }
    const { agents, sessionQuery } = this._services();
    const live = agents?.get?.(threadId);
    if (live?.session) {
      const events = snapshotEventsSafe(live.session);
      return { id: threadId, resident: true, eventCount: events.length, turns: [] };
    }
    if (!sessionQuery?.observeSession) {
      return { id: threadId, resident: false, turns: [] };
    }
    const observed = await sessionQuery.observeSession(threadId, { signal: AbortSignal.timeout(5000) });
    try {
      const events = observed?.events ?? [];
      const { lastAssistantText } = extractSessionUsageAndText(events);
      const endEvent = [...events].reverse().find(ev => ev?.type === 'turn/end' || ev?.type === 'agent/turn-end' || ev?.data?.reason?.kind);
      const kind = endEvent?.data?.reason?.kind;
      const terminalStatus = kind === 'completed' ? 'completed' : (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') ? 'failed' : null;
      return {
        id: threadId,
        resident: false,
        turns: terminalStatus
          ? [{
              id: threadId,
              status: terminalStatus,
              items: lastAssistantText ? [{ type: 'agentMessage', text: lastAssistantText }] : [],
              error: terminalStatus === 'failed' ? (endEvent?.data?.reason?.message ?? `Turn ended with ${kind}`) : null,
            }]
          : [],
      };
    } finally {
      try { await observed?.[Symbol.asyncDispose]?.(); } catch { /* ignore */ }
      try { observed?.[Symbol.dispose]?.(); } catch { /* ignore */ }
    }
  }

  async close() {
    this.closed = true;
    const running = [...this.tasks.values()];
    this.tasks.clear();
    await Promise.allSettled(running.map(entry => entry.interrupt()));
  }
}
