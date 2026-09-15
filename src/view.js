// M1 — the canvas's view of the graph.
//
// React Flow wants `{ nodes: [...], edges: [...] }` with its own shapes; the
// reconciler wants `src/graph.js`. This file is the only place that knows both,
// and it is PURE - no React, no reactflow import, no DOM. That is what lets the
// translation be tested without a browser, and it keeps the canvas from becoming
// a second source of truth.
//
// The direction of authority is fixed: the graph is rendered INTO the canvas,
// and a canvas gesture is turned back into a mutation of the graph. React Flow
// never holds state the graph does not have. The one exception is selection,
// which is about what the user is looking at rather than what the comp contains.

import { addEdge, moveNode, LABEL_COLORS, KIND_DEFAULT_LABEL } from './graph.js';

// What a node looks like on the canvas. A node is a layer, so it shows the two
// things that decide what that layer IS - its name and its kind - and the
// handful of transform values the graph currently owns. M2 adds effects (as
// collapsible sections with their own parameter ports), blend mode, and AE
// label colour.
export function toFlowNodes(graph) {
  const drivenByNode = new Map();
  for (const edge of Object.values(graph.edges)) {
    if (edge.kind === 'flow') continue;
    if (!drivenByNode.has(edge.to)) drivenByNode.set(edge.to, {});
    drivenByNode.get(edge.to)[edge.toProp] = edge.id;
  }
  return Object.values(graph.nodes).map((node) => ({
    id: node.id,
    type: node.kind === 'effect' ? 'ntlEffect' : (node.kind === 'expression' ? 'ntlExpression' : 'ntlLayer'),
    position: { x: node.ui?.x ?? 0, y: node.ui?.y ?? 0 },
    data: {
      name: node.name,
      kind: node.kind,
      parent: node.parent ?? null,
      blendMode: node.blendMode || 'normal',
      label: node.label ?? KIND_DEFAULT_LABEL[node.kind] ?? 0,
      labelColor: LABEL_COLORS[node.label ?? KIND_DEFAULT_LABEL[node.kind] ?? 0] || null,
      // The inputs a node offers are exactly the properties the graph owns on
      // it, so a port list cannot drift from what the reconciler would write.
      // A text layer's string. On the card because it is the one thing that
      // identifies a title at a glance, and the name rarely is - AE calls them
      // all "Text" until somebody renames them.
      text: node.kind === 'text' ? (node.text ?? '') : undefined,
      ports: Object.keys(node.props).sort(),
      props: node.props,
      matchName: node.matchName || null,
      expression: node.expression || '',
      // An input driven by an edge is not the user's to type into: the
      // expression IS the value there (P1.2's rule, surfaced in the UI).
      driven: drivenByNode.get(node.id) || {},
      // Both inline effect stacks and standalone effect nodes are supported.
      effects: (node.effects || []).map((fx, i) => ({
        index: i,
        matchName: fx.matchName,
        name: fx.name || fx.matchName,
        params: fx.params || {},
        ports: Object.keys(fx.params || {}).sort(),
      })),
    },
  }));
}

// Which of a node's properties are the target of an expression edge.
export function drivenProps(graph, nodeId) {
  const out = {};
  for (const edge of Object.values(graph.edges)) {
    if (edge.kind === 'flow') continue;
    if (edge.to !== nodeId) continue;
    out[edge.toProp] = edge.id;
  }
  return out;
}

// An edge's SOURCE is stored the way After Effects addresses it, because that is
// what goes into the expression body: ".transform.position". A port is named
// after the property alone. The two are not the same string, and conflating them
// produces an edge pointing at a handle that does not exist - which React Flow
// discards in silence, so the wire lands in the model and never appears on the
// canvas. That is exactly what the first run of the panel did.
export const TRANSFORM_PATH = '.transform.';

export const portFromPath = (path) =>
  (typeof path === 'string' && path.startsWith(TRANSFORM_PATH)
    ? path.slice(TRANSFORM_PATH.length)
    : path);

export const pathFromPort = (port) => `${TRANSFORM_PATH}${port}`;

export function toFlowEdges(graph) {
  return Object.values(graph.edges).map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    // Ports are named after the property, so an edge lands on the input it
    // actually drives rather than on the node as a whole.
    sourceHandle: edge.kind === 'flow'
      ? 'flow:out'
      : (graph.nodes[edge.from]?.kind === 'expression'
        ? 'expression:out'
        : `property:out:${portFromPath(edge.fromProp)}`),
    targetHandle: edge.kind === 'flow' ? 'flow:in' : `property:in:${edge.toProp}`,
    type: 'ntlEdge',
    ariaLabel: edge.kind === 'flow'
      ? `Effect flow from ${edge.from} to ${edge.to}`
      : `Expression from ${edge.from} to ${edge.to}.${edge.toProp}`,
    data: { fromProp: edge.fromProp, toProp: edge.toProp, kind: edge.kind },
  }));
}

export const toFlow = (graph) => ({ nodes: toFlowNodes(graph), edges: toFlowEdges(graph) });

