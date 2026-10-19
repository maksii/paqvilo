import { renderControl, hasControl } from './controls.mjs';
import { icon, navigationIcon } from './icons.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const csrf = $('meta[name="mirage-csrf"]').content;
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem('mirage.apps.' + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('mirage.apps.' + key, JSON.stringify(value)); } catch { /* Session remains usable when browser storage is unavailable. */ } },
};
let catalogue, app, table, current, query = {}, selected = new Set(), record, etag, formId, activeTab, controls = [], dirty = false, pending = false, generation = 0, tabObserver;
let recent = storage.get('recent', []), pinned = storage.get('pinned', []);
const notice = (text, error = false) => { const element = $('#notice'); element.textContent = text; element.hidden = !text; element.classList.toggle('error', error); };
async function api(path = '', options = {}) {
  const response = await fetch('/_apps/api' + path, { ...options, headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, ...options.headers } });
  const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status}).`); return body;
}
const tablePath = (entity = table.entity, id) => '/tables/' + encodeURIComponent(entity) + (id ? '/' + encodeURIComponent(id) : '');
function button(label, action, { disabled = false, title, className = '', iconName, iconOnly = false, chevron = false } = {}) {
  const iconForLabel = { '⌂  Home': 'home', '＋ New': 'add', '＋ New related record': 'add', '↻ Refresh': 'refresh', '↻ Refresh related records': 'refresh', '▣ Save': 'save', '← Back': 'back', '▥ Edit columns': 'columns', '▽ Edit filters': 'filter', 'Save & Close': 'saveClose', Delete: 'delete', 'Show Chart': 'chart', 'Visualize this view': 'powerbi', 'Email a Link': 'email', Flow: 'flow', 'Run Report': 'report', Share: 'share', Pin: 'pin', Unpin: 'pin' };
  const text = label.replace(/^(?:⌂\s+|＋\s+|↻\s+|▣\s+|←\s+|▥\s+|▽\s+)/, '');
  const graphic = iconName ?? iconForLabel[label];
  const element = document.createElement('button'); element.type = 'button'; element.innerHTML = (graphic ? icon(graphic) : '') + (iconOnly ? '' : `<span>${esc(text)}</span>`) + (chevron ? icon('chevron', 'chevron') : '');
  if (iconOnly) element.setAttribute('aria-label', text);
  element.disabled = disabled; element.className = className; if (title) element.title = title;
  if (action) element.addEventListener('click', () => run(action)); return element;
}
async function run(action) { try { await action(); } catch (error) { notice(error.message, true); } }
function dialog(title, content, actions) {
  const element = $('#dialog'); if (element.open) element.close(); element.replaceChildren();
  const heading = document.createElement('h2'); heading.id = 'dialog-title'; heading.textContent = title;
  const body = document.createElement('div'); body.className = 'dialog-body'; if (typeof content === 'string') body.innerHTML = content; else body.append(content);
  const footer = document.createElement('div'); footer.className = 'dialog-actions';
  element.append(heading, body, footer);
  for (const [name, action, primary] of actions) footer.append(button(name, action, { className: primary ? 'primary' : 'secondary' }));
  element.showModal(); return element;
}
const closeDialog = () => $('#dialog').close();
async function confirm(title, text, yes = 'Continue') {
  return new Promise(resolve => {
    const element = dialog(title, `<p>${esc(text)}</p>`, [['Cancel', () => { closeDialog(); resolve(false); }], [yes, () => { closeDialog(); resolve(true); }, true]]);
    element.addEventListener('cancel', () => resolve(false), { once: true });
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
    commands.append(button('Open in VSCode', null, { iconName: 'vscode', disabled: true, title: 'Opening an external editor is not supported locally.' }), button('▣ Save', () => saveRecord(false)), button('Save & Close', () => saveRecord(true)), button('＋ New', () => navigate(table.entity, { id: 'new' })), button('Deactivate', null, { iconName: 'deactivate', disabled: true, title: 'Record activation commands are not supported locally yet.' }));
    if (record?.[table.idColumn]) commands.append(button('Delete', () => deleteRecords([{ id: record[table.idColumn], etag }]), { disabled: table.protectedIds?.includes(record[table.idColumn]), title: table.protectedIds?.includes(record[table.idColumn]) ? 'The source website cannot be deleted from its own running instance.' : undefined }));
    commands.append(button('↻ Refresh', async () => { if (await canLeave()) await loadRoute(); }), button('Check Access', null, { iconName: 'key', disabled: true, title: 'Staff security roles are not simulated locally.' }), button('Flow', null, { disabled: true, chevron: true, title: 'Flow is not supported locally.' }));
    commands.append(button('More commands', () => { const isPinned = pinned.some(item => item.url === location.pathname + location.search); dialog('Record commands', '<p>Keep this local record in your pinned navigation.</p>', [['Close', closeDialog], [isPinned ? 'Unpin' : 'Pin', () => { const url = location.pathname + location.search; pinned = isPinned ? pinned.filter(item => item.url !== url) : [...pinned, { url, label: record?.[table.nameColumn] ?? table.singular, app: app.uniqueName }]; storage.set('pinned', pinned); closeDialog(); renderNavigation(); }]]); }, { iconName: 'more', iconOnly: true }));
  } else {
    commands.append(button('Show Chart', null, { disabled: true, title: 'Charts are not supported locally yet.' }), button('＋ New', () => navigate(table.entity, { id: 'new' }), { className: 'new-command', title: 'Create a local record' }), button('Delete', async () => {
      const rows = await Promise.all([...selected].map(id => api(tablePath(table.entity, id)).then(value => ({ id, etag: value.etag })))); await deleteRecords(rows);
    }, { disabled: !selected.size || [...selected].some(id => table.protectedIds?.includes(id)) }), button('↻ Refresh', () => loadGrid()));
    commands.append(button('Visualize this view', null, { disabled: true, title: 'Power BI is not supported locally.' }), button('Email a Link', null, { disabled: true, chevron: true, title: 'Email links are not supported locally.' }), button('Flow', null, { disabled: true, chevron: true, title: 'Flow is not supported locally.' }), button('Run Report', null, { disabled: true, chevron: true, title: 'Reports are not supported locally.' }), button('More commands', null, { disabled: true, iconName: 'more', iconOnly: true, title: 'Additional ribbon commands are not supported locally.' }));
  }
  commands.append(button('Share', null, { disabled: true, className: 'share-command', chevron: true, title: 'Sharing is not supported locally.' }));
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
  const token = ++generation; selected = new Set(); renderCommands('grid'); $('#content').setAttribute('aria-busy', 'true');
  try {
    const result = await api(tablePath() + '?query=' + encodeURIComponent(JSON.stringify(query)));
    if (token !== generation) return; current = result; renderGrid();
  } finally { if (token === generation) $('#content').setAttribute('aria-busy', 'false'); }
}
function renderGrid() {
  document.title = `${table.label} ${table.views.find(view => view.id === query.view)?.name ?? ''} - ${app.name} · Mirage`;
  const content = $('#content'); content.replaceChildren(); content.className = 'grid-content';
  const header = document.createElement('div'); header.className = 'grid-header';
  const views = document.createElement('select'); views.className = 'view-select'; views.setAttribute('aria-label', 'View');
  views.title = table.views.find(view => view.id === query.view)?.source === 'solution' ? 'Exported solution view' : 'Generated from available metadata';
  for (const view of table.views) views.add(new Option(view.name, view.id)); views.value = query.view;
  views.addEventListener('change', () => run(() => navigate(table.entity, { view: views.value })));
  header.append(views, button('▥ Edit columns', editColumns), button('▽ Edit filters', editFilters));
  const search = document.createElement('input'); search.type = 'search'; search.className = 'search'; search.placeholder = 'Filter by keyword'; search.setAttribute('aria-label', 'Filter by keyword'); search.value = query.search ?? '';
  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => run(async () => { query.search = search.value; query.page = 1; await loadGrid(); const replacement = $('.search'); replacement?.focus(); }), 300); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { clearTimeout(searchTimer); run(async () => { query.search = search.value; query.page = 1; await loadGrid(); $('.search')?.focus(); }); } });
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
    const element = dialog(`Look up ${field.label}`, body, [['Cancel', () => { closeDialog(); resolve(null); }]]); element.addEventListener('cancel', () => resolve(null), { once: true });
    let timer, sequence = 0;
    async function load() {
      const token = ++sequence, destination = catalogue.tables[target.value]; const found = await api(tablePath(target.value) + '?query=' + encodeURIComponent(JSON.stringify({ search: search.value, columns: [destination.nameColumn], pageSize: 50, view: destination.views.find(view => view.id === 'all')?.id })));
      if (token !== sequence) return; results.replaceChildren();
      for (const row of found.rows) results.append(button(display(row[destination.nameColumn]) || '(No name)', () => { closeDialog(); resolve({ id: row[destination.idColumn], entity: destination.entity, name: display(row[destination.nameColumn]) }); }));
      if (!found.rows.length) results.textContent = 'No matching local records.';
    }
    target.addEventListener('change', () => run(load)); search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(load), 250); }); run(load);
  });
}
async function loadRecord(id) {
  const token = ++generation; $('#content').setAttribute('aria-busy', 'true');
  const result = id ? await api(tablePath(table.entity, id)) : { row: Object.fromEntries(Object.values(table.fields).filter(field => field.defaultValue !== undefined).map(field => [field.name, field.defaultValue])) };
  if (token !== generation) return; record = result.row;
  if (!id) for (const [name, value] of new URLSearchParams(new URLSearchParams(location.search).get('extraqs') ?? '')) {
    const field = Object.hasOwn(table.fields, name) ? table.fields[name] : null;
    if (field && !field.isPrimaryId && field.validForCreate !== false && hasControl(field)) record[name] = field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === 'true' : value;
  }
  etag = result.etag; formId = table.forms[0]?.id; activeTab = null; renderRecord();
  if (id) remember({ label: record[table.nameColumn] ?? table.singular, url: location.pathname + location.search, app: app.uniqueName });
  $('#content').setAttribute('aria-busy', 'false');
}
function renderRecord() {
  tabObserver?.disconnect();
  const content = $('#content'); content.replaceChildren(); content.className = 'record-content'; controls = [];
  const existing = Boolean(record[table.idColumn]);
  document.title = `${existing ? record[table.nameColumn] ?? table.singular : 'New ' + table.singular} - ${app.name} · Mirage`;
  renderCommands('form');
  const recordCard = document.createElement('div'); recordCard.className = 'record-card'; content.append(recordCard);
  const header = document.createElement('div'); header.className = 'record-header'; header.innerHTML = `<div><div class="record-title"><h1>${esc(existing ? record[table.nameColumn] ?? '(No name)' : 'New ' + table.singular)}</h1><span class="record-saved" id="save-status"> - ${dirty ? 'Unsaved changes' : existing ? 'Saved' : 'New record'}</span></div><small>${esc(table.singular)}</small></div>`;
  recordCard.append(header);
  let selectedForm = table.forms.find(form => form.id === formId) ?? table.forms[0];
  if (table.forms.length > 1) { const chooser = document.createElement('select'); chooser.setAttribute('aria-label', 'Record form'); chooser.className = 'form-chooser'; for (const form of table.forms) chooser.add(new Option(form.name, form.id)); chooser.value = selectedForm.id; chooser.addEventListener('change', () => { captureDraft(); formId = chooser.value; renderRecord(); }); header.append(chooser); }
  if (selectedForm.hasScripts) { const warning = document.createElement('span'); warning.className = 'script-indicator'; warning.textContent = 'Local scripts disabled'; warning.title = 'This exported form references scripts or events. Their behavior is not executed locally.'; header.append(warning); }
  const tabs = document.createElement('div'); tabs.className = 'tabs'; tabs.setAttribute('role', 'tablist');
  const availableTabs = selectedForm.tabs.filter(tab => tab.visible !== false);
  activeTab = availableTabs.some(tab => tab.id === activeTab) ? activeTab : availableTabs[0]?.id;
  const chooseTab = tab => { captureDraft(); activeTab = tab.id; renderRecord(); };
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
      if (cell.visible === false) continue;
      const position = element => { if (cell.column !== undefined) element.style.gridColumn = `${cell.column + 1} / span ${Math.min(cell.colspan ?? 1, section.columns ?? 1)}`; if (cell.row !== undefined) element.style.gridRow = String(cell.row + 1); fields.append(element); };
      if (cell.subgrid) { position(renderSubgrid(cell)); continue; }
      if (!cell.supported || !table.fields[cell.name]) { const unsupported = document.createElement('p'); unsupported.className = 'unsupported'; unsupported.textContent = `${cell.label ?? 'Control'}: ${cell.reason ?? 'Unsupported control'}`; position(unsupported); continue; }
      const field = { ...table.fields[cell.name], label: cell.label ?? table.fields[cell.name].label };
      const disabled = cell.disabled || field.isPrimaryId || field[existing ? 'validForUpdate' : 'validForCreate'] === false;
      const wrapper = document.createElement('div'); wrapper.className = 'field'; const label = document.createElement('label'); label.htmlFor = 'field-' + field.name; label.textContent = field.label; if (field.required) { const required = document.createElement('span'); required.className = 'required'; required.setAttribute('aria-hidden', 'true'); required.textContent = '*'; label.append(required); }
      if (cell.showLabel === false) label.className = 'sr-only';
      const control = renderControl(field, record[field.name], { disabled, tables: catalogue.tables, lookup, formatted: record[field.name + '@OData.Community.Display.V1.FormattedValue'] }); wrapper.append(label, control.element); position(wrapper); controls.push({ name: field.name, control, disabled });
    }
    columns[Math.max(0, section.column ?? 0)]?.append(panel);
  }
  const markDirty = () => { dirty = true; notice(''); $('#save-status').textContent = ' - Unsaved changes'; };
  form.addEventListener('input', markDirty); form.addEventListener('change', markDirty); content.append(form);
  recordCard.title = selectedForm.source === 'solution' ? 'Exported solution form · unsupported controls remain read-only.' : 'Form generated from available metadata.';
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
  let page = 1, sort, direction = 'asc';
  const selectedRelated = new Set();
  const toolbar = document.createElement('div'), results = document.createElement('div'), footer = document.createElement('div'); footer.className = 'grid-footer'; results.className = 'related-results';
  const newRelated = button(`New ${target.singular}`, () => navigate(target.entity, { id: 'new', defaults: { [field]: parentId } }), { iconName: 'add' }); newRelated.dataset.action = 'new-related';
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
  if (cell.subgrid.searchEnabled) { const searchRow = document.createElement('div'); searchRow.className = 'subgrid-search'; const searchBox = document.createElement('div'); searchBox.className = 'search-box'; searchBox.innerHTML = icon('search'); searchBox.append(search); searchRow.append(searchBox); panel.append(searchRow); let timer; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(load), 250); }); }
  panel.append(results, footer);
  async function load() {
    const result = await api(tablePath(target.entity) + '?query=' + encodeURIComponent(JSON.stringify({ view: view.id, search: search.value, filters: [{ field, operator: 'eq', value: parentId }], pageSize: cell.subgrid.pageSize, page, sort, direction })));
    if (!panel.isConnected) return;
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
    const updateSelection = () => { deleteRelated.hidden = !selectedRelated.size; all.checked = Boolean(result.rows.length && selectedRelated.size === result.rows.length); all.indeterminate = selectedRelated.size > 0 && !all.checked; };
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
  }
  queueMicrotask(() => run(load));
  return panel;
}
function captureDraft() { for (const entry of controls) if (!entry.disabled && entry.control.supported) record[entry.name] = entry.control.read(); }
async function saveRecord(close) {
  if (pending || !$('#record-form').reportValidity()) return;
  notice('');
  captureDraft();
  const existing = Boolean(record[table.idColumn]), values = {};
  // Send editable fields across all tabs; disabled/system fields never enter writes.
  const layoutFields = new Map(table.forms.find(form => form.id === formId)?.tabs.flatMap(tab => tab.sections.flatMap(section => section.fields)).filter(field => field.supported && !field.disabled).map(field => [field.name, field]) ?? []);
  for (const [name, value] of Object.entries(record)) {
    const field = table.fields[name]; if (field && hasControl(field) && !field.isPrimaryId && field[existing ? 'validForUpdate' : 'validForCreate'] !== false && layoutFields.has(name)) values[name] = value;
  }
  pending = true; $('#commands').classList.add('busy');
  try {
    const result = await api(tablePath(table.entity, existing ? record[table.idColumn] : undefined), { method: existing ? 'PATCH' : 'POST', headers: existing ? { 'if-match': etag } : {}, body: JSON.stringify(values) });
    dirty = false; record = result.row; etag = result.etag;
    catalogue = await api(); table = catalogue.tables[table.entity];
    await navigate(table.entity, close ? {} : { id: record[table.idColumn], replace: true }); notice('Record saved locally.');
  } finally { pending = false; $('#commands').classList.remove('busy'); }
}
async function deleteRecords(rows) {
  if (!rows.length) return;
  if (!await confirm('Delete local records', `Delete ${rows.length} selected record${rows.length === 1 ? '' : 's'} from this Mirage instance?`, 'Delete')) return;
  let deleted = 0;
  try {
    for (const row of rows) { await api(tablePath(table.entity, row.id), { method: 'DELETE', headers: { 'if-match': row.etag } }); deleted++; }
    dirty = false; catalogue = await api(); table = catalogue.tables[table.entity]; await navigate(table.entity); notice(`${deleted} record${deleted === 1 ? '' : 's'} deleted locally.`);
  } catch (error) { notice(`${deleted} records deleted. ${error.message}`, true); throw error; }
}
async function loadRoute() {
  dirty = false; notice('');
  const params = new URLSearchParams(location.search), application = params.get('appname') ?? params.get('appid');
  app = application ? catalogue.apps.find(app => app.id === application || app.uniqueName === application) : catalogue.apps.find(app => app.id === catalogue.defaultApp);
  if (!app) throw new Error('This application is not imported. Choose an available application above.');
  $('#apps').value = app.uniqueName ?? app.id; $('#source-label').textContent = app.name ?? app.uniqueName;
  const entity = params.get('etn') ?? firstEntity(app); table = catalogue.tables[entity];
  if (!table) throw new Error('No table metadata is available for this application. Import its solution and local mappings.');
  renderNavigation(); record = null; etag = null;
  if (params.get('pagetype') === 'entityrecord') await loadRecord(params.get('id'));
  else {
    const view = params.get('viewid') ?? table.views.find(view => view.isDefault)?.id ?? table.views[0].id;
    query = { view, page: 1, pageSize: 50, ...storage.get(`view.${app.uniqueName}.${entity}.${view}`, {}) };
    await loadGrid(); remember({ label: table.label, app: app.uniqueName, url: targetUrl(entity, { view }) });
  }
}
$('#collapse').addEventListener('click', () => { $('#sidebar').classList.toggle('collapsed'); $('#collapse').setAttribute('aria-expanded', String(!$('#sidebar').classList.contains('collapsed'))); });
for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);
$('#apps').addEventListener('change', () => run(async () => { const destination = catalogue.apps.find(app => (app.uniqueName ?? app.id) === $('#apps').value); await navigate(firstEntity(destination), { application: destination }); }));
window.addEventListener('popstate', () => run(async () => { if (await canLeave()) await loadRoute(); else history.forward(); }));
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
await run(async () => {
  catalogue = await api();
  for (const application of catalogue.apps) $('#apps').add(new Option(application.name ?? application.uniqueName, application.uniqueName ?? application.id));
  await loadRoute();
});
