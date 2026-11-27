// Read-only DOM snapshot through the DevTools protocol: closed shadow roots and cross-origin frames included.
//
// Page code cannot enter a closed shadow root or a cross-origin frame, but the browser's DevTools protocol can:
// DOM.getDocument with pierce: true returns every shadow root (open and closed) and the documents of frames that run in
// the page's process, and an out-of-process (cross-site) frame is its own target, reached through the session Playwright
// attached to it (Target.setAutoAttach). Only reading commands are sent (DOM.getDocument, DOM.querySelectorAll,
// DOM.getBoxModel, CSS.getComputedStyleForNode, Page.getFrameTree); the sessions are detached afterwards.

/** Attributes a snapshot reports; field values are never among them. */
export const SNAPSHOT_ATTRIBUTES = Object.freeze([
  'id',
  'class',
  'style',
  'role',
  'aria-label',
  'aria-hidden',
  'title',
  'type',
  'name',
  'href',
  'src',
  'disabled',
  'checked',
]);
/** Elements whose text a snapshot never reads, and the toolkit's own panels, which it never reports. */
export const SNAPSHOT_TEXT_BLOCKED = Object.freeze([
  'script',
  'style',
  'template',
  'noscript',
  'input',
  'textarea',
  'select',
  'option',
]);
export const SNAPSHOT_PANEL_IDS = Object.freeze(['paqvilo-panel', 'paqvilo-xray', 'paqvilo-model-inspector']);

const FRAME_OWNERS = new Set(['iframe', 'frame', 'object', 'embed', 'portal', 'fencedframe']);
const ELEMENT = 1;
// Playwright's refusal of a session for a frame that runs in its parent's process.
const IN_PROCESS_FRAME = /separate CDP session/;
const TEXT = 3;
const MAX_TEXT_NODES = 300;

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const attributesOf = (node) => {
  const map = new Map();
  const list = node.attributes ?? [];
  for (let index = 0; index + 1 < list.length; index += 2) map.set(list[index], list[index + 1]);
  return map;
};
const editable = (attributes) => attributes.has('contenteditable') && attributes.get('contenteditable') !== 'false';
const textBlocked = (node, attributes) =>
  SNAPSHOT_TEXT_BLOCKED.includes(node.localName) ||
  editable(attributes) ||
  SNAPSHOT_PANEL_IDS.includes(attributes.get('id'));

// The node's light-DOM text, as the page snapshot's tree walker reads it: shadow roots and frames are their own scopes.
function textOf(node, textLimit) {
  if (textBlocked(node, attributesOf(node))) return '';
  let text = '';
  let inspected = 0;
  const visit = (current) => {
    for (const child of current.children ?? []) {
      if (text.length >= textLimit || inspected >= MAX_TEXT_NODES) return;
      if (child.nodeType === TEXT) {
        inspected++;
        text += child.nodeValue.slice(0, textLimit - text.length) + ' ';
      } else if (child.nodeType === ELEMENT && !textBlocked(child, attributesOf(child))) visit(child);
    }
  };
  visit(node);
  return text.replace(/\s+/g, ' ').trim().slice(0, textLimit);
}

const NO_RECT = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });
// The border box in CSS pixels of the top viewport. The protocol reports a box in the viewport of its session's root
// frame: the top one for the page and its in-process frames, the frame's own for an out-of-process frame, so that
// frame's boxes are moved by `offset`, its owner's content box in the top viewport (null: the owner has no box).
function rectOf(model, offset) {
  const quad = model?.border;
  if (!Array.isArray(quad) || quad.length < 8 || !offset) return NO_RECT;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: x + offset.x, y: y + offset.y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
const TOP_OFFSET = () => Promise.resolve({ x: 0, y: 0 });
// The offset of an out-of-process frame's viewport: its owner's content box, read once, moved by the owner's offset.
function frameOffset(owner, scope) {
  let offset;
  return () =>
    (offset ??= (async () => {
      const base = await scope.offset();
      if (!base) return null;
      try {
        const { model } = await scope.session.send('DOM.getBoxModel', { nodeId: owner.nodeId });
        return { x: base.x + model.content[0], y: base.y + model.content[1] };
      } catch {
        return null;
      }
    })());
}

// A protocol error for a selector the DOM agent cannot parse ("DOM Error while querying").
const selectorError = (error) => /querying|selector/i.test(String(error?.message ?? ''));

async function openTree(session) {
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  return root;
}

// The documents of out-of-process frames, by frame id: each has its own session, and an in-process frame refuses one
// (its document is already in its parent's tree). A frame that goes away while it is read (removed, navigated) is
// skipped and counted in `detached`; it never fails the snapshot.
async function remoteDocuments(context, page, sessions) {
  const remote = new Map();
  let detached = 0;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const session = await context.newCDPSession(frame);
      sessions.push(session);
      const { frameTree } = await session.send('Page.getFrameTree');
      remote.set(frameTree.frame.id, { session, root: await openTree(session) });
    } catch (error) {
      if (!IN_PROCESS_FRAME.test(String(error?.message ?? ''))) detached++;
    }
  }
  return { remote, detached };
}

