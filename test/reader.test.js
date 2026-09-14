// Offline tests for P1.1's reader. No After Effects involved.
//
// The payloads here are shaped exactly as jsx/reader.jsx emits them, so the two
// halves can be checked against each other without AE running. What they cannot
// check is that AE really returns these shapes - that is the in-AE pass, and it
// is recorded separately.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCompState, normalizeCompState, ReadError, readCompCall, jsxStringLiteral,
  newCompDialogCall, parseNewCompDialog,
  activeCompCall, parseActiveComp,
  classifyActiveComp,
} from '../src/reader.js';
import { diff } from '../src/diff.js';
import { createGraph, addNode, addEdge, tagFor, expressionFor, expressionBody } from '../src/graph.js';

// ---- helpers ---------------------------------------------------------------

let nid = 100;
const hostLayer = (over = {}) => ({
  nativeId: nid++,
  index: 1,
  name: 'Layer',
  comment: '',
  nodeId: null,
  kind: 'solid',
  enabled: true,
  inPoint: 0,
  outPoint: 5,
  parentIndex: null,
  parentTag: null,
  props: { opacity: 100, position: [960, 540] },
  expressions: {},
  ...over,
});

const payload = (layers, over = {}) => ({
  ok: true,
  compName: 'Shot 01',
  compId: 42,
  revision: 7,
  duration: 10,
  frameRate: 24,
  layerCount: layers.length,
  managedLayers: layers.filter((l) => l.nodeId !== null).length,
  untaggedLayers: layers.filter((l) => l.nodeId === null).length,
  readErrors: 0,
  firstError: null,
  layers,
  ...over,
});

// ---- the call --------------------------------------------------------------

test('the evalScript call is built with escaped arguments', () => {
  assert.equal(readCompCall(), 'NTL_ReadComp(null, false, null)');
  assert.equal(readCompCall({ compName: 'Shot 01', includeEffects: true }),
    'NTL_ReadComp("Shot 01", true, null)');
  assert.equal(readCompCall({ compId: 42 }), 'NTL_ReadComp(null, false, 42)');
});

test('a comp name with quotes or backslashes cannot break out of the call', () => {
  // The recurring hazard in this project, in the one place it would reach AE.
  assert.equal(jsxStringLiteral('he said "hi"'), '"he said \\"hi\\""');
  assert.equal(jsxStringLiteral('C:\\temp'), '"C:\\\\temp"');
  assert.equal(jsxStringLiteral('two\nlines'), '"two\\nlines"');
});

test('the new-comp call opens the native AE dialog', () => {
  assert.equal(newCompDialogCall(), 'NTL_ShowNewCompDialog()');
});

test('the native new-comp dialog result is validated, including cancel', () => {
  assert.equal(parseNewCompDialog('{"ok":true,"created":true,"compName":"Shot","compId":42}').compId, 42);
  assert.equal(parseNewCompDialog('{"ok":true,"created":false}').created, false);
  assert.throws(() => parseNewCompDialog('{"ok":false,"message":"no project"}'),
    (e) => e instanceof ReadError && /no project/.test(e.message));
  assert.throws(() => parseNewCompDialog('EvalScript error.'),
    (e) => e instanceof ReadError && /did not return JSON/.test(e.message));
});

test('the active-comp identity check validates present and absent comps', () => {
  assert.equal(activeCompCall(), 'NTL_ActiveComp()');
  assert.equal(parseActiveComp('{"ok":true,"active":false}').active, false);
  assert.equal(parseActiveComp('{"ok":true,"active":true,"compName":"Shot","compId":9}').compId, 9);
  assert.throws(() => parseActiveComp('{"ok":true,"active":true}'),
    (e) => e instanceof ReadError && /did not identify/.test(e.message));
});

test('active comp identity catches deletion and switching to a duplicate', () => {
  const expected = { compId: 9, compName: 'Shot' };
  assert.equal(classifyActiveComp(expected, { active: false }).status, 'missing');
  assert.equal(classifyActiveComp(expected, { active: true, compId: 10, compName: 'Shot 2' }).status, 'changed');
  assert.equal(classifyActiveComp(expected, { active: true, compId: 9, compName: 'Renamed Shot' }).status, 'same');
});

// ---- refusing a bad read ---------------------------------------------------

test('a host failure surfaces as a ReadError, not as an empty comp', () => {
  assert.throws(() => normalizeCompState({ ok: false, message: 'no composition' }),
    (e) => e instanceof ReadError && /no composition/.test(e.message));
});