// ---------------------------------------------------------------- the parent
//
// Parenting is a relationship between layers, and the canvas draws it as a wire
// like any other - but it is NOT an expression edge. AE has a real parent
// pointer, the diff emits setParent for it, and it carries no expression text.
// Drawn separately so the two can never be confused in either direction.

export const PARENT_HANDLE = 'parent';

export function toParentEdges(graph) {
  const out = [];
  for (const node of Object.values(graph.nodes)) {
    if (!node.parent) continue;
    if (!graph.nodes[node.parent]) continue;   // a dangling parent draws nothing
    out.push({
      id: `parent:${node.id}`,
      source: node.parent,
      target: node.id,
      sourceHandle: 'parent:out',
      targetHandle: 'parent:in',
      type: 'ntlParentEdge',
      ariaLabel: `Parent relationship from ${node.parent} to ${node.id}`,
      data: { parent: true },
    });
  }
  return out;
}

// ------------------------------------------------------- canvas -> the graph

export class ViewError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ViewError';
    this.detail = detail ?? null;
  }
}

export const propFromHandle = (handle) => {
  if (typeof handle !== 'string') return null;
  const cut = handle.indexOf(':');
  return cut === -1 ? null : handle.slice(cut + 1) || null;
};

export function handleMeta(handle) {
  if (typeof handle !== 'string') return null;
  const parts = handle.split(':');
  if (parts.length === 2 && ['flow', 'expression', 'parent'].includes(parts[0])
      && ['in', 'out'].includes(parts[1])) {
    return { type: parts[0], direction: parts[1], prop: null };
  }
  if (parts.length >= 3 && parts[0] === 'property'
      && ['in', 'out'].includes(parts[1]) && parts.slice(2).join(':')) {
    return { type: 'property', direction: parts[1], prop: parts.slice(2).join(':') };
  }
  return null;
}

function validateEnds(graph, connection) {
  const { source, target } = connection;
  if (!graph.nodes[source]) throw new ViewError(`unknown source node "${source}"`);
  if (!graph.nodes[target]) throw new ViewError(`unknown target node "${target}"`);
  if (source === target) throw new ViewError('a node cannot be wired to itself');
  const from = handleMeta(connection.sourceHandle);
  const to = handleMeta(connection.targetHandle);
  if (!from || !to || from.direction !== 'out' || to.direction !== 'in') {
    throw new ViewError('a wire must run from an output port to an input port');
  }
  return { from, to };
}

