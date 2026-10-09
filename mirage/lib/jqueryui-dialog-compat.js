/* Local jQuery UI dialog adapter. It reproduces the dialog widget's DOM contract
 * (div.ui-dialog with title bar, close button, content and button pane; the modal
 * overlay; dialogClass, width, buttons, open/close callbacks and dialogopen /
 * dialogclose events) so portal scripts that style or query the widget keep working
 * when the platform's jQuery UI build is not available locally. */
(() => {
  // One adapter per document: a repeated include only re-attaches the plugin.
  const compat = (window.__ppSimCompat ||= {});
  if (compat.jqueryUiDialog) { compat.jqueryUiDialog(window.jQuery); return; }
  if (!window.jQuery) { console.error("Local dialog compatibility requires jQuery."); return; }
  const states = new WeakMap();
  let sequence = 0;
  const defaults = { autoOpen: true, buttons: [], closeOnEscape: true, closeText: "Close", dialogClass: "", draggable: true, modal: false, resizable: true, title: null, width: 300 };
  const fire = (state, name, event) => {
    const $ = window.jQuery;
    const callback = state.options[name];
    if (typeof callback === "function") callback.call(state.element, event ?? $.Event(`dialog${name}`), {});
    // A DOM event reaches both jQuery handlers and addEventListener listeners.
    state.element.dispatchEvent(new CustomEvent(`dialog${name}`, { bubbles: true }));
  };
  const buttonList = (buttons) =>
    Array.isArray(buttons)
      ? buttons
      : Object.entries(buttons ?? {}).map(([text, value]) => (typeof value === "function" ? { text, click: value } : { text, ...value }));
  function render(state) {
    const { wrapper, element, options } = state;
    wrapper.className = `ui-dialog ui-corner-all ui-widget ui-widget-content ui-front ${options.dialogClass ?? ""}`.trim();
    wrapper.style.width = typeof options.width === "number" ? `${options.width}px` : String(options.width ?? "");
    state.title.textContent = options.title ?? element.getAttribute("title") ?? "";
    state.close.title = options.closeText;
    state.close.lastChild.textContent = options.closeText;
    const buttons = buttonList(options.buttons);
    state.buttonset.replaceChildren(
      ...buttons.map((definition) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `ui-button ui-corner-all ui-widget ${definition.class ?? ""}`.trim();
        button.textContent = definition.text ?? "";
        if (definition.id) button.id = definition.id;
        button.addEventListener("click", (event) => definition.click?.call(element, event));
        return button;
      }),
    );
    state.buttonpane.hidden = !buttons.length;
  }
  function create(element, options) {
    const id = element.id || `ui-id-${++sequence}`;
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "dialog");
    wrapper.setAttribute("tabindex", "-1");
    wrapper.setAttribute("aria-describedby", id);
    wrapper.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1060;display:none;max-width:95vw;max-height:95vh;overflow:auto";
    const titlebar = document.createElement("div");
    titlebar.className = "ui-dialog-titlebar ui-corner-all ui-widget-header ui-helper-clearfix";
    const title = document.createElement("span");
    title.className = "ui-dialog-title";
    title.id = `ui-id-${++sequence}`;
    wrapper.setAttribute("aria-labelledby", title.id);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ui-button ui-corner-all ui-widget ui-button-icon-only ui-dialog-titlebar-close";
    close.innerHTML = '<span class="ui-button-icon ui-icon ui-icon-closethick"></span><span class="ui-button-icon-space"> </span>';
    close.append(document.createTextNode("Close"));
    titlebar.append(title, close);
    const buttonpane = document.createElement("div");
    buttonpane.className = "ui-dialog-buttonpane ui-widget-content ui-helper-clearfix";
    const buttonset = document.createElement("div");
    buttonset.className = "ui-dialog-buttonset";
    buttonpane.append(buttonset);
    const placeholder = document.createComment("dialog");
    element.before(placeholder);
    element.classList.add("ui-dialog-content", "ui-widget-content");
    wrapper.append(titlebar, element, buttonpane);
    ((options.appendTo && document.querySelector(options.appendTo)) || document.body).append(wrapper);
    const state = { element, options, wrapper, title, close, buttonpane, buttonset, placeholder, overlay: null, open: false };
    close.addEventListener("click", (event) => {
      event.preventDefault();
      hide(state, event);
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.options.closeOnEscape) hide(state, event);
    });
    render(state);
    return state;
  }
  function show(state) {
    if (state.open) return;
    if (state.options.modal) {
      state.overlay ??= Object.assign(document.createElement("div"), { className: "ui-widget-overlay ui-front" });
      state.overlay.style.cssText = "position:fixed;inset:0;z-index:1059;background:rgba(0,0,0,.3)";
      state.wrapper.before(state.overlay);
    }
    state.element.hidden = false;
    state.wrapper.style.display = "";
    state.open = true;
    fire(state, "open");
    state.wrapper.focus?.();
  }
  function hide(state, event) {
    if (!state.open) return;
    const $ = window.jQuery;
    const before = $.Event("dialogbeforeClose");
    if (typeof state.options.beforeClose === "function" && state.options.beforeClose.call(state.element, before, {}) === false) return;
    state.wrapper.style.display = "none";
    state.overlay?.remove();
    state.open = false;
    fire(state, "close", event);
  }
  const plugin = function (argument, ...args) {
    const command = typeof argument === "string" ? argument : null;
    if (command === "isOpen") return this.length ? Boolean(states.get(this[0])?.open) : false;
    if (command === "instance") return this.length ? states.get(this[0]) : undefined;
    if (command === "option" && args.length === 1 && typeof args[0] === "string") return this.length ? states.get(this[0])?.options[args[0]] : undefined;
    if (command === "widget") return window.jQuery(this.length ? states.get(this[0])?.wrapper ?? [] : []);
    return this.each(function () {
      const element = this;
      let state = states.get(element);
      if (!command) {
        if (state) {
          // Re-initialising an existing dialog sets its options and opens it as jQuery UI's _init does.
          Object.assign(state.options, argument ?? {});
          render(state);
        } else {
          state = create(element, { ...defaults, ...(argument ?? {}) });
          states.set(element, state);
        }
        if (state.options.autoOpen !== false) show(state);
        else if (!state.open) state.wrapper.style.display = "none";
        return;
      }
      if (!state) return;
      if (command === "open") show(state);
      else if (command === "close") hide(state);
      else if (command === "moveToTop") state.wrapper.style.zIndex = String(Number(state.wrapper.style.zIndex || 1060) + 1);
      else if (command === "option") {
        if (args.length === 2) state.options[args[0]] = args[1];
        else if (args[0] && typeof args[0] === "object") Object.assign(state.options, args[0]);
        render(state);
      } else if (command === "destroy") {
        hide(state);
        element.classList.remove("ui-dialog-content", "ui-widget-content");
        state.placeholder.replaceWith(element);
        state.wrapper.remove();
        states.delete(element);
      }
    });
  };
  plugin.__ppSimCompat = true;
  const attach = ($) => {
    if (typeof $?.fn?.jquery === "string" && !$.fn.dialog) $.fn.dialog = plugin;
  };
  compat.jqueryUiDialog = attach;
  attach(window.jQuery);
  watchJQuery(compat, attach);
  ((globalThis.__portalSimulation ||= {}).compatibility ||= {}).jqueryUiDialogMode = "local-compatibility";
  console.info("Local jQuery UI dialog compatibility active for source-used dialog behavior.");
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