// Walks the pierced trees in document order. `order` lists the elements with their scope, the element that encloses
// each (`parent`, across shadow hosts and frame owners) and its depth; `scopes` the documents and shadow roots, with the
// session that owns their node ids. `blocked`: the node stands inside an element whose text is never read (a field, an
// editable region); this holds across shadow roots and frames too. A scope is `sealed` when page code cannot reach it:
// inside a closed shadow root or a cross-origin frame, at any depth.
function collectTree({ root, session, remote, detached, origin, maxNodes }) {
  const boundaries = {
    openShadowRoots: 0,
    closedShadowRoots: 0,
    frames: 0,
    crossOriginFrames: 0,
    outOfProcessFrames: 0,
    unreadFrames: 0,
    detachedFrames: detached,
  };
  const scopes = [];
  const order = [];
  let walked = 0;
  let truncated = false;
  const walk = (node, scope, blocked, parent) => {
    if (walked++ >= maxNodes) {
      truncated = true;
      return;
    }
    if (node.nodeType !== ELEMENT) return;
    const attributes = attributesOf(node);
    if (SNAPSHOT_PANEL_IDS.includes(attributes.get('id'))) return;
    const entry = { node, scope, blocked, parent, depth: parent ? parent.depth + 1 : 0 };
    order.push(entry);
    const inner = blocked || textBlocked(node, attributes);
    for (const shadow of node.shadowRoots ?? []) enterShadow(shadow, scope, inner, entry);
    // The protocol also names the frame of a frame's root <html> element: only frame owners hold a frame.
    if (FRAME_OWNERS.has(node.localName)) frameOwner(node, scope, inner, entry);
    for (const child of node.children ?? []) walk(child, scope, inner, entry);
  };
  const enterScope = (container, scope, blocked, parent) => {
    scopes.push({ nodeId: container.nodeId, scope });
    for (const child of container.children ?? []) walk(child, scope, blocked, parent);
  };
  const enterShadow = (shadow, scope, blocked, host) => {
    // A user-agent shadow root is the browser's own (an input's editor holds the field value): never read.
    if (shadow.shadowRootType !== 'open' && shadow.shadowRootType !== 'closed') return;
    boundaries[shadow.shadowRootType === 'open' ? 'openShadowRoots' : 'closedShadowRoots']++;
    const sealed = scope.sealed || shadow.shadowRootType === 'closed';
    // The closed roots on the way to a scope, outermost first (backend node ids): Inspect hands them to the page's
    // registry to read their source marks (sealedSource).
    const closedRoots =
      shadow.shadowRootType === 'closed' ? [...(scope.closedRoots ?? []), shadow.backendNodeId] : scope.closedRoots;
    enterScope(shadow, { ...scope, shadowRoot: shadow.shadowRootType, sealed, closedRoots }, blocked, host);
  };
  // A frame in the page's process is read through the pierced document of its owner; an out-of-process frame through
  // its own session. Which one depends on the browser's process model, not on the origin.
  // `reader`: the session that owns the document's node ids and the offset of its viewport.
  const enterDocument = (document, owner, blocked, reader, entry, frameId) => {
    const url = document.documentURL ?? '';
    const frameOrigin = originOf(url);
    const outOfProcess = reader.session !== owner.session;
    boundaries.frames++;
    if (frameOrigin !== origin) boundaries.crossOriginFrames++;
    if (outOfProcess) boundaries.outOfProcessFrames++;
    const frame = { url, origin: frameOrigin, crossOrigin: frameOrigin !== origin, outOfProcess };
    const base = document.baseURL || url;
    const sealed = owner.sealed || frame.crossOrigin;
    // A frame document has a registry of its own (`registryFrame`): the closed roots on the way restart here. A
    // cross-origin document has no exported source, so its closed roots are never handed to a registry.
    const scope = {
      session: reader.session,
      offset: reader.offset,
      shadowRoot: null,
      base,
      frame,
      sealed,
      closedRoots: frame.crossOrigin ? null : [],
      registryFrame: frameId ?? null,
    };
    enterScope(document, scope, blocked, entry);
  };
  const frameOwner = (node, scope, blocked, entry) => {
    if (node.contentDocument) return enterDocument(node.contentDocument, scope, blocked, scope, entry, node.frameId);
    if (node.frameId === undefined) return;
    const attached = remote.get(node.frameId);
    // Each out-of-process document is entered once, at its owner.
    remote.delete(node.frameId);
    if (attached) {
      const reader = { session: attached.session, offset: frameOffset(node, scope) };
      return enterDocument(attached.root, scope, blocked, reader, entry, node.frameId);
    }
    boundaries.unreadFrames++;
  };
  const base = root.baseURL || root.documentURL;
  const top = { session, offset: TOP_OFFSET, shadowRoot: null, base, frame: null, sealed: false, registryFrame: null };
  enterScope(root, top, false, null);
  return { boundaries, scopes, order, truncated };
}

