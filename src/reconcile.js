import { addNode, desiredExpressions, nodeIdFromTag } from './graph.js';
import { diff } from './diff.js';
import { removeNode } from './view.js';

export class ReconcileError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'ReconcileError';
    this.detail = detail;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Build a graph that adopts every safely representable fact in compState.
 * Nothing mutates the live graph until a final diff proves the candidate needs
 * zero writes back to AE.
 */
export function captureCompState(graph, compState) {
  const candidate = clone(graph);
  let desired = desiredExpressions(candidate);
  const layers = new Map();
  const duplicates = new Set();
  for (const layer of compState.layers) {
    const id = nodeIdFromTag(layer.comment);
    if (!id) continue;
    if (layers.has(id)) duplicates.add(id);
    else layers.set(id, layer);
  }
  if (duplicates.size) {
    throw new ReconcileError(`Cannot adopt duplicated graph tags: ${[...duplicates].join(', ')}`);
  }

  for (const [id, edge] of Object.entries(candidate.edges)) {
    if (edge.kind !== 'expression') continue;
    const actual = layers.get(edge.to)?.expressions?.[edge.toProp] ?? '';
    const wanted = desired[`${edge.to}|${edge.toProp}`]?.text ?? '';
    if (actual !== wanted) delete candidate.edges[id];
  }
  desired = desiredExpressions(candidate);
  const flowNodes = new Set();
  for (const edge of Object.values(candidate.edges)) {
    if (edge.kind === 'flow') { flowNodes.add(edge.from); flowNodes.add(edge.to); }
  }

  for (const node of Object.values(candidate.nodes)) {
    if (node.kind === 'expression') continue;
    const layer = layers.get(node.id);
    if (!layer) {
      removeNode(candidate, node.id);
      continue;
    }
    node.nativeId = layer.nativeId;
    node.name = layer.name;
    node.parent = layer.parentTag ?? null;
    node.enabled = layer.enabled !== false;
    node.label = layer.label ?? node.label;
    node.blendMode = layer.blendMode ?? node.blendMode;
    if (node.kind === 'effect') {
      const effect = layer.effects?.[0];
      if (effect?.matchName === node.matchName) node.props = clone(effect.params || {});
    } else {
      for (const [prop, value] of Object.entries(layer.props || {})) {
        // A driven value belongs to its expression, not to a constant input.
        if (!desired[`${node.id}|${prop}`]) node.props[prop] = clone(value);
      }
      if (!flowNodes.has(node.id)) {
        node.effects = (layer.effects || []).map((effect) => ({
          matchName: effect.matchName,
          name: effect.name || effect.matchName,
          params: clone(effect.params || {}),
        }));
      }
    }
  }

  for (const [id, layer] of layers) {
    if (candidate.nodes[id]) continue;
    addNode(candidate, {
      id, nativeId: layer.nativeId, kind: layer.kind, name: layer.name,
      parent: layer.parentTag, enabled: layer.enabled, label: layer.label,
      blendMode: layer.blendMode, props: clone(layer.props || {}),
      effects: (layer.effects || []).map((effect) => ({
        matchName: effect.matchName, name: effect.name, params: clone(effect.params || {}),
      })),
    });
  }

  compState.layers.forEach((layer, index) => {
    const id = nodeIdFromTag(layer.comment);
    if (id && candidate.nodes[id]) candidate.nodes[id].order = index + 1;
  });

  const verification = diff(candidate, compState);
  if (verification.ops.length) {
    throw new ReconcileError(
      `AE contains ${verification.ops.length} change${verification.ops.length === 1 ? '' : 's'} that cannot be represented safely`,
      verification,
    );
  }
  return { graph: candidate, warnings: verification.warnings };
}
