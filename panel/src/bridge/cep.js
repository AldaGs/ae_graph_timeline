// The CEP bridge, in exactly the shape src/loop.js already expects.
//
// P1.5 takes a host as `{ evalScript(source) -> Promise<string> }` and was
// tested offline against a fake with that interface, so wiring the reconciler in
// M3 is a matter of handing it this object. Nothing here knows what the calls
// mean; it moves strings.
//
// evalScript does NOT reject. A host-side throw comes back as the string
// "EvalScript error.", and no host at all comes back as the shim's simulated
// reply - both of which the panel's parsers already refuse as not-JSON. Turning
// either into a rejection here would just move the same failure somewhere the
// loop handles it less well.
//
// M4.8: the bridge also owns a SUSPENSION gate. After Effects refuses to run any
// script while a modal dialog is waiting - including its own "Save changes?" on
// quit - and it reports that refusal by putting up an alert of its own:
//
//     Unable to execute script at line 0. After Effects error: Cannot run a
//     script while a modal dialog is waiting for response.
//
// The panel polls twice a second, so a quit produced one of those alerts per
// poll. There is no API to ask whether a modal is open, so the gate is driven
// from the two things that CAN be known: CEP's ApplicationBeforeQuit event, and
// a host call that came back unusable. Both stop the calls at the source, which
// is the only place they can be stopped.

const NO_HOST = 'CEP Not Found';
const SUSPENDED = 'Host Suspended';

export const HOST_BUSY = 'After Effects is busy (a dialog may be open) — synchronization paused.';

// How long the bridge stays quiet after a host call came back unusable. Long
// enough that a modal dialog the user is actually reading produces one complaint
// rather than a stream of them; short enough that a transient miss costs one
// observation.
export const HOST_QUIET_MS = 5000;

// CEP's host lifecycle events. The first is the documented one; the bare name is
// listened for too, because it costs nothing and CEP's event naming has varied.
const QUIT_EVENTS = [
  'com.adobe.csxs.events.ApplicationBeforeQuit',
  'applicationBeforeQuit',
];

// CEP does not guarantee useful replies when multiple evalScript calls overlap.
// Keep one transport lane for startup reads, sync patches, pings, and identity
// checks. A failed request is isolated so it cannot poison every later call.
export function serializeEvalScript(dispatch) {
  let tail = Promise.resolve();
  return (source) => {
    const request = tail.then(() => dispatch(source));
    tail = request.catch(() => undefined);
    return request;
  };
}

// Whether a reply means "the host did not run this", as opposed to something the
// host said. A modal dialog blocking the script presents exactly this way: the
// callback fires with the error string, or with nothing at all.
export const isHostUnavailableReply = (reply) =>
  typeof reply !== 'string' || reply.length === 0
  || reply.startsWith(NO_HOST) || reply.startsWith(SUSPENDED)
  || reply === 'EvalScript error.';

export function createHost() {
  const cs = typeof window !== 'undefined' && window.CSInterface
    ? new window.CSInterface()
    : null;

  const connected = Boolean(cs && typeof window.__adobe_cep__ !== 'undefined');

  // null = running. A number is a deadline; Infinity is "not coming back",
  // which is what a host quit means.
  let suspendedUntil = null;
  let suspendReason = '';
  // A modal host call the PANEL asked for (AE's own New Composition dialog).
  // Unlike a suspension it does not close the transport - the dialog call itself
  // has to get through - but nothing should poll behind it, or the queue fills
  // with observations of a state the user has not finished choosing yet.
  let modalDepth = 0;
  const watchers = new Set();

  const notify = () => {
    for (const fn of watchers) {
      try { fn({ suspended: host.suspended, reason: suspendReason }); } catch { /* not ours */ }
    }
  };

  const dispatch = (source) => {
    if (!connected) return Promise.resolve(`${NO_HOST}: ${source}`);
    // Checked HERE rather than only in the callers: the gate has to hold for
    // every path into the host, including a call already queued behind another
    // when the quit arrived.
    if (host.suspended) return Promise.resolve(`${SUSPENDED}: ${suspendReason}`);
    return new Promise((resolve) => {
      cs.evalScript(source, (reply) => {
        const text = typeof reply === 'string' ? reply : String(reply);
        // The bridge is the one place that sees every reply, so it is where a
        // reply the host never ran is noticed. A modal dialog presents exactly
        // this way, and each further call while it is open makes After Effects
        // raise an error alert of its own - so the gate closes here, before the
        // next poll can reach the host.
        if (isHostUnavailableReply(text)) {
          host.suspend(HOST_BUSY, HOST_QUIET_MS);
        }
        resolve(text);
      });
    });
  };
  const evalScript = serializeEvalScript(dispatch);

  const host = {
    connected,
    env: cs ? cs.getHostEnvironment() : null,

    evalScript(source) {
      return evalScript(source);
    },

    /** True while no call may be sent to After Effects. */
    get suspended() {
      if (suspendedUntil === null) return false;
      if (suspendedUntil === Infinity) return true;
      if (Date.now() < suspendedUntil) return true;
      suspendedUntil = null;
      suspendReason = '';
      return false;
    },

    get suspendReason() { return suspendReason; },

    /** Suspended, or holding a modal host call. What a poller should check. */
    get busy() { return host.suspended || modalDepth > 0; },

    beginModal() { modalDepth++; },
    endModal() { modalDepth = Math.max(0, modalDepth - 1); },

    /**
     * Stop talking to After Effects.
     *
     * @param reason  shown to the user, so say what is holding the host
     * @param ms      how long to wait; omit for "until the panel is reloaded",
     *                which is the right answer for a host that is quitting
     */
    suspend(reason, ms) {
      const until = ms === undefined ? Infinity : Date.now() + ms;
      // Never shorten an existing suspension: a quit must not be downgraded to
      // a five-second backoff by a poll that failed on the way out.
      if (suspendedUntil === Infinity) return;
      if (suspendedUntil !== null && until <= suspendedUntil) return;
      suspendedUntil = until;
      suspendReason = reason;
      notify();
    },

    resume() {
      if (suspendedUntil === Infinity) return false;
      suspendedUntil = null;
      suspendReason = '';
      notify();
      return true;
    },

    /** Called on every change of the gate, so the panel can say why it stopped. */
    onSuspendChange(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };

  if (connected && typeof cs.addEventListener === 'function') {
    const onQuit = () => host.suspend('After Effects is closing — synchronization stopped.');
    for (const type of QUIT_EVENTS) {
      try { cs.addEventListener(type, onQuit); } catch { /* an event this host does not have */ }
    }
  }

  if (typeof window !== 'undefined') {
    // The panel itself going away. Whatever is in flight is the last thing that
    // should reach the host; a poll firing during teardown cannot be useful.
    window.addEventListener('beforeunload', () =>
      host.suspend('The panel is closing — synchronization stopped.'));
  }

  return host;
}

// Whether a reply is the shape of "no host", as opposed to something the host
// said. Kept next to the bridge because the two strings are its business.
export const isHostMissing = (reply) =>
  typeof reply === 'string' && (reply.startsWith(NO_HOST) || reply === 'EvalScript error.');
