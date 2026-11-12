// Feature controls, the mobile-offline profile clone, cards, the NPS rating, and the Power BI, Finance and Operations, analytics
// and ALM messages. Every operation is registered through registerAddon (dataverse-addon-common.mjs), so a trusted
// pack's dataverseMessages handler replaces it. The feature-control shapes, probe answers, card defaults and the profile clone
// are not confirmed natively.
// ponytail: GetFeatureControlStringSettingsForNamespaceWithUserContext ignores its setting names and additional filters.
import { DataError } from './data-error.mjs';
import { argsOf, featureNotEnabled, registerAddon, STAMPED_COLUMNS } from './dataverse-addon-common.mjs';
import { privilegeDeniedError } from './dataverse-security.mjs';

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const notFound = (logical, id) =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id, innerCode: '0x80040217' });
const ADMIN_ROLE = 'System Administrator';
// The tables of a mobile offline profile clone, the profile first.
const PROFILE_TABLES = [
  'mobileofflineprofile',
  'mobileofflineprofileitem',
  'mobileofflineprofileitemassociation',
  'mobileofflineprofileitemfilter',
];
// A copy of a stored row for a create: its declared columns without the primary key and the stamped columns.
function copyOf(store, logical, row) {
  const { idColumn } = store.resolveMapping(logical);
  const known = store.fieldDefinitions(logical);
  return Object.fromEntries(
    Object.entries(row).filter(
      ([name]) => Object.hasOwn(known, name) && name !== idColumn && !STAMPED_COLUMNS.has(name),
    ),
  );
}

// Feature control setting: a featurecontrolsetting row's uniquename is the namespace, its content the JSON object { "<name>": value }.
// Only active rows (statecode 0) count.
function settingsOf(store) {
  const settings = [];
  for (const row of store.state.tables.featurecontrolsetting ?? []) {
    if (row.statecode !== 0) continue;
    let values;
    try {
      values = JSON.parse(row.content || '{}');
    } catch {
      continue;
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [name, value] of Object.entries(values)) settings.push({ namespace: row.uniquename, name, value });
  }
  return settings;
}

// Type names are ours: the native mscrm.Type is an empty complex type.
function typeOf(value) {
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Decimal';
  return 'String';
}

// The CSDL declares Value as Edm.String (mscrm.Object is not expressible), so every value is sent as a string.
const asSetting = (s) => ({ Type: typeOf(s.value), Value: String(s.value), Name: s.name, NamespaceValue: s.namespace });
const asStringSetting = (s) => ({
  TypeName: typeOf(s.value),
  Value: String(s.value),
  Name: s.name,
  NamespaceValue: s.namespace,
});

// The two shared complex types, declared once (by the first feature-control operation below).
const FEATURE_TYPES =
  '<ComplexType Name="FeatureControlSettingData"><Property Name="Type" Type="Edm.String" /><Property Name="Value" Type="Edm.String" />' +
  '<Property Name="Name" Type="Edm.String" /><Property Name="NamespaceValue" Type="Edm.String" /></ComplexType>' +
  '<ComplexType Name="FeatureControlStringSettingData"><Property Name="TypeName" Type="Edm.String" /><Property Name="Value" Type="Edm.String" />' +
  '<Property Name="Name" Type="Edm.String" /><Property Name="NamespaceValue" Type="Edm.String" /></ComplexType>';

