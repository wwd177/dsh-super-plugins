import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

function summarizeApproval(method, params = {}) {
  const cmd = params.command ?? params.cmd ?? params.parsedCmd;
  const cmdText = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
  const files = params.fileChanges ?? params.files ?? params.changes;
  const fileCount = Array.isArray(files) ? files.length : files && typeof files === 'object' ? Object.keys(files).length : 0;
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    return cmdText ? `请求执行命令：${cmdText.slice(0, 160)}` : '请求执行终端命令';
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return fileCount ? `请求修改 ${fileCount} 个文件` : '请求修改文件';
  }
  if (method === 'item/permissions/requestApproval') {
    return '请求额外权限';
  }
  return `请求交互审批：${method}`;
}

function compactDetail(params = {}) {
  try {
    const raw = JSON.stringify(params, null, 2);
    return raw.length > 4000 ? `${raw.slice(0, 4000)}\n... (truncated)` : raw;
  } catch {
    return String(params);
  }
}

export class PendingApprovalManager extends EventEmitter {
  constructor({ maxPending = 32 } = {}) {
    super();
    this.maxPending = maxPending;
    this.pending = new Map();
    this.closed = false;
  }

  list() {
    const now = Date.now();
    return [...this.pending.values()].map(entry => ({
      id: entry.id,
      method: entry.method,
      threadId: entry.threadId,
      turnId: entry.turnId,
      taskId: entry.taskId,
      taskTitle: entry.taskTitle,
      summary: entry.summary,
      detail: entry.detail,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      remainingMs: Math.max(0, entry.expiresAtMs - now),
    }));
  }

  request({ method, params = {}, threadId = null, turnId = null, taskId = null, taskTitle = null, timeoutMs = 120_000, signal = null } = {}) {
    if (this.closed || this.pending.size >= this.maxPending) {
      return Promise.resolve({ decision: 'deny', reason: this.closed ? 'Engine is closing' : 'Too many pending approval requests' });
    }
    const id = randomUUID();
    const createdAtMs = Date.now();
    const durationMs = Math.max(1000, Number(timeoutMs) || 120_000);
    const expiresAtMs = createdAtMs + durationMs;
    return new Promise(resolve => {
      let timer = null;
      const finish = (decision, reason) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve({ decision, reason });
        this.emit('change', { type: 'approval-resolved', id, decision });
      };
      const onAbort = () => finish('deny', 'Approval request timed out or cancelled; denied by default');
      const entry = {
        id,
        method,
        threadId,
        turnId,
        taskId,
        taskTitle,
        summary: summarizeApproval(method, params),
        detail: compactDetail(params),
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        finish,
      };
      if (signal) {
        if (signal.aborted) {
          resolve({ decision: 'deny', reason: 'Approval request already aborted' });
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(() => finish('deny', 'Approval request timed out; denied by default'), durationMs);
      timer.unref?.();
      this.pending.set(id, entry);
      this.emit('change', { type: 'approval-requested', id, summary: entry.summary, taskId });
    });
  }

  decide(id, decision, { reason } = {}) {
    if (!['allow', 'deny'].includes(decision)) throw new Error('Approval decision must be allow or deny');
    const entry = this.pending.get(id);
    if (!entry) throw new Error('Approval request not found or already resolved');
    const note = typeof reason === 'string' && reason.trim()
      ? reason.trim().slice(0, 500)
      : decision === 'allow' ? 'Explicitly approved by user in dashboard' : 'Denied by user in dashboard';
    entry.finish(decision, note);
    return { id, decision, reason: note };
  }

  close() {
    this.closed = true;
    for (const entry of [...this.pending.values()]) {
      entry.finish('deny', 'Engine closed before approval decision');
    }
  }
}
