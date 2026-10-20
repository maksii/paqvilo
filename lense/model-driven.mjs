import { readLocalFile } from './local-file.mjs';
import { pathToFileURL } from 'node:url';
import { hasSourceMap, withFileSourceMap } from './source-map.mjs';
import { importModelDrivenResources } from '../mirage/lib/model-driven-resources.mjs';
import { scanSolutionSources } from '../mirage/lib/solution-schema.mjs';

export function modelDrivenOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Provide the model-driven environment origin with --url.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('--url must be an environment origin without credentials, path, query or fragment. Use --path for main.aspx.');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Model-driven environments require HTTPS; HTTP is allowed for loopback fixtures.');
  return url.origin;
}

const pathname = value => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\?#\x00-\x1f]/.test(value)) throw new Error('Resource mappings require an origin-relative pathname without query, fragment or backslash.');
  let decoded; try { decoded = decodeURIComponent(value); } catch { throw new Error('Resource mapping contains invalid URL encoding.'); }
  if (/[\\\x00-\x1f]/.test(decoded) || decoded.split('/').some(segment => ['.', '..'].includes(segment))) throw new Error('Invalid resource mapping pathname.');
  if (/^\/(?:api|oauth[^/]*|auth|signin|sign-in|login|connect|_sim|_setup)(?:\/|$)/i.test(decoded) || /^\/(?:main\.aspx|_apps\/api)(?:\/|$)/i.test(decoded)) throw new Error('Model-driven resource mappings cannot target an API, authentication, application shell or administration route.');
  return decoded.replace(/^\/webresources\//i, '/WebResources/');
};

export async function readModelDrivenResourceMap(file) {
  if (!file) return [];
  const data = await readLocalFile(file, { maxBytes: 1024 * 1024, encoding: 'utf8' });
  const map = JSON.parse(data);
  if (map?.version !== 1 || !Array.isArray(map.resources) || map.resources.length > 10000) throw new Error('Resource map requires version: 1 and a resources array (at most 10000 entries).');
  return map.resources.map(entry => {
    if (!entry || typeof entry.resource !== 'string' || !entry.resource || Object.keys(entry).some(key => !['path', 'resource'].includes(key))) throw new Error('Each resource mapping requires only path and resource.');
    return { path: pathname(entry.path), resource: entry.resource };
  });
}

export async function importModelDrivenProject(project) {
  const scan = await scanSolutionSources(project.solutionRoots, { order: project.solutionOrder });
  const imported = await importModelDrivenResources(scan.layers);
  return { ...imported, layers: scan.layers, diagnostics: [...scan.diagnostics, ...imported.diagnostics] };
}

const DEBUG_MAP_LIMITS = { assetBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };

// Conservative upper bound for the inline JSON source and line map, including
// JSON escaping, UTF-8, base64 and the directive. Estimate before allocating a
// map: a newline-heavy source otherwise grows many times larger than its input.
function debugMapEstimate(text, file) {
  let bytes = 2, lines = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13 || code === 10 && text.charCodeAt(i - 1) !== 13 || code === 0x2028 || code === 0x2029) lines++;
    if (code < 32) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    else if (code === 34 || code === 92) bytes += 2;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  const fileBytes = Buffer.byteLength(JSON.stringify(pathToFileURL(file).href));
  return 128 + Math.ceil((bytes + lines * 5 + fileBytes + 256) / 3) * 4;
}

