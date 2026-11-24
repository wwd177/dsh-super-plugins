const PRIORITY_RANK = { critical: 4, high: 3, normal: 2, low: 1 };
const DIFFICULTY_WEIGHT = { low: 1, easy: 1, medium: 2, high: 3, hard: 3 };
const TERMINAL_DONE = new Set(['accepted']);

export const VALID_PRIORITIES = ['critical', 'high', 'normal', 'low'];

export function priorityRank(value) {
  return PRIORITY_RANK[value] ?? PRIORITY_RANK.normal;
}

export function normalizeScope(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!cleaned) return '';
  if (cleaned === '.' || cleaned === '*' || cleaned === '**') return '*';
  return cleaned.replace(/(?:\/\*+)+$/, '') || '*';
}

export function scopesOverlap(a, b) {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (!left || !right) return false;
  if (left === '*' || right === '*' || left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function taskScopesOverlap(scopesA = [], scopesB = []) {
  if (!Array.isArray(scopesA) || !Array.isArray(scopesB) || !scopesA.length || !scopesB.length) return null;
  for (const sa of scopesA) {
    for (const sb of scopesB) {
      if (scopesOverlap(sa, sb)) return [sa, sb];
    }
  }
  return null;
}

export function pathMatchesWriteScopes(relPath, writeScopes = []) {
  if (!Array.isArray(writeScopes) || !writeScopes.length) return true;
  const normFile = normalizeScope(relPath);
  if (!normFile) return false;
  return writeScopes.some(scope => {
    const normScope = normalizeScope(scope);
    if (!normScope) return false;
    if (normScope === '*' || normFile === normScope) return true;
    return normFile.startsWith(`${normScope}/`);
  });
}

/**
 * Analyze a set of tasks as a DAG:
 * - Topological waves (0-based parallel execution stages)
 * - Downstream transitive unblocking count per task
 * - Critical path remaining depth & weight (CPM-style longest path to sink)
 * - Ready queue order prioritizing explicit priority -> critical path -> downstream impact
 * - Same-wave write-scope overlap warnings (advisory conflict detection)
 */
export function analyzeTaskGraph(tasks = []) {
  const byId = new Map();
  for (const task of tasks) byId.set(task.id, task);

  const children = new Map();
  const parents = new Map();
  for (const task of tasks) {
    children.set(task.id, []);
    const deps = (task.dependsOn ?? []).filter(dep => byId.has(dep));
    parents.set(task.id, deps);
  }
  for (const task of tasks) {
    for (const dep of parents.get(task.id)) {
      children.get(dep).push(task.id);
    }
  }

  // Compute topological wave (longest distance from any root)
  const waveMemo = new Map();
  const waveVisiting = new Set();
  const computeWave = id => {
    if (waveMemo.has(id)) return waveMemo.get(id);
    if (waveVisiting.has(id)) return 0; // Guard against corrupted external cycles
    waveVisiting.add(id);
    const deps = parents.get(id) ?? [];
    const level = deps.length ? 1 + Math.max(...deps.map(computeWave)) : 0;
    waveVisiting.delete(id);
    waveMemo.set(id, level);
    return level;
  };

  // Compute remaining critical path (depth & weighted effort to sink, counting unaccepted tasks)
  const cpMemo = new Map();
  const cpVisiting = new Set();
  const computeCritical = id => {
    if (cpMemo.has(id)) return cpMemo.get(id);
    if (cpVisiting.has(id)) return { depth: 0, weight: 0 };
    cpVisiting.add(id);
    const task = byId.get(id);
    const selfActive = TERMINAL_DONE.has(task.state) ? 0 : 1;
    const selfWeight = TERMINAL_DONE.has(task.state) ? 0 : (DIFFICULTY_WEIGHT[task.difficulty] ?? 2);
    const kids = children.get(id) ?? [];
    let bestDepth = 0;
    let bestWeight = 0;
    for (const childId of kids) {
      const sub = computeCritical(childId);
      if (sub.weight > bestWeight || (sub.weight === bestWeight && sub.depth > bestDepth)) {
        bestDepth = sub.depth;
        bestWeight = sub.weight;
      }
    }
    const res = { depth: selfActive + bestDepth, weight: selfWeight + bestWeight };
    cpVisiting.delete(id);
    cpMemo.set(id, res);
    return res;
  };

  // Compute transitive downstream count (how many unaccepted tasks depend directly or transitively on this task)
  const downstreamMemo = new Map();
  const computeDownstream = id => {
    if (downstreamMemo.has(id)) return downstreamMemo.get(id);
    const seen = new Set();
    const stack = [...(children.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of children.get(cur) ?? []) stack.push(next);
    }
    const count = [...seen].filter(cid => !TERMINAL_DONE.has(byId.get(cid)?.state)).length;
    downstreamMemo.set(id, count);
    return count;
  };

  const nodes = new Map();
  let maxCriticalWeight = 0;
  for (const task of tasks) {
    const wave = computeWave(task.id);
    const cp = computeCritical(task.id);
    const downstreamCount = computeDownstream(task.id);
    if (!TERMINAL_DONE.has(task.state) && cp.weight > maxCriticalWeight) {
      maxCriticalWeight = cp.weight;
    }
    nodes.set(task.id, {
      id: task.id,
      title: task.title,
      memberId: task.memberId ?? null,
      state: task.state,
      blockReason: task.blockReason ?? null,
      difficulty: task.difficulty ?? 'medium',
      priority: task.priority ?? 'normal',
      autoAccept: Boolean(task.autoAccept),
      writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes : [],
      dependsOn: parents.get(task.id) ?? [],
      wave,
      downstreamCount,
      criticalDepth: cp.depth,
      criticalWeight: cp.weight,
      onCriticalPath: false,
    });
  }

  // Mark exact critical path chain starting from highest remaining critical weight unaccepted node(s)
  const criticalPathIds = [];
  if (maxCriticalWeight > 0) {
    const roots = [...nodes.values()]
      .filter(n => !TERMINAL_DONE.has(n.state) && n.criticalWeight === maxCriticalWeight)
      .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || b.downstreamCount - a.downstreamCount || a.wave - b.wave);
    let current = roots[0];
    const visited = new Set();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      current.onCriticalPath = true;
      criticalPathIds.push(current.id);
      const nextCandidates = (children.get(current.id) ?? [])
        .map(cid => nodes.get(cid))
        .filter(n => n && !TERMINAL_DONE.has(n.state))
        .sort((a, b) => b.criticalWeight - a.criticalWeight || b.criticalDepth - a.criticalDepth || priorityRank(b.priority) - priorityRank(a.priority));
      current = nextCandidates[0] ?? null;
    }
  }

  // Group into waves
  const waveMap = new Map();
  for (const node of nodes.values()) {
    if (!waveMap.has(node.wave)) waveMap.set(node.wave, []);
    waveMap.get(node.wave).push(node);
  }
  const waves = [...waveMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, items]) => ({
      wave: index,
      tasks: items.sort((a, b) => Number(b.onCriticalPath) - Number(a.onCriticalPath) || priorityRank(b.priority) - priorityRank(a.priority) || b.downstreamCount - a.downstreamCount),
    }));

  // Detect advisory write-scope overlaps among active/unaccepted tasks that can execute in parallel (no ancestor/descendant relationship)
  const isAncestor = (anc, desc) => {
    const stack = [...(parents.get(desc) ?? [])];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of parents.get(cur) ?? []) stack.push(p);
    }
    return false;
  };
  const scopeOverlaps = [];
  const activeWithScopes = [...nodes.values()].filter(n => !TERMINAL_DONE.has(n.state) && !['cancelled', 'abandoned'].includes(n.state) && n.writeScopes.length > 0);
  for (let i = 0; i < activeWithScopes.length; i++) {
    for (let j = i + 1; j < activeWithScopes.length; j++) {
      const a = activeWithScopes[i];
      const b = activeWithScopes[j];
      if (isAncestor(a.id, b.id) || isAncestor(b.id, a.id)) continue;
      const matched = [];
      for (const sa of a.writeScopes) {
        for (const sb of b.writeScopes) {
          if (scopesOverlap(sa, sb)) matched.push([sa, sb]);
        }
      }
      if (matched.length) {
        scopeOverlaps.push({
          taskA: { id: a.id, title: a.title, memberId: a.memberId },
          taskB: { id: b.id, title: b.title, memberId: b.memberId },
          scopes: matched.slice(0, 6),
        });
      }
    }
  }

  const maxParallelWidth = waves.reduce((max, w) => Math.max(max, w.tasks.length), 0);
  const remainingCount = [...nodes.values()].filter(n => !TERMINAL_DONE.has(n.state) && !['cancelled', 'abandoned'].includes(n.state)).length;

  return {
    totalTasks: tasks.length,
    remainingTasks: remainingCount,
    waveCount: waves.length,
    maxParallelWidth,
    criticalPathIds,
    criticalPathWeight: maxCriticalWeight,
    scopeOverlaps,
    waves,
    nodes,
  };
}

