import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, addNode, addEdge } from '../src/graph.js';
import { serializeGraph, parseGraph, createGraphStore, inspectSavedGraph } from '../src/persistence.js';
import { classifyProjectPath, graphFilePathFor } from '../src/reader.js';

test('reopen tolerates observed AE precision rounding and rebinds a unique tag', () => {
  const graph = createGraph('Comp 1');
  addNode(graph, { id: 'n2', kind: 'null', name: 'Null n2', nativeId: 19,
    props: { position: [669.33332824707, 628, 0] } });
  const baseline = { compId: 1, revision: 934, layers: [{ nativeId: 19, name: 'Null n2',
    comment: 'ntl:n2', kind: 'null', props: { position: [669.33332824707, 628, 0] } }] };
  const current = JSON.parse(JSON.stringify(baseline));
  current.revision = 94;
  current.layers[0].nativeId = 17;
  current.layers[0].props.position[0] = 669.333312988281;
  const inspected = inspectSavedGraph(graph, baseline, current);
  assert.equal(inspected.graph.nodes.n2.nativeId, 17);
  assert.deepEqual(inspected.diagnostic.ops, []);
  assert.equal(inspected.baselineChanged, false);
  assert.equal(graph.nodes.n2.nativeId, 19);
  current.layers[0].props.position[0] += 0.01;
  assert.equal(inspectSavedGraph(graph, baseline, current).baselineChanged, true);
  current.layers.push({ ...current.layers[0], nativeId: 20 });
  assert.equal(inspectSavedGraph(graph, baseline, current).graph.nodes.n2.nativeId, 19);
});

test('graph document preserves all graph-only data and refuses future versions', () => {
  const graph = createGraph('Shot');
  addNode(graph, { id: 'a', ui: { x: 33, y: 77 }, nativeId: 15 });
  addNode(graph, { id: 'e', kind: 'expression', expression: 'time * 10;' });
  addEdge(graph, { id: 'wire', from: 'e', to: 'a' });
  const text = serializeGraph(graph, { projectPath: 'shot.aep', compId: 7 });
  assert.deepEqual(parseGraph(text).graph, graph);
  assert.throws(() => parseGraph(text.replace('"schemaVersion": 1', '"schemaVersion": 2')), /version/);
});

test('interrupted writes preserve the last file and corruption recovers the backup', () => {
  const files = new Map();
  let interrupt = false;
  const fs = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error('missing'); return files.get(p); },
    writeFileSync: (p, text) => files.set(p, text),
    renameSync: (from, to) => {
      if (interrupt && to === 'shot.ntl') throw new Error('interrupted');
      files.set(to, files.get(from)); files.delete(from);
    },
  };
  const store = createGraphStore(fs);
  const graph = createGraph('First');
  store.save('shot.ntl', serializeGraph(graph, { compId: 1 }));
  graph.compName = 'Second';
  interrupt = true;
  assert.throws(() => store.save('shot.ntl', serializeGraph(graph, { compId: 1 })), /interrupted/);
  assert.equal(store.load('shot.ntl').document.graph.compName, 'First');
  files.set('shot.ntl', '{broken');
  assert.equal(store.load('shot.ntl').recovered, true);
  assert.equal(store.load('shot.ntl').document.graph.compName, 'First');
});

// ---- M4.9: the sidecar follows the project ---------------------------------

// A filesystem in a Map, so a move can be checked by looking at what exists.
function memoryFs() {
  const files = new Map();
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync: (p, text) => files.set(p, text),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  };
}

test('a graph saved after Save As lands beside the new project, not the old one', () => {
  // The symptom: saving the .aep somewhere else left the .ntl next to the OLD
  // project. The graph is already in memory, so nothing has to be copied - the
  // storage is re-pointed and written again at the new path.
  const fs = memoryFs();
  const store = createGraphStore(fs);
  const graph = createGraph('Shot');
  addNode(graph, { id: 'n1', name: 'Solid n1', props: { opacity: 100 } });

  const was = graphFilePathFor('C:/old/shot.aep', 4);
  store.save(was, serializeGraph(graph, { projectPath: 'C:/old/shot.aep', compId: 4 }));
  assert.ok(fs.existsSync(was));

  assert.equal(classifyProjectPath('C:/old/shot.aep',
    { active: true, compId: 4, projectPath: 'C:/new/shot.aep' }), 'moved');

  const now = graphFilePathFor('C:/new/shot.aep', 4);
  store.save(now, serializeGraph(graph, { projectPath: 'C:/new/shot.aep', compId: 4 }));

  const reopened = store.load(now);
  assert.equal(reopened.document.identity.projectPath, 'C:/new/shot.aep');
  assert.deepEqual(Object.keys(reopened.document.graph.nodes), ['n1']);
  // The old one is left alone: that .aep may still exist, and it still has its
  // graph. A move is not a deletion.
  assert.ok(fs.existsSync(was));
});

test('a sidecar already at the new path is identified rather than overwritten', () => {
  // Saving over an .aep whose sidecar belongs to a different graph would destroy
  // it. The panel re-points the storage - so Save Graph can replace it
  // deliberately - but writes nothing automatically, and this is the check that
  // tells the two cases apart.
  const fs = memoryFs();
  const store = createGraphStore(fs);
  const mine = createGraph('Mine');
  addNode(mine, { id: 'n1', name: 'Mine n1', props: { opacity: 100 } });
  const theirs = createGraph('Theirs');
  addNode(theirs, { id: 'n9', name: 'Theirs n9', props: { opacity: 50 } });

  const path = graphFilePathFor('C:/new/shot.aep', 4);
  const identity = { projectPath: 'C:/new/shot.aep', compId: 4 };
  store.save(path, serializeGraph(theirs, identity));
  const occupant = store.load(path);

  const myGraphId = JSON.parse(serializeGraph(mine, identity)).graphId;
  assert.notEqual(occupant.document.graphId, myGraphId, 'a different graph is in the way');
  assert.equal(occupant.document.graph.nodes.n9.name, 'Theirs n9', 'and it is still intact');
});
