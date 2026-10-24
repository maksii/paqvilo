import { EXTENSIONS } from './dataverse-extensions.mjs';
import {
  install as installCustomApis,
  describeCustomApis,
  parseCustomApiFiles,
  parseFxExpressionFiles,
} from './dataverse-customapi.mjs';
import { parseDuplicateRuleXml } from './dataverse-duplicates.mjs';
import { solutionLayerFiles } from './solution-content-fingerprint.mjs';
import { readSolutionWorkflows, workflowExtension } from './dataverse-workflows.mjs';
import { solutionPluginExtension } from './dataverse-plugin-registration.mjs';
import { addonHandlerExtension } from './dataverse-addon-common.mjs';
import { isDeepStrictEqual } from 'node:util';
import { parseSolutionXml, descendants, child, childText } from './solution-xml.mjs';
import { uuidV5 } from './dataverse-security.mjs';

// Source-owned row ids per table (state.dataverse.sourceSeeded): what the last seed wrote, so a later seed removes the rows
// whose source definition is gone. It lives in state, so a rolled-back transaction restores it with the rows.
const seededOf = (store) => ((store.state.dataverse ??= {}).sourceSeeded ??= {});
const idKey = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

/**
 * Read-only Solution/trusted-pack composition shared by every runtime host. layers and plugins are values or getters over the
 * current sources. The returned extension list carries refresh(): it re-reads the layers and re-registers custom APIs,
 * duplicate rules, classic workflow definitions and activations and plug-in registrations from the current sources in one
 * store transaction (additions, changes and deletions), then reports SOURCE_EXTENSIONS_REFRESHED with the changes.
 */
