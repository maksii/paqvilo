/*
 * Local equivalent of the platform's /xrm-adx/js/crmentityformview.js (basic and multistep
 * form pages, loaded inside the WebForms form after the WebForms resources): form field
 * helpers that page scripts and generated markup call (LimitInput, setPrecision,
 * scrollToAndFocus, validateRequiredField, updateConstantSum, ...), dirty tracking with the
 * confirm-on-exit prompt, the document-ready behaviours (active step announcer, readonly
 * URL/e-mail links, data-required, Enter key handling) and the validation summary
 * accessibility wrapper around Page_ClientValidate. Functions that the local WebForms
 * runtime (webforms-compat.js) already defines are kept. Idempotent.
 */
(() => {
  "use strict";
  if (window.__ppCrmEntityFormView) return;
  window.__ppCrmEntityFormView = true;
  const w = window;
  const jq = () => (typeof w.jQuery?.fn?.jquery === "string" ? w.jQuery : null);
  const define = (name, fn) => {
    if (typeof w[name] !== "function") w[name] = fn;
  };
  const resource = (key, fallback) => (typeof w.ResourceManager?.[key] === "string" ? w.ResourceManager[key] : fallback);
  const visible = (element) => Boolean(element && element.getClientRects().length);

  define("GetMaxLength", (field) => field.exMaxLen);
  define("GetSelectionLength", (field) => (field.selectionStart == null ? 0 : field.selectionEnd - field.selectionStart));
  define("LimitInput", (field, event) => {
    let allowed = true;
    const max = w.GetMaxLength(field);
    if (max != null) {
      const length = field.value.length;
      const key = event.keyCode ?? event.which;
      const permitted = key < 32 || (key >= 33 && key <= 40) || key === 46;
      if (!permitted && length - Number(w.GetSelectionLength(field)) >= Number(max)) allowed = false;
      if (length > Number(max)) field.value = field.value.substring(0, Number(max));
    }
    event.returnValue = allowed;
    return allowed;
  });
  define("LimitPaste", (field, event) => {
    let allowed = true;
    const max = w.GetMaxLength(field);
    const pasted = event.clipboardData?.getData?.("text") ?? "";
    if (max != null && field.value.length + pasted.length - Number(w.GetSelectionLength(field)) > Number(max)) allowed = false;
    event.returnValue = allowed;
    return allowed;
  });
  define("LengthError", (field) => {
    const max = parseInt(field.getAttribute("maxlength"), 10);
    document.getElementById("length_error_message")?.remove();
    if (field.value.length === max) {
      field.insertAdjacentHTML("afterend", `<p class="alert sr-only" role="alert" id="length_error_message">${resource("Length_ErrorText", "You’ve reached the maximum characters allowed in this field.")}</p>`);
      return false;
    }
    return true;
  });
  define("setPrecision", (id, precision) => {
    const field = id ? document.getElementById(id) : null;
    if (!field || field.value === "" || isNaN(field.value)) return;
    field.value = parseFloat(field.value).toFixed(precision || 0);
  });
  define("getUrlScheme", (value) => {
    const index = String(value).indexOf("://");
    return index === -1 ? "" : String(value).substr(0, index);
  });
  const allowedScheme = (url) => ["http", "https", "ftp", "ftps", "onenote", "tel"].includes(w.getUrlScheme(url).toLowerCase());
  define("launchTickerSymbolUrl", (symbol) => {
    if (symbol !== "") w.open(`http://go.microsoft.com/fwlink?linkid=8506&Symbol=${encodeURIComponent(String(symbol).toUpperCase())}`, "_blank");
    return false;
  });
  define("uppercaseTickerSymbol", (element) => {
    if (element.value !== "") element.value = element.value.toUpperCase();
  });
  define("launchUrl", (url) => {
    if (url !== "" && allowedScheme(url)) w.open(url, "_blank");
    return false;
  });
  define("launchEmail", (email) => {
    if (email !== "") w.location.href = `mailto:${email}`;
    return false;
  });
  define("prefixHttp", (url, maxLength) => {
    const value = String(url).trim();
    return /^https?:\/\//i.test(value) ? value : `https://${value.substring(0, maxLength - "https://".length)}`;
  });
  define("validateUrlProtocol", (url, maxLength) => {
    if (url === "") return url;
    const scheme = w.getUrlScheme(url).toLowerCase();
    if (allowedScheme(url)) return url;
    if (scheme === "") return w.prefixHttp(url, maxLength || 100);
    w.alert("Invalid Protocol. Only HTTP, HTTPS, FTP, FTPS, ONENOTE and TEL protocols are allowed in this field.");
    return url;
  });
  define("validateUrlInput", (element, maxLength) => {
    element.value = w.validateUrlProtocol(element.value, maxLength);
  });
  define("validateRequiredField", (id) => {
    const control = document.getElementById(id);
    if (!control) return;
    control.setAttribute("aria-invalid", control.value === "" || control.value == null ? "true" : "false");
    for (const option of control.querySelectorAll('input[type="radio"], input[type="checkbox"]')) if (option.checked) control.setAttribute("aria-invalid", "false");
  });
  define("scrollToPosition", (id) => {
    const element = id == null ? null : document.getElementById(id);
    if (!element) return;
    let x = element.offsetLeft;
    let y = element.offsetTop;
    for (let parent = element.offsetParent; parent; parent = parent.offsetParent) {
      x += parent.offsetLeft;
      y += parent.offsetTop;
    }
    w.scrollTo(x, y);
  });
  define("setFocus", (id) => {
    if (id != null) document.getElementById(id)?.focus();
  });
  define("scrollToAndFocus", (scrollToId, focusOnId) => {
    if (!focusOnId) return;
    w.scrollToPosition(scrollToId || focusOnId);
    w.setFocus(focusOnId);
  });
  define("disableButtons", () => {
    for (const input of document.getElementsByTagName("input")) if (input.type === "submit" || input.type === "button") input.disabled = true;
  });
  define("updateConstantSum", (name) => {
    const elements = [...document.getElementsByClassName(name)];
    const total = elements.reduce((sum, element) => (!isNaN(element.value) && element.value.length ? sum + parseInt(element.value, 10) : sum), 0);
    const field = document.getElementById(`ConstantSumTotalValue${name}`);
    if (elements.length && field) field.value = total;
  });
  define("setIsDirty", (id) => {
    const element = id ? document.getElementById(id) : null;
    if (element && !element.classList.contains("dirty")) element.classList.add("dirty");
  });
  define("isDirty", () => document.getElementsByClassName("dirty").length > 0);
  define("clearIsDirty", () => {
    for (const element of [...document.getElementsByClassName("dirty")]) element.classList.remove("dirty");
  });
  define("confirmExit", () => {
    if (document.getElementById("confirmOnExit")?.value !== "true" || !w.isDirty()) return undefined;
    const custom = document.getElementById("confirmOnExitMessage")?.value;
    return custom || resource("Click_Stay_To_Save_Your_Changes", "Your changes haven't been saved. Would you like to stay on the page to save your changes?");
  });
  w.onbeforeunload = w.confirmExit;
  // The platform script replaces these built-ins on form pages: on reference-portal /contact-us/
  // document.getElementsByClassName returns an Array (page scripts call .forEach on it) that
  // matches word boundaries ("control" includes .form-control), while jQuery class selection
  // keeps native matching: the platform jQuery's selector engine does not use the method
  // (support.getElementsByClassName is false; live-run11, live-run12).
  String.prototype.trim = function () {
    return this.replace(/^\s+|\s+$/g, "");
  };
  document.getElementsByClassName = function (name) {
    const pattern = new RegExp(`\\b${name}\\b`);
    return [...this.getElementsByTagName("*")].filter((element) => pattern.test(element.className));
  };
  const nativeClassSelection = ($) => {
    if (!$?.find || typeof $.fn?.jquery !== "string" || $.find.__ppNativeClassSelection) return;
    // Selector engines (jQuery <= 3.6) that check the support flag, and the class finder
    // used for compound selectors, stop using the replaced method.
    if ($.find.support && "getElementsByClassName" in $.find.support) $.find.support.getElementsByClassName = false;
    if ($.expr?.find?.CLASS) delete $.expr.find.CLASS;
    // jQuery >= 3.7 answers a lone class selector with context.getElementsByClassName.
    const find = $.find;
    const wrapped = function (selector, context, results, seed) {
      if (!seed && typeof selector === "string" && /^\.[\w-]+$/.test(selector) && (context == null || context === document)) {
        const output = results || [];
        Array.prototype.push.apply(output, document.querySelectorAll(selector));
        return output;
      }
      return find.apply(this, arguments);
    };
    Object.assign(wrapped, find);
    wrapped.__ppNativeClassSelection = true;
    $.find = wrapped;
  };
  nativeClassSelection(w.jQuery);
  const registry = (w.__ppSimCompat ||= {});
  (registry.jqueryWatchers ||= new Set()).add(nativeClassSelection);
  if (!registry.jqueryWatched) {
    const descriptor = Object.getOwnPropertyDescriptor(w, "jQuery");
    if (!descriptor || (!descriptor.get && !descriptor.set && descriptor.configurable !== false)) {
      let current = w.jQuery;
      try {
        Object.defineProperty(w, "jQuery", {
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
        // A non-configurable global keeps the current instance.
      }
    }
  }
  define("setfocusOnSuccessMessage", () => {
    const message = document.getElementById("MessageLabel");
    if (visible(message)) {
      const selected = document.querySelector('#casetypecode option[selected="selected"]');
      for (const label of document.querySelectorAll("div.status > span.label-default")) label.textContent = selected?.textContent ?? "";
      message.setAttribute("aria-live", "polite");
      message.setAttribute("aria-atomic", "true");
      if (message.parentElement?.matches("div.success") && w.history.replaceState) w.history.replaceState(null, document.title, w.location.href);
      return;
    }
    if (visible(document.getElementById("PreviousButton"))) {
      const first = [...document.querySelectorAll("form:not(.filter):not(.form-search) input, select, textarea, button")].find((element) => visible(element) && !element.disabled && !element.readOnly);
      first?.focus();
    }
  });

  // Validation summary accessibility around the WebForms validation entry point.
  if (typeof w.Page_ClientValidate === "function" && !w.Page_ClientValidate.__ppSummary) {
    const original = w.Page_ClientValidate;
    const wrapped = function (...args) {
      original.apply(this, args);
      if (w.Page_IsValid === false) {
        for (const summary of document.querySelectorAll(".validation-summary")) {
          summary.setAttribute("aria-live", "assertive");
          summary.setAttribute("aria-atomic", "true");
          for (const list of summary.querySelectorAll("ul")) list.setAttribute("role", "list");
          for (const item of summary.querySelectorAll("ul li")) item.setAttribute("role", "listitem");
          for (const link of summary.querySelectorAll("ul li a")) {
            const id = link.getAttribute("referenceControlId");
            const control = id ? document.getElementById(id) : null;
            if (control && /^(INPUT|TEXTAREA|SELECT)$/.test(control.tagName)) w.validateRequiredField(id);
          }
        }
        for (const header of document.querySelectorAll(".validation-header")) header.setAttribute("role", "presentation");
        return false;
      }
      return true;
    };
    wrapped.__ppSummary = true;
    w.Page_ClientValidate = wrapped;
  }

  const ready = () => {
    const active = document.querySelector(".progress .list-group-item.active");
    if (active) {
      const label = active.textContent;
      const host = active.parentElement?.parentElement;
      if (host) {
        const announcer = document.createElement("div");
        announcer.id = label;
        announcer.className = "sr-only";
        announcer.setAttribute("aria-live", "assertive");
        announcer.textContent = label;
        host.appendChild(announcer);
      }
      document.querySelector("fieldset")?.setAttribute("aria-labelledby", label);
      setTimeout(() => document.querySelector("fieldset .control")?.firstChild?.focus?.());
    }
    const linkify = (input, href, text, target) => {
      const container = document.createElement("div");
      container.className = "control";
      const link = document.createElement("a");
      link.className = "text-primary";
      link.style.cursor = "pointer";
      link.setAttribute("href", href);
      if (target) link.setAttribute("target", target);
      link.setAttribute("readonly", "readonly");
      link.textContent = text;
      input.style.display = "none";
      container.appendChild(link);
      input.parentElement?.appendChild(container);
    };
    for (const input of document.querySelectorAll(".entity-form input[type='url'][readonly], .entity-form input[type='url'][disabled]")) {
      const ticker = input.classList.contains("tickersymbol");
      const value = input.value;
      if (!value) continue;
      linkify(input, ticker ? `http://go.microsoft.com/fwlink?linkid=8506&Symbol=${encodeURIComponent(value.toUpperCase())}` : value, value, "_blank");
    }
    for (const input of document.querySelectorAll(".entity-form input[type='email'][readonly], .entity-form input[type='email'][disabled]"))
      if (input.value) linkify(input, `mailto:${input.value}`, input.value, null);
    for (const span of document.querySelectorAll(".entity-form span[data-required]")) {
      const required = span.getAttribute("data-required") === "true";
      for (const control of span.querySelectorAll("input,select,textarea")) control.required = required;
    }
    for (const form of document.querySelectorAll(".entity-form"))
      form.addEventListener("keypress", (event) => {
        if ((event.keyCode || event.which) !== 13 || event.target === form) return;
        const composite = document.querySelector("textarea[id^=address]")?.closest(".control")?.querySelector(".popover-content");
        if (composite?.contains(document.activeElement)) event.preventDefault();
        event.stopPropagation();
      });
    for (const button of document.querySelectorAll("form input[type=submit], form button"))
      button.addEventListener("keypress", (event) => {
        if ((event.keyCode || event.which) !== 13) return;
        event.preventDefault();
        event.stopPropagation();
        button.click();
      });
  };
  const $ = jq();
  if ($) $(ready);
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  w.addEventListener("load", () => {
    w.setfocusOnSuccessMessage();
    w.portal?.setValidationSummaryFocus?.();
  });
})();
