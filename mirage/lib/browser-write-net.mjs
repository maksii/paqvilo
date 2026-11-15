/**
 * Browser-session write net. Request interception on the browser session is in force for every target of the browser
 * from its first request, whichever debugging client resumes the target, so a popup, a frame or a nested popup of an
 * owned page cannot send a write before its own page session is guarded.
 *
 * Ownership follows the opener chain: a page target is owned when it is a root added by the caller, or when its
 * opener is owned; a cross-process frame belongs to the owner of its parent target; an in-process frame belongs to
 * the owned page whose frame tree contains it. A request whose owner cannot be resolved (no frame, a failed lookup) is
 * UNATTRIBUTED and its write is failed. A request of a page the net does not own is continued unchanged and not
 * reported.
 *
 * Transport: { send(method, params, sessionId?) -> Promise<result>, onEvent(listener) -> off }, where the listener
 * receives raw CDP messages { method, params, sessionId? } of the browser connection.
 */

export const UNATTRIBUTED = Object.freeze({ unattributed: true });
const ALL_REQUESTS = [{ urlPattern: '*', requestStage: 'Request' }];
const BLOCK = Object.freeze({ action: 'block', reason: 'unattributed' });
const NO_DECISION = Object.freeze({ action: 'block', reason: 'no-decision' });
const MAX_PARENT_DEPTH = 16;
const VERSION_READ_GUARD_MS = 10_000; // hang guard for the debugging endpoint's version read
const SOCKET_OPEN_GUARD_MS = 30_000; // hang guard for the debugging socket's open

const treeHasFrame = (node, frameId) =>
  node?.frame?.id === frameId || (node?.childFrames ?? []).some((child) => treeHasFrame(child, frameId));

/**
 * Opens the net on the browser session of `transport`.
 * @param {object} options
 * @param {{ send: Function, onEvent: Function }} options.transport
 * @param {(request: { method: string, url: string, headers: object, postData?: string, resourceType?: string }) => { action: 'continue' | 'block' | 'fulfil', status?: number }} options.decide
 * @param {(entry: { request: object, decision: object, owner: unknown }) => void} [options.onDecided] called for every
 *   owned or unattributed request that is not continued, before it is answered
 * @param {unknown} [options.adoptNewPages] when given, every page created after the net opened with no opener is a root
 *   owned by this value
 * @param {(targetId: string) => void} [options.onAdopted] `onAdopted(targetId)` is called for each page the net adopts as
 *   its own
 */
