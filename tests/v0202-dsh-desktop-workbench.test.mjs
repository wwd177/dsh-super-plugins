import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DshSuperTeamsRuntime, defaultDshEngineDataDir, safeGetCordisService } from '../packages/super-teams/src/runtime.mjs';
import { sendDeliveryExport } from '../packages/super-teams/src/engine/delivery-export.mjs';
import { fetchDelivery } from '../packages/super-teams/public/delivery-download.js';
import * as superTeamsPlugin from '../packages/super-teams/index.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeStrictCordisCtx(services = {}) {
  const ctx = {
    get(name) {
      return services[name];
    },
  };
  for (const name of ['connection', 'profileContext', 'subagents', 'workingDirectory', 'logger', 'webServer', 'skills']) {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      get() {
        throw new Error(`cannot get property "${name}" without inject`);
      },
    });
  }
  return ctx;
}

test('Cordis strict-proxy runtime survives missing injects, tool calls before connection, and binds fence dynamically', async t => {
  const tmpDir = makeTempDir('dsh-v0202-strict-');
  const savedEnv = process.env.DSH_SUPERAGENT_DATA_DIR;
  delete process.env.DSH_SUPERAGENT_DATA_DIR;
  t.after(() => {
    if (savedEnv !== undefined) process.env.DSH_SUPERAGENT_DATA_DIR = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // Strict ctx where `ctx.profileContext` getter throws but `ctx.get('profileContext')` succeeds
  const strictProfileCtx = makeStrictCordisCtx({ profileContext: { home: tmpDir } });
  assert.equal(defaultDshEngineDataDir(strictProfileCtx), path.join(tmpDir, 'plugin-data', 'dsh-super-teams'));

  // Strict ctx where `profileContext` is completely absent (must not throw!)
  const strictEmptyCtx = makeStrictCordisCtx({});
  assert.equal(safeGetCordisService(strictEmptyCtx, 'connection'), undefined);
  assert.ok(defaultDshEngineDataDir(strictEmptyCtx).endsWith(path.join('plugin-data', 'dsh-super-teams')));

  // Simulate webServer booting BEFORE connection and super-teams starting via early tool call
  const registeredTools = new Map();
  let registeredRoute = null;
  const strictPluginCtx = makeStrictCordisCtx({
    logger: { warn() {}, info() {}, error() {} },
    tools: {
      register(def) {
        registeredTools.set(def.name, def);
        return () => registeredTools.delete(def.name);
      },
    },
  });

  // Wire Cordis-like inject behavior that waits for BOTH webServer and connection
  const provided = new Map([['tools', {
    register(def) {
      registeredTools.set(def.name, def);
      return () => registeredTools.delete(def.name);
    },
  }]]);
  const pendingInjects = [];
  const tryFlushInjects = () => {
    for (let i = pendingInjects.length - 1; i >= 0; i--) {
      const item = pendingInjects[i];
      if (item.deps.every(d => provided.has(d))) {
        pendingInjects.splice(i, 1);
        const sub = {
          effect(fn) {
            const c = fn();
            if (typeof c === 'function') cleanups.push(c);
            return c;
          },
        };
        for (const d of item.deps) sub[d] = provided.get(d);
        item.cb(sub);
      }
    }
  };
  const cleanups = [];
  Object.defineProperty(strictPluginCtx, 'tools', { get: () => provided.get('tools') });
  strictPluginCtx.inject = (deps, cb) => {
    pendingInjects.push({ deps, cb });
    tryFlushInjects();
  };
  strictPluginCtx.effect = fn => {
    const c = fn();
    if (typeof c === 'function') cleanups.push(c);
    return c;
  };
  strictPluginCtx.get = name => provided.get(name);

  provided.set('webServer', {
    register(route) {
      registeredRoute = route;
      return () => { registeredRoute = null; };
    },
  });

  superTeamsPlugin.apply(strictPluginCtx, { dataDir: path.join(tmpDir, 'runtime') });
  assert.equal(registeredTools.size, 8);
  assert.equal(registeredRoute, null, 'Route waits until both webServer and connection are available');

  // Execute a tool BEFORE connection is provided -> must succeed without throwing Cordis inject error!
  const earlyOverview = await registeredTools.get('engine_overview').execute({}, { agent: { id: 'sess-early', session: { header: { cwd: tmpDir } } } });
  assert.equal(earlyOverview.total, 0);

  // Now provide connection -> route mounts synchronously & switches existing router to fenced mode
  provided.set('connection', {
    requestRejection: req => (req.headers?.['x-allow'] === 'yes' ? undefined : 403),
  });
  tryFlushInjects();
  assert.ok(registeredRoute, 'Route must register once connection arrives');

  const callHandler = async (url, headers = {}) => {
    let status = 200;
    const outHeaders = {};
    const chunks = [];
    const req = { method: 'GET', url, headers: { host: '127.0.0.1:4567', ...headers }, on() {} };
    const res = {
      headersSent: false,
      setHeader(k, v) { outHeaders[String(k).toLowerCase()] = v; },
      writeHead(code, h = {}) {
        status = code;
        this.headersSent = true;
        for (const [k, v] of Object.entries(h)) outHeaders[String(k).toLowerCase()] = v;
      },
      end(b) { if (b) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b))); },
    };
    await registeredRoute.handler(req, res);
    return { status, headers: outHeaders, text: Buffer.concat(chunks).toString('utf8') };
  };

  assert.equal((await callHandler('/superagent-engine/app.js')).status, 403);
  const jsRes = await callHandler('/superagent-engine/app.js', { 'x-allow': 'yes' });
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers['content-type'], /text\/javascript/);
  const apiRes = await callHandler('/superagent-engine/api/health', { 'x-allow': 'yes' });
  assert.equal(apiRes.status, 200);
  assert.equal(JSON.parse(apiRes.text).host, 'deepseek-harness');

  for (const fn of [...cleanups].reverse()) {
    await fn();
  }
});

