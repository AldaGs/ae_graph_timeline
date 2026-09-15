// A text layer's string, end to end, against the real reader.jsx and patch.jsx
// in a VM.
//
// Until this existed the feature was half-present in a way that is worse than
// absent: "+ Text" called addText('') and made an empty layer, and nothing in
// the panel, the model, the diff or the writer could ever put a word in it.
//
// The claim under test is the round trip - the string the graph holds becomes
// the string After Effects holds, the typography survives the write, and the
// two states AE refuses are refused here first with a sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAE } from './fake-ae.js';
import { createGraph, addNode, setNodeField, tagFor, nodeIdFromTag, hydrateFromComp } from '../src/graph.js';
import { diff } from '../src/diff.js';
import { readCompCall, parseCompState } from '../src/reader.js';
import { applyPatchCall, parseReceipt, PatchError } from '../src/patch.js';
import { createWriteLoop } from '../src/loop.js';

const read = (ae) => parseCompState(ae.eval(readCompCall({ includeEffects: true })));
// parseCompState carries the layer's COMMENT, not a node id: the tag is the
// identity and the diff derives it the same way.
const managed = (ae, nodeId) => read(ae).layers.find((l) => nodeIdFromTag(l.comment) === nodeId);
const apply = (ae, ops) => parseReceipt(ae.eval(applyPatchCall(ops, { compId: ae.comp.id })));

function scene() {
  const ae = makeAE();
  const layer = ae.comp.add('Title', { comment: tagFor('t1'), kind: 'text' });
  layer.textDocument.text = 'Hello';
  const graph = createGraph();
  addNode(graph, { id: 't1', kind: 'text', name: 'Title', nativeId: layer.id, text: 'Hello' });
  return { ae, graph, layer };
}

test('the reader reports a text layer\'s string', () => {
  const { ae } = scene();
  const layer = managed(ae, 't1');
  assert.equal(layer.kind, 'text');
  assert.equal(layer.text, 'Hello');
  assert.equal(layer.textLocked, undefined);
});

test('only a text layer reports one, because only one has the property', () => {
  // `undefined` means "not read", and the diff refuses to write a field it
  // never saw - which is what stops a solid from being "corrected" to a string.
  const ae = makeAE();
  ae.comp.add('Background', { comment: tagFor('bg'), kind: 'solid' });
  const layer = managed(ae, 'bg');
  assert.equal(layer.text, undefined);
});

test('changing the string emits one op, and After Effects follows', () => {
  const { ae, graph, layer } = scene();
  setNodeField(graph, 't1', 'text', 'Goodbye');

  const ops = diff(graph, read(ae)).ops;
  assert.deepEqual(ops.map((o) => o.op), ['setText']);
  assert.deepEqual(ops[0], { op: 'setText', node: 't1', from: 'Hello', to: 'Goodbye' });

  assert.equal(apply(ae, ops).ok, true);
  assert.equal(layer.textDocument.text, 'Goodbye');

  // And it settles: the graph and the comp now agree.
  assert.deepEqual(diff(graph, read(ae)).ops, []);
});

test('the typography survives the write', () => {
  // The whole reason the writer mutates the TextDocument it was handed instead
  // of constructing a fresh one: a new document resets font, size, colour and
  // tracking to AE's defaults - the user's typography thrown away to change a
  // word.
  const { ae, graph, layer } = scene();
  Object.assign(layer.textDocument, { font: 'Futura', fontSize: 120, tracking: 40 });
  setNodeField(graph, 't1', 'text', 'Goodbye');
  apply(ae, diff(graph, read(ae)).ops);

  assert.equal(layer.textDocument.text, 'Goodbye');
  assert.equal(layer.textDocument.font, 'Futura');
  assert.equal(layer.textDocument.fontSize, 120);
  assert.equal(layer.textDocument.tracking, 40);
});

test('a keyframed string is reported locked, and never written over', () => {
  // The same rule every other property follows. Reported by the READER so the
  // panel can show the field read-only, rather than letting the user type into
  // something the writer will refuse.
  const { ae, graph, layer } = scene();
  layer.sourceText.numKeys = 3;

  const observed = read(ae);
  assert.equal(observed.layers.find((l) => nodeIdFromTag(l.comment) === 't1').textLocked, true);

  setNodeField(graph, 't1', 'text', 'Goodbye');
  assert.deepEqual(diff(graph, observed).ops, [], 'the diff does not ask');

  // And if something asked anyway, the writer refuses with a sentence.
  assert.throws(() => apply(ae, [{ op: 'setText', node: 't1', to: 'Goodbye' }]),
    (e) => e instanceof PatchError && /keyframed/.test(e.message));
  assert.equal(layer.textDocument.text, 'Hello');
});

test('an expression-driven string is refused the same way', () => {
  const { ae, graph, layer } = scene();
  layer.sourceText.expressionEnabled = true;
  layer.sourceText.canSetExpression = false;
  assert.equal(managed(ae, 't1').textLocked, true);
  setNodeField(graph, 't1', 'text', 'Goodbye');
  assert.deepEqual(diff(graph, read(ae)).ops, []);
});

test('setText aimed at a layer that is not text is refused', () => {
  const ae = makeAE();
  ae.comp.add('Background', { comment: tagFor('bg'), kind: 'solid' });
  assert.throws(() => apply(ae, [{ op: 'setText', node: 'bg', to: 'nope' }]),
    (e) => e instanceof PatchError && /not a text layer/.test(e.message));
});

test('the model refuses text on a layer that has nowhere to put it', () => {
  // Refused in the MODEL rather than at the panel, because the model is what
  // the writer is handed and the panel is not the only thing that can reach it.
  const graph = createGraph();
  addNode(graph, { id: 'bg', kind: 'solid', name: 'Background' });
  assert.throws(() => setNodeField(graph, 'bg', 'text', 'nope'),
    /Only a text layer has editable text/);
  addNode(graph, { id: 't1', kind: 'text', name: 'Title' });
  assert.throws(() => setNodeField(graph, 't1', 'text', 42), /Text must be a string/);
  assert.equal(setNodeField(graph, 't1', 'text', 'ok').text, 'ok');
  assert.equal(setNodeField(graph, 't1', 'text', 'ok'), null, 'no change, no op');
});

test('a created text layer is given its string in the same pass', async () => {
  // A node created with text must not need a second round trip to receive it:
  // the layer would exist empty for one write cycle, which is a frame of the
  // comp showing the wrong thing.
  const ae = makeAE();
  const graph = createGraph();
  addNode(graph, { id: 't1', kind: 'text', name: 'Title', text: 'Hello' });

  const loop = createWriteLoop({ host: ae.host, graph, observeAfterPatch: true, includeEffects: true });
  loop.touch();
  await loop.flush();

  const layer = ae.comp.byTag('t1');
  assert.equal(layer.kind, 'text');
  assert.equal(layer.textDocument.text, 'Hello');
  assert.deepEqual(diff(graph, read(ae)).ops, [], 'settled after one pass');
  await loop.close();
});

test('a text layer reopened from the comp brings its string back', () => {
  // Hydration is what runs when the panel opens onto a comp it has no saved
  // graph for. A string it dropped would be a string the diff then wrote back
  // as empty.
  const { ae } = scene();
  const graph = createGraph();
  hydrateFromComp(graph, read(ae));
  assert.equal(graph.nodes.t1.text, 'Hello');
  assert.deepEqual(diff(graph, read(ae)).ops, []);
});
