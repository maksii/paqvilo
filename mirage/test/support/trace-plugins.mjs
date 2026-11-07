// Shared setup of the trace-plugins and trace-plugins-context suites: an organization runtime over the invented x_item and
// x_note tables, and a store holding the invented fx_Ping custom API (string input Message, string output Reply). Each
// suite registers its own steps, handlers and assertions. Invented schemas only.
import { DataStore, emptyState } from '../../lib/data.mjs';
import { dataverseSettings } from '../../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../../lib/dataverse-organization.mjs';
import { EXTENSIONS } from '../../lib/dataverse-extensions.mjs';
import { parseCustomApiFiles } from '../../lib/dataverse-customapi.mjs';
import { createTraceStore } from '../../lib/trace-store.mjs';

// An initialized store whose x_item and x_note tables are empty (mapping(logical) gives each mapping), with its organization
// runtime on every built-in extension, closed after t.
export async function itemNoteOrganization(t, mapping) {
  const state = emptyState();
  state.mappings.x_item = mapping('x_item');
  state.mappings.x_note = mapping('x_note');
  state.tables.x_item = [];
  state.tables.x_note = [];
  const store = await new DataStore({ state }).init();
  const runtime = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({ enabled: true }),
    extensions: [...EXTENSIONS],
  });
  t.after(() => runtime.close());
  return store;
}

// A store with only the fx_Ping custom API rows, parsed from its solution files, traced at level full.
export function pingApiStore() {
  const el = (name, value = '') => `<${name}>${value}</${name}>`;
  const label = (name, text) =>
    `<${name} default="${text}"><label description="${text}" languagecode="1033" /></${name}>`;
  const files = [
    {
      path: 'fx_Ping/customapi.xml',
      text: `<customapi uniquename="fx_Ping">${el('bindingtype', 0)}${el('boundentitylogicalname')}${label('displayname', 'fx_Ping')}${el('executeprivilegename')}${el('isfunction', 0)}${el('isprivate', 0)}${el('name', 'fx_Ping')}</customapi>`,
    },
    {
      path: 'fx_Ping/customapirequestparameters/Message/customapirequestparameter.xml',
      text: `<customapirequestparameter uniquename="Message">${label('displayname', 'Message')}${el('isoptional', 0)}${el('logicalentityname')}${el('name', 'fx_Ping.Message')}${el('type', 10)}</customapirequestparameter>`,
    },
    {
      path: 'fx_Ping/customapiresponseproperties/Reply/customapiresponseproperty.xml',
      text: `<customapiresponseproperty uniquename="Reply">${label('displayname', 'Reply')}${el('logicalentityname')}${el('name', 'fx_Ping.Reply')}${el('type', 10)}</customapiresponseproperty>`,
    },
  ];
  const state = emptyState();
  const rows = parseCustomApiFiles(files);
  for (const logical of ['customapi', 'customapirequestparameter', 'customapiresponseproperty'])
    state.tables[logical] = rows[logical];
  const store = new DataStore({ state });
  store.traces = createTraceStore({ settings: { level: 'full' } });
  return store;
}
