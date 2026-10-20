const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, layer = 'shared', dirty = false;
const field = (label, name, value, hint = '', type = 'text') => `<div class="field"><label>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}<input name="${esc(name)}" type="${type}" value="${esc(value)}"></label></div>`;
const options = (values, chosen) => values.map(value => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(value)}</option>`).join('');
const select = (label, name, values, chosen) => `<div class="field"><label>${esc(label)}<select name="${name}">${values.map(value => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(name === 'runtime-kind' ? runtimeName(value) : name === 'simulation-level' ? ({ 'local-state': 'Local state (existing compatibility)', 'dry-run': 'Dry run · memory edits', simulation: 'Simulation · pack DATA writes', deep: 'Deep simulation · DATA and schema' })[value] : value)}</option>`).join('')}</select></label></div>`;
const source = site => `<div class="source"><strong>${site.sourceStatus.format ? `${esc(site.sourceStatus.layout?.dialect ?? site.sourceStatus.format)} export` : site.sourceStatus.exists ? 'Folder needs an export' : 'Source folder missing'}</strong><p class="path">${esc(site.sourceStatus.path || 'No source selected')}</p><span class="badge neutral">${site.sourceStatus.git ? `${esc(site.sourceStatus.git.branch)} · ${esc(site.sourceStatus.git.commit)}${site.sourceStatus.git.changed ? ' · tracked changes in this folder' : ''}` : ''}${site.sourceStatus.gitState === 'timeout' ? ' · Git status unavailable (timeout)' : site.sourceStatus.gitState === 'unavailable' ? ' · Git status unavailable' : !site.sourceStatus.git ? 'No committed Git checkout' : ''}</span></div>`;
function notice(message, error = false) { const node = $('#notice'); node.hidden = false; node.className = error ? 'error' : ''; node.textContent = message; }
async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? 'Setup request failed.');
  return data;
}
async function load() {
  try { state = await request('/_setup/api/status'); dirty = false; $('#notice').hidden = true; render(); }
  catch (error) { notice(error.message, true); }
}
async function save(payload) {
  $('#notice').hidden = true;
  const buttons = [...document.querySelectorAll('button[type=submit]')]; buttons.forEach(button => { button.disabled = true; });
  try {
    state = await request('/_setup/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paqvilo-Setup-CSRF': state.csrf }, body: JSON.stringify({ ...payload, layer, revision: state.revision }) });
    dirty = false; render(); notice(state.runtime ? 'Saved. Restart the preview to apply configuration changes.' : 'Saved. Your next preview will use these settings.');
  } catch (error) { notice(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
const operation = (path, value) => ({ op: 'set', path, value });
const runtimeName = kind => ({ 'power-pages': 'Power Pages + model-driven apps', 'model-driven': 'Model-driven apps', 'dataverse-api': 'Dataverse API only' })[kind] ?? kind;
function runtimeEditor(settings, site) {
  const runtime = settings.runtime ?? { kind: 'power-pages' }, simulation = settings.simulation;
  return `<form data-form="runtime" ${site ? `data-site="${esc(site.id)}"` : ''}>
    <div class="grid">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], runtime.kind)}<div data-app-choice ${runtime.kind === 'dataverse-api' ? 'hidden' : ''}>${field('Default application GUID', 'defaultApp', runtime.defaultApp ?? '', 'Optional imported app. Leave empty for the available default.')}</div></div>
    ${select('Simulation level', 'simulation-level', ['local-state', 'dry-run', 'simulation', 'deep'], simulation?.level ?? 'local-state')}
    <div class="hint"><p><strong>Dry run:</strong> edit records in memory; no runtime state or pack writes. <strong>Simulation:</strong> update existing pack DATA files. <strong>Deep:</strong> also allow schema changes in declared DATA/schema destinations.</p><p>Local-state keeps existing ignored-state behavior for older configurations. Pack file ownership is declared by trusted pack modules; setup does not execute them. Changes apply after restart and do not flush in-memory edits.</p></div>
    <div class="grid"><label class="checkbox"><input name="api-enabled" type="checkbox" ${settings.dataverse?.enabled || runtime.kind === 'dataverse-api' ? 'checked' : ''}>Enable organization HTTP API</label>${field('API port', 'api-port', settings.dataverse?.port ?? 0, '0 chooses a free port.', 'number')}</div>
    ${state.kind === 'project' ? `${!state.sites.length ? `<div class="grid" data-portal-source ${runtime.kind === 'power-pages' ? '' : 'hidden'}>${field('Power Pages target name', 'portal-id', 'portal', 'Used only when selecting Power Pages.')}${field('Power Pages export path', 'portal-path', '', 'Add an existing export to switch this standalone project to Power Pages.')}</div>` : '<p class="hint">Existing portal selections are retained when using a standalone profile and become active again when switching back to Power Pages.</p>'}<div class="field"><label>Solution exports<small>One existing local folder per line, relative to this project file. Existing Solution IDs are retained for unchanged paths.</small><textarea name="runtime-solutions">${esc((state.settings.solutions ?? []).map(item => item.path).join('\n'))}</textarea></label></div><div class="field"><label>Trusted data packs<small>One id | module path per line. Register modules explicitly; exports and DATA files remain in your project.</small><textarea name="runtime-packs">${esc((state.settings.dataPacks ?? []).map(item => `${item.id} | ${item.module}`).join('\n'))}</textarea></label></div>` : ''}
    <p class="hint">After starting Mirage, use Administration → Organization identity for staff users, app registrations, local secrets, certificates and federation. Portal visitor personas are separate from organization staff and API application identities.</p><div class="actions"><button type="submit">Save runtime configuration</button><span class="hint">Restart required for running previews.</span></div></form>`;
}
function envRow(id = '', settings = {}) {
  return `<div class="environment-editor"><div class="grid">${field('Environment name', 'env-id', id)}${field('Portal origin', 'env-url', settings.url ?? '', 'HTTP(S) origin only; no sign-in links or query tokens.')}</div><div class="row"><label class="checkbox"><input name="env-caution" type="checkbox" ${settings.caution ? 'checked' : ''}>Real data · caution</label><button class="secondary" type="button" data-remove-env>Remove</button></div></div>`;
}
function siteEditor(site) {
  if (state.kind === 'project') return `<form data-form="project-site" data-site="${esc(site.id)}">${field('Portal export path', 'source', site.source, 'Relative to this Mirage project file.')}<div class="actions"><button type="submit">Save source</button></div></form>`;
  if (site.runtime?.kind && site.runtime.kind !== 'power-pages') return `<form data-form="standalone-site" data-site="${esc(site.id)}">${field('Mirage port', 'port', site.mirage.port ?? '', '0 chooses a free port.', 'number')}<div class="field"><label>Solution export folders<small>One existing local path per line, relative to the source root. This target needs no portal export or environment URL.</small><textarea name="solutions">${esc((site.mirage.solutionRoots ?? state.settings.solutionRoots ?? []).join('\n'))}</textarea></label></div><div class="field"><label>Trusted data packs<small>One id | module path per line. Modules are not executed by setup.</small><textarea name="site-packs">${esc((site.mirage.dataPacks ?? []).map(item => typeof item === 'string' ? `pack | ${item}` : `${item.id} | ${item.module}`).join('\n'))}</textarea></label></div><div class="actions"><button type="submit">Save sources</button></div></form>`;
  return `<form data-form="site" data-site="${esc(site.id)}"><div class="grid">${field('Portal export folder', 'source', site.source, 'Relative to the source root; absolute paths also work.')}${field('Default environment', 'defaultEnv', site.defaultEnv)}</div>
    <div class="grid">${field('Mirage port', 'port', site.mirage.port ?? '', '0 chooses a free port.', 'number')}${field('Start page', 'startPath', site.startPath ?? '/')}</div>
    <div class="field"><label>Solution export folders<small>One path per line, relative to the source root. Leave empty when this portal needs none.</small><textarea name="solutions">${esc((site.mirage.solutionRoots ?? []).join('\n'))}</textarea></label></div>
    <div class="field"><label>Scenario preset<small>Optional ID supplied by a trusted project pack.</small><input name="preset" value="${esc(site.mirage.preset ?? '')}"></label></div>
    <h3>Environments</h3><div data-environments>${Object.entries(site.environments).map(([id, settings]) => envRow(id, settings)).join('')}</div><button type="button" class="secondary" data-add-env>Add environment</button>
    <details><summary>Preview rules</summary>${select('Source scope', 'scope', ['all', 'changed'], site.scope ?? 'all')}<div class="field"><label>Route rules (YAML)<small>Explicit file, directory or passthrough mappings. Other inline/markup settings are in Configuration below.</small><textarea name="routes" class="mono">${esc(JSON.stringify(site.routes ?? [], null, 2))}</textarea></label></div></details>
    <div class="actions"><button type="submit">Save portal</button><span class="hint">Writes the ${layer} configuration.</span></div></form>`;
}
function render() {
  const runtime = state.runtime;
  const navigation = $('#runtime-navigation');
  const portalUrl = runtime?.links?.powerPages ?? runtime?.portalUrl ?? (runtime?.product === 'Mirage' && (!runtime.kind || runtime.kind === 'power-pages') ? '/' : null);
  const simUrl = runtime?.portalUrl ? new URL('/_sim/', new URL(runtime.portalUrl, location.href)).href : '/_sim/';
  navigation.hidden = !runtime;
  navigation.innerHTML = runtime ? `${portalUrl ? `<a href="${esc(portalUrl)}">← Back to portal</a>` : ''}${runtime.product === 'Mirage' ? `<a href="${esc(runtime.links?.administration ?? simUrl)}">Administration</a>${runtime.kind !== 'dataverse-api' ? `<a href="${esc(runtime.links?.modelDriven ?? '/main.aspx')}">Model-driven apps</a>` : ''}` : ''}` : '';
  $('#scope').textContent = state.directory;
  const count = state.findings.length;
  const personal = state.layers.personal;
  if (!personal) layer = 'shared';
  $('#content').innerHTML = `
    <section id="overview"><div class="section-head"><div><span class="eyebrow">OVERVIEW</span><h2>${state.layers.shared.exists ? 'Your project at a glance' : 'Welcome to your new workspace'}</h2></div><span class="badge ${count ? 'warn' : ''}">${count ? `${count} next step${count === 1 ? '' : 's'}` : 'Configuration ready'}</span></div>
    ${runtime ? `<div class="runtime ${runtime.restartRequired ? 'warn' : ''}"><strong>${esc(runtime.product)} preview running${runtime.site ? ` · ${esc(runtime.site)}` : ''}</strong><p>${runtime.restartRequired ? 'Configuration has changed. Restart the preview to apply it; the running sources, browser destination and state stay as started.' : 'Saves apply on your next preview start.'}</p>${runtime.sourceDir ? `<p class="path">Running source: ${esc(runtime.sourceDir)}</p>` : ''}</div>` : ''}
    ${!state.layers.shared.exists ? `<div class="intro"><strong>Choose your local runtime</strong><p>Connect local exports and trusted data packs. Use <code>paqvilo init</code> first if you also want project scripts, tests and agent instructions.</p></div><form data-form="create">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], 'power-pages')}<div class="grid">${field('Target name', 'id', 'portal')}${field('Source root', 'root', './sources', 'Folder holding local exports; a portal is required only for Power Pages.')}</div><button type="submit">Create ${state.kind === 'project' ? 'Mirage project' : 'catalogue'}</button></form>` : ''}
    <ul class="findings">${state.findings.map(item => `<li>${item.site ? `<strong>${esc(item.site)}</strong> · ` : ''}${esc(item.message)} <a href="${item.code === 'configuration' ? '#advanced' : '#portals'}">Review</a></li>`).join('')}</ul><p class="hint">Readiness checks local configuration and folders. It does not prove browser coverage or a deployed commit.</p></section>
    <section id="edit-layer"><div class="section-head"><div><h2>Where should changes be saved?</h2><p>Shared settings belong to the project. Personal overrides stay on this computer.</p></div>${personal ? `<select id="layer" aria-label="Configuration layer">${options(['shared', 'personal'], layer)}</select>` : '<span class="badge neutral">Shared project</span>'}</div><p class="path">${esc(state.layers[layer].file)}</p>${layer === 'personal' ? '<p class="hint">Personal overrides merge with shared settings. Removing an override reveals its shared value. Ignore paqvilo.config.local.yml in Git before using personal settings.</p>' : ''}</section>
    <section id="runtime-configuration"><div class="section-head"><div><span class="eyebrow">RUNTIME + PERSISTENCE</span><h2>Runtime configuration</h2><p>Choose the surfaces and write behavior for the next start.</p></div></div>${state.layers.shared.exists && state.kind === 'project' ? runtimeEditor(state.settings) : state.sites.map(site => `<details><summary>${esc(site.id)} · ${esc(runtimeName(site.runtime?.kind ?? 'power-pages'))}</summary>${runtimeEditor(site.effectiveMirage ?? site.mirage, site)}</details>`).join('')}${(state.solutions ?? []).map(item => `<p class="path">${esc(item.path)} · ${item.exists ? 'Found' : 'Missing'}</p>`).join('')}</section>
    <section id="portals"><div class="section-head"><div><span class="eyebrow">LOCAL EXPORTS + ENVIRONMENTS</span><h2>Targets & sources</h2><p>Power Pages targets use portal exports. Standalone apps and APIs use Solution exports and packs.</p></div></div><div class="portals">${state.sites.map(site => `<article class="card" id="portal-${esc(site.id)}"><div class="card-head"><h3>${esc(site.id)}</h3><span class="badge ${site.runtime?.kind !== 'power-pages' || site.sourceStatus.format ? '' : 'warn'}">${esc(runtimeName(site.runtime?.kind ?? 'power-pages'))}</span></div>${site.runtime?.kind && site.runtime.kind !== 'power-pages' ? '' : source(site)}${Object.entries(site.environments).map(([id, settings]) => `<div class="env"><div><strong>${esc(id)}</strong><div class="path">${esc(settings.url)}</div></div><span class="badge ${settings.caution ? 'warn' : 'neutral'}">${settings.caution ? 'REAL DATA' : 'Environment'}</span></div>`).join('')}${site.solutions.length ? `<p class="hint">${site.solutions.length} Solution folder(s) · ${site.solutions.filter(item => item.exists).length} found</p>` : ''}${site.packs?.length ? `<p class="hint">${site.packs.length} explicit pack module(s) · ${site.packs.filter(item => item.exists).length} found. Modules are not executed by setup.</p>` : ''}<details><summary>Edit source settings</summary>${siteEditor(site)}</details></article>`).join('')}</div>
    ${state.kind === 'catalogue' && state.layers.shared.exists ? `<details><summary>Add a target</summary><form data-form="add">${select('Runtime surface', 'runtime-kind', ['power-pages', 'model-driven', 'dataverse-api'], 'power-pages')}<div class="grid">${field('Target name', 'id', '')}${field('Portal export folder', 'source', '', 'Required only for Power Pages; relative to the source root.')}</div><button type="submit">Add target</button></form></details>` : ''}</section>
    <section id="settings"><div class="section-head"><div><span class="eyebrow">PROJECT DEFAULTS</span><h2>Project settings</h2></div></div>${state.kind === 'catalogue' && state.layers.shared.exists && state.settings.browser ? `<form data-form="settings"><div class="grid">${field('Source root', 'sourceRoot', state.settings.sourceRoot, 'Relative to the catalogue directory. Exports remain outside the toolkit.')}${select('Default portal', 'defaultSite', ['', ...state.sites.map(site => site.id)], state.settings.defaultSite)}</div><div class="grid">${select('Browser', 'browser', ['msedge', 'chrome', 'chromium'], state.settings.browser.channel)}${select('Development targets', 'portals', ['selected', 'all'], state.settings.portals)}</div><div class="row"><label class="checkbox"><input name="liveReload" type="checkbox" ${state.settings.liveReload ? 'checked' : ''}>Reload on save</label><label class="checkbox"><input name="panel" type="checkbox" ${state.settings.panel ? 'checked' : ''}>Development panel</label></div><div class="actions"><button type="submit">Save defaults</button></div></form>` : '<p>Edit the project document in Configuration below.</p>'}
    ${state.settings.resolvedSourceRoot ? `<p class="path">Effective source root: ${esc(state.settings.resolvedSourceRoot)} (${esc(state.settings.provenance?.sourceRoot)})</p>` : ''}${Object.entries(state.settings.effective ?? {}).map(([key, setting]) => `<p class="hint"><code>${esc(key)}</code> = ${esc(setting.value)} · ${esc(setting.origin)} overrides file defaults</p>`).join('')}</section>
    <section id="advanced"><div class="section-head"><div><span class="eyebrow">ADVANCED + RECOVERY</span><h2>Configuration & rules</h2><p>Use the full document for inline mapping, observations with evidence, packs and other supported settings.</p></div><a href="${state.docs.configuration}" target="_blank" rel="noreferrer">Settings reference ↗</a></div><form data-form="yaml"><label> ${esc(layer)} configuration<textarea name="yaml" class="mono yaml" spellcheck="false">${esc(state.layers[layer].text || '{}\n')}</textarea></label><div class="actions"><button type="submit">Validate & save document</button><span class="hint">Invalid changes stay here until corrected. Unrelated configuration is preserved by guided forms.</span></div></form></section>
    <section id="guidance"><span class="eyebrow">NEXT STEPS</span><h2>From setup to development</h2><ol class="steps"><li><strong>Install and check the toolkit.</strong> In a scaffold, run <code>npm run setup</code>; otherwise run <code>paqvilo doctor --setup</code>.</li><li><strong>Connect local exports.</strong> Select existing portal and Solution folders above. Use <code>paqvilo init --check</code> for remaining scaffold tasks, including pack tests and fixtures.</li><li><strong>Inspect before browsing.</strong> Run <code>paqvilo mirage inspect</code> for local sources and <code>paqvilo lense doctor --all</code> for configured targets, using this configuration file.</li><li><strong>Start a preview.</strong> Run <code>paqvilo mirage dev</code> locally, or <code>paqvilo lense dev</code> for an authorized environment. Reopen setup during development for status and changes.</li></ol><p class="hint">Setup never deploys, synchronizes, installs, imports pack code or contacts a live portal. Lense browser actions can affect live data. Follow the user's scope; let them handle sign-in/MFA.</p><div class="links">${Object.entries(state.docs).map(([key, link]) => `<a href="${link}" target="_blank" rel="noreferrer">${esc(key[0].toUpperCase() + key.slice(1))} ↗</a>`).join('')}</div><p class="hint">Paqvilo ${esc(state.version)} · use installed CLI --help and bundled docs when online documentation differs.</p></section>`;
  if (state.canEdit === false) for (const button of document.querySelectorAll('button[type=submit]')) button.disabled = true;
}
$('#content').addEventListener('input', event => { if (event.target.id !== 'layer') dirty = true; });
$('#content').addEventListener('change', event => {
  if (event.target.name === 'runtime-kind') {
    const form = event.target.closest('form');
    const portal = form.querySelector('[data-portal-source]'); if (portal) portal.hidden = event.target.value !== 'power-pages';
    const application = form.querySelector('[data-app-choice]'); if (application) { application.hidden = event.target.value === 'dataverse-api'; if (application.hidden) application.querySelector('input').value = ''; }
    if (event.target.value === 'dataverse-api' && form.querySelector('[name=api-enabled]')) form.querySelector('[name=api-enabled]').checked = true;
  }
  if (event.target.id === 'layer') {
    if (!['shared', 'personal'].includes(event.target.value)) return;
    if (dirty && !confirm('Discard unsaved form changes and switch configuration layer?')) { event.target.value = layer; return; }
    layer = event.target.value === 'personal' ? 'personal' : 'shared'; dirty = false; render();
  }
});
$('#content').addEventListener('click', event => {
  if (event.target.closest('[data-add-env]')) { event.target.closest('form').querySelector('[data-environments]').insertAdjacentHTML('beforeend', envRow()); dirty = true; }
  if (event.target.closest('[data-remove-env]')) { event.target.closest('.environment-editor').remove(); dirty = true; }
});
$('#content').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, data = new FormData(form), value = name => String(data.get(name) ?? '').trim();
  const type = form.dataset.form, id = form.dataset.site, site = state.sites.find(site => site.id === id);
  const edits = [], set = (path, v) => edits.push(operation(path, v));
  const identifier = text => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(text) && !/^(?:constructor|prototype|__proto__)$/i.test(text);
  try {
    if (type === 'yaml') return await save({ text: String(data.get('yaml')) });
    if (type === 'create') {
      if (!identifier(value('id'))) throw new Error('Use a portal name with letters, numbers, underscores or hyphens.');
      const kind = value('runtime-kind'), runtime = { kind }, simulation = { level: 'dry-run' };
      const catalogue = { sourceRoot: value('root') || '.', defaultSite: value('id'), sites: { [value('id')]: { ...(kind === 'power-pages' ? { source: '.', defaultEnv: 'dev', environments: { dev: 'https://portal.example.test' } } : {}), mirage: { port: 0, runtime, simulation, ...(kind === 'dataverse-api' ? { dataverse: { enabled: true } } : {}) } } } };
      const project = { version: 2, runtime, simulation, ...(kind === 'power-pages' ? { defaultPortal: value('id'), portals: [{ id: value('id'), path: value('root') || '.' }] } : { solutions: [], ...(kind === 'dataverse-api' ? { dataverse: { enabled: true } } : {}) }) };
      layer = 'shared'; return await save({ text: JSON.stringify(state.kind === 'project' ? project : catalogue, null, 2) });
    }
    if (type === 'runtime') {
      const before = site ? site.effectiveMirage ?? site.mirage : state.settings, prefix = site ? ['sites', id, 'mirage'] : [];
      const change = (path, next, previous) => { if (JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null)) next === undefined ? edits.push({ op: 'delete', path: [...prefix, ...path] }) : set([...prefix, ...path], next); };
      const kind = value('runtime-kind'), defaultApp = value('defaultApp');
      if (kind === 'dataverse-api' && defaultApp) throw new Error('Clear the default application for an API-only runtime.');
      change(['runtime', 'kind'], kind, before.runtime?.kind ?? 'power-pages');
      change(['runtime', 'defaultApp'], defaultApp || undefined, before.runtime?.defaultApp);
      change(['simulation'], value('simulation-level') === 'local-state' ? undefined : { level: value('simulation-level') }, before.simulation);
      const apiEnabled = data.has('api-enabled');
      if (kind === 'dataverse-api' && !apiEnabled) throw new Error('An API-only runtime requires the organization HTTP API.');
      change(['dataverse', 'enabled'], apiEnabled, before.dataverse?.enabled ?? false);
      change(['dataverse', 'port'], Number(value('api-port')), before.dataverse?.port ?? 0);
      if (state.kind === 'project') {
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
        const packs = value('runtime-packs').split(/\r?\n/).filter(text => text.trim()).map(text => { const [id, ...parts] = text.split('|'); const module = parts.join('|').trim(); if (!identifier(id.trim()) || !module) throw new Error('Use id | module path for each trusted pack.'); return { id: id.trim(), module }; });
        if (new Set(packs.map(item => item.id)).size !== packs.length) throw new Error('Data pack IDs must be unique.');
        if (JSON.stringify(packs) !== JSON.stringify((state.settings.dataPacks ?? []).map(item => ({ id: item.id, module: item.module })))) set(['dataPacks'], packs.map(pack => {
          const index = (state.settings.dataPacks ?? []).findIndex(item => item.id === pack.id), original = state.settings.dataPackEntries?.[index];
          return original && typeof original === 'object' ? { ...original, module: pack.module } : pack;
        }));
      }
      return await save({ operations: edits });
    }
    if (type === 'add') {
      if (!identifier(value('id')) || state.sites.some(site => site.id === value('id'))) throw new Error('Choose a new, valid target name.');
      const kind = value('runtime-kind');
      set(['sites', value('id')], { ...(kind === 'power-pages' ? { source: value('source') || '.', defaultEnv: 'dev', environments: { dev: 'https://portal.example.test' } } : {}), mirage: { port: 0, runtime: { kind }, simulation: { level: 'dry-run' }, ...(kind === 'dataverse-api' ? { dataverse: { enabled: true } } : {}) } });
    }
    if (type === 'settings') {
      set(['sourceRoot'], value('sourceRoot'));
      if (value('defaultSite')) set(['defaultSite'], value('defaultSite'));
      else edits.push({ op: 'delete', path: ['defaultSite'] });
      set(['browser', 'channel'], value('browser')); set(['portals'], value('portals'));
      for (const field of ['panel', 'liveReload']) set([field], data.has(field));
    }
    if (type === 'project-site') set(['portals', state.sites.indexOf(site), 'path'], value('source'));
    if (type === 'standalone-site') {
      const prefix = ['sites', id, 'mirage'];
      const roots = value('solutions').split(/\r?\n/).map(text => text.trim()).filter(Boolean);
      if (JSON.stringify(roots) !== JSON.stringify(site.mirage.solutionRoots ?? state.settings.solutionRoots ?? [])) set([...prefix, 'solutionRoots'], roots);
      const port = value('port') === '' ? undefined : Number(value('port'));
      if (port !== site.mirage.port) port === undefined ? edits.push({ op: 'delete', path: [...prefix, 'port'] }) : set([...prefix, 'port'], port);
      const packs = value('site-packs').split(/\r?\n/).filter(text => text.trim()).map(text => { const [id, ...parts] = text.split('|'); const module = parts.join('|').trim(); if (!identifier(id.trim()) || !module) throw new Error('Use id | module path for each trusted pack.'); return { id: id.trim(), module }; });
      if (new Set(packs.map(item => item.id)).size !== packs.length) throw new Error('Pack IDs must be unique.');
      const old = (site.mirage.dataPacks ?? []).map(item => typeof item === 'string' ? { id: 'pack', module: item } : item);
      if (JSON.stringify(packs) !== JSON.stringify(old)) set([...prefix, 'dataPacks'], packs);
    }
    if (type === 'site') {
      const prefix = ['sites', id];
      set([...prefix, 'source'], value('source'));
      if (value('defaultEnv')) set([...prefix, 'defaultEnv'], value('defaultEnv'));
      else edits.push({ op: 'delete', path: [...prefix, 'defaultEnv'] });
      set([...prefix, 'startPath'], value('startPath') || '/');
      set([...prefix, 'mirage', 'port'], value('port') === '' ? null : Number(value('port')));
      set([...prefix, 'mirage', 'solutionRoots'], value('solutions').split(/\r?\n/).map(text => text.trim()).filter(Boolean));
      set([...prefix, 'mirage', 'preset'], value('preset') || null);
      const environments = {};
      for (const row of form.querySelectorAll('.environment-editor')) {
        const name = row.querySelector('[name=env-id]').value.trim(), url = row.querySelector('[name=env-url]').value.trim();
        if (!identifier(name) || Object.hasOwn(environments, name)) throw new Error('Environment names must be valid and unique.');
        let origin; try { origin = new URL(url); } catch { throw new Error(`Enter a valid origin for ${name}.`); }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Use HTTP(S) origins without credentials, paths or query tokens.');
        // Preserve baseline/scope and other environment-specific settings.
        environments[name] = { ...site.environments[name], url: origin.origin, caution: row.querySelector('[name=env-caution]').checked };
      }
      if (value('defaultEnv') && !environments[value('defaultEnv')]) throw new Error('The default environment must name one of this portal’s environments.');
      for (const [name, setting] of Object.entries(environments)) {
        set([...prefix, 'environments', name, 'url'], setting.url);
        set([...prefix, 'environments', name, 'caution'], setting.caution);
      }
      for (const name of Object.keys(site.environments)) if (!Object.hasOwn(environments, name)) edits.push({ op: 'delete', path: [...prefix, 'environments', name] });
      set([...prefix, 'scope'], value('scope'));
      // Route YAML is passed through the document editor's validator via a string operation.
      edits.push({ op: 'set', path: [...prefix, 'routes'], yaml: value('routes') || '[]' });
    }
    // Guided forms show effective defaults. Write only fields the user changed,
    // so inherited values and scalar environment comments remain untouched.
    const changed = type === 'site' ? edits.filter(edit => {
      const path = edit.path.slice(2);
      let previous = path.reduce((value, key) => value?.[key], site);
      if (path.join('.') === 'startPath') previous ??= '/';
      if (path.join('.') === 'scope') previous ??= 'all';
      if (path[0] === 'environments' && path[2] === 'caution') previous = Boolean(previous);
      if (path.join('.') === 'routes') previous ??= [];
      if (edit.yaml !== undefined) return edit.yaml !== JSON.stringify(previous, null, 2);
      const next = edit.value;
      if (edit.op === 'delete') return previous !== undefined;
      return JSON.stringify(previous ?? null) !== JSON.stringify(next);
    }) : edits;
    await save({ operations: changed });
  } catch (error) { notice(error.message, true); }
});
$('#refresh').addEventListener('click', () => { if (!dirty || confirm('Discard unsaved form changes and reload status?')) load(); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
load();
