import { createHash, randomBytes } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { installDomProvenance } from './dom-provenance.mjs';
import { installPortalProvenanceRegistry } from './portal-element-provider.mjs';
import { normalizeInspectionSourceRef } from './inspection-evidence.mjs';
import { platformRule } from './request-classes.mjs';
import { createResponseProofQueue } from './response-proof-queue.mjs';
import { scriptHashIndex } from './script-source-evidence.mjs';
import {
  originOf,
  readEndedByContextClose,
  registryAccess,
  trackDefaultDocuments,
} from './portal-provenance-transport.mjs';

const unanswered = Symbol('unanswered');
// A command or sideband read waits until it answers or the attachment is disposed (its page closed or interception
// stopped). This guard only ends a wait on a live renderer or server that never answers, and that loss is reported.
const COMMAND_HANG_MS = 30_000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeURL = (value) =>
  typeof value === 'string' && value.length <= 32768 && /^(?:https?:\/\/|file:\/\/\/)/.test(value)
    ? { url: value.split(/[?#]/, 1)[0], urlKey: digest(value) }
    : null;
// A proof acknowledged for a script's response or document names that parsed script by its hash and address.
const namesScript = (proof, compiled) =>
  proof.generatedHash === compiled.hash &&
  (proof.urlKey ? proof.urlKey === compiled.urlKey : proof.url === compiled.url);

// The proofs that can locate a callsite in one parsed script: the acknowledged ones, else the export source whose
// text has the hash the browser reported for this very script (admitted by `admitByHash`).
function scriptProofsFor(record, compiled) {
  const acknowledged = [...record.proofs.values()].filter((proof) => namesScript(proof, compiled));
  if (acknowledged.length) return acknowledged;
  const byHash = record.hashProofs.get(compiled.scriptId);
  return byHash && byHash.generatedHash === compiled.hash ? [byHash] : [];
}

/* NOSONAR */ function collectNodeMatches(record, event, parsed, frame, locate) {
  const matches = [];
  for (const compiled of parsed) {
    for (const proof of scriptProofsFor(record, compiled)) {
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
  return matches;
}

function hasUnverifiedScriptVersion(record, parsed) {
  return parsed.some((script) => !scriptProofsFor(record, script).length);
}

// What a callsite notification may say a call did: created, copied or inserted elements (the element's own record),
// moved an element the parser made, or changed one (dom-provenance.mjs).
const CREATIONS = new Set(['created-by', 'cloned-by', 'attached-by']);
const CHANGES = new Set(['moved-by', 'changed-by']);
const RELATIONSHIPS = new Set([...CREATIONS, ...CHANGES]);
// The names of what a change changed: at most eight distinct attribute names (lowercase letters, digits and `_.:-`,
// at most 64 characters), "text" or "children", and whether more were left out. A notification that says anything
// else, or names a change for a creation or a move, is refused. Returns null for a refused notification.
const CHANGE_WORD = /^[a-z][a-z0-9_.:-]{0,63}$/;
export function changeWords(data) {
  const { relationship, what, more } = data ?? {};
  if (more !== undefined && more !== true) return null;
  if (relationship !== 'changed-by')
    return what === undefined && more === undefined ? { words: [], more: false } : null;
  if (
    !Array.isArray(what) ||
    !what.length ||
    what.length > 8 ||
    !what.every((word) => typeof word === 'string' && CHANGE_WORD.test(word)) ||
    new Set(what).size !== what.length
  )
    return null;
  return { words: [...what], more: more === true };
}
const changeLabel = (event) => {
  if (!event.what?.words.length) return '';
  const more = event.what.more ? ' and more' : '';
  return ': ' + event.what.words.join(', ') + more;
};
// Which frames of a stack are named, and how. See resolveCallsite.
const NAMED = new Set(['proven', 'platform', 'external']);
const relationshipVerb = { 'attached-by': 'Inserted by', 'cloned-by': 'Copied by' };
const componentWords = {
  'platform-asset': "the portal's own script",
  'external-resource': 'a script from another site',
};
const unnamedWords = {
  'script-callsite-unmapped': 'a script not found in your sources',
  'script-callsite-ambiguous': 'a script that matches several of your sources',
  'script-hash-conflict': 'a script that matches several of your sources',
  'script-version-unverified': 'a script version that could not be verified',
};
const frameWords = (frame) => (frame.component ? componentWords[frame.component.kind] : unnamedWords[frame.reason]);
// One step of a chain per run of frames in the same place: a proven file and region, or the same component.
const frameKey = (frame) =>
  frame.state === 'proven'
    ? JSON.stringify(['proven', frame.ref.id, frame.region.start])
    : JSON.stringify([frame.state, frame.component?.key ?? frame.reason]);

/**
 * The facts of one DOM callsite from its resolved frames (innermost first; `frames[0]` made the DOM call).
 *
 * The rule, derivable from the export alone: the developer's code is code the export holds. The creator is the
 * innermost frame in such code (a "proven" frame: its parsed script maps to a local source). Frames inside it are what
 * it called to touch the DOM: the portal's own scripts, scripts of other sites, or code the export does not hold; they
 * are named as "through" steps, frame 0 as the "DOM call". Frames outside it that are named (proven, portal runtime or
 * another site) are its callers. Without a proven frame, the creator is frame 0 when the portal runtime or another site
 * made the call; any other unnamed frame 0 leaves the callsite unattributed, since that code may be the developer's.
 * No library is recognised by name: a library the export holds (a web file) is the developer's code like any other.
 */
function callsiteFacts(event, frames) {
  let at = frames.findIndex((frame) => frame.state === 'proven');
  if (at < 0) at = NAMED.has(frames[0]?.state) ? 0 : -1;
  if (at < 0) return null;
  const id = 'dom:' + event.id;
  const verb = relationshipVerb[event.relationship] ?? 'Created by';
  const named = frames[at];
  // Code that eval or new Function compiled is named by the place of that call.
  const own = named.evaluated ? 'code that this script evaluated' : 'this script';
  // A move or a change of an element the parser made is where the element stands or what it shows now, not what it
  // is: one context row that names the script and what changed. The element stays its template's tag.
  if (CHANGES.has(event.relationship)) return [changeFact(event, named, id, own)];
  const facts = [creatorFact(named, id, verb, own)];
  // Inside the creator: frame 0 made the DOM call, the frames between it and the creator carried it.
  for (let index = 0, last = null; index < at; index++) {
    const key = frameKey(frames[index]);
    if (key === last) continue;
    last = key;
    const words = frameWords(frames[index]);
    if (index === 0) facts.push(stepFact(id, frames[index], index, 'dom-call', 'DOM call in ' + words));
    else facts.push(stepFact(id, frames[index], index, 'through', 'Through ' + words));
  }
  // Outside it: the named callers, once per place.
  for (let index = at + 1, previous = frameKey(named); index < frames.length; index++) {
    const frame = frames[index],
      key = frameKey(frame);
    if (!NAMED.has(frame.state) || key === previous) continue;
    previous = key;
    facts.push(stepFact(id, frame, index, 'called-from', 'Called from ' + callerWords(frame)));
  }
  return facts;
}
const callerWords = (frame) => (frame.state === 'proven' ? 'this script' : frameWords(frame));
// The one context row of a move or change (see callsiteFacts).
function changeFact(event, named, id, own) {
  const label =
    (event.relationship === 'moved-by' ? 'Moved by ' : 'Changed by ') +
    (named.state === 'proven' ? own : componentWords[named.component.kind]) +
    changeLabel(event);
  if (named.state !== 'proven')
    return {
      id,
      dimension: 'context',
      proof: 'observed-dom-callsite',
      predicate: event.relationship,
      label,
      binding: named.component,
    };
  return {
    id,
    dimension: 'context',
    proof: 'observed-dom-callsite',
    predicate: event.relationship,
    label,
    sourceRefIds: [named.ref.id],
    region: named.region,
    renderSourceRevision: named.sourceRevision,
  };
}
// The creator's fact of a creation, copy or insertion (see callsiteFacts).
function creatorFact(named, id, verb, own) {
  if (named.state !== 'proven')
    return {
      id,
      dimension: 'context',
      proof: 'observed-dom-callsite',
      binding: named.component,
      label: verb + ' ' + componentWords[named.component.kind],
    };
  return {
    id,
    dimension: 'source',
    proof: 'observed-dom-callsite',
    sourceRefIds: [named.ref.id],
    region: named.region,
    renderSourceRevision: named.sourceRevision,
    ...(named.evaluated ? { label: verb + ' ' + own } : {}),
  };
}
// One step of a callsite's chain: a frame inside the creator or a named caller.
function stepFact(id, frame, index, predicate, label) {
  const fact = {
    id: id + ':' + predicate + ':' + index,
    dimension: 'context',
    proof: 'observed-dom-callsite',
    predicate,
    label,
  };
  if (frame.state === 'proven')
    Object.assign(fact, {
      sourceRefIds: [frame.ref.id],
      region: frame.region,
      renderSourceRevision: frame.sourceRevision,
    });
  else if (frame.component) fact.binding = frame.component;
  else fact.reason = frame.reason;
  return fact;
}

// The limits of a resolved callsite: a proven frame's truncated source map, or an unnamed frame up to the creator
// (`open`) that a truncated hash index may have left out.
function callsiteLimits(record, proven, open) {
  const reasons = [
    ...(proven.some((frame) => frame.limited) ? ['script-source-map-truncated'] : []),
    ...(record.hashIndex?.truncated && open.some((frame) => frame.state === 'unnamed')
      ? ['script-hash-index-limit']
      : []),
  ];
  return { truncated: reasons.length > 0, reasons };
}
// One ref per source, the creator's first: a caller in the same file is located by its own fact's region.
function callsiteSourceRefs(proven) {
  const firstRefs = new Map();
  for (const frame of proven) if (!firstRefs.has(frame.ref.id)) firstRefs.set(frame.ref.id, frame.ref);
  return [...firstRefs.values()].map((ref, index) => (index === 0 ? ref : { ...ref, relationship: 'called-from' }));
}
// The verdict of a callsite that a transport bound left without resolution: it alone is reported as limited.
const limitedCallsite = (reason) => ({
  sourceRefs: [],
  facts: [],
  reason,
  limits: { truncated: true, reasons: [reason] },
});

// The hash index of the export a provider returns, built once per index object and source revision.
const HASH_INDEXES = 4;
const NO_INDEX = Object.freeze({ sourceRevision: null, byHash: new Map(), truncated: false });

async function callDomRecord(record, command, functionDeclaration, value, unanswered) {
  const result = await command(
    'Runtime.callFunctionOn',
    { objectId: record.objectId, functionDeclaration, arguments: [{ value }], returnByValue: true },
    unanswered,
  );
  if (result === unanswered || result?.exceptionDetails) {
    record.closed = true;
    record.nodes.clear();
    return false;
  }
  return result !== null;
}

function validScriptProof(proof) {
  return !(
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
  );
}

function storeScriptProof(record, descriptor, request, proof, refs) {
  if (!validScriptProof(proof)) return;
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
  if (!address.urlKey && !address.url) return;
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
      descriptor.channel === 'lense-script-resource' || descriptor.channel === 'mirage-resource' || proof.external,
  });
}
// The loader of each frame of a frame tree; `urls`, when given, receives each frame's document URL.
const frameLoaders = (tree, urls = null) => {
  const found = new Map(),
    queue = [tree];
  let visited = 0;
  while (queue.length && visited++ < 256) {
    const item = queue.shift();
    if (item?.frame?.id) {
      found.set(item.frame.id, item.frame.loaderId);
      if (urls && typeof item.frame.url === 'string') {
        if (urls.size >= 256 && !urls.has(item.frame.id)) urls.delete(urls.keys().next().value);
        urls.set(item.frame.id, item.frame.url);
      }
    }
    if (item?.childFrames) queue.push(...item.childFrames.slice(0, Math.max(0, 256 - visited - queue.length)));
  }
  return found;
};

/** Pair an actual DOM callsite with parsed code and an acknowledged local implementation. */
export function createDomProvenanceTransport(context, configs) {
  const targets = new Map(configs.map((cfg) => [new URL(cfg.origin).origin, cfg]));
  const slot = '__paqviloDom_' + randomBytes(16).toString('hex'),
    secret = randomBytes(32).toString('hex'),
    // Authenticates a callsite notification and nothing else: it never unlocks the writer.
    notifyKey = randomBytes(32).toString('hex');
  const binding = '__paqviloDomEvent_' + randomBytes(16).toString('hex');
  // Closes a registry without its writer; unlike `secret` it cannot admit evidence.
  const releaseKey = randomBytes(32).toString('hex');
  // A same-origin about:blank or srcdoc frame (its location's origin is "null", its own origin the portal's) carries
  // no marks of its own, but its MutationObserver can watch the portal's document: it gets the response registry's
  // mark filter alone (markFilterOnly returns before any registry exists). The registry's claim and release methods
  // are written without the space here, so this bootstrap holds the recorder's signatures exactly once
  // (registryAccess locates them).
  const origins = JSON.stringify([...targets.keys()]);
  const markFilter = installPortalProvenanceRegistry
    .toString()
    .replaceAll('claim(value) {', 'claim(value){')
    .replaceAll('release(value) {', 'release(value){');
  const bootstrap = `if(${origins}.includes(location.origin))(${installDomProvenance.toString()})(${JSON.stringify({ slot, secret, notifyKey, binding, releaseKey })});else if(location.protocol==="about:"&&${origins}.includes(self.origin))(${markFilter})({markFilterOnly:true});\n//# sourceURL=paqvilo-tool://dom-provenance`;
  const registries = registryAccess({ kind: 'script', slot, bootstrap, secret, releaseKey });
  // Per target origin: `(route) => portal source index` of the export the developer works on (registerScriptSources).
  const scriptSources = new Map();
  const hashIndexes = new Map(),
    builtIndexes = new WeakMap();
  // The script hash index of `index`, built lazily: once per index object, and shared by source revision.
  const hashIndexOf = (index) => {
    if (!index || typeof index !== 'object' || !index.sources) return null;
    let built = builtIndexes.get(index);
    if (built) return built;
    const revision = typeof index.sourceRevision === 'string' ? index.sourceRevision : null;
    built = revision !== null ? hashIndexes.get(revision) : null;
    if (!built) {
      built = scriptHashIndex(index);
      if (revision !== null) {
        if (hashIndexes.size >= HASH_INDEXES) hashIndexes.delete(hashIndexes.keys().next().value);
        hashIndexes.set(revision, built);
      }
    }
    builtIndexes.set(index, built);
    return built;
  };
  return {
    slot,
    /**
     * Admits scripts the browser parsed in documents of `origin` by their content hash against the export the
     * provider returns: `provider(route)` resolves to the portal source index (`sources`, `sourceRevision`) for a
     * document path, as SourceInspector.sourceIndexFor does. Returns a function that removes the registration.
     */
    registerScriptSources(origin, provider) {
      const key = new URL(origin).origin;
      if (!targets.has(key) || typeof provider !== 'function') return () => {};
      scriptSources.set(key, provider);
      return () => {
        if (scriptSources.get(key) === provider) scriptSources.delete(key);
      };
    },
    async onAttach({ cdp, configure, report, clock = globalThis }) {
      const controller = new AbortController();
      setMaxListeners(0, controller.signal);
      const contexts = new Map(),
        requests = new Map(),
        descriptors = new Map(),
        // The records of the last cleared contexts by frame. Chromium clears and re-reports the contexts of an unchanged
        // document when it re-attaches the tab's DevTools session; the re-reported context of the same document
        // (same frame and loader) continues the record's parsed scripts, proofs and pending callsites.
        cleared = new Map();
      let loaders = new Map(),
        initial = new Map(),
        script,
        closed = false;
      // The URL of each frame's current document (its route selects the export's sources).
      const frameUrls = new Map();
      const { documents, tracking: documentTracking } = trackDefaultDocuments(targets);
      const lost = (error) => {
        if (!closed) report?.(error);
      };
      // `command` is declared below; the registry asks through it only after attachment.
      const registry = registries({ ask: (method, params) => command(method, params, null), lost });
      const tracking = [...documentTracking, ...registry.tracking];
      // A rejected command resolves to `rejected`; a command ended by disposal or the hang guard resolves to null.
      const command = async (method, params = {}, rejected = null) => {
        if (
          closed &&
          ![
            'Runtime.callFunctionOn',
            'Runtime.evaluate',
            'Runtime.getProperties',
            'Runtime.releaseObjectGroup',
            'Runtime.removeBinding',
            'Page.removeScriptToEvaluateOnNewDocument',
            'Debugger.disable',
          ].includes(method)
        )
          return null;
        // Cleanup commands sent during disposal are not ended by it.
        const ending = closed ? null : controller.signal;
        let release, timer;
        const expired = new Promise((resolve) => {
          release = () => resolve(null);
          timer = clock.setTimeout(() => {
            lost(new Error(`${method} did not answer within ${COMMAND_HANG_MS} ms`));
            release();
          }, COMMAND_HANG_MS);
          if (ending?.aborted) release();
          else ending?.addEventListener('abort', release, { once: true });
        });
        try {
          return await Promise.race([
            Promise.resolve()
              .then(() => cdp.send(method, params))
              .catch(() => rejected),
            expired,
          ]);
        } finally {
          clock.clearTimeout(timer);
          ending?.removeEventListener('abort', release);
        }
      };
      // In-flight sideband reads per document (`frameId:loaderId`); a callsite waits for them before it is unmapped.
      const reading = new Map();
      const settled = (record) =>
        !record.indexing &&
        !reading.get(record.frameId + ':' + record.loaderId) &&
        !acknowledgements.waiting(record.frameId);
      // A failed read is a loss only while its target still answers; closing the page, context or browser ends it quietly.
      const readLost = async (message, error) => {
        if (
          closed ||
          readEndedByContextClose(error) ||
          (await command('Page.getFrameTree', {}, unanswered)) === unanswered
        )
          return;
        lost(new Error(message));
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
        return {
          sourceRefId: mapping.sourceRefId,
          region: { start, end: start + 1, ...sourceLine(proof, mapping.sourceRefId, start, line, column) },
        };
      };
      // The 1-based line and column of a source offset: from the line starts of the source text when the export's
      // index has them, else, for a script served as the file is (one mapping, no shift of lines), the callsite's own.
      const sourceLine = (proof, sourceRefId, start, line, column) => {
        const starts = proof.sourceLines?.get(sourceRefId) ?? lineIndex?.get(sourceRefId);
        if (starts?.length) {
          let low = 0,
            high = starts.length - 1;
          while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (starts[middle] <= start) low = middle;
            else high = middle - 1;
          }
          return { line: low + 1, column: start - starts[low] + 1 };
        }
        return proof.external && proof.mappings.length === 1 ? { line: line + 1, column: column + 1 } : {};
      };
      // The line starts of the export's sources by ref id, from the hash index of the document being resolved.
      let lineIndex = null;
      // What one stack frame is: a place in a local source (proven), the portal runtime or another site (named by its
      // address), or code that cannot be named (with the reason).
      const resolveFrame = (record, event, frame) => {
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
        const matches = collectNodeMatches(record, event, parsed, frame, locate);
        const distinct = [
          ...new Map(
            matches.map((item) => [
              JSON.stringify([item.ref.key ?? item.ref.id, item.ref.contentRevision, item.region]),
              item,
            ]),
          ).values(),
        ];
        if (distinct.length > 1) return { state: 'unnamed', reason: 'script-callsite-ambiguous' };
        // An overlapping different script version cannot be attributed by URL alone.
        if (distinct.length === 1 && hasUnverifiedScriptVersion(record, parsed))
          return { state: 'unnamed', reason: 'script-version-unverified' };
        if (distinct.length === 1) return { state: 'proven', ...distinct[0] };
        if (parsed.some((script) => record.hashConflicts.has(script.scriptId)))
          return { state: 'unnamed', reason: 'script-hash-conflict' };
        // Not the export's: the portal runtime (request-classes.mjs, the one rule table) or another site, by address.
        let address;
        try {
          address = new URL(frame.url);
        } catch {
          return { state: 'unnamed', reason: 'script-callsite-unmapped' };
        }
        if (['http:', 'https:'].includes(address.protocol)) {
          const rule = platformRule(address, record.origin);
          // Solution web resources and code component bundles are platform addresses for code the developer ships,
          // not the portal runtime: without a proof they stay unnamed.
          if (rule?.class === 'platform-asset' && rule.platform !== 'web-resource')
            return {
              state: 'platform',
              component: { kind: 'platform-asset', key: 'platform-asset:' + rule.platform, name: rule.platform },
            };
          if (address.origin !== record.origin && !rule)
            // Another site's script: named by its origin only (no path or query).
            return {
              state: 'external',
              component: {
                kind: 'external-resource',
                key: 'external-resource:' + address.origin,
                name: address.host,
              },
            };
        }
        return { state: 'unnamed', reason: 'script-callsite-unmapped' };
      };
      const resolveNode = (record, event) => {
        if (event.limited) return limitedCallsite(event.limited);
        const first = event.frames[0];
        if (!first || first.barrier) return { sourceRefs: [], facts: [], reason: 'direct-callsite-unavailable' };
        const frames = [];
        lineIndex = record.hashIndex?.sourceLines ?? null;
        for (const frame of event.frames) {
          if (frame.barrier) break;
          const resolved = resolveFrame(record, event, frame);
          frames.push(frame.evaluated ? { ...resolved, evaluated: true } : resolved);
        }
        const creator = frames.findIndex((frame) => frame.state === 'proven');
        // A frame up to the creator (every frame without one) could still be proved by a proof or an index that is
        // on its way: the callsite waits for them.
        const open = frames.slice(0, creator < 0 ? frames.length : creator + 1);
        if (!settled(record) && open.some((frame) => frame.state !== 'proven')) return null;
        const facts = callsiteFacts(event, frames);
        const proven = frames.filter((frame) => frame.state === 'proven');
        const limits = callsiteLimits(record, proven, open);
        if (!facts) return { sourceRefs: [], facts: [], reason: frames[0].reason, limits };
        return { sourceRefs: callsiteSourceRefs(proven), limits, facts };
      };
      /* NOSONAR: single-pass routine, splitting it would change shared state */ const flush = async (record) => {
        record.dirty = true;
        if (record.flushing || !record.objectId || closed || record.closed) return;
        record.flushing = true;
        try {
          // A rejected call or a page-side exception means the claimed object no
          // longer answers: the record closes instead of resending to it.
          do {
            record.dirty = false;
            if (loaders.get(record.frameId) !== record.loaderId) break;
            // New bindings can overflow the pending queue while a preceding
            // batch is awaiting its protocol acknowledgement.
            if (record.limitReason && !record.limitSent) {
              if (
                !(await callDomRecord(
                  record,
                  command,
                  'function(reason){return this.markLimited(reason)}',
                  record.limitReason,
                  unanswered,
                ))
              )
                break;
              record.limitSent = true;
            }
            const batch = [];
            // Callsites the transport had no room for get their verdict first: only they are reported as limited.
            for (const [id, event] of record.evicted) {
              if (batch.length >= 64) break;
              batch.push({ id, proof: resolveNode(record, event) });
              record.evicted.delete(id);
            }
            for (const [id, event] of record.nodes) {
              if (batch.length >= 64) break;
              const proof = resolveNode(record, event);
              if (proof) {
                batch.push({ id, proof });
                record.nodes.delete(id);
              }
            }
            if (!batch.length) break;
            await callDomRecord(
              record,
              command,
              'function(entries){return this.resolveMany(entries)}',
              batch,
              unanswered,
            );
            if (record.closed) break;
            if (record.nodes.size || record.evicted.size) record.dirty = true;
          } while (record.dirty && !closed && !record.closed);
        } finally {
          // Nodes left pending are flushed again when a proof arrives or the last read of their document settles.
          record.flushing = false;
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
        if (size > 8 * 1024 * 1024) {
          lost(new Error('a script provenance descriptor is larger than 8 MiB, so its scripts are not identified'));
          return false;
        }
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
          // Script proofs beyond this bound are not admitted: callsites that stay unproved say so.
          if (descriptor.scriptProofs.length > 128) record.limitReason ??= 'script-proof-index-limit';
          for (const proof of descriptor.scriptProofs.slice(0, 128))
            storeScriptProof(record, descriptor, request, proof, refs);
        }
        flush(record).catch(() => {});
      };
      // A parsed script the transport has no acknowledged proof for is admitted when its hash, reported by the
      // browser for the code it compiled, is the hash of exactly one place in the export (scriptHashIndex). The page
      // cannot write that hash; a hash two places share is a conflict and proves nothing.
      const admitScriptByHash = (record, script) => {
        const index = record.hashIndex;
        if (!index || record.hashProofs.has(script.scriptId) || record.hashConflicts.has(script.scriptId)) return;
        const entry = index.byHash.get(script.hash);
        if (!entry) return;
        if (entry.conflict) {
          if (record.hashConflicts.size >= 512) record.hashConflicts.delete(record.hashConflicts.values().next().value);
          record.hashConflicts.add(script.scriptId);
          return;
        }
        if (record.hashProofs.size >= 512) {
          record.limitReason ??= 'script-proof-index-limit';
          record.hashProofs.delete(record.hashProofs.keys().next().value);
        }
        record.hashProofs.set(script.scriptId, {
          id: 'hash:' + script.scriptId,
          scriptId: script.scriptId,
          generatedHash: script.hash,
          url: script.url,
          urlKey: script.urlKey,
          lineStarts: entry.lineStarts,
          linesTruncated: entry.linesTruncated,
          mappingsTruncated: false,
          mappings: entry.mappings,
          sourceLines: index.sourceLines,
          refs: new Map([[entry.ref.id, entry.ref]]),
          sourceRevision: index.sourceRevision,
          // Bound to this very parsed script by its id: its place in the document needs no second check.
          external: true,
        });
      };
      // The export's script hash index for a document, read once from the registered provider (registerScriptSources).
      const indexScripts = (record) => {
        if (record.hashIndex || record.indexing || closed) return;
        const provider = scriptSources.get(record.origin);
        if (!provider) return;
        let route = '/';
        try {
          route = new URL(frameUrls.get(record.frameId)).pathname;
        } catch {
          /* The document address is not known yet: the start route selects the sources. */
        }
        record.indexing = true;
        Promise.resolve()
          .then(() => provider(route))
          .then(
            (index) => {
              record.hashIndex = hashIndexOf(index) ?? NO_INDEX;
            },
            () => {
              record.hashIndex = NO_INDEX;
              lost(new Error("the export's script sources could not be read to identify parsed scripts"));
            },
          )
          .finally(() => {
            record.indexing = false;
            if (closed || record.closed) return;
            for (const parsedScript of record.scripts.values()) admitScriptByHash(record, parsedScript);
            flush(record).catch(() => {});
          });
      };
      // The re-reported context of an unchanged document continues the record of its cleared context. Entries the new
      // context received since it was created are newer and win; each index keeps its bound.
      const adopt = (record) => {
        const previous = cleared.get(record.frameId);
        cleared.delete(record.frameId);
        if (previous?.loaderId !== record.loaderId) return false;
        for (const [field, bound] of [
          ['scripts', 512],
          ['proofs', 256],
          ['nodes', 2048],
          ['evicted', 16384],
          ['hashProofs', 512],
        ])
          record[field] = new Map([...previous[field], ...record[field]].slice(-bound));
        record.hashConflicts = new Set([...previous.hashConflicts, ...record.hashConflicts].slice(-512));
        record.hashIndex ??= previous.hashIndex;
        record.limitReason ??= previous.limitReason;
        record.limitSent = previous.limitSent;
        return true;
      };
      // A callsite notified while Chromium re-attached the session was dropped: the page still holds it pending, and its
      // notification passes the same checks as a delivered one.
      const recover = async (record) => {
        const answer = await command('Runtime.callFunctionOn', {
          objectId: record.objectId,
          functionDeclaration: 'function(){return this.pendingCallsites()}',
          returnByValue: true,
        });
        const text = answer?.result?.value;
        if (typeof text === 'string' && text.length)
          for (const payload of text.split('\n', 2048))
            called({ name: binding, executionContextId: record.id, payload });
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
          origin: execution.origin,
          frameId: execution.auxData.frameId,
          loaderId: loaders.get(execution.auxData.frameId),
          objectId: null,
          scripts: new Map(),
          proofs: new Map(),
          nodes: new Map(),
          // Callsites the node bound pushed out, by id: each still receives its own limited verdict.
          evicted: new Map(),
          // Proofs admitted by content hash, by parsed script id, and the scripts whose hash is a conflict.
          hashProofs: new Map(),
          hashConflicts: new Set(),
          hashIndex: null,
          indexing: false,
          closed: false,
          flushing: false,
        };
        contexts.set(record.id, record);
        (async () => {
          const tree = (await command('Page.getFrameTree'))?.frameTree;
          record.loaderId = frameLoaders(tree, frameUrls).get(record.frameId);
          // A document that was open before the bootstrap was registered has no registry to retire.
          if (record.loaderId && record.loaderId === initial.get(record.frameId)) documents.delete(record.id);
          if (!record.loaderId || record.loaderId === initial.get(record.frameId)) return;
          loaders.set(record.frameId, record.loaderId);
          const returned = adopt(record);
          const writer = await registry.claim(record.id, () => record.closed || closed);
          if (!writer) return;
          // The record was retired while its claim was answered: the writer handle is not kept.
          if (closed || record.closed) {
            await command('Runtime.releaseObject', { objectId: writer });
            return;
          }
          record.objectId = writer;
          if (returned) await recover(record);
          indexScripts(record);
          admitDescriptors(record);
        })().catch(() => {});
      };
      const destroy = ({ executionContextId }) => {
        const record = contexts.get(executionContextId);
        if (record) {
          record.closed = true;
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
        const compiled = {
          ...address,
          scriptId: event.scriptId,
          hash: event.hash,
          startLine: event.startLine ?? 0,
          startColumn: event.startColumn ?? 0,
          endLine: event.endLine ?? 0,
          endColumn: event.endColumn ?? 0,
          hasSourceURL: Boolean(event.hasSourceURL),
        };
        record.scripts.set(event.scriptId, compiled);
        admitScriptByHash(record, compiled);
        indexScripts(record);
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
          data.key !== notifyKey ||
          typeof data.id !== 'string' ||
          !data.id.length ||
          data.id.length > 128 ||
          !RELATIONSHIPS.has(data.relationship) ||
          !Array.isArray(data.frames)
        )
          return;
        const what = changeWords(data);
        if (what === null) return;
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
                  frame.column <= 0 ||
                  (frame.evaluated !== undefined && frame.evaluated !== true))),
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
                ...(frame.evaluated === true ? { evaluated: true } : {}),
              },
        );
        if (record.nodes.size >= 2048 && !record.nodes.has(data.id)) {
          record.limitReason ??= 'dom-evidence-transport-limit';
          const oldest = record.nodes.keys().next().value;
          record.nodes.delete(oldest);
          // Its node is told so on the next flush; beyond this bound only the document-wide limit report remains.
          if (record.evicted.size >= 16384) record.evicted.delete(record.evicted.keys().next().value);
          record.evicted.set(oldest, { id: oldest, limited: 'dom-evidence-transport-limit' });
        }
        record.nodes.set(data.id, { id: data.id, relationship: data.relationship, what, frames });
        flush(record).catch(() => {});
      };
      // Chromium ends the contexts of a frame's document before it reports the frame's next document, and announces the
      // new document's context after that report: a context of the frame still live then holds the reported document in
      // a reused window (see `reused`). Only a document the transport would instrument lost its provenance.
      const retireReused = (frame) => {
        for (const record of contexts.values())
          if (record.frameId === frame.id && !record.closed) {
            destroy({ executionContextId: record.id });
            if (targets.has(originOf(frame.url))) registry.reused(frame.id);
          }
      };
      const navigated = ({ frame, type }) => {
        if (!frame?.id) return;
        // A back/forward cache restore re-reports the restored document's own context before its navigation; that
        // context is claimed as usual.
        if (type !== 'BackForwardCacheRestore') retireReused(frame);
        // Acknowledgements still waiting in this frame are kept: Fetch answers in the browser process, so the new
        // document's own script can be acknowledged before this renderer notification arrives. Each one is admitted into
        // the document its request notification names.
        loaders.set(frame.id, frame.loaderId);
        if (typeof frame.url === 'string') {
          if (frameUrls.size >= 256 && !frameUrls.has(frame.id)) frameUrls.delete(frameUrls.keys().next().value);
          frameUrls.set(frame.id, frame.url);
        }
      };
      const detached = ({ frameId }) => {
        loaders.delete(frameId);
        frameUrls.delete(frameId);
        registry.forget(frameId);
        cleared.delete(frameId);
        acknowledgements.forget(frameId);
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
      const acknowledgements = createResponseProofQueue({
        requests,
        // An acknowledgement that leaves the queue may name a replaced document: the frame's waiting callsites
        // receive their verdict now.
        admit: (frameId, loaderId, descriptor, request) => {
          const admitted = ingest(frameId, loaderId, descriptor, request);
          for (const record of contexts.values()) if (record.frameId === frameId) flush(record).catch(() => {});
          return admitted;
        },
        // A discarded acknowledgement is a lost proof: report it and give the frame's waiting callsites their verdict.
        evicted: (frameId) => {
          lost(new Error('a script provenance acknowledgement was discarded at the queue limit'));
          for (const record of contexts.values()) if (record.frameId === frameId) flush(record).catch(() => {});
        },
      });
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
        const documentKey = request.frameId + ':' + request.loaderId;
        reading.set(documentKey, (reading.get(documentKey) ?? 0) + 1);
        (async () => {
          const url = new URL('/_sim/api/page-provenance', origin);
          url.searchParams.set('proof', proofId);
          const answer = await context.request.get(url.href, {
            headers: { 'x-paqvilo-provenance-access': access },
            maxRedirects: 0,
            timeout: COMMAND_HANG_MS,
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
        })()
          .catch((error) => readLost('the script provenance read did not complete', error))
          .finally(() => {
            const left = (reading.get(documentKey) ?? 1) - 1;
            if (left) reading.set(documentKey, left);
            else reading.delete(documentKey);
            // The last read of a document settled: its pending callsites receive their verdict now.
            if (!left)
              for (const record of contexts.values())
                if (record.frameId + ':' + record.loaderId === documentKey) flush(record).catch(() => {});
          });
      };
      const listeners = [
        ['Runtime.executionContextCreated', created],
        ['Runtime.executionContextDestroyed', destroy],
        [
          'Runtime.executionContextsCleared',
          () => {
            // Merged per frame: a second clear before the context returns keeps the record of the first.
            for (const record of contexts.values()) {
              record.closed = true;
              if (!record.loaderId) continue;
              cleared.delete(record.frameId);
              if (cleared.size >= 128) cleared.delete(cleared.keys().next().value);
              cleared.set(record.frameId, record);
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
        for (const [event, handler] of listeners) cdp.off(event, handler);
        // The bootstrap is removed first, while contexts are still tracked: a document that commits during disposal
        // announces its context before the removal is answered, so its registry is retired below as well.
        if (script?.identifier)
          await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
        for (const [event, handler] of tracking) cdp.off(event, handler);
        // A registry is retired through its verified `release`, not through its claimed writer: the writer of a claim
        // that is still in flight never reaches this transport, and a claim that follows the release finds it closed.
        await Promise.allSettled([...documents].map((contextId) => registry.release(contextId)));
        controller.abort();
        documents.clear();
        contexts.clear();
        cleared.clear();
        requests.clear();
        acknowledgements.clear();
        descriptors.clear();
        reading.clear();
        frameUrls.clear();
        await Promise.allSettled([
          command('Runtime.removeBinding', { name: binding }),
          command('Runtime.releaseObjectGroup', { objectGroup: slot }),
          command('Debugger.disable'),
        ]);
      };
      try {
        await configure('Page.enable');
        loaders = frameLoaders((await configure('Page.getFrameTree')).frameTree, frameUrls);
        initial = new Map(loaders);
        for (const [event, handler] of [...tracking, ...listeners]) cdp.on(event, handler);
        await configure('Runtime.addBinding', { name: binding });
        script = await configure('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });
        await configure('Debugger.enable');
        // Debugger reports parsed scripts; it never pauses the page, also not at an authored `debugger` statement.
        await configure('Debugger.setSkipAllPauses', { skip: true });
        await configure('Runtime.enable');
      } catch (error) {
        await dispose();
        throw error;
      }
      return {
        dispose,
        publishDescriptor: (frameId, loaderId, proof, request) => ingest(frameId, loaderId, proof, request),
        publishProvenance(event, proof) {
          // Only a script request's notification is admitted above, so another acknowledgement could never be matched.
          if (event.resourceType !== 'Script') return false;
          return acknowledgements.fulfill(event, proof);
        },
      };
    },
  };
}
