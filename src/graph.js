// The graph model, and the conventions that let a node find its layer again.
//
// Everything here is pure data. Nothing in this file knows After Effects exists,
// which is what makes the reconciler testable without it.

// ---------------------------------------------------------------- identity
//
// S3: layer.comment is the durable anchor (survives reorder, rename, duplicate,
// precompose and save/reload); the native layer.id is a cached handle that is
// unique and free but does NOT survive precompose. We carry both.

const TAG_PREFIX = 'ntl:';

export const tagFor = (nodeId) => `${TAG_PREFIX}${nodeId}`;

export const nodeIdFromTag = (comment) => {
  if (typeof comment !== 'string') return null;
  const t = comment.trim();
  return t.startsWith(TAG_PREFIX) ? t.slice(TAG_PREFIX.length) || null : null;
};

// A layer we did not tag belongs to the user. The reconciler must never write
// to one, and must never delete one.
export const isManaged = (layer) => nodeIdFromTag(layer.comment) !== null;

// ---------------------------------------------------------------- expressions
//
// An expression edge is self-maintaining: once written, After Effects evaluates
// the relationship itself, so it cannot drift and costs nothing to keep. The
// tag comment is what makes ownership detectable - the graph edits expressions
// it authored and refuses to touch one the user wrote by hand.

const EXPR_TAG = '// ntl:edge:';

export const expressionFor = (edgeId, body) => `${EXPR_TAG}${edgeId}\n${body}`;

export const edgeIdFromExpression = (text) => {
  if (typeof text !== 'string') return null;
  const first = text.split('\n', 1)[0].trim();
  return first.startsWith(EXPR_TAG) ? first.slice(EXPR_TAG.length) || null : null;
};

export const ownsExpression = (text) =>
  typeof text === 'string' && text.length > 0 && edgeIdFromExpression(text) !== null;

// Expressions address layers by NAME, not by the native id - so the graph must
// own the names of the layers it generates, and repair references when it
// renames one.
export const expressionBody = (sourceLayerName, sourceProp) =>
  `thisComp.layer(${JSON.stringify(sourceLayerName)})${sourceProp}`;

// ---------------------------------------------------------------- the graph

export function createGraph() {
  return { nodes: {}, edges: {} };
}

export function addNode(graph, node) {
  if (!node.id) throw new Error('node needs an id');
  graph.nodes[node.id] = {
    id: node.id,
    kind: node.kind || 'solid',
    name: node.name || node.id,
    parent: node.parent ?? null,
    order: node.order ?? Object.keys(graph.nodes).length + 1,
    props: { ...(node.props || {}) },
    effects: (node.effects || []).map((e) => ({ ...e, params: { ...(e.params || {}) } })),
    // Where the node sits on the canvas. It lives in the MODEL, not in the
    // panel, because M6 has to persist it: a graph that reopened with every node
    // stacked at the origin would have lost the thing the user spent the most
    // time arranging. Nothing in After Effects has an opinion about it, so the
    // diff never reads it and moving a node can never emit a patch.
    ui: { x: node.ui?.x ?? 0, y: node.ui?.y ?? 0 },
  };
  return graph.nodes[node.id];
}

// Moving a node is a change to the drawing, never to the comp. Kept as its own
// function so the panel cannot reach into `ui` by accident on a path that also
// touches props - and so the one caller that must NOT mark the loop dirty is
// visible in one place.
export function moveNode(graph, nodeId, x, y) {
  const node = graph.nodes[nodeId];
  if (!node) return null;
  node.ui = { x, y };
  return node;
}

// An edge writes an expression onto `to.prop` that reads `from.prop`.
export function addEdge(graph, edge) {
  if (!edge.id) throw new Error('edge needs an id');
  if (!graph.nodes[edge.from]) throw new Error(`edge ${edge.id}: unknown source ${edge.from}`);
  if (!graph.nodes[edge.to]) throw new Error(`edge ${edge.id}: unknown target ${edge.to}`);
  graph.edges[edge.id] = {
    id: edge.id,
    from: edge.from,
    fromProp: edge.fromProp || '.transform.position',
    to: edge.to,
    toProp: edge.toProp || 'position',
    kind: edge.kind || 'expression',
  };
  return graph.edges[edge.id];
}

// Which expression text each target property should hold, given the graph.
// Keyed "<nodeId>|<prop>" because one property can carry only one expression.
export function desiredExpressions(graph) {
  const out = {};
  for (const edge of Object.values(graph.edges)) {
    if (edge.kind !== 'expression') continue;
    const source = graph.nodes[edge.from];
    if (!source) continue;
    const key = `${edge.to}|${edge.toProp}`;
    if (out[key]) {
      // A property can hold exactly one expression, so two edges landing on the
      // same input is a graph error, not something to silently resolve.
      out[key].conflict = true;
      continue;
    }
    out[key] = {
      edgeId: edge.id,
      node: edge.to,
      prop: edge.toProp,
      text: expressionFor(edge.id, expressionBody(source.name, edge.fromProp)),
      conflict: false,
    };
  }
  return out;
}
