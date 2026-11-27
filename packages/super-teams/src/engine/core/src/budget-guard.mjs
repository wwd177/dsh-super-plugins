import { createHash } from 'node:crypto';

const now = () => new Date().toISOString();

const positiveIntOrNull = (val, field) => {
  if (val === undefined || val === null) return null;
  if (!Number.isInteger(val) || val < 1) {
    throw new Error(`${field} must be a positive integer or null`);
  }
  return val;
};

export function normalizeBudgetConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('budget must be an object');
  }
  return {
    maxTeamAttempts: positiveIntOrNull(raw.maxTeamAttempts, 'budget.maxTeamAttempts'),
    maxInFlight: positiveIntOrNull(raw.maxInFlight, 'budget.maxInFlight'),
    maxTaskDurationMs: positiveIntOrNull(raw.maxTaskDurationMs, 'budget.maxTaskDurationMs'),
    maxTeamTokensSoft: positiveIntOrNull(raw.maxTeamTokensSoft, 'budget.maxTeamTokensSoft'),
    sameErrorBreakerThreshold: raw.sameErrorBreakerThreshold === null
      ? null
      : (raw.sameErrorBreakerThreshold === undefined
          ? null
          : positiveIntOrNull(raw.sameErrorBreakerThreshold, 'budget.sameErrorBreakerThreshold')),
  };
}

export function extractTotalTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const candidates = [usage.totalTokens, usage.total_tokens, usage.total];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) return Math.trunc(val);
  }
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
    return Math.trunc(input + output);
  }
  return 0;
}

export function computeErrorFingerprint(errorText) {
  const normalized = String(errorText ?? '')
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '<ts>')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '<uuid>')
    .replace(/:\d+:\d+\b/g, ':<line>')
    .replace(/\d+ms\b/g, '<ms>')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 事务型预算预占与熔断守卫（Phase 0.3）：
 * - 硬上限（总尝试次数 / 并发槽位 / 单次运行时长）：在 SQLite 事务内原子检查并预占，杜绝多 worker 并发超发。
 * - Token 上限：明确标为软上限，按 (attemptId, threadId) 幂等记录最新单调累计值（重启重放与迟到快照绝不重复叠加），并公开在途暴露数。
 */
export class BudgetGuard {
  constructor({ store }) {
    this.store = store;
  }

  _defaultLedger(teamId, config = normalizeBudgetConfig({})) {
    return {
      teamId,
      config,
      attemptsReserved: 0,
      attemptsUsed: 0,
      inFlightAttemptIds: [],
      usageByAttemptThread: {},
      totalTokens: 0,
      softLimitExceeded: false,
      inFlightExposureAtBreach: 0,
      frozenReason: null,
      errorStreaks: {},
      updatedAt: null,
    };
  }

  getLedger(teamId) {
    const existing = this.store.budgetLedger?.(teamId);
    if (existing) return existing;
    return this._defaultLedger(teamId);
  }

  configureTeamBudget(teamId, rawBudget) {
    const config = normalizeBudgetConfig(rawBudget);
    return this.store.transaction(() => {
      const ledger = this.store.budgetLedger(teamId) ?? this._defaultLedger(teamId, config);
      ledger.config = config;
      // Clear previous frozen reason if operator explicitly increased limits above current usage.
      if (ledger.frozenReason === 'budget_exceeded:attempts' && (!config.maxTeamAttempts || ledger.attemptsReserved < config.maxTeamAttempts)) {
        ledger.frozenReason = null;
      }
      if (ledger.frozenReason === 'budget_exceeded:tokens_soft_limit' && (!config.maxTeamTokensSoft || ledger.totalTokens <= config.maxTeamTokensSoft)) {
        ledger.frozenReason = null;
        ledger.softLimitExceeded = false;
      }
      ledger.updatedAt = now();
      this.store.saveBudgetLedger(ledger);
      return ledger;
    });
  }

