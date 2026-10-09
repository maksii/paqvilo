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
  const compat = (window.__ppSimCompat ||= {});
  if (compat.jqueryUiWidgets) { compat.jqueryUiWidgets(window.jQuery); return; }
  if (!window.jQuery) { console.error("Local jQuery UI widget compatibility requires jQuery."); return; }
  const regional = {
    dayNames: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    dayNamesShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    monthNames: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    monthNamesShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    dateFormat: "mm/dd/yy",
  };
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  const dayOfYear = (date) => Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 86400000);
  const TICKS_AT_EPOCH = 621355968000000000;

  function formatDate(format, date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    let output = "";
    let literal = false;
    for (let index = 0; index < format.length; index++) {
      const token = format[index];
      if (literal) {
        if (token === "'" && format[index + 1] !== "'") literal = false;
        else {
          output += token;
          if (token === "'") index++;
        }
        continue;
      }
      const doubled = format[index + 1] === token;
      switch (token) {
        case "d": output += doubled ? pad(date.getDate()) : date.getDate(); break;
        case "o": output += doubled ? pad(dayOfYear(date), 3) : dayOfYear(date); break;
        case "D": output += (doubled ? regional.dayNames : regional.dayNamesShort)[date.getDay()]; break;
        case "m": output += doubled ? pad(date.getMonth() + 1) : date.getMonth() + 1; break;
        case "M": output += (doubled ? regional.monthNames : regional.monthNamesShort)[date.getMonth()]; break;
        case "y": output += doubled ? date.getFullYear() : pad(date.getFullYear() % 100); break;
        case "@": output += date.getTime(); break;
        case "!": output += date.getTime() * 10000 + TICKS_AT_EPOCH; break;
        case "'":
          if (doubled) output += "'";
          else literal = true;
          break;
        default: output += token;
      }
      if (doubled && "doDmMy'".includes(token)) index++;
    }
    return output;
  }

  function parseDate(format, value) {
    if (value == null || value === "") return null;
    const text = String(value);
    let position = 0;
    let year = -1;
    let month = -1;
    let day = -1;
    let ordinal = -1;
    let literal = false;
    const fail = (reason) => { throw new Error(`${reason} at position ${position}`); };
    const number = (digits) => {
      const match = new RegExp(`^\\d{1,${digits}}`).exec(text.slice(position));
      if (!match) fail("Missing number");
      position += match[0].length;
      return Number(match[0]);
    };
    const name = (short, long) => {
      const candidates = [...long.map((label, index) => [label, index]), ...short.map((label, index) => [label, index])].sort((a, b) => b[0].length - a[0].length);
      for (const [label, index] of candidates)
        if (text.slice(position, position + label.length).toLowerCase() === label.toLowerCase()) {
          position += label.length;
          return index + 1;
        }
      return fail("Unknown name");
    };
    const exact = (character) => {
      if (text[position] !== character) fail("Unexpected literal");
      position++;
    };
    for (let index = 0; index < format.length; index++) {
      const token = format[index];
      if (literal) {
        if (token === "'" && format[index + 1] !== "'") literal = false;
        else {
          exact(token);
          if (token === "'") index++;
        }
        continue;
      }
      const doubled = format[index + 1] === token;
      switch (token) {
        case "d": day = number(2); break;
        case "o": ordinal = number(3); break;
        case "D": name(regional.dayNamesShort, regional.dayNames); break;
        case "m": month = number(2); break;
        case "M": month = name(regional.monthNamesShort, regional.monthNames); break;
        case "y": year = number(doubled ? 4 : 2); break;
        case "@": {
          const date = new Date(number(14));
          [year, month, day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
          break;
        }
        case "!": {
          const date = new Date((number(20) - TICKS_AT_EPOCH) / 10000);
          [year, month, day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
          break;
        }
        case "'":
          if (doubled) exact("'");
          else literal = true;
          break;
        default: exact(token);
      }
      if (doubled && "doDmMy'".includes(token)) index++;
    }
    if (position < text.length) fail("Extra characters");
    const now = new Date();
    if (year === -1) year = now.getFullYear();
    // jQuery UI's default shortYearCutoff ("+10"): two-digit years up to ten years ahead are this century.
    else if (year < 100) year += year <= (now.getFullYear() % 100) + 10 ? Math.floor(now.getFullYear() / 100) * 100 : Math.floor(now.getFullYear() / 100) * 100 - 100;
    if (ordinal > -1) {
      const date = new Date(year, 0, ordinal);
      [month, day] = [date.getMonth() + 1, date.getDate()];
    }
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) fail("Invalid date");
    return date;
  }

  // minDate, maxDate, defaultDate and setDate: a Date, date text in the format, a day count
  // or relative units ("+1D", "-2W +1M").
  function resolveDate(value, format) {
    if (value == null || value === "") return null;
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const today = new Date();
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (typeof value === "number") return new Date(base.getFullYear(), base.getMonth(), base.getDate() + value);
    try {
      return parseDate(format, value);
    } catch {
      let year = base.getFullYear();
      let month = base.getMonth();
      let day = base.getDate();
      let matched = false;
      for (const match of String(value).matchAll(/([+-]?\d+)\s*([dwmy])?/gi)) {
        matched = true;
        const amount = Number(match[1]);
        const unit = (match[2] ?? "d").toLowerCase();
        if (unit === "d") day += amount;
        else if (unit === "w") day += amount * 7;
        else {
          if (unit === "m") month += amount;
          else year += amount;
          day = Math.min(day, new Date(year, month + 1, 0).getDate());
        }
      }
      return matched ? new Date(year, month, day) : null;
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
    if (typeof options.onSelect === "function") options.onSelect.call(state.element, text, state);
    window.jQuery(state.element).trigger("change");
  }
  function chooser(state) {
    if (state.chooser?.isConnected) return state.chooser;
    const input = document.createElement("input");
    input.type = "date";
    input.className = "paqvilo-mirage-datepicker-chooser";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none";
    input.addEventListener("change", () => {
      const [year, month, day] = input.value.split("-").map(Number);
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
    input.min = min ? isoDay(min) : "";
    input.max = max ? isoDay(max) : "";
    const current = currentDate(state) ?? resolveDate(options.defaultDate, options.dateFormat);
    input.value = current ? isoDay(current) : "";
    try {
      input.showPicker?.();
    } catch {
      // showPicker needs a user gesture; programmatic focus leaves the text field editable.
    }
  }
  const datepicker = function (command, ...args) {
    const first = this[0];
    if (command === "getDate") {
      const state = first && states.get(first);
      return state ? currentDate(state) : null;
    }
    if (command === "isDisabled") return Boolean(first?.disabled);
    if (command === "option" && args.length === 1 && typeof args[0] === "string") {
      const state = first && states.get(first);
      return state ? optionsOf(state)[args[0]] : undefined;
    }
    return this.each(function () {
      let state = states.get(this);
      if (typeof command !== "string") {
        if (state) Object.assign(state.options, command ?? {});
        else {
          state = { element: this, options: { ...(command ?? {}) } };
          state.open = () => show(state);
          states.set(this, state);
          this.classList.add("hasDatepicker");
          this.setAttribute("autocomplete", "off");
          // jQuery UI's default showOn is "focus".
          this.addEventListener("focus", state.open);
          this.addEventListener("click", state.open);
        }
        return;
      }
      if (!state) return;
      if (command === "show") show(state);
      else if (command === "hide") state.chooser?.blur();
      else if (command === "setDate") {
        const options = optionsOf(state);
        const date = resolveDate(args[0], options.dateFormat);
        this.value = date ? formatDate(options.dateFormat, date) : "";
      } else if (command === "option") {
        if (args.length === 2) state.options[args[0]] = args[1];
        else if (args[0] && typeof args[0] === "object") Object.assign(state.options, args[0]);
      } else if (command === "enable") this.disabled = false;
      else if (command === "disable") this.disabled = true;
      else if (command === "destroy") {
        this.removeEventListener("focus", state.open);
        this.removeEventListener("click", state.open);
        state.chooser?.remove();
        this.classList.remove("hasDatepicker");
        states.delete(this);
      }
    });
  };
  datepicker.__ppSimCompat = true;

  const tabStates = new WeakMap();
  function collectTabs(state) {
    state.tabs = [...(state.list?.children ?? [])]
      .filter((item) => item.tagName === "LI")
      .map((item) => {
        const anchor = item.querySelector("a");
        const hash = anchor?.getAttribute("href") ?? "";
        const panel = hash.startsWith("#") ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
        item.classList.add("ui-tabs-tab", "ui-corner-top", "ui-state-default", "ui-tab");
        item.setAttribute("role", "tab");
        anchor?.classList.add("ui-tabs-anchor");
        if (panel) {
          panel.classList.add("ui-tabs-panel", "ui-corner-bottom", "ui-widget-content");
          panel.setAttribute("role", "tabpanel");
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
      tab.item.classList.toggle("ui-tabs-active", active);
      tab.item.classList.toggle("ui-state-active", active);
      tab.item.setAttribute("aria-selected", String(active));
      tab.item.setAttribute("aria-expanded", String(active));
      if (tab.panel) {
        tab.panel.style.display = active ? "" : "none";
        tab.panel.setAttribute("aria-hidden", String(!active));
      }
    });
    const changed = state.options.active !== target;
    state.options.active = target;
    if (event || (changed && state.initialised)) {
      const $ = window.jQuery;
      const ui = { newTab: $(state.tabs[target].item), newPanel: $(state.tabs[target].panel ?? []) };
      const domEvent = event ?? $.Event("tabsactivate");
      if (typeof state.options.activate === "function") state.options.activate.call(state.element, domEvent, ui);
      $(state.element).trigger("tabsactivate", [ui]);
    }
    state.initialised = true;
  }
  const tabs = function (command, ...args) {
    const first = this[0];
    if (command === "option" && args.length === 1 && typeof args[0] === "string") return first && tabStates.get(first)?.options[args[0]];
    return this.each(function () {
      let state = tabStates.get(this);
      if (typeof command !== "string") {
        if (!state) {
          const list = [...this.children].find((child) => child.tagName === "UL" || child.tagName === "OL") ?? this.querySelector("ul,ol");
          state = { element: this, list, tabs: [], options: { active: 0, ...(command ?? {}) } };
          tabStates.set(this, state);
          this.classList.add("ui-tabs", "ui-corner-all", "ui-widget", "ui-widget-content");
          list?.classList.add("ui-tabs-nav", "ui-corner-all", "ui-helper-reset", "ui-helper-clearfix", "ui-widget-header");
          list?.setAttribute("role", "tablist");
          list?.addEventListener("click", (event) => {
            const index = state.tabs.findIndex((tab) => tab.anchor === event.target.closest("a"));
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
      if (command === "option") {
        const changes = args.length === 2 ? { [args[0]]: args[1] } : (args[0] ?? {});
        Object.assign(state.options, { ...changes, active: state.options.active });
        if ("active" in changes) activateTab(state, Number(changes.active));
      } else if (command === "refresh") {
        collectTabs(state);
        activateTab(state, state.options.active);
      } else if (command === "destroy") tabStates.delete(this);
    });
  };
  tabs.__ppSimCompat = true;

  const attach = ($) => {
    if (typeof $?.fn?.jquery !== "string") return;
    if (!$.fn.datepicker) $.fn.datepicker = datepicker;
    if (!$.datepicker) $.datepicker = { formatDate, parseDate, regional: { "": regional }, setDefaults: (options) => Object.assign(globalDefaults, options ?? {}) };
    if (!$.fn.tabs) $.fn.tabs = tabs;
  };
  compat.jqueryUiWidgets = attach;
  attach(window.jQuery);
  watchJQuery(compat, attach);
  ((globalThis.__portalSimulation ||= {}).compatibility ||= {}).jqueryUiWidgetsMode = "local-compatibility";
  /** Re-attach this adapter whenever a later script replaces window.jQuery. */
  function watchJQuery(registry, reattach) {
    (registry.jqueryWatchers ||= new Set()).add(reattach);
    if (registry.jqueryWatched) return;
    const descriptor = Object.getOwnPropertyDescriptor(window, "jQuery");
    if (descriptor && (descriptor.get || descriptor.set || descriptor.configurable === false)) return;
    let current = window.jQuery;
    try {
      Object.defineProperty(window, "jQuery", {
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
})();
