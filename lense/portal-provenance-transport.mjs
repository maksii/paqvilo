import { createHash, randomBytes } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { installPortalProvenanceRegistry } from './portal-element-provider.mjs';
import { createResponseProofQueue } from './response-proof-queue.mjs';

const MAX_DESCRIPTOR_BYTES = 8 * 1024 * 1024;
// A command or sideband read waits until it answers or the attachment is disposed (its page closed or interception
// stopped). This guard only ends a wait on a live renderer or server that never answers, and that loss is reported.
const COMMAND_HANG_MS = 30_000;

/**
 * Whether a sideband read failed because its browser context is closing. Playwright's BrowserContext.close() disposes
 * the context's request context before it closes the pages: a read still in flight then fails with
 * "apiRequestContext.<method>: Request context disposed." and reading an answer it dropped fails with
 * "apiResponse.body: Response has been disposed", while the tab still answers. Playwright exports no class or code
 * for either, so the first line of the message is matched after its API-name prefix.
 */
const CONTEXT_CLOSED_READ = /^(?:[\w.]+: )?(?:Request context disposed\.|Response has been disposed)$/;
export const readEndedByContextClose = (error) =>
  typeof error?.message === 'string' && CONTEXT_CLOSED_READ.test(error.message.split('\n', 1)[0]);

/**
 * The default execution contexts of the target origins, kept current from the CDP events that create and destroy them.
 * Every live default context of a target origin, including a context beyond the record limit and one whose claim is
 * still in flight or was never admitted: disposal retires the registry in each of them.
 */
export function trackDefaultDocuments(targets) {
  const documents = new Set();
  const tracking = [
    [
      'Runtime.executionContextCreated',
      ({ context: execution }) => {
        if (execution.auxData?.isDefault && targets.has(execution.origin)) documents.add(execution.id);
      },
    ],
    ['Runtime.executionContextDestroyed', ({ executionContextId }) => documents.delete(executionContextId)],
    ['Runtime.executionContextsCleared', () => documents.clear()],
  ];
  return { documents, tracking };
}

/**
 * Where V8 locates a registry method of a bootstrap (`[[FunctionLocation]]`, zero-based): the opening parenthesis of
 * its parameter list. The method's signature occurs once in the bootstrap.
 */
function methodLocation(source, signature) {
  const index = source.indexOf(signature);
  if (index < 0 || source.includes(signature, index + 1))
    throw new Error(`a provenance bootstrap must contain ${signature} exactly once`);
  const at = index + signature.indexOf('('),
    before = source.slice(0, at);
  const lineNumber = before.split('\n').length - 1;
  return { lineNumber, columnNumber: at - (before.lastIndexOf('\n') + 1) };
}

/**
 * The bootstrap script the browser parsed in each execution context, from `Debugger.scriptParsed`. It is identified
 * by its content hash (SHA-256 of the source, as Chromium reports it): a page cannot compile a script with that hash
 * because the source holds the registry secret. Bounded; a destroyed context forgets its script, and cleared contexts
 * forget theirs: context and script ids restart in a new renderer process, and a context that returns after a clear
 * (session re-attach, back/forward cache restore) has its scripts reported again.
 */
function trackBootstrapScripts(bootstrap) {
  const hash = createHash('sha256').update(bootstrap).digest('hex');
  const scripts = new Map();
  const tracking = [
    [
      'Debugger.scriptParsed',
      (event) => {
        if (event.hash !== hash || !event.executionContextId) return;
        if (scripts.size >= 256 && !scripts.has(event.executionContextId)) scripts.delete(scripts.keys().next().value);
        scripts.set(event.executionContextId, event.scriptId);
      },
    ],
    ['Runtime.executionContextDestroyed', ({ executionContextId }) => scripts.delete(executionContextId)],
    ['Runtime.executionContextsCleared', () => scripts.clear()],
  ];
  return { scripts, tracking };
}

/** The origin of a frame's URL, or null when it has none. */
export const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const ownDataFunction = (entry) =>
  entry?.isOwn === true && !entry.get && !entry.set && entry.value?.type === 'function' && entry.value.objectId;
