import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, addNode, addEdge } from '../src/graph.js';
import { serializeGraph, parseGraph, createGraphStore, inspectSavedGraph } from '../src/persistence.js';

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
