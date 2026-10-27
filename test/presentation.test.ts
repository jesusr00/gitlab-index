import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFindings, renderProjectDetails } from '../src/presentation/findings.js';
import type { StoredFinding, StoredProject } from '../src/inventory/store.js';

const finding = (changes: Partial<StoredFinding> = {}): StoredFinding => ({
  projectId: 7, host: 'gitlab.example.com', project: 'team/web', projectUrl: 'https://gitlab.example.com/team/web',
  member: true, lastCommitAt: '2026-10-27T12:00:00Z', active: true, archived: false, technology: 'node', version: '24-alpine', selector: '24', ecosystem: 'generic',
  component: '.', source: 'docker', file: 'Dockerfile', status: 'resolved', reason: null,
  sha: 'a'.repeat(40), url: `https://gitlab.example.com/team/web/-/blob/${'a'.repeat(40)}/Dockerfile`,
  scannedAt: '2026-10-27T16:56:45.608Z', freshness: 'current', scanStatus: 'ready', ...changes,
});
test('compact search groups repeated declarations and prints a project link once', () => {
  const text = renderFindings([finding(), finding({ source: 'ci', file: '.cicd/test.yml' })], 100);
  assert.equal(text.split('https://gitlab.example.com/team/web').length - 1, 1);
  assert.equal(text.split('24-alpine').length - 1, 1);
  assert.match(text, /27\/10\/2026/);
  assert.match(text, /Files/);
  assert.match(text, /\b2\b/);
  assert.ok(!text.includes('2026-10-27T'));
  assert.ok(!text.includes('false'));
  assert.ok(!text.includes('.cicd/test.yml'));
  assert.ok(!text.includes('resolved'));
  assert.ok(text.includes('show 7'));
});
test('long hashes and technology names cannot stretch the terminal table', () => {
  const text = renderFindings([finding({ technology: 'a'.repeat(90), version: `sha256:${'f'.repeat(64)}`, status: 'unresolved', reason: 'A long diagnostic '.repeat(20) })], 80);
  assert.ok(text.split('\n').every(line => line.length <= 80), text);
  assert.match(text, /…/);
  assert.ok(!text.includes('f'.repeat(64)));
  assert.ok(!text.includes('A long diagnostic'));
});
test('different versions and exceptional states remain separate and visible', () => {
  const text = renderFindings([
    finding(),
    finding({ version: '22', selector: '22' }),
    finding({ status: 'unresolved', reason: 'Dynamic expression', version: '${NODE_VERSION}' }),
    finding({ version: null, status: 'unknown', freshness: 'stale', active: false, archived: true }),
  ], 120);
  for (const value of ['24-alpine', '22', '${NODE_VERSION}', 'unknown', 'stale', 'archived', 'inactive']) assert.ok(text.includes(value), value);
});
test('project detail preserves evidence, complete versions and diagnostics without a wide table', () => {
  const full = finding({ version: `sha256:${'f'.repeat(64)}`, status: 'unresolved', reason: 'Unsupported version', component: 'apps/web', file: 'apps/web/Dockerfile' });
  const project: StoredProject = { id: 7, host: full.host, path: full.project, url: full.projectUrl, defaultBranch: 'main', empty: false, archived: false, member: true, lastCommitAt: full.lastCommitAt, active: true, status: 'ready', sha: full.sha, scannedAt: full.scannedAt, checkedAt: full.scannedAt, error: null };
  const text = renderProjectDetails(project, [full]);
  for (const value of [full.version!, full.file, full.component, full.reason!, '27/10/2026']) assert.ok(text.includes(value), value);
  assert.ok(!text.includes('/-/blob/'));
});
test('empty and narrow views stay readable and invalid dates do not crash rendering', () => {
  assert.equal(renderFindings([]), 'No results.');
  const text = renderFindings([finding({ scannedAt: 'invalid' })], 40);
  assert.ok(text.includes('unknown'));
  assert.ok(text.includes('24-alpine'));
});
