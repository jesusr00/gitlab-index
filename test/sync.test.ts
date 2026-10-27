import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Inventory } from '../src/inventory/store.js';
import { synchronize } from '../src/inventory/sync.js';
import type { Project, Repository } from '../src/types.js';
const host = 'gitlab.example.com';
const project = (id = 1): Project => ({ id, path: `team/app-${id}`, url: `https://${host}/team/app-${id}`, defaultBranch: 'main', archived: false, empty: false });
class Repo implements Repository {
  items = [project()];
  sha = 'a'.repeat(40);
  committedAt = new Date().toISOString();
  files = new Map([['.nvmrc', '24']]);
  fail: string | undefined;
  reads = 0;
  seenShas: string[] = [];
  async projects() { if (this.fail === 'membership') throw new Error('Membership failed'); return this.items; }
  async head() { if (this.fail === 'head') throw new Error('HTTP 403'); return { sha: this.sha, committedAt: this.committedAt }; }
  async tree(_p: Project, sha: string) { this.seenShas.push(sha); return [...this.files.keys()]; }
  async file(_p: Project, sha: string, path: string) { this.reads++; this.seenShas.push(sha); if (this.fail === 'file') throw new Error('HTTP 403'); return this.files.get(path)!; }
}
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-test-'));
  const path = join(dir, 'inventory.sqlite');
  const db = new Inventory(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, repo: new Repo(), path };
}
test('sync persists pinned evidence; unchanged commits skip reads, force rescans', async t => {
  const { db, repo, path } = setup(t);
  assert.equal((await synchronize(db, host, repo)).scanned, 1);
  assert.ok(repo.seenShas.every(x => x === repo.sha));
  const findings = db.search(host, { technology: 'node', major: 24 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.freshness, 'current');
  assert.ok(findings[0]?.url.includes(`/-/blob/${repo.sha}/.nvmrc`));
  const reads = repo.reads;
  assert.equal((await synchronize(db, host, repo)).skipped, 1);
  assert.equal(repo.reads, reads);
  assert.equal((await synchronize(db, host, repo, { force: true })).scanned, 1);
  const offline = new Inventory(path);
  try { assert.equal(offline.search(host, { technology: 'node' }).length, 1); } finally { offline.close(); }
});
test('changed snapshots remove deleted manifests atomically; failures retain stale evidence', async t => {
  const { db, repo } = setup(t);
  await synchronize(db, host, repo);
  repo.sha = 'b'.repeat(40); repo.fail = 'file';
  assert.equal((await synchronize(db, host, repo)).failed, 1);
  assert.equal(db.search(host)[0]?.sha, 'a'.repeat(40));
  assert.equal(db.search(host)[0]?.freshness, 'stale');
  repo.fail = undefined; repo.files = new Map([['package.json', '{broken']]);
  assert.equal((await synchronize(db, host, repo)).failed, 1);
  assert.equal(db.search(host).length, 1);
  repo.files.clear();
  assert.equal((await synchronize(db, host, repo)).scanned, 1);
  assert.equal(db.search(host).length, 0);
});
test('completed membership refresh deactivates missing projects; failed refresh preserves membership', async t => {
  const { db, repo } = setup(t);
  await synchronize(db, host, repo);
  repo.items = []; repo.fail = 'membership';
  await assert.rejects(synchronize(db, host, repo), /Membership failed/);
  assert.equal(db.projects(host).length, 1);
  repo.fail = undefined;
  await synchronize(db, host, repo);
  assert.equal(db.projects(host).length, 0);
  assert.equal(db.search(host).length, 0);
  assert.equal(db.search(host, { includeNonMembers: true, activity: 'all' })[0]?.member, false);
});
test('empty and archived projects are represented; a denied project does not stop others', async t => {
  const { db, repo } = setup(t);
  repo.items = [{ ...project(1), empty: true, defaultBranch: null }, { ...project(2), archived: true }, project(3)];
  repo.head = async p => { if (p.id === 3) throw new Error('HTTP 403'); return { sha: repo.sha, committedAt: new Date().toISOString() }; };
  const result = await synchronize(db, host, repo);
  assert.deepEqual(result, { discovered: 3, scanned: 1, skipped: 0, empty: 1, failed: 1 });
  assert.equal(db.projects(host).find(p => p.id === 1)?.status, 'empty');
  assert.equal(db.search(host)[0]?.archived, true);
});
test('nested CI includes resolve at the pinned commit and preserve external include uncertainty', async t => {
  const { db, repo } = setup(t);
  repo.files = new Map([
    ['.gitlab-ci.yml', 'include:\n  - local: /pipelines/*.yaml\n  - project: team/templates\n    file: /node.yml\n'],
    ['pipelines/node.yaml', 'image: node:24-alpine\ninclude:\n  - local: /.gitlab-ci.yml\n'],
    ['apps/web/package.json', '{"engines":{"node":"22"}}'],
    ['node_modules/example/package.json', '{broken'],
  ]);
  await synchronize(db, host, repo);
  assert.equal(db.search(host, { technology: 'node', major: 24 }).length, 1);
  assert.equal(db.search(host, { technology: 'node', major: 22 })[0]?.component, 'apps/web');
  assert.equal(db.search(host, { technology: 'gitlab-ci' })[0]?.status, 'unresolved');
  assert.equal(repo.reads, 3);
});
test('custom CI roots and missing local includes are handled explicitly', async t => {
  const { db, repo } = setup(t);
  repo.items[0]!.ciConfigPath = 'pipelines/main.yaml';
  repo.files = new Map([['pipelines/main.yaml', 'image: node:24\n']]);
  assert.equal((await synchronize(db, host, repo)).scanned, 1);
  assert.equal(db.search(host, { technology: 'node', major: 24 }).length, 1);
  repo.sha = 'b'.repeat(40);
  repo.files.set('pipelines/main.yaml', 'include: /missing.yaml');
  assert.equal((await synchronize(db, host, repo)).failed, 1);
  assert.equal(db.search(host)[0]?.freshness, 'stale');
});
test('interrupted scans preserve previous findings and a subsequent sync recovers', async t => {
  const { db, repo } = setup(t);
  await synchronize(db, host, repo);
  const controller = new AbortController();
  repo.sha = 'b'.repeat(40);
  const original = repo.file.bind(repo);
  repo.file = async (...args) => { controller.abort(new Error('Interrupted')); return original(...args); };
  await assert.rejects(synchronize(db, host, repo, { signal: controller.signal }), /Interrupted/);
  assert.equal(db.search(host)[0]?.sha, 'a'.repeat(40));
  assert.equal(db.search(host)[0]?.freshness, 'stale');
  repo.file = original;
  assert.equal((await synchronize(db, host, repo)).scanned, 1);
  assert.equal(db.search(host)[0]?.freshness, 'current');
});
test('a concurrent synchronization cannot acquire the same inventory', t => {
  const { db, path } = setup(t);
  const other = new Inventory(path);
  try { db.acquire(); assert.throws(() => other.acquire(), /already/); }
  finally { db.release(); other.close(); }
});
test('concurrency is bounded across projects', async t => {
  const { db, repo } = setup(t);
  repo.items = Array.from({ length: 264 }, (_, i) => project(i + 1));
  let running = 0; let maximum = 0;
  repo.head = async () => {
    running++; maximum = Math.max(running, maximum);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--; return { sha: repo.sha, committedAt: new Date().toISOString() };
  };
  await synchronize(db, host, repo, { concurrency: 256 });
  assert.equal(maximum, 256);
  await assert.rejects(synchronize(db, host, repo, { concurrency: 257 }), /between 1 and 256/);
});
test('a dead process lock is reclaimed and an interrupted snapshot remains queryable', async t => {
  const { db, repo, path } = setup(t);
  await synchronize(db, host, repo);
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { Inventory } from ${JSON.stringify(resolve('src/inventory/store.ts'))};
    const db = new Inventory(${JSON.stringify(path)});
    db.acquire(); db.scanning(${JSON.stringify(host)}, 1); db.close();
  `], { stdio: 'pipe' });
  assert.equal(db.search(host)[0]?.freshness, 'stale');
  assert.equal((await synchronize(db, host, repo)).scanned, 1);
  assert.equal(db.search(host)[0]?.freshness, 'current');
});
test('GitLab CI spec headers work through nested includes; malformed job documents preserve the previous snapshot', async t => {
  const { db, repo } = setup(t);
  repo.files = new Map([
    ['.gitlab-ci.yml', 'spec:\n  inputs: {}\n---\ninclude:\n  - local: /.cicd/quality/.quality-fe.yml\n'],
    ['.cicd/quality/.quality-fe.yml', 'spec:\n  inputs:\n    stage:\n      default: test\n---\ninclude: /pipelines/node.yml\nquality:\n  script: !reference [.shared, script]\n'],
    ['pipelines/node.yml', 'image: node:24-alpine\n'],
  ]);
  const result = await synchronize(db, host, repo);
  assert.equal(result.failed, 0);
  assert.equal(db.search(host, { technology: 'node', major: 24 }).length, 1);
  repo.sha = 'b'.repeat(40);
  repo.files.set('.cicd/quality/.quality-fe.yml', 'spec:\n  inputs: {}\n---\njob:\n  image: [node:24\n');
  assert.equal((await synchronize(db, host, repo)).failed, 1);
  assert.equal(db.search(host)[0]?.freshness, 'stale');
  assert.match(db.projects(host)[0]!.error!, /YAML .* at line \d+, column \d+/);
});
test('explicit CI references can target excluded build directories without scanning generated manifests', async t => {
  const { db, repo } = setup(t);
  repo.files = new Map([
    ['.gitlab-ci.yml', 'include: /.cicd/build/.build.yml\n'],
    ['.cicd/build/.build.yml', 'include: /.cicd/build/node.yml\n'],
    ['.cicd/build/node.yml', 'image: node:24-alpine\n'],
    ['build/package.json', '{broken'],
  ]);
  assert.equal((await synchronize(db, host, repo)).failed, 0);
  assert.equal(db.search(host, { technology: 'node', major: 24 }).length, 1);
  assert.equal(repo.reads, 3);
  repo.items[0]!.ciConfigPath = '.cicd/build/node.yml';
  assert.equal((await synchronize(db, host, repo)).failed, 0);
});
test('scan progress identifies tree listing and manifest reads before project completion', async t => {
  const { db, repo } = setup(t);
  const messages: string[] = [];
  repo.tree = async (_p, sha, onSignal, onPage) => {
    assert.ok(messages.some(m => m.includes('listing repository tree')));
    onPage?.(100); onPage?.(1100);
    return [...repo.files.keys()];
  };
  const original = repo.file.bind(repo);
  repo.file = async (...args) => {
    assert.ok(messages.some(m => m.includes('reading manifest 1/1')));
    return original(...args);
  };
  await synchronize(db, host, repo, { onProgress: message => messages.push(message) });
  assert.ok(messages.some(m => m.includes('1100 entries')));
  assert.match(messages.at(-1)!, /^\[100\.0% 1\/1\] scanned /);
});
test('sync indexes Compose variants and preserves the previous snapshot if a Compose manifest is malformed', async t => {
  const { db, repo } = setup(t);
  repo.files = new Map([
    ['apps/api/docker-compose.prod.yaml', 'services:\n  api:\n    image: node:24-alpine\n'],
    ['apps/worker/compose.dev.yaml', 'services:\n  worker:\n    image: python:3.12-slim\n'],
    ['vendor/example/compose.prod.yaml', 'not: [valid'],
  ]);
  assert.equal((await synchronize(db, host, repo)).scanned, 1);
  assert.equal(db.search(host, { technology: 'node', major: 24 })[0]?.file, 'apps/api/docker-compose.prod.yaml');
  assert.equal(db.search(host, { technology: 'python' })[0]?.component, 'apps/worker');
  assert.equal(repo.reads, 2);
  repo.sha = 'b'.repeat(40);
  repo.files.set('apps/api/docker-compose.prod.yaml', 'services:\n  api:\n    image: [node:24\n');
  assert.equal((await synchronize(db, host, repo)).failed, 1);
  assert.equal(db.search(host, { technology: 'node' })[0]?.freshness, 'stale');
});
test('global progress counts scanned, unchanged, empty and failed repositories exactly once', async t => {
  const { db, repo } = setup(t);
  await synchronize(db, host, repo);
  repo.items = [project(1), { ...project(2), empty: true, defaultBranch: null }, project(3), project(4)];
  repo.head = async p => { if (p.id === 4) throw new Error('HTTP 403'); return { sha: repo.sha, committedAt: new Date().toISOString() }; };
  const messages: string[] = [];
  const result = await synchronize(db, host, repo, { concurrency: 2, onProgress: message => messages.push(message) });
  assert.deepEqual(result, { discovered: 4, scanned: 1, skipped: 1, empty: 1, failed: 1 });
  assert.equal(messages[0], '[0.0% 0/4] starting synchronization');
  const completed = messages.filter(message => /\] (scanned|unchanged|empty|failed) /.test(message));
  assert.equal(completed.length, 4);
  for (const [index, message] of completed.entries()) assert.ok(message.startsWith(`[${((index + 1) * 25).toFixed(1)}% ${index + 1}/4] `), message);
  const percentages = messages.map(message => Number(message.match(/^\[([\d.]+)%/)?.[1]));
  assert.ok(percentages.every((p, i) => Number.isFinite(p) && p >= (percentages[i - 1] ?? 0) && p <= 100));
});
test('global progress handles an empty inventory without NaN or division by zero', async t => {
  const { db, repo } = setup(t);
  repo.items = [];
  const messages: string[] = [];
  await synchronize(db, host, repo, { onProgress: message => messages.push(message) });
  assert.deepEqual(messages, ['[100.0% 0/0] no projects to process']);
});
test('interruption does not count an incomplete repository toward global completion', async t => {
  const { db, repo } = setup(t);
  const controller = new AbortController();
  repo.file = async () => { controller.abort(new Error('Interrupted')); return '24'; };
  const messages: string[] = [];
  await assert.rejects(synchronize(db, host, repo, { signal: controller.signal, onProgress: message => messages.push(message) }), /Interrupted/);
  assert.ok(messages.every(message => message.startsWith('[0.0% 0/1] ')), messages.join('\n'));
  assert.equal(db.projects(host)[0]?.status, 'failed');
});

test('sync backfills unchanged commit dates and preserves the last known date after access failure', async t => {
  const { db, repo } = setup(t);
  db.membership(host, repo.items);
  db.snapshot(host, repo.items[0]!, repo.sha, []);
  assert.equal(db.projects(host)[0]?.lastCommitAt, null);
  assert.equal((await synchronize(db, host, repo)).skipped, 1);
  assert.equal(repo.reads, 0);
  assert.equal(db.projects(host)[0]?.lastCommitAt, repo.committedAt);
  repo.sha = 'b'.repeat(40);
  repo.committedAt = '2000-01-01T00:00:00.000Z';
  await synchronize(db, host, repo);
  assert.equal(db.search(host).length, 0);
  assert.equal(db.search(host, { activity: 'inactive' }).length, 1);
  repo.fail = 'head';
  await synchronize(db, host, repo);
  assert.equal(db.projects(host)[0]?.lastCommitAt, repo.committedAt);
  assert.equal(db.search(host, { activity: 'inactive' })[0]?.freshness, 'stale');
  repo.fail = 'file'; repo.sha = 'c'.repeat(40);
  repo.committedAt = new Date().toISOString();
  await synchronize(db, host, repo);
  assert.equal(db.search(host)[0]?.sha, 'b'.repeat(40));
  assert.equal(db.search(host)[0]?.lastCommitAt, repo.committedAt);
  assert.equal(db.search(host)[0]?.freshness, 'stale');
});
