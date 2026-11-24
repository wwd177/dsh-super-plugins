import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../packages/super-teams/src/engine/engine.mjs';
import { ContextStore } from '../packages/super-teams/src/engine/context.mjs';
import { DshAdapter } from '../packages/super-teams/src/engine/dsh-adapter.mjs';
import { createStandaloneDshServer } from '../packages/super-teams/src/engine/dsh-http.mjs';

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
    }
    return { status: 'completed', text: `## 交付摘要\n已完成 **${task.title}**`, usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 } };
  },
});

const engine = new Engine({ dataDir, adapter, contextStore });
await engine.initialize();
const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../packages/super-teams/public');
const { server, token } = createStandaloneDshServer({ engine, contextStore, adapter, publicDir });
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const baseUrl = `http://127.0.0.1:${server.address().port}/superagent-engine/`;

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

  assert.equal(errors.length, 0, `Unexpected runtime exceptions: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ passed: true, checksCount: checks.length, checks }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  try { chrome.kill(); } catch {}
  await new Promise(ok => server.close(ok));
  await engine.close();
  await adapter.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