// Every pierced tree of the page, or null when the top document is not on `origin`. Opened sessions join `sessions`.
async function readTrees({ context, page, origin, maxNodes, sessions }) {
  const session = await context.newCDPSession(page);
  sessions.push(session);
  const root = await openTree(session);
  if (originOf(root.documentURL) !== origin) return null;
  const { remote, detached } = await remoteDocuments(context, page, sessions);
  return { session, root, tree: collectTree({ root, session, remote, detached, origin, maxNodes }) };
}

// The node ids each session's scopes match, or null for a selector the DOM agent cannot parse.
async function matchedNodes(scopes, sessions, selector) {
  const matched = new Map(sessions.map((session) => [session, new Set()]));
  for (const { nodeId, scope } of scopes) {
    try {
      const { nodeIds } = await scope.session.send('DOM.querySelectorAll', { nodeId, selector });
      for (const id of nodeIds) matched.get(scope.session).add(id);
    } catch (error) {
      if (selectorError(error)) return null;
      throw error;
    }
  }
  return matched;
}

/**
 * Snapshot of the elements matching `selector` in the page's document, in every shadow root (open or closed) and in
 * every frame document (same-origin, cross-origin in the page's process, and out-of-process frames). Each element
 * names its scope: `shadowRoot` (`open`, `closed` or null) and `frame` (null for the top document, else its URL,
 * origin and whether that origin differs from the portal's). The top document must be on `origin`.
 * @returns {Promise<object>} `{ denied }`, `{ invalidSelector }` or `{ url, title, total, truncated, elements, boundaries }`
 */
export async function piercedSnapshot({
  context,
  page,
  origin,
  selector,
  limit,
  textLimit,
  styles,
  maxNodes = 50_000,
}) {
  const sessions = [];
  try {
    const read = await readTrees({ context, page, origin, maxNodes, sessions });
    if (!read) return { denied: true };
    const { root, tree } = read;
    const matched = await matchedNodes(tree.scopes, sessions, selector);
    if (!matched) return { invalidSelector: true };
    const elements = [];
    let total = 0;
    for (const { node, scope, blocked } of tree.order) {
      if (!matched.get(scope.session).has(node.nodeId)) continue;
      const index = total++;
      if (elements.length < limit)
        elements.push(await describe(node, scope, index, { textLimit: blocked ? 0 : textLimit, styles }));
    }
    // document.title: the first HTML title element of the document's own tree. In an HTML document an HTML element's
    // nodeName is upper case; an SVG <title> keeps its lower-case name.
    const title = tree.order.find(
      ({ node, scope }) => scope.frame === null && scope.shadowRoot === null && node.nodeName === 'TITLE',
    );
    return {
      url: root.documentURL,
      title: title ? textOf(title.node, 500) : '',
      total,
      truncated: total > limit || tree.truncated,
      elements,
      boundaries: tree.boundaries,
    };
  } finally {
    await Promise.allSettled(sessions.map((session) => session.detach()));
  }
}

