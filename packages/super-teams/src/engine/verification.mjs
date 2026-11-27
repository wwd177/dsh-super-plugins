import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathMatchesWriteScopes } from './scheduler.mjs';
import {
  exportCandidateForTesting,
  sealCandidateAndDiff,
  storeGitPatch,
} from './git-worktree.mjs';
import { buildIsolatedTestEnv, killProcessTree } from './core/src/process-isolation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const outputLimit = 1024 * 1024;
// Keep the fixed -e script below Windows' process command-line limit.
const scriptLimit = 16 * 1024;

export const ALLOWED_TEST_COMMANDS = Object.freeze(['node', 'pytest', 'python', 'python3', 'cargo', 'go', 'dotnet', 'npm']);
const ALLOWED_TEST_COMMAND_SET = new Set(ALLOWED_TEST_COMMANDS);
const NODE_FORBIDDEN_FLAGS = new Set([
  '-e', '--eval', '-p', '--print', '-r', '--require', '--import',
  '--loader', '--experimental-loader', '-c', '--check', '-i', '--interactive',
  '--inspect', '--inspect-brk', '--env-file', '--title',
]);
const NPM_FORBIDDEN_FLAGS = new Set(['--script-shell', '--prefix', '--userconfig', '--globalconfig', '--cache']);
const CARGO_FORBIDDEN_FLAGS = new Set(['--manifest-path', '--config']);
const GO_FORBIDDEN_FLAGS = new Set(['-exec', '-toolexec']);
const PYTEST_FORBIDDEN_FLAGS = new Set(['-c', '--config-file', '--rootdir', '--eval']);

export function isBehavioralCheck(check) {
  return check?.type === 'node_test' || check?.type === 'command_test';
}

export function validRelative(value) {
  if (typeof value !== 'string' || !value || /[:\0]/.test(value) || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('Check path must stay within the task workspace');
}

export function secureFile(cwd, relative) {
  validRelative(relative);
  const base = fs.realpathSync(cwd);
  if (path.resolve(cwd) !== base) throw new Error('Workspace path was replaced or linked');
  let current = base;
  for (const segment of relative.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed in artifact checks');
  }
  if (!fs.statSync(current).isFile()) throw new Error('Artifact is not a regular file');
  return current;
}

function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  if (!value || typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new Error('expected must be JSON with finite numbers and safe integers');
  ancestors.add(value);
  if (Object.getOwnPropertySymbols(value).length || (Array.isArray(value) && (Object.keys(value).length !== value.length || Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index))))) throw new Error('expected must be a dense JSON value');
  for (const item of Object.values(value)) jsonValue(item, ancestors);
  ancestors.delete(value);
}

