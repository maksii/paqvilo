/* Reversible local repair for controls actually occluded by an overlay footer. */
(() => {
  const compat = (window.__ppSimCompat ||= {});
  if (compat.footerSpacing) return;
  compat.footerSpacing = true;
  let repaired = null,
    original = null,
    observer,
    scheduled = false,
    forceCheck = false,
    visual = null,
    coveredPoint = null,
    sourcePosition = null,
    lastScroll = null;
  const properties = ['position', 'top', 'bottom', 'margin-top'];
  const restore = () => {
    if (!repaired) return;
    for (const [name, value, priority] of original) {
      if (value) repaired.style.setProperty(name, value, priority);
      else repaired.style.removeProperty(name);
    }
  };
  function visibleRect(element, clipViewport = true) {
    let rect = element.getBoundingClientRect();
    let { left, right, top, bottom } = rect;
    if (clipViewport) {
      left = Math.max(0, left);
      right = Math.min(innerWidth, right);
      top = Math.max(0, top);
      bottom = Math.min(innerHeight, bottom);
    }
    if (right <= left || bottom <= top) return null;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        Number(style.opacity) === 0 ||
        ['fixed', 'sticky'].includes(style.position) ||
        node.matches('.modal,[role="dialog"]')
      )
        return null;
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
  // Restoring the footer for hit testing can interrupt hover even when the final
  // geometry is identical. Observe the current scene before changing any styles.
  function visualState() {
    const values = [repaired, innerWidth, innerHeight];
    const body = document.body.getBoundingClientRect(),
      footer = repaired.getBoundingClientRect();
    values.push(
      body.left + scrollX,
      body.top + scrollY,
      body.width,
      body.height,
      footer.left + scrollX,
      footer.top + scrollY,
      footer.width,
      footer.height,
    );
    for (const element of document.querySelectorAll('button,input[type="button"],input[type="submit"],a[href]')) {
      if (repaired.contains(element)) continue;
      const rect = visibleRect(element, false);
      if (rect) {
        values.push(element, rect.left + scrollX, rect.right + scrollX, rect.top + scrollY, rect.bottom + scrollY);
        for (let node = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          values.push(
            node,
            style.position,
            style.zIndex,
            style.opacity,
            style.transform,
            style.filter,
            style.isolation,
            style.pointerEvents,
          );
        }
      }
    }
    if (coveredPoint) values.push(document.elementFromPoint(coveredPoint[0] - scrollX, coveredPoint[1] - scrollY));
    return values;
  }
  function applySpacing() {
    scheduled = false;
    const forced = forceCheck;
    forceCheck = false;
    const movedFixed =
      sourcePosition === 'fixed' && lastScroll && (lastScroll[0] !== scrollX || lastScroll[1] !== scrollY);
    if (repaired?.isConnected && !forced && !movedFixed && visual) {
      const current = visualState();
      if (current.length === visual.length && current.every((value, index) => value === visual[index])) return;
    }
    // Source-position measurements must not change the browser's scroll anchor.
    // Otherwise restoring/reapplying an identical repair can move the pointer
    // away from its hovered control and close that control's tooltip.
    const root = document.documentElement,
      anchorStyle = root.getAttribute('style');
    root.style.setProperty('overflow-anchor', 'none', 'important');
    try {
      restore();
      const footer = document.querySelector("[data-sim-footer-spacing],footer[role='contentinfo'],footer");
      sourcePosition = footer && getComputedStyle(footer).position;
      let covered = null;
      if (footer && ['absolute', 'fixed'].includes(getComputedStyle(footer).position)) {
        const f = footer.getBoundingClientRect();
        covered = [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a[href]')].find(
          (element) => {
            if (footer.contains(element)) return false;
            const rect = visibleRect(element);
            if (!rect) return false;
            const left = Math.max(rect.left, f.left),
              right = Math.min(rect.right, f.right);
            const top = Math.max(rect.top, f.top),
              bottom = Math.min(rect.bottom, f.bottom);
            if (right - left < 1 || bottom - top < 1) return false;
            const point = [(left + right) / 2, (top + bottom) / 2];
            const hit = document.elementFromPoint(...point);
            if (hit === footer || footer.contains(hit)) {
              coveredPoint = [point[0] + scrollX, point[1] + scrollY];
              return true;
            }
            return false;
          },
        );
      }
      const state = ((globalThis.__portalSimulation ||= {}).compatibility ||= {});
      if (covered) {
        if (repaired !== footer)
          original = properties.map((name) => [
            name,
            footer.style.getPropertyValue(name),
            footer.style.getPropertyPriority(name),
          ]);
        const wasActive = repaired === footer;
        repaired = footer;
        footer.style.position = 'static';
        footer.style.top = 'auto';
        footer.style.bottom = 'auto';
        footer.style.marginTop = '24px';
        state.footerSpacingMode = 'local-overlap-repair';
        state.footerSpacingControl = covered.id || covered.tagName.toLowerCase();
        if (!wasActive) console.info('Local footer overlap repair:', covered);
        visual = visualState();
        lastScroll = [scrollX, scrollY];
      } else {
        repaired = original = null;
        visual = coveredPoint = null;
        lastScroll = null;
        state.footerSpacingMode = 'source';
        delete state.footerSpacingControl;
      }
    } finally {
      if (anchorStyle == null) root.removeAttribute('style');
      else root.setAttribute('style', anchorStyle);
      observer?.takeRecords();
    }
  }
  const schedule = (force = false) => {
    forceCheck ||= force;
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(applySpacing);
    }
  };
  const start = () => {
    observer = new MutationObserver((records) =>
      schedule(
        records.some(
          (record) =>
            (record.type === 'attributes' && (record.target === repaired || record.target.contains?.(repaired))) ||
            record.target.closest?.('head,style') ||
            record.target.parentElement?.closest('head,style') ||
            [...record.addedNodes, ...record.removedNodes].some((node) => node.matches?.('style,link')),
        ),
      ),
    );
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    applySpacing();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.addEventListener('resize', () => schedule(true));
  window.addEventListener('scroll', () => schedule(), true);
})();
