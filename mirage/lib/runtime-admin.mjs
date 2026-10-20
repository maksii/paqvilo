// Generic local administration shared by portal and solution-only hosts.
const error = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const decodeAdminIdentifier = value => { try { return decodeURIComponent(value); } catch { throw error('Administration identifier has invalid URL encoding.'); } };
export function createRuntimeAdminRouter({ store, json, jsonObjectBody, change, csrf, status, state, configuration, configure, simulation, diagnostics, shutdown, dataverseAdmin, staffSession }) {
  const records = async (req, res, url, relative) => {
    const method = req.method;
    const record = /^\/records\/([^/]+)(?:\/([^/]+))?$/.exec(relative);
    if (record) {
      const [, entity, id] = record.map((x) => x && decodeAdminIdentifier(x));
      const identity = { admin: true };
      if (
        method === "GET" &&
        !id &&
        (url.searchParams.has("page") ||
          url.searchParams.has("pageSize") ||
          url.searchParams.has("search"))
      ) {
        const pageSize = Math.min(
          100,
          Math.max(
            1,
            Number.parseInt(url.searchParams.get("pageSize"), 10) || 25,
          ),
        );
        const search = (url.searchParams.get("search") ?? "")
          .trim()
          .toLowerCase();
        const rows = store
          .rows(entity, identity)
          .filter(
            (row) =>
              !search || JSON.stringify(row).toLowerCase().includes(search),
          );
        const total = rows.length,
          pageCount = Math.max(1, Math.ceil(total / pageSize)),
          page = Math.min(
            pageCount,
            Math.max(1, Number.parseInt(url.searchParams.get("page"), 10) || 1),
          );
        return json(res, 200, {
          items: rows.slice((page - 1) * pageSize, page * pageSize),
          total,
          page,
          pageSize,
          pageCount,
        });
      }
      if (method === "GET")
        return json(
          res,
          200,
          id
            ? await store.get(entity, id, identity)
            : await store.query(entity, url.searchParams, identity),
        );
      return change(async () => {
        if (method === "POST" && !id)
          return json(
            res,
            201,
            await store.create(entity, await jsonObjectBody(req), identity),
          );
        if (method === "PATCH" && id)
          return json(
            res,
            200,
            await store.update(entity, id, await jsonObjectBody(req), identity),
          );
        if (method === "DELETE" && id) {
          await store.remove(entity, id, identity);
          return json(res, 204, null);
        }
        throw error("Unsupported record operation.", 405);
      });
    }
  };
  return async (req, res, url) => {
    const prefix = /^\/(?:_sim|__sim)\/api(?=\/|$)/.exec(url.pathname);
    if (!prefix) return false;
    const relative = url.pathname.slice(prefix[0].length), method = req.method;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && req.headers['x-sim-csrf'] !== csrf()) throw error('Missing simulator CSRF token.', 403);
    if (staffSession && await staffSession(req, res, url)) return true;
    const answer = async value => { json(res, 200, await value); return true; };
    if (method === 'GET' && relative === '/status' && status) return answer(status());
    if (method === 'GET' && relative === '/state' && state) return answer(state(url));
    if (method === 'GET' && relative === '/config' && configuration) return answer(configuration());
    if (method === 'PATCH' && relative === '/config' && configure) return answer(change(async () => configure(await jsonObjectBody(req))));
    if (method === 'GET' && relative === '/simulation' && simulation) return answer(simulation());
    if (method === 'GET' && relative === '/diagnostics' && diagnostics) return answer(diagnostics());
    if (relative === '/dataverse' || relative.startsWith('/dataverse/')) {
      if (!dataverseAdmin) return false;
      await dataverseAdmin(req, res, relative); return true;
    }
    if (/^\/records\/[^/]+(?:\/[^/]+)?$/.test(relative)) { await records(req, res, url, relative); return true; }
    if (method === 'POST' && relative === '/shutdown' && shutdown) {
      res.once('finish', () => { Promise.resolve().then(shutdown).catch(() => {}); });
      json(res, 200, { stopped: true }); return true;
    }
    return false;
  };
}
