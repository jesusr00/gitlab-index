import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('release requires a matching version tag and repository identity', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const check = (overrides: Record<string, string>) => spawnSync(process.execPath, ['scripts/check-release.mjs'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${pkg.version}`, GITHUB_REPOSITORY: 'jesusr00/gitlab-index', ...overrides },
  });
  assert.equal(check({}).status, 0);
  assert.match(check({ GITHUB_REF_NAME: 'v99.0.0' }).stderr, /Tag must equal/);
  assert.match(check({ GITHUB_REF_TYPE: 'branch' }).stderr, /Select a version tag/);
  assert.match(check({ GITHUB_REPOSITORY: 'someone/fork' }).stderr, /repository must match/);
});
