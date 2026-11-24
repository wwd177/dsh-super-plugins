'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isUtf8 } = require('node:buffer');

try {
  const [basename, ...args] = process.argv.slice(2);
  if (!/^[a-f0-9]{64}\.txt$/.test(basename ?? '')) throw new Error('Expected one source basename: <64hex>.txt');
  let offset = 0, limit = 8192, tail = false, expectedHash;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--offset', '--limit', '--tail', '--sha256'].includes(flag) || seen.has(flag)) throw new Error('Unknown or duplicate reader option');
    seen.add(flag);
    if (flag === '--tail') { tail = true; continue; }
    const value = args[++index];
    if (flag === '--sha256') {
      if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error('Expected original SOURCE.sha256');
      expectedHash = value; continue;
    }
    if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error('Reader windows require nonnegative integer bytes');
    if (flag === '--offset') offset = Number(value);
    else limit = Number(value);
  }
  if (!expectedHash) throw new Error('--sha256 is required to verify the original source');
  if (limit < 4 || limit > 16384) throw new Error('--limit must be between 4 and 16384 UTF-8 bytes');
  if (tail && seen.has('--offset')) throw new Error('--tail cannot be combined with --offset');

  const script = path.resolve(process.argv[1]);
  const directory = path.dirname(script);
  let current = path.parse(directory).root;
  for (const segment of path.relative(current, directory).split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, segment);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Reader directory must not contain symbolic links');
  }
  if (fs.lstatSync(script).isSymbolicLink()) throw new Error('Reader script must not be a symbolic link');
  const filename = path.join(directory, basename);
  const info = fs.lstatSync(filename);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('Source must be an independent regular file, not a symbolic link');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let data;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Source identity changed while opening');
    data = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (sha256 !== expectedHash) throw new Error('Source SHA-256 differs from the original');
  if (!isUtf8(data)) throw new Error('Source is not valid UTF-8');
  let start = tail ? Math.max(0, data.length - limit) : Math.min(offset, data.length);
  while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
  let end = Math.min(start + limit, data.length);
  while (end < data.length && end > start && (data[end] & 0xc0) === 0x80) end--;
  const text = data.subarray(start, end).toString('utf8');
  process.stdout.write(`${JSON.stringify({ id: basename.slice(0, -4), sha256, offset: start, nextOffset: end < data.length ? end : null, totalBytes: data.length, bytes: end - start, mode: tail ? 'tail' : 'page', text })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
}
