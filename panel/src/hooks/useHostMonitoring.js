import { useEffect } from 'react';
import { activeCompCall, parseActiveComp, classifyActiveComp } from '../../../src/reader.js';

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
          || !loopRef.current || state?.inFlight || state?.gestureDepth > 0) return;
      polling = true;
      try {
        await loopRef.current.poll();
        failures = 0;
        retryAfter = 0;
      } catch (e) {
        failures++;
        retryAfter = Date.now() + Math.min(8000, 750 * (2 ** failures));
        if (!cancelled) setLink({ state: 'error', detail: `Could not observe AE changes: ${e.message}` });
      }
      finally { polling = false; }
    };
    const handle = window.setInterval(() => void poll(), 750);
    return () => { cancelled = true; window.clearInterval(handle); };
  }, [host, startup.state]);

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
      if (cancelled || checking || !activeCompRef.current
          || loopState?.inFlight || loopState?.gestureDepth > 0) return;
      checking = true;
      try {
        const active = parseActiveComp(await host.evalScript(activeCompCall()));
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
  }, [host]);

}
