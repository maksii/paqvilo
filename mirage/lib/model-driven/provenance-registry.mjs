// Metadata-only ownership. Renderers hold the writer; consumers receive only
// the frozen reader. DOM attributes never establish a registry binding.
const nativeString = String,
  replace = Function.prototype.call.bind(String.prototype.replace),
  lower = Function.prototype.call.bind(String.prototype.toLowerCase),
  safeInteger = Number.isSafeInteger;
const normalize = (value) => lower(replace(nativeString(value ?? ''), /[{}]/g, ''));
export const modelDrivenKey = (kind, id) => `${kind}:${normalize(id)}`;
export const modelDrivenControlKey = (formId, control, region = 'body') =>
  `control:${normalize(formId)}:${normalize(control?.uniqueId ?? control?.id ?? (safeInteger(control?.ordinal) ? `@${control.ordinal}` : (control?.attributes?.datafieldname ?? control?.name ?? control)))}:${region}`;

export function createModelDrivenProvenanceRegistry(document) {
  // Capture before customizations run. Neither prototype replacements nor a
  // caller's edited query result may become renderer-owned node evidence.
  const view = document.defaultView;
  const call = Function.prototype.call.bind(Function.prototype.call);
  const weakGet = call.bind(null, WeakMap.prototype.get),
    weakSet = call.bind(null, WeakMap.prototype.set),
    weakDelete = call.bind(null, WeakMap.prototype.delete),
    setHas = call.bind(null, Set.prototype.has),
    setAdd = call.bind(null, Set.prototype.add),
    push = call.bind(null, Array.prototype.push),
    slice = call.bind(null, String.prototype.slice),
    test = call.bind(null, RegExp.prototype.test);
  const NativeWeakMap = WeakMap,
    NativeSet = Set,
    freeze = Object.freeze,
    define = Object.defineProperty,
    descriptor = Object.getOwnPropertyDescriptor,
    descriptors = Object.getOwnPropertyDescriptors,
    keys = Object.keys,
    prototype = Object.getPrototypeOf,
    objectPrototype = Object.prototype,
    isArray = Array.isArray,
    finite = Number.isFinite,
    clone = globalThis.structuredClone.bind(globalThis);
  const ownerDocument = descriptor(view.Node.prototype, 'ownerDocument').get,
    connected = descriptor(view.Node.prototype, 'isConnected').get,
    nodeType = descriptor(view.Node.prototype, 'nodeType').get,
    parentElement = descriptor(view.Node.prototype, 'parentElement').get,
    getRoot = view.Node.prototype.getRootNode,
    shadowHost = descriptor(view.ShadowRoot.prototype, 'host').get;
  const own = (object, key) => object && descriptor(object, key)?.value;
  const sameDocument = (node) => {
    try {
      return call(ownerDocument, node) === document;
    } catch {
      return false;
    }
  };
  const append = (target, rows, transform) => {
    if (!isArray(rows)) return;
    for (let index = 0; index < rows.length; index++) push(target, transform ? transform(rows[index]) : rows[index]);
  };
  const bindings = new NativeWeakMap();
  let generation = 0,
    currentLease = freeze({ generation: 0 });
  let currentContext = { state: 'loading' };
  const metadata = (value, depth = 0) => {
    if (depth > 6) return undefined;
    if (typeof value === 'string') return value.length <= 2048 ? value : slice(value, 0, 2048);
    if (typeof value === 'boolean' || value === null || (typeof value === 'number' && finite(value))) return value;
    if (isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length && index < 128; index++)
        push(result, metadata(own(value, index), depth + 1));
      return result;
    }
    if (!value || prototype(value) !== objectPrototype) return undefined;
    const result = {},
      fields = descriptors(value),
      names = keys(fields);
    for (let index = 0; index < names.length; index++) {
      const key = names[index];
      if (test(/^(?:record|row|value|values|user|userId|recordId|entityId|text|label|url|query|href)$/i, key)) continue;
      const item = metadata(own(fields[key], 'value'), depth + 1);
      if (item !== undefined)
        define(result, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const bind = (node, input, lease = currentLease) => {
    if (!sameDocument(node)) return () => {};
    const entry = freeze({
      owner: metadata(own(input, 'owner')),
      context: metadata(own(input, 'context') ?? []),
      facts: metadata(own(input, 'facts') ?? []),
      sourceKeys: metadata(own(input, 'sourceKeys') ?? []),
      sourceRefs: metadata(own(input, 'sourceRefs') ?? []),
      availability: metadata(own(input, 'availability') ?? []),
      coverage: own(input, 'coverage') === 'self' ? 'self' : 'subtree',
      lifetime: own(input, 'lifetime') === 'document' ? 'document' : 'ui',
      lease,
      generation: ++generation,
    });
    weakSet(bindings, node, entry);
    return () => {
      if (weakGet(bindings, node) === entry) weakDelete(bindings, node);
    };
  };
  const parent = (node) => {
    const parent = call(parentElement, node);
    if (parent) return parent;
    try {
      return call(shadowHost, call(getRoot, node));
    } catch {
      return null;
    }
  };
  const query = (node, { scope, anchorGeneration } = {}) => {
    const result = {
      version: 1,
      mode: 'local',
      scope,
      anchorGeneration,
      facts: [],
      contextFacts: [],
      sourceKeys: [],
      sourceRefs: [],
      availability: [],
      providerGeneration: 0,
    };
    if (!sameDocument(node) || !call(connected, node)) {
      push(result.availability, { reason: 'node-document-unavailable' });
      return result;
    }
    let selected = false,
      depth = 0;
    const seen = new NativeSet();
    for (
      let element = call(nodeType, node) === 1 ? node : call(parentElement, node);
      element && depth++ < 128;
      element = parent(element)
    ) {
      if (!sameDocument(element) || setHas(seen, element)) break;
      setAdd(seen, element);
      const entry = weakGet(bindings, element);
      if (!entry) continue;
      if (entry.lifetime !== 'document' && entry.lease !== currentLease) {
        if (!selected && entry.owner && (entry.coverage !== 'self' || element === node)) {
          push(result.facts, {
            subject: 'selection',
            predicate: 'identity',
            dimension: 'owner',
            kind: 'observed',
            proof: 'mirage-registry',
            binding: entry.owner,
            scope,
            stale: true,
            reason: 'render-lease-expired',
          });
          append(result.sourceRefs, entry.sourceRefs, (ref) => ({ ...ref, sourceRevision: scope?.sourceRevision }));
          append(result.sourceKeys, entry.sourceKeys);
          push(result.availability, { capability: 'selected-owner', reason: 'render-lease-expired' });
          result.providerGeneration = entry.generation;
          selected = true;
        }
        continue;
      }
      if (entry.generation > result.providerGeneration) result.providerGeneration = entry.generation;
      const fact = (binding, dimension, predicate = 'identity') => ({
        subject: dimension === 'owner' ? 'selection' : binding.key,
        predicate,
        dimension,
        kind: 'observed',
        proof: 'mirage-registry',
        binding,
        scope,
      });
      if (!selected && entry.owner && (entry.coverage !== 'self' || element === node)) {
        push(result.facts, fact(entry.owner, 'owner'));
        append(result.sourceKeys, entry.sourceKeys);
        append(result.sourceRefs, entry.sourceRefs, (ref) => ({ ...ref, sourceRevision: scope?.sourceRevision }));
        append(result.availability, entry.availability);
        append(result.facts, entry.facts, (item) => ({ ...item, scope }));
        selected = true;
      } else if (entry.owner) push(result.contextFacts, fact(entry.owner, 'enclosing', 'contains'));
      append(result.contextFacts, entry.context, (item) => fact(item, 'context', item.relationship ?? 'contains'));
    }
    const sourceKeys = [],
      seenKeys = new NativeSet();
    for (let index = 0; index < result.sourceKeys.length; index++) {
      const key = result.sourceKeys[index];
      if (!setHas(seenKeys, key)) {
        setAdd(seenKeys, key);
        push(sourceKeys, key);
      }
    }
    result.sourceKeys = sourceKeys;
    if (!selected) push(result.availability, { reason: 'node-owner-not-bound' });
    return clone(result);
  };
  const reader = freeze({
    version: 1,
    kind: 'mirage-private-registry',
    query,
    context: () => clone({ version: 1, ...currentContext }),
  });
  return freeze({
    reader,
    bind,
    beginUI() {
      currentLease = freeze({ generation: ++generation });
      currentContext = { state: 'loading' };
      return currentLease;
    },
    setContext(input, lease = currentLease) {
      if (lease !== currentLease) return false;
      currentContext = metadata(input);
      return true;
    },
    currentLease: () => currentLease,
    update(node, input, lease = currentLease) {
      if (lease !== currentLease) return false;
      bind(node, input, lease);
      return true;
    },
    install(target = view) {
      const existing = descriptor(target, '__paqviloMirageProvenance');
      if (existing) return existing.value === reader;
      define(target, '__paqviloMirageProvenance', {
        value: reader,
        configurable: false,
        writable: false,
      });
      return true;
    },
  });
}
