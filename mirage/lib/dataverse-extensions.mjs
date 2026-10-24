// Extensions installed into the Dataverse API when it starts. An entry is { name, install(api), reset?(api) }:
// install runs once per API before the first request, reset runs on every reseed before security is re-seeded.
// reset must use api.store directly: reseed runs inside the server's change queue, where api.change would wait on itself.
// startDataverseApi({ extensions }) defaults to this list. dataverse-customapi is not listed: server.mjs passes its own
// customApiExtension (the Solution's customapis rows), and installing the module here as well would register each operation twice.
import { install as installStandard, reset as resetStandard } from './dataverse-standard.mjs';
import { install as installFiles, reset as resetFiles } from './dataverse-files.mjs';
import { install as installPredefined, reset as resetPredefined } from './dataverse-predefined.mjs';
import { install as installAudit, reset as resetAudit } from './dataverse-audit.mjs';
import { install as installMetadataTables, reset as resetMetadataTables } from './dataverse-metadata-tables.mjs';
import { install as installElastic, close as closeElastic } from './dataverse-elastic.mjs';
import { metadataWriteOperations, metadataWriteRoutes } from './dataverse-metadata-relationships.mjs';
import { install as installDuplicates, reset as resetDuplicates } from './dataverse-duplicates.mjs';
import { fieldSecurity } from './dataverse-fls.mjs';
import { EXTENSION as recordMessages } from './dataverse-record-messages.mjs';
import { install as installAsync, reset as resetAsync, close as closeAsync } from './dataverse-async.mjs';
import { install as installSolutions, reset as resetSolutions } from './dataverse-solutions.mjs';
import { install as installSecurityMessages, reset as resetSecurityMessages } from './dataverse-security-messages.mjs';
import { install as installSecurityMessages2 } from './dataverse-security-messages2.mjs';
import { install as installCustomizationMessages } from './dataverse-customization-messages.mjs';
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

const metadataRelationships = {
  name: 'dataverse-metadata-relationships',
  install(api) {
    for (const route of metadataWriteRoutes(api)) api.addRoute(route.match, route.handle);
    for (const op of metadataWriteOperations(api)) api.registry.register(op);
  },
};

export const EXTENSIONS = [
  // First: the standard tables exist before the predefined and audit modules run, and the re-seed gives them privileges.
  { name: 'dataverse-standard', install: installStandard, reset: resetStandard },
  // After the standard tables and their relationships: hierarchical tables are read from the seeded metadata.
  hierarchy,
  activityPointer,
  { name: 'dataverse-files', install: installFiles, reset: resetFiles },
  // Directly after the files module: file, image, note and attachment bytes move to the host storage routes (api.providers.storage).
  storageRouting,
  // Document locations keep their bytes in the storage provider the files module routes.
  sharepointDocuments,
  { name: 'dataverse-predefined', install: installPredefined, reset: resetPredefined },
  { name: 'dataverse-audit', install: installAudit, reset: resetAudit },
  { name: 'dataverse-metadata-tables', install: installMetadataTables, reset: resetMetadataTables },
  { name: 'dataverse-elastic', install: installElastic, close: closeElastic },
  metadataRelationships,
  // Contract modules that compute column values run before duplicate detection and field security read the row:
  // calculated first, then formula and rollup columns over it, business rules and the currency of money values.
  calculated,
  formula,
  rollup,
  businessRules,
  currency,
  { name: 'dataverse-duplicates', install: installDuplicates, reset: resetDuplicates },
  fieldSecurity,
  recordMessages,
  // Directly after record messages: it reuses their IsValidStateTransition registration.
  stateTransitions,
  { name: 'dataverse-async', install: installAsync, reset: resetAsync, close: closeAsync },
  // After async: ImportSolutionAsync writes its asyncoperation rows into the table async seeds.
  { name: 'dataverse-solutions', install: installSolutions, reset: resetSolutions },
  { name: 'dataverse-security-messages', install: installSecurityMessages, reset: resetSecurityMessages },
  { name: 'dataverse-security-messages2', install: installSecurityMessages2 },
  { name: 'dataverse-customization-messages', install: installCustomizationMessages },
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
];
