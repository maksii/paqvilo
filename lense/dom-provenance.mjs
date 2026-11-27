/**
 * Early owned-browser instrumentation. Arguments/text/values never enter evidence.
 *
 * What it records, per element: the call that created, copied or inserted an element a script made (one record, with
 * the call's stack), and for an element the parser made (a template's tag) the calls that moved or changed it (rows,
 * newest first). Bounds, each said in the answer of the element it affects:
 * - INSERTION_ELEMENTS (2000) elements one call records one by one; the rest is the call's region, answered with the
 *   call's own record and the 'dom-evidence-limit' reason.
 * - TASK_CAPTURES (5000) stack captures per task, about 10 µs each; past it calls are recorded without a callsite.
 * - `maximum` (10000) callsites waiting for the transport; calls of one place share a record until it is sent.
 * - CHANGE_ENTRIES (4) rows, CHANGE_WORDS (8) names and ELEMENT_CAPTURES (32) captures per changed element.
 * Records are weak: removed elements take theirs with them; the other maps are bounded at 1024 entries.
 */
// NOSONAR: window preserves the browser WindowProxy boundary when page code reassigns globalThis.
// `secret` only unlocks the writer and never leaves this closure. Notifications carry `notifyKey`, which admits a
// notification and nothing else, and every value page code could observe is built from own properties of
// null-prototype objects, primitives and captured natives, so page accessors and `toJSON` hooks never see either key.
// Serialized into the page as one function: its captured natives and recorder state exist only inside it.
export function installDomProvenance({ slot, secret, notifyKey, binding, releaseKey, limit = 10000 } = {}) {
  // A slot that already exists belongs to the page (it cannot be replaced): the registry is refused for this document.
  // The transport finds no function of this bootstrap there, so it claims nothing and reports the document.
  if (!slot || !secret || !notifyKey || secret === notifyKey || !binding || Object.hasOwn(window, slot)) return; // NOSONAR: preserve the page window receiver and binding
  // Serialized into the page with this function, so it must stay nested here.
  /* NOSONAR */ function stackFrameOf(raw, match, methods, NativeEncoder) {
    const { apply, stringSlice, digest, subtle, encode, digests, mapGet, mapSet, mapSize, mapClear } = methods;
    let pathEnd = raw.length;
    for (let index = 0; index < raw.length; index++)
      if (raw[index] === '?' || raw[index] === '#') {
        pathEnd = index;
        break;
      }
    const url = apply(stringSlice, raw, [0, pathEnd]);
    if (url.length > 4096) return { __proto__: null, barrier: true };
    // One digest per script address: a loop that builds thousands of elements hashes its few addresses once each.
    let key = digest ? apply(mapGet, digests, [raw]) : null;
    if (digest && !key) {
      key = apply(digest, subtle, ['SHA-256', apply(encode, new NativeEncoder(), [raw])]);
      if (apply(mapSize, digests, []) >= 1024) apply(mapClear, digests, []);
      apply(mapSet, digests, [raw, key]);
    }
    return { __proto__: null, barrier: false, url, raw, key, line: +match[2], column: +match[3] };
  }
  const apply = Reflect.apply,
    describe = Object.getOwnPropertyDescriptor,
    define = Object.defineProperty,
    freeze = Object.freeze,
    hasOwn = Object.hasOwn;
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
    array = Array.isArray,
    isSafeInteger = Number.isSafeInteger;
  // A string primitive: JSON.stringify looks up `toJSON` only on objects.
  const quote = (value) => apply(stringify, JSON, [typeof value === 'string' ? value : '']);
  // One serialized callsite frame; a frame without integer coordinates is a barrier.
  const frameText = (frame, urlKey) => {
    if (!isSafeInteger(frame.line) || !isSafeInteger(frame.column)) return '{"barrier":true}';
    const key = urlKey === null ? 'null' : quote(urlKey);
    return (
      '{"url":' +
      quote(frame.url) +
      ',"urlKey":' +
      key +
      ',"line":' +
      frame.line +
      ',"column":' +
      frame.column +
      (frame.evaluated === true ? ',"evaluated":true' : '') +
      '}'
    );
  };
  const stringSlice = String.prototype.slice,
    stringIndex = String.prototype.indexOf,
    stringIncludes = String.prototype.includes,
    lower = String.prototype.toLowerCase;
  const minimum = Math.min;
  const numberString = Number.prototype.toString,
    pad = String.prototype.padStart,
    regexExec = RegExp.prototype.exec;
  const then = Promise.prototype.then;
  // Patterns of the hot paths, compiled once (none is global or sticky: `exec` keeps no state between calls).
  const BUILTIN_FRAME = /^\s*at [^()]*\((?:<anonymous>|native)\)$/,
    EVAL_FRAME = /\(eval at [^\n]*?\(((?:https?:\/\/|file:\/\/\/)[^\s()]*):(\d+):(\d+)\)/,
    ADDRESS_FRAME = /((?:https?:\/\/|file:\/\/\/)[^\s]*):(\d+):(\d+)\)?$/,
    CHANGE_WORD = /^[a-z][a-z0-9_.:-]{0,63}$/,
    PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
  const mapGet = Map.prototype.get,
    mapSet = Map.prototype.set,
    mapHas = Map.prototype.has,
    mapDelete = Map.prototype.delete,
    mapClear = Map.prototype.clear,
    mapForEach = Map.prototype.forEach;
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
  const errorString = describe(NativeError.prototype, 'toString'),
    captureStackDescriptor = describe(NativeError, 'captureStackTrace');
  const sameDescriptor = (a, b) => {
    const names = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
    for (let i = 0; i < names.length; i++) if (a?.[names[i]] !== b?.[names[i]]) return false; // NOSONAR: array-like or mutated collection, index loop kept
    return true;
  };
  const own = (object, key) => (object && typeof object === 'object' && hasOwn(object, key) ? object[key] : undefined);
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
  // The facts read on every recorded call, through their own getters.
  const nodeTypeOf = getters.nodeType,
    ownerDocumentOf = getters.ownerDocument,
    connectedOf = getters.isConnected;
  // Element-only traversal: text and comment nodes are never recorded, so they are never walked either. The getters
  // live on the interface of each node type (ParentNode, NonDocumentTypeChildNode).
  const elementGetters = {};
  for (const [key, prototype, name] of [
    ['element-first', Element.prototype, 'firstElementChild'],
    ['element-last', Element.prototype, 'lastElementChild'],
    ['element-next', Element.prototype, 'nextElementSibling'],
    ['element-previous', Element.prototype, 'previousElementSibling'],
    ['document-first', Document.prototype, 'firstElementChild'],
    ['document-last', Document.prototype, 'lastElementChild'],
    ['fragment-first', DocumentFragment.prototype, 'firstElementChild'],
    ['fragment-last', DocumentFragment.prototype, 'lastElementChild'],
    ['data-next', CharacterData.prototype, 'nextElementSibling'],
  ])
    elementGetters[key] = describe(prototype, name)?.get;
  const readElement = (node, key) => (node && elementGetters[key] ? apply(elementGetters[key], node, []) : null);
  const parentKind = { 1: 'element', 9: 'document', 11: 'fragment' };
  const firstElementIn = (node) => {
    const kind = parentKind[nodeType(node)];
    return kind ? readElement(node, kind + '-first') : null;
  };
  const lastElementIn = (node) => {
    const kind = parentKind[nodeType(node)];
    return kind ? readElement(node, kind + '-last') : null;
  };
  // The first element after `node` among its siblings (text, comment and processing instruction nodes included).
  const nextElementAfter = (node) => {
    const type = nodeType(node);
    if (type === 1) return readElement(node, 'element-next');
    if (type === 3 || type === 4 || type === 7 || type === 8) return readElement(node, 'data-next');
    let next = readNode(node, 'nextSibling');
    for (let steps = 0; next && nodeType(next) !== 1 && steps < 64; steps++) next = readNode(next, 'nextSibling');
    return next && nodeType(next) === 1 ? next : null;
  };
  const shadowHost = describe(ShadowRoot.prototype, 'host')?.get;
  const NativeShadowRoot = ShadowRoot;
  const nodeType = (node) => {
    try {
      return node ? apply(nodeTypeOf, node, []) : null;
    } catch {
      return null;
    }
  };
  // Per element, the callsite record of the call that created, copied or inserted it (records of moves and changes are
  // kept per element in `changes`, below). Weak: a removed element takes its record with it.
  let records = new NativeWeakMap();
  const pending = new NativeMap(),
    digests = new NativeMap(),
    restorers = [];
  // Callsites waiting for the transport's proof at once; past it an element is recorded without one and says so.
  const maximum = Number.isSafeInteger(limit) && limit >= 0 ? Math.min(limit, 10000) : 10000;
  // Elements one call records one by one. The rest of what that call brought is a region (below) that carries the
  // call's own record: each element in it is answered with that call, marked as not recorded individually.
  const INSERTION_ELEMENTS = 2000;
  // `failed`: an observation failed, so nothing in this document can be said to be parser-made any more.
  // `transportLimit`: the transport dropped evidence; only callsites still waiting for a proof are affected by it.
  let closed = false,
    transportLimit = null,
    failed = false;
  const NativeWeakSet = WeakSet,
    weakSetAdd = WeakSet.prototype.add,
    weakSetHas = WeakSet.prototype.has;
  // Regions past a call's bound, by their roots: `regionSelf` holds a root that came whole from the call (its subtree
  // included), `regionBelow` an element the call recorded whose children it did not all take (its descendants came from
  // the call, it is recorded itself). Both map to the call's record.
  const regionSelf = new NativeWeakMap(),
    regionBelow = new NativeWeakMap();
  let regionRoots = 0;
  const markRegion = (node, record, self) => {
    if (!node || !record) return;
    apply(weakSet, self ? regionSelf : regionBelow, [node, record]);
    regionRoots++;
  };
  // The record of the region `node` lies in, across open and closed shadow roots up to their hosts: undefined outside
  // every region, null when the path is too deep to walk (not known to be outside one). `outsideRegion` is defined
  // below; this runs only once the recorder is installed.
  const insideRegion = (node) => /* NOSONAR: one bounded ancestor walk on every insertion, cursor shared */ {
    if (!regionRoots) return undefined;
    let current = node;
    for (let steps = 0; current && steps < 4096; steps++) {
      const self = apply(weakGet, regionSelf, [current]);
      if (self) return self;
      if (current !== node) {
        const below = apply(weakGet, regionBelow, [current]);
        if (below) return below;
      }
      // A parser-made element inserted into a region after its call (see `markOutside`): neither it nor anything
      // below it came from the region's call.
      if (apply(weakSetHas, outsideRegion, [current])) return undefined;
      const parent = readNode(current, 'parentNode');
      current = parent ?? (nodeType(current) === 11 && shadowHost ? hostOf(current) : null);
    }
    return current ? null : undefined;
  };
  const hostOf = (root) => {
    try {
      return apply(shadowHost, root, []);
    } catch {
      return null; // A document fragment that is no shadow root.
    }
  };
  // `entry`: the recorded entry point the page called, still on the stack. The stack is captured above it, so the
  // recorder's own frames are neither formatted (most of a capture's cost) nor counted against the limit.
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const stackFrames = (entry) => {
    if (
      !sameDescriptor(prepare, describe(NativeError, 'prepareStackTrace')) ||
      (entry && !sameDescriptor(captureStackDescriptor, describe(NativeError, 'captureStackTrace'))) ||
      !sameDescriptor(stackLimit, describe(NativeError, 'stackTraceLimit')) ||
      !sameDescriptor(errorString, describe(NativeError.prototype, 'toString'))
    )
      return { __proto__: null, frames: { __proto__: null, length: 0 }, reason: 'custom-stack-format' };
    // The default limit (10) counts this instrumentation's own frames too, which would leave too few page frames to
    // reach the developer's code behind a library: the limit is raised for this one capture and restored at once. The
    // descriptors are null-prototype objects, so no page accessor on Object.prototype takes part in either definition.
    const raise = stackLimit && hasOwn(stackLimit, 'value') && stackLimit.writable && stackLimit.configurable;
    let stack;
    if (raise)
      define(NativeError, 'stackTraceLimit', {
        __proto__: null,
        value: 40,
        writable: true,
        enumerable: stackLimit.enumerable,
        configurable: true,
      });
    try {
      if (typeof entry === 'function' && typeof captureStackDescriptor?.value === 'function') {
        // A null-prototype holder: V8 names the stack's first line without reading a page accessor.
        const holder = { __proto__: null };
        apply(captureStackDescriptor.value, NativeError, [holder, entry]);
        stack = holder.stack;
      }
      // Without the entry point on the stack the capture is empty: the whole stack is taken.
      if (typeof stack !== 'string' || apply(stringIndex, stack, ['\n']) < 0) stack = new NativeError().stack;
    } finally {
      if (raise)
        define(NativeError, 'stackTraceLimit', {
          __proto__: null,
          value: stackLimit.value,
          writable: true,
          enumerable: stackLimit.enumerable,
          configurable: true,
        });
    }
    if (typeof stack !== 'string' || stack.length > 32768)
      return { __proto__: null, frames: { __proto__: null, length: 0 }, reason: 'stack-unavailable' };
    const frameMethods = {
      __proto__: null,
      apply,
      stringSlice,
      digest,
      subtle,
      encode,
      digests,
      mapGet,
      mapSet,
      mapSize,
      mapClear,
    };
    // A null-prototype list: an index or `length` accessor on Array.prototype cannot observe or replace a frame.
    const frames = { __proto__: null, length: 0 };
    // The frames as text, which identifies the callsite for `newRecord`'s sharing.
    let text = '';
    const push = (frame) => {
      frames[frames.length] = frame;
      frames.length++;
      if (frame.barrier) text += '|';
      else text += frame.raw + ' ' + frame.line + ':' + frame.column + (frame.evaluated ? ' eval|' : '|');
    };
    let offset = apply(stringIndex, stack, ['\n']) + 1;
    for (let i = 1; offset > 0 && offset < stack.length && i < 41; i++) {
      const end = apply(stringIndex, stack, ['\n', offset]);
      const line = apply(stringSlice, stack, [offset, end < 0 ? stack.length : end]);
      offset = end < 0 ? 0 : end + 1;
      if (apply(stringIncludes, line, ['paqvilo-tool://'])) continue;
      // A built-in function between two frames (Array.prototype.forEach, Reflect.set, a promise job) has no place of its
      // own: the frames around it stay linked.
      if (
        (apply(stringIncludes, line, ['(<anonymous>)']) || apply(stringIncludes, line, ['(native)'])) &&
        apply(regexExec, BUILTIN_FRAME, [line])
      )
        continue;
      // Code that eval or new Function compiled has no address of its own: V8 names the place of the eval call
      // ("eval at f (address:line:column), <anonymous>:1:2"). The frame stands for that call, marked as evaluated.
      // Code evaluated with its own sourceURL is reported under that address like a script, and parsed under it too;
      // the transport finds both scripts there and names neither.
      const evaluated = apply(stringIncludes, line, ['(eval at ']) ? apply(regexExec, EVAL_FRAME, [line]) : null;
      const match = evaluated ?? apply(regexExec, ADDRESS_FRAME, [line]);
      if (!match) {
        push({ __proto__: null, barrier: true });
        break;
      }
      const raw = match[1];
      const frame = stackFrameOf(raw, match, frameMethods, NativeEncoder);
      if (evaluated && !frame.barrier) frame.evaluated = true;
      if (frame.barrier) {
        push(frame);
        break;
      }
      push(frame);
      if (frames.length >= 12) break;
    }
    return {
      __proto__: null,
      frames,
      text,
      reason: !frames.length || frames[0].barrier ? 'callsite-unavailable' : null,
    };
  };
  // Stack captures one task may spend (a capture costs about 10 µs): past it, a call is recorded without its callsite
  // as past the limit, so a task that builds or changes tens of thousands of elements stays within about 50 ms of
  // recording. The budget renews in the next microtask checkpoint (the next script, callback or task).
  const TASK_CAPTURES = 5000;
  let taskCaptures = 0,
    renewing = false;
  const settled = Promise.resolve();
  const renew = () => {
    taskCaptures = 0;
    renewing = false;
  };
  const overBudget = {
    __proto__: null,
    frames: { __proto__: null, length: 0 },
    text: '',
    reason: 'dom-evidence-limit',
  };
  const lazyStack = (entry) => {
    let capture;
    return () => {
      if (capture) return capture;
      if (!renewing) {
        renewing = true;
        apply(then, settled, [renew]); // NOSONAR: captured native then on a resolved promise; renew cannot throw, and a page-overridable catch is never called
      }
      capture = taskCaptures++ < TASK_CAPTURES ? stackFrames(entry) : overBudget;
      return capture;
    };
  };
  const remember = (node, relationship, capture) => {
    if (closed || nodeType(node) !== 1 || apply(weakHas, records, [node])) return null;
    const record = newRecord(relationship, capture, null);
    apply(weakSet, records, [node, record]);
    return record;
  };
  // The JSON text of a change's words (validated when they were collected, see `changeWord`).
  const wordsText = (what) => {
    let text = '';
    for (let i = 0; i < what.length; i++) text += (i ? ',' : '') + quote(what[i]);
    return ',"what":[' + text + ']' + (what.more ? ',"more":true' : '');
  };
  // One callsite record: the relationship of a call to the elements it made, copied, inserted, moved or changed, and
  // the proof of its callsite once the transport sends it. `what` (changes only) names what the call changed.
  // Records whose notification is not sent yet, by relationship, change and callsite text. A call with the same text
  // shares such a record (a loop that builds thousands of rows sends one notification per line, not one per row). It
  // is shared only until its notification is sent: every script compiled before the shared calls ran was compiled
  // before that notification, so the transport resolves it against the same scripts as each call's own (the transport
  // receives a script's parse before any later notification). Once sent, the next call gets a record of its own.
  const unsent = new NativeMap(),
    limitRecords = new NativeMap(),
    reasonRecords = new NativeMap();
  const newRecord = (relationship, capture, what) => /* NOSONAR: limit, reason and share tiers run in order */ {
    const made = (reason) => ({
      __proto__: null,
      id: randomId(),
      relationship,
      what,
      reason,
      proof: null,
      payload: null,
      sent: false,
    });
    if (closed) return made(null);
    // A call past a limit has nothing of its own to say: one record per relationship says it for all of them.
    const limited = () => {
      let record = get(limitRecords, relationship);
      if (!record) {
        record = made('dom-evidence-limit');
        apply(mapSet, limitRecords, [relationship, record]);
      }
      return record;
    };
    // Too many callsites wait for the backend: this node is recorded without one, and says so. Later nodes are
    // admitted again as soon as waiting callsites receive their proofs.
    if (apply(mapSize, pending, []) >= maximum) return limited();
    const observation = capture();
    if (observation.reason === 'dom-evidence-limit') return limited();
    // A call whose callsite cannot be told (a custom stack format, code without an address) says only why: one record
    // per relationship and reason says it for all of them.
    if (observation.reason || typeof emit !== 'function') {
      const reasonKey = relationship + ' ' + observation.reason;
      let record = get(reasonRecords, reasonKey);
      if (!record) {
        if (apply(mapSize, reasonRecords, []) >= 1024) apply(mapClear, reasonRecords, []);
        record = made(observation.reason);
        apply(mapSet, reasonRecords, [reasonKey, record]);
      }
      return record;
    }
    let key = relationship + '\n' + observation.text;
    if (what) key += '\n' + wordsText(what);
    const shared = get(unsent, key);
    if (shared && !shared.sent && has(pending, shared.id)) return shared;
    const record = made(null);
    if (apply(mapSize, unsent, []) >= 1024) apply(mapClear, unsent, []);
    apply(mapSet, unsent, [key, record]);
    apply(mapSet, pending, [record.id, record]);
    // Serialized frames by index; the notification text is concatenated from JSON-quoted primitives only.
    const frames = { __proto__: null };
    const count = observation.frames.length;
    let remaining = count;
    const finish = (index, frame) => {
      frames[index] = frame;
      if (--remaining || closed || !has(pending, record.id)) return;
      record.sent = true;
      let list = '';
      for (let i = 0; i < count; i++) list += (i ? ',' : '') + frames[i];
      try {
        // Kept for `pendingCallsites`: Chromium drops a notification sent while it re-attaches the DevTools session.
        record.payload =
          '{"version":1,"key":' +
          quote(notifyKey) +
          ',"id":' +
          quote(record.id) +
          ',"relationship":' +
          quote(relationship) +
          (what ? wordsText(what) : '') +
          ',"frames":[' +
          list +
          ']}';
        apply(emit, window, [record.payload]); // NOSONAR: preserve the page window receiver and binding
      } catch {
        record.reason = 'callsite-unavailable';
        record.payload = null;
        apply(mapDelete, pending, [record.id]);
      }
    };
    for (let i = 0; i < observation.frames.length; i++) {
      const frame = observation.frames[i];
      if (frame.barrier) {
        finish(i, '{"barrier":true}');
        continue;
      }
      const complete = (urlKey) => finish(i, frameText(frame, urlKey));
      if (!frame.key) {
        complete(null);
        continue;
      }
      /* NOSONAR: rejection is handled by the caller */ try {
        void apply(then, frame.key, [
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
        record.payload = null;
        apply(mapDelete, pending, [record.id]);
      }
    }
    return record;
  };
  // The record of one call's region, made the first time the call reaches its bound (see INSERTION_ELEMENTS).
  const regionFor = (relationship, capture) => {
    let record = null;
    return () => (record ??= newRecord(relationship, capture, null));
  };
  // Marks `node` and the element siblings after it as whole roots of the region: what a call brings beyond its bound.
  // One write per sibling, no walk into them; the native call itself is linear in them anyway.
  const markRestOfSiblings = (node, region, previous = false) => {
    for (let current = node; current; current = readElement(current, previous ? 'element-previous' : 'element-next'))
      markRegion(current, region(), true);
  };
  // The elements of `root`'s subtree (root included when it is one), at most `budget`. What the bound leaves out goes
  // into the call's region: the elements still waiting as whole roots, an element whose children were not all taken as
  // a root of what lies below it.
  const descendants = (root, budget, region) => {
    const nodes = [],
      stack = [];
    let visited = 0;
    const type = nodeType(root);
    if (type === 1) stack[0] = root;
    else if (type === 9 || type === 11) {
      let child = lastElementIn(root);
      for (; child && stack.length < budget; child = readElement(child, 'element-previous'))
        stack[stack.length] = child;
      if (child) markRestOfSiblings(child, region, true);
    }
    while (stack.length) {
      const node = stack[stack.length - 1]; // NOSONAR: do not invoke page-overridable Array.prototype methods during instrumentation
      stack.length--;
      if (visited >= budget) {
        markRegion(node, region(), true);
        continue;
      }
      visited++;
      nodes[nodes.length] = node;
      let child = lastElementIn(node);
      for (; child && stack.length + visited < budget; child = readElement(child, 'element-previous'))
        stack[stack.length] = child;
      if (child) markRegion(node, region(), false);
    }
    return { nodes, visited };
  };
  const markNodes = (nodes, relationship, capture) => {
    for (let i = 0; i < nodes.length; i++) remember(nodes[i], relationship, capture); // NOSONAR: array-like or mutated collection, index loop kept
  };
  // Elements removed from this document that no script made: put back in later, they are moved, not inserted. Filled
  // from the change observer's records, which every recorded insertion reads first (`enter`).
  const removedServer = new NativeWeakSet();
  // Whether `node` stands in the document, or in a subtree taken out of it (its own root was removed).
  const inDocument = (node) => {
    if (apply(connectedOf, node, [])) return true;
    let current = node;
    for (let steps = 0; current && steps < 4096; steps++, current = readNode(current, 'parentNode'))
      if (apply(weakSetHas, removedServer, [current])) return true;
    return false;
  };
  // Whether inserting `node` moves an element the parser made: one of this document no script made (no record, no
  // region), that stands in the document or was removed from it. Its tag stays the template's.
  const isMove = (node) =>
    nodeType(node) === 1 &&
    !apply(weakHas, records, [node]) &&
    readNode(node, 'ownerDocument') === document &&
    inDocument(node) &&
    insideRegion(node) === undefined;
  // The elements an insertion brings (read before the native call: a fragment still holds them), the parser-made
  // elements it moves (their subtrees are not walked: they stay the parser's), and its region. A parser-made element
  // inside what it brings (moved into a fragment or a detached wrapper earlier, or cut out by a range) is moved too,
  // with the elements below it: none of them is recorded as brought.
  const incoming = (args, firstOnly, capture) => /* NOSONAR: one pass sharing the visit budget, seen set, region */ {
    const nodes = [],
      moves = [],
      seen = new NativeSet(),
      count = firstOnly ? minimum(1, args.length) : args.length;
    const region = regionFor('attached-by', capture);
    let visited = 0;
    for (let i = 0; i < count; i++) {
      const type = nodeType(args[i]);
      if (!type) continue;
      if (isMove(args[i])) {
        moves[moves.length] = args[i];
        continue;
      }
      if (visited >= INSERTION_ELEMENTS) {
        if (type === 1) markRegion(args[i], region(), true);
        else if (type === 11) markRestOfSiblings(firstElementIn(args[i]), region);
        continue;
      }
      const found = descendants(args[i], INSERTION_ELEMENTS - visited, region),
        children = found.nodes;
      visited += found.visited;
      /* NOSONAR: array-like or mutated collection, index loop kept */ for (let j = 0; j < children.length; j++) {
        const child = children[j];
        if (apply(setHas, seen, [child])) continue;
        apply(setAdd, seen, [child]);
        if (!isMove(child)) nodes[nodes.length] = child;
        else if (moves.length < INSERTION_ELEMENTS && !isMove(readNode(child, 'parentNode')))
          moves[moves.length] = child;
      }
    }
    return { nodes, moves };
  };
  // Capture the actual insertion interval, never diff two truncated whole-parent scans.
  const range = (root, left, right) => ({ root, left, right });
  const markRange = (prior, capture) => {
    if (
      !prior?.root ||
      (prior.left && readNode(prior.left, 'parentNode') !== prior.root) ||
      (prior.right && readNode(prior.right, 'parentNode') !== prior.root)
    )
      return;
    const nodes = [];
    const region = regionFor('created-by', capture);
    let visited = 0;
    // The elements between the two neighbours: from the first element after `left` up to the first element at or
    // after `right` (a text or comment neighbour has no element to stop at of its own).
    let node = prior.left ? nextElementAfter(prior.left) : firstElementIn(prior.root);
    let end = null;
    if (prior.right) end = nodeType(prior.right) === 1 ? prior.right : nextElementAfter(prior.right);
    while (node && node !== end) {
      if (visited >= INSERTION_ELEMENTS) {
        markRegion(node, region(), true);
        node = readElement(node, 'element-next');
        continue;
      }
      const found = descendants(node, INSERTION_ELEMENTS - visited, region),
        children = found.nodes;
      visited += found.visited;
      for (let i = 0; i < children.length; i++) nodes[nodes.length] = children[i]; // NOSONAR: array-like or mutated collection, index loop kept
      node = readElement(node, 'element-next');
    }
    markNodes(nodes, 'created-by', capture);
  };
  const restoreProperty = (prototype, name, part, wrapper, original) => {
    const current = describe(prototype, name);
    if (current?.[part] === wrapper && current.configurable) define(prototype, name, { ...current, [part]: original });
  };
  const NativeObserver = MutationObserver;
  const observerTake = MutationObserver.prototype.takeRecords,
    observerWatch = MutationObserver.prototype.observe,
    observerStop = MutationObserver.prototype.disconnect;
  const mutationAdded = describe(MutationRecord.prototype, 'addedNodes').get,
    mutationRemoved = describe(MutationRecord.prototype, 'removedNodes').get,
    mutationType = describe(MutationRecord.prototype, 'type').get,
    mutationAttribute = describe(MutationRecord.prototype, 'attributeName').get,
    nodeListLength = describe(NodeList.prototype, 'length').get;
  const mutationTarget = describe(MutationRecord.prototype, 'target').get;
  // ---- Moves and changes of elements no script made (the parser's: the template's tags).
  //
  // What changed is proved by the browser: a mutation observer of the whole document reports every attribute, text and
  // child change with its element, whatever path made it. Who changed it is proved by the call: every recorded DOM
  // entry point below (attribute, class, style declaration members, text, children, form values) opens a scope; the
  // scope takes the observer's records before the native call (they belong to earlier code) and after it (they were
  // made during it), and of those only the ones the call's own arguments name (its claim, see `claimed`) are
  // attributed to the call's stack. A change no recorded call made (a named style or dataset write, a path the
  // recorder does not follow, other code that ran inside the call, the browser itself) is shown without a script. The
  // observer alone never names a script. Changes of elements a script made are not recorded: their creator is named.
  //
  // Bounds: CHANGE_ENTRIES rows per element (newest first; older ones are dropped and the answer says so),
  // CHANGE_WORDS names per row, ELEMENT_CAPTURES stack captures per element, and the task budget of stack captures
  // (TASK_CAPTURES) shared with creations; past a bound changes are still listed by what changed, without a script,
  // and the answer says the record is partial. Records are weak: a removed element takes its rows with it.
  const CHANGE_ENTRIES = 4,
    CHANGE_WORDS = 8,
    ELEMENT_CAPTURES = 32;
  const marker = 'data-paqvilo-source';
  const changes = new NativeWeakMap();
  // A change's name: an attribute name (lowercase letters, digits and `_.:-`, at most 64 characters), "text",
  // "children", or one of the form-value words. Anything else is never shown.
  const changeWord = (value) => {
    if (typeof value !== 'string' || !value.length || value.length > 64) return null;
    const word = apply(lower, value, []);
    return word !== marker && apply(regexExec, CHANGE_WORD, [word]) ? word : null;
  };
  const addWord = (words, word) => {
    if (!word) return;
    for (let i = 0; i < words.length; i++) if (words[i] === word) return; // NOSONAR: array-like or mutated collection, index loop kept
    if (words.length >= CHANGE_WORDS) words.more = true;
    else words[words.length++] = word;
  };
  const newWords = () => ({ __proto__: null, length: 0, more: false });
  const copyWords = (what) => {
    if (!what) return null;
    const copy = newWords();
    for (let i = 0; i < what.length; i++) copy[copy.length++] = what[i]; // NOSONAR: array-like or mutated collection, index loop kept
    copy.more = what.more;
    return copy;
  };
  // An element whose changes are recorded: one of this document that no script made, standing in the document or
  // taken out of it (an element made through a path the recorder does not follow is neither).
  const unmade = (node) =>
    nodeType(node) === 1 &&
    !apply(weakHas, records, [node]) &&
    apply(ownerDocumentOf, node, []) === document &&
    insideRegion(node) === undefined;
  const isServer = (node) => unmade(node) && inDocument(node);
  const stateOf = (node) => {
    let state = apply(weakGet, changes, [node]);
    if (!state) {
      state = { __proto__: null, entries: { __proto__: null, length: 0 }, captures: 0, dropped: false, limited: false };
      apply(weakSet, changes, [node, state]);
    }
    return state;
  };
  // Adds a row in front; an unattributed or limited row merges into a front row of the same kind.
  const pushEntry = (state, entry) => /* NOSONAR: merge-or-shift of one bounded row list at its front row */ {
    const entries = state.entries,
      front = entries.length ? entries[0] : null;
    // The same call again (a loop), or calls past the same limit: one row.
    if (front && entry.record && front.record === entry.record) {
      if (entry.what) for (let i = 0; i < entry.what.length; i++) addWord(front.what, entry.what[i]); // NOSONAR: array-like or mutated collection, index loop kept
      if (entry.what?.more) front.what.more = true;
      return;
    }
    if (
      front &&
      !entry.record &&
      !front.record &&
      front.reason === entry.reason &&
      front.relationship === entry.relationship
    ) {
      if (entry.what) for (let i = 0; i < entry.what.length; i++) addWord(front.what, entry.what[i]); // NOSONAR: array-like or mutated collection, index loop kept
      if (entry.what?.more) front.what.more = true;
      return;
    }
    if (entries.length >= CHANGE_ENTRIES) state.dropped = true;
    const length = minimum(entries.length, CHANGE_ENTRIES - 1);
    for (let i = length; i > 0; i--) entries[i] = entries[i - 1];
    entries[0] = entry;
    entries.length = length + 1;
  };
  const recordChange = (node, relationship, what, scope) => {
    if (closed) return;
    const state = stateOf(node);
    if (!scope) {
      pushEntry(state, { __proto__: null, record: null, reason: 'dom-change-unattributed', relationship, what });
      return;
    }
    if (state.captures >= ELEMENT_CAPTURES) {
      state.limited = true;
      pushEntry(state, { __proto__: null, record: null, reason: 'dom-change-limit', relationship, what });
      return;
    }
    // One record per call and change: the elements one call changes alike share it.
    let key = relationship;
    if (what) for (let i = 0; i < what.length; i++) key += ' ' + what[i]; // NOSONAR: array-like or mutated collection, index loop kept
    if (what?.more) key += ' +';
    scope.shared ??= new NativeMap();
    let record = get(scope.shared, key);
    if (!record) {
      record = newRecord(relationship, scope.capture, what);
      apply(mapSet, scope.shared, [key, record]);
    }
    state.captures++;
    pushEntry(state, { __proto__: null, record, reason: null, relationship, what: copyWords(what) });
  };
  // ---- Which records a call made.
  //
  // A call is credited only with the records its own arguments name (its claim): for an attribute call, that attribute
  // of that element; for a class, id, style or other reflected property, that element's attribute; for a call that
  // inserts, removes or replaces children, the child changes of its own targets (the parent it changes and the parents
  // the nodes it brings leave); for a text call, the text it changes. Code that runs synchronously inside the native
  // call (a custom element reaction, an event listener, a path the recorder does not follow) may change other
  // attributes or other elements meanwhile: those records are listed without a script, never given to the call.
  const containsNode = Node.prototype.contains,
    namespaceOf = describe(Element.prototype, 'namespaceURI')?.get,
    attrLocalName = describe(Attr.prototype, 'localName')?.get;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const inside = (root, node) => {
    if (node === root) return true;
    try {
      return Boolean(root && node && apply(containsNode, root, [node]));
    } catch {
      return false;
    }
  };
  // The name the browser gives the attribute `name` names on `element` (setAttribute lowercases it on an HTML element):
  // null when it cannot be told without coercing the argument again (not a string) or lowercasing beyond ASCII.
  const attributeName = (element, name) => {
    if (typeof name !== 'string' || !name.length || name.length > 256) return null;
    let html;
    try {
      html = apply(namespaceOf, element, []) === XHTML;
    } catch {
      return null;
    }
    if (!html) return name;
    let named = get(lowered, name);
    if (named === undefined) {
      named = apply(regexExec, PRINTABLE_ASCII, [name]) ? apply(lower, name, []) : null;
      if (apply(mapSize, lowered, []) >= 256) apply(mapClear, lowered, []);
      apply(mapSet, lowered, [name, named]);
    }
    return named;
  };
  // The lowercase names of recent attribute names (a page names few attributes, many times).
  const lowered = new NativeMap();
  const claimed = (claim, type, target, attribute) => {
    if (!claim) return false;
    if (type === 'attributes')
      return claim.node === target && typeof claim.name === 'string' && claim.name === attribute;
    if (claim.within && inside(claim.within, target)) return true;
    if (type === 'childList') {
      const children = claim.children;
      for (let i = 0; children && i < children.length; i++) if (children[i] && children[i] === target) return true;
      return false;
    }
    return (
      type === 'characterData' &&
      ((claim.data && claim.data === target) ||
        Boolean(claim.dataParent && readNode(target, 'parentNode') === claim.dataParent))
    );
  };
  // Parser-made elements that were inserted into a region (above) after the call that made the region: by a recorded
  // move or by a path the recorder does not follow. They and their subtrees stay the parser's: a region never takes
  // over what its call did not bring (an element it brought is recorded, or a root of the region).
  const outsideRegion = new NativeWeakSet();
  const markOutside = (added, length) => {
    if (!regionRoots) return;
    for (let j = 0; j < length && j < INSERTION_ELEMENTS; j++) {
      const node = added[j];
      if (nodeType(node) !== 1 || apply(weakHas, records, [node]) || apply(weakHas, regionSelf, [node])) continue;
      if (insideRegion(node)) apply(weakSetAdd, outsideRegion, [node]);
    }
  };
  // The elements change records are about, and what changed. `scope` is the call in progress the records were made
  // in, or null for records no recorded call was in progress for: then child and text changes are not listed, since
  // the parser makes them too. Inside a call, a record the call does not claim is listed without a script.
  const collectChanges = (taken, scope) => /* NOSONAR: one ordered record pass filling the lists add shares */ {
    let credited = null,
      unattributed = null;
    const add = (own, node, word) => {
      // The element an attribute call names was a parser element when the call began (it opened this scope), and an
      // attribute change does not change that.
      if (!word || (!(own && claim?.node === node && scope.serverTarget) && !isServer(node))) return;
      let list = own ? credited : unattributed;
      if (!list) {
        list = { __proto__: null, map: new NativeMap(), order: [] };
        if (own) credited = list;
        else unattributed = list;
      }
      let words = get(list.map, node);
      if (!words) {
        words = newWords();
        apply(mapSet, list.map, [node, words]);
        list.order[list.order.length] = node;
      }
      addWord(words, word);
    };
    const claim = scope ? scope.claim : null;
    const count = taken ? taken.length : 0;
    for (let i = 0; i < count; i++) {
      const change = taken[i],
        type = apply(mutationType, change, []),
        target = apply(mutationTarget, change, []);
      if (type === 'attributes') {
        const name = apply(mutationAttribute, change, []);
        add(Boolean(scope) && claimed(claim, type, target, name), target, changeWord(name));
      } else if (type === 'characterData') {
        if (scope) add(claimed(claim, type, target, null), readNode(target, 'parentNode'), 'text');
      } else if (type === 'childList') {
        const added = apply(mutationAdded, change, []),
          removed = apply(mutationRemoved, change, []);
        const addedLength = apply(nodeListLength, added, []),
          removedLength = apply(nodeListLength, removed, []);
        // Elements among the nodes make it a change of children; text and comment nodes alone a change of text.
        let elements = false;
        for (let j = 0; !elements && j < addedLength && j < INSERTION_ELEMENTS; j++)
          elements = nodeType(added[j]) === 1;
        for (let j = 0; j < removedLength && j < INSERTION_ELEMENTS; j++) {
          if (nodeType(removed[j]) !== 1) continue;
          elements = true;
          // A parser-made element taken out of the document: put back later, it is moved.
          // (Records arrive after the fact: the element is already out of the document.)
          if (unmade(removed[j])) apply(weakSetAdd, removedServer, [removed[j]]);
        }
        const own = Boolean(scope) && claimed(claim, type, target, null);
        if (scope) add(own, target, elements ? 'children' : 'text');
        if (own && scope.adds) addedBy(scope, added, addedLength);
        markOutside(added, addedLength);
      }
    }
    if (scope?.extra?.node) add(true, scope.extra.node, scope.extra.word);
    if (unattributed) {
      /* NOSONAR: array-like or mutated collection, index loop kept */ for (
        let i = 0;
        i < unattributed.order.length;
        i++
      )
        recordChange(unattributed.order[i], 'changed-by', get(unattributed.map, unattributed.order[i]), null);
    }
    if (credited) {
      /* NOSONAR: array-like or mutated collection, index loop kept */ for (let i = 0; i < credited.order.length; i++)
        recordChange(credited.order[i], 'changed-by', get(credited.map, credited.order[i]), scope);
    }
    const moves = scope?.moves;
    if (moves) {
      for (let i = 0; i < moves.length; i++) recordChange(moves[i], 'moved-by', null, scope); // NOSONAR: array-like or mutated collection, index loop kept
    }
  };
  // The elements a native call inserted that no recorded call made, for an entry point that inserts without naming
  // what (a range's insertNode, execCommand, setHTML): recorded with the call's relationship; a parser element it took
  // out of the document in the same call is moved.
  const addedBy = (scope, added, length) => {
    const region = regionFor(scope.adds, scope.capture);
    let budget = INSERTION_ELEMENTS;
    for (let j = 0; j < length; j++) {
      const node = added[j];
      if (nodeType(node) !== 1 || apply(weakHas, records, [node])) continue;
      if (apply(weakSetHas, removedServer, [node])) {
        scope.moves ??= [];
        scope.moves[scope.moves.length] = node;
        continue;
      }
      if (budget <= 0) {
        markRegion(node, region(), true);
        continue;
      }
      const found = descendants(node, budget, region);
      budget -= found.visited;
      markNodes(found.nodes, scope.adds, scope.capture);
    }
  };
  const changeObserver = new NativeObserver((taken) => {
    try {
      collectChanges(taken, null);
    } catch {
      /* A change that cannot be read is not listed. */
    }
  });
  apply(observerWatch, changeObserver, [
    document,
    { __proto__: null, attributes: true, characterData: true, childList: true, subtree: true },
  ]);
  restorers[restorers.length] = () => apply(observerStop, changeObserver, []);
  // The recorded calls in progress, innermost last (a custom element's reaction runs inside the call that caused it).
  // A call that watches nothing stands here as `unwatched`, one shared object.
  const active = { __proto__: null, length: 0 };
  const unwatched = { __proto__: null, watching: false };
  // Records waiting in the observer belong to the innermost call in progress only when that call took the records
  // before it began (it watches); otherwise they may be older than it and are listed without a script.
  const drain = () => {
    const top = active.length ? active[active.length - 1] : null;
    collectChanges(apply(observerTake, changeObserver, []), top?.watching ? top : null);
  };
  // Outside every recorded call: the records still waiting are listed (without a script) before a question about
  // an element is answered, so the answer includes them.
  const settle = () => {
    if (!closed && !active.length)
      try {
        collectChanges(apply(observerTake, changeObserver, []), null);
      } catch {
        /* A change that cannot be read is not listed. */
      }
  };
  const anyServer = (targets) => {
    if (!array(targets)) return isServer(targets);
    for (let i = 0; targets && i < targets.length; i++) if (isServer(targets[i])) return true;
    return false;
  };
  const enter = (targets, hooks, receiver, args, entry) => {
    const adds = hooks.adds ?? null;
    if (!adds && !anyServer(targets)) {
      active[active.length] = unwatched;
      active.length++;
      return unwatched;
    }
    const scope = {
      __proto__: null,
      capture: lazyStack(entry),
      watching: true,
      extra: hooks.extra?.(receiver) ?? null,
      claim: hooks.claim ? hooks.claim(receiver, args) : null,
      // The call's only target is its receiver, a parser element (the scope watches because of it).
      serverTarget: !adds && !array(targets),
      moves: null,
      shared: null,
      adds,
    };
    drain();
    active[active.length] = scope;
    active.length++;
    return scope;
  };
  const leave = (scope) => {
    if (active.length && active[active.length - 1] === scope) active.length--;
    if (scope.watching) collectChanges(apply(observerTake, changeObserver, []), scope);
  };
  // Wraps one DOM entry point. `targets(receiver, args)` names the elements whose changes the call may make (only a
  // parser-made one among them opens a watching scope), `claim(receiver, args)` the records the call makes (above),
  // `extra(receiver)` a change no observer reports (a form value), `before`/`after` the recording of elements the call
  // brings; `after` receives the call's own stack capture.
  const instrument = (hooks, original, receiver, args, entry) => /* NOSONAR: ordered scope around one native call */ {
    if (closed) return apply(original, receiver, args);
    let scope = null,
      prior;
    try {
      if (hooks.targets)
        scope = enter(hooks.targets === self ? receiver : hooks.targets(receiver, args), hooks, receiver, args, entry);
      prior = hooks.before?.(receiver, args, scope?.watching ? scope.capture : null);
    } catch {
      /* Native method validates receivers. */
    }
    let value;
    try {
      value = apply(original, receiver, args);
    } catch (error) {
      if (scope)
        try {
          leave(scope);
        } catch {
          /* Preserve native behavior. */
        }
      throw error;
    }
    if (!closed && hooks.after)
      try {
        hooks.after(receiver, value, prior, args, scope?.watching ? scope.capture : lazyStack(entry));
      } catch {
        /* Preserve native behavior. */
      }
    if (scope)
      try {
        if (scope.watching && prior?.moves?.length) scope.moves = prior.moves;
        leave(scope);
      } catch {
        /* Preserve native behavior. */
      }
    return value;
  };
  // A wrapper shaped like the native it replaces: a concise method or accessor (no `prototype`, not a constructor),
  // with the native's `name` and `length`; the property keeps the native's descriptor flags.
  const shaped = (wrapper, original) => {
    define(wrapper, 'name', { __proto__: null, value: original.name });
    define(wrapper, 'length', { __proto__: null, value: original.length });
    return wrapper;
  };
  const methodLike = (name, call) =>
    ({
      __proto__: null,
      [name](...args) {
        return call(this, args);
      },
    })[name];
  const getterLike = (name, call) =>
    describe(
      {
        __proto__: null,
        get [name]() {
          return call(this);
        },
      },
      name,
    ).get;
  const setterLike = (name, call) =>
    describe(
      {
        __proto__: null,
        set [name](value) {
          call(this, value);
        },
      },
      name,
    ).set;
  const wrapMethod = (prototype, name, hooks) => {
    const descriptor = prototype ? describe(prototype, name) : null;
    if (typeof descriptor?.value !== 'function' || !descriptor.configurable) return;
    const original = descriptor.value;
    const wrapper = shaped(
      methodLike(name, (receiver, args) => instrument(hooks, original, receiver, args, wrapper)),
      original,
    );
    define(prototype, name, { ...descriptor, value: wrapper });
    restorers[restorers.length] = () => restoreProperty(prototype, name, 'value', wrapper, original);
  };
  const wrapSetter = (prototype, name, hooks) => {
    const descriptor = prototype ? describe(prototype, name) : null;
    if (typeof descriptor?.set !== 'function' || !descriptor.configurable) return;
    const original = descriptor.set;
    const setter = shaped(
      setterLike(name, (receiver, value) => {
        instrument(hooks, original, receiver, [value], setter);
      }),
      original,
    );
    define(prototype, name, { ...descriptor, set: setter });
    restorers[restorers.length] = () => restoreProperty(prototype, name, 'set', setter, original);
  };
  const writeObserver = new NativeObserver((changes) => {
    if (writeCapture)
      try {
        markWrittenChanges(changes, writeCapture);
      } catch {
        failed = true;
      }
  });
  apply(observerWatch, writeObserver, [document, { childList: true, subtree: true }]);
  let writeCapture = null;
  // What one document.write added: the elements of its records, at most one insertion's bound; the targets of what
  // the bound leaves out are marked partial.
  const markWrittenChanges = (written, capture) => {
    let budget = INSERTION_ELEMENTS;
    const region = regionFor('created-by', capture);
    /* NOSONAR: array-like or mutated collection, index loop kept */ for (let i = 0; i < written.length; i++) {
      const added = apply(mutationAdded, written[i], []),
        length = apply(nodeListLength, added, []);
      for (let j = 0; j < length; j++) {
        if (budget <= 0) {
          if (nodeType(added[j]) === 1) markRegion(added[j], region(), true);
          continue;
        }
        const found = descendants(added[j], budget, region);
        budget -= found.visited;
        for (let k = 0; k < found.nodes.length; k++) remember(found.nodes[k], 'created-by', capture); // NOSONAR: array-like or mutated collection, index loop kept
      }
    }
  };
  // Open shadow roots the page registry found (portal-element-provider.mjs): a document.write that the parser inserts
  // into one is observed there too. Anyone may ask; it only widens what this registry watches.
  const watched = new NativeWeakSet();
  const watchRoot = (root) => {
    if (closed || !root || nodeType(root) !== 11 || !hostOf(root) || apply(weakSetHas, watched, [root])) return false;
    try {
      apply(observerWatch, writeObserver, [root, { __proto__: null, childList: true, subtree: true }]);
    } catch {
      return false;
    }
    apply(weakSetAdd, watched, [root]);
    return true;
  };
  const collectWritten = (capture) => {
    const changes = apply(observerTake, writeObserver, []);
    if (capture) markWrittenChanges(changes, capture);
  };
  const wrapDocumentWritesAndCopies = () => {
    for (const name of ['write', 'writeln']) {
      const descriptor = describe(Document.prototype, name);
      if (typeof descriptor?.value !== 'function' || !descriptor.configurable) continue;
      const original = descriptor.value;
      const write = (receiver, args) => {
        const previous = writeCapture;
        if (!closed)
          try {
            collectWritten(previous);
          } catch {
            /* Native write remains authoritative. */
          }
        writeCapture = lazyStack(wrapper);
        try {
          return apply(original, receiver, args);
        } finally {
          if (!closed)
            try {
              collectWritten(writeCapture);
            } catch {
              failed = true;
            }
          writeCapture = previous;
        }
      };
      const wrapper = shaped(methodLike(name, write), original);
      define(Document.prototype, name, { ...descriptor, value: wrapper });
      restorers[restorers.length] = () => restoreProperty(Document.prototype, name, 'value', wrapper, original);
    }
    restorers[restorers.length] = () => apply(observerStop, writeObserver, []);
    for (const name of ['createElement', 'createElementNS'])
      wrapMethod(Document.prototype, name, {
        after: (_receiver, node, _prior, _args, capture) => remember(node, 'created-by', capture),
      });
    for (const [prototype, name] of [
      [Node.prototype, 'cloneNode'],
      [Document.prototype, 'importNode'],
    ])
      wrapMethod(prototype, name, {
        after: (_receiver, node, _prior, _args, capture) =>
          markNodes(descendants(node, INSERTION_ELEMENTS, regionFor('cloned-by', capture)).nodes, 'cloned-by', capture),
      });
  };
  wrapDocumentWritesAndCopies();
  // Markup parsed outside the document (a fragment of a range, a document of DOMParser) is not recorded where it is
  // parsed: the call that inserts it into the document is ("Inserted by this script").
  // The parent whose children a call changes, for a node (its parent) or an element (itself).
  const elementOf = (node) => (nodeType(node) === 1 ? node : readNode(node, 'parentNode'));
  const parentOf = (node) => readNode(node, 'parentNode');
  const self = (receiver) => [receiver];
  const ofParent = (receiver) => [parentOf(receiver)];
  const ofText = (receiver) => [elementOf(receiver)];
  // What each call claims (see `claimed`).
  const childrenOf = (receiver) => ({ __proto__: null, children: [receiver] });
  const childrenOfParent = (receiver) => ({ __proto__: null, children: [parentOf(receiver)] });
  // What a call changes anywhere below one node (and the node's own children).
  const insideOf = (node) => ({ __proto__: null, within: node });
  // A text call: the children of an element, document or fragment (textContent, innerText), or a character data
  // node's own data.
  const textOf = (receiver) => {
    const type = nodeType(receiver);
    return type === 1 || type === 9 || type === 11
      ? { __proto__: null, children: [receiver] }
      : { __proto__: null, data: receiver };
  };
  const attributeOf = (node, name) => ({ __proto__: null, node, name });
  const wrapMarkupSetters = () => {
    for (const [prototype, name] of [
      [Element.prototype, 'innerHTML'],
      [Element.prototype, 'outerHTML'],
      // A shadow root's markup: content a script writes there is script-made like anywhere else.
      [NativeShadowRoot.prototype, 'innerHTML'],
    ]) {
      const outer = name === 'outerHTML';
      wrapSetter(prototype, name, {
        targets: outer ? ofParent : self,
        claim: outer ? childrenOfParent : childrenOf,
        before: (receiver) =>
          outer
            ? range(
                readNode(receiver, 'parentNode'),
                readNode(receiver, 'previousSibling'),
                readNode(receiver, 'nextSibling'),
              )
            : range(receiver, null, null),
        after: (_receiver, _value, prior, _args, capture) => markRange(prior, capture),
      });
    }
    // setHTMLUnsafe replaces the children of an element or a shadow root with parsed markup, like innerHTML.
    for (const prototype of [Element.prototype, NativeShadowRoot.prototype])
      wrapMethod(prototype, 'setHTMLUnsafe', {
        targets: self,
        claim: childrenOf,
        before: (receiver) => range(receiver, null, null),
        after: (_receiver, _value, prior, _args, capture) => markRange(prior, capture),
      });
  };
  wrapMarkupSetters();
  // The element whose children an insertAdjacent* call changes.
  const adjacentParent = (receiver, args) => {
    if (typeof args[0] !== 'string') return [receiver]; // Never coerce an argument a second time.
    const position = apply(lower, args[0], []);
    return [position === 'beforebegin' || position === 'afterend' ? parentOf(receiver) : receiver];
  };
  const adjacentClaim = (receiver, args) => ({ __proto__: null, children: adjacentParent(receiver, args) });
  wrapMethod(Element.prototype, 'insertAdjacentHTML', {
    targets: adjacentParent,
    claim: adjacentClaim,
    after: (_receiver, _value, prior, _args, capture) => markRange(prior, capture),
    before: (receiver, args) => {
      if (typeof args[0] !== 'string') return null; // Never coerce an argument a second time.
      const position = apply(lower, args[0], []),
        parent = readNode(receiver, 'parentNode');
      if (position === 'beforebegin') return range(parent, readNode(receiver, 'previousSibling'), receiver);
      if (position === 'afterend') return range(parent, receiver, readNode(receiver, 'nextSibling'));
      if (position === 'afterbegin') return range(receiver, null, readNode(receiver, 'firstChild'));
      if (position === 'beforeend') return range(receiver, readNode(receiver, 'lastChild'), null);
      return null;
    },
  });
  // The elements an insertion may change: the parent that takes the nodes, each element it brings (a parser-made one
  // is moved) and the parent each one leaves. A fragment brings its own elements: its first ones stand for it.
  const insertionTargets = (container, args, firstOnly) => {
    const targets = [container],
      count = firstOnly ? minimum(1, args.length) : args.length;
    for (let i = 0; i < count && i < 64; i++) {
      const type = nodeType(args[i]);
      if (!type) continue;
      targets[targets.length] = args[i];
      targets[targets.length] = parentOf(args[i]);
      if (type !== 11) continue;
      let child = firstElementIn(args[i]);
      for (let taken = 0; child && taken < 8; taken++, child = readElement(child, 'element-next'))
        targets[targets.length] = child;
    }
    return targets;
  };
  // What an insertion claims: the child changes of the parent that takes the nodes and of the parents they leave.
  const insertionClaim = (container, args, firstOnly) => {
    const children = [container],
      count = firstOnly ? minimum(1, args.length) : args.length;
    for (let i = 0; i < count && i < 64; i++) if (nodeType(args[i])) children[children.length] = parentOf(args[i]);
    return { __proto__: null, children };
  };
  const siblingInsertion = new NativeSet(['before', 'after', 'replaceWith']);
  const wrapChildInsertions = () => {
    for (const [prototype, names] of [
      [Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']],
      [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'moveBefore']],
      // A document fragment and a shadow root (one is a fragment) take children through these as well.
      [DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren', 'moveBefore']],
      // Text and comment nodes take siblings too.
      [CharacterData.prototype, ['before', 'after', 'replaceWith']],
    ]) {
      for (const name of names) {
        // insertBefore, replaceChild and moveBefore (a move that keeps the element's state, where the browser has it)
        // bring their first argument only: the second names a child that is already there.
        const firstOnly = prototype === Node.prototype || name === 'moveBefore';
        const sibling = apply(setHas, siblingInsertion, [name]);
        wrapMethod(prototype, name, {
          targets: (receiver, args) => insertionTargets(sibling ? parentOf(receiver) : receiver, args, firstOnly),
          claim: (receiver, args) => insertionClaim(sibling ? parentOf(receiver) : receiver, args, firstOnly),
          before: (_receiver, args, capture) => incoming(args, firstOnly, capture),
          after: (_receiver, _value, prior, _args, capture) => markNodes(prior?.nodes ?? [], 'attached-by', capture),
        });
      }
    }
  };
  wrapChildInsertions();
  wrapMethod(Element.prototype, 'insertAdjacentElement', {
    targets: (receiver, args) => [adjacentParent(receiver, args)[0], args[1], parentOf(args[1])],
    claim: (receiver, args) => insertionClaim(adjacentParent(receiver, args)[0], [args[1]], true),
    before: (_receiver, args, capture) => incoming([args[1]], true, capture),
    after: (_receiver, _value, prior, _args, capture) => markNodes(prior?.nodes ?? [], 'attached-by', capture),
  });
  // ---- Removals, text and attributes: changes only.
  wrapMethod(Element.prototype, 'insertAdjacentText', { targets: adjacentParent, claim: adjacentClaim });
  // Entry points that insert elements without naming them: what they add is read from the change observer's records.
  // A range's insertion claims the child changes of the node it inserts into (the parent of a text node it splits, and
  // that text node's data) and of the parent the inserted node leaves; surroundContents also what it extracts, below
  // the range's common ancestor.
  const nothing = () => null;
  const rangeStart = describe(AbstractRange.prototype, 'startContainer')?.get,
    rangeAncestor = describe(Range.prototype, 'commonAncestorContainer')?.get;
  const isCharacterData = (node) => {
    const type = nodeType(node);
    return type === 3 || type === 4 || type === 7 || type === 8;
  };
  const rangeClaim = (surround) => (receiver, args) => {
    const start = apply(rangeStart, receiver, []);
    const children = [isCharacterData(start) ? parentOf(start) : start];
    if (nodeType(args[0])) children[children.length] = parentOf(args[0]);
    if (!surround) return { __proto__: null, children, data: isCharacterData(start) ? start : null };
    const ancestor = apply(rangeAncestor, receiver, []);
    return { __proto__: null, children, within: isCharacterData(ancestor) ? parentOf(ancestor) : ancestor };
  };
  wrapMethod(Range.prototype, 'insertNode', { targets: nothing, adds: 'attached-by', claim: rangeClaim(false) });
  wrapMethod(Range.prototype, 'surroundContents', { targets: nothing, adds: 'attached-by', claim: rangeClaim(true) });
  // deleteContents and extractContents take out what the range holds, below its common ancestor (the text of a
  // text node it cuts included).
  const rangeWithin = (receiver) => {
    const ancestor = apply(rangeAncestor, receiver, []);
    return isCharacterData(ancestor) ? parentOf(ancestor) : ancestor;
  };
  for (const name of ['deleteContents', 'extractContents'])
    wrapMethod(Range.prototype, name, {
      targets: (receiver) => [rangeWithin(receiver)],
      claim: (receiver) => insideOf(rangeWithin(receiver)),
    });
  // execCommand edits the editing host of the selection (or the whole document in design mode): it claims what
  // changes inside that host.
  const selectionOf = Document.prototype.getSelection,
    anchorOf = describe(Selection.prototype, 'anchorNode')?.get,
    editable = describe(HTMLElement.prototype, 'isContentEditable')?.get,
    designMode = describe(Document.prototype, 'designMode')?.get;
  const editingHost = (receiver) => {
    if (apply(designMode, receiver, []) === 'on') return receiver;
    const selection = apply(selectionOf, receiver, []);
    let host = selection ? elementOf(apply(anchorOf, selection, [])) : null;
    if (!host || nodeType(host) !== 1 || !apply(editable, host, [])) return null;
    for (let parent = parentOf(host); parent && nodeType(parent) === 1 && apply(editable, parent, []);)
      ((host = parent), (parent = parentOf(parent)));
    return host;
  };
  wrapMethod(Document.prototype, 'execCommand', {
    targets: nothing,
    adds: 'created-by',
    claim: (receiver) => ({ __proto__: null, within: editingHost(receiver) }),
  });
  for (const prototype of [Element.prototype, NativeShadowRoot.prototype])
    wrapMethod(prototype, 'setHTML', { targets: nothing, adds: 'created-by', claim: childrenOf });
  wrapMethod(Node.prototype, 'removeChild', { targets: self, claim: childrenOf });
  for (const prototype of [Element.prototype, CharacterData.prototype])
    wrapMethod(prototype, 'remove', { targets: ofParent, claim: childrenOfParent });
  wrapMethod(Node.prototype, 'normalize', {
    targets: self,
    claim: (receiver) => ({ __proto__: null, within: receiver }),
  });
  wrapSetter(Node.prototype, 'textContent', { targets: ofText, claim: textOf });
  wrapSetter(Node.prototype, 'nodeValue', { targets: ofText, claim: textOf });
  wrapSetter(CharacterData.prototype, 'data', { targets: ofText, claim: textOf });
  for (const name of ['appendData', 'insertData', 'deleteData', 'replaceData'])
    wrapMethod(CharacterData.prototype, name, { targets: ofText, claim: textOf });
  wrapMethod(Text.prototype, 'splitText', {
    targets: ofText,
    claim: (receiver) => ({ __proto__: null, data: receiver, children: [parentOf(receiver)] }),
  });
  wrapSetter(HTMLElement.prototype, 'innerText', { targets: self, claim: childrenOf });
  // outerText replaces the element with text, which merges with the text nodes next to it.
  wrapSetter(HTMLElement.prototype, 'outerText', {
    targets: ofParent,
    claim: (receiver) => ({ __proto__: null, children: [parentOf(receiver)], dataParent: parentOf(receiver) }),
  });
  // The attribute each attribute method names: by its name (setAttributeNS by the local part of the qualified name,
  // removeAttributeNS by its local name), or by the attribute node it passes.
  const nodeName = (attr) => {
    try {
      return apply(attrLocalName, attr, []);
    } catch {
      return null;
    }
  };
  const localPart = (name) => {
    if (typeof name !== 'string') return null;
    const colon = apply(stringIndex, name, [':']);
    return colon < 0 ? name : apply(stringSlice, name, [colon + 1]);
  };
  for (const [name, named] of [
    ['setAttribute', (receiver, args) => attributeName(receiver, args[0])],
    ['removeAttribute', (receiver, args) => attributeName(receiver, args[0])],
    ['toggleAttribute', (receiver, args) => attributeName(receiver, args[0])],
    ['setAttributeNS', (_receiver, args) => localPart(args[1])],
    ['removeAttributeNS', (_receiver, args) => (typeof args[1] === 'string' ? args[1] : null)],
    ['setAttributeNode', (_receiver, args) => nodeName(args[0])],
    ['setAttributeNodeNS', (_receiver, args) => nodeName(args[0])],
    ['removeAttributeNode', (_receiver, args) => nodeName(args[0])],
  ])
    wrapMethod(Element.prototype, name, {
      targets: self,
      claim: (receiver, args) => attributeOf(receiver, named(receiver, args)),
    });
  const attrOwner = describe(Attr.prototype, 'ownerElement')?.get;
  const ownerElement = (attr) => (attrOwner ? apply(attrOwner, attr, []) : null);
  wrapSetter(Attr.prototype, 'value', {
    targets: (receiver) => [ownerElement(receiver)],
    claim: (receiver) => attributeOf(ownerElement(receiver), nodeName(receiver)),
  });
  // Reflected attributes set through a property: the observer reports the attribute. Each accessor is wrapped on the
  // prototype that defines it, and claims its attribute (the property's name in lowercase, but for these two).
  const reflectedNames = { __proto__: null, className: 'class', htmlFor: 'for' };
  const reflected = [
    'id',
    'className',
    'slot',
    'hidden',
    'title',
    'lang',
    'dir',
    'tabIndex',
    'href',
    'src',
    'disabled',
    'type',
    'name',
    'placeholder',
    'required',
    'readOnly',
    'alt',
    'action',
    'method',
    'target',
    'rel',
    'htmlFor',
    'colSpan',
    'rowSpan',
    'open',
    'multiple',
    'min',
    'max',
    'step',
    'pattern',
    'autocomplete',
    'contentEditable',
  ];
  // Form values a script sets: no attribute changes, so the call names the change itself.
  const formValues = [
    [HTMLInputElement.prototype, 'value', 'value'],
    [HTMLInputElement.prototype, 'checked', 'checked'],
    [HTMLInputElement.prototype, 'indeterminate', 'checked'],
    [HTMLTextAreaElement.prototype, 'value', 'value'],
    [HTMLSelectElement.prototype, 'value', 'value'],
    [HTMLSelectElement.prototype, 'selectedIndex', 'value'],
    [HTMLOptionElement.prototype, 'selected', 'selected'],
  ];
  const elementPrototypes = [Element.prototype, HTMLElement.prototype];
  const wrapReflectedAndFormSetters = () => {
    /* NOSONAR: WindowProxy even if globalThis is reassigned */ for (const key of Object.getOwnPropertyNames(window))
      if (/^HTML[A-Za-z]*Element$/.test(key) && key !== 'HTMLElement' && typeof window[key] === 'function')
        elementPrototypes[elementPrototypes.length] = window[key].prototype;
    for (const prototype of elementPrototypes)
      for (const name of reflected)
        if (prototype && hasOwn(prototype, name)) {
          const attribute = reflectedNames[name] ?? apply(lower, name, []);
          wrapSetter(prototype, name, { targets: self, claim: (receiver) => attributeOf(receiver, attribute) });
        }
    for (const [prototype, name, word] of formValues)
      wrapSetter(prototype, name, { targets: self, extra: (receiver) => ({ __proto__: null, node: receiver, word }) });
  };
  wrapReflectedAndFormSetters();
  // Token lists and style declarations do not name their element: the getters that hand them out remember it, with
  // the attribute the object reflects. The getter returns the browser's own object, unchanged.
  const owners = new NativeWeakMap();
  const ownerOf = (receiver) => [apply(weakGet, owners, [receiver])?.element];
  const ownedClaim = (receiver) => {
    const owner = apply(weakGet, owners, [receiver]);
    return owner ? attributeOf(owner.element, owner.attribute) : null;
  };
  const rememberOwner = (prototype, name, attribute) => {
    const descriptor = prototype ? describe(prototype, name) : null;
    if (typeof descriptor?.get !== 'function' || !descriptor.configurable) return;
    const original = descriptor.get;
    const getter = shaped(
      getterLike(name, (receiver) => {
        const value = apply(original, receiver, []);
        if (!closed && value && typeof value === 'object')
          try {
            if (!apply(weakHas, owners, [value]))
              apply(weakSet, owners, [value, { __proto__: null, element: receiver, attribute }]);
          } catch {
            /* Preserve native behavior. */
          }
        return value;
      }),
      original,
    );
    define(prototype, name, { ...describe(prototype, name), get: getter });
    restorers[restorers.length] = () => restoreProperty(prototype, name, 'get', getter, original);
  };
  const wrapTokenLists = () => {
    rememberOwner(Element.prototype, 'classList', 'class');
    for (const constructor of [HTMLAnchorElement, HTMLAreaElement, HTMLLinkElement, HTMLFormElement])
      rememberOwner(constructor.prototype, 'relList', 'rel');
    for (const name of ['add', 'remove', 'toggle', 'replace'])
      wrapMethod(DOMTokenList.prototype, name, { targets: ownerOf, claim: ownedClaim });
    wrapSetter(DOMTokenList.prototype, 'value', { targets: ownerOf, claim: ownedClaim });
  };
  wrapTokenLists();
  // Style: the declaration's own members (setProperty, removeProperty, cssText, cssFloat) are wrapped on its
  // prototype, so a call through them is attributed whatever object it is applied to; `element.style = text` is the
  // element's own setter. A named property write (`element.style.color = value`) and a dataset write have no hook: the
  // observer lists them without a script.
  // ---- Interfaces that make, insert or remove elements themselves.
  // A table makes the rows, cells and sections it is asked for (and a body for the first row of a table without one):
  // what a call adds or removes below its receiver is the call's. A row or cell it returns is new, also in a table
  // outside the document, where no change record names it; a caption, head or foot it returns may be the template's.
  const wrapTableMembers = () => {
    const returnedNew = (_receiver, node, _prior, _args, capture) => remember(node, 'created-by', capture);
    for (const [constructor, makers, removers] of [
      [
        HTMLTableElement,
        ['insertRow', 'createCaption', 'createTHead', 'createTFoot', 'createTBody'],
        ['deleteRow', 'deleteCaption', 'deleteTHead', 'deleteTFoot'],
      ],
      [HTMLTableSectionElement, ['insertRow'], ['deleteRow']],
      [HTMLTableRowElement, ['insertCell'], ['deleteCell']],
    ]) {
      for (const name of makers) {
        const hooks = { __proto__: null, targets: nothing, adds: 'created-by', claim: insideOf };
        if (name === 'insertRow' || name === 'insertCell') hooks.after = returnedNew;
        wrapMethod(constructor.prototype, name, hooks);
      }
      for (const name of removers) wrapMethod(constructor.prototype, name, { targets: self, claim: insideOf });
    }
  };
  wrapTableMembers();
  // A select inserts the option or group `add` is given (into the group of the option it goes before), takes one out
  // with `remove(index)`, and a shorter or longer `length` removes options or makes empty ones. Its option list does
  // the same and does not name its select: the `options` getter remembers it. (An option assigned by index,
  // `options[2] = option`, has no hook.)
  rememberOwner(HTMLSelectElement.prototype, 'options', null);
  const selectOf = (receiver) => apply(weakGet, owners, [receiver])?.element ?? null;
  for (const [prototype, owner] of [
    [HTMLSelectElement.prototype, (receiver) => receiver],
    [HTMLOptionsCollection.prototype, selectOf],
  ]) {
    wrapMethod(prototype, 'add', {
      targets: (receiver, args) => insertionTargets(owner(receiver), args, true),
      claim: (receiver, args) => {
        const claim = insertionClaim(owner(receiver), args, true);
        claim.within = owner(receiver);
        return claim;
      },
      before: (_receiver, args, capture) => incoming(args, true, capture),
      after: (_receiver, _value, prior, _args, capture) => markNodes(prior?.nodes ?? [], 'attached-by', capture),
    });
    wrapSetter(prototype, 'length', {
      targets: nothing,
      adds: 'created-by',
      claim: (receiver) => insideOf(owner(receiver)),
    });
  }
  // A select's own remove() is the element's (it leaves its parent); remove(index) takes that option out.
  wrapMethod(HTMLSelectElement.prototype, 'remove', {
    targets: (receiver, args) => [args.length ? receiver : parentOf(receiver)],
    claim: (receiver, args) => (args.length ? insideOf(receiver) : childrenOfParent(receiver)),
  });
  wrapMethod(HTMLOptionsCollection.prototype, 'remove', {
    targets: (receiver) => [selectOf(receiver)],
    claim: (receiver) => insideOf(selectOf(receiver)),
  });
  const wrapStyleMembers = () => {
    for (const constructor of [HTMLElement, SVGElement, globalThis.MathMLElement]) {
      rememberOwner(constructor?.prototype, 'style', 'style');
      wrapSetter(constructor?.prototype, 'style', {
        targets: self,
        claim: (receiver) => attributeOf(receiver, 'style'),
      });
    }
    for (const name of ['setProperty', 'removeProperty'])
      wrapMethod(CSSStyleDeclaration.prototype, name, { targets: ownerOf, claim: ownedClaim });
    wrapSetter(CSSStyleDeclaration.prototype, 'cssText', { targets: ownerOf, claim: ownedClaim });
    wrapSetter(CSSStyleDeclaration.prototype, 'cssFloat', { targets: ownerOf, claim: ownedClaim });
  };
  wrapStyleMembers();
  const query = (node, { scope, anchorGeneration } = {}) => /* NOSONAR: answer built in order into shared result */ {
    settle();
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
        limits: { truncated: false, reasons: [] },
      };
    // A limit is reported only for the nodes it affected: one an insertion's bound left out, one recorded without a
    // callsite, one still waiting after the transport dropped evidence, or every node once an observation failed.
    const limited = (reason) => {
      result.limits.truncated = true;
      result.limits.reasons[result.limits.reasons.length] = reason;
    };
    if (closed || !readNode(node, 'isConnected') || readNode(node, 'ownerDocument') !== document) return result;
    if (failed) limited('dom-observation-failed');
    // A region's element is answered with the call that brought it, marked as not recorded one by one.
    let creation = record;
    if (!creation) {
      const region = insideRegion(node);
      if (region) {
        creation = region;
        limited('dom-evidence-limit');
      } else if (region === null) {
        result.availability[0] = { reason: 'dom-evidence-limit' };
        limited('dom-evidence-limit');
        return result;
      }
    }
    if (creation) {
      const reason = addCallsite(result, creation, scope, null);
      if (reason) {
        result.availability[0] = { reason };
        if (reason === 'dom-evidence-limit' || reason === transportLimit) limited(reason);
      }
      return result;
    }
    // An element no script made: the moves and changes recorded for it, newest first.
    const state = apply(weakGet, changes, [node]);
    if (!state) return result;
    if (state.limited) limited('dom-change-limit');
    if (state.dropped) limited('dom-change-history-limit');
    /* NOSONAR: array-like or mutated collection, index loop kept */ for (let i = 0; i < state.entries.length; i++) {
      const entry = state.entries[i];
      if (entry.record) {
        const reason = addCallsite(result, entry.record, scope, entry);
        if (reason !== undefined) addChangeFact(result, entry, scope, reason || 'direct-callsite-unavailable');
      } else addChangeFact(result, entry, scope, entry.reason);
    }
    return result;
  };
  const callsiteLabel = (relationship) => {
    if (relationship === 'attached-by') return 'Inserted by this script';
    if (relationship === 'cloned-by') return 'Copied by this script';
    return 'Created by this script';
  };
  // Why a change's script is not named, in the words of the row.
  const changeReasons = {
    __proto__: null,
    'dom-change-unattributed': ' without a recorded script call',
    'dom-change-limit': ' by a script past the recording limit (its call was not recorded)',
    'dom-evidence-limit': ' by a script past the recording limit (its call was not recorded)',
    'dom-evidence-transport-limit': ' by a script past the recording limit (its call was not recorded)',
    'creation-proof-pending': ' by a script that is still being located',
    'script-callsite-unmapped': ' by a script not found in your sources',
    'script-callsite-ambiguous': ' by a script that matches several of your sources',
    'script-hash-conflict': ' by a script that matches several of your sources',
    'script-version-unverified': ' by a script version that could not be verified',
  };
  const wordsLabel = (what) => {
    if (!what?.length) return '';
    let text = ': ';
    for (let i = 0; i < what.length; i++) text += (i ? ', ' : '') + what[i];
    return text + (what.more ? ' and more' : '');
  };
  // A move or change whose script is not named: what changed, and why no script is named.
  const addChangeFact = (result, entry, scope, reason) => {
    result.facts[result.facts.length] = {
      id: 'dom-change:' + (entry.record?.id ?? 'unattributed') + ':' + result.facts.length,
      scope,
      subject: entry.record?.id ?? 'selection',
      dimension: 'context',
      proof: 'observed-dom-change',
      predicate: entry.relationship,
      reason,
      label:
        (entry.relationship === 'moved-by' ? 'Moved' : 'Changed') +
        (changeReasons[reason] ?? ' by a script whose call could not be located') +
        (entry.relationship === 'moved-by' ? '' : wordsLabel(entry.what)),
    };
  };
  // The label of a callsite fact the transport left without one: the record's relationship, or the move or change.
  const fallbackLabel = (record, entry) => {
    if (!entry) return callsiteLabel(record.relationship);
    return (entry.relationship === 'moved-by' ? 'Moved' : 'Changed') + ' by this script' + wordsLabel(entry.what);
  };
  // Adds the facts of one callsite record to `result`; returns the reason when the record names no script. `entry`:
  // the move or change it records, whose facts the transport labelled; otherwise the element's creation.
  const addCallsite = (result, record, scope, entry) => /* NOSONAR: ordered copy of a cloned proof's own fields */ {
    if (!record.proof) return record.reason ?? transportLimit ?? 'creation-proof-pending';
    const proof = apply(clone, window, [record.proof]); // NOSONAR: preserve the page window receiver and binding
    // Only own fields of the transport's proof: an Object.prototype accessor cannot add a reason, a limit or facts.
    const reason = own(proof, 'reason'),
      limits = own(proof, 'limits');
    const refs = own(proof, 'sourceRefs') ?? [];
    /* NOSONAR: array-like or mutated collection, index loop kept */ for (let i = 0; i < refs.length; i++) {
      let known = false;
      /* NOSONAR: array-like or mutated collection, index loop kept */ for (
        let j = 0;
        j < result.sourceRefs.length;
        j++
      )
        if (own(result.sourceRefs[j], 'id') === own(refs[i], 'id')) known = true;
      if (!known) result.sourceRefs[result.sourceRefs.length] = refs[i];
    }
    if (limits) {
      result.limits.truncated = result.limits.truncated || Boolean(own(limits, 'truncated'));
      const reasons = own(limits, 'reasons') ?? [];
      for (let i = 0; i < reasons.length; i++) result.limits.reasons[result.limits.reasons.length] = reasons[i]; // NOSONAR: array-like or mutated collection, index loop kept
    }
    const facts = own(proof, 'facts') ?? [];
    const valid = typeof reason === 'string' && apply(regexExec, /^[a-z][a-z0-9-]{0,127}$/, [reason]) ? reason : null;
    if (!facts.length) return valid ?? '';
    // The creator's fact takes the node's relationship and its words; a step of the call chain (or a creator that is
    // the portal's own script) carries its own, which the writer's transport set. A move or change keeps the
    // relationship and label the transport gave it, which names what changed.
    /* NOSONAR: array-like or mutated collection, index loop kept */ for (let i = 0; i < facts.length; i++) {
      const predicate = own(facts[i], 'predicate'),
        label = own(facts[i], 'label');
      result.facts[result.facts.length] = {
        ...facts[i],
        scope,
        subject: record.id,
        predicate:
          typeof predicate === 'string' && apply(regexExec, /^[a-z][a-z-]{0,63}$/, [predicate])
            ? predicate
            : record.relationship,
        label: typeof label === 'string' && label.length && label.length <= 256 ? label : fallbackLabel(record, entry),
      };
    }
    if (valid && !entry) result.availability[result.availability.length] = { reason: valid };
    return undefined;
  };
  const resolveRecord = (id, proof) => {
    const record = get(pending, id);
    if (closed || !record || !proof || typeof proof !== 'object' || array(proof)) return false;
    try {
      record.proof = apply(clone, window, [proof]); // NOSONAR: preserve the page window receiver and binding
    } catch {
      return false;
    }
    record.payload = null;
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
    // The notifications of the records still waiting for a proof, oldest first, for a transport that claims this
    // document again after a DevTools re-attach. Only the claimed writer exposes them.
    // One string primitive, newline-separated (a notification has no raw newline): the newest 2048 notifications
    // within 8 MiB, oldest first, since the ones dropped during a re-attach are the newest.
    pendingCallsites() {
      if (closed) return '';
      const payloads = { __proto__: null };
      let total = 0;
      apply(mapForEach, pending, [
        (record) => {
          if (typeof record.payload === 'string') payloads[total++] = record.payload;
        },
      ]);
      let first = total,
        size = 0;
      while (first > 0 && total - first < 2048 && size + payloads[first - 1].length < 8 * 1024 * 1024)
        size += payloads[--first].length + 1;
      let text = '';
      for (let i = first; i < total; i++) text += (i > first ? '\n' : '') + payloads[i];
      return text;
    },
    resolveMany(entries) {
      if (!array(entries) || entries.length > 128 || closed) return 0;
      let count = 0;
      for (let i = 0; i < entries.length; i++) if (resolveRecord(entries[i]?.id, entries[i]?.proof)) count++; // NOSONAR: array-like or mutated collection, index loop kept
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
    // true: a script made or moved this node; false: no script did; null: not known (a partial region, a failed
    // observation, a closed registry).
    // A move of an element the parser made, or a change of one, is no creation: it stays false for that element.
    isScriptObserved(node) {
      if (closed || failed) return null;
      if (stored(node)) return true;
      settle();
      const region = insideRegion(node);
      if (region) return true;
      return region === null ? null : false;
    },
    watchRoot,
    isScriptCreated(node) {
      if (!stored(node)) settle();
      const record = stored(node) ?? insideRegion(node);
      return record?.relationship === 'created-by' || record?.relationship === 'cloned-by';
    },
    // Every claim with the secret returns the same writer: a DevTools session that Chromium re-attaches to this
    // unchanged document loses its earlier object handles and must claim the writer again.
    claim(value) {
      return value === secret && !closed ? writer : null;
    },
    // The backend retires a registry by its context when the writer never reached it: a claim still in flight, a claim
    // that was never admitted, a context beyond its record limit. The key only closes this registry; it admits nothing.
    release(value) {
      if (!releaseKey || value !== releaseKey) return false;
      writer.dispose();
      return true;
    },
  });
  define(window, slot, { value: reader, configurable: false, writable: false }); // NOSONAR: preserve the page window receiver and binding
}
