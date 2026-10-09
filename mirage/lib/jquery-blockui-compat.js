/*
 * Local equivalent of the jQuery blockUI 2.56 API that the platform serves at
 * /js/jquery.blockUI.js (form pages) and bundles in postpreform.bundle (every page):
 * $.blockUI, $.unblockUI, $.growlUI, $.fn.block, $.fn.unblock and $.blockUI.defaults,
 * with the plugin's layer markup (div.blockUI, div.blockUI.blockOverlay,
 * div.blockUI.blockMsg.blockPage|blockElement), z-order, data keys and callbacks.
 * Attaches to every jQuery instance that a page installs; idempotent.
 */
(() => {
  "use strict";
  const registry = (window.__ppSimCompat ||= {});
  if (registry.blockUI) return;
  registry.blockUI = true;

  function attach($) {
    if (!$ || typeof $.fn?.jquery !== "string" || $.blockUI?.__ppSimCompat) return;
    const noop = () => {};
    let pageBlock = null;
    let pageBlockEls = [];
    const defaults = {
      message: "<h1>Please wait...</h1>",
      title: null,
      draggable: true,
      theme: false,
      css: { padding: 0, margin: 0, width: "30%", top: "40%", left: "35%", textAlign: "center", color: "#000", border: "3px solid #aaa", backgroundColor: "#fff", cursor: "wait" },
      themedCSS: { width: "30%", top: "40%", left: "35%" },
      overlayCSS: { backgroundColor: "#000", opacity: 0.6, cursor: "wait" },
      cursorReset: "default",
      growlCSS: { width: "350px", top: "10px", left: "", right: "10px", border: "none", padding: "5px", opacity: 0.6, cursor: "default", color: "#fff", backgroundColor: "#000", "border-radius": "10px" },
      iframeSrc: /^https/i.test(window.location.href || "") ? "javascript:false" : "about:blank",
      forceIframe: false,
      baseZ: 1000,
      centerX: true,
      centerY: true,
      allowBodyStretch: true,
      bindEvents: true,
      constrainTabKey: true,
      fadeIn: 200,
      fadeOut: 400,
      timeout: 0,
      showOverlay: true,
      focusInput: true,
      focusableElements: ":input:enabled:visible",
      onBlock: null,
      onUnblock: null,
      onOverlayClick: null,
      quirksmodeOffsetHack: 4,
      blockMsgClass: "blockMsg",
      ignoreIfBlocked: false,
    };

    function center(element, x, y) {
      const parent = element.parentNode;
      const style = element.style;
      const left = (parent.offsetWidth - element.offsetWidth) / 2 - (parseInt($.css(parent, "borderLeftWidth"), 10) || 0);
      const top = (parent.offsetHeight - element.offsetHeight) / 2 - (parseInt($.css(parent, "borderTopWidth"), 10) || 0);
      if (x) style.left = left > 0 ? `${left}px` : "0";
      if (y) style.top = top > 0 ? `${top}px` : "0";
    }

    function handler(event) {
      const opts = event.data;
      if (event.type === "keydown" && event.keyCode === 9 && pageBlock && opts.constrainTabKey) {
        const elements = pageBlockEls;
        const forward = !event.shiftKey && event.target === elements[elements.length - 1];
        const back = event.shiftKey && event.target === elements[0];
        if (forward || back) {
          setTimeout(() => (forward ? elements[0] : elements[elements.length - 1])?.focus(), 10);
          return false;
        }
      }
      const target = $(event.target);
      if (target.hasClass("blockOverlay") && opts.onOverlayClick) opts.onOverlayClick(event);
      if (target.parents(`div.${opts.blockMsgClass}`).length > 0) return true;
      return target.parents().children().filter("div.blockUI").length === 0;
    }

    function bind(on, element, opts) {
      const full = element === window;
      const $element = $(element);
      if (!on && ((full && !pageBlock) || (!full && !$element.data("blockUI.isBlocked")))) return;
      $element.data("blockUI.isBlocked", on);
      if (!full || !opts.bindEvents || (on && !opts.showOverlay)) return;
      const events = "mousedown mouseup keydown keypress keyup touchstart touchend touchmove";
      if (on) $(document).on(events, opts, handler);
      else $(document).off(events, handler);
    }

    function install(element, options) {
      const full = element === window;
      let message = options && options.message !== undefined ? options.message : undefined;
      const opts = $.extend({}, $.blockUI.defaults, options || {});
      if (opts.ignoreIfBlocked && $(element).data("blockUI.isBlocked")) return;
      opts.overlayCSS = $.extend({}, $.blockUI.defaults.overlayCSS, opts.overlayCSS || {});
      const css = $.extend({}, $.blockUI.defaults.css, opts.css || {});
      if (opts.onOverlayClick) opts.overlayCSS.cursor = "pointer";
      message = message === undefined ? opts.message : message;
      if (full && pageBlock) remove(window, { fadeOut: 0 });
      if (message && typeof message !== "string" && (message.parentNode || message.jquery)) {
        const node = message.jquery ? message[0] : message;
        const history = { el: node, parent: node.parentNode, display: node.style.display, position: node.style.position };
        $(element).data("blockUI.history", history);
        if (history.parent) history.parent.removeChild(node);
      }
      $(element).data("blockUI.onUnblock", opts.onUnblock);
      let z = opts.baseZ;
      const layer1 = $('<div class="blockUI" style="display:none"></div>');
      const layer2 = $(`<div class="blockUI blockOverlay" style="z-index:${z++};display:none;border:none;margin:0;padding:0;width:100%;height:100%;top:0;left:0"></div>`);
      const layer3 = $(`<div class="blockUI ${opts.blockMsgClass} ${full ? "blockPage" : "blockElement"}" style="z-index:${z + 10};display:none;position:${full ? "fixed" : "absolute"}"></div>`);
      if (message) layer3.css(css);
      layer2.css(opts.overlayCSS).css("position", full ? "fixed" : "absolute");
      const parent = full ? $("body") : $(element);
      if (!full && parent.css("position") === "static") {
        parent.css("position", "relative");
        parent.data("blockUI.static", true);
      }
      for (const layer of [layer1, layer2, layer3]) layer.appendTo(parent);
      if (message) {
        layer3.append(message);
        if (message.jquery || message.nodeType) $(message).show();
      }
      const done = opts.onBlock || noop;
      if (opts.fadeIn) {
        if (opts.showOverlay) layer2.fadeIn(opts.fadeIn, opts.showOverlay && !message ? done : noop);
        if (message) layer3.fadeIn(opts.fadeIn, done);
      } else {
        if (opts.showOverlay) layer2.show();
        if (message) layer3.show();
        if (opts.onBlock) opts.onBlock();
      }
      bind(true, element, opts);
      if (full) {
        pageBlock = layer3[0];
        pageBlockEls = $(opts.focusableElements, pageBlock).toArray();
        if (opts.focusInput) setTimeout(() => pageBlockEls[0]?.focus(), 20);
      } else center(layer3[0], opts.centerX, opts.centerY);
      if (opts.timeout) {
        const timer = setTimeout(() => (full ? $.unblockUI(opts) : $(element).unblock(opts)), opts.timeout);
        $(element).data("blockUI.timeout", timer);
      }
    }

    function reset(layers, history, opts, element) {
      const $element = $(element);
      layers.each(function () {
        if (this.parentNode) this.parentNode.removeChild(this);
      });
      if (history?.el) {
        history.el.style.display = history.display;
        history.el.style.position = history.position;
        if (history.parent) history.parent.appendChild(history.el);
        $element.removeData("blockUI.history");
      }
      if ($element.data("blockUI.static")) $element.css("position", "static");
      if (typeof opts.onUnblock === "function") opts.onUnblock(element, opts);
    }

    function remove(element, options) {
      const full = element === window;
      const $element = $(element);
      const history = $element.data("blockUI.history");
      const timer = $element.data("blockUI.timeout");
      if (timer) {
        clearTimeout(timer);
        $element.removeData("blockUI.timeout");
      }
      const opts = $.extend({}, $.blockUI.defaults, options || {});
      bind(false, element, opts);
      if (opts.onUnblock === null) {
        opts.onUnblock = $element.data("blockUI.onUnblock");
        $element.removeData("blockUI.onUnblock");
      }
      const layers = full ? $("body").children().filter(".blockUI").add("body > .blockUI") : $element.find(">.blockUI");
      if (opts.cursorReset) {
        if (layers.length > 1) layers[1].style.cursor = opts.cursorReset;
        if (layers.length > 2) layers[2].style.cursor = opts.cursorReset;
      }
      if (full) {
        pageBlock = null;
        pageBlockEls = [];
      }
      if (opts.fadeOut) {
        layers.fadeOut(opts.fadeOut);
        setTimeout(() => reset(layers, history, opts, element), opts.fadeOut);
      } else reset(layers, history, opts, element);
    }

    $.blockUI = function (options) {
      install(window, options);
    };
    $.unblockUI = function (options) {
      remove(window, options);
    };
    $.growlUI = function (title, message, timeout, onClose) {
      const growl = $('<div class="growlUI"></div>');
      if (title) growl.append(`<h1>${title}</h1>`);
      if (message) growl.append(`<h2>${message}</h2>`);
      if (timeout === undefined) timeout = 3000;
      $.blockUI({ message: growl, fadeIn: 700, fadeOut: 1000, centerY: false, timeout, showOverlay: false, onUnblock: onClose, css: $.blockUI.defaults.growlCSS });
    };
    $.fn.block = function (options) {
      if (this[0] === window) {
        $.blockUI(options);
        return this;
      }
      const opts = $.extend({}, $.blockUI.defaults, options || {});
      return this.each(function () {
        const $this = $(this);
        if (opts.ignoreIfBlocked && $this.data("blockUI.isBlocked")) return;
        $this.unblock({ fadeOut: 0 });
      }).each(function () {
        install(this, options);
      });
    };
    $.fn.unblock = function (options) {
      if (this[0] === window) {
        $.unblockUI(options);
        return this;
      }
      return this.each(function () {
        remove(this, options);
      });
    };
    $.blockUI.version = 2.56;
    $.blockUI.defaults = defaults;
    $.blockUI.__ppSimCompat = true;
  }

  attach(window.jQuery);
  // Pages may install another jQuery later (as the platform bundles do); re-attach to it.
  watchJQuery(registry, attach);

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
