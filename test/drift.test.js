// Offline tests for P1.4's drift guard.
//
// The guard's job is to answer "did the comp move under us, and does it matter"
// cheaply enough to ask constantly. Two things are being tested, and they pull in
// opposite directions:
//
//   - it must NOT cry wolf. A user selecting a layer, or editing a different
//     comp, moves app.project.revision. A guard that reported that as drift would
//     stop the reconciler every few seconds.
//   - it must NOT miss the five changes that invalidate the graph's identities.
//     Those are the ones a patch must never be computed through.
//
// What these cannot prove is that After Effects moves `revision` when and only
// when this assumes. That is jsx/p1b-check.jsx, run inside AE.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  snapshot, compareSnapshots, projectSnapshot, createDriftGuard,
  fnv1a, canonicalValue, parseRevision, revisionCall, DriftError,
} from '../src/drift.js';
import { tagFor, expressionFor, expressionBody } from '../src/graph.js';

// A compState the way the reader hands one over. Written out here rather than
// read through the reader, so a guard bug cannot hide behind a reader bug.
function state({ revision = 10, compId = 1, layers = [] } = {}) {
  return {
    compName: 'Shot 01',
    compId,
    revision,
    duration: 10,
    frameRate: 24,
    layers: layers.map((l, i) => ({
      nativeId: l.nativeId ?? 500 + i,
      index: l.index ?? i + 1,
      name: l.name ?? `L${i}`,
      comment: l.node ? tagFor(l.node) : (l.comment ?? ''),
      kind: l.kind ?? 'footage',
      enabled: l.enabled !== false,
      inPoint: l.inPoint ?? 0,
      outPoint: l.outPoint ?? 5,
      parentTag: l.parentTag ?? null,
      parentIndex: null,
      props: l.props ?? { opacity: 100, position: [960, 540] },
      expressions: l.expressions ?? {},
      source: l.source ?? null,
    })),
  };
}

const base = () => state({
  layers: [
    { node: 'a', name: 'Source', nativeId: 501 },
    { node: 'b', name: 'Target', nativeId: 502 },
    { name: 'THE USER LAYER', nativeId: 503, comment: 'notes' },
  ],
});

const kinds = (report) => report.changes.map((c) => c.kind);

// ---- the digest ------------------------------------------------------------

test('the digest is stable across reads and moves when a value moves', () => {
  const a = snapshot(base());
  const b = snapshot(base());
  assert.equal(a.digest, b.digest, 'two reads of the same comp digest identically');

  const moved = base();
  moved.layers[0].props.opacity = 99;
  assert.notEqual(snapshot(moved).digest, a.digest);
});

test('a float AE round-trips imperfectly is not drift', () => {
  // 1e-6 is the same tolerance diff's valueEquals uses. If the digest were
  // stricter than the diff, the guard would report drift the diff then found
  // nothing to correct - and the loop would read, report and write forever.
  const nudged = base();
  nudged.layers[0].props.position = [960.0000001, 540];
  assert.equal(snapshot(nudged).digest, snapshot(base()).digest);

  const real = base();
  real.layers[0].props.position = [960.01, 540];
  assert.notEqual(snapshot(real).digest, snapshot(base()).digest);
});

test('a layer index is not part of the digest', () => {
  // Inserting a layer renumbers everything below it. If index were digested,
  // one insert would report every layer in the comp as drifted.
  const reindexed = base();
  reindexed.layers[0].index = 7;
  reindexed.layers[1].index = 9;
  assert.equal(snapshot(reindexed).managedDigest, snapshot(base()).managedDigest);
});

test('fnv1a stays in 32 bits and depends on every character', () => {
  assert.equal(fnv1a('').length, 8);
  assert.equal(fnv1a('a'), fnv1a('a'));
  assert.notEqual(fnv1a('ab'), fnv1a('ba'));
  // The shift form must not drift from the multiply form into float territory:
  // a long input still has to produce eight hex digits, not NaN or 1e+21.
  const long = fnv1a('x'.repeat(5000));
  assert.match(long, /^[0-9a-f]{8}$/);
});

test('canonicalValue distinguishes the cases that would otherwise collide', () => {
  assert.notEqual(canonicalValue(100), canonicalValue('100'));
  assert.notEqual(canonicalValue([1, 2]), canonicalValue([2, 1]));
  assert.equal(canonicalValue(null), canonicalValue(undefined));
});