/** Exact declared assets only. No response fetch, native request replay or API interception. */
export function createModelDrivenOverlay({ origin, imported, mappings = [], ownsRequest = () => true, onApplied = () => {}, sourceMapLimits = {} }) {
  origin = modelDrivenOrigin(origin);
  const mapLimits = { ...DEBUG_MAP_LIMITS };
  for (const [key, value] of Object.entries(sourceMapLimits)) {
    if (!Object.hasOwn(mapLimits, key) || !Number.isSafeInteger(value) || value < 1 || value > DEBUG_MAP_LIMITS[key]) throw new Error(`Invalid model-driven debugger map limit ${key}.`);
    mapLimits[key] = value;
  }
  let routes, resources, pathsByResource, diagnostics, revision = 0, applied = 0, currentRevisionApplied = 0;
  const hits = new Map(), currentHits = new Map(), unmatched = new Map();
  function replace(next, nextMappings = mappings) {
    // Prepare debugger mappings once per revision, rather than copying a bundle
    // and building an inline map on every intercepted request.
    let remainingMapBytes = mapLimits.totalBytes;
    const nextDiagnostics = [...next.diagnostics];
    const assets = new Map([...next.assets.values()].map(asset => {
      if (!asset.file || !/(?:java|ecma)script/i.test(asset.mime)) return [asset.name, asset];
      const text = asset.data.toString('utf8');
      if (hasSourceMap(text)) return [asset.name, asset];
      const estimate = debugMapEstimate(text, asset.file);
      if (asset.data.length + estimate > mapLimits.assetBytes || estimate > remainingMapBytes) {
        nextDiagnostics.push({ code: 'MODEL_SOURCE_MAP_LIMIT', name: asset.name, message: 'Local debugger map omitted because it exceeds the bounded asset or session map budget. The original script is still overlaid.' });
        return [asset.name, asset];
      }
      const data = withFileSourceMap(asset.data, asset.file);
      remainingMapBytes -= data.length - asset.data.length;
      return [asset.name, { ...asset, data }];
    }));
    const nextRoutes = new Map(), nextPaths = new Map([...assets.keys()].map(name => [name, new Set()]));
    const add = (key, name) => {
      const asset = assets.get(name); if (!asset) throw new Error(`Resource map selects an undeclared Solution resource: ${name}`);
      key = pathname(key);
      if (nextRoutes.has(key) && nextRoutes.get(key).name !== name) throw new Error(`Multiple Solution resources map to ${key}.`);
      nextRoutes.set(key, asset);
      nextPaths.get(name).add(key);
    };
    for (const resource of next.resources) add(`/WebResources/${resource.name}`, resource.name);
    for (const mapping of nextMappings) add(mapping.path, mapping.resource);
    // Publish only a complete import. An invalid save cannot partially replace routes.
    routes = nextRoutes; resources = assets; pathsByResource = nextPaths; diagnostics = nextDiagnostics; mappings = nextMappings;
    for (const name of hits.keys()) if (!resources.has(name)) hits.delete(name);
    currentHits.clear(); unmatched.clear(); currentRevisionApplied = 0; revision++;
  }
  replace(imported);
  return {
    replace,
    async handle(route) {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || request.isNavigationRequest?.() || request.resourceType?.() === 'document' || !ownsRequest(request)) { await route.fallback(); return; }
      let key; try { key = pathname(url.pathname); } catch { await route.fallback(); return; }
      const asset = routes.get(key);
      if (!asset) {
        if ((/^\/WebResources\//.test(key) || ['script', 'stylesheet'].includes(request.resourceType?.())) && (unmatched.has(key) || unmatched.size < 256)) unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
        await route.fallback(); return;
      }
      const appliedRevision = revision;
      await route.fulfill({ status: 200, headers: { 'content-type': asset.mime, 'cache-control': 'no-store', 'x-paqvilo-source': 'local-solution', 'x-content-type-options': 'nosniff' }, body: request.method() === 'HEAD' ? Buffer.alloc(0) : asset.data });
      applied++;
      const count = (hits.get(asset.name) ?? 0) + 1;
      if (resources.has(asset.name)) hits.set(asset.name, count);
      // Requests already being answered can finish after a source replacement.
      // They count toward the session, but never prove the new revision was applied.
      if (revision === appliedRevision) {
        currentRevisionApplied++;
        currentHits.set(asset.name, (currentHits.get(asset.name) ?? 0) + 1);
      }
      onApplied({ resource: asset.name, path: key, count, revision: appliedRevision });
    },
    report() {
      return { schemaVersion: 1, kind: 'model-driven-overlay', origin, revision, diagnostics,
        resources: [...resources.keys()].map(name => ({ name, paths: [...pathsByResource.get(name)], applied: hits.get(name) ?? 0, currentRevisionApplied: currentHits.get(name) ?? 0 })),
        applied, currentRevisionApplied,
        unmatched: [...unmatched].map(([path, count]) => ({ path, count })), unmatchedLimit: 256,
        // Native PCF URLs vary by environment and version. Bind observed exact paths;
        // never infer a bundle mapping from an arbitrary script filename.
        unbound: [...resources.keys()].filter(name => !pathsByResource.get(name).size), writesFiles: [] };
    },
  };
}