function flowWouldCycle(graph, source, target) {
  const outgoing = new Map();
  for (const edge of Object.values(graph.edges)) {
    if (edge.kind !== 'flow') continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const pending = [target];
  const seen = new Set();
  while (pending.length) {
    const at = pending.pop();
    if (at === source) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    pending.push(...(outgoing.get(at) || []));
  }
  return false;
}

export function connectFlow(graph, connection, { edgeId } = {}) {
  const { from, to } = validateEnds(graph, connection);
  const source = graph.nodes[connection.source];
  const target = graph.nodes[connection.target];
  if (from.type !== 'flow' || to.type !== 'flow') {
    throw new ViewError('effect flow must join two flow ports');
  }
  if (source.kind === 'expression' || target.kind !== 'effect') {
    throw new ViewError('effect flow must end at an effect node');
  }
  if (!target.matchName) throw new ViewError(`effect node "${target.name}" has no match name`);
  if (Object.values(graph.edges).some((edge) => edge.kind === 'flow' && edge.from === source.id)) {
    throw new ViewError(`effect flow from "${source.name}" already has a next node`);
  }
  if (flowWouldCycle(graph, source.id, target.id)) {
    throw new ViewError('that effect connection would make a cycle');
  }
  const id = edgeId || nextEdgeId(graph);
  addEdge(graph, { id, from: source.id, to: target.id, kind: 'flow', fromProp: 'flow', toProp: 'flow' });
  return { kind: 'flow', edge: id };
}

export function connectExpression(graph, connection, { edgeId } = {}) {
  const { from, to } = validateEnds(graph, connection);
  const source = graph.nodes[connection.source];
  const target = graph.nodes[connection.target];
  const validSource = from.type === 'expression' && source.kind === 'expression'
    || from.type === 'property' && source.kind !== 'expression' && source.kind !== 'effect'
      && source.props?.[from.prop] !== undefined;
  if (!validSource || to.type !== 'property' || target.kind === 'expression' || target.kind === 'effect'
      || target.props?.[to.prop] === undefined) {
    throw new ViewError('expression wires currently support layer transform properties only');
  }

  const displaced = Object.values(graph.edges)
    .filter((edge) => edge.kind === 'expression' && edge.to === target.id && edge.toProp === to.prop);
  const id = edgeId || nextEdgeId(graph);
  addEdge(graph, {
    id, from: source.id,
    fromProp: from.type === 'property' ? pathFromPort(from.prop) : 'expression',
    to: target.id, toProp: to.prop, kind: 'expression',
  });
  for (const edge of displaced) if (edge.id !== id) delete graph.edges[edge.id];
  return { kind: 'expression', edge: id, replaced: displaced.map((edge) => edge.id) };
}

export function connectParent(graph, connection) {
  const { from, to } = validateEnds(graph, connection);
  const source = graph.nodes[connection.source];
  const target = graph.nodes[connection.target];
  if (from.type !== 'parent' || to.type !== 'parent') {
    throw new ViewError('a parent wire has to join two parent ports');
  }
  if (source.kind === 'expression' || source.kind === 'effect'
      || target.kind === 'expression' || target.kind === 'effect') {
    throw new ViewError('only layer nodes can be parented');
  }
  if (wouldCycle(graph, target.id, source.id)) {
    throw new ViewError(`parenting ${target.id} to ${source.id} would make a loop`);
  }
  target.parent = source.id;
  return { kind: 'parent', node: target.id, to: source.id };
}

/**
 * A wire the user just drew, turned into a mutation of the graph.
 *
 * Returns what KIND of change it was, so the caller knows whether it has to
 * reach After Effects at all: a position is a drawing change, a parent or an
 * edge is a change to the comp.
 */
export function connect(graph, connection, { edgeId } = {}) {
  const from = handleMeta(connection.sourceHandle);
  const to = handleMeta(connection.targetHandle);
  if (from?.type === 'flow' || to?.type === 'flow') return connectFlow(graph, connection, { edgeId });
  if (from?.type === 'parent' || to?.type === 'parent') return connectParent(graph, connection);
  return connectExpression(graph, connection, { edgeId });
}

// Following parents upward. Cheap: the chain is a chain, and AE refuses a loop
// anyway - the point of checking here is the error message.
export function wouldCycle(graph, child, proposedParent) {
  let at = proposedParent;
  const seen = new Set();
  while (at) {
    if (at === child) return true;
    if (seen.has(at)) return true;      // an existing loop; do not spin on it
    seen.add(at);
    at = graph.nodes[at]?.parent ?? null;
  }
  return false;
}

export function disconnect(graph, flowEdgeId) {
  if (typeof flowEdgeId === 'string' && flowEdgeId.startsWith('parent:')) {
    const nodeId = flowEdgeId.slice('parent:'.length);
    if (!graph.nodes[nodeId]) return null;
    graph.nodes[nodeId].parent = null;
    return { kind: 'parent', node: nodeId, to: null };
  }
  if (!graph.edges[flowEdgeId]) return null;
  delete graph.edges[flowEdgeId];
  return { kind: 'edge', edge: flowEdgeId };
}

/**
 * React Flow's change list, applied to the graph.
 *
 * Only positions and removals are honoured. Everything else React Flow reports -
 * selection, dimensions, drag state - is about the canvas and is left where it
 * belongs. Returns whether anything in there was a change AE has to hear about,
 * so the caller knows whether to mark the write loop dirty.
 */
export function applyNodeChanges(graph, changes) {
  let structural = false;
  let moved = false;
  for (const change of changes || []) {
    if (change.type === 'position' && change.position) {
      moveNode(graph, change.id, change.position.x, change.position.y);
      moved = true;
      continue;
    }
    if (change.type === 'remove') {
      if (removeNode(graph, change.id)) structural = true;
    }
  }
  return { structural, moved };
}

// Deleting a node deletes every edge touching it and clears every parent
// pointing at it. Leaving either behind would make the graph describe a comp
// that cannot exist, and the diff would then emit ops against a node that is
// not there.
export function removeNode(graph, nodeId) {
  if (!graph.nodes[nodeId]) return false;
  delete graph.nodes[nodeId];
  for (const [id, edge] of Object.entries(graph.edges)) {
    if (edge.from === nodeId || edge.to === nodeId) delete graph.edges[id];
  }
  for (const node of Object.values(graph.nodes)) {
    if (node.parent === nodeId) node.parent = null;
  }
  return true;
}

// ------------------------------------------------------------------- naming
//
// Expressions address layers BY NAME (S6), so two nodes sharing one is not a
// cosmetic problem: it is an ambiguous expression target. Names are made unique
// at the point they are created or changed.

export function uniqueName(graph, wanted, exceptNodeId = null) {
  const taken = new Set(
    Object.values(graph.nodes)
      .filter((n) => n.id !== exceptNodeId)
      .map((n) => n.name),
  );
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) {
    const candidate = `${wanted} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function renameNode(graph, nodeId, wanted) {
  const node = graph.nodes[nodeId];
  if (!node) return null;
  const name = uniqueName(graph, String(wanted || '').trim() || node.id, nodeId);
  node.name = name;
  return name;
}

// Ids the user never sees but the comment tags do (S3), so they have to be
// stable and collision-free within a graph.
export function nextNodeId(graph, prefix = 'n') {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!graph.nodes[id]) return id;
  }
}

export function nextEdgeId(graph, prefix = 'e') {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!graph.edges[id]) return id;
  }
}
