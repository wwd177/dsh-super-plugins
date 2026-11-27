import { fetchDelivery } from './delivery-download.js';

function resolveDefaultApiBase() {
  if (typeof location === 'undefined') return '';
  if (location.pathname.startsWith('/superagent-engine')) return '/superagent-engine';
  return '';
}

function detectHostDarkTheme() {
  if (typeof document === 'undefined') return null;
  const docEl = document.documentElement;
  const bodyEl = document.body;
  for (const el of [docEl, bodyEl]) {
    if (!el) continue;
    const dt = (el.getAttribute('data-theme') || el.getAttribute('data-color-mode') || el.getAttribute('data-dsh-theme') || '').toLowerCase();
    if (dt.includes('dark')) return true;
    if (dt.includes('light')) return false;
    if (el.classList?.contains('dark') || el.classList?.contains('theme-dark')) return true;
    if (el.classList?.contains('light') || el.classList?.contains('theme-light')) return false;
  }
  try {
    const bg = getComputedStyle(docEl).getPropertyValue('--dsw-alias-bg-base').trim() || getComputedStyle(bodyEl || docEl).backgroundColor;
    const rgb = bg.match(/\d+/g)?.map(Number);
    if (rgb && rgb.length >= 3 && !(rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0 && rgb[3] === 0)) {
      const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
      return lum < 0.45;
    }
  } catch {}
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : false;
}

const TEAM_TEMPLATES = {
  delivery: {
    name: '研发交付团队',
    members: [
      { name: '架构与接口设计', role: '架构师', difficulty: 'high', responsibility: '梳理需求边界、数据契约与模块拆分，输出清晰的设计说明与接口约定，供实现与测试对齐。' },
      { name: '核心功能实现', role: '实现工程师', difficulty: 'high', responsibility: '按设计契约完成核心代码实现，保持写入范围聚焦，附带自测说明与变更文件清单。' },
      { name: '质量与验收测试', role: '测试验收员', difficulty: 'medium', responsibility: '针对验收标准编写或执行自动化测试与边界用例，输出客观通过/失败证据与风险提示。' },
    ],
  },
  fullstack: {
    name: '全栈并行团队',
    members: [
      { name: '后端服务与数据层', role: '后端工程师', difficulty: 'high', responsibility: '实现后端 API、校验与持久化逻辑，输出接口契约与单元测试结果。' },
      { name: '前端交互与界面', role: '前端工程师', difficulty: 'high', responsibility: '完成前端页面布局、状态管理与深浅色/响应式适配，避免与后端目录写入冲突。' },
      { name: '端到端联调与验证', role: '联调验证员', difficulty: 'medium', responsibility: '打通前后端关键链路，验证异常场景与性能表现，输出验收清单。' },
    ],
  },
  debug: {
    name: '根因排查与修复团队',
    members: [
      { name: '现象复现与根因定位', role: '诊断分析员', difficulty: 'medium', responsibility: '梳理日志、复现路径与最小触发条件，输出带证据链的根因定位报告。' },
      { name: '最小变更修复', role: '修复工程师', difficulty: 'high', responsibility: '基于根因实施最小、可回滚的代码修复，避免引入无关改动。' },
      { name: '回归测试与防护', role: '回归验证员', difficulty: 'medium', responsibility: '补充防回归单元测试，验证原缺陷消失且现有套件全部通过。' },
    ],
  },
  research: {
    name: '调研与方案评审团队',
    members: [
      { name: '资料与现状调研', role: '调研员', difficulty: 'medium', responsibility: '收集对比竞品/开源方案与现有系统约束，输出带引用出处的结构化事实清单。' },
      { name: '技术方案设计', role: '方案设计师', difficulty: 'high', responsibility: '基于事实清单提出 2–3 套备选方案及推荐方案，明确投入产出与迁移路径。' },
      { name: '风险与可行性审查', role: '评审专家', difficulty: 'high', responsibility: '从稳定性、安全性与用户体验角度挑刺，列出阻断风险与缓解措施。' },
    ],
  },
};