const genuineSlot = (entry) =>
  entry.isOwn === true &&
  entry.writable === false &&
  entry.configurable === false &&
  !entry.get &&
  !entry.set &&
  entry.value?.type === 'object' &&
  entry.value.objectId;

/**
 * Verifies the registry of one execution context without running page code and returns the object ids of its
 * `methods` (name -> location in the bootstrap). The context's global must hold `slot` as an own, non-writable,
 * non-configurable data property; that object must hold each method as an own data property whose function V8 locates
 * at the method's place in the bootstrap script the browser parsed in this context (`script(contextId)`). A page cannot
 * satisfy this with its own object: no function of its making, or of another document's bootstrap, has that location.
 * `ask(method, params)` resolves to the answer, or to null when the command failed or ended.
 * Resolves to `{ methods }`, to `{ absent: true }` when the context has no such slot (an uninstrumented document), to
 * `{ invalid: reason }`, to `{ unparsed: true }` when the browser reported no bootstrap script for the context, or to
 * null when a command ended.
 */
async function verifyRegistry({ ask, contextId, slot, objectGroup, script, methods }) {
  const global = await ask('Runtime.evaluate', { expression: 'this', contextId, objectGroup, silent: true });
  if (!global?.result?.objectId) return null;
  const own = await ask('Runtime.getProperties', {
    objectId: global.result.objectId,
    ownProperties: true,
    // Indexed properties of a window are its child frames' windows: materializing one gives a frame's initial empty
    // document its context, and Chromium then keeps that window for the frame's first same-origin document, where no
    // bootstrap runs. The slot is a named property; named frame access lives on the prototype chain, not here.
    nonIndexedPropertiesOnly: true,
    generatePreview: false,
  });
  if (!Array.isArray(own?.result)) return null;
  const entry = own.result.find((item) => item.name === slot);
  if (!entry) return { absent: true };
  if (!genuineSlot(entry)) return { invalid: 'slot' };
  const members = await ask('Runtime.getProperties', { objectId: entry.value.objectId, ownProperties: true });
  if (!Array.isArray(members?.result)) return null;
  const found = {};
  for (const [name, location] of Object.entries(methods)) {
    const member = members.result.find((item) => item.name === name);
    if (!ownDataFunction(member)) return { invalid: name };
    const inner = await ask('Runtime.getProperties', { objectId: member.value.objectId, ownProperties: true });
    if (!inner) return null;
    const at = inner.internalProperties?.find((item) => item.name === '[[FunctionLocation]]')?.value?.value;
    const parsed = script(contextId);
    // Without the browser's report of the bootstrap in this context nothing can be verified, and nothing is sent.
    if (!parsed) return { unparsed: true };
    if (at?.scriptId !== parsed || at.lineNumber !== location.lineNumber || at.columnNumber !== location.columnNumber)
      return { invalid: name };
    found[name] = member.value.objectId;
  }
  return { methods: found };
}

/** Calls a verified registry method with one argument: no page-controlled lookup happens between check and call. */
const callRegistryMethod = (ask, objectId, value, objectGroup) =>
  ask('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function(value){return this(value)}',
    arguments: [{ value }],
    objectGroup,
    silent: true,
  });

/**
 * The verified access to the registries one bootstrap installs (`kind` names them in reports). Per attachment, with
 * its `ask(method, params)` (answer, or null when the command failed or ended) and `lost(error)`: `tracking` lists the
 * events that record the bootstrap script parsed in each context; `claim(contextId, ended)` resolves to the writer's
 * object id, or null; `release(contextId)` closes the registry; `reused(frameId)` reports, once per frame until
 * `forget(frameId)`, a document that took over the window of its frame's initial empty document. The secret and the release key are sent only to the
 * verified functions.
 *
 * One claim, after verifying the registry: the bootstrap runs synchronously while Chromium creates the main-world
 * context (InspectorPageAgent::DidCreateMainWorldContext injects it, and Debugger.scriptParsed reports it first), and
 * Runtime.evaluate is not one of the protocol methods that interrupt running script (ShouldInterruptForMethod in
 * devtools_session.cc), so the verification runs after the bootstrap. A writer is always the bootstrap's own: only its
 * verified claim receives the secret. A context without the slot is an uninstrumented document.
 */
