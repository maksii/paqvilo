import { createHash } from 'node:crypto';
import { parseXmlDocument } from 'paqvilo/mirage/lib/fetchxml-engine.mjs';
import { odataRequest } from './core.mjs';

const identifier = /^[a-z][a-z0-9_]*$/i;
const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lowerName = (column) => column.name ?? column.LogicalName ?? column.schemaName?.toLowerCase();

export function sourceODataColumns(schema, tableName) {
  const table = schema.tables.find((table) => table.name === tableName);
  if (!table) throw new Error('The OData root is absent from the source schema.');
  const columns = new Map(table.columns.map((column) => [lowerName(column), column]));
  const primaryId = `${tableName}id`,
    primaryName =
      table.primaryName?.name ??
      { account: 'name', contact: 'fullname', transactioncurrency: 'currencyname' }[tableName];
  columns.set(primaryId, { name: primaryId, type: 'guid', nullable: false });
  if (primaryName) columns.set(primaryName, { name: primaryName, type: 'string' });
  for (const relationship of schema.relationships.filter(
    (relationship) => relationship.kind === 'oneToMany' && relationship.child === tableName,
  ))
    columns.set(relationship.lookup.name, {
      name: relationship.lookup.name,
      type: 'lookup',
      targets: [relationship.parent],
    });
  return { table, columns, primaryId, primaryName };
}

/** Genuine root attributes only. An aggregate alias is not an entity property,
 * and lookup values use the documented _logicalname_value OData spelling. */
export function sourceODataSelection({ schema, table, fields }) {
  const metadata = sourceODataColumns(schema, table),
    rejected = [],
    selected = new Map();
  for (const field of fields) {
    const logical = field.logicalName ?? field.source ?? field.name;
    if (!identifier.test(logical ?? '') || field.aggregate || !metadata.columns.has(logical)) {
      rejected.push({
        field: field.name,
        source: logical,
        reason: field.aggregate ? 'aggregate-expression' : 'not-a-root-entity-column',
      });
      continue;
    }
    const column = metadata.columns.get(logical);
    if (column.IsValidForRead === false || column.isValidForRead === false) {
      rejected.push({ field: field.name, source: logical, reason: 'not-valid-for-read' });
      continue;
    }
    const lookup =
      column.type === 'lookup' ||
      column.AttributeType === 'Lookup' ||
      column.AttributeType === 'Customer' ||
      column.AttributeType === 'Owner';
    const property = lookup ? `_${logical}_value` : logical;
    const type = lookup
      ? 'guid'
      : column.behavior === 'DateOnly'
        ? 'dateonly'
        : column.type === 'choice'
          ? 'integer'
          : (column.type ?? 'string');
    // Names intentionally match native response properties. Existing canonical
    // row handling can consume these without inventing FetchXML aliases.
    selected.set(property, {
      name: property,
      source: property,
      logicalName: logical,
      type,
      nullable: logical !== metadata.primaryId,
      precision: column.precision ?? (type === 'money' ? 2 : 4),
    });
  }
  return { fields: [...selected.values()], select: [...selected.keys()], rejected };
}

/** Additional well-formed probes, never replacements for the eight original
 * authored OData cases. Native deep-parent CDS failures remain possible even
 * after query authoring, property names and request lengths are corrected. */
export function compilePositiveODataProbes({ manifest, schema, catalogue, visibleIdsByTable = {} }) {
  if (manifest.odataVariants.length !== 8)
    throw new Error('This fixed-source extension requires the original eight OData cases.');
  return manifest.odataVariants.map((original) => {
    const metadata = sourceODataColumns(schema, original.table);
    if (!metadata.primaryName) throw new Error('OData marker correlation requires an actual primary-name column.');
    const base = manifest.cases.find((plan) => plan.id === original.baseCaseId);
    if (!base) throw new Error('Original OData case has no paired source query.');
    // Use the original query catalogue's root projection, since a recording
    // deployment may deliberately optimize manifest fields to primary IDs.
    const sourceQuery = catalogue.queries.find((query) => query.id === original.baseCaseId)?.fetchXml ?? base.fetchXml;
    const root = parseXmlDocument(sourceQuery, { root: 'fetch' }).children.find((element) => element.name === 'entity');
    const requested = root.children
      .filter((element) => element.name === 'attribute')
      .map((attribute) => ({
        name: attribute.attrs.name,
        source: attribute.attrs.name,
        aggregate: attribute.attrs.aggregate,
      }));
    const firstLookup = [...metadata.columns.values()].find((column) => column.type === 'lookup');
    const selection = sourceODataSelection({
      schema,
      table: original.table,
      fields: [
        { name: metadata.primaryId },
        { name: metadata.primaryName },
        ...requested,
        ...(firstLookup ? [{ name: lowerName(firstLookup) }] : []),
      ],
    });
    const fallback = catalogue.records
      .filter((record) => record.table === original.table)
      .map((record) => manifest.fixtures[record.key])
      .filter((value) => guid.test(value ?? ''));
    const candidates = visibleIdsByTable[original.table] ?? fallback;
    if (!candidates.length || candidates.some((value) => !guid.test(value)))
      throw new Error('Bind at least one actual native fixture GUID per positive-authoring root.');
    const plan = {
      ...original,
      id: original.id + '-positive',
      variant: 'odata-positive-authoring',
      queryType: 'odata',
      fragments: undefined,
      fixtureIds: [candidates[0].toLowerCase()],
      fields: selection.fields,
      primaryId: metadata.primaryId,
      primaryName: metadata.primaryName,
      pageSize: 10,
      authoringQualification: 'schema-valid-bounded-request',
      expectedNativeOutcome: 'requires-native-evidence',
      selectionRejections: selection.rejected,
      requiredLogicalWebApiFields: selection.fields.map((field) => field.logicalName),
      requiredWireWebApiFields: selection.fields.map((field) => field.source),
      preservesOriginalCaseId: original.id,
      nativeQualified: false,
    };
    plan.logicalQueryHash = hash({
      table: plan.table,
      fixtureIds: plan.fixtureIds,
      fields: plan.fields,
      primaryId: plan.primaryId,
      primaryName: plan.primaryName,
      queryType: plan.queryType,
      variant: plan.variant,
    });
    return plan;
  });
}

export function positiveODataRequest(plan, operation) {
  const url = odataRequest(plan, operation) + '&$top=10';
  if (url.length > 2000) throw new Error('Positive OData authoring probe exceeded its bounded request budget.');
  return url;
}
