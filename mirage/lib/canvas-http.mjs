import { canvasViewport } from './canvas-runtime.mjs';
import { canvasRenderingGaps } from './canvas-rendering.mjs';
import { canvasSourceCoverageGaps } from './canvas-source.mjs';
import { CANVAS_ASSETS, canvasAssetUrls } from './canvas-assets.mjs';
// Canvas app host under the reserved `/_apps/canvas/` prefix: the inventory page of every app and, when the host wires
// the headless runtime (canvas-runtime.mjs), the app view: screens and controls with their current property values,
// variables, collections, data sources, forms, notifications and errors, with HTML forms that drive it. Nothing is
// rendered as the app would look (requirement canvas:rendering). The driver API is POST /_apps/api/canvas/<app> (JSON with
// the x-sim-csrf header, or the view's urlencoded forms with a _csrf field; loopback callers with a staff or portal
// principal only; { action: "start" | "reset", parameters } passes the launch parameters Param reads); GET
// /_apps/api/canvas/<app> answers the snapshot.
// Mount before the model-driven handler: that handler answers 404 for every other `/_apps/*` path.
import { stringifyExactJson } from './exact-numeric.mjs';
import { canvasPlayerAsset, canvasPlayerPage } from './canvas-player.mjs';
import { recordHttpError, statusFromHttp } from './trace-store.mjs';

const PREFIX = '/_apps/canvas/';
const API_PREFIX = '/_apps/api/canvas/';
const BANNER = 'Canvas apps are not rendered; their screens, controls and formulas run headlessly';
const PLAYER_BANNER =
  'Canvas apps use a bounded local player; unsupported features and incomplete sources are reported';
const INVENTORY_BANNER = 'Canvas apps are inventoried only on this host; nothing is executed';
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const BODY_LIMIT = 64 * 1024;
const IMAGE_BODY_LIMIT = 1_500_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
// An app is hosted (behaviour) when this host wires the runtime and the app has readable screens; else inventory.
const levelOf = (source, hosted) =>
  hosted && source.screens.length && !canvasSourceCoverageGaps(source).length ? 'behaviour' : 'inventory';
const reasonOf = (hosted) => (hosted ? 'CANVAS_RENDERING_BASELINE' : 'CANVAS_HOST_NOT_IMPLEMENTED');

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
// Exact decimals (exact-numeric.mjs) keep every digit: a 28-digit Decimal is written as its number lexeme.
const writeJson = (res, status, value) =>
  send(res, status, 'application/json; charset=utf-8', stringifyExactJson(value));
// The behaviour property a driver action runs (its canvas span is named `<action> <control>.<property>`).
const ACTION_PROPERTY = { select: 'OnSelect', input: 'OnChange', 'add-media': 'OnChange', codecomponent: 'OnChange' };
// The source text of one control or screen property formula (canvas-source.mjs rows; owner may carry its screen).
const formulaOf = (source, control, property) => {
  const row = (source.formulas ?? []).find(
    (item) => item.property === property && (item.owner === control || String(item.owner).endsWith(`.${control}`)),
  );
  return row ? String(row.text ?? '').replace(/^\s*=/, '') : null;
};
const page = (title, body, hosted, playerList = false) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
  `<body><p role="status"><strong>${hosted ? (playerList ? PLAYER_BANNER : BANNER) : INVENTORY_BANNER}</strong></p>${body}</body></html>`;
const summary =
  (hosted) =>
  ({ uniqueName, source }) => ({
    uniqueName,
    name: source.app.name,
    version: source.app.version ?? null,
    screens: source.screens.length,
    formulas: source.formulas.length,
    diagnostics: source.diagnostics.length,
    level: levelOf(source, hosted),
    ...(canvasSourceCoverageGaps(source).length ? { reason: canvasSourceCoverageGaps(source)[0].code } : {}),
  });
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const shown = (value) => {
  const text = stringifyExactJson(value ?? null);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > IMAGE_BODY_LIMIT) throw failure(413, 'PayloadTooLarge', 'The request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) {
    if (size > BODY_LIMIT) throw failure(413, 'PayloadTooLarge', 'The request body is too large.');
    const fields = Object.fromEntries(new URLSearchParams(text));
    const action = {
      action: fields.action,
      control: fields.control || undefined,
      screen: fields.screen || undefined,
      formula: fields.formula || undefined,
    };
    if (fields.item !== undefined && fields.item !== '') action.item = Number(fields.item);
    if (fields.index !== undefined && fields.index !== '') action.value = Number(fields.index);
    else if (fields.value !== undefined) action.value = fields.value;
    return { form: true, csrf: fields._csrf, action };
  }
  let action;
  try {
    action = text ? JSON.parse(text) : null;
  } catch {
    throw failure(400, 'InvalidJson', 'The request body is not valid JSON.');
  }
  if (!action || typeof action !== 'object' || Array.isArray(action))
    throw failure(400, 'CanvasActionInvalid', 'The request body must be a JSON object with an action.');
  if (size > BODY_LIMIT && !(action.action === 'add-media' && typeof action.data === 'string'))
    throw failure(413, 'PayloadTooLarge', 'Only bounded image input accepts a larger request body.');
  return { form: false, csrf: req.headers['x-sim-csrf'], action };
}

