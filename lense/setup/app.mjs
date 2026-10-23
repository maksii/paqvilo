import * as kit from './ui-kit.mjs';
import { renderDashboard, renderNodeDetail } from './dashboard-map.mjs';
import * as icons from './dashboard-icons.mjs';
import { HELP } from './help-content.mjs';
import { PRODUCT_OF } from './dashboard-map.mjs';
import * as quickUi from './quick.mjs';

const $ = selector => document.querySelector(selector);
const esc = kit.escapeHtml;
let state, layer = 'shared', yamlLayer = null, dirty = false, pending = false, pendingFocus, firstRender = true;
// Same-origin runtime facts (D19) and the live dashboard feed (D6, D21); both degrade to configuration-only views.
let runtimeInfo = {}, dashboard = null, dashboardError = '', previousActivity, nodeId = null, preflight = null;
const activityHistory = []; // earlier live activity snapshots, oldest first (sparklines)
const preflightInput = { requires: '', strict: false };
const pagers = {}, uiOpen = new Map(), specs = new Map();
let newRows = 0, nextSection = null;
// Two views of one page: Quick setup (plain-language steps to set up and run) and All settings (every key, by stage).
// A link to a section of All settings opens it; otherwise the last choice of this browser, Quick setup by default.
const ALL_SECTIONS = new Set(['overview', 'system', 'runtime-configuration', 'portals', 'packs', 'personas', 'simulation', 'providers', 'identity', 'settings', 'advanced', 'guidance']);
const storedView = () => { try { return localStorage.getItem('paqvilo-setup-view'); } catch { return null; } };
let view = ALL_SECTIONS.has(decodeURIComponent(location.hash.slice(1)).split('-')[0]) || ALL_SECTIONS.has(decodeURIComponent(location.hash.slice(1))) || storedView() === 'all' ? 'all' : 'quick';
// Quick setup state: found exports, running previews and the last preview operation, the step being changed.
let quick = null, preview = null, quickEditing = null, quickSite = null, restartHint = false, previewError = '', quickMapOpen = false, savedAt = 0;
const quickTarget = () => (state ? quickUi.targetOf(state, quickSite ?? state.settings?.defaultSite) : null);
const quickSession = () => { const target = quickTarget(); return (preview?.sessions ?? []).find(item => (target?.project ? true : item.site === target?.id)) ?? null; };
const extraAttributes = (extra, hint) => `${extra.id ? ` id="${esc(extra.id)}"${hint ? ` aria-describedby="${esc(extra.id)}-help"` : ''}` : ''}${extra.placeholder !== undefined && extra.placeholder !== null && extra.placeholder !== '' ? ` placeholder="${esc(extra.placeholder)}"` : ''}${extra.list ? ` list="${esc(extra.list)}"` : ''}`;
// Field guidance sits behind an (i) tooltip next to the label; with an id the tooltip stays the control's description.
const tip = (text, label, id) => (text ? kit.info({ id: id ? `${id}-help` : undefined, label: `About ${label}`, text }) : '');
const labelText = (label, hint, id) => `<span class="field-label">${esc(label)}${tip(hint, label, id)}</span>`;
const field = (label, name, value, hint = '', type = 'text', extra = {}) => `<div><label${extra.id ? ` for="${esc(extra.id)}"` : ''}>${labelText(label, hint, extra.id)}<input name="${esc(name)}" type="${type}" value="${esc(value)}"${extraAttributes(extra, hint)}></label></div>`;
const area = (label, name, value, hint, id, className = '') => `<div><label for="${esc(id)}">${labelText(label, hint, id)}<textarea id="${esc(id)}" name="${esc(name)}" aria-describedby="${esc(id)}-help"${className ? ` class="${className}"` : ''} spellcheck="false">${esc(value)}</textarea></label></div>`;
const check = (label, name, checked, id, hint = '') => `<div><label class="checkbox-line" for="${esc(id)}"><input id="${esc(id)}" name="${esc(name)}" type="checkbox" ${checked ? 'checked' : ''}${hint ? ` aria-describedby="${esc(id)}-help"` : ''}>${esc(label)}</label>${tip(hint, label, id)}</div>`;
// One option builder: [value, text] pairs; the selected option compares as text.
const optionList = (pairs, chosen) => pairs.map(([value, text]) => `<option value="${esc(value)}" ${String(value) === String(chosen ?? '') ? 'selected' : ''}>${esc(text)}</option>`).join('');
const choice = (label, name, values, chosen, id = '', hint = '') => `<div><label${id ? ` for="${esc(id)}"` : ''}>${labelText(label, hint, id)}<select${id ? ` id="${esc(id)}"` : ''} name="${esc(name)}"${hint && id ? ` aria-describedby="${esc(id)}-help"` : ''}>${optionList(values, chosen)}</select></label></div>`;
const slug = text => String(text ?? '').replace(/[^a-zA-Z0-9-]+/g, '-');
const lines = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const identifier = text => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(text) && !/^(?:constructor|prototype|__proto__)$/i.test(text);
const helpText = key => HELP[key]?.intro ?? '';
const catalogueDoc = key => state.settingsCatalogue?.find(item => item.key === key)?.doc ?? '';
const fileName = file => String(file ?? '').split(/[\\/]/).pop();
const adminUrl = () => state.runtime?.links?.administration ?? (state.runtime?.portalUrl && state.runtime.liveProxy ? new URL('/_sim/', state.runtime.portalUrl).href
  : !state.runtime && quickSession()?.ready ? quickSession().adminUrl ?? new URL('/_sim/', quickSession().url).href : '/_sim/');
