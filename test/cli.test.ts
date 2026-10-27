import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Inventory } from '../src/inventory/store.js';
import { detect } from '../src/detection/index.js';

test('CLI searches offline, emits parseable JSON and reports project details', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inventory.sqlite');
  const host = 'offline.example.com';
  const db = new Inventory(path);
  const project = { id: 7, path: 'team/web', url: `https://${host}/team/web`, defaultBranch: 'main', archived: false, empty: false };
  db.membership(host, [project]);
  db.recordCommit(host, project.id, new Date().toISOString());
  db.snapshot(host, project, 'a'.repeat(40), detect(new Map([['.nvmrc', '24'], ['package.json', '{"dependencies":{"react":"19.0.0"}}']])));
  db.close();
  const cli = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), '--database', path, '--host', host, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: '', NODE_NO_WARNINGS: '1' } });
  const findings = JSON.parse(cli('search', '--technology', 'node', '--major', '24', '--format', 'json'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].technology, 'node');
  assert.ok(findings[0].url.endsWith('/.nvmrc'));
  assert.equal(JSON.parse(cli('projects', '--format', 'json'))[0].id, 7);
  assert.equal(JSON.parse(cli('show', '7', '--format', 'json')).findings.length, 3);
  assert.equal(JSON.parse(cli('search', '--technology', 'react', '--version', '19.0.0', '--format', 'json')).length, 1);
  const table = cli('search', '--technology', 'node', '--major', '24');
  assert.match(table, /https:\/\/offline\.example\.com\/team\/web/);
  assert.ok(!table.includes('/-/blob/'));
  assert.match(cli('search', '--technology', 'absent'), /No results/);
  assert.throws(() => cli('search', '--technology', 'node', '--major', '24', '--version', '24'), /Use only one/);
  assert.throws(() => cli('show', '999'), /not indexed/);
});
test('CLI sync consumes glab HTTP responses, preserves successful projects, and exits nonzero for partial failure', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-glab-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'inventory.sqlite');
  const host = 'fixture.example.com';
  const fake = `#!${process.execPath}
const endpoint = process.argv.at(-1);
let status = 200;
let body;
if (endpoint.startsWith('projects?')) body = [1,2].map(id => ({id,path_with_namespace:'team/app-'+id,web_url:'https://fixture.example.com/team/app-'+id,default_branch:'main'}));
else if (endpoint.startsWith('projects/2/')) { status = 403; body = { error: 'SECRET_NEVER_LOG' }; }
else if (endpoint.includes('/branches/')) body = {commit:{id:'${'a'.repeat(40)}',committed_date:new Date().toISOString()}};
else if (endpoint.includes('/tree?')) body = [{type:'blob',mode:'100644',path:'.nvmrc'}];
else body = {encoding:'base64',size:2,content:'MjQ='};
process.stdout.write('HTTP/2.0 '+status+' Response\\r\\nContent-Type: application/json\\r\\nX-Next-Page: \\r\\n\\r\\n'+JSON.stringify(body));
process.exitCode = status >= 400 ? 1 : 0;
`;
  writeFileSync(join(dir, 'glab'), fake, { mode: 0o700 });
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), '--database', dbPath, '--host', host, 'sync', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, PATH: dir, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { discovered: 2, scanned: 1, skipped: 0, empty: 0, failed: 1 });
  assert.match(result.stderr, /\[0\.0% 0\/2\] starting synchronization/);
  assert.match(result.stderr, /\[100\.0% 2\/2\]/);
  assert.ok(!result.stderr.includes('SECRET_NEVER_LOG'));
  const db = new Inventory(dbPath);
  try { assert.equal(db.search(host, { technology: 'node', major: 24 }).length, 1); }
  finally { db.close(); }
});

test('CLI filters by commit activity offline and keeps unknown dates accessible', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-activity-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inventory.sqlite');
  const host = 'offline.example.com';
  const db = new Inventory(path);
  const projects = [1, 2, 3].map(id => ({ id, path: `team/app-${id}`, url: `https://${host}/team/app-${id}`, defaultBranch: 'main', archived: false, empty: false }));
  db.membership(host, projects);
  for (const project of projects) db.snapshot(host, project, 'a'.repeat(40), detect(new Map([['.nvmrc', '24']])));
  db.recordCommit(host, 1, new Date().toISOString());
  db.recordCommit(host, 2, '2000-01-01T00:00:00.000Z');
  db.close();
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), '--database', path, '--host', host, ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  const search = (...args: string[]) => {
    const result = cli('search', '--technology', 'node', '--format', 'json', ...args);
    assert.equal(result.status, 0, result.stderr);
    return { ...result, ids: JSON.parse(result.stdout).map((f: any) => f.projectId) };
  };
  const active = search();
  assert.deepEqual(active.ids, [1]);
  assert.match(active.stderr, /Commit dates are unknown for 1 projects/);
  assert.deepEqual(search('--activity', 'inactive').ids, [2]);
  assert.deepEqual(search('--activity', 'all').ids, [1, 2, 3]);
  assert.equal(search('--activity', 'all').stderr, '');
  assert.deepEqual(search('--active-since', '1999-01-01').ids, [1, 2]);
  assert.equal(JSON.parse(cli('show', '2', '--format', 'json').stdout).findings.length, 1);
  assert.notEqual(cli('search', '--technology', 'node', '--activity', 'invalid').status, 0);
  assert.match(cli('search', '--technology', 'node', '--active-since', '2026-02-30').stderr, /YYYY-MM-DD/);
});
