import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readLocalFile } from './local-file.mjs';
import { pathToFileURL } from 'node:url';
import { hasSourceMap, withFileSourceMap } from './source-map.mjs';
import { importModelDrivenResources } from '../mirage/lib/model-driven-resources.mjs';
import { scanSolutionSources } from '../mirage/lib/solution-schema.mjs';
import { importSolutionMetadata } from '../mirage/lib/solution-metadata.mjs';
import { solutionApps } from '../mirage/lib/model-driven/catalogue.mjs';

export function modelDrivenOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provide the model-driven environment origin with --url.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      '--url must be an environment origin without credentials, path, query or fragment. Use --path for main.aspx.',
    );
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Model-driven environments require HTTPS; HTTP is allowed for loopback fixtures.');
  return url.origin;
}

export const modelDrivenResourcePath = (value) => {
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\?#\x00-\x1f]/.test(value))
    throw new Error('Resource mappings require an origin-relative pathname without query, fragment or backslash.');
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error('Resource mapping contains invalid URL encoding.');
  }
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  if (/[\\\x00-\x1f]/.test(decoded) || decoded.split('/').some((segment) => ['.', '..'].includes(segment)))
    throw new Error('Invalid resource mapping pathname.');
  if (
    /^\/(?:api|oauth[^/]*|auth|signin|sign-in|login|connect|_sim|_setup)(?:\/|$)/i.test(decoded) ||
    /^\/(?:main\.aspx|_apps\/api)(?:\/|$)/i.test(decoded)
  )
    throw new Error(
      'Model-driven resource mappings cannot target an API, authentication, application shell or administration route.',
    );
  return decoded.replace(/^\/webresources\//i, '/WebResources/');
};

const pathname = modelDrivenResourcePath;
const confinedMapFile = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !/[\\:%?#\s]/.test(value) &&
  !value.startsWith('/') &&
  !value.split('/').some((part) => ['.', '..', ''].includes(part));

function validMapSegments(map) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let source = 0,
    line = 0,
    column = 0,
    name = 0,
    generated = 0;
  let fields = [],
    value = 0,
    shift = 0,
    continued = false,
    separated = false;
  const segment = () => {
    if (!fields.length || continued || ![1, 4, 5].includes(fields.length) || fields[0] < 0) return false;
    generated += fields[0];
    if (!Number.isSafeInteger(generated)) return false;
    if (fields.length >= 4) {
      source += fields[1];
      line += fields[2];
      column += fields[3];
      if (
        source < 0 ||
        source >= map.sources.length ||
        line < 0 ||
        column < 0 ||
        ![source, line, column].every(Number.isSafeInteger)
      )
        return false;
      if (fields.length === 5) {
        name += fields[4];
        if (name < 0 || name >= map.names.length || !Number.isSafeInteger(name)) return false;
      }
    }
    fields = [];
    return true;
  };
  for (const char of map.mappings) {
    if (char === ',' || char === ';') {
      if (fields.length || continued) {
        if (!segment()) return false;
      } else if (char === ',' || separated) return false;
      if (char === ';') generated = 0;
      separated = char === ',';
      continue;
    }
    const digit = alphabet.indexOf(char);
    if (digit < 0 || shift > 45 || fields.length >= 5) return false;
    value += (digit & 31) * 2 ** shift;
    continued = (digit & 32) !== 0;
    if (continued) shift += 5;
    else {
      fields.push((value % 2 ? -1 : 1) * Math.floor(value / 2));
      value = 0;
      shift = 0;
    }
    separated = false;
  }
  return !separated && !continued && (!fields.length || segment());
}

