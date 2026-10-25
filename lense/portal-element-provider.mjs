/** Serializable early bootstrap. Only a backend-held writer can admit response descriptors. */
export function installPortalProvenanceRegistry({ secret, slot, domProvenanceSlot, limit = 50000 }) {
  if (!secret || !slot || Object.hasOwn(window, slot)) return;
  const marker = 'data-paqvilo-source';
  const apply = Reflect.apply,
    clone = structuredClone,
    freeze = Object.freeze,
    define = Object.defineProperty;
  const lock = (object, prototype, names) => {
    for (let i = 0; i < names.length; i++) define(object, names[i], { value: prototype[names[i]].bind(object) });
    return object;
  };
  const getter = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
  const nodeType = getter(Node.prototype, 'nodeType'),
    childNodes = getter(Node.prototype, 'childNodes');
  const ownerDocument = getter(Node.prototype, 'ownerDocument'),
    connected = getter(Node.prototype, 'isConnected');
  const localName = getter(Element.prototype, 'localName');
  const templatePrototype = HTMLTemplateElement.prototype;
  const templateDescriptor = Object.getOwnPropertyDescriptor(templatePrototype, 'content');
  const templateContent = templateDescriptor.get;
  const descriptorOf = Object.getOwnPropertyDescriptor;
  const scriptObserved = domProvenanceSlot ? window[domProvenanceSlot]?.isScriptObserved : null;
  const read = (get, node) => apply(get, node, []);
  const getAttribute = Element.prototype.getAttribute;
  const attribute = (node, name) => apply(getAttribute, node, [name]);
  const originals = lock(new Map(), Map.prototype, ['get', 'set', 'clear']);
  const duplicates = lock(new Set(), Set.prototype, ['add', 'has', 'clear']);
  const nodeIds = lock(new WeakMap(), WeakMap.prototype, ['get', 'set', 'has']);
  const inertOwners = lock(new WeakMap(), WeakMap.prototype, ['get', 'set']);
  const revoked = lock(new WeakSet(), WeakSet.prototype, ['add', 'has']);
  const changedAttributes = lock(new WeakMap(), WeakMap.prototype, ['get', 'set']);
  const proofs = lock(new Map(), Map.prototype, ['get', 'set', 'delete', 'clear', 'forEach']);
  const relevantAttribute =
    /^(?:id|name|type|data-(?:entityname|formid|viewid|listid|control-id|control-name|pcf-schema|pcf-control|pcf-name))$/;
  const testAttribute = RegExp.prototype.test.bind(relevantAttribute);
  const getMapSize = getter(Map.prototype, 'size');
  const NativeCustomEvent = CustomEvent,
    dispatch = EventTarget.prototype.dispatchEvent;
  const NativeWeakSet = WeakSet,
    seenHas = WeakSet.prototype.has,
    seenAdd = WeakSet.prototype.add;
  const recordGetters = {};
  for (const name of ['type', 'target', 'attributeName', 'oldValue', 'addedNodes'])
    recordGetters[name] = getter(MutationRecord.prototype, name);
  const recordValue = (record, name) => read(recordGetters[name], record);
  let claimed = false,
    truncated = false;
  const markerOf = (node) => (node && read(nodeType, node) === 1 ? attribute(node, marker) : null);
  const remember = (node, id, inertOwner = null) => {
    if (!id || id.length > 256 || read(nodeType, node) !== 1) return;
    if (!nodeIds.has(node) && scriptObserved && scriptObserved(node) !== false) return;
    if (nodeIds.has(node) && nodeIds.get(node) !== id) revoked.add(node);
    nodeIds.set(node, id);
    const previous = originals.get(id);
    if (previous && previous !== node) {
      duplicates.add(id);
      return;
    }
    if (!previous && read(getMapSize, originals) >= limit) {
      truncated = true;
      return;
    }
    originals.set(id, node);
    if (inertOwner && nodeIds.has(inertOwner) && originals.get(nodeIds.get(inertOwner)) === inertOwner)
      inertOwners.set(node, inertOwner);
  };
  const subtree = (node, visit, seen, budget) => {
    const stack = [{ node, owner: null }];
    let size = 1;
    while (size) {
      const { node: current, owner } = stack[--size];
      if (apply(seenHas, seen, [current])) continue;
      apply(seenAdd, seen, [current]);
      if (++budget.nodes > limit) {
        truncated = true;
        return;
      }
      visit(current, owner);
      const children = read(childNodes, current);
      for (let i = children.length - 1; i >= 0; i--) stack[size++] = { node: children[i], owner };
      if (read(nodeType, current) === 1 && read(localName, current) === 'template')
        stack[size++] = { node: read(templateContent, current), owner: current };
    }
  };
  const observe = (records) => {
    if (records.length > limit) {
      truncated = true;
      return;
    }
    const seen = new NativeWeakSet(),
      budget = { nodes: 0 };
    // A script may remove a parser marker before this microtask; MutationRecord retains the original node.
    const oldMarkers = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (
        recordValue(record, 'type') === 'attributes' &&
        recordValue(record, 'attributeName') === marker &&
        recordValue(record, 'oldValue')
      )
        oldMarkers[oldMarkers.length] = { node: recordValue(record, 'target'), id: recordValue(record, 'oldValue') };
    }
    const originalMarker = (node) => {
      for (let i = 0; i < oldMarkers.length; i++) if (oldMarkers[i].node === node) return oldMarkers[i].id;
      return markerOf(node);
    };
    for (let i = 0; i < records.length; i++) {
      const record = records[i],
        type = recordValue(record, 'type');
      if (type === 'childList') {
        const added = recordValue(record, 'addedNodes');
        for (let j = 0; j < added.length; j++)
          subtree(added[j], (child, owner) => remember(child, originalMarker(child), owner), seen, budget);
      } else if (type === 'attributes') {
        const node = recordValue(record, 'target');
        if (recordValue(record, 'attributeName') === marker) {
          const oldValue = recordValue(record, 'oldValue');
          remember(node, oldValue);
          const next = markerOf(node);
          if (next !== oldValue) revoked.add(node);
          if (next) remember(node, next);
        } else if (
          nodeIds.has(node) &&
          testAttribute(recordValue(record, 'attributeName')) &&
          attribute(node, recordValue(record, 'attributeName')) !== recordValue(record, 'oldValue')
        ) {
          let changes = changedAttributes.get(node);
          if (!changes) {
            changes = lock(new Set(), Set.prototype, ['add', 'has']);
            changedAttributes.set(node, changes);
          }
          changes.add(recordValue(record, 'attributeName'));
        }
      }
    }
  };
  const observer = new MutationObserver(observe);
  const takeRecords = observer.takeRecords.bind(observer),
    disconnect = observer.disconnect.bind(observer);
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
  const contentGetter = function () {
    const content = read(templateContent, this);
    observe(takeRecords());
    subtree(this, (node, owner) => remember(node, markerOf(node), owner), new NativeWeakSet(), { nodes: 0 });
    return content;
  };
  define(templatePrototype, 'content', { ...templateDescriptor, get: contentGetter });
  const query = (node, { scope, anchorGeneration } = {}) => {
    observe(takeRecords());
    const result = {
      version: 1,
      mode: 'live',
      scope,
      anchorGeneration,
      node: {
        id: null,
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
    const id = nodeIds.get(node);
    result.node.id = id ?? null;
    if (!id || revoked.has(node) || duplicates.has(id) || originals.get(id) !== node) {
      result.availability[0] = { reason: id ? 'node-identity-revoked' : 'node-not-proved' };
      return result;
    }
    let admitted = false;
    proofs.forEach((proof) => {
      if (admitted) return;
      let binding = null;
      for (let i = 0; i < proof.bindings.length; i++) if (proof.bindings[i].id === id) binding = proof.bindings[i];
      if (!binding) return;
      if (binding.inertTemplateId) {
        const owner = inertOwners.get(node);
        if (
          !owner ||
          nodeIds.get(owner) !== binding.inertTemplateId ||
          originals.get(binding.inertTemplateId) !== owner
        )
          return;
      }
      if (read(localName, node) !== binding.tag) return;
      const attributes = binding.attributes ?? [];
      const changes = changedAttributes.get(node);
      if (changes) {
        if (binding.mapping !== 'platform') return;
        for (let i = 0; i < attributes.length; i++) if (changes.has(attributes[i].name)) return;
      }
      for (let i = 0; i < attributes.length; i++)
        if (attribute(node, attributes[i].name) !== attributes[i].value) return;
      const local = proof.channel === 'mirage-render';
      if (proof.complete === false) result.limits.truncated = true;
      result.mode = local ? 'local' : 'live';
      result.sourceRefs = [];
      const ids = clone(binding.sourceRefIds ?? [binding.sourceRefId]);
      const contexts = binding.contexts ?? [];
      for (let i = 0; i < proof.sourceRefs.length; i++) {
        let relevant = false;
        for (let j = 0; j < ids.length; j++) if (proof.sourceRefs[i].id === ids[j]) relevant = true;
        for (let j = 0; j < contexts.length; j++)
          if (proof.sourceRefs[i].id === contexts[j].sourceRefId) relevant = true;
        if (relevant) result.sourceRefs[result.sourceRefs.length] = clone(proof.sourceRefs[i]);
      }
      result.facts[0] = {
        id: proof.proofId + ':' + id,
        scope,
        dimension: binding.mapping === 'platform' ? 'owner' : 'source',
        kind:
          binding.mapping === 'platform'
            ? 'render-platform'
            : binding.mapping === 'conflicting'
              ? 'binding-conflict'
              : binding.mapping === 'derived'
                ? 'render-derived'
                : local
                  ? 'render-literal'
                  : 'lense-applied-literal',
        subject: id,
        predicate:
          binding.mapping === 'platform' ? 'identity' : binding.mapping === 'derived' ? 'implementation' : 'created-by',
        ...(binding.mapping === 'platform' ? { binding: clone(binding.component) } : {}),
        sourceRefIds: ids,
        region: binding.region,
        renderSourceRevision: proof.sourceRevision,
      };
      for (let i = 0; i < contexts.length; i++)
        result.facts[result.facts.length] = {
          id: proof.proofId + ':context:' + i + ':' + id,
          scope,
          dimension: 'context',
          kind: 'render-invocation',
          subject: id,
          predicate: 'declares',
          sourceRefIds: [contexts[i].sourceRefId],
          region: contexts[i].region,
          renderSourceRevision: proof.sourceRevision,
        };
      admitted = true;
    });
    if (admitted) return clone(result);
    result.availability[0] = { reason: 'response-proof-not-published' };
    return result;
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
    query,
    exclude(node) {
      revoked.add(node);
    },
    dispose() {
      disconnect();
      if (descriptorOf(templatePrototype, 'content')?.get === contentGetter)
        define(templatePrototype, 'content', templateDescriptor);
      proofs.clear();
      originals.clear();
      duplicates.clear();
    },
  });
  const capability = freeze({
    query,
    claim(value) {
      if (claimed || value !== secret) return null;
      claimed = true;
      return writer;
    },
  });
  define(window, slot, { value: capability, configurable: false, writable: false });
}