export function registryAccess({ kind, slot, bootstrap, secret, releaseKey }) {
  const claimAt = methodLocation(bootstrap, 'claim(value) {'),
    releaseAt = methodLocation(bootstrap, 'release(value) {');
  return ({ ask, lost }) => {
    const { scripts, tracking } = trackBootstrapScripts(bootstrap);
    const reusedFrames = new Set();
    const verify = (contextId, methods) =>
      verifyRegistry({ ask, contextId, slot, objectGroup: slot, script: (id) => scripts.get(id), methods });
    return {
      tracking,
      async claim(contextId, ended) {
        const registry = await verify(contextId, { claim: claimAt });
        if (ended() || registry?.absent) return null;
        const writer = registry?.methods && (await callRegistryMethod(ask, registry.methods.claim, secret, slot));
        if (writer?.result?.objectId) return writer.result.objectId;
        if (ended()) return null;
        // A page script in that document holds the registry's place: a reload brings it back, so it is not offered.
        if (registry?.invalid)
          lost(
            Object.assign(
              new Error(
                `a page script holds the place of the ${kind} provenance registry in a document, so provenance for that document is not recorded`,
              ),
              { reloadHelps: false },
            ),
          );
        else lost(new Error(`the ${kind} provenance registry of a document could not be claimed`));
        return null;
      },
      async release(contextId) {
        const registry = await verify(contextId, { release: releaseAt });
        if (registry?.methods) await callRegistryMethod(ask, registry.methods.release, releaseKey, slot);
      },
      // When the initial empty document of a frame already has its context (page code touched the frame's window before
      // its document committed), Chromium keeps that Window and context for the same-origin document that replaces it: it
      // reports a navigation but no new context, and no bootstrap runs in the new document. Page code may have prepared
      // that window, so no registry is installed into it. A later navigation of the frame gets a fresh window.
      reused(frameId) {
        if (reusedFrames.has(frameId)) return;
        if (reusedFrames.size >= 256) reusedFrames.delete(reusedFrames.values().next().value);
        reusedFrames.add(frameId);
        lost(
          Object.assign(
            new Error(
              `a document took over the window of its frame's initial empty document, so its ${kind} provenance is not recorded`,
            ),
            { reloadHelps: false },
          ),
        );
      },
      forget(frameId) {
        reusedFrames.delete(frameId);
      },
    };
  };
}

