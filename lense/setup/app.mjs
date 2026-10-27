import * as kit from './ui-kit.mjs';
import { renderDashboard, renderNodeDetail } from './dashboard-map.mjs';
import * as icons from './dashboard-icons.mjs';
import { HELP } from './help-content.mjs';
import { PRODUCT_OF } from './dashboard-map.mjs';
import * as quickUi from './quick.mjs';

const $ = (selector) => document.querySelector(selector);
const esc = kit.escapeHtml;
let state,
  layer = 'shared',
  yamlLayer = null,
  dirty = false,
  pending = false,
  pendingFocus,
  firstRender = true;
// Same-origin runtime facts and the live dashboard feed; both degrade to configuration-only views.
let runtimeInfo = {},
  dashboard = null,
  dashboardError = '',
  previousActivity,
  nodeId = null;
const activityHistory = []; // earlier live activity snapshots, oldest first (sparklines)
const pagers = {},
  uiOpen = new Map(),
  specs = new Map();
let newRows = 0,
  nextSection = null;
// Two views of one page: Quick setup (plain-language steps to set up and run) and All settings (every key, by stage).
// A link to a section of All settings opens it; otherwise the last choice of this browser, Quick setup by default.
const ALL_SECTIONS = new Set([
  'overview',
  'system',
  'runtime-configuration',
  'portals',
  'packs',
  'environments',
  'personas',
  'providers',
  'identity',
  'settings',
  'advanced',
  'guidance',
]);
const storedView = () => {
  try {
    return localStorage.getItem('paqvilo-setup-view');
  } catch {
    return null;
  }
};
let view =
  ALL_SECTIONS.has(decodeURIComponent(location.hash.slice(1)).split('-')[0]) ||
  ALL_SECTIONS.has(decodeURIComponent(location.hash.slice(1))) ||
  storedView() === 'all'
    ? 'all'
    : 'quick';
// Quick setup state: found exports, running previews and the last preview operation, the step being changed.
let quick = null,
  preview = null,
  quickEditing = null,
  quickSite = null,
  restartHint = false,
  previewError = '',
  quickMapOpen = false,
  savedAt = 0;
const quickTarget = () => (state ? quickUi.targetOf(state, quickSite ?? state.settings?.defaultSite) : null);
const quickSession = () => {
  const target = quickTarget();
  return (preview?.sessions ?? []).find((item) => (target?.project ? true : item.site === target?.id)) ?? null;
};
const extraAttributes = (extra, hint) =>
  `${extra.id ? ` id="${esc(extra.id)}"${hint ? ` aria-describedby="${esc(extra.id)}-help"` : ''}` : ''}${extra.placeholder !== undefined && extra.placeholder !== null && extra.placeholder !== '' ? ` placeholder="${esc(extra.placeholder)}"` : ''}${extra.list ? ` list="${esc(extra.list)}"` : ''}`;
// Field guidance sits behind an (i) tooltip next to the label; with an id the tooltip stays the control's description.
const tip = (text, label, id) =>
  text ? kit.info({ id: id ? `${id}-help` : undefined, label: `About ${label}`, text }) : '';
const labelText = (label, hint, id) => `<span class="field-label">${esc(label)}${tip(hint, label, id)}</span>`;
const field = (label, name, value, hint = '', type = 'text', extra = {}) =>
  `<div><label${extra.id ? ` for="${esc(extra.id)}"` : ''}>${labelText(label, hint, extra.id)}<input name="${esc(name)}" type="${type}" value="${esc(value)}"${extraAttributes(extra, hint)}></label></div>`;
const area = (label, name, value, hint, id, className = '') =>
  `<div><label for="${esc(id)}">${labelText(label, hint, id)}<textarea id="${esc(id)}" name="${esc(name)}" aria-describedby="${esc(id)}-help"${className ? ` class="${className}"` : ''} spellcheck="false">${esc(value)}</textarea></label></div>`;
const check = (label, name, checked, id, hint = '') =>
  `<div><label class="checkbox-line" for="${esc(id)}"><input id="${esc(id)}" name="${esc(name)}" type="checkbox" ${checked ? 'checked' : ''}${hint ? ` aria-describedby="${esc(id)}-help"` : ''}>${esc(label)}</label>${tip(hint, label, id)}</div>`;
// One option builder: [value, text] pairs; the selected option compares as text.
const optionList = (pairs, chosen) =>
  pairs
    .map(
      ([value, text]) =>
        `<option value="${esc(value)}" ${String(value) === String(chosen ?? '') ? 'selected' : ''}>${esc(text)}</option>`,
    )
    .join('');
const choice = (label, name, values, chosen, id = '', hint = '') =>
  `<div><label${id ? ` for="${esc(id)}"` : ''}>${labelText(label, hint, id)}<select${id ? ` id="${esc(id)}"` : ''} name="${esc(name)}"${hint && id ? ` aria-describedby="${esc(id)}-help"` : ''}>${optionList(values, chosen)}</select></label></div>`;
const slug = (text) => String(text ?? '').replace(/[^a-zA-Z0-9-]+/g, '-');
const lines = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const identifier = (text) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(text) && !/^(?:constructor|prototype|__proto__)$/i.test(text);
const helpText = (key) => HELP[key]?.intro ?? '';
const catalogueDoc = (key) => state.settingsCatalogue?.find((item) => item.key === key)?.doc ?? '';
const fileName = (file) =>
  String(file ?? '')
    .split(/[\\/]/)
    .pop();
const adminUrl = () =>
  state.runtime?.links?.administration ??
  (state.runtime?.portalUrl && state.runtime.liveProxy
    ? new URL('/_sim/', state.runtime.portalUrl).href
    : !state.runtime && quickSession()?.ready
      ? (quickSession().adminUrl ?? new URL('/_sim/', quickSession().url).href)
      : '/_sim/');
// Setup and /_sim/ share an origin only when Mirage mounts this page itself (no separate portal URL, relative administration link).
const liveRuntime = () =>
  Boolean(state?.runtime?.product === 'Mirage' && !state.runtime.portalUrl && String(adminUrl()).startsWith('/'));
// Where the running preview's live views are read: /_sim/api on the same origin, else the setup server's read-only relay
// (`mirage dev` serves setup on its own port); null without a running Mirage preview.
// A preview found by Quick setup (no preview started this page) is read through the relay by its site.
const liveBase = () =>
  liveRuntime() ? '/_sim/api' : state?.runtime?.liveProxy || quickSession()?.ready ? '/_setup/api/runtime' : null;
const liveQuery = (query = new URLSearchParams()) => {
  if (!liveRuntime() && !state?.runtime?.liveProxy && quickSession()?.site) query.set('site', quickSession().site);
  return query.size ? `?${query}` : '';
};
// A data module registered by its path alone uses the id it declares; "id | path" names the id it must declare.
const packText = (list) =>
  (list ?? [])
    .map((item) => (typeof item === 'string' ? item : item.id ? `${item.id} | ${item.module}` : item.module))
    .join('\n');
function packLines(text) {
  const packs = lines(text).map((line) => {
    if (!line.includes('|')) return line;
    const [id, ...parts] = line.split('|'),
      module = parts.join('|').trim();
    if (!identifier(id.trim()) || !module)
      throw new Error('Write each sample data module as its file path, or as id | file path.');
    return { id: id.trim(), module };
  });
  const ids = packs.filter((item) => typeof item === 'object').map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('Each sample data module id may be used once.');
  return packs;
}
/** Push a set/delete edit when the next value differs from the previous one (undefined deletes). */
const update = (edits, path, next, previous) => {
  if (JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null))
    edits.push(next === undefined ? { op: 'delete', path } : { op: 'set', path, value: next });
};
const number = (text, label) => {
  if (text === '') return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  return value;
};
/** The (i) guidance of a section: its own intro plus the shared help entries (docs/setup.md stages) named by `keys`. */
function sectionHelp(title, intro, ...keys) {
  const entries = keys.map((key) => HELP[`setup.${key}`]).filter(Boolean);
  return kit.info({
    label: `About ${title}`,
    text: [intro, ...entries.map((entry) => entry.intro)].filter(Boolean).join(' '),
    steps: entries.flatMap((entry) => entry.steps ?? []),
    docs: [...new Set(entries.map((entry) => entry.doc).filter(Boolean))].map((doc) => kit.docLink(doc, state.docs)),
  });
}
const note = (text, label = 'More information') => kit.info({ label, text });
const SIMULATION_LEVELS = {
  'local-state': 'Older behaviour: a separate local state file',
  'dry-run': 'Keep changes only while it runs (dry run)',
  simulation: 'Save changes into the project data files',
  deep: 'Save data and table changes (advanced)',
};
const LEVEL_HELP =
  'What happens to records you add or change in the preview. Keep only while it runs: they reset when the preview restarts and your files never change. Save into the project data files: they are written to the data files of your sample data module. Data and table changes: also new tables and columns. Applies when the preview restarts.';
// What a target runs, in words: "Power Pages website, Model-driven apps".
const partsName = (siteId) => {
  const parts = quickUi.targetOf(state, siteId)?.parts ?? {};
  return (
    Object.entries(quickUi.PARTS)
      .filter(([key]) => parts[key])
      .map(([, item]) => item.title)
      .join(', ') || 'Nothing chosen'
  );
};
const optionText = (name, value) =>
  name === 'runtime-kind'
    ? runtimeName(value)
    : name === 'simulation-level'
      ? (SIMULATION_LEVELS[value] ?? value)
      : value;
const source = (site) =>
  `<div class="notice"><strong>${site.sourceStatus.format ? `Website export found (${esc(site.sourceStatus.layout?.dialect ?? site.sourceStatus.format)} format)` : site.sourceStatus.exists ? 'This folder holds no website export' : 'Website export folder not found'}</strong><p class="code-text source-path">${esc(site.sourceStatus.path || 'No source selected')}</p><span class="ui-badge ui-tone-neutral">${site.sourceStatus.git ? `Git branch ${esc(site.sourceStatus.git.branch)}, commit ${esc(site.sourceStatus.git.commit)}${site.sourceStatus.git.changed ? ' · uncommitted changes in this folder' : ''}` : ''}${site.sourceStatus.gitState === 'timeout' ? ' · Git status unavailable (timeout)' : site.sourceStatus.gitState === 'unavailable' ? ' · Git status unavailable' : !site.sourceStatus.git ? 'No committed Git checkout' : ''}</span></div>`;
function notice(message, error = false) {
  const node = $('#notice');
  node.hidden = false;
  node.className = `activity-feedback ${error ? 'error' : 'done'}`;
  node.setAttribute('role', error ? 'alert' : 'status');
  node.textContent = message;
  // A confirmation fades after a few seconds; errors stay until the next action.
  clearTimeout(notice.timer);
  if (!error && /^(Saved|Nothing|Preview|Created|Done)/.test(message))
    notice.timer = setTimeout(() => {
      if (node.textContent === message) node.hidden = true;
    }, 5000);
}
function beginOperation(message) {
  pending = true;
  pendingFocus = document.activeElement;
  const controls = [
    ...document.querySelectorAll('#content input, #content select, #content textarea, #content button, #refresh'),
  ].map((node) => [node, node.disabled]);
  for (const [node] of controls) node.disabled = true;
  $('#content').setAttribute('aria-busy', 'true');
  notice(message);
  $('#notice').className = 'activity-feedback pending';
  return () => {
    pending = false;
    pendingFocus = undefined;
    $('#content').removeAttribute('aria-busy');
    for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
  };
}
// A repaint (a save, a poll, the preview starting) never moves the page: what the reader looks at stays where it was.
// The anchor is the element with an id at 40% of the window height (left edge of the content), measured after `paint`
// has also restored open sections, so nothing above it changes height afterwards.
function keepPlace(paint) {
  const content = $('#content').getBoundingClientRect(),
    probe = document
      .elementFromPoint(content.left + 24, Math.round(window.innerHeight * 0.4))
      ?.closest('#content [id]');
  const anchor =
      probe && probe.id !== 'content'
        ? probe
        : [...document.querySelectorAll('#content > [id]')].find((node) => node.getBoundingClientRect().bottom > 80),
    id = anchor?.id,
    top = anchor?.getBoundingClientRect().top;
  paint();
  const again = id && document.getElementById(id);
  if (again) window.scrollBy(0, again.getBoundingClientRect().top - top);
}
// While a button is pressed, polls leave the page alone, so the click lands on the button that was pressed.
let pressing = false;
document.addEventListener(
  'pointerdown',
  () => {
    pressing = true;
  },
  true,
);
for (const type of ['pointerup', 'pointercancel'])
  document.addEventListener(
    type,
    () =>
      setTimeout(() => {
        pressing = false;
      }),
    true,
  );
function renderPreservingContext() {
  // Sections the user saw keep their open state; sections that appear for the first time take their default.
  const sections = [...document.querySelectorAll('#content details[data-section-key]')];
  const seen = new Set(sections.map((node) => node.dataset.sectionKey)),
    open = new Set(sections.filter((node) => node.open).map((node) => node.dataset.sectionKey));
  const focused = pendingFocus ?? document.activeElement,
    form = focused?.closest('form');
  const focus = form
    ? {
        type: form.dataset.form,
        site: form.dataset.site,
        key: form.dataset.key,
        name: focused.name,
        submit: focused.type === 'submit',
      }
    : null;
  const previousNext = nextSection;
  keepPlace(() => {
    render();
    for (const node of document.querySelectorAll('#content details[data-section-key]'))
      if (seen.has(node.dataset.sectionKey)) node.open = open.has(node.dataset.sectionKey);
    // When a save moves the next step to another stage, that stage opens.
    if (nextSection && nextSection !== previousNext) document.getElementById(nextSection)?.setAttribute('open', '');
  });
  if (focus) {
    const replacement = [...document.querySelectorAll('#content form')].find(
      (node) => node.dataset.form === focus.type && node.dataset.site === focus.site && node.dataset.key === focus.key,
    );
    const control = focus.submit
      ? replacement?.querySelector('button[type=submit]')
      : [...(replacement?.elements ?? [])].find((node) => node.name === focus.name);
    control?.focus({ preventScroll: true });
  }
}
async function request(url, options = {}) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 120_000);
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    const response = await fetch(url, { ...options, signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'Setup request failed.');
    return data;
  } catch (error) {
    if (deadline.signal.aborted)
      throw new Error(
        options.method && options.method !== 'GET'
          ? 'The configuration request timed out. Its result may be unknown; refresh and check the configuration before retrying.'
          : 'Loading configuration timed out. Try Refresh to reconnect.',
        { cause: error },
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function load() {
  if (pending) return;
  const finish = beginOperation(state ? 'Refreshing project configuration…' : 'Loading project configuration…');
  try {
    // A successful load needs no banner: the status strip shows the result; errors and saves still report in #notice.
    state = await request('/_setup/api/status');
    await Promise.all([loadQuick(), pollPreview(true)]);
    await loadRuntimeInfo();
    dirty = false;
    renderPreservingContext();
    $('#notice').hidden = true;
    if (firstRender) {
      firstRender = false;
      if (location.hash) reveal(decodeURIComponent(location.hash.slice(1)), true);
    }
  } catch (error) {
    notice(error.message, true);
  } finally {
    finish();
  }
  pollDashboard();
}
// Runtime lists for datalists and pack badges: only from the runtime serving this page; any failure leaves free text.
// ponytail: read once per status load (Refresh status rereads); poll them with the dashboard if presets or packs change while the page stays open.
async function loadRuntimeInfo() {
  const base = liveBase();
  if (!base) {
    runtimeInfo = {};
    return;
  }
  const get = (url) =>
    fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  const [status, packs] = await Promise.all([get(`${base}/status${liveQuery()}`), get(`${base}/packs${liveQuery()}`)]);
  runtimeInfo = { status, packs };
}
// The save notice follows the restart comparison: required, already matching, or unknown.
function savedNotice(runtime) {
  // A preview this page found running (started here or from a terminal) needs a restart to use the save.
  if (!runtime && quickSession()?.ready) return 'Saved. Restart the preview under Start & check to use it.';
  if (!runtime) return 'Saved. Your next preview will use these settings.';
  if (runtime.restartRequired === true)
    return `Saved. Restart the preview to apply configuration changes: ${runtime.restartCommand}`;
  if (runtime.restartRequired === false) return 'Saved. The running preview already matches this configuration.';
  return `Saved. The configuration could not be compared with the running preview (${runtime.restartReason}); restart it to be sure: ${runtime.restartCommand}`;
}
/** Saves through the validated configuration API; true when the save succeeded. */
async function save(payload) {
  if (pending) return false;
  const finish = beginOperation('Validating and saving configuration…');
  try {
    state = await request('/_setup/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': state.csrf },
      body: JSON.stringify({ layer, ...payload, revision: state.revision }),
    });
    dirty = false;
    savedAt = Date.now();
    if (!state.runtime && quickSession()?.ready) restartHint = true;
    renderPreservingContext();
    notice(view === 'quick' ? 'Saved.' : savedNotice(state.runtime));
    return true;
  } catch (error) {
    notice(error.message, true);
    return false;
  } finally {
    finish();
  }
}
// Opening a link inside the page: the target opens, scrolls to the top, briefly lights up and names itself in the breadcrumb,
// so it is clear where the link landed.
function reveal(id, scroll = false) {
  const target = id && document.getElementById(id);
  if (!target) return;
  for (let node = target.closest('details'); node; node = node.parentElement?.closest('details')) node.open = true;
  if (!scroll) return;
  target.scrollIntoView({ block: 'start' });
  const section = target.closest('details.stage, section.panel');
  const title = section?.querySelector('h2')?.textContent.trim();
  if (title && view === 'all')
    $('#breadcrumb').textContent =
      target === section
        ? title
        : `${title} › ${target.querySelector('h2, h3, legend, summary')?.textContent.trim() || 'section'}`;
  for (const node of document.querySelectorAll('.is-target')) node.classList.remove('is-target');
  void target.offsetWidth;
  target.classList.add('is-target');
}
const operation = (path, value) => ({ op: 'set', path, value });
const runtimeName = (kind) =>
  ({
    'power-pages': 'Power Pages + model-driven apps',
    'model-driven': 'Model-driven apps',
    'dataverse-api': 'Dataverse API only',
  })[kind] ?? kind;
