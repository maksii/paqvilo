import { indexPersonaCatalog, filterPersonaIndex, personaFilters, personaRowKey, foldPersonaText } from './persona-search.mjs';
import { personaCard, personaDetailsView, personaHtml } from './persona-picker-view.mjs';

const mounted = new WeakMap();
const read = key => { try {
  const value = JSON.parse(localStorage.getItem(key) ?? '{}');
  const list = (name, limit) => Array.isArray(value?.[name]) ? [...new Set(value[name].filter(item => typeof item === 'string'))].slice(0, limit) : [];
  return {pinned:list('pinned',1000),recent:list('recent',5)};
} catch { return {pinned:[],recent:[]}; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* optional browser preference */ } };
const storageKey = report => `paqvilo:persona-picker:${report.scope ?? 'local'}`;
export function rememberPersona(report, key) {
  const value = read(storageKey(report));
  value.recent = [key, ...(value.recent ?? []).filter(entry => entry !== key)].slice(0, 5);
  write(storageKey(report), value);
}

/** Mount on a stable picker node. Typing only updates row visibility/counts;
 * it never redraws the search input or the surrounding administration view. */
export function mountPersonaPicker(root, report, { filters = {}, onSelect, onFilterChange } = {}) {
  if (mounted.has(root)) return mounted.get(root);
  const index = indexPersonaCatalog(report), byKey = new Map(index.map(entry => [entry.key, entry.persona]));
  const contexts = new Map((report.contexts ?? []).map(context => [context.id, context]));
  const mode = root.dataset.personaMode;
  const preferences = read(storageKey(report));
  let selected = root.querySelector('[data-selected="true"]')?.dataset.personaRow ?? null;
  let state = { q: '', roles: [], accounts: [], groups: [], tags: [], hideNoRoles: false, ...filters };
  let rows = [], frame;
  const groupNodes = [...root.querySelectorAll('[data-persona-group], [data-persona-subgroup]')];
  const openGroups = new Map(groupNodes.map(node => [node, node.open]));
  const query = root.querySelector('[data-persona-query]');
  const defaultSection = root.querySelector('[data-persona-default]');
  if (defaultSection) root.insertBefore(defaultSection, root.querySelector('[data-persona-shortcuts="pinned"]'));
  root.querySelector('[data-persona-tools]').hidden = false;
  const active = () => Boolean(state.q || state.hideNoRoles || ['roles', 'accounts', 'groups', 'tags'].some(name => state[name]?.length));
  const collectRows = () => {
    rows = [...root.querySelectorAll('[data-persona-row]')];
    for (const button of root.querySelectorAll('[data-persona-pin], [data-persona-details]')) button.hidden = false;
    for (const button of root.querySelectorAll('[data-persona-pin]')) {
      const pinned = (preferences.pinned ?? []).includes(button.dataset.personaPin);
      button.setAttribute('aria-pressed', String(pinned)); button.textContent = pinned ? '★' : '☆';
    }
  };
  const shortcuts = () => {
    for (const type of ['pinned', 'recent']) {
      const section = root.querySelector(`[data-persona-shortcuts="${type}"]`);
      const entries = (preferences[type] ?? []).filter(key => byKey.has(key) && (type !== 'recent' || !(preferences.pinned ?? []).includes(key))).map(key => byKey.get(key));
      section.querySelector('[data-persona-shortcut-list]').innerHTML = `<ul class="persona-list">${entries.map(persona => personaCard(persona, { mode, selectedKey: selected, contexts, shortcut: true })).join('')}</ul>`;
      section.hidden = !entries.length;
    }
    collectRows();
  };
  const update = (started = performance.now()) => {
    const matches = filterPersonaIndex(index, state), keys = new Set(matches.map(entry => entry.key));
    const counts = new Map(), subcounts = new Map();
    for (const entry of matches) {
      counts.set(entry.persona.group, (counts.get(entry.persona.group) ?? 0) + 1);
      if (entry.persona.subgroup) { const key = `${entry.persona.group}:${entry.persona.subgroup}`; subcounts.set(key, (subcounts.get(key) ?? 0) + 1); }
    }
    for (const node of rows) node.hidden = !keys.has(node.dataset.personaRow);
    for (const node of groupNodes) {
      const group = node.dataset.personaGroup, subgroup = node.dataset.personaSubgroup;
      const count = subgroup ? subcounts.get(subgroup) ?? 0 : counts.get(group) ?? 0;
      node.hidden = !count;
      node.querySelector(':scope > summary .persona-group-count').textContent = String(count);
      if (active()) node.open = count > 0;
      else node.open = openGroups.get(node) ?? false;
    }
    if (defaultSection) defaultSection.hidden = !defaultSection.querySelector('[data-persona-row]:not([hidden])');
    for (const section of root.querySelectorAll('[data-persona-shortcuts]')) section.hidden = !section.querySelector('[data-persona-row]:not([hidden])');
    root.querySelector('[data-persona-result-count]').textContent = `${matches.length} of ${report.total}`;
    root.querySelector('[data-persona-empty]').hidden = matches.length > 0;
    root.dataset.personaMatchedCount = String(matches.length);
    root.dataset.personaFilterMs = String(Math.round((performance.now() - started) * 100) / 100);
    for (const name of ['roles', 'accounts', 'groups', 'tags']) root.querySelector(`[data-persona-facet-count="${name}"]`).textContent = state[name]?.length ? ` (${state[name].length})` : '';
    root.dispatchEvent(new CustomEvent('persona-filtered', { bubbles: true, detail: { count: matches.length, total: report.total, durationMs: Number(root.dataset.personaFilterMs) } }));
  };
  const schedule = () => {
    const started = performance.now(); cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (!root.isConnected) return; update(started); onFilterChange?.(state); });
  };
  const syncControls = () => {
    query.value = state.q ?? ''; root.querySelector('[data-persona-roles-only]').checked = Boolean(state.hideNoRoles);
    for (const checkbox of root.querySelectorAll('[data-persona-filter]')) checkbox.checked = (state[checkbox.dataset.personaFilter] ?? []).includes(checkbox.value);
  };
  const facet = name => {
    const options = new Map(), groupLabels = new Map((report.groups ?? []).map(group => [group.id, group.label]));
    const add = (value, label) => { const previous = options.get(value); options.set(value, { value, label, count: (previous?.count ?? 0) + 1 }); };
    for (const { persona } of index) {
      if (name === 'roles') for (const value of persona.roles ?? []) add(value, value);
      else if (name === 'tags') for (const value of persona.tags ?? []) add(value, value);
      else if (name === 'groups') add(persona.group, groupLabels.get(persona.group) ?? 'Other contacts');
      else add(persona.account?.id || persona.account?.name || '__none', persona.account?.name || persona.account?.id || 'No account');
    }
    return [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
  };
  root.addEventListener('toggle', event => {
    const target = event.target;
    if (target.dataset.personaFacet && target.open && !target.dataset.personaLoaded) {
      const name = target.dataset.personaFacet, options = facet(name);
      target.querySelector('[data-persona-options]').innerHTML = `${options.length > 10 ? `<input type="search" data-persona-facet-search="${name}" aria-label="Find ${name}" placeholder="Find ${name}">` : ''}${options.map(option => `<label><input type="checkbox" data-persona-filter="${name}" value="${personaHtml(option.value)}"${(state[name] ?? []).includes(option.value) ? ' checked' : ''}><span>${personaHtml(option.label)} <small>(${option.count})</small></span></label>`).join('') || '<p>No values available.</p>'}`;
      target.dataset.personaLoaded = 'true';
    } else if (groupNodes.includes(target) && !active()) openGroups.set(target, target.open);
  }, true);
  root.addEventListener('input', event => {
    if (event.target.matches('[data-persona-query]')) { state.q = event.target.value; schedule(); }
    if (event.target.dataset.personaFacetSearch) {
      const wanted = foldPersonaText(event.target.value);
      for (const label of event.target.parentElement.querySelectorAll('label')) label.hidden = !foldPersonaText(label.textContent).includes(wanted);
    }
  });
  query.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  root.addEventListener('change', event => {
    const name = event.target.dataset.personaFilter;
    if (name) state[name] = [...root.querySelectorAll(`[data-persona-filter="${name}"]:checked`)].map(input => input.value);
    else if (event.target.matches('[data-persona-roles-only]')) state.hideNoRoles = event.target.checked;
    else return;
    schedule();
  });
  root.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || !root.contains(button)) return;
    if (button.hasAttribute('data-persona-clear')) {
      state = { q: '', roles: [], accounts: [], groups: [], tags: [], hideNoRoles: false }; syncControls(); schedule(); return;
    }
    if (button.dataset.personaPin) {
      const key = button.dataset.personaPin, pinned = new Set(preferences.pinned ?? []);
      if (pinned.has(key)) pinned.delete(key); else pinned.add(key);
      preferences.pinned = [...pinned]; write(storageKey(report), preferences); shortcuts(); update(); return;
    }
    if (button.dataset.personaDetails) {
      const persona = byKey.get(button.dataset.personaDetails), dialog = document.createElement('dialog');
      dialog.className = 'persona-dialog';
      dialog.setAttribute('aria-label', `Persona details: ${persona.label ?? persona.name}`);
      dialog.innerHTML = `<button type="button" class="persona-button persona-dialog-close">Close</button>${personaDetailsView(persona, contexts.get(persona.context))}`;
      dialog.querySelector('button').addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal(); return;
    }
    if (button.dataset.personaChoose) {
      selected = button.dataset.personaChoose;
      for (const node of rows) { const chosen = node.dataset.personaRow === selected; node.dataset.selected = String(chosen); const action = node.querySelector('[data-persona-choose]'); if (action) { action.setAttribute('aria-pressed', String(chosen)); action.textContent = chosen ? 'Selected' : 'Choose'; action.classList.toggle('persona-primary', chosen); } }
      onSelect?.(byKey.get(selected), selected);
      root.dispatchEvent(new CustomEvent('persona-selected', { bubbles: true, detail: { persona: byKey.get(selected), key: selected } }));
    }
  });
  const form = root.closest('form');
  form?.addEventListener('submit', event => {
    if (mode !== 'signin') return;
    const key = event.submitter?.name === 'personaKey' ? event.submitter.value : event.submitter?.name === 'contactId' ? `@contact:${event.submitter.value}` : null;
    if (key) try { sessionStorage.setItem('paqvilo:pending-persona', JSON.stringify({ key, contactId: byKey.get(key)?.contactId, at: Date.now() })); } catch { /* optional preference */ }
  });
  try {
    const pending = JSON.parse(sessionStorage.getItem('paqvilo:pending-persona') ?? 'null');
    if (pending && Date.now() - pending.at < 300000 && report.session?.signedIn && report.session.contactId === pending.contactId) { rememberPersona(report, pending.key); preferences.recent = read(storageKey(report)).recent; sessionStorage.removeItem('paqvilo:pending-persona'); }
  } catch { /* optional preference */ }
  shortcuts(); syncControls(); update();
  const controller = { setFilters(next) { state = { ...state, ...next }; syncControls(); update(); }, remember(key) { rememberPersona(report, key); preferences.recent = read(storageKey(report)).recent; shortcuts(); update(); }, getFilters: () => ({ ...state }), report };
  mounted.set(root, controller); return controller;
}

async function enhanceSignIn() {
  const roots = [...document.querySelectorAll('[data-persona-picker][data-persona-mode="signin"]')];
  if (!roots.length) return;
  try {
    const response = await fetch('/__sim/api/personas'); if (!response.ok) return;
    const report = await response.json(); if (!report.enabled) return;
    for (const root of roots) mountPersonaPicker(root, report, { filters: personaFilters(location.search), onFilterChange: state => {
      const url = new URL(location.href);
      for (const name of ['q', 'role', 'account', 'group', 'tag', 'rolesOnly']) url.searchParams.delete(name);
      if (state.q) url.searchParams.set('q', state.q);
      for (const [field, name] of [['roles', 'role'], ['accounts', 'account'], ['groups', 'group'], ['tags', 'tag']]) for (const value of state[field] ?? []) url.searchParams.append(name, value);
      if (state.hideNoRoles) url.searchParams.set('rolesOnly', '1'); history.replaceState(null, '', url);
    } });
  } catch { /* Server-rendered groups remain usable without enhancement. */ }
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhanceSignIn, { once: true }); else enhanceSignIn();
}