export async function sourceOrganizationExtensions({
  layers = [],
  plugins,
  customApis = new Map(),
  pluginHandlers = new Map(),
  workflowHandlers = new Map(),
  workflowOverrides = () => ({}),
  cloudFlow,
  diagnostic = () => {},
  addonHandlers = new Map(),
  timeoutMs = () => 120000,
  base = EXTENSIONS,
} = {}) {
  const layersOf = () => (typeof layers === 'function' ? layers() : layers) ?? [];
  const pluginsOf = () => (typeof plugins === 'function' ? plugins() : plugins);
  // Files of one top-level folder of each distinct layer, from a directory or a Solution ZIP (solutionLayerFiles).
  const folderFiles = (layers, folder) =>
    [...new Map(layers.filter((layer) => layer?.dir).map((layer) => [layer.dir, layer])).values()].map((layer) => {
      try {
        return solutionLayerFiles(layer, folder);
      } catch (error) {
        diagnostic({ code: 'SOLUTION_LAYER_COMPONENTS_UNREADABLE', source: layer.dir, message: error.message });
        return [];
      }
    });
  const text = (file) => file.read().toString('utf8');
  // Custom APIs of the Solution sources: a customapis folder at each layer's root (parseCustomApiFiles reads its files).
  // A customapi.xml may name an fxexpression of the fxexpressions folder (a Dataverse Function defined in the Solution).
  const relative = (files) =>
    files
      .filter((file) => /\.xml$/i.test(file.name))
      .map((file) => ({ path: file.name.slice(file.name.indexOf('/') + 1), text: text(file) }));
  const readSolutionCustomApis = (layers) => {
    const fxexpression = folderFiles(layers, /^fxexpressions$/i).flatMap(
      (files) => parseFxExpressionFiles(relative(files)).fxexpression,
    );
    const rows = { fxexpression, customapi: [], customapirequestparameter: [], customapiresponseproperty: [] };
    for (const files of folderFiles(layers, /^customapis$/i)) {
      const parsed = parseCustomApiFiles(relative(files), { fxexpressions: fxexpression });
      for (const logical of Object.keys(parsed)) rows[logical].push(...parsed[logical]);
    }
    return rows;
  };
  // Duplicate rules of the Solution sources: duplicaterules/<rule>/duplicaterule.xml at each layer's root.
  const readSolutionDuplicateRules = (layers) => {
    const rows = { duplicaterule: [], duplicaterulecondition: [] };
    for (const files of folderFiles(layers, /^duplicaterules$/i)) {
      for (const file of files.filter((item) => /^[^/]+\/[^/]+\/duplicaterule\.xml$/i.test(item.name))) {
        const parsed = parseDuplicateRuleXml(text(file));
        rows.duplicaterule.push(parsed.duplicaterule);
        rows.duplicaterulecondition.push(...parsed.duplicaterulecondition);
      }
    }
    return rows;
  };
  // Catalogs and catalog assignments of the Solution sources ("When an action is performed" lists the actions of a Catalog and a
  // Category): catalogs/<uniquename>/catalog.xml and the catalogassignments.xml file of the Assets folder
  // (https://learn.microsoft.com/power-apps/developer/data-platform/catalog-catalogassignment#create-catalog-and-catalog-assignments-by-editing-solution-files).
  // A custom API assignment's object is the customapiid of that unique name among the Solution's custom APIs.
  // Guessed: the exported file layout beyond the Learn examples (the Assets folder name's case, a catalog.xml that is the
  // root element itself or wrapped); row ids are name-derived UUIDs (uuidV5), not the exported ids.
  const readSolutionCatalogs = (layers, customapis) => {
    const rows = { catalog: [], catalogassignment: [] },
      NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
      idOf = (name) => uuidV5(NS, 'catalog:' + String(name).toLowerCase());
    const parse = (file) => {
      try {
        return parseSolutionXml(text(file), { recover: true });
      } catch (error) {
        diagnostic({ code: 'SOLUTION_CATALOG_UNREADABLE', source: file.name, message: error.message });
        return null;
      }
    };
    const labelled = (node, name) => child(node, name)?.attrs.default ?? childText(node, name) ?? null;
    for (const files of folderFiles(layers, /^catalogs$/i))
      for (const file of files.filter((item) => /^[^/]+\/[^/]+\/catalog\.xml$/i.test(item.name))) {
        const root = parse(file),
          node = root?.name === 'catalog' ? root : root && descendants(root, 'catalog')[0];
        if (!node?.attrs.uniquename) continue;
        const parent = childText(child(node, 'parentcatalogid'), 'uniquename');
        rows.catalog.push({
          catalogid: idOf(node.attrs.uniquename),
          uniquename: node.attrs.uniquename,
          name: childText(node, 'name') ?? node.attrs.uniquename,
          displayname: labelled(node, 'displayname'),
          description: labelled(node, 'description'),
          parentcatalogid: parent ? idOf(parent) : null,
        });
      }
    const apiOf = (name) =>
      customapis.find((row) => String(row.uniquename).toLowerCase() === String(name ?? '').toLowerCase());
    for (const files of folderFiles(layers, /^assets$/i))
      for (const file of files.filter((item) => /^[^/]+\/catalogassignments\.xml$/i.test(item.name))) {
        const root = parse(file);
        for (const node of root
          ? root.name === 'catalogassignment'
            ? [root]
            : descendants(root, 'catalogassignment')
          : []) {
          const a = node.attrs,
            type = String(a.objectidtype ?? a.objecttypeid ?? '').toLowerCase(),
            catalog = a['catalogid.uniquename'];
          const objectName = a['object.uniquename'] ?? a['object.logicalname'] ?? a['object.workflowid'] ?? null;
          if (!catalog || !objectName) continue;
          const object =
            type === 'customapi'
              ? (apiOf(objectName)?.customapiid ?? null)
              : type === 'workflow'
                ? String(objectName).replace(/[{}]/g, '').toLowerCase()
                : null;
          rows.catalogassignment.push({
            catalogassignmentid: uuidV5(
              NS,
              'catalogassignment:' + catalog.toLowerCase() + ':' + type + ':' + String(objectName).toLowerCase(),
            ),
            catalogid: idOf(catalog),
            name: childText(node, 'name') ?? objectName,
            objectidtype: type || null,
            object,
            objectname: objectName,
          });
        }
      }
    return rows;
  };
  const read = async () => {
    const current = layersOf(),
      apis = readSolutionCustomApis(current);
    return {
      rows: { ...apis, ...readSolutionDuplicateRules(current), ...readSolutionCatalogs(current, apis.customapi) },
      facts: await readSolutionWorkflows(current, { diagnostic }),
    };
  };
  let sources = await read();

  // Writes the Solution's custom API and duplicate rule rows (insert or replace by id) and removes the rows an earlier seed
  // wrote whose definition is gone. Runs inside the caller's transaction; returns { table: { added, changed, removed } }.
  const seedRows = (api, solutionRows) => {
    const { store } = api,
      seeded = seededOf(store),
      changes = {};
    for (const [logical, rows] of Object.entries(solutionRows)) {
      // An explicitly declared normalized schema snapshot owns the entire
      // operation table, including an empty array representing deletion.
      // Source defaults must not resurrect or replace those authored rows.
      if (store.storageAdapter?.schemaRecordsAuthoritative?.(logical)) continue;
      // fxexpression is a standard table: nothing to write or remove while the Solution has none and none was seeded.
      if (!store.state.mappings[logical] && !rows.length && !seeded[logical]?.length) continue;
      store.state.tables[logical] ??= [];
      const idColumn = store.state.mappings[logical]?.idColumn ?? `${logical}id`,
        table = () => store.tableRows(logical);
      const next = new Set(rows.map((row) => idKey(row[idColumn])));
      const counts = { added: 0, changed: 0, removed: 0 };
      for (const id of seeded[logical] ?? []) {
        if (next.has(id)) continue;
        const index = table().findIndex((item) => idKey(item[idColumn]) === id);
        if (index >= 0) {
          store.removeRow(logical, table(), index);
          counts.removed += 1;
        }
      }
      for (const row of rows) {
        const index = table().findIndex((item) => idKey(item[idColumn]) === idKey(row[idColumn]));
        if (index >= 0) {
          if (isDeepStrictEqual(table()[index], row)) continue;
          store.removeRow(logical, table(), index);
          counts.changed += 1;
        } else counts.added += 1;
        store.insertRow(logical, table(), structuredClone(row));
      }
      seeded[logical] = [...next];
      changes[logical] = counts;
    }
    return changes;
  };
  // Seeds the customapi tables (dataverseOnly mappings) and the Solution's custom API and duplicate rule rows. install and reset both run it:
  // reset runs inside the change queue, so the customapi install gets a direct change instead of the queued one.
  let installedApi = null,
    syncCustomApis = () => {};
  const customApiExtension = {
    name: 'customapi',
    describe: (api) => describeCustomApis(api),
    async install(api) {
      installedApi = api;
      ({ sync: syncCustomApis } = installCustomApis(
        { ...api, change: (fn) => fn() },
        { handlers: customApis, pluginTypes: pluginHandlers, timeoutMs: timeoutMs },
      ));
      await api.store.transact(() => {
        seedRows(api, sources.rows);
      });
      syncCustomApis();
    },
    async reset(api) {
      await customApiExtension.install(api);
    },
  };
  const plugin = solutionPluginExtension(pluginsOf);
  const workflow = workflowExtension({
    facts: () => sources.facts,
    handlers: workflowHandlers,
    overrides: workflowOverrides,
    cloudFlow,
    diagnostic,
  });
  const list = [...base, customApiExtension, plugin, workflow, addonHandlerExtension(addonHandlers)];
  Object.defineProperty(list, 'refresh', {
    enumerable: false,
    /** Re-registers the source modules from the current sources; null before install. A failure leaves the previous registrations. */
    value: async () => {
      if (!installedApi) return null;
      const api = installedApi,
        next = await read();
      const changes = await api.store.transact(() => ({
        ...seedRows(api, next.rows),
        ...plugin.sync(api),
        ...workflow.sync(api, next.facts),
      }));
      sources = next;
      syncCustomApis();
      const changed = Object.fromEntries(
        Object.entries(changes).filter(([, counts]) => counts.added || counts.changed || counts.removed),
      );
      diagnostic({
        code: 'SOURCE_EXTENSIONS_REFRESHED',
        severity: 'info',
        changes: changed,
        message: Object.keys(changed).length
          ? `Re-registered Solution source modules: ${Object.entries(changed)
              .map(([table, counts]) => `${table} +${counts.added} ~${counts.changed} -${counts.removed}`)
              .join(', ')}.`
          : 'Solution source modules are unchanged.',
      });
      return changed;
    },
  });
  return list;
}
