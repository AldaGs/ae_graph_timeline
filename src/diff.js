// The reconciler's read half: graph + comp state -> a patch.
//
// Pure. No After Effects, no I/O, no writes. That is not tidiness - it is
// Wall 1b, measured: reading and writing interleaved in one loop cost 2.26x
// what a read pass followed by a single batched write pass costs (294 µs vs
// 130 µs per property). Diff decides; patch acts.

import { nodeIdFromTag, desiredExpressions, ownsExpression, edgeIdFromExpression } from './graph.js';

const EPSILON = 1e-6;

// AE hands back floats and arrays of floats. Compare with tolerance, or every
// diff reports spurious changes forever.
export function valueEquals(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    // AE persists some values at single precision. Allow half a float32 ULP
    // in addition to the absolute floor, while retaining meaningful edits.
    return Math.abs(a - b) <= Math.max(EPSILON, Math.max(Math.abs(a), Math.abs(b)) * (2 ** -24));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valueEquals(a[i], b[i])) return false;
    return true;
  }
  return false;
}

export function propertyEquals(prop, a, b) {
  if (Array.isArray(a) && Array.isArray(b) && Math.min(a.length, b.length) === 2
      && Math.max(a.length, b.length) === 3 && ['position', 'anchorPoint', 'scale'].includes(prop)) {
    const longer = a.length === 3 ? a : b;
    return valueEquals(longer[2], prop === 'scale' ? 100 : 0)
      && valueEquals(a.slice(0, 2), b.slice(0, 2));
  }
  return valueEquals(a, b);
}

// Ops are emitted in a fixed order. It matters:
//   clearExpression first  - references to layers about to be deleted must go
//                            before their targets do
//   createLayer next       - parents and expression sources must exist before
//                            anything points at them
//   setParent / setProp    - now that every layer exists
//   setExpression          - after names are final, since expressions address
//                            layers BY NAME
//   reorder                - cosmetic, cheap, last before deletes
//   deleteLayer last       - nothing still refers to them by then
const OP_ORDER = [
  'clearExpression',
  'createLayer',
  'setName',
  'setComment',
  'setProp',
  'setEnabled',
  'setShy',
  'setHideShyLayers',
  'setLabel',
  'setText',
  'setBlendMode',
  'setEffect',
  'addEffect',
  'linkEffectToHost',
  'setParent',
  'setExpression',
  'reorder',
  'removeEffect',
  'deleteLayer',
];

export function sortPatch(ops) {
  return [...ops].sort((a, b) => OP_ORDER.indexOf(a.op) - OP_ORDER.indexOf(b.op));
}

