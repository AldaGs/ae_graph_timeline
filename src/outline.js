// The outliner's tree, as data.
//
// Blender's outliner nests objects under their parents and reads top to bottom;
// After Effects' timeline is a flat stack where a layer's parent may sit
// anywhere. Both are true at once, and this file is where they are reconciled:
//
//   - the tree NESTS by parent, because that is the relationship a user is
//     actually looking for when they open an outliner;
//   - the flat order is the tree's depth-first walk, so what the user reads top
//     to bottom IS the AE stacking order. Nothing is displayed that does not
//     correspond to a real position in the comp.
//
// The consequence is deliberate and worth stating: dragging a parent takes its
// children with it. That is the only reading of "move this row" that keeps the
// two orders the same thing.
//
// Pure. No React, no After Effects.

import { buildEffectFlowIndex } from './diff.js';
import { KIND_DEFAULT_LABEL } from './graph.js';

/**
 * The outliner's groups, nested.
 *
 * Layers come first, as one group standing for the composition - the thing a
 * Blender user would read as a collection. Expression nodes are their own
 * group: they are not layers, they have no place in the stacking order, and
 * listing them among things that do would imply one.
 */
export function outlineTree(graph, { compName = null } = {}) {
  const flows = buildEffectFlowIndex(graph);
  const layers = [];
  const logic = [];

  const effects = [];
  for (const node of Object.values(graph?.nodes || {})) {
    if (node.kind === 'expression') { logic.push(node); continue; }
    // An effect node's host null is machinery. It appears under the layer whose
    // effect stack it belongs to, never as a layer of its own.
    if (node.kind === 'effect') { effects.push(node); continue; }
    layers.push(node);
  }

  const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id);
  const childrenOf = new Map();
  for (const node of layers) {
    const parent = graph.nodes[node.parent] && node.parent !== node.id ? node.parent : null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(node);
  }

  // A parent cycle would recurse forever. The graph refuses to build one, but
  // a hand-edited .ntl file is not the graph's to vouch for.
  const seen = new Set();
  const build = (parentId) => (childrenOf.get(parentId) || []).sort(byOrder).map((node) => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    return {
      type: 'layer',
      id: node.id,
      name: node.name,
      kind: node.kind,
      enabled: node.enabled !== false,
      label: node.label ?? KIND_DEFAULT_LABEL[node.kind] ?? 0,
      order: node.order || 0,
      effects: flows.effectsFor(node.id).map((fx, index) => ({
        type: 'effect',
        // A standalone effect node keeps its own id, so clicking it selects the
        // node the user drew. An inline effect has none to give.
        id: fx.hostId || `${node.id}#fx${index}`,
        nodeId: fx.hostId || null,
        name: fx.name || fx.matchName,
        matchName: fx.matchName,
      })),
      children: build(node.id),
    };
  }).filter(Boolean);

  const roots = build(null);
  // A node orphaned by a parent that is gone, or stranded in a cycle, is still
  // a layer in the comp. Shown at the top level rather than dropped.
  const stranded = layers.filter((node) => !seen.has(node.id)).sort(byOrder);
  for (const node of stranded) {
    seen.add(node.id);
    roots.push({ type: 'layer', id: node.id, name: node.name, kind: node.kind,
      enabled: node.enabled !== false, label: node.label ?? 0, order: node.order || 0,
      effects: [], children: [] });
  }

  // An effect node the user has just dropped is wired to nothing, so no layer
  // claims it and it would appear NOWHERE - visible on the canvas and absent
  // from the outliner. Grouped on its own until it is wired, at which point it
  // moves under the layer whose stack it joined.
  const claimed = new Set();
  const claim = (nodes) => {
    for (const node of nodes) {
      for (const fx of node.effects || []) if (fx.nodeId) claimed.add(fx.nodeId);
      claim(node.children || []);
    }
  };
  claim(roots);
  const unwired = effects.filter((node) => !claimed.has(node.id)).sort(byOrder);

  const groups = [];
  if (roots.length) {
    groups.push({ type: 'comp', id: '@comp', name: compName || graph?.compName || 'Composition',
                  children: roots, count: layers.length });
  }
  if (unwired.length) {
    groups.push({ type: 'unwired', id: '@unwired', name: 'Unwired effects', count: unwired.length,
      children: unwired.map((node) => ({
        type: 'effect', id: node.id, nodeId: node.id, kind: 'effect',
        name: node.name, matchName: node.matchName, effects: [], children: [] })) });
  }
  if (logic.length) {
    groups.push({ type: 'logic', id: '@logic', name: 'Expressions', count: logic.length,
      children: logic.sort(byOrder).map((node) => ({
        type: 'expression', id: node.id, name: node.name, kind: 'expression',
        effects: [], children: [] })) });
  }
  return groups;
}

