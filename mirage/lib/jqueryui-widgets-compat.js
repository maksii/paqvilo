/* Local jQuery UI datepicker and tabs adapters. The platform's preform bundle carries
 * jQuery UI 1.13.2; its local equivalent (lib/platform-manifest.mjs) includes these widgets
 * next to the dialog adapter, so portal scripts that call .datepicker() or .tabs() keep
 * working.
 *
 * datepicker supports:
 * - the jQuery UI date format tokens d, dd, o, oo, D, DD, m, mm, M, MM, y, yy, @, ! and
 *   quoted literals;
 * - minDate and maxDate as a Date, date text, a day count or a relative "+1D -2W +1M +1Y";
 * - onSelect;
 * - the getDate, setDate, option, show, hide, enable, disable and destroy methods;
 * - $.datepicker.formatDate, parseDate and setDefaults.
 * The browser's own date chooser stands in for the calendar popup.
 *
 * tabs supports ul > li > a[href="#panel"] navigation with the jQuery UI classes and roles,
 * the active option and the activate callback and tabsactivate event. */
(() => {
  // One adapter per document: a repeated include only re-attaches the plugins.
  const compat = (globalThis.__ppSimCompat ||= {});
  if (compat.jqueryUiWidgets) {
    compat.jqueryUiWidgets(globalThis.jQuery);
    return;
  }
  if (!globalThis.jQuery) {
    console.error('Local jQuery UI widget compatibility requires jQuery.');
    return;
  }
  const regional = {
    dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    dayNamesShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    monthNames: [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ],
    monthNamesShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    dateFormat: 'mm/dd/yy',
  };
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const dayOfYear = (date) =>
    Math.round(
      (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 86400000,
    );
  const TICKS_AT_EPOCH = 621355968000000000;

  function formatLiteral(format, index) {
    const token = format[index];
    if (token === "'" && format[index + 1] !== "'") return { literal: false, output: '', skip: 0 };
    return { literal: true, output: token, skip: token === "'" ? 1 : 0 };
  }

  function formatToken(token, doubled, date) {
    switch (token) {
      case 'd':
        return doubled ? pad(date.getDate()) : date.getDate();
      case 'o':
        return doubled ? pad(dayOfYear(date), 3) : dayOfYear(date);
      case 'D':
        return (doubled ? regional.dayNames : regional.dayNamesShort)[date.getDay()];
      case 'm':
        return doubled ? pad(date.getMonth() + 1) : date.getMonth() + 1;
      case 'M':
        return (doubled ? regional.monthNames : regional.monthNamesShort)[date.getMonth()];
      case 'y':
        return doubled ? date.getFullYear() : pad(date.getFullYear() % 100);
      case '@':
        return date.getTime();
      case '!':
        return date.getTime() * 10000 + TICKS_AT_EPOCH;
      case "'":
        return doubled ? "'" : '';
      default:
        return token;
    }
  }

  function parseToken(token, doubled, state) {
    switch (token) {
      case 'd':
        state.day = dateNumber(state, 2);
        break;
      case 'o':
        state.ordinal = dateNumber(state, 3);
        break;
      case 'D':
        dateName(state, regional.dayNamesShort, regional.dayNames);
        break;
      case 'm':
        state.month = dateNumber(state, 2);
        break;
      case 'M':
        state.month = dateName(state, regional.monthNamesShort, regional.monthNames);
        break;
      case 'y':
        state.year = dateNumber(state, doubled ? 4 : 2);
        break;
      case '@': {
        const date = new Date(dateNumber(state, 14));
        [state.year, state.month, state.day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
        break;
      }
      case '!': {
        const date = new Date((dateNumber(state, 20) - TICKS_AT_EPOCH) / 10000);
        [state.year, state.month, state.day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
        break;
      }
      case "'":
        if (doubled) dateExact(state, "'");
        else state.literal = true;
        break;
      default:
        dateExact(state, token);
    }
  }

  function dateParseFail(state, reason) {
    throw new Error(`${reason} at position ${state.position}`);
  }

  function dateNumber(state, digits) {
    const match = new RegExp(String.raw`^\d{1,${digits}}`).exec(state.text.slice(state.position));
    if (!match) dateParseFail(state, 'Missing number');
    state.position += match[0].length;
    return Number(match[0]);
  }

  function dateName(state, short, long) {
    const candidates = [
      ...long.map((label, index) => [label, index]),
      ...short.map((label, index) => [label, index]),
    ].sort((a, b) => b[0].length - a[0].length);
    for (const [label, index] of candidates)
      if (state.text.slice(state.position, state.position + label.length).toLowerCase() === label.toLowerCase()) {
        state.position += label.length;
        return index + 1;
      }
    return dateParseFail(state, 'Unknown name');
  }

  function dateExact(state, character) {
    if (state.text[state.position] !== character) dateParseFail(state, 'Unexpected literal');
    state.position++;
  }

  function finalizeParsedDate(state) {
    const now = new Date();
    if (state.year === -1) state.year = now.getFullYear();
    // jQuery UI's default shortYearCutoff ("+10"): two-digit years up to ten years ahead are this century.
    else if (state.year < 100)
      state.year +=
        state.year <= (now.getFullYear() % 100) + 10
          ? Math.floor(now.getFullYear() / 100) * 100
          : Math.floor(now.getFullYear() / 100) * 100 - 100;
    if (state.ordinal > -1) {
      const date = new Date(state.year, 0, state.ordinal);
      [state.month, state.day] = [date.getMonth() + 1, date.getDate()];
    }
    const date = new Date(state.year, state.month - 1, state.day);
    if (date.getFullYear() !== state.year || date.getMonth() + 1 !== state.month || date.getDate() !== state.day)
      dateParseFail(state, 'Invalid date');
    return date;
  }

  function relativeDate(value, base) {
    let year = base.getFullYear();
    let month = base.getMonth();
    let day = base.getDate();
    let matched = false;
    for (const match of String(value).matchAll(/([+-]?\d+)\s*([dwmy])?/gi)) {
      matched = true;
      const amount = Number(match[1]);
      const unit = (match[2] ?? 'd').toLowerCase();
      if (unit === 'd') day += amount;
      else if (unit === 'w') day += amount * 7;
      else {
        if (unit === 'm') month += amount;
        else year += amount;
        day = Math.min(day, new Date(year, month + 1, 0).getDate());
      }
    }
    return matched ? new Date(year, month, day) : null;
  }

  function formatDate(format, date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    let output = '';
    let literal = false;
    for (let index = 0; index < format.length; index++) {
      const token = format[index];
      if (literal) {
        const part = formatLiteral(format, index);
        literal = part.literal;
        output += part.output;
        index += part.skip;
        continue;
      }
      const doubled = format[index + 1] === token;
      output += formatToken(token, doubled, date);
      if (token === "'" && !doubled) literal = true;
      if (doubled && "doDmMy'".includes(token)) index++;
    }
    return output;
  }

  /* NOSONAR: single-pass routine, splitting it would change shared state */ function parseDate(format, value) {
    if (value == null || value === '') return null;
    const state = { text: String(value), position: 0, year: -1, month: -1, day: -1, ordinal: -1, literal: false };
    for (let index = 0; index < format.length; index++) {
      const token = format[index];
      if (state.literal) {
        if (token === "'" && format[index + 1] !== "'") state.literal = false;
        else {
          dateExact(state, token);
          if (token === "'") index++;
        }
        continue;
      }
      const doubled = format[index + 1] === token;
      parseToken(token, doubled, state);
      if (doubled && "doDmMy'".includes(token)) index++;
    }
    if (state.position < state.text.length) dateParseFail(state, 'Extra characters');
    return finalizeParsedDate(state);
  }

  // minDate, maxDate, defaultDate and setDate: a Date, date text in the format, a day count
  // or relative units ("+1D", "-2W +1M").
  function resolveDate(value, format) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (typeof value === 'number') return new Date(base.getFullYear(), base.getMonth(), base.getDate() + value);
    try {
      return parseDate(format, value);
    } catch {
      return relativeDate(value, base);
    }
  }

  const states = new WeakMap();
  const globalDefaults = {};
  const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const optionsOf = (state) => ({ dateFormat: regional.dateFormat, ...globalDefaults, ...state.options });
  const currentDate = (state) => {
    try {
      return parseDate(optionsOf(state).dateFormat, state.element.value);
    } catch {
      return null;
    }
  };
  function select(state, date) {
    const options = optionsOf(state);
    const text = formatDate(options.dateFormat, date);
    state.element.value = text;
    if (typeof options.onSelect === 'function') options.onSelect.call(state.element, text, state);
    globalThis.jQuery(state.element).trigger('change');
  }
  function chooser(state) {
    if (state.chooser?.isConnected) return state.chooser;
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'paqvilo-mirage-datepicker-chooser';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    input.addEventListener('change', () => {
      const [year, month, day] = input.value.split('-').map(Number);
      if (year) select(state, new Date(year, month - 1, day));
    });
    state.element.after(input);
    state.chooser = input;
    return input;
  }
  function show(state) {
    if (state.element.disabled) return;
    const options = optionsOf(state);
    const input = chooser(state);
    const min = resolveDate(options.minDate, options.dateFormat);
    const max = resolveDate(options.maxDate, options.dateFormat);
    input.min = min ? isoDay(min) : '';
    input.max = max ? isoDay(max) : '';
    const current = currentDate(state) ?? resolveDate(options.defaultDate, options.dateFormat);
    input.value = current ? isoDay(current) : '';
    try {
      input.showPicker?.();
    } catch {
      // showPicker needs a user gesture; programmatic focus leaves the text field editable.
    }
  }

  function initializeDatepicker(element, state, command) {
    if (state) {
      Object.assign(state.options, command ?? {});
      return;
    }
    state = { element, options: { ...command } };
    state.open = () => show(state);
    states.set(element, state);
    element.classList.add('hasDatepicker');
    element.setAttribute('autocomplete', 'off');
    // jQuery UI's default showOn is "focus".
    element.addEventListener('focus', state.open);
    element.addEventListener('click', state.open);
  }

  function runDatepickerCommand(element, state, command, args) {
    if (!state) return;
    if (command === 'show') show(state);
    else if (command === 'hide') state.chooser?.blur();
    else if (command === 'setDate') {
      const options = optionsOf(state);
      const date = resolveDate(args[0], options.dateFormat);
      element.value = date ? formatDate(options.dateFormat, date) : '';
    } else if (command === 'option') {
      if (args.length === 2) state.options[args[0]] = args[1];
      else if (args[0] && typeof args[0] === 'object') Object.assign(state.options, args[0]);
    } else if (command === 'enable') element.disabled = false;
    else if (command === 'disable') element.disabled = true;
    else if (command === 'destroy') {
      element.removeEventListener('focus', state.open);
      element.removeEventListener('click', state.open);
      state.chooser?.remove();
      element.classList.remove('hasDatepicker');
      states.delete(element);
    }
  }

  function applyDatepicker(element, command, args) {
    const state = states.get(element);
    if (typeof command !== 'string') {
      initializeDatepicker(element, state, command);
      return;
    }
    runDatepickerCommand(element, state, command, args);
  }

  const datepicker = function (command, ...args) {
    const first = this[0];
    if (command === 'getDate') {
      const state = first && states.get(first);
      return state ? currentDate(state) : null;
    }
    if (command === 'isDisabled') return Boolean(first?.disabled);
    if (command === 'option' && args.length === 1 && typeof args[0] === 'string') {
      const state = first && states.get(first);
      return state ? optionsOf(state)[args[0]] : undefined;
    }
    return this.each(function () {
      applyDatepicker(this, command, args);
    });
  };
  datepicker.__ppSimCompat = true;

  const tabStates = new WeakMap();
  function collectTabs(state) {
    state.tabs = [...(state.list?.children ?? [])]
      .filter((item) => item.tagName === 'LI')
      .map((item) => {
        const anchor = item.querySelector('a');
        const hash = anchor?.getAttribute('href') ?? '';
        const panel = hash.startsWith('#') ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
        item.classList.add('ui-tabs-tab', 'ui-corner-top', 'ui-state-default', 'ui-tab');
        item.setAttribute('role', 'tab');
        anchor?.classList.add('ui-tabs-anchor');
        if (panel) {
          panel.classList.add('ui-tabs-panel', 'ui-corner-bottom', 'ui-widget-content');
          panel.setAttribute('role', 'tabpanel');
        }
        return { item, anchor, panel };
      })
      .filter((tab) => tab.anchor);
  }
  function activateTab(state, index, event) {
    if (!state.tabs.length) return;
    const target = Math.max(0, Math.min(state.tabs.length - 1, Number.isFinite(index) ? index : 0));
    state.tabs.forEach((tab, position) => {
      const active = position === target;
      tab.item.classList.toggle('ui-tabs-active', active);
      tab.item.classList.toggle('ui-state-active', active);
      tab.item.setAttribute('aria-selected', String(active));
      tab.item.setAttribute('aria-expanded', String(active));
      if (tab.panel) {
        tab.panel.style.display = active ? '' : 'none';
        tab.panel.setAttribute('aria-hidden', String(!active));
      }
    });
    const changed = state.options.active !== target;
    state.options.active = target;
    if (event || (changed && state.initialised)) {
      const $ = globalThis.jQuery;
      const ui = { newTab: $(state.tabs[target].item), newPanel: $(state.tabs[target].panel ?? []) };
      const domEvent = event ?? $.Event('tabsactivate');
      if (typeof state.options.activate === 'function') state.options.activate.call(state.element, domEvent, ui);
      $(state.element).trigger('tabsactivate', [ui]);
    }
    state.initialised = true;
  }
  const tabs = function (command, ...args) {
    const first = this[0];
    if (command === 'option' && args.length === 1 && typeof args[0] === 'string')
      return first && tabStates.get(first)?.options[args[0]];
    return this.each(function () {
      let state = tabStates.get(this);
      if (typeof command !== 'string') {
        if (!state) {
          const list =
            [...this.children].find((child) => child.tagName === 'UL' || child.tagName === 'OL') ??
            this.querySelector('ul,ol');
          state = { element: this, list, tabs: [], options: { active: 0, ...command } };
          tabStates.set(this, state);
          this.classList.add('ui-tabs', 'ui-corner-all', 'ui-widget', 'ui-widget-content');
          list?.classList.add(
            'ui-tabs-nav',
            'ui-corner-all',
            'ui-helper-reset',
            'ui-helper-clearfix',
            'ui-widget-header',
          );
          list?.setAttribute('role', 'tablist');
          list?.addEventListener('click', (event) => {
            const index = state.tabs.findIndex((tab) => tab.anchor === event.target.closest('a'));
            if (index < 0) return;
            event.preventDefault();
            activateTab(state, index, event);
          });
          collectTabs(state);
        } else Object.assign(state.options, command ?? {});
        activateTab(state, Number(state.options.active ?? 0));
        return;
      }
      if (!state) return;
      if (command === 'option') {
        const changes = args.length === 2 ? { [args[0]]: args[1] } : (args[0] ?? {});
        Object.assign(state.options, { ...changes, active: state.options.active });
        if ('active' in changes) activateTab(state, Number(changes.active));
      } else if (command === 'refresh') {
        collectTabs(state);
        activateTab(state, state.options.active);
      } else if (command === 'destroy') tabStates.delete(this);
    });
  };
  tabs.__ppSimCompat = true;

  const attach = ($) => {
    if (typeof $?.fn?.jquery !== 'string') return;
    if (!$.fn.datepicker) $.fn.datepicker = datepicker;
    if (!$.datepicker)
      $.datepicker = {
        formatDate,
        parseDate,
        regional: { '': regional },
        setDefaults: (options) => Object.assign(globalDefaults, options ?? {}),
      };
    if (!$.fn.tabs) $.fn.tabs = tabs;
  };
  compat.jqueryUiWidgets = attach;
  attach(globalThis.jQuery);
  watchJQuery(compat, attach);
  globalThis.__portalSimulation ||= {};
  globalThis.__portalSimulation.compatibility ||= {};
  globalThis.__portalSimulation.compatibility.jqueryUiWidgetsMode = 'local-compatibility';
  /** Re-attach this adapter whenever a later script replaces window.jQuery. */
  // BEGIN generated jQuery watcher
  function watchJQuery(registry, attach) {
    let watchers = registry.jqueryWatchers;
    if (!watchers) {
      watchers = new Set();
      registry.jqueryWatchers = watchers;
    }
    watchers.add(attach);
    if (registry.jqueryWatched) return;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'jQuery');
    if (descriptor && (descriptor.get || descriptor.set || descriptor.configurable === false)) return;
    let current = globalThis.jQuery;
    try {
      Object.defineProperty(globalThis, 'jQuery', {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (value) => {
          current = value;
          for (const watcher of registry.jqueryWatchers) {
            try {
              watcher(value);
            } catch (error) {
              console.error(error);
            }
          }
        },
      });
      registry.jqueryWatched = true;
    } catch {
      // A non-configurable global stays a plain property; repeated includes still re-attach.
    }
  }
  // END generated jQuery watcher
})();
