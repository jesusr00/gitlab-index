import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('CLI saves the GitLab host in .env and respects flag and environment precedence', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.GITLAB_INDEX_HOST;
  const cli = (args: string[], extraEnv = {}) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/cli.ts'), '--database', join(dir, 'inventory.sqlite'), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...env, ...extraEnv },
  });
  const missing = cli(['projects']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /GitLab host is not configured.*GITLAB_INDEX_HOST/);
  assert.equal(existsSync(join(dir, 'inventory.sqlite')), false);
  writeFileSync(join(dir, '.env'), 'GITLAB_INDEX_HOST=\n');
  assert.equal(cli(['projects']).status, 1);
  writeFileSync(join(dir, '.env'), '# Local settings\nOTHER=value\n');
  const saved = cli(['config', 'set-host', 'GITLAB.EXAMPLE.COM']);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /# Local settings\nOTHER=value\nGITLAB_INDEX_HOST=gitlab.example.com\n/);
  assert.equal(cli(['projects', '--format', 'json']).stdout.trim(), '[]');
  const overridden = cli(['projects'], { GITLAB_INDEX_HOST: 'invalid/path' });
  assert.notEqual(overridden.status, 0);
  assert.equal(cli(['--host', 'override.example.com', 'projects'], { GITLAB_INDEX_HOST: 'invalid/path' }).status, 0);
  assert.notEqual(cli(['config', 'set-host', 'https://bad.example.com/path']).status, 0);
  assert.equal(cli(['config', 'set-host', 'second.example.com']).status, 0);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8').match(/GITLAB_INDEX_HOST=/g)?.length, 1);
});
