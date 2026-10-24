import { icon } from './icons.mjs';

// The native duration selector stores whole minutes. The observed English
// choices are platform defaults; exported column bounds still apply.
const choices = [
  1, 15, 30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360, 390, 420, 450, 480, 1440, 2880, 4320,
];
const invalidDuration =
  'The duration must be entered in the following format: x minutes, x hours or x days. Hours and days can also be entered using decimals, for example, x.x hours or x.x days.';
let nextId = 0;
export function parseDuration(text) {
  const input = String(text ?? '').trim();
  if (!input) return null;
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(minutes?|hours?|days?)?$/i.exec(input);
  if (!match) return undefined;
  const unit = (match[2] ?? 'minutes').toLowerCase(),
    amount = Number(match[1]);
  const value = Math.round(amount * (unit.startsWith('day') ? 1440 : unit.startsWith('hour') ? 60 : 1));
  return Number.isSafeInteger(value) ? value : undefined;
}
export function formatDuration(value) {
  if (value == null || value === '') return '';
  const unit = value >= 1440 ? 'day' : value >= 60 ? 'hour' : 'minute',
    amount = Number((value / (unit === 'day' ? 1440 : unit === 'hour' ? 60 : 1)).toFixed(2));
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}
export function renderDuration(field, initialValue, _context = {}) {
  const element = document.createElement('div');
  element.className = 'duration-control';
  const primary = document.createElement('input');
  primary.type = 'text';
  primary.autocomplete = 'off';
  primary.placeholder = '---';
  primary.setAttribute('role', 'combobox');
  primary.setAttribute('aria-haspopup', 'listbox');
  primary.setAttribute('aria-expanded', 'false');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'duration-trigger';
  trigger.setAttribute('aria-label', `Open duration options for ${field.label ?? field.name}`);
  trigger.innerHTML = icon('chevron');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.tabIndex = -1;
  clear.className = 'duration-clear';
  clear.setAttribute('aria-label', `Clear ${field.label ?? field.name}`);
  clear.innerHTML = icon('close');
  const list = document.createElement('div');
  list.id = `duration-options-${++nextId}`;
  list.className = 'duration-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', `${field.label ?? field.name} duration options`);
  list.hidden = true;
  primary.setAttribute('aria-controls', list.id);
  const error = document.createElement('div');
  error.id = `${list.id}-error`;
  error.className = 'duration-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  primary.setAttribute('aria-describedby', error.id);
  let value = initialValue == null || initialValue === '' ? null : Number(initialValue),
    edited = false,
    preserveText = false,
    active = -1,
    alive = true,
    lifetime,
    validationError = '',
    externalError = '';
  const nativeValidity = primary.setCustomValidity.bind(primary);
  primary.setCustomValidity = (message) => {
    externalError = String(message);
    nativeValidity(externalError || validationError);
  };
  const reason = (next) =>
    next === undefined || (next != null && (!Number.isSafeInteger(next) || next < 0))
      ? invalidDuration
      : next != null && field.minValue !== undefined && next < field.minValue
        ? `Enter a duration of at least ${formatDuration(field.minValue)}.`
        : next != null && field.maxValue !== undefined && next > field.maxValue
          ? `Enter a duration no greater than ${formatDuration(field.maxValue)}.`
          : '';
  const validate = (show = false) => {
    const next = edited ? parseDuration(primary.value) : value,
      message = reason(next);
    nativeValidity(externalError || message);
    clear.hidden = !primary.value;
    validationError = message;
    if (show) {
      error.textContent = message ? `${field.label ?? field.name}: ${message}` : '';
      error.hidden = !message;
    }
    return { next, valid: !message };
  };
  const markActive = () => {
    for (const [index, node] of [...list.children].entries()) {
      node.classList.toggle('active', index === active);
      node.setAttribute('aria-selected', String(choices[index] === value));
    }
    if (!list.hidden && active >= 0) primary.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else primary.removeAttribute('aria-activedescendant');
  };
  const revealActive = () => {
    const row = list.children[active]?.getBoundingClientRect(),
      viewport = list.getBoundingClientRect();
    if (row?.top < viewport.top) list.scrollTop -= viewport.top - row.top;
    else if (row?.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  };
  const close = (focus = false) => {
    list.hidden = true;
    primary.setAttribute('aria-expanded', 'false');
    primary.removeAttribute('aria-activedescendant');
    lifetime?.abort();
    if (focus && alive && !primary.disabled) primary.focus();
  };
  const commit = (show = true) => {
    const state = validate(show);
    if (state.valid) {
      if (edited) preserveText = state.next === value;
      value = state.next;
      edited = false;
      primary.value = preserveText ? primary.value.trim() : formatDuration(value);
    }
    return state;
  };
  const choose = (next) => {
    if (!alive || primary.disabled || reason(next)) return;
    value = next;
    edited = false;
    preserveText = false;
    primary.value = formatDuration(next);
    validate(true);
    close(true);
    primary.dispatchEvent(new Event('input', { bubbles: true }));
    primary.dispatchEvent(new Event('change', { bubbles: true }));
    edited = false;
  };
  const open = () => {
    if (!alive || primary.disabled || !list.hidden) return;
    list.hidden = false;
    primary.setAttribute('aria-expanded', 'true');
    active = choices.indexOf(validate().next);
    if (active < 0) active = 0;
    const scrollRoot = element.closest('.record-content');
    const bounds = () => {
      const boundary = scrollRoot?.getBoundingClientRect(),
        pinned = scrollRoot?.querySelector(':scope>.record-card')?.getBoundingClientRect();
      return {
        top: Math.max(0, boundary?.top ?? 0, pinned?.bottom ?? 0),
        bottom: Math.min(innerHeight, boundary?.bottom ?? innerHeight),
      };
    };
    let rect = element.getBoundingClientRect(),
      edge = bounds();
    // Browser focus can scroll a field underneath a sticky form header. Bring
    // it back into the usable form area before measuring the options viewport.
    if (
      scrollRoot &&
      (rect.top < edge.top + 8 ||
        rect.bottom > edge.bottom - 8 ||
        (edge.bottom - rect.bottom < 458 && edge.bottom - edge.top >= rect.height + 466))
    ) {
      scrollRoot.scrollTop += rect.top - (edge.top + 8);
      rect = element.getBoundingClientRect();
      edge = bounds();
    }
    const below = edge.bottom - rect.bottom,
      above = rect.top - edge.top;
    const isAbove = below < Math.min(450, list.scrollHeight) && above > below;
    list.classList.toggle('above', isAbove);
    list.style.maxHeight = `${Math.max(80, Math.min(450, (isAbove ? above : below) - 8))}px`;
    markActive();
    lifetime = new AbortController();
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!element.contains(event.target)) close();
      },
      { signal: lifetime.signal },
    );
    element.addEventListener(
      'focusout',
      (event) => {
        if (!element.contains(event.relatedTarget)) close();
      },
      { signal: lifetime.signal },
    );
    window.addEventListener('resize', () => close(), { signal: lifetime.signal });
    window.addEventListener(
      'scroll',
      (event) => {
        if (list.contains(event.target)) return;
        const edge = bounds(),
          field = element.getBoundingClientRect(),
          popup = list.getBoundingClientRect();
        if (field.top < edge.top || field.bottom > edge.bottom || popup.top < edge.top || popup.bottom > edge.bottom)
          close();
      },
      { capture: true, signal: lifetime.signal },
    );
    revealActive();
  };
  for (const [index, minutes] of choices.entries()) {
    const option = document.createElement('div');
    option.id = `${list.id}-${index}`;
    option.setAttribute('role', 'option');
    option.textContent = formatDuration(minutes);
    option.setAttribute('aria-disabled', String(Boolean(reason(minutes))));
    option.addEventListener('pointerdown', (event) => event.preventDefault());
    option.addEventListener('click', () => choose(minutes));
    list.append(option);
  }
  primary.addEventListener('input', () => {
    edited = true;
    validate();
  });
  primary.addEventListener('click', open);
  primary.addEventListener('blur', () => commit());
  primary.addEventListener('invalid', () => validate(true));
  primary.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      commit();
      close();
    } else if (
      ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) &&
      (!list.hidden || event.key.startsWith('Arrow'))
    ) {
      event.preventDefault();
      const wasClosed = list.hidden;
      open();
      const enabled = choices.flatMap((value, index) => (reason(value) ? [] : [index])),
        position = enabled.indexOf(active);
      active =
        event.key === 'Home'
          ? enabled[0]
          : event.key === 'End'
            ? enabled.at(-1)
            : enabled[
                Math.max(
                  0,
                  Math.min(enabled.length - 1, position + (wasClosed ? 0 : event.key === 'ArrowDown' ? 1 : -1)),
                )
              ];
      markActive();
      revealActive();
    } else if (event.key === 'Enter') {
      if (!list.hidden) {
        event.preventDefault();
        if (choices[active] !== undefined) choose(choices[active]);
      } else commit();
    }
  });
  trigger.addEventListener('pointerdown', (event) => event.preventDefault());
  trigger.addEventListener('click', () => {
    primary.focus({ preventScroll: true });
    if (list.hidden) open();
    else close();
  });
  clear.addEventListener('pointerdown', (event) => event.preventDefault());
  clear.addEventListener('click', () => {
    if (!alive || primary.disabled) return;
    value = null;
    edited = false;
    preserveText = false;
    primary.value = '';
    validate(true);
    close(true);
    primary.dispatchEvent(new Event('input', { bubbles: true }));
    primary.dispatchEvent(new Event('change', { bubbles: true }));
    edited = false;
  });
  primary.value = formatDuration(value);
  element.append(primary, clear, trigger, list, error);
  validate();
  return {
    element,
    primary,
    read() {
      const state = validate(true);
      if (!state.valid) throw new Error(`${field.label ?? field.name}: ${validationError}`);
      return state.next;
    },
    setValue(next) {
      value = next == null || next === '' ? null : Number(next);
      edited = false;
      preserveText = false;
      primary.value = formatDuration(value);
      validate(true);
      markActive();
    },
    setDisabled(disabled) {
      primary.disabled = disabled;
      trigger.disabled = disabled;
      clear.disabled = disabled;
      if (disabled) close();
    },
    destroy() {
      alive = false;
      close();
    },
  };
}
