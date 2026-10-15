import { randomUUID } from 'node:crypto';

/** Local frame load ordering: a real pending image, never a synthetic load event. */
export function createFrameReadiness({ diagnostic = () => {}, timeoutMs = 5000, limit = 1000 } = {}) {
  const pending = new Map();
  const prefix = '/__sim/frame-ready/';
  const finish = (id, reason) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.response?.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    diagnostic({ code: reason === 'timeout' ? 'FRAME_READY_TIMEOUT' : 'FRAME_LOAD_ORDERING', severity: reason === 'timeout' ? 'warning' : 'info', path: entry.path,
      ordering: reason, message: reason === 'timeout' ? 'Local frame load blocker expired; ready ordering is unverified.' : `Local frame load released after ${reason}.` });
  };
  return {
    decorate(html, { path = '/', observed } = {}) {
      if (observed?.modalLoadOrdering === 'immediate') return html;
      // Native documents have a final body tag. Authored scripts can contain an
      // earlier literal "</body>"; preserve their bytes when adding the blocker.
      const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
      if (bodyEnd < 0) return html;
      if (pending.size >= limit) finish(pending.keys().next().value, 'timeout');
      const id = randomUUID(), route = prefix + id;
      const entry = { path, timer: setTimeout(() => finish(id, 'timeout'), timeoutMs) };
      entry.timer.unref?.();
      pending.set(id, entry);
      // The image is parsed before DOMContentLoaded. jQuery 3 ready handlers are
      // asynchronous; queue behind them and allow one further macrotask. A
      // throwing ready handler does not prevent the global ready promise settling.
      const markup = `<img hidden alt="" aria-hidden="true" data-paqvilo-frame-ready src="${route}"><script data-paqvilo-frame-ready>(function(){document.addEventListener('DOMContentLoaded',function(){var jq=window.jQuery;function release(reason){window.__portalSimulation=window.__portalSimulation||{};window.__portalSimulation.frameLoadOrdering=reason;fetch('${route}?reason='+reason,{method:'POST',credentials:'same-origin'}).then(function(response){return response.arrayBuffer();}).catch(function(){});}if(jq&&jq.ready&&typeof jq.ready.then==='function'){jq.ready.then(function(){setTimeout(function(){release('jquery-ready');},0);});}else release('dom-ready');},{once:true});})();</script>`;
      return html.slice(0, bodyEnd) + markup + html.slice(bodyEnd);
    },
    handle(req, res, url) {
      if (!url.pathname.startsWith(prefix)) return false;
      const id = url.pathname.slice(prefix.length), entry = pending.get(id);
      if (!entry) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return true; }
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== url.origin) { res.writeHead(403); res.end(); return true; }
        const reason = url.searchParams.get('reason') === 'jquery-ready' ? 'jquery-ready' : 'dom-ready';
        finish(id, reason);
        res.writeHead(204, { 'cache-control': 'no-store' }); res.end();
      } else if (req.method === 'GET' && !entry.response) {
        res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
        entry.response = res;
        res.on('close', () => { if (pending.has(id)) finish(id, 'aborted'); });
      } else { res.writeHead(405); res.end(); }
      return true;
    },
    close() { for (const id of pending.keys()) finish(id, 'aborted'); },
  };
}