  peekReserveBlock(teamId) {
    if (!teamId) return { blocked: false };
    const ledger = this.store.budgetLedger?.(teamId);
    if (!ledger) return { blocked: false };
    const cfg = ledger.config ?? {};
    const hasAnyLimit = Boolean(cfg.maxTeamAttempts || cfg.maxInFlight || cfg.maxTaskDurationMs || cfg.maxTeamTokensSoft || cfg.sameErrorBreakerThreshold);
    if (!hasAnyLimit) return { blocked: false };
    if (ledger.frozenReason) {
      return {
        blocked: true,
        code: 'BUDGET_FROZEN',
        budgetReason: ledger.frozenReason,
        message: `Team dispatch blocked by budget guard: ${ledger.frozenReason}`,
      };
    }
    if (cfg.maxInFlight && ledger.inFlightAttemptIds.length >= cfg.maxInFlight) {
      return {
        blocked: true,
        code: 'BUDGET_EXCEEDED_CONCURRENCY',
        message: `Team in-flight concurrency limit reached (${ledger.inFlightAttemptIds.length}/${cfg.maxInFlight})`,
      };
    }
    if (cfg.maxTeamAttempts && ledger.attemptsReserved >= cfg.maxTeamAttempts) {
      return {
        blocked: true,
        code: 'BUDGET_EXCEEDED_ATTEMPTS',
        message: `Team hard attempt budget exhausted (${ledger.attemptsReserved}/${cfg.maxTeamAttempts})`,
      };
    }
    return { blocked: false };
  }

  reserveAttempt(teamId, attemptId) {
    if (!teamId) return { reserved: false, reason: 'no_team' };
    const outcome = this.store.transaction(() => {
      const ledger = this.store.budgetLedger(teamId);
      if (!ledger) return { reservation: { reserved: false, enforced: false } };
      const cfg = ledger.config ?? {};
      const hasAnyLimit = Boolean(cfg.maxTeamAttempts || cfg.maxInFlight || cfg.maxTaskDurationMs || cfg.maxTeamTokensSoft || cfg.sameErrorBreakerThreshold);
      if (!hasAnyLimit) return { reservation: { reserved: false, enforced: false } };

      if (ledger.frozenReason) {
        return {
          blockedError: Object.assign(new Error(`Team dispatch blocked by budget guard: ${ledger.frozenReason}`), {
            code: 'BUDGET_FROZEN',
            budgetReason: ledger.frozenReason,
          }),
        };
      }
      if (ledger.inFlightAttemptIds.includes(attemptId)) {
        return { reservation: { reserved: true, idempotent: true, ledger } };
      }
      if (cfg.maxInFlight && ledger.inFlightAttemptIds.length >= cfg.maxInFlight) {
        return {
          blockedError: Object.assign(
            new Error(`Team in-flight concurrency limit reached (${ledger.inFlightAttemptIds.length}/${cfg.maxInFlight})`),
            { code: 'BUDGET_EXCEEDED_CONCURRENCY' },
          ),
        };
      }
      if (cfg.maxTeamAttempts && ledger.attemptsReserved >= cfg.maxTeamAttempts) {
        ledger.frozenReason = 'budget_exceeded:attempts';
        ledger.updatedAt = now();
        this.store.saveBudgetLedger(ledger);
        return {
          blockedError: Object.assign(
            new Error(`Team hard attempt budget exhausted (${ledger.attemptsReserved}/${cfg.maxTeamAttempts})`),
            { code: 'BUDGET_EXCEEDED_ATTEMPTS' },
          ),
        };
      }

      ledger.attemptsReserved += 1;
      ledger.inFlightAttemptIds.push(attemptId);
      ledger.updatedAt = now();
      this.store.saveBudgetLedger(ledger);
      return {
        reservation: {
          reserved: true,
          enforced: true,
          attemptsReserved: ledger.attemptsReserved,
          inFlightCount: ledger.inFlightAttemptIds.length,
          maxTaskDurationMs: cfg.maxTaskDurationMs ?? null,
        },
      };
    });
    if (outcome?.blockedError) throw outcome.blockedError;
    return outcome.reservation;
  }

