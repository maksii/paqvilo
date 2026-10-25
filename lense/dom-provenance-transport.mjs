import { createHash, randomBytes } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { installDomProvenance } from './dom-provenance.mjs';
import { normalizeInspectionSourceRef } from './inspection-evidence.mjs';
import { createResponseProofQueue } from './response-proof-queue.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeURL = (value) =>
  typeof value === 'string' && value.length <= 32768 && /^(?:https?:\/\/|file:\/\/\/)/.test(value)
    ? { url: value.split(/[?#]/, 1)[0], urlKey: digest(value) }
    : null;
const frameLoaders = (tree) => {
  const found = new Map(),
    queue = [tree];
  let visited = 0;
  while (queue.length && visited++ < 256) {
    const item = queue.shift();
    if (item?.frame?.id) found.set(item.frame.id, item.frame.loaderId);
    if (item?.childFrames) queue.push(...item.childFrames.slice(0, Math.max(0, 256 - visited - queue.length)));
  }
  return found;
};

/** Pair an actual DOM callsite with parsed code and an acknowledged local implementation. */
export function createDomProvenanceTransport(context, configs) {
  const targets = new Map(configs.map((cfg) => [new URL(cfg.origin).origin, cfg]));
  const slot = '__paqviloDom_' + randomBytes(16).toString('hex'),
    secret = randomBytes(32).toString('hex');
  const binding = '__paqviloDomEvent_' + randomBytes(16).toString('hex');
  const bootstrap = `if(${JSON.stringify([...targets.keys()])}.includes(location.origin))(${installDomProvenance.toString()})(${JSON.stringify({ slot, secret, binding })});\n//# sourceURL=paqvilo-tool://dom-provenance`;
  return {
    slot,
    async onAttach({ cdp, configure }) {
      const controller = new AbortController();
      setMaxListeners(0, controller.signal);
      const contexts = new Map(),
        requests = new Map(),
        descriptors = new Map();
      let loaders = new Map(),
        initial = new Map(),
        script,
        closed = false;
      const command = async (method, params = {}) => {
        if (
          closed &&
          ![
            'Runtime.callFunctionOn',
            'Runtime.releaseObjectGroup',
            'Runtime.removeBinding',
            'Page.removeScriptToEvaluateOnNewDocument',
            'Debugger.disable',
          ].includes(method)
        )
          return null;
        const deadline = closed
          ? AbortSignal.timeout(3000)
          : AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
        let release;
        const expired = new Promise((resolve) => {
          release = () => resolve(null);
          if (deadline.aborted) release();
          else deadline.addEventListener('abort', release, { once: true });
        });
        try {
          return await Promise.race([
            Promise.resolve()
              .then(() => cdp.send(method, params))
              .catch(() => null),
            expired,
          ]);
        } finally {
          deadline.removeEventListener('abort', release);
        }
      };
      const locate = (proof, parsed, frame) => {
        const line = frame.line - 1 - (parsed.hasSourceURL ? 0 : parsed.startLine);
        const column = frame.column - 1 - (!parsed.hasSourceURL && line === 0 ? parsed.startColumn : 0);
        if (
          !Number.isSafeInteger(line) ||
          line < 0 ||
          !Number.isSafeInteger(column) ||
          column < 0 ||
          line >= proof.lineStarts.length
        )
          return null;
        const offset = proof.lineStarts[line] + column;
        if (line + 1 < proof.lineStarts.length && offset >= proof.lineStarts[line + 1]) return null;
        const matches = proof.mappings.filter(
          (mapping) =>
            mapping.generatedStart <= offset &&
            offset < mapping.generatedEnd &&
            mapping.generatedEnd - mapping.generatedStart === mapping.sourceEnd - mapping.sourceStart,
        );
        if (matches.length !== 1) return null;
        const mapping = matches[0],
          start = mapping.sourceStart + offset - mapping.generatedStart;
        return { sourceRefId: mapping.sourceRefId, region: { start, end: start + 1 } };
      };
      const resolveNode = (record, event) => {
        const frame = event.frames[0];
        if (!frame || frame.barrier) return { sourceRefs: [], facts: [], reason: 'direct-callsite-unavailable' };
        const parsed = [...record.scripts.values()].filter((script) => {
          if (!(frame.urlKey ? script.urlKey === frame.urlKey : script.url === frame.url)) return false;
          const line = frame.line - 1,
            column = frame.column - 1;
          if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 0 || column < 0) return false;
          const firstLine = script.hasSourceURL ? 0 : script.startLine;
          const lastLine = script.hasSourceURL ? script.endLine - script.startLine : script.endLine;
          const firstColumn = script.hasSourceURL ? 0 : script.startColumn;
          const lastColumn =
            script.endColumn - (script.hasSourceURL && script.endLine === script.startLine ? script.startColumn : 0);
          return (
            line >= firstLine &&
            line <= lastLine &&
            (line !== firstLine || column >= firstColumn) &&
            (line !== lastLine || column < lastColumn)
          );
        });
        const matches = [];
        for (const compiled of parsed) {
          for (const proof of record.proofs.values()) {
            if (
              proof.generatedHash !== compiled.hash ||
              !(proof.urlKey ? proof.urlKey === compiled.urlKey : proof.url === compiled.url)
            )
              continue;
            if (
              !proof.external &&
              !compiled.hasSourceURL &&
              (compiled.startLine !== proof.documentStart?.line || compiled.startColumn !== proof.documentStart?.column)
            )
              continue;
            const point = locate(proof, compiled, frame),
              ref = point && proof.refs.get(point.sourceRefId);
            if (!ref) continue;
            matches.push({
              ref: {
                ...ref,
                region: point.region,
                relationship: event.relationship,
                observations: { ...ref.observations, served: true, parsed: true, executed: true },
              },
              region: point.region,
              sourceRevision: proof.sourceRevision,
              limited: proof.linesTruncated || proof.mappingsTruncated,
            });
          }
        }
        const distinct = [
          ...new Map(
            matches.map((item) => [
              JSON.stringify([item.ref.key ?? item.ref.id, item.ref.contentRevision, item.region]),
              item,
            ]),
          ).values(),
        ];
        if (distinct.length !== 1)
          return Date.now() - event.createdAt >= 3000
            ? {
                sourceRefs: [],
                facts: [],
                reason: distinct.length > 1 ? 'script-callsite-ambiguous' : 'script-callsite-unmapped',
              }
            : null;
        // An overlapping different script version cannot be attributed by URL alone.
        if (
          parsed.some(
            (script) =>
              ![...record.proofs.values()].some(
                (proof) =>
                  proof.generatedHash === script.hash &&
                  (proof.urlKey ? proof.urlKey === script.urlKey : proof.url === script.url),
              ),
          )
        )
          return Date.now() - event.createdAt >= 3000
            ? { sourceRefs: [], facts: [], reason: 'script-version-unverified' }
            : null;
        const selected = distinct[0];
        return {
          sourceRefs: [selected.ref],
          limits: {
            truncated: Boolean(selected.limited),
            reasons: selected.limited ? ['script-source-map-truncated'] : [],
          },
          facts: [
            {
              id: 'dom:' + event.id,
              dimension: 'source',
              proof: 'observed-dom-callsite',
              sourceRefIds: [selected.ref.id],
              region: selected.region,
              renderSourceRevision: selected.sourceRevision,
            },
          ],
        };
      };
      const flush = async (record) => {
        record.dirty = true;
        if (record.flushing || !record.objectId || closed || record.closed) return;
        record.flushing = true;
        try {
          if (record.limitReason && !record.limitSent) {
            record.limitSent = true;
            await command('Runtime.callFunctionOn', {
              objectId: record.objectId,
              functionDeclaration: 'function(reason){return this.markLimited(reason)}',
              arguments: [{ value: record.limitReason }],
              returnByValue: true,
            });
          }
          do {
            record.dirty = false;
            if (loaders.get(record.frameId) !== record.loaderId) break;
            const batch = [];
            for (const [id, event] of record.nodes) {
              const proof = resolveNode(record, event);
              if (proof) {
                batch.push({ id, proof });
                record.nodes.delete(id);
              }
              if (batch.length >= 64) break;
            }
            if (!batch.length) break;
            await command('Runtime.callFunctionOn', {
              objectId: record.objectId,
              functionDeclaration: 'function(entries){return this.resolveMany(entries)}',
              arguments: [{ value: batch }],
              returnByValue: true,
            });
            if (record.nodes.size) record.dirty = true;
          } while (record.dirty && !closed && !record.closed);
        } finally {
          record.flushing = false;
          if (
            record.nodes.size &&
            !record.retry &&
            !closed &&
            !record.closed &&
            loaders.get(record.frameId) === record.loaderId
          )
            record.retry = setTimeout(() => {
              record.retry = null;
              flush(record).catch(() => {});
            }, 3100);
        }
      };
      const ingest = (frameId, loaderId, descriptor, request = {}) => {
        if (
          closed ||
          descriptor?.version !== 1 ||
          !Array.isArray(descriptor.scriptProofs) ||
          !Array.isArray(descriptor.sourceRefs) ||
          !['lense-applied-response', 'mirage-render', 'lense-script-resource', 'mirage-resource'].includes(
            descriptor.channel,
          )
        )
          return false;
        let size;
        try {
          size = Buffer.byteLength(JSON.stringify(descriptor));
        } catch {
          return false;
        }
        if (size > 8 * 1024 * 1024) return false;
        const key = frameId + ':' + loaderId;
        if (descriptors.size >= 64 && !descriptors.has(key)) descriptors.delete(descriptors.keys().next().value);
        descriptors.set(key, [...(descriptors.get(key) ?? []), { descriptor, request }].slice(-32));
        for (const record of contexts.values())
          if (record.frameId === frameId && record.loaderId === loaderId) admitDescriptors(record);
        return true;
      };
      const admitDescriptors = (record) => {
        for (const { descriptor, request } of descriptors.get(record.frameId + ':' + record.loaderId) ?? []) {
          const refs = new Map(
            descriptor.sourceRefs
              .map(normalizeInspectionSourceRef)
              .filter(Boolean)
              .map((ref) => [ref.id, ref]),
          );
          for (const proof of descriptor.scriptProofs.slice(0, 128)) {
            if (
              !proof ||
              typeof proof !== 'object' ||
              typeof proof.id !== 'string' ||
              !proof.id.length ||
              proof.id.length > 256 ||
              proof.hashAlgorithm !== 'sha256-utf8' ||
              !/^[a-f0-9]{64}$/.test(proof.generatedHash ?? '') ||
              !Array.isArray(proof.lineStarts) ||
              !proof.lineStarts.length ||
              proof.lineStarts[0] !== 0 ||
              proof.lineStarts.length > 16384 ||
              !proof.lineStarts.every(
                (offset, index, starts) =>
                  Number.isSafeInteger(offset) &&
                  offset >= 0 &&
                  offset <= 1_000_000_000 &&
                  (!index || offset > starts[index - 1]),
              ) ||
              !Array.isArray(proof.mappings)
            )
              continue;
            const mappings = proof.mappings
              .slice(0, 50000)
              .filter(
                (mapping) =>
                  mapping &&
                  typeof mapping === 'object' &&
                  refs.has(mapping.sourceRefId) &&
                  mapping.generatedEnd > mapping.generatedStart &&
                  mapping.sourceEnd > mapping.sourceStart &&
                  ['generatedStart', 'generatedEnd', 'sourceStart', 'sourceEnd'].every(
                    (field) => Number.isSafeInteger(mapping[field]) && mapping[field] >= 0,
                  ),
              );
            const address = proof.debugUrlKey ? { url: proof.debugUrl, urlKey: proof.debugUrlKey } : request;
            if (!address.urlKey && !address.url) continue;
            if (record.proofs.size >= 256 && !record.proofs.has(proof.id)) {
              record.limitReason ??= 'script-proof-index-limit';
              record.proofs.delete(record.proofs.keys().next().value);
            }
            record.proofs.set(proof.id, {
              ...proof,
              mappingsTruncated: proof.mappingsTruncated || proof.mappings.length > 50000,
              mappings,
              refs,
              ...address,
              sourceRevision: descriptor.sourceRevision,
              external:
                descriptor.channel === 'lense-script-resource' ||
                descriptor.channel === 'mirage-resource' ||
                proof.external,
            });
          }
        }
        flush(record).catch(() => {});
      };
      const created = ({ context: execution }) => {
        if (
          closed ||
          !execution.auxData?.isDefault ||
          !targets.has(execution.origin) ||
          contexts.has(execution.id) ||
          contexts.size >= 128
        )
          return;
        const record = {
          id: execution.id,
          frameId: execution.auxData.frameId,
          loaderId: loaders.get(execution.auxData.frameId),
          objectId: null,
          scripts: new Map(),
          proofs: new Map(),
          nodes: new Map(),
          closed: false,
          flushing: false,
        };
        contexts.set(record.id, record);
        (async () => {
          record.loaderId = frameLoaders((await command('Page.getFrameTree'))?.frameTree).get(record.frameId);
          if (!record.loaderId || record.loaderId === initial.get(record.frameId)) return;
          loaders.set(record.frameId, record.loaderId);
          for (let attempt = 0; attempt < 12 && !closed && !record.closed; attempt++) {
            const result = await command('Runtime.evaluate', {
              expression: `window[${JSON.stringify(slot)}]?.claim(${JSON.stringify(secret)})`,
              contextId: record.id,
              objectGroup: slot,
              silent: true,
            });
            if (result?.result?.objectId) {
              record.objectId = result.result.objectId;
              admitDescriptors(record);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        })().catch(() => {});
      };
      const destroy = ({ executionContextId }) => {
        const record = contexts.get(executionContextId);
        if (record) {
          record.closed = true;
          clearTimeout(record.retry);
          contexts.delete(executionContextId);
        }
      };
      const parsed = (event) => {
        const record = contexts.get(event.executionContextId),
          address = safeURL(event.url);
        if (!record || !address || !/^[a-f0-9]{64}$/.test(event.hash ?? '')) return;
        if (record.scripts.size >= 512) {
          record.limitReason ??= 'parsed-script-index-limit';
          record.scripts.delete(record.scripts.keys().next().value);
        }
        record.scripts.set(event.scriptId, {
          ...address,
          hash: event.hash,
          startLine: event.startLine ?? 0,
          startColumn: event.startColumn ?? 0,
          endLine: event.endLine ?? 0,
          endColumn: event.endColumn ?? 0,
          hasSourceURL: Boolean(event.hasSourceURL),
        });
        flush(record).catch(() => {});
      };
      const called = (event) => {
        const record = contexts.get(event.executionContextId);
        if (
          event.name !== binding ||
          !record ||
          record.closed ||
          loaders.get(record.frameId) !== record.loaderId ||
          typeof event.payload !== 'string' ||
          event.payload.length > 65536
        )
          return;
        let data;
        try {
          data = JSON.parse(event.payload);
        } catch {
          return;
        }
        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          data.version !== 1 ||
          data.secret !== secret ||
          typeof data.id !== 'string' ||
          !data.id.length ||
          data.id.length > 128 ||
          !['created-by', 'cloned-by', 'attached-by'].includes(data.relationship) ||
          !Array.isArray(data.frames)
        )
          return;
        if (
          data.frames.some(
            (frame) =>
              !frame ||
              typeof frame !== 'object' ||
              Array.isArray(frame) ||
              (frame.barrier !== true &&
                (!safeURL(frame.url) ||
                  !Number.isSafeInteger(frame.line) ||
                  frame.line <= 0 ||
                  !Number.isSafeInteger(frame.column) ||
                  frame.column <= 0)),
          )
        )
          return;
        const frames = data.frames.slice(0, 12).map((frame) =>
          frame.barrier === true
            ? { barrier: true }
            : {
                url: safeURL(frame.url).url.slice(0, 4096),
                urlKey: /^[a-f0-9]{64}$/.test(frame.urlKey ?? '') ? frame.urlKey : null,
                line: frame.line,
                column: frame.column,
              },
        );
        if (record.nodes.size >= 2048) {
          record.limitReason ??= 'dom-evidence-transport-limit';
          record.nodes.delete(record.nodes.keys().next().value);
        }
        record.nodes.set(data.id, { id: data.id, relationship: data.relationship, frames, createdAt: Date.now() });
        flush(record).catch(() => {});
      };
      const navigated = ({ frame }) => {
        if (frame?.id) {
          for (const record of contexts.values())
            if (record.frameId === frame.id && record.loaderId && record.loaderId !== frame.loaderId) {
              record.closed = true;
              clearTimeout(record.retry);
            }
          loaders.set(frame.id, frame.loaderId);
          for (const record of contexts.values())
            if (record.frameId === frame.id && !record.loaderId) {
              record.loaderId = frame.loaderId;
              admitDescriptors(record);
            }
        }
      };
      const detached = ({ frameId }) => {
        loaders.delete(frameId);
        for (const record of contexts.values())
          if (record.frameId === frameId) destroy({ executionContextId: record.id });
        for (const key of descriptors.keys()) if (key.startsWith(frameId + ':')) descriptors.delete(key);
      };
      const requested = (event) => {
        if (!['Script', 'Document'].includes(event.type)) return;
        let address;
        try {
          if (!targets.has(new URL(event.request.url).origin)) return;
          address = safeURL(event.request.url);
        } catch {
          return;
        }
        if (!address) return;
        if (requests.size >= 512) requests.delete(requests.keys().next().value);
        requests.set(event.requestId, { ...address, frameId: event.frameId, loaderId: event.loaderId });
        acknowledgements.requested(event.requestId, requests.get(event.requestId));
      };
      const acknowledgements = createResponseProofQueue({ requests, admit: ingest });
      const response = (event) => {
        if (event.type !== 'Script' || event.response.status !== 200) return;
        const request = requests.get(event.requestId);
        if (!request) return;
        let origin;
        try {
          origin = new URL(event.response.url).origin;
        } catch {
          return;
        }
        if (!targets.get(origin)?.mirage) return;
        const proofId = Object.entries(event.response.headers ?? {}).find(
          ([name]) => name.toLowerCase() === 'x-paqvilo-script-proof',
        )?.[1];
        const access = Object.entries(event.response.headers ?? {}).find(
          ([name]) => name.toLowerCase() === 'x-paqvilo-provenance-access',
        )?.[1];
        if (typeof proofId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(proofId)) return;
        if (typeof access !== 'string' || !/^[a-f0-9]{64}$/.test(access)) return;
        (async () => {
          const url = new URL('/_sim/api/page-provenance', origin);
          url.searchParams.set('proof', proofId);
          const answer = await context.request.get(url.href, {
            headers: { 'x-paqvilo-provenance-access': access },
            maxRedirects: 0,
            timeout: 3000,
            failOnStatusCode: false,
          });
          try {
            if (
              closed ||
              answer.status() !== 200 ||
              !/application\/json/i.test(answer.headers()['content-type'] ?? '') ||
              Number(answer.headers()['content-length'] ?? 0) > 8 * 1024 * 1024
            )
              return;
            const bytes = await answer.body();
            if (bytes.length > 8 * 1024 * 1024) return;
            const proof = JSON.parse(bytes.toString('utf8'));
            if (proof.channel === 'mirage-resource' && proof.proofId === proofId)
              ingest(request.frameId, request.loaderId, proof, request);
          } finally {
            await answer.dispose?.();
          }
        })().catch(() => {});
      };
      const listeners = [
        ['Runtime.executionContextCreated', created],
        ['Runtime.executionContextDestroyed', destroy],
        [
          'Runtime.executionContextsCleared',
          () => {
            for (const record of contexts.values()) {
              record.closed = true;
              clearTimeout(record.retry);
            }
            contexts.clear();
          },
        ],
        ['Runtime.bindingCalled', called],
        ['Debugger.scriptParsed', parsed],
        ['Page.frameNavigated', navigated],
        ['Page.frameDetached', detached],
        ['Network.requestWillBeSent', requested],
        ['Network.responseReceived', response],
      ];
      const dispose = async () => {
        if (closed) return;
        closed = true;
        for (const record of contexts.values()) clearTimeout(record.retry);
        for (const [event, handler] of listeners) cdp.off(event, handler);
        await Promise.allSettled(
          [...contexts.values()]
            .filter((record) => record.objectId)
            .map((record) =>
              command('Runtime.callFunctionOn', {
                objectId: record.objectId,
                functionDeclaration: 'function(){this.dispose()}',
                returnByValue: true,
              }),
            ),
        );
        controller.abort();
        contexts.clear();
        requests.clear();
        acknowledgements.clear();
        descriptors.clear();
        await Promise.allSettled([
          command('Runtime.removeBinding', { name: binding }),
          ...(script?.identifier
            ? [command('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier })]
            : []),
          command('Runtime.releaseObjectGroup', { objectGroup: slot }),
          command('Debugger.disable'),
        ]);
      };
      try {
        await configure('Page.enable');
        loaders = frameLoaders((await configure('Page.getFrameTree')).frameTree);
        initial = new Map(loaders);
        for (const [event, handler] of listeners) cdp.on(event, handler);
        await configure('Runtime.addBinding', { name: binding });
        script = await configure('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });
        await configure('Debugger.enable');
        await configure('Runtime.enable');
      } catch (error) {
        await dispose();
        throw error;
      }
      return {
        dispose,
        publishDescriptor: (frameId, loaderId, proof, request) => ingest(frameId, loaderId, proof, request),
        publishProvenance(event, proof) {
          return acknowledgements.fulfill(event, proof);
        },
      };
    },
  };
}
