/*
 * Local equivalent of the platform's /xrm-adx/js/entitylist-map.js (map lists with credentials):
 * on ready the map host is sized to the page and the loading status box is placed inside it, as
 * the platform script does before it loads the map provider (live Bing map list: the provider
 * script is blocked by the page's content security policy, so the map itself never draws).
 * ponytail: layout only; no map provider, search or directions locally.
 */
(() => {
  "use strict";
  if (window.__ppEntityListMap) return;
  window.__ppEntityListMap = true;
  const ready = () => {
    const map = document.getElementById("entity-list-map");
    if (!map || document.getElementById("entity-list-map-status")) return;
    const width = map.parentElement?.getBoundingClientRect().width ?? 0;
    map.style.height = `${window.innerHeight / 2}px`;
    map.style.width = `${width}px`;
    const status = document.createElement("div");
    status.id = "entity-list-map-status";
    const box = map.getBoundingClientRect();
    status.setAttribute("style", `display:none; border: 1px solid #333; padding: 5px; background: #fff; position: absolute; left: ${box.left + window.scrollX}px; top: ${box.top + window.scrollY}px; z-index: 10000;`);
    // The platform names the image with an application-relative path (live: a redirected request).
    status.innerHTML = '<img src="~/xrm-adx/samples/images/loader.gif" alt="Loading">&nbsp;<span id="entity-list-map-status-text"></span>';
    map.append(status);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
