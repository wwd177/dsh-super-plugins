#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const PLUGIN_NAMES = ['@local/dsh-superagent-menu', '@local/dsh-super-teams'];
const SKILL_ENTRIES = [
  { name: 'superagent-workflow', package: 'superagent', version: '1.24.1-dsh.1' },
  { name: 'workflow-quality', package: 'superagent', version: '1.24.1-dsh.1' },
  { name: 'development-handoff', package: 'superagent', version: '1.24.1-dsh.1' },
  { name: 'super-teams', package: 'super-teams', version: '0.16.1-dsh.1' },
];

function parseArgs(argv) {
  const opts = {
    mode: 'install',
    profile: process.env.DSH_PROFILE || 'desktop',
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    dshCli: process.env.DSH_CLI || '',
    dshInstallDir: process.env.DSH_INSTALL_DIR || '',
    backupRoot: '',
    purgeData: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify') opts.mode = 'verify';
    else if (arg === '--uninstall') opts.mode = 'uninstall';
    else if (arg === '--install') opts.mode = 'install';
    else if (arg === '--purge-data') opts.purgeData = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--profile' && argv[i + 1]) opts.profile = argv[++i];
    else if (arg === '--dsh-home' && argv[i + 1]) opts.dshHome = argv[++i];
    else if (arg === '--dsh-cli' && argv[i + 1]) opts.dshCli = argv[++i];
    else if (arg === '--dsh-install-dir' && argv[i + 1]) opts.dshInstallDir = argv[++i];
    else if (arg === '--backup-root' && argv[i + 1]) opts.backupRoot = argv[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log([
        'Usage: node scripts/install.mjs [options]',
        '',
        'Modes:',
        '  --install              Install or upgrade SuperAgent + Super Teams + 4 skills (default)',
        '  --verify               Verify existing installation integrity without modifying files',
        '  --uninstall            Remove SuperAgent + Super Teams plugins and 4 skills cleanly',
        '',
        'Options:',
        '  --profile <name>       Target DeepSeek Harness profile (default: desktop)',
        '  --dsh-home <dir>       DeepSeek Harness home directory (default: ~/.dsh or $DSH_HOME)',
        '  --dsh-cli <file>       Explicit path to dsh / dsh.cmd CLI binary',
        '  --dsh-install-dir <d>  DeepSeek Harness app installation directory',
        '  --purge-data           With --uninstall, also delete plugin-data/dsh-super-teams',
        '  --json                 Emit machine-readable JSON output (ideal for AI agents)',
      ].join('\n'));
      process.exit(0);
    }
  }
  opts.dshHome = path.resolve(opts.dshHome);
  return opts;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findOnPath(binNames) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of binNames) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