function pointerParts(pointer) {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/')) || /~(?:[^01]|$)/.test(pointer)) throw new Error('Invalid RFC6901 JSON pointer');
  return pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function flagName(arg) {
  const eq = arg.indexOf('=');
  return (eq >= 0 ? arg.slice(0, eq) : arg).toLowerCase();
}

function assertSafeCommandArg(arg) {
  if (typeof arg !== 'string' || !arg.length || arg.length > 512 || /[\0\r\n]/.test(arg)) {
    throw new Error('command_test args must be non-empty single-line strings up to 512 characters');
  }
  const valuePart = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
  if (valuePart.split(/[\\/]/).includes('..')) {
    throw new Error(`command_test argument must not traverse parent directories: ${arg}`);
  }
  // Reject absolute paths (POSIX /foo or Windows C:\foo, \\server\share), while allowing relative ./foo or Go ./...
  if (/^[a-zA-Z]:[\\/]/.test(valuePart) || valuePart.startsWith('\\\\') || (!arg.startsWith('-') && valuePart.startsWith('/')) || (arg.includes('=') && valuePart.startsWith('/'))) {
    throw new Error(`command_test argument must not reference absolute host paths: ${arg}`);
  }
}

export function validateCommandTest(check) {
  if (check.path !== undefined && check.path !== '.') validRelative(check.path);
  if (typeof check.command !== 'string' || !check.command.trim() || /[\\/\0\s]/.test(check.command.trim())) {
    throw new Error(`command_test command must be one of: ${ALLOWED_TEST_COMMANDS.join(', ')}`);
  }
  const cmd = check.command.trim().toLowerCase();
  if (!ALLOWED_TEST_COMMAND_SET.has(cmd)) {
    throw new Error(`Unsupported command_test runner "${check.command}"; allowed structured runners: ${ALLOWED_TEST_COMMANDS.join(', ')}`);
  }
  const args = check.args === undefined ? [] : check.args;
  if (!Array.isArray(args) || args.length > 32) {
    throw new Error('command_test args must be an array of at most 32 strings');
  }
  for (const arg of args) assertSafeCommandArg(arg);

  if (cmd === 'node') {
    if (args[0] !== '--test') {
      throw new Error('command_test with "node" must invoke structured test runner "node --test ..." (inline eval flags are forbidden)');
    }
    for (const arg of args) {
      if (NODE_FORBIDDEN_FLAGS.has(flagName(arg))) {
        throw new Error(`command_test with "node" forbids flag: ${arg}`);
      }
    }
  } else if (cmd === 'python' || cmd === 'python3') {
    if (args[0] !== '-m' || !['pytest', 'unittest'].includes(args[1])) {
      throw new Error(`command_test with "${cmd}" must invoke "-m pytest" or "-m unittest"`);
    }
    for (const arg of args.slice(2)) {
      const f = flagName(arg);
      if (f === '-c' || f === '--command' || f === '-i' || arg === '-' || PYTEST_FORBIDDEN_FLAGS.has(f)) {
        throw new Error(`command_test with "${cmd}" forbids flag: ${arg}`);
      }
    }
  } else if (cmd === 'pytest') {
    for (const arg of args) {
      if (PYTEST_FORBIDDEN_FLAGS.has(flagName(arg))) {
        throw new Error(`command_test with "pytest" forbids flag: ${arg}`);
      }
    }
  } else if (cmd === 'cargo') {
    if (args[0] !== 'test') throw new Error('command_test with "cargo" must start with "test"');
    for (const arg of args) {
      if (CARGO_FORBIDDEN_FLAGS.has(flagName(arg))) throw new Error(`command_test with "cargo" forbids flag: ${arg}`);
    }
  } else if (cmd === 'go') {
    if (args[0] !== 'test') throw new Error('command_test with "go" must start with "test"');
    for (const arg of args) {
      if (GO_FORBIDDEN_FLAGS.has(flagName(arg))) throw new Error(`command_test with "go" forbids flag: ${arg}`);
    }
  } else if (cmd === 'dotnet') {
    if (args[0] !== 'test') throw new Error('command_test with "dotnet" must start with "test"');
    const DOTNET_FORBIDDEN_FLAGS = new Set(['-p', '--property', '/p', '-t', '--target', '/t', '--test-adapter-path', '--settings', '-s', '--diag', '--logger', '--results-directory', '-r', '--msbuildprojectextensionspath', '--binarylogger', '-bl']);
    for (const arg of args) {
      const f = flagName(arg);
      if (DOTNET_FORBIDDEN_FLAGS.has(f) || /^(?:-|\/)(?:p|property|t|target)(?:[:=]|$)/i.test(arg)) {
        throw new Error(`command_test with "dotnet" forbids flag: ${arg}`);
      }
    }
  } else if (cmd === 'npm') {
    const validTest = args[0] === 'test';
    const validRunTest = args[0] === 'run' && typeof args[1] === 'string' && /^test(?:[:_-][a-z0-9_-]+)?$/i.test(args[1]);
    if (!validTest && !validRunTest) {
      throw new Error('command_test with "npm" only allows "npm test" or "npm run test[:name]"');
    }
    for (const arg of args) {
      if (NPM_FORBIDDEN_FLAGS.has(flagName(arg))) throw new Error(`command_test with "npm" forbids flag: ${arg}`);
      if (/[&|<>^%!"`\r\n]/.test(arg)) throw new Error(`command_test with "npm" forbids shell metacharacters in argument: ${arg}`);
    }
  }

  if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 120000)) {
    throw new Error('command_test timeoutMs must be 100..120000');
  }
}

export function validateCheck(check) {
  if (!check || !['file_exists', 'file_contains', 'json_equals', 'node_test', 'command_test'].includes(check.type)) throw new Error('Unsupported artifact check');
  if (check.type === 'command_test') {
    validateCommandTest(check);
    return;
  }
  validRelative(check.path);
  if (check.type === 'file_contains' && typeof check.value !== 'string') throw new Error('Unsupported artifact check');
  if (check.type === 'json_equals') {
    pointerParts(check.pointer);
    if (!Object.hasOwn(check, 'expected')) throw new Error('json_equals requires expected');
    jsonValue(check.expected);
  }
  if (check.type === 'node_test') {
    const hasInlineScript = typeof check.testScript === 'string' && check.testScript.trim().length > 0;
    if (hasInlineScript) {
      if (Buffer.byteLength(check.testScript, 'utf8') > scriptLimit) throw new Error('node_test inline testScript exceeds 16 KiB limit');
    } else if (!/^[a-f0-9]{64}$/.test(check.sourceId ?? '') || !/^[a-f0-9]{64}$/.test(check.sha256 ?? '')) {
      throw new Error('node_test requires either testScript or a fixed sourceId and sha256');
    }
    if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 100 || check.timeoutMs > 120000)) throw new Error('node_test timeoutMs must be 100..120000');
  }
}

