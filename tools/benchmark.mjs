import { performance } from 'node:perf_hooks';
import { createGraph, addNode, tagFor } from '../src/graph.js';
import { diff } from '../src/diff.js';
import { toFlowNodes } from '../src/view.js';
import { parseCompState, readCompCall } from '../src/reader.js';
import { applyPatchCall, parseReceipt } from '../src/patch.js';
import { createNodeCache } from '../panel/src/canvas/nodeCache.js';
import { makeAE } from '../test/fake-ae.js';

function measure(fn, count = 30) {
  for (let i = 0; i < 5; i++) fn();
  const samples = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now(); fn(); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { median: +samples[Math.floor(count / 2)].toFixed(3), p95: +samples[Math.floor(count * .95)].toFixed(3) };
}

console.log('Node', process.version, process.platform, process.arch);
console.log('Milliseconds: offline VM host is NOT AE; view preparation is NOT DOM render or pointer latency.');
for (const size of [50, 200, 1000]) {
  const graph = createGraph('benchmark');
  const ae = makeAE();
  for (let i = 0; i < size; i++) {
    const id = `n${i}`;
    addNode(graph, { id, name: id, kind: 'solid', props: { opacity: 100 }, order: i + 1 });
    ae.comp.add(id, { comment: tagFor(id), props: { opacity: 100 } });
  }
  const read = readCompCall();
  const state = parseCompState(ae.eval(read));
  // Match host stack order so this is genuinely a clean diff.
  state.layers.forEach((layer, i) => { graph.nodes[layer.comment.slice(4)].order = i + 1; });
  if (diff(graph, state).ops.length) throw new Error('Benchmark fixture is not clean');
  const cache = createNodeCache();
  const connected = JSON.parse(JSON.stringify(graph));
  for (let i = 1; i < size; i++) {
    connected.edges[`e${i}`] = { id: `e${i}`, kind: 'expression', from: `n${i - 1}`, to: `n${i}`, fromProp: '.transform.opacity', toProp: 'opacity' };
  }
  const connectedCache = createNodeCache();
  const changed = Array.from({ length: size }, (_, i) => ({ op: 'setProp', node: `n${i}`, prop: 'opacity', to: 50 }));
  const call = applyPatchCall(changed);
  const results = {
    size,
    readVM: measure(() => parseCompState(ae.eval(read))),
    diff: measure(() => diff(graph, state)),
    view: measure(() => cache(toFlowNodes(graph))),
    connectedView: measure(() => connectedCache(toFlowNodes(connected))),
    patchVM: measure(() => { const receipt = parseReceipt(ae.eval(call)); if (!receipt.ok) throw new Error('Patch failed'); }),
  };
  console.log(JSON.stringify(results));
}