// Setup and /_sim/ share an origin only when Mirage mounts this page itself (no separate portal URL, relative administration link).
const liveRuntime = () => Boolean(state?.runtime?.product === 'Mirage' && !state.runtime.portalUrl && String(adminUrl()).startsWith('/'));
// Where the running preview's live views are read: /_sim/api on the same origin, else the setup server's read-only relay
// (`mirage dev` serves setup on its own port); null without a running Mirage preview.
// A preview found by Quick setup (no preview started this page) is read through the relay by its site.
const liveBase = () => (liveRuntime() ? '/_sim/api' : state?.runtime?.liveProxy || quickSession()?.ready ? '/_setup/api/runtime' : null);
const liveQuery = (query = new URLSearchParams()) => {
  if (!liveRuntime() && !state?.runtime?.liveProxy && quickSession()?.site) query.set('site', quickSession().site);
  return query.size ? `?${query}` : '';
};
const packText = list => (list ?? []).map(item => typeof item === 'string' ? `pack | ${item}` : `${item.id} | ${item.module}`).join('\n');
function packLines(text) {
  const packs = lines(text).map(line => { const [id, ...parts] = line.split('|'); const module = parts.join('|').trim(); if (!identifier(id.trim()) || !module) throw new Error('Use id | module path for each trusted pack.'); return { id: id.trim(), module }; });
  if (new Set(packs.map(item => item.id)).size !== packs.length) throw new Error('Pack IDs must be unique.');
  return packs;
}
/** Push a set/delete edit when the next value differs from the previous one (undefined deletes). */
const update = (edits, path, next, previous) => { if (JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null)) edits.push(next === undefined ? { op: 'delete', path } : { op: 'set', path, value: next }); };
const number = (text, label) => { if (text === '') return undefined; const value = Number(text); if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`); return value; };
/** The (i) guidance of a section: its own intro plus the shared help entries (docs/setup.md stages) named by `keys`. */
function sectionHelp(title, intro, ...keys) {
  const entries = keys.map(key => HELP[`setup.${key}`]).filter(Boolean);
  return kit.info({ label: `About ${title}`, text: [intro, ...entries.map(entry => entry.intro)].filter(Boolean).join(' '), steps: entries.flatMap(entry => entry.steps ?? []),
    example: entries.find(entry => entry.example)?.example, docs: [...new Set(entries.map(entry => entry.doc).filter(Boolean))].map(doc => kit.docLink(doc, state.docs)) });
}
const note = (text, label = 'More information') => kit.info({ label, text });
const SIMULATION_LEVELS = { 'local-state': 'Local state (existing compatibility)', 'dry-run': 'Dry run · memory edits', simulation: 'Simulation · pack DATA writes', deep: 'Deep simulation · DATA and schema' };
const optionText = (name, value) => (name === 'runtime-kind' ? runtimeName(value) : name === 'simulation-level' ? SIMULATION_LEVELS[value] ?? value : value);
const select = (label, name, values, chosen) => choice(label, name, values.map(value => [value, optionText(name, value)]), chosen);
const source = site => `<div class="notice"><strong>${site.sourceStatus.format ? `${esc(site.sourceStatus.layout?.dialect ?? site.sourceStatus.format)} export` : site.sourceStatus.exists ? 'Folder needs an export' : 'Source folder missing'}</strong><p class="code-text source-path">${esc(site.sourceStatus.path || 'No source selected')}</p><span class="ui-badge ui-tone-neutral">${site.sourceStatus.git ? `${esc(site.sourceStatus.git.branch)} · ${esc(site.sourceStatus.git.commit)}${site.sourceStatus.git.changed ? ' · tracked changes in this folder' : ''}` : ''}${site.sourceStatus.gitState === 'timeout' ? ' · Git status unavailable (timeout)' : site.sourceStatus.gitState === 'unavailable' ? ' · Git status unavailable' : !site.sourceStatus.git ? 'No committed Git checkout' : ''}</span></div>`;
function notice(message, error = false) {
  const node = $('#notice'); node.hidden = false; node.className = `activity-feedback ${error ? 'error' : 'done'}`;
  node.setAttribute('role', error ? 'alert' : 'status'); node.textContent = message;
  // A confirmation fades after a few seconds; errors stay until the next action.
  clearTimeout(notice.timer);
  if (!error && /^(Saved|Nothing|Preview|Created|Done)/.test(message)) notice.timer = setTimeout(() => { if (node.textContent === message) node.hidden = true; }, 5000);
}
function beginOperation(message) {
  pending = true;
  pendingFocus = document.activeElement;
  const controls = [...document.querySelectorAll('#content input, #content select, #content textarea, #content button, #refresh')].map(node => [node, node.disabled]);
  for (const [node] of controls) node.disabled = true;
  $('#content').setAttribute('aria-busy', 'true');
  notice(message); $('#notice').className = 'activity-feedback pending';
  return () => {
    pending = false; pendingFocus = undefined; $('#content').removeAttribute('aria-busy');
    for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
  };
}
function renderPreservingContext() {
  // Sections the user saw keep their open state; sections that appear for the first time take their default.
  const sections = [...document.querySelectorAll('#content details[data-section-key]')];
  const seen = new Set(sections.map(node => node.dataset.sectionKey)), open = new Set(sections.filter(node => node.open).map(node => node.dataset.sectionKey));
  const focused = pendingFocus ?? document.activeElement, form = focused?.closest('form');
  const focus = form ? { type: form.dataset.form, site: form.dataset.site, key: form.dataset.key, name: focused.name, submit: focused.type === 'submit' } : null;
  const previousNext = nextSection;
  render();
  for (const node of document.querySelectorAll('#content details[data-section-key]')) if (seen.has(node.dataset.sectionKey)) node.open = open.has(node.dataset.sectionKey);
  // When a save moves the next step to another stage, that stage opens.
  if (nextSection && nextSection !== previousNext) document.getElementById(nextSection)?.setAttribute('open', '');
  if (focus) {
    const replacement = [...document.querySelectorAll('#content form')].find(node => node.dataset.form === focus.type && node.dataset.site === focus.site && node.dataset.key === focus.key);
    const control = focus.submit ? replacement?.querySelector('button[type=submit]') : [...(replacement?.elements ?? [])].find(node => node.name === focus.name);
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
    if (deadline.signal.aborted) throw new Error(options.method && options.method !== 'GET'
      ? 'The configuration request timed out. Its result may be unknown; refresh and check the configuration before retrying.'
      : 'Loading configuration timed out. Try Refresh to reconnect.');
    throw error;
  } finally { clearTimeout(timer); }
}
async function load() {
  if (pending) return;
  const finish = beginOperation(state ? 'Refreshing project configuration…' : 'Loading project configuration…');
  try {
    // A successful load needs no banner: the status strip shows the result; errors and saves still report in #notice.
    state = await request('/_setup/api/status'); await Promise.all([loadQuick(), pollPreview(true)]); await loadRuntimeInfo(); dirty = false; renderPreservingContext(); $('#notice').hidden = true;
    if (firstRender) { firstRender = false; if (location.hash) reveal(decodeURIComponent(location.hash.slice(1)), true); }
  }
  catch (error) { notice(error.message, true); }
  finally { finish(); }
  pollDashboard();
}
// Runtime lists for datalists and pack badges (D19): only from the runtime serving this page; any failure leaves free text.
// ponytail: read once per status load (Refresh status rereads); poll them with the dashboard if presets or packs change while the page stays open.
async function loadRuntimeInfo() {
  const base = liveBase();
  if (!base) { runtimeInfo = {}; return; }
  const get = url => fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }).then(response => (response.ok ? response.json() : null)).catch(() => null);
  const [status, packs] = await Promise.all([get(`${base}/status${liveQuery()}`), get(`${base}/packs${liveQuery()}`)]);
  runtimeInfo = { status, packs };
}
// The save notice follows the restart comparison: required, already matching, or unknown (RU3-14, RU3-02).
function savedNotice(runtime) {
  if (!runtime) return 'Saved. Your next preview will use these settings.';
  if (runtime.restartRequired === true) return `Saved. Restart the preview to apply configuration changes: ${runtime.restartCommand}`;
  if (runtime.restartRequired === false) return 'Saved. The running preview already matches this configuration.';
  return `Saved. The configuration could not be compared with the running preview (${runtime.restartReason}); restart it to be sure: ${runtime.restartCommand}`;
}
/** Saves through the validated configuration API; true when the save succeeded. */
async function save(payload) {
  if (pending) return false;
  const finish = beginOperation('Validating and saving configuration…');
  try {
    state = await request('/_setup/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': state.csrf }, body: JSON.stringify({ layer, ...payload, revision: state.revision }) });
    dirty = false; savedAt = Date.now(); renderPreservingContext(); notice(view === 'quick' ? 'Saved.' : savedNotice(state.runtime));
    return true;
  } catch (error) { notice(error.message, true); return false; }
  finally { finish(); }
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
  if (title && view === 'all') $('#breadcrumb').textContent = target === section ? title : `${title} › ${target.querySelector('h2, h3, legend, summary')?.textContent.trim() || 'section'}`;
  for (const node of document.querySelectorAll('.is-target')) node.classList.remove('is-target');
  void target.offsetWidth; target.classList.add('is-target');
}
const operation = (path, value) => ({ op: 'set', path, value });
const runtimeName = kind => ({ 'power-pages': 'Power Pages + model-driven apps', 'model-driven': 'Model-driven apps', 'dataverse-api': 'Dataverse API only' })[kind] ?? kind;
function runtimeEditor(settings, site) {
  const runtime = settings.runtime ?? { kind: 'power-pages' }, simulation = settings.simulation, key = site ? slug(site.id) : 'project';
  // Catalogue sites show effective values; keys that only defaults.mirage sets are named, so a site value is a deliberate override (RB-09).
  const inherited = name => (site?.inherited?.[name] ? `<p class="muted small">Inherited from defaults.mirage; saving a different value sets this target's own ${esc(name)}.</p>` : '');
  const apps = runtimeApps();
  return `<form class="form-grid" data-form="runtime" id="runtime-${key}" ${site ? `data-site="${esc(site.id)}"` : ''}>
    <div class="inline-fields">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], runtime.kind)}<div data-app-choice ${runtime.kind === 'dataverse-api' ? 'hidden' : ''}>${field('Default application GUID', 'defaultApp', runtime.defaultApp ?? '', `Optional imported app. Leave empty for the available default.${apps.length ? ' Suggestions come from the running preview.' : ''}`, 'text', { id: `runtime-${key}-app`, list: apps.length ? 'app-options' : '' })}</div></div>${inherited('runtime')}
    <div class="inline-fields">${choice('Simulation level', 'simulation-level', ['local-state', 'dry-run', 'simulation', 'deep'].map(value => [value, optionText('simulation-level', value)]), simulation?.level ?? 'local-state', `runtime-${key}-level`, 'Dry run: edit records in memory; no runtime state or pack writes. Simulation: update existing pack DATA files. Deep: also allow schema changes in declared DATA/schema destinations. Local state keeps the ignored-state behavior of older configurations. Pack modules declare file ownership; setup never runs them. Changes apply after restart and do not flush in-memory edits.')}<div class="api-fields"><label class="checkbox-line"><input name="api-enabled" type="checkbox" ${settings.dataverse?.enabled || runtime.kind === 'dataverse-api' ? 'checked' : ''}>Enable organization HTTP API</label>${field('API port', 'api-port', settings.dataverse?.port ?? 0, '0 chooses a free port. TLS, tenant and registrations are under Identity & API.', 'number', { id: `runtime-${key}-api-port` })}</div></div>${inherited('simulation')}
    ${check('Run trusted Solution JavaScript, form events, command actions and standard field PCF controls', 'trusted-extensions', settings.modelDriven?.trustedExtensions === true, `runtime-${key}-trusted`, 'Enable only for project code you trust. Extensions run in the local app with your selected staff permissions. Unsupported APIs and controls report a limitation. Restart after changing trust.')}
    ${area('Model-driven client sources', 'client-sources', (settings.modelDriven?.clientSources ?? []).join('\n'), 'Optional: one local folder of unpacked client resources per line (modelDriven.clientSources). Resolved paths are shown; unchanged lines are not rewritten.', `runtime-${key}-client-sources`)}
    ${state.kind === 'project' ? `${!state.sites.length ? `<div class="inline-fields" data-portal-source ${runtime.kind === 'power-pages' ? '' : 'hidden'}>${field('Power Pages target name', 'portal-id', 'portal', 'Used only when selecting Power Pages.')}${field('Power Pages export path', 'portal-path', '', 'Add an existing export to switch this standalone project to Power Pages.')}</div>` : '<p class="muted">Existing portal selections are retained when using a standalone profile and become active again when switching back to Power Pages.</p>'}${area('Solution exports', 'runtime-solutions', (state.settings.solutions ?? []).map(item => item.path).join('\n'), 'One existing local folder per line, relative to this project file. Existing Solution IDs are retained for unchanged paths.', `runtime-${key}-solutions`)}${area('Trusted data packs', 'runtime-packs', (state.settings.dataPacks ?? []).map(item => `${item.id} | ${item.module}`).join('\n'), 'One id | module path per line. Register modules explicitly; exports and DATA files remain in your project.', `runtime-${key}-packs`)}` : ''}
    <div class="toolbar"><button type="submit" class="button primary">Save runtime configuration</button><span class="muted">Applies at the next preview start.</span></div></form>`;
}
function envRow(id = '', settings = {}, siteId = '') {
  return `<div class="environment-editor"><div class="inline-fields">${field('Environment name', 'env-id', id)}${field('Portal origin', 'env-url', settings.url ?? '', 'HTTP(S) origin only; no sign-in links or query tokens.')}</div><div class="row"><label class="checkbox-line"><input name="env-caution" type="checkbox" ${settings.caution ? 'checked' : ''}>Real data · caution</label><button class="button" type="button" data-remove-env>Remove</button></div>
    <details class="disclosure" ${id && siteId ? `data-section-key="env-${esc(siteId)}-${esc(id)}"` : ''}><summary>Baseline, scope and start page</summary><div class="inline-fields">${field('Baseline', 'env-baseline', settings.baseline ?? '', 'Optional Git ref compared for changed-only overlays.')}${field('Start page', 'env-start', settings.startPath ?? '', 'Optional first page for this environment.')}</div>${choice('Source scope', 'env-scope', [['', 'Site default'], ['all', 'all'], ['changed', 'changed']], settings.scope ?? '', `env-${slug(siteId)}-${slug(id) || `new-${++newRows}`}-scope`)}</details></div>`;
}
function siteEditor(site) {
  if (state.kind === 'project') return `<form class="form-grid" data-form="project-site" data-site="${esc(site.id)}">${field('Portal export path', 'source', site.source, 'Relative to this Mirage project file.')}<div class="toolbar"><button type="submit" class="button primary">Save source</button></div></form>`;
  if (site.runtime?.kind && site.runtime.kind !== 'power-pages') return `<form class="form-grid" data-form="standalone-site" data-site="${esc(site.id)}">${field('Mirage port', 'port', site.mirage.port ?? '', '0 chooses a free port.', 'number')}<div class="inline-fields">${area('Solution export folders', 'solutions', (site.mirage.solutionRoots ?? state.settings.solutionRoots ?? []).join('\n'), 'One existing local path per line, relative to the source root. This target needs no portal export or environment URL.', `standalone-${slug(site.id)}-solutions`)}${area('Trusted data packs', 'site-packs', (site.mirage.dataPacks ?? []).map(item => typeof item === 'string' ? `pack | ${item}` : `${item.id} | ${item.module}`).join('\n'), 'One id | module path per line. Modules are not executed by setup.', `standalone-${slug(site.id)}-packs`)}</div><div class="toolbar"><button type="submit" class="button primary">Save sources</button></div></form>`;
  const key = slug(site.id), presets = runtimePresets();
  return `<form class="form-grid" data-form="site" data-site="${esc(site.id)}" id="site-${key}"><div class="inline-fields">${field('Portal export folder', 'source', site.source, 'Relative to the source root; absolute paths also work.', 'text', { id: `site-${key}-source` })}${field('Default environment', 'defaultEnv', site.defaultEnv)}${field('Mirage port', 'port', site.mirage.port ?? '', '0 chooses a free port.', 'number', { id: `site-${key}-port` })}${field('Start page', 'startPath', site.startPath ?? '/')}</div>
    <div class="inline-fields">${area('Solution export folders', 'solutions', (site.mirage.solutionRoots ?? []).join('\n'), 'One path per line, relative to the source root. Leave empty when this portal needs none.', `site-${key}-solutions`)}${area('Trusted data packs', 'site-packs', packText(site.mirage.dataPacks), `One id | module path per line. ${helpText('setup.packs.module')} Setup checks that the file exists and never runs it.`, `site-${key}-packs`)}</div>
    <div class="inline-fields">${field('Startup data preset', 'preset', site.mirage.preset ?? '', `Optional data preset ID from a trusted pack, seeded at startup.${presets.length ? ' Suggestions come from the running preview.' : ''}`, 'text', { id: `site-${key}-preset`, list: presets.length ? 'preset-options' : '' })}${choice('Startup preset mode', 'presetMode', [['', 'Not set'], ['bootstrap', 'bootstrap · keep an existing state'], ['always', 'always · reapply at every start']], site.mirage.presetMode, `site-${key}-preset-mode`)}${choice('Preset configuration', 'presetConfiguration', [['', 'Not set'], ['data-only', 'data-only'], ['apply', 'apply · also apply its linked configuration']], site.mirage.presetConfiguration, `site-${key}-preset-configuration`, helpText('setup.packs.preset'))}</div>
    <h3>Environments</h3><div data-environments>${Object.entries(site.environments).map(([id, settings]) => envRow(id, settings, site.id)).join('')}</div><button type="button" class="button" data-add-env>Add environment</button>
    <details class="disclosure" data-section-key="preview-${esc(site.id)}"><summary>Preview rules</summary>${select('Source scope', 'scope', ['all', 'changed'], site.scope ?? 'all')}${area('Route rules (YAML)', 'routes', JSON.stringify(site.routes ?? [], null, 2), 'Explicit file, directory or passthrough mappings. Other inline/markup settings are in Configuration & rules.', `site-${key}-routes`, 'ui-mono')}</details>
    <div class="toolbar"><button type="submit" class="button primary">Save portal</button><span class="muted">Writes the ${layer} configuration.</span></div></form>`;
}
// stages[].anchor (lense/setup/store.mjs) is the one stage→section map.
const sectionOf = item => String(item?.anchor ?? '#overview').slice(1);
// The setting editor shows each stage's remaining keys in the section owning the stage; project and start keys sit with the document and defaults.
const editorSection = item => (item.id === 1 ? 'advanced' : item.id === 10 ? 'settings' : sectionOf(item));
const STAGE_STATUS = { done: ['done', 'ok'], next: ['next step', 'info'], optional: ['optional', 'neutral'], blocked: ['to do', 'warn'] };
const STATUS_ORDER = ['next', 'blocked', 'done', 'optional'];
// Keys with a dedicated guided control; the setting editor offers every other catalogue key.
const DEDICATED = new Set(['sourceRoot', 'defaultSite', 'portals', 'includeCaution', 'browser.channel', 'browser.headless', 'browser.profileDir', 'browser.profile', 'browser.userDataDir', 'browser.profileDirectory', 'browser.cdpUrl', 'browser.debugPort', 'browser.bypassCSP', 'agent.enabled', 'liveReload', 'panel', 'editor', 'sourceMaps', 'sites',
  'source', 'defaultEnv', 'environments', 'startPath', 'scope', 'routes', 'solutionRoots', 'dataPacks', 'port', 'preset', 'presetMode', 'presetConfiguration', 'runtime', 'simulation', 'modelDriven', 'dataverse', 'dataverse.applications', 'personaContexts', 'identityProvider',
  'solutions', 'lcid', 'watch', 'stateDirectory']);
const dedicated = item => DEDICATED.has(item.key) && !(item.key === 'portals' && item.scope === 'project');
const SITE_FIELDS = new Set(['source', 'defaultEnv', 'environments', 'startPath', 'webFiles', 'inline', 'markup', 'scope', 'routes']);
const FINDING_STEPS = { 'missing-source': 'select the portal export folder', 'placeholder-origin': 'replace the example.test origin', 'missing-solution': 'select the Solution folder', 'source-layout': 'select the export inside the checkout', 'missing-pack': 'write or select the pack module' };
const IDENTITY_LISTS = { applications: ['appId', 'displayName', 'secretEnvironmentVariable'], users: ['domainname', 'fullname'], managedIdentities: ['clientId', 'displayName'], federatedIssuers: ['issuer'] };
const lists = new Map();

const runtimePresets = () => {
  const found = new Map();
  // [id, name, the name of the project pack that offers it, or null for a built-in set]
  const packs = new Map((runtimeInfo.packs?.packs ?? []).map(pack => [pack.id, pack.name ?? pack.id]));
  for (const item of runtimeInfo.packs?.library ?? []) if (item?.id && !found.has(item.id)) found.set(item.id, [item.name ?? item.id, item.pack ? packs.get(item.pack) ?? item.pack : null]);
  for (const item of runtimeInfo.status?.presets ?? runtimeInfo.status?.availablePresets ?? []) if (item?.id && !found.has(item.id)) found.set(item.id, [item.name ?? item.id, null]);
  return [...found].map(([id, [name, pack]]) => [id, name, pack]);
};
const runtimeApps = () => (Array.isArray(runtimeInfo.status?.modelDrivenApps) ? runtimeInfo.status.modelDrivenApps : [])
  .map(app => [app?.id ?? app?.appId ?? app?.appid, app?.name ?? app?.uniqueName ?? '']).filter(([id]) => typeof id === 'string' && id);
const datalists = () => `<datalist id="preset-options">${runtimePresets().map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')}</datalist>`
  + `<datalist id="app-options">${runtimeApps().map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('')}</datalist>`;

// Lists over 10 rows get the shared pager; each list re-renders alone (search, size, page) so other drafts stay intact.
function list(key, items, columns, options = {}) {
  const html = () => {
    if (items.length <= 10) return kit.table({ key, columns, items, caption: options.caption, emptyText: options.emptyText });
    const result = kit.pageItems(items, pagers[key] ??= {}, options.text ? { text: options.text } : undefined);
    pagers[key].page = result.page;
    return kit.table({ key, columns, result, caption: options.caption, emptyText: options.emptyText });
  };
  lists.set(key, html);
  return `<div class="list" data-list="${esc(key)}">${html()}</div>`;
}
function rerenderTable(key, search = false) {
  const host = document.querySelector(`[data-list="${CSS.escape(key)}"]`), html = lists.get(key);
  if (host && html) {
    const open = new Set([...host.querySelectorAll('details[data-section-key][open]')].map(node => node.dataset.sectionKey));
    host.innerHTML = html();
    for (const node of host.querySelectorAll('details[data-section-key]')) node.open = open.has(node.dataset.sectionKey);
  } else if (key === 'dashboard-activity') refreshSystem(true);
  if (search) { const input = document.querySelector(`[data-table-search="${CSS.escape(key)}"]`); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }
}
function applyUiOpen(root) { for (const node of root.querySelectorAll('details[data-ui-section]')) if (uiOpen.has(node.dataset.uiSection)) node.open = uiOpen.get(node.dataset.uiSection); }

// A collapsible section: one title row with its (i) guidance and status badge; the guidance never sits inside the heading.
function stage(id, opened, { title, help = '', badge, body }) {
  const stages = (state.stages ?? []).filter(item => sectionOf(item) === id);
  const status = STATUS_ORDER.find(name => stages.some(item => item.status === name));
  const mark = badge ?? (status ? kit.badge(...STAGE_STATUS[status]) : '');
  return `<details id="${id}" class="stage panel" data-section-key="${id}"${opened.has(id) ? ' open' : ''}><summary><div class="panel-heading"><div class="title-row"><h2>${esc(title)}</h2>${help}</div>${mark}</div></summary><div class="stage-body">${body}</div></details>`;
}
// The stage rail uses the sidebar items of /_sim/: the step number in the icon slot (green when done), one line per stage.
// Done and optional stages carry their status as text for assistive technology; open stages show a small badge.
const SECTION_TITLES = { overview: 'project status', system: 'Your system at a glance', 'runtime-configuration': 'Runtime configuration', portals: 'Targets & sources', packs: 'Data packs', personas: 'Personas & scenarios',
  simulation: 'Simulation & state', providers: 'Providers & services', identity: 'Identity & API', settings: 'Project settings', advanced: 'Configuration & rules', guidance: 'Start & verify' };
