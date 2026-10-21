import { icon } from './icons.mjs';

const pad = value => String(value).padStart(2, '0');
const keyOf = date => `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localDate = (year, month, day) => { const date = new Date(0); date.setHours(0, 0, 0, 0); date.setFullYear(year, month, day); return date; };
function parseDate(text) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim()), display = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!iso && !display) return null;
  const year = Number(iso?.[1] ?? display[3]), month = Number(iso?.[2] ?? display[1]) - 1, day = Number(iso?.[3] ?? display[2]);
  const date = localDate(year, month, day);
  return year >= 1 && year <= 9999 && date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
}
const dateText = date => `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[1]); const minute = Number(match[2]), suffix = match[3]?.toUpperCase();
  if (minute > 59 || hour > (suffix ? 12 : 23) || suffix && hour < 1) return null;
  if (suffix) hour = hour % 12 + (suffix === 'PM' ? 12 : 0);
  return { hour, minute };
}
const timeText = ({ hour, minute }) => `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
let nextId = 0;

export function renderDate(field, initialValue, context = {}) {
  const onlyDate = String(field.format).toLowerCase() === 'dateonly' || field.dateTimeBehavior === 'DateOnly';
  const independent = field.dateTimeBehavior === 'TimeZoneIndependent';
  const offset = context.formatting?.timeZoneOffsetMinutes, staffTimeZone = !onlyDate && !independent && Number.isInteger(offset);
  const element = document.createElement('div'); element.className = `date-control${onlyDate ? '' : ' date-with-time'}`;
  const dateHost = document.createElement('div'); dateHost.className = 'date-input';
  const primary = document.createElement('input'); primary.type = 'text'; primary.placeholder = 'M/d/yyyy'; primary.autocomplete = 'off';
  primary.setAttribute('role', 'combobox'); primary.setAttribute('aria-haspopup', 'dialog'); primary.setAttribute('aria-expanded', 'false');
  const button = (label, glyph, action) => { const node = document.createElement('button'); node.type = 'button'; node.setAttribute('aria-label', label); node.title = label; node.dataset.focusKey = label.startsWith('Navigate to previous month') ? 'previous-month' : label.startsWith('Navigate to next month') ? 'next-month' : label.startsWith('Navigate to previous year') ? 'previous-year' : label.startsWith('Navigate to next year') ? 'next-year' : /^(Month|Year) picker/.test(label) ? 'year-picker' : label; if (glyph) node.innerHTML = icon(glyph); node.addEventListener('click', action); return node; };
  const calendar = document.createElement('div'); calendar.id = `date-calendar-${++nextId}`; calendar.className = 'date-calendar'; calendar.setAttribute('role', 'dialog'); calendar.setAttribute('aria-label', 'Calendar'); calendar.hidden = true;
  primary.setAttribute('aria-controls', calendar.id);
  const trigger = button(`Open calendar for ${field.label ?? field.name}`, 'calendar', () => calendar.hidden ? open() : close(true));
  trigger.innerHTML = '<svg class="icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="3.5" y="3.5" width="13" height="13" rx="2" fill="none" stroke="currentColor"/><g fill="currentColor"><circle cx="7" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="13" cy="8" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></g></svg>';
  const time = document.createElement('input'); time.type = 'text'; time.className = 'date-time-input'; time.placeholder = '--:--'; time.setAttribute('aria-label', `${field.label ?? field.name} Time`); time.autocomplete = 'off';
  const timeHost = document.createElement('div'); timeHost.className = 'date-time-host';
  const timeOptions = document.createElement('div'); timeOptions.className = 'date-time-options'; timeOptions.id = calendar.id + '-times'; timeOptions.setAttribute('role', 'listbox'); timeOptions.setAttribute('aria-label', `Time options for ${field.label ?? field.name}`);
  time.setAttribute('role', 'combobox'); time.setAttribute('aria-haspopup', 'listbox'); time.setAttribute('aria-controls', timeOptions.id); time.setAttribute('aria-expanded', 'false');
  const timeTrigger = button(`Open time options for ${field.label ?? field.name}`, 'chevron', () => { time.focus(); timeOptions.isConnected ? closeTime() : openTime(); });
  let timeLifetime, timeActive = 0, timeKeyboard = false;
  let shown, focused, yearPage, years = false, alive = true, lifetime, dateError = '', timeError = '', externalDateError = '', externalTimeError = '', rendering = false;
  const nativeDateValidity = primary.setCustomValidity.bind(primary), nativeTimeValidity = time.setCustomValidity.bind(time);
  primary.setCustomValidity = message => { externalDateError = String(message); nativeDateValidity(externalDateError || dateError); };
  time.setCustomValidity = message => { externalTimeError = String(message); nativeTimeValidity(externalTimeError || timeError); };
  const months = Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat('en-US', { month: 'long' }).format(localDate(2024, month, 1)));
  const updateValidity = () => {
    const date = primary.value ? parseDate(primary.value) : null;
    const nextDateError = primary.value && !date ? 'Enter a valid date in M/d/yyyy format.' : '';
    dateError = nextDateError; nativeDateValidity(externalDateError || dateError);
    if (!onlyDate) { time.hidden = timeHost.hidden = !primary.value; if (!primary.value) closeTime(); timeError = time.value && !parseTime(time.value) ? 'Enter a valid time.' : ''; nativeTimeValidity(externalTimeError || timeError); }
    return date;
  };
  function setValue(value) {
    closeTime();
    const instant = value == null || value === '' ? null : new Date(value);
    const valid = instant && Number.isFinite(instant.getTime());
    const wall = valid && staffTimeZone ? new Date(instant.getTime() + offset * 60000) : null;
    const date = wall ? localDate(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) : valid ? value instanceof Date ? instant : onlyDate || independent ? parseDate(String(value).slice(0, 10)) : instant : null;
    primary.value = date ? dateText(date) : '';
    const localTime = wall ? { hour: wall.getUTCHours(), minute: wall.getUTCMinutes() } : valid && independent && !(value instanceof Date) ? parseTime(String(value).slice(11, 16)) : valid ? { hour: instant.getHours(), minute: instant.getMinutes() } : null;
    time.value = localTime ? timeText(localTime) : ''; updateValidity();
  }
  const emit = () => { primary.dispatchEvent(new Event('input', { bubbles: true })); primary.dispatchEvent(new Event('change', { bubbles: true })); };
  function closeTime(focus = false) { timeOptions.remove(); timeLifetime?.abort(); timeLifetime = undefined; time.setAttribute('aria-expanded', 'false'); time.removeAttribute('aria-activedescendant'); if (focus && alive && !time.disabled) time.focus({ preventScroll: true }); }
  function markTime() {
    const value = parseTime(time.value), selected = value ? value.hour * 60 + value.minute : -1;
    for (const [index, option] of [...timeOptions.children].entries()) { option.setAttribute('aria-selected', String(index * 30 === selected)); option.classList.toggle('active', timeKeyboard && index === timeActive); }
    if (timeOptions.isConnected) time.setAttribute('aria-activedescendant', `${timeOptions.id}-${timeActive}`);
  }
  function revealTime() { const row = timeOptions.children[timeActive]?.getBoundingClientRect(), bounds = timeOptions.getBoundingClientRect(); if (row?.top < bounds.top) timeOptions.scrollTop -= bounds.top - row.top; else if (row?.bottom > bounds.bottom) timeOptions.scrollTop += row.bottom - bounds.bottom; }
  function chooseTime(index) {
    if (!alive || primary.disabled || time.disabled || !timeOptions.isConnected) return;
    time.value = timeText({ hour: Math.floor(index / 2), minute: index % 2 * 30 }); updateValidity(); closeTime(true); emit();
  }
  function openTime() {
    if (!alive || primary.disabled || time.disabled || timeHost.hidden || timeOptions.isConnected) return;
    close(); timeKeyboard = false;
    const value = parseTime(time.value); timeActive = value ? Math.min(47, Math.floor((value.hour * 60 + value.minute) / 30)) : 0;
    document.body.append(timeOptions); time.setAttribute('aria-expanded', 'true'); markTime();
    const rect = timeHost.getBoundingClientRect(), below = innerHeight - rect.bottom, above = rect.top, isAbove = below < Math.min(1544, above), height = Math.max(32, Math.min(1544, isAbove ? above : below));
    Object.assign(timeOptions.style, { width: `${Math.min(rect.width, innerWidth - 16)}px`, maxHeight: `${height}px`, left: `${Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8))}px`, top: `${isAbove ? rect.top - height : rect.bottom}px` });
    timeOptions.scrollTop = 0; revealTime();
    timeLifetime = new AbortController();
    document.addEventListener('pointerdown', event => { if (!timeHost.contains(event.target) && !timeOptions.contains(event.target)) closeTime(); }, { signal: timeLifetime.signal });
    window.addEventListener('resize', () => closeTime(), { signal: timeLifetime.signal });
    window.addEventListener('scroll', event => { if (!timeOptions.contains(event.target)) closeTime(); }, { capture: true, signal: timeLifetime.signal });
  }
  if (!onlyDate) for (let index = 0; index < 48; index++) { const option = document.createElement('div'); option.id = `${timeOptions.id}-${index}`; option.setAttribute('role', 'option'); option.textContent = timeText({ hour: Math.floor(index / 2), minute: index % 2 * 30 }); option.setAttribute('aria-label', option.textContent); option.addEventListener('pointerdown', event => event.preventDefault()); option.addEventListener('click', () => chooseTime(index)); timeOptions.append(option); }
  function close(focus = false) { calendar.hidden = true; primary.setAttribute('aria-expanded', 'false'); lifetime?.abort(); lifetime = undefined; if (focus && alive && !primary.disabled) primary.focus(); }
  function choose(date) {
    if (!alive || primary.disabled) return;
    primary.value = dateText(date); if (!onlyDate && !time.value) time.value = '12:00 AM'; updateValidity(); close(true); emit();
  }
  const navigate = offset => { const next = localDate(shown.getFullYear(), shown.getMonth() + offset, 1); if (next.getFullYear() < 1 || next.getFullYear() > 9999) return; shown = next; yearPage = shown.getFullYear(); render(); };
  const focusDay = date => { focused = date; shown = localDate(date.getFullYear(), date.getMonth(), 1); yearPage = shown.getFullYear(); render(); calendar.querySelector(`[data-date="${keyOf(date)}"]`)?.focus(); };
  function render() {
    const focusKey = calendar.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null; rendering = true;
    calendar.replaceChildren();
    const daysPane = document.createElement('div'); daysPane.className = 'calendar-days';
    const dayHeader = document.createElement('div'); dayHeader.className = 'calendar-header';
    const monthName = document.createElement('span'); monthName.className = 'calendar-heading'; monthName.setAttribute('aria-live', 'polite'); monthName.textContent = `${months[shown.getMonth()]} ${shown.getFullYear()}`;
    dayHeader.append(monthName, button(`Navigate to previous month ${months[(shown.getMonth() + 11) % 12]}`, 'sortUp', () => navigate(-1)), button(`Navigate to next month ${months[(shown.getMonth() + 1) % 12]}`, 'sortDown', () => navigate(1)));
    const grid = document.createElement('table'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', monthName.textContent); grid.setAttribute('aria-multiselectable', 'false');
    const week = grid.createTHead().insertRow();
    for (const name of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.setAttribute('aria-label', name); cell.textContent = name.slice(0, 2); week.append(cell); }
    const selected = parseDate(primary.value), today = localDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    const start = localDate(shown.getFullYear(), shown.getMonth(), 1 - shown.getDay()); const body = grid.createTBody();
    for (let row = 0; row < 6; row++) {
      const tr = body.insertRow();
      for (let column = 0; column < 7; column++) {
        const date = localDate(start.getFullYear(), start.getMonth(), start.getDate() + row * 7 + column), key = keyOf(date), cell = tr.insertCell();
        cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-selected', String(selected && keyOf(selected) === key));
        const day = button(`${date.getDate()}, ${months[date.getMonth()]}, ${date.getFullYear()}`, null, () => choose(date)); day.textContent = String(date.getDate()); day.dataset.date = key; day.tabIndex = keyOf(focused) === key ? 0 : -1;
        day.classList.toggle('outside-month', date.getMonth() !== shown.getMonth()); day.classList.toggle('today', keyOf(today) === key); day.classList.toggle('selected', Boolean(selected && keyOf(selected) === key));
        if (keyOf(today) === key) day.setAttribute('aria-current', 'date');
        day.addEventListener('keydown', event => {
          let next;
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) next = localDate(date.getFullYear(), date.getMonth(), date.getDate() + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]));
          else if (event.key === 'Home' || event.key === 'End') next = localDate(date.getFullYear(), date.getMonth(), date.getDate() + (event.key === 'Home' ? -date.getDay() : 6 - date.getDay()));
          else if (event.key === 'PageUp' || event.key === 'PageDown') { const offset = (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1); const month = localDate(date.getFullYear(), date.getMonth() + offset, 1); next = localDate(month.getFullYear(), month.getMonth(), Math.min(date.getDate(), localDate(month.getFullYear(), month.getMonth() + 1, 0).getDate())); }
          if (next) { event.preventDefault(); event.stopPropagation(); focusDay(next); }
        }); cell.append(day);
      }
    }
    daysPane.append(dayHeader, grid);
    const monthsPane = document.createElement('div'); monthsPane.className = 'calendar-months';
    const yearHeader = document.createElement('div'); yearHeader.className = 'calendar-header';
    const yearButton = button(years ? `Year picker ${yearPage} - ${yearPage + 11}, select to switch to month picker` : `Month picker for year ${yearPage}, select to switch to year picker`, null, () => { years = !years; render(); }); yearButton.className = 'calendar-heading'; yearButton.textContent = years ? `${yearPage} - ${yearPage + 11}` : String(yearPage);
    yearHeader.append(yearButton, button(`Navigate to previous ${years ? `year range ${yearPage - 12} - ${yearPage - 1}` : `year ${yearPage - 1}`}`, 'sortUp', () => { yearPage = Math.max(1, yearPage - (years ? 12 : 1)); render(); }), button(`Navigate to next ${years ? `year range ${yearPage + 12} - ${yearPage + 23}` : `year ${yearPage + 1}`}`, 'sortDown', () => { yearPage = Math.min(9999, yearPage + (years ? 12 : 1)); render(); }));
    const monthGrid = document.createElement('div'); monthGrid.className = 'calendar-month-grid'; monthGrid.setAttribute('role', 'group'); monthGrid.setAttribute('aria-label', years ? 'Years' : 'Months');
    for (let index = 0; index < 12; index++) {
      const year = yearPage + index;
      const month = button(years ? String(year) : months[index], null, () => { if (years) { yearPage = year; years = false; render(); } else { shown = localDate(yearPage, index, 1); focused = localDate(yearPage, index, 1); render(); } }); month.textContent = years ? String(year) : months[index].slice(0, 3); month.disabled = years && (year < 1 || year > 9999); monthGrid.append(month);
    }
    monthsPane.append(yearHeader, monthGrid); calendar.append(daysPane, monthsPane); daysPane.classList.toggle('year-picker-open', years);
    if (focusKey) [...calendar.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey)?.focus(); rendering = false;
  }
  function open() {
    if (!alive || primary.disabled || !calendar.hidden) return;
    closeTime();
    focused = updateValidity() ?? localDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()); shown = localDate(focused.getFullYear(), focused.getMonth(), 1); yearPage = shown.getFullYear(); years = false; render();
    calendar.hidden = false; primary.setAttribute('aria-expanded', 'true');
    const scrollRoot = element.closest('.record-content');
    const bounds = () => { const root = scrollRoot?.getBoundingClientRect(), pinned = scrollRoot?.querySelector(':scope>.record-card')?.getBoundingClientRect(); return { top: Math.max(0, root?.top ?? 0, pinned?.bottom ?? 0), bottom: Math.min(innerHeight, root?.bottom ?? innerHeight) }; };
    let rect = dateHost.getBoundingClientRect(), boundary = bounds(), below = boundary.bottom - rect.bottom, above = rect.top - boundary.top;
    if (scrollRoot && below < 254 && above < 254) { scrollRoot.scrollTop += Math.max(0, 262 - below); rect = dateHost.getBoundingClientRect(); boundary = bounds(); below = boundary.bottom - rect.bottom; above = rect.top - boundary.top; }
    const isAbove = below < 254 && above > below; calendar.classList.toggle('above', isAbove);
    calendar.style.maxHeight = `${Math.max(80, Math.min(254, (isAbove ? above : below) - 1))}px`;
    const left = Math.max(8, Math.min(rect.left, innerWidth - calendar.offsetWidth - 8)); calendar.style.left = `${left - rect.left}px`;
    lifetime = new AbortController();
    document.addEventListener('pointerdown', event => { if (!element.contains(event.target)) close(); }, { signal: lifetime.signal });
    element.addEventListener('focusout', event => { if (!rendering && !element.contains(event.relatedTarget)) close(); }, { signal: lifetime.signal });
    window.addEventListener('resize', () => close(), { signal: lifetime.signal });
    window.addEventListener('scroll', () => { const edge = bounds(), popup = calendar.getBoundingClientRect(); if (popup.top < edge.top - 1 || popup.bottom > edge.bottom + 1) close(); }, { capture: true, signal: lifetime.signal });
    calendar.querySelector(`[data-date="${keyOf(focused)}"]`)?.focus();
  }
  primary.addEventListener('input', updateValidity);
  primary.addEventListener('change', () => { const date = updateValidity(); if (date) primary.value = dateText(date); else if (!primary.value) { time.value = ''; time.hidden = timeHost.hidden = true; closeTime(); } });
  primary.addEventListener('click', open);
  primary.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.altKey && event.key === 'ArrowUp') { event.preventDefault(); open(); } else if (event.key === 'Enter') { event.preventDefault(); primary.dispatchEvent(new Event('change', { bubbles: true })); close(true); } });
  time.addEventListener('input', () => { updateValidity(); markTime(); }); time.addEventListener('change', () => { const parsed = parseTime(time.value); if (parsed) time.value = timeText(parsed); updateValidity(); markTime(); });
  time.addEventListener('click', openTime); time.addEventListener('blur', () => closeTime()); timeTrigger.addEventListener('pointerdown', event => event.preventDefault());
  time.addEventListener('keydown', event => {
    if (event.key === 'Tab') { closeTime(); return; }
    if (event.key === 'Escape' && timeOptions.isConnected) { event.preventDefault(); event.stopPropagation(); closeTime(true); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && (timeOptions.isConnected || event.key.startsWith('Arrow'))) { event.preventDefault(); const closed = !timeOptions.isConnected; openTime(); timeActive = event.key === 'Home' ? 0 : event.key === 'End' ? 47 : Math.max(0, Math.min(47, timeActive + (closed ? 0 : event.key === 'ArrowDown' ? 1 : -1))); timeKeyboard = true; markTime(); revealTime(); }
    else if (event.key === 'Enter') { event.preventDefault(); if (timeOptions.isConnected) chooseTime(timeActive); else time.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  element.addEventListener('keydown', event => { if (event.key === 'Escape' && !calendar.hidden) { event.preventDefault(); event.stopPropagation(); close(true); } });
  dateHost.append(primary, trigger, calendar); element.append(dateHost); timeHost.append(time, timeTrigger); if (!onlyDate) element.append(timeHost); setValue(initialValue);
  return { element, primary, read() {
    const date = updateValidity(); if (!primary.value) return null; if (!date) throw new Error(`Enter a valid date for ${field.label ?? field.name}.`);
    if (onlyDate) return keyOf(date);
    const clock = time.value ? parseTime(time.value) : { hour: 0, minute: 0 }; if (!clock) throw new Error(`Enter a valid time for ${field.label ?? field.name}.`);
    if (independent) return `${keyOf(date)}T${pad(clock.hour)}:${pad(clock.minute)}:00.000Z`;
    if (staffTimeZone) { const utc = new Date(0); utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate()); utc.setUTCHours(clock.hour, clock.minute, 0, 0); return new Date(utc.getTime() - offset * 60000).toISOString(); }
    date.setHours(clock.hour, clock.minute); return date.toISOString();
  }, setValue, setDisabled(disabled) { primary.disabled = Boolean(disabled); time.disabled = Boolean(disabled); trigger.disabled = Boolean(disabled); timeTrigger.disabled = Boolean(disabled); if (disabled) { close(); closeTime(); } }, destroy() { alive = false; close(); closeTime(); } };
}
