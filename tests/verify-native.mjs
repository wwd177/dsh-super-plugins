import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

function resolveDshResourcesDir() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.DSH_INSTALL_DIR) {
    const dir = path.resolve(process.env.DSH_INSTALL_DIR);
    candidates.push(path.join(dir, 'resources'), path.join(dir, 'Contents', 'Resources'));
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources'),
      path.join(progFiles, 'DeepSeek Harness', 'resources'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/DeepSeek Harness.app/Contents/Resources',
      path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources'),
    );
  } else {
    candidates.push(
      '/opt/DeepSeek Harness/resources',
      '/opt/deepseek-harness/resources',
      '/usr/lib/deepseek-harness/resources',
      path.join(home, '.local', 'share', 'deepseek-harness', 'resources'),
    );
  }
  for (const resDir of candidates) {
    const base = path.join(resDir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
    try {
      if (fs.existsSync(path.join(base, 'cordis', 'lib', 'index.js'))) return base;
    } catch {}
  }
  throw new Error('Could not locate DeepSeek Harness app.asar (@deepseek-ai/*). Run this test with DeepSeek Harness (ELECTRON_RUN_AS_NODE=1) or set DSH_INSTALL_DIR.');
}

const dshBase = resolveDshResourcesDir();
const native = name => import(pathToFileURL(path.join(dshBase, name, 'lib', 'index.js')).href);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.DSH_PLUGIN_ROOT
  ? path.resolve(process.env.DSH_PLUGIN_ROOT)
  : (fs.existsSync(path.resolve(testDir, '../packages/super-teams/package.json'))
      ? path.resolve(testDir, '../packages')
      : path.resolve(testDir, '..'));

const superTeamsPlugin = await import(pathToFileURL(path.join(pluginRoot, 'super-teams/index.js')).href);
const superAgentPlugin = await import(pathToFileURL(path.join(pluginRoot, 'superagent/index.js')).href);

