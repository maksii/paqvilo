/*
 * Local equivalent of the document-ready behaviour of the Power Pages app bundle
 * (/resource/powerappsportal/dist/app.bundle-<hash>.js) that page scripts and the DOM rely on.
 * The bundle's entity grid, subgrid, lookup and notes runtime is lib/entity-grid-compat.js.
 * Observed on reference-portal (agent C live-run9, agent G baseline) and read from the cached bundle:
 * - the heading announcer appended to every .page-header that contains an h1;
 * - dropdown, label, radio, checkbox and option accessibility attributes;
 * - .crmEntityFormView role/aria-label, picklist option attributes, readonly control focus;
 * - portal.* helpers and the moment locale taken from <html lang>.
 * Loaded after the footer like the bundle; idempotent.
 */
(() => {
  "use strict";
  if (window.__ppPlatformApp) return;
  window.__ppPlatformApp = true;
  const jq = () => (typeof window.jQuery?.fn?.jquery === "string" ? window.jQuery : null);
  // jQuery ready callbacks run after DOMContentLoaded listeners and after the ready
  // handlers that page scripts registered earlier, as the bundle's do.
  const ready = (fn) => {
    const $ = jq();
    if ($) $(fn);
    else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else setTimeout(fn);
  };
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = (element) => (element ? element.textContent : "");
  const resource = (key, fallback) => {
    const value = window.ResourceManager?.[key];
    return typeof value === "string" ? value : fallback;
  };
  const setAttributeFromTitle = (element) => {
    const title = element.getAttribute("title");
    if (title != null) element.setAttribute("aria-label", title);
  };
  const nextElement = (element) => element.nextElementSibling;

  const portal = (window.portal = window.portal || {});
  portal.IsRequestedFromMaker ||= function () {
    return Boolean(document.querySelector("div[data-gjs-type]"));
  };
  portal.setValidationSummaryFocus ||= function () {
    for (const summary of all(".validation-summary")) {
      if (!summary.getClientRects().length) continue;
      summary.removeAttribute("role");
      for (const header of all(".validation-header")) header.setAttribute("role", "none");
      summary.setAttribute("tabindex", "0");
      summary.focus();
      for (const list of summary.querySelectorAll("ul")) list.setAttribute("role", "presentation");
    }
  };
  portal.SetValidationSummary ||= function (id) {
    const summary = id ? document.getElementById(id) : null;
    if (!summary) return;
    for (const item of summary.querySelectorAll("li")) item.setAttribute("aria-label", item.textContent);
  };
  portal.UpdateValidationSummary ||= portal.SetValidationSummary;
  portal.addRoleOnCheckboxLabel ||= function (elements) {
    for (const element of jq() ? jq()(elements).toArray() : [].concat(elements ?? [])) element?.setAttribute?.("role", "none");
  };
  // Liquid date output (<abbr class="timeago|posttime">) is reformatted with the site formats.
  portal.convertAbbrDateTimesToTimeAgo ||= function () {
    if (typeof window.moment !== "function") return;
    const TOKENS = { yyyy: "YYYY", yy: "YY", MMMM: "MMMM", MMM: "MMM", MM: "MM", M: "M", dddd: "dddd", ddd: "ddd", dd: "DD", d: "D", HH: "HH", H: "H", hh: "hh", h: "h", mm: "mm", m: "m", ss: "ss", s: "s", fff: "SSS", tt: "A", t: "A" };
    const dotNetToMoment = (format) =>
      String(format ?? "").replace(/'([^']*)'|"([^"]*)"|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|tt|t/g, (token, single, double) =>
        single != null || double != null ? `[${single ?? double}]` : TOKENS[token]);
    for (const selector of ["abbr.timeago", "abbr.posttime"])
      for (const element of all(selector)) {
        const parsed = Date.parse(element.textContent);
        if (!parsed) continue;
        const value = window.moment(parsed);
        const dateFormat = dotNetToMoment(element.closest("[data-dateformat]")?.getAttribute("data-dateformat") || "MMMM d, yyyy");
        const timeFormat = dotNetToMoment(element.closest("[data-timeformat]")?.getAttribute("data-timeformat") || "h:mm tt");
        const format = element.getAttribute("data-format") ? dotNetToMoment(element.getAttribute("data-format")) : `${dateFormat} ${timeFormat}`;
        element.setAttribute("title", selector === "abbr.timeago" ? value.format("YYYY-MM-DDTHH:mm:ss") : value.format(format));
        element.textContent = value.format(format);
      }
  };

  ready(() => {
    if (typeof window.moment?.locale === "function") window.moment.locale(document.documentElement.getAttribute("lang") || "en");
    portal.convertAbbrDateTimesToTimeAgo();

    // Dropdowns and menus.
    for (const scope of [".page_section .btn-select .dropdown-menu li a", ".navbar .btn-select .dropdown-menu li a"]) all(scope)[0]?.setAttribute("aria-selected", "true");
    for (const link of all(".dropdown-menu li a")) {
      link.addEventListener("focus", () => link.parentElement?.classList.add("active"));
      link.addEventListener("focusout", () => link.parentElement?.classList.remove("active"));
    }
    for (const lookup of all("tr td.clearfix.cell.lookup.form-control-cell .control .input-group")) lookup.setAttribute("role", "none");
    for (const link of all("#profile-dropdown a")) link.setAttribute("role", "button");
    for (const link of all('li.weblink>a[title="Home"]')) link.setAttribute("aria-label", resource("Home_DefaultText", "Home"));
    for (const link of all("li.dropdown>a.navbar-icon")) link.setAttribute("title", resource("Search_DefaultText", "Search"));
    for (const label of all("label.required")) {
      const next = nextElement(label);
      if (!next) continue;
      for (const control of next.querySelectorAll("input,select,textarea")) {
        setAttributeFromTitle(control);
        control.setAttribute("aria-required", "true");
      }
    }
    for (const toggle of all("li.dropdown>a.dropdown-toggle")) {
      setAttributeFromTitle(toggle);
      toggle.setAttribute("aria-expanded", "false");
      toggle.removeAttribute("aria-haspopup");
    }
    for (const toggle of all('li.dropdown>a.dropdown-toggle[role="menuitem"]')) toggle.setAttribute("aria-haspopup", "true");
    for (const link of all("li.weblink.dropdown>a")) setAttributeFromTitle(link);
    for (const link of all("div.list-group>a")) setAttributeFromTitle(link);
    for (const required of all("div.required")) for (const box of nextElement(required)?.querySelectorAll('input[type="checkbox"]') ?? []) box.setAttribute("aria-required", "true");
    for (const radio of all('input[type="radio"]')) {
      radio.closest("tr")?.setAttribute("role", "group");
      radio.closest("td")?.setAttribute("role", "radiogroup");
    }
    document.getElementById("_yuiResizeMonitor")?.removeAttribute("tabindex");
    for (const link of all(".nav.weblinks a")) if (link.getAttribute("href") === location.pathname) link.setAttribute("aria-current", "page");
    for (const option of all("select>option")) if (option.text === "" && option.hasAttribute("label")) option.text = option.getAttribute("label");

    // Forms.
    const heading = all(".page-header h1").map(text).join("");
    for (const form of all(".crmEntityFormView")) {
      form.setAttribute("role", "form");
      form.setAttribute("aria-label", heading || resource("Entity_Form_Label", "Basic Form"));
    }
    for (const input of all("input[type='file']"))
      input.addEventListener("keydown", (event) => {
        if ((event.keyCode || event.which) !== 13) return;
        event.stopPropagation();
        event.preventDefault();
        input.click();
      });
    const picklists = all(".control select.form-control.picklist");
    if (picklists[0]?.hasAttribute("required")) for (const picklist of picklists) picklist.removeAttribute("required");
    for (const picklist of picklists) {
      const options = [...picklist.options];
      options.forEach((option, index) => {
        const label = option.text.replace(/\s+/g, " ").trim();
        option.setAttribute("data-original-text", label);
        option.text = label;
        option.setAttribute("aria-posinset", String(index + 1));
        option.setAttribute("aria-setsize", String(options.length));
      });
    }
    for (const form of all(".entity-form[readonly]"))
      for (const control of form.querySelectorAll(".lookup[readonly], .picklist[readonly], .MultiSelectPicklist[readonly]")) control.closest(".control")?.setAttribute("tabindex", "0");
    if (document.querySelector("div .info.required")) for (const input of all("input.form-control.input-text-box")) input.setAttribute("aria-required", "true");

    // Heading announcer.
    if (heading || document.querySelector(".page-header h1")) {
      for (const header of all(".page-header")) {
        const announcer = document.createElement("div");
        announcer.setAttribute("role", "alert");
        announcer.setAttribute("aria-roledescription", "heading");
        announcer.setAttribute("aria-label", heading);
        announcer.setAttribute("class", "sr-only");
        header.appendChild(announcer);
      }
    }
  });

  // Ads and polls (the bundle's adx.Ad, adx.AdPlacement, adx.Poll and adx.PollPlacement):
  // each .ad/.adplacement/.poll/.pollplacement element loads its data-url (GET) and shows
  // the returned markup; a poll submits the checked option to data-submit-url through
  // shell.ajaxSafePost and shows the returned results.
  const adx = (window.adx = window.adx || {});
  const load = (url) => {
    const $ = jq();
    if ($) return new Promise((resolve, reject) => $.ajax({ url, type: "GET" }).then(resolve, reject));
    return fetch(url, { credentials: "same-origin" }).then((response) => (response.ok ? response.text() : Promise.reject(response)));
  };
  const show = (element, html) => {
    element.innerHTML = String(html ?? "").trim();
    element.style.display = "";
  };
  const placement = (element, after) => {
    const url = element.getAttribute("data-url");
    element.style.display = "none";
    const source = url ? load(url) : Promise.resolve(element.innerHTML);
    return source.then(
      (html) => {
        show(element, html);
        after?.();
      },
      (error) => console.error({ error, ad: element }),
    );
  };
  adx.Ad ||= function Ad(element) {
    this.init = () => placement(element);
  };
  adx.AdPlacement ||= function AdPlacement(element) {
    this.init = () => placement(element);
  };
  adx.Poll ||= function Poll(element) {
    const content = element.querySelector(".poll-content") ?? element;
    const toggle = (question) => {
      for (const panel of element.querySelectorAll(".poll-questionpanel")) panel.style.display = question ? "" : "none";
      for (const panel of element.querySelectorAll(".poll-resultspanel")) panel.style.display = question ? "none" : "";
    };
    const render = (html) => {
      show(content, html);
      const question = element.querySelector(".poll-questionpanel");
      this.id = question?.getAttribute("data-id") ?? null;
      this.name = question?.getAttribute("data-name") ?? null;
      this.submitted = !question;
      toggle(!this.submitted);
    };
    this.viewPoll = () => toggle(true);
    this.viewResults = () => {
      toggle(false);
      if (this.submitted) for (const back of element.querySelectorAll(".poll-return")) back.remove();
    };
    this.init = () => {
      const url = element.getAttribute("data-url");
      return (url ? load(url) : Promise.resolve(content.innerHTML)).then(
        (html) => {
          render(html);
          element.addEventListener("click", (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(".poll-viewresults")) this.viewResults();
            else if (target?.closest(".poll-return")) this.viewPoll();
            else if (target?.closest(".poll-submit")) {
              const option = element.querySelector("input[id^='poll_option_']:checked")?.value;
              const submitUrl = element.getAttribute("data-submit-url");
              if (!option || !submitUrl || typeof window.shell?.ajaxSafePost !== "function") return;
              window.shell
                .ajaxSafePost({ url: submitUrl, async: false, type: "POST", data: JSON.stringify({ pollId: this.id, optionId: option }), contentType: "application/json; charset=utf-8" })
                .then((html) => render(html), (...details) => console.log({ m: "Post Failed", d: details }));
            }
          });
        },
        (error) => console.error({ error, poll: element }),
      );
    };
  };
  adx.PollPlacement ||= function PollPlacement(element) {
    this.init = () => placement(element, () => all(".poll", element).forEach((poll) => new adx.Poll(poll).init()));
  };
  ready(() => {
    for (const element of all(".poll")) if (!element.closest(".pollplacement")) new adx.Poll(element).init();
    for (const element of all(".pollplacement")) new adx.PollPlacement(element).init();
    for (const element of all(".ad")) new adx.Ad(element).init();
    for (const element of all(".adplacement")) new adx.AdPlacement(element).init();
  });
})();