export function resolveDshCli({ dshCli, dshInstallDir }) {
  const candidates = [];
  if (dshCli) candidates.push(path.resolve(dshCli));
  if (dshInstallDir) {
    const base = path.resolve(dshInstallDir);
    if (process.platform === 'win32') {
      candidates.push(path.join(base, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    } else if (process.platform === 'darwin') {
      candidates.push(path.join(base, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'));
      candidates.push(path.join(base, 'resources', 'runtime', 'cli', 'bin', 'dsh'));
    } else {
      candidates.push(path.join(base, 'resources', 'runtime', 'cli', 'bin', 'dsh'));
    }
  }

  const fromPath = findOnPath(process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']);
  if (fromPath) candidates.push(fromPath);

  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      path.join(progFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
    );
  } else {
    candidates.push(
      '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
      '/opt/deepseek-harness/resources/runtime/cli/bin/dsh',
      '/usr/lib/deepseek-harness/resources/runtime/cli/bin/dsh',
      path.join(home, '.local', 'share', 'deepseek-harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'),
      path.join(home, '.local', 'bin', 'dsh'),
    );
  }

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  throw new Error(
    `Could not locate DeepSeek Harness CLI (dsh / dsh.cmd). Pass --dsh-cli <path> or --dsh-install-dir <dir>. Checked: ${candidates.join(', ')}`
  );
}

function resolvePackageSourceRoot() {
  const candidates = [
    path.join(REPO_ROOT, 'packages'),
    REPO_ROOT,
  ];
  for (const root of candidates) {
    if (
      fs.existsSync(path.join(root, 'superagent', 'package.json')) &&
      fs.existsSync(path.join(root, 'super-teams', 'package.json'))
    ) {
      return root;
    }
  }
  throw new Error(`Cannot find superagent and super-teams package directories under ${REPO_ROOT}`);
}

function removeEntrySafe(targetPath) {
  let st;
  try {
    st = fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    // On Windows directory junctions, lstatSync().isSymbolicLink() is true; unlinkSync/rmdirSync removes only the junction reparse point.
    try {
      fs.unlinkSync(targetPath);
    } catch {
      fs.rmdirSync(targetPath);
    }
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyPlainTree(srcDir, dstDir) {
  const srcFull = path.resolve(srcDir);
  const dstFull = path.resolve(dstDir);
  fs.mkdirSync(dstFull, { recursive: true });
  for (const entry of fs.readdirSync(srcFull, { withFileTypes: true })) {
    const srcChild = path.join(srcFull, entry.name);
    const dstChild = path.join(dstFull, entry.name);
    if (entry.isDirectory()) {
      copyPlainTree(srcChild, dstChild);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcChild, dstChild);
    }
  }
}

function collectRelativeFiles(rootDir, current = rootDir, out = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) collectRelativeFiles(rootDir, full, out);
    else if (entry.isFile()) out.push(path.relative(rootDir, full).replace(/\\/g, '/'));
  }
  return out;
}

function runDshCli(dshCli, args, dshHome = null) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  if (dshHome) cleanEnv.DSH_HOME = dshHome;

  let res;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshCli)) {
    // Pass executable and arguments via environment variables so cmd.exe performs single-pass
    // expansion without re-expanding literal %VAR% tokens or breaking on spaces/metacharacters.
    cleanEnv.DSH_CLI_BIN = dshCli;
    const argRefs = args.map((val, idx) => {
      const key = `DSH_CLI_ARG_${idx}`;
      cleanEnv[key] = String(val);
      return `"%${key}%"`;
    });
    const cmdLine = `"%DSH_CLI_BIN%" ${argRefs.join(' ')}`.trim();
    res = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
      env: cleanEnv,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else {
    res = spawnSync(dshCli, args, {
      env: cleanEnv,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  if (res.status !== 0) {
    throw new Error(
      `dsh CLI exited with status ${res.status}:\n${(res.stdout || '') + '\n' + (res.stderr || '')}`.trim()
    );
  }
  return res;
}

function snapshotProtectedFiles(dshHome) {
  const list = [];
  for (const name of ['.credentials.yaml', '.env', 'cordis.patch.yml']) {
    const file = path.join(dshHome, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      list.push({ path: file, sha256: sha256File(file) });
    }
  }
  return list;
}

function assertProtectedUnchanged(protectedList) {
  for (const item of protectedList) {
    const current = sha256File(item.path);
    if (current !== item.sha256) {
      throw new Error(`Protected user file was unexpectedly modified: ${item.path}`);
    }
  }
}

function verifyInstallation({ dshHome, profile }) {
  const profileManifestPath = path.join(dshHome, 'profiles', profile, 'package.json');
  if (!fs.existsSync(profileManifestPath)) {
    throw new Error(`Profile manifest missing: ${profileManifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
  const stageRoot = path.join(dshHome, 'local-packages', 'dsh-super-plugins');
  const stageRootNorm = stageRoot.replace(/\\/g, '/');

  for (const pkgName of PLUGIN_NAMES) {
    const dep = String(manifest?.dependencies?.[pkgName] || '');
    const depNorm = dep.replace(/^(?:link|file):/, '').replace(/\\/g, '/');
    if (!/^(?:link|file):/.test(dep) || !depNorm.startsWith(stageRootNorm)) {
      throw new Error(`Expected ${pkgName} dependency to point inside "${stageRootNorm}", got "${dep}"`);
    }
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    if (!bundles.includes(pkgName)) {
      throw new Error(`Plugin ${pkgName} is missing from dsh.profile.bundles in ${profileManifestPath}`);
    }
  }

  const skillRoot = path.join(dshHome, 'skills');
  const skillRootReal = fs.existsSync(skillRoot) ? fs.realpathSync(skillRoot) : skillRoot;
  const verifiedSkills = [];

  for (const entry of SKILL_ENTRIES) {
    const installedDir = path.join(skillRoot, entry.name);
    const stagedDir = path.join(stageRoot, entry.package, 'skills', entry.name);
    if (!fs.existsSync(installedDir)) {
      throw new Error(`Installed skill directory missing: ${installedDir}`);
    }
    const lstat = fs.lstatSync(installedDir);
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
      throw new Error(`Installed skill must be a regular directory (not symlink/junction): ${installedDir}`);
    }
    const real = fs.realpathSync(installedDir);
    const rel = path.relative(skillRootReal, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Installed skill realpath escaped ${skillRootReal}: ${real}`);
    }

    const stagedFiles = collectRelativeFiles(stagedDir);
    for (const relFile of stagedFiles) {
      const sHash = sha256File(path.join(stagedDir, relFile));
      const dPath = path.join(installedDir, relFile);
      if (!fs.existsSync(dPath)) {
        throw new Error(`Missing file in installed skill: ${entry.name}/${relFile}`);
      }
      const dHash = sha256File(dPath);
      if (sHash !== dHash) {
        throw new Error(`SHA-256 mismatch in skill file ${entry.name}/${relFile}`);
      }
    }
    verifiedSkills.push({
      name: entry.name,
      version: entry.version,
      path: installedDir,
      fileCount: stagedFiles.length,
    });
  }

  return {
    ok: true,
    mode: 'verify',
    platform: process.platform,
    dshHome,
    profile,
    stagedPackages: stageRoot,
    plugins: Object.fromEntries(PLUGIN_NAMES.map(n => [n, manifest.dependencies[n]])),
    skills: verifiedSkills,
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, Math.max(1, ms));
}

function withDshHomeLock(dshHome, { createHome = false, mode, profile }, fn) {
  if (createHome) {
    fs.mkdirSync(dshHome, { recursive: true });
  } else if (!fs.existsSync(dshHome)) {
    return fn(dshHome);
  }
  const dshHomeReal = fs.realpathSync(dshHome);
  const lockPath = path.join(dshHomeReal, '.dsh-super-plugins.lock');
  const nonce = crypto.randomUUID();
  const payload = JSON.stringify({
    pid: process.pid,
    nonce,
    mode,
    profile,
    startedAt: new Date().toISOString(),
  }) + '\n';
  const deadline = Date.now() + 25000;
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, payload, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.lstatSync(lockPath);
        if (st.isSymbolicLink()) {
          throw new Error(`Refusing unsafe lock symlink at ${lockPath}`);
        }
        const raw = fs.readFileSync(lockPath, 'utf8');
        let info = null;
        if (raw.trim()) {
          try { info = JSON.parse(raw); } catch { info = null; }
        }
        const ageMs = Date.now() - st.mtimeMs;
        const deadOwner = info && Number.isInteger(info.pid) && !isPidAlive(info.pid);
        const stale = deadOwner || ageMs > 60000 || (!info && ageMs > 3000);
        if (stale) {
          const confirmRaw = fs.readFileSync(lockPath, 'utf8');
          if (confirmRaw === raw) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
        }
      } catch (readErr) {
        if (readErr.code === 'ENOENT') continue;
        if (/Refusing unsafe lock symlink/.test(readErr.message)) throw readErr;
      }
      sleepSyncMs(45);
    }
  }
  if (!acquired) {
    throw new Error(`Timed out waiting for DSH installation lock at ${lockPath}. Another install or uninstall process is currently modifying ${dshHomeReal}.`);
  }
  try {
    return fn(dshHomeReal);
  } finally {
    try {
      const currentRaw = fs.readFileSync(lockPath, 'utf8');
      const current = JSON.parse(currentRaw);
      if (current?.nonce === nonce) fs.unlinkSync(lockPath);
    } catch {}
  }
}

