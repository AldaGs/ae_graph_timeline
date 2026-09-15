import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGraph, addNode } from '../src/graph.js';
import { createGraphCommands } from '../panel/src/graphCommands.js';
import { createWriteLoop } from '../src/loop.js';
import { makeAE } from './fake-ae.js';

function setup() {
  const graph = createGraph();
  const touches = [];
  let redraws = 0;
  let selected = 'selected';
  let gestureDepth = 0;
  const loop = {
    touch(label) { touches.push(label); },
    beginGesture() { gestureDepth++; return gestureDepth; },
    endGesture() { gestureDepth--; return Promise.resolve({ status: 'idle' }); },
    get state() { return { gestureDepth }; },
  };
  const commands = createGraphCommands({
    graph, getLoop: () => loop, redraw: () => redraws++, setSelected: (v) => { selected = v; },
  });
  return { graph, touches, commands, get redraws() { return redraws; }, get selected() { return selected; } };
}

test('visible graph commands redraw and touch the loop once', () => {
  const s = setup();
  const layer = s.commands.addLayer('solid', { x: 10, y: 20 });
  s.commands.rename(layer.id, 'Hero');
  s.commands.setBlendMode(layer.id, 'multiply');
  s.commands.setEnabled(layer.id, false);
  s.commands.setLabel(layer.id, 4);
  s.commands.addInlineEffect(layer.id, { matchName: 'ADBE Fill', name: 'Fill' });

  assert.equal(s.redraws, 6);
  assert.equal(s.touches.length, 6);
  assert.equal(s.graph.nodes[layer.id].name, 'Hero');
  assert.equal(s.graph.nodes[layer.id].enabled, false);
});

test('expression edits touch without rebuilding the controlled node', () => {
  const s = setup();
  const node = s.commands.addExpressionNode({ x: 0, y: 0 });
  const before = s.redraws;
  s.commands.setExpression(node.id, 'time * 2;');
  assert.equal(s.redraws, before);
  assert.equal(s.touches.at(-1), `Edit ${node.name} expression`);
});

test('moving nodes is canvas-only and never touches AE', () => {
  const s = setup();
  const node = s.commands.addLayer('null');
  const touchesBefore = s.touches.length;
  s.commands.moveNodes([{ id: node.id, position: { x: 55, y: 89 } }]);
  assert.equal(s.graph.nodes[node.id].ui.x, 55);
  assert.equal(s.touches.length, touchesBefore);
});

test('connect, disconnect, reorder, and delete share the command boundary', () => {
  const s = setup();
  const a = s.commands.addLayer('solid');
  const b = s.commands.addLayer('solid');
  const edge = s.commands.connect({
    source: a.id, target: b.id, sourceHandle: 'property:out:position', targetHandle: 'property:in:position',
  });
  s.commands.disconnect(edge.edge);
  s.commands.reorder([b.id, a.id]);
  s.commands.remove(a.id);

  assert.equal(s.graph.nodes[a.id], undefined);
  assert.equal(s.selected, null);
  assert.match(s.touches.at(-1), /^Delete /);
});

test('gesture commands are paired and an extra close is harmless', async () => {
  const s = setup();
  assert.equal(s.commands.beginGesture('Edit expression'), 1);
  await s.commands.endGesture();
  assert.deepEqual(await s.commands.endGesture(), { status: 'idle' });
});

test('inspector property edits commit valid values once', () => {
  const s = setup();
  const node = s.commands.addLayer('solid');
  const before = s.touches.length;
  s.commands.setProperty(node.id, 'position', [120, 240]);
  s.commands.setProperty(node.id, 'opacity', 50);
  assert.deepEqual(node.props.position, [120, 240]);
  assert.equal(node.props.opacity, 50);
  assert.equal(s.touches.length, before + 2);
});

test('inspector rejects invalid values without mutating or scheduling AE writes', () => {
  const s = setup();
  const node = s.commands.addLayer('solid');
  const before = s.touches.length;
  const props = structuredClone(node.props);
  for (const [prop, value] of [
    ['position', [1]], ['position', [1, 2, 3]], ['position', 2],
    ['position', [NaN, 2]], ['opacity', Infinity], ['opacity', '50'],
    ['opacity', [50]], ['opacity', -1], ['opacity', 101], ['missing', 1],
  ]) assert.throws(() => s.commands.setProperty(node.id, prop, value));
  assert.deepEqual(node.props, props);
  assert.equal(s.touches.length, before);
});

test('inspector refuses edits to linked properties', () => {
  const s = setup();
  const a = s.commands.addLayer('solid');
  const b = s.commands.addLayer('solid');
  s.commands.connect({ source: a.id, target: b.id,
    sourceHandle: 'property:out:position', targetHandle: 'property:in:position' });
  const before = s.touches.length;
  assert.throws(() => s.commands.setProperty(b.id, 'position', [1, 2]), /Disconnect/);
  assert.equal(s.touches.length, before);
});

test('invalid reorder and field values are atomic model refusals', () => {
  const s = setup();
  const node = s.commands.addLayer('solid');
  const before = JSON.stringify(s.graph);
  const touches = s.touches.length;
  assert.throws(() => s.commands.reorder([node.id, 'missing']));
  assert.throws(() => s.commands.reorder([node.id, node.id]));
  assert.throws(() => s.commands.setLabel(node.id, 17));
  assert.throws(() => s.commands.setBlendMode(node.id, 'unknown'));
  assert.throws(() => s.commands.setEnabled(node.id, 'yes'));
  assert.equal(JSON.stringify(s.graph), before);
  assert.equal(s.touches.length, touches);
});

test('a gesture opening against a closed loop does not take the drag with it', () => {
  // Closing the loop is an ordinary event - the comp changed, or AE is quitting -
  // and a scrub in progress must survive it. The graph is still the graph.
  const graph = createGraph();
  addNode(graph, { id: 'a', name: 'A', props: { opacity: 100 } });
  const ae = makeAE();
  const loop = createWriteLoop({ host: ae.host, graph });
  void loop.close();

  const commands = createGraphCommands({ graph, getLoop: () => loop, redraw() {} });
  assert.equal(commands.beginGesture('Set A opacity'), 0, 'refused, not thrown');
  commands.setProperty('a', 'opacity', 40);
  assert.equal(graph.nodes.a.props.opacity, 40, 'the edit still landed in the graph');
  return commands.endGesture().then((r) => assert.equal(r.status, 'idle'));
});
