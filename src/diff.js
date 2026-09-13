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
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < EPSILON;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valueEquals(a[i], b[i])) return false;
    return true;
  }
  return false;
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
  'setProp',
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

/**
 * @param graph      the source of truth
 * @param compState  what After Effects currently holds, from the reader
 * @returns { ops, warnings, stats }
 */
export function diff(graph, compState) {
  const ops = [];
  const warnings = [];

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
    warnings.push({
      kind: 'duplicate',
      node: nodeId,
      count: layers.length,
      keptNativeId: original.nativeId,
      message: `${layers.length} layers claim tag "${nodeId}" — treating nativeId ${original.nativeId} as the original; the copies are unmanaged until re-tagged`,
    });
  }

// Helper to flatten chained effect nodes into an array of effects for a layer node.
function getFlattenedEffects(graph, startNodeId) {
  const flowEdges = Object.values(graph.edges).filter((e) => e.kind === 'flow');
  const outgoing = {};
  for (const e of flowEdges) {
    if (!outgoing[e.from]) outgoing[e.from] = [];
    outgoing[e.from].push(e);
  }
  
  const effects = [...(graph.nodes[startNodeId]?.effects || [])];
  let curr = startNodeId;
  while (outgoing[curr] && outgoing[curr].length > 0) {
    const edge = outgoing[curr][0]; // MVP: assume linear chain
    const nextNode = graph.nodes[edge.to];
    if (nextNode && nextNode.kind === 'effect') {
      effects.push({
        matchName: nextNode.matchName,
        name: nextNode.name,
        hostId: nextNode.id,
        hostName: nextNode.name,
      });
      curr = nextNode.id;
    } else {
      break;
    }
  }
  return effects;
}

  // ---- layers the graph wants that are not there --------------------------
  for (const node of Object.values(graph.nodes)) {
    if (node.kind === 'expression') continue;
    if (resolved.has(node.id)) continue;
    const kind = node.kind === 'effect' ? 'null' : node.kind;
    const props = node.kind === 'effect' ? {} : node.props;
    ops.push({ op: 'createLayer', node: node.id, kind, name: node.name, props });
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
      // A property driven by an expression is not ours to write: the expression
      // IS the value. Writing it would be overwritten on the next frame anyway.
      if (desired[`${node.id}|${prop}`]) continue;

      const have = layer.props?.[prop];
      if (have === undefined) {
        warnings.push({ kind: 'missingProp', node: node.id, prop,
          message: `comp state has no "${prop}" for node ${node.id}` });
        continue;
      }
      if (!valueEquals(have, want)) {
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

    const wantEffects = node.kind === 'effect' 
      ? [{ matchName: node.matchName, name: node.name, params: node.props }]
      : getFlattenedEffects(graph, node.id);

    const haveEffects = layer.effects || [];
    for (let i = 0; i < wantEffects.length; i++) {
      const wantEffect = wantEffects[i];
      const haveEffect = haveEffects[i];
      
      if (!haveEffect || haveEffect.matchName !== wantEffect.matchName) {
        ops.push({ op: 'addEffect', node: node.id, index: i + 1, matchName: wantEffect.matchName, name: wantEffect.name, params: wantEffect.params || {} });
      } else if (wantEffect.hostId) {
        // Shared effect! It should get its values from expressions linked to the host.
        // We only check if there are params that could be linked. If it's empty, we don't bother yet.
        const hostName = wantEffect.hostName;
        let allLinked = true;
        for (const param of Object.keys(haveEffect.params || {})) {
           const expr = haveEffect.expressions?.[param] || '';
           if (expr.indexOf(`thisComp.layer("${hostName}")`) === -1) {
              allLinked = false; break;
           }
        }
        // If they aren't fully linked, and we know there are params, link them!
        if (!allLinked && Object.keys(haveEffect.params || {}).length > 0) {
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
