/** Early owned-browser instrumentation. Arguments/text/values never enter evidence. */
export function installDomProvenance({ slot, secret, binding, limit = 10000 } = {}) {
  if (!slot || !secret || !binding || Object.hasOwn(window, slot)) return;
  const apply = Reflect.apply,
    describe = Object.getOwnPropertyDescriptor,
    define = Object.defineProperty,
    freeze = Object.freeze;
  const NativeError = Error,
    NativeMap = Map,
    NativeWeakMap = WeakMap,
    NativeSet = Set;
  const NativeEncoder = TextEncoder,
    NativeBytes = Uint8Array,
    NativeWords = Uint32Array,
    NativeEvent = CustomEvent;
  const clone = structuredClone,
    stringify = JSON.stringify,
    array = Array.isArray;
  const stringSlice = String.prototype.slice,
    stringIndex = String.prototype.indexOf,
    stringIncludes = String.prototype.includes,
    lower = String.prototype.toLowerCase;
  const minimum = Math.min;
  const numberString = Number.prototype.toString,
    pad = String.prototype.padStart,
    regexExec = RegExp.prototype.exec;
  const then = Promise.prototype.then;
  const mapGet = Map.prototype.get,
    mapSet = Map.prototype.set,
    mapHas = Map.prototype.has,
    mapDelete = Map.prototype.delete,
    mapClear = Map.prototype.clear;
  const mapSize = describe(Map.prototype, 'size').get;
  const weakGet = WeakMap.prototype.get,
    weakSet = WeakMap.prototype.set,
    weakHas = WeakMap.prototype.has;
  const setHas = Set.prototype.has,
    setAdd = Set.prototype.add;
  const dispatch = EventTarget.prototype.dispatchEvent,
    encode = TextEncoder.prototype.encode;
  const cryptoHost = crypto,
    subtle = cryptoHost.subtle,
    digest = subtle?.digest,
    uuid = cryptoHost.randomUUID,
    random = cryptoHost.getRandomValues;
  const byteLength = describe(ArrayBuffer.prototype, 'byteLength').get;
  const emit = window[binding],
    prepare = describe(NativeError, 'prepareStackTrace'),
    stackLimit = describe(NativeError, 'stackTraceLimit');
  const errorString = describe(NativeError.prototype, 'toString');
  const sameDescriptor = (a, b) => {
    const names = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
    for (let i = 0; i < names.length; i++) if (a?.[names[i]] !== b?.[names[i]]) return false;
    return true;
  };
  const get = (map, key) => apply(mapGet, map, [key]),
    has = (map, key) => apply(mapHas, map, [key]);
  const stored = (node) => apply(weakGet, records, [node]);
  const hex = (value, width) => apply(pad, apply(numberString, value, [16]), [width, '0']);
  const randomId = () => {
    if (uuid) return apply(uuid, cryptoHost, []);
    const words = apply(random, cryptoHost, [new NativeWords(4)]);
    let text = '';
    for (let i = 0; i < 4; i++) text += hex(words[i], 8);
    return text;
  };
  const getters = {};
  for (const name of [
    'nodeType',
    'parentNode',
    'firstChild',
    'lastChild',
    'previousSibling',
    'nextSibling',
    'ownerDocument',
    'isConnected',
  ])
    getters[name] = describe(Node.prototype, name)?.get;
  const readNode = (node, name) => (node && getters[name] ? apply(getters[name], node, []) : null);
  const nodeType = (node) => {
    try {
      return readNode(node, 'nodeType');
    } catch {
      return null;
    }
  };
  let records = new NativeWeakMap();
  const pending = new NativeMap(),
    restorers = [];
  const maximum = Number.isSafeInteger(limit) && limit >= 0 ? Math.min(limit, 10000) : 10000;
  let closed = false,
    transportLimit = null,
    claimed = false,
    truncated = false;
  const stackFrames = () => {
    if (
      !sameDescriptor(prepare, describe(NativeError, 'prepareStackTrace')) ||
      !sameDescriptor(stackLimit, describe(NativeError, 'stackTraceLimit')) ||
      !sameDescriptor(errorString, describe(NativeError.prototype, 'toString'))
    )
      return { frames: [], reason: 'custom-stack-format' };
    const stack = new NativeError().stack;
    if (typeof stack !== 'string' || stack.length > 32768) return { frames: [], reason: 'stack-unavailable' };
    const frames = [];
    let offset = apply(stringIndex, stack, ['\n']) + 1;
    for (let i = 1; offset > 0 && offset < stack.length && i < 25; i++) {
      const end = apply(stringIndex, stack, ['\n', offset]);
      const line = apply(stringSlice, stack, [offset, end < 0 ? stack.length : end]);
      offset = end < 0 ? 0 : end + 1;
      if (apply(stringIncludes, line, ['paqvilo-tool://'])) continue;
      const match = apply(regexExec, /((?:https?:\/\/|file:\/\/\/)[^\s]*):(\d+):(\d+)\)?$/, [line]);
      if (!match) {
        frames[frames.length] = { barrier: true };
        break;
      }
      const raw = match[1];
      let pathEnd = raw.length;
      for (let j = 0; j < raw.length; j++)
        if (raw[j] === '?' || raw[j] === '#') {
          pathEnd = j;
          break;
        }
      const url = apply(stringSlice, raw, [0, pathEnd]);
      if (url.length > 4096) {
        frames[frames.length] = { barrier: true };
        break;
      }
      const key = digest ? apply(digest, subtle, ['SHA-256', apply(encode, new NativeEncoder(), [raw])]) : null;
      frames[frames.length] = { url, key, line: +match[2], column: +match[3] };
      if (frames.length >= 12) break;
    }
    return { frames, reason: !frames.length || frames[0].barrier ? 'callsite-unavailable' : null };
  };
  const lazyStack = () => {
    let capture;
    return () => (capture ??= stackFrames());
  };
  const remember = (node, relationship, capture) => {
    if (closed || nodeType(node) !== 1 || apply(weakHas, records, [node])) return;
    const record = { id: randomId(), relationship, reason: null, proof: null };
    apply(weakSet, records, [node, record]);
    if (apply(mapSize, pending, []) >= maximum) {
      truncated = true;
      record.reason = 'dom-evidence-limit';
      return;
    }
    const observation = capture();
    record.reason = observation.reason;
    if (observation.reason || typeof emit !== 'function') return;
    apply(mapSet, pending, [record.id, record]);
    const frames = [];
    let remaining = observation.frames.length;
    const finish = (index, frame) => {
      frames[index] = frame;
      if (--remaining || closed || !has(pending, record.id)) return;
      try {
        apply(emit, window, [apply(stringify, JSON, [{ version: 1, secret, id: record.id, relationship, frames }])]);
      } catch {
        record.reason = 'callsite-unavailable';
        apply(mapDelete, pending, [record.id]);
      }
    };
    for (let i = 0; i < observation.frames.length; i++) {
      const frame = observation.frames[i];
      if (frame.barrier) {
        finish(i, { barrier: true });
        continue;
      }
      const complete = (urlKey) => finish(i, { url: frame.url, urlKey, line: frame.line, column: frame.column });
      if (!frame.key) {
        complete(null);
        continue;
      }
      try {
        apply(then, frame.key, [
          (buffer) => {
            const bytes = new NativeBytes(buffer),
              length = apply(byteLength, buffer, []);
            let text = '';
            for (let j = 0; j < length; j++) text += hex(bytes[j], 2);
            complete(text);
          },
          () => complete(null),
        ]);
      } catch {
        record.reason = 'callsite-unavailable';
        apply(mapDelete, pending, [record.id]);
      }
    }
  };
  const descendants = (root, budget = 2000) => {
    const nodes = [],
      stack = [root];
    let visited = 0;
    while (stack.length && visited < budget) {
      const node = stack[stack.length - 1];
      stack.length--;
      if (!node || !nodeType(node)) continue;
      visited++;
      if (nodeType(node) === 1) nodes[nodes.length] = node;
      let child = readNode(node, 'lastChild');
      for (; child && stack.length + visited < budget; child = readNode(child, 'previousSibling'))
        stack[stack.length] = child;
      if (child) truncated = true;
    }
    if (stack.length) truncated = true;
    return { nodes, visited };
  };
  const markNodes = (nodes, relationship) => {
    const capture = lazyStack();
    for (let i = 0; i < nodes.length; i++) remember(nodes[i], relationship, capture);
  };
  const incoming = (args, firstOnly = false) => {
    const nodes = [],
      seen = new NativeSet(),
      count = firstOnly ? minimum(1, args.length) : args.length;
    let visited = 0;
    for (let i = 0; i < count; i++) {
      if (visited >= 2000) {
        truncated = true;
        break;
      }
      if (!nodeType(args[i])) {
        visited++;
        continue;
      }
      const found = descendants(args[i], 2000 - visited),
        children = found.nodes;
      visited += found.visited;
      for (let j = 0; j < children.length; j++)
        if (!apply(setHas, seen, [children[j]])) {
          apply(setAdd, seen, [children[j]]);
          nodes[nodes.length] = children[j];
        }
    }
    return nodes;
  };
  // Capture the actual insertion interval, never diff two truncated whole-parent scans.
  const range = (root, left, right) => ({ root, left, right });
  const markRange = (prior) => {
    if (
      !prior?.root ||
      (prior.left && readNode(prior.left, 'parentNode') !== prior.root) ||
      (prior.right && readNode(prior.right, 'parentNode') !== prior.root)
    )
      return;
    const nodes = [];
    let visited = 0;
    let node = prior.left ? readNode(prior.left, 'nextSibling') : readNode(prior.root, 'firstChild');
    while (node && node !== prior.right && visited < 2000) {
      const found = descendants(node, 2000 - visited),
        children = found.nodes;
      visited += found.visited;
      for (let i = 0; i < children.length; i++) nodes[nodes.length] = children[i];
      node = readNode(node, 'nextSibling');
    }
    if (node && node !== prior.right) truncated = true;
    markNodes(nodes, 'created-by');
  };
  const restoreProperty = (prototype, name, part, wrapper, original) => {
    const current = describe(prototype, name);
    if (current?.[part] === wrapper && current.configurable) define(prototype, name, { ...current, [part]: original });
  };
  const wrapMethod = (prototype, name, after, before) => {
    const descriptor = describe(prototype, name);
    if (typeof descriptor?.value !== 'function' || !descriptor.configurable) return;
    const original = descriptor.value;
    const wrapper = function (...args) {
      let prior;
      if (!closed)
        try {
          prior = before?.(this, args);
        } catch {
          /* Native method validates receivers. */
        }
      const value = apply(original, this, args);
      if (!closed)
        try {
          after(this, value, prior, args);
        } catch {
          /* Preserve native behavior. */
        }
      return value;
    };
    define(wrapper, 'name', { value: original.name });
    define(wrapper, 'length', { value: original.length });
    define(prototype, name, { ...descriptor, value: wrapper });
    restorers[restorers.length] = () => restoreProperty(prototype, name, 'value', wrapper, original);
  };
  const NativeObserver = MutationObserver;
  const observerTake = MutationObserver.prototype.takeRecords,
    observerWatch = MutationObserver.prototype.observe,
    observerStop = MutationObserver.prototype.disconnect;
  const mutationAdded = describe(MutationRecord.prototype, 'addedNodes').get,
    nodeListLength = describe(NodeList.prototype, 'length').get;
  const writeObserver = new NativeObserver((changes) => {
    if (writeCapture)
      try {
        markWrittenChanges(changes, writeCapture);
      } catch {
        truncated = true;
      }
  });
  apply(observerWatch, writeObserver, [document, { childList: true, subtree: true }]);
  let writeCapture = null;
  const markWrittenChanges = (changes, capture) => {
    let budget = 2000;
    for (let i = 0; i < changes.length; i++) {
      if (i >= 2000) {
        truncated = true;
        return;
      }
      const added = apply(mutationAdded, changes[i], []),
        length = apply(nodeListLength, added, []);
      for (let j = 0; j < length; j++) {
        if (budget <= 0) {
          truncated = true;
          return;
        }
        const found = descendants(added[j], budget);
        budget -= found.visited;
        for (let k = 0; k < found.nodes.length; k++) remember(found.nodes[k], 'created-by', capture);
      }
    }
  };
  const collectWritten = (capture) => {
    const changes = apply(observerTake, writeObserver, []);
    if (capture) markWrittenChanges(changes, capture);
  };
  for (const name of ['write', 'writeln']) {
    const descriptor = describe(Document.prototype, name);
    if (typeof descriptor?.value !== 'function' || !descriptor.configurable) continue;
    const original = descriptor.value;
    const wrapper = function (...args) {
      const previous = writeCapture;
      if (!closed)
        try {
          collectWritten(previous);
        } catch {
          /* Native write remains authoritative. */
        }
      writeCapture = lazyStack();
      try {
        return apply(original, this, args);
      } finally {
        if (!closed)
          try {
            collectWritten(writeCapture);
          } catch {
            truncated = true;
          }
        writeCapture = previous;
      }
    };
    define(wrapper, 'name', { value: original.name });
    define(wrapper, 'length', { value: original.length });
    define(Document.prototype, name, { ...descriptor, value: wrapper });
    restorers[restorers.length] = () => restoreProperty(Document.prototype, name, 'value', wrapper, original);
  }
  restorers[restorers.length] = () => apply(observerStop, writeObserver, []);
  for (const name of ['createElement', 'createElementNS'])
    wrapMethod(Document.prototype, name, (_receiver, node) => remember(node, 'created-by', stackFrames));
  for (const [prototype, name] of [
    [Node.prototype, 'cloneNode'],
    [Document.prototype, 'importNode'],
  ])
    wrapMethod(prototype, name, (_receiver, node) => markNodes(descendants(node).nodes, 'cloned-by'));
  for (const name of ['innerHTML', 'outerHTML']) {
    const descriptor = describe(Element.prototype, name);
    if (typeof descriptor?.set !== 'function' || !descriptor.configurable) continue;
    const setter = function (value) {
      let prior;
      if (!closed)
        try {
          prior =
            name === 'outerHTML'
              ? range(readNode(this, 'parentNode'), readNode(this, 'previousSibling'), readNode(this, 'nextSibling'))
              : range(this, null, null);
        } catch {
          /* Native setter validates receivers. */
        }
      const result = apply(descriptor.set, this, [value]);
      if (!closed)
        try {
          markRange(prior);
        } catch {
          /* Preserve native behavior. */
        }
      return result;
    };
    define(Element.prototype, name, { ...descriptor, set: setter });
    restorers[restorers.length] = () => restoreProperty(Element.prototype, name, 'set', setter, descriptor.set);
  }
  wrapMethod(
    Element.prototype,
    'insertAdjacentHTML',
    (_receiver, _value, prior) => markRange(prior),
    (receiver, args) => {
      if (typeof args[0] !== 'string') return null; // Never coerce an argument a second time.
      const position = apply(lower, args[0], []),
        parent = readNode(receiver, 'parentNode');
      if (position === 'beforebegin') return range(parent, readNode(receiver, 'previousSibling'), receiver);
      if (position === 'afterend') return range(parent, receiver, readNode(receiver, 'nextSibling'));
      if (position === 'afterbegin') return range(receiver, null, readNode(receiver, 'firstChild'));
      if (position === 'beforeend') return range(receiver, readNode(receiver, 'lastChild'), null);
      return null;
    },
  );
  for (const [prototype, names] of [
    [Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']],
    [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith']],
  ]) {
    const firstOnly = prototype === Node.prototype;
    for (const name of names)
      wrapMethod(
        prototype,
        name,
        (_receiver, _value, nodes) => markNodes(nodes ?? [], 'attached-by'),
        (_receiver, args) => incoming(args, firstOnly),
      );
  }
  const query = (node, { scope, anchorGeneration } = {}) => {
    const record = stored(node),
      result = {
        version: 1,
        mode: 'live',
        scope,
        anchorGeneration,
        node: { connected: Boolean(node && readNode(node, 'isConnected')) },
        facts: [],
        sourceRefs: [],
        availability: [],
        limits: { truncated: truncated || Boolean(transportLimit), reasons: transportLimit ? [transportLimit] : [] },
      };
    if (closed || !readNode(node, 'isConnected') || readNode(node, 'ownerDocument') !== document || !record)
      return result;
    if (!record.proof) {
      result.availability[0] = { reason: record.reason ?? transportLimit ?? 'creation-proof-pending' };
      return result;
    }
    const proof = apply(clone, window, [record.proof]);
    if (typeof proof.reason === 'string' && apply(regexExec, /^[a-z][a-z0-9-]{0,127}$/, [proof.reason]))
      result.availability[0] = { reason: proof.reason };
    result.sourceRefs = proof.sourceRefs ?? [];
    if (proof.limits) {
      result.limits.truncated = result.limits.truncated || Boolean(proof.limits.truncated);
      const reasons = proof.limits.reasons ?? [];
      for (let i = 0; i < reasons.length; i++) result.limits.reasons[result.limits.reasons.length] = reasons[i];
    }
    const facts = proof.facts ?? [];
    for (let i = 0; i < facts.length; i++)
      result.facts[i] = {
        ...facts[i],
        scope,
        subject: record.id,
        predicate: record.relationship,
        label:
          record.relationship === 'attached-by'
            ? 'Observed script attachment callsite'
            : record.relationship === 'cloned-by'
              ? 'Observed script clone callsite'
              : 'Observed script creation callsite',
      };
    return result;
  };
  const resolveRecord = (id, proof) => {
    const record = get(pending, id);
    if (closed || !record || !proof || typeof proof !== 'object' || array(proof)) return false;
    try {
      record.proof = apply(clone, window, [proof]);
    } catch {
      return false;
    }
    apply(mapDelete, pending, [id]);
    return true;
  };
  const ready = () => apply(dispatch, document, [new NativeEvent('paqvilo-provenance-ready', { detail: { slot } })]);
  const writer = freeze({
    markLimited(reason) {
      if (closed || typeof reason !== 'string' || !reason.length || reason.length > 256 || transportLimit) return false;
      transportLimit = reason;
      ready();
      return true;
    },
    resolve(id, proof) {
      if (!resolveRecord(id, proof)) return false;
      ready();
      return true;
    },
    resolveMany(entries) {
      if (!array(entries) || entries.length > 128 || closed) return 0;
      let count = 0;
      for (let i = 0; i < entries.length; i++) if (resolveRecord(entries[i]?.id, entries[i]?.proof)) count++;
      if (count) ready();
      return count;
    },
    dispose() {
      if (closed) return;
      closed = true;
      apply(mapClear, pending, []);
      records = new NativeWeakMap();
      for (let i = restorers.length - 1; i >= 0; i--)
        try {
          restorers[i]();
        } catch {
          /* Preserve authored descriptor changes. */
        }
      restorers.length = 0;
    },
  });
  const reader = freeze({
    query,
    isScriptObserved(node) {
      return closed || truncated ? null : Boolean(stored(node));
    },
    isScriptCreated(node) {
      const record = stored(node);
      return record?.relationship === 'created-by' || record?.relationship === 'cloned-by';
    },
    claim(value) {
      if (claimed || value !== secret || closed) return null;
      claimed = true;
      return writer;
    },
  });
  define(window, slot, { value: reader, configurable: false, writable: false });
}