  releaseAttempt(teamId, attemptId) {
    if (!teamId || !attemptId) return null;
    return this.store.transaction(() => {
      const ledger = this.store.budgetLedger(teamId);
      if (!ledger) return null;
      const idx = ledger.inFlightAttemptIds.indexOf(attemptId);
      if (idx === -1) return ledger;
      ledger.inFlightAttemptIds.splice(idx, 1);
      ledger.attemptsUsed += 1;
      ledger.updatedAt = now();
      this.store.saveBudgetLedger(ledger);
      return ledger;
    });
  }

  /**
   * 幂等录入某个 attempt/thread 的最新累计用量快照（只增不减、不重复叠加）。
   */
  recordUsageSnapshot(teamId, attemptId, threadId, usage) {
    if (!teamId || !attemptId || !usage) return null;
    const total = extractTotalTokens(usage);
    if (total <= 0) return null;
    const key = `${attemptId}:${threadId || 'default'}`;
    return this.store.transaction(() => {
      const ledger = this.store.budgetLedger(teamId) ?? this._defaultLedger(teamId);
      const prev = Number(ledger.usageByAttemptThread[key] ?? 0);
      // Monotonic guard against out-of-order / stale late snapshots or replay duplicates
      if (total <= prev) {
        return {
          ledger,
          totalTokens: ledger.totalTokens,
          softLimitExceeded: ledger.softLimitExceeded,
          dedupedOrStale: true,
        };
      }
      ledger.usageByAttemptThread[key] = total;
      ledger.totalTokens = Object.values(ledger.usageByAttemptThread).reduce((sum, n) => sum + Number(n || 0), 0);

      const softLimit = ledger.config?.maxTeamTokensSoft ?? null;
      let justBreached = false;
      if (softLimit && ledger.totalTokens > softLimit && !ledger.softLimitExceeded) {
        ledger.softLimitExceeded = true;
        ledger.frozenReason = 'budget_exceeded:tokens_soft_limit';
        ledger.inFlightExposureAtBreach = ledger.inFlightAttemptIds.length;
        justBreached = true;
      }
      ledger.updatedAt = now();
      this.store.saveBudgetLedger(ledger);
      return {
        ledger,
        totalTokens: ledger.totalTokens,
        softLimitExceeded: ledger.softLimitExceeded,
        justBreached,
        inFlightExposureCount: ledger.inFlightAttemptIds.length,
      };
    });
  }

  recordTaskFailure(teamId, taskId, errorText) {
    if (!teamId || !taskId) return { tripBreaker: false };
    const fp = computeErrorFingerprint(errorText);
    return this.store.transaction(() => {
      const ledger = this.store.budgetLedger(teamId);
      if (!ledger) return { tripBreaker: false, fingerprint: fp };
      const threshold = ledger.config?.sameErrorBreakerThreshold ?? null;
      const prev = ledger.errorStreaks[taskId];
      const count = prev?.fingerprint === fp ? prev.count + 1 : 1;
      ledger.errorStreaks[taskId] = { fingerprint: fp, count, at: now() };
      ledger.updatedAt = now();
      this.store.saveBudgetLedger(ledger);
      return {
        tripBreaker: Boolean(threshold && count >= threshold),
        fingerprint: fp,
        consecutiveCount: count,
        threshold,
      };
    });
  }

  clearTaskErrorStreak(teamId, taskId) {
    if (!teamId || !taskId) return;
    this.store.transaction(() => {
      const ledger = this.store.budgetLedger(teamId);
      if (!ledger || !ledger.errorStreaks[taskId]) return;
      delete ledger.errorStreaks[taskId];
      ledger.updatedAt = now();
      this.store.saveBudgetLedger(ledger);
    });
  }
}
