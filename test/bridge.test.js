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

// ---- M4.8: the modal-dialog gate ------------------------------------------
//
// After Effects refuses to run ANY script while a modal dialog is waiting - its
// own "Save changes?" on quit included - and it announces the refusal with an
// alert of its own ("Cannot run a script while a modal dialog is waiting for
// response"). The panel polls twice a second, so a quit produced one of those
// alerts per poll. There is no API to ask whether a modal is open, so the gate
// is driven from the quit event and from a reply the host never ran.

function fakeCep({ reply = '{"ok":true}' } = {}) {
  const listeners = new Map();
  const calls = [];
  const cep = {
    getHostEnvironment: () => '{"appId":"AEFT"}',
    evalScript: (source, cb) => { calls.push(source); cb(typeof reply === 'function' ? reply(source) : reply); },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatchEvent: () => {},
  };
  global.window = {
    __adobe_cep__: cep,
    CSInterface: function () { this.hostEnvironment = { appId: 'AEFT' }; Object.assign(this, cep,
      { getHostEnvironment: () => ({ appId: 'AEFT' }) }); },
    addEventListener: () => {},
  };
  return { calls, fire: (type) => listeners.get(type)?.({ type }) };
}

test('the host quit event stops every later call reaching After Effects', async () => {
  const cep = fakeCep();
  const { createHost } = await import('../panel/src/bridge/cep.js');
  const host = createHost();
  assert.equal(host.connected, true);

  assert.equal(await host.evalScript('NTL_Revision()'), '{"ok":true}');
  assert.equal(cep.calls.length, 1);

  cep.fire('com.adobe.csxs.events.ApplicationBeforeQuit');
  assert.equal(host.suspended, true);
  const reply = await host.evalScript('NTL_Revision()');
  assert.match(reply, /^Host Suspended/);
  assert.equal(cep.calls.length, 1, 'nothing further was handed to After Effects');
  // A quit is final: it must not be resumable by a later backoff expiring.
  assert.equal(host.resume(), false);
  assert.equal(host.suspended, true);
  delete global.window;
});

test('a reply the host never ran closes the gate for a while, not forever', async () => {
  const cep = fakeCep({ reply: 'EvalScript error.' });
  const { createHost, HOST_QUIET_MS } = await import('../panel/src/bridge/cep.js');
  const host = createHost();

  await host.evalScript('NTL_ActiveComp()');
  assert.equal(host.suspended, true, 'one refused call is enough to stop polling');
  assert.match(host.suspendReason, /dialog/);
  assert.equal(cep.calls.length, 1);

  await host.evalScript('NTL_ActiveComp()');
  assert.equal(cep.calls.length, 1, 'the next poll never left the panel');

  assert.ok(HOST_QUIET_MS > 0 && HOST_QUIET_MS < 60000);
  assert.equal(host.resume(), true, 'a transient hold is recoverable');
  assert.equal(host.suspended, false);
  delete global.window;
});

test('a modal host call the panel asked for stops pollers but not itself', async () => {
  const cep = fakeCep();
  const { createHost } = await import('../panel/src/bridge/cep.js');
  const host = createHost();

  host.beginModal();
  assert.equal(host.busy, true, 'pollers check busy and stand down');
  assert.equal(host.suspended, false, 'the transport stays open for the dialog call');
  assert.equal(await host.evalScript('NTL_ShowNewCompDialog()'), '{"ok":true}');
  host.endModal();
  assert.equal(host.busy, false);
  delete global.window;
});
