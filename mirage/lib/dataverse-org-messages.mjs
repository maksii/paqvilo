import { argsOf, readMessageRecords } from './dataverse-message-context.mjs';
import { organizationRecord } from './organization-context.mjs';
// Simulated Dataverse organization, environment variable, license and deployment messages, through the registered operations.
// Each answers from the store (organization row, solution, systemuser, workflow, environmentvariabledefinition and
// environmentvariablevalue) or from a fixed stand-in where the simulator has no such fact.
// SetFeatureStatus is an internal-only message: registered with its native signature.
// Not registered here: Validate (no documented contract).
import { DataError } from './data-error.mjs';
import { standardTableDef } from './dataverse-standard.mjs';
import {
  ACCESS_MODE,
  isInteractiveUser,
  ownerColumns,
  privilegeDeniedError,
  privilegeName,
  uuidV5,
} from './dataverse-security.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { parseEntityReference } from './data.mjs';
import { registerInternalMessage } from './dataverse-addon-common.mjs';

const ENV_DEFINITION = 'environmentvariabledefinition';
const ENV_VALUE = 'environmentvariablevalue';
// Environment variable types (UpsertEnvironmentVariable Type): String, Integer, Boolean, JSON, Data Source, Secret.
const ENV_TYPES = new Set([100000000, 100000001, 100000002, 100000003, 100000004, 100000005]);
// The only documented secret store for UpsertEnvironmentVariable: 0, KeyVault.
const KEY_VAULT = 0;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
// The simulator has no instance type, license, sku or storage model; these are fixed stand-ins.
const INSTANCE_TYPE_DEVELOPER = 13; // OrganizationType Developer
const DEPLOYMENT_LICENSE_TYPE = 'Trial';
const LIMITS = {
  MaxNumberOfActiveUsers: 1000,
  MaxNumberOfNonInteractiveUsers: 1000,
  MaxNumberOfCustomEntities: 1000,
  MaxNumberOfPublishedWorkflows: 1000,
  MaxStorage: 10240,
};

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? undefined;
const ref = (logical, id) => (id == null ? null : { id, logical_name: logical, name: '' });
const tableOf = (store, logical) => (store.state.tables[logical] ??= []);
// Function parameters arrive as c.params and action parameters as the body; a SOAP call carries both.
// Refusal wording is a guess; 0x80040203 (InvalidArgument) is the default code for a rejected argument.
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const notFound = (logical, id) =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id, innerCode: '0x80040217' });
const requiredText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${name} is required.`);
  return value;
};
const integerOf = (value, name) => {
  const number = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isInteger(number))
    throw invalid(`${name} must be an integer.`);
  return number;
};

// Dataverse-only state (settings, the encryption key) lives under store.state.dataverse; no portal path reads it.
const dv = (store) => (store.state.dataverse ??= {});
const ADMIN = 'System Administrator';
const given = (value) => value !== undefined && value !== null && value !== '';
const GUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orgIdOf = (store) => organizationRecord(store)?.organizationid ?? ZERO_GUID;
const TIME = (value) => new Date(value).getTime();
// The primary-key row of a table, or null.
const rowNamed = (store, logical, id) => tableOf(store, logical).find((r) => sameId(r[`${logical}id`], id)) ?? null;
const fieldsOf = (values) =>
  Object.fromEntries(Object.entries(values).filter(([field]) => !field.startsWith('@odata.')));

// settingdefinition datatype and overridablelevel values (assumed, not documented).
const DATATYPE = { Number: 0, String: 1, Boolean: 2 };
const LEVEL = { AppAndOrganization: 0, OrganizationOnly: 1, AppOnly: 2 };
const SETTING_DETAIL = `<ComplexType Name="SettingDetail"><Property Name="Name" Type="Edm.String" Unicode="false" /><Property Name="Value" Type="Edm.String" Unicode="false" /><Property Name="DataType" Type="Edm.Int32" /></ComplexType>`;
const settingNotFound = (name) =>
  new DataError(`settingdefinition With Name = ${name} Does Not Exist`, 404, 'NotFound', { innerCode: '0x80040217' });
const appNotFound = (name) =>
  new DataError(`appmodule With UniqueName = ${name} Does Not Exist`, 404, 'NotFound', { innerCode: '0x80040217' });
// ponytail: definitions come from the host or tests (dv(store).settingDefinitions). Reading them from a solution export needs
// dataverse-settings.mjs and solution parsing.
const definitionOf = (store, name) => dv(store).settingDefinitions?.[key(name)] ?? null;
const appOf = (store, name) => tableOf(store, 'appmodule').find((a) => sameId(a.uniquename, name)) ?? null;
const settingValues = (store) => (dv(store).settingValues ??= { environment: {}, app: {} });
const levelOf = (def) => def.overridablelevel ?? LEVEL.AppAndOrganization; // the default for a definition without a level is a guess

// The value RetrieveSetting reports: a non-overridable setting has its default; otherwise the app value (AppAndOrganization,
// AppOnly) then the environment value (AppAndOrganization, OrganizationOnly), else the default. appName is null without an app.
function settingValueOf(store, def, appName) {
  const values = settingValues(store);
  const name = key(def.uniquename);
  const appValue = appName ? values.app[`${key(appName)}|${name}`] : undefined;
  const envValue = values.environment[name];
  const level = levelOf(def);
  let stored;
  if (def.isoverridable === false) stored = undefined;
  else if (level === LEVEL.OrganizationOnly) stored = envValue;
  else if (level === LEVEL.AppOnly) stored = appValue;
  else stored = appValue !== undefined ? appValue : envValue;
  return stored ?? def.defaultvalue ?? null;
}

// The stored form of a value for its datatype. Booleans are stored lowercase; anything else for a number or boolean is refused.
function settingTextOf(def, value) {
  if (def.datatype === DATATYPE.Number) {
    if (value.trim() !== '' && Number.isFinite(Number(value))) return value;
    throw invalid('Value does not match the setting data type.');
  }
  if (def.datatype === DATATYPE.Boolean) {
    if (/^(true|false)$/i.test(value)) return value.toLowerCase();
    throw invalid('Value does not match the setting data type.');
  }
  return value;
}

// The encryption key: the stored one, else a deterministic stand-in (the platform generates a random passphrase).
// The key is never logged.
const encryptionKeyOf = (store) => dv(store).dataEncryptionKey ?? uuidV5(orgIdOf(store), 'dataencryptionkey');

// The record an entity-reference parameter names: an @odata.id string or object, or a typed object. Returns { logical, id }.
function referenceOf(store, value, name) {
  const refused = () => invalid(`The ${name} parameter is not an entity reference.`, '0x80048d19');
  if (value && typeof value === 'object' && value['@odata.id'] === undefined) {
    const logical = /\.(\w+)$/.exec(String(value['@odata.type'] ?? ''))?.[1] ?? null;
    if (!logical) throw refused();
    const mapping = store.resolveMapping(logical);
    if (value[mapping.idColumn] == null) throw refused();
    return { logical: mapping.logicalName, id: String(value[mapping.idColumn]) };
  }
  const text = value && typeof value === 'object' ? value['@odata.id'] : value;
  const ref = parseEntityReference(
    String(text ?? '')
      .trim()
      .replace(/^https?:\/\/[^/]+/i, '')
      .replace(/^\/?api\/data\/v\d+\.\d+\//i, ''),
  );
  if (!ref) throw refused();
  return { logical: store.resolveMapping(ref.set).logicalName, id: String(ref.id) };
}

// Keyword wildcards: * and % match any text; everything else is literal (case-insensitive by the caller).
const escapeText = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const WALL_PARAMS = [
  ['PageNumber', 'Edm.Int32'],
  ['PageSize', 'Edm.Int32'],
  ['CommentsPerPost', 'Edm.Int32'],
  ['StartDate', 'Edm.DateTimeOffset', true],
  ['EndDate', 'Edm.DateTimeOffset', true],
  ['Type', 'Edm.Int32', true],
  ['Source', 'Edm.Int32', true],
  ['SortDirection', 'Edm.Boolean', true],
  ['Keyword', 'Edm.String', true],
];

// The definition named by a schema name (case-insensitive), or null.
const definitionNamed = (store, schemaName) =>
  tableOf(store, ENV_DEFINITION).find((d) => sameId(d.schemaname, schemaName)) ?? null;
// The value row of a definition, or null: a definition has at most one value in this module.
const valueOf = (store, definitionId) =>
  tableOf(store, ENV_VALUE).find((v) => sameId(refId(v.environmentvariabledefinitionid), definitionId)) ?? null;
// The value a reader sees: the value row when one exists, else the definition's default value, else null.
const currentValue = (store, definition) => {
  const row = valueOf(store, definition.environmentvariabledefinitionid);
  return row ? (row.value ?? null) : (definition.defaultvalue ?? null);
};

function organizationInfo(store) {
  return {
    InstanceType: INSTANCE_TYPE_DEVELOPER,
    SingletonScenarioName: null,
    Solutions: tableOf(store, 'solution').map((s) => ({
      FriendlyName: s.friendlyname ?? null,
      Id: refId(s.solutionid) ?? null,
      PublisherId: refId(s.publisherid) ?? null,
      PublisherIdName: null, // publisher names are not joined here
      PublisherUniqueName: null,
      SolutionUniqueName: s.uniquename ?? null,
      VersionNumber: s.version ?? null,
    })),
  };
}

function organizationResources(store) {
  const users = tableOf(store, 'systemuser');
  // ponytail: a custom entity is a mapping the standard catalogue does not know and no dataverseOnly stand-in seeded.
  const customEntities = Object.entries(store.state.mappings).filter(
    ([logical, mapping]) => !standardTableDef(logical) && !mapping.dataverseOnly,
  ).length;
  return {
    CurrentNumberOfActiveUsers: users.filter(isInteractiveUser).length,
    CurrentNumberOfCustomEntities: customEntities,
    CurrentNumberOfNonInteractiveUsers: users.filter((u) => u.accessmode === ACCESS_MODE.NonInteractive).length,
    CurrentNumberOfPublishedWorkflows: tableOf(store, 'workflow').filter((w) => w.statecode === 1).length,
    CurrentStorage: 0, // no blob storage is modelled
    MaxNumberOfActiveUsers: LIMITS.MaxNumberOfActiveUsers,
    MaxNumberOfCustomEntities: LIMITS.MaxNumberOfCustomEntities,
    MaxNumberOfNonInteractiveUsers: LIMITS.MaxNumberOfNonInteractiveUsers,
    MaxNumberOfPublishedWorkflows: LIMITS.MaxNumberOfPublishedWorkflows,
    MaxStorage: LIMITS.MaxStorage,
  };
}

// CSDL for one operation. A response is a ComplexType named <Name>Response with the given properties; `extra` holds any
// other complex type it uses, so the fragment stands alone in $metadata. boundSet binds to a collection (the native `entityset`
// parameter); a param [name, type, true] is optional (the OptionalParameter annotation).
function csdlOf(
  kind,
  name,
  { bound = null, boundSet = null, params = [], returns = null, response = null, extra = '' } = {},
) {
  const tag = kind === 'action' ? 'Action' : 'Function';
  const parts = bound ? [`<Parameter Name="entity" Type="mscrm.${bound}" Nullable="false" />`] : [];
  if (boundSet) parts.push(`<Parameter Name="entityset" Type="Collection(mscrm.${boundSet})" Nullable="false" />`);
  for (const [param, type, optional] of params) {
    parts.push(
      optional
        ? `<Parameter Name="${param}" Type="${type}"><Annotation Term="Org.OData.Core.V1.OptionalParameter" /></Parameter>`
        : `<Parameter Name="${param}" Type="${type}" />`,
    );
  }
  const complex = response
    ? `<ComplexType Name="${name}Response">${response.map(([prop, type]) => `<Property Name="${prop}" Type="${type}" />`).join('')}</ComplexType>`
    : '';
  const result = response ? `mscrm.${name}Response` : returns;
  if (result) parts.push(`<ReturnType Type="${result}" Nullable="false" />`);
  const head = `<${tag} Name="${name}"${bound ? ' IsBound="true"' : ''}>`;
  return [complex, extra, `${head}\n  ${parts.join('\n  ')}\n</${tag}>`].filter(Boolean).join('\n');
}

const ORGANIZATION_TYPES = `<ComplexType Name="SolutionCt">
  <Property Name="FriendlyName" Type="Edm.String" /><Property Name="Id" Type="Edm.Guid" /><Property Name="PublisherId" Type="Edm.Guid" />
  <Property Name="PublisherIdName" Type="Edm.String" /><Property Name="PublisherUniqueName" Type="Edm.String" />
  <Property Name="SolutionUniqueName" Type="Edm.String" /><Property Name="VersionNumber" Type="Edm.String" />
