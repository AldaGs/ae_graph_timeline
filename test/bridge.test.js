import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeEvalScript } from '../panel/src/bridge/cep.js';

test('CEP calls are serialized so health checks cannot overlap patches', async () => {
  const started = [];
  const releases = [];
  const call = serializeEvalScript((source) => new Promise((resolve) => {
    started.push(source);
    releases.push(() => resolve(source));
  }));

  const patch = call('patch');
  const health = call('active-comp');
  await Promise.resolve();
  assert.deepEqual(started, ['patch']);
  releases.shift()();
  assert.equal(await patch, 'patch');
  await Promise.resolve();
  assert.deepEqual(started, ['patch', 'active-comp']);
  releases.shift()();
  assert.equal(await health, 'active-comp');
});

test('one failed CEP call does not block later calls', async () => {
  const call = serializeEvalScript(async (source) => {
    if (source === 'bad') throw new Error('host failed');
    return source;
  });
  await assert.rejects(call('bad'), /host failed/);
  assert.equal(await call('good'), 'good');
});
