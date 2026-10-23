import { randomBytes } from "node:crypto";

function install({ origin, channel, stateName, names, maxBytes }) {
  if (
    window !== window.top ||
    location.origin !== origin ||
    globalThis[stateName]
  )
    return;
  if (
    names.some((name) => Object.prototype.hasOwnProperty.call(globalThis, name))
  )
    throw Error("An owned page API name is already present.");
  let sequence = 0;
  const pending = new Map();
  const state = {
    deliver(packet) {
      const entry = pending.get(packet.id);
      if (!entry) return;
      pending.delete(packet.id);
      clearTimeout(entry.timer);
      if (packet.expiresAt < Date.now()) {
        entry.reject(Error("The owned page reply expired."));
        return;
      }
      packet.failed
        ? entry.reject(Error("The owned page request failed."))
        : entry.resolve(packet.value);
    },
    dispose() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Error("The owned page connection closed."));
      }
      pending.clear();
      for (const name of names)
        if (globalThis[name]?.ownedChannel === channel) delete globalThis[name];
      delete globalThis[stateName];
      delete globalThis[channel];
    },
  };
  Object.defineProperty(globalThis, stateName, {
    value: state,
    configurable: true,
  });
  for (const name of names) {
    const fn = (...args) =>
      new Promise((resolve, reject) => {
        if (location.origin !== origin)
          return reject(Error("The owned page changed origin."));
        let body;
        const id = ++sequence;
        try {
          body = JSON.stringify({ id, name, args });
        } catch {
          return reject(Error("The owned page request is not JSON."));
        }
        if (new TextEncoder().encode(body).length > maxBytes)
          return reject(Error("The owned page request is too large."));
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("The owned page request timed out."));
        }, 20000);
        pending.set(id, { resolve, reject, timer });
        try {
          globalThis[channel](body);
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(Error("The owned page connection is unavailable."));
        }
      });
    Object.defineProperty(fn, "ownedChannel", { value: channel });
    Object.defineProperty(globalThis, name, { value: fn, configurable: true });
  }
}

