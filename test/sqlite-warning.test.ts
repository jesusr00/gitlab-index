import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('SQLite initialization hides only its experimental warning and restores warning handling', () => {
  const { NODE_NO_WARNINGS, NODE_OPTIONS, ...env } = process.env;
  const store = pathToFileURL(resolve('src/inventory/store.ts')).href;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const original = process.emitWarning;
    const { Inventory } = await import(${JSON.stringify(store)});
    if (process.emitWarning !== original) throw new Error('Warning handler was not restored');
    const db = new Inventory(':memory:');
    db.close();
    process.emitWarning('Another experimental feature', 'ExperimentalWarning');
    process.emitWarning('Visible ordinary warning', { code: 'VISIBLE_WARNING' });
  `], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes('SQLite is an experimental feature'), result.stderr);
  assert.match(result.stderr, /ExperimentalWarning: Another experimental feature/);
  assert.match(result.stderr, /VISIBLE_WARNING/);
});
