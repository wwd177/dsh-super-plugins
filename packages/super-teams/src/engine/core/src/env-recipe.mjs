import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildIsolatedTestEnv, killProcessTree } from './process-isolation.mjs';

const now = () => new Date().toISOString();

/**
 * 仓库环境与测试命令只读探测（Phase 1 / v0.20）：
 * 仅识别锁文件与候选测试命令供用户明确确认一次，绝不自动替用户暗选易过的短脚本。
 */
export function probeRepoEnvironment(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }
  const realRepo = fs.realpathSync(repoPath);
  const lockfiles = [];
  const candidateCommands = [];
  const ecosystems = [];

  const checkLock = (name, eco) => {
    if (fs.existsSync(path.join(realRepo, name))) {
      lockfiles.push({ file: name, ecosystem: eco });
    }
  };
  checkLock('package-lock.json', 'node');
  checkLock('pnpm-lock.yaml', 'node');
  checkLock('yarn.lock', 'node');
  checkLock('uv.lock', 'python');
  checkLock('poetry.lock', 'python');
  checkLock('requirements.txt', 'python');
  checkLock('Cargo.lock', 'rust');
  checkLock('go.sum', 'go');

  const pkgJsonPath = path.join(realRepo, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    ecosystems.push('node');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      for (const [key, scriptBody] of Object.entries(scripts)) {
        if (key === 'test' || /^test[:_-]/i.test(key)) {
          candidateCommands.push({
            id: `npm:${key}`,
            ecosystem: 'node',
            command: 'npm',
            args: key === 'test' ? ['test'] : ['run', key],
            rawScript: String(scriptBody).slice(0, 300),
            requiresUserConfirmation: true,
          });
        }
      }
    } catch {}
    if (fs.existsSync(path.join(realRepo, 'tests'))) {
      candidateCommands.push({
        id: 'node:tests',
        ecosystem: 'node',
        command: 'node',
        args: ['--test'],
        rawScript: 'node --test',
        requiresUserConfirmation: true,
      });
    }
  }

  if (fs.existsSync(path.join(realRepo, 'pyproject.toml')) || fs.existsSync(path.join(realRepo, 'pytest.ini'))) {
    ecosystems.push('python');
    candidateCommands.push({
      id: 'python:pytest',
      ecosystem: 'python',
      command: 'python',
      args: ['-m', 'pytest'],
      rawScript: 'python -m pytest',
      requiresUserConfirmation: true,
    });
  }

  if (fs.existsSync(path.join(realRepo, 'Cargo.toml'))) {
    ecosystems.push('rust');
    candidateCommands.push({
      id: 'cargo:test',
      ecosystem: 'rust',
      command: 'cargo',
      args: ['test'],
      rawScript: 'cargo test',
      requiresUserConfirmation: true,
    });
  }

  if (fs.existsSync(path.join(realRepo, 'go.mod'))) {
    ecosystems.push('go');
    candidateCommands.push({
      id: 'go:test',
      ecosystem: 'go',
      command: 'go',
      args: ['test', './...'],
      rawScript: 'go test ./...',
      requiresUserConfirmation: true,
    });
  }

  return {
    repoPath: realRepo,
    ecosystems: [...new Set(ecosystems)],
    lockfiles,
    candidateCommands,
    autoSelected: false,
    note: 'Detected candidates only. Confirm the exact test command once before freezing goal criteria.',
    probedAt: now(),
  };
}

export function approveEnvRecipe(store, teamId, {
  repoPath,
  selectedCommands = [],
  setupCommand = null,
  envVars = {},
  approvedBy = 'maintainer',
} = {}) {
  if (!repoPath) throw new Error('repoPath is required');
  if (typeof approvedBy !== 'string' || !approvedBy.trim()) {
    throw new Error('approvedBy identity is required');
  }
  const normalized = {
    repoPath: path.resolve(repoPath),
    selectedCommands: Array.isArray(selectedCommands) ? selectedCommands : [],
    setupCommand: setupCommand ? String(setupCommand) : null,
    envVars: envVars && typeof envVars === 'object' ? envVars : {},
  };
  const recipeHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const record = {
    id: `recipe-${randomUUID().slice(0, 12)}`,
    teamId,
    ...normalized,
    recipeHash,
    approved: true,
    approvedBy: approvedBy.trim(),
    approvedAt: now(),
  };
  store.saveEnvRecipe(record);
  return record;
}

/**
 * 每 Worktree 独立环境、动态端口租约与并发服务生命周期管理器（v0.20）：
 * 取消其中 1 个 worktree 仅回收该 worktree 的进程树与端口租约，不影响其他并发服务。
 */
export class WorktreeEnvManager {
  constructor() {
    this.allocatedPorts = new Set();
    this.services = new Map(); // worktreeId -> { pid, child, port, tempDir, recipeHash }
  }

  async allocatePort() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          const p = addr?.port;
          srv.close(() => resolve(p));
        });
      });
      if (port && !this.allocatedPorts.has(port)) {
        this.allocatedPorts.add(port);
        return port;
      }
    }
    throw new Error('Failed to allocate a free local TCP port');
  }

  async startWorktreeService({
    worktreeId,
    cwd,
    command,
    args = [],
    readyUrl = null,
    recipeHash = null,
    extraEnv = {},
    timeoutMs = 10000,
  }) {
    if (!worktreeId || !cwd || !command) {
      throw new Error('worktreeId, cwd, and command are required');
    }
    if (this.services.has(worktreeId)) {
      await this.cancelWorktree(worktreeId);
    }

    const port = await this.allocatePort();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-wt-env-'));
    const { env } = buildIsolatedTestEnv(tempDir, {
      extraEnv: {
        ...extraEnv,
        PORT: String(port),
        SUPERAGENT_PORT: String(port),
        WORKTREE_ID: String(worktreeId),
      },
    });

    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entry = {
      worktreeId,
      pid: child.pid,
      child,
      port,
      tempDir,
      recipeHash,
      logs: '',
      exited: false,
    };
    this.services.set(worktreeId, entry);
    child.stdout?.on('data', chunk => {
      if (entry.logs.length < 16384) entry.logs += chunk.toString('utf8');
    });
    child.stderr?.on('data', chunk => {
      if (entry.logs.length < 16384) entry.logs += chunk.toString('utf8');
    });
    child.on('close', () => {
      entry.exited = true;
    });

    const targetUrl = readyUrl ? readyUrl.replace('{port}', String(port)) : `http://127.0.0.1:${port}/health`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (entry.exited) {
        await this.cancelWorktree(worktreeId);
        throw new Error(`Worktree service ${worktreeId} exited prematurely: ${entry.logs.slice(0, 400)}`);
      }
      try {
        const res = await fetch(targetUrl, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          return { worktreeId, pid: entry.pid, port, url: targetUrl, recipeHash };
        }
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }

    await this.cancelWorktree(worktreeId);
    throw new Error(`Worktree service ${worktreeId} failed to become ready within ${timeoutMs}ms`);
  }

  async cancelWorktree(worktreeId) {
    const entry = this.services.get(worktreeId);
    if (!entry) return false;
    this.services.delete(worktreeId);
    if (entry.pid) killProcessTree(entry.pid);
    this.allocatedPorts.delete(entry.port);
    try { fs.rmSync(entry.tempDir, { recursive: true, force: true }); } catch {}
    return true;
  }

  async closeAll() {
    for (const id of [...this.services.keys()]) {
      await this.cancelWorktree(id);
    }
  }
}