export async function readModelDrivenResourceMap(file, { assets = new Map() } = {}) {
  if (!file) return [];
  const data = await readLocalFile(file, { maxBytes: 1024 * 1024, encoding: 'utf8' });
  const map = JSON.parse(data);
  if (map?.version !== 1 || !Array.isArray(map.resources) || map.resources.length > 10000)
    throw new Error('Resource map requires version: 1 and a resources array (at most 10000 entries).');
  let remaining = DEBUG_MAP_LIMITS.totalBytes;
  const mappings = [];
  const mappedScripts = new Set();
  const assetsByName = new Map([...assets.values()].map((asset) => [asset.name, asset]));
  for (const entry of map.resources) {
    if (
      !entry ||
      typeof entry.resource !== 'string' ||
      !entry.resource ||
      Object.keys(entry).some((key) => !['path', 'resource', 'sourceMap'].includes(key))
    )
      throw new Error('Each resource mapping requires path, resource and optionally sourceMap.');
    const mapping = { path: pathname(entry.path), resource: entry.resource };
    if (entry.sourceMap !== undefined) {
      if (mappedScripts.has(entry.resource)) throw new Error('A script can declare only one source-map sidecar.');
      mappedScripts.add(entry.resource);
      const spec = entry.sourceMap;
      if (!spec || Object.keys(spec).some((key) => !['path', 'file'].includes(key)) || !confinedMapFile(spec.file))
        throw new Error('sourceMap requires path and a confined file relative to the declared resource directory.');
      const route = pathname(spec.path);
      const asset = assetsByName.get(entry.resource);
      try {
        if (!asset?.file || !/(?:java|ecma)script/i.test(asset.mime))
          throw new Error('The declared script has no local file-backed source.');
        const data = await readLocalFile(path.join(path.dirname(asset.file), spec.file), {
          root: path.dirname(asset.file),
          maxBytes: DEBUG_MAP_LIMITS.assetBytes,
        });
        if (data.length > remaining) throw new Error('Source maps exceed the aggregate debugger-map byte limit.');
        remaining -= data.length;
        const parsed = JSON.parse(data.toString('utf8'));
        if (
          parsed.version !== 3 ||
          !Array.isArray(parsed.sources) ||
          !parsed.sources.length ||
          parsed.sources.length > 10000 ||
          typeof parsed.mappings !== 'string' ||
          !/^[A-Za-z0-9+/;,]*$/.test(parsed.mappings) ||
          parsed.sections !== undefined ||
          !Array.isArray(parsed.names) ||
          parsed.names.some((name) => typeof name !== 'string') ||
          !validMapSegments(parsed) ||
          (parsed.sourceRoot !== undefined && parsed.sourceRoot !== '') ||
          parsed.sources.some((source) => !confinedMapFile(source)) ||
          (parsed.sourcesContent !== undefined &&
            (!Array.isArray(parsed.sourcesContent) ||
              parsed.sourcesContent.length !== parsed.sources.length ||
              parsed.sourcesContent.some((source) => source !== null && typeof source !== 'string')))
        )
          throw new Error(
            'Source map must be a version 3 map with confined relative sources and no remote source root.',
          );
        mapping.sourceMap = { path: route, data };
      } catch (error) {
        mapping.sourceMapDiagnostic = {
          code: 'MODEL_SOURCE_MAP_INVALID',
          name: entry.resource,
          message: `Debugger sidecar unavailable: ${error.code ?? error.message}. The compiled script remains overlaid.`,
        };
      }
    }
    mappings.push(mapping);
  }
  return mappings;
}

export async function importModelDrivenProject(project) {
  const scan = await scanSolutionSources(project.solutionRoots, { order: project.solutionOrder });
  const imported = await importModelDrivenResources(scan.layers, { clientSources: project.modelDriven?.clientSources });
  // The same tables, columns, forms, views and apps Mirage builds its model-driven apps from (one scan, read once).
  const metadata = await importSolutionMetadata(project.solutionRoots, { scan, lcid: project.lcid ?? 1033 });
  const apps = solutionApps(scan, { lcid: project.lcid ?? 1033 });
  // Inventory components (canvas apps, connectors, dashboards...) are listed with counts; they are never overlaid or counted as coverage.
  return {
    ...imported,
    layers: scan.layers,
    metadata,
    apps,
    diagnostics: [
      ...scan.diagnostics,
      ...imported.diagnostics,
      ...metadata.diagnostics.map((item) => ({ code: item.code, message: item.message, source: item.file })),
    ],
    inventory: scan.inventory ?? [],
    inventoryCounts: inventoryCounts(scan.inventory),
  };
}