function getDirIdentity(dirPath) {
  const st = fs.statSync(dirPath, { bigint: true });
  const realpath = fs.realpathSync(dirPath);
  return { devIno: `${st.dev}:${st.ino}`, realpath };
}

function manifestReferencesOurPlugins(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const map = manifest[field];
    if (map && typeof map === 'object' && PLUGIN_NAMES.some(name => Object.hasOwn(map, name))) {
      return true;
    }
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  return Array.isArray(bundles) && PLUGIN_NAMES.some(name => bundles.includes(name));
}

function inspectProfilesUsage(dshHomeReal, targetProfile) {
  const profilesRoot = path.join(dshHomeReal, 'profiles');
  if (!fs.existsSync(profilesRoot)) {
    return {
      profilesReadError: null,
      targetStillReferences: false,
      remainingProfiles: [],
      unknownProfiles: [],
    };
  }
  let entries;
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
  } catch (err) {
    return {
      profilesReadError: err.message || String(err),
      targetStillReferences: true,
      remainingProfiles: [],
      unknownProfiles: ['<profiles-root>'],
    };
  }

  let targetIdentity = null;
  const targetDir = path.join(profilesRoot, targetProfile);
  try {
    if (fs.existsSync(targetDir)) {
      targetIdentity = getDirIdentity(targetDir);
    }
  } catch {
    return {
      profilesReadError: `Cannot resolve target profile directory identity: ${targetDir}`,
      targetStillReferences: true,
      remainingProfiles: [],
      unknownProfiles: [targetProfile],
    };
  }

  let targetStillReferences = false;
  const remainingProfiles = [];
  const unknownProfiles = [];
  const seenOtherIdentities = new Set();

  for (const entry of entries) {
    const entryPath = path.join(profilesRoot, entry.name);
    let st;
    let ident;
    try {
      fs.lstatSync(entryPath);
      st = fs.statSync(entryPath, { bigint: true });
      if (!st.isDirectory()) continue;
      ident = getDirIdentity(entryPath);
    } catch {
      unknownProfiles.push(entry.name);
      continue;
    }

    const isTarget =
      entry.name === targetProfile ||
      (targetIdentity && ident.realpath === targetIdentity.realpath && ident.devIno === targetIdentity.devIno);

    const pkgPath = path.join(entryPath, 'package.json');
    let parsedManifest = null;
    let manifestValid = false;
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedManifest = parsed;
        manifestValid = true;
      }
    } catch {
      manifestValid = false;
    }

    if (isTarget) {
      if (!manifestValid || manifestReferencesOurPlugins(parsedManifest)) {
        targetStillReferences = true;
      }
      continue;
    }

    const dedupKey = `${ident.devIno}|${ident.realpath}`;
    if (seenOtherIdentities.has(dedupKey)) continue;
    seenOtherIdentities.add(dedupKey);

    if (!manifestValid) {
      unknownProfiles.push(entry.name);
      continue;
    }
    if (manifestReferencesOurPlugins(parsedManifest)) {
      remainingProfiles.push(entry.name);
    }
  }

  return {
    profilesReadError: null,
    targetStillReferences,
    remainingProfiles,
    unknownProfiles,
  };
}