// Compare decimal spellings exactly before JSON.parse can silently round a value.
function decimalKey(token) {
  const [mantissa, exponent = '0'] = token.toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [integer, fraction = ''] = mantissa.replace(/^-/, '').split('.');
  let digits = (integer + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  let power = BigInt(exponent) - BigInt(fraction.length);
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); power++; }
  return `${negative ? '-' : ''}${digits}e${power}`;
}

function parseJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || decimalKey(context.source) !== decimalKey(String(value)))) throw new Error('JSON number loses precision or exceeds the safe integer range');
    return value;
  });
}

function selectJson(value, pointer) {
  for (const part of pointerParts(pointer)) {
    if (!value || typeof value !== 'object' || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) || !Object.hasOwn(value, part)) throw new Error(`JSON pointer does not exist: ${pointer}`);
    value = value[part];
  }
  return value;
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

function sourceScript(store, check) {
  const ref = store.verifySources([check.sourceId])[0];
  if (ref.sha256 !== check.sha256) throw new Error('node_test source hash mismatch');
  const source = store.readSource(check.sourceId, { limit: scriptLimit + 1 });
  if (source.totalBytes > scriptLimit || source.nextOffset !== null || hash(Buffer.from(source.text)) !== check.sha256) throw new Error('node_test source exceeds limit or hash mismatch');
  return source.text;
}

export function validateTestSource(store, check) { if (check.type === 'node_test') sourceScript(store, check); }

function buildSanitizedTestEnv(testTmpDir) {
  return buildIsolatedTestEnv(testTmpDir, { preserveElectronAsNode: true });
}