const APP_HELP = 'Which of your model-driven apps opens first at /main.aspx. Leave it on the first app if unsure.';
function runtimeEditor(settings, site) {
  const runtime = settings.runtime ?? { kind: 'power-pages' },
    simulation = settings.simulation,
    key = site ? slug(site.id) : 'project';
  const parts = quickUi.targetOf(state, site?.id)?.parts ?? {};
  // Catalogue sites show effective values; keys that only defaults.mirage sets are named, so a site value is a deliberate override.
  const inherited = (name) =>
    site?.inherited?.[name]
      ? `<p class="muted small">Inherited from defaults.mirage; saving a different value sets this target's own ${esc(name)}.</p>`
      : '';
  const apps = runtimeApps(),
    chosen = runtime.defaultApp ?? '';
  const appOptions = [
    ['', 'The first app'],
    ...apps.map(([id, name]) => [id, name || id]),
    ...(chosen && !apps.some(([id]) => id === chosen) ? [[chosen, chosen]] : []),
  ];
  const appField = apps.length
    ? choice('Model-driven app that opens first', 'defaultApp', appOptions, chosen, `runtime-${key}-app`, APP_HELP)
    : field(
        'Model-driven app that opens first (optional)',
        'defaultApp',
        chosen,
        `${APP_HELP} Once the preview runs, this becomes a list of your apps; until then leave it empty.`,
        'text',
        { id: `runtime-${key}-app` },
      );
  // A project file with no website yet takes its first export here, when the website is ticked.
  const portalSource =
    state.kind === 'project' && !state.sites.length
      ? `<div class="inline-fields" data-portal-source ${parts.website ? '' : 'hidden'}>${field('Website name', 'portal-id', 'portal', 'A short name for the website in this project file: letters, numbers and hyphens.')}${withPick(field('Website export folder', 'portal-path', '', 'The folder your website was downloaded into, relative to this project file.', 'text', { id: `runtime-${key}-portal-path` }), 'website', `runtime-${key}-portal-path`)}</div>`
      : '';
  return `<form class="form-grid" data-form="runtime" id="runtime-${key}" ${site ? `data-site="${esc(site.id)}"` : ''}>${quickUi.partsFieldset(esc, parts)}${inherited('runtime')}${portalSource}
    <div class="inline-fields">${site ? field('Local port', 'port', site.mirage.port ?? '', PORT_HELP, 'number', { id: `runtime-${key}-port` }) : ''}<div data-api-port ${parts.api ? '' : 'hidden'}>${field('Web API port', 'api-port', settings.dataverse?.port ?? 0, 'Scripts and tests call the Web API at http://127.0.0.1:<port>/api/data/v9.2/. Keep a fixed number so the address never changes; 0 picks a free port at every start.', 'number', { id: `runtime-${key}-api-port` })}</div><div data-app-choice ${parts.modelDriven ? '' : 'hidden'}>${appField}</div></div>
    <div class="inline-fields">${choice(
      'When you add or change records',
      'simulation-level',
      ['dry-run', 'simulation', 'deep', 'local-state'].map((value) => [value, optionText('simulation-level', value)]),
      simulation?.level ?? 'local-state',
      `runtime-${key}-level`,
      LEVEL_HELP,
    )}</div>${inherited('simulation')}
    ${check('Run your own scripts and controls inside model-driven apps', 'trusted-extensions', settings.modelDriven?.trustedExtensions === true, `runtime-${key}-trusted`, "Form scripts, command buttons and code components (PCF) from your Solutions run in the local apps with the test user's permissions. Turn this on only for code from your own project. Applies when the preview restarts.")}
    <div class="toolbar"><button type="submit" class="button primary">Save runtime configuration</button><span class="muted">Applies when the preview restarts.</span></div></form>`;
}
const withPick = (html, kind, into) => `<div class="pick-field">${html}${pickButton(kind, into)}</div>`;
const PORT_HELP =
  'The preview opens at http://127.0.0.1:<port>. Everything you run shares this address: the website at /, model-driven apps at /main.aspx, canvas apps at /_apps/canvas/ and the simulator at /_sim/. Only the Web API has a port of its own. Keep a fixed number (8787 is usual) so the address stays the same; 0 picks a free port at every start.';
const PACK_HELP =
  'Files of your project that fill tables with example records (pack.mjs): one file path per line. Only add files you trust: their code runs when the preview starts.';
const PRESET_HELP =
  'The example records your tables start with: a data set of your sample data module, or a built-in example.';
// A Choose folder… button that writes the picked folder into a field, or adds it as a line of a list.
const pickButton = (kind, into) =>
  `<button type="button" class="button small" data-pick-folder="${esc(kind)}" data-pick-into="${esc(into)}">${kind === 'solution' ? 'Add a Solution folder…' : 'Choose folder…'}</button>`;
const LOCAL_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i;
function envRow(id = '', settings = {}, siteId = '') {
  return `<div class="environment-editor"><div class="inline-fields">${field('Environment name', 'env-id', id, 'A short name, for example dev or test.')}${field('Website address', 'env-url', settings.url ?? '', 'The start of your live website address, for example https://contoso.powerappsportals.com, without sign-in links.')}</div>${LOCAL_URL.test(settings.url ?? '') ? '<p class="muted small">This is the address of your local preview, not a live website: Lense can show your files there too. You can leave it as it is.</p>' : ''}<div class="row"><label class="checkbox-line"><input name="env-caution" type="checkbox" ${settings.caution ? 'checked' : ''}>Holds real customer data (Paqvilo leaves it out when you run something on all environments)</label><button class="button" type="button" data-remove-env>Remove</button></div>
    <details class="disclosure" ${id && siteId ? `data-section-key="env-${esc(siteId)}-${esc(id)}"` : ''}><summary>Advanced: compared version, scope and first page</summary><div class="inline-fields">${field('Baseline', 'env-baseline', settings.baseline ?? '', 'Optional Git ref compared for changed-only overlays.')}${field('Start page', 'env-start', settings.startPath ?? '', 'Optional first page for this environment.')}</div>${choice(
      'Source scope',
      'env-scope',
      [
        ['', 'Site default'],
        ['all', 'all'],
        ['changed', 'changed'],
      ],
      settings.scope ?? '',
      `env-${slug(siteId)}-${slug(id) || `new-${++newRows}`}-scope`,
    )}</details></div>`;
}
// A list of folders, one per line, with its Choose folder… button.
const folderList = (label, name, values, help, id, kind) =>
  withPick(area(label, name, (values ?? []).join('\n'), help, id), kind, id);
// A deployment profile file as the form shows it: a path, and what it is relative to (the website export, the export root
// or the settings folder). A list of files (several deployment settings files) is edited in the Settings file.
const PROFILE_SECTIONS = [
  [
    'pages',
    'Website changes file',
    'A .deployment.yml file of your website export (deployment-profiles folder): changes to website records for this environment.',
  ],
  [
    'environmentVariables',
    'Environment variable values file',
    'A deployment settings .json file (pac solution create-settings) with EnvironmentVariables: their values for this environment.',
  ],
  [
    'connectionReferences',
    'Connection references file',
    'A deployment settings .json file with ConnectionReferences (often the same file as above).',
  ],
];
// Choose file… writes the path and its starting folder for you; the note only says how the path is read.
const BASES = {
  '': 'path from the settings folder',
  source: 'path from the website export folder',
  sourceRoot: 'path from the export root',
};
const profileValue = (value) =>
  typeof value === 'string'
    ? ['', value]
    : value && typeof value === 'object' && !Array.isArray(value)
      ? value.source !== undefined
        ? ['source', value.source]
        : value.sourceRoot !== undefined
          ? ['sourceRoot', value.sourceRoot]
          : ['', '']
      : ['', ''];
function profileRow(key, id = '', sources = {}, isDefault = false) {
  const row = `profile-${key}-${slug(id) || `new-${++newRows}`}`;
  if (Object.values(sources).some(Array.isArray))
    return `<div class="profile-editor" data-profile-locked="${esc(id)}"><p><strong>${esc(id)}</strong> <span class="muted small">uses a list of files; change it in the Settings file.</span></p><input type="hidden" name="profile-keep" value="${esc(id)}"></div>`;
  return (
    `<div class="profile-editor"><div class="inline-fields">${field('Profile name', 'profile-id', id, 'A short name, for example dev or test.', 'text', { id: `${row}-id` })}<div><label class="checkbox-line"><input type="radio" name="profile-default" value="${esc(id)}" ${isDefault ? 'checked' : ''} data-profile-default>Use by default</label></div><div class="row"><button class="button" type="button" data-remove-profile>Remove</button></div></div>` +
    `<div class="inline-fields">${PROFILE_SECTIONS.map(([section, label, help]) => {
      const [base, value] = profileValue(sources[section]);
      return `<div class="pick-field">${field(label, `profile-${section}`, value, `${help} Use Choose file…: it writes the path, and the folder the path starts from, for you.`, 'text', { id: `${row}-${section}` })}<input type="hidden" name="profile-${section}-base" value="${esc(base)}"><span class="muted small" data-profile-base>${esc(value ? BASES[base] : '')}</span><button type="button" class="button small" data-pick-file="${section === 'pages' ? 'profile' : 'settings'}" data-pick-into="${row}-${section}">Choose file…</button></div>`;
    }).join('')}</div></div>`
  );
}
function codeAppRow(app = {}, index = '') {
  const id = `code-app-${++newRows}`,
    dev = app.devServer ?? {};
  return `<div class="profile-editor" data-code-app data-index="${esc(index)}"><div class="inline-fields">${field('App name', 'code-name', app.name ?? '', 'Used in the local app URL.', 'text', { id: `${id}-name` })}${field('App folder', 'code-dir', app.dir ?? '', 'Relative to the project file.', 'text', { id: `${id}-dir` })}${field('Config file', 'code-config', app.config ?? '', 'Relative to the app folder; blank uses power.config.json.', 'text', { id: `${id}-config` })}${field('Local app URL', 'code-url', app.localAppUrl ?? '', 'Optional loopback URL.', 'text', { id: `${id}-url` })}</div><details><summary>Optional local dev server</summary>${area('Command argv (JSON array)', 'code-command', dev.command ? JSON.stringify(dev.command) : '', 'Explicit command and arguments; no shell.', `${id}-command`)}<div class="inline-fields">${field('Working folder', 'code-cwd', dev.cwd ?? '', 'Relative to the app folder.', 'text', { id: `${id}-cwd` })}${field('Startup timeout (ms)', 'code-timeout', dev.timeoutMs ?? '', '1000 to 300000 milliseconds.', 'number', { id: `${id}-timeout` })}</div>${area('Environment (JSON object)', 'code-env', dev.env ? JSON.stringify(dev.env) : '', 'Environment names and string values.', `${id}-env`)}</details><button type="button" class="button" data-remove-code-app>Remove app</button></div>`;
}
function codeAppsOf(form, originals) {
  return [...form.querySelectorAll('[data-code-app]')].map((row) => {
    const value = (name) => row.querySelector(`[name="${name}"]`).value.trim();
    const previous = row.dataset.index === '' ? {} : (originals[Number(row.dataset.index)] ?? {});
    const app = { ...previous, name: value('code-name'), dir: value('code-dir') };
    for (const [key, name] of [
      ['config', 'code-config'],
      ['localAppUrl', 'code-url'],
    ]) {
      if (value(name)) app[key] = value(name);
      else delete app[key];
    }
    const command = value('code-command'),
      env = value('code-env'),
      cwd = value('code-cwd'),
      timeout = value('code-timeout');
    if (command || env || cwd || timeout) {
      let parsedCommand, parsedEnv;
      try {
        parsedCommand = JSON.parse(command);
        if (env) parsedEnv = JSON.parse(env);
      } catch {
        throw new Error('Dev server command and environment must be valid JSON.');
      }
      if (
        !Array.isArray(parsedCommand) ||
        !parsedCommand.length ||
        typeof parsedCommand[0] !== 'string' ||
        !parsedCommand[0].trim() ||
        parsedCommand.some((v) => typeof v !== 'string' || v.includes('\0'))
      )
        throw new Error('Dev server command must be a nonempty JSON array of strings.');
      if (
        env &&
        (!parsedEnv ||
          typeof parsedEnv !== 'object' ||
          Array.isArray(parsedEnv) ||
          Object.values(parsedEnv).some((v) => typeof v !== 'string'))
      )
        throw new Error('Dev server environment must be a JSON object of strings.');
      if (timeout && (!/^\d+$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 300000))
        throw new Error('Dev server timeout must be 1000 to 300000 ms.');
      app.devServer = { ...(previous.devServer ?? {}), command: parsedCommand };
      if (cwd) app.devServer.cwd = cwd;
      else delete app.devServer.cwd;
      if (env) app.devServer.env = parsedEnv;
      else delete app.devServer.env;
      if (timeout) app.devServer.timeoutMs = Number(timeout);
      else delete app.devServer.timeoutMs;
    } else delete app.devServer;
    return app;
  });
}
function siteEditor(site) {
  const project = state.kind === 'project',
    key = slug(site.id),
    mirage = (project ? state.settings : site.mirage) ?? {};
  const found = quick?.candidates ?? { canvas: [], codeApps: [] };
  const portal = !site.runtime?.kind || site.runtime.kind === 'power-pages';
  // Canvas app folders found here and not used yet; one a Solution already packs is offered unticked, with that Solution named.
  const canvas = mirage.canvas?.sources ?? [];
  const canvasOffer = (found.canvas ?? []).filter(
    (item) => !canvas.some((value) => quickUi.normalPath(value) === quickUi.normalPath(item.value)),
  );
  const profiles = Object.entries(mirage.deploymentProfiles?.profiles ?? {}),
    current = mirage.deploymentProfiles?.default ?? null;
  const portalFound = (quick?.candidates?.portals ?? []).find(
    (item) => quickUi.normalPath(item.value) === quickUi.normalPath(site.source),
  );
  const profileOffer = (portalFound?.profiles ?? []).filter((item) => !profiles.some(([id]) => id === item.name));
  return (
    `<form class="form-grid" data-form="files" data-site="${esc(site.id)}" id="files-${key}">` +
    (portal
      ? withPick(
          field(
            'Website export folder',
            'source',
            site.source,
            project
              ? 'The folder your website was downloaded into, relative to this project file.'
              : 'The folder your website was downloaded into from Power Pages, relative to the export root (the project folder unless Project settings says otherwise).',
            'text',
            { id: `files-${key}-source` },
          ),
          'website',
          `files-${key}-source`,
        )
      : '') +
    (project
      ? folderList(
          'Solution folders',
          'runtime-solutions',
          (state.settings.solutions ?? []).map((item) => item.path),
          'Your exported and unpacked Solutions (pac solution unpack): one folder per line, relative to this project file. Your tables, forms, views, apps and flows come from here.',
          `files-${key}-solutions`,
          'solution',
        )
      : folderList(
          'Solution folders',
          'solutions',
          site.mirage.solutionRoots ?? state.settings.solutionRoots ?? [],
          'Your exported and unpacked Solutions (pac solution unpack): one folder per line, relative to the export root. Your tables, forms, views, apps and flows come from here.',
          `files-${key}-solutions`,
          'solution',
        )) +
    folderList(
      'Canvas app folders (optional)',
      'canvas-sources',
      canvas,
      'Canvas apps outside your Solutions: a folder with Src/*.pa.yaml (or an .msapp file) per line, relative to the settings folder. Apps inside your Solutions need nothing here.',
      `files-${key}-canvas`,
      'canvas',
    ) +
    (canvasOffer.length
      ? `<fieldset class="quick-group"><legend>Canvas app folders found</legend>${canvasOffer.map((item) => `<label class="checkbox-line"><input type="checkbox" name="canvas-found" value="${esc(item.value)}" ${item.inSolution ? '' : 'checked'}><code>${esc(item.path)}</code>${item.inSolution ? ` <span class="muted small">Solution ${esc(item.inSolution)} already contains this app; add it only to run this folder copy too.</span>` : ''}</label>`).join('')}</fieldset>`
      : '') +
    folderList(
      'Model-driven script folders (optional)',
      'client-sources',
      mirage.modelDriven?.clientSources ?? [],
      'Only when your form scripts are built outside your Solutions (for example a TypeScript build output folder): one folder per line, relative to the settings folder. They replace the Solution copies of the same files.',
      `files-${key}-client`,
      'folder',
    ) +
    `<div class="title-row"><h3>Deployment profiles (optional)</h3>${note('A deployment profile is a set of files that adjust your project for one environment (dev, test…): website record changes, environment variable values and connection references. The preview applies the default profile; choose another in the simulator (Environment).', 'About deployment profiles')}</div>` +
    (profileOffer.length
      ? `<p class="quick-hint">Found in your website export: ${profileOffer.map((item) => `<code>${esc(item.file)}</code>`).join(', ')}. <button type="button" class="button small" data-add-found-profiles="${esc(JSON.stringify(profileOffer))}">Add them</button></p>`
      : '') +
    `<div data-profiles data-key="${esc(key)}" data-source-dir="${esc(site.sourceStatus?.path ?? '')}">${profiles.map(([id, sources]) => profileRow(key, id, sources, id === current)).join('')}</div>` +
    `<div class="row"><button type="button" class="button" data-add-profile>Add profile</button><label class="checkbox-line"><input type="radio" name="profile-default" value="" ${current ? '' : 'checked'}>No default profile</label></div>` +
    (project
      ? `<fieldset class="quick-group"><legend>Code apps</legend><p>Register each local app. Changes apply after restarting the preview.</p><div data-code-apps>${(state.layers.shared.values.codeApps ?? []).map((app, index) => codeAppRow(app, index)).join('')}</div><button type="button" class="button" data-add-code-app>Add code app</button></fieldset>`
      : '<p class="muted small">Code apps run from a standalone project file (paqvilo setup --project), not from this settings file.</p>') +
    `<div class="toolbar"><button type="submit" class="button primary">Save</button><span class="muted">Writes the ${layer} settings file. Applies when the preview restarts.</span></div></form>`
  );
}
// Live environments (Lense): where Lense opens your live website, and which local files it shows there.
function environmentsEditor(site) {
  const key = slug(site.id);
  return (
    `<form class="form-grid" data-form="environments" data-site="${esc(site.id)}" id="environments-${key}">` +
    `<div class="inline-fields">${field('Default live environment', 'defaultEnv', site.defaultEnv, 'Lense is the Paqvilo tool that opens your live website in its own browser and shows your local files on it. This is the name of the environment below that it opens unless you choose another, for example dev.', 'text', { id: `environments-${key}-default` })}${field('First page Lense opens', 'startPath', site.startPath ?? '/', 'The page of your live website that Lense opens first: the part of the address after the domain, for example / for the home page or /contact.', 'text', { id: `environments-${key}-start` })}</div>` +
    `<div data-environments>${Object.entries(site.environments)
      .map(([id, settings]) => envRow(id, settings, site.id))
      .join('')}</div><button type="button" class="button" data-add-env>Add environment</button>` +
    `<details class="disclosure" data-section-key="preview-${esc(site.id)}"><summary>Advanced: which local files Lense shows</summary>${choice(
      'Local files Lense shows',
      'scope',
      [
        ['all', 'All local files'],
        ['changed', 'Only files changed since the compared version'],
      ],
      site.scope ?? 'all',
      `environments-${key}-scope`,
    )}${area('Route rules (YAML)', 'routes', JSON.stringify(site.routes ?? [], null, 2), 'Explicit file, directory or passthrough mappings. Other inline/markup settings are in the Settings file.', `environments-${key}-routes`, 'ui-mono')}</details>` +
    `<div class="toolbar"><button type="submit" class="button primary">Save</button><span class="muted">Writes the ${layer} settings file.</span></div></form>`
  );
}
// Sample data: the modules of a project, its starting data and when it loads.
function dataEditor(site) {
  const project = state.kind === 'project',
    key = slug(site?.id ?? 'project'),
    mirage = (project ? state.settings : site.mirage) ?? {};
  const presets = runtimePresets(),
    preset = mirage.preset ?? '',
    registered = project ? (state.packs ?? []) : (site.packs ?? []);
  const found = (quick?.candidates?.packs ?? []).filter(
    (item) =>
      !registered.some(
        (pack) =>
          quickUi.normalPath(pack.module) === quickUi.normalPath(item.value) ||
          quickUi.normalPath(pack.module).endsWith(`/${quickUi.normalPath(item.value)}`),
      ),
  );
  const presetField = presets.length
    ? `<div><label for="data-${key}-preset">${labelText('Starting data', PRESET_HELP, `data-${key}-preset`)}<select id="data-${key}-preset" name="preset" aria-describedby="data-${key}-preset-help"><option value="">No starting data</option>${quickUi.presetGroups(esc, presets, preset, false)}${preset && !presets.some(([id]) => id === preset) ? `<option value="${esc(preset)}" selected>${esc(preset)}</option>` : ''}</select></label></div>`
    : field(
        'Starting data (optional)',
        'preset',
        preset,
        `${PRESET_HELP} The data sets of your module are listed here once the preview runs; until then leave it empty (tables start empty).`,
        'text',
        { id: `data-${key}-preset` },
      );
  return (
    `<form class="form-grid" data-form="data" ${site ? `data-site="${esc(site.id)}"` : ''} id="data-${key}">` +
    area('Sample data modules', 'packs', packText(mirage.dataPacks), PACK_HELP, `data-${key}-packs`) +
    (registered.length
      ? `<ul class="detail-list">${registered.map((pack) => `<li class="row"><code>${esc(pack.module)}</code> ${kit.badge(pack.exists ? 'file found' : 'file missing', pack.exists ? 'ok' : 'bad')}</li>`).join('')}</ul>`
      : '') +
    (found.length
      ? `<fieldset class="quick-group"><legend>Found in this folder</legend>${found.map((item) => `<label class="checkbox-line"><input type="checkbox" name="pack-found" value="${esc(item.value)}"><code>${esc(item.path)}</code></label>`).join('')}</fieldset>`
      : '') +
    (project
      ? ''
      : `<div class="inline-fields">${presetField}${choice(
          'When to load the starting data',
          'presetMode',
          [
            ['', 'Default (every start)'],
            ['bootstrap', 'First start only: later changes are kept'],
            ['always', 'Every start: back to the starting data'],
          ],
          mirage.presetMode,
          `data-${key}-preset-mode`,
          'Whether the starting data is loaded once, or again at every start.',
        )}${choice(
          'Settings saved with the data set',
          'presetConfiguration',
          [
            ['', 'Default (the data only)'],
            ['data-only', 'Load the data only'],
            ['apply', 'Also apply its saved settings'],
          ],
          mirage.presetConfiguration,
          `data-${key}-preset-configuration`,
          'A data set saved in the simulator can carry settings (such as the signed-in person); choose whether they apply too.',
        )}</div>`) +
    `<div class="toolbar"><button type="submit" class="button primary">Save</button><span class="muted">Applies when the preview restarts.</span></div></form>`
  );
}
// A button into the simulator, which manages what runs; before the preview runs, a line saying where it will be.
const simulator = () => (state.runtime?.product === 'Mirage' || quickSession()?.ready ? adminUrl() : null);
// With several projects, the link names the one it opens: the project chosen under Start & check.
const simLink = (view, text) => {
  const site = state.sites?.length > 1 ? quickTarget()?.id : null,
    label = site ? `${text} (${site})` : text;
  return simulator()
    ? `<a class="button small sim-link" href="${esc(simulator())}#${esc(view)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`
    : `<span class="muted small">${esc(label)}: in the simulator, once ${site ? "this project's" : 'the'} preview runs (Start &amp; check).</span>`;
};
// stages[].anchor (lense/setup/store.mjs) is the one stage→section map.
const sectionOf = (item) => String(item?.anchor ?? '#overview').slice(1);
// The setting editor shows each stage's remaining keys in the section owning the stage; project and start keys sit with the document and defaults.
const editorSection = (item) => (item.id === 1 ? 'advanced' : item.id === 10 ? 'settings' : sectionOf(item));
const STAGE_STATUS = {
  done: ['done', 'ok'],
  next: ['next step', 'info'],
  optional: ['optional', 'neutral'],
  blocked: ['to do', 'warn'],
};
const STATUS_ORDER = ['next', 'blocked', 'done', 'optional'];
// Keys with a dedicated guided control; the setting editor offers every other catalogue key.
const DEDICATED = new Set([
  'sourceRoot',
  'defaultSite',
  'portals',
  'includeCaution',
  'browser.channel',
  'browser.headless',
  'browser.profileDir',
  'browser.profile',
  'browser.userDataDir',
  'browser.profileDirectory',
  'browser.cdpUrl',
  'browser.debugPort',
  'browser.bypassCSP',
  'agent.enabled',
  'liveReload',
  'panel',
  'editor',
  'sourceMaps',
  'sites',
  'source',
  'defaultEnv',
  'environments',
  'startPath',
  'scope',
  'routes',
  'solutionRoots',
  'dataPacks',
  'port',
  'preset',
  'presetMode',
  'presetConfiguration',
  'runtime',
  'simulation',
  'modelDriven',
  'dataverse',
  'dataverse.applications',
  'personaContexts',
  'identityProvider',
  'solutions',
  'lcid',
  'watch',
  'stateDirectory',
  'canvas',
  'deploymentProfiles',
  'codeApps',
  'localServices',
]);
const dedicated = (item) =>
  DEDICATED.has(item.key) &&
  !(item.key === 'portals' && item.scope === 'project') &&
  !(item.key === 'sourceMaps' && item.scope !== 'catalogue');
