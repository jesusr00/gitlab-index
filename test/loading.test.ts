import test from 'node:test';
import assert from 'node:assert/strict';
import { startDiscoveryLoading } from '../src/presentation/loading.js';

test('discovery loading renders immediately and animates until stopped', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const writes: string[] = [];
  const stop = startDiscoveryLoading({ isTTY: true, write: message => writes.push(message) });
  assert.match(writes[0]!, /Discovering GitLab projects/);
  t.mock.timers.tick(80);
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0], writes[1]);
  stop();
  assert.equal(writes.at(-1), '\r\x1b[2K');
  const count = writes.length;
  stop();
  t.mock.timers.tick(800);
  assert.equal(writes.length, count);
});
test('redirected discovery output is a single plain line without terminal escapes', () => {
  const writes: string[] = [];
  const stop = startDiscoveryLoading({ write: message => writes.push(message) });
  stop(); stop();
  assert.deepEqual(writes, ['Discovering GitLab projects...\n']);
});
