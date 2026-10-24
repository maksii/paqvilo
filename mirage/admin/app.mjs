import { personaSessionPanel, personaManagementPanel, mountPersonaAdministration } from './persona-manager.mjs';
import * as kit from './ui-kit.mjs';
import { renderDashboard, renderNodeDetail } from './dashboard-map.mjs';
import * as icons from './dashboard-icons.mjs';
import { HELP } from './help-content.mjs';
import { view as servicesView } from './view-services.mjs';
import { view as flowsView } from './view-flows.mjs';
import { view as capabilitiesView } from './view-capabilities.mjs';
import { view as packsView } from './view-packs.mjs';
let personaCatalogue, selectedPersonaKey;
const API = '/__sim/api';
const $ = (selector, root = document) => root.querySelector(selector);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const json = (value) => JSON.stringify(value, null, 2);
const badge = (text, tone = '') => `<span class="badge ${tone}">${escape(text)}</span>`;
// View modules: DOM-free `{ id, label, icon, hosts, requires, load(ctx), render(ctx), handle(ctx, event) }`
// objects, plus the optional hooks `mounted(ctx)` (after each render) and `leave(ctx)` (when the view closes).
// Wiring another module is one import and one entry in this array.
const BOTH = ['power-pages', 'standalone'];
const modules = [dashboardModule(), servicesView, flowsView, capabilitiesView, packsView];
// Built-in views: a view without `requires` exists on every host; otherwise its first route decides. When the
// host publishes `status.routes` (its mounted admin routes) the list answers without a request; otherwise built-in
// routes are probed on standalone hosts only (Power Pages hosts serve every built-in route) and module routes everywhere.
// Views of the portal source need the portal page-resources route (Power Pages hosts only).
const PORTAL_SOURCE = '/_sim/api/page-resources';
const builtInViews = [
  { id: 'overview', label: 'Overview', icon: '◈' },
  { id: 'records', label: 'Data records', icon: '▤' },
  { id: 'portal', label: 'Portal configuration', icon: '✎', requires: [PORTAL_SOURCE] },
  { id: 'platform', label: 'Platform rules', icon: '⚙', requires: ['/_sim/api/platform-settings'] },
  { id: 'overrides', label: 'Settings & snippet overrides', icon: '✎', requires: [PORTAL_SOURCE] },
  { id: 'endpoints', label: 'Endpoints', icon: '⇄', requires: [PORTAL_SOURCE] },
  { id: 'operations', label: 'Backend operations', icon: '⚑' },
  { id: 'mappings', label: 'Entity mappings', icon: '◇', requires: [PORTAL_SOURCE] },
  { id: 'plugins', label: 'Plugins & presets', icon: '⌘', requires: [PORTAL_SOURCE] },
  { id: 'access', label: 'Portal identity & permissions', icon: '♙', requires: ['/_sim/api/personas'] },
  { id: 'dataverse', label: 'Organization identity & API', icon: '⬡' },
  { id: 'scenarios', label: 'Scenarios', icon: '▶', requires: ['/_sim/api/scenarios'] },
  { id: 'environment', label: 'Environment', icon: '⚙', requires: ['/_sim/api/environment'] },
  { id: 'connection', label: 'Live connection', icon: '↗', requires: [PORTAL_SOURCE] },
  { id: 'runtime', label: 'Runtime state', icon: '⟳' },
  { id: 'evidence', label: 'Render & diagnostics', icon: '◎', requires: ['/_sim/api/diagnostics'] },
  { id: 'audit', label: 'Request audit', icon: '≋', requires: ['/_sim/api/audit'] },
  { id: 'logs', label: 'Live logs', icon: '☰', requires: ['/_sim/events'] },
];
const views = [...modules.map((module) => ({ ...module, module })), ...builtInViews];
const NAV_GROUPS = [
  ['Monitor', ['dashboard', 'overview', 'logs', 'audit', 'evidence']],
  ['Data', ['records', 'packs', 'plugins', 'mappings', 'endpoints']],
  ['Platform', ['services', 'flows', 'capabilities', 'operations', 'environment', 'platform', 'overrides', 'portal']],
  ['Identity', ['access', 'dataverse', 'scenarios']],
  ['Runtime', ['runtime', 'connection']],
];
const groupOf = (id) => NAV_GROUPS.find(([, ids]) => ids.includes(id))?.[0] ?? 'Platform';
const collapsedGroups = new Set();
let state;
// GET /status, read once per session when `/state` carries no `docs`; it may also carry `routes`.
let statusExtra;
const capabilities = () => state?.capabilities ?? state?.status?.capabilities ?? {};
const powerPages = () => capabilities().powerPages !== false;
const hostKind = () => (powerPages() ? 'power-pages' : 'standalone');
// Route probes: one GET per required route and session; only a 404 hides a view. A host that publishes
// `status.routes` answers from that list instead, so no probe request (and no 404 console noise) is made.
const probes = new Map();
const probeUrl = (route) => String(route).replace(/^\/_{1,2}sim\//, '/__sim/');
const probing = new Map();
const API_ROOT = '/__sim/api';
// Portal-only routes: a standalone host (powerPages === false) never serves them, so they are never probed there.
const PORTAL_ONLY =
  /^\/__sim\/(?:api\/(?:personas|session|scenarios|presets|portal-[a-z-]+|page-resources|audit|experiments)|events)(?:[/?]|$)/;
// `status.routes`: the mounted /_sim/api route prefixes ("/dashboard", "/flow-runs", …; full "/_sim/api/…" paths work too).
const publishedRoutes = () => {
  const routes = state?.status?.routes ?? state?.routes ?? statusExtra?.routes;
  return Array.isArray(routes)
    ? routes.map((route) => {
        const url = probeUrl(route);
        return url.startsWith('/__sim/') ? url : `${API_ROOT}${url.startsWith('/') ? '' : '/'}${url}`;
      })
    : null;
};
/** What the host says without a request: the published list for /_sim/api routes, `false` for portal-only routes on a standalone host; else undefined. */
const declared = (url) => {
  const list = publishedRoutes();
  if (list && url.startsWith(`${API_ROOT}/`))
    return list.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
  return !powerPages() && PORTAL_ONLY.test(url) ? false : undefined;
};
/** True when the host serves `route`: declared, else a probe answer, else served on Power Pages. */
const hasRoute = (route) => declared(probeUrl(route)) ?? probes.get(probeUrl(route)) ?? powerPages();
function probe(route) {
  const url = probeUrl(route);
  const answer = declared(url) ?? probes.get(url);
  if (answer !== undefined) return Promise.resolve(answer);
  if (!probing.has(url))
    probing.set(
      url,
      fetch(url, { cache: 'no-store', headers: { accept: 'application/json, text/event-stream' } })
        .then((response) => {
          response.body?.cancel().catch(() => {});
          probes.set(url, response.status !== 404);
          return probes.get(url);
        })
        .catch(() => false)
        .finally(() => probing.delete(url)),
    );
  return probing.get(url);
}
const probed = (view) => {
  if (!view.requires?.length) return true;
  const url = probeUrl(view.requires[0]);
  return declared(url) ?? ((!view.module && powerPages()) || probes.get(url) === true);
};
const viewAvailable = (view) => (view.hosts ?? BOTH).includes(hostKind()) && probed(view);
const probeViews = () =>
  Promise.all(
    views
      .filter(
        (view) => (view.hosts ?? BOTH).includes(hostKind()) && view.requires?.length && (view.module || !powerPages()),
      )
      .map((view) => probe(view.requires[0])),
  );
const availableViews = () => views.filter(viewAvailable);
const moduleFor = (id) => views.find((view) => view.id === id)?.module;
const runtimeLinks = () => state?.links ?? state?.status?.links ?? {};
const docs = () => state?.docs ?? state?.status?.docs ?? statusExtra?.docs ?? {};
const docOf = (path) => (path ? kit.docLink(path, docs()) : undefined);
const helpKey = (key) => `help-${String(key).replace(/[^a-z0-9-]+/gi, '-')}`;
/** Help from help-content (`<view>.<panel>`): its first sentence, with the details and doc link behind an (i) tooltip. */
const panelHelp = (key, title) =>
  HELP[key]
    ? kit.leadHelp({
        id: helpKey(key),
        label: title,
        text: HELP[key].intro,
        steps: HELP[key].steps,
        example: HELP[key].example,
        doc: docOf(HELP[key].doc),
      })
    : '';
/** Visible help for one control from `HELP[key].fields[name]`; the control carries `aria-describedby="<id>-help"`. */
const controlHelp = (id, key, name) => kit.fieldHelp(id, HELP[key]?.fields?.[name] ?? '');
/** The `fields` legend of a help entry (audit kinds, log types, operation modes…) as a collapsed list. */
const legend = (key, title = 'What the values mean') =>
  HELP[key]?.fields
    ? kit.section({
        key: `legend:${key}`,
        title,
        body: `<ul class="help-list">${Object.values(HELP[key].fields)
          .map((text) => `<li>${escape(text)}</li>`)
          .join('')}</ul>`,
      })
    : '';
/** The guide that starts every view: intro, steps, example and doc links from help-content. */
const viewGuide = (key) =>
  HELP[key]
    ? kit.guide({
        key,
        intro: kit.splitLead(HELP[key].intro)[0],
        details: kit.splitLead(HELP[key].intro)[1],
        steps: HELP[key].steps ?? [],
        example: HELP[key].example,
        docs: HELP[key].doc ? [docOf(HELP[key].doc)] : [],
      })
    : '';
/**
 * Tie visible field help to its control (aria-describedby): help that sits in the same field wrapper as a
 * control gets the id `<control id>-help`; help built with `kit.fieldHelp` already carries it.
 */
function linkFieldHelp(root) {
  for (const help of root.querySelectorAll('form .field-help, form .ui-field-help')) {
    let control = null;
    for (
      let scope = help.parentElement, depth = 0;
      scope && !control && depth < 3 && !scope.matches('form');
      scope = scope.parentElement, depth++
    )
      control = scope.querySelector('input[id]:not([type=hidden]), select[id], textarea[id]');
    if (!control) continue;
    if (!help.id) help.id = `${control.id}-help`;
    const described = new Set((control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
    if (!described.has(help.id)) control.setAttribute('aria-describedby', [...described, help.id].join(' '));
  }
}
// The context every view module receives (built once; getters read the current state).
const ctx = {
  request: (...args) => request(...args),
  refresh: (...args) => refresh(...args),
  notify: (...args) => notify(...args),
  setButtonPending: (...args) => setButtonPending(...args),
  askConfirmation: (...args) => askConfirmation(...args),
  render: () => render(),
  state: () => state,
  session: () => browserSession,
  data: {},
  pager: (key) => browserFor(key),
  open: (key) => openDisclosures.has(key) || sectionState.get(key) === true,
  toggle(key) {
    if (openDisclosures.has(key)) openDisclosures.delete(key);
    else openDisclosures.add(key);
    render();
  },
  help: HELP,
  docs,
  links: runtimeLinks,
  capabilities,
  escape,
  kit,
  view: () => activeView,
  group: () => groupOf(activeView),
  /** Scroll to and highlight `selector` after the next render (a details or a row the action just opened). */
  reveal: (selector) => {
    landing = { view: activeView, selector };
  },
};
// An (i) tooltip inside a scrolling table would be clipped by the table frame: while it shows, it is placed in the
// viewport under its button instead.
for (const type of ['mouseover', 'focusin'])
  document.addEventListener(type, (event) => {
    const info = event.target.closest?.('.ui-info');
    const pop = info?.closest('.table-wrap, .ui-table-wrap') && info.querySelector('.ui-info-pop');
    if (!pop) return;
    const box = info.getBoundingClientRect();
    Object.assign(pop.style, {
      position: 'fixed',
      top: `${box.bottom + 8}px`,
      left: `${Math.max(8, Math.min(box.left - 12, innerWidth - 400))}px`,
    });
  });
// Delegated events reach the active view module first; `handle` returns true when it consumed the event.
for (const type of ['click', 'submit', 'change', 'input', 'keydown'])
  document.addEventListener(type, (event) => {
    const module = moduleFor(activeView);
    if (!module?.handle || !$('#content')?.contains(event.target)) return;
    if (module.handle(ctx, event) === true) event.stopImmediatePropagation();
  });
const recordAccess = () => (state?.recordCapabilities ?? state?.status?.recordCapabilities)?.[selectedEntity] ?? {};
const disabledRecordAction = (operation) =>
  recordAccess()[operation] === false
    ? ` disabled title="${escape(recordAccess().reason ?? 'No pack DATA owner is declared for this table.')}"`
    : '';
let staffSession,
  staffSessionError = '';
async function loadStaffSession() {
  try {
    staffSession = await request('/dataverse/session');
    staffSessionError = '';
  } catch (error) {
    staffSession = undefined;
    staffSessionError = error.message;
  }
}
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'staff-session-form') return;
  event.preventDefault();
  const button = event.submitter;
  if (!setButtonPending(button, true)) return;
  try {
    staffSession = await request('/dataverse/session', {
      method: 'POST',
      body: JSON.stringify({ userId: $('#staff-user').value }),
    });
    staffSessionError = '';
    drafts.delete('staff-session-form');
    render();
    notify('Staff session changed. Reload open model-driven tabs to use this identity.');
  } catch (error) {
    setButtonPending(button, false, true);
    notify(error.message, true);
  } finally {
    setButtonPending(button, false);
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="staff-reset"]');
  if (!button) return;
  if (!setButtonPending(button, true)) return;
  try {
    staffSession = await request('/dataverse/session', { method: 'DELETE' });
    staffSessionError = '';
    render();
    notify('Local administrator selected. Reload open model-driven tabs to use this identity.');
  } catch (error) {
    setButtonPending(button, false, true);
    notify(error.message, true);
  } finally {
    setButtonPending(button, false);
  }
});
function staffSessionPanel() {
  if (capabilities().modelDriven === false) return '';
  const current = staffSession?.current;
  return `<section class="panel section-gap" data-panel="staff-session"><div class="panel-heading"><h2>Model-driven staff session</h2>${badge(current?.kind === 'staff' ? 'Staff user' : current ? 'Local administrator' : 'Session unavailable', current?.kind === 'staff' ? '' : 'amber')}</div>${panelHelp('dataverse.staff-session', 'the staff session')}${staffSessionError ? `<div class="notice warning">${escape(staffSessionError)}</div>` : ''}${current ? `<p><strong>${escape(current.name)}</strong> · ${escape((current.roles ?? []).join(', ') || 'No roles')}</p>` : ''}<form id="staff-session-form" class="form-grid"><div><label for="staff-user">Staff user</label><select id="staff-user" aria-describedby="staff-user-help" ${staffSession?.users?.length ? '' : 'disabled'}>${(staffSession?.users ?? []).map((user) => `<option value="${escape(user.id)}" ${current?.id === user.id ? 'selected' : ''}>${escape(user.name)} · ${escape((user.roles ?? []).join(', ') || 'No roles')}</option>`).join('') || '<option>No eligible staff users; create an interactive user below.</option>'}</select>${controlHelp('staff-user', 'dataverse.staff-session', 'user')}</div><div class="toolbar"><button type="submit" class="button primary" ${staffSession?.users?.length ? '' : 'disabled'}>Use staff user</button><button type="button" class="button" data-action="staff-reset">Use local administrator</button></div></form></section>`;
}
// Plain words for the persistence values a runtime reports (lib/simulation-settings.mjs, simulation-persistence.mjs).
const PERSISTENCE = {
  memory: 'In memory only: gone when this runtime stops',
  'pack-data-files': 'The pack DATA files listed below',
  'local-state': "This runtime's private state file",
  'private-local-state': "This runtime's private state file",
};
/** One fact row: label with an (i) explanation, then the value. */
const fact = (label, valueHtml, tip) =>
  `<div class="row"><span class="row-title">${escape(label)}${tip ? kit.info({ label: `About ${label}`, text: tip }) : ''}</span><span>${valueHtml}</span></div>`;
function simulationPanel() {
  const policy = state?.simulation ?? state?.status?.simulation;
  if (!policy) return '';
  const labels = {
    'dry-run': 'Dry run',
    simulation: 'Simulation',
    deep: 'Deep simulation',
    'local-state': 'Legacy local state',
  };
  const kind = state?.runtime?.kind ?? state?.status?.runtime?.kind ?? 'power-pages';
  const targets = policy.targets ?? [];
  return (
    `<section class="panel section-gap" data-panel="persistence"><div class="panel-heading"><h2>Runtime & persistence</h2>${badge(labels[policy.level] ?? policy.level, policy.level === 'dry-run' ? 'green' : 'amber')}</div>${panelHelp(activeView === 'runtime' ? 'runtime.persistence' : 'overview.runtime', 'runtime and persistence')}<div class="detail-list">` +
    fact(
      'Runtime kind',
      escape(
        {
          'power-pages': 'Power Pages portal with its organization',
          'model-driven': 'Model-driven apps with their organization',
          'dataverse-api': 'Dataverse Web API only',
        }[kind] ?? kind,
      ),
      'What this runtime serves. It comes from the project configuration and changes only after a restart.',
    ) +
    fact(
      'Record changes are kept in',
      escape(PERSISTENCE[policy.recordPersistence] ?? policy.recordPersistence),
      'Where creates, updates and deletes of business records (accounts, contacts and other tables) go. Set by the simulation level in Project setup.',
    ) +
    fact(
      'Sign-ins, users and secrets are kept in',
      escape(
        PERSISTENCE[policy.controlPlanePersistence ?? (policy.level === 'dry-run' ? 'memory' : 'private-local-state')],
      ),
      'Where local registrations, staff users, password and secret hashes are stored. Never in your source files.',
    ) +
    fact(
      'Table and column changes',
      policy.schemaChanges ? 'Allowed' : 'Not allowed',
      'Whether this runtime may add tables or columns. Only deep simulation (or the legacy local state) allows it.',
    ) +
    `</div>${policy.level === 'dry-run' ? '' : policy.legacy ? '<p class="muted">This configuration names no simulation level, so it keeps the older private state file. Choose a level in Project setup to write pack DATA files instead.</p>' : '<p class="muted">Tables without a pack DATA file are read-only here.</p>'}` +
    (targets.length
      ? pagedTable('data-targets', targets, {
          caption: 'Pack DATA files that receive record changes',
          columns: [
            { label: 'Pack', render: (target) => `<strong>${escape(target.packId)}</strong>` },
            { label: 'File', render: (target) => `<span class="source-path">${escape(target.file)}</span>` },
            {
              label: 'Tables',
              info: 'The tables whose record changes this file receives. "schema destination" means it also receives table and column changes.',
              render: (target) =>
                `${escape(Array.isArray(target.tables) ? target.tables.join(', ') : JSON.stringify(target.tables ?? []))}${target.schema ? ' · schema destination' : ''}`,
            },
          ],
        })
      : '') +
    `${policy.ready === false ? '<div class="notice warning">Persistence is not ready. Review declared DATA files before writing.</div>' : ''}<p class="muted">${Number(policy.dirtyRecords ?? 0)} records changed since start${policy.dirtyTables?.length ? ` · ${escape(policy.dirtyTables.join(', '))}` : ''}.</p><a class="button" href="/_setup/#runtime-configuration">Change the level in Project setup</a></section>`
  );
}
// Deep links are #view or #view?name=value: records (entity, id), audit filters,
// portal items (kind, name), access (contact) and logs (type).
// An empty hash lands on the Infrastructure dashboard; an unknown one on the overview.
const parseHash = () => {
  const [view = '', query = ''] = location.hash.slice(1).split('?');
  return { view: view === 'identity' ? 'access' : view || 'dashboard', params: new URLSearchParams(query) };
};
let activeView = views.some(({ id }) => id === parseHash().view) ? parseHash().view : 'overview';
let pendingRoute = null,
  routeNotice = '';
// Where a navigation lands: entering a view scrolls to its top and focuses its heading; `#view?panel=<key>` opens,
// scrolls to and highlights that panel once the view's data has loaded (so later content cannot push it away);
// ctx.reveal does the same for an element an action just rendered.
let landing = { view: activeView, top: true, panel: parseHash().params.get('panel') };
// The landed panel stays outlined for a moment, also across the re-renders of polling views.
let landed = null;
const panelTarget = (view, key) => {
  const content = $('#content'),
    quoted = CSS.escape(key);
  return (
    content.querySelector(
      [
        `[data-ui-section="${view}:${quoted}"]`,
        `[data-ui-section="${view}-${quoted}"]`,
        `[data-ui-section="${quoted}"]`,
        `[data-disclosure="${quoted}"]`,
        `[data-panel="${quoted}"]`,
      ].join(', '),
    ) ?? content.querySelector(`#${quoted}`)
  );
};
function land() {
  if (landed?.view === activeView) landed.find()?.classList.add('is-landed');
  if (!landing || landing.view !== activeView) return;
  if (landing.top) {
    landing.top = false;
    window.scrollTo(0, 0);
    $('#view-title')?.focus({ preventScroll: true });
  }
  if (!landing.selector && !landing.panel) {
    landing = null;
    return;
  }
  if (!landing.selector && !landing.ready) return;
  const { selector, panel } = landing,
    find = () => (selector ? $('#content').querySelector(selector) : panelTarget(activeView, panel));
  const target = find();
  if (!target) return;
  landing = null;
  if (target.localName === 'details') target.open = true;
  target.scrollIntoView({ block: 'start' });
  if (!target.matches('a, button, input, select, textarea, summary, [tabindex]')) target.setAttribute('tabindex', '-1');
  (target.localName === 'details' ? target.querySelector('summary') : target).focus({ preventScroll: true });
  target.classList.add('is-landed');
  const mark = (landed = { view: activeView, find });
  setTimeout(() => {
    if (landed !== mark) return;
    landed = null;
    mark.find()?.classList.remove('is-landed');
  }, 2500);
}
let selectedEntity = '';
let filter = '';
let editContext;
let confirmAction;
let toastTimer;
let shellCaptureResult;
// Shell capture starts from the site home page; any other portal page can be entered.
let shellCapturePath = '/';
let managedControlPath = '';
const browsers = new Map();
const browserFor = (key) => {
  if (!browsers.has(key))
    browsers.set(key, {
      page: 1,
      size: key === 'records' || key === 'logs' ? 20 : 10,
      search: '',
    });
  return browsers.get(key);
};
const openDisclosures = new Set(),
  disclosureRenderers = new Map();
// Open state of kit sections (`details[data-ui-section]`) across re-renders, by key.
const sectionState = new Map();
function disclosure(key, label, renderer) {
  disclosureRenderers.set(key, renderer);
  return `<details class="panel section-gap disclosure" data-disclosure="${escape(key)}" ${openDisclosures.has(key) ? 'open' : ''}><summary>${escape(label)}</summary><div data-disclosure-body>${openDisclosures.has(key) ? renderer() : ''}</div></details>`;
}
// Unsaved form input belongs to the user until that form is submitted successfully or the
// view changes. Views re-render for lazy loads, refreshes and live updates; restore the
// controls the user changed instead of silently replacing them with stored values.
const drafts = new Map();
function rememberDraft(control) {
  const form = control?.closest?.('#content form[id]');
  // File inputs cannot be restored programmatically; their contents are read immediately.
  if (!form || !control.id || !('value' in control) || control.type === 'file') return;
  if (!drafts.has(form.id)) drafts.set(form.id, new Map());
  drafts
    .get(form.id)
    .set(
      control.id,
      control.type === 'checkbox' || control.type === 'radio' ? { checked: control.checked } : { value: control.value },
    );
}
function restoreDrafts() {
  for (const [formId, controls] of drafts) {
    const form = document.getElementById(formId);
    if (!form) continue;
    for (const [id, saved] of controls) {
      const control = form.querySelector(`#${CSS.escape(id)}`);
      if (!control) continue;
      if ('checked' in saved) control.checked = saved.checked;
      else control.value = saved.value;
    }
  }
}
const lazyValues = new Map();
function lazyJson(label, value) {
  const key = String(lazyValues.size);
  lazyValues.set(key, value);
  return `<details class="section-gap lazy-detail" data-lazy-json="${key}"><summary>${escape(label)}</summary><pre class="json-view"></pre></details>`;
}
function inspectButton(value) {
  const key = String(lazyValues.size);
  lazyValues.set(key, value);
  return `<button class="button small" data-inspect="${key}">Inspect request</button>`;
}
/** Client-side paging over the kit (`pageItems`); the page state stays in `browsers` under `key`. */
function sliceRows(key, items, options) {
  const settings = browserFor(key),
    result = kit.pageItems(items, settings, options);
  settings.page = result.page;
  return { ...result, settings };
}
function tableTools(key, total, pages, { search = true } = {}) {
  const settings = browserFor(key);
  if (total <= kit.PAGE_SIZES[0] && !settings.search && settings.page <= 1) return '';
  return kit.tableTools(
    key,
    { total, pages, page: settings.page, size: settings.size, search: settings.search },
    { searchable: search },
  );
}
/** A paged kit table keyed by `key` (rows carry `data-table="key"`). */
// Ten rows or fewer need no search box or pager (the kit pages longer lists).
const pagedTable = (key, items, spec) =>
  items.length <= kit.PAGE_SIZES[0] && !browserFor(key).search
    ? kit.table({ key, items, ...spec })
    : kit.table({ key, result: sliceRows(key, items, spec.text ? { text: spec.text } : undefined), ...spec });
/**
 * A text box that filters a long `<select>` (options) or checkbox list (`.checkbox-line`, `.checkbox-label`)
 * client-side; shown only for more than ten choices. `target` is the select id or the list container id.
 */
const listFilters = new Map();
function filterBox(target, count, label) {
  if (count <= 10) return '';
  return `<input type="search" class="list-filter" id="${escape(target)}-filter" data-filter-target="${escape(target)}" aria-label="${escape(label)}" placeholder="${escape(label)}…" value="${escape(listFilters.get(target) ?? '')}">`;
}
function applyListFilter(input) {
  const target = document.getElementById(input.dataset.filterTarget),
    needle = input.value.trim().toLowerCase();
  listFilters.set(input.dataset.filterTarget, input.value);
  if (!target) return;
  const items =
    target.localName === 'select'
      ? [...target.options]
      : [...target.querySelectorAll('.checkbox-line, .checkbox-label')];
  for (const item of items)
    item.hidden = Boolean(needle) && !item.selected && !item.textContent.toLowerCase().includes(needle);
}
let auditResult,
  auditLoading = false,
  auditError = '',
  auditGeneration = 0;
let recordResult,
  recordLoading = false,
  recordError = '',
  recordGeneration = 0,
  contactsLoading = false;
async function loadRecords() {
  if (state?.data && !state.summaryMode) return;
  const names = entities();
  if (!names.includes(selectedEntity)) selectedEntity = preferredEntity(names);
  if (!selectedEntity) return;
  const generation = ++recordGeneration,
    settings = browserFor('records');
  recordLoading = true;
  recordError = '';
  render();
  try {
    const result = await request(
      `/records/${encodeURIComponent(selectedEntity)}?` +
        new URLSearchParams({
          page: settings.page,
          pageSize: settings.size,
          search: filter,
        }),
    );
    if (generation === recordGeneration) {
      recordResult = result;
      settings.page = result.page;
    }
  } catch (error) {
    if (generation === recordGeneration) recordError = error.message;
  } finally {
    if (generation === recordGeneration) {
      recordLoading = false;
      if (activeView === 'records') render();
    }
  }
}
// Contacts for persona choices: one page of 20, never the whole table. When that page holds every
// contact the choices stay a `<select>`; otherwise each choice is a server-searched lookup (`contactLookup`).
const CONTACT_PAGE = 20;
let contactDirectory = { items: [], total: 0 };
const contactCache = new Map();
const rememberContacts = (rows) => {
  for (const row of rows) contactCache.set(personaId(row.contactid), row);
  return rows;
};
const contactList = () => state?.data?.contact ?? contactDirectory.items;
const contactsComplete = () => Boolean(state?.data?.contact) || contactDirectory.items.length >= contactDirectory.total;
const findContact = (id) =>
  contactList().find((record) => personaId(record.contactid) === personaId(id)) ?? contactCache.get(personaId(id));
async function loadContacts() {
  if (state?.data?.contact || contactsLoading) return;
  contactsLoading = true;
  try {
    const result = await request(`/records/contact?page=1&pageSize=${CONTACT_PAGE}`);
    contactDirectory = {
      items: rememberContacts(result.items ?? []),
      total: Number(result.total ?? result.items?.length ?? 0),
    };
    const wanted = [selectedPersona, browserSession?.contactId, state?.status?.effectiveIdentity?.contactId].filter(
      (id) => id && !findContact(id),
    );
    for (const id of new Set(wanted.map(personaId)))
      rememberContacts(
        (await request(`/records/contact?search=${encodeURIComponent(id)}&pageSize=${CONTACT_PAGE}`)).items ?? [],
      );
  } catch (error) {
    notify(error.message, true);
  } finally {
    contactsLoading = false;
    if (['access', 'scenarios'].includes(activeView)) render();
  }
}
// Lookup search: GET /records/contact?search=<q>&pageSize=20 fills the datalist; choosing an entry sets the hidden id.
let lookupTimer,
  lookupGeneration = 0;
const lookupMatches = new Map();
const lookupText = (record) => `${contactLabel(record)} (${record.contactid})`;
/**
 * A contact choice for `id`: a `<select>` when every contact is loaded, else a search box with a datalist
 * backed by the server and a hidden `#id` input holding the contact id. `fixed` adds leading choices
 * such as "Keep current persona" ([[value, label]]).
 */
