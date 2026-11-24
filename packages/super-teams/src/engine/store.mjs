import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Match JS truthiness for stored JSON, including older numeric/string flags.
// Missing/null are SQL NULL, false is 0, and the empty string is also false.
const unresolvedFlag = "(json_extract(body,'$.executionUnresolved') NOT IN (0,''))";

let ownBirth;
function processBirth(pid) {
  if (pid === process.pid && ownBirth) return ownBirth;
  let birth;
  if (process.platform === 'win32') {
    const cmd = `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`;
    for (const shell of ['powershell.exe', 'pwsh.exe', 'pwsh']) {
      try {
        birth = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (birth) break;
      } catch {}
    }
    if (!birth && pid === process.pid) {
      birth = `self-${process.pid}-${Math.round(Date.now() - process.uptime() * 1000)}`;
    }
  } else if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    birth = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } else {
    birth = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 10000 }).trim();
  }
  if (!birth) throw new Error('Cannot determine writer process lifetime');
  if (pid === process.pid) ownBirth = birth;
  return birth;
}
function readOwner(filename) {
  let text;
  try { text = fs.readFileSync(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'number' ? { pid: parsed, legacy: true } : parsed;
  } catch { return { malformed: true }; }
}
function isStale(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  // Legacy or inaccessible lifetimes remain locked; guessing risks a second writer.
  if (!owner.birth) return false;
  try { return processBirth(owner.pid) !== owner.birth; }
  catch { return false; }
}

// One process owns the database. Synchronous transactions are the only write path.
export class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.lockPath = path.join(dataDir, 'writer.lock');
    this.guardPath = path.join(dataDir, '.writer-recovery.sqlite');
    this.owner = { version: 2, pid: process.pid, birth: processBirth(process.pid), token: randomUUID() };
    this._guard(() => {
      const previous = readOwner(this.lockPath);
      if (previous && !isStale(previous)) throw new Error('Engine data directory already has a writer');
      if (previous) fs.unlinkSync(this.lockPath);
      this.lock = fs.openSync(this.lockPath, 'wx');
      fs.writeFileSync(this.lock, JSON.stringify(this.owner));
      fs.fsyncSync(this.lock);
    });
    try {
      this.db = new DatabaseSync(path.join(dataDir, 'engine.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS team_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, team_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tasks_team_state ON tasks(json_extract(body,'$.teamId'), json_extract(body,'$.state'))
          WHERE json_extract(body,'$.teamId') IS NOT NULL;
        CREATE INDEX IF NOT EXISTS tasks_unresolved ON tasks(${unresolvedFlag}) WHERE ${unresolvedFlag}=1;
        CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);`);
    } catch (error) { this.close(); throw error; }
  }
  _guard(fn) {
    // A separate SQLite file supplies an OS-released recovery mutex. It does
    // not hold the application database transaction or rely on stale PID files.
    const guard = new DatabaseSync(this.guardPath);
    try {
      guard.exec('PRAGMA busy_timeout=100; BEGIN EXCLUSIVE');
      try { const value = fn(); guard.exec('COMMIT'); return value; }
      catch (error) { guard.exec('ROLLBACK'); throw error; }
    } catch (error) {
      if (/locked|busy/i.test(error.message)) throw new Error('Engine data directory already has a writer or recovery in progress');
      throw error;
    } finally { guard.close(); }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  tasks() { return this.db.prepare('SELECT body FROM tasks ORDER BY rowid').all().map(row => JSON.parse(row.body)); }
  unresolvedTasks() {
    return this.db.prepare(`SELECT body FROM tasks WHERE ${unresolvedFlag}=1 ORDER BY rowid`).all().map(row => JSON.parse(row.body));
  }
  teamTasks(teamId) {
    return this.db.prepare("SELECT body FROM tasks WHERE json_extract(body,'$.teamId')=? ORDER BY rowid").all(teamId).map(row => JSON.parse(row.body));
  }
  teamStateCounts() {
    const rows = this.db.prepare(`SELECT json_extract(body,'$.teamId') AS teamId, json_extract(body,'$.state') AS state, COUNT(*) AS count
      FROM tasks WHERE json_extract(body,'$.teamId') IS NOT NULL GROUP BY teamId, state ORDER BY MIN(rowid)`).all();
    const counts = new Map();
    for (const { teamId, state, count } of rows) {
      if (!counts.has(teamId)) counts.set(teamId, {});
      counts.get(teamId)[state] = count;
    }
    return counts;
  }
  get(id) { const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; }
  save(task) { this.db.prepare('INSERT INTO tasks(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, JSON.stringify(task)); }
  request(id) { return this.db.prepare('SELECT fingerprint,task_id AS taskId FROM requests WHERE id=?').get(id); }
  addRequest(id, fingerprint, taskId) { this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(id, fingerprint, taskId); }
  teams() { return this.db.prepare('SELECT body FROM teams ORDER BY rowid').all().map(row => JSON.parse(row.body)); }
  team(id) { const row = this.db.prepare('SELECT body FROM teams WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; }
  saveTeam(team) { this.db.prepare('INSERT INTO teams(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(team.id, JSON.stringify(team)); }
  teamRequest(id) { return this.db.prepare('SELECT fingerprint,team_id AS teamId FROM team_requests WHERE id=?').get(id); }
  addTeamRequest(id, fingerprint, teamId) { this.db.prepare('INSERT INTO team_requests VALUES(?,?,?)').run(id, fingerprint, teamId); }
  event(taskId, event) {
    const result = this.db.prepare('INSERT INTO events(task_id,body) VALUES(?,?)').run(taskId, JSON.stringify(event));
    return { seq: Number(result.lastInsertRowid), ...event };
  }
  events(id, after, limit) { return this.db.prepare('SELECT seq,body FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit).map(row => ({ seq: row.seq, ...JSON.parse(row.body) })); }
  close() {
    this.db?.close(); this.db = null;
    if (this.lock !== undefined) {
      fs.closeSync(this.lock); this.lock = undefined;
      this._guard(() => {
        if (readOwner(this.lockPath)?.token === this.owner.token) fs.unlinkSync(this.lockPath);
      });
    }
  }
}
