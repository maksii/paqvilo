import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { startAgentServer, redactText, redactUrl } from './agent-server.mjs';
import { inspectModelDrivenContext, modelDrivenInspectionCatalogue } from './model-driven-inspection.mjs';
import { modelDrivenInspectorUi } from './model-driven-inspector-ui.mjs';
import { MODEL_DRIVEN_ACTIONS, validateModelDrivenAction } from './model-driven-actions.mjs';
import { modelDrivenActionAvailability, runModelDrivenAction } from './model-driven-action-runner.mjs';
import { modelDrivenActionsUi } from './model-driven-actions-ui.mjs';
import { readModelDrivenNativeSource } from './model-driven-native-comparison.mjs';
import { createOwnedPageBindings } from './owned-page-binding.mjs';
import { panelUi } from './panel-ui.mjs';
import { xrayUi } from './xray-ui.mjs';
import { openInEditor } from './panel.mjs';
import {
  modelDrivenPanelData,
  modelDrivenPanelInspection,
  modelDrivenPanelUi,
  modelDrivenSourceFiles,
  createModelDrivenPanelSources,
} from './model-driven-panel.mjs';
import { installModelDrivenCommands } from './model-driven-commands.mjs';
import {
  createModelDrivenIdentity,
  verifyModelDrivenIdentity,
  modelDrivenIdentityResult,
} from './model-driven-identity.mjs';

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
  try {
    return await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Only known-size identity-encoded native source responses are read via CDP.
 * Unknown/compressed bodies stay unavailable: Content-Length cannot bound their decoded allocation.
 */
export function modelDrivenComparisonAdmission(response, { page, overlay, origin }) {
  try {
    const request = response.request(),
      url = new URL(response.url()),
      headers = response.headers();
    if (
      response.status() !== 200 ||
      url.origin !== origin ||
      request.frame() !== page.mainFrame() ||
      request.method() !== 'GET' ||
      headers['x-paqvilo-source'] === 'local-solution' ||
      (headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity')
    )
      return null;
    const length = headers['content-length'];
    if (!/^(?:0|[1-9][0-9]{0,7})$/.test(length ?? '') || Number(length) > 3 * 1024 * 1024) return null;
    const name = overlay.resourceForUrl(response.url());
    return name && overlay.isTextResource(name) ? { name, length: Number(length) } : null;
  } catch {
    return null;
  }
}

/** Native SPA transitions do not emit a document navigation. Keep this key in
 * the browser; no route values or record IDs are returned through the binding.
 */
export function installModelDrivenContextWatch({ origin, token }) {
  const host = document.getElementById('paqvilo-panel') ?? document.getElementById('paqvilo-model-inspector');
  if (location.origin !== origin || host?.__paqModelInspector?.token !== token || host.__paqModelWatch?.token === token)
    return;
  host.__paqModelWatch?.dispose();
  const safe = (callback) => {
    try {
      return callback();
    } catch {
      return undefined;
    }
  };
  const key = () =>
    JSON.stringify([
      location.href,
      Boolean(window.Xrm),
      safe(() => window.Xrm?.Page?.data?.entity?.getEntityName()),
      safe(() => window.Xrm?.Page?.ui?.formSelector?.getCurrentItem()?.getId()),
      safe(() => window.Xrm?.Page?.ui?.getFormType()),
    ]);
  let previous = key();
  const timer = setInterval(() => {
    if (!host.isConnected || host.__paqModelInspector?.token !== token || location.origin !== origin) {
      clearInterval(timer);
      return;
    }
    const next = key();
    if (next === previous) return;
    previous = next;
    host.__paqModelActions?.contextChanged?.();
    Promise.resolve(window.__paqviloModelInspectorRefresh?.()).catch(() => {});
  }, 500);
  Object.defineProperty(host, '__paqModelWatch', {
    configurable: true,
    value: {
      token,
      dispose() {
        clearInterval(timer);
      },
    },
  });
}

/** Dedicated-tab inspector; shares the bounded browser agent with Power Pages via state adapters. */
export async function startModelDrivenInspector({
  context,
  page,
  overlay,
  cfg,
  imported,
  attached = false,
  stop,
  runtime = {},
  savedState = null,
}) {
  const session = Object.assign(new EventEmitter(), { cfg, rel: (file) => String(file) });
  const token = randomBytes(12).toString('hex');
  const identity = createModelDrivenIdentity({ origin: cfg.origin, page });
  let catalogue = modelDrivenInspectionCatalogue(imported),
    sources = new Map([...imported.assets.values()].map((asset) => [asset.name, asset.file]));
  let currentImported = imported,
    ui = modelDrivenPanelUi(savedState?.ui ?? {}),
    live = runtime.liveReload ?? runtime.watching !== false;
  const activity = [];
  const panelSources = savedState?.panelSources ?? (await createModelDrivenPanelSources(imported));
  if (savedState?.panelSources) await panelSources.update(imported);
  let inspectionVersion = 1;
  let latestContext = null,
    observedAt = null,
    timer,
    busy = false,
    dirty = false,
    closed = false,
    agent,
    pageBindings,
    inspectionError = '';
  const problems = [],
    removers = [],
    requestDocuments = new WeakMap();
  let comparisonPending = 0;
  let documentRevision = 0;
  let identityRevision = 0,
    identityBusy = false;
  const on = (target, name, handler) => {
    target.on(name, handler);
    removers.push(() => target.off(name, handler));
  };
  const active = () => {
    try {
      return !closed && !page.isClosed() && new URL(page.url()).origin === cfg.origin;
    } catch {
      return false;
    }
  };
  const installTools = async () => {
    if (cfg.panel === false || !active()) return;
    await page.evaluate(installModelDrivenContextWatch, { origin: cfg.origin, token });
    await page.evaluate(installModelDrivenCommands, { origin: cfg.origin, token });
    const availability = await page.evaluate(modelDrivenActionAvailability, {
      origin: cfg.origin,
      actions: MODEL_DRIVEN_ACTIONS,
    });
    if (active())
      await page.evaluate(modelDrivenActionsUi, {
        origin: cfg.origin,
        token,
        actions: MODEL_DRIVEN_ACTIONS,
        availability,
      });
  };
  const snapshot = () => {
    const report = overlay.report(),
      unbound = new Set(report.unbound);
    const resources = bounded(
      report.resources.slice(0, MAX_ITEMS).map((resource) => ({
        name: redactText(resource.name, 500),
        mime: resource.mime,
        applied: resource.applied,
        currentRevisionApplied: resource.currentRevisionApplied,
        paths: resource.paths.slice(0, 10).map((path) => redactText(path, 1000)),
        pathsTruncated: resource.paths.length > 10,
        source: redactText(sources.get(resource.name) ?? 'Selected Solution archive', 1000),
        unbound: unbound.has(resource.name),
        paused: resource.paused,
      })),
    );
    const diagnostics = bounded(
      report.diagnostics.slice(0, MAX_ITEMS).map((item) => ({
        code: redactText(item.code, 100),
        message: redactText(item.message),
        source: redactText(item.source, 1000),
      })),
    );
    return {
      token,
      origin: cfg.origin,
      revision: report.revision,
      inspectionVersion,
      resourceCount: report.resources.length,
      applied: report.applied,
      currentRevisionApplied: report.currentRevisionApplied,
      resources,
      diagnostics,
      problems: problems.slice(),
      catalogue,
      context: latestContext,
      observedAt,
      pendingInspection: busy || dirty,
      inspectionError,
      truncated:
        report.resources.length > resources.length ||
        resources.some((resource) => resource.pathsTruncated) ||
        report.diagnostics.length > diagnostics.length ||
        catalogue.limits.truncated,
    };
  };
  const panelData = () =>
    modelDrivenPanelData(snapshot(), {
      cfg,
      ui,
      activity,
      live,
      online: overlay.report().online,
      git: panelSources.state.git,
      facts: panelSources.state.facts,
      scope: panelSources.state.scope,
    });
  const drawPanel = async () => {
    await page.evaluate(panelUi, panelData());
    await page.evaluate(xrayUi, panelData());
    await page.evaluate(modelDrivenInspectorUi, { origin: cfg.origin, token });
  };
  const update = async () => {
    timer = undefined;
    if (busy || !active()) return;
    busy = true;
    dirty = false;
    inspectionError = '';
    const revision = documentRevision;
    try {
      // Install the panel before reading native context so a slow/paused app
      // exposes progress immediately instead of appearing ready with empty data.
      // A failed tools install must not hide the app context from Inspect and X-ray.
      if (cfg.panel !== false) {
        await drawPanel();
        await installTools().catch(() => {});
      }
      const observed = await page.evaluate(inspectModelDrivenContext, cfg.origin);
      if (!active() || revision !== documentRevision) return;
      latestContext = observed;
      observedAt = new Date().toISOString();
      inspectionVersion++;
    } catch {
      inspectionError =
        'App context could not be refreshed. Try Refresh after the app finishes navigating or the debugger resumes.';
    } finally {
      busy = false;
      if (active() && revision === documentRevision && cfg.panel !== false) {
        await drawPanel().catch(() => {});
        await installTools().catch(() => {});
      }
      if (dirty) refresh();
    }
  };
  const refresh = (next) => {
    if (closed) return;
    if (next) {
      currentImported = next;
      catalogue = modelDrivenInspectionCatalogue(next);
      sources = new Map([...next.assets.values()].map((asset) => [asset.name, asset.file]));
      void panelSources
        .update(next)
        .then(() => {
          if (!closed) {
            overlay.setScope(panelSources.state.scope, panelSources.changed());
            refresh();
          }
        })
        .catch(() => problem({ type: 'error', text: 'The Git source baseline could not be refreshed.' }));
      activity.unshift({ type: 'save', how: 'reload', text: 'Local Solution sources reloaded.', at: Date.now() });
      activity.splice(100);
    }
    dirty = true;
    if (!timer && !busy)
      timer = setTimeout(() => {
        void update();
      }, 75);
  };
  const problem = (item) => {
    if (!active()) return;
    problems.push(item);
    const retained = bounded(problems.slice().reverse());
    problems.splice(0, problems.length - retained.length);
    refresh();
  };
  on(page, 'pageerror', (error) => {
    const location = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(error.stack ?? '');
    problem({
      type: 'pageerror',
      text: redactText(error.message),
      ...(location
        ? {
            url: redactUrl(location[1]),
            line: Number(location[2]) - 1,
            col: Number(location[3]) - 1,
          }
        : {}),
    });
  });
  on(page, 'console', (message) => {
    if (!['error', 'warning', 'warn'].includes(message.type())) return;
    if (/^Failed to load resource/.test(message.text())) return;
    const location = message.location?.() ?? {};
    problem({
      type: message.type(),
      text: redactText(message.text()),
      ...(location.url ? { url: redactUrl(location.url), line: location.lineNumber, col: location.columnNumber } : {}),
    });
  });
  on(page, 'request', (request) => requestDocuments.set(request, documentRevision));
  on(page, 'requestfailed', (request) => {
    if (requestDocuments.get(request) === documentRevision)
      problem({ type: 'requestfailed', text: redactText(request.failure()?.errorText), url: redactUrl(request.url()) });
  });
  on(page, 'response', (response) => {
    if (requestDocuments.get(response.request()) === documentRevision && response.status() >= 400)
      problem({ type: 'http', text: `HTTP ${response.status()}`, url: redactUrl(response.url()) });
    const admission = modelDrivenComparisonAdmission(response, { page, overlay, origin: cfg.origin });
    if (admission && comparisonPending < 2 && typeof response.body === 'function') {
      const revision = overlay.report().revision,
        document = documentRevision;
      comparisonPending++;
      void response
        .body()
        .then((bytes) => {
          if (
            !closed &&
            document === documentRevision &&
            revision === overlay.report().revision &&
            bytes.length === admission.length &&
            panelSources.observe(admission.name, bytes)
          )
            refresh();
        })
        .catch(() => {})
        .finally(() => {
          comparisonPending--;
        });
    }
  });
  on(page, 'framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    documentRevision++;
    identityRevision++;
    identityBusy = false;
    if (!active()) identity.stop();
    latestContext = null;
    observedAt = null;
    problems.length = 0;
    refresh();
  });
  on(page, 'domcontentloaded', () => refresh());
  try {
    const bindings = {};
    bindings.__paqviloModelPanelApi = async (source, input) => {
      if (
        cfg.panel === false ||
        source.page !== page ||
        source.frame !== page.mainFrame() ||
        !active() ||
        input?.token !== token ||
        typeof input.name !== 'string' ||
        (input.body != null && (typeof input.body !== 'object' || Array.isArray(input.body))) ||
        Buffer.byteLength(JSON.stringify(input.body ?? {})) > 32768
      )
        return { ok: false, error: 'Panel request refused.' };
      const body = input.body ?? {};
      try {
        if (input.name === 'ui') {
          ui = modelDrivenPanelUi(body);
          return { ok: true };
        }
        if (input.name === 'catalog') return { ok: true, entries: panelData().sourceCatalogue };
        if (input.name === 'inspect') {
          if (body.refresh) refresh();
          return { ok: true, version: inspectionVersion, report: modelDrivenPanelInspection(snapshot()) };
        }
        if (input.name === 'diff') {
          const allowed = snapshot().resources.find((resource) => resource.name === body.rel);
          if (!allowed || !overlay.isTextResource(allowed.name))
            return { ok: false, error: 'Select a declared script or stylesheet.' };
          const lease = overlay.nativeRead(allowed.name),
            revision = overlay.report().revision,
            document = documentRevision;
          try {
            const result = await within(
              page.evaluate(readModelDrivenNativeSource, { origin: cfg.origin, path: lease.path, token: lease.token }),
              13000,
            );
            if (!result)
              return {
                ok: false,
                error: 'The native comparison did not complete within 13 seconds. Resume the debugger and retry.',
              };
            if (!active() || revision !== overlay.report().revision || document !== documentRevision)
              return { ok: false, error: 'The page or source revision changed during comparison. Try again.' };
            if (!result.ok) return result;
            const bytes = Buffer.from(result.text, 'utf8');
            if (bytes.length !== result.bytes || !panelSources.observe(allowed.name, bytes))
              return {
                ok: false,
                error: 'The native source encoding or size is outside the bounded comparison contract.',
              };
            refresh();
            return panelSources.diff(body.rel, panelData().env);
          } finally {
            lease.release();
          }
        }
        if (input.name === 'open') {
          const file = modelDrivenSourceFiles(snapshot()).get(body.rel);
          if (!file) return { ok: false, error: 'The source is outside the selected Solution catalogue.' };
          const line = Number.isSafeInteger(body.line) && body.line > 0 ? body.line : 1,
            col = Number.isSafeInteger(body.col) && body.col > 0 ? body.col : 1;
          const error = await openInEditor(cfg.editor ?? 'code', file, line, col);
          return error ? { ok: false, error } : { ok: true };
        }
        if (input.name === 'mode' && typeof body.online === 'boolean') {
          overlay.setOnline(body.online);
          activity.unshift({
            type: 'switch',
            text: body.online ? 'Online resources enabled.' : 'Local Solution overlay enabled.',
            at: Date.now(),
          });
          activity.splice(100);
          refresh();
          return { ok: true };
        }
        if (input.name === 'live' && typeof body.on === 'boolean') {
          if (typeof runtime.setLive !== 'function')
            return { ok: false, error: 'This runner does not support changing live reload.' };
          runtime.setLive(body.on);
          live = body.on;
          refresh();
          return { ok: true };
        }
        if (input.name === 'toggle' && typeof body.rel === 'string' && typeof body.off === 'boolean') {
          overlay.pause(body.rel, body.off);
          refresh();
          return { ok: true };
        }
        if (input.name === 'scope') {
          panelSources.setScope(body.scope);
          overlay.setScope(body.scope, panelSources.changed());
          refresh();
          return { ok: true };
        }
        if (input.name === 'rebaseline') {
          await panelSources.update(currentImported, true);
          overlay.setScope(panelSources.state.scope, panelSources.changed());
          refresh();
          return { ok: true };
        }
        if (input.name === 'clear' && ['problems', 'activity'].includes(body.what)) {
          (body.what === 'problems' ? problems : activity).length = 0;
          refresh();
          return { ok: true };
        }
        return { ok: false, error: 'Unsupported model-driven panel action.' };
      } catch {
        return {
          ok: false,
          error: 'The panel action could not complete. Check the selected sources and Git baseline.',
        };
      }
    };
    bindings.__paqviloModelInspectorRefresh = (source) => {
      if (source.page !== page || source.frame !== page.mainFrame() || !active()) return false;
      refresh();
      return true;
    };
    const ownsSource = (source, input) =>
      cfg.panel !== false &&
      source.page === page &&
      source.frame === page.mainFrame() &&
      active() &&
      input?.token === token &&
      typeof input.requestId === 'string' &&
      /^[\w-]{1,100}$/.test(input.requestId);
    bindings.__paqviloModelAction = async (source, input) => {
      const acknowledgement = (accepted) => ({ accepted, requestId: input?.requestId });
      if (!ownsSource(source, input)) return acknowledgement(false);
      let validated;
      try {
        validated = validateModelDrivenAction(input.action, input.params ?? {});
      } catch {
        return { ...acknowledgement(false), reason: 'invalid-input' };
      }
      try {
        return await page.evaluate(runModelDrivenAction, {
          origin: cfg.origin,
          token,
          requestId: input.requestId,
          ...validated,
        });
      } catch {
        return acknowledgement(false);
      }
    };
    bindings.__paqviloModelIdentity = async (source, input) => {
      const acknowledgement = (accepted) => ({ accepted, requestId: input?.requestId });
      if (!ownsSource(source, input)) return acknowledgement(false);
      if (input.objectId === null) {
        identityRevision++;
        identity.stop();
        identityBusy = false;
        await page
          .evaluate(modelDrivenIdentityResult, { origin: cfg.origin, token, requestId: input.requestId, active: false })
          .catch(() => {});
        return acknowledgement(true);
      }
      if (
        identityBusy ||
        identity.active ||
        typeof input.objectId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.objectId)
      )
        return acknowledgement(false);
      const revision = ++identityRevision;
      identityBusy = true;
      try {
        const verified = await page.evaluate(verifyModelDrivenIdentity, {
          origin: cfg.origin,
          token,
          requestId: input.requestId,
          objectId: input.objectId,
        });
        if (!verified || !active() || revision !== identityRevision) return acknowledgement(false);
        if (!identity.start(input.objectId)) return acknowledgement(false);
        const delivered = await page.evaluate(modelDrivenIdentityResult, {
          origin: cfg.origin,
          token,
          requestId: input.requestId,
          active: true,
        });
        if (!delivered || revision !== identityRevision) {
          if (revision === identityRevision) identity.stop();
          return acknowledgement(false);
        }
        return acknowledgement(true);
      } catch {
        if (revision === identityRevision) identity.stop();
        return acknowledgement(false);
      } finally {
        if (revision === identityRevision) identityBusy = false;
      }
    };
    pageBindings = await createOwnedPageBindings(page, { origin: cfg.origin, bindings });
    agent = await startAgentServer({
      session,
      context,
      attached,
      stop,
      runtime,
      options: {
        ownsPage: (candidate) => candidate === page,
        sessionState: () => {
          const state = snapshot();
          return {
            kind: 'model-driven',
            browserScope: { mode: 'dedicated-app-tab', stopScope: 'browser', origin: cfg.origin },
            overlay: {
              revision: state.revision,
              applied: state.applied,
              currentRevisionApplied: state.currentRevisionApplied,
              resourceCount: state.resourceCount,
              resources: state.resources,
              diagnostics: state.diagnostics,
              truncated: state.truncated,
            },
            inspection: {
              context: latestContext,
              observedAt,
              pending: state.pendingInspection,
              error: inspectionError || undefined,
              limits: { maxItems: MAX_ITEMS, maxSectionBytes: MAX_SECTION_BYTES },
            },
          };
        },
        pageState: () => {
          const { token: _token, ...state } = snapshot();
          return { kind: 'model-driven', ...state };
        },
      },
    });
    refresh();
    if (agent) console.log(`Model-driven agent API: ${agent.discoveryFile}`);
    return {
      agent,
      refresh,
      snapshot,
      persistentState: () => ({ ui: modelDrivenPanelUi(ui), panelSources }),
      prepareRequest: (route) => identity.prepare(route),
      close: async () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        identityRevision++;
        const failures = [];
        const drain = async (callback) => {
          try {
            await callback();
          } catch (error) {
            failures.push(error);
          }
        };
        await drain(() => identity.close());
        for (const remove of removers) await drain(remove);
        await drain(() => pageBindings?.close());
        await drain(() => agent?.close());
        session.removeAllListeners();
        problems.length = 0;
        await drain(async () => {
          if (!page.isClosed())
            await within(
              page
                .evaluate((retired) => {
                  const retiredSessions = (window.__paqviloRetiredModelInspectors ??= []);
                  retiredSessions.push(retired);
                  if (retiredSessions.length > 64) retiredSessions.shift();
                  const canonicalRetired = (window.__paqviloRetiredSessions ??= []);
                  canonicalRetired.push(retired);
                  if (canonicalRetired.length > 64) canonicalRetired.shift();
                  const inspector = document.getElementById('paqvilo-panel')?.__paqModelInspector;
                  if (inspector?.token === retired) inspector.dispose();
                }, token)
                .catch(() => {}),
              250,
            );
        });
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Model-driven inspector cleanup failed.');
      },
    };
  } catch (error) {
    closed = true;
    clearTimeout(timer);
    const failures = [error];
    for (const cleanup of [() => identity.close(), ...removers, () => pageBindings?.close(), () => agent?.close()]) {
      try {
        await cleanup();
      } catch (cause) {
        failures.push(cause);
      }
    }
    session.removeAllListeners();
    if (failures.length > 1)
      throw new AggregateError(failures, 'Model-driven inspector initialization and cleanup failed.', { cause: error });
    throw error;
  }
}
