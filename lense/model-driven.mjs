import { readLocalFile } from './local-file.mjs';
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

/** Exact declared assets only. No response fetch, native request replay or API interception. */
export function createModelDrivenOverlay({ origin, imported, mappings = [], ownsRequest = () => true, onApplied = () => {} }) {
  origin = modelDrivenOrigin(origin);
  let routes, resources, diagnostics, revision = 0;
  const hits = new Map(), currentHits = new Map(), unmatched = new Map();
  function replace(next, nextMappings = mappings) {
    const assets = new Map([...next.assets.values()].map(asset => [asset.name, asset]));
    const nextRoutes = new Map();
    const add = (key, name) => {
      const asset = assets.get(name); if (!asset) throw new Error(`Resource map selects an undeclared Solution resource: ${name}`);
      key = pathname(key);
      if (nextRoutes.has(key) && nextRoutes.get(key).name !== name) throw new Error(`Multiple Solution resources map to ${key}.`);
      nextRoutes.set(key, asset);
    };
    for (const resource of next.resources) add(`/WebResources/${resource.name}`, resource.name);
    for (const mapping of nextMappings) add(mapping.path, mapping.resource);
    // Publish only a complete import. An invalid save cannot partially replace routes.
    routes = nextRoutes; resources = assets; diagnostics = next.diagnostics; mappings = nextMappings; currentHits.clear(); revision++;
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
      await route.fulfill({ status: 200, headers: { 'content-type': asset.mime, 'cache-control': 'no-store', 'x-paqvilo-source': 'local-solution', 'x-content-type-options': 'nosniff' }, body: request.method() === 'HEAD' ? Buffer.alloc(0) : asset.data });
      const count = (hits.get(asset.name) ?? 0) + 1; hits.set(asset.name, count);
      currentHits.set(asset.name, (currentHits.get(asset.name) ?? 0) + 1);
      onApplied({ resource: asset.name, path: key, count, revision });
    },
    report() {
      return { schemaVersion: 1, kind: 'model-driven-overlay', origin, revision, diagnostics,
        resources: [...resources.keys()].map(name => ({ name, paths: [...routes].filter(([, asset]) => asset.name === name).map(([path]) => path), applied: hits.get(name) ?? 0, currentRevisionApplied: currentHits.get(name) ?? 0 })),
        applied: [...hits.values()].reduce((sum, count) => sum + count, 0),
        currentRevisionApplied: [...currentHits.values()].reduce((sum, count) => sum + count, 0),
        unmatched: [...unmatched].map(([path, count]) => ({ path, count })), unmatchedLimit: 256,
        // Native PCF URLs vary by environment and version. Bind observed exact paths;
        // never infer a bundle mapping from an arbitrary script filename.
        unbound: [...resources.keys()].filter(name => ![...routes.values()].some(asset => asset.name === name)), writesFiles: [] };
    },
  };
}
