import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { DshAdapter } from '../packages/super-teams/src/engine/dsh-adapter.mjs';
import { createDshEngineRouter, createStandaloneDshServer } from '../packages/super-teams/src/engine/dsh-http.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-smoke-'));
const dataDir = path.join(tempRoot, 'data');
const contextStore = new ContextStore(path.join(dataDir, 'context'));
const runs = [];
const adapter = new DshAdapter({
  mockRunner: async (task, { onEvent }) => {
    runs.push(task);
    onEvent({ method: 'item/started', params: { item: { type: 'toolCall', name: 'str_replace_editor' } } });
    if (task.checks?.some(c => c.path === 'shared/api/spec.json')) {
      fs.mkdirSync(path.join(task.cwd, 'shared/api'), { recursive: true });
      fs.writeFileSync(path.join(task.cwd, 'shared/api/spec.json'), JSON.stringify({ version: 1, endpoints: ['/v1/items'] }));
    } else if (task.checks?.some(c => c.path === 'shared/api/types.ts')) {
      fs.mkdirSync(path.join(task.cwd, 'shared/api'), { recursive: true });
      fs.writeFileSync(path.join(task.cwd, 'shared/api/types.ts'), 'export interface Item { id: string; }\n');
    } else if (task.checks?.some(c => c.path === 'src/impl.md')) {
      fs.mkdirSync(path.join(task.cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(task.cwd, 'src/impl.md'), `# Result\n${task.reworkFeedback ? 'Revised: ' + task.reworkFeedback : 'Initial draft'}\n`);
    } else if (task.checks?.some(c => c.path === 'src/git-feature.txt')) {
      fs.mkdirSync(path.join(task.cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(task.cwd, 'src/git-feature.txt'), 'git-worktree-ui-verified\n');
    }
    return { status: 'completed', text: `## 交付摘要\n已完成 **${task.title}**`, usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 } };
  },
});

const engine = new Engine({ dataDir, adapter, contextStore });
await engine.initialize();
const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../packages/super-teams/public');
const clientJsSource = fs.readFileSync(path.resolve(publicDir, '../client.js'), 'utf8');
const { server, token } = createStandaloneDshServer({ engine, contextStore, adapter, publicDir });
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const baseUrl = `http://127.0.0.1:${server.address().port}/superagent-engine/`;

// Dedicated fenced-mode server mirroring real DeepSeek Harness webServer router for client.js dual-chat E2E test
const fencedRouter = createDshEngineRouter({ engine, contextStore, adapter, publicDir, basePrefix: '/superagent-engine', fence: () => true });
const fencedServer = http.createServer((req, res) => {
  if (req.url === '/host-harness') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><base href="/"></head><body><div id="host-root"></div></body></html>');
    return;
  }
  return fencedRouter.handler(req, res);
});
await new Promise(ok => fencedServer.listen(0, '127.0.0.1', ok));
const fencedOrigin = `http://127.0.0.1:${fencedServer.address().port}`;

const chromeCandidates = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const browserBin = chromeCandidates.find(p => fs.existsSync(p));
assert(browserBin, 'No Chrome or Edge binary found for headless smoke');