const railHtml = () => (state.stages ?? []).map(item => {
  const [text, tone] = STAGE_STATUS[item.status] ?? [item.status, 'neutral'];
  const status = ['done', 'optional'].includes(item.status) ? `<span class="ui-sr-only">${esc(text)}</span>` : kit.badge(text, tone);
  const section = SECTION_TITLES[sectionOf(item)];
  return `<a class="nav-item is-${esc(item.status)}${item.status === 'next' ? ' active" aria-current="step' : ''}" href="#${esc(sectionOf(item))}" title="${esc(`Stage ${item.id}, ${item.title}: ${text}.${section ? ` Opens the ${section} section.` : ''}`)}"><span class="nav-icon rail-step" aria-hidden="true">${esc(item.id)}</span><span class="rail-title">${esc(item.title)}</span>${status}</a>`;
}).join('');

// ---- Setting editor (D17, D18): every catalogue key without a dedicated form, saved to the layer its badge names.
const valueExample = example => {
  const rows = String(example ?? '').replace(/\n$/, '').split('\n');
  if (rows.length === 1) return rows[0].replace(/^[^:]+:\s*/, '');
  return rows.slice(1).map(row => row.replace(/^ {2}/, '')).join('\n');
};
// Every row carries the current authored value (the status exposes each document's keys, secrets as references only);
// known is false only when that document could not be read, and such a row offers no blind replace or delete.
function settingTargets(item) {
  const path = item.key.split('.'), at = source => path.reduce((value, key) => value?.[key], source);
  if (item.scope === 'catalogue') return [{ path, layer, value: at(state.settings), known: true }];
  if (item.scope === 'site') return state.sites.map(site => (SITE_FIELDS.has(item.key)
    ? { site, path: ['sites', site.id, ...path], layer, value: site[item.key], known: true }
    : { site, path: ['sites', site.id, 'mirage', ...path], layer, value: (site.authoredMirage ?? site.mirage)?.[item.key], known: true, inherited: site.inherited?.[item.key] ? (site.effectiveMirage ?? site.mirage)?.[item.key] : undefined }));
  const values = state.layers.shared.values;
  if (item.scope === 'portal') return state.sites.map((site, index) => ({ site, path: ['portals', index, ...path], layer: 'shared', value: at(values?.portals?.[index]), known: Boolean(values) }));
  if (state.kind === 'project') return [{ path, layer: 'shared', value: at(values), known: Boolean(values) }];
  return state.sites.map(site => { const linked = state.layers[`project:${site.id}`]; return linked ? { site, path, layer: `project:${site.id}`, file: linked.file, value: at(linked.values), known: Boolean(linked.values) } : { site, missing: true }; });
}
// A value the status reduced to references (secrets, connection settings, or defaults holding them) is never replaced from this page.
const referencesOnly = (item, value) => value !== undefined && (item.redact || (item.key === 'defaults' && ['secrets', 'connections'].some(key => value?.mirage?.[key] !== undefined)));
const shownValue = value => (value === undefined ? '' : JSON.stringify(value, null, 2));
function referenceSummary(item, value) {
  const entries = item.key === 'defaults' ? Object.entries({ ...(value.mirage?.secrets ?? {}), ...(value.mirage?.connections ?? {}) }) : Array.isArray(value) ? value.map((entry, index) => [entry?.appId ?? index, entry]) : Object.entries(value ?? {});
  return `<ul class="references">${entries.map(([name, entry]) => `<li><code>${esc(name)}</code>${entry?.kind ? ` · ${esc(entry.kind === 'protected' ? 'protected value' : 'environment variable')}` : ''}${entry?.provider ? ` · ${esc(entry.provider)}` : ''}${Array.isArray(entry?.settings) && entry.settings.length ? ` · settings: ${esc(entry.settings.join(', '))}` : ''}</li>`).join('')}</ul>`;
}
const settingId = ({ item, target }) => `setting-${slug(target.site?.id ?? 'root')}-${slug(item.key)}`;
function settingInfo(row) {
  const { item, target } = row, id = settingId(row);
  const scope = target.missing ? 'project file (not linked)' : state.kind === 'project' ? 'project file' : target.layer;
  const notes = [item.doc,
    item.pending && 'Accepted by shape only: the module that owns this key has not registered its parser in this build.',
    item.redact && (item.redactHelp ?? 'References only: validation refuses literal secret values; never paste one here.'),
    target.inherited !== undefined && 'Inherited from defaults.mirage (shown as the placeholder); saving sets this target\'s own value.'].filter(Boolean);
  return `<span class="title-row"><code class="setting-key">${esc(item.key)}</code>${kit.info({ id: `${id}-help`, label: `About ${item.key}`, text: notes.join(' '), example: item.example, docs: item.contract ? [kit.docLink(item.contract, state.docs)] : [] })}</span>${target.site ? ` <span class="muted">· ${esc(target.site.id)}</span>` : ''}`
    + `<div class="setting-badges">${kit.badge(scope, String(target.layer).startsWith('project:') ? 'info' : 'neutral')}${item.pending ? ` ${kit.badge('parser pending', 'warn')}` : ''}${item.redact ? ` ${kit.badge('references only', 'warn')}` : ''}</div>`;
}
function settingControl(row) {
  const { item, target } = row, id = settingId(row);
  if (target.missing) return `<p class="muted">Set sites.${esc(target.site.id)}.mirage.project to a .yml, .yaml or .json Mirage project file to edit this project-only key here.</p>`;
  const advanced = `<a href="#advanced" data-yaml-layer="${esc(target.layer)}">Configuration &amp; rules</a>`;
  if (!target.known) return `<p class="muted">The current value of ${esc(item.key)} is not available because its document did not validate. Edit it in ${advanced}.</p>`;
  if (referencesOnly(item, target.value)) return `${referenceSummary(item, target.value)}<p class="muted">Shown as references only. Add, change or remove these entries in the verbatim document in ${advanced}${target.file ? ` (${esc(fileName(target.file))})` : ''}; this page never replaces them.</p>`;
  specs.set(id, row);
  const value = target.value, described = `aria-describedby="${esc(id)}-help"`;
  const inherited = target.inherited === undefined ? '' : typeof target.inherited === 'object' ? JSON.stringify(target.inherited, null, 2) : String(target.inherited);
  const options = pairs => optionList(pairs, value);
  const control = ['list', 'object'].includes(item.kind)
    ? `<textarea id="${esc(id)}" name="value" class="ui-mono" rows="5" spellcheck="false" ${described} placeholder="${esc(inherited || valueExample(item.example))}">${esc(shownValue(value))}</textarea>`
    : item.kind === 'boolean' ? `<select id="${esc(id)}" name="value" ${described}>${options([['', inherited ? `Not set (inherits ${inherited})` : 'Not set'], ['true', 'true'], ['false', 'false']])}</select>`
    : item.kind === 'choice' ? `<select id="${esc(id)}" name="value" ${described}>${options([['', inherited ? `Not set (inherits ${inherited})` : 'Not set'], ...(item.choices ?? []).map(option => [option, option])])}</select>`
    : `<input id="${esc(id)}" name="value" type="${item.kind === 'number' ? 'number' : 'text'}" value="${esc(value ?? '')}" placeholder="${esc(inherited)}" ${described}>`;
  return `<form data-form="setting" data-key="${esc(item.key)}" data-site="${esc(target.site?.id ?? '')}" data-spec="${esc(id)}" class="setting-form"><label class="ui-sr-only" for="${esc(id)}">${esc(item.key)} value${target.site ? ` for ${esc(target.site.id)}` : ''}</label>${control}`
    + `<div class="toolbar"><button type="submit" class="button">Save setting ${esc(item.key)}</button>${['list', 'object'].includes(item.kind) ? note(`YAML for the value only, without the key line; the current value is shown${target.file ? ` from ${fileName(target.file)}` : ''}. Saving replaces the whole key and drops comments inside it; empty removes the key.`, 'About YAML values') : ''}</div></form>`;
}
const SETTING_COLUMNS = [{ label: 'Setting', render: settingInfo }, { label: 'Value', render: settingControl }];
function settingEditor(sectionId) {
  if (!state.layers.shared.exists) return '';
  return (state.stages ?? []).filter(item => editorSection(item) === sectionId).map(({ id, title }) => {
    const rows = (state.settingsCatalogue ?? []).filter(item => item.stage === id && !dedicated(item)).flatMap(item => settingTargets(item).map(target => ({ item, target })));
    if (!rows.length) return '';
    return kit.section({ key: `settings-stage-${id}`, title: `Setting editor · ${title}`, summary: `${rows.length} setting${rows.length === 1 ? '' : 's'} without a dedicated form`,
      help: kit.info({ label: `About the ${title} settings`, text: `The other keys of this stage. Each row saves to the layer in its badge: ${state.kind === 'project' ? 'the project file' : `the ${layer} catalogue, or project:<target> for a linked Mirage project file`}. Lists and mappings are YAML snippets validated on save.`, docs: [kit.docLink('docs/configuration.md', state.docs)] }),
      body: list(`settings-${id}`, rows, SETTING_COLUMNS, { caption: `Settings for ${title}`, text: row => `${row.item.key} ${row.target.site?.id ?? ''} ${row.item.doc}` }) });
  }).join('');
}

