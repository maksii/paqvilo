/*
 * Local equivalent of the platform's /xrm-adx/js/radcaptcha.js (form pages): the
 * `radcaptcha.onClientLoad` hook of the Telerik captcha control and the captcha tooltip
 * attributes, applied on load and after partial postbacks when ASP.NET AJAX is present.
 * It also stands in for the Telerik RadCaptcha client control (lib/platform.mjs captchaControl):
 * on load the control adds its HTML5 audio player and raises its load event, whose handler
 * follows the refresh link; the refresh is an ASP.NET AJAX partial postback of the challenge
 * panel (server.mjs answers the update panel delta). Telerik marks the document with the
 * browser classes (t-chrome t-chrome<version>).
 */
(() => {
  "use strict";
  if (window.radcaptcha?.__ppSimCompat) return;
  const REFRESH = /^(.+\$captcha)\$CaptchaLinkButton$/;
  window.radcaptcha = {
    __ppSimCompat: true,
    onClientLoad(control) {
      const refresh = control?._element?.getElementsByTagName?.("a");
      if (!refresh || refresh.length === 0) return;
      // A javascript: postback link runs as the platform's navigation does, without a javascript: URL.
      const postback = /^javascript:__doPostBack\('([^']*)','([^']*)'\)$/.exec(refresh[0].getAttribute("href") ?? "");
      if (postback) window.__doPostBack(postback[1], postback[2]);
      else document.location = refresh[0].href;
    },
  };
  window.initCaptchaTooltips = function () {
    // Bootstrap 5 by its tooltip plugin, or locally by the page bundle (Mirage ships no bootstrap global).
    const bootstrap5 = typeof window.bootstrap?.Tooltip !== "undefined" || Boolean(document.querySelector("script[src*='bootstrap.BootstrapV5.bundle']"));
    const toggle = bootstrap5 ? "data-bs-toggle" : "data-toggle";
    const placement = bootstrap5 ? "data-bs-placement" : "data-placement";
    for (const selector of ["a.rcRefreshImage", "a.rcCaptchaAudioLink"]) {
      const link = document.querySelector(selector);
      if (!link) continue;
      link.setAttribute(toggle, "tooltip");
      link.setAttribute(placement, "bottom");
      link.setAttribute("role", "button");
    }
  };
  // The HTML5 audio player of a captcha plays the audio link's challenge; the link itself then
  // only starts the player (Telerik: href "#"), and the text box and client state autocomplete off.
  const initAudio = (element) => {
    const link = element.querySelector("a.rcCaptchaAudioLink");
    let audio = element.querySelector(":scope > audio");
    if (!audio) {
      audio = document.createElement("audio");
      audio.preload = "auto";
      audio.setAttribute("style", "position: absolute; top: 0px; left: 0px;");
      element.append(audio);
    }
    if (link && link.getAttribute("href") !== "#") {
      audio.setAttribute("src", link.getAttribute("href"));
      link.setAttribute("href", "#");
    }
    for (const input of element.querySelectorAll("input[id$='_CaptchaTextBox'], input[id$='_ClientState']")) input.setAttribute("autocomplete", "off");
  };
  // A hidden field of the delta moves into its own hidden span at the end of the form
  // (ASP.NET AJAX PageRequestManager._createHiddenField).
  const createHiddenField = (form, id, value) => {
    let container;
    const existing = document.getElementById(id);
    if (existing) {
      if (!existing._isContained) existing.remove();
      else container = existing.parentNode;
    }
    if (!container) {
      container = document.createElement("span");
      container.style.cssText = "display:none !important";
      form.append(container);
    }
    container.innerHTML = "<input type='hidden' />";
    const field = container.childNodes[0];
    field._isContained = true;
    field.id = field.name = id;
    field.value = value;
  };
  // The update panel delta: length|type|id|content| segments (ASP.NET AJAX PageRequestManager).
  const applyDelta = (form, text) => {
    for (let at = 0; at < text.length;) {
      const length = Number(text.slice(at, text.indexOf("|", at)));
      const typeAt = text.indexOf("|", at) + 1;
      const idAt = text.indexOf("|", typeAt) + 1;
      const contentAt = text.indexOf("|", idAt) + 1;
      if (!typeAt || !idAt || !contentAt || !Number.isFinite(length)) return;
      const type = text.slice(typeAt, idAt - 1), id = text.slice(idAt, contentAt - 1), content = text.substr(contentAt, length);
      at = contentAt + length + 1;
      if (type === "updatePanel") {
        const panel = document.getElementById(id);
        if (!panel) continue;
        panel.innerHTML = content;
        const captcha = panel.closest("div.RadCaptcha");
        if (captcha) initAudio(captcha);
      } else if (type === "hiddenField") createHiddenField(form, id, content);
      // The startup block (the "new image is ready" announcement) stays unrun: the page content
      // security policy blocks the script the platform injects without a nonce.
    }
  };
  const refreshCaptcha = (form, target, panel) => {
    const body = new URLSearchParams([["ctl00$ContentContainer$ctl01", `${panel}|${target}`]]);
    for (const [name, value] of new FormData(form)) if (typeof value === "string" && name !== "__EVENTTARGET" && name !== "__EVENTARGUMENT") body.append(name, value);
    body.set("__EVENTTARGET", target);
    body.set("__EVENTARGUMENT", "");
    body.append("__ASYNCPOST", "true");
    const request = new XMLHttpRequest();
    request.open("POST", form.getAttribute("action") || location.pathname + location.search);
    request.setRequestHeader("X-Requested-With", "XMLHttpRequest");
    request.setRequestHeader("X-MicrosoftAjax", "Delta=true");
    request.setRequestHeader("Cache-Control", "no-cache");
    request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=utf-8");
    request.onload = () => { if (request.status === 200) applyDelta(form, request.responseText); };
    request.send(body.toString());
  };
  // The control initialises with the document (Sys.Application init: the audio player) and raises
  // its load event with the page (Sys.Application load, after the challenge image).
  const boot = () => {
    const captchas = [...document.querySelectorAll("div.RadCaptcha")];
    if (!captchas.length) return;
    const browser = /Chrome\/(\d+)/.exec(navigator.userAgent);
    if (browser) document.documentElement.classList.add("t-chrome", `t-chrome${browser[1]}`);
    const postBack = window.__doPostBack;
    window.__doPostBack = function (eventTarget, _eventArgument) {
      const captcha = REFRESH.exec(String(eventTarget));
      const form = captcha && document.getElementById(`${captcha[1].replace(/\$/g, "_")}_ctl01`)?.closest("form");
      if (form) return void refreshCaptcha(form, eventTarget, `${captcha[1]}$ctl01`);
      return postBack?.apply(this, arguments);
    };
    for (const element of captchas) initAudio(element);
    const load = () => {
      for (const element of captchas) window.radcaptcha.onClientLoad({ _element: element });
      if (!window.Sys?.Application?.add_load) setTimeout(window.initCaptchaTooltips, 1000);
    };
    if (document.readyState === "complete") load();
    else window.addEventListener("load", load, { once: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
  const Sys = window.Sys;
  if (Sys?.Application?.add_load) Sys.Application.add_load(() => setTimeout(window.initCaptchaTooltips, 1000));
  if (Sys?.WebForms?.PageRequestManager?.getInstance)
    Sys.WebForms.PageRequestManager.getInstance().add_beginRequest(() => {
      const $ = window.jQuery;
      for (const selector of [".rcRefreshImage", ".rcCaptchaAudioLink"])
        try {
          $?.(selector).first().tooltip("hide");
        } catch {
          /* tooltips are optional */
        }
    });
})();
