const webApiReference = 'https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview';
const roleReference = 'https://learn.microsoft.com/en-us/power-pages/security/create-web-roles';
const settingsReference = 'https://learn.microsoft.com/en-us/power-pages/configure/configure-site-settings';
const environmentReference =
  'https://learn.microsoft.com/en-us/power-pages/configure/environment-variables-for-site-settings';
const cacheReference = 'https://learn.microsoft.com/en-us/power-pages/admin/site-checker-performance';
const permissionReference = 'https://learn.microsoft.com/en-us/power-pages/security/table-permissions';

export const recordRules = [
  {
    id: 'PP-API-004',
    title: 'Mixed wildcard Web API fields',
    severity: 'warning',
    category: 'security',
    confidence: 'high',
    message: 'A Web API field list contains a wildcard token alongside explicit fields.',
    remediation:
      'Remove the unsupported wildcard token and validate the required explicit column list across read and write journeys.',
    references: [webApiReference],
  },
  {
    id: 'PP-API-001',
    title: 'Unsupported wildcard Web API fields',
    severity: 'error',
    category: 'security',
    confidence: 'high',
    message: 'A Web API field setting uses the unsupported wildcard projection.',
    remediation:
      'Replace the wildcard with required column logical names; validate all read and write journeys before deploying.',
    references: [webApiReference],
  },
  {
    id: 'PP-API-002',
    title: 'Enabled Web API has no field configuration',
    severity: 'error',
    category: 'reliability',
    confidence: 'high',
    message: 'The Web API is explicitly enabled without fields or a confirmed view-based field configuration.',
    remediation:
      'Configure explicit column logical names or an eligible Power Pages Web API Columns system view on a supported site version.',
    references: [webApiReference],
  },
  {
    id: 'PP-API-003',
    title: 'Verify view-based Web API columns',
    severity: 'hint',
    category: 'security',
    confidence: 'medium',
    message:
      'Web API fields depend on a system view whose effective published columns and site-version support require verification.',
    remediation:
      'Verify the published Power Pages Web API Columns view and site version 9.8.8.x or later; explicit and view columns are combined.',
    references: [webApiReference],
  },
  {
    id: 'PP-SEC-001',
    title: 'Detailed Web API errors enabled',
    severity: 'warning',
    category: 'security',
    confidence: 'high',
    message: 'Detailed Web API inner errors are explicitly enabled.',
    remediation:
      'Disable inner errors outside a controlled diagnostic session to reduce disclosure of implementation details.',
    references: [webApiReference],
  },
  {
    id: 'PP-SEC-002',
    title: 'Default HTML encoding disabled',
    severity: 'warning',
    category: 'security',
    confidence: 'high',
    message: 'Default HTML encoding is explicitly disabled.',
    remediation:
      'Enable default HTML encoding and review intended HTML output and user-controlled Liquid values before deployment.',
    references: [settingsReference],
  },
  {
    id: 'PP-SEC-003',
    title: 'Literal identity secret in site setting',
    severity: 'warning',
    category: 'security',
    confidence: 'medium',
    message: 'An identity secret setting contains a nonempty literal value in the local export.',
    remediation:
      'Review whether the export contains a credential; use supported environment-variable or secret-backed configuration and rotate any exposed credential.',
    references: [environmentReference],
  },
  {
    // Hosted session F1 (2026-11-26): with this setting on, /_api/mspp_webroles returned the web roles of every site in the
    // environment and columns outside the fields list.
    id: 'PP-SEC-004',
    title: 'Web role table enabled for the Web API',
    severity: 'warning',
    category: 'security',
    confidence: 'high',
    message:
      'The Web API is enabled for mspp_webrole; hosted Power Pages answers it with the web roles of every site in the environment and with columns outside the configured fields list.',
    remediation:
      'Disable Webapi/mspp_webrole unless disclosing every site’s web role names and audit columns to the permitted web roles is intended; read the visitor’s own roles through Liquid user.roles instead.',
    references: [webApiReference],
  },
  {
    id: 'PP-PERF-001',
    title: 'Shared output cache explicitly disabled',
    severity: 'warning',
    category: 'performance',
    confidence: 'high',
    message: 'Header or footer output caching is explicitly disabled in the export.',
    remediation:
      'Review the effective header or footer template and enable output caching where compatible with its dynamic content.',
    references: [cacheReference],
  },
  {
    id: 'PP-ROLE-001',
    title: 'Multiple default anonymous roles',
    severity: 'error',
    category: 'security',
    confidence: 'high',
    message: 'More than one active web role is marked as the default anonymous role for this site.',
    remediation: 'Keep one intended default anonymous web role and review the table permissions assigned to it.',
    references: [roleReference],
  },
  {
    id: 'PP-ROLE-002',
    title: 'Multiple default authenticated roles',
    severity: 'error',
    category: 'security',
    confidence: 'high',
    message: 'More than one active web role is marked as the default authenticated role for this site.',
    remediation:
      'Keep one intended default authenticated web role and review permissions granted to every signed-in user.',
    references: [roleReference],
  },
  {
    // Hosted session F1 (2026-11-26, a disposable site and a partially migrated one): the security role generated for a
    // Custom Access permission keeps the root filter only; a permission filtered only through joins grants every row.
    id: 'PP-PERM-001',
    title: 'Custom Access join dropped by hosted Power Pages',
    severity: 'warning',
    category: 'security',
    confidence: 'high',
    message:
      'A Custom Access table permission filters through link-entity joins; with enhanced authorization enabled, hosted Power Pages drops the joins and keeps only the root filter, so it grants more rows than its FetchXML states (every row when it has no root predicate).',
    remediation:
      'Express the Custom Access predicate on columns of the permission table itself, or use a parent or contact scope; Mirage refuses the permission locally rather than widening it.',
    references: [permissionReference],
  },
  {
    id: 'PP-CONFIG-001',
    title: 'Ambiguous duplicate site setting',
    severity: 'warning',
    category: 'reliability',
    confidence: 'high',
    message: 'Multiple active records define the same site setting; its effective value is unresolved.',
    remediation:
      'Resolve duplicate setting records and rerun analysis; dependent conclusions are skipped until the setting is unambiguous.',
    references: [settingsReference],
  },
  {
    id: 'PP-CONFIG-002',
    title: 'Effective site setting unresolved',
    severity: 'hint',
    category: 'reliability',
    confidence: 'high',
    message:
      'A relevant site setting depends on external configuration or has an unrecognized value; dependent checks are unresolved.',
    remediation:
      'Verify the effective setting through the intended deployment configuration; analysis does not resolve environment variables or contact a tenant.',
    references: [environmentReference, webApiReference],
  },
];

