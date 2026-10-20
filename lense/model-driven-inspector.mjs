import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { startAgentServer, redactText, redactUrl } from './agent-server.mjs';
import { inspectModelDrivenContext, modelDrivenInspectionCatalogue } from './model-driven-inspection.mjs';
import { modelDrivenInspectorUi } from './model-driven-inspector-ui.mjs';

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

/** Dedicated-tab inspector; shares the bounded browser agent with Power Pages via state adapters. */
export async function startModelDrivenInspector({ context, page, overlay, cfg, imported, attached = false, stop, runtime = {} }) {
  const session = Object.assign(new EventEmitter(), { cfg, rel: file => String(file) });
  const token = randomBytes(12).toString('hex');
  let catalogue = modelDrivenInspectionCatalogue(imported), sources = new Map([...imported.assets.values()].map(asset => [asset.name, asset.file]));
  let latestContext = null, observedAt = null, timer, busy = false, dirty = false, closed = false, agent;
  const problems = [], removers = [], requestDocuments = new WeakMap();
  let documentRevision = 0;
  const on = (target, name, handler) => { target.on(name, handler); removers.push(() => target.off(name, handler)); };
  const active = () => { try { return !closed && !page.isClosed() && new URL(page.url()).origin === cfg.origin; } catch { return false; } };
  const snapshot = () => {
    const report = overlay.report(), unbound = new Set(report.unbound);
    const resources = bounded(report.resources.slice(0, MAX_ITEMS).map(resource => ({ name: redactText(resource.name, 500), applied: resource.applied, currentRevisionApplied: resource.currentRevisionApplied,
      paths: resource.paths.slice(0, 10).map(path => redactText(path, 1000)), pathsTruncated: resource.paths.length > 10,
      source: redactText(sources.get(resource.name) ?? 'Selected Solution archive', 1000), unbound: unbound.has(resource.name) })));
    const diagnostics = bounded(report.diagnostics.slice(0, MAX_ITEMS).map(item => ({ code: redactText(item.code, 100), message: redactText(item.message), source: redactText(item.source, 1000) })));
    return { token, origin: cfg.origin, revision: report.revision, resourceCount: report.resources.length, applied: report.applied, currentRevisionApplied: report.currentRevisionApplied,
      resources, diagnostics,
      problems: problems.slice(), catalogue, context: latestContext, observedAt,
      pendingInspection: busy,
      truncated: report.resources.length > resources.length || resources.some(resource => resource.pathsTruncated) || report.diagnostics.length > diagnostics.length || catalogue.limits.truncated,
    };
  };
  const update = async () => {
    timer = undefined;
    if (busy || !active()) return;
    busy = true; dirty = false;
    const revision = documentRevision;
    try {
      const observed = await page.evaluate(inspectModelDrivenContext, cfg.origin);
      if (!active() || revision !== documentRevision) return;
      latestContext = observed; observedAt = new Date().toISOString();
      if (cfg.panel !== false) await page.evaluate(modelDrivenInspectorUi, snapshot());
    } catch { /* Navigation/paused debugger must not break interception or watcher cleanup. */ }
    finally { busy = false; if (dirty) refresh(); }
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
    latestContext = null; observedAt = null; problems.length = 0; refresh();
  });
  on(page, 'domcontentloaded', () => refresh());
  try {
    await page.exposeBinding('__paqviloModelInspectorRefresh', source => {
      if (source.page !== page || source.frame !== page.mainFrame() || !active()) return false;
      refresh(); return true;
    });
    agent = await startAgentServer({ session, context, attached, stop, runtime, options: {
      ownsPage: candidate => candidate === page,
      sessionState: () => {
        const state = snapshot();
        return { kind: 'model-driven', browserScope: { mode: 'dedicated-app-tab', stopScope: 'browser', origin: cfg.origin }, overlay: { revision: state.revision, applied: state.applied, currentRevisionApplied: state.currentRevisionApplied, resourceCount: state.resourceCount, resources: state.resources, diagnostics: state.diagnostics, truncated: state.truncated }, inspection: { context: latestContext, observedAt, pending: busy, limits: { maxItems: MAX_ITEMS, maxSectionBytes: MAX_SECTION_BYTES } } };
      },
      pageState: () => { const { token: _token, ...state } = snapshot(); return { kind: 'model-driven', ...state }; },
    } });
    refresh();
    if (agent) console.log(`Model-driven agent API: ${agent.discoveryFile}`);
    return { agent, refresh, snapshot, close: async () => {
      if (closed) return; closed = true; clearTimeout(timer);
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
    await agent?.close(); session.removeAllListeners(); throw error;
  }
}