const chrome = spawn(browserBin, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${path.join(tempRoot, 'profile')}`,
  'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

const checks = [];
const errors = [];
let socket;

try {
  const endpoint = await new Promise((ok, fail) => {
    let log = '';
    const timer = setTimeout(() => fail(new Error('Browser startup timeout')), 20000);
    chrome.stderr.on('data', chunk => {
      log += chunk;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    chrome.on('error', fail);
  });

  socket = new WebSocket(endpoint);
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', fail, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const m = JSON.parse(String(event.data));
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.fail(new Error(m.error.message)) : p.ok(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });
  const rpc = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++seq;
    const timer = setTimeout(() => fail(new Error('CDP timeout ' + method)), 20000);
    pending.set(id, { ok, fail, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await rpc('Target.createTarget', { url: baseUrl });
  const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
  await rpc('Page.enable', {}, sessionId);
  await rpc('Runtime.enable', {}, sessionId);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1320, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  const evaluate = async expression => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async expression => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(ok => setTimeout(ok, 90));
    }
    throw new Error('UI condition timeout: ' + expression);
  };

  // 1. Standalone DSH connection status & honest empty state
  await until("document.querySelector('#connection')?.textContent.includes('Harness 已就绪')");
  assert.ok(await evaluate("document.querySelector('#overview').textContent.includes('DeepSeek Harness')"));
  checks.push('dsh_ready_banner_and_empty_state');

  // 2. Scientific team templates populate modal cleanly
  await evaluate("document.querySelector('#new-team').click(); document.querySelector('[data-template=\"delivery\"]').click();");
  assert.equal(await evaluate("document.querySelectorAll('#member-fields .member-fields').length"), 3);
  assert.equal(await evaluate("document.querySelector('#team-form input[name=name]').value"), '研发交付团队');
  await evaluate("document.querySelector('#close-dialog').click()");
  checks.push('scientific_team_templates_populate_form');

  // 3. Prepare a multi-wave DAG team with scope overlap (runtime mutex banner) + behavioral node_test autoAccept + batch accept_checked
  const dagTeam = engine.createTeam({
    requestId: 'smoke-dag-' + randomUUID(),
    name: 'DSH 波次验证团队',
    goal: '验证关键路径波次图、运行时写入范围互斥锁、行为测试自动验收与返工',
    sessionId: 'dsh-session-demo',
    members: [
      { name: '架构师', role: '架构设计', responsibility: '生成 shared/api/spec.json' },
      { name: '后端开发', role: '核心开发', responsibility: '生成 src/impl.md' },
      { name: '样式微调', role: '前端开发', responsibility: '同目录写入以验证互斥锁与重叠横幅' },
    ],
    tasks: [
      {
        key: 'spec',
        member: '架构师',
        title: '编写接口契约',
        goal: '输出 shared/api/spec.json',
        priority: 'critical',
        writeScopes: ['shared/api'],
        autoAccept: true,
        checks: [{
          type: 'node_test',
          path: 'shared/api/spec.json',
          testScript: 'const fs = require("fs"); const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (j.version !== 1 || !Array.isArray(j.endpoints)) process.exit(1);',
        }],
      },
      {
        key: 'parallel',
        member: '样式微调',
        title: '并行共享目录修改',
        goal: '验证运行时互斥锁排队',
        writeScopes: ['shared/api/types.ts'],
        checks: [{ type: 'file_contains', path: 'shared/api/types.ts', value: 'export interface Item' }],
      },
      {
        key: 'impl',
        member: '后端开发',
        title: '实现核心文档',
        goal: '输出 src/impl.md',
        dependsOn: ['spec'],
        writeScopes: ['src/impl.md'],
        checks: [{ type: 'file_contains', path: 'src/impl.md', value: '# Result' }],
      },
    ],
  });

  await evaluate(`document.querySelector('#team-select').value=${JSON.stringify(dagTeam.id)}; document.querySelector('#team-select').dispatchEvent(new Event('change'));`);
  await until("document.querySelector('#overview').textContent.includes('执行波次图 · 2 个波次')");
  assert.ok(await evaluate("document.querySelector('#overview').textContent.includes('写入范围互斥锁')"));
  checks.push('wave_dag_and_runtime_mutex_banner_visible');

  // 4. Resume team -> Wave 1 serializes overlapping 'shared/api' tasks & autoAccepts 'spec' via node_test -> Wave 2 runs 'impl' -> '一键验收已通过（2）' button appears!
  await engine.teamControl(dagTeam.id, 'resume');
  await until("[...document.querySelectorAll('#overview button')].some(b => b.textContent.includes('一键验收已通过'))");
  checks.push('behavioral_auto_accept_and_mutex_unlock_wave2');

  // 5. Inspect task detail: durationMs, token usage, file preview, rework form
  const implTask = engine.getTeam(dagTeam.id).tasks.find(t => t.title === '实现核心文档');
  await evaluate(`document.querySelector('[data-member-id="${implTask.memberId}"]').click()`);
  await until("document.querySelector('#detail').textContent.includes('tokens') && document.querySelectorAll('.file-chip').length > 0");
  await evaluate("document.querySelector('.file-chip').click()");
  await until("document.querySelector('.file-preview-box') && !document.querySelector('.file-preview-box').hidden && document.querySelector('.file-preview-box').textContent.includes('Initial draft')");
  checks.push('usage_tokens_and_markdown_file_preview_work');

  // 6. Batch accept checked tasks -> 100% progress
  await evaluate("[...document.querySelectorAll('#overview button')].find(b => b.textContent.includes('一键验收已通过')).click()");
  await until("document.querySelector('#overview').textContent.includes('3 / 3 已验收')");
  checks.push('batch_accept_checked_completes_team');

  // 7. Theme switching (dark / light) + error card contrast + responsive widths (1320, 420, 390)
  await evaluate("document.querySelector('#toggle-theme').click()"); // auto -> dark
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
  await evaluate("document.querySelector('#toggle-theme').click()"); // dark -> light
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'light');
  for (const width of [1320, 420, 390]) {
    await rpc('Emulation.setDeviceMetricsOverride', { width, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
    await new Promise(ok => setTimeout(ok, 120));
    const overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
    assert.ok(overflow <= 1, `Expected zero horizontal overflow at ${width}px, got +${overflow}px`);
  }
  checks.push('theme_toggle_and_zero_overflow_at_1320_420_390');

  // 8. Shadow DOM Embedded Sidebar Mode (exact client.js ShadowRoot host at 400px sidebar width + host .dark sync!)
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
  const shadowOk = await evaluate(`(async () => {
    localStorage.removeItem('superagent-dsh-theme');
    delete document.documentElement.dataset.theme;
    document.body.innerHTML = '<div id="dsh-mock-sidebar"></div>';
    const host = document.getElementById('dsh-mock-sidebar');
    host.style.width = '400px';
    host.style.maxWidth = '400px';
    host.style.height = '780px';
    host.style.overflow = 'hidden';
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    const shadow = host.attachShadow({ mode: 'open' });
    const [css, html] = await Promise.all([
      fetch('/superagent-engine/style.css').then(r => r.text()),
      fetch('/superagent-engine/template.html').then(r => r.text()),
    ]);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
    shadow.innerHTML = html;
    const mod = await import('/superagent-engine/app.js');
    const ctrl = await mod.mountSuperAgentWorkbench(shadow, {
      apiBase: '/superagent-engine',
      token: ${JSON.stringify(token)},
      sessionId: 'dsh-sidebar-session-99',
      teamId: ${JSON.stringify(dagTeam.id)},
    });
    const hostThemeDark = host.dataset.theme === 'dark';
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    await new Promise(r => setTimeout(r, 60));
    const hostThemeLight = host.dataset.theme === 'light';
    for (const det of shadow.querySelectorAll('#detail details')) det.open = true;
    await new Promise(r => setTimeout(r, 40));
    const shell = shadow.getElementById('sa-shell');
    const scrollW = shell.scrollWidth;
    const clientW = shell.clientWidth;
    const wideEls = [...shadow.querySelectorAll('*')].filter(e => e.getClientRects().length > 0 && e.scrollWidth > clientW + 1).map(e => e.tagName + '#' + e.id + '.' + e.className + ':' + e.scrollWidth + '/' + clientW);
    const noOverflow = scrollW <= clientW + 1 && clientW <= 400;
    const hasOverview = shadow.getElementById('overview').textContent.includes('DSH 波次验证团队');
    ctrl.dispose();
    return { hostThemeDark, hostThemeLight, noOverflow, hasOverview, wideEls };
  })()`);
  assert.deepEqual(shadowOk, { hostThemeDark: true, hostThemeLight: true, noOverflow: true, hasOverview: true, wideEls: [] });
  checks.push('shadow_dom_400px_sidebar_mount_theme_sync_and_container_layout');

  // 9. Real client.js + real app.js + real dsh-http.mjs dual-chat panel isolation regression (A stays on teamA when B opens teamB!)
  const teamA = engine.createTeam({
    requestId: 'dual-chat-a-' + randomUUID(),
    name: '会话A专属团队',
    goal: '验证会话A面板不被会话B串切',
    sessionId: 'chat-A',
    members: [{ name: '成员A', role: '后端', responsibility: '保留在会话A' }],
  });
  const teamB = engine.createTeam({
    requestId: 'dual-chat-b-' + randomUUID(),
    name: '会话B专属团队',
    goal: '验证会话B打开自己团队时仅切B不切A',
    sessionId: 'chat-B',
    members: [{ name: '成员B', role: '前端', responsibility: '在会话B打开' }],
  });
  const teamB2 = engine.createTeam({
    requestId: 'dual-chat-b2-' + randomUUID(),
    name: '会话B二号团队',
    goal: '验证会话B再次切换仍不串切会话A',
    sessionId: 'chat-B',
    members: [{ name: '成员B2', role: '测试', responsibility: '在会话B第二次切换' }],
  });

  const { targetId: dualTargetId } = await rpc('Target.createTarget', { url: `${fencedOrigin}/host-harness` });
  const { sessionId: dualCdpSid } = await rpc('Target.attachToTarget', { targetId: dualTargetId, flatten: true });
  await rpc('Page.enable', {}, dualCdpSid);
  await rpc('Runtime.enable', {}, dualCdpSid);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, dualCdpSid);
  const evalDual = async expression => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, dualCdpSid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const untilDual = async expression => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evalDual(expression)) return;
      await new Promise(ok => setTimeout(ok, 90));
    }
    throw new Error('Dual-chat UI condition timeout: ' + expression);
  };

  await untilDual("Boolean(document.getElementById('host-root'))");
  await evalDual(`(() => {
    let loaded = null;
    window.__ModuleLoader__ = { load(spec) { loaded = spec; } };
    ${clientJsSource}
    window.__DSH_CLIENT_LOADED__ = loaded;

    // Minimal synchronous React runtime faithfully implementing useRef, useEffect, and createElement for WorkbenchHost
    const mounted = [];
    function mountComponent(Component, props, container) {
      const state = { refs: [], effects: [], cleanups: [] };
      const fakeReact = {
        createElement(type, p, ...children) {
          if (typeof type === 'function') return type(p || {});
          const el = document.createElement(type);
          if (p) {
            for (const [k, v] of Object.entries(p)) {
              if (k === 'ref' && v && typeof v === 'object') v.current = el;
              else if (k === 'style' && v && typeof v === 'object') Object.assign(el.style, v);
              else if (v !== undefined && v !== null) el.setAttribute(k, String(v));
            }
          }
          for (const child of children) {
            if (child instanceof Node) el.append(child);
            else if (typeof child === 'string') el.append(document.createTextNode(child));
          }
          return el;
        },
        useRef(init) { const r = { current: init }; state.refs.push(r); return r; },
        useEffect(fn) { state.effects.push(fn); },
      };
      const el = Component(props, fakeReact);
      container.append(el);
      for (const fn of state.effects) {
        const cleanup = fn();
        if (typeof cleanup === 'function') state.cleanups.push(cleanup);
      }
      const handle = { el, cleanups: state.cleanups };
      mounted.push(handle);
      return handle;
    }

    // Bind React hooks via a current-instance pointer so client.js's shared React reference supports multiple WorkbenchHosts!
    let activeHooks = null;
    const sharedReact = {
      createElement(type, p, ...children) {
        if (typeof type === 'function') return { __fn: type, props: p || {} };
        const el = document.createElement(type);
        if (p) {
          for (const [k, v] of Object.entries(p)) {
            if (k === 'ref' && v && typeof v === 'object') v.current = el;
            else if (k === 'style' && v && typeof v === 'object') Object.assign(el.style, v);
            else if (v !== undefined && v !== null) el.setAttribute(k, String(v));
          }
        }
        for (const child of children) {
          if (child instanceof Node) el.append(child);
          else if (typeof child === 'string') el.append(document.createTextNode(child));
        }
        return el;
      },
      useRef(init) { const r = { current: init }; activeHooks.refs.push(r); return r; },
      useEffect(fn) { activeHooks.effects.push(fn); },
    };

    const openedTargets = [];
    let tabBodyRenderer = null;
    const ctx = {
      commandUi: { register() {} },
      sessions: {
        scope: sid => (sid === 'chat-A' || sid === 'chat-B' ? { id: sid } : undefined),
        subagentAddress: () => undefined,
      },
      uiConversation: {},
      get: () => undefined,
      effect(fn) { const c = fn(); window.__CLEANUPS__ = window.__CLEANUPS__ || []; if (typeof c === 'function') window.__CLEANUPS__.push(c); return c; },
      inject(deps, cb) {
        if (deps.includes('sidebarRightTabs')) {
          cb({
            effect(fn) { const c = fn(); window.__CLEANUPS__ = window.__CLEANUPS__ || []; if (typeof c === 'function') window.__CLEANUPS__.push(c); return c; },
            locale: { register: () => () => {} },
            sidebarRightTabs: { register: () => () => {} },
            slots: {
              inject: (_n, fn) => fn(),
              register: (meta, render) => {
                if (meta?.name === 'sidebar.right.pane.tab') tabBodyRenderer = render;
                return () => {};
              },
            },
            sidebarRight: {
              // Deliberately report chat-A as activeElement's commandTarget to prove chat-B does not hijack chat-A!
              commandTarget: () => ({ sessionId: 'chat-A', host: 'dock' }),
              openTabFromTarget(kind, target) { openedTargets.push({ kind, target }); },
              isExpanded: () => true,
              toggleExpanded() {},
            },
          });
        }
      },
    };

    const plugin = loaded.factory(id => (id === 'react' ? sharedReact : null));
    plugin.apply(ctx);
    window.__OPENED_TARGETS__ = openedTargets;

    function mountSessionPane(domId, sid) {
      const wrap = document.createElement('div');
      wrap.id = domId;
      wrap.style.width = '400px';
      wrap.style.height = '760px';
      wrap.style.display = 'inline-block';
      document.getElementById('host-root').append(wrap);
      const vnode = tabBodyRenderer({ sessionId: sid });
      const hooks = { refs: [], effects: [] };
      activeHooks = hooks;
      const el = vnode.__fn(vnode.props);
      activeHooks = null;
      wrap.append(el);
      for (const fn of hooks.effects) {
        const c = fn();
        if (typeof c === 'function') window.__CLEANUPS__.push(c);
      }
      return el;
    }

    // Pre-focus session A on teamA and mount BOTH panes simultaneously inside the same host window!
    window.__HOST_A__ = mountSessionPane('pane-A', 'chat-A');
    window.__HOST_B__ = mountSessionPane('pane-B', 'chat-B');
  })()`);

  // Wait for both real Shadow DOM workbenches to mount, then explicitly pin pane A on teamA and pane B on dagTeam
  await untilDual("Boolean(window.__HOST_A__.shadowRoot?.querySelector('#team-select')) && Boolean(window.__HOST_B__.shadowRoot?.querySelector('#team-select'))");
  await evalDual(`(() => {
    const selA = window.__HOST_A__.shadowRoot.querySelector('#team-select');
    selA.value = ${JSON.stringify(teamA.id)};
    selA.dispatchEvent(new Event('change'));
    const selB = window.__HOST_B__.shadowRoot.querySelector('#team-select');
    selB.value = ${JSON.stringify(dagTeam.id)};
    selB.dispatchEvent(new Event('change'));
  })()`);
  await untilDual(`window.__HOST_A__.shadowRoot.querySelector('#overview').textContent.includes('会话A专属团队') && window.__HOST_B__.shadowRoot.querySelector('#overview').textContent.includes('DSH 波次验证团队')`);

  // Wait briefly so client.js cold-start cursor finishes initial poll, then fire real server-side open-workbench for chat-B -> teamB
  await new Promise(ok => setTimeout(ok, 300));
  fencedRouter.notifyWorkbenchOpen({ sessionId: 'chat-B', teamId: teamB.id });

  await untilDual("window.__HOST_B__.shadowRoot.querySelector('#overview').textContent.includes('会话B专属团队') && window.__OPENED_TARGETS__.length >= 1");
  // Give A an extra full poll cycle to verify A never receives or executes the switch!
  await new Promise(ok => setTimeout(ok, 2100));
  const dualResult1 = await evalDual(`({
    teamASelected: window.__HOST_A__.shadowRoot.querySelector('#team-select').value,
    teamAOverview: window.__HOST_A__.shadowRoot.querySelector('#overview').textContent.includes('会话A专属团队'),
    teamAHasB: window.__HOST_A__.shadowRoot.querySelector('#overview').textContent.includes('会话B专属团队'),
    teamBSelected: window.__HOST_B__.shadowRoot.querySelector('#team-select').value,
    teamBOverview: window.__HOST_B__.shadowRoot.querySelector('#overview').textContent.includes('会话B专属团队'),
    openedTargets: window.__OPENED_TARGETS__,
  })`);
  assert.equal(dualResult1.teamASelected, teamA.id, 'Pane A must remain strictly on teamA');
  assert.equal(dualResult1.teamAOverview, true, 'Pane A overview must still display teamA');
  assert.equal(dualResult1.teamAHasB, false, 'Pane A must NEVER show teamB');
  assert.equal(dualResult1.teamBSelected, teamB.id, 'Pane B must switch to teamB');
  assert.equal(dualResult1.teamBOverview, true, 'Pane B overview must display teamB');
  assert.ok(dualResult1.openedTargets.every(t => t.target?.sessionId === 'chat-B'), `openTabFromTarget must ONLY target chat-B, got ${JSON.stringify(dualResult1.openedTargets)}`);

  // Fire a second open-workbench for chat-B -> teamB2 to verify repeated switches still keep A locked on teamA
  fencedRouter.notifyWorkbenchOpen({ sessionId: 'chat-B', teamId: teamB2.id });
  await untilDual("window.__HOST_B__.shadowRoot.querySelector('#overview').textContent.includes('会话B二号团队')");
  await new Promise(ok => setTimeout(ok, 300));
  assert.equal(await evalDual("window.__HOST_A__.shadowRoot.querySelector('#team-select').value"), teamA.id, 'Pane A must still stay on teamA after repeated chat-B opens');
  checks.push('real_client_js_dual_chat_workbench_strict_session_isolation');

  // 10. Standard sidebar New Team modal supports Git Worktree mode + Merge Preview & Atomic Branch Publish UI at 400px sidebar width
  const gitRepoDir = path.join(tempRoot, 'ui-git-repo');
  fs.mkdirSync(gitRepoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: gitRepoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'UI Smoke'], { cwd: gitRepoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'uismoke@example.test'], { cwd: gitRepoDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(gitRepoDir, 'README.md'), '# UI Smoke Git Repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: gitRepoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: gitRepoDir, stdio: 'pipe' });

  const gitFormReady = await evalDual(`(async () => {
    const s = window.__HOST_A__.shadowRoot;
    s.querySelector('#new-team').click();
    const mode = s.querySelector('#team-workspace-mode');
    const repoField = s.querySelector('#team-repo-path-field');
    const repoInput = s.querySelector('#team-repo-path');
    const hiddenBefore = repoField.hidden;
    mode.value = 'git-worktree';
    mode.dispatchEvent(new Event('change'));
    const hiddenAfter = repoField.hidden;
    const requiredAfter = repoInput.required;
    repoInput.value = ${JSON.stringify(gitRepoDir)};
    const form = s.querySelector('#team-form');
    form.querySelector(':scope > label input[name="name"]').value = '侧栏Git建队团队';
    form.querySelector('textarea[name="goal"]').value = '验证标准侧栏表单直接创建 Git Worktree 团队并原子发布新分支';
    while (s.querySelectorAll('#member-fields .member-fields').length > 1) {
      const rows = [...s.querySelectorAll('#member-fields .member-fields')];
      rows[rows.length - 1].querySelector('[data-remove-member]').click();
      await new Promise(r => setTimeout(r, 20));
    }
    const row0 = s.querySelector('#member-fields .member-fields');
    row0.querySelector('input[name="name"]').value = 'Git开发者';
    row0.querySelector('input[name="role"]').value = '工程师';
    row0.querySelector('textarea[name="responsibility"]').value = '写入 src/git-feature.txt';
    const valid = form.checkValidity();
    s.querySelector('#create-team').click();
    return { hiddenBefore, hiddenAfter, requiredAfter, valid, membersCount: s.querySelectorAll('#member-fields .member-fields').length };
  })()`);
  assert.deepEqual(gitFormReady, { hiddenBefore: true, hiddenAfter: false, requiredAfter: true, valid: true, membersCount: 1 });

  try {
    await untilDual("window.__HOST_A__.shadowRoot.querySelector('#overview').textContent.includes('侧栏Git建队团队') && window.__HOST_A__.shadowRoot.querySelector('#overview').textContent.includes('Git Worktree')");
  } catch (err) {
    const diag = await evalDual(`({
      createError: window.__HOST_A__.shadowRoot.querySelector('#create-error')?.textContent,
      dialogOpen: window.__HOST_A__.shadowRoot.querySelector('#team-dialog')?.open,
      notice: window.__HOST_A__.shadowRoot.querySelector('#notice')?.textContent,
      overview: window.__HOST_A__.shadowRoot.querySelector('#overview')?.textContent?.slice(0, 200),
      selected: window.__HOST_A__.shadowRoot.querySelector('#team-select')?.value,
    })`);
    throw new Error(`${err.message} | diag=${JSON.stringify(diag)}`);
  }
  const gitTeamId = await evalDual("window.__HOST_A__.shadowRoot.querySelector('#team-select').value");
  const gitTeam = engine.getTeam(gitTeamId);
  assert.equal(gitTeam.workspaceMode, 'git-worktree');
  assert.equal(gitTeam.sessionId, 'chat-A', 'Manual sidebar team creation must bind activeSessionId');
  assert.ok(gitTeam.baseCommit && gitTeam.baseCommit.length >= 7);

  // Submit & accept one git-worktree task, then drive Merge Preview + Atomic Publish directly from the sidebar UI!
  const gitTask = await engine.submit({
    requestId: 'ui-git-task-' + randomUUID(),
    teamId: gitTeam.id,
    memberId: gitTeam.members[0].id,
    title: '实现 Git 特性',
    goal: '创建 src/git-feature.txt',
    writeScopes: ['src/git-feature.txt'],
    checks: [{ type: 'file_contains', path: 'src/git-feature.txt', value: 'git-worktree-ui-verified' }],
  });
  await engine.teamControl(gitTeam.id, 'resume');
  const dlGit = Date.now() + 10000;
  while (Date.now() < dlGit && engine.get(gitTask.id).state !== 'checked') {
    await new Promise(ok => setTimeout(ok, 60));
  }
  assert.equal(engine.get(gitTask.id).state, 'checked');
  await engine.accept(gitTask.id, { expectedRevision: engine.get(gitTask.id).revision, reason: 'UI Git smoke accept' });

  await untilDual("[...window.__HOST_A__.shadowRoot.querySelectorAll('#overview button')].some(b => b.textContent.includes('预览 Git 合并') && b.dataset.unavailable === 'false')");
  await evalDual("[...window.__HOST_A__.shadowRoot.querySelectorAll('#overview button')].find(b => b.textContent.includes('预览 Git 合并')).click()");
  await untilDual("window.__HOST_A__.shadowRoot.querySelector('#notice').textContent.includes('合并预览通过')");
  await evalDual(`(() => {
    const s = window.__HOST_A__.shadowRoot;
    const det = [...s.querySelectorAll('#overview details')].find(d => d.textContent.includes('Git Worktree 合并与分支发布'));
    det.open = true;
    det.querySelector('input[data-merge-branch]').value = 'ui-smoke-branch';
    [...det.querySelectorAll('button')].find(b => b.textContent.includes('原子发布到新分支')).click();
  })()`);
  await untilDual("window.__HOST_A__.shadowRoot.querySelector('#notice').textContent.includes('superagent/ui-smoke-branch')");
  const createdBranches = execFileSync('git', ['branch', '--list', 'superagent/ui-smoke-branch'], { cwd: gitRepoDir, encoding: 'utf8' }).trim();
  assert.match(createdBranches, /superagent\/ui-smoke-branch/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: gitRepoDir, encoding: 'utf8' }).trim(), '', 'Live working tree must remain completely untouched');
  const gitShellOverflow = await evalDual("(() => { const sh = window.__HOST_A__.shadowRoot.getElementById('sa-shell'); return sh.scrollWidth - sh.clientWidth; })()");
  assert.ok(gitShellOverflow <= 1, `Expected <=1px overflow on 400px Git Worktree sidebar, got +${gitShellOverflow}px`);
  await evalDual("(window.__CLEANUPS__ || []).forEach(fn => { try { fn(); } catch {} });");
  checks.push('sidebar_new_team_git_worktree_form_and_merge_preview_apply_ui');

  assert.equal(errors.length, 0, `Unexpected runtime exceptions: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ passed: true, checksCount: checks.length, checks }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  try { chrome.kill(); } catch {}
  await new Promise(ok => server.close(ok));
  await new Promise(ok => fencedServer.close(ok));
  fencedRouter.dispose();
  await engine.close();
  await adapter.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
