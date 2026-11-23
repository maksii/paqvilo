import { EventEmitter } from 'node:events';

/** A browser as far as interception sees it: tabs with a DevTools session each, and the online portal. */
export function fakeBrowser(online = {}) {
  const sent = [];
  const fetched = [];
  // requests the browser itself sent to the portal with their response paused (Fetch.continueRequest interceptResponse)
  const staged = [];
  const pausedUrls = new Map();
  const context = Object.assign(new EventEmitter(), {
    tabs: [],
    pages: () => context.tabs.map((t) => t.page),
    newCDPSession: async (page) => context.tabs.find((t) => t.page === page).cdp,
    request: {
      fetch: async (url, opts) => {
        fetched.push({ url, ...opts });
        const r = online[url];
        if (!r) throw new Error(`no route to ${url}`);
        const body = Buffer.from(r.body ?? '');
        return {
          status: () => r.status ?? 200,
          headers: () => r.headers ?? {},
          headersArray: () => Object.entries(r.headers ?? {}).map(([name, value]) => ({ name, value })),
          text: async () => body.toString(),
          body: async () => body,
        };
      },
    },
  });
  const openTab = (url = 'about:blank') => {
    const cdp = Object.assign(new EventEmitter(), {
      send: async (method, params) => {
        sent.push({ method, ...params });
        // The browser sends the request itself and pauses once more when the portal has answered.
        if (method === 'Fetch.continueRequest' && params.interceptResponse) {
          const url = pausedUrls.get(params.requestId);
          const answer = online[url];
          staged.push({ url, requestId: params.requestId });
          queueMicrotask(() =>
            cdp.emit('Fetch.requestPaused', {
              requestId: params.requestId,
              frameId: 'main',
              request: { url },
              ...(answer
                ? {
                    responseStatusCode: answer.status ?? 200,
                    responseHeaders: Object.entries(answer.headers ?? {}).map(([name, value]) => ({ name, value })),
                  }
                : { responseErrorReason: 'Failed' }),
            }),
          );
          return {};
        }
        if (method === 'Fetch.getResponseBody') {
          const answer = online[pausedUrls.get(params.requestId)];
          return { body: Buffer.from(answer?.body ?? '').toString('base64'), base64Encoded: true };
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Runtime.evaluate' && params.expression === 'document')
          return { result: { objectId: 'document' } };
        if (
          method === 'Runtime.callFunctionOn' &&
          params.functionDeclaration?.startsWith('function repairLateDocument')
        ) {
          page.reloads++;
          return { result: { value: 'reloading' } };
        }
        return {};
      },
    });
    const mainFrame = { url: () => url };
    const page = Object.assign(new EventEmitter(), {
      url: () => url,
      mainFrame: () => mainFrame,
      context: () => context,
      isClosed: () => false,
      reloads: 0,
      reload: async () => void page.reloads++,
      goto: async () => void page.reloads++,
      // what the dev panel was last drawn with
      drawn: null,
      // the portal sign-in and sign-out flows the panel ran in this page
      flows: [],
      evaluate: async (fn, data) => {
        if (fn?.name === 'runSessionFlow') {
          page.flows.push(data);
          return true;
        }
        if (fn?.name === 'inspectRenderedPage') return { assets: [], controls: [] };
        page.drawn = data;
        return undefined;
      },
    });
    const tab = {
      page,
      cdp,
      pause: (requestId, url, { type = 'XHR', method = 'GET', frameId = 'main', headers = {}, postData } = {}) => {
        pausedUrls.set(requestId, url);
        return cdp.emit('Fetch.requestPaused', {
          requestId,
          frameId,
          resourceType: type,
          request: { url, method, headers, postData, hasPostData: postData != null },
        });
      },
    };
    context.tabs.push(tab);
    return tab;
  };
  const answers = (requestId) => sent.filter((s) => s.requestId === requestId && s.method.startsWith('Fetch.'));
  return { context, openTab, sent, fetched, staged, answers };
}

/**
 * Interception answers each paused request with one Fetch.* command for its request ID. The function this returns
 * pauses a request on `tab` and resolves once that answer was sent.
 */
export function pausedAnswers(tab) {
  const waiting = new Map();
  const send = tab.cdp.send;
  tab.cdp.send = async (method, params) => {
    const result = await send(method, params);
    // A request the browser sends itself is paused once more at its response: the answer is what follows that.
    if (method.startsWith('Fetch.') && !params?.interceptResponse && method !== 'Fetch.getResponseBody')
      waiting.get(params?.requestId)?.();
    return result;
  };
  return (requestId, url, options) => {
    const answered = new Promise((resolve) => waiting.set(requestId, resolve));
    tab.pause(requestId, url, options);
    return answered;
  };
}
