import { EventEmitter } from 'node:events';

/** A browser as far as interception sees it: tabs with a DevTools session each, and the online portal. */
export function fakeBrowser(online = {}) {
  const sent = [];
  const fetched = [];
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
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        return {};
      },
    });
    const page = Object.assign(new EventEmitter(), {
      url: () => url,
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
        page.drawn = data;
        return undefined;
      },
    });
    const tab = {
      page,
      cdp,
      pause: (requestId, url, { type = 'XHR', method = 'GET', frameId = 'main', headers = {}, postData } = {}) =>
        cdp.emit('Fetch.requestPaused', { requestId, frameId, resourceType: type, request: { url, method, headers, postData, hasPostData: postData != null } }),
    };
    context.tabs.push(tab);
    return tab;
  };
  const answers = (requestId) => sent.filter((s) => s.requestId === requestId && s.method.startsWith('Fetch.'));
  return { context, openTab, sent, fetched, answers };
}