/** `{ component: { level: count } }` for Solution inventory records. */
export function inventoryCounts(records = []) {
  const counts = {};
  for (const record of records) {
    const row = (counts[record.component] ??= {});
    row[record.level] = (row[record.level] ?? 0) + 1;
  }
  return counts;
}

const DEBUG_MAP_LIMITS = { assetBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };

// Conservative upper bound for the inline JSON source and line map, including
// JSON escaping, UTF-8, base64 and the directive. Estimate before allocating a
// map: a newline-heavy source otherwise grows many times larger than its input.
function debugMapEstimate(text, file) {
  let bytes = 2,
    lines = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13 || (code === 10 && text.charCodeAt(i - 1) !== 13) || code === 0x2028 || code === 0x2029) lines++;
    if (code < 32) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    else if (code === 34 || code === 92) bytes += 2;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  const fileBytes = Buffer.byteLength(JSON.stringify(pathToFileURL(file).href));
  return 128 + Math.ceil((bytes + lines * 5 + fileBytes + 256) / 3) * 4;
}

/** Exact declared assets only. No response fetch, native request replay or API interception. */
export function createModelDrivenOverlay({
  origin,
  imported,
  mappings = [],
  ownsRequest = () => true,
  onApplied = () => {},
  sourceMapLimits = {},
}) {
  origin = modelDrivenOrigin(origin);
  const mapLimits = { ...DEBUG_MAP_LIMITS };
  for (const [key, value] of Object.entries(sourceMapLimits)) {
    if (!Object.hasOwn(mapLimits, key) || !Number.isSafeInteger(value) || value < 1 || value > DEBUG_MAP_LIMITS[key])
      throw new Error(`Invalid model-driven debugger map limit ${key}.`);
    mapLimits[key] = value;
  }
  let routes,
    resources,
    pathsByResource,
    diagnostics,
    revision = 0,
    applied = 0,
    currentRevisionApplied = 0;
  let online = false;
  const paused = new Set();
  let scope = 'all',
    editedSources = new Set();
  const nativeReads = new Map();
  const hits = new Map(),
    currentHits = new Map(),
    unmatched = new Map();
  function replace(next, nextMappings = mappings) {
    // Prepare debugger mappings once per revision, rather than copying a bundle
    // and building an inline map on every intercepted request.
    let remainingMapBytes = mapLimits.totalBytes;
    const nextDiagnostics = [...next.diagnostics];
    const explicitSidecars = new Set(
      nextMappings.filter((mapping) => mapping.sourceMap).map((mapping) => mapping.resource),
    );
    const assets = new Map(
      [...next.assets.values()].map((asset) => {
        if (!asset.file || !/(?:java|ecma)script/i.test(asset.mime)) return [asset.name, asset];
        const text = asset.data.toString('utf8');
        if (hasSourceMap(text) || explicitSidecars.has(asset.name)) return [asset.name, asset];
        const estimate = debugMapEstimate(text, asset.file);
        if (asset.data.length + estimate > mapLimits.assetBytes || estimate > remainingMapBytes) {
          nextDiagnostics.push({
            code: 'MODEL_SOURCE_MAP_LIMIT',
            name: asset.name,
            message:
              'Local debugger map omitted because it exceeds the bounded asset or session map budget. The original script is still overlaid.',
          });
          return [asset.name, asset];
        }
        const data = withFileSourceMap(asset.data, asset.file);
        remainingMapBytes -= data.length - asset.data.length;
        return [asset.name, { ...asset, data }];
      }),
    );
    const nextRoutes = new Map(),
      nextPaths = new Map([...assets.keys()].map((name) => [name, new Set()]));
    const add = (key, name) => {
      const asset = assets.get(name);
      if (!asset) throw new Error(`Resource map selects an undeclared Solution resource: ${name}`);
      key = pathname(key);
      if (nextRoutes.has(key) && nextRoutes.get(key).name !== name)
        throw new Error(`Multiple Solution resources map to ${key}.`);
      nextRoutes.set(key, asset);
      nextPaths.get(name).add(key);
    };
    for (const resource of next.resources) add(`/WebResources/${resource.name}`, resource.name);
    for (const mapping of nextMappings) add(mapping.path, mapping.resource);
    const sidecarScripts = new Set();
    for (const mapping of nextMappings) {
      if (mapping.sourceMapDiagnostic) nextDiagnostics.push(mapping.sourceMapDiagnostic);
      if (!mapping.sourceMap) continue;
      if (sidecarScripts.has(mapping.resource)) throw new Error('A script can declare only one source-map sidecar.');
      sidecarScripts.add(mapping.resource);
      const asset = assets.get(mapping.resource),
        mapPath = pathname(mapping.sourceMap.path);
      if (nextRoutes.has(mapPath))
        throw new Error(`Debugger sidecar conflicts with a declared resource at ${mapPath}.`);
      const text = asset.data.toString('utf8');
      if (/sourceMappingURL=data:/i.test(text)) {
        nextDiagnostics.push({
          code: 'MODEL_SOURCE_MAP_INLINE_PRESERVED',
          name: asset.name,
          message: 'The existing inline source map is preserved; the sidecar mapping is unused.',
        });
        continue;
      }
      if (mapping.sourceMap.data.length > remainingMapBytes || mapping.sourceMap.data.length > mapLimits.assetBytes) {
        nextDiagnostics.push({
          code: 'MODEL_SOURCE_MAP_LIMIT',
          name: asset.name,
          message:
            'Debugger sidecar omitted because it exceeds the session map budget. The compiled script remains overlaid.',
        });
        continue;
      }
      remainingMapBytes -= mapping.sourceMap.data.length;
      // Debuggers use the final directive. Preserve every executable byte,
      // including string/regex literals that merely resemble map comments.
      const data = Buffer.concat([asset.data, Buffer.from(`\n//# sourceMappingURL=${mapPath}\n`)]);
      const rewritten = { ...asset, data };
      assets.set(asset.name, rewritten);
      for (const [key, value] of nextRoutes) if (value === asset) nextRoutes.set(key, rewritten);
      nextRoutes.set(mapPath, {
        name: asset.name,
        data: mapping.sourceMap.data,
        mime: 'application/json; charset=utf-8',
        debuggerMap: true,
      });
    }
    // Publish only a complete import. An invalid save cannot partially replace routes.
    routes = nextRoutes;
    resources = assets;
    pathsByResource = nextPaths;
    diagnostics = nextDiagnostics;
    mappings = nextMappings;
    for (const name of hits.keys()) if (!resources.has(name)) hits.delete(name);
    for (const name of paused) if (!resources.has(name)) paused.delete(name);
    currentHits.clear();
    unmatched.clear();
    currentRevisionApplied = 0;
    revision++;
  }
  replace(imported);
  return {
    replace,
    nativeRead(name) {
      const paths = pathsByResource.get(name);
      if (!paths?.size || !/(?:javascript|ecmascript|text\/css)/i.test(resources.get(name)?.mime ?? ''))
        throw new Error('Select a declared text resource.');
      if (nativeReads.size >= 2) throw new Error('Two native comparisons are already in progress.');
      const token = randomUUID(),
        entry = { name, expires: Date.now() + 15000 };
      nativeReads.set(token, entry);
      return {
        path: [...paths].at(-1),
        token,
        release() {
          nativeReads.delete(token);
        },
      };
    },
    isTextResource(name) {
      return /(?:javascript|ecmascript|text\/css)/i.test(resources.get(name)?.mime ?? '');
    },
    resourceForUrl(value) {
      try {
        const url = new URL(value);
        return url.origin === origin ? (routes.get(pathname(url.pathname))?.name ?? null) : null;
      } catch {
        return null;
      }
    },
    async handle(route) {
      const request = route.request(),
        url = new URL(request.url());
      const headers = request.headers?.() ?? {},
        nativeToken = headers['x-paqvilo-native-comparison'];
      let fallbackOptions;
      if (url.origin === origin && ownsRequest(request) && nativeToken !== undefined) {
        const forwarded = { ...headers };
        delete forwarded['x-paqvilo-native-comparison'];
        if (typeof route.removeRequestHeader === 'function') route.removeRequestHeader('x-paqvilo-native-comparison');
        else fallbackOptions = { headers: forwarded };
      }
      const fallback = () => route.fallback(fallbackOptions);
      if (
        url.origin !== origin ||
        !['GET', 'HEAD'].includes(request.method()) ||
        request.isNavigationRequest?.() ||
        request.resourceType?.() === 'document' ||
        !ownsRequest(request)
      ) {
        await fallback();
        return;
      }
      let key;
      try {
        key = pathname(url.pathname);
      } catch {
        await fallback();
        return;
      }
      const asset = routes.get(key);
      if (!asset) {
        if (
          (/^\/WebResources\//.test(key) || ['script', 'stylesheet'].includes(request.resourceType?.())) &&
          (unmatched.has(key) || unmatched.size < 256)
        )
          unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
        await fallback();
        return;
      }
      const nativeRead = nativeReads.get(nativeToken);
      if (
        nativeRead &&
        nativeRead.name === asset.name &&
        nativeRead.expires > Date.now() &&
        request.method() === 'GET'
      ) {
        nativeReads.delete(nativeToken);
        await fallback();
        return;
      }
      if (online || paused.has(asset.name) || (scope === 'changed' && !editedSources.has(asset.name))) {
        await fallback();
        return;
      }
      const appliedRevision = revision;
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': asset.mime,
          'cache-control': 'no-store',
          'x-paqvilo-source': 'local-solution',
          'x-content-type-options': 'nosniff',
        },
        body: request.method() === 'HEAD' ? Buffer.alloc(0) : asset.data,
      });
      if (asset.debuggerMap) return;
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
    setOnline(value) {
      if (typeof value !== 'boolean') throw new Error('Online mode must be boolean.');
      online = value;
    },
    setScope(value, names = []) {
      if (!['all', 'changed'].includes(value) || [...names].some((name) => !resources.has(name)))
        throw new Error('Select a valid scope and declared resource names.');
      scope = value;
      editedSources = new Set(names);
    },
    pause(name, value) {
      if (!resources.has(name) || typeof value !== 'boolean')
        throw new Error('Select a declared resource and boolean pause state.');
      if (value) paused.add(name);
      else paused.delete(name);
    },
    report() {
      return {
        schemaVersion: 1,
        kind: 'model-driven-overlay',
        origin,
        revision,
        online,
        diagnostics,
        debuggerMaps: [...routes]
          .filter(([, asset]) => asset.debuggerMap)
          .map(([path, asset]) => ({ path, resource: asset.name })),
        resources: [...resources.keys()].map((name) => ({
          name,
          mime: resources.get(name).mime,
          paths: [...pathsByResource.get(name)],
          applied: hits.get(name) ?? 0,
          currentRevisionApplied: currentHits.get(name) ?? 0,
          paused: paused.has(name),
        })),
        applied,
        currentRevisionApplied,
        unmatched: [...unmatched].map(([path, count]) => ({ path, count })),
        unmatchedLimit: 256,
        // Native PCF URLs vary by environment and version. Bind observed exact paths;
        // never infer a bundle mapping from an arbitrary script filename.
        unbound: [...resources.keys()].filter((name) => !pathsByResource.get(name).size),
        writesFiles: [],
      };
    },
  };
}