test('Delivery ZIP export & fetchDelivery work when Electron forwardWebRequest strips Content-Length', async t => {
  const tmpDir = makeTempDir('dsh-v0202-zip-');
  const rt = new DshSuperTeamsRuntime({
    dataDir: path.join(tmpDir, 'data'),
    mockRunner: async task => {
      fs.mkdirSync(path.join(task.cwd, 'out'), { recursive: true });
      fs.writeFileSync(path.join(task.cwd, 'out/report.txt'), 'verified delivery payload\n', 'utf8');
      return { status: 'completed', text: 'done', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
  });
  await rt.ensureStarted();

  const team = rt.engine.createTeam({
    requestId: 'zip-' + randomUUID(),
    name: 'Electron ZIP Team',
    goal: 'Verify X-Delivery-Bytes fallback',
    members: [{ name: 'Builder', role: 'Dev', responsibility: 'Write out/report.txt' }],
  });
  const sub = rt.engine.submit({
    requestId: 'zip-task-' + randomUUID(),
    teamId: team.id,
    memberId: team.members[0].id,
    title: 'Generate report',
    goal: 'Write out/report.txt',
    writeScopes: ['out/report.txt'],
    autoAccept: true,
    checks: [{
      type: 'node_test',
      path: 'out/report.txt',
      testScript: 'const fs = require("fs"); if (!fs.readFileSync(process.argv[1], "utf8").includes("verified")) process.exit(1);',
    }],
  });
  await rt.engine.teamControl(team.id, 'resume');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && rt.engine.get(sub.id).state !== 'accepted') {
    await new Promise(r => setTimeout(r, 30));
  }
  assert.equal(rt.engine.get(sub.id).state, 'accepted');

  let activeExport = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const m = /^\/(stripped|mismatch)\/api\/teams\/([^/]+)\/delivery\.zip$/.exec(u.pathname);
    if (!m) {
      res.writeHead(404).end();
      return;
    }
    const mode = m[1];
    const teamId = decodeURIComponent(m[2]);
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, h = {}) => {
      const out = {};
      for (const [k, v] of Object.entries(h)) {
        const lk = k.toLowerCase();
        if (mode === 'stripped' && lk === 'content-length') continue;
        out[lk] = lk === 'x-delivery-bytes' && mode === 'mismatch' ? String(Number(v) + 1) : v;
      }
      return origWriteHead(code, out);
    };
    activeExport = sendDeliveryExport({ engine: rt.engine, teamId, req, res });
    await activeExport;
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await activeExport.catch(() => {});
    await new Promise(ok => { server.close(ok); server.closeAllConnections(); });
    await rt.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const downloaded = await fetchDelivery(team.id, { apiBase: `${origin}/stripped` });
  await activeExport;
  assert.equal(downloaded.filename, `team-${team.id}-delivery.zip`);
  assert.ok(downloaded.blob.size > 50, 'Downloaded ZIP blob must contain valid payload even without Content-Length header');

  await assert.rejects(
    () => fetchDelivery(team.id, { apiBase: `${origin}/mismatch` }),
    /下载校验信息不一致/
  );
  await activeExport;
});

