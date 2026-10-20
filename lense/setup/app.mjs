const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, layer = 'shared', dirty = false;
const field = (label, name, value, hint = '', type = 'text') => `<div class="field"><label>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}<input name="${esc(name)}" type="${type}" value="${esc(value)}"></label></div>`;
const options = (values, chosen) => values.map(value => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(value)}</option>`).join('');
const select = (label, name, values, chosen) => `<div class="field"><label>${esc(label)}<select name="${name}">${options(values, chosen)}</select></label></div>`;
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
function envRow(id = '', settings = {}) {
  return `<div class="environment-editor"><div class="grid">${field('Environment name', 'env-id', id)}${field('Portal origin', 'env-url', settings.url ?? '', 'HTTP(S) origin only; no sign-in links or query tokens.')}</div><div class="row"><label class="checkbox"><input name="env-caution" type="checkbox" ${settings.caution ? 'checked' : ''}>Real data · caution</label><button class="secondary" type="button" data-remove-env>Remove</button></div></div>`;
}
function siteEditor(site) {
  if (state.kind === 'project') return `<form data-form="project-site" data-site="${esc(site.id)}">${field('Portal export path', 'source', site.source, 'Relative to this Mirage project file.')}<div class="actions"><button type="submit">Save source</button></div></form>`;
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
  const portalUrl = runtime?.portalUrl ?? (runtime?.product === 'Mirage' ? '/' : null);
  const simUrl = runtime?.portalUrl ? new URL('/_sim/', new URL(runtime.portalUrl, location.href)).href : '/_sim/';
  navigation.hidden = !portalUrl;
  navigation.innerHTML = portalUrl ? `<a href="${esc(portalUrl)}">← Back to portal</a>${runtime.product === 'Mirage' ? `<a href="${esc(simUrl)}">Manage data and personas</a><a href="${esc(new URL('/main.aspx', new URL(portalUrl, location.href)).href)}">Model-driven apps</a>` : ''}` : '';
  $('#scope').textContent = state.directory;
  const count = state.findings.length;
  const personal = state.layers.personal;
  if (!personal) layer = 'shared';
  $('#content').innerHTML = `
    <section id="overview"><div class="section-head"><div><span class="eyebrow">OVERVIEW</span><h2>${state.layers.shared.exists ? 'Your project at a glance' : 'Welcome to your new workspace'}</h2></div><span class="badge ${count ? 'warn' : ''}">${count ? `${count} next step${count === 1 ? '' : 's'}` : 'Configuration ready'}</span></div>
    ${runtime ? `<div class="runtime ${runtime.restartRequired ? 'warn' : ''}"><strong>${esc(runtime.product)} preview running${runtime.site ? ` · ${esc(runtime.site)}` : ''}</strong><p>${runtime.restartRequired ? 'Configuration has changed. Restart the preview to apply it; the running sources, browser destination and state stay as started.' : 'Saves apply on your next preview start.'}</p>${runtime.sourceDir ? `<p class="path">Running source: ${esc(runtime.sourceDir)}</p>` : ''}</div>` : ''}
    ${!state.layers.shared.exists ? `<div class="intro"><strong>Start with one configuration</strong><p>Connect a local export and an environment here. Use <code>paqvilo init</code> first if you also want project scripts, tests and agent instructions.</p></div><form data-form="create"><div class="grid">${field('Portal name', 'id', 'portal')}${field('Source root', 'root', './sources', 'Folder holding your local source checkouts.')}</div><button type="submit">Create ${state.kind === 'project' ? 'Mirage project' : 'catalogue'}</button></form>` : ''}
    <ul class="findings">${state.findings.map(item => `<li>${item.site ? `<strong>${esc(item.site)}</strong> · ` : ''}${esc(item.message)} <a href="${item.code === 'configuration' ? '#advanced' : '#portals'}">Review</a></li>`).join('')}</ul><p class="hint">Readiness checks local configuration and folders. It does not prove browser coverage or a deployed commit.</p></section>
    <section id="edit-layer"><div class="section-head"><div><h2>Where should changes be saved?</h2><p>Shared settings belong to the project. Personal overrides stay on this computer.</p></div>${personal ? `<select id="layer" aria-label="Configuration layer">${options(['shared', 'personal'], layer)}</select>` : '<span class="badge neutral">Shared project</span>'}</div><p class="path">${esc(state.layers[layer].file)}</p>${layer === 'personal' ? '<p class="hint">Personal overrides merge with shared settings. Removing an override reveals its shared value. Ignore paqvilo.config.local.yml in Git before using personal settings.</p>' : ''}</section>
    <section id="portals"><div class="section-head"><div><span class="eyebrow">LOCAL EXPORTS + ENVIRONMENTS</span><h2>Portals & sources</h2><p>Each portal has its own sources, environments and simulation settings.</p></div></div><div class="portals">${state.sites.map(site => `<article class="card" id="portal-${esc(site.id)}"><div class="card-head"><h3>${esc(site.id)}</h3><span class="badge ${site.sourceStatus.format ? '' : 'warn'}">${site.sourceStatus.format ? 'Source found' : 'Needs sources'}</span></div>${source(site)}${Object.entries(site.environments).map(([id, settings]) => `<div class="env"><div><strong>${esc(id)}</strong><div class="path">${esc(settings.url)}</div></div><span class="badge ${settings.caution ? 'warn' : 'neutral'}">${settings.caution ? 'REAL DATA' : 'Environment'}</span></div>`).join('')}${site.solutions.length ? `<p class="hint">${site.solutions.length} Solution folder(s) · ${site.solutions.filter(item => item.exists).length} found</p>` : ''}${site.packs?.length ? `<p class="hint">${site.packs.length} explicit pack module(s) · ${site.packs.filter(item => item.exists).length} found. Modules are not executed by setup.</p>` : ''}<details><summary>Edit portal settings</summary>${siteEditor(site)}</details></article>`).join('')}</div>
    ${state.kind === 'catalogue' && state.layers.shared.exists ? `<details><summary>Add a portal</summary><form data-form="add"><div class="grid">${field('Portal name', 'id', '')}${field('Portal export folder', 'source', '', 'Relative to the source root.')}</div><button type="submit">Add portal</button></form></details>` : ''}</section>
    <section id="settings"><div class="section-head"><div><span class="eyebrow">PROJECT DEFAULTS</span><h2>Project settings</h2></div></div>${state.kind === 'catalogue' && state.layers.shared.exists && state.settings.browser ? `<form data-form="settings"><div class="grid">${field('Source root', 'sourceRoot', state.settings.sourceRoot, 'Relative to the catalogue directory. Exports remain outside the toolkit.')}${select('Default portal', 'defaultSite', ['', ...state.sites.map(site => site.id)], state.settings.defaultSite)}</div><div class="grid">${select('Browser', 'browser', ['msedge', 'chrome', 'chromium'], state.settings.browser.channel)}${select('Development targets', 'portals', ['selected', 'all'], state.settings.portals)}</div><div class="row"><label class="checkbox"><input name="liveReload" type="checkbox" ${state.settings.liveReload ? 'checked' : ''}>Reload on save</label><label class="checkbox"><input name="panel" type="checkbox" ${state.settings.panel ? 'checked' : ''}>Development panel</label></div><div class="actions"><button type="submit">Save defaults</button></div></form>` : '<p>Edit the project document in Configuration below.</p>'}
    ${state.settings.resolvedSourceRoot ? `<p class="path">Effective source root: ${esc(state.settings.resolvedSourceRoot)} (${esc(state.settings.provenance?.sourceRoot)})</p>` : ''}${Object.entries(state.settings.effective ?? {}).map(([key, setting]) => `<p class="hint"><code>${esc(key)}</code> = ${esc(setting.value)} · ${esc(setting.origin)} overrides file defaults</p>`).join('')}</section>
    <section id="advanced"><div class="section-head"><div><span class="eyebrow">ADVANCED + RECOVERY</span><h2>Configuration & rules</h2><p>Use the full document for inline mapping, observations with evidence, packs and other supported settings.</p></div><a href="${state.docs.configuration}" target="_blank" rel="noreferrer">Settings reference ↗</a></div><form data-form="yaml"><label> ${esc(layer)} configuration<textarea name="yaml" class="mono yaml" spellcheck="false">${esc(state.layers[layer].text || '{}\n')}</textarea></label><div class="actions"><button type="submit">Validate & save document</button><span class="hint">Invalid changes stay here until corrected. Unrelated configuration is preserved by guided forms.</span></div></form></section>
    <section id="guidance"><span class="eyebrow">NEXT STEPS</span><h2>From setup to development</h2><ol class="steps"><li><strong>Install and check the toolkit.</strong> In a scaffold, run <code>npm run setup</code>; otherwise run <code>paqvilo doctor --setup</code>.</li><li><strong>Connect local exports.</strong> Select existing portal and Solution folders above. Use <code>paqvilo init --check</code> for remaining scaffold tasks, including pack tests and fixtures.</li><li><strong>Inspect before browsing.</strong> Run <code>paqvilo mirage inspect</code> for local sources and <code>paqvilo lense doctor --all</code> for configured targets, using this configuration file.</li><li><strong>Start a preview.</strong> Run <code>paqvilo mirage dev</code> locally, or <code>paqvilo lense dev</code> for an authorized environment. Reopen setup during development for status and changes.</li></ol><p class="hint">Setup never deploys, synchronizes, installs, imports pack code or contacts a live portal. Lense browser actions can affect live data. Follow the user's scope; let them handle sign-in/MFA.</p><div class="links">${Object.entries(state.docs).map(([key, link]) => `<a href="${link}" target="_blank" rel="noreferrer">${esc(key[0].toUpperCase() + key.slice(1))} ↗</a>`).join('')}</div><p class="hint">Paqvilo ${esc(state.version)} · use installed CLI --help and bundled docs when online documentation differs.</p></section>`;
  if (state.canEdit === false) for (const button of document.querySelectorAll('button[type=submit]')) button.disabled = true;
}
$('#content').addEventListener('input', event => { if (event.target.id !== 'layer') dirty = true; });
$('#content').addEventListener('change', event => {
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
      const catalogue = { sourceRoot: value('root') || '.', defaultSite: value('id'), sites: { [value('id')]: { source: '.', defaultEnv: 'dev', environments: { dev: 'https://portal.example.test' }, mirage: { port: 0 } } } };
      const project = { version: 2, defaultPortal: value('id'), portals: [{ id: value('id'), path: value('root') || '.' }] };
      layer = 'shared'; return await save({ text: JSON.stringify(state.kind === 'project' ? project : catalogue, null, 2) });
    }
    if (type === 'add') {
      if (!identifier(value('id')) || state.sites.some(site => site.id === value('id'))) throw new Error('Choose a new, valid portal name.');
      set(['sites', value('id')], { source: value('source') || '.', defaultEnv: 'dev', environments: { dev: 'https://portal.example.test' }, mirage: { port: 0 } });
    }
    if (type === 'settings') {
      set(['sourceRoot'], value('sourceRoot'));
      if (value('defaultSite')) set(['defaultSite'], value('defaultSite'));
      else edits.push({ op: 'delete', path: ['defaultSite'] });
      set(['browser', 'channel'], value('browser')); set(['portals'], value('portals'));
      for (const field of ['panel', 'liveReload']) set([field], data.has(field));
    }
    if (type === 'project-site') set(['portals', state.sites.indexOf(site), 'path'], value('source'));
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
