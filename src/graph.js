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

// ---------------------------------------------------------------- label colors
//
// AE's 16 system label colours, as CSS-friendly hex. Index 0 is "None".
// Used on the canvas to distinguish layer types visually, keeping the same
// language AE users already know.

export const LABEL_COLORS = [
  null,       // 0: None
  '#a4a4a4', // 1: Gray
  '#9a9800', // 2: Yellow
  '#c8a89d', // 3: Tan
  '#c8e47e', // 4: Lime
  '#7bcebc', // 5: Sea Foam
  '#a9c4e4', // 6: Lavender
  '#e8c3d3', // 7: Peach
  '#d9c7a5', // 8: Sand
  '#b5b5b5', // 9: Silver
  '#f44336', // 10: Red
  '#e69138', // 11: Orange
  '#f1c232', // 12: Gold
  '#6aa84f', // 13: Green
  '#4285f4', // 14: Blue
  '#674ea7', // 15: Purple
];

// Default label index per layer kind. Keeps the canvas colourful out of the box
// without the user having to label every node by hand.
export const KIND_DEFAULT_LABEL = {
  solid:    10,  // Red
  null:      1,  // Gray
  text:     12,  // Gold
  shape:     4,  // Lime
  footage:  11,  // Orange
  precomp:  14,  // Blue
  camera:    5,  // Sea Foam
  light:     2,  // Yellow
};

// ---------------------------------------------------------------- blend modes
//
// AE blend modes by scripting constant name. The graph stores the string, and
// patch.jsx maps it to BlendingMode[value].

export const BLEND_MODES = [
  'normal', 'dissolve',
  'darken', 'multiply', 'colorBurn', 'linearBurn', 'darkerColor',
  'lighten', 'screen', 'colorDodge', 'linearDodge', 'lighterColor',
  'overlay', 'softLight', 'hardLight', 'vividLight', 'linearLight', 'pinLight', 'hardMix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
];

// Scripting constant names AE expects in BlendingMode.
export const BLEND_MODE_AE = {
  normal: 'NORMAL',
  dissolve: 'DISSOLVE',
  darken: 'DARKEN',
  multiply: 'MULTIPLY',
  colorBurn: 'COLOR_BURN',
  linearBurn: 'LINEAR_BURN',
  darkerColor: 'DARKER_COLOR',
  lighten: 'LIGHTEN',
  screen: 'SCREEN',
  colorDodge: 'COLOR_DODGE',
  linearDodge: 'LINEAR_DODGE',
  lighterColor: 'LIGHTER_COLOR',
  overlay: 'OVERLAY',
  softLight: 'SOFT_LIGHT',
  hardLight: 'HARD_LIGHT',
  vividLight: 'VIVID_LIGHT',
  linearLight: 'LINEAR_LIGHT',
  pinLight: 'PIN_LIGHT',
  hardMix: 'HARD_MIX',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  subtract: 'SUBTRACT',
  divide: 'DIVIDE',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

// ---------------------------------------------------------------- the graph

export function createGraph(compName = null) {
  return { compName, nodes: {}, edges: {} };
}

export function addNode(graph, node) {
  if (!node.id) throw new Error('node needs an id');
  graph.nodes[node.id] = {
    id: node.id,
    kind: node.kind || 'solid',
    name: node.name || node.id,
    parent: node.parent ?? null,
    order: node.order ?? Object.keys(graph.nodes).length + 1,
    blendMode: node.blendMode || 'normal',
    label: node.label ?? KIND_DEFAULT_LABEL[node.kind || 'solid'] ?? 0,
    props: { ...(node.props || {}) },
    // For M3 effect nodes
    matchName: node.matchName || null,
    // For M3 expression nodes
    expression: node.expression || '',
    effects: (node.effects || []).map((e) => ({
      matchName: e.matchName,
      name: e.name || e.matchName,
      params: { ...(e.params || {}) },
    })),
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

export function setNodeExpression(graph, nodeId, expression) {
  const node = graph.nodes[nodeId];
  if (!node) return null;
  node.expression = expression;
  return node;
}

// ---------------------------------------------------------------- effects
//
// Effects are an ordered stack on each node, matching AE's Effect Parade. Order
// matters: Blur before Fill != Fill before Blur. Each effect is identified by
// matchName (AE's stable internal name) and carries a bag of parameter values.

export function addEffect(graph, nodeId, effect) {
  const node = graph.nodes[nodeId];
  if (!node) throw new Error(`addEffect: unknown node "${nodeId}"`);
  if (!effect.matchName) throw new Error('effect needs a matchName');
  const entry = {
    matchName: effect.matchName,
    name: effect.name || effect.matchName,
    params: { ...(effect.params || {}) },
  };
  node.effects.push(entry);
  return entry;
}

export function removeEffect(graph, nodeId, effectIndex) {
  const node = graph.nodes[nodeId];
  if (!node) throw new Error(`removeEffect: unknown node "${nodeId}"`);
  if (effectIndex < 0 || effectIndex >= node.effects.length) {
    throw new Error(`removeEffect: index ${effectIndex} out of range`);
  }
  return node.effects.splice(effectIndex, 1)[0];
}

export function moveEffect(graph, nodeId, fromIndex, toIndex) {
  const node = graph.nodes[nodeId];
  if (!node) throw new Error(`moveEffect: unknown node "${nodeId}"`);
  if (fromIndex < 0 || fromIndex >= node.effects.length) return null;
  if (toIndex < 0 || toIndex >= node.effects.length) return null;
  const [effect] = node.effects.splice(fromIndex, 1);
  node.effects.splice(toIndex, 0, effect);
  return effect;
}

export function setEffectParam(graph, nodeId, effectIndex, param, value) {
  const node = graph.nodes[nodeId];
  if (!node) throw new Error(`setEffectParam: unknown node "${nodeId}"`);
  const effect = node.effects[effectIndex];
  if (!effect) throw new Error(`setEffectParam: no effect at index ${effectIndex}`);
  effect.params[param] = value;
  return effect;
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
      text: expressionFor(
        edge.id,
        source.kind === 'expression' ? source.expression : expressionBody(source.name, edge.fromProp)
      ),
      conflict: false,
    };
  }
  return out;
}
