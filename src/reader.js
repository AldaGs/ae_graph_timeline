// P1.1 — the panel side of the comp state reader.
//
// jsx/reader.jsx does the reading inside After Effects and hands back a JSON
// string (evalScript can return nothing else). This file turns that string into
// the compState the pure diff consumes, and refuses to hand the diff anything
// it cannot trust.
//
// That refusal is the point. The diff decides what to WRITE into the user's
// project; feeding it a half-read comp would make it emit ops to "correct"
// properties that were merely unreadable. A partial read must fail loudly, not
// quietly become a patch.

const HOST_FN = 'NTL_ReadComp';
const NEW_COMP_DIALOG_FN = 'NTL_ShowNewCompDialog';
const ACTIVE_COMP_FN = 'NTL_ActiveComp';

export class ReadError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ReadError';
    this.detail = detail ?? null;
  }
}

// Escaping a string for an evalScript call. Same hazard as everywhere else in
// this project: build it with split/join, never a regex carrying backslashes.
export function jsxStringLiteral(s) {
  if (s === null || s === undefined) return 'null';
  const body = String(s)
    .split('\\').join('\\\\')
    .split('"').join('\\"')
    .split('\r').join('\\r')
    .split('\n').join('\\n');
  return `"${body}"`;
}

export function readCompCall({ compName = null, compId = null, includeEffects = false } = {}) {
  return `${HOST_FN}(${jsxStringLiteral(compName)}, ${includeEffects ? 'true' : 'false'}, ${compId ?? 'null'})`;
}

export const newCompDialogCall = () => `${NEW_COMP_DIALOG_FN}()`;
export const activeCompCall = () => `${ACTIVE_COMP_FN}()`;

export function parseActiveComp(jsonText) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new ReadError(`active comp check did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }
  if (payload?.ok !== true || typeof payload.active !== 'boolean') {
    throw new ReadError(payload?.message || 'active comp check returned an invalid result', payload);
  }
  if (payload.active && (typeof payload.compName !== 'string' || !isFiniteNumber(payload.compId))) {
    throw new ReadError('active comp check did not identify the composition', payload);
  }
  return payload;
}

export function classifyActiveComp(expected, active) {
  if (!expected) return { status: 'untracked' };
  if (!active?.active) return { status: 'missing', expected };
  if (active.compId !== expected.compId) return { status: 'changed', expected, active };
  return { status: 'same', expected, active };
}

export function parseNewCompDialog(jsonText) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new ReadError(`new comp dialog did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }
  if (payload?.ok !== true || typeof payload.created !== 'boolean') {
    throw new ReadError(payload?.message || 'new comp dialog returned an invalid result', payload);
  }
  if (payload.created && (typeof payload.compName !== 'string' || !isFiniteNumber(payload.compId))) {
    throw new ReadError('new comp dialog did not identify the created composition', payload);
  }
  return payload;
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// A property value is a number or an array of numbers. Anything else came back
// wrong, and is dropped with a warning rather than passed through: an undefined
// in compState reads to the diff as "missing", which it already reports.
function cleanValues(raw, where, warnings) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (isFiniteNumber(v)) { out[k] = v; continue; }
    if (Array.isArray(v) && v.length > 0 && v.every(isFiniteNumber)) { out[k] = v; continue; }
    warnings.push({
      kind: 'badValue',
      where,
      prop: k,
      message: `${where}.${k} is not a number or array of numbers; dropped`,
    });
  }
  return out;
}

function cleanExpressions(raw, where, warnings) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (typeof v === 'string' && v.length > 0) { out[k] = v; continue; }
    warnings.push({ kind: 'badExpression', where, prop: k,
      message: `${where}.${k} expression is not a non-empty string; dropped` });
  }
  return out;
}

// A blend mode the host could not name is reported and dropped, never guessed.
// Defaulting it to 'normal' would make the diff try to "correct" a mode this
// build does not know, on every pass, forever.
function blendModeOf(layer, where, warnings) {
  if (layer.blendMode === undefined) return undefined;
  if (typeof layer.blendMode === 'string' && layer.blendMode.length > 0) return layer.blendMode;
  warnings.push({ kind: 'unknownBlendMode', where,
    message: `${where} carries a blend mode this build cannot name; it is left alone` });
  return undefined;
}

