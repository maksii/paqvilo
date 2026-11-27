// Extensions installed into the Dataverse API when it starts. An entry is { name, install(api), reset?(api), describe?(api) }:
// install runs once per API before the first request, reset runs on every reseed before security is re-seeded.
// reset must use api.store directly: reseed runs inside the server's change queue, where api.change would wait on itself.
// startDataverseApi({ extensions }) defaults to this list. dataverse-customapi is not listed: server.mjs passes its own
// customApiExtension (the Solution's customapis rows), and installing the module here as well would register each operation twice.
import {
  install as installStandard,
  reset as resetStandard,
  describe as describeStandard,
} from './dataverse-standard.mjs';
import { install as installFiles, reset as resetFiles, describe as describeFiles } from './dataverse-files.mjs';
import {
  install as installPredefined,
  reset as resetPredefined,
  describe as describePredefined,
} from './dataverse-predefined.mjs';
import { install as installAudit, reset as resetAudit, describe as describeAudit } from './dataverse-audit.mjs';
import {
  install as installMetadataTables,
  reset as resetMetadataTables,
  describe as describeMetadataTables,
} from './dataverse-metadata-tables.mjs';
import { install as installElastic, close as closeElastic, describe as describeElastic } from './dataverse-elastic.mjs';
import {
  metadataWriteOperations,
  metadataWriteRoutes,
  describe as describeMetadataRelationships,
} from './dataverse-metadata-relationships.mjs';
import {
  install as installDuplicates,
  reset as resetDuplicates,
  describe as describeDuplicates,
} from './dataverse-duplicates.mjs';
import { fieldSecurity } from './dataverse-fls.mjs';
import { EXTENSION as recordMessages } from './dataverse-record-messages.mjs';
import {
  install as installAsync,
  reset as resetAsync,
  close as closeAsync,
  describe as describeAsync,
} from './dataverse-async.mjs';
import {
  install as installSolutions,
  reset as resetSolutions,
  describe as describeSolutions,
} from './dataverse-solutions.mjs';
import {
  install as installSecurityMessages,
  reset as resetSecurityMessages,
  describe as describeSecurityMessages,
} from './dataverse-security-messages.mjs';
import {
  install as installSecurityMessages2,
  describe as describeSecurityMessages2,
} from './dataverse-security-messages2.mjs';
import {
  install as installCustomizationMessages,
  describe as describeCustomizationMessages,
} from './dataverse-customization-messages.mjs';
import { EXTENSION as activityPointer } from './dataverse-activitypointer.mjs';
import { EXTENSION as search } from './dataverse-search.mjs';
import { EXTENSION as activityMessages } from './dataverse-activity-messages.mjs';
import { EXTENSION as orgMessages } from './dataverse-org-messages.mjs';
import { EXTENSION as metadataMessages } from './dataverse-metadata-messages.mjs';
import { EXTENSION as calendarMessages } from './dataverse-calendar-messages.mjs';
import { EXTENSION as appMessages } from './dataverse-app-messages.mjs';
import { EXTENSION as pluginRegistration } from './dataverse-plugin-registration.mjs';
import { EXTENSION as dataMessages } from './dataverse-data-messages.mjs';
import { EXTENSION as miscMessages } from './dataverse-misc-messages.mjs';
import { EXTENSION as addonWorkqueues } from './dataverse-addon-workqueues.mjs';
import { EXTENSION as addonD365 } from './dataverse-addon-d365.mjs';
import { EXTENSION as addonAi } from './dataverse-addon-ai.mjs';
import { EXTENSION as addonGit } from './dataverse-addon-git.mjs';
import { EXTENSION as addonFeatureControl } from './dataverse-addon-featurecontrol.mjs';
import { EXTENSION as addonFlows } from './dataverse-addon-flows.mjs';
import { EXTENSION as addonPva } from './dataverse-addon-pva.mjs';
import { EXTENSION as hierarchy } from './dataverse-hierarchy.mjs';
import { EXTENSION as sharepointDocuments } from './sharepoint-documents.mjs';
import { EXTENSION as sharepointDocumentTable } from './sharepoint-document-table.mjs';
import { EXTENSION as storageRouting } from './dataverse-storage-routing.mjs';
import { EXTENSION as calculated } from './dataverse-calculated.mjs';
import { EXTENSION as formula } from './dataverse-formula.mjs';
import { EXTENSION as rollup } from './dataverse-rollup.mjs';
import { EXTENSION as businessRules } from './dataverse-business-rules.mjs';
import { EXTENSION as currency } from './dataverse-currency.mjs';
import { EXTENSION as virtualProviders } from './dataverse-virtual-providers.mjs';
import { EXTENSION as stateTransitions } from './dataverse-state-transitions.mjs';
import { EXTENSION as cascade } from './dataverse-cascade.mjs';
import { EXTENSION as bpf } from './dataverse-bpf.mjs';
import { USER_SETTINGS_EXTENSION } from './staff-session.mjs';
import { addonLevel } from './dataverse-addon-common.mjs';

