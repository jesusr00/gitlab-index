import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Inventory } from '../src/inventory/store.js';
import { DatabaseSync } from '../src/inventory/sqlite.js';
import { activityCutoff, parseActivityDate } from '../src/inventory/activity.js';
import { detect } from '../src/detection/index.js';

const host = 'example.com';
test('activity uses six calendar months and clamps month ends', () => {
  assert.equal(activityCutoff(new Date('2026-10-27T12:00:00Z')), '2026-04-27T00:00:00.000Z');
  assert.equal(activityCutoff(new Date('2026-08-31T12:00:00Z')), '2026-02-28T00:00:00.000Z');
  assert.equal(activityCutoff(new Date('2024-08-31T12:00:00Z')), '2024-02-29T00:00:00.000Z');
  for (const input of ['2026-02-30', '2026-13-01', 'today', '2026-1-1']) assert.throws(() => parseActivityDate(input), /YYYY-MM-DD/);
  assert.equal(parseActivityDate('2026-04-27'), '2026-04-27T00:00:00.000Z');
});
test('search filters activity by commit dates independently of membership and scan timestamps', () => {
  const db = new Inventory(':memory:');
  try {
    const projects = [1,2,3,4].map(id => ({ id, path: `team/app-${id}`, url: `https://${host}/team/app-${id}`, defaultBranch: 'main', empty: false, archived: id === 2 }));
    db.membership(host, projects);
    for (const p of projects) db.snapshot(host, p, 'a'.repeat(40), detect(new Map([['.nvmrc', '24']])));
    db.recordCommit(host, 1, new Date().toISOString());
    db.recordCommit(host, 2, '2000-01-01T00:00:00.000Z');
    db.recordCommit(host, 3, '2026-04-27T00:00:00.000Z');
    const query = { technology: 'node', activeSince: '2026-04-27' };
    assert.deepEqual(db.search(host, query).map(f => f.projectId), [1,3]);
    assert.deepEqual(db.search(host, { ...query, activity: 'inactive' }).map(f => f.projectId), [2]);
    assert.equal(db.search(host, { ...query, activity: 'all' }).length, 4);
    const unknown = db.search(host, { activity: 'all' }).find(f => f.projectId === 4)!;
    assert.equal(unknown.active, null);
    assert.equal(unknown.member, true);
    assert.equal(db.missingCommitDates(host), 1);
    db.membership(host, projects.filter(p => p.id !== 1));
    assert.deepEqual(db.search(host, query).map(f => f.projectId), [3]);
    assert.deepEqual(db.search(host, { ...query, includeNonMembers: true }).map(f => f.projectId), [1,3]);
    assert.equal(db.search(host, { ...query, includeNonMembers: true })[0]?.active, true);
    assert.equal(db.search(host, { ...query, includeNonMembers: true })[0]?.member, false);
    assert.throws(() => db.search(host, { activity: 'invalid' as any }), /Activity/);
  } finally { db.close(); }
});
test('version 1 migration retains findings and membership without inventing commit dates', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inventory.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE projects (host TEXT NOT NULL,id INTEGER NOT NULL,path TEXT NOT NULL,url TEXT NOT NULL,default_branch TEXT,archived INTEGER NOT NULL,empty INTEGER NOT NULL,ci_config_path TEXT,active INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'pending',sha TEXT,scanned_at TEXT,checked_at TEXT,error TEXT,PRIMARY KEY(host,id));
    CREATE TABLE findings (id INTEGER PRIMARY KEY,host TEXT NOT NULL,project_id INTEGER NOT NULL,technology TEXT NOT NULL,version TEXT,selector TEXT,ecosystem TEXT NOT NULL,component TEXT NOT NULL,source TEXT NOT NULL,file TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,sha TEXT NOT NULL,url TEXT NOT NULL,scanned_at TEXT NOT NULL,FOREIGN KEY(host,project_id) REFERENCES projects(host,id));
    INSERT INTO projects(host,id,path,url,archived,empty,active,status) VALUES ('example.com',1,'team/app','https://example.com/team/app',0,0,1,'ready');
    INSERT INTO findings(host,project_id,technology,version,ecosystem,component,source,file,status,sha,url,scanned_at) VALUES ('example.com',1,'node','24','generic','.','runtime','.nvmrc','resolved','abc','https://example.com/source','2026-10-27T00:00:00Z');
    PRAGMA user_version = 1;`);
  old.close();
  const db = new Inventory(path);
  try {
    assert.equal(db.projects(host)[0]?.member, true);
    assert.equal(db.projects(host)[0]?.lastCommitAt, null);
    assert.equal(db.search(host).length, 0);
    assert.equal(db.search(host, { activity: 'all' }).length, 1);
    db.recordCommit(host, 1, new Date().toISOString());
    assert.equal(db.search(host).length, 1);
  } finally { db.close(); }
  const reopened = new Inventory(path);
  try { assert.equal(reopened.search(host).length, 1); } finally { reopened.close(); }
});

test('migration waits for an existing sync and leaves the old schema intact', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-locked-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inventory.sqlite');
  const old = new DatabaseSync(path);
  try {
    old.exec(`CREATE TABLE sync_lock (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL); PRAGMA user_version=1;`);
    old.prepare('INSERT INTO sync_lock VALUES (1, ?)').run(process.pid);
    assert.throws(() => new Inventory(path), /Stop the running sync/);
    assert.equal((old.prepare('PRAGMA user_version').get() as any).user_version, 1);
    old.exec('BEGIN IMMEDIATE; ROLLBACK;');
  } finally { old.close(); }
});
