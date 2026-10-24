import fs from 'node:fs';
import { pluginSteps } from './dataverse-plugins.mjs';
const tables = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const mappings = {
  account: { entitySet: 'accounts', inferred: true, idColumn: 'accountid' },
  contact: { entitySet: 'contacts', inferred: true, idColumn: 'contactid' },
  annotation: { entitySet: 'annotations', inferred: true, idColumn: 'annotationid' },
  transactioncurrency: { entitySet: 'transactioncurrencies', inferred: true, idColumn: 'transactioncurrencyid' },
};
// Permissions are imported from the portal. Only this contact receives the editor role.
const permissions = [];
const personaRoles = [{ contactId: tables.contact[0].contactid, roles: ['Workspace Editors'] }];
// Explicit local model of Dataverse's contact display-name calculation.
const plugins = [
  {
    id: 'demo-contact-name',
    entity: 'contact',
    operations: ['create', 'update'],
    set: { fullname: { op: 'concat', args: ['$record.firstname', ' ', '$record.lastname'] } },
  },
];
// Local simulation configuration; never part of the deployable portal export.
const entraSettings = {
  'Authentication/Registration/ExternalLoginEnabled': 'True',
  'Authentication/Registration/AzureADLoginEnabled': 'True',
  'Authentication/OpenIdConnect/AzureAD/Caption': 'Demo Microsoft Entra',
  'Authentication/OpenIdConnect/AzureAD/ClientId': 'paqvilo-demo-local',
  'Authentication/OpenIdConnect/AzureAD/ExternalLogoutEnabled': 'True',
};
export default {
  id: 'example',
  name: 'Paqvilo demo',
  description: 'Invented accounts, related contacts and attachments',
  matches: ({ portal }) => portal?.website?.name === 'Paqvilo demo',
  presets: () => ({
    'example-demo': {
      name: 'Populated account workspace',
      description: '12 accounts, 24 contacts and two notes; editor and reader access',
      mappings,
      tables,
      permissions,
      plugins,
      personaRoles,
      permissionSource: 'exported',
      settings: { permissionMode: 'enforce' },
    },
    'example-empty': {
      name: 'Empty account workspace',
      description: 'No accounts or notes; editor and reader remain available for local sign-in',
      mappings,
      tables: {
        ...tables,
        account: [],
        annotation: [],
        contact: tables.contact.slice(0, 2).map(({ parentcustomerid, _parentcustomerid_value, ...contact }) => contact),
      },
      permissions,
      plugins,
      personaRoles,
      permissionSource: 'exported',
      settings: { permissionMode: 'enforce' },
    },
  }),
  generators: {},
  personas: [],
  plugins: [],
  pluginSteps,
  configurationPresets: [
    {
      id: 'example-entra',
      name: 'Simulated Microsoft Entra sign-in',
      description:
        'Enable the loopback identity provider using invented contacts. Source exports stay unchanged. Use Source defaults to reset.',
      portalOverrides: { settings: entraSettings },
    },
  ],
  personaCatalog: {
    version: 1,
    groups: [
      {
        id: 'operators',
        label: 'Demo operators',
        subgroups: [
          { id: 'edit', label: 'Editor' },
          { id: 'read', label: 'Reader' },
        ],
      },
    ],
    personas: [
      {
        key: 'editor',
        contactId: tables.contact[0].contactid,
        label: tables.contact[0].fullname,
        group: 'operators',
        subgroup: 'edit',
        tags: ['edit', 'crud'],
        description: 'Edit accounts, contacts and notes. Permissions come from the exported Workspace Editors role.',
      },
      {
        key: 'reader',
        contactId: tables.contact[1].contactid,
        label: tables.contact[1].fullname,
        group: 'operators',
        subgroup: 'read',
        tags: ['read-only'],
        description: 'Read accounts, contacts and notes. Writes are denied by exported table permissions.',
      },
    ],
    contexts: [
      {
        id: 'entra',
        label: 'Simulated Entra sandbox',
        portalOverrides: { settings: entraSettings },
        browser: { viewport: { width: 1280, height: 900 } },
      },
    ],
    scenarios: [
      {
        id: 'entra-editor',
        label: 'Entra · editor',
        group: 'operators',
        persona: 'editor',
        context: 'entra',
        startPath: '/',
      },
      {
        id: 'entra-reader',
        label: 'Entra · reader',
        group: 'operators',
        persona: 'reader',
        context: 'entra',
        startPath: '/',
      },
    ],
  },
  serverLogics: {
    'paqvilo-estimate': ({ runExportedServerLogic }) => runExportedServerLogic(),
    'paqvilo-account-summary': ({ runExportedServerLogic }) => runExportedServerLogic(),
  },
  cloudFlows: { 'Example Location': ({ runExportedCloudFlow }) => runExportedCloudFlow() },
};
