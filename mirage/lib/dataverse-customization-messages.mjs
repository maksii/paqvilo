// Simulated Dataverse customization messages: RetrieveApplicationRibbon, RetrieveEntityRibbon, UpdateRibbonClientMetadata,
// QueueUpdateRibbonClientMetadata, RetrieveFilteredForms, CopySystemForm, RetrieveUnpublished, RetrieveUnpublishedMultiple and
// PublishTheme. Registered as extension operations (dataverse-operations.mjs).
//
// Publishing: Mirage keeps no unpublished layer. Every write applies at once (PublishXml does nothing, dataverse-metadata-tables.mjs),
// so RetrieveUnpublished and RetrieveUnpublishedMultiple return the current rows, as the platform does for components with no
// pending changes.
//
// Ribbons: Mirage has no ribbon model and does not read RibbonDiffXml from Solutions. Every ribbon answer is the documented
// default (empty) RibbonDiffXml, zipped and base64 encoded.
//
// ValidateUnpublished (mobileofflineprofile), IsComponentCustomizable and SubstituteForAttribute/SubstituteForComponent are here
// too, with assumed answers. RemoveActiveCustomization* live in dataverse-solution-messages.mjs.
import { DataError } from './data-error.mjs';
import { randomUUID } from 'node:crypto';
import { contextUrl, parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';
import { privilegeDeniedError, privilegeName, uuidV5 } from './dataverse-security.mjs';
import { zipOf } from './dataverse-solutions.mjs';
import { componentsOf } from './dataverse-solution-messages.mjs';

// SubstitutionResult and its enum: declared once, with SubstituteForAttribute (SubstituteForComponent reuses them).
const SUBSTITUTION_TYPES = `<ComplexType Name="SubstitutionResult"><Property Name="Message" Type="Edm.String" Unicode="false" /><Property Name="Status" Type="mscrm.SubstitutionStatus" /></ComplexType>
<EnumType Name="SubstitutionStatus"><Member Name="Success" Value="0" /><Member Name="Error" Value="1" /><Member Name="Warning" Value="2" /></EnumType>
`;

// RibbonLocationFilters enum.
const RIBBON_FILTERS = { Form: 1, HomepageGrid: 2, SubGrid: 4, All: 7 };
// The tables RetrieveUnpublished binds to natively; only the ones Mirage has are registered.
const UNPUBLISHED_ENTITIES = [
  'savedqueryvisualization',
  'systemform',
  'customcontroldefaultconfig',
  'webresource',
  'sitemap',
  'savedquery',
  'mobileofflineprofileitem',
  'mobileofflineprofile',
  'appconfig',
  'appconfiginstance',
  'navigationsetting',
  'appmodule',
  'workflow',
  'desktopflowbinary',
  'aipluginconversationstarter',
  'aipluginconversationstartermapping',
  'aipluginoperationresponsetemplate',
  'aiplugintitle',
  'aiplugin',
  'aipluginoperation',
  'aipluginoperationparameter',
  'computeruseagent',
];
// The documented default RibbonDiffXml (not a live capture); the zip entry name is ours.
const RIBBON_XML =
  '<RibbonDiffXml><CustomActions /><Templates><RibbonTemplates Id="Mscrm.Templates"></RibbonTemplates></Templates>' +
  '<CommandDefinitions /><RuleDefinitions><TabDisplayRules /><DisplayRules /><EnableRules /></RuleDefinitions><LocLabels /></RibbonDiffXml>';
const compressedRibbon = () =>
  zipOf([{ name: 'RibbonXml.xml', data: Buffer.from(RIBBON_XML, 'utf8') }]).toString('base64');

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const tableOf = (store, logical) => (store.state.tables[logical] ??= []);
const GUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id });