test('client.js detects 503/HTML fallback responses, retries with cache-busting query, and exposes reload button', async () => {
  const clientCode = fs.readFileSync(path.resolve('packages/super-teams/client.js'), 'utf8');
  assert.ok(clientCode.includes('const mod = await import(moduleUrl);'), 'Expected dynamic moduleUrl import in client.js');
  const harnessCode = clientCode.replace('const mod = await import(moduleUrl);', 'const mod = await __testImport(moduleUrl);');

  function makeFakeElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {},
      children: [],
      listeners: new Map(),
      _textContent: '',
      _innerHTML: '',
      shadowRoot: null,
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
      click() {
        for (const fn of this.listeners.get('click') || []) fn({ type: 'click' });
      },
      append(...nodes) { this.children.push(...nodes); },
      appendChild(node) { this.children.push(node); return node; },
      replaceChildren(...nodes) { this.children = [...nodes]; this._innerHTML = ''; },
      attachShadow() {
        this.shadowRoot = {
          adoptedStyleSheets: [],
          children: [],
          _innerHTML: '',
          replaceChildren(...nodes) { this.children = [...nodes]; },
          set innerHTML(v) { this._innerHTML = v; this.children = []; },
          get innerHTML() { return this._innerHTML; },
        };
        return this.shadowRoot;
      },
      set textContent(v) { this._textContent = String(v); },
      get textContent() {
        if (this.children.length) return this.children.map(c => c.textContent || '').join(' ');
        return this._textContent;
      },
      set innerHTML(v) { this._innerHTML = v; },
      get innerHTML() { return this._innerHTML; },
    };
    return el;
  }

  let loader;
  let phase = 'auto-recover'; // 0: 503, 1: HTML fallback, 2+: OK; 'manual-recover': always 404 until fixed
  let fetchAttempt = 0;
  const importedSpecifiers = [];
  const mountedCalls = [];
  const cleanups = [];
  let pendingEffects = [];
  let hostEl = null;

  const fakeCssSheet = class CSSStyleSheet {
    replaceSync(text) { this.text = text; }
  };
  const fakeDocument = {
    baseURI: 'dsh-app://app/',
    hidden: false,
    createElement: makeFakeElement,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    URL,
    CustomEvent: class CustomEvent {},
    CSSStyleSheet: fakeCssSheet,
    AbortController,
    fetch: async url => {
      if (String(url).includes('/api/changes')) {
        return { ok: true, json: async () => ({ seq: 0, items: [] }) };
      }
      if (String(url).endsWith('/style.css')) {
        const idx = fetchAttempt++;
        if (phase === 'auto-recover') {
          if (idx === 0) return { ok: false, status: 503, headers: new Headers(), text: async () => '' };
          if (idx === 1) return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }), text: async () => '<html>SPA</html>' };
          return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/css' }), text: async () => 'body{}' };
        }
        if (phase === 'fail-only') {
          return { ok: false, status: 404, headers: new Headers(), text: async () => '' };
        }
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/css' }), text: async () => 'body{}' };
      }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<div id="sa-shell"></div>' };
    },
    window: {
      __ModuleLoader__: { load: val => { loader = val; } },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      setInterval: () => 1,
      clearInterval() {},
    },
    __testImport: async specifier => {
      importedSpecifiers.push(specifier);
      return {
        async mountSuperAgentWorkbench(_shadow, opts) {
          mountedCalls.push(opts);
          return { dispose() {} };
        },
      };
    },
    document: fakeDocument,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(harnessCode, sandbox);

  const fakeReact = {
    createElement(type, props) {
      if (typeof type === 'function') return type(props || {});
      const el = makeFakeElement(type);
      if (props?.ref) props.ref.current = el;
      return el;
    },
    useRef: init => ({ current: init }),
    useEffect: fn => { pendingEffects.push(fn); },
  };
  const mountPane = sid => {
    pendingEffects = [];
    const el = tabRender({ sessionId: sid });
    const stoppers = pendingEffects.map(fn => fn()).filter(fn => typeof fn === 'function');
    return { el, stop: () => stoppers.forEach(fn => fn()) };
  };
  const mod = loader.factory(id => (id === 'react' ? fakeReact : null));
  let tabRender = null;
  mod.apply({
    commandUi: { register() {} },
    sessions: { scope: () => ({ get: () => ({ input: { for: () => ({ actions: { captureInsertion: () => ({}), insertText: () => false }, focus() {} }) } }) }), subagentAddress: () => undefined },
    uiConversation: {},
    get: () => undefined,
    effect: fn => { const c = fn(); if (typeof c === 'function') cleanups.push(c); },
    inject: (deps, cb) => {
      if (deps.includes('sidebarRightTabs')) {
        cb({
          effect: fn => { const c = fn(); if (typeof c === 'function') cleanups.push(c); },
          locale: { register: () => () => {} },
          sidebarRightTabs: { register: () => () => {} },
          slots: {
            inject: (_n, fn) => fn(),
            register: (meta, r) => {
              if (meta.name === 'sidebar.right.pane.tab') tabRender = r;
              return () => {};
            },
          },
          sidebarRight: { commandTarget: () => null, openTabFromTarget() {}, isExpanded: () => false, toggleExpanded() {} },
        });
      }
    },
  });

  // Case 1: automatic retries on 503 -> SPA HTML fallback -> 200 success
  const pane1 = mountPane('sess-1');
  hostEl = pane1.el;
  const dl1 = Date.now() + 5000;
  while (Date.now() < dl1 && mountedCalls.length < 1) await new Promise(r => setTimeout(r, 30));
  assert.equal(mountedCalls.length, 1);
  assert.equal(importedSpecifiers[0], 'dsh-app://app/superagent-engine/app.js?retry=2');
  assert.equal(mountedCalls[0].apiBase, 'dsh-app://app/superagent-engine');
  pane1.stop();

  // Case 2: 3 consecutive 404 failures show final error + working "重新加载" button
  phase = 'fail-only';
  importedSpecifiers.length = 0;
  mountedCalls.length = 0;
  const pane2 = mountPane('sess-2');
  hostEl = pane2.el;
  const dl2 = Date.now() + 5000;
  while (Date.now() < dl2 && !(hostEl.shadowRoot?.children?.[0]?.textContent || '').includes('团队工作台加载失败：style.css HTTP 404')) {
    await new Promise(r => setTimeout(r, 30));
  }
  const errContainer = hostEl.shadowRoot.children[0];
  assert.match(errContainer.textContent, /团队工作台加载失败：style\.css HTTP 404/);
  const reloadBtn = errContainer.children.find(c => c.tagName === 'BUTTON');
  assert.ok(reloadBtn, 'Must render 重新加载 retry button');

  phase = 'recovered';
  reloadBtn.click();
  const dl3 = Date.now() + 3000;
  while (Date.now() < dl3 && mountedCalls.length < 1) await new Promise(r => setTimeout(r, 20));
  assert.equal(mountedCalls.length, 1);
  assert.equal(importedSpecifiers[0], 'dsh-app://app/superagent-engine/app.js?retry=3');
  pane2.stop();

  for (const c of cleanups) c();
});

