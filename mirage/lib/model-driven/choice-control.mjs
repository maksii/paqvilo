import { icon } from './icons.mjs';

// A field choice keeps focus on its input, like the model-driven combobox. The
// popup lives beside the field so form lifetime and security remain authoritative.
let nextId = 0;
export function renderChoice(field, value, { multiple = false, options = field.options ?? [], allowEmpty = true } = {}) {
  const element = document.createElement('div'); element.className = `choice-control${multiple ? ' choice-multiple' : ''}`;
  const primary = document.createElement('input'); primary.type = 'text';
  primary.setAttribute('role', 'combobox'); primary.setAttribute('aria-haspopup', 'listbox'); primary.setAttribute('aria-expanded', 'false'); primary.autocomplete = 'off';
  const chevron = document.createElement('span'); chevron.className = 'choice-chevron'; chevron.innerHTML = icon('chevron');
  const list = document.createElement('div'); list.id = `field-choices-${++nextId}`; list.className = 'choice-options'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', `${field.label ?? field.name} choices`); list.hidden = true;
  if (multiple) list.setAttribute('aria-multiselectable', 'true');
  primary.setAttribute('aria-controls', list.id);
  const values = multiple ? Array.isArray(value) ? [...value] : value == null || value === '' ? [] : String(value).split(',').map(Number) : value == null ? [] : [value];
  const entries = multiple ? [{ all: true, label: 'Select all' }, ...options] : allowEmpty ? [{ value: null, label: '--Select--' }, ...options] : options;
  let selected = values, active = -1, outside, typed = '', typingTimer, notifying = false, filterText = '', required = false, externalError = '', alive = true, keyboardActive = false;
  const nativeValidity = primary.setCustomValidity.bind(primary);
  const validate = () => nativeValidity(externalError || (required && !selected.length ? 'Select an option.' : ''));
  primary.setCustomValidity = message => { externalError = String(message); validate(); };
  // The visible text is a search query while expanded. Required validation
  // follows the selected choices even when a form script changes it at runtime.
  Object.defineProperty(primary, 'required', { configurable: true, get: () => required, set(value) { required = Boolean(value); primary.setAttribute('aria-required', String(required)); validate(); } });
  const same = (left, right) => left == null ? right == null : String(left) === String(right);
  const chosen = entry => entry.all ? options.length > 0 && options.every(option => selected.some(value => same(value, option.value))) : selected.some(value => same(value, entry.value)) || !multiple && entry.value == null && !selected.length;
  const update = () => {
    primary.value = multiple && !list.hidden ? filterText : selected.map(value => options.find(option => same(option.value, value))?.label ?? String(value)).join('; ');
    primary.placeholder = list.hidden ? '---' : multiple ? 'Select or search options' : '--Select--';
    for (const [index, option] of [...list.children].entries()) { option.setAttribute('aria-selected', String(chosen(entries[index]))); option.classList.toggle('active', keyboardActive && index === active); }
    validate();
    if (!list.hidden && active >= 0 && !list.children[active]?.hidden) primary.setAttribute('aria-activedescendant', `${list.id}-${active}`); else primary.removeAttribute('aria-activedescendant');
  };
  const filterOptions = (resetActive = false) => {
    const term = filterText.toLocaleLowerCase();
    for (const [index, option] of [...list.children].entries()) option.hidden = multiple && !entries[index].all && !entries[index].label.toLocaleLowerCase().includes(term);
    if (resetActive || active < 0 || list.children[active]?.hidden) active = [...list.children].findIndex((option, index) => !option.hidden && (!term || !entries[index].all));
  };
  const close = () => { list.hidden = true; element.classList.remove('open'); primary.setAttribute('aria-expanded', 'false'); primary.removeAttribute('aria-activedescendant'); outside?.abort(); clearTimeout(typingTimer); typed = ''; filterText = ''; update(); };
  const position = () => {
    const rect = element.getBoundingClientRect(), scrollRoot = element.closest('.record-content'), boundary = scrollRoot?.getBoundingClientRect(), pinned = scrollRoot?.querySelector(':scope>.record-card')?.getBoundingClientRect();
    const below = Math.min(innerHeight, boundary?.bottom ?? innerHeight) - rect.bottom, above = rect.top - Math.max(0, boundary?.top ?? 0, pinned?.bottom ?? 0);
    const isAbove = below < Math.min(240, list.scrollHeight) && above > below;
    list.classList.toggle('above', isAbove); list.style.maxHeight = `${Math.max(32, Math.min(240, (isAbove ? above : below) - 8))}px`;
  };
  // scrollIntoView can scroll the containing form and move its focused field.
  // Move only the list viewport when keyboard navigation reaches an edge.
  const revealActive = () => {
    const option = list.children[active]; if (!option) return;
    const row = option.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  };
  const open = (query = '') => {
    if (!alive || primary.disabled || !list.hidden) return;
    list.hidden = false; element.classList.add('open'); primary.setAttribute('aria-expanded', 'true'); active = Math.max(0, entries.findIndex(chosen)); keyboardActive = false; filterText = multiple ? query : ''; filterOptions(Boolean(filterText)); update(); position(); revealActive();
    outside = new AbortController();
    document.addEventListener('pointerdown', event => { if (!element.contains(event.target)) close(); }, { signal: outside.signal });
    window.addEventListener('resize', close, { signal: outside.signal });
    window.addEventListener('scroll', event => { if (!list.contains(event.target)) close(); }, { capture: true, signal: outside.signal });
  };
  const choose = index => {
    const entry = entries[index]; if (!alive || !entry || primary.disabled) return;
    selected = multiple ? entry.all ? chosen(entry) ? [] : options.map(option => option.value) : chosen(entry) ? selected.filter(value => !same(value, entry.value)) : [...selected, entry.value] : entry.value == null ? [] : [entry.value];
    update(); if (!multiple) close(); primary.focus();
    notifying = true; primary.dispatchEvent(new Event('input', { bubbles: true })); primary.dispatchEvent(new Event('change', { bubbles: true })); notifying = false;
  };
  for (const [index, entry] of entries.entries()) {
    const option = document.createElement('div'); option.id = `${list.id}-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-label', entry.label); option.textContent = entry.label;
    if (entry.all) { option.className = 'choice-select-all'; const count = document.createElement('span'); count.textContent = `${options.length} items`; count.setAttribute('aria-hidden', 'true'); option.append(count); }
    option.addEventListener('pointerdown', event => event.preventDefault()); option.addEventListener('click', () => choose(index)); list.append(option);
  }
  primary.addEventListener('beforeinput', event => { if (!multiple) event.preventDefault(); });
  primary.addEventListener('input', event => { if (!multiple || notifying) return; event.stopPropagation(); const term = primary.value; if (list.hidden) open(term); else { filterText = term; filterOptions(true); update(); position(); } });
  primary.addEventListener('click', () => list.hidden ? open() : close());
  primary.addEventListener('blur', close);
  primary.addEventListener('keydown', event => {
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const wasClosed = list.hidden; open();
      const visible = [...list.children].flatMap((option, index) => option.hidden ? [] : [index]), position = visible.indexOf(active);
      active = event.key === 'Home' ? visible[0] : event.key === 'End' ? visible.at(-1) : visible[Math.max(0, Math.min(visible.length - 1, position + (wasClosed ? 0 : event.key === 'ArrowDown' ? 1 : -1)))];
      keyboardActive = true; update(); revealActive(); return;
    }
    if (event.key === 'Enter' || event.key === ' ' && !multiple) { event.preventDefault(); if (list.hidden) open(); else choose(active); }
    else if (!multiple && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); open(); typed += event.key.toLocaleLowerCase(); clearTimeout(typingTimer); typingTimer = setTimeout(() => { typed = ''; }, 700);
      const index = entries.findIndex(entry => String(entry.label).toLocaleLowerCase().startsWith(typed));
      if (index >= 0) { active = index; keyboardActive = true; update(); revealActive(); }
    }
  });
  element.append(primary, chevron, list); update();
  return { element, primary, read: () => multiple ? selected.length ? [...selected] : null : selected[0] ?? null,
    setValue(value) { selected = multiple ? Array.isArray(value) ? [...value] : value == null || value === '' ? [] : String(value).split(',').map(Number) : value == null ? [] : [value]; update(); },
    setDisabled(disabled) { primary.disabled = disabled; if (disabled) close(); }, destroy() { alive = false; close(); } };
}