export async function openBrowserWriteNet({
  transport,
  decide,
  onDecided = () => {},
  adoptNewPages,
  onAdopted = () => {},
}) {
  const targets = new Map();
  const owners = new Map();
  const sessions = new Map();
  const inflight = new Set();
  let adopting = false;
  let phase = 'open';
  let closing = null;

  const send = (method, params = {}, sessionId) => transport.send(method, params, sessionId);
  const answer = (method, params) => send(method, params).catch(() => {});

  const adoptsNewPage = (info) => !info.openerId && adopting && adoptNewPages !== undefined;
  const ownerOfNewPage = (info) => {
    if (owners.has(info.openerId)) return owners.get(info.openerId);
    return adoptsNewPage(info) ? adoptNewPages : undefined;
  };
  // A report that throws never stops the page from being adopted.
  const reportAdopted = (targetId) => {
    try {
      onAdopted(targetId);
    } catch {
      // The adoption stands whatever the caller does with the report.
    }
  };
  const onTargetCreated = (info) => {
    targets.set(info.targetId, { type: info.type, openerId: info.openerId });
    if (info.type !== 'page') return;
    const owner = ownerOfNewPage(info);
    if (owner !== undefined) owners.set(info.targetId, owner);
    if (adoptsNewPage(info)) reportAdopted(info.targetId);
  };
  // A closed page stays known by its id: the browser pauses the writes its main frame sends while closing (pagehide
  // beacons) after the page target is destroyed, and they still belong to its owner, or to nobody.
  // ponytail: one small entry per page the browser ever opened; prune when a net outlives many thousands of pages.
  const onTargetDestroyed = (targetId) => {
    sessions.delete(targetId);
    const target = targets.get(targetId);
    if (target?.type === 'page') target.closed = true;
    else targets.delete(targetId);
  };

  const sessionFor = (targetId) => {
    if (!sessions.has(targetId)) {
      const attached = send('Target.attachToTarget', { targetId, flatten: true }).then((result) => result.sessionId);
      sessions.set(targetId, attached);
      attached.catch(() => sessions.delete(targetId));
    }
    return sessions.get(targetId);
  };
  const frameInTree = async (targetId, frameId) => {
    const sessionId = await sessionFor(targetId);
    const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
    return treeHasFrame(frameTree, frameId);
  };
  // The page or cross-process frame whose own frame tree contains the frame; owned pages are searched first. A lookup
  // that fails counts as not found there.
  const containerOf = async (frameId) => {
    const candidates = [...targets]
      .filter(([, info]) => !info.closed && (info.type === 'page' || info.type === 'iframe'))
      .map(([targetId]) => targetId)
      .sort((a, b) => Number(owners.has(b)) - Number(owners.has(a)));
    for (const targetId of candidates) {
      if (await frameInTree(targetId, frameId).catch(() => false)) return targetId;
    }
    return null;
  };
  // An in-process frame belongs to the owner of the target that contains it; a frame no target contains is UNATTRIBUTED.
  const ownerInFrameTrees = async (frameId, depth) => {
    const container = await containerOf(frameId);
    return container ? ownerOfFrame(container, depth + 1) : UNATTRIBUTED;
  };
  const targetInfo = (targetId) =>
    send('Target.getTargetInfo', { targetId }).then(
      (result) => result.targetInfo,
      () => null,
    );
  // Resolves the owner of the frame that sent a request: an owner, null for a page the net does not own, or UNATTRIBUTED.
  const ownerOfFrame = async (frameId, depth = 0) => {
    if (!frameId || depth > MAX_PARENT_DEPTH) return UNATTRIBUTED;
    if (owners.has(frameId)) return owners.get(frameId);
    if (targets.get(frameId)?.type === 'page') return null;
    const info = await targetInfo(frameId);
    if (!info) return ownerInFrameTrees(frameId, depth);
    if (info.parentId) return ownerOfFrame(info.parentId, depth + 1);
    return owners.get(info.openerId) ?? null;
  };
  // While closing, nothing is looked up: a page the net does not own is continued and every other write is failed.
  const ownerWhileClosing = (frameId) => {
    if (owners.has(frameId)) return owners.get(frameId);
    return targets.get(frameId)?.type === 'page' ? null : UNATTRIBUTED;
  };
  const resolveOwner = async (frameId) => {
    if (phase !== 'open') return ownerWhileClosing(frameId);
    try {
      return await ownerOfFrame(frameId);
    } catch {
      return UNATTRIBUTED;
    }
  };

  const report = (entry) => {
    try {
      onDecided(entry);
    } catch {
      // A failing report never turns a stopped write into a continued one.
    }
  };
  // A refused failRequest has no further answer; the browser then keeps the request paused until the net closes.
  const failRequest = (requestId) => answer('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  const settleOwned = async (requestId, request, decision, owner) => {
    const applied = owner === UNATTRIBUTED ? BLOCK : (decision ?? NO_DECISION);
    report({ request, decision: applied, owner });
    if (applied.action === 'fulfil')
      return send('Fetch.fulfillRequest', {
        requestId,
        responseCode: applied.status,
        responseHeaders: [{ name: 'cache-control', value: 'no-store' }],
        body: '',
      }).catch(() => failRequest(requestId));
    return failRequest(requestId);
  };
  const handlePaused = async (params) => {
    const { requestId, frameId } = params;
    const request = {
      method: params.request.method,
      url: params.request.url,
      headers: params.request.headers ?? {},
      postData: params.request.postData,
      resourceType: params.resourceType,
    };
    let decision;
    try {
      decision = decide(request);
    } catch {
      decision = BLOCK;
    }
    if (decision?.action === 'continue') return answer('Fetch.continueRequest', { requestId });
    const owner = await resolveOwner(frameId);
    if (owner === null) return answer('Fetch.continueRequest', { requestId });
    return settleOwned(requestId, request, decision, owner);
  };
  const track = (promise) => {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise)).catch(() => {});
  };
  const drain = async () => {
    while (inflight.size) await Promise.allSettled(inflight);
  };

  const listener = (message) => {
    if (message.sessionId) return;
    if (message.method === 'Target.targetCreated') onTargetCreated(message.params.targetInfo);
    else if (message.method === 'Target.targetDestroyed') onTargetDestroyed(message.params.targetId);
    else if (message.method === 'Fetch.requestPaused')
      track(handlePaused(message.params).catch(() => failRequest(message.params.requestId)));
  };
  const off = transport.onEvent(listener);
  try {
    await send('Target.setDiscoverTargets', { discover: true });
    adopting = true;
    await send('Fetch.enable', { patterns: ALL_REQUESTS });
  } catch (error) {
    off();
    await answer('Target.setDiscoverTargets', { discover: false });
    throw error;
  }

  const shutdown = async () => {
    phase = 'closing';
    // An empty pattern list stops new pauses while requests already paused stay paused, so each is answered here.
    await answer('Fetch.enable', { patterns: [] });
    await drain();
    await answer('Fetch.disable');
    off();
    await drain();
    const attached = await Promise.allSettled(sessions.values());
    const detaches = attached
      .filter((result) => result.status === 'fulfilled')
      .map((result) => answer('Target.detachFromTarget', { sessionId: result.value }));
    await Promise.all(detaches);
    await answer('Target.setDiscoverTargets', { discover: false });
    phase = 'closed';
  };

  return {
    /** Makes `targetId` (a page target) a root owned by `owner`; popups it opens are owned by the same owner. */
    addRoot(targetId, owner) {
      owners.set(targetId, owner);
    },
    /** The owner the net resolves for `frameId` now (null: not owned; UNATTRIBUTED: unresolvable). */
    ownerOf: (frameId) => resolveOwner(frameId),
    /** Disables the net. Requests paused when it closes are answered first: continued when foreign, otherwise failed. */
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}