export async function mountSuperAgentWorkbench(root = document, options = {}) {
  const isShadow = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot;
  const $ = id => root.getElementById(id);
  const shellEl = $('sa-shell') || (isShadow ? root.host : document.documentElement);
  const apiBase = (options.apiBase ?? resolveDefaultApiBase()).replace(/\/+$/, '');
  const isCustomScheme = typeof location !== 'undefined' && !/^https?:$/i.test(location.protocol);
  let activeSessionId = options.sessionId || (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('session') : null) || null;
  let token = options.token ?? root.querySelector?.('meta[name="engine-token"]')?.content ?? document.querySelector?.('meta[name="engine-token"]')?.content ?? '';
  if (token === '__ENGINE_TOKEN__' || token === 'dsh-fenced') token = '';

  const states = {
    queued: '排队', blocked: '等待依赖', dispatching: '派发待确认', running: '执行中',
    pausing: '正在暂停', paused: '已暂停', 'paused-unconfirmed': '暂停待核对',
    cancelling: '正在取消', cancelled: '已取消', 'cancelled-unconfirmed': '取消待核对',
    unknown: '结果未知', submitted: '已提交待验', checked: '机械检查通过',
    accepted: '已验收', failed: '失败', abandoned: '已放弃业务跟进',
  };
  const LEGACY = '__standalone__';
  let disposed = false;
  let selectedTeam = options.teamId || (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('team') : '') || '';
  let selectedMember = null, selectedTask = null, view = 'task', currentTeam = null, currentTasks = [], currentSources = [], allTeams = [];
  let refreshSequence = 0, detailSequence = 0, scopeSequence = 0, sourceSequence = 0, sourcePage = null;
  let lastShell = '', lastTask = '', lastSources = '', latestTaskRequest = null, createRequest = null;
  const locks = new Set(), evidence = new Map(), sourceDrafts = new Map(), disclosureState = new Map();
  const acceptanceDrafts = new Map(), abandonmentDrafts = new Map(), reworkDrafts = new Map();
  const memberDifficulties = new Map(), liveActivities = new Map(), taskFilesCache = new Map();
  const emptyOverview = $('overview').innerHTML;
  let attentionPage = null, pendingApprovals = [], lastApprovals = '', auditMode = false;
  let refreshFlight = null, refreshAgain = false, refreshTimer = null, tokenFlight = null, reconnectAttempt = 0, connectionProblem = '';
  let streamAbort = null, streamConnected = false, streamRetryTimer = null, sseDebounce = null;
  let changePollTimer = null, lastChangeSeq = 0;
  const selectedCandidateByTeam = new Map(), selectedApprovalByTeam = new Map(), knownCandidateCountByTeam = new Map(), prReconcileByTeam = new Map(), v19Drafts = new Map(), repoProbeByTeam = new Map();
  let lastSecurityPosture = null, lastRefusals = null, pendingCreateBudget = null;
  const v19Draft = teamId => { if (!v19Drafts.has(teamId)) v19Drafts.set(teamId, {}); return v19Drafts.get(teamId); };
  const v19FmtErr = err => (err ? ((err.code ? `[${err.code}] ` : '') + (err.message || String(err))) : '未知错误');
  const v19SplitGoalLines = goal => {
    const parts = String(goal || '').split(/[。！？\r\n]+/).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts.join('\n') : '完成目标验收条文';
  };
  const v19ParseCriteriaLines = (text, tasks = []) => {
    const list = Array.isArray(tasks) ? tasks : [];
    const preferred = list.filter(t => ['accepted', 'checked', 'submitted', 'running', 'queued'].includes(t.state));
    const pool = preferred.length ? preferred : list;
    return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((line, idx) => {
      const m = /^\[(?:signoff|人工签认|人工)\]\s*(.+)$/i.exec(line);
      if (m) return { id: `c-${idx + 1}`, requirementText: m[1].trim(), mandatory: true, verificationMode: 'human_signoff', signoffRole: 'maintainer' };
      const tm = /^\[task:([^\]]+)\]\s*(.+)$/i.exec(line);
      if (tm) return { id: `c-${idx + 1}`, requirementText: tm[2].trim(), mandatory: true, verificationMode: 'check', taskId: tm[1].trim() };
      if (pool.length) {
        const byText = pool.find(t => (t.title && line.includes(t.title)) || (t.goal && t.goal.includes(line)));
        const bound = byText || pool[idx % pool.length];
        return { id: `c-${idx + 1}`, requirementText: line, mandatory: true, verificationMode: 'check', taskId: bound.id };
      }
      return { id: `c-${idx + 1}`, requirementText: line, mandatory: true, verificationMode: 'human_signoff', signoffRole: 'maintainer' };
    });
  };
  const v19SetCardStatus = (box, msg, isError = false) => {
    if (!box) return;
    box.textContent = msg || '';
    box.className = isError ? 'error' : 'hint';
    box.hidden = !msg;
  };
  async function v19ApplyPendingBudget(team) {
    if (!pendingCreateBudget || !team || team.name !== pendingCreateBudget.teamName) return;
    const payload = pendingCreateBudget.budget;
    pendingCreateBudget = null;
    try {
      await api('/teams/' + encodeURIComponent(team.id) + '/budget', 'POST', payload);
      await refresh(true);
    } catch (err) { notice('创建后写入预算失败：' + v19FmtErr(err)); }
  }
  function v19BuildGovernanceCard(team) {
    const wrap = node('section', undefined, 'v19-card v19-gov-card');
    wrap.dataset.v19Panel = 'governance'; wrap.dataset.v19Team = team.id;
    wrap.append(node('h3', '运行预算、环境配方与安全态势（v0.19）'));
    const statusEl = node('p', '', 'hint'); statusEl.dataset.v19Status = 'governance'; statusEl.hidden = true;
    const draft = v19Draft(team.id);
    const b = team.budget || {}; const cfg = b.config || {};
    const usedTokens = Number(b.totalTokens || 0);
    const softLimit = cfg.maxTeamTokensSoft ? Number(cfg.maxTeamTokensSoft) : null;
    const pct = softLimit ? Math.min(100, Math.round((usedTokens / softLimit) * 100)) : 0;
    const budgetRow = node('div', undefined, 'v19-subpanel');
    budgetRow.style.borderTop = 'none'; budgetRow.style.paddingTop = '0'; budgetRow.style.marginTop = '0';
    const summaryParts = [
      `Tokens ${usedTokens.toLocaleString()}${softLimit ? ` / ${softLimit.toLocaleString()} (软上限 ${pct}%)` : ' (未设软上限)'}`,
      `尝试次数 ${Number(b.attemptsUsed || 0)}${cfg.maxTeamAttempts ? ` / ${cfg.maxTeamAttempts}` : ''}`,
      ...(cfg.maxTaskDurationMs ? [`单任务上限 ${Math.round(cfg.maxTaskDurationMs / 1000)}s`] : []),
    ];
    budgetRow.append(node('p', summaryParts.join(' · '), 'meta'));
    if (softLimit) {
      const bar = node('div', undefined, 'v19-progress');
      const fill = node('div', undefined, 'v19-progress-fill' + (b.softLimitExceeded ? ' danger' : (pct >= 80 ? ' warn' : '')));
      fill.style.width = pct + '%'; bar.append(fill); budgetRow.append(bar);
    }
    if (b.softLimitExceeded || b.frozenReason) {
      const pills = node('div', undefined, 'v19-pills');
      if (b.softLimitExceeded) pills.append(node('span', `已触及 Token 软上限（在途暴露 ${Number(b.inFlightExposureAtBreach || 0)} 项）`, 'v19-pill warn'));
      if (b.frozenReason) pills.append(node('span', `预算熔断原因：${b.frozenReason}`, 'v19-pill error'));
      budgetRow.append(pills);
    }
    const bGrid = node('div', undefined, 'v19-grid');
    const fTok = node('label', undefined, 'v19-field'); fTok.append(node('span', 'Token 软上限'));
    const inTok = document.createElement('input'); inTok.type = 'number'; inTok.min = '1000'; inTok.step = '1000'; inTok.dataset.v19BudgetTokens = '1';
    inTok.value = draft.budgetTokens ?? (cfg.maxTeamTokensSoft ?? ''); inTok.placeholder = '例如 200000';
    inTok.addEventListener('input', () => { draft.budgetTokens = inTok.value; }); fTok.append(inTok);
    const fDur = node('label', undefined, 'v19-field'); fDur.append(node('span', '单任务耗时上限（秒）'));
    const inDur = document.createElement('input'); inDur.type = 'number'; inDur.min = '5'; inDur.step = '5'; inDur.dataset.v19BudgetDuration = '1';
    inDur.value = draft.budgetDuration ?? (cfg.maxTaskDurationMs ? String(Math.round(cfg.maxTaskDurationMs / 1000)) : ''); inDur.placeholder = '例如 1800';
    inDur.addEventListener('input', () => { draft.budgetDuration = inDur.value; }); fDur.append(inDur);
    const fAtt = node('label', undefined, 'v19-field'); fAtt.append(node('span', '最大总尝试次数'));
    const inAtt = document.createElement('input'); inAtt.type = 'number'; inAtt.min = '1'; inAtt.step = '1'; inAtt.dataset.v19BudgetAttempts = '1';
    inAtt.value = draft.budgetAttempts ?? (cfg.maxTeamAttempts ?? ''); inAtt.placeholder = '例如 24';
    inAtt.addEventListener('input', () => { draft.budgetAttempts = inAtt.value; }); fAtt.append(inAtt);
    bGrid.append(fTok, fDur, fAtt); budgetRow.append(bGrid);
    const bAct = node('div', undefined, 'actions');
    const saveBudgetBtn = button('保存预算设置', async () => {
      try {
        const body = {};
        const tVal = Number(inTok.value); body.maxTeamTokensSoft = inTok.value && Number.isInteger(tVal) && tVal >= 1 ? tVal : null;
        const dVal = Number(inDur.value); body.maxTaskDurationMs = inDur.value && Number.isFinite(dVal) && dVal >= 1 ? Math.round(dVal * 1000) : null;
        const aVal = Number(inAtt.value); body.maxTeamAttempts = inAtt.value && Number.isInteger(aVal) && aVal >= 1 ? aVal : null;
        await api('/teams/' + encodeURIComponent(team.id) + '/budget', 'POST', body);
        v19SetCardStatus(statusEl, '已更新团队运行预算限制。');
        notice('已保存运行预算限制。');
        await refresh(true);
      } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
    }, 'budget:' + team.id);
    saveBudgetBtn.dataset.action = 'save-budget'; bAct.append(saveBudgetBtn); budgetRow.append(bAct);
    wrap.append(budgetRow);

    const envSub = node('div', undefined, 'v19-subpanel');
    const recipes = Array.isArray(team.envRecipes) ? team.envRecipes : [];
    envSub.append(node('p', recipes.length ? `已批准环境配方：${recipes.length} 份（最近哈希 ${recipes.at(-1).recipeHash.slice(0, 12)}）` : '尚未批准仓库测试环境配方（探测只列候选命令，绝不暗选）。', 'meta'));
    const probeData = repoProbeByTeam.get(team.id);
    if (probeData) {
      const cmds = Array.isArray(probeData.candidateCommands) ? probeData.candidateCommands : [];
      envSub.append(node('p', `探测生态：${(probeData.ecosystems || []).join(', ') || '未识别'} · 锁文件：${(probeData.lockfiles || []).map(l => l.file).join(', ') || '无'} · 候选命令 ${cmds.length} 条`, 'hint'));
      if (cmds.length) {
        const approveEnvBtn = button('批准探测首条命令为环境配方', async () => {
          try {
            const first = cmds[0];
            const rec = await api('/teams/' + encodeURIComponent(team.id) + '/env-recipes', 'POST', { repoPath: team.repoPath, selectedCommands: [`${first.command} ${(first.args || []).join(' ')}`.trim()], approvedBy: 'dashboard:maintainer' });
            v19SetCardStatus(statusEl, `已批准环境配方 ${rec.recipeHash.slice(0, 12)}。`);
            notice(`已批准环境配方 ${rec.recipeHash.slice(0, 12)}。`);
            await refresh(true);
          } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
        }, 'env:' + team.id);
        approveEnvBtn.dataset.action = 'approve-env-recipe'; envSub.append(approveEnvBtn);
      }
    }
    const secRow = node('div', undefined, 'actions');
    if (team.repoPath) {
      const probeTeamBtn = button('探测仓库测试命令', async () => {
        try {
          const res = await api('/repo/probe', 'POST', { repoPath: team.repoPath });
          repoProbeByTeam.set(team.id, res);
          v19SetCardStatus(statusEl, `探测完成：发现 ${(res.candidateCommands || []).length} 条候选命令（需人工确认，autoSelected=${res.autoSelected}）。`);
          await refresh(true);
        } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
      }, 'probe:' + team.id, 'quiet');
      probeTeamBtn.dataset.action = 'probe-team-repo'; secRow.append(probeTeamBtn);
    }
    const postureBox = node('div', undefined, 'v19-list'); postureBox.dataset.v19PostureBox = '1';
    const renderPostureContent = (p, ref) => {
      postureBox.replaceChildren();
      if (p) {
        const tools = (p.toolchains || []).map(t => `${t.command}:${t.status}`).join(' · ');
        postureBox.append(node('div', `隔离边界：${p.isolationLevel} | 工具链：${tools}`, 'v19-item'));
        if (p.boundaryDisclosure) postureBox.append(node('p', p.boundaryDisclosure, 'hint'));
      }
      const rList = ref?.refusals || [];
      if (rList.length) postureBox.append(node('div', `最近系统拒绝记录（${rList.length} 条）：` + rList.slice(0, 3).map(r => r.reason || r.code || r.action).join('；'), 'v19-item'));
    };
    if (lastSecurityPosture) renderPostureContent(lastSecurityPosture, lastRefusals);
    const postureBtn = button('刷新安全态势与拒绝日志', async () => {
      try {
        const [p, ref] = await Promise.all([api('/security/posture'), api('/refusals?limit=10')]);
        lastSecurityPosture = p; lastRefusals = ref;
        renderPostureContent(p, ref);
        v19SetCardStatus(statusEl, `安全态势已更新：${p.isolationLevel}。`);
      } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
    }, 'posture:' + team.id, 'quiet');
    postureBtn.dataset.action = 'refresh-posture'; secRow.append(postureBtn);
    envSub.append(secRow, postureBox); wrap.append(envSub, statusEl);
    return wrap;
  }
  function v19MountOverviewPanels(team, tasks) {
    const ov = $('overview');
    if (!ov || !team || selectedTeam !== team.id) return;
    const oldGov = ov.querySelector('[data-v19-panel="governance"]'); if (oldGov) oldGov.remove();
    const oldDel = ov.querySelector('[data-v19-panel="delivery"]'); if (oldDel) oldDel.remove();
    ov.append(v19BuildGovernanceCard(team));
    if (team.workspaceMode !== 'git-worktree') return;
    const mergeInput = ov.querySelector('input[data-merge-branch]');
    const card = node('section', undefined, 'v19-card v19-delivery-card');
    card.dataset.v19Panel = 'delivery'; card.dataset.v19Team = team.id;
    card.append(node('h3', '冻结候选交付、目标门禁签认与只读 PR 对账（v0.19）'));
    const statusEl = node('p', '', 'hint'); statusEl.dataset.v19Status = 'delivery'; statusEl.hidden = true;
    const draft = v19Draft(team.id);
    const cands = Array.isArray(team.candidates) ? team.candidates : [];
    const prevCandCount = knownCandidateCountByTeam.get(team.id);
    let selCandId = selectedCandidateByTeam.get(team.id);
    if (!cands.some(c => c.id === selCandId) || (prevCandCount !== undefined && cands.length > prevCandCount)) {
      selCandId = cands.at(-1)?.id || '';
      if (selCandId) selectedCandidateByTeam.set(team.id, selCandId); else selectedCandidateByTeam.delete(team.id);
      selectedApprovalByTeam.delete(team.id);
    }
    knownCandidateCountByTeam.set(team.id, cands.length);
    const cand = cands.find(c => c.id === selCandId) || null;

    const critSec = node('div', undefined, 'v19-subpanel'); critSec.style.borderTop = 'none'; critSec.style.marginTop = '0'; critSec.style.paddingTop = '0';
    critSec.append(node('h4', '1. 目标原话门禁冻结与具名人工签认'));
    const gc = team.goalCriteria || null;
    if (gc) {
      critSec.append(node('p', `已冻结门禁 rev.${gc.revision}（gateHash ${String(gc.gateHash || '').slice(0, 10)}）· 未映射片段：${(gc.unmappedSegments || []).length}`, 'meta'));
      if ((gc.unmappedSegments || []).length) critSec.append(node('p', '未覆盖原话片段：' + gc.unmappedSegments.map(s => s.text).join('；'), 'error'));
    }
    const critLinesLabel = node('label', undefined, 'v19-field'); critLinesLabel.append(node('span', '验收条文（每行一条；以 [signoff] 开头可设为人签必达条文）'));
    const critArea = document.createElement('textarea'); critArea.rows = 3; critArea.dataset.v19CriteriaLines = '1';
    critArea.value = draft.criteriaLines ?? (gc?.criteria?.length ? gc.criteria.map(c => (c.verificationMode === 'human_signoff' ? '[signoff] ' : '') + c.requirementText).join('\n') : v19SplitGoalLines(team.goal));
    critArea.addEventListener('input', () => { draft.criteriaLines = critArea.value; }); critLinesLabel.append(critArea);
    const signerLabel = node('label', undefined, 'v19-field'); signerLabel.append(node('span', '维护者 / 签认人署名'));
    const signerInput = document.createElement('input'); signerInput.type = 'text'; signerInput.dataset.v19Signer = '1';
    signerInput.value = draft.signer ?? 'maintainer-alice'; signerInput.addEventListener('input', () => { draft.signer = signerInput.value; }); signerLabel.append(signerInput);
    const critBtn = button('冻结目标需求', async () => {
      try {
        const criteria = v19ParseCriteriaLines(critArea.value, tasks);
        const res = await api('/teams/' + encodeURIComponent(team.id) + '/criteria/freeze', 'POST', { confirmedBy: signerInput.value.trim() || 'maintainer-ui', criteria });
        v19SetCardStatus(statusEl, `已冻结目标需求 rev.${res.revision}（含 ${res.criteria.length} 条目，未映射 ${(res.unmappedSegments || []).length} 项）。`);
        notice(`已冻结目标需求 rev.${res.revision}。`);
        await refresh(true);
      } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
    }, 'criteria-freeze:' + team.id);
    critBtn.dataset.action = 'criteria-freeze';
    const critAct = node('div', undefined, 'actions'); critAct.append(critBtn);
    critSec.append(critLinesLabel, signerLabel, critAct);
    if (gc?.criteria?.length) {
      const sGrid = node('div', undefined, 'v19-grid');
      const cSelWrap = node('label', undefined, 'v19-field'); cSelWrap.append(node('span', '选择条文签认'));
      const cSel = document.createElement('select'); cSel.dataset.v19SignoffCriterion = '1';
      for (const item of gc.criteria) {
        const o = document.createElement('option'); o.value = item.id; o.textContent = `[${item.verificationMode}] ${item.requirementText}`;
        cSel.append(o);
      }
      const prefSignoff = gc.criteria.find(c => c.verificationMode === 'human_signoff');
      if (draft.signoffCriterionId && gc.criteria.some(c => c.id === draft.signoffCriterionId)) cSel.value = draft.signoffCriterionId;
      else if (prefSignoff) cSel.value = prefSignoff.id;
      cSel.addEventListener('change', () => { draft.signoffCriterionId = cSel.value; }); cSelWrap.append(cSel);
      const nWrap = node('label', undefined, 'v19-field'); nWrap.append(node('span', '签认备注'));
      const nIn = document.createElement('input'); nIn.type = 'text'; nIn.dataset.v19SignoffNote = '1'; nIn.value = draft.signoffNote ?? 'Verified manually';
      nIn.addEventListener('input', () => { draft.signoffNote = nIn.value; }); nWrap.append(nIn);
      sGrid.append(cSelWrap, nWrap);
      const signBtn = button('签署人工验收签认', async () => {
        try {
          await api('/teams/' + encodeURIComponent(team.id) + '/criteria/signoff', 'POST', {
            criterionId: cSel.value, ...(cand ? { candidateId: cand.id } : {}),
            signer: signerInput.value.trim() || 'maintainer-ui', note: nIn.value.trim() || 'Manual signoff',
          });
          v19SetCardStatus(statusEl, `已记录条文 ${cSel.value} 的具名人工签认。`);
          notice('已记录具名人工验收签认。');
          await refresh(true);
        } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
      }, 'criteria-signoff:' + team.id);
      signBtn.dataset.action = 'criteria-signoff';
      const sAct = node('div', undefined, 'actions'); sAct.append(signBtn);
      critSec.append(sGrid, sAct);
    }
    card.append(critSec);

    const candSec = node('div', undefined, 'v19-subpanel');
    candSec.append(node('h4', '2. 冻结候选切换与绑定批准（切换候选自动清空旧批准）'));
    if (!cands.length) {
      candSec.append(node('p', '尚无冻结候选。请至少验收 1 个任务后点击上方“生成冻结候选”。', 'hint'));
    } else {
      const cSelWrap = node('label', undefined, 'v19-field'); cSelWrap.append(node('span', `选择冻结候选（共 ${cands.length} 个）`));
      const candSel = document.createElement('select'); candSel.dataset.v19CandidateSelect = '1'; candSel.dataset.action = 'select-candidate';
      cands.forEach((item, idx) => {
        const o = document.createElement('option'); o.value = item.id;
        o.textContent = `C${idx + 1} · ${item.id} · ${item.status}${item.assemblyMode ? ` (${item.assemblyMode})` : ''}`;
        candSel.append(o);
      });
      candSel.value = selCandId;
      candSel.addEventListener('change', () => {
        selectedCandidateByTeam.set(team.id, candSel.value);
        selectedApprovalByTeam.delete(team.id);
        v19MountOverviewPanels(team, tasks);
      });
      cSelWrap.append(candSel); candSec.append(cSelWrap);
      if (cand) {
        const pills = node('div', undefined, 'v19-pills');
        const isFailed = cand.status === 'verification_failed';
        pills.append(node('span', isFailed ? '集成检查未通过 · 禁止批准发布' : `候选状态：${cand.status}`, 'v19-pill ' + (isFailed ? 'error' : 'good')));
        const ev = cand.liveGoalEvaluation || cand.goalEvaluation;
        if (ev) pills.append(node('span', ev.goalPassed ? '目标门禁：通过' : '目标门禁：未全部通过', 'v19-pill ' + (ev.goalPassed ? 'good' : 'warn')));
        candSec.append(pills);
        if (cand.commitOid) candSec.append(node('p', `Commit OID: ${cand.commitOid}`, 'meta'));

        const revGrid = node('div', undefined, 'v19-grid');
        const revGoalWrap = node('label', undefined, 'v19-field'); revGoalWrap.append(node('span', '修订任务说明'));
        const revGoalIn = document.createElement('input'); revGoalIn.type = 'text'; revGoalIn.dataset.v19ReviseGoal = '1';
        revGoalIn.value = draft.reviseGoal ?? ''; revGoalIn.placeholder = `基于 ${cand.id} 发起兼容修订`;
        revGoalIn.addEventListener('input', () => { draft.reviseGoal = revGoalIn.value; }); revGoalWrap.append(revGoalIn);
        const revMemWrap = node('label', undefined, 'v19-field'); revMemWrap.append(node('span', '指派修订成员'));
        const revMemSel = document.createElement('select'); revMemSel.dataset.v19ReviseMember = '1';
        for (const m of team.members || []) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name} (${m.role})`; revMemSel.append(o); }
        if (draft.reviseMemberId) revMemSel.value = draft.reviseMemberId;
        revMemSel.addEventListener('change', () => { draft.reviseMemberId = revMemSel.value; }); revMemWrap.append(revMemSel);
        revGrid.append(revGoalWrap, revMemWrap);
        const revBtn = button('基于当前候选发起集成修订', async () => {
          try {
            const goal = revGoalIn.value.trim() || `基于冻结候选 ${cand.id} 执行集成修订`;
            const t = await api('/tasks', 'POST', {
              requestId: 'ui-rev-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6),
              teamId: team.id, memberId: revMemSel.value || team.members?.[0]?.id,
              title: '集成修订 · ' + cand.id.slice(0, 8), goal, revisionOfCandidateId: cand.id,
            });
            v19SetCardStatus(statusEl, `已提交基于候选 ${cand.id} 的集成修订任务 ${t.id}。`);
            notice(`已提交集成修订任务 ${t.id}。`);
            await refresh(true);
          } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
        }, 'revise:' + team.id, 'quiet');
        revBtn.dataset.action = 'revise-candidate';

        const pubGrid = node('div', undefined, 'v19-grid');
        const brWrap = node('label', undefined, 'v19-field'); brWrap.append(node('span', '目标本地分支名（不含 superagent/ 前缀）'));
        const brIn = document.createElement('input'); brIn.type = 'text'; brIn.dataset.v19Branch = '1';
        brIn.value = draft.branchName ?? mergeInput?.value ?? ''; brIn.placeholder = '留空按默认分支名';
        brIn.addEventListener('input', () => { draft.branchName = brIn.value; if (mergeInput) mergeInput.value = brIn.value; }); brWrap.append(brIn);
        const allApps = Array.isArray(team.approvals) ? team.approvals : [];
        const validApps = allApps.filter(a => a.candidateId === cand.id && !a.revokedAt);
        let selAppId = selectedApprovalByTeam.get(team.id) || '';
        if (!validApps.some(a => a.id === selAppId)) { selAppId = ''; selectedApprovalByTeam.delete(team.id); }
        const appWrap = node('label', undefined, 'v19-field'); appWrap.append(node('span', `当前候选绑定批准（仅显示属于 ${cand.id} 的有效批准）`));
        const appSel = document.createElement('select'); appSel.dataset.v19ApprovalSelect = '1';
        const emptyOpt = document.createElement('option'); emptyOpt.value = ''; emptyOpt.textContent = validApps.length ? '选择一条有效批准…' : '无绑定批准（需点击“批准当前候选”）';
        appSel.append(emptyOpt);
        for (const a of validApps) {
          const o = document.createElement('option'); o.value = a.id;
          o.textContent = `${a.id.slice(0, 8)} · ${a.purpose} -> ${a.targetRef}`;
          appSel.append(o);
        }
        appSel.value = selAppId;
        appSel.addEventListener('change', () => { if (appSel.value) selectedApprovalByTeam.set(team.id, appSel.value); else selectedApprovalByTeam.delete(team.id); });
        appWrap.append(appSel); pubGrid.append(brWrap, appWrap);

        const appBtn = button('批准当前候选', async () => {
          try {
            const bName = (brIn.value || mergeInput?.value || '').trim();
            const app = await api('/teams/' + encodeURIComponent(team.id) + '/candidates/' + encodeURIComponent(cand.id) + '/approve', 'POST', {
              purpose: 'local_publish', ...(bName ? { branchName: bName } : {}), actor: 'dashboard:maintainer',
            });
            selectedApprovalByTeam.set(team.id, app.id);
            v19SetCardStatus(statusEl, `已为候选 ${cand.id} 记录绑定批准 ${app.id}。`);
            notice(`已批准候选 ${cand.id}（${app.id}）。`);
            await refresh(true);
          } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
        }, 'approve:' + team.id);
        appBtn.dataset.action = 'approve-candidate';

        const revokeBtn = button('撤销选定批准', async () => {
          try {
            const aid = appSel.value || selectedApprovalByTeam.get(team.id) || '';
            if (!aid) throw new Error('请先选择一条有效批准记录后再撤销');
            await api('/teams/' + encodeURIComponent(team.id) + '/approvals/' + encodeURIComponent(aid) + '/revoke', 'POST', { reason: 'ui-manual-revoke' });
            selectedApprovalByTeam.delete(team.id);
            v19SetCardStatus(statusEl, `已撤销批准 ${aid}。`);
            notice(`已撤销批准 ${aid}。`);
            await refresh(true);
          } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
        }, 'revoke:' + team.id, 'quiet');
        revokeBtn.dataset.action = 'revoke-approval';

        const pubBtn = button('使用选定批准发布本地分支', async () => {
          try {
            const aid = appSel.value || selectedApprovalByTeam.get(team.id) || '';
            if (!aid) throw new Error('当前候选尚无选定有效批准（切换候选后旧批准已自动清空），请先点击“批准当前候选”。');
            const bName = (brIn.value || mergeInput?.value || '').trim();
            const pub = await api('/teams/' + encodeURIComponent(team.id) + '/candidates/' + encodeURIComponent(cand.id) + '/publish-local', 'POST', {
              approvalId: aid, ...(bName ? { branchName: bName } : {}),
            });
            v19SetCardStatus(statusEl, pub.note || `已按批准 ${aid} 发布本地分支 ${pub.branch}。`);
            notice(pub.note || `已发布本地分支 ${pub.branch}。`);
            await refresh(true);
          } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
        }, 'pub-sel:' + team.id, 'primary-good');
        pubBtn.dataset.action = 'publish-with-approval';

        const cAct = node('div', undefined, 'actions'); cAct.append(revBtn, appBtn, revokeBtn, pubBtn);
        candSec.append(revGrid, pubGrid, cAct);
      }
    }
    card.append(candSec);

    const prSec = node('div', undefined, 'v19-subpanel');
    prSec.append(node('h4', '3. 只读 PR 对账（三层分离事实）与远端交付意图'));
    const prLinks = Array.isArray(team.prLinks) ? team.prLinks : [];
    const prGrid = node('div', undefined, 'v19-grid');
    const prRepoWrap = node('label', undefined, 'v19-field'); prRepoWrap.append(node('span', 'GitHub 仓库 (owner/repo)'));
    const prRepoIn = document.createElement('input'); prRepoIn.type = 'text'; prRepoIn.dataset.v19PrRepo = '1';
    prRepoIn.value = draft.prRepo ?? prLinks.at(-1)?.repo ?? ''; prRepoIn.placeholder = 'owner/repo';
    prRepoIn.addEventListener('input', () => { draft.prRepo = prRepoIn.value; }); prRepoWrap.append(prRepoIn);
    const prNumWrap = node('label', undefined, 'v19-field'); prNumWrap.append(node('span', 'PR 编号'));
    const prNumIn = document.createElement('input'); prNumIn.type = 'number'; prNumIn.min = '1'; prNumIn.dataset.v19PrNumber = '1';
    prNumIn.value = draft.prNumber ?? (prLinks.at(-1)?.prNumber ? String(prLinks.at(-1).prNumber) : ''); prNumIn.placeholder = '42';
    prNumIn.addEventListener('input', () => { draft.prNumber = prNumIn.value; }); prNumWrap.append(prNumIn);
    prGrid.append(prRepoWrap, prNumWrap);
    const prBtn = button('只读 PR 对账', async () => {
      try {
        const repo = prRepoIn.value.trim(); const num = Number(prNumIn.value);
        if (!repo || !Number.isInteger(num) || num < 1) throw new Error('请填写合法的 owner/repo 与 PR 编号');
        const res = await api('/teams/' + encodeURIComponent(team.id) + '/pr/reconcile', 'POST', {
          repo, prNumber: num, ...(cand ? { candidateId: cand.id } : {}),
        });
        prReconcileByTeam.set(team.id, res);
        v19SetCardStatus(statusEl, `已完成 PR #${num} 只读对账（writeRequestsMade=${res.observation?.writeRequestsMade ?? 0}）。`);
        notice(`PR #${num} 只读对账完成。`);
        await refresh(true);
      } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
    }, 'pr-rec:' + team.id);
    prBtn.dataset.action = 'pr-reconcile';
    const prAct = node('div', undefined, 'actions'); prAct.append(prBtn); prSec.append(prGrid, prAct);

    const latestObs = prReconcileByTeam.get(team.id)?.observation || prLinks.at(-1)?.lastObservation || null;
    const confirmedPublish = (Array.isArray(team.publishIntents) ? team.publishIntents : []).some(i => i.status === 'confirmed' || i.receipt?.branch);
    if (latestObs || prLinks.length) {
      const pills = node('div', undefined, 'v19-pills'); pills.dataset.v19PrPills = '1';
      const localIntegrated = Boolean(team.lastMerge?.branch || confirmedPublish || latestObs?.localFacts?.publishedLocally);
      pills.append(node('span', localIntegrated ? `1. 本地集成发布：已发布本地分支${team.lastMerge?.branch ? ` (${team.lastMerge.branch})` : ''}` : '1. 本地集成发布：尚未发布', 'v19-pill ' + (localIntegrated ? 'good' : 'warn')));
      if (latestObs) {
        const rMerged = Boolean(latestObs.remoteMerged);
        pills.append(node('span', `2. 远端 PR：${rMerged ? '已合入' : '未合入'}${latestObs.versionMismatch ? ' (存在版本差异)' : ''}`, 'v19-pill ' + (latestObs.versionMismatch ? 'warn' : (rMerged ? 'good' : ''))));
        const gOk = Boolean(latestObs.localFacts?.effectiveGoalPassed);
        pills.append(node('span', `3. 本地目标同步：${gOk ? '本地已通过' : '本地未通过'}${rMerged && !gOk ? '（远端已合入但本地未变绿）' : ''}`, 'v19-pill ' + (gOk ? 'good' : 'error')));
      } else if (prLinks.at(-1)) {
        const lk = prLinks.at(-1);
        pills.append(node('span', `2. 远端 PR #${lk.prNumber}：${lk.lastState || lk.status || 'unknown'}`, 'v19-pill'));
      }
      prSec.append(pills);
    }

    const streams = (Array.isArray(team.deliveryStreams) ? team.deliveryStreams : []).filter(s => s.state === 'frozen_external_drift');
    for (const st of streams) {
      const item = node('div', undefined, 'v19-item');
      item.append(node('p', `交付流 ${st.id} 因外部漂移已冻结：${st.frozenReason || st.actualRemoteHead}`, 'error'));
      const nb = document.createElement('input'); nb.type = 'text'; nb.placeholder = '重定向到新分支名（留空则接纳当前远端头）'; nb.dataset.v19DriftBranch = '1';
      const rb = button('解决外部漂移', async () => {
        try {
          await api('/teams/' + encodeURIComponent(team.id) + '/remote/drift/resolve', 'POST', {
            deliveryStreamId: st.id, action: nb.value.trim() ? 'redirect_new_branch' : 'adopt_as_candidate', ...(nb.value.trim() ? { newBranch: nb.value.trim() } : {}),
          });
          notice(`已解决交付流 ${st.id} 的外部漂移冻结。`); await refresh(true);
        } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
      }, 'drift-res:' + st.id);
      rb.dataset.action = 'resolve-drift'; item.append(nb, rb); prSec.append(item);
    }

    const unknownPrs = (Array.isArray(team.prCreateIntents) ? team.prCreateIntents : []).filter(i => i.status === 'receipt_unknown' || i.status === 'unknown');
    for (const u of unknownPrs) {
      const item = node('div', undefined, 'v19-item');
      item.append(node('p', `PR 建单回执未明（${u.id} · ${u.status}）：绝不自动重试创建，需只读核实或人工处置。`, 'warn'));
      const pIn = document.createElement('input'); pIn.type = 'number'; pIn.min = '1'; pIn.placeholder = '已知 PR 编号'; pIn.dataset.v19UnknownPr = '1';
      const bBind = button('人工绑定 PR', async () => {
        try {
          await api('/teams/' + encodeURIComponent(team.id) + '/remote/unknown/resolve', 'POST', { intentId: u.id, action: 'bind_existing', prNumber: Number(pIn.value) });
          notice(`已人工绑定 PR 意图 ${u.id}。`); await refresh(true);
        } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
      }, 'unk-bind:' + u.id);
      const bAb = button('作废此意图', async () => {
        try {
          await api('/teams/' + encodeURIComponent(team.id) + '/remote/unknown/resolve', 'POST', { intentId: u.id, action: 'abandon' });
          notice(`已作废未知 PR 意图 ${u.id}。`); await refresh(true);
        } catch (err) { v19SetCardStatus(statusEl, v19FmtErr(err), true); notice(v19FmtErr(err)); }
      }, 'unk-ab:' + u.id, 'quiet');
      bBind.dataset.action = 'resolve-unknown-bind'; bAb.dataset.action = 'resolve-unknown-abandon';
      item.append(pIn, bBind, bAb); prSec.append(item);
    }
    card.append(prSec, statusEl); ov.append(card);
  }
  function v19BindGlobalUI() {
    const probeBtn = $('probe-repo-btn');
    if (probeBtn && !probeBtn.dataset.v19Bound) {
      probeBtn.dataset.v19Bound = '1';
      probeBtn.addEventListener('click', async () => {
        const out = $('repo-probe-result'); const rp = $('team-repo-path')?.value?.trim();
        if (!out) return; out.hidden = false;
        if (!rp) { out.textContent = '请先填写 Git 仓库根目录绝对路径。'; out.className = 'error'; return; }
        out.textContent = '正在只读探测仓库锁文件与候选测试命令…'; out.className = 'hint';
        try {
          const res = await api('/repo/probe', 'POST', { repoPath: rp });
          out.className = 'hint';
          const cmds = (res.candidateCommands || []).map(c => `${c.command} ${(c.args || []).join(' ')}`).join(' | ');
          out.textContent = `生态：${(res.ecosystems || []).join(', ') || '未识别'}；锁文件：${(res.lockfiles || []).map(l => l.file).join(', ') || '无'}；候选命令（autoSelected=${res.autoSelected}）：${cmds || '未检测到'}。`;
        } catch (err) { out.className = 'error'; out.textContent = v19FmtErr(err); }
      });
    }
    const teamForm = $('team-form');
    if (teamForm && !teamForm.dataset.v19Bound) {
      teamForm.dataset.v19Bound = '1';
      teamForm.addEventListener('submit', () => {
        const nameVal = teamForm.querySelector('input[name="name"]')?.value?.trim();
        const tVal = Number($('team-soft-token')?.value); const dVal = Number($('team-max-duration')?.value); const aVal = Number($('team-max-attempts')?.value);
        const b = {};
        if (Number.isInteger(tVal) && tVal >= 1) b.maxTeamTokensSoft = tVal;
        if (Number.isFinite(dVal) && dVal >= 1) b.maxTaskDurationMs = Math.round(dVal * 1000);
        if (Number.isInteger(aVal) && aVal >= 1) b.maxTeamAttempts = aVal;
        pendingCreateBudget = nameVal && Object.keys(b).length ? { teamName: nameVal, budget: b } : null;
      }, { capture: true });
    }
    const ov = $('overview');
    if (ov && !ov.dataset.v19ObsBound && typeof MutationObserver !== 'undefined') {
      ov.dataset.v19ObsBound = '1';
      new MutationObserver(() => {
        if (!currentTeam || currentTeam.id !== selectedTeam) return;
        if (pendingCreateBudget && currentTeam.name === pendingCreateBudget.teamName) v19ApplyPendingBudget(currentTeam);
        if (currentTeam.workspaceMode !== 'git-worktree' && !ov.querySelector('[data-v19-panel="governance"]')) ov.append(v19BuildGovernanceCard(currentTeam));
      }).observe(ov, { childList: true });
    }
  }
  queueMicrotask(v19BindGlobalUI);

  function node(tag, text, className) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (className) e.className = className;
    return e;
  }
  function notice(text) {
    const el = $('notice');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }
  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    return (n / 1024 / 1024).toFixed(1) + ' MiB';
  }
  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }
  function formatUsage(u) {
    if (!u || typeof u !== 'object') return '';
    const total = u.total_tokens ?? u.totalTokens ?? u.total ?? ((typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') ? u.input_tokens + u.output_tokens : null);
    return typeof total === 'number' && Number.isFinite(total) ? total.toLocaleString() + ' tokens' : '';
  }
  function priorityLabel(p) { return { critical: '紧急', high: '高优', low: '低优' }[p] || ''; }
  async function copyText(text, btn) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1400);
    } catch { notice('剪贴板不可用，请手动选中复制。'); }
  }

  const themeOrder = ['auto', 'dark', 'light'];
  const themeLabels = { auto: '主题：自动', dark: '主题：深色', light: '主题：浅色' };
  let themePreference = 'auto';

  function syncEffectiveTheme() {
    const target = themePreference === 'auto'
      ? (isShadow ? (detectHostDarkTheme() ? 'dark' : 'light') : null)
      : themePreference;
    const surfaces = isShadow ? [root.host, shellEl] : [document.documentElement, shellEl];
    for (const s of surfaces) {
      if (!s?.dataset) continue;
      if (!target) delete s.dataset.theme;
      else s.dataset.theme = target;
    }
    const btn = $('toggle-theme');
    if (btn) btn.textContent = themeLabels[themePreference];
  }

  function applyTheme(mode) {
    themePreference = themeOrder.includes(mode) ? mode : 'auto';
    try { localStorage.setItem('superagent-dsh-theme', themePreference); } catch {}
    syncEffectiveTheme();
  }
  try { applyTheme(localStorage.getItem('superagent-dsh-theme') || 'auto'); } catch { applyTheme('auto'); }

  let hostThemeObserver = null;
  if (isShadow && typeof MutationObserver !== 'undefined') {
    hostThemeObserver = new MutationObserver(() => {
      if (themePreference === 'auto') syncEffectiveTheme();
    });
    hostThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-mode', 'style'] });
    if (document.body) hostThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
  }

  function appendInlineMarkdown(parent, text) {
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0, match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
      const tok = match[0];
      if (tok.startsWith('`')) parent.append(node('code', tok.slice(1, -1)));
      else if (tok.startsWith('**')) parent.append(node('strong', tok.slice(2, -2)));
      last = match.index + tok.length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(text) {
    const wrap = node('div', undefined, 'md-body');
    if (!text) { wrap.append(node('p', '暂无记录')); return wrap; }
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trimStart().startsWith('```')) {
        const codeLines = []; i++;
        while (i < lines.length && !lines[i].trimStart().startsWith('```')) { codeLines.push(lines[i]); i++; }
        if (i < lines.length) i++;
        const pre = node('pre'), code = node('code', codeLines.join('\n'));
        pre.append(code); wrap.append(pre); continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        const h = node(heading[1].length <= 2 ? 'h4' : 'h5');
        appendInlineMarkdown(h, heading[2]); wrap.append(h); i++; continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const ul = node('ul');
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const li = node('li');
          appendInlineMarkdown(li, lines[i].replace(/^\s*[-*]\s+/, ''));
          ul.append(li); i++;
        }
        wrap.append(ul); continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const ol = node('ol');
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const li = node('li');
          appendInlineMarkdown(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
          ol.append(li); i++;
        }
        wrap.append(ol); continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !lines[i].trimStart().startsWith('```') && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      const p = node('p'); appendInlineMarkdown(p, para.join('\n')); wrap.append(p);
    }
    return wrap;
  }

  function renderSystemHealth(value) {
    const box = $('system-health');
    if (!box) return;
    const visible = Boolean(value && (value.actionRequired || auditMode));
    box.hidden = !visible;
    if (!value) return;
    box.className = value.actionRequired ? 'error' : 'hint';
    box.replaceChildren(node('p', '全局状态 · 未确认执行占用 ' + value.unresolvedSlotsUsed + ' 槽 · 快照 ' + (value.snapshotDiskUsageBytes === null ? '统计中' : (value.snapshotDiskUsageBytes / 1024 / 1024).toFixed(1) + ' MiB')));
    for (const issue of value.diagnostics || []) {
      const ref = issue.example || {};
      const label = {
        'execution-known-identity': '原子代理身份已保存：先核对原执行终态，再决定后续动作。',
        'execution-missing-identity': '缺少原子代理身份：检查执行日志寻找原身份，保留占槽，不另建替代任务。',
      }[issue.kind] || issue.kind;
      box.append(node('p', issue.count + ' 项 · ' + label, 'hint'));
      if (ref.taskId) box.append(node('p', '示例任务 ' + ref.taskId + '；用任务详情核对原执行。', 'meta'));
    }
    if (value.unresolvedSlotsUsed) box.append(node('p', '暂停或放弃业务跟进不证明执行已停止，不释放未知占槽。', 'hint'));
    if (value.snapshotDiskError) box.append(node('p', '快照统计失败：' + value.snapshotDiskError));
  }

  function renderApprovals(list) {
    pendingApprovals = list || [];
    const sig = JSON.stringify(pendingApprovals.map(a => [a.id, a.summary]));
    if (sig === lastApprovals) return;
    lastApprovals = sig;
    const box = $('approval-banner');
    if (!box) return;
    box.hidden = !pendingApprovals.length;
    if (!pendingApprovals.length) { box.replaceChildren(); return; }
    box.replaceChildren(node('h2', '待你审批（' + pendingApprovals.length + ' 项 · 超时将默认拒绝）'));
    for (const item of pendingApprovals) {
      const card = node('div', undefined, 'approval-card');
      card.append(node('h3', (item.taskTitle ? item.taskTitle + ' · ' : '') + item.summary));
      const sec = Math.max(1, Math.ceil((item.remainingMs || 0) / 1000));
      card.append(node('p', '请求方法：' + item.method + ' · 约 ' + sec + ' 秒后自动拒绝', 'meta'));
      const det = technical('查看审批参数', 'approval:' + item.id);
      det.append(node('pre', item.detail || '{}', 'log'));
      card.append(det);
      const controls = node('div', undefined, 'actions'), key = 'approval:' + item.id;
      controls.append(
        button('允许本次', async () => { await api('/approvals/' + encodeURIComponent(item.id) + '/decide', 'POST', { decision: 'allow' }); notice('已允许本次操作请求。'); await loadApprovals(); }, key, 'primary-good'),
        button('拒绝', async () => { await api('/approvals/' + encodeURIComponent(item.id) + '/decide', 'POST', { decision: 'deny' }); notice('已拒绝该操作请求。'); await loadApprovals(); }, key, 'secondary danger')
      );
      card.append(controls); box.append(card);
    }
    applyLocks();
  }

  async function loadApprovals() {
    try { const r = await api('/approvals'); renderApprovals(r.approvals || []); } catch {}
  }

  function connectionError(text) {
    connectionProblem = text;
    const errEl = $('connection-error'), connEl = $('connection');
    if (errEl) { errEl.textContent = text; errEl.hidden = !text; }
    if (text && connEl) { connEl.textContent = '连接中断 · 自动重连中'; connEl.classList.add('offline'); }
  }
  function reportError(error) { if (!error.connection || error.mutation) notice(error.message); }
  function statusLabel(state) { return states[state] || '状态待核实'; }
  function taskLabel(task) {
    return task?.state === 'blocked'
      ? (task.blockReason === 'dependency-abandoned' ? '依赖已放弃 · 需要重规划' : task.blockReason === 'write-scope-lock' ? '等待同范围写入锁释放' : task.blockReason === 'wait' ? '等待宿主就绪' : task.blockReason === 'preflight' || task.error ? '预检失败 · 需要处理' : '等待依赖')
      : statusLabel(task?.state);
  }
  function badge(state, label) {
    const tone = state === 'failed' || label?.includes('失败') ? ' error' : ['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed', 'submitted', 'abandoned'].includes(state) || label?.includes('重规划') ? ' warn' : ['accepted', 'checked'].includes(state) ? ' good' : '';
    return node('span', label || statusLabel(state), 'state' + tone);
  }
  function dotTone(task) {
    if (['accepted', 'checked'].includes(task.state)) return 'good';
    if (['running', 'dispatching'].includes(task.state)) return 'running';
    if (task.state === 'failed' || task.blockReason === 'preflight') return 'error';
    if (['submitted', 'unknown', 'paused-unconfirmed', 'cancelled-unconfirmed', 'abandoned'].includes(task.state) || task.blockReason === 'dependency-abandoned') return 'warn';
    return '';
  }

  async function request(url, reqOptions = {}, html = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), reqOptions.method && reqOptions.method !== 'GET' ? 15000 : 8000);
    try {
      const response = await fetch(url, {
        ...reqOptions,
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
      });
      return { response, result: html ? await response.text() : await response.json() };
    } catch (error) {
      const failure = new Error(error.name === 'AbortError' ? '宿主服务响应超时' : '无法读取进程内引擎，请确认插件已启用');
      failure.connection = true;
      connectionError(failure.message + '。正在自动重连；当前草稿已保留。');
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  async function renewToken(previous) {
    if (token !== previous) return;
    if (!tokenFlight) {
      tokenFlight = (async () => {
        const { response, result } = await request(`${apiBase}/`, {}, true);
        const next = new DOMParser().parseFromString(result, 'text/html').querySelector('meta[name="engine-token"]')?.content;
        if (!response.ok || !next) {
          const error = new Error('暂时无法更新连接凭据');
          error.connection = true;
          throw error;
        }
        token = next === 'dsh-fenced' ? '' : next;
        const meta = document.querySelector?.('meta[name="engine-token"]');
        if (meta) meta.content = next;
        restartStream();
      })().finally(() => { tokenFlight = null; });
    }
    return tokenFlight;
  }

  async function api(path, method = 'GET', data, extraHeaders = {}) {
    const mutation = method !== 'GET';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const sentToken = token;
        const headers = { 'Content-Type': 'application/json', ...(sentToken ? { 'x-engine-token': sentToken } : {}), ...extraHeaders };
        const payload = mutation && data !== undefined && activeSessionId && typeof data === 'object' && !Array.isArray(data) && data.sessionId === undefined
          ? { ...data, sessionId: activeSessionId }
          : data;
        const { response, result } = await request(`${apiBase}/api${path}`, {
          method,
          headers,
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
        if (response.status === 401) {
          connectionError('本机连接凭据已变化，正在重新连接；当前草稿已保留。');
          await renewToken(sentToken);
          if (!mutation && attempt === 0) continue;
          const error = new Error(mutation ? '连接凭据已更新。本次操作未自动重发；请先核对原结果，再决定是否重新操作。' : '连接凭据暂未恢复，将继续自动重连');
          error.connection = true;
          throw error;
        }
        if (!response.ok) {
          const error = new Error(result.error || '请求失败');
          if (response.status >= 500) {
            error.connection = true;
            connectionError(error.message + '。正在自动重连；当前草稿已保留。');
          }
          throw error;
        }
        return result;
      }
    } catch (error) {
      if (error.connection && mutation) {
        error.mutation = true;
        if (!error.message.includes('未自动重发')) error.message += '。本次操作未自动重发，结果尚未确认；请先核对原结果，再决定是否重新操作。';
      }
      throw error;
    }
  }

  function applyLocks() {
    root.querySelectorAll('[data-lock]').forEach(b => {
      b.disabled = locks.has(b.dataset.lock) || b.dataset.unavailable === 'true';
    });
  }
  async function action(key, fn) {
    if (locks.has(key)) return;
    locks.add(key); applyLocks();
    try { await fn(); await refresh(true); }
    catch (e) { reportError(e); }
    finally { locks.delete(key); applyLocks(); }
  }
  function button(text, fn, key, style = 'secondary') {
    const b = node('button', text, style);
    b.type = 'button';
    if (key) b.dataset.lock = key;
    b.addEventListener('click', () => key ? action(key, fn) : Promise.resolve().then(fn).catch(reportError));
    return b;
  }
  function message(label, text) {
    const box = node('div', undefined, 'message');
    box.append(node('h3', label), node('p', text || '暂无记录'));
    return box;
  }
  function markdownMessage(label, text, copyable = false) {
    const box = node('div', undefined, 'message');
    if (copyable && text) {
      const head = node('div', undefined, 'message-head');
      head.append(node('h3', label));
      const copyBtn = node('button', '复制', 'quiet');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', () => copyText(text, copyBtn));
      head.append(copyBtn); box.append(head);
    } else box.append(node('h3', label));
    box.append(renderMarkdown(text));
    return box;
  }
  function technical(label, id) {
    const d = node('details'), summary = node('summary', label);
    d.append(summary);
    if (id) {
      d.open = disclosureState.get(id) || false;
      d.addEventListener('toggle', () => disclosureState.set(id, d.open));
    }
    return d;
  }
  function scopePath(teamId = selectedTeam) {
    return teamId && teamId !== LEGACY ? '/teams/' + encodeURIComponent(teamId) + '/sources' : '/sources';
  }
  function taskList(value) { return Array.isArray(value) ? value : value?.tasks || []; }
  function memberTasks(member) { return currentTasks.filter(t => t.memberId === member.id || (member.taskIds || []).includes(t.id)); }
  function memberState(tasks) {
    if (!tasks.length) return null;
    for (const s of ['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed', 'abandoned', 'failed', 'running', 'dispatching', 'pausing', 'cancelling', 'submitted', 'checked', 'blocked', 'queued', 'paused', 'cancelled']) {
      if (tasks.some(t => t.state === s)) return s;
    }
    return tasks.every(t => t.state === 'accepted') ? 'accepted' : 'unknown';
  }
  function modelLabel(task) { return task?.model ? task.model + ' / ' + (task.effort || '强度待核实') : '模型待分配'; }
  function saveSourceDraft() {
    const f = $('source-form');
    if (!f) return;
    sourceDrafts.set(selectedTeam, { label: f.elements.label.value, text: f.elements.text.value, critical: f.elements.critical.checked, kind: f.elements.kind.value });
  }
  function restoreSourceDraft() {
    const f = $('source-form'), d = sourceDrafts.get(selectedTeam) || {};
    if (!f) return;
    f.elements.label.value = d.label || '';
    f.elements.text.value = d.text || '';
    f.elements.critical.checked = !!d.critical;
    f.elements.kind.value = d.kind || 'document';
  }
  function changeTeam(id) {
    saveSourceDraft();
    selectedTeam = id; selectedMember = null; selectedTask = null; currentTeam = null; currentTasks = []; attentionPage = null;
    scopeSequence++; refreshSequence++; detailSequence++; sourceSequence++; sourcePage = null;
    lastShell = ''; lastTask = ''; lastSources = '';
    $('source-viewer').hidden = true; $('workbench').hidden = true; $('legacy-tools').hidden = true;
    if ($('dsh-session-panel')) $('dsh-session-panel').hidden = !id || id === LEGACY;
    restoreSourceDraft(); notice('');
    $('overview').replaceChildren(node('p', '正在读取团队…', 'hint'));
    refresh(true);
  }
  function renderSwitcher(teams) {
    allTeams = teams;
    const select = $('team-select'), filter = ($('team-filter')?.value || '').trim().toLowerCase(), showArchived = Boolean($('show-archived')?.checked);
    const visible = teams.filter(t => (showArchived || !t.archived || t.id === selectedTeam) && (!filter || (t.name || '').toLowerCase().includes(filter)));
    const signature = JSON.stringify([visible.map(t => [t.id, t.name, Boolean(t.archived)]), showArchived, filter]);
    if (select.dataset.signature !== signature) {
      select.replaceChildren(new Option('选择团队', ''));
      for (const t of visible) select.add(new Option((t.archived ? '[已归档] ' : '') + (t.name || '未命名团队'), t.id));
      select.add(new Option('此前的独立任务', LEGACY));
      select.dataset.signature = signature;
    }
    select.value = selectedTeam;
  }
  function stat(value, label) {
    const n = node('div', undefined, 'stat');
    n.append(node('strong', String(value)), node('span', label));
    return n;
  }
  async function openAttentionTask(task, scope) {
    if (scope !== scopeSequence) return;
    if (!currentTasks.some(item => item.id === task.id)) await refresh(true);
    if (scope !== scopeSequence) return;
    const member = currentTeam?.members.find(m => memberTasks(m).some(item => item.id === task.id));
    if (!member) { notice('当前团队已找不到这项任务，请刷新待处理任务。'); return; }
    selectedMember = member.id; selectedTask = task.id; view = 'task';
    renderMembers(); renderMemberHeading(); $('member-heading').scrollIntoView({ block: 'start' }); await loadDetail();
  }
  async function loadAttentionPage(cursor = 0) {
    const scope = scopeSequence;
    if (!currentTeam || (attentionPage?.scope === scope && attentionPage.loading)) return;
    const panel = node('div'), page = { scope, panel, loading: true };
    attentionPage = page;
    panel.setAttribute('aria-live', 'polite');
    panel.append(node('p', '正在读取待处理任务…', 'hint'));
    renderOverview(); applyLocks();
    try {
      const query = new URLSearchParams({ teamId: currentTeam.id, attentionOnly: 'true', limit: '5', cursor: String(cursor) });
      const data = await api('/overview?' + query);
      if (scope !== scopeSequence) return;
      const resultLabel = data.items.length
        ? '待处理任务 ' + (cursor + 1) + '–' + (cursor + data.items.length) + ' / ' + data.matchedTotal
        : cursor ? '本页已无待处理任务。' : '暂无待处理任务。';
      panel.replaceChildren(node('p', new Date().toLocaleTimeString('zh-CN') + ' 查询 · ' + resultLabel, 'hint'));
      const rows = node('div', undefined, 'actions');
      for (const task of data.items) {
        const entry = button((task.title || '成员任务') + ' · ' + taskLabel(task), () => openAttentionTask(task, scope));
        entry.dataset.attentionTask = task.id;
        rows.append(entry);
      }
      if (data.nextCursor !== null) rows.append(button('下一页待处理任务', () => loadAttentionPage(data.nextCursor)));
      panel.append(rows);
    } catch (error) {
      if (scope === scopeSequence) panel.replaceChildren(node('p', error.message, 'error'));
    } finally {
      page.loading = false;
    }
  }

  function renderOverview() {
    const box = $('overview'); box.replaceChildren();
    const legacy = selectedTeam === LEGACY, team = currentTeam, tasks = currentTasks, top = node('div', undefined, 'team-top');
    top.append(node('h2', legacy ? '此前的独立任务' : team.name || '未命名团队'));
    if (!legacy) {
      const state = team.control === 'cancel' ? 'cancelled' : team.control === 'pause' ? 'paused' : 'running';
      const label = (team.archived ? '已归档 · ' : '') + (team.control === 'pause' ? (tasks.length ? '已暂停' : '筹备中') : team.control === 'cancel' ? '已取消' : '协作已开启');
      top.append(badge(state, label));
      if (team.workspaceMode === 'git-worktree') {
        top.append(node('span', 'Git Worktree' + (team.baseCommit ? ' · ' + team.baseCommit.slice(0, 7) : ''), 'mini-tag auto'));
      }
    }
    box.append(top, node('p', legacy ? '保留原有任务的记录、检查和验收入口。' : team.goal || '目标尚未记录', 'goal'));
    if (!legacy && team.workspaceMode === 'git-worktree') {
      const gitLine = 'Git 仓库模式 · 基线 ' + (team.baseCommit ? team.baseCommit.slice(0, 12) : '未知')
        + (team.baseBranch ? ' (' + team.baseBranch + ')' : '')
        + (team.lastMerge?.branch ? ' · 已发布分支 ' + team.lastMerge.branch : ' · 尚未合并发布');
      box.append(node('p', gitLine, 'meta'));
    }
    if (tasks.length) {
      const acceptedCount = tasks.filter(t => t.state === 'accepted').length, pct = Math.round((acceptedCount / tasks.length) * 100);
      const pw = node('div', undefined, 'progress-wrap'), pm = node('div', undefined, 'progress-meta');
      pm.append(node('span', '交付进度：' + acceptedCount + ' / ' + tasks.length + ' 已验收'), node('span', pct + '%'));
      const track = node('div', undefined, 'progress-track'), fill = node('div', undefined, 'progress-fill');
      fill.style.width = pct + '%'; track.append(fill); pw.append(pm, track); box.append(pw);
    }
    const stats = node('div', undefined, 'stats');
    stats.append(
      stat(legacy ? tasks.length : team.members.length, legacy ? '独立任务' : '团队成员'),
      stat(tasks.filter(t => ['running', 'dispatching'].includes(t.state)).length, '执行中'),
      stat(tasks.filter(t => ['submitted', 'checked'].includes(t.state)).length, '待验收'),
      stat(tasks.filter(t => t.state === 'accepted').length, '已验收'),
      stat(tasks.filter(t => ['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed', 'failed'].includes(t.state) || t.state === 'blocked' && !['wait', 'dependency', 'dependency-abandoned', 'write-scope-lock'].includes(t.blockReason) && !!t.error).length, '异常待核对'),
      stat(tasks.filter(t => t.state === 'abandoned' && t.executionUnresolved).length, '已放弃但运行未确认'),
      stat(tasks.filter(t => t.blockReason === 'dependency-abandoned').length, '依赖放弃待重规划')
    );
    box.append(stats);

    const graph = !legacy ? team.graph : null;
    const showDag = !legacy && graph && graph.waves?.length && (graph.waveCount > 1 || graph.scopeOverlaps?.length || tasks.some(t => t.dependsOn?.length || t.autoAccept || (t.priority && t.priority !== 'normal')));
    if (showDag) {
      const byId = new Map(tasks.map(t => [t.id, t])), dag = node('div', undefined, 'dag-section');
      const header = node('div', undefined, 'dag-header');
      const summary = '执行波次图 · ' + graph.waveCount + ' 个波次 · 最大并行度 ' + graph.maxParallelWidth + (graph.criticalPathIds?.length > 1 ? ' · 关键路径 ' + graph.criticalPathIds.length + ' 步' : '');
      header.append(node('strong', summary), node('span', '点击节点跳转到对应成员任务'));
      dag.append(header);
      if (graph.scopeOverlaps?.length) {
        const warn = node('div', undefined, 'scope-warning');
        const items = graph.scopeOverlaps.slice(0, 3).map(o => `「${o.taskA.title}」与「${o.taskB.title}」(${o.scopes.map(pair => pair[0]).join(', ')})`).join('；');
        warn.textContent = '⚠ 检测到 ' + graph.scopeOverlaps.length + ' 组并行写入范围重叠：' + items + (graph.scopeOverlaps.length > 3 ? ' 等' : '') + '。调度器已启用写入范围互斥锁自动串行执行，且越界生成文件将拦截验收。';
        dag.append(warn);
      }
      const waveList = node('div', undefined, 'wave-list');
      for (const w of graph.waves) {
        const row = node('div', undefined, 'wave-row');
        row.append(node('span', 'Wave ' + (w.wave + 1), 'wave-label'));
        const nodesBox = node('div', undefined, 'wave-nodes');
        for (const gNode of w.tasks) {
          const t = byId.get(gNode.id) || gNode;
          const isCritical = Boolean(gNode.onCriticalPath && graph.waveCount > 1);
          const chip = node('button', undefined, 'dep-chip' + (isCritical ? ' critical-node' : ''));
          chip.type = 'button';
          const dot = node('span', undefined, 'dep-dot ' + dotTone(t));
          const deps = (gNode.dependsOn || []).map(d => byId.get(d)?.title || d.slice(0, 6));
          chip.append(dot, node('span', (deps.length ? deps.join('+') + ' → ' : '') + (t.title || '任务')));
          if (isCritical) chip.append(node('span', '关键', 'mini-tag critical'));
          if (gNode.priority === 'critical' || gNode.priority === 'high') chip.append(node('span', priorityLabel(gNode.priority), 'mini-tag prio'));
          if (gNode.autoAccept) chip.append(node('span', '自动验', 'mini-tag auto'));
          chip.title = (t.title || '任务') + ' · ' + taskLabel(t) + (gNode.writeScopes?.length ? ' · 写入范围: ' + gNode.writeScopes.join(', ') : '');
          chip.addEventListener('click', () => openAttentionTask(t, scopeSequence));
          nodesBox.append(chip);
        }
        row.append(nodesBox); waveList.append(row);
      }
      dag.append(waveList); box.append(dag);
    }

    if (!legacy) {
      const controls = node('div', undefined, 'actions'), key = 'team:' + team.id, missing = team.members.filter(m => !memberTasks(m).length).length;
      const checkedEligible = tasks.filter(t => t.state === 'checked' && t.control === 'run' && !t.executionUnresolved && t.completionStatus !== 'failed');
      if (team.control !== 'cancel') {
        if (team.control === 'pause') controls.append(button(missing ? '创建成员任务并开始' : '接续协作', () => startTeam(team.id), key));
        else controls.append(button('暂停团队', () => controlTeam(team.id, 'pause'), key));
        if (checkedEligible.length) controls.append(button('一键验收已通过（' + checkedEligible.length + '）', () => batchAcceptChecked(team.id), key, 'primary-good'));
        controls.append(button('取消团队', () => controlTeam(team.id, 'cancel'), key, 'quiet danger'));
      }
      const exportButton = button('导出已验收成果', () => downloadDelivery(team.id), 'delivery');
      exportButton.dataset.unavailable = String(!tasks.some(task => task.state === 'accepted'));
      exportButton.title = tasks.some(task => task.state === 'accepted') ? '下载固定快照成果和团队交付清单' : '暂无已验收任务';
      controls.append(exportButton);
      if (team.workspaceMode === 'git-worktree') {
        const hasAccepted = tasks.some(task => task.state === 'accepted');
        const previewBtn = button('预览 Git 合并', () => previewGitMerge(team.id), 'merge:' + team.id);
        previewBtn.dataset.unavailable = String(!hasAccepted);
        previewBtn.title = hasAccepted ? '在独立临时 worktree 重放已验收补丁并检查冲突，不修改当前分支' : '暂无已验收任务';
        controls.append(previewBtn);
      }
      controls.append(button('查看待处理任务', () => loadAttentionPage()));
      controls.append(button(team.archived ? '取消归档' : '归档团队', () => archiveTeam(team.id, !team.archived), key, 'quiet'));
      box.append(controls);
      if (team.workspaceMode === 'git-worktree') {
        const hasAccepted = tasks.some(task => task.state === 'accepted');
        const candidates = Array.isArray(team.candidates) ? team.candidates : [];
        const latestCand = candidates.at(-1) || null;
        const prLinks = Array.isArray(team.prLinks) ? team.prLinks : [];
        const latestPr = prLinks.at(-1) || null;
        const criteria = team.goalCriteria || null;

        // R2/R7：三层分离状态条（本地分支 / 目标验收 / 远端 PR 事实）与未覆盖原文暴露
        const statusStrip = node('div', undefined, 'actions');
        if (latestCand?.localPublish) {
          statusStrip.append(node('span', '本地分支：' + latestCand.localPublish.branch, 'mini-tag'));
        } else if (team.lastMerge?.branch) {
          statusStrip.append(node('span', '本地分支：' + team.lastMerge.branch, 'mini-tag'));
        }
        if (latestCand) {
          const gp = Boolean(latestCand.goalEvaluation?.goalPassed);
          statusStrip.append(node('span', gp ? '目标已验收' : (latestCand.isPartial ? '可供审阅（部分成果）' : '待完成目标门禁'), 'mini-tag' + (gp ? ' auto' : ' prio')));
        }
        if (latestPr) {
          const prObs = latestPr.lastObservation || {};
          const prLabel = latestPr.remoteMerged
            ? 'GitHub PR #' + latestPr.prNumber + ' 已合入' + (latestPr.versionMismatch ? '（⚠ 与本地验收版本不一致）' : '')
            : latestPr.externalDrift
              ? 'GitHub PR #' + latestPr.prNumber + ' 外部漂移（只读）'
              : 'GitHub PR #' + (latestPr.prNumber || '?') + ' · ' + (prObs.pr?.state || latestPr.status);
          statusStrip.append(node('span', prLabel, 'mini-tag' + (latestPr.versionMismatch || latestPr.externalDrift ? ' critical' : '')));
        }
        if (statusStrip.children.length) box.append(statusStrip);

        if (criteria?.unmappedSegments?.length) {
          const unmappedWarn = node('div', undefined, 'scope-warning');
          unmappedWarn.textContent = '⚠ 以下用户原话尚未映射验收方式（目标无法自动变绿）：' + criteria.unmappedSegments.map(s => `「${s.text}」`).join('；');
          box.append(unmappedWarn);
        }

        const mergePanel = technical('Git Worktree 冻结候选、本地发布与只读 PR 对账（v0.18）', 'git-merge:' + team.id);
        mergePanel.append(node('p', '先锁定不可变冻结候选（批准 A 绝不漂移发布 A+B），仅以原子 CAS 方式创建全新本地 superagent/<slug> 分支，绝不改动活工作树或既有用户分支；本地分支与远端 PR 合入分开记录。', 'hint'));
        if (latestCand) {
          mergePanel.append(node('p', `最新冻结候选 ${latestCand.id} · 提交 ${String(latestCand.commitOid || '').slice(0, 12)} · 模式 ${latestCand.assemblyMode || 'full_replay'} · 含 ${(latestCand.entries || []).length} 项快照`, 'meta'));
          if (latestCand.baseDrift?.drifted) {
            mergePanel.append(node('p', '基线漂移检查：' + (latestCand.baseDrift.ok ? '无冲突' : '存在集成冲突 (' + (latestCand.baseDrift.conflictPaths || []).join(', ') + ')') + ' · 目标 ' + String(latestCand.baseDrift.targetCommit || '').slice(0, 12), latestCand.baseDrift.ok ? 'meta' : 'error'));
          }
        }
        if (latestPr?.lastObservation?.summaryNote) {
          mergePanel.append(node('p', latestPr.lastObservation.summaryNote, latestPr.versionMismatch || latestPr.externalDrift ? 'error' : 'meta'));
        }
        const branchLabel = node('label', '目标分支后缀（可选，自动加 superagent/ 前缀）');
        const branchInput = node('input');
        branchInput.type = 'text';
        branchInput.maxLength = 64;
        branchInput.placeholder = '例如：release-v1（留空则自动生成）';
        branchInput.dataset.mergeBranch = team.id;
        branchLabel.append(branchInput);
        const mergeActions = node('div', undefined, 'actions');
        const freezeCandBtn = button('生成冻结候选', () => createFrozenCandidate(team.id), 'merge:' + team.id);
        freezeCandBtn.dataset.unavailable = String(!hasAccepted);
        const applyBtn = button('原子发布到新分支', () => applyGitMerge(team.id, branchInput.value.trim() || null), 'merge:' + team.id, 'primary-good');
        applyBtn.dataset.unavailable = String(!hasAccepted);
        mergeActions.append(
          freezeCandBtn,
          button('仅预览冲突与 Diff', () => previewGitMerge(team.id), 'merge:' + team.id),
          applyBtn,
        );
        if (latestCand) {
          mergeActions.append(
            button('批准并发布当前候选', () => approveAndPublishCandidate(team.id, latestCand.id, branchInput.value.trim() || null), 'merge:' + team.id),
            button('检查目标基线漂移', () => checkBaseDrift(team.id, latestCand.id), 'merge:' + team.id, 'quiet'),
          );
        }
        queueMicrotask(() => v19MountOverviewPanels(team, tasks));
        mergePanel.append(branchLabel, mergeActions);
        box.append(mergePanel);
      }
      if (attentionPage?.scope === scopeSequence) box.append(attentionPage.panel);
      box.append(node('p', '导出会列明未完成事项；主项目集成需另行确认。分享前请检查文件中的敏感内容。', 'hint audit-note'));
      if (missing) box.append(node('p', missing + ' 位成员尚未分配任务。开始时先逐一创建任务，全部保存成功后运行。', 'scope-note'));
      box.append(node('p', '状态来自任务记录；开启协作不代表每位成员已开始执行。', 'hint audit-note'));
      const meta = technical('团队标识与版本', 'team:' + team.id);
      meta.append(node('p', '团队 ' + team.id + ' · 版本 ' + (team.revision ?? '未知') + (team.sessionId ? ' · 挂载会话 ' + team.sessionId : ''), 'meta'));
      box.append(meta);
    }
  }

  async function batchAcceptChecked(id) {
    const r = await api('/teams/' + encodeURIComponent(id) + '/accept-checked', 'POST', { actor: 'dsh-workbench:batch-reviewer' });
    const ok = (r.accepted || []).length, fail = (r.failed || []).length;
    notice(fail ? '已批量验收 ' + ok + ' 项，' + fail + ' 项失败：\n' + r.failed.map(f => f.title + '：' + f.error).join('\n') : ok ? '已批量验收 ' + ok + ' 项机械检查通过的任务，并已解锁后续依赖。' : '当前没有可批量验收的已通过任务。');
  }
  async function previewGitMerge(id) {
    notice('正在临时 detached worktree 中预览合并…');
    const r = await api('/teams/' + encodeURIComponent(id) + '/merge-preview', 'POST', {});
    if (r.ok) {
      const filesCount = (r.changedFiles || []).length;
      notice(`合并预览通过：已重放 ${(r.appliedTasks || []).length} 项任务，涉及 ${filesCount} 个文件，未改动活工作树。${r.unacceptedTaskCount ? `（尚有 ${r.unacceptedTaskCount} 项未验收任务未纳入，正式合并将被门禁阻止）` : ''}${r.diffStat ? '\n' + r.diffStat : ''}`);
    } else {
      const c = r.conflict;
      notice(`合并预览发现冲突：任务 ${c?.title || c?.taskId || '未知'}（快照 ${c?.snapshotId?.slice(0, 12) || '未知'}）：${c?.detail || '补丁无法自动应用'}`);
    }
  }
  async function applyGitMerge(id, branchName) {
    notice('正在临时 detached worktree 中重放补丁并原子发布新本地分支…');
    const r = await api('/teams/' + encodeURIComponent(id) + '/merge-apply', 'POST', branchName ? { branchName } : {});
    notice(`已原子创建本地分支 ${r.branch}（提交 ${String(r.mergedCommit || r.commitOid || '').slice(0, 12)}），共纳入 ${(r.appliedTasks || []).length} 项已验收任务；本地分支创建不等于远端 PR 合入，当前活工作树未受改动。`);
  }
  async function createFrozenCandidate(id) {
    notice('正在组装不可变交付候选并固定 Git 对象引用…');
    const r = await api('/teams/' + encodeURIComponent(id) + '/candidates', 'POST', {});
    if (!r.ok && r.conflict) {
      notice(`候选组装发现冲突：任务 ${r.conflict.title || r.conflict.taskId}：${r.conflict.detail}`);
      return;
    }
    const c = r.candidate;
    notice(`已生成冻结候选 ${c.id}（提交 ${String(c.commitOid || '').slice(0, 12)}，${c.isPartial ? '部分成果可供审阅' : '全量已验收'}，${c.goalEvaluation?.goalPassed ? '目标门禁已通过' : '尚有待完成目标条件'}）。`);
  }
  async function approveAndPublishCandidate(id, candidateId, branchName) {
    notice(`正在为冻结候选 ${candidateId} 记录绑定批准并原子发布本地分支…`);
    const app = await api('/teams/' + encodeURIComponent(id) + '/candidates/' + encodeURIComponent(candidateId) + '/approve', 'POST', {
      purpose: 'local_publish',
      ...(branchName ? { branchName } : {}),
      actor: 'dsh-workbench:maintainer',
    });
    const pub = await api('/teams/' + encodeURIComponent(id) + '/candidates/' + encodeURIComponent(candidateId) + '/publish-local', 'POST', {
      approvalId: app.id,
      ...(branchName ? { branchName } : {}),
    });
    notice(pub.note || `已按绑定批准发布本地分支 ${pub.branch}。`);
  }
  async function checkBaseDrift(id, candidateId) {
    notice(`正在隔离三方试合目标分支与候选 ${candidateId}…`);
    const r = await api('/teams/' + encodeURIComponent(id) + '/candidates/' + encodeURIComponent(candidateId) + '/base-drift', 'POST', {});
    notice(r.ok ? (r.detail || '目标基线试合无冲突。') : `检测到目标基线与候选集成冲突（路径：${(r.conflictPaths || []).join(', ')}）：${r.detail}`);
  }
  async function archiveTeam(id, archived) {
    await api('/teams/' + encodeURIComponent(id) + '/archive', 'POST', { archived });
    notice(archived ? '已归档该团队，可在顶部勾选「含已归档」随时查看。' : '已取消归档，团队恢复显示在默认列表中。');
  }
  async function controlTeam(id, control) {
    notice('');
    const r = await api('/teams/' + encodeURIComponent(id) + '/control', 'POST', { action: control });
    const failures = (r.outcomes || []).filter(o => o.status === 'failed');
    notice(failures.length ? '团队控制已保存，' + failures.length + ' 项任务处理失败：\n' + failures.map(o => o.taskId + '：' + (o.error || '原因未知')).join('\n') : { pause: '暂停请求已保存。活动任务的最终状态以真实回执为准。', resume: '协作已开启，将在当前 DeepSeek Harness 会话树下按波次调度子代理。', cancel: '取消请求已保存。尚未确认的运行会标明待核对。' }[control]);
  }
  async function downloadDelivery(id) {
    notice('正在核对固定快照并准备成果包…');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 125000);
    try {
      const sentToken = token;
      let result;
      try { result = await fetchDelivery(id, { token: sentToken, apiBase, signal: controller.signal }); }
      catch (error) { if (error.status === 401) { await renewToken(sentToken); throw new Error('连接凭据已更新，请重新点击导出。'); } throw error; }
      const url = URL.createObjectURL(result.blob), link = document.createElement('a');
      link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (selectedTeam === id) notice('成果包校验完成，已交给浏览器下载。请在下载列表确认保存结果；未完成事项见包内 DELIVERY.md。');
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('导出超时，未保存文件。请检查团队状态后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function startTeam(id) {
    notice('正在保存成员任务；已存在任务保留原输入，全部完成后才会开始协作。');
    const team = await api('/teams/' + encodeURIComponent(id)), sourceResponse = await api(scopePath(id));
    const sources = Array.isArray(sourceResponse) ? sourceResponse : sourceResponse.sources || [];
    const sourceIds = sources.map(source => source.id);
    const diffMap = memberDifficulties.get(id) || new Map();
    try {
      for (const member of team.members || []) {
        const tasks = taskList(team.tasks).filter(t => t.memberId === member.id || (member.taskIds || []).includes(t.id));
        if (tasks.length) continue;
        const difficulty = diffMap.get(member.name) || 'medium';
        await api('/tasks', 'POST', { requestId: 'ui-team-' + id + '-member-' + member.id, teamId: id, memberId: member.id, title: member.name || member.role, goal: member.responsibility, difficulty, sourceIds });
      }
    } catch (error) {
      throw new Error(error.message + '。本次尚未请求开始协作；已创建任务的输入与资料绑定保持不变，可以重试补齐其余成员任务。');
    }
    await controlTeam(id, 'resume');
    notice($('notice').textContent + '\n已存在任务的输入与资料绑定保持不变；新增任务使用本次启动时的团队资料。');
  }

  function renderMembers() {
    const legacy = selectedTeam === LEGACY;
    const members = legacy ? currentTasks.map(t => ({ id: t.id, name: t.title || '独立任务', role: '独立任务', responsibility: '', taskIds: [t.id] })) : currentTeam.members;
    $('roster-title').textContent = legacy ? '独立任务' : '团队成员';
    $('member-count').textContent = members.length + (legacy ? ' 项' : ' 位');
    if (!members.some(m => m.id === selectedMember)) selectedMember = members[0]?.id || null;
    const list = $('members'); list.replaceChildren();
    for (const m of members) {
      const tasks = memberTasks(m), state = memberState(tasks);
      const active = tasks.filter(t => t.executionUnresolved || ['dispatching', 'running', 'pausing', 'cancelling'].includes(t.state));
      const model = active.length > 1 ? active.length + ' 项活动任务 · 模型见任务详情' : modelLabel(active[0] || tasks.find(t => t.state === state));
      const b = button('', () => { selectedMember = m.id; selectedTask = null; lastTask = ''; detailSequence++; renderMembers(); renderMemberHeading(); loadDetail(); }, null, 'member' + (selectedMember === m.id ? ' active' : ''));
      b.dataset.memberId = m.id; b.setAttribute('aria-pressed', String(selectedMember === m.id));
      const top = node('div', undefined, 'member-top');
      top.append(node('span', m.name || '未命名成员', 'member-name'), badge(state, state ? taskLabel(tasks.find(t => t.state === state && t.blockReason === 'preflight') || tasks.find(t => t.state === state)) : '尚未分配任务'));
      b.append(top, node('p', m.role || '职责成员', 'member-role'));
      if (m.responsibility) b.append(node('p', m.responsibility, 'responsibility'));
      const liveTask = active[0], liveText = liveTask && (liveActivities.get(liveTask.id) || liveTask.lastActivity?.text);
      if (liveText) { const live = node('p', liveText, 'member-live'); live.dataset.liveTask = liveTask.id; b.append(live); }
      b.append(node('p', model, 'member-model'));
      list.append(b);
    }
    if (!members.length) list.append(node('p', '尚无任务', 'hint'));
  }

  function renderMemberHeading() {
    const legacy = selectedTeam === LEGACY;
    const member = legacy && selectedMember ? { id: selectedMember, name: currentTasks.find(t => t.id === selectedMember)?.title || '独立任务', taskIds: [selectedMember] } : currentTeam?.members.find(m => m.id === selectedMember);
    const heading = $('member-heading'); heading.replaceChildren();
    if (!member) {
      heading.append(node('h2', '等待任务')); selectedTask = null;
      $('task-tabs').replaceChildren();
      $('detail').replaceChildren(node('p', '尚无独立任务，可在下方新建。', 'hint'));
      $('activity').replaceChildren(node('p', '尚无执行记录', 'hint'));
      showView(); return;
    }
    heading.append(node('h2', member.name || '未命名成员'));
    if (member.role) heading.append(node('p', member.role, 'member-intro'));
    const tasks = memberTasks(member);
    if (!tasks.some(t => t.id === selectedTask)) selectedTask = tasks.at(-1)?.id || null;
    const tabs = $('task-tabs'); tabs.replaceChildren();
    if (tasks.length > 1) {
      for (const t of tasks) {
        const b = button((t.title || '任务') + ' · ' + taskLabel(t), () => { selectedTask = t.id; lastTask = ''; detailSequence++; renderMemberHeading(); loadDetail(); }, null, selectedTask === t.id ? 'active' : '');
        b.dataset.taskId = t.id; tabs.append(b);
      }
    }
    if (!selectedTask) {
      $('detail').replaceChildren(message('职责', member.responsibility), node('p', '尚未创建成员任务。团队开始协作时再创建并执行。', 'hint'));
      $('activity').replaceChildren(node('p', '尚无执行记录', 'hint'));
    }
    showView();
  }

  function showView() {
    for (const b of $('detail-tabs').querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    }
    $('detail').hidden = view !== 'task';
    $('activity').hidden = view !== 'activity';
    $('sources-panel').hidden = view !== 'sources';
    if (view === 'activity' && selectedTask) {
      const item = taskEvidence(selectedTask);
      $('activity').replaceChildren(item.activity);
      if (!item.loaded && !item.busy) loadEvents(selectedTask).catch(reportError);
    }
  }

  function verificationRecord(task) {
    const record = task.verification, count = (record.files || []).length, status = record.status ?? (count ? (record.passed ? 'passed' : 'failed') : 'not_verified');
    const labels = { passed: '程序检查通过', failed: '程序检查失败', not_verified: '未配置检查 · 尚未验证' };
    const box = message('实际检查记录', labels[status] || status);
    box.append(node('p', '程序检查和调用方最终验收分别记录。测试脚本通过 ELECTRON_RUN_AS_NODE=1 纯 Node 执行，当前进程不提供额外 OS 沙箱。', 'hint audit-note'));
    if (!count) return box;
    const files = technical('检查结果与文件版本', 'files:' + task.id);
    for (const file of record.files || []) files.append(node('p', file.path + ' · SHA-256 ' + (file.sha256 || '未记录'), 'meta'));
    for (const check of record.checks || []) files.append(node('pre', JSON.stringify(check, null, 2), 'log'));
    box.append(files); return box;
  }

  function executionRecord(task) {
    const labels = { completed: '宿主子代理已完成', failed: '宿主执行失败', interrupted: '宿主子代理已中断', 'not-started': '执行尚未启动' };
    const box = message('运行与产物分别核对', labels[task.completionStatus] || (task.executionUnresolved ? '运行结果尚未确认' : '宿主结果未记录'));
    if (task.completionStatus === 'failed') { box.classList.add('error'); box.prepend(badge('failed', '宿主失败 · 产物另行验收')); }
    if (task.runtimeError && task.runtimeError !== task.error) box.append(node('p', String(task.runtimeError)));
    box.append(node('p', '子代理回合结束不证明所有派生进程和外部写入已经停止。', 'hint audit-note'));
    if (task.acceptance) {
      const accepted = task.acceptance, pinned = value => value === true ? '是' : value === false ? '否' : '未知', snapshotId = accepted.snapshotId || task.snapshotId;
      box.append(node('p', task.completionStatus === 'failed' ? '调用方已明确接受产物；宿主失败记录仍保留。' : '调用方验收已记录。'));
      if (accepted.reason) box.append(node('p', '验收理由：' + accepted.reason, 'meta'));
      const audit = node('div', undefined, 'audit-note');
      audit.append(
        node('p', '调用来源声明：' + (accepted.actor || 'unknown') + '；不等于已认证的人类身份。', 'hint'),
        node('p', '版本绑定：' + pinned(accepted.versionPinned), 'meta'),
        node('p', '产物快照：' + (snapshotId || '历史记录尚未冻结'), 'meta'),
        node('p', '快照核验复制的文件字节，不等于操作系统隔离，也不证明派生进程停止。', 'hint')
      );
      if (accepted.snapshotFreeze) audit.append(node('p', '冻结时版本绑定：' + pinned(accepted.snapshotFreeze.versionPinned) + '；原验收的版本绑定记录保留。', 'meta'));
      box.append(audit);
      const details = technical('验收版本与证据', 'acceptance:' + task.id);
      details.append(node('pre', JSON.stringify(accepted, null, 2), 'log'));
      box.append(details);
    }
    return box;
  }

  function acceptanceForm(task) {
    let draft = acceptanceDrafts.get(task.id);
    if (!draft || draft.revision !== task.revision) { draft = { revision: task.revision, reason: '', ack: false }; acceptanceDrafts.set(task.id, draft); }
    const failed = task.completionStatus === 'failed';
    const box = failed ? node('div', undefined, 'message') : technical('验收备注（可选）', 'accept-note:' + task.id);
    const label = node('label', failed ? '宿主失败仍接受产物的理由' : '验收理由'), input = node('textarea');
    input.maxLength = 2000; input.rows = 2; input.value = draft.reason; input.dataset.acceptReason = task.id;
    input.addEventListener('input', () => { draft.reason = input.value; });
    label.append(input); box.append(label);
    if (failed) {
      box.prepend(node('p', '宿主执行失败。只有核对当前产物后，才能明确接受这一版本。', 'error'));
      const check = node('label', undefined, 'check'), ack = node('input');
      ack.type = 'checkbox'; ack.checked = draft.ack; ack.dataset.acceptException = task.id;
      ack.addEventListener('change', () => { draft.ack = ack.checked; });
      check.append(ack, node('span', '我已知晓宿主失败，仍接受当前产物'));
      box.append(check);
    }
    return { box, draft };
  }

  function reworkForm(task) {
    let draft = reworkDrafts.get(task.id);
    if (!draft || draft.revision !== task.revision) { draft = { revision: task.revision, feedback: '' }; reworkDrafts.set(task.id, draft); }
    const panel = technical('打回返工（填写修改意见）', 'rework:' + task.id);
    const label = node('label', '返工修改意见（将作为必读反馈注入下一次执行）'), input = node('textarea');
    input.rows = 3; input.maxLength = 4000; input.placeholder = '例如：补全边界测试、修复第 2 节数据口径、调整输出格式…';
    input.value = draft.feedback; input.dataset.reworkFeedback = task.id;
    input.addEventListener('input', () => { draft.feedback = input.value; });
    label.append(input);
    const submit = button('提交打回返工', async () => {
      if (!draft.feedback.trim()) throw new Error('请填写具体的返工修改意见');
      await api('/tasks/' + encodeURIComponent(task.id) + '/rework', 'POST', { expectedRevision: task.revision, feedback: draft.feedback.trim(), actor: 'dsh-workbench:reviewer' });
      reworkDrafts.delete(task.id); disclosureState.set('rework:' + task.id, false);
      notice('已打回返工，任务已携修改意见重新进入队列。');
    }, 'task:' + task.id, 'secondary');
    submit.dataset.reworkSubmit = task.id;
    const acts = node('div', undefined, 'actions'); acts.append(submit);
    panel.append(label, acts); return panel;
  }

  function abandonmentForm(task) {
    let draft = abandonmentDrafts.get(task.id);
    if (!draft || draft.revision !== task.revision) { draft = { revision: task.revision, reason: '', evidence: '' }; abandonmentDrafts.set(task.id, draft); }
    const box = message('放弃业务跟进', '只放弃业务跟进，不证明已停止；运行未确认时仍占容量。依赖此任务的工作需要重新规划。');
    for (const [field, title, maxLength] of [['reason', '放弃原因', 2000], ['evidence', '已核对的证据引用', 4000]]) {
      const label = node('label', title + '（必填）'), input = node('textarea');
      input.rows = 2; input.maxLength = maxLength; input.required = true; input.value = draft[field];
      input.dataset[field === 'reason' ? 'abandonReason' : 'abandonEvidence'] = task.id;
      input.addEventListener('input', () => { draft[field] = input.value; });
      label.append(input); box.append(label);
    }
    const submit = button('放弃业务跟进', async () => {
      if (!draft.reason.trim() || !draft.evidence.trim()) throw new Error('请填写放弃原因和证据引用；这不会确认运行已停止。');
      await api('/tasks/' + encodeURIComponent(task.id) + '/abandon', 'POST', { expectedRevision: task.revision, actor: 'dsh-workbench:user', reason: draft.reason.trim(), evidence: draft.evidence.trim() });
      abandonmentDrafts.delete(task.id);
      notice('已放弃业务跟进；不证明已停止，运行未确认时仍占容量。');
    }, 'task:' + task.id, 'quiet danger');
    submit.dataset.abandonTask = task.id; box.append(submit); return box;
  }

  function taskFilesWidget(task) {
    const wrap = node('div', undefined, 'files-box');
    const head = node('div', undefined, 'section-heading');
    head.append(node('h3', '产物文件预览'), button('刷新文件列表', () => loadTaskFiles(task.id, wrap), 'files-list:' + task.id, 'quiet'));
    const listEl = node('div', undefined, 'files-list'), previewEl = node('div', undefined, 'file-preview-box');
    previewEl.hidden = true;
    wrap.append(head, listEl, previewEl);
    const cached = taskFilesCache.get(task.id);
    if (cached && cached.revision === task.revision) renderFileChips(task.id, cached.data, listEl, previewEl);
    else { listEl.append(node('p', '点击「刷新文件列表」或等待加载产物文件…', 'hint')); loadTaskFiles(task.id, wrap).catch(() => {}); }
    return wrap;
  }
  function renderFileChips(taskId, data, listEl, previewEl) {
    listEl.replaceChildren();
    const files = data?.files || [];
    if (!files.length) { listEl.append(node('p', '当前工作区尚无生成文件。', 'hint')); return; }
    for (const f of files) {
      const chip = button(f.path + ' (' + formatBytes(f.bytes) + ')', () => previewTaskFile(taskId, f.path, 0, listEl, previewEl, chip), null, 'file-chip');
      chip.dataset.filePath = f.path; listEl.append(chip);
    }
  }
  async function loadTaskFiles(taskId, wrap) {
    const listEl = wrap.querySelector('.files-list'), previewEl = wrap.querySelector('.file-preview-box');
    const data = await api('/tasks/' + encodeURIComponent(taskId) + '/files');
    const task = currentTasks.find(t => t.id === taskId);
    if (taskFilesCache.size >= 100) { const first = taskFilesCache.keys().next().value; if (first) taskFilesCache.delete(first); }
    taskFilesCache.set(taskId, { revision: task?.revision ?? -1, data });
    if (selectedTask === taskId) renderFileChips(taskId, data, listEl, previewEl);
  }
  async function previewTaskFile(taskId, filePath, offset, listEl, previewEl, activeChip) {
    for (const c of listEl.querySelectorAll('.file-chip')) c.classList.toggle('active', c === activeChip);
    previewEl.hidden = false; previewEl.replaceChildren(node('p', '正在读取 ' + filePath + '…', 'hint'));
    try {
      const r = await api('/tasks/' + encodeURIComponent(taskId) + '/file?path=' + encodeURIComponent(filePath) + '&offset=' + offset + '&limit=16384');
      previewEl.replaceChildren();
      const bar = node('div', undefined, 'section-heading');
      bar.append(node('span', filePath + ' · ' + formatBytes(r.totalBytes), 'meta'), button('关闭预览', () => { previewEl.hidden = true; for (const c of listEl.querySelectorAll('.file-chip')) c.classList.remove('active'); }, null, 'quiet'));
      previewEl.append(bar);
      if (r.binary) { previewEl.append(node('p', '二进制文件（' + formatBytes(r.totalBytes) + '），暂不支持文本预览，可导出成果包查看。', 'hint')); return; }
      if (/\.md$/i.test(filePath)) previewEl.append(renderMarkdown(r.text));
      else previewEl.append(node('pre', r.text || '(空文件)', 'log'));
      if (r.nextOffset !== null) {
        const more = node('div', undefined, 'actions');
        more.append(button('读取下一页', () => previewTaskFile(taskId, filePath, r.nextOffset, listEl, previewEl, activeChip)));
        previewEl.append(more);
      }
    } catch (e) { previewEl.replaceChildren(node('p', '无法预览文件：' + e.message, 'error')); }
  }

  async function loadDetail() {
    const id = selectedTask, scope = scopeSequence, sequence = ++detailSequence, box = $('detail');
    if (!id) { delete box.dataset.taskId; lastTask = ''; return; }
    if (box.dataset.taskId !== id) { box.dataset.taskId = id; lastTask = ''; box.replaceChildren(node('p', '正在读取任务详情…', 'hint')); }
    try {
      const task = await api('/tasks/' + encodeURIComponent(id));
      if (id !== selectedTask || scope !== scopeSequence || sequence !== detailSequence) return;
      const snapshot = JSON.stringify([task, currentTeam?.control]);
      if (snapshot === lastTask) { showView(); return; }
      lastTask = snapshot;
      box.replaceChildren();
      const top = node('div', undefined, 'task-head');
      top.append(node('h3', task.title || '成员任务'));
      const badges = node('div', undefined, 'task-badges');
      if (task.priority && task.priority !== 'normal') badges.append(node('span', priorityLabel(task.priority), 'mini-tag' + (task.priority === 'low' ? '' : ' prio')));
      if (task.autoAccept) badges.append(node('span', '检查通过自动验收', 'mini-tag auto'));
      badges.append(badge(task.state, taskLabel(task)));
      top.append(badges);
      const metaParts = [modelLabel(task)];
      const dur = formatDuration(task.durationMs); if (dur) metaParts.push('耗时 ' + dur);
      const tok = formatUsage(task.usage); if (tok) metaParts.push('用量 ' + tok);
      if (task.reworkCount) metaParts.push('已返工 ' + task.reworkCount + ' 次');
      if (task.maxRetries) metaParts.push('失败重试 ' + (task.retryCount ?? 0) + '/' + task.maxRetries);
      box.append(top, node('p', metaParts.join(' · '), 'meta'));
      if (task.writeScopes?.length) box.append(node('p', '建议写入范围：' + task.writeScopes.join('，'), 'meta'));
      const live = liveActivities.get(task.id) || task.lastActivity?.text;
      if (live && ['running', 'dispatching'].includes(task.state)) { const lp = node('p', live, 'member-live'); lp.id = 'task-live'; box.append(lp); }
      box.append(message('任务与完成条件', task.goal));
      if (task.reworkFeedback) box.append(message('最近返工意见', task.reworkFeedback));
      box.append(markdownMessage('当前结果', typeof task.summary === 'string' ? task.summary : task.summary?.text, true));
      if (task.summary?.truncated) box.append(node('p', '当前显示摘要，完整结果可点击下方按钮分页读取。', 'hint'));
      if (task.error) box.append(message('需要处理', typeof task.error === 'string' ? task.error : JSON.stringify(task.error)));
      if (task.budgetDetails) {
        const d = task.budgetDetails, detail = technical('上下文预算明细', 'budget:' + task.id);
        detail.append(node('p', '必需 ' + d.requiredBytes + ' 字节 / 预算 ' + d.budgetBytes + ' 字节；超出 ' + d.overByBytes + ' 字节。请拆分占用最大的依赖或关键材料。', 'hint'));
        for (const row of d.budgetBreakdown || []) detail.append(node('p', row.id + '：' + row.bytes + ' 字节', 'meta'));
        box.append(detail);
      }
      if (task.executionUnresolved) box.append(node('p', '执行结果尚未确认，请先核对原运行。', 'error'));
      if (task.cwd || task.acceptance?.snapshotId) box.append(taskFilesWidget(task));
      if (task.verification) box.append(verificationRecord(task));
      if (task.completionStatus || task.attemptId || task.acceptance) box.append(executionRecord(task));
      if (task.state === 'accepted' && task.acceptance && !task.acceptance.snapshotId && !task.snapshotId && !task.executionUnresolved) {
        const freeze = button('冻结已验收版本', async () => { await api('/tasks/' + encodeURIComponent(id) + '/freeze', 'POST', { expectedRevision: task.revision, actor: 'dsh-workbench:user' }); notice('历史验收的登记字节已冻结；未重新运行检查，原版本绑定记录保留。'); }, 'task:' + id);
        freeze.dataset.freezeSnapshot = id;
        box.append(node('p', '历史验收缺少快照。冻结前会核对已登记版本；文件有变化时需要另行处理。', 'scope-note'), freeze);
      }
      if (task.state === 'abandoned') {
        const record = task.abandonment || {};
        const abandoned = message('业务跟进已放弃', task.executionUnresolved ? '不证明已停止；运行未确认，仍占容量。请核对原运行。' : '已有运行核对记录；放弃业务跟进本身不证明已停止。');
        abandoned.append(node('p', '放弃原因：' + (record.reason || '未记录')), node('p', '证据引用：' + (record.evidence || '未记录'), 'meta'), node('p', '调用来源声明：' + (record.actor || 'unknown') + '；不等于已认证的人类身份。', 'hint audit-note'));
        box.append(abandoned);
      }
      if (task.blockReason === 'dependency-abandoned') box.append(message('依赖需要重新规划', '依赖任务已放弃业务跟进，不能作为已验收依赖继续。请重新规划依赖和任务。'));
      if (task.executionUnresolved && ['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed'].includes(task.state)) box.append(abandonmentForm(task));
      const result = taskEvidence(id); box.append(result.result);
      if (task.state !== 'accepted') {
        const actions = node('div', undefined, 'actions'), key = 'task:' + id;
        const eligible = ['checked', 'submitted'].includes(task.state) && task.control === 'run' && !task.executionUnresolved;
        const form = eligible ? acceptanceForm(task) : null;
        if (form) box.append(form.box);
        if (task.state !== 'abandoned') {
          const accept = button('确认验收', async () => {
            const draft = form?.draft;
            if (task.completionStatus === 'failed' && (!draft?.ack || !draft.reason.trim())) throw new Error('请说明接受产物的理由，并确认保留宿主失败记录。');
            await api('/tasks/' + encodeURIComponent(id) + '/accept', 'POST', { expectedRevision: task.revision, reason: draft?.reason.trim() || null, actor: 'dsh-workbench:user', acknowledgeHostFailure: !!draft?.ack });
            acceptanceDrafts.delete(id); notice('验收结果与当前版本已记录。');
          }, key);
          accept.dataset.unavailable = String(!eligible); actions.append(accept);
          const verify = button('重新检查产物', async () => { await api('/tasks/' + encodeURIComponent(id) + '/verify', 'POST', {}); notice('机械检查已完成，请核对检查记录。'); }, key);
          verify.dataset.unavailable = String(!['failed', 'checked', 'submitted'].includes(task.state) || task.control !== 'run' || task.executionUnresolved);
          verify.title = '仅重新检查本地文件；需要执行结果已确定且控制为运行。'; actions.append(verify);
          box.append(actions);
          if (['submitted', 'checked', 'failed'].includes(task.state) && !task.executionUnresolved && currentTeam?.control !== 'cancel') box.append(reworkForm(task));
        }
        const controls = technical('任务控制与运行核对', 'controls:' + id), group = node('div', undefined, 'actions');
        if (task.state !== 'abandoned' && currentTeam?.control !== 'cancel') {
          for (const [label, actionName] of [['暂停任务', 'pause'], ['接续任务', 'resume'], ['取消任务', 'cancel']]) {
            group.append(button(label, async () => { await api('/tasks/' + encodeURIComponent(id) + '/control', 'POST', { action: actionName }); notice('任务控制请求已保存。'); }, key));
          }
        }
        group.append(button('核对原运行', async () => { await api('/tasks/' + encodeURIComponent(id) + '/reconcile', 'POST', {}); notice('已请求核对原运行，请查看任务状态。'); }, key));
        if (task.state !== 'abandoned' && currentTeam?.control !== 'cancel') {
          group.append(button('安全重试', async () => { await api('/tasks/' + encodeURIComponent(id) + '/retry', 'POST', {}); notice('重试请求已保存。'); }, key));
        }
        controls.append(group); box.append(controls);
      }
      const meta = technical('任务标识与执行目录', 'meta:' + id);
      meta.append(node('p', '任务 ' + task.id + '\n子代理会话 ' + (task.threadId || '尚未派发') + '\n工作目录 ' + (task.cwd || '尚未派发'), 'meta'));
      box.append(meta); showView(); applyLocks();
    } catch (e) {
      if (id === selectedTask && scope === scopeSequence && sequence === detailSequence) {
        if (!lastTask) box.replaceChildren(node('p', '任务详情读取失败：' + e.message, 'error'));
        reportError(e);
      }
    }
  }

  function taskEvidence(id) {
    if (evidence.has(id)) return evidence.get(id);
    if (evidence.size >= 80) { for (const k of evidence.keys()) if (k !== selectedTask) { evidence.delete(k); break; } }
    const result = node('div'), activity = node('div'), tools = node('div', undefined, 'evidence'), log = node('pre', '', 'log');
    log.hidden = true;
    const state = { id, result, activity, log, nextOffset: null, after: 0, loaded: false, busy: false };
    const first = button('读取完整结果', () => loadResult(id, 0), 'result:' + id);
    const next = button('结果下一页', () => loadResult(id, state.nextOffset), 'result:' + id);
    next.dataset.unavailable = 'true';
    tools.append(first, next); result.append(tools, log); state.nextButton = next; evidence.set(id, state);
    renderActivity(state, []);
    return state;
  }
  async function loadResult(id, offset) {
    if (offset === null) return;
    const item = taskEvidence(id), r = await api('/tasks/' + encodeURIComponent(id) + '/result?offset=' + offset + '&limit=8192');
    item.log.hidden = false; item.log.textContent = r.text || '尚无结果内容'; item.nextOffset = r.nextOffset;
    item.nextButton.dataset.unavailable = String(r.nextOffset === null); applyLocks();
  }
  const eventLabels = {
    created: '任务已创建', 'submitted-to-queue': '已进入队列', queued: '任务进入队列',
    'dispatch-intent': '开始派发', dispatching: '正在派发', 'host-started': '子代理已启动',
    started: '开始执行', 'execution-result': '收到执行结果', submitted: '结果已提交',
    checked: '机械检查完成', accepted: '验收已记录', failed: '执行失败', abandoned: '已放弃业务跟进',
    'rework-requested': '已打回返工', 'auto-retry-scheduled': '已安排失败自动重试',
    'snapshot-frozen': '验收字节已冻结', 'host-event': '实时动作', control: '任务控制',
    'state-changed': '状态变化', reconciled: '原运行已核对',
  };
  function renderActivity(item, events) {
    item.activity.replaceChildren(node('p', '以下为进程内引擎与 DeepSeek Harness 子代理的真实记录，按发生顺序显示。', 'hint'));
    for (const event of events) {
      const row = node('div', undefined, 'activity-item'), date = event.at || event.timestamp;
      row.append(node('time', date ? new Date(date).toLocaleString() : '时间未记录'), node('strong', eventLabels[event.type] || event.type || '引擎记录'));
      if (event.state) row.append(node('p', statusLabel(event.state)));
      if (event.message || event.error) row.append(node('p', typeof (event.message || event.error) === 'string' ? event.message || event.error : JSON.stringify(event.message || event.error)));
      const raw = technical('查看事件记录'); raw.append(node('pre', JSON.stringify(event, null, 2), 'log')); row.append(raw);
      item.activity.append(row);
    }
    if (!events.length) item.activity.append(node('p', item.loaded ? '本页暂无活动记录。' : '尚未读取活动记录。', 'hint'));
    const pager = node('div', undefined, 'pager');
    pager.append(button(item.loaded ? '读取后续活动' : '读取活动', () => loadEvents(item.id), 'events:' + item.id));
    item.activity.append(pager);
  }
  async function loadEvents(id) {
    const item = taskEvidence(id); if (item.busy) return;
    item.busy = true; item.id = id;
    try {
      const r = await api('/tasks/' + encodeURIComponent(id) + '/events?after=' + item.after + '&limit=50');
      item.after = r.nextAfter; item.loaded = true; renderActivity(item, r.items || []);
    } finally { item.busy = false; applyLocks(); }
  }

  function renderSources(sources) {
    const scope = selectedTeam; currentSources = sources;
    const signature = scope + JSON.stringify(sources);
    if (signature === lastSources) return;
    lastSources = signature;
    const box = $('source-list'); box.replaceChildren();
    $('source-scope').textContent = scope === LEGACY ? '这些资料属于此前的独立任务。' : '仅显示当前团队资料；其它团队资料与关键约束不会混入。';
    for (const source of sources) {
      const row = node('div', undefined, 'source-row'), text = node('div');
      text.append(node('p', source.label || '未命名资料'));
      if (source.critical) text.append(node('p', '关键约束 · 完整保留', 'hint'));
      else if (source.kind === 'ruling') text.append(node('p', '团队决策 (Ruling) · 自动随队内任务附带', 'hint'));
      row.append(text, button('查看原文', () => readOriginal(scope, source.id, 0), 'source-read'));
      box.append(row);
    }
    if (!sources.length) box.append(node('p', '尚无资料。可添加完整原文、团队决策或关键约束。', 'hint'));
    if (scope === LEGACY) {
      const opts = $('source-options'), checked = new Set([...opts.querySelectorAll('input:checked')].map(i => i.value));
      opts.replaceChildren();
      for (const source of sources) {
        const label = node('label', undefined, 'check'), input = node('input');
        input.type = 'checkbox'; input.value = source.id; input.checked = source.critical || checked.has(source.id); input.disabled = source.critical;
        label.append(input, node('span', source.label || source.id)); opts.append(label);
      }
      if (!sources.length) opts.textContent = '暂无资料';
    }
  }
  async function readOriginal(scope, id, offset) {
    const seq = ++sourceSequence; sourcePage = { scope, id, nextOffset: null };
    $('source-viewer').hidden = false; $('source-content').textContent = '正在读取原文…'; $('source-next').disabled = true;
    const r = await api(scopePath(scope) + '/' + encodeURIComponent(id) + '?offset=' + offset + '&limit=8192');
    if (seq !== sourceSequence || scope !== selectedTeam) return;
    sourcePage.nextOffset = r.nextOffset; $('source-content').textContent = r.text;
    $('source-location').textContent = '原文 ' + id + ' · UTF-8 字节 ' + r.offset + ' / ' + r.totalBytes + ' · SHA-256 ' + r.sha256;
    $('source-next').disabled = r.nextOffset === null;
  }
  function renderDependencies() {
    const dep = $('task-form').elements.dependency, old = dep.value;
    dep.replaceChildren(new Option('无依赖', ''));
    for (const t of currentTasks) dep.add(new Option(t.title || t.id, t.id));
    dep.value = old;
  }

  async function refreshDshSessionStatus() {
    const statusEl = $('dsh-session-status'), bindBtn = $('dsh-bind-session');
    if (!statusEl) return;
    try {
      const q = activeSessionId ? '?sessionId=' + encodeURIComponent(activeSessionId) : '';
      const snap = await api('/dsh/session' + q);
      const teamBound = currentTeam?.sessionId || null;
      const effSession = snap.activeSessionId || activeSessionId || null;
      if (snap.available) {
        statusEl.className = 'hint';
        statusEl.textContent = `当前活跃会话：${effSession || '自动识别'}${snap.provider && snap.model ? ` · 主路由 ${snap.provider}/${snap.model}` : ''}${snap.cwd ? ` · 工作区 ${snap.cwd}` : ''}` + (teamBound ? `\n当前团队已绑定会话：${teamBound}` : '\n当前团队将在启动时自动挂载到活跃根会话。');
      } else {
        statusEl.className = 'error';
        statusEl.textContent = '当前尚未检测到活跃主聊天会话。请先在左侧新建或打开一个聊天窗口，再启动团队执行。';
      }
      if (bindBtn) {
        bindBtn.dataset.unavailable = String(!currentTeam || !effSession);
        applyLocks();
      }
    } catch (e) {
      statusEl.className = 'error';
      statusEl.textContent = e.message;
    }
  }

  function handleLiveEvent(eventName, payload) {
    if (eventName === 'change') scheduleSseRefresh();
    else if (eventName === 'approval') { loadApprovals(); scheduleSseRefresh(); }
    else if (eventName === 'open-workbench') {
      const targetSid = typeof payload?.sessionId === 'string' && payload.sessionId.trim() ? payload.sessionId.trim() : null;
      const mySid = typeof activeSessionId === 'string' && activeSessionId.trim() ? activeSessionId.trim() : null;
      const matched = targetSid ? (Boolean(mySid) && mySid === targetSid) : !mySid;
      if (!matched) return;
      if (payload?.teamId && payload.teamId !== selectedTeam) changeTeam(payload.teamId);
      if (typeof options.onOpenWorkbench === 'function') options.onOpenWorkbench(payload);
    } else if (eventName === 'activity' && payload?.taskId && payload?.text) {
      if (liveActivities.size >= 200 && !liveActivities.has(payload.taskId)) {
        const oldest = liveActivities.keys().next().value;
        if (oldest) liveActivities.delete(oldest);
      }
      liveActivities.set(payload.taskId, payload.text);
      const el = root.querySelector(`[data-live-task="${payload.taskId}"]`);
      if (el) el.textContent = payload.text;
      if (selectedTask === payload.taskId && $('task-live')) $('task-live').textContent = payload.text;
    }
  }

  function scheduleSseRefresh() {
    clearTimeout(sseDebounce);
    sseDebounce = setTimeout(() => { if (!locks.size && !disposed) refresh(); }, 120);
  }

  function stopStream() {
    clearTimeout(streamRetryTimer);
    clearInterval(changePollTimer);
    changePollTimer = null;
    if (streamAbort) { try { streamAbort.abort(); } catch {} streamAbort = null; }
    streamConnected = false;
  }
  function restartStream() { stopStream(); connectStream(); }

  function startChangesPoll() {
    if (changePollTimer || disposed) return;
    streamConnected = true;
    changePollTimer = setInterval(async () => {
      if (disposed || document.hidden) return;
      try {
        const qs = new URLSearchParams({ since: String(lastChangeSeq) });
        if (activeSessionId) qs.set('sessionId', activeSessionId);
        const res = await api('/changes?' + qs.toString());
        if (typeof res.seq === 'number') {
          const prev = lastChangeSeq;
          lastChangeSeq = res.seq;
          if (prev > 0 && Array.isArray(res.items)) {
            for (const item of res.items) handleLiveEvent(item.event, item.payload);
          }
        }
      } catch {}
    }, 1200);
  }

  async function connectStream() {
    if (disposed || streamAbort || document.hidden) return;
    if (isCustomScheme) {
      startChangesPoll();
      return;
    }
    const controller = new AbortController();
    streamAbort = controller;
    try {
      const headers = token ? { 'x-engine-token': token } : {};
      const streamUrl = activeSessionId
        ? `${apiBase}/api/stream?sessionId=${encodeURIComponent(activeSessionId)}`
        : `${apiBase}/api/stream`;
      const res = await fetch(streamUrl, { headers, cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!res.ok || !res.body) { streamConnected = false; throw new Error('SSE unavailable'); }
      streamConnected = true;
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buffer = '', eventName = 'message';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) { eventName = 'message'; continue; }
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            try {
              const payload = JSON.parse(line.slice(5).trim());
              if (eventName === 'ready' && typeof payload.seq === 'number') lastChangeSeq = payload.seq;
              else handleLiveEvent(eventName, payload);
            } catch {}
          }
        }
      }
    } catch {}
    finally {
      if (streamAbort === controller) { streamAbort = null; streamConnected = false; }
      if (!disposed && !controller.signal.aborted && !document.hidden && !streamAbort) {
        clearTimeout(streamRetryTimer);
        streamRetryTimer = setTimeout(connectStream, 3000);
      }
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (disposed) return;
    const base = streamConnected ? 4500 : 2500;
    const delay = connectionProblem ? Math.min(10000, 2500 * 2 ** reconnectAttempt++) : base;
    if (!connectionProblem) reconnectAttempt = 0;
    refreshTimer = setTimeout(() => {
      if (disposed) return;
      if (locks.size || document.hidden && !connectionProblem) scheduleRefresh();
      else refresh();
    }, delay);
  }
  function refresh(force = false) {
    clearTimeout(refreshTimer);
    if (disposed) return Promise.resolve();
    if (refreshFlight) { refreshAgain = refreshAgain || force; return refreshFlight; }
    refreshFlight = (async () => {
      do { refreshAgain = false; await refreshOnce(force); force = true; } while (refreshAgain && !disposed);
    })().finally(() => { refreshFlight = null; scheduleRefresh(); });
    return refreshFlight;
  }

  async function refreshOnce(force = false) {
    const seq = ++refreshSequence, scope = scopeSequence;
    try {
      const statusHeaders = selectedTeam === LEGACY ? {} : { 'x-summary-only': '1' };
      const [status, listing] = await Promise.all([api('/status', 'GET', undefined, statusHeaders), api('/teams')]);
      if (disposed || seq !== refreshSequence || scope !== scopeSequence) return;
      if (typeof status.seq === 'number' && lastChangeSeq === 0) lastChangeSeq = status.seq;
      const teams = listing.teams || [], adapter = status.health?.adapter, scheduler = status.health?.scheduler;
      if (scheduler?.maxConcurrent && $('concurrency-select') && !locks.has('settings')) $('concurrency-select').value = String(scheduler.maxConcurrent);
      const label = {
        connected: 'Harness 已就绪',
        connecting: '正在等待 Harness 子代理服务',
        reconnecting: '正在重连 Harness',
        disconnected: 'Harness 未连接',
        closed: '引擎已关闭',
      }[adapter?.state] || 'Harness 状态未知';
      connectionError('');
      renderSystemHealth(status.health?.systemHealthBanner);
      const slotsText = scheduler?.maxConcurrent ? ' · 并发 ' + (scheduler.activeSlots ?? 0) + '/' + scheduler.maxConcurrent : '';
      $('connection').textContent = label + slotsText + (scheduler?.pendingReconciliations ? ' · ' + scheduler.pendingReconciliations + ' 项待核对' : '');
      $('connection').classList.toggle('offline', adapter?.state !== 'connected');
      if (status.health?.pendingApprovals || pendingApprovals.length) loadApprovals();
      if (!selectedTeam && teams.length) {
        const firstActive = teams.find(t => !t.archived) || teams[0];
        selectedTeam = firstActive.id; restoreSourceDraft();
      }
      renderSwitcher(teams);
      if (!selectedTeam) {
        $('overview').innerHTML = emptyOverview;
        $('workbench').hidden = true;
        if ($('dsh-session-panel')) $('dsh-session-panel').hidden = true;
        return;
      }
      let team, sources;
      if (selectedTeam === LEGACY) {
        const full = status.tasks ? status : await api('/status');
        if (seq !== refreshSequence || scope !== scopeSequence) return;
        currentTasks = taskList(full.tasks).filter(t => !t.teamId); sources = full.sources || []; currentTeam = null;
      } else {
        const responses = await Promise.all([api('/teams/' + encodeURIComponent(selectedTeam)), api(scopePath())]);
        if (seq !== refreshSequence || scope !== scopeSequence) return;
        team = responses[0]; sources = Array.isArray(responses[1]) ? responses[1] : responses[1].sources || [];
        currentTeam = team; currentTasks = taskList(team.tasks);
      }
      if (seq !== refreshSequence || scope !== scopeSequence) return;
      for (const t of currentTasks) if (!['running', 'dispatching'].includes(t.state)) liveActivities.delete(t.id);
      $('workbench').hidden = false;
      $('legacy-tools').hidden = selectedTeam !== LEGACY;
      if ($('dsh-session-panel')) $('dsh-session-panel').hidden = selectedTeam === LEGACY;
      const snapshot = JSON.stringify([selectedTeam, currentTeam, currentTasks]);
      if (force || snapshot !== lastShell) {
        lastShell = snapshot;
        renderOverview(); renderMembers(); renderMemberHeading();
        if (selectedTeam === LEGACY) renderDependencies();
      }
      renderSources(sources);
      if ($('dsh-session-panel')?.open) refreshDshSessionStatus();
      await loadDetail(); applyLocks();
    } catch (e) {
      if (seq !== refreshSequence || scope !== scopeSequence) return;
      reportError(e);
    }
  }

  function addMember(preset = null) {
    const container = $('member-fields'); if (container.children.length >= 12) return;
    const row = node('div', undefined, 'member-fields'), top = node('div', undefined, 'fields-top');
    for (const [name, label] of [['name', '成员名称'], ['role', '角色']]) {
      const field = node('label', label), input = node('input');
      input.name = name; input.required = true; input.maxLength = name === 'name' ? 100 : 120;
      if (preset?.[name]) input.value = preset[name];
      field.append(input); top.append(field);
    }
    const diffField = node('label', '难度'), diffSelect = node('select'); diffSelect.name = 'difficulty';
    const targetDiff = preset?.difficulty || 'medium';
    for (const [val, lbl] of [['low', '简单'], ['medium', '一般'], ['high', '复杂']]) {
      const o = new Option(lbl, val); if (val === targetDiff) o.selected = true; diffSelect.add(o);
    }
    diffField.append(diffSelect); top.append(diffField);
    const remove = button('移除', () => { if (container.children.length > 1) { row.remove(); createRequest = null; updateMemberControls(); } }, null, 'quiet');
    remove.dataset.removeMember = ''; remove.setAttribute('aria-label', '移除此成员'); top.append(remove);
    const field = node('label', '具体职责与交付'), input = node('textarea');
    input.name = 'responsibility'; input.required = true; input.rows = 2;
    if (preset?.responsibility) input.value = preset.responsibility;
    field.append(input); row.append(top, field); container.append(row); createRequest = null; updateMemberControls();
  }
  function applyTeamTemplate(key) {
    const tpl = TEAM_TEMPLATES[key]; if (!tpl) return;
    const form = $('team-form');
    const teamNameInput = form.querySelector(':scope > label input[name="name"]');
    if (teamNameInput && !teamNameInput.value.trim()) teamNameInput.value = tpl.name;
    $('member-fields').replaceChildren();
    for (const m of tpl.members) addMember(m);
    createRequest = null; $('create-error').hidden = true;
  }
  function updateMemberControls() {
    $('add-member').disabled = $('member-fields').children.length >= 12;
    for (const b of $('member-fields').querySelectorAll('[data-remove-member]')) b.disabled = $('member-fields').children.length <= 1;
  }

  $('toggle-theme').addEventListener('click', () => {
    const next = themeOrder[(themeOrder.indexOf(themePreference) + 1) % themeOrder.length];
    applyTheme(next);
  });
  $('team-templates').addEventListener('click', e => {
    const btn = e.target.closest('[data-template]');
    if (btn) applyTeamTemplate(btn.dataset.template);
  });
  $('toggle-audit').addEventListener('click', () => {
    auditMode = !auditMode;
    shellEl.dataset.audit = auditMode ? 'on' : 'off';
    if (!isShadow) document.body.dataset.audit = auditMode ? 'on' : 'off';
    $('toggle-audit').setAttribute('aria-pressed', String(auditMode));
    refresh(true);
  });
  $('concurrency-select').addEventListener('change', e => {
    const value = Number(e.target.value);
    action('settings', async () => { await api('/settings', 'POST', { maxConcurrent: value }); notice('并发执行数已更新为 ' + value + '。'); });
  });
  $('team-filter').addEventListener('input', () => renderSwitcher(allTeams));
  $('show-archived').addEventListener('change', () => renderSwitcher(allTeams));
  $('team-select').addEventListener('change', e => changeTeam(e.target.value));
  if ($('dsh-session-panel')) {
    $('dsh-session-panel').addEventListener('toggle', () => { if ($('dsh-session-panel').open) refreshDshSessionStatus(); });
    $('dsh-refresh-session').addEventListener('click', () => refreshDshSessionStatus());
    $('dsh-bind-session').dataset.lock = 'dsh-bind';
    $('dsh-bind-session').addEventListener('click', () => action('dsh-bind', async () => {
      if (!currentTeam) return;
      const snap = await api('/dsh/session' + (activeSessionId ? '?sessionId=' + encodeURIComponent(activeSessionId) : ''));
      const sid = activeSessionId || snap.activeSessionId;
      if (!sid) throw new Error('未检测到可绑定的活跃主聊天会话');
      const rebound = await api('/teams/' + encodeURIComponent(currentTeam.id) + '/rebind-session', 'POST', { sessionId: sid });
      const wokenCount = Array.isArray(rebound?.wokenTaskIds) ? rebound.wokenTaskIds.length : 0;
      notice(wokenCount ? `已将当前活跃会话挂载到该团队，并唤醒 ${wokenCount} 项因原会话离线阻断的任务。` : '已将当前活跃会话挂载到该团队。');
      await refreshDshSessionStatus();
      await refresh(true);
    }));
  }
  function syncWorkspaceModeField() {
    const modeSelect = $('team-workspace-mode');
    const repoField = $('team-repo-path-field');
    const repoInput = $('team-repo-path');
    if (!modeSelect || !repoField || !repoInput) return;
    const isGit = modeSelect.value === 'git-worktree';
    repoField.hidden = !isGit;
    repoInput.required = isGit;
  }
  if ($('team-workspace-mode')) {
    $('team-workspace-mode').addEventListener('change', () => {
      syncWorkspaceModeField();
      createRequest = null;
      $('create-error').hidden = true;
      if ($('team-workspace-mode').value === 'git-worktree' && $('team-repo-path') && !$('team-repo-path').value.trim()) {
        api('/dsh/session' + (activeSessionId ? '?sessionId=' + encodeURIComponent(activeSessionId) : ''))
          .then(snap => { if (snap?.cwd && $('team-repo-path') && !$('team-repo-path').value.trim()) $('team-repo-path').value = snap.cwd; })
          .catch(() => {});
      }
    });
  }
  $('new-team').addEventListener('click', () => { syncWorkspaceModeField(); $('team-dialog').showModal(); });
  $('close-dialog').addEventListener('click', () => { $('team-dialog').close(); });
  $('add-member').addEventListener('click', () => addMember());
  $('team-form').addEventListener('input', () => { createRequest = null; $('create-error').hidden = true; });
  $('team-form').addEventListener('submit', async event => {
    event.preventDefault(); if (locks.has('create')) return;
    const form = event.currentTarget, data = new FormData(form);
    const diffEntries = [];
    const members = [...$('member-fields').children].map(row => {
      const item = Object.fromEntries([...row.querySelectorAll('input,textarea')].map(input => [input.name, input.value.trim()]));
      const diff = row.querySelector('select[name=difficulty]')?.value || 'medium';
      diffEntries.push([item.name, diff]);
      return item;
    });
    const workspaceMode = (data.get('workspaceMode') || 'isolated').trim();
    const repoPath = (data.get('repoPath') || '').trim();
    if (workspaceMode === 'git-worktree' && !repoPath) {
      $('create-error').textContent = '选择 Git 仓库 Worktree 模式时必须填写本地 Git 仓库根目录绝对路径。';
      $('create-error').hidden = false;
      return;
    }
    createRequest ??= crypto.randomUUID();
    const payload = {
      requestId: createRequest,
      name: data.get('name').trim(),
      goal: data.get('goal').trim(),
      members,
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      ...(workspaceMode === 'git-worktree' ? { workspaceMode: 'git-worktree', repoPath } : {}),
    };
    const controls = [...form.querySelectorAll('input,textarea,select,button')];
    locks.add('create'); controls.forEach(e => { e.disabled = true; });
    try {
      const r = await api('/teams', 'POST', payload), team = r.team || r;
      memberDifficulties.set(team.id, new Map(diffEntries));
      changeTeam(team.id); $('team-dialog').close(); form.reset(); syncWorkspaceModeField(); createRequest = null;
      $('member-fields').replaceChildren(); addMember(); addMember();
      notice(workspaceMode === 'git-worktree'
        ? 'Git Worktree 团队已保存为筹备状态（已锁定基线提交，不会改动当前分支）。确认职责后点击“创建成员任务并开始”。'
        : '团队已保存为筹备状态。确认职责后，点击“创建成员任务并开始”。');
    } catch (e) {
      $('create-error').textContent = e.message; $('create-error').hidden = false;
    } finally {
      locks.delete('create'); controls.forEach(e => { e.disabled = false; }); updateMemberControls(); syncWorkspaceModeField();
    }
  });
  $('detail-tabs').addEventListener('click', event => { const tab = event.target.closest('[data-view]'); if (tab) { view = tab.dataset.view; showView(); } });
  $('source-next').addEventListener('click', () => { if (sourcePage?.nextOffset !== null && sourcePage) action('source-read', () => readOriginal(sourcePage.scope, sourcePage.id, sourcePage.nextOffset)); });
  $('source-close').addEventListener('click', () => { sourceSequence++; sourcePage = null; $('source-viewer').hidden = true; });
  $('source-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget, scope = selectedTeam, data = new FormData(form);
    action('source-save', async () => {
      await api(scopePath(scope), 'POST', { label: data.get('label'), text: data.get('text'), critical: data.has('critical'), kind: data.get('kind') });
      const unchanged = scope === selectedTeam && form.elements.label.value === data.get('label') && form.elements.text.value === data.get('text') && form.elements.critical.checked === data.has('critical') && form.elements.kind.value === data.get('kind');
      if (unchanged) { sourceDrafts.delete(scope); form.reset(); }
      lastSources = '';
      notice('资料已保存到当前范围。关键约束与团队决策会自动进入后续新任务。');
    });
  });
  $('source-form').querySelector('button[type=submit]').dataset.lock = 'source-save';
  $('task-form').addEventListener('input', () => { latestTaskRequest = null; });
  $('task-form').querySelector('button[type=submit]').dataset.lock = 'task-create';
  $('task-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    latestTaskRequest ??= crypto.randomUUID();
    const path = data.get('checkPath').trim(), value = data.get('checkValue');
    const checks = path ? [{ type: value ? 'file_contains' : 'file_exists', path, ...(value ? { value } : {}) }] : [];
    const payload = {
      requestId: latestTaskRequest,
      title: data.get('title'),
      goal: data.get('goal'),
      difficulty: data.get('difficulty'),
      dependsOn: data.get('dependency') ? [data.get('dependency')] : [],
      sourceIds: [...$('source-options').querySelectorAll('input:checked')].map(input => input.value),
      checks,
    };
    action('task-create', async () => {
      const t = await api('/tasks', 'POST', payload);
      latestTaskRequest = null;
      if (selectedTeam === LEGACY) { selectedMember = t.id; selectedTask = t.id; lastTask = ''; }
      notice('独立任务已保存。');
    });
  });

  const onVisibilityChange = () => {
    if (disposed) return;
    if (document.hidden) stopStream();
    else { refresh(); connectStream(); }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  addMember(); addMember();
  await refresh();
  connectStream();

  return {
    setSessionId(nextSessionId) {
      if (typeof nextSessionId === 'string' && nextSessionId.trim()) {
        const clean = nextSessionId.trim();
        const changed = clean !== activeSessionId;
        activeSessionId = clean;
        api('/dsh/session', 'POST', { sessionId: activeSessionId }).catch(() => {});
        if (changed && !disposed) restartStream();
      }
    },
    selectTeam(teamId) {
      if (teamId && teamId !== selectedTeam) changeTeam(teamId);
    },
    getSelectedTeam() {
      return selectedTeam;
    },
    refresh: () => refresh(true),
    dispose() {
      disposed = true;
      clearTimeout(refreshTimer);
      clearTimeout(sseDebounce);
      stopStream();
      hostThemeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

if (typeof document !== 'undefined' && document.getElementById('sa-shell')) {
  mountSuperAgentWorkbench(document).catch(err => console.error('SuperAgent Workbench boot failed:', err));
}
