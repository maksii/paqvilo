/*
 * Local equivalent of the platform's /xrm-adx/js/crmentityformview-datetime.js (form pages
 * with date or date-time controls): binds every rendered date control to the date picker.
 * The binding is the client runtime's date control initialiser (lib/date-controls.mjs),
 * which uses the captured Bootstrap datetimepicker and moment when present and the
 * browser's native date inputs otherwise; it is idempotent per control.
 */
(() => {
  "use strict";
  const bind = () => window.__portalSimulation?.initializeDateControls?.();
  if (typeof window.jQuery?.fn?.jquery === "string") window.jQuery(bind);
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