// RibbonLocationFilter as a member name ('All', Microsoft.Dynamics.CRM.RibbonLocationFilters'All') or its value (7).
function ribbonFilterOf(value) {
  if (value === undefined || value === null) throw invalid('RibbonLocationFilter is required.');
  const name = String(value)
    .trim()
    .replace(/^Microsoft\.Dynamics\.CRM\.RibbonLocationFilters/, '')
    .replace(/^'|'$/g, '');
  const found = Object.entries(RIBBON_FILTERS).find(([member, number]) => member === name || String(number) === name);
  if (!found) throw invalid(`RibbonLocationFilter ${value} is not a RibbonLocationFilters member.`); // native message text not known
  return found[1];
}

// systemform id from a Target entity reference or a bare id; null when the parameter is absent.
function destinationOf(target) {
  if (target === undefined || target === null) return null;
  const match = GUID.exec(String(target?.formid ?? target?.systemformid ?? target?.['@odata.id'] ?? target));
  if (!match) throw invalid('Target must be a systemform reference.'); // native message text not known
  return match[1];
}

// mobileofflineprofile id of a Target reference (ValidateUnpublished); any other entity or no id is the request error.
function profileIdOf(target) {
  const type = String(target?.['@odata.type'] ?? '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
  const text = String(target?.mobileofflineprofileid ?? target?.['@odata.id'] ?? '');
  const set = /([a-z_]+)\(/i.exec(text)?.[1]?.toLowerCase();
  const id = GUID.exec(text)?.[1];
  if (!id || (type && type !== 'mobileofflineprofile') || (set && set !== 'mobileofflineprofiles')) {
    throw invalid('Target must be a mobileofflineprofile reference.'); // native message text not known
  }
  return id;
}

function csdlOf(kind, name, { bound = null, params = [], returns = null, response = null }) {
  const tag = kind === 'action' ? 'Action' : 'Function';
  const complexType = response
    ? `<ComplexType Name="${name}Response"><Property Name="${response[0]}" Type="${response[1]}" /></ComplexType>\n`
    : '';
  const parts = bound ? [`<Parameter Name="entity" Type="mscrm.${bound}" Nullable="false" />`] : [];
  for (const [param, type] of params) parts.push(`<Parameter Name="${param}" Type="${type}" />`);
  if (response) returns = `mscrm.${name}Response`;
  if (returns) parts.push(`<ReturnType Type="${returns}" Nullable="false" />`);
  return `${complexType}<${tag} Name="${name}"${bound ? ' IsBound="true"' : ''}>\n  ${parts.join('\n  ')}\n</${tag}>`;
}

function operations(api) {
  const { store } = api;
  // The table a parameter names; a missing name is a request error, an unknown one is the store's 404.
  const tableNamed = (name, parameter) => {
    if (typeof name !== 'string' || name === '') throw invalid(`${parameter} is required.`);
    return store.resolveMapping(name);
  };
  // Writes are one isolated transaction in the change queue, as in dataverse-security-messages.mjs.
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const need = (c, operation, schemaName, entity) => {
    const name = privilegeName(operation, schemaName);
    if (!(api.principals.privileges(c.user).get(name) > 0)) throw privilegeDeniedError(c.user, name, entity);
  };
  const respond = (c, name, body) => ({
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...body },
  });
  // Reads go through the record handlers as the caller, so row privileges, $select and formatting apply as for a GET.
  const read = (c, path, query = c.url.searchParams) => {
    const url = new URL(`${c.origin}${path}`);
    for (const [name, value] of query) url.searchParams.set(name, value);
    return api.records.handle({
      method: 'GET',
      route: parseDataverseRoute(path),
      url,
      origin: c.origin,
      version: c.version,
      prefer: parsePrefer(undefined),
      headers: {},
      user: c.user,
      caller: c.caller,
      identity: c.identity,
      requestId: c.requestId,
    });
  };
  const ribbonOp = (name, responseField) => ({
    name,
    kind: 'function',
    binding: 'unbound',
    handle: async (c) => respond(c, name, { [responseField]: compressedRibbon() }),
    csdl: csdlOf('function', name, { returns: null, response: [responseField, 'Edm.Binary'] }),
  });

  const ops = [
    {
      name: 'InstantiateFilters',
      kind: 'action',
      binding: 'entity',
      entity: 'systemuser',
      csdl: csdlOf('action', 'InstantiateFilters', {
        bound: 'systemuser',
        params: [['TemplateCollection', 'Collection(mscrm.savedquery)']],
      }),
      async handle(c) {
        // Outlook templates instantiate personal views owned by the bound user. The filter client itself is outside Mirage.
        // Assumptions: the copied columns, duplicate-template behaviour and errors.
        need(c, 'create', 'UserQuery', 'userquery');
        const userId = c.target?.id;
        const userMapping = store.resolveMapping('systemuser');
        const user = tableOf(store, 'systemuser').find((row) => sameId(row[userMapping.idColumn], userId));
        if (!user) throw notFound('systemuser', userId);
        if (!sameId(c.user.systemuserid, userId)) need(c, 'write', 'User', 'systemuser');
        const templates = c.body?.TemplateCollection;
        if (!Array.isArray(templates)) throw invalid('TemplateCollection must be a collection.');
        const savedMapping = store.resolveMapping('savedquery');
        const copies = templates.map((reference) => {
          const id = reference?.savedqueryid;
          const source = tableOf(store, 'savedquery').find((row) => sameId(row[savedMapping.idColumn], id));
          if (!source) throw notFound('savedquery', id);
          api.principals.authorize({
            user: c.user,
            entity: 'savedquery',
            operation: 'read',
            row: source,
            mapping: savedMapping,
          });
          const copy = {
            userqueryid: randomUUID(),
            ownerid: { id: userId, logical_name: 'systemuser', name: user.fullname ?? '' },
            owninguser: userId,
            owningbusinessunit: user.businessunitid ?? null,
          };
          for (const name of [
            'name',
            'description',
            'fetchxml',
            'layoutxml',
            'columnsetxml',
            'returnedtypecode',
            'querytype',
          ])
            if (source[name] != null) copy[name] = source[name];
          return copy;
        });
        await write(() => tableOf(store, 'userquery').push(...copies));
        return { status: 204 };
      },
    },
    ribbonOp('RetrieveApplicationRibbon', 'CompressedApplicationRibbonXml'),
    {
      name: 'RetrieveEntityRibbon',
      kind: 'function',
      binding: 'unbound',
      handle: async (c) => {
        tableNamed(c.params?.EntityName, 'EntityName');
        ribbonFilterOf(c.params?.RibbonLocationFilter);
        return respond(c, 'RetrieveEntityRibbon', { CompressedEntityXml: compressedRibbon() });
      },
      csdl: csdlOf('function', 'RetrieveEntityRibbon', {
        params: [
          ['EntityName', 'Edm.String'],
          ['RibbonLocationFilter', 'Microsoft.Dynamics.CRM.RibbonLocationFilters'],
        ],
        response: ['CompressedEntityXml', 'Edm.Binary'],
      }),
    },
    {
      // Undocumented action; Mirage keeps no ribbon cache, so nothing changes.
      name: 'UpdateRibbonClientMetadata',
      kind: 'action',
      binding: 'unbound',
      handle: async () => ({ status: 204 }),
      csdl: csdlOf('action', 'UpdateRibbonClientMetadata', {}), // parameterless in the native metadata.xml (self-closing Action)
    },
    {
      // Queues UpdateRibbonClientMetadata to a background job; no response is documented. Mirage has no ribbon cache, so the job does nothing.
      name: 'QueueUpdateRibbonClientMetadata',
      kind: 'action',
      binding: 'unbound',
      handle: async () => ({ status: 204 }),
      csdl: csdlOf('action', 'QueueUpdateRibbonClientMetadata', {}),
    },
    {
      name: 'RetrieveFilteredForms',
      kind: 'function',
      binding: 'collection',
      entity: 'systemform',
      handle: async (c) => {
        need(c, 'read', 'SystemForm', 'systemform');
        const logical = tableNamed(c.params?.EntityLogicalName, 'EntityLogicalName').logicalName;
        const formType = Number(c.params?.FormType);
        if (!Number.isInteger(formType)) throw invalid('FormType must be an integer.');
        const userId = GUID.exec(String(c.params?.User ?? ''))?.[1];
        if (!userId) throw invalid('User is required.');
        if (!store.get('systemuser', userId, c.identity)) throw notFound('systemuser', userId);
        const query = new URLSearchParams({ $filter: `objecttypecode eq '${logical}' and type eq ${formType}` });
        return read(c, `/api/data/${c.version}/systemforms`, query);
      },
      csdl: csdlOf('function', 'RetrieveFilteredForms', {
        bound: 'systemform',
        params: [
          ['EntityLogicalName', 'Edm.String'],
          ['FormType', 'Edm.Int32'],
          ['User', 'mscrm.systemuser'],
        ],
        returns: 'Collection(mscrm.systemform)',
      }),
    },
    {
      // Copies a systemform. Target is the form the copy is written to; absent, a new row is created.
      // Assumption: the copy's name and formid (undocumented).
      name: 'CopySystemForm',
      kind: 'action',
      binding: 'entity',
      entity: 'systemform',
      handle: async (c) => {
        const destination = destinationOf(c.body?.Target);
        need(c, 'create', 'SystemForm', 'systemform');
        if (destination) need(c, 'write', 'SystemForm', 'systemform');
        const source = c.target.row;
        // The primary id of systemform is formid (standard tables file), so every lookup and write uses the mapping's id column.
        const idColumn = c.target.mapping.idColumn;
        const newId = await write(() => {
          const rows = tableOf(store, 'systemform');
          const copy = { ...source };
          if (destination) {
            const row = rows.find((r) => sameId(r[idColumn], destination));
            if (!row) throw notFound('systemform', destination);
            Object.assign(row, { ...copy, [idColumn]: row[idColumn] });
            return row[idColumn];
          }
          let n = rows.length,
            id;
          do id = uuidV5(source[idColumn], `copy:${n++}`);
          while (rows.some((r) => sameId(r[idColumn], id)));
          rows.push({ ...copy, [idColumn]: id });
          return id;
        });
        return read(c, `/api/data/${c.version}/systemforms(${newId})`);
      },
      csdl: csdlOf('action', 'CopySystemForm', { bound: 'systemform', returns: 'mscrm.systemform' }),
    },
    {
      // The check is undocumented beyond the Target reference. Mirage has no unpublished layer, so a
      // mobileofflineprofile that exists is valid (204).
      name: 'ValidateUnpublished',
      kind: 'action',
      binding: 'unbound',
      handle: async (c) => {
        const profile = profileIdOf(c.body?.Target);
        if (!store.get('mobileofflineprofile', profile, c.identity)) throw notFound('mobileofflineprofile', profile);
        need(c, 'read', 'MobileOfflineProfile', 'mobileofflineprofile');
        return { status: 204 };
      },
      csdl: csdlOf('action', 'ValidateUnpublished', { params: [['Target', 'mscrm.crmbaseentity']] }),
    },
    {
      // Assumed answer per component kind: an attribute takes its column's IsCustomizable, a table its own; a relationship
      // and an option set are customizable. Only Mirage component ids are accepted (componentObjectId, dataverse-solution-messages.mjs).
      name: 'IsComponentCustomizable',
      kind: 'function',
      binding: 'unbound',
      handle: async (c) => {
        const id = key(GUID.exec(String(c.params?.ComponentId ?? ''))?.[1]);
        const type = Number(c.params?.ComponentType);
        const component = componentsOf(store.state).find((x) => x.id === id && x.type === type);
        if (!component)
          throw new DataError(`The solution component ${c.params?.ComponentId} does not exist.`, 404, 'NotFound'); // native message text not known
        const mapping =
          component.kind === 'entity' || component.kind === 'attribute'
            ? store.resolveMapping(component.logical)
            : null;
        const customizable =
          component.kind === 'attribute'
            ? mapping.fields[component.name]?.columnMetadata?.isCustomizable
            : component.kind === 'entity'
              ? mapping.dataverseMetadata?.IsCustomizable?.Value
              : undefined;
        return respond(c, 'IsComponentCustomizable', { IsComponentCustomizable: customizable ?? true });
      },
      csdl: csdlOf('function', 'IsComponentCustomizable', {
        params: [
          ['ComponentId', 'Edm.Guid'],
          ['ComponentType', 'Edm.Int32'],
        ],
        response: ['IsComponentCustomizable', 'Edm.Boolean'],
      }),
    },
    {
      // Only the parameters are documented; the answer is a success with no store effect.
      name: 'SubstituteForAttribute',
      kind: 'action',
      binding: 'unbound',
      handle: async (c) => {
        for (const name of ['AttributeName', 'AttributeContent', 'SubStore'])
          if (c.body?.[name] === undefined) throw invalid(`${name} is required.`);
        return respond(c, 'SubstituteForAttribute', { Result: { Message: '', Status: 'Success' } });
      },
      csdl:
        SUBSTITUTION_TYPES +
        csdlOf('action', 'SubstituteForAttribute', {
          params: [
            ['AttributeName', 'Edm.String'],
            ['AttributeContent', 'Edm.String'],
            ['SubStore', 'Edm.String'],
          ],
          response: ['Result', 'mscrm.SubstitutionResult'],
        }),
    },
    {
      // As SubstituteForAttribute. The entity is the record the substitution is for.
      name: 'SubstituteForComponent',
      kind: 'action',
      binding: 'unbound',
      handle: async (c) => {
        for (const name of ['Entity', 'SubStore'])
          if (c.body?.[name] === undefined) throw invalid(`${name} is required.`);
        return respond(c, 'SubstituteForComponent', { Result: { Message: '', Status: 'Success' } });
      },
      csdl: csdlOf('action', 'SubstituteForComponent', {
        params: [
          ['Entity', 'mscrm.crmbaseentity'],
          ['SubStore', 'Edm.String'],
        ],
        response: ['Result', 'mscrm.SubstitutionResult'],
      }),
    },
    {
      name: 'PublishTheme',
      kind: 'action',
      binding: 'entity',
      entity: 'theme',
      handle: async (c) => {
        need(c, 'write', 'Theme', 'theme');
        const id = c.target.id;
        await write(() => {
          for (const theme of tableOf(store, 'theme')) theme.isdefaulttheme = sameId(theme.themeid, id);
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'PublishTheme', { bound: 'theme' }),
    },
  ];

  for (const entity of UNPUBLISHED_ENTITIES) {
    if (!store.state.mappings[entity]) continue;
    ops.push({
      name: 'RetrieveUnpublished',
      kind: 'function',
      binding: 'entity',
      entity,
      handle: async (c) => read(c, `/api/data/${c.version}/${c.target.mapping.entitySet}(${c.target.id})`),
      csdl: csdlOf('function', 'RetrieveUnpublished', { bound: entity, returns: 'mscrm.savedqueryvisualization' }),
    });
    ops.push({
      name: 'RetrieveUnpublishedMultiple',
      kind: 'function',
      binding: 'collection',
      entity,
      handle: async (c) => read(c, `/api/data/${c.version}/${c.target.mapping.entitySet}`),
      csdl: csdlOf('function', 'RetrieveUnpublishedMultiple', {
        bound: entity,
        returns: 'Collection(mscrm.savedqueryvisualization)',
      }),
    });
  }
  return ops;
}

// Registers the operations. Synchronous: the registry only stores definitions.
export function install(api) {
  for (const op of operations(api)) api.registry.register(op);
}