/** Private CDP writers admit descriptors only into the response's actual frame/loader. */
export function createPortalProvenanceTransport(context, configs, { onDescriptor, domProvenanceSlot } = {}) {
  const targets = new Map(configs.map((cfg) => [new URL(cfg.origin).origin, cfg]));
  const slot = '__paqviloPortal_' + randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  // Closes a registry without its writer; unlike `secret` it cannot admit evidence.
  const releaseKey = randomBytes(32).toString('hex');
  const bootstrap = `if(${JSON.stringify([...targets.keys()])}.includes(location.origin))(${installPortalProvenanceRegistry.toString()})(${JSON.stringify({ slot, secret, domProvenanceSlot, releaseKey })});\n//# sourceURL=paqvilo-tool://portal-provenance`;
  const registries = registryAccess({ kind: 'page', slot, bootstrap, secret, releaseKey });
  return {
    slot,
    async onAttach({ cdp, configure, report, clock = globalThis }) {
      const controller = new AbortController();
      setMaxListeners(0, controller.signal);
      const contexts = new Map(),
        requests = new Map(),
        pending = new Map();
      const initialLoaders = new Map(),
        // The loader of each frame whose context was cleared. Chromium clears and re-reports the contexts of an unchanged
        // document when it re-attaches the tab's DevTools session; the proofs still waiting for that document are kept
        // for its re-reported context, and dropped once the frame reports another loader or detaches.
        returning = new Map();
      let script,
        closed = false;
      const { documents, tracking: documentTracking } = trackDefaultDocuments(targets);
      const lost = (error) => {
        if (!closed) report?.(error);
      };
      const registry = registries({ ask: (method, params) => send(method, params, null), lost });
      const tracking = [...documentTracking, ...registry.tracking];
      // A rejected command resolves to `rejected`; a command ended by disposal or the hang guard resolves to null.
      const send = async (method, params = {}, rejected = null) => {
        let timer, onAbort;
        const aborted = new Promise((resolve) => {
          timer = clock.setTimeout(() => {
            lost(new Error(`${method} did not answer within ${COMMAND_HANG_MS} ms`));
            resolve(null);
          }, COMMAND_HANG_MS);
          onAbort = () => resolve(null);
          if (!controller.signal.aborted) controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          return await Promise.race([cdp.send(method, params).catch(() => rejected), aborted]);
        } finally {
          clock.clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
        }
      };
      // A failed read is a loss only while its target still answers; closing the page, context or browser ends it quietly.
      const gone = Symbol('gone');
      const readLost = async (message, error) => {
        if (closed || readEndedByContextClose(error) || (await send('Page.getFrameTree', {}, gone)) === gone) return;
        lost(new Error(message));
      };
      const frames = (tree, map = new Map(), depth = 0) => {
        if (depth > 64 || map.size >= 256) return map;
        if (tree?.frame) map.set(tree.frame.id, tree.frame.loaderId);
        for (const child of tree?.childFrames ?? []) frames(child, map, depth + 1);
        return map;
      };
      const currentLoader = async (frameId) => frames((await send('Page.getFrameTree'))?.frameTree).get(frameId);
      const validShape = (proof) =>
        proof?.version === 1 &&
        ['lense-applied-response', 'mirage-render'].includes(proof.channel) &&
        typeof proof.proofId === 'string' &&
        proof.proofId.length <= 256 &&
        Array.isArray(proof.bindings) &&
        Array.isArray(proof.sourceRefs);
      // 'valid', 'too-large' or 'invalid'.
      const checkProof = (proof) => {
        try {
          if (!validShape(proof)) return 'invalid';
          return Buffer.byteLength(JSON.stringify(proof)) <= MAX_DESCRIPTOR_BYTES ? 'valid' : 'too-large';
        } catch {
          return 'invalid';
        }
      };
      // What the registry of a document whose descriptor is too large to deliver receives instead: that fact alone,
      // so the X-ray says "provenance too large" for its elements rather than "not proved".
      const tooLargeProof = (channel, proofId) => ({
        version: 1,
        channel,
        proofId,
        bindings: [],
        sourceRefs: [],
        complete: false,
        unavailable: 'response-proof-too-large',
      });
      const reportTooLarge = () =>
        lost(
          new Error(
            `the provenance of a document is larger than ${MAX_DESCRIPTOR_BYTES / 1024 / 1024} MiB, so its elements are not identified`,
          ),
        );
      const flush = async (record) => {
        if (closed || record.closed || !record.objectId || !record.loaderId) return;
        const key = record.frameId + ':' + record.loaderId;
        const proofs = pending.get(key);
        if (!proofs?.length || (await currentLoader(record.frameId)) !== record.loaderId || record.closed || closed)
          return;
        pending.delete(key);
        for (const proof of proofs) {
          if (closed || record.closed) return;
          await send('Runtime.callFunctionOn', {
            objectId: record.objectId,
            functionDeclaration: 'function(proof){return this.publish(proof)}',
            arguments: [{ value: proof }],
            returnByValue: true,
          });
        }
      };
      const admit = async (frameId, loaderId, proof, request) => {
        if (closed || !frameId || !loaderId) return false;
        const state = checkProof(proof);
        if (state === 'invalid') return false;
        if (state === 'too-large') {
          reportTooLarge();
          proof = tooLargeProof(proof.channel, proof.proofId);
        } else await onDescriptor?.({ cdp, frameId, loaderId, proof, request });
        if (closed) return false;
        const key = frameId + ':' + loaderId;
        if (pending.size >= 64 && !pending.has(key)) pending.delete(pending.keys().next().value);
        pending.set(key, [...(pending.get(key) ?? []), proof].slice(-16));
        for (const record of contexts.values())
          if (record.frameId === frameId && record.loaderId === loaderId) await flush(record);
        return true;
      };
      const retire = (id, keepPending = false) => {
        const record = contexts.get(id);
        if (!record) return;
        record.closed = true;
        contexts.delete(id);
        if (record.loaderId && !keepPending) pending.delete(record.frameId + ':' + record.loaderId);
        if (record.objectId) send('Runtime.releaseObject', { objectId: record.objectId }).catch(() => {});
      };
      const created = ({ context: execution }) => {
        if (
          closed ||
          !execution.auxData?.isDefault ||
          !execution.auxData.frameId ||
          !targets.has(execution.origin) ||
          contexts.has(execution.id) ||
          contexts.size >= 128
        )
          return;
        const record = {
          id: execution.id,
          frameId: execution.auxData.frameId,
          objectId: null,
          loaderId: null,
          closed: false,
        };
        contexts.set(record.id, record);
        (async () => {
          const loader = await currentLoader(record.frameId);
          // Existing documents never received our early bootstrap: do not scan
          // their DOM retroactively or accept a page-created lookalike registry.
          // Such a document has no registry to retire either.
          if (loader && initialLoaders.get(record.frameId) === loader) documents.delete(record.id);
          const previous = returning.get(record.frameId);
          returning.delete(record.frameId);
          if (previous && previous !== loader) pending.delete(record.frameId + ':' + previous);
          if (!loader || initialLoaders.get(record.frameId) === loader || record.closed || closed) return;
          record.loaderId = loader;
          const writer = await registry.claim(record.id, () => record.closed || closed);
          if (!writer) return;
          // The record was retired while its claim was answered: the writer handle is not kept.
          if (record.closed || closed) {
            await send('Runtime.releaseObject', { objectId: writer });
            return;
          }
          record.objectId = writer;
          if ((await currentLoader(record.frameId)) !== loader || record.closed || closed) return;
          await flush(record);
        })().catch(() => {});
      };
      const destroyed = ({ executionContextId }) => retire(executionContextId);
      const cleared = () => {
        // Merged per frame: a second clear before the context returns keeps the loader of the first.
        // Deleting the visited entry while iterating a Map is safe.
        for (const [id, record] of contexts) {
          if (record.loaderId) {
            returning.delete(record.frameId);
            if (returning.size >= 128) returning.delete(returning.keys().next().value);
            returning.set(record.frameId, record.loaderId);
          }
          retire(id, Boolean(record.loaderId));
        }
      };
      // Chromium ends the contexts of a frame's document before it reports the frame's next document, and announces
      // the new document's context after that report. A context of the frame that is still live when the frame reports
      // a document therefore holds that document in a reused window.
      // A back/forward cache restore re-reports the restored document's context before its navigation: that context is
      // the restored document's own and is claimed as usual.
      const navigated = ({ frame, type }) => {
        if (type === 'BackForwardCacheRestore') return;
        for (const record of contexts.values())
          if (record.frameId === frame?.id && !record.closed) {
            retire(record.id);
            // Only a document the transport would instrument lost its provenance.
            if (targets.has(originOf(frame.url))) registry.reused(frame.id);
          }
      };
      const detached = ({ frameId }) => {
        registry.forget(frameId);
        returning.delete(frameId);
        for (const key of pending.keys()) if (key.startsWith(frameId + ':')) pending.delete(key);
      };
      const requested = (event) => {
        if (closed || event.type !== 'Document') return;
        let address;
        try {
          address = new URL(event.request.url);
        } catch {
          return;
        }
        if (!targets.has(address.origin)) return;
        if (requests.size >= 256) requests.delete(requests.keys().next().value);
        requests.set(event.requestId, {
          frameId: event.frameId,
          loaderId: event.loaderId,
          origin: address.origin,
          url: address.origin + address.pathname,
          urlKey: createHash('sha256').update(event.request.url).digest('hex'),
        });
        acknowledgements.requested(event.requestId, requests.get(event.requestId));
      };
      const acknowledgements = createResponseProofQueue({ requests, admit });
      const response = (event) => {
        if (closed || event.type !== 'Document' || event.response.status !== 200) return;
        let address;
        try {
          address = new URL(event.response.url);
        } catch {
          return;
        }
        if (!targets.get(address.origin)?.mirage) return;
        const header = Object.entries(event.response.headers ?? {}).find(
          ([name]) => name.toLowerCase() === 'x-paqvilo-provenance',
        )?.[1];
        const access = Object.entries(event.response.headers ?? {}).find(
          ([name]) => name.toLowerCase() === 'x-paqvilo-provenance-access',
        )?.[1];
        if (typeof header !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(header)) return;
        if (typeof access !== 'string' || !/^[a-f0-9]{64}$/.test(access)) return;
        (async () => {
          const descriptor = new URL('/_sim/api/page-provenance', address.origin);
          descriptor.searchParams.set('proof', header);
          const answer = await context.request.get(descriptor.href, {
            headers: { 'x-paqvilo-provenance-access': access },
            maxRedirects: 0,
            timeout: COMMAND_HANG_MS,
            failOnStatusCode: false,
          });
          const request = requests.get(event.requestId);
          const own = request?.frameId === event.frameId && request.loaderId === event.loaderId;
          // A descriptor over the bound is not read: its document is told so (see tooLargeProof).
          const oversized = async () => {
            reportTooLarge();
            if (own && !closed)
              await admit(request.frameId, request.loaderId, tooLargeProof('mirage-render', header), request);
          };
          try {
            if (closed || answer.status() !== 200 || !/application\/json/i.test(answer.headers()['content-type'] ?? ''))
              return;
            if (Number(answer.headers()['content-length'] ?? 0) > MAX_DESCRIPTOR_BYTES) return await oversized();
            const bytes = await answer.body();
            if (closed) return;
            if (bytes.length > MAX_DESCRIPTOR_BYTES) return await oversized();
            const proof = JSON.parse(bytes.toString('utf8'));
            if (proof.proofId !== header || proof.channel !== 'mirage-render') return;
            if (own) await admit(request.frameId, request.loaderId, proof, request);
          } finally {
            await answer.dispose?.();
          }
        })().catch((error) => readLost('the page provenance read did not complete', error));
      };
      const listeners = [
        ['Runtime.executionContextCreated', created],
        ['Runtime.executionContextDestroyed', destroyed],
        ['Runtime.executionContextsCleared', cleared],
        ['Page.frameNavigated', navigated],
        ['Page.frameDetached', detached],
        ['Network.requestWillBeSent', requested],
        ['Network.responseReceived', response],
      ];
      const dispose = async () => {
        if (closed) return;
        closed = true;
        controller.abort();
        for (const [type, listener] of listeners) cdp.off(type, listener);
        for (const record of contexts.values()) record.closed = true;
        contexts.clear();
        requests.clear();
        acknowledgements.clear();
        pending.clear();
        returning.clear();
        // The bootstrap is removed first, while contexts are still tracked: a document that commits during disposal
        // announces its context before the removal is answered, so its registry is retired below as well.
        if (script?.identifier)
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
        for (const [type, listener] of tracking) cdp.off(type, listener);
        // A registry is retired through its verified `release`, not through its claimed writer: the writer of a claim
        // that is still in flight never reaches this transport, and the browser runs this command after that claim.
        await Promise.allSettled([...documents].map((contextId) => registry.release(contextId)));
        documents.clear();
        await Promise.allSettled([
          send('Runtime.releaseObjectGroup', { objectGroup: slot }),
          send('Debugger.disable'),
          send('Runtime.disable'),
          send('Page.disable'),
        ]);
      };
      try {
        await configure('Page.enable');
        for (const [frameId, loader] of frames((await configure('Page.getFrameTree')).frameTree))
          initialLoaders.set(frameId, loader);
        for (const [type, listener] of [...tracking, ...listeners]) cdp.on(type, listener);
        // Debugger reports which script the browser parsed in each context; it never pauses the page.
        await configure('Debugger.enable');
        await configure('Debugger.setSkipAllPauses', { skip: true });
        script = await configure('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });
        await configure('Runtime.enable');
      } catch (error) {
        await dispose();
        throw error;
      }
      return {
        dispose,
        async publishProvenance(event, proof) {
          if (closed || event.resourceType !== 'Document' || proof?.channel !== 'lense-applied-response') return false;
          // The acknowledgement queue holds descriptors within the bound only: one over it is reported now and its
          // document receives the fact that it was too large.
          if (checkProof(proof) === 'too-large') {
            reportTooLarge();
            return acknowledgements.fulfill(event, tooLargeProof(proof.channel, proof.proofId));
          }
          return acknowledgements.fulfill(event, proof);
        },
      };
    },
  };
}
