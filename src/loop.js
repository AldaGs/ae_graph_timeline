// P1.5 — the coalesced write loop.
//
// The thing that turns "mutate the graph object" into "After Effects follows",
// and the whole file exists because of one measurement: S5 put After Effects'
// undo stack at exactly 99 entries. A patch per frame would evict the user's
// entire history in under two seconds of dragging a node. So writes are
// COALESCED - one undo entry per gesture, never one per frame:
//
//   - while a gesture is open, nothing is written at all. A drag mutates the
//     graph as often as it likes; the comp is patched once, when the drag ends.
//   - a mutation with no gesture around it is debounced, and the debounce window
//     restarts on each further mutation. A REPL user typing three assignments in
//     a row gets one patch, not three.
//   - only one patch is ever in flight. A mutation arriving mid-flight sets the
//     loop dirty again and is picked up by the next pass, rather than racing a
//     patch computed from a comp state that is already stale.
//
// Each pass is read -> guard -> diff -> patch, in that order, because the diff
// must be computed against what the comp actually holds (Wall 1b: read pass,
// then one batched write pass) and P1.4's guard must have the chance to refuse
// before anything is written.
//
// The host is injected, so the whole loop runs offline against test/fake-ae.js.

import { readCompCall, parseCompState, ReadError } from './reader.js';
import { diff } from './diff.js';
import { applyPatchCall, parseReceipt, rollbackCall, PatchError } from './patch.js';
import { createDriftGuard, revisionCall, parseRevision, DriftError } from './drift.js';
import { bindNativeId, nodeIdFromTag, desiredExpressions, TRANSFORM_PROPS } from './graph.js';

export class LoopError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'LoopError';
    this.detail = detail ?? null;
  }
}

/**
 * @param host        { evalScript(source) -> Promise<string> } - the CEP bridge
 * @param graph       the source of truth; mutate it, then call touch()
 * @param compName    null for the active comp
 * @param compId      native identity of the comp inspected by the panel
 * @param debounceMs  how long after the last mutation a flush runs. 60 ms: S2c
 *                    measured the round trip at 1.2 ms, so this is chosen for
 *                    the user's hands, not for the transport.
 * @param guard       a P1.4 drift guard; one is made if none is passed
 * @param timer       { setTimeout, clearTimeout } - injected so tests own the clock
 */
