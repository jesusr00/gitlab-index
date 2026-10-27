import test from 'node:test';
import assert from 'node:assert/strict';
import { Inventory } from '../src/inventory/store.js';
import { detect } from '../src/detection/index.js';

test('project substring search composes with technology, version, activity and membership filters', () => {
  const db = new Inventory(':memory:');
  const host = 'example.com';
  const projects = ['team/frontend-app', 'other/frontend-app', 'team/api_100%'].map((path, i) => ({
    id: i + 1, path, url: `https://${host}/${path}`, defaultBranch: 'main', empty: false, archived: false,
  }));
  try {
    db.membership(host, projects);
    for (const p of projects) {
      db.recordCommit(host, p.id, p.id === 2 ? '2000-01-01T00:00:00.000Z' : new Date().toISOString());
      db.snapshot(host, p, 'a'.repeat(40), detect(new Map([['.nvmrc', '24'], ['package.json', '{"dependencies":{"react":"19.0.0"}}']])));
    }
    assert.equal(db.search(host, { project: 'FRONTEND' }).length, 3);
    assert.equal(db.search(host, { project: 'frontend', activity: 'all' }).length, 6);
    assert.deepEqual(db.search(host, { project: 'frontend', technology: 'node', major: 24, activity: 'inactive' }).map(f => f.projectId), [2]);
    assert.deepEqual(db.search(host, { project: 'team/frontend', technology: 'react' }).map(f => f.projectId), [1]);
    assert.equal(db.search(host, { project: '_100%' }).length, 3);
    assert.equal(db.search(host, { project: "' OR 1=1 --" }).length, 0);
    db.membership(host, projects.slice(1));
    assert.equal(db.search(host, { project: 'team/frontend' }).length, 0);
    assert.equal(db.search(host, { project: 'team/frontend', includeNonMembers: true }).length, 3);
  } finally { db.close(); }
});
