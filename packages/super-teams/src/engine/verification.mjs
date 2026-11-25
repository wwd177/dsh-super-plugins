import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathMatchesWriteScopes } from './scheduler.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const outputLimit = 1024 * 1024;
// Keep the fixed -e script below Windows' process command-line limit.
const scriptLimit = 16 * 1024;

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

export function validateCheck(check) {
  if (!check || !['file_exists', 'file_contains', 'json_equals', 'node_test'].includes(check.type)) throw new Error('Unsupported artifact check');
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

const SAFE_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NODE_NO_WARNINGS',
]);

async function runNodeTest({ task, check, sourceStore, evidenceDir, filename }) {
  const script = sourceScript(sourceStore, check);
  const prefix = `node-test-${randomUUID()}`;
  const testTmpDir = path.join(evidenceDir, `${prefix}-tmp`);
  fs.mkdirSync(testTmpDir, { recursive: true });
  const files = Object.fromEntries(['stdout', 'stderr'].map(stream => [stream, path.join(evidenceDir, `${prefix}.${stream}.txt`)]));
  const descriptors = Object.fromEntries(Object.entries(files).map(([stream, file]) => [stream, fs.openSync(file, 'wx')]));
  const env = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && SAFE_ENV_KEYS.has(key.toUpperCase())) env[key] = val;
  }
  // DeepSeek Harness Desktop uses Electron as process.execPath; force pure Node mode so node_test never opens a GUI window.
  env.ELECTRON_RUN_AS_NODE = '1';
  env.TMP = testTmpDir;
  env.TEMP = testTmpDir;
  env.TMPDIR = testTmpDir;
  let bytes = 0, reason = null, code = null, signal = null;
  try {
    await new Promise(resolve => {
      // The caller registers trusted code; this is an execution gate, not an OS sandbox.
      const child = spawn(process.execPath, ['--input-type=commonjs', '-e', script, filename], { cwd: task.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = message => { reason = message; child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); };
      const timer = setTimeout(() => stop('node_test timed out'), check.timeoutMs ?? 5000);
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
        const remaining = Math.max(0, outputLimit - bytes);
        const kept = chunk.subarray(0, remaining);
        if (kept.length) fs.writeSync(descriptors[stream], kept);
        bytes += kept.length;
        if (chunk.length > remaining) stop('node_test output limit exceeded');
      });
      child.on('error', error => { reason = `node_test launch failed: ${error.message}`; });
      child.on('close', (exitCode, exitSignal) => { clearTimeout(timer); code = exitCode; signal = exitSignal; resolve(); });
    });
  } finally {
    Object.values(descriptors).forEach(fd => fs.closeSync(fd));
    try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch {}
  }
  const output = Object.fromEntries(Object.entries(files).map(([stream, file]) => {
    const data = fs.readFileSync(file);
    return [stream, { file, bytes: data.length, sha256: hash(data), preview: data.subarray(0, 4096).toString('utf8'), truncated: data.length > 4096 }];
  }));
  const evidence = { sourceId: check.sourceId, scriptSha256: check.sha256, exitCode: code, signal, output, outputLimitBytes: outputLimit, outputComplete: reason === null };
  try { sourceScript(sourceStore, check); } catch (error) { reason = error.message; }
  if (reason || code !== 0) throw Object.assign(new Error(reason ?? `node_test exited with code ${code}`), { evidence });
  return evidence;
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

export async function artifactFiles(task, records = task.verification?.files ?? []) {
  const files=[];
  for(const record of records)files.push({...record,...await hashArtifact(secureFile(task.cwd,record.path))});
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
      if (st.isDirectory()) walk(full, childRel, depth + 1);
      else if (!pathMatchesWriteScopes(childRel, writeScopes)) violations.push(childRel);
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

export async function verifyArtifacts({ task, sourceStore, evidenceDir }) {
  const files = [], checks = [];
  const result = () => ({ at: new Date().toISOString(), status: task.checks.length ? 'passed' : 'not_verified', passed: task.checks.length ? true : null, files, checks, artifactOnly: !task.checks.some(check => check.type === 'node_test'), hostCompletionStatus: task.completionStatus ?? null, scope: 'Registered checks and declared writeScopes (pre-test and post-test) were evaluated; caller acceptance is separate; node_test executes trusted registered code without an OS sandbox' });
  try {
    assertWriteScopesClean(task, checks, 'pre-check');
    for (const check of task.checks) {
      validateCheck(check);
      const filename = secureFile(task.cwd, check.path), measured = await hashArtifact(filename,{capture:['file_contains','json_equals'].includes(check.type)}),bytes=measured.data;
      const record = { path: check.path, sha256: measured.sha256, bytes: measured.bytes, type: check.type };
      let evidence;
      try {
        if (check.type === 'file_contains' && !bytes.toString('utf8').includes(check.value)) throw new Error(`Artifact does not contain required value: ${check.path}`);
        if (check.type === 'json_equals' && !jsonEqual(selectJson(parseJson(bytes.toString('utf8')), check.pointer), check.expected)) throw new Error(`JSON value does not equal expected: ${check.path}${check.pointer}`);
        if (check.type === 'node_test') evidence = await runNodeTest({ task, check, sourceStore, evidenceDir, filename });
        if ((await hashArtifact(secureFile(task.cwd, check.path))).sha256 !== record.sha256) throw new Error('Artifact changed during verification');
      } catch (error) {
        checks.push({ type: check.type, path: check.path, passed: false, error: error.message, ...((error.evidence ?? evidence) ? { evidence: error.evidence ?? evidence } : {}) });
        throw error;
      }
      files.push(record); checks.push({ type: check.type, path: check.path, passed: true, ...(evidence ? { evidence } : {}) });
    }
    // A later test must not silently rewrite an earlier checked artifact or leave out-of-scope files in task.cwd.
    if (!isDeepStrictEqual(await artifactFiles(task, files), files)) throw new Error('Artifact changed during verification');
    assertWriteScopesClean(task, checks, 'post-check');
    return result();
  } catch (error) { error.verification = { ...result(), status: 'failed', passed: false, error: error.message }; throw error; }
}
