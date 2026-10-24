/* Local-only date picker adapter. This provides the small jQuery API surface
 * used by exported source while editing dates with the browser's native UI. */
(() => {
  // One adapter per document: a repeated include only re-attaches the plugin to
  // the current jQuery (a later jQuery include replaces $.fn).
  const compat = (window.__ppSimCompat ||= {});
  if (compat.dateTimePicker) {
    compat.dateTimePicker(window.jQuery);
    return;
  }
  const moment = window.moment;
  if (!window.jQuery || !moment) {
    console.error("Local date picker compatibility requires jQuery and Moment.");
    return;
  }
  const jq = () => window.jQuery;
  const instances = new WeakMap();
  const trigger = (root, name, detail) => {
    // Native bindings survive later source includes replacing window.jQuery.
    if (name === 'change' && root.__simDateTarget) root.dispatchEvent(new CustomEvent('sim:datechange', { detail }));
    jq()(root).trigger(jq().Event(`dp.${name}`, detail));
  };
  const parse = (value, format) => {
    if (moment.isMoment(value)) return value.clone();
    if (value instanceof Date) return moment(value);
    if (typeof value === "string")
      return moment(value, [format, "YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DDTHH:mm"], true);
    return moment(value);
  };
  function install(root, options) {
    const display = root.matches("input")
        ? root
        : root.querySelector('input:not([type="hidden"])'),
      logicalId = display?.id?.replace(/_datepicker_description$/, ""),
      linked = logicalId && document.getElementById(logicalId),
      canonical = linked && linked !== display ? linked : display,
      nativeBinding = Boolean(root.__simDateTarget),
      format = options.format || display?.dataset.dateFormat || "DD/MM/YYYY",
      hasTime = /[Hhms]/.test(format),
      chooser = document.createElement("input");
    if (!display) return;
    chooser.type = hasTime ? "datetime-local" : "date";
    chooser.className = "paqvilo-mirage-date-chooser";
    // Local-only controls are marked so parity comparisons can tell them from platform markup.
    chooser.setAttribute("data-paqvilo-local", "");
    chooser.setAttribute("aria-label", display.getAttribute("aria-label") || "Choose date");
    chooser.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:0;bottom:0";
    // The platform's picker group holds only the box and the calendar button until it opens:
    // the native chooser joins the DOM while a choice is pending, the action buttons only
    // while a source script shows one (DOM parity with the live group).
    const detachChooser = () => { if (chooser.isConnected) chooser.remove(); };
    chooser.addEventListener("blur", detachChooser);
    const buttons = document.createElement("span");
    buttons.className = "paqvilo-mirage-date-actions";
    buttons.setAttribute("data-paqvilo-local", "");
    buttons.setAttribute("role", "group");
    buttons.setAttribute("aria-label", "Date actions");
    const makeButton = (label, action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-default paqvilo-mirage-date-action";
      button.textContent = label;
      button.setAttribute("aria-label", label);
      button.hidden = true;
      button.addEventListener("click", action);
      buttons.append(button);
      return button;
    };
    const todayButton = makeButton("Today", () => setDate(moment(), true)),
      clearButton = makeButton("Clear date", () => setDate(null, true)),
      syncButtons = () => { if (todayButton.hidden && clearButton.hidden) buttons.remove(); else if (!buttons.isConnected) root.append(buttons); };
    let lastGoodValue = '';
    const parseCurrent = () =>
        parse(canonical.value || display.value, format),
      isoValue = (value) =>
        value.format(hasTime ? "YYYY-MM-DDTHH:mm" : "YYYY-MM-DD"),
      notify = (oldDate, date) => {
        const current = date === undefined ? parseCurrent() : date;
        trigger(root, "update", { date: current?.isValid() ? current : null });
        trigger(root, "change", {
          date: current?.isValid() ? current : null,
          oldDate: oldDate?.isValid?.() ? oldDate : null,
        });
      },
      // userInput: only the user's own choice dispatches the visible box's DOM change (the
      // plugin's date()/clear() fire dp.* events without touching the box's change handlers).
      setDate = (value, announce = false, userInput = announce) => {
        const oldDate = parseCurrent(),
          next = value == null ? null : parse(value, format);
        if (next && !next.isValid()) return;
        const formatted = next ? next.format(format) : "";
        if (canonical !== display && !nativeBinding) canonical.value = next ? isoValue(next) : "";
        display.value = formatted;
        chooser.value = next ? isoValue(next) : "";
        if (announce) {
          if (!nativeBinding) canonical.dispatchEvent(new Event("change", { bubbles: true }));
          if (userInput && canonical !== display)
            display.dispatchEvent(new Event("change", { bubbles: true }));
          notify(oldDate, next);
        }
      },
      show = () => {
        trigger(root, "show", { date: parseCurrent() });
        if (!chooser.isConnected) root.append(chooser);
        try {
          if (typeof chooser.showPicker === "function") chooser.showPicker();
          else chooser.focus();
        } catch {
          chooser.focus();
        }
      };
    chooser.addEventListener("change", () => {
      setDate(chooser.value ? moment(chooser.value, hasTime ? "YYYY-MM-DDTHH:mm" : "YYYY-MM-DD", true) : null, true);
      detachChooser();
    });
    display.addEventListener("change", () => {
      const value = parse(display.value, format);
      if (value?.isValid()) {
        if (nativeBinding) lastGoodValue = display.value;
        const oldDate = parseCurrent();
        if (canonical !== display && !nativeBinding) canonical.value = isoValue(value);
        chooser.value = isoValue(value);
        notify(oldDate, value);
      } else if (nativeBinding) {
        const previous = parseCurrent();
        if (!display.value.trim()) lastGoodValue = '';
        const restored = lastGoodValue ? parse(lastGoodValue, format) : null;
        display.value = restored?.isValid() ? lastGoodValue : '';
        chooser.value = restored?.isValid() ? isoValue(restored) : '';
        notify(previous, restored?.isValid() ? restored : null);
      }
    });
    root.addEventListener("click", (event) => {
      if (event.target.closest(".input-group-addon,[data-date-icon],.customCalender")) {
        event.preventDefault();
        show();
      }
    });
    const initial = parseCurrent();
    if (initial?.isValid()) chooser.value = isoValue(initial);
    const api = {
      date(value) {
        if (!arguments.length) {
          const current = parseCurrent();
          return current?.isValid() ? current : null;
        }
        setDate(value, true, false);
        return api;
      },
      getMoment() { return api.date() || moment(); },
      minDate(value) {
        if (!arguments.length) return chooser.min ? moment(chooser.min) : false;
        const date = parse(value, format);
        if (date?.isValid()) chooser.min = isoValue(date);
        return api;
      },
      showTodayButton(value) {
        if (!arguments.length) return !todayButton.hidden;
        todayButton.hidden = !value;
        syncButtons();
        return api;
      },
      showClear(value) {
        if (!arguments.length) return !clearButton.hidden;
        clearButton.hidden = !value;
        syncButtons();
        return api;
      },
      show,
      hide() { chooser.blur(); detachChooser(); return api; },
      clear() { setDate(null, true, false); return api; },
      enable() { display.disabled = false; chooser.disabled = false; return api; },
      disable() { display.disabled = true; chooser.disabled = true; return api; },
      destroy() { chooser.remove(); buttons.remove(); instances.delete(root); return api; },
    };
    instances.set(root, api);
    jq()(root).data("DateTimePicker", api);
  }
  const plugin = function (argument, ...args) {
    if (typeof argument === "string") {
      this.map(function () {
        const api = instances.get(this);
        if (!api || typeof api[argument] !== "function")
          throw new Error(`Unsupported local DateTimePicker method: ${argument}`);
        return api[argument](...args);
      });
      return this;
    }
    const options = argument && typeof argument === "object" ? argument : {};
    return this.each(function () {
      if (!instances.has(this)) install(this, options);
    });
  };
  plugin.__ppSimCompat = true;
  const attach = ($) => {
    if (typeof $?.fn?.jquery === "string" && !$.fn.datetimepicker) $.fn.datetimepicker = plugin;
  };
  compat.dateTimePicker = attach;
  attach(window.jQuery);
  watchJQuery(compat, attach);
  ((globalThis.__portalSimulation ||= {}).compatibility ||= {}).datePickerMode = "native-compatibility";
  console.info("Local date picker compatibility adapter active; browser-native controls are used.");
  /** Re-attach this adapter whenever a later script replaces window.jQuery. */
  function watchJQuery(registry, attach) {
    (registry.jqueryWatchers ||= new Set()).add(attach);
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
