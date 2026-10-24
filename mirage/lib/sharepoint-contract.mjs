// SharePoint / Microsoft Graph driveItem contract fixture: a bounded route set answered from an in-memory store
// seeded by project fixtures. Never mounted by default: a connection that declares it serves these routes behind a connector
// `http` provider URL rewrite, or a project test starts createSharePointFixtureServer on loopback. Never reaches a tenant.
//
// Operations: list children by path, upload (simple PUT) by path, create folder by path, delete by item id; If-Match on
// upload and delete; @microsoft.graph.conflictBehavior fail|rename|replace. Everything else answers 501 notSupported with
// inner code ProviderOperationUnsupported and a diagnostic once per method and route shape.
//
// Contract: https://learn.microsoft.com/graph/api/resources/driveitem and its list-children, put-content,
// post-children and delete operations; error bodies per https://learn.microsoft.com/graph/errors.
// Guessed: the eTag/cTag text ("{<id>},<version>"), item id format and parentReference.path for the root.
// Guessed: error bodies carry only code and message (no innerError date / request-id); 412 uses resourceModified.
// Guessed: PUT content to a path whose parent folder does not exist answers 404 itemNotFound (Graph may create it).
// Guessed: POST children defaults to conflictBehavior fail; replace on an existing folder answers 200 with that folder.
// ponytail: simple upload bodies are capped at 4 MiB in the fixture server (413); createUploadSession is not modelled.
import http from "node:http";
import { systemClock, systemIds } from "./runtime-clock.mjs";

export const SHAREPOINT_CONTRACT_OPERATIONS = Object.freeze(["listChildren", "uploadContent", "createFolder", "deleteItem"]);

export const sharePointContractDescriptor = Object.freeze({
  name: "sharepoint-contract",
  version: 1,
  kind: "connector-fixture",
  level: "contract",
  operations: SHAREPOINT_CONTRACT_OPERATIONS,
  requires: Object.freeze(["connection:sharepoint"]),
  principal: "connection",
  stateOwner: "sharepoint-contract",
  lifecycle: "in-process",
});

const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const MAX_UPLOAD = 4 * 1024 * 1024;

/** Validates { sites: { id: {...} }, drives: { id: { siteId } }, items: [{ driveId, path, folder?, content?, contentType? }] }.
 * Returns a normalised copy; throws TypeError naming the bad entry. */
export function validateSharePointFixtures(value) {
  if (value === undefined) return { sites: {}, drives: {}, items: [] };
  if (!plain(value)) throw new TypeError("SharePoint fixtures must be an object with sites, drives and items.");
  for (const key of Object.keys(value)) if (!["sites", "drives", "items"].includes(key)) throw new TypeError(`Unknown SharePoint fixtures key '${key}'.`);
  const sites = value.sites ?? {};
  const drives = value.drives ?? {};
  const items = value.items ?? [];
  if (!plain(sites)) throw new TypeError("SharePoint fixtures sites must map site ids to objects.");
  for (const [id, site] of Object.entries(sites)) if (!plain(site)) throw new TypeError(`SharePoint fixtures sites['${id}'] must be an object.`);
  if (!plain(drives)) throw new TypeError("SharePoint fixtures drives must map drive ids to objects.");
  for (const [id, drive] of Object.entries(drives)) {
    if (!plain(drive) || typeof drive.siteId !== "string" || !Object.hasOwn(sites, drive.siteId))
      throw new TypeError(`SharePoint fixtures drives['${id}'].siteId must name a declared site.`);
  }
  if (!Array.isArray(items)) throw new TypeError("SharePoint fixtures items must be an array.");
  const normalised = items.map((item, index) => {
    const at = `SharePoint fixtures items[${index}]`;
    if (!plain(item)) throw new TypeError(`${at} must be an object.`);
    if (typeof item.driveId !== "string" || !Object.hasOwn(drives, item.driveId)) throw new TypeError(`${at}.driveId must name a declared drive.`);
    const segments = typeof item.path === "string" ? item.path.split("/").filter(Boolean) : [];
    if (!segments.length || segments.some((s) => s === "." || s === "..")) throw new TypeError(`${at}.path must be a relative path without . or .. segments.`);
    if (item.content !== undefined && (item.folder === true || typeof item.content !== "string")) throw new TypeError(`${at}.content must be a string on a file item.`);
    return { driveId: item.driveId, path: segments.join("/"), folder: item.folder === true, content: item.content ?? "", contentType: item.contentType ?? "application/octet-stream", ...(item.id ? { id: String(item.id) } : {}) };
  });
  return { sites: structuredClone(sites), drives: structuredClone(drives), items: normalised };
}

const graphError = (status, code, message, inner) => ({ status, headers: { "content-type": "application/json" },
  body: { error: { code, message, ...(inner ? { innerError: { code: inner } } : {}) } } });
const notFound = (what = "The resource could not be found.") => graphError(404, "itemNotFound", what);

/** Route descriptors { method, pattern, operation, handle(req) } over one in-memory store. req: { method, url, headers, body }.
 * handle answers { status, headers, body } (body: object for JSON, null for none). The last route answers 501 for the rest. */
