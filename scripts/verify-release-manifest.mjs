#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const opts = { repo: process.cwd(), zip: '', remote: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) opts.repo = argv[++i];
    else if (argv[i] === '--zip' && argv[i + 1]) opts.zip = argv[++i];
    else if (argv[i] === '--remote' && argv[i + 1]) opts.remote = argv[++i];
  }
  opts.repo = path.resolve(opts.repo);
  if (opts.zip) opts.zip = path.resolve(opts.zip);
  return opts;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, `Invalid ZIP (missing EOCD): ${zipPath}`);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let ptr = buf.readUInt32LE(eocdOffset + 16);
  const rawEntries = new Map();
  for (let n = 0; n < totalEntries; n++) {
    assert.equal(buf.readUInt32LE(ptr), 0x02014b50, `Invalid central directory signature at ${ptr}`);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const fullName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (fullName.endsWith('/')) continue;

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `Invalid local header at ${localOffset}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compSlice = buf.subarray(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = Buffer.from(compSlice);
    else if (method === 8) content = zlib.inflateRawSync(compSlice);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${fullName}`);
    assert.equal(content.length, uncompSize, `ZIP size mismatch for ${fullName}`);
    rawEntries.set(fullName, content);
  }
  return rawEntries;
}

const opts = parseArgs(process.argv.slice(2));
const git = (args, encoding) => execFileSync('git', args, { cwd: opts.repo, encoding: encoding ?? 'buffer', maxBuffer: 64 * 1024 * 1024 });

const dirty = git(['status', '--porcelain'], 'utf8').trim();
assert.equal(dirty, '', `Working tree must be clean before verifying release manifest:\n${dirty}`);

const commit = git(['rev-parse', 'HEAD'], 'utf8').trim();
const blobManifestBuf = git(['cat-file', 'blob', `${commit}:SHA256SUMS.json`]);
const manifest = JSON.parse(blobManifestBuf.toString('utf8'));
const manifestPaths = Object.keys(manifest.files || {}).sort();

const lsOut = git(['ls-tree', '-r', '-z', '--name-only', commit]).toString('utf8');
const trackedPaths = lsOut.split('\0').filter(p => p && p !== 'SHA256SUMS.json').sort();

assert.deepEqual(manifestPaths, trackedPaths, 'SHA256SUMS.json path set must match git ls-tree HEAD exactly');

for (const rel of trackedPaths) {
  const expected = manifest.files[rel];
  const blobHash = sha256(git(['cat-file', 'blob', `${commit}:${rel}`]));
  assert.equal(blobHash, expected, `Git blob SHA-256 mismatch at ${commit}:${rel}`);
  const diskHash = sha256(fs.readFileSync(path.join(opts.repo, rel)));
  assert.equal(diskHash, expected, `Checked-out working file SHA-256 mismatch: ${rel}`);
}

let matchedZip = 0;
if (opts.zip) {
  const entries = readZipEntries(opts.zip);
  const firstKey = entries.keys().next().value || '';
  const prefix = firstKey.includes('/') ? `${firstKey.split('/')[0]}/` : '';
  const zipMap = new Map();
  for (const [k, v] of entries) {
    assert.ok(prefix === '' || k.startsWith(prefix), `Unexpected ZIP root entry ${k}`);
    zipMap.set(prefix ? k.slice(prefix.length) : k, v);
  }
  assert.ok(zipMap.has('SHA256SUMS.json'), 'ZIP missing SHA256SUMS.json');
  assert.equal(sha256(zipMap.get('SHA256SUMS.json')), sha256(blobManifestBuf), 'ZIP SHA256SUMS.json differs from committed SHA256SUMS.json');

  const zipPaths = [...zipMap.keys()].filter(p => p !== 'SHA256SUMS.json').sort();
  assert.deepEqual(zipPaths, trackedPaths, 'ZIP path set must match git ls-tree HEAD and SHA256SUMS.json exactly');
  for (const rel of trackedPaths) {
    assert.equal(sha256(zipMap.get(rel)), manifest.files[rel], `ZIP entry SHA-256 mismatch: ${rel}`);
    matchedZip++;
  }
}

let remoteMatched = null;
if (opts.remote) {
  const remoteOid = git(['rev-parse', '--verify', opts.remote], 'utf8').trim();
  assert.equal(remoteOid, commit, `Remote ref ${opts.remote} (${remoteOid}) != HEAD (${commit})`);
  remoteMatched = remoteOid;
}

console.log(JSON.stringify({
  ok: true,
  commit,
  entries: manifestPaths.length,
  matchedBlob: trackedPaths.length,
  matchedDisk: trackedPaths.length,
  ...(opts.zip ? { matchedZip } : {}),
  ...(remoteMatched ? { remote: opts.remote, remoteMatched } : {}),
}, null, 2));
