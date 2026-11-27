import { inspectionEvidenceRuntime, resolveInspectionEvidence } from './inspection-evidence.mjs';
import { renderInspectionEvidence } from './inspection-evidence-ui.mjs';
import { lenseUiKit } from './ui-kit.mjs';
import { observePortalNode } from './portal-node-observation.mjs';
import { definitionQuery } from './definition-query.mjs';

// All embedded source is owned code; page data is passed as a separate argument.
/* NOSONAR: intentional local script execution or generated handler */ export const xrayUi = new Function(
  'data',
  `const {resolveInspectionEvidence}=(${inspectionEvidenceRuntime.toString()})(); const renderInspectionEvidence=(${renderInspectionEvidence.toString()}); const lenseUiKit=(${lenseUiKit.toString()}); const observePortalNode=(${observePortalNode.toString()}); const definitionQuery=(${definitionQuery.toString()}); return (${xrayBrowserImpl.toString()})(data);`,
);

// Self-contained browser function, like panelUi. Never reads page text or input values.
function xrayBrowserImpl(data) {
  // A <form>'s named controls shadow its own members (an <input name="matches"> makes form.matches that input), and a
  // document's named elements shadow the document's. Power Pages wraps the whole page in <form id="content_form">, so
  // every member of a page node is read through its prototype's own getter or method, never off the instance.
  const get = (object, name) => {
    try {
      const prototype = object == null ? null : Object.getPrototypeOf(object);
      return prototype ? Reflect.get(prototype, name, object) : undefined;
    } catch {
      return undefined;
    }
  };
  const call = (object, name, ...args) => {
    const method = get(object, name);
    return typeof method === 'function' ? Reflect.apply(method, object, args) : undefined;
  };
  if (
    location.origin !== data.origin ||
    globalThis.__paqviloRetiredSessions?.includes(data.token) ||
    !get(document, 'body')
  )
    return;
  let host = call(document, 'getElementById', 'paqvilo-xray');
  // The panel owns the current UI state; server-persisted visibility may lag a shortcut.
  if (host?.__px) {
    host.__px.update({ ...data, ui: undefined });
    return;
  }
  // An X-ray whose host the page removed or replaced while inspection was off is not reachable through the document.
  // Dispose it before another one is created, so its attachShadow hook is restored first and never ends up under this one's.
  globalThis.__paqviloXrayUi?.dispose?.();
  host = call(document, 'createElement', 'div');
  host.id = 'paqvilo-xray';
  host.setAttribute('popover', 'manual');
  host.style.cssText =
    'all:initial!important;direction:ltr!important;unicode-bidi:isolate!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;pointer-events:none!important;overflow:visible!important;z-index:2147483647!important;';
  get(document, 'body').append(host);
  const owningBody = get(document, 'body');
  // The panel's look: its tokens, icons and controls (lense/ui-kit.mjs).
  const kit = lenseUiKit();
  const root = host.attachShadow({ mode: 'open' }),
    sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{color-scheme:normal}*{box-sizing:border-box}.ui{${kit.tokens}--tone-source:#29805b;--tone-generated:#8a5cb8;--tone-component:#3975ad;--tone-portal:#7a7f87;--tone-runtime:#a87a22;--tone-none:#c4473a;--tone-field:#29805b;--tone-content:#947330;font:13px/1.45 var(--font);color:var(--fg);text-align:left;letter-spacing:0}
    .ui:focus{outline:none}.shield{position:fixed;inset:0;pointer-events:auto;cursor:crosshair}.ui.interact .shield{display:none}.ui.interact .marks{opacity:.35}.ui.passthrough .shield{pointer-events:none}.bar,.card,.tip,.legend{background:var(--bg);border:1px solid var(--panel-line);border-radius:var(--radius);box-shadow:var(--shadow)}.bar,.card{pointer-events:auto}.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;padding:6px 8px;max-width:calc(100vw - 16px);white-space:nowrap}.brand{display:flex;align-items:center;gap:8px;padding-right:7px}.brand strong{color:var(--link);font-size:14px}.brand span{color:var(--muted)}.hint,.muted{color:var(--muted)}.hint{font-size:11px}.bar select{max-width:142px}
    .card{position:fixed;right:12px;top:64px;width:410px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 80px);display:flex;flex-direction:column;overflow:hidden}.card[hidden],.tip[hidden]{display:none}.cardhead{display:flex;gap:6px;align-items:center;padding:9px 10px 9px 12px;border-bottom:1px solid var(--line);background:var(--head-bg);cursor:move;touch-action:none}.grow{flex:1;min-width:0}.eyebrow{font-size:11px;color:var(--muted)}.title{font-size:14px;font-weight:600;overflow-wrap:anywhere}.content{overflow:auto;overscroll-behavior:contain;min-height:0;padding:0 12px 12px;scrollbar-width:thin}.section{margin-top:12px}.section h3{font-size:12px;font-weight:600;margin:0 0 6px}.section h3 small{font-size:11px;font-weight:400;color:var(--muted)}.binding{padding:7px 9px;background:color-mix(in srgb,var(--primary) 6%,var(--bg));border-left:3px solid var(--primary)}.binding strong{font-weight:600;display:block;overflow-wrap:anywhere}.binding .muted{font-size:11.5px;margin-top:3px}.details{display:grid;grid-template-columns:66px 1fr;gap:4px 8px;margin:7px 0;font-size:12px}.details dt{color:var(--muted)}.details dd{margin:0;overflow-wrap:anywhere}.mono{font:11.5px/1.5 Consolas,monospace;overflow-wrap:anywhere;color:var(--muted)}.titlerow{display:flex;align-items:center;gap:6px;min-width:0}.note{font-size:11.5px;color:var(--muted);margin:4px 0 0;line-height:1.5}.foot{display:flex;align-items:center;gap:4px;padding:5px 8px;border-top:1px solid var(--line);background:var(--head-bg)}.foot .hint{margin-left:auto}.status{padding:0 12px 7px;font-size:11.5px;color:var(--muted)}.status:empty{display:none}.actions{display:flex;align-items:center;gap:6px;margin-top:6px}
    details{margin-top:8px}summary{cursor:pointer}.crumb[data-depth='1']{padding-left:15px}.crumb[data-depth='2']{padding-left:23px}.crumb[data-depth='3']{padding-left:31px}.crumb[data-depth='4']{padding-left:39px}.crumb[data-depth='5']{padding-left:47px}.crumb[data-depth='6']{padding-left:55px}.crumb{display:block;width:100%;font:11px Consolas,monospace;margin-top:3px;padding:2px 4px;border-radius:var(--radius);overflow-wrap:anywhere}.crumb:hover{background:var(--tint);color:var(--link)}.welcome{padding:12px}.welcome .hero{font-size:14px;font-weight:600;margin:0 0 6px}.welcome p{margin:5px 0}.welcome .counts{padding-top:8px;border-top:1px solid var(--line);margin-top:10px}.marks{position:fixed;inset:0;pointer-events:none}.mark{position:fixed;border:1px solid var(--tone,var(--primary));background:transparent;pointer-events:none}.selected{border:2px solid var(--primary);background:color-mix(in srgb,var(--primary) 6%,transparent)}.hover{border:2px dashed var(--primary);background:color-mix(in srgb,var(--primary) 3%,transparent)}.tip{position:fixed;pointer-events:none;max-width:370px;padding:5px 8px;font-size:12px;overflow-wrap:anywhere}.tip b{display:block;font-weight:600}.tip .mono{font-size:11px}.legend.covered{visibility:hidden}.legend{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);pointer-events:none;font-size:11px;color:var(--muted);padding:5px 9px;max-width:calc(100vw - 16px)}.legend i{display:inline-block;width:7px;height:7px;margin:0 4px 0 10px}.legend i:first-child{margin-left:0}.legend .tone-source{background:var(--tone-source)}.legend .tone-generated{background:var(--tone-generated)}.legend .tone-component{background:var(--tone-component)}.legend .tone-portal{background:var(--tone-portal)}.legend .tone-runtime{background:var(--tone-runtime)}.legend .tone-none{background:var(--tone-none)}.mark.unidentified{border-style:dashed}
    .scan-wash{position:fixed;inset:0;pointer-events:none;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--primary) 7%,transparent),transparent);height:45vh;bottom:auto;animation:xray-scan 2.8s ease-in-out infinite}.scan-state{position:fixed;left:50%;bottom:55px;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);padding:14px 18px;display:flex;align-items:center;gap:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);pointer-events:auto}.scan-state strong{display:block;font-weight:600}.scan-state p{margin:2px 0 0;color:var(--muted);font-size:12px}.scan-state .btn{margin-left:8px}.scan-orbit{display:inline-block;width:24px;height:24px;flex:none;border:2px solid var(--line);border-top-color:var(--primary);border-radius:50%;animation:xray-orbit .9s linear infinite}.scan-state.error .scan-orbit{animation:none;border-color:var(--muted);border-radius:4px}.scan-state[hidden],.scan-wash[hidden]{display:none}.ui.loading .tip{display:none}.ui.loading .legend{opacity:.7}@keyframes xray-scan{from{transform:translateY(-100%)}to{transform:translateY(100vh)}}@keyframes xray-orbit{to{transform:rotate(360deg)}}
    @media(max-width:850px){.bar{top:8px;gap:3px;padding:5px}.bar .hint:not([data-using=true]),.brand span{display:none}.brand{padding-right:3px}.bar select{max-width:118px}.card{top:auto;bottom:44px;max-height:46dvh;width:380px;right:8px}.scan-state{bottom:55px}.ui:has(.card:not([hidden])) .scan-state{bottom:auto;top:55px}.legend{bottom:8px;font-size:10px}.legend .hint{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important}.scan-wash{transform:translateY(25vh)}}
  `);
  const evidenceSheet = new CSSStyleSheet();
  evidenceSheet.replaceSync(renderInspectionEvidence(null, { part: 'styles' }));
  root.adoptedStyleSheets = [sheet, evidenceSheet];
  // What Esc does, said the same way in the welcome, the legend and the card.
  const escText = 'Esc clears the selection, then turns off X-ray',
    escHint = '<kbd>Esc</kbd>' + escText.slice(3);
  // A model-driven app has no templates: its other outlined content is the page's own.
  const contentLayer = data.modelDriven ? 'Page content' : 'Templates & content';
  // The legend names what the outline colours mean: what the evidence says about each element.
  const dataLayer = data.modelDriven ? 'Forms, views & fields' : 'Forms, lists & fields';
  const legendKeys = [
    ['source', data.modelDriven ? 'Page content' : 'Markup from your sources'],
    ...(data.modelDriven ? [] : [['generated', 'Generated by Liquid']]),
    ['component', dataLayer],
    ...(data.modelDriven ? [] : [['portal', 'Added by the portal']]),
    ['runtime', 'Created at runtime'],
    ['none', 'Not identified'],
  ]
    .map(([tone, text]) => '<i class="tone-' + tone + '"></i>' + text)
    .join(' ');
  // What the page does now, in the toolbar: inspecting, or used normally until Ctrl is tapped again.
  const modeText = (using) =>
    using ? 'Using the page · tap <kbd>Ctrl</kbd> to inspect' : 'Tap <kbd>Ctrl</kbd> to use the page';
  root.innerHTML = `<div class="ui" hidden><div class="shield"></div><div class="marks"></div><div class="bar" role="toolbar" aria-label="Lense X-ray"><div class="brand"><strong>paqvilo</strong><span>X-ray</span></div><button class="f on" data-action="mode" aria-pressed="true">Inspect</button><select aria-label="Highlight layer" title="Which matched elements get an outline"><option value="all">All sources</option><option value="data">${dataLayer}</option><option value="content">${contentLayer}</option><option value="none">Selection only</option></select><button class="f on" data-action="details" aria-pressed="true" title="Show the details card of the selected element. Off: hover summaries only.">Details</button><button class="ib" data-action="refresh" aria-label="Refresh source inspection" title="Re-read your local sources and match this page again">${kit.icon('reload')}</button><span class="hint mode-state" role="status">${modeText(false)}</span><button class="ib" data-action="exit" aria-label="Turn off X-ray" title="Turn off X-ray">${kit.icon('close')}</button></div><aside class="card" aria-label="Lense source details"></aside><div class="tip" hidden></div><div class="legend">${legendKeys} <span class="hint"></span><span class="limit-note" role="status"></span></div></div>`;

  const ui = call(root, 'querySelector', '.ui'),
    marks = call(root, 'querySelector', '.marks'),
    card = call(root, 'querySelector', '.card'),
    tip = call(root, 'querySelector', '.tip');
  const backgroundMarks = call(document, 'createElement', 'div'),
    selectedMark = call(document, 'createElement', 'div'),
    selectedFormMark = call(document, 'createElement', 'div'),
    hoverMark = call(document, 'createElement', 'div');
  selectedMark.className = 'mark selected';
  selectedFormMark.className = 'mark enclosing-form';
  hoverMark.className = 'mark hover';
  marks.append(backgroundMarks);
  const wash = call(document, 'createElement', 'div');
  wash.className = 'scan-wash';
  wash.hidden = true;
  wash.setAttribute('aria-hidden', 'true');
  ui.prepend(wash);
  const scanState = call(document, 'createElement', 'div');
  scanState.className = 'scan-state';
  scanState.hidden = true;
  scanState.setAttribute('role', 'status');
  scanState.setAttribute('aria-live', 'polite');
  ui.append(scanState);
  const lifetime = new AbortController(),
    listen = (target, type, fn, options = {}) =>
      target.addEventListener(type, fn, { ...options, signal: lifetime.signal });
  for (const type of [
    'click',
    'dblclick',
    'auxclick',
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'keydown',
    'keyup',
    'keypress',
  ])
    listen(root, type, (event) => event.stopPropagation());
  const documentIds = new WeakMap(),
    frameIds = new WeakMap(),
    anchorIds = new WeakMap();
  const uiEpoch =
    (Number.isSafeInteger(globalThis.__paqviloInspectionEpoch) ? globalThis.__paqviloInspectionEpoch : 0) + 1;
  globalThis.__paqviloInspectionEpoch = uiEpoch;
  const opaqueId = (map, value, prefix) => {
    if (!map.has(value))
      map.set(
        value,
        prefix +
          '-' +
          [...crypto.getRandomValues(new Uint32Array(4))].map((part) => part.toString(16).padStart(8, '0')).join(''),
      );
    return map.get(value);
  };
  const getSelectionScope = (node) => {
    const doc = get(node, 'ownerDocument') ?? document,
      embedding = frameOf(doc);
    return {
      documentId: opaqueId(documentIds, doc, 'document'),
      frameId: embedding ? opaqueId(frameIds, embedding, 'frame') : 'top',
      uiEpoch,
      sourceRevision: String(
        d.sourceRevision ??
          (d.inspection ?? d.mirage)?.sourceRevision ??
          report?.sourceRevision ??
          (d.inspection ?? d.mirage)?.version ??
          d.catalogVersion ??
          0,
      ),
    };
  };
  const viewListeners = [],
    frameViews = new Map(),
    frameElements = new Map(),
    frameAnimationHooks = new Map(),
    frameShadowHooks = new Map();
  const listenViews = (type, fn, options = {}) => {
    listen(globalThis, type, fn, options);
    viewListeners.push([type, fn, options]);
  };
  const watchFrame = (doc) => {
    if (!frameViews.has(doc)) {
      const controller = new AbortController();
      for (const [type, fn, options] of viewListeners)
        get(doc, 'defaultView').addEventListener(type, fn, { ...options, signal: controller.signal });
      frameViews.set(doc, controller);
      const release = hookShadowView(get(doc, 'defaultView'));
      if (release) frameShadowHooks.set(doc, release);
    }
    if (enabled && !frameAnimationHooks.has(doc)) {
      const release = hookAnimationView(get(doc, 'defaultView'));
      if (release) frameAnimationHooks.set(doc, release);
    }
  };
  // Input guards never wait for a report or the geometry scan: walk documents, open shadow roots and same-origin frames synchronously.
  // The guard observer is separate from the geometry observer, so scan budgets and reconnects never narrow guarding.
  const pruneFrames = () => {
    for (const [doc, controller] of frameViews)
      if (!frameOf(doc)?.isConnected || frameDocument(frameOf(doc)) !== doc) {
        controller.abort();
        frameAnimationHooks.get(doc)?.();
        frameAnimationHooks.delete(doc);
        frameShadowHooks.get(doc)?.();
        frameShadowHooks.delete(doc);
        frameViews.delete(doc);
      }
    if (selected && !liveNode(selected)) detachSelection('frame-document-replaced');
    for (const [embedding, controller] of frameElements)
      if (!embedding.isConnected) {
        controller.abort();
        frameElements.delete(embedding);
      }
  };
  const guardObserver = new MutationObserver((records) => {
    if (records.some((record) => record.removedNodes.length)) pruneFrames();
    for (const record of records)
      for (const node of record.addedNodes) if (get(node, 'nodeType') === 1 && !own(node)) watchFrames(node);
  });
  const watchDocument = (owner) => {
    walkedDocuments.add(owner);
    // A document's load waits for its frames: the frames of a loaded document have committed their first document.
    if (get(owner, 'readyState') === 'complete') settleLoadedFrames(owner);
    else
      get(owner, 'defaultView')?.addEventListener(
        'load',
        () => {
          settleLoadedFrames(owner);
          watchFrames(owner);
        },
        { once: true },
      );
  };
  const watchFrameElement = (node) => {
    const controller = new AbortController();
    // Frame load is not composed across a shadow boundary. Listen on the
    // embedding element in capture phase, independently of geometry scans.
    node.addEventListener(
      'load',
      () => {
        loadedFrames.add(node);
        pruneFrames();
        watchFrames(node);
      },
      { capture: true, signal: controller.signal },
    );
    frameElements.set(node, controller);
  };
  const watchFrames = (surface = document, depth = 0) => {
    if (disposed || depth > 40) return;
    const owner = get(surface, 'nodeType') === 9 ? surface : get(surface, 'ownerDocument');
    if (owner && !walkedDocuments.has(owner)) watchDocument(owner);
    if (get(surface, 'nodeType') !== 1) guardObserver.observe(surface, { subtree: true, childList: true });
    for (const node of [surface, ...(call(surface, 'querySelectorAll', '*') ?? [])]) {
      if (get(node, 'shadowRoot') && !own(node)) {
        shadowRoots.add(get(node, 'shadowRoot'));
        watchFrames(get(node, 'shadowRoot'), depth + 1);
      }
      if (get(node, 'localName') === 'iframe' && !own(node) && !frameElements.has(node)) watchFrameElement(node);
      const inner = get(node, 'localName') === 'iframe' && frameDocument(node);
      if (inner) {
        watchFrame(inner);
        watchFrames(inner, depth + 1);
      }
    }
  };
  // Key events inside any child frame (same-origin, cross-origin, closed shadow root, mid-navigation) never reach the parent.
  // Inspect is modal: unless focus is already in Lense UI, it moves to the overlay, so input lands in this document, where the guards run.
  // Unconditional, because focus inside a closed shadow root's frame is indistinguishable from focus on its host.
  // The move runs as a microtask: it completes before any later input task, and a refocus inside the blur dispatch itself does not stick.
  const containFocus = () =>
    queueMicrotask(() => {
      if (!enabled || disposed || interacting || !call(document, 'hasFocus') || own(get(document, 'activeElement')))
        return;
      ui.focus({ preventScroll: true });
      // ponytail: a cross-origin (out-of-process) frame keeps browser focus past the microtask; reclaim it one task later. Input in that task is a platform boundary.
      setTimeout(() => {
        if (enabled && !disposed && !interacting && root.activeElement === ui) {
          ui.blur();
          ui.focus({ preventScroll: true });
        }
      });
    });
  ui.tabIndex = -1;
  const releaseFrames = () => {
    for (const controller of [...frameViews.values(), ...frameElements.values()]) controller.abort();
    for (const release of frameAnimationHooks.values()) release();
    frameAnimationHooks.clear();
    for (const release of frameShadowHooks.values()) release();
    frameShadowHooks.clear();
    frameViews.clear();
    frameElements.clear();
  };
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const norm = (value) =>
    String(value ?? '')
      .replace(/[{}]/g, '')
      .toLowerCase();
  let geometryCache = null,
    styleCache = null;
  const styleFor = (node) => {
    if (!styleCache) return getComputedStyle(node);
    if (!styleCache.has(node)) styleCache.set(node, getComputedStyle(node));
    return styleCache.get(node);
  };
  let d = data,
    report = null,
    enabled = false,
    interacting = false,
    ctrlTap = false,
    selected = null,
    hover = null,
    overUi = false,
    layer = 'all',
    details = true,
    frame = 0,
    candidates = [],
    needsScan = true,
    detailsDirty = false,
    pointer = { x: 0, y: 0 },
    drag = null,
    disposed = false;
  // cardMoved: the person dragged or docked the card, so it stays where they put it until the next pick.
  let cardMoved = false,
    cardPlacement = '';
  let oneShot = false,
    candidateLimit = false,
    pickGesture = false,
    pendingPick = null,
    pendingPoint = null,
    warmup = false;
  // The read below the selection where page code cannot reach (a closed shadow root, a cross-origin frame): Lense reads
  // it through the DevTools protocol at the point of the pick. { generation, reading, result }.
  let pierced = null;
  let selectionGeneration = 0,
    retainedOneShot = false,
    lastIdentity = null,
    lastScope = null,
    anchorQueued = false;
  let statusMessage = '',
    statusSelection = null,
    feedbackEpoch = 0;
  const retainedObserver = new MutationObserver((records) => {
    if (!selected || disposed || !records.some((record) => !own(record.target) && record.attributeName !== 'style'))
      return;
    if (anchorQueued) return;
    anchorQueued = true;
    queueMicrotask(() => {
      anchorQueued = false;
      if (!selected || disposed) return;
      if (!liveNode(selected)) detachSelection('node-replaced');
      else {
        if (statusMessage && !statusCurrent(statusSelection)) clearStatus();
        if (!enabled) notifySelection(true, 'node-identity-changed');
      }
    });
  });
  const inspectionError = () => {
    const inspection = d.inspection ?? d.mirage;
    return (
      d.inspectionError ||
      (inspection?.active === false ? inspection.error || 'Your local sources could not be read.' : '')
    );
  };
  const renderProgress = () => {
    const error = inspectionError(),
      pending = d.inspectionLoading ?? Boolean((d.inspection ?? d.mirage)?.loading),
      loading = (!report || pending) && !error;
    ui.classList.toggle('loading', loading && !report);
    ui.setAttribute('aria-busy', String(loading));
    wash.hidden = !loading || Boolean(report);
    scanState.hidden = !loading && !error;
    const progressTitle = () => {
      if (report) return 'Updating source inspection';
      if (pending) return 'Reading local sources';
      return 'Preparing X-ray';
    };
    const progressPhase = () =>
      (d.inspection ?? d.mirage)?.phase ?? (report ? '' : 'Matching page elements to your source files.');
    const html = error
      ? `<span class="scan-orbit" aria-hidden="true"></span><div><strong>Source inspection unavailable</strong><p>Details: ${esc(error)}</p></div><button class="btn sec" data-action="refresh">Retry</button>`
      : `<span class="scan-orbit" aria-hidden="true"></span><div><strong>${progressTitle()}</strong><p>${esc(progressPhase())}</p></div>`;
    if (scanState.innerHTML !== html) scanState.innerHTML = html;
    scanState.classList.toggle('error', Boolean(error));
    const refresh = call(root, 'querySelector', '.bar [data-action="refresh"]');
    refresh.disabled = Boolean(pending);
    refresh.setAttribute('aria-busy', String(Boolean(pending)));
  };
  const own = (node) =>
    node === host ||
    call(node, 'closest', '#paqvilo-panel,#paqvilo-handle,#paqvilo-xray') ||
    ['paqvilo-panel', 'paqvilo-handle', 'paqvilo-xray'].includes(get(get(call(node, 'getRootNode'), 'host'), 'id'));
  // The shield covers the page, and with it Lense UI outside X-ray (the dev panel's pill, its handle). The topmost
  // element under the shield decides: when it is Lense UI, the pointer is over Lense, not over the page.
  const lenseUiAt = (x, y) => {
    const below = call(document, 'elementsFromPoint', x, y).find((item) => item !== host);
    return below && own(below) ? below : null;
  };
  // While the pointer is over that UI the shield lets it through, so the pill stays hoverable and clickable.
  const passThrough = (on) => ui.classList.toggle('passthrough', on);
  // The attribute, not the property: on a <form>, `id` names a control called "id" (named access) when it has one.
  const label = (node) => {
    const id = call(node, 'getAttribute', 'id') ?? '';
    return `${get(node, 'localName')}${id ? '#' + id.slice(0, 160) : ''}${!id && get(node, 'classList')?.length ? '.' + [...get(node, 'classList')].slice(0, 2).join('.') : ''}`;
  };
  const descent = new WeakMap();
  const child = (node) => {
    if (get(descent.get(node), 'isConnected') && parent(descent.get(node)) === node) return descent.get(node);
    if (get(node, 'localName') === 'iframe') return get(frameDocument(node), 'body');
    // Every child counts, also one that is not rendered (a script, a stylesheet link, a hidden dialog): the files the
    // page loads and hidden parts are reachable from their parent.
    return [...(get(get(node, 'shadowRoot'), 'children') ?? get(node, 'children') ?? [])].find((item) => !own(item));
  };
  const parameterDescription = (parameter) => {
    if (parameter.kind === 'binding') return 'Column: ' + parameter.column;
    if (parameter.kind === 'dataset') return 'Dataset: ' + (parameter.viewId ?? parameter.entity ?? 'not found');
    if (parameter.kind === 'unresolved') return parameter.reason ?? 'Not resolved';
    // Parameter values stay out of the card; the kind says how the property gets its value.
    if (parameter.kind === 'static') return 'Fixed value';
    return parameter.kind;
  };
  // How a code component is bound to its control, in the panel's words; X-ray's own bindings are already words.
  const bindingLabel = (binding) =>
    ({
      'native-formxml': 'Bound on the form',
      'declared-schema-name': 'Matched by schema name',
      'observed-component-mapping': 'Matched by component setting',
      unknown: 'Not resolved',
    })[binding] ??
    binding ??
    'Not resolved';
  const frameOf = (doc) => {
    try {
      return get(doc, 'defaultView')?.frameElement ?? null;
    } catch {
      return null;
    }
  };
  // Reading a frame's document before the frame's first navigation commits gives the frame's initial empty document a
  // window, and Chromium keeps that window for the frame's first same-origin document, where Lense's provenance
  // bootstrap never runs (lense/portal-provenance-transport.mjs, `reused`). A frame is read once it has loaded, when it
  // navigates nowhere (no src, about:blank), or when it was already in a document that had finished loading when
  // X-ray first walked that document.
  const loadedFrames = new WeakSet(),
    walkedDocuments = new WeakSet();
  const frameSettled = (node) => {
    if (loadedFrames.has(node) || !['iframe', 'frame'].includes(get(node, 'localName'))) return true;
    const src = (call(node, 'getAttribute', 'src') ?? '').trim();
    return !call(node, 'hasAttribute', 'srcdoc') && (!src || /^about:blank$/i.test(src));
  };
  // A frame inserted after its document loaded can still be loading when X-ray first walks that document. The browser
  // records a frame's resource timing entry when the frame's load completes: a frame that navigates to an address and
  // has no entry yet is still loading, and its own load event (watchFrames) settles it. When the timing buffer is
  // full an entry can be missing for a loaded frame; the document's load then stands for its frames, as before.
  const frameLoadRecorded = (doc, frame) => {
    const src = (call(frame, 'getAttribute', 'src') ?? '').trim();
    if (call(frame, 'hasAttribute', 'srcdoc') || !src || /^about:blank$/i.test(src)) return true;
    try {
      const timing = get(doc, 'defaultView').performance;
      const entries = timing.getEntriesByType('resource');
      if (entries.length >= 250) return true;
      const address = new URL(src, get(doc, 'baseURI')).href;
      return entries.some((entry) => entry.initiatorType === 'iframe' && entry.name === address);
    } catch {
      return true;
    }
  };
  const settleLoadedFrames = (doc) => {
    for (const frame of call(doc, 'querySelectorAll', 'iframe,frame'))
      if (frameLoadRecorded(doc, frame)) loadedFrames.add(frame);
  };
  const frameDocument = (node) => {
    if (!frameSettled(node)) return null;
    try {
      const doc = get(node, 'contentDocument');
      return get(doc, 'documentElement') ? doc : null;
    } catch {
      return null;
    }
  };
  const liveNode = (node) => {
    if (!get(node, 'isConnected')) return false;
    let doc = get(node, 'ownerDocument');
    for (let depth = 0; doc !== document && depth < 40; depth++) {
      const frame = frameOf(doc);
      if (!get(frame, 'isConnected') || frameDocument(frame) !== doc) return false;
      doc = get(frame, 'ownerDocument');
    }
    return doc === document;
  };
  const parent = (node) =>
    get(node, 'assignedSlot') ??
    get(node, 'parentElement') ??
    get(call(node, 'getRootNode'), 'host') ??
    frameOf(get(node, 'ownerDocument')) ??
    null;
  const lineage = (node) => {
    const rows = [];
    // Bounded like the observation's ancestors: a clobbered or cyclic parent chain cannot run without end.
    for (let current = node; current && rows.length < 1024; current = parent(current)) rows.push(current);
    return rows;
  };
  const labelledControl = (node) => {
    const labelNode = lineage(node).find((item) => get(item, 'localName') === 'label');
    const labelScope = call(
      labelNode,
      'closest',
      '[data-formid],[data-form-layout],[id^="EntityFormControl"],[id^="WebFormControl"],[data-entityname],[data-entity],[data-paqvilo-table],form',
    );
    return get(labelNode, 'htmlFor')
      ? ([...(call(labelScope ?? get(labelNode, 'parentElement') ?? document, 'querySelectorAll', '[id]') ?? [])].find(
          (item) => get(item, 'id') === get(labelNode, 'htmlFor'),
        ) ?? null)
      : (call(labelNode, 'querySelector', 'input,select,textarea,output') ?? null);
  };
  // Read only declared configuration data. Never invoke grid APIs, renderers,
  // accessors or business-value getters during passive inspection.
  const ownData = (object, key) => {
    try {
      return object && Object.getOwnPropertyDescriptor(object, key)?.value;
    } catch {
      return undefined;
    }
  };
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const gridColumn = (node) => {
    const cell = call(node, 'closest', 'td,th,[data-paqvilo-column]'),
      table = call(cell, 'closest', 'table');
    if (!table) return null;
    // A scroll-head clone can opt into the original grid by ID. Do not guess
    // from a shared wrapper, column name or page-wide requests.
    const boundId = call(table, 'getAttribute', 'data-paqvilo-grid'); // NOSONAR: reads attributes of observed DOM, dataset would differ
    const boundMatches = boundId
      ? [...call(call(table, 'getRootNode'), 'querySelectorAll', '#' + CSS.escape(boundId))]
      : [table];
    const boundTable = boundMatches.length === 1 ? boundMatches[0] : null;
    if (get(boundTable, 'localName') !== 'table') return null;
    const declared = call(cell, 'getAttribute', 'data-paqvilo-column'); // NOSONAR: reads attributes of observed DOM, dataset would differ
    const view = get(get(table, 'ownerDocument'), 'defaultView'),
      jq = ownData(view, 'jQuery'),
      settings =
        ownData(ownData(ownData(jq, 'fn'), 'dataTable'), 'settings') ?? ownData(ownData(view, 'DataTable'), 'settings');
    let config;
    if (Array.isArray(settings))
      for (let index = 0; index < Math.min(settings.length, 200); index++) {
        const item = ownData(settings, index);
        if (ownData(item, 'nTable') === boundTable) {
          config = item;
          break;
        }
      }
    const columns = ownData(config, 'aoColumns');
    const cellIndex = ownData(ownData(cell, '_DT_CellIndex'), 'column');
    const headerIndex = /^\d+$/.test(call(cell, 'getAttribute', 'data-dt-column') ?? '') // NOSONAR: reads attributes of observed DOM, dataset would differ
      ? Number(call(cell, 'getAttribute', 'data-dt-column')) // NOSONAR: reads attributes of observed DOM, dataset would differ
      : null;
    let column;
    if (Array.isArray(columns)) {
      for (let index = 0; index < Math.min(columns.length, 500); index++) {
        const item = ownData(columns, index);
        if (ownData(item, 'nTh') === cell) {
          column = item;
          break;
        }
      }
      column ??= ownData(columns, Number.isInteger(cellIndex) ? cellIndex : headerIndex);
    }
    const name = declared || ownData(column, 'sName') || ownData(column, 'mData');
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(name)) return null;
    return { name: name.toLowerCase(), table: call(boundTable, 'getAttribute', 'data-paqvilo-table') ?? '' }; // NOSONAR: reads attributes of observed DOM, dataset would differ
  };
  /* NOSONAR */ const binding = (node, resolveHost = true) => {
    if (report?.modelDriven) {
      const context = report.modelDriven,
        catalogue = context.catalogue;
      const chain = lineage(node),
        nativeId =
          call(
            chain.find((item) => call(item, 'hasAttribute', 'data-id')),
            'getAttribute',
            'data-id',
          ) ?? ''; // NOSONAR: reads attributes of observed DOM, dataset would differ
      // Native fields carry data-id; a labelled form control without one (such as the
      // loopback app) is identified only by its own name. An empty identifier matches nothing.
      let control = null;
      if (!nativeId) control = labelledControl(node) ?? (call(node, 'matches', 'input,select,textarea') ? node : null);
      const fieldName = nativeId ? nativeId.split('.')[0] : (call(control, 'getAttribute', 'name') ?? '');
      // Parent app context does not establish ownership inside an embedded document.
      const sameDocument = get(node, 'ownerDocument') === document;
      const exact = sameDocument ? (report.forms ?? []).filter((form) => norm(form.id) === norm(context.formId)) : [];
      let forms = [];
      if (sameDocument) forms = exact.length ? exact : (report.forms ?? []);
      // A subgrid carries data-id="dataSetRoot_<control>" (native and Mirage); it names its table, view and relationship, not a column.
      const subgridId = nativeId.startsWith('dataSetRoot_') ? nativeId.slice('dataSetRoot_'.length) : '';
      const native = subgridId
        ? (report.nativeComponents ?? []).filter(
            (item) => item.id === subgridId && forms.some((form) => form.id === item.formId),
          )
        : [];
      // A list page shows a view of the page's table: the view of the address (else its default) and, on a column, that column.
      const listPage = sameDocument && context.pageType === 'entitylist';
      const views = listPage
        ? [
            (report.views ?? []).find((view) => view.id === context.viewId) ??
              (report.views ?? []).find((view) => view.isDefault) ??
              (report.views ?? [])[0],
          ].filter(Boolean)
        : [];
      const listFields =
        listPage && fieldName
          ? (report.columns ?? []).filter((column) => column.name === fieldName && column.entity === context.entity)
          : [];
      let fields;
      if (listPage) fields = listFields;
      else if (fieldName && !subgridId)
        fields = forms.flatMap((form) =>
          (report.columns ?? []).filter(
            (column) =>
              column.formId === form.id &&
              (nativeId ? [column.name, column.controlId] : [column.name]).includes(fieldName),
          ),
        );
      else fields = [];
      const code = fields.flatMap((field) => {
        const form = forms.find((item) => item.id === field.formId),
          control = form?.controls.find((item) => item.name === field.name);
        return control?.pcf
          ? [
              {
                schemaName: control.pcf.name,
                field: field.name,
                entity: field.entity,
                binding: exact.length ? 'Control on the open form' : 'Control on a possible form of this table',
                formSource: { name: form.name, ref: form.ref },
                resources: (report.assets ?? []).filter((asset) => asset.name.startsWith(control.pcf.name + '/')),
              },
            ]
          : [];
      });
      let commandLocation;
      if (context.pageType === 'entitylist') commandLocation = 'grid';
      else if (context.formId || context.formType != null || context.pageType === 'entityrecord')
        commandLocation = 'form';
      else commandLocation = null;
      const matches = sameDocument
        ? (catalogue?.commands ?? []).filter(
            (command) =>
              command.id &&
              context.entity &&
              command.entity === context.entity &&
              command.locations?.includes(commandLocation) &&
              (nativeId === command.id ||
                command.nativeControlIds?.includes(nativeId) ||
                (commandLocation === 'form' && nativeId === `${command.entity}|NoRelationship|Form|${command.id}`)),
          )
        : [];
      return {
        entity: sameDocument ? context.entity : '',
        fields,
        forms: listPage ? [] : forms,
        views: views.map((view) => ({ ...view, kind: 'view' })),
        lists: [],
        native,
        code,
        formId: sameDocument ? context.formId : '',
        viewId: '',
        listId: '',
        context: nativeId || label(node),
        conflict: false,
        formCertain: exact.length > 0,
        listCertain: false,
        commands: matches.length === 1 ? matches : [],
        commandAmbiguous: matches.length > 1,
      };
    }
    const labelled = labelledControl(node);
    const chain = lineage(labelled ?? node);
    // Native rich-text hosts name the attribute, while inner editor IDs are
    // shared by every instance. Carry that host through accessible frame chains.
    const richHost =
      resolveHost &&
      chain.find((item) => {
        const name = /^(.*)_(?:ControlView|Container)$/i.exec(get(item, 'id'))?.[1];
        return name && (report?.columns ?? []).some((column) => norm(column.name) === norm(name));
      });
    // The containing frame may supply its form ID; host-page forms are a separate context.
    if (get(node, 'ownerDocument') !== document) {
      const boundary = chain.findIndex(
        (item, index) => get(item, 'localName') === 'iframe' && (!richHost || index > chain.indexOf(richHost)),
      );
      if (boundary >= 0) chain.splice(boundary + 1);
    }
    const documentContext = (doc) => {
      try {
        // A document, or { URL } for a frame's address before its document is read.
        const url = new URL(get(doc, 'nodeType') === 9 ? get(doc, 'URL') : doc.URL);
        if (url.origin !== location.origin) return {};
        const params = definitionQuery(url);
        const declarations = (keys) =>
          params.filter(([key, value]) => keys.includes(key) && value).map(([, value]) => value);
        const forms = declarations(['entityformid', 'formid']),
          tables = declarations(['entityname', 'tablename', 'etn', 'typename']);
        const repeatedFormConflict = ['entityformid', 'formid'].some(
          (key) => new Set(declarations([key]).map(norm)).size > 1,
        );
        const sameDefinition = forms.every(
          (id) =>
            norm(id) === norm(forms[0]) ||
            allForms.some(
              (form) =>
                [form.id, form.formXml?.id].some((value) => norm(value) === norm(id)) /* NOSONAR */ &&
                [form.id, form.formXml?.id].some((value) => norm(value) === norm(forms[0])), // NOSONAR: callbacks capture request-scoped state
            ),
        );
        return {
          formId: declarations(['entityformid'])[0] ?? forms[0] ?? '',
          entity: tables[0] ?? '',
          conflict: repeatedFormConflict || !sameDefinition || new Set(tables.map(norm)).size > 1,
        };
      } catch {
        return {};
      }
    };
    const documentForm = (doc) => documentContext(doc).formId ?? '';
    const compact = (value) =>
      norm(value)
        .replaceAll('-', '')
        .replace(/[^a-z0-9_]/g, '_');
    const indexedForms = report?.componentIndex?.forms ?? [];
    const allForms = [
      ...(report?.forms ?? []).map((form) => {
        const matches = indexedForms.filter((item) => norm(item.id) === norm(form.id));
        const whole =
          matches.length === 1 && (!form.entity || norm(matches[0].entity) === norm(form.entity)) ? matches[0] : null;
        return { ...whole, ...form, formXml: form.formXml ?? whole?.formXml };
      }),
      ...indexedForms.filter((form) => !(report?.forms ?? []).some((known) => norm(known.id) === norm(form.id))),
    ];
    const pageLists = (report?.components ?? []).filter((item) => item.kind === 'list'),
      allLists = [
        ...pageLists.map((list) => ({
          ...(report?.componentIndex?.lists ?? []).find(
            (item) => norm(item.id ?? item.recordId) === norm(list.id ?? list.recordId),
          ),
          ...list,
          pageReferenced: true,
        })),
        ...(report?.componentIndex?.lists ?? []).filter(
          (list) => !pageLists.some((known) => norm(known.id ?? known.recordId) === norm(list.id ?? list.recordId)),
        ),
      ];
    const nativeAt = (current) =>
      allForms.filter((form) =>
        ['EntityFormControl_', 'WebFormControl_'].some(
          (prefix) =>
            get(current, 'id') === prefix + compact(form.id) ||
            get(current, 'id') === prefix + compact(form.id) + '_EntityFormView',
        ),
      );
    let entity = '',
      formId = '',
      viewId = '',
      listId = '',
      forms = [],
      views = [],
      lists = [],
      family = '',
      context = '',
      conflict = false,
      formCertain = false,
      listCertain = false;
    const scope = [];
    for (const current of chain) {
      let shape = {};
      try {
        const parsed = JSON.parse(
          /* NOSONAR */ call(current, 'getAttribute', 'data-form-layout') ??
            /* NOSONAR */ call(
              call(current, 'querySelector', ':scope > [data-form-layout]'),
              'getAttribute',
              'data-form-layout',
            ) ??
            '{}',
        );
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) shape = parsed;
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
      const value = (name) => call(current, 'getAttribute', name) ?? '';
      const scopedFrame = get(current, 'localName') === 'iframe' ? frameDocument(current) : null;
      const frameContext = scopedFrame ? documentContext(scopedFrame) : {};
      if (
        frameContext.conflict ||
        (get(current, 'ownerDocument') !== document && documentContext(get(current, 'ownerDocument')).conflict)
      )
        conflict = true;
      // Mirage's own renderers write data-entityname (read on Mirage pages only); a live portal names a row's table
      // with data-entity.
      const mirageTable = d.mirageMode ? value('data-entityname') : '';
      const tableDeclarations = [
        mirageTable,
        value('data-entity'),
        value('data-paqvilo-table'),
        shape.EntityName,
        frameContext.entity,
      ]
        .filter(Boolean)
        .map(norm);
      const declared = tableDeclarations[0] ?? '';
      if (new Set(tableDeclarations).size > 1) conflict = true;
      let frameForm = '';
      if (get(current, 'localName') === 'iframe') {
        try {
          const url = new URL(call(current, 'getAttribute', 'src'), get(get(current, 'ownerDocument'), 'baseURI'));
          if (scopedFrame && /^https?:/i.test(get(scopedFrame, 'URL'))) frameForm = frameContext.formId || '';
          else if (url.origin === location.origin) frameForm = documentContext({ URL: url.href }).formId || '';
        } catch {
          /* Optional inspection or cleanup failure must not interrupt the owning operation. */
        }
      }
      let fallbackForm = '';
      if (/^EntityFormControl(?:_EntityFormView)?$/.test(get(current, 'id'))) {
        if (get(current, 'ownerDocument') === document)
          fallbackForm = report?.page?.entityFormId ?? report?.page?.basicFormId ?? '';
        else fallbackForm = documentForm(get(current, 'ownerDocument'));
      }
      const fallbackList =
        get(current, 'ownerDocument') === document && /^EntityListControl$/.test(get(current, 'id'))
          ? (report?.page?.listId ?? '')
          : '';
      // data-formid, data-viewid and data-listid are markers of local pages only: no portal writes them, so on a
      // live page an author's attribute of that name says nothing.
      const marked = (name) => (d.mirageMode ? value(name) : '');
      const fid = marked('data-formid') || String(shape.Id ?? '') || frameForm || fallbackForm;
      for (const declaredForm of [marked('data-formid'), shape.Id, frameForm, fallbackForm].filter(Boolean)) {
        if (norm(declaredForm) === norm(fid)) continue;
        if (
          !allForms.some(
            (form) =>
              [form.id, form.formXml?.id].some((id) => norm(id) === norm(fid)) &&
              [form.id, form.formXml?.id].some((id) => norm(id) === norm(declaredForm)),
          )
        )
          conflict = true;
      }
      let vid = marked('data-viewid') || value('data-selected-view');
      /* NOSONAR */ if (!vid && call(current, 'hasAttribute', 'data-view-layouts'))
        try {
          const layouts = JSON.parse(atob(value('data-view-layouts')));
          if (Array.isArray(layouts) && layouts.length === 1) vid = String(layouts[0].Id ?? layouts[0].id ?? '');
        } catch {
          /* Optional inspection or cleanup failure must not interrupt the owning operation. */
        }
      const currentId = get(current, 'id');
      const listMatch =
        /^EntityList(?:Control_)?([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:$|_)/i.exec(currentId) ??
        /^EntityListControl_([0-9a-z]+)$/i.exec(currentId);
      let lid = marked('data-listid') || listMatch?.[1] || listMatch?.[2] || fallbackList;
      let inferredList = Boolean(fallbackList && !marked('data-listid'));
      if (!lid && call(current, 'matches', '.entitylist,.entity-grid') && !call(current, 'closest', '.subgrid')) {
        const candidates = (report?.components ?? []).filter(
          (item) => item.kind === 'list' && (!vid || (item.viewIds ?? []).some((id) => norm(id) === norm(vid))),
        );
        if (candidates.length === 1) {
          lid = candidates[0].recordId ?? candidates[0].id;
          inferredList = true;
        }
      }
      const nativeForms = nativeAt(current);
      const recordForms = allForms.filter((item) => fid && norm(item.id) === norm(fid));
      let nextForms;
      if (recordForms.length) nextForms = recordForms;
      else if (nativeForms.length) nextForms = nativeForms;
      else nextForms = allForms.filter((item) => fid && norm(item.formXml?.id) === norm(fid));
      const nextViews = (report?.views ?? []).filter((item) => vid && norm(item.id) === norm(vid));
      const nextLists = allLists.filter((item) => lid && compact(item.recordId ?? item.id) === compact(lid));
      let nextFamily;
      if (vid || lid) nextFamily = 'collection';
      else if (fid || nativeForms.length) nextFamily = 'form';
      else nextFamily = '';
      if (family && nextFamily && family !== nextFamily) break;
      if (
        forms.length &&
        nextForms.length &&
        !nextForms.some((item) => forms.some((known) => norm(known.id) === norm(item.id)))
      )
        break;
      if (
        (formId && fid && norm(formId) !== norm(fid)) ||
        (viewId && vid && norm(viewId) !== norm(vid)) ||
        (listId && lid && norm(listId) !== norm(lid))
      )
        break;
      const entities = [
        ...new Set([...nextForms, ...nextViews, ...nextLists].map((item) => item.entity).filter(Boolean)),
      ];
      const inferred = entities.length === 1 ? entities[0] : '';
      // A different enclosing table/component is a boundary, not the selected control's owner.
      if (entity && ((declared && norm(declared) !== norm(entity)) || (inferred && norm(inferred) !== norm(entity)))) {
        // An explicit frame declaration disagreeing with its resolved form is a
        // conflict, never permission to substitute a parent table.
        if (get(current, 'localName') === 'iframe' || (nextForms.length && (fid || nativeForms.length)))
          conflict = true;
        break;
      }
      if (
        entities.length > 1 ||
        (declared && inferred && norm(declared) !== norm(inferred)) ||
        (mirageTable && shape.EntityName && norm(mirageTable) !== norm(shape.EntityName))
      )
        conflict = true;
      scope.push(current);
      entity ||= norm(declared || inferred);
      if (!context && (declared || nextFamily)) context = label(current);
      if (nextFamily) family = nextFamily;
      if (!formId && fid) formId = fid;
      if (!viewId && vid) viewId = vid;
      if (!listId && lid) listId = lid;
      if (!forms.length && nextForms.length) {
        forms = nextForms;
        formCertain = Boolean(recordForms.length || nativeForms.length);
      }
      if (!views.length && nextViews.length) views = nextViews;
      if (!lists.length && nextLists.length) lists = nextLists;
      if (nextLists.length && !inferredList) listCertain = true;
    }
    if (!views.length && lists.length === 1 && lists[0].viewIds?.length === 1)
      views = (report?.views ?? []).filter((item) => norm(item.id) === norm(lists[0].viewIds[0]));
    // Rendered column declarations: a control's or list cell's data-attribute and a lookup dialog's
    // data-lookup-datafieldname (Power Pages), and, on Mirage pages only, the markers Mirage's own renderers write
    // (data-field, data-fieldname, data-pcf-native-field): a live portal never writes them, so on a live page they are
    // an author's attributes. A list cell's data-th is its column's display label, never a logical name.
    const fieldAttributes = d.mirageMode
      ? ['data-attribute', 'data-field', 'data-fieldname', 'data-pcf-native-field', 'data-lookup-datafieldname']
      : ['data-attribute', 'data-lookup-datafieldname'];
    const explicit = scope.find((item) => fieldAttributes.some((name) => call(item, 'hasAttribute', name)));
    const control = labelled ?? scope.find((item) => call(item, 'matches', 'input,select,textarea,output'));
    const grid = gridColumn(node);
    let names;
    if (explicit) names = fieldAttributes.map((key) => call(explicit, 'getAttribute', key)).filter(Boolean);
    else if (grid) names = [grid.name];
    else if (control) names = [get(control, 'id'), call(control, 'getAttribute', 'name')].filter(Boolean);
    else names = [];
    const hostContext = richHost ? binding(richHost, false) : null;
    const hostAgrees =
      hostContext &&
      !hostContext.conflict &&
      (!entity || norm(entity) === norm(hostContext.entity)) &&
      (!forms.length ||
        forms.some((form) => hostContext.forms.some((hostForm) => norm(hostForm.id) === norm(form.id))));
    if (richHost && hostAgrees && (entity || forms.length)) {
      const hostName = /^(.*)_(?:ControlView|Container)$/i.exec(get(richHost, 'id'))[1];
      if (explicit && names.some((name) => norm(name) !== norm(hostName))) conflict = true;
      names.splice(0, names.length, hostName);
    }
    if (grid?.table) {
      if (entity && norm(grid.table) !== norm(entity)) conflict = true;
      else entity = norm(grid.table);
    }
    if (control && entity) for (const name of [...names]) if (name.includes('$')) names.push(name.split('$').at(-1)); // NOSONAR: snapshot copy guards against mutation while iterating
    const cell = call(
      control,
      'closest',
      d.mirageMode ? '.cell,.form-group,td,[data-fieldname]' : '.cell,.form-group,td',
    );
    if (cell) {
      /* NOSONAR: snapshot copy guards against mutation while iterating */ for (const name of [...names]) {
        const base = name.replace(
          /_(?:name|entityname|datepicker_description|datepicker|timepicker_description|timepicker|i\d+|option_\d+|\d+|selected|value|container)$/i,
          '',
        );
        if (
          base !== name &&
          ([...call(cell, 'querySelectorAll', 'input')].some(
            (item) =>
              (get(item, 'id') === base || get(item, 'name') === base) &&
              (get(item, 'type') === 'hidden' || /_(?:date|time)picker(?:_description)?$/i.test(name)),
          ) ||
            (call(control, 'matches', 'input[type=radio],input[type=checkbox]') &&
              chain.some((item) => get(item, 'id') === base && call(cell, 'contains', item))))
        )
          names.push(base);
      }
    }
    const fields = conflict
      ? []
      : (report?.columns ?? []).filter(
          (item) =>
            // A column is a candidate only inside a rendered table context (a form, list or declared grid): a
            // hand-written input named like a column is not a field of every table that has the column.
            entity && names.some((name) => norm(name) === norm(item.name)) && norm(item.entity) === norm(entity),
        );
    // A grid's table is a binding boundary, but its enclosing form still owns the
    // FormXml control. Resolve ownership separately from the selected row's table.
    const ownerForms =
      chain
        .map((current) => {
          let id = d.mirageMode ? call(current, 'getAttribute', 'data-formid') : null; // NOSONAR: reads attributes of observed DOM, dataset would differ
          if (!id)
            try {
              id = JSON.parse(call(current, 'getAttribute', 'data-form-layout') ?? '{}')?.Id; // NOSONAR: reads attributes of observed DOM, dataset would differ
            } catch {
              /* Optional inspection or cleanup failure must not interrupt the owning operation. */
            }
          return id
            ? (report?.forms ?? []).filter((form) => norm(form.id) === norm(id) || norm(form.formXml?.id) === norm(id))
            : nativeAt(current);
        })
        .find((items) => items.length) ?? forms;
    const native = (report?.nativeComponents ?? []).filter(
      (item) =>
        scope.some(
          (ancestor) =>
            get(ancestor, 'id') === item.id || call(ancestor, 'getAttribute', 'data-lookup-datafieldname') === item.id, // NOSONAR: reads attributes of observed DOM, dataset would differ
        ) &&
        (!ownerForms.length || ownerForms.some((form) => norm(form.id) === norm(item.formId))) &&
        (!item.viewId || !viewId || norm(item.viewId) === norm(viewId)),
    );
    // Mirage marks its code component hosts with data-pcf-schema; a live host is PcfControlConfig_<column>.
    const schema = call(
      d.mirageMode ? scope.find((item) => call(item, 'hasAttribute', 'data-pcf-schema')) : null,
      'getAttribute',
      'data-pcf-schema',
    ); // NOSONAR: reads attributes of observed DOM, dataset would differ
    const code = (report?.codeComponents ?? []).filter(
      (item) =>
        (schema && norm(item.schemaName) === norm(schema)) ||
        (item.binding === 'native-formxml' &&
          item.selectedDesktop &&
          item.enablement === 'configured' &&
          ownerForms.some((form) => norm(form.id) === norm(item.formId)) &&
          scope.some(
            (node) =>
              (get(node, 'id') === item.field + '_Container' &&
                Boolean(
                  call(node, 'querySelector', ':scope > [data-pcf-control][id="PcfControlConfig_' + item.field + '"]'),
                )) ||
              (d.mirageMode && call(node, 'getAttribute', 'data-pcf-native-field') === item.field), // NOSONAR: reads attributes of observed DOM, dataset would differ
          )),
    );
    return {
      entity,
      fields,
      forms,
      views,
      lists,
      native,
      code,
      formId,
      viewId,
      listId,
      context,
      conflict,
      formCertain,
      listCertain,
      grid,
      exportedForms: allForms,
      exportedLists: allLists,
    };
  };
  const framework =
    /^(?:alert(?:-.+)?|message|form-control|btn(?:-.+)?|close|title|row|container(?:-fluid)?|col-(?:xs|sm|md|lg|xl|xxl)-\d+|modal(?:-.+)?|control-label|input-group(?:-.+)?|clearfix|pull-(?:left|right)|text-(?:left|right|center|muted)|hidden|show|active)$/; // NOSONAR: regex kept: a rewrite would change matches or captures
  let rankingReport, frequencies, pageOwners, pageTemplates;
  const sourceEvidenceLabel = (item, strong, depth) => {
    let prefix;
    if (item.kind === 'script') prefix = 'Script uses';
    else if (strong) prefix = 'Markup matches';
    else prefix = 'Markup may match';
    const enclosing = depth ? ' on a parent element' : '';
    const occurrences = item.occurrences > 1 ? ' · ' + item.occurrences + ' places in this file' : '';
    return `${prefix} ${item.selector}${enclosing}${occurrences}`;
  };
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const sourceMatches = (node) => {
    const ancestors = lineage(node).filter((item) => get(item, 'ownerDocument') === get(node, 'ownerDocument')),
      rows = [];
    if (rankingReport !== report || !frequencies) {
      rankingReport = report;
      frequencies = new Map();
      pageOwners = new Set(['page']);
      // The templates this page renders (its template and what it includes), when the report names them.
      pageTemplates = (report?.webTemplates ?? []).some((item) => item.name || item.ref)
        ? new Set(report.webTemplates.flatMap((item) => [item.name, item.ref, item.id].filter(Boolean)))
        : null;
      for (const item of report?.elementSources ?? [])
        if (item.matchKind === 'class') {
          let files = frequencies.get(item.selector);
          if (!files) {
            files = new Set();
            frequencies.set(item.selector, files);
          }
          files.add((item.ref ?? item.sourceFile) + '#' + (item.recordId ?? item.id ?? item.name ?? ''));
        }
      const sources = [
        ...(report?.webTemplates ?? []).map((item) => ({
          ...item,
          owners: ['web-template:' + norm(item.id), 'web-template:' + item.name],
        })),
        ...(report?.snippets ?? []).map((item) => ({
          ...item,
          owners: ['content-snippet:' + norm(item.id), 'content-snippet:' + item.name],
        })),
      ];
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of sources)
          if (
            !item.owners.every((owner) => pageOwners.has(owner)) &&
            (item.includedBy ?? item.usedBy)?.some(
              (owner) => owner.startsWith('page-template:') || pageOwners.has(owner),
            )
          ) {
            for (const owner of item.owners) pageOwners.add(owner);
            changed = true;
          }
      }
    }
    for (const item of report?.elementSources ?? []) {
      try {
        const exactDepth = ancestors.findIndex((ancestor) => call(ancestor, 'matches', item.selector));
        let depth;
        if (exactDepth >= 0) depth = exactDepth;
        else if (item.matchKind === 'class')
          depth = ancestors.findIndex(
            (ancestor) =>
              get(ancestor, 'localName') === item.tag &&
              (item.classes ?? []).some((name) => get(ancestor, 'classList').contains(name)),
          );
        else depth = -1;
        if (depth < 0) continue;
        const target = ancestors[depth];
        const locations = item.locations ?? [];
        const matchingTags = locations.filter((location) => !location.tag || location.tag === get(target, 'localName'));
        const contexts = (matchingTags.length ? matchingTags : locations)
          .map((location) => {
            const agreement = (location.contexts ?? []).filter((selector) =>
                ancestors.slice(depth + 1).some((ancestor) => call(ancestor, 'matches', selector)),
              ).length,
              declared = location.classes ?? item.classes ?? [],
              present = declared.filter((name) => get(target, 'classList').contains(name)).length;
            let contextual = 0,
              contradictions = 0;
            for (const context of location.ancestors ?? []) {
              const container = ancestors
                .slice(depth + 1)
                .find(
                  (ancestor) =>
                    get(ancestor, 'localName') === context.tag &&
                    context.classes.some((name) => get(ancestor, 'classList').contains(name)),
                );
              if (!container) continue;
              const missing = context.classes.filter((name) => !get(container, 'classList').contains(name));
              contradictions += missing.length;
              contextual += missing.length ? 0 : context.classes.filter((name) => !framework.test(name)).length;
            }
            return {
              ...location,
              agreement,
              contextual,
              contradictions,
              locationScore:
                agreement * 20 + present * 5 - (declared.length - present) * 65 + contextual * 20 - contradictions * 65,
            };
          })
          .sort((a, b) => b.locationScore - a.locationScore);
        const declaredClasses = contexts[0]?.classes ?? item.classes ?? [],
          classes = declaredClasses.filter((name) => get(target, 'classList').contains(name)),
          meaningful = classes.filter((name) => !framework.test(name));
        const agreed = contexts[0]?.agreement ?? 0,
          tagMatch =
            locations.some((location) => location.tag === get(target, 'localName')) ||
            !item.tag ||
            item.tag === get(target, 'localName');
        const pageChain =
          (item.includedBy ?? item.usedBy)?.some(
            (owner) => owner.startsWith('page-template:') || pageOwners.has(owner),
          ) ?? false;
        // A template this page neither renders nor includes is a candidate only for the element's own ID or attribute:
        // a class it shares, or a match on a parent element, says nothing about this page.
        if (
          pageTemplates &&
          item.kind === 'template' &&
          !pageChain &&
          ![item.name, item.ref, item.id].some((key) => key && pageTemplates.has(key)) &&
          (depth > 0 || !['id', 'attribute'].includes(item.matchKind))
        )
          continue;
        const missing = declaredClasses.length - classes.length,
          targetClasses = [...get(target, 'classList')].filter((name) => !framework.test(name)),
          coverage = targetClasses.length ? meaningful.length / targetClasses.length : 1;
        const rarity = report?.elementSourceFrequencies?.[item.selector] ?? frequencies.get(item.selector)?.size ?? 1;
        const contextual = contexts[0]?.contextual ?? 0,
          contradictions = contexts[0]?.contradictions ?? 0;
        // Static reachability and selector rarity cannot prove a conditional branch rendered.
        const compatible = tagMatch && !missing && !contradictions;
        const strong =
          compatible &&
          (item.matchKind === 'id' ||
            item.matchKind === 'attribute' ||
            (item.matchKind === 'class' &&
              ((meaningful.length > 0 && (coverage >= 1 || rarity <= 2)) ||
                contextual > 0 ||
                (agreed > 0 && meaningful.length > 0))));
        const attributeCount = Object.entries(contexts[0]?.attributes ?? item.attributes ?? {}).filter(
          ([key, value]) => call(target, 'getAttribute', key) === value,
        ).length;
        // Prefer stronger evidence across adjacent regions, but do not let a distant
        // page-container ID eclipse the distinctive template immediately around a node.
        const matchKindScore = () => {
          if (item.matchKind === 'id') return 110;
          if (item.matchKind === 'attribute') return 85;
          if (item.matchKind === 'class') return 35 + classes.length * 5 + meaningful.length * 10;
          return 20;
        };
        const score =
          attributeCount * 5 +
          matchKindScore() +
          (tagMatch ? 10 : -85) +
          agreed * 20 +
          contextual * 20 -
          contradictions * 65 -
          depth * 40 +
          coverage * 15 -
          missing * 65 -
          Math.min(10, Math.log2(Math.max(1, rarity)) * 2);
        const best = contexts.filter((location) => location.locationScore === contexts[0]?.locationScore);
        rows.push({
          ...item,
          line: best[0]?.line ?? item.line,
          lines: best.map((location) => location.line).filter(Boolean),
          depth,
          score,
          strong,
          compatible,
          pageChain,
          evidenceLabel: sourceEvidenceLabel(item, strong, depth),
        });
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    }
    // A page's include graph cannot disambiguate shared markup. The current
    // page's own copy also competes with template/snippet IDs and attributes
    // added at runtime; retain those identities without asserting an owner.
    const sourceIdentity = (item) =>
      (item.ref ?? item.sourceFile ?? '') + '\u0000' + (item.recordId ?? item.id ?? item.name ?? '');
    const markupKinds = new Set(['page', 'template', 'snippet']);
    for (const row of rows)
      if (
        row.strong &&
        markupKinds.has(row.kind) &&
        rows.some(
          (other) =>
            other !== row &&
            other.compatible &&
            markupKinds.has(other.kind) &&
            sourceIdentity(other) !== sourceIdentity(row) &&
            other.depth === row.depth &&
            (other.selector === row.selector ||
              (other.matchKind === 'class' && row.matchKind === 'class') ||
              other.kind === 'page' ||
              row.kind === 'page'),
        )
      )
        row.ambiguous = true;
    for (const row of rows)
      if (row.ambiguous) {
        row.strong = false;
        row.evidenceLabel = row.evidenceLabel.replace('Markup matches ', 'Markup may match ');
      }
    const ranked = /* NOSONAR */ rows.sort(
      // NOSONAR: retain in-place receiver mutation and ordering
      /* NOSONAR: preserve in-place sorting */
      (a, b) =>
        Number(b.strong) - Number(a.strong) ||
        b.score - a.score ||
        a.depth - b.depth ||
        Number(b.pageChain) - Number(a.pageChain),
    );
    const result = ranked.slice(0, 60);
    result.omitted = Math.max(0, ranked.length - result.length);
    return result;
  };
  // The element Lense read below the selection, with where it stands and what its source is. Content of another origin
  // is not portal source; content of a closed shadow root is the selected element's, which created it.
  const piercedHtml = (below) => {
    const found = below?.result?.element;
    if (!found) return '';
    const frame = found.scope?.frame;
    // A cross-origin frame has no exported source, closed roots inside it included. A portal page in a frame (in the
    // tab's process or out of it) is the portal's: its closed roots map as the page's do.
    const foreign = below.result.sealedBy === 'cross-origin-frame' || Boolean(frame?.crossOrigin);
    const heading = foreign
      ? 'Inside a cross-origin frame · ' + esc(frame?.origin ?? '')
      : 'Inside a closed shadow root';
    const kind = foreign ? 'cross-origin-frame' : 'closed-shadow-root';
    const attributes = Object.entries(found.attributes ?? {})
      .map(([name, value]) => '<dt>' + esc(name) + '</dt><dd>' + esc(value) + '</dd>')
      .join('');
    const path = (below.result.path ?? [])
      .map(
        (step) =>
          step.tag + (step.id ? '#' + step.id : '') + (step.class ? '.' + step.class.replaceAll(/\s+/g, '.') : ''),
      )
      .join(' › ');
    // A declarative closed shadow root the export writes: its element maps to that source, as other elements do.
    const written = (below.result.source?.refs ?? []).filter((ref) => ref.ref && ref.line);
    let source = foreign
      ? 'Not portal source: the frame belongs to another origin, so it is shown, never matched to files.'
      : 'Contained in its shadow host: script of the host created this closed shadow root, so its source is the host’s.';
    if (!foreign && written.length)
      source =
        'Written by the exported source: ' +
        written
          .map((ref) => '<span class="mono" data-pierced-source>' + esc(ref.ref + ':' + ref.line) + '</span>')
          .join(', ');
    return (
      '<div class="section pierced" data-pierced="' +
      kind +
      '" data-generation="' +
      below.generation +
      '"><h3>' +
      heading +
      ' <small>read through the DevTools protocol</small></h3><div class="binding"><strong>' +
      esc('<' + found.tag + '>') +
      '</strong>' +
      (found.text ? '<div class="muted">' + esc(found.text) + '</div>' : '') +
      '</div><dl class="details"><dt>Path</dt><dd class="mono">' +
      esc(path) +
      '</dd>' +
      attributes +
      '</dl><p class="note">' +
      source +
      '</p></div>'
    );
  };
  const dispatch = (action, detail = {}) =>
    host.dispatchEvent(new CustomEvent('paqvilo-xray', { bubbles: true, detail: { action, ...detail } }));
  const feedbackIdentity = (evidence) => ({
    owner: JSON.stringify(
      evidence?.owner?.component &&
        Object.fromEntries(
          ['key', 'kind', 'entity', 'field', 'id', 'name'].map((key) => [key, evidence.owner.component[key]]),
        ),
    ),
    refs: (evidence?.source?.refs ?? []).map((ref) => ({
      key: ref.sourceKey ?? ref.key ?? ref.id,
      sourceRevision: ref.sourceRevision,
      contentRevision: ref.contentRevision,
      region: ref.region && { start: ref.region.start, end: ref.region.end },
    })),
  });
  const clearStatus = () => {
    statusMessage = '';
    statusSelection = null;
    const output = call(card, 'querySelector', '.status');
    if (output) output.textContent = '';
  };
  const statusCurrent = (expected) => {
    if (!enabled || disposed || !selected || !liveNode(selected) || !expected) return false;
    const scope = getSelectionScope(selected);
    if (
      expected.anchorGeneration !== selectionGeneration ||
      expected.feedbackEpoch !== feedbackEpoch ||
      !['documentId', 'frameId', 'uiEpoch', 'sourceRevision'].every((key) => expected.scope?.[key] === scope[key])
    )
      return false;
    const previous = expected.feedbackIdentity ?? feedbackIdentity(expected.identity?.evidence),
      current = feedbackIdentity(identify(selected, scope).evidence);
    return (
      previous.owner === current.owner &&
      previous.refs.every((ref) => current.refs.some((candidate) => JSON.stringify(candidate) === JSON.stringify(ref)))
    );
  };
  const setStatus = (message, expected) => {
    const current = expected ?? {
      anchorGeneration: selectionGeneration,
      scope: getSelectionScope(selected),
      feedbackEpoch,
      feedbackIdentity: selected ? feedbackIdentity(identify(selected, getSelectionScope(selected)).evidence) : null,
    };
    if (!statusCurrent(current)) {
      if (!statusCurrent(statusSelection)) clearStatus();
      return;
    }
    statusMessage = String(message ?? '');
    statusSelection = current;
    const output = call(card, 'querySelector', '.status');
    if (output) output.textContent = statusMessage;
  };
  const kindName = (kind) =>
    ({
      template: 'Web template',
      snippet: 'Content snippet',
      page: 'Page copy',
      'basic-form': 'Basic form',
      'model-driven-form': 'Form',
      'advanced-form': 'Multistep form',
      list: 'List',
      script: 'Script',
      field: 'Column',
      column: 'Dataverse column',
      control: 'Form field',
      view: 'View',
      table: 'Table',
      image: 'Image',
      stylesheet: 'Stylesheet',
      asset: 'Asset',
      webtemplate: 'Web template',
      markup: 'Markup',
      'web-file': 'Web file',
      'platform-shell': 'Portal page shell',
      'platform-asset': 'Portal runtime file',
      'portal-endpoint': 'Portal endpoint',
      'external-resource': 'File from another site',
      'builtin-template': 'Built-in template',
      'content-snippet': 'Content snippet',
      'webpage-field': 'Web page field',
      'page-template': 'Page template',
      'form-tab': 'Form tab',
      'form-section': 'Form section',
      'liquid-tag': 'Liquid tag',
      'advanced-form-step': 'Multistep form step',
      pcf: 'Code component',
      form: 'Form',
      formxml: 'Form',
      webpage: 'Web page',
      'form-control': 'Form control',
      subgrid: 'Subgrid',
      'quick-view': 'Quick view',
      'lookup-view': 'Lookup view',
      'list-view': 'List view',
    })[kind] ??
    kind ??
    'Source';
  // A part of a component (key "<component>#<part>") in words, after the component's own name: "Contact us ·
  // validation summary", "Cases · action: create". A field reads "contact.emailaddress1".
  const PART_WORDS = {
    'custom-javascript': 'custom JavaScript',
    'client-validation': 'client validation',
    captcha: 'CAPTCHA',
    'empty-maker': 'empty message for makers',
    empty: 'empty message',
    'access-denied': 'access denied message',
    error: 'error message',
    loading: 'loading message',
  };
  const partText = (part) =>
    String(part)
      .split(':')
      .map((piece) => PART_WORDS[piece] ?? piece.replaceAll('-', ' '))
      .join(': ');
  const componentLabel = (component) => {
    const key = typeof component?.key === 'string' ? component.key : '';
    const at = key.indexOf('#');
    if (at >= 0) {
      const part = key.slice(at + 1);
      const id = norm(component.id ?? component.recordId ?? '');
      const whole = id
        ? [...(report?.forms ?? []), ...(report?.components ?? [])].find(
            (item) => item?.name && norm(item.id ?? item.recordId) === id,
          )?.name
        : '';
      return [whole, partText(part)].filter(Boolean).join(' · ');
    }
    return columnLabel(component);
  };
  // Gives a component its display name: a field its column's label, a part "<component> · <part>" in words. A part's
  // own name is its code, so it takes the display name too: the header never shows the code.
  const nameComponent = (component) => {
    if (!component || component.label) return;
    const display = componentLabel(component);
    if (!display) return;
    component.label = display;
    if (component.key?.includes('#')) component.name = display;
  };
  // The display name of a field or column component (its logical name is the component's name).
  const columnLabel = (component) =>
    ['control', 'field', 'column'].includes(component?.kind)
      ? (report?.columns ?? []).find(
          (column) =>
            column.label &&
            norm(column.name) === norm(component.field ?? component.name) &&
            (!component.formId || !column.formId || norm(column.formId) === norm(component.formId)) &&
            (!component.entity || !column.entity || norm(column.entity) === norm(component.entity)),
        )?.label
      : undefined;
  // Files X-ray lists itself use the shared row: name and kind, the path on one line, icon buttons.
  const sourceRows = (rows, evidence) =>
    rows
      .map((item) => {
        // The accessible names carry the row (and its selector, when one file matches more than once).
        const name = item.name ?? item.label ?? 'Source',
          row = (item.name ?? item.label ?? item.ref) + (item.selector ? ' ' + item.selector : ''),
          copy = item.path ?? item.sourceFile ?? item.ref;
        // A markup match says where it matched with the relation badge the evidence rows use; its line keeps the rest.
        const parentMatch = item.selector && item.depth > 0;
        const why = item.evidenceLabel ?? evidence;
        return renderInspectionEvidence(null, {
          part: 'row',
          context: 'xray',
          row: {
            cls: 'source',
            name,
            what: kindName(item.kind),
            relation: item.selector && why ? [parentMatch ? 'Parent' : 'This element', why] : undefined,
            path: item.ref ?? item.url ?? 'Source unavailable',
            subs: [parentMatch && why ? why.replaceAll(' on a parent element', '') : why],
            actions: item.ref
              ? [
                  {
                    act: 'open',
                    icon: 'code',
                    title: 'Open ' + row + ' in the editor',
                    data: { ref: item.ref },
                  },
                  { act: 'copy', icon: 'copy', title: 'Copy the file path of ' + row, data: { copy } },
                  item.depth && {
                    act: 'source-region',
                    icon: 'up',
                    title: 'Select the parent element matching ' + item.selector,
                    data: { selector: item.selector },
                  },
                ]
              : [],
          },
        });
      })
      .join('');
  const countPill = (count) => `<span class="n dimn">${count}</span>`;
  const disclosureState = new Map(),
    contextPages = new Map();
  const pageRows = (key, rows, render) => {
    const size = 8,
      pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(contextPages.get(key) ?? 0, pages - 1);
    const pageControls = () => {
      if (pages <= 1) return '';
      return `<div class="actions"><button class="btn sec" data-action="context-page" data-context="${esc(key)}" data-page="${page - 1}" ${page ? '' : 'disabled'}>Previous</button><span class="note">${page * size + 1}–${Math.min(rows.length, (page + 1) * size)} of ${rows.length}</span><button class="btn sec" data-action="context-page" data-context="${esc(key)}" data-page="${page + 1}" ${page < pages - 1 ? '' : 'disabled'}>Next</button></div>`;
    };
    return render(rows.slice(page * size, (page + 1) * size)) + pageControls();
  };
  const emptyEvidenceRefs = [],
    modelHydrations = new Map();
  let indexedEvidenceRows = null,
    evidenceIndex = null,
    evidenceReport = null;
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const sourceEvidenceIndex = () => {
    if (evidenceReport !== report) {
      evidenceReport = report;
      modelHydrations.clear();
    }
    let rows;
    if (Array.isArray(report?.portalSources)) rows = report.portalSources;
    else if (Array.isArray(report?.sourceRefs)) rows = report.sourceRefs;
    // A model-driven report carries its Solution files with the app context.
    else if (Array.isArray(report?.modelDriven?.sourceRefs)) rows = report.modelDriven.sourceRefs;
    else rows = emptyEvidenceRefs;
    if (rows !== indexedEvidenceRows) {
      indexedEvidenceRows = rows;
      evidenceIndex = { rows, byId: new Map(), byRef: new Map(), byComponent: new Map(), byRecord: new Map() };
      const addTo = (map, key, ref) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(ref);
      };
      for (const ref of rows) {
        evidenceIndex.byId.set(ref.id, ref);
        addTo(evidenceIndex.byRef, ref.ref, ref);
        if (ref.componentKey) addTo(evidenceIndex.byComponent, ref.componentKey, ref);
        else if (ref.kind && ref.recordId) addTo(evidenceIndex.byRecord, ref.kind + ':' + norm(ref.recordId), ref);
      }
    }
    return evidenceIndex;
  };
  const portalHydrations = new Set(),
    selectionAnchors = new WeakMap();
  /* NOSONAR */ const hydrateModelSelection = (node, scope, anchorGeneration, packets) => {
    if (!d.modelDriven || disposed) return [];
    const active = {},
      componentKeys = new Set(),
      observedRefs = packets.flatMap((packet) => packet.sourceRefs ?? []);
    for (const packet of packets) {
      for (const name of ['entity', 'table', 'formId', 'viewId'])
        if (typeof packet.active?.[name] === 'string' && packet.active[name].length <= 256)
          active[name] ??= packet.active[name];
      for (const name of ['controlNames', 'controlKeys', 'componentKeys'])
        if (Array.isArray(packet.active?.[name]))
          active[name] = [
            ...new Set([
              ...(active[name] ?? []),
              ...packet.active[name].filter((value) => typeof value === 'string' && value.length <= 8192),
            ]),
          ].slice(0, 128);
      for (const value of packet.sourceKeys ?? [])
        if (typeof value === 'string' && value.length <= 8192 && componentKeys.size < 128) componentKeys.add(value);
    }
    for (const ref of observedRefs)
      if (typeof ref.componentKey === 'string' && ref.componentKey.length <= 8192 && componentKeys.size < 128)
        componentKeys.add(ref.componentKey);
    const sameScope = (value) =>
      value && ['documentId', 'frameId', 'uiEpoch', 'sourceRevision'].every((name) => value[name] === scope[name]);
    const key = JSON.stringify([
      scope,
      anchorGeneration,
      active,
      [...componentKeys].sort(/* NOSONAR: preserve default string coercion */),
    ]);
    const capturedReport = report;
    let cached = modelHydrations.get(key);
    if (!cached && observedRefs.length)
      cached = [...modelHydrations.values()].find(
        (entry) =>
          entry.status === 'ready' &&
          entry.report === report &&
          entry.anchorGeneration === anchorGeneration &&
          sameScope(entry.scope) &&
          observedRefs.every((ref) => entry.refs.some((current) => current.id === ref.id)),
      );
    const currentRefs = cached?.status === 'ready' ? cached.refs : [];
    for (const packet of packets)
      packet.sourceRefs = (packet.sourceRefs ?? []).map((ref) => {
        const current = currentRefs.find((item) => item.id === ref.id);
        return {
          ...ref,
          currentState: (() => {
            if (ref.currentState === 'unavailable' || current?.currentState === 'unavailable') return 'unavailable';
            if (current) return 'available';
            return 'pending';
          })(),
          ...(current ? { currentContentRevision: current.currentContentRevision ?? current.contentRevision } : {}),
        };
      });
    if (node !== selected || !componentKeys.size || cached) return currentRefs;
    if (modelHydrations.size >= 32) modelHydrations.delete(modelHydrations.keys().next().value);
    const entry = { status: 'pending', scope, anchorGeneration, report: capturedReport, refs: [] };
    modelHydrations.set(key, entry);
    queueMicrotask(async () => {
      let timer;
      try {
        const current = host.__px?.selectionState?.();
        if (
          disposed ||
          report !== capturedReport ||
          selected !== node ||
          current?.anchorGeneration !== anchorGeneration ||
          !sameScope(getSelectionScope(node))
        )
          return;
        const api = Object.getOwnPropertyDescriptor(globalThis, '__paqviloModelPanelApi')?.value;
        if (typeof api !== 'function') {
          entry.status = 'unavailable';
          return;
        }
        const answer = await Promise.race([
          api({
            token: d.token,
            name: 'provenance',
            body: { version: 1, scope, anchorGeneration, active, componentKeys: [...componentKeys] },
          }),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 10000, null);
          }),
        ]);
        if (
          disposed ||
          report !== capturedReport ||
          selected !== node ||
          !liveNode(node) ||
          host.__px?.selectionState?.().anchorGeneration !== anchorGeneration ||
          !sameScope(getSelectionScope(node)) ||
          !answer?.ok ||
          answer.version !== 1 ||
          !sameScope(answer.scope) ||
          answer.anchorGeneration !== anchorGeneration
        ) {
          entry.status = 'unavailable';
          return;
        }
        let bytes = 0;
        entry.refs = (Array.isArray(answer.sourceRefs) ? answer.sourceRefs : []).slice(0, 128).filter((ref) => {
          if (!ref || typeof ref.id !== 'string' || ref.id.length > 8192 || ref.sourceRevision !== scope.sourceRevision)
            return false;
          bytes += JSON.stringify(ref).length;
          return bytes <= 256 * 1024;
        });
        entry.status = 'ready';
        host.__px?.refreshSelection?.('source-details-ready');
      } catch {
        entry.status = 'unavailable';
      } finally {
        clearTimeout(timer);
      }
    });
    return currentRefs;
  };
  // Proofs that name what an element is. The portal's page shell is named only when nothing else names the element.
  const NAMING_PROOFS = new Set([
    'native-component-id',
    'native-field-id',
    'page-configured-component',
    'native-api',
    'native-api-owner',
    'runtime-owner',
    'resource-url',
    'render-platform',
    'mirage-registry',
    'mirage-owner',
    'model-driven-binding',
  ]);
  // Components that hold other components: what the page structure says of one of them around a rendered element is
  // where the element stands.
  const CONTAINER_KINDS = new Set([
    'form',
    'model-driven-form',
    'basic-form',
    'advanced-form',
    'form-tab',
    'form-section',
    'list',
    'view',
    'table',
    'subgrid',
    'quickform',
    'webpage',
  ]);
  const provenanceReaders = (view) =>
    [d.provenanceSlot, d.provenance?.slot]
      .filter(Boolean)
      .map((slot) => view?.[slot])
      .filter((reader) => typeof reader?.query === 'function');
  // An element with no proof of its own (a script created it, or the parser implied it) stands inside one that has:
  // the nearest such ancestor says where it is. The ancestor's own facts become "Contained in" rows of the element.
  const readContainerPacket = (reader, current, ancestorScope, anchorGeneration) => {
    let packet;
    try {
      packet = reader.query(current, { scope: ancestorScope, anchorGeneration });
    } catch {
      return null;
    }
    return packet?.version !== 1 || !(packet.facts ?? []).length ? null : packet;
  };
  const containerFacts = (packet, current, scope, depth) => {
    const refs = packet.sourceRefs ?? [];
    const facts = [];
    for (const fact of packet.facts) {
      if (fact.dimension === 'context') {
        facts.push({ ...fact, scope });
        continue;
      }
      const ref = refs.find((item) => (fact.sourceRefIds ?? []).includes(item.id));
      const binding =
        fact.binding ??
        (ref
          ? {
              kind: 'markup',
              key: 'markup:' + ref.id + ':' + (fact.region?.start ?? 0),
              name: (ref.name || 'Markup') + ' · ' + get(current, 'localName'),
            }
          : null);
      if (!binding) continue;
      facts.push({
        ...fact,
        id: 'container:' + fact.id,
        scope,
        dimension: 'enclosing',
        predicate: 'contains',
        binding,
        label: depth === 0 ? 'Directly inside this element' : 'Inside this element',
      });
    }
    return facts;
  };
  const containerProof = (node, scope, anchorGeneration) => {
    let current = parent(node);
    for (let depth = 0; current && depth < 64; depth++, current = parent(current)) {
      if (get(current, 'nodeType') !== 1) continue;
      const ancestorScope = getSelectionScope(current);
      for (const reader of provenanceReaders(get(get(current, 'ownerDocument'), 'defaultView'))) {
        const packet = readContainerPacket(reader, current, ancestorScope, anchorGeneration);
        if (!packet) continue;
        const facts = containerFacts(packet, current, scope, depth);
        if (facts.some((fact) => fact.dimension === 'enclosing'))
          return {
            version: 1,
            mode: packet.mode,
            scope,
            anchorGeneration,
            sourceRefs: packet.sourceRefs ?? [],
            facts,
            availability: [],
            limits: { truncated: Boolean(packet.limits?.truncated) },
          };
      }
    }
    return null;
  };
  // Elements that load a file, by the attribute that names it.
  const RESOURCE_ATTRIBUTES = {
    img: ['src'],
    script: ['src'],
    link: ['href'],
    source: ['src'],
    video: ['src', 'poster'],
    audio: ['src'],
    embed: ['src'],
    object: ['data'],
    input: ['src'],
    track: ['src'],
    use: ['href'],
    image: ['href'],
  };
  const pathKey = (pathname) => {
    let value = String(pathname ?? '');
    try {
      value = decodeURIComponent(value);
    } catch {
      /* A malformed escape keeps the raw path, as the overlay does. */
    }
    const lowered = value.toLowerCase();
    let end = lowered.length;
    while (end > 0 && lowered[end - 1] === '/') end--;
    return lowered.slice(0, end) || '/';
  };
  let compiledRules = null,
    compiledFrom = null;
  const platformRuleOf = (address) => {
    if (compiledFrom !== d.platformRules) {
      compiledFrom = d.platformRules;
      compiledRules = (d.platformRules ?? []).flatMap((rule) => {
        try {
          return [{ ...rule, path: new RegExp(rule.source, rule.flags) }];
        } catch {
          return [];
        }
      });
    }
    const cdn = Boolean(d.platformCdnOrigin) && address.origin === d.platformCdnOrigin;
    if (address.origin !== location.origin && !cdn) return null;
    // A website-language segment in front of a platform path is not part of the path the rule names.
    const first = address.pathname.split('/')[1]?.toLowerCase();
    const pathname =
      !cdn && first && (d.languageCodes ?? []).includes(first)
        ? address.pathname.slice(first.length + 1) || '/'
        : address.pathname;
    for (const rule of compiledRules ?? []) {
      if (cdn && !rule.cdn) continue;
      if (!rule.path.test(pathname)) continue;
      const name =
        rule.platform === 'bundle'
          ? address.pathname
              .replace(/^\/resource\/powerappsportal\//i, '')
              .replace(/^\/?dist\//i, '')
              .replace(/[-.][0-9a-f]{6,}(?=\.[a-z0-9]+$)/i, '') || 'bundle'
          : rule.platform;
      return { class: rule.class, platform: name };
    }
    return null;
  };
  // What a loading element loads: a web file of the export (the address resolves to it as the overlay resolves
  // it), a file of the portal runtime, or a file of another site.
  const resourceAddress = (node) => {
    const names = RESOURCE_ATTRIBUTES[get(node, 'localName')];
    if (!names) return null;
    if (
      get(node, 'localName') === 'link' &&
      !/\b(?:stylesheet|icon|preload|modulepreload|prefetch|manifest)\b/i.test(get(node, 'rel'))
    )
      return null;
    if (get(node, 'localName') === 'input' && get(node, 'type') !== 'image') return null;
    let value = get(node, 'localName') === 'img' ? get(node, 'currentSrc') : '';
    for (const name of names) value ||= call(node, 'getAttribute', name) ?? '';
    if (!value) return null;
    let address;
    try {
      address = new URL(value, get(get(node, 'ownerDocument'), 'baseURI'));
    } catch {
      return null;
    }
    return /^https?:$/.test(address.protocol) ? address : null;
  };
  // A file of the export's web files or of a code component the page's address names; null when it names none.
  const localResourceOwner = (address, fact) => {
    const key = pathKey(address.pathname);
    const assets = (report?.assets ?? []).filter((item) => pathKey(item.url) === key);
    // A file a code component's manifest declares (lense/pcf-resources.mjs): the component owns it, and the
    // declared file is its source.
    if (assets.length === 1 && String(assets[0].componentKey ?? '').startsWith('pcf:')) {
      const name = assets[0].schemaName ?? assets[0].componentKey.slice(4);
      return {
        webFile: true,
        sourceFile: assets[0].sourceFile,
        fact: fact({ kind: 'pcf', key: assets[0].componentKey, name }, 'Loads a file of this code component'),
      };
    }
    if (assets.length === 1) {
      // A web file record is named by its id; one without an id (a hand-written export) by its address.
      const id = norm(assets[0].recordId ?? assets[0].id ?? '');
      return {
        webFile: true,
        fact: fact(
          {
            kind: 'web-file',
            key: id ? 'web-file:' + id : 'web-file:url:' + key,
            ...(id ? { id } : {}),
            name: assets[0].name ?? assets[0].url,
          },
          'Loads this web file',
        ),
      };
    }
    return null;
  };
  const resourceOwner = (node, scope) => {
    const address = resourceAddress(node);
    if (!address) return null;
    const fact = (binding, label) => ({
      id: 'resource:' + binding.key,
      scope,
      dimension: 'owner',
      proof: 'resource-url',
      subject: 'selection',
      predicate: 'identity',
      binding,
      label,
    });
    if (address.origin === location.origin) {
      const local = localResourceOwner(address, fact);
      if (local) return local;
    }
    const rule = platformRuleOf(address);
    if (rule)
      return {
        fact: fact(
          {
            kind: rule.class === 'platform-asset' ? 'platform-asset' : 'portal-endpoint',
            key: rule.class + ':' + rule.platform,
            name: rule.platform,
          },
          'Loads a file of the portal itself',
        ),
      };
    if (address.origin !== location.origin)
      return {
        fact: fact(
          { kind: 'external-resource', key: 'external-resource:' + address.origin, name: address.host },
          'Loads a file from another site',
        ),
      };
    return null;
  };
  /* NOSONAR */ const queryElementEvidence = (node, b, matches, scope) => {
    const anchorGeneration = host.__px?.selectionState?.().anchorGeneration ?? 0;
    const packets = [],
      reasons = [];
    const view = get(get(node, 'ownerDocument'), 'defaultView');
    const slots = [d.provenanceSlot, d.provenance?.slot].filter(Boolean);
    const readers = [
      ...(d.modelDriven ? [view?.__paqviloModelDrivenProvider] : []),
      ...slots.map((slot) => view?.[slot]),
      ...(d.domProvenanceSlot ? [view?.[d.domProvenanceSlot]] : []),
    ];
    for (const reader of new Set(readers.filter(Boolean))) {
      try {
        const query = reader.query;
        if (typeof query !== 'function') continue;
        const packet = query(node, { scope, anchorGeneration });
        const after = getSelectionScope(node);
        if (
          packet?.version !== 1 ||
          packet.scope?.documentId !== scope.documentId ||
          packet.scope?.frameId !== scope.frameId ||
          packet.scope?.uiEpoch !== scope.uiEpoch ||
          packet.scope?.sourceRevision !== scope.sourceRevision ||
          packet.anchorGeneration !== anchorGeneration ||
          JSON.stringify(after) !== JSON.stringify(scope)
        ) {
          reasons.push('provider-scope-changed');
          continue;
        }
        packets.push(packet);
      } catch {
        reasons.push('provider-read-unavailable');
      }
    }
    if (
      !d.modelDriven &&
      !packets.some((packet) =>
        (packet.facts ?? []).some((fact) =>
          /^(?:render-|served-|lense-applied-|binding-conflict)/.test(fact.kind ?? ''),
        ),
      )
    ) {
      const inherited = containerProof(node, scope, anchorGeneration);
      if (inherited) packets.push(inherited);
    }
    const index = sourceEvidenceIndex();
    if (!report?.modelDriven) {
      try {
        packets.push(
          observePortalNode(node, {
            scope,
            bindings: {
              ...b,
              forms: b.exportedForms,
              lists: b.exportedLists,
              views: report?.views ?? [],
              columns: report?.columns ?? b.fields,
              quickForms: (report?.nativeComponents ?? []).filter((component) => component.kind === 'quickform'),
              subgrids: (report?.nativeComponents ?? []).filter((component) => component.kind === 'subgrid'),
              codeComponents: report?.codeComponents ?? [],
              // The components the web page record names; the portal renders them under generic wrapper IDs.
              pageDocument: document,
              pageFormId: report?.page?.entityFormId ?? report?.page?.basicFormId,
              pageWebFormId: report?.page?.webFormId ?? report?.page?.advancedFormId,
              pageListId: report?.page?.listId,
              mirage: Boolean(d.mirageMode),
            },
            sourceRefs: index.rows,
            sourceRefsByComponent: index.byComponent,
          }),
        );
      } catch {
        reasons.push('portal-structure-unavailable');
      }
    }
    const facts = packets.flatMap((packet) =>
      [...(packet.facts ?? []), ...(packet.contextFacts ?? []).map((fact) => ({ ...fact, dimension: 'context' }))].map(
        (fact) => ({
          ...fact,
          sourceRefBindings: (packet.sourceRefs ?? [])
            .filter((ref) => (fact.sourceRefIds ?? []).includes(ref.id))
            .map((ref) => ({ id: ref.id, sourceRevision: ref.sourceRevision, contentRevision: ref.contentRevision })),
        }),
      ),
    );
    // Enclosing components named by the report carry their exported definition files like observed ones do.
    const linkedRefs = [];
    // The row opens its first file, so the record's definition leads: its definition ref, else the file that holds
    // its name (a web page's .webpage.yml). Content files such as the page copy are listed under Page files.
    const definitionFirst = (ref) => {
      if (ref.relationship === 'definition') return 0;
      return ref.fieldPath?.[0] === 'name' ? 1 : 2;
    };
    const linked = (fact, sourceFile) => {
      const key = fact.binding.kind + ':' + norm(fact.binding.id);
      // One file once: a record's name and copy fields live in the same file, and the row opens its first one.
      const files = new Set();
      // A loaded file leads the refs of its component: the row opens the file the element loads.
      const loaded = typeof sourceFile === 'string' ? sourceFile.replaceAll('\\', '/').toLowerCase() : '';
      const isLoaded = (ref) =>
        Boolean(loaded && ref.ref) &&
        (loaded === ref.ref.toLowerCase() || loaded.endsWith('/' + ref.ref.toLowerCase()));
      const refs = [
        ...(index.byComponent.get(fact.binding.key) ?? index.byComponent.get(key) ?? index.byRecord.get(key) ?? []),
      ]
        .sort((a, b) => Number(isLoaded(b)) - Number(isLoaded(a)) || definitionFirst(a) - definitionFirst(b))
        .filter((ref) => !files.has(ref.ref) && files.add(ref.ref));
      linkedRefs.push(...refs);
      return {
        ...fact,
        sourceRefIds: refs.map((ref) => ref.id),
        sourceRefBindings: refs.map((ref) => ({
          id: ref.id,
          sourceRevision: ref.sourceRevision,
          contentRevision: ref.contentRevision,
        })),
      };
    };
    const resource = d.modelDriven ? null : resourceOwner(node, scope);
    if (resource) facts.push(resource.webFile ? linked(resource.fact, resource.sourceFile) : resource.fact);
    if (!d.modelDriven && !facts.some((fact) => fact.dimension === 'owner' || fact.dimension === 'source')) {
      const doc = get(node, 'ownerDocument');
      const root = node === get(doc, 'documentElement') || node === doc.head || node === doc.body;
      const named = packets.some((packet) => packet.published === true);
      // A document that is not a page of markup (a JSON or text response a web template writes): what the browser
      // shows of it is that response. The template of the page is what wrote it.
      const writer =
        doc === document && !/html/i.test(doc.contentType ?? 'text/html')
          ? (report?.webTemplates ?? []).find((item) =>
              (item.includedBy ?? item.usedBy ?? []).some((owner) => owner.startsWith('page-template:')),
            )
          : null;
      if (writer?.id)
        facts.push(
          linked({
            id: 'page-output:' + norm(writer.id),
            scope,
            dimension: 'owner',
            proof: 'page-output',
            subject: 'selection',
            predicate: 'identity',
            binding: { kind: 'webtemplate', key: 'webtemplate:' + norm(writer.id), id: writer.id, name: writer.name },
            label: 'The browser shows the response this template writes',
          }),
        );
      // The html, head or body of a document whose own tags are all named, without a name of its own: the document
      // does not write that tag, the browser adds it.
      else if (root && named)
        facts.push({
          id: 'implied:' + get(node, 'localName'),
          scope,
          dimension: 'owner',
          proof: 'implied-element',
          subject: 'selection',
          predicate: 'identity',
          binding: { kind: 'platform-shell', key: 'platform-shell:implied', name: 'Added by the browser' },
          label: 'The page does not write this tag: the browser adds it',
        });
    }
    if (
      facts.some(
        (fact) =>
          fact.dimension === 'owner' &&
          fact.binding &&
          fact.binding.kind !== 'platform-shell' &&
          NAMING_PROOFS.has(fact.proof ?? fact.kind),
      )
    )
      for (const fact of facts)
        if (fact.dimension === 'owner' && fact.binding?.kind === 'platform-shell') fact.dimension = 'context';
    // The renderer's own statement of what it wrote for this element (a field of a form, a part of a list) is the
    // most specific one. What the page structure says besides it (the form the element stands in, the list around
    // it) is where the element is, not a second answer to what it is.
    const rendered = facts.find(
      (fact) =>
        fact.dimension === 'owner' &&
        (fact.proof ?? fact.kind) === 'render-platform' &&
        fact.binding &&
        fact.binding.kind !== 'platform-shell',
    );
    // Only a container (a form, list, view, table, subgrid and the like, or a part of one) becomes where the element
    // stands; a different column, field or code component is a second answer to what it is: an owner conflict.
    if (rendered)
      for (const fact of facts)
        if (
          fact !== rendered &&
          fact.dimension === 'owner' &&
          fact.binding &&
          fact.binding.key !== rendered.binding.key &&
          CONTAINER_KINDS.has(fact.binding.kind) &&
          NAMING_PROOFS.has(fact.proof ?? fact.kind) &&
          (fact.proof ?? fact.kind) !== 'resource-url'
        ) {
          fact.dimension = 'enclosing';
          fact.predicate = 'contains';
        }
    const hostPage = report?.page;
    if (!d.modelDriven && (hostPage?.id ?? hostPage?.recordId) && liveNode(node))
      facts.push(
        linked({
          id: 'selected-export-host-page',
          scope,
          dimension: 'enclosing',
          proof: 'export-definition',
          subject: 'selection',
          predicate: get(node, 'ownerDocument') === document ? 'configured-webpage' : 'webpage-hosting-selected-frame',
          binding: {
            kind: 'webpage',
            key: 'webpage:' + (hostPage.id ?? hostPage.recordId),
            id: hostPage.id ?? hostPage.recordId,
            name: hostPage.name ?? 'Web page',
          },
          label:
            get(node, 'ownerDocument') === document ? 'Web page of this address' : 'Web page that hosts this frame',
        }),
      );
    const hydratedCurrentSourceRefs = hydrateModelSelection(node, scope, anchorGeneration, packets);
    const sourceRefs = packets.flatMap((packet) => packet.sourceRefs ?? []);
    const mode = packets.some((packet) => packet.mode === 'local') || d.mirageMode ? 'local' : 'live';
    // The files saved since this page loaded: a source the page shows is outdated only when it is one of them.
    const changedFiles = !d.modelDriven && Array.isArray(d.pending) ? d.pending : undefined;
    // Files the portal serves in another version than the baseline (the checkout is ahead of it, or behind it).
    const servedDiffers = (d.served?.files ?? []).filter((file) => file.state === 'differs').map((file) => file.rel);
    const initial = resolveInspectionEvidence({
      version: 1,
      scope,
      mode,
      node: { connected: liveNode(node) },
      facts,
      sourceRefs,
      changedFiles,
      servedDiffers,
    });
    const anchors = packets.flatMap((packet) => packet.componentAnchors ?? []);
    selectionAnchors.set(node, anchors);
    if (
      !d.modelDriven &&
      node === selected &&
      (initial.owner.status === 'unavailable' || initial.source.status === 'unavailable') &&
      ((get(node, 'ownerDocument') !== document &&
        call(node, 'matches', 'input:not([type=hidden]):not([type=password]),select,textarea,output,label') &&
        initial.enclosing.some((row) => row.component?.kind === 'table')) ||
        (b.grid?.table && b.grid?.name))
    ) {
      const key = JSON.stringify([scope, anchorGeneration]);
      if (!portalHydrations.has(key)) {
        if (portalHydrations.size >= 32) portalHydrations.delete(portalHydrations.values().next().value);
        portalHydrations.add(key);
        queueMicrotask(() => {
          if (
            !disposed &&
            selected === node &&
            liveNode(node) &&
            JSON.stringify(getSelectionScope(node)) === JSON.stringify(scope)
          )
            dispatch('refresh');
        });
      }
    }
    // Legacy metadata is useful search context. It cannot label itself runtime proof.
    if (initial.owner.status !== 'exact' && initial.owner.status !== 'conflicting') {
      for (const item of b.fields ?? [])
        facts.push({
          id: 'column-candidate:' + item.entity + ':' + item.name,
          scope,
          dimension: 'owner',
          proof: 'native-dom',
          subject: 'selection',
          predicate: 'identity',
          binding: {
            kind: 'field',
            key: 'column:' + item.entity + ':' + item.name,
            entity: item.entity,
            name: item.name,
          },
        });
      if (!b.fields?.length && b.grid?.name)
        facts.push({
          id: 'unresolved-grid-column',
          scope,
          dimension: 'owner',
          proof: 'native-dom',
          subject: 'selection',
          predicate: 'identity',
          binding: {
            kind: 'column',
            key: 'column:' + (b.entity ?? b.grid.table ?? 'unknown') + ':' + b.grid.name,
            entity: b.entity ?? b.grid.table,
            name: b.grid.name,
          },
          reason: 'column-definition-unavailable',
        });
      for (const item of b.code ?? [])
        facts.push({
          id: 'pcf-candidate:' + (item.schemaName ?? item.name),
          scope,
          dimension: 'owner',
          proof: 'declared-include',
          subject: 'selection',
          predicate: 'identity',
          binding: { kind: 'pcf', key: 'pcf:' + (item.schemaName ?? item.name), name: item.schemaName ?? item.name },
        });
    }
    if (b.conflict)
      facts.push({
        id: 'legacy-context-conflict',
        scope,
        dimension: 'context',
        kind: 'api-page-context',
        reason: 'legacy-context-disagreement',
        label: 'The page address and the markup point to different components.',
      });
    for (const item of [...(b.forms ?? []), ...(b.views ?? []), ...(b.lists ?? [])]) {
      if (
        facts.some(
          (fact) =>
            ['owner', 'enclosing'].includes(fact.dimension) &&
            fact.proof !== 'declared-include' &&
            norm(fact.binding?.id ?? fact.binding?.recordId) === norm(item.id ?? item.recordId),
        )
      )
        continue;
      // The open model-driven form is identified by the app (or Mirage) by its form ID: it is the form of this page,
      // not one the configuration merely declares. Its kind and key are the Solution's, so its files and the provider's
      // context name the same component.
      const kind = item.kind === 'model-driven-form' ? 'form' : (item.kind ?? 'form');
      const identified = { 'mirage-form-id': 'mirage-registry', 'native-form-id': 'native-api' }[item.evidence];
      facts.push(
        linked({
          id: 'enclosing-candidate:' + (item.id ?? item.recordId),
          scope,
          dimension: 'enclosing',
          proof: identified ?? 'declared-include',
          predicate: identified ? 'contains' : 'declares',
          ...(identified ? { label: item.evidenceLabel ?? 'Form open on this page' } : {}),
          binding: {
            kind,
            key: kind + ':' + (item.id ?? item.recordId),
            id: item.id ?? item.recordId,
            name: item.name,
            entity: item.entity,
          },
        }),
      );
    }
    for (const [position, item] of matches.entries()) {
      const field =
        item.sourceField ??
        (Array.isArray(item.fieldPath) ? item.fieldPath.at(-1) : item.fieldPath) ??
        { template: 'source', snippet: 'value', page: 'copy' }[item.kind];
      const logicalField = (value) =>
        String(value ?? '')
          .replace(/^(?:adx_|mspp_)/, '')
          .toLowerCase();
      const referenced = item.sourceRefId ? index.byId.get(item.sourceRefId) : null;
      const semantic = (item.ref ? (index.byRef.get(item.ref) ?? []) : []).filter(
        (ref) =>
          (!item.recordId || norm(ref.recordId) === norm(item.recordId)) &&
          (!field || logicalField(ref.fieldPath?.at(-1)) === logicalField(field)) &&
          (!item.languageId || norm(ref.languageId) === norm(item.languageId)) &&
          (item.lcid === undefined || ref.lcid === item.lcid),
      );
      // One file can contain thousands of unrelated records/fields/languages.
      // A filename never selects all of them as this node's candidate identity.
      let selected;
      if (referenced) selected = [referenced];
      else if (item.recordId && semantic.length === 1) selected = semantic;
      else selected = [];
      const refs = selected.length
        ? selected
        : [{ id: 'static:' + position, ref: item.ref, kind: item.kind, name: item.name }];
      sourceRefs.push(...refs);
      facts.push({
        id: 'static-match:' + position,
        scope,
        dimension: item.kind === 'script' ? 'context' : 'source',
        kind: item.kind === 'script' ? 'script-reference' : 'static-selector',
        predicate: item.kind === 'script' ? 'declares' : 'possible-markup',
        sourceRefIds: refs.map((ref) => ref.id),
        sourceRefBindings: refs.map((ref) => ({
          id: ref.id,
          sourceRevision: ref.sourceRevision,
          contentRevision: ref.contentRevision,
        })),
        label: item.evidenceLabel ?? 'Markup match',
      });
    }
    for (const packet of packets) {
      for (const availability of packet.availability ?? [])
        if (typeof availability.reason === 'string') reasons.push(availability.reason);
      for (const reason of packet.limits?.reasons ?? []) if (typeof reason === 'string') reasons.push(reason);
    }
    sourceRefs.push(...linkedRefs);
    const currentSourceRefs = [
      ...sourceRefs.map((ref) => index.byId.get(ref.id)).filter(Boolean),
      ...hydratedCurrentSourceRefs,
    ];
    const distinctRefs = [
      ...new Map(
        sourceRefs.map((ref) => [JSON.stringify([ref.id, ref.key, ref.contentRevision, ref.region]), ref]),
      ).values(),
    ];
    const sourceLimits = report?.elementSourceLimits ?? {};
    const omittedSources = (sourceLimits.markupOmittedSources ?? []).map((ref) => ({
      ref,
      reason: 'Skipped: file too large to search',
    }));
    const truncatedScripts = (sourceLimits.scriptTruncatedSources ?? []).map((ref) => ({
      ref,
      reason: 'Skipped: too many scripts to search',
    }));
    if (sourceLimits.truncated) reasons.push('export-source-hint-index-truncated');
    if (matches.omitted) reasons.push('additional-source-candidates-omitted');
    // A sign-in page reaches the browser exactly as the portal sent it (Lense never reads or marks it, so signing in
    // behaves as online): no element of it carries proof, and what is matched is matched by markup alone.
    try {
      const pageRule = platformRuleOf(new URL(location.href));
      if (pageRule && (pageRule.platform === 'sign-in' || pageRule.platform === 'external-sign-in'))
        reasons.push('sign-in-page-untouched');
    } catch {
      /* an address that cannot be read names no rule */
    }
    return resolveInspectionEvidence({
      version: 1,
      scope,
      mode,
      node: { connected: liveNode(node) },
      facts,
      sourceRefs: distinctRefs,
      currentSourceRefs,
      changedFiles,
      servedDiffers,
      limits: {
        truncated:
          Boolean(sourceLimits.truncated) ||
          packets.some((packet) => packet.limits?.truncated) ||
          candidateLimit ||
          Boolean(matches.omitted),
        reasons,
        sources: [...omittedSources, ...truncatedScripts],
        omitted: { markupSources: sourceLimits.markupOmittedSourceCount ?? 0, candidates: matches.omitted ?? 0 },
      },
    });
  };
  const identify = (node, scope = getSelectionScope(node)) => {
    const b = binding(node);
    const matched = sourceMatches(node);
    const matches = matched.map((item) => ({
      ...item,
      strong: false,
      evidenceLabel: item.evidenceLabel ?? 'Markup match',
    }));
    matches.omitted = matched.omitted;
    const evidence = queryElementEvidence(node, b, matches, scope);
    // Rows show a file by its path in the source folder, as Page files does (the panel renders this evidence too).
    if (typeof d.sourceDir === 'string' && d.sourceDir) evidence.sourceDir = d.sourceDir;
    // The field's display name travels with its component, so the panel names it as the card does.
    nameComponent(evidence.owner.component);
    for (const row of [...evidence.enclosing, ...evidence.candidates])
      if (row.component?.key?.includes('#')) nameComponent(row.component);
    const owner = evidence.owner.component;
    const exact = evidence.source.refs.find((ref) => ref.status === 'exact');
    const candidate = evidence.candidates.find((item) => item.status === 'candidate')?.component;
    // A likely file with no component: the hover tip and the card say the same, as the card's source row does.
    const likelyRef = owner || exact ? null : evidence.source.refs.find((ref) => ref.status === 'candidate');
    const likely = Boolean(likelyRef);
    // One header format in the hover summary, the card and the panel: "display name · logical name" for a component,
    // "file · tag" for an element only a file names (so Parent and Child change it), else the tag alone. Only the tag:
    // element IDs and classes can carry record data, and the title travels with selection events.
    const ownerNames = owner ? [...new Set([owner.label ?? columnLabel(owner), owner.name].filter(Boolean))] : [];
    // A component with one name (a web template the render identified) adds the tag, as a file match does: the title
    // stays the same when the render's own proof arrives after the file match, and Parent and Child change it.
    const ownerName = ownerNames.length === 1 ? ownerNames[0] + ' · ' + get(node, 'localName') : ownerNames.join(' · ');
    const fileName = (exact ?? likelyRef)?.name;
    // No proof of its own, inside an element that has one: named by where it stands. Only when nothing names the
    // element: a conflicting, likely or outdated owner shows as itself, never hidden behind the container's answer.
    const container =
      owner || exact || evidence.owner.status !== 'unavailable'
        ? null
        : evidence.enclosing.find(
            (row) =>
              row.status === 'exact' &&
              (row.evidence ?? []).some((item) => typeof item.id === 'string' && item.id.startsWith('container:')),
          );
    let title;
    if (ownerName || owner?.id) title = ownerName || owner.id;
    else if (container)
      title =
        'Inside ' +
        (container.component?.label ?? container.component?.name ?? kindName(container.component?.kind)) +
        ' · ' +
        get(node, 'localName');
    else if (fileName) title = fileName + ' · ' + get(node, 'localName');
    else if (candidate)
      title =
        'Possible ' +
        (candidate.label ?? candidate.name ?? kindName(candidate.kind).toLowerCase()) +
        ' · ' +
        get(node, 'localName');
    else title = get(node, 'localName') + ' element';
    return {
      title,
      // The one place the card states the selection's certainty; the rows below carry their own.
      kind: (() => {
        if (owner) return kindName(owner.kind);
        if (evidence.source.status === 'exact') return 'Source file';
        if (container) return 'Inside a known element';
        if (likely && evidence.owner.status === 'unavailable') return 'Likely source file';
        return (
          {
            conflicting: 'Several matches',
            candidate: 'Likely match',
            stale: 'Outdated: select again',
          }[evidence.owner.status] ??
          (evidence.source.refs.length ? 'No matching component' : 'Not matched to any source')
        );
      })(),
      // The file the person most likely wants next, when no component names the element: its name only, the card
      // shows the path.
      sub: owner
        ? [owner.entity, owner.field ?? owner.controlName].filter(Boolean).join('.')
        : kit.displayPath(((exact ?? evidence.source.refs[0])?.ref ?? '').split(/[\\/]/).pop()),
      matched: Boolean(owner || exact || candidate || likely || container),
      contained: Boolean(container),
      b,
      matches,
      evidence,
    };
  };
  const selectionIdentity = (node, scope = node ? getSelectionScope(node) : null) => {
    if (!node) return null;
    const found = identify(node, scope),
      owner = found.evidence.owner;
    const exact = owner.status === 'exact';
    return {
      title: found.title,
      kind: found.kind,
      sub: found.sub,
      evidence: found.evidence,
      fields:
        exact && ['field', 'column'].includes(owner.component.kind)
          ? (report?.columns ?? []).filter(
              (item) =>
                norm(item.entity) === norm(owner.component.entity) &&
                norm(item.name) === norm(owner.component.field ?? owner.component.name),
            )
          : [],
      forms:
        exact && /form/.test(owner.component.kind)
          ? found.b.forms.filter((item) => norm(item.id) === norm(owner.component.id))
          : [],
      views:
        exact && owner.component.kind === 'view'
          ? found.b.views.filter((item) => norm(item.id) === norm(owner.component.id))
          : [],
      lists:
        exact && owner.component.kind === 'list'
          ? found.b.lists.filter((item) => norm(item.id ?? item.recordId) === norm(owner.component.id))
          : [],
      sources: found.evidence.source.refs.filter((ref) => ref.status === 'exact'),
    };
  };
  /* NOSONAR */ const declaredContextHtml = (node, b, evidence) => {
    let out = '';
    if (call(node, 'matches', 'img[src],img[srcset],link[href],script[src]')) {
      let pathname;
      try {
        const value =
          get(node, 'localName') === 'img'
            ? node.currentSrc || call(node, 'getAttribute', 'src')
            : (call(node, 'getAttribute', 'src') ?? call(node, 'getAttribute', 'href'));
        const address = new URL(value, get(get(node, 'ownerDocument'), 'baseURI'));
        if (address.origin === location.origin) pathname = address.pathname;
      } catch {
        /* A foreign or malformed resource is not a local definition. */
      }
      const assets = (report?.assets ?? []).filter((item) => item.url === pathname);
      if (assets.length)
        out +=
          '<details open data-disclosure="selected-resource"><summary>Linked file</summary>' +
          sourceRows(assets) +
          '</details>';
    }
    const events = (b.forms ?? []).flatMap((form) => (form.events ?? []).map((event) => ({ ...event, form })));
    const definitionRows = [
      ...(b.forms ?? []).flatMap((form) =>
        [form, form.formXml && { kind: 'FormXml', ...form.formXml }].filter(Boolean),
      ),
      ...(b.views ?? []),
      ...(b.lists ?? []),
    ];
    // Forms and views the details above already list (with open and copy) are not repeated here.
    const listed = new Set(
      [evidence?.owner?.component, ...(evidence?.enclosing ?? []).map((row) => row.component)]
        .map((component) => norm(component?.id ?? component?.recordId ?? ''))
        .filter(Boolean),
    );
    const definitions = [
      ...new Map(
        definitionRows
          .filter((item) => !listed.has(norm(item.id ?? item.recordId ?? '')))
          .map((item) => [
            JSON.stringify([item.ref ?? null, item.id ?? item.recordId ?? item.name, item.kind ?? null]),
            item,
          ]),
      ).values(),
    ];
    if (definitions.length)
      out +=
        '<details data-disclosure="declared-form-definitions"><summary>Forms and views on this page</summary>' +
        sourceRows(definitions) +
        '</details>';
    const commands = b.commands ?? [];
    if (events.length || commands.length)
      out +=
        '<details data-disclosure="declared-handlers"><summary>Event handlers and commands</summary>' +
        events
          .map((event) =>
            renderInspectionEvidence(null, {
              part: 'row',
              context: 'xray',
              row: {
                cls: 'source',
                name:
                  event.form.name +
                  ' · ' +
                  event.name +
                  (event.attribute ? ' · ' + event.attribute : '') +
                  (event.active === false ? ' (disabled)' : ''),
                subs: (event.handlers ?? []).map(
                  (handler) =>
                    (handler.enabled === false ? '[disabled] ' : '') + handler.library + ': ' + handler.functionName,
                ),
              },
            }),
          )
          .join('') +
        commands
          .map(
            (command) =>
              sourceRows([{ ...command, name: command.label ?? command.id, ref: command.source }], 'Command') +
              '<p class="mono">' +
              (command.actions ?? []).map((action) => esc(action.library + ': ' + action.functionName)).join('<br>') +
              '</p>',
          )
          .join('') +
        '</details>';
    if (b.native?.length)
      out +=
        '<details data-disclosure="declared-native"><summary>Subgrids and quick views</summary>' +
        b.native
          .map(
            (item) =>
              '<dl class="details"><dt>Control</dt><dd>' +
              esc(item.name ?? item.id) +
              '</dd><dt>Form</dt><dd>' +
              esc(item.owner ?? item.formName ?? item.formId ?? 'Not found') +
              '</dd>' +
              (item.relationship ? '<dt>Relation</dt><dd>' + esc(item.relationship) + '</dd>' : '') +
              '</dl>' +
              sourceRows([{ ...item, name: kindName(item.kind) + ' definition' }, ...(item.metadataSources ?? [])]),
          )
          .join('') +
        '</details>';
    const codeHtml = (items) =>
      items
        .map((item) => {
          const parameters = Object.entries(item.parameters ?? {});
          const properties = item.properties ?? [];
          return (
            '<dl class="details"><dt>Schema</dt><dd>' +
            esc(item.schemaName ?? item.name) +
            '</dd><dt>Binding</dt><dd>' +
            esc(bindingLabel(item.binding)) +
            '</dd>' +
            (item.entity ? '<dt>Table</dt><dd>' + esc(item.entity) + '</dd>' : '') +
            (item.field ? '<dt>Column</dt><dd>' + esc(item.field) + '</dd>' : '') +
            (item.enablement ? '<dt>Portal</dt><dd>' + esc(item.enablement) + '</dd>' : '') +
            '</dl>' +
            sourceRows(
              [
                { ...item, name: item.schemaName ?? item.name },
                item.formSource,
                ...(item.metadataSources ?? []),
              ].filter(Boolean),
            ) +
            (properties.length
              ? '<details><summary>Manifest properties ' +
                countPill(properties.length) +
                '</summary>' +
                properties
                  .map(
                    (property) =>
                      '<div class="note"><b>' +
                      esc(property.name) +
                      '</b> · ' +
                      esc(property['of-type'] ?? property['of-type-group'] ?? 'type not set') +
                      ' · ' +
                      esc(property.usage ?? 'input') +
                      (property.required === 'true' || property.required === true ? ' · required' : '') +
                      '</div>',
                  )
                  .join('') +
                '</details>'
              : '') +
            (parameters.length
              ? '<dl class="details">' +
                parameters
                  .map(
                    ([name, parameter]) =>
                      '<dt>' + esc(name) + '</dt><dd>' + esc(parameterDescription(parameter)) + '</dd>',
                  )
                  .join('') +
                '</dl>'
              : '') +
            sourceRows(item.resources ?? [], 'Component file') +
            (item.datasets ?? [])
              .map(
                (dataset) =>
                  '<div class="binding"><strong>' +
                  esc(dataset.name) +
                  '</strong><p class="note">' +
                  esc(
                    dataset.resolved
                      ? [dataset.entity, dataset.viewName, `${dataset.fields?.length ?? 0} columns`]
                          .filter(Boolean)
                          .join(' · ')
                      : 'Table or view not found',
                  ) +
                  '</p></div>' +
                  sourceRows([dataset]),
              )
              .join('')
          );
        })
        .join('');
    if (b.code?.length)
      out +=
        '<details data-disclosure="declared-pcf"><summary>Code component settings</summary>' +
        codeHtml(b.code) +
        '</details>';
    else if (report?.codeComponents?.length)
      out +=
        '<details class="pcf-context" data-disclosure="pcf-context"><summary>Page code components ' +
        countPill(report.codeComponents.length) +
        '</summary>' +
        pageRows('pcf', report.codeComponents, codeHtml) +
        '</details>';
    const api = (report?.apiReferences ?? []).filter((item) => !b.entity || norm(item.entity) === norm(b.entity));
    if (api.length)
      out +=
        '<details class="api-context" data-disclosure="api-context"><summary>Web API calls ' +
        countPill(api.length) +
        '</summary>' +
        pageRows('api', api, (items) =>
          items
            .map(
              (item) =>
                '<div class="binding"><strong>/_api/' +
                esc(item.name) +
                '</strong><p class="note">' +
                esc(item.entity ?? 'Table not found') +
                ' · ' +
                (item.evidence === 'observed-api-request' ? 'Requested by this page' : 'Referenced in source code') +
                '</p></div>' +
                sourceRows([item, ...(item.sources ?? [])]) +
                // A table's permission rules page like other context, once per table.
                pageRows(
                  'api-permissions:' + norm(item.entity),
                  (report?.permissionRules ?? []).filter(
                    (rule) => item.entity && norm(rule.entity) === norm(item.entity),
                  ),
                  (rules) =>
                    sourceRows(
                      /* NOSONAR: callbacks capture request-scoped state */ rules.map((rule) => ({
                        ...rule,
                        kind: 'permission',
                        evidenceLabel: rule.scope + (rule.effective ? ' · ' + rule.effective : ''),
                      })),
                    ),
                ),
            )
            .join(''),
        ) +
        '</details>';
    const page = report?.page;
    if (report)
      out +=
        '<details class="page-context" data-disclosure="page-context"><summary>Page files' +
        (page ? ' · ' + esc(page.pageName ?? page.name ?? '') : '') +
        '</summary>' +
        // A model-driven page has no web page or page template: its files are the form, view and table.
        (report.modelDriven
          ? ''
          : '<dl class="details"><dt>Page</dt><dd>' +
            esc(page?.pageName ?? page?.name ?? 'Not in your sources') +
            '</dd><dt>Template</dt><dd>' +
            esc(page?.pageTemplateName ?? report.pageTemplate?.name ?? 'None found') +
            '</dd></dl>') +
        pageRows('page-sources', report.pageSources ?? [], (rows) => sourceRows(rows)) +
        pageRows('page-assets', report.assets ?? [], (rows) => sourceRows(rows)) +
        pageRows('page-templates', report.webTemplates ?? [], (rows) =>
          sourceRows(rows.map((item) => ({ ...item, kind: 'template' }))),
        ) +
        '</details>';
    return out;
  };
  const sourcesHtml = (node) => {
    const found = identify(node),
      matches = found.matches;
    const markup = matches.filter((item) => item.kind !== 'script');
    const scripts = matches.filter((item) => item.kind === 'script');
    return (
      renderInspectionEvidence(found.evidence, { context: 'xray' }) +
      (markup.length
        ? '<details data-disclosure="static-candidates"><summary>Markup matches ' +
          countPill(markup.length) +
          '</summary><p class="note">Files whose markup matches this element\'s ID or classes. Check before you edit.</p>' +
          pageRows('markup-candidates', markup, (rows) => sourceRows(rows)) +
          '</details>'
        : '') +
      (scripts.length
        ? '<details data-disclosure="declared-scripts"><summary>Script references ' +
          countPill(scripts.length) +
          '</summary>' +
          pageRows('script-candidates', scripts, (rows) => sourceRows(rows)) +
          '</details>'
        : '') +
      declaredContextHtml(node, found.b, found.evidence)
    );
  };
  /* NOSONAR */ const renderCard = (preserve = false, measuredRect) => {
    if (!enabled) return;
    if (!statusCurrent(statusSelection)) {
      statusMessage = '';
      statusSelection = null;
    }
    // details.toggle is queued by the browser; capture the actual disclosure
    // state before replacing a card, even if the next pick arrives first.
    for (const item of call(card, 'querySelectorAll', 'details[data-disclosure]'))
      disclosureState.set(item.dataset.disclosure, item.open);
    // Read portal geometry before revealing or rebuilding the overlay. Otherwise
    // the first selection synchronously lays out both the old and new card.
    const selectedRect = selected
      ? (measuredRect ?? visibleRect(selected) ?? call(selected, 'getBoundingClientRect'))
      : null;
    renderProgress();
    const focused =
      preserve && root.activeElement && call(card, 'contains', root.activeElement)
        ? { ...root.activeElement.dataset }
        : null;
    const feedback = preserve ? (call(card, 'querySelector', '.status')?.textContent ?? '') : '';
    const scroll = preserve ? (call(card, 'querySelector', '.content')?.scrollTop ?? 0) : 0,
      open = preserve
        ? [...card.querySelectorAll('details[open]')].map(
            (item) => item.dataset.disclosure ?? call(item, 'querySelector', 'summary')?.textContent,
          )
        : [];
    card.hidden = !details || !selected;
    if (!selected) {
      // A model-driven app has forms, views and columns; a portal also has templates.
      const app = Boolean(d.modelDriven || report?.modelDriven);
      const welcomeCounts = () => {
        if (report)
          return [
            app ? '' : `${(report.webTemplates ?? []).length} templates`,
            `${(report.forms ?? []).length} forms`,
            `${(report.views ?? []).length} views`,
            `${(report.columns ?? []).length} columns`,
          ]
            .filter(Boolean)
            .join(' · ');
        return esc(
          d.inspectionError ||
            (d.inspection?.active === false ? d.inspection.error : '') ||
            'Loading source inspection…',
        );
      };
      card.innerHTML = `<div class="welcome"><div class="hero">${app ? 'Select an element of the app' : 'Select a portal element'}</div><p class="note">${app ? 'Hover or click to identify its form, field, view, table or code component.' : 'Hover or click to identify its template, page source, form, view or Dataverse column.'}</p><p class="note">Tap <kbd>Ctrl</kbd> or click <b>Inspect</b> to use the ${app ? 'app' : 'portal'} normally, and again to inspect. ${escHint}.</p><p class="note counts">${welcomeCounts()}</p></div>`;
      return;
    }
    const identity = identify(selected, getSelectionScope(selected));
    // A new pick places the card next to it again, also after the person moved the card for an earlier one.
    if (!preserve) cardMoved = false;
    // The header names the component once (display name and logical name) with its certainty badge.
    const heading = identity.title;
    // A frame the browser keeps closed to this page (cross-origin, sandboxed) cannot be entered by a click.
    let frameNote = '';
    const below = pierced?.generation === selectionGeneration ? pierced : null;
    if (get(selected, 'localName') === 'iframe') {
      const boundary = frameSettled(selected) && !frameDocument(selected);
      let note = boundary
        ? 'Frame outside Inspect: the browser keeps a cross-origin or sandboxed frame closed to this page, so its controls cannot be selected here; open the frame in its own tab to inspect it.'
        : 'Frame. Click inside it to select its controls. If that does not work, open the frame in its own tab.';
      if (boundary && below?.result?.element)
        note =
          'The browser keeps this frame closed to the page; Lense read the element under the pointer through the DevTools protocol, below.';
      frameNote =
        '<p class=note>' + note + '</p><button class="btn sec" data-action="frame-open">Open frame in new tab</button>';
    }
    card.innerHTML = `<div class="cardhead"><div class="grow"><div class="eyebrow">${esc(identity.kind)}</div><div class="titlerow"><div class="title">${esc(heading)}</div>${renderInspectionEvidence(identity.evidence, { part: 'badge' })}</div></div><button class="ib" data-action="dock" title="Move details to the other side" aria-label="Move details">${kit.icon('swap')}</button><button class="ib" data-action="clear" aria-label="Clear selection" title="Clear selection">${kit.icon('close')}</button></div><div class="content">${frameNote}${piercedHtml(below)}${sourcesHtml(selected)}<details class="ancestry"${identity.matched ? '' : ' open'}><summary>Parent elements</summary><div class="mono element-label">${esc(label(selected))}</div><p class="note">Select an enclosing element to inspect its source. [ and ] cycle overlapping elements.</p>${lineage(
      selected,
    )
      .map(
        (node, index) =>
          `<button class="crumb" data-action="ancestor" data-index="${index}" data-depth="${Math.min(index, 6)}">${esc(label(node))}</button>`,
      )
      .join(
        '',
      )}</details></div><div class="status" role="status">${esc(feedback)}</div><div class="foot"><button class="btn sec" data-action="parent" title="Select the enclosing element (Up arrow)" ${!parent(selected) || own(parent(selected)) ? 'disabled' : ''}>${kit.icon('up')}Parent</button><button class="btn sec" data-action="child" title="Select a child element: the one you came from, else the first (Down arrow)" ${!child(selected) ? 'disabled' : ''}>${kit.icon('down')}Child</button><button class="btn sec" data-action="reveal" title="Scroll the page to the selected element">${kit.icon('locate')}Reveal</button></div>`;
    // New content already starts at zero. Writing scrollTop=0 would force its first
    // layout during selection even though there is no scroll position to restore.
    call(card, 'querySelector', '.status').textContent = statusMessage;
    // Every disclosure gets the panel's group header.
    for (const summary of call(card, 'querySelectorAll', 'summary:not(.gh)')) {
      summary.classList.add('gh');
      summary.insertAdjacentHTML('afterbegin', kit.icon('right'));
    }
    for (const item of call(card, 'querySelectorAll', 'details'))
      if (disclosureState.has(item.dataset.disclosure)) item.open = disclosureState.get(item.dataset.disclosure);
      else if (open.includes(item.dataset.disclosure ?? call(item, 'querySelector', 'summary')?.textContent))
        item.open = true;
    const body = call(card, 'querySelector', '.content');
    if (body && scroll) body.scrollTop = scroll;
    if (focused)
      [...card.querySelectorAll('button,summary,select,input,a[href]')]
        .find((item) => Object.entries(focused).every(([key, value]) => item.dataset[key] === value))
        ?.focus({ preventScroll: true });
    placeCard(selectedRect, !preserve);
  };
  // The details card opens beside the selected element: right of it, else left, else below, else above, inside the
  // viewport and under the toolbar, so it never covers the element when any side has room. It follows the element on
  // scroll and resize; an element larger than every free side gets the card on the side with the most room.
  const placeCard = (rect, force = false) => {
    if (!rect || card.hidden || cardMoved || drag) return;
    // A clipped visible rectangle carries only its origin and size.
    const right = rect.left + rect.width,
      below = rect.top + rect.height;
    const key = `${rect.left},${rect.top},${rect.width},${rect.height},${innerWidth},${innerHeight}`;
    if (!force && key === cardPlacement) return;
    cardPlacement = key;
    const gap = 8,
      top = Math.min(64, Math.max(gap, innerHeight / 4)),
      // The legend sits along the bottom edge; the card stays above it.
      bottom = innerHeight - 44,
      // Under half of a narrow window, so the page stays readable beside it.
      width = Math.min(410, Math.max(340, innerWidth * 0.45), innerWidth - 2 * gap);
    card.style.width = width + 'px';
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    card.style.maxHeight = '';
    const height = Math.min(card.scrollHeight || card.offsetHeight, bottom - top);
    const clamp = (value, low, high) => Math.max(low, Math.min(value, Math.max(low, high)));
    const sides = [
      { room: innerWidth - gap - right - gap, need: width, x: right + gap, y: null },
      { room: rect.left - gap - gap, need: width, x: rect.left - gap - width, y: null },
      { room: bottom - below - gap, need: Math.min(height, 160), x: null, y: below + gap },
      { room: rect.top - gap - top, need: Math.min(height, 160), x: null, y: null },
    ];
    const side = sides.find((item) => item.room >= item.need) ?? [...sides].sort((a, b) => b.room - a.room)[0];
    if (side.x === null) {
      card.style.left = clamp(rect.left, gap, innerWidth - gap - width) + 'px';
      card.style.maxHeight = Math.max(160, side.room) + 'px';
      // Above the element the card hangs from its bottom edge, so a card shorter than the room stays next to it.
      if (side === sides[2]) card.style.top = clamp(side.y, top, bottom - 160) + 'px';
      else {
        card.style.top = 'auto';
        card.style.bottom = innerHeight - Math.max(top + 160, rect.top - gap) + 'px';
      }
    } else {
      card.style.left = clamp(side.x, gap, innerWidth - gap - width) + 'px';
      const y = clamp(rect.top, top, bottom - height);
      card.style.top = y + 'px';
      // A disclosure opened later grows the card down to the legend, not past the window.
      card.style.maxHeight = bottom - y + 'px';
    }
  };
  // Rectangles live outside portal layout. Clip to each scroll container without changing its CSS.
  /* NOSONAR: single-pass routine, splitting it would change shared state */ function visibleRect(node) {
    if (!liveNode(node) || own(node)) return null;
    if (geometryCache?.has(node)) return geometryCache.get(node);
    const style = styleFor(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    )
      return null;
    const doc = get(node, 'ownerDocument'),
      view = doc.defaultView;
    const rect = call(node, 'getBoundingClientRect');
    let left = Math.max(0, rect.left),
      top = Math.max(0, rect.top),
      right = Math.min(view.innerWidth, rect.right),
      bottom = Math.min(view.innerHeight, rect.bottom);
    if (!rect.width || !rect.height) return null;
    const establishesFixed = (css) =>
      css.transform !== 'none' ||
      css.perspective !== 'none' ||
      css.filter !== 'none' ||
      (css.backdropFilter && css.backdropFilter !== 'none') ||
      /layout|paint|strict|content/.test(css.contain) ||
      /transform|perspective|filter/.test(css.willChange);
    let escape = '';
    if (style.position === 'fixed') escape = 'fixed';
    else if (style.position === 'absolute') escape = 'absolute';
    for (const ancestor of lineage(parent(node)).filter((item) => get(item, 'ownerDocument') === doc)) {
      const css = styleFor(ancestor);
      if (css.display === 'none' || css.opacity === '0') return null;
      if (escape && (establishesFixed(css) || (escape === 'absolute' && css.position !== 'static'))) escape = '';
      if (!escape && ancestor !== doc.body && ancestor !== doc.documentElement) {
        const r = call(ancestor, 'getBoundingClientRect'),
          sx = r.width / ancestor.offsetWidth || 1,
          sy = r.height / ancestor.offsetHeight || 1;
        if (/hidden|clip|auto|scroll/.test(css.overflowX)) {
          left = Math.max(left, r.left + ancestor.clientLeft * sx);
          right = Math.min(right, r.left + (ancestor.clientLeft + ancestor.clientWidth) * sx);
        }
        if (/hidden|clip|auto|scroll/.test(css.overflowY)) {
          top = Math.max(top, r.top + ancestor.clientTop * sy);
          bottom = Math.min(bottom, r.top + (ancestor.clientTop + ancestor.clientHeight) * sy);
        }
      }
      // A positioned ancestor can itself escape clipping higher in the tree.
      if (css.position === 'fixed') escape = 'fixed';
      else if (css.position === 'absolute' && !escape) escape = 'absolute';
    }
    const embedding = frameOf(doc);
    if (embedding) {
      const outer = visibleRect(embedding);
      if (!outer) return null;
      // visibleRect(embedding) is in the top viewport; retain the unclipped origin.
      const origin = frameOrigin(embedding);
      left = Math.max(outer.left, origin.x + left * origin.sx);
      right = Math.min(outer.left + outer.width, origin.x + right * origin.sx);
      top = Math.max(outer.top, origin.y + top * origin.sy);
      bottom = Math.min(outer.top + outer.height, origin.y + bottom * origin.sy);
    }
    const result = right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
    geometryCache?.set(node, result);
    return result;
  }
  function frameOrigin(node) {
    const r = call(node, 'getBoundingClientRect'),
      sx = r.width / node.offsetWidth || 1,
      sy = r.height / node.offsetHeight || 1,
      outer = frameOf(get(node, 'ownerDocument'));
    const local = { x: r.left + node.clientLeft * sx, y: r.top + node.clientTop * sy, sx, sy };
    if (!outer) return local;
    const p = frameOrigin(outer);
    return { x: p.x + local.x * p.sx, y: p.y + local.y * p.sy, sx: sx * p.sx, sy: sy * p.sy };
  }
  // CSSOM geometry: a strict page CSP blocks style attributes parsed from markup.
  // What the outlines of the current view leave out, said in the legend: more elements in view than are searched, more
  // outlines than are drawn, frames and shadow roots that are not searched.
  const outlineLimits = { viewport: false, drawn: false, roots: 0 };
  const legendHint = () => {
    const notes = [];
    if (outlineLimits.viewport) notes.push('More than 800 elements in view: only 800 are searched for outlines');
    if (outlineLimits.drawn) notes.push('Only 250 outlines are drawn in this view: scroll or zoom in for the rest');
    if (outlineLimits.roots)
      notes.push(
        outlineLimits.roots === 1
          ? '1 frame or shadow root is not searched for outlines'
          : `${outlineLimits.roots} frames or shadow roots are not searched for outlines`,
      );
    return notes.map((note) => ' · ' + note).join('');
  };
  const rectNode = (r, tone, type = '') => {
    const mark = call(document, 'createElement', 'div');
    mark.className = type === 'none' ? 'mark unidentified' : 'mark';
    mark.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--tone:${tone}`;
    return mark;
  };
  // Keep selection nodes stable across paints: replacing their DOM on every
  // frame can invalidate readers between locating an outline and measuring it.
  const updateMark = (mark, node, tone, measuredRect) => {
    const r = measuredRect === undefined ? node && visibleRect(node) : measuredRect;
    if (!r) {
      mark.remove();
      return;
    }
    mark.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--tone:${tone}`;
    if (mark.parentNode !== marks) marks.append(mark);
  };
  const backgroundClipped = (node) =>
    lineage(node).some((item) => {
      const css = styleFor(item);
      return (css.clip !== 'auto' && css.clip !== '') || (css.clipPath !== 'none' && css.clipPath !== '');
    });
  // An outline's colour says what the element's evidence says, the same answer the card gives: your sources' markup,
  // markup generated by Liquid code, a form, list or field component, the portal's own page and files, an element
  // created at runtime inside an identified one, or not identified. The labels are proofLabels of
  // inspection-evidence.mjs for the proofs that generate markup.
  const GENERATED_LABELS = new Set([
    'Generated by this Liquid code',
    'Generated from this file',
    'Not in your local copy of this file: the deployed version differs here',
  ]);
  const COMPONENT_KINDS = new Set([
    'basic-form',
    'advanced-form',
    'advanced-form-step',
    'model-driven-form',
    'form',
    'formxml',
    'form-tab',
    'form-section',
    'form-control',
    'field',
    'column',
    'control',
    'subgrid',
    'lookup-view',
    'quick-view',
    'list',
    'list-view',
    'view',
    'table',
    'pcf',
  ]);
  const PORTAL_KINDS = new Set([
    'platform-shell',
    'platform-asset',
    'portal-endpoint',
    'external-resource',
    'builtin-template',
  ]);
  const evidenceCategory = (found) => {
    const owner = found.evidence.owner;
    const kind = owner.status === 'exact' ? String(owner.component?.kind ?? '').split(':')[0] : '';
    if (COMPONENT_KINDS.has(kind)) return 'component';
    if (PORTAL_KINDS.has(kind)) return 'portal';
    if (kind === 'liquid-tag') return 'generated';
    const exact = found.evidence.source.refs.find((ref) => ref.status === 'exact');
    // "Generated by the <name> tag": generated markup whose Liquid tag is known.
    if (exact)
      return GENERATED_LABELS.has(exact.evidenceLabel) || /^Generated by the \w+ tag$/.test(exact.evidenceLabel ?? '')
        ? 'generated'
        : 'source';
    if (kind) return 'source';
    if (found.contained) return 'runtime';
    return 'none';
  };
  // Evidence per element, computed for what is drawn and kept until the report or the page changes.
  let toneCache = new WeakMap(),
    toneReport = null;
  const forgetTones = () => {
    toneCache = new WeakMap();
  };
  const category = (node, compute = true) => {
    if (toneReport !== report) {
      toneReport = report;
      forgetTones();
    }
    if (toneCache.has(node)) return toneCache.get(node);
    if (!compute) return null;
    let type;
    try {
      type = evidenceCategory(identify(node));
    } catch {
      type = 'none';
    }
    toneCache.set(node, type);
    return type;
  };
  const TONES = {
    source: 'var(--tone-source)',
    generated: 'var(--tone-generated)',
    component: 'var(--tone-component)',
    portal: 'var(--tone-portal)',
    runtime: 'var(--tone-runtime)',
    none: 'var(--tone-none)',
  };
  const markColor = (type) => TONES[type] ?? TONES.none;
  // Which evidence each layer of the "Highlight layer" choice outlines.
  const LAYERS = {
    data: new Set(['component']),
    content: new Set(['source', 'generated', 'portal', 'runtime']),
  };
  const tooltipFormDetails = (binding) => {
    if (binding.fields.length !== 1 || !binding.forms.length) return '';
    let label = 'Form';
    if (!binding.formCertain) label = 'Possible form' + (binding.forms.length > 1 ? 's' : '');
    let count;
    if (binding.forms.length === 1) count = binding.forms[0].name;
    else count = binding.forms.length + ' forms';
    return `<div class="note">${label}: ${esc(count)}</div>`;
  };
  const isOccluded = (node, r) => {
    const x = r.left + r.width / 2,
      y = r.top + Math.min(r.height / 2, 30),
      top = hitStack(x, y)[0];
    return top && !lineage(node).includes(top) && !lineage(top).includes(node);
  };
  const discoveryCursors = new WeakMap(),
    shadowRoots = new Set();
  let releaseShadowHook = null,
    releaseAnimationHook = null;
  function watchShadowRoots() {
    if (releaseShadowHook) return;
    releaseShadowHook = hookShadowView(globalThis);
  }
  function hookShadowView(view) {
    const prototype = view.Element.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'attachShadow');
    if (!descriptor?.value || !descriptor.configurable) return;
    const wrapped = function (...args) {
      const surface = descriptor.value.apply(this, args);
      if (!disposed && surface.mode === 'open' && !own(this)) {
        shadowRoots.add(surface);
        watchFrames(this);
        if (enabled) {
          needsScan = true;
          schedule();
        }
      }
      return surface;
    };
    Object.defineProperty(prototype, 'attachShadow', { ...descriptor, value: wrapped });
    return () => {
      if (Object.getOwnPropertyDescriptor(prototype, 'attachShadow')?.value === wrapped)
        Object.defineProperty(prototype, 'attachShadow', descriptor);
    };
  }
  function watchAnimations() {
    if (releaseAnimationHook) return;
    releaseAnimationHook = hookAnimationView(globalThis);
  }
  function hookAnimationView(view) {
    const prototype = view.Element.prototype,
      descriptor = Object.getOwnPropertyDescriptor(prototype, 'animate');
    if (!descriptor?.value || !descriptor.configurable) return null;
    const wrapped = function (...args) {
      const result = descriptor.value.apply(this, args);
      if (enabled && !disposed && !own(this)) animate();
      return result;
    };
    Object.defineProperty(prototype, 'animate', { ...descriptor, value: wrapped });
    return () => {
      if (Object.getOwnPropertyDescriptor(prototype, 'animate')?.value === wrapped)
        Object.defineProperty(prototype, 'animate', descriptor);
    };
  }
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const scan = () => {
    // Rebuild observed roots so detached components are not retained indefinitely.
    observer.disconnect();
    observer.observe(get(document, 'documentElement'), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: identityAttributes,
    });
    // Platform structure as Power Pages renders it (form wrappers and layouts, form cells and controls, list grids,
    // subgrids, code component hosts), plus Mirage's own code component hosts on Mirage pages.
    const selector =
      'input:not([type=hidden]),select,textarea,form,[data-form-layout],div[id^="EntityFormControl"],div[id^="WebFormControl"],[data-selected-view],[data-view-layouts],.entitylist,.entity-grid,.subgrid[id],.control[data-logical-name],[data-attribute],[id^="PcfControlConfig_"][data-pcf-control],[role=dialog],dialog,iframe' +
      (d.mirageMode ? ',[data-entityname],[data-pcf-native-field],[data-pcf-schema]' : '');
    pruneFrames();
    const hintSelectors = [...new Set((report?.elementSources ?? []).map((hint) => hint.selector))];
    candidates = [];
    const seen = new Set(),
      visible = [],
      fallback = [];
    let observed = 0,
      visibleOverflow = false;
    const addCandidate = (node) => {
      if (own(node) || seen.has(node)) return;
      observed = Math.min(801, observed + 1);
      const local = call(node, 'getBoundingClientRect'),
        view = get(get(node, 'ownerDocument'), 'defaultView');
      const r =
        local.width > 0 &&
        local.height > 0 &&
        local.bottom > 0 &&
        local.right > 0 &&
        local.left < view.innerWidth &&
        local.top < view.innerHeight &&
        visibleRect(node);
      const inView = r && !backgroundClipped(node);
      const list = inView ? visible : fallback;
      if (list.length < 800) {
        list.push(node);
        seen.add(node);
      } else if (inView) visibleOverflow = true;
    };
    for (const surface of shadowRoots) if (!surface.host.isConnected) shadowRoots.delete(surface);
    const roots = [document, ...shadowRoots];
    for (let index = 0; index < roots.length && index < 40; index++) {
      const surface = roots[index];
      if (surface !== document)
        observer.observe(surface.documentElement ?? surface, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: identityAttributes,
        });
      for (const embedding of call(surface, 'querySelectorAll', 'iframe')) {
        const inner = frameDocument(embedding);
        if (inner && !roots.includes(inner)) {
          roots.push(inner);
          watchFrame(inner);
        }
      }
      if (!visibleOverflow)
        for (const node of call(surface, 'querySelectorAll', selector)) {
          addCandidate(node);
          if (visibleOverflow) break;
        }
      const nodes = call(surface, 'querySelectorAll', '*'),
        start = discoveryCursors.get(surface) ?? 0,
        budget = Math.min(
          nodes.length,
          surface === document ? 4000 : Math.max(100, Math.floor(4000 / Math.max(1, roots.length - 1))),
        );
      for (let offset = 0; offset < budget; offset++) {
        const node = nodes[(start + offset) % nodes.length];
        if (get(node, 'shadowRoot') && !own(node)) {
          if (!roots.includes(get(node, 'shadowRoot'))) roots.push(get(node, 'shadowRoot'));
          shadowRoots.add(get(node, 'shadowRoot'));
          observer.observe(get(node, 'shadowRoot'), {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: identityAttributes,
          });
        }
      }
      discoveryCursors.set(surface, nodes.length ? (start + budget) % nodes.length : 0);
      for (const hintSelector of hintSelectors) {
        if (visibleOverflow) break;
        try {
          for (const node of call(surface, 'querySelectorAll', hintSelector)) {
            addCandidate(node);
            if (visibleOverflow) break;
          }
        } catch {
          /* Optional inspection or cleanup failure must not interrupt the owning operation. */
        }
      }
    }
    candidates = [...visible, ...fallback].slice(0, 800);
    // Limits are said for what is in view: elements outside it are outlined when they scroll in. They never mark a
    // selection as incomplete: a selection is identified on its own, whatever the outlines hold.
    candidateLimit = false;
    outlineLimits.viewport = visibleOverflow;
    outlineLimits.roots = Math.max(0, roots.length - 40);
    needsScan = false;
    // Frame animations may already be running when their documents are discovered.
    animate();
  };
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const paint = () => {
    frame = 0;
    if (!enabled || disposed || get(document, 'hidden')) return;
    if (warmup) {
      warmup = false;
      schedule();
      return;
    }
    geometryCache = new WeakMap();
    styleCache = new WeakMap();
    if (selected && !liveNode(selected)) {
      detachSelection('node-replaced');
      card.hidden = false;
      const welcome = call(card, 'querySelector', '.hero');
      if (welcome) welcome.textContent = 'Element removed';
      const note = call(card, 'querySelector', '.note');
      if (note) note.textContent = 'The page replaced this element. Select it again.';
    }
    if (hover && !liveNode(hover)) hover = null;
    if (detailsDirty && selected) {
      detailsDirty = false;
      renderCard(true);
      notifySelection(true);
    }
    if (needsScan && report) scan();
    const background = call(document, 'createDocumentFragment');
    let count = 0,
      computed = 0,
      waiting = false;
    outlineLimits.drawn = false;
    if (layer !== 'none')
      for (const node of candidates) {
        const r = visibleRect(node);
        if (!r || r.width < 4 || r.height < 4 || backgroundClipped(node) || isOccluded(node, r)) continue;
        // The evidence of an element is read when it is first drawn, a bounded number per frame: what is in view is
        // outlined first, the rest follows in the next frames.
        let type = category(node, false);
        if (type === null) {
          if (computed >= 40) {
            waiting = true;
            continue;
          }
          computed++;
          type = category(node);
        }
        if (LAYERS[layer] && !LAYERS[layer].has(type)) continue;
        if (count >= 250) {
          outlineLimits.drawn = true;
          break;
        }
        background.append(rectNode(r, markColor(type), type));
        count++;
      }
    backgroundMarks.replaceChildren(background);
    // The keys and hints may wrap away on a narrow window; what the outlines leave out stays in view.
    const hint = ' · click to select · ' + escText,
      note = legendHint();
    const hintNode = call(root, 'querySelector', '.legend .hint'),
      noteNode = call(root, 'querySelector', '.legend .limit-note');
    if (hintNode.textContent !== hint) hintNode.textContent = hint;
    if (noteNode.textContent !== note) noteNode.textContent = note;
    if (waiting) schedule();
    // X-ray paints in the top layer, above the Lense pill and panel: outlines leave their boxes free.
    const lenseBoxes = [
      call(document, 'getElementById', 'paqvilo-panel'),
      call(document, 'getElementById', 'paqvilo-panel')?.shadowRoot?.querySelector('.panel'),
      call(document, 'getElementById', 'paqvilo-handle'),
    ]
      .map((item) => call(item, 'getBoundingClientRect'))
      .filter((box) => box?.width && box.height);
    const holes = lenseBoxes
      .map((box) => 'M' + box.left + ' ' + box.top + 'h' + box.width + 'v' + box.height + 'h' + -box.width + 'Z')
      .join('');
    marks.style.clipPath = holes ? `path(evenodd, "M0 0H${innerWidth}V${innerHeight}H0Z${holes}")` : '';
    updateMark(selectedMark, selected, 'var(--primary)');
    if (selected) placeCard(visibleRect(selected));
    let formContext = null;
    for (const anchor of selectionAnchors.get(selected) ?? []) {
      if (
        !/^(?:basic-form|advanced-form):/.test(anchor.componentKey ?? '') ||
        !Number.isSafeInteger(anchor.ancestorDepth)
      )
        continue;
      let current = selected;
      for (let depth = 0; current && depth < anchor.ancestorDepth; depth++)
        current =
          get(current, 'assignedSlot') ?? get(current, 'parentElement') ?? get(call(current, 'getRootNode'), 'host');
      if (
        current &&
        get(current, 'ownerDocument') === get(selected, 'ownerDocument') &&
        get(current, 'localName') === anchor.localName &&
        get(current, 'id') === anchor.id
      ) {
        formContext = current;
        selectedFormMark.dataset.componentKey = anchor.componentKey;
        break;
      }
    }
    updateMark(selectedFormMark, formContext, 'var(--tone-component)');
    updateMark(hoverMark, hover !== selected && !interacting ? hover : null, 'var(--primary)');
    const target = hover ?? selected,
      r = target && visibleRect(target);
    // The open card already describes the selected element.
    tip.hidden = !report || !r || interacting || overUi || (target === selected && !card.hidden);
    if (!tip.hidden) {
      const identity = identify(target),
        b = identity.b;
      // Measured at the left edge: a fixed box near the right edge would shrink and wrap.
      tip.style.left = '0px';
      const tipSub = identity.sub ? '<div class="mono">' + esc(identity.sub) + '</div>' : '';
      tip.innerHTML = identity.matched
        ? `<span class="note">${esc(identity.kind)}</span><b>${esc(identity.title)}</b>${tipSub}${tooltipFormDetails(b)}`
        : `<b>${esc(identity.kind)}</b><span class="note">Click to see parent elements.</span>`;
      // Beside the element, left of it first: left-aligned text leaves the end of whatever precedes it empty, while
      // the next cell or value starts right after it. Below or above only when neither side has room.
      const tr = call(tip, 'getBoundingClientRect'),
        gap = 8,
        top = 58,
        right = r.left + r.width,
        bottom = r.top + r.height;
      const clampY = (y) => Math.max(top, Math.min(innerHeight - tr.height - gap, y));
      const clampX = (x) => Math.max(gap, Math.min(innerWidth - tr.width - gap, x));
      // The tip never covers the open details card: a narrow window leaves it no side, and then it stays hidden.
      const cr = card.hidden ? null : call(card, 'getBoundingClientRect');
      const clear = ([x, y]) =>
        !cr || x >= cr.right || x + tr.width <= cr.left || y >= cr.bottom || y + tr.height <= cr.top;
      const place = [
        r.left - 2 * gap >= tr.width && [r.left - gap - tr.width, clampY(r.top)],
        innerWidth - right - 2 * gap >= tr.width && [right + gap, clampY(r.top)],
        innerHeight - bottom - 2 * gap >= tr.height && [clampX(r.left), bottom + gap],
        [clampX(r.left), clampY(r.top - tr.height - gap)],
      ]
        .filter(Boolean)
        .find(clear);
      tip.hidden = !place;
      if (place) {
        tip.style.left = place[0] + 'px';
        tip.style.top = place[1] + 'px';
      }
    }
    // The legend steps aside for the Lense pill or panel under it (a narrow window puts both at the bottom).
    const legend = call(root, 'querySelector', '.legend'),
      lr = call(legend, 'getBoundingClientRect'),
      ly = lr.top + lr.height / 2;
    legend.classList.toggle(
      'covered',
      [lr.left + 2, lr.left + lr.width / 2, lr.right - 2].some((x) => lenseUiAt(x, ly)),
    );

    geometryCache = null;
    styleCache = null;
  };
  const ensureHost = () => {
    if (disposed) return false;
    if (host.isConnected) return true;
    const existing = call(document, 'getElementById', 'paqvilo-xray');
    if (
      host.parentElement?.matches('dialog') &&
      get(document, 'body') === owningBody &&
      owningBody.isConnected &&
      (!existing || existing === host)
    ) {
      topLayer(true);
      return true;
    }
    host.__px?.dispose();
    return false;
  };
  const schedule = () => {
    if (!ensureHost()) return;
    if (enabled && !get(document, 'hidden') && !frame) frame = requestAnimationFrame(paint);
  };
  const hitStack = (x, y) => {
    const stack = [],
      seen = new Set();
    /* NOSONAR */ const add = (node, depth = 0, px = x, py = y) => {
      if (own(node) || seen.has(node)) return;
      seen.add(node);
      if (get(node, 'shadowRoot'))
        observer.observe(get(node, 'shadowRoot'), {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: identityAttributes,
        });
      if (get(node, 'shadowRoot') && depth < 40)
        for (const inner of get(node, 'shadowRoot').elementsFromPoint(px, py))
          if (call(inner, 'getRootNode') === get(node, 'shadowRoot')) add(inner, depth + 1, px, py);
      if (get(node, 'localName') === 'iframe' && depth < 40) {
        const doc = frameDocument(node),
          r = call(node, 'getBoundingClientRect'),
          sx = r.width / node.offsetWidth || 1,
          sy = r.height / node.offsetHeight || 1,
          ix = (px - r.left) / sx - node.clientLeft,
          iy = (py - r.top) / sy - node.clientTop;
        if (doc && ix >= 0 && iy >= 0 && ix < node.clientWidth && iy < node.clientHeight)
          for (const inner of doc.elementsFromPoint(ix, iy)) add(inner, depth + 1, ix, iy);
      }
      stack.push(node);
    };
    for (const node of call(document, 'elementsFromPoint', x, y)) add(node);
    return stack;
  };
  const underPointer = (x, y) => hitStack(x, y)[0];
  let modalOrder = [];
  const topLayer = (force = false) => {
    modalOrder = modalOrder.filter((node) => get(node, 'isConnected') && call(node, 'matches', ':modal'));
    const modal =
      modalOrder.at(-1) ??
      get(document, 'activeElement')?.closest('dialog:modal') ??
      [...call(document, 'querySelectorAll', 'dialog:modal')].at(-1);
    const container = modal ?? get(document, 'body');
    const moved = host.parentElement !== container;
    if (moved) container.append(host);
    if (enabled) {
      try {
        const open = call(host, 'matches', ':popover-open');
        if (open && (force || moved)) host.hidePopover();
        if (!open || force || moved) host.showPopover();
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    }
  };
  const mode = () => {
    containFocus();
    ui.classList.toggle('interact', interacting);
    const button = call(root, 'querySelector', '[data-action=mode]');
    button.setAttribute('aria-pressed', String(!interacting));
    button.classList.toggle('on', !interacting);
    const state = call(root, 'querySelector', '.mode-state');
    if (state.dataset.using !== String(interacting)) {
      state.dataset.using = String(interacting);
      state.innerHTML = modeText(interacting);
    }
    // One label: pressed is inspecting, released is using the page. A label that flips as well would contradict it.
    button.title = interacting
      ? 'Interact mode: the page works normally. Click or tap Ctrl to inspect again.'
      : 'Inspect mode: hover for a summary, click to select. Click or tap Ctrl to use the page normally.';
  };
  let identifierReport,
    knownIdentifiers = new Set(),
    knownClasses = new Set();
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const selectionElement = () => {
    if (!selected) return null;
    if (identifierReport !== report) {
      identifierReport = report;
      knownIdentifiers = new Set();
      knownClasses = new Set();
      for (const row of [
        ...(report?.columns ?? []),
        ...(report?.nativeControls ?? []),
        ...(report?.componentIndex?.forms ?? []),
        ...(report?.componentIndex?.lists ?? []),
      ])
        for (const value of [row.id, row.name, row.field, row.controlId])
          if (typeof value === 'string') knownIdentifiers.add(value);
      for (const hint of report?.elementSources ?? []) {
        for (const match of String(hint.selector ?? '').matchAll(/#([\w-]+)/g)) knownIdentifiers.add(match[1]);
        for (const match of String(hint.selector ?? '').matchAll(/\.([\w-]+)/g)) knownClasses.add(match[1]);
      }
    }
    const name = call(selected, 'getAttribute', 'name');
    const classes = [...get(selected, 'classList')]
      .filter((value) => knownClasses.has(value))
      .slice(0, 5)
      .join('.');
    return {
      tag: get(selected, 'localName'),
      ...(knownIdentifiers.has(get(selected, 'id')) ? { id: get(selected, 'id').slice(0, 160) } : {}),
      ...(knownIdentifiers.has(name) ? { name: name.slice(0, 160) } : {}),
      ...(classes ? { classes } : {}),
    };
  };
  const lifecycle = (
    action,
    reason,
    identity = null,
    scope = selected ? getSelectionScope(selected) : (lastScope ?? getSelectionScope()),
  ) => {
    if (identity?.evidence) identity = { ...identity, evidence: { ...identity.evidence, scope } };
    lastIdentity = identity;
    lastScope = scope;
    dispatch(action, {
      reason,
      scope,
      anchorId: selected ? opaqueId(anchorIds, selected, 'anchor') : null,
      selectionGeneration,
      anchorGeneration: selectionGeneration,
      element: selectionElement(),
      identity,
      oneShot: retainedOneShot,
      updated: action === 'updated',
    });
  };
  const notifySelection = (updated, reason = updated ? 'evidence-changed' : 'user-selection') => {
    if (!selected || !liveNode(selected)) return;
    lifecycle(updated ? 'updated' : 'selected', reason, selectionIdentity(selected, getSelectionScope(selected)));
  };
  const refreshSelection = (reason = 'evidence-ready') => {
    if (!selected || !liveNode(selected)) return;
    renderCard(true);
    notifySelection(true, reason);
    schedule();
  };
  const clearSelection = (reason = 'user-clear') => {
    if (!selected && !lastIdentity) return;
    const previous = selected && liveNode(selected) ? getSelectionScope(selected) : lastScope;
    retainedObserver.disconnect();
    selectionGeneration++;
    lifecycle('cleared', reason, null, previous);
    selected = null;
    hover = null;
    retainedOneShot = false;
    renderCard();
    schedule();
  };
  const detachSelection = (reason) => {
    if (!selected) return;
    lifecycle('detached', reason, null, lastScope ?? getSelectionScope(selected));
    clearSelection('anchor-detached');
  };
  const watchSelection = () => {
    retainedObserver.disconnect();
    if (!selected) return;
    const surfaces = new Set([
      get(document, 'documentElement'),
      get(get(selected, 'ownerDocument'), 'documentElement'),
    ]);
    for (const item of lineage(selected).slice(0, 40)) {
      const surface = call(item, 'getRootNode');
      if (surface?.host) surfaces.add(surface);
    }
    for (const surface of surfaces)
      if (surface)
        retainedObserver.observe(surface, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: identityAttributes,
        });
  };
  // A logical-name label that Lense added to a model-driven field stands for that field: picking or hovering it
  // inspects the field it was added to, not the label itself.
  const annotated = (node) => get(call(node, 'closest', '[data-paq-model-logical-name]'), 'parentElement') ?? node;
  const select = (picked, point = null) => {
    const node = annotated(picked);
    if (!node || own(node)) return;
    const rect = visibleRect(node),
      cardRect = rect ?? call(node, 'getBoundingClientRect');
    resizeObserver.disconnect();
    resizeObserver.observe(get(document, 'documentElement'));
    resizeObserver.observe(node);
    selected = node;
    selectionGeneration++;
    pierced = point ? { generation: selectionGeneration, reading: true, result: null } : null;
    retainedOneShot = oneShot;
    watchSelection();
    details = true;
    hover = node;
    renderCard(false, cardRect);
    if (enabled) {
      updateMark(selectedMark, selected, 'var(--primary)', rect);
      hoverMark.remove();
    }
    schedule();
    const once = oneShot;
    notifySelection(false);
    if (point) dispatch('pierce', { x: point.x, y: point.y, selectionGeneration });
    if (once) toggle(false);
  };
  const toggle = (value) => {
    const next = value ?? !enabled;
    if (next === enabled) return;
    enabled = next;
    warmup = enabled;
    ui.hidden = !enabled;
    mode();
    if (enabled) {
      watchShadowRoots();
      watchAnimations();
      observer.observe(get(document, 'documentElement'), {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: identityAttributes,
      });
      watchFrames();
      resizeObserver.observe(get(document, 'documentElement'));
      needsScan = true;
      topLayer();
      renderCard();
      schedule();
      animate();
    } else {
      statusMessage = '';
      statusSelection = null;
      feedbackEpoch++;
      oneShot = false;
      releaseAnimationHook?.();
      releaseAnimationHook = null;
      for (const release of frameAnimationHooks.values()) release();
      frameAnimationHooks.clear();
      resizeObserver.disconnect();
      observer.disconnect();
      // Keep same-origin frame shortcut discovery alive while inspection is
      // off. Every activation guard checks enabled; dispose owns teardown.
      if (!retainedOneShot) clearSelection('xray-disabled');
      hover = null;
      overUi = false;
      passThrough(false);
      ctrlTap = false;
      interacting = false;
      backgroundMarks.replaceChildren();
      selectedMark.remove();
      selectedFormMark.remove();
      hoverMark.remove();
      tip.hidden = true;
      try {
        host.hidePopover();
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    dispatch('toggled', { enabled });
  };
  const identityAttributes = [
    'class',
    'style',
    'hidden',
    'open',
    'id',
    'for',
    'role',
    'type',
    'src',
    'data-th',
    'data-form-layout',
    'data-formid',
    'data-viewid',
    'data-selected-view',
    'data-view-layouts',
    'data-entityname',
    'data-entity',
    'name',
    'data-field',
    'data-fieldname',
    'data-attribute',
    'data-lookup-datafieldname',
    'data-pcf-schema',
    'data-pcf-native-field',
    'data-listid',
    'data-controlid',
    'data-id',
    // data-paqvilo-source is not watched: the provenance registry removes it as it remembers each element.
    // The declarations portal-node-observation reads: the opt-in table/grid/column markers and the portal's own
    // control, tab/section and code component host markers.
    'data-paqvilo-table',
    'data-paqvilo-grid',
    'data-paqvilo-column',
    'data-logical-name',
    'data-name',
    'pcf-controlcontext',
    'slot',
  ];
  const observer = new MutationObserver((records) => {
    if (!ensureHost()) return;
    if (!enabled) return;
    const external = records.filter(
      (record) =>
        !own(record.target) &&
        !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every((node) => node === host)),
    );
    if (!external.length) return;
    // A changed page can change what its elements are: outline colours are read again (a style change cannot).
    if (external.some((record) => record.attributeName !== 'style')) forgetTones();
    if (selected) {
      const associated = labelledControl(selected);
      const related = new Set([...lineage(selected), ...lineage(associated)]);
      if (
        external.some(
          (record) =>
            record.attributeName !== 'style' &&
            (record.type === 'childList' ||
              related.has(record.target) ||
              lineage(record.target).includes(selected) ||
              record.attributeName === 'id' ||
              record.target.localName === 'slot'),
        )
      )
        detailsDirty = true;
    }
    needsScan = true;
    if (external.some((record) => record.type === 'childList' || record.attributeName === 'open')) topLayer();
    schedule();
  });
  listen(
    document,
    'toggle',
    (event) => {
      if (event.target === host || !event.target.matches?.('dialog,[popover]')) return;
      if (event.target.matches('dialog:modal')) {
        modalOrder = modalOrder.filter((node) => node !== event.target);
        modalOrder.push(event.target);
      }
      if (enabled) {
        topLayer(event.newState === 'open');
        schedule();
      }
    },
    { capture: true },
  );
  observer.observe(get(document, 'documentElement'), {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: identityAttributes,
  });
  listenViews(
    'pointermove',
    (event) => {
      if (!enabled) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (drag) {
        card.style.left = Math.max(8, Math.min(innerWidth - card.offsetWidth - 8, event.clientX - drag.x)) + 'px';
        card.style.top = Math.max(74, Math.min(innerHeight - card.offsetHeight - 8, event.clientY - drag.y)) + 'px';
        card.style.right = 'auto';
        card.style.bottom = 'auto';
        cardMoved = true;
        return;
      }
      const node = event.composedPath().find((item) => item?.nodeType === 1);
      const lenseUi = get(node, 'classList')?.contains('shield')
        ? lenseUiAt(event.clientX, event.clientY)
        : own(node) && node;
      // Over Lense's own UI (card, bar, dev panel) the page is not hovered: no outline, no tooltip.
      overUi = Boolean(lenseUi);
      passThrough(overUi && call(lenseUi, 'getRootNode')?.host !== host && lenseUi !== host);
      if (overUi) {
        if (hover) {
          hover = null;
          schedule();
        } else if (!tip.hidden) schedule();
        return;
      }
      hover = annotated(get(node, 'classList')?.contains('shield') ? underPointer(event.clientX, event.clientY) : node);
      if (own(hover)) hover = null;
      schedule();
    },
    { capture: true },
  );
  for (const type of [
    'pointerdown',
    'pointerup',
    'pointercancel',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'contextmenu',
    'auxclick',
    'touchstart',
    'touchend',
    'touchcancel',
    'focus',
    'focusin',
    'focusout',
    'blur',
  ])
    listenViews(
      type,
      (event) => /* NOSONAR: single-pass routine, splitting it would change shared state */ {
        if (event.ctrlKey) ctrlTap = false;
        if (!pickGesture && (!enabled || interacting)) return;
        const node = event.composedPath().find((item) => item?.nodeType === 1);
        if (!pickGesture && (!node || (own(node) && !get(node, 'classList')?.contains('shield')))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === 'pointerdown' || type === 'touchstart') {
          const point = event.changedTouches?.[0] ?? event;
          // A press that reached the shield over the dev panel is not a pick of the page under it; the next press
          // reaches the panel.
          if (!pickGesture && get(node, 'classList')?.contains('shield') && lenseUiAt(point.clientX, point.clientY)) {
            passThrough(true);
            return;
          }
          const picked = get(node, 'classList')?.contains('shield') ? underPointer(point.clientX, point.clientY) : node;
          const at = { x: point.clientX, y: point.clientY };
          if (oneShot) {
            pickGesture = true;
            pendingPick = picked;
            pendingPoint = at;
          } else select(picked, at);
        }
        if (['click', 'auxclick', 'contextmenu', 'touchend'].includes(type) && pickGesture) {
          const picked = pendingPick;
          if (oneShot) select(picked, pendingPoint);
          pickGesture = false;
          pendingPick = null;
          pendingPoint = null;
        }
        if (type === 'pointercancel' || type === 'touchcancel') {
          pickGesture = false;
          pendingPick = null;
        }
      },
      { capture: true, passive: false },
    );
  listenViews(
    'scroll',
    () => {
      needsScan = true;
      schedule();
    },
    { capture: true, passive: true },
  );
  listenViews(
    'load',
    (event) => {
      if (event.target?.localName === 'iframe') watchFrames(event.target);
      needsScan = true;
      schedule();
    },
    { capture: true },
  );
  listenViews(
    'resize',
    () => {
      cardMoved = false;
      cardPlacement = '';
      needsScan = true;
      schedule();
    },
    { passive: true },
  );
  listenViews(
    'keydown',
    (event) => /* NOSONAR: single-pass routine, splitting it would change shared state */ {
      if (event.altKey && event.shiftKey && event.code === 'KeyX') {
        if (event.ctrlKey || event.metaKey || event.repeat) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        toggle();
        return;
      }
      if (!enabled) return;
      if (event.key === 'Control') {
        ctrlTap = !event.repeat && !event.shiftKey && !event.altKey && !event.metaKey;
        return;
      }
      ctrlTap = false;
      const node = event.composedPath().find((item) => item?.nodeType === 1);
      if (event.key === 'Tab' && !interacting) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // A control inside a closed disclosure keeps its boxes; only checkVisibility knows it is not rendered.
        const controls = [
          ...root.querySelectorAll(
            'button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex]:not([tabindex="-1"])',
          ),
        ].filter((item) => call(item, 'checkVisibility', { visibilityProperty: true }));
        const index = controls.indexOf(root.activeElement),
          direction = event.shiftKey ? -1 : 1;
        let focusIndex;
        if (index < 0) {
          if (event.shiftKey) focusIndex = controls.length - 1;
          else focusIndex = 0;
        } else focusIndex = (index + direction + controls.length) % controls.length;
        (controls[focusIndex] ?? ui).focus();
        return;
      }
      if (own(node) && call(node, 'matches', 'input,select,textarea')) return;
      if (interacting && !own(node)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (selected) {
          clearSelection('escape');
        } else toggle(false);
        return;
      }
      if (interacting) return;
      // Do not let keyboard activation submit a focused portal form while inspecting.
      if (
        ['ArrowUp', 'ArrowDown', '[', ']'].includes(event.key) ||
        ((!own(node) || node === ui) && ['Enter', ' '].includes(event.key))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === 'ArrowUp' && selected) {
          const ancestor = parent(selected);
          if (ancestor) descent.set(ancestor, selected);
          select(ancestor);
        }
        if (event.key === 'ArrowDown' && selected) select(child(selected));
        if (event.key === '[' || event.key === ']') {
          const stack = hitStack(pointer.x, pointer.y),
            index = stack.indexOf(selected ?? hover);
          let next;
          if (index < 0) next = 0;
          else {
            const step = event.key === ']' ? 1 : -1;
            next = (index + step + stack.length) % stack.length;
          }
          select(stack[next]);
        }
      }
    },
    { capture: true },
  );
  listenViews(
    'keyup',
    (event) => {
      if (event.key === 'Control' && ctrlTap && enabled) {
        interacting = !interacting;
        mode();
        schedule();
      }
      ctrlTap = false;
      if (
        enabled &&
        !interacting &&
        !own(event.composedPath().find((item) => item?.nodeType === 1)) &&
        ['Enter', ' '].includes(event.key)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  listen(document, 'visibilitychange', () => {
    ctrlTap = false;
    mode();
    schedule();
  });
  // Ctrl+wheel is browser zoom, not a tap; in Interact the page, not the shield, gets the wheel. Not passive: a
  // passive wheel listener on the window lets Chromium scroll before dispatch, so the shield's own scroll (and its
  // preventDefault) would come on top of the browser's and the page would move twice.
  listenViews(
    'wheel',
    (event) => {
      if (event.ctrlKey) ctrlTap = false;
    },
    { capture: true, passive: false },
  );
  listen(
    root,
    'wheel',
    (event) => /* NOSONAR: single-pass routine, splitting it would change shared state */ {
      if (event.ctrlKey) ctrlTap = false;
      if (!event.target.classList?.contains('shield') || interacting || event.ctrlKey) return;
      event.preventDefault();
      const node = underPointer(event.clientX, event.clientY);
      if (!node) return;
      const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 16,
        factor = event.deltaMode === 1 ? line : 1;
      let dx = event.deltaX * factor,
        dy = event.deltaY * factor;
      if (event.deltaMode === 2) {
        dx *= innerWidth;
        dy *= innerHeight;
      }
      if (event.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      for (const [axis, amount] of [
        ['x', dx],
        ['y', dy],
      ]) {
        if (!amount) continue;
        for (const current of lineage(node)) {
          const css = getComputedStyle(current),
            vertical = axis === 'y',
            overflow = vertical ? css.overflowY : css.overflowX;
          const extent = vertical
            ? current.scrollHeight - current.clientHeight
            : current.scrollWidth - current.clientWidth;
          const rootScroller = current === get(get(current, 'ownerDocument'), 'scrollingElement');
          if ((!/auto|scroll/.test(overflow) && !rootScroller) || extent <= 0) continue;
          const offset = vertical ? current.scrollTop : current.scrollLeft;
          const rtl = !vertical && css.direction === 'rtl';
          let canScroll;
          if (rtl) {
            if (amount < 0) canScroll = offset > -extent + 1;
            else canScroll = offset < 0;
          } else if (amount < 0) canScroll = offset > 0;
          else canScroll = offset < extent - 1;
          if (canScroll) {
            current.scrollBy({ left: vertical ? 0 : amount, top: vertical ? amount : 0, behavior: 'instant' });
            break;
          }
          if (/contain|none/.test(vertical ? css.overscrollBehaviorY : css.overscrollBehaviorX)) break;
        }
      }
      schedule();
    },
    { passive: false },
  );
  listenViews('blur', () => {
    ctrlTap = false;
    drag = null;
    mode();
    schedule();
  });
  listen(root, 'pointerdown', (event) => {
    const header = event.target.closest('.cardhead');
    if (!header || event.target.closest('button')) return;
    const r = call(card, 'getBoundingClientRect');
    drag = { x: event.clientX - r.left, y: event.clientY - r.top };
    header.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  listenViews(
    'pointerup',
    () => {
      drag = null;
    },
    { capture: true },
  );
  listen(root, 'change', (event) => {
    if (event.target.matches('select')) {
      layer = event.target.value;
      schedule();
    }
  });
  listen(
    root,
    'toggle',
    (event) => {
      const key = event.target.dataset?.disclosure;
      if (key) disclosureState.set(key, event.target.open);
    },
    { capture: true },
  );
  /* NOSONAR: single-pass routine, splitting it would change shared state */ listen(root, 'click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'context-page' && !button.disabled) {
      contextPages.set(button.dataset.context, Math.max(0, Number(button.dataset.page) || 0));
      renderCard(true);
    }
    if (action === 'refresh' && !button.disabled) {
      setStatus('Refreshing…');
      dispatch('refresh');
    }
    if (action === 'exit') toggle(false);
    if (action === 'mode') {
      interacting = !interacting;
      mode();
      schedule();
    }
    if (action === 'details') {
      details = !details;
      button.setAttribute('aria-pressed', String(details));
      button.classList.toggle('on', details);
      renderCard();
    }
    if (action === 'source-region') {
      let region;
      try {
        region = lineage(selected).find((node) => call(node, 'matches', button.dataset.selector));
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
      if (region) select(region);
      else setStatus('This part of the page is gone. Select the element again.');
    }
    if (action === 'clear') {
      clearSelection('user-clear');
    }
    if (action === 'parent') {
      const ancestor = parent(selected);
      if (ancestor) descent.set(ancestor, selected);
      select(ancestor);
    }
    if (action === 'child') select(child(selected));
    if (action === 'ancestor') select(lineage(selected)[Number(button.dataset.index)]);
    if (action === 'frame-open' && get(selected, 'localName') === 'iframe') {
      try {
        const url = new URL(
          call(selected, 'getAttribute', 'src') ?? '',
          get(get(selected, 'ownerDocument'), 'baseURI'),
        );
        if (!call(selected, 'getAttribute', 'src') || !['http:', 'https:'].includes(url.protocol)) throw new Error(); // NOSONAR: error is detected by type, message is not used
        window.open(url.href, '_blank', 'noopener');
      } catch {
        setStatus('This frame has no address of its own, so it cannot open in a new tab.');
      }
    }
    if (action === 'reveal') {
      selected?.scrollIntoView({ block: 'center', inline: 'nearest' });
      schedule();
    }
    if (action === 'dock') {
      const r = call(card, 'getBoundingClientRect');
      card.style.left = r.left > innerWidth / 2 ? '20px' : innerWidth - 20 - r.width + 'px';
      cardMoved = true;
    }
    if (action === 'copy') {
      // The message belongs to the selection the button was pressed for: another element can be picked while the
      // clipboard write is pending.
      const pressedFor = host.__px.feedbackState();
      const reference = button.dataset.copyKind === 'reference';
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        // The panel's words: one message per kind of copy wherever Lense copies.
        setStatus(reference ? 'Source reference copied' : 'Path copied', pressedFor);
      } catch {
        setStatus('The browser did not allow copying', pressedFor);
      }
    }
    if (action === 'open')
      dispatch('open', {
        ref: button.dataset.ref,
        line: Number(button.dataset.line) || undefined,
        find: button.dataset.find || undefined,
        ...(button.dataset.sourceKey
          ? {
              sourceKey: button.dataset.sourceKey,
              sourceRevision: button.dataset.sourceRevision,
              contentRevision: button.dataset.contentRevision,
              scope: getSelectionScope(selected),
              anchorGeneration: selectionGeneration,
              ...(button.dataset.sourceRegion ? { region: JSON.parse(button.dataset.sourceRegion) } : {}),
            }
          : {}),
      });
  });
  // Follow active animations; idle documents never poll geometry.
  let animationFrame = 0;
  const resizeObserver = new ResizeObserver(schedule);
  const animate = () => {
    cancelAnimationFrame(animationFrame);
    if (!enabled || disposed || get(document, 'hidden')) return;
    if (
      [document, ...frameViews.keys()].some((doc) =>
        doc.getAnimations().some((animation) => animation.playState === 'running' && !own(animation.effect?.target)),
      )
    ) {
      schedule();
      animationFrame = requestAnimationFrame(animate);
    }
  };
  listenViews('animationstart', animate, { capture: true });
  listenViews(
    'paqvilo-provenance-ready',
    (event) => {
      // New proof from the page's provider can name elements that had none: outline colours are read again.
      if ([d.provenanceSlot, d.domProvenanceSlot].includes(event.detail?.slot) && event.detail?.slot) {
        forgetTones();
        if (enabled) schedule();
      }
      if (
        ![d.provenanceSlot, d.domProvenanceSlot].includes(event.detail?.slot) ||
        !event.detail?.slot ||
        !selected ||
        !liveNode(selected)
      )
        return;
      refreshSelection('response-proof-ready');
    },
    { capture: true },
  );
  listenViews('transitionrun', animate, { capture: true });
  listen(document, 'visibilitychange', () => {
    if (get(document, 'hidden')) {
      cancelAnimationFrame(frame);
      frame = 0;
      cancelAnimationFrame(animationFrame);
    } else {
      schedule();
      animate();
    }
  });
  watchShadowRoots();
  watchFrames();
  // How much of the page is identified: every element of the document, accessible frames and open shadow roots,
  // asked the same question a selection asks. Tags only: no text, no attribute values.
  const coverageShape = (node) => {
    const parts = [];
    for (
      let current = node, depth = 0;
      get(current, 'nodeType') === 1 && depth < 4;
      current = get(current, 'parentElement'), depth++
    )
      parts.unshift(get(current, 'localName'));
    return parts.join(' > ');
  };
  const coverageState = (found) => {
    const owner = found.evidence.owner?.status;
    const source = found.evidence.source?.status;
    if (owner === 'exact' || source === 'exact') return 'direct';
    if (found.contained) return 'contained';
    if (owner === 'conflicting' || source === 'conflicting') return 'conflict';
    return owner === 'candidate' || source === 'candidate' ? 'likely' : 'none';
  };
  const coverageKind = (state, evidence) => {
    if (state !== 'direct') return state;
    if (evidence.owner?.status === 'exact') return evidence.owner.component?.kind ?? 'component';
    return evidence.source.refs.find((ref) => ref.status === 'exact')?.kind ?? 'source';
  };
  // The frame and shadow roots a node opens, queued to be walked after the current root.
  const queueCoverageRoots = (roots, node, frame) => {
    const shadow = get(node, 'shadowRoot');
    if (shadow && roots.length < 200) roots.push({ root: shadow, frame });
    if (get(node, 'localName') === 'iframe' || get(node, 'localName') === 'frame') {
      const inner = frameDocument(node);
      if (inner && roots.length < 200) roots.push({ root: inner, frame: (frame ? frame + ' > ' : '') + 'frame' });
    }
  };
  // One element asked the same question a selection asks: counted by state and kind, and sampled when unidentified.
  const tallyCoverageNode = ({ counts, kinds, unidentified, sampleNodes, samples }, node, frame) => {
    let found;
    try {
      found = identify(node);
    } catch {
      counts.failed++;
      kinds.failed = (kinds.failed ?? 0) + 1;
      if (unidentified.length < samples) {
        unidentified.push({
          state: 'failed',
          tag: get(node, 'localName'),
          path: coverageShape(node),
          ...(frame ? { frame } : {}),
        });
        sampleNodes.push(node);
      }
      return;
    }
    const state = coverageState(found);
    counts[state]++;
    const kind = coverageKind(state, found.evidence);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if ((state === 'none' || state === 'likely' || state === 'conflict') && unidentified.length < samples) {
      unidentified.push({ state, tag: get(node, 'localName'), path: coverageShape(node), ...(frame ? { frame } : {}) });
      sampleNodes.push(node);
    }
  };
  const coverage = ({ limit = 20000, samples = 40 } = {}) => {
    // failed: an element whose identification threw. It is not counted as unidentified: X-ray could not ask.
    const counts = { direct: 0, contained: 0, likely: 0, conflict: 0, none: 0, failed: 0 };
    const kinds = {};
    const unidentified = [],
      sampleNodes = [];
    const tally = { counts, kinds, unidentified, sampleNodes, samples };
    let total = 0,
      truncated = false;
    const roots = [{ root: document, frame: '' }];
    while (roots.length) {
      const { root, frame } = roots.shift();
      for (const node of call(root, 'querySelectorAll', '*')) {
        if (own(node)) continue;
        if (total >= limit) {
          truncated = true;
          break;
        }
        total++;
        queueCoverageRoots(roots, node, frame);
        tallyCoverageNode(tally, node, frame);
      }
    }
    coverageSamples = sampleNodes;
    return { version: 1, total, truncated, counts, kinds, unidentified, report: Boolean(report) };
  };
  // The elements of the last coverage samples, by position: the panel selects one without holding page nodes.
  let coverageSamples = [];
  host.__px = globalThis.__paqviloXrayUi = {
    toggle,
    select,
    identify,
    coverage,
    // The inspection report of this page, for a caller that asks for coverage without turning X-ray on.
    setReport(next) {
      if (next && next !== report) {
        report = next;
        needsScan = true;
      }
    },
    hasReport: () => Boolean(report),
    /** Selects sample `index` of the last coverage, when it is still on the page; false when it is gone. */
    selectCoverageSample(index) {
      const node = coverageSamples[index];
      if (!node || !liveNode(node)) return false;
      select(node);
      return true;
    },
    pickOnce() {
      oneShot = true;
      toggle(true);
    },
    selection() {
      return lastIdentity;
    },
    getSelectionScope,
    refreshSelection,
    selectedNode() {
      return selected && liveNode(selected) ? selected : null;
    },
    /**
     * The identification of an element in a closed shadow root that Lense reached (panel action pierce): what identify
     * says of it, reduced to its title and source references (file, line).
     */
    identifySealed(node) {
      const identity = identify(node, getSelectionScope(node));
      const source = identity?.evidence?.source;
      return structuredClone({
        title: identity?.title ?? null,
        kind: identity?.kind ?? null,
        status: source?.status ?? null,
        refs: (source?.refs ?? []).map((ref) => ({
          ref: ref.ref ?? null,
          name: ref.name ?? ref.label ?? null,
          line: ref.region?.line ?? null,
          status: ref.status ?? null,
        })),
      });
    },
    /** The pierced read of the current selection as markup, for the panel's selection summary ('' when none). */
    /** The pierced read of the current selection: null without one, else whether it is still read and what it found. */
    piercedState() {
      if (pierced?.generation !== selectionGeneration) return null;
      return { generation: pierced.generation, reading: pierced.reading, found: pierced.result?.element ?? null };
    },
    piercedMarkup() {
      return piercedHtml(pierced?.generation === selectionGeneration ? pierced : null);
    },
    /** The pierced read of selection `generation` (lense panel action pierce); a later selection ignores it. */
    setPierced(generation, result) {
      if (generation !== selectionGeneration || pierced?.generation !== generation) return;
      pierced = { generation, reading: false, result: result?.ok ? result : null };
      renderCard(true);
    },
    selectionState() {
      return {
        scope: selected ? getSelectionScope(selected) : (lastScope ?? getSelectionScope()),
        anchorId: selected ? opaqueId(anchorIds, selected, 'anchor') : null,
        selectionGeneration,
        anchorGeneration: selectionGeneration,
        feedbackEpoch,
        identity: lastIdentity,
      };
    },
    feedbackState() {
      return {
        scope: getSelectionScope(selected),
        anchorGeneration: selectionGeneration,
        feedbackEpoch,
        feedbackIdentity: selected ? feedbackIdentity(identify(selected, getSelectionScope(selected)).evidence) : null,
      };
    },
    clearSelection,
    get token() {
      return d.token;
    },
    get enabled() {
      return enabled;
    },
    /* NOSONAR: single-pass routine, splitting it would change shared state */ update(next, nextReport) {
      const previousError = d.inspectionError;
      const previousScope = selected ? getSelectionScope(selected) : null;
      d =
        nextReport?.sourceRevision !== undefined &&
        next.sourceRevision === undefined &&
        (next.inspection ?? next.mirage)?.sourceRevision === undefined
          ? { ...next, sourceRevision: nextReport.sourceRevision }
          : next;
      if (selected && previousScope.sourceRevision !== getSelectionScope(selected).sourceRevision && lastIdentity) {
        const identity = lastIdentity.evidence
          ? {
              ...lastIdentity,
              evidence: {
                ...lastIdentity.evidence,
                source: {
                  ...lastIdentity.evidence.source,
                  status: 'stale',
                  refs: (lastIdentity.evidence.source?.refs ?? []).map((ref) => ({ ...ref, status: 'stale' })),
                },
              },
            }
          : lastIdentity;
        lifecycle('stale', 'source-revision-changed', identity);
        renderCard(true);
      }
      const mismatchedRevision =
        nextReport?.sourceRevision !== undefined &&
        String(nextReport.sourceRevision) !== getSelectionScope(selected).sourceRevision;
      const currentReport =
        next.inspectionError || (next.inspection ?? next.mirage)?.active === false || mismatchedRevision
          ? null
          : nextReport;
      if (currentReport !== undefined && currentReport !== report) {
        report = currentReport;
        needsScan = true;
        if (!report) candidates = [];
        renderCard(true);
        if (selected && report) notifySelection(true, 'fresh-evidence');
        schedule();
      } else if (previousError !== d.inspectionError) renderCard(true);
      if (enabled) renderProgress();
      if (next.ui?.hidden && enabled) toggle(false);
    },
    status: setStatus,
    dispose() {
      disposed = true;
      clearSelection('disposed');
      retainedObserver.disconnect();
      releaseShadowHook?.();
      releaseAnimationHook?.();
      resizeObserver.disconnect();
      cancelAnimationFrame(animationFrame);
      cancelAnimationFrame(frame);
      observer.disconnect();
      guardObserver.disconnect();
      releaseFrames();
      lifetime.abort();
      host.remove();
      if (globalThis.__paqviloXrayUi === host.__px) globalThis.__paqviloXrayUi = null;
    },
  };
}