// ---- System map (D21): planned from status.topology, live from /_sim/api/dashboard on the same origin.
function plannedPayload() {
  const target = state.kind === 'project' ? null : state.sites.find(site => site.id === state.settings.defaultSite) ?? state.sites[0];
  const kind = state.kind === 'project' ? state.settings.runtime?.kind : target?.runtime?.kind;
  const level = (state.kind === 'project' ? state.settings.simulation : (target?.effectiveMirage ?? target?.mirage)?.simulation)?.level;
  return { ...(state.topology ?? {}), runtime: { product: state.runtime?.product ?? 'Mirage', kind: kind ?? 'power-pages', simulationLevel: level ?? 'local state (no level set)' } };
}
const isLive = () => Boolean(dashboard && liveBase());
const currentPayload = () => (isLive() ? dashboard : plannedPayload());
// Setup shows the header and the map; activity, preflight and the configuration summary belong to the simulator workspace.
const SYSTEM_PARTS = { guide: false, kpis: false, feed: false, blocking: false, configuration: false };
function systemBody() {
  const source = !isLive() && liveBase() ? kit.notice(dashboardError ? `Live status is unavailable (${dashboardError}); showing the plan from configuration.` : 'Connecting to the running preview…', 'neutral') : '';
  return source + renderDashboard(currentPayload(), { mode: isLive() ? 'live' : 'planned', docs: state.docs, previousActivity: isLive() ? previousActivity : undefined, history: isLive() ? activityHistory : [], help: HELP, kit, icons, parts: SYSTEM_PARTS, compact: true });
}
function nodeDetail(node) {
  const html = renderNodeDetail(node, state.docs, { kit, icons, payload: currentPayload() });
  // Node links name /_sim/ views: open them in Administration when it serves this origin; planned nodes have no view to open.
  return isLive() ? html.replace(/href="#/, `href="${esc(adminUrl())}#`) : html.replace(/<p class="ui-drawer-actions">[\s\S]*?<\/p>/, '');
}
function afterSystem() {
  const slot = $('#dashboard-node-detail'), node = nodeId && (currentPayload().nodes ?? []).find(item => item.id === nodeId);
  if (slot) slot.innerHTML = node ? nodeDetail(node) : '';
}
function afterPreflight() {
  const requires = $('#dashboard-preflight-requires'), strict = $('#dashboard-preflight-strict'), result = $('#dashboard-preflight-result');
  if (requires) requires.value = preflightInput.requires;
  if (strict) strict.checked = preflightInput.strict;
  if (result) result.innerHTML = preflightView();
}
function refreshSystem(force = false) {
  const body = $('#system-body');
  // A poll never replaces controls the user is working in; the next poll catches up.
  // ponytail: whole-section re-render per poll; patch node statuses and tiles in place if the map grows past a few hundred nodes.
  if (view === 'quick') return refreshQuick(force);
  if (!body || (!force && body.contains(document.activeElement))) return;
  body.innerHTML = systemBody(); applyUiOpen(body); afterSystem();
  const badge = $('#system > summary .ui-badge'); if (badge) badge.outerHTML = systemBadge();
}
const systemBadge = () => (isLive() ? kit.badge('live', 'ok') : kit.badge('planned', 'info'));
// One poll at a time, so responses never resolve out of order and previousActivity pairs consecutive feeds.
// The map refreshes every 5 seconds while the tab is visible and the section is open (it opens first by default).
let polling = false;
async function pollDashboard() {
  if (polling || !state || !liveBase() || pending || document.visibilityState !== 'visible' || !(view === 'quick' ? quickSession()?.ready : $('#system')?.open)) return;
  polling = true;
  try {
    const response = await fetch(`${liveBase()}/dashboard${liveQuery()}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    previousActivity = dashboard?.activity; if (previousActivity) { activityHistory.push(previousActivity); if (activityHistory.length > 12) activityHistory.shift(); } dashboard = next; dashboardError = '';
  } catch (error) { dashboardError = error.message; }
  finally { polling = false; }
  refreshSystem();
}
// ---- Quick setup: found exports (read once per status load), running previews (polled) and preview operations.
async function loadQuick() {
  if (view !== 'quick') return;
  try { quick = await request('/_setup/api/quick'); } catch { quick = { candidates: { portals: [], solutions: [], packs: [] } }; }
}
let previewTimer = null, previewPolling = false;
async function pollPreview(silent = false) {
  if (previewPolling || !state || document.visibilityState !== 'visible') return;
  previewPolling = true;
  const before = preview?.operation?.state;
  try {
    const response = await fetch('/_setup/api/preview', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    preview = await response.json(); previewError = '';
  } catch {
    // While the preview that serves this page restarts, nothing answers: keep the last state and try again.
    if (preview?.operation?.state !== 'running') { previewError = 'Setup cannot read the preview status right now; it keeps trying.'; preview ??= { sessions: [], operation: null }; }
  } finally { previewPolling = false; }
  const now = preview?.operation?.state;
  clearTimeout(previewTimer);
  if (before === 'running' && now !== 'running') {
    if (now === 'done') { restartHint = false; notice({ start: 'Preview started.', restart: 'Preview restarted with your saved settings.', stop: 'Preview stopped.' }[preview.operation.action] ?? 'Done.'); }
    if (liveRuntime()) return location.reload();
    dashboard = null; await loadRuntimeInfo();
  }
  if (now === 'running' || (quickSession() && !quickSession().ready)) previewTimer = setTimeout(() => pollPreview(), 1500);
  if (!silent) { refreshQuick(); if (view === 'all' && !state.runtime && liveChanged()) { await loadRuntimeInfo(); renderPreservingContext(); } }
  pollDashboard();
}
// All settings reads the found preview as Quick setup does; it repaints when the preview starts or stops.
let lastLive = null;
const liveChanged = () => { const now = Boolean(quickSession()?.ready); const changed = now !== lastLive; lastLive = now; if (changed && !now) { dashboard = null; runtimeInfo = {}; } return changed; };
function quickHtml() {
  const target = quickTarget(), session = quickSession(), live = isLive() ? dashboard : null;
  const mapHtml = session?.ready && live ? (quickMapOpen ? renderDashboard(live, { mode: 'live', docs: state.docs, kit, icons, help: HELP, parts: SYSTEM_PARTS, compact: true }) : '<p class="muted">Loading…</p>') : '';
  // A failed start from before the last save no longer describes this configuration.
  const operation = preview?.operation?.state === 'failed' && Date.parse(preview.operation.at) < savedAt ? null : preview?.operation;
  return quickUi.quickView({ state, kit, esc, target, session, quick, editing: quickEditing, operation, apps: runtimeApps(), presets: runtimePresets(), restartHint, previewError, checking: preview === null,
    dashboard: live, productName: node => PRODUCT_OF(node.id, node.kind, node.label).name, mapHtml, mapOpen: quickMapOpen });
}
// A poll never replaces a quick form the user is filling in (focused, changed or choosing a folder); the next poll catches up.
function refreshQuick(force = false) {
  const host = $('#quick');
  if (view !== 'quick' || !host || (!force && (document.activeElement?.closest?.('#quick form') || host.querySelector('form.is-changed') || $('#folder-picker').open))) return;
  // Polls repaint only what changed, so a pointer or tooltip on the page is not disturbed every few seconds.
  const html = quickHtml();
  if (!force && html === host.dataset.rendered) return;
  host.innerHTML = html; host.dataset.rendered = html; afterSystem(); syncShell();
}
// A setup page opened on its own (no preview serves it) links the sidebar and top bar to a preview it found running.
function syncShell() {
  if (!state || state.runtime) return;
  const session = quickSession()?.ready ? quickSession() : null, link = key => session?.links?.[key] ? new URL(session.links[key], session.url).href : null;
  const admin = session ? link('administration') ?? new URL('/_sim/', session.url).href : null, portal = quickTarget()?.parts?.website ? link('powerPages') : null;
  const area = $('#area-simulator');
  if (admin) { area.href = admin; area.removeAttribute('aria-disabled'); } else { area.removeAttribute('href'); area.setAttribute('aria-disabled', 'true'); }
  area.querySelector('.muted').hidden = Boolean(admin);
  $('#open-simulator').hidden = !admin; if (admin) $('#open-simulator').href = admin;
  $('#open-portal').hidden = !portal; if (portal) $('#open-portal').href = portal;
  $('#setup-state').textContent = session ? `Preview running${session.site ? ` · ${session.site}` : ''}` : 'Local configuration';
}
/** The parts ticked in a Quick setup form; at least one. */
function chosenParts(data) {
  const ticked = new Set(data.getAll('part').map(String));
  if (!ticked.size) throw new Error('Choose at least one thing to run.');
  return Object.fromEntries(Object.keys(quickUi.PARTS).map(key => [key, ticked.has(key)]));
}
async function quickSave(edits) {
  if (!edits.length) { quickEditing = null; refreshQuick(true); return notice('Nothing changed.'); }
  if (!(await save({ operations: edits }))) return;
  quickEditing = null; if (quickSession()) restartHint = true;
  refreshQuick(true);
}
async function previewAction(action) {
  const target = quickTarget();
  if (preview?.operation?.state === 'running') return;
  if (action === 'stop' && liveRuntime() && !confirm('This page is served by the preview. Stopping it also closes this page until you open setup again. Stop the preview?')) return;
  // The step shows the operation at once, before the runner answers.
  preview = { ...(preview ?? {}), operation: { action, site: target?.project ? null : target?.id, state: 'running', step: action === 'stop' ? 'stop' : action === 'restart' ? 'stop' : 'start', at: new Date().toISOString() } };
  refreshQuick(true);
  try {
    const response = await fetch('/_setup/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': state.csrf },
      body: JSON.stringify({ action, site: target?.project ? null : target?.id }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? 'The preview could not be changed.');
    preview = { ...(preview ?? {}), operation: data.operation }; previewError = '';
  } catch (error) { previewError = error.message; }
  refreshQuick(true);
  clearTimeout(previewTimer); previewTimer = setTimeout(() => pollPreview(), 1500);
}
function setView(next) {
  if (next === view) return;
  view = next === 'all' ? 'all' : 'quick';
  try { localStorage.setItem('paqvilo-setup-view', view); } catch { /* the choice is only a convenience */ }
  Promise.all([view === 'quick' && !quick ? loadQuick() : null, pollPreview(true)]).then(async () => { await loadRuntimeInfo(); render(); });
  render();
}
// ---- Folder picker (Quick setup): browse the folders of this computer, see what each holds, choose one for the open form.
const picker = { kind: null, form: null, data: null };
const PICK = {
  website: { title: 'Choose your website export folder', help: 'Open folders until you reach the one that holds your website export (a website.yml file or a .powerpages-site folder). Folders that hold one are marked.', noun: 'website export' },
  solution: { title: 'Choose a Solution folder', help: 'Open folders until you reach an unpacked Solution (it holds an Other/Solution.xml file). Folders that hold one are marked.', noun: 'Solution' },
};
const kindText = kind => (kind ? `${kind.type === 'website' ? 'Website export' : 'Solution'}${kind.name ? `: ${kind.name}` : ''}` : '');
async function openFolder(folder) {
  const here = $('#folder-picker-here');
  try { picker.data = await request(`/_setup/api/folders${folder ? `?path=${encodeURIComponent(folder)}` : ''}`); }
  catch (error) { here.className = 'folder-picker-here'; here.textContent = error.message; return; }
  const data = picker.data, match = data.kind?.type === picker.kind, noun = PICK[picker.kind].noun;
  $('#folder-picker-input').value = data.path;
  here.className = `folder-picker-here${match ? ' is-match' : ''}`;
  here.textContent = match ? `This folder is a ${kindText(data.kind)}. Choose “Use this folder”.` : data.kind ? `This folder holds a ${kindText(data.kind)}, not a ${noun}.` : `This folder is not a ${noun}. Open one of the folders below.`;
  $('#folder-picker-list').innerHTML = (data.parent ? `<li><button type="button" class="folder-row" data-folder-open="${esc(data.parent)}"><span>↑ Up one folder</span></button></li>` : '')
    + (data.folders.length ? data.folders.map(item => `<li><button type="button" class="folder-row" data-folder-open="${esc(item.path)}"><span>📁 ${esc(item.name)}</span>${item.kind ? `<span class="tag">${esc(kindText(item.kind))}</span>` : ''}</button></li>`).join('') : '<li class="empty">No folders inside this one.</li>');
}
function openPicker(kind, form) {
  Object.assign(picker, { kind, form, data: null });
  $('#folder-picker-title').textContent = PICK[kind].title; $('#folder-picker-help').textContent = PICK[kind].help;
  $('#folder-picker').showModal(); openFolder('');
}
function useFolder() {
  const { data, kind, form } = picker;
  if (!data || !form?.isConnected) return $('#folder-picker').close();
  if (data.kind?.type !== kind && !confirm(`This folder does not look like a ${PICK[kind].noun}. Use it anyway?`)) return;
  const found = [...form.querySelectorAll(`input[name="${kind}"]`)].find(input => input.value && quickUi.normalPath(input.value) === quickUi.normalPath(data.value));
  if (found) found.checked = true;
  else if (kind === 'website') {
    form.querySelector('[name="website-other"]').value = data.value;
    form.querySelector('[data-picked="website"]').innerHTML = `<code>${esc(data.shown)}</code>`;
    form.querySelector('input[name="website"][value=""]').checked = true;
  } else form.querySelector('[data-folder-list="solution"]').insertAdjacentHTML('beforeend', quickUi.folderRowHtml(esc, 'solution', data.value, data.shown));
  form.classList.add('is-changed');
  $('#folder-picker').close();
}
$('#folder-picker').addEventListener('click', event => {
  const open = event.target.closest('[data-folder-open]');
  if (open) return openFolder(open.dataset.folderOpen);
  if (event.target.closest('[data-folder-go]')) return openFolder($('#folder-picker-input').value.trim());
  if (event.target.closest('[data-folder-use]')) useFolder();
});
$('#folder-picker-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); openFolder(event.target.value.trim()); } });
$('#folder-picker').addEventListener('close', () => { picker.form?.querySelector(`[data-pick-folder="${picker.kind}"]`)?.focus(); });
function showNode(id) {
  const node = (currentPayload().nodes ?? []).find(item => item.id === id), slot = $('#dashboard-node-detail');
  if (!node || !slot) return;
  nodeId = id; slot.innerHTML = nodeDetail(node); slot.querySelector('[data-drawer-close]')?.focus();
}
function preflightView() {
  if (!preflight) return '';
  if (preflight.error) return kit.notice(preflight.error, 'bad');
  const report = preflight.report ?? {}, summary = report.summary ?? {};
  const rows = [...(report.requirements ?? [])].sort((a, b) => Number(Boolean(b.blocking)) - Number(Boolean(a.blocking)) || String(a.status).localeCompare(String(b.status)));
  return `<p class="chip-row">${kit.badge(`${summary.total ?? rows.length} requirements`, 'info')} ${kit.badge(`${summary.satisfied ?? 0} satisfied`, 'ok')} ${kit.badge(`${summary.blocking ?? 0} blocking`, summary.blocking ? 'bad' : 'ok')}</p>`
    + list('preflight', rows, [
      { label: 'Requirement', render: row => `<code>${esc(row.id)}</code>` },
      { label: 'Kind', render: row => esc(row.kind) },
      { label: 'Status', render: row => `${kit.badge(row.status, row.status === 'satisfied' ? 'ok' : row.blocking ? 'bad' : 'warn')}${row.blocking ? ` ${kit.badge('blocking', 'bad')}` : ''}` },
      { label: 'Detail', render: row => esc(row.message ?? '') },
    ], { caption: 'Preflight requirements', emptyText: 'No requirement is in scope.', text: row => `${row.id} ${row.kind} ${row.status} ${row.message ?? ''}` });
}
// Requirements check (Start & verify): preflight of the running preview, on demand; the CLI command otherwise.
function preflightBlock() {
  const command = `npx paqvilo mirage preflight ${state.commandArgs?.file ?? ''}${state.commandArgs?.site ? ` ${state.commandArgs.site}` : ''}`;
  const help = note('Preflight lists what the configuration needs that this runtime cannot provide: placeholders, unsupported components and declared services that do not answer. Empty requirements check everything; * matches any characters and matching ignores case. Strict makes every unsatisfied requirement in scope blocking.', 'About the requirements check');
  const head = `<div class="title-row"><h3>Check requirements</h3>${help}</div>`;
  if (!liveBase()) return `${head}<p class="muted">Start the preview to run it here, or run <code>${esc(command)} --strict</code>.</p>`;
  return `${head}<form id="dashboard-preflight" class="preflight-form"><label class="ui-sr-only" for="dashboard-preflight-requires">Requirements (ids or globs, separated by spaces)</label>`
    + '<input id="dashboard-preflight-requires" name="requires" type="text" placeholder="All requirements, or ids and globs: cloud-flow:* table:x_item">'
    + '<label class="checkbox-line"><input id="dashboard-preflight-strict" name="strict" type="checkbox"> Strict</label><button type="submit" class="button primary">Run preflight</button></form><div id="dashboard-preflight-result"></div>';
}
async function runPreflight() {
  const query = new URLSearchParams();
  for (const id of preflightInput.requires.split(/\s+/).filter(Boolean)) query.append('requires', id);
  if (preflightInput.strict) query.set('strict', 'true');
  notice('Running preflight on the running preview…');
  try {
    const response = await fetch(`${liveBase()}/preflight${liveQuery(query)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? `Preflight failed (HTTP ${response.status}).`);
    preflight = { report: body }; notice(`Preflight finished: ${body.summary?.blocking ?? 0} blocking requirement(s).`);
  } catch (error) { preflight = { error: error.message }; notice(error.message, true); }
  const result = $('#dashboard-preflight-result'); if (result) result.innerHTML = preflightView();
}
function copyCommand(id) {
  const text = document.getElementById(id)?.textContent ?? '';
  if (!navigator.clipboard) return notice('Clipboard access is unavailable here; select the command and copy it.', true);
  navigator.clipboard.writeText(text).then(() => notice('Command copied.'), () => notice('Copying was refused; select the command and copy it.', true));
}

// ---- Section bodies
const RESTART_TEXT = {
  true: ['restart needed', 'warn', 'The saved configuration differs from the one the preview started with. Stop the preview, then start it again with the command shown.'],
  false: ['matches this configuration', 'ok', 'The running preview matches this configuration. After further saves, stop the preview and start it again with the command shown.'],
  null: ['restart to be sure', 'warn', 'The configuration could not be compared with the running preview, so a restart may be needed.'],
};
// The running preview in one line: state, restart need and the restart command; the explanations sit behind (i).
function runtimeBanner(runtime) {
  const known = typeof runtime.restartRequired === 'boolean' ? runtime.restartRequired : null, [status, tone, text] = RESTART_TEXT[known];
  const details = [text, known === null && runtime.restartReason ? `Reason: ${runtime.restartReason}.` : '', runtime.restartScope ? `The comparison covers ${runtime.restartScope}.` : '',
    helpText('setup.start.restart'), runtime.sourceDir ? `Running source: ${runtime.sourceDir}` : ''].filter(Boolean).join(' ');
  return `<div class="status-line"><span class="status-dot ready" aria-hidden="true"></span><strong>${esc(runtime.product)} preview running${runtime.site ? ` · ${esc(runtime.site)}` : ''}</strong>${kit.badge(status, tone)}${note(details, 'About the running preview')}`
    + (runtime.restartCommand ? `<code id="restart-command" class="command-text">${esc(runtime.restartCommand)}</code><button type="button" class="button quiet small" data-copy="restart-command">Copy</button>` : '') + '</div>';
}
function createFlow() {
  const project = state.kind === 'project', templates = state.templates ?? [];
  const kind = project ? 'This page edits a standalone Mirage project file (paqvilo setup --project): one runtime with a portal export or Solution exports, optional trusted packs and providers.'
    : 'This page edits a shared catalogue (paqvilo.config.yml): targets (Power Pages portals, model-driven or API-only runtimes), their environments and shared defaults, with a personal layer for local overrides.';
  const intro = `${kind} To explore the shipped example project instead, run npx paqvilo mirage demo. Run npx paqvilo init first if you also want project scripts, tests and agent instructions.`;
  return `<div class="title-row"><h3>Start from an example setup</h3>${note(intro, 'About creating the configuration')}</div>`
    + (templates.length ? `<form class="form-grid" data-form="template" id="form-template"><fieldset class="templates"><legend class="ui-sr-only">Example setups</legend>${templates.map((item, index) => `<label class="template" for="template-${esc(item.id)}"><span class="template-head"><input type="radio" id="template-${esc(item.id)}" name="template" value="${esc(item.id)}" ${index === 0 ? 'checked' : ''}><strong>${esc(item.title)}</strong>`
      + `${kit.info({ label: 'Expected next steps', text: `Expected next steps, not errors: ${(item.expectedFindings ?? []).map(code => FINDING_STEPS[code] ?? code).join('; ') || 'none'}.`, steps: item.nextSteps ?? [] })}</span>`
      + `<span class="template-text">${esc(item.description)}</span><span class="template-badges">${(item.surfaces ?? []).map(surface => kit.badge(runtimeName(surface), 'info')).join(' ')}</span></label>`).join('')}</fieldset>`
      + `<div class="inline-fields">${field('Target name', 'id', 'invented-portal', 'Letters, numbers and hyphens.', 'text', { id: 'template-target' })}${field('Source folder', 'root', '', 'Optional portal export or Solution folder, relative to the configuration file. Empty uses the template example path.', 'text', { id: 'template-root' })}</div>`
      + '<div class="toolbar"><button type="submit" class="button primary">Create from template</button></div></form>' : '')
    + `<div class="title-row"><h3>Start empty</h3>${note(`Writes a minimal ${project ? 'project file' : 'catalogue'} for one runtime surface; complete the stages one by one.`, 'About starting empty')}</div><form class="form-grid" data-form="create"><div class="inline-fields">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], 'power-pages')}${field('Target name', 'id', 'portal')}${field('Source root', 'root', './sources', 'Folder holding local exports; a portal is required only for Power Pages.')}</div><div class="toolbar"><button type="submit" class="button primary">Create ${project ? 'Mirage project' : 'catalogue'}</button></div></form>`;
}
// Where saves go: the shared or personal catalogue layer (the file is named in its tooltip); linked project files are listed under Configuration & rules.
function layerControl(personal) {
  const file = state.layers[layer]?.file ?? '';
  const text = [`Saves write ${file}.`, layer === 'personal' ? 'Personal overrides merge with shared settings; removing one reveals its shared value. Ignore paqvilo.config.local.yml in Git before using personal settings.' : '',
    state.kind === 'project' ? 'A standalone project file has no personal layer: every guided form writes the project file.' : '', helpText('setup.project.layers')].filter(Boolean).join(' ');
  return `<span class="save-target"><label for="layer">Save to</label>${personal ? `<select id="layer" class="compact-select">${optionList([['shared', 'shared'], ['personal', 'personal']], layer)}</select>` : kit.badge(state.kind === 'project' ? 'Project file' : 'Shared project')}`
    + `<span class="code-text muted">${esc(fileName(file))}</span>${kit.info({ label: 'About the save target', text, docs: HELP['setup.project.layers']?.doc ? [kit.docLink(HELP['setup.project.layers'].doc, state.docs)] : [] })}</span>`;
}
// The status strip: readiness, the running preview, where saves go, and the findings that need a step.
function overviewBody(personal) {
  const expected = new Set((state.templates ?? []).flatMap(item => item.expectedFindings ?? []));
  const anchor = section => (/^#[a-z0-9-]+$/i.test(section ?? '') ? section : '#overview');
  const stages = state.stages ?? [], count = state.findings.length, created = state.layers.shared.exists;
  const ready = kit.badge(count ? `${count} next step${count === 1 ? '' : 's'}` : 'Configuration ready', count ? 'warn' : 'ok');
  const head = `<div class="status-line"><strong>${created ? 'Project' : state.kind === 'project' ? 'Create your Mirage project' : 'Create your catalogue'}</strong>${ready}`
    + `${stages.length ? `<span class="muted">${stages.filter(item => item.status === 'done').length} of ${stages.length} stages done</span>` : ''}`
    + `${sectionHelp('the project', 'Readiness checks local configuration and folders. It does not prove browser coverage or a deployed commit.', 'project')}${created ? layerControl(personal) : ''}</div>`;
  return head + (state.runtime ? runtimeBanner(state.runtime) : '') + (!created ? createFlow() : '')
    + (state.findings.some(item => expected.has(item.code)) ? '<p class="muted small">Findings marked “next step” are expected after creating from a template or scaffold: they name the folders and origins you still choose. They are not errors.</p>' : '')
    // A linked-project finding opens its document in the YAML editor (RU3-15).
    + (count ? `<ul class="detail-list findings">${state.findings.map(item => `<li class="row"><span>${item.site ? `<strong>${esc(item.site)}</strong> · ` : ''}${esc(item.message)} ${expected.has(item.code) ? kit.badge('next step', 'info') : kit.badge('needs attention', 'warn')}</span><a href="${esc(anchor(item.section))}"${item.layer && state.layers[item.layer] ? ` data-yaml-layer="${esc(item.layer)}"` : ''}>Review</a></li>`).join('')}</ul>` : '');
}
function runtimeBody() {
  const editors = state.kind === 'project' ? runtimeEditor(state.settings)
    : state.sites.map(site => `<details class="disclosure" data-section-key="runtime-${esc(site.id)}"><summary>${esc(site.id)} · ${esc(runtimeName(site.runtime?.kind ?? 'power-pages'))}</summary>${runtimeEditor(site.effectiveMirage ?? site.mirage, site)}</details>`).join('');
  const solutions = state.solutions ?? [];
  return editors
    + (solutions.length ? `<h3>Solution folders</h3>${list('solutions', solutions, [{ label: 'Folder', render: item => `<span class="code-text source-path">${esc(item.path)}</span>` }, { label: 'Status', render: item => kit.badge(item.exists ? 'found' : 'missing', item.exists ? 'ok' : 'bad') }], { caption: 'Solution export folders' })}` : '')
    + settingEditor('runtime-configuration');
}
function portalsBody() {
  const cards = state.sites.map(site => `<section class="panel target-card" id="portal-${esc(site.id)}"><div class="panel-heading"><h3>${esc(site.id)}</h3>${kit.badge(runtimeName(site.runtime?.kind ?? 'power-pages'), site.runtime?.kind !== 'power-pages' || site.sourceStatus.format ? 'ok' : 'warn')}</div>${site.runtime?.kind && site.runtime.kind !== 'power-pages' ? '' : source(site)}`
    + (Object.keys(site.environments).length ? list(`environments-${site.id}`, Object.entries(site.environments), [
      { label: 'Environment', render: ([id]) => `<strong>${esc(id)}</strong>` },
      { label: 'Origin', render: ([, settings]) => `<span class="code-text source-path">${esc(settings.url)}</span>` },
      { label: 'Kind', render: ([, settings]) => (settings.caution ? kit.badge('REAL DATA', 'warn') : kit.badge('Environment', 'neutral')) },
    ], { caption: `Environments of ${site.id}`, text: ([id, settings]) => `${id} ${settings.url}` }) : '')
    + `${site.solutions.length ? `<p class="muted">${site.solutions.length} Solution folder(s) · ${site.solutions.filter(item => item.exists).length} found</p>` : ''}${site.packs?.length ? `<p class="muted">${site.packs.length} explicit pack module(s) · ${site.packs.filter(item => item.exists).length} found. <a href="#packs">Data packs</a></p>` : ''}<details class="disclosure" data-section-key="source-${esc(site.id)}"><summary>Edit source settings</summary>${siteEditor(site)}</details></section>`).join('');
  return `<div class="grid-two">${cards}</div>`
    + (state.kind === 'catalogue' ? `<details class="disclosure" data-section-key="add-target"><summary>Add a target</summary><form class="form-grid" data-form="add">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], 'power-pages')}<div class="inline-fields">${field('Target name', 'id', '')}${field('Portal export folder', 'source', '', 'Required only for Power Pages; relative to the source root.')}</div><div class="toolbar"><button type="submit" class="button primary">Add target</button></div></form></details>` : '')
    + settingEditor('portals');
}
function packsBody() {
  const rows = state.kind === 'project' ? (state.packs ?? []).map(pack => ({ ...pack, target: null })) : state.sites.flatMap(site => (site.packs ?? []).map(pack => ({ ...pack, target: site.id })));
  // A pack registered by its path (no id) is the loaded pack with the same module file.
  const slash = text => String(text ?? '').replace(/\\/g, '/').toLowerCase();
  const live = runtimeInfo.packs, livePack = pack => live?.packs?.find(item => (pack.id && item.id === pack.id) || (item.module && slash(pack.module).endsWith(`/${slash(item.module).replace(/^\.\//, '')}`)));
  const activation = pack => {
    if (!live) return kit.badge(liveBase() ? 'not reported' : 'start the preview to check', 'neutral');
    const item = livePack(pack);
    if (!item) return kit.badge('not loaded', 'warn');
    return item.matched === true ? kit.badge('matched', 'ok') : item.matched === false ? kit.badge('not matched', 'warn') : kit.badge('no portal context', 'neutral');
  };
  const table = list('packs', rows, [
    { label: 'Target', render: pack => esc(pack.target ?? 'project') },
    { label: 'Pack', render: pack => (pack.id ?? livePack(pack)?.id ? `<code>${esc(pack.id ?? livePack(pack).id)}</code>` : '<span class="muted">its own id</span>') },
    { label: 'Module', render: pack => `<span class="code-text source-path">${esc(pack.module)}</span>` },
    { label: 'File', render: pack => kit.badge(pack.exists ? 'found' : 'missing', pack.exists ? 'ok' : 'bad') },
    { label: 'Running preview', render: activation },
    { label: 'Diagnostics', render: pack => esc(livePack(pack)?.diagnostics?.length ?? '—') },
    { label: 'Edit', render: pack => `<a href="#${pack.target ? `portal-${esc(pack.target)}` : 'runtime-configuration'}">Edit registration</a>` },
  ], { caption: 'Registered data packs', emptyText: 'No pack is registered. Add id | module path lines in a target\'s Trusted data packs field.', text: pack => `${pack.target ?? ''} ${pack.id} ${pack.module}` });
  const summary = live ? `<p class="muted">The running preview loaded ${esc(live.packs?.length ?? 0)} pack(s), ${esc((live.packs ?? []).filter(item => item.matched === true).length)} matched. <a href="${esc(adminUrl())}#packs">Open Data packs in Administration</a></p>`
    + ((live.failed ?? []).length ? kit.notice(`Packs that failed to load: ${live.failed.map(item => `${item.module}: ${item.error}`).join('; ')}`, 'bad') : '') : '';
  return table + summary + settingEditor('packs');
}
function personasForm(site) {
  const key = slug(site.id), mirage = site.mirage ?? {}, contexts = mirage.personaContexts ?? {}, provider = mirage.identityProvider ?? {};
  return `<form class="form-grid" data-form="personas" data-site="${esc(site.id)}" id="personas-${key}"><div class="inline-fields">${field('Isolated persona contexts', 'maxInstances', contexts.maxInstances ?? '', `${helpText('setup.personas.maxInstances')} Empty uses the default.`, 'number', { id: `personas-${key}-max`, placeholder: '4' })}`
    + `${choice('Sign-in presentation', 'presentation', [['', 'Not set'], ['page', 'page'], ['dialog', 'dialog']], provider.presentation, `personas-${key}-presentation`, 'How the local identity provider shows its sign-in.')}</div>`
    + `${field('Sign-in title', 'title', provider.title ?? '', 'Title of the local identity provider page or dialog.', 'text', { id: `personas-${key}-title` })}<div class="toolbar"><button type="submit" class="button primary">Save personas</button></div></form>`;
}
const SCENARIOS_TEXT = 'Three things are called scenarios. Saved state scenarios (Administration → Scenarios) restore a data preset, persona and permission mode. Persona-catalogue scenarios from a pack launch isolated persona contexts. Preflight scenario files ({ id, requires }) scope paqvilo mirage preflight --scenario. The Startup data preset of a target is the data seeded at start.';
function personasBody() {
  const catalogues = (runtimeInfo.packs?.packs ?? []).filter(pack => Object.values(pack.personaCatalog ?? {}).some(Boolean));
  return (state.kind === 'catalogue' ? state.sites.map(site => `<details class="disclosure" data-section-key="personas-${esc(site.id)}"><summary>${esc(site.id)} · persona contexts and local sign-in</summary>${personasForm(site)}</details>`).join('')
      : kit.notice('personaContexts and identityProvider are catalogue settings; a standalone project file does not accept them. Personas still come from contacts in your data and from pack persona catalogues.', 'neutral'))
    + (catalogues.length ? `<h3>Persona catalogues in the running preview</h3>${list('persona-catalogues', catalogues, ['groups', 'personas', 'contexts', 'scenarios'].reduce((columns, name) => [...columns, { label: name[0].toUpperCase() + name.slice(1), render: pack => esc(pack.personaCatalog?.[name] ?? 0) }], [{ label: 'Pack', render: pack => `<code>${esc(pack.id)}</code>` }]), { caption: 'Persona catalogues by pack' })}<p class="muted"><a href="${esc(adminUrl())}#access">Manage personas in Administration → Portal identity &amp; permissions</a>.</p>` : '')
    + settingEditor('personas');
}
function simulationBody() {
  const targets = state.kind === 'project' ? [{ id: 'project', level: state.settings.simulation?.level, preset: null }]
    : state.sites.map(site => { const mirage = site.effectiveMirage ?? site.mirage ?? {}; return { id: site.id, level: mirage.simulation?.level, preset: mirage.preset, mode: mirage.presetMode, configuration: mirage.presetConfiguration }; });
  return list('simulation-targets', targets, [
    { label: 'Target', render: item => esc(item.id) },
    { label: 'Simulation level', render: item => kit.badge(item.level ?? 'local state', item.level ? 'info' : 'neutral') },
    { label: 'Startup data preset', render: item => (state.kind === 'project' ? '—' : item.preset ? `<code>${esc(item.preset)}</code>${item.mode ? ` · ${esc(item.mode)}` : ''}${item.configuration ? ` · ${esc(item.configuration)}` : ''}` : 'none') },
    { label: 'Change', render: item => `<a href="#runtime-configuration">Level</a>${state.kind === 'project' ? '' : ` · <a href="#portal-${esc(item.id)}">Preset</a>`}` },
  ], { caption: 'Simulation level and startup preset per target' }) + settingEditor('simulation');
}
// Provider keys have no dedicated form: the setting editor below lists them; their reference sits in the section guidance.
const PROVIDER_KEYS = ['storage', 'messaging', 'connections', 'secrets', 'localServices', 'serviceFixtures'];
function providersBody() {
  return settingEditor('providers');
}
const listText = (items, fields) => (Array.isArray(items) ? items : []).map(item => fields.map(name => item?.[name] ?? '').join(' | ').replace(/(?: \| )+$/, '')).join('\n');
function identityForm(settings, site) {
  const dataverse = settings?.dataverse ?? {}, key = site ? slug(site.id) : 'project', id = name => `identity-${key}-${name}`;
  return `<form class="form-grid" data-form="identity" id="identity-${key}" ${site ? `data-site="${esc(site.id)}"` : ''}>`
    + `<div class="inline-fields">${check('Serve the API over TLS', 'tls', dataverse.tls === true, id('tls'), 'Enable the listener and choose its port under Runtime surface.')}${field('TLS port', 'tlsPort', dataverse.tlsPort ?? '', '0 chooses a free port.', 'number', { id: id('tls-port') })}</div>`
    + field('Tenant ID', 'tenantId', dataverse.tenantId ?? '', 'Tenant GUID of the simulated organization.', 'text', { id: id('tenant') })
    + area('Application registrations', 'applications', listText(dataverse.applications, IDENTITY_LISTS.applications), 'One appId | display name | secret environment variable per line. References only: name the variable that holds the client secret; never paste a secret. Roles and other fields of an existing registration are kept.', id('applications'), 'ui-mono')
    + area('Users', 'users', listText(dataverse.users, IDENTITY_LISTS.users), 'One domain name | full name per line; roles and other fields of an existing user are kept.', id('users'), 'ui-mono')
    + area('Managed identities', 'managedIdentities', listText(dataverse.managedIdentities, IDENTITY_LISTS.managedIdentities), 'One client ID | display name per line; other fields are kept.', id('managed-identities'), 'ui-mono')
    + area('Federated issuers', 'federatedIssuers', listText(dataverse.federatedIssuers, IDENTITY_LISTS.federatedIssuers), 'One issuer per line; other fields of an existing issuer (jwks) are kept.', id('federated-issuers'), 'ui-mono')
    + area('Service protection limits (YAML)', 'serviceProtection', dataverse.serviceProtection ? JSON.stringify(dataverse.serviceProtection, null, 2) : '', 'Optional mapping of requestsPer300s, executionTimeMsPer300s and concurrentRequests. Empty keeps the defaults.', id('service-protection'), 'ui-mono')
    + '<div class="toolbar"><button type="submit" class="button primary">Save identity &amp; API</button></div></form>';
}
function identityBody() {
  const forms = state.kind === 'project' ? identityForm(state.settings)
    : state.sites.map(site => `<details class="disclosure" data-section-key="identity-${esc(site.id)}"><summary>${esc(site.id)} · TLS, tenant, registrations and users</summary>${identityForm(site.mirage ?? {}, site)}</details>`).join('');
  return forms + settingEditor('identity');
}
function settingsBody() {
  let form = '<p>Edit the project document in Configuration below.</p>';
  if (state.kind === 'catalogue' && state.settings.browser) {
    const browser = state.settings.browser, doc = key => catalogueDoc(key);
    form = `<form class="form-grid" data-form="settings"><div class="inline-fields">${field('Source root', 'sourceRoot', state.settings.sourceRoot, `Relative to the catalogue directory. Exports remain outside the toolkit.${state.settings.resolvedSourceRoot ? ` Effective: ${state.settings.resolvedSourceRoot} (${state.settings.provenance?.sourceRoot}).` : ''}`, 'text', { id: 'settings-source-root' })}${select('Default portal', 'defaultSite', ['', ...state.sites.map(site => site.id)], state.settings.defaultSite)}`
      + `${select('Browser', 'browser', ['msedge', 'chrome', 'chromium'], browser.channel)}${select('Development targets', 'portals', ['selected', 'all'], state.settings.portals)}</div><div class="row check-row"><label class="checkbox-line"><input name="liveReload" type="checkbox" ${state.settings.liveReload ? 'checked' : ''}>Reload on save</label><label class="checkbox-line"><input name="panel" type="checkbox" ${state.settings.panel ? 'checked' : ''}>Development panel</label>`
      + check('Include real-data (caution) environments in all-target commands', 'includeCaution', state.settings.includeCaution === true, 'settings-include-caution', doc('includeCaution')) + '</div>'
      + `<details class="disclosure" data-section-key="settings-browser"><summary>Browser profile, debugging, agent and editor</summary>`
      + `<div class="inline-fields">${check('Run the browser without a window', 'headless', browser.headless === true, 'settings-headless', doc('browser.headless'))}${check('Bypass the page content security policy', 'bypassCSP', browser.bypassCSP === true, 'settings-bypass-csp', doc('browser.bypassCSP'))}${check('Expose the bounded Lense agent API', 'agentEnabled', state.settings.agent?.enabled === true, 'settings-agent', doc('agent.enabled'))}${check('Map overlaid resources to source files', 'sourceMaps', state.settings.sourceMaps === true, 'settings-source-maps', doc('sourceMaps'))}</div>`
      + `<div class="inline-fields">${field('Profile folder', 'profileDir', browser.profileDir ?? '', doc('browser.profileDir'), 'text', { id: 'settings-profile-dir' })}${field('Named profile', 'profile', browser.profile ?? '', doc('browser.profile'), 'text', { id: 'settings-profile' })}${field('Existing user data folder', 'userDataDir', browser.userDataDir ?? '', doc('browser.userDataDir'), 'text', { id: 'settings-user-data' })}${field('Profile directory', 'profileDirectory', browser.profileDirectory ?? '', doc('browser.profileDirectory'), 'text', { id: 'settings-profile-directory' })}</div>`
      + `<div class="inline-fields">${field('DevTools endpoint (cdpUrl)', 'cdpUrl', browser.cdpUrl ?? '', doc('browser.cdpUrl'), 'text', { id: 'settings-cdp' })}${field('Remote debugging port', 'debugPort', browser.debugPort ?? '', doc('browser.debugPort'), 'number', { id: 'settings-debug-port' })}${field('Editor command', 'editor', state.settings.editor ?? '', doc('editor'), 'text', { id: 'settings-editor' })}</div></details>`
      + '<div class="toolbar"><button type="submit" class="button primary">Save defaults</button></div></form>';
  } else if (state.kind === 'project') {
    const settings = state.settings;
    form = `<form class="form-grid" data-form="project-settings" id="project-settings"><div class="inline-fields">${field('Locale ID (lcid)', 'lcid', settings.lcid ?? '', `${catalogueDoc('lcid')} Empty keeps the file value.`, 'number', { id: 'project-lcid', placeholder: '1033' })}${field('State folder', 'stateDirectory', settings.stateDirectory ?? '', `${catalogueDoc('stateDirectory')} Empty keeps the file value.`, 'text', { id: 'project-state-directory' })}`
      + `${choice('Reload when sources change', 'watch', [['', 'Keep the file value'], ['true', 'true'], ['false', 'false']], settings.watch === undefined ? '' : String(settings.watch), 'project-watch', catalogueDoc('watch'))}</div><div class="toolbar"><button type="submit" class="button primary">Save project settings</button></div></form>`;
  }
  const overrides = Object.entries(state.settings.effective ?? {});
  return form + (overrides.length ? `<p class="muted">${overrides.map(([key, setting]) => `<code>${esc(key)}</code> = ${esc(setting.value)} · ${esc(setting.origin)} overrides file defaults`).join('<br>')}</p>` : '') + settingEditor('settings');
}
function advancedBody() {
  const documents = Object.keys(state.layers).filter(key => key === 'shared' || key === 'personal' || key.startsWith('project:'));
  const current = state.layers[yamlLayer] ? yamlLayer : layer, linked = Object.entries(state.layers).filter(([key]) => key.startsWith('project:'));
  const editorNote = 'Use the full document for inline mapping, observations with evidence, packs and other supported settings. Invalid changes stay here until corrected; guided forms preserve unrelated configuration. The editor shows the document verbatim, as saved: it is the only place on this page that shows secrets and connection settings entries (elsewhere they appear as names only). A secrets protectedValue is machine-bound DPAPI ciphertext, not a secret value; secret values never belong in configuration.';
  return `<form class="form-grid" data-form="yaml">${documents.length > 1 ? choice('Document', 'yaml-layer', documents.map(key => [key, `${key} · ${fileName(state.layers[key].file)}`]), current, 'yaml-layer', 'The shared and personal catalogue layers and linked Mirage project files.') : ''}<label><span class="field-label">${esc(current)} configuration${kit.info({ label: 'About the configuration document', text: editorNote, docs: state.docs?.configuration?.href ? [{ href: state.docs.configuration.href, label: 'Settings reference', path: 'docs/configuration.md' }] : [] })}</span><textarea name="yaml" class="ui-mono yaml" spellcheck="false">${esc(state.layers[current]?.text || '{}\n')}</textarea></label>`
    + '<div class="toolbar"><button type="submit" class="button primary">Validate & save document</button></div></form>'
    + (linked.length ? `<div class="title-row"><h3>Linked Mirage project files</h3>${note('Project-only keys of a target live in its sites.<id>.mirage.project file. Rows of the setting editor marked project:<target> save there.')}</div>${list('linked-projects', linked.map(([key, item]) => ({ key, ...item })), [{ label: 'Layer', render: item => `<code>${esc(item.key)}</code>` }, { label: 'File', render: item => `<span class="code-text source-path">${esc(item.file)}</span>` }, { label: 'Status', render: item => kit.badge(item.exists ? 'found' : 'missing', item.exists ? 'ok' : 'warn') }], { caption: 'Linked project files' })}` : '')
    + settingEditor('advanced');
}
function guidanceBody() {
  // Arguments quoted by the server (status.commandArgs), as the restart command quotes them.
  const project = state.kind === 'project', arg = esc(state.commandArgs?.file ?? ''), at = state.commandArgs?.site ? ` ${esc(state.commandArgs.site)}` : '';
  const steps = [
    ['Install and check', 'In a scaffold, run <code>npm run setup</code>; otherwise <code>npx paqvilo doctor --setup</code>.'],
    ['Scaffold or compare', `${project ? '' : '<code>npx paqvilo init --check</code> lists remaining scaffold tasks. '}<code>npx paqvilo mirage demo</code> copies the shipped example project.`],
    ['Inspect', project ? `<code>npx paqvilo mirage inspect ${arg}</code>` : `<code>npx paqvilo lense doctor ${arg} --all</code>`],
    ['Generate data (optional)', `<code>npx paqvilo mirage data scaffold --profile smoke --state .paqvilo/smoke-state.json ${arg}${at}</code>`],
    ...(project ? [] : [['Standalone project (optional)', `<code>npx paqvilo mirage init ${arg}${at}</code>, then <code>npx paqvilo setup --project &lt;file&gt;</code>`]]),
    ['Start a preview', project ? `<code>npx paqvilo mirage serve ${arg}</code>` : `<code>npx paqvilo mirage dev ${arg}${at}</code> locally, or <code>npx paqvilo lense dev ${arg}${at}</code> for an authorized environment`],
  ];
  const docs = Object.entries(state.docs ?? {}).map(([key, link]) => ({ key, ...(link && typeof link === 'object' ? link : { href: link, path: key, label: key }) }));
  const featured = ['setupWorkspace', 'configuration', 'packs', 'simulation', 'personaCatalog', 'dataverseApi'].map(key => docs.find(item => item.key === key)).filter(item => item?.href);
  return preflightBlock()
    + `<div class="title-row"><h3>Commands for this configuration</h3>${note(`Run these from ${state.directory}. Setup never deploys, synchronizes, installs, imports pack code or contacts a live portal. Lense browser actions can affect live data; follow the user's scope and let them handle sign-in and MFA. Paqvilo ${state.version}: guide links open this release's tag (main for prereleases); the installed CLI --help and bundled docs describe the installed version.`, 'About these commands')}</div>`
    + `<dl class="command-list">${steps.map(([title, text]) => `<dt>${esc(title)}</dt><dd>${text}</dd>`).join('')}</dl>`
    + `<div class="toolbar">${featured.map(item => `<a href="${esc(item.href)}" target="_blank" rel="noreferrer">${esc(item.label)} ↗</a>`).join('')}</div>`
    + `<details class="disclosure" data-section-key="docs-all"><summary>All guides (${docs.length})</summary>${list('docs', docs, [{ label: 'Guide', render: item => (item.href ? `<a href="${esc(item.href)}" target="_blank" rel="noreferrer">${esc(item.label)} ↗</a>` : esc(item.label)) }, { label: 'Repository path', render: item => `<code>${esc(item.path)}</code>` }], { caption: 'Documentation', text: item => `${item.key} ${item.label} ${item.path}` })}</details>`;
}
const providerHelp = () => PROVIDER_KEYS.map(name => HELP[`setup.providers.${name}`] && `${name}: ${HELP[`setup.providers.${name}`].intro}`).filter(Boolean);

function render() {
  const runtime = state.runtime;
  const navigation = $('#runtime-navigation');
  const portalUrl = runtime?.links?.powerPages ?? runtime?.portalUrl ?? (runtime?.product === 'Mirage' && (!runtime.kind || runtime.kind === 'power-pages') ? '/' : null);
  const simUrl = runtime?.portalUrl ? new URL('/_sim/', new URL(runtime.portalUrl, location.href)).href : '/_sim/';
  const admin = runtime?.product === 'Mirage' ? runtime.links?.administration ?? simUrl : null;
  navigation.hidden = !runtime;
  navigation.innerHTML = runtime ? `<div class="nav-label area-label">RUNNING PREVIEW</div>${portalUrl ? `<a class="nav-item" href="${esc(portalUrl)}">← Back to portal</a>` : ''}${admin ? `<a class="nav-item" href="${esc(admin)}">Administration</a>${runtime.kind !== 'dataverse-api' ? `<a class="nav-item" href="${esc(runtime.links?.modelDriven ?? '/main.aspx')}">Model-driven apps</a>` : ''}` : ''}` : '';
  // Shell (D22): top bar actions, the AREAS switch and the sidebar status follow the running preview.
  const openSimulator = $('#open-simulator'), openPortal = $('#open-portal'), area = $('#area-simulator');
  openSimulator.hidden = !admin; if (admin) openSimulator.href = admin;
  openPortal.hidden = !portalUrl; if (portalUrl) openPortal.href = portalUrl;
  if (admin) { area.href = admin; area.removeAttribute('aria-disabled'); } else { area.removeAttribute('href'); area.setAttribute('aria-disabled', 'true'); }
  area.querySelector('.muted').hidden = Boolean(admin);
  $('#setup-state').textContent = runtime ? `${runtime.product} preview running${runtime.site ? ` · ${runtime.site}` : ''}` : 'Local configuration';
  $('#scope').textContent = state.directory;
  const created = state.layers.shared.exists;
  const personal = state.layers.personal;
  if (!personal) layer = 'shared';
  specs.clear(); lists.clear();
  // First render: the system map, the stage with the next step and the hash target are open (plus a project's runtime form).
  const next = (state.stages ?? []).find(item => item.status === 'next');
  const nextSections = next ? state.findings.filter(item => next.findings?.includes(item.code)).map(item => String(item.section ?? '').slice(1)) : [];
  nextSection = next && sectionOf(next) !== 'overview' ? sectionOf(next) : null;
  $('#breadcrumb').textContent = next ? next.title : 'Overview';
  const opened = new Set(['system', nextSection, ...nextSections, state.kind === 'project' && 'runtime-configuration', decodeURIComponent(location.hash.slice(1))]);
  const afterCreate = body => (created ? body : kit.notice('Create the configuration above first; this stage edits it.', 'neutral'));
  const rail = $('#stage-rail');
  rail.hidden = !(state.stages ?? []).length; rail.innerHTML = railHtml();
  document.body.dataset.setupView = view;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  syncShell();
  if (view === 'quick') {
    $('#breadcrumb').textContent = 'Quick setup';
    $('#content').innerHTML = datalists() + `<section id="quick" class="panel quick" aria-label="Quick setup">${quickHtml()}</section>`;
    afterSystem();
    if (state.canEdit === false) for (const button of document.querySelectorAll('#content form[data-form] button[type=submit]')) button.disabled = true;
    return;
  }
  $('#content').innerHTML = datalists() + `<section id="overview" class="panel overview-strip" aria-label="Project status">${overviewBody(personal)}</section>` + [
    stage('system', opened, { title: 'Your system at a glance', help: sectionHelp('the system map', 'Planned from configuration, or live from the running preview (refreshed every 5 seconds while this section is open and the tab is visible).', 'system'), badge: systemBadge(), body: `<div id="system-body">${systemBody()}</div>` }),
    stage('runtime-configuration', opened, { title: 'Runtime configuration', help: sectionHelp('runtime configuration', 'Choose the surfaces and write behavior for the next start. Staff users, app registrations, local secrets, certificates and federation of a running preview are managed in Administration → Organization identity & API.', 'runtime'), body: afterCreate(runtimeBody()) }),
    stage('portals', opened, { title: 'Targets & sources', help: sectionHelp('targets and sources', 'Power Pages targets use portal exports. Standalone apps and APIs use Solution exports and packs.', 'sources', 'environments'), body: afterCreate(portalsBody()) }),
    stage('packs', opened, { title: 'Data packs', help: sectionHelp('data packs', 'Trusted pack modules registered per target; what the running preview loaded and matched. Setup checks that module files exist and never runs them.', 'packs'), body: afterCreate(packsBody()) }),
    stage('personas', opened, { title: 'Personas & scenarios', help: sectionHelp('personas and scenarios', SCENARIOS_TEXT, 'personas'), body: afterCreate(personasBody()) }),
    stage('simulation', opened, { title: 'Simulation & state', help: sectionHelp('simulation and state', 'Where writes go and which data each start seeds.', 'simulation'), body: afterCreate(simulationBody()) }),
    stage('providers', opened, { title: 'Providers & services', help: kit.info({ label: 'About providers and services', text: [helpText('setup.providers'), state.kind === 'catalogue' ? 'Some provider keys are project-only: their rows are marked project:<target> and save to that target\'s linked Mirage project file.' : ''].filter(Boolean).join(' '), steps: providerHelp(), docs: HELP['setup.providers']?.doc ? [kit.docLink(HELP['setup.providers'].doc, state.docs)] : [] }), body: afterCreate(providersBody()) }),
    stage('identity', opened, { title: 'Identity & API', help: sectionHelp('identity and API', 'Staff users, app secrets (shown once), certificates and federated credentials of a running preview are managed in Administration → Organization identity & API. Configuration holds references only.', 'identity'), body: afterCreate(identityBody()) }),
    stage('settings', opened, { title: 'Project settings', help: state.kind === 'project' ? note('Project-wide settings of this Mirage project file: locale, state folder and source watching. Saves apply on the next start.', 'About project settings')
      : note('Defaults every command reads from this catalogue: the source root, default target, browser, development targets, and the Lense agent and editor options. Shell PAQVILO_* variables and .env values override them. Saves apply on the next start.', 'About project settings'), body: afterCreate(settingsBody()) }),
    stage('advanced', opened, { title: 'Configuration & rules', help: note('The full documents, with every key of the project stage.', 'About configuration and rules'), body: advancedBody() }),
    stage('guidance', opened, { title: 'Start & verify', help: sectionHelp('start and verify', 'Check requirements against the running preview, then the commands for this configuration file.', 'start'), body: guidanceBody() }),
  ].join('');
  applyUiOpen($('#content')); afterSystem(); afterPreflight();
  if (state.canEdit === false) for (const button of document.querySelectorAll('#content form[data-form] button[type=submit]')) button.disabled = true;
}
$('#content').addEventListener('input', event => {
  const target = event.target;
  if (target.matches('[data-table-search]')) { const key = target.dataset.tableSearch; pagers[key] = { ...pagers[key], search: target.value, page: 1 }; return rerenderTable(key, true); }
  if (target.id === 'dashboard-preflight-requires') { preflightInput.requires = target.value; return; }
  if (target.closest('form[data-form]') && !['layer', 'yaml-layer'].includes(target.id)) dirty = true;
  target.closest('#quick form')?.classList.add('is-changed');
});
$('#content').addEventListener('change', event => {
  const target = event.target;
  if (target.matches('[data-table-size]')) { const key = target.dataset.tableSize; pagers[key] = { ...pagers[key], size: Number(target.value), page: 1 }; return rerenderTable(key); }
  if (target.id === 'dashboard-preflight-strict') { preflightInput.strict = target.checked; return; }
  target.closest('#quick form')?.classList.add('is-changed');
  if (target.id === 'quick-site') { quickSite = target.value; quickEditing = null; dashboard = null; refreshQuick(true); pollDashboard(); return; }
  if (target.name === 'runtime-kind') {
    const form = target.closest('form');
    const portal = form.querySelector('[data-portal-source]'); if (portal) portal.hidden = target.value !== 'power-pages';
    const application = form.querySelector('[data-app-choice]'); if (application) { application.hidden = target.value === 'dataverse-api'; if (application.hidden) application.querySelector('input').value = ''; }
    if (target.value === 'dataverse-api' && form.querySelector('[name=api-enabled]')) form.querySelector('[name=api-enabled]').checked = true;
  }
  if (target.id === 'layer') {
    if (!['shared', 'personal'].includes(target.value)) return;
    if (dirty && !confirm('Discard unsaved form changes and switch configuration layer?')) { target.value = layer; return; }
    layer = target.value === 'personal' ? 'personal' : 'shared'; yamlLayer = null; dirty = false; renderPreservingContext();
  }
  if (target.id === 'yaml-layer') {
    if (!Object.hasOwn(state.layers, target.value)) return;
    if (dirty && !confirm('Discard unsaved form changes and open another document?')) { target.value = state.layers[yamlLayer] ? yamlLayer : layer; return; }
    yamlLayer = target.value; dirty = false; renderPreservingContext();
  }
});
$('#content').addEventListener('click', event => {
  const target = event.target;
  const quickEdit = target.closest('[data-quick-edit]');
  if (quickEdit) { quickEditing = quickEdit.dataset.quickEdit || null; refreshQuick(true); document.getElementById(`quick-${quickEditing}`)?.scrollIntoView({ block: 'nearest' }); return; }
  const pick = target.closest('[data-pick-folder]');
  if (pick) return openPicker(pick.dataset.pickFolder, pick.closest('form'));
  if (target.closest('[data-folder-remove]')) { const form = target.closest('form'); target.closest('li').remove(); form.classList.add('is-changed'); return; }
  const previewButton = target.closest('[data-preview]');
  if (previewButton) return previewAction(previewButton.dataset.preview);
  if (target.closest('[data-add-env]')) { const form = target.closest('form'); form.querySelector('[data-environments]').insertAdjacentHTML('beforeend', envRow('', {}, form.dataset.site)); dirty = true; }
  if (target.closest('[data-remove-env]')) { target.closest('.environment-editor').remove(); dirty = true; }
  const page = target.closest('[data-table-page]');
  if (page) { const key = page.dataset.tablePage; pagers[key] = { ...pagers[key], page: Math.max(1, (pagers[key]?.page ?? 1) + Number(page.dataset.delta)) }; return rerenderTable(key); }
  const copy = target.closest('[data-copy]');
  if (copy) return copyCommand(copy.dataset.copy);
  if (target.closest('[data-drawer-close]')) {
    const id = nodeId; nodeId = null; const slot = $('#dashboard-node-detail'); if (slot) slot.innerHTML = '';
    if (id) document.querySelector(`[data-node="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  const node = target.closest('[data-node]');
  if (node) showNode(node.dataset.node);
});
$('#content').addEventListener('keydown', event => {
  const node = event.target.closest?.('[data-node]');
  if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showNode(node.dataset.node); }
});
// details 'toggle' does not bubble: capture it to remember kit section state and to start live polling when the map opens.
$('#content').addEventListener('toggle', event => {
  if (event.target.dataset?.sectionKey === 'quick-map' && event.target.open !== quickMapOpen) { quickMapOpen = event.target.open; if (quickMapOpen) refreshQuick(true); return; }
  const key = event.target.dataset?.uiSection;
  if (key) uiOpen.set(key, event.target.open);
  if (event.target.id === 'system' && event.target.open) pollDashboard();
}, true);
document.addEventListener('click', event => {
  // An (i) button shows its guidance on focus; inside a section summary or a label it must not toggle the section or the control.
  if (event.target.closest?.('.ui-info-button')) { event.preventDefault(); event.target.closest('.ui-info-button').focus(); return; }
  const switcher = event.target.closest?.('[data-view]');
  if (switcher && state) return setView(switcher.dataset.view);
  const link = event.target.closest?.('a[href^="#"]'), href = link?.getAttribute('href'), document_ = link?.dataset.yamlLayer;
  // A Quick setup link into All settings, and the stage rail, switch to All settings first.
  if (link && state && view === 'quick' && (link.hasAttribute('data-quick-all') || ALL_SECTIONS.has(String(href).slice(1)))) setView('all');
  // Links to a document (a linked-project finding, a references-only row) open it in the YAML editor first.
  if (document_ && state?.layers[document_] && document_ !== (state.layers[yamlLayer] ? yamlLayer : layer)) {
    if (dirty && !confirm('Discard unsaved form changes and open another document?')) { event.preventDefault(); return; }
    yamlLayer = document_; dirty = false; renderPreservingContext();
  }
  if (href && href.length > 1) reveal(decodeURIComponent(href.slice(1)), true);
});
window.addEventListener('hashchange', () => { const id = decodeURIComponent(location.hash.slice(1)); if (view === 'quick' && ALL_SECTIONS.has(id)) setView('all'); reveal(id, true); });
// A tooltip near the right edge opens leftwards, so it never widens the page.
for (const type of ['mouseover', 'focusin']) document.addEventListener(type, event => {
  const holder = event.target.closest?.('.ui-info');
  if (holder) holder.classList.toggle('is-end', holder.getBoundingClientRect().left > document.documentElement.clientWidth - 400);
});
document.addEventListener('visibilitychange', () => { pollPreview(); pollDashboard(); });
// A page restored from the browser history shows old state: read it again.
window.addEventListener('pageshow', event => { if (event.persisted) load(); });
setInterval(pollDashboard, 5000);
setInterval(() => pollPreview(), 5000);
// ---- Form submissions: one handler per data-form. A handler saves itself, or returns the edits to save.
const SUBMIT = {
  async 'quick-create'({ data, value }) {
    const name = value('name');
    if (!identifier(name)) throw new Error('Use a project name made of letters, numbers, underscores or hyphens.');
    layer = 'shared';
    // Written as one guided edit per top-level key, so the new file is plain block YAML.
    const created = quickUi.createDocument({ parts: chosenParts(data), name, project: state.kind === 'project', candidates: quick?.candidates, port: quick?.port ?? 8787, apiPort: quick?.apiPort ?? null });
    if (await save({ operations: Object.entries(created).map(([key, value]) => ({ op: 'set', path: [key], value })) })) {
      await loadQuick(); quickEditing = null; render();
      notice(`Created ${fileName(state.layers.shared.file)} in ${state.directory}. Check the folders it uses in step 2.`);
    }
  },
  'quick-kind': ({ data }) => quickSave(quickUi.partsEdits(quickTarget(), chosenParts(data), quick?.candidates)),
  'quick-files'({ data, value }) {
    const target = quickTarget(), website = value('website') || value('website-other'), solutions = data.getAll('solution').map(String);
    if (target.parts.website && !website) throw new Error('Choose the folder of your website export.');
    if ((target.parts.modelDriven || target.parts.canvas) && !solutions.length) throw new Error('Choose at least one Solution folder: your apps are built from it.');
    return quickSave(quickUi.filesEdits(target, { website, solutions }));
  },
  'quick-data': ({ data, value }) => quickSave(quickUi.dataEdits(quickTarget(), { preset: data.has('preset') ? value('preset') : undefined, packs: data.getAll('pack').map(String), level: value('level') })),
  yaml: ({ data }) => save({ text: String(data.get('yaml')), layer: state.layers[yamlLayer] ? yamlLayer : layer }),
  template({ value }) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(value('id'))) throw new Error('Use a target name of 1-63 letters, numbers or hyphens.');
    layer = 'shared'; return save({ template: value('template'), values: { id: value('id'), root: value('root') }, layer: 'shared' });
  },
  setting({ form, data }) {
    const spec = specs.get(form.dataset.spec);
    if (!spec) throw new Error('Refresh status before saving this setting.');
    const { item, target } = spec, raw = String(data.get('value') ?? ''), text = raw.trim();
    // Rows without a shown current value, or with references only, render no form; refuse a stale one too (RU3-05).
    if (!target.known || referencesOnly(item, target.value)) return notice(`Edit ${item.key} in Configuration & rules; this page does not replace values it shows as references only.`, true);
    let edit;
    if (['list', 'object'].includes(item.kind)) {
      if (text === shownValue(target.value).trim()) return notice(`Nothing to save: ${item.key} is unchanged.`);
      edit = text ? { op: 'set', path: target.path, yaml: raw } : { op: 'delete', path: target.path };
    } else if (!text) edit = { op: 'delete', path: target.path };
    else edit = { op: 'set', path: target.path, value: item.kind === 'number' ? number(text, item.key) : item.kind === 'boolean' ? text === 'true' : text };
    if (edit.op === 'delete' && target.value === undefined) return notice(`Nothing to save: ${item.key} is not set here.`);
    if (edit.value !== undefined && JSON.stringify(edit.value) === JSON.stringify(target.value)) return notice(`Nothing to save: ${item.key} is unchanged.`);
    return save({ operations: [edit], layer: target.layer });
  },
  personas({ id, site, value, edits }) {
    const mirage = site.mirage ?? {}, prefix = ['sites', id, 'mirage'], max = number(value('maxInstances'), 'Isolated persona contexts');
    if (max !== undefined && (!Number.isInteger(max) || max < 0 || max > 32)) throw new Error('Isolated persona contexts must be a whole number from 0 to 32.');
    update(edits, [...prefix, 'personaContexts', 'maxInstances'], max, mirage.personaContexts?.maxInstances);
    update(edits, [...prefix, 'identityProvider', 'presentation'], value('presentation') || undefined, mirage.identityProvider?.presentation);
    update(edits, [...prefix, 'identityProvider', 'title'], value('title') || undefined, mirage.identityProvider?.title);
    if (!edits.length) return notice('Nothing to save: no persona setting changed.');
    return save({ operations: edits });
  },
  identity({ id, site, data, value, edits, set }) {
    const before = (site ? site.mirage?.dataverse : state.settings.dataverse) ?? {}, prefix = site ? ['sites', id, 'mirage', 'dataverse'] : ['dataverse'];
    if (data.has('tls') !== (before.tls === true)) set([...prefix, 'tls'], data.has('tls'));
    update(edits, [...prefix, 'tlsPort'], number(value('tlsPort'), 'TLS port'), before.tlsPort);
    update(edits, [...prefix, 'tenantId'], value('tenantId') || undefined, before.tenantId);
    for (const [name, fields] of Object.entries(IDENTITY_LISTS)) {
      const rows = lines(value(name));
      if (rows.join('\n') === lines(listText(before[name], fields)).join('\n')) continue;
      const entries = rows.map(line => {
        const parts = line.split('|').map(part => part.trim());
        if (!parts[0]) throw new Error(`Start each ${name} line with its ${fields[0]}.`);
        // Match an existing entry by its first field so roles, credentials and other authored fields survive.
        const entry = { ...((Array.isArray(before[name]) ? before[name] : []).find(item => item?.[fields[0]] === parts[0]) ?? {}) };
        fields.forEach((field, index) => { if (parts[index]) entry[field] = parts[index]; else delete entry[field]; });
        if (entry.secretEnvironmentVariable !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.secretEnvironmentVariable)) throw new Error('secretEnvironmentVariable names an environment variable; it never holds the secret itself.');
        return entry;
      });
      update(edits, [...prefix, name], entries.length ? entries : undefined, before[name]);
    }
    const protection = String(data.get('serviceProtection') ?? ''), shown = before.serviceProtection ? JSON.stringify(before.serviceProtection, null, 2) : '';
    if (protection.trim() !== shown.trim()) edits.push(protection.trim() ? { op: 'set', path: [...prefix, 'serviceProtection'], yaml: protection } : { op: 'delete', path: [...prefix, 'serviceProtection'] });
    if (!edits.length) return notice('Nothing to save: no identity setting changed.');
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
  create({ value }) {
    if (!identifier(value('id'))) throw new Error('Use a portal name with letters, numbers, underscores or hyphens.');
    const kind = value('runtime-kind'), runtime = { kind }, simulation = { level: 'dry-run' };
    const catalogue = { sourceRoot: value('root') || '.', defaultSite: value('id'), sites: { [value('id')]: { ...(kind === 'power-pages' ? { source: '.', defaultEnv: 'dev', environments: { dev: 'https://portal.example.test' } } : {}), mirage: { port: 0, runtime, simulation, ...(kind === 'dataverse-api' ? { dataverse: { enabled: true } } : {}) } } } };
    const project = { version: 2, runtime, simulation, ...(kind === 'power-pages' ? { defaultPortal: value('id'), portals: [{ id: value('id'), path: value('root') || '.' }] } : { solutions: [], ...(kind === 'dataverse-api' ? { dataverse: { enabled: true } } : {}) }) };
    layer = 'shared'; return save({ text: JSON.stringify(state.kind === 'project' ? project : catalogue, null, 2) });
  },
  runtime(context) {
    const { id, site, data, value, edits, set } = context;
    const before = site ? site.effectiveMirage ?? site.mirage : state.settings, prefix = site ? ['sites', id, 'mirage'] : [];
    const change = (path, next, previous) => { if (JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null)) next === undefined ? edits.push({ op: 'delete', path: [...prefix, ...path] }) : set([...prefix, ...path], next); };
    const kind = value('runtime-kind'), defaultApp = value('defaultApp');
    if (kind === 'dataverse-api' && defaultApp) throw new Error('Clear the default application for an API-only runtime.');
    change(['runtime', 'kind'], kind, before.runtime?.kind ?? 'power-pages');
    change(['runtime', 'defaultApp'], defaultApp || undefined, before.runtime?.defaultApp);
    if (value('simulation-level') === 'local-state' && before.simulation && site?.inherited?.simulation) throw new Error('Local state cannot override the simulation level inherited from defaults.mirage. Remove it from defaults in Configuration & rules, or choose a level.');
    change(['simulation'], value('simulation-level') === 'local-state' ? undefined : { level: value('simulation-level') }, before.simulation);
    change(['modelDriven', 'trustedExtensions'], data.has('trusted-extensions'), before.modelDriven?.trustedExtensions ?? false);
    const sources = lines(value('client-sources'));
    if (JSON.stringify(sources) !== JSON.stringify(before.modelDriven?.clientSources ?? [])) change(['modelDriven', 'clientSources'], sources.length ? sources : undefined, before.modelDriven?.clientSources);
    const apiEnabled = data.has('api-enabled');
    if (kind === 'dataverse-api' && !apiEnabled) throw new Error('An API-only runtime requires the organization HTTP API.');
    change(['dataverse', 'enabled'], apiEnabled, before.dataverse?.enabled ?? false);
    change(['dataverse', 'port'], Number(value('api-port')), before.dataverse?.port ?? 0);
    if (state.kind === 'project') projectRuntimeEdits(context, kind);
    return save({ operations: edits });
  },
  add({ value, set, edits }) {
    if (!identifier(value('id')) || state.sites.some(site => site.id === value('id'))) throw new Error('Choose a new, valid target name.');
    const kind = value('runtime-kind');
    set(['sites', value('id')], { ...(kind === 'power-pages' ? { source: value('source') || '.', defaultEnv: 'dev', environments: { dev: 'https://portal.example.test' } } : {}), mirage: { port: 0, runtime: { kind }, simulation: { level: 'dry-run' }, ...(kind === 'dataverse-api' ? { dataverse: { enabled: true } } : {}) } });
    return save({ operations: edits });
  },
  settings({ data, value, edits, set }) {
    // Only fields the user changed are written, so untouched keys keep their authored form (RU3-05).
    const settings = state.settings, browser = settings.browser ?? {}, flag = (name, path, previous) => { if (data.has(name) !== (previous === true)) set(path, data.has(name)); };
    update(edits, ['sourceRoot'], value('sourceRoot'), settings.sourceRoot);
    update(edits, ['defaultSite'], value('defaultSite') || undefined, settings.defaultSite || undefined);
    update(edits, ['browser', 'channel'], value('browser'), browser.channel);
    update(edits, ['portals'], value('portals'), settings.portals);
    for (const name of ['panel', 'liveReload']) flag(name, [name], settings[name]);
    flag('includeCaution', ['includeCaution'], settings.includeCaution);
    flag('headless', ['browser', 'headless'], browser.headless); flag('bypassCSP', ['browser', 'bypassCSP'], browser.bypassCSP);
    flag('agentEnabled', ['agent', 'enabled'], settings.agent?.enabled); flag('sourceMaps', ['sourceMaps'], settings.sourceMaps);
    for (const name of ['profileDir', 'profile', 'userDataDir', 'profileDirectory', 'cdpUrl']) update(edits, ['browser', name], value(name) || undefined, browser[name] ?? undefined);
    update(edits, ['browser', 'debugPort'], number(value('debugPort'), 'Remote debugging port'), browser.debugPort ?? undefined);
    update(edits, ['editor'], value('editor') || undefined, settings.editor ?? undefined);
    if (!edits.length) return notice('Nothing to save: no default changed.');
    return save({ operations: edits });
  },
  'project-site': ({ site, value, set, edits }) => { set(['portals', state.sites.indexOf(site), 'path'], value('source')); return save({ operations: edits }); },
  'standalone-site'({ id, site, value, edits, set }) {
    const prefix = ['sites', id, 'mirage'];
    const roots = value('solutions').split(/\r?\n/).map(text => text.trim()).filter(Boolean);
    if (JSON.stringify(roots) !== JSON.stringify(site.mirage.solutionRoots ?? state.settings.solutionRoots ?? [])) set([...prefix, 'solutionRoots'], roots);
    const port = value('port') === '' ? undefined : Number(value('port'));
    if (port !== site.mirage.port) port === undefined ? edits.push({ op: 'delete', path: [...prefix, 'port'] }) : set([...prefix, 'port'], port);
    const packs = packLines(value('site-packs'));
    const old = (site.mirage.dataPacks ?? []).map(item => typeof item === 'string' ? { id: 'pack', module: item } : item);
    if (JSON.stringify(packs) !== JSON.stringify(old)) set([...prefix, 'dataPacks'], packs);
    return save({ operations: edits });
  },
  site: context => save({ operations: siteEdits(context) }),
};
// Project-file runtime form: the first Power Pages portal, Solution folders (IDs kept for unchanged paths) and packs.
function projectRuntimeEdits({ value, set }, kind) {
  if (kind === 'power-pages' && !state.sites.length) {
    if (!identifier(value('portal-id')) || !value('portal-path')) throw new Error('Select a Power Pages target name and export path.');
    set(['portals'], [{ id: value('portal-id'), path: value('portal-path') }]); set(['defaultPortal'], value('portal-id'));
  }
  const paths = value('runtime-solutions').split(/\r?\n/).map(text => text.trim()).filter(Boolean);
  if (new Set(paths).size !== paths.length) throw new Error('Each Solution folder must be listed once.');
  const old = state.settings.solutions ?? [];
  if (JSON.stringify(paths) !== JSON.stringify(old.map(item => item.path))) {
    const matched = paths.map(path => old.find(item => item.path === path));
    const claimed = new Set(matched.filter(Boolean).map(item => item.id)), reserved = new Set(old.map(item => item.id)); let counter = 1;
    const solutions = paths.map((path, index) => {
      // Claim moved, unchanged paths first; a replacement can retain its
      // prior row ID only when another row has not already claimed it.
      const previous = matched[index] ?? (old[index] && !claimed.has(old[index].id) ? old[index] : null);
      if (previous) {
        claimed.add(previous.id);
        const original = state.settings.solutionEntries?.[old.indexOf(previous)], authored = original && typeof original === 'object' ? original : {};
        const key = Object.hasOwn(authored, 'path') ? 'path' : Object.hasOwn(authored, 'source') ? 'source' : Object.hasOwn(authored, 'root') ? 'root' : 'path';
        // Explicit IDs keep shorthand entries stable when reordered.
        return { ...authored, id: previous.id, [key]: path };
      }
      let id; do { id = `solution-${counter++}`; } while (reserved.has(id)); reserved.add(id); return { id, path };
    });
    set(['solutions'], solutions);
  }
  const packs = packLines(value('runtime-packs'));
  if (JSON.stringify(packs) !== JSON.stringify((state.settings.dataPacks ?? []).map(item => ({ id: item.id, module: item.module })))) set(['dataPacks'], packs.map(pack => {
    const index = (state.settings.dataPacks ?? []).findIndex(item => item.id === pack.id), original = state.settings.dataPackEntries?.[index];
    return original && typeof original === 'object' ? { ...original, module: pack.module } : pack;
  }));
}
// Catalogue Power Pages site form. Guided forms show effective defaults; only fields the user changed are written,
// so inherited values and scalar environment comments remain untouched.
function siteEdits({ form, id, site, value, edits, set }) {
  const prefix = ['sites', id];
  set([...prefix, 'source'], value('source'));
  if (value('defaultEnv')) set([...prefix, 'defaultEnv'], value('defaultEnv'));
  else edits.push({ op: 'delete', path: [...prefix, 'defaultEnv'] });
  set([...prefix, 'startPath'], value('startPath') || '/');
  set([...prefix, 'mirage', 'port'], value('port') === '' ? null : Number(value('port')));
  set([...prefix, 'mirage', 'solutionRoots'], value('solutions').split(/\r?\n/).map(text => text.trim()).filter(Boolean));
  set([...prefix, 'mirage', 'preset'], value('preset') || null);
  // Packs are compared as the lines shown, so string entries and unchanged lists are never rewritten.
  if (lines(value('site-packs')).join('\n') !== lines(packText(site.mirage.dataPacks)).join('\n')) set([...prefix, 'mirage', 'dataPacks'], packLines(value('site-packs')));
  else packLines(value('site-packs'));
  for (const name of ['presetMode', 'presetConfiguration']) value(name) ? set([...prefix, 'mirage', name], value(name)) : edits.push({ op: 'delete', path: [...prefix, 'mirage', name] });
  const environments = {};
  for (const row of form.querySelectorAll('.environment-editor')) {
    const name = row.querySelector('[name=env-id]').value.trim(), url = row.querySelector('[name=env-url]').value.trim();
    if (!identifier(name) || Object.hasOwn(environments, name)) throw new Error('Environment names must be valid and unique.');
    let origin; try { origin = new URL(url); } catch { throw new Error(`Enter a valid origin for ${name}.`); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Use HTTP(S) origins without credentials, paths or query tokens.');
    // Preserve baseline/scope and other environment-specific settings.
    const optional = selector => row.querySelector(selector)?.value.trim() || undefined;
    environments[name] = { ...site.environments[name], url: origin.origin, caution: row.querySelector('[name=env-caution]').checked,
      baseline: optional('[name=env-baseline]'), startPath: optional('[name=env-start]'), scope: optional('[name=env-scope]') };
  }
  if (value('defaultEnv') && !environments[value('defaultEnv')]) throw new Error('The default environment must name one of this portal’s environments.');
  for (const [name, setting] of Object.entries(environments)) {
    set([...prefix, 'environments', name, 'url'], setting.url);
    set([...prefix, 'environments', name, 'caution'], setting.caution);
    for (const key of ['baseline', 'startPath', 'scope']) setting[key] === undefined ? edits.push({ op: 'delete', path: [...prefix, 'environments', name, key] }) : set([...prefix, 'environments', name, key], setting[key]);
  }
  for (const name of Object.keys(site.environments)) if (!Object.hasOwn(environments, name)) edits.push({ op: 'delete', path: [...prefix, 'environments', name] });
  set([...prefix, 'scope'], value('scope'));
  // Route YAML is passed through the document editor's validator via a string operation.
  edits.push({ op: 'set', path: [...prefix, 'routes'], yaml: value('routes') || '[]' });
  return edits.filter(edit => {
    const path = edit.path.slice(2);
    let previous = path.reduce((current, key) => current?.[key], site);
    if (path.join('.') === 'startPath') previous ??= '/';
    if (path.join('.') === 'scope') previous ??= 'all';
    if (path[0] === 'environments' && path[2] === 'caution') previous = Boolean(previous);
    if (path.join('.') === 'routes') previous ??= [];
    // An absent solutionRoots and an empty list are the same; neither writes `solutionRoots: []` (RU3-16).
    if (path.join('.') === 'mirage.solutionRoots') previous ??= [];
    if (edit.yaml !== undefined) return edit.yaml !== JSON.stringify(previous, null, 2);
    if (edit.op === 'delete') return previous !== undefined;
    return JSON.stringify(previous ?? null) !== JSON.stringify(edit.value);
  });
}
$('#content').addEventListener('submit', async event => {
  event.preventDefault();
  if (pending) return;
  const form = event.target, data = new FormData(form), value = name => String(data.get(name) ?? '').trim();
  if (form.id === 'dashboard-preflight') { preflightInput.requires = form.elements.requires.value; preflightInput.strict = form.elements.strict.checked; return runPreflight(); }
  const id = form.dataset.site, edits = [];
  const context = { form, data, value, id, site: state.sites.find(item => item.id === id), edits, set: (path, next) => edits.push(operation(path, next)) };
  try { await SUBMIT[form.dataset.form]?.(context); }
  catch (error) { notice(error.message, true); }
});
$('#refresh').addEventListener('click', () => { if (!dirty || confirm('Discard unsaved form changes and reload status?')) load(); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
load();
