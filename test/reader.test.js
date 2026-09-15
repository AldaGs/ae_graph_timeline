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
  classifyActiveComp, classifyProjectPath, graphFilePathFor,
} from '../src/reader.js';
import { diff } from '../src/diff.js';
import { createGraph, addNode, addEdge, tagFor, expressionFor, expressionBody } from '../src/graph.js';
import { makeAE } from './fake-ae.js';
import {
  clampCompFrame, clampFrame, parseTransportState, setCurrentFrameCall, transportStateCall,
  TransportError,
} from '../src/transport.js';
import { selectFootageCall, parseFootageSelection } from '../src/footage.js';

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

test('the transport call stays frame-based at the panel boundary', () => {
  assert.equal(transportStateCall(42), 'NTL_TransportState(42)');
  assert.equal(setCurrentFrameCall(42, 12.6), 'NTL_SetCurrentFrame(42, 13)');
});

test('the transport uses AE display start, work area and frame rate', () => {
  const ae = makeAE();
  ae.comp.displayStartFrame = 1001;
  ae.comp.displayStartTime = 1001 / 24;
  ae.comp.workAreaStart = 1;
  ae.comp.workAreaDuration = 3;
  ae.comp.time = 1.5;

  const beforeRevision = ae.project.revision;
  const state = parseTransportState(ae.eval(transportStateCall(ae.comp.id)));
  assert.deepEqual({
    current: state.currentFrame,
    start: state.startFrame,
    end: state.endFrame,
    workStart: state.workStartFrame,
    workEnd: state.workEndFrame,
    fps: state.frameRate,
  }, { current: 1037, start: 1001, end: 1240, workStart: 1025, workEnd: 1096, fps: 24 });

  const moved = parseTransportState(ae.eval(setCurrentFrameCall(ae.comp.id, 1026)));
  assert.equal(moved.currentFrame, 1026);
  assert.ok(Math.abs(ae.comp.time - (25 / 24)) < 1e-12);
  assert.equal(ae.project.revision, beforeRevision, 'moving the CTI is not a project edit');
});

