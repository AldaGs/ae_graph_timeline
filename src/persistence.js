import { nodeIdFromTag } from './graph.js';
import { diff } from './diff.js';
import { compareSnapshots, snapshot } from './drift.js';

// Refresh cached handles only for unique durable tags. A duplicate still
// requires a decision; its first layer is never guessed to be the original.
export function inspectSavedGraph(graph, baseline, current) {
  const counts = new Map();
  for (const layer of current.layers) {
    const id = nodeIdFromTag(layer.comment);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const candidate = JSON.parse(JSON.stringify(graph));
  for (const layer of current.layers) {
    const id = nodeIdFromTag(layer.comment);
    if (counts.get(id) === 1 && candidate.nodes[id]) {
      const node = candidate.nodes[id];
      node.nativeId = layer.nativeId;
      // M4.8 briefly completed effect nodes from their host null's transform,
      // polluting persisted parameter bags. Reopen has the authoritative effect
      // record in hand, so retain only keys that are real parameters.
      if (node.kind === 'effect') {
        const effect = (layer.effects || []).find((item) => item.matchName === node.matchName);
        if (effect) {
          const observed = effect.params || {};
          node.props = Object.fromEntries(Object.entries(node.props || {})
            .filter(([key]) => observed[key] !== undefined));
        }
      }
    }
  }
  const diagnostic = diff(candidate, current);
  const changes = baseline ? compareSnapshots(snapshot(baseline), snapshot(current)).changes : [];
  return { graph: candidate, diagnostic,
    baselineChanged: changes.some((change) => change.kind !== 'rebindable') };
}

// Versioned, lossless graph documents. Never execute file contents.
export function parseGraph(text) {
  const doc = JSON.parse(text);
  if (doc.schemaVersion !== 1) throw new Error('Unsupported graph file version');
  if (!doc.graphId || !doc.identity || !doc.graph?.nodes || !doc.graph?.edges) throw new Error('Incomplete graph file');
  for (const [id, node] of Object.entries(doc.graph.nodes)) {
    if (id !== node.id || !node.kind || !node.props || !Number.isFinite(node.ui?.x) || !Number.isFinite(node.ui?.y)) throw new Error('Invalid graph node: ' + id);
    if (node.parent && !doc.graph.nodes[node.parent]) throw new Error('Missing parent: ' + id);
  }
  for (const [id, edge] of Object.entries(doc.graph.edges)) {
    if (id !== edge.id || !doc.graph.nodes[edge.from] || !doc.graph.nodes[edge.to]
        || !['flow', 'expression'].includes(edge.kind)) throw new Error('Invalid graph edge: ' + id);
  }
  return doc;
}

export function serializeGraph(graph, identity, baseline = null, graphId = null) {
  const text = JSON.stringify({ schemaVersion: 1, graphId: graphId || `ntl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    identity, baseline, graph, savedAt: new Date().toISOString() }, null, 2);
  parseGraph(text);
  return text;
}

// Injected filesystem keeps disk recovery testable without CEP.
export function createGraphStore(fs) {
  return {
    load(path) {
      if (!fs.existsSync(path) && !fs.existsSync(path + '.bak')) return null;
      try { return { document: parseGraph(fs.readFileSync(path, 'utf8')), recovered: false }; }
      catch (error) {
        // A newer schema is not corruption: never replace it with an old backup.
        if (/version/.test(error.message)) throw error;
        return { document: parseGraph(fs.readFileSync(path + '.bak', 'utf8')), recovered: true };
      }
    },
    save(path, text) {
      parseGraph(text);
      if (fs.existsSync(path)) {
        const previous = fs.readFileSync(path, 'utf8');
        let valid = false;
        try { parseGraph(previous); valid = true; }
        catch (error) {
          if (/version/.test(error.message)) throw error;
          parseGraph(fs.readFileSync(path + '.bak', 'utf8'));
        }
        if (valid) {
          fs.writeFileSync(path + '.bak.tmp', previous, 'utf8');
          fs.renameSync(path + '.bak.tmp', path + '.bak');
        }
      }
      fs.writeFileSync(path + '.tmp', text, 'utf8');
      fs.renameSync(path + '.tmp', path);
    },
  };
}
