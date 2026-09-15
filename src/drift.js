// P1.4 — the drift guard.
//
// The graph is the source of truth, but After Effects has no event that says
// "the user edited the comp behind your back" (Wall 2 in PLAN.md). So drift is
// detected by comparison, and the only reason that is affordable is S4:
// app.project.revision is a 2.3 µs read, and it moves on every change to the
// project. Three tiers, cheapest first:
//
//   1. the GATE     - app.project.revision against the one we last saw.
//                     2.3 µs, and while nothing moves it is the only cost.
//   2. the SNAPSHOT - a full structural read (S4 measured a whole-comp read and
//                     hash at well under one patch budget), digested.
//   3. the COMPARE  - digest against digest. Equal means the revision moved for
//                     something that is none of our business: a selection, a
//                     view change, an edit in another comp. Different means the
//                     comp really moved, and the compare says where.
//
// Tier 1 is what runs while idle. Tiers 2 and 3 only run once tier 1 says
// something happened, which is what makes an idle reconciler cost ~0.
//
// Pure. No After Effects, no I/O - the only thing here that knows about the host
// is the pair of helpers that build the revision call and parse its reply.

import { nodeIdFromTag, ownsExpression } from './graph.js';
import { valueEquals } from './diff.js';

const REVISION_FN = 'NTL_Revision';

export class DriftError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'DriftError';
    this.report = report ?? null;
  }
}

// ------------------------------------------------------------------ the gate

export const revisionCall = () => `${REVISION_FN}()`;

export function parseRevision(jsonText) {
  let r;
  try {
    r = JSON.parse(jsonText);
  } catch {
    throw new DriftError(`revision gate did not return JSON: "${String(jsonText).slice(0, 120)}"`);
  }
  if (r.ok !== true || typeof r.revision !== 'number') {
    throw new DriftError(r.message || 'revision gate reported failure', r);
  }
  return r.revision;
}

// --------------------------------------------------------------- the digest
//
// FNV-1a, 32-bit. Not a security hash and not trying to be: it stands in for a
// string comparison over a few hundred layers, where the only property that
// matters is that a changed comp produces a changed number. Written out rather
// than pulled in because the digest must stay byte-identical across versions of
// this project, or a reload would look like drift.
export function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // The 32-bit FNV prime, by shifts, because h * 16777619 loses precision
    // once h passes 2^24 and the hash would then depend on the JS engine.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Stable digest text. Rounded digests are a fast candidate check, not numeric
