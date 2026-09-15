// The panel side of the selection bridge. Pure: it builds a call and reads a
// reply, and knows nothing about React or CEP.
//
// Why it exists: After Effects' Effect Controls and Properties panels follow the
// layer SELECTION and nothing else, so a node selected on the canvas has to
// become a selected layer or those panels have no way to know what the user is
// looking at.

const SELECT_FN = 'NTL_SelectLayers';
const EFFECT_CONTROLS_FN = 'NTL_ShowEffectControls';

export class SelectError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SelectError';
    this.detail = detail ?? null;
  }
}

// A node id reaches ExtendScript inside a string literal, so it is escaped the
// same way every other string in this project is: split/join, never a regex
// carrying backslashes. An id that could close its own literal would be an
// injection into the host, not merely a bad selection.
const literal = (s) => `"${String(s)
  .split('\\').join('\\\\')
  .split('"').join('\\"')
  .split('\r').join('\\r')
  .split('\n').join('\\n')}"`;

/**
 * Which layers should be selected, given the graph and the panel's selection.
 *
 * A node with no layer behind it selects nothing rather than clearing: an
 * expression node is not a layer, and a layer node whose layer does not exist
 * yet is one the next patch will create. Deselecting everything because the
 * user clicked one of those would be a worse answer than doing nothing.
 *
 * An EFFECT node resolves to its own host layer - the null the reconciler
 * creates to carry it - because that is the layer whose Effect Controls holds
 * the effect the user just clicked on.
 */
export function selectionTagsFor(graph, nodeIds) {
  const wanted = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
  const tags = [];
  for (const id of wanted) {
    const node = graph?.nodes?.[id];
    if (!node || node.kind === 'expression') continue;
    if (node.nativeId === null || node.nativeId === undefined) continue;
    tags.push(node.id);
  }
  return tags;
}

export function selectLayersCall(tags, { compId = null, exclusive = true } = {}) {
  const list = (tags || []).map(literal).join(',');
  return `${SELECT_FN}(${compId ?? 'null'}, [${list}], ${exclusive ? 'true' : 'false'})`;
}

export const showEffectControlsCall = () => `${EFFECT_CONTROLS_FN}()`;

export function parseSelection(jsonText) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new SelectError(`selection did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }
  if (payload?.ok !== true) {
    throw new SelectError(payload?.message || 'selection reported failure', payload);
  }
  return payload;
}