test('transport seeks clamp to the comp while playback remains bounded by the work area', () => {
  const ae = makeAE();
  ae.comp.workAreaStart = 2;
  ae.comp.workAreaDuration = 2;
  const moved = parseTransportState(ae.eval(setCurrentFrameCall(ae.comp.id, 999)));
  assert.equal(moved.currentFrame, 239);
  assert.equal(clampFrame(-10, moved), 48);
  assert.equal(clampCompFrame(-10, moved), 0);
  assert.throws(() => parseTransportState('{"ok":true,"frameRate":24}'),
    (e) => e instanceof TransportError && /incomplete/.test(e.message));
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

test('the footage picker distinguishes cancel from a selected native path', () => {
  const ae = makeAE();
  assert.deepEqual(parseFootageSelection(ae.eval(selectFootageCall())), { selected: false });
  ae.app.nextOpenFile = 'D:/shot/plate.mov';
  assert.deepEqual(parseFootageSelection(ae.eval(selectFootageCall())), {
    selected: true, path: 'D:/shot/plate.mov', name: 'plate.mov',
  });
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

// ---- M4.8: R1, label and blend mode at the reader boundary ----------------

test('label and blend mode survive a real host read, and a change in AE is seen', () => {
  // R1 in docs/M4.7_REVIEW.md: the host built layer records without these two
  // fields, so the inspector could change them, the diff would report clean,
  // and After Effects kept the old value forever.
  const ae = makeAE();
  const layer = ae.comp.add('Tagged', { comment: tagFor('a'), label: 4 });
  layer.blendingMode = ae.ctx.BlendingMode?.MULTIPLY ?? 5222;

  const state = parseCompState(ae.eval(readCompCall({ includeEffects: true })));
  const read = state.layers.find((l) => l.comment === tagFor('a'));
  assert.equal(read.label, 4, 'label reached the panel');
  assert.equal(read.blendMode, 'multiply', 'the BlendingMode enum was named');

  // And the diff now has something to compare against.
  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'Tagged', label: 2, blendMode: 'screen',
    props: { ...read.props } });
  const ops = diff(graph, state).ops.map((op) => op.op).sort();
  assert.deepEqual(ops, ['setBlendMode', 'setLabel']);
});

test('the host names exactly which effect parameters can carry expressions', () => {
  const ae = makeAE();
  const layer = ae.comp.add('Tagged', { comment: tagFor('a') });
  const effect = layer.effectParade.addProperty('ADBE Fill');
  const color = effect.property('ADBE Fill-0002');
  color._value = [1, 0, 0, 1];
  const topic = effect.property('ADBE Fill-0001');
  topic.canSetExpression = false;

  const state = parseCompState(ae.eval(readCompCall({ includeEffects: true })));
  assert.deepEqual(state.layers[0].effects[0].expressionParams, ['ADBE Fill-0002']);
});

test('an unmanaged layer contributes neither label nor blend mode', () => {
  // Same rule as the properties: a field on a layer that is not ours must not
  // reach the diff, because anything in compState looks writable to it.
  const ae = makeAE();
  ae.comp.add("the user's own", { comment: 'notes', label: 7 });
  const state = parseCompState(ae.eval(readCompCall()));
  const theirs = state.layers[0];
  assert.equal(theirs.label, undefined);
  assert.equal(theirs.blendMode, undefined);
});

test('a blend mode this build cannot name is reported, never guessed as normal', () => {
  const state = normalizeCompState(payload([
    hostLayer({ comment: tagFor('a'), blendMode: null }),
  ]));
  assert.equal(state.layers[0].blendMode, undefined, 'not silently "normal"');
  assert.deepEqual(state.warnings.map((w) => w.kind), ['unknownBlendMode']);
});

test('the comp frame is carried so a new layer can be centred in it', () => {
  const ae = makeAE();
  const state = parseCompState(ae.eval(readCompCall()));
  assert.equal(state.width, 1920);
  assert.equal(state.height, 1080);
});

test('the reader carries shy layer and composition visibility state', () => {
  const ae = makeAE();
  const layer = ae.comp.add('Effect Host', { comment: tagFor('fx'), kind: 'null' });
  layer.shy = true;
  ae.comp.hideShyLayers = true;

  const state = parseCompState(ae.eval(readCompCall()));
  assert.equal(state.layers[0].shy, true);
  assert.equal(state.hideShyLayers, true);
});

test('the reader carries file-backed source identity for managed footage', () => {
  const ae = makeAE();
  const item = ae.project.importFile(new ae.ctx.ImportOptions(new ae.ctx.File('D:/shot/plate.mov')));
  const layer = ae.comp.layers.add(item);
  layer.comment = tagFor('plate');

  const state = parseCompState(ae.eval(readCompCall()));
  assert.deepEqual(state.layers[0].source, {
    kind: 'footage', itemId: item.id, name: 'plate.mov',
    path: 'D:/shot/plate.mov', missing: false,
  });
});

// ---- M4.9: the project's own path, so the graph's sidecar can follow it ----

test('the identity check carries the project path, and normalizes an unsaved one', () => {
  const saved = parseActiveComp(JSON.stringify(
    { ok: true, active: true, compName: 'Shot', compId: 3, projectPath: 'C:/work/shot.aep' }));
  assert.equal(saved.projectPath, 'C:/work/shot.aep');
  // An unsaved project has no file. That is a fact, not a failure, and the
  // caller must not have to tell "" from undefined.
  assert.equal(parseActiveComp('{"ok":true,"active":true,"compName":"S","compId":3}').projectPath, null);
  assert.equal(parseActiveComp('{"ok":true,"active":false,"projectPath":""}').projectPath, null);
});

test('the host reports the project path alongside the active comp', () => {
  const ae = makeAE();
  ae.project.file = { fsName: 'C:/work/shot.aep' };
  const active = parseActiveComp(ae.eval(activeCompCall()));
  assert.equal(active.projectPath, 'C:/work/shot.aep');
  assert.equal(active.compId, ae.comp.id);
});

test('Save As is classified as a move, so the sidecar can be re-pointed', () => {
  // The symptom: saving the .aep to another path left the .ntl file next to the
  // OLD project, where reopening the new one would never find it. Nothing in the
  // panel noticed, because the path was read once at startup.
  const at = (projectPath) => ({ active: true, compId: 3, projectPath });
  assert.equal(classifyProjectPath('C:/a.aep', at('C:/a.aep')), 'same');
  assert.equal(classifyProjectPath('C:/a.aep', at('C:/b.aep')), 'moved');
  assert.equal(classifyProjectPath(null, at('C:/b.aep')), 'saved');
  assert.equal(classifyProjectPath('C:/a.aep', at(null)), 'unsaved');
  assert.equal(classifyProjectPath(undefined, at('C:/b.aep')), 'untracked');
});

test('the sidecar path is derived in exactly one place', () => {
  // Two places computing this string is two places for it to drift, and a
  // sidecar written where nothing later reads it is a graph the user believes
  // is saved.
  assert.equal(graphFilePathFor('C:/work/shot.aep', 12), 'C:/work/shot.aep.comp-12.ntl');
  assert.equal(graphFilePathFor(null, 12), null);
  assert.equal(graphFilePathFor('C:/work/shot.aep', null), null);
  assert.equal(graphFilePathFor('C:/work/shot.aep', undefined), null);
});
