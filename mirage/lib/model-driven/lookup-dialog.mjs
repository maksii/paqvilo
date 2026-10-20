import { icon, navigationIcon } from './icons.mjs';

// All data access is supplied by the shell's same-origin adapter. Dismissal and
// replacement abort the view lifetime, so stale reads cannot select a new value.
export function createLookupDialog(field, { tables, api, tablePath, display, dialog, closeDialog, onDialogCancel, getLifetime, pickerButton }) {
  const targets = (field.targets ?? []).filter(entity => tables[entity]);
  if (!targets.length) return Promise.resolve(null);
  return new Promise(resolve => {
    const body = document.createElement('div'); body.className = 'lookup-browser';
    const controls = document.createElement('div'); controls.className = 'lookup-browser-toolbar';
    let target = targets[0], view;
    const targetHost = document.createElement('div'), viewHost = document.createElement('div');
    const searchBox = document.createElement('div'); searchBox.className = 'lookup-browser-search';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search'; search.setAttribute('aria-label', 'Search lookup records');
    const searchIcon = document.createElement('span'); searchIcon.innerHTML = icon('search'); searchBox.append(search, searchIcon);
    const mine = document.createElement('label'); mine.className = 'lookup-only-mine'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = true; mine.append(checkbox, document.createTextNode('Only my records')); mine.title = 'Filtering by record ownership is not supported locally.';
    const create = document.createElement('button'); create.type = 'button'; create.disabled = true; create.innerHTML = icon('add'); create.append(document.createTextNode('Add new record')); create.title = 'Creating a record from this lookup is not supported locally.';
    targetHost.hidden = targets.length === 1;
    controls.append(targetHost, viewHost, mine, create);
    const results = document.createElement('div'); results.className = 'lookup-results lookup-browser-results';
    const status = document.createElement('div'); status.className = 'lookup-browser-status'; status.setAttribute('role', 'status');
    const selection = document.createElement('div'); selection.className = 'lookup-browser-selected';
    body.append(searchBox, controls, results, status, selection);
    let selected, sequence = 0, timer, request;
    const title = () => `Choose ${(tables[target].singular ?? tables[target].label).toLocaleLowerCase()} for ${field.label}`;
    const element = dialog(title(), body, [['Done', () => { if (!selected) return; resolve(selected); closeDialog(); }, true], ['Cancel', () => { resolve(null); closeDialog(); }]]);
    element.classList.add('lookup-dialog');
    const lifetime = getLifetime();
    const close = document.createElement('button'); close.type = 'button'; close.className = 'lookup-dialog-close'; close.innerHTML = icon('close'); close.setAttribute('aria-label', 'Close'); close.addEventListener('click', () => { resolve(null); closeDialog(); }); element.prepend(close);
    lifetime.signal.addEventListener('abort', () => { clearTimeout(timer); request?.abort(); sequence++; element.classList.remove('lookup-dialog'); }, { once: true });
    onDialogCancel(element, () => resolve(null));
    const add = element.querySelector('.dialog-actions .primary'); add.disabled = true;
    const clearSelection = () => { selected = undefined; add.disabled = true; selection.replaceChildren(document.createTextNode('Selected record')); };
    const views = () => tables[target].lookupViews?.length ? tables[target].lookupViews : tables[target].views ?? [];
    const setViews = () => {
      const preferred = views().find(definition => definition.isDefault) ?? views()[0];
      view = preferred?.id; renderView();
    };
    const renderView = () => {
      const definitions = views();
      const trigger = pickerButton(definitions.find(definition => definition.id === view)?.name ?? 'Select a view', definitions.map(definition => ({ label: definition.name, value: definition.id, isDefault: definition.isDefault })), { label: 'Lookup view', selected: view, search: true, className: 'lookup-view-picker', choose: value => { view = value; renderView(); clearTimeout(timer); load(); } });
      viewHost.replaceChildren(trigger);
    };
    const renderTarget = () => {
      const trigger = pickerButton(tables[target].label, targets.map(entity => ({ label: tables[entity].label, value: entity })), { label: 'Lookup table', selected: target, className: 'lookup-table-picker', choose: entity => { target = entity; element.querySelector('#dialog-title').textContent = title(); renderTarget(); clearTimeout(timer); setViews(); load(); } });
      targetHost.replaceChildren(trigger);
    };
    function choose(record, destination, row) {
      selected = { id: record[destination.idColumn], entity: destination.entity, name: display(record[destination.nameColumn]) };
      add.disabled = false;
      for (const candidate of results.querySelectorAll('tr[aria-selected]')) { const active = candidate === row; candidate.setAttribute('aria-selected', String(active)); candidate.querySelector('input').checked = active; }
      const label = document.createElement('span'); label.textContent = selected.name || '(No name)';
      const remove = document.createElement('button'); remove.type = 'button'; remove.innerHTML = icon('close'); remove.setAttribute('aria-label', 'Remove selected record'); remove.addEventListener('click', () => { clearSelection(); for (const candidate of results.querySelectorAll('tr[aria-selected]')) { candidate.setAttribute('aria-selected', 'false'); candidate.querySelector('input').checked = false; } });
      const chip = document.createElement('span'); chip.className = 'lookup-browser-chip'; chip.append(label, remove); selection.replaceChildren(document.createTextNode('Selected record'), chip);
    }
    async function load() {
      if (lifetime.signal.aborted || !results.isConnected) return;
      const token = ++sequence, destination = tables[target]; clearSelection();
      request?.abort(); request = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, request.signal]);
      const definition = views().find(definition => definition.id === view);
      const columns = [...new Set([destination.nameColumn, ...(definition?.fields ?? []).map(field => field.name)])].filter(name => name !== destination.idColumn && destination.fields[name]).slice(0, 5);
      results.inert = true; results.setAttribute('aria-busy', 'true'); status.textContent = 'Searching records…'; results.replaceChildren();
      try {
        const found = await api(tablePath(destination.entity) + '?query=' + encodeURIComponent(JSON.stringify({ search: search.value, columns, pageSize: 50, view })), { signal });
        if (token !== sequence || lifetime.signal.aborted) return;
        const grid = document.createElement('table'); grid.setAttribute('aria-label', `${destination.label} lookup results`);
        const head = grid.createTHead().insertRow(); const selectionHeading = document.createElement('th'); selectionHeading.className = 'lookup-selection'; selectionHeading.setAttribute('aria-label', 'Selection'); head.append(selectionHeading);
        for (const name of columns) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = destination.fields[name]?.label ?? name; head.append(cell); }
        const tbody = grid.createTBody();
        for (const record of found.rows) {
          const row = tbody.insertRow(); row.setAttribute('aria-selected', 'false');
          const cell = row.insertCell(); cell.className = 'lookup-selection'; const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'lookup-record'; radio.setAttribute('aria-label', `Select ${display(record[destination.nameColumn]) || '(No name)'}`); cell.append(radio);
          for (const name of columns) { const cell = row.insertCell(); if (name === destination.nameColumn) { const glyph = document.createElement('span'); glyph.innerHTML = icon(navigationIcon({ entity: destination.entity })); const title = document.createElement('span'); title.textContent = display(record[name]) || '(No name)'; cell.append(glyph, title); } else cell.textContent = display(record[name + '@OData.Community.Display.V1.FormattedValue'] ?? record[name]); }
          row.addEventListener('click', () => choose(record, destination, row)); radio.addEventListener('change', () => choose(record, destination, row));
        }
        results.append(grid); status.textContent = found.rows.length ? `${found.rows.length} record${found.rows.length === 1 ? '' : 's'}${found.more ? ' (first 50)' : ''}` : 'No records found.';
      } catch (error) {
        if (token !== sequence || lifetime.signal.aborted) return;
        status.textContent = error.message + ' '; const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again'; retry.addEventListener('click', load); status.append(retry);
      } finally { if (token === sequence && !lifetime.signal.aborted) { results.inert = false; results.setAttribute('aria-busy', 'false'); } }
    }
    const schedule = () => { clearTimeout(timer); request?.abort(); sequence++; clearSelection(); results.inert = true; results.setAttribute('aria-busy', 'true'); timer = setTimeout(load, 250); };
    search.addEventListener('input', schedule);
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(timer); load(); } });
    renderTarget(); setViews(); load();
  });
}
