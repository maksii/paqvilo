// Metadata-only platform back-references for ordinary source-defined custom user-owned tables.
// Never install these declarations in DataStore relationships or the CRUD/cascade graph.
// Names and lookup columns follow the pinned standard relationship catalogue.
const REFERENCES = [
  ['SyncErrors', 'syncerror', 'regardingobjectid', 'Cascade'],
  ['AsyncOperations', 'asyncoperation', 'regardingobjectid', 'NoCascade'],
  ['MailboxTrackingFolders', 'mailboxtrackingfolder', 'regardingobjectid', 'Cascade'],
  ['UserEntityInstanceDatas', 'userentityinstancedata', 'objectid', 'Cascade'],
  ['ProcessSession', 'processsession', 'regardingobjectid', 'NoCascade'],
  ['BulkDeleteFailures', 'bulkdeletefailure', 'regardingobjectid', 'Cascade', false],
  ['PrincipalObjectAttributeAccesses', 'principalobjectattributeaccess', 'objectid', 'Cascade', false],
];
const typeOf = (field) =>
  String(field?.columnMetadata?.type ?? field?.dataverseType ?? field?.type ?? '').toLowerCase();

/** Missing records in the normalized metadata relationship format. Source SchemaNames remain authoritative. */
export function implicitRelationships(source, { existing = [] } = {}) {
  const tableType =
    source.s?.tableType ??
    source.m?.tableType ??
    source.m?.dataverseMetadata?.TableType ??
    source.def?.tableType ??
    'Standard';
  const userOwned = source.ownership === 'user' || source.ownershipType === 'UserOwned';
  if (
    !source.s ||
    source.def ||
    !/^[a-z0-9]+_/.test(source.logical) ||
    source.s.isCustomEntity === false ||
    !userOwned ||
    source.isVirtual ||
    (source.isVirtual == null && tableType === 'Virtual') ||
    tableType === 'Elastic' ||
    source.s.isIntersect ||
    source.m?.intersect ||
    source.s.isActivity
  )
    return [];
  const templates = [...REFERENCES];
  if (Object.values(source.fields ?? {}).some((field) => typeOf(field) === 'file'))
    templates.push(['FileAttachments', 'fileattachment', 'objectid', 'Cascade', true, '1.0.0.0', 2]);
  // Enabling duplicate detection controls execution, not whether the platform back-reference schema exists.
  templates.push(
    ['DuplicateMatchingRecord', 'duplicaterecord', 'duplicaterecordid', 'Cascade', true, '1.0'],
    ['DuplicateBaseRecord', 'duplicaterecord', 'baserecordid', 'Cascade', true, '1.0'],
  );
  const names = new Set(existing.map((name) => String(name).toLowerCase()));
  return templates
    .map(([suffix, entity, attribute, deletion, advancedFind = true, version = '1.0.0.0', behavior = 0]) => {
      const name = `${source.logical}_${suffix}`;
      return {
        type: '1:N',
        schemaName: name,
        referencedEntity: source.logical,
        referencedAttribute: source.idColumn,
        referencingEntity: entity,
        referencingAttribute: attribute,
        referencedNav: name,
        referencingNav: `${attribute}_${source.logical}`,
        relationshipBehavior: behavior,
        cascade: { delete: deletion },
        isCustomRelationship: false,
        isValidForAdvancedFind: advancedFind,
        introducedVersion: version,
      };
    })
    .filter((relationship) => !names.has(relationship.schemaName.toLowerCase()));
}