/**
 * Validate and normalize the host's payload.
 *
 * @param payload  the parsed JSON from NTL_ReadComp
 * @param opts.tolerateReadErrors  P1.4's drift gate may want a best-effort read;
 *                                 the reconciler's write path must NOT set this.
 * @returns compState — exactly the shape diff() expects
 */
export function normalizeCompState(payload, { tolerateReadErrors = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new ReadError('reader returned no object');
  }
  if (payload.ok !== true) {
    throw new ReadError(payload.message || 'reader reported failure', payload);
  }
  if (!Array.isArray(payload.layers)) {
    throw new ReadError('reader returned no layers array', payload);
  }

  // The host COUNTS read failures rather than swallowing them, so that a
  // property it could not read cannot silently look unchanged forever.
  if (payload.readErrors > 0 && !tolerateReadErrors) {
    throw new ReadError(
      `${payload.readErrors} properties could not be read (first: ${payload.firstError}); ` +
      'refusing to diff a partial read',
      payload,
    );
  }

  const warnings = [];
  const seenNativeIds = new Set();
  const layers = [];

  for (const l of payload.layers) {
    if (!isFiniteNumber(l.nativeId)) {
      throw new ReadError(`layer "${l.name}" has no usable native id`, l);
    }
    // S3: the native id is unique within a project. Two layers sharing one is
    // not a duplicate the reconciler can reason about - it means the read
    // itself is wrong, and every id-based decision downstream would be too.
    if (seenNativeIds.has(l.nativeId)) {
      throw new ReadError(`native id ${l.nativeId} appears twice; the read is inconsistent`, l);
    }
    seenNativeIds.add(l.nativeId);

    const where = l.name || `layer#${l.index}`;
    layers.push({
      nativeId: l.nativeId,
      index: l.index,
      name: typeof l.name === 'string' ? l.name : '',
      comment: typeof l.comment === 'string' ? l.comment : '',
      kind: l.kind || 'footage',
      enabled: l.enabled !== false,
      inPoint: l.inPoint,
      outPoint: l.outPoint,
      // R1: carried only when the host actually observed them. `undefined`
      // means "not read", and the diff refuses to write a field it never saw -
      // which is what keeps an unsupported layer kind from being "corrected"
      // to a value nobody chose.
      label: Number.isInteger(l.label) ? l.label : undefined,
      blendMode: blendModeOf(l, where, warnings),
      // Parents travel as TAGS, not indices. An index is a position, not an
      // identity, and it changes the moment anything is reordered.
      parentTag: l.parentTag ?? null,
      parentIndex: l.parentIndex ?? null,
      props: cleanValues(l.props, where, warnings),
      expressions: cleanExpressions(l.expressions, where, warnings),
      effects: Array.isArray(l.effects)
        ? l.effects.map((fx) => ({
            name: fx.name,
            matchName: fx.matchName,
            index: fx.index,
            params: cleanValues(fx.params, `${where}/${fx.name}`, warnings),
            expressions: cleanExpressions(fx.expressions, `${where}/${fx.name}`, warnings),
          }))
        : undefined,
    });
  }

  return {
    compName: payload.compName,
    compId: payload.compId,
    // The frame of the comp, so the panel can centre a new layer in THIS comp.
    width: isFiniteNumber(payload.width) ? payload.width : null,
    height: isFiniteNumber(payload.height) ? payload.height : null,
    // S4: the revision this state was read at. P1.4 compares it before trusting
    // the state, and before writing a patch computed from it.
    revision: payload.revision,
    duration: payload.duration,
    frameRate: payload.frameRate,
    layers,
    warnings,
    stats: {
      layerCount: payload.layerCount,
      managedLayers: payload.managedLayers,
      untaggedLayers: payload.untaggedLayers,
      readErrors: payload.readErrors ?? 0,
      elapsedMs: payload.elapsedMs,
    },
  };
}

export function parseCompState(jsonText, opts) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch (e) {
    // evalScript returns the string "EvalScript error." on a host-side throw,
    // and an empty string if the host returned nothing at all. Neither is JSON,
    // and neither should surface as a parser error.
    const head = String(jsonText).slice(0, 120);
    throw new ReadError(`reader did not return JSON: "${head}"`, e.message);
  }
  return normalizeCompState(payload, opts);
}