async function describe(node, { session, offset, shadowRoot, frame, base }, index, { textLimit, styles }) {
  const own = attributesOf(node);
  const attributes = {};
  for (const name of SNAPSHOT_ATTRIBUTES) {
    if (!own.has(name)) continue;
    let value = own.get(name).slice(0, 500);
    // A frame's links resolve against its own document, not the portal page.
    if ((name === 'href' || name === 'src') && frame) {
      try {
        value = new URL(value, base).href;
      } catch {
        /* An unresolvable link stays as written; the API reports it as an invalid URL. */
      }
    }
    attributes[name] = value;
  }
  let rect = NO_RECT;
  try {
    rect = rectOf((await session.send('DOM.getBoxModel', { nodeId: node.nodeId })).model, await offset());
  } catch {
    /* An element without a layout box (display: none, detached) has no rectangle. */
  }
  const computed = new Map();
  try {
    const { computedStyle } = await session.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId });
    for (const { name, value } of computedStyle) computed.set(name, value);
  } catch {
    /* An element the style engine has no style for reports empty values. */
  }
  const style = (name) => (computed.get(name) ?? '').slice(0, 500);
  return {
    index,
    tag: node.localName,
    attributes,
    text: textOf(node, textLimit),
    visible: rect.width > 0 && rect.height > 0 && style('visibility') !== 'hidden' && style('display') !== 'none',
    rect,
    style: Object.fromEntries(styles.map((name) => [name, style(name)])),
    scope: {
      shadowRoot,
      frame: frame
        ? { url: frame.url, origin: frame.origin, crossOrigin: frame.crossOrigin, outOfProcess: frame.outOfProcess }
        : null,
    },
  };
}

const SELECTED_NODE = 'globalThis.__paqviloXrayUi?.selectedNode?.() ?? null';
// The element X-ray has selected, with its pierced subtree (in-process frame documents included), or null.
async function selectedSubtree(session) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: SELECTED_NODE,
    objectGroup: 'paqvilo-pierce',
    // A page script that never returns cannot hold the read.
    timeout: 5000,
  });
  if (!result?.objectId) return null;
  try {
    const { node } = await session.send('DOM.describeNode', { objectId: result.objectId, depth: -1, pierce: true });
    return node;
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup: 'paqvilo-pierce' });
  }
}
// Whether page code cannot reach part of the subtree: a closed shadow root, a cross-origin frame document, or a frame
// whose document is not in the subtree (out of process).
function sealedBelow(node, origin) {
  const pending = [node];
  for (let seen = 0; pending.length && seen < 100_000; seen++) {
    const current = pending.pop();
    if (sealedAt(current, origin)) return true;
    pending.push(
      ...(current.children ?? []),
      ...(current.shadowRoots ?? []).filter((shadow) => shadow.shadowRootType === 'open'),
      ...(current.contentDocument ? [current.contentDocument] : []),
    );
  }
  return false;
}
// The node itself holds what page code cannot enter: a closed shadow root, or a frame it cannot read.
function sealedAt(node, origin) {
  if ((node.shadowRoots ?? []).some((shadow) => shadow.shadowRootType === 'closed')) return true;
  if (!FRAME_OWNERS.has(node.localName)) return false;
  if (node.contentDocument) return originOf(node.contentDocument.documentURL) !== origin;
  return node.frameId !== undefined;
}
const isWithin = (entry, ancestor) => {
  for (let current = entry; current; current = current.parent) if (current === ancestor) return true;
  return false;
};
// Whether the entry's border box holds the point and it is rendered visible there.
async function rendersAt(entry, x, y) {
  let rect;
  try {
    const { model } = await entry.scope.session.send('DOM.getBoxModel', { nodeId: entry.node.nodeId });
    rect = rectOf(model, await entry.scope.offset());
  } catch {
    return false;
  }
  const inside = x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
  return inside && !(await hiddenStyle(entry));
}
// The elements from the selection (excluded) to the entry; each with its tag, id and classes (bounded).
function pathBetween(selected, entry) {
  const path = [];
  for (let current = entry; current && current !== selected; current = current.parent) path.unshift(current);
  return path.map(({ node }) => {
    const own = attributesOf(node);
    return {
      tag: node.localName,
      id: own.get('id')?.slice(0, 200) ?? null,
      class: own.get('class')?.slice(0, 200) ?? null,
    };
  });
}
const hiddenStyle = async (entry) => {
  try {
    const { computedStyle } = await entry.scope.session.send('CSS.getComputedStyleForNode', {
      nodeId: entry.node.nodeId,
    });
    const value = (name) => computedStyle.find((item) => item.name === name)?.value;
    return value('visibility') === 'hidden' || value('display') === 'none';
  } catch {
    return true;
  }
};

