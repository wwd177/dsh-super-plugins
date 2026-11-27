import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SAFE_TEST_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NODE_NO_WARNINGS',
  'DOTNET_CLI_HOME', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE',
]);

export const SECRET_ENV_PREFIXES = Object.freeze([
  'GH_', 'GITHUB_', 'GIT_ASKPASS', 'NPM_TOKEN', 'AWS_', 'AZURE_', 'GCP_', 'GOOGLE_',
  'OPENAI_', 'ANTHROPIC_', 'DEEPSEEK_', 'HF_', 'DOCKER_', 'PYPI_', 'CARGO_REGISTRY_TOKEN',
  'SSH_', 'PGPASSWORD', 'DATABASE_URL',
]);

/**
 * 强杀指定 PID 的整棵进程树（Windows 使用 taskkill /T /F；POSIX 使用负 PID 进程组）。
 */
export function killProcessTree(target) {
  const pid = typeof target === 'number' ? target : target?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 8000,
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return true;
  } catch {
    try {
      if (typeof target === 'object' && typeof target?.kill === 'function') target.kill('SIGKILL');
      else process.kill(pid, 'SIGKILL');
    } catch {}
    return false;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isPersonalHomePath(dirEntry, realHome, realProfile) {
  if (!dirEntry) return false;
  const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const check = candidate => {
    if (!candidate) return false;
    const base = norm(candidate);
    const cur = norm(dirEntry);
    return cur === base || cur.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  };
  return check(realHome) || check(realProfile);
}

function safeRemoveOwnedDir(dirPath) {
  if (!dirPath) return;
  let st;
  try {
    st = fs.lstatSync(dirPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * 构造隔离的测试子进程环境变量，并落盘空 HOME / Git / npm 配置文件。
 * 彻底停止透传宿主机真实 HOME、USERPROFILE、APPDATA、LOCALAPPDATA 及各类 Token。
 * 当 Windows 下调用方传入深层 testTmpDir 导致路径接近 MAX_PATH 时，自动切换至系统短临时目录并随 cleanup() 安全回收。
 */
export function buildIsolatedTestEnv(testTmpDir, {
  extraEnv = {},
  toolchainRoots = [],
  stripPersonalPathEntries = false,
  preserveElectronAsNode = false,
} = {}) {
  if (!testTmpDir || typeof testTmpDir !== 'string') {
    throw new Error('testTmpDir is required to build an isolated test environment');
  }
  const candidateIso = path.join(testTmpDir, 'isolated-home');
  const needsShortRoot = process.platform === 'win32' && (
    path.join(candidateIso, 'AppData', 'Roaming').length > 180 ||
    path.join(candidateIso, '.gitconfig.lock').length > 210 ||
    testTmpDir.length > 170
  );
  let ownedExternalRoot = null;
  let isolatedRoot = candidateIso;
  let effectiveTmpDir = testTmpDir;
  if (needsShortRoot) {
    ownedExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-h-'));
    isolatedRoot = path.join(ownedExternalRoot, 'h');
    effectiveTmpDir = path.join(ownedExternalRoot, 't');
  }
  const cleanup = () => {
    const target = ownedExternalRoot;
    ownedExternalRoot = null;
    if (target) {
      try { safeRemoveOwnedDir(target); } catch {}
    }
  };

  try {
    const lockPath = path.join(isolatedRoot, '.gitconfig.lock');
    const roamingPath = path.join(isolatedRoot, 'AppData', 'Roaming');
    if (process.platform === 'win32' && (lockPath.length >= 248 || roamingPath.length >= 248)) {
      throw new Error(`Isolated environment path exceeds Windows MAX_PATH safe budget (${Math.max(lockPath.length, roamingPath.length)} chars): ${lockPath}`);
    }
    const xdgConfig = path.join(isolatedRoot, '.config');
    const xdgData = path.join(isolatedRoot, '.local', 'share');
    const xdgCache = path.join(isolatedRoot, '.cache');
    const ghConfig = path.join(xdgConfig, 'gh');
    const npmCache = path.join(xdgCache, 'npm');
    const appData = roamingPath;
    const localAppData = path.join(isolatedRoot, 'AppData', 'Local');
    for (const dir of [effectiveTmpDir, isolatedRoot, xdgConfig, xdgData, xdgCache, ghConfig, npmCache, appData, localAppData]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const emptyGitConfig = path.join(isolatedRoot, '.gitconfig');
    const emptyNpmRc = path.join(isolatedRoot, '.npmrc');
    if (!fs.existsSync(emptyGitConfig)) fs.writeFileSync(emptyGitConfig, '', 'utf8');
    if (!fs.existsSync(emptyNpmRc)) fs.writeFileSync(emptyNpmRc, '', 'utf8');

    const env = {};
    const allowedUpper = new Set(SAFE_TEST_ENV_KEYS);
    for (const [key, val] of Object.entries(process.env)) {
      if (val === undefined) continue;
      const upper = key.toUpperCase();
      if (!allowedUpper.has(upper)) continue;
      if (SECRET_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) continue;
      env[key] = val;
    }

    // Filter personal-directory entries from PATH when requested and prepend pinned toolchain roots.
    const rawPath = env.PATH || env.Path || '';
    const realHome = process.env.HOME;
    const realProfile = process.env.USERPROFILE;
    let pathParts = rawPath.split(path.delimiter).filter(Boolean);
    if (stripPersonalPathEntries) {
      pathParts = pathParts.filter(p => !isPersonalHomePath(p, realHome, realProfile));
    }
    if (Array.isArray(toolchainRoots) && toolchainRoots.length) {
      pathParts = [...toolchainRoots.filter(Boolean), ...pathParts];
    }
    if (pathParts.length) {
      env.PATH = pathParts.join(path.delimiter);
      if (process.platform === 'win32' && 'Path' in env && !('PATH' in process.env)) {
        env.Path = env.PATH;
      }
    }

    env.HOME = isolatedRoot;
    env.USERPROFILE = isolatedRoot;
    env.APPDATA = appData;
    env.LOCALAPPDATA = localAppData;
    env.XDG_CONFIG_HOME = xdgConfig;
    env.XDG_DATA_HOME = xdgData;
    env.XDG_CACHE_HOME = xdgCache;
    env.GH_CONFIG_DIR = ghConfig;
    env.GIT_CONFIG_GLOBAL = emptyGitConfig;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_ASKPASS = '';
    env.SSH_AUTH_SOCK = '';
    env.NPM_CONFIG_USERCONFIG = emptyNpmRc;
    env.NPM_CONFIG_CACHE = npmCache;
    env.TMP = effectiveTmpDir;
    env.TEMP = effectiveTmpDir;
    env.TMPDIR = effectiveTmpDir;
    if (preserveElectronAsNode) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    for (const [key, val] of Object.entries(extraEnv ?? {})) {
      if (val === undefined || val === null) delete env[key];
      else env[key] = String(val);
    }
    return { env, isolatedRoot, emptyGitConfig, emptyNpmRc, ghConfig, tmpDir: effectiveTmpDir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function probeBinary(cmd, args = ['--version']) {
  const winCmd = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
  try {
    const res = spawnSync(winCmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) {
      return { command: cmd, status: 'not_installed_on_host', detail: res.error.code || res.error.message };
    }
    const line = String(res.stdout || res.stderr || '').split(/\r?\n/).find(Boolean)?.trim() || '';
    if (res.status !== 0) {
      // e.g. Windows App Execution Alias or broken install
      return { command: cmd, status: 'unusable_on_host', exitCode: res.status, detail: line.slice(0, 200) };
    }
    return { command: cmd, status: 'verified', version: line.slice(0, 120) };
  } catch (err) {
    return { command: cmd, status: 'not_installed_on_host', detail: err.message };
  }
}

/**
 * 动态实测当前宿主机工具链可用性与真实 OS 安全隔离边界（绝不伪报隔离级别）。
 */
export function probeHostIsolationPosture({ dedicatedAccountEnvVar = 'SUPERAGENT_OS_ISOLATED' } = {}) {
  const dedicatedAccount = process.env[dedicatedAccountEnvVar] === '1';
  const toolchains = [
    { command: 'node', status: 'verified', version: process.version, execPath: process.execPath },
    probeBinary('git', ['--version']),
    probeBinary('npm', ['--version']),
    probeBinary('python', ['--version']),
    probeBinary('python3', ['--version']),
    probeBinary('pytest', ['--version']),
    probeBinary('cargo', ['--version']),
    probeBinary('go', ['version']),
    probeBinary('dotnet', ['--version']),
  ];
  return {
    platform: process.platform,
    arch: process.arch,
    isolationLevel: dedicatedAccount ? 'os_account_isolated' : 'env_and_config_isolated_same_os_user',
    boundaryDisclosure: dedicatedAccount
      ? 'Verification commands run under a dedicated low-privilege OS execution identity.'
      : 'Environment variables, HOME/USERPROFILE/APPDATA, Git config, and npm config are isolated per verification run, but child processes still execute under the same OS user identity (Windows Credential Manager / DPAPI and readable absolute host paths require a dedicated low-privilege OS user or ephemeral VM for strong OS boundary).',
    processTreeCleanup: process.platform === 'win32' ? 'taskkill_tree' : 'process_group_sigkill',
    toolchains,
    measuredAt: new Date().toISOString(),
  };
}
