// A fake browser-session transport for the write-net tests: its answers come from a responder, and the test delivers browser
// events with emit().

/** A transport whose answers come from `responder`; the test delivers events with emit(). */
export function fakeTransport(responder = () => ({})) {
  const calls = [];
  let listener = null;
  return {
    calls,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      return responder(method, params, sessionId, this);
    },
    onEvent(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    emit(message) {
      listener?.(message);
    },
    get listening() {
      return listener !== null;
    },
    named(method) {
      return calls.filter((call) => call.method === method);
    },
    async close() {
      // The fake holds no socket to release.
    },
  };
}
