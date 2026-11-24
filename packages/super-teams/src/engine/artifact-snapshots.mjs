import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const SNAPSHOT_LIMITS = Object.freeze({ maxFiles: 128, maxBlobBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxManifestBytes: 1024 * 1024 });
const chunkBytes = 64 * 1024, shaPattern = /^[a-f0-9]{64}$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const serialize = manifest => Buffer.from(`${JSON.stringify(manifest)}\n`);
function quotas(value = {}) {
  const result = { ...SNAPSHOT_LIMITS, ...value };
  for (const [key, number] of Object.entries(result)) if (!Object.hasOwn(SNAPSHOT_LIMITS, key) || !Number.isSafeInteger(number) || number < 0) throw new Error('Invalid snapshot quota');
  return result;
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || path.win32.isAbsolute(value) || /[<>:"|?*\x00-\x1f]/.test(value)) throw new Error('Snapshot path must be a safe relative path');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Snapshot path contains unsafe path segments');
  return parts.join('/');
}
function descriptor(value, withPath = false) {
  if (!value || typeof value !== 'object' || !shaPattern.test(value.sha256 ?? '')) throw new Error('Snapshot requires a SHA-256');
  if (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0)) throw new Error('Snapshot size must be a nonnegative integer');
  return { ...(withPath ? { path: relativePath(value.path) } : {}), sha256: value.sha256, ...(value.bytes !== undefined ? { bytes: value.bytes } : {}) };
}
function orderedFiles(files, limits) {
  if (!Array.isArray(files)) throw new Error('Snapshot files must be an array');
  const unique = new Map(), aliases = new Map();
  for (const file of files) {
    const record = descriptor(file, true), alias = record.path.toLowerCase();
    if (aliases.has(alias) && aliases.get(alias) !== record.path) throw new Error('Snapshot path alias conflict');
    aliases.set(alias, record.path);
    const previous = unique.get(record.path);
    if (previous && (previous.sha256 !== record.sha256 || (previous.bytes !== undefined && record.bytes !== undefined && previous.bytes !== record.bytes))) throw new Error('Snapshot path descriptor conflict');
    unique.set(record.path, previous?.bytes !== undefined ? previous : record);
    if (unique.size > limits.maxFiles) throw new Error('Snapshot file count quota exceeded');
  }
  for (const alias of aliases.keys()) for (let slash = alias.indexOf('/'); slash !== -1; slash = alias.indexOf('/', slash + 1)) if (aliases.has(alias.slice(0, slash))) throw new Error('Snapshot file/directory path conflict');
  return [...unique.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function directory(absolute, create = false) {
  const resolved = path.resolve(absolute); let current = path.parse(resolved).root;
  for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) { try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Snapshot directory must not contain links');
  }
  return resolved;
}
async function openFile(filename, { independent = true, maxBytes, identities } = {}) {
  await directory(path.dirname(filename)); const info = await fs.lstat(filename, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || (independent && info.nlink !== 1n)) throw new Error('Snapshot requires an independent regular file without links');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || (independent && opened.nlink !== 1n) || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Snapshot source identity changed while opening');
    if (opened.size > maxBytes) throw new Error('Snapshot per-file byte quota exceeded');
    if (identities) { const identity = `${opened.dev}:${opened.ino}`, previous = identities.get(identity); if (previous && previous !== filename) throw new Error('Snapshot source path alias conflict'); identities.set(identity, filename); }
    return { handle, size: Number(opened.size) };
  } catch (error) { await handle.close(); throw error; }
}
function compare(actual, expected = {}) {
  if (expected.bytes !== undefined && actual.bytes !== expected.bytes) throw new Error('Snapshot size mismatch');
  if (expected.sha256 !== undefined && actual.sha256 !== expected.sha256) throw new Error('Snapshot SHA-256 mismatch');
  return actual;
}
async function writeAll(handle, data) {
  let offset = 0;
  while (offset < data.length) { const { bytesWritten } = await handle.write(data, offset, data.length - offset); if (!bytesWritten) throw new Error('Snapshot write made no progress'); offset += bytesWritten; }
}
// A single reusable buffer and awaited writes keep hash and copy on exactly the same chunks.
async function streamFile(filename, { expected, independent = true, maxBytes, identities, destination, window } = {}) {
  const { handle } = await openFile(filename, { independent, maxBytes, identities });
  let output; const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(chunkBytes); let bytes = 0;
  try {
    if (destination) output = await fs.open(destination, 'wx', 0o600);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      if (bytes + bytesRead > maxBytes) throw new Error('Snapshot per-file byte quota exceeded');
      const chunk = buffer.subarray(0, bytesRead); digest.update(chunk);
      if (window) { const start = Math.max(bytes, window.offset), end = Math.min(bytes + bytesRead, window.offset + window.buffer.length); if (end > start) chunk.copy(window.buffer, start - window.offset, start - bytes, end - bytes); }
      if (output) await writeAll(output, chunk);
      bytes += bytesRead;
    }
    const actual = compare({ sha256: digest.digest('hex'), bytes }, expected);
    if (output) await output.sync();
    return actual;
  } finally { await handle.close(); if (output) await output.close(); }
}
export async function hashFile(filename, { limits } = {}) {
  return streamFile(filename, { independent: false, maxBytes: quotas(limits).maxBlobBytes });
}
export async function verifyFile({ filename, sha256, bytes, limits }) {
  const expected = descriptor({ sha256, bytes });
  return streamFile(filename, { expected, maxBytes: quotas(limits).maxBlobBytes });
}
async function checkedCopy(filename, destination, expected, limits, identities, independent = true) {
  const actual = await streamFile(filename, { expected, independent, destination, identities, maxBytes: limits.maxBlobBytes });
  await verifyFile({ filename: destination, ...actual, limits }); return actual;
}
async function writeSmall(filename, bytes) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await writeAll(handle, bytes); await handle.sync(); } finally { await handle.close(); }
}
async function readSmall(filename, maxBytes) {
  const { handle } = await openFile(filename, { maxBytes }); const chunks = []; let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, maxBytes + 1));
    while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; bytes += bytesRead; if (bytes > maxBytes) throw new Error('Snapshot manifest byte quota exceeded'); chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); }
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}
function manifestQuota(manifest, limits) {
  let total = 0;
  for (const file of [...manifest.files, ...(manifest.result ? [manifest.result] : [])]) { if (file.bytes === undefined) throw new Error('Snapshot manifest requires blob sizes'); if (file.bytes > limits.maxBlobBytes) throw new Error('Snapshot per-file byte quota exceeded'); total += file.bytes; if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) throw new Error('Snapshot total byte quota exceeded'); }
  const bytes = serialize(manifest); if (bytes.length > limits.maxManifestBytes) throw new Error('Snapshot manifest byte quota exceeded'); return bytes;
}
async function snapshotPath(root, id) {
  if (typeof id !== 'string' || !shaPattern.test(id)) throw new Error('Invalid snapshot id');
  return directory(path.join(await directory(root), id));
}
/** Metadata only: this validates manifest identity and quotas, not unrelated blob content. */
export async function readSnapshot({ root, id, limits: options }) {
  const limits = quotas(options), snapshot = await snapshotPath(root, id), bytes = await readSmall(path.join(snapshot, 'manifest.json'), limits.maxManifestBytes);
  if (hash(bytes) !== id) throw new Error('Snapshot manifest SHA-256 mismatch');
  let manifest; try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid snapshot manifest JSON'); }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !Object.hasOwn(manifest, 'result')) throw new Error('Invalid snapshot manifest structure');
  const canonical = { version: 1, files: orderedFiles(manifest.files, limits), result: manifest.result === null ? null : descriptor(manifest.result) };
  if (!manifestQuota(canonical, limits).equals(bytes)) throw new Error('Snapshot manifest must have canonical structure');
  return { id, manifest: canonical };
}
export async function verifySnapshot({ root, id, limits }) {
  const snapshot = await readSnapshot({ root, id, limits }), directoryName = await snapshotPath(root, id), checked = new Map();
  for (const record of [...snapshot.manifest.files, ...(snapshot.manifest.result ? [snapshot.manifest.result] : [])]) {
    if (checked.has(record.sha256)) compare(checked.get(record.sha256), record);
    else checked.set(record.sha256, await verifyFile({ filename: path.join(directoryName, 'blobs', record.sha256), ...record, limits }));
  }
  return snapshot;
}
async function cleanup(staging, parent) {
  if (!await exists(staging)) return;
  const verified = await directory(staging);
  if (path.dirname(verified) !== parent || !path.basename(verified).startsWith('.tmp-')) throw new Error('Unsafe snapshot staging cleanup path');
  await fs.rm(verified, { recursive: true });
}
/** Independent copies, atomic publication, no automatic removal of published history. No OS isolation or power-loss guarantee. */
export async function freezeSnapshot({ root, cwd, resultFile, resultSha256, files = [], limits: options }) {
  const limits = quotas(options), records = orderedFiles(files, limits);
  if (resultFile != null && (typeof resultFile !== 'string' || !resultFile || !shaPattern.test(resultSha256 ?? ''))) throw new Error('Snapshot result requires a file and SHA-256');
  if (resultFile == null && resultSha256 != null) throw new Error('Snapshot result SHA-256 requires a file');
  const workspace = await directory(cwd), storage = await directory(root, true), staging = path.join(storage, `.tmp-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  const manifest = { version: 1, files: [], result: null }, identities = new Map(), copied = new Map();
  let total = 0;
  try {
    await fs.mkdir(path.join(staging, 'blobs'));
    const copy = async (filename, expected) => {
      const remaining = { ...limits, maxBlobBytes: Math.min(limits.maxBlobBytes, limits.maxTotalBytes - total) };
      if (expected.bytes > remaining.maxBlobBytes) throw new Error('Snapshot byte quota exceeded');
      const actual = copied.has(expected.sha256) ? await streamFile(filename, { expected, independent: false, identities, maxBytes: remaining.maxBlobBytes }) : await checkedCopy(filename, path.join(staging, 'blobs', expected.sha256), expected, remaining, identities, false);
      copied.set(actual.sha256, actual); total += actual.bytes; if (!Number.isSafeInteger(total) || total > limits.maxTotalBytes) throw new Error('Snapshot total byte quota exceeded'); return actual;
    };
    for (const record of records) manifest.files.push({ path: record.path, ...await copy(path.join(workspace, ...record.path.split('/')), record) });
    if (resultFile != null) manifest.result = await copy(path.isAbsolute(resultFile) ? resultFile : path.join(workspace, ...relativePath(resultFile).split('/')), { sha256: resultSha256 });
    const bytes = manifestQuota(manifest, limits), id = hash(bytes), target = path.join(storage, id);
    await writeSmall(path.join(staging, 'manifest.json'), bytes);
    if (!(await readSmall(path.join(staging, 'manifest.json'), limits.maxManifestBytes)).equals(bytes)) throw new Error('Copied snapshot manifest differs');
    if (await exists(target)) await verifySnapshot({ root: storage, id, limits });
    else {
      try { await fs.rename(staging, target); } catch (error) { if (!await exists(target)) throw error; await verifySnapshot({ root: storage, id, limits }); }
    }
    return { id, manifestSha256: id, manifest };
  } finally { await cleanup(staging, storage); }
}
/** The destination must be new. Every file is verified from its copied bytes before the directory becomes visible. */
export async function copySnapshot({ root, id, destination, limits: options }) {
  const limits = quotas(options), snapshot = await readSnapshot({ root, id, limits }), source = await snapshotPath(root, id);
  const target = path.resolve(destination), parent = await directory(path.dirname(target), true);
  if (await exists(target)) throw new Error('Snapshot destination already exists');
  const staging = path.join(parent, `.tmp-${randomUUID()}`); await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const record of snapshot.manifest.files) {
      const output = path.join(staging, 'artifacts', ...record.path.split('/')); await directory(path.dirname(output), true);
      await checkedCopy(path.join(source, 'blobs', record.sha256), output, record, limits);
    }
    if (snapshot.manifest.result) await checkedCopy(path.join(source, 'blobs', snapshot.manifest.result.sha256), path.join(staging, 'result.txt'), snapshot.manifest.result, limits);
    if (await exists(target)) throw new Error('Snapshot destination already exists');
    await fs.rename(staging, target); return snapshot;
  } finally { await cleanup(staging, parent); }
}
function pageOptions(offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Result offset must be a nonnegative integer');
  if (!Number.isSafeInteger(limit) || limit < 4 || limit > 65536) throw new Error('Result limit must be 4..65536 bytes');
}
export async function readVerifiedFilePage({ filename, sha256, bytes, offset = 0, limit = 8192, limits: options }) {
  pageOptions(offset, limit); const expected = descriptor({ sha256, bytes }), window = { offset, buffer: Buffer.alloc(limit + 4) };
  const actual = await streamFile(filename, { expected, window, maxBytes: quotas(options).maxBlobBytes });
  const length = Math.min(window.buffer.length, Math.max(0, actual.bytes - offset)); let start = 0;
  while (start < length && (window.buffer[start] & 0xc0) === 0x80) start++;
  let end = Math.min(start + limit, length); while (end < length && end > start && (window.buffer[end] & 0xc0) === 0x80) end--;
  const aligned = Math.min(offset + start, actual.bytes), next = Math.min(offset + end, actual.bytes);
  return { text: window.buffer.subarray(start, end).toString('utf8'), offset: aligned, nextOffset: next < actual.bytes ? next : null, totalBytes: actual.bytes, sha256: actual.sha256 };
}
export async function readSnapshotResult({ root, id, offset = 0, limit = 8192, limits }) {
  pageOptions(offset, limit); const { manifest } = await readSnapshot({ root, id, limits });
  if (!manifest.result) return { text: '', offset: 0, nextOffset: null, totalBytes: 0 };
  return readVerifiedFilePage({ filename: path.join(await snapshotPath(root, id), 'blobs', manifest.result.sha256), ...manifest.result, offset, limit, limits });
}
/** Explicit metadata scan for a caller-managed cache; never follows links or reads blob contents. */
export async function scanSnapshotStorage({ root }) {
  const result = { bytes: 0, files: 0, snapshots: 0, stagingDirectories: 0 };
  if (!await exists(root)) return result;
  const storage = await directory(root);
  const visit = async (current, top = false) => {
    const entries = await fs.opendir(current);
    for await (const entry of entries) {
      const filename = path.join(current, entry.name), info = await fs.lstat(filename);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { if (top && shaPattern.test(entry.name)) result.snapshots++; if (top && entry.name.startsWith('.tmp-')) result.stagingDirectories++; await visit(filename); }
      else if (info.isFile()) { result.files++; result.bytes += info.size; }
    }
  };
  await visit(storage, true); return result;
}
