/* Keep an absolutely positioned exported footer from covering its last form
 * controls in the local browser viewport. */
(() => {
  const compat = (window.__ppSimCompat ||= {});
  if (compat.footerSpacing) return;
  compat.footerSpacing = true;
  const applySpacing = () => {
    const footer = document.querySelector("[data-sim-footer-spacing],footer[role='contentinfo'],footer");
    if (!footer) return;
    const style = getComputedStyle(footer);
    if (style.position !== "absolute" && style.position !== "fixed") return;
    const footerPosition = style.position;
    const actions = [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a[href]')]
      .filter((element) => !footer.contains(element) && element.getClientRects().length > 0);
    if (!actions.length) return;
    const footerRect = footer.getBoundingClientRect();
    const covered = actions.some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > footerRect.top + 1 && rect.top < footerRect.bottom && rect.left < footerRect.right && rect.right > footerRect.left;
    });
    if (!covered) return;
    if (["absolute", "fixed"].includes(footerPosition)) {
      // Overlay portal footers sit outside normal document flow. Return the
      // footer to the flow where it stands (the DOM order stays native, e.g.
      // footer before a cookie banner) so controls remain reachable.
      footer.style.position = "static";
      footer.style.top = "auto";
      footer.style.bottom = "auto";
      footer.style.marginTop = "24px";
    }
    ((globalThis.__portalSimulation ||= {}).compatibility ||= {}).footerSpacingMode = "local-overlap-repair";
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applySpacing, { once: true });
  else applySpacing();
  window.addEventListener("resize", applySpacing);
  if (document.body) {
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; applySpacing(); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  console.info("Local footer spacing checks for overlapping form controls.");
})();