// Validate and index effect flow once per diff. The previous traversal rebuilt
// this map for every layer and silently chose the first branch, which made both
// malformed graphs and large graphs unnecessarily dangerous.
export function buildEffectFlowIndex(graph) {
  const outgoing = new Map();
  const errors = [];
  const invalid = new Set();
  for (const edge of Object.values(graph.edges)) {
    if (edge.kind !== 'flow') continue;
    const source = graph.nodes[edge.from];
    const target = graph.nodes[edge.to];
    if (!source || !target || target.kind !== 'effect' || !target.matchName) {
      errors.push({ kind: 'invalidFlow', edge: edge.id,
        message: `effect flow ${edge.id} must end at an effect node with a match name` });
      invalid.add(edge.from);
      continue;
    }
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  for (const [nodeId, edges] of outgoing) {
    if (edges.length <= 1) continue;
    errors.push({ kind: 'flowBranch', node: nodeId,
      message: `effect flow from ${nodeId} branches ${edges.length} ways; only linear chains are supported` });
    invalid.add(nodeId);
  }

  const next = new Map();
  for (const [nodeId, edges] of outgoing) {
    if (edges.length === 1 && !invalid.has(nodeId)) next.set(nodeId, edges[0].to);
  }
  const color = new Map();
  for (const root of next.keys()) {
    if (color.has(root)) continue;
    const trail = [];
    const positions = new Map();
    let nodeId = root;
    while (nodeId !== undefined && !color.has(nodeId)) {
      color.set(nodeId, 1);
      positions.set(nodeId, trail.length);
      trail.push(nodeId);
      nodeId = next.get(nodeId);
    }
    if (positions.has(nodeId)) {
      const cycle = trail.slice(positions.get(nodeId)).concat(nodeId);
      for (const id of cycle) invalid.add(id);
      errors.push({ kind: 'flowCycle', node: nodeId,
        message: `effect flow contains a cycle: ${cycle.join(' → ')}` });
    }
    for (const id of trail) color.set(id, 2);
  }

  return {
    errors,
    effectsFor(startNodeId) {
      const effects = [...(graph.nodes[startNodeId]?.effects || [])];
      const seen = new Set([startNodeId]);
      let current = startNodeId;
      while (!invalid.has(current) && next.has(current)) {
        const targetId = next.get(current);
        if (seen.has(targetId) || invalid.has(targetId)) break;
        seen.add(targetId);
        const effect = graph.nodes[targetId];
        effects.push({
          matchName: effect.matchName, name: effect.name,
          params: effect.props || {}, hostId: effect.id, hostName: effect.name,
        });
        current = targetId;
      }
      return effects;
    },
  };
}

/**
 * @param graph      the source of truth
 * @param compState  what After Effects currently holds, from the reader
 * @returns { ops, warnings, stats }
 */
export function diff(graph, compState) {
  const ops = [];
  const warnings = [];
  const effectFlows = buildEffectFlowIndex(graph);
  warnings.push(...effectFlows.errors);

  // This is a composition-level timeline display setting, not a layer. It is
  // nevertheless graph-owned: starting a graph should immediately hide its
  // shy implementation layers, even before the first effect node is added.
  if (graph.hideShyLayers === true && compState.hideShyLayers === false) {
    ops.push({ op: 'setHideShyLayers', to: true });
  }

  // ---- index the comp by tag, and notice duplicates -----------------------
  //
  // S3: a duplicated layer carries the same comment tag but gets its own native
  // id. Same tag + the native id the graph recorded = the original; the other is
  // a copy the user made, and the graph must not silently adopt it.
  const byTag = new Map();
  const untagged = [];
  for (const layer of compState.layers) {
    const nodeId = nodeIdFromTag(layer.comment);
    if (nodeId === null) { untagged.push(layer); continue; }
    if (!byTag.has(nodeId)) byTag.set(nodeId, []);
    byTag.get(nodeId).push(layer);
  }

  const resolved = new Map();
  for (const [nodeId, layers] of byTag) {
    if (layers.length === 1) { resolved.set(nodeId, layers[0]); continue; }
    const known = graph.nodes[nodeId]?.nativeId;
    const original = layers.find((l) => l.nativeId === known) || layers[0];
    resolved.set(nodeId, original);

    // M4: strip tags from copies so they become normal unmanaged AE layers
    for (const copy of layers) {
      if (copy !== original) {
        ops.push({ op: 'setComment', node: nodeId, nativeId: copy.nativeId, comment: '' });
      }
    }

    warnings.push({
      kind: 'duplicate',
      node: nodeId,
      count: layers.length,
      keptNativeId: original.nativeId,
      message: `${layers.length} layers claim tag "${nodeId}" — treating nativeId ${original.nativeId} as the original; the copies are unmanaged until re-tagged`,
    });
  }

  // ---- layers the graph wants that are not there --------------------------
  for (const node of Object.values(graph.nodes)) {
    if (node.kind === 'expression') continue;
    if (resolved.has(node.id)) continue;
    const kind = node.kind === 'effect' ? 'null' : node.kind;
    const props = node.kind === 'effect' ? {} : node.props;
    // The string travels WITH the creation, like the label and the order do. A
    // setText in the next pass would leave the layer empty for one write cycle,
    // which is a frame of the comp showing the wrong thing.
    const text = kind === 'text' && typeof node.text === 'string' ? node.text : undefined;
    ops.push({ op: 'createLayer', node: node.id, kind, name: node.name, props,
      label: node.label, enabled: node.enabled, shy: node.kind === 'effect',
      order: node.order, text, source: node.source || undefined });
  }

  // ---- layers we own that the graph no longer wants -----------------------
  for (const [nodeId, layer] of resolved) {
    const node = graph.nodes[nodeId];
    if (!node || node.kind === 'expression') {
      ops.push({ op: 'deleteLayer', node: nodeId, nativeId: layer.nativeId, name: layer.name });
    }
  }

  // ---- properties, names, parents -----------------------------------------
  const desired = desiredExpressions(graph);

  for (const node of Object.values(graph.nodes)) {
    if (node.kind === 'expression') continue;
    const layer = resolved.get(node.id);
    if (!layer) continue; // just created; its props ride along on createLayer

    if (layer.name !== node.name) {
      ops.push({ op: 'setName', node: node.id, from: layer.name, to: node.name });
    }

    for (const [prop, want] of Object.entries(node.props)) {
      // Parenting compensates local transforms to retain the visible pose.
      // The post-patch observation captures those new local constants.
      if ((node.parent ?? null) !== (layer.parentTag ?? null)
          && ['position', 'anchorPoint', 'scale', 'rotation'].includes(prop)) continue;
      // A property driven by an expression is not ours to write: the expression
      // IS the value. Writing it would be overwritten on the next frame anyway.
      if (desired[`${node.id}|${prop}`]) continue;

      const have = layer.props?.[prop];
      if (have === undefined) {
        warnings.push({ kind: 'missingProp', node: node.id, prop,
          message: `comp state has no "${prop}" for node ${node.id}` });
        continue;
      }
      if (!propertyEquals(prop, have, want)) {
        ops.push({ op: 'setProp', node: node.id, prop, from: have, to: want });
      }
    }

    const wantParent = node.parent ?? null;
    const haveParent = layer.parentTag ?? null;
    if (wantParent !== haveParent) {
      ops.push({ op: 'setParent', node: node.id, from: haveParent, to: wantParent });
    }

    if (layer.blendMode !== undefined && layer.blendMode !== node.blendMode) {
      ops.push({ op: 'setBlendMode', node: node.id, from: layer.blendMode, to: node.blendMode });
    }

    if (layer.enabled !== undefined && layer.enabled !== node.enabled) {
      ops.push({ op: 'setEnabled', node: node.id, from: layer.enabled, to: node.enabled });
    }

    if (node.kind === 'effect' && layer.shy === false) {
      ops.push({ op: 'setShy', node: node.id, from: false, to: true });
    }

    if (layer.label !== undefined && layer.label !== node.label) {
      ops.push({ op: 'setLabel', node: node.id, from: layer.label, to: node.label });
    }

    // A text layer's string. Gated on the reader having OBSERVED it, like every
    // other field above: emitting a write for something unread would have the
    // diff correcting a value it cannot see, forever. `textLocked` is the
    // reader saying the property is keyframed or expression-driven - the writer
    // refuses those, so the diff must not ask.
    if (layer.text !== undefined && !layer.textLocked
        && typeof node.text === 'string' && layer.text !== node.text) {
      ops.push({ op: 'setText', node: node.id, from: layer.text, to: node.text });
    }

    const wantEffects = node.kind === 'effect' 
      ? [{ matchName: node.matchName, name: node.name, params: node.props }]
      : effectFlows.effectsFor(node.id);

    const haveEffects = layer.effects || [];
    for (let i = 0; i < wantEffects.length; i++) {
      const wantEffect = wantEffects[i];
      const haveEffect = haveEffects[i];
      
      if (!haveEffect || haveEffect.matchName !== wantEffect.matchName) {
        ops.push({ op: 'addEffect', node: node.id, index: i + 1, matchName: wantEffect.matchName, name: wantEffect.name, params: wantEffect.params || {} });
      } else if (wantEffect.hostId) {
        // Shared effect! It should get its values from expressions linked to the host.
        // The host reader identifies which parameters actually accept an
        // expression. Checking every value made effects such as Fill look
        // perpetually half-linked because AE exposes non-expression topic/menu
        // properties alongside the writable values.
        const hostName = wantEffect.hostName;
        const expressionParams = Array.isArray(haveEffect.expressionParams)
          ? haveEffect.expressionParams
          : Object.keys(haveEffect.params || {});
        let allLinked = expressionParams.length > 0;
        for (const param of expressionParams) {
           const expr = haveEffect.expressions?.[param] || '';
           if (expr.indexOf(`thisComp.layer("${hostName}")`) === -1) {
              allLinked = false; break;
           }
        }
        // If they aren't fully linked, and we know there are linkable params, link them.
        if (!allLinked && expressionParams.length > 0) {
           ops.push({ op: 'linkEffectToHost', node: node.id, effectIndex: i + 1, hostName });
        }
      } else {
        // Direct effect or Effect Node itself: just set values.
        for (const [param, wantVal] of Object.entries(wantEffect.params || {})) {
          const haveVal = haveEffect.params?.[param];
          if (haveVal !== undefined && !valueEquals(haveVal, wantVal)) {
            ops.push({ op: 'setEffect', node: node.id, index: i + 1, param, from: haveVal, to: wantVal });
          }
        }
      }
    }

    if (haveEffects.length > wantEffects.length) {
      warnings.push({
        kind: 'extraEffects',
        node: node.id,
        message: `layer has ${haveEffects.length} effects but graph only lists ${wantEffects.length}; extra effects are unmanaged and left alone`,
      });
    }
  }

  // ---- expression edges ---------------------------------------------------
  for (const want of Object.values(desired)) {
    if (want.conflict) {
      warnings.push({ kind: 'edgeConflict', node: want.node, prop: want.prop,
        message: `two edges target ${want.node}.${want.prop}; a property holds only one expression` });
      continue;
    }
    const layer = resolved.get(want.node);
    if (!layer) continue; // created this pass; the expression lands next pass

    const have = layer.expressions?.[want.prop] ?? '';

    // Never clobber an expression the user wrote. Ownership is detectable
    // because the graph tags the ones it authors.
    if (have && !ownsExpression(have)) {
      warnings.push({ kind: 'userExpression', node: want.node, prop: want.prop,
        message: `${want.node}.${want.prop} carries a hand-written expression; the edge will not overwrite it` });
      continue;
    }
    if (have !== want.text) {
      ops.push({ op: 'setExpression', node: want.node, prop: want.prop,
        edge: want.edgeId, text: want.text, replacing: have || null });
    }
  }

  // ---- expressions we own that the graph no longer wants ------------------
  for (const [nodeId, layer] of resolved) {
    for (const [prop, text] of Object.entries(layer.expressions || {})) {
      if (!ownsExpression(text)) continue;
      const edgeId = edgeIdFromExpression(text);
      const stillWanted = desired[`${nodeId}|${prop}`];
      if (!stillWanted || stillWanted.edgeId !== edgeId || !graph.edges[edgeId]) {
        ops.push({ op: 'clearExpression', node: nodeId, prop, edge: edgeId });
      }
    }
  }

  // ---- layer order --------------------------------------------------------
  // We extract the order of managed layers currently in AE, and the desired order.
  // Only visible layer nodes participate; effect-controller host nulls retain
  // their slots and expressions have no host layer.
  const layerNodes = Object.values(graph.nodes).filter(n => n.kind !== 'expression' && n.kind !== 'effect');
  
  // Desired sequence of tags from top (smallest index) to bottom
  const desiredTags = layerNodes
    .sort((a, b) => a.order - b.order)
    .map(n => n.id)
    .filter(id => resolved.has(id)); // only reorder layers that actually exist this pass

  // Current sequence of tags in AE (compState.layers is top-to-bottom)
  const currentTags = compState.layers
    .map(l => {
      const tag = nodeIdFromTag(l.comment);
      const node = graph.nodes[tag];
      return resolved.has(tag) && l === resolved.get(tag) && node
        && node.kind !== 'effect' && node.kind !== 'expression' ? tag : null;
    })
    .filter(tag => tag !== null);

  // If the relative order of managed layers doesn't match the desired order, emit a reorder op.
  const currentTagsStr = currentTags.join(',');
  const desiredTagsStr = desiredTags.join(',');
  if (currentTagsStr !== desiredTagsStr && desiredTags.length > 0) {
    ops.push({ op: 'reorder', tags: desiredTags, current: currentTags });
  }

  return {
    ops: sortPatch(ops),
    warnings,
    stats: {
      nodes: Object.keys(graph.nodes).length,
      edges: Object.keys(graph.edges).length,
      managedLayers: resolved.size,
      untaggedLayers: untagged.length, // the user's — never touched
      opCount: ops.length,
    },
  };
}
