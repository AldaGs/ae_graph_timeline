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

// Fixed display palette, not a read of the user's customizable AE preferences.
export const LABEL_COLORS = [
  null, '#b53838', '#e4d84c', '#a9cbc7', '#e5bcca', '#a9a9ca',
  '#e7c19e', '#b3c7b3', '#677dbd', '#4a9e4a', '#742774',
  '#e8922f', '#7a5233', '#eb59a1', '#59a1eb', '#a1eb59', '#5e5e5e',
];

// Default label index per layer kind. Keeps the canvas colourful out of the box
// without the user having to label every node by hand.
export const KIND_DEFAULT_LABEL = {
  solid:     1,  // Red
  null:     16,  // Gray
  text:      2,  // Yellow
  shape:     9,  // Green
  footage:  11,  // Orange
  precomp:   8,  // Blue
  camera:    7,  // Sea Foam
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

// ------------------------------------------------------------ transform props
//
// The reader reads exactly these five, in this order (jsx/common.jsx's
// NTLR_TRANSFORM), so these five are what a layer node holds. A node built by
// `addLayer` and a node rebuilt by `hydrateFromComp` MUST end up with the same
// set, or the same layer is a different node depending on how the panel came to
// know about it: the inspector renders one editor per entry in `props`, and
// setNodeProperty refuses a property the node does not already carry.
export const TRANSFORM_PROPS = ['anchorPoint', 'position', 'scale', 'rotation', 'opacity'];

// Which of them a layer kind actually has. A camera has no scale and no opacity;
// a light has neither, and no Z rotation either. Asking for one that is not
// there is how a node acquires a property the diff can then never satisfy.
const KIND_TRANSFORM = {
  camera: ['anchorPoint', 'position', 'rotation'],
  light: ['anchorPoint', 'position'],
};

export const transformPropsFor = (kind) => KIND_TRANSFORM[kind] || TRANSFORM_PROPS;

/**
 * The props a newly authored layer node starts with.
 *
 * `anchorPoint` is deliberately ABSENT. Its default is a property of the layer's
 * source, not of the comp - [50,50] for a null, [0,0] for text, the centre for a
 * full-frame solid - so a value guessed here would be written into After Effects
 * and visibly move the layer. It is adopted from the layer After Effects actually
 * made, one round trip later (see observeAfterPatch in src/loop.js), which is
 * what finally makes a created node and a hydrated node the same shape.
 */
export function defaultLayerProps(kind, { width = 1920, height = 1080 } = {}) {
  const available = transformPropsFor(kind);
  const centre = [Math.round(width / 2), Math.round(height / 2)];
  const all = { position: centre, scale: [100, 100], rotation: 0, opacity: 100 };
  const out = {};
  for (const prop of available) {
    if (prop === 'anchorPoint') continue;
    if (all[prop] !== undefined) out[prop] = all[prop];
  }
  return out;
}

// ---------------------------------------------------------------- the graph

export function createGraph(compName = null) {
  // Effect nodes are materialized as controller nulls in AE. A graph keeps
  // those implementation layers out of the timeline by enabling AE's global
  // Hide Shy Layers switch when the graph starts.
  return { compName, hideShyLayers: false, nodes: {}, edges: {} };
}

export function addNode(graph, node) {
  if (!node.id) throw new Error('node needs an id');
  graph.nodes[node.id] = {
    id: node.id,
    kind: node.kind || 'solid',
    name: node.name || node.id,
    parent: node.parent ?? null,
    nativeId: node.nativeId ?? null,
    order: node.order ?? Object.keys(graph.nodes).length + 1,
    blendMode: node.blendMode ?? 'normal',
    label: node.label ?? KIND_DEFAULT_LABEL[node.kind || 'solid'] ?? 0,
    enabled: node.enabled ?? true,
    props: { ...(node.props || {}) },
    // A text layer's string. Empty rather than null for every kind, so a node
    // that becomes text later has somewhere to put one; only text layers ever
    // have it written, because only they have a Source Text property.
    text: typeof node.text === 'string' ? node.text : '',
    // For M3 effect nodes
    matchName: node.matchName || null,
    // For M3 expression nodes
    expression: node.expression || '',
    effects: (node.effects || []).map((e) => ({
      matchName: e.matchName,
      name: e.name || e.matchName,
      params: { ...(e.params || {}) },
    })),
    // Source-backed layers keep AE's project item id as a fast live handle and
    // the file path as a recovery hint. AE remains responsible for footage
    // interpretation and relinking.
    source: node.source ? {
      kind: node.source.kind || 'footage',
      itemId: Number.isFinite(node.source.itemId) ? node.source.itemId : null,
      path: typeof node.source.path === 'string' ? node.source.path : null,
      importAs: node.source.importAs || 'footage',
      missing: node.source.missing === true,
    } : null,
    // Where the node sits on the canvas. It lives in the MODEL, not in the
    // panel, because M6 has to persist it: a graph that reopened with every node
    // stacked at the origin would have lost the thing the user spent the most
    // time arranging. Nothing in After Effects has an opinion about it, so the
    // diff never reads it and moving a node can never emit a patch.
    ui: { x: node.ui?.x ?? 0, y: node.ui?.y ?? 0 },
  };
  return graph.nodes[node.id];
}

// M4: bind a native After Effects layer.id to a graph node. Called after a
// createLayer receipt returns, and during comp hydration.
export function bindNativeId(graph, nodeId, nativeId) {
  const node = graph.nodes[nodeId];
  if (!node) return null;
  node.nativeId = nativeId;
  return node;
}

export function bindSourceItemId(graph, nodeId, itemId) {
  const node = graph.nodes[nodeId];
  if (!node?.source) return null;
  node.source.itemId = itemId;
  return node;
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
  if (!(param in effect.params)) throw new Error(`setEffectParam: "${param}" is not a parameter of ${effect.matchName}`);
  // The same rule setNodeProperty enforces, and for the same reason: a value the
  // reader cannot read back is a value the diff will try to correct forever.
  // Checked here rather than at the panel, because the model is what the writer
  // is handed and the panel is not the only thing that can reach it.
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || !values.every(Number.isFinite)) throw new Error('Enter finite numeric values');
  if (Array.isArray(effect.params[param]) !== Array.isArray(value)
      || (Array.isArray(value) && value.length !== effect.params[param].length)) {
    throw new Error('Vector dimensions must match');
  }
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

// M4 Phase D: Rebuild or bind graph nodes from a read compState.
export function hydrateFromComp(graph, compState) {
  if (compState.compId) graph.compName = compState.compName;
  for (const layer of compState.layers) {
    const nodeId = nodeIdFromTag(layer.comment);
    if (!nodeId) continue;
    
    if (graph.nodes[nodeId]) {
      // Node exists, just bind the native id
      bindNativeId(graph, nodeId, layer.nativeId);
    } else {
      // Node missing (e.g. panel reload), recreate it as a layer node
      addNode(graph, {
        id: nodeId,
        nativeId: layer.nativeId,
        kind: layer.kind,
        name: layer.name,
        blendMode: layer.blendMode,
        label: layer.label,
        enabled: layer.enabled,
        text: layer.text,
        source: layer.source,
        props: { ...layer.props },
        // We do not recover effects here since they belong to effect nodes,
        // which are a bigger challenge for M6 persistence.
      });
    }
  }
  return graph;
}

/** Replace a recovered graph while preserving the object held by the panel. */
export function replaceGraph(graph, saved) {
  graph.compName = saved.compName;
  graph.hideShyLayers = saved.hideShyLayers === true;
  graph.nodes = JSON.parse(JSON.stringify(saved.nodes));
  graph.edges = JSON.parse(JSON.stringify(saved.edges));
}

export function setNodeProperty(graph, nodeId, prop, value) {
  const node = graph.nodes[nodeId];
  if (!node || !(prop in node.props)) throw new Error('Unknown property');
  if (desiredExpressions(graph)[`${nodeId}|${prop}`]) throw new Error('Disconnect the expression before editing this value');
  const values = Array.isArray(value) ? value : [value];
  if (!Array.isArray(node.props[prop]) && Array.isArray(value)) throw new Error('Enter a single number');
  if (!values.length || !values.every(Number.isFinite)) throw new Error('Enter finite numeric values');
  if (Array.isArray(node.props[prop]) && (!Array.isArray(value) || value.length !== node.props[prop].length)) throw new Error('Vector dimensions must match');
  if (prop === 'opacity' && (value < 0 || value > 100)) throw new Error('Opacity must be between 0 and 100');
  node.props[prop] = value;
  return node;
}

export function setNodeField(graph, nodeId, field, value) {
  const node = graph.nodes[nodeId];
  if (!node) return null;
  if (!['blendMode', 'enabled', 'label', 'text'].includes(field)) throw new Error('Unsupported node field');
  if (field === 'blendMode' && !BLEND_MODES.includes(value)) throw new Error('Unknown blend mode');
  if (field === 'enabled' && typeof value !== 'boolean') throw new Error('Visibility must be boolean');
  if (field === 'label' && (!Number.isInteger(value) || value < 0 || value >= LABEL_COLORS.length)) throw new Error('Invalid label');
  // Only a text layer has a Source Text property to write to. Refused here
  // rather than at the panel, because the model is what the writer is handed.
  if (field === 'text') {
    if (typeof value !== 'string') throw new Error('Text must be a string');
    if (node.kind !== 'text') throw new Error('Only a text layer has editable text');
  }
  if (node[field] === value) return null;
  node[field] = value;
  return node;
}

export function reorderNodes(graph, nodeIds) {
  if (new Set(nodeIds).size !== nodeIds.length || nodeIds.some((id) => !graph.nodes[id])) throw new Error('Invalid layer order');
  let changed = false;
  nodeIds.forEach((id, index) => {
    if (graph.nodes[id].order !== index + 1) {
      graph.nodes[id].order = index + 1;
      changed = true;
    }
  });
  return changed;
}