/**
 * The element at viewport point (x, y) that page code cannot reach, below the element X-ray has selected (Inspect): the
 * deepest rendered element inside a closed shadow root or a cross-origin frame, at any depth, whose border box holds the
 * point. Read-only, through the same pierced read as piercedSnapshot, with its blocked-text rules. The selection is read
 * from the page's X-ray tools; the point is in CSS pixels of the top viewport.
 * @returns {Promise<object>} `{ denied }`, or `{ element, path, sealedBy, selected }` with element null when no
 *   such element is at the point
 */
export async function piercedElementAt({
  context,
  page,
  origin,
  x,
  y,
  textLimit = 500,
  styles = [],
  maxNodes = 50_000,
  maxCandidates = 2000,
  sealedSource = null,
}) {
  const sessions = [];
  try {
    if (originOf(page.url()) !== origin) return { denied: true };
    const probe = await context.newCDPSession(page);
    sessions.push(probe);
    const selection = await selectedSubtree(probe);
    if (!selection) return { element: null, selected: false };
    // Nothing below the selection is sealed: page code reads all of it, and Inspect already did.
    if (!sealedBelow(selection, origin)) return { element: null, selected: true };
    const read = await readTrees({ context, page, origin, maxNodes, sessions });
    if (!read) return { denied: true };
    const { session, tree } = read;
    const selected = tree.order.find(
      (entry) => entry.scope.session === session && entry.node.backendNodeId === selection.backendNodeId,
    );
    if (!selected) return { element: null, selected: false };
    // The sealed elements below the selection, deepest first, then the later one (it paints over an earlier sibling).
    const candidates = tree.order
      .filter((entry) => entry.scope.sealed && isWithin(entry, selected))
      .slice(0, maxCandidates)
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => right.entry.depth - left.entry.depth || right.index - left.index);
    for (const { entry } of candidates) {
      if (!(await rendersAt(entry, x, y))) continue;
      const element = await describe(entry.node, entry.scope, 0, { textLimit: entry.blocked ? 0 : textLimit, styles });
      const found = { selected: true, element, path: pathBetween(selected, entry), sealedBy: sealedBy(entry) };
      // Content of closed shadow roots of a portal document (the page's, or a same-origin portal frame's, in the page's
      // process or out of it, each with its own registry) may be written by the exported source (a declarative shadow
      // root): `sealedSource` maps it as that document maps its other elements, or answers null. A cross-origin
      // document has no closed roots to hand over (closedRoots is null there).
      if (sealedSource && entry.scope.closedRoots?.length)
        // A mapping that cannot be read leaves the element reported without one.
        found.source = await Promise.resolve(
          sealedSource({
            cdp: entry.scope.session,
            backendNodeId: entry.node.backendNodeId,
            roots: entry.scope.closedRoots,
            frameId: entry.scope.registryFrame,
          }),
        ).catch(() => null);
      return found;
    }
    return { element: null, selected: true };
  } finally {
    await Promise.allSettled(sessions.map((session) => session.detach()));
  }
}

// The innermost boundary page code cannot cross on the way to the entry: a closed shadow root or a cross-origin frame.
function sealedBy(entry) {
  for (let current = entry; current?.parent; current = current.parent) {
    const outer = current.parent.scope;
    if (current.scope === outer) continue;
    if (current.scope.frame !== outer.frame) {
      if (current.scope.frame?.crossOrigin) return 'cross-origin-frame';
    } else if (current.scope.shadowRoot === 'closed') return 'closed-shadow-root';
  }
  return null;
}
