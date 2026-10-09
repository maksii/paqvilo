/*
 * Local equivalent of the platform's /xrm-adx/js/radcaptcha.js (form pages): the
 * `radcaptcha.onClientLoad` hook of the Telerik captcha control and the captcha tooltip
 * attributes, applied on load and after partial postbacks when ASP.NET AJAX is present.
 * The local runtime renders no captcha control, so the hooks find no captcha elements.
 */
(() => {
  "use strict";
  if (window.radcaptcha?.__ppSimCompat) return;
  window.radcaptcha = {
    __ppSimCompat: true,
    onClientLoad(control) {
      const refresh = control?._element?.getElementsByTagName?.("a");
      if (refresh && refresh.length > 0) document.location = refresh[0].href;
    },
  };
  window.initCaptchaTooltips = function () {
    const bootstrap5 = typeof window.bootstrap?.Tooltip !== "undefined";
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
