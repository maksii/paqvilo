import { randomUUID } from 'node:crypto';

/** Observe committed Chromium documents without treating hash/history changes as replacement.
 * `document` labels early requests; optional `ready` also requires the CDP identity and loader baseline. */
export async function observeDocumentCommits(page, cdp, { document, commit, ready }) {
  const suffix = randomUUID().replaceAll('-', '');
  const browserBinding = '__paqviloDocumentCdp' + suffix;
  const frameBinding = '__paqviloDocumentFrame' + suffix;
  const reportBinding = '__paqviloDocumentReport' + suffix;
  const pairs = new Map(),
    documents = new Map(),
    loaders = new Map(),
    sessions = new Map(),
    attaching = new Set(),
    retrying = new Set();
  let disposed = false;
  const validToken = (token) => typeof token === 'string' && /^[0-9a-f]{1,8}(?:-[0-9a-f]{1,8}){3}$/.test(token);
  const pairFor = (token) => {
    if (!validToken(token)) return null;
    if (!pairs.has(token) && pairs.size >= 2048) pairs.delete(pairs.keys().next().value);
    return pairs.get(token) ?? {};
  };
  const join = (token) => {
    const pair = pairs.get(token),
      record = sessions.get(pair?.session);
    if (!pair?.frame || !pair.frameId || !record?.initialized || !record.loaders.get(pair.frameId)) return;
    const previous = documents.get(pair.frameId);
    if (previous?.token !== token) documents.set(pair.frameId, { frame: pair.frame, token });
    pairs.delete(token);
    if (previous?.token !== token) ready?.(pair.frame, token);
  };
  const joinSession = (session, frameId) => {
    for (const [token, pair] of pairs)
      if (pair.session === session && (!frameId || pair.frameId === frameId)) join(token);
  };
  const navigated = (frame, session) => {
    if (disposed) return;
    sessions.get(session)?.loaders.set(frame.id, frame.loaderId);
    const previous = loaders.get(frame.id);
    loaders.set(frame.id, frame.loaderId);
    if (previous && previous !== frame.loaderId) {
      const replaced = documents.get(frame.id);
      if (replaced) commit(replaced.frame, replaced.token);
    }
    joinSession(session, frame.id);
  };
  const forgetFrame = (frameId, frame) => {
    documents.delete(frameId);
    loaders.delete(frameId);
    for (const record of sessions.values()) record.loaders.delete(frameId);
    for (const [token, pair] of pairs)
      if (pair.frameId === frameId || (frame && pair.frame === frame)) pairs.delete(token);
  };
  await page.exposeBinding(frameBinding, ({ frame }, token) => {
    if (disposed) return;
    const pair = pairFor(token);
    if (!pair) return;
    // Label early requests even while the independent CDP target is still attaching.
    document(frame, token);
    pairs.set(token, { ...pair, frame });
    join(token);
  });
  const connect = async (session, owner = null) => {
    const contexts = new Map(),
      listeners = [];
    const on = (name, handler) => {
      session.on(name, handler);
      listeners.push([name, handler]);
    };
    const record = {
      session,
      owner,
      frameId: null,
      initialized: false,
      loaders: new Map(),
      cleanup: () => {
        for (const [name, handler] of listeners) session.off(name, handler);
        contexts.clear();
        record.loaders.clear();
        for (const [token, pair] of pairs) if (pair.session === session) pairs.delete(token);
        void session.send('Runtime.removeBinding', { name: browserBinding }).catch(() => {});
      },
    };
    sessions.set(session, record);
    on('Runtime.executionContextCreated', ({ context }) => {
      if (context.auxData?.isDefault) contexts.set(context.id, context.auxData.frameId);
    });
    on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
    on('Runtime.executionContextsCleared', () => contexts.clear());
    on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
      if (name !== browserBinding || disposed) return;
      const frameId = contexts.get(executionContextId),
        pair = pairFor(payload);
      if (!frameId || !pair) return;
      pairs.set(payload, { ...pair, frameId, session });
      join(payload);
    });
    on('Page.frameNavigated', ({ frame }) => navigated(frame, session));
    on('Page.frameDetached', ({ frameId, reason }) => {
      if (reason !== 'swap') forgetFrame(frameId);
    });
    on('close', () => {
      record.cleanup();
      sessions.delete(session);
      if (owner && !disposed && !owner.isDetached()) {
        if (attaching.has(owner)) retrying.add(owner);
        else void attach(owner);
      }
    });
    try {
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      await session.send('Runtime.addBinding', { name: browserBinding });
      const { frameTree } = await session.send('Page.getFrameTree');
      record.frameId = frameTree.frame.id;
      const remember = (node) => {
        navigated(node.frame, session);
        for (const child of node.childFrames ?? []) remember(child);
      };
      remember(frameTree);
      // Keep current tokens pending until this target's own snapshot has seeded its loader.
      // A historical child entry in the parent target cannot establish OOPIF readiness.
      record.initialized = true;
      joinSession(session);
      // OOPIF attachment can follow its initialization script; repeat the identity handshake.
      if (owner) await owner.evaluate((name) => window[name]?.(), reportBinding).catch(() => {});
    } catch (cause) {
      record.cleanup();
      sessions.delete(session);
      if (owner) await session.detach().catch(() => {});
      else throw cause;
    }
  };
  const attach = async (frame) => {
    if (
      disposed ||
      frame === page.mainFrame() ||
      attaching.has(frame) ||
      [...sessions.values()].some((entry) => entry.owner === frame)
    )
      return;
    attaching.add(frame);
    try {
      const session = await page.context().newCDPSession(frame);
      if (disposed || frame.isDetached()) await session.detach().catch(() => {});
      else await connect(session, frame);
    } catch {
      /* In-process children are already observed by their parent CDP target. */
    } finally {
      attaching.delete(frame);
      if (retrying.delete(frame) && !disposed && !frame.isDetached()) void attach(frame);
    }
  };
  const detached = (frame) => {
    for (const record of sessions.values())
      if (record.owner === frame) {
        forgetFrame(record.frameId, frame);
        record.cleanup();
        sessions.delete(record.session);
        void record.session.detach().catch(() => {});
      }
    for (const [frameId, value] of documents) if (value.frame === frame) forgetFrame(frameId, frame);
    for (const [token, pair] of pairs) if (pair.frame === frame) pairs.delete(token);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    page.off('frameattached', attach);
    page.off('framenavigated', attach);
    page.off('framedetached', detached);
    page.off('close', dispose);
    for (const record of sessions.values()) {
      record.cleanup();
      if (record.owner) void record.session.detach().catch(() => {});
    }
    sessions.clear();
    attaching.clear();
    retrying.clear();
    pairs.clear();
    documents.clear();
    loaders.clear();
  };
  page.on('frameattached', attach);
  page.on('framenavigated', attach);
  page.on('framedetached', detached);
  page.on('close', dispose);
  try {
    await connect(cdp);
    await page.addInitScript(
      ({ browserBinding, frameBinding, reportBinding }) => {
        const token = [...crypto.getRandomValues(new Uint32Array(4))].map((value) => value.toString(16)).join('-');
        const report = () => {
          if (typeof window[browserBinding] === 'function') window[browserBinding](token);
          void window[frameBinding](token).catch(() => {});
        };
        Object.defineProperty(window, reportBinding, { value: report });
        report();
        window.addEventListener('pageshow', (event) => {
          if (event.persisted) report();
        });
      },
      { browserBinding, frameBinding, reportBinding },
    );
    for (const frame of page.frames()) void attach(frame);
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