// ---- what counts as drift, and what does not -------------------------------

test('the user editing their OWN layers is reported but never blocking', () => {
  const before = snapshot(base());
  const after = state({
    revision: 11,
    layers: [
      { node: 'a', name: 'Source', nativeId: 501 },
      { node: 'b', name: 'Target', nativeId: 502 },
      { name: 'THE USER LAYER', nativeId: 503, comment: 'notes' },
      { name: 'their new layer', nativeId: 504, comment: '' },
    ],
  });
  const r = compareSnapshots(before, snapshot(after));
  assert.equal(r.drifted, false, 'nothing we own moved');
  assert.equal(r.verdict, 'clean');
  assert.equal(r.foreignMoved, true);
  assert.equal(r.foreignDelta, 1);
});

test('a revision that moved with nothing behind it is spurious, not drift', () => {
  const guard = createDriftGuard();
  guard.mark(base());
  // A selection, a view change, an edit in another comp: revision moves, the
  // comp does not. This is the case the digest tier exists to make cheap.
  const r = guard.inspect(state({
    revision: 99,
    layers: [
      { node: 'a', name: 'Source', nativeId: 501 },
      { node: 'b', name: 'Target', nativeId: 502 },
      { name: 'THE USER LAYER', nativeId: 503, comment: 'notes' },
    ],
  }));
  assert.equal(r.drifted, false);
  assert.equal(r.revisionMoved, true);
  assert.equal(r.spuriousRevision, true);
});

test('a value the user nudged on one of our layers is reported, not refused', () => {
  // The graph is the source of truth here, so the next diff simply corrects it.
  const before = snapshot(base());
  const after = base();
  after.revision = 11;
  after.layers[0].props.opacity = 60;
  const r = compareSnapshots(before, snapshot(after));
  assert.deepEqual(kinds(r), ['propChanged']);
  assert.equal(r.verdict, 'report');
  assert.equal(r.blocking.length, 0);
});

test('the five changes that invalidate an identity are all blocking', () => {
  const before = snapshot(base());

  const gone = base();
  gone.layers.splice(0, 1);
  assert.equal(compareSnapshots(before, snapshot(gone)).verdict, 'refuse');
  assert.deepEqual(kinds(compareSnapshots(before, snapshot(gone))), ['vanished']);

  // M4 Phase C: The tag survived but it is on a different layer - what precompose does
  // (S3: the native id does not survive it), and what a delete-and-paste does.
  // Because the tag is unique, it is 'rebindable', not 'replaced', and does not block.
  const replaced = base();
  replaced.layers[0].nativeId = 777;
  const replacedReport = compareSnapshots(before, snapshot(replaced));
  assert.deepEqual(kinds(replacedReport), ['rebindable']);
  assert.equal(replacedReport.verdict, 'report');

  const duped = base();
  duped.layers.push({ ...duped.layers[0], nativeId: 778 });
  assert.ok(kinds(compareSnapshots(before, snapshot(duped))).includes('duplicated'));

  const otherComp = base();
  otherComp.compId = 2;
  otherComp.compName = 'Shot 02';
  assert.deepEqual(kinds(compareSnapshots(before, snapshot(otherComp))), ['compChanged']);

  // An edge we authored, come back hand-written. The only expression case that
  // blocks: writing over it would throw the user's work away.
  const withEdge = base();
  withEdge.layers[1].expressions = { position: expressionFor('e1', expressionBody('Source', '.transform.position')) };
  const edged = snapshot(withEdge);
  const takenOver = base();
  takenOver.layers[1].expressions = { position: 'wiggle(2,30)' };
  const r = compareSnapshots(edged, snapshot(takenOver));
  assert.deepEqual(kinds(r), ['edgeTakenOver']);
  assert.equal(r.verdict, 'refuse');
});

test('a layer appearing with a tag we did not create is drift', () => {
  const before = snapshot(base());
  const after = base();
  after.layers.push({ nativeId: 900, index: 4, name: 'C', comment: tagFor('c'),
    kind: 'footage', enabled: true, inPoint: 0, outPoint: 5, parentTag: null,
    props: {}, expressions: {} });
  assert.deepEqual(kinds(compareSnapshots(before, snapshot(after))), ['appeared']);
});

