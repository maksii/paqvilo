/* Reversible local repair for controls actually occluded by an overlay footer. */
(() => {
  const compat = (window.__ppSimCompat ||= {});
  if (compat.footerSpacing) return;
  compat.footerSpacing = true;
  let repaired = null, original = null, observer, scheduled = false;
  const properties = ['position', 'top', 'bottom', 'margin-top'];
  const restore = () => {
    if (!repaired) return;
    for (const [name, value, priority] of original) {
      if (value) repaired.style.setProperty(name, value, priority);
      else repaired.style.removeProperty(name);
    }
  };
  function visibleRect(element) {
    let rect = element.getBoundingClientRect();
    let { left, right, top, bottom } = rect;
    left = Math.max(0, left); right = Math.min(innerWidth, right);
    top = Math.max(0, top); bottom = Math.min(innerHeight, bottom);
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0 ||
          ['fixed', 'sticky'].includes(style.position) || node.matches('.modal,[role="dialog"]')) return null;
      if (node === element) continue;
      rect = node.getBoundingClientRect();
      if (/(auto|hidden|scroll|clip)/.test(style.overflowX)) {
        left = Math.max(left, rect.left + node.clientLeft);
        right = Math.min(right, rect.left + node.clientLeft + node.clientWidth);
      }
      if (/(auto|hidden|scroll|clip)/.test(style.overflowY)) {
        top = Math.max(top, rect.top + node.clientTop);
        bottom = Math.min(bottom, rect.top + node.clientTop + node.clientHeight);
      }
    }
    return right > left && bottom > top ? { left, right, top, bottom } : null;
  }
  function applySpacing() {
    scheduled = false;
    restore();
    const footer = document.querySelector("[data-sim-footer-spacing],footer[role='contentinfo'],footer");
    let covered = null;
    if (footer && ['absolute', 'fixed'].includes(getComputedStyle(footer).position)) {
      const f = footer.getBoundingClientRect();
      covered = [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a[href]')].find(element => {
        if (footer.contains(element)) return false;
        const rect = visibleRect(element);
        if (!rect) return false;
        const left = Math.max(rect.left, f.left), right = Math.min(rect.right, f.right);
        const top = Math.max(rect.top, f.top), bottom = Math.min(rect.bottom, f.bottom);
        if (right - left < 1 || bottom - top < 1) return false;
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return hit === footer || footer.contains(hit);
      });
    }
    const state = ((globalThis.__portalSimulation ||= {}).compatibility ||= {});
    if (covered) {
      if (repaired !== footer) original = properties.map(name => [name, footer.style.getPropertyValue(name), footer.style.getPropertyPriority(name)]);
      const wasActive = repaired === footer;
      repaired = footer;
      footer.style.position = 'static'; footer.style.top = 'auto'; footer.style.bottom = 'auto'; footer.style.marginTop = '24px';
      state.footerSpacingMode = 'local-overlap-repair';
      state.footerSpacingControl = covered.id || covered.tagName.toLowerCase();
      if (!wasActive) console.info('Local footer overlap repair:', covered);
    } else {
      repaired = original = null;
      state.footerSpacingMode = 'source'; delete state.footerSpacingControl;
    }
    observer?.takeRecords();
  }
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(applySpacing); } };
  const start = () => {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    applySpacing();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
})();
