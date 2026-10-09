/*
 * Local compatibility runtime for native Power Pages basic/advanced forms:
 * ASP.NET client validation (WebUIValidation.js semantics: Page_Validators,
 * Page_ClientValidate, ValidatorEnable, ValidatorOnChange, ...), WebForms
 * postback entry points (WebForm_DoPostBackWithOptions, __doPostBack,
 * WebForm_FireDefaultButton, WebForm_OnSubmit) and the crmentityformview.js
 * helpers (setIsDirty, clearIsDirty, disableButtons, scrollToAndFocus, ...).
 * A "postback" of a rendered native form is submitted as JSON to the local form
 * service; the outcome (message, redirect, step) follows the exported settings.
 * This file is loaded synchronously before the form markup, like the native
 * WebResource.axd/ScriptResource.axd scripts.
 */
(() => {
  "use strict";
  if (window.__ppWebFormsRuntime) return;
  window.__ppWebFormsRuntime = true;
  const w = window;
  const jq = () => (typeof w.jQuery?.fn?.jquery === "string" ? w.jQuery : null);

  // ---- WebUIValidation.js ------------------------------------------------------------
  w.Page_ValidationVer = "125";
  w.Page_IsValid = true;
  w.Page_BlockSubmit = false;
  w.Page_InvalidControlToBeFocused = null;
  w.Page_TextTypes = /^(text|password|file|search|tel|url|email|number|range|color|datetime|date|month|week|time|datetime-local)$/i;
  w.ValidatorUpdateDisplay = function (val) {
    if (typeof val.display === "string") {
      if (val.display === "None") return;
      if (val.display === "Dynamic") {
        val.style.display = val.isvalid ? "none" : "inline";
        return;
      }
    }
    val.style.visibility = val.isvalid ? "hidden" : "visible";
  };
  w.ValidatorUpdateIsValid = function () {
    w.Page_IsValid = w.AllValidatorsValid(w.Page_Validators);
  };
  w.AllValidatorsValid = function (validators) {
    if (typeof validators !== "undefined" && validators != null)
      for (let i = 0; i < validators.length; i++) if (!validators[i].isvalid) return false;
    return true;
  };
  w.ValidatorHookupControlID = function (controlID, val) {
    if (typeof controlID !== "string") return;
    const control = document.getElementById(controlID);
    if (typeof control !== "undefined" && control != null) w.ValidatorHookupControl(control, val);
    else {
      val.isvalid = true;
      val.enabled = false;
    }
  };
  w.ValidatorHookupControl = function (control, val) {
    if (typeof control.tagName !== "string") return;
    if (control.tagName !== "INPUT" && control.tagName !== "TEXTAREA" && control.tagName !== "SELECT") {
      for (let i = 0; i < control.childNodes.length; i++) w.ValidatorHookupControl(control.childNodes[i], val);
      return;
    }
    if (typeof control.Validators === "undefined") {
      control.Validators = [];
      const eventType = control.type === "radio" ? "click" : "change";
      control.addEventListener(eventType, (event) => w.ValidatorOnChange(event));
    }
    // Several forms on one page each run ValidatorOnLoad; hook a validator once.
    if (control.Validators.indexOf(val) < 0) control.Validators[control.Validators.length] = val;
  };
  w.ValidatorGetValue = function (id) {
    const control = document.getElementById(id);
    if (!control) return "";
    if (typeof control.value === "string" && control.tagName !== "SPAN" && control.tagName !== "TABLE") return control.value;
    return w.ValidatorGetValueRecursive(control);
  };
  w.ValidatorGetValueRecursive = function (control) {
    if (typeof control.value === "string" && (control.type !== "radio" || control.checked === true) && control.tagName !== "SPAN" && control.tagName !== "TABLE") return control.value;
    for (let i = 0; i < control.childNodes.length; i++) {
      const value = w.ValidatorGetValueRecursive(control.childNodes[i]);
      if (value !== "") return value;
    }
    return "";
  };
  w.Page_ClientValidate = function (validationGroup) {
    w.Page_InvalidControlToBeFocused = null;
    if (typeof w.Page_Validators === "undefined") return true;
    for (let i = 0; i < w.Page_Validators.length; i++) w.ValidatorValidate(w.Page_Validators[i], validationGroup, null);
    w.ValidatorUpdateIsValid();
    w.ValidationSummaryOnSubmit(validationGroup);
    w.Page_BlockSubmit = !w.Page_IsValid;
    if (!w.Page_IsValid) {
      // crmentityformview.js focuses the first summary link of an invalid form.
      const link = document.querySelector(".validation-summary a");
      if (link) setTimeout(() => link.focus(), 0);
    }
    return w.Page_IsValid;
  };
  w.ValidatorCommonOnSubmit = function () {
    w.Page_InvalidControlToBeFocused = null;
    const result = !w.Page_BlockSubmit;
    w.Page_BlockSubmit = false;
    return result;
  };
  w.ValidatorEnable = function (val, enable) {
    val.enabled = enable !== false;
    w.ValidatorValidate(val);
    w.ValidatorUpdateIsValid();
  };
  w.ValidatorOnChange = function (event) {
    w.Page_InvalidControlToBeFocused = null;
    const target = event?.target ?? event?.srcElement;
    const validators = target?.Validators ?? [];
    for (let i = 0; i < validators.length; i++) w.ValidatorValidate(validators[i], null, event);
    w.ValidatorUpdateIsValid();
  };
  w.ValidatorValidate = function (val, validationGroup, event) {
    val.isvalid = true;
    if ((typeof val.enabled === "undefined" || val.enabled !== false) && w.IsValidationGroupMatch(val, validationGroup)) {
      if (typeof val.evaluationfunction === "function") {
        val.isvalid = val.evaluationfunction(val);
        if (!val.isvalid && w.Page_InvalidControlToBeFocused == null && typeof val.focusOnError === "string" && val.focusOnError === "t") w.ValidatorSetFocus(val, event);
      }
    }
    w.ValidatorUpdateDisplay(val);
  };
  w.ValidatorSetFocus = function (val) {
    const control = typeof val.controltovalidate === "string" ? document.getElementById(val.controltovalidate) : null;
    if (control && typeof control.focus === "function") {
      control.focus();
      w.Page_InvalidControlToBeFocused = control;
    }
  };
  w.IsValidationGroupMatch = function (control, validationGroup) {
    if (typeof validationGroup === "undefined" || validationGroup == null) return true;
    const controlGroup = typeof control.validationGroup === "string" ? control.validationGroup : "";
    return controlGroup === validationGroup;
  };
  w.ValidatorOnLoad = function () {
    if (typeof w.Page_Validators === "undefined") return;
    for (let i = 0; i < w.Page_Validators.length; i++) {
      const val = w.Page_Validators[i];
      if (typeof val.evaluationfunction === "string") val.evaluationfunction = w[val.evaluationfunction];
      if (typeof val.isvalid === "string") val.isvalid = val.isvalid !== "False";
      else val.isvalid = true;
      if (typeof val.enabled === "string") val.enabled = val.enabled !== "False";
      if (typeof val.controltovalidate === "string") w.ValidatorHookupControlID(val.controltovalidate, val);
      if (typeof val.controlhookup === "string") w.ValidatorHookupControlID(val.controlhookup, val);
    }
    w.Page_ValidationActive = true;
  };
  w.ValidatorTrim = function (value) {
    const match = String(value ?? "").match(/^\s*(\S+(\s+\S+)*)\s*$/);
    return match == null ? "" : match[1];
  };
  w.RequiredFieldValidatorEvaluateIsValid = function (val) {
    return w.ValidatorTrim(w.ValidatorGetValue(val.controltovalidate)) !== w.ValidatorTrim(val.initialvalue ?? "");
  };
  w.RegularExpressionValidatorEvaluateIsValid = function (val) {
    const value = w.ValidatorGetValue(val.controltovalidate);
    if (w.ValidatorTrim(value).length === 0) return true;
    const matches = new RegExp(val.validationexpression).exec(value);
    return matches != null && value === matches[0];
  };
  w.CustomValidatorEvaluateIsValid = function (val) {
    let value = "";
    if (typeof val.controltovalidate === "string") {
      value = w.ValidatorGetValue(val.controltovalidate);
      if (w.ValidatorTrim(value).length === 0 && (typeof val.validateemptytext !== "string" || val.validateemptytext !== "true")) return true;
    }
    const args = { Value: value, IsValid: true };
    if (typeof val.clientvalidationfunction === "string" && typeof w[val.clientvalidationfunction] === "function") w[val.clientvalidationfunction](val, args);
    return args.IsValid;
  };
  w.ValidatorConvert = function (op, dataType) {
    if (dataType === "Integer") return /^\s*[-+]?\d+\s*$/.test(op) ? parseInt(op, 10) : null;
    if (dataType === "Double" || dataType === "Currency") {
      const number = Number(String(op).replace(/,/g, ""));
      return Number.isFinite(number) ? number : null;
    }
    if (dataType === "Date") {
      const date = new Date(op);
      return Number.isNaN(date.getTime()) ? null : date.getTime();
    }
    return String(op);
  };
  w.ValidatorCompare = function (operand1, operand2, operator, val) {
    const dataType = val.type || "String";
    const op1 = w.ValidatorConvert(operand1, dataType);
    if (op1 == null) return false;
    if (operator === "DataTypeCheck") return true;
    const op2 = w.ValidatorConvert(operand2, dataType);
    if (op2 == null) return true;
    switch (operator) {
      case "NotEqual":
        return op1 !== op2;
      case "GreaterThan":
        return op1 > op2;
      case "GreaterThanEqual":
        return op1 >= op2;
      case "LessThan":
        return op1 < op2;
      case "LessThanEqual":
        return op1 <= op2;
      default:
        return op1 === op2;
    }
  };
  w.CompareValidatorEvaluateIsValid = function (val) {
    const value = w.ValidatorGetValue(val.controltovalidate);
    if (w.ValidatorTrim(value).length === 0) return true;
    let compareTo = "";
    if (typeof val.controltocompare === "string" && document.getElementById(val.controltocompare)) compareTo = w.ValidatorGetValue(val.controltocompare);
    else if (typeof val.valuetocompare === "string") compareTo = val.valuetocompare;
    return w.ValidatorCompare(value, compareTo, val.operator, val);
  };
  w.RangeValidatorEvaluateIsValid = function (val) {
    const value = w.ValidatorGetValue(val.controltovalidate);
    if (w.ValidatorTrim(value).length === 0) return true;
    return w.ValidatorCompare(value, val.minimumvalue, "GreaterThanEqual", val) && w.ValidatorCompare(value, val.maximumvalue, "LessThanEqual", val);
  };
  w.ValidationSummaryOnSubmit = function (validationGroup) {
    if (typeof w.Page_ValidationSummaries === "undefined") return;
    for (let i = 0; i < w.Page_ValidationSummaries.length; i++) {
      const summary = w.Page_ValidationSummaries[i];
      if (!summary) continue;
      summary.style.display = "none";
      if (!w.Page_IsValid && w.IsValidationGroupMatch(summary, validationGroup)) {
        if (summary.showsummary !== "False") {
          summary.style.display = "";
          const mode = typeof summary.displaymode === "string" ? summary.displaymode : "BulletList";
          const [headerSep, first, pre, post, end] = mode === "List" ? ["<br>", "", "", "<br>", ""] : mode === "SingleParagraph" ? [" ", "", "", " ", "<br>"] : ["", "<ul>", "<li>", "</li>", "</ul>"];
          let html = typeof summary.headertext === "string" ? summary.headertext + headerSep : "";
          html += first;
          for (let j = 0; j < w.Page_Validators.length; j++)
            if (!w.Page_Validators[j].isvalid && typeof w.Page_Validators[j].errormessage === "string") html += pre + w.Page_Validators[j].errormessage + post;
          html += end;
          summary.innerHTML = html;
          w.scrollTo(0, 0);
        }
      }
    }
  };
  w.ValidatorOnSubmit = function () {
    return w.Page_ValidationActive ? w.ValidatorCommonOnSubmit() : true;
  };

  // ---- crmentityformview.js helpers ----------------------------------------------------
  w.setIsDirty = function (id) {
    const control = document.getElementById(id);
    if (control) control.classList.add("dirty");
    w.__ppFormDirty = true;
  };
  w.isDirty = function () {
    return Boolean(w.__ppFormDirty);
  };
  w.clearIsDirty = function () {
    w.__ppFormDirty = false;
    for (const node of document.querySelectorAll(".dirty")) node.classList.remove("dirty");
  };
  w.disableButtons = function () {
    for (const input of document.querySelectorAll('.crmEntityFormView input[type="submit"], .crmEntityFormView input[type="button"]')) {
      input.disabled = true;
      input.__ppDisabledBySubmit = true;
    }
  };
  w.scrollToAndFocus = function (labelId, controlId) {
    const label = document.getElementById(labelId);
    const control = document.getElementById(controlId);
    (label || control)?.scrollIntoView?.({ block: "center" });
    if (control && typeof control.focus === "function") control.focus();
  };
  w.setFocus = function (controlId) {
    document.getElementById(controlId)?.focus?.();
  };
  w.LengthError = function (control) {
    return !(control && control.maxLength > 0 && control.value.length > control.maxLength);
  };
  w.LimitInput = function (control) {
    const max = Number(control?.exMaxLen ?? control?.maxLength ?? 0);
    if (max > 0 && control.value.length > max) control.value = control.value.slice(0, max);
    return true;
  };
  w.LimitPaste = w.LimitInput;
  w.launchUrl = function (value) {
    if (value) w.open(/^https?:/i.test(value) ? value : `http://${value}`, "_blank");
  };
  w.launchEmail = function (value) {
    if (value) w.location.href = `mailto:${value}`;
  };
  w.validateUrlInput = function () {
    return true;
  };
  w.uppercaseTickerSymbol = function (control) {
    if (control) control.value = control.value.toUpperCase();
  };

  // ---- WebForms.js postback ----------------------------------------------------------------
  w.WebForm_PostBackOptions = function (eventTarget, eventArgument, validation, validationGroup, actionUrl, trackFocus, clientSubmit) {
    this.eventTarget = eventTarget;
    this.eventArgument = eventArgument;
    this.validation = validation;
    this.validationGroup = validationGroup;
    this.actionUrl = actionUrl;
    this.trackFocus = trackFocus;
    this.clientSubmit = clientSubmit;
  };
  w.WebForm_DoPostBackWithOptions = function (options) {
    let valid = true;
    if (options.validation && typeof w.Page_ClientValidate === "function") valid = w.Page_ClientValidate(options.validationGroup);
    if (valid && options.clientSubmit) w.__doPostBack(options.eventTarget, options.eventArgument);
    else if (!valid) restoreButtons();
  };
  w.WebForm_OnSubmit = function () {
    if (typeof w.ValidatorOnSubmit === "function" && w.ValidatorOnSubmit() === false) return false;
    return true;
  };
  w.WebForm_FireDefaultButton = function (event, target) {
    if (event.keyCode === 13 && !(event.target && /^(TEXTAREA|A|BUTTON)$/i.test(event.target.tagName))) {
      const button = document.getElementById(target);
      if (button && typeof button.click !== "undefined") {
        button.click();
        event.cancelBubble = true;
        if (event.stopPropagation) event.stopPropagation();
        return false;
      }
    }
    return true;
  };
  w.__doPostBack = function (eventTarget, eventArgument) {
    const button = [...document.querySelectorAll("input, button")].find((node) => node.name === eventTarget || node.id === String(eventTarget).split("$").pop());
    const form = button?.closest("[data-pp-native-form]") ?? findFormFromTarget(eventTarget);
    if (!form) {
      // A postback without a rendered native form (for example an authored
      // copy of the native button) re-renders the page natively.
      console.info("Local postback has no rendered native form; reloading the page.");
      location.reload();
      return;
    }
    const action = /PreviousButton$/.test(String(eventTarget)) ? "previous" : /DeleteButton$/.test(String(eventTarget)) ? "delete" : "submit";
    submitNativeForm(form, action, button, eventArgument);
  };
  function findFormFromTarget(eventTarget) {
    const control = /\$(EntityFormControl_[0-9a-f]{32}|WebFormControl_[0-9a-f]{32}|EntityFormControl|WebFormControl)\$/i.exec(String(eventTarget))?.[1];
    return control ? document.getElementById(control)?.closest("[data-pp-native-form]") ?? document.getElementById(control) : document.querySelector("[data-pp-native-form]");
  }
  function restoreButtons() {
    for (const input of document.querySelectorAll("input")) {
      if (!input.__ppDisabledBySubmit) continue;
      input.disabled = false;
      input.__ppDisabledBySubmit = false;
      if (input.__ppOriginalValue != null) input.value = input.__ppOriginalValue;
    }
  }
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.('input[type="button"], input[type="submit"]');
      if (button && button.closest("[data-pp-native-form]") && button.__ppOriginalValue == null) button.__ppOriginalValue = button.value;
    },
    true,
  );

  // ---- local submission ------------------------------------------------------------------------
  const configOf = (form) => {
    if (form.__ppConfig) return form.__ppConfig;
    const node = form.querySelector('script[type="application/json"][data-paqvilo-mirage-form-config]');
    form.__ppConfig = node ? JSON.parse(node.textContent) : null;
    return form.__ppConfig;
  };
  const readFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type || "application/octet-stream", size: file.size, content: String(reader.result).replace(/^data:[^,]*,/, "") });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  const radios = (field, element) => [...document.querySelectorAll(`input[name="${CSS.escape(field.name)}"]`), ...(element?.querySelectorAll?.("input[type=radio]") ?? [])];
  /**
   * Browsers post only enabled controls: a control that page script disabled
   * contributes no value, so the save leaves that column untouched.
   */
  function controlDisabled(field) {
    const element = document.getElementById(field.id);
    if (!element) return false;
    if (field.control === "boolean-radio" || field.control === "picklist-radio") {
      const inputs = radios(field, element);
      return inputs.length > 0 && inputs.every((input) => input.disabled);
    }
    return element.disabled === true;
  }
  function controlValue(field) {
    const element = document.getElementById(field.id);
    switch (field.control) {
      case "lookup": {
        const value = element?.value ?? "";
        const entity = document.getElementById(`${field.id}_entityname`)?.value || (Object.keys(field.bindings ?? {}).length === 1 ? Object.keys(field.bindings)[0] : "");
        return { lookup: true, value, entity };
      }
      case "checkbox":
        return element ? element.checked : null;
      case "boolean-radio": {
        const checked = radios(field, element).find((input) => input.checked);
        return checked ? checked.value === "1" || checked.value === "true" : null;
      }
      case "boolean-dropdown":
        return element?.value === "" || element == null ? null : element.value === "1" || element.value === "true";
      case "picklist-radio": {
        const checked = element?.querySelector("input:checked");
        return checked ? Number(checked.value) : null;
      }
      case "picklist":
        return element?.value === "" || element == null ? null : Number(element.value);
      case "multiselect":
        return element?.value ? element.value : null;
      case "number":
        return element?.value === "" || element == null ? null : Number(String(element.value).replace(/,/g, ""));
      case "datetime":
        return element?.value ? element.value : null;
      case "richtext":
        try {
          return JSON.parse(element?.value ?? '""');
        } catch {
          throw new Error(`Invalid rich text value for ${field.name}`);
        }
      default:
        // An empty text box saves as null (Dataverse stores no empty strings).
        return element?.value === "" || element == null ? null : element.value;
    }
  }
  // LiquidServerControl.OnItemSaved writes HtmlErrorValidationDiv into the
  // postback response: the message appears above the page content and the form
  // keeps its posted values.
  function showError(_form, message) {
    for (const previous of document.querySelectorAll("[data-pp-save-error]")) previous.remove();
    const div = document.createElement("div");
    div.className = "alert alert-block alert-danger";
    div.setAttribute("data-pp-save-error", "");
    div.innerHTML = `<p class='text-danger'><span class='fa fa-exclamation-triangle' aria-hidden='true'></span> ${escapeHtml(message)} </p>`;
    document.body.prepend(div);
    if (typeof w.scrollTo === "function") w.scrollTo(0, 0);
  }
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function showSuccess(form, message, hide) {
    let panel = form.querySelector("#MessagePanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "MessagePanel";
      const host = form.querySelector("#EntityFormPanel, #WebFormPanel");
      (host ?? form.firstElementChild)?.before?.(panel);
    }
    panel.className = "message alert alert-info success alert alert-success success alert alert-success";
    panel.setAttribute("role", "alert");
    panel.innerHTML = `<span id="MessageLabel">${message}</span>`;
    panel.style.display = "";
    if (hide) for (const node of form.querySelectorAll("#EntityFormPanel, #WebFormPanel")) node.style.display = "none";
  }
  async function submitNativeForm(form, action, button) {
    const config = configOf(form);
    if (!config) return;
    try {
      const values = {};
      if (action !== "previous" && action !== "delete")
        for (const field of config.fields ?? []) {
          if (field.readOnly || controlDisabled(field)) continue;
          const value = controlValue(field);
          if (value && typeof value === "object" && value.lookup) {
            const binding = value.entity ? field.bindings?.[value.entity] : null;
            if (!value.value) {
              if (config.operation === "update" || field.bindAlways) for (const entry of Object.values(field.bindings ?? {})) values[`${entry.navigation}@odata.bind`] = null;
              continue;
            }
            if (!binding) throw new Error(`The lookup navigation mapping is unresolved for ${field.name}.`);
            values[`${binding.navigation}@odata.bind`] = `/${binding.entitySet}(${encodeURIComponent(value.value)})`;
            continue;
          }
          if (value === null && config.operation !== "update") continue;
          values[field.name] = value;
        }
      const attachments = [];
      for (const input of form.querySelectorAll('input[type="file"][data-pp-attach-file]')) for (const file of input.files ?? []) attachments.push(await readFile(file));
      const tokenValue = await new Promise((resolve) => {
        const deferred = w.shell?.getTokenDeferred?.();
        if (deferred?.done) deferred.done(resolve);
        else if (deferred?.then) deferred.then(resolve);
        else resolve(document.querySelector('input[name="__RequestVerificationToken"]')?.value);
      });
      const response = await fetch(config.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", __RequestVerificationToken: tokenValue },
        body: JSON.stringify({
          recordId: form.querySelector("input[type=hidden][id$='_EntityID']")?.value || null,
          stepId: config.stepId ?? null,
          action,
          values,
          attachments,
          query: Object.fromEntries(new URLSearchParams(location.search)),
          pageUrl: location.pathname + location.search,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error?.message || result.Message || result.message || "Save failed");
      const outcome = result.outcome ?? {};
      const idInput = form.querySelector("input[type=hidden][id$='_EntityID']");
      if (idInput && result.recordId) idInput.value = result.recordId;
      form.dispatchEvent(new CustomEvent("sim:saved", { bubbles: true, detail: result }));
      if (outcome.type === "redirect" || outcome.type === "step") {
        location.assign(outcome.url);
        return;
      }
      const message = outcome.message || "Submission completed successfully.";
      // Native success is a postback: the page or modal frame re-renders at the
      // WebForms form's action (scripts may change it) with the message.
      const target = postbackTarget(form);
      sessionStorage.setItem(`paqvilo-mirage:form-success:${target.pathname}${target.search}`, JSON.stringify({ id: result.recordId || "", name: result.name ?? "", message, hideForm: outcome.hideForm !== false, form: form.id }));
      if (target.href === location.href) location.reload();
      else location.assign(target.href);
    } catch (error) {
      restoreButtons();
      showError(form, error.message);
    }
  }

  // The page's WebForms form (form#liquid_form, or form#content_form in modal documents).
  function serverForm(node) {
    const form = node?.closest?.("form");
    return form && /^(liquid_form|content_form)$/.test(form.id) ? form : null;
  }
  function postbackTarget(node) {
    const form = serverForm(node);
    try {
      return new URL(form?.getAttribute("action") || location.href, location.href);
    } catch {
      return new URL(location.href);
    }
  }
  // A browser submission of the WebForms form (implicit submission, an authored submit
  // button) is a postback on the platform. Native form buttons post through __doPostBack;
  // any other submission re-renders the page at the form action, as a postback that no
  // server control handles does.
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !/^(liquid_form|content_form)$/.test(form.id) || event.defaultPrevented) return;
      event.preventDefault();
      const submitter = event.submitter;
      if (submitter?.closest?.("[data-pp-native-form]") && (submitter.name || submitter.id)) {
        w.__doPostBack(submitter.name || submitter.id, "");
        return;
      }
      location.assign(postbackTarget(form).href);
    },
    false,
  );

  // Native success state after the local postback reload.
  document.addEventListener("DOMContentLoaded", () => {
    const key = `paqvilo-mirage:form-success:${location.pathname}${location.search}`;
    const saved = sessionStorage.getItem(key);
    if (!saved) return;
    sessionStorage.removeItem(key);
    try {
      const state = JSON.parse(saved);
      const form = (state.form && document.getElementById(state.form)) || document.querySelector("[data-pp-native-form]");
      if (!form) return;
      showSuccess(form, state.message, state.hideForm);
      const idInput = form.querySelector("input[type=hidden][id$='_EntityID']");
      if (idInput && state.id && !idInput.value) idInput.value = state.id;
      // Form.aspx and LiquidServerControl register this script after ItemSaved;
      // lookup create forms (?lookup=) post the created record instead.
      const lookup = /^\/_portal\/modal-form-template-path\//i.test(location.pathname) && new URLSearchParams(location.search).get("lookup");
      w.parent.postMessage(lookup ? JSON.stringify({ type: "Success", name: state.name ?? "", id: state.id || null }) : "Success", "*");
    } catch (error) {
      console.error("Invalid saved form completion state", error);
    }
  });

  w.__portalSimulation = w.__portalSimulation || {};
  w.__portalSimulation.webForms = { submit: submitNativeForm };
})();
