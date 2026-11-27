import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import yazl from './vendor/yazl.cjs';
import { readSnapshot, copySnapshot, hashFile } from './artifact-snapshots.mjs';
import { readVerifiedGitPatch } from './git-worktree.mjs';

export const DELIVERY_LIMITS = Object.freeze({ maxBytes: 128 * 1024 * 1024, maxEntries: 2048, maxTasks: 100 });
export const DELIVERY_TIMEOUT_MS = 120000;
export const DELIVERY_MAX_ZIP_BYTES = 132 * 1024 * 1024;
const active = new WeakSet();
export class DeliveryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new DeliveryError(status, message); };
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail(400, '交付导出的团队或任务 ID 无效');
  return value;
}
const field = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
const passed = value => typeof value === 'boolean' ? value : null;
const priority = task => task.executionUnresolved || ['unknown', 'paused-unconfirmed', 'cancelled-unconfirmed'].includes(task.state) ? 0 : task.state === 'accepted' ? 2 : 1;
const hash = value => createHash('sha256').update(value).digest('hex');

/** Captures stored state only. It never freezes, reconciles, dispatches or edits a task. */
export async function createDeliveryExport({ engine, teamId, signal, limits: requested = {} }) {
  identifier(teamId);
  if (active.has(engine)) fail(409, '此引擎已有交付导出或下载进行中，请完成后重试');
  active.add(engine);
  let temporary, cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (temporary) {
        const info = await fsp.lstat(temporary);
        if (info.isSymbolicLink() || !info.isDirectory() || path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('superagent-delivery-')) throw new Error('Unsafe delivery cleanup path');
        await fsp.rm(temporary, { recursive: true });
      }
    } finally { active.delete(engine); }
  };
  const checkAbort = () => { if (signal?.aborted) fail(499, '交付导出已取消或超时'); };
  try {
    checkAbort();
    const limits = { ...DELIVERY_LIMITS };
    for (const [name, value] of Object.entries(requested)) {
      if (!Object.hasOwn(limits, name) || !Number.isSafeInteger(value) || value < 1 || value > limits[name]) fail(400, '交付导出限额无效');
      limits[name] = value;
    }
    // Engine.getTeam returns task summaries; fetch full stored records synchronously
    // so acceptance/verification and every team task version share one observation.
    const capture = () => {
      const team = engine.getTeam(teamId);
      if (!Array.isArray(team.tasks) || team.tasks.length > limits.maxTasks) fail(413, `交付报告最多支持 ${limits.maxTasks} 个任务，未进行截断`);
      return structuredClone({ ...team, tasks: team.tasks.map(task => engine.get(task.id)) });
    };
    const captured = capture(), fingerprint = JSON.stringify(captured);
    const assertCurrent = () => {
      checkAbort();
      let current; try { current = JSON.stringify(capture()); } catch { fail(409, '团队或任务版本在导出期间变化，请重新导出'); }
      if (current !== fingerprint) fail(409, '团队或任务版本在导出期间变化，请重新导出');
    };
    const tasks = [...captured.tasks].sort((a, b) => priority(a) - priority(b));
    const accepted = tasks.filter(task => task.state === 'accepted');
    if (!accepted.length) fail(400, '当前团队没有已验收成果可导出；请先完成并验收任务');
    for (const task of tasks) identifier(task.id);
    if (new Set(tasks.map(task => task.id)).size !== tasks.length) fail(409, '团队任务 ID 重复，不能导出');
    if (accepted.some(task => !task.acceptance?.snapshotId)) fail(409, '已验收任务缺少冻结快照，请先执行 freeze 再导出；本操作不会自动冻结');
    const observedAt = new Date().toISOString(), snapshotRoot = path.join(engine.dataDir, 'artifact-snapshots');
    const snapshots = new Map(), gitPatches = new Map(); let totalBytes = 0, entryCount = 2;
    for (const task of accepted) {
      checkAbort();
      const snapshot = await readSnapshot({ root: snapshotRoot, id: task.acceptance.snapshotId });
      const records = [...snapshot.manifest.files, ...(snapshot.manifest.result ? [snapshot.manifest.result] : [])];
      totalBytes += records.reduce((sum, file) => sum + file.bytes, 0); entryCount += records.length;
      if (task.acceptance.git?.patchFile && task.acceptance.git?.patchSha256) {
        const patchBytes = readVerifiedGitPatch({ dataDir: engine.dataDir, patchFile: task.acceptance.git.patchFile, patchSha256: task.acceptance.git.patchSha256 });
        gitPatches.set(task.id, { bytes: patchBytes, sha256: task.acceptance.git.patchSha256 });
        totalBytes += patchBytes.length; entryCount += 1;
      }
      if (totalBytes > limits.maxBytes || entryCount > limits.maxEntries) fail(413, '交付文件超过未压缩字节或条目限额，未进行截断');
      if ((snapshot.manifest.result?.sha256 ?? null) !== (task.resultSha256 ?? null) || task.acceptance.resultSha256 !== task.resultSha256) fail(409, '已验收结果与冻结快照版本不一致');
      const artifacts = task.acceptance.artifacts;
      if (!Array.isArray(artifacts) || new Set(artifacts.map(file => file.path)).size !== snapshot.manifest.files.length || snapshot.manifest.files.some(file => !artifacts.some(item => item.path === file.path && item.sha256 === file.sha256 && (item.bytes === undefined || item.bytes === file.bytes)))) fail(409, '已验收文件与冻结快照版本不一致');
      // copySnapshot verifies each source while copying and then verifies the staged bytes.
      snapshots.set(task.id, snapshot);
    }
    if (entryCount === 2) fail(400, '已验收快照没有可导出的文件或冻结结果');
    checkAbort();
    temporary = await fsp.mkdtemp(path.join(path.resolve(os.tmpdir()), 'superagent-delivery-'));
    const payload = path.join(temporary, 'payload'); await fsp.mkdir(payload);
    const files = [];
    for (const task of accepted) {
      checkAbort(); const snapshot = snapshots.get(task.id), copied = path.join(temporary, `copy-${task.id}`);
      await copySnapshot({ root: snapshotRoot, id: snapshot.id, destination: copied });
      const taskRoot = path.join(payload, 'artifacts', task.id); await fsp.mkdir(taskRoot, { recursive: true });
      await fsp.rename(path.join(copied, 'artifacts'), path.join(taskRoot, 'files')).catch(async error => {
        if (error.code !== 'ENOENT' || snapshot.manifest.files.length) throw error;
      });
      for (const record of snapshot.manifest.files) files.push({ ...record, path: `artifacts/${task.id}/files/${record.path}` });
      if (snapshot.manifest.result) {
        await fsp.rename(path.join(copied, 'result.txt'), path.join(taskRoot, 'result.txt'));
        files.push({ path: `artifacts/${task.id}/result.txt`, ...snapshot.manifest.result });
      }
      if (gitPatches.has(task.id)) {
        const patch = gitPatches.get(task.id);
        await fsp.writeFile(path.join(taskRoot, 'changes.patch'), patch.bytes, { flag: 'wx' });
        files.push({ path: `artifacts/${task.id}/changes.patch`, bytes: patch.bytes.length, sha256: patch.sha256 });
      }
    }
    const safeReason = (value, task) => {
      if (typeof value !== 'string') return null;
      let text = value.slice(0, 2000).replace(/[\x00-\x1f\x7f]/g, ' ');
      for (const local of [task.cwd, engine.dataDir, captured.repoPath].filter(value => typeof value === 'string' && value)) text = text.replaceAll(local, '[local path omitted]');
      return text + (value.length > 2000 ? ' [reason truncated]' : '');
    };
    const facts = tasks.map(task => ({ id: task.id, revision: task.revision, state: field(task.state), executionUnresolved: passed(task.executionUnresolved),
      hostCompletionStatus: field(task.completionStatus), mechanicalChecks: { status: field(task.verification?.status) ?? 'not_verified', passed: passed(task.verification?.passed) },
      included: task.state === 'accepted', snapshotId: task.state === 'accepted' ? task.acceptance.snapshotId : null,
      ...(gitPatches.has(task.id) ? { gitPatchSha256: gitPatches.get(task.id).sha256 } : {}),
      acceptance: task.acceptance ? { hostCompletionStatus: field(task.acceptance.hostCompletionStatus), acknowledgeHostFailure: passed(task.acceptance.acknowledgeHostFailure), reason: safeReason(task.acceptance.reason, task), versionPinned: passed(task.acceptance.versionPinned) } : null }));
    const members = (captured.members ?? []).map(member => ({ id: identifier(member.id), state: field(member.state), taskIds: (member.taskIds ?? []).map(identifier) }));
    const unassigned = members.filter(member => member.taskIds.length === 0);
    const warning = '分享前请自行检查文件内容及验收理由。已验收产物本身仍可能包含敏感信息；本导出不承诺自动识别或清除全部敏感内容。';
    const lines = ['# 已验收成果交付包', '', `观察时间：${observedAt}`, `团队：${teamId}；版本：${captured.revision}`, '', '## 未知与未完成（优先核对）', '',
      ...unassigned.map(member => `- 成员 ${member.id} 尚未分配任务。`),
      ...facts.filter(task => !task.included || task.executionUnresolved).map(task => `- ${task.id}: state=${task.state}; unresolved=${task.executionUnresolved}; host=${task.hostCompletionStatus ?? 'null'}；未验收任务不包含文件。`), '', `成员共 ${members.length} 人；尚未分配任务 ${unassigned.length} 人。成员 ID、状态与任务对应关系见 manifest.json。`, '', '## 全部任务的观察事实', '',
      ...facts.map(task => `- ${task.id}: state=${task.state}; unresolved=${task.executionUnresolved}; host=${task.hostCompletionStatus ?? 'null'}; mechanicalChecks.passed=${task.mechanicalChecks.passed}; snapshot=${task.snapshotId ?? 'not included'}; acceptance=${JSON.stringify(task.acceptance)}`), '',
      '仅已验收任务的固定快照文件及可用冻结结果包含在包中。未自动 freeze、重跑任务或改变验收状态。观察后状态仍可能变化；发出下载前已再次核对该团队版本。', '', '任务已验收不表示整个项目已完成集成。本包不执行文件合并；整项交付仍需在最终目标目录验证实际行为。', '', warning, '',
      'manifest.json 的 files 为所有其他 ZIP 条目的 SHA-256 和字节数；manifest.json 自身不列入自校验。内部数据库、连接令牌、原生绑定、提示词和运行日志未被收集；用户登记的产物内容由分享者检查。', ''];
    const report = Buffer.from(lines.join('\n')); await fsp.writeFile(path.join(payload, 'DELIVERY.md'), report, { flag: 'wx' }); files.unshift({ path: 'DELIVERY.md', bytes: report.length, sha256: hash(report) });
    if (gitPatches.size > 0) {
      const handoffLines = [
        '# Git Worktree 集成交接清单 (HANDOFF)',
        '',
        `- 观察时间：${observedAt}`,
        `- 团队 ID：${teamId}`,
        `- 工作区模式：git-worktree`,
        `- 基线提交 (baseCommit)：${captured.baseCommit ?? 'unknown'}`,
        ...(captured.lastMerge?.branch ? [`- 最近已发布分支：${captured.lastMerge.branch} (${captured.lastMerge.mergedCommit})`] : []),
        '',
        '## 已冻结的增量补丁（按验收任务列出）',
        '',
        ...accepted.filter(t => gitPatches.has(t.id)).map(t => `- ${t.id}: snapshot=${t.acceptance.snapshotId}; patch=artifacts/${t.id}/changes.patch; sha256=${gitPatches.get(t.id).sha256}`),
        '',
        '## 推荐集成方式',
        '',
        '1. 优先使用引擎内置 `engine_team(action="merge_preview")` 预览冲突与集成测试，通过后使用 `engine_team(action="merge_apply", branchName="...")` 原子发布到全新的 `superagent/<slug>` 分支。',
        '2. 或在目标仓库新建基于 `baseCommit` 的独立分支后，按 DAG 依赖顺序依次执行 `git apply --index artifacts/<taskId>/changes.patch` 并运行完整测试套件。',
        '',
      ];
      const handoff = Buffer.from(handoffLines.join('\n'));
      await fsp.writeFile(path.join(payload, 'HANDOFF.md'), handoff, { flag: 'wx' });
      files.splice(1, 0, { path: 'HANDOFF.md', bytes: handoff.length, sha256: hash(handoff) });
      totalBytes += handoff.length;
    }
    const manifest = { version: 1, kind: 'superagent-accepted-delivery', observedAt, team: { id: teamId, revision: captured.revision, control: field(captured.control), unassignedMemberCount: unassigned.length }, members, tasks: facts, warning, integration: 'Not performed by this export; validate behavior in the final target workspace.', checksumScope: 'All ZIP payload entries except manifest.json itself', files };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); await fsp.writeFile(path.join(payload, 'manifest.json'), manifestBytes, { flag: 'wx' });
    totalBytes += report.length + manifestBytes.length;
    if (totalBytes > limits.maxBytes || files.length + 1 > limits.maxEntries) fail(413, '交付报告与文件超过未压缩字节或条目限额，未进行截断');
    const zipPath = path.join(temporary, 'delivery.zip'), records = [...files, { path: 'manifest.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) }];
    await writeZip({ zipPath, payload, records, signal }); checkAbort();
    if ((await fsp.stat(zipPath)).size > DELIVERY_MAX_ZIP_BYTES) fail(413, '交付 ZIP 超过 132 MiB 下载限额，未发送部分文件');
    const zipHash = await hashFile(zipPath, { limits: { maxBlobBytes: DELIVERY_MAX_ZIP_BYTES } });
    if (!zipHash.bytes) fail(500, '交付 ZIP 没有完整生成');
    assertCurrent();
    return { zipPath, filename: `team-${teamId}-delivery.zip`, bytes: zipHash.bytes, sha256: zipHash.sha256, manifest, assertCurrent, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof DeliveryError) throw error;
    if (signal?.aborted) fail(499, '交付导出已取消或超时');
    fail(409, '交付导出失败：请检查冻结快照完整性与任务版本后重试');
  }
}

