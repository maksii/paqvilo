// The platform setting definitions and the validation of their overrides: a table and a check, with no organization
// state. The `platform` settings contract (platform-config.mjs) validates through it without loading the query engine;
// platform-settings.mjs re-exports validatePlatformOverrides and resolves the values of a running organization.
import { DataError } from './data-error.mjs';

const learn = 'https://learn.microsoft.com/en-us/';
const organization = learn + 'power-apps/developer/data-platform/organization-table';
const files = learn + 'power-apps/developer/data-platform/attachment-annotation-files#file-size-limits';
const fileTypes = learn + 'power-apps/developer/data-platform/files-images-overview';
const fetch = learn + 'power-apps/developer/data-platform/fetchxml/';
const support =
  'https://support.microsoft.com/en-au/topic/timeline-does-not-render-and-shows-records-could-not-be-loaded-4ce9200a-1afe-3ef4-ac11-a74b91f4f40c';
const item = (key, { type, defaultValue, access, coverage, source, description, extra = {} }) => ({
  key,
  type,
  defaultValue,
  access,
  coverage,
  source,
  description,
  ...extra,
});

/** Curated feature-documented controls, not every writable Organization column. */
export const PLATFORM_SETTINGS = Object.freeze([
  item('BypassBusinessLogicExecutionStepIdsLimit', {
    type: 'integer',
    defaultValue: 3,
    access: 'OrgDbOrgSettings',
    coverage: 'Selective synchronous and asynchronous plug-in step bypass',
    source: learn + 'power-apps/developer/data-platform/bypass-custom-business-logic#limit-on-the-number-of-steps',
    description:
      'Maximum step IDs supplied for one operation. Microsoft recommends no more than ten; exported organization settings remain authoritative.',
    extra: { min: 0, max: 2147483647, orgDbOrgSetting: true },
  }),
  item('QueryLinkEntityLimit', {
    type: 'integer',
    defaultValue: 15,
    access: 'Microsoft support request',
    coverage: 'FetchXML and SDK QueryExpression joins',
    source: support,
    description: 'Organization-wide support-managed join budget. Raising it here simulates an approved support change.',
    extra: { min: 1, max: 1000 },
  }),
  item('MaxUploadFileSize', {
    type: 'integer',
    defaultValue: 5242880,
    access: 'Organization setting',
    coverage: 'Annotation and ActivityMimeAttachment writes',
    source: files,
    description: 'Maximum base64-encoded attachment size in bytes; file/image columns have separate limits.',
    extra: { min: 1, max: 131072000, column: 'maxuploadfilesize' },
  }),
  item('BlockedAttachments', {
    type: 'string',
    defaultValue: '',
    access: 'Organization setting',
    coverage: 'Annotation and ActivityMimeAttachment writes',
    source: fileTypes,
    description:
      'Semicolon-separated blocked extensions, without dots. Empty local default; use the organization row or an override for the actual environment list.',
    extra: { column: 'blockedattachments' },
  }),
  item('BlockedMimeTypes', {
    type: 'string',
    defaultValue: '',
    access: 'Organization setting',
    coverage: 'Annotation and ActivityMimeAttachment writes',
    source: fileTypes,
    description: 'Semicolon-separated blocked MIME types.',
    extra: { column: 'blockedmimetypes' },
  }),
  item('AllowedMimeTypes', {
    type: 'string',
    defaultValue: '',
    access: 'Organization setting',
    coverage: 'Annotation and ActivityMimeAttachment writes',
    source: fileTypes,
    description: 'Semicolon-separated allowed MIME types; empty means no allowlist.',
    extra: { column: 'allowedmimetypes' },
  }),
  ...[
    ['AuditSettings', 'string', 'auditsettings'],
    ['IsAuditEnabled', 'boolean', 'isauditenabled'],
    ['IsUserAccessAuditEnabled', 'boolean', 'isuseraccessauditenabled'],
    ['AuditRetentionPeriodV2', 'integer', 'auditretentionperiodv2'],
    ['UserAccessAuditingInterval', 'integer', 'useraccessauditinginterval'],
    ['PluginTraceLogSetting', 'integer', 'plugintracelogsetting'],
    ['QuickFindRecordLimitEnabled', 'boolean', 'quickfindrecordlimitenabled'],
    ['ShareToPreviousOwnerOnAssign', 'boolean', 'sharetopreviousowneronassign'],
    ['ExpireChangeTrackingInDays', 'integer', 'expirechangetrackingindays'],
    ['ExpireSubscriptionsInDays', 'integer', 'expiresubscriptionsindays'],
    ['IsExternalSearchIndexEnabled', 'boolean', 'isexternalsearchindexenabled'],
  ].map(([key, type, column]) =>
    item(key, {
      type,
      defaultValue: null,
      access: 'Organization setting',
      coverage: 'Catalogue only; behaviour not simulated',
      source: organization,
      description:
        'Feature-documented organization option. Stored and reported for scenario provenance; changing it does not invent the associated service.',
      extra: {
        column,
        ...(type === 'integer' ? { min: 0, max: 2147483647 } : {}),
        ...(key === 'PluginTraceLogSetting' ? { min: 0, max: 2 } : {}),
        ...(key === 'AuditRetentionPeriodV2' ? { min: -1 } : {}),
      },
    }),
  ),
  ...['AllowSaveAsDraftAppointment', 'AutoTrackSentFolderItems'].map((key) =>
    item(key, {
      type: 'boolean',
      defaultValue: false,
      access: 'OrgDBOrgSettings tool',
      coverage: 'Catalogue only; Exchange synchronization not simulated',
      source: learn + 'power-platform/admin/orgdborgsettings',
      description:
        'Documented server-side synchronization option; change through the supported OrganizationSettingsEditor tool in a real environment.',
    }),
  ),
  item('WorkflowSettings.MaxDepth', {
    type: 'integer',
    defaultValue: 8,
    access: 'On-premises deployment PowerShell',
    coverage: 'Catalogue only; CLR/async safety bounds remain independent',
    source: learn + 'dotnet/api/microsoft.xrm.sdk.iexecutioncontext.depth',
    description: 'Documented legacy deployment control; not presented as a self-service cloud organization setting.',
    extra: { min: 1, max: 32 },
  }),
  item('FetchConditionLimit', {
    type: 'integer',
    defaultValue: 500,
    access: 'Simulator experiment',
    coverage: 'FetchXML condition/link count',
    source: fetch + 'filter-rows',
    description:
      'Documented default limit; this local override is not a claim of a supported cloud administration setting.',
    extra: { min: 1, max: 10000 },
  }),
  item('FetchLinkAndFilterLimit', {
    type: 'integer',
    defaultValue: 27,
    access: 'Simulator experiment',
    coverage: 'FetchXML ordinary joins plus existential filter links',
    source: null,
    description:
      'Combined native admission bound independently reported by the backend conversion error. Separate from the ordinary join limit; this local override is not a cloud administration setting.',
    extra: { min: 1, max: 1000 },
  }),
  item('AggregateQueryRecordLimit', {
    type: 'integer',
    defaultValue: 50000,
    access: 'Simulator experiment',
    coverage: 'FetchXML aggregates only',
    source: fetch + 'aggregate-data',
    description:
      'Documented FetchXML aggregate bound. Local override; no inferred cloud support ticket entitlement. OData aggregate limits remain separate.',
    extra: { min: 1, max: 1000000 },
  }),
  item('FetchLinkDepth', {
    type: 'integer',
    defaultValue: 32,
    access: 'Simulator safety bound',
    coverage: 'FetchXML nesting',
    source: fetch + 'join-tables',
    description: 'Local execution bound, not a documented Dataverse organization option.',
    extra: { min: 1, max: 60 },
  }),
  item('FetchJoinRowLimit', {
    type: 'integer',
    defaultValue: 250000,
    access: 'Simulator safety bound',
    coverage: 'Intermediate FetchXML joined rows',
    source: null,
    description: 'Local memory protection; exceeding it fails rather than truncating rows.',
    extra: { min: 1, max: 1000000, stateSetting: 'fetchJoinRowLimit' },
  }),
]);
const definitions = new Map(PLATFORM_SETTINGS.map((x) => [x.key, x]));
export function validatePlatformOverrides(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DataError('Platform overrides must be an object.', 400, 'InvalidPlatformSetting');
  for (const [key, v] of Object.entries(value)) {
    const d = definitions.get(key);
    if (!d) throw new DataError('Unknown platform setting: ' + key, 400, 'InvalidPlatformSetting');
    if (
      (d.type === 'integer' && (!Number.isSafeInteger(v) || v < d.min || v > d.max)) ||
      (d.type === 'boolean' && typeof v !== 'boolean') ||
      (d.type === 'string' && (typeof v !== 'string' || v.length > 8192))
    )
      throw new DataError('Invalid value for platform setting ' + key, 400, 'InvalidPlatformSetting');
  }
  return value;
}