</ComplexType>
<ComplexType Name="OrganizationInfo">
  <Property Name="InstanceType" Type="Edm.Int32" /><Property Name="SingletonScenarioName" Type="Edm.String" />
  <Property Name="Solutions" Type="Collection(mscrm.SolutionCt)" />
</ComplexType>`;
const RESOURCE_COUNTS = [
  'CurrentNumberOfActiveUsers',
  'CurrentNumberOfCustomEntities',
  'CurrentNumberOfNonInteractiveUsers',
  'CurrentNumberOfPublishedWorkflows',
  'CurrentStorage',
  'MaxNumberOfActiveUsers',
  'MaxNumberOfCustomEntities',
  'MaxNumberOfNonInteractiveUsers',
  'MaxNumberOfPublishedWorkflows',
  'MaxStorage',
];
const RESOURCES_TYPE = `<ComplexType Name="OrganizationResources">
  ${RESOURCE_COUNTS.map((name) => `<Property Name="${name}" Type="Edm.Int32" />`).join('\n  ')}
</ComplexType>`;
const LICENSE_TYPES = `<ComplexType Name="ServicePlan">
  <Property Name="DisplayName" Type="Edm.String" /><Property Name="Name" Type="Edm.String" /><Property Name="ServicePlanId" Type="Edm.Guid" />