const SITE_FIELDS = new Set([
  'source',
  'defaultEnv',
  'environments',
  'startPath',
  'webFiles',
  'inline',
  'markup',
  'scope',
  'routes',
]);
const FINDING_STEPS = {
  'missing-source': 'select the portal export folder',
  'placeholder-origin': 'replace the example.test origin',
  'missing-solution': 'select the Solution folder',
  'source-layout': 'select the export inside the checkout',
  'missing-pack': 'write or select the pack module',
};
const lists = new Map();

const runtimePresets = () => {
  const found = new Map();
  // [id, name, the name of the project pack that offers it, or null for a built-in set]
  const packs = new Map((runtimeInfo.packs?.packs ?? []).map((pack) => [pack.id, pack.name ?? pack.id]));
  for (const item of runtimeInfo.packs?.library ?? [])
    if (item?.id && !found.has(item.id))
      found.set(item.id, [item.name ?? item.id, item.pack ? (packs.get(item.pack) ?? item.pack) : null]);
  for (const item of runtimeInfo.status?.presets ?? runtimeInfo.status?.availablePresets ?? [])
    if (item?.id && !found.has(item.id)) found.set(item.id, [item.name ?? item.id, null]);
  return [...found].map(([id, [name, pack]]) => [id, name, pack]);
};
const runtimeApps = () =>
  (Array.isArray(runtimeInfo.status?.modelDrivenApps) ? runtimeInfo.status.modelDrivenApps : [])
    .map((app) => [app?.id ?? app?.appId ?? app?.appid, app?.name ?? app?.uniqueName ?? ''])
    .filter(([id]) => typeof id === 'string' && id);
