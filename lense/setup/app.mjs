import * as kit from './ui-kit.mjs';
import { renderDashboard, renderNodeDetail } from './dashboard-map.mjs';
import * as icons from './dashboard-icons.mjs';
import { HELP } from './help-content.mjs';

const $ = selector => document.querySelector(selector);
const esc = kit.escapeHtml;
let state, layer = 'shared', yamlLayer = null, dirty = false, pending = false, pendingFocus, firstRender = true;
// Same-origin runtime facts (D19) and the live dashboard feed (D6, D21); both degrade to configuration-only views.
let runtimeInfo = {}, dashboard = null, dashboardError = '', previousActivity, nodeId = null, preflight = null;
const activityHistory = []; // earlier live activity snapshots, oldest first (sparklines)
const preflightInput = { requires: '', strict: false };
const pagers = {}, uiOpen = new Map(), specs = new Map();
let newRows = 0, nextSection = null;
const extraAttributes = (extra, hint) => `${extra.id ? ` id="${esc(extra.id)}"${hint ? ` aria-describedby="${esc(extra.id)}-help"` : ''}` : ''}${extra.placeholder !== undefined && extra.placeholder !== null && extra.placeholder !== '' ? ` placeholder="${esc(extra.placeholder)}"` : ''}${extra.list ? ` list="${esc(extra.list)}"` : ''}`;
const field = (label, name, value, hint = '', type = 'text', extra = {}) => `<div><label${extra.id ? ` for="${esc(extra.id)}"` : ''}>${esc(label)}${hint ? `<small class="field-help"${extra.id ? ` id="${esc(extra.id)}-help"` : ''}>${esc(hint)}</small>` : ''}<input name="${esc(name)}" type="${type}" value="${esc(value)}"${extraAttributes(extra, hint)}></label></div>`;
const area = (label, name, value, hint, id, className = '') => `<div><label for="${esc(id)}">${esc(label)}<small class="field-help" id="${esc(id)}-help">${esc(hint)}</small><textarea id="${esc(id)}" name="${esc(name)}" aria-describedby="${esc(id)}-help"${className ? ` class="${className}"` : ''} spellcheck="false">${esc(value)}</textarea></label></div>`;
const check = (label, name, checked, id, hint = '') => `<div><label class="checkbox-line" for="${esc(id)}"><input id="${esc(id)}" name="${esc(name)}" type="checkbox" ${checked ? 'checked' : ''}${hint ? ` aria-describedby="${esc(id)}-help"` : ''}>${esc(label)}</label>${hint ? `<p class="field-help" id="${esc(id)}-help">${esc(hint)}</p>` : ''}</div>`;
// One option builder: [value, text] pairs; the selected option compares as text.
const optionList = (pairs, chosen) => pairs.map(([value, text]) => `<option value="${esc(value)}" ${String(value) === String(chosen ?? '') ? 'selected' : ''}>${esc(text)}</option>`).join('');
const choice = (label, name, values, chosen, id = '', hint = '') => `<div><label${id ? ` for="${esc(id)}"` : ''}>${esc(label)}${hint ? `<small class="field-help"${id ? ` id="${esc(id)}-help"` : ''}>${esc(hint)}</small>` : ''}<select${id ? ` id="${esc(id)}"` : ''} name="${esc(name)}"${hint && id ? ` aria-describedby="${esc(id)}-help"` : ''}>${optionList(values, chosen)}</select></label></div>`;
const slug = text => String(text ?? '').replace(/[^a-zA-Z0-9-]+/g, '-');
const lines = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const identifier = text => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(text) && !/^(?:constructor|prototype|__proto__)$/i.test(text);
const helpText = key => HELP[key]?.intro ?? '';
const catalogueDoc = key => state.settingsCatalogue?.find(item => item.key === key)?.doc ?? '';
const fileName = file => String(file ?? '').split(/[\\/]/).pop();
const adminUrl = () => state.runtime?.links?.administration ?? '/_sim/';
// Setup and /_sim/ share an origin only when Mirage mounts this page itself (no separate portal URL, relative administration link).
const liveRuntime = () => Boolean(state?.runtime?.product === 'Mirage' && !state.runtime.portalUrl && String(adminUrl()).startsWith('/'));
const packText = list => (list ?? []).map(item => typeof item === 'string' ? `pack | ${item}` : `${item.id} | ${item.module}`).join('\n');
function packLines(text) {
  const packs = lines(text).map(line => { const [id, ...parts] = line.split('|'); const module = parts.join('|').trim(); if (!identifier(id.trim()) || !module) throw new Error('Use id | module path for each trusted pack.'); return { id: id.trim(), module }; });
  if (new Set(packs.map(item => item.id)).size !== packs.length) throw new Error('Pack IDs must be unique.');
  return packs;
}
/** Push a set/delete edit when the next value differs from the previous one (undefined deletes). */
const update = (edits, path, next, previous) => { if (JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null)) edits.push(next === undefined ? { op: 'delete', path } : { op: 'set', path, value: next }); };
const number = (text, label) => { if (text === '') return undefined; const value = Number(text); if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`); return value; };
function guideFor(stage) {
  const entry = HELP[`setup.${stage}`];
  return entry ? kit.guide({ key: `setup-${stage}`, intro: entry.intro, steps: entry.steps ?? [], example: entry.example, docs: entry.doc ? [kit.docLink(entry.doc, state.docs)] : [] }) : '';
}
const SIMULATION_LEVELS = { 'local-state': 'Local state (existing compatibility)', 'dry-run': 'Dry run · memory edits', simulation: 'Simulation · pack DATA writes', deep: 'Deep simulation · DATA and schema' };
const optionText = (name, value) => (name === 'runtime-kind' ? runtimeName(value) : name === 'simulation-level' ? SIMULATION_LEVELS[value] ?? value : value);
const select = (label, name, values, chosen) => choice(label, name, values.map(value => [value, optionText(name, value)]), chosen);
const source = site => `<div class="notice"><strong>${site.sourceStatus.format ? `${esc(site.sourceStatus.layout?.dialect ?? site.sourceStatus.format)} export` : site.sourceStatus.exists ? 'Folder needs an export' : 'Source folder missing'}</strong><p class="code-text source-path">${esc(site.sourceStatus.path || 'No source selected')}</p><span class="ui-badge ui-tone-neutral">${site.sourceStatus.git ? `${esc(site.sourceStatus.git.branch)} · ${esc(site.sourceStatus.git.commit)}${site.sourceStatus.git.changed ? ' · tracked changes in this folder' : ''}` : ''}${site.sourceStatus.gitState === 'timeout' ? ' · Git status unavailable (timeout)' : site.sourceStatus.gitState === 'unavailable' ? ' · Git status unavailable' : !site.sourceStatus.git ? 'No committed Git checkout' : ''}</span></div>`;
function notice(message, error = false) {
  const node = $('#notice'); node.hidden = false; node.className = `activity-feedback ${error ? 'error' : 'done'}`;
  node.setAttribute('role', error ? 'alert' : 'status'); node.textContent = message;
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
    state = await request('/_setup/api/status'); await loadRuntimeInfo(); dirty = false; renderPreservingContext(); notice('Project configuration is up to date.');
    if (firstRender) { firstRender = false; if (location.hash) reveal(decodeURIComponent(location.hash.slice(1)), true); }
  }
  catch (error) { notice(error.message, true); }
  finally { finish(); }
  pollDashboard();
}
// Runtime lists for datalists and pack badges (D19): only from the runtime serving this page; any failure leaves free text.
// ponytail: read once per status load (Refresh status rereads); poll them with the dashboard if presets or packs change while the page stays open.
async function loadRuntimeInfo() {
  if (!liveRuntime()) { runtimeInfo = {}; return; }
  const get = url => fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) }).then(response => (response.ok ? response.json() : null)).catch(() => null);
  const [status, packs] = await Promise.all([get('/_sim/api/status'), get('/_sim/api/packs')]);
  runtimeInfo = { status, packs };
}
// The save notice follows the restart comparison: required, already matching, or unknown (RU3-14, RU3-02).
function savedNotice(runtime) {
  if (!runtime) return 'Saved. Your next preview will use these settings.';
  if (runtime.restartRequired === true) return `Saved. Restart the preview to apply configuration changes: ${runtime.restartCommand}`;
  if (runtime.restartRequired === false) return 'Saved. The running preview already matches this configuration.';
  return `Saved. The configuration could not be compared with the running preview (${runtime.restartReason}); restart it to be sure: ${runtime.restartCommand}`;
}
async function save(payload) {
  if (pending) return;
  const finish = beginOperation('Validating and saving configuration…');
  try {
    state = await request('/_setup/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': state.csrf }, body: JSON.stringify({ layer, ...payload, revision: state.revision }) });
    dirty = false; renderPreservingContext(); notice(savedNotice(state.runtime));
  } catch (error) { notice(error.message, true); }
  finally { finish(); }
}
function reveal(id, scroll = false) {
  const target = id && document.getElementById(id);
  if (!target) return;
  for (let node = target.closest('details'); node; node = node.parentElement?.closest('details')) node.open = true;
  if (scroll) target.scrollIntoView({ block: 'start' });
}
const operation = (path, value) => ({ op: 'set', path, value });
const runtimeName = kind => ({ 'power-pages': 'Power Pages + model-driven apps', 'model-driven': 'Model-driven apps', 'dataverse-api': 'Dataverse API only' })[kind] ?? kind;
function runtimeEditor(settings, site) {
  const runtime = settings.runtime ?? { kind: 'power-pages' }, simulation = settings.simulation, key = site ? slug(site.id) : 'project';
  // Catalogue sites show effective values; keys that only defaults.mirage sets are named, so a site value is a deliberate override (RB-09).
  const inherited = name => (site?.inherited?.[name] ? `<p class="muted">Inherited from defaults.mirage. Saving a different value here sets this target's own ${esc(name)}.</p>` : '');
  const apps = runtimeApps();
  return `<form class="form-grid" data-form="runtime" id="runtime-${key}" ${site ? `data-site="${esc(site.id)}"` : ''}>
    <div class="inline-fields">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], runtime.kind)}<div data-app-choice ${runtime.kind === 'dataverse-api' ? 'hidden' : ''}>${field('Default application GUID', 'defaultApp', runtime.defaultApp ?? '', `Optional imported app. Leave empty for the available default.${apps.length ? ' Suggestions come from the running preview.' : ''}`, 'text', { id: `runtime-${key}-app`, list: apps.length ? 'app-options' : '' })}</div></div>${inherited('runtime')}
    ${select('Simulation level', 'simulation-level', ['local-state', 'dry-run', 'simulation', 'deep'], simulation?.level ?? 'local-state')}${inherited('simulation')}
    <label class="checkbox-line"><input name="trusted-extensions" type="checkbox" ${settings.modelDriven?.trustedExtensions ? 'checked' : ''}>Run trusted Solution JavaScript, form events, command actions and standard field PCF controls</label><p class="muted">Enable only for project code you trust. Extensions run in the local app with your selected staff permissions. Unsupported APIs and controls report a limitation. Restart after changing trust.</p>
    ${area('Model-driven client sources', 'client-sources', (settings.modelDriven?.clientSources ?? []).join('\n'), 'Optional: one local folder of unpacked client resources per line (modelDriven.clientSources). Resolved paths are shown; unchanged lines are not rewritten.', `runtime-${key}-client-sources`)}
    <div class="muted"><p><strong>Dry run:</strong> edit records in memory; no runtime state or pack writes. <strong>Simulation:</strong> update existing pack DATA files. <strong>Deep:</strong> also allow schema changes in declared DATA/schema destinations.</p><p>Local-state keeps existing ignored-state behavior for older configurations. Pack file ownership is declared by trusted pack modules; setup does not execute them. Changes apply after restart and do not flush in-memory edits.</p></div>
    <div class="inline-fields"><label class="checkbox-line"><input name="api-enabled" type="checkbox" ${settings.dataverse?.enabled || runtime.kind === 'dataverse-api' ? 'checked' : ''}>Enable organization HTTP API</label>${field('API port', 'api-port', settings.dataverse?.port ?? 0, '0 chooses a free port.', 'number')}</div>
    ${state.kind === 'project' ? `${!state.sites.length ? `<div class="inline-fields" data-portal-source ${runtime.kind === 'power-pages' ? '' : 'hidden'}>${field('Power Pages target name', 'portal-id', 'portal', 'Used only when selecting Power Pages.')}${field('Power Pages export path', 'portal-path', '', 'Add an existing export to switch this standalone project to Power Pages.')}</div>` : '<p class="muted">Existing portal selections are retained when using a standalone profile and become active again when switching back to Power Pages.</p>'}<div><label>Solution exports<small class="field-help">One existing local folder per line, relative to this project file. Existing Solution IDs are retained for unchanged paths.</small><textarea name="runtime-solutions">${esc((state.settings.solutions ?? []).map(item => item.path).join('\n'))}</textarea></label></div><div><label>Trusted data packs<small class="field-help">One id | module path per line. Register modules explicitly; exports and DATA files remain in your project.</small><textarea name="runtime-packs">${esc((state.settings.dataPacks ?? []).map(item => `${item.id} | ${item.module}`).join('\n'))}</textarea></label></div>` : ''}
    <p class="muted">After starting Mirage, use Administration → Organization identity &amp; API for staff users, app registrations, local secrets, certificates and federation. Portal visitor personas are separate from organization staff and API application identities. TLS, tenant and registrations are under <a href="#identity">Identity &amp; API</a>.</p><div class="toolbar"><button type="submit" class="button primary">Save runtime configuration</button><span class="muted">Restart required for running previews.</span></div></form>`;
}
function envRow(id = '', settings = {}, siteId = '') {
  return `<div class="environment-editor"><div class="inline-fields">${field('Environment name', 'env-id', id)}${field('Portal origin', 'env-url', settings.url ?? '', 'HTTP(S) origin only; no sign-in links or query tokens.')}</div><div class="row"><label class="checkbox-line"><input name="env-caution" type="checkbox" ${settings.caution ? 'checked' : ''}>Real data · caution</label><button class="button" type="button" data-remove-env>Remove</button></div>
    <details class="disclosure" ${id && siteId ? `data-section-key="env-${esc(siteId)}-${esc(id)}"` : ''}><summary>Baseline, scope and start page</summary><div class="inline-fields">${field('Baseline', 'env-baseline', settings.baseline ?? '', 'Optional Git ref compared for changed-only overlays.')}${field('Start page', 'env-start', settings.startPath ?? '', 'Optional first page for this environment.')}</div>${choice('Source scope', 'env-scope', [['', 'Site default'], ['all', 'all'], ['changed', 'changed']], settings.scope ?? '', `env-${slug(siteId)}-${slug(id) || `new-${++newRows}`}-scope`)}</details></div>`;
}
function siteEditor(site) {
  if (state.kind === 'project') return `<form class="form-grid" data-form="project-site" data-site="${esc(site.id)}">${field('Portal export path', 'source', site.source, 'Relative to this Mirage project file.')}<div class="toolbar"><button type="submit" class="button primary">Save source</button></div></form>`;
  if (site.runtime?.kind && site.runtime.kind !== 'power-pages') return `<form class="form-grid" data-form="standalone-site" data-site="${esc(site.id)}">${field('Mirage port', 'port', site.mirage.port ?? '', '0 chooses a free port.', 'number')}<div><label>Solution export folders<small class="field-help">One existing local path per line, relative to the source root. This target needs no portal export or environment URL.</small><textarea name="solutions">${esc((site.mirage.solutionRoots ?? state.settings.solutionRoots ?? []).join('\n'))}</textarea></label></div><div><label>Trusted data packs<small class="field-help">One id | module path per line. Modules are not executed by setup.</small><textarea name="site-packs">${esc((site.mirage.dataPacks ?? []).map(item => typeof item === 'string' ? `pack | ${item}` : `${item.id} | ${item.module}`).join('\n'))}</textarea></label></div><div class="toolbar"><button type="submit" class="button primary">Save sources</button></div></form>`;
  const key = slug(site.id), presets = runtimePresets();
  return `<form class="form-grid" data-form="site" data-site="${esc(site.id)}" id="site-${key}"><div class="inline-fields">${field('Portal export folder', 'source', site.source, 'Relative to the source root; absolute paths also work.')}${field('Default environment', 'defaultEnv', site.defaultEnv)}</div>
    <div class="inline-fields">${field('Mirage port', 'port', site.mirage.port ?? '', '0 chooses a free port.', 'number')}${field('Start page', 'startPath', site.startPath ?? '/')}</div>
    <div><label>Solution export folders<small class="field-help">One path per line, relative to the source root. Leave empty when this portal needs none.</small><textarea name="solutions">${esc((site.mirage.solutionRoots ?? []).join('\n'))}</textarea></label></div>
    ${area('Trusted data packs', 'site-packs', packText(site.mirage.dataPacks), `One id | module path per line. ${helpText('setup.packs.module')} Setup checks that the file exists and never runs it.`, `site-${key}-packs`)}
    <div class="inline-fields">${field('Startup data preset', 'preset', site.mirage.preset ?? '', `Optional data preset ID from a trusted pack, seeded at startup.${presets.length ? ' Suggestions come from the running preview.' : ''}`, 'text', { id: `site-${key}-preset`, list: presets.length ? 'preset-options' : '' })}${choice('Startup preset mode', 'presetMode', [['', 'Not set'], ['bootstrap', 'bootstrap · keep an existing state'], ['always', 'always · reapply at every start']], site.mirage.presetMode, `site-${key}-preset-mode`)}</div>
    ${choice('Preset configuration', 'presetConfiguration', [['', 'Not set'], ['data-only', 'data-only'], ['apply', 'apply · also apply its linked configuration']], site.mirage.presetConfiguration, `site-${key}-preset-configuration`, helpText('setup.packs.preset'))}
    <h3>Environments</h3><div data-environments>${Object.entries(site.environments).map(([id, settings]) => envRow(id, settings, site.id)).join('')}</div><button type="button" class="button" data-add-env>Add environment</button>
    <details class="disclosure" data-section-key="preview-${esc(site.id)}"><summary>Preview rules</summary>${select('Source scope', 'scope', ['all', 'changed'], site.scope ?? 'all')}<div><label>Route rules (YAML)<small class="field-help">Explicit file, directory or passthrough mappings. Other inline/markup settings are in Configuration below.</small><textarea name="routes" class="ui-mono">${esc(JSON.stringify(site.routes ?? [], null, 2))}</textarea></label></div></details>
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
  for (const item of [...(runtimeInfo.status?.presets ?? runtimeInfo.status?.availablePresets ?? []), ...(runtimeInfo.packs?.library ?? [])]) if (item?.id && !found.has(item.id)) found.set(item.id, item.name ?? item.id);
  return [...found];
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

function stage(id, opened, { eyebrow = '', title, intro = '', badge, body }) {
  const stages = (state.stages ?? []).filter(item => sectionOf(item) === id);
  const status = STATUS_ORDER.find(name => stages.some(item => item.status === name));
  const mark = badge ?? (status ? kit.badge(...STAGE_STATUS[status]) : '');
  return `<details id="${id}" class="stage panel section-gap" data-section-key="${id}"${opened.has(id) ? ' open' : ''}><summary><div class="panel-heading"><div>${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ''}<h2>${esc(title)}</h2>${intro ? `<p>${esc(intro)}</p>` : ''}</div>${mark}</div></summary><div class="stage-body">${body}</div></details>`;
}
// The stage rail uses the sidebar items of /_sim/: the step number in the icon slot, the next step marked active.
const railHtml = () => (state.stages ?? []).map(item => {
  const [text, tone] = STAGE_STATUS[item.status] ?? [item.status, 'neutral'];
  return `<a class="nav-item is-${esc(item.status)}${item.status === 'next' ? ' active" aria-current="step' : ''}" href="#${esc(sectionOf(item))}"><span class="nav-icon rail-step" aria-hidden="true">${esc(item.id)}</span><span class="rail-title">${esc(item.title)}</span>${kit.badge(text, tone)}</a>`;
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
  return `<code class="setting-key">${esc(item.key)}</code>${target.site ? ` <span class="muted">· ${esc(target.site.id)}</span>` : ''}`
    + `<div class="setting-badges">${kit.badge(scope, String(target.layer).startsWith('project:') ? 'info' : 'neutral')}${item.pending ? ` ${kit.badge('parser pending', 'warn')}` : ''}${item.redact ? ` ${kit.badge('references only', 'warn')}` : ''}</div>`
    + `<p class="field-help" id="${esc(id)}-help">${esc(item.doc)}</p>`
    + (item.pending ? '<p class="muted">Accepted by shape only: the module that owns this key has not registered its parser in this build.</p>' : '')
    + (item.redact ? `<p class="muted">${esc(item.redactHelp ?? 'References only: validation refuses literal secret values; never paste one here.')}</p>` : '')
    + (target.inherited !== undefined ? '<p class="muted">Inherited from defaults.mirage (shown as the placeholder); saving sets this target\'s own value.</p>' : '')
    + (item.contract ? kit.help({ text: 'Contract:', doc: kit.docLink(item.contract, state.docs) }) : '')
    + (item.example ? `<details class="disclosure example" data-section-key="example-${esc(id)}"><summary>Example</summary><pre class="ui-example">${esc(item.example)}</pre></details>` : '');
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
    + (['list', 'object'].includes(item.kind) ? `<p class="muted">YAML for the value only, without the key line; the current value is shown${target.file ? ` from ${esc(fileName(target.file))}` : ''}. Saving replaces the whole key and drops comments inside it; empty removes the key.</p>` : '')
    + `<div class="toolbar"><button type="submit" class="button">Save setting ${esc(item.key)}</button></div></form>`;
}
const SETTING_COLUMNS = [{ label: 'Setting', render: settingInfo }, { label: 'Value', render: settingControl }];
function settingEditor(sectionId) {
  if (!state.layers.shared.exists) return '';
  return (state.stages ?? []).filter(item => editorSection(item) === sectionId).map(({ id, title }) => {
    const rows = (state.settingsCatalogue ?? []).filter(item => item.stage === id && !dedicated(item)).flatMap(item => settingTargets(item).map(target => ({ item, target })));
    if (!rows.length) return '';
    return kit.section({ key: `settings-stage-${id}`, title: `Setting editor · ${title}`, summary: `${rows.length} setting${rows.length === 1 ? '' : 's'} without a dedicated form`,
      help: { text: `The other keys of this stage. Each row saves to the layer in its badge: ${state.kind === 'project' ? 'the project file' : `the ${layer} catalogue, or project:<target> for a linked Mirage project file`}. Lists and mappings are YAML snippets validated on save.`, doc: kit.docLink('docs/configuration.md', state.docs) },
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
const isLive = () => Boolean(dashboard && liveRuntime());
const currentPayload = () => (isLive() ? dashboard : plannedPayload());
function systemBody() {
  const stages = state.stages ?? [], next = stages.find(item => item.status === 'next');
  const readiness = kit.tiles([
    { label: 'Stages done', value: `${stages.filter(item => item.status === 'done').length} of ${stages.length}`, detail: 'from the rail', tone: 'ok' },
    { label: 'Next step', value: next ? next.title : 'None', detail: next ? `stage ${next.id}` : 'every required stage is done', tone: next ? 'info' : 'ok' },
    { label: 'Findings', value: String(state.findings.length), detail: state.findings.length ? 'listed in Overview' : 'configuration ready', tone: state.findings.length ? 'warn' : 'ok' },
  ]);
  const source = isLive() ? kit.notice(`Live from the running preview: refreshed ${new Date().toLocaleTimeString()}, every 5 seconds while this tab is visible and this section is open.`, 'ok')
    : liveRuntime() ? kit.notice(dashboardError ? `Live status is unavailable (${dashboardError}); showing the plan from configuration.` : 'Connecting to the running preview; showing the plan from configuration meanwhile.', 'neutral') : '';
  return readiness + source + renderDashboard(currentPayload(), { mode: isLive() ? 'live' : 'planned', docs: state.docs, previousActivity: isLive() ? previousActivity : undefined, history: isLive() ? activityHistory : [], help: HELP, kit, icons, pager: pagers['dashboard-activity'] ??= {} });
}
function nodeDetail(node) {
  const html = renderNodeDetail(node, state.docs, { kit, icons, payload: currentPayload() });
  // Node links name /_sim/ views: open them in Administration when it serves this origin; planned nodes have no view to open.
  return isLive() ? html.replace(/href="#/, `href="${esc(adminUrl())}#`) : html.replace(/<p class="ui-drawer-actions">[\s\S]*?<\/p>/, '');
}
function afterSystem() {
  const slot = $('#dashboard-node-detail'), node = nodeId && (currentPayload().nodes ?? []).find(item => item.id === nodeId);
  if (slot) slot.innerHTML = node ? nodeDetail(node) : '';
  const requires = $('#dashboard-preflight-requires'), strict = $('#dashboard-preflight-strict'), result = $('#dashboard-preflight-result');
  if (requires) requires.value = preflightInput.requires;
  if (strict) strict.checked = preflightInput.strict;
  if (result) result.innerHTML = preflightView();
}
function refreshSystem(force = false) {
  const body = $('#system-body');
  // A poll never replaces controls the user is working in; the next poll catches up.
  // ponytail: whole-section re-render per poll; patch node statuses and tiles in place if the map grows past a few hundred nodes.
  if (!body || (!force && body.contains(document.activeElement))) return;
  body.innerHTML = systemBody(); applyUiOpen(body); afterSystem();
  const badge = $('#system > summary .ui-badge'); if (badge) badge.outerHTML = isLive() ? kit.badge('live', 'ok') : kit.badge('planned', 'info');
}
// One poll at a time, so responses never resolve out of order and previousActivity pairs consecutive feeds.
let polling = false;
async function pollDashboard() {
  if (polling || !state || !liveRuntime() || pending || document.visibilityState !== 'visible' || !$('#system')?.open) return;
  polling = true;
  try {
    const response = await fetch('/_sim/api/dashboard', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const next = await response.json();
    previousActivity = dashboard?.activity; if (previousActivity) { activityHistory.push(previousActivity); if (activityHistory.length > 12) activityHistory.shift(); } dashboard = next; dashboardError = '';
  } catch (error) { dashboardError = error.message; }
  finally { polling = false; }
  refreshSystem();
}
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
  return kit.tiles([{ label: 'Requirements', value: String(summary.total ?? rows.length), tone: 'info' }, { label: 'Satisfied', value: String(summary.satisfied ?? 0), tone: 'ok' }, { label: 'Blocking', value: String(summary.blocking ?? 0), tone: summary.blocking ? 'bad' : 'ok' }])
    + list('preflight', rows, [
      { label: 'Requirement', render: row => `<code>${esc(row.id)}</code>` },
      { label: 'Kind', render: row => esc(row.kind) },
      { label: 'Status', render: row => `${kit.badge(row.status, row.status === 'satisfied' ? 'ok' : row.blocking ? 'bad' : 'warn')}${row.blocking ? ` ${kit.badge('blocking', 'bad')}` : ''}` },
      { label: 'Detail', render: row => esc(row.message ?? '') },
    ], { caption: 'Preflight requirements', emptyText: 'No requirement is in scope.', text: row => `${row.id} ${row.kind} ${row.status} ${row.message ?? ''}` });
}
async function runPreflight() {
  const query = new URLSearchParams();
  for (const id of preflightInput.requires.split(/\s+/).filter(Boolean)) query.append('requires', id);
  if (preflightInput.strict) query.set('strict', 'true');
  notice('Running preflight on the running preview…');
  try {
    const response = await fetch(`/_sim/api/preflight${query.size ? `?${query}` : ''}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
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
  true: ['Configuration has changed. Restart the preview to apply it; the running sources, browser destination and state stay as started.', 'Stop the running preview, then start it again with:'],
  false: ['The running preview matches this configuration. Saves apply on your next preview start.', 'After further saves, stop the preview and start it again with:'],
  null: ['The configuration could not be compared with the running preview, so a restart may be needed. Restart it to be sure the saved configuration applies.', 'Stop the running preview, then start it again with:'],
};
function runtimeBanner(runtime) {
  const known = typeof runtime.restartRequired === 'boolean' ? runtime.restartRequired : null, [status, lead] = RESTART_TEXT[known];
  return `<div class="notice${known === false ? '' : ' warning'}"><strong>${esc(runtime.product)} preview running${runtime.site ? ` · ${esc(runtime.site)}` : ''}</strong><p>${esc(status)}</p>`
    + (known === null && runtime.restartReason ? `<p class="muted">Reason: ${esc(runtime.restartReason)}</p>` : '')
    + (runtime.restartScope ? `<p class="muted">The comparison covers ${esc(runtime.restartScope)}.</p>` : '')
    + (runtime.restartCommand ? `<p class="muted">${esc(lead)}</p><div class="command"><code id="restart-command">${esc(runtime.restartCommand)}</code><button type="button" class="button" data-copy="restart-command">Copy command</button></div><p class="muted">${esc(helpText('setup.start.restart'))}</p>` : '')
    + `${runtime.sourceDir ? `<p class="code-text source-path">Running source: ${esc(runtime.sourceDir)}</p>` : ''}</div>`;
}
function createFlow() {
  const project = state.kind === 'project', templates = state.templates ?? [];
  const kind = project ? 'This page edits a standalone Mirage project file (paqvilo setup --project): one runtime with a portal export or Solution exports, optional trusted packs and providers.'
    : 'This page edits a shared catalogue (paqvilo.config.yml): targets (Power Pages portals, model-driven or API-only runtimes), their environments and shared defaults, with a personal layer for local overrides.';
  return `<div class="notice"><strong>Start from an example setup</strong><p>${esc(kind)} To explore the shipped example project instead, run <code>npx paqvilo mirage demo</code>. Run <code>npx paqvilo init</code> first if you also want project scripts, tests and agent instructions.</p></div>`
    + (templates.length ? `<form class="form-grid" data-form="template" id="form-template"><fieldset class="templates"><legend>Example setups</legend>${templates.map((item, index) => `<label class="template" for="template-${esc(item.id)}"><span class="template-head"><input type="radio" id="template-${esc(item.id)}" name="template" value="${esc(item.id)}" ${index === 0 ? 'checked' : ''}><strong>${esc(item.title)}</strong></span>`
      + `<span class="template-text">${esc(item.description)}</span><span class="template-badges">${(item.surfaces ?? []).map(surface => kit.badge(runtimeName(surface), 'info')).join(' ')}</span>`
      + `<span class="template-text">Expected next steps, not errors: ${esc((item.expectedFindings ?? []).map(code => FINDING_STEPS[code] ?? code).join('; ') || 'none')}.</span>`
      + `<span class="template-steps">${(item.nextSteps ?? []).map(step => `<span>${esc(step)}</span>`).join('')}</span></label>`).join('')}</fieldset>`
      + `<div class="inline-fields">${field('Target name', 'id', 'invented-portal', 'Letters, numbers and hyphens.', 'text', { id: 'template-target' })}${field('Source folder', 'root', '', 'Optional portal export or Solution folder, relative to the configuration file. Empty uses the template example path.', 'text', { id: 'template-root' })}</div>`
      + '<div class="toolbar"><button type="submit" class="button primary">Create from template</button></div></form>' : '')
    + `<h3>Start empty</h3><p class="muted">Write a minimal ${project ? 'project file' : 'catalogue'} for one runtime surface and complete the stages one by one.</p>`
    + `<form class="form-grid" data-form="create">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], 'power-pages')}<div class="inline-fields">${field('Target name', 'id', 'portal')}${field('Source root', 'root', './sources', 'Folder holding local exports; a portal is required only for Power Pages.')}</div><button type="submit" class="button primary">Create ${project ? 'Mirage project' : 'catalogue'}</button></form>`;
}
function overviewBody() {
  const expected = new Set((state.templates ?? []).flatMap(item => item.expectedFindings ?? []));
  const anchor = section => (/^#[a-z0-9-]+$/i.test(section ?? '') ? section : '#overview');
  return guideFor('project') + (state.runtime ? runtimeBanner(state.runtime) : '') + (!state.layers.shared.exists ? createFlow() : '')
    + (state.findings.some(item => expected.has(item.code)) ? kit.notice('Findings marked “next step” are expected after creating from a template or scaffold: they name the folders and origins you still choose. They are not errors.', 'info') : '')
    // A linked-project finding opens its document in the YAML editor (RU3-15).
    + `<ul class="detail-list findings">${state.findings.map(item => `<li class="row"><span>${item.site ? `<strong>${esc(item.site)}</strong> · ` : ''}${esc(item.message)} ${expected.has(item.code) ? kit.badge('next step', 'info') : kit.badge('needs attention', 'warn')}</span><a href="${esc(anchor(item.section))}"${item.layer && state.layers[item.layer] ? ` data-yaml-layer="${esc(item.layer)}"` : ''}>Review</a></li>`).join('')}</ul>`
    + '<p class="muted">Readiness checks local configuration and folders. It does not prove browser coverage or a deployed commit.</p>';
}
function layerBody(personal) {
  const linked = Object.entries(state.layers).filter(([key]) => key.startsWith('project:'));
  return `${personal ? `<select id="layer" aria-label="Configuration layer">${optionList([['shared', 'shared'], ['personal', 'personal']], layer)}</select>` : kit.badge('Shared project')}<p class="code-text source-path">${esc(state.layers[layer].file)}</p>`
    + (layer === 'personal' ? '<p class="muted">Personal overrides merge with shared settings. Removing an override reveals its shared value. Ignore paqvilo.config.local.yml in Git before using personal settings.</p>' : '')
    + (state.kind === 'project' ? '<p class="muted">A standalone project file has no personal layer: every guided form writes the project file.</p>' : '')
    + (HELP['setup.project.layers'] ? kit.help({ text: helpText('setup.project.layers'), doc: kit.docLink(HELP['setup.project.layers'].doc, state.docs) }) : '')
    + (linked.length ? `<h3>Linked Mirage project files</h3><p class="muted">Project-only keys of a target live in its sites.&lt;id&gt;.mirage.project file. Rows of the setting editor marked project:&lt;target&gt; save there.</p>${list('linked-projects', linked.map(([key, item]) => ({ key, ...item })), [{ label: 'Layer', render: item => `<code>${esc(item.key)}</code>` }, { label: 'File', render: item => `<span class="code-text source-path">${esc(item.file)}</span>` }, { label: 'Status', render: item => kit.badge(item.exists ? 'found' : 'missing', item.exists ? 'ok' : 'warn') }], { caption: 'Linked project files' })}` : '');
}
function runtimeBody() {
  const editors = state.kind === 'project' ? runtimeEditor(state.settings)
    : state.sites.map(site => `<details class="disclosure" data-section-key="runtime-${esc(site.id)}"><summary>${esc(site.id)} · ${esc(runtimeName(site.runtime?.kind ?? 'power-pages'))}</summary>${runtimeEditor(site.effectiveMirage ?? site.mirage, site)}</details>`).join('');
  const solutions = state.solutions ?? [];
  return guideFor('runtime') + editors
    + (solutions.length ? `<h3>Solution folders</h3>${list('solutions', solutions, [{ label: 'Folder', render: item => `<span class="code-text source-path">${esc(item.path)}</span>` }, { label: 'Status', render: item => kit.badge(item.exists ? 'found' : 'missing', item.exists ? 'ok' : 'bad') }], { caption: 'Solution export folders' })}` : '')
    + settingEditor('runtime-configuration');
}
function portalsBody() {
  const cards = state.sites.map(site => `<section class="panel" id="portal-${esc(site.id)}"><div class="panel-heading"><h3>${esc(site.id)}</h3>${kit.badge(runtimeName(site.runtime?.kind ?? 'power-pages'), site.runtime?.kind !== 'power-pages' || site.sourceStatus.format ? 'ok' : 'warn')}</div>${site.runtime?.kind && site.runtime.kind !== 'power-pages' ? '' : source(site)}`
    + (Object.keys(site.environments).length ? list(`environments-${site.id}`, Object.entries(site.environments), [
      { label: 'Environment', render: ([id]) => `<strong>${esc(id)}</strong>` },
      { label: 'Origin', render: ([, settings]) => `<span class="code-text source-path">${esc(settings.url)}</span>` },
      { label: 'Kind', render: ([, settings]) => (settings.caution ? kit.badge('REAL DATA', 'warn') : kit.badge('Environment', 'neutral')) },
    ], { caption: `Environments of ${site.id}`, text: ([id, settings]) => `${id} ${settings.url}` }) : '')
    + `${site.solutions.length ? `<p class="muted">${site.solutions.length} Solution folder(s) · ${site.solutions.filter(item => item.exists).length} found</p>` : ''}${site.packs?.length ? `<p class="muted">${site.packs.length} explicit pack module(s) · ${site.packs.filter(item => item.exists).length} found. Modules are not executed by setup. <a href="#packs">Data packs</a></p>` : ''}<details class="disclosure" data-section-key="source-${esc(site.id)}"><summary>Edit source settings</summary>${siteEditor(site)}</details></section>`).join('');
  return guideFor('sources') + guideFor('environments') + `<div class="grid-two">${cards}</div>`
    + (state.kind === 'catalogue' ? `<details class="disclosure" data-section-key="add-target"><summary>Add a target</summary><form class="form-grid" data-form="add">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], 'power-pages')}<div class="inline-fields">${field('Target name', 'id', '')}${field('Portal export folder', 'source', '', 'Required only for Power Pages; relative to the source root.')}</div><button type="submit" class="button primary">Add target</button></form></details>` : '')
    + settingEditor('portals');
}
function packsBody() {
  const rows = state.kind === 'project' ? (state.packs ?? []).map(pack => ({ ...pack, target: null })) : state.sites.flatMap(site => (site.packs ?? []).map(pack => ({ ...pack, target: site.id })));
  const live = runtimeInfo.packs, livePack = id => live?.packs?.find(item => item.id === id);
  const activation = pack => {
    if (!live) return kit.badge(liveRuntime() ? 'not reported' : 'start the preview to check', 'neutral');
    const item = livePack(pack.id);
    if (!item) return kit.badge('not loaded', 'warn');
    return item.matched === true ? kit.badge('matched', 'ok') : item.matched === false ? kit.badge('not matched', 'warn') : kit.badge('no portal context', 'neutral');
  };
  const table = list('packs', rows, [
    { label: 'Target', render: pack => esc(pack.target ?? 'project') },
    { label: 'Pack', render: pack => `<code>${esc(pack.id)}</code>` },
    { label: 'Module', render: pack => `<span class="code-text source-path">${esc(pack.module)}</span>` },
    { label: 'File', render: pack => kit.badge(pack.exists ? 'found' : 'missing', pack.exists ? 'ok' : 'bad') },
    { label: 'Running preview', render: activation },
    { label: 'Diagnostics', render: pack => esc(livePack(pack.id)?.diagnostics?.length ?? '—') },
    { label: 'Edit', render: pack => `<a href="#${pack.target ? `portal-${esc(pack.target)}` : 'runtime-configuration'}">Edit registration</a>` },
  ], { caption: 'Registered data packs', emptyText: 'No pack is registered. Add id | module path lines in a target\'s Trusted data packs field.', text: pack => `${pack.target ?? ''} ${pack.id} ${pack.module}` });
  const summary = live ? `<p class="muted">The running preview loaded ${esc(live.packs?.length ?? 0)} pack(s), ${esc((live.packs ?? []).filter(item => item.matched === true).length)} matched. <a href="${esc(adminUrl())}#packs">Open Data packs in Administration</a> for exports, presets, DATA ownership and diagnostics.</p>`
    + ((live.failed ?? []).length ? kit.notice(`Packs that failed to load: ${live.failed.map(item => `${item.module}: ${item.error}`).join('; ')}`, 'bad') : '') : '';
  return guideFor('packs') + table + summary + settingEditor('packs');
}
function personasForm(site) {
  const key = slug(site.id), mirage = site.mirage ?? {}, contexts = mirage.personaContexts ?? {}, provider = mirage.identityProvider ?? {};
  return `<form class="form-grid" data-form="personas" data-site="${esc(site.id)}" id="personas-${key}"><div class="inline-fields">${field('Isolated persona contexts', 'maxInstances', contexts.maxInstances ?? '', `${helpText('setup.personas.maxInstances')} Empty uses the default.`, 'number', { id: `personas-${key}-max`, placeholder: '4' })}`
    + `${choice('Sign-in presentation', 'presentation', [['', 'Not set'], ['page', 'page'], ['dialog', 'dialog']], provider.presentation, `personas-${key}-presentation`, 'How the local identity provider shows its sign-in.')}</div>`
    + `${field('Sign-in title', 'title', provider.title ?? '', 'Title of the local identity provider page or dialog.', 'text', { id: `personas-${key}-title` })}<div class="toolbar"><button type="submit" class="button primary">Save personas</button></div></form>`;
}
function personasBody() {
  const scenarios = 'Three things are called scenarios. Saved state scenarios (Administration → Scenarios) restore a data preset, persona and permission mode. Persona-catalogue scenarios from a pack launch isolated persona contexts. Preflight scenario files ({ id, requires }) scope paqvilo mirage preflight --scenario. The Startup data preset of a target is the data seeded at start.';
  const catalogues = (runtimeInfo.packs?.packs ?? []).filter(pack => Object.values(pack.personaCatalog ?? {}).some(Boolean));
  return guideFor('personas') + kit.help({ text: scenarios, doc: kit.docLink('mirage/docs/persona-catalog.md', state.docs) })
    + (state.kind === 'catalogue' ? state.sites.map(site => `<details class="disclosure" data-section-key="personas-${esc(site.id)}"><summary>${esc(site.id)} · persona contexts and local sign-in</summary>${personasForm(site)}</details>`).join('')
      : kit.notice('personaContexts and identityProvider are catalogue settings; a standalone project file does not accept them. Personas still come from contacts in your data and from pack persona catalogues.', 'neutral'))
    + (catalogues.length ? `<h3>Persona catalogues in the running preview</h3>${list('persona-catalogues', catalogues, ['groups', 'personas', 'contexts', 'scenarios'].reduce((columns, name) => [...columns, { label: name[0].toUpperCase() + name.slice(1), render: pack => esc(pack.personaCatalog?.[name] ?? 0) }], [{ label: 'Pack', render: pack => `<code>${esc(pack.id)}</code>` }]), { caption: 'Persona catalogues by pack' })}<p class="muted"><a href="${esc(adminUrl())}#access">Manage personas in Administration → Portal identity &amp; permissions</a>.</p>` : '')
    + settingEditor('personas');
}
function simulationBody() {
  const targets = state.kind === 'project' ? [{ id: 'project', level: state.settings.simulation?.level, preset: null }]
    : state.sites.map(site => { const mirage = site.effectiveMirage ?? site.mirage ?? {}; return { id: site.id, level: mirage.simulation?.level, preset: mirage.preset, mode: mirage.presetMode, configuration: mirage.presetConfiguration }; });
  return guideFor('simulation') + list('simulation-targets', targets, [
    { label: 'Target', render: item => esc(item.id) },
    { label: 'Simulation level', render: item => kit.badge(item.level ?? 'local state', item.level ? 'info' : 'neutral') },
    { label: 'Startup data preset', render: item => (state.kind === 'project' ? '—' : item.preset ? `<code>${esc(item.preset)}</code>${item.mode ? ` · ${esc(item.mode)}` : ''}${item.configuration ? ` · ${esc(item.configuration)}` : ''}` : 'none') },
    { label: 'Change', render: item => `<a href="#runtime-configuration">Level</a>${state.kind === 'project' ? '' : ` · <a href="#portal-${esc(item.id)}">Preset</a>`}` },
  ], { caption: 'Simulation level and startup preset per target' }) + settingEditor('simulation');
}
function providersBody() {
  const reference = ['storage', 'messaging', 'connections', 'secrets', 'localServices', 'serviceFixtures'].map(name => {
    const entry = HELP[`setup.providers.${name}`];
    return entry ? kit.help({ text: `${name}: ${entry.intro}`, doc: entry.doc ? kit.docLink(entry.doc, state.docs) : undefined }) : '';
  }).join('');
  return guideFor('providers') + `<details class="disclosure" data-section-key="providers-reference"><summary>Provider keys explained</summary>${reference}</details>`
    + (state.kind === 'catalogue' ? kit.notice('Some provider keys are project-only: their rows are marked project:<target> and save to that target\'s linked Mirage project file.', 'neutral') : '')
    + settingEditor('providers');
}
const listText = (items, fields) => (Array.isArray(items) ? items : []).map(item => fields.map(name => item?.[name] ?? '').join(' | ').replace(/(?: \| )+$/, '')).join('\n');
function identityForm(settings, site) {
  const dataverse = settings?.dataverse ?? {}, key = site ? slug(site.id) : 'project', id = name => `identity-${key}-${name}`;
  return `<form class="form-grid" data-form="identity" id="identity-${key}" ${site ? `data-site="${esc(site.id)}"` : ''}><p class="muted">Enable the listener and choose its port in Runtime &amp; persistence.</p>`
    + `<div class="inline-fields">${check('Serve the API over TLS', 'tls', dataverse.tls === true, id('tls'))}${field('TLS port', 'tlsPort', dataverse.tlsPort ?? '', '0 chooses a free port.', 'number', { id: id('tls-port') })}</div>`
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
  return guideFor('identity') + '<p class="muted">Staff users, app secrets (shown once), certificates and federated credentials of a running preview are managed in Administration → Organization identity &amp; API. Configuration holds references only.</p>' + forms + settingEditor('identity');
}
function settingsBody() {
  let form = '<p>Edit the project document in Configuration below.</p>';
  if (state.kind === 'catalogue' && state.settings.browser) {
    const browser = state.settings.browser, doc = key => catalogueDoc(key);
    form = `<form class="form-grid" data-form="settings"><div class="inline-fields">${field('Source root', 'sourceRoot', state.settings.sourceRoot, 'Relative to the catalogue directory. Exports remain outside the toolkit.')}${select('Default portal', 'defaultSite', ['', ...state.sites.map(site => site.id)], state.settings.defaultSite)}</div><div class="inline-fields">${select('Browser', 'browser', ['msedge', 'chrome', 'chromium'], browser.channel)}${select('Development targets', 'portals', ['selected', 'all'], state.settings.portals)}</div><div class="row"><label class="checkbox-line"><input name="liveReload" type="checkbox" ${state.settings.liveReload ? 'checked' : ''}>Reload on save</label><label class="checkbox-line"><input name="panel" type="checkbox" ${state.settings.panel ? 'checked' : ''}>Development panel</label></div>`
      + check('Include real-data (caution) environments in all-target commands', 'includeCaution', state.settings.includeCaution === true, 'settings-include-caution', doc('includeCaution'))
      + `<details class="disclosure" data-section-key="settings-browser"><summary>Browser profile, debugging, agent and editor</summary>`
      + `<div class="inline-fields">${check('Run the browser without a window', 'headless', browser.headless === true, 'settings-headless', doc('browser.headless'))}${check('Bypass the page content security policy', 'bypassCSP', browser.bypassCSP === true, 'settings-bypass-csp', doc('browser.bypassCSP'))}</div>`
      + `<div class="inline-fields">${field('Profile folder', 'profileDir', browser.profileDir ?? '', doc('browser.profileDir'), 'text', { id: 'settings-profile-dir' })}${field('Named profile', 'profile', browser.profile ?? '', doc('browser.profile'), 'text', { id: 'settings-profile' })}</div>`
      + `<div class="inline-fields">${field('Existing user data folder', 'userDataDir', browser.userDataDir ?? '', doc('browser.userDataDir'), 'text', { id: 'settings-user-data' })}${field('Profile directory', 'profileDirectory', browser.profileDirectory ?? '', doc('browser.profileDirectory'), 'text', { id: 'settings-profile-directory' })}</div>`
      + `<div class="inline-fields">${field('DevTools endpoint (cdpUrl)', 'cdpUrl', browser.cdpUrl ?? '', doc('browser.cdpUrl'), 'text', { id: 'settings-cdp' })}${field('Remote debugging port', 'debugPort', browser.debugPort ?? '', doc('browser.debugPort'), 'number', { id: 'settings-debug-port' })}</div>`
      + `<div class="inline-fields">${check('Expose the bounded Lense agent API', 'agentEnabled', state.settings.agent?.enabled === true, 'settings-agent', doc('agent.enabled'))}${check('Map overlaid resources to source files', 'sourceMaps', state.settings.sourceMaps === true, 'settings-source-maps', doc('sourceMaps'))}</div>`
      + `${field('Editor command', 'editor', state.settings.editor ?? '', doc('editor'), 'text', { id: 'settings-editor' })}</details><div class="toolbar"><button type="submit" class="button primary">Save defaults</button></div></form>`;
  } else if (state.kind === 'project') {
    const settings = state.settings;
    form = `<form class="form-grid" data-form="project-settings" id="project-settings"><p class="muted">Empty fields keep the values in the project file.</p><div class="inline-fields">${field('Locale ID (lcid)', 'lcid', settings.lcid ?? '', catalogueDoc('lcid'), 'number', { id: 'project-lcid', placeholder: '1033' })}${field('State folder', 'stateDirectory', settings.stateDirectory ?? '', catalogueDoc('stateDirectory'), 'text', { id: 'project-state-directory' })}</div>`
      + `${choice('Reload when sources change', 'watch', [['', 'Keep the file value'], ['true', 'true'], ['false', 'false']], settings.watch === undefined ? '' : String(settings.watch), 'project-watch', catalogueDoc('watch'))}<div class="toolbar"><button type="submit" class="button primary">Save project settings</button></div></form>`;
  }
  const intro = state.kind === 'project'
    ? kit.help({ text: 'Project-wide settings of this Mirage project file: locale, state folder and source watching. Saves apply on the next start.', doc: kit.docLink('mirage/docs/standalone-organization.md', state.docs) })
    : kit.help({ text: 'Defaults every command reads from this catalogue: the source root, default target, browser, development targets, and the Lense agent and editor options. Shell PAQVILO_* variables and .env values override them. Saves apply on the next start.', doc: kit.docLink('docs/configuration.md', state.docs) });
  return intro + form + `${state.settings.resolvedSourceRoot ? `<p class="code-text source-path">Effective source root: ${esc(state.settings.resolvedSourceRoot)} (${esc(state.settings.provenance?.sourceRoot)})</p>` : ''}${Object.entries(state.settings.effective ?? {}).map(([key, setting]) => `<p class="muted"><code>${esc(key)}</code> = ${esc(setting.value)} · ${esc(setting.origin)} overrides file defaults</p>`).join('')}` + settingEditor('settings');
}
function advancedBody() {
  const documents = Object.keys(state.layers).filter(key => key === 'shared' || key === 'personal' || key.startsWith('project:'));
  const current = state.layers[yamlLayer] ? yamlLayer : layer;
  return `<p class="muted">Use the full document for inline mapping, observations with evidence, packs and other supported settings. <a href="${esc(state.docs?.configuration?.href ?? '#guidance')}" target="_blank" rel="noreferrer">Settings reference ↗</a></p>`
    + `<form class="form-grid" data-form="yaml">${documents.length > 1 ? choice('Document', 'yaml-layer', documents.map(key => [key, `${key} · ${fileName(state.layers[key].file)}`]), current, 'yaml-layer', 'The shared and personal catalogue layers and linked Mirage project files.') : ''}<label> ${esc(current)} configuration<textarea name="yaml" class="ui-mono yaml" spellcheck="false">${esc(state.layers[current]?.text || '{}\n')}</textarea></label>`
    + '<div class="toolbar"><button type="submit" class="button primary">Validate & save document</button><span class="muted">Invalid changes stay here until corrected. Unrelated configuration is preserved by guided forms.</span></div><p class="muted">The editor shows the document verbatim, as saved; it is the only place on this page that shows secrets and connection settings entries (elsewhere they appear as names only). A secrets protectedValue is machine-bound DPAPI ciphertext, not a secret value; secret values never belong in configuration.</p></form>'
    + settingEditor('advanced');
}
function guidanceBody() {
  // Arguments quoted by the server (status.commandArgs), as the restart command quotes them.
  const project = state.kind === 'project', arg = esc(state.commandArgs?.file ?? ''), at = state.commandArgs?.site ? ` ${esc(state.commandArgs.site)}` : '';
  const steps = [
    ['Install and check the toolkit.', 'In a scaffold, run <code>npm run setup</code>; otherwise run <code>npx paqvilo doctor --setup</code>.'],
    ['Scaffold or compare with the example.', `${project ? '' : '<code>npx paqvilo init --check</code> lists remaining scaffold tasks, including pack tests and fixtures. '}<code>npx paqvilo mirage demo</code> copies the shipped example project.`],
    ['Inspect before browsing.', project ? `<code>npx paqvilo mirage inspect ${arg}</code> checks local sources.` : `<code>npx paqvilo lense doctor ${arg} --all</code> checks the configured targets.`],
    ['Check requirements.', `<code>npx paqvilo mirage preflight ${arg}${at}</code> lists blocking requirements; add <code>--scenario FILE</code> or <code>--strict</code> to narrow or tighten them.`],
    ['Generate local data (optional).', `<code>npx paqvilo mirage data scaffold --profile smoke --state .paqvilo/smoke-state.json ${arg}${at}</code> writes a synthetic state file at the path you choose.`],
    ...(project ? [] : [['Write a standalone project (optional).', `<code>npx paqvilo mirage init ${arg}${at}</code> writes a Mirage project file from the site; open it with <code>npx paqvilo setup --project &lt;file&gt;</code>.`]]),
    ['Start a preview.', project ? `<code>npx paqvilo mirage serve ${arg}</code>. Reopen setup during development for status and changes.` : `<code>npx paqvilo mirage dev ${arg}${at}</code> locally, or <code>npx paqvilo lense dev ${arg}${at}</code> for an authorized environment. Reopen setup during development for status and changes.`],
    ['Verify.', 'Open Administration (<code>/_sim/</code>) and the <a href="#system">System map</a>; run preflight there for the scenarios you need.'],
  ];
  const docs = Object.entries(state.docs ?? {}).map(([key, link]) => ({ key, ...(link && typeof link === 'object' ? link : { href: link, path: key, label: key }) }));
  const featured = ['setupWorkspace', 'configuration', 'packs', 'simulation', 'personaCatalog', 'dataverseApi'].map(key => docs.find(item => item.key === key)).filter(item => item?.href);
  return guideFor('start') + `<p class="muted">Run these from <span class="code-text source-path">${esc(state.directory)}</span>.</p><section class="ui-guide" data-ui-guide="start-commands"><p class="ui-guide-title">Commands for this configuration</p><ol>${steps.map(([title, text]) => `<li><strong>${esc(title)}</strong> ${text}</li>`).join('')}</ol></section>`
    + '<p class="muted">Setup never deploys, synchronizes, installs, imports pack code or contacts a live portal. Lense browser actions can affect live data. Follow the user\'s scope; let them handle sign-in/MFA.</p>'
    + `<div class="toolbar">${featured.map(item => `<a href="${esc(item.href)}" target="_blank" rel="noreferrer">${esc(item.label)} ↗</a>`).join('')}</div>`
    + `<details class="disclosure" data-section-key="docs-all"><summary>All guides (${docs.length})</summary>${list('docs', docs, [{ label: 'Guide', render: item => (item.href ? `<a href="${esc(item.href)}" target="_blank" rel="noreferrer">${esc(item.label)} ↗</a>` : esc(item.label)) }, { label: 'Repository path', render: item => `<code>${esc(item.path)}</code>` }], { caption: 'Documentation', text: item => `${item.key} ${item.label} ${item.path}` })}</details>`
    + `<p class="muted">Paqvilo ${esc(state.version)} · guide links open this release's tag (main for prereleases); the installed CLI --help and bundled docs describe the installed version.</p>`;
}

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
  const count = state.findings.length, created = state.layers.shared.exists;
  const personal = state.layers.personal;
  if (!personal) layer = 'shared';
  specs.clear(); lists.clear();
  // First render: Overview, the save target and the stage with the next step are open (plus the hash target and a project's runtime form).
  const next = (state.stages ?? []).find(item => item.status === 'next');
  const nextSections = next ? state.findings.filter(item => next.findings?.includes(item.code)).map(item => String(item.section ?? '').slice(1)) : [];
  nextSection = next ? sectionOf(next) : null;
  $('#breadcrumb').textContent = next ? next.title : 'Overview';
  const opened = new Set(['overview', 'edit-layer', nextSection, ...nextSections, state.kind === 'project' && 'runtime-configuration', decodeURIComponent(location.hash.slice(1))]);
  const afterCreate = body => (created ? body : kit.notice('Create the configuration in Overview first; this stage edits it.', 'neutral'));
  const rail = $('#stage-rail');
  rail.hidden = !(state.stages ?? []).length; rail.innerHTML = railHtml();
  $('#content').innerHTML = datalists() + [
    stage('overview', opened, { eyebrow: 'OVERVIEW', title: created ? 'Your project at a glance' : state.kind === 'project' ? 'Create your Mirage project' : 'Create your catalogue',
      badge: kit.badge(count ? `${count} next step${count === 1 ? '' : 's'}` : 'Configuration ready', count ? 'warn' : 'ok'), body: overviewBody() }),
    stage('system', opened, { eyebrow: 'SYSTEM MAP', title: 'Your system at a glance', intro: helpText('setup.system'), badge: isLive() ? kit.badge('live', 'ok') : kit.badge('planned', 'info'), body: `<div id="system-body">${systemBody()}</div>` }),
    stage('edit-layer', opened, { eyebrow: 'SAVE TARGET', title: 'Where should changes be saved?', intro: 'Shared settings belong to the project. Personal overrides stay on this computer.', badge: '', body: layerBody(personal) }),
    stage('runtime-configuration', opened, { eyebrow: 'RUNTIME + PERSISTENCE', title: 'Runtime configuration', intro: 'Choose the surfaces and write behavior for the next start.', body: afterCreate(runtimeBody()) }),
    stage('portals', opened, { eyebrow: 'LOCAL EXPORTS + ENVIRONMENTS', title: 'Targets & sources', intro: 'Power Pages targets use portal exports. Standalone apps and APIs use Solution exports and packs.', body: afterCreate(portalsBody()) }),
    stage('packs', opened, { eyebrow: 'DATA PACKS', title: 'Data packs', intro: 'Trusted pack modules registered per target; what the running preview loaded and matched.', body: afterCreate(packsBody()) }),
    stage('personas', opened, { eyebrow: 'PERSONAS + SCENARIOS', title: 'Personas & scenarios', intro: 'Isolated persona contexts, the local sign-in and what "scenario" means where.', body: afterCreate(personasBody()) }),
    stage('simulation', opened, { eyebrow: 'SIMULATION + STATE', title: 'Simulation & state', intro: 'Where writes go and which data each start seeds.', body: afterCreate(simulationBody()) }),
    stage('providers', opened, { eyebrow: 'PROVIDERS + SERVICES', title: 'Providers & services', intro: 'Storage, messaging, outbox, connections, secret references, local services and profiles.', body: afterCreate(providersBody()) }),
    stage('identity', opened, { eyebrow: 'IDENTITY + API', title: 'Identity & API', intro: 'The organization API listener, tenant, app registrations and users, by reference only.', body: afterCreate(identityBody()) }),
    stage('settings', opened, { eyebrow: 'PROJECT DEFAULTS', title: 'Project settings', intro: state.kind === 'project' ? 'Locale, state folder and source watching of the project.' : 'Source root, browser, development targets, agent and editor.', body: afterCreate(settingsBody()) }),
    stage('advanced', opened, { eyebrow: 'ADVANCED + RECOVERY', title: 'Configuration & rules', intro: 'The full documents, with every key of the project stage.', body: advancedBody() }),
    stage('guidance', opened, { eyebrow: 'START + VERIFY', title: 'From setup to development', intro: 'Commands for this configuration file, then verification in Administration.', body: guidanceBody() }),
  ].join('');
  applyUiOpen($('#content')); afterSystem();
  if (state.canEdit === false) for (const button of document.querySelectorAll('#content form[data-form] button[type=submit]')) button.disabled = true;
}
$('#content').addEventListener('input', event => {
  const target = event.target;
  if (target.matches('[data-table-search]')) { const key = target.dataset.tableSearch; pagers[key] = { ...pagers[key], search: target.value, page: 1 }; return rerenderTable(key, true); }
  if (target.id === 'dashboard-preflight-requires') { preflightInput.requires = target.value; return; }
  if (target.closest('form[data-form]') && !['layer', 'yaml-layer'].includes(target.id)) dirty = true;
});
$('#content').addEventListener('change', event => {
  const target = event.target;
  if (target.matches('[data-table-size]')) { const key = target.dataset.tableSize; pagers[key] = { ...pagers[key], size: Number(target.value), page: 1 }; return rerenderTable(key); }
  if (target.id === 'dashboard-preflight-strict') { preflightInput.strict = target.checked; return; }
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
  const key = event.target.dataset?.uiSection;
  if (key) uiOpen.set(key, event.target.open);
  if (event.target.id === 'system' && event.target.open) pollDashboard();
}, true);
document.addEventListener('click', event => {
  const link = event.target.closest?.('a[href^="#"]'), href = link?.getAttribute('href'), document_ = link?.dataset.yamlLayer;
  // Links to a document (a linked-project finding, a references-only row) open it in the YAML editor first.
  if (document_ && state?.layers[document_] && document_ !== (state.layers[yamlLayer] ? yamlLayer : layer)) {
    if (dirty && !confirm('Discard unsaved form changes and open another document?')) { event.preventDefault(); return; }
    yamlLayer = document_; dirty = false; renderPreservingContext();
  }
  if (href && href.length > 1) reveal(decodeURIComponent(href.slice(1)));
});
window.addEventListener('hashchange', () => reveal(decodeURIComponent(location.hash.slice(1)), true));
document.addEventListener('visibilitychange', pollDashboard);
setInterval(pollDashboard, 5000);
// ---- Form submissions: one handler per data-form. A handler saves itself, or returns the edits to save.
const SUBMIT = {
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
