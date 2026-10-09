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
  const trigger = (root, name, detail) =>
    jq()(root).trigger(jq().Event(`dp.${name}`, detail));
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
      format = options.format || display?.dataset.dateFormat || "DD/MM/YYYY",
      hasTime = /[Hhms]/.test(format),
      chooser = document.createElement("input");
    if (!display) return;
    chooser.type = hasTime ? "datetime-local" : "date";
    chooser.className = "paqvilo-mirage-date-chooser";
    chooser.setAttribute("aria-label", display.getAttribute("aria-label") || "Choose date");
    chooser.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:0;bottom:0";
    root.append(chooser);
    const buttons = document.createElement("span");
    buttons.className = "paqvilo-mirage-date-actions";
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
      clearButton = makeButton("Clear date", () => setDate(null, true));
    root.append(buttons);
    const parseCurrent = () =>
        parse(canonical.value || display.value, format),
      isoValue = (value) =>
        value.format(hasTime ? "YYYY-MM-DDTHH:mm" : "YYYY-MM-DD"),
      notify = (oldDate) => {
        const current = parseCurrent();
        trigger(root, "update", { date: current?.isValid() ? current : null });
        trigger(root, "change", {
          date: current?.isValid() ? current : null,
          oldDate: oldDate?.isValid?.() ? oldDate : null,
        });
      },
      setDate = (value, announce = false) => {
        const oldDate = parseCurrent(),
          next = value == null ? null : parse(value, format);
        if (next && !next.isValid()) return;
        const formatted = next ? next.format(format) : "";
        if (canonical !== display) canonical.value = next ? isoValue(next) : "";
        display.value = formatted;
        chooser.value = next ? isoValue(next) : "";
        if (announce) {
          canonical.dispatchEvent(new Event("change", { bubbles: true }));
          if (canonical !== display)
            display.dispatchEvent(new Event("change", { bubbles: true }));
          notify(oldDate);
        }
      },
      show = () => {
        trigger(root, "show", { date: parseCurrent() });
        try {
          if (typeof chooser.showPicker === "function") chooser.showPicker();
          else chooser.focus();
        } catch {
          chooser.focus();
        }
      };
    chooser.addEventListener("change", () =>
      setDate(chooser.value ? moment(chooser.value, hasTime ? "YYYY-MM-DDTHH:mm" : "YYYY-MM-DD", true) : null, true),
    );
    display.addEventListener("change", () => {
      const value = parse(display.value, format);
      if (value?.isValid()) {
        const oldDate = parseCurrent();
        if (canonical !== display) canonical.value = isoValue(value);
        chooser.value = isoValue(value);
        notify(oldDate);
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
        setDate(value, true);
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
        return api;
      },
      showClear(value) {
        if (!arguments.length) return !clearButton.hidden;
        clearButton.hidden = !value;
        return api;
      },
      show,
      hide() { chooser.blur(); return api; },
      clear() { setDate(null, true); return api; },
      enable() { display.disabled = false; chooser.disabled = false; return api; },
      disable() { display.disabled = true; chooser.disabled = true; return api; },
      destroy() { chooser.remove(); buttons.remove(); instances.delete(root); return api; },
    };
    instances.set(root, api);
    jq()(root).data("DateTimePicker", api);
  }
  const plugin = function (argument, ...args) {
    if (typeof argument === "string") {
      const result = this.map(function () {
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