/**
 * The rows to render, flattened, with the depth each one sits at.
 *
 * @param collapsed  a Set of row ids whose children are hidden
 */
export function outlineRows(groups, collapsed = new Set()) {
  const rows = [];
  const walk = (nodes, depth, parentId) => {
    for (const node of nodes) {
      // Effects before children: an effect belongs TO this layer, a child is a
      // separate layer that merely points at it.
      const kids = [...(node.effects || []), ...(node.children || [])];
      rows.push({ ...node, depth, parentId, hasChildren: kids.length > 0 });
      if (kids.length && !collapsed.has(node.id)) walk(kids, depth + 1, node.id);
    }
  };
  for (const group of groups) {
    const kids = group.children || [];
    rows.push({ ...group, depth: 0, parentId: null, hasChildren: kids.length > 0 });
    if (kids.length && !collapsed.has(group.id)) walk(kids, 1, group.id);
  }
  return rows;
}

/** Every layer id, top to bottom: the AE stacking order the tree stands for. */
export function outlineOrder(groups) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type !== 'layer') continue;
      out.push(node.id);
      walk(node.children || []);
    }
  };
  for (const group of groups) if (group.type === 'comp') walk(group.children || []);
  return out;
}

/**
 * Where a drag ends up.
 *
 * Expressed over the flat order rather than the tree, because the flat order is
 * what After Effects is given and the only thing a reorder can actually change.
 * A node's subtree travels with it: the tree nests by parent, so leaving a
 * child behind would print an order the tree could never redraw.
 *
 * @param before  drop above the target rather than below it
 * @returns the new flat order, or null when the move would change nothing or
 *          cannot be made - a row dropped inside its own subtree, for instance
 */
export function moveInOutline(groups, sourceId, targetId, { before = true } = {}) {
  const order = outlineOrder(groups);
  if (sourceId === targetId) return null;
  if (!order.includes(sourceId) || !order.includes(targetId)) return null;

  const subtree = subtreeIds(groups, sourceId);
  // Dropping a row into its own descendants has no meaning: the block being
  // moved and the place it is going are the same rows.
  if (subtree.includes(targetId)) return null;

  const moving = order.filter((id) => subtree.includes(id));
  const rest = order.filter((id) => !subtree.includes(id));
  const at = rest.indexOf(targetId);
  if (at === -1) return null;

  const next = [...rest.slice(0, before ? at : at + 1), ...moving,
                ...rest.slice(before ? at : at + 1)];
  return next.join(',') === order.join(',') ? null : next;
}

export function subtreeIds(groups, rootId) {
  const found = [];
  const collect = (node) => {
    if (node.type !== 'layer') return;
    found.push(node.id);
    for (const child of node.children || []) collect(child);
  };
  const find = (nodes) => {
    for (const node of nodes) {
      if (node.id === rootId) { collect(node); return true; }
      if (find(node.children || [])) return true;
    }
    return false;
  };
  find(groups);
  return found;
}
