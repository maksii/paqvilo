/** Serializable early bootstrap. Only a backend-held writer can admit response descriptors. */
// NOSONAR: window preserves the browser WindowProxy boundary when page code reassigns globalThis.
//
// The response marks each element it binds with `data-paqvilo-source` (an id of 64 random bits, nothing derivable
// from another element's). This registry reads the mark of each element the parser inserts, remembers it and removes
// it, so the DOM that page scripts read and serialize is the portal's own; it removes the inline script proof id
// (`data-paqvilo-script`) the same way. What a page can still see of them:
// - Page mutation observers never receive a record about either attribute (its removal included): MutationObserver
//   is wrapped so that such a record is never delivered (`installMarkFilter`, below; also installed alone in
//   same-origin about:blank and srcdoc frames by the script transport). A page that writes one of these two
//   attributes itself is not told about its own write either.
// - Code that runs while the parser inserts an element and before the next microtask checkpoint can read marks that
//   are not removed yet: a custom element's reactions (connectedCallback, attributeChangedCallback), a synchronous
//   event fired during parsing (an about:blank iframe's load event), and a microtask queued before this registry's
//   observer microtask (a promise a custom element constructor makes). Inline and external scripts run after a
//   checkpoint and never see one. What such code reads is harmless: the id of one element says nothing about another
//   element's, and a copy of it gains nothing and costs the element that owns it nothing (`decide`, below).
// - Elements inside a closed shadow root carry no mark (only their component could read it): their bindings name their
//   place under the host's binding, and the backend hands the root over when Inspect reads it through the DevTools
//   protocol (`admitSealed`, below).
// `markFilterOnly`: install only the filter (a frame whose document carries no marks of its own).
export function installPortalProvenanceRegistry({
  secret,
  slot,
  domProvenanceSlot,
  releaseKey,
  limit = 50000,
  markFilterOnly = false,
}) {
  const marker = 'data-paqvilo-source',
    // The response's inline script proof id (mirage/lib/render-provenance.mjs): no page code needs it, so it is
    // removed from every script element this registry visits, like the mark.
    scriptMarker = 'data-paqvilo-script';
  const apply = Reflect.apply,
    construct = Reflect.construct,
    clone = structuredClone,
    freeze = Object.freeze,
    define = Object.defineProperty;
  const getter = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
  const descriptorOf = Object.getOwnPropertyDescriptor;
  const NativeObserver = MutationObserver;
  // Page mutation observers never see the mark: a record whose attribute is the mark is dropped from what a page
  // callback and takeRecords() receive, and a callback left with no record is not called. MutationObserver keeps its
  // prototype object, `instanceof`, subclassing (`new.target`), its name and length, and its errors (an observer
  // created without `new` or without a callable is the native's own refusal).
  const installMarkFilter = () => {
    const prototype = NativeObserver.prototype,
      nativeTake = prototype.takeRecords;
    const recordType = getter(MutationRecord.prototype, 'type'),
      recordAttribute = getter(MutationRecord.prototype, 'attributeName');
    const put = (list, value) =>
      define(list, list.length, { __proto__: null, value, writable: true, enumerable: true, configurable: true });
    // The records without the mark's: the browser's own array when it has none.
    const kept = (records) => {
      let left = null;
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const name = apply(recordType, record, []) === 'attributes' ? apply(recordAttribute, record, []) : null;
        const mark = name === marker || name === scriptMarker;
        if (mark && !left) {
          left = [];
          for (let j = 0; j < i; j++) put(left, records[j]);
        } else if (!mark && left) put(left, record);
      }
      return left ?? records;
    };
    const Observer = function MutationObserver(callback) {
      if (!new.target) return apply(NativeObserver, this, [callback]);
      if (typeof callback !== 'function') return construct(NativeObserver, [callback], new.target);
      const delivered = function (records, observer) {
        const left = kept(records);
        if (left.length) return apply(callback, this, [left, observer]);
      };
      return construct(NativeObserver, [delivered], new.target);
    };
    define(Observer, 'prototype', { __proto__: null, value: prototype, writable: false });
    define(prototype, 'constructor', { ...descriptorOf(prototype, 'constructor'), value: Observer });
    const take = {
      __proto__: null,
      takeRecords() {
        return kept(apply(nativeTake, this, []));
      },
    }.takeRecords;
    define(take, 'length', { __proto__: null, value: nativeTake.length });
    define(prototype, 'takeRecords', { ...descriptorOf(prototype, 'takeRecords'), value: take });
    for (const name of ['MutationObserver', 'WebKitMutationObserver'])
      if (window[name] === NativeObserver) define(window, name, { ...descriptorOf(window, name), value: Observer }); // NOSONAR: preserve the page window receiver and binding
  };
  if (markFilterOnly) {
    installMarkFilter();
    return;
  }
  // A slot that already exists belongs to the page (it cannot be replaced): the registry is refused for this document.
  // The transport finds no function of this bootstrap there, so it claims nothing and reports the document.
  if (!secret || !slot || Object.hasOwn(window, slot)) return; // NOSONAR: preserve the page window receiver and binding
  const lock = (object, prototype, names) => {
    for (let i = 0; i < names.length; i++) define(object, names[i], { value: prototype[names[i]].bind(object) }); // NOSONAR: array-like or mutated collection, index loop kept
    return object;
  };
  const nodeType = getter(Node.prototype, 'nodeType'),
    childNodes = getter(Node.prototype, 'childNodes');
  const ownerDocument = getter(Node.prototype, 'ownerDocument'),
    connected = getter(Node.prototype, 'isConnected');
  const localName = getter(Element.prototype, 'localName');
  const templatePrototype = HTMLTemplateElement.prototype;
  const templateDescriptor = Object.getOwnPropertyDescriptor(templatePrototype, 'content');
  const templateContent = templateDescriptor.get;
  const domReader = domProvenanceSlot ? window[domProvenanceSlot] : null;
  const scriptObserved = domReader?.isScriptObserved ?? null,
    watchRoot = domReader?.watchRoot ?? null;
  // Open shadow roots are observed like the document (a closed root stays a boundary: its content is never read).
  const shadowRootOf = getter(Element.prototype, 'shadowRoot'),
    shadowHostOf = getter(ShadowRoot.prototype, 'host');
  const observedRoots = lock(new WeakSet(), WeakSet.prototype, ['add', 'has']);
  // Nodes left unbound because the script registry could not say whether a script made them (its insertion bound).
  const unknownOrigin = lock(new WeakSet(), WeakSet.prototype, ['add', 'has']);
  const read = (get, node) => apply(get, node, []);
  const getAttribute = Element.prototype.getAttribute;
  const attribute = (node, name) => apply(getAttribute, node, [name]);
  // The mark is removed through the attribute map's own removeNamedItem, a native no recorder wraps: the removal is
  // never a recorded script call, and page observers never receive its record (installMarkFilter).
  const attributesOf = getter(Element.prototype, 'attributes'),
    removeNamed = NamedNodeMap.prototype.removeNamedItem;
  const querySelectorAll = Element.prototype.querySelectorAll,
    readyState = getter(Document.prototype, 'readyState');
  const originals = lock(new Map(), Map.prototype, ['get', 'set', 'has', 'clear']);
  // Ids two elements carried in one batch whose order the browser's records cannot prove: no element is named by them.
  const contested = lock(new Set(), Set.prototype, ['add', 'has', 'clear']);
  const contestedNodes = lock(new WeakSet(), WeakSet.prototype, ['add', 'has']);
  // Every id a parser-made element carried: a mark with one of these values is the response's and is removed wherever
  // it is found (a copy a script made of it included); a value no parser element carried is the page's own.
  const responseIds = lock(new Set(), Set.prototype, ['add', 'has', 'clear']);
  const nodeIds = lock(new WeakMap(), WeakMap.prototype, ['get', 'set', 'has']);
  const inertOwners = lock(new WeakMap(), WeakMap.prototype, ['get', 'set']);
  const revoked = lock(new WeakSet(), WeakSet.prototype, ['add', 'has']);
  const changedAttributes = lock(new WeakMap(), WeakMap.prototype, ['get', 'set']);
  const proofs = lock(new Map(), Map.prototype, ['get', 'set', 'delete', 'clear', 'forEach']);
  const relevantAttribute =
    /^(?:id|name|type|data-(?:entityname|formid|viewid|listid|control-id|control-name|pcf-schema|pcf-control|pcf-name))$/;
  const testAttribute = RegExp.prototype.test.bind(relevantAttribute);
  const getMapSize = getter(Map.prototype, 'size'),
    getSetSize = getter(Set.prototype, 'size');
  const NativeCustomEvent = CustomEvent,
    dispatch = EventTarget.prototype.dispatchEvent;
  const NativeWeakSet = WeakSet,
    NativeMap = Map,
    seenHas = WeakSet.prototype.has,
    seenAdd = WeakSet.prototype.add,
    mapGet = Map.prototype.get,
    mapSet = Map.prototype.set,
    mapForEach = Map.prototype.forEach;
  const recordGetters = {};
  for (const name of ['type', 'target', 'attributeName', 'oldValue', 'addedNodes'])
    recordGetters[name] = getter(MutationRecord.prototype, name);
  const recordValue = (record, name) => read(recordGetters[name], record);
  // A handle per answered element for the facts of its answer: random, unrelated to its mark.
  const handles = lock(new WeakMap(), WeakMap.prototype, ['get', 'set']);
  const randomWords = crypto.getRandomValues,
    NativeWords = Uint32Array,
    hexOf = Number.prototype.toString;
  const handleOf = (node) => {
    let handle = handles.get(node);
    if (!handle) {
      const words = apply(randomWords, crypto, [new NativeWords(2)]);
      handle = 'element-' + apply(hexOf, words[0], [16]) + apply(hexOf, words[1], [16]);
      handles.set(node, handle);
    }
    return handle;
  };
  let disposed = false,
    truncated = false;
  const markerOf = (node) => (node && read(nodeType, node) === 1 ? attribute(node, marker) : null);
  // Removes a mark the response carried (see `responseIds`) from `node`.
  const strip = (node) => {
    const value = markerOf(node);
    if (value === null || !responseIds.has(value)) return;
    try {
      apply(removeNamed, read(attributesOf, node), [marker]);
    } catch {
      /* Already gone. */
    }
  };
  // ---- Which element a mark names.
  //
  // A mark names the parser's element: the first element that carries it in the order the browser inserted them into
  // this document. A script can only copy a mark from an element that already exists, so a copy always comes later:
  // - an element seen in an earlier batch of records keeps its mark; one that carries it later gains nothing and costs
  //   the first nothing;
  // - in one batch, elements are ordered by the record that inserted them (each parser insertion has its own record);
  //   an element found below another without a record of its own came with it. Content of a shadow root or a template
  //   has no records of its own (the parser fills them before they are observed): its order is not known. When two
  //   elements carry one mark and the earlier one is not proved earlier, neither is named (the answer says the
  //   identity is not known);
  // - an element a recorded script call made, copied or inserted is never a candidate (lense/dom-provenance.mjs).
  const newBatch = () => ({
    __proto__: null,
    direct: new NativeMap(),
    candidates: new NativeMap(),
    marked: [],
    scripts: [],
    seen: new NativeWeakSet(),
    budget: { nodes: 0 },
  });
  const consider = (batch, node, id, owner, time, exact) => {
    if (!id || id.length > 256 || read(nodeType, node) !== 1) return;
    batch.marked[batch.marked.length] = node;
    if (nodeIds.has(node)) return;
    if (scriptObserved) {
      const made = scriptObserved(node);
      // Not known whether a script made it: it names nothing, and its mark is removed like a response's.
      if (made === null) {
        unknownOrigin.add(node);
        if (read(getSetSize, responseIds) < limit) responseIds.add(id);
      }
      if (made !== false) return;
    }
    let list = apply(mapGet, batch.candidates, [id]);
    if (!list) {
      list = [];
      apply(mapSet, batch.candidates, [id, list]);
    }
    list[list.length] = { __proto__: null, node, owner, time, exact };
  };
  const admit = (node, id, owner) => {
    if (!originals.has(id) && read(getMapSize, originals) >= limit) {
      truncated = true;
      return;
    }
    nodeIds.set(node, id);
    originals.set(id, node);
    if (inertOwner(owner)) inertOwners.set(node, owner);
  };
  const inertOwner = (owner) => owner && nodeIds.has(owner) && originals.get(nodeIds.get(owner)) === owner;
  const decide = (batch) => {
    apply(mapForEach, batch.candidates, [
      (list, id) => {
        if (read(getSetSize, responseIds) < limit) responseIds.add(id);
        // Seen before: these are later copies.
        if (originals.has(id) || contested.has(id)) return;
        let first = list[0];
        for (let i = 1; i < list.length; i++) if (list[i].time < first.time) first = list[i];
        let proved = list.length === 1 || first.exact;
        for (let i = 0; proved && i < list.length; i++)
          if (list[i] !== first && list[i].node !== first.node && list[i].time <= first.time) proved = false;
        if (proved) admit(first.node, id, first.owner);
        else {
          contested.add(id);
          for (let i = 0; i < list.length; i++) contestedNodes.add(list[i].node); // NOSONAR: array-like or mutated collection, index loop kept
        }
      },
    ]);
    for (let i = 0; i < batch.marked.length; i++) strip(batch.marked[i]); // NOSONAR: array-like or mutated collection, index loop kept
    /* NOSONAR: array-like or mutated collection, index loop kept */ for (let i = 0; i < batch.scripts.length; i++)
      if (attribute(batch.scripts[i], scriptMarker) !== null)
        try {
          apply(removeNamed, read(attributesOf, batch.scripts[i]), [scriptMarker]);
        } catch {
          /* Already gone. */
        }
  };
  // While the document is being parsed a script can copy an element that still carries its mark (a custom element's
  // reaction): the marks below a script-made element are removed too. After parsing no parser mark is left to copy.
  const markedBelow = (batch, node) => {
    if (apply(readyState, document, []) !== 'loading') return;
    let found;
    try {
      found = apply(querySelectorAll, node, ['[' + marker + ']']);
    } catch {
      return;
    }
    for (let i = 0; i < found.length && i < limit; i++) batch.marked[batch.marked.length] = found[i];
  };
  // Visits `node`'s subtree. `time`: the index of the record that inserted it; `exact`: false inside a shadow root or
  // a template's content, whose own insertions have no records here. A descendant that a later record of the batch
  // inserted (`batch.direct`) is visited at that record instead.
  const subtree = (batch, node, visit, time, exact) => /* NOSONAR: one stack walk sharing its cursor and budget */ {
    const stack = [{ node, owner: null, exact }];
    let size = 1;
    while (size) {
      const { node: current, owner, exact: proved } = stack[--size];
      if (apply(seenHas, batch.seen, [current])) continue;
      if (current !== node) {
        const at = apply(mapGet, batch.direct, [current]);
        if (at !== undefined && at > time) continue;
      }
      apply(seenAdd, batch.seen, [current]);
      if (++batch.budget.nodes > limit) {
        truncated = true;
        return;
      }
      visit(current, owner, proved);
      if (read(nodeType, current) === 1 && read(localName, current) === 'script')
        batch.scripts[batch.scripts.length] = current;
      // An element a script made (the script registry says so: it was created, copied or inserted by a recorded call)
      // brought its subtree with it: nothing below it is the parser's, except a parser element moved into it, which
      // its own parser record names. Its subtree is not walked, so a page that builds thousands of elements does not
      // spend this registry's bound on them.
      const element = read(nodeType, current) === 1;
      const made = element && scriptObserved && !nodeIds.has(current) && scriptObserved(current) === true;
      if (made) markedBelow(batch, current);
      else {
        const children = read(childNodes, current);
        for (let i = children.length - 1; i >= 0; i--) stack[size++] = { node: children[i], owner, exact: proved };
        if (element && read(localName, current) === 'template')
          stack[size++] = { node: read(templateContent, current), owner: current, exact: false };
      }
      // The parser attaches a declarative shadow root when it reads the template's start tag and streams the rest
      // into it, so the root exists by the time its host is seen: content already in it is visited now, content that
      // follows arrives as records of its own observation.
      const root = element ? read(shadowRootOf, current) : null;
      if (root && !observedRoots.has(root)) {
        observedRoots.add(root);
        observer.observe(root, observation);
        if (watchRoot) watchRoot(root);
        if (!made) stack[size++] = { node: root, owner, exact: false };
      }
    }
  };
  const oldMarkersFor = (records) => {
    // A script may remove a parser marker before this microtask; MutationRecord retains the original node.
    const oldMarkers = [];
    // NOSONAR: page scripts can replace the array iterator after early bootstrap.
    /* NOSONAR */ for (let i = 0; i < records.length; i++) {
      // NOSONAR: preserve indexed native-record access and mutation order
      const record = records[i];
      if (
        recordValue(record, 'type') === 'attributes' &&
        recordValue(record, 'attributeName') === marker &&
        recordValue(record, 'oldValue')
      )
        oldMarkers[oldMarkers.length] = { node: recordValue(record, 'target'), id: recordValue(record, 'oldValue') };
    }
    return oldMarkers;
  };
  const originalMarker = (node, oldMarkers) => {
    for (let i = 0; i < oldMarkers.length; i++) if (oldMarkers[i].node === node) return oldMarkers[i].id; // NOSONAR: array-like or mutated collection, index loop kept
    return markerOf(node);
  };
  const processChildList = (batch, record, time, oldMarkers) => {
    const added = recordValue(record, 'addedNodes');
    /* NOSONAR: array-like or mutated collection, index loop kept */ for (let j = 0; j < added.length; j++)
      subtree(
        batch,
        added[j],
        (child, owner, exact) => consider(batch, child, originalMarker(child, oldMarkers), owner, time, exact),
        time,
        true,
      );
  };
  // A change of the mark itself is not a change of the element: the element a mark named keeps it, and a mark a
  // script writes later names nothing (a response's mark written somewhere is removed again, see `strip`). Changes
  // of the attributes a platform binding is named by are kept.
  const processAttributeMutation = (batch, record) => {
    const node = recordValue(record, 'target'),
      name = recordValue(record, 'attributeName');
    if (name === marker) {
      batch.marked[batch.marked.length] = node;
      return;
    }
    if (nodeIds.has(node) && testAttribute(name) && attribute(node, name) !== recordValue(record, 'oldValue')) {
      let changes = changedAttributes.get(node);
      if (!changes) {
        changes = lock(new Set(), Set.prototype, ['add', 'has']);
        changedAttributes.set(node, changes);
      }
      changes.add(name);
    }
  };
  const observe = (records) => {
    if (records.length > limit) {
      truncated = true;
      return;
    }
    const batch = newBatch();
    const oldMarkers = oldMarkersFor(records);
    // NOSONAR: keep mutation records independent of page-owned array iteration.
    for (let i = 0; i < records.length; i++) {
      if (recordValue(records[i], 'type') !== 'childList') continue;
      const added = recordValue(records[i], 'addedNodes');
      /* NOSONAR: array-like or mutated collection, index loop kept */ for (let j = 0; j < added.length; j++)
        if (apply(mapGet, batch.direct, [added[j]]) === undefined) apply(mapSet, batch.direct, [added[j], i]);
    }
    for (let i = 0; i < records.length; i++) {
      // NOSONAR: preserve indexed native-record access and mutation order
      const type = recordValue(records[i], 'type');
      if (type === 'childList') processChildList(batch, records[i], i, oldMarkers);
      else if (type === 'attributes') processAttributeMutation(batch, records[i]);
    }
    decide(batch);
  };
  const observer = new NativeObserver(observe);
  // A null-prototype dictionary: an option a page script adds to Object.prototype is never read for a later root.
  const observation = { __proto__: null, subtree: true, childList: true, attributes: true, attributeOldValue: true };
  const takeRecords = observer.takeRecords.bind(observer),
    disconnect = observer.disconnect.bind(observer);
  define(observer, 'observe', { value: observer.observe.bind(observer) });
  observer.observe(document, observation);
  installMarkFilter();
  // A template's content is read when a script asks for it: its marks are taken (and removed) first.
  const contentGetter = descriptorOf(
    {
      __proto__: null,
      get content() {
        const content = read(templateContent, this);
        observe(takeRecords());
        const batch = newBatch();
        subtree(batch, this, (node, owner, exact) => consider(batch, node, markerOf(node), owner, 0, exact), 0, false);
        decide(batch);
        return content;
      },
    },
    'content',
  ).get;
  define(templatePrototype, 'content', { ...templateDescriptor, get: contentGetter });
  // A copy of an admitted original is never that original: cloneNode and importNode are wrapped so that each node of a
  // copy whose source node is an admitted original (or itself a contested node) is contested, and a query for it says
  // its identity is revoked. The copy is walked beside its source, as `subtree` walks (template content and open
  // shadow roots included), up to `limit` nodes; a level whose child counts differ is not paired. The native is
  // called first with the caller's own arguments and its result or error is the caller's; the bookkeeping never
  // throws. A recorder wrapper installed before or after this one (lense/dom-provenance.mjs) is called or calls this
  // one unchanged, and each restores only its own wrapper.
  const copyRestorers = [],
    listLength = getter(NodeList.prototype, 'length');
  const markCopy = (source, copy) => /* NOSONAR: one stack walk sharing its cursor and budget */ {
    const stack = [source, copy];
    let size = 2,
      visited = 0;
    while (size && visited < limit) {
      const to = stack[--size],
        from = stack[--size];
      visited++;
      const id = nodeIds.get(from);
      if ((id !== undefined && originals.get(id) === from) || contestedNodes.has(from)) contestedNodes.add(to);
      const fromChildren = read(childNodes, from),
        toChildren = read(childNodes, to),
        count = read(listLength, fromChildren);
      if (count === read(listLength, toChildren))
        for (let i = count - 1; i >= 0; i--) {
          stack[size++] = fromChildren[i];
          stack[size++] = toChildren[i];
        }
      if (read(nodeType, from) !== 1 || read(nodeType, to) !== 1) continue;
      if (read(localName, from) === 'template' && read(localName, to) === 'template') {
        stack[size++] = read(templateContent, from);
        stack[size++] = read(templateContent, to);
      }
      const fromRoot = read(shadowRootOf, from),
        toRoot = read(shadowRootOf, to);
      if (fromRoot && toRoot) {
        stack[size++] = fromRoot;
        stack[size++] = toRoot;
      }
    }
  };
  for (const [prototype, name] of [
    [Node.prototype, 'cloneNode'],
    [Document.prototype, 'importNode'],
  ]) {
    const descriptor = descriptorOf(prototype, name);
    if (typeof descriptor?.value !== 'function' || !descriptor.configurable) continue;
    const native = descriptor.value;
    const source = name === 'cloneNode' ? (receiver) => receiver : (_receiver, args) => args[0];
    const wrapper = {
      __proto__: null,
      [name](...args) {
        const copy = apply(native, this, args);
        if (!disposed)
          try {
            markCopy(source(this, args), copy);
          } catch {
            /* Preserve native behavior. */
          }
        return copy;
      },
    }[name];
    define(wrapper, 'name', { __proto__: null, value: native.name });
    define(wrapper, 'length', { __proto__: null, value: native.length });
    define(prototype, name, { ...descriptor, value: wrapper });
    copyRestorers[copyRestorers.length] = () => {
      if (descriptorOf(prototype, name)?.value === wrapper) define(prototype, name, descriptor);
    };
  }
  const findProofBinding = (proof, id) => {
    let binding = null;
    for (let i = 0; i < proof.bindings.length; i++) if (proof.bindings[i].id === id) binding = proof.bindings[i]; // NOSONAR: array-like or mutated collection, index loop kept
    return binding;
  };
  const proofBindingIsValid = (proof, binding, node) => {
    if (binding.inertTemplateId) {
      const owner = inertOwners.get(node);
      if (!owner || nodeIds.get(owner) !== binding.inertTemplateId || originals.get(binding.inertTemplateId) !== owner)
        return false;
    }
    if (read(localName, node) !== binding.tag) return false;
    const attributes = binding.attributes ?? [];
    // An identity attribute (`relevantAttribute`: id, name, type and the listed data-* names) that a script changed
    // since the parser made the element ends its source binding, even when the value is changed back: a script that
    // repurposes the element makes it no longer what the response wrote, and the answer has no facts rather than a
    // source the element may no longer have. A platform binding, named by its attributes, ends when one of those
    // changed. Class, style and aria changes are not tracked and keep either binding.
    const changes = changedAttributes.get(node);
    if (changes) {
      if (binding.mapping !== 'platform') return false;
      for (let i = 0; i < attributes.length; i++) if (changes.has(attributes[i].name)) return false; // NOSONAR: array-like or mutated collection, index loop kept
    }
    /* NOSONAR: array-like or mutated collection, index loop kept */ for (let i = 0; i < attributes.length; i++)
      if (attribute(node, attributes[i].name) !== attributes[i].value) return false;
    return true;
  };
  const addRelevantSourceRefs = (result, proof, ids, contexts) => {
    /* NOSONAR */ for (let i = 0; i < proof.sourceRefs.length; i++) {
      let relevant = false;
      for (let j = 0; j < ids.length; j++) if (proof.sourceRefs[i].id === ids[j]) relevant = true; // NOSONAR: array-like or mutated collection, index loop kept
      for (let j = 0; j < contexts.length; j++) if (proof.sourceRefs[i].id === contexts[j].sourceRefId) relevant = true; // NOSONAR: array-like or mutated collection, index loop kept
      if (relevant) result.sourceRefs[result.sourceRefs.length] = clone(proof.sourceRefs[i]);
    }
  };
  // `handle`: the answer's name for the element (`handleOf`); the facts never carry the element's mark or the proof's id.
  const addProof = (proof, node, id, result, scope, handle) => /* NOSONAR: facts written in order from one binding */ {
    const binding = findProofBinding(proof, id);
    if (!binding || !proofBindingIsValid(proof, binding, node)) return false;
    const local = proof.channel === 'mirage-render';
    if (proof.complete === false) result.limits.truncated = true;
    result.mode = local ? 'local' : 'live';
    result.sourceRefs = [];
    const all = clone(binding.sourceRefIds ?? [binding.sourceRefId]);
    const contexts = binding.contexts ?? [];
    addRelevantSourceRefs(result, proof, all, contexts);
    // "served": the binding was read off the document the portal served (lense/response-alignment.mjs), not written by
    // Lense and not reported by a local render.
    const served = binding.origin === 'served';
    // Generated markup with a known writer: the region is that writer's Liquid code. Other files that only supplied
    // a value are named in a fact of their own, without that region.
    const located = binding.mapping === 'derived' && binding.region && typeof binding.sourceRefId === 'string';
    const ids = located ? [binding.sourceRefId] : all;
    const renderBindingKind = () => {
      if (binding.mapping === 'platform') return served ? 'served-platform' : 'render-platform';
      if (binding.mapping === 'conflicting') return 'binding-conflict';
      if (binding.mapping === 'derived') {
        if (!located) return 'render-derived';
        if (binding.drift) return 'served-drift';
        return served ? 'served-generated' : 'render-generated';
      }
      if (local) return 'render-literal';
      return served ? 'served-literal' : 'lense-applied-literal';
    };
    const renderBindingPredicate = () => {
      if (binding.mapping === 'platform') return 'identity';
      if (binding.mapping === 'derived') return 'implementation';
      return 'created-by';
    };
    result.facts[0] = {
      id: 'response:' + handle,
      scope,
      dimension: binding.mapping === 'platform' ? 'owner' : 'source',
      kind: renderBindingKind(),
      subject: handle,
      predicate: renderBindingPredicate(),
      ...(binding.mapping === 'platform' ? { binding: clone(binding.component) } : {}),
      sourceRefIds: ids,
      region: binding.region,
      renderSourceRevision: proof.sourceRevision,
      // The file is known; it holds this tag in several identical places and the page does not show which one.
      ...(binding.oneOf ? { label: 'One of ' + binding.oneOf + ' identical places in this file' } : {}),
      // The Liquid tags and outputs of the code that wrote generated markup (lense/response-alignment.mjs), so the
      // card can name the tag. inspection-evidence.mjs bounds them again.
      ...(located && Array.isArray(binding.liquid) && binding.liquid.length
        ? { liquid: clone(binding.liquid.slice(0, 4)) }
        : {}),
    };
    if (located) {
      const others = [];
      for (let i = 0; i < all.length; i++) if (all[i] !== binding.sourceRefId) others[others.length] = all[i]; // NOSONAR: array-like or mutated collection, index loop kept
      if (others.length)
        result.facts[result.facts.length] = {
          id: 'response:contributors:' + handle,
          scope,
          dimension: 'source',
          kind: 'render-derived',
          subject: handle,
          predicate: 'implementation',
          sourceRefIds: others,
          renderSourceRevision: proof.sourceRevision,
        };
    }
    for (let i = 0; i < contexts.length; i++)
      result.facts[result.facts.length] = {
        id: 'response:context:' + i + ':' + handle,
        scope,
        dimension: 'context',
        // A record whose data the element shows (a web link, a site marker, a page) or the template that included
        // the element's source.
        kind: contexts[i].relationship === 'data-record' ? 'render-record' : 'render-invocation',
        subject: handle,
        predicate: 'declares',
        sourceRefIds: [contexts[i].sourceRefId],
        region: contexts[i].region,
        renderSourceRevision: proof.sourceRevision,
      };
    return true;
  };
  /* NOSONAR: ordered availability checks on one result */ const query = (node, { scope, anchorGeneration } = {}) => {
    observe(takeRecords());
    const result = {
      version: 1,
      mode: 'live',
      scope,
      anchorGeneration,
      // The element's mark is never part of the answer (a page script reads this answer too).
      node: {
        tag: node && read(nodeType, node) === 1 ? read(localName, node) : null,
        connected: Boolean(node && read(connected, node)),
      },
      sourceRefs: [],
      facts: [],
      availability: [],
      limits: { truncated },
    };
    if (truncated) {
      result.availability[0] = { reason: 'registry-limit' };
      return result;
    }
    if (!node || read(ownerDocument, node) !== document || !read(connected, node)) {
      result.availability[0] = { reason: 'node-detached-or-foreign' };
      return result;
    }
    // A descriptor too large to deliver: its transport published only that fact (portal-provenance-transport.mjs), so
    // no node of the document can be proved, and the answer says why instead of "not proved".
    const tooLarge = () => {
      let found = false;
      proofs.forEach((proof) => {
        if (proof.unavailable === 'response-proof-too-large') found = true;
      });
      if (found) {
        result.availability[0] = { reason: 'response-proof-too-large' };
        result.limits.truncated = true;
      }
      return found;
    };
    const id = nodeIds.get(node);
    // Whether this document's elements were named at all: a tag without a name in a named document is one the
    // document's source does not write.
    result.published = read(getMapSize, proofs) > 0;
    if (!id || revoked.has(node) || originals.get(id) !== node) {
      result.availability[0] = { reason: id || contestedNodes.has(node) ? 'node-identity-revoked' : 'node-not-proved' };
      // A proof that stopped at its binding limit left later elements of the document unbound: say so for a node
      // without a binding, instead of "not proved".
      if (!id && !contestedNodes.has(node) && !tooLarge()) {
        let incomplete = false;
        proofs.forEach((proof) => {
          if (proof.complete === false) incomplete = true;
        });
        if (incomplete) {
          result.availability[0] = { reason: 'response-proof-incomplete' };
          result.limits.truncated = true;
        } else if (unknownOrigin.has(node)) {
          // The script registry's insertion bound left this node out: whether a script made it is not known.
          result.availability[0] = { reason: 'script-provenance-limit' };
          result.limits.truncated = true;
        }
      }
      return result;
    }
    let admitted = false;
    proofs.forEach((proof) => {
      if (!admitted) admitted = addProof(proof, node, id, result, scope, handleOf(node));
    });
    if (admitted) return clone(result);
    result.availability[0] = { reason: 'response-proof-not-published' };
    tooLarge();
    return result;
  };
  // The binding of each place under the host whose binding is `hostId` (a closed shadow root's elements, by their
  // element index path from the root; lib/render-provenance.mjs sealedChildren).
  const sealedPlaces = (hostId) => {
    const places = new NativeMap();
    proofs.forEach((proof) => {
      for (let i = 0; i < proof.bindings.length; i++) {
        const sealed = proof.bindings[i].sealed;
        if (sealed?.host === hostId && typeof sealed.path === 'string')
          apply(mapSet, places, [sealed.path, proof.bindings[i].id]);
      }
    });
    return places;
  };
  // Names each element of `root` by the binding of its place, up to `limit` elements; a template's content is left out.
  const admitPlaces = (root, places) => {
    const stack = [{ node: root, path: '' }];
    for (let visited = 0; stack.length && visited < limit; visited++) {
      const { node, path } = stack.pop();
      const children = elementChildren(node);
      for (let i = 0; i < children.length; i++) {
        const child = children[i],
          place = path ? path + '.' + i : String(i);
        const id = apply(mapGet, places, [place]);
        if (id && !nodeIds.has(child) && !originals.has(id)) admit(child, id, null);
        if (read(localName, child) !== 'template') stack[stack.length] = { node: child, path: place };
      }
    }
  };
  // The element children of a node, in order (a closed shadow root or one of its elements).
  const elementChildren = (node) => {
    const children = read(childNodes, node),
      elements = [];
    for (let i = 0; i < children.length; i++)
      if (read(nodeType, children[i]) === 1) elements[elements.length] = children[i]; // NOSONAR: array-like or mutated collection, index loop kept
    return elements;
  };
  const isArray = Array.isArray;
  const writer = freeze({
    publish(proof) {
      if (
        !proof ||
        (proof.channel !== 'mirage-render' && proof.channel !== 'lense-applied-response') ||
        !isArray(proof.bindings) ||
        !isArray(proof.sourceRefs)
      )
        return false;
      if (read(getMapSize, proofs) >= 16) {
        let removed = false;
        proofs.forEach((_value, key) => {
          if (!removed) {
            proofs.delete(key);
            removed = true;
          }
        });
      }
      proofs.set(proof.proofId, clone(proof));
      apply(dispatch, document, [new NativeCustomEvent('paqvilo-provenance-ready', { detail: { slot } })]);
      return true;
    },
    retire(proofId) {
      return proofs.delete(proofId);
    },
    // A closed shadow root of this document that the backend reached through the DevTools protocol (Inspect, lense/
    // dom-pierce.mjs). Its host must be the element its proof names; each of its elements is named by the binding of
    // its place under that host (the element index path the response wrote), and only while its tag and identity
    // attributes are what the binding says (proofBindingIsValid, at query time).
    admitSealed(root) {
      if (disposed || !root || read(nodeType, root) !== 11 || read(ownerDocument, root) !== document) return false;
      const host = read(shadowHostOf, root),
        hostId = host ? nodeIds.get(host) : undefined;
      if (!hostId || originals.get(hostId) !== host) return false;
      admitPlaces(root, sealedPlaces(hostId));
      return true;
    },
    query,
    exclude(node) {
      revoked.add(node);
    },
    dispose() {
      disposed = true;
      disconnect();
      if (descriptorOf(templatePrototype, 'content')?.get === contentGetter)
        define(templatePrototype, 'content', templateDescriptor);
      for (let i = 0; i < copyRestorers.length; i++) copyRestorers[i](); // NOSONAR: array-like or mutated collection, index loop kept
      proofs.clear();
      originals.clear();
      contested.clear();
      responseIds.clear();
    },
  });
  const capability = freeze({
    query,
    // Every claim with the secret returns the same writer: a DevTools session that Chromium re-attaches to this
    // unchanged document loses its earlier object handles and must claim the writer again.
    claim(value) {
      return value === secret && !disposed ? writer : null;
    },
    // The backend retires a registry by its context when the writer never reached it: a claim still in flight, a claim
    // that was never admitted, a context beyond its record limit. The key only closes this registry; it admits nothing.
    release(value) {
      if (!releaseKey || value !== releaseKey) return false;
      writer.dispose();
      return true;
    },
  });
  define(window, slot, { value: capability, configurable: false, writable: false }); // NOSONAR: preserve the page window receiver and binding
}
