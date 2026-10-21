import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { startAgentServer, redactText, redactUrl } from './agent-server.mjs';
import { inspectModelDrivenContext, modelDrivenInspectionCatalogue } from './model-driven-inspection.mjs';
import { modelDrivenInspectorUi } from './model-driven-inspector-ui.mjs';
import { MODEL_DRIVEN_ACTIONS, validateModelDrivenAction } from './model-driven-actions.mjs';
import { modelDrivenActionAvailability, runModelDrivenAction } from './model-driven-action-runner.mjs';
import { modelDrivenActionsUi } from './model-driven-actions-ui.mjs';
import { installModelDrivenCommands } from './model-driven-commands.mjs';
import { createModelDrivenIdentity, verifyModelDrivenIdentity, modelDrivenIdentityResult } from './model-driven-identity.mjs';

const MAX_ITEMS = 200;
const MAX_SECTION_BYTES = 128 * 1024;
const bounded = (rows, limit = MAX_ITEMS) => {
  let bytes = 0;
  const selected = [];
  for (const row of rows) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (selected.length >= limit || bytes > MAX_SECTION_BYTES) break;
    selected.push(row);
  }
  return selected;
};
const within = async (operation, milliseconds) => {
  let timer;
  try { return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
};

/** Native SPA transitions do not emit a document navigation. Keep this key in
 * the browser; no route values or record IDs are returned through the binding.
 */
export function installModelDrivenContextWatch({ origin, token }) {
  const host = document.getElementById('paqvilo-model-inspector');
  if (location.origin !== origin || host?.__paqModelInspector?.token !== token || host.__paqModelWatch?.token === token) return;
  host.__paqModelWatch?.dispose();
  const safe = callback => { try { return callback(); } catch { return undefined; } };
  const key = () => JSON.stringify([location.href, Boolean(window.Xrm), safe(() => window.Xrm?.Page?.data?.entity?.getEntityName()), safe(() => window.Xrm?.Page?.ui?.formSelector?.getCurrentItem()?.getId()), safe(() => window.Xrm?.Page?.ui?.getFormType())]);
  let previous = key();
  const timer = setInterval(() => {
    if (!host.isConnected || host.__paqModelInspector?.token !== token || location.origin !== origin) { clearInterval(timer); return; }
    const next = key();
    if (next === previous) return;
    previous = next; host.__paqModelActions?.contextChanged?.();
    Promise.resolve(window.__paqviloModelInspectorRefresh?.()).catch(() => {});
  }, 500);
  Object.defineProperty(host, '__paqModelWatch', { configurable: true, value: { token, dispose() { clearInterval(timer); } } });
}

/** Dedicated-tab inspector; shares the bounded browser agent with Power Pages via state adapters. */
export async function startModelDrivenInspector({ context, page, overlay, cfg, imported, attached = false, stop, runtime = {} }) {
  const session = Object.assign(new EventEmitter(), { cfg, rel: file => String(file) });
  const token = randomBytes(12).toString('hex');
  const identity = createModelDrivenIdentity({ origin: cfg.origin, page });
  let catalogue = modelDrivenInspectionCatalogue(imported), sources = new Map([...imported.assets.values()].map(asset => [asset.name, asset.file]));
  let latestContext = null, observedAt = null, timer, busy = false, dirty = false, closed = false, agent, inspectionError = '';
  const problems = [], removers = [], requestDocuments = new WeakMap();
  let documentRevision = 0;
  let identityRevision = 0, identityBusy = false;
  const on = (target, name, handler) => { target.on(name, handler); removers.push(() => target.off(name, handler)); };
  const active = () => { try { return !closed && !page.isClosed() && new URL(page.url()).origin === cfg.origin; } catch { return false; } };
  const installTools = async () => {
    if (cfg.panel === false || !active()) return;
    await page.evaluate(installModelDrivenContextWatch, { origin: cfg.origin, token });
    await page.evaluate(installModelDrivenCommands, { origin: cfg.origin, token });
    const availability = await page.evaluate(modelDrivenActionAvailability, { origin: cfg.origin, actions: MODEL_DRIVEN_ACTIONS });
    if (active()) await page.evaluate(modelDrivenActionsUi, { origin: cfg.origin, token, actions: MODEL_DRIVEN_ACTIONS, availability });
  };
  const snapshot = () => {
    const report = overlay.report(), unbound = new Set(report.unbound);
    const resources = bounded(report.resources.slice(0, MAX_ITEMS).map(resource => ({ name: redactText(resource.name, 500), applied: resource.applied, currentRevisionApplied: resource.currentRevisionApplied,
      paths: resource.paths.slice(0, 10).map(path => redactText(path, 1000)), pathsTruncated: resource.paths.length > 10,
      source: redactText(sources.get(resource.name) ?? 'Selected Solution archive', 1000), unbound: unbound.has(resource.name) })));
    const diagnostics = bounded(report.diagnostics.slice(0, MAX_ITEMS).map(item => ({ code: redactText(item.code, 100), message: redactText(item.message), source: redactText(item.source, 1000) })));
    return { token, origin: cfg.origin, revision: report.revision, resourceCount: report.resources.length, applied: report.applied, currentRevisionApplied: report.currentRevisionApplied,
      resources, diagnostics,
      problems: problems.slice(), catalogue, context: latestContext, observedAt,
      pendingInspection: busy || dirty, inspectionError,
      truncated: report.resources.length > resources.length || resources.some(resource => resource.pathsTruncated) || report.diagnostics.length > diagnostics.length || catalogue.limits.truncated,
    };
  };
  const update = async () => {
    timer = undefined;
    if (busy || !active()) return;
    busy = true; dirty = false; inspectionError = '';
    const revision = documentRevision;
    try {
      // Install the panel before reading native context so a slow/paused app
      // exposes progress immediately instead of appearing ready with empty data.
      if (cfg.panel !== false) { await page.evaluate(modelDrivenInspectorUi, snapshot()); await installTools(); }
      const observed = await page.evaluate(inspectModelDrivenContext, cfg.origin);
      if (!active() || revision !== documentRevision) return;
      latestContext = observed; observedAt = new Date().toISOString();
    } catch { inspectionError = 'App context could not be refreshed. Try Refresh after the app finishes navigating or the debugger resumes.'; }
    finally {
      busy = false;
      if (active() && revision === documentRevision && cfg.panel !== false) {
        await page.evaluate(modelDrivenInspectorUi, snapshot()).catch(() => {});
        await installTools().catch(() => {});
      }
      if (dirty) refresh();
    }
  };
  const refresh = next => {
    if (closed) return;
    if (next) { catalogue = modelDrivenInspectionCatalogue(next); sources = new Map([...next.assets.values()].map(asset => [asset.name, asset.file])); }
    dirty = true;
    if (!timer && !busy) timer = setTimeout(() => { void update(); }, 75);
  };
  const problem = item => {
    if (!active()) return;
    problems.push(item);
    const retained = bounded(problems.slice().reverse());
    problems.splice(0, problems.length - retained.length);
    refresh();
  };
  on(page, 'pageerror', error => problem({ type: 'pageerror', text: redactText(error.message) }));
  on(page, 'console', message => {
    if (!['error', 'warning', 'warn'].includes(message.type())) return;
    const location = message.location?.() ?? {};
    problem({ type: message.type(), text: redactText(message.text()), ...(location.url ? { url: redactUrl(location.url), line: location.lineNumber } : {}) });
  });
  on(page, 'request', request => requestDocuments.set(request, documentRevision));
  on(page, 'requestfailed', request => {
    if (requestDocuments.get(request) === documentRevision) problem({ type: 'requestfailed', text: redactText(request.failure()?.errorText), url: redactUrl(request.url()) });
  });
  on(page, 'response', response => {
    if (requestDocuments.get(response.request()) === documentRevision && response.status() >= 400) problem({ type: 'http', text: `HTTP ${response.status()}`, url: redactUrl(response.url()) });
  });
  on(page, 'framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    documentRevision++;
    identityRevision++; identityBusy = false;
    if (!active()) identity.stop();
    latestContext = null; observedAt = null; problems.length = 0; refresh();
  });
  on(page, 'domcontentloaded', () => refresh());
  try {
    await page.exposeBinding('__paqviloModelInspectorRefresh', source => {
      if (source.page !== page || source.frame !== page.mainFrame() || !active()) return false;
      refresh(); return true;
    });
    const ownsSource = (source, input) => cfg.panel !== false && source.page === page && source.frame === page.mainFrame() && active() && input?.token === token && typeof input.requestId === 'string' && /^[\w-]{1,100}$/.test(input.requestId);
    await page.exposeBinding('__paqviloModelAction', async (source, input) => {
      const acknowledgement = accepted => ({ accepted, requestId: input?.requestId });
      if (!ownsSource(source, input)) return acknowledgement(false);
      let validated;
      try { validated = validateModelDrivenAction(input.action, input.params ?? {}); }
      catch { return { ...acknowledgement(false), reason: 'invalid-input' }; }
      try {
        return await page.evaluate(runModelDrivenAction, { origin: cfg.origin, token, requestId: input.requestId, ...validated });
      } catch { return acknowledgement(false); }
    });
    await page.exposeBinding('__paqviloModelIdentity', async (source, input) => {
      const acknowledgement = accepted => ({ accepted, requestId: input?.requestId });
      if (!ownsSource(source, input)) return acknowledgement(false);
      if (input.objectId === null) {
        identityRevision++; identity.stop(); identityBusy = false;
        await page.evaluate(modelDrivenIdentityResult, { origin: cfg.origin, token, requestId: input.requestId, active: false }).catch(() => {});
        return acknowledgement(true);
      }
      if (identityBusy || identity.active || typeof input.objectId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.objectId)) return acknowledgement(false);
      const revision = ++identityRevision;
      identityBusy = true;
      try {
        const verified = await page.evaluate(verifyModelDrivenIdentity, { origin: cfg.origin, token, requestId: input.requestId, objectId: input.objectId });
        if (!verified || !active() || revision !== identityRevision) return acknowledgement(false);
        if (!identity.start(input.objectId)) return acknowledgement(false);
        const delivered = await page.evaluate(modelDrivenIdentityResult, { origin: cfg.origin, token, requestId: input.requestId, active: true });
        if (!delivered || revision !== identityRevision) { if (revision === identityRevision) identity.stop(); return acknowledgement(false); }
        return acknowledgement(true);
      } catch { if (revision === identityRevision) identity.stop(); return acknowledgement(false); }
      finally { if (revision === identityRevision) identityBusy = false; }
    });
    agent = await startAgentServer({ session, context, attached, stop, runtime, options: {
      ownsPage: candidate => candidate === page,
      sessionState: () => {
        const state = snapshot();
        return { kind: 'model-driven', browserScope: { mode: 'dedicated-app-tab', stopScope: 'browser', origin: cfg.origin }, overlay: { revision: state.revision, applied: state.applied, currentRevisionApplied: state.currentRevisionApplied, resourceCount: state.resourceCount, resources: state.resources, diagnostics: state.diagnostics, truncated: state.truncated }, inspection: { context: latestContext, observedAt, pending: state.pendingInspection, error: inspectionError || undefined, limits: { maxItems: MAX_ITEMS, maxSectionBytes: MAX_SECTION_BYTES } } };
      },
      pageState: () => { const { token: _token, ...state } = snapshot(); return { kind: 'model-driven', ...state }; },
    } });
    refresh();
    if (agent) console.log(`Model-driven agent API: ${agent.discoveryFile}`);
    return { agent, refresh, snapshot, prepareRequest: route => identity.prepare(route), close: async () => {
      if (closed) return; closed = true; clearTimeout(timer);
      identityRevision++; identity.close();
      for (const remove of removers) remove();
      await agent?.close(); session.removeAllListeners(); problems.length = 0;
      if (!page.isClosed()) await within(page.evaluate(retired => {
        const retiredSessions = window.__paqviloRetiredModelInspectors ??= [];
        retiredSessions.push(retired); if (retiredSessions.length > 64) retiredSessions.shift();
        const inspector = document.getElementById('paqvilo-model-inspector')?.__paqModelInspector;
        if (inspector?.token === retired) inspector.dispose();
      }, token).catch(() => {}), 250);
    } };
  } catch (error) {
    closed = true; clearTimeout(timer); for (const remove of removers) remove();
    identity.close();
    await agent?.close(); session.removeAllListeners(); throw error;
  }
}