export function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value.trim().toLowerCase() === 'true') return true;
  if (value.trim().toLowerCase() === 'false') return false;
  return undefined;
}

export function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function siteKey(record) {
  const website = record.fields.websiteid;
  const identity = textValue(typeof website === 'object' && website !== null ? website.id : website).toLowerCase();
  return `${record.rootId ?? 'source'}\0${identity}`;
}

export function isActive(record) {
  return record.fields.statecode !== 1 && record.fields.statecode !== '1';
}

export function isEnvironmentBacked(record) {
  const fields = record.fields;
  if (fields.source === 1 || fields.source === '1') return true;
  if (
    Object.entries(fields).some(
      ([key, value]) => key.startsWith('environmentvariable') && value !== null && value !== undefined && value !== '',
    )
  )
    return true;
  const value = textValue(fields.value);
  return /\$\{|\$\(|\{\{|^@Microsoft\.KeyVault\(|^%[^%]+%$/i.test(value);
}

function groupsBySite(records) {
  const groups = new Map();
  for (const record of records) {
    const key = siteKey(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups.values();
}

function settingIndex(records) {
  const settings = new Map();
  for (const record of records) {
    const name = textValue(record.fields.name).toLowerCase();
    if (!name) continue;
    if (!settings.has(name)) settings.set(name, []);
    settings.get(name).push(record);
  }
  return settings;
}

function booleanSetting(name) {
  return (
    /^webapi\/[^/]+\/(enabled|usefieldsfromview)$/.test(name) ||
    name === 'webapi/error/innererror' ||
    name === 'site/enabledefaulthtmlencoding' ||
    /^(header|footer)\/outputcache\/enabled$/.test(name)
  );
}

function relevantSetting(name) {
  return (
    booleanSetting(name) ||
    /^webapi\/[^/]+\/fields$/.test(name) ||
    /(?:^|\/)(?:clientsecret|appsecret|consumersecret)$/.test(name)
  );
}

function unresolvedSetting(name, record) {
  if (isEnvironmentBacked(record)) return true;
  if (booleanSetting(name)) return booleanValue(record.fields.value) === undefined;
  const value = record.fields.value;
  return value !== null && value !== undefined && typeof value !== 'string';
}

function analyzeLiteralSetting(name, record, emit) {
  const value = textValue(record.fields.value);
  const flag = booleanValue(record.fields.value);
  if (/^webapi\/[^/]+\/fields$/.test(name)) {
    if (value === '*') emit('PP-API-001', record, 'value');
    else if (value.split(',').some((token) => token.trim() === '*')) emit('PP-API-004', record, 'value');
  }
  if (name === 'webapi/error/innererror' && flag === true) emit('PP-SEC-001', record, 'value');
  if (name === 'webapi/mspp_webrole/enabled' && flag === true) emit('PP-SEC-004', record, 'value');
  if (name === 'site/enabledefaulthtmlencoding' && flag === false) emit('PP-SEC-002', record, 'value');
  if (/^(header|footer)\/outputcache\/enabled$/.test(name) && flag === false) emit('PP-PERF-001', record, 'value');
  if (/(?:^|\/)(?:clientsecret|appsecret|consumersecret)$/.test(name) && value) emit('PP-SEC-003', record, 'value');
}

function knownSetting(settings, name) {
  const entries = settings.get(name);
  if (!entries) return { missing: true };
  if (entries.length !== 1 || unresolvedSetting(name, entries[0])) return { unresolved: true };
  return { record: entries[0] };
}

function analyzeWebApiConfiguration(settings, name, record, emit) {
  const match = /^webapi\/([^/]+)\/enabled$/.exec(name);
  if (!match || booleanValue(record.fields.value) !== true) return;
  const fields = knownSetting(settings, `webapi/${match[1]}/fields`);
  const view = knownSetting(settings, `webapi/${match[1]}/usefieldsfromview`);
  if (fields.unresolved || view.unresolved) return;
  const usesView = view.record && booleanValue(view.record.fields.value) === true;
  if (usesView) emit('PP-API-003', view.record, 'value');
  else if (fields.missing || !textValue(fields.record.fields.value)) emit('PP-API-002', record, 'value');
}

function analyzeSiteSettings(settings, emit) {
  for (const [name, entries] of settings) {
    if (entries.length > 1) {
      for (const record of entries) emit('PP-CONFIG-001', record, 'name');
      continue;
    }
    if (!relevantSetting(name)) continue;
    const record = entries[0];
    if (unresolvedSetting(name, record)) {
      emit('PP-CONFIG-002', record, 'value');
      continue;
    }
    analyzeLiteralSetting(name, record, emit);
    analyzeWebApiConfiguration(settings, name, record, emit);
  }
}

function analyzeSettings(records, emit) {
  for (const siteRecords of groupsBySite(records)) analyzeSiteSettings(settingIndex(siteRecords), emit);
}

function roleIdentity(record) {
  const id = record.id || record.fields.id || record.fields.webroleid;
  return textValue(id).toLowerCase() || `${record.file}:${record.line}:${record.column}`;
}

function analyzeRoles(records, emit) {
  for (const siteRecords of groupsBySite(records)) {
    for (const [field, rule] of [
      ['anonymoususersrole', 'PP-ROLE-001'],
      ['authenticatedusersrole', 'PP-ROLE-002'],
    ]) {
      const defaults = siteRecords.filter((record) => booleanValue(record.fields[field]) === true);
      const identities = new Set(defaults.map(roleIdentity));
      if (identities.size > 1) for (const record of defaults) emit(rule, record, field);
    }
  }
}

const CUSTOM_ACCESS_SCOPE = '756150005';

function analyzePermissions(records, emit) {
  for (const record of records) {
    const scope = record.fields.scope;
    const value = textValue(
      typeof scope === 'object' && scope !== null ? String(scope.value ?? '') : String(scope ?? ''),
    );
    if (value === CUSTOM_ACCESS_SCOPE && /<\s*link-entity\b/i.test(textValue(record.fields.permissionfetchxml)))
      emit('PP-PERM-001', record, 'permissionfetchxml');
  }
}

export function analyzeRecords(records, emit) {
  const active = records.filter(isActive);
  analyzeSettings(
    active.filter((record) => record.kind === 'sitesetting'),
    emit,
  );
  analyzeRoles(
    active.filter((record) => record.kind === 'webrole'),
    emit,
  );
  analyzePermissions(
    active.filter((record) => record.kind === 'tablepermission'),
    emit,
  );
}
