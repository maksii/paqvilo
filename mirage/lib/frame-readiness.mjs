import { randomUUID } from 'node:crypto';
import { documentAnchors, scriptMarker } from './document-injection.mjs';

// A decorated document whose page never asks for the image is forgotten after this many limits.
const NEVER_REQUESTED_FACTOR = 12;

/** Local frame load ordering: a real pending image, never a synthetic load event. */
export function createFrameReadiness({ diagnostic = () => {}, timeoutMs = 5000, limit = 1000 } = {}) {
  const pending = new Map();
  const prefix = '/__sim/frame-ready/';
  const finish = (id, reason) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    // A document closed or evicted before its page asked for the image held nothing: there is no ordering to report.
    if (!entry.response && reason === 'aborted') return;
    entry.response?.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
    const expired = reason === 'timeout' || reason === 'never-requested';
    diagnostic({
      code: expired ? 'FRAME_READY_TIMEOUT' : 'FRAME_LOAD_ORDERING',
      severity: expired ? 'warning' : 'info',
      path: entry.path,
      ordering: reason,
      message:
        {
          timeout: 'Local frame load blocker expired; ready ordering is unverified.',
          'never-requested':
            'The page never requested the local frame load blocker (its inline script did not run); the frame load was not held and ready ordering is unverified.',
        }[reason] ?? `Local frame load released after ${reason}.`,
    });
  };
  const arm = (id, entry, ms, reason) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => finish(id, reason), ms);
    entry.timer.unref?.();
  };
  // The limit bounds the page's own ready work only: it starts when the page asks for the image, so the time a busy
  // host took to deliver the document and its scripts never expires the blocker. A page whose marker script never runs
  // (a site policy without 'unsafe-inline') never asks: its entry ends after a longer lifetime from decoration and
  // reports that the load was not held. `limit` bounds how many entries are kept until then.
  return {
    // `injectedScripts` is the response's injected-script marker under a nonce policy (lib/document-injection.mjs).
    decorate(html, { path = '/', observed, head = false, sent = null, injectedScripts = null } = {}) {
      // `sent` is shown the document as it leaves here (the caller's record of what it answers); it changes nothing.
      const answered = (document) => {
        sent?.(document);
        return document;
      };
      // A HEAD answer is no document a browser loads: it gets no blocker.
      if (head || observed?.modalLoadOrdering === 'immediate') return answered(html);
      // Native documents have a final body tag: the blocker goes before the document's real one, never before the same
      // text in an authored script or an attribute value (lib/document-injection.mjs).
      const bodyEnd = documentAnchors(html).bodyEnd;
      if (bodyEnd < 0) return answered(html);
      if (pending.size >= limit) {
        const oldest = pending.keys().next().value;
        finish(oldest, pending.get(oldest).response ? 'timeout' : 'aborted');
      }
      const id = randomUUID(),
        route = prefix + id,
        entry = { path };
      pending.set(id, entry);
      arm(id, entry, timeoutMs * NEVER_REQUESTED_FACTOR, 'never-requested');
      // The marker script, the last element of the body, requests the image: the browser cannot fetch a script-assigned
      // source ahead of the parser, and every parser-blocking script before it has arrived and run. It still holds the
      // load event. The image is found by its marker, not by position (the parser can foster-parent it out of an
      // unclosed table), and the release is registered even if that fails. jQuery 3 ready handlers are
      // asynchronous; queue behind them and allow one further macrotask. A
      // throwing ready handler does not prevent the global ready promise settling. Once the
      // frame has loaded, the marker leaves the document (the platform frame has no such image).
      // If CSP permits the blocking image but refuses fetch (connect-src), release through another image request.
      const markup = `<img hidden alt="" aria-hidden="true" data-paqvilo-frame-ready><script${scriptMarker(injectedScripts)} data-paqvilo-frame-ready>(function(){try{var image=document.querySelector('img[data-paqvilo-frame-ready]');if(image)image.src='${route}';}finally{document.addEventListener('DOMContentLoaded',function(){var jq=window.jQuery;function release(reason){window.__portalSimulation=window.__portalSimulation||{};window.__portalSimulation.frameLoadOrdering=reason;function releaseByImage(){new Image().src='${route}?release='+reason;}fetch('${route}?reason='+reason,{method:'POST',credentials:'same-origin'}).then(function(response){if(response.ok===false)return releaseByImage();return response.arrayBuffer();}).catch(releaseByImage);}if(jq&&jq.ready&&typeof jq.ready.then==='function'){jq.ready.then(function(){setTimeout(function(){release('jquery-ready');},0);});}else release('dom-ready');},{once:true});}window.addEventListener('load',function(){document.querySelectorAll('[data-paqvilo-frame-ready]').forEach(function(node){node.remove();});},{once:true});})();</script>`;
      return answered(html.slice(0, bodyEnd) + markup + html.slice(bodyEnd));
    },
    handle(req, res, url) {
      if (!url.pathname.startsWith(prefix)) return false;
      const id = url.pathname.slice(prefix.length),
        entry = pending.get(id);
      if (!entry) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return true;
      }
      const imageRelease = req.method === 'GET' && url.searchParams.has('release');
      if (req.method === 'POST' || imageRelease) {
        const origin = req.headers.origin;
        if (
          (origin && origin !== url.origin) ||
          (imageRelease &&
            (req.headers['sec-fetch-site'] !== 'same-origin' ||
              req.headers['sec-fetch-dest'] !== 'image' ||
              req.headers['sec-fetch-mode'] !== 'no-cors'))
        ) {
          res.writeHead(403);
          res.end();
          return true;
        }
        const reasonParam = imageRelease ? 'release' : 'reason';
        const reason = url.searchParams.get(reasonParam) === 'jquery-ready' ? 'jquery-ready' : 'dom-ready';
        finish(id, reason);
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
      } else if (req.method === 'GET' && !entry.response) {
        res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
        entry.response = res;
        arm(id, entry, timeoutMs, 'timeout');
        res.on('close', () => {
          if (pending.has(id)) finish(id, 'aborted');
        });
      } else {
        res.writeHead(405);
        res.end();
      }
      return true;
    },
    close() {
      for (const id of pending.keys()) finish(id, 'aborted');
    },
  };
}