const metadataRelationships = {
  name: 'dataverse-metadata-relationships',
  install(api) {
    for (const route of metadataWriteRoutes(api)) api.addRoute(route.match, route.handle);
    for (const op of metadataWriteOperations(api)) api.registry.register(op);
  },
  describe: describeMetadataRelationships,
};

// Per API: entry name -> the operation names its install registered (a diff of api.registry.names()).
const registered = new WeakMap();

// An entry with describe(api) gets the operations its install registered added to its record: each at the record level
// unless the record lists it (operations or operationLevels). An add-on message a pack answers is at contract, and one that
// only answers its default error at inventory, whatever the module states (addonLevel).
function withOperations(entry) {
  if (!entry.describe) return entry;
  const remember = (api, before) => {
    if (!registered.has(api)) registered.set(api, new Map());
    registered.get(api).set(
      entry.name,
      api.registry.names().filter((name) => !before.has(name)),
    );
  };
  return {
    ...entry,
    install(api, ...rest) {
      const before = new Set(api.registry.names());
      const result = entry.install(api, ...rest);
      if (typeof result?.then !== 'function') {
        remember(api, before);
        return result;
      }
      return result.then((value) => {
        remember(api, before);
        return value;
      });
    },
    describe(api) {
      const record = entry.describe(api);
      const names = (api && registered.get(api)?.get(entry.name)) ?? [];
      const operations = new Map(
        (record.operations ?? []).map((op) => (typeof op === 'string' ? [op, { name: op }] : [op.name, op])),
      );
      for (const name of names) if (!operations.has(name)) operations.set(name, { name });
      if (!operations.size) return record;
      const operationLevels = { ...record.operationLevels };
      for (const [name, op] of operations) {
        const fixed = addonLevel(api, name);
        if (!fixed) continue;
        operations.set(name, { ...op, ...fixed });
        delete operationLevels[name];
      }
      return { ...record, operations: [...operations.values()], operationLevels };
    },
  };
}

export const EXTENSIONS = [
  // First: the standard tables exist before the predefined and audit modules run, and the re-seed gives them privileges.
  { name: 'dataverse-standard', install: installStandard, reset: resetStandard, describe: describeStandard },
  // After the standard tables and their relationships: hierarchical tables are read from the seeded metadata.
  hierarchy,
  activityPointer,
  { name: 'dataverse-files', install: installFiles, reset: resetFiles, describe: describeFiles },
  // Directly after the files module: file, image, note and attachment bytes move to the host storage routes (api.providers.storage).
  storageRouting,
  // Document locations keep their bytes in the storage provider the files module routes.
  sharepointDocuments,
  // The sharepointdocument rows of those locations (reads only).
  sharepointDocumentTable,
  { name: 'dataverse-predefined', install: installPredefined, reset: resetPredefined, describe: describePredefined },
  { name: 'dataverse-audit', install: installAudit, reset: resetAudit, describe: describeAudit },
  {
    name: 'dataverse-metadata-tables',
    install: installMetadataTables,
    reset: resetMetadataTables,
    describe: describeMetadataTables,
  },
  { name: 'dataverse-elastic', install: installElastic, close: closeElastic, describe: describeElastic },
  metadataRelationships,
  // Contract modules that compute column values run before duplicate detection and field security read the row:
  // calculated first, then formula and rollup columns over it, business rules and the currency of money values.
  calculated,
  formula,
  rollup,
  businessRules,
  currency,
  { name: 'dataverse-duplicates', install: installDuplicates, reset: resetDuplicates, describe: describeDuplicates },
  fieldSecurity,
  recordMessages,
  // Directly after record messages: it reuses their IsValidStateTransition registration.
  stateTransitions,
  { name: 'dataverse-async', install: installAsync, reset: resetAsync, close: closeAsync, describe: describeAsync },
  // After async: ImportSolutionAsync writes its asyncoperation rows into the table async seeds.
  { name: 'dataverse-solutions', install: installSolutions, reset: resetSolutions, describe: describeSolutions },
  {
    name: 'dataverse-security-messages',
    install: installSecurityMessages,
    reset: resetSecurityMessages,
    describe: describeSecurityMessages,
  },
  { name: 'dataverse-security-messages2', install: installSecurityMessages2, describe: describeSecurityMessages2 },
  {
    name: 'dataverse-customization-messages',
    install: installCustomizationMessages,
    describe: describeCustomizationMessages,
  },
  search,
  metadataMessages,
  orgMessages,
  activityMessages,
  miscMessages,
  calendarMessages,
  appMessages,
  // After the files and async modules: the recycle bin hook and the import jobs use their store and systemJob.
  dataMessages,
  addonWorkqueues,
  addonD365,
  addonAi,
  addonGit,
  addonFeatureControl,
  addonFlows,
  addonPva,
  cascade,
  bpf,
  USER_SETTINGS_EXTENSION,
  // The last beforeWrite: its check runs after every refusal of the other hooks; the provider's write itself runs in the
  // records 'external' stage after the store write passed every check (module header).
  virtualProviders,
  // Last: the registry holds every operation, so the sdkmessage rows cover them. The Solution's rows come from server.mjs.
  pluginRegistration,
].map(withOperations);