async function writeZip({ zipPath, payload, records, signal }) {
  const zip = new yazl.ZipFile(), readers = new Set(), endings = [];
  zip.on('error', error => zip.outputStream.destroy(error));
  const abort = () => { zip.emit('error', new Error('Delivery cancelled')); for (const stream of readers) stream.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  const writing = pipeline(zip.outputStream, fs.createWriteStream(zipPath, { flags: 'wx' }), { signal }); writing.catch(() => {});
  try {
    for (const record of records) zip.addReadStreamLazy(record.path, { size: record.bytes }, callback => {
      if (signal?.aborted) return callback(new Error('Delivery cancelled'));
      const input = fs.createReadStream(path.join(payload, ...record.path.split('/'))), digest = createHash('sha256'); let bytes = 0;
      const checked = new Transform({ transform(chunk, encoding, done) { bytes += chunk.length; digest.update(chunk); done(null, chunk); }, flush(done) { done(bytes === record.bytes && digest.digest('hex') === record.sha256 ? null : new Error('Delivery payload hash mismatch')); } });
      for (const stream of [input, checked]) { readers.add(stream); endings.push(finished(stream).catch(() => {})); stream.once('close', () => readers.delete(stream)); }
      input.on('error', error => checked.destroy(error)); checked.on('error', error => zip.emit('error', error)); input.pipe(checked); callback(null, checked);
    });
    zip.end(); await writing;
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const stream of readers) stream.destroy();
    await Promise.all(endings);
  }
}

/** Keeps one export slot until the HTTP transfer finishes or is cancelled. */
export async function sendDeliveryExport({ engine, teamId, req, res }) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  const disconnected = () => { if (!res.writableFinished) controller.abort(); };
  req.on('aborted', disconnected); res.on('close', disconnected); let result;
  try {
    result = await createDeliveryExport({ engine, teamId, signal: controller.signal });
    result.assertCurrent();
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${result.filename}"`, 'Content-Length': result.bytes, 'X-Delivery-Bytes': String(result.bytes), 'Cache-Control': 'no-store', 'X-Delivery-SHA256': result.sha256 });
    await pipeline(fs.createReadStream(result.zipPath), res, { signal: controller.signal });
  } finally {
    clearTimeout(timer); req.off('aborted', disconnected); res.off('close', disconnected);
    await result?.cleanup();
  }
}