/** Isolated from Playwright's shared exposed-binding dispatcher during CDP attachment. */
export async function createOwnedPageBindings(
  page,
  {
    origin,
    bindings,
    maxBytes = 65536,
    maxResultBytes = 16 * 1024 * 1024,
    callTimeout = 18000,
  },
) {
  const expected = new URL(origin).origin;
  const entries = Object.entries(bindings);
  if (
    entries.some(
      ([name, callback]) =>
        !/^[A-Za-z_$][\w$]{0,100}$/.test(name) ||
        typeof callback !== "function",
    )
  )
    throw Error("Invalid owned page binding.");
  const suffix = randomBytes(16).toString("hex");
  const channel = "__paqviloOwned_" + suffix,
    stateName = "__paqviloOwnedState_" + suffix;
  const session = await page.context().newCDPSession(page);
  const contexts = new Map(),
    callbacks = new Map(entries);
  const pendingCalls = new Set();
  let mainFrame,
    script,
    closed = false,
    inFlight = 0;
  const contextsCreated = ({ context }) => contexts.set(context.id, context);
  const contextsDestroyed = ({ executionContextId }) =>
    contexts.delete(executionContextId);
  const cleared = () => contexts.clear();
  const navigated = ({ frame }) => {
    if (!frame.parentId) mainFrame = frame.id;
  };
  const reply = async (context, packet) => {
    if (closed || contexts.get(context.id) !== context) return;
    try {
      if (Buffer.byteLength(JSON.stringify(packet)) > maxResultBytes)
        packet = { id: packet.id, failed: true };
    } catch {
      packet = { id: packet.id, failed: true };
    }
    await bounded(
      () =>
        session.send("Runtime.callFunctionOn", {
          executionContextId: context.id,
          functionDeclaration:
            "function(key,packet){globalThis[key]?.deliver(packet)}",
          arguments: [
            { value: stateName },
            { value: { ...packet, expiresAt: Date.now() + 1500 } },
          ],
          returnByValue: true,
        }),
      1500,
    ).catch(() => {});
  };
  const called = async (event) => {
    if (
      event.name !== channel ||
      closed ||
      Buffer.byteLength(event.payload) > maxBytes
    )
      return;
    const context = contexts.get(event.executionContextId);
    if (
      !context?.auxData?.isDefault ||
      context.auxData.frameId !== mainFrame ||
      context.origin !== expected
    )
      return;
    let packet;
    try {
      packet = JSON.parse(event.payload);
    } catch {
      return;
    }
    if (
      !Number.isSafeInteger(packet.id) ||
      packet.id < 1 ||
      !Array.isArray(packet.args) ||
      !callbacks.has(packet.name)
    )
      return;
    if (inFlight >= 32) return reply(context, { id: packet.id, failed: true });
    inFlight++;
    try {
      let timer, cancel;
      const deadline = new Promise((_, reject) => {
        cancel = () => reject(Error("Owned page call ended."));
        timer = setTimeout(cancel, callTimeout);
      });
      pendingCalls.add(cancel);
      let value;
      try {
        value = await Promise.race([
          Promise.resolve().then(() =>
            callbacks.get(packet.name)(
              { page, frame: page.mainFrame(), context: page.context() },
              ...packet.args,
            ),
          ),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
        pendingCalls.delete(cancel);
      }
      await reply(context, { id: packet.id, value });
    } catch {
      await reply(context, { id: packet.id, failed: true });
    } finally {
      inFlight--;
    }
  };
  session.on("Runtime.executionContextCreated", contextsCreated);
  session.on("Runtime.executionContextDestroyed", contextsDestroyed);
  session.on("Runtime.executionContextsCleared", cleared);
  session.on("Page.frameNavigated", navigated);
  session.on("Runtime.bindingCalled", called);
  const bounded = (operation, timeout = 500) => {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Error("Owned page cleanup timed out.")),
        timeout,
      );
    });
    return Promise.race([Promise.resolve().then(operation), deadline]).finally(
      () => clearTimeout(timer),
    );
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    session.off("Runtime.bindingCalled", called);
    session.off("Runtime.executionContextCreated", contextsCreated);
    session.off("Runtime.executionContextDestroyed", contextsDestroyed);
    session.off("Runtime.executionContextsCleared", cleared);
    session.off("Page.frameNavigated", navigated);
    for (const cancel of pendingCalls) cancel();
    if (page.isClosed()) {
      contexts.clear();
      return;
    }
    const failures = [];
    const drain = async (operation) => {
      try {
        await bounded(operation);
      } catch (error) {
        failures.push(error);
      }
    };
    if (!page.isClosed()) {
      if (script)
        await drain(async () => {
          try {
            await session.send("Page.removeScriptToEvaluateOnNewDocument", {
              identifier: script,
            });
          } catch (error) {
            // Chromium can retire this session's script ID during an origin change.
            // This exact response confirms the owned script is already absent.
            if (
              !String(error.message).endsWith(
                "Protocol error (Page.removeScriptToEvaluateOnNewDocument): Script not found",
              )
            )
              throw error;
          }
        });
      await drain(async () => {
        const response = await session.send("Runtime.evaluate", {
          expression: `globalThis[${JSON.stringify(stateName)}]?.dispose();delete globalThis[${JSON.stringify(channel)}]`,
        });
        if (response.exceptionDetails)
          throw Error("Owned page wrapper cleanup failed.");
      });
      await drain(() =>
        session.send("Runtime.removeBinding", { name: channel }),
      );
    }
    contexts.clear();
    await drain(() => session.detach());
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Owned page binding cleanup failed.");
  };
  try {
    await session.send("Page.enable");
    mainFrame = (await session.send("Page.getFrameTree")).frameTree.frame.id;
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", { name: channel });
    const source = `(${install.toString()})(${JSON.stringify({ origin: expected, channel, stateName, names: entries.map(([name]) => name), maxBytes })})`;
    script = (
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source })
    ).identifier;
    const installed = await session.send("Runtime.evaluate", {
      expression: source,
    });
    if (installed.exceptionDetails)
      throw Error("Owned page wrapper installation failed.");
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Owned page binding initialization and cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }
  return { close };
}