function assertSafeDeletionTarget(dshHomeReal, targetPath) {
  const resolved = path.resolve(targetPath);
  const rel = path.relative(dshHomeReal, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing deletion outside DSH home (${dshHomeReal}): ${resolved}`);
  }
  const parentDir = path.dirname(resolved);
  const segments = path.relative(dshHomeReal, parentDir).split(path.sep).filter(Boolean);
  let cur = dshHomeReal;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    let lst;
    try {
      lst = fs.lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      throw new Error(`Refusing deletion beneath non-regular ancestor directory: ${cur}`);
    }
  }
  if (fs.existsSync(parentDir)) {
    const parentReal = fs.realpathSync(parentDir);
    const parentRel = path.relative(dshHomeReal, parentReal);
    if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
      throw new Error(`Refusing deletion whose resolved parent escaped DSH home: ${parentReal}`);
    }
  }
  return true;
}

function performInstall(opts) {
  return withDshHomeLock(opts.dshHome, { createHome: true, mode: 'install', profile: opts.profile }, dshHomeReal => {
    return performInstallLocked({ ...opts, dshHome: dshHomeReal });
  });
}

function performInstallLocked(opts) {
  const { dshHome, profile } = opts;
  const dshCli = resolveDshCli(opts);
  const pkgSourceRoot = resolvePackageSourceRoot();
  const profileDir = path.join(dshHome, 'profiles', profile);
  const profileManifestPath = path.join(profileDir, 'package.json');

  if (!fs.existsSync(profileManifestPath)) {
    throw new Error(
      `DeepSeek Harness profile "${profile}" not found at ${profileManifestPath}. Open DeepSeek Harness once to initialize your profile first.`
    );
  }

  const protectedBefore = snapshotProtectedFiles(dshHome);
  const beforeManifest = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));

  const backupParent = path.join(dshHome, 'profile-backups', 'dsh-super-plugins');
  fs.mkdirSync(backupParent, { recursive: true });
  const safeProfile = String(profile).replace(/[^a-zA-Z0-9._-]/g, '_');
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const randSuffix = crypto.randomBytes(3).toString('hex');
  const backupRoot = opts.backupRoot
    ? path.resolve(opts.backupRoot)
    : path.join(backupParent, `${safeProfile}-${stamp}-${randSuffix}`);
  if (opts.backupRoot) fs.mkdirSync(backupRoot, { recursive: true });
  else fs.mkdirSync(backupRoot, { recursive: false });

  for (const fname of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml']) {
    const f = path.join(profileDir, fname);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backupRoot, fname));
  }

  // 1. Atomically stage self-contained package copies inside <dshHome>/local-packages before swapping
  const localPackagesDir = path.join(dshHome, 'local-packages');
  fs.mkdirSync(localPackagesDir, { recursive: true });
  const stageRoot = path.join(localPackagesDir, 'dsh-super-plugins');
  const tempStageRoot = path.join(localPackagesDir, `.staging-dsh-super-plugins-${process.pid}-${randSuffix}`);
  const prevStageBackup = path.join(localPackagesDir, `.backup-dsh-super-plugins-${process.pid}-${randSuffix}`);
  removeEntrySafe(tempStageRoot);
  fs.mkdirSync(tempStageRoot, { recursive: true });
  for (const pkg of ['superagent', 'super-teams']) {
    const src = path.join(pkgSourceRoot, pkg);
    const dst = path.join(tempStageRoot, pkg);
    copyPlainTree(src, dst);
    if (!fs.existsSync(path.join(dst, 'package.json'))) {
      removeEntrySafe(tempStageRoot);
      throw new Error(`Staging incomplete for package ${pkg}`);
    }
  }

  // 2. Back up any pre-existing skills before replacing
  const skillRoot = path.join(dshHome, 'skills');
  fs.mkdirSync(skillRoot, { recursive: true });
  const previousSkills = [];
  for (const entry of SKILL_ENTRIES) {
    const dst = path.join(skillRoot, entry.name);
    if (fs.existsSync(dst)) {
      const st = fs.lstatSync(dst);
      previousSkills.push({
        name: entry.name,
        wasSymbolicLink: st.isSymbolicLink(),
      });
      if (fs.existsSync(path.join(dst, 'SKILL.md'))) {
        copyPlainTree(dst, path.join(backupRoot, `skill-${entry.name}`));
      }
    }
  }
  fs.writeFileSync(path.join(backupRoot, 'previous-skills.json'), JSON.stringify(previousSkills, null, 2) + '\n', 'utf8');

  const hadPrevStage = fs.existsSync(stageRoot);
  if (hadPrevStage) fs.renameSync(stageRoot, prevStageBackup);
  try {
    fs.renameSync(tempStageRoot, stageRoot);

    // 3. Register both self-contained packages via native dsh plugin manager
    const agentSpec = 'link:' + path.join(stageRoot, 'superagent').replace(/\\/g, '/');
    const teamsSpec = 'link:' + path.join(stageRoot, 'super-teams').replace(/\\/g, '/');
    runDshCli(dshCli, ['plugin', '--profile', profile, 'add', agentSpec, teamsSpec], dshHome);

    // 4. Atomically stage and swap 4 skills as regular directories with SHA-256 lock verification
    const skillLocks = {};
    for (const entry of SKILL_ENTRIES) {
      const src = path.join(stageRoot, entry.package, 'skills', entry.name);
      const dst = path.join(skillRoot, entry.name);
      const tempSkillDst = path.join(skillRoot, `.staging-${entry.name}-${process.pid}-${randSuffix}`);
      removeEntrySafe(tempSkillDst);
      copyPlainTree(src, tempSkillDst);

      const files = {};
      for (const rel of collectRelativeFiles(src)) {
        const h = sha256File(path.join(src, rel));
        const dh = sha256File(path.join(tempSkillDst, rel));
        if (h !== dh) {
          removeEntrySafe(tempSkillDst);
          throw new Error(`Skill hash verification failed for ${entry.name}/${rel}`);
        }
        files[rel] = h;
      }
      removeEntrySafe(dst);
      fs.renameSync(tempSkillDst, dst);
      skillLocks[entry.name] = {
        package: entry.package,
        version: entry.version,
        installedPath: dst,
        stagedSourcePath: src,
        files,
      };
    }

    fs.writeFileSync(
      path.join(stageRoot, 'skill-lock.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        engineVersion: '0.19.1-dsh.1',
        superagentVersion: '1.24.1-dsh.1',
        superTeamsVersion: '0.16.1-dsh.1',
        skills: skillLocks,
      }, null, 2) + '\n',
      'utf8'
    );
    removeEntrySafe(prevStageBackup);
  } catch (err) {
    removeEntrySafe(tempStageRoot);
    if (hadPrevStage && fs.existsSync(prevStageBackup)) {
      removeEntrySafe(stageRoot);
      try { fs.renameSync(prevStageBackup, stageRoot); } catch {}
    }
    throw err;
  }

  // 5. Verify unrelated plugins/bundles & protected credentials remain 100% untouched
  const afterManifest = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'));
  for (const [depName, depVal] of Object.entries(beforeManifest.dependencies || {})) {
    if (PLUGIN_NAMES.includes(depName)) continue;
    if (afterManifest.dependencies?.[depName] !== depVal) {
      throw new Error(`Unrelated plugin dependency changed unexpectedly: ${depName}`);
    }
  }
  for (const bundle of beforeManifest?.dsh?.profile?.bundles || []) {
    if (!afterManifest?.dsh?.profile?.bundles?.includes(bundle)) {
      throw new Error(`Existing bundle disappeared from profile: ${bundle}`);
    }
  }
  assertProtectedUnchanged(protectedBefore);

  // Prune older backups beyond latest 2
  if (fs.existsSync(backupParent)) {
    const dirs = fs.readdirSync(backupParent, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ name: d.name, full: path.join(backupParent, d.name), mtime: fs.statSync(path.join(backupParent, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of dirs.slice(2)) {
      fs.rmSync(old.full, { recursive: true, force: true });
    }
  }

  const verification = verifyInstallation({ dshHome, profile });
  const report = {
    ok: true,
    mode: 'install',
    platform: process.platform,
    dshCli,
    dshHome,
    profile,
    backup: backupRoot,
    versions: {
      engine: '0.19.1-dsh.1',
      superagent: '1.24.1-dsh.1',
      superTeams: '0.16.1-dsh.1',
    },
    plugins: verification.plugins,
    skills: verification.skills,
    restartRequired: true,
  };
  fs.writeFileSync(path.join(backupRoot, 'installation.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  return report;
}

function performUninstall(opts) {
  return withDshHomeLock(opts.dshHome, { createHome: false, mode: 'uninstall', profile: opts.profile }, dshHomeReal => {
    return performUninstallLocked({ ...opts, dshHome: dshHomeReal });
  });
}

function performUninstallLocked(opts) {
  const { dshHome, profile, purgeData } = opts;
  const dshCli = resolveDshCli(opts);
  const protectedBefore = snapshotProtectedFiles(dshHome);

  try {
    runDshCli(dshCli, ['plugin', '--profile', profile, 'remove', ...PLUGIN_NAMES], dshHome);
  } catch (err) {
    if (!/not installed|unknown|not found/i.test(err.message)) throw err;
  }

  const usage = inspectProfilesUsage(dshHome, profile);
  if (usage.targetStillReferences) {
    throw new Error(`Uninstall failed: profile "${profile}" still references SuperAgent/Super Teams plugins or manifests cannot be verified after removal.`);
  }

  // Clean up orphaned node_modules/@local plugin junctions left behind by pnpm remove inside targetProfile
  for (const pkgShort of ['dsh-superagent-menu', 'dsh-super-teams']) {
    const nmLink = path.join(dshHome, 'profiles', profile, 'node_modules', '@local', pkgShort);
    try {
      if (fs.lstatSync(nmLink).isSymbolicLink() && assertSafeDeletionTarget(dshHome, nmLink)) {
        removeEntrySafe(nmLink);
      }
    } catch {}
  }

  const shouldPreserveShared =
    Boolean(usage.profilesReadError) ||
    usage.remainingProfiles.length > 0 ||
    usage.unknownProfiles.length > 0;

  let sharedAssetsPreserved = true;
  let preservedReason = null;
  if (!shouldPreserveShared) {
    const targets = [
      ...SKILL_ENTRIES.map(entry => path.join(dshHome, 'skills', entry.name)),
      path.join(dshHome, 'local-packages', 'dsh-super-plugins'),
    ];
    const failures = [];
    for (const targetPath of targets) {
      try {
        if (assertSafeDeletionTarget(dshHome, targetPath)) {
          removeEntrySafe(targetPath);
        }
      } catch (err) {
        failures.push(`${targetPath}: ${err.message}`);
      }
    }
    if (failures.length > 0) {
      const remainingOnDisk = targets.filter(p => fs.existsSync(p));
      throw new Error(`Failed while removing shared assets (${failures.join('; ')}). Remaining paths: ${remainingOnDisk.join(', ')}`);
    }
    sharedAssetsPreserved = false;
  } else {
    preservedReason = usage.profilesReadError
      ? `profiles_read_error: ${usage.profilesReadError}`
      : usage.unknownProfiles.length > 0
        ? `unreadable_or_unknown_profiles: ${usage.unknownProfiles.join(', ')}`
        : `referenced_by_other_profiles: ${usage.remainingProfiles.join(', ')}`;
  }

  if (purgeData) {
    const dataTarget = path.join(dshHome, 'profiles', profile, 'plugin-data', 'dsh-super-teams');
    if (assertSafeDeletionTarget(dshHome, dataTarget)) {
      removeEntrySafe(dataTarget);
    }
  }

  assertProtectedUnchanged(protectedBefore);
  return {
    ok: true,
    mode: 'uninstall',
    platform: process.platform,
    dshHome,
    profile,
    purgedData: purgeData,
    sharedAssetsPreserved,
    remainingProfiles: usage.remainingProfiles,
    unknownProfiles: usage.unknownProfiles,
    ...(preservedReason ? { preservedReason } : {}),
    restartRequired: true,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = opts.mode === 'verify'
      ? verifyInstallation(opts)
      : opts.mode === 'uninstall'
        ? performUninstall(opts)
        : performInstall(opts);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (opts.mode === 'verify') {
      console.log(`[OK] Verified SuperAgent + Super Teams installation in ${result.dshHome} (profile: ${result.profile}, ${result.skills.length} regular skills verified).`);
    } else if (opts.mode === 'uninstall') {
      console.log(`[OK] Uninstalled SuperAgent + Super Teams from ${result.dshHome} (profile: ${result.profile}). Restart DeepSeek Harness to apply.`);
    } else {
      console.log(`[OK] Installed SuperAgent 1.24.1-dsh.1 + Super Teams 0.16.1-dsh.1 (Engine 0.19.1-dsh.1) into ${result.dshHome} (profile: ${result.profile}).`);
      console.log(`     Backup saved to: ${result.backup}`);
      console.log(`     Please restart DeepSeek Harness once to load the updated plugins and Team Workbench.`);
    }
  } catch (err) {
    if (opts.json) {
      console.error(JSON.stringify({ ok: false, mode: opts.mode, error: err.message || String(err) }, null, 2));
    } else {
      console.error(`[ERROR] ${err.message || err}`);
    }
    process.exit(1);
  }
}
