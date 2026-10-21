import { icon, navigationIcon } from './icons.mjs';

let nextId = 0;
export function renderLookup(field, value, context) {
  const element = document.createElement('div'); element.className = 'lookup';
  const primary = document.createElement('input'); primary.type = 'text'; primary.autocomplete = 'off'; primary.placeholder = '---';
  primary.setAttribute('role', 'combobox'); primary.setAttribute('aria-autocomplete', 'list'); primary.setAttribute('aria-expanded', 'false'); primary.setAttribute('aria-haspopup', 'listbox');
  let selectedId = value?.id ?? value?.value ?? value, selectedName = context.formatted ?? value?.name;
  let selectedEntity = value?.entity ?? value?.logical_name ?? value?.logicalName ?? context.logicalName ?? (field.targets?.length === 1 ? field.targets[0] : undefined);
  let externalError = ''; const nativeValidity = primary.setCustomValidity.bind(primary);
  const validate = () => nativeValidity(externalError || (!selectedId && primary.value ? 'Select a record from the lookup results.' : ''));
  primary.setCustomValidity = message => { externalError = String(message); validate(); };
  const badge = document.createElement('span'); badge.className = 'lookup-kind';
  const makeButton = (label, glyph, className) => { const button = document.createElement('button'); button.type = 'button'; button.className = className ?? ''; button.innerHTML = icon(glyph); button.setAttribute('aria-label', label); return button; };
  const clear = makeButton(`Clear ${field.label}`, 'close', 'lookup-clear'), find = makeButton(`Look up ${field.label}`, 'search');
  const available = field.targets?.some(entity => context.tables?.[entity]);
  find.disabled = !available; find.title = available ? 'Search records' : 'Target table metadata is unavailable.';
  const popup = document.createElement('div'); popup.className = 'lookup-suggestions'; popup.hidden = true;
  const results = document.createElement('div'); results.id = `lookup-suggestions-${++nextId}`; results.setAttribute('role', 'listbox'); results.setAttribute('aria-label', `${field.label} records`);
  primary.setAttribute('aria-controls', results.id);
  const footer = document.createElement('div'); footer.className = 'lookup-suggestions-footer';
  const create = makeButton('New', 'add'); create.append(document.createTextNode('New')); create.disabled = true; create.title = 'Creating a record from this lookup is not supported locally.';
  const advanced = makeButton('Advanced', 'search'); advanced.append(document.createTextNode('Advanced')); footer.append(create, advanced); popup.append(results, footer);
  let alive = true, pending = false, timer, request, lifetime, sequence = 0, active = -1, found = [];
  const update = () => {
    element.classList.toggle('has-selection', Boolean(selectedId)); clear.hidden = !selectedId; badge.hidden = !selectedId;
    badge.innerHTML = icon(navigationIcon({ entity: selectedEntity }));
    primary.style.width = selectedId ? `${Math.max(40, primary.value.length * 7.2 + 16)}px` : '';
    validate();
  };
  const close = () => { clearTimeout(timer); request?.abort(); lifetime?.abort(); sequence++; popup.hidden = true; primary.placeholder = '---'; primary.setAttribute('aria-expanded', 'false'); primary.removeAttribute('aria-activedescendant'); };
  const choose = selected => {
    if (!alive || primary.disabled) return;
    selectedId = selected.id; selectedEntity = selected.entity; selectedName = selected.name; primary.value = selectedName ?? selectedId; close(); update();
    element.dispatchEvent(new Event('change', { bubbles: true })); primary.focus();
  };
  const position = () => {
    const rect = element.getBoundingClientRect(), scrollRoot = element.closest('.record-content'), boundary = scrollRoot?.getBoundingClientRect(), pinned = scrollRoot?.querySelector(':scope>.record-card')?.getBoundingClientRect();
    const below = Math.min(innerHeight, boundary?.bottom ?? innerHeight) - rect.bottom, above = rect.top - Math.max(0, boundary?.top ?? 0, pinned?.bottom ?? 0);
    const desired = Math.min(240, results.scrollHeight) + footer.getBoundingClientRect().height;
    const isAbove = below < desired && above > below; popup.classList.toggle('above', isAbove);
    results.style.maxHeight = `${Math.max(40, Math.min(240, (isAbove ? above : below) - footer.getBoundingClientRect().height - 8))}px`;
  };
  const open = () => {
    if (!alive || primary.disabled || !available) return false;
    if (popup.hidden) {
      popup.hidden = false; primary.setAttribute('aria-expanded', 'true'); primary.placeholder = `Look for ${field.label}`; lifetime = new AbortController();
      document.addEventListener('pointerdown', event => { if (!element.contains(event.target)) close(); }, { signal: lifetime.signal });
      element.addEventListener('focusout', event => { if (!element.contains(event.relatedTarget)) close(); }, { signal: lifetime.signal });
      window.addEventListener('resize', close, { signal: lifetime.signal });
      window.addEventListener('scroll', event => { if (!popup.contains(event.target)) close(); }, { capture: true, signal: lifetime.signal });
    }
    position(); return true;
  };
  const render = () => {
    results.replaceChildren();
    for (const [index, record] of found.entries()) {
      const row = makeButton(record.name || '(No name)', navigationIcon({ entity: record.entity }), 'lookup-suggestion'); row.setAttribute('role', 'option'); row.id = `${results.id}-${index}`; row.tabIndex = -1;
      row.setAttribute('aria-selected', String(index === active)); row.append(document.createTextNode(record.name || '(No name)'));
      row.addEventListener('pointerdown', event => event.preventDefault()); row.addEventListener('click', () => choose(record)); results.append(row);
    }
    if (active >= 0) primary.setAttribute('aria-activedescendant', `${results.id}-${active}`); else primary.removeAttribute('aria-activedescendant');
    if (!found.length) { const empty = document.createElement('p'); empty.textContent = 'No records found.'; results.append(empty); }
  };
  async function load() {
    if (!open()) return;
    const token = ++sequence; request?.abort(); request = new AbortController(); active = -1; found = [];
    results.setAttribute('aria-busy', 'true'); results.textContent = 'Loading…';
    try {
      const rows = await context.lookupSuggestions(field, selectedId ? '' : primary.value, { signal: request.signal });
      if (token !== sequence || !alive || primary.disabled) return; found = rows; render(); position();
    } catch (error) {
      if (token !== sequence || request.signal.aborted || !alive) return;
      results.textContent = error.message;
    } finally { if (token === sequence && alive) results.setAttribute('aria-busy', 'false'); }
  }
  async function browse() {
    if (!alive || pending || primary.disabled) return; close(); pending = true; find.disabled = true;
    try { const selected = await context.lookup(field); if (selected) choose(selected); }
    finally { pending = false; find.disabled = !available || primary.disabled; }
  }
  primary.value = selectedName ?? selectedId ?? '';
  primary.addEventListener('input', () => {
    if (!alive || primary.disabled) return;
    selectedId = null; selectedName = null; selectedEntity = undefined; update(); close(); found = []; active = -1; primary.removeAttribute('aria-activedescendant'); results.replaceChildren(); results.textContent = 'Loading…'; results.setAttribute('aria-busy', 'true');
    if (typeof context.lookupSuggestions === 'function' && open()) { const token = sequence; timer = setTimeout(() => { if (token === sequence) load(); }, 250); }
  });
  primary.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); if (popup.hidden) { if (context.lookupSuggestions) load(); else browse(); return; }
      active = Math.max(0, Math.min(found.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); render();
      const row = results.children[active]?.getBoundingClientRect(), viewport = results.getBoundingClientRect();
      if (row?.top < viewport.top) results.scrollTop -= viewport.top - row.top;
      else if (row?.bottom > viewport.bottom) results.scrollTop += row.bottom - viewport.bottom;
    } else if (event.key === 'Enter' && !popup.hidden) { event.preventDefault(); if (found[active]) choose(found[active]); }
  });
  clear.addEventListener('click', () => { if (!alive || primary.disabled) return; selectedId = null; selectedName = null; selectedEntity = undefined; primary.value = ''; close(); update(); element.dispatchEvent(new Event('change', { bubbles: true })); primary.focus(); });
  find.addEventListener('click', () => { if (context.lookupSuggestions) { primary.focus(); load(); } else browse(); });
  advanced.addEventListener('click', browse);
  element.append(badge, primary, clear, find, popup); update();
  return { element, primary, read() { if (!selectedId) { if (primary.value) throw new Error(`Select a record for ${field.label} from its lookup.`); return null; } if (!selectedEntity) throw new Error(`Choose a target table for ${field.label} using its lookup.`); return { id: selectedId, entity: selectedEntity, ...(selectedName ? { name: selectedName } : {}) }; },
    setDisabled(disabled) { primary.disabled = disabled; clear.disabled = disabled; find.disabled = disabled || !available || pending; if (disabled) close(); },
    destroy() { alive = false; close(); } };
}
