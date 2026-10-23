/** Install a browser-only custom command executor. Source and results never cross
 * the inspector binding or enter agent metadata. Execution requires explicit Run.
 */
export function installModelDrivenCommands({ origin, token }) {
  const host = (document.getElementById('paqvilo-panel') ?? document.getElementById('paqvilo-model-inspector'));
  const live = () => location.origin === origin && host?.isConnected && host.__paqModelInspector?.token === token && !window.__paqviloRetiredModelInspectors?.includes(token);
  if (!live() || host.__paqModelCommands?.token === token) return;
  host.__paqModelCommands?.dispose();
  let disposed = false;
  const pending = new Map();
  const target = () => { const read = callback => { try { return callback(); } catch { return undefined; } }; return JSON.stringify([location.href, read(() => window.Xrm?.Page?.data?.entity?.getId()), read(() => window.Xrm?.Page?.ui?.formSelector?.getCurrentItem()?.getId())]); };
  const cancelPending = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); clearInterval(entry.targetTimer); entry.controller.abort(); } pending.clear(); };
  const deliver = (requestId, result) => { if (!disposed && live() && host.__paqModelActions?.token === token) host.__paqModelActions.receive(requestId, result); };
  const summary = value => {
    try { return (typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, 2))?.slice(0, 32000) ?? String(value); }
    catch { return '[Result cannot be serialized]'; }
  };
  const run = ({ code, timeoutMs = 30000, requestId } = {}) => {
    if (disposed || !live() || typeof code !== 'string' || !code.trim() || code.length > 65536 || typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId) || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000 || pending.has(requestId)) return { accepted: false, requestId };
    const controller = new AbortController(), route = target();
    const entry = { controller, timer: undefined, targetTimer: undefined }; pending.set(requestId, entry);
    const finish = result => {
      if (pending.get(requestId) !== entry) return;
      pending.delete(requestId); clearTimeout(entry.timer); clearInterval(entry.targetTimer);
      if (target() !== route) return;
      deliver(requestId, result);
    };
    entry.timer = setTimeout(() => {
      controller.abort();
      finish({ status: 'error', title: 'Command wait expired', message: 'Lense stopped waiting and signalled abort. JavaScript or requests that ignore the signal may still be running. Reload the app to stop remaining page code.' });
    }, timeoutMs);
    entry.targetTimer = setInterval(() => {
      if (!live() || disposed) { cancelPending(); return; }
      if (target() === route) return;
      controller.abort(); pending.delete(requestId); clearTimeout(entry.timer); clearInterval(entry.targetTimer);
      deliver(requestId, { status: 'cancelled', title: 'Command target changed', message: 'The native record or form changed. Lense stopped waiting and signalled abort. Code that ignores the signal may continue.' });
    }, 250);
    Promise.resolve().then(async () => {
      if (disposed || !live() || target() !== route) throw Error('The app changed before this command could run.');
      // This is a user-authored developer command, never an action received from
      // the agent API, imported automatically, or used for built-in operations.
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return await new AsyncFunction('Xrm', 'signal', '"use strict";\n' + code)(window.Xrm, controller.signal);
    }).then(value => finish({ status: 'ok', title: 'Command completed', message: summary(value) }), error => finish({ status: 'error', title: 'Command failed', message: String(error?.message ?? error).slice(0, 4000) }));
    return { accepted: true, requestId };
  };
  Object.defineProperty(host, '__paqModelCommands', { configurable: true, value: { token, run, cancelPending, dispose() { disposed = true; cancelPending(); } } });
}
