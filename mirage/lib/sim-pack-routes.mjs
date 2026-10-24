// GET /_sim/api/packs: the registered data packs of this runtime: what each exports, its presets and personas, which
// DATA files it owns in the current simulation, its export diagnostics and whether it matches the portal. Read-only; module
// and data file paths are relative to the project root, never absolute.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack, packMatches, packModules, packDiagnostics } from './preset-registry.mjs';
import { packProvides } from './pack-exports.mjs';
import { listPresets } from './presets.mjs';

const ROUTE = /^\/(?:_sim|__sim)\/api\/packs$/;
/** The /_sim/api prefixes this router answers (status `routes`). */
export const routes = Object.freeze(['/packs']);
const SETUP_LINK = '/_setup/#packs';
// A recognised data export only: a lazy getter is never evaluated here.
const dataOf = (pack, name) => {
  const property = Object.getOwnPropertyDescriptor(pack, name);
  return property && 'value' in property ? property.value : undefined;
};
const sizeOf = (value) =>
  Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
const slash = (file) => file.split(path.sep).join('/');

/**
 * packs: the runtime's validated packs; registration: { project, dataPacks, packs } as given to discoverPacks; projectRoot;
 * state(): store.state; library(): the preset library; simulation(): the simulation report (DATA targets);
 * portal(): the imported portal (Power Pages) or null. Resolves true when it answered.
 */
export function createPackRoutes({
  packs = [],
  registration = {},
  projectRoot = process.cwd(),
  state,
  library = () => ({}),
  simulation = () => null,
  portal = () => null,
}) {
  const relative = (file) => (file ? slash(path.relative(projectRoot, file)) || '.' : null);
  // Registered modules (built-in, project, explicit) loaded again: the module cache returns the same validated pack objects,
  // so each pack finds its module, and packs the portal filtered out are listed too (matched false).
  let registered = null;
  const modules = async () =>
    (registered ??= (async () => {
      const entries = [];
      const projectModules = new Set((await packModules({ project: registration.project })).map((item) => item.module));
      // Packs supplied to the API by module path (createSimulator({ packs })) count as 'api'; supplied objects have no module.
      const supplied = (registration.packs ?? [])
        .filter((item) => typeof item === 'string' || item instanceof URL)
        .map((item) => ({
          module: /^file:/i.test(String(item)) ? fileURLToPath(String(item)) : path.resolve(String(item)),
          api: true,
        }));
      for (const entry of [
        ...(await packModules({ project: registration.project, explicit: registration.dataPacks ?? [] })),
        ...supplied,
      ]) {
        const source = entry.api ? 'api' : projectModules.has(entry.module) ? 'project' : 'explicit';
        try {
          entries.push({ pack: await loadPack(entry.module), module: entry.module, source });
        } catch (error) {
          entries.push({
            pack: null,
            module: entry.module,
            source,
            error: error.message.split(entry.module).join(relative(entry.module)),
          });
        }
      }
      return entries;
    })());

  const describe = (pack, entry, presets, targets, currentPortal) => {
    let matched = null,
      matchReason = 'no portal context';
    if (currentPortal) {
      try {
        matched = packMatches(pack, currentPortal);
        matchReason = matched ? 'matches({ portal }) returned true' : 'matches({ portal }) did not return true';
      } catch (error) {
        matched = false;
        matchReason = error.message;
      }
    }
    const exports = {};
    for (const item of packProvides([pack])) exports[item.export] = (exports[item.export] ?? 0) + 1;
    const catalog = dataOf(pack, 'personaCatalog') ?? {};
    const owned = targets.filter((target) => target.packId === pack.id);
    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      module: relative(entry?.module ?? null),
      registration: { source: entry?.source ?? 'api', setupLink: SETUP_LINK },
      matched,
      matchReason,
      exports,
      presets: presets.filter((item) => item.pack === pack.id).map(({ id, name }) => ({ id, name })),
      configurationPresets: sizeOf(dataOf(pack, 'configurationPresets')),
      personas: sizeOf(dataOf(pack, 'personas')),
      personaCatalog: Object.fromEntries(
        ['groups', 'personas', 'contexts', 'scenarios'].map((name) => [name, sizeOf(catalog[name])]),
      ),
      dataFiles: (dataOf(pack, 'dataFiles') ?? []).map((file) => {
        const target = owned.find((item) => slash(String(item.file ?? '')).endsWith(slash(file.file)));
        return {
          file: file.file,
          tables: Object.keys(file.tables ?? {}),
          writable: Boolean(target),
          ownedTables: target?.tables ?? [],
        };
      }),
      diagnostics: packDiagnostics(pack),
    };
  };

  return async (req, res, url) => {
    if (!ROUTE.test(url.pathname)) return false;
    // HEAD answers like GET without a body (node drops the body of a HEAD response).
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(body));
      return true;
    };
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(
        405,
        { error: { code: 'MethodNotAllowed', message: 'The pack inventory is read-only; use GET.' } },
        { allow: 'GET, HEAD' },
      );
    const presets = listPresets({ state: state?.() ?? {}, library: library() ?? {} });
    const targets = simulation()?.targets ?? [];
    const currentPortal = portal();
    const entries = await modules();
    const listed = new Set();
    const items = [];
    for (const pack of packs) {
      listed.add(pack);
      items.push(
        describe(
          pack,
          entries.find((entry) => entry.pack === pack),
          presets,
          targets,
          currentPortal,
        ),
      );
    }
    for (const entry of entries)
      if (entry.pack && !listed.has(entry.pack)) {
        listed.add(entry.pack);
        items.push(describe(entry.pack, entry, presets, targets, currentPortal));
      }
    const failed = entries
      .filter((entry) => !entry.pack)
      .map((entry) => ({ module: relative(entry.module), error: entry.error }));
    return send(200, {
      packs: items,
      failed,
      library: presets.map(({ id, name, pack = null, source }) => ({ id, name, pack, source })),
      setupLink: SETUP_LINK,
    });
  };
}
