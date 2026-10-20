// Controls are registered by supported metadata type. Unknown controls are explicit
// read-only placeholders; solution JavaScript is never evaluated by this registry.
import { icon, navigationIcon } from './icons.mjs';
import { controlDescriptor } from './control-descriptors.mjs';
const registry = new Map();
export const registerControl = (type, render) => registry.set(type, render);
export const hasControl = field => controlDescriptor(field).supported && registry.has(field.type ?? 'text');
const input = (type, field, value) => {
  const control = document.createElement('input'); control.type = type;
  control.value = value ?? ''; if (field.maxLength) control.maxLength = field.maxLength;
  if (field.minValue !== undefined) control.min = field.minValue;
  if (field.maxValue !== undefined) control.max = field.maxValue;
  return { element: control, read: () => control.value === '' ? null : control.value };
};
registerControl('text', (field, value) => input(field.format === 'email' ? 'email' : field.format === 'url' ? 'url' : 'text', field, value));
registerControl('textarea', (field, value) => { const control = document.createElement('textarea'); control.rows = /source|copy|javascript|css/.test(field.name) ? 12 : 5; control.value = value ?? ''; if (field.maxLength) control.maxLength = field.maxLength; return { element: control, read: () => control.value || null }; });
registerControl('json', (field, value) => { const control = document.createElement('textarea'); control.rows = 5; control.value = value == null ? '' : JSON.stringify(value, null, 2); return { element: control, read: () => control.value.trim() ? JSON.parse(control.value) : null }; });
registerControl('number', (field, value) => {
  if (field.options?.length) {
    const select = document.createElement('select'); select.add(new Option('— Select —', ''));
    for (const option of field.options) select.add(new Option(option.label, String(option.value)));
    select.value = value == null ? '' : String(value);
    return { element: select, read: () => select.value === '' ? null : Number(select.value) };
  }
  const control = input('number', field, value); control.element.step = /int|bigint/.test(field.dataverseType ?? '') ? '1' : 'any';
  return { element: control.element, read: () => control.element.value === '' ? null : Number(control.element.value) };
});
registerControl('boolean', (field, value) => {
  const select = document.createElement('select'); select.add(new Option('— Select —', '')); select.add(new Option('Yes', 'true')); select.add(new Option('No', 'false')); select.value = value == null ? '' : String(Boolean(value));
  return { element: select, read: () => select.value === '' ? null : select.value === 'true' };
});
registerControl('date', (field, value) => {
  const dateOnly = field.format === 'dateonly' || field.dateTimeBehavior === 'DateOnly';
  const date = value ? new Date(value) : null;
  const text = date && Number.isFinite(date.getTime()) ? dateOnly ? String(value).slice(0, 10) : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  const control = input(dateOnly ? 'date' : 'datetime-local', field, text);
  return { element: control.element, read: () => control.element.value ? dateOnly ? control.element.value : new Date(control.element.value).toISOString() : null };
});
registerControl('lookup', (field, value, context) => {
  const wrapper = document.createElement('div'); wrapper.className = 'lookup';
  let selectedId = value?.id ?? value?.value ?? value;
  let selectedName = context.formatted ?? value?.name;
  let selectedEntity = value?.entity ?? value?.logical_name ?? value?.logicalName ?? context.logicalName ?? (field.targets?.length === 1 ? field.targets[0] : undefined);
  const control = input('text', field, selectedName ?? selectedId); control.element.setAttribute('aria-label', field.label);
  const badge = document.createElement('span'); badge.className = 'lookup-kind';
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'lookup-clear'; clear.innerHTML = icon('close'); clear.setAttribute('aria-label', `Clear ${field.label}`);
  const selection = () => { wrapper.classList.toggle('has-selection', Boolean(selectedId)); clear.hidden = !selectedId; badge.hidden = !selectedId; badge.innerHTML = icon(navigationIcon({ entity: selectedEntity })); control.element.style.width = selectedId ? `${Math.max(40, String(control.element.value).length * 7.2 + 16)}px` : ''; control.element.setCustomValidity(control.element.value && !selectedEntity ? `Choose a target table using Look up ${field.label}; a record ID alone is ambiguous.` : ''); };
  control.element.addEventListener('input', () => { selectedId = null; selectedName = null; selectedEntity = field.targets?.length === 1 ? field.targets[0] : undefined; selection(); });
  clear.addEventListener('click', () => { selectedId = null; selectedName = null; selectedEntity = undefined; control.element.value = ''; selection(); wrapper.dispatchEvent(new Event('change', { bubbles: true })); });
  const find = document.createElement('button'); find.type = 'button'; find.innerHTML = icon('search'); find.setAttribute('aria-label', `Look up ${field.label}`);
  find.disabled = !field.targets?.some(entity => context.tables[entity]); find.title = find.disabled ? 'Target table metadata is unavailable; enter a local record ID.' : 'Choose a local record';
  find.addEventListener('click', async () => { const selected = await context.lookup(field); if (selected) { selectedId = selected.id; selectedName = selected.name; selectedEntity = selected.entity; control.element.value = selectedName ?? selectedId; selection(); wrapper.dispatchEvent(new Event('change', { bubbles: true })); } });
  wrapper.append(badge, control.element, clear, find); selection(); return { element: wrapper, primary: control.element, read: () => { const id = selectedId ?? control.read(); if (id == null) return null; if (!selectedEntity) throw new Error(`Choose a target table for ${field.label} using its lookup.`); return { id, entity: selectedEntity, ...(selectedName ? { name: selectedName } : {}) }; } };
});
export function renderControl(field, value, context = {}) {
  const renderer = registry.get(field.type ?? 'text');
  if (!controlDescriptor(field).supported || !renderer) { const element = document.createElement('p'); element.className = 'unsupported'; element.textContent = 'This control is not supported locally yet.'; return { element, read: () => value, supported: false }; }
  const rendered = renderer(field, value, context), primary = rendered.primary ?? rendered.element;
  primary.name = field.name; primary.id = `field-${field.name}`;
  primary.setAttribute('aria-label', field.label ?? field.name);
  primary.required = Boolean(field.required); primary.disabled = Boolean(context.disabled);
  if (context.disabled) for (const control of rendered.element.querySelectorAll('button,input,select,textarea')) control.disabled = true;
  return { ...rendered, supported: true };
}
