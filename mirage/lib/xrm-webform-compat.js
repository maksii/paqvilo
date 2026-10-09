/*
 * Local equivalent of the platform's /xrm-adx/js/webform.js (basic and multistep form
 * pages, loaded inside the WebForms form before radcaptcha.js and crmentityformview.js):
 * the multistep progress bar label, keyboard activation of Previous buttons, dirty
 * tracking with the confirm-on-exit prompt and the legacy String/document helpers that
 * the platform script installs. Functions the local WebForms runtime already defines are
 * kept. Idempotent.
 */
(() => {
  "use strict";
  if (window.__ppXrmWebForm) return;
  window.__ppXrmWebForm = true;
  const w = window;
  const define = (name, fn) => {
    if (typeof w[name] !== "function") w[name] = fn;
  };
  define("disableButtons", () => {
    for (const input of document.getElementsByTagName("input")) if (input.type === "submit" || input.type === "button") input.disabled = true;
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
    return document.getElementById("confirmOnExitMessage")?.value || "You have attempted to leave or refresh this page. Your changes have not been saved. To stay on the page to save your changes, click Stay.";
  });
  w.onbeforeunload = w.confirmExit;
  // The platform script replaces these built-ins on form pages (array result, word-boundary match).
  String.prototype.trim = function () {
    return this.replace(/^\s+|\s+$/g, "");
  };
  document.getElementsByClassName = function (name) {
    const pattern = new RegExp(`(\\b(?!-))${name}(\\b(?!-))`);
    return [...this.getElementsByTagName("*")].filter((element) => pattern.test(element.className));
  };
  const ready = () => {
    const $ = w.jQuery;
    if (typeof $?.fn?.stackRanking === "function")
      $(".stack-rank-cell").parents("table.section").each(function () {
        if (!$(this).hasClass("stack-rank")) $(this).stackRanking();
      });
    for (const button of document.querySelectorAll(".previous-btn"))
      button.addEventListener("keydown", (event) => {
        const key = event.keyCode || event.which;
        if (key !== 13 && key !== 32) return;
        event.stopPropagation();
        event.preventDefault();
        button.click();
      });
    const progress = document.getElementById("WebFormControl_ProgressIndicator");
    if (progress && progress.getClientRects().length) {
      const heading = [...document.querySelectorAll(".page-header")].filter((header) => header.getClientRects().length).map((header) => [...header.querySelectorAll("h1")].map((h1) => h1.textContent).join("")).join("");
      for (const bar of progress.querySelectorAll("[role='progressbar']")) bar.setAttribute("aria-labelledby", heading.trim());
    }
  };
  if (typeof w.jQuery?.fn?.jquery === "string") w.jQuery(ready);
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