test('a PARTIAL read is refused — it must never become a patch', () => {
  // The host counts unreadable properties rather than swallowing them. If we
  // diffed anyway, every property it failed to read would look absent, and the
  // reconciler would emit ops to "fix" values it simply could not see.
  assert.throws(
    () => normalizeCompState(payload([hostLayer()], { readErrors: 3, firstError: 'opacity: no' })),
    (e) => e instanceof ReadError && /refusing to diff a partial read/.test(e.message),
  );
});

test('a partial read CAN be tolerated explicitly, for the drift gate only', () => {
  const s = normalizeCompState(payload([hostLayer()], { readErrors: 3, firstError: 'x' }),
    { tolerateReadErrors: true });
  assert.equal(s.stats.readErrors, 3);
});

test('duplicate native ids mean the read itself is wrong', () => {
  assert.throws(
    () => normalizeCompState(payload([hostLayer({ nativeId: 5 }), hostLayer({ nativeId: 5 })])),
    (e) => e instanceof ReadError && /appears twice/.test(e.message),
  );
});

test('evalScript\'s error string is reported as such, not as a JSON parse error', () => {
  assert.throws(() => parseCompState('EvalScript error.'),
    (e) => e instanceof ReadError && /did not return JSON/.test(e.message));
  assert.throws(() => parseCompState(''),
    (e) => e instanceof ReadError && /did not return JSON/.test(e.message));
});

// ---- normalization ---------------------------------------------------------

test('a non-numeric property value is dropped with a warning, never passed on', () => {
  const s = normalizeCompState(payload([
    hostLayer({ name: 'Odd', props: { opacity: 100, shape: 'a Shape object', bad: [1, null] } }),
  ]));
  assert.deepEqual(Object.keys(s.layers[0].props), ['opacity']);
  assert.equal(s.warnings.filter((w) => w.kind === 'badValue').length, 2);
});

test('parents travel as tags, not indices', () => {
  const s = normalizeCompState(payload([
    hostLayer({ index: 1, comment: tagFor('kid'), nodeId: 'kid', parentIndex: 2, parentTag: 'dad' }),
    hostLayer({ index: 2, comment: tagFor('dad'), nodeId: 'dad' }),
  ]));
  assert.equal(s.layers[0].parentTag, 'dad');
});

test('the revision the state was read at is carried through', () => {
  // S4: P1.4 compares this before trusting the state or writing from it.
  assert.equal(normalizeCompState(payload([hostLayer()])).revision, 7);
});

// ---- the two halves meeting ------------------------------------------------

test('a recorded comp reads into a state the diff can use unchanged', () => {
  // The join P1.1 exists for: host payload -> reader -> diff, with no adapter
  // in between and no AE running.
  const raw = JSON.stringify(payload([
    hostLayer({
      index: 1, name: 'Target', comment: tagFor('b'), nodeId: 'b',
      props: { opacity: 100, position: [0, 0] },
      expressions: { position: expressionFor('e1', expressionBody('Source', '.transform.position')) },
    }),
    hostLayer({ index: 2, name: 'Source', comment: tagFor('a'), nodeId: 'a',
      props: { opacity: 100, position: [960, 540] } }),
    hostLayer({ index: 3, name: "the user's own layer", comment: '' }),
  ]));

  const state = parseCompState(raw);

  const g = createGraph();
  addNode(g, { id: 'a', name: 'Source', props: { opacity: 100, position: [960, 540] } });
  addNode(g, { id: 'b', name: 'Target', props: { opacity: 50, position: [0, 0] } });
  addEdge(g, { id: 'e1', from: 'a', to: 'b', fromProp: '.transform.position', toProp: 'position' });

  const r = diff(g, state);

  // The edge is already satisfied; only the opacity differs, and the order needs swapping.
  assert.equal(r.ops.length, 2);
  assert.equal(r.ops.find(o => o.op === 'setProp').prop, 'opacity');
  assert.ok(r.ops.find(o => o.op === 'reorder'));
  assert.equal(r.stats.untaggedLayers, 1);
  assert.equal(r.warnings.length, 0);
});

test('an untagged layer survives the round trip untouched', () => {
  const state = parseCompState(JSON.stringify(payload([
    hostLayer({ name: 'precious', comment: 'my note', props: { opacity: 3 } }),
  ])));
  const r = diff(createGraph(), state);
  assert.equal(r.ops.length, 0);
  assert.equal(r.stats.untaggedLayers, 1);
});
