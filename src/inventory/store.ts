import { DatabaseSync } from './sqlite.js';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Finding, Project, Search } from '../types.js';
import { matchesVersion } from '../detection/versions.js';
import { activityCutoff, parseActivityDate, projectIsActive } from './activity.js';

export interface StoredProject extends Project {
  host: string; member: boolean; active: boolean | null; lastCommitAt: string | null; status: string; sha: string | null; scannedAt: string | null; checkedAt: string | null; error: string | null;
}
export interface StoredFinding extends Finding {
  projectId: number; host: string; project: string; projectUrl: string; archived: boolean; member: boolean; active: boolean | null; lastCommitAt: string | null;
  sha: string; url: string; scannedAt: string; freshness: 'current' | 'stale'; scanStatus: string;
}
export function defaultDatabase(): string {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'gitlab-index', 'inventory.sqlite');
}
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export class Inventory {
  private readonly db: DatabaseSync;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as any).user_version;
    if (version > 2) { this.db.close(); throw new Error('Inventory schema is newer than this CLI; upgrade the CLI'); }
    try { this.transaction(() => {
      if (version === 1) {
        const hasLock = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_lock'").get();
        const lock = hasLock ? this.db.prepare('SELECT pid FROM sync_lock WHERE id=1').get() as { pid: number } | undefined : undefined;
        if (lock && processIsAlive(lock.pid)) throw new Error('Stop the running sync before upgrading the inventory schema');
        this.db.exec('ALTER TABLE projects RENAME COLUMN active TO member; ALTER TABLE projects ADD COLUMN last_commit_at TEXT;');
      }
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        host TEXT NOT NULL, id INTEGER NOT NULL, path TEXT NOT NULL, url TEXT NOT NULL,
        default_branch TEXT, archived INTEGER NOT NULL, empty INTEGER NOT NULL, ci_config_path TEXT,
        member INTEGER NOT NULL DEFAULT 1, last_commit_at TEXT, status TEXT NOT NULL DEFAULT 'pending', sha TEXT,
        scanned_at TEXT, checked_at TEXT, error TEXT, PRIMARY KEY(host, id)
      );
      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY, host TEXT NOT NULL, project_id INTEGER NOT NULL,
        technology TEXT NOT NULL, version TEXT, selector TEXT, ecosystem TEXT NOT NULL,
        component TEXT NOT NULL, source TEXT NOT NULL, file TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT, sha TEXT NOT NULL, url TEXT NOT NULL, scanned_at TEXT NOT NULL,
        FOREIGN KEY(host, project_id) REFERENCES projects(host, id)
      );
      CREATE INDEX IF NOT EXISTS findings_technology ON findings(technology, host, project_id);
      CREATE TABLE IF NOT EXISTS sync_lock (id INTEGER PRIMARY KEY CHECK(id = 1), pid INTEGER NOT NULL);
      PRAGMA user_version = 2;
      `);
    }); } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acquire(): void {
    this.transaction(() => {
      const lock = this.db.prepare('SELECT pid FROM sync_lock WHERE id = 1').get() as { pid: number } | undefined;
      if (lock) {
        if (processIsAlive(lock.pid)) throw new Error('Another synchronization is already using this inventory');
      }
      this.db.prepare('INSERT OR REPLACE INTO sync_lock(id, pid) VALUES (1, ?)').run(process.pid);
      this.db.prepare("UPDATE projects SET status = 'failed', error = 'Previous scan was interrupted' WHERE status IN ('scanning', 'pending')").run();
    });
  }
  release(): void { this.db.prepare('DELETE FROM sync_lock WHERE id = 1 AND pid = ?').run(process.pid); }
  membership(host: string, projects: Project[]): void {
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET member = 0 WHERE host = ?').run(host);
      const insert = this.db.prepare(`INSERT INTO projects(host,id,path,url,default_branch,archived,empty,ci_config_path) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(host,id) DO UPDATE SET path=excluded.path,url=excluded.url,default_branch=excluded.default_branch,
        archived=excluded.archived,empty=excluded.empty,ci_config_path=excluded.ci_config_path,member=1,status='pending',error=NULL`);
      for (const p of projects) insert.run(host, p.id, p.path, p.url, p.defaultBranch, Number(p.archived), Number(p.empty), p.ciConfigPath ?? null);
    });
  }
  projects(host: string, includeNonMembers = false): StoredProject[] {
    const cutoff = activityCutoff();
    return (this.db.prepare(`SELECT * FROM projects WHERE host = ? ${includeNonMembers ? '' : 'AND member = 1'} ORDER BY path`).all(host) as any[]).map(p => ({
      host: p.host, id: p.id, path: p.path, url: p.url, defaultBranch: p.default_branch, archived: !!p.archived, empty: !!p.empty,
      ciConfigPath: p.ci_config_path, member: !!p.member, lastCommitAt: p.last_commit_at, active: projectIsActive(p.last_commit_at, !!p.empty, cutoff), status: p.status, sha: p.sha, scannedAt: p.scanned_at, checkedAt: p.checked_at, error: p.error,
    }));
  }
  recordCommit(host: string, id: number, committedAt: string): void {
    if (!Number.isFinite(Date.parse(committedAt))) throw new Error('Invalid commit date');
    this.db.prepare('UPDATE projects SET last_commit_at=? WHERE host=? AND id=?').run(new Date(committedAt).toISOString(), host, id);
  }
  missingCommitDates(host: string, includeNonMembers = false): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM projects WHERE host=? AND empty=0 AND last_commit_at IS NULL ${includeNonMembers ? '' : 'AND member=1'}`).get(host) as { count: number }).count;
  }
  scanning(host: string, id: number): void { this.db.prepare("UPDATE projects SET status='scanning', error=NULL WHERE host=? AND id=?").run(host, id); }
  failed(host: string, id: number, error: string): void { this.db.prepare("UPDATE projects SET status='failed', error=?, checked_at=? WHERE host=? AND id=?").run(error, new Date().toISOString(), host, id); }
  unchanged(host: string, id: number): void { this.db.prepare("UPDATE projects SET status='ready', error=NULL, checked_at=? WHERE host=? AND id=?").run(new Date().toISOString(), host, id); }
  snapshot(host: string, project: Project, sha: string | null, findings: Finding[]): void {
    const time = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM findings WHERE host=? AND project_id=?').run(host, project.id);
      const insert = this.db.prepare(`INSERT INTO findings(host,project_id,technology,version,selector,ecosystem,component,source,file,status,reason,sha,url,scanned_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const f of findings) {
        const url = `${project.url}/-/blob/${sha}/${f.file.split('/').map(encodeURIComponent).join('/')}`;
        insert.run(host, project.id, f.technology, f.version, f.selector ?? null, f.ecosystem, f.component, f.source, f.file, f.status, f.reason, sha, url, time);
      }
      if (sha === null) this.db.prepare('UPDATE projects SET last_commit_at=NULL WHERE host=? AND id=?').run(host, project.id);
      this.db.prepare('UPDATE projects SET status=?,sha=?,scanned_at=?,checked_at=?,error=NULL WHERE host=? AND id=?')
        .run(sha === null ? 'empty' : 'ready', sha, time, time, host, project.id);
    });
  }
  search(host: string, query: Search = {}, projectId?: number): StoredFinding[] {
    const params: (string | number)[] = [host];
    let conditions = 'f.host = ?';
    if (!query.includeNonMembers) conditions += ' AND p.member = 1';
    const activity = query.activity ?? 'active';
    if (!['active', 'inactive', 'all'].includes(activity)) throw new Error('Activity must be active, inactive or all');
    const cutoff = query.activeSince ? parseActivityDate(query.activeSince) : activityCutoff();
    if (activity === 'active') { conditions += ' AND p.last_commit_at >= ?'; params.push(cutoff); }
    if (activity === 'inactive') { conditions += ' AND (p.empty=1 OR p.last_commit_at < ?)'; params.push(cutoff); }
    if (query.project) { conditions += ' AND instr(lower(p.path), lower(?)) > 0'; params.push(query.project); }
    if (query.technology) { conditions += ' AND f.technology = ?'; params.push(query.technology.toLowerCase()); }
    if (projectId !== undefined) { conditions += ' AND f.project_id = ?'; params.push(projectId); }
    const rows = this.db.prepare(`SELECT f.*,p.path AS project,p.url AS project_url,p.archived,p.member,p.empty,p.last_commit_at,p.status AS scan_status FROM findings f
      JOIN projects p ON p.host=f.host AND p.id=f.project_id WHERE ${conditions} ORDER BY p.path,f.component,f.technology,f.file,f.version`).all(...params) as any[];
    return rows.map(f => ({
      technology: f.technology, version: f.version, ...(f.selector === null ? {} : { selector: f.selector }), ecosystem: f.ecosystem,
      component: f.component, source: f.source, file: f.file, status: f.status, reason: f.reason,
      projectId: f.project_id, host: f.host, project: f.project, projectUrl: f.project_url, archived: !!f.archived, member: !!f.member, lastCommitAt: f.last_commit_at, active: projectIsActive(f.last_commit_at, !!f.empty, cutoff),
      sha: f.sha, url: f.url, scannedAt: f.scanned_at, freshness: f.scan_status === 'ready' && f.member ? 'current' : 'stale', scanStatus: f.scan_status,
    } satisfies StoredFinding)).filter(f => matchesVersion(f, query));
  }
}