export function createSharePointContractRoutes({ fixtures, diagnostic, clock = systemClock, ids = systemIds } = {}) {
  const data = validateSharePointFixtures(fixtures);
  const items = new Map(); // id -> item
  const seen = new Set();
  const now = () => new Date(clock.now()).toISOString();
  const etagOf = (item) => `"{${item.id}},${item.version}"`;
  const roots = new Map();
  const add = (fields) => {
    const item = { id: fields.id ?? ids.uuid().replace(/-/g, "").toUpperCase(), version: 1, created: now(), modified: now(), bytes: Buffer.alloc(0), mimeType: "application/octet-stream", ...fields };
    items.set(item.id, item);
    return item;
  };
  for (const driveId of Object.keys(data.drives)) roots.set(driveId, add({ id: `root-${driveId}`, driveId, name: "root", parentId: null, folder: true }));
  const childOf = (parent, name) => [...items.values()].find((item) => item.parentId === parent.id && item.name.toLowerCase() === name.toLowerCase()) ?? null;
  const byPath = (driveId, segments) => {
    let current = roots.get(driveId);
    for (const segment of segments) {
      if (!current?.folder) return null;
      current = childOf(current, segment);
    }
    return current ?? null;
  };
  for (const item of data.items) {
    const segments = item.path.split("/");
    let parent = roots.get(item.driveId);
    for (const segment of segments.slice(0, -1)) parent = childOf(parent, segment) ?? add({ driveId: item.driveId, name: segment, parentId: parent.id, folder: true });
    if (childOf(parent, segments.at(-1))) throw new TypeError(`SharePoint fixtures declare '${item.path}' twice.`);
    add({ ...(item.id ? { id: item.id } : {}), driveId: item.driveId, name: segments.at(-1), parentId: parent.id, folder: item.folder,
      bytes: Buffer.from(item.content), mimeType: item.contentType });
  }

  const pathOf = (item) => {
    const names = [];
    for (let current = items.get(item.parentId); current && current.parentId; current = items.get(current.parentId)) names.unshift(current.name);
    return `/drives/${item.driveId}/root:${names.length ? "/" + names.join("/") : ""}`;
  };
  const driveItem = (item) => ({
    id: item.id, name: item.name, eTag: etagOf(item), cTag: etagOf(item),
    size: item.folder ? [...items.values()].filter((child) => child.parentId === item.id).reduce((sum, child) => sum + (child.folder ? 0 : child.bytes.length), 0) : item.bytes.length,
    createdDateTime: item.created, lastModifiedDateTime: item.modified,
    parentReference: { driveId: item.driveId, driveType: "documentLibrary", ...(item.parentId ? { id: item.parentId, path: pathOf(item) } : {}) },
    ...(item.folder ? { folder: { childCount: [...items.values()].filter((child) => child.parentId === item.id).length } } : { file: { mimeType: item.mimeType } }),
  });
  const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body });
  // Site and drive must be declared, and the drive must belong to the site.
  const driveFor = (siteId, driveId) => (data.drives[driveId]?.siteId === siteId ? driveId : null);
  const segmentsOf = (raw) => raw.split("/").filter(Boolean).map(decodeURIComponent);
  const header = (req, name) => req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  const conflictOf = (value, fallback) => (["fail", "rename", "replace"].includes(value) ? value : fallback);
  const uniqueName = (parent, name) => {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) if (!childOf(parent, `${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`;
  };
  const removeTree = (item) => {
    for (const child of [...items.values()].filter((entry) => entry.parentId === item.id)) removeTree(child);
    items.delete(item.id);
  };

  const prefix = String.raw`^(?:/v1\.0)?/sites/([^/?]+)/drives/([^/?]+)`;
  const routes = [
    {
      method: "GET", operation: "listChildren", pattern: new RegExp(prefix + String.raw`/root:/(.+?):/children(?:\?.*)?$`),
      handle(req, [, siteId, driveId, rawPath]) {
        const drive = driveFor(decodeURIComponent(siteId), decodeURIComponent(driveId));
        const folder = drive && byPath(drive, segmentsOf(rawPath));
        if (!folder?.folder) return notFound();
        return json(200, { value: [...items.values()].filter((item) => item.parentId === folder.id).map(driveItem) });
      },
    },
    {
      method: "PUT", operation: "uploadContent", pattern: new RegExp(prefix + String.raw`/root:/(.+?):/content(?:\?(.*))?$`),
      handle(req, [, siteId, driveId, rawPath, query]) {
        const drive = driveFor(decodeURIComponent(siteId), decodeURIComponent(driveId));
        const segments = segmentsOf(rawPath);
        const parent = drive && byPath(drive, segments.slice(0, -1));
        if (!parent?.folder || !segments.length) return notFound();
        let existing = childOf(parent, segments.at(-1));
        if (existing?.folder) return graphError(409, "nameAlreadyExists", "The specified item name already exists.");
        const ifMatch = header(req, "if-match");
        if (ifMatch !== undefined && ifMatch !== "*" && (!existing || ifMatch !== etagOf(existing)))
          return graphError(412, "resourceModified", "The resource has changed since the caller last read it.");
        let name = segments.at(-1);
        const conflict = conflictOf(new URLSearchParams(query ?? "").get("@microsoft.graph.conflictBehavior"), "replace");
        if (existing && conflict === "fail") return graphError(409, "nameAlreadyExists", "The specified item name already exists.");
        if (existing && conflict === "rename") { name = uniqueName(parent, name); existing = null; }
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
        const mimeType = header(req, "content-type") ?? "application/octet-stream";
        if (existing) {
          Object.assign(existing, { bytes, mimeType, version: existing.version + 1, modified: now() });
          return json(200, driveItem(existing));
        }
        return json(201, driveItem(add({ driveId: drive, name, parentId: parent.id, folder: false, bytes, mimeType })));
      },
    },
    {
      method: "POST", operation: "createFolder", pattern: new RegExp(prefix + String.raw`/root:/(.+?):/children(?:\?.*)?$`),
      handle(req, [, siteId, driveId, rawPath]) {
        const drive = driveFor(decodeURIComponent(siteId), decodeURIComponent(driveId));
        const parent = drive && byPath(drive, segmentsOf(rawPath));
        if (!parent?.folder) return notFound();
        let body;
        try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "")); } catch { body = null; }
        if (!plain(body) || typeof body.name !== "string" || !body.name.trim() || /[\\/]/.test(body.name) || !plain(body.folder))
          return graphError(400, "invalidRequest", "The request is malformed or incorrect.");
        const existing = childOf(parent, body.name);
        const conflict = conflictOf(body["@microsoft.graph.conflictBehavior"], "fail");
        if (existing && conflict === "fail") return graphError(409, "nameAlreadyExists", "The specified item name already exists.");
        if (existing && conflict === "replace" && existing.folder) return json(200, driveItem(existing));
        if (existing && conflict === "replace") removeTree(existing);
        const name = existing && conflict === "rename" ? uniqueName(parent, body.name) : body.name;
        return json(201, driveItem(add({ driveId: drive, name, parentId: parent.id, folder: true })));
      },
    },
    {
      method: "DELETE", operation: "deleteItem", pattern: new RegExp(prefix + String.raw`/items/([^/?]+)(?:\?.*)?$`),
      handle(req, [, siteId, driveId, itemId]) {
        const drive = driveFor(decodeURIComponent(siteId), decodeURIComponent(driveId));
        const item = drive && items.get(decodeURIComponent(itemId));
        if (!item || item.driveId !== drive || !item.parentId) return notFound();
        const ifMatch = header(req, "if-match");
        if (ifMatch !== undefined && ifMatch !== "*" && ifMatch !== etagOf(item))
          return graphError(412, "resourceModified", "The resource has changed since the caller last read it.");
        removeTree(item);
        return { status: 204, headers: {}, body: null };
      },
    },
    {
      method: "*", operation: "unsupported", pattern: /^/,
      handle(req) {
        const shape = `${req.method} ${String(req.url ?? "").split("?")[0].replace(/\/[^/]+/g, "/*")}`;
        if (!seen.has(shape)) {
          seen.add(shape);
          diagnostic?.({ severity: "warning", code: "SHAREPOINT_CONTRACT_UNSUPPORTED", message: `The SharePoint contract fixture does not model ${shape}.` });
        }
        return graphError(501, "notSupported", "The SharePoint contract fixture does not model this operation.", "ProviderOperationUnsupported");
      },
    },
  ];
  // handle(req) matches its own pattern against req.url, so a caller needs only the descriptor.
  // A malformed percent-escape in a path makes decodeURIComponent throw URIError; answer it here, where every route goes through.
  return routes.map(({ handle, ...route }) => ({ ...route, handle: (req) => {
    try { return handle(req, route.pattern.exec(String(req.url ?? "")) ?? []); }
    catch (error) { if (error instanceof URIError) return graphError(400, "invalidRequest", "The request is malformed or incorrect."); throw error; }
  } }));
}

/** Answers one request from a route list: the first route whose method and pattern match. */
export function dispatchSharePointRoute(routes, req) {
  for (const route of routes) {
    if (route.method !== "*" && route.method !== req.method) continue;
    if (route.pattern.test(String(req.url ?? ""))) return route.handle(req);
  }
  return graphError(501, "notSupported", "No route.", "ProviderOperationUnsupported");
}

/** Loopback HTTP server over the route set (tests, project httpFixtures). Resolves { url, routes, close() }. */
export async function createSharePointFixtureServer({ fixtures, diagnostic, host = "127.0.0.1", clock, ids } = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new TypeError("The SharePoint fixture server listens on loopback only.");
  const routes = createSharePointContractRoutes({ fixtures, diagnostic, clock, ids });
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        const tooLarge = graphError(413, "invalidRequest", "The fixture accepts simple uploads up to 4 MiB.");
        response.writeHead(tooLarge.status, tooLarge.headers).end(JSON.stringify(tooLarge.body));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const answer = dispatchSharePointRoute(routes, { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(answer.status, answer.headers);
    response.end(answer.body == null ? undefined : JSON.stringify(answer.body));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const { port } = server.address();
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    routes,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
