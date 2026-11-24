const maintenanceBlockingStates = new Set([
  'queued', 'blocked', 'dispatching', 'running', 'pausing', 'cancelling',
  'unknown', 'paused-unconfirmed', 'cancelled-unconfirmed'
]);

export function blocksIdleMaintenance(task) {
  return Boolean(task.executionUnresolved) || maintenanceBlockingStates.has(task.state);
}

// Shared by the overview and notifications; normal scheduler waits need no decision.
export function taskAttention(task) {
  if (task.state === 'blocked') {
    const reason = task.blockReason ?? (task.error ? 'preflight' : 'dependency');
    return { needsDecision: ['preflight','dependency-abandoned'].includes(reason), reason };
  }
  if (task.state === 'abandoned') return { needsDecision: task.executionUnresolved !== false, reason: task.executionUnresolved !== false ? 'abandoned-unresolved-execution' : null };
  if (['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed'].includes(task.state)) return { needsDecision: true, reason: 'unresolved-execution' };
  if (task.state === 'failed') return { needsDecision: true, reason: 'execution-failed' };
  if (['submitted', 'checked'].includes(task.state)) return { needsDecision: true, reason: 'acceptance-required' };
  return { needsDecision: false, reason: null };
}