/** The headless app view (no script: every action is a form post that redirects back here). */
function appView(app, snapshot, token) {
  const target = `${API_PREFIX}${encodeURIComponent(app.uniqueName)}`;
  const form = (fields, label, extra = '') =>
    `<form method="post" action="${escapeHtml(target)}"><input type="hidden" name="_csrf" value="${escapeHtml(token)}">` +
    Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join('') +
    `${extra}<button type="submit">${escapeHtml(label)}</button></form>`;
  const controlActions = (control, item) => {
    const scope = item === undefined ? {} : { item };
    const parts = [];
    if (control.behaviours.includes('OnSelect') || (control.kind === 'gallery' && item !== undefined))
      parts.push(form({ action: 'select', control: control.name, ...scope }, `Select ${control.name}`));
    if (control.kind === 'textinput')
      parts.push(
        form(
          { action: 'input', control: control.name, ...scope },
          'Set text',
          `<label>Text <input name="value" value="${escapeHtml(control.properties.Text ?? '')}"></label>`,
        ),
      );
    if (control.kind === 'toggle' || control.kind === 'checkbox')
      parts.push(
        form(
          { action: 'input', control: control.name, value: String(control.properties.Value !== true), ...scope },
          control.properties.Value === true ? 'Switch off' : 'Switch on',
        ),
      );
    if (control.kind === 'datepicker')
      parts.push(
        form(
          { action: 'input', control: control.name, ...scope },
          'Set date',
          `<label>Date <input type="date" name="value"></label>`,
        ),
      );
    if (control.kind === 'dropdown' || control.kind === 'combobox')
      parts.push(
        form(
          { action: 'input', control: control.name, ...scope },
          'Choose',
          `<label>Item index <input type="number" min="0" name="index"></label>`,
        ),
      );
    return parts.join('');
  };
  const properties = (values) =>
    `<dl>${Object.entries(values)
      .map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd><code>${escapeHtml(shown(value))}</code></dd>`)
      .join('')}</dl>`;
  const controlRow = (control) =>
    `<li><strong>${escapeHtml(control.name)}</strong> <code>${escapeHtml(control.type ?? '')}</code>` +
    (control.supported ? '' : ' <em>not hosted (unsupported control)</em>') +
    properties(control.properties) +
    controlActions(control) +
    (control.items
      ? `<ol start="0">${control.items
          .map(
            (row) =>
              `<li>${form({ action: 'select', control: control.name, item: row.index }, `Select item ${row.index}`)}` +
              Object.entries(row.controls)
                .map(([name, values]) => `<p>${escapeHtml(name)}</p>${properties(values)}`)
                .join('') +
              '</li>',
          )
          .join('')}</ol>`
      : '') +
    '</li>';
  const section = (title, value) => `<h2>${escapeHtml(title)}</h2><pre>${escapeHtml(stringifyExactJson(value))}</pre>`;
  return (
    `<h1>${escapeHtml(snapshot.name)}</h1>` +
    `<p>Current screen: <strong>${escapeHtml(snapshot.currentScreen ?? 'none')}</strong> (history: ${escapeHtml(snapshot.history.join(' → '))})</p>` +
    form({ action: 'back' }, 'Back') +
    form(
      { action: 'navigate' },
      'Navigate',
      `<label>Screen <select name="screen">${snapshot.screens.map((screen) => `<option${screen.current ? ' selected' : ''}>${escapeHtml(screen.name)}</option>`).join('')}</select></label>`,
    ) +
    form(
      { action: 'run' },
      'Run behaviour formula',
      `<label>Formula <textarea name="formula" rows="2" cols="60"></textarea></label>`,
    ) +
    (snapshot.unsupported.length
      ? `<h2>Not hosted</h2><ul>${snapshot.unsupported.map((item) => `<li>${escapeHtml(item.screen)}.${escapeHtml(item.name)}: ${escapeHtml(item.control)}</li>`).join('')}</ul>`
      : '') +
    snapshot.screens
      .map(
        (screen) =>
          `<h2>Screen ${escapeHtml(screen.name)}${screen.current ? ' (current)' : ''}</h2>${properties(screen.properties)}<ul>${screen.controls.map(controlRow).join('')}</ul>`,
      )
      .join('') +
    section('Variables', snapshot.variables) +
    section('Context variables', snapshot.context) +
    section('Collections', snapshot.collections) +
    section('Data sources', snapshot.dataSources) +
    section('Forms', snapshot.forms) +
    section('Notifications', snapshot.notifications) +
    section('Launches', snapshot.launches) +
    section('Errors', snapshot.errors) +
    section('Diagnostics', snapshot.diagnostics) +
    section('Activity', snapshot.log)
  );
}

/**
 * `apps()` returns `[{ uniqueName, source }]` where `source` is a `readCanvasSource` result. `enabled()` (project
 * `canvas.enabled`, default true) false answers every path under the prefix 404 CanvasAppsDisabled and reports the
 * CANVAS_DISABLED diagnostic once. `runtime` (createCanvasRuntime) hosts the apps; `principal(req)` → { kind, principalId }
 * or null, or a promise of it (the staff session, or a signed-in portal visitor's mapped Dataverse user; never SYSTEM); `csrf()` → the simulator CSRF token. Without
 * a runtime the pages show the inventory and the API answers 501 CanvasRuntimeUnavailable. Returns false synchronously for
 * paths it does not own and true for the rest (the answer may complete asynchronously). `traces` (the host trace store)
 * names the request root's actor with `traceActor(principal)` (default: a staff or local administrator principal is the
 * `staff` actor; any other keeps the root's), opens one `canvas` span per driver action and records every error answer
 * on the root (recordHttpError).
 */
export function createCanvasHandler({
  apps,
  diagnostic,
  enabled = () => true,
  runtime = null,
  principal = () => null,
  csrf = () => null,
  traces = null,
  traceActor = (caller) =>
    ['staff', 'local-admin'].includes(caller?.kind) ? { kind: 'staff', id: caller.principalId, name: null } : null,
} = {}) {
  if (typeof apps !== 'function') throw new TypeError('createCanvasHandler needs an apps() function.');
  // Every JSON answer of 400 or more is the request root's error ({ error } or the first failed formula of an outcome).
  const json = (res, status, value) => {
    if (status >= 400) {
      const error = value?.error ?? value?.errors?.find((item) => item.status >= 400) ?? value?.errors?.[0];
      const span = traces?.current() ?? null;
      // A plug-in fault keeps the identity its Dataverse spans carry (traceError, D-R3-19).
      if (error?.traceError) span?.setStatus(statusFromHttp(status)).setError(error);
      else recordHttpError(span, status, { code: error?.code, message: error?.message });
    }
    writeJson(res, status, value);
  };
  // One canvas span per driver action (start, select <control>.OnSelect, run <formula>, …); the formula text is input at
  // level full; an action whose formulas failed ends with the first failure (denied for a refused write).
  const traceAction = async (app, action, fn) => {
    if (!traces?.enabled) return fn();
    const kind = String(action.action ?? 'unknown');
    const property =
      kind === 'codecomponent-event'
        ? action.event
        : kind === 'start' || kind === 'reset'
          ? 'OnStart'
          : ACTION_PROPERTY[kind];
    const control = kind === 'start' || kind === 'reset' ? 'App' : (action.control ?? null);
    const target = control && property ? `${control}.${property}` : (action.control ?? action.screen ?? null);
    const name = ['run', 'evaluate'].includes(kind)
      ? `${kind} ${action.formula ?? ''}`
      : kind === 'start' || kind === 'reset' || !target
        ? kind
        : `${kind} ${target}`;
    const span = traces.start({
      kind: 'canvas',
      name,
      module: 'canvas',
      operation: kind,
      attributes: {
        app: app.uniqueName,
        action: kind,
        ...(control ? { control } : {}),
        ...(property ? { property } : {}),
        ...(action.screen ? { screen: action.screen } : {}),
        ...(Number.isInteger(action.item) ? { item: action.item } : {}),
      },
      input: () => ({
        formula:
          typeof action.formula === 'string'
            ? action.formula
            : control && property
              ? formulaOf(app.source, control, property)
              : null,
        ...(action.parameters ? { parameters: action.parameters } : {}),
        ...(action.value !== undefined ? { value: action.value } : {}),
      }),
    });
    let outcome;
    try {
      outcome = await traces.run(span, fn);
    } catch (error) {
      span.fail(error);
      throw error;
    }
    const failed = outcome.errors?.find((item) => item.status >= 400) ?? outcome.errors?.[0];
    span.output(() => ({ result: outcome.result ?? null, errors: outcome.errors ?? [] }));
    if (failed)
      span.end({
        status: failed.status >= 400 ? statusFromHttp(failed.status) : 'error',
        error: failed.traceError
          ? failed
          : { code: failed.code ?? 'CanvasFormulaError', message: failed.message ?? '' },
        attributes: { errors: outcome.errors.length },
      });
    else span.end();
    return outcome;
  };
  const reported = new Set();
  const once = (key, entry) => {
    if (!reported.has(key)) {
      reported.add(key);
      diagnostic?.(entry);
    }
  };
  const callerOf = async (req) => {
    const caller = await principal(req);
    if (!caller?.principalId)
      throw failure(
        401,
        'CanvasPrincipalRequired',
        'Select a staff user in /_sim/ (or sign in to the portal) before running a canvas app.',
      );
    return { kind: caller.kind, principalId: caller.principalId };
  };
  async function api(req, res, app) {
    traces?.current()?.set({ app: app.uniqueName });
    if (!runtime)
      throw failure(
        501,
        'CanvasRuntimeUnavailable',
        'This host does not run canvas apps (no canvas runtime is wired).',
      );
    if (!LOOPBACK.has(req.socket?.remoteAddress))
      throw failure(403, 'LoopbackRequired', 'The canvas driver API answers loopback callers only.');
    const caller = await callerOf(req);
    // A GET never starts the app (OnStart may write): it answers the running instance, else { started: false }.
    if (req.method === 'GET') {
      const instance = runtime.existing(app.uniqueName, caller);
      return json(
        res,
        200,
        instance ? await instance.observe() : { app: app.uniqueName, started: false, rendered: false },
      );
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'GET, POST');
      throw failure(405, 'MethodNotAllowed', 'The canvas driver API takes GET or POST.');
    }
    const { form, csrf: token, action } = await readForm(req);
    if (!csrf() || token !== csrf()) throw failure(403, 'CsrfRequired', 'Missing simulator CSRF token.');
    if (action.sourceRevision !== undefined && action.sourceRevision !== app.source.revision)
      throw failure(
        409,
        'CanvasSourceChanged',
        'The app source changed. Reload the player and explicitly start its new revision.',
      );
    if (action.action === 'reset' || action.action === 'start') {
      // Launch parameters (Param) of a new instance: a record of text values; a running instance keeps its own (parameter
      // values do not change until the app reloads), so a page that passes new ones resets first.
      const parameters = action.parameters ?? {};
      if (
        !parameters ||
        typeof parameters !== 'object' ||
        Array.isArray(parameters) ||
        Object.values(parameters).some((value) => !['string', 'number', 'boolean'].includes(typeof value))
      )
        throw failure(
          400,
          'CanvasParametersInvalid',
          'parameters must be an object of text, number or Boolean values.',
        );
      const viewport = action.viewport === undefined ? undefined : canvasViewport(action.viewport);
      const { snapshot } = await traceAction(app, action, async () => {
        if (action.action === 'reset') runtime.reset(app.uniqueName, caller);
        // A new instance ran App.OnStart now: its errors are this action's outcome.
        const fresh = !runtime.existing(app.uniqueName, caller);
        const snapshot = await (await runtime.session(app.uniqueName, caller, { parameters, viewport })).observe();
        return { snapshot, errors: fresh ? (snapshot.errors ?? []) : [] };
      });
      if (form) {
        res.writeHead(303, { location: `${PREFIX}${encodeURIComponent(app.uniqueName)}?view=inspect` });
        return res.end();
      }
      return json(res, 200, { result: null, errors: [], snapshot });
    }
    const outcome = await traceAction(app, action, async () =>
      (await runtime.session(app.uniqueName, caller)).act(action),
    );
    if (form) {
      res.writeHead(303, { location: `${PREFIX}${encodeURIComponent(app.uniqueName)}?view=inspect` });
      return res.end();
    }
    // A failed data-source write answers its status (403 when the principal may not write), with the snapshot after it.
    const status = outcome.errors.find((error) => error.status >= 400)?.status ?? 200;
    return json(res, status, outcome);
  }
  async function view(req, res, app) {
    const { source } = app;
    once(
      app.uniqueName,
      runtime
        ? {
            code: 'CANVAS_NOT_RENDERED',
            message: 'A canvas app page was served headlessly; the app is not rendered.',
            source: app.uniqueName,
          }
        : {
            code: 'CANVAS_HOST_NOT_IMPLEMENTED',
            message: 'A canvas app inventory page was served; this host does not run canvas apps.',
            source: app.uniqueName,
          },
    );
    const diagnostics = source.diagnostics.length
      ? `<ul>${source.diagnostics.map((item) => `<li><code>${escapeHtml(item.code)}</code> ${escapeHtml(item.message)}</li>`).join('')}</ul>`
      : '<p>None.</p>';
    let hosted;
    if (!runtime) hosted = '<p>This host does not run canvas apps; the inventory below is all it shows.</p>';
    else if (!source.screens.length) hosted = '<p>The app has no readable screens; nothing runs.</p>';
    else {
      const caller = await principal(req);
      if (!caller?.principalId)
        hosted =
          '<p>Select a staff user in <a href="/_sim/">/_sim/</a> (or sign in to the portal) to run this app.</p>';
      else {
        const instance = runtime.existing(app.uniqueName, { kind: caller.kind, principalId: caller.principalId });
        // The page never starts the app: a Start form (a CSRF-checked POST) does.
        if (!instance)
          hosted =
            `<p>The app is not running.</p><form method="post" action="${escapeHtml(`${API_PREFIX}${encodeURIComponent(app.uniqueName)}`)}">` +
            `<input type="hidden" name="_csrf" value="${escapeHtml(csrf() ?? '')}"><input type="hidden" name="action" value="start"><button type="submit">Start the app</button></form>`;
        else
          try {
            hosted = appView(app, await instance.observe(), csrf() ?? '');
          } catch (error) {
            hosted = `<p>The app could not be read: <code>${escapeHtml(error.code ?? 'CanvasError')}</code> ${escapeHtml(error.message)}</p>`;
          }
      }
    }
    send(
      res,
      200,
      'text/html; charset=utf-8',
      page(
        source.app.name,
        `<h1>${escapeHtml(source.app.name)}</h1><dl>` +
          `<dt>Unique name</dt><dd>${escapeHtml(app.uniqueName)}</dd><dt>Version</dt><dd>${escapeHtml(source.app.version ?? 'unknown')}</dd>` +
          `<dt>Schema</dt><dd>${escapeHtml(source.app.schemaVersion ?? 'unknown')}</dd><dt>Formulas</dt><dd>${source.formulas.length}</dd></dl>` +
          `<h2>Screens</h2><ul>${source.screens.map((screen) => `<li>${escapeHtml(screen.name)}</li>`).join('')}</ul><h2>Diagnostics</h2>${diagnostics}` +
          `<h2>Headless app</h2>${hosted}`,
        Boolean(runtime),
      ),
    );
  }
  const handle = async (req, res, url) => {
    const { pathname } = url;
    // The root's actor is the principal the app runs as; an unusable session is answered by the paths that need one.
    if (traces?.enabled)
      try {
        traces.current()?.setActor(traceActor(await principal(req)));
      } catch {
        /* no actor */
      }
    if (enabled() === false) {
      once(':disabled', {
        code: 'CANVAS_DISABLED',
        message: 'A /_apps/canvas/ request was refused: canvas.enabled is false for this runtime.',
      });
      return json(res, 404, {
        error: {
          message: 'Canvas apps are disabled for this runtime (canvas.enabled is false).',
          code: 'CanvasAppsDisabled',
        },
      });
    }
    const list = apps() ?? [];
    const find = (encoded) => {
      let name = null;
      try {
        name = decodeURIComponent(encoded);
      } catch {
        name = null;
      }
      return name && list.find((entry) => entry.uniqueName === name);
    };
    if (pathname.startsWith(API_PREFIX)) {
      const app = /^[^/]+$/.test(pathname.slice(API_PREFIX.length)) && find(pathname.slice(API_PREFIX.length));
      if (!app) throw failure(404, 'CanvasAppNotFound', 'Canvas app not found.');
      return api(req, res, app);
    }
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return json(res, 405, {
        error: {
          message: 'Canvas app pages require GET; drive an app through POST /_apps/api/canvas/<app>.',
          code: 'MethodNotAllowed',
        },
      });
    }
    const rest = pathname.slice(PREFIX.length);
    const assetRoute = /^([^/]+)\/assets\/([^/]+)$/.exec(rest);
    if (assetRoute) {
      const app = find(assetRoute[1]);
      let name;
      try {
        name = decodeURIComponent(assetRoute[2]);
      } catch {
        name = null;
      }
      const asset = name && app?.source?.[CANVAS_ASSETS]?.get(name);
      if (!asset) throw failure(404, 'CanvasAssetNotFound', 'Canvas asset not found.');
      if (asset.type === 'image/svg+xml')
        res.setHeader(
          'content-security-policy',
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
      return send(res, 200, asset.type, asset.data);
    }
    if (!rest || pathname === '/_apps/canvas') {
      if (/\bapplication\/json\b/.test(req.headers.accept ?? ''))
        return json(res, 200, {
          level: runtime ? 'behaviour' : 'inventory',
          reason: reasonOf(runtime),
          hosted: Boolean(runtime),
          apps: list.map(summary(Boolean(runtime))),
        });
      return send(
        res,
        200,
        'text/html; charset=utf-8',
        page(
          'Canvas apps',
          `<h1>Canvas apps</h1><ul>${list
            .map(
              (app) =>
                `<li><a href="${PREFIX}${escapeHtml(encodeURIComponent(app.uniqueName))}">${escapeHtml(app.source.app.name)}</a> (${escapeHtml(app.uniqueName)})</li>`,
            )
            .join('')}</ul>`,
          Boolean(runtime),
          true,
        ),
      );
    }
    const asset = await canvasPlayerAsset(rest);
    if (asset) return send(res, 200, asset.type, asset.body);
    const [, inventory, encoded] = /^(api\/)?([^/]+)$/.exec(rest) ?? [];
    const app = encoded && find(encoded);
    if (!app) throw failure(404, 'CanvasAppNotFound', 'Canvas app not found.');
    if (inventory && url.searchParams.get('revision') === '1')
      return json(res, 200, { revision: app.source.revision ?? null });
    if (inventory)
      return json(res, 200, {
        uniqueName: app.uniqueName,
        level: levelOf(app.source, Boolean(runtime)),
        reason: canvasSourceCoverageGaps(app.source)[0]?.code ?? reasonOf(runtime),
        ...app.source,
        assets: canvasAssetUrls(app.uniqueName, app.source[CANVAS_ASSETS] ?? new Map()),
        rendering: { level: 'contract', gaps: canvasRenderingGaps(app.source) },
      });
    if (runtime && app.source.screens.length && url.searchParams.get('view') !== 'inspect') {
      // Explicitly trusted PCF bundles commonly generate Fluent CSS at runtime. Script execution stays same-origin.
      if (Object.values(app.source.codeComponents ?? {}).some((component) => component.admitted))
        res.setHeader('content-security-policy', CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"));
      return send(
        res,
        200,
        'text/html; charset=utf-8',
        canvasPlayerPage(app, csrf() ?? '', {
          traceId: res.getHeader('x-trace-id') ?? null,
          spanId: res.getHeader('x-sim-span-id') ?? null,
        }),
      );
    }
    return view(req, res, app);
  };
  return (req, res, url = new URL(req.url, 'http://localhost')) => {
    const { pathname } = url;
    if (pathname !== '/_apps/canvas' && !pathname.startsWith(PREFIX) && !pathname.startsWith(API_PREFIX)) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('content-security-policy', CSP);
    handle(req, res, url).catch((error) => {
      if (res.headersSent || res.destroyed) return;
      const status = error.status ?? 500;
      json(res, status, {
        error: {
          code: error.code ?? 'CanvasError',
          message: status >= 500 && !error.code ? 'The canvas request failed.' : error.message,
        },
      });
    });
    return true;
  };
}
