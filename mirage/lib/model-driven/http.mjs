import fs from 'node:fs/promises';

const assets = { 'app.mjs': 'text/javascript; charset=utf-8', 'controls.mjs': 'text/javascript; charset=utf-8', 'icons.mjs': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
const fail = (message, status) => Object.assign(new Error(message), { status, code: 'ModelDrivenRequestInvalid' });
const metadataOnly = catalogue => ({ ...catalogue, tables: Object.fromEntries(Object.entries(catalogue.tables).map(([name, { rows: _rows, ...table }]) => [name, table])) });

export function createModelDrivenHandler({ catalogue, data, csrf, json, readBody, change, read = fn => fn() }) {
  return async (req, res, url) => {
    const shell = url.pathname === '/main.aspx' || /^\/_apps\/?$/.test(url.pathname);
    const asset = /^\/_apps\/assets\/([^/]+)$/.exec(url.pathname);
    const api = /^\/_apps\/api(?:\/(.*))?$/.exec(url.pathname);
    if (!shell && !asset && !api && !url.pathname.startsWith('/_apps/')) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    try {
      if (shell || asset) {
        if (!['GET', 'HEAD'].includes(req.method)) throw fail('This resource requires GET.', 405);
        if (asset && !assets[asset[1]]) throw fail('Asset not found.', 404);
        const name = shell ? 'index.html' : asset[1];
        let content = await fs.readFile(new URL(name, import.meta.url), 'utf8');
        if (shell) content = content.replace('__MIRAGE_CSRF__', csrf());
        // App code and assets are local. Solution scripts/URLs are data only.
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
        res.writeHead(200, { 'content-type': shell ? 'text/html; charset=utf-8' : assets[name] });
        res.end(req.method === 'HEAD' ? undefined : content);
        return true;
      }
      if (!api) throw fail('Model-driven resource not found.', 404);
      const method = req.method;
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw fail('Method not allowed.', 405);
      if (method !== 'GET' && req.headers['x-sim-csrf'] !== csrf()) throw fail('Missing simulator CSRF token.', 403);
      if (!api[1]) {
        if (method !== 'GET') throw fail('Catalogue requires GET.', 405);
        json(res, 200, await read(() => metadataOnly(catalogue()))); return true;
      }
      const route = /^tables\/([a-z][\w]*)(?:\/([^/]+))?$/i.exec(api[1]);
      if (!route) throw fail('Model-driven endpoint not found.', 404);
      const [, entity, encodedId] = route, id = encodedId ? decodeURIComponent(encodedId) : null;
      if (id && (!/^[\w{}-]{1,128}$/.test(id))) throw fail('Invalid record ID.', 400);
      if (method === 'GET') {
        if (id) json(res, 200, await data.get(entity, id));
        else {
          let query;
          try { query = JSON.parse(url.searchParams.get('query') ?? '{}'); } catch { throw fail('Invalid grid query JSON.', 400); }
          if (!query || typeof query !== 'object' || Array.isArray(query)) throw fail('Provide a grid query object.', 400);
          json(res, 200, await data.list(entity, query));
        }
      } else {
        if (method === 'POST' && id || method !== 'POST' && !id) throw fail('Invalid record operation.', 405);
        const values = method === 'DELETE' ? {} : await readBody(req);
        const result = await change(() => data.write(entity, id, values, { remove: method === 'DELETE', etag: req.headers['if-match'] }));
        json(res, method === 'POST' ? 201 : 200, result);
      }
    } catch (error) {
      json(res, error.status ?? 500, { error: { message: error.message, code: error.code ?? 'ModelDrivenError' } });
    }
    return true;
  };
}