</ComplexType>
<ComplexType Name="UserLicenseInfo">
  <Property Name="ServicePlans" Type="Collection(mscrm.ServicePlan)" />
</ComplexType>`;

function operations(api) {
  const { store } = api;
  // Every write is one isolated store transaction inside the change queue, as the other Dataverse messages write (dataverse-security-messages.mjs).
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  // The privilege the caller needs on a table (Read or Write), refused as the platform refuses it.
  const need = (c, logical, right) => {
    const privilege = privilegeName(right, api.principals.privilegeNoun(logical));
    if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, logical);
  };
  const respond = (c, name, payload) => ({
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...payload },
  });
  // The privilege check and its refusal text are guesses.
  const requireAdmin = (c) => {
    if (!api.principals.roles(c.user).some((r) => r.name === ADMIN))
      throw new DataError('The caller is not a System Administrator.', 403, 'PrivilegeDenied', {
        innerCode: '0x80040220',
      });
  };
  // The Web API GET of a path as the caller reads it (row privileges, field security, lookup formatting), as the activity module does.
  const readAsCaller = (c, path, query = '') => readMessageRecords(api, c, new URL(`${c.origin}${path}${query}`));
  const authorizeRead = (c, logical, row) =>
    api.principals.authorize({
      user: c.user,
      entity: logical,
      operation: 'read',
      row,
      mapping: store.resolveMapping(logical),
    });

  // SharePoint: the parent of a site or location row (parentsite, or parentsiteorlocation with its logical name), or null.
  const parentOfSharePoint = (row, logical) => {
    const ref = logical === 'sharepointsite' ? row.parentsite : row.parentsiteorlocation;
    const id = refId(ref);
    if (id == null) return null;
    const parentLogical = ref?.logical_name ?? 'sharepointsite';
    const parent = rowNamed(store, parentLogical, id);
    return parent ? { row: parent, logical: parentLogical } : null;
  };
  const absoluteOf = (row, logical, depth = 0) => {
    if (depth > 32) throw invalid('The SharePoint location hierarchy is too deep.');
    if (row.absoluteurl) return row.absoluteurl;
    const parent = parentOfSharePoint(row, logical);
    if (!parent) return row.relativeurl ?? ''; // a root row with no absolute URL: assumed
    return `${absoluteOf(parent.row, parent.logical, depth + 1).replace(/\/+$/, '')}/${(row.relativeurl ?? '').replace(/^\/+/, '')}`;
  };
  // The site collection: the topmost sharepointsite of the row, whose absolute URL is given only when isgridpresent is true (blank otherwise).
  const siteCollectionUrl = (row, logical) => {
    let current = { row, logical };
    let site = logical === 'sharepointsite' ? current : null;
    for (let depth = 0; depth <= 32; depth++) {
      const parent = parentOfSharePoint(current.row, current.logical);
      if (!parent) break;
      current = parent;
      if (current.logical === 'sharepointsite') site = current;
    }
    return site && site.row.isgridpresent === true ? absoluteOf(site.row, 'sharepointsite') : '';
  };
  const absoluteUrlOf = (logical, csdl) => ({
    name: 'RetrieveAbsoluteAndSiteCollectionUrl',
    kind: 'function',
    binding: 'entity',
    entity: logical,
    handle: (c) => {
      need(c, logical, 'Read');
      const row = rowNamed(store, logical, c.target?.id);
      if (!row) throw notFound(logical, c.target?.id);
      authorizeRead(c, logical, row);
      return respond(c, 'RetrieveAbsoluteAndSiteCollectionUrl', {
        AbsoluteUrl: absoluteOf(row, logical),
        SiteCollectionUrl: siteCollectionUrl(row, logical),
      });
    },
    csdl,
  });

  // The posts regarding the subjects, newest first (ascending with SortDirection true), paged, each with its newest comments.
  // Type is reserved: accepted and ignored. The comment shape and order and the Keyword syntax are guesses.
  const wall = (c, subjects, createdBy) => {
    const args = argsOf(c);
    const page = integerOf(args.PageNumber, 'PageNumber');
    const size = integerOf(args.PageSize, 'PageSize');
    const comments = integerOf(args.CommentsPerPost, 'CommentsPerPost');
    if (page < 1) throw invalid('PageNumber must be at least 1.');
    if (size < 1) throw invalid('PageSize must be at least 1.');
    if (comments < 0) throw invalid('CommentsPerPost must be at least 0.');
    need(c, 'post', 'Read');
    const ids = new Set(subjects.filter(given).map(key));
    const start = given(args.StartDate) ? TIME(args.StartDate) : null;
    const end = given(args.EndDate) ? TIME(args.EndDate) : null;
    const source = given(args.Source) ? integerOf(args.Source, 'Source') : null;
    const pattern = given(args.Keyword)
      ? new RegExp(String(args.Keyword).split(/[*%]/).map(escapeText).join('.*'), 'i')
      : null;
    const ascending = args.SortDirection === true || args.SortDirection === 'true';
    const candidates = tableOf(store, 'post').filter((p) => {
      const regarding = refId(p.regardingobjectid);
      return (
        (regarding != null && ids.has(key(regarding))) ||
        [...ids].some((id) => key(p.text).includes(id)) ||
        (createdBy != null && sameId(refId(p.createdby), createdBy))
      );
    });
    // The caller must read the records the posts regard. A post with no regarding record stays; an unreadable one is dropped.
    const visible = candidates.filter((p) => {
      const regarding = refId(p.regardingobjectid);
      if (regarding == null) return true;
      const logical = p.regardingobjectid?.logical_name ?? p.regardingobjecttypecode;
      if (!logical) return false;
      try {
        authorizeRead(c, logical, rowNamed(store, logical, regarding));
        return true;
      } catch {
        return false;
      }
    });
    const kept = visible.filter((p) => {
      const at = TIME(p.createdon);
      if (start !== null && at < start) return false;
      if (end !== null && at > end) return false;
      if (source !== null && Number(p.source) !== source) return false;
      return !pattern || pattern.test(p.text ?? '');
    });
    kept.sort((a, b) => (TIME(a.createdon) - TIME(b.createdon)) * (ascending ? 1 : -1));
    const value = kept.slice((page - 1) * size, page * size).map((p) => ({
      ...p,
      Post_Comments: tableOf(store, 'postcomment')
        .filter((cm) => sameId(refId(cm.postid), p.postid))
        .sort((a, b) => TIME(b.createdon) - TIME(a.createdon))
        .slice(0, comments),
    }));
    return { status: 200, body: { '@odata.context': contextUrl(c.origin, c.version, 'posts'), value } };
  };

  return [
    {
      name: 'IsDataEncryptionActive',
      kind: 'function',
      binding: 'unbound',
      // All new and upgraded organizations use data encryption by default. The encryption key is not modelled.
      handle: (c) => respond(c, 'IsDataEncryptionActive', { IsActive: true }),
      csdl: csdlOf('function', 'IsDataEncryptionActive', { response: [['IsActive', 'Edm.Boolean']] }),
    },
    {
      name: 'ResetUserFilters',
      kind: 'action',
      binding: 'unbound',
      // The offline filters of the caller. The simulator keeps no offline filter state, so the reset has nothing to change
      // (the accepted QueryType values are a guess).
      handle: (c) => {
        integerOf(argsOf(c).QueryType, 'QueryType');
        return { status: 204 };
      },
      csdl: csdlOf('action', 'ResetUserFilters', { params: [['QueryType', 'Edm.Int32']] }),
    },
    {
      name: 'RetrieveOrganizationInfo',
      kind: 'function',
      binding: 'unbound',
      handle: (c) => respond(c, 'RetrieveOrganizationInfo', { organizationInfo: organizationInfo(store) }),
      csdl: csdlOf('function', 'RetrieveOrganizationInfo', {
        response: [['organizationInfo', 'mscrm.OrganizationInfo']],
        extra: ORGANIZATION_TYPES,
      }),
    },
    {
      name: 'RetrieveOrganizationResources',
      kind: 'function',
      binding: 'unbound',
      handle: (c) =>
        respond(c, 'RetrieveOrganizationResources', { OrganizationResources: organizationResources(store) }),
      csdl: csdlOf('function', 'RetrieveOrganizationResources', {
        response: [['OrganizationResources', 'mscrm.OrganizationResources']],
        extra: RESOURCES_TYPE,
      }),
    },
    {
      name: 'RetrieveEnvironmentVariableValue',
      kind: 'function',
      binding: 'unbound',
      handle: (c) => {
        const schemaName = requiredText(argsOf(c).DefinitionSchemaName, 'DefinitionSchemaName');
        need(c, ENV_DEFINITION, 'Read');
        const definition = definitionNamed(store, schemaName);
        // The not-found wording and code for a schema name are guesses.
        if (!definition)
          throw new DataError(`${ENV_DEFINITION} With SchemaName = ${schemaName} Does Not Exist`, 404, 'NotFound', {
            innerCode: '0x80040217',
          });
        return respond(c, 'RetrieveEnvironmentVariableValue', { Value: currentValue(store, definition) });
      },
      csdl: csdlOf('function', 'RetrieveEnvironmentVariableValue', {
        params: [['DefinitionSchemaName', 'Edm.String']],
        response: [['Value', 'Edm.String']],
      }),
    },
    {
      name: 'RetrieveEnvironmentVariables',
      kind: 'function',
      binding: 'unbound',
      // The row shape is a guess: the definition row, with its current value under `value`.
      handle: (c) => {
        need(c, ENV_DEFINITION, 'Read');
        const names = argsOf(c).SchemaNames;
        const wanted = Array.isArray(names) && names.length ? names : null;
        const rows = tableOf(store, ENV_DEFINITION)
          .filter((d) => !wanted || wanted.some((name) => sameId(name, d.schemaname)))
          .map((d) => ({ ...d, value: currentValue(store, d) }));
        return {
          status: 200,
          body: { '@odata.context': contextUrl(c.origin, c.version, 'environmentvariabledefinitions'), value: rows },
        };
      },
      csdl: csdlOf('function', 'RetrieveEnvironmentVariables', {
        params: [['SchemaNames', 'Collection(Edm.String)']],
        returns: 'Collection(mscrm.crmbaseentity)',
      }),
    },
    {
      name: 'UpsertEnvironmentVariable',
      kind: 'action',
      binding: 'unbound',
      handle: async (c) => {
        need(c, ENV_DEFINITION, 'Write');
        const args = argsOf(c);
        const schemaName = requiredText(args.SchemaName, 'SchemaName');
        const type = Number(args.Type);
        if (args.Type === undefined || args.Type === null || !ENV_TYPES.has(type))
          throw invalid('Type must be one of the environment variable types.');
        if (args.SecretStore !== undefined && args.SecretStore !== null && Number(args.SecretStore) !== KEY_VAULT) {
          throw invalid('SecretStore must be 0, the Key Vault store.');
        }
        if (args.Value !== undefined) need(c, ENV_VALUE, 'Write');
        const organizationId = organizationRecord(store)?.organizationid ?? ZERO_GUID;
        await write(() => {
          const definitions = tableOf(store, ENV_DEFINITION);
          let definition = definitionNamed(store, schemaName);
          if (!definition) {
            definition = {
              environmentvariabledefinitionid: uuidV5(organizationId, `${ENV_DEFINITION}:${schemaName.toLowerCase()}`),
              schemaname: schemaName,
              statecode: 0,
              statuscode: 1,
            };
            definitions.push(definition);
          }
          const set = (field, value) => {
            if (value !== undefined) definition[field] = value;
          };
          set('displayname', args.DisplayName);
          definition.type = type;
          set('defaultvalue', args.DefaultValue);
          set('secretstore', args.SecretStore === undefined || args.SecretStore === null ? undefined : KEY_VAULT);
          set('parameterkey', args.ParameterKey);
          set('apiid', args.ApiId);
          if (args.Value !== undefined) {
            let row = valueOf(store, definition.environmentvariabledefinitionid);
            if (!row) {
              row = {
                environmentvariablevalueid: uuidV5(definition.environmentvariabledefinitionid, ENV_VALUE),
                environmentvariabledefinitionid: ref(ENV_DEFINITION, definition.environmentvariabledefinitionid),
                schemaname: schemaName,
                statecode: 0,
                statuscode: 1,
              };
              tableOf(store, ENV_VALUE).push(row);
            }
            row.value = args.Value;
          }
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'UpsertEnvironmentVariable', {
        params: [
          ['DisplayName', 'Edm.String'],
          ['SchemaName', 'Edm.String'],
          ['Type', 'Edm.Int32'],
          ['DefaultValue', 'Edm.String'],
          ['Value', 'Edm.String'],
          ['SecretStore', 'Edm.Int32'],
          ['ParameterKey', 'Edm.String'],
          ['ApiId', 'Edm.String'],
        ],
      }),
    },
    {
      name: 'RetrieveEnvironmentVariableSecretValue',
      kind: 'action',
      binding: 'unbound',
      // Natively callable from a Power Automate flow only. Key Vault is never called: the value row holds the Key Vault reference
      // and api.secrets (secret-resolver.mjs, from the project `secrets` config) resolves it for the caller. Without a
      // `secrets` config the secret is refused with the not-simulated code the other messages use.
      handle: async (c) => {
        const name = requiredText(argsOf(c).EnvironmentVariableName, 'EnvironmentVariableName');
        need(c, ENV_DEFINITION, 'Read');
        const definition = definitionNamed(store, name);
        if (!definition)
          throw new DataError(`${ENV_DEFINITION} With SchemaName = ${name} Does Not Exist`, 404, 'NotFound', {
            innerCode: '0x80040217',
          });
        const secrets = api.secrets ?? null;
        if (!secrets)
          throw new DataError(
            'Key Vault secret values are not simulated: no secrets configuration exists.',
            501,
            'NotImplemented',
            { innerCode: '0x80040216' },
          );
        if (Number(definition.type) !== 100000005 || Number(definition.secretstore ?? KEY_VAULT) !== KEY_VAULT)
          throw invalid(`${name} is not a Key Vault Secret environment variable.`); // code and wording are guesses
        const answer = await secrets.resolve(currentValue(store, definition), {
          principalId: (c.caller ?? c.user)?.systemuserid,
          purpose: 'RetrieveEnvironmentVariableSecretValue',
        });
        if (answer.status === 'resolved')
          return respond(c, 'RetrieveEnvironmentVariableSecretValue', { EnvironmentVariableSecretValue: answer.value });
        // The native status and code per refusal are guesses: denied 403, missing/unbound 404, expired/disabled 400.
        if (answer.status === 'denied')
          throw new DataError(answer.reason, 403, 'PrivilegeDenied', { innerCode: '0x80040220' });
        if (answer.status === 'missing' || answer.status === 'unbound')
          throw new DataError(answer.reason, 404, 'NotFound', { innerCode: '0x80040217' });
        throw invalid(answer.reason);
      },
      csdl: csdlOf('action', 'RetrieveEnvironmentVariableSecretValue', {
        params: [['EnvironmentVariableName', 'Edm.String']],
        response: [['EnvironmentVariableSecretValue', 'Edm.String']],
      }),
    },
    {
      name: 'NotifyEnvironmentVariableSecretChange',
      kind: 'action',
      binding: 'unbound',
      // Called from a flow on a Key Vault event. Nothing is cached here, so the notice only validates its arguments; the
      // native reply is a guess.
      handle: (c) => {
        const args = argsOf(c);
        requiredText(args.KeyVaultUrl, 'KeyVaultUrl');
        requiredText(args.SecretName, 'SecretName');
        return { status: 204 };
      },
      csdl: csdlOf('action', 'NotifyEnvironmentVariableSecretChange', {
        params: [
          ['KeyVaultUrl', 'Edm.String'],
          ['SecretName', 'Edm.String'],
        ],
      }),
    },
    {
      name: 'RetrieveDeploymentLicenseType',
      kind: 'function',
      binding: 'unbound',
      // The simulator has no license model; this is a fixed stand-in string.
      handle: (c) => respond(c, 'RetrieveDeploymentLicenseType', { licenseType: DEPLOYMENT_LICENSE_TYPE }),
      csdl: csdlOf('function', 'RetrieveDeploymentLicenseType', { response: [['licenseType', 'Edm.String']] }),
    },
    {
      name: 'RetrieveLicenseInfo',
      kind: 'function',
      binding: 'unbound',
      // ponytail: AccessMode is validated, not used to filter the counts. Granted licenses are the interactive users.
      handle: (c) => {
        integerOf(argsOf(c).AccessMode, 'AccessMode');
        return respond(c, 'RetrieveLicenseInfo', {
          AvailableCount: 0, // no license pool is modelled
          GrantedLicenseCount: tableOf(store, 'systemuser').filter(isInteractiveUser).length,
        });
      },
      csdl: csdlOf('function', 'RetrieveLicenseInfo', {
        params: [['AccessMode', 'Edm.Int32']],
        response: [
          ['AvailableCount', 'Edm.Int32'],
          ['GrantedLicenseCount', 'Edm.Int32'],
        ],
      }),
    },
    {
      name: 'RetrieveUserLicenseInfo',
      kind: 'function',
      binding: 'entity',
      entity: 'systemuser',
      // The simulator has no service plan model, so the plans list is empty.
      handle: (c) => {
        const id = c.target?.id;
        if (!tableOf(store, 'systemuser').some((u) => sameId(u.systemuserid, id))) throw notFound('systemuser', id);
        return respond(c, 'RetrieveUserLicenseInfo', { licenseInfo: { ServicePlans: [] } });
      },
      csdl: csdlOf('function', 'RetrieveUserLicenseInfo', {
        bound: 'systemuser',
        response: [['licenseInfo', 'mscrm.UserLicenseInfo']],
        extra: LICENSE_TYPES,
      }),
    },
    {
      name: 'RetrieveSetting',
      kind: 'function',
      binding: 'unbound',
      handle: (c) => {
        const args = argsOf(c);
        const name = requiredText(args.SettingName, 'SettingName');
        const def = definitionOf(store, name);
        if (!def) throw settingNotFound(name);
        const app = given(args.AppUniqueName) ? appOf(store, args.AppUniqueName) : null;
        if (given(args.AppUniqueName) && !app) throw appNotFound(args.AppUniqueName);
        return respond(c, 'RetrieveSetting', {
          SettingDetail: {
            Name: def.uniquename,
            Value: settingValueOf(store, def, app?.uniquename ?? null),
            DataType: def.datatype,
          },
        });
      },
      csdl: csdlOf('function', 'RetrieveSetting', {
        params: [
          ['AppUniqueName', 'Edm.String', true],
          ['SettingName', 'Edm.String'],
        ],
        response: [['SettingDetail', 'mscrm.SettingDetail']],
        extra: SETTING_DETAIL,
      }),
    },
    {
      name: 'SaveSettingValue',
      kind: 'action',
      binding: 'unbound',
      // Only the System Administrator role may save (a guess).
      // ponytail: SolutionUniqueName is checked, and nothing else recorded.
      handle: async (c) => {
        requireAdmin(c);
        const args = argsOf(c);
        const name = requiredText(args.SettingName, 'SettingName');
        const value = requiredText(args.Value, 'Value');
        const def = definitionOf(store, name);
        if (!def) throw settingNotFound(name);
        if (
          given(args.SolutionUniqueName) &&
          !tableOf(store, 'solution').some((s) => sameId(s.uniquename, args.SolutionUniqueName))
        ) {
          throw new DataError(`solution With UniqueName = ${args.SolutionUniqueName} Does Not Exist`, 404, 'NotFound', {
            innerCode: '0x80040217',
          });
        }
        const app = given(args.AppUniqueName) ? appOf(store, args.AppUniqueName) : null;
        if (given(args.AppUniqueName) && !app) throw appNotFound(args.AppUniqueName);
        const level = levelOf(def);
        const levelAllowed = app
          ? [LEVEL.AppAndOrganization, LEVEL.AppOnly].includes(level)
          : [LEVEL.AppAndOrganization, LEVEL.OrganizationOnly].includes(level);
        if (def.isoverridable === false || !levelAllowed)
          throw invalid('The setting cannot be overridden at this level.'); // wording is a guess
        const stored = settingTextOf(def, value);
        await write(() => {
          const values = settingValues(store);
          if (app) values.app[`${key(app.uniquename)}|${key(def.uniquename)}`] = stored;
          else values.environment[key(def.uniquename)] = stored;
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'SaveSettingValue', {
        params: [
          ['AppUniqueName', 'Edm.String'],
          ['SettingName', 'Edm.String'],
          ['Value', 'Edm.String'],
          ['SolutionUniqueName', 'Edm.String'],
        ],
      }),
    },
    {
      name: 'RetrieveDataEncryptionKey',
      kind: 'function',
      binding: 'unbound',
      // The encryption key of the organization. The Basic User refusal text is a guess.
      handle: (c) => {
        requireAdmin(c);
        return respond(c, 'RetrieveDataEncryptionKey', { EncryptionKey: encryptionKeyOf(store) });
      },
      csdl: csdlOf('function', 'RetrieveDataEncryptionKey', { response: [['EncryptionKey', 'Edm.String']] }),
    },
    {
      name: 'SetDataEncryptionKey',
      kind: 'action',
      binding: 'unbound',
      // ponytail: change and restore both store the key; the simulator encrypts no columns, so the key is only reported back.
      handle: async (c) => {
        requireAdmin(c);
        const args = argsOf(c);
        const encryptionKey = requiredText(args.EncryptionKey, 'EncryptionKey');
        const change = args.ChangeEncryptionKey;
        if (!(typeof change === 'boolean' || change === 'true' || change === 'false'))
          throw invalid('ChangeEncryptionKey must be a Boolean.');
        await write(() => {
          dv(store).dataEncryptionKey = encryptionKey;
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'SetDataEncryptionKey', {
        params: [
          ['EncryptionKey', 'Edm.String'],
          ['ChangeEncryptionKey', 'Edm.Boolean'],
        ],
      }),
    },
    {
      name: 'InstallSampleData',
      kind: 'action',
      binding: 'unbound',
      // ponytail: no business rows are generated; the native sample row set is not reproduced. The refusal texts are guesses.
      handle: async (c) => {
        requireAdmin(c);
        await write(() => {
          const org = organizationRecord(store);
          if (!org) throw notFound('organization', orgIdOf(store));
          if (org.sampledataimportid) throw invalid('Sample data is already installed.');
          org.sampledataimportid = uuidV5(orgIdOf(store), 'sampledata');
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'InstallSampleData'),
    },
    {
      name: 'UninstallSampleData',
      kind: 'action',
      binding: 'unbound',
      handle: async (c) => {
        requireAdmin(c);
        await write(() => {
          const org = organizationRecord(store);
          if (!org?.sampledataimportid) throw invalid('Sample data is not installed.');
          org.sampledataimportid = null;
        });
        return { status: 204 };
      },
      csdl: csdlOf('action', 'UninstallSampleData'),
    },
    absoluteUrlOf(
      'sharepointsite',
      csdlOf('function', 'RetrieveAbsoluteAndSiteCollectionUrl', {
        bound: 'sharepointsite',
        response: [
          ['AbsoluteUrl', 'Edm.String'],
          ['SiteCollectionUrl', 'Edm.String'],
        ],
      }),
    ),
    // The second overload names the same response type, so the complex type is declared once.
    absoluteUrlOf(
      'sharepointdocumentlocation',
      csdlOf('function', 'RetrieveAbsoluteAndSiteCollectionUrl', {
        bound: 'sharepointdocumentlocation',
        returns: 'mscrm.RetrieveAbsoluteAndSiteCollectionUrlResponse',
      }),
    ),
    {
      name: 'RetrieveUserApplicationLicenseAccess',
      kind: 'function',
      binding: 'entity',
      entity: 'systemuser',
      // The LicenseAccessInfo JSON is empty, since no license model is simulated.
      handle: (c) => {
        const id = c.target?.id;
        if (!rowNamed(store, 'systemuser', id)) throw notFound('systemuser', id);
        const app = argsOf(c).ApplicationId;
        if (typeof app !== 'string' || !GUID_TEXT.test(app)) throw invalid('ApplicationId must be a GUID.');
        const known = tableOf(store, 'appmodule').some(
          (a) => sameId(a.appmoduleid, app) || sameId(a.appmoduleidunique, app),
        );
        if (!known) throw notFound('appmodule', app);
        return respond(c, 'RetrieveUserApplicationLicenseAccess', { LicenseAccessInfo: JSON.stringify({}) });
      },
      csdl: csdlOf('function', 'RetrieveUserApplicationLicenseAccess', {
        bound: 'systemuser',
        params: [['ApplicationId', 'Edm.Guid']],
        response: [['LicenseAccessInfo', 'Edm.String']],
      }),
    },
    {
      name: 'GenerateSocialProfile',
      kind: 'action',
      binding: 'collection',
      entity: 'socialprofile',
      // The profile for a community. The match rule (uniqueprofileid, else profilename) is a guess.
      handle: async (c) => {
        const e = argsOf(c).Entity;
        if (!e || typeof e !== 'object' || Array.isArray(e)) throw invalid('Entity is required.');
        need(c, 'socialprofile', 'Read');
        const rows = tableOf(store, 'socialprofile');
        const sameCommunity = (row) => sameId(row.community, e.community);
        const existing = given(e.uniqueprofileid)
          ? rows.find((r) => sameId(r.uniqueprofileid, e.uniqueprofileid) && sameCommunity(r))
          : given(e.profilename)
            ? rows.find((r) => sameId(r.profilename, e.profilename) && sameCommunity(r))
            : undefined;
        let id = existing?.socialprofileid;
        if (existing) {
          authorizeRead(c, 'socialprofile', existing);
        } else {
          need(c, 'socialprofile', 'Create');
          await write(async () => {
            const owner = ownerColumns(store, { id: c.user.systemuserid, logical_name: 'systemuser' });
            id = (
              await api.records.createInternal(c, 'socialprofile', { ...fieldsOf(e), ...owner }, { authorized: true })
            ).socialprofileid;
          });
        }
        const got = await readAsCaller(
          c,
          `/api/data/${c.version}/${store.resolveMapping('socialprofile').entitySet}(${id})`,
        );
        return {
          status: 200,
          body: { ...got, '@odata.context': contextUrl(c.origin, c.version, 'socialprofiles/$entity') },
        };
      },
      csdl: csdlOf('action', 'GenerateSocialProfile', {
        boundSet: 'socialprofile',
        params: [['Entity', 'mscrm.socialprofile']],
        returns: 'mscrm.socialprofile',
      }),
    },
    {
      name: 'RetrievePersonalWall',
      kind: 'function',
      binding: 'collection',
      entity: 'post',
      // The caller's own id, and the records the caller follows (postfollow rows the caller owns).
      handle: (c) => {
        const followed = tableOf(store, 'postfollow')
          .filter((f) => sameId(refId(f.ownerid), c.user.systemuserid))
          .map((f) => refId(f.regardingobjectid));
        return wall(c, [c.user.systemuserid, ...followed], null);
      },
      csdl: csdlOf('function', 'RetrievePersonalWall', {
        boundSet: 'post',
        params: WALL_PARAMS,
        returns: 'Collection(mscrm.post)',
      }),
    },
    {
      name: 'RetrieveRecordWall',
      kind: 'function',
      binding: 'collection',
      entity: 'post',
      handle: (c) => {
        const target = referenceOf(store, argsOf(c).Entity, 'Entity');
        const row = rowNamed(store, target.logical, target.id);
        if (!row) throw notFound(target.logical, target.id);
        authorizeRead(c, target.logical, row);
        return wall(c, [target.id], target.logical === 'systemuser' ? target.id : null);
      },
      csdl: csdlOf('function', 'RetrieveRecordWall', {
        boundSet: 'post',
        params: [['Entity', 'mscrm.crmbaseentity'], ...WALL_PARAMS],
        returns: 'Collection(mscrm.post)',
      }),
    },
    {
      name: 'RetrieveTimelineWallRecords',
      kind: 'function',
      binding: 'collection',
      entity: 'activitypointer',
      // The string format is a guess. ponytail: RollupType 1 and 2 are accepted and read as 0.
      handle: async (c) => {
        const args = argsOf(c);
        const xml = requiredText(args.FetchXml, 'FetchXml');
        if (given(args.RollupType) && ![0, 1, 2].includes(integerOf(args.RollupType, 'RollupType')))
          throw invalid('RollupType must be 0, 1 or 2.');
        if (given(args.Target)) {
          const target = referenceOf(store, args.Target, 'Target');
          const row = rowNamed(store, target.logical, target.id);
          if (!row) throw notFound(target.logical, target.id);
          authorizeRead(c, target.logical, row);
        }
        const { entitySet } = store.resolveMapping('activitypointer');
        const body = await readAsCaller(
          c,
          `/api/data/${c.version}/${entitySet}`,
          `?fetchXml=${encodeURIComponent(xml)}`,
        );
        return respond(c, 'RetrieveTimelineWallRecords', { TimelineWallRecords: JSON.stringify(body.value ?? []) });
      },
      csdl: csdlOf('function', 'RetrieveTimelineWallRecords', {
        boundSet: 'activitypointer',
        params: [
          ['FetchXml', 'Edm.String'],
          ['Target', 'mscrm.crmbaseentity', true],
          ['RollupType', 'Edm.Int32', true],
        ],
        response: [['TimelineWallRecords', 'Edm.String']],
      }),
    },
    {
      name: 'ExecuteFxExpression',
      kind: 'action',
      binding: 'unbound',
      // api.fxEvaluator (a function) wins; else the host's Power Fx provider (canvas-power-fx.mjs, a pack `powerFx` adapter) through
      // its synchronous path. Neither present answers 501. The response property name Result is a guess.
      handle: async (c) => {
        const args = argsOf(c);
        const expression = requiredText(args.expression, 'expression');
        const powerFx = api.providers?.powerFx;
        const evaluate =
          typeof api.fxEvaluator === 'function'
            ? api.fxEvaluator
            : typeof powerFx?.evaluateSync === 'function'
              ? (input) => ({
                  Result: powerFx.evaluateSync(input.expression, {
                    values: input.inputparameters ?? {},
                    principal: input.user?.systemuserid ?? null,
                  }).value,
                })
              : null;
        if (!evaluate)
          throw new DataError(
            'Power Fx expressions are not simulated: no evaluator is installed.',
            501,
            'NotImplemented',
            { innerCode: '0x80040216' },
          );
        const result = await evaluate({
          expression,
          entitylogicalname: args.entitylogicalname,
          context: args.context,
          inputparameters: args.inputparameters,
          outputparameters: args.outputparameters,
          user: c.user,
        });
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.crmbaseentity'),
            ...result,
          },
        };
      },
      csdl: csdlOf('action', 'ExecuteFxExpression', {
        params: [
          ['expression', 'Edm.String'],
          ['entitylogicalname', 'Edm.String'],
          ['context', 'Edm.String'],
          ['inputparameters', 'mscrm.crmbaseentity'],
          ['outputparameters', 'mscrm.crmbaseentity'],
        ],
        returns: 'mscrm.crmbaseentity',
      }),
    },
  ];
}

export function install(api) {
  for (const op of operations(api)) api.registry.register(op);
  // Internal-only message: https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/setfeaturestatus
  registerInternalMessage(api, {
    name: 'SetFeatureStatus',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['FeatureType', 'Edm.Int32'],
        ['Status', 'Edm.Boolean'],
        ['ConfigData', 'Edm.String'],
        ['IsSolutionUninstall', 'Edm.Boolean'],
      ],
    },
  });
}

export const EXTENSION = { name: 'dataverse-org-messages', install };