/**
 * A transport over a raw CDP WebSocket to a loopback browser endpoint (`http://127.0.0.1:PORT` or its `ws://` URL).
 * Every pending call is rejected when the socket closes; close() closes the socket and waits for its close event.
 */
export async function connectCdpTransport(endpoint, { WebSocketImpl = globalThis.WebSocket, fetchImpl = fetch } = {}) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('The browser debugging endpoint must be loopback without credentials.');
  let socketUrl = url.href;
  if (url.protocol === 'http:') {
    const version = await fetchImpl(new URL('/json/version', url), {
      signal: AbortSignal.timeout(VERSION_READ_GUARD_MS),
    });
    socketUrl = (await version.json()).webSocketDebuggerUrl;
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(socketUrl).hostname))
    throw new Error('The browser debugging socket must be loopback.');
  const socket = new WebSocketImpl(socketUrl);
  const opened = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const pending = new Map();
  const listeners = new Set();
  const closedError = () => new Error('The browser debugging socket closed.');
  // The guard starts with the socket and ends at open, error or close; a socket that never opens is closed.
  const openGuard = setTimeout(() => {
    opened.reject(new Error('The browser debugging socket did not open.'));
    socket.close();
  }, SOCKET_OPEN_GUARD_MS);
  let nextId = 0;
  let socketClosed = false;
  socket.addEventListener('open', () => {
    clearTimeout(openGuard);
    opened.resolve();
  });
  socket.addEventListener('error', () => {
    clearTimeout(openGuard);
    opened.reject(new Error('Could not open the browser debugging socket.'));
  });
  socket.addEventListener('close', () => {
    clearTimeout(openGuard);
    socketClosed = true;
    for (const { reject } of pending.values()) reject(closedError());
    pending.clear();
    opened.reject(closedError());
    closed.resolve();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const call = message.id === undefined ? undefined : pending.get(message.id);
    if (!call) {
      // A snapshot: a listener that subscribes or unsubscribes during a dispatch does not change who receives this message.
      for (const listener of Array.from(listeners)) listener(message);
      return;
    }
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  });
  await opened.promise;
  return {
    send(method, params = {}, sessionId) {
      if (socketClosed) return Promise.reject(closedError());
      nextId += 1;
      const id = nextId;
      const call = Promise.withResolvers();
      pending.set(id, call);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return call.promise;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (socket.readyState !== WebSocketImpl.CLOSED) socket.close();
      await closed.promise;
    },
  };
}
