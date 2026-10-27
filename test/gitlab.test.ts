import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLab, ApiError, validateHost, type ApiResponse, type Transport } from '../src/gitlab/client.js';
const response = (body: unknown, headers: Record<string, string> = {}, status = 200): ApiResponse => ({ body: JSON.stringify(body), headers, status });
const row = (id: number) => ({ id, path_with_namespace: `team/app-${id}`, web_url: `https://example.com/team/app-${id}`, default_branch: 'main', archived: true });
test('membership discovery follows all pages and keeps archived projects', async () => {
  const endpoints: string[] = [];
  const api = new GitLab({ async get(endpoint) {
    endpoints.push(endpoint);
    return endpoint.endsWith('page=1') ? response([row(1)], { 'x-next-page': '2' }) : response([row(2)], { 'x-next-page': '' });
  } });
  const projects = await api.projects();
  assert.deepEqual(projects.map(p => p.id), [1, 2]);
  assert.ok(projects.every(p => p.archived));
  assert.ok(endpoints.every(p => p.includes('membership=true') && !p.includes('archived=false')));
});
test('tree pagination, encoded file paths and commit-pinned reads', async () => {
  const sha = 'a'.repeat(40); const endpoints: string[] = [];
  const api = new GitLab({ async get(endpoint) {
    endpoints.push(endpoint);
    if (endpoint.startsWith('projects?')) return response([row(1)]);
    if (endpoint.includes('/branches/')) return response({ commit: { id: sha, committed_date: '2026-10-27T12:00:00Z' } });
    if (endpoint.includes('/tree?')) return endpoint.endsWith('page=1')
      ? response([{ type: 'blob', mode: '100644', path: 'apps/web/package.json' }, { type: 'blob', mode: '120000', path: 'link' }], { 'x-next-page': '2' })
      : response([{ type: 'blob', mode: '100644', path: 'go.mod' }]);
    return response({ encoding: 'base64', content: Buffer.from('24').toString('base64'), size: 2 });
  } });
  const p = (await api.projects())[0]!;
  assert.deepEqual(await api.head(p), { sha, committedAt: '2026-10-27T12:00:00.000Z' });
  const progress: number[] = [];
  assert.deepEqual(await api.tree(p, sha, undefined, entries => progress.push(entries)), ['apps/web/package.json', 'go.mod']);
  assert.deepEqual(progress, [2, 3]);
  assert.equal(await api.file(p, sha, 'apps/web/package.json'), '24');
  assert.ok(endpoints.filter(e => e.includes('/tree?') || e.includes('/files/')).every(e => e.includes(`ref=${sha}`)));
  assert.ok(endpoints.some(e => e.includes('apps%2Fweb%2Fpackage.json')));
});
test('429 honors Retry-After, transient server errors retry, and failures are bounded', async () => {
  const waits: number[] = []; let calls = 0;
  const api = new GitLab({ async get() {
    calls++;
    if (calls === 1) return response({}, { 'retry-after': '2' }, 429);
    if (calls === 2) return response({}, {}, 503);
    return response([]);
  } }, 3, async ms => { waits.push(ms); });
  await api.projects();
  assert.deepEqual(waits, [2000, 500]);
  const denied = new GitLab({ async get() { return response({ secret: 'do-not-log' }, {}, 403); } });
  await assert.rejects(denied.projects(), (e: unknown) => e instanceof ApiError && e.status === 403 && !e.message.includes('do-not-log'));
  let retries = 0;
  const unavailable = new GitLab({ async get() { retries++; return response({}, {}, 503); } }, 2, async () => {});
  await assert.rejects(unavailable.projects(), /503/);
  assert.equal(retries, 3);
});
test('membership failure after the first page never returns a partial list', async () => {
  const transport: Transport = { async get(endpoint) { return endpoint.endsWith('page=1') ? response([row(1)], { 'x-next-page': '2' }) : response({}, {}, 403); } };
  await assert.rejects(new GitLab(transport).projects(), /403/);
});
test('cancellation stops requests and rejects unsafe hosts', async () => {
  const controller = new AbortController(); controller.abort(new Error('Interrupted'));
  const api = new GitLab({ async get() { throw new Error('Should not request'); } });
  await assert.rejects(api.projects(controller.signal), /Interrupted/);
  for (const host of ['https://gitlab.com', '-h', 'user@host', 'host/path']) assert.throws(() => validateHost(host));
});
test('malformed API responses never expose response body text in diagnostics', async () => {
  const api = new GitLab({ async get() { return { status: 200, headers: {}, body: '<secret-auth-token>' }; } });
  await assert.rejects(api.projects(), (error: unknown) => error instanceof Error && !error.message.includes('secret-auth-token'));
});

test('head uses the default branch commit date and rejects missing dates', async () => {
  const project = { id: 1, path: 'team/app', url: 'https://example.com/team/app', defaultBranch: 'release/next', archived: false, empty: false };
  let committedDate: unknown = '2026-10-27T08:00:00-04:00';
  const api = new GitLab({ async get(endpoint) {
    assert.equal(endpoint, 'projects/1/repository/branches/release%2Fnext');
    return response({ commit: { id: 'a'.repeat(40), committed_date: committedDate, authored_date: '2000-01-01T00:00:00Z' } });
  } });
  assert.equal((await api.head(project)).committedAt, '2026-10-27T12:00:00.000Z');
  for (const value of [undefined, null, '', 'invalid']) {
    committedDate = value;
    await assert.rejects(api.head(project), /invalid commit date/);
  }
});