/**
 * Sort ready candidate tasks by scientific scheduling priority:
 * 1. Explicit priority (critical > high > normal > low)
 * 2. On critical path (true > false)
 * 3. Remaining critical path weight (higher first to shorten makespan)
 * 4. Transitive downstream unblock count (higher first to unlock parallelism)
 * 5. Creation timestamp (FIFO tie-breaker)
 */
export function rankReadyCandidates(candidates, allTasks) {
  if (candidates.length <= 1) return [...candidates];
  const graph = analyzeTaskGraph(allTasks);
  return [...candidates].sort((a, b) => {
    const na = graph.nodes.get(a.id);
    const nb = graph.nodes.get(b.id);
    return (
      priorityRank(b.priority) - priorityRank(a.priority)
      || Number(Boolean(nb?.onCriticalPath)) - Number(Boolean(na?.onCriticalPath))
      || (nb?.criticalWeight ?? 0) - (na?.criticalWeight ?? 0)
      || (nb?.downstreamCount ?? 0) - (na?.downstreamCount ?? 0)
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    );
  });
}

export function serializeTaskGraph(graph) {
  return {
    totalTasks: graph.totalTasks,
    remainingTasks: graph.remainingTasks,
    waveCount: graph.waveCount,
    maxParallelWidth: graph.maxParallelWidth,
    criticalPathIds: graph.criticalPathIds,
    criticalPathWeight: graph.criticalPathWeight,
    scopeOverlaps: graph.scopeOverlaps,
    waves: graph.waves,
  };
}
