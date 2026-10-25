import { createHash, randomBytes } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { installPortalProvenanceRegistry } from './portal-element-provider.mjs';
import { createResponseProofQueue } from './response-proof-queue.mjs';

const MAX_DESCRIPTOR_BYTES = 8 * 1024 * 1024;
const COMMAND_MS = 3000;

/** Private CDP writers admit descriptors only into the response's actual frame/loader. */
export function createPortalProvenanceTransport(context, configs, { onDescriptor, domProvenanceSlot } = {}) {
  const targets = new Map(configs.map((cfg) => [new URL(cfg.origin).origin, cfg]));
  const slot = '__paqviloPortal_' + randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const bootstrap = `if(${JSON.stringify([...targets.keys()])}.includes(location.origin))(${installPortalProvenanceRegistry.toString()})(${JSON.stringify({ slot, secret, domProvenanceSlot })});`;
  return {
    slot,
    async onAttach({ cdp, configure }) {
      const controller = new AbortController();
      setMaxListeners(0, controller.signal);
      const contexts = new Map(),
        requests = new Map(),
        pending = new Map();
      const initialLoaders = new Map();
      let script,
        closed = false;
      const send = async (method, params = {}) => {
        let timer, onAbort;
        const aborted = new Promise((resolve) => {
          timer = setTimeout(resolve, COMMAND_MS, null);
          onAbort = () => resolve(null);
          if (!controller.signal.aborted) controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          return await Promise.race([cdp.send(method, params).catch(() => null), aborted]);
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
        }
      };
      const frames = (tree, map = new Map(), depth = 0) => {
        if (depth > 64 || map.size >= 256) return map;
        if (tree?.frame) map.set(tree.frame.id, tree.frame.loaderId);
        for (const child of tree?.childFrames ?? []) frames(child, map, depth + 1);
        return map;
      };
      const currentLoader = async (frameId) => frames((await send('Page.getFrameTree'))?.frameTree).get(frameId);
      const validProof = (proof) => {
        try {
          return (
            proof?.version === 1 &&
            ['lense-applied-response', 'mirage-render'].includes(proof.channel) &&
            typeof proof.proofId === 'string' &&
            proof.proofId.length <= 256 &&
            Array.isArray(proof.bindings) &&
            Array.isArray(proof.sourceRefs) &&
            Buffer.byteLength(JSON.stringify(proof)) <= MAX_DESCRIPTOR_BYTES
          );
        } catch {
          return false;
        }
      };
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
        if (closed || !frameId || !loaderId || !validProof(proof)) return false;
        await onDescriptor?.({ cdp, frameId, loaderId, proof, request });
        if (closed) return false;
        const key = frameId + ':' + loaderId;
        if (pending.size >= 64 && !pending.has(key)) pending.delete(pending.keys().next().value);
        pending.set(key, [...(pending.get(key) ?? []), proof].slice(-16));
        for (const record of contexts.values())
          if (record.frameId === frameId && record.loaderId === loaderId) await flush(record);
        return true;
      };
      const retire = (id) => {
        const record = contexts.get(id);
        if (!record) return;
        record.closed = true;
        contexts.delete(id);
        if (record.loaderId) pending.delete(record.frameId + ':' + record.loaderId);
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
          if (!loader || initialLoaders.get(record.frameId) === loader || record.closed || closed) return;
          record.loaderId = loader;
          for (let attempt = 0; attempt < 12 && !record.closed && !closed; attempt++) {
            const result = await send('Runtime.evaluate', {
              contextId: record.id,
              expression: `this[${JSON.stringify(slot)}]&&this[${JSON.stringify(slot)}].claim(${JSON.stringify(secret)})`,
              returnByValue: false,
              objectGroup: slot,
            });
            if (result?.result?.objectId) {
              record.objectId = result.result.objectId;
              break;
            }
            await delay(20, undefined, { signal: controller.signal }).catch(() => {});
          }
          if ((await currentLoader(record.frameId)) !== loader || record.closed || closed) return;
          await flush(record);
        })().catch(() => {});
      };
      const destroyed = ({ executionContextId }) => retire(executionContextId);
      const cleared = () => {
        for (const id of [...contexts.keys()]) retire(id);
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
            timeout: COMMAND_MS,
            failOnStatusCode: false,
          });
          try {
            if (
              closed ||
              answer.status() !== 200 ||
              !/application\/json/i.test(answer.headers()['content-type'] ?? '') ||
              Number(answer.headers()['content-length'] ?? 0) > MAX_DESCRIPTOR_BYTES
            )
              return;
            const bytes = await answer.body();
            if (bytes.length > MAX_DESCRIPTOR_BYTES || closed) return;
            const proof = JSON.parse(bytes.toString('utf8'));
            if (proof.proofId !== header || proof.channel !== 'mirage-render') return;
            const request = requests.get(event.requestId);
            if (request?.frameId === event.frameId && request.loaderId === event.loaderId)
              await admit(request.frameId, request.loaderId, proof, request);
          } finally {
            await answer.dispose?.();
          }
        })().catch(() => {});
      };
      const listeners = [
        ['Runtime.executionContextCreated', created],
        ['Runtime.executionContextDestroyed', destroyed],
        ['Runtime.executionContextsCleared', cleared],
        ['Network.requestWillBeSent', requested],
        ['Network.responseReceived', response],
      ];
      const dispose = async () => {
        if (closed) return;
        closed = true;
        controller.abort();
        for (const [type, listener] of listeners) cdp.off(type, listener);
        const cleanup = [];
        for (const record of contexts.values()) {
          record.closed = true;
          if (record.objectId)
            cleanup.push(
              send('Runtime.callFunctionOn', {
                objectId: record.objectId,
                functionDeclaration: 'function(){this.dispose()}',
                returnByValue: true,
              }),
            );
        }
        contexts.clear();
        requests.clear();
        acknowledgements.clear();
        pending.clear();
        if (script?.identifier)
          cleanup.push(send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier }));
        cleanup.push(
          send('Runtime.releaseObjectGroup', { objectGroup: slot }),
          send('Runtime.disable'),
          send('Page.disable'),
        );
        await Promise.allSettled(cleanup);
      };
      try {
        await configure('Page.enable');
        for (const [frameId, loader] of frames((await configure('Page.getFrameTree')).frameTree))
          initialLoaders.set(frameId, loader);
        for (const [type, listener] of listeners) cdp.on(type, listener);
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
          return acknowledgements.fulfill(event, proof);
        },
      };
    },
  };
}