function contactChoice(id, label, selectedId, { fixed = [], help = '' } = {}) {
  const describedBy = help ? ` aria-describedby="${escape(id)}-help"` : '';
  const fieldHelpHtml = help ? kit.fieldHelp(id, help) : '';
  if (contactsComplete()) {
    const options = [
      ...fixed.map(([value, text]) => [value, text]),
      ...contactList().map((record) => [record.contactid, contactLabel(record)]),
    ];
    return `<label for="${escape(id)}">${escape(label)}</label><select id="${escape(id)}"${describedBy}>${options.map(([value, text]) => `<option value="${escape(value)}" ${(personaId(value) === personaId(selectedId) && value !== '__keep') || value === selectedId ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select>${fieldHelpHtml}`;
  }
  const chosen =
    fixed.find(([value]) => value === selectedId)?.[1] ??
    (findContact(selectedId) ? lookupText(findContact(selectedId)) : '');
  const matches = lookupMatches.get(id) ?? contactList();
  return (
    `<label for="${escape(id)}-search">${escape(label)}</label><input type="search" id="${escape(id)}-search" list="${escape(id)}-options" data-contact-lookup="${escape(id)}" autocomplete="off" value="${escape(chosen)}" placeholder="Type a name or contact id" aria-describedby="${escape(id)}-search-help">` +
    `<datalist id="${escape(id)}-options">${fixed.map(([value, text]) => `<option value="${escape(text)}" data-contact-value="${escape(value)}"></option>`).join('')}${matches.map((record) => `<option value="${escape(lookupText(record))}" data-contact-value="${escape(record.contactid)}"></option>`).join('')}</datalist>` +
    `<input type="hidden" id="${escape(id)}" value="${escape(selectedId ?? '')}">` +
    kit.fieldHelp(
      `${id}-search`,
      `${contactDirectory.total} contacts: type to search the server (20 matches at a time), then pick an entry.${help ? ` ${help}` : ''}`,
    )
  );
}
function contactLookupInput(input) {
  const id = input.dataset.contactLookup,
    hidden = document.getElementById(id),
    list = document.getElementById(`${id}-options`);
  const exact = [...(list?.options ?? [])].find((option) => option.value === input.value);
  if (exact) {
    hidden.value = exact.dataset.contactValue;
    rememberDraft(hidden);
    contactChosen(id, hidden.value);
    return;
  }
  clearTimeout(lookupTimer);
  const generation = ++lookupGeneration,
    query = input.value.trim();
  lookupTimer = setTimeout(async () => {
    try {
      const result = await request(`/records/contact?search=${encodeURIComponent(query)}&pageSize=${CONTACT_PAGE}`);
      if (generation !== lookupGeneration) return;
      lookupMatches.set(id, rememberContacts(result.items ?? []));
      const options = document.getElementById(`${id}-options`);
      if (options)
        options.innerHTML =
          [...options.querySelectorAll('[data-contact-value]')]
            .filter((option) => !findContact(option.dataset.contactValue))
            .map((option) => option.outerHTML)
            .join('') +
          lookupMatches
            .get(id)
            .map(
              (record) =>
                `<option value="${escape(lookupText(record))}" data-contact-value="${escape(record.contactid)}"></option>`,
            )
            .join('');
    } catch (error) {
      notify(error.message, true);
    }
  }, 250);
}
/** The effect of choosing a contact, for selects and lookups alike. */
function contactChosen(id, value) {
  if (id === 'session-contact') {
    sessionPick = value;
    const button = document.querySelector('[data-action="session-sign-in"]');
    if (button) button.textContent = `Sign in as ${contactLabel(findContact(value)) || value}`;
  }
  if (id === 'persona-contact') {
    selectedPersona = value;
    // Membership choices belong to the previously selected contact.
    drafts.delete('persona-form');
    render();
  }
}
let accessRules,
  accessRulesError = '';
async function loadAccessRules() {
  try {
    accessRules = await request('/portal-access-rules');
    accessRulesError = '';
  } catch (error) {
    accessRules = undefined;
    accessRulesError = error.message;
  }
  if (activeView === 'portal') render();
}
let environmentResult,
  environmentError = '',
  enrichmentReport = null;
async function loadEnvironment() {
  try {
    environmentResult = await request('/environment');
    environmentError = '';
  } catch (error) {
    environmentResult = undefined;
    environmentError = error.message;
  }
  if (activeView === 'environment') render();
}
// Module load state per view: a module renders only after its data arrived; a failed load shows its error.
const moduleLoads = new Map();
async function loadView() {
  if (activeView !== 'logs') disconnectLogs();
  for (const module of modules) if (module.id !== activeView) module.leave?.(ctx);
  const module = moduleFor(activeView),
    loading = activeView;
  if (module?.load) {
    try {
      await module.load(ctx);
      moduleLoads.set(loading, { loaded: true });
    } catch (error) {
      moduleLoads.set(loading, { loaded: moduleLoads.get(loading)?.loaded === true, error });
    }
    if (activeView === loading) render();
  }
  if (activeView === 'audit') await loadAudit();
  if (activeView === 'operations') {
    await loadOperations().catch((error) => notify(error.message, true));
    if (!powerPages()) render();
  }
  if (activeView === 'records') await loadRecords();
  if (['access', 'scenarios'].includes(activeView)) {
    personaCatalogue = await request('/personas');
    if (personaCatalogue.version !== 1) personaCatalogue = undefined;
    await loadContacts();
    render();
  }
  if (activeView === 'access') {
    await loadExternalIdentities();
    if (activeView === 'access') render();
  }
  if (activeView === 'portal') await loadAccessRules();
  if (activeView === 'environment') await loadEnvironment();
  if (activeView === 'dataverse') {
    if (capabilities().modelDriven !== false) await loadStaffSession();
    await loadDataverse();
  }
  if (activeView === 'logs') connectLogs();
  await followRoute();
  // The view's data is in: a panel the link named either lands now or does not exist here.
  if (landing?.view === activeView) landing.ready = true;
  land();
  if (landing?.view === activeView) landing = null;
}
/** Filters and selections a deep link sets before its view loads. */
function applyRoute(view, params) {
  const has = [...params.keys()].length > 0;
  if (view === 'records') {
    if (params.get('entity')) {
      selectedEntity = params.get('entity');
      recordResult = undefined;
      browserFor('records').page = 1;
    }
    if (params.has('id')) {
      filter = params.get('id') ?? '';
      browserFor('records').page = 1;
    }
  }
  if (view === 'audit' && has) {
    for (const key of Object.keys(auditFilters)) auditFilters[key] = params.get(key) ?? '';
    browserFor('audit').page = 1;
  }
  if (view === 'access' && params.get('contact')) selectedPersona = params.get('contact');
  if (view === 'logs' && params.get('type')) logFilters.type = params.get('type');
  if (view === 'operations' && params.get('key')) {
    selectedOperation = params.get('key');
    openDisclosures.add('operation-edit');
    landing = { ...(landing?.view === view ? landing : { view }), panel: 'operation-edit' };
  }
  moduleFor(view)?.route?.(ctx, params);
  routeNotice = '';
  pendingRoute = has ? { view, params } : null;
}
/** Actions a deep link asks for once its data is loaded: open a record or portal item. */
async function followRoute() {
  const route = pendingRoute;
  if (!route || route.view !== activeView || !state) return;
  pendingRoute = null;
  if (route.view === 'records' && route.params.get('id')) {
    const id = route.params.get('id');
    const mapping = collection('mappings').find((item) => (item.logicalName || item.entity) === selectedEntity);
    const idColumn = mapping?.idColumn || `${selectedEntity}id`;
    const key = (value) =>
      String(value ?? '')
        .replace(/[{}]/g, '')
        .toLowerCase();
    const rows = state.summaryMode ? recordResult?.items || [] : state.data?.[selectedEntity] || [];
    const match = rows.find((row) => key(row[idColumn] ?? row.id) === key(id));
    if (match) await openEditor('records', String(match[idColumn] ?? match.id));
    else {
      routeNotice = `No ${selectedEntity} record has ID ${id}; the list shows records whose values contain it.`;
      render();
    }
  }
  if (route.view === 'portal') {
    const editorName = {
      settings: 'portal-settings',
      snippets: 'portal-snippets',
      roles: 'portal-roles',
      'access-rules': 'portal-access-rules',
    }[route.params.get('kind')];
    if (editorName && route.params.get('name')) await openEditor(editorName, route.params.get('name'));
  }
}
const auditFilters = {
  kind: '',
  provider: '',
  outcome: '',
  status: '',
  path: '',
  entity: '',
  search: '',
  correlationId: '',
};
const activeAuditFilters = () => Object.fromEntries(Object.entries(auditFilters).filter(([, value]) => value));
// ---- Live logs: /__sim/events?channels=logs while the Live logs view is open.
const logEntries = [],
  pausedLogs = [],
  logFilters = { type: '', search: '' };
let logSource = null,
  logPaused = false,
  logStatus = 'Disconnected',
  logFrame = 0;
function connectLogs() {
  if (logSource || typeof EventSource !== 'function') return;
  logStatus = 'Connecting…';
  logSource = new EventSource('/__sim/events?channels=logs');
  const add = (entry) => {
    if (logPaused) pausedLogs.push(entry);
    else logEntries.unshift(entry);
    if (logEntries.length > 500) logEntries.length = 500;
    if (pausedLogs.length > 500) pausedLogs.splice(0, pausedLogs.length - 500);
    scheduleLogs();
  };
  logSource.addEventListener('open', () => {
    logStatus = 'Streaming';
    scheduleLogs();
  });
  logSource.addEventListener('error', () => {
    logStatus = 'Reconnecting…';
    scheduleLogs();
  });
  logSource.addEventListener('log', (event) => {
    try {
      add(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  });
  logSource.addEventListener('reload', (event) =>
    add({
      type: 'reload',
      level: 'info',
      time: new Date().toISOString(),
      revision: Number(event.data),
    }),
  );
}
function disconnectLogs() {
  logSource?.close();
  logSource = null;
  logStatus = 'Disconnected';
}
async function loadAudit() {
  const generation = ++auditGeneration;
  auditLoading = true;
  auditError = '';
  render();
  const settings = browserFor('audit'),
    query = new URLSearchParams({
      page: String(settings.page),
      pageSize: String(settings.size),
      ...activeAuditFilters(),
    });
  try {
    const result = await request('/audit?' + query);
    if (generation === auditGeneration) auditResult = result;
  } catch (error) {
    if (generation === auditGeneration) auditError = error.message;
  } finally {
    if (generation === auditGeneration) {
      auditLoading = false;
      if (activeView === 'audit') render();
    }
  }
}
const config = () => state?.config || {};
const collection = (name) => config()[name] || state?.[name] || [];
const entities = () =>
  [
    ...new Set([
      ...Object.keys(state?.data || {}),
      ...Object.keys(state?.status?.tableCounts || {}),
      ...collection('mappings')
        .map((item) => item.logicalName || item.entity)
        .filter(Boolean),
    ]),
  ].sort();
const preferredEntity = (names) => {
  if (powerPages()) {
    const authored = new Set(
      collection('mappings')
        .filter((item) => !item.dataverseOnly && !item.modelDrivenSource)
        .map((item) => item.logicalName || item.entity),
    );
    const name = names.find((item) => authored.has(item));
    if (name) return name;
  }
  return names[0] || '';
};
// The page heading of a built-in view, followed by its guide. The heading is the sidebar label and the
// eyebrow its sidebar group, so the page names where a link landed; the guide intro is the one description, and
// `description` shows only for a view without a help entry.
const viewLabel = (id) => views.find((view) => view.id === id)?.label ?? id;
const heading = (description, action = '') =>
  `<div class="page-heading"><div><span class="eyebrow">${escape(groupOf(activeView).toUpperCase())}</span><h1 id="view-title" tabindex="-1">${escape(viewLabel(activeView))}</h1>${HELP[activeView] ? '' : `<p>${escape(description)}</p>`}</div>${action}</div>${viewGuide(activeView)}`;
const EFFECTS = {
  data: ['Changes local data', 'amber'],
  saves: ['Saves a definition only', ''],
  sources: ['Re-reads source files', ''],
  browser: ['This browser only', ''],
  read: ['Read only', 'neutral'],
};
/**
 * The ordered steps of a view: each links to the panel that does it (`#view?panel=key`), says what happens and
 * whether it changes local data (`effect`: data, browser or read).
 */
const steps = (key, items) =>
  `<ol class="sim-steps" data-steps="${escape(key)}" aria-label="Steps">${items.map(({ label, href, detail, effect }) => `<li>${href ? `<a href="${escape(href)}">${escape(label)}</a>` : `<strong>${escape(label)}</strong>`}${badge(...EFFECTS[effect])}<span class="step-detail">${escape(detail)}</span></li>`).join('')}</ol>`;
/** Actions side by side with what each does and whether it changes local data (`[[buttonHtml, detail, effect]]`). */
const actionList = (rows) =>
  `<div class="detail-list action-list">${rows.map(([button, detail, effect]) => `<div class="row"><div class="action-cell">${button}</div><div class="row-detail">${badge(...EFFECTS[effect])} ${escape(detail)}</div></div>`).join('')}</div>`;
const addButton = (name, label) =>
  `<button class="button primary" type="button" data-add="${name}" aria-label="${escape(label)}"${name === 'records' ? disabledRecordAction('create') : ''}>+ ${escape(label)}</button>`;
const empty = (title, description, action = '') =>
  `<div class="empty"><div class="empty-icon" aria-hidden="true">◇</div><h2>${escape(title)}</h2><p>${escape(description)}</p>${action}</div>`;
const rowActions = (name, id) =>
  `<button class="button small" type="button" data-edit="${name}" data-id="${escape(id)}"${name === 'records' ? disabledRecordAction('update') : ''}>Edit</button><button class="button small quiet" type="button" data-delete="${name}" data-id="${escape(id)}" aria-label="Delete ${escape(id)}"${name === 'records' ? disabledRecordAction('delete') : ''}>Delete</button>`;
const objectValue = (value) =>
  value === undefined || value === null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const previewValue = (value) => {
  const text = objectValue(value);
  return text.length > 140 ? text.slice(0, 137) + '…' : text;
};

// Keep feedback outside the rendered panel so lazy loading and chained saves do not
// erase it. Counts represent actual outstanding requests, including overlapping reads.
let pendingRequests = 0,
  pendingWrites = 0;
function beginRequest(options) {
  const writing = options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase());
  pendingRequests++;
  if (writing) pendingWrites++;
  const update = () => {
    const feedback = $('#activity-feedback');
    feedback.hidden = pendingRequests === 0;
    const message = pendingWrites ? 'Applying local changes…' : pendingRequests ? 'Loading workspace data…' : '';
    if (feedback.textContent !== message) feedback.textContent = message;
    $('#content').setAttribute('aria-busy', String(pendingRequests > 0));
  };
  update();
  return () => {
    pendingRequests--;
    if (writing) pendingWrites--;
    update();
  };
}
const pendingButtons = new WeakMap(),
  pendingScopes = new Map();
const operationScope = (node) => {
  const scope = node?.closest(
    'form, [data-operation-scope], #persona-session-panel, #persona-management-panel, #persona-scenarios-panel',
  );
  // Row actions and their nested role/password forms share one mutation boundary.
  return scope?.closest('[data-operation-scope]') ?? scope;
};
const intersectsPendingScope = (scope) =>
  Boolean(
    scope &&
    [...pendingScopes.values()].some((operation) => {
      const pending = operation.id ? document.getElementById(operation.id) : operation.currentScope;
      // A row and the editor opened for the same record carry the same named scope and share one lock.
      const named = scope.dataset?.operationScope;
      return (
        pending &&
        (scope.contains(pending) || pending.contains(scope) || (named && named === pending.dataset?.operationScope))
      );
    }),
  );
const controlIdentity = (node, index) =>
  node.id || JSON.stringify([node.localName, node.name, node.type, { ...node.dataset }, index]);
const controlValue = (node) => ({
  value: node.value,
  checked: node.checked,
  ...(node.localName === 'select'
    ? {
        selected: [...node.selectedOptions].map((option) => ({
          value: option.value,
          text: option.textContent,
          data: { ...option.dataset },
          index: option.index,
        })),
      }
    : {}),
});
const applyControlValue = (node, value) => {
  if (!value || node.type === 'file') return;
  if (node.localName === 'select' && Array.isArray(value.selected)) {
    const options = [...node.options],
      used = new Set();
    const sameData = (left, right) =>
      Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(([key, item]) => right[key] === item);
    const selected = value.selected
      .map((saved) => {
        const candidates = options.filter((option) => !used.has(option) && option.value === saved.value);
        const match =
          candidates.find((option) => sameData(saved.data, option.dataset) && option.textContent === saved.text) ??
          candidates.find((option) => sameData(saved.data, option.dataset)) ??
          candidates.find((option) => option.textContent === saved.text) ??
          candidates.find((option) => option.index === saved.index) ??
          candidates[0];
        if (match) used.add(match);
        return match;
      })
      .filter(Boolean);
    if (selected.length || value.selected.length === 0) {
      if (node.multiple) for (const option of options) option.selected = used.has(option);
      else node.selectedIndex = selected[0]?.index ?? -1;
    }
  } else if (typeof value.value === 'string') node.value = value.value;
  if (typeof value.checked === 'boolean') node.checked = value.checked;
};
function lockOperationScope(operation) {
  const scope = operation.id ? document.getElementById(operation.id) : operation.scope;
  if (!scope?.isConnected) return;
  if (operation.currentScope === scope) return;
  // A row and the editor opened for the same record carry the same named scope and lock together.
  const named = scope.dataset.operationScope;
  const linked = named
    ? [...document.querySelectorAll(`[data-operation-scope="${CSS.escape(named)}"]`)].filter((node) => node !== scope)
    : [];
  const controls = [scope, ...linked].flatMap((root) => [...root.querySelectorAll('input, textarea, select, button')]);
  operation.current = controls.map((node, index) => {
    const key = controlIdentity(node, index),
      previous = { node, disabled: node.disabled, value: controlValue(node), text: node.textContent };
    applyControlValue(node, operation.values.get(key));
    node.disabled = true;
    if (key === operation.buttonKey) {
      node.textContent = 'Working…';
      node.setAttribute('aria-busy', 'true');
    }
    return { ...previous, key };
  });
  operation.currentScope = scope;
  operation.linkedScopes = linked;
  for (const node of [scope, ...linked]) {
    node.dataset.pendingAction = 'true';
    node.setAttribute('aria-busy', 'true');
  }
}
function restorePendingScopes() {
  for (const operation of pendingScopes.values()) lockOperationScope(operation);
}
function setButtonPending(button, pending, failed = false) {
  if (!button) return true;
  if (pending) {
    if (pendingButtons.has(button)) return false;
    const scope = operationScope(button),
      controls = scope ? [...scope.querySelectorAll('input, textarea, select, button')] : [button];
    if (intersectsPendingScope(scope)) return false;
    const values = new Map(controls.map((node, index) => [controlIdentity(node, index), controlValue(node)]));
    const operation = {
      scope: scope ?? button,
      id: scope?.id,
      buttonKey: controlIdentity(button, controls.indexOf(button)),
      values,
      current: [],
      focused: document.activeElement,
    };
    pendingButtons.set(button, operation);
    if (operation.id) pendingScopes.set(operation.id, operation);
    if (scope) lockOperationScope(operation);
    else {
      operation.current = [{ node: button, disabled: button.disabled, text: button.textContent }];
      button.disabled = true;
      button.textContent = 'Working…';
      button.setAttribute('aria-busy', 'true');
    }
  } else {
    const operation = pendingButtons.get(button);
    if (!operation) return;
    for (const previous of operation.current) {
      const { node } = previous;
      if (!node.isConnected) continue;
      node.disabled = previous.disabled;
      applyControlValue(node, failed ? operation.values.get(previous.key) : previous.value);
      if (node.localName === 'button') {
        node.textContent = previous.text;
        node.removeAttribute('aria-busy');
      }
    }
    for (const scope of [operation.currentScope, ...(operation.linkedScopes ?? [])])
      if (scope) {
        delete scope.dataset.pendingAction;
        scope.removeAttribute('aria-busy');
      }
    if (operation.id) pendingScopes.delete(operation.id);
    pendingButtons.delete(button);
    if (document.activeElement === document.body) {
      const focus = operation.focused?.isConnected
        ? operation.focused
        : operation.current.find((item) => item.key === operation.buttonKey)?.node;
      if (focus?.isConnected && !focus.disabled) focus.focus({ preventScroll: true });
    }
  }
  return true;
}

document.addEventListener(
  'submit',
  (event) => {
    if (event.target.closest('[data-pending-action]') || intersectsPendingScope(operationScope(event.target))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);
document.addEventListener(
  'click',
  (event) => {
    if (event.target.closest('[data-pending-action]') || intersectsPendingScope(operationScope(event.target))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true,
);
document.addEventListener(
  'cancel',
  (event) => {
    if (event.target.matches('dialog') && event.target.querySelector('[data-pending-action]')) event.preventDefault();
  },
  true,
);

async function request(path, options = {}) {
  const finish = beginRequest(options);
  const deadline = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    const response = await fetch(`${API}${path}`, {
      ...options,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.method && options.method !== 'GET' && state?.csrf ? { 'X-Sim-CSRF': state.csrf } : {}),
        ...options.headers,
      },
      cache: 'no-store',
    });
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Simulator returned invalid JSON (${response.status}).`);
    }
    if (!response.ok) {
      const error = new Error(
        typeof result.error === 'string'
          ? result.error
          : result.error?.message || result.message || `Request failed (${response.status}).`,
      );
      error.details = result;
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (deadline.aborted)
      throw new Error(
        options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())
          ? 'The local operation timed out. Its result may be unknown; refresh the workspace and check before retrying.'
          : 'The local request timed out. Refresh the workspace to try again.',
        { cause: error },
      );
    throw error;
  } finally {
    finish();
  }
}

function notify(message, error = false) {
  clearTimeout(toastTimer);
  const el = $('#notification');
  el.setAttribute('role', error ? 'alert' : 'status');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
    },
    error ? 9000 : 4500,
  );
}

// This browser's own sign-in session: a cookie the Mirage sets on the browser that asks.
// It is separate from the default persona that the local sign-in page offers.
let browserSession = null,
  sessionPick = '';
async function loadSession() {
  try {
    const session = await request('/session');
    browserSession = {
      signedIn: Boolean(session.signedIn),
      contactId: session.contactId ?? null,
      name: session.name ?? null,
      roles: Array.isArray(session.roles) ? session.roles : [],
      roleSource: session.roleSource ?? 'memberships',
      accountId: session.accountId ?? null,
      identityProvider:
        session.identityProvider && typeof session.identityProvider === 'object' ? session.identityProvider : null,
    };
  } catch (error) {
    browserSession = { signedIn: false, roles: [], error: error.message };
  }
}
// External identity records (GET /session/identities: { table, identities, registrations }),
// for the access view; null when this Mirage does not report them.
let externalIdentities;
async function loadExternalIdentities() {
  try {
    const result = await request('/session/identities');
    externalIdentities = {
      table: typeof result?.table === 'string' ? result.table : null,
      identities: Array.isArray(result?.identities) ? result.identities : [],
    };
  } catch {
    externalIdentities = null;
  }
}
/** The provider the portal's sign-in uses (its default one), or null: the local sign-in page. */
function signInProvider() {
  const idp = browserSession?.identityProvider;
  if (!idp?.available) return null;
  const providers = Array.isArray(idp.providers) ? idp.providers : [];
  return providers.find((item) => item?.default) || providers[0] || null;
}
/** How the portal signs in, as label/value rows: the provider, its callback and the local identity provider. */
function signInRoute() {
  const idp = browserSession?.identityProvider;
  const provider = signInProvider();
  if (!provider) return [['Sign-in', `Local sign-in page${idp?.reason ? ` (${idp.reason})` : ''}`]];
  return [
    [
      'Identity provider',
      `${provider.caption || provider.name || provider.id}${provider.type ? ` (${provider.type})` : ''}`,
    ],
    ['Callback path', provider.callbackPath || 'Not reported'],
    [
      'Local identity provider',
      idp.origin
        ? `${idp.origin}${idp.port ? ` (port ${idp.port})` : ''}`
        : idp.port
          ? `Port ${idp.port}`
          : 'Not reported',
    ],
  ];
}
const returnHere = () => `/_sim/${location.hash || '#access'}`;
/**
 * The portal's own sign-in for this browser, as a person runs it: the identity provider's
 * external login with a login_hint (the local identity provider answers it without a click), or
 * the local persona sign-in page when the site has no external provider. A signed-in browser
 * signs out first, because an external login made while signed in links to that account. The
 * page navigates and comes back to this view; it never sets the session cookie itself.
 */
async function signInThroughPortal(contactId) {
  const provider = signInProvider();
  if (browserSession?.signedIn)
    await fetch('/Account/Login/LogOff?returnUrl=%2F', {
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
    });
  const response = await fetch('/_layout/tokenhtml', { credentials: 'same-origin', cache: 'no-store' });
  const html = response.ok ? await response.text() : '';
  const token = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector('input[name="__RequestVerificationToken"]')?.value;
  if (!token)
    throw new Error(`The portal returned no antiforgery token at /_layout/tokenhtml (HTTP ${response.status}).`);
  const form = document.createElement('form');
  form.method = 'post';
  form.action = provider
    ? `/Account/Login/ExternalLogin?returnUrl=${encodeURIComponent(returnHere())}`
    : `/SignIn?ReturnUrl=${encodeURIComponent(returnHere())}`;
  form.hidden = true;
  const fields = provider ? { provider: provider.id, login_hint: contactId } : { contactId };
  for (const [name, value] of Object.entries({ ...fields, __RequestVerificationToken: token })) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  HTMLFormElement.prototype.submit.call(form);
}
/** The portal's sign-out (through the provider's end-session); it comes back to this view. */
function signOutThroughPortal() {
  location.assign(`/Account/Login/LogOff?returnUrl=${encodeURIComponent(returnHere())}`);
}
/** The simulation override: explicit web roles for this browser's signed-in session; null clears it. */
async function setSessionRoles(roles) {
  await request('/session/roles', { method: 'POST', body: JSON.stringify({ roles }) });
  await loadSession();
  render();
}
/**
 * The simulation override: explicit web-role names for this browser's signed-in session instead
 * of the contact's memberships. It applies on top of a real sign-in and never signs in by itself.
 */
function sessionOverrideForm() {
  const session = browserSession || {};
  const override = session.roleSource === 'override';
  const disabled = session.signedIn ? '' : ' disabled';
  return `<section class="advanced-content"><div class="panel-heading"><h2>Simulation override</h2>${badge(override ? 'Override active' : 'No override', override ? 'amber' : '')}</div>${panelHelp('access.session-override', 'the simulation override')}${session.signedIn ? '' : '<div class="notice section-gap">Sign this browser in through the portal first.</div>'}<form id="session-override-form" class="form-grid"><div><label for="override-roles">Web roles for ${escape(session.signedIn ? session.name || session.contactId : "this browser's session")}</label><input id="override-roles" value="${escape(override ? (session.roles || []).join(', ') : '')}" placeholder="Authenticated Users, Administrators"${disabled}><p class="field-help">Separate role names with commas.</p></div><div class="toolbar"><button class="button primary" type="submit"${disabled}>Apply override</button>${override ? '<button class="button" type="button" data-action="session-override-clear">Clear override</button>' : ''}</div></form></section>`;
}
const sessionSummary = () =>
  !browserSession
    ? "Loading this browser's session"
    : browserSession.signedIn
      ? `Signed in as ${browserSession.name || browserSession.contactId}`
      : 'Anonymous: this browser is not signed in';
const contactLabel = (record) =>
  record ? record.fullname || [record.firstname, record.lastname].filter(Boolean).join(' ') || record.contactid : '';
function sessionPanel() {
  if (personaCatalogue?.enabled) return personaSessionPanel(personaCatalogue, browserSession, selectedPersonaKey);
  const session = browserSession || { signedIn: false, roles: [] };
  const contacts = contactList();
  const wanted = personaId(
    sessionPick || (session.signedIn ? session.contactId : '') || selectedPersona || contacts[0]?.contactid,
  );
  const chosen = findContact(wanted) || contacts[0];
  const signOut = session.signedIn
    ? '<button class="button" type="button" data-action="session-sign-out">Sign out</button>'
    : '';
  const provider = signInProvider();
  return `<section class="panel"><div class="panel-heading"><h2>This browser's session</h2>${session.roleSource === 'override' ? badge('Simulation override', 'amber') : ''}${badge(session.signedIn ? 'Signed in' : 'Anonymous', session.signedIn ? 'green' : '')}</div>${panelHelp('access.session', "this browser's session")}<p class="muted">Sign in runs ${provider ? "the exported identity provider's login, answered by the local identity provider," : 'the local sign-in page'} and comes back here.</p><div class="notice"><strong>${escape(sessionSummary())}</strong><br>${escape((session.roles || []).join(', ') || 'No roles')}${session.roleSource === 'override' ? ' (simulation override)' : ''}${session.accountId ? `<br>Account: ${escape(session.accountId)}` : ''}</div><div class="detail-list section-gap" id="sign-in-route">${signInRoute()
    .map(
      ([title, value]) =>
        `<div class="row"><span class="row-title">${escape(title)}</span><span class="row-detail source-path">${escape(value)}</span></div>`,
    )
    .join('')}</div>${session.error ? `<div class="notice warning section-gap">${escape(session.error)}</div>` : ''}${
    contacts.length
      ? `<div class="form-grid section-gap"><div>${contactChoice('session-contact', 'Persona for this browser', chosen?.contactid)}</div></div><div class="toolbar"><button class="button primary" type="button" data-action="session-sign-in">Sign in as ${escape(contactLabel(chosen))}</button>${signOut}</div>`
      : `<div class="notice section-gap">No local contacts to sign in as yet: create a persona below.</div>${signOut ? `<div class="toolbar">${signOut}</div>` : ''}`
  }</section>`;
}
async function refreshOnce() {
  try {
    state = await request('/state?summary=1');
    state.summaryMode = state.summaryMode === true || !state.data;
    if (powerPages()) await loadSession();
    else browserSession = undefined;
    if (!state.docs && !state.status?.docs && statusExtra === undefined)
      statusExtra = await request('/status').catch(() => null);
    await probeViews();
    if (!availableViews().some(({ id }) => id === activeView)) activeView = 'overview';
    personaCatalogue = undefined;
    recordResult = undefined;
    $('#connection-dot').className = 'status-dot ready';
    $('#connection-label').textContent = 'Simulator connected';
    render();
    await loadView();
    return true;
  } catch (error) {
    $('#connection-dot').className = 'status-dot error';
    $('#connection-label').textContent = 'Connection interrupted';
    if (!state)
      $('#content').innerHTML = empty(
        'Unable to load the workspace',
        error.message,
        '<button class="button primary" data-action="retry">Try again</button>',
      );
    notify(error.message, true);
    return false;
  }
}
let refreshInFlight,
  refreshAgain = false,
  refreshAnnounce = false;
function refresh({ announce = false } = {}) {
  refreshAgain = true;
  refreshAnnounce ||= announce;
  if (refreshInFlight) return refreshInFlight;
  $('#refresh').disabled = true;
  refreshInFlight = (async () => {
    let success;
    do {
      refreshAgain = false;
      success = await refreshOnce();
    } while (refreshAgain);
    if (success && refreshAnnounce) notify('Workspace refreshed.');
  })().finally(() => {
    refreshInFlight = undefined;
    refreshAnnounce = false;
    $('#refresh').disabled = false;
  });
  return refreshInFlight;
}

function overview() {
  if (!powerPages())
    return (
      heading(
        'Run solution-based apps and integrations against one local organization. Configure staff identities, application credentials and declared DATA persistence.',
      ) +
      simulationPanel() +
      `<section class="panel section-gap"><h2>Start working</h2>${panelHelp('overview.customize')}<div class="toolbar">${runtimeLinks().modelDriven ? `<a class="button primary" href="${escape(runtimeLinks().modelDriven)}">Open model-driven apps</a>` : ''}<button class="button" data-view="dataverse">Organization identity & API</button><button class="button" data-view="records">Manage data records</button><a class="button" href="/_setup/">Project setup</a></div><p class="muted">This runtime has no Power Pages rendering or portal visitor personas.</p></section>`
    );
  const rows = Object.values(
    state.status?.tableCounts ||
      Object.fromEntries(Object.entries(state.data || {}).map(([name, rows]) => [name, rows.length])),
  ).reduce((sum, count) => sum + Number(count || 0), 0);
  const status = state.status || {};
  const diagnostics = state.diagnostics || status.diagnostics || [];
  const pages = status.pages || state.pages || [];
  const pageCount = Array.isArray(pages) ? pages.length : pages;
  // Each card opens the view that manages what it counts.
  const metrics = [
    ['records', 'Data records', rows, `in ${entities().length} tables`, '▤'],
    ['evidence', 'Portal pages', pageCount || status.pageCount || 0, 'found in the portal export', '◇'],
    [
      'plugins',
      'Plugin rules',
      collection('plugins').filter((item) => item.enabled !== false).length,
      'switched on',
      '⌘',
    ],
    ['evidence', 'Diagnostics', diagnostics.length, 'findings to review', '◎'],
  ];
  const row = (title, detail, tip, extra = '') =>
    `<div class="row"><div><div class="row-title">${escape(title)}${tip ? kit.info({ label: `About ${title}`, text: tip }) : ''}</div><div class="row-detail">${detail}</div></div>${extra}</div>`;
  const go = (view, panel) =>
    `<a class="button small" href="#${view}${panel ? `?panel=${panel}` : ''}">${escape(viewLabel(view))} →</a>`;
  const styles =
    status.platformStyles?.mode === 'captured'
      ? `Captured ${escape(status.platformStyles.capturedAt)} from ${escape(status.platformStyles.origin)}`
      : 'Not captured: Mirage uses its own basic form styles';
  return (
    heading('Render portal sources and test configured data and backend rules.') +
    simulationPanel() +
    `<div class="cards">${metrics.map(([view, label, value, detail, icon]) => `<a class="metric" href="#${view}"><span class="metric-icon" aria-hidden="true">${icon}</span><div class="metric-label">${label}</div><div class="metric-value">${escape(value)}</div><div class="metric-detail">${escape(detail)}</div></a>`).join('')}</div>${panelHelp('overview.metrics', 'these counts')}` +
    `<div class="grid-two"><section class="panel tall-panel" data-panel="workspace"><div class="panel-heading"><h2>Workspace configuration</h2>${badge(config().mode === 'live' ? 'Live data' : 'Local data', config().mode === 'live' ? 'amber' : 'green')}</div>${panelHelp('overview.workspace', 'the workspace configuration')}
      ${row('Page rendering', config().pageMode === 'live' ? 'Pages from the connected environment' : 'Liquid and portal metadata from local sources', 'Who renders portal pages: this runtime from your local sources, or the connected online environment.', badge(config().pageMode === 'live' ? 'Live' : 'Local'))}
      ${row('Data source', escape(config().mode === 'live' ? config().live?.origin || 'Live environment selected' : 'Local records and plugin rules of this runtime'), 'Where Web API and Liquid data reads go. Change it under Live connection.', go('connection', 'routing'))}
      ${row('This browser', `${escape(sessionSummary())} · ${escape((browserSession?.roles || []).join(', ') || 'No roles')}`, 'The portal sign-in of this browser only. Other browsers keep their own.', go('access', 'session'))}
      ${row(
        'Sign-in route',
        escape(
          signInRoute()
            .map(([title, value]) => `${title}: ${value}`)
            .join(' · '),
        ),
        "How the portal's Sign in button works locally: the exported identity provider answered by a local stand-in, or the local sign-in page.",
      )}
      ${row('Platform stylesheets', `${styles}${status.platformStyles?.missingHeadStylesheets?.length ? ` · Missing: ${escape(status.platformStyles.missingHeadStylesheets.join(', '))}` : ''}`, 'The Power Pages platform CSS. Capture it from a reference portal with Capture page shell under Live connection; until then pages use local basic form styles.')}
      ${row('Sign-in page default', escape(config().identity?.name || config().identity?.contactId || config().identity?.id || 'No default person'), 'The test person the local sign-in page offers first, and the identity of scripts that send no browser cookie.')}
      ${row('Portal source folder', `<span class="source-path">${escape(status.repo || status.source || status.sourceDir || state.repo || 'See simulator launch configuration')}</span>`)}
      ${row('Runtime', `Revision ${escape(status.revision ?? 'not reported')} · source ${escape(String(status.sourceFingerprint ?? '').slice(0, 12) || 'not reported')}${config().activeScenario ? ` · scenario ${escape(config().activeScenario.name || config().activeScenario.id)}` : ''}`, 'The revision goes up each time saved sources reload. The source fingerprint identifies the loaded sources, not a deployed commit.', go('runtime'))}
    </section><section class="panel" data-panel="next"><div class="panel-heading"><h2>Where to go next</h2></div>${panelHelp('overview.customize', 'where to go next')}
      ${[
        ['records', 'Add or change records', 'Create the records your pages, lists and Web API calls read.'],
        ['access', 'Sign in as a test person', 'See the portal as a contact with its web roles.'],
        ['plugins', 'Simulate backend rules', 'Validate saves and fill fields automatically, or apply a data preset.'],
        [
          'scenarios',
          'Switch whole setups',
          'Save data, person and permission choices as a scenario and apply it in one step.',
        ],
        ['evidence', 'Check what went wrong', 'Review diagnostics and rendering evidence.'],
      ]
        .filter(([view]) => availableViews().some(({ id }) => id === view))
        .map(
          ([view, title, desc]) =>
            `<div class="row"><div><div class="row-title">${title}</div><div class="row-detail">${desc}</div></div>${go(view)}</div>`,
        )
        .join('')}
    </section></div>`
  );
}

function records() {
  const names = entities();
  if (!names.includes(selectedEntity)) selectedEntity = preferredEntity(names);
  const all = state.summaryMode ? recordResult?.items || [] : state.data?.[selectedEntity] || [];
  const rows = all.filter((item) => JSON.stringify(item).toLowerCase().includes(filter.toLowerCase()));
  const page = state.summaryMode
    ? {
        items: all,
        total: recordResult?.total || 0,
        pages: recordResult?.pageCount || 1,
      }
    : sliceRows('records', rows);
  const mapping = collection('mappings').find((item) => (item.logicalName || item.entity) === selectedEntity);
  const idColumn = mapping?.idColumn || `${selectedEntity}id`;
  const columns = [...new Set([idColumn, ...all.flatMap((item) => Object.keys(item))])].slice(0, 6);
  return (
    heading(
      'Manage mock records used by local data requests and form/list schemas.',
      selectedEntity ? addButton('records', 'Create record') : '',
    ) +
    (config().mode === 'live'
      ? '<div class="notice section-gap">This editor changes local records. Selecting live data does not turn record administration into live environment administration.</div>'
      : '') +
    (selectedEntity && recordAccess().create === false && recordAccess().update === false
      ? `<div class="notice section-gap">${escape(selectedEntity)} is read-only here: ${escape(recordAccess().reason ?? 'no pack DATA file is declared for this table.')} Create, Edit and Delete are switched off.</div>`
      : '') +
    panelHelp('records.table', 'the record list') +
    `<div class="toolbar"><label class="nowrap" for="entity-select">Entity</label>${filterBox('entity-select', names.length, 'Filter tables')}<select id="entity-select" aria-describedby="entity-select-help">${names.map((name) => `<option ${name === selectedEntity ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select><input id="record-search" type="search" placeholder="Search record values…" aria-label="Search record values" aria-describedby="record-search-help" value="${escape(filter)}"><span class="record-count">${page.total} matching records</span></div><details class="field-hints"><summary>What these fields do</summary><p>${controlHelp('entity-select', 'records.table', 'entity')} ${controlHelp('record-search', 'records.table', 'search')}</p></details>${recordLoading ? '<p role="status" class="muted">Loading records…</p>' : ''}${recordError ? `<div class="notice warning">${escape(recordError)}</div>` : ''}${routeNotice ? `<div class="notice warning">${escape(routeNotice)}</div>` : ''}` +
    (!selectedEntity
      ? empty(
          'Map your first entity',
          'Entity mappings connect Dataverse logical names, entity sets, and primary ID fields.',
          '<button class="button primary" data-view="mappings">Configure entities</button>',
        )
      : !rows.length
        ? empty(
            all.length ? 'No matching records' : 'This entity is ready for data',
            all.length
              ? 'Try a different search.'
              : `Create a ${selectedEntity} record or apply a preset to populate this entity.`,
            all.length ? '' : addButton('records', 'Create record'),
          )
        : tableTools('records', page.total, page.pages, { search: false }) +
          `<div class="table-wrap"><table data-table="records"><thead><tr>${columns.map((column) => `<th>${escape(column)}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${page.items
            .map((record, _index) => {
              const id = record[idColumn] ?? record.id;
              return `<tr>${columns.map((column) => `<td title="${escape(previewValue(record[column]))}">${escape(previewValue(record[column]))}</td>`).join('')}<td class="actions">${id === undefined ? `<span class="muted">Missing ${escape(idColumn)}</span>` : rowActions('records', id)}</td></tr>`;
            })
            .join('')}</tbody></table></div>`)
  );
}

function pluginOperation(item, index) {
  const value = item.configuration ?? { mode: item.mode, status: 200, body: {} };
  const unsupportedBehavior = !item.enabled
    ? 'This registration is inactive in the export and does not execute.'
    : value.mode === 'disabled'
      ? 'Disabled mode does not execute this registration.'
      : value.mode === 'mock'
        ? 'Configured mock status controls local acceptance; original logic is not executed.'
        : value.mode === 'placeholder'
          ? 'Placeholder mode skips this registration with a diagnostic.'
          : 'The selected execution mode rejects this unsupported registration with LocalPluginUnsupported.';
  const disabled = item.configurable ? '' : ' disabled';
  const modes = [
    ['placeholder', 'Placeholder (skip with diagnostic)'],
    ['disabled', 'Disabled locally'],
    ['mock', 'Configured target changes or rejection'],
    ['handler', 'Trusted project JavaScript model'],
    ['clr', 'Execute trusted original CLR assembly'],
  ];
  const message = String(item.message ?? '').toLowerCase(),
    pre = [10, 20].includes(item.stage);
  const mockHelp =
    message === 'retrievemultiple'
      ? item.stage === 20
        ? 'Use {"query":{...}} with a typed QueryExpression, QueryByAttribute or FetchExpression for this source table.'
        : 'Use {"collection":{"$type":"EntityCollection","entities":[],"moreRecords":false,"totalRecordCount":-1,"pagingCookie":null}} to replace the read result.'
      : message === 'retrieve' && item.stage === 40
        ? 'Use {"entityResult":{...}} with a typed Entity retaining this table and record identity.'
        : ['createmultiple', 'updatemultiple'].includes(message) && pre
          ? 'Use {"targets":[...]} with typed Entity values retaining the submitted table, count and existing identities.'
          : ['create', 'update'].includes(message) && pre
            ? 'Use {"target":{"column":"value"}} to change submitted fields.'
            : 'This stage supports an explicit error; it cannot persist target changes.';
  return `<section class="panel section-gap"><div class="panel-heading"><h2>${escape(item.name)}</h2>${badge('plugin-step')}${badge(item.mode)}</div>
    <p class="muted">${escape(item.entity ?? 'Unresolved table')} ${escape(item.message ?? 'Unknown message')} · ${escape(item.stageName)} · rank ${escape(item.rank ?? 'unknown')}${item.filteringAttributes.length ? ` · input attributes: ${escape(item.filteringAttributes.join(', '))}` : ''}</p>
    <p class="field-help">${escape(item.typeName ?? 'Unresolved type')} · ${escape(item.assemblyName ?? 'Unresolved assembly')}</p>
    ${item.unsupported ? `<p class="notice">${escape(item.unsupported)} ${escape(unsupportedBehavior)}</p>` : !item.enabled ? '<p class="notice">This registration is disabled in the export.</p>' : ''}
    ${[item.sourceFile, item.typeSourceFile, item.assemblySourceFile]
      .filter(Boolean)
      .map((file) => `<p class="field-help">Metadata: ${escape(file)}</p>`)
      .join(
        '',
      )}${item.codeSourceFile ? `<p class="field-help">Mapped C# source: ${escape(item.codeSourceFile)}</p>` : item.codeSourceDiagnostic ? `<p class="notice">${escape(item.codeSourceDiagnostic)}</p>` : ''}
    <form id="operation-form-${index}" data-operation-key="${escape(item.key)}" class="form-grid">
      <div><label for="operation-mode-${index}">Local behavior</label><select id="operation-mode-${index}" name="mode"${disabled}>${modes.map(([mode, label]) => `<option value="${mode}"${value.mode === mode ? ' selected' : ''}${(mode === 'handler' && !item.registered) || (mode === 'clr' && !item.clrAvailable) ? ' disabled' : ''}>${label}</option>`).join('')}</select></div>
      <div><label for="operation-status-${index}">Mock result status</label><input id="operation-status-${index}" name="status" type="number" min="200" max="599" value="${escape(value.status ?? 200)}"${disabled}><p class="field-help">400 or above rejects the write and rolls back the local transaction.</p></div>
      <div><label for="operation-body-${index}">Mock result (JSON)</label><textarea id="operation-body-${index}" name="body" class="code-editor" rows="6" spellcheck="false"${disabled}>${escape(json(value.body ?? {}))}</textarea><p class="field-help">${escape(mockHelp)} Use {"error":{"message":"Rejected"}} to reject explicitly.</p></div>
      <div class="toolbar"><button class="button primary" type="submit"${disabled}>Save local behavior</button>${item.configuration ? `<button class="button" type="button" data-operation-reset="${escape(item.key)}">Use source default</button>` : ''}</div>
    </form>${item.clrProvenance ? lazyJson('Original CLR assembly and SDK provenance', item.clrProvenance) : ''}<p class="field-help">CLR mode executes the explicitly trusted original DLL in a separate local process. JavaScript handlers and mocks remain models. Top-level PreValidation SDK writes commit independently; PreOperation/PostOperation and nested PreValidation join their caller transaction. Read observers cannot write through the SDK bridge; backend calls require a separate project security profile. Traces, skips and failures appear in Diagnostics. This is trusted code execution, not a security sandbox.</p></section>`;
}

// One operation's edit panel (cloud flows, server logic, workflows); plug-in steps use `pluginOperation`.
function operationPanel(item, index) {
  const value = item.configuration ?? { mode: item.mode, status: 200, body: {} };
  const disabled = !item.configurable ? ' disabled' : '';
  return `<section class="panel section-gap"><div class="panel-heading"><h2>${escape(item.name)}</h2>${badge(item.kind)}${badge(item.mode)}</div><p class="muted">${item.path ? escape(item.path) : item.contract?.trigger?.kind === 'dataverse' ? 'Automatic imported Dataverse row trigger: ' + escape(item.contract.trigger.table ?? 'unresolved table') + '. No portal consumer is required.' : 'No exported portal consumer. Add a consumer with its web-role grants before invoking this request workflow.'}</p>${item.sourceFile ? `<p class="field-help">Source: ${escape(item.sourceFile)}</p>` : '<p class="field-help">No executable definition in the selected sources.</p>'}${item.contract ? lazyJson('Input schema and exported actions', item.contract) : ''}<form id="operation-form-${index}" data-operation-key="${escape(item.key)}" class="form-grid"><div><label for="operation-mode-${index}">Local behavior</label><select id="operation-mode-${index}" name="mode"${disabled}>${[
    ['placeholder', 'Placeholder (501)'],
    ['disabled', 'Disabled locally'],
    ['mock', 'Configured response'],
    ['exported', 'Execute exported definition'],
    ['handler', 'Trusted project handler'],
  ]
    .map(
      ([mode, label]) =>
        `<option value="${mode}"${value.mode === mode ? ' selected' : ''}${(mode === 'handler' && !item.registered) || (mode === 'exported' && !item.definitionAvailable) ? ' disabled' : ''}>${label}</option>`,
    )
    .join(
      '',
    )}</select></div><div><label for="operation-status-${index}">Mock response status</label><input id="operation-status-${index}" name="status" type="number" min="200" max="599" value="${escape(value.status ?? 200)}"${disabled}><p class="field-help">Server logic uses its native success envelope; status 400 or above simulates failure.</p></div><div><label for="operation-body-${index}">Mock response body (JSON)</label><textarea id="operation-body-${index}" name="body" class="code-editor" rows="6" spellcheck="false"${disabled}>${escape(json(Object.hasOwn(value, 'body') ? value.body : {}))}</textarea></div>${item.kind === 'cloud-flow' ? `<div><label class="checkbox-label"><input type="checkbox" name="localActivation"${value.activation === 'local-enabled' ? ' checked' : ''}${disabled}> Explicitly activate this source locally</label><p class="field-help">Draft or unknown exported activation stays unchanged. This choice only enables the local trigger and is recorded in traces.</p></div><div><label for="operation-steps-${index}">Per-action choices (JSON)</label><textarea id="operation-steps-${index}" name="steps" class="code-editor" rows="6"${disabled}>${escape(json(value.steps ?? {}))}</textarea><p class="field-help">Use exact action keys from the contract: {"Action":{"mode":"mock","outputs":{"body":{}}}} or mode disabled. Unknown actions are rejected; external calls do not execute implicitly.</p></div>` : ''}<div class="toolbar"><button class="button primary" type="submit"${disabled}>Save local behavior</button>${item.configuration ? `<button class="button" type="button" data-operation-reset="${escape(item.key)}">Use source default</button>` : ''}</div></form><p class="field-help">Exported web-role grants still apply. A mock response does not test the flow's business logic or connector behavior.</p></section>`;
}
let selectedOperation = '',
  standaloneOperations = [];
// Power Pages hosts list operations in /state; standalone hosts answer GET /operations and take overrides
// through PATCH /config { operations } (the whole override map).
const operationItems = () => (powerPages() ? (config().operations ?? []) : standaloneOperations);
async function loadOperations() {
  if (!powerPages()) standaloneOperations = (await request('/operations')).items ?? [];
}
async function saveOperation(key, value) {
  if (powerPages()) {
    await request(
      `/operations/${encodeURIComponent(key)}`,
      value === null ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify(value) },
    );
    return;
  }
  const overrides = Object.fromEntries(
    standaloneOperations
      .filter((item) => item.configuration && item.key !== key)
      .map((item) => [item.key, item.configuration]),
  );
  if (value !== null) overrides[key] = value;
  await request('/config', { method: 'PATCH', body: JSON.stringify({ operations: overrides }) });
  await loadOperations();
}
function operations() {
  const items = operationItems();
  const position = new Map(items.map((item, index) => [item.key, index]));
  const selected = items.find((item) => item.key === selectedOperation);
  return (
    heading(
      'Server logic, flows and plugin registrations discovered from the selected portal and solution exports. Local choices stay in simulator state.',
    ) +
    legend('operations', 'Local behaviour modes') +
    `<section class="panel section-gap" data-panel="list"><div class="panel-heading"><h2>Operations</h2>${badge(`${items.length} discovered`)}</div>${panelHelp('operations.list', 'the operations list')}${pagedTable(
      'operations',
      items,
      {
        caption: 'Backend operations',
        emptyText:
          'No exported operations. Include server logic, cloud-flow consumers, solution Workflows or plugin registrations in the selected sources.',
        text: (item) =>
          [item.name, item.kind, item.mode, item.configuration?.mode, item.path, item.entity, item.message]
            .filter(Boolean)
            .join(' '),
        rowAttrs: (item) => ({
          'data-operation-row': item.key,
          class: item.key === selectedOperation ? 'is-selected' : undefined,
        }),
        columns: [
          {
            label: 'Operation',
            render: (item) =>
              `<strong>${escape(item.name)}</strong><div class="row-detail">${escape(item.path ?? [item.entity, item.message].filter(Boolean).join(' ') ?? '')}</div>`,
          },
          {
            label: 'Kind',
            info: 'server-logic: exported server logic under /_api/serverlogics. cloud-flow: a Power Automate flow. workflow: a classic Solution workflow. plugin-step: a registered Dataverse plug-in step.',
            render: (item) => badge(item.kind),
          },
          {
            label: 'Local behaviour',
            info: 'How this runtime answers the operation; Local behaviour modes above explains each value. Local override means you changed it here; Edit, then Use source default removes it.',
            render: (item) =>
              `${badge(item.configuration?.mode ?? item.mode)}${item.configuration ? ` ${badge('Local override', 'amber')}` : ''}`,
          },
          {
            label: 'Actions',
            render: (item) =>
              `<button class="button small" type="button" data-operation-select="${escape(item.key)}" aria-label="Edit ${escape(item.name)}">Edit</button>`,
          },
        ],
      },
    )}</section>` +
    (selected
      ? disclosure('operation-edit', `Edit ${selected.name}`, () =>
          (selected.kind === 'plugin-step' ? pluginOperation : operationPanel)(selected, position.get(selected.key)),
        )
      : '')
  );
}

const definitions = {
  mappings: {
    title: 'Entity mappings',
    description: 'Connect logical names to Web API entity sets, primary IDs, and relationships.',
    label: 'Add mapping',
    help: 'Use the same logical names and ID columns as your exported portal. The mapping ID equals its logical name. Relationships may be added to resolve linked queries.',
    sample: () => ({
      logicalName: 'account',
      entitySet: 'accounts',
      idColumn: 'accountid',
      relationships: {},
    }),
    empty:
      'Add a mapping for each table your pages, lists or Web API calls use that the imported metadata does not already map.',
    columns: [
      ['Table', 'logicalName', null, 'The table logical name from your export, for example account.'],
      [
        'Web API name',
        'entitySet',
        null,
        'The entity set name the Web API uses in /_api/<name>, usually the plural, for example accounts.',
      ],
      ['Primary ID column', 'idColumn', null, "The column that holds each record's unique ID, for example accountid."],
    ],
  },
  endpoints: {
    title: 'Endpoints',
    description: 'Define custom responses or route individual requests to the connected environment.',
    label: 'Add endpoint',
    help: 'Match a request path and HTTP method. Local endpoints return the configured status and body; live endpoints use the connected environment.',
    sample: () => ({
      id: crypto.randomUUID(),
      path: '/api/example',
      method: 'GET',
      mode: 'local',
      status: 200,
      body: { value: [] },
    }),
    empty:
      'Add an endpoint to answer one request path and method with your own status and body (local), or to send it to the connected environment (live).',
    columns: [
      ['Path', 'path'],
      ['Method', 'method'],
      [
        'Answered by',
        'mode',
        null,
        'local: this runtime answers with the configured status and body. live: the request goes to the connected environment.',
      ],
      ['Status', 'status'],
    ],
  },
  plugins: {
    title: 'Plugins & presets',
    description: 'Simulate backend validations, computed fields, and repeatable data scenarios.',
    label: 'Add plugin',
    help: 'Plugin rules run on the configured operations. Validate inputs and set or default fields using declarative expressions.',
    sample: () => ({
      id: crypto.randomUUID(),
      name: 'Require account name',
      entity: 'account',
      enabled: true,
      operations: ['create', 'update'],
      validate: [{ field: 'name', required: true, message: 'Account name is required.' }],
      defaults: {},
      set: {},
      secondary: [],
    }),
    empty:
      "Add a rule to require fields or fill values when a table's records are created or updated through this runtime.",
    columns: [
      ['Rule', 'name'],
      ['Table', 'entity'],
      ['Runs on', 'operations', null, 'The record operations that trigger the rule: create, update or delete.'],
      ['Switched on', 'enabled', (item) => (item.enabled === false ? 'No' : 'Yes')],
    ],
  },
  permissions: {
    title: 'Table permissions',
    description: 'Define which roles can read or mutate each simulated table.',
    label: 'Add permission',
    help: 'Assign operations and roles to a table. Contact and account scopes use the configured identity and optional relationship field.',
    sample: () => ({
      id: crypto.randomUUID(),
      entity: 'account',
      operations: ['read'],
      roles: ['Authenticated Users'],
      scope: 'global',
    }),
    columns: [
      ['Table', 'entity'],
      [
        'Operations',
        'operations',
        null,
        "What the roles may do with the table's records: read, create, update, delete, append or appendTo.",
      ],
      ['Web roles', 'roles'],
      [
        'Scope',
        'scope',
        null,
        "Which records the permission covers: global (all), contact or account (the person's own or their account's), parent or self.",
      ],
    ],
  },
  presets: {
    title: 'Simulation presets',
    description: 'Save data and configuration scenarios and apply them to the workspace.',
    label: 'Add preset',
    help: 'A preset can seed tables and configure mappings, permissions, plugins, and settings for a repeatable scenario. Applying a preset changes simulator state.',
    sample: () => ({
      id: crypto.randomUUID(),
      name: 'Example account',
      tables: {
        account: [{ accountid: crypto.randomUUID(), name: 'Contoso local' }],
      },
      mappings: { account: { entitySet: 'accounts', idColumn: 'accountid' } },
    }),
    columns: [
      ['Preset', 'name'],
      ['What it does', 'description'],
    ],
  },
  scenarios: {
    title: 'Scenarios',
    description: 'Combine a preset, a persona and permission settings, then apply them in one step.',
    label: 'Add scenario',
    help: 'A scenario applies its optional preset first, then its persona and permission settings, in one local state change. persona is null for an anonymous visitor or {"contactId": "..."} for a local contact; permissionMode is enforce or permissive; permissionSource is configured, exported or combined. Omitted parts keep the current setup.',
    sample: () => ({
      id: 'example-scenario',
      name: 'Example scenario',
      description: '',
      preset: state?.status?.availablePresets?.[0]?.id ?? null,
      persona: null,
      permissionMode: 'enforce',
    }),
    columns: [
      ['Scenario', 'name'],
      ['Data preset', 'preset', (item) => item.preset || 'Keep current data'],
      [
        'Persona',
        'persona',
        (item) =>
          item.persona === undefined
            ? 'Keep current persona'
            : item.persona === null
              ? 'Anonymous visitor'
              : item.persona.contactId,
      ],
      [
        'Permissions',
        'permissionMode',
        (item) => item.permissionMode || 'Keep current',
        'enforce applies table permissions as the portal does; permissive lets every local request through.',
      ],
    ],
  },
};

function collectionTable(name) {
  const def = definitions[name];
  const items = collection(name);
  const page = sliceRows(name, items);
  if (!items.length)
    return empty(`No ${def.title.toLowerCase()} yet`, def.empty ?? def.description, addButton(name, def.label));
  return (
    tableTools(name, page.total, page.pages) +
    `<div class="table-wrap"><table data-table="${escape(name)}"><thead><tr>${def.columns.map(([label, , , tip]) => `<th>${escape(label)}${tip ? kit.info({ label: `About ${label}`, text: tip }) : ''}</th>`).join('')}<th>Actions</th></tr></thead><tbody>${page.items
      .map(
        (item) =>
          `<tr>${def.columns
            .map(([_label, field, format], index) => {
              const value = format
                ? format(item)
                : (item[field] ?? (field === 'name' ? item.id : field === 'enabled' ? true : '—'));
              return `<td ${index === 0 ? 'class="item-title"' : ''}>${field === 'mode' ? badge(value, value === 'live' ? 'amber' : 'green') : escape(previewValue(Array.isArray(value) ? value.join(', ') : value))}</td>`;
            })
            .join(
              '',
            )}<td class="actions">${name === 'presets' ? `<button class="button small" data-apply="${escape(item.id)}">Apply</button> ` : name === 'scenarios' ? `<button class="button small" data-apply-scenario="${escape(item.id)}">Apply</button> ` : ''}${rowActions(name, item.id)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
  );
}

function configurationView(name) {
  const def = definitions[name];
  return (
    heading(def.description, addButton(name, def.label)) +
    `<section class="section-gap" data-panel="${name === 'plugins' ? 'rules' : 'table'}">${name === 'plugins' ? `<div class="panel-heading"><h2>Plugin rules</h2></div>` : ''}${panelHelp(`${name}.${name === 'plugins' ? 'plugins' : 'table'}`, def.title)}${collectionTable(name)}</section>` +
    (name === 'plugins'
      ? `<section class="section-gap" data-panel="presets"><div class="panel-heading"><div><h2>Simulation presets</h2></div>${addButton('presets', 'Add preset')}</div>${panelHelp('plugins.presets', 'simulation presets')}${collectionTable('presets')}</section>${presetPicker()}`
      : '') +
    (name === 'mappings'
      ? solutionMetadataPanel() +
        `<section class="panel section-gap"><div class="panel-heading"><div><h2>Form & view schema overrides</h2><p class="muted">Imported solution schemas apply automatically. Define overrides for unresolved or custom components.</p></div><button class="button" data-add="componentSchemas">Edit schemas</button></div>${panelHelp('mappings.schema-overrides')}${lazyJson('Inspect schema overrides', config().componentSchemas || {})}</section>`
      : '')
  );
}

function solutionMetadataPanel() {
  const metadata = state.status?.solutionMetadata;
  const counts =
    metadata?.counts ||
    (metadata
      ? {
          ...metadata.resolved,
          ...metadata.data,
          solutionForms: metadata.forms ?? 'Not reported',
          solutionViews: metadata.views ?? 'Not reported',
          unresolved:
            typeof metadata.unresolved === 'number' ? metadata.unresolved : (metadata.unresolved || []).length,
        }
      : {});
  const sources = metadata?.sources || metadata?.roots || [];
  const unresolved = metadata?.unresolved || metadata?.diagnostics || [];
  const hasSources = Array.isArray(sources) && sources.length > 0;
  return `<section class="panel section-gap"><div class="panel-heading"><h2>Imported solution metadata</h2>${badge(metadata ? (hasSources ? 'Sources reported' : 'No solution sources') : 'No import status', 'amber')}</div>${panelHelp('mappings.solution-metadata', 'imported solution metadata')}${
    metadata
      ? `${kit.section({
          key: 'solution-metadata-counts',
          title: 'Imported counts',
          summary: `${Object.keys(counts).length} kinds`,
          body: `<div class="detail-list">${Object.entries(counts)
            .map(
              ([key, value]) =>
                `<div class="row"><span class="row-title">${escape(key)}</span><span class="row-detail">${escape(objectValue(value))}</span></div>`,
            )
            .join('')}</div>`,
        })}${lazyJson('Metadata sources', sources)}${Array.isArray(unresolved) && unresolved.length ? `<h3 class="section-gap">Unresolved metadata</h3>${diagnosticGroups(unresolved, 'unresolved')}` : ''}${lazyJson('Full import status', metadata)}`
      : '<p class="muted">The server has not reported an import summary. Inspect the configured solution roots and runtime diagnostics.</p>'
  }</section>`;
}

function presetPicker() {
  const presets = state.status?.availablePresets || collection('presets');
  if (!presets.length) return '';
  return kit.section({
    key: 'preset-picker',
    title: 'Apply a preset',
    summary: `${presets.length} presets · changes local data`,
    help: panelHelp('plugins.apply', 'applying a preset'),
    body: `<div class="toolbar"><label for="available-preset">Available preset</label>${filterBox('available-preset', presets.length, 'Filter presets')}<select id="available-preset" aria-describedby="available-preset-help">${presets.map((preset) => `<option value="${escape(preset.id)}">${escape(preset.name || preset.id)}${(state.diagnostics ?? []).some((d) => d.preset === preset.id && d.code?.startsWith('PACK_CONFIGURATION_PRESET_LINK')) ? ' · ⚠ invalid configuration link' : ''}${preset.configurationPreset ? ` · configuration: ${escape(preset.configurationPreset)}` : ''}</option>`).join('')}</select><label><input type="checkbox" id="preset-apply-configuration" aria-describedby="preset-apply-configuration-help"> Also apply the data preset’s configuration preset (if provided)</label><button class="button" data-apply-selected>Apply selected preset</button></div><details class="field-hints"><summary>What these fields do</summary><p>${controlHelp('available-preset', 'plugins.apply', 'preset')} ${controlHelp('preset-apply-configuration', 'plugins.apply', 'configuration')}</p></details>`,
  });
}

let selectedPersona = null;
const personaId = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
function personaPanel() {
  const model = state.status?.permissionModel || {};
  const contacts = contactList();
  const identity = state.status?.effectiveIdentity || config().identity || {};
  const desired = personaId(selectedPersona || identity.contactId || identity.id);
  const chosen = findContact(desired) ? desired : personaId(contacts[0]?.contactid);
  const contact = findContact(chosen);
  const assignments = model.memberships || config().contactRoles || [];
  const assigned = new Set(assignments.filter((row) => row.contactId === chosen).map((row) => row.roleId));
  const roles = model.webRoles || state.status?.webRoles || [];
  return `<section class="panel section-gap" data-panel="personas"><div class="panel-heading"><h2>Contact personas</h2>${badge(identity.roleSource === 'memberships' ? 'Contact memberships' : 'Role override', identity.roleSource === 'memberships' ? 'green' : 'amber')}</div>${panelHelp('access.personas', 'contact personas')}${
    contacts.length
      ? `<form id="persona-form" class="form-grid"><div>${personaCatalogue?.enabled ? `<label>Local contact</label><input type="hidden" id="persona-contact" value="${escape(chosen)}"><strong>${escape(contactLabel(contact))}</strong> <button type="button" class="button" data-persona-contact-chooser data-contact-id="${escape(chosen)}">Choose persona</button>` : contactChoice('persona-contact', 'Local contact', contact?.contactid ?? chosen)}<p class="field-help">Selected contact account: ${escape(contact?.parentcustomerid?.name || contact?.parentcustomerid?.id || contact?.parentcustomerid || 'None')}</p></div><fieldset class="role-picker" id="persona-roles"><legend>Contact web-role memberships</legend><p class="field-help" id="persona-roles-help">Assignments use the imported role IDs. Authenticated and anonymous roles marked in the export apply automatically.</p>${filterBox('persona-roles', roles.length, 'Filter web roles')}${roles
          .filter((role) => role.id)
          .map(
            (role, index) =>
              `<div class="checkbox-line"><input type="checkbox" id="contact-role-${index}" data-contact-role="${escape(role.id)}" aria-describedby="persona-roles-help" ${assigned.has(role.id) ? 'checked' : ''}><label for="contact-role-${index}">${escape(role.name)}${role.authenticated ? ' · authenticated default' : role.anonymous ? ' · anonymous default' : ''}</label></div>`,
          )
          .join(
            '',
          )}</fieldset><div class="toolbar"><button class="button" type="submit" value="memberships">Save contact roles</button><button class="button primary" type="submit" value="select">Save roles and make default</button><button class="button" type="button" data-action="persona-sign-in">Make default on the sign-in page</button><button class="button quiet" type="button" data-action="persona-sign-out">No default persona</button></div></form>`
      : '<div class="notice">No local contacts are available. Add contact records under Data records or apply a persona preset.</div>'
  }<div class="notice section-gap"><strong>Sign-in page default:</strong> ${escape(identity.name || 'No default persona')}<br>${escape((identity.roles || []).join(', ') || 'No roles')}<br>Account: ${escape(identity.accountId || 'None')}</div></section>`;
}
/**
 * External identities per contact: the identity records the local identity provider signs each
 * contact in with (provider, username and where the record came from).
 */
function externalIdentitiesPanel() {
  if (externalIdentities === undefined) return '';
  const provider = signInProvider();
  const report = externalIdentities;
  let body = '<div class="notice">This Mirage does not report external identities.</div>';
  if (report) {
    const byContact = new Map();
    for (const item of report.identities) {
      const key = personaId(item.contactId);
      if (!byContact.has(key)) byContact.set(key, { name: item.contactName, rows: [] });
      byContact.get(key).rows.push(item);
    }
    // Contacts with identity records; when every contact is loaded (at most one page), also those without one.
    const entries = contactsComplete()
      ? contactList().map((record) => [personaId(record.contactid), contactLabel(record)])
      : [];
    for (const [key, value] of byContact)
      if (!entries.some(([id]) => id === key)) entries.push([key, value.name || key]);
    const describe = (item) =>
      `${escape(item.providerName || item.provider)}: ${escape(item.username)}${item.origin || item.active === false ? ` (${escape([item.origin, item.active === false ? 'inactive' : ''].filter(Boolean).join(', '))})` : ''}`;
    body = pagedTable('external-identities', entries, {
      caption: 'External identities per contact',
      emptyText: 'No local contacts to sign in as.',
      text: ([key, name]) =>
        `${name} ${key} ${(byContact.get(key)?.rows || []).map((item) => `${item.provider} ${item.username}`).join(' ')}`,
      rowAttrs: ([key]) => ({ 'data-contact-id': key }),
      columns: [
        { label: 'Contact', render: ([, name]) => `<strong>${escape(name)}</strong>` },
        {
          label: 'Identity records',
          render: ([key]) =>
            `<span class="source-path">${(byContact.get(key)?.rows || []).map(describe).join('; ') || 'None recorded yet: the first sign-in through the provider records one'}</span>`,
        },
      ],
    });
  }
  return disclosure(
    'external-identities',
    `External identities (${report?.identities?.length ?? 0} records)`,
    () =>
      `<section id="external-identities"><div class="panel-heading"><h2>External identities</h2>${badge(provider ? provider.caption || provider.name || 'Identity provider' : 'Local sign-in page', provider ? 'green' : '')}</div><p class="muted">The local identity provider offers the active contacts. A contact signs in with its external identity record for the provider (${escape(report?.table || 'adx_externalidentity, or mspp_externalidentity in enhanced exports')}); the first sign-in of a contact without one records it.</p>${panelHelp('access.external-identities')}${body}</section>`,
  );
}
function createPersonaForm() {
  const roles = (state.status?.permissionModel?.webRoles || state.status?.webRoles || []).filter((role) => role.id);
  return `<section class="advanced-content">${panelHelp('access.create-persona')}<p class="muted">Create a local contact with exported web-role memberships. Backend plugin rules apply to the contact record. The live browser identity is not affected.</p><form id="create-persona-form" class="form-grid"><div class="inline-fields"><div><label for="new-persona-first">First name</label><input id="new-persona-first" autocomplete="off"></div><div><label for="new-persona-last">Last name</label><input id="new-persona-last" required autocomplete="off"></div></div><div class="inline-fields"><div><label for="new-persona-email">Email</label><input id="new-persona-email" type="email" autocomplete="off"></div><div><label for="new-persona-account">Account ID</label><input id="new-persona-account" placeholder="Optional parent account ID" autocomplete="off"></div></div><fieldset class="role-picker" id="new-persona-roles"><legend>New persona web roles</legend>${filterBox('new-persona-roles', roles.length, 'Filter web roles')}${roles.map((role, index) => `<div class="checkbox-line"><input type="checkbox" id="new-persona-role-${index}" data-new-persona-role="${escape(role.id)}"><label for="new-persona-role-${index}">${escape(role.name)}</label></div>`).join('') || '<p class="field-help">The export defines no web roles.</p>'}</fieldset><div class="checkbox-line"><input type="checkbox" id="new-persona-select" checked><label for="new-persona-select">Sign this browser in as the new persona</label></div><div><button class="button primary" type="submit">Create persona</button></div></form></section>`;
}
function permissionTree() {
  const model = state.status?.permissionModel;
  if (!model) return '';
  const rows = model.tree || [],
    byId = new Map(rows.map((row) => [row.id, row])),
    page = sliceRows('grant tree', rows);
  const depth = (row) => {
    let level = 0,
      parent = row.parentId;
    const visited = new Set([row.id]);
    while (parent && byId.has(parent) && !visited.has(parent) && level < 6) {
      visited.add(parent);
      level++;
      parent = byId.get(parent).parentId;
    }
    return level;
  };
  return `<section class="panel section-gap" data-panel="permissions"><div class="panel-heading"><h2>Effective permission hierarchy</h2>${badge(model.source || 'Configured')}</div>${panelHelp('access.permissions', 'the effective permission hierarchy')}<form id="permission-source-form" class="toolbar"><label for="permission-source">Grant source</label><select id="permission-source" aria-describedby="permission-source-help"><option value="configured" ${config().permissionSource === 'configured' || !config().permissionSource ? 'selected' : ''}>Configured local rules</option><option value="exported" ${config().permissionSource === 'exported' ? 'selected' : ''}>Imported portal grants</option><option value="combined" ${config().permissionSource === 'combined' ? 'selected' : ''}>Imported grants + local additions</option></select><button class="button" type="submit">Apply grant source</button>${controlHelp('permission-source', 'access.permissions', 'source')}</form>${tableTools('grant tree', page.total, page.pages)}<div class="table-wrap section-gap"><table data-table="grant tree"><thead><tr><th>Permission / parent</th><th>Scope${kit.info({ label: 'About Scope', text: "Which records the grant covers: global (all), contact or account (the person's own or their account's), parent (through the parent grant's records) or self." })}</th><th>Operations / roles</th><th>Accessible records${kit.info({ label: 'About Accessible records', text: 'How many local records of the table the current person can reach through this grant, as the runtime reports it.' })}</th><th>Status</th></tr></thead><tbody>${page.items.map((row) => `<tr><td class="depth-${depth(row)}"><strong>${escape(row.name || row.entity)}</strong><div class="row-detail">${escape(row.entity)}${row.parentId ? ` · parent ${escape(byId.get(row.parentId)?.name || row.parentId)}` : ''}</div><div class="row-detail">${escape(row.relationshipName || '')} · ${escape(row.provenance?.type || 'Configured')}</div></td><td>${escape(row.scope)}</td><td>${escape((row.operations || []).join(', '))}<div class="row-detail">${escape((row.roles || []).join(', '))}${row.inheritedRoles ? ' · inherited' : ''}</div></td><td>${escape(model.visibleCounts?.[row.entity] ?? 'Not reported')}</td><td>${badge(row.enabled ? 'Enabled' : 'Disabled', row.enabled ? 'green' : 'amber')}${row.disabledReason ? `<div class="row-detail">${escape(row.disabledReason)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No grants were reported.</td></tr>'}</tbody></table></div>${model.diagnostics?.length ? lazyJson(`${model.diagnostics.length} permission observations`, model.diagnostics) : ''}</section>`;
}
function access() {
  const identity = config().identity || {};
  const roleNames = [
    ...new Set(
      [
        ...(state.status?.webRoles || []).map((role) => (typeof role === 'string' ? role : role.name)),
        ...collection('permissions').flatMap((permission) => permission.roles || []),
        ...(identity.roles || []),
      ].filter(Boolean),
    ),
  ].sort();
  const rolePicker = roleNames.length
    ? `<fieldset class="role-picker" id="identity-role-choices"><legend>Available web roles</legend><p class="field-help">Select imported role names, then save the identity. These roles affect local simulation; the connected browser retains its own live permissions.</p>${filterBox('identity-role-choices', roleNames.length, 'Filter web roles')}${roleNames.map((role, index) => `<div class="checkbox-line"><input type="checkbox" id="role-choice-${index}" data-role-choice="${escape(role)}" ${(identity.roles || []).includes(role) ? 'checked' : ''}><label for="role-choice-${index}">${escape(role)}</label></div>`).join('')}</fieldset>`
    : '';
  return (
    heading('Test portal behavior for the current contact, account, and web roles.') +
    steps('access', [
      {
        label: 'Sign in as a test person',
        href: '#access?panel=session',
        detail: "Pick a contact; this browser signs in through the portal's own sign-in and comes back here.",
        effect: 'browser',
      },
      {
        label: "Adjust that person's web roles",
        href: '#access?panel=personas',
        detail: "Save the contact's web-role memberships, or override roles for this browser only.",
        effect: 'data',
      },
      {
        label: 'Check what they can reach',
        href: '#access?panel=permissions',
        detail: 'Read the effective permission hierarchy; Apply grant source switches which grants count.',
        effect: 'read',
      },
      {
        label: 'Open the portal',
        href: runtimeLinks().powerPages || '/',
        detail: 'Pages in this browser now render for that person.',
        effect: 'read',
      },
    ]) +
    `<div data-panel="session">${sessionPanel()}</div>` +
    personaPanel() +
    (personaCatalogue ? personaManagementPanel(personaCatalogue) : '') +
    externalIdentitiesPanel() +
    disclosure('create-persona', 'Create a persona', createPersonaForm) +
    disclosure('session-override', 'Simulation override', sessionOverrideForm) +
    disclosure(
      'manual-identity',
      'Advanced: configured identity (sign-in default and scripts)',
      () =>
        `<section class="advanced-content"><div class="panel-heading"><h2>Configured identity</h2>${badge(identity.id || identity.contactId ? 'Authenticated' : 'Anonymous', identity.id || identity.contactId ? 'green' : '')}</div>${panelHelp('access.manual-identity', 'the configured identity')}<form id="identity-form" class="form-grid"><div class="inline-fields"><div><label for="identity-id">Contact ID</label><input id="identity-id" value="${escape(identity.contactId || identity.id || '')}" placeholder="Leave empty for anonymous">${kit.fieldHelp('identity-id', 'The contact id requests without a browser session use; empty means anonymous.')}</div><div><label for="identity-name">Display name</label><input id="identity-name" value="${escape(identity.name || '')}" placeholder="Local tester">${kit.fieldHelp('identity-name', 'The name Liquid sees as user.name for this configured identity.')}</div></div><div class="inline-fields"><div><label for="identity-account">Account ID</label><input id="identity-account" value="${escape(identity.accountId || '')}">${kit.fieldHelp('identity-account', 'The parent account id used for account-scoped table permissions.')}</div><div><label for="identity-roles">Web roles</label><input id="identity-roles" value="${escape((identity.roles || []).join(', '))}" placeholder="Authenticated Users, Administrators"><p class="field-help">Separate role names with commas.</p></div></div>${rolePicker}<div><label for="permission-mode">Permission enforcement</label><select id="permission-mode"><option value="permissive" ${config().permissionMode !== 'enforce' ? 'selected' : ''}>Permissive sandbox</option><option value="enforce" ${config().permissionMode === 'enforce' ? 'selected' : ''}>Enforce configured permissions</option></select>${kit.fieldHelp('permission-mode', 'Permissive lets every local request through for experiments; enforce applies table permissions as the portal does.')}</div><div><button class="button primary" type="submit">Save identity</button></div></form></section>`,
    ) +
    permissionTree() +
    presetPicker() +
    disclosure(
      'raw-permissions',
      `Edit local table permission rules (${collection('permissions').length})`,
      () =>
        `<section class="section-gap"><div class="panel-heading"><div><h2>Table permissions</h2><p class="muted">Read and mutation access for the simulated identity.</p></div>${addButton('permissions', 'Add permission')}</div>${panelHelp('access.raw-permissions')}${['exported', 'combined'].includes(config().permissionSource) ? '<div class="notice section-gap">Imported grants are source controlled. Choose configured local rules to edit their local copies, or imported grants + local additions to create separately identified local rules.</div>' : ''}${collectionTable('permissions')}</section>`,
    )
  );
}

function connection() {
  const live = config().live || {};
  const connected =
    state.status?.liveConnected || state.status?.live?.connected || live.connected || state.live?.connected;
  return (
    heading('Choose local simulation or data and pages from an authenticated online environment.') +
    `<div class="grid-two"><section class="panel" data-panel="routing"><div class="panel-heading"><h2>Request routing</h2>${badge(config().mode === 'live' ? 'Live data selected' : 'Local data selected', config().mode === 'live' ? 'amber' : 'green')}</div>${panelHelp('connection.routing')}<form id="connection-form" class="form-grid"><div class="inline-fields"><div><label for="data-mode">Data provider</label><select id="data-mode"><option value="local" ${config().mode !== 'live' ? 'selected' : ''}>Local mock</option><option value="live" ${config().mode === 'live' ? 'selected' : ''}>Live environment</option></select>${kit.fieldHelp('data-mode', 'Where Web API and Liquid data reads go. Live reads use the connected browser; writes still need the switch below.')}</div><div><label for="page-mode">Page provider</label><select id="page-mode"><option value="local" ${config().pageMode !== 'live' ? 'selected' : ''}>Local Liquid rendering</option><option value="live" ${config().pageMode === 'live' ? 'selected' : ''}>Live rendered pages</option></select>${kit.fieldHelp('page-mode', 'Local renders Liquid from your sources; live passes rendered pages through from the reference.')}</div></div><div><label for="live-origin">Environment origin</label><input id="live-origin" type="url" value="${escape(live.origin || '')}" placeholder="https://your-portal.powerappsportals.com"><p class="field-help">Use the portal origin. Individual endpoint routes can override the data provider.</p></div><div><label for="fetchxml-path">Live FetchXML endpoint override</label><input id="fetchxml-path" value="${escape(live.fetchXmlPath || '')}" placeholder="/fetch-data/?query={fetchXml}"><p class="field-help">Leave blank for native /_api/&lt;mappedSet&gt;?fetchXml= reads. An optional existing same-origin JSON endpoint must include {fetchXml}.</p></div><div class="checkbox-line"><input id="live-writes" type="checkbox" ${live.allowWrites && state.status?.liveWrites !== 'disabled' ? 'checked' : ''}${state.status?.liveWrites === 'disabled' ? ' disabled aria-describedby="live-writes-disabled"' : ''}><label for="live-writes">Allow create, update, and delete requests to the live environment.<br><span class="field-help">These requests affect actual environment data.</span>${state.status?.liveWrites === 'disabled' ? '<br><span class="field-help" id="live-writes-disabled">Disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) to allow it.</span>' : ''}</label></div><div class="checkbox-line"><input id="confine-portal-pages" type="checkbox" ${config().confinePortalPages ? 'checked' : ''}><label for="confine-portal-pages">Confine local pages to loopback.<br><span class="field-help">Adds a Content-Security-Policy that keeps local portal pages on this loopback origin. When off, pages carry only the headers the portal's site settings define, as they do online.</span></label></div><fieldset id="confinement-options" class="confinement-options${config().confinePortalPages ? '' : ' is-off'}" ${config().confinePortalPages ? '' : 'disabled'}><legend>Exceptions while confined</legend><div class="checkbox-line"><input id="external-assets" type="checkbox" ${config().externalAssets ? 'checked' : ''}><label for="external-assets">Allow external assets in local portal pages.<br><span class="field-help">Enable when your exported styles, fonts, or images use online URLs.</span></label></div><div><label for="external-frame-origins">Online embedded content</label><textarea id="external-frame-origins" class="full-width" rows="2" placeholder="https://app.powerbi.com">${escape((config().externalFrameOrigins || []).join('\n'))}</textarea><p class="field-help">One exact HTTPS origin per line. These frames use the selected online service even when portal API and data stay local. Leave blank to block online embedded content.</p></div><p class="field-help confinement-note">These apply only while local pages are confined to loopback.</p></fieldset><div><button class="button primary" type="submit">Save routing</button></div></form></section>
    <section class="panel" data-panel="browser"><div class="panel-heading"><h2>Authenticated browser</h2>${badge(connected ? 'Connected' : 'Not connected', connected ? 'green' : '')}</div>${panelHelp('connection.browser')}<p class="muted">Connect to an existing browser through its local debugging address. Sign-in stays in that browser; simulator configuration contains no credentials.</p><form id="live-connect-form" class="form-grid"><div><label for="cdp-url">Browser debugging address</label><input id="cdp-url" type="url" value="http://127.0.0.1:9222" required><p class="field-help">Use the free debugging port reported by your development session.</p></div><div class="toolbar"><button class="button" type="submit">Connect browser</button>${connected ? '<button class="button quiet" type="button" data-action="live-disconnect">Disconnect browser</button>' : ''}</div></form><div class="notice section-gap">Provider settings apply to requests reaching this mirage. Live page passthrough is online output, not proof of local rendering parity. Hardcoded online URLs in portal scripts remain browser requests.</div></section></div>` +
    disclosure(
      'shell-capture',
      'Capture page shell (reads the live page)',
      () =>
        `<section><div class="panel-heading"><h2>Capture page shell</h2>${badge('Read-only live page')}</div>${panelHelp('connection.shell', 'capturing the page shell')}<form id="shell-capture-form" class="form-grid"><div><label for="shell-page-path">Portal page path</label><input id="shell-page-path" value="${escape(shellCapturePath)}" placeholder="/" required></div><div><label for="managed-control-path">Managed editor page (optional)</label><input id="managed-control-path" value="${escape(managedControlPath)}" placeholder="/_portal/modal-form-template-path/…"><p class="field-help">Read an explicitly known native rich-text page to capture static PCF manifests. This GET saves no record values; existing connected pages supply observed font resource URLs.</p></div><div><button class="button" type="submit">Capture and replace shell</button></div></form>${shellCaptureResult ? `<details class="section-gap" open><summary class="muted">Page shell capture report</summary><pre class="json-view" id="shell-capture-report">${escape(json(shellCaptureResult))}</pre></details>` : ''}</section>`,
    ) +
    disclosure(
      'asset-capture',
      'Capture static portal assets',
      () =>
        `<section><div class="panel-heading"><h2>Capture static portal assets</h2>${badge('Explicit files only')}</div>${panelHelp('connection.assets', 'capturing static assets')}<form id="asset-capture-form" class="form-grid"><div><label for="asset-paths">Static file paths</label><textarea id="asset-paths" class="full-width" rows="4" placeholder="/xrm-adx/js/jquery-ui-1.11.4.min.js" required></textarea></div><div><label class="checkbox-label"><input id="observe-stylesheets" type="checkbox"> Observe selected stylesheet versions</label><p class="field-help">CSS files only. Explicit native versions apply while their exported source hashes are unchanged; local edits win.</p><button class="button" type="submit">Capture assets</button></div></form></section>`,
    ) +
    `<section class="panel section-gap"><div class="panel-heading"><div><h2>Portal shell resources</h2><p class="muted">Match the observed stylesheet and script order around local page templates.</p></div><button class="button" data-add="shellProfile">Edit shell profile</button></div>${panelHelp('connection.shell-resources')}${lazyJson('Inspect shell profile', config().shellProfile || {})}</section>`
  );
}

function richTextBaselines() {
  const rows = state.status?.richTextConfigurations || [];
  if (!rows.length) return '';
  return disclosure('rich-text-baselines', `Rich-text JSON baselines (${rows.length})`, () => {
    const page = sliceRows('rich-text baselines', rows);
    return `<section><div class="panel-heading"><h2>Versioned rich-text JSON baselines</h2>${badge(`${rows.length} deployment observations`)}</div>${panelHelp('mappings.rich-text')}<p class="muted">Captured JSON applies only while its mapped source file hash is unchanged. Edited local source wins. Capture records an observed deployment configuration; it does not identify the deployed commit.</p>${tableTools('rich-text baselines', page.total, page.pages)}<div class="table-wrap"><table data-table="rich-text baselines"><thead><tr><th>Local resource / source</th><th>Observed origin / path</th><th>Source binding</th><th>Provenance</th></tr></thead><tbody>${page.items.map((row) => `<tr><td><code>${escape(row.url)}</code><div class="row-detail">${escape(row.sourceFile)}</div></td><td>${escape(row.origin)}<div class="row-detail">${escape(row.observedPath)}</div></td><td>${badge(row.status === 'eligible' ? 'Source unchanged' : row.status === 'stale' ? 'Local source wins' : 'Invalid baseline', row.status === 'eligible' ? 'green' : 'amber')}${row.diagnostic ? `<div class="row-detail">${escape(row.diagnostic.message)}</div>` : ''}</td><td>${lazyJson('Inspect versioned provenance', row)}</td></tr>`).join('')}</tbody></table></div></section>`;
  });
}

function observedStylesheetBaselines() {
  const rows = state.status?.observedStylesheets ?? config().shellProfile?.observedStylesheets ?? [];
  if (!rows.length) return '';
  return disclosure('stylesheet-baselines', `Observed stylesheet versions (${rows.length})`, () => {
    const page = sliceRows('stylesheet baselines', rows);
    return (
      '<section><div class="panel-heading"><h2>Observed stylesheet versions</h2>' +
      badge(rows.length + ' source-bound observations') +
      '</div><p class="muted">These exact static native bytes apply only while mapped local source and cache hashes match. Local edits win; source/native differences remain inspectable.</p>' +
      tableTools('stylesheet baselines', page.total, page.pages) +
      '<div class="table-wrap"><table data-table="stylesheet baselines"><thead><tr><th>Mapped CSS / source</th><th>Source binding</th><th>Provenance</th></tr></thead><tbody>' +
      page.items
        .map(
          (row) =>
            '<tr><td><code>' +
            escape(row.path) +
            '</code><div class="row-detail">' +
            escape(row.sourceFile) +
            '</div></td><td>' +
            badge(
              row.state === 'observed'
                ? 'Observed bytes active'
                : row.state === 'source-edited'
                  ? 'Local source wins'
                  : (row.state ?? 'Captured; checked on request'),
              row.state === 'observed' ? 'green' : '',
            ) +
            (row.diagnostic ? '<div class="row-detail">' + escape(row.diagnostic.message) + '</div>' : '') +
            '</td><td>' +
            lazyJson('Inspect source/native hashes', row) +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table></div></section>'
    );
  });
}
function snippetCompositionControls() {
  const rows = config().shellProfile?.snippetCompositions ?? [];
  return disclosure(
    'snippet-compositions',
    `Observed snippet compositions (${rows.length})`,
    () =>
      `<section>${panelHelp('mappings.snippet-compositions', 'observed snippet compositions')}<form id="snippet-composition-form" class="form-grid"><div><label for="composition-page">Observed page path</label><input id="composition-page" placeholder="/owned-products/" required></div><div><label for="composition-parent">Parent snippet name</label><input id="composition-parent" required></div><div><label for="composition-child">Existing action snippet name</label><input id="composition-child" required></div><div><button class="button" type="submit">Observe static composition</button></div></form>${lazyJson('Inspect source-bound compositions', rows)}</section>`,
  );
}

// Diagnostics grouped by code: the groups and the items inside each group page through the kit.
function diagnosticItem(item) {
  const where = item.path || item.page || item.file;
  const route =
    typeof item.path === 'string' && /^\/(?!\/)/.test(item.path) && !/^\/_{1,2}sim(?:\/|$)/.test(item.path)
      ? item.path
      : null;
  const links = route
    ? `<div class="diagnostic-links"><a class="button small" href="${escape(route)}" target="_blank" rel="noopener">Open page ↗</a><a class="button small" href="#audit?path=${escape(encodeURIComponent(route))}">Requests for this path</a></div>`
    : item.file
      ? `<div class="diagnostic-links"><button class="button small" data-copy-text="${escape(item.file)}">Copy source path</button></div>`
      : '';
  return `<div class="diagnostic"><p>${escape(item.message || (typeof item === 'string' ? item : JSON.stringify(item)))}</p>${where ? `<div class="row-detail source-path">${escape(where)}</div>` : ''}${links}</div>`;
}
function diagnosticGroups(diagnostics, scope = 'diagnostics') {
  const grouped = new Map();
  for (const item of diagnostics) {
    const key = item.code || item.type || item.severity || 'Observation';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const groups = sliceRows(
    `${scope}-groups`,
    [...grouped].sort((a, b) => b[1].length - a[1].length),
    { text: ([key, items]) => `${key} ${items.map((item) => item.message ?? '').join(' ')}` },
  );
  return (
    tableTools(`${scope}-groups`, groups.total, groups.pages) +
    groups.items
      .map(([key, items]) => {
        const pagerKey = `${scope}:${key}`,
          page = sliceRows(pagerKey, items);
        return `<details class="diagnostic-group" data-ui-section="${escape(pagerKey)}"><summary><code>${escape(key)}</code>${badge(`${items.length}`, items.some((item) => /error|fail/i.test(item.severity || item.level || '')) ? 'red' : 'amber')}</summary><div class="diagnostic-items">${items.length > 10 ? tableTools(pagerKey, page.total, page.pages) : ''}${page.items.map(diagnosticItem).join('')}</div></details>`;
      })
      .join('') +
    `<p class="muted">Every observation is listed here; <a href="/__sim/api/diagnostics" target="_blank" rel="noopener">open the diagnostics API</a> to see them all as JSON.</p>`
  );
}

function evidenceSummary(evidence) {
  if (!evidence || !Object.keys(evidence).length) return '';
  const pixels = evidence.pixels;
  const urls = evidence.artifactUrls || {};
  return `<div class="detail-list"><div class="row"><span class="row-title">Compared route</span><span class="row-detail">${escape(evidence.path || 'Not reported')}</span></div><div class="row"><span class="row-title">Captured</span><span class="row-detail">${escape(evidence.time || 'Not reported')}</span></div>${pixels ? `<div class="row"><span class="row-title">Different pixels</span><span class="row-detail">${escape(pixels.different)} / ${escape(pixels.total)}</span></div><div class="row"><span class="row-title">Difference</span><span class="row-detail">${escape((Number(pixels.fraction || 0) * 100).toFixed(4))}%</span></div>` : ''}</div>${evidence.differences?.length ? `<ul class="muted">${evidence.differences.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}${Object.entries(
    urls,
  )
    .filter(([, url]) => typeof url === 'string' && /^\/__sim\//.test(url) && !url.includes('\\'))
    .map(
      ([label, url]) =>
        `<details class="evidence-image"><summary>${escape(label)} screenshot</summary><a href="${escape(url)}" target="_blank" rel="noopener"><img src="${escape(url)}" alt="${escape(label)} rendering evidence" loading="lazy"></a></details>`,
    )
    .join('')}`;
}

function evidence() {
  const status = state.status || {};
  const diagnostics = state.diagnostics || status.diagnostics || [];
  const evidence = state.evidence || status.evidence || {};
  const pages = status.pages || state.pages || [];
  const page = sliceRows('pages', Array.isArray(pages) ? pages : []);
  const stale = evidence.stale === true;
  const observed = !stale && (evidence.verified === true || evidence.passed === true);
  return (
    heading('Inspect observed render results, unsupported behavior, and runtime failures.') +
    `<div class="notice ${observed ? '' : 'warning'}">${stale ? 'Saved evidence is stale because its source or simulator state differs from this workspace. Run verification again to establish current results.' : observed ? 'Passing evidence applies only to the compared route, state, identity, and viewport. It does not establish exact parity for the entire portal.' : 'Exact portal parity has not been established by this workspace state. Configured pages and successful rendering alone do not prove equivalence to the live portal.'}</div>` +
    `<div class="grid-two"><section class="panel" data-panel="diagnostics"><div class="panel-heading"><h2>Runtime diagnostics</h2>${badge(`${diagnostics.length} observations`, diagnostics.length ? 'amber' : 'green')}</div>${panelHelp('evidence.diagnostics')}${diagnostics.length ? diagnosticGroups(diagnostics) : '<p class="muted">No diagnostics reported. Visit a portal page and refresh to inspect rendering observations.</p>'}</section><section class="panel" data-panel="rendering"><div class="panel-heading"><h2>Rendering evidence</h2>${badge(stale ? 'Stale evidence' : observed ? 'Evidence reported' : 'Unverified', observed ? 'green' : 'amber')}</div>${panelHelp('evidence.rendering')}${evidenceSummary(evidence)}${lazyJson('Full evidence report', evidence)}${lazyJson('Runtime status', status)}</section></div>` +
    `<section class="panel section-gap" data-panel="pages"><div class="panel-heading"><h2>Discovered pages</h2><span class="record-count">${Array.isArray(pages) ? pages.length : 0} routes</span></div>${panelHelp('evidence.pages')}${
      Array.isArray(pages) && pages.length
        ? tableTools('pages', page.total, page.pages) +
          `<div class="table-wrap"><table data-table="pages"><thead><tr><th>Page</th><th>Route</th><th>Action</th></tr></thead><tbody>${page.items
            .map((page) => {
              const route = typeof page === 'string' ? page : page.path || page.route || page.url || '/';
              const safeRoute = /^\/(?!\/)/.test(route) ? route : '/';
              return `<tr><td>${escape(page.name || page.title || route)}</td><td><code>${escape(route)}</code></td><td><a class="button small" href="${escape(safeRoute)}" target="_blank" rel="noopener">Open page ↗</a></td></tr>`;
            })
            .join('')}</tbody></table></div>`
        : '<p class="muted">Page route details are not included in the current server status.</p>'
    }</section>`
  );
}

function audit() {
  const result = auditResult || { items: [], total: 0, pageCount: 1 };
  browserFor('audit');
  const select = (name, label, values) =>
    `<label>${label}<select id="audit-filter-${name}" data-audit-filter="${name}" aria-describedby="audit-filter-${name}-help"><option value="">All</option>${values.map((value) => `<option value="${escape(value)}" ${auditFilters[name] === value ? 'selected' : ''}>${escape(value)}</option>`).join('')}</select></label>`;
  return (
    heading(
      'Inspect bounded, sanitized API, Liquid FetchXML, form, and page activity.',
      '<button class="button" data-audit-action="refresh">Refresh audit</button>',
    ) +
    `${legend('audit', 'Kinds and outcomes')}<section class="panel">${panelHelp('audit.filters')}<div class="toolbar audit-filters">${select('kind', 'Kind', [...new Set(['api', 'liquid-fetchxml', 'form', 'page', 'entity-read', 'entity-query', ...(Array.isArray(result.kinds) ? result.kinds : []), ...(auditFilters.kind ? [auditFilters.kind] : [])])])}${select('provider', 'Provider', ['local', 'live'])}${select('outcome', 'Outcome', ['success', 'error', 'denied', 'pending'])}${select('status', 'Status', ['2xx', '3xx', '4xx', '5xx', 'pending'])}<input type="search" id="audit-filter-path" data-audit-filter="path" aria-label="Filter audit by path" aria-describedby="audit-filter-path-help" placeholder="Path contains…" value="${escape(auditFilters.path)}"><input type="search" id="audit-filter-entity" data-audit-filter="entity" aria-label="Filter audit by table" aria-describedby="audit-filter-entity-help" placeholder="Table logical name" value="${escape(auditFilters.entity)}"><input type="search" id="audit-filter-search" data-audit-filter="search" aria-label="Search audit" aria-describedby="audit-filter-search-help" placeholder="Contact, table, path or error…" value="${escape(auditFilters.search)}">${auditFilters.correlationId ? `<button class="button small" data-audit-action="uncorrelate">Correlation ${escape(auditFilters.correlationId.slice(0, 8))} ×</button>` : ''}<button class="button small" data-audit-action="export">Export filtered JSON</button><button class="button small" data-audit-action="copy">Copy filtered JSON</button><button class="button small quiet" data-audit-action="clear">Clear audit</button></div><details class="field-hints"><summary>What these fields do</summary><p>${['kind', 'provider', 'outcome', 'status', 'path', 'entity', 'search'].map((name) => controlHelp(`audit-filter-${name}`, 'audit.filters', name)).join(' ')}</p></details><p class="muted">${escape(result.retained ?? 0)} kept · ${escape(result.dropped ?? 0)} dropped as the oldest beyond the limit.</p>${auditError ? `<div class="notice warning">${escape(auditError)}</div>` : ''}${auditLoading ? '<p role="status" class="muted">Loading request audit…</p>' : ''}${tableTools('audit', result.total, result.pageCount || 1, { search: false })}${panelHelp('audit.table')}<div class="table-wrap"><table data-table="audit"><thead><tr><th>Sequence / time${kit.info({ label: 'About Sequence / time', text: 'The order number given when the request started, and its start time.' })}</th><th>Request${kit.info({ label: 'About Request', text: 'The kind (Kinds and outcomes above explains each), method, path and table.' })}</th><th>Provider / contact${kit.info({ label: 'About Provider / contact', text: 'local: answered by this runtime; live: passed to the connected environment. Below it, the contact the request ran as, or Anonymous.' })}</th><th>Status / duration</th><th>Rows / outcome${kit.info({ label: 'About Rows / outcome', text: 'How many rows the request returned, then success, error, denied (a permission decision) or pending.' })}</th><th>Details</th></tr></thead><tbody>${result.items.map((item) => `<tr><td>${escape(item.sequence)}<div class="row-detail">${escape(item.startedAt)}</div></td><td><strong>${escape(item.kind)}</strong><div class="row-detail">${escape(item.method)} ${escape(item.path)}</div><code>${escape(item.entity || '')}</code></td><td>${badge(item.provider)}<div class="row-detail">${escape(item.identity?.contactId || 'Anonymous')}</div></td><td>${badge(item.status, item.status >= 400 ? 'red' : 'green')}<div class="row-detail">${escape(Number(item.durationMs || 0).toFixed(1))} ms</div></td><td>${escape(item.rowCount ?? '—')} · ${escape(item.outcome)}${item.error ? `<div class="row-detail">${escape(item.error.code)}${item.error.portalCode ? ` · portal ${escape(item.error.portalCode)}` : ''}</div>` : ''}</td><td>${inspectButton(item)}</td></tr>`).join('') || '<tr><td colspan="6">No matching requests have been recorded.</td></tr>'}</tbody></table></div></section>`
  );
}

function portal(overridesOnly = false) {
  if (overridesOnly)
    return (
      heading(
        'Per-instance values replace exported settings/snippets without editing source files. Reset restores the current source. False and True remain portal strings.',
      ) +
      experimentPanel() +
      portalValuePanels(true)
    );
  return (
    heading(
      'Experiment with local settings, snippets and web roles. Changes persist in this simulator workspace and refresh the portal.',
    ) +
    portalValuePanels(false) +
    accessRulesPanel()
  );
}
function portalValuePanels(overridesOnly) {
  return [
    ['portal-settings', 'Site settings', 'portalSettings'],
    ['portal-snippets', 'Content snippets', 'portalSnippets'],
    ...(overridesOnly ? [] : [['portal-roles', 'Web roles', 'portalRoles']]),
  ]
    .map(([kind, title, key]) => {
      const rows = config()[key] ?? [];
      const page = sliceRows(kind, rows);
      const displayValue = (row) => {
        if (row.deleted) return 'Removed locally';
        if (kind !== 'portal-roles') return String(row.value ?? '').slice(0, 160);
        return (
          [
            row.value?.authenticatedUsersRole && 'Signed-in contacts',
            row.value?.anonymousUsersRole && 'Anonymous visitors',
          ]
            .filter(Boolean)
            .join(', ') || 'Assigned through contact memberships'
        );
      };
      const tip = (label, text) => `${escape(label)}${kit.info({ label: `About ${label}`, text })}`;
      return `<section class="panel section-gap" data-panel="${kind.slice(7)}"><div class="panel-heading"><h2>${title}</h2><button class="button" data-add="${kind}">Add ${title === 'Site settings' ? 'setting' : title === 'Web roles' ? 'role' : 'snippet'}</button></div>${panelHelp(`${overridesOnly ? 'overrides' : 'portal'}.${kind.slice(7)}`, title.toLowerCase())}${tableTools(kind, page.total, page.pages)}<div class="table-wrap"><table data-table="${kind}"><thead><tr><th>Name</th><th>${kind === 'portal-roles' ? tip('Membership', 'Who gets the role without an explicit membership: every signed-in contact, every anonymous visitor, or only contacts assigned to it.') : tip('Effective value', 'The value portal pages and Liquid read now: your local override when there is one, otherwise the exported value.')}</th><th>${tip('Source value', 'The value in your exported portal source files. Local changes never edit these files.')}</th><th>${tip('Origin', 'Exported source: the value comes from your files. Local override: changed here; Reset restores the exported value.')}</th><th>Actions</th></tr></thead><tbody>${page.items.map((row) => `<tr id="portal-value-${escape(kind)}-${escape(row.id)}" data-operation-scope><td>${escape(row.name)}</td><td>${escape(displayValue(row))}</td><td>${escape(typeof row.sourceValue === 'object' ? JSON.stringify(row.sourceValue) : String(row.sourceValue ?? 'Not in source')).slice(0, 300)}</td><td>${badge(row.overridden ? 'Local override' : 'Exported source')}</td><td>${kind !== 'portal-roles' && !row.deleted && /^(true|false)$/i.test(String(row.value)) ? `<button class="button small" data-portal-toggle="${escape(row.id)}" data-portal-kind="${kind}" data-portal-value="${String(row.value).toLowerCase() === 'true' ? 'False' : 'True'}">Set ${String(row.value).toLowerCase() === 'true' ? 'False' : 'True'}</button>` : ''}<button class="button small" data-edit="${kind}" data-id="${escape(row.id)}">Edit</button>${row.overridden ? `<button class="button small" data-delete="${kind}" data-id="${escape(row.id)}">Reset</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>`;
    })
    .join('');
}

const experimentOwnership = (p) => (p.readOnly ? 'pack' : p.builtin ? 'builtin' : 'saved');
function selectedExperiment() {
  const select = document.querySelector('#experiment-select'),
    option = select?.selectedOptions[0];
  return config().experimentPresets?.find(
    (p) =>
      p.id === select?.value &&
      String(p.source ?? '') === option?.dataset.source &&
      experimentOwnership(p) === option?.dataset.ownership,
  );
}
document.addEventListener('change', (event) => {
  if (event.target.id !== 'experiment-select') return;
  const selected = selectedExperiment(),
    button = document.querySelector('[data-experiment="delete"]'),
    apply = document.querySelector('[data-experiment="apply"]');
  if (button) button.disabled = !selected || selected.builtin || selected.readOnly;
  if (apply) apply.disabled = !selected || selected.shadowed === true;
});
function experimentPanel() {
  return `<section id="configuration-presets-panel" data-operation-scope class="panel"><h2>Configuration presets</h2>${panelHelp(activeView === 'overrides' ? 'overrides.presets' : 'platform.presets', 'these presets')}<div class="toolbar">${filterBox('experiment-select', (config().experimentPresets ?? []).length, 'Filter configuration presets')}<select id="experiment-select" aria-label="Configuration preset" aria-describedby="experiment-select-help">${(config().experimentPresets ?? []).map((p) => `<option value="${escape(p.id)}" data-source="${escape(p.source ?? '')}" data-ownership="${experimentOwnership(p)}">${escape(p.name)}${p.shadowed ? ' · saved collision (pack takes precedence)' : p.readOnly ? ` · pack: ${escape(p.source)}` : p.builtin ? ' · built-in' : ' · local'}</option>`).join('')}</select><button class="button" data-experiment="apply">Apply preset</button><button class="button" data-experiment="delete" disabled>Delete saved preset</button></div><div class="toolbar"><input id="experiment-name" aria-label="Preset name" placeholder="Preset name" aria-describedby="experiment-name-help"><input id="experiment-id" aria-label="Preset ID" placeholder="preset-id" aria-describedby="experiment-id-help"><button class="button" data-experiment="save">Save current overrides</button><button class="button" data-experiment="export">Export selected JSON</button></div><details class="field-hints"><summary>What these fields do</summary><p>${controlHelp('experiment-select', 'platform.presets', 'select')} ${controlHelp('experiment-name', 'platform.presets', 'name')} ${controlHelp('experiment-id', 'platform.presets', 'id')}</p></details><details><summary>Import preset JSON</summary><textarea id="experiment-import" aria-label="Preset JSON" rows="6" aria-describedby="experiment-import-help"></textarea>${controlHelp('experiment-import', 'platform.presets', 'import')}<button class="button" data-experiment="import">Import preset</button></details><p>Active: ${escape(config().activeExperiment?.name ?? 'Custom / source defaults')}</p></section>`;
}
function platformRules() {
  const rows = config().platformSettings ?? [],
    page = sliceRows('platform-settings', rows);
  return (
    heading(
      'Local Dataverse/platform experiments. The access column describes real administration; coverage states exactly what Mirage enforces. No control updates a connected organization.',
    ) +
    (powerPages() || hasRoute('/_sim/api/experiments') ? experimentPanel() : '') +
    `<section class="panel section-gap" data-panel="settings"><h2>Platform settings</h2>${panelHelp('platform.settings', 'platform settings')}${tableTools('platform-settings', page.total, page.pages)}<div class="table-wrap"><table data-table="platform-settings"><thead><tr><th>Setting / documentation</th><th>Real administration${kit.info({ label: 'About Real administration', text: 'Who changes this setting in a real environment: a Microsoft support request, an organization setting, the catalogue only, or a simulator-only safety bound.' })}</th><th>Simulation coverage${kit.info({ label: 'About Simulation coverage', text: 'Exactly which local requests this runtime limits or checks with the setting.' })}</th><th>Source / effective value${kit.info({ label: 'About Source / effective value', text: 'Source: the value from the exported organization row or the catalogue default. Effective: the value requests use now, including your override.' })}</th><th>Instance override${kit.info({ label: 'About Instance override', text: "A value for this runtime only. Save override stores it in this runtime's state; Use source/default removes it." })}</th></tr></thead><tbody>${page.items.map((d) => `<tr id="platform-rule-${escape(d.key)}" data-operation-scope><td><strong>${escape(d.key)}</strong><p class="row-detail" id="platform-${escape(d.key)}-help">${escape(d.description)}</p>${d.source ? `<a href="${escape(d.source)}" target="_blank" rel="noreferrer">Microsoft documentation</a>` : ''}</td><td>${escape(d.access)}</td><td>${escape(d.coverage)}</td><td>${escape(d.origin)}<br>Source: ${escape(d.sourceValue ?? 'Not configured')}<br>Effective: ${escape(d.value ?? 'Not configured')}</td><td><label for="platform-${escape(d.key)}">${escape(d.key)}</label>${d.type === 'boolean' ? `<select id="platform-${escape(d.key)}" aria-describedby="platform-${escape(d.key)}-help"><option value="false" ${d.value !== true ? 'selected' : ''}>False</option><option value="true" ${d.value === true ? 'selected' : ''}>True</option></select>` : `<input id="platform-${escape(d.key)}" aria-describedby="platform-${escape(d.key)}-help" type="${d.type === 'integer' ? 'number' : 'text'}" value="${escape(d.value ?? '')}" ${d.type === 'integer' ? `min="${d.min}" max="${d.max}"` : ''}>`}<button class="button small" data-platform-save="${escape(d.key)}">Save override</button>${d.overridden ? `<button class="button small" data-platform-reset="${escape(d.key)}">Use source/default</button>` : ''}</td></tr>`).join('')}</tbody></table></div></section>`
  );
}

function accessRulesPanel() {
  const pages = new Map((state.status?.pages || []).map((page) => [String(page.id).toLowerCase(), page]));
  const roles = new Map((state.status?.webRoles || []).map((role) => [String(role.id).toLowerCase(), role.name]));
  const head = `<div class="panel-heading" data-panel="access-rules"><div><h2>Page access rules</h2><p class="muted">Grant change (1) and restrict read (2) rules decide which web roles may open a page branch. Local overrides apply immediately to page access, navigation and files; reset restores the export.</p></div><button class="button" data-add="portal-access-rules">Add rule</button></div>${panelHelp('portal.access-rules')}`;
  if (accessRulesError)
    return `<section class="panel section-gap">${head}<div class="notice warning">${escape(accessRulesError)}</div></section>`;
  if (!accessRules)
    return `<section class="panel section-gap">${head}<p role="status" class="muted">Loading page access rules…</p></section>`;
  const page = sliceRows('portal-access-rules', accessRules);
  const describe = (row) => {
    const value = row.value;
    if (!value) return ['Removed locally', '—', '—'];
    const target = pages.get(String(value.webPageId).toLowerCase());
    return [
      target ? `${target.name || target.url} (${target.url || target.path})` : `Unknown page ${value.webPageId}`,
      `${value.right === 1 ? 'Grant change' : value.right === 2 ? 'Restrict read' : 'Unresolved'} · ${value.scope === 2 ? 'exclude direct child files' : 'all content'}`,
      (value.roleIds || [])
        .map((roleId) => roles.get(String(roleId).toLowerCase()) || `${roleId} (unknown)`)
        .join(', ') || 'No roles',
    ];
  };
  return `<section class="panel section-gap">${head}${tableTools('portal-access-rules', page.total, page.pages)}<div class="table-wrap"><table data-table="portal-access-rules"><thead><tr><th>Rule</th><th>Page</th><th>Right / scope</th><th>Web roles</th><th>Origin</th><th>Actions</th></tr></thead><tbody>${
    page.items
      .map((row) => {
        const [target, right, roleNames] = describe(row);
        return `<tr><td class="item-title">${escape(row.name)}</td><td>${escape(target)}</td><td>${escape(right)}</td><td>${escape(roleNames)}</td><td>${badge(row.deleted ? 'Removed locally' : row.overridden ? 'Local override' : 'Exported source', row.overridden ? 'amber' : '')}</td><td class="actions"><button class="button small" data-edit="portal-access-rules" data-id="${escape(row.id)}">Edit</button>${row.overridden ? `<button class="button small" data-delete="portal-access-rules" data-id="${escape(row.id)}">Reset</button>` : ''}</td></tr>`;
      })
      .join('') || '<tr><td colspan="6">The export defines no page access rules.</td></tr>'
  }</tbody></table></div></section>`;
}

// Three kinds of scenario: state scenarios saved here, persona-catalogue scenarios and preflight scenario files.
function scenarioForm() {
  const presets = (state.status?.availablePresets || []).filter((preset) => !preset.unavailable);
  const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;
  return `<section>${panelHelp('scenarios.save')}<p class="muted">Choose what the scenario changes. Parts left on “keep” stay as they are when it is applied. Applying a preset first replaces the data sections that preset defines; the persona must exist afterwards.</p><form id="scenario-form" class="form-grid"><div class="inline-fields"><div><label for="scenario-name">Scenario name</label><input id="scenario-name" required placeholder="Reviewer with enforced permissions">${kit.fieldHelp('scenario-name', 'Shown in the scenarios table and in the active scenario notice.')}</div><div><label for="scenario-id">Scenario ID</label><input id="scenario-id" placeholder="reviewer-enforced"><p class="field-help">Letters, numbers, dots, underscores or hyphens. Derived from the name when empty.</p></div></div><div><label for="scenario-preset">Preset</label>${filterBox('scenario-preset', presets.length, 'Filter presets')}<select id="scenario-preset">${option('', 'Keep current data')}${presets.map((preset) => option(preset.id, preset.name || preset.id)).join('')}</select>${kit.fieldHelp('scenario-preset', 'A data preset applied first; it replaces the tables it defines.')}</div><div>${contactChoice(
    'scenario-persona',
    'Persona',
    '__keep',
    {
      fixed: [
        ['__keep', 'Keep current persona'],
        ['', 'Anonymous visitor'],
      ],
      help: 'Applying signs this browser in as the persona, or out for an anonymous visitor.',
    },
  )}</div><div><label for="scenario-permission-mode">Permission enforcement</label><select id="scenario-permission-mode">${option('', 'Keep current')}${option('enforce', 'Enforce table permissions')}${option('permissive', 'Permissive sandbox')}</select>${kit.fieldHelp('scenario-permission-mode', 'Enforce applies table permissions; permissive lets every local request through.')}</div><div><button class="button primary" type="submit">Save scenario</button></div></form></section>`;
}
function scenarios() {
  const active = config().activeScenario;
  const dashboard = availableViews().some(({ id }) => id === 'dashboard');
  return (
    heading(
      'Name a combination of preset, persona and permission enforcement, then switch between them in one step.',
      addButton('scenarios', 'Add scenario'),
    ) +
    steps('scenarios', [
      {
        label: 'Save a scenario',
        href: '#scenarios?panel=scenario-save',
        detail:
          'Name a data preset, a test person and permission enforcement to apply together. Saving changes nothing else.',
        effect: 'saves',
      },
      {
        label: 'Apply it',
        href: '#scenarios?panel=saved',
        detail:
          "Apply loads the preset's tables, signs this browser in as the person and sets enforcement; parts left on keep stay as they are.",
        effect: 'data',
      },
      {
        label: 'Or launch a catalogue scenario',
        href: '#scenarios?panel=persona-scenarios-panel',
        detail:
          'Signs a persona in and opens its start page; one with its own preset or setup runs in an isolated copy.',
        effect: 'browser',
      },
      {
        label: 'Reset when you are done',
        href: '#scenarios?panel=reset',
        detail: 'Restores the imported records, configuration, identity and permissions. Saved scenarios are kept.',
        effect: 'data',
      },
    ]) +
    (active
      ? `<div class="notice">Active scenario: <strong>${escape(active.name || active.id)}</strong> · applied ${escape(active.appliedAt || '')}</div>`
      : '') +
    `<section class="panel section-gap" data-panel="saved"><div class="panel-heading"><h2>Saved scenarios</h2>${badge(`${collection('scenarios').length} saved`)}</div>${panelHelp('scenarios.saved', 'saved scenarios')}${collectionTable('scenarios')}</section>` +
    disclosure('scenario-save', 'Save a scenario', scenarioForm) +
    (personaCatalogue
      ? personaManagementPanel(personaCatalogue)
      : `<section class="panel section-gap" id="persona-scenarios-panel"><h2>Catalogue scenarios</h2>${panelHelp('scenarios.catalogue', 'catalogue scenarios')}<p class="muted">No persona catalogue is loaded in this runtime, so there are no catalogue scenarios. A data pack or local state supplies the catalogue.</p></section>`) +
    `<section class="panel section-gap" data-panel="preflight"><h2>Preflight scenario files</h2>${panelHelp('scenarios.preflight', 'preflight scenario files')}<p class="muted">They stay in your project; this runtime does not load or list them.${dashboard ? ' The same check runs on demand under Blocking in Infrastructure.' : ''}</p>${dashboard ? `<a class="button" href="#dashboard?panel=blocking">Infrastructure: Blocking →</a>` : ''}</section>` +
    `<section class="panel section-gap" data-panel="reset"><div class="panel-heading"><h2>Reset the workspace</h2>${badge('Changes local data', 'amber')}</div>${panelHelp('scenarios.reset', 'reset')}<button class="button danger" data-action="reset-workspace">Reset to imported defaults</button></section>`
  );
}

function deploymentProfileControls(selection) {
  if (!selection?.profiles?.length)
    return '<p class="muted">Configure <code>mirage.deploymentProfiles</code> to select and pin mapped profiles here. Legacy exported profiles use <code>--deployment-profile NAME</code>.</p>';
  const labels = {
    pages: 'Pages',
    environmentVariables: 'Environment variables',
    connectionReferences: 'Connection references',
  };
  const option = (value, label, selected) =>
    `<option value="${escape(value)}" ${selected ? 'selected' : ''}>${escape(label)}</option>`;
  return `<form id="deployment-profile-form" class="form-grid section-gap"><div><label for="deployment-profile-id">Profile</label><select id="deployment-profile-id">${option('', 'No profile', !selection.profile)}${selection.profiles.map((profile) => option(profile.id, profile.id, selection.profile === profile.id)).join('')}</select></div><div>${Object.entries(
    labels,
  )
    .map(
      ([section, label]) =>
        `<label><input type="checkbox" data-profile-section="${section}" ${selection.enabled[section] ? 'checked' : ''} ${selection.required.includes(section) ? 'disabled' : ''}> ${label}${selection.required.includes(section) ? ' (required)' : ''}</label>`,
    )
    .join(
      '',
    )}</div><div class="toolbar"><button class="button primary" type="submit">Apply and pin locally</button><button class="button" type="submit" value="reset">Use configured defaults</button></div><p class="muted">${selection.pinned ? 'Pinned for this workspace.' : 'Following configured defaults.'} Default: ${escape(selection.default ?? 'None')}. Manual site and variable overrides take precedence. Connection references are local simulated records.</p></form>`;
}

function environment() {
  const env = environmentResult;
  const project = state.status?.project;
  const references = Array.isArray(project?.references) ? project.references : [];
  const live = env?.live || state.status?.live || {};
  const variables = env?.environmentVariables;
  const valueCell = (value) => (value === null || value === undefined ? '—' : String(value));
  const referenceTable = () =>
    pagedTable('references', references, {
      caption: 'Reference environments',
      columns: [
        { label: 'Reference', className: 'item-title', render: (reference) => escape(reference.name || reference.id) },
        { label: 'Origin', render: (reference) => `<code>${escape(reference.origin)}</code>` },
        {
          label: 'State',
          render: (reference) =>
            `${reference.origin === live.origin ? badge('Selected', 'green') : ''}${reference.default || reference.id === (project?.defaultReference?.id ?? project?.defaultReference) ? badge('Default') : ''}`,
        },
        {
          label: 'Actions',
          className: 'actions',
          render: (reference) =>
            `<button class="button small" data-reference-origin="${escape(reference.origin)}">Use for live routing</button>`,
        },
      ],
    });
  return (
    heading(
      'Reference environments, environment variables, deployment profile and reference enrichment for this workspace.',
      '<button class="button" data-action="reload-environment">Refresh environment</button>',
    ) +
    (environmentError ? `<div class="notice warning">${escape(environmentError)}</div>` : '') +
    `<div class="grid-two"><section class="panel" data-panel="references"><div class="panel-heading"><h2>Reference environments</h2>${badge(live.connected ? 'Browser connected' : 'Not connected', live.connected ? 'green' : '')}</div>${panelHelp('environment.references')}<p class="muted">Selecting a reference sets the origin used for live routing and enrichment. It never connects by itself: connect the intended signed-in browser under Live connection.</p>${
      references.length
        ? referenceTable()
        : '<div class="notice">No reference environments are configured for this runtime. A Mirage project file lists them under <code>references</code>; the toolkit can write one with <code>mirage init</code>.</div>'
    }<div class="detail-list section-gap"><div class="row"><span class="row-title">Live origin</span><span class="row-detail">${escape(live.origin || 'Not set')}</span></div><div class="row"><span class="row-title">Live writes</span><span class="row-detail">${escape(
      (live.liveWrites ?? state.status?.liveWrites) === 'disabled'
        ? 'Disabled for this runtime (start the Mirage with --allow-live-writes)'
        : live.allowWrites
          ? 'Allowed'
          : 'Blocked',
    )}</span></div></div><a class="button small section-gap" href="#connection?panel=browser">Live connection: connect a browser →</a></section>` +
    `<section class="panel" data-panel="profile"><div class="panel-heading"><h2>Deployment profile</h2>${badge(env?.profileSelection?.profile || env?.deploymentProfile || 'None applied')}</div>${panelHelp('environment.profile')}<div class="detail-list"><div class="row"><span class="row-title">Profile field changes</span><span class="row-detail">${escape(env?.profileChanges ?? 0)}</span></div><div class="row"><span class="row-title">Exported profiles</span><span class="row-detail">${escape((env?.deploymentProfiles || []).join(', ') || 'None')}</span></div></div>${deploymentProfileControls(env?.profileSelection)}<p class="muted">Profiles apply locally and do not identify the deployed commit.</p></section></div>` +
    `<section class="panel section-gap" data-panel="variables"><div class="panel-heading"><h2>Environment variables</h2>${badge(variables?.available ? `${variables.definitions.length} definitions` : 'Not imported', variables?.available ? 'green' : '')}</div>${panelHelp('environment.variables')}${legend('environment.variables', 'Secret variables')}<p class="muted">Definitions and values are local Dataverse tables seeded from the Solution sources. A local value is kept as an override until it is reset; then the Solution value or the definition default applies.</p>${
      variables?.available
        ? pagedTable('environment-variables', variables.definitions, {
            caption: 'Environment variables',
            emptyText: 'No environment variable definitions are stored.',
            columns: [
              {
                label: 'Schema name',
                className: 'item-title',
                render: (item) => `<code>${escape(item.schemaName)}</code>`,
              },
              { label: 'Display name', render: (item) => escape(item.displayName || '') },
              { label: 'Default', render: (item) => escape(item.secret ? 'secret' : valueCell(item.defaultValue)) },
              {
                label: 'Current value',
                render: (item) =>
                  `${escape(item.secret ? 'secret' : valueCell(item.value))}${item.overridden ? ` ${badge('Local override', 'amber')}` : ''}`,
              },
              { label: 'Effective', render: (item) => escape(item.secret ? 'secret' : valueCell(item.effectiveValue)) },
              {
                label: 'Actions',
                className: 'actions',
                render: (item) =>
                  `<button class="button small" data-edit="environment-variable" data-id="${escape(item.schemaName)}" ${variables.valuesMapped ? '' : 'disabled'}>Edit value</button>${item.overridden ? `<button class="button small quiet" data-reset-variable="${escape(item.schemaName)}">Reset local value</button>` : ''}`,
              },
            ],
          })
        : '<div class="notice">This workspace has no environmentvariabledefinition table. Import Solution environment variables during bootstrap to edit them here.</div>'
    }</section>` +
    // Reference reads and enrichment exist on the Power Pages host only.
    (!powerPages()
      ? ''
      : disclosure(
          'reference-enrichment',
          'Reference enrichment (reads the selected reference)',
          () =>
            `<section><div class="panel-heading"><h2>Reference enrichment</h2>${badge('Reads the selected reference', 'amber')}</div>${panelHelp('environment.enrichment', 'reference enrichment')}<form id="enrichment-form" class="form-grid"><div><label for="enrichment-plan">Enrichment plan (JSON array)</label><textarea id="enrichment-plan" class="code-editor" rows="8" spellcheck="false" placeholder='[{"entity":"account","fetchXml":"<fetch><entity name=\\"account\\"><attribute name=\\"name\\"/></entity></fetch>","pageSize":100,"maxPages":1}]'></textarea>${kit.fieldHelp('enrichment-plan', 'A JSON array of { entity, fetchXml, pageSize?, maxPages?, mode? } reads; Validate checks it without reading the reference.')}</div><div><label for="enrichment-file">Load plan file</label><input id="enrichment-file" type="file" accept="application/json,.json"></div><div class="toolbar"><button class="button" type="submit" value="validate">Validate plan</button><button class="button primary" type="submit" value="run" ${live.connected ? '' : 'disabled'}>Run plan</button></div></form>${enrichmentReport ? `<details class="section-gap" open><summary class="muted">Enrichment report</summary><pre class="json-view" id="enrichment-report">${escape(json(enrichmentReport))}</pre></details>` : ''}${(env?.referenceImports || []).length ? lazyJson(`${env.referenceImports.length} recorded reference imports`, env.referenceImports) : ''}</section>`,
        )) +
    (project
      ? `<section class="panel section-gap" data-panel="project"><div class="panel-heading"><h2>Project</h2>${badge(project.configFile ? 'Project file' : 'No project file')}</div>${panelHelp('environment.project')}<div class="detail-list"><div class="row"><span class="row-title">Configuration</span><span class="row-detail source-path">${escape(project.configFile || 'Started from a portal source without --project')}</span></div><div class="row"><span class="row-title">Portals</span><span class="row-detail source-path">${escape((project.portals || []).map((item) => (typeof item === 'string' ? item : item.id || item.sourceDir || '')).join(', '))}</span></div><div class="row"><span class="row-title">Solutions</span><span class="row-detail source-path">${escape((project.solutions || []).map((item) => (typeof item === 'string' ? item : item.id || item.root || '')).join(', ') || 'None')}</span></div><div class="row"><span class="row-title">Data packs in the project file${kit.info({ label: 'About data packs in the project file', text: 'Packs listed in the Mirage project file. Packs registered in the catalogue site show under Data packs.' })}</span><span class="row-detail">${escape((project.dataPacks || []).map((item) => (typeof item === 'string' ? item : item.id || item.module || '')).join(', ') || 'None')}</span></div></div>${lazyJson('Full project configuration', project)}</section>`
      : '')
  );
}

function runtimeState() {
  const status = state.status || {};
  if (!powerPages())
    return (
      heading('The active organization, imported Solutions and administration capabilities.') +
      simulationPanel() +
      `<section class="panel section-gap"><div class="detail-list"><div class="row"><span class="row-title">Runtime revision</span><span>${escape(status.revision ?? 'Not reported')}</span></div><div class="row"><span class="row-title">Solution roots</span><span class="source-path">${escape((status.solutionRoots ?? []).join(', ') || 'None')}</span></div></div>${lazyJson('Inspect runtime status', status)}<p class="muted">Change the runtime surface, imports and persistence level in Project setup, then restart. State import/reset and portal rendering controls are unavailable in this profile.</p><a class="button" href="/_setup/">Project setup</a></section>`
    );
  // status.bootstrap reports what the runtime loaded: Solution roots, layers in load order, timings.
  const bootstrap = status.bootstrap || {};
  const roots =
    Array.isArray(bootstrap.solutionRoots) && bootstrap.solutionRoots.length
      ? bootstrap.solutionRoots
      : status.solutionMetadata?.roots || status.solutionMetadata?.sources || [];
  const layers = Array.isArray(bootstrap.layers) ? bootstrap.layers : [];
  const timings = bootstrap.timings || {};
  const lastReload = timings.lastReload;
  // The local sign-in page and the platform behaviour recorded for this site (with its evidence).
  const signIn = bootstrap.signInPath;
  const signInText = signIn?.path
    ? `${signIn.path} (${signIn.source === 'site-setting' ? 'exported LoginPath setting' : signIn.source === 'observed' ? `observed${signIn.evidence ? `; evidence ${signIn.evidence}` : ''}` : 'platform default'})`
    : null;
  const observed = bootstrap.observed && typeof bootstrap.observed === 'object' ? bootstrap.observed : null;
  // Nested observations (headers) read "page name=value; webFile name=value, name=value".
  const nested = (value) => {
    if (!value || typeof value !== 'object') return String(value);
    const entries = Object.entries(value);
    return entries.every(([, item]) => !item || typeof item !== 'object')
      ? entries.map(([key, item]) => `${key}=${item}`).join(', ')
      : entries.map(([key, item]) => `${key} ${nested(item)}`).join('; ');
  };
  const observedText = observed
    ? `${Object.entries(observed)
        .filter(([key]) => key !== 'evidence')
        .map(([key, value]) => (value && typeof value === 'object' ? `${key} (${nested(value)})` : `${key} ${value}`))
        .join(', ')}${observed.evidence ? ` (evidence: ${observed.evidence})` : ''}`
    : 'None recorded';
  const row = (title, value) =>
    `<div class="row"><span class="row-title">${escape(title)}</span><span class="row-detail source-path">${escape(value ?? 'Not reported')}</span></div>`;
  return (
    heading('Fingerprints, reloads and portable copies of this local workspace state.') +
    simulationPanel() +
    disclosure(
      'runtime-fingerprints',
      `Fingerprints and bootstrap facts${status.implementationChanged ? ' · restart to load edited runtime code' : ''}`,
      () =>
        `<section><div class="panel-heading"><h2>Fingerprints</h2>${badge(status.implementationChanged ? 'Restart to load edited runtime code' : 'Runtime code current', status.implementationChanged ? 'amber' : 'green')}</div>${panelHelp('runtime.fingerprints')}<div class="detail-list">${row('Runtime revision', status.revision)}${row('Source fingerprint', status.sourceFingerprint)}${row('Loaded implementation', status.loadedImplementationFingerprint)}${row('Current implementation', status.implementationFingerprint)}${row('Source directory', status.sourceDir)}${row('Solution roots', roots.join(', ') || 'None')}${row('Solution layers', layers.map((layer) => `${layer.solution || layer.dir || 'Solution'}${layer.version ? ` ${layer.version}` : ''}${layer.type ? ` (${layer.type})` : ''}`).join(' → ') || 'None')}${row('Environment variable definitions', String(bootstrap.environmentVariables ?? 0))}${row('Sign-in page', signInText)}${row('Observed platform behaviour', observedText)}${row('Startup', Number.isFinite(timings.startupMs) ? `${timings.startupMs} ms${Number.isFinite(timings.solutionsMs) ? ` (Solutions ${timings.solutionsMs} ms)` : ''}` : null)}${row('Last source reload', lastReload ? `${lastReload.at} · ${lastReload.durationMs} ms · ${lastReload.changedCount ?? 0} changed files` : 'None since start')}</div>${
          layers.length
            ? pagedTable('solution-layers', layers, {
                caption: 'Solution layers in load order',
                columns: [
                  { label: 'Solution', render: (layer) => escape(layer.solution || layer.dir || 'Solution') },
                  { label: 'Version', render: (layer) => escape(layer.version ?? '') },
                  { label: 'Type', render: (layer) => escape(layer.type ?? '') },
                ],
              })
            : ''
        }<p class="muted">Evidence binds these fingerprints. A source save reloads the runtime and changes the source fingerprint; editing Mirage code requires a restart.</p></section>`,
    ) +
    `<section class="panel section-gap" data-panel="state"><div class="panel-heading"><h2>Workspace state</h2>${badge('Local only')}</div>${panelHelp('runtime.state', 'workspace state')}${actionList(
      [
        [
          '<button class="button" data-action="reload-sources">Reload sources</button>',
          'Reads your portal and Solution source files again, as saving a source file does.',
          'sources',
        ],
        [
          '<button class="button" data-action="export-state">Export state JSON</button>',
          'Downloads records, mappings, presets, rules and configuration as one JSON file. Nothing changes here.',
          'read',
        ],
        [
          '<label class="button" for="state-import-file">Import state JSON</label><input id="state-import-file" type="file" accept="application/json,.json" hidden>',
          'Replaces the whole local state with the file (saved scenarios are kept) and reloads open portal pages.',
          'data',
        ],
        [
          '<button class="button danger" data-action="reset-workspace">Reset to imported defaults</button>',
          'Restores the records, configuration, identity and permissions imported at start.',
          'data',
        ],
      ],
    )}</section>`
  );
}

const LOG_TYPES = ['request', 'liquid', 'data', 'plugin', 'diagnostic', 'reload', 'connected'];
function logSummary(entry) {
  const item = entry.entry;
  if (item)
    return `${item.method} ${item.path} → ${item.status ?? 'pending'}${item.entity ? ` · ${item.entity}` : ''}${item.rowCount !== null && item.rowCount !== undefined ? ` · ${item.rowCount} rows` : ''} · ${Number(item.durationMs || 0).toFixed(1)} ms${item.error ? ` · ${item.error.code}${item.error.portalCode ? ` (portal ${item.error.portalCode})` : ''}: ${item.error.message}` : ''}`;
  if (entry.type === 'plugin')
    return `${entry.operation} ${entry.entity}: ${(entry.plugins || []).join(', ') || 'no matching rules'} ${entry.outcome}${entry.error ? ` · ${entry.error.message}` : ''}`;
  if (entry.type === 'diagnostic')
    return `${entry.diagnostic?.code || 'Observation'}: ${entry.diagnostic?.message || ''}${entry.diagnostic?.path ? ` · ${entry.diagnostic.path}` : ''}`;
  if (entry.type === 'reload') return `Runtime revision ${entry.revision}`;
  if (entry.type === 'connected') return `Log stream connected at revision ${entry.revision ?? '?'}`;
  return JSON.stringify(entry);
}
const filteredLogs = () =>
  logEntries.filter(
    (entry) =>
      (!logFilters.type || entry.type === logFilters.type) &&
      (!logFilters.search || JSON.stringify(entry).toLowerCase().includes(logFilters.search.toLowerCase())),
  );
// Only the current page is in the DOM: newest first, 20 per page by default, through the kit pager.
function logRows() {
  const page = sliceRows('logs', filteredLogs(), { searchable: false });
  return (
    (page.total > page.size ? tableTools('logs', page.total, page.pages, { search: false }) : '') +
      page.items
        .map(
          (entry) =>
            `<div class="log-row ${escape(entry.level || 'info')}"><span class="log-time">${escape(String(entry.time || '').slice(11, 23))}</span>${badge(entry.type, entry.level === 'error' ? 'red' : entry.level === 'warning' ? 'amber' : '')}<span class="log-text">${escape(logSummary(entry))}</span><button class="button small quiet" data-log-entry="${escape(entry.sequence ?? '')}" data-log-time="${escape(entry.time ?? '')}">Inspect</button></div>`,
        )
        .join('') ||
    `<p class="muted">${logEntries.length ? 'No log entries match the filter.' : 'Waiting for runtime activity. Open or reload a portal page to see its requests.'}</p>`
  );
}
const logStatusText = () =>
  `${logStatus}${logPaused ? ` · paused, ${pausedLogs.length} new entries waiting` : ''} · ${logEntries.length} retained (newest 500)`;
function scheduleLogs() {
  if (activeView !== 'logs' || logFrame) return;
  logFrame = requestAnimationFrame(() => {
    logFrame = 0;
    const list = $('#log-list'),
      status = $('#log-status');
    if (list) list.innerHTML = logRows();
    if (status) status.textContent = logStatusText();
  });
}
function logs() {
  return (
    heading(
      'Requests, Liquid and data reads, plugin evaluations, diagnostics and reloads as they happen in this runtime.',
    ) +
    legend('logs', 'Log types') +
    `<section class="panel">${panelHelp('logs.list')}<div class="toolbar"><label class="nowrap">Type <select id="log-filter-type" data-log-filter="type" aria-label="Log type" aria-describedby="log-filter-type-help"><option value="">All</option>${LOG_TYPES.map((type) => `<option ${logFilters.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label><input type="search" id="log-filter-search" data-log-filter="search" aria-label="Filter live logs" aria-describedby="log-filter-search-help" placeholder="Path, table, code or message…" value="${escape(logFilters.search)}"><button class="button small" data-log-action="pause">${logPaused ? 'Resume' : 'Pause'}</button><button class="button small" data-log-action="copy">Copy filtered JSON</button><button class="button small quiet" data-log-action="clear">Clear</button></div><details class="field-hints"><summary>What these fields do</summary><p>${controlHelp('log-filter-type', 'logs.list', 'type')} ${controlHelp('log-filter-search', 'logs.list', 'search')}</p></details><p class="muted" id="log-status" role="status">${escape(logStatusText())}</p><div id="log-list" class="log-list">${logRows()}</div></section>`
  );
}

// ---- Dataverse API view: /_sim/api/dataverse status, registrations, users and the request ring buffer.
let dataverseResult,
  dataverseError = '',
  dataverseDisabled = false,
  // A created secret lives only in this page until dismissed; GET payloads never carry it.
  dataverseSecret = null,
  // The application whose edit row is open (its appId).
  dataverseEditing = null;
async function loadDataverse() {
  try {
    dataverseResult = await request('/dataverse');
    dataverseError = '';
    dataverseDisabled = false;
    // The full request ring; the summary above carries only the last 50.
    dataverseRequests =
      (await request('/dataverse/requests').catch(() => ({ requests: dataverseResult.requests ?? [] }))).requests ?? [];
  } catch (error) {
    dataverseResult = undefined;
    dataverseDisabled = error.details?.error?.code === 'DATAVERSE_DISABLED';
    dataverseError = dataverseDisabled ? '' : error.message;
  }
  if (activeView === 'dataverse') render();
}
// The user and workflow whose single edit form is open.
let dataverseRequests = [],
  dataverseUserEditing = null,
  dataverseWorkflowEditing = null;
const ACCESS_MODES = {
  0: 'Read-Write',
  1: 'Administrative',
  2: 'Read',
  3: 'Support user',
  4: 'Non-interactive',
  5: 'Delegated admin',
};
function dataverse() {
  const title = heading(
    'Local organization staff, simulated Entra application registrations, credentials and token authority. Staff sessions, application tokens and portal personas remain separate. Nothing here reaches a real environment.',
    '<button class="button" data-action="reload-dataverse">Refresh</button>',
  );
  if (dataverseDisabled)
    return (
      title +
      staffSessionPanel() +
      empty(
        'Organization HTTP API is disabled',
        'Staff sessions can still serve model-driven apps. Enable the HTTP API in Project setup and restart to connect integration clients.',
        '<a class="button" href="/_setup/#runtime-configuration">Configure API</a>',
      )
    );
  if (dataverseError) return title + `<div class="notice warning">${escape(dataverseError)}</div>`;
  const result = dataverseResult;
  if (!result) return title + '<p role="status" class="muted">Loading Dataverse API status…</p>';
  const roles = result.roles ?? [];
  const value = (text) => (text ? `<code>${escape(text)}</code>` : '—');
  const roleChoices = (prefix, selected) =>
    `<div class="dv-roles" id="${escape(prefix)}-list">${filterBox(`${prefix}-list`, roles.length, 'Filter security roles')}${roles.map((role) => `<label class="checkbox-label"><input type="checkbox" id="${escape(prefix)}-${escape(role.roleid)}" data-dv-role="${escape(role.name)}" ${selected.includes(role.name) ? 'checked' : ''}> ${escape(role.name)}</label>`).join('')}</div>`;
  const grantChoices = (prefix, selected) =>
    `<div class="dv-roles">${(result.grantTypes ?? []).map((name) => `<label class="checkbox-label"><input type="checkbox" id="${escape(prefix)}-${escape(name)}" data-dv-grant="${escape(name)}" ${selected.includes(name) ? 'checked' : ''}> ${escape(name)}</label>`).join('')}</div>`;
  const grantHelp = (id) =>
    kit.fieldHelp(id, 'Grant types this application may redeem; see Grant types above for what each allows.');
  // Inline edit row under the application it changes; the same fields as registration, minus the secret.
  const editRow = (app) =>
    `<tr><td colspan="5"><form id="dv-app-edit-${escape(app.appId)}" class="form-grid" data-dv-edit-form="${escape(app.appId)}"><div><label for="dv-edit-name">Edit display name</label><input id="dv-edit-name" value="${escape(app.displayName)}" required></div><div><label>Allowed grants</label>${grantChoices('dv-edit-grant', app.allowedGrants ?? [])}${grantHelp('dv-edit-grant')}</div><div><label class="checkbox-label"><input id="dv-edit-public" type="checkbox" ${app.publicClient ? 'checked' : ''}> Public client (no secret)</label></div><div><label for="dv-edit-redirect">Redirect URIs (one per line)</label><textarea id="dv-edit-redirect" rows="3" spellcheck="false">${escape((app.redirectUris ?? []).join('\n'))}</textarea>${kit.fieldHelp('dv-edit-redirect', 'http(s) URLs the authorization code and device flows may return to.')}</div><div class="toolbar"><button class="button primary" type="submit">Save application</button><button class="button quiet" type="button" data-dv-cancel-edit>Cancel edit</button></div></form></td></tr>`;
  const appOptions = (result.applications ?? [])
    .map((app) => `<option value="${escape(app.appId)}">${escape(app.displayName)} (${escape(app.appId)})</option>`)
    .join('');
  const secretPanel = dataverseSecret
    ? `<section class="panel section-gap one-time-secret" aria-live="polite"><div class="panel-heading"><h2>${escape(dataverseSecret.label)}</h2>${badge('Shown once', 'amber')}</div>${panelHelp('dataverse.secret')}<div class="notice warning">Copy this secret now. It is stored hashed and is not shown again; later listings show only its first characters.</div><code id="dv-secret">${escape(dataverseSecret.secret)}</code><div class="toolbar"><button class="button small" type="button" data-copy-text="${escape(dataverseSecret.secret)}">Copy secret</button><button class="button small quiet" type="button" data-action="dismiss-dataverse-secret">Dismiss</button></div></section>`
    : '';
  const status = `<section class="panel"><div class="panel-heading"><h2>Status</h2>${badge(result.enabled === false ? 'HTTP API disabled · organization available' : 'Listening', result.enabled === false ? '' : 'green')}</div>${panelHelp('dataverse.status')}<div class="detail-list">${[
    ['HTTPS origin', result.tlsOrigin],
    ['Authority', result.authority],
    ['Tenant id', result.tenantId],
    ['Organization id', result.organizationId],
    ['Certificate file', result.certificateFile],
    ['Certificate fingerprint', result.certificateFingerprint],
  ]
    .map(
      ([label, text]) =>
        `<div class="row"><div class="row-title">${escape(label)}</div><div class="row-detail">${value(text)}</div></div>`,
    )
    .join('')}</div></section>`;
  // Clients connect to the origin; the Origin itself is listed here rather than in Status.
  const tdsEnabled = result.tdsPort !== null && result.tdsPort !== undefined;
  const customServiceClientPort = (() => {
    try {
      const url = new URL(result.origin);
      return url.protocol === 'http:' && Boolean(url.port) && url.port !== '80';
    } catch {
      return false;
    }
  })();
  const serviceClientPortNote = customServiceClientPort
    ? '<p class="notice" data-serviceclient-port>Microsoft.PowerPlatform.Dataverse.Client drops custom HTTP ports. <a href="/_setup/#runtime-configuration">Configure the organization API port as 80</a>, then restart Mirage before using these ServiceClient connection strings.</p>'
    : '';
  const connect = disclosure(
    'dv-connect',
    `Connect${tdsEnabled ? ' · TDS (SQL) endpoint on' : ''}`,
    () =>
      `<section><div class="panel-heading"><h2>Connect</h2>${badge(tdsEnabled ? 'TDS (SQL) endpoint on' : 'TDS (SQL) endpoint off', tdsEnabled ? 'green' : '')}</div>${panelHelp('dataverse.connect')}<p class="muted">Addresses for clients and tools. Each application signs in with its own client secret, which is shown only once when it is created, so the connection strings keep a placeholder.</p><div class="detail-list">${[
        ['Org URL', result.origin],
        ['Token endpoint', result.authority ? `${result.authority}/oauth2/v2.0/token` : null],
        ['Scope', result.origin ? `${result.origin}/.default` : null],
        ['TDS endpoint (SQL queries)', tdsEnabled ? `127.0.0.1,${result.tdsPort}` : null],
      ]
        .map(
          ([label, text]) =>
            `<div class="row"><div class="row-title">${escape(label)}</div><div class="row-detail">${value(text)}</div></div>`,
        )
        .join(
          '',
        )}</div><h3>ServiceClient connection strings</h3>${serviceClientPortNote}${(result.applications ?? []).map((app) => `<div class="row-detail"><code>${escape(`AuthType=ClientSecret;Url=${result.origin};ClientId=${app.appId};ClientSecret=<client secret>`)}</code></div>`).join('') || '<p class="muted">Register an application to get a connection string.</p>'}</section>`,
  );
  const appPage = sliceRows('dv-applications', result.applications ?? []);
  const applications = `<section class="panel section-gap"><div class="panel-heading"><h2>Applications</h2>${badge(`${(result.applications ?? []).length} registered`)}</div>${panelHelp('dataverse.applications')}${legend('dataverse.applications', 'Grant types')}${tableTools('dv-applications', appPage.total, appPage.pages)}<div class="table-wrap"><table data-table="dv-applications"><thead><tr><th>Application</th><th>Secrets</th><th>Certificates</th><th>Grants</th><th>Actions</th></tr></thead><tbody>${appPage.items.map((app) => `<tr id="dv-app-row-${escape(app.appId)}" data-operation-scope><td class="item-title">${escape(app.displayName)}<div class="row-detail"><code>${escape(app.appId)}</code></div>${app.systemuserid ? `<div class="row-detail">User ${escape(app.systemuserid)}</div>` : ''}${(app.redirectUris ?? []).map((uri) => `<div class="row-detail">Redirect <code>${escape(uri)}</code></div>`).join('')}</td><td>${(app.secrets ?? []).map((secret) => `<div class="row-detail"><code>${escape(secret.hint)}…</code> expires ${escape(String(secret.expiresOn ?? '').slice(0, 10))} <button class="button small quiet" type="button" data-dv-delete-secret="${escape(secret.id)}" data-dv-app="${escape(app.appId)}">Remove</button></div>`).join('') || 'None'}</td><td>${(app.certificates ?? []).map((certificate) => `<div class="row-detail"><code>SHA-1 ${escape(certificate.thumbprint)}</code> <button class="button small quiet" type="button" data-dv-remove-cert="${escape(certificate.thumbprint)}" data-dv-app="${escape(app.appId)}" aria-label="Remove certificate ${escape(certificate.thumbprint)}">Remove</button></div><div class="row-detail"><code>SHA-256 ${escape(certificate.thumbprint256)}</code></div>`).join('') || 'None'}</td><td>${escape((app.allowedGrants ?? []).join(', '))}${app.publicClient ? ` ${badge('Public client')}` : ''}</td><td class="actions"><button class="button small quiet" type="button" data-dv-edit-app="${escape(app.appId)}">Edit</button><button class="button small" type="button" data-dv-add-secret="${escape(app.appId)}">Add secret</button><button class="button small quiet" type="button" data-dv-remove-app="${escape(app.appId)}" data-dv-name="${escape(app.displayName)}">Remove</button></td></tr>${dataverseEditing === app.appId ? editRow(app) : ''}`).join('') || '<tr><td colspan="5">No application registered yet.</td></tr>'}</tbody></table></div></section>`;
  const allUsers = result.users ?? [];
  const userPage = sliceRows('dv-users', allUsers);
  const editingUser = allUsers.find((user) => user.systemuserid === dataverseUserEditing);
  const userEditor = editingUser
    ? `<section class="panel section-gap" id="dv-user-editor-${escape(editingUser.systemuserid)}" data-dv-user-editor="${escape(editingUser.systemuserid)}" data-operation-scope="dv-user-${escape(editingUser.systemuserid)}"><div class="panel-heading"><h3>Edit ${escape(editingUser.fullname)}</h3><button class="button small quiet" type="button" data-dv-close-user>Close</button></div><form id="dv-roles-${escape(editingUser.systemuserid)}" class="form-grid" data-dv-user="${escape(editingUser.systemuserid)}"><div><label>Security roles</label>${roleChoices(`dv-roles-${editingUser.systemuserid}`, editingUser.roles ?? [])}${kit.fieldHelp(`dv-roles-${editingUser.systemuserid}`, "Roles decide what this user's tokens can read or change through the API.")}</div><div><button class="button small" type="submit">Save roles</button></div></form><form id="dv-password-${escape(editingUser.systemuserid)}" class="dv-password form-grid" data-dv-password="${escape(editingUser.systemuserid)}"><div><label for="dv-password-input-${escape(editingUser.systemuserid)}">New password for ${escape(editingUser.fullname)}</label><input id="dv-password-input-${escape(editingUser.systemuserid)}" type="password" autocomplete="new-password" minlength="8" maxlength="256" required aria-describedby="dv-password-input-${escape(editingUser.systemuserid)}-help">${kit.fieldHelp(`dv-password-input-${editingUser.systemuserid}`, '8 to 256 characters for the password (ROPC) grant; stored hashed and never shown.')}</div><div class="toolbar"><button class="button small" type="submit">${editingUser.passwordSet ? 'Replace password' : 'Set password'}</button>${editingUser.passwordSet ? `<button class="button small quiet" type="button" data-dv-clear-password="${escape(editingUser.systemuserid)}" data-dv-name="${escape(editingUser.fullname)}">Clear password</button>` : ''}</div></form></section>`
    : '';
  const users = disclosure(
    'dv-users',
    `Users (${allUsers.length})`,
    () =>
      `<section><div class="panel-heading"><h2>Users</h2>${badge(`${allUsers.length} users`)}</div>${panelHelp('dataverse.users')}${legend('dataverse.users', 'Access modes')}<p class="muted">Security roles decide what a token holder can read or change through this API. They never apply to the portal.</p>${tableTools('dv-users', userPage.total, userPage.pages)}<div class="table-wrap"><table data-table="dv-users"><thead><tr><th>User</th><th>Access mode</th><th>State</th><th>Roles</th><th>Actions</th></tr></thead><tbody>${userPage.items.map((user) => `<tr id="dv-user-row-${escape(user.systemuserid)}" data-operation-scope="dv-user-${escape(user.systemuserid)}"><td class="item-title">${escape(user.fullname)}<div class="row-detail">${escape(user.domainname || (user.applicationid ? `Application ${user.applicationid}` : ''))}</div><div class="row-detail"><code>${escape(user.systemuserid)}</code></div></td><td>${escape(ACCESS_MODES[user.accessmode] ?? String(user.accessmode))}</td><td>${badge(user.isdisabled ? 'Disabled' : 'Enabled', user.isdisabled ? 'red' : 'green')}${user.passwordSet ? ` ${badge('Password set')}` : ''}</td><td>${escape((user.roles ?? []).join(', ') || 'No roles')}</td><td class="actions"><button class="button small quiet" type="button" data-dv-edit-user="${escape(user.systemuserid)}" aria-label="Edit ${escape(user.fullname)}">Edit</button><button class="button small" type="button" data-dv-toggle-user="${escape(user.systemuserid)}" data-dv-disabled="${user.isdisabled ? 'false' : 'true'}">${user.isdisabled ? 'Enable' : 'Disable'}</button></td></tr>`).join('') || '<tr><td colspan="5">No users.</td></tr>'}</tbody></table></div>${userEditor}</section>`,
  );
  const register = disclosure(
    'dv-register',
    'Register an application',
    () =>
      `<section>${panelHelp('dataverse.register')}<form id="dv-app-form" class="form-grid"><div><label for="dv-app-name">Display name</label><input id="dv-app-name" required>${kit.fieldHelp('dv-app-name', "Shown in sign-in pages and as the application user's name.")}</div><div><label for="dv-app-id">Application id (optional GUID)</label><input id="dv-app-id" placeholder="Generated when empty">${kit.fieldHelp('dv-app-id', 'The client id clients send; a new GUID is generated when empty.')}</div><div><label>Roles for the application user</label>${roleChoices('dv-app-role', ['System Administrator'])}</div><div><label>Allowed grants</label>${grantChoices('dv-app-grant', ['client_credentials'])}${grantHelp('dv-app-grant')}</div><div><label class="checkbox-label"><input id="dv-app-public" type="checkbox"> Public client (no secret)</label><p class="field-help">A public client gets no secret; it signs in with a grant such as authorization_code and a redirect URI.</p></div><div><label for="dv-app-redirect">Redirect URIs (one per line)</label><textarea id="dv-app-redirect" rows="3" spellcheck="false" placeholder="https://client.example.test/callback"></textarea>${kit.fieldHelp('dv-app-redirect', 'http(s) URLs the authorization code and device flows may return to.')}</div><div><button class="button primary" type="submit">Register application</button></div></form></section>`,
  );
  const createUser = disclosure(
    'dv-create-user',
    'Create an interactive user',
    () =>
      `<section>${panelHelp('dataverse.users')}<form id="dv-user-form" class="form-grid"><div><label for="dv-user-name">Full name</label><input id="dv-user-name" required>${kit.fieldHelp('dv-user-name', 'The systemuser full name shown in model-driven apps and sign-in pickers.')}</div><div><label for="dv-user-domain">Sign-in name (domainname)</label><input id="dv-user-domain" placeholder="maker@example.test" required>${kit.fieldHelp('dv-user-domain', 'The user principal name used to sign in locally.')}</div><div><label for="dv-user-object">Entra object id (optional GUID)</label><input id="dv-user-object" placeholder="Generated when empty">${kit.fieldHelp('dv-user-object', "The oid claim of this user's tokens; generated when empty.")}</div><div><label for="dv-user-password">Password for ROPC sign-in (optional, 8 to 256 characters)</label><input id="dv-user-password" type="password" autocomplete="new-password" minlength="8" maxlength="256"><p class="field-help">Stored hashed and never shown. Leave empty to refuse the password grant for this user.</p></div><div><label>Roles</label>${roleChoices('dv-user-role', ['Basic User'])}</div><div><button class="button primary" type="submit">Create user</button></div></form></section>`,
  );
  const certificate = disclosure(
    'dv-certificate',
    'Add a certificate',
    () =>
      `<section>${panelHelp('dataverse.certificates')}<form id="dv-cert-form" class="form-grid"><div><label for="dv-cert-app">Application</label><select id="dv-cert-app" required ${appOptions ? '' : 'disabled'}>${appOptions || "<option value=''>Register an application first</option>"}</select>${kit.fieldHelp('dv-cert-app', 'The application that signs client assertions with the matching private key.')}</div><div><label for="dv-cert-pem">Certificate or public key (PEM)</label><textarea id="dv-cert-pem" class="code-editor" rows="6" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----" required></textarea><p class="field-help">Paste the certificate (recommended, its SHA-1 and SHA-256 fingerprints become the x5t and x5t#S256 thumbprints MSAL sends) or a bare public key. Only public material is stored; the client signs its assertion with the matching private key.</p></div><div><button class="button" type="submit" ${appOptions ? '' : 'disabled'}>Add certificate</button></div></form></section>`,
  );
  const federatedRows = (result.applications ?? []).flatMap((app) =>
    (app.federatedCredentials ?? []).map((credential) => ({ app, credential })),
  );
  const federatedPage = sliceRows('dv-federated', federatedRows);
  const federated = disclosure(
    'dv-federated',
    `Federated credentials (${federatedRows.length})`,
    () =>
      `<section><div class="panel-heading"><h2>Federated credentials</h2>${badge(`${federatedRows.length} trusted`)}</div>${panelHelp('dataverse.federated')}<p class="muted">Workload identity federation: tokens from an external issuer sign in as the application. Only the issuer's public keys are stored.</p>${tableTools('dv-federated', federatedPage.total, federatedPage.pages)}<div class="table-wrap"><table data-table="dv-federated"><thead><tr><th>Application</th><th>Issuer</th><th>Subject</th><th>Audience</th><th>Actions</th></tr></thead><tbody>${federatedPage.items.map(({ app, credential }) => `<tr id="dv-federated-row-${escape(app.appId)}-${encodeURIComponent(credential.issuer)}-${encodeURIComponent(credential.subject)}" data-operation-scope><td class="item-title">${escape(app.displayName)}</td><td><code>${escape(credential.issuer)}</code></td><td><code>${escape(credential.subject)}</code></td><td>${escape((credential.audiences ?? []).join(', '))}</td><td class="actions"><button class="button small quiet" type="button" data-dv-remove-federated data-dv-app="${escape(app.appId)}" data-dv-issuer="${escape(credential.issuer)}" data-dv-subject="${escape(credential.subject)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="5">No federated credential yet.</td></tr>'}</tbody></table></div><form id="dv-federated-form" class="form-grid section-gap"><div><label for="dv-fed-app">Application</label><select id="dv-fed-app" required ${appOptions ? '' : 'disabled'}>${appOptions || "<option value=''>Register an application first</option>"}</select></div><div><label for="dv-fed-issuer">Issuer (https URL)</label><input id="dv-fed-issuer" type="url" placeholder="https://issuer.example.test/tenant" required>${kit.fieldHelp('dv-fed-issuer', 'The iss claim of the external tokens.')}</div><div><label for="dv-fed-subject">Subject</label><input id="dv-fed-subject" placeholder="repo:example/app:ref:refs/heads/main" required>${kit.fieldHelp('dv-fed-subject', 'The sub claim that must match exactly.')}</div><div><label for="dv-fed-audience">Audience</label><input id="dv-fed-audience" value="api://AzureADTokenExchange" required>${kit.fieldHelp('dv-fed-audience', 'The aud claim the external token carries.')}</div><div><label for="dv-fed-jwks">Issuer JWKS (public keys, JSON)</label><textarea id="dv-fed-jwks" class="code-editor" rows="5" spellcheck="false" placeholder='{"keys":[]}' required></textarea><p class="field-help">The issuer's public JSON Web Key Set. A key with a private part is refused.</p></div><div><button class="button" type="submit" ${appOptions ? '' : 'disabled'}>Add federated credential</button></div></form></section>`,
  );
  // Managed identity endpoint summary: mode and endpoint only; the identity header is never rendered.
  const summary = result.managedIdentity ?? {};
  const identitySummary = summary.enabled
    ? kit.kv([
        ['Mode', escape(summary.mode ?? 'appservice')],
        ['Endpoint', summary.endpoint ? `<code>${escape(summary.endpoint)}</code>` : 'Not reported'],
        ['Identity header', 'Configured for the managed identity endpoint; its value is not displayed here.'],
      ])
    : kit.notice(
        'The managed identity endpoint is off for this runtime. Configure managedIdentity in the mirage settings and restart to serve it.',
        'neutral',
      );
  const identityRows = result.managedIdentities ?? [];
  const identities = disclosure(
    'dv-managed-identities',
    `Managed identities (${identityRows.length})`,
    () =>
      `<section><div class="panel-heading"><h2>Managed identities</h2>${badge(`${identityRows.length} identities`)}</div>${panelHelp('dataverse.managed-identities')}${identitySummary}<p class="muted">Azure-hosted identities that obtain tokens from this simulator's managed identity endpoints. Each becomes an application user; identities from the settings are removed there.</p>${pagedTable(
        'dv-managed-identities',
        identityRows,
        {
          caption: 'Managed identities',
          emptyText: 'No managed identity yet.',
          columns: [
            {
              label: 'Identity',
              className: 'item-title',
              render: (identity) =>
                `${escape(identity.displayName)}<div class="row-detail"><code>${escape(identity.clientId)}</code></div>`,
            },
            { label: 'Principal id', render: (identity) => `<code>${escape(identity.principalId ?? '')}</code>` },
            { label: 'Roles', render: (identity) => escape((identity.roles ?? []).join(', ')) },
            {
              label: 'Source',
              render: (identity) =>
                identity.source === 'settings' ? badge('From settings') : badge('Added here', 'green'),
            },
            {
              label: 'Actions',
              className: 'actions',
              render: (identity) =>
                identity.source === 'settings'
                  ? ''
                  : `<button class="button small quiet" type="button" data-dv-remove-identity="${escape(identity.clientId)}" data-dv-name="${escape(identity.displayName)}">Remove</button>`,
            },
          ],
        },
      )}<form id="dv-identity-form" class="form-grid section-gap"><div><label for="dv-identity-name">Identity name</label><input id="dv-identity-name" required>${kit.fieldHelp('dv-identity-name', 'The display name of the identity and its application user.')}</div><div><label for="dv-identity-client">Client id (optional GUID)</label><input id="dv-identity-client" placeholder="Generated when empty">${kit.fieldHelp('dv-identity-client', 'The client_id a workload sends to the endpoint; generated when empty.')}</div><div><label for="dv-identity-principal">Principal id (optional GUID)</label><input id="dv-identity-principal" placeholder="Generated when empty">${kit.fieldHelp('dv-identity-principal', 'The oid claim of the issued tokens; generated when empty.')}</div><div><label>Roles</label>${roleChoices('dv-identity-role', ['Basic User'])}</div><div><button class="button" type="submit">Add managed identity</button></div></form></section>`,
  );
  const requests = disclosure(
    'dv-requests',
    `Recent requests (${dataverseRequests.length})`,
    () =>
      `<section><div class="panel-heading"><h2>Recent requests</h2>${badge('Ring buffer')}</div>${panelHelp('dataverse.requests')}<p class="muted">Requests on the Dataverse origin, newest first. Tokens, secrets and bodies are never recorded.</p>${pagedTable(
        'dv-requests',
        [...dataverseRequests].reverse(),
        {
          caption: 'Dataverse requests',
          emptyText: 'No request has reached the Dataverse origin yet.',
          text: (entry) =>
            `${entry.method} ${entry.path} ${entry.status} ${entry.appId ?? ''} ${entry.userId ?? ''} ${entry.grant ?? ''}`,
          columns: [
            { label: 'Time', render: (entry) => escape(new Date(entry.at).toISOString()) },
            {
              label: 'Request',
              render: (entry) => `<strong>${escape(entry.method)}</strong> <code>${escape(entry.path)}</code>`,
            },
            {
              label: 'Status / duration',
              render: (entry) =>
                `${badge(entry.status, entry.status >= 400 ? 'red' : 'green')}<div class="row-detail">${escape(Number(entry.ms || 0).toFixed(1))} ms</div>`,
            },
            {
              label: 'Caller',
              render: (entry) =>
                `${escape(entry.appId || entry.userId || 'Anonymous')}${entry.grant ? `<div class="row-detail">${escape(entry.grant)}</div>` : ''}`,
            },
          ],
        },
      )}</section>`,
  );
  const reset = powerPages()
    ? `<section class="panel section-gap"><div class="panel-heading"><h2>Reset</h2>${badge('Local state change', 'amber')}</div>${panelHelp('dataverse.reset')}<p class="muted">Reset the workspace to its imported defaults. Application registrations and user passwords are kept; the security tables are seeded again, so runtime-created users are removed.</p><button class="button danger" data-action="reset-workspace">Reset to imported defaults</button></section>`
    : '';
  // Runtime settings the API reads per request, then the values only a restart can change.
  const env = result.environment ?? null;
  const restart = env?.restartRequired ?? {};
  const environment = env
    ? disclosure(
        'dv-environment',
        'Environment settings',
        () =>
          `<section><div class="panel-heading"><h2>Environment settings</h2>${badge('Applies now', 'green')}</div>${panelHelp('dataverse.environment')}<p class="muted">Changes take effect on the next request, with no restart. Auditing and duplicate detection are organization settings; the others act on the Dataverse API.</p><form id="dv-environment-form" class="form-grid"><div><label class="checkbox-label"><input id="dv-env-auditing" type="checkbox" ${env.auditing ? 'checked' : ''}> Audit record changes</label><p class="field-help">Records create, update and delete changes in the audit table.</p></div><div><label class="checkbox-label"><input id="dv-env-duplicates" type="checkbox" ${env.duplicateDetection ? 'checked' : ''}> Duplicate detection</label><p class="field-help">Runs published duplicate detection rules on create and update.</p></div><div><label class="checkbox-label"><input id="dv-env-tds" type="checkbox" ${env.tdsEnabled ? 'checked' : ''}> Enable TDS endpoint</label><p class="field-help">TDS is the SQL Server protocol that SQL tools use to query Dataverse tables. Off keeps the listener, but every TDS login is refused.</p></div><div><label for="dv-env-plugin-timeout">Plug-in timeout (seconds)</label><input id="dv-env-plugin-timeout" type="number" min="1" max="3600" step="1" required value="${escape(String(env.pluginTimeoutSeconds))}">${kit.fieldHelp('dv-env-plugin-timeout', 'A plug-in step that runs longer fails with a timeout error.')}</div><div><label for="dv-env-requests">Requests per 300 seconds, per user</label><input id="dv-env-requests" type="number" min="1" step="1" value="${escape(env.requestsPer300s === null ? '' : String(env.requestsPer300s))}" placeholder="Off"><p class="field-help">Empty turns the limit off. Over the limit, Web API requests answer 429.</p></div><div class="toolbar"><button class="button primary" type="submit">Save environment settings</button></div></form><h3>Restart required</h3><p class="muted">Read when the Dataverse API starts. Change them in the mirage settings and restart.</p><div class="detail-list">${[
            ['Port (0 is ephemeral)', String(restart.port)],
            ['TLS', restart.tls ? 'On' : 'Off'],
            ['Tenant id', restart.tenantId],
            ['Organization id', restart.organizationId],
            ['Locale id', String(restart.localeId ?? '')],
            ['Base currency', restart.currencyCode],
          ]
            .map(
              ([label, text]) =>
                `<div class="row"><div class="row-title">${escape(label)}</div><div class="row-detail">${value(text)}</div></div>`,
            )
            .join('')}</div></section>`,
      )
    : '';
  const workflows = workflowsPanel(result.workflows ?? []);
  return (
    title +
    staffSessionPanel() +
    secretPanel +
    status +
    (result.enabled === false
      ? '<p class="notice">The organization core serves model-driven apps. Enable the HTTP API in <a href="/_setup/#runtime-configuration">Project setup</a> and restart for token-based integration clients.</p>'
      : connect) +
    applications +
    register +
    certificate +
    users +
    createUser +
    workflows +
    environment +
    federated +
    identities +
    requests +
    reset
  );
}
// Classic workflows: the run mode each one takes when it starts. XAML is never executed; the mock result is used by a mock run only.
const WORKFLOW_MODES = {
  handler: 'Pack handler, else placeholder',
  placeholder: 'Placeholder',
  mock: 'Mock result',
  disabled: 'Disabled',
};
function workflowsPanel(rows) {
  const triggerText = (row) =>
    [
      row.trigger.create ? 'create' : null,
      row.trigger.delete ? 'delete' : null,
      ...row.trigger.updateAttributes.map((name) => `update ${name}`),
    ]
      .filter(Boolean)
      .join(', ') || 'on demand only';
  const mockText = (row) =>
    JSON.stringify(
      row.override?.mode === 'mock'
        ? { status: row.override.status, message: row.override.message }
        : { status: 30, message: 'Simulator: mock workflow result.' },
      null,
      2,
    );
  const editing = rows.find((row) => row.workflowid === dataverseWorkflowEditing);
  const name = (row) => row.name ?? row.uniquename ?? row.workflowid;
  const editor = editing
    ? `<section class="panel section-gap" data-dv-workflow-editor="${escape(editing.workflowid)}"><div class="panel-heading"><h3>Run mode for ${escape(name(editing))}</h3><button class="button small quiet" type="button" data-dv-close-workflow>Close</button></div><form id="dv-workflow-${escape(editing.workflowid)}" class="form-grid" data-dv-workflow="${escape(editing.workflowid)}"><div><label for="dv-workflow-mode">Run mode for ${escape(name(editing))}</label><select id="dv-workflow-mode" aria-describedby="dv-workflow-mode-help">${Object.entries(
        WORKFLOW_MODES,
      )
        .map(
          ([mode, label]) =>
            `<option value="${mode}" ${(editing.override?.mode ?? 'handler') === mode ? 'selected' : ''}>${escape(label)}</option>`,
        )
        .join(
          '',
        )}</select>${kit.fieldHelp('dv-workflow-mode', 'Placeholder ends the job Canceled, a pack handler runs trusted code, mock returns the result below, disabled skips the workflow.')}</div><div><label for="dv-workflow-mock">Mock result as JSON for ${escape(name(editing))}</label><textarea id="dv-workflow-mock" class="code-editor" rows="3" spellcheck="false" aria-describedby="dv-workflow-mock-help">${escape(mockText(editing))}</textarea>${kit.fieldHelp('dv-workflow-mock', 'Used by mock runs only: { status, message }.')}</div><div><button class="button small" type="submit">Save run mode</button></div></form></section>`
    : '';
  const page = sliceRows('dv-workflows', rows, {
    text: (row) => `${name(row)} ${row.primaryentity ?? ''} ${row.processMode ?? ''}`,
  });
  const lines = page.items.map(
    (row) =>
      `<tr><td class="item-title">${escape(name(row))}<div class="row-detail"><code>${escape(row.workflowid)}</code></div></td><td>${escape(row.primaryentity ?? '')}<div class="row-detail">${badge(row.processMode)}${row.statecode === 1 ? '' : ` ${badge('Not activated', 'amber')}`}</div></td><td>${escape(triggerText(row))}</td><td>${escape(WORKFLOW_MODES[row.override?.mode ?? 'handler'])}</td><td class="actions"><button class="button small quiet" type="button" data-dv-edit-workflow="${escape(row.workflowid)}" aria-label="Edit run mode for ${escape(name(row))}">Edit</button></td></tr>`,
  );
  return disclosure(
    'dv-workflows',
    `Workflows (${rows.length} classic)`,
    () =>
      `<section><div class="panel-heading"><h2>Workflows</h2>${badge(`${rows.length} classic`)}</div>${panelHelp('dataverse.workflows')}<p class="muted">Classic workflows of the Solution. Their XAML is never executed: a placeholder ends a background job Canceled, a pack handler runs the trusted code, and a mock returns the result above. Only the run mode changes here; the triggers come from the workflow.</p>${tableTools('dv-workflows', page.total, page.pages)}<div class="table-wrap"><table data-table="dv-workflows"><thead><tr><th>Workflow</th><th>Table and timing</th><th>Trigger</th><th>Run mode</th><th>Actions</th></tr></thead><tbody>${lines.join('') || '<tr><td colspan="5">No classic workflow in the Solution.</td></tr>'}</tbody></table></div>${editor}</section>`,
  );
}
const dvRoles = (form) => [...form.querySelectorAll('[data-dv-role]:checked')].map((input) => input.dataset.dvRole);
const dvGrants = (form) => [...form.querySelectorAll('[data-dv-grant]:checked')].map((input) => input.dataset.dvGrant);
const dvLines = (value) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
async function dataverseWrite(path, options, done) {
  const result = await request(path, options);
  if (capabilities().modelDriven !== false) await loadStaffSession();
  await loadDataverse();
  if (done) notify(done);
  return result;
}
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!/^dv-/.test(form.id ?? '')) return;
  event.preventDefault();
  const button = event.submitter;
  if (!setButtonPending(button, true)) return;
  try {
    if (form.id === 'dv-app-form') {
      const created = await dataverseWrite('/dataverse/applications', {
        method: 'POST',
        body: JSON.stringify({
          displayName: $('#dv-app-name').value.trim(),
          ...($('#dv-app-id').value.trim() ? { appId: $('#dv-app-id').value.trim() } : {}),
          roles: dvRoles(form),
          allowedGrants: dvGrants(form),
          publicClient: $('#dv-app-public').checked,
          redirectUris: dvLines($('#dv-app-redirect').value),
        }),
      });
      dataverseSecret = { label: `Client secret for ${created.appId}`, secret: created.secret };
      drafts.delete(form.id);
      render();
      notify('Application registered. Copy the secret now.');
    } else if (form.id === 'dv-user-form') {
      const password = $('#dv-user-password').value;
      await dataverseWrite(
        '/dataverse/users',
        {
          method: 'POST',
          body: JSON.stringify({
            fullname: $('#dv-user-name').value.trim(),
            domainname: $('#dv-user-domain').value.trim(),
            ...($('#dv-user-object').value.trim() ? { objectId: $('#dv-user-object').value.trim() } : {}),
            roles: dvRoles(form),
            ...(password ? { password } : {}),
          }),
        },
        'User created.',
      );
      drafts.delete(form.id);
      render();
    } else if (form.id === 'dv-cert-form') {
      const pem = $('#dv-cert-pem').value;
      const payload = /-----BEGIN CERTIFICATE-----/.test(pem) ? { certificatePem: pem } : { publicKeyPem: pem };
      await dataverseWrite(
        `/dataverse/applications/${encodeURIComponent($('#dv-cert-app').value)}/certificates`,
        { method: 'POST', body: JSON.stringify(payload) },
        'Certificate added.',
      );
      drafts.delete(form.id);
      render();
    } else if (form.dataset.dvEditForm) {
      const appId = form.dataset.dvEditForm;
      await dataverseWrite(
        `/dataverse/applications/${encodeURIComponent(appId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            displayName: $('#dv-edit-name').value.trim(),
            allowedGrants: dvGrants(form),
            publicClient: $('#dv-edit-public').checked,
            redirectUris: dvLines($('#dv-edit-redirect').value),
          }),
        },
        'Application saved.',
      );
      dataverseEditing = null;
      drafts.delete(form.id);
      render();
    } else if (form.id === 'dv-federated-form') {
      let jwks;
      try {
        jwks = JSON.parse($('#dv-fed-jwks').value);
      } catch {
        throw new Error('The issuer JWKS must be valid JSON.');
      }
      await dataverseWrite(
        `/dataverse/applications/${encodeURIComponent($('#dv-fed-app').value)}/federated-credentials`,
        {
          method: 'POST',
          body: JSON.stringify({
            issuer: $('#dv-fed-issuer').value.trim(),
            subject: $('#dv-fed-subject').value.trim(),
            audiences: [$('#dv-fed-audience').value.trim()],
            jwks,
          }),
        },
        'Federated credential added.',
      );
      drafts.delete(form.id);
      render();
    } else if (form.id === 'dv-identity-form') {
      const clientId = $('#dv-identity-client').value.trim();
      const principalId = $('#dv-identity-principal').value.trim();
      await dataverseWrite(
        '/dataverse/managed-identities',
        {
          method: 'POST',
          body: JSON.stringify({
            displayName: $('#dv-identity-name').value.trim(),
            ...(clientId ? { clientId } : {}),
            ...(principalId ? { principalId } : {}),
            roles: dvRoles(form),
          }),
        },
        'Managed identity added.',
      );
      drafts.delete(form.id);
      render();
    } else if (form.id === 'dv-environment-form') {
      const requests = $('#dv-env-requests').value.trim();
      await dataverseWrite(
        '/dataverse/environment',
        {
          method: 'PATCH',
          body: JSON.stringify({
            auditing: $('#dv-env-auditing').checked,
            duplicateDetection: $('#dv-env-duplicates').checked,
            tdsEnabled: $('#dv-env-tds').checked,
            pluginTimeoutSeconds: Number($('#dv-env-plugin-timeout').value),
            requestsPer300s: requests ? Number(requests) : null,
          }),
        },
        'Environment settings saved.',
      );
    } else if (form.dataset.dvPassword) {
      const password = form.querySelector('input[type=password]').value;
      await dataverseWrite(
        `/dataverse/users/${encodeURIComponent(form.dataset.dvPassword)}`,
        { method: 'PATCH', body: JSON.stringify({ password }) },
        'Password set.',
      );
    } else if (form.dataset.dvUser) {
      await dataverseWrite(
        `/dataverse/users/${encodeURIComponent(form.dataset.dvUser)}`,
        { method: 'PATCH', body: JSON.stringify({ roles: dvRoles(form) }) },
        'Roles saved.',
      );
      drafts.delete(form.id);
      render();
    } else if (form.dataset.dvWorkflow) {
      const mode = form.querySelector('select').value;
      let mock;
      if (mode === 'mock') {
        try {
          mock = JSON.parse(form.querySelector('textarea').value);
        } catch {
          throw new Error('The mock result must be valid JSON.');
        }
      }
      await dataverseWrite(
        `/dataverse/workflows/${encodeURIComponent(form.dataset.dvWorkflow)}`,
        { method: 'PATCH', body: JSON.stringify({ mode, ...(mock ? { mock } : {}) }) },
        'Run mode saved.',
      );
    }
  } catch (error) {
    setButtonPending(button, false, true);
    notify(error.message, true);
  } finally {
    if (button) setButtonPending(button, false);
  }
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const data = target.dataset;
  if (data.action === 'reload-dataverse') return loadDataverse();
  if (data.action === 'dismiss-dataverse-secret') {
    dataverseSecret = null;
    return render();
  }
  if (data.dvEditApp !== undefined) {
    dataverseEditing = data.dvEditApp;
    return render();
  }
  if (data.dvCancelEdit !== undefined) {
    dataverseEditing = null;
    return render();
  }
  if (data.dvEditUser !== undefined || data.dvCloseUser !== undefined) {
    dataverseUserEditing = data.dvEditUser ?? null;
    return render();
  }
  if (data.dvEditWorkflow !== undefined || data.dvCloseWorkflow !== undefined) {
    dataverseWorkflowEditing = data.dvEditWorkflow ?? null;
    return render();
  }
  if (
    data.dvAddSecret === undefined &&
    data.dvDeleteSecret === undefined &&
    data.dvToggleUser === undefined &&
    data.dvRemoveApp === undefined &&
    data.dvRemoveCert === undefined &&
    data.dvRemoveFederated === undefined &&
    data.dvRemoveIdentity === undefined &&
    data.dvClearPassword === undefined
  )
    return;
  if (data.dvRemoveApp !== undefined)
    return askConfirmation(
      'Remove application?',
      `Remove ${data.dvName} and its application user. Tokens already issued stop working.`,
      async () => {
        await dataverseWrite(
          `/dataverse/applications/${encodeURIComponent(data.dvRemoveApp)}`,
          { method: 'DELETE' },
          'Application removed.',
        );
      },
      'Remove application',
    );
  if (data.dvRemoveIdentity !== undefined)
    return askConfirmation(
      'Remove managed identity?',
      `Remove ${data.dvName} and its application user.`,
      async () => {
        await dataverseWrite(
          `/dataverse/managed-identities/${encodeURIComponent(data.dvRemoveIdentity)}`,
          { method: 'DELETE' },
          'Managed identity removed.',
        );
      },
      'Remove managed identity',
    );
  if (!setButtonPending(target, true)) return;
  try {
    if (data.dvAddSecret !== undefined) {
      const created = await dataverseWrite(`/dataverse/applications/${encodeURIComponent(data.dvAddSecret)}/secrets`, {
        method: 'POST',
        body: '{}',
      });
      dataverseSecret = { label: `New client secret for ${data.dvAddSecret}`, secret: created.secret };
      render();
      notify('Secret added. Copy it now.');
    } else if (data.dvDeleteSecret !== undefined)
      await dataverseWrite(
        `/dataverse/applications/${encodeURIComponent(data.dvApp)}/secrets/${encodeURIComponent(data.dvDeleteSecret)}`,
        { method: 'DELETE' },
        'Secret removed.',
      );
    else if (data.dvToggleUser !== undefined)
      await dataverseWrite(
        `/dataverse/users/${encodeURIComponent(data.dvToggleUser)}`,
        { method: 'PATCH', body: JSON.stringify({ isdisabled: data.dvDisabled === 'true' }) },
        data.dvDisabled === 'true' ? 'User disabled.' : 'User enabled.',
      );
    else if (data.dvClearPassword !== undefined)
      await dataverseWrite(
        `/dataverse/users/${encodeURIComponent(data.dvClearPassword)}`,
        { method: 'PATCH', body: JSON.stringify({ password: null }) },
        'Password cleared.',
      );
    else if (data.dvRemoveCert !== undefined)
      await dataverseWrite(
        `/dataverse/applications/${encodeURIComponent(data.dvApp)}/certificates/${encodeURIComponent(data.dvRemoveCert)}`,
        { method: 'DELETE' },
        'Certificate removed.',
      );
    else if (data.dvRemoveFederated !== undefined)
      await dataverseWrite(
        `/dataverse/applications/${encodeURIComponent(data.dvApp)}/federated-credentials`,
        { method: 'DELETE', body: JSON.stringify({ issuer: data.dvIssuer, subject: data.dvSubject }) },
        'Federated credential removed.',
      );
  } catch (error) {
    setButtonPending(target, false, true);
    notify(error.message, true);
  } finally {
    setButtonPending(target, false);
  }
});

function renderView(view) {
  const module = moduleFor(view);
  if (module) {
    const load = moduleLoads.get(view),
      label = views.find(({ id }) => id === view)?.label ?? view;
    const failure = load?.error
      ? kit.notice(
          `${label} could not be loaded: ${load.error.message}${load.error.status ? ` (HTTP ${load.error.status})` : ''}. Use Refresh to try again.`,
          'bad',
        )
      : '';
    // The dashboard renders its own loading and error states from its poll.
    if (module.load && view !== 'dashboard' && !load?.loaded)
      return heading('') + (failure || `<p role="status" class="muted">Loading ${escape(label)}…</p>`);
    return failure + module.render(ctx);
  }
  switch (view) {
    case 'overview':
      return overview();
    case 'records':
      return records();
    case 'portal':
      return portal();
    case 'overrides':
      return portal(true);
    case 'platform':
      return platformRules();
    case 'endpoints':
      return configurationView('endpoints');
    case 'operations':
      return operations();
    case 'mappings':
      return configurationView('mappings');
    case 'plugins':
      return configurationView('plugins');
    case 'access':
      return access();
    case 'scenarios':
      return scenarios();
    case 'environment':
      return environment();
    case 'dataverse':
      return dataverse();
    case 'connection':
      return connection();
    case 'runtime':
      return runtimeState();
    case 'evidence':
      return evidence();
    case 'audit':
      return audit();
    case 'logs':
      return logs();
    default:
      return overview();
  }
}

function render() {
  const focused = document.activeElement;
  const focusKey =
    focused?.id && $('#content').contains(focused)
      ? `#${CSS.escape(focused.id)}`
      : focused?.dataset?.tableSearch
        ? `[data-table-search="${CSS.escape(focused.dataset.tableSearch)}"]`
        : null;
  const selection = {
    start: focused?.selectionStart,
    end: focused?.selectionEnd,
    direction: focused?.selectionDirection,
  };
  const scroll = { top: focused?.scrollTop, left: focused?.scrollLeft };
  lazyValues.clear();
  const links = runtimeLinks();
  for (const [selector, key] of [
    ['#open-portal', 'powerPages'],
    ['#open-model-driven', 'modelDriven'],
  ]) {
    const anchor = $(selector);
    if (anchor) {
      anchor.hidden = key === 'powerPages' ? !powerPages() : capabilities().modelDriven === false;
      if (links[key]) anchor.href = links[key];
    }
  }
  // One product, two areas: the wordmark stays Paqvilo; the small line names the area and the host flavour.
  const kind = $('#workspace-kind');
  if (kind) kind.textContent = `SIMULATOR WORKSPACE · ${powerPages() ? 'PORTAL' : 'MIRAGE'} STUDIO`;
  // Sidebar groups: collapsible, the active view's group always open.
  const available = availableViews();
  $('#navigation').innerHTML = [...NAV_GROUPS.map(([group]) => group)]
    .map((group) => {
      const items = available
        .filter(({ id }) => groupOf(id) === group)
        .sort(
          (a, b) =>
            (NAV_GROUPS.find(([name]) => name === group)[1].indexOf(a.id) + 1 || 99) -
            (NAV_GROUPS.find(([name]) => name === group)[1].indexOf(b.id) + 1 || 99),
        );
      if (!items.length) return '';
      const open = !collapsedGroups.has(group) || items.some(({ id }) => id === activeView);
      return `<details class="nav-group" data-nav-group="${escape(group)}"${open ? ' open' : ''}><summary>${escape(group)}</summary>${items.map(({ id, label, icon }) => `<a class="nav-item ${activeView === id ? 'active' : ''}" href="#${escape(id)}" ${activeView === id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${escape(icon)}</span>${escape(label)}</a>`).join('')}</details>`;
    })
    .join('');
  $('#breadcrumb').textContent = viewLabel(activeView);
  const crumbGroup = $('#breadcrumb-group');
  if (crumbGroup) crumbGroup.textContent = groupOf(activeView);
  document.title = `${viewLabel(activeView)} · Paqvilo simulator workspace`;
  $('#content').innerHTML = renderView(activeView);
  if (activeView === 'connection' || activeView === 'mappings')
    $('#content').insertAdjacentHTML(
      'beforeend',
      richTextBaselines() + observedStylesheetBaselines() + snippetCompositionControls(),
    );
  if (personaCatalogue && ['access', 'scenarios'].includes(activeView))
    mountPersonaAdministration($('#content'), personaCatalogue, {
      request,
      refresh,
      notify,
      setButtonPending,
      session: browserSession,
      selectedKey: selectedPersonaKey,
      onSelected: (key) => {
        selectedPersonaKey = key;
      },
      onContact: (persona) => {
        selectedPersona = persona.contactId;
        render();
      },
    });
  moduleFor(activeView)?.mounted?.(ctx);
  for (const section of $('#content').querySelectorAll('details[data-ui-section]'))
    if (sectionState.has(section.dataset.uiSection)) section.open = sectionState.get(section.dataset.uiSection);
  restoreDrafts();
  for (const input of $('#content').querySelectorAll('[data-filter-target]')) applyListFilter(input);
  linkFieldHelp($('#content'));
  syncConfinement();
  restorePendingScopes();
  if (focusKey) {
    const replacement = $('#content').querySelector(focusKey);
    // Lazy data can arrive between focus and the next keystroke, before an input event saves a
    // draft. Keep editing in the replacement control without moving the operator's viewport.
    replacement?.focus({ preventScroll: true });
    if (
      typeof replacement?.setSelectionRange === 'function' &&
      typeof replacement.selectionStart === 'number' &&
      typeof selection.start === 'number' &&
      typeof selection.end === 'number'
    ) {
      try {
        replacement.setSelectionRange(selection.start, selection.end, selection.direction);
      } catch {
        /* A changed control type may no longer support text selection. */
      }
      replacement.scrollTop = scroll.top;
      replacement.scrollLeft = scroll.left;
    }
  }
  land();
}

async function openEditor(name, id) {
  if (name === 'records' && recordAccess()[id === undefined ? 'create' : 'update'] === false) {
    notify(recordAccess().reason ?? 'This table has no declared pack DATA owner and is read-only.', true);
    return;
  }
  let item;
  let help;
  let title;
  if (name === 'portal-access-rules') {
    const existing = (accessRules ?? []).find((row) => row.id === id);
    if (id !== undefined && !existing) {
      notify('This page access rule is not available. Refresh the workspace.', true);
      return;
    }
    item =
      id === undefined
        ? {
            id: crypto.randomUUID(),
            value: {
              name: 'Local page rule',
              webPageId: state.status?.pages?.[0]?.id ?? '',
              right: 2,
              scope: 1,
              roleIds: [],
            },
          }
        : { id, value: existing.value };
    title = `${id === undefined ? 'Add' : 'Edit'} page access rule`;
    help = `right 1 grants change (and read) to the roles on that page branch; right 2 restricts reading the branch to the roles. scope 1 covers all content, scope 2 excludes direct child web files. webPageId and roleIds are exported IDs (roles: ${(state.status?.webRoles || []).map((role) => `${role.name}=${role.id}`).join(', ') || 'none'}). A null value removes the rule locally; Reset restores the export.`;
    editContext = { name, id };
  } else if (name === 'environment-variable') {
    const variable = environmentResult?.environmentVariables?.definitions?.find((entry) => entry.schemaName === id);
    if (!variable) {
      notify('This environment variable is not available. Refresh the environment.', true);
      return;
    }
    item = { value: variable.value ?? variable.defaultValue ?? '' };
    title = `Set ${id}`;
    help =
      'Set the local current value as text. A null value removes the local value so the definition default applies.';
    editContext = { name, id };
  } else if (['portal-settings', 'portal-snippets', 'portal-roles'].includes(name)) {
    const key =
      name === 'portal-settings' ? 'portalSettings' : name === 'portal-roles' ? 'portalRoles' : 'portalSnippets';
    const existing = (config()[key] ?? []).find((row) => row.id === id);
    item =
      id === undefined
        ? name === 'portal-roles'
          ? {
              id: crypto.randomUUID(),
              value: { name: 'Local role', authenticatedUsersRole: false, anonymousUsersRole: false },
            }
          : { name: '', value: '' }
        : { name: existing?.name, value: existing?.value };
    title = `${id === undefined ? 'Add' : 'Edit'} ${name === 'portal-settings' ? 'site setting' : name === 'portal-roles' ? 'web role' : 'content snippet'}`;
    help =
      name === 'portal-roles'
        ? 'Edit the role name and automatic membership flags inside value. Null removes the role locally. Imported permission/page rules and contact memberships resolve these roles by ID; reset restores the source.'
        : 'Enter name and string value. A null value removes this value locally. Reset restores the exported source. Snippets support Liquid. Local overrides persist across source reloads.';
    editContext = { name, id };
  } else if (name === 'shellProfile') {
    item = config().shellProfile || {};
    title = 'Edit portal shell profile';
    help =
      'Set stylesheets, headScripts, and bodyScripts arrays in the observed live resource order. Use portal-relative paths or HTTP(S) URLs. Script entries can be objects with src and defer. An empty object keeps the default shell resource selection. Example: {"stylesheets":["/bootstrap.min.css","/theme.css"],"headScripts":["/jquery.min.js"],"bodyScripts":[]}.';
    editContext = { name, configField: true };
  } else if (name === 'componentSchemas') {
    item = config().componentSchemas || {};
    title = 'Edit form & view schemas';
    help =
      'Key each schema by the exported form or list name or ID. Example: {"Contact form":{"entity":"contact","title":"Contact","fields":[{"name":"firstname","label":"First name","type":"text","required":true}]}}. List schemas use the same entity and fields, with optional query parameters. Explicit schemas enable simulation; they do not prove the live layout matches.';
    editContext = { name, configField: true };
  } else if (name === 'records') {
    const mapping = collection('mappings').find((entry) => (entry.logicalName || entry.entity) === selectedEntity);
    const idColumn = mapping?.idColumn || `${selectedEntity}id`;
    item =
      id === undefined
        ? { [idColumn]: crypto.randomUUID() }
        : (recordResult?.items || state.data?.[selectedEntity] || []).find(
            (record) => String(record[idColumn] ?? record.id) === id,
          );
    title = `${id === undefined ? 'Create' : 'Edit'} ${selectedEntity} record`;
    help =
      'Edit local field values as JSON, even when live routing is selected. Backend plugin rules apply. Admin edits bypass portal table permissions; test role access through the portal.';
    editContext = { name, id, entity: selectedEntity };
  } else {
    const def = definitions[name];
    item = id === undefined ? def.sample() : collection(name).find((entry) => String(entry.id) === id);
    title = `${id === undefined ? 'Add' : 'Edit'} ${name === 'presets' ? 'preset' : name.slice(0, -1)}`;
    help = def.help;
    editContext = { name, id };
  }
  if (name === 'presets' && id !== undefined) {
    try {
      item = await request(`/presets/${encodeURIComponent(id)}`);
    } catch (error) {
      notify(error.message, true);
      return;
    }
  }
  if (!item) {
    notify('This item is no longer available. Refresh the workspace.', true);
    return;
  }
  $('#editor-title').textContent = title;
  $('#editor-category').textContent = name === 'records' ? 'LOCAL DATA' : 'CONFIGURATION';
  $('#editor-description').textContent = help;
  $('#editor-json').value = json(item);
  $('#editor-error').hidden = true;
  $('#editor').showModal();
  $('#editor-json').focus();
}

function askConfirmation(title, message, action, label = 'Delete') {
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-submit').textContent = label;
  confirmAction = action;
  $('#confirm').showModal();
  $('#confirm-cancel').focus();
}

async function saveConfig(patch, { form } = {}) {
  await request('/config', { method: 'PATCH', body: JSON.stringify(patch) });
  // After a successful save the values come from the simulator; a failed save keeps the draft.
  if (form) drafts.delete(form);
  await refresh();
  notify('Configuration saved.');
}

document.addEventListener('click', async (event) => {
  const control = event.target.closest(
    '[data-platform-save],[data-platform-reset],[data-experiment],[data-portal-toggle]',
  );
  if (control) {
    event.preventDefault();
    if (!setButtonPending(control, true)) return;
    try {
      if (control.dataset.portalToggle) {
        await request('/' + control.dataset.portalKind + '/' + encodeURIComponent(control.dataset.portalToggle), {
          method: 'PATCH',
          body: JSON.stringify({ value: control.dataset.portalValue }),
        });
      } else if (control.dataset.platformSave) {
        const key = control.dataset.platformSave,
          d = config().platformSettings.find((d) => d.key === key),
          input = document.getElementById('platform-' + key);
        if (d.type === 'integer' && !input.value.trim()) throw new Error('Enter an integer or use source/default.');
        const value =
          d.type === 'integer' ? Number(input.value) : d.type === 'boolean' ? input.value === 'true' : input.value;
        await request('/platform-settings', { method: 'PATCH', body: JSON.stringify({ [key]: value }) });
      } else if (control.dataset.platformReset)
        await request('/platform-settings/' + encodeURIComponent(control.dataset.platformReset), { method: 'DELETE' });
      else {
        const action = control.dataset.experiment,
          id = $('#experiment-select').value,
          preset = selectedExperiment();
        if (action === 'apply')
          await request('/experiments/' + encodeURIComponent(id) + '/apply', { method: 'POST', body: '{}' });
        else if (action === 'delete') await request('/experiments/' + encodeURIComponent(id), { method: 'DELETE' });
        else if (action === 'save')
          await request('/experiments', {
            method: 'POST',
            body: JSON.stringify({
              id: $('#experiment-id').value,
              name: $('#experiment-name').value,
              platformOverrides: config().platformOverrides ?? {},
              portalOverrides: {
                settings: config().portalOverrides?.settings ?? {},
                snippets: config().portalOverrides?.snippets ?? {},
              },
            }),
          });
        else if (action === 'import')
          await request('/experiments', {
            method: 'POST',
            body: JSON.stringify(JSON.parse($('#experiment-import').value)),
          });
        else if (action === 'export') {
          if (!preset) throw new Error('Select a preset.');
          const { builtin, source, readOnly, shadowed, diagnostics, ...portable } = preset,
            url = URL.createObjectURL(new Blob([json(portable)], { type: 'application/json' })),
            a = document.createElement('a');
          a.href = url;
          a.download = id + '.json';
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          notify('Configuration preset exported.');
          return;
        }
      }
      await refresh();
      notify('Local configuration updated.');
    } catch (error) {
      setButtonPending(control, false, true);
      notify(error.message, true);
    } finally {
      setButtonPending(control, false);
    }
    return;
  }
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.operationReset) {
    if (!setButtonPending(target, true)) return;
    try {
      await saveOperation(target.dataset.operationReset, null);
      drafts.clear();
      await refresh();
      notify('Source operation default restored.');
    } catch (error) {
      setButtonPending(target, false, true);
      notify(error.message, true);
    } finally {
      setButtonPending(target, false);
    }
    return;
  }
  if (target.dataset.inspect !== undefined) {
    const value = lazyValues.get(target.dataset.inspect);
    $('#inspection-json').textContent = json(value);
    const correlated = $('#inspection-correlated');
    if (correlated) {
      correlated.hidden = !value?.correlationId;
      correlated.dataset.correlation = value?.correlationId ?? '';
    }
    $('#inspection').showModal();
    return;
  }
  if (target.id === 'inspection-correlated') {
    $('#inspection').close();
    const correlation = target.dataset.correlation;
    if (!correlation) return;
    if (activeView === 'audit') {
      auditFilters.correlationId = correlation;
      browserFor('audit').page = 1;
      await loadAudit();
    } else location.hash = `audit?correlationId=${encodeURIComponent(correlation)}`;
    return;
  }
  if (target.dataset.logEntry !== undefined) {
    const entry = logEntries.find(
      (item) =>
        String(item.sequence ?? '') === target.dataset.logEntry && String(item.time ?? '') === target.dataset.logTime,
    );
    if (!entry) return;
    $('#inspection-json').textContent = json(entry);
    const correlated = $('#inspection-correlated');
    if (correlated) {
      correlated.hidden = !entry.entry?.correlationId;
      correlated.dataset.correlation = entry.entry?.correlationId ?? '';
    }
    $('#inspection').showModal();
    return;
  }
  if (target.dataset.logAction) {
    const action = target.dataset.logAction;
    if (action === 'pause') {
      logPaused = !logPaused;
      if (!logPaused) {
        logEntries.unshift(...pausedLogs.slice().reverse());
        pausedLogs.length = 0;
        if (logEntries.length > 500) logEntries.length = 500;
      }
      render();
    } else if (action === 'clear') {
      logEntries.length = 0;
      pausedLogs.length = 0;
      scheduleLogs();
    } else {
      try {
        await navigator.clipboard.writeText(json(filteredLogs()));
        notify('Filtered log copied.');
      } catch (error) {
        notify(error.message, true);
      }
    }
    return;
  }
  if (target.dataset.copyText !== undefined) {
    try {
      await navigator.clipboard.writeText(target.dataset.copyText);
      notify('Copied.');
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.id === 'inspection-close') {
    $('#inspection').close();
    return;
  }
  if (target.id === 'inspection-copy') {
    try {
      await navigator.clipboard.writeText($('#inspection-json').textContent);
      notify('Request details copied.');
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.tablePage) {
    browserFor(target.dataset.tablePage).page += Number(target.dataset.delta);
    if (target.dataset.tablePage === 'audit') await loadAudit();
    else if (target.dataset.tablePage === 'records' && state.summaryMode) await loadRecords();
    else render();
    return;
  }
  if (target.dataset.auditAction) {
    const action = target.dataset.auditAction;
    if (action === 'refresh') {
      await loadAudit();
      return;
    }
    if (action === 'uncorrelate') {
      auditFilters.correlationId = '';
      browserFor('audit').page = 1;
      await loadAudit();
      return;
    }
    if (action === 'clear') {
      askConfirmation(
        'Clear request audit?',
        'Remove retained diagnostic activity from this simulator session.',
        async () => {
          await request('/audit/clear', { method: 'POST', body: '{}' });
          browserFor('audit').page = 1;
          await loadAudit();
        },
        'Clear audit',
      );
      return;
    }
    try {
      const exported = await request('/audit/export?' + new URLSearchParams(activeAuditFilters())),
        content = json(exported);
      if (action === 'copy') {
        await navigator.clipboard.writeText(content);
        notify('Filtered audit copied.');
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json' })),
          link = document.createElement('a');
        link.href = url;
        link.download = 'simulator-audit.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.applyScenario) {
    const id = target.dataset.applyScenario;
    const scenario = collection('scenarios').find((item) => item.id === id);
    askConfirmation(
      'Apply this scenario?',
      `${scenario?.preset ? `Preset ${scenario.preset} replaces the local data it defines, then ` : ''}the persona and permission settings of “${scenario?.name ?? id}” apply in one change. Open portal pages reload.`,
      async () => {
        // The scenario applies first (its preset can create the persona). A scenario persona
        // (null = anonymous) then signs this browser in or out through the portal, which comes
        // back to this view.
        const persona = Boolean(scenario && scenario.persona !== undefined);
        const contactId = scenario?.persona?.contactId ?? null;
        await request(`/scenarios/${encodeURIComponent(id)}/apply`, {
          method: 'POST',
          body: '{}',
        });
        await refresh();
        const current = browserSession?.signedIn ? browserSession.contactId : null;
        if (persona && personaId(current) !== personaId(contactId)) {
          notify(
            `Scenario applied. ${contactId ? 'Signing this browser in as its persona' : 'Signing this browser out'} through the portal ...`,
          );
          if (contactId) await signInThroughPortal(contactId);
          else signOutThroughPortal();
          return;
        }
        notify(persona ? `Scenario applied. ${sessionSummary()}.` : 'Scenario applied.');
      },
      'Apply scenario',
    );
    return;
  }
  if (target.dataset.referenceOrigin) {
    try {
      await request('/environment/reference', {
        method: 'POST',
        body: JSON.stringify({ origin: target.dataset.referenceOrigin }),
      });
      await refresh();
      notify('Reference origin selected for live routing. Connect its signed-in browser to read from it.');
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.resetVariable) {
    try {
      await request(`/environment/variables/${encodeURIComponent(target.dataset.resetVariable)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: null }),
      });
      await loadEnvironment();
      notify('Local value removed; the Solution value or definition default applies.');
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === 'reset-workspace') {
    askConfirmation(
      'Reset the workspace?',
      'Restore imported records, configuration, identity and permissions. Local records, overrides and rules are replaced; saved scenarios are kept. Open portal pages reload.',
      async () => {
        await request('/reset', { method: 'POST', body: '{}' });
        await refresh();
        notify('Workspace reset to imported defaults.');
      },
      'Reset workspace',
    );
    return;
  }
  if (target.dataset.action === 'reload-sources') {
    try {
      await request('/reload', { method: 'POST', body: '{}' });
      await refresh();
      notify('Sources reloaded.');
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === 'reload-environment') {
    await loadEnvironment();
    return;
  }
  if (target.dataset.action === 'export-state') {
    try {
      const exported = await request('/state/export');
      const url = URL.createObjectURL(new Blob([json(exported)], { type: 'application/json' })),
        link = document.createElement('a');
      link.href = url;
      link.download = 'simulator-state.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === 'persona-sign-in' || target.dataset.action === 'persona-sign-out') {
    const contactId =
      target.dataset.action === 'persona-sign-in' ? personaId($('#persona-contact')?.value) || null : null;
    if (target.dataset.action === 'persona-sign-in' && !contactId) return;
    try {
      await request('/personas/select', {
        method: 'POST',
        body: JSON.stringify({ contactId }),
      });
      await refresh();
      notify(
        contactId
          ? 'The sign-in page now offers the selected contact first.'
          : 'The sign-in page offers no default persona.',
      );
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === 'session-sign-in' || target.dataset.action === 'session-sign-out') {
    const signIn = target.dataset.action === 'session-sign-in';
    const contactId = signIn ? personaId($('#session-contact')?.value) || null : null;
    if (signIn && !contactId) return;
    try {
      const provider = signInProvider();
      notify(
        signIn
          ? `Signing in through ${provider ? provider.caption || provider.name || 'the identity provider' : 'the local sign-in page'} ...`
          : 'Signing out through the portal ...',
      );
      if (signIn) await signInThroughPortal(contactId);
      else signOutThroughPortal();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.action === 'session-override-clear') {
    try {
      await setSessionRoles(null);
      notify("The simulation override is cleared: the session uses the contact's web roles again.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (target.dataset.operationSelect) {
    selectedOperation = target.dataset.operationSelect;
    openDisclosures.add('operation-edit');
    drafts.clear();
    render();
    document.querySelector('[data-disclosure="operation-edit"]')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (target.dataset.action === 'live-disconnect') {
    if (!setButtonPending(target, true)) return;
    try {
      await request('/live/disconnect', { method: 'POST', body: '{}' });
      await refresh();
      notify('Authenticated browser disconnected. Live routing stays configured until you change it.');
    } catch (error) {
      setButtonPending(target, false, true);
      notify(error.message, true);
    } finally {
      setButtonPending(target, false);
    }
    return;
  }
  if (target.dataset.view) location.hash = target.dataset.view;
  if (target.dataset.action === 'retry') await refresh();
  if (target.dataset.add) await openEditor(target.dataset.add);
  if (target.dataset.edit) await openEditor(target.dataset.edit, target.dataset.id);
  if (target.dataset.delete) {
    const { delete: name, id } = target.dataset;
    const entity = selectedEntity;
    const reset = ['portal-settings', 'portal-snippets', 'portal-roles', 'portal-access-rules'].includes(name);
    askConfirmation(
      reset ? 'Reset local override?' : `Delete ${name === 'records' ? 'record' : 'configuration item'}?`,
      reset ? `Reset ${id} to its exported source value?` : `Delete ${id}? This removes it from the local simulator.`,
      async () => {
        await request(
          `/${name === 'records' ? `records/${encodeURIComponent(entity)}` : name}/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
        await refresh();
        notify('Item deleted.');
      },
    );
  }
  if (target.dataset.apply || target.hasAttribute('data-apply-selected')) {
    const id = target.dataset.apply || $('#available-preset').value;
    const applyConfiguration = $('#preset-apply-configuration')?.checked === true;
    askConfirmation(
      'Apply this preset?',
      'The preset will update simulator records and configuration according to its definition.',
      async () => {
        try {
          await request(`/presets/${encodeURIComponent(id)}/apply`, {
            method: 'POST',
            body: JSON.stringify({ applyConfiguration }),
          });
        } catch (error) {
          if (error.details?.error?.code?.startsWith('PACK_CONFIGURATION_PRESET_LINK')) {
            await refresh();
            if ($('#available-preset')) $('#available-preset').value = id;
            if ($('#preset-apply-configuration')) $('#preset-apply-configuration').checked = applyConfiguration;
          }
          throw error;
        }
        await refresh();
        notify('Preset applied.');
      },
      'Apply preset',
    );
  }
});

/** Confinement exceptions look and act disabled while local pages are not confined. */
function syncConfinement() {
  const toggle = $('#confine-portal-pages'),
    options = $('#confinement-options');
  if (!toggle || !options) return;
  options.disabled = !toggle.checked;
  options.classList.toggle('is-off', !toggle.checked);
}
document.addEventListener('change', (event) => {
  if (event.target.id === 'deployment-profile-id') {
    const sources =
      environmentResult?.profileSelection?.profiles.find((profile) => profile.id === event.target.value)?.sources ?? {};
    for (const control of document.querySelectorAll('[data-profile-section]')) {
      control.checked =
        Boolean(sources[control.dataset.profileSection]) &&
        (environmentResult.profileSelection.defaults[control.dataset.profileSection] ?? true);
      control.disabled =
        !sources[control.dataset.profileSection] ||
        environmentResult.profileSelection.required.includes(control.dataset.profileSection);
    }
  }
  if (event.target.id === 'confine-portal-pages') syncConfinement();
  if (event.target.id === 'session-contact') {
    contactChosen('session-contact', event.target.value);
    return;
  }
  if (event.target.dataset.contactLookup) return;
  if (event.target.dataset.logFilter === 'type') {
    logFilters.type = event.target.value;
    scheduleLogs();
    return;
  }
  if (event.target.id === 'state-import-file') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    file.text().then((text) =>
      askConfirmation(
        'Import this state?',
        `Replace the whole local workspace state with ${file.name}? Saved scenarios are kept; open portal pages reload.`,
        async () => {
          await request('/state/import', { method: 'POST', body: text });
          await refresh();
          notify('State imported.');
        },
        'Import state',
      ),
    );
    return;
  }
  if (event.target.id === 'enrichment-file') {
    const file = event.target.files?.[0];
    if (file)
      file.text().then((text) => {
        $('#enrichment-plan').value = text;
        rememberDraft($('#enrichment-plan'));
      });
    return;
  }
  if (event.target.dataset.tableSize) {
    browserFor(event.target.dataset.tableSize).size = Number(event.target.value);
    browserFor(event.target.dataset.tableSize).page = 1;
    if (event.target.dataset.tableSize === 'audit') loadAudit();
    else if (event.target.dataset.tableSize === 'records' && state.summaryMode) loadRecords();
    else render();
    return;
  }
  if (Object.hasOwn(auditFilters, event.target.dataset.auditFilter)) {
    auditFilters[event.target.dataset.auditFilter] = event.target.value;
    browserFor('audit').page = 1;
    loadAudit();
    return;
  }
  rememberDraft(event.target);
  if (event.target.id === 'persona-contact') contactChosen('persona-contact', event.target.value);
  if (event.target.hasAttribute('data-role-choice')) {
    const role = event.target.dataset.roleChoice;
    const values = new Set(
      $('#identity-roles')
        .value.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    if (event.target.checked) values.add(role);
    else values.delete(role);
    $('#identity-roles').value = [...values].join(', ');
    rememberDraft($('#identity-roles'));
  }

  if (event.target.id === 'entity-select') {
    selectedEntity = event.target.value;
    filter = '';
    browserFor('records').page = 1;
    recordResult = undefined;
    render();
    loadRecords();
  }
});
document.addEventListener('input', (event) => {
  if (event.target.dataset.filterTarget) {
    applyListFilter(event.target);
    return;
  }
  if (event.target.dataset.contactLookup) {
    contactLookupInput(event.target);
    return;
  }
  if (event.target.dataset.logFilter === 'search') {
    logFilters.search = event.target.value;
    scheduleLogs();
    return;
  }
  if (event.target.dataset.tableSearch) {
    const key = event.target.dataset.tableSearch,
      value = event.target.value;
    browserFor(key).search = value;
    browserFor(key).page = 1;
    render();
    const input = document.querySelector(`[data-table-search="${CSS.escape(key)}"]`);
    input.focus();
    return;
  }
  rememberDraft(event.target);
  if (event.target.id === 'identity-roles') {
    const values = new Set(
      event.target.value
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    document.querySelectorAll('[data-role-choice]').forEach((input) => {
      input.checked = values.has(input.dataset.roleChoice);
      rememberDraft(input);
    });
  }

  if (event.target.id === 'record-search') {
    const input = event.target;
    const position = input.selectionStart;
    filter = input.value;
    browserFor('records').page = 1;
    if (state.summaryMode) {
      loadRecords();
      return;
    }
    render();
    $('#record-search').focus();
    try {
      $('#record-search').setSelectionRange(position, position);
    } catch {
      /* Search inputs may not support selection ranges. */
    }
  }
});

$('#editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (!setButtonPending(button, true)) return;
  try {
    const body = JSON.parse($('#editor-json').value);
    if (!body || Array.isArray(body) || typeof body !== 'object')
      throw new Error('Enter a JSON object with named fields.');
    const { name, id, entity, configField } = editContext;
    if (name === 'mappings') {
      if (!body.logicalName) throw new Error('Mappings require a logicalName.');
      if ((body.id && body.id !== body.logicalName) || (id !== undefined && id !== body.logicalName))
        throw new Error('The mapping ID must equal its logicalName. To rename an entity, create a new mapping.');
      body.id = body.logicalName;
    }
    if (name === 'environment-variable') {
      if (body.value !== null && typeof body.value !== 'string')
        throw new Error('Enter a text value, or null to use the definition default.');
      await request(`/environment/variables/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: body.value }),
      });
      $('#editor').close();
      await loadEnvironment();
      notify('Environment variable saved.');
      return;
    }
    if (configField) {
      await request('/config', {
        method: 'PATCH',
        body: JSON.stringify({ [name]: body }),
      });
      $('#editor').close();
      await refresh();
      notify(name === 'shellProfile' ? 'Shell profile saved.' : 'Schemas saved.');
      return;
    }
    const path = `/${name === 'records' ? `records/${encodeURIComponent(entity)}` : name}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
    await request(path, {
      method: id === undefined ? 'POST' : 'PATCH',
      body: JSON.stringify(body),
    });
    $('#editor').close();
    await refresh();
    notify('Changes saved.');
  } catch (error) {
    setButtonPending(button, false, true);
    $('#editor-error').textContent = error.message;
    $('#editor-error').hidden = false;
  } finally {
    setButtonPending(button, false);
  }
});

$('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (!setButtonPending(button, true)) return;
  try {
    await confirmAction();
    $('#confirm').close();
  } catch (error) {
    setButtonPending(button, false, true);
    notify(error.message, true);
  } finally {
    setButtonPending(button, false);
  }
});
for (const selector of ['#editor-close', '#editor-cancel'])
  $(selector).addEventListener('click', () => $('#editor').close());
$('#confirm-cancel').addEventListener('click', () => $('#confirm').close());
$('#refresh').addEventListener('click', () => refresh({ announce: true }));
// Views that summarize live runtime state fetch it again when they are opened.
const FRESH_VIEWS = [
  'overview',
  'environment',
  'runtime',
  'evidence',
  ...modules.filter((module) => module.fresh).map((module) => module.id),
];
window.addEventListener('hashchange', () => {
  const { view, params } = parseHash();
  if (!availableViews().some(({ id }) => id === view)) {
    if (!powerPages() || view === 'dashboard') {
      activeView = 'overview';
      render();
      loadView().catch((error) => notify(error.message, true));
    }
    return;
  }
  const entered = view !== activeView;
  if (entered) {
    drafts.clear();
    dataverseSecret = null;
  }
  activeView = view;
  filter = '';
  if (entered || params.has('panel')) landing = { view, top: entered, panel: params.get('panel') };
  applyRoute(view, params);
  if (entered && FRESH_VIEWS.includes(view)) {
    refresh();
    return;
  }
  render();
  loadView().catch((error) => notify(error.message, true));
});

document.addEventListener(
  'toggle',
  (event) => {
    const detail = event.target;
    if (detail.open && detail.dataset?.lazyJson !== undefined) {
      const value = lazyValues.get(detail.dataset.lazyJson);
      detail.querySelector('pre').textContent = json(value);
    }
    if (detail.dataset?.uiSection) sectionState.set(detail.dataset.uiSection, detail.open);
    if (detail.dataset?.navGroup) {
      if (detail.open) collapsedGroups.delete(detail.dataset.navGroup);
      else collapsedGroups.add(detail.dataset.navGroup);
    }
    if (detail.dataset?.disclosure) {
      const key = detail.dataset.disclosure;
      if (detail.open) {
        openDisclosures.add(key);
        const body = detail.querySelector('[data-disclosure-body]');
        if (!body.children.length) {
          body.innerHTML = disclosureRenderers.get(key)?.() || '';
          restoreDrafts();
        }
      } else openDisclosures.delete(key);
    }
  },
  true,
);
document.addEventListener('submit', async (event) => {
  if (
    ![
      'identity-form',
      'connection-form',
      'live-connect-form',
      'snippet-composition-form',
      'asset-capture-form',
      'shell-capture-form',
      'persona-form',
      'permission-source-form',
      'scenario-form',
      'create-persona-form',
      'enrichment-form',
      'session-override-form',
      'deployment-profile-form',
    ].includes(event.target.id) &&
    !event.target.matches('form[data-operation-key]')
  )
    return;
  event.preventDefault();
  const button = event.submitter;
  if (!setButtonPending(button, true)) return;
  try {
    if (event.target.id === 'deployment-profile-form') {
      const pin =
        button.value === 'reset'
          ? null
          : {
              profile: $('#deployment-profile-id').value || null,
              enabled: Object.fromEntries(
                [...document.querySelectorAll('[data-profile-section]')].map((control) => [
                  control.dataset.profileSection,
                  control.checked,
                ]),
              ),
            };
      await request('/environment/profiles', { method: 'PUT', body: JSON.stringify(pin) });
      drafts.delete('deployment-profile-form');
      await refresh();
      environmentResult = await request('/environment');
      render();
      notify(pin ? 'Deployment profile pinned locally.' : 'Configured profile defaults restored.');
    } else if (event.target.matches('form[data-operation-key]')) {
      const form = event.target;
      await saveOperation(form.dataset.operationKey, {
        mode: form.elements.mode.value,
        status: Number(form.elements.status.value),
        body: JSON.parse(form.elements.body.value),
        ...(form.elements.steps ? { steps: JSON.parse(form.elements.steps.value) } : {}),
        ...(form.elements.localActivation?.checked ? { activation: 'local-enabled' } : {}),
      });
      drafts.delete(form.id);
      await refresh();
      notify('Local operation saved.');
    } else if (event.target.id === 'session-override-form') {
      const roles = $('#override-roles')
        .value.split(',')
        .map((role) => role.trim())
        .filter(Boolean);
      if (!roles.length) throw new Error('Enter at least one web role, or clear the override.');
      await setSessionRoles(roles);
      drafts.delete('session-override-form');
      notify(
        `Simulation override: ${browserSession.name || browserSession.contactId} has ${roles.join(', ')} in this browser.`,
      );
    } else if (event.target.id === 'identity-form') {
      await saveConfig(
        {
          permissionMode: $('#permission-mode').value,
          identity: {
            roleSource: 'override',
            id: $('#identity-id').value.trim(),
            contactId: $('#identity-id').value.trim(),
            name: $('#identity-name').value.trim(),
            accountId: $('#identity-account').value.trim(),
            roles: $('#identity-roles')
              .value.split(',')
              .map((role) => role.trim())
              .filter(Boolean),
          },
        },
        { form: 'identity-form' },
      );
    } else if (event.target.id === 'persona-form') {
      const contactId = personaId($('#persona-contact').value);
      const contactRoles = (state.status?.permissionModel?.memberships || config().contactRoles || []).filter(
        (assignment) => personaId(assignment.contactId) !== contactId,
      );
      document
        .querySelectorAll('[data-contact-role]:checked')
        .forEach((input) => contactRoles.push({ contactId, roleId: input.dataset.contactRole }));
      const patch = { contactRoles };
      if (button.value === 'select')
        patch.identity = {
          id: contactId,
          contactId,
          roleSource: 'memberships',
          roles: [],
        };
      await saveConfig(patch, { form: 'persona-form' });
    } else if (event.target.id === 'permission-source-form') {
      await saveConfig(
        {
          permissionSource: $('#permission-source').value,
          permissionMode: 'enforce',
        },
        { form: 'permission-source-form' },
      );
    } else if (event.target.id === 'connection-form') {
      const origin = $('#live-origin').value.trim();
      if (origin && !/^https?:\/\//i.test(origin)) throw new Error('Enter an HTTP or HTTPS environment origin.');
      const externalFrameOrigins = [
        ...new Set(
          $('#external-frame-origins')
            .value.split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => {
              let url;
              try {
                url = new URL(value);
              } catch {
                throw new Error('Online embedded content requires one exact HTTPS origin per line.');
              }
              if (
                url.protocol !== 'https:' ||
                url.username ||
                url.password ||
                url.pathname !== '/' ||
                url.search ||
                url.hash
              )
                throw new Error(
                  'Online embedded content requires exact HTTPS origins without credentials, paths, queries or fragments.',
                );
              return url.origin;
            }),
        ),
      ];
      await saveConfig(
        {
          mode: $('#data-mode').value,
          pageMode: $('#page-mode').value,
          confinePortalPages: $('#confine-portal-pages').checked,
          externalAssets: $('#external-assets').checked,
          externalFrameOrigins,
          live: {
            ...config().live,
            origin,
            fetchXmlPath: $('#fetchxml-path').value.trim() || null,
            // A runtime started without --allow-live-writes refuses true; its switch stays off.
            allowWrites: state.status?.liveWrites !== 'disabled' && $('#live-writes').checked,
          },
        },
        { form: 'connection-form' },
      );
    } else if (event.target.id === 'scenario-form') {
      const name = $('#scenario-name').value.trim();
      const id =
        $('#scenario-id').value.trim() ||
        name
          .toLowerCase()
          .replace(/[^\w.-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 80);
      const persona = $('#scenario-persona').value;
      const body = { id, name };
      if ($('#scenario-preset').value) body.preset = $('#scenario-preset').value;
      if (persona !== '__keep') body.persona = persona ? { contactId: persona } : null;
      if ($('#scenario-permission-mode').value) body.permissionMode = $('#scenario-permission-mode').value;
      await request('/scenarios', { method: 'POST', body: JSON.stringify(body) });
      drafts.delete('scenario-form');
      await refresh();
      notify('Scenario saved.');
    } else if (event.target.id === 'create-persona-form') {
      const signIn = $('#new-persona-select').checked;
      const created = await request('/personas', {
        method: 'POST',
        body: JSON.stringify({
          firstname: $('#new-persona-first').value.trim(),
          lastname: $('#new-persona-last').value.trim(),
          emailaddress1: $('#new-persona-email').value.trim(),
          accountId: $('#new-persona-account').value.trim(),
          roleIds: [...document.querySelectorAll('[data-new-persona-role]:checked')].map(
            (input) => input.dataset.newPersonaRole,
          ),
        }),
      });
      drafts.delete('create-persona-form');
      const contactId = created.contact?.contactid;
      if (contactId) selectedPersona = sessionPick = contactId;
      await refresh();
      if (signIn && contactId) {
        notify(
          `Persona ${created.contact?.fullname ?? ''} created; signing this browser in as it through the portal ...`,
        );
        await signInThroughPortal(contactId);
      } else notify(`Persona ${created.contact?.fullname ?? ''} created.`);
    } else if (event.target.id === 'enrichment-form') {
      let plan;
      try {
        plan = JSON.parse($('#enrichment-plan').value);
      } catch {
        throw new Error('The enrichment plan must be a JSON array of table queries.');
      }
      if (button.value === 'run') {
        askConfirmation(
          'Run this enrichment plan?',
          'The connected browser reads the listed records from the selected reference origin. Complete results replace or merge into local tables in one change; open portal pages reload.',
          async () => {
            try {
              enrichmentReport = await request('/reference/enrich', {
                method: 'POST',
                body: JSON.stringify({ plan }),
              });
            } catch (error) {
              enrichmentReport = error.details ?? { error: error.message };
              render();
              throw error;
            }
            await refresh();
            notify('Reference records imported into local state.');
          },
          'Run plan',
        );
      } else {
        try {
          enrichmentReport = await request('/reference/enrich/validate', {
            method: 'POST',
            body: JSON.stringify({ plan }),
          });
        } catch (error) {
          enrichmentReport = error.details ?? { error: error.message };
          render();
          throw error;
        }
        render();
        notify('The plan is valid. No reference reads were made.');
      }
    } else if (event.target.id === 'shell-capture-form') {
      const path = $('#shell-page-path').value.trim();
      shellCapturePath = path;
      managedControlPath = $('#managed-control-path').value.trim();
      if (!/^\/(?!\/)/.test(path) || path.includes('\\')) throw new Error('Enter a portal-relative page path.');
      try {
        shellCaptureResult = await request('/assets/capture-shell', {
          method: 'POST',
          body: JSON.stringify({
            path,
            managedControlPath: managedControlPath || undefined,
          }),
        });
      } catch (error) {
        shellCaptureResult = error.details?.report || error.details || { error: error.message };
        render();
        throw error;
      }
      drafts.delete(event.target.id);
      await refresh();
      notify(
        `Page shell ${shellCaptureResult.applied === false ? 'not replaced' : 'replaced'}. Captured ${shellCaptureResult.captured?.length ?? 0} static files.${shellCaptureResult.complete === false ? ' Dependencies remain incomplete; inspect the capture report.' : ''}`,
        shellCaptureResult.complete === false,
      );
    } else if (event.target.id === 'snippet-composition-form') {
      await request('/assets/capture-snippet-composition', {
        method: 'POST',
        body: JSON.stringify({
          path: $('#composition-page').value.trim(),
          parentName: $('#composition-parent').value.trim(),
          childName: $('#composition-child').value.trim(),
        }),
      });
      drafts.delete(event.target.id);
      await refresh();
      notify('Observed composition verified against both local snippets.');
    } else if (event.target.id === 'asset-capture-form') {
      const paths = $('#asset-paths')
        .value.split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (!paths.length || paths.some((item) => !/^\/(?!\/)/.test(item) || item.includes('\\')))
        throw new Error('Enter portal-relative static file paths, one per line.');
      const observingStylesheets = $('#observe-stylesheets')?.checked;
      if (observingStylesheets && paths.some((item) => !item.endsWith('.css')))
        throw new Error('Stylesheet observations require mapped CSS paths only.');
      const result = await request(observingStylesheets ? '/assets/capture-stylesheets' : '/assets/capture', {
        method: 'POST',
        body: JSON.stringify({ paths }),
      });
      drafts.delete(event.target.id);
      await refresh();
      const failures = result.failures || result.errors || [];
      const captured = result.captured?.length ?? (failures.length ? 0 : paths.length);
      notify(
        `Captured ${captured} files for ${paths.length} requested paths.${failures.length ? ` ${failures.length} failed: ${failures.map((item) => `${item.path || ''} ${item.message || item}`).join('; ')}` : ''}`,
        failures.length > 0,
      );
    } else {
      await request('/live/connect', {
        method: 'POST',
        body: JSON.stringify({ cdpUrl: $('#cdp-url').value.trim() }),
      });
      drafts.delete(event.target.id);
      await refresh();
      notify('Authenticated browser connected.');
    }
  } catch (error) {
    setButtonPending(button, false, true);
    notify(error.message, true);
  } finally {
    setButtonPending(button, false);
  }
});

// ---- Infrastructure dashboard: GET /__sim/api/dashboard, polled every 5 s while visible and active;
// Power Pages hosts also refetch on the SSE `reload` event. A 404 (older host) hides the view.
function dashboardModule() {
  let payload = null,
    previousActivity = null,
    problem = null,
    timer = 0,
    events = null,
    selected = null,
    preflight = null,
    preflightError = '',
    generation = 0;
  const history = []; // ring of earlier activity snapshots, oldest first (sparklines)
  // The open drawer's nodes and the node payload they show: a poll re-render re-attaches them unchanged, so
  // focus (restored by id in render()) and the drawer's scroll position survive while the node's facts did not change.
  let drawer = null;
  const route = '/_sim/api/dashboard';
  const active = () => activeView === 'dashboard';
  async function fetchPayload() {
    const mine = ++generation;
    try {
      const response = await fetch(`${API}/dashboard`, { cache: 'no-store', headers: { accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (mine !== generation) return;
      if (response.status === 404) {
        probes.set(probeUrl(route), false);
        stop();
        if (active()) location.hash = 'overview';
        return;
      }
      if (response.status === 503) problem = { starting: true };
      else if (!response.ok)
        problem = {
          error:
            typeof body.error === 'string'
              ? body.error
              : (body.error?.message ?? `The dashboard answered HTTP ${response.status}.`),
        };
      else {
        previousActivity = payload?.activity ?? null;
        if (previousActivity) {
          history.push(previousActivity);
          if (history.length > 12) history.shift();
        }
        payload = body;
        problem = null;
      }
    } catch (error) {
      if (mine === generation) problem = { error: error.message };
    }
    if (active()) render();
  }
  function stop() {
    clearInterval(timer);
    timer = 0;
    events?.close();
    events = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active() && timer) fetchPayload();
  });
  function preflightResult() {
    if (preflightError) return kit.notice(preflightError, 'bad');
    if (!preflight) return '';
    const summary = preflight.summary ?? {};
    const result = sliceRows('dashboard-preflight', preflight.requirements ?? [], {
      text: (item) => `${item.id} ${item.kind} ${item.status} ${item.message ?? ''}`,
    });
    return (
      kit.notice(
        `${summary.total ?? 0} requirements · ${summary.blocking ?? 0} blocking${preflight.scope?.strict ? ' (strict)' : ''}.`,
        summary.blocking ? 'bad' : 'ok',
      ) +
      kit.table({
        key: 'dashboard-preflight',
        result,
        caption: 'Preflight requirements',
        emptyText: 'No requirement matched.',
        columns: [
          { label: 'Requirement', render: (item) => `<code>${escape(item.id)}</code>` },
          { label: 'Kind', render: (item) => escape(item.kind ?? '') },
          {
            label: 'Status',
            render: (item) =>
              `${kit.badge(item.status, item.status === 'satisfied' ? 'ok' : item.blocking ? 'bad' : 'warn')}${item.blocking ? ` ${kit.badge('blocking', 'bad')}` : ''}`,
          },
          { label: 'Detail', render: (item) => escape(item.message ?? item.resolution?.level ?? '') },
        ],
      })
    );
  }
  function select(id, focusDrawer) {
    selected = id;
    render();
    if (focusDrawer) document.getElementById('dashboard-drawer')?.focus();
  }
  function close() {
    const id = selected;
    selected = null;
    render();
    document.querySelector(`[data-node="${CSS.escape(id ?? '')}"]`)?.focus();
  }
  function runPreflight(event) {
    event.preventDefault();
    const form = event.target,
      button = event.submitter;
    if (!setButtonPending(button, true)) return;
    const query = new URLSearchParams();
    for (const requirement of form.elements.requires.value.trim().split(/\s+/).filter(Boolean))
      query.append('requires', requirement);
    if (form.elements.strict.checked) query.set('strict', 'true');
    browserFor('dashboard-preflight').page = 1;
    request(`/preflight?${query}`)
      .then((report) => {
        preflight = report;
        preflightError = '';
        setButtonPending(button, false);
      })
      .catch((error) => {
        preflight = null;
        preflightError = error.message;
        setButtonPending(button, false, true);
        setButtonPending(button, false);
      })
      .finally(() => render());
  }
  return {
    id: 'dashboard',
    label: 'Infrastructure',
    icon: '◉',
    hosts: BOTH,
    requires: [route],
    async load() {
      if (!timer)
        timer = setInterval(() => {
          if (document.visibilityState === 'visible' && active()) fetchPayload();
        }, 5000);
      if (powerPages() && hasRoute('/_sim/events') && !events && typeof EventSource === 'function') {
        events = new EventSource('/__sim/events');
        events.addEventListener('reload', () => fetchPayload());
      }
      await fetchPayload();
    },
    leave: stop,
    render(context) {
      const head = `<div class="page-heading"><div><span class="eyebrow">${escape(groupOf('dashboard').toUpperCase())}</span><h1 id="view-title" tabindex="-1">Infrastructure</h1><p>What this runtime runs and how busy each part is, refreshed every 5 seconds while this page is visible. Select a part for its facts and the view that manages it.</p></div><button class="button" type="button" data-dashboard-refresh>Refresh now</button></div>`;
      const notices = problem?.starting
        ? kit.notice(
            'The runtime is still starting. This view keeps polling and fills in once the organization is ready.',
            'info',
          )
        : problem?.error
          ? kit.notice(problem.error, 'bad')
          : '';
      if (!payload)
        return head + notices + (problem ? '' : '<p role="status" class="muted">Loading the infrastructure map…</p>');
      return (
        head +
        notices +
        renderDashboard(payload, {
          mode: 'live',
          docs: context.docs(),
          previousActivity,
          history,
          help: HELP,
          kit,
          icons,
          pager: browserFor('dashboard-activity'),
        })
      );
    },
    mounted(context) {
      const node = payload?.nodes?.find((item) => item.id === selected);
      const slot = document.getElementById('dashboard-node-detail');
      const key = node ? JSON.stringify(node) : null;
      if (slot && node) {
        if (drawer?.key === key) slot.replaceChildren(...drawer.nodes);
        else {
          slot.innerHTML =
            renderNodeDetail(node, context.docs(), { kit, icons, payload }) +
            panelHelp('dashboard.drawer', 'these facts');
          // The drawer names the owning view by its sidebar label, so the link reads as the place it opens.
          for (const link of slot.querySelectorAll('.ui-drawer-actions a[href^="#"]'))
            link.textContent = `Open ${viewLabel(link.getAttribute('href').slice(1).split('?')[0])} →`;
          drawer = { key, nodes: [...slot.childNodes] };
        }
      }
      if (!node) {
        selected = null;
        drawer = null;
      }
      const result = document.getElementById('dashboard-preflight-result');
      if (result) result.innerHTML = preflightResult();
    },
    handle(context, event) {
      const node = event.target.closest?.('[data-node]');
      if (event.type === 'click' && node) {
        select(node.dataset.node, true);
        return true;
      }
      if (event.type === 'keydown' && node && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        select(node.dataset.node, true);
        return true;
      }
      if (event.type === 'keydown' && event.key === 'Escape' && selected) {
        close();
        return true;
      }
      if (event.type === 'click' && event.target.closest('[data-drawer-close]')) {
        close();
        return true;
      }
      if (event.type === 'click' && event.target.closest('[data-dashboard-refresh]')) {
        fetchPayload();
        return true;
      }
      if (event.type === 'submit' && event.target.id === 'dashboard-preflight') {
        runPreflight(event);
        return true;
      }
      return false;
    },
  };
}

applyRoute(activeView, parseHash().params);
await refresh();
