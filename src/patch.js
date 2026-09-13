// P1.3 — the panel side of the patch emitter.
//
// Turns the diff's ops into an evalScript call, and turns the receipt that comes
// back into something the panel can act on - including a rollback.
//
// ExtendScript has no JSON parser, so the ops travel as a real ES3 array
// LITERAL inside the call itself. That makes escaping load-bearing: an
// expression body containing a quote or a backslash would otherwise not be bad
// data, it would be executable source. Every string goes through one function,
// and that function is tested against the hostile cases.

const APPLY_FN = 'NTL_ApplyPatch';

// Ops jsx/patch.jsx implements. An op outside this set is refused HERE rather
// than discovered in After Effects, where the failure costs a round trip.
export const SUPPORTED_OPS = new Set([
  'createLayer', 'deleteLayer', 'setName', 'setProp',
  'setParent', 'setExpression', 'clearExpression',
  'addEffect', 'removeEffect', 'setEffect', 'setBlendMode',
  'linkEffectToHost',
]);

export class PatchError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'PatchError';
    this.detail = detail ?? null;
  }
}

// ------------------------------------------------------------- serialization

// An ES3 literal. Deliberately not JSON.stringify: this text is SOURCE CODE
// that After Effects will execute, so the escaping is a security boundary, not
// a formatting choice. Non-ASCII and every control character go out as \uXXXX,
// which no ExtendScript parser can misread.
export function toJsxLiteral(value) {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return jsxString(value);
  if (Array.isArray(value)) return `[${value.map(toJsxLiteral).join(',')}]`;
  if (t === 'object') {
    const kv = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      kv.push(`${jsxString(k)}:${toJsxLiteral(v)}`);
    }
    return `{${kv.join(',')}}`;
  }
  throw new PatchError(`cannot serialize a ${t} into ExtendScript`);
}

export function jsxString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code > 0x7e) {
      // Includes \n, \r, \t, U+2028/U+2029 and everything else that could end a
      // line or a literal early. Surrogate pairs fall out of this correctly
      // because the loop iterates code POINTS.
      for (let i = 0; i < ch.length; i++) {
        out += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
      }
    } else out += ch;
  }
  return out + '"';
}

// ------------------------------------------------------------------ the call

/**
 * @param ops        the diff's ops, already ordered — do NOT re-sort them
 * @param label      what the user sees in Edit > Undo. One patch, one entry:
 *                   S5 measured the stack at 99, so this must be one gesture's
 *                   worth of change, never one frame's.
 * @param revision   the app.project.revision the diff was computed against; the
 *                   host refuses the patch if the project has moved since
 */
export function applyPatchCall(ops, { compName = null, label = 'Node Timeline', revision = -1 } = {}) {
  if (!Array.isArray(ops)) throw new PatchError('ops must be an array');
  for (const op of ops) {
    if (!SUPPORTED_OPS.has(op.op)) {
      throw new PatchError(`op "${op.op}" is not implemented`, op);
    }
  }
  return `${APPLY_FN}(${toJsxLiteral(compName)},${toJsxLiteral(ops)},` +
         `${toJsxLiteral(label)},${toJsxLiteral(revision)})`;
}

// ---------------------------------------------------------------- the receipt

/**
 * @returns { ok, applied, writes, created, inverse, invertible, revision, ... }
 * @throws  PatchError on a stale project or a failed patch — and carries the
 *          inverse of whatever DID apply, so the caller can roll back.
 */
export function parseReceipt(jsonText) {
  let r;
  try {
    r = JSON.parse(jsonText);
  } catch {
    throw new PatchError(`patch did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }

  if (r.ok === true) return r;

  if (r.stale) {
    // Not an error in the patch — the world moved. The caller re-reads and
    // re-diffs; it does not retry the same ops against a changed comp.
    throw new PatchError(
      `project moved between read and write (expected revision ${r.expected}, found ${r.actual})`,
      { ...r, retryable: true },
    );
  }

  throw new PatchError(
    `patch failed at op ${r.failedAt} of ${r.ofOps}: ${r.message}`,
    { ...r, retryable: false },
  );
}

/**
 * Roll back a patch by RE-APPLYING its inverse. Not by pressing undo: a script
 * cannot reliably undo its own patch, and the user's own history is interleaved
 * with ours in the same 99-entry stack.
 *
 * The inverse arrives newest-first from the host, so it is applied as given.
 */
export function rollbackCall(receiptOrDetail, { compName = null, label = 'Node Timeline — undo patch' } = {}) {
  const inverse = receiptOrDetail?.inverse;
  if (!Array.isArray(inverse) || inverse.length === 0) return null;
  // No revision guard: the project has necessarily moved — we moved it.
  return applyPatchCall(inverse, { compName, label, revision: -1 });
}

// True when every change in the patch can be put back. A patch that deleted a
// layer cannot: re-creating a solid does not restore its masks or keyframes.
export const isFullyReversible = (receipt) => receipt.invertible === true;
