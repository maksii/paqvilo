// The out-of-process frames of a tab, instrumented before their documents run.
//
// A frame that runs in another renderer process than its parent (site isolation: a cross-site frame, and a portal page
// nested inside one) is a DevTools target of its own: the tab's session neither intercepts its requests nor installs
// scripts in it. `Target.setAutoAttach` with `waitForDebuggerOnStart` on the tab's own session attaches this client to
// each such target as it is created and holds it before it runs anything; the target waits for every client that asked
// for the pause (Playwright's own session included) until each sends `Runtime.runIfWaitingForDebugger`. Lense sets up
// that target (interception, provenance) while it waits, then lets it run, and asks the same of the target's own
// children, recursively.
//
// Playwright's CDP session cannot address a flattened child session, so the child sessions are non-flat: commands go
// through `Target.sendMessageToTarget` of the parent session and answers and events come back as
// `Target.receivedMessageFromTarget`. A child session behaves like the tab's (`send`, `on`, `off`, `detach`), so the
// interception and provenance code runs on it unchanged.

const CHILD_COMMAND_HANG_MS = 30_000;

/** A non-flat DevTools session of a child target, reached through `parent` (a CDP session or another child). */
function childSession(parent, sessionId, { clock = globalThis } = {}) {
  const listeners = new Map();
  const pending = new Map();
  let next = 0,
    closed = false;
  const emit = (method, params) => {
    // A copy: a listener may remove itself (once) while the others run.
    for (const listener of Array.from(listeners.get(method) ?? [])) {
      try {
        listener(params);
      } catch {
        /* A listener's failure is its own; other listeners still run. */
      }
    }
  };
  const received = ({ sessionId: from, message }) => {
    if (from !== sessionId || closed) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data.id !== undefined) {
      const waiting = pending.get(data.id);
      if (!waiting) return;
      pending.delete(data.id);
      clock.clearTimeout(waiting.timer);
      if (data.error)
        waiting.reject(Object.assign(new Error(data.error.message ?? 'Protocol error'), { data: data.error }));
      else waiting.resolve(data.result ?? {});
      return;
    }
    if (typeof data.method === 'string') emit(data.method, data.params ?? {});
  };
  const ended = ({ sessionId: from }) => {
    if (from === sessionId) close('The frame target was detached');
  };
  const close = (reason) => {
    if (closed) return;
    closed = true;
    parent.off('Target.receivedMessageFromTarget', received);
    parent.off('Target.detachedFromTarget', ended);
    for (const waiting of pending.values()) {
      clock.clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
    pending.clear();
    emit('paqvilo.closed', {});
    listeners.clear();
  };
  parent.on('Target.receivedMessageFromTarget', received);
  parent.on('Target.detachedFromTarget', ended);
  return {
    sessionId,
    get closed() {
      return closed;
    },
    send(method, params = {}) {
      if (closed) return Promise.reject(new Error('The frame target was detached'));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} did not answer within ${CHILD_COMMAND_HANG_MS} ms`));
        }, CHILD_COMMAND_HANG_MS);
        pending.set(id, { resolve, reject, timer });
        parent
          .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
          .catch((error) => {
            if (!pending.has(id)) return;
            pending.delete(id);
            clock.clearTimeout(timer);
            reject(error);
          });
      });
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
      return this;
    },
    off(method, listener) {
      listeners.get(method)?.delete(listener);
      return this;
    },
    once(method, listener) {
      const once = (params) => {
        this.off(method, once);
        listener(params);
      };
      return this.on(method, once);
    },
    async detach() {
      if (closed) return;
      await parent.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      close('The frame target session was detached');
    },
  };
}

/**
 * Attaches to each out-of-process frame target below `session` (the tab's session or a child) and holds it until
 * `instrument(child, targetInfo)` settled, then lets it run; the same is asked of each child, recursively, by
 * `instrument` calling this function on it. Returns a function that stops watching.
 * @param {object} session a CDP session (send, on, off)
 * @param {(child: object, targetInfo: object) => Promise<void>} instrument
 */
export async function watchFrameTargets(session, instrument, { clock = globalThis, onError = () => {} } = {}) {
  const attached = async ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo?.type !== 'iframe') {
      // Not a frame (a worker): it is not Lense's. It runs as it would, and this client leaves it.
      const other = childSession(session, sessionId, { clock });
      if (waitingForDebugger) await other.send('Runtime.runIfWaitingForDebugger').catch(() => {});
      await other.detach();
      return;
    }
    const child = childSession(session, sessionId, { clock });
    try {
      await instrument(child, targetInfo);
    } catch (error) {
      onError(error);
    } finally {
      // Whatever the setup did, the frame is never left paused.
      if (waitingForDebugger) await child.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  };
  const listener = (event) => {
    attached(event).catch(() => {});
  };
  session.on('Target.attachedToTarget', listener);
  await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  return async () => {
    session.off('Target.attachedToTarget', listener);
    await session
      .send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false })
      .catch(() => {});
  };
}
