// Guidance describes existing controls; reading it never resumes or releases work.
export function recoveryGuidance(task) {
  if (task.executionUnresolved === true) {
    const identified = Boolean(task.threadId);
    const isTerminalStopped =
      task.completionStatus === 'interrupted' ||
      (task.attemptId && task.recoveryTerminal?.attemptId === task.attemptId) ||
      (task.attemptId && task.recovery?.attemptId === task.attemptId && task.recovery?.exhausted === true);
    const manualRelease = isTerminalStopped
      ? (task.state === 'abandoned'
          ? {
              tool: 'engine_control',
              action: 'resolve_unresolved',
              requiresRevisionPin: true,
              stopCertified: false,
              requiredFields: ['taskId', 'action', 'expectedRevision', 'reason', 'evidence'],
              optionalFields: ['expectedAttemptId'],
              guidance: '确认宿主进程已停止后，刷新最新 expectedRevision 与可选 expectedAttemptId，提交 reason 与 evidence 调用 resolve_unresolved 释放占槽（仍保留 stopCertified=false 审计边界）。',
            }
          : {
              prerequisiteAction: 'abandon',
              tool: 'engine_control',
              action: 'resolve_unresolved',
              requiresRevisionPin: true,
              stopCertified: false,
              guidance: '自动对账已确认中断或达到轮询上限；如需人工释放占槽，请先携带 expectedRevision 执行 abandon，刷新 revision 后再调用 resolve_unresolved（不代表停止证明）。',
            })
      : null;
    return {
      kind: identified ? 'execution-known-identity' : 'execution-missing-identity',
      summary: identified ? '原执行尚未确认，按保存的聊天身份核对。' : '缺少原执行聊天身份，当前无法自动对账。',
      next: identified ? { tool: 'engine_control', arguments: { taskId: task.id, action: 'reconcile' } } : null,
      instruction: identified ? '核对原执行终态后再决定是否重试；对账不会创建新尝试。' : '检查原聊天和本地执行日志以寻找原身份；未确认旧执行前保留占槽，不另建替代任务。',
      limitation: '放弃仅结束业务跟进，不证明进程停止，也不释放未知执行占用的槽位。',
      ...(manualRelease ? { manualRelease } : {}),
    };
  }
  if (task.state === 'blocked' && (task.blockReason === 'preflight' || task.error && !task.blockReason)) return {
    kind: 'preflight', summary: '派发前检查未通过，任务尚不能开工。', next: null,
    instruction: task.budgetDetails ? '按字节账单拆分任务；保留全部必传约束，不以裁掉关键内容绕过上限。' : '读取当前错误并修正输入或依赖；确认尚未派发后再使用现有重试入口。',
  };
  return null;
}

export function recoveryDiagnostics(tasks, bindings) {
  const groups = [
    ['execution-known-identity', tasks.filter(t => t.executionUnresolved === true && t.threadId)],
    ['execution-missing-identity', tasks.filter(t => t.executionUnresolved === true && !t.threadId)],
    ['notification-unknown', bindings.filter(b => ['unknown', 'needs-attention'].includes(b.blockingDelivery?.status))],
  ];
  return groups.filter(([, items]) => items.length).map(([kind, items]) => {
    const item = items[0];
    // Engine IDs are bounded references. Never attach transcripts or command lines.
    const reference = value => typeof value === 'string' && value.length <= 180 ? value : null;
    return { kind, count: items.length, example: kind === 'notification-unknown'
      ? { bindingId: reference(item.id), batchId: reference(item.blockingDelivery.batchId) }
      : { taskId: reference(item.id) } };
  });
}
