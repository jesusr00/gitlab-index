import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gitlab-index-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  execFileSync(npm, ['pack', '--pack-destination', dir], { stdio: 'inherit' });
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const tarball = join(dir, `${pkg.name}-${pkg.version}.tgz`);
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.includes('package/dist/cli.js'));
  assert.ok(entries.includes('package/LICENSE'));
  assert.ok(entries.every(path => /^package\/(?:dist\/|README\.md$|LICENSE$|package\.json$)/.test(path)), 'Unexpected files in the npm tarball');
  execFileSync(npm, ['install', '--prefix', dir, '--omit=dev', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', tarball], { stdio: 'inherit' });
  const executable = join(dir, 'node_modules', 'gitlab-index', 'dist', 'cli.js');
  const run = (...args) => execFileSync(process.execPath, [executable, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(run('--help'), /gitlab-index/);
  assert.equal(run('--version').trim(), pkg.version);
  run('config', 'set-host', 'offline.example.com');
  assert.deepEqual(JSON.parse(run('--database', join(dir, 'inventory.sqlite'), 'projects', '--format', 'json')), []);
  console.log('Packed CLI installs and runs without development dependencies.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