test('install.mjs hot-upgrade keeps skills clean without .staging leftovers even with active fs.watch and passes --verify', async t => {
  const tmpRoot = makeTempDir('dsh-v0202-install-');
  const dshHome = path.join(tmpRoot, 'dsh-home');
  const profDir = path.join(dshHome, 'profiles', 'desktop');
  const cliDir = path.join(tmpRoot, 'cli');
  const skillsDir = path.join(dshHome, 'skills');
  fs.mkdirSync(profDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify({
    name: 'profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2));

  const runnerPath = path.join(cliDir, 'fake-dsh.mjs');
  fs.writeFileSync(runnerPath, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'plugin') {
  const pIdx = args.indexOf('--profile');
  const profile = pIdx >= 0 ? args[pIdx + 1] : 'desktop';
  const actionIdx = pIdx >= 0 ? pIdx + 2 : 1;
  const action = args[actionIdx];
  const profDir = path.join(process.env.DSH_HOME, 'profiles', profile);
  const pkgFile = path.join(profDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || { profile: { bundles: [] } };
  if (action === 'add') {
    for (const spec of args.slice(actionIdx + 1)) {
      const target = spec.replace(/^(?:file|link):/, '');
      const mPkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
      pkg.dependencies[mPkg.name] = spec;
      if (!pkg.dsh.profile.bundles.includes(mPkg.name)) pkg.dsh.profile.bundles.push(mPkg.name);
    }
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\\n');
  }
}
`, 'utf8');

  let dshCli;
  if (process.platform === 'win32') {
    dshCli = path.join(cliDir, 'dsh.cmd');
    fs.writeFileSync(dshCli, `@echo off\r\n"${process.execPath}" "${runnerPath}" %*\r\n`, 'utf8');
  } else {
    dshCli = path.join(cliDir, 'dsh');
    fs.writeFileSync(dshCli, `#!/bin/sh\nexec "${process.execPath}" "${runnerPath}" "$@"\n`, 'utf8');
    fs.chmodSync(dshCli, 0o755);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installScript = path.join(repoRoot, 'scripts', 'install.mjs');
  const watcher = fs.watch(skillsDir, () => {});
  t.after(() => {
    try { watcher.close(); } catch {}
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  });

  const env = { ...process.env, DSH_HOME: dshHome, DSH_PROFILE: 'desktop', DSH_CLI: dshCli };
  const r1 = JSON.parse(execFileSync(process.execPath, [installScript, '--install', '--json'], { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true }));
  assert.equal(r1.ok, true);

  // Hot-upgrade over existing install with active fs.watch on skillsDir & sub-watcher on superagent-workflow
  const subWatcher = fs.watch(path.join(skillsDir, 'superagent-workflow'), () => {});
  try {
    const r2 = JSON.parse(execFileSync(process.execPath, [installScript, '--install', '--json'], { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true }));
    assert.equal(r2.ok, true);
  } finally {
    try { subWatcher.close(); } catch {}
  }

  const skillEntries = fs.readdirSync(skillsDir);
  assert.equal(skillEntries.some(n => n.startsWith('.staging-')), false, `No .staging-* leftovers allowed in skills/: ${JSON.stringify(skillEntries)}`);
  assert.equal(fs.readdirSync(dshHome).some(n => n.startsWith('.staging-skill-')), false, 'No .staging-skill-* leftovers allowed in dshHome');

  const verifyOut = JSON.parse(execFileSync(process.execPath, [installScript, '--verify', '--json'], { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true }));
  assert.equal(verifyOut.ok, true);
  assert.equal(verifyOut.skills.length, 4);
});
