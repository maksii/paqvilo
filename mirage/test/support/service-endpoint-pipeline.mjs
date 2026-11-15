// Service endpoint delivery wired as server.mjs wires it, shared by the web hook, Service Bus delivery, request context and
// trace suites: the registered-step plug-in pipeline (steps read from the registration rows on every call) with its
// asynchronous runner, and an invented widget table's store with the Dataverse API started over it. Each suite writes its
// own endpoint and step rows. Invented schemas and loopback only.
import { DataStore, emptyState } from '../../lib/data.mjs';
import { dataverseSettings } from '../../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../../lib/dataverse-extensions.mjs';
import { overlayRegisteredSteps } from '../../lib/dataverse-plugin-registration.mjs';
import { createAsyncPluginRunner } from '../../lib/plugin-async.mjs';
import {
  pluginCatalogue,
  pluginPhaseRequiresCheckpoint,
  pluginStepMatchesEntity,
  runPluginPhase,
} from '../../lib/exported-plugins.mjs';

// Sets the store's plug-in pipeline to the registered steps, delivering service endpoint steps through webhooks; diagnostic
// (optional) receives the pipeline's and the runner's diagnostics. Returns the asynchronous plug-in runner.
export function wireRegisteredSteps(store, webhooks, diagnostic) {
  const reporting = diagnostic ? { diagnostic } : {};
  const steps = () =>
    pluginCatalogue({
      plugins: overlayRegisteredSteps({ steps: [], types: [], assemblies: [] }, store),
      handlers: new Map(),
    });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items: steps(), handlers: new Map(), webhooks, ...reporting }),
    ({ entity, operation }) =>
      steps().some(
        (item) =>
          item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation,
      ),
    (context) => pluginPhaseRequiresCheckpoint(steps(), context),
  );
  return createAsyncPluginRunner({
    store,
    items: steps,
    handlers: new Map(),
    runtimes: new Map(),
    webhooks,
    ...reporting,
    systemJobs: () => true,
  });
}

// An initialized store with the empty, user-configured <prefix>_widget table (primary name <prefix>_name) and the Dataverse
// API on it (close api when done), with the ids of the Create message and its <prefix>_widget filter.
export async function widgetApi(prefix) {
  const table = `${prefix}_widget`,
    name = `${prefix}_name`;
  const state = emptyState();
  state.mappings[table] = {
    logicalName: table,
    entitySet: `${table}s`,
    idColumn: `${table}id`,
    nameColumn: name,
    userConfigured: true,
    fields: { [name]: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables[table] = [];
  const store = await new DataStore({ state }).init();
  const api = await startDataverseApi({
    store,
    settings: dataverseSettings({ enabled: true }),
    log: () => {},
    extensions: [...EXTENSIONS],
  });
  const messageId = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
  const filterId = store
    .tableRows('sdkmessagefilter')
    .find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === table).sdkmessagefilterid;
  return { store, api, messageId, filterId };
}
