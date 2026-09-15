// The outliner's tree, as data.
//
// Blender's LOOK, not Blender's hierarchy. Every layer is a child of the
// composition and nothing else: After Effects' timeline is a flat stack, and
// nesting layers under their parents would make the outliner disagree with the
// timeline about what the comp is. A layer's parent is a relationship, and the
// canvas is where a relationship belongs.
//
// So a row's depth means one thing only: a layer sits under its composition, and
// an effect sits under the layer whose stack it is in. An effect is not a layer,
// has no position in the stack, and is never reordered.
//
// Pure. No React, no After Effects.

import { buildEffectFlowIndex } from './diff.js';
import { KIND_DEFAULT_LABEL } from './graph.js';

/**
 * The outliner's groups.
 *
 * Layers come first, as one group standing for the composition - the thing a
 * Blender user would read as a collection. Expression nodes and unwired effect
 * nodes are their own groups: they are not layers, they have no place in the
 * stacking order, and listing them among things that do would imply one.
 */
export function outlineTree(graph, { compName = null } = {}) {
  const flows = buildEffectFlowIndex(graph);
  const layers = [];
  const effects = [];
  const logic = [];

  for (const node of Object.values(graph?.nodes || {})) {
    if (node.kind === 'expression') { logic.push(node); continue; }
    // An effect node's host null is machinery. It appears under the layer whose
    // effect stack it belongs to, never as a layer of its own.
    if (node.kind === 'effect') { effects.push(node); continue; }
    layers.push(node);
  }

  const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id);
  const claimed = new Set();

  const rows = layers.sort(byOrder).map((node) => ({
    type: 'layer',
    id: node.id,
    name: node.name,
    kind: node.kind,
    enabled: node.enabled !== false,
    label: node.label ?? KIND_DEFAULT_LABEL[node.kind] ?? 0,
    order: node.order || 0,
    // The parent is a fact the row can SAY, not something to be nested by. A
    // user scanning the outliner still wants to know a layer is parented; they
    // do not want the stack rearranged in order to be told.
    parent: graph.nodes[node.parent] && node.parent !== node.id ? node.parent : null,
    effects: flows.effectsFor(node.id).map((fx, index) => {
      if (fx.hostId) claimed.add(fx.hostId);
      return {
        type: 'effect',
        // A standalone effect node keeps its own id, so clicking it selects the
        // node the user drew. An inline effect has none to give.
        id: fx.hostId || `${node.id}#fx${index}`,
        nodeId: fx.hostId || null,
        name: fx.name || fx.matchName,
        matchName: fx.matchName,
      };
    }),
  }));

  // An effect node the user has just dropped is wired to nothing, so no layer
  // claims it and it would appear NOWHERE - visible on the canvas and absent
  // from the outliner. Grouped on its own until it is wired, at which point it
  // moves under the layer whose stack it joined.
  const unwired = effects.filter((node) => !claimed.has(node.id)).sort(byOrder);

  const groups = [];
  if (rows.length) {
    groups.push({ type: 'comp', id: '@comp', name: compName || graph?.compName || 'Composition',
                  children: rows, count: rows.length });
  }
  if (unwired.length) {
    groups.push({ type: 'unwired', id: '@unwired', name: 'Unwired effects', count: unwired.length,
      children: unwired.map((node) => ({
        type: 'effect', id: node.id, nodeId: node.id, kind: 'effect',
        name: node.name, matchName: node.matchName, effects: [] })) });
  }
  if (logic.length) {
    groups.push({ type: 'logic', id: '@logic', name: 'Expressions', count: logic.length,
      children: logic.sort(byOrder).map((node) => ({
        type: 'expression', id: node.id, name: node.name, kind: 'expression', effects: [] })) });
  }
  return groups;
}

/**
 * The rows to render, flattened, with the depth each one sits at.
 *
 * Three levels, and only three: group, layer, effect. Written as a loop rather
 * than a recursion because that is the truth of the shape - a recursive walk
 * here would imply a depth the model does not have.
 *
 * @param collapsed  a Set of row ids whose children are hidden
 */
export function outlineRows(groups, collapsed = new Set()) {
  const rows = [];
  for (const group of groups) {
    const kids = group.children || [];
    rows.push({ ...group, depth: 0, parentId: null, hasChildren: kids.length > 0 });
    if (!kids.length || collapsed.has(group.id)) continue;
    for (const row of kids) {
      const fx = row.effects || [];
      rows.push({ ...row, depth: 1, parentId: group.id, hasChildren: fx.length > 0 });
      if (!fx.length || collapsed.has(row.id)) continue;
      for (const effect of fx) {
        rows.push({ ...effect, depth: 2, parentId: row.id, hasChildren: false });
      }
    }
  }
  return rows;
}

/** Every layer id, top to bottom: the AE stacking order the outliner shows. */
export function outlineOrder(groups) {
  const out = [];
  for (const group of groups) {
    if (group.type !== 'comp') continue;
    for (const row of group.children || []) if (row.type === 'layer') out.push(row.id);
  }
  return out;
}

/**
 * Where a drag ends up.
 *
 * Expressed over the flat order, because the flat order is the whole of what
 * After Effects is given and the only thing a reorder can change. One row
 * moves, and nothing travels with it, because nothing is nested under it.
 *
 * @param before  drop above the target rather than below it
 * @returns the new flat order, or null when the move would change nothing or
 *          cannot be made
 */
export function moveInOutline(groups, sourceId, targetId, { before = true } = {}) {
  const order = outlineOrder(groups);
  if (sourceId === targetId) return null;
  if (!order.includes(sourceId) || !order.includes(targetId)) return null;

  const rest = order.filter((id) => id !== sourceId);
  const at = rest.indexOf(targetId);
  if (at === -1) return null;

  const next = [...rest.slice(0, before ? at : at + 1), sourceId,
                ...rest.slice(before ? at : at + 1)];
  return next.join(',') === order.join(',') ? null : next;
}