function operations(api) {
  const { store } = api;
  const tableOf = (logical) => (store.state.tables[logical] ??= []);
  const rowIn = (logical, pk, id) => tableOf(logical).find((row) => sameId(row[pk], id)) ?? null;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const cardOf = (id) => {
    const row = rowIn('card', 'cardid', id);
    if (!row) throw notFound('card', id);
    return row;
  };
  const namespaceOf = (name) => settingsOf(store).filter((s) => s.namespace === name);
  // The privilege and row check of the CRUD path for one operation, made before any read or write.
  const requireAccess = (c, logical, operation, row) =>
    api.principals.authorize({ user: c.user, entity: logical, operation, row, mapping: store.resolveMapping(logical) });
  // The System Administrator role check of dataverse-security-messages2.mjs; the privilege name in the refusal is a guess.
  const requireSystemAdministrator = (c) => {
    if (!api.principals.roles(c.user).some((role) => role.name === ADMIN_ROLE))
      throw privilegeDeniedError(c.user, 'prvSystemAdministrator', 'organization');
  };
  // Creates a copy of each row through the create rule of the caller; returns the new primary key of each old one.
  async function copyRows(c, logical, rows, columnsOf) {
    const { idColumn } = store.resolveMapping(logical);
    const ids = new Map();
    for (const row of rows) {
      const copy = await api.records.createInternal(c, logical, columnsOf(row), { authorized: true });
      ids.set(key(row[idColumn]), copy[idColumn]);
    }
    return ids;
  }

  // Clone of a mobile offline profile: the profile, its items, their associations and the filters on them, under new ids.
  // The source and every table are checked for the caller first; each copy is written through the create rule.
  async function cloneProfile(c, source) {
    requireAccess(c, 'mobileofflineprofile', 'read', source);
    for (const logical of PROFILE_TABLES) requireAccess(c, logical, 'create');
    const name = `${source.name} (Copy)`;
    if (name.length > 200) {
      throw new DataError(
        'A validation error occurred. The length of the Name attribute of the mobileofflineprofile entity exceeded the maximum allowed length of 200.',
        400,
        'InvalidRequest',
        { innerCode: '0x80071112' },
      );
    }
    const items = tableOf('mobileofflineprofileitem').filter((row) =>
      sameId(row.regardingobjectid, source.mobileofflineprofileid),
    );
    const onCopiedItem = (row) =>
      items.some((item) => sameId(item.mobileofflineprofileitemid, row.mobileofflineprofileitemid));
    const associations = tableOf('mobileofflineprofileitemassociation').filter(onCopiedItem);
    const filters = tableOf('mobileofflineprofileitemfilter').filter(
      (row) => onCopiedItem(row) || sameId(row.mobileofflineprofileid, source.mobileofflineprofileid),
    );
    return write(async () => {
      const profile = await api.records.createInternal(
        c,
        'mobileofflineprofile',
        { ...copyOf(store, 'mobileofflineprofile', source), name },
        { authorized: true },
      );
      const profileId = profile.mobileofflineprofileid;
      const itemIds = await copyRows(c, 'mobileofflineprofileitem', items, (row) => ({
        ...copyOf(store, 'mobileofflineprofileitem', row),
        regardingobjectid: profileId,
      }));
      await copyRows(c, 'mobileofflineprofileitemassociation', associations, (row) => ({
        ...copyOf(store, 'mobileofflineprofileitemassociation', row),
        mobileofflineprofileitemid: itemIds.get(key(row.mobileofflineprofileitemid)),
      }));
      await copyRows(c, 'mobileofflineprofileitemfilter', filters, (row) => ({
        ...copyOf(store, 'mobileofflineprofileitemfilter', row),
        mobileofflineprofileid: profileId,
        mobileofflineprofileitemid: itemIds.get(key(row.mobileofflineprofileitemid)) ?? row.mobileofflineprofileitemid,
      }));
      return profile;
    });
  }

  return [
    // Feature controls (read-only). The first operation also declares the shared complex types.
    {
      name: 'RetrieveFeatureControlSetting',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['NamespaceValue', 'Edm.String'],
          ['FeatureControlName', 'Edm.String'],
        ],
        response: [['FeatureControlSetting', 'mscrm.FeatureControlSettingData']],
      },
      csdl:
        FEATURE_TYPES +
        '<ComplexType Name="RetrieveFeatureControlSettingResponse"><Property Name="FeatureControlSetting" Type="mscrm.FeatureControlSettingData" /></ComplexType>' +
        '<Action Name="RetrieveFeatureControlSetting"><Parameter Name="NamespaceValue" Type="Edm.String" /><Parameter Name="FeatureControlName" Type="Edm.String" />' +
        '<ReturnType Type="mscrm.RetrieveFeatureControlSettingResponse" Nullable="false" /></Action>',
      handle: async (c) => {
        const { NamespaceValue, FeatureControlName } = argsOf(c);
        const found = namespaceOf(NamespaceValue).find((s) => s.name === FeatureControlName);
        return { FeatureControlSetting: found ? asSetting(found) : null };
      },
    },
    {
      name: 'RetrieveFeatureControlSettings',
      kind: 'action',
      binding: 'unbound',
      // The native name filter is not known; here the name matches exactly, so the collection has one entry or none.
      signature: {
        params: [
          ['NamespaceValue', 'Edm.String'],
          ['FeatureControlName', 'Edm.String'],
        ],
        response: [['FeatureControlSettingCollection', 'Collection(mscrm.FeatureControlSettingData)']],
      },
      handle: async (c) => {
        const { NamespaceValue, FeatureControlName } = argsOf(c);
        return {
          FeatureControlSettingCollection: namespaceOf(NamespaceValue)
            .filter((s) => s.name === FeatureControlName)
            .map(asSetting),
        };
      },
    },
    {
      name: 'RetrieveFeatureControlSettingsByNamespace',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [['NamespaceName', 'Edm.String']],
        response: [['FeatureControlSettingCollection', 'Collection(mscrm.FeatureControlSettingData)']],
      },
      handle: async (c) => ({ FeatureControlSettingCollection: namespaceOf(argsOf(c).NamespaceName).map(asSetting) }),
    },
    {
      name: 'RetrieveBoolFeatureControlSetting',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['NamespaceValue', 'Edm.String'],
          ['FeatureControlName', 'Edm.String'],
        ],
        response: [['IsEnabled', 'Edm.Boolean']],
      },
      handle: async (c) => {
        const { NamespaceValue, FeatureControlName } = argsOf(c);
        const found = namespaceOf(NamespaceValue).find((s) => s.name === FeatureControlName);
        return { IsEnabled: found?.value === true };
      },
    },
    {
      name: 'RetrieveFeatureControlStringSettings',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [],
        response: [['FeatureControlStringSettingCollection', 'Collection(mscrm.FeatureControlStringSettingData)']],
      },
      handle: async () => ({ FeatureControlStringSettingCollection: settingsOf(store).map(asStringSetting) }),
    },
    {
      name: 'RetrieveFeatureControlStringSettingsForNamespace',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [['NamespaceName', 'Edm.String']],
        response: [['FeatureControlStringSettingCollection', 'Collection(mscrm.FeatureControlStringSettingData)']],
      },
      handle: async (c) => ({
        FeatureControlStringSettingCollection: namespaceOf(argsOf(c).NamespaceName).map(asStringSetting),
      }),
    },
    {
      name: 'GetFeatureControlStringSettingsForNamespaceWithUserContext',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['NamespaceName', 'Edm.String'],
          ['FeatureControlSettingNames', 'Collection(Edm.String)'],
          ['AdditionalFilterNames', 'Collection(Edm.String)'],
          ['AdditionalFilterValues', 'Collection(Edm.String)'],
        ],
        response: [['FeatureControlStringSettingCollection', 'Collection(mscrm.FeatureControlStringSettingData)']],
      },
      handle: async (c) => ({
        FeatureControlStringSettingCollection: namespaceOf(argsOf(c).NamespaceName).map(asStringSetting),
      }),
    },
    // Documented "For internal use only."; store-backed here.
    {
      name: 'UpdateFeatureConfig',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['FeatureType', 'Edm.Int32'],
          ['ConfigData', 'Edm.String'],
        ],
      },
      handle: async (c) => {
        requireSystemAdministrator(c);
        const { FeatureType, ConfigData } = argsOf(c);
        await write(() => {
          store.state.dataverse ??= {};
          store.state.dataverse.featureConfig ??= {};
          store.state.dataverse.featureConfig[FeatureType] = ConfigData;
        });
        return undefined;
      },
    },
    // Documented "For internal use only."; store-backed here.
    {
      name: 'CloneMobileOfflineProfile',
      kind: 'action',
      binding: 'entity',
      entity: 'mobileofflineprofile',
      signature: { params: [], returns: 'mscrm.mobileofflineprofile' },
      handle: async (c) => ({ ...(await cloneProfile(c, c.target.row)) }),
    },
    // Cards.
    {
      name: 'CardCreateClone',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['CardName', 'Edm.String'],
          ['CardId', 'Edm.String'],
        ],
        response: [['CardIdClone', 'Edm.String']],
      },
      handle: async (c) => {
        const { CardName, CardId } = argsOf(c);
        const card = cardOf(CardId);
        requireAccess(c, 'card', 'read', card);
        requireAccess(c, 'card', 'create');
        const copy = await write(() =>
          api.records.createInternal(
            c,
            'card',
            { ...copyOf(store, 'card', card), name: CardName },
            { authorized: true },
          ),
        );
        return { CardIdClone: copy.cardid };
      },
    },
    {
      name: 'CardGetFullJson',
      kind: 'action',
      binding: 'unbound',
      signature: { params: [['CardId', 'Edm.String']], response: [['CardFullJson', 'Edm.String']] },
      handle: async (c) => {
        const card = cardOf(argsOf(c).CardId);
        requireAccess(c, 'card', 'read', card);
        return { CardFullJson: card.appdefinition ?? null };
      },
    },
    {
      name: 'ImportCardTypeSchema',
      kind: 'action',
      binding: 'unbound',
      signature: { params: [['ImportCardTypeSchema', 'Edm.String']], response: [['GUID', 'Edm.Guid']] },
      fallback: featureNotEnabled,
    },
    // NPS: no table holds the rating, so a valid score has no store effect. The 400 message and its code are guesses.
    {
      name: 'CreateNPSUserRating',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['Score', 'Edm.Int32'],
          ['Comment', 'Edm.String'],
          ['AppModuleId', 'Edm.String'],
          ['Browser', 'Edm.String'],
          ['Device', 'Edm.String'],
        ],
      },
      handle: async (c) => {
        const { Score } = argsOf(c);
        const score = Number(Score);
        if (Score == null || !Number.isInteger(score) || score < 0 || score > 10)
          throw invalid('Score must be an integer from 0 to 10.');
        return undefined;
      },
    },
    // Power BI, Finance and Operations, analytics and ALM: a pack handler answers them, otherwise the feature is not enabled.
    {
      name: 'GetPBIReportRefreshStatus',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [['ReportId', 'Edm.Guid']],
        response: [
          ['ReportRefreshStatusState', 'Edm.String'],
          ['ReportRefreshStatusStartTime', 'Edm.String'],
          ['ReportRefreshStatusEndTime', 'Edm.String'],
        ],
      },
      fallback: featureNotEnabled,
    },
    {
      name: 'PBIAutoRefreshDataset',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['AutoRefreshParameters', 'Edm.String'],
          ['ReportId', 'Edm.Guid'],
        ],
        response: [['HttpResponse', 'Edm.String']],
      },
      fallback: featureNotEnabled,
    },
    {
      name: 'SnapshotDatasource',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [['SourceDatalakeFolderUniqueName', 'Edm.String']],
        response: [['SnapshotReference', 'Edm.String']],
      },
      fallback: featureNotEnabled,
    },
    {
      name: 'AlmHandler',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['action', 'Edm.String'],
          ['input', 'Edm.String'],
        ],
        response: [['result', 'Edm.String']],
      },
      fallback: featureNotEnabled,
    },
    {
      name: 'install',
      kind: 'action',
      binding: 'entity',
      entity: 'workflow',
      signature: {
        params: [
          ['connectionReferences', 'Edm.String'],
          ['appIds', 'Edm.String'],
          ['context', 'Edm.String'],
          ['expand', 'Edm.String'],
        ],
        response: [
          ['flowTriggerUri', 'Edm.String'],
          ['connectionId', 'Edm.String'],
          ['stringifiedConnectionObject', 'Edm.String'],
        ],
      },
      fallback: featureNotEnabled,
    },
    // Deterministic probes (guessed values).
    {
      name: 'RetrieveAnalyticsStoreDetails',
      kind: 'function',
      binding: 'unbound',
      csdl:
        '<ComplexType Name="AnalyticsStoreDetails"><Property Name="Endpoint" Type="Edm.String" /></ComplexType>' +
        '<ComplexType Name="RetrieveAnalyticsStoreDetailsResponse"><Property Name="AnalyticsStoreDetails" Type="mscrm.AnalyticsStoreDetails" /></ComplexType>' +
        '<Function Name="RetrieveAnalyticsStoreDetails"><ReturnType Type="mscrm.RetrieveAnalyticsStoreDetailsResponse" Nullable="false" /></Function>',
      handle: async () => ({ AnalyticsStoreDetails: { Endpoint: null } }),
    },
    {
      name: 'RetrieveFinanceAndOperationsIntegrationDetails',
      kind: 'function',
      binding: 'unbound',
      signature: {
        response: [
          ['IsUnifiedDatabase', 'Edm.Boolean'],
          ['Id', 'Edm.String'],
          ['TenantId', 'Edm.String'],
          ['Url', 'Edm.String'],
          ['OrgLifecycleStatus', 'Edm.String'],
        ],
      },
      handle: async () => ({ IsUnifiedDatabase: false, Id: null, TenantId: null, Url: null, OrgLifecycleStatus: null }),
    },
  ];
}

function install(api) {
  for (const op of operations(api)) registerAddon(api, op);
}

export const EXTENSION = { name: 'dataverse-addon-featurecontrol', install };