// equality: property comparisons also use valueEquals's relative tolerance.
export function canonicalValue(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalValue).join(',')}]`;
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(6) : 'nan';
  if (v === null || v === undefined) return '~';
  return JSON.stringify(String(v));
}

const canonicalMap = (obj) =>
  Object.keys(obj || {}).sort().map((k) => `${k}=${canonicalValue(obj[k])}`).join(';');

// The fields that make up a layer's structural identity. Deliberately NOT
// everything the reader returns: `index` is a position, and it moves whenever
// anything above a layer is added or removed, so including it would report every
// layer in the comp as drifted the moment one was inserted. Order is carried
// separately, as one digest over the whole comp.
function layerFacts(layer) {
  return {
    nativeId: layer.nativeId,
    name: layer.name,
    kind: layer.kind,
    enabled: layer.enabled !== false,
    inPoint: layer.inPoint,
    outPoint: layer.outPoint,
    parentTag: layer.parentTag ?? null,
    // R1: null means "the host did not report one", which is not the same as
    // 'normal'. Defaulting it here made a layer kind without a blend mode
    // indistinguishable from one the user had set back to normal.
    blendMode: layer.blendMode ?? null, // M2
    label: layer.label ?? null,
    source: layer.source ? { ...layer.source } : null,
    props: { ...(layer.props || {}) },
    expressions: { ...(layer.expressions || {}) },
    // M2: effects array, keeping only what matters for structural identity
    effects: (layer.effects || []).map((fx) => ({
      matchName: fx.matchName,
      name: fx.name,
      params: { ...(fx.params || {}) },
      expressions: { ...(fx.expressions || {}) },
    })),
  };
}

const canonicalEffects = (effects) =>
  (effects || []).map((fx) => 
    `${fx.matchName}|${fx.name}|${canonicalMap(fx.params)}|${canonicalMap(fx.expressions)}`
  ).join('::');

function layerDigest(f) {
  return fnv1a([
    f.nativeId, f.name, f.kind, f.enabled ? '1' : '0',
    canonicalValue(f.inPoint), canonicalValue(f.outPoint),
    f.parentTag ?? '~',
    f.blendMode ?? '~',
    canonicalValue(f.label),
    canonicalMap(f.source),
    canonicalMap(f.props),
    canonicalMap(f.expressions),
    canonicalEffects(f.effects),
  ].join('|'));
}

/**
 * Digest a compState into something cheap to hold and cheap to compare.
 *
 * Managed and unmanaged layers are digested SEPARATELY. A user rearranging their
 * own layers is not drift the reconciler needs to care about; a user moving one
 * of ours is. One combined digest could not tell those apart, and would make the
 * guard cry wolf over the most ordinary thing a user does.
 */
export function snapshot(compState) {
  const layers = {};
  const foreign = [];
  const managedOrder = [];

  for (const layer of compState.layers) {
    const nodeId = nodeIdFromTag(layer.comment);
    if (nodeId === null) {
      foreign.push(`${layer.nativeId}:${layer.name}`);
      continue;
    }
    const facts = layerFacts(layer);
    managedOrder.push(nodeId);
    if (layers[nodeId]) {
      // Two layers carrying one tag - the duplicate case S3 found. Recorded as a
      // fact of the snapshot rather than resolved here; diff() and the writer
      // each have their own rule for it, and the guard must not invent a third.
      layers[nodeId].duplicate = true;
      continue;
    }
    layers[nodeId] = { nodeId, facts, digest: layerDigest(facts), duplicate: false };
  }

  const managedDigest = fnv1a(
    Object.keys(layers).sort().map((id) => `${id}:${layers[id].digest}`).join(''),
  );

  return {
    compId: compState.compId,
    compName: compState.compName,
    revision: compState.revision,
    layers,
    managedDigest,
    // Kept as a list, not just a digest, so a projection through a delete can
    // work out the new order instead of having to re-read for it.
    order: managedOrder,
    orderDigest: fnv1a(managedOrder.join(',')),
    foreignDigest: fnv1a(foreign.join('')),
    foreignCount: foreign.length,
    digest: fnv1a(`${managedDigest}|${foreign.length}`),
  };
}

// --------------------------------------------------------------- the compare

const FACT_KINDS = [
  ['name', 'renamed'],
  ['kind', 'kindChanged'],
  ['enabled', 'toggled'],
  ['inPoint', 'retimed'],
  ['outPoint', 'retimed'],
  ['parentTag', 'reparented'],
  ['blendMode', 'blendModeChanged'],
  ['label', 'labelChanged'],
];

/**
 * What moved between two snapshots of the same comp.
 *
 * Every change is classified, because "the comp moved" is not actionable and
 * "the layer node b owns is gone" is. An expression change is classified
 * further: text we authored that no longer carries our tag means the user edited
 * our expression by hand, which is the one case the reconciler must never
 * silently overwrite.
 */
export function compareSnapshots(before, after) {
  const changes = [];

  if (before.compId !== after.compId) {
    changes.push({ kind: 'compChanged', from: before.compName, to: after.compName,
      message: `the comp being reconciled changed from "${before.compName}" to "${after.compName}"` });
    // No point comparing layer by layer across two different comps.
    return report(before, after, changes);
  }

  for (const [nodeId, was] of Object.entries(before.layers)) {
    const now = after.layers[nodeId];
    if (!now) {
      changes.push({ kind: 'vanished', node: nodeId,
        message: `the layer carrying tag "${nodeId}" is gone from the comp` });
      continue;
    }
    if (now.digest === was.digest) continue;

    if (now.facts.nativeId !== was.facts.nativeId) {
      // The tag is still there but on a different layer. Precompose does this
      // (S3: the native id does not survive it), and so does deleting ours and
      // pasting a copy back. M4: if the tag is unique, it's a rebind, not a block.
      const isRebindable = !now.duplicate;
      const kind = isRebindable ? 'rebindable' : 'replaced';
      changes.push({ kind, node: nodeId,
        from: was.facts.nativeId, to: now.facts.nativeId,
        message: `tag "${nodeId}" is now on native id ${now.facts.nativeId}, was ${was.facts.nativeId}` });
    }

    for (const [field, kind] of FACT_KINDS) {
      if (canonicalValue(was.facts[field]) === canonicalValue(now.facts[field])) continue;
      changes.push({ kind, node: nodeId, field,
        from: was.facts[field], to: now.facts[field],
        message: `${nodeId}.${field}: ${canonicalValue(was.facts[field])} -> ${canonicalValue(now.facts[field])}` });
    }

    if (canonicalMap(was.facts.source) !== canonicalMap(now.facts.source)) {
      changes.push({ kind: 'sourceChanged', node: nodeId,
        from: was.facts.source, to: now.facts.source,
        message: `${nodeId}.source changed in After Effects` });
    }

    for (const prop of union(was.facts.props, now.facts.props)) {
      const from = was.facts.props[prop];
      const to = now.facts.props[prop];
      if (valueEquals(from, to) || canonicalValue(from) === canonicalValue(to)) continue;
      changes.push({ kind: 'propChanged', node: nodeId, prop, from, to,
        message: `${nodeId}.${prop}: ${canonicalValue(from)} -> ${canonicalValue(to)}` });
    }

    for (const prop of union(was.facts.expressions, now.facts.expressions)) {
      const from = was.facts.expressions[prop] ?? null;
      const to = now.facts.expressions[prop] ?? null;
      if (from === to) continue;
      // Whether the text we own is still text we own. An edge that came back
      // hand-edited is the drift that must block a write, because the next patch
      // would otherwise throw the user's work away and call it reconciliation.
      const ours = from !== null && ownsExpression(from);
      const stillOurs = to !== null && ownsExpression(to);
      changes.push({
        kind: ours && !stillOurs ? 'edgeTakenOver' : 'expressionChanged',
        node: nodeId, prop, from, to,
        message: ours && !stillOurs
          ? `${nodeId}.${prop} held an edge we authored; it is now hand-written or cleared`
          : `${nodeId}.${prop} expression changed`,
      });
    }

    // Effect comparison: since they are ordered, we compare by index.
    const wasFx = was.facts.effects || [];
    const nowFx = now.facts.effects || [];
    const maxFx = Math.max(wasFx.length, nowFx.length);
    for (let i = 0; i < maxFx; i++) {
      const w = wasFx[i];
      const n = nowFx[i];
      if (w && !n) {
        // If it was a managed effect, it missing is blocking.
        changes.push({ kind: 'effectRemoved', node: nodeId, index: i, matchName: w.matchName,
          message: `${nodeId} lost effect "${w.matchName}" at index ${i}` });
      } else if (!w && n) {
        changes.push({ kind: 'effectAdded', node: nodeId, index: i, matchName: n.matchName,
          message: `${nodeId} gained effect "${n.matchName}" at index ${i}` });
      } else if (w && n && w.matchName !== n.matchName) {
        changes.push({ kind: 'effectReplaced', node: nodeId, index: i, from: w.matchName, to: n.matchName,
          message: `${nodeId} effect at index ${i} changed from "${w.matchName}" to "${n.matchName}"` });
      } else if (w && n) {
        // Same effect matchName, check params
        for (const param of union(w.params, n.params)) {
          const pFrom = w.params[param];
          const pTo = n.params[param];
          if (canonicalValue(pFrom) === canonicalValue(pTo)) continue;
          changes.push({ kind: 'effectParamChanged', node: nodeId, index: i, param, from: pFrom, to: pTo,
            message: `${nodeId} effect ${n.matchName} parameter "${param}" changed: ${canonicalValue(pFrom)} -> ${canonicalValue(pTo)}` });
        }
      }
    }
  }

  for (const nodeId of Object.keys(after.layers)) {
    if (!before.layers[nodeId]) {
      changes.push({ kind: 'appeared', node: nodeId,
        message: `a layer carrying tag "${nodeId}" appeared that we did not create` });
      continue;
    }
    if (after.layers[nodeId].duplicate && !before.layers[nodeId].duplicate) {
      changes.push({ kind: 'duplicated', node: nodeId,
        message: `tag "${nodeId}" is now carried by more than one layer` });
    }
  }

  if (before.orderDigest !== after.orderDigest && changes.length === 0) {
    // Reported on its own only when nothing else moved: a reorder that came with
    // a create or a delete is already explained by those.
    changes.push({ kind: 'reordered',
      message: 'the managed layers are in a different order' });
  }

  return report(before, after, changes);
}

function union(a, b) {
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
}

// Drift a patch must not be computed through. Everything else - a value the user
// nudged, a layer they renamed - the next diff simply corrects, because the graph
// is the source of truth. These five are different: each means an identity the
// graph was holding is no longer the thing it thought it was.
const BLOCKING = new Set(['compChanged', 'vanished', 'replaced', 'duplicated', 'edgeTakenOver', 'effectRemoved', 'effectReplaced']);

// The user's own layers are reported, never counted as drift. The reconciler does
// not write to them, so their moving cannot invalidate a patch.
function report(before, after, changes) {
  const blocking = changes.filter((c) => BLOCKING.has(c.kind));
  return {
    drifted: changes.length > 0,
    changes,
    blocking,
    // What a caller should do: nothing, write anyway, or stop and ask.
    verdict: blocking.length > 0 ? 'refuse' : (changes.length > 0 ? 'report' : 'clean'),
    revisionMoved: before.revision !== after.revision,
    foreignMoved: before.foreignDigest !== after.foreignDigest,
    foreignDelta: after.foreignCount - before.foreignCount,
    from: before.revision,
    to: after.revision,
  };
}

// ----------------------------------------------------------- the projection
//
// After our own patch lands, the comp has moved - by exactly the ops we sent.
// Projecting the baseline forward through them is what lets the next compare
// mean "someone ELSE changed something" instead of "we did". The alternative is
// a full read after every patch, a round trip (1.2 ms) spent re-learning what we
// had just written.
export function projectSnapshot(snap, ops, revision) {
  const layers = {};
  for (const [id, entry] of Object.entries(snap.layers)) {
    layers[id] = { ...entry, facts: { ...entry.facts,
      props: { ...entry.facts.props }, expressions: { ...entry.facts.expressions } } };
  }

  for (const op of ops) {
    const entry = layers[op.node];
    switch (op.op) {
      case 'createLayer':
        // Not projectable, on purpose. The native id and the out point are AE's
        // to decide, and a baseline holding guesses for them would report our own
        // creation as someone else's drift on every later pass. A patch that
        // created a layer earns one fresh read - it cost 14.5 ms anyway, so a
        // 1.2 ms round trip to learn what AE actually made is not the expensive
        // part of it.
        return null;
      case 'deleteLayer':
        delete layers[op.node];
        break;
      case 'setName':
        if (entry) entry.facts.name = op.to;
        break;
      case 'setProp':
        if (entry) entry.facts.props[op.prop] = op.to;
        break;
      case 'setParent':
        if (entry) entry.facts.parentTag = op.to ?? null;
        break;
      case 'setBlendMode':
        if (entry) entry.facts.blendMode = op.to;
        break;
      case 'setLabel':
        if (entry) entry.facts.label = op.to;
        break;
      case 'setEnabled':
        if (entry) entry.facts.enabled = op.to;
        break;
      // Timeline visibility housekeeping is intentionally absent from the
      // structural drift digest, but it is safe to project through it.
      case 'setShy':
      case 'setHideShyLayers':
        break;
      case 'setExpression':
        if (entry) entry.facts.expressions[op.prop] = op.text;
        break;
      case 'clearExpression':
        if (entry) delete entry.facts.expressions[op.prop];
        break;
      case 'addEffect':
        if (entry) {
          entry.facts.effects = entry.facts.effects || [];
          entry.facts.effects.splice(op.index - 1, 0, {
            matchName: op.matchName,
            name: op.name,
            params: { ...(op.params || {}) },
            expressions: {}
          });
        }
        break;
      case 'removeEffect':
        if (entry && entry.facts.effects) {
          entry.facts.effects.splice(op.effectIndex - 1, 1);
        }
        break;
      case 'setEffect':
        if (entry && entry.facts.effects) {
          const fx = entry.facts.effects[op.index - 1];
          if (fx) fx.params[op.param] = op.to;
        }
        break;
      default:
        // An op we cannot project would make the projection a lie, and the next
        // compare would report the gap as someone else's drift. Better to say the
        // baseline is unusable and take a fresh read.
        return null;
    }
  }

  const rebuilt = {};
  for (const [id, entry] of Object.entries(layers)) {
    rebuilt[id] = { ...entry, digest: layerDigest(entry.facts) };
  }
  const managedDigest = fnv1a(
    Object.keys(rebuilt).sort().map((id) => `${id}:${rebuilt[id].digest}`).join(''),
  );

  // A delete changes the order of what remains, and deleting is the only
  // ordering change a projectable patch can make - createLayer bails out above,
  // precisely because only AE knows where it put the new layer.
  const order = (snap.order || []).filter((id) => rebuilt[id]);

  return {
    ...snap,
    revision: revision ?? snap.revision,
    layers: rebuilt,
    managedDigest,
    order,
    orderDigest: fnv1a(order.join(',')),
    digest: fnv1a(`${managedDigest}|${snap.foreignCount}`),
  };
}

// ------------------------------------------------------------------ the guard

/**
 * Holds the baseline and asks the three questions in order.
 *
 * @param onDrift  'refuse' - a blocking change stops the write until accepted
 *                 'report' - every change is reported and the write proceeds
 */
export function createDriftGuard({ onDrift = 'refuse' } = {}) {
  let baseline = null;
  let seenRevision = null;
  let lastReport = null;

  return {
    get baseline() { return baseline; },
    get revision() { return seenRevision; },
    get lastReport() { return lastReport; },
    onDrift,

    // Tier 1. The only thing that runs while idle.
    gate(revision) {
      if (seenRevision === null) return { status: 'unknown', revision };
      if (revision === seenRevision) return { status: 'clean', revision };
      return { status: 'moved', revision, from: seenRevision };
    },

    // Tiers 2 and 3, against a state the caller has already read.
    inspect(compState) {
      const now = snapshot(compState);
      if (!baseline) {
        lastReport = { drifted: false, changes: [], blocking: [], verdict: 'unknown',
                       revisionMoved: false, foreignMoved: false, foreignDelta: 0,
                       from: null, to: now.revision, firstRead: true };
        return lastReport;
      }
      const r = compareSnapshots(baseline, now);
      // A revision that moved with an identical digest is the common case, and
      // the cheap one: something happened in the project that is not in this
      // comp, or is not structural. Worth naming, because it is the whole reason
      // the digest tier exists.
      r.spuriousRevision = r.revisionMoved && !r.drifted && !r.foreignMoved;
      lastReport = r;
      return r;
    },

    // Adopt a state as the truth. Called after a clean pass, and after the user
    // has been told about drift and has chosen to go on.
    mark(compState) {
      baseline = snapshot(compState);
      seenRevision = baseline.revision;
      return baseline;
    },

    // After our own patch: move the baseline through our own ops instead of
    // re-reading. Returns false when the ops could not be projected, which
    // forces the next pass to take a real read.
    advance(ops, revision) {
      if (!baseline) return false;
      const next = projectSnapshot(baseline, ops, revision);
      if (!next) { baseline = null; seenRevision = null; return false; }
      baseline = next;
      seenRevision = revision;
      return true;
    },

    // The write gate. Throws rather than returning a flag: a caller that forgets
    // to check a boolean writes into a comp that moved under it, and the whole
    // point of P1.4 is that this cannot happen by omission.
    assertWritable(compState) {
      const r = this.inspect(compState);
      if (onDrift === 'refuse' && r.blocking.length > 0) {
        throw new DriftError(
          `the comp moved under the reconciler: ${r.blocking.map((c) => c.message).join('; ')}`,
          r,
        );
      }
      return r;
    },

    forget() { baseline = null; seenRevision = null; },
  };
}
