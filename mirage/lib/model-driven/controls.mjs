// Controls are registered by supported metadata type. Unknown controls are explicit
// read-only placeholders. Trusted Solution PCF bundles use a separate lifecycle.
import { renderLookup } from './lookup-control.mjs';
import { controlDescriptor } from './control-descriptors.mjs';
import { renderPcfControl } from './pcf-runtime.mjs';
import { renderChoice } from './choice-control.mjs';
import { renderDate } from './date-control.mjs';
import { renderDuration } from './duration-control.mjs';
import { icon } from './icons.mjs';
const registry = new Map();
export const registerControl = (type, render) => registry.set(type, render);
export const hasControl = (field) => registry.has(controlDescriptor(field).type);
const input = (type, field, value) => {
  const control = document.createElement('input');
  control.type = type;
  control.value = value ?? '';
  control.placeholder = '---';
  if (field.maxLength) control.maxLength = field.maxLength;
  if (field.minValue !== undefined) control.min = field.minValue;
  if (field.maxValue !== undefined) control.max = field.maxValue;
  return { element: control, read: () => (control.value === '' ? null : control.value) };
};
registerControl('text', (field, value) => {
  const format = String(field.format ?? '').toLowerCase();
  const control = input(
    format === 'email' ? 'email' : format === 'url' ? 'url' : format === 'phone' ? 'tel' : 'text',
    field,
    value,
  );
  const action = {
    email: ['Send email', 'mail'],
    phone: ['Call phone number', 'phone'],
    url: ['Open website', 'globe'],
    ticker: ['Open ticker symbol', 'ticker'],
    tickersymbol: ['Open ticker symbol', 'ticker'],
  }[format];
  if (!action) return control;
  const element = document.createElement('div');
  element.className = 'text-action-control';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-field-action';
  button.disabled = true;
  button.setAttribute('aria-label', `${action[0]} for ${field.label ?? field.name}`);
  button.title = 'External field actions are not supported locally.';
  button.innerHTML = icon(action[1]);
  element.append(control.element, button);
  return {
    element,
    primary: control.element,
    read: control.read,
    setValue(next) {
      control.element.value = next ?? '';
    },
    setDisabled(next) {
      control.element.disabled = next;
    },
  };
});
registerControl('textarea', (field, value, context = {}) => {
  const control = document.createElement('textarea');
  const declared = context.rows ?? field.editorRows;
  control.rows = Number.isInteger(declared) && declared > 0 ? Math.min(100, declared) : 2;
  if (context.rows != null || !field.editorRows || control.rows === 2)
    control.style.height = `${control.rows * 20 + 16}px`;
  control.value = value ?? '';
  if (field.maxLength) control.maxLength = field.maxLength;
  return { element: control, read: () => control.value || null };
});
registerControl('json', (field, value) => {
  const control = document.createElement('textarea');
  control.rows = 5;
  control.value = value == null ? '' : JSON.stringify(value, null, 2);
  return { element: control, read: () => (control.value.trim() ? JSON.parse(control.value) : null) };
});
registerControl('number', (field, value, context = {}) => {
  if (String(field.format).toLowerCase() === 'duration') return renderDuration(field, value);
  if (field.options?.length) {
    return renderChoice(field, value);
  }
  const control = input('number', field, value);
  control.element.step = /int|bigint/.test(field.dataverseType ?? '') ? '1' : 'any';
  const element = document.createElement('div');
  element.className = 'number-control';
  const formatted = document.createElement('span');
  formatted.className = 'number-formatted';
  formatted.setAttribute('aria-hidden', 'true');
  const integer = /^(?:int|integer|bigint)$/.test(field.dataverseType ?? ''),
    money = /^(?:money|currency)$/.test(field.dataverseType ?? '');
  const precision = Number.isInteger(field.precision) ? Math.max(0, Math.min(20, field.precision)) : integer ? 0 : 2;
  // Reuse the record's own formatted currency symbol; no site-specific symbol
  // belongs in the control host. The organization adapter supplies annotations.
  const symbol = money ? String(context.formatted ?? '').replace(/[\d\s,.+\-−]/g, '') : '';
  const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
  let original = value;
  const refresh = () => {
    const raw = control.element.value;
    formatted.textContent =
      raw === ''
        ? ''
        : Object.is(Number(raw), Number(original)) && context.formatted != null
          ? String(context.formatted)
          : symbol + format.format(Number(raw));
    element.classList.toggle('has-number', raw !== '');
  };
  control.element.addEventListener('input', refresh);
  control.element.addEventListener('blur', refresh);
  element.append(control.element, formatted);
  refresh();
  return {
    element,
    primary: control.element,
    read: () => (control.element.value === '' ? null : Number(control.element.value)),
    setValue(next) {
      original = undefined;
      control.element.value = next ?? '';
      refresh();
    },
    setDisabled(next) {
      control.element.disabled = next;
    },
  };
});
registerControl('boolean', (field, value) => {
  // Dataverse can serialize TrueOption before FalseOption. The native two-option
  // control presents false then true while preserving each exported label.
  const choices = field.options?.length
    ? field.options
        .map((option) => ({ ...option, value: Boolean(Number(option.value)) }))
        .sort((left, right) => Number(left.value) - Number(right.value))
    : [
        { label: 'No', value: false },
        { label: 'Yes', value: true },
      ];
  return renderChoice(
    field,
    value == null ? null : value === true || value === 1 || value === 'true' || value === '1',
    { options: choices, allowEmpty: false },
  );
});
registerControl('multiselect', (field, value) => renderChoice(field, value, { multiple: true }));
registerControl('date', renderDate);
registerControl('lookup', renderLookup);
export function renderControl(field, value, context = {}) {
  const renderer = registry.get(controlDescriptor(field).type);
  if (!controlDescriptor(field).supported || !renderer) {
    const element = document.createElement('p');
    element.className = 'unsupported';
    element.textContent = 'This control is not supported locally yet.';
    return { element, read: () => value, supported: false };
  }
  if (context.pcf) return renderPcfControl(field, value, context);
  const rendered = context.readOnlyText
      ? (() => {
          let raw = value;
          const display = () =>
            raw == null
              ? ''
              : (field.options?.find((option) => String(option.value) === String(raw))?.label ?? String(raw));
          const control = input('text', field, display());
          return {
            element: control.element,
            read: () => raw,
            setValue(next) {
              raw = next;
              control.element.value = display();
            },
            setDisabled() {
              control.element.disabled = true;
            },
          };
        })()
      : renderer(field, value, context),
    primary = rendered.primary ?? rendered.element;
  primary.name = field.name;
  primary.id = `field-${field.name}`;
  primary.setAttribute('aria-label', field.label ?? field.name);
  primary.required = Boolean(field.required);
  primary.disabled = Boolean(context.disabled || context.readOnlyText);
  if (context.disabled)
    for (const control of rendered.element.querySelectorAll('button,input,select,textarea')) control.disabled = true;
  if (context.disabled) rendered.setDisabled?.(true);
  return { ...rendered, supported: true };
}
