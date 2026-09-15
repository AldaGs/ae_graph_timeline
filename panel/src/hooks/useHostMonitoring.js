import { useEffect } from 'react';
import { activeCompCall, parseActiveComp, classifyActiveComp } from '../../../src/reader.js';
import { isHostUnavailableReply } from '../bridge/cep.js';

// Observation never authorizes writes to a different active composition.
export function useHostMonitoring({ host, startup, loopRef, activeCompRef, loopEventsRef, inspectRef, setLink, setSelected, setContextMenu, setStartup }) {
  // M4.4 groundwork: observe AE while ready. The loop's revision gate makes an
  // unchanged poll cheap, and the CEP bridge serializes it with writes.
  useEffect(() => {
    if (!host.connected || startup.state !== 'ready') return;
    let cancelled = false;
    let polling = false;
    let failures = 0;
    let retryAfter = 0;
    const poll = async () => {
      const state = loopRef.current?.state;
      if (cancelled || polling || document.hidden || Date.now() < retryAfter
          || host.busy
          || !loopRef.current || state?.inFlight || state?.gestureDepth > 0) return;
      polling = true;
      try {
        await loopRef.current.poll();
        failures = 0;
        retryAfter = 0;
      } catch (e) {
        failures++;
        retryAfter = Date.now() + Math.min(8000, 750 * (2 ** failures));
        // A reply the host never ran has already closed the bridge's gate, and
        // it is not a drift problem to report: it is After Effects saying "not
        // now", most often because a modal dialog is up. Reporting it as an
        // error would say nothing the user can act on.
        if (!cancelled && !host.suspended) {
          setLink({ state: 'error', detail: `Could not observe AE changes: ${e.message}` });
        }
      }
      finally { polling = false; }
    };
    const handle = window.setInterval(() => void poll(), 750);
    return () => { cancelled = true; window.clearInterval(handle); };
  }, [host, startup.state, loopRef, setLink]);

  // The bridge suspends itself on the host's quit event and on a reply the host
  // never ran. Say so, and stop the write loop: a patch held in the debounce
  // when After Effects started closing has nowhere to land.
  useEffect(() => {
    if (!host.connected) return;
    return host.onSuspendChange(({ suspended, reason }) => {
      if (!suspended) {
        setLink({ state: 'live', detail: 'Synchronization resumed' });
        return;
      }
      loopRef.current?.discardPending();
      setLink({ state: 'paused', detail: reason });
    });
  }, [host, loopRef, setLink]);

  // The active comp can change without app.project.revision moving. Keep this
  // identity watch separate from drift polling so a delete, close, switch, or
  // duplicate can never redirect a write intended for another comp.
  useEffect(() => {
    if (!host.connected) return;
    let cancelled = false;
    let checking = false;
    let transientFailures = 0;

    const checkActiveComp = async () => {
      const loopState = loopRef.current?.state;
      if (cancelled || checking || !activeCompRef.current || host.busy
          || loopState?.inFlight || loopState?.gestureDepth > 0) return;
      checking = true;
      try {
        const reply = await host.evalScript(activeCompCall());
        // Same rule as the drift poll: a reply the host never ran means stop
        // calling, not "the composition is gone". The bridge has already
        // suspended itself; the only thing left is to not act on the reply.
        if (isHostUnavailableReply(reply)) return;
        const active = parseActiveComp(reply);
        if (cancelled) return;
        if (transientFailures > 0) {
          transientFailures = 0;
          setLink({ state: 'live', detail: 'Active composition verified' });
        }
        const expected = activeCompRef.current;
        const identity = classifyActiveComp(expected, active);
        if (identity.status === 'missing' || identity.status === 'changed') {
          loopEventsRef.current?.();
          loopEventsRef.current = null;
          await loopRef.current?.close();
          loopRef.current = null;
          activeCompRef.current = null;
          setSelected(null);
          setContextMenu(null);
          setStartup({
            state: identity.status === 'changed' ? 'comp-changed' : 'no-comp',
            detail: identity.status === 'changed'
              ? `Active composition changed from “${expected.compName}” to “${active.compName}”. Writes are paused until you inspect the new comp.`
              : `“${expected.compName}” was closed or deleted. The in-memory graph is retained read-only.`,
          });
          if (identity.status === 'missing') {
            // Re-enter the existing no-comp retry path so a comp opened after a
            // deletion is detected without reopening the extension.
            window.setTimeout(() => void inspectRef.current?.(), 1000);
          }
        }
      } catch (e) {
        if (!cancelled) {
          transientFailures++;
          // An empty CEP callback can occur transiently while AE is completing
          // another host operation. The comp-id guard on every patch still
          // prevents writes to the wrong comp, so do not turn one missed health
          // check into a fatal/read-only startup state.
          if (transientFailures >= 3) {
            setLink({ state: 'error', detail: `Active composition check failed ${transientFailures} times: ${e.message}` });
          }
        }
      } finally {
        checking = false;
      }
    };

    const handle = window.setInterval(() => void checkActiveComp(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [host, loopRef, activeCompRef, loopEventsRef, inspectRef, setLink, setSelected, setContextMenu, setStartup]);

}