const datalists = () =>
  `<datalist id="preset-options">${runtimePresets()
    .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
    .join('')}</datalist>` +
  `<datalist id="app-options">${runtimeApps()
    .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`)
    .join('')}</datalist>`;

// Lists over 10 rows get the shared pager; each list re-renders alone (search, size, page) so other drafts stay intact.
function list(key, items, columns, options = {}) {
  const html = () => {
    if (items.length <= 10)
      return kit.table({ key, columns, items, caption: options.caption, emptyText: options.emptyText });
    const result = kit.pageItems(items, (pagers[key] ??= {}), options.text ? { text: options.text } : undefined);
    pagers[key].page = result.page;
    return kit.table({ key, columns, result, caption: options.caption, emptyText: options.emptyText });
  };
  lists.set(key, html);
  return `<div class="list" data-list="${esc(key)}">${html()}</div>`;
}
function rerenderTable(key, search = false) {
  const host = document.querySelector(`[data-list="${CSS.escape(key)}"]`),
    html = lists.get(key);
  if (host && html) {
    const open = new Set(
      [...host.querySelectorAll('details[data-section-key][open]')].map((node) => node.dataset.sectionKey),
    );
    host.innerHTML = html();
    for (const node of host.querySelectorAll('details[data-section-key]'))
      node.open = open.has(node.dataset.sectionKey);
  } else if (key === 'dashboard-activity') refreshSystem(true);
  if (search) {
    const input = document.querySelector(`[data-table-search="${CSS.escape(key)}"]`);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}
function applyUiOpen(root) {
  for (const node of root.querySelectorAll('details[data-ui-section]'))
    if (uiOpen.has(node.dataset.uiSection)) node.open = uiOpen.get(node.dataset.uiSection);
}

// A collapsible section: one title row with its (i) guidance and status badge; the guidance never sits inside the heading.
function stage(id, opened, { title, help = '', badge, body }) {
  const stages = stagesNow().filter((item) => sectionOf(item) === id);
  const status = STATUS_ORDER.find((name) => stages.some((item) => item.status === name));
  const mark = badge ?? (status ? kit.badge(...STAGE_STATUS[status]) : '');
  return `<details id="${id}" class="stage panel" data-section-key="${id}"${opened.has(id) ? ' open' : ''}><summary><div class="panel-heading"><div class="title-row"><h2>${esc(title)}</h2>${help}</div>${mark}</div></summary><div class="stage-body">${body}</div></details>`;
}
// The stage rail uses the sidebar items of /_sim/: the step number in the icon slot (green when done), one line per stage.
// Done and optional stages carry their status as text for assistive technology; open stages show a small badge.
const SECTION_TITLES = {
  overview: 'project status',
  system: 'Your system at a glance',
  'runtime-configuration': 'What to run',
  portals: 'Exported files & live environments',
  packs: 'Sample data',
  personas: 'Test people & sign-in',
  environments: 'Live environments',
  providers: 'Outside services',
  identity: 'Web API access',
  settings: 'Project settings',
  advanced: 'Settings file',
  guidance: 'Start & check',
};
// Stages with what the page knows: a setup opened on its own sees the preview it found running, so Start & check is done.
// Saved changes it has not restarted with make it the next step again.
const needsStartingData = () => {
  const target = quickTarget();
  return Boolean(target && !target.project && target.packs.length && !target.preset);
};
const stagesNow = () =>
  (state.stages ?? []).map((item) =>
    item.id === 10 && item.status !== 'blocked' && !state.runtime && quickSession()?.ready
      ? { ...item, status: restartHint || preview?.operation?.settingsChanged === true ? 'next' : 'done' }
      : // A sample data module without a chosen data set leaves the tables empty: the choice is the next step once the preview runs.
        item.id === 5 && item.status === 'done' && needsStartingData()
        ? { ...item, status: quickSession()?.ready ? 'next' : 'optional' }
        : item,
  );
const railHtml = () =>
  stagesNow()
    .map((item, index) => {
      const [text, tone] = STAGE_STATUS[item.status] ?? [item.status, 'neutral'];
      const status = ['done', 'optional'].includes(item.status)
        ? `<span class="ui-sr-only">${esc(text)}</span>`
        : kit.badge(text, tone);
      const section = SECTION_TITLES[sectionOf(item)];
      return `<a class="nav-item is-${esc(item.status)}${item.status === 'next' ? ' active" aria-current="step' : ''}" href="#${esc(sectionOf(item))}" title="${esc(`Stage ${index + 1}, ${item.title}: ${text}.${section ? ` Opens the ${section} section.` : ''}`)}"><span class="nav-icon rail-step" aria-hidden="true">${index + 1}</span><span class="rail-title">${esc(item.title)}</span>${status}</a>`;
    })
    .join('');

// ---- Setting editor: every catalogue key without a dedicated form, saved to the layer its badge names.
// Every row carries the current authored value (the status exposes each document's keys, secrets as references only);
// known is false only when that document could not be read, and such a row offers no blind replace or delete.
function settingTargets(item) {
  const path = item.key.split('.'),
    at = (source) => path.reduce((value, key) => value?.[key], source);
  if (item.scope === 'catalogue') return [{ path, layer, value: at(state.settings), known: true }];
  if (item.scope === 'site')
    return state.sites.map((site) =>
      SITE_FIELDS.has(item.key)
        ? { site, path: ['sites', site.id, ...path], layer, value: site[item.key], known: true }
        : {
            site,
            path: ['sites', site.id, 'mirage', ...path],
            layer,
            value: (site.authoredMirage ?? site.mirage)?.[item.key],
            known: true,
            inherited: site.inherited?.[item.key] ? (site.effectiveMirage ?? site.mirage)?.[item.key] : undefined,
          },
    );
  const values = state.layers.shared.values;
  if (item.scope === 'portal')
    return state.sites.map((site, index) => ({
      site,
      path: ['portals', index, ...path],
      layer: 'shared',
      value: at(values?.portals?.[index]),
      known: Boolean(values),
    }));
  if (state.kind === 'project') return [{ path, layer: 'shared', value: at(values), known: Boolean(values) }];
  return state.sites.map((site) => {
    const linked = state.layers[`project:${site.id}`];
    return linked
      ? {
          site,
          path,
          layer: `project:${site.id}`,
          file: linked.file,
          value: at(linked.values),
          known: Boolean(linked.values),
        }
      : { site, missing: true };
  });
}
// A value the status reduced to references (secrets, connection settings, or defaults holding them) is never replaced from this page.
const referencesOnly = (item, value) =>
  value !== undefined &&
  (item.redact ||
    (item.key === 'defaults' && ['secrets', 'connections'].some((key) => value?.mirage?.[key] !== undefined)));
// A saved value shown as block YAML, as it is typed; strings that YAML would read differently are quoted (JSON strings are YAML).
const yamlScalar = (value) =>
  typeof value === 'string' &&
  /^[\w./~-][\w ./@:~-]*$/.test(value) &&
  !/: |:$| $|^- /.test(value) &&
  !/^(?:true|false|null|yes|no|on|off|~|[-+]?(?:\d[\d_]*)?\.?\d+(?:e[-+]?\d+)?)$/i.test(value)
    ? value
    : JSON.stringify(value);
const yamlBlock = (value) => value !== null && typeof value === 'object' && Object.keys(value).length > 0;
function yamlText(value, pad = '') {
  if (!yamlBlock(value)) return pad + yamlScalar(value);
  if (Array.isArray(value))
    return value
      .map((item) => `${pad}- ${yamlBlock(item) ? yamlText(item, `${pad}  `).trimStart() : yamlScalar(item)}`)
      .join('\n');
  return Object.entries(value)
    .map(
      ([key, item]) =>
        `${pad}${yamlScalar(key)}:${yamlBlock(item) ? `\n${yamlText(item, `${pad}  `)}` : ` ${yamlScalar(item)}`}`,
    )
    .join('\n');
}
const shownValue = (value) => (value === undefined ? '' : yamlText(value));
function referenceSummary(item, value) {
  const entries =
    item.key === 'defaults'
      ? Object.entries({ ...(value.mirage?.secrets ?? {}), ...(value.mirage?.connections ?? {}) })
      : Array.isArray(value)
        ? value.map((entry, index) => [entry?.appId ?? index, entry])
        : Object.entries(value ?? {});
  return `<ul class="references">${entries.map(([name, entry]) => `<li><code>${esc(name)}</code>${entry?.kind ? ` · ${esc(entry.kind === 'protected' ? 'protected value' : 'environment variable')}` : ''}${entry?.provider ? ` · ${esc(entry.provider)}` : ''}${Array.isArray(entry?.settings) && entry.settings.length ? ` · settings: ${esc(entry.settings.join(', '))}` : ''}</li>`).join('')}</ul>`;
}
const settingId = ({ item, target }) => `setting-${slug(target.site?.id ?? 'root')}-${slug(item.key)}`;
function settingInfo(row) {
  const { item, target } = row,
    id = settingId(row);
  const scope = target.missing ? 'project file (not linked)' : state.kind === 'project' ? 'project file' : target.layer;
  const notes = [
    item.doc,
    item.pending &&
      'Accepted by shape only: the module that owns this key has not registered its parser in this build.',
    item.redact &&
      (item.redactHelp ?? 'References only: validation refuses literal secret values; never paste one here.'),
    target.inherited !== undefined &&
      "Inherited from defaults.mirage (shown as the placeholder); saving sets this target's own value.",
  ].filter(Boolean);
  return (
    `<span class="title-row"><code class="setting-key">${esc(item.key)}</code>${kit.info({ id: `${id}-help`, label: `About ${item.key}`, text: notes.join(' '), example: item.example, docs: item.contract ? [kit.docLink(item.contract, state.docs)] : [] })}</span>${target.site ? ` <span class="muted">· ${esc(target.site.id)}</span>` : ''}` +
    `<div class="setting-badges">${kit.badge(scope, String(target.layer).startsWith('project:') ? 'info' : 'neutral')}${item.pending ? ` ${kit.badge('parser pending', 'warn')}` : ''}${item.redact ? ` ${kit.badge('references only', 'warn')}` : ''}</div>`
  );
}
function settingControl(row) {
  const { item, target } = row,
    id = settingId(row);
  if (target.missing)
    return `<p class="muted">Not available for ${esc(target.site.id)}: this setting lives in a separate Mirage project file, which this project does not use. Skip it unless a developer set one up.</p>`;
  const advanced = `<a href="#advanced" data-yaml-layer="${esc(target.layer)}">Configuration &amp; rules</a>`;
  if (!target.known)
    return `<p class="muted">The current value of ${esc(item.key)} is not available because its document did not validate. Edit it in ${advanced}.</p>`;
  if (referencesOnly(item, target.value))
    return `${referenceSummary(item, target.value)}<p class="muted">Shown as references only. Add, change or remove these entries in the verbatim document in ${advanced}${target.file ? ` (${esc(fileName(target.file))})` : ''}; this page never replaces them.</p>`;
  specs.set(id, row);
  const value = target.value,
    described = `aria-describedby="${esc(id)}-help"`;
  const inherited =
    target.inherited === undefined
      ? ''
      : typeof target.inherited === 'object'
        ? JSON.stringify(target.inherited, null, 2)
        : String(target.inherited);
  const options = (pairs) => optionList(pairs, value);
  const control = ['list', 'object'].includes(item.kind)
    ? // Empty means not set: the example sits in the (i) next to the key, never in the box, so it cannot pass for a value.
      `<textarea id="${esc(id)}" name="value" class="ui-mono" rows="5" spellcheck="false" ${described} placeholder="${esc(inherited || 'Not set. An example is under (i) next to the setting name.')}">${esc(shownValue(value))}</textarea>`
    : item.kind === 'boolean'
      ? `<select id="${esc(id)}" name="value" ${described}>${options([
          ['', inherited ? `Not set (inherits ${inherited})` : 'Not set'],
          ['true', 'true'],
          ['false', 'false'],
        ])}</select>`
      : item.kind === 'choice'
        ? `<select id="${esc(id)}" name="value" ${described}>${options([['', inherited ? `Not set (inherits ${inherited})` : 'Not set'], ...(item.choices ?? []).map((option) => [option, option])])}</select>`
        : `<input id="${esc(id)}" name="value" type="${item.kind === 'number' ? 'number' : 'text'}" value="${esc(value ?? '')}" placeholder="${esc(inherited)}" ${described}>`;
  return (
    `<form data-form="setting" data-key="${esc(item.key)}" data-site="${esc(target.site?.id ?? '')}" data-spec="${esc(id)}" class="setting-form"><label class="ui-sr-only" for="${esc(id)}">${esc(item.key)} value${target.site ? ` for ${esc(target.site.id)}` : ''}</label>${control}` +
    `<div class="toolbar"><button type="submit" class="button">Save setting ${esc(item.key)}</button>${['list', 'object'].includes(item.kind) ? note(`YAML for the value only, without the key line. The box shows the value saved now${target.file ? ` in ${fileName(target.file)}` : ''}, and is empty when the setting is not set. Saving replaces the whole key and drops comments inside it; empty removes the key.`, 'About YAML values') : ''}</div></form>`
  );
}
const SETTING_COLUMNS = [
  { label: 'Setting', render: settingInfo },
  { label: 'Value', render: settingControl },
];
function settingEditor(sectionId) {
  if (!state.layers.shared.exists) return '';
  return (state.stages ?? [])
    .filter((item) => editorSection(item) === sectionId)
    .map(({ id, title }) => {
      const rows = (state.settingsCatalogue ?? [])
        .filter((item) => item.stage === id && !dedicated(item))
        .flatMap((item) => settingTargets(item).map((target) => ({ item, target })));
      if (!rows.length) return '';
      return kit.section({
        key: `settings-stage-${id}`,
        title: `More settings · ${title}`,
        summary: `${rows.length} advanced setting${rows.length === 1 ? '' : 's'} as YAML, for developers; you can skip this`,
        help: kit.info({
          label: `About the ${title} settings`,
          text: `The other keys of this stage. Each row saves to the layer in its badge: ${state.kind === 'project' ? 'the project file' : `the ${layer} catalogue, or project:<target> for a linked Mirage project file`}. Lists and mappings are YAML snippets validated on save.`,
          docs: [kit.docLink('docs/configuration.md', state.docs)],
        }),
        body: list(`settings-${id}`, rows, SETTING_COLUMNS, {
          caption: `Settings for ${title}`,
          text: (row) => `${row.item.key} ${row.target.site?.id ?? ''} ${row.item.doc}`,
        }),
      });
    })
    .join('');
}

// ---- System map: planned from status.topology, live from /_sim/api/dashboard on the same origin.
function plannedPayload() {
  const target =
    state.kind === 'project'
      ? null
      : (state.sites.find((site) => site.id === state.settings.defaultSite) ?? state.sites[0]);
  const kind = state.kind === 'project' ? state.settings.runtime?.kind : target?.runtime?.kind;
  const level = (
    state.kind === 'project' ? state.settings.simulation : (target?.effectiveMirage ?? target?.mirage)?.simulation
  )?.level;
  return {
    ...(state.topology ?? {}),
    runtime: {
      product: state.runtime?.product ?? 'Mirage',
      kind: kind ?? 'power-pages',
      simulationLevel: level ?? 'local state (no level set)',
    },
  };
}
// Both views draw what the simulator's Infrastructure view draws while a preview runs, else the plan from the settings file.
const isLive = () => Boolean(dashboard && liveBase());
const currentPayload = () => (isLive() ? dashboard : plannedPayload());
// Setup shows the header and the map; activity, preflight and the configuration summary belong to the simulator workspace.
const SYSTEM_PARTS = { guide: false, kpis: false, feed: false, blocking: false, configuration: false };
function systemBody() {
  const source =
    !isLive() && liveBase()
      ? kit.notice(
          dashboardError
            ? `Live status is unavailable (${dashboardError}); showing the plan from configuration.`
            : 'Connecting to the running preview…',
          'neutral',
        )
      : '';
  return (
    source +
    renderDashboard(currentPayload(), {
      mode: isLive() ? 'live' : 'planned',
      docs: state.docs,
      previousActivity: isLive() ? previousActivity : undefined,
      history: isLive() ? activityHistory : [],
      help: HELP,
      kit,
      icons,
      parts: SYSTEM_PARTS,
      compact: true,
    })
  );
}
function nodeDetail(node) {
  const html = renderNodeDetail(node, state.docs, { kit, icons, payload: currentPayload() });
  // Node links name /_sim/ views: open them in Administration when it serves this origin; planned nodes have no view to open.
  return isLive()
    ? html.replace(/href="#/, `href="${esc(adminUrl())}#`)
    : html.replace(/<p class="ui-drawer-actions">[\s\S]*?<\/p>/, '');
}
function afterSystem() {
  const slot = $('#dashboard-node-detail'),
    node = nodeId && (currentPayload().nodes ?? []).find((item) => item.id === nodeId);
  if (slot) slot.innerHTML = node ? nodeDetail(node) : '';
}
function refreshSystem(force = false) {
  const body = $('#system-body');
  // A poll never replaces controls the user is working in; the next poll catches up.
  // ponytail: whole-section re-render per poll; patch node statuses and tiles in place if the map grows past a few hundred nodes.
  if (view === 'quick') return refreshQuick(force);
  if (!body || (!force && (pressing || body.contains(document.activeElement)))) return;
  const html = systemBody();
  if (!force && html === body.dataset.rendered) return;
  keepPlace(() => {
    body.innerHTML = html;
    body.dataset.rendered = html;
    applyUiOpen(body);
    afterSystem();
  });
  const badge = $('#system > summary .ui-badge');
  if (badge) badge.outerHTML = systemBadge();
}
const systemBadge = () => (isLive() ? kit.badge('live', 'ok') : kit.badge('planned', 'info'));
// One poll at a time, so responses never resolve out of order and previousActivity pairs consecutive feeds.
// The map refreshes every 5 seconds while the tab is visible and the section is open (it opens first by default).
let polling = false;
async function pollDashboard() {
  // Both views read the running preview: Quick setup for its check and map, All settings for the verdict under Start & check.
  if (
    polling ||
    !state ||
    !liveBase() ||
    pending ||
    document.visibilityState !== 'visible' ||
    (!quickSession()?.ready && !state.runtime)
  )
    return;
  polling = true;
  try {
    const response = await fetch(`${liveBase()}/dashboard${liveQuery()}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    previousActivity = dashboard?.activity;
    if (previousActivity) {
      activityHistory.push(previousActivity);
      if (activityHistory.length > 12) activityHistory.shift();
    }
    dashboard = next;
    dashboardError = '';
  } catch (error) {
    dashboardError = error.message;
  } finally {
    polling = false;
  }
  refreshSystem();
  refreshRun();
}
// ---- Quick setup: found exports (read once per status load), running previews (polled) and preview operations.
// Exports found in the project folder: both views offer them (Quick setup steps, All settings create and Sample data).
async function loadQuick() {
  try {
    quick = await request('/_setup/api/quick');
  } catch {
    quick = { candidates: { portals: [], solutions: [], packs: [] } };
  }
}
let previewTimer = null,
  previewPolling = false;
async function pollPreview(silent = false) {
  if (previewPolling || !state || document.visibilityState !== 'visible') return;
  previewPolling = true;
  const before = preview?.operation?.state;
  try {
    const response = await fetch('/_setup/api/preview', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    preview = await response.json();
    previewError = '';
  } catch {
    // While the preview that serves this page restarts, nothing answers: keep the last state and try again.
    if (preview?.operation?.state !== 'running') {
      previewError = 'Setup cannot read the preview status right now; it keeps trying.';
      preview ??= { sessions: [], operation: null };
    }
  } finally {
    previewPolling = false;
  }
  const now = preview?.operation?.state;
  clearTimeout(previewTimer);
  if (before === 'running' && now !== 'running') {
    if (now === 'done') {
      restartHint = false;
      notice(
        { start: 'Preview started.', restart: 'Preview restarted with your saved settings.', stop: 'Preview stopped.' }[
          preview.operation.action
        ] ?? 'Done.',
      );
    }
    if (liveRuntime()) return location.reload();
    dashboard = null;
    await loadRuntimeInfo();
  }
  if (now === 'running' || (quickSession() && !quickSession().ready))
    previewTimer = setTimeout(() => pollPreview(), 1500);
  if (!silent) {
    refreshQuick();
    refreshRun();
    if (view === 'all' && !state.runtime && !pending && !dirty && Boolean(quickSession()?.ready) !== lastLive) {
      await loadRuntimeInfo();
      // Polls can finish after editing or saving starts. Keep the live change
      // pending until a later poll can repaint without discarding a draft.
      if (!pending && !dirty && liveChanged()) renderPreservingContext();
    }
  }
  pollDashboard();
}
// All settings reads the found preview as Quick setup does; it repaints when the preview starts or stops.
let lastLive = null;
const liveChanged = () => {
  const now = Boolean(quickSession()?.ready);
  const changed = now !== lastLive;
  lastLive = now;
  if (changed && !now) {
    dashboard = null;
    runtimeInfo = {};
  }
  return changed;
};
function quickHtml() {
  const target = quickTarget(),
    session = quickSession(),
    live = isLive() ? dashboard : null;
  const mapHtml =
    session?.ready && live
      ? quickMapOpen
        ? renderDashboard(live, {
            mode: 'live',
            docs: state.docs,
            kit,
            icons,
            help: HELP,
            parts: SYSTEM_PARTS,
            compact: true,
          })
        : '<p class="muted">Loading…</p>'
      : '';
  // A failed start from before the last save no longer describes this configuration.
  const operation =
    preview?.operation?.state === 'failed' && Date.parse(preview.operation.at) < savedAt ? null : preview?.operation;
  return quickUi.quickView({
    state,
    kit,
    esc,
    target,
    session,
    quick,
    editing: quickEditing,
    operation,
    apps: runtimeApps(),
    presets: runtimePresets(),
    restartHint: restartHint || preview?.operation?.settingsChanged === true,
    previewError,
    checking: preview === null,
    dashboard: live,
    productName: (node) => PRODUCT_OF(node.id, node.kind, node.label).name,
    mapHtml,
    mapOpen: quickMapOpen,
  });
}
// A poll never replaces a quick form the user is filling in (focused, changed or choosing a folder); the next poll catches up.
function refreshQuick(force = false) {
  const host = $('#quick');
  if (
    view !== 'quick' ||
    !host ||
    (!force &&
      (pressing ||
        document.activeElement?.closest?.('#quick form') ||
        host.querySelector('form.is-changed') ||
        $('#folder-picker').open))
  )
    return;
  // Polls repaint only what changed, so a pointer or tooltip on the page is not disturbed every few seconds.
  const html = quickHtml();
  if (!force && html === host.dataset.rendered) return;
  keepPlace(() => {
    host.innerHTML = html;
    host.dataset.rendered = html;
    afterSystem();
  });
  syncShell();
}
// A setup page opened on its own (no preview serves it) links the sidebar and top bar to a preview it found running.
// The chosen project's preview when it runs, else any running one.
function syncShell() {
  if (!state || state.runtime) return;
  const session = quickSession()?.ready
      ? quickSession()
      : ((preview?.sessions ?? []).find((item) => item.ready) ?? null),
    link = (key) => (session?.links?.[key] ? new URL(session.links[key], session.url).href : null);
  const target = session && session !== quickSession() ? quickUi.targetOf(state, session.site) : quickTarget();
  const admin = session ? (link('administration') ?? new URL('/_sim/', session.url).href) : null,
    portal = target?.parts?.website ? link('powerPages') : null;
  const area = $('#area-simulator');
  if (admin) {
    area.href = admin;
    area.removeAttribute('aria-disabled');
  } else {
    area.removeAttribute('href');
    area.setAttribute('aria-disabled', 'true');
  }
  area.querySelector('.muted').hidden = Boolean(admin);
  $('#open-simulator').hidden = !admin;
  if (admin) $('#open-simulator').href = admin;
  $('#open-portal').hidden = !portal;
  if (portal) $('#open-portal').href = portal;
  $('#setup-state').textContent = session
    ? `Preview running${session.site ? ` · ${session.site}` : ''}`
    : 'Local configuration';
}
/** The parts ticked in a Quick setup form; at least one. */
function chosenParts(data) {
  const ticked = new Set(data.getAll('part').map(String));
  if (!ticked.size) throw new Error('Choose at least one thing to run.');
  return Object.fromEntries(Object.keys(quickUi.PARTS).map((key) => [key, ticked.has(key)]));
}
async function quickSave(edits) {
  if (!edits.length) {
    quickEditing = null;
    refreshQuick(true);
    return notice('Nothing changed.');
  }
  if (!(await save({ operations: edits }))) return;
  quickEditing = null;
  if (quickSession()) restartHint = true;
  refreshQuick(true);
}
async function previewAction(action) {
  const target = quickTarget();
  if (preview?.operation?.state === 'running') return;
  if (
    action === 'stop' &&
    liveRuntime() &&
    !confirm(
      'This page is served by the preview. Stopping it also closes this page until you open setup again. Stop the preview?',
    )
  )
    return;
  // The step shows the operation at once, before the runner answers.
  preview = {
    ...(preview ?? {}),
    operation: {
      action,
      site: target?.project ? null : target?.id,
      state: 'running',
      step: action === 'stop' ? 'stop' : action === 'restart' ? 'stop' : 'start',
      at: new Date().toISOString(),
    },
  };
  refreshQuick(true);
  refreshRun(true);
  try {
    const response = await fetch('/_setup/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': state.csrf },
      body: JSON.stringify({ action, site: target?.project ? null : target?.id }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'The preview could not be changed.');
    preview = { ...(preview ?? {}), operation: data.operation };
    previewError = '';
  } catch (error) {
    previewError = error.message;
  }
  refreshQuick(true);
  refreshRun(true);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => pollPreview(), 1500);
}
// Start & check in All settings: the Quick setup run controls, repainted only when they change.
function runHtml() {
  const operation =
    preview?.operation?.state === 'failed' && Date.parse(preview.operation.at) < savedAt ? null : preview?.operation;
  const session = quickSession(),
    live = session?.ready && liveBase() ? dashboard : null;
  return (
    quickUi.runStep({
      state,
      esc,
      target: quickTarget(),
      session,
      operation,
      restartHint: restartHint || preview?.operation?.settingsChanged === true,
      previewError,
      checking: preview === null,
      presets: runtimePresets(),
      apps: runtimeApps(),
    }) +
    (session?.ready
      ? quickUi.checkStep({
          state,
          esc,
          session,
          dashboard: live,
          productName: (node) => PRODUCT_OF(node.id, node.kind, node.label).name,
        })
      : '')
  );
}
function refreshRun(force = false) {
  const host = $('#guidance-run');
  if (view !== 'all' || !host || (!force && pressing)) return;
  const html = runHtml();
  if (html !== host.dataset.rendered)
    keepPlace(() => {
      host.innerHTML = html;
      host.dataset.rendered = html;
    });
  syncShell();
}
function setView(next) {
  if (next === view) return;
  view = next === 'all' ? 'all' : 'quick';
  try {
    localStorage.setItem('paqvilo-setup-view', view);
  } catch {
    /* the choice is only a convenience */
  }
  Promise.all([view === 'quick' && !quick ? loadQuick() : null, pollPreview(true)]).then(async () => {
    await loadRuntimeInfo();
    render();
  });
  render();
}
// ---- Folder picker (Quick setup): browse the folders of this computer, see what each holds, choose one for the open form.
const picker = { kind: null, form: null, data: null };
// config: the folder is written from the settings folder; files: the picker lists files of that type and picks one.
const PICK = {
  website: {
    title: 'Choose your website export folder',
    help: 'Open folders until you reach the one that holds your website export (a website.yml file or a .powerpages-site folder). Folders that hold one are marked.',
    noun: 'website export',
  },
  solution: {
    title: 'Choose a Solution folder',
    help: 'Open folders until you reach an unpacked Solution (it holds an Other/Solution.xml file). Folders that hold one are marked.',
    noun: 'Solution',
  },
  canvas: {
    title: 'Choose a canvas app folder',
    help: 'Open folders until you reach a canvas app source folder (it holds a Src folder with .pa.yaml files). Folders that hold one are marked.',
    noun: 'canvas app',
    config: true,
  },
  codeApp: {
    title: 'Choose a code app folder',
    help: 'Open folders until you reach a code app (it holds a power.config.json file). Folders that hold one are marked.',
    noun: 'code app',
    config: true,
  },
  folder: {
    title: 'Choose a folder with model-driven scripts',
    help: 'Open the folder your build writes your form scripts to, then choose “Use this folder”.',
    noun: null,
    config: true,
  },
  'profile-file': {
    title: 'Choose a website changes file',
    help: 'Open the deployment-profiles folder of your website export and choose a .deployment.yml file.',
    files: 'profile',
  },
  'settings-file': {
    title: 'Choose a deployment settings file',
    help: 'Choose the .json deployment settings file (from pac solution create-settings) for this environment.',
    files: 'settings',
  },
};
const KIND_NAMES = {
  website: 'Website export',
  solution: 'Solution',
  canvas: 'Canvas app',
  codeApp: 'Code app',
  profiles: 'Deployment profiles',
  pack: 'Sample data module',
};
const kindText = (kind) => (kind ? `${KIND_NAMES[kind.type] ?? kind.type}${kind.name ? `: ${kind.name}` : ''}` : '');
async function openFolder(folder) {
  const here = $('#folder-picker-here');
  const spec = PICK[picker.kind],
    query = new URLSearchParams({ ...(folder ? { path: folder } : {}), ...(spec.files ? { files: spec.files } : {}) });
  try {
    picker.data = await request(`/_setup/api/folders${query.size ? `?${query}` : ''}`);
  } catch (error) {
    here.className = 'folder-picker-here';
    here.textContent = error.message;
    return;
  }
  const data = picker.data,
    match = data.kind?.type === picker.kind,
    noun = spec.noun;
  $('#folder-picker-input').value = data.path;
  here.className = `folder-picker-here${match ? ' is-match' : ''}`;
  here.textContent = spec.files
    ? data.files.length
      ? 'Choose a file below, or open a folder.'
      : 'Open folders below until the file you want is listed.'
    : !noun
      ? 'Open the folder you want, then choose “Use this folder”.'
      : match
        ? `This folder is a ${kindText(data.kind)}. Choose “Use this folder”.`
        : data.kind
          ? `This folder holds a ${kindText(data.kind)}, not a ${noun}.`
          : `This folder is not a ${noun}. Open one of the folders below.`;
  $('#folder-picker-list').innerHTML =
    (data.parent
      ? `<li><button type="button" class="folder-row" data-folder-open="${esc(data.parent)}"><span>↑ Up one folder</span></button></li>`
      : '') +
    data.files
      .map(
        (item) =>
          `<li><button type="button" class="folder-row is-file" data-file-use="${esc(item.path)}"><span>📄 ${esc(item.name)}</span><span class="tag">Use this file</span></button></li>`,
      )
      .join('') +
    (data.folders.length
      ? data.folders
          .map(
            (item) =>
              `<li><button type="button" class="folder-row" data-folder-open="${esc(item.path)}"><span>📁 ${esc(item.name)}</span>${item.kind ? `<span class="tag">${esc(kindText(item.kind))}</span>` : ''}</button></li>`,
          )
          .join('')
      : '<li class="empty">No folders inside this one.</li>');
}
function openPicker(kind, form, into = null) {
  Object.assign(picker, { kind, form, into, data: null });
  $('#folder-picker-title').textContent = PICK[kind].title;
  $('#folder-picker-help').textContent = PICK[kind].help;
  $('#folder-picker [data-folder-use]').hidden = Boolean(PICK[kind].files);
  $('#folder-picker').showModal();
  openFolder('');
}
function useFolder() {
  const { data, kind, form } = picker;
  if (!data || !form?.isConnected) return $('#folder-picker').close();
  if (
    PICK[kind].noun &&
    data.kind?.type !== kind &&
    !confirm(`This folder does not look like a ${PICK[kind].noun}. Use it anyway?`)
  )
    return;
  const into = picker.into && document.getElementById(picker.into),
    value = PICK[kind].config ? data.config : data.value;
  if (into) {
    // A list field gets the folder as a new line; a single field takes it as its value.
    if (into.tagName === 'TEXTAREA') {
      const rows = lines(into.value);
      if (!rows.some((row) => quickUi.normalPath(row) === quickUi.normalPath(value)))
        into.value = [...rows, value].join('\n');
    } else into.value = value;
    into.dispatchEvent(new Event('input', { bubbles: true }));
    return $('#folder-picker').close();
  }
  const found = [...form.querySelectorAll(`input[name="${kind}"]`)].find(
    (input) => input.value && quickUi.normalPath(input.value) === quickUi.normalPath(data.value),
  );
  if (found) found.checked = true;
  else if (kind === 'website') {
    form.querySelector('[name="website-other"]').value = data.value;
    form.querySelector('[data-picked="website"]').innerHTML = `<code>${esc(data.shown)}</code>`;
    form.querySelector('input[name="website"][value=""]').checked = true;
  } else
    form
      .querySelector('[data-folder-list="solution"]')
      .insertAdjacentHTML('beforeend', quickUi.folderRowHtml(esc, 'solution', data.value, data.shown));
  form.classList.add('is-changed');
  $('#folder-picker').close();
}
// A picked file: inside the project's website export it is written from there (the export can move), else from the settings folder.
function useFile(file) {
  const item = picker.data?.files.find((entry) => entry.path === file),
    into = picker.into && document.getElementById(picker.into);
  if (!item || !into?.isConnected) return $('#folder-picker').close();
  const exportDir = String(into.closest('[data-source-dir]')?.dataset.sourceDir ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, ''),
    path = item.path.replace(/\\/g, '/');
  const inside = exportDir && path.toLowerCase().startsWith(`${exportDir.toLowerCase()}/`);
  into.value = inside ? path.slice(exportDir.length + 1) : item.value;
  const holder = into.closest('.pick-field'),
    base = holder?.querySelector('[name$="-base"]');
  if (base) base.value = inside ? 'source' : '';
  const label = holder?.querySelector('[data-profile-base]');
  if (label) label.textContent = inside ? BASES.source : BASES[''];
  into.dispatchEvent(new Event('input', { bubbles: true }));
  $('#folder-picker').close();
}
$('#folder-picker').addEventListener('click', (event) => {
  const fileRow = event.target.closest('[data-file-use]');
  if (fileRow) return useFile(fileRow.dataset.fileUse);
  const open = event.target.closest('[data-folder-open]');
  if (open) return openFolder(open.dataset.folderOpen);
  if (event.target.closest('[data-folder-go]')) return openFolder($('#folder-picker-input').value.trim());
  if (event.target.closest('[data-folder-use]')) useFolder();
});
$('#folder-picker-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    openFolder(event.target.value.trim());
  }
});
$('#folder-picker').addEventListener('close', () => {
  (picker.into
    ? document.getElementById(picker.into)
    : picker.form?.querySelector(`[data-pick-folder="${picker.kind}"]`)
  )?.focus();
});
function showNode(id) {
  const node = (currentPayload().nodes ?? []).find((item) => item.id === id),
    slot = $('#dashboard-node-detail');
  if (!node || !slot) return;
  nodeId = id;
  slot.innerHTML = nodeDetail(node);
  slot.querySelector('[data-drawer-close]')?.focus();
}
function copyCommand(id) {
  const text = document.getElementById(id)?.textContent ?? '';
  if (!navigator.clipboard)
    return notice('Clipboard access is unavailable here; select the command and copy it.', true);
  navigator.clipboard.writeText(text).then(
    () => notice('Command copied.'),
    () => notice('Copying was refused; select the command and copy it.', true),
  );
}

// ---- Section bodies
const RESTART_TEXT = {
  true: [
    'restart needed',
    'warn',
    'The saved configuration differs from the one the preview started with. Stop the preview, then start it again with the command shown.',
  ],
  false: [
    'matches this configuration',
    'ok',
    'The running preview matches this configuration. After further saves, stop the preview and start it again with the command shown.',
  ],
  null: [
    'restart to be sure',
    'warn',
    'The configuration could not be compared with the running preview, so a restart may be needed.',
  ],
};
// The running preview in one line: state, restart need and the restart command; the explanations sit behind (i).
function runtimeBanner(runtime) {
  const known = typeof runtime.restartRequired === 'boolean' ? runtime.restartRequired : null,
    [status, tone, text] = RESTART_TEXT[known];
  const details = [
    text,
    known === null && runtime.restartReason ? `Reason: ${runtime.restartReason}.` : '',
    runtime.restartScope ? `The comparison covers ${runtime.restartScope}.` : '',
    helpText('setup.start.restart'),
    runtime.sourceDir ? `Running source: ${runtime.sourceDir}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    `<div class="status-line"><span class="status-dot ready" aria-hidden="true"></span><strong>${esc(runtime.product)} preview running${runtime.site ? ` · ${esc(runtime.site)}` : ''}</strong>${kit.badge(status, tone)}${note(details, 'About the running preview')}` +
    (runtime.restartCommand
      ? `<code id="restart-command" class="command-text">${esc(runtime.restartCommand)}</code><button type="button" class="button quiet small" data-copy="restart-command">Copy</button>`
      : '') +
    '</div>'
  );
}
function createFlow() {
  const project = state.kind === 'project',
    templates = state.templates ?? [];
  const file = fileName(state.layers.shared.file) || (project ? 'mirage.project.json' : 'paqvilo.config.yml'),
    folder = String(state.directory ?? '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop();
  const found = quick?.candidates ?? { portals: [], solutions: [], packs: [] },
    count = (items, word) => items.length && `${items.length} ${word}${items.length === 1 ? '' : 's'}`;
  const seen = [
    count(found.portals, 'website export'),
    count(found.solutions, 'Solution'),
    count(found.packs, 'sample data module'),
  ].filter(Boolean);
  return (
    `<p>Paqvilo keeps your choices in one settings file, <code>${esc(file)}</code>, in <code>${esc(state.directory)}</code>. Create it here, then go through the stages on the left in order.</p>` +
    `<form class="form-grid" data-form="create">${quickUi.partsFieldset(esc, quickUi.foundParts(found))}${quickUi.websitesFieldset(esc, found.portals)}<div class="inline-fields">${field('Project name', 'id', quickUi.slugName(folder), 'The name of this setup in the settings file and in the simulator: letters, numbers and hyphens. Keep the suggestion if unsure. With several websites, each project is named after its website instead.', 'text', { id: 'create-name' })}</div>` +
    `${check(seen.length ? `Use the exported files found in this folder: ${seen.join(', ')}` : 'Use the exported files found in this folder (none found yet)', 'use-found', seen.length > 0, 'create-use-found', 'Fills in the website export, Solution and sample data folders found up to four folders deep. Untick it to choose every folder yourself under Exported files.')}` +
    `<div class="toolbar"><button type="submit" class="button primary">Create ${project ? 'project file' : 'settings file'}</button></div></form>` +
    (templates.length
      ? `<details class="disclosure" data-section-key="templates"><summary>Or, instead, start from an example settings file (shows more features)</summary><p class="muted small">Example settings files whose folders and website addresses are examples: you replace them with your own afterwards. Use the form above if unsure.</p><form class="form-grid" data-form="template" id="form-template"><fieldset class="templates"><legend class="ui-sr-only">Example setups</legend>${templates
          .map(
            (item, index) =>
              `<label class="template" for="template-${esc(item.id)}"><span class="template-head"><input type="radio" id="template-${esc(item.id)}" name="template" value="${esc(item.id)}" ${index === 0 ? 'checked' : ''}><strong>${esc(item.title)}</strong>` +
              `${kit.info({ label: 'Expected next steps', text: `Expected next steps, not errors: ${(item.expectedFindings ?? []).map((code) => FINDING_STEPS[code] ?? code).join('; ') || 'none'}.`, steps: item.nextSteps ?? [] })}</span>` +
              `<span class="template-text">${esc(item.description)}</span></label>`,
          )
          .join('')}</fieldset>` +
        `<div class="inline-fields">${field('Project name', 'id', quickUi.slugName(folder), 'Letters, numbers and hyphens.', 'text', { id: 'template-target' })}${withPick(field('Exported folder', 'root', '', 'Your website export folder, or a Solution folder for the app and API examples. Empty keeps the example folder, which you change later.', 'text', { id: 'template-root' }), 'website', 'template-root')}</div>` +
        '<div class="toolbar"><button type="submit" class="button">Create from example</button></div></form></details>'
      : '')
  );
}
// Where saves go: the shared or personal catalogue layer (the file is named in its tooltip); linked project files are listed under Configuration & rules.
function layerControl(personal) {
  const file = state.layers[layer]?.file ?? '';
  const text = [
    'Leave this on shared unless you want a setting only on your own computer (personal).',
    `Saves write ${file}.`,
    layer === 'personal'
      ? 'Personal overrides merge with shared settings; removing one reveals its shared value. Ignore paqvilo.config.local.yml in Git before using personal settings.'
      : '',
    state.kind === 'project'
      ? 'A standalone project file has no personal layer: every guided form writes the project file.'
      : '',
    helpText('setup.project.layers'),
  ]
    .filter(Boolean)
    .join(' ');
  return (
    `<span class="save-target"><label for="layer">Save to</label>${
      personal
        ? `<select id="layer" class="compact-select">${optionList(
            [
              ['shared', 'shared'],
              ['personal', 'personal'],
            ],
            layer,
          )}</select>`
        : kit.badge(state.kind === 'project' ? 'Project file' : 'Shared project')
    }` +
    `<span class="code-text muted">${esc(fileName(file))}</span>${kit.info({ label: 'About the save target', text, docs: HELP['setup.project.layers']?.doc ? [kit.docLink(HELP['setup.project.layers'].doc, state.docs)] : [] })}</span>`
  );
}
// The status strip: readiness, the running preview, where saves go, and the findings that need a step.
function overviewBody(personal) {
  const expected = new Set((state.templates ?? []).flatMap((item) => item.expectedFindings ?? []));
  const anchor = (section) => (/^#[a-z0-9-]+$/i.test(section ?? '') ? section : '#overview');
  const stages = stagesNow(),
    count = state.findings.length,
    created = state.layers.shared.exists;
  const ready = kit.badge(
    count ? `${count} next step${count === 1 ? '' : 's'}` : 'Configuration ready',
    count ? 'warn' : 'ok',
  );
  const head =
    `<div class="status-line"><strong>${created ? 'Project' : state.kind === 'project' ? 'Create your project file' : 'Create your settings file'}</strong>${ready}` +
    `${stages.length ? `<span class="muted">${stages.filter((item) => item.status === 'done').length} of ${stages.length} stages done</span>` : ''}` +
    `${sectionHelp('the project', 'Shows whether your settings file and folders are complete. It checks files on this computer only: start the preview to see your project run.', 'project')}${created ? layerControl(personal) : ''}</div>`;
  return (
    head +
    (state.runtime ? runtimeBanner(state.runtime) : '') +
    (!created ? createFlow() : '') +
    (state.findings.some((item) => expected.has(item.code))
      ? '<p class="muted small">Items marked “next step” are expected after creating a project: they name the folders and addresses you still choose. They are not errors.</p>'
      : '') +
    // A linked-project finding opens its document in the YAML editor.
    (count
      ? `<ul class="detail-list findings">${state.findings.map((item) => `<li class="row"><span>${item.site ? `<strong>${esc(item.site)}</strong> · ` : ''}${esc(item.message)} ${expected.has(item.code) ? kit.badge('next step', 'info') : kit.badge('needs attention', 'warn')}</span><a href="${esc(anchor(item.section))}"${item.layer && state.layers[item.layer] ? ` data-yaml-layer="${esc(item.layer)}"` : ''}>Review</a></li>`).join('')}</ul>`
      : '')
  );
}
function runtimeBody() {
  const editors =
    state.kind === 'project'
      ? runtimeEditor(state.settings)
      : state.sites
          .map(
            (site) =>
              `<details class="disclosure" data-section-key="runtime-${esc(site.id)}"${state.sites.length === 1 ? ' open' : ''}><summary>${esc(site.id)} · ${esc(partsName(site.id))}</summary>${runtimeEditor(site.effectiveMirage ?? site.mirage, site)}</details>`,
          )
          .join('');
  return editors + settingEditor('runtime-configuration');
}
// One card per project; a website found here and not used yet is offered as another project.
function portalsBody() {
  const sites =
    state.kind === 'project'
      ? state.sites.length
        ? state.sites
        : [{ id: 'project', runtime: state.settings.runtime, mirage: state.settings, sourceStatus: {} }]
      : state.sites;
  const cards = sites
    .map(
      (site) =>
        `<section class="panel target-card" id="portal-${esc(site.id)}"><div class="panel-heading"><h3>${esc(site.id)}</h3>${kit.badge(partsName(site.id), 'neutral')}</div>` +
        `${(!site.runtime?.kind || site.runtime.kind === 'power-pages') && site.sourceStatus ? source(site) : ''}` +
        `${(site.solutions ?? state.solutions ?? []).length ? `<p class="muted">${(site.solutions ?? state.solutions).length} Solution folder(s) · ${(site.solutions ?? state.solutions).filter((item) => item.exists).length} found</p>` : ''}` +
        `<details class="disclosure" data-section-key="files-${esc(site.id)}"${sites.length === 1 ? ' open' : ''}><summary>Folders and files of ${esc(site.id)}</summary>${siteEditor(site)}</details></section>`,
    )
    .join('');
  const used = new Set(state.sites.map((site) => quickUi.normalPath(site.source)));
  const unused = (quick?.candidates?.portals ?? []).filter((item) => !used.has(quickUi.normalPath(item.value)));
  const addWebsite =
    state.kind === 'catalogue'
      ? `<details class="disclosure" data-section-key="add-target"${unused.length ? ' open' : ''}><summary>Add another website (each website is its own project with its own address)</summary><form class="form-grid" data-form="add">` +
        (unused.length
          ? `<fieldset class="quick-group"><legend>Website exports found here and not used yet</legend>${unused.map((item, index) => `<label class="checkbox-line"><input type="radio" name="found-website" value="${esc(item.value)}" data-name="${esc(quickUi.slugName(item.name ?? item.value.split('/').pop()))}" ${index ? '' : 'checked'}><span><strong>${esc(item.name ?? item.path)}</strong> <code>${esc(item.path)}</code></span></label>`).join('')}<label class="checkbox-line"><input type="radio" name="found-website" value=""${unused.length ? '' : ' checked'}>Another folder</label></fieldset>`
          : '<input type="hidden" name="found-website" value="">') +
        `<div class="inline-fields">${field('Project name', 'id', unused.length ? quickUi.slugName(unused[0].name ?? unused[0].value.split('/').pop()) : '', 'A short name: letters, numbers and hyphens.', 'text', { id: 'add-target-name' })}${withPick(field('Website export folder', 'source', '', 'Only for another folder; relative to the export root.', 'text', { id: 'add-target-source' }), 'website', 'add-target-source')}</div>` +
        `${quickUi.partsFieldset(esc, { website: true })}<div class="toolbar"><button type="submit" class="button primary">Add project</button><span class="muted">It gets its own local port; start it from Start &amp; check.</span></div></form></details>`
      : '';
  return `<div class="grid-two">${cards}</div>${addWebsite}` + settingEditor('portals');
}
function environmentsBody() {
  const portals =
    state.kind === 'catalogue'
      ? state.sites.filter((site) => !site.runtime?.kind || site.runtime.kind === 'power-pages')
      : [];
  if (!portals.length)
    return '<p class="muted">Live environments belong to websites in a settings file. Nothing here needs one.</p>';
  return (
    portals
      .map(
        (site) =>
          `<details class="disclosure" data-section-key="environments-${esc(site.id)}"${portals.length === 1 ? ' open' : ''}><summary>${esc(site.id)} · ${Object.keys(site.environments).length} environment(s)</summary>${environmentsEditor(site)}</details>`,
      )
      .join('') + settingEditor('environments')
  );
}
function packsBody() {
  const target = quickTarget(),
    choose = needsStartingData()
      ? `<p class="quick-hint">No starting data is chosen, so your tables start empty. ${quickSession()?.ready ? `<a class="button small" href="#data-${esc(slug(target.id))}-preset">Choose starting data</a>` : 'Start the preview (under Start & check), then come back here: its data sets are listed once it runs.'}</p>`
      : '';
  const forms =
    state.kind === 'project'
      ? dataEditor(null)
      : state.sites
          .map(
            (site) =>
              `<details class="disclosure" data-section-key="data-${esc(site.id)}"${state.sites.length === 1 ? ' open' : ''}><summary>${esc(site.id)} · ${site.packs?.length ? `${site.packs.length} module(s)` : 'no sample data'}</summary>${dataEditor(site)}</details>`,
          )
          .join('');
  return (
    choose +
    forms +
    `<p>${simLink('packs', 'See what the preview loaded from each module')}</p>` +
    settingEditor('packs')
  );
}
function personasForm(site) {
  const key = slug(site.id),
    mirage = site.mirage ?? {},
    contexts = mirage.personaContexts ?? {},
    provider = mirage.identityProvider ?? {};
  return (
    `<form class="form-grid" data-form="personas" data-site="${esc(site.id)}" id="personas-${key}"><div class="inline-fields">${field('Test people signed in side by side', 'maxInstances', contexts.maxInstances ?? '', 'How many separate browser sessions can each be signed in as a different test person at the same time, from 0 to 32. 0 turns this off; empty uses 4.', 'number', { id: `personas-${key}-max`, placeholder: '4' })}` +
    `${choice(
      'How the test sign-in appears',
      'presentation',
      [
        ['', 'Default'],
        ['page', 'As a page'],
        ['dialog', 'As a dialog'],
      ],
      provider.presentation,
      `personas-${key}-presentation`,
      'When you use Sign in on the website, the local preview asks which test person you are, on a page or in a dialog.',
    )}</div>` +
    `${field('Title of the test sign-in', 'title', provider.title ?? '', 'The heading shown on that sign-in page or dialog. Empty uses the default.', 'text', { id: `personas-${key}-title` })}<div class="toolbar"><button type="submit" class="button primary">Save</button></div></form>`
  );
}
const SCENARIOS_TEXT =
  'Test people are the contacts and staff users in your data. Here you choose how many can be signed in at once and how the test sign-in looks. To sign in as someone, use Sign in on the website, or the simulator (Administration → Portal identity & permissions). Saved scenarios (a data set, a person and their permissions) are kept in the simulator under Scenarios.';
function personasBody() {
  const portals =
    state.kind === 'catalogue'
      ? state.sites.filter((site) => !site.runtime?.kind || site.runtime.kind === 'power-pages')
      : [];
  if (state.kind === 'catalogue' && !portals.length)
    return (
      '<p class="muted">Test people sign in to a website; none of your projects has one. Staff users of the apps and the Web API are under Web API access.</p>' +
      settingEditor('personas')
    );
  return (
    (state.kind === 'catalogue'
      ? portals
          .map(
            (site) =>
              `<details class="disclosure" data-section-key="personas-${esc(site.id)}"${state.sites.length === 1 ? ' open' : ''}><summary>${esc(site.id)} · test people and sign-in</summary>${personasForm(site)}</details>`,
          )
          .join('')
      : kit.notice(
          'These settings belong to websites in a settings file; a standalone project file does not take them. Test people still come from the contacts in your data.',
          'neutral',
        )) +
    `<p class="row">${simLink('access', 'Sign in as a test person, and manage test people and permissions')}</p>` +
    settingEditor('personas')
  );
}
// Provider keys have no dedicated form: the setting editor below lists them; their reference sits in the section guidance.
const PROVIDER_KEYS = ['storage', 'messaging', 'connections', 'secrets', 'localServices', 'serviceFixtures'];
// Services you run yourself (localServices): the preview never starts them; it checks that each one answers.
const SERVICE_KINDS = [
  ['http', 'A web service (Azure Functions, a webhook receiver, any http service)'],
  ['azure-storage', 'Azure Storage emulator (Azurite)'],
  ['service-bus', 'Service Bus emulator'],
];
const SERVICE_ADDRESS_HELP =
  'Where it answers on this computer: http://127.0.0.1:<port> or http://localhost:<port>. Azure Functions usually use port 7071; Azurite blob storage is http://127.0.0.1:10000/devstoreaccount1. For the Service Bus emulator, write the name of the environment variable that holds its connection string instead (never the connection string itself).';
function serviceRow(id = '', entry = {}) {
  const address =
    entry.kind === 'service-bus' ? (entry.connectionStringVariable ?? '') : (entry.baseUrl ?? entry.blob ?? '');
  return (
    `<div class="environment-editor" data-service><div class="inline-fields">${field('Name', 'svc-id', id, 'A short name, for example functions or blob-storage: letters, numbers and hyphens.')}${choice('What it is', 'svc-kind', SERVICE_KINDS, entry.kind ?? 'http')}</div>` +
    `<div class="inline-fields">${field('Address', 'svc-address', address, SERVICE_ADDRESS_HELP)}${field('Path to check (optional)', 'svc-probe', entry.probe ?? '', 'A page of the service that answers when it is up, for example /admin/host/status for Azure Functions. Empty checks the address itself.')}</div>` +
    '<div class="row"><button class="button" type="button" data-remove-service>Remove</button></div></div>'
  );
}
function servicesForm(site) {
  const project = state.kind === 'project',
    services =
      (project ? state.layers.shared.values?.localServices : (site.authoredMirage ?? site.mirage)?.localServices) ?? {};
  return (
    `<form class="form-grid" data-form="services" ${site ? `data-site="${esc(site.id)}"` : ''} id="services-${esc(slug(site?.id ?? 'project'))}"><div data-services>${Object.entries(
      services,
    )
      .map(([id, entry]) => serviceRow(id, entry))
      .join('')}</div>` +
    `<div class="row"><button type="button" class="button" data-add-service>Add a service</button></div><div class="toolbar"><button type="submit" class="button primary">Save</button><span class="muted">Applies when the preview restarts.</span></div></form>`
  );
}
function providersBody() {
  const forms =
    state.kind === 'project'
      ? servicesForm(null)
      : state.sites
          .map(
            (site) =>
              `<details class="disclosure" data-section-key="services-${esc(site.id)}"${state.sites.length === 1 ? ' open' : ''}><summary>${esc(site.id)} · ${Object.keys((site.authoredMirage ?? site.mirage)?.localServices ?? {}).length} service(s) you run yourself</summary>${servicesForm(site)}</details>`,
          )
          .join('');
  return (
    '<p class="muted">Optional. Skip this unless your project calls outside services.</p>' +
    `<div class="title-row"><h3>Services you run yourself</h3>${note('Programs you start on this computer that your project calls, such as Azure Functions, Azurite or the Service Bus emulator. The preview never starts them; it checks that each one answers and shows the result in the simulator (Services). Where file columns and notes are stored is the storage setting under More settings below, not this list.', 'About services you run yourself')}</div>` +
    forms +
    `<p>${simLink('services', 'See which services the preview found and how they answer')}</p>` +
    settingEditor('providers')
  );
}
function identityForm(settings, site) {
  const dataverse = settings?.dataverse ?? {},
    key = site ? slug(site.id) : 'project',
    id = (name) => `identity-${key}-${name}`;
  const declared = [
    ['user', dataverse.users],
    ['app registration', dataverse.applications],
  ]
    .map(([word, items]) => `${(items ?? []).length} ${word}${(items ?? []).length === 1 ? '' : 's'}`)
    .join(' and ');
  return (
    `<form class="form-grid" data-form="identity" id="identity-${key}" ${site ? `data-site="${esc(site.id)}"` : ''}>` +
    `<div class="inline-fields">${check('Also serve the Web API over a secure (https) address', 'tls', dataverse.tls === true, id('tls'), 'For clients that refuse plain http. Turn the Web API itself on under What to run.')}${field('Secure port', 'tlsPort', dataverse.tlsPort ?? '', '0 picks a free port at every start.', 'number', { id: id('tls-port') })}</div>` +
    field(
      'Tenant ID',
      'tenantId',
      dataverse.tenantId ?? '',
      'The tenant id (a GUID) of the simulated organization. Leave it empty unless your scripts expect a specific one.',
      'text',
      { id: id('tenant') },
    ) +
    `<p class="muted small">Web API users and app registrations: add them in the simulator once the preview runs (the button below), where you also see their sign-in details. The settings file now declares ${esc(declared)} that exist from the very first start.</p>` +
    `<details class="disclosure"${site ? ` data-section-key="identity-users-${esc(site.id)}"` : ''}><summary>Users from the very first start (for developers)</summary><p class="muted small">Add them to the settings file under the Settings file stage, at <code>${esc(site ? `sites.${site.id}.mirage.dataverse.users` : 'dataverse.users')}</code>. Each user needs a sign-in name (domainname) and a display name (fullname):</p>` +
    `<pre class="ui-example">${esc(`${site ? `sites:\n  ${site.id}:\n    mirage:\n      ` : ''}dataverse:\n${site ? '        ' : '  '}users:\n${site ? '          ' : '    '}- domainname: alex@example.test\n${site ? '            ' : '      '}fullname: Alex Example`)}</pre></details>` +
    '<div class="toolbar"><button type="submit" class="button primary">Save identity &amp; API</button></div></form>'
  );
}
function identityBody() {
  const forms =
    state.kind === 'project'
      ? identityForm(state.settings)
      : state.sites
          .map(
            (site) =>
              `<details class="disclosure" data-section-key="identity-${esc(site.id)}"><summary>${esc(site.id)} · secure address and tenant</summary>${identityForm(site.mirage ?? {}, site)}</details>`,
          )
          .join('');
  return (
    forms + `<p>${simLink('dataverse', 'Manage Web API users and app registrations')}</p>` + settingEditor('identity')
  );
}
function settingsBody() {
  let form = '<p>Edit the project document in Configuration below.</p>';
  if (state.kind === 'catalogue' && state.settings.browser) {
    const browser = state.settings.browser,
      doc = (key) => catalogueDoc(key);
    form =
      `<form class="form-grid" data-form="settings"><div class="inline-fields">${field('Folder that export paths start from', 'sourceRoot', state.settings.sourceRoot, `Export folders in this file are relative to this folder, which is relative to the settings file. . means the project folder.${state.settings.resolvedSourceRoot ? ` Now: ${state.settings.resolvedSourceRoot} (${state.settings.provenance?.sourceRoot}).` : ''}`, 'text', { id: 'settings-source-root' })}${choice('Default project', 'defaultSite', [['', 'Not set'], ...state.sites.map((site) => [site.id, site.id])], state.settings.defaultSite, 'settings-default-site', 'The project that commands and this page use when none is named.')}` +
      `${choice(
        'Browser for Lense',
        'browser',
        [
          ['msedge', 'Microsoft Edge'],
          ['chrome', 'Google Chrome'],
          ['chromium', 'Chromium'],
        ],
        browser.channel,
        'settings-browser',
        'Lense is the Paqvilo tool that shows your local files on your live website; this is the browser it opens. The local preview opens in any browser.',
      )}${choice(
        'Projects that start together',
        'portals',
        [
          ['selected', 'The default project'],
          ['all', 'All projects'],
        ],
        state.settings.portals,
        'settings-portals',
        'Which projects a development command starts when none is named.',
      )}</div><div class="row check-row"><label class="checkbox-line"><input name="liveReload" type="checkbox" ${state.settings.liveReload ? 'checked' : ''}>Reload the page when you save a file</label>${note('When you save a file of your export, the open page reloads by itself.', 'About reloading on save')}<label class="checkbox-line"><input name="panel" type="checkbox" ${state.settings.panel ? 'checked' : ''}>Show the Paqvilo panel on pages</label>${note('A small Paqvilo panel on each page shows which local files it uses.', 'About the Paqvilo panel')}` +
      check(
        'Include environments marked as holding real customer data when a command runs on all of them',
        'includeCaution',
        state.settings.includeCaution === true,
        'settings-include-caution',
        doc('includeCaution'),
      ) +
      '</div>' +
      `<details class="disclosure" data-section-key="settings-browser"><summary>Browser profile, debugging, agent and editor</summary>` +
      `<div class="inline-fields">${check('Run the browser without a window', 'headless', browser.headless === true, 'settings-headless', doc('browser.headless'))}${check('Bypass the page content security policy', 'bypassCSP', browser.bypassCSP === true, 'settings-bypass-csp', doc('browser.bypassCSP'))}${check('Expose the bounded Lense agent API', 'agentEnabled', state.settings.agent?.enabled === true, 'settings-agent', doc('agent.enabled'))}${check('Map overlaid resources to source files', 'sourceMaps', state.settings.sourceMaps === true, 'settings-source-maps', doc('sourceMaps'))}</div>` +
      `<div class="inline-fields">${field('Profile folder', 'profileDir', browser.profileDir ?? '', doc('browser.profileDir'), 'text', { id: 'settings-profile-dir' })}${field('Named profile', 'profile', browser.profile ?? '', doc('browser.profile'), 'text', { id: 'settings-profile' })}${field('Existing user data folder', 'userDataDir', browser.userDataDir ?? '', doc('browser.userDataDir'), 'text', { id: 'settings-user-data' })}${field('Profile directory', 'profileDirectory', browser.profileDirectory ?? '', doc('browser.profileDirectory'), 'text', { id: 'settings-profile-directory' })}</div>` +
      `<div class="inline-fields">${field('DevTools endpoint (cdpUrl)', 'cdpUrl', browser.cdpUrl ?? '', doc('browser.cdpUrl'), 'text', { id: 'settings-cdp' })}${field('Remote debugging port', 'debugPort', browser.debugPort ?? '', doc('browser.debugPort'), 'number', { id: 'settings-debug-port' })}${field('Editor command', 'editor', state.settings.editor ?? '', doc('editor'), 'text', { id: 'settings-editor' })}</div></details>` +
      '<div class="toolbar"><button type="submit" class="button primary">Save</button></div></form>';
  } else if (state.kind === 'project') {
    const settings = state.settings;
    form =
      `<form class="form-grid" data-form="project-settings" id="project-settings"><div class="inline-fields">${field('Locale ID (lcid)', 'lcid', settings.lcid ?? '', `${catalogueDoc('lcid')} Empty keeps the file value.`, 'number', { id: 'project-lcid', placeholder: '1033' })}${field('State folder', 'stateDirectory', settings.stateDirectory ?? '', `${catalogueDoc('stateDirectory')} Empty keeps the file value.`, 'text', { id: 'project-state-directory' })}` +
      `${choice(
        'Reload when sources change',
        'watch',
        [
          ['', 'Keep the file value'],
          ['true', 'true'],
          ['false', 'false'],
        ],
        settings.watch === undefined ? '' : String(settings.watch),
        'project-watch',
        catalogueDoc('watch'),
      )}</div><div class="toolbar"><button type="submit" class="button primary">Save project settings</button></div></form>`;
  }
  const overrides = Object.entries(state.settings.effective ?? {});
  return (
    form +
    (overrides.length
      ? `<p class="muted">${overrides.map(([key, setting]) => `<code>${esc(key)}</code> = ${esc(setting.value)} · ${esc(setting.origin)} overrides file defaults`).join('<br>')}</p>`
      : '') +
    settingEditor('settings')
  );
}
function advancedBody() {
  const documents = Object.keys(state.layers).filter(
    (key) => key === 'shared' || key === 'personal' || key.startsWith('project:'),
  );
  const current = state.layers[yamlLayer] ? yamlLayer : layer,
    linked = Object.entries(state.layers).filter(([key]) => key.startsWith('project:'));
  const editorNote =
    'Use the full document for inline mapping, observations with evidence, packs and other supported settings. Invalid changes stay here until corrected; guided forms preserve unrelated configuration. The editor shows the document verbatim, as saved: it is the only place on this page that shows secrets and connection settings entries (elsewhere they appear as names only). A secrets protectedValue is machine-bound DPAPI ciphertext, not a secret value; secret values never belong in configuration.';
  return (
    `<form class="form-grid" data-form="yaml">${
      documents.length > 1
        ? choice(
            'Document',
            'yaml-layer',
            documents.map((key) => [key, `${key} · ${fileName(state.layers[key].file)}`]),
            current,
            'yaml-layer',
            'The shared and personal catalogue layers and linked Mirage project files.',
          )
        : ''
    }<label><span class="field-label">${esc(current)} configuration${kit.info({ label: 'About the configuration document', text: editorNote, docs: state.docs?.configuration?.href ? [{ href: state.docs.configuration.href, label: 'Settings reference', path: 'docs/configuration.md' }] : [] })}</span><textarea name="yaml" class="ui-mono yaml" spellcheck="false">${esc(state.layers[current]?.text || '{}\n')}</textarea></label>` +
    '<div class="toolbar"><button type="submit" class="button primary">Validate & save document</button></div></form>' +
    (linked.length
      ? `<div class="title-row"><h3>Linked Mirage project files</h3>${note('Project-only keys of a target live in its sites.<id>.mirage.project file. Rows of the setting editor marked project:<target> save there.')}</div>${list(
          'linked-projects',
          linked.map(([key, item]) => ({ key, ...item })),
          [
            { label: 'Layer', render: (item) => `<code>${esc(item.key)}</code>` },
            { label: 'File', render: (item) => `<span class="code-text source-path">${esc(item.file)}</span>` },
            {
              label: 'Status',
              render: (item) => kit.badge(item.exists ? 'found' : 'missing', item.exists ? 'ok' : 'warn'),
            },
          ],
          { caption: 'Linked project files' },
        )}`
      : '') +
    settingEditor('advanced')
  );
}
function guidanceBody() {
  // Arguments quoted by the server (status.commandArgs), as the restart command quotes them.
  const project = state.kind === 'project',
    arg = esc(state.commandArgs?.file ?? ''),
    at = state.commandArgs?.site ? ` ${esc(state.commandArgs.site)}` : '';
  const steps = [
    [
      'Install and check',
      'In a scaffold, run <code>npm run setup</code>; otherwise <code>npx paqvilo doctor --setup</code>.',
    ],
    [
      'Scaffold or compare',
      `${project ? '' : '<code>npx paqvilo init --check</code> lists remaining scaffold tasks. '}<code>npx paqvilo mirage demo</code> copies the shipped example project.`,
    ],
    [
      'Inspect',
      project ? `<code>npx paqvilo mirage inspect ${arg}</code>` : `<code>npx paqvilo lense doctor ${arg} --all</code>`,
    ],
    [
      'Generate data (optional)',
      `<code>npx paqvilo mirage data scaffold --profile smoke --state .paqvilo/smoke-state.json ${arg}${at}</code>`,
    ],
    ...(project
      ? []
      : [
          [
            'Standalone project (optional)',
            `<code>npx paqvilo mirage init ${arg}${at}</code>, then <code>npx paqvilo setup --project &lt;file&gt;</code>`,
          ],
        ]),
    [
      'Start a preview',
      project
        ? `<code>npx paqvilo mirage serve ${arg}</code>`
        : `<code>npx paqvilo mirage dev ${arg}${at}</code> locally, or <code>npx paqvilo lense dev ${arg}${at}</code> for an authorized environment`,
    ],
  ];
  // One row per guide: several keys can name the same document.
  const docs = [
    ...new Map(
      Object.entries(state.docs ?? {})
        .map(([key, link]) => ({
          key,
          ...(link && typeof link === 'object' ? link : { href: link, path: key, label: key }),
        }))
        .map((item) => [item.href ?? item.path, item]),
    ).values(),
  ];
  const featured = ['setupWorkspace', 'configuration', 'packs', 'simulation', 'personaCatalog', 'dataverseApi']
    .map((key) => docs.find((item) => item.key === key))
    .filter((item) => item?.href);
  // Each project (website) runs as a preview of its own: with several, the person picks the one to start, open or stop.
  const sites = state.kind === 'catalogue' ? state.sites : [],
    target = quickTarget();
  const choose =
    sites.length > 1
      ? `<label class="quick-target">Project <select id="run-site" class="compact-select">${sites.map((site) => `<option value="${esc(site.id)}" ${site.id === target?.id ? 'selected' : ''}>${esc(site.id)}</option>`).join('')}</select></label>`
      : '';
  return (
    `<div class="title-row"><h3>Run your project</h3></div>${choose ? `<p class="run-site">${choose} <span class="muted small">Each website runs as a preview of its own.</span></p>` : ''}<div id="guidance-run" class="quick-run">${runHtml()}</div>` +
    `<p class="row">${simLink('capabilities', 'Check what the project needs that the preview cannot provide')} ${simLink('dashboard', 'Open the live system map')}</p>` +
    `<details class="disclosure" data-section-key="commands"><summary>For developers: terminal commands</summary><div class="title-row"><h3>Commands for this configuration</h3>${note(`Run these from ${state.directory}. Setup never deploys, synchronizes, installs, imports pack code or contacts a live portal. Lense browser actions can affect live data; follow the user's scope and let them handle sign-in and MFA. Paqvilo ${state.version}: guide links open this release's tag (main for prereleases); the installed CLI --help and bundled docs describe the installed version.`, 'About these commands')}</div>` +
    `<dl class="command-list">${steps.map(([title, text]) => `<dt>${esc(title)}</dt><dd>${text}</dd>`).join('')}</dl>` +
    `<div class="toolbar">${featured.map((item) => `<a href="${esc(item.href)}" target="_blank" rel="noreferrer">${esc(item.label)} ↗</a>`).join('')}</div></details>` +
    `<details class="disclosure" data-section-key="docs-all"><summary>All guides (${docs.length})</summary>${list(
      'docs',
      docs,
      [
        {
          label: 'Guide',
          render: (item) =>
            item.href
              ? `<a href="${esc(item.href)}" target="_blank" rel="noreferrer">${esc(item.label)} ↗</a>`
              : esc(item.label),
        },
        { label: 'Repository path', render: (item) => `<code>${esc(item.path)}</code>` },
      ],
      { caption: 'Documentation', text: (item) => `${item.key} ${item.label} ${item.path}` },
    )}</details>`
  );
}
const providerHelp = () =>
  PROVIDER_KEYS.map(
    (name) => HELP[`setup.providers.${name}`] && `${name}: ${HELP[`setup.providers.${name}`].intro}`,
  ).filter(Boolean);

function render() {
  const runtime = state.runtime;
  const navigation = $('#runtime-navigation');
  const portalUrl =
    runtime?.links?.powerPages ??
    runtime?.portalUrl ??
    (runtime?.product === 'Mirage' && (!runtime.kind || runtime.kind === 'power-pages') ? '/' : null);
  const simUrl = runtime?.portalUrl ? new URL('/_sim/', new URL(runtime.portalUrl, location.href)).href : '/_sim/';
  const admin = runtime?.product === 'Mirage' ? (runtime.links?.administration ?? simUrl) : null;
  navigation.hidden = !runtime;
  navigation.innerHTML = runtime
    ? `<div class="nav-label area-label">RUNNING PREVIEW</div>${portalUrl ? `<a class="nav-item" href="${esc(portalUrl)}">← Back to portal</a>` : ''}${admin ? `<a class="nav-item" href="${esc(admin)}">Administration</a>${runtime.kind !== 'dataverse-api' ? `<a class="nav-item" href="${esc(runtime.links?.modelDriven ?? '/main.aspx')}">Model-driven apps</a>` : ''}` : ''}`
    : '';
  // Shell: top bar actions, the AREAS switch and the sidebar status follow the running preview.
  const openSimulator = $('#open-simulator'),
    openPortal = $('#open-portal'),
    area = $('#area-simulator');
  openSimulator.hidden = !admin;
  if (admin) openSimulator.href = admin;
  openPortal.hidden = !portalUrl;
  if (portalUrl) openPortal.href = portalUrl;
  if (admin) {
    area.href = admin;
    area.removeAttribute('aria-disabled');
  } else {
    area.removeAttribute('href');
    area.setAttribute('aria-disabled', 'true');
  }
  area.querySelector('.muted').hidden = Boolean(admin);
  $('#setup-state').textContent = runtime
    ? `${runtime.product} preview running${runtime.site ? ` · ${runtime.site}` : ''}`
    : 'Local configuration';
  $('#scope').textContent = state.directory;
  const created = state.layers.shared.exists;
  const personal = state.layers.personal;
  if (!personal) layer = 'shared';
  specs.clear();
  lists.clear();
  // First render: the system map, the stage with the next step and the hash target are open (plus a project's runtime form).
  const next = (state.stages ?? []).find((item) => item.status === 'next');
  const nextSections = next
    ? state.findings
        .filter((item) => next.findings?.includes(item.code))
        .map((item) => String(item.section ?? '').slice(1))
    : [];
  nextSection = next && sectionOf(next) !== 'overview' ? sectionOf(next) : null;
  $('#breadcrumb').textContent = next ? next.title : 'Overview';
  const opened = new Set([
    'system',
    nextSection,
    ...nextSections,
    state.kind === 'project' && 'runtime-configuration',
    decodeURIComponent(location.hash.slice(1)),
  ]);
  const afterCreate = (body) =>
    created ? body : kit.notice('Create the configuration above first; this stage edits it.', 'neutral');
  const rail = $('#stage-rail');
  rail.hidden = !(state.stages ?? []).length;
  rail.innerHTML = railHtml();
  document.body.dataset.setupView = view;
  for (const button of document.querySelectorAll('[data-view]'))
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  syncShell();
  if (view === 'quick') {
    $('#breadcrumb').textContent = 'Quick setup';
    $('#content').innerHTML =
      datalists() + `<section id="quick" class="panel quick" aria-label="Quick setup">${quickHtml()}</section>`;
    afterSystem();
    if (state.canEdit === false)
      for (const button of document.querySelectorAll('#content form[data-form] button[type=submit]'))
        button.disabled = true;
    return;
  }
  $('#content').innerHTML =
    datalists() +
    `<section id="overview" class="panel overview-strip" aria-label="Project status">${overviewBody(personal)}</section>` +
    [
      stage('system', opened, {
        title: 'Your system at a glance',
        help: sectionHelp(
          'the system map',
          'Planned from configuration, or live from the running preview (refreshed every 5 seconds while this section is open and the tab is visible).',
          'system',
        ),
        badge: systemBadge(),
        body: `<div id="system-body">${systemBody()}</div>`,
      }),
      stage('runtime-configuration', opened, {
        title: 'What to run',
        help: sectionHelp(
          'what to run',
          'Choose what runs in the preview, and what happens to records you change there. Test users and app secrets of a running preview are managed in the simulator (Administration → Organization identity & API).',
          'runtime',
        ),
        body: afterCreate(runtimeBody()),
      }),
      stage('portals', opened, {
        title: 'Exported files',
        help: sectionHelp(
          'exported files',
          'Every folder and file your project is built from: website exports (one project each), Solutions, canvas apps, scripts, deployment profiles and code apps.',
          'sources',
        ),
        body: afterCreate(portalsBody()),
      }),
      stage('packs', opened, {
        title: 'Sample data',
        help: sectionHelp(
          'sample data',
          'Files of your project that fill tables with example records, and whether the running preview loaded them.',
          'packs',
        ),
        body: afterCreate(packsBody()),
      }),
      stage('environments', opened, {
        title: 'Live environments (optional)',
        help: sectionHelp(
          'live environments',
          'Only for Lense, which shows your local files on your live website. The local preview does not use these addresses.',
          'environments',
        ),
        body: afterCreate(environmentsBody()),
      }),
      stage('personas', opened, {
        title: 'Test people & sign-in',
        help: sectionHelp('test people and sign-in', SCENARIOS_TEXT, 'personas'),
        body: afterCreate(personasBody()),
      }),
      stage('providers', opened, {
        title: 'Outside services (advanced)',
        help: kit.info({
          label: 'About connections and services',
          text: [
            'Optional. Skip this unless your project calls outside services.',
            helpText('setup.providers'),
            state.kind === 'catalogue'
              ? "Some provider keys are project-only: their rows are marked project:<target> and save to that target's linked Mirage project file."
              : '',
          ]
            .filter(Boolean)
            .join(' '),
          steps: providerHelp(),
          docs: HELP['setup.providers']?.doc ? [kit.docLink(HELP['setup.providers'].doc, state.docs)] : [],
        }),
        body: afterCreate(providersBody()),
      }),
      stage('identity', opened, {
        title: 'Web API access (advanced)',
        help: sectionHelp(
          'web API access',
          'Optional. Only for scripts and tests that call the Web API. Users and app secrets of a running preview are managed in the simulator (Administration → Organization identity & API); the settings file holds references only.',
          'identity',
        ),
        body: afterCreate(identityBody()),
      }),
      stage('settings', opened, {
        title: 'Project settings',
        help:
          state.kind === 'project'
            ? note(
                'Project-wide settings of this Mirage project file: locale, state folder and source watching. Saves apply on the next start.',
                'About project settings',
              )
            : note(
                'Defaults for terminal commands and Lense: where export paths start, the default project and the browser. The local preview works with these defaults. Shell PAQVILO_* variables and .env values override them. Saves apply on the next start.',
                'About project settings',
              ),
        body: afterCreate(settingsBody()),
      }),
      stage('advanced', opened, {
        title: 'Settings file (for developers)',
        help: note(
          'The whole settings file as text, for settings this page has no form for.',
          'About the settings file',
        ),
        body: advancedBody(),
      }),
      stage('guidance', opened, {
        title: 'Start & check',
        help: sectionHelp(
          'start and check',
          'Start the preview and open your website and apps, then check what the project needs. Terminal commands for developers are at the end.',
          'start',
        ),
        body: guidanceBody(),
      }),
    ].join('');
  applyUiOpen($('#content'));
  afterSystem();
  if (state.canEdit === false)
    for (const button of document.querySelectorAll('#content form[data-form] button[type=submit]'))
      button.disabled = true;
}
$('#content').addEventListener('input', (event) => {
  const target = event.target;
  if (target.matches('[data-table-search]')) {
    const key = target.dataset.tableSearch;
    pagers[key] = { ...pagers[key], search: target.value, page: 1 };
    return rerenderTable(key, true);
  }
  if (target.name === 'profile-id') {
    const choiceInput = target.closest('.profile-editor')?.querySelector('[data-profile-default]');
    if (choiceInput) choiceInput.value = target.value.trim();
  }
  if (target.closest('form[data-form]') && !['layer', 'yaml-layer'].includes(target.id)) dirty = true;
  target.closest('#quick form')?.classList.add('is-changed');
});
$('#content').addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[data-table-size]')) {
    const key = target.dataset.tableSize;
    pagers[key] = { ...pagers[key], size: Number(target.value), page: 1 };
    return rerenderTable(key);
  }
  target.closest('#quick form')?.classList.add('is-changed');
  if (target.id === 'quick-site') {
    quickSite = target.value;
    quickEditing = null;
    dashboard = null;
    refreshQuick(true);
    pollDashboard();
    return;
  }
  // The chosen project drives the stage marks and every simulator link on the page, so it all repaints.
  if (target.id === 'run-site') {
    quickSite = target.value;
    dashboard = null;
    liveChanged();
    renderPreservingContext();
    pollDashboard();
    loadRuntimeInfo().then(() => {
      if (quickSite === target.value) renderPreservingContext();
    });
    return;
  }
  if (target.name === 'found-website') {
    const form = target.closest('form'),
      name = form.querySelector('[name=id]');
    if (name && target.dataset.name) name.value = target.dataset.name;
    form.querySelector('[name=source]').closest('.pick-field').hidden = Boolean(target.value);
  }
  if (target.name === 'part' && target.closest('form[data-form="runtime"]')) {
    const form = target.closest('form'),
      ticked = (name) => Boolean(form.querySelector(`input[name="part"][value="${name}"]:checked`));
    const show = (selector, on) => {
      const node = form.querySelector(selector);
      if (node) node.hidden = !on;
    };
    show('[data-app-choice]', ticked('modelDriven'));
    show('[data-api-port]', ticked('api'));
    show('[data-portal-source]', ticked('website'));
  }
  if (target.id === 'layer') {
    if (!['shared', 'personal'].includes(target.value)) return;
    if (dirty && !confirm('Discard unsaved form changes and switch configuration layer?')) {
      target.value = layer;
      return;
    }
    layer = target.value === 'personal' ? 'personal' : 'shared';
    yamlLayer = null;
    dirty = false;
    renderPreservingContext();
  }
  if (target.id === 'yaml-layer') {
    if (!Object.hasOwn(state.layers, target.value)) return;
    if (dirty && !confirm('Discard unsaved form changes and open another document?')) {
      target.value = state.layers[yamlLayer] ? yamlLayer : layer;
      return;
    }
    yamlLayer = target.value;
    dirty = false;
    renderPreservingContext();
  }
});
$('#content').addEventListener('click', (event) => {
  const target = event.target;
  const quickEdit = target.closest('[data-quick-edit]');
  // In All settings, Choose starting data goes to the Starting data field of Sample data.
  if (quickEdit && view !== 'quick' && quickEdit.dataset.quickEdit === 'data' && quickTarget()) {
    const id = `data-${slug(quickTarget().project ? 'project' : quickTarget().id)}-preset`;
    reveal(id, true);
    document.getElementById(id)?.focus({ preventScroll: true });
    return;
  }
  if (quickEdit) {
    if (view !== 'quick') setView('quick');
    quickEditing = quickEdit.dataset.quickEdit || null;
    refreshQuick(true);
    document.getElementById(`quick-${quickEditing}`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const pick = target.closest('[data-pick-folder]');
  if (pick) return openPicker(pick.dataset.pickFolder, pick.closest('form'), pick.dataset.pickInto);
  const pickFile = target.closest('[data-pick-file]');
  if (pickFile)
    return openPicker(`${pickFile.dataset.pickFile}-file`, pickFile.closest('form'), pickFile.dataset.pickInto);
  const codeApps = target.closest('form')?.querySelector('[data-code-apps]');
  if (target.closest('[data-add-code-app]') && codeApps) {
    codeApps.insertAdjacentHTML('beforeend', codeAppRow());
    dirty = true;
    return;
  }
  if (target.closest('[data-remove-code-app]')) {
    target.closest('[data-code-app]').remove();
    dirty = true;
    return;
  }
  const profiles = target.closest('form')?.querySelector('[data-profiles]');
  if (target.closest('[data-add-profile]') && profiles) {
    profiles.insertAdjacentHTML('beforeend', profileRow(profiles.dataset.key));
    dirty = true;
    return;
  }
  if (target.closest('[data-remove-profile]')) {
    target.closest('.profile-editor').remove();
    dirty = true;
    return;
  }
  const foundProfiles = target.closest('[data-add-found-profiles]');
  if (foundProfiles && profiles) {
    for (const item of JSON.parse(foundProfiles.dataset.addFoundProfiles))
      profiles.insertAdjacentHTML(
        'beforeend',
        profileRow(profiles.dataset.key, item.name, { pages: { source: item.file } }),
      );
    foundProfiles.closest('.quick-hint').remove();
    dirty = true;
    return;
  }
  if (target.closest('[data-folder-remove]')) {
    const form = target.closest('form');
    target.closest('li').remove();
    form.classList.add('is-changed');
    return;
  }
  const previewButton = target.closest('[data-preview]');
  if (previewButton) return previewAction(previewButton.dataset.preview);
  if (target.closest('[data-add-env]')) {
    const form = target.closest('form');
    form.querySelector('[data-environments]').insertAdjacentHTML('beforeend', envRow('', {}, form.dataset.site));
    dirty = true;
  }
  if (target.closest('[data-remove-env]')) {
    target.closest('.environment-editor').remove();
    dirty = true;
  }
  if (target.closest('[data-add-service]')) {
    target.closest('form').querySelector('[data-services]').insertAdjacentHTML('beforeend', serviceRow());
    dirty = true;
  }
  if (target.closest('[data-remove-service]')) {
    target.closest('[data-service]').remove();
    dirty = true;
  }
  const page = target.closest('[data-table-page]');
  if (page) {
    const key = page.dataset.tablePage;
    pagers[key] = { ...pagers[key], page: Math.max(1, (pagers[key]?.page ?? 1) + Number(page.dataset.delta)) };
    return rerenderTable(key);
  }
  const copy = target.closest('[data-copy]');
  if (copy) return copyCommand(copy.dataset.copy);
  if (target.closest('[data-drawer-close]')) {
    const id = nodeId;
    nodeId = null;
    const slot = $('#dashboard-node-detail');
    if (slot) slot.innerHTML = '';
    if (id) document.querySelector(`[data-node="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  const node = target.closest('[data-node]');
  if (node) showNode(node.dataset.node);
});
$('#content').addEventListener('keydown', (event) => {
  const node = event.target.closest?.('[data-node]');
  if (node && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    showNode(node.dataset.node);
  }
});
// details 'toggle' does not bubble: capture it to remember kit section state and to start live polling when the map opens.
$('#content').addEventListener(
  'toggle',
  (event) => {
    if (event.target.dataset?.sectionKey === 'quick-map' && event.target.open !== quickMapOpen) {
      quickMapOpen = event.target.open;
      if (quickMapOpen) refreshQuick(true);
      return;
    }
    const key = event.target.dataset?.uiSection;
    if (key) uiOpen.set(key, event.target.open);
    if (event.target.id === 'system' && event.target.open) pollDashboard();
  },
  true,
);
document.addEventListener('click', (event) => {
  // An (i) button shows its guidance on focus; inside a section summary or a label it must not toggle the section or the control.
  if (event.target.closest?.('.ui-info-button')) {
    event.preventDefault();
    event.target.closest('.ui-info-button').focus({ preventScroll: true });
    return;
  }
  const switcher = event.target.closest?.('[data-view]');
  if (switcher && state) return setView(switcher.dataset.view);
  const link = event.target.closest?.('a[href^="#"]'),
    href = link?.getAttribute('href'),
    document_ = link?.dataset.yamlLayer;
  // A Quick setup link into All settings, and the stage rail, switch to All settings first.
  if (
    link &&
    state &&
    view === 'quick' &&
    (link.hasAttribute('data-quick-all') || ALL_SECTIONS.has(String(href).slice(1)))
  )
    setView('all');
  // Links to a document (a linked-project finding, a references-only row) open it in the YAML editor first.
  if (document_ && state?.layers[document_] && document_ !== (state.layers[yamlLayer] ? yamlLayer : layer)) {
    if (dirty && !confirm('Discard unsaved form changes and open another document?')) {
      event.preventDefault();
      return;
    }
    yamlLayer = document_;
    dirty = false;
    renderPreservingContext();
  }
  if (href && href.length > 1) reveal(decodeURIComponent(href.slice(1)), true);
});
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (view === 'quick' && ALL_SECTIONS.has(id)) setView('all');
  reveal(id, true);
});
// A tooltip near the right edge opens leftwards, so it never widens the page; near the bottom it opens upwards.
for (const type of ['mouseover', 'focusin'])
  document.addEventListener(type, (event) => {
    const holder = event.target.closest?.('.ui-info'),
      box = holder?.getBoundingClientRect();
    if (holder) {
      holder.classList.toggle('is-end', box.left > document.documentElement.clientWidth - 400);
      holder.classList.toggle('is-up', box.bottom > window.innerHeight - 280 && box.top > 280);
    }
  });
// An (i) opened by a click closes when the page scrolls away from it.
document.addEventListener(
  'scroll',
  () => {
    if (document.activeElement?.matches?.('.ui-info-button')) document.activeElement.blur();
  },
  { passive: true },
);
document.addEventListener('visibilitychange', () => {
  pollPreview();
  pollDashboard();
});
// A page restored from the browser history shows old state: read it again.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) load();
});
setInterval(pollDashboard, 5000);
setInterval(() => pollPreview(), 5000);
// ---- Form submissions: one handler per data-form. A handler saves itself, or returns the edits to save.
const SUBMIT = {
  async 'quick-create'({ data, value }) {
    const name = value('name');
    if (!identifier(name)) throw new Error('Use a project name made of letters, numbers, underscores or hyphens.');
    layer = 'shared';
    // Written as one guided edit per top-level key, so the new file is plain block YAML.
    const created = quickUi.createDocument({
      parts: chosenParts(data),
      name,
      project: state.kind === 'project',
      candidates: quick?.candidates,
      port: quick?.port ?? 8787,
      ports: quick?.ports ?? [],
      websites: quickUi.chosenWebsites(data, quick?.candidates),
      apiPort: quick?.apiPort ?? null,
    });
    if (
      await save({ operations: Object.entries(created).map(([key, value]) => ({ op: 'set', path: [key], value })) })
    ) {
      await loadQuick();
      quickEditing = null;
      render();
      notice(
        `Created ${fileName(state.layers.shared.file)} in ${state.directory}. Check the folders it uses in step 2.`,
      );
    }
  },
  'quick-kind': ({ data }) => quickSave(quickUi.partsEdits(quickTarget(), chosenParts(data), quick?.candidates)),
  'quick-files'({ data, value }) {
    const target = quickTarget(),
      website = value('website') || value('website-other'),
      solutions = data.getAll('solution').map(String);
    if (target.parts.website && !website) throw new Error('Choose the folder of your website export.');
    if ((target.parts.modelDriven || target.parts.canvas) && !solutions.length)
      throw new Error('Choose at least one Solution folder: your apps are built from it.');
    return quickSave(quickUi.filesEdits(target, { website, solutions }));
  },
  'quick-data': ({ data, value }) =>
    quickSave(
      quickUi.dataEdits(quickTarget(), {
        preset: data.has('preset') ? value('preset') : undefined,
        packs: data.getAll('pack').map(String),
        level: value('level'),
      }),
    ),
  yaml: ({ data }) => save({ text: String(data.get('yaml')), layer: state.layers[yamlLayer] ? yamlLayer : layer }),
  template({ value }) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(value('id')))
      throw new Error('Use a target name of 1-63 letters, numbers or hyphens.');
    layer = 'shared';
    return save({ template: value('template'), values: { id: value('id'), root: value('root') }, layer: 'shared' });
  },
  setting({ form, data }) {
    const spec = specs.get(form.dataset.spec);
    if (!spec) throw new Error('Refresh status before saving this setting.');
    const { item, target } = spec,
      raw = String(data.get('value') ?? ''),
      text = raw.trim();
    // Rows without a shown current value, or with references only, render no form; refuse a stale one too.
    if (!target.known || referencesOnly(item, target.value))
      return notice(
        `Edit ${item.key} in the Settings file section; this page does not replace values it shows as references only.`,
        true,
      );
    let edit;
    if (['list', 'object'].includes(item.kind)) {
      if (text === shownValue(target.value).trim()) return notice(`Nothing to save: ${item.key} is unchanged.`);
      edit = text ? { op: 'set', path: target.path, yaml: raw } : { op: 'delete', path: target.path };
    } else if (!text) edit = { op: 'delete', path: target.path };
    else
      edit = {
        op: 'set',
        path: target.path,
        value: item.kind === 'number' ? number(text, item.key) : item.kind === 'boolean' ? text === 'true' : text,
      };
    if (edit.op === 'delete' && target.value === undefined)
      return notice(`Nothing to save: ${item.key} is not set here.`);
    if (edit.value !== undefined && JSON.stringify(edit.value) === JSON.stringify(target.value))
      return notice(`Nothing to save: ${item.key} is unchanged.`);
    return save({ operations: [edit], layer: target.layer });
  },
  personas({ id, site, value, edits }) {
    const mirage = site.mirage ?? {},
      prefix = ['sites', id, 'mirage'],
      max = number(value('maxInstances'), 'Isolated persona contexts');
    if (max !== undefined && (!Number.isInteger(max) || max < 0 || max > 32))
      throw new Error('Isolated persona contexts must be a whole number from 0 to 32.');
    update(edits, [...prefix, 'personaContexts', 'maxInstances'], max, mirage.personaContexts?.maxInstances);
    update(
      edits,
      [...prefix, 'identityProvider', 'presentation'],
      value('presentation') || undefined,
      mirage.identityProvider?.presentation,
    );
    update(
      edits,
      [...prefix, 'identityProvider', 'title'],
      value('title') || undefined,
      mirage.identityProvider?.title,
    );
    if (!edits.length) return notice('Nothing to save: no persona setting changed.');
    return save({ operations: edits });
  },
  identity({ id, site, data, value, edits, set }) {
    const before = (site ? site.mirage?.dataverse : state.settings.dataverse) ?? {},
      prefix = site ? ['sites', id, 'mirage', 'dataverse'] : ['dataverse'];
    if (data.has('tls') !== (before.tls === true)) set([...prefix, 'tls'], data.has('tls'));
    update(edits, [...prefix, 'tlsPort'], number(value('tlsPort'), 'TLS port'), before.tlsPort);
    update(edits, [...prefix, 'tenantId'], value('tenantId') || undefined, before.tenantId);
    // Users, app registrations and service limits declared in the settings file are edited in the Settings file; this form never touches them.
    if (!edits.length) return notice('Nothing to save: no identity setting changed.');
    return save({ operations: edits });
  },
  // Services you run yourself; keys this form does not show (required, description) are kept. The server validates addresses.
  services({ form, site, edits }) {
    const project = state.kind === 'project',
      path = project ? ['localServices'] : ['sites', site.id, 'mirage', 'localServices'];
    const before =
        (project ? state.layers.shared.values?.localServices : (site.authoredMirage ?? site.mirage)?.localServices) ??
        {},
      services = {};
    for (const row of form.querySelectorAll('[data-service]')) {
      const read = (name) => row.querySelector(`[name=${name}]`).value.trim(),
        name = read('svc-id'),
        kind = read('svc-kind'),
        address = read('svc-address'),
        probe = read('svc-probe');
      if (!/^[a-z][a-z0-9-]{0,63}$/i.test(name) || Object.hasOwn(services, name))
        throw new Error('Give each service its own name: a letter first, then letters, numbers and hyphens.');
      if (!address) throw new Error(`Enter the address of ${name}.`);
      const kept = { ...(before[name] ?? {}) };
      for (const key of ['kind', 'baseUrl', 'blob', 'connectionStringVariable', 'probe']) delete kept[key];
      services[name] = {
        kind,
        ...(kind === 'service-bus'
          ? { connectionStringVariable: address }
          : { [kind === 'http' ? 'baseUrl' : 'blob']: address, ...(probe ? { probe } : {}) }),
        ...kept,
      };
    }
    update(
      edits,
      path,
      Object.keys(services).length ? services : undefined,
      Object.keys(before).length ? before : undefined,
    );
    if (!edits.length) return notice('Nothing to save: no service changed.');
    return save({ operations: edits });
  },
  'project-settings'({ value, edits }) {
    const settings = state.settings;
    if (value('lcid')) update(edits, ['lcid'], number(value('lcid'), 'Locale ID'), settings.lcid);
    if (value('stateDirectory')) update(edits, ['stateDirectory'], value('stateDirectory'), settings.stateDirectory);
    if (value('watch')) update(edits, ['watch'], value('watch') === 'true', settings.watch);
    if (!edits.length) return notice('Nothing to save: empty fields keep the values in the project file.');
    return save({ operations: edits });
  },
  async create({ data, value }) {
    const name = value('id');
    if (!identifier(name)) throw new Error('Use a project name made of letters, numbers, underscores or hyphens.');
    if (!quick) await loadQuick();
    // The same file Quick setup creates: what to run, the found exports (when chosen), a local address and dry run.
    const created = quickUi.createDocument({
      parts: chosenParts(data),
      name,
      project: state.kind === 'project',
      candidates: data.has('use-found') ? quick?.candidates : null,
      port: quick?.port ?? 8787,
      ports: quick?.ports ?? [],
      apiPort: quick?.apiPort ?? null,
      websites: quickUi.chosenWebsites(data, quick?.candidates),
    });
    layer = 'shared';
    if (
      await save({
        operations: Object.entries(created).map(([key, item]) => ({ op: 'set', path: [key], value: item })),
      })
    )
      notice(
        `Saved. Created ${fileName(state.layers.shared.file)}. The stage marked “next step” on the left shows what to do now.`,
      );
  },
  runtime(context) {
    const { id, site, data, value, edits, set } = context;
    const before = site ? (site.effectiveMirage ?? site.mirage) : state.settings,
      prefix = site ? ['sites', id, 'mirage'] : [];
    const change = (path, next, previous) => {
      if (JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null))
        next === undefined ? edits.push({ op: 'delete', path: [...prefix, ...path] }) : set([...prefix, ...path], next);
    };
    // What to run: the runtime kind and its switches, written as Quick setup writes them.
    const parts = chosenParts(data),
      kind = quickUi.kindFor(parts),
      defaultApp = value('defaultApp');
    edits.push(...quickUi.partsEdits(quickUi.targetOf(state, id), parts, quick?.candidates));
    if (parts.modelDriven) change(['runtime', 'defaultApp'], defaultApp || undefined, before.runtime?.defaultApp);
    else if (kind === 'dataverse-api' && before.runtime?.defaultApp)
      change(['runtime', 'defaultApp'], undefined, before.runtime.defaultApp);
    if (value('simulation-level') === 'local-state' && before.simulation && site?.inherited?.simulation)
      throw new Error(
        'Local state cannot override the simulation level inherited from defaults.mirage. Remove it from defaults in the Settings file, or choose another option.',
      );
    change(
      ['simulation'],
      value('simulation-level') === 'local-state' ? undefined : { level: value('simulation-level') },
      before.simulation,
    );
    change(
      ['modelDriven', 'trustedExtensions'],
      data.has('trusted-extensions'),
      before.modelDriven?.trustedExtensions ?? false,
    );
    if (parts.api) change(['dataverse', 'port'], Number(value('api-port') || 0), before.dataverse?.port ?? 0);
    if (site && value('port') !== String(site.mirage.port ?? ''))
      change(['port'], value('port') === '' ? undefined : number(value('port'), 'Local port'), site.mirage.port);
    if (state.kind === 'project') projectPortalEdits(context, kind);
    return save({ operations: edits });
  },
  async add({ data, value, set, edits }) {
    if (!identifier(value('id')) || state.sites.some((site) => site.id === value('id')))
      throw new Error('Choose a new project name: letters, numbers and hyphens.');
    const parts = chosenParts(data),
      kind = quickUi.kindFor(parts),
      source = value('found-website') || value('source');
    if (parts.website && !source) throw new Error('Choose a website export found here, or the folder of another one.');
    // Another website is another project: its own local address (a free port), the deployment profiles in its export, dry run.
    const found = (quick?.candidates?.portals ?? []).find(
      (item) => quickUi.normalPath(item.value) === quickUi.normalPath(source),
    );
    const port = await request('/_setup/api/port')
      .then((body) => body.port)
      .catch(() => 0);
    const profiles = found?.profiles?.length
      ? {
          deploymentProfiles: {
            profiles: Object.fromEntries(found.profiles.map((item) => [item.name, { pages: { source: item.file } }])),
          },
        }
      : {};
    set(['sites', value('id')], {
      ...(kind === 'power-pages'
        ? { source, defaultEnv: 'local', environments: { local: `http://127.0.0.1:${port || 8787}` } }
        : {}),
      mirage: { port, runtime: { kind }, simulation: { level: 'dry-run' }, ...quickUi.switchesFor(parts), ...profiles },
    });
    return save({ operations: edits });
  },
  settings({ data, value, edits, set }) {
    // Only fields the user changed are written, so untouched keys keep their authored form.
    const settings = state.settings,
      browser = settings.browser ?? {},
      flag = (name, path, previous) => {
        if (data.has(name) !== (previous === true)) set(path, data.has(name));
      };
    update(edits, ['sourceRoot'], value('sourceRoot'), settings.sourceRoot);
    update(edits, ['defaultSite'], value('defaultSite') || undefined, settings.defaultSite || undefined);
    update(edits, ['browser', 'channel'], value('browser'), browser.channel);
    update(edits, ['portals'], value('portals'), settings.portals);
    for (const name of ['panel', 'liveReload']) flag(name, [name], settings[name]);
    flag('includeCaution', ['includeCaution'], settings.includeCaution);
    flag('headless', ['browser', 'headless'], browser.headless);
    flag('bypassCSP', ['browser', 'bypassCSP'], browser.bypassCSP);
    flag('agentEnabled', ['agent', 'enabled'], settings.agent?.enabled);
    flag('sourceMaps', ['sourceMaps'], settings.sourceMaps);
    for (const name of ['profileDir', 'profile', 'userDataDir', 'profileDirectory', 'cdpUrl'])
      update(edits, ['browser', name], value(name) || undefined, browser[name] ?? undefined);
    update(
      edits,
      ['browser', 'debugPort'],
      number(value('debugPort'), 'Remote debugging port'),
      browser.debugPort ?? undefined,
    );
    update(edits, ['editor'], value('editor') || undefined, settings.editor ?? undefined);
    if (!edits.length) return notice('Nothing to save: no default changed.');
    return save({ operations: edits });
  },
  // Exported files: folders, canvas app and script folders, deployment profiles and code apps of one project.
  files(context) {
    const { form, data, value, site, edits, set } = context,
      project = state.kind === 'project';
    const prefix = project ? [] : ['sites', site.id, 'mirage'],
      before = (project ? state.settings : site.mirage) ?? {};
    const listOf = (name) => [...new Set(lines(value(name)))];
    if (form.querySelector('[name=source]')) {
      if (!value('source')) throw new Error('Choose the folder of your website export.');
      if (project) {
        const index = state.sites.indexOf(site);
        if (index >= 0 && value('source') !== site.source) set(['portals', index, 'path'], value('source'));
      } else if (value('source') !== site.source) set(['sites', site.id, 'source'], value('source'));
    }
    if (project) projectSolutionEdits(context);
    else
      update(
        edits,
        [...prefix, 'solutionRoots'],
        listOf('solutions').length ? listOf('solutions') : undefined,
        before.solutionRoots?.length ? before.solutionRoots : undefined,
      );
    const canvas = [...new Set([...listOf('canvas-sources'), ...data.getAll('canvas-found').map(String)])];
    update(
      edits,
      [...prefix, 'canvas', 'sources'],
      canvas.length ? canvas : undefined,
      before.canvas?.sources?.length ? before.canvas.sources : undefined,
    );
    update(
      edits,
      [...prefix, 'modelDriven', 'clientSources'],
      listOf('client-sources').length ? listOf('client-sources') : undefined,
      before.modelDriven?.clientSources?.length ? before.modelDriven.clientSources : undefined,
    );
    if (project) {
      const originals = state.layers.shared.values.codeApps ?? [];
      const apps = codeAppsOf(form, originals);
      update(edits, ['codeApps'], apps.length ? apps : undefined, originals.length ? originals : undefined);
    }
    update(
      edits,
      [...prefix, 'deploymentProfiles'],
      profilesOf(form, before.deploymentProfiles),
      before.deploymentProfiles,
    );
    if (!edits.length) return notice('Nothing to save: no folder or file changed.');
    return save({ operations: edits });
  },
  // Live environments (Lense) of one website.
  environments({ form, id, site, value, edits, set }) {
    const prefix = ['sites', id];
    if (value('defaultEnv')) set([...prefix, 'defaultEnv'], value('defaultEnv'));
    else edits.push({ op: 'delete', path: [...prefix, 'defaultEnv'] });
    set([...prefix, 'startPath'], value('startPath') || '/');
    const environments = {};
    for (const row of form.querySelectorAll('.environment-editor')) {
      const name = row.querySelector('[name=env-id]').value.trim(),
        url = row.querySelector('[name=env-url]').value.trim();
      if (!identifier(name) || Object.hasOwn(environments, name))
        throw new Error('Environment names must be valid and unique.');
      let origin;
      try {
        origin = new URL(url);
      } catch {
        throw new Error(`Enter a valid website address for ${name}.`);
      }
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash
      )
        throw new Error(
          'Use the start of the website address only (https://…), without sign-in links, paths or query text.',
        );
      // Keep baseline, scope and other environment-specific settings.
      const optional = (selector) => row.querySelector(selector)?.value.trim() || undefined;
      environments[name] = {
        ...site.environments[name],
        url: origin.origin,
        caution: row.querySelector('[name=env-caution]').checked,
        baseline: optional('[name=env-baseline]'),
        startPath: optional('[name=env-start]'),
        scope: optional('[name=env-scope]'),
      };
    }
    if (value('defaultEnv') && !environments[value('defaultEnv')])
      throw new Error('The default live environment must be one of the environments below.');
    for (const [name, setting] of Object.entries(environments)) {
      set([...prefix, 'environments', name, 'url'], setting.url);
      set([...prefix, 'environments', name, 'caution'], setting.caution);
      for (const key of ['baseline', 'startPath', 'scope'])
        setting[key] === undefined
          ? edits.push({ op: 'delete', path: [...prefix, 'environments', name, key] })
          : set([...prefix, 'environments', name, key], setting[key]);
    }
    for (const name of Object.keys(site.environments))
      if (!Object.hasOwn(environments, name)) edits.push({ op: 'delete', path: [...prefix, 'environments', name] });
    set([...prefix, 'scope'], value('scope'));
    // Route YAML is passed through the document editor's validator via a string operation.
    edits.push({ op: 'set', path: [...prefix, 'routes'], yaml: value('routes') || '[]' });
    return save({ operations: changedOnly(site, edits) });
  },
  // Sample data: modules (a found one ticked in), the starting data and when it loads.
  data({ data, value, site, edits }) {
    const project = state.kind === 'project',
      prefix = project ? [] : ['sites', site.id, 'mirage'],
      before = (project ? state.settings : site.mirage) ?? {};
    const text = [...lines(value('packs')), ...data.getAll('pack-found').map(String)].join('\n');
    // Compared as the lines shown, so a module registered by its path alone stays a path.
    if (lines(text).join('\n') !== lines(packText(before.dataPacks)).join('\n')) {
      const packs = packLines(text);
      update(
        edits,
        [...prefix, 'dataPacks'],
        packs.length
          ? packs.map((pack) => {
              if (typeof pack === 'string' || !project) return pack;
              const index = (state.settings.dataPacks ?? []).findIndex((item) => item.id === pack.id),
                original = state.settings.dataPackEntries?.[index];
              return original && typeof original === 'object' ? { ...original, module: pack.module } : pack;
            })
          : undefined,
        before.dataPacks,
      );
    }
    if (!project)
      for (const name of ['preset', 'presetMode', 'presetConfiguration'])
        update(edits, [...prefix, name], value(name) || undefined, before[name] ?? undefined);
    if (!edits.length) return notice('Nothing to save: sample data unchanged.');
    return save({ operations: edits });
  },
};
// Deployment profiles of the Exported files form: rows of name, three files with their base, and the default. Rows that use a
// list of files are kept as they are; other keys (required, enabled) are kept.
function profilesOf(form, before) {
  const profiles = {},
    kept = new Set([...form.querySelectorAll('[name=profile-keep]')].map((input) => input.value));
  for (const id of kept) profiles[id] = before?.profiles?.[id];
  for (const row of form.querySelectorAll('[data-profiles] .profile-editor:not([data-profile-locked])')) {
    const id = row.querySelector('[name=profile-id]').value.trim();
    if (!id) continue;
    if (!identifier(id) || Object.hasOwn(profiles, id))
      throw new Error('Deployment profile names must be valid and unique.');
    const sources = {};
    for (const [section] of PROFILE_SECTIONS) {
      const file = row.querySelector(`[name="profile-${section}"]`).value.trim(),
        base = row.querySelector(`[name="profile-${section}-base"]`).value;
      if (file) sources[section] = base ? { [base]: file } : file;
    }
    if (!Object.keys(sources).length) throw new Error(`Choose at least one file for the deployment profile ${id}.`);
    profiles[id] = sources;
  }
  if (!Object.keys(profiles).length) return undefined;
  const chosen = form.querySelector('[name=profile-default]:checked')?.value || null;
  if (chosen && !Object.hasOwn(profiles, chosen))
    throw new Error('The default deployment profile must be one of the profiles above.');
  const { profiles: _, default: __, ...other } = before ?? {};
  return { ...other, ...(chosen ? { default: chosen } : {}), profiles };
}
// The website of a project file without one, added when What to run ticks the website.
function projectPortalEdits({ value, set }, kind) {
  if (kind === 'power-pages' && !state.sites.length) {
    if (!identifier(value('portal-id')) || !value('portal-path'))
      throw new Error('Choose a website name and the folder of its export.');
    set(['portals'], [{ id: value('portal-id'), path: value('portal-path') }]);
    set(['defaultPortal'], value('portal-id'));
  }
}
// Project-file Solution folders (IDs kept for unchanged paths).
function projectSolutionEdits({ value, set }) {
  const paths = value('runtime-solutions')
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean);
  if (new Set(paths).size !== paths.length) throw new Error('Each Solution folder must be listed once.');
  const old = state.settings.solutions ?? [];
  if (JSON.stringify(paths) !== JSON.stringify(old.map((item) => item.path))) {
    const matched = paths.map((path) => old.find((item) => item.path === path));
    const claimed = new Set(matched.filter(Boolean).map((item) => item.id)),
      reserved = new Set(old.map((item) => item.id));
    let counter = 1;
    const solutions = paths.map((path, index) => {
      // Claim moved, unchanged paths first; a replacement can retain its
      // prior row ID only when another row has not already claimed it.
      const previous = matched[index] ?? (old[index] && !claimed.has(old[index].id) ? old[index] : null);
      if (previous) {
        claimed.add(previous.id);
        const original = state.settings.solutionEntries?.[old.indexOf(previous)],
          authored = original && typeof original === 'object' ? original : {};
        const key = Object.hasOwn(authored, 'path')
          ? 'path'
          : Object.hasOwn(authored, 'source')
            ? 'source'
            : Object.hasOwn(authored, 'root')
              ? 'root'
              : 'path';
        // Explicit IDs keep shorthand entries stable when reordered.
        return { ...authored, id: previous.id, [key]: path };
      }
      let id;
      do {
        id = `solution-${counter++}`;
      } while (reserved.has(id));
      reserved.add(id);
      return { id, path };
    });
    set(['solutions'], solutions);
  }
}
// Only edits that change the site's value: inherited values and scalar environment comments stay untouched.
function changedOnly(site, edits) {
  return edits.filter((edit) => {
    const path = edit.path.slice(2);
    let previous = path.reduce((current, key) => current?.[key], site);
    if (path.join('.') === 'startPath') previous ??= '/';
    if (path.join('.') === 'scope') previous ??= 'all';
    if (path[0] === 'environments' && path[2] === 'caution') previous = Boolean(previous);
    if (path.join('.') === 'routes') previous ??= [];
    // An absent solutionRoots and an empty list are the same; neither writes `solutionRoots: []`.
    if (path.join('.') === 'mirage.solutionRoots') previous ??= [];
    if (edit.yaml !== undefined) return edit.yaml !== JSON.stringify(previous, null, 2);
    if (edit.op === 'delete') return previous !== undefined;
    return JSON.stringify(previous ?? null) !== JSON.stringify(edit.value);
  });
}
$('#content').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending) return;
  const form = event.target,
    data = new FormData(form),
    value = (name) => String(data.get(name) ?? '').trim();
  const id = form.dataset.site,
    edits = [];
  const context = {
    form,
    data,
    value,
    id,
    site: state.sites.find((item) => item.id === id),
    edits,
    set: (path, next) => edits.push(operation(path, next)),
  };
  try {
    await SUBMIT[form.dataset.form]?.(context);
  } catch (error) {
    notice(error.message, true);
  }
});
$('#refresh').addEventListener('click', () => {
  if (!dirty || confirm('Discard unsaved form changes and reload status?')) load();
});
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
load();