function resolveWindowsNpmLaunch(args) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const pathDirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (fs.existsSync(path.join(dir, 'npm.cmd'))) {
      candidates.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  const npmCli = candidates.find(candidate => fs.existsSync(candidate));
  if (npmCli) {
    return { exec: process.execPath, argv: [npmCli, ...args] };
  }
  const npmCmdDir = pathDirs.find(dir => fs.existsSync(path.join(dir, 'npm.cmd')));
  if (npmCmdDir) {
    for (const arg of args) {
      if (/[&|<>^%!"`\r\n]/.test(arg)) throw new Error(`Unsafe cmd metacharacter in npm argument: ${arg}`);
    }
    // Fallback without shell interpolation of untrusted characters: pass npm.cmd and each arg via env vars to cmd /d /s /c.
    const npmCmdPath = path.join(npmCmdDir, 'npm.cmd');
    const extraEnv = { __SA_NPM_CMD: npmCmdPath };
    const refs = [];
    args.forEach((arg, idx) => {
      const k = `__SA_ARG_${idx}`;
      extraEnv[k] = arg;
      refs.push(`"%${k}%"`);
    });
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { exec: comspec, argv: ['/d', '/s', '/c', `"\"%__SA_NPM_CMD%\"${refs.length ? ' ' + refs.join(' ') : ''}"`], extraEnv, windowsVerbatimArguments: true };
  }
  return { exec: 'npm', argv: args };
}

function resolveRunnerLaunch(command, args) {
  const cmd = command.trim().toLowerCase();
  if (cmd === 'node') {
    return { exec: process.execPath, argv: args };
  }
  if (cmd === 'npm' && process.platform === 'win32') {
    return resolveWindowsNpmLaunch(args);
  }
  return { exec: cmd, argv: args };
}

function detectZeroExecutedTests(cmd, args, stdoutText, stderrText) {
  const combined = `${stdoutText}\n${stderrText}`;
  if (cmd === 'node') {
    if (/(?:^|\n)\s*[#ℹ]\s*tests\s+0\b/.test(combined)) {
      return 'command_test (node --test) executed 0 tests';
    }
    if (/(?:^|\n)\s*[#ℹ]\s*pass\s+0\b/.test(combined)) {
      return 'command_test (node --test) passed 0 tests (all skipped/todo or empty suite)';
    }
  }
  if ((cmd === 'python' || cmd === 'python3') && args[1] === 'unittest' && /\bRan 0 tests\b/.test(combined)) {
    return 'command_test (python -m unittest) executed 0 tests';
  }
  if (cmd === 'cargo' && /\brunning 0 tests\b/i.test(combined) && !/\brunning [1-9]\d* tests?\b/i.test(combined)) {
    return 'command_test (cargo test) executed 0 tests';
  }
  if (cmd === 'go' && (/\[no tests to run\]/.test(combined) || (/\[no test files\]/.test(combined) && !/^(?:ok\s|PASS\b)/m.test(combined)))) {
    return 'command_test (go test) executed 0 tests';
  }
  return null;
}

export function commandTestSelfModificationConflict(checks = [], changedPaths = []) {
  if (!Array.isArray(checks) || !Array.isArray(changedPaths) || !changedPaths.length) return null;
  const normChanged = new Set(changedPaths.map(p => String(p).replace(/\\/g, '/').replace(/^\.\//, '')));
  for (const check of checks) {
    if (check?.type !== 'command_test') continue;
    const cmd = String(check.command ?? '').trim().toLowerCase();
    if (cmd === 'npm' && normChanged.has('package.json')) {
      return 'autoAccept blocked: candidate modified package.json while using npm command_test; explicit review/accept or pre-registered node_test is required';
    }
    for (const arg of check.args ?? []) {
      if (typeof arg !== 'string' || arg.startsWith('-')) continue;
      const normArg = arg.replace(/\\/g, '/').replace(/^\.\//, '');
      if (normChanged.has(normArg)) {
        return `autoAccept blocked: candidate modified command_test target "${normArg}"; explicit review/accept or pre-registered node_test is required`;
      }
    }
  }
  return null;
}

function removeOwnedTempDir(dirPath) {
  if (!dirPath) return;
  try {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

async function runProcessWithEvidence({ label, exec, argv, cwd, extraEnv = {}, timeoutMs, evidenceDir, windowsVerbatimArguments = false }) {
  let files = null;
  let descriptors = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const shortId = randomUUID().replace(/-/g, '').slice(0, 12);
    const prefix = `${label}-${shortId}`;
    const candFiles = Object.fromEntries(['stdout', 'stderr'].map(stream => [stream, path.join(evidenceDir, `${prefix}.${stream}.txt`)]));
    if (process.platform === 'win32') {
      const overPath = Object.values(candFiles).find(file => file.length >= 250);
      if (overPath) {
        throw new Error(`Evidence output path exceeds Windows MAX_PATH safe budget (${overPath.length} chars): ${overPath}`);
      }
    }
    const opened = {};
    const createdFiles = [];
    try {
      for (const [stream, file] of Object.entries(candFiles)) {
        opened[stream] = fs.openSync(file, 'wx');
        createdFiles.push(file);
      }
      files = candFiles;
      descriptors = opened;
      break;
    } catch (err) {
      for (const fd of Object.values(opened)) { try { fs.closeSync(fd); } catch {} }
      for (const created of createdFiles) { try { fs.rmSync(created, { force: true }); } catch {} }
      if (err.code === 'EEXIST' && attempt < 7) continue;
      throw err;
    }
  }
  const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v-'));
  let iso = null;
  let bytes = 0, reason = null, code = null, signal = null;
  try {
    iso = buildSanitizedTestEnv(testTmpDir);
    const env = { ...iso.env, ...extraEnv };
    await new Promise(resolve => {
      const child = spawn(exec, argv, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stop = message => {
        reason = message;
        killProcessTree(child);
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
      };
      const timer = setTimeout(() => stop(`${label} timed out`), timeoutMs);
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
        const remaining = Math.max(0, outputLimit - bytes);
        const kept = chunk.subarray(0, remaining);
        if (kept.length) fs.writeSync(descriptors[stream], kept);
        bytes += kept.length;
        if (chunk.length > remaining) stop(`${label} output limit exceeded`);
      });
      child.on('error', error => { reason = `${label} launch failed: ${error.message}`; });
      child.on('close', (exitCode, exitSignal) => {
        clearTimeout(timer);
        // Ensure no background descendants survive past test exit.
        killProcessTree(child);
        code = exitCode;
        signal = exitSignal;
        resolve();
      });
    });
  } finally {
    Object.values(descriptors || {}).forEach(fd => { try { fs.closeSync(fd); } catch {} });
    try { iso?.cleanup?.(); } catch {}
    removeOwnedTempDir(testTmpDir);
  }
  const rawBuffers = {};
  const output = Object.fromEntries(Object.entries(files).map(([stream, file]) => {
    const data = fs.readFileSync(file);
    rawBuffers[stream] = data;
    return [stream, { file, bytes: data.length, sha256: hash(data), preview: data.subarray(0, 4096).toString('utf8'), truncated: data.length > 4096 }];
  }));
  return { code, signal, reason, output, rawBuffers };
}

async function runNodeTest({ cwd, check, sourceStore, evidenceDir, filename }) {
  const script = sourceScript(sourceStore, check);
  const run = await runProcessWithEvidence({
    label: 'node-test',
    exec: process.execPath,
    argv: ['--input-type=commonjs', '-e', script, filename],
    cwd,
    timeoutMs: check.timeoutMs ?? 5000,
    evidenceDir,
  });
  let reason = run.reason;
  const evidence = { sourceId: check.sourceId, scriptSha256: check.sha256, exitCode: run.code, signal: run.signal, output: run.output, outputLimitBytes: outputLimit, outputComplete: reason === null };
  try { sourceScript(sourceStore, check); } catch (error) { reason = error.message; }
  if (reason || run.code !== 0) throw Object.assign(new Error(reason ?? `node_test exited with code ${run.code}`), { evidence });
  return evidence;
}

export async function runCommandTest({ cwd, check, evidenceDir }) {
  validateCommandTest(check);
  const cmd = check.command.trim().toLowerCase();
  const args = check.args ?? [];
  const launch = resolveRunnerLaunch(cmd, args);
  const run = await runProcessWithEvidence({
    label: 'command-test',
    exec: launch.exec,
    argv: launch.argv,
    cwd,
    extraEnv: launch.extraEnv ?? {},
    windowsVerbatimArguments: Boolean(launch.windowsVerbatimArguments),
    timeoutMs: check.timeoutMs ?? 30000,
    evidenceDir,
  });
  let reason = run.reason;
  if (!reason && run.code === 0) {
    reason = detectZeroExecutedTests(cmd, args, run.rawBuffers.stdout.toString('utf8'), run.rawBuffers.stderr.toString('utf8'));
  }
  const evidence = {
    command: cmd,
    args,
    exitCode: run.code,
    signal: run.signal,
    output: run.output,
    outputLimitBytes: outputLimit,
    outputComplete: run.reason === null,
  };
  if (reason || run.code !== 0) throw Object.assign(new Error(reason ?? `command_test (${cmd}) exited with code ${run.code}`), { evidence });
  return evidence;
}

export async function runStandaloneCheck({ cwd, check, sourceStore, evidenceDir }) {
  validateCheck(check);
  if (check.type === 'command_test') {
    if (check.path && check.path !== '.') secureFile(cwd, check.path);
    return runCommandTest({ cwd, check, evidenceDir });
  }
  if (check.type === 'node_test') {
    const filename = secureFile(cwd, check.path);
    if (!sourceStore && typeof check.testScript === 'string' && check.testScript.trim()) {
      const run = await runProcessWithEvidence({
        label: 'integration-node-test',
        exec: process.execPath,
        argv: ['--input-type=commonjs', '-e', check.testScript, filename],
        cwd,
        timeoutMs: check.timeoutMs ?? 15000,
        evidenceDir,
      });
      const evidence = { exitCode: run.code, signal: run.signal, output: run.output, outputLimitBytes: outputLimit, outputComplete: run.reason === null };
      if (run.reason || run.code !== 0) throw Object.assign(new Error(run.reason ?? `node_test exited with code ${run.code}`), { evidence });
      return evidence;
    }
    return runNodeTest({ cwd, check, sourceStore, evidenceDir, filename });
  }
  throw new Error('Integration check must be a behavioral command_test or node_test');
}

export async function hashArtifact(filename,{capture=false,maxBytes=64*1024*1024}={}) {
  const before=await fs.promises.lstat(filename,{bigint:true});
  if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1n)throw new Error('Artifact must be an independent regular file without links');
  const file=await fs.promises.open(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try {
    const opened=await file.stat({bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||opened.dev!==before.dev||opened.ino!==before.ino)throw new Error('Artifact identity changed while opening');
    const limit=capture?Math.min(maxBytes,1024*1024):maxBytes;
    const tooLarge=()=>new Error(capture?'Text artifact checks are limited to 1 MiB; use a registered node_test for larger files':'Artifact exceeds the 64 MiB file limit');
    const openedSize=Number(opened.size);
    if(!Number.isSafeInteger(openedSize)||openedSize>limit)throw tooLarge();
    const digest=createHash('sha256'),chunks=[];let bytes=0;
    for await(const chunk of file.createReadStream({autoClose:false,highWaterMark:64*1024})) {
      bytes+=chunk.length;if(bytes>limit)throw tooLarge();digest.update(chunk);if(capture)chunks.push(chunk);
    }
    if(bytes!==openedSize)throw new Error('Artifact changed size during read');
    return {sha256:digest.digest('hex'),bytes,...(capture?{data:Buffer.concat(chunks)}:{})};
  } finally {await file.close();}
}

export async function artifactFiles(task, records = task.verification?.files ?? [], cwdOverride = null) {
  const baseCwd = cwdOverride ?? task.cwd;
  const files=[];
  for(const record of records)files.push({...record,...await hashArtifact(secureFile(baseCwd,record.path))});
  return files;
}

function findOutOfScopeWorkspaceFiles(cwd, writeScopes) {
  if (!Array.isArray(writeScopes) || !writeScopes.length || !cwd || !fs.existsSync(cwd)) return [];
  const root = fs.realpathSync(cwd);
  if (path.resolve(cwd) !== root) throw new Error('Workspace path was replaced or linked');
  const skipTop = new Set(['context-sources', 'dependencies', 'node_modules', '.git']);
  const violations = [];
  const walk = (dir, rel, depth) => {
    if (depth > 32) {
      throw new Error(`Workspace directory nesting exceeds 32 levels at ${rel}; cannot certify writeScopes`);
    }
    if (violations.length >= 16) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (violations.length >= 16) break;
      if (depth === 0 && skipTop.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const st = fs.lstatSync(full, { bigint: true });
      if (st.isSymbolicLink()) {
        violations.push(`${childRel} (symlink)`);
        continue;
      }
      if (st.isDirectory()) {
        let realChild;
        try { realChild = fs.realpathSync(full); } catch { violations.push(`${childRel} (unresolvable directory link)`); continue; }
        const normA = process.platform === 'win32' ? realChild.toLowerCase() : realChild;
        const normB = process.platform === 'win32' ? path.resolve(full).toLowerCase() : path.resolve(full);
        if (normA !== normB) {
          violations.push(`${childRel} (junction)`);
          continue;
        }
        walk(full, childRel, depth + 1);
      } else if (!pathMatchesWriteScopes(childRel, writeScopes)) violations.push(childRel);
    }
  };
  walk(root, '', 0);
  return violations;
}

function assertWriteScopesClean(task, checks, stageLabel) {
  const scopeViolations = findOutOfScopeWorkspaceFiles(task.cwd, task.writeScopes);
  if (scopeViolations.length) {
    const msg = `Write scope violation (${stageLabel}): undeclared file(s) produced outside writeScopes (${task.writeScopes.join(', ')}): ${scopeViolations.join(', ')}`;
    checks.push({ type: 'write_scope_guard', path: scopeViolations[0], stage: stageLabel, passed: false, error: msg, violations: scopeViolations });
    throw new Error(msg);
  }
}

export async function verifyArtifacts({ task, sourceStore, evidenceDir, dataDir = null, excludeEngineDirs = [] }) {
  const files = [], checks = [];
  const isWorktree = task.workspaceMode === 'git-worktree' && Boolean(task.attemptStartCommit);
  let gitMeta = null;
  let verifyExportDir = null;
  const hasBehavioral = task.checks.some(isBehavioralCheck);
  const result = () => ({
    at: new Date().toISOString(),
    status: task.checks.length ? 'passed' : 'not_verified',
    passed: task.checks.length ? true : null,
    files,
    checks,
    ...(gitMeta ? { git: gitMeta } : {}),
    artifactOnly: !hasBehavioral,
    hostCompletionStatus: task.completionStatus ?? null,
    scope: isWorktree
      ? 'Git worktree candidate was sealed against attemptStartCommit, audited by two-tree diff against writeScopes, and verified on an isolated .git-free export copy; caller acceptance is separate'
      : 'Registered checks and declared writeScopes (pre-test and post-test) were evaluated; caller acceptance is separate; node_test/command_test execute trusted registered runners without an OS sandbox',
  });
  try {
    let evalCwd = task.cwd;
    let sealed = null;
    if (isWorktree) {
      try {
        sealed = await sealCandidateAndDiff({
          cwd: task.cwd,
          attemptStartCommit: task.attemptStartCommit,
          writeScopes: task.writeScopes ?? null,
          excludeEngineDirs,
        });
      } catch (err) {
        checks.push({ type: 'write_scope_guard', path: '.', stage: 'two-tree-diff', passed: false, error: err.message });
        throw err;
      }
      if (!evidenceDir) throw new Error('git-worktree verification requires an attempt evidence directory');
      verifyExportDir = path.join(evidenceDir, `verify-export-${randomUUID()}`);
      await exportCandidateForTesting({ cwd: task.cwd, candidateCommit: sealed.candidateCommit, destDir: verifyExportDir });
      evalCwd = verifyExportDir;
    } else {
      assertWriteScopesClean(task, checks, 'pre-check');
    }

    const checkedRecords = [];
    for (const check of task.checks) {
      validateCheck(check);
      const isWorkspaceRootCmd = check.type === 'command_test' && (!check.path || check.path === '.');
      let filename = null, record = null, bytes = null;
      if (!isWorkspaceRootCmd) {
        filename = secureFile(evalCwd, check.path);
        const measured = await hashArtifact(filename, { capture: ['file_contains', 'json_equals'].includes(check.type) });
        bytes = measured.data;
        record = { path: check.path, sha256: measured.sha256, bytes: measured.bytes, type: check.type };
      }
      let evidence;
      try {
        if (check.type === 'file_contains' && !bytes.toString('utf8').includes(check.value)) throw new Error(`Artifact does not contain required value: ${check.path}`);
        if (check.type === 'json_equals' && !jsonEqual(selectJson(parseJson(bytes.toString('utf8')), check.pointer), check.expected)) throw new Error(`JSON value does not equal expected: ${check.path}${check.pointer}`);
        if (check.type === 'node_test') evidence = await runNodeTest({ cwd: evalCwd, check, sourceStore, evidenceDir, filename });
        if (check.type === 'command_test') evidence = await runCommandTest({ cwd: evalCwd, check, evidenceDir });
        if (record && (await hashArtifact(secureFile(evalCwd, check.path))).sha256 !== record.sha256) throw new Error('Artifact changed during verification');
      } catch (error) {
        checks.push({ type: check.type, path: check.path ?? '.', passed: false, error: error.message, ...((error.evidence ?? evidence) ? { evidence: error.evidence ?? evidence } : {}) });
        throw error;
      }
      if (record) {
        checkedRecords.push(record);
        files.push(record);
      }
      checks.push({ type: check.type, path: check.path ?? '.', passed: true, ...(evidence ? { evidence } : {}) });
    }

    if (checkedRecords.length && !isDeepStrictEqual(await artifactFiles(task, checkedRecords, evalCwd), checkedRecords)) {
      throw new Error('Artifact changed during verification');
    }

    if (isWorktree && sealed) {
      // Include all changed regular files from the sealed candidateCommit in the verified file list so snapshots capture the exact worktree diff.
      const seenPaths = new Set(files.map(f => f.path.replace(/\\/g, '/')));
      for (const relPath of sealed.changedPaths) {
        const norm = relPath.replace(/\\/g, '/');
        if (seenPaths.has(norm)) continue;
        const measured = await hashArtifact(secureFile(evalCwd, norm));
        files.push({ path: norm, sha256: measured.sha256, bytes: measured.bytes, type: 'git_changed' });
        seenPaths.add(norm);
      }
      const persisted = dataDir ? storeGitPatch({ dataDir, patchBuffer: sealed.patchBuffer, patchSha256: sealed.patchSha256 }) : { patchFile: null, patchSha256: sealed.patchSha256, patchBytes: sealed.patchBytes };
      gitMeta = {
        workspaceMode: 'git-worktree',
        attemptStartCommit: sealed.attemptStartCommit,
        candidateTree: sealed.candidateTree,
        candidateCommit: sealed.candidateCommit,
        patchFile: persisted.patchFile,
        patchSha256: persisted.patchSha256,
        patchBytes: persisted.patchBytes,
        changes: sealed.changes,
        changedPaths: sealed.changedPaths,
        deletedPaths: sealed.deletedPaths,
      };
    } else {
      assertWriteScopesClean(task, checks, 'post-check');
    }

    return result();
  } catch (error) {
    error.verification = { ...result(), status: 'failed', passed: false, error: error.message };
    throw error;
  } finally {
    if (verifyExportDir && fs.existsSync(verifyExportDir)) {
      try { fs.rmSync(verifyExportDir, { recursive: true, force: true }); } catch {}
    }
  }
}
