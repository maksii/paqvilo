import { createLookupDialog } from './lookup-dialog.mjs';
import { renderControl, hasControl } from './controls.mjs';
import { icon, navigationIcon, columnIcon } from './icons.mjs';
import { createFormClientRuntime, evaluateRibbonRules } from './client-runtime.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const csrf = $('meta[name="mirage-csrf"]').content;
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem('mirage.apps.' + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('mirage.apps.' + key, JSON.stringify(value)); } catch { /* Session remains usable when browser storage is unavailable. */ } },
};
let catalogue, app, table, current, query = {}, selected = new Set(), record, recordCapabilities, etag, formId, activeTab, activeArea, activeNavigationItem, controls = [], dirty = false, pending = false, generation = 0, tabObserver, commandObserver, staffIdentity, staffSession, staffSessionError = '';
let recent = storage.get('recent', []), pinned = storage.get('pinned', []);
let touchedFields = new Set();
let loadedFormType = 1;
let clientRuntime, clientReady = Promise.resolve(), clientChanges = Promise.resolve(), requestingSave = false;
let gridSearchTimer, dialogLifetime, formLifetime, dismissPicker;
const clientControlState = new Map();
const formCellLayouts = new WeakMap();
function setFieldLock(label, locked) {
  let lock = label.querySelector('.field-lock');
  if (!locked) { lock?.remove(); return; }
  if (!lock) { lock = document.createElement('span'); lock.className = 'field-lock'; lock.setAttribute('aria-hidden', 'true'); lock.innerHTML = icon('lock'); label.append(lock); }
}
function reflowSectionFields(host) {
  if (!host || ![...host.children].some(element => formCellLayouts.get(element)?.row !== undefined)) return;
  const rows = [...new Set([...host.children].filter(element => !element.hidden && !formCellLayouts.get(element)?.spacer).map(element => formCellLayouts.get(element)?.row).filter(row => row !== undefined))].sort((left, right) => left - right);
  for (const element of host.children) {
    const cell = formCellLayouts.get(element); if (!cell || cell.row === undefined) continue;
    if (cell.spacer) element.hidden = cell.visible === false || !rows.includes(cell.row);
    const row = rows.indexOf(cell.row); if (row < 0) continue;
    const span = Math.max(1, rows.filter(index => index >= cell.row && index < cell.row + (cell.rowspan ?? 1)).length);
    element.style.gridRow = `${row + 1}${span > 1 ? ` / span ${span}` : ''}`;
  }
}
const disposeControls = () => { for (const entry of controls) entry.control.destroy?.(); controls = []; };
function disposeClient() { dismissPicker?.(false); clearTimeout(gridSearchTimer); formLifetime?.abort(); tabObserver?.disconnect(); clientRuntime?.destroy(); clientRuntime = undefined; clientControlState.clear(); $('#form-notifications')?.remove(); $('#record-status')?.remove(); disposeControls(); clientReady = Promise.resolve(); clientChanges = Promise.resolve(); }
const notice = (text, error = false) => { const element = $('#notice'); element.textContent = text; element.hidden = !text; element.classList.toggle('error', error); };
function contentLoading(text) {
  document.documentElement.dataset.mirageAppState = 'loading';
  notice('');
  let status = $('#app-loading');
  if (!status) { status = document.createElement('div'); status.id = 'app-loading'; status.className = 'app-loading'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); $('#workspace').append(status); }
  status.textContent = text;
  $('#content').setAttribute('aria-busy', 'true'); $('#content').inert = true; $('#commands').inert = true; $('#commands').classList.remove('busy'); $('#commands').setAttribute('aria-busy', 'true');
}
function contentLoaded() { document.documentElement.dataset.mirageAppState = 'ready'; $('#app-loading')?.remove(); $('#content').setAttribute('aria-busy', 'false'); $('#content').inert = false; $('#commands').inert = false; $('#commands').setAttribute('aria-busy', 'false'); }
function loadFailed(error, retry) {
  contentLoaded(); $('#content').inert = true; $('#commands').inert = true;
  document.documentElement.dataset.mirageAppState = 'error';
  notice(error.message, true); $('#notice').append(document.createTextNode(' '), button('Try again', retry));
}
async function api(path = '', options = {}) {
  const response = await fetch('/_apps/api' + path, { ...options, headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, ...options.headers } });
  const body = await response.json();
  if (!response.ok) { const code = body.error?.code, errorCode = typeof code === 'number' ? code : /^0x[\da-f]+$/i.test(code ?? '') ? Number.parseInt(code, 16) : undefined; throw Object.assign(new Error(body.error?.message ?? `Request failed (${response.status}).`), { status: response.status, code, ...(Number.isFinite(errorCode) ? { errorCode } : {}) }); }
  return body;
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
function controlDisabled(cell, field, requested) {
  const mode = record?.[table.idColumn] ? 'update' : 'create';
  return Boolean((requested ?? (loadedFormType === 4 || cell?.disabled)) || field?.isPrimaryId || field?.[mode === 'update' ? 'validForUpdate' : 'validForCreate'] === false || !capability(mode) || recordCapabilities?.fields?.[field?.name]?.[mode] === false);
}
const capabilityReason = source => source?.reason ?? 'Your staff role or the configured DATA ownership does not allow this operation.';
const appComponents = (type, components) => { const ids = new Set((app?.components ?? []).filter(component => component.type === type).map(component => String(component.id ?? '').replace(/[{}]/g, '').toLowerCase())); const matching = components.filter(component => ids.has(String(component.id).replace(/[{}]/g, '').toLowerCase())); return matching.length ? matching : components; };
const appForms = () => appComponents(60, table.forms);
const preferredFormKey = () => `form.${app.id}.${table.entity}`;
const rememberForm = id => storage.set(preferredFormKey(), id);
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
  dismissPicker?.(false);
  dialogLifetime?.abort(); dialogLifetime = new AbortController();
  const lifetime = dialogLifetime;
  const element = $('#dialog'); if (element.open) element.close(); element.className = ''; element.replaceChildren();
  element.addEventListener('cancel', () => queueMicrotask(() => lifetime.abort()), { once: true, signal: lifetime.signal });
  element.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDialog(); } }, { signal: lifetime.signal });
  const heading = document.createElement('h2'); heading.id = 'dialog-title'; heading.textContent = title;
  const body = document.createElement('div'); body.className = 'dialog-body'; if (typeof content === 'string') body.innerHTML = content; else body.append(content);
  const footer = document.createElement('div'); footer.className = 'dialog-actions';
  element.append(heading, body, footer);
  for (const [name, action, primary] of actions) footer.append(button(name, action, { className: primary ? 'primary' : 'secondary' }));
  element.showModal(); return element;
}
const closeDialog = () => { dismissPicker?.(false); dialogLifetime?.abort(); $('#dialog').close(); };
// Pickers are anchored to the activating control and release document listeners on
// dismissal or route changes. The menu uses roving focus rather than a browser select.
function picker(trigger, choices, { label, selected, choose, search = false, menuClass = '' } = {}) {
  dismissPicker?.(false);
  const lifetime = new AbortController(), menu = document.createElement('div');
  menu.className = `shell-picker ${menuClass}`; menu.id = 'shell-picker'; menu.setAttribute('role', menuClass === 'column-picker' ? 'menu' : 'dialog'); menu.setAttribute('aria-label', search ? 'View Options' : label);
  trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', menu.id);
  const close = (focus = true) => { lifetime.abort(); menu.remove(); trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-controls'); if (dismissPicker === close) dismissPicker = undefined; if (focus && trigger.isConnected) trigger.focus(); };
  dismissPicker = close;
  const list = document.createElement('div'); list.className = 'picker-options'; list.setAttribute('role', menuClass === 'column-picker' ? 'presentation' : 'menu'); if (menuClass !== 'column-picker') list.setAttribute('aria-label', search ? 'Views' : label); menu.append(list);
  const render = (term = '') => {
    list.replaceChildren();
    for (const entry of choices.filter(entry => entry.label.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) {
      const item = button(entry.label, async () => { close(); await choose(entry.value); }, { className: (entry.value === selected ? 'selected ' : '') + (entry.separatorBefore ? 'picker-separator' : ''), disabled: entry.disabled, title: entry.reason });
      item.setAttribute('role', entry.role ?? 'menuitemradio'); if (entry.role !== 'menuitem') item.setAttribute('aria-checked', String(entry.value === selected)); item.tabIndex = -1;
      item.insertAdjacentHTML('afterbegin', `<span class="picker-check">${entry.value === selected ? icon('check', 'picker-item-icon') : ''}</span>${entry.iconName ? icon(entry.iconName) : ''}`); if (entry.isDefault) item.insertAdjacentHTML('beforeend', '<small>Default</small>'); list.append(item);
    }
    if (!list.children.length) { const empty = document.createElement('p'); empty.className = 'picker-empty'; empty.textContent = 'No results found'; list.append(empty); }
  };
  let input;
  if (search) { const box = document.createElement('div'); box.className = 'picker-search'; box.innerHTML = icon('search'); input = document.createElement('input'); input.type = 'search'; input.placeholder = 'Search views'; input.setAttribute('aria-label', 'Search views'); input.addEventListener('input', () => render(input.value)); box.append(input); menu.prepend(box); }
  render(); if (menuClass === 'area-picker') { const heading = document.createElement('div'); heading.className = 'area-picker-title'; heading.textContent = label; menu.prepend(heading); } if (search) { const actions = document.createElement('div'); actions.className = 'picker-actions'; actions.setAttribute('role', 'menu'); actions.setAttribute('aria-label', 'View Actions'); const manage = button('Manage and share views', null, { disabled: true, iconName: 'settings', title: 'View sharing and management are not supported locally.' }); manage.setAttribute('role', 'menuitem'); actions.append(manage); menu.append(actions); } ($('#dialog').open ? $('#dialog') : document.body).append(menu);
  const position = () => { const rect = trigger.getBoundingClientRect(), above = menuClass === 'area-picker'; menu.style.minWidth = `${Math.min(menuClass === 'form-picker' ? 203 : above ? 200 : Math.max(rect.width, 280), innerWidth - 24)}px`; menu.style.maxHeight = `${Math.max(100, above ? rect.top - 12 : innerHeight - rect.bottom - 12)}px`; menu.style.left = `${Math.max(above ? 0 : 12, Math.min(rect.left, innerWidth - menu.offsetWidth - (above ? 0 : 12)))}px`; menu.style.top = `${above ? Math.max(12, rect.top - menu.offsetHeight) : rect.bottom}px`; };
  position();
  menu.addEventListener('keydown', event => {
    const items = [...list.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close(false);
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(false); }, { signal: lifetime.signal });
  window.addEventListener('resize', () => close(false), { signal: lifetime.signal });
  (input ?? list.querySelector('[aria-checked="true"]') ?? list.querySelector('button'))?.focus();
}
function pickerButton(label, choices, options) {
  const trigger = button(label, () => { if (trigger.getAttribute('aria-expanded') === 'true') dismissPicker?.(); else picker(trigger, choices, options); }, { chevron: true, className: options.className ?? '' });
  trigger.setAttribute('aria-label', options.label); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); picker(trigger, choices, options); } });
  return trigger;
}
function chooseApplication() {
  if (!catalogue?.apps?.length) return;
  const body = document.createElement('div'); body.className = 'app-picker-content';
  const toolbar = document.createElement('div'); toolbar.className = 'app-picker-toolbar';
  const searchBox = document.createElement('div'); searchBox.className = 'app-picker-search'; searchBox.innerHTML = icon('search');
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search my apps...'; search.setAttribute('aria-label', 'Search my apps'); searchBox.append(search); toolbar.append(searchBox);
  toolbar.append(button('Create new App', null, { disabled: true, iconName: 'add', title: 'App authoring is not supported locally.' }), button('Refresh', async () => { catalogue = await api(); render(); }, { iconName: 'refresh' }), button('Filter', null, { disabled: true, iconName: 'filter', title: 'Additional application filters are not supported locally.' }));
  const heading = document.createElement('h3'); heading.className = 'app-picker-section';
  const list = document.createElement('div'); list.className = 'app-cards'; list.setAttribute('aria-label', 'Published Apps');
  const status = document.createElement('p'); status.className = 'app-picker-empty'; status.setAttribute('role', 'status');
  const render = () => {
    list.replaceChildren();
    for (const application of catalogue.apps.filter(application => (application.name ?? application.uniqueName ?? application.id).toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))) {
      const card = button('', async () => { closeDialog(); const destination = firstPage(application); await navigate(destination?.entity, { application, view: destination?.view }); }, { className: 'app-card' });
      const name = application.name ?? application.uniqueName ?? application.id;
      card.setAttribute('aria-label', name); if (application.id === app?.id) card.setAttribute('aria-current', 'true');
      card.innerHTML = `<span class="app-card-art">${application.iconUrl?.startsWith('/_apps/resources/') ? `<img src="${esc(application.iconUrl)}" alt="">` : icon('pageGrid')}</span><span class="app-card-info"><strong>${esc(name)}</strong>${application.description ? `<span class="app-card-description">${esc(application.description)}</span>` : ''}<span class="app-card-footer">UNIFIED INTERFACE</span></span>`;
      list.append(card);
    }
    heading.textContent = `Published Apps (${list.children.length})`; status.textContent = list.children.length ? '' : 'No apps found'; status.hidden = Boolean(list.children.length);
  };
  const editing = document.createElement('h3'); editing.className = 'app-picker-section'; editing.textContent = 'Apps Being Edited (0)'; editing.title = 'Local app authoring is not supported.';
  search.addEventListener('input', render); body.append(toolbar, heading, list, status, editing); render();
  const element = dialog('Apps', body, []); element.className = 'app-picker-dialog';
  const close = button('Close', closeDialog, { iconName: 'close', iconOnly: true, className: 'app-picker-close' }); element.prepend(close);
  const expand = button('Expand', () => { element.classList.toggle('expanded'); }, { iconName: 'open', iconOnly: true, className: 'app-picker-expand' }); element.prepend(expand);
  $('#apps').setAttribute('aria-expanded', 'true'); dialogLifetime.signal.addEventListener('abort', () => $('#apps').setAttribute('aria-expanded', 'false'), { once: true }); search.focus();
}
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
const firstPage = application => application.navigation.flatMap(area => area.groups.flatMap(group => group.items)).find(item => item.supported && item.entity);
const firstEntity = application => firstPage(application)?.entity;
function targetUrl(entity, { id, view, application = app, defaults, form } = {}) {
  const params = new URLSearchParams({ appname: application.uniqueName ?? application.id, pagetype: id ? 'entityrecord' : 'entitylist', etn: entity });
  if (id && id !== 'new') params.set('id', id); if (view) params.set('viewid', view);
  if (id && form) params.set('formid', form);
  if (defaults) params.set('extraqs', new URLSearchParams(defaults).toString());
  return '/main.aspx?' + params;
}
function gridSnapshot() { return { application: app.id, entity: table.entity, area: activeArea?.id, navigation: activeNavigationItem?.id, query: structuredClone(query) }; }
async function returnToGrid() {
  const origin = history.state?.returnGrid, application = catalogue.apps.find(app => app.id === origin?.application);
  if (!application || !Object.hasOwn(catalogue.tables, origin?.entity)) return navigate(table.entity);
  return navigate(origin.entity, { application, view: origin.query?.view, area: origin.area, navigation: origin.navigation, grid: origin });
}
async function navigate(entity, { id, view, application = app, replace = false, defaults, form, area, grid, navigation } = {}) {
  if (!await canLeave()) return;
  if (area) storage.set(`area.${application.uniqueName}`, area);
  $('#sidebar').classList.remove('mobile-open'); $('#mobile-navigation').setAttribute('aria-expanded', 'false');
  const origin = current ? gridSnapshot() : history.state?.returnGrid;
  if (current) history.replaceState({ ...history.state, grid: origin }, '', location.href);
  const url = targetUrl(entity, { id, view, application, defaults, form });
  const selectedPage = navigation ?? (application === app && entity === table.entity ? activeNavigationItem?.id : undefined);
  history[replace ? 'replaceState' : 'pushState']({ ...(id ? { returnGrid: origin } : grid ? { grid } : {}), ...(selectedPage ? { navigation: selectedPage } : {}) }, '', url);
  await loadRoute();
}
function remember(entry) {
  recent = [entry, ...recent.filter(item => item.url !== entry.url)].slice(0, 12); storage.set('recent', recent); renderNavigation();
}
function renderNavigation() {
  const nav = $('#navigation'); nav.replaceChildren();
  const home = button('⌂  Home', () => navigate(firstEntity(app), { view: firstPage(app)?.view }), { className: 'quick', title: 'Home' }); home.setAttribute('aria-label', 'Home'); nav.append(home);
  for (const [label, entries] of [['Recent', recent], ['Pinned', pinned]]) {
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.setAttribute('aria-label', label); summary.title = label; summary.innerHTML = icon(label === 'Recent' ? 'recent' : 'pin') + `<span>${label}</span>` + icon('chevron', 'chevron'); details.append(summary);
    const history = document.createElement('div'); history.className = 'navigation-history'; details.append(history);
    for (const entry of entries.filter(entry => entry.app === app.uniqueName)) history.append(button(entry.label, async () => { if (!await canLeave()) return; window.history.pushState({}, '', entry.url); await loadRoute(); }));
    if (!history.querySelector('button')) { const empty = document.createElement('p'); empty.textContent = 'No items yet'; empty.className = 'source-info'; history.append(empty); }
    nav.append(details);
  }
  const routeParams = new URLSearchParams(location.search), requestedView = (routeParams.get('viewid') ?? (!routeParams.has('etn') ? firstPage(app)?.view : undefined))?.replace(/[{}]/g, '').toLowerCase(), view = appViews().find(view => view.id === requestedView)?.id ?? appViews().find(view => view.isDefault)?.id ?? appViews()[0]?.id;
  const areaItems = activeArea?.groups.flatMap(group => group.items) ?? [], activeItem = areaItems.find(item => item === activeNavigationItem) ?? areaItems.find(item => item.supported && item.entity === table?.entity && item.view === view) ?? areaItems.find(item => item.supported && item.entity === table?.entity && !item.view);
  for (const group of activeArea?.groups ?? []) {
    const heading = document.createElement('h2'); heading.textContent = group.title; if (!nav.querySelector('h2')) heading.className = 'first-group'; nav.append(heading);
    for (const item of group.items) {
      const entry = button(item.title, () => { const destinationApp = catalogue.apps.find(application => application.id === item.targetApplicationId) ?? app; return navigate(item.entity, { view: item.view, navigation: item.id, application: destinationApp, ...(destinationApp === app ? { area: activeArea.id } : {}) }); }, { iconName: navigationIcon(item), disabled: !item.supported, title: item.reason ?? item.title, className: item === activeItem ? 'active' : '' });
      entry.setAttribute('aria-label', item.title);
      if (item === activeItem) entry.setAttribute('aria-current', 'page'); nav.append(entry);
    }
  }
  $('#area-selector')?.remove();
  if (app.navigation.length > 1) {
    const footer = document.createElement('div'); footer.id = 'area-selector';
    const choose = pickerButton(activeArea.title, app.navigation.map(area => ({ label: area.title, value: area.id, disabled: !area.groups.some(group => group.items.some(item => item.supported)), reason: 'This area has no imported supported page.' })), { label: 'Change area', selected: activeArea.id, menuClass: 'area-picker', className: 'area-chooser', choose: id => {
      const area = app.navigation.find(area => area.id === id), item = area.groups.flatMap(group => group.items).find(item => item.supported && catalogue.tables[item.entity]);
      return navigate(item?.entity ?? table.entity, { view: item?.view, area: id, navigation: item?.id });
    } });
    const initial = document.createElement('i'); initial.className = 'area-initial'; initial.dataset.initial = activeArea.title.trim().slice(0, 1).toUpperCase(); initial.setAttribute('aria-hidden', 'true'); choose.prepend(initial); footer.append(choose); $('#sidebar').append(footer);
  }
}
function renderCommands(mode) {
  commandObserver?.disconnect();
  const commands = $('#commands'); commands.replaceChildren(); commands.classList.toggle('form-commands', mode === 'form');
  let firstFormAction;
  const separator = () => { const line = document.createElement('span'); line.className = 'separator'; commands.append(line); };
  commands.append(button('Back', mode === 'form' ? returnToGrid : null, { iconName: 'back', iconOnly: true, disabled: mode !== 'form' })); separator();
  if (mode === 'form') {
    commands.append(button('Open in new window', null, { iconName: 'open', iconOnly: true, disabled: true, title: 'Opening a separate record window is not supported locally.' })); separator();
    const canSave = loadedFormType !== 4 && capability(record?.[table.idColumn] ? 'update' : 'create');
    const firstFormActionIndex = commands.children.length;
    commands.append(button('▣ Save', () => saveRecord(false), { disabled: !canSave, title: canSave ? undefined : capabilityReason(recordCapabilities ?? table.capabilities) }), button('Save & Close', () => saveRecord(true), { disabled: !canSave }), button('＋ New', () => navigate(table.entity, { id: 'new' }), { disabled: !capability('create', table.capabilities), title: capability('create', table.capabilities) ? undefined : capabilityReason(table.capabilities) }), button(loadedFormType === 4 ? 'Activate' : 'Deactivate', null, { iconName: 'deactivate', disabled: true, title: 'Record activation commands are not supported locally yet.' }));
    if (loadedFormType === 4) for (const node of [...commands.children]) if (['Save', 'Save & Close'].includes(node.textContent.trim())) node.remove();
    firstFormAction = commands.children[firstFormActionIndex];
    if (record?.[table.idColumn]) commands.append(button('Delete', () => deleteRecords([{ id: record[table.idColumn], etag }]), { disabled: !capability('delete') || table.protectedIds?.includes(record[table.idColumn]), title: table.protectedIds?.includes(record[table.idColumn]) ? 'The source website cannot be deleted from its own running instance.' : !capability('delete') ? capabilityReason(recordCapabilities ?? table.capabilities) : undefined }));
    commands.append(button('↻ Refresh', async () => { if (await canLeave()) await loadRoute(); }), button('Check Access', null, { iconName: 'key', disabled: true, title: 'Access inspection command is not supported locally.' }));
    if (Object.values(table.fields).some(field => field.dataverseType === 'owner')) commands.append(button('Assign', null, { iconName: 'person', disabled: true, title: 'Assigning record ownership is not supported locally.' }));
    commands.append(button('Flow', null, { disabled: true, chevron: true, title: 'Flow is not supported locally.' }), button('Word Templates', null, { iconName: 'pageForm', disabled: true, chevron: true, title: 'Word template generation is not supported locally.' }), button('Run Report', null, { disabled: true, chevron: true, title: 'Reports are not supported locally.' }));
    const recordCommands = () => { const isPinned = pinned.some(item => item.url === location.pathname + location.search); dialog('Record commands', '<p>Keep this local record in your pinned navigation.</p>', [['Close', closeDialog], [isPinned ? 'Unpin' : 'Pin', () => { const url = location.pathname + location.search; pinned = isPinned ? pinned.filter(item => item.url !== url) : [...pinned, { url, label: record?.[table.nameColumn] ?? table.singular, app: app.uniqueName }]; storage.set('pinned', pinned); closeDialog(); renderNavigation(); }]]); };
    const more = button('More commands', () => {
      const hidden = [...commands.querySelectorAll('button[data-command-overflow]')];
      if (!hidden.length) return recordCommands();
      picker(more, [...hidden.map((node, index) => ({ label: node.getAttribute('aria-label') ?? node.textContent.trim(), value: index, role: 'menuitem', disabled: node.disabled, reason: node.title })), { label: 'Record commands', value: 'record', role: 'menuitem', separatorBefore: true }], { label: 'More commands', menuClass: 'column-picker', choose: value => value === 'record' ? recordCommands() : hidden[value]?.click() });
    }, { iconName: 'more', iconOnly: true }); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); commands.append(more);
  } else {
    if (table.grid?.control === 'Microsoft.PowerApps.PowerAppsOneGrid') commands.append(button('Show As', null, { disabled: true, iconName: 'gridModes', chevron: true, title: 'Switching grid visualization modes is not supported locally.' }));
    commands.append(button('Show Chart', null, { disabled: true, title: 'Charts are not supported locally yet.' }), button('＋ New', () => navigate(table.entity, { id: 'new' }), { className: 'new-command', disabled: !capability('create', current?.capabilities ?? table.capabilities), title: capability('create', current?.capabilities ?? table.capabilities) ? 'Create a local record' : capabilityReason(current?.capabilities ?? table.capabilities) }), button('Delete', async () => {
      const rows = await Promise.all([...selected].map(id => api(tablePath(table.entity, id)).then(value => ({ id, etag: value.etag })))); await deleteRecords(rows);
    }, { disabled: !selected.size || !capability('delete', current?.capabilities ?? table.capabilities) || [...selected].some(id => table.protectedIds?.includes(id) || current?.rowCapabilities?.[id]?.delete === false), title: !capability('delete', current?.capabilities ?? table.capabilities) || [...selected].some(id => current?.rowCapabilities?.[id]?.delete === false) ? capabilityReason(current?.capabilities ?? table.capabilities) : [...selected].some(id => table.protectedIds?.includes(id)) ? 'The source website cannot be deleted from its own running instance.' : undefined }), button('↻ Refresh', () => loadGrid()));
    commands.append(button('Visualize this view', null, { disabled: true, title: 'Power BI is not supported locally.' }), button('Email a Link', null, { disabled: true, chevron: true, title: 'Email links are not supported locally.' }), button('Flow', null, { disabled: true, chevron: true, title: 'Flow is not supported locally.' }), button('Run Report', null, { disabled: true, chevron: true, title: 'Reports are not supported locally.' }), button('More commands', null, { disabled: true, iconName: 'more', iconOnly: true, title: 'Additional ribbon commands are not supported locally.' }));
  }
  commands.append(button('Share', null, { disabled: true, className: 'share-command', chevron: true, title: 'Sharing is not supported locally.' }));
  for (const command of table?.commands ?? []) {
    if (!command.locations?.includes(mode)) continue;
    const context = { mode, entity: table.entity, selection: [...selected], formType: mode === 'form' ? loadedFormType : undefined, existing: Boolean(record?.[table.idColumn]), read: name => record?.[name] };
    if (command.supported && !evaluateRibbonRules(command.displayRules, context)) continue;
    const unavailable = commandUnavailable(command), disabled = Boolean(unavailable) || !evaluateRibbonRules(command.enableRules, context);
    const entry = button(command.label, async () => { await clientReady; const runtime = clientRuntime ??= createShellClient({ clientEvents: [], tabs: [] }); await runtime.command(command, [...selected]); renderCommands(mode); }, { disabled, title: disabled ? unavailable ?? 'The exported enable rule is not satisfied.' : 'Exported Solution command · local data only' });
    // An exported zero-sequence modern form action precedes standard actions.
    // Other positions retain their fallback until their native slots are known.
    entry.dataset.solutionCommand = command.id; commands.insertBefore(entry, (command.sourceKind ?? command.source) === 'appaction' && command.sequence === 0 && firstFormAction ? firstFormAction : commands.lastChild);
  }  if (mode === 'form') { commandObserver = new ResizeObserver(() => fitFormCommands(commands)); commandObserver.observe(commands); fitFormCommands(commands); }
}
function fitFormCommands(commands) {
  const children = [...commands.children], more = children.find(node => node.getAttribute('aria-label') === 'More commands'), share = commands.querySelector('.share-command');
  if (!more || !share) return;
  for (const node of children) { if (node.hasAttribute('data-command-overflow')) { node.hidden = false; node.removeAttribute('data-command-overflow'); } }
  const pinned = new Set([...children.slice(0, 4), more, share]), width = node => node.offsetWidth + (node.classList.contains('separator') ? 8 : 0);
  let remaining = innerWidth <= 650 ? 0 : commands.clientWidth - 14 - [...pinned].reduce((sum, node) => sum + width(node), 0), overflow = false;
  for (const node of children) {
    if (pinned.has(node)) continue;
    const needed = width(node); overflow ||= needed > remaining;
    if (overflow) { node.hidden = true; node.setAttribute('data-command-overflow', ''); } else remaining -= needed;
  }
}
function refreshCommandRules(mode) {
  const context = { mode, entity: table.entity, selection: [...selected], formType: mode === 'form' ? loadedFormType : undefined, existing: Boolean(record?.[table.idColumn]), read: name => record?.[name] };
  for (const node of document.querySelectorAll('[data-solution-command]')) {
    const command = table.commands?.find(command => command.id === node.dataset.solutionCommand); if (!command) continue;
    node.hidden = command.supported && !evaluateRibbonRules(command.displayRules, context);
    node.disabled = Boolean(commandUnavailable(command)) || !evaluateRibbonRules(command.enableRules, context);
  }
}
const preferenceKey = () => `view.${app.uniqueName}.${table.entity}.${query.view}`;
function savePreferences() { storage.set(preferenceKey(), { columns: query.columns, filters: query.filters, widths: query.widths }); }
function display(value, field, row, name) {
  const formatted = row?.[name + '@OData.Community.Display.V1.FormattedValue']; if (formatted !== undefined) return String(formatted);
  if (value == null) return '';
  if (typeof value === 'object') return value.name ?? value.label ?? value.id ?? JSON.stringify(value);
  if (field?.options?.length) return field.options.find(option => String(option.value) === String(value))?.label ?? String(value);
  if (field?.type === 'boolean') return value ? 'Yes' : 'No';
  if (field?.type === 'date') { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value); }
  return String(value);
}
function gridCell(source, row, name) {
  const cell = document.createElement('td'), field = source.fields[name], raw = row[name], text = display(raw, field, row, name); cell.title = text;
  if (field?.type === 'number' && !field.options) cell.className = 'numeric-cell';
  if (name === source.nameColumn) cell.append(button(text || '(No name)', () => navigate(source.entity, { id: row[source.idColumn] }), { className: 'link' + (source.grid?.control === 'Microsoft.PowerApps.PowerAppsOneGrid' ? ' primary-grid-link' : '') }));
  else if (field?.type === 'lookup' && raw != null && text) {
    const entity = raw?.entity ?? row[name + '@Microsoft.Dynamics.CRM.lookuplogicalname'] ?? row[`_${name}_value@Microsoft.Dynamics.CRM.lookuplogicalname`] ?? (field.targets?.length === 1 ? field.targets[0] : undefined), id = raw?.id ?? raw?.value ?? raw;
    const target = entity && Object.hasOwn(catalogue.tables, entity) ? catalogue.tables[entity] : undefined;
    const available = Boolean(target && typeof id !== 'object' && target.capabilities?.read !== false);
    const link = button(text, available ? () => navigate(entity, { id: String(id).replace(/[{}]/g, '') }) : null, { className: 'link lookup-grid-link', disabled: !available, title: available ? undefined : 'The lookup target is not available to this local application.' });
    if (field.dataverseType === 'owner' || ['systemuser', 'team'].includes(entity)) { const avatar = document.createElement('span'); avatar.className = 'grid-persona'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = text.replace(/^[^\p{L}\p{N}]+/u, '').split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase(); link.prepend(avatar); }
    cell.append(link);
  } else cell.textContent = text;
  cell.addEventListener('dblclick', event => { if (event.target.closest('button,input,select,textarea,a,[contenteditable]')) return; event.preventDefault(); run(() => navigate(source.entity, { id: row[source.idColumn] })); });
  return cell;
}
async function loadGrid() {
  if (table.grid?.pagination === false) query.page = 1;
  history.replaceState({ ...history.state, grid: gridSnapshot() }, '', location.href);
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
  const viewLabel = (appViews().find(view => view.id === query.view)?.name ?? 'Select a view') + (table.grid?.control === 'Microsoft.PowerApps.PowerAppsOneGrid' && query.search?.trim() ? '*' : '');
  const views = pickerButton(viewLabel, appViews().map(view => ({ label: view.name, value: view.id, isDefault: view.isDefault })), { label: 'View', selected: query.view, choose: view => navigate(table.entity, { view }), search: true, className: 'view-select', menuClass: 'view-picker' });
  views.title = table.views.find(view => view.id === query.view)?.source === 'solution' ? 'Exported solution view' : 'Generated from available metadata';
  header.append(views, button('▥ Edit columns', editColumns), button('▽ Edit filters', editFilters));
  const search = document.createElement('input'); search.type = 'search'; search.className = 'search'; search.placeholder = 'Filter by keyword'; search.setAttribute('aria-label', 'Filter by keyword'); search.value = query.search ?? '';
  const searchGeneration = generation;
  const applySearch = async () => { if (!search.isConnected || searchGeneration !== generation) return; query.search = search.value; query.page = 1; await loadGrid(); $('.search')?.focus(); };
  search.addEventListener('input', () => { clearTimeout(gridSearchTimer); gridSearchTimer = setTimeout(() => run(applySearch), 300); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { clearTimeout(gridSearchTimer); run(applySearch); } });
  const searchBox = document.createElement('div'); searchBox.className = 'search-box'; searchBox.innerHTML = icon('search'); searchBox.append(search); header.append(searchBox); content.append(header);
  if (query.filters?.length) { const summary = document.createElement('div'); summary.className = 'filter-summary'; summary.textContent = query.filters.map(filter => `${table.fields[filter.field]?.label ?? filter.field} ${filter.operator} ${filter.value ?? ''}`).join(' AND '); summary.append(button('Clear filters', () => { query.filters = []; query.page = 1; savePreferences(); return loadGrid(); })); content.append(summary); }
  const scroll = document.createElement('div'); scroll.className = 'grid-scroll'; scroll.dataset.paging = table.grid?.pagination === false ? 'infinite' : 'paged';
  const grid = document.createElement('table'); grid.setAttribute('aria-label', table.label);
  const columnGroup = document.createElement('colgroup'), selectionColumn = document.createElement('col'); selectionColumn.className = 'selection-column'; columnGroup.append(selectionColumn);
  const viewWidths = table.views.find(view => view.id === query.view)?.fields ?? [];
  const weights = current.columns.map(name => viewWidths.find(field => field.name === name)?.width ?? 150), totalWidth = weights.reduce((sum, width) => sum + width, 0);
  grid.style.minWidth = `${current.columns.reduce((sum, name, index) => sum + (query.widths?.[name] ?? weights[index]), 48)}px`;
  for (const [index, width] of weights.entries()) { const column = document.createElement('col'); column.style.width = query.widths?.[current.columns[index]] ? `${query.widths[current.columns[index]]}px` : ((width / totalWidth) * 100) + '%'; columnGroup.append(column); } grid.append(columnGroup);
  const head = document.createElement('thead'), headings = document.createElement('tr'), selection = document.createElement('th'); selection.className = 'selection';
  const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all records'); all.addEventListener('change', () => { selected = new Set(all.checked ? current.rows.map(row => String(row[table.idColumn])) : []); renderRows(); renderCommands('grid'); }); selection.append(all); headings.append(selection);
  for (const name of current.columns) {
    const th = document.createElement('th'); th.scope = 'col';
    const direction = current.sort === name ? current.direction === 'desc' ? ' ↓' : ' ↑' : '';
    const heading = button((table.fields[name]?.label ?? name) + direction, () => columnMenu(heading, name), { disabled: !table.fields[name], chevron: true }); heading.setAttribute('aria-haspopup', 'menu'); heading.setAttribute('aria-expanded', 'false'); th.append(heading);
    if (current.sort === name) th.setAttribute('aria-sort', current.direction === 'desc' ? 'descending' : 'ascending'); headings.append(th);
  }
  head.append(headings); grid.append(head, document.createElement('tbody')); scroll.append(grid); content.append(scroll);
  function renderRows() {
    const body = grid.querySelector('tbody'); body.replaceChildren();
    for (const row of current.rows) {
      const id = String(row[table.idColumn]), tr = document.createElement('tr'); tr.classList.toggle('selected', selected.has(id));
      const selectCell = document.createElement('td'); selectCell.className = 'selection'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(id); checkbox.setAttribute('aria-label', `Select ${display(row[table.nameColumn]) || id}`);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(id); else selected.delete(id); tr.classList.toggle('selected', checkbox.checked); all.checked = selected.size === current.rows.length; all.indeterminate = selected.size > 0 && !all.checked; renderCommands('grid'); }); selectCell.append(checkbox); tr.append(selectCell);
      for (const name of current.columns) tr.append(gridCell(table, row, name));
      body.append(tr);
    }
    grid.classList.toggle('empty-grid', !current.rows.length);
    if (!current.rows.length) {
      const tr = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = current.columns.length + 1; cell.className = 'empty-state';
      cell.innerHTML = `<div class="empty-grid-panel"><svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true"><circle cx="100" cy="100" r="100" fill="#c9c9c9"/><g fill="#f7f7f7" stroke="#e6e6e6">${[50, 86, 122].flatMap(y => [37, 81, 125].map(x => `<rect x="${x}" y="${y}" width="39" height="32" rx="1"/>`)).join('')}</g><g fill="#f7f7f7"><path d="m100 12 3 5 5 2-5 3-3 5-3-5-5-3 5-2zm13 12 4 7 7 4-7 4-4 7-4-7-7-4 7-4zm-25 0 2 4 4 2-4 2-2 4-2-4-4-2 4-2z"/></g></svg><p>We didn't find anything to show here</p></div>`;
      tr.append(cell); body.append(tr);
    }
  }
  renderRows();
  const footer = document.createElement('div'); footer.className = 'grid-footer';
  const count = document.createElement('span'); count.textContent = current.total >= 0 ? `Rows: ${current.total}` : `Rows on this page: ${current.rows.length}`;
  const info = document.createElement('span'); info.className = 'page-info'; info.textContent = `Page ${current.page}`;
  const size = document.createElement('select'); size.setAttribute('aria-label', 'Rows per page'); for (const count of [25, 50, 100]) size.add(new Option(String(count), String(count))); size.value = String(query.pageSize ?? 50); size.addEventListener('change', () => run(() => { query.pageSize = Number(size.value); query.page = 1; return loadGrid(); }));
  footer.append(count);
  if (table.grid?.pagination === true) {
    const first = current.rows.length ? (current.page - 1) * (query.pageSize ?? 50) + 1 : 0, last = first ? first + current.rows.length - 1 : 0;
    count.textContent = `Rows: ${first} - ${last}${current.total >= 0 ? ` of ${current.total}` : ''}`;
    const pager = document.createElement('div'); pager.className = 'native-grid-pager'; pager.setAttribute('role', 'group'); pager.setAttribute('aria-label', 'Grid pages');
    const firstPage = button('Load first page', () => { query.page = 1; return loadGrid(); }, { iconName: 'back', iconOnly: true, disabled: current.page <= 1, className: 'first-page' });
    pager.append(firstPage, button('Previous page', () => { query.page--; return loadGrid(); }, { iconName: 'back', iconOnly: true, disabled: current.page <= 1 }), info, button('Next page', () => { query.page++; return loadGrid(); }, { iconName: 'back', iconOnly: true, disabled: !current.more, className: 'next-page' })); footer.append(pager);
  } else if (table.grid?.pagination !== false && (current.more || current.page > 1 || current.total > 25)) footer.append(info, size, button('‹ Previous', () => { query.page--; return loadGrid(); }, { disabled: current.page <= 1 }), button('Next ›', () => { query.page++; return loadGrid(); }, { disabled: !current.more })); content.append(footer);
  if (table.grid?.pagination === false) {
    const token = generation; let loading = false, failed = false;
    const loadMore = async () => {
      if (loading || failed || !current.more || token !== generation || !scroll.isConnected) return;
      loading = true; scroll.setAttribute('aria-busy', 'true');
      try {
        const result = await api(tablePath() + '?query=' + encodeURIComponent(JSON.stringify({ ...query, page: current.page + 1 })));
        if (token !== generation || !scroll.isConnected) return;
        const ids = new Set(current.rows.map(row => String(row[table.idColumn])));
        current = { ...result, rows: [...current.rows, ...result.rows.filter(row => !ids.has(String(row[table.idColumn])))], more: result.more && result.rows.length > 0 };
        renderRows(); all.checked = selected.size === current.rows.length; all.indeterminate = selected.size > 0 && !all.checked;
        count.textContent = current.total >= 0 ? `Rows: ${current.total}` : `Rows loaded: ${current.rows.length}`;
      } catch (error) {
        if (token !== generation || !scroll.isConnected) return;
        failed = true;
        const retry = button('Retry loading records', () => { failed = false; retry.remove(); return loadMore(); }, { title: error.message }); footer.append(retry);
      } finally { loading = false; scroll.removeAttribute('aria-busy'); }
    };
    scroll.addEventListener('scroll', () => { if (scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 100) run(loadMore); });
  }
}
function editColumns() {
  let chosen = [...current.columns], resetWidths = false, dragged;
  const body = document.createElement('div'), toolbar = document.createElement('div'); toolbar.className = 'columns-toolbar';
  const list = document.createElement('div'); list.className = 'columns-list'; list.setAttribute('aria-label', 'View columns'); body.append(toolbar, list);
  let apply, reset, addColumns;
  const defaults = (table.views.find(view => view.id === query.view)?.fields ?? []).map(field => field.name);
  const changed = () => { if (apply) apply.disabled = !resetWidths && JSON.stringify(chosen) === JSON.stringify(current.columns); if (reset) reset.disabled = JSON.stringify(chosen) === JSON.stringify(defaults) && (!query.widths || resetWidths); };
  const move = (name, offset) => { const index = chosen.indexOf(name), next = index + offset; if (next < 0 || next >= chosen.length) return; [chosen[index], chosen[next]] = [chosen[next], chosen[index]]; render(); };
  function render() {
    list.replaceChildren();
    for (const [index, name] of chosen.entries()) {
      const label = table.fields[name]?.label ?? name, row = document.createElement('div'); row.className = 'column-card'; row.draggable = true; row.tabIndex = 0;
      row.innerHTML = `${icon(columnIcon(table.fields[name]))}<span>${esc(label)}</span>`;
      row.addEventListener('dragstart', event => { dragged = name; event.dataTransfer.setData('text/plain', name); });
      row.addEventListener('dragover', event => { if (dragged && dragged !== name) event.preventDefault(); });
      row.addEventListener('drop', event => { event.preventDefault(); if (!dragged || dragged === name) return; chosen.splice(chosen.indexOf(dragged), 1); chosen.splice(index, 0, dragged); dragged = undefined; render(); });
      row.addEventListener('dragend', () => { dragged = undefined; });
      row.addEventListener('keydown', event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(name, event.key === 'ArrowUp' ? -1 : 1); list.children[chosen.indexOf(name)]?.focus(); } });
      const more = button(`${label} column options`, () => picker(more, [{ label: 'Move up', value: 'up', role: 'menuitem', disabled: index === 0, iconName: 'sortUp' }, { label: 'Move down', value: 'down', role: 'menuitem', disabled: index === chosen.length - 1, iconName: 'sortDown' }, { label: 'Remove', value: 'remove', role: 'menuitem', disabled: chosen.length === 1, iconName: 'delete' }], { label: `${label} column options`, menuClass: 'column-picker', choose: value => { if (value === 'remove') { chosen = chosen.filter(column => column !== name); render(); } else move(name, value === 'up' ? -1 : 1); } }), { iconName: 'more', iconOnly: true }); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); row.append(more); list.append(row);
    }
    changed();
  }
  toolbar.append(addColumns = button('Add columns', () => {
    const panel = document.createElement('dialog'); panel.className = 'add-column-browser'; panel.setAttribute('aria-labelledby', 'add-columns-title'); const title = document.createElement('h3'); title.id = 'add-columns-title'; title.textContent = 'Add columns';
    const close = () => { lifetime.signal.removeEventListener('abort', close); panel.close(); panel.remove(); if (!lifetime.signal.aborted && addColumns.isConnected) addColumns.focus(); }; const lifetime = dialogLifetime; lifetime.signal.addEventListener('abort', close, { once: true });
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
    panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
    const tabs = document.createElement('div'); tabs.className = 'add-column-tabs'; tabs.setAttribute('role', 'tablist'); const primary = button(table.singular, null); primary.setAttribute('role', 'tab'); primary.setAttribute('aria-selected', 'true'); const related = button('Related', null, { disabled: true, title: 'Adding columns from related tables is not supported locally.' }); related.setAttribute('role', 'tab'); related.setAttribute('aria-selected', 'false'); tabs.append(primary, related);
    const searchBox = document.createElement('div'); searchBox.className = 'add-column-search'; const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search'; search.setAttribute('aria-label', 'Search columns'); searchBox.innerHTML = icon('search'); searchBox.append(search, button('All', null, { disabled: true, chevron: true, title: 'All available local columns are shown.' }));
    const options = document.createElement('div'); options.className = 'add-column-options'; const renderOptions = () => { options.replaceChildren(); for (const field of Object.values(table.fields).filter(field => field.validForGrid !== false && !chosen.includes(field.name) && (field.label ?? field.name).toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).sort((left, right) => (left.label ?? left.name).localeCompare(right.label ?? right.name))) options.append(button(field.label ?? field.name, () => { chosen.push(field.name); render(); renderOptions(); }, { iconName: columnIcon(field) })); };
    const footer = document.createElement('div'); footer.className = 'add-column-footer'; footer.append(button('Close', close, { className: 'secondary' }));
    search.addEventListener('input', renderOptions); panel.append(title, button('Close', close, { iconName: 'close', iconOnly: true, className: 'side-panel-close' }), tabs, searchBox, options, footer); $('#dialog').append(panel); renderOptions(); panel.showModal(); search.focus();
  }, { iconName: 'add' }), reset = button('Reset to default', () => { chosen = [...defaults]; resetWidths = Boolean(query.widths); render(); }, { iconName: 'reset' }), button('Download LayoutXML', null, { iconName: 'download', disabled: true, title: 'Downloading an edited view definition is not supported locally.' }));
  render();
  const element = dialog(`Edit columns: ${table.label}`, body, [['Apply', async () => { query.columns = chosen; if (resetWidths) query.widths = undefined; query.page = 1; savePreferences(); closeDialog(); await loadGrid(); }, true], ['Cancel', closeDialog]]);
  element.classList.add('side-panel', 'columns-panel'); const close = button('Close', closeDialog, { iconName: 'close', iconOnly: true, className: 'side-panel-close' }); element.prepend(close); apply = element.querySelector('.primary'); changed();
}
function columnMenu(trigger, name) {
  const index = current.columns.indexOf(name), choices = [
    { label: 'A to Z', value: 'asc', iconName: 'sortUp' }, { label: 'Z to A', value: 'desc', iconName: 'sortDown' },
    { label: 'Group by', value: 'group', role: 'menuitem', separatorBefore: true, disabled: true, iconName: 'group', reason: 'Grouping records is not supported locally.' },
    { label: 'Filter by', value: 'filter', role: 'menuitem', iconName: 'filter' },
    { label: 'Column width', value: 'width', role: 'menuitem', separatorBefore: true, iconName: 'columns' },
    { label: 'Move right', value: 'right', role: 'menuitem', iconName: 'arrowRight', disabled: index === current.columns.length - 1 },
  ];
  picker(trigger, choices, { label: `${table.fields[name]?.label ?? name} column options`, selected: current.sort === name ? current.direction ?? 'asc' : undefined, menuClass: 'column-picker', choose: async value => {
    if (value === 'asc' || value === 'desc') { query.sort = name; query.direction = value; query.page = 1; await loadGrid(); }
    else if (value === 'filter') editFilters(name);
    else if (value === 'right') { query.columns = [...current.columns]; [query.columns[index], query.columns[index + 1]] = [query.columns[index + 1], query.columns[index]]; savePreferences(); await loadGrid(); }
    else if (value === 'width') { const body = document.createElement('label'); body.textContent = 'Width (pixels)'; const input = document.createElement('input'); input.type = 'number'; input.min = '40'; input.max = '2000'; input.value = String(query.widths?.[name] ?? Math.round(trigger.closest('th').getBoundingClientRect().width)); input.setAttribute('aria-label', 'Width (pixels)'); body.append(input); dialog('Column width', body, [['Cancel', closeDialog], ['Apply', async () => { if (!input.reportValidity()) return; query.widths = { ...query.widths, [name]: Number(input.value) }; savePreferences(); closeDialog(); await loadGrid(); }, true]]); }
  } });
}
function editFilters(initialField) {
  const filters = structuredClone(query.filters ?? []), body = document.createElement('div');
  let valueControls = [];
  const disposeValues = () => { for (const control of valueControls) control.destroy?.(); valueControls = []; };
  if (initialField && !filters.some(filter => filter.field === initialField)) filters.push({ field: initialField, operator: 'eq', value: '' });
  const toolbar = document.createElement('div'); toolbar.className = 'filters-toolbar'; toolbar.append(button('Reset to default', () => { filters.splice(0); render(); }, { iconName: 'reset' }), button('Download FetchXML', null, { disabled: true, iconName: 'download', title: 'Downloading an edited query definition is not supported locally.' }), button('Delete all filters', () => { filters.splice(0); render(); }, { iconName: 'filter' }));
  const dataMode = document.createElement('div'); dataMode.className = 'filter-data-mode'; dataMode.append(document.createTextNode('Showing local data'), button('Change to retained data', null, { disabled: true, title: 'Retained Dataverse data is not available in the local simulator.' })); dataMode.insertAdjacentHTML('beforeend', icon('info'));
  const headings = document.createElement('div'); headings.className = 'filter-headings'; headings.innerHTML = '<span>Field</span><span>Operator</span><span>Value</span>';
  const group = button('AND', null, { disabled: true, chevron: true, title: 'All local conditions must match.' }); group.className = 'filter-group';
  const list = document.createElement('div'); list.className = 'filter-conditions'; body.append(toolbar, dataMode, group, headings, list);
  const comparisons = [['eq', 'Equals'], ['ne', 'Does not equal']], emptyOperators = [['null', 'Does not contain data'], ['not-null', 'Contains data']];
  const operatorsFor = field => [...comparisons, ...(field?.type === 'number' && !field.options || field?.type === 'date' ? [['gt', 'Greater than'], ['ge', 'Greater than or equal'], ['lt', 'Less than'], ['le', 'Less than or equal']] : []), ...(['text', 'textarea'].includes(field?.type) && !field.options ? [['contains', 'Contains'], ['not-contains', 'Does not contain'], ['begins-with', 'Begins with'], ['ends-with', 'Ends with']] : []), ...emptyOperators];
  function render() {
    disposeValues();
    list.replaceChildren();
    for (const [index, filter] of filters.entries()) {
      const row = document.createElement('div'); row.className = 'filter-row';
      const definition = table.fields[filter.field], operators = operatorsFor(definition);
      // Retain old explicitly-authored pattern filters when editing saved preferences.
      if (['like', 'not-like'].includes(filter.operator)) operators.splice(2, 0, [filter.operator, filter.operator === 'like' ? 'Matches pattern' : 'Does not match pattern']);
      const field = pickerButton(definition?.label ?? filter.field, Object.values(table.fields).map(definition => ({ label: definition.label ?? definition.name, value: definition.name })), { label: `Filter ${index + 1} column`, selected: filter.field, choose: name => { filter.field = name; filter.value = ''; if (!operatorsFor(table.fields[name]).some(([value]) => value === filter.operator)) filter.operator = 'eq'; render(); }, className: 'filter-picker' });
      const operator = pickerButton(operators.find(([value]) => value === filter.operator)?.[1] ?? filter.operator, operators.map(([value, label]) => ({ label, value })), { label: `Filter ${index + 1} operator`, selected: filter.operator, choose: value => { filter.operator = value; render(); }, className: 'filter-picker' });
      const noValue = ['null', 'not-null'].includes(filter.operator), value = document.createElement('div'); value.className = 'filter-value';
      // Filter values use the same source-typed scalar editors as the record form.
      // Query bounds are independent of the table's write bounds and required level.
      const typed = definition && ['number', 'boolean', 'date'].includes(definition.type), control = typed ? renderControl({ ...definition, name: `filter-${index + 1}-value`, label: `Filter ${index + 1} value`, required: !noValue, minValue: undefined, maxValue: undefined }, filter.value === '' ? null : filter.value, { disabled: noValue }) : undefined;
      if (control) {
        valueControls.push(control); value.append(control.element);
        const read = () => { try { const next = control.read(); filter.value = definition.type === 'boolean' && next != null ? Number(next) : next; } catch { /* The editor retains its own validation while a value is incomplete. */ } };
        control.element.addEventListener('input', read); control.element.addEventListener('change', read);
      } else {
        const input = document.createElement('input'); input.setAttribute('aria-label', `Filter ${index + 1} value`); input.value = filter.value ?? ''; input.disabled = noValue; input.addEventListener('input', () => { filter.value = input.value; }); value.append(input);
      }
      row.append(field, operator, value, button('Remove condition', () => { filters.splice(index, 1); render(); }, { title: 'Remove condition', iconName: 'delete', iconOnly: true })); list.append(row);
    }
  }
  const addRow = () => { filters.push({ field: table.nameColumn, operator: 'eq', value: '' }); render(); };
  const split = document.createElement('div'); split.className = 'add-filter-split'; const add = button('Add', addRow, { iconName: 'add' }); add.setAttribute('aria-label', 'Add condition');
  const more = button('Add options', () => picker(more, [{ label: 'Add row', value: 'row', role: 'menuitem', iconName: 'add' }, { label: 'Add group', value: 'group', role: 'menuitem', disabled: true, reason: 'Nested filter groups are not supported locally.' }], { label: 'Add filter options', menuClass: 'column-picker', choose: addRow }), { chevron: true, iconOnly: true }); split.append(add, more); body.append(split); render();
  const element = dialog(`Edit filters: ${table.label}`, body, [['Apply', async () => { if (valueControls.some(control => !(control.primary ?? control.element).reportValidity())) return; query.filters = filters; query.page = 1; savePreferences(); closeDialog(); await loadGrid(); }, true], ['Cancel', closeDialog]]);
  dialogLifetime.signal.addEventListener('abort', disposeValues, { once: true });
  element.classList.add('side-panel', 'filters-panel'); element.prepend(button('Close', closeDialog, { iconName: 'close', iconOnly: true, className: 'side-panel-close' }));
}
function lookup(field) { return createLookupDialog(field, { tables: catalogue.tables, api, tablePath, display, dialog, closeDialog, onDialogCancel, pickerButton, getLifetime: () => dialogLifetime }); }
async function lookupSuggestions(field, search, { signal } = {}) {
  const targets = (field.targets ?? []).filter(entity => Object.hasOwn(catalogue.tables, entity));
  const results = await Promise.all(targets.map(async entity => {
    const destination = catalogue.tables[entity], view = (destination.lookupViews ?? destination.views)?.[0];
    const secondary = view?.fields?.find(column => ![destination.nameColumn, destination.idColumn].includes(column.name) && Object.hasOwn(destination.fields, column.name))?.name;
    const found = await api(tablePath(entity) + '?query=' + encodeURIComponent(JSON.stringify({ search, columns: [destination.nameColumn, ...(secondary ? [secondary] : [])], ...(view?.id ? { view: view.id } : { scope: 'table' }), pageSize: 5 })), { signal });
    return found.rows.map(row => ({ id: row[destination.idColumn], entity, name: display(row[destination.nameColumn], destination.fields[destination.nameColumn], row, destination.nameColumn),
      tableLabel: destination.label, ...(secondary ? { description: display(row[secondary], destination.fields[secondary], row, secondary) } : {}) }));
  }));
  return results.flat().slice(0, 5);
}
async function loadRecord(id) {
  const token = ++generation; contentLoading(id ? 'Loading record and form…' : 'Preparing new record…');
  try {
    const result = id ? await api(tablePath(table.entity, id)) : { row: Object.fromEntries(Object.values(table.fields).filter(field => field.defaultValue !== undefined).map(field => [field.name, field.defaultValue])) };
    if (token !== generation) return; record = result.row; touchedFields = new Set(); recordCapabilities = result.capabilities ?? table.capabilities;
    // Match the observed disabled form for exported two-state Active/Inactive
    // tables. Bind this to the loaded row so editing an active draft's state
    // does not disable it before the transition can be saved.
    const stateField = Object.values(table.fields).find(field => field.dataverseType === 'state' && field.options?.length === 2 && field.options.every(option => [0, 1].includes(Number(option.value))));
    loadedFormType = !id ? 1 : stateField && Number(record[stateField.name]) === 1 ? 4 : 2;
    if (!id) {
      const principal = staffSession?.current, principalId = principal?.principalId ?? principal?.id;
      if (principalId && Object.hasOwn(catalogue.tables, 'systemuser')) for (const field of Object.values(table.fields)) {
        if (field.dataverseType === 'owner' && field.defaultValue === undefined && !Object.hasOwn(record, field.name) && field.targets?.includes('systemuser')) record[field.name] = { id: principalId, entity: 'systemuser', name: principal.name ?? principalId };
      }
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
    const requestedForm = new URLSearchParams(location.search).get('formid')?.replace(/[{}]/g, '').toLowerCase();
    const availableForms = appForms(), preferredForm = requestedForm === undefined ? storage.get(preferredFormKey()) : requestedForm;
    etag = result.etag; formId = availableForms.find(form => String(form.id).replace(/[{}]/g, '').toLowerCase() === String(preferredForm ?? '').replace(/[{}]/g, '').toLowerCase())?.id ?? availableForms[0]?.id;
    if (formId) rememberForm(formId);
    activeTab = null; await renderRecord();
    if (token !== generation) return;
    if (id) remember({ label: record[table.nameColumn] ?? table.singular, url: location.pathname + location.search, app: app.uniqueName });
    contentLoaded();
  } catch (error) { if (token === generation) loadFailed(error, () => { disposeClient(); dirty = false; return loadRecord(id); }); }
}
async function renderRecord() {
  if (loadedFormType === 4) {
    let banner = $('#record-status');
    if (!banner) { banner = document.createElement('div'); banner.id = 'record-status'; banner.setAttribute('role', 'status'); ($('#form-notifications') ?? $('#commands')).before(banner); }
    const state = Object.values(table.fields).find(field => field.dataverseType === 'state');
    const label = state?.options?.find(option => String(option.value) === String(record?.[state.name]))?.label ?? String(record?.[state?.name] ?? '');
    const glyph = document.createElement('span'); glyph.innerHTML = icon('lock'); glyph.setAttribute('aria-hidden', 'true');
    banner.replaceChildren(glyph, document.createTextNode(`Read-only This record’s status: ${label}`));
  } else $('#record-status')?.remove();
  const renderGeneration = generation;
  formLifetime?.abort(); formLifetime = new AbortController();
  tabObserver?.disconnect();
  disposeControls();
  const content = $('#content'); content.replaceChildren(); content.className = 'record-content';
  const existing = Boolean(record[table.idColumn]);
  document.title = `${existing ? record[table.nameColumn] ?? table.singular : 'New ' + table.singular} - ${app.name} · Mirage`;
  renderCommands('form');
  const recordCard = document.createElement('div'); recordCard.className = 'record-card'; content.append(recordCard);
  const header = document.createElement('div'); header.className = 'record-header'; header.innerHTML = `<div class="record-identity"><div class="record-title"><h1>${esc(existing ? record[table.nameColumn] ?? '(No name)' : 'New ' + table.singular)}</h1><span class="record-saved" id="save-status"> - ${dirty ? 'Unsaved changes' : existing ? 'Saved' : 'New record'}</span></div><div class="record-subtitle"><small>${esc(table.singular)}</small></div></div>`;
  recordCard.append(header);
  const availableForms = appForms();
  let selectedForm = availableForms.find(form => form.id === formId) ?? availableForms[0];
  if (new URLSearchParams(location.search).has('formid')) { const url = new URL(location.href); url.searchParams.set('formid', selectedForm.id); history.replaceState(history.state, '', url); }
  if (availableForms.length > 1) {
    const separator = document.createElement('span'); separator.textContent = '·'; separator.setAttribute('aria-hidden', 'true');
    header.querySelector('.record-subtitle').append(separator, pickerButton(selectedForm.name, [...availableForms].sort((left, right) => Number(right.id === selectedForm.id) - Number(left.id === selectedForm.id)).map(form => ({ label: form.name, value: form.id })), { label: 'Record form', selected: selectedForm.id, className: 'form-chooser', menuClass: 'form-picker', choose: async id => { captureDraft(); disposeClient(); formId = id; rememberForm(id); const url = new URL(location.href); url.searchParams.set('formid', id); history.replaceState(history.state, '', url); await renderRecord(); } }));
  }
  if (selectedForm.hasScripts) { const warning = document.createElement('span'); warning.className = 'script-indicator'; warning.textContent = catalogue.clientExtensions?.trusted ? 'Local Solution scripts' : 'Local scripts disabled'; warning.title = catalogue.clientExtensions?.trusted ? 'Explicitly trusted exported scripts execute against the bounded local client API.' : 'Trust local Solution client extensions in configuration to run exported form events.'; header.append(warning); }
  const tabs = document.createElement('div'); tabs.className = 'tabs'; tabs.setAttribute('role', 'tablist');
  const availableTabs = selectedForm.tabs.filter(tab => tab.visible !== false);
  activeTab = availableTabs.some(tab => tab.id === activeTab) ? activeTab : availableTabs[0]?.id;
  const chooseTab = async (tab, focus = false) => { captureDraft(); activeTab = tab.id; await renderRecord(); if (focus) $('#content [role="tab"][aria-selected="true"]')?.focus(); };
  for (const [index, tab] of availableTabs.entries()) { const tabButton = button(tab.label, () => chooseTab(tab)); tabButton.id = `record-tab-${index}`; tabButton.setAttribute('role', 'tab'); tabButton.setAttribute('aria-controls', 'record-form'); tabButton.setAttribute('aria-selected', String(tab.id === activeTab)); tabButton.tabIndex = tab.id === activeTab ? 0 : -1; tabs.append(tabButton); }
  const tabButtons = [...tabs.children];
  const moreTabs = button('More tabs', () => picker(moreTabs, availableTabs.map(tab => ({ label: tab.label, value: tab.id })), { label: 'Record tabs', selected: activeTab, choose: id => chooseTab(availableTabs.find(tab => tab.id === id), true) }), { iconName: 'more', iconOnly: true }); moreTabs.setAttribute('aria-haspopup', 'dialog'); moreTabs.setAttribute('aria-expanded', 'false'); moreTabs.hidden = true;
  tabs.addEventListener('keydown', event => {
    if (event.target.getAttribute('role') !== 'tab' || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const index = availableTabs.findIndex(tab => tab.id === activeTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? availableTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + availableTabs.length) % availableTabs.length;
    run(() => chooseTab(availableTabs[next], true));
  });
  const assist = button('Form assist', null, { iconName: 'pageForm', disabled: true, className: 'form-assist', title: 'Form assist is not supported locally.' });
  tabs.append(moreTabs, assist); recordCard.append(tabs);
  tabObserver = new ResizeObserver(() => {
    tabButtons.forEach(button => { button.hidden = false; }); moreTabs.hidden = true;
    const gap = 22, budget = tabs.clientWidth - 42 - assist.offsetWidth - gap;
    const selected = tabButtons.find(entry => entry.getAttribute('aria-selected') === 'true');
    let used = (selected?.offsetWidth ?? 0) + gap, overflow = false;
    for (const entry of tabButtons) { if (entry === selected) continue; const width = entry.offsetWidth + gap; const fits = innerWidth > 650 && used + width <= budget - 45; entry.hidden = !fits; if (fits) used += width; else overflow = true; }
    moreTabs.hidden = !overflow;
    const form = content.querySelector('.form-layout');
    if (form) form.style.setProperty('--form-usable-height', Math.max(0, content.clientHeight - (form.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop) - 20) + 'px');
  }); tabObserver.observe(tabs); tabObserver.observe(content);
  const form = document.createElement('form'); form.id = 'record-form'; form.className = 'form-layout';
  form.setAttribute('role', 'tabpanel'); form.setAttribute('aria-labelledby', `record-tab-${availableTabs.findIndex(tab => tab.id === activeTab)}`);
  form.addEventListener('submit', event => { event.preventDefault(); run(() => saveRecord(false)); });
  const tab = availableTabs.find(tab => tab.id === activeTab);
  const widths = tab?.columnWidths?.length ? tab.columnWidths : [100];
  form.dataset.columns = String(widths.length);
  widths.forEach((width, index) => form.style.setProperty('--column-' + (index + 1), Math.max(1, width) + 'fr'));
  form.style.gridTemplateColumns = widths.map(width => `${Math.max(1, width)}fr`).join(' ');
  const columns = widths.map(() => { const column = document.createElement('div'); column.className = 'form-column'; form.append(column); return column; });
  for (const section of tab?.sections ?? []) {
    if (section.visible === false) continue;
    const panel = document.createElement('section'); panel.className = 'form-section'; if (section.label && section.showLabel !== false) { const title = document.createElement('h2'); title.textContent = section.label; panel.append(title); }
    if (section.labelPosition) panel.dataset.labelPosition = section.labelPosition;
    if (section.labelAlignment) panel.dataset.labelAlignment = section.labelAlignment;
    const fields = document.createElement('div'); fields.className = 'section-fields'; fields.dataset.columns = String(section.columns ?? 1); panel.append(fields);
    for (const cell of section.fields) {
      const position = element => { element.hidden = clientControlState.get(cell.sourceControl?.id ?? cell.name)?.get('hidden') ?? cell.visible === false; if (cell.column !== undefined) element.style.gridColumn = `${cell.column + 1} / span ${Math.min(cell.colspan ?? 1, section.columns ?? 1)}`; formCellLayouts.set(element, cell); fields.append(element); };
      if (cell.spacer) { const spacer = document.createElement('div'); spacer.className = 'form-spacer'; spacer.setAttribute('aria-hidden', 'true'); position(spacer); continue; }
      if (cell.subgrid) { position(renderSubgrid(cell)); continue; }
      if (!cell.supported || !table.fields[cell.name]) { const unsupported = document.createElement('p'); unsupported.className = 'unsupported'; unsupported.textContent = `${cell.label ?? 'Control'}: ${cell.reason ?? 'Unsupported control'}`; position(unsupported); continue; }
      const field = { ...table.fields[cell.name], label: cell.label ?? table.fields[cell.name].label };
      const disabled = controlDisabled(cell, field, clientControlState.get(cell.sourceControl?.id ?? field.name)?.get('disabled'));
      const wrapper = document.createElement('div'); wrapper.className = 'field'; const label = document.createElement('label'); label.htmlFor = 'field-' + field.name; label.textContent = field.label; if (field.required) { const required = document.createElement('span'); required.className = 'required'; required.setAttribute('aria-hidden', 'true'); required.textContent = '*'; label.append(required); }
      if (cell.showLabel === false) label.className = 'sr-only';
      setFieldLock(label, disabled && (cell.disabled || field.isPrimaryId || field[existing ? 'validForUpdate' : 'validForCreate'] === false));
      const name = cell.sourceControl?.id ?? field.name;
      const control = renderFieldControl(cell, field, disabled); wrapper.append(label, control.element); position(wrapper); controls.push({ name: field.name, controlName: name, cell, wrapper, label, control, disabled });
    }
    reflowSectionFields(fields); columns[Math.max(0, section.column ?? 0)]?.append(panel);
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
  return renderControl(field, record[field.name], { disabled, tables: catalogue.tables, lookup, lookupSuggestions, formatting: catalogue.formatting,
    readOnlyText: cell.readOnlyText, rows: cell.rowspan,
    pcf: cell.pcf, clientExtensions: catalogue.clientExtensions, record, fields: table.fields, entity: table.entity, recordId: record[table.idColumn], webAPI: () => clientRuntime?.Xrm.WebApi,
    user: staffSession?.current ? { id: staffSession.current.principalId ?? staffSession.current.id, name: staffSession.current.name } : undefined,
    formatted: record[field.name + '@OData.Community.Display.V1.FormattedValue'], logicalName: record[field.name + '@Microsoft.Dynamics.CRM.lookuplogicalname'] });
}
function applyControlState(name, key, value) {
  const entry = controls.find(entry => entry.controlName === name); if (!entry) return;
  if (key === 'hidden') { entry.wrapper.hidden = value; reflowSectionFields(entry.wrapper.parentElement); }
  else if (key === 'label') { const locked = Boolean(entry.label.querySelector('.field-lock')), required = entry.label.querySelector('.required'); entry.label.textContent = value; if (required) entry.label.append(required); setFieldLock(entry.label, locked); (entry.control.primary ?? entry.control.element).setAttribute('aria-label', value); }
  else if (key === 'focus') (entry.control.primary ?? entry.control.element).focus();
  else if (key === 'required') {
    (entry.control.primary ?? entry.control.element).required = value === 'required';
    if (value !== 'required') entry.label.querySelector('.required')?.remove();
    else if (!entry.label.querySelector('.required')) { const marker = document.createElement('span'); marker.className = 'required'; marker.setAttribute('aria-hidden', 'true'); marker.textContent = '*'; entry.label.append(marker); }
  }
  else if (key === 'disabled') {
    // Client scripts can restrict a control, never enable a field denied by its source or staff policy.
    entry.disabled = controlDisabled(entry.cell, table.fields[entry.name], value);
    if (entry.control.setDisabled) entry.control.setDisabled(entry.disabled);
    else for (const node of [entry.control.element, ...entry.control.element.querySelectorAll('input,textarea,select,button')]) if ('disabled' in node) node.disabled = entry.disabled;
    const field = table.fields[entry.name];
    setFieldLock(entry.label, entry.disabled && (entry.cell.disabled || field.isPrimaryId || field[record?.[table.idColumn] ? 'validForUpdate' : 'validForCreate'] === false));
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
    getFormType: () => loadedFormType,
    user: staffSession?.current ? { id: staffSession.current.principalId ?? staffSession.current.id, name: staffSession.current.name } : undefined,
    read: name => { const entry = controls.find(entry => entry.name === name); return entry?.control.supported ? entry.control.read() : record?.[name]; },
    write: (name, value) => {
      const field = table.fields[name], cell = cells.find(cell => cell.name === name), mode = record?.[table.idColumn] ? 'update' : 'create';
      if (!record || !cell || field.isPrimaryId || field[mode === 'update' ? 'validForUpdate' : 'validForCreate'] === false || !capability(mode) || recordCapabilities?.fields?.[name]?.[mode] === false) throw new Error(`Column ${name} cannot be changed by this client extension.`);
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
    controlState: (name, key, value) => { const entry = controls.find(entry => entry.controlName === name); if (value === undefined) { const cell = cells.find(cell => controlName(cell) === name); return key === 'disabled' ? entry?.disabled ?? controlDisabled(cell, table.fields[cell?.name], clientControlState.get(name)?.get(key)) : clientControlState.get(name)?.get(key) ?? (key === 'hidden' ? entry?.wrapper.hidden ?? cell?.visible === false : key === 'label' ? cell?.label ?? table.fields[cell?.name]?.label : undefined); } const states = clientControlState.get(name) ?? new Map(); states.set(key, value); clientControlState.set(name, states); applyControlState(name, key, value); return true; },
    notification: (message, level, id) => {
      let host = $('#form-notifications'), element = [...host?.children ?? []].find(element => element.dataset.formNotification === id);
      if (message == null) { element?.remove(); return; }
      if (!host) { host = document.createElement('div'); host.id = 'form-notifications'; $('#commands').before(host); }
      if (!element) { element = document.createElement('p'); element.dataset.formNotification = id; element.setAttribute('role', 'status'); host.append(element); }
      element.className = level === 'ERROR' ? 'error' : level === 'WARNING' ? 'warning' : 'info'; element.replaceChildren();
      const glyph = document.createElement('span'); glyph.innerHTML = icon('info'); glyph.setAttribute('aria-hidden', 'true'); element.append(glyph, document.createTextNode(message));
    },
    request: async (entity, id, options = {}) => { if (!Object.hasOwn(catalogue.tables, entity)) throw new Error(`Table ${entity} is not imported.`); return api(tablePath(entity, id ? String(id).replace(/[{}]/g, '') : undefined) + (options.query ? '?query=' + encodeURIComponent(JSON.stringify(options.query)) : ''), { method: options.method ?? 'GET', ...(options.etag ? { headers: { 'if-match': options.etag } } : {}), ...(options.data ? { body: JSON.stringify(options.data) } : {}) }); },
    save: close => saveRecord(close), refresh: () => loadRoute(), close: returnToGrid,
    openForm: options => { if (!options || !catalogue.tables[options.entityName]) throw new Error('The target form table is not imported.'); if (options.useQuickCreateForm || options.openInNewWindow) throw new Error('Quick create and separate form windows are not supported locally.'); return navigate(options.entityName, { id: options.entityId ?? 'new', form: options.formId }); },
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
  const relationshipName = cell.subgrid.relationship?.toLowerCase();
  const relationship = relationshipName && Object.entries(table.relationships ?? {}).find(([name, relation]) => (name.toLowerCase() === relationshipName || relation.schemaName?.toLowerCase() === relationshipName) && relation.entity === target.entity && relation.many === true && relation.from === table.idColumn)?.[1];
  const boundField = relationshipName ? candidates.find(field => field.name === relationship?.to) : candidates.length === 1 ? candidates[0] : undefined;
  if (!boundField) return unavailable('The related table has no unambiguous exported lookup to this record.');
  const field = boundField.name;
  let view = target.views.find(view => view.id === cell.subgrid.view);
  if (!view) return unavailable('The exported subgrid view is unavailable.');
  let page = 1, sort, direction = 'asc', sequence = 0, timer;
  const lifetime = formLifetime;
  lifetime.signal.addEventListener('abort', () => { clearTimeout(timer); sequence++; }, { once: true });
  if (cell.subgrid.viewPickerEnabled) {
    const views = target.views.filter(candidate => candidate.id === view.id || !cell.subgrid.views?.length || cell.subgrid.views.includes(candidate.id));
    const viewOptions = { label: `View for ${label}`, selected: view.id, search: true, menuClass: 'view-picker', className: 'subgrid-view-picker', choose: async id => {
      view = views.find(candidate => candidate.id === id); page = 1; sort = undefined; direction = 'asc';
      viewOptions.selected = view.id;
      chooseView.querySelector('span').textContent = view.name; await load();
    } };
    const chooseView = pickerButton(view.name, views.map(candidate => ({ label: candidate.name, value: candidate.id, isDefault: candidate.isDefault })), viewOptions);
    heading.replaceWith(chooseView);
  }
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
  if (cell.subgrid.searchEnabled) { const searchRow = document.createElement('div'); searchRow.className = 'subgrid-search'; const searchBox = document.createElement('div'); searchBox.className = 'search-box'; searchBox.innerHTML = icon('search'); searchBox.append(search); searchRow.append(searchBox); panel.append(searchRow); search.addEventListener('input', () => { clearTimeout(timer); page = 1; timer = setTimeout(() => run(load), 250); }); }
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
      grid.style.minWidth = `${total + 48}px`;
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
        for (const name of result.columns) tr.append(gridCell(target, row, name));
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
  // Client scripts may explicitly write source-disabled presentation controls.
  // Column permissions and staff capabilities still govern the resulting write.
  const layoutFields = new Map(table.forms.find(form => form.id === formId)?.tabs.flatMap(tab => tab.sections.flatMap(section => section.fields)).filter(field => field.supported).map(field => [field.name, field]) ?? []);
  for (const [name, value] of Object.entries(record)) {
    const field = table.fields[name], mode = existing ? 'update' : 'create'; if ((!existing || touchedFields.has(name)) && field && hasControl(field) && !field.isPrimaryId && field[existing ? 'validForUpdate' : 'validForCreate'] !== false && recordCapabilities?.fields?.[name]?.[mode] !== false && layoutFields.has(name)) values[name] = value;
  }
  if (existing && !Object.keys(values).length) { dirty = false; touchedFields.clear(); if (close) await returnToGrid(); else notice('No record changes to save.'); return; }
  pending = true; $('#commands').classList.add('busy');
  try {
    const result = await api(tablePath(table.entity, existing ? record[table.idColumn] : undefined), { method: existing ? 'PATCH' : 'POST', headers: existing ? { 'if-match': etag } : {}, body: JSON.stringify(values) });
    if (saveGeneration !== generation) return;
    dirty = false; touchedFields.clear(); record = result.row; etag = result.etag;
    const refreshed = await api(); if (saveGeneration !== generation) return;
    catalogue = refreshed; table = catalogue.tables[table.entity];
    if (close) await returnToGrid(); else await navigate(table.entity, { id: record[table.idColumn], form: formId, replace: true }); notice('Record saved locally.');
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
  $('#apps').innerHTML = `<span>${esc(app.name ?? app.uniqueName)}</span>${icon('chevron', 'chevron')}`; $('#apps').title = 'Select an app'; $('#source-label').textContent = app.name ?? app.uniqueName;
  const entity = params.get('etn') ?? firstEntity(app); table = catalogue.tables[entity];
  if (!table) throw new Error('No table metadata is available for this application. Import its solution and local mappings.');
  const preferredArea = storage.get(`area.${app.uniqueName}`, undefined), requestedViewId = (params.get('viewid') ?? (!params.has('etn') ? firstPage(app)?.view : undefined))?.replace(/[{}]/g, '').toLowerCase(), containsEntity = area => area.groups.some(group => group.items.some(item => item.supported && item.entity === entity));
  const containsView = area => Boolean(requestedViewId && area.groups.some(group => group.items.some(item => item.supported && item.entity === entity && item.view === requestedViewId)));
  activeArea = app.navigation.find(area => area.id === preferredArea && containsView(area)) ?? app.navigation.find(containsView) ?? app.navigation.find(area => area.id === preferredArea && containsEntity(area)) ?? app.navigation.find(containsEntity) ?? app.navigation.find(area => area.id === preferredArea) ?? app.navigation[0];
  if (activeArea) storage.set(`area.${app.uniqueName}`, activeArea.id);
  const pageItems = activeArea?.groups.flatMap(group => group.items).filter(item => item.supported && item.entity === entity) ?? [];
  activeNavigationItem = pageItems.find(item => item.id === history.state?.navigation) ?? pageItems.find(item => item.view && item.view === requestedViewId) ?? pageItems.find(item => !item.view) ?? pageItems[0];
  renderNavigation(); record = null; recordCapabilities = undefined; current = null; etag = null;
  if (params.get('pagetype') === 'entityrecord') await loadRecord(params.get('id'));
  else {
    const availableViews = appViews(), requestedView = requestedViewId;
    const view = availableViews.find(view => view.id === requestedView)?.id ?? availableViews.find(view => view.isDefault)?.id ?? availableViews[0].id;
    const saved = history.state?.grid, restore = saved?.application === app.id && saved?.entity === entity && saved?.query?.view === view ? saved.query : {};
    query = { page: 1, pageSize: 50, ...storage.get(`view.${app.uniqueName}.${entity}.${view}`, {}), ...restore, view };
    await loadGrid(); remember({ label: table.label, app: app.uniqueName, url: targetUrl(entity, { view }) });
  }
}
$('#mobile-navigation').addEventListener('click', () => { const sidebar = $('#sidebar'); sidebar.classList.toggle('mobile-open'); $('#mobile-navigation').setAttribute('aria-expanded', String(sidebar.classList.contains('mobile-open'))); });
$('#collapse').addEventListener('click', () => { $('#sidebar').classList.toggle('collapsed'); $('#collapse').setAttribute('aria-expanded', String(!$('#sidebar').classList.contains('collapsed'))); });
for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);
$('#apps').addEventListener('click', chooseApplication);
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
    $('#apps').disabled = !catalogue.apps.length;
    await loadRoute();
  } catch (error) { loadFailed(error, initialize); }
}
await initialize();
