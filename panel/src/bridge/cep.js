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

const NO_HOST = 'CEP Not Found';

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

export function createHost() {
  const cs = typeof window !== 'undefined' && window.CSInterface
    ? new window.CSInterface()
    : null;

  const connected = Boolean(cs && typeof window.__adobe_cep__ !== 'undefined');
  const dispatch = (source) => {
    if (!connected) return Promise.resolve(`${NO_HOST}: ${source}`);
    return new Promise((resolve) => {
      cs.evalScript(source, (reply) => resolve(typeof reply === 'string' ? reply : String(reply)));
    });
  };
  const evalScript = serializeEvalScript(dispatch);

  return {
    connected,
    env: cs ? cs.getHostEnvironment() : null,

    evalScript(source) {
      return evalScript(source);
    },
  };
}

// Whether a reply is the shape of "no host", as opposed to something the host
// said. Kept next to the bridge because the two strings are its business.
export const isHostMissing = (reply) =>
  typeof reply === 'string' && (reply.startsWith(NO_HOST) || reply === 'EvalScript error.');