export function createWriteLoop({
  host,
  graph,
  compName = null,
  compId = null,
  debounceMs = 60,
  guard = createDriftGuard(),
  includeEffects = false,
  maxStaleRetries = 2,
  observeAfterPatch = false,
  timer = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
} = {}) {
  if (!host || typeof host.evalScript !== 'function') {
    throw new LoopError('the loop needs a host with evalScript()');
  }
  if (!graph) throw new LoopError('the loop needs a graph');

  let dirty = false;
  let gestureDepth = 0;
  let gestureLabel = null;
  let pendingLabel = null;
  let timerHandle = null;
  let inFlight = null;
  let closed = false;
  let driftHold = null;      // the report that stopped us, until it is accepted

  const listeners = new Set();
  const stats = {
    touches: 0, flushes: 0, passes: 0, patches: 0, undoEntries: 0,
    cleanPasses: 0, coalesced: 0, staleRetries: 0, rollbacks: 0,
    reads: 0, gates: 0, drifts: 0, refusals: 0, opsWritten: 0,
  };

  const emit = (event) => {
    for (const fn of listeners) {
      // A listener that throws must not take the loop with it - the patch has
      // already been applied by the time events go out.
      try { fn(event); } catch { /* the panel's problem, not the loop's */ }
    }
  };

  // ------------------------------------------------------------------ the host

  const call = async (source) => {
    const out = await host.evalScript(source);
    if (typeof out !== 'string') {
      throw new LoopError('the host returned something other than a string', out);
    }
    return out;
  };

  const readComp = async () => {
    stats.reads++;
    return parseCompState(await call(readCompCall({ compName, compId, includeEffects })));
  };

  // ------------------------------------------------------------------ one pass

  async function pass(label) {
    stats.passes++;
    emit({ type: 'reading', label: label || 'Node Timeline' });

    const compState = await readComp();

    // P1.4's tiers 2 and 3. assertWritable throws on drift that invalidates the
    // graph's identities; everything else is reported and corrected by the diff.
    let report;
    try {
      report = guard.assertWritable(compState);
    } catch (e) {
      if (!(e instanceof DriftError)) throw e;
      stats.drifts++;
      stats.refusals++;
      driftHold = e.report;
      emit({ type: 'drift', verdict: 'refused', report: e.report, message: e.message });
      // Still dirty: the graph's changes have not been written. They wait for
      // acceptDrift(), which is a decision only the user can make.
      return { status: 'refused', report: e.report };
    }
    if (report.drifted) {
      stats.drifts++;
      emit({ type: 'drift', verdict: 'report', report });
    }

    // M4: Phase C: if the guard reported any 'rebindable' drift (e.g. precompose),
    // auto-update the handles before computing the diff.
    if (report.changes) {
      for (const change of report.changes) {
        if (change.kind === 'rebindable') {
          bindNativeId(graph, change.node, change.to);
        }
      }
    }

    const { ops, warnings, stats: diffStats } = diff(graph, compState);

    if (ops.length === 0) {
      // No patch, and therefore NO UNDO GROUP. An empty group would still cost
      // the user an undo entry out of 99 and would read as "Node Timeline" in
      // their history for a pass that changed nothing.
      stats.cleanPasses++;
      guard.mark(compState);
      emit({ type: 'clean', revision: compState.revision, warnings, stats: diffStats });
      return { status: 'clean', warnings };
    }

    const parentProps = new Map(ops.filter((op) => op.op === 'setParent')
      .map((op) => [op.node, JSON.stringify(graph.nodes[op.node]?.props)]));
    const created = new Set(ops.filter((op) => op.op === 'createLayer').map((op) => op.node));
    const source = applyPatchCall(ops, {
      compName,
      compId,
      // The label is what the user reads in Edit > Undo, so it names the
      // gesture rather than the machinery.
      label: label || 'Node Timeline',
      revision: compState.revision,
    });

    let receipt;
    try {
      emit({ type: 'patching', label: label || 'Node Timeline', ops, warnings });
      receipt = parseReceipt(await call(source));
    } catch (e) {
      if (e instanceof PatchError && e.detail?.retryable) {
        // Stale: the project moved between our read and our write. The ops are
        // not re-sent - they were computed against a comp that no longer exists.
        stats.staleRetries++;
        emit({ type: 'stale', expected: e.detail.expected, actual: e.detail.actual });
        return { status: 'stale' };
      }
      if (e instanceof PatchError) {
        // A patch that failed partway left the comp between two states. Roll it
        // back by re-applying the inverse; a script cannot undo its own patch.
        const rollback = rollbackCall(e.detail, { compName, compId });
        let rolledBack = false;
        if (rollback) {
          try {
            parseReceipt(await call(rollback));
            rolledBack = true;
            stats.rollbacks++;
          } catch (e2) {
            emit({ type: 'rollbackFailed', message: e2.message });
          }
        }
        // The baseline is worthless either way: we no longer know what the comp
        // holds. The next pass takes a fresh read.
        guard.forget();
        emit({ type: 'failed', message: e.message, detail: e.detail, rolledBack });
        return { status: 'failed', rolledBack, error: e };
      }
      throw e;
    }

    stats.patches++;
    stats.undoEntries++;    // one patch, one undo group, one entry. S5.
    stats.opsWritten += ops.length;

    // M4: bind native AE layer.id values back onto graph nodes so that
    // duplicate disambiguation works on the next pass.
    if (receipt.createdIds) {
      for (const [nodeId, nativeId] of Object.entries(receipt.createdIds)) {
        bindNativeId(graph, nodeId, nativeId);
      }
    }

    // Move the baseline through our own ops rather than re-reading. Where that
    // is not possible (a patch that created a layer), the baseline is dropped and
    // the next pass reads for real.
    if (!guard.advance(ops, receipt.revision)) guard.forget();

    emit({ type: 'patched', label: label || 'Node Timeline', ops, receipt, warnings });
    if (observeAfterPatch) {
      const observed = await readComp();
      const driven = desiredExpressions(graph);
      for (const layer of observed.layers) {
        const id = nodeIdFromTag(layer.comment);
        const node = graph.nodes[id];
        if (!node) continue;

        // A node the graph has just authored is INCOMPLETE: the panel can only
        // assert the transform values a user chose, and the rest - anchorPoint
        // above all - defaults from the layer's source, not from the comp. So
        // the layer After Effects actually made is what fills those in. Without
        // this, a created node carries fewer properties than the same node
        // rebuilt by hydrateFromComp, the inspector renders fewer editors for
        // it, and setNodeProperty refuses the ones it did not render.
        if (created.has(id)) {
          for (const prop of TRANSFORM_PROPS) {
            if (node.props[prop] !== undefined) continue;
            if (layer.props[prop] === undefined || driven[`${id}|${prop}`]) continue;
            node.props[prop] = layer.props[prop];
          }
          continue;
        }

        // Do not overwrite an edit made while the host was working.
        if (!parentProps.has(id) || JSON.stringify(node.props) !== parentProps.get(id)
            || node.parent !== layer.parentTag) continue;
        for (const prop of ['position', 'anchorPoint', 'scale', 'rotation']) {
          if (layer.props[prop] !== undefined && !driven[`${id}|${prop}`]) {
            node.props[prop] = layer.props[prop];
          }
        }
      }
      guard.mark(observed);
      emit({ type: 'checkpoint', compState: observed });
    }
    return { status: 'patched', receipt, ops, warnings };
  }

  // ----------------------------------------------------------------- the flush

  async function runFlush(label) {
    let attempt = 0;
    for (;;) {
      const result = await pass(label);
      if (result.status !== 'stale') return result;
      if (attempt++ >= maxStaleRetries) {
        emit({ type: 'gaveUp', after: attempt, reason: 'the project kept moving between read and write' });
        return { status: 'stale', gaveUp: true };
      }
      // Round again: a fresh read, a fresh diff. The comp moved, so the answer
      // to "what should be written" may have changed too.
    }
  }

  function schedule() {
    if (closed || gestureDepth > 0) return;
    if (timerHandle !== null) {
      // The window restarts on every mutation, which is what makes a burst of
      // them one patch instead of a patch each.
      timer.clearTimeout(timerHandle);
      stats.coalesced++;
    }
    timerHandle = timer.setTimeout(() => {
      timerHandle = null;
      void flush();
    }, debounceMs);
  }

  /**
   * Write now, if there is anything to write.
   *
   * Serialized: while a patch is in flight the call joins it, and a mutation
   * that arrived during that patch triggers one further pass afterwards.
   */
  function flush({ force = false } = {}) {
    if (closed) return Promise.resolve({ status: 'closed' });
    // Joined FIRST, before any of the early exits below. A caller that awaits
    // flush() is asking for the comp to be up to date when the promise settles;
    // returning "idle" while our own patch is still in the air would be a lie,
    // and a subtle one - it reads as a race only under load.
    if (inFlight) return inFlight.then(() => flush({ force }));
    if (gestureDepth > 0 && !force) {
      // Mid-gesture. Nothing is written; this is the rule the 99-entry stack
      // demands, not an optimisation.
      return Promise.resolve({ status: 'deferred', reason: 'a gesture is open' });
    }
    if (driftHold && !force) {
      return Promise.resolve({ status: 'held', reason: 'drift is waiting to be accepted',
                               report: driftHold });
    }
    if (!dirty && !force) return Promise.resolve({ status: 'idle' });

    if (timerHandle !== null) { timer.clearTimeout(timerHandle); timerHandle = null; }

    const label = pendingLabel;
    dirty = false;
    pendingLabel = null;
    stats.flushes++;

    inFlight = runFlush(label)
      .catch((e) => {
        // A read that cannot be trusted is not a patch that failed - nothing was
        // written. The graph stays dirty so the next pass tries again.
        dirty = true;
        guard.forget();
        const kind = e instanceof ReadError ? 'readFailed' : 'error';
        emit({ type: kind, message: e.message, detail: e.detail ?? null });
        return { status: kind, error: e };
      })
      .then((result) => {
        inFlight = null;
        // Mutations that arrived while the patch was in flight, or ops left
        // unwritten by a stale give-up, get their own pass.
        if (dirty && gestureDepth === 0 && !driftHold) schedule();
        return result;
      });

    return inFlight;
  }

  // -------------------------------------------------------------- the surface

  return {
    stats,
    guard,

    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** The graph changed. Cheap, synchronous, and safe to call per frame. */
    touch(label) {
      if (closed) return;
      stats.touches++;
      dirty = true;
      if (label && !pendingLabel) pendingLabel = label;
      schedule();
    },

    /**
     * Open a gesture. Every mutation until endGesture() lands in ONE patch, and
     * therefore in one undo entry, whatever the user sees on the way.
     * Nestable, because a compound edit may be built out of smaller ones.
     */
    beginGesture(label = 'Node Timeline edit') {
      if (closed) throw new LoopError('the loop is closed');
      if (gestureDepth === 0) {
        gestureLabel = label;
        if (timerHandle !== null) { timer.clearTimeout(timerHandle); timerHandle = null; }
      }
      gestureDepth++;
      return gestureDepth;
    },

    /** Close a gesture. The outermost one flushes. */
    endGesture() {
      if (gestureDepth === 0) throw new LoopError('endGesture without beginGesture');
      gestureDepth--;
      if (gestureDepth > 0) return Promise.resolve({ status: 'nested' });
      const label = gestureLabel;
      gestureLabel = null;
      if (!dirty) return Promise.resolve({ status: 'idle' });
      pendingLabel = label;
      return flush();
    },

    /** beginGesture/endGesture around one function, exceptions included. */
    async gesture(label, fn) {
      this.beginGesture(label);
      let closing;
      try {
        await fn();
      } finally {
        // The gesture closes whether or not the mutation finished. One left open
        // would stop the loop ever writing anything again.
        closing = this.endGesture();
      }
      // Awaited outside the finally block, so a mutation that threw still closed
      // its gesture and a mutation that did not still gets its patch awaited.
      return closing;
    },

    flush,

    /**
     * Tier 1 on its own: the 2.3 µs gate, for a caller polling while idle.
     * Reads nothing and writes nothing unless the revision actually moved.
     */
    async poll() {
      if (closed) return { status: 'closed' };
      stats.gates++;
      const revision = parseRevision(await call(revisionCall()));
      const gate = guard.gate(revision);
      if (gate.status === 'clean') return { status: 'clean', revision };

      const compState = await readComp();
      const report = guard.inspect(compState);
      if (!report.drifted) {
        // The revision moved but the comp did not: an edit elsewhere in the
        // project, or a selection. Adopt the revision so the next gate is cheap
        // again, and say nothing to the panel.
        guard.mark(compState);
        emit({ type: 'observed', report, compState });
        return { status: 'spurious', revision, report };
      }
      stats.drifts++;
      if (report.blocking.length > 0 && guard.onDrift === 'refuse') {
        stats.refusals++;
        driftHold = report;
      }
      emit({ type: 'drift', verdict: report.verdict, report, compState });
      return { status: 'drifted', revision, report };
    },

    /** What stopped the loop, or null. */
    get held() { return driftHold; },

    /**
     * The user has seen the drift and wants to go on. The comp as it stands
     * becomes the baseline, and whatever the graph still wants is written over it.
     */
    acceptDrift() {
      driftHold = null;
      guard.forget();
      dirty = true;
      return flush();
    },

    /** The user wants the comp as it stands, and the graph's pending changes gone. */
    discardPending() {
      driftHold = null;
      dirty = false;
      pendingLabel = null;
      if (timerHandle !== null) { timer.clearTimeout(timerHandle); timerHandle = null; }
    },

    /** Adopt a comp state after the panel has explicitly reconciled it. */
    adoptCompState(compState) {
      driftHold = null;
      dirty = false;
      pendingLabel = null;
      if (timerHandle !== null) { timer.clearTimeout(timerHandle); timerHandle = null; }
      return guard.mark(compState);
    },

    get state() {
      return { dirty, gestureDepth, gestureLabel, inFlight: inFlight !== null,
               held: driftHold !== null, closed };
    },

    close() {
      closed = true;
      if (timerHandle !== null) { timer.clearTimeout(timerHandle); timerHandle = null; }
      listeners.clear();
      return inFlight ?? Promise.resolve({ status: 'closed' });
    },
  };
}