test('a reorder is reported only when nothing else explains it', () => {
  const before = snapshot(base());
  const swapped = base();
  [swapped.layers[0], swapped.layers[1]] = [swapped.layers[1], swapped.layers[0]];
  assert.deepEqual(kinds(compareSnapshots(before, snapshot(swapped))), ['reordered']);

  // Same reorder, but a layer also vanished: the reorder is a consequence, and
  // reporting it alongside would be noise on top of the finding that matters.
  const withDelete = base();
  withDelete.layers.splice(0, 1);
  assert.deepEqual(kinds(compareSnapshots(before, snapshot(withDelete))), ['vanished']);
});

test('renames, reparents, toggles and retimes each say which field moved', () => {
  const before = snapshot(base());
  const after = base();
  after.layers[0].name = 'Renamed';
  after.layers[0].enabled = false;
  after.layers[1].parentTag = 'a';
  after.layers[1].outPoint = 9;
  const r = compareSnapshots(before, snapshot(after));
  assert.deepEqual(kinds(r).sort(), ['renamed', 'reparented', 'retimed', 'toggled']);
  assert.equal(r.verdict, 'report');
});

// ---- the gate --------------------------------------------------------------

test('the gate is the only thing that runs while nothing moves', () => {
  const guard = createDriftGuard();
  assert.equal(guard.gate(10).status, 'unknown', 'with no baseline it cannot say');
  guard.mark(base());
  assert.equal(guard.gate(10).status, 'clean');
  assert.equal(guard.gate(11).status, 'moved');
});

test('the revision gate reply is parsed, and a host failure is not a number', () => {
  assert.equal(revisionCall(), 'NTL_Revision()');
  assert.equal(parseRevision('{"ok":true,"revision":42}'), 42);
  assert.throws(() => parseRevision('EvalScript error.'), DriftError);
  assert.throws(() => parseRevision('{"ok":false,"message":"no project"}'),
    (e) => e instanceof DriftError && /no project/.test(e.message));
});

// ---- the write gate --------------------------------------------------------

test('assertWritable throws on blocking drift and returns on everything else', () => {
  const guard = createDriftGuard();
  guard.mark(base());

  const nudged = base();
  nudged.layers[0].props.opacity = 60;
  assert.equal(guard.assertWritable(nudged).verdict, 'report', 'a nudge does not stop a write');

  guard.mark(base());
  const gone = base();
  gone.layers.splice(0, 1);
  assert.throws(() => guard.assertWritable(gone),
    (e) => e instanceof DriftError && /moved under the reconciler/.test(e.message));
});

test("onDrift 'report' writes anyway, and says what it wrote over", () => {
  const guard = createDriftGuard({ onDrift: 'report' });
  guard.mark(base());
  const gone = base();
  gone.layers.splice(0, 1);
  const r = guard.assertWritable(gone);
  assert.equal(r.verdict, 'refuse', 'the verdict is unchanged - only the enforcement is');
  assert.equal(r.blocking.length, 1);
});

test('the first read has no baseline to compare against, and says so', () => {
  const guard = createDriftGuard();
  const r = guard.inspect(base());
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.firstRead, true);
  assert.equal(r.drifted, false);
});

// ---- the projection --------------------------------------------------------

test('our own patch is not drift: the baseline moves through the ops', () => {
  const guard = createDriftGuard();
  guard.mark(base());

  const ops = [
    { op: 'setProp', node: 'a', prop: 'opacity', from: 100, to: 50 },
    { op: 'setName', node: 'b', from: 'Target', to: 'Renamed' },
    { op: 'setParent', node: 'b', from: null, to: 'a' },
  ];
  assert.equal(guard.advance(ops, 11), true);
  assert.equal(guard.revision, 11);

  // The comp as it now stands - exactly what we asked for. Nothing else moved,
  // so the guard must see nothing at all.
  const applied = base();
  applied.revision = 11;
  applied.layers[0].props.opacity = 50;
  applied.layers[1].name = 'Renamed';
  applied.layers[1].parentTag = 'a';
  const r = guard.inspect(applied);
  assert.equal(r.drifted, false, `the projection reported: ${kinds(r).join(', ')}`);
});

