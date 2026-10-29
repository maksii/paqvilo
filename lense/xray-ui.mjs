import { inspectionEvidenceRuntime, resolveInspectionEvidence } from './inspection-evidence.mjs';
import { renderInspectionEvidence } from './inspection-evidence-ui.mjs';
import { observePortalNode } from './portal-node-observation.mjs';
import { definitionQuery } from './definition-query.mjs';

// All embedded source is owned code; page data is passed as a separate argument.
export const xrayUi = new Function(
  'data',
  `const {resolveInspectionEvidence}=(${inspectionEvidenceRuntime.toString()})(); const renderInspectionEvidence=(${renderInspectionEvidence.toString()}); const observePortalNode=(${observePortalNode.toString()}); const definitionQuery=(${definitionQuery.toString()}); return (${xrayBrowserImpl.toString()})(data);`,
);

// Self-contained browser function, like panelUi. Never reads page text or input values.
function xrayBrowserImpl(data) {
  if (location.origin !== data.origin || window.__paqviloRetiredSessions?.includes(data.token) || !document.body)
    return;
  let host = document.getElementById('paqvilo-xray');
  // The panel owns the current UI state; server-persisted visibility may lag a shortcut.
  if (host?.__px) {
    host.__px.update({ ...data, ui: undefined });
    return;
  }
  host = document.createElement('div');
  host.id = 'paqvilo-xray';
  host.setAttribute('popover', 'manual');
  host.style.cssText =
    'all:initial!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;pointer-events:none!important;overflow:visible!important;z-index:2147483647!important;';
  document.body.append(host);
  const owningBody = document.body;
  const root = host.attachShadow({ mode: 'open' }),
    sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{color-scheme:normal}*{box-sizing:border-box}.ui{--bg:#fff;--fg:#212529;--muted:#6c757d;--primary:#0d6efd;--link:#0d6efd;--on-primary:#fff;--radius:4px;--line:#d8dfe7;--head-bg:#f3f6fa;--panel-line:rgba(0,0,0,.15);--shadow:0 6px 12px rgba(0,0,0,.18);--font:"Segoe UI",system-ui,sans-serif;font:13px/1.45 var(--font);color:var(--fg);text-align:left;letter-spacing:0}
    button,select{font:inherit;color:inherit}button{cursor:pointer;background:none;border:0;border-radius:var(--radius);padding:4px 7px;text-align:left}button:hover{background:color-mix(in srgb,var(--primary) 8%,var(--bg));color:var(--link)}button:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:2px}button[aria-pressed=true]{color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,var(--bg))}button:disabled{opacity:.4;cursor:default}
    .ui:focus{outline:none}.shield{position:fixed;inset:0;pointer-events:auto;cursor:crosshair}.ui.interact .shield{display:none}.bar,.card,.tip,.legend{background:var(--bg);border:1px solid var(--panel-line);border-radius:var(--radius);box-shadow:var(--shadow)}.bar,.card{pointer-events:auto}.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;padding:6px 8px;max-width:calc(100vw - 16px);white-space:nowrap}.brand{display:flex;align-items:center;gap:8px;padding-right:7px}.brand strong{color:var(--link);font-size:14px}.brand span{color:var(--muted)}.hint,.muted{color:var(--muted)}.hint{font-size:11px}.bar select{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:4px;max-width:142px}.exit{font-size:18px;line-height:1}
    .card{position:fixed;right:12px;top:64px;width:410px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 80px);display:flex;flex-direction:column;overflow:hidden}.card[hidden],.tip[hidden]{display:none}.cardhead{display:flex;gap:6px;align-items:center;padding:9px 10px 9px 12px;border-bottom:1px solid var(--line);background:var(--head-bg);cursor:move;touch-action:none}.grow{flex:1;min-width:0}.eyebrow{font-size:11px;color:var(--muted)}.title{font-size:14px;font-weight:600;overflow-wrap:anywhere}.cardhead button{padding:3px 7px}.content{overflow:auto;overscroll-behavior:contain;min-height:0;padding:0 12px 12px;scrollbar-width:thin}.section{margin-top:12px}.section h3{font-size:12px;font-weight:600;margin:0 0 6px}.section h3 small{font-size:11px;font-weight:400;color:var(--muted)}.binding{padding:7px 9px;background:color-mix(in srgb,var(--primary) 6%,var(--bg));border-left:3px solid var(--primary)}.binding strong{font-weight:600;display:block;overflow-wrap:anywhere}.binding .muted{font-size:11.5px;margin-top:3px}.details{display:grid;grid-template-columns:66px 1fr;gap:4px 8px;margin:7px 0;font-size:12px}.details dt{color:var(--muted)}.details dd{margin:0;overflow-wrap:anywhere}.source{padding:7px 0;border-bottom:1px solid var(--line)}.source:last-child{border-bottom:0}.source .name{display:flex;align-items:center;gap:7px}.source .name b{font-weight:500;flex:1;overflow-wrap:anywhere}.badge{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:3px;padding:0 4px;flex:none}.mono{font:11.5px/1.5 Consolas,monospace;overflow-wrap:anywhere;color:var(--muted)}.source .mono{margin-top:3px}.source .actions{display:flex;gap:5px;margin-top:4px}.source button{padding:2px 5px;color:var(--link);font-size:11.5px}.note{font-size:11.5px;color:var(--muted);margin:4px 0 0;line-height:1.5}.foot{display:flex;align-items:center;gap:4px;padding:5px 8px;border-top:1px solid var(--line);background:var(--head-bg)}.foot button{font-size:11.5px}.foot .hint{margin-left:auto}.status{padding:0 12px 7px;font-size:11.5px;color:var(--muted)}.status:empty{display:none}
    details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:12px;padding:4px 0}.crumb[data-depth='1']{padding-left:15px}.crumb[data-depth='2']{padding-left:23px}.crumb[data-depth='3']{padding-left:31px}.crumb[data-depth='4']{padding-left:39px}.crumb[data-depth='5']{padding-left:47px}.crumb[data-depth='6']{padding-left:55px}.crumb{display:block;width:100%;text-align:left;font:11px Consolas,monospace;margin-top:3px;overflow-wrap:anywhere}.welcome{padding:12px}.welcome .hero{font-size:14px;font-weight:600;margin:0 0 6px}.welcome p{margin:5px 0}.welcome .counts{padding-top:8px;border-top:1px solid var(--line);margin-top:10px}.empty{padding:12px 0}.empty b{display:block}.marks{position:fixed;inset:0;pointer-events:none}.mark{position:fixed;border:1px solid var(--tone,var(--primary));background:transparent;pointer-events:none}.selected{border:2px solid var(--primary);background:color-mix(in srgb,var(--primary) 6%,transparent)}.hover{border:2px dashed var(--primary);background:color-mix(in srgb,var(--primary) 3%,transparent)}.tip{position:fixed;pointer-events:none;max-width:370px;padding:5px 8px;font-size:12px;overflow-wrap:anywhere}.tip b{display:block;font-weight:600}.tip .mono{font-size:11px}.legend{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);pointer-events:none;font-size:11px;color:var(--muted);padding:5px 9px;max-width:calc(100vw - 16px)}.legend i{display:inline-block;width:7px;height:7px;margin:0 4px 0 10px}.legend i:first-child{margin-left:0}.legend .tone-field{background:#29805b}.legend .tone-component{background:#3975ad}.legend .tone-content{background:#947330}kbd{font:10px Consolas,monospace;border:1px solid var(--line);padding:0 3px;border-radius:2px}
    .scan-wash{position:fixed;inset:0;pointer-events:none;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--primary) 7%,transparent),transparent);height:45vh;bottom:auto;animation:xray-scan 2.8s ease-in-out infinite}.scan-state{position:fixed;left:50%;bottom:55px;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);padding:14px 18px;display:flex;align-items:center;gap:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);pointer-events:auto}.scan-state strong{display:block;font-weight:600}.scan-state p{margin:2px 0 0;color:var(--muted);font-size:12px}.scan-state button{margin-left:8px;color:var(--link);border:1px solid var(--line)}.scan-orbit{display:inline-block;width:24px;height:24px;flex:none;border:2px solid var(--line);border-top-color:var(--primary);border-radius:50%;animation:xray-orbit .9s linear infinite}.scan-state.error .scan-orbit{animation:none;border-color:var(--muted);border-radius:4px}.scan-state[hidden],.scan-wash[hidden]{display:none}.ui.loading .tip{display:none}.ui.loading .legend{opacity:.7}@keyframes xray-scan{from{transform:translateY(-100%)}to{transform:translateY(100vh)}}@keyframes xray-orbit{to{transform:rotate(360deg)}}
    @media(max-width:850px){.bar{top:8px;gap:3px;padding:5px}.bar .hint,.brand span{display:none}.brand{padding-right:3px}.bar button{font-size:11.5px;padding:4px}.bar select{max-width:118px;font-size:11px}.card{top:auto;bottom:44px;max-height:46dvh;width:380px;right:8px}.scan-state{bottom:55px}.ui:has(.card:not([hidden])) .scan-state{bottom:auto;top:55px}.legend{bottom:8px;font-size:10px}.legend .hint{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important}.scan-wash{transform:translateY(25vh)}}
  `);
  const evidenceSheet = new CSSStyleSheet();
  evidenceSheet.replaceSync(renderInspectionEvidence(null, { part: 'styles' }));
  root.adoptedStyleSheets = [sheet, evidenceSheet];
  root.innerHTML = `<div class="ui" hidden><div class="shield"></div><div class="marks"></div><div class="bar" role="toolbar" aria-label="Lense X-ray"><div class="brand"><strong>paqvilo</strong><span>X-ray</span></div><button data-action="mode" aria-pressed="true">Inspect</button><select aria-label="Highlight layer"><option value="all">All sources</option><option value="data">Forms & data</option><option value="content">Templates & content</option><option value="none">Selection only</option></select><button data-action="details" aria-pressed="true" title="Show or hide source details">Details</button><button data-action="refresh" aria-label="Refresh source inspection" title="Refresh sources and component bindings">↻</button><span class="hint"><kbd>Ctrl</kbd> interact</span><button class="exit" data-action="exit" aria-label="Turn off X-ray">×</button></div><aside class="card" aria-label="Lense source details"></aside><div class="tip" hidden></div><div class="legend"><i class="tone-field"></i>Fields<i class="tone-component"></i>Forms & views<i class="tone-content"></i>Source markup <span class="hint"> · click to select · <kbd>Esc</kbd> back · background limits: 800 candidates / 250 outlines</span></div></div>`;

  const ui = root.querySelector('.ui'),
    marks = root.querySelector('.marks'),
    card = root.querySelector('.card'),
    tip = root.querySelector('.tip');
  const backgroundMarks = document.createElement('div'),
    selectedMark = document.createElement('div'),
    selectedFormMark = document.createElement('div'),
    hoverMark = document.createElement('div');
  selectedMark.className = 'mark selected';
  selectedFormMark.className = 'mark enclosing-form';
  hoverMark.className = 'mark hover';
  marks.append(backgroundMarks);
  const wash = document.createElement('div');
  wash.className = 'scan-wash';
  wash.hidden = true;
  wash.setAttribute('aria-hidden', 'true');
  ui.prepend(wash);
  const scanState = document.createElement('div');
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
  const uiEpoch = (Number.isSafeInteger(window.__paqviloInspectionEpoch) ? window.__paqviloInspectionEpoch : 0) + 1;
  window.__paqviloInspectionEpoch = uiEpoch;
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
    const doc = node?.ownerDocument ?? document,
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
    listen(window, type, fn, options);
    viewListeners.push([type, fn, options]);
  };
  const watchFrame = (doc) => {
    if (!frameViews.has(doc)) {
      const controller = new AbortController();
      for (const [type, fn, options] of viewListeners)
        doc.defaultView.addEventListener(type, fn, { ...options, signal: controller.signal });
      frameViews.set(doc, controller);
      const release = hookShadowView(doc.defaultView);
      if (release) frameShadowHooks.set(doc, release);
    }
    if (enabled && !frameAnimationHooks.has(doc)) {
      const release = hookAnimationView(doc.defaultView);
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
      for (const node of record.addedNodes) if (node.nodeType === 1 && !own(node)) watchFrames(node);
  });
  const watchFrames = (surface = document, depth = 0) => {
    if (disposed || depth > 40) return;
    if (surface.nodeType !== 1) guardObserver.observe(surface, { subtree: true, childList: true });
    for (const node of [surface, ...surface.querySelectorAll('*')]) {
      if (node.shadowRoot && !own(node)) {
        shadowRoots.add(node.shadowRoot);
        watchFrames(node.shadowRoot, depth + 1);
      }
      if (node.localName === 'iframe' && !own(node) && !frameElements.has(node)) {
        const controller = new AbortController();
        // Frame load is not composed across a shadow boundary. Listen on the
        // embedding element in capture phase, independently of geometry scans.
        node.addEventListener(
          'load',
          () => {
            pruneFrames();
            watchFrames(node);
          },
          { capture: true, signal: controller.signal },
        );
        frameElements.set(node, controller);
      }
      const inner = node.localName === 'iframe' && frameDocument(node);
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
      if (!enabled || disposed || interacting || ctrl || !document.hasFocus() || own(document.activeElement)) return;
      ui.focus({ preventScroll: true });
      // ponytail: a cross-origin (out-of-process) frame keeps browser focus past the microtask; reclaim it one task later. Input in that task is a platform boundary.
      setTimeout(() => {
        if (enabled && !disposed && !interacting && !ctrl && root.activeElement === ui) {
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
    ctrl = false,
    selected = null,
    hover = null,
    layer = 'all',
    details = true,
    frame = 0,
    candidates = [],
    needsScan = true,
    detailsDirty = false,
    pointer = { x: 0, y: 0 },
    drag = null,
    disposed = false;
  let oneShot = false,
    candidateLimit = false,
    pickGesture = false,
    pendingPick = null,
    warmup = false;
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
      d.inspectionError || (inspection?.active === false ? inspection.error || 'Source inspection is unavailable.' : '')
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
    const html = error
      ? `<span class="scan-orbit" aria-hidden="true"></span><div><strong>Source inspection unavailable</strong><p>Details: ${esc(error)}</p></div><button data-action="refresh">Retry</button>`
      : `<span class="scan-orbit" aria-hidden="true"></span><div><strong>${report ? 'Updating source inspection' : pending ? 'Reading local sources' : 'Preparing X-ray'}</strong><p>${esc((d.inspection ?? d.mirage)?.phase ?? (report ? 'Previous details remain visible while sources update.' : 'Matching rendered elements to their origins.'))} You can exit at any time.</p></div>`;
    if (scanState.innerHTML !== html) scanState.innerHTML = html;
    scanState.classList.toggle('error', Boolean(error));
    const refresh = root.querySelector('.bar [data-action="refresh"]');
    refresh.disabled = Boolean(pending);
    refresh.setAttribute('aria-busy', String(Boolean(pending)));
  };
  const own = (node) =>
    node === host ||
    node?.closest?.('#paqvilo-panel,#paqvilo-handle,#paqvilo-xray') ||
    ['paqvilo-panel', 'paqvilo-handle', 'paqvilo-xray'].includes(node?.getRootNode?.()?.host?.id);
  const label = (node) =>
    `${node.localName}${node.id ? '#' + node.id.slice(0, 160) : ''}${!node.id && node.classList?.length ? '.' + [...node.classList].slice(0, 2).join('.') : ''}`;
  const descent = new WeakMap();
  const child = (node) =>
    descent.get(node)?.isConnected && parent(descent.get(node)) === node
      ? descent.get(node)
      : node?.localName === 'iframe'
        ? frameDocument(node)?.body
        : [...(node?.shadowRoot?.children ?? node?.children ?? [])].find(
            (item) => !item.matches('style,script,link') && !own(item),
          );
  const frameOf = (doc) => {
    try {
      return doc?.defaultView?.frameElement ?? null;
    } catch {
      return null;
    }
  };
  const frameDocument = (node) => {
    try {
      const doc = node.contentDocument;
      return doc?.documentElement ? doc : null;
    } catch {
      return null;
    }
  };
  const liveNode = (node) => {
    if (!node?.isConnected) return false;
    let doc = node.ownerDocument;
    for (let depth = 0; doc !== document && depth < 40; depth++) {
      const frame = frameOf(doc);
      if (!frame?.isConnected || frameDocument(frame) !== doc) return false;
      doc = frame.ownerDocument;
    }
    return doc === document;
  };
  const parent = (node) =>
    node?.assignedSlot ?? node?.parentElement ?? node?.getRootNode?.()?.host ?? frameOf(node?.ownerDocument) ?? null;
  const lineage = (node) => {
    const rows = [];
    for (let current = node; current; current = parent(current)) rows.push(current);
    return rows;
  };
  const labelledControl = (node) => {
    const labelNode = lineage(node).find((item) => item.localName === 'label');
    const labelScope = labelNode?.closest(
      '[data-formid],[data-form-layout],[id^="EntityFormControl"],[id^="WebFormControl"],[data-entityname],[data-entity],form',
    );
    return labelNode?.htmlFor
      ? ([...(labelScope ?? labelNode.parentElement ?? document).querySelectorAll('[id]')].find(
          (item) => item.id === labelNode.htmlFor,
        ) ?? null)
      : (labelNode?.querySelector('input,select,textarea,output') ?? null);
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
  const gridColumn = (node) => {
    const cell = node.closest('td,th,[data-paqvilo-column]'),
      table = cell?.closest('table');
    if (!table) return null;
    // A scroll-head clone can opt into the original grid by ID. Do not guess
    // from a shared wrapper, column name or page-wide requests.
    const boundId = table.getAttribute('data-paqvilo-grid');
    const boundMatches = boundId ? [...table.getRootNode().querySelectorAll('#' + CSS.escape(boundId))] : [table];
    const boundTable = boundMatches.length === 1 ? boundMatches[0] : null;
    if (!boundTable || boundTable.localName !== 'table') return null;
    const declared = cell.getAttribute('data-paqvilo-column');
    const view = table.ownerDocument.defaultView,
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
    const headerIndex = /^\d+$/.test(cell.getAttribute('data-dt-column') ?? '')
      ? Number(cell.getAttribute('data-dt-column'))
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
    return { name: name.toLowerCase(), table: boundTable.getAttribute('data-paqvilo-table') ?? '' };
  };
  const binding = (node, resolveHost = true) => {
    if (report?.modelDriven) {
      const context = report.modelDriven,
        catalogue = context.catalogue;
      const chain = lineage(node),
        nativeId = chain.find((item) => item.hasAttribute('data-id'))?.getAttribute('data-id') ?? '';
      // Native fields carry data-id; a labelled form control without one (such as the
      // loopback app) is identified only by its own name. An empty identifier matches nothing.
      const control = nativeId
        ? null
        : (labelledControl(node) ?? (node.matches('input,select,textarea') ? node : null));
      const fieldName = nativeId ? nativeId.split('.')[0] : (control?.getAttribute('name') ?? '');
      // Parent app context does not establish ownership inside an embedded document.
      const sameDocument = node.ownerDocument === document;
      const exact = sameDocument ? (report.forms ?? []).filter((form) => norm(form.id) === norm(context.formId)) : [];
      const forms = sameDocument ? (exact.length ? exact : (report.forms ?? [])) : [];
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
      const fields = listPage
        ? listFields
        : fieldName && !subgridId
          ? forms.flatMap((form) =>
              (report.columns ?? []).filter(
                (column) =>
                  column.formId === form.id &&
                  (nativeId ? [column.name, column.controlId] : [column.name]).includes(fieldName),
              ),
            )
          : [];
      const code = fields.flatMap((field) => {
        const form = forms.find((item) => item.id === field.formId),
          control = form?.controls.find((item) => item.name === field.name);
        return control?.pcf
          ? [
              {
                schemaName: control.pcf.name,
                field: field.name,
                entity: field.entity,
                binding: exact.length
                  ? 'native-form-id + control identifier'
                  : 'candidate-table-form + control identifier',
                formSource: { name: form.name, ref: form.ref },
                resources: (report.assets ?? []).filter((asset) => asset.name.startsWith(control.pcf.name + '/')),
              },
            ]
          : [];
      });
      const commandLocation =
        context.pageType === 'entitylist'
          ? 'grid'
          : context.formId || context.formType != null || context.pageType === 'entityrecord'
            ? 'form'
            : null;
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
        const name = /^(.*)_(?:ControlView|Container)$/i.exec(item.id)?.[1];
        return name && (report?.columns ?? []).some((column) => norm(column.name) === norm(name));
      });
    // The containing frame may supply its form ID; host-page forms are a separate context.
    if (node.ownerDocument !== document) {
      const boundary = chain.findIndex(
        (item, index) => item.localName === 'iframe' && (!richHost || index > chain.indexOf(richHost)),
      );
      if (boundary >= 0) chain.splice(boundary + 1);
    }
    const documentContext = (doc) => {
      try {
        const url = new URL(doc.URL);
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
                [form.id, form.formXml?.id].some((value) => norm(value) === norm(id)) &&
                [form.id, form.formXml?.id].some((value) => norm(value) === norm(forms[0])),
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
        .replace(/-/g, '')
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
        ...pageLists,
        ...(report?.componentIndex?.lists ?? []).filter(
          (list) => !pageLists.some((known) => norm(known.id ?? known.recordId) === norm(list.id ?? list.recordId)),
        ),
      ];
    const nativeAt = (current) =>
      allForms.filter((form) =>
        ['EntityFormControl_', 'WebFormControl_'].some(
          (prefix) =>
            current.id === prefix + compact(form.id) || current.id === prefix + compact(form.id) + '_EntityFormView',
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
          current.getAttribute('data-form-layout') ??
            current.querySelector(':scope > [data-form-layout]')?.getAttribute('data-form-layout') ??
            '{}',
        );
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) shape = parsed;
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
      const value = (name) => current.getAttribute(name) ?? '';
      const scopedFrame = current.localName === 'iframe' ? frameDocument(current) : null;
      const frameContext = scopedFrame ? documentContext(scopedFrame) : {};
      if (
        frameContext.conflict ||
        (current.ownerDocument !== document && documentContext(current.ownerDocument).conflict)
      )
        conflict = true;
      const tableDeclarations = [
        value('data-entityname'),
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
      if (current.localName === 'iframe') {
        try {
          const url = new URL(current.getAttribute('src'), current.ownerDocument.baseURI);
          if (scopedFrame && /^https?:/i.test(scopedFrame.URL)) frameForm = frameContext.formId || '';
          else if (url.origin === location.origin) frameForm = documentContext({ URL: url.href }).formId || '';
        } catch {
          /* Optional inspection or cleanup failure must not interrupt the owning operation. */
        }
      }
      const fallbackForm = /^EntityFormControl(?:_EntityFormView)?$/.test(current.id)
        ? current.ownerDocument === document
          ? (report?.page?.entityFormId ?? report?.page?.basicFormId ?? '')
          : documentForm(current.ownerDocument)
        : '';
      const fallbackList =
        current.ownerDocument === document && /^EntityListControl$/.test(current.id)
          ? (report?.page?.listId ?? '')
          : '';
      const fid = value('data-formid') || String(shape.Id ?? '') || frameForm || fallbackForm;
      for (const declaredForm of [value('data-formid'), shape.Id, frameForm, fallbackForm].filter(Boolean)) {
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
      let vid = value('data-viewid') || value('data-selected-view');
      if (!vid && current.hasAttribute('data-view-layouts'))
        try {
          const layouts = JSON.parse(atob(value('data-view-layouts')));
          if (Array.isArray(layouts) && layouts.length === 1) vid = String(layouts[0].Id ?? layouts[0].id ?? '');
        } catch {
          /* Optional inspection or cleanup failure must not interrupt the owning operation. */
        }
      let lid =
        value('data-listid') ||
        /^EntityList(?:Control_)?([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:$|_)/i.exec(
          current.id,
        )?.[1] ||
        fallbackList;
      let inferredList = Boolean(fallbackList && !value('data-listid'));
      if (!lid && current.matches('.entitylist,.entity-grid') && !current.closest('.subgrid')) {
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
      const nextForms = recordForms.length
        ? recordForms
        : nativeForms.length
          ? nativeForms
          : allForms.filter((item) => fid && norm(item.formXml?.id) === norm(fid));
      const nextViews = (report?.views ?? []).filter((item) => vid && norm(item.id) === norm(vid));
      const nextLists = allLists.filter((item) => lid && compact(item.recordId ?? item.id) === compact(lid));
      const nextFamily = vid || lid ? 'collection' : fid || nativeForms.length ? 'form' : '';
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
        if (current.localName === 'iframe' || (nextForms.length && (fid || nativeForms.length))) conflict = true;
        break;
      }
      if (
        entities.length > 1 ||
        (declared && inferred && norm(declared) !== norm(inferred)) ||
        (value('data-entityname') && shape.EntityName && norm(value('data-entityname')) !== norm(shape.EntityName))
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
    const fieldAttributes = [
      'data-attribute',
      'data-field',
      'data-fieldname',
      'data-pcf-native-field',
      'data-th',
      'data-lookup-datafieldname',
    ];
    const explicit = scope.find((item) => fieldAttributes.some((name) => item.hasAttribute(name)));
    const control = labelled ?? scope.find((item) => item.matches('input,select,textarea,output'));
    const grid = gridColumn(node);
    const names = explicit
      ? fieldAttributes.map((key) => explicit.getAttribute(key)).filter(Boolean)
      : grid
        ? [grid.name]
        : control
          ? [control.id, control.getAttribute('name')].filter(Boolean)
          : [];
    const hostContext = richHost ? binding(richHost, false) : null;
    const hostAgrees =
      hostContext &&
      !hostContext.conflict &&
      (!entity || norm(entity) === norm(hostContext.entity)) &&
      (!forms.length ||
        forms.some((form) => hostContext.forms.some((hostForm) => norm(hostForm.id) === norm(form.id))));
    if (richHost && hostAgrees && (entity || forms.length)) {
      const hostName = /^(.*)_(?:ControlView|Container)$/i.exec(richHost.id)[1];
      if (explicit && names.some((name) => norm(name) !== norm(hostName))) conflict = true;
      names.splice(0, names.length, hostName);
    }
    if (grid?.table) {
      if (entity && norm(grid.table) !== norm(entity)) conflict = true;
      else entity = norm(grid.table);
    }
    if (control && entity) for (const name of [...names]) if (name.includes('$')) names.push(name.split('$').at(-1));
    const cell = control?.closest('.cell,.form-group,td,[data-fieldname]');
    if (cell) {
      for (const name of [...names]) {
        const base = name.replace(
          /_(?:name|entityname|datepicker_description|datepicker|timepicker_description|timepicker|i\d+|option_\d+|\d+|selected|value|container)$/i,
          '',
        );
        if (
          base !== name &&
          ([...cell.querySelectorAll('input')].some(
            (item) =>
              (item.id === base || item.name === base) &&
              (item.type === 'hidden' || /_(?:date|time)picker(?:_description)?$/i.test(name)),
          ) ||
            (control.matches('input[type=radio],input[type=checkbox]') &&
              chain.some((item) => item.id === base && cell.contains(item))))
        )
          names.push(base);
      }
    }
    const fields = conflict
      ? []
      : (report?.columns ?? []).filter(
          (item) =>
            names.some((name) => norm(name) === norm(item.name)) && (!entity || norm(item.entity) === norm(entity)),
        );
    // A grid's table is a binding boundary, but its enclosing form still owns the
    // FormXml control. Resolve ownership separately from the selected row's table.
    const ownerForms =
      chain
        .map((current) => {
          let id = current.getAttribute('data-formid');
          if (!id)
            try {
              id = JSON.parse(current.getAttribute('data-form-layout') ?? '{}')?.Id;
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
          (ancestor) => ancestor.id === item.id || ancestor.getAttribute('data-lookup-datafieldname') === item.id,
        ) &&
        (!ownerForms.length || ownerForms.some((form) => norm(form.id) === norm(item.formId))) &&
        (!item.viewId || !viewId || norm(item.viewId) === norm(viewId)),
    );
    const schema = scope.find((item) => item.hasAttribute('data-pcf-schema'))?.getAttribute('data-pcf-schema');
    const code = (report?.codeComponents ?? []).filter(
      (item) =>
        (schema && norm(item.schemaName) === norm(schema)) ||
        (item.binding === 'native-formxml' &&
          item.selectedDesktop &&
          item.enablement === 'configured' &&
          ownerForms.some((form) => norm(form.id) === norm(item.formId)) &&
          scope.some(
            (node) =>
              node.id === 'PcfControl_' + item.field || node.getAttribute('data-pcf-native-field') === item.field,
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
    /^(?:alert(?:-.+)?|message|form-control|btn(?:-.+)?|close|title|row|container(?:-fluid)?|col-(?:xs|sm|md|lg|xl|xxl)-\d+|modal(?:-.+)?|control-label|input-group(?:-.+)?|clearfix|pull-(?:left|right)|text-(?:left|right|center|muted)|hidden|show|active)$/;
  let rankingReport, frequencies, pageOwners;
  const sourceMatches = (node) => {
    const ancestors = lineage(node).filter((item) => item.ownerDocument === node.ownerDocument),
      rows = [];
    if (rankingReport !== report || !frequencies) {
      rankingReport = report;
      frequencies = new Map();
      pageOwners = new Set(['page']);
      for (const item of report?.elementSources ?? [])
        if (item.matchKind === 'class') {
          let files = frequencies.get(item.selector);
          if (!files) frequencies.set(item.selector, (files = new Set()));
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
        const exactDepth = ancestors.findIndex((ancestor) => ancestor.matches(item.selector));
        const depth =
          exactDepth >= 0
            ? exactDepth
            : item.matchKind === 'class'
              ? ancestors.findIndex(
                  (ancestor) =>
                    ancestor.localName === item.tag &&
                    (item.classes ?? []).some((name) => ancestor.classList.contains(name)),
                )
              : -1;
        if (depth < 0) continue;
        const target = ancestors[depth];
        const locations = item.locations ?? [];
        const matchingTags = locations.filter((location) => !location.tag || location.tag === target.localName);
        const contexts = (matchingTags.length ? matchingTags : locations)
          .map((location) => {
            const agreement = (location.contexts ?? []).filter((selector) =>
                ancestors.slice(depth + 1).some((ancestor) => ancestor.matches(selector)),
              ).length,
              declared = location.classes ?? item.classes ?? [],
              present = declared.filter((name) => target.classList.contains(name)).length;
            let contextual = 0,
              contradictions = 0;
            for (const context of location.ancestors ?? []) {
              const container = ancestors
                .slice(depth + 1)
                .find(
                  (ancestor) =>
                    ancestor.localName === context.tag &&
                    context.classes.some((name) => ancestor.classList.contains(name)),
                );
              if (!container) continue;
              const missing = context.classes.filter((name) => !container.classList.contains(name));
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
          classes = declaredClasses.filter((name) => target.classList.contains(name)),
          meaningful = classes.filter((name) => !framework.test(name));
        const agreed = contexts[0]?.agreement ?? 0,
          tagMatch =
            locations.some((location) => location.tag === target.localName) ||
            !item.tag ||
            item.tag === target.localName;
        const pageChain =
          (item.includedBy ?? item.usedBy)?.some(
            (owner) => owner.startsWith('page-template:') || pageOwners.has(owner),
          ) ?? false;
        const missing = declaredClasses.length - classes.length,
          targetClasses = [...target.classList].filter((name) => !framework.test(name)),
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
          ([key, value]) => target.getAttribute(key) === value,
        ).length;
        // Prefer stronger evidence across adjacent regions, but do not let a distant
        // page-container ID eclipse the distinctive template immediately around a node.
        const score =
          attributeCount * 5 +
          (item.matchKind === 'id'
            ? 110
            : item.matchKind === 'attribute'
              ? 85
              : item.matchKind === 'class'
                ? 35 + classes.length * 5 + meaningful.length * 10
                : 20) +
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
          evidenceLabel: `${item.kind === 'script' ? 'Script reference' : strong ? 'Markup match' : 'Possible match'}: ${item.selector}${depth ? ' on an enclosing element' : ''}${item.occurrences > 1 ? ' · ' + item.occurrences + ' locations in this source' : ''}`,
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
        row.evidenceLabel = row.evidenceLabel.replace('Markup match:', 'Possible match:');
      }
    const ranked = rows.sort(
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
    const output = card.querySelector('.status');
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
    const output = card.querySelector('.status');
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
      view: 'View',
      table: 'Table',
      image: 'Image',
      stylesheet: 'Stylesheet',
      asset: 'Asset',
    })[kind] ??
    kind ??
    'Source';
  const sourceRows = (rows, evidence) =>
    rows
      .map(
        (item) =>
          `<div class="source"><div class="name"><b>${esc(item.name ?? item.label ?? 'Source')}</b><span class="badge">${esc(kindName(item.kind))}</span></div><div class="mono">${esc(item.ref ?? item.url ?? 'Source unavailable')}</div>${item.evidenceLabel || evidence ? `<div class="note">${esc(item.evidenceLabel ?? evidence)}</div>` : ''}${item.ref ? `<div class="actions"><button data-action="open" data-ref="${esc(item.ref)}">Browse file ↗</button><button data-action="copy" data-copy="${esc(item.path ?? item.sourceFile ?? item.ref)}">Copy path</button>${item.depth ? `<button data-action="source-region" data-selector="${esc(item.selector)}">Select matching ancestor</button>` : ''}</div>` : ''}</div>`,
      )
      .join('');
  const disclosureState = new Map(),
    contextPages = new Map();
  const pageRows = (key, rows, render) => {
    const size = 8,
      pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(contextPages.get(key) ?? 0, pages - 1);
    return (
      render(rows.slice(page * size, (page + 1) * size)) +
      (pages > 1
        ? `<div class="actions"><button data-action="context-page" data-context="${esc(key)}" data-page="${page - 1}" ${page ? '' : 'disabled'}>Previous</button><span class="note">${page + 1} / ${pages} · ${rows.length} entries</span><button data-action="context-page" data-context="${esc(key)}" data-page="${page + 1}" ${page < pages - 1 ? '' : 'disabled'}>Next</button></div>`
        : '')
    );
  };
  const emptyEvidenceRefs = [],
    modelHydrations = new Map();
  let indexedEvidenceRows = null,
    evidenceIndex = null,
    evidenceReport = null;
  const sourceEvidenceIndex = () => {
    if (evidenceReport !== report) {
      evidenceReport = report;
      modelHydrations.clear();
    }
    const rows = Array.isArray(report?.portalSources)
      ? report.portalSources
      : Array.isArray(report?.sourceRefs)
        ? report.sourceRefs
        : emptyEvidenceRefs;
    if (rows !== indexedEvidenceRows) {
      indexedEvidenceRows = rows;
      evidenceIndex = { rows, byId: new Map(), byRef: new Map(), byComponent: new Map() };
      for (const ref of rows) {
        evidenceIndex.byId.set(ref.id, ref);
        if (!evidenceIndex.byRef.has(ref.ref)) evidenceIndex.byRef.set(ref.ref, []);
        evidenceIndex.byRef.get(ref.ref).push(ref);
        if (ref.componentKey) {
          if (!evidenceIndex.byComponent.has(ref.componentKey)) evidenceIndex.byComponent.set(ref.componentKey, []);
          evidenceIndex.byComponent.get(ref.componentKey).push(ref);
        }
      }
    }
    return evidenceIndex;
  };
  const portalHydrations = new Set(),
    selectionAnchors = new WeakMap();
  const hydrateModelSelection = (node, scope, anchorGeneration, packets) => {
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
    const key = JSON.stringify([scope, anchorGeneration, active, [...componentKeys].sort()]);
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
          currentState:
            ref.currentState === 'unavailable' || current?.currentState === 'unavailable'
              ? 'unavailable'
              : current
                ? 'available'
                : 'pending',
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
        const api = Object.getOwnPropertyDescriptor(window, '__paqviloModelPanelApi')?.value;
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
  const queryElementEvidence = (node, b, matches, scope) => {
    const anchorGeneration = host.__px?.selectionState?.().anchorGeneration ?? 0;
    const packets = [],
      reasons = [];
    const view = node.ownerDocument.defaultView;
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
          !packet ||
          packet.version !== 1 ||
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
    const hostPage = report?.page;
    if (!d.modelDriven && (hostPage?.id ?? hostPage?.recordId) && liveNode(node))
      facts.push({
        id: 'selected-export-host-page',
        scope,
        dimension: 'enclosing',
        proof: 'export-definition',
        subject: 'selection',
        predicate: node.ownerDocument === document ? 'configured-webpage' : 'webpage-hosting-selected-frame',
        binding: {
          kind: 'webpage',
          key: 'webpage:' + (hostPage.id ?? hostPage.recordId),
          id: hostPage.id ?? hostPage.recordId,
          name: hostPage.name ?? 'Host webpage',
        },
        label:
          node.ownerDocument === document ? 'Selected export webpage' : 'Selected export webpage hosting this frame',
      });
    const hydratedCurrentSourceRefs = hydrateModelSelection(node, scope, anchorGeneration, packets);
    const sourceRefs = packets.flatMap((packet) => packet.sourceRefs ?? []);
    const mode = packets.some((packet) => packet.mode === 'local') || d.mirageMode ? 'local' : 'live';
    const initial = resolveInspectionEvidence({
      version: 1,
      scope,
      mode,
      node: { connected: liveNode(node) },
      facts,
      sourceRefs,
    });
    const anchors = packets.flatMap((packet) => packet.componentAnchors ?? []);
    selectionAnchors.set(node, anchors);
    if (
      !d.modelDriven &&
      node === selected &&
      (initial.owner.status === 'unavailable' || initial.source.status === 'unavailable') &&
      ((node.ownerDocument !== document &&
        node.matches('input:not([type=hidden]):not([type=password]),select,textarea,output,label') &&
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
        label: 'Navigation/export hints disagree; direct current bindings are evaluated separately',
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
      facts.push({
        id: 'enclosing-candidate:' + (item.id ?? item.recordId),
        scope,
        dimension: 'enclosing',
        proof: 'declared-include',
        predicate: 'declares',
        binding: {
          kind: item.kind ?? 'form',
          key: (item.kind ?? 'form') + ':' + (item.id ?? item.recordId),
          id: item.id ?? item.recordId,
          name: item.name,
          entity: item.entity,
        },
      });
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
      const selected = referenced ? [referenced] : item.recordId && semantic.length === 1 ? semantic : [];
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
        label: item.evidenceLabel ?? 'Static export match; rendered ownership unverified',
      });
    }
    for (const packet of packets) {
      for (const availability of packet.availability ?? [])
        if (typeof availability.reason === 'string') reasons.push(availability.reason);
      for (const reason of packet.limits?.reasons ?? []) if (typeof reason === 'string') reasons.push(reason);
    }
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
      reason: 'Oversized source omitted; not attributed',
    }));
    const truncatedScripts = (sourceLimits.scriptTruncatedSources ?? []).map((ref) => ({
      ref,
      reason: 'Script index truncated; not attributed',
    }));
    if (sourceLimits.truncated) reasons.push('export-source-hint-index-truncated');
    if (matches.omitted) reasons.push('additional-source-candidates-omitted');
    return resolveInspectionEvidence({
      version: 1,
      scope,
      mode,
      node: { connected: liveNode(node) },
      facts,
      sourceRefs: distinctRefs,
      currentSourceRefs,
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
      evidenceLabel: (item.evidenceLabel ?? 'Static export candidate').replace('Markup match:', 'Static candidate:'),
    }));
    matches.omitted = matched.omitted;
    const evidence = queryElementEvidence(node, b, matches, scope);
    const owner = evidence.owner.component;
    const exact = evidence.source.refs.find((ref) => ref.status === 'exact');
    const candidate = evidence.candidates.find((item) => item.status === 'candidate')?.component;
    return {
      title:
        owner?.label ??
        owner?.name ??
        owner?.id ??
        exact?.name ??
        (candidate
          ? 'Possible ' + (candidate.label ?? candidate.name ?? candidate.kind)
          : 'Selected ' + node.localName),
      kind: owner
        ? kindName(owner.kind)
        : evidence.source.status === 'exact'
          ? 'Rendered source'
          : evidence.owner.status === 'conflicting'
            ? 'Conflicting owner evidence'
            : 'Owner ' + evidence.owner.status,
      sub: owner
        ? [owner.entity, owner.field ?? owner.controlName].filter(Boolean).join('.')
        : (exact?.ref ?? 'Select a source below or inspect the evidence.'),
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
  const declaredContextHtml = (node, b) => {
    let out = '';
    if (node.matches('img[src],img[srcset],link[href],script[src]')) {
      let pathname;
      try {
        const value =
          node.localName === 'img'
            ? node.currentSrc || node.getAttribute('src')
            : (node.getAttribute('src') ?? node.getAttribute('href'));
        const address = new URL(value, node.ownerDocument.baseURI);
        if (address.origin === location.origin) pathname = address.pathname;
      } catch {
        /* A foreign or malformed resource is not a local definition. */
      }
      const assets = (report?.assets ?? []).filter((item) => item.url === pathname);
      if (assets.length)
        out +=
          '<details open data-disclosure="selected-resource"><summary>Selected resource reference</summary>' +
          sourceRows(assets, 'Rendered resource URL; markup ownership and loaded bytes are separate evidence') +
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
    const definitions = [
      ...new Map(
        definitionRows.map((item) => [
          JSON.stringify([item.ref ?? null, item.id ?? item.recordId ?? item.name, item.kind ?? null]),
          item,
        ]),
      ).values(),
    ];
    if (definitions.length)
      out +=
        '<details data-disclosure="declared-form-definitions"><summary>Exported form / view definitions</summary><p class="note">Configuration relationships and local definitions; selected owner certainty is shown above.</p>' +
        sourceRows(definitions, 'Exported component definition/context') +
        '</details>';
    const commands = b.commands ?? [];
    if (events.length || commands.length)
      out +=
        '<details data-disclosure="declared-handlers"><summary>Declared handlers</summary><p class="note">Exported event and command definitions; execution and selected-element ownership are not inferred.</p>' +
        events
          .map(
            (event) =>
              '<div class="source"><b>' +
              esc(event.form.name) +
              ' · ' +
              esc(event.name) +
              (event.attribute ? ' · ' + esc(event.attribute) : '') +
              (event.active === false ? ' (disabled)' : '') +
              '</b><p class="mono">' +
              (event.handlers ?? [])
                .map((handler) =>
                  esc((handler.enabled === false ? '[disabled] ' : '') + handler.library + ': ' + handler.functionName),
                )
                .join('<br>') +
              '</p></div>',
          )
          .join('') +
        commands
          .map(
            (command) =>
              sourceRows([{ ...command, name: command.label ?? command.id, ref: command.source }], 'Declared command') +
              '<p class="mono">' +
              (command.actions ?? []).map((action) => esc(action.library + ': ' + action.functionName)).join('<br>') +
              '</p>',
          )
          .join('') +
        '</details>';
    if (b.native?.length)
      out +=
        '<details data-disclosure="declared-native"><summary>Exported native controls</summary><p class="note">Exported control and containing form relationships; selected ownership and active mounting require independent evidence.</p>' +
        b.native
          .map(
            (item) =>
              '<dl class="details"><dt>Control</dt><dd>' +
              esc(item.name ?? item.id) +
              '</dd><dt>Form</dt><dd>' +
              esc(item.owner ?? item.formName ?? item.formId ?? 'Unresolved') +
              '</dd>' +
              (item.relationship ? '<dt>Relation</dt><dd>' + esc(item.relationship) + '</dd>' : '') +
              '</dl>' +
              sourceRows(
                [{ ...item, name: kindName(item.kind) + ' definition' }, ...(item.metadataSources ?? [])],
                'Exported native control configuration',
              ),
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
            esc(item.binding ?? 'Unresolved') +
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
              'Exported component binding',
            ) +
            (properties.length
              ? '<details><summary>Manifest properties (' +
                properties.length +
                ')</summary>' +
                properties
                  .map(
                    (property) =>
                      '<div class="note"><b>' +
                      esc(property.name) +
                      '</b> · ' +
                      esc(property['of-type'] ?? property['of-type-group'] ?? 'type unresolved') +
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
                      '<dt>' +
                      esc(name) +
                      '</dt><dd>' +
                      esc(
                        parameter.kind === 'binding'
                          ? 'Column: ' + parameter.column
                          : parameter.kind === 'dataset'
                            ? 'Dataset: ' + (parameter.viewId ?? parameter.entity ?? 'unresolved')
                            : parameter.kind === 'unresolved'
                              ? (parameter.reason ?? 'Unresolved binding')
                              : 'Exported ' + parameter.kind,
                      ) +
                      '</dd>',
                  )
                  .join('') +
                '</dl>'
              : '') +
            sourceRows(item.resources ?? [], 'Declared component resource; serving and execution are not inferred') +
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
                      : 'Table/view binding unresolved',
                  ) +
                  '</p></div>' +
                  sourceRows([dataset], 'Exported dataset definition'),
              )
              .join('')
          );
        })
        .join('');
    if (b.code?.length)
      out +=
        '<details data-disclosure="declared-pcf"><summary>Exported code component bindings</summary><p class="note">Configured properties, parameters, datasets and resources; an active mount requires separate runtime evidence.</p>' +
        codeHtml(b.code) +
        '</details>';
    else if (report?.codeComponents?.length)
      out +=
        '<details class="pcf-context" data-disclosure="pcf-context"><summary>Page code components (' +
        report.codeComponents.length +
        ')</summary><p class="note">Exported page references; no component-to-element ownership or active mount is asserted.</p>' +
        pageRows('pcf', report.codeComponents, codeHtml) +
        '</details>';
    const api = (report?.apiReferences ?? []).filter((item) => !b.entity || norm(item.entity) === norm(b.entity));
    if (api.length)
      out +=
        '<details class="api-context" data-disclosure="api-context"><summary>Web API context · ' +
        api.length +
        '</summary><p class="note">Source references and observed requests are context. No request-to-element ownership is asserted.</p>' +
        pageRows('api', api, (items) =>
          items
            .map(
              (item) =>
                '<div class="binding"><strong>/_api/' +
                esc(item.name) +
                '</strong><p class="note">' +
                esc(item.entity ?? 'Table unresolved') +
                ' · ' +
                (item.evidence === 'observed-api-request' ? 'Observed request' : 'Literal source reference') +
                '</p></div>' +
                sourceRows([item, ...(item.sources ?? [])], 'Web API reference') +
                sourceRows(
                  (report?.permissionRules ?? [])
                    .filter((rule) => item.entity && norm(rule.entity) === norm(item.entity))
                    .map((rule) => ({
                      ...rule,
                      kind: 'permission',
                      evidenceLabel: rule.scope + ' · effective access ' + (rule.effective ?? 'unknown'),
                    })),
                ),
            )
            .join(''),
        ) +
        '</details>';
    const page = report?.page;
    if (report)
      out +=
        '<details class="page-context" data-disclosure="page-context"><summary>Page dependencies' +
        (page ? ' · ' + esc(page.pageName ?? page.name ?? '') : '') +
        '</summary><p class="note">Expected export composition and declared dependencies; neither execution nor selected-element ownership is implied.</p>' +
        '<dl class="details"><dt>Page</dt><dd>' +
        esc(page?.pageName ?? page?.name ?? 'Not in selected export') +
        '</dd><dt>Template</dt><dd>' +
        esc(page?.pageTemplateName ?? report.pageTemplate?.name ?? 'Unresolved') +
        '</dd></dl>' +
        pageRows('page-sources', report.pageSources ?? [], (rows) => sourceRows(rows, 'Page source context')) +
        pageRows('page-assets', report.assets ?? [], (rows) => sourceRows(rows, 'Declared page resource')) +
        pageRows('page-templates', report.webTemplates ?? [], (rows) =>
          sourceRows(
            rows.map((item) => ({ ...item, kind: 'template' })),
            'Declared template dependency',
          ),
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
      renderInspectionEvidence(found.evidence, { context: 'xray', selectedLabel: 'Selected ' + node.localName }) +
      (markup.length
        ? '<details data-disclosure="static-candidates"><summary>Search export markup · ' +
          markup.length +
          ' candidates</summary><p class="note">Static selectors are search suggestions. They do not prove which source rendered this node.</p>' +
          pageRows('markup-candidates', markup, (rows) =>
            sourceRows(rows, 'Static candidate; rendered ownership unverified'),
          ) +
          '</details>'
        : '') +
      (scripts.length
        ? '<details data-disclosure="declared-scripts"><summary>Script references · ' +
          scripts.length +
          '</summary><p class="note">A selector reference or served script does not establish execution or ownership of this element.</p>' +
          pageRows('script-candidates', scripts, (rows) => sourceRows(rows, 'Declared script reference')) +
          '</details>'
        : '') +
      declaredContextHtml(node, found.b)
    );
  };
  const renderCard = (preserve = false, measuredRect) => {
    if (!enabled) return;
    if (!statusCurrent(statusSelection)) {
      statusMessage = '';
      statusSelection = null;
    }
    // details.toggle is queued by the browser; capture the actual disclosure
    // state before replacing a card, even if the next pick arrives first.
    for (const item of card.querySelectorAll('details[data-disclosure]'))
      disclosureState.set(item.dataset.disclosure, item.open);
    // Read portal geometry before revealing or rebuilding the overlay. Otherwise
    // the first selection synchronously lays out both the old and new card.
    const selectedRect = selected ? (measuredRect ?? visibleRect(selected) ?? selected.getBoundingClientRect()) : null;
    renderProgress();
    const focused =
      preserve && root.activeElement && card.contains(root.activeElement) ? { ...root.activeElement.dataset } : null;
    const scroll = preserve ? (card.querySelector('.content')?.scrollTop ?? 0) : 0,
      open = preserve
        ? [...card.querySelectorAll('details[open]')].map(
            (item) => item.dataset.disclosure ?? item.querySelector('summary')?.textContent,
          )
        : [];
    card.hidden = !details || !selected;
    if (!selected) {
      card.innerHTML = `<div class="welcome"><div class="hero">Select a portal element</div><p class="note">Hover or click to identify its template, page source, form, view or Dataverse column.</p><p class="note">Hold <kbd>Ctrl</kbd> to interact with the portal. <kbd>Esc</kbd> clears selection, then exits.</p><p class="note counts">${report ? `${(report.webTemplates ?? []).length} templates · ${(report.forms ?? []).length} forms · ${(report.views ?? []).length} views · ${(report.columns ?? []).length} columns` : esc(d.inspectionError || (d.inspection?.active === false ? d.inspection.error : '') || 'Loading source inspection…')}</p></div>`;
      return;
    }
    const identity = identify(selected, getSelectionScope(selected));
    if (selectedRect.left + selectedRect.width > innerWidth - 434 && selectedRect.left < innerWidth - 12) {
      card.style.left = '12px';
      card.style.right = 'auto';
    } else {
      card.style.left = 'auto';
      card.style.right = '12px';
    }
    card.innerHTML = `<div class="cardhead"><div class="grow"><div class="eyebrow">${esc(identity.kind)}</div><div class="title">${esc(identity.title)}</div>${renderInspectionEvidence(identity.evidence, { part: 'headline' })}</div><button data-action="dock" title="Move details to the other side" aria-label="Move details">⇄</button><button data-action="clear" aria-label="Clear selection">×</button></div><div class="content">${selected.localName === 'iframe' ? '<p class=note>Frame boundary · accessible same-origin controls can be selected directly; cross-origin and sandbox restrictions remain in force. Open an inaccessible inner document in its own tab for control details.</p><button data-action="frame-open">Open frame in new tab</button>' : ''}${sourcesHtml(selected)}<details class="ancestry"><summary>Element & ancestry</summary><div class="mono element-label">${esc(label(selected))}</div><p class="note">Select an enclosing element to inspect its source. [ and ] cycle overlapping elements.</p>${lineage(
      selected,
    )
      .map(
        (node, index) =>
          `<button class="crumb" data-action="ancestor" data-index="${index}" data-depth="${Math.min(index, 6)}">${index ? '↳ ' : ''}${esc(label(node))}</button>`,
      )
      .join(
        '',
      )}${selected.localName === 'iframe' ? '<p class="note">Frame boundary: inner inspection requires an accessible same-origin document; cross-origin and sandbox restrictions are preserved.</p>' : ''}</details></div><div class="status" role="status"></div><div class="foot"><button data-action="parent" ${!parent(selected) || own(parent(selected)) ? 'disabled' : ''}>↑ Parent</button><button data-action="child" ${!child(selected) ? 'disabled' : ''}>↓ Child</button><button data-action="reveal">Reveal</button><span class="hint">Esc to release</span></div>`;
    // New content already starts at zero. Writing scrollTop=0 would force its first
    // layout during selection even though there is no scroll position to restore.
    card.querySelector('.status').textContent = statusMessage;
    for (const item of card.querySelectorAll('details'))
      if (disclosureState.has(item.dataset.disclosure)) item.open = disclosureState.get(item.dataset.disclosure);
      else if (open.includes(item.dataset.disclosure ?? item.querySelector('summary')?.textContent)) item.open = true;
    const body = card.querySelector('.content');
    if (body && scroll) body.scrollTop = scroll;
    if (focused)
      [...card.querySelectorAll('button,summary,select,input,a[href]')]
        .find((item) => Object.entries(focused).every(([key, value]) => item.dataset[key] === value))
        ?.focus({ preventScroll: true });
  };
  // Rectangles live outside portal layout. Clip to each scroll container without changing its CSS.
  function visibleRect(node) {
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
    const doc = node.ownerDocument,
      view = doc.defaultView;
    const rect = node.getBoundingClientRect();
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
    let escape = style.position === 'fixed' ? 'fixed' : style.position === 'absolute' ? 'absolute' : '';
    for (const ancestor of lineage(parent(node)).filter((item) => item.ownerDocument === doc)) {
      const css = styleFor(ancestor);
      if (css.display === 'none' || css.opacity === '0') return null;
      if (escape && (establishesFixed(css) || (escape === 'absolute' && css.position !== 'static'))) escape = '';
      if (!escape && ancestor !== doc.body && ancestor !== doc.documentElement) {
        const r = ancestor.getBoundingClientRect(),
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
    const r = node.getBoundingClientRect(),
      sx = r.width / node.offsetWidth || 1,
      sy = r.height / node.offsetHeight || 1,
      outer = frameOf(node.ownerDocument);
    const local = { x: r.left + node.clientLeft * sx, y: r.top + node.clientTop * sy, sx, sy };
    if (!outer) return local;
    const p = frameOrigin(outer);
    return { x: p.x + local.x * p.sx, y: p.y + local.y * p.sy, sx: sx * p.sx, sy: sy * p.sy };
  }
  // CSSOM geometry: a strict page CSP blocks style attributes parsed from markup.
  const rectNode = (r, tone) => {
    const mark = document.createElement('div');
    mark.className = 'mark';
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
  const category = (node) =>
    node.matches(
      'input,select,textarea,[data-field],[data-attribute],[data-fieldname],[data-pcf-native-field],[data-th]',
    )
      ? 'field'
      : node.matches(
            'form,[data-formid],[data-form-layout],[data-viewid],[data-selected-view],[data-listid],[data-pcf-schema],.entity-grid',
          )
        ? 'component'
        : 'content';
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
    releaseShadowHook = hookShadowView(window);
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
    releaseAnimationHook = hookAnimationView(window);
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
  const scan = () => {
    // Rebuild observed roots so detached components are not retained indefinitely.
    observer.disconnect();
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: identityAttributes,
    });
    const selector =
      'input:not([type=hidden]),select,textarea,form,[data-formid],[data-form-layout],[data-viewid],[data-selected-view],[data-view-layouts],[data-listid],.entitylist,.entity-grid,[data-entityname],[data-field],[data-attribute],[data-fieldname],[data-pcf-native-field],[data-pcf-schema],[data-th],[role=dialog],dialog,iframe';
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
      const local = node.getBoundingClientRect(),
        view = node.ownerDocument.defaultView;
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
      for (const embedding of surface.querySelectorAll('iframe')) {
        const inner = frameDocument(embedding);
        if (inner && !roots.includes(inner)) {
          roots.push(inner);
          watchFrame(inner);
        }
      }
      if (!visibleOverflow)
        for (const node of surface.querySelectorAll(selector)) {
          addCandidate(node);
          if (visibleOverflow) break;
        }
      const nodes = surface.querySelectorAll('*'),
        start = discoveryCursors.get(surface) ?? 0,
        budget = Math.min(
          nodes.length,
          surface === document ? 4000 : Math.max(100, Math.floor(4000 / Math.max(1, roots.length - 1))),
        );
      for (let offset = 0; offset < budget; offset++) {
        const node = nodes[(start + offset) % nodes.length];
        if (node.shadowRoot && !own(node)) {
          if (!roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
          shadowRoots.add(node.shadowRoot);
          observer.observe(node.shadowRoot, {
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
          for (const node of surface.querySelectorAll(hintSelector)) {
            addCandidate(node);
            if (visibleOverflow) break;
          }
        } catch {
          /* Optional inspection or cleanup failure must not interrupt the owning operation. */
        }
      }
    }
    candidates = [...visible, ...fallback].slice(0, 800);
    candidateLimit = observed > 800;
    root.querySelector('.legend .hint').textContent =
      ' · click to select · Esc back' + (candidateLimit ? ' · Candidate limit reached (800)' : '');
    needsScan = false;
    // Frame animations may already be running when their documents are discovered.
    animate();
  };
  const paint = () => {
    frame = 0;
    if (!enabled || disposed || document.hidden) return;
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
      const welcome = card.querySelector('.hero');
      if (welcome) welcome.textContent = 'Element removed';
      const note = card.querySelector('.note');
      if (note) note.textContent = 'The selected element was replaced or removed. Select a rendered element again.';
    }
    if (hover && !liveNode(hover)) hover = null;
    if (detailsDirty && selected) {
      detailsDirty = false;
      renderCard(true);
      notifySelection(true);
    }
    if (needsScan && report) scan();
    const background = document.createDocumentFragment();
    let count = 0;
    if (layer !== 'none')
      for (const node of candidates) {
        const type = category(node);
        if ((layer === 'data' && type === 'content') || (layer === 'content' && type !== 'content')) continue;
        const r = visibleRect(node);
        if (!r || r.width < 4 || r.height < 4 || backgroundClipped(node) || isOccluded(node, r)) continue;
        background.append(rectNode(r, type === 'field' ? '#29805b' : type === 'component' ? '#3975ad' : '#947330'));
        if (++count >= 250) break;
      }
    backgroundMarks.replaceChildren(background);
    updateMark(selectedMark, selected, '#76f1df');
    let formContext = null;
    for (const anchor of selectionAnchors.get(selected) ?? []) {
      if (
        !/^(?:basic-form|advanced-form):/.test(anchor.componentKey ?? '') ||
        !Number.isSafeInteger(anchor.ancestorDepth)
      )
        continue;
      let current = selected;
      for (let depth = 0; current && depth < anchor.ancestorDepth; depth++)
        current = current.assignedSlot ?? current.parentElement ?? current.getRootNode?.()?.host;
      if (
        current?.ownerDocument === selected?.ownerDocument &&
        current.localName === anchor.localName &&
        current.id === anchor.id
      ) {
        formContext = current;
        selectedFormMark.dataset.componentKey = anchor.componentKey;
        break;
      }
    }
    updateMark(selectedFormMark, formContext, '#3975ad');
    updateMark(hoverMark, hover !== selected && !interacting && !ctrl ? hover : null, '#c0b0ff');
    const target = hover ?? selected,
      r = target && visibleRect(target);
    tip.hidden = !report || !r || interacting || ctrl;
    if (!tip.hidden) {
      const identity = identify(target),
        b = identity.b;
      tip.innerHTML = `<span class="note">${esc(identity.kind)}</span><b>${esc(identity.title)}</b><div class="mono">${esc(identity.sub)}</div>${b.fields.length === 1 && b.forms.length ? `<div class="note">${b.formCertain ? 'Form' : 'Form candidate' + (b.forms.length > 1 ? 's' : '')}: ${esc(b.forms.length === 1 ? b.forms[0].name : b.forms.length + ' configurations')}</div>` : ''}`;
      const tr = tip.getBoundingClientRect();
      tip.style.left = Math.max(8, Math.min(innerWidth - tr.width - 8, r.left)) + 'px';
      tip.style.top = Math.max(58, Math.min(innerHeight - tr.height - 8, r.top - tr.height - 8)) + 'px';
    }

    geometryCache = null;
    styleCache = null;
  };
  const ensureHost = () => {
    if (disposed) return false;
    if (host.isConnected) return true;
    const existing = document.getElementById('paqvilo-xray');
    if (
      host.parentElement?.matches('dialog') &&
      document.body === owningBody &&
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
    if (enabled && !document.hidden && !frame) frame = requestAnimationFrame(paint);
  };
  const hitStack = (x, y) => {
    const stack = [],
      seen = new Set();
    const add = (node, depth = 0, px = x, py = y) => {
      if (own(node) || seen.has(node)) return;
      seen.add(node);
      if (node.shadowRoot)
        observer.observe(node.shadowRoot, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: identityAttributes,
        });
      if (node.shadowRoot && depth < 40)
        for (const inner of node.shadowRoot.elementsFromPoint(px, py))
          if (inner.getRootNode() === node.shadowRoot) add(inner, depth + 1, px, py);
      if (node.localName === 'iframe' && depth < 40) {
        const doc = frameDocument(node),
          r = node.getBoundingClientRect(),
          sx = r.width / node.offsetWidth || 1,
          sy = r.height / node.offsetHeight || 1,
          ix = (px - r.left) / sx - node.clientLeft,
          iy = (py - r.top) / sy - node.clientTop;
        if (doc && ix >= 0 && iy >= 0 && ix < node.clientWidth && iy < node.clientHeight)
          for (const inner of doc.elementsFromPoint(ix, iy)) add(inner, depth + 1, ix, iy);
      }
      stack.push(node);
    };
    for (const node of document.elementsFromPoint(x, y)) add(node);
    return stack;
  };
  const underPointer = (x, y) => hitStack(x, y)[0];
  let modalOrder = [];
  const topLayer = (force = false) => {
    modalOrder = modalOrder.filter((node) => node.isConnected && node.matches(':modal'));
    const modal =
      modalOrder.at(-1) ??
      document.activeElement?.closest('dialog:modal') ??
      [...document.querySelectorAll('dialog:modal')].at(-1);
    const container = modal ?? document.body;
    const moved = host.parentElement !== container;
    if (moved) container.append(host);
    if (enabled) {
      try {
        const open = host.matches(':popover-open');
        if (open && (force || moved)) host.hidePopover();
        if (!open || force || moved) host.showPopover();
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    }
  };
  const mode = () => {
    containFocus();
    ui.classList.toggle('interact', interacting || ctrl);
    const button = root.querySelector('[data-action=mode]');
    button.setAttribute('aria-pressed', String(!interacting && !ctrl));
    button.textContent = interacting || ctrl ? 'Interact' : 'Inspect';
  };
  let identifierReport,
    knownIdentifiers = new Set(),
    knownClasses = new Set();
  const selectionElement = () => {
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
    const name = selected.getAttribute('name');
    const classes = [...selected.classList]
      .filter((value) => knownClasses.has(value))
      .slice(0, 5)
      .join('.');
    return {
      tag: selected.localName,
      ...(knownIdentifiers.has(selected.id) ? { id: selected.id.slice(0, 160) } : {}),
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
    const surfaces = new Set([document.documentElement, selected.ownerDocument.documentElement]);
    for (const item of lineage(selected).slice(0, 40)) {
      const surface = item.getRootNode();
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
  const select = (node) => {
    if (!node || own(node)) return;
    const rect = visibleRect(node),
      cardRect = rect ?? node.getBoundingClientRect();
    resizeObserver.disconnect();
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(node);
    selected = node;
    selectionGeneration++;
    retainedOneShot = oneShot;
    watchSelection();
    details = true;
    hover = node;
    renderCard(false, cardRect);
    if (enabled) {
      updateMark(selectedMark, selected, '#76f1df', rect);
      hoverMark.remove();
    }
    schedule();
    const once = oneShot;
    notifySelection(false);
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
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: identityAttributes,
      });
      watchFrames();
      resizeObserver.observe(document.documentElement);
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
      ctrl = false;
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
    'data-paqvilo-source',
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
    if (selected) {
      const associated = labelledControl(selected);
      const related = [...lineage(selected), ...lineage(associated)];
      if (
        external.some(
          (record) =>
            record.attributeName !== 'style' &&
            (record.type === 'childList' ||
              related.includes(record.target) ||
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
  observer.observe(document.documentElement, {
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
        return;
      }
      const node = event.composedPath().find((item) => item?.nodeType === 1);
      if (own(node) && !node?.classList?.contains('shield')) return;
      hover = node?.classList?.contains('shield') ? underPointer(event.clientX, event.clientY) : node;
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
      (event) => {
        if (!pickGesture && (!enabled || interacting || ctrl || event.ctrlKey)) return;
        const node = event.composedPath().find((item) => item?.nodeType === 1);
        if (!pickGesture && (!node || (own(node) && !node.classList?.contains('shield')))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === 'pointerdown' || type === 'touchstart') {
          const point = event.changedTouches?.[0] ?? event;
          const picked = node.classList?.contains('shield') ? underPointer(point.clientX, point.clientY) : node;
          if (oneShot) {
            pickGesture = true;
            pendingPick = picked;
          } else select(picked);
        }
        if (['click', 'auxclick', 'contextmenu', 'touchend'].includes(type) && pickGesture) {
          const picked = pendingPick;
          if (oneShot) select(picked);
          pickGesture = false;
          pendingPick = null;
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
      card.style.left = '';
      card.style.top = '';
      card.style.right = '';
      card.style.bottom = '';
      needsScan = true;
      schedule();
    },
    { passive: true },
  );
  listenViews(
    'keydown',
    (event) => {
      if (event.altKey && event.shiftKey && event.code === 'KeyX') {
        if (event.ctrlKey || event.metaKey || event.repeat) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        toggle();
        return;
      }
      if (!enabled) return;
      if (event.key === 'Control') {
        ctrl = true;
        mode();
        schedule();
        return;
      }
      const node = event.composedPath().find((item) => item?.nodeType === 1);
      if (event.key === 'Tab' && !interacting && !ctrl) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const controls = [
          ...root.querySelectorAll(
            'button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex]:not([tabindex="-1"])',
          ),
        ].filter((item) => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
        const index = controls.indexOf(root.activeElement),
          direction = event.shiftKey ? -1 : 1;
        (
          controls[
            index < 0
              ? event.shiftKey
                ? controls.length - 1
                : 0
              : (index + direction + controls.length) % controls.length
          ] ?? ui
        ).focus();
        return;
      }
      if (own(node) && node?.matches('input,select,textarea')) return;
      if ((interacting || ctrl) && !own(node)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (selected) {
          clearSelection('escape');
        } else toggle(false);
        return;
      }
      if (interacting || ctrl) return;
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
            index = stack.indexOf(selected ?? hover),
            next = index < 0 ? 0 : (index + (event.key === ']' ? 1 : -1) + stack.length) % stack.length;
          select(stack[next]);
        }
      }
    },
    { capture: true },
  );
  listenViews(
    'keyup',
    (event) => {
      if (event.key === 'Control') {
        ctrl = false;
        mode();
        schedule();
      }
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
    ctrl = false;
    mode();
    schedule();
  });
  listen(
    root,
    'wheel',
    (event) => {
      if (!event.target.classList?.contains('shield') || interacting || ctrl || event.ctrlKey) return;
      event.preventDefault();
      const node = underPointer(event.clientX, event.clientY);
      if (!node) return;
      const line = parseFloat(getComputedStyle(node).lineHeight) || 16,
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
          const rootScroller = current === current.ownerDocument.scrollingElement;
          if ((!/auto|scroll/.test(overflow) && !rootScroller) || extent <= 0) continue;
          const offset = vertical ? current.scrollTop : current.scrollLeft;
          const rtl = !vertical && css.direction === 'rtl';
          const canScroll = rtl
            ? amount < 0
              ? offset > -extent + 1
              : offset < 0
            : amount < 0
              ? offset > 0
              : offset < extent - 1;
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
    ctrl = false;
    drag = null;
    mode();
    schedule();
  });
  listen(root, 'pointerdown', (event) => {
    const header = event.target.closest('.cardhead');
    if (!header || event.target.closest('button')) return;
    const r = card.getBoundingClientRect();
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
  listen(root, 'click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'context-page' && !button.disabled) {
      contextPages.set(button.dataset.context, Math.max(0, Number(button.dataset.page) || 0));
      renderCard(true);
    }
    if (action === 'refresh' && !button.disabled) {
      setStatus('Refreshing local source inspection…');
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
      renderCard();
    }
    if (action === 'source-region') {
      let region;
      try {
        region = lineage(selected).find((node) => node.matches(button.dataset.selector));
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
      if (region) select(region);
      else setStatus('This source region is no longer present. Select a rendered element again.');
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
    if (action === 'frame-open' && selected?.localName === 'iframe') {
      try {
        const url = new URL(selected.getAttribute('src') ?? '', selected.ownerDocument.baseURI);
        if (!selected.getAttribute('src') || !['http:', 'https:'].includes(url.protocol)) throw new Error();
        window.open(url.href, '_blank', 'noopener');
      } catch {
        setStatus('This embedded document has no standalone HTTP address.');
      }
    }
    if (action === 'reveal') {
      selected?.scrollIntoView({ block: 'center', inline: 'nearest' });
      schedule();
    }
    if (action === 'dock') {
      const r = card.getBoundingClientRect();
      card.style.left = r.left > innerWidth / 2 ? '20px' : 'auto';
      card.style.right = r.left > innerWidth / 2 ? 'auto' : '20px';
    }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        setStatus('Source path copied.');
      } catch {
        setStatus('The browser could not copy the source path.');
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
    if (!enabled || disposed || document.hidden) return;
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
    if (document.hidden) {
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
  host.__px = {
    toggle,
    select,
    identify,
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
    update(next, nextReport) {
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
      const theme = document.getElementById('paqvilo-panel')?.shadowRoot?.querySelector('.wrap');
      if (theme) {
        const style = getComputedStyle(theme);
        for (const key of [
          '--bg',
          '--fg',
          '--muted',
          '--primary',
          '--link',
          '--on-primary',
          '--radius',
          '--line',
          '--head-bg',
          '--panel-line',
          '--shadow',
          '--font',
        ]) {
          const value = style.getPropertyValue(key);
          if (value) ui.style.setProperty(key, value);
        }
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
    },
  };
}
