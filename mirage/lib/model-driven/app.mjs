import { renderControl, hasControl } from './controls.mjs';
import { icon, navigationIcon } from './icons.mjs';
import { createFormClientRuntime, evaluateRibbonRules } from './client-runtime.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const csrf = $('meta[name="mirage-csrf"]').content;
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem('mirage.apps.' + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('mirage.apps.' + key, JSON.stringify(value)); } catch { /* Session remains usable when browser storage is unavailable. */ } },
};
let catalogue, app, table, current, query = {}, selected = new Set(), record, recordCapabilities, etag, formId, activeTab, controls = [], dirty = false, pending = false, generation = 0, tabObserver, staffIdentity, staffSession, staffSessionError = '';
let recent = storage.get('recent', []), pinned = storage.get('pinned', []);
let touchedFields = new Set();
let clientRuntime, clientReady = Promise.resolve(), clientChanges = Promise.resolve(), requestingSave = false;
let gridSearchTimer, dialogLifetime, formLifetime;
const clientControlState = new Map();
const disposeControls = () => { for (const entry of controls) entry.control.destroy?.(); controls = []; };
function disposeClient() { clearTimeout(gridSearchTimer); formLifetime?.abort(); tabObserver?.disconnect(); clientRuntime?.destroy(); clientRuntime = undefined; clientControlState.clear(); disposeControls(); clientReady = Promise.resolve(); clientChanges = Promise.resolve(); }
const notice = (text, error = false) => { const element = $('#notice'); element.textContent = text; element.hidden = !text; element.classList.toggle('error', error); };
function contentLoading(text) {
  notice('');
  let status = $('#app-loading');
  if (!status) { status = document.createElement('div'); status.id = 'app-loading'; status.className = 'app-loading'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); $('#workspace').append(status); }
  status.textContent = text;
  $('#content').setAttribute('aria-busy', 'true'); $('#content').inert = true; $('#commands').inert = true; $('#commands').classList.remove('busy'); $('#commands').setAttribute('aria-busy', 'true');
}
function contentLoaded() { $('#app-loading')?.remove(); $('#content').setAttribute('aria-busy', 'false'); $('#content').inert = false; $('#commands').inert = false; $('#commands').setAttribute('aria-busy', 'false'); }
function loadFailed(error, retry) {
  contentLoaded(); $('#content').inert = true; $('#commands').inert = true;
  notice(error.message, true); $('#notice').append(document.createTextNode(' '), button('Try again', retry));
}
async function api(path = '', options = {}) {
  const response = await fetch('/_apps/api' + path, { ...options, headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, ...options.headers } });
  const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status}).`); return body;
}
async function staffRequest(options = {}) {
  const response = await fetch('/_sim/api/dataverse/session', { ...options, headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf } });
  const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? 'Staff session unavailable.'); return body;
}
function renderStaffSession(session) {
  staffSession = session; staffSessionError = '';
  staffIdentity = session.current?.kind === 'staff' ? session.current.id : 'local-admin';
  const profile = $('#staff-profile'); profile.textContent = session.current?.kind === 'staff' ? (session.current.name ?? '').split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase() || '#' : '#';
  profile.title = `${session.current?.name ?? 'Local administrator'} · ${session.current?.kind === 'staff' ? (session.current.roles ?? []).join(', ') || 'No roles' : 'Explicit local development administrator'}`;
}
async function loadStaffSession() {
  try { const session = await staffRequest(); renderStaffSession(session); }
  catch (error) { staffSession = undefined; staffIdentity = undefined; staffSessionError = error.message; $('#staff-profile').title = 'Staff session unavailable. Select an identity explicitly.'; notice(error.message, true); }
}
async function staffProfile() {
  await loadStaffSession();
  const body = document.createElement('div');
  body.innerHTML = `<p><strong>${esc(staffSession?.current?.name ?? 'Staff session unavailable')}</strong></p><p>${esc(staffSessionError || (staffSession?.current?.roles ?? []).join(', ') || 'No roles')}</p><p>Staff roles and field security apply to model-driven reads and changes. Local administrator is an explicit development bypass. Portal personas and API application tokens are separate.</p><label for="staff-actor">Organization staff</label>`;
  const select = document.createElement('select'); select.id = 'staff-actor'; select.add(new Option('Local administrator', 'local-admin'));
  for (const user of staffSession?.users ?? []) select.add(new Option(`${user.name} · ${(user.roles ?? []).join(', ') || 'No roles'}`, user.id));
  if (!staffIdentity) { select.add(new Option('Select an identity', '')); select.value = ''; } else select.value = staffIdentity;
  body.append(select); const administration = document.createElement('p'); administration.innerHTML = '<a href="/_sim/#dataverse">Manage organization identities</a>'; body.append(administration);
  dialog('Staff profile', body, [['Close', closeDialog], ['Use identity', async () => {
    const selection = select.value; if (!selection) return;
    closeDialog(); if (!await canLeave()) return;
    renderStaffSession(await staffRequest(selection === 'local-admin' ? { method: 'DELETE' } : { method: 'POST', body: JSON.stringify({ userId: selection }) }));
    generation++; disposeClient();
    dirty = false; record = null; recordCapabilities = undefined; current = null; $('#commands').replaceChildren(); $('#content').replaceChildren(); $('#navigation').replaceChildren();
    catalogue = await api(); await loadRoute();
  }, true]]);
}
const capability = (operation, source = recordCapabilities ?? table?.capabilities) => source?.[operation] !== false;
const capabilityReason = source => source?.reason ?? 'Your staff role or the configured DATA ownership does not allow this operation.';
const appComponents = (type, components) => { const ids = new Set((app?.components ?? []).filter(component => component.type === type).map(component => String(component.id ?? '').replace(/[{}]/g, '').toLowerCase())); const matching = components.filter(component => ids.has(String(component.id).replace(/[{}]/g, '').toLowerCase())); return matching.length ? matching : components; };
const appForms = () => appComponents(60, table.forms);
const appViews = () => appComponents(26, table.views);
function commandUnavailable(command) {
  if (!command.supported) return command.reason ?? 'This exported command is not supported locally.';
  if (catalogue.clientExtensions?.trusted !== true) return 'Trust local Solution client extensions in configuration to run this command.';
  const missing = command.actions?.find(action => !catalogue.clientExtensions.resources?.some(resource => resource.type === 'script' && resource.name === String(action.library ?? '').replace(/^\$webresource:/i, '')));
  return missing ? `Import the command's JavaScript WebResource (${missing.library}) to run it locally.` : undefined;
}
const tablePath = (entity = table.entity, id) => '/tables/' + encodeURIComponent(entity) + (id ? '/' + encodeURIComponent(id) : '');
function button(label, action, { disabled = false, title, className = '', iconName, iconOnly = false, chevron = false } = {}) {
  const iconForLabel = { '⌂  Home': 'home', '＋ New': 'add', '＋ New related record': 'add', '↻ Refresh': 'refresh', '↻ Refresh related records': 'refresh', '▣ Save': 'save', '← Back': 'back', '▥ Edit columns': 'columns', '▽ Edit filters': 'filter', 'Save & Close': 'saveClose', Delete: 'delete', 'Show Chart': 'chart', 'Visualize this view': 'powerbi', 'Email a Link': 'email', Flow: 'flow', 'Run Report': 'report', Share: 'share', Pin: 'pin', Unpin: 'pin' };
  const text = label.replace(/^(?:⌂\s+|＋\s+|↻\s+|▣\s+|←\s+|▥\s+|▽\s+)/, '');
  const graphic = iconName ?? iconForLabel[label];
  const element = document.createElement('button'); element.type = 'button'; element.innerHTML = (graphic ? icon(graphic) : '') + (iconOnly ? '' : `<span>${esc(text)}</span>`) + (chevron ? icon('chevron', 'chevron') : '');
  if (iconOnly) element.setAttribute('aria-label', text);
  element.disabled = disabled; element.className = className; if (title) element.title = title;
  if (action) element.addEventListener('click', () => runButton(element, action)); return element;
}
async function runButton(element, action) {
  if (element.disabled || element.getAttribute('aria-busy') === 'true') return;
  const wasDisabled = element.disabled;
  element.disabled = true; element.setAttribute('aria-busy', 'true');
  try { await run(action); }
  finally { element.removeAttribute('aria-busy'); if (element.isConnected) element.disabled = wasDisabled; }
}
async function run(action) { try { await action(); } catch (error) { notice(error.message, true); } }
function dialog(title, content, actions) {
  dialogLifetime?.abort(); dialogLifetime = new AbortController();
  const lifetime = dialogLifetime;
  const element = $('#dialog'); if (element.open) element.close(); element.replaceChildren();
  element.addEventListener('cancel', () => queueMicrotask(() => lifetime.abort()), { once: true, signal: lifetime.signal });
  const heading = document.createElement('h2'); heading.id = 'dialog-title'; heading.textContent = title;
  const body = document.createElement('div'); body.className = 'dialog-body'; if (typeof content === 'string') body.innerHTML = content; else body.append(content);
  const footer = document.createElement('div'); footer.className = 'dialog-actions';
  element.append(heading, body, footer);
  for (const [name, action, primary] of actions) footer.append(button(name, action, { className: primary ? 'primary' : 'secondary' }));
  element.showModal(); return element;
}
const closeDialog = () => { dialogLifetime?.abort(); $('#dialog').close(); };
// Replacing a modal must settle the old caller as a dismissal as well as remove
// its listeners. Successful actions settle first, before closing their modal.
const onDialogCancel = (_element, listener) => dialogLifetime.signal.addEventListener('abort', listener, { once: true });
async function confirm(title, text, yes = 'Continue') {
  return new Promise(resolve => {
    const element = dialog(title, `<p>${esc(text)}</p>`, [['Cancel', () => { resolve(false); closeDialog(); }], [yes, () => { resolve(true); closeDialog(); }, true]]);
    onDialogCancel(element, () => resolve(false));
  });
}
async function canLeave() { return !dirty || await confirm('Unsaved changes', 'Leave this record and discard your unsaved changes?', 'Discard changes'); }
const firstEntity = application => application.navigation.flatMap(area => area.groups.flatMap(group => group.items)).find(item => item.supported && item.entity)?.entity;
function targetUrl(entity, { id, view, application = app, defaults } = {}) {
  const params = new URLSearchParams({ appname: application.uniqueName ?? application.id, pagetype: id ? 'entityrecord' : 'entitylist', etn: entity });
  if (id && id !== 'new') params.set('id', id); if (view) params.set('viewid', view);
  if (defaults) params.set('extraqs', new URLSearchParams(defaults).toString());
  return '/main.aspx?' + params;
}
async function navigate(entity, { id, view, application = app, replace = false, defaults } = {}) {
  if (!await canLeave()) return;
  const url = targetUrl(entity, { id, view, application, defaults });
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  await loadRoute();
}
function remember(entry) {
  recent = [entry, ...recent.filter(item => item.url !== entry.url)].slice(0, 12); storage.set('recent', recent); renderNavigation();
}
function renderNavigation() {
  const nav = $('#navigation'); nav.replaceChildren();
  nav.append(button('⌂  Home', () => navigate(firstEntity(app)), { className: 'quick' }));
  for (const [label, entries] of [['Recent', recent], ['Pinned', pinned]]) {
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.innerHTML = icon(label === 'Recent' ? 'recent' : 'pin') + `<span>${label}</span>` + icon('chevron', 'chevron'); details.append(summary);
    for (const entry of entries.filter(entry => entry.app === app.uniqueName)) details.append(button(entry.label, async () => { if (!await canLeave()) return; history.pushState({}, '', entry.url); await loadRoute(); }));
    if (!details.querySelector('button')) { const empty = document.createElement('p'); empty.textContent = 'No items yet'; empty.className = 'source-info'; details.append(empty); }
    nav.append(details);
  }
  for (const area of app.navigation) for (const group of area.groups) {
    const heading = document.createElement('h2'); heading.textContent = group.title; if (!nav.querySelector('h2')) heading.className = 'first-group'; nav.append(heading);
    for (const item of group.items) {
      const entry = button(item.title, () => navigate(item.entity), { iconName: navigationIcon(item), disabled: !item.supported, title: item.reason ?? item.title, className: item.entity === table?.entity ? 'active' : '' });
      if (item.entity === table?.entity) entry.setAttribute('aria-current', 'page'); nav.append(entry);
    }
  }
}
function renderCommands(mode) {
  const commands = $('#commands'); commands.replaceChildren(); commands.classList.toggle('form-commands', mode === 'form');
  const separator = () => { const line = document.createElement('span'); line.className = 'separator'; commands.append(line); };
  commands.append(button('Back', mode === 'form' ? () => navigate(table.entity) : null, { iconName: 'back', iconOnly: true, disabled: mode !== 'form' })); separator();
  if (mode === 'form') {
    commands.append(button('Open in new window', null, { iconName: 'open', iconOnly: true, disabled: true, title: 'Opening a separate record window is not supported locally.' })); separator();
    const canSave = capability(record?.[table.idColumn] ? 'update' : 'create');
    commands.append(button('Open in VSCode', null, { iconName: 'vscode', disabled: true, title: 'Opening an external editor is not supported locally.' }), button('▣ Save', () => saveRecord(false), { disabled: !canSave, title: canSave ? undefined : capabilityReason(recordCapabilities ?? table.capabilities) }), button('Save & Close', () => saveRecord(true), { disabled: !canSave }), button('＋ New', () => navigate(table.entity, { id: 'new' }), { disabled: !capability('create', table.capabilities), title: capability('create', table.capabilities) ? undefined : capabilityReason(table.capabilities) }), button('Deactivate', null, { iconName: 'deactivate', disabled: true, title: 'Record activation commands are not supported locally yet.' }));
    if (record?.[table.idColumn]) commands.append(button('Delete', () => deleteRecords([{ id: record[table.idColumn], etag }]), { disabled: !capability('delete') || table.protectedIds?.includes(record[table.idColumn]), title: table.protectedIds?.includes(record[table.idColumn]) ? 'The source website cannot be deleted from its own running instance.' : !capability('delete') ? capabilityReason(recordCapabilities ?? table.capabilities) : undefined }));
    commands.append(button('↻ Refresh', async () => { if (await canLeave()) await loadRoute(); }), button('Check Access', null, { iconName: 'key', disabled: true, title: 'Access inspection command is not supported locally.' }), button('Flow', null, { disabled: true, chevron: true, title: 'Flow is not supported locally.' }));
    commands.append(button('More commands', () => { const isPinned = pinned.some(item => item.url === location.pathname + location.search); dialog('Record commands', '<p>Keep this local record in your pinned navigation.</p>', [['Close', closeDialog], [isPinned ? 'Unpin' : 'Pin', () => { const url = location.pathname + location.search; pinned = isPinned ? pinned.filter(item => item.url !== url) : [...pinned, { url, label: record?.[table.nameColumn] ?? table.singular, app: app.uniqueName }]; storage.set('pinned', pinned); closeDialog(); renderNavigation(); }]]); }, { iconName: 'more', iconOnly: true }));
  } else {
    commands.append(button('Show Chart', null, { disabled: true, title: 'Charts are not supported locally yet.' }), button('＋ New', () => navigate(table.entity, { id: 'new' }), { className: 'new-command', disabled: !capability('create', current?.capabilities ?? table.capabilities), title: capability('create', current?.capabilities ?? table.capabilities) ? 'Create a local record' : capabilityReason(current?.capabilities ?? table.capabilities) }), button('Delete', async () => {
      const rows = await Promise.all([...selected].map(id => api(tablePath(table.entity, id)).then(value => ({ id, etag: value.etag })))); await deleteRecords(rows);
    }, { disabled: !selected.size || !capability('delete', current?.capabilities ?? table.capabilities) || [...selected].some(id => table.protectedIds?.includes(id) || current?.rowCapabilities?.[id]?.delete === false), title: !capability('delete', current?.capabilities ?? table.capabilities) || [...selected].some(id => current?.rowCapabilities?.[id]?.delete === false) ? capabilityReason(current?.capabilities ?? table.capabilities) : [...selected].some(id => table.protectedIds?.includes(id)) ? 'The source website cannot be deleted from its own running instance.' : undefined }), button('↻ Refresh', () => loadGrid()));
    commands.append(button('Visualize this view', null, { disabled: true, title: 'Power BI is not supported locally.' }), button('Email a Link', null, { disabled: true, chevron: true, title: 'Email links are not supported locally.' }), button('Flow', null, { disabled: true, chevron: true, title: 'Flow is not supported locally.' }), button('Run Report', null, { disabled: true, chevron: true, title: 'Reports are not supported locally.' }), button('More commands', null, { disabled: true, iconName: 'more', iconOnly: true, title: 'Additional ribbon commands are not supported locally.' }));
  }
  commands.append(button('Share', null, { disabled: true, className: 'share-command', chevron: true, title: 'Sharing is not supported locally.' }));
  for (const command of table?.commands ?? []) {
    if (!command.locations?.includes(mode)) continue;
    const context = { mode, entity: table.entity, selection: [...selected], existing: Boolean(record?.[table.idColumn]), read: name => record?.[name] };
    if (command.supported && !evaluateRibbonRules(command.displayRules, context)) continue;
    const unavailable = commandUnavailable(command), disabled = Boolean(unavailable) || !evaluateRibbonRules(command.enableRules, context);
    const entry = button(command.label, async () => { await clientReady; const runtime = clientRuntime ??= createShellClient({ clientEvents: [], tabs: [] }); await runtime.command(command, [...selected]); renderCommands(mode); }, { disabled, title: disabled ? unavailable ?? 'The exported enable rule is not satisfied.' : 'Exported Solution command · local data only' });
    entry.dataset.solutionCommand = command.id; commands.insertBefore(entry, commands.lastChild);
  }
}
function refreshCommandRules(mode) {
  const context = { mode, entity: table.entity, selection: [...selected], existing: Boolean(record?.[table.idColumn]), read: name => record?.[name] };
  for (const node of document.querySelectorAll('[data-solution-command]')) {
    const command = table.commands?.find(command => command.id === node.dataset.solutionCommand); if (!command) continue;
    node.hidden = command.supported && !evaluateRibbonRules(command.displayRules, context);
    node.disabled = Boolean(commandUnavailable(command)) || !evaluateRibbonRules(command.enableRules, context);
  }
}
const preferenceKey = () => `view.${app.uniqueName}.${table.entity}.${query.view}`;
function savePreferences() { storage.set(preferenceKey(), { columns: query.columns, filters: query.filters }); }
function display(value, field, row, name) {
  const formatted = row?.[name + '@OData.Community.Display.V1.FormattedValue']; if (formatted !== undefined) return String(formatted);
  if (value == null) return '';
  if (typeof value === 'object') return value.name ?? value.label ?? value.id ?? JSON.stringify(value);
  if (field?.options?.length) return field.options.find(option => String(option.value) === String(value))?.label ?? String(value);
  if (field?.type === 'boolean') return value ? 'Yes' : 'No';
  if (field?.type === 'date') { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value); }
  return String(value);
}
async function loadGrid() {
  const token = ++generation; selected = new Set(); renderCommands('grid'); contentLoading('Loading records…');
  try {
    const result = await api(tablePath() + '?query=' + encodeURIComponent(JSON.stringify(query)));
    if (token !== generation) return; current = result; renderCommands('grid'); renderGrid();
    contentLoaded();
  } catch (error) { if (token === generation) loadFailed(error, loadGrid); }
}
function renderGrid() {
  clearTimeout(gridSearchTimer);
  document.title = `${table.label} ${table.views.find(view => view.id === query.view)?.name ?? ''} - ${app.name} · Mirage`;
  const content = $('#content'); content.replaceChildren(); content.className = 'grid-content';
  const header = document.createElement('div'); header.className = 'grid-header';
  const views = document.createElement('select'); views.className = 'view-select'; views.setAttribute('aria-label', 'View');
  views.title = table.views.find(view => view.id === query.view)?.source === 'solution' ? 'Exported solution view' : 'Generated from available metadata';
  for (const view of appViews()) views.add(new Option(view.name, view.id)); views.value = query.view;
  views.addEventListener('change', () => run(() => navigate(table.entity, { view: views.value })));
  header.append(views, button('▥ Edit columns', editColumns), button('▽ Edit filters', editFilters));
  const search = document.createElement('input'); search.type = 'search'; search.className = 'search'; search.placeholder = 'Filter by keyword'; search.setAttribute('aria-label', 'Filter by keyword'); search.value = query.search ?? '';
  const searchGeneration = generation;
  const applySearch = async () => { if (!search.isConnected || searchGeneration !== generation) return; query.search = search.value; query.page = 1; await loadGrid(); $('.search')?.focus(); };
  search.addEventListener('input', () => { clearTimeout(gridSearchTimer); gridSearchTimer = setTimeout(() => run(applySearch), 300); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { clearTimeout(gridSearchTimer); run(applySearch); } });
  const searchBox = document.createElement('div'); searchBox.className = 'search-box'; searchBox.innerHTML = icon('search'); searchBox.append(search); header.append(searchBox); content.append(header);
  if (query.filters?.length) { const summary = document.createElement('div'); summary.className = 'filter-summary'; summary.textContent = query.filters.map(filter => `${table.fields[filter.field]?.label ?? filter.field} ${filter.operator} ${filter.value ?? ''}`).join(' AND '); summary.append(button('Clear filters', () => { query.filters = []; query.page = 1; savePreferences(); return loadGrid(); })); content.append(summary); }
  const scroll = document.createElement('div'); scroll.className = 'grid-scroll';
  const grid = document.createElement('table'); grid.setAttribute('aria-label', table.label);
  const columnGroup = document.createElement('colgroup'), selectionColumn = document.createElement('col'); selectionColumn.className = 'selection-column'; columnGroup.append(selectionColumn);
  const viewWidths = table.views.find(view => view.id === query.view)?.fields ?? [];
  const weights = current.columns.map(name => viewWidths.find(field => field.name === name)?.width ?? 150), totalWidth = weights.reduce((sum, width) => sum + width, 0);
  for (const width of weights) { const column = document.createElement('col'); column.style.width = ((width / totalWidth) * 100) + '%'; columnGroup.append(column); } grid.append(columnGroup);
  const head = document.createElement('thead'), headings = document.createElement('tr'), selection = document.createElement('th'); selection.className = 'selection';
  const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all records'); all.addEventListener('change', () => { selected = new Set(all.checked ? current.rows.map(row => String(row[table.idColumn])) : []); renderRows(); renderCommands('grid'); }); selection.append(all); headings.append(selection);
  for (const name of current.columns) {
    const th = document.createElement('th'); th.scope = 'col';
    const direction = current.sort === name ? current.direction === 'desc' ? ' ↓' : ' ↑' : '';
    th.append(button((table.fields[name]?.label ?? name) + direction, () => { query.direction = query.sort === name && query.direction !== 'desc' ? 'desc' : 'asc'; query.sort = name; query.page = 1; return loadGrid(); }, { disabled: !table.fields[name], chevron: true }));
    if (current.sort === name) th.setAttribute('aria-sort', current.direction === 'desc' ? 'descending' : 'ascending'); headings.append(th);
  }
  head.append(headings); grid.append(head, document.createElement('tbody')); scroll.append(grid); content.append(scroll);
  function renderRows() {
    const body = grid.querySelector('tbody'); body.replaceChildren();
    for (const row of current.rows) {
      const id = String(row[table.idColumn]), tr = document.createElement('tr'); tr.classList.toggle('selected', selected.has(id));
      const selectCell = document.createElement('td'); selectCell.className = 'selection'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(id); checkbox.setAttribute('aria-label', `Select ${display(row[table.nameColumn]) || id}`);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(id); else selected.delete(id); tr.classList.toggle('selected', checkbox.checked); all.checked = selected.size === current.rows.length; all.indeterminate = selected.size > 0 && !all.checked; renderCommands('grid'); }); selectCell.append(checkbox); tr.append(selectCell);
      for (const [index, name] of current.columns.entries()) {
        const cell = document.createElement('td'), value = display(row[name], table.fields[name], row, name); cell.title = value;
        if (name === table.nameColumn || index === 0) cell.append(button(value || '(No name)', () => navigate(table.entity, { id }), { className: 'link' }));
        else cell.textContent = value;
        tr.append(cell);
      }
      body.append(tr);
    }
    if (!current.rows.length) { const tr = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = current.columns.length + 1; cell.className = 'empty-state'; cell.innerHTML = '<strong>No records available</strong>Change your filters or create a local record.'; tr.append(cell); body.append(tr); }
  }
  renderRows();
  const footer = document.createElement('div'); footer.className = 'grid-footer';
  const count = document.createElement('span'); count.textContent = current.total >= 0 ? `Rows: ${current.total}` : `Rows on this page: ${current.rows.length}`;
  const info = document.createElement('span'); info.className = 'page-info'; info.textContent = `Page ${current.page}`;
  const size = document.createElement('select'); size.setAttribute('aria-label', 'Rows per page'); for (const count of [25, 50, 100]) size.add(new Option(String(count), String(count))); size.value = String(query.pageSize ?? 50); size.addEventListener('change', () => run(() => { query.pageSize = Number(size.value); query.page = 1; return loadGrid(); }));
  footer.append(count);
  if (current.more || current.page > 1 || current.total > 25) footer.append(info, size, button('‹ Previous', () => { query.page--; return loadGrid(); }, { disabled: current.page <= 1 }), button('Next ›', () => { query.page++; return loadGrid(); }, { disabled: !current.more })); content.append(footer);
}
function editColumns() {
  const chosen = [...current.columns], other = Object.keys(table.fields).filter(name => !chosen.includes(name)), order = [...chosen, ...other];
  const body = document.createElement('div'), filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = 'Find a column'; filter.setAttribute('aria-label', 'Find a column'); body.append(filter); const list = document.createElement('div'); body.append(list);
  function render() {
    list.replaceChildren();
    for (const name of order.filter(name => (table.fields[name]?.label ?? name).toLowerCase().includes(filter.value.toLowerCase()))) {
      const row = document.createElement('div'); row.className = 'column-row'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'column-' + name; checkbox.checked = chosen.includes(name); const label = document.createElement('label'); label.htmlFor = checkbox.id; label.textContent = table.fields[name]?.label ?? name;
      checkbox.addEventListener('change', () => { if (checkbox.checked) chosen.push(name); else chosen.splice(chosen.indexOf(name), 1); });
      const move = offset => { const index = order.indexOf(name), next = index + offset; if (next < 0 || next >= order.length) return; [order[index], order[next]] = [order[next], order[index]]; render(); };
      row.append(checkbox, label, button('↑', () => move(-1), { title: `Move ${label.textContent} up` }), button('↓', () => move(1), { title: `Move ${label.textContent} down` })); list.append(row);
    }
  }
  filter.addEventListener('input', render); render();
  dialog('Edit columns', body, [['Cancel', closeDialog], ['Reset', async () => { query.columns = undefined; query.page = 1; savePreferences(); closeDialog(); await loadGrid(); }], ['Apply', async () => { const columns = order.filter(name => chosen.includes(name)); if (!columns.length) { filter.setCustomValidity('Select at least one column.'); filter.reportValidity(); return; } query.columns = columns; query.page = 1; savePreferences(); closeDialog(); await loadGrid(); }, true]]);
}
function editFilters() {
  const filters = structuredClone(query.filters ?? []), body = document.createElement('div'), intro = document.createElement('p'); intro.textContent = 'Show records matching all of these conditions.'; body.append(intro);
  const list = document.createElement('div'); body.append(list);
  const operators = [['eq', 'Equals'], ['ne', 'Does not equal'], ['like', 'Contains (% wildcards)'], ['not-like', 'Does not contain (% wildcards)'], ['gt', 'Greater than'], ['ge', 'Greater than or equal'], ['lt', 'Less than'], ['le', 'Less than or equal'], ['null', 'Does not contain data'], ['not-null', 'Contains data']];
  function render() {
    list.replaceChildren();
    for (const [index, filter] of filters.entries()) {
      const row = document.createElement('div'); row.className = 'filter-row';
      const field = document.createElement('select'); field.setAttribute('aria-label', `Filter ${index + 1} column`); for (const definition of Object.values(table.fields)) field.add(new Option(definition.label ?? definition.name, definition.name)); field.value = filter.field; field.addEventListener('change', () => { filter.field = field.value; });
      const operator = document.createElement('select'); operator.setAttribute('aria-label', `Filter ${index + 1} operator`); for (const [value, label] of operators) operator.add(new Option(label, value)); operator.value = filter.operator;
      const value = document.createElement('input'); value.setAttribute('aria-label', `Filter ${index + 1} value`); value.value = filter.value ?? ''; value.disabled = ['null', 'not-null'].includes(filter.operator); value.addEventListener('input', () => { filter.value = value.value; }); operator.addEventListener('change', () => { filter.operator = operator.value; value.disabled = ['null', 'not-null'].includes(filter.operator); });
      row.append(field, operator, value, button('×', () => { filters.splice(index, 1); render(); }, { title: 'Remove condition' })); list.append(row);
    }
  }
  body.append(button('＋ Add condition', () => { filters.push({ field: table.nameColumn, operator: 'eq', value: '' }); render(); })); render();
  dialog('Edit filters', body, [['Cancel', closeDialog], ['Apply', async () => { query.filters = filters; query.page = 1; savePreferences(); closeDialog(); await loadGrid(); }, true]]);
}
async function lookup(field) {
  const targets = field.targets.filter(entity => catalogue.tables[entity]); if (!targets.length) return null;
  return new Promise(resolve => {
    const body = document.createElement('div'), target = document.createElement('select'); target.setAttribute('aria-label', 'Lookup table'); for (const entity of targets) target.add(new Option(catalogue.tables[entity].label, entity));
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search records'; search.setAttribute('aria-label', 'Search lookup records');
    const results = document.createElement('div'); results.className = 'lookup-results'; body.append(target, search, results);
    const element = dialog(`Look up ${field.label}`, body, [['Cancel', () => { resolve(null); closeDialog(); }]]); onDialogCancel(element, () => resolve(null));
    let timer, sequence = 0; const lifetime = dialogLifetime;
    lifetime.signal.addEventListener('abort', () => { clearTimeout(timer); sequence++; }, { once: true });
    async function load() {
      if (lifetime.signal.aborted || !results.isConnected) return;
      const token = ++sequence, destination = catalogue.tables[target.value];
      results.setAttribute('aria-busy', 'true'); results.textContent = 'Searching local records…';
      try {
        const found = await api(tablePath(target.value) + '?query=' + encodeURIComponent(JSON.stringify({ search: search.value, columns: [destination.nameColumn], pageSize: 50, view: destination.views.find(view => view.id === 'all')?.id })));
        if (token !== sequence || lifetime.signal.aborted) return; results.replaceChildren();
        for (const row of found.rows) results.append(button(display(row[destination.nameColumn]) || '(No name)', () => { resolve({ id: row[destination.idColumn], entity: destination.entity, name: display(row[destination.nameColumn]) }); closeDialog(); }));
        if (!found.rows.length) results.textContent = 'No matching local records.';
      } catch (error) { if (token === sequence && !lifetime.signal.aborted) { results.textContent = error.message + ' '; results.append(button('Try again', load)); } }
      finally { if (token === sequence && !lifetime.signal.aborted) results.setAttribute('aria-busy', 'false'); }
    }
    target.addEventListener('change', () => run(load)); search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(load), 250); }); run(load);
  });
}
async function loadRecord(id) {
  const token = ++generation; contentLoading(id ? 'Loading record and form…' : 'Preparing new record…');
  try {
    const result = id ? await api(tablePath(table.entity, id)) : { row: Object.fromEntries(Object.values(table.fields).filter(field => field.defaultValue !== undefined).map(field => [field.name, field.defaultValue])) };
    if (token !== generation) return; record = result.row; touchedFields = new Set(); recordCapabilities = result.capabilities ?? table.capabilities;
    if (!id) {
      const defaults = new Map(new URLSearchParams(new URLSearchParams(location.search).get('extraqs') ?? ''));
      const initialValues = Object.values(table.fields)
        .filter(field => defaults.has(field.name) && !field.isPrimaryId && field.validForCreate !== false && hasControl(field))
        .map(field => {
          const value = defaults.get(field.name);
          return [field.name, field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === 'true' : value];
        });
      // Creating own data properties avoids invoking inherited setters from URL-supplied defaults.
      record = { ...record, ...Object.fromEntries(initialValues) };
    }
    etag = result.etag; formId = appForms()[0]?.id; activeTab = null; await renderRecord();
    if (token !== generation) return;
    if (id) remember({ label: record[table.nameColumn] ?? table.singular, url: location.pathname + location.search, app: app.uniqueName });
    contentLoaded();
  } catch (error) { if (token === generation) loadFailed(error, () => { disposeClient(); dirty = false; return loadRecord(id); }); }
}
async function renderRecord() {
  const renderGeneration = generation;
  formLifetime?.abort(); formLifetime = new AbortController();
  tabObserver?.disconnect();
  disposeControls();
  const content = $('#content'); content.replaceChildren(); content.className = 'record-content';
  const existing = Boolean(record[table.idColumn]);
  document.title = `${existing ? record[table.nameColumn] ?? table.singular : 'New ' + table.singular} - ${app.name} · Mirage`;
  renderCommands('form');
  const recordCard = document.createElement('div'); recordCard.className = 'record-card'; content.append(recordCard);
  const header = document.createElement('div'); header.className = 'record-header'; header.innerHTML = `<div><div class="record-title"><h1>${esc(existing ? record[table.nameColumn] ?? '(No name)' : 'New ' + table.singular)}</h1><span class="record-saved" id="save-status"> - ${dirty ? 'Unsaved changes' : existing ? 'Saved' : 'New record'}</span></div><small>${esc(table.singular)}</small></div>`;
  recordCard.append(header);
  const availableForms = appForms();
  let selectedForm = availableForms.find(form => form.id === formId) ?? availableForms[0];
  if (availableForms.length > 1) { const chooser = document.createElement('select'); chooser.setAttribute('aria-label', 'Record form'); chooser.className = 'form-chooser'; for (const form of availableForms) chooser.add(new Option(form.name, form.id)); chooser.value = selectedForm.id; chooser.addEventListener('change', () => run(async () => { captureDraft(); disposeClient(); formId = chooser.value; await renderRecord(); })); header.append(chooser); }
  if (selectedForm.hasScripts) { const warning = document.createElement('span'); warning.className = 'script-indicator'; warning.textContent = catalogue.clientExtensions?.trusted ? 'Local Solution scripts' : 'Local scripts disabled'; warning.title = catalogue.clientExtensions?.trusted ? 'Explicitly trusted exported scripts execute against the bounded local client API.' : 'Trust local Solution client extensions in configuration to run exported form events.'; header.append(warning); }
  const tabs = document.createElement('div'); tabs.className = 'tabs'; tabs.setAttribute('role', 'tablist');
  const availableTabs = selectedForm.tabs.filter(tab => tab.visible !== false);
  activeTab = availableTabs.some(tab => tab.id === activeTab) ? activeTab : availableTabs[0]?.id;
  const chooseTab = async tab => { captureDraft(); activeTab = tab.id; await renderRecord(); };
  for (const tab of availableTabs) { const tabButton = button(tab.label, () => chooseTab(tab)); tabButton.setAttribute('role', 'tab'); tabButton.setAttribute('aria-selected', String(tab.id === activeTab)); tabs.append(tabButton); }
  const tabButtons = [...tabs.children];
  const moreTabs = button('More tabs', () => { const list = document.createElement('div'); list.className = 'lookup-results'; for (const tab of availableTabs) list.append(button(tab.label, () => { closeDialog(); chooseTab(tab); })); dialog('Record tabs', list, [['Close', closeDialog]]); }, { iconName: 'more', iconOnly: true }); moreTabs.hidden = true;
  const assist = button('Form assist', null, { iconName: 'pageForm', disabled: true, className: 'form-assist', title: 'Form assist is not supported locally.' });
  tabs.append(moreTabs, assist); recordCard.append(tabs);
  tabObserver = new ResizeObserver(() => {
    tabButtons.forEach(button => { button.hidden = false; }); moreTabs.hidden = true;
    const gap = 22, budget = tabs.clientWidth - 42 - assist.offsetWidth - gap;
    const selected = tabButtons.find(entry => entry.getAttribute('aria-selected') === 'true');
    let used = (selected?.offsetWidth ?? 0) + gap, overflow = false;
    for (const entry of tabButtons) { if (entry === selected) continue; const width = entry.offsetWidth + gap; const fits = used + width <= budget - 45; entry.hidden = !fits; if (fits) used += width; else overflow = true; }
    moreTabs.hidden = !overflow;
  }); tabObserver.observe(tabs);
  const form = document.createElement('form'); form.id = 'record-form'; form.className = 'form-layout';
  form.addEventListener('submit', event => { event.preventDefault(); run(() => saveRecord(false)); });
  const tab = availableTabs.find(tab => tab.id === activeTab);
  const widths = tab?.columnWidths?.length ? tab.columnWidths : [100];
  form.style.gridTemplateColumns = widths.map(width => `${Math.max(1, width)}fr`).join(' ');
  const columns = widths.map(() => { const column = document.createElement('div'); column.className = 'form-column'; form.append(column); return column; });
  for (const section of tab?.sections ?? []) {
    if (section.visible === false) continue;
    const panel = document.createElement('section'); panel.className = 'form-section'; if (section.label && section.showLabel !== false) { const title = document.createElement('h2'); title.textContent = section.label; panel.append(title); }
    const fields = document.createElement('div'); fields.className = 'section-fields'; fields.dataset.columns = String(section.columns ?? 1); panel.append(fields);
    for (const cell of section.fields) {
      const position = element => { element.hidden = clientControlState.get(cell.sourceControl?.id ?? cell.name)?.get('hidden') ?? cell.visible === false; if (cell.column !== undefined) element.style.gridColumn = `${cell.column + 1} / span ${Math.min(cell.colspan ?? 1, section.columns ?? 1)}`; if (cell.row !== undefined) element.style.gridRow = String(cell.row + 1); fields.append(element); };
      if (cell.subgrid) { position(renderSubgrid(cell)); continue; }
      if (!cell.supported || !table.fields[cell.name]) { const unsupported = document.createElement('p'); unsupported.className = 'unsupported'; unsupported.textContent = `${cell.label ?? 'Control'}: ${cell.reason ?? 'Unsupported control'}`; position(unsupported); continue; }
      const field = { ...table.fields[cell.name], label: cell.label ?? table.fields[cell.name].label };
      const mode = existing ? 'update' : 'create';
      const disabled = cell.disabled || field.isPrimaryId || field[existing ? 'validForUpdate' : 'validForCreate'] === false || !capability(mode) || recordCapabilities?.fields?.[field.name]?.[mode] === false;
      const wrapper = document.createElement('div'); wrapper.className = 'field'; const label = document.createElement('label'); label.htmlFor = 'field-' + field.name; label.textContent = field.label; if (field.required) { const required = document.createElement('span'); required.className = 'required'; required.setAttribute('aria-hidden', 'true'); required.textContent = '*'; label.append(required); }
      if (cell.showLabel === false) label.className = 'sr-only';
      const name = cell.sourceControl?.id ?? field.name;
      const control = renderFieldControl(cell, field, disabled); wrapper.append(label, control.element); position(wrapper); controls.push({ name: field.name, controlName: name, cell, wrapper, label, control, disabled });
    }
    columns[Math.max(0, section.column ?? 0)]?.append(panel);
  }
  const markDirty = event => { const entry = controls.find(entry => entry.control.element === event.target || entry.control.element.contains(event.target)); if (!entry || entry.disabled || !entry.control.supported) return; touchedFields.add(entry.name); dirty = true; notice(''); $('#save-status').textContent = ' - Unsaved changes'; };
  form.addEventListener('input', markDirty); form.addEventListener('change', event => { markDirty(event); const entry = controls.find(entry => entry.control.element === event.target || entry.control.element.contains(event.target)); if (!entry || entry.disabled) return; const runtime = clientRuntime, ready = clientReady; clientChanges = clientChanges.catch(() => {}).then(async () => { await ready; if (runtime !== clientRuntime) return; captureDraft(); await runtime?.dispatch('onchange', entry.name); refreshCommandRules('form'); }); clientChanges.catch(error => notice(error.message, true)); }); content.append(form);
  recordCard.title = selectedForm.source === 'solution' ? 'Exported solution form · unsupported controls remain read-only.' : 'Form generated from available metadata.';
  const initializing = !clientRuntime;
  if (initializing) clientRuntime = createShellClient(selectedForm);
  const runtime = clientRuntime;
  const ready = Promise.all(controls.map(entry => entry.control.ready));
  if (initializing && catalogue.clientExtensions?.trusted === true) clientReady = ready.then(() => runtime.prepare()).then(() => runtime.dispatch('onload'));
  else await ready;
  await clientReady;
  if (runtime !== clientRuntime || renderGeneration !== generation) return;
  for (const [name, states] of clientControlState) for (const [key, value] of states) applyControlState(name, key, value);
  renderCommands('form');
}
function renderFieldControl(cell, field, disabled) {
  return renderControl(field, record[field.name], { disabled, tables: catalogue.tables, lookup,
    pcf: cell.pcf, clientExtensions: catalogue.clientExtensions, record, fields: table.fields, entity: table.entity, recordId: record[table.idColumn], webAPI: () => clientRuntime?.Xrm.WebApi,
    formatted: record[field.name + '@OData.Community.Display.V1.FormattedValue'], logicalName: record[field.name + '@Microsoft.Dynamics.CRM.lookuplogicalname'] });
}
function applyControlState(name, key, value) {
  const entry = controls.find(entry => entry.controlName === name); if (!entry) return;
  if (key === 'hidden') entry.wrapper.hidden = value;
  else if (key === 'label') { entry.label.textContent = value; (entry.control.primary ?? entry.control.element).setAttribute('aria-label', value); }
  else if (key === 'focus') (entry.control.primary ?? entry.control.element).focus();
  else if (key === 'required') (entry.control.primary ?? entry.control.element).required = value === 'required';
  else if (key === 'disabled') {
    // Client scripts can restrict a control, never enable a field denied by its source or staff policy.
    entry.disabled = Boolean(value || entry.cell.disabled || table.fields[entry.name]?.isPrimaryId || !capability(record?.[table.idColumn] ? 'update' : 'create') || recordCapabilities?.fields?.[entry.name]?.[record?.[table.idColumn] ? 'update' : 'create'] === false || table.fields[entry.name]?.[record?.[table.idColumn] ? 'validForUpdate' : 'validForCreate'] === false);
    if (entry.control.setDisabled) entry.control.setDisabled(entry.disabled);
    else for (const node of [entry.control.element, ...entry.control.element.querySelectorAll('input,textarea,select,button')]) if ('disabled' in node) node.disabled = entry.disabled;
  } else if (key.startsWith('notification:')) {
    const id = key.slice(13); let message = [...entry.wrapper.querySelectorAll('[data-client-notification]')].find(element => element.dataset.clientNotification === id);
    if (value == null) message?.remove(); else { if (!message) { message = document.createElement('p'); message.className = 'unsupported'; message.dataset.clientNotification = id; entry.wrapper.append(message); } message.textContent = value; }
    const primary = entry.control.primary ?? (entry.control.element.matches('input,select,textarea') ? entry.control.element : entry.control.element.querySelector('input,select,textarea'));
    const messages = [...clientControlState.get(name) ?? []].filter(([key, value]) => key.startsWith('notification:') && value != null).map(([, value]) => value);
    primary?.setCustomValidity?.(messages.join('\n'));
  }
}
function createShellClient(selectedForm) {
  const cells = selectedForm.tabs.flatMap(tab => tab.sections.flatMap(section => section.fields)).filter(cell => cell.name && cell.supported);
  const controlName = cell => cell.sourceControl?.id ?? cell.name;
  const runtime = createFormClientRuntime({ table, tables: catalogue.tables, form: selectedForm, record: record ?? {}, extensions: catalogue.clientExtensions,
    read: name => { const entry = controls.find(entry => entry.name === name); return entry?.control.supported ? entry.control.read() : record?.[name]; },
    write: (name, value) => {
      const field = table.fields[name], cell = cells.find(cell => cell.name === name), mode = record?.[table.idColumn] ? 'update' : 'create';
      if (!record || !cell || cell.disabled || field.isPrimaryId || field[mode === 'update' ? 'validForUpdate' : 'validForCreate'] === false || !capability(mode) || recordCapabilities?.fields?.[name]?.[mode] === false) throw new Error(`Column ${name} cannot be changed by this client extension.`);
      record[name] = value; touchedFields.add(name); dirty = true;
      for (const entry of controls.filter(entry => entry.name === name)) {
        if (entry.control.setValue) entry.control.setValue(value);
        else { const replacement = renderFieldControl(entry.cell, { ...field, label: entry.cell.label ?? field.label }, entry.disabled); entry.control.element.replaceWith(replacement.element); entry.control.destroy?.(); entry.control = replacement; }
        for (const [key, state] of clientControlState.get(entry.controlName) ?? []) applyControlState(entry.controlName, key, state);
      }
      if ($('#save-status')) $('#save-status').textContent = ' - Unsaved changes';
    },
    isDirty: name => name ? touchedFields.has(name) : dirty,
    required: (name, value) => { const cell = cells.find(cell => cell.name === name), entry = controls.find(entry => entry.name === name), primary = entry?.control.primary ?? entry?.control.element; if (value !== undefined && cell) { const states = clientControlState.get(controlName(cell)) ?? new Map(); states.set('required', value); clientControlState.set(controlName(cell), states); applyControlState(controlName(cell), 'required', value); } const configured = cell && clientControlState.get(controlName(cell))?.get('required'); return configured !== undefined ? configured === 'required' : primary?.required ?? table.fields[name]?.required; },
    controlNames: name => cells.filter(cell => !name || cell.name === name).map(controlName), controlField: name => cells.find(cell => controlName(cell) === name)?.name,
    controlState: (name, key, value) => { const entry = controls.find(entry => entry.controlName === name); if (value === undefined) return clientControlState.get(name)?.get(key) ?? (key === 'disabled' ? entry?.disabled : key === 'hidden' ? entry?.wrapper.hidden : key === 'label' ? entry?.label.textContent : undefined); const states = clientControlState.get(name) ?? new Map(); states.set(key, value); clientControlState.set(name, states); applyControlState(name, key, value); return true; },
    notification: (message, level, id) => { let element = [...document.querySelectorAll('[data-form-notification]')].find(element => element.dataset.formNotification === id); if (message == null) { element?.remove(); return; } if (!element) { element = document.createElement('p'); element.dataset.formNotification = id; element.setAttribute('role', 'status'); $('#content').prepend(element); } element.className = level === 'ERROR' ? 'unsupported' : 'source-info'; element.textContent = message; },
    request: async (entity, id, options = {}) => { if (!Object.hasOwn(catalogue.tables, entity)) throw new Error(`Table ${entity} is not imported.`); return api(tablePath(entity, id ? String(id).replace(/[{}]/g, '') : undefined) + (options.query ? '?query=' + encodeURIComponent(JSON.stringify(options.query)) : ''), { method: options.method ?? 'GET', ...(options.etag ? { headers: { 'if-match': options.etag } } : {}), ...(options.data ? { body: JSON.stringify(options.data) } : {}) }); },
    save: close => saveRecord(close), refresh: () => loadRoute(), close: () => navigate(table.entity),
    openForm: options => { if (!options || !catalogue.tables[options.entityName]) throw new Error('The target form table is not imported.'); if (options.useQuickCreateForm || options.openInNewWindow) throw new Error('Quick create and separate form windows are not supported locally.'); return navigate(options.entityName, { id: options.entityId ?? 'new' }); },
    alert: (text, title) => new Promise(resolve => { const body = document.createElement('p'); body.textContent = text; const element = dialog(title, body, [['OK', () => { resolve(); closeDialog(); }, true]]); onDialogCancel(element, () => resolve()); }),
    confirm: (text, title) => confirm(title, text),
  });
  globalThis.Xrm = runtime.Xrm; return runtime;
}
function renderSubgrid(cell) {
  const panel = document.createElement('section'); panel.className = 'related-grid';
  const target = catalogue.tables[cell.subgrid.entity], parentId = record[table.idColumn];
  const label = cell.label?.trim() || target?.label || 'Related records';
  const heading = document.createElement('h3'); heading.textContent = label;
  const headingRow = document.createElement('div'); headingRow.className = 'subgrid-heading'; headingRow.append(heading); panel.append(headingRow);
  const unavailable = message => { const text = document.createElement('p'); text.className = 'unsupported'; text.textContent = message; panel.append(text); return panel; };
  if (!parentId) return unavailable('Save this record to view related records.');
  if (!target) return unavailable('The related table metadata is unavailable.');
  const candidates = Object.values(target.fields).filter(field => field.type === 'lookup' && field.targets?.includes(table.entity));
  if (candidates.length !== 1) return unavailable('The related table has no unambiguous exported lookup to this record.');
  const field = candidates[0].name;
  const view = target.views.find(view => view.id === cell.subgrid.view);
  if (!view) return unavailable('The exported subgrid view is unavailable.');
  let page = 1, sort, direction = 'asc', sequence = 0, timer;
  const lifetime = formLifetime;
  lifetime.signal.addEventListener('abort', () => { clearTimeout(timer); sequence++; }, { once: true });
  const selectedRelated = new Set();
  const toolbar = document.createElement('div'), results = document.createElement('div'), footer = document.createElement('div'); footer.className = 'grid-footer'; results.className = 'related-results';
  const newRelated = button(`New ${target.singular}`, () => navigate(target.entity, { id: 'new', defaults: { [field]: parentId } }), { iconName: 'add', disabled: target.capabilities?.create === false, title: target.capabilities?.create === false ? capabilityReason(target.capabilities) : undefined }); newRelated.dataset.action = 'new-related';
  const deleteRelated = button('Delete', async () => {
    if (!await confirm('Delete local records', `Delete ${selectedRelated.size} selected related records from this Mirage instance?`, 'Delete')) return;
    for (const id of selectedRelated) {
      const found = await api(tablePath(target.entity, id));
      await api(tablePath(target.entity, id), { method: 'DELETE', headers: { 'if-match': found.etag } });
    }
    catalogue = await api(); await load();
  }); deleteRelated.hidden = true;
  toolbar.append(newRelated, deleteRelated, button('Refresh', load, { iconName: 'refresh' }), button('Flow', null, { disabled: true, chevron: true, title: 'Flow is not supported locally.' }), button('More commands', null, { disabled: true, iconOnly: true, iconName: 'more' })); headingRow.append(toolbar);
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Filter by keyword'; search.setAttribute('aria-label', `Filter ${label} by keyword`);
  if (cell.subgrid.searchEnabled) { const searchRow = document.createElement('div'); searchRow.className = 'subgrid-search'; const searchBox = document.createElement('div'); searchBox.className = 'search-box'; searchBox.innerHTML = icon('search'); searchBox.append(search); searchRow.append(searchBox); panel.append(searchRow); search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(load), 250); }); }
  panel.append(results, footer);
  async function load() {
    const token = ++sequence;
    if (!panel.isConnected || lifetime.signal.aborted) return;
    results.setAttribute('aria-busy', 'true'); results.inert = true;
    footer.textContent = 'Loading related records…';
    try {
      const result = await api(tablePath(target.entity) + '?query=' + encodeURIComponent(JSON.stringify({ view: view.id, search: search.value, filters: [{ field, operator: 'eq', value: parentId }], pageSize: cell.subgrid.pageSize, page, sort, direction })));
      if (!panel.isConnected || token !== sequence) return;
      selectedRelated.clear(); deleteRelated.hidden = true;
      results.replaceChildren(); const grid = document.createElement('table'); grid.setAttribute('aria-label', label);
      const columnGroup = document.createElement('colgroup'), selectionColumn = document.createElement('col'); selectionColumn.className = 'selection-column'; columnGroup.append(selectionColumn);
      const weights = result.columns.map(name => view.fields.find(field => field.name === name)?.width ?? 150), total = weights.reduce((sum, width) => sum + width, 0);
      for (const width of weights) { const column = document.createElement('col'); column.style.width = `${width / total * 100}%`; columnGroup.append(column); } grid.append(columnGroup);
      const head = document.createElement('thead'), headings = document.createElement('tr'), selectHeading = document.createElement('th'); selectHeading.className = 'selection';
      const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', `Select all ${label}`); selectHeading.append(all); headings.append(selectHeading);
      for (const name of result.columns) {
        const th = document.createElement('th'), arrow = result.sort === name ? result.direction === 'desc' ? ' ↓' : ' ↑' : '';
        th.append(button((target.fields[name]?.label ?? name) + arrow, () => { direction = result.sort === name && result.direction !== 'desc' ? 'desc' : 'asc'; sort = name; return load(); }, { chevron: true, disabled: !target.fields[name] })); headings.append(th);
      }
      head.append(headings); grid.append(head);
      const body = document.createElement('tbody');
      const updateSelection = () => { deleteRelated.hidden = !selectedRelated.size; deleteRelated.disabled = result.capabilities?.delete === false || [...selectedRelated].some(id => result.rowCapabilities?.[id]?.delete === false || target.protectedIds?.includes(id)); deleteRelated.title = deleteRelated.disabled ? capabilityReason(result.capabilities ?? target.capabilities) : ''; all.checked = Boolean(result.rows.length && selectedRelated.size === result.rows.length); all.indeterminate = selectedRelated.size > 0 && !all.checked; };
      for (const row of result.rows) {
        const tr = document.createElement('tr');
        const id = String(row[target.idColumn]), selection = document.createElement('td'); selection.className = 'selection';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', `Select ${display(row[target.nameColumn]) || id}`);
        checkbox.addEventListener('change', () => { if (checkbox.checked) selectedRelated.add(id); else selectedRelated.delete(id); tr.classList.toggle('selected', checkbox.checked); updateSelection(); }); selection.append(checkbox); tr.append(selection);
        for (const [index, name] of result.columns.entries()) { const td = document.createElement('td'), text = display(row[name], target.fields[name], row, name); if (name === target.nameColumn || index === 0) td.append(button(text || '(No name)', () => navigate(target.entity, { id: row[target.idColumn] }), { className: 'link' })); else td.textContent = text; tr.append(td); }
        body.append(tr);
      }
      all.addEventListener('change', () => { selectedRelated.clear(); for (const [index, row] of result.rows.entries()) { if (all.checked) selectedRelated.add(String(row[target.idColumn])); const tr = body.children[index]; tr.classList.toggle('selected', all.checked); tr.querySelector('input').checked = all.checked; } updateSelection(); });
      if (!result.rows.length) { const empty = document.createElement('p'); empty.textContent = 'No related records.'; results.append(empty); }
      else { grid.append(body); results.append(grid); }
      footer.replaceChildren(document.createTextNode(`Rows: ${result.total >= 0 ? result.total : result.rows.length}`));
      if (result.more || page > 1) footer.append(button('‹ Previous related records', () => { page--; return load(); }, { disabled: page === 1 }), button('Next related records ›', () => { page++; return load(); }, { disabled: !result.more }));
    } catch (error) { if (panel.isConnected && token === sequence) { footer.textContent = error.message + ' '; footer.append(button('Try again', load)); } }
    finally { if (panel.isConnected && token === sequence) { results.setAttribute('aria-busy', 'false'); results.inert = false; } }
  }
  queueMicrotask(() => run(load));
  return panel;
}
function captureDraft() { for (const entry of controls) if (!entry.disabled && entry.control.supported) record[entry.name] = entry.control.read(); }
async function saveRecord(close) {
  if (requestingSave) return;
  requestingSave = true;
  const form = $('#record-form'), status = $('#save-status'), saveGeneration = generation;
  if (form) form.inert = true;
  if (status) { status.textContent = ' - Saving…'; status.setAttribute('role', 'status'); }
  $('#commands').classList.add('busy');
  $('#commands').setAttribute('aria-busy', 'true');
  try { await persistRecord(close); }
  finally {
    requestingSave = false;
    if (saveGeneration === generation) {
      $('#commands').classList.remove('busy'); $('#commands').setAttribute('aria-busy', 'false');
      if (form?.isConnected) form.inert = false;
      if (status?.isConnected) status.textContent = ' - ' + (dirty ? 'Unsaved changes' : record?.[table.idColumn] ? 'Saved' : 'New record');
    }
  }
}
async function persistRecord(close) {
  const saveGeneration = generation;
  await clientReady; await clientChanges;
  if (saveGeneration !== generation) return;
  const save = await clientRuntime?.dispatch('onsave', undefined, close ? 2 : 1); if (save?.prevented) { notice('Save cancelled by the exported form event.'); return; }
  if (saveGeneration !== generation) return;
  if (pending || !capability(record?.[table.idColumn] ? 'update' : 'create')) return;
  const form = $('#record-form'); form.inert = false;
  if (!form.reportValidity()) return;
  form.inert = true;
  notice('');
  captureDraft();
  const existing = Boolean(record[table.idColumn]), values = {};
  // Send editable fields across all tabs; disabled/system fields never enter writes.
  const layoutFields = new Map(table.forms.find(form => form.id === formId)?.tabs.flatMap(tab => tab.sections.flatMap(section => section.fields)).filter(field => field.supported && !field.disabled).map(field => [field.name, field]) ?? []);
  for (const [name, value] of Object.entries(record)) {
    const field = table.fields[name], mode = existing ? 'update' : 'create'; if ((!existing || touchedFields.has(name)) && field && hasControl(field) && !field.isPrimaryId && field[existing ? 'validForUpdate' : 'validForCreate'] !== false && recordCapabilities?.fields?.[name]?.[mode] !== false && layoutFields.has(name)) values[name] = value;
  }
  if (existing && !Object.keys(values).length) { dirty = false; touchedFields.clear(); if (close) await navigate(table.entity); else notice('No record changes to save.'); return; }
  pending = true; $('#commands').classList.add('busy');
  try {
    const result = await api(tablePath(table.entity, existing ? record[table.idColumn] : undefined), { method: existing ? 'PATCH' : 'POST', headers: existing ? { 'if-match': etag } : {}, body: JSON.stringify(values) });
    if (saveGeneration !== generation) return;
    dirty = false; touchedFields.clear(); record = result.row; etag = result.etag;
    const refreshed = await api(); if (saveGeneration !== generation) return;
    catalogue = refreshed; table = catalogue.tables[table.entity];
    await navigate(table.entity, close ? {} : { id: record[table.idColumn], replace: true }); notice('Record saved locally.');
  } finally { pending = false; }
}
async function deleteRecords(rows) {
  if (!rows.length || pending || requestingSave) return;
  const entity = table.entity, deleteGeneration = generation;
  if (!await confirm('Delete local records', `Delete ${rows.length} selected record${rows.length === 1 ? '' : 's'} from this Mirage instance?`, 'Delete')) return;
  if (deleteGeneration !== generation) return;
  let deleted = 0; pending = true; contentLoading(`Deleting ${rows.length} local record${rows.length === 1 ? '' : 's'}…`);
  try {
    for (const row of rows) { await api(tablePath(entity, row.id), { method: 'DELETE', headers: { 'if-match': row.etag } }); deleted++; }
    if (deleteGeneration !== generation) return;
    dirty = false; catalogue = await api(); table = catalogue.tables[table.entity]; await navigate(table.entity); notice(`${deleted} record${deleted === 1 ? '' : 's'} deleted locally.`);
  } catch (error) { throw new Error(`${deleted} record${deleted === 1 ? '' : 's'} deleted. ${error.message}`); }
  finally { pending = false; if (deleteGeneration === generation) contentLoaded(); }
}
async function loadRoute() {
  disposeClient();
  dirty = false; touchedFields.clear(); notice('');
  const params = new URLSearchParams(location.search), application = params.get('appname') ?? params.get('appid');
  app = application ? catalogue.apps.find(app => app.id === application || app.uniqueName === application) : catalogue.apps.find(app => app.id === catalogue.defaultApp);
  if (!app) throw new Error('This application is not imported. Choose an available application above.');
  $('#apps').value = app.uniqueName ?? app.id; $('#source-label').textContent = app.name ?? app.uniqueName;
  const entity = params.get('etn') ?? firstEntity(app); table = catalogue.tables[entity];
  if (!table) throw new Error('No table metadata is available for this application. Import its solution and local mappings.');
  renderNavigation(); record = null; recordCapabilities = undefined; current = null; etag = null;
  if (params.get('pagetype') === 'entityrecord') await loadRecord(params.get('id'));
  else {
    const availableViews = appViews(), requestedView = params.get('viewid');
    const view = availableViews.find(view => view.id === requestedView)?.id ?? availableViews.find(view => view.isDefault)?.id ?? availableViews[0].id;
    query = { view, page: 1, pageSize: 50, ...storage.get(`view.${app.uniqueName}.${entity}.${view}`, {}) };
    await loadGrid(); remember({ label: table.label, app: app.uniqueName, url: targetUrl(entity, { view }) });
  }
}
$('#collapse').addEventListener('click', () => { $('#sidebar').classList.toggle('collapsed'); $('#collapse').setAttribute('aria-expanded', String(!$('#sidebar').classList.contains('collapsed'))); });
for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);
$('#apps').addEventListener('change', () => run(async () => { const destination = catalogue.apps.find(app => (app.uniqueName ?? app.id) === $('#apps').value); await navigate(firstEntity(destination), { application: destination }); }));
window.addEventListener('popstate', () => run(async () => { if (await canLeave()) await loadRoute(); else history.forward(); }));
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
$('#staff-profile').addEventListener('click', () => runButton($('#staff-profile'), staffProfile));
let checkingStaff = false;
window.addEventListener('focus', () => run(async () => {
  if (!catalogue || checkingStaff) return;
  checkingStaff = true;
  try {
    const previous = JSON.stringify(staffSession?.current); await loadStaffSession();
    if (previous === JSON.stringify(staffSession?.current)) return;
    generation++; disposeClient();
    if (dirty) { for (const element of document.querySelectorAll('#record-form input,#record-form select,#record-form textarea,#record-form button,#commands button')) element.disabled = true; notice('The staff session changed in another tab. Reload or choose a profile to discard this draft before continuing.', true); return; }
    $('#commands').replaceChildren(); $('#content').replaceChildren(); $('#navigation').replaceChildren();
    if (staffSession) { catalogue = await api(); await loadRoute(); }
  } finally { checkingStaff = false; }
}));
async function initialize() {
  contentLoading('Loading application and staff identity…');
  try {
    await loadStaffSession();
    const response = await fetch('/_sim/api/status');
    if (response.ok) { const status = await response.json(); const portal = $('#open-portal'); portal.hidden = status.capabilities?.powerPages === false; if (status.links?.powerPages) portal.href = status.links.powerPages; }
    catalogue = await api();
    $('#apps').replaceChildren();
    for (const application of catalogue.apps) $('#apps').add(new Option(application.name ?? application.uniqueName, application.uniqueName ?? application.id));
    await loadRoute();
  } catch (error) { loadFailed(error, initialize); }
}
await initialize();
