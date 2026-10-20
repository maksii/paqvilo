import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTENSIONS } from './dataverse-extensions.mjs';
import { install as installCustomApis, readCustomApiSolution } from './dataverse-customapi.mjs';
import { readDuplicateRuleSolution } from './dataverse-duplicates.mjs';
import { readSolutionWorkflows, workflowExtension } from './dataverse-workflows.mjs';
import { solutionPluginExtension } from './dataverse-plugin-registration.mjs';
import { addonHandlerExtension } from './dataverse-addon-common.mjs';

/** Read-only Solution/trusted-pack composition shared by every runtime host. */
export async function sourceOrganizationExtensions({ layers = [], plugins, customApis = new Map(), pluginHandlers = new Map(), workflowHandlers = new Map(),
  workflowOverrides = () => ({}), cloudFlow, diagnostic = () => {}, addonHandlers = new Map(), timeoutMs = () => 120000, base = EXTENSIONS } = {}) {
  // Custom APIs of the Solution sources: a customapis folder at each layer's root (dataverse-customapi.mjs reads it).
  const readSolutionCustomApis = async (layers) => {
    const rows = { customapi: [], customapirequestparameter: [], customapiresponseproperty: [] };
    for (const dir of new Set(layers.map((layer) => layer.dir).filter(Boolean))) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const folder = entries.find((entry) => entry.isDirectory() && /^customapis$/i.test(entry.name));
      if (!folder) continue;
      const parsed = await readCustomApiSolution(path.join(dir, folder.name));
      for (const logical of Object.keys(rows)) rows[logical].push(...parsed[logical]);
    }
    return rows;
  };
  // Duplicate rules of the Solution sources: a duplicaterules folder at each layer's root (dataverse-duplicates.mjs reads it).
  const readSolutionDuplicateRules = async (layers) => {
    const rows = { duplicaterule: [], duplicaterulecondition: [] };
    for (const dir of new Set(layers.map((layer) => layer.dir).filter(Boolean))) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const folder = entries.find((entry) => entry.isDirectory() && /^duplicaterules$/i.test(entry.name));
      if (!folder) continue;
      const parsed = await readDuplicateRuleSolution(path.join(dir, folder.name));
      for (const logical of Object.keys(rows)) rows[logical].push(...parsed[logical]);
    }
    return rows;
  };
  // Seeds the customapi tables (dataverseOnly mappings) and the Solution's custom API and duplicate rule rows. install and reset both run it:
  // reset runs inside the change queue, so the customapi install gets a direct change instead of the queued one.
  const customApiExtension = (solutionRows) => {
    const seed = async (api) => {
      const { sync } = installCustomApis({ ...api, change: (fn) => fn() }, { handlers: customApis, pluginTypes: pluginHandlers, timeoutMs: timeoutMs });
      await api.store.transact(() => {
        for (const [logical, rows] of Object.entries(solutionRows)) {
          // An explicitly declared normalized schema snapshot owns the entire
          // operation table, including an empty array representing deletion.
          // Source defaults must not resurrect or replace those authored rows.
          if (api.store.storageAdapter?.schemaRecordsAuthoritative?.(logical)) continue;
          for (const row of rows) {
            const table = () => api.store.tableRows(logical);
            const idColumn = api.store.state.mappings[logical].idColumn;
            const index = table().findIndex((item) => String(item[idColumn]).toLowerCase() === String(row[idColumn]).toLowerCase());
            if (index >= 0) api.store.removeRow(logical, table(), index);
            api.store.insertRow(logical, table(), structuredClone(row));
          }
        }
      });
      sync();
    };
    return { name: "customapi", install: seed, reset: seed };
  };
  const solutionRows = { ...await readSolutionCustomApis(layers), ...await readSolutionDuplicateRules(layers) };
  const facts = await readSolutionWorkflows(layers);
  return [...base, customApiExtension(solutionRows), solutionPluginExtension(plugins),
    workflowExtension({ facts, handlers: workflowHandlers, overrides: workflowOverrides, cloudFlow, diagnostic }), addonHandlerExtension(addonHandlers)];
}
