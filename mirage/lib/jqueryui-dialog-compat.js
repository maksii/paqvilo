/* Local jQuery UI dialog adapter. It reproduces the dialog widget's DOM contract
 * (div.ui-dialog with title bar, close button, content and button pane; the modal
 * overlay; dialogClass, width, buttons, open/close callbacks and dialogopen /
 * dialogclose events) so portal scripts that style or query the widget keep working
 * when the platform's jQuery UI build is not available locally. */
(() => {
  // One adapter per document: a repeated include only re-attaches the plugin.
  const compat = (globalThis.__ppSimCompat ||= {});
  if (compat.jqueryUiDialog) {
    compat.jqueryUiDialog(globalThis.jQuery);
    return;
  }
  if (!globalThis.jQuery) {
    console.error('Local dialog compatibility requires jQuery.');
    return;
  }
  const states = new WeakMap();
  let overlayStyle;
  let sequence = 0;
  const defaults = {
    autoOpen: true,
    buttons: [],
    closeOnEscape: true,
    closeText: 'Close',
    dialogClass: '',
    draggable: true,
    modal: false,
    resizable: true,
    title: null,
    width: 300,
  };
  const fire = (state, name, event) => {
    const callback = state.options[name];
    // A DOM event reaches both jQuery handlers and addEventListener listeners.
    const action = new CustomEvent(`dialog${name.toLowerCase()}`, { bubbles: true, cancelable: true });
    state.element.dispatchEvent(action);
    if (typeof callback !== 'function') return !action.defaultPrevented;
    const callbackEvent = state.jquery.Event(action);
    if (event) callbackEvent.originalEvent = event;
    return callback.call(state.element, callbackEvent, {}) !== false && !callbackEvent.isDefaultPrevented();
  };
  const buttonList = (buttons) =>
    Array.isArray(buttons)
      ? buttons
      : Object.entries(buttons ?? {}).map(([text, value]) =>
          typeof value === 'function' ? { text, click: value } : { text, ...value },
        );
  function render(state) {
    const { wrapper, element, options } = state;
    wrapper.className =
      `ui-dialog ui-corner-all ui-widget ui-widget-content ui-front ${options.dialogClass ?? ''}`.trim();
    wrapper.style.width = typeof options.width === 'number' ? `${options.width}px` : String(options.width ?? '');
    state.title.textContent = options.title ?? element.getAttribute('title') ?? '';
    state.close.title = options.closeText;
    state.close.lastChild.textContent = options.closeText;
    const buttons = buttonList(options.buttons);
    state.buttonset.replaceChildren(
      ...buttons.map((definition) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `ui-button ui-corner-all ui-widget ${definition.class ?? ''}`.trim();
        button.textContent = definition.text ?? '';
        if (definition.id) button.id = definition.id;
        button.addEventListener('click', (event) => definition.click?.call(element, event));
        return button;
      }),
    );
    state.buttonpane.hidden = !buttons.length;
  }
  function create(element, options, jquery) {
    const id = element.id || `ui-id-${++sequence}`;
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'dialog');
    wrapper.setAttribute('tabindex', '-1');
    wrapper.setAttribute('aria-describedby', id);
    wrapper.style.cssText =
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1060;display:none;max-width:95vw;max-height:95vh;overflow:auto';
    const titlebar = document.createElement('div');
    titlebar.className = 'ui-dialog-titlebar ui-corner-all ui-widget-header ui-helper-clearfix';
    const title = document.createElement('span');
    title.className = 'ui-dialog-title';
    title.id = `ui-id-${++sequence}`;
    wrapper.setAttribute('aria-labelledby', title.id);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ui-button ui-corner-all ui-widget ui-button-icon-only ui-dialog-titlebar-close';
    close.innerHTML =
      '<span class="ui-button-icon ui-icon ui-icon-closethick"></span><span class="ui-button-icon-space"> </span>';
    close.append(document.createTextNode('Close'));
    titlebar.append(title, close);
    const buttonpane = document.createElement('div');
    buttonpane.className = 'ui-dialog-buttonpane ui-widget-content ui-helper-clearfix';
    const buttonset = document.createElement('div');
    buttonset.className = 'ui-dialog-buttonset';
    buttonpane.append(buttonset);
    const placeholder = document.createComment('dialog');
    element.before(placeholder);
    element.classList.add('ui-dialog-content', 'ui-widget-content');
    wrapper.append(titlebar, element, buttonpane);
    ((options.appendTo && document.querySelector(options.appendTo)) || document.body).append(wrapper);
    const state = {
      element,
      jquery,
      originalDisplay: element.style.display,
      originalDisplayPriority: element.style.getPropertyPriority('display'),
      originalHidden: element.getAttribute('hidden'),
      options,
      wrapper,
      title,
      close,
      buttonpane,
      buttonset,
      placeholder,
      overlay: null,
      opener: null,
      open: false,
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      hide(state, event);
    });
    wrapper.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.options.closeOnEscape && !event.defaultPrevented) {
        event.preventDefault();
        hide(state, event);
      }
    });
    render(state);
    return state;
  }
  function moveToTop(wrapper, gap = 1) {
    // Leave room for a new modal's overlay above earlier dialogs, even when reopening an older wrapper.
    const top = Array.from(wrapper.parentElement?.children ?? []).reduce(
      (zIndex, sibling) => {
        if (sibling === wrapper || !sibling.classList.contains('ui-front') || !sibling.getClientRects().length)
          return zIndex;
        return Math.max(zIndex, Number(getComputedStyle(sibling).zIndex) || 0);
      },
      (Number(wrapper.style.zIndex) || 1060) - gap,
    );
    wrapper.style.zIndex = String(top + gap);
    return top + gap;
  }
  function show(state) {
    if (state.open) return;
    state.opener = document.activeElement;
    const zIndex = moveToTop(state.wrapper, state.options.modal ? 2 : 1);
    if (state.options.modal) {
      if (!overlayStyle && globalThis.location.origin !== 'null') {
        // The fallback layer precedes page layers and loads under a same-origin style policy.
        overlayStyle = document.createElement('link');
        overlayStyle.rel = 'stylesheet';
        overlayStyle.href = `${globalThis.location.origin}/__sim-static/jqueryui-dialog-compat.css`;
        overlayStyle.setAttribute('blocking', 'render');
        document.head.prepend(overlayStyle);
      }
      state.overlay ??= Object.assign(document.createElement('div'), { className: 'ui-widget-overlay ui-front' });
      state.overlay.setAttribute('data-paqvilo-dialog-overlay', '');
      state.overlay.style.cssText = `position:fixed;inset:0;z-index:${zIndex - 1}`;
      state.wrapper.before(state.overlay);
    }
    state.element.hidden = false;
    state.wrapper.style.display = '';
    state.jquery(state.element).show();
    state.open = true;
    state.wrapper.focus?.();
    fire(state, 'open');
  }
  function hide(state, event) {
    if (!state.open) return;
    const allowed = fire(state, 'beforeClose', event);
    if (!allowed || !state.open) return;
    state.wrapper.style.display = 'none';
    state.overlay?.remove();
    state.open = false;
    state.opener?.focus?.();
    fire(state, 'close', event);
  }
  function initializeDialog(element, argument, jquery) {
    let state = states.get(element);
    if (state) {
      // Re-initialising an existing dialog sets its options and opens it as jQuery UI's _init does.
      Object.assign(state.options, argument ?? {});
      render(state);
    } else {
      state = create(element, { ...defaults, ...argument }, jquery);
      states.set(element, state);
    }
    if (state.options.autoOpen !== false) show(state);
    else if (!state.open) state.wrapper.style.display = 'none';
  }
  function destroy(state) {
    const { element, overlay, originalDisplay, originalDisplayPriority, originalHidden, placeholder, wrapper } = state;
    state.open = false;
    overlay?.remove();
    element.classList.remove('ui-dialog-content', 'ui-widget-content');
    element.style.setProperty('display', originalDisplay, originalDisplayPriority);
    if (originalHidden === null) element.removeAttribute('hidden');
    else element.setAttribute('hidden', originalHidden);
    if (placeholder.parentNode) placeholder.replaceWith(element);
    else element.remove();
    wrapper.remove();
    states.delete(element);
  }
  function runDialogCommand(command, args, state) {
    if (!state) return;
    if (command === 'open') show(state);
    else if (command === 'close') hide(state);
    else if (command === 'moveToTop') moveToTop(state.wrapper);
    else if (command === 'option') {
      if (args.length === 2) state.options[args[0]] = args[1];
      else if (args[0] && typeof args[0] === 'object') Object.assign(state.options, args[0]);
      render(state);
    } else if (command === 'destroy') destroy(state);
  }
  const plugin = function (argument, ...args) {
    const jquery = this.constructor;
    const command = typeof argument === 'string' ? argument : null;
    if (command === 'isOpen') return this.length ? Boolean(states.get(this[0])?.open) : false;
    if (command === 'instance') return this.length ? states.get(this[0]) : undefined;
    if (command === 'option' && args.length === 1 && typeof args[0] === 'string')
      return this.length ? states.get(this[0])?.options[args[0]] : undefined;
    if (command === 'widget') return jquery(this.length ? (states.get(this[0])?.wrapper ?? []) : []);
    return this.each(function () {
      if (!command) {
        initializeDialog(this, argument, jquery);
        return;
      }
      runDialogCommand(command, args, states.get(this));
    });
  };
  plugin.__ppSimCompat = true;
  const attach = ($) => {
    if (typeof $?.fn?.jquery === 'string' && !$.fn.dialog) $.fn.dialog = plugin;
  };
  compat.jqueryUiDialog = attach;
  attach(globalThis.jQuery);
  watchJQuery(compat, attach);
  globalThis.__portalSimulation ||= {};
  globalThis.__portalSimulation.compatibility ||= {};
  globalThis.__portalSimulation.compatibility.jqueryUiDialogMode = 'local-compatibility';
  console.info('Local jQuery UI dialog compatibility active for source-used dialog behaviour.');
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