const { Context } = await native('cordis');
const { default: Tools } = await native('dsh-tools');
const { default: SystemPrompt } = await native('dsh-system-prompt');
const executor = await native('dsh-tool-executor-native');
const { default: SkillService } = await native('dsh-skill');
const { FileSystemSkillProvider } = await native('dsh-skill-filesystem');
const { evaluatePluginCompatibility, getDshRuntimeVersion } = await native('dsh-app-boot');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-universal-'));
const engineDataDir = path.join(tempRoot, 'engine-data');
const workspace = path.join(tempRoot, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

const ctx = new Context();
const signal = new AbortController().signal;
const checks = [];

const registeredRoutes = [];
ctx.provide('connection', true);
ctx.connection = { requestRejection: req => (req.headers?.['x-dsh-allow'] === '1' ? undefined : 'unauthorized') };
ctx.provide('webServer', true);
ctx.webServer = {
  register(spec) {
    registeredRoutes.push(spec);
    return () => {
      const idx = registeredRoutes.indexOf(spec);
      if (idx >= 0) registeredRoutes.splice(idx, 1);
    };
  },
};

ctx.plugin(SystemPrompt, {});
ctx.plugin(SkillService);
ctx.plugin(Tools);
ctx.plugin(executor);
ctx.plugin(superAgentPlugin);
ctx.plugin(superTeamsPlugin, { dataDir: engineDataDir });
await new Promise(resolve => setTimeout(resolve, 140));

try {
  // 0. Verify universal compatibility range & locale/icon resources against actual DSH runtime
  const runtimeVer = getDshRuntimeVersion();
  for (const pkgDir of ['superagent', 'super-teams']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, pkgDir, 'package.json'), 'utf8'));
    const compat = evaluatePluginCompatibility(manifest, runtimeVer);
    assert.equal(compat, undefined, `Expected full compatibility (undefined) on DSH ${runtimeVer}, got ${JSON.stringify(compat)}`);
    assert(fs.statSync(path.join(pluginRoot, pkgDir, 'assets/icon.svg')).isFile(), `${pkgDir}: missing assets/icon.svg`);
    for (const lang of ['en', 'zh']) {
      const loc = JSON.parse(fs.readFileSync(path.join(pluginRoot, pkgDir, `locale/${lang}.json`), 'utf8'));
      assert(loc?.meta?.title && loc?.meta?.description, `${pkgDir}: locale/${lang}.json missing meta.title/description`);
    }
  }
  checks.push(`Universal engines.dsh compatibility verified on DSH ${runtimeVer} along with icon.svg and en/zh locales`);

  // 1. Verify exact 8 unified tools + bundled fallback skills registered on ctx.skills
  assert(ctx.tools, 'Native ToolsService did not start');
  const schemas = ctx.tools.schemas();
  assert.equal(schemas.length, 8, `Expected 8 unified native tools (7 engine_* + 1 teams_engine), got ${schemas.length}`);
  assert.deepEqual(schemas.map(s => s.name).sort(), [
    'engine_control',
    'engine_evidence',
    'engine_overview',
    'engine_source',
    'engine_submit',
    'engine_team',
    'engine_workspace',
    'teams_engine',
  ]);
  if (ctx.skills?.summaries) {
    const bundledSummaries = await ctx.skills.summaries({ cwd: workspace, signal });
    const names = (Array.isArray(bundledSummaries) ? bundledSummaries : bundledSummaries.skills || []).map(s => s.name);
    for (const expectedSkill of ['superagent-workflow', 'workflow-quality', 'development-handoff', 'super-teams']) {
      assert(names.includes(expectedSkill), `Expected bundled skill ${expectedSkill} on ctx.skills, got ${JSON.stringify(names)}`);
    }
  }
  checks.push('Cordis + ToolsService + SkillService registers 8 unified tools and all 4 bundled fallback skills');

  let serial = 0;
  async function invoke(name, args, expectedError, targetTools = ctx.tools) {
    const batch = await targetTools.execute({
      calls: [{ type: 'tool_call', id: 'dsh-univ-' + (++serial), name, arguments: JSON.stringify(args) }],
      signal,
    });
    const result = batch.results[0].result;
    if (expectedError) {
      assert(result.isError, JSON.stringify(result));
      assert.match(JSON.stringify(result), expectedError);
      return result;
    }
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content.find(item => item.type === 'text').text);
  }

  // 2. Strict schema rejection + shallow autoAccept rejection
  await invoke('engine_team', { action: 'prepare', unexpectedField: true }, /unrecognized|additional|unknown|required/i);
  await invoke('teams_engine', { action: 'overview', badExtra: 1 }, /unrecognized|additional|unknown/i);
  await invoke('engine_team', {
    action: 'prepare',
    requestId: randomUUID(),
    name: 'Shallow Reject Team',
    goal: 'Must reject shallow autoAccept',
    members: [{ name: 'Designer', role: 'Architect', responsibility: 'Draft spec' }],
    tasks: [
      { key: 'spec', member: 'Designer', title: 'Draft spec', goal: 'Write spec.md', autoAccept: true, checks: [{ type: 'file_exists', path: 'spec.md' }] },
    ],
  }, /autoAccept=true requires at least one behavioral node_test check/);
  checks.push('Native tool pipeline rejects unrecognized fields and blocks shallow autoAccept without node_test');

  // 3. Engine team prepare (with inline behavioral testScript) + graph + teams_engine read-only views + workspace auto-open
  const prepared = await invoke('engine_team', {
    action: 'prepare',
    requestId: randomUUID(),
    name: 'Universal Team',
    goal: 'Verify unified persistent SQLite WAL engine tools',
    members: [
      { name: 'Designer', role: 'Architect', responsibility: 'Draft spec' },
      { name: 'Builder', role: 'Engineer', responsibility: 'Build module' },
    ],
    tasks: [
      {
        key: 'spec',
        member: 'Designer',
        title: 'Draft spec',
        goal: 'Write docs/spec.json',
        priority: 'high',
        writeScopes: ['docs/spec.json'],
        autoAccept: true,
        checks: [{
          type: 'node_test',
          path: 'docs/spec.json',
          testScript: 'const fs = require("fs"); const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!j.ready) process.exit(1);',
        }],
      },
      { key: 'build', member: 'Builder', title: 'Build module', goal: 'Write src/index.js', dependsOn: ['spec'], writeScopes: ['src/index.js'] },
    ],
  });
  assert.equal(prepared.graphSummary.waveCount, 2);
  const graph = await invoke('engine_team', { action: 'graph', teamId: prepared.id });
  assert.equal(graph.waveCount, 2);
  assert.equal(graph.criticalPathIds.length, 2);

  const teView = await invoke('teams_engine', { action: 'overview', team_id: prepared.id });
  assert.equal(teView.source, 'superagent-engine-dsh');
  assert.equal(teView.store, 'engine.sqlite');
  assert.equal(teView.audit_independence, 'same_engine_store');
  assert.equal(teView.data.total, 2);

  const wsInfo = await invoke('engine_workspace', { teamId: prepared.id });
  assert.equal(wsInfo.openedInSidebar, true);
  assert.equal(wsInfo.host, 'deepseek-harness');
  checks.push('Native engine_team(prepare/graph), inline testScript, teams_engine, and engine_workspace execute cleanly');

  // 4. Verify webServer prefix route mounted and fenced by ctx.connection.requestRejection
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(registeredRoutes.length, 1);
  assert.equal(registeredRoutes[0].path, '/superagent-engine');
  let blockedStatus = 0;
  await registeredRoutes[0].handler(
    { method: 'GET', url: '/superagent-engine/api/health', headers: {} },
    { setHeader() {}, writeHead(code) { blockedStatus = code; }, end() {} }
  );
  assert.equal(blockedStatus, 403, 'Unauthenticated request must be blocked by DSH connection fence');
  let allowedBody = '';
  await registeredRoutes[0].handler(
    { method: 'GET', url: '/superagent-engine/api/changes?since=0', headers: { 'x-dsh-allow': '1' } },
    { setHeader() {}, writeHead() {}, end(chunk) { allowedBody = String(chunk || ''); } }
  );
  assert(JSON.parse(allowedBody).seq >= 1, 'Authenticated request must pass DSH connection fence');
  checks.push('/superagent-engine route enforces ctx.connection.requestRejection fence');

  // 5. Verify opt-in legacy mode (enableLegacyBoard: true) mounts all 15 tools cleanly
  const legacyCtx = new Context();
  legacyCtx.plugin(SystemPrompt, {});
  legacyCtx.plugin(Tools);
  legacyCtx.plugin(executor);
  legacyCtx.plugin(superTeamsPlugin, { dataDir: path.join(tempRoot, 'legacy-engine'), enableLegacyBoard: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  try {
    assert.equal(legacyCtx.tools.schemas().length, 15, 'Opt-in enableLegacyBoard: true must expose 8 primary + 7 legacy tools');
    const created = await invoke('teams_create', { workspace, title: 'Legacy Opt-In Board', request_id: randomUUID() }, null, legacyCtx.tools);
    assert.ok(created.team_id);
    checks.push('Explicit enableLegacyBoard opt-in mounts legacy .super-teams tools cleanly without polluting default mode');
  } finally {
    await legacyCtx.fiber.dispose();
  }

  // 6. Verify both client.js modules (commandUi + sidebarRightTabs + betterSidebar)
  for (const [dir, command, skillName] of [['superagent', 'superagent', 'superagent-workflow'], ['super-teams', 'superteams', 'super-teams']]) {
    let loader;
    const registeredCommands = [];
    const registeredRightTabs = [];
    const registeredBetterTabs = [];
    const fakeReact = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useEffect: () => {},
      useRef: val => ({ current: val }),
    };
    vm.runInNewContext(
      fs.readFileSync(path.join(pluginRoot, dir, 'client.js'), 'utf8'),
      { URL, fetch: async () => ({ ok: false }), window: { __ModuleLoader__: { load: val => { loader = val; } }, addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} }, document: { baseURI: 'dsh-app://app/', hidden: true, addEventListener() {}, removeEventListener() {} } }
    );
    let inputText = 'existing draft', focused = false;
    const input = {
      actions: {
        captureInsertion: () => ({ start: 5, end: 8 }),
        insertText: (text, span) => { inputText = inputText.slice(0, span.start) + text + inputText.slice(span.end); return true; },
      },
      focus: () => { focused = true; },
    };
    const mod = loader.factory(id => (id === 'react' ? fakeReact : null));
    const clientCtx = {
      commandUi: { register: val => registeredCommands.push(val) },
      sessions: {
        scope: id => (id === 'root' ? { get: () => ({ input: { for: () => input } }) } : undefined),
        subagentAddress: () => undefined,
      },
      effect: fn => fn(),
      inject: (deps, cb) => {
        if (deps.includes('sidebarRightTabs')) {
          cb({
            effect: fn => fn(),
            locale: { register: () => () => {} },
            sidebarRightTabs: { register: tab => { registeredRightTabs.push(tab); return () => {}; } },
            slots: { inject: (_n, fn) => fn(), register: () => () => {} },
            sidebarRight: { commandTarget: () => ({ sessionId: 'root', host: 'dock' }), openTabFromTarget() {}, isExpanded: () => true, toggleExpanded() {} },
          });
        } else if (deps.includes('betterSidebar')) {
          cb({
            effect: fn => fn(),
            betterSidebar: { registerTab: tab => { registeredBetterTabs.push(tab); return () => {}; } },
          });
        }
      },
    };
    mod.apply(clientCtx);
    const cmd = registeredCommands.find(c => c.name === command);
    assert(cmd, `Expected command ${command}`);
    assert(cmd.available({ sessionId: 'root' }));
    cmd.ui.run({ sessionId: 'root' });
    assert.equal(inputText, '/' + skillName + ' existing draft');
    assert(focused);
    if (dir === 'super-teams') {
      assert(registeredCommands.some(c => c.name === 'superagent-workbench'), 'Expected superagent-workbench command');
      assert.equal(registeredRightTabs.length, 1, 'Expected stock sidebarRightTabs registration');
      assert.equal(registeredBetterTabs.length, 1, 'Expected dsh-better-sidebar registration');
    }
  }
  checks.push('Client modules register commandUi, stock sidebarRightTabs, and dsh-better-sidebar tabs');

  // 7. When DSH_VERIFY_INSTALLED=1, verify self-contained <dshHome> installation cross-platform
  if (process.env.DSH_VERIFY_INSTALLED === '1') {
    const dshHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
    const profileName = process.env.DSH_PROFILE || 'desktop';
    const profilePkg = JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', profileName, 'package.json'), 'utf8'));
    const stageRoot = path.join(dshHome, 'local-packages', 'dsh-super-plugins');
    const stageRootNorm = stageRoot.replace(/\\/g, '/');

    for (const pkgName of ['@local/dsh-superagent-menu', '@local/dsh-super-teams']) {
      const spec = String(profilePkg.dependencies?.[pkgName] || '');
      const specNorm = spec.replace(/^(?:link|file):/, '').replace(/\\/g, '/');
      assert(/^(?:link|file):/.test(spec) && specNorm.startsWith(stageRootNorm), `Expected self-contained spec inside ${stageRootNorm} for ${pkgName}, got ${spec}`);
    }

    const skillRoot = path.join(dshHome, 'skills');
    const skillRootReal = fs.realpathSync(skillRoot);
    const skillPairs = [
      ['superagent-workflow', 'superagent'],
      ['workflow-quality', 'superagent'],
      ['development-handoff', 'superagent'],
      ['super-teams', 'super-teams'],
    ];
    for (const [skillName, pkgDir] of skillPairs) {
      const installedDir = path.join(skillRoot, skillName);
      const lstat = fs.lstatSync(installedDir);
      assert(lstat.isDirectory() && !lstat.isSymbolicLink(), `${skillName} in ${skillRoot} must be a regular directory, not a junction/symlink`);
      const real = fs.realpathSync(installedDir);
      const rel = path.relative(skillRootReal, real);
      assert(!rel.startsWith('..') && !path.isAbsolute(rel), `realpath of ${skillName} must stay inside ${skillRootReal}, got ${real}`);

      const stagedMd = path.join(stageRoot, pkgDir, 'skills', skillName, 'SKILL.md');
      const sourceMd = path.join(pluginRoot, pkgDir, 'skills', skillName, 'SKILL.md');
      assert.equal(sha256File(path.join(installedDir, 'SKILL.md')), sha256File(stagedMd));
      assert.equal(sha256File(path.join(installedDir, 'SKILL.md')), sha256File(sourceMd));
    }

    const provider = new FileSystemSkillProvider({ get: () => undefined, logger: { warn() {} } }, { signal, invalidate() {} }, { dshHome, watch: false });
    try {
      const result = await provider.list({ cwd: workspace, signal });
      const all = Array.isArray(result) ? result : result.candidates;
      for (const [skillName] of skillPairs) {
        const found = all.filter(c => c.name === skillName);
        assert.equal(found.length, 1, `${skillName}: expected unique installed skill, found ${found.length}`);
      }
      checks.push('Self-contained <dshHome> packages & regular skill directories verified cross-platform');
    } finally {
      await provider.dispose();
    }
  }

  console.log(JSON.stringify({ passed: true, checksCount: checks.length, checks }, null, 2));
} finally {
  await ctx.fiber.dispose();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
