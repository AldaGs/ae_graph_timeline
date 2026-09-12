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
  'setEffect',
  'setParent',
  'setExpression',
  'reorder',
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

  // ---- layers the graph wants that are not there --------------------------
  for (const node of Object.values(graph.nodes)) {
    if (resolved.has(node.id)) continue;
    ops.push({ op: 'createLayer', node: node.id, kind: node.kind, name: node.name, props: node.props });
  }

  // ---- layers we own that the graph no longer wants -----------------------
  for (const [nodeId, layer] of resolved) {
    if (!graph.nodes[nodeId]) {
      ops.push({ op: 'deleteLayer', node: nodeId, nativeId: layer.nativeId, name: layer.name });
    }
  }

  // ---- properties, names, parents -----------------------------------------
  const desired = desiredExpressions(graph);

  for (const node of Object.values(graph.nodes)) {
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
