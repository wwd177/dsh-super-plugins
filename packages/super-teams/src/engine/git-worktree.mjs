import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathMatchesWriteScopes } from './scheduler.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[a-f0-9]{40,64}$/;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

const SAFE_GIT_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMP', 'TEMP', 'TMPDIR',
]);

function normalizePathForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(child, parent) {
  const c = normalizePathForCompare(child);
  const p = normalizePathForCompare(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function buildGitEnv(extraEnv = {}) {
  const env = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && SAFE_GIT_ENV_KEYS.has(key.toUpperCase())) env[key] = val;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  for (const [key, val] of Object.entries(extraEnv)) {
    if (val === undefined || val === null) delete env[key];
    else env[key] = String(val);
  }
  return env;
}

export function runGit(args, { cwd, env: extraEnv = {}, input = null, timeoutMs = 60000, maxBytes = MAX_GIT_OUTPUT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: buildGitEnv(extraEnv),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    let totalBytes = 0;
    let settled = false;
    let abortReason = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    const stop = reason => {
      abortReason = reason;
      killProcessTree(child);
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
    };

    const timer = setTimeout(() => stop(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`), timeoutMs);
    timer.unref?.();

    const collect = (target, chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        stop(`git ${args[0] ?? ''} output exceeded ${maxBytes} bytes`);
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', chunk => collect(outChunks, chunk));
    child.stderr.on('data', chunk => collect(errChunks, chunk));
    child.on('error', err => finish(new Error(`git launch failed: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (abortReason) return finish(new Error(abortReason));
      finish(null, {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });

    if (input !== null && input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function gitOk(args, opts) {
  const res = await runGit(args, opts);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout.toString('utf8')).trim().slice(0, 600);
    throw new Error(`git ${args[0] ?? ''} failed (code ${res.code})${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

function fixedCommitEnv(extra = {}) {
  return {
    GIT_AUTHOR_NAME: 'SuperAgent Engine',
    GIT_AUTHOR_EMAIL: 'superagent@local.invalid',
    GIT_AUTHOR_DATE: '1700000000 +0000',
    GIT_COMMITTER_NAME: 'SuperAgent Engine',
    GIT_COMMITTER_EMAIL: 'superagent@local.invalid',
    GIT_COMMITTER_DATE: '1700000000 +0000',
    ...extra,
  };
}

export function validateGitRepoSync(repoPath, dataDir) {
  if (typeof repoPath !== 'string' || !repoPath.trim() || repoPath.includes('\0')) {
    throw new Error('repoPath must be a non-empty absolute path to a Git repository');
  }
  const raw = repoPath.trim();
  if (!path.isAbsolute(raw)) throw new Error('repoPath must be an absolute path');
  if (!fs.existsSync(raw)) throw new Error('repoPath does not exist');
  const st = fs.lstatSync(raw);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('repoPath must be a real directory (not a symbolic link)');
  const realRepo = fs.realpathSync(raw);
  if (dataDir) {
    const realData = fs.existsSync(dataDir) ? fs.realpathSync(dataDir) : path.resolve(dataDir);
    if (isSameOrInside(realRepo, realData) || isSameOrInside(realData, realRepo)) {
      throw new Error('repoPath must not overlap with the engine data directory');
    }
  }
  const gitSync = args => spawnSync('git', args, { cwd: realRepo, env: buildGitEnv(), shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  const inside = gitSync(['rev-parse', '--is-inside-work-tree']);
  if (inside.error) throw new Error(`git launch failed: ${inside.error.message}`);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') throw new Error('repoPath is not inside a Git working tree');
  const topRes = gitSync(['rev-parse', '--show-toplevel']);
  if (topRes.status !== 0) throw new Error(`Failed to resolve Git repository root: ${topRes.stderr.trim()}`);
  const topReal = fs.realpathSync(topRes.stdout.trim());
  if (normalizePathForCompare(topReal) !== normalizePathForCompare(realRepo)) {
    throw new Error(`repoPath must be the Git repository root (${topReal})`);
  }
  const headRes = gitSync(['rev-parse', '--verify', 'HEAD']);
  const baseCommit = (headRes.stdout || '').trim();
  if (headRes.status !== 0 || !OID_RE.test(baseCommit)) {
    throw new Error('Git repository must have a valid HEAD commit before creating a git-worktree team');
  }
  const branchRes = gitSync(['symbolic-ref', '--short', '-q', 'HEAD']);
  const baseBranch = branchRes.status === 0 ? (branchRes.stdout || '').trim() || null : null;
  return { repoPath: realRepo, baseCommit, baseBranch };
}

export async function validateGitRepo(repoPath, dataDir) {
  if (typeof repoPath !== 'string' || !repoPath.trim() || repoPath.includes('\0')) {
    throw new Error('repoPath must be a non-empty absolute path to a Git repository');
  }
  const raw = repoPath.trim();
  if (!path.isAbsolute(raw)) throw new Error('repoPath must be an absolute path');
  if (!fs.existsSync(raw)) throw new Error('repoPath does not exist');
  const st = fs.lstatSync(raw);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('repoPath must be a real directory (not a symbolic link)');
  const realRepo = fs.realpathSync(raw);
  if (dataDir) {
    const realData = fs.existsSync(dataDir) ? fs.realpathSync(dataDir) : path.resolve(dataDir);
    if (isSameOrInside(realRepo, realData) || isSameOrInside(realData, realRepo)) {
      throw new Error('repoPath must not overlap with the engine data directory');
    }
  }
  const inside = (await gitOk(['rev-parse', '--is-inside-work-tree'], { cwd: realRepo })).stdout.toString('utf8').trim();
  if (inside !== 'true') throw new Error('repoPath is not inside a Git working tree');
  const topRaw = (await gitOk(['rev-parse', '--show-toplevel'], { cwd: realRepo })).stdout.toString('utf8').trim();
  const topReal = fs.realpathSync(topRaw);
  if (normalizePathForCompare(topReal) !== normalizePathForCompare(realRepo)) {
    throw new Error(`repoPath must be the Git repository root (${topReal})`);
  }
  const headRes = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: realRepo });
  const baseCommit = headRes.stdout.toString('utf8').trim();
  if (headRes.code !== 0 || !OID_RE.test(baseCommit)) {
    throw new Error('Git repository must have a valid HEAD commit before creating a git-worktree team');
  }
  const branchRes = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: realRepo });
  const baseBranch = branchRes.code === 0 ? branchRes.stdout.toString('utf8').trim() || null : null;
  return { repoPath: realRepo, baseCommit, baseBranch };
}

export function assertNoSymlinksOrJunctions(rootDir, { skipTop = new Set(['.git', 'context-sources', 'dependencies', 'node_modules']) } = {}) {
  const realRoot = fs.realpathSync(rootDir);
  if (normalizePathForCompare(path.resolve(rootDir)) !== normalizePathForCompare(realRoot)) {
    throw new Error('Workspace path was replaced or linked');
  }
  const violations = [];
  const walk = (dir, rel, depth) => {
    if (depth > 32) {
      throw new Error(`Workspace directory nesting exceeds 32 levels at ${rel}; cannot certify git worktree`);
    }
    if (violations.length >= 16) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (violations.length >= 16) break;
      if (depth === 0 && skipTop.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const st = fs.lstatSync(full, { bigint: true });
      if (st.isSymbolicLink()) {
        violations.push(`${childRel} (symlink/junction)`);
        continue;
      }
      if (st.isDirectory()) {
        // Double-check Windows directory junctions / reparse points via realpathSync comparison.
        let realChild;
        try { realChild = fs.realpathSync(full); } catch { violations.push(`${childRel} (unresolvable directory link)`); continue; }
        if (normalizePathForCompare(realChild) !== normalizePathForCompare(path.resolve(full))) {
          violations.push(`${childRel} (junction/reparse-point)`);
          continue;
        }
        walk(full, childRel, depth + 1);
      }
    }
  };
  walk(realRoot, '', 0);
  if (violations.length) {
    throw new Error(`Write scope violation (symlink/junction): symbolic links and directory junctions are forbidden in worktrees: ${violations.join(', ')}`);
  }
}

export async function removeAttemptWorktree({ repoPath, cwd, allowedBaseDir = null }) {
  if (!cwd) return;
  const resolvedCwd = path.resolve(cwd);
  if (allowedBaseDir && !isSameOrInside(resolvedCwd, allowedBaseDir)) {
    throw new Error('Refusing to remove worktree outside engine data directory');
  }
  try {
    await runGit(['worktree', 'remove', '--force', resolvedCwd], { cwd: repoPath, timeoutMs: 30000 });
  } catch {}
  if (fs.existsSync(resolvedCwd)) {
    try { fs.rmSync(resolvedCwd, { recursive: true, force: true }); } catch {}
  }
  try {
    await runGit(['worktree', 'prune'], { cwd: repoPath, timeoutMs: 30000 });
  } catch {}
}

export async function prepareAttemptWorktree({ repoPath, baseCommit, cwd, dependencyPatches = [], allowedBaseDir = null }) {
  if (!OID_RE.test(baseCommit ?? '')) throw new Error('Invalid baseCommit for git worktree');
  if (fs.existsSync(cwd)) throw new Error('Attempt worktree target directory already exists');
  await gitOk(['worktree', 'add', '--detach', cwd, baseCommit], { cwd: repoPath, timeoutMs: 60000 });
  const appliedDependencies = [];
  try {
    let anyApplied = false;
    for (const dep of dependencyPatches) {
      const patchBuf = Buffer.isBuffer(dep.patchBytes) ? dep.patchBytes : Buffer.from(dep.patchBytes ?? '');
      if (patchBuf.length === 0) {
        appliedDependencies.push({ taskId: dep.taskId, snapshotId: dep.snapshotId, patchSha256: dep.patchSha256, empty: true });
        continue;
      }
      const applyRes = await runGit(['apply', '--index', '--whitespace=nowarn'], { cwd, input: patchBuf, timeoutMs: 60000 });
      if (applyRes.code !== 0) {
        const priorSummary = appliedDependencies.map(d => `${d.taskId}@${d.snapshotId.slice(0, 12)}`).join(', ') || 'baseCommit';
        const detail = (applyRes.stderr || applyRes.stdout.toString('utf8')).trim().slice(0, 400);
        throw Object.assign(
          new Error(`Dependency patch conflict while replaying ${dep.taskId} (snapshot ${dep.snapshotId}) after [${priorSummary}]: ${detail}`),
          {
            code: 'WORKTREE_DEPENDENCY_CONFLICT',
            conflictingTaskId: dep.taskId,
            conflictingSnapshotId: dep.snapshotId,
            appliedDependencies,
          },
        );
      }
      anyApplied = true;
      appliedDependencies.push({ taskId: dep.taskId, snapshotId: dep.snapshotId, patchSha256: dep.patchSha256, empty: false });
    }
    if (anyApplied) {
      const diffCheck = await runGit(['diff', '--cached', '--quiet'], { cwd });
      if (diffCheck.code === 1) {
        await gitOk(['commit', '--no-gpg-sign', '--no-verify', '-m', 'superagent: replay accepted dependencies'], {
          cwd,
          env: fixedCommitEnv(),
        });
      }
    }
    const attemptStartCommit = (await gitOk(['rev-parse', '--verify', 'HEAD'], { cwd })).stdout.toString('utf8').trim();
    return { cwd, baseCommit, attemptStartCommit, appliedDependencies };
  } catch (error) {
    await removeAttemptWorktree({ repoPath, cwd, allowedBaseDir }).catch(() => {});
    throw error;
  }
}

export async function treeContainsTopLevelPath({ cwd, commit, name }) {
  const res = await runGit(['ls-tree', '--name-only', commit, '--', name], { cwd });
  return res.code === 0 && res.stdout.toString('utf8').trim().length > 0;
}

function parseRawDiffZ(buffer) {
  const changes = [];
  let offset = 0;
  while (offset < buffer.length) {
    const metaEnd = buffer.indexOf(0, offset);
    if (metaEnd === -1) break;
    const meta = buffer.subarray(offset, metaEnd).toString('utf8');
    offset = metaEnd + 1;
    if (!meta.startsWith(':')) continue;
    const parts = meta.slice(1).split(' ');
    if (parts.length < 5) continue;
    const [oldMode, newMode, oldOid, newOid, status] = parts;
    const path1End = buffer.indexOf(0, offset);
    if (path1End === -1) break;
    const path1 = buffer.subarray(offset, path1End).toString('utf8');
    offset = path1End + 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      const path2End = buffer.indexOf(0, offset);
      if (path2End === -1) break;
      const path2 = buffer.subarray(offset, path2End).toString('utf8');
      offset = path2End + 1;
      changes.push({ oldMode, newMode, oldOid, newOid, status, oldPath: path1, path: path2 });
    } else {
      changes.push({ oldMode, newMode, oldOid, newOid, status, path: path1 });
    }
  }
  return changes;
}

export async function sealCandidateAndDiff({ cwd, attemptStartCommit, writeScopes = null, excludeEngineDirs = [] }) {
  if (!OID_RE.test(attemptStartCommit ?? '')) throw new Error('Invalid attemptStartCommit');
  const safeExcludes = [];
  for (const dir of excludeEngineDirs) {
    if (!dir) continue;
    // Never exclude a path that actually existed in attemptStartCommit (it belongs to the repo).
    if (!(await treeContainsTopLevelPath({ cwd, commit: attemptStartCommit, name: dir }))) {
      safeExcludes.push(dir);
    }
  }
  // Reject any symlink or Windows directory junction in the working tree first.
  assertNoSymlinksOrJunctions(cwd, { skipTop: new Set(['.git', 'node_modules', ...safeExcludes]) });

  const tmpIndex = path.join(os.tmpdir(), `superagent-idx-${randomUUID()}`);
  try {
    // Seed temporary index from attemptStartCommit so tracked files matching .gitignore are never dropped on add -A.
    await gitOk(['read-tree', attemptStartCommit], { cwd, env: { GIT_INDEX_FILE: tmpIndex }, timeoutMs: 60000 });
    const addArgs = ['add', '-A', '--', '.'];
    for (const dir of safeExcludes) addArgs.push(`:(exclude)${dir}`);
    await gitOk(addArgs, { cwd, env: { GIT_INDEX_FILE: tmpIndex }, timeoutMs: 60000 });
    const candidateTree = (await gitOk(['write-tree'], { cwd, env: { GIT_INDEX_FILE: tmpIndex } })).stdout.toString('utf8').trim();
    const candidateCommit = (await gitOk(
      ['commit-tree', candidateTree, '-p', attemptStartCommit, '-m', 'superagent: sealed candidate'],
      { cwd, env: fixedCommitEnv({ GIT_INDEX_FILE: tmpIndex }) },
    )).stdout.toString('utf8').trim();

    // Two-tree diff against attemptStartCommit: catches commits made on detached HEAD, renames, deletions, mode changes, symlinks.
    const rawDiff = (await gitOk(['diff', '--raw', '--find-renames', '-z', attemptStartCommit, candidateCommit], { cwd })).stdout;
    const changes = parseRawDiffZ(rawDiff);

    const modeViolations = [];
    for (const change of changes) {
      if (change.newMode === '120000') modeViolations.push(`${change.path} (git symlink 120000)`);
      if (change.newMode === '160000') modeViolations.push(`${change.path} (git submodule 160000)`);
    }
    if (modeViolations.length) {
      throw new Error(`Write scope violation (two-tree diff): forbidden git entry mode(s): ${modeViolations.join(', ')}`);
    }

    if (Array.isArray(writeScopes) && writeScopes.length > 0) {
      const violations = [];
      for (const change of changes) {
        if (change.status.startsWith('R')) {
          const oldOk = pathMatchesWriteScopes(change.oldPath, writeScopes);
          const newOk = pathMatchesWriteScopes(change.path, writeScopes);
          if (!oldOk || !newOk) {
            violations.push(`${change.status} ${change.oldPath} -> ${change.path}`);
          }
        } else {
          if (!pathMatchesWriteScopes(change.path, writeScopes)) {
            violations.push(`${change.status} ${change.path}`);
          }
        }
        if (violations.length >= 16) break;
      }
      if (violations.length) {
        throw new Error(`Write scope violation (two-tree diff): changes outside writeScopes (${writeScopes.join(', ')}): ${violations.join(', ')}`);
      }
    }

    const patchRes = await gitOk(['diff', '--binary', '--full-index', attemptStartCommit, candidateCommit], {
      cwd,
      maxBytes: MAX_PATCH_BYTES,
    });
    const patchBuffer = patchRes.stdout;
    if (patchBuffer.length > MAX_PATCH_BYTES) {
      throw new Error(`Candidate git patch exceeds ${MAX_PATCH_BYTES} bytes limit`);
    }
    const patchSha256 = hash(patchBuffer);
    const changedPaths = [...new Set(changes.filter(c => !c.status.startsWith('D')).map(c => c.path))].sort();
    const deletedPaths = [...new Set(changes.filter(c => c.status.startsWith('D') || c.status.startsWith('R')).map(c => c.oldPath ?? c.path))].sort();

    return {
      attemptStartCommit,
      candidateTree,
      candidateCommit,
      patchBuffer,
      patchSha256,
      patchBytes: patchBuffer.length,
      changes: changes.map(({ status, path: p, oldPath, oldMode, newMode }) => ({ status, path: p, ...(oldPath ? { oldPath } : {}), oldMode, newMode })),
      changedPaths,
      deletedPaths,
    };
  } finally {
    try { if (fs.existsSync(tmpIndex)) fs.rmSync(tmpIndex, { force: true }); } catch {}
  }
}

export async function exportCandidateForTesting({ cwd, candidateCommit, destDir }) {
  if (!OID_RE.test(candidateCommit ?? '')) throw new Error('Invalid candidateCommit');
  if (fs.existsSync(destDir)) throw new Error('Export test directory already exists');
  fs.mkdirSync(destDir, { recursive: true });
  const tmpIndex = path.join(os.tmpdir(), `superagent-export-idx-${randomUUID()}`);
  try {
    const gitDir = (await gitOk(['rev-parse', '--absolute-git-dir'], { cwd })).stdout.toString('utf8').trim();
    const prefix = `${path.resolve(destDir).replace(/\\/g, '/').replace(/\/+$/, '')}/`;
    const gitEnv = { GIT_DIR: gitDir, GIT_INDEX_FILE: tmpIndex };
    await gitOk(['read-tree', candidateCommit], { cwd: destDir, env: gitEnv });
    await gitOk(['-c', 'core.autocrlf=false', '-c', 'core.symlinks=false', 'checkout-index', '-a', '-f', `--prefix=${prefix}`], { cwd: destDir, env: gitEnv });
    if (fs.existsSync(path.join(destDir, '.git'))) {
      throw new Error('Isolated test export unexpectedly contains .git metadata');
    }
    return destDir;
  } catch (error) {
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    throw error;
  } finally {
    try { if (fs.existsSync(tmpIndex)) fs.rmSync(tmpIndex, { force: true }); } catch {}
  }
}

export function storeGitPatch({ dataDir, patchBuffer, patchSha256 }) {
  const actualSha = hash(patchBuffer);
  if (actualSha !== patchSha256) throw new Error('Patch SHA-256 mismatch before persistence');
  const dir = path.join(dataDir, 'git-patches');
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, `${patchSha256}.patch`);
  const rel = path.relative(dataDir, filename).replace(/\\/g, '/');
  if (fs.existsSync(filename)) {
    const st = fs.lstatSync(filename, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1n) throw new Error('Stored git patch is not an independent regular file');
    const existing = fs.readFileSync(filename);
    if (hash(existing) !== patchSha256) throw new Error('Existing stored git patch hash mismatch');
    return { patchFile: rel, patchSha256, patchBytes: existing.length };
  }
  const tmp = path.join(dir, `.tmp-${randomUUID()}.patch`);
  try {
    fs.writeFileSync(tmp, patchBuffer, { flag: 'wx', mode: 0o600 });
    try {
      fs.renameSync(tmp, filename);
    } catch (err) {
      if (!fs.existsSync(filename)) throw err;
      const existing = fs.readFileSync(filename);
      if (hash(existing) !== patchSha256) throw new Error('Concurrent stored git patch hash mismatch');
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch {}
  }
  return { patchFile: rel, patchSha256, patchBytes: patchBuffer.length };
}

export function readVerifiedGitPatch({ dataDir, patchFile, patchSha256 }) {
  if (typeof patchFile !== 'string' || !patchFile || !/^[a-f0-9]{64}$/.test(patchSha256 ?? '')) {
    throw new Error('Invalid git patch reference');
  }
  const full = path.resolve(dataDir, patchFile);
  if (!isSameOrInside(full, path.join(dataDir, 'git-patches'))) {
    throw new Error('Git patch path escapes git-patches storage');
  }
  const st = fs.lstatSync(full, { bigint: true });
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1n) {
    throw new Error('Git patch file must be an independent regular file');
  }
  if (Number(st.size) > MAX_PATCH_BYTES) throw new Error('Git patch exceeds size limit');
  const bytes = fs.readFileSync(full);
  if (hash(bytes) !== patchSha256) throw new Error('Stored git patch SHA-256 mismatch');
  return bytes;
}

export function sanitizeSuperagentBranch(branchName, teamId) {
  let raw = typeof branchName === 'string' ? branchName.trim() : '';
  if (raw.startsWith('refs/heads/')) raw = raw.slice('refs/heads/'.length);
  if (raw.startsWith('superagent/')) raw = raw.slice('superagent/'.length);
  if (!raw) {
    const prefix = String(teamId ?? 'team').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'team';
    raw = `team-${prefix}-${Date.now().toString(36)}`;
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw) || raw.includes('..') || raw.endsWith('.') || raw.endsWith('.lock')) {
    throw new Error('branchName must be a safe slug under superagent/<slug> (alphanumeric, ".", "_", "-", 1..64 chars, no ".." or ".lock")');
  }
  return { slug: raw, branch: `superagent/${raw}`, ref: `refs/heads/superagent/${raw}` };
}

export async function runTeamMerge({
  repoPath,
  baseCommit,
  teamId,
  orderedAcceptedTasks,
  dataDir,
  integrationCheck = null,
  sourceStore = null,
  evidenceDir = null,
  apply = false,
  branchName = null,
  runIntegrationCheck = null,
}) {
  const repoInfo = await validateGitRepo(repoPath, dataDir);
  if (!OID_RE.test(baseCommit ?? '')) throw new Error('Team is missing a valid baseCommit');
  await gitOk(['cat-file', '-e', `${baseCommit}^{commit}`], { cwd: repoInfo.repoPath });
  if (!Array.isArray(orderedAcceptedTasks) || !orderedAcceptedTasks.length) {
    throw new Error('No accepted git-worktree tasks are ready to merge');
  }

  const branchTarget = apply ? sanitizeSuperagentBranch(branchName, teamId) : null;
  const loadedPatches = orderedAcceptedTasks.map(task => {
    const gitMeta = task.acceptance?.git;
    if (!gitMeta?.patchFile || !gitMeta?.patchSha256) {
      throw new Error(`Accepted task ${task.id} is missing frozen git patch metadata`);
    }
    const patchBytes = readVerifiedGitPatch({
      dataDir,
      patchFile: gitMeta.patchFile,
      patchSha256: gitMeta.patchSha256,
    });
    return {
      taskId: task.id,
      title: task.title,
      snapshotId: task.acceptance.snapshotId,
      patchSha256: gitMeta.patchSha256,
      patchBytes,
    };
  });

  const stagingRoot = path.join(dataDir, 'merge-staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const runId = `${String(teamId).replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'team'}-${randomUUID()}`;
  const stagingDir = path.join(stagingRoot, `wt-${runId}`);
  const testExportDir = path.join(stagingRoot, `test-${runId}`);
  let cleanupWarning = null;

  try {
    await gitOk(['worktree', 'add', '--detach', stagingDir, baseCommit], { cwd: repoInfo.repoPath, timeoutMs: 60000 });
    const appliedTasks = [];
    for (const item of loadedPatches) {
      if (item.patchBytes.length === 0) {
        appliedTasks.push({ taskId: item.taskId, title: item.title, snapshotId: item.snapshotId, patchSha256: item.patchSha256, emptyPatch: true });
        continue;
      }
      const res = await runGit(['apply', '--index', '--whitespace=nowarn'], { cwd: stagingDir, input: item.patchBytes, timeoutMs: 60000 });
      if (res.code !== 0) {
        const conflict = {
          taskId: item.taskId,
          title: item.title,
          snapshotId: item.snapshotId,
          patchSha256: item.patchSha256,
          priorTasks: appliedTasks.map(t => ({ taskId: t.taskId, snapshotId: t.snapshotId })),
          detail: (res.stderr || res.stdout.toString('utf8')).trim().slice(0, 800),
        };
        if (apply) {
          throw Object.assign(
            new Error(`Merge conflict while applying task ${item.taskId} (snapshot ${item.snapshotId}): ${conflict.detail}`),
            { code: 'MERGE_CONFLICT', conflict },
          );
        }
        return {
          ok: false,
          mode: 'preview',
          repoPath: repoInfo.repoPath,
          baseCommit,
          appliedTasks,
          conflict,
          note: 'Preview validated in a temporary detached git worktree (subsequently removed); your active checkout and branches were not modified.',
        };
      }
      appliedTasks.push({ taskId: item.taskId, title: item.title, snapshotId: item.snapshotId, patchSha256: item.patchSha256, emptyPatch: false });
    }

    const mergedTree = (await gitOk(['write-tree'], { cwd: stagingDir })).stdout.toString('utf8').trim();
    const commitMsg = `superagent: merge team ${teamId}\n\nBase: ${baseCommit}\nTasks:\n${appliedTasks.map(t => `- ${t.taskId} (snapshot ${t.snapshotId})`).join('\n')}\n`;
    const mergedCommit = (await gitOk(
      ['commit-tree', mergedTree, '-p', baseCommit, '-m', commitMsg],
      { cwd: stagingDir, env: fixedCommitEnv() },
    )).stdout.toString('utf8').trim();

    const statRes = await gitOk(['diff', '--stat', baseCommit, mergedCommit], { cwd: stagingDir });
    const rawDiff = (await gitOk(['diff', '--raw', '--find-renames', '-z', baseCommit, mergedCommit], { cwd: stagingDir })).stdout;
    const changedFiles = parseRawDiffZ(rawDiff).map(({ status, path: p, oldPath }) => ({ status, path: p, ...(oldPath ? { oldPath } : {}) }));

    let integrationResult = null;
    if (integrationCheck) {
      if (typeof runIntegrationCheck !== 'function') throw new Error('Integration check runner is unavailable');
      await exportCandidateForTesting({ cwd: stagingDir, candidateCommit: mergedCommit, destDir: testExportDir });
      try {
        const evidence = await runIntegrationCheck({ cwd: testExportDir, check: integrationCheck, sourceStore, evidenceDir });
        integrationResult = { passed: true, type: integrationCheck.type, evidence };
      } catch (err) {
        integrationResult = { passed: false, type: integrationCheck.type, error: err.message, ...(err.evidence ? { evidence: err.evidence } : {}) };
        if (apply) {
          throw Object.assign(new Error(`Integration check failed on merged commit ${mergedCommit}: ${err.message}`), {
            code: 'INTEGRATION_CHECK_FAILED',
            integrationCheck: integrationResult,
          });
        }
        return {
          ok: false,
          mode: 'preview',
          repoPath: repoInfo.repoPath,
          baseCommit,
          mergedCommit,
          appliedTasks,
          diffStat: statRes.stdout.toString('utf8').trim(),
          changedFiles,
          integrationCheck: integrationResult,
          note: 'Preview validated in a temporary detached git worktree (subsequently removed); your active checkout and branches were not modified.',
        };
      }
    }

    if (apply) {
      // Guard against any active worktree whose HEAD (including an unborn HEAD) already points to the target branch.
      const wtList = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoInfo.repoPath });
      if (wtList.code === 0) {
        const lines = wtList.stdout.toString('utf8').split(/\r?\n/);
        if (lines.some(line => line.trim() === `branch ${branchTarget.ref}`)) {
          throw Object.assign(
            new Error(`Refusing to publish ${branchTarget.branch}: an active worktree already has ${branchTarget.ref} checked out`),
            { code: 'MERGE_BRANCH_CHECKED_OUT' },
          );
        }
      }
      // Atomic create-only ref publication: expected old OID = 40 zeros ensures concurrent calls or existing branches fail cleanly.
      const publishRes = await runGit(['update-ref', branchTarget.ref, mergedCommit, ZERO_OID], { cwd: repoInfo.repoPath });
      if (publishRes.code !== 0) {
        const detail = (publishRes.stderr || publishRes.stdout.toString('utf8')).trim().slice(0, 400);
        throw Object.assign(
          new Error(`Atomic branch publish failed for ${branchTarget.branch} (branch may already exist or another merge_apply won the race): ${detail}`),
          { code: 'MERGE_BRANCH_EXISTS' },
        );
      }
    }

    return {
      ok: true,
      mode: apply ? 'apply' : 'preview',
      repoPath: repoInfo.repoPath,
      baseCommit,
      mergedCommit,
      ...(branchTarget ? { branch: branchTarget.branch, ref: branchTarget.ref } : {}),
      appliedTasks,
      diffStat: statRes.stdout.toString('utf8').trim(),
      changedFiles,
      ...(integrationResult ? { integrationCheck: integrationResult } : {}),
      note: apply
        ? `Published atomically to new branch ${branchTarget.branch} (${mergedCommit.slice(0, 12)}) without modifying your active working tree or existing branches.`
        : 'Preview validated in a temporary detached git worktree (subsequently removed); your active checkout and branches were not modified.',
    };
  } finally {
    const warnings = [];
    if (fs.existsSync(testExportDir)) {
      try { fs.rmSync(testExportDir, { recursive: true, force: true }); }
      catch (err) { warnings.push(`testExportDir cleanup failed: ${err.message}`); }
    }
    try {
      await removeAttemptWorktree({ repoPath: repoInfo.repoPath, cwd: stagingDir, allowedBaseDir: stagingRoot });
    } catch (err) {
      warnings.push(`staging worktree cleanup failed: ${err.message}`);
    }
    if (warnings.length) cleanupWarning = warnings.join('; ');
  }
}
