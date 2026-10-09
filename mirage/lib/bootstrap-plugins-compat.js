/* Local Bootstrap 3-compatible interaction adapters for source-only portals.
 * These implement common controls as accessible DOM behavior, not Bootstrap's
 * full visual/theme system. jQuery plugin calls follow Bootstrap 3.4.1 (the platform's
 * BootstrapV3 bundle): a call without a command applies the plugin's default options
 * (a modal shows, a new collapse toggles; dropdowns, tabs, tooltips, popovers and alerts
 * only initialise). The data API accepts Bootstrap 3 data-* and Bootstrap 5 data-bs-*. */
(() => {
  // One adapter per document: a repeated include only re-attaches the plugins to
  // the current jQuery; the delegated click handler is bound once.
  const compat = (window.__ppSimCompat ||= {});
  if (compat.bootstrapPlugins) { compat.bootstrapPlugins(window.jQuery); return; }
  if (!window.jQuery) { console.error("Local Bootstrap compatibility requires jQuery."); return; }
  const data = new WeakMap();
  // Per-element plugin state, as Bootstrap's $(element).data("bs.<plugin>") instances.
  const instances = new WeakMap();
  const instance = (element, name) => instances.get(element)?.[name];
  const create = (element, name, value) => {
    let all = instances.get(element);
    if (!all) instances.set(element, (all = {}));
    return (all[name] = value);
  };
  const event = (element, name, properties) => {
    const $ = window.jQuery;
    const value = $.Event(name, properties);
    $(element).trigger(value);
    return value;
  };
  // Options from data-* (Bootstrap 3) or data-bs-* (Bootstrap 5) attributes, converted as jQuery .data() does.
  const dataOptions = (element, names) => {
    const values = window.jQuery(element).data();
    const result = {};
    for (const name of names) {
      const value = values[name] ?? values["bs" + name[0].toUpperCase() + name.slice(1)];
      if (value !== undefined) result[name] = value;
    }
    return result;
  };
  // A trigger's targets: data-target/data-bs-target, else the #fragment of href.
  const targetsOf = (trigger) => {
    let selector = trigger.getAttribute("data-target") || trigger.getAttribute("data-bs-target");
    if (!selector) selector = trigger.getAttribute("href")?.replace(/.*(?=#[^\s]+$)/, "");
    if (!selector || selector === "#") return [];
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };
  const dropdownMenu = (toggle) => [...(toggle.parentElement?.children ?? [])].find((element) => element.classList.contains("dropdown-menu"));
  const setShown = (element, shown) => {
    element.hidden = !shown;
    element.classList.toggle("in", shown);
    element.classList.toggle("show", shown);
    element.setAttribute("aria-hidden", String(!shown));
  };
  function hint(element, kind, options = {}) {
    const $ = window.jQuery;
    let state = data.get(element) ?? {};
    const command = typeof options === "string" ? options : null;
    const hide = () => { state.tip?.remove(); state.tip = null; element.removeAttribute("aria-describedby"); };
    const show = () => {
      if (state.tip?.isConnected) return;
      const tip = document.createElement("div");
      tip.className = kind === "popover" ? "popover paqvilo-mirage-popover" : "tooltip paqvilo-mirage-tooltip";
      tip.setAttribute("role", kind === "popover" ? "dialog" : "tooltip");
      tip.id = `paqvilo-mirage-${kind}-${Math.random().toString(36).slice(2)}`;
      if (kind === "popover") { const arrow = document.createElement("div"); arrow.className = "arrow"; tip.append(arrow); }
      const value = (key) => { const result = state.options?.[key] ?? element.getAttribute(key === "content" ? "data-content" : "title") ?? ""; return typeof result === "function" ? result.call(element) : result; };
      const title = value("title"), content = value("content");
      if (kind === "popover" && title) { const h = document.createElement("h3"); h.className = "popover-title"; h.textContent = String(title); tip.append(h); }
      if (content || kind === "tooltip") { const body = document.createElement("div"); body.className = kind === "popover" ? "popover-content" : "tooltip-inner"; if (kind === "popover" && state.options?.html) body.innerHTML = String(content); else body.textContent = String(content || title); tip.append(body); }
      (state.options?.container === "body" ? document.body : element.parentElement ?? document.body).append(tip);
      tip.style.cssText = "position:absolute;z-index:1080;max-width:24rem;padding:.5rem;background:#fff;border:1px solid #777;border-radius:.25rem;box-shadow:0 2px 6px #0003";
      element.setAttribute("aria-describedby", tip.id); state.tip = tip; data.set(element, state);
      if (kind === "popover") {
        const Constructor = $.fn.popover?.Constructor;
        const instance = Object.create(Constructor?.prototype ?? Object.prototype);
        instance.$element = $(element);
        instance.$tip = $(tip);
        instance.tip = function () { return this.$tip; };
        instance.arrow = function () { return this.$tip.find(".arrow"); };
        const position = instance.getPosition(instance.$element);
        const placement = state.options?.placement ?? "bottom";
        const vertical = placement === "bottom" || placement === "top" || placement === "auto";
        const tipHeight = tip.offsetHeight, tipWidth = tip.offsetWidth;
        tip.style.left = `${Math.max(0, position.left + (vertical ? (position.width - tipWidth) / 2 : position.width + 4))}px`;
        tip.style.top = `${Math.max(0, placement === "top" ? position.top - tipHeight - 4 : position.top + (vertical ? position.height + 4 : (position.height - tipHeight) / 2))}px`;
        instance.replaceArrow(vertical ? (tipWidth - position.width) / 2 : (tipHeight - position.height) / 2, vertical ? tipWidth : tipHeight, vertical);
        state.instance = instance;
      } else {
        const rect = element.getBoundingClientRect(); tip.style.left = `${Math.max(0, rect.left + scrollX)}px`; tip.style.top = `${rect.bottom + scrollY + 4}px`;
      }
    };
    if (command === "hide" || command === "destroy" || command === "dispose") hide();
    else if (command === "show") show();
    else if (command === "toggle") state.tip?.isConnected ? hide() : show();
    else if (!command) {
      // Bootstrap initialises once: later option calls do not rebind or replace options.
      if (state.bound) return;
      state.bound = true; state.options = options; data.set(element, state);
      const trigger = options.trigger ?? (kind === "tooltip" ? "hover focus" : "click");
      if (trigger.includes("hover")) { element.addEventListener("mouseenter", show); element.addEventListener("mouseleave", hide); }
      if (trigger.includes("focus")) { element.addEventListener("focus", show); element.addEventListener("blur", hide); }
      if (trigger.includes("click")) element.addEventListener("click", () => state.tip?.isConnected ? hide() : show());
      if (trigger === "manual") element.setAttribute("aria-haspopup", kind === "popover" ? "dialog" : "true");
    }
  }
  const MODAL_DEFAULTS = { backdrop: true, keyboard: true, show: true };
  const modal = {
    show(element, relatedTarget) {
      const state = instance(element, "modal") ?? create(element, "modal", { options: { ...MODAL_DEFAULTS, ...dataOptions(element, ["backdrop", "keyboard", "show"]) } });
      if (event(element, "show.bs.modal", { relatedTarget }).isDefaultPrevented() || state.shown) return;
      state.shown = true;
      document.body.classList.add("modal-open");
      if (state.options.backdrop) {
        state.backdrop = document.createElement("div");
        state.backdrop.className = "modal-backdrop fade in show";
        document.body.append(state.backdrop);
      }
      setShown(element, true);
      element.style.display = "block";
      element.scrollTop = 0;
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-modal", "true");
      // A click beside the dialog hides it unless the backdrop is static; Escape hides it when keyboard is on.
      state.click = (click) => { if (click.target === element && state.options.backdrop === true) modal.hide(element); };
      state.keydown = (key) => { if (key.key === "Escape" && state.options.keyboard) modal.hide(element); };
      element.addEventListener("click", state.click);
      element.addEventListener("keydown", state.keydown);
      element.focus?.();
      event(element, "shown.bs.modal", { relatedTarget });
    },
    hide(element) {
      const state = instance(element, "modal");
      if (event(element, "hide.bs.modal").isDefaultPrevented() || !state?.shown) return;
      state.shown = false;
      setShown(element, false);
      element.style.display = "none";
      element.removeAttribute("aria-modal");
      element.removeEventListener("click", state.click);
      element.removeEventListener("keydown", state.keydown);
      state.backdrop?.remove();
      state.backdrop = null;
      if (!document.querySelector(".modal.in")) document.body.classList.remove("modal-open");
      event(element, "hidden.bs.modal");
    },
    toggle(element, relatedTarget) { if (instance(element, "modal")?.shown) modal.hide(element); else modal.show(element, relatedTarget); },
    handleUpdate() {},
  };
  const collapseOpen = (element) => element.classList.contains("in") || element.classList.contains("show");
  const collapseTriggers = (element) => [...document.querySelectorAll('[data-toggle="collapse"],[data-bs-toggle="collapse"]')].filter((trigger) => targetsOf(trigger).includes(element));
  const collapse = {
    show(element) { if (!collapseOpen(element)) collapse.set(element, true); },
    hide(element) { if (collapseOpen(element)) collapse.set(element, false); },
    toggle(element) { collapse.set(element, !collapseOpen(element)); },
    set(element, shown) {
      if (event(element, shown ? "show.bs.collapse" : "hide.bs.collapse").isDefaultPrevented()) return;
      setShown(element, shown);
      element.setAttribute("aria-expanded", String(shown));
      for (const trigger of collapseTriggers(element)) {
        trigger.classList.toggle("collapsed", !shown);
        trigger.setAttribute("aria-expanded", String(shown));
      }
      event(element, shown ? "shown.bs.collapse" : "hidden.bs.collapse");
    },
  };
  // Bootstrap 3 opens the toggle's parent (.open) and signals on it; Bootstrap 5 (data-bs-toggle) shows the
  // toggle and its menu (.show) and signals on the toggle. Both fire show/shown/hide/hidden.bs.dropdown.
  const DROPDOWN_TOGGLES = '[data-toggle="dropdown"],[data-bs-toggle="dropdown"]';
  const dropdownTarget = (toggle) => (toggle.hasAttribute("data-bs-toggle") ? toggle : (toggle.parentElement ?? toggle));
  const dropdownOpen = (toggle) => (toggle.hasAttribute("data-bs-toggle") ? toggle.classList.contains("show") : Boolean(toggle.parentElement?.classList.contains("open")));
  const dropdown = {
    show(element) {
      const bs5 = element.hasAttribute("data-bs-toggle"), target = dropdownTarget(element);
      if (dropdownOpen(element) || event(target, "show.bs.dropdown", { relatedTarget: element }).isDefaultPrevented()) return;
      if (bs5) { element.classList.add("show"); dropdownMenu(element)?.classList.add("show"); } else target.classList.add("open");
      element.setAttribute("aria-expanded", "true");
      event(target, "shown.bs.dropdown", { relatedTarget: element });
    },
    hide(element) {
      const bs5 = element.hasAttribute("data-bs-toggle"), target = dropdownTarget(element);
      if (!dropdownOpen(element) || event(target, "hide.bs.dropdown", { relatedTarget: element }).isDefaultPrevented()) return;
      if (bs5) { element.classList.remove("show"); dropdownMenu(element)?.classList.remove("show"); } else target.classList.remove("open");
      element.setAttribute("aria-expanded", "false");
      event(target, "hidden.bs.dropdown", { relatedTarget: element });
    },
    // Opening one menu closes the others (Bootstrap's clearMenus).
    toggle(element) {
      if (element.matches(".disabled, :disabled")) return;
      const open = dropdownOpen(element);
      clearMenus();
      if (!open) dropdown.show(element);
    },
  };
  // Any other click closes open menus, except a click in a form field or form inside the open dropdown.
  function clearMenus(click) {
    for (const toggle of document.querySelectorAll(DROPDOWN_TOGGLES)) {
      if (!dropdownOpen(toggle)) continue;
      const container = toggle.parentElement ?? toggle;
      if (click && container.contains(click.target) && (/^(input|textarea)$/i.test(click.target.tagName) || click.target.closest("form"))) continue;
      dropdown.hide(toggle);
    }
  }
  // Bootstrap 3 marks the tab's <li> active; Bootstrap 5 marks the tab itself.
  const TAB_TOGGLES = '[data-toggle="tab"],[data-toggle="pill"],[data-bs-toggle="tab"],[data-bs-toggle="pill"],[data-bs-toggle="list"]';
  const tabItem = (tab) => (!tab.hasAttribute("data-bs-toggle") && tab.parentElement?.tagName === "LI" ? tab.parentElement : tab);
  const tab = {
    show(element) {
      if (tabItem(element).classList.contains("active")) return;
      const list = element.closest("ul:not(.dropdown-menu)") ?? element.closest("[role=tablist],.nav,.list-group");
      const tabs = list ? [...list.querySelectorAll(TAB_TOGGLES)] : [];
      if (!tabs.includes(element)) tabs.push(element);
      const previous = tabs.find((candidate) => candidate !== element && tabItem(candidate).classList.contains("active")) ?? null;
      const hiding = previous && event(previous, "hide.bs.tab", { relatedTarget: element });
      const showing = event(element, "show.bs.tab", { relatedTarget: previous ?? undefined });
      if (showing.isDefaultPrevented() || hiding?.isDefaultPrevented()) return;
      for (const candidate of tabs) {
        const active = candidate === element;
        tabItem(candidate).classList.toggle("active", active);
        candidate.setAttribute("aria-selected", String(active));
        if (!candidate.hasAttribute("data-bs-toggle")) candidate.setAttribute("aria-expanded", String(active));
        const pane = targetsOf(candidate)[0];
        if (pane) { pane.classList.toggle("active", active); setShown(pane, active); }
      }
      if (previous) event(previous, "hidden.bs.tab", { relatedTarget: element });
      event(element, "shown.bs.tab", { relatedTarget: previous ?? undefined });
    },
  };
  const alertBox = {
    close(element) {
      const target = element.closest(".alert") ?? element;
      if (event(target, "close.bs.alert").isDefaultPrevented()) return;
      target.classList.remove("in", "show");
      target.remove();
      event(target, "closed.bs.alert");
      window.jQuery(target).remove();
    },
  };
  // $(element).<plugin>(argument, relatedTarget), as Bootstrap 3.4.1's Plugin functions.
  const plugins = {
    tooltip: (element, argument) => hint(element, "tooltip", argument ?? {}),
    popover: (element, argument) => hint(element, "popover", argument ?? {}),
    modal(element, argument, relatedTarget) {
      const command = typeof argument === "string" ? argument : null;
      const options = { ...MODAL_DEFAULTS, ...dataOptions(element, ["backdrop", "keyboard", "show"]), ...(argument && typeof argument === "object" ? argument : {}) };
      if (!instance(element, "modal")) create(element, "modal", { options });
      if (command) modal[command]?.(element, relatedTarget);
      else if (options.show) modal.show(element, relatedTarget);
    },
    collapse(element, argument) {
      const command = typeof argument === "string" ? argument : null;
      if (!instance(element, "collapse")) {
        const options = { toggle: true, ...dataOptions(element, ["toggle"]), ...(argument && typeof argument === "object" ? argument : {}) };
        create(element, "collapse", { options });
        // A new collapse toggles unless asked to show/hide or created with toggle: false.
        if (options.toggle && !/show|hide/.test(command ?? "")) {
          collapse.toggle(element);
          if (command === "toggle") return;
        }
      }
      if (command) collapse[command]?.(element);
    },
    dropdown(element, argument) {
      if (!instance(element, "dropdown")) {
        create(element, "dropdown", {});
        // Data API toggles are handled by the delegated listener; other elements toggle on their own click.
        if (!element.matches(DROPDOWN_TOGGLES))
          element.addEventListener("click", (click) => { click.preventDefault(); click.stopPropagation(); dropdown.toggle(element); });
      }
      if (typeof argument === "string") dropdown[argument]?.(element);
    },
    tab(element, argument) { if (typeof argument === "string") tab[argument]?.(element); },
    alert(element, argument) { if (typeof argument === "string") alertBox[argument]?.(element); },
  };
  const attach = ($) => {
  if (typeof $?.fn?.jquery !== "string") return;
  for (const [name, run] of Object.entries(plugins)) {
    if ($.fn[name]) continue;
    const plugin = function (argument, relatedTarget) {
      return this.each(function () {
        run(this, argument, relatedTarget);
      });
    };
    plugin.__ppSimCompat = true;
    $.fn[name] = plugin;
  }
  if ($.fn.popover && !$.fn.popover.Constructor) {
    $.fn.popover.Constructor = function LocalPopover() {};
    $.fn.popover.Constructor.prototype.getPosition = function ($element) {
      const element = ($element ?? this.$element)?.[0];
      if (!element) return { width: 0, height: 0, top: 0, left: 0, scroll: 0 };
      const rect = element.getBoundingClientRect();
      return { width: rect.width || element.offsetWidth, height: rect.height || element.offsetHeight, top: rect.top + window.pageYOffset, left: rect.left + window.pageXOffset, scroll: 0 };
    };
    $.fn.popover.Constructor.prototype.replaceArrow = function (delta, dimension, isVertical) {
      const arrow = this.arrow();
      if (isVertical) arrow.css("left", "50%").css("top", "");
      else arrow.css("top", "50%").css("left", "");
    };
  }
  if ($.fn.tooltip && !$.fn.tooltip.Constructor) $.fn.tooltip.Constructor = function LocalTooltip() {};
  };
  compat.bootstrapPlugins = attach;
  attach(window.jQuery);
  watchJQuery(compat, attach);
  // The data API acts only for local plugins: a real Bootstrap owns its own handlers.
  const local = (name) => Boolean(window.jQuery?.fn?.[name]?.__ppSimCompat);
  const handleCompatibilityClick = (click) => {
    const $ = window.jQuery;
    const source = click.target instanceof Element ? click.target : click.target?.parentElement;
    if (!$ || !source) return;
    // Bootstrap 3 (data-*) and Bootstrap 5 (data-bs-*) data API: the platform bundle's local
    // equivalent serves both builds (lib/platform-manifest.mjs).
    const menuToggle = source.closest(DROPDOWN_TOGGLES);
    if (menuToggle && local("dropdown")) { click.preventDefault(); $(menuToggle).dropdown("toggle"); return; }
    if (local("dropdown")) clearMenus(click);
    const dismiss = source.closest('[data-dismiss="modal"],[data-bs-dismiss="modal"]');
    if (dismiss) { if (!local("modal")) return; click.preventDefault(); const element = dismiss.closest(".modal"); if (element) $(element).modal("hide"); return; }
    const close = source.closest('[data-dismiss="alert"],[data-bs-dismiss="alert"]');
    if (close) {
      if (!local("alert")) return;
      click.preventDefault();
      const targets = targetsOf(close);
      for (const element of targets.length ? targets : [close.closest(".alert")].filter(Boolean)) $(element).alert("close");
      return;
    }
    const toggle = source.closest("[data-toggle],[data-bs-toggle]"); if (!toggle) return;
    const kind = toggle.getAttribute("data-toggle") || toggle.getAttribute("data-bs-toggle");
    if (!local({ tab: "tab", pill: "tab", list: "tab", collapse: "collapse", modal: "modal" }[kind])) return;
    if (["tab", "pill", "list"].includes(kind)) { click.preventDefault(); $(toggle).tab("show"); return; }
    if (kind === "collapse") {
      if (toggle.tagName === "A" || !(toggle.getAttribute("data-target") || toggle.getAttribute("data-bs-target"))) click.preventDefault();
      for (const element of targetsOf(toggle)) {
        if (!instance(element, "collapse")) create(element, "collapse", { options: { toggle: false } });
        collapse.toggle(element);
      }
      return;
    }
    if (kind === "modal") {
      if (toggle.tagName === "A" || toggle.tagName === "AREA") click.preventDefault();
      const element = targetsOf(toggle)[0];
      if (!element) return;
      // A first open takes the target's and the trigger's options; later clicks toggle.
      if (instance(element, "modal")) $(element).modal("toggle", toggle);
      else $(element).modal(dataOptions(toggle, ["backdrop", "keyboard", "show"]), toggle);
    }
  };
  document.addEventListener("click", handleCompatibilityClick);
  ((globalThis.__portalSimulation ||= {}).compatibility ||= {}).bootstrapPluginsMode = "local-compatibility";
  console.info("Local Bootstrap interaction compatibility active for tooltip, popover, modal, dropdown, tab, collapse, and alert controls.");
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