test('a projected baseline still catches someone ELSE editing in the same window', () => {
  const guard = createDriftGuard();
  guard.mark(base());
  guard.advance([{ op: 'setProp', node: 'a', prop: 'opacity', to: 50 }], 11);

  const alsoTouched = base();
  alsoTouched.revision = 12;
  alsoTouched.layers[0].props.opacity = 50;      // ours
  alsoTouched.layers[1].props.opacity = 7;       // not ours
  const r = guard.inspect(alsoTouched);
  assert.deepEqual(kinds(r), ['propChanged']);
  assert.equal(r.changes[0].node, 'b');
});

test('a patch that created a layer earns a fresh read instead of a guess', () => {
  // The native id and the out point are AE's to decide. A baseline holding
  // guesses for them would report our own creation as drift on every later pass.
  const guard = createDriftGuard();
  guard.mark(base());
  assert.equal(guard.advance([{ op: 'createLayer', node: 'c', kind: 'solid', name: 'C' }], 11), false);
  assert.equal(guard.baseline, null);
  assert.equal(guard.gate(11).status, 'unknown', 'which forces a real read next pass');
});

test('an op the projection does not know throws the baseline away', () => {
  // Silently ignoring it would make the baseline a lie, and the next compare
  // would report the gap as someone else's drift.
  assert.equal(projectSnapshot(snapshot(base()), [{ op: 'reorder', node: 'a' }], 11), null);
});

test('a delete projects, because we know exactly what is gone', () => {
  const guard = createDriftGuard();
  guard.mark(base());
  assert.equal(guard.advance([{ op: 'deleteLayer', node: 'b', nativeId: 502 }], 11), true);
  const after = base();
  after.revision = 11;
  after.layers.splice(1, 1);
  assert.equal(guard.inspect(after).drifted, false);
});

// ---- the control -----------------------------------------------------------

test('CONTROL: a guard that skips the compare passes nothing', () => {
  // Every test above would still pass against a guard that reported drift
  // constantly, or never. This one fails both.
  const blind = {
    mark() {}, inspect: () => ({ drifted: false, changes: [], blocking: [], verdict: 'clean' }),
  };
  const gone = base();
  gone.layers.splice(0, 1);
  assert.equal(blind.inspect(gone).verdict, 'clean');

  const real = createDriftGuard();
  real.mark(base());
  assert.notEqual(real.inspect(gone).verdict, 'clean',
    'the real guard must disagree with the blind one, or these tests prove nothing');
});

// ---- M2: effects and blend modes -------------------------------------------

test('drift guard detects effect and blend mode changes', () => {
  const guard = createDriftGuard();
  const state = base();
  
  // Base state
  state.layers[0].blendMode = 'normal';
  state.layers[0].effects = [
    { matchName: 'ADBE Fill', name: 'Fill', params: { 'ADBE Fill-0002': [1, 0, 0, 1] } }
  ];
  guard.mark(state);
  
  // Change blend mode
  const b1 = JSON.parse(JSON.stringify(state));
  b1.revision++;
  b1.layers[0].blendMode = 'multiply';
  
  const r1 = guard.inspect(b1);
  assert.equal(r1.drifted, true);
  assert.equal(r1.changes[0].kind, 'blendModeChanged');
  
  // Change effect param
  const b2 = JSON.parse(JSON.stringify(state));
  b2.revision++;
  b2.layers[0].effects[0].params['ADBE Fill-0002'] = [0, 1, 0, 1];
  
  const r2 = guard.inspect(b2);
  assert.equal(r2.drifted, true);
  assert.equal(r2.changes[0].kind, 'effectParamChanged');
  
  // Remove effect (blocking)
  const b3 = JSON.parse(JSON.stringify(state));
  b3.revision++;
  b3.layers[0].effects = [];
  
  const r3 = guard.inspect(b3);
  assert.equal(r3.drifted, true);
  assert.equal(r3.changes[0].kind, 'effectRemoved');
  assert.ok(r3.blocking.some(c => c.kind === 'effectRemoved'), 'losing a managed effect is blocking drift');
});

test('footage relinking is visible as source drift', () => {
  const before = state({ layers: [{ node: 'plate', source: {
    kind: 'footage', itemId: 5, path: 'D:/old/plate.mov', missing: false,
  } }] });
  const after = state({ layers: [{ node: 'plate', source: {
    kind: 'footage', itemId: 5, path: 'D:/new/plate.mov', missing: false,
  } }] });
  const report = compareSnapshots(snapshot(before), snapshot(after));
  assert.equal(report.changes.some((change) => change.kind === 'sourceChanged'), true);
  assert.equal(report.blocking.length, 0);
});
