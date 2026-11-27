// The chart data service of the Liquid chart tag: GET /_services/visualizations/get-chart-builder?chartId=&viewId=, which
// the platform chart script requests for each `div.crm-chart` (hosted session F3, summary-F3.md PAGE-06b, runs a and b).
// The answer is built from the exported system chart (Entities/<table>/Visualizations) and view (SavedQueries) and
// the visitor's rows:
// - FetchXml: the chart's aggregate fetch with the view's root filters added, written as the platform writes it (two-space
//   indent, CRLF, " />"); OuterQuery.Query: the chart's own fetch the same way.
// - Query, ChartDefinition.Fetch and ChartDefinition.DataDescription: the merged fetch as the platform's query object.
//   Mapped values are the captured ones (aggregate sum, condition eq, filter and, ascending order) and the fetch.xsd
//   orders they come from (aggregates count, countcolumn, sum, avg, min, max; filter and, or); another operator is null
//   (PORTAL_CHART_QUERY_MODEL_PARTIAL).
// - Data and DataJson: the aggregate rows the visitor may read (table permissions apply). DataJson carries the captured
//   for(;;); prefix, each measure as a two-decimal string with its number in <alias>_Value.
// - AttributeMetadata and EntityMetadata: the chart's columns and table from the solution metadata;
//   ChartDefinition.PrimaryEntityMetadata: the RetrieveEntity metadata (attributes and relationships) Mirage derives
//   for the table.
// - ResourceManagerStringOverrides and the constant AttributeMetadata flags are copied as captured (en-US).
// Without a table permission that grants read the service answers {"ChartDefinition":"","EntityPermissionDenied":true},
// and the chart script shows "You don't have the appropriate permissions." (captured).
import { randomUUID } from 'node:crypto';
import { parseXmlDocument } from './fetchxml-engine.mjs';
import { attributeTypeDisplayName } from './attribute-metadata.mjs';
import { objectTypeCode } from './dataverse-metadata.mjs';

export const CHART_BUILDER_PATH = '/_services/visualizations/get-chart-builder';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const DATA_PREFIX = 'for(;;);';

// Captured for an en-US site; the platform's own localized strings for the chart script.
const STRING_OVERRIDES = Object.freeze({
  'ActivityContainerControl.SubjectEllipsesText': '...',
  'Web.Visualization.AxisTitle': '{0} ({1})',
  'Web.Visualization.AxisTitle.DateGrouping': '{0} ({1})',
  'Web.Visualization.EmptyAxisLabel': '(blank)',
  'Web.Visualization.AxisTitle.AVG': 'Avg',
  'Web.Visualization.AxisTitle.SUM': 'Sum',
  'Web.Visualization.AxisTitle.MIN': 'Min',
  'Web.Visualization.AxisTitle.MAX': 'Max',
  'Web.Visualization.AxisTitle.NONE': 'None',
  'Web.Visualization.AxisTitle.COUNT': 'Count:All',
  'Web.Visualization.AxisTitle.COUNTCOLUMN': 'Count:Non-empty',
  'Web.Visualization.AxisTitle.CurrencySymbol': '{0} ({1})',
  'Web.Visualization.AxisTitle.DateGrouping.DAY': 'Day',
  'Web.Visualization.AxisTitle.DateGrouping.FISCALPERIOD': 'Fiscal period',
  'Web.Visualization.AxisTitle.DateGrouping.FISCALYEAR': 'Fiscal year',
  'Web.Visualization.AxisTitle.DateGrouping.MONTH': 'Month',
  'Web.Visualization.AxisTitle.DateGrouping.QUARTER': 'Quarter',
  'Web.Visualization.AxisTitle.DateGrouping.WEEK': 'Week',
  'Web.Visualization.AxisTitle.DateGrouping.YEAR': 'Year',
  'Web.Visualization.Year.Quarter': 'Quarter',
  'Web.Visualization.Year.Week': 'Week',
  Chart_NoData_Message: 'No data available.',
  Calendar_Short_Months: 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec',
});

// fetch.xsd enumeration orders. Operators beyond the captured eq are not mapped.
const AGGREGATES = { count: 0, countcolumn: 1, sum: 2, avg: 3, min: 4, max: 5 };
const OPERATORS = { eq: 0 };
const FILTER_TYPES = { and: 0, or: 1 };
// Attribute order of the platform's writer, as captured; other attributes keep their source order after these.
const ATTRIBUTE_ORDER = {
  attribute: ['name', 'build', 'addedby', 'alias', 'aggregate', 'groupby', 'dategrouping', 'usertimezone', 'distinct'],
  condition: ['column', 'attribute', 'entityname', 'operator', 'aggregate', 'alias', 'value'],
  order: ['attribute', 'alias', 'descending'],
};

const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .trim()
    .toLowerCase();
const escapeAttribute = (value) =>
  String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
const escapeText = (value) =>
  String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const elements = (node, name) => (node?.children ?? []).filter((child) => !name || child.name === name);
const descendant = (node, name) => {
  for (const child of elements(node)) {
    if (child.name === name) return child;
    const found = descendant(child, name);
    if (found) return found;
  }
  return null;
};

function orderedAttributes(node) {
  const order = ATTRIBUTE_ORDER[node.name] ?? [];
  const names = Object.keys(node.attrs ?? {});
  return [...order.filter((name) => names.includes(name)), ...names.filter((name) => !order.includes(name))];
}

/** XML as the platform writes FetchXML: indented (two spaces, CRLF) or compact, empty elements as " />". */
function writeFetchXml(node, { indent = true, depth = 0 } = {}) {
  const pad = indent ? '  '.repeat(depth) : '';
  const newline = indent ? '\r\n' : '';
  const attributes = orderedAttributes(node)
    .map((name) => ` ${name}="${escapeAttribute(node.attrs[name])}"`)
    .join('');
  const children = elements(node);
  const text = node.text?.trim() ? escapeText(node.text.trim()) : '';
  if (!children.length && !text) return `${pad}<${node.name}${attributes} />`;
  if (!children.length) return `${pad}<${node.name}${attributes}>${text}</${node.name}>`;
  const inner = children.map((child) => writeFetchXml(child, { indent, depth: depth + 1 })).join(newline);
  return `${pad}<${node.name}${attributes}>${newline}${inner}${newline}${pad}</${node.name}>`;
}

const flag = (value) => (value == null ? null : String(value).toLowerCase() === 'true');

/** The platform query object of one fetch (the captured FetchType serialization); unmapped values are null. */
function queryModel(fetch, { chart, partial }) {
  const enumOf = (map, value, what) => {
    if (value == null) return null;
    const key = String(value).toLowerCase();
    if (Object.hasOwn(map, key)) return map[key];
    partial.add(`${what} ${key}`);
    return null;
  };
  const condition = (node) => ({
    Column: null,
    Attribute: node.attrs.attribute ?? null,
    EntityName: node.attrs.entityname ?? null,
    Operator: enumOf(OPERATORS, node.attrs.operator, 'operator'),
    Aggregate: null,
    Alias: null,
    UiName: null,
    UiType: null,
    UiHidden: null,
    Value: node.attrs.value ?? null,
    ValueOf: null,
    Values: elements(node, 'value').map((value) => value.text.trim()),
    Extensions: [],
  });
  const filter = (node) => ({
    Hint: null,
    IsQuickFindFields: null,
    Type: enumOf(FILTER_TYPES, node.attrs.type ?? 'and', 'filter type'),
    Conditions: elements(node, 'condition').map(condition),
    Filters: elements(node, 'filter').map(filter),
    Links: [],
    Extensions: [],
  });
  const entity = descendant(fetch, 'entity');
  if (elements(entity, 'link-entity').length) partial.add('link-entity');
  return {
    Version: fetch.attrs.version ?? null,
    PageSize: null,
    PageNumber: null,
    PagingCookie: null,
    UtcOffset: null,
    Aggregate: flag(fetch.attrs.aggregate),
    Distinct: flag(fetch.attrs.distinct),
    MappingType: 0,
    MinActiveRowVersion: null,
    OutputFormat: null,
    ReturnTotalRecordCount: null,
    // The platform runs a chart query without locks (captured); a view keeps its own attribute.
    NoLock: chart ? true : flag(fetch.attrs['no-lock']),
    Top: null,
    UseRawOrderBy: null,
    LateMaterialize: null,
    Options: null,
    SkipCache: null,
    IsAuditable: null,
    Entity: {
      Name: entity?.attrs.name ?? null,
      Attributes: elements(entity, 'attribute').map((node) => ({
        Name: node.attrs.name ?? null,
        Build: null,
        AddedBy: null,
        Alias: node.attrs.alias ?? null,
        Aggregate: enumOf(AGGREGATES, node.attrs.aggregate, 'aggregate'),
        GroupBy: flag(node.attrs.groupby),
        DateGrouping: null,
        UserTimeZone: null,
        Distinct: null,
        Extensions: [],
      })),
      Orders: elements(entity, 'order').map((node) => ({
        Attribute: node.attrs.attribute ?? null,
        Alias: node.attrs.alias ?? null,
        Direction: flag(node.attrs.descending) ? 1 : 0,
        Extensions: [],
      })),
      Filters: elements(entity, 'filter').map(filter),
      Links: [],
      Extensions: [],
    },
    Extensions: [],
    Orders: [],
  };
}

/** The chart's aggregate fetch with the view's root filters appended to its entity (the captured merge). */
function mergedFetch(chartFetch, viewFetch, partial) {
  const merged = structuredClone(chartFetch);
  const entity = descendant(merged, 'entity');
  const viewEntity = descendant(viewFetch, 'entity');
  entity.children.push(...structuredClone(elements(viewEntity, 'filter')));
  // A view's linked-table conditions are not merged (not captured); the chart reads the view's root filters only.
  if (elements(viewEntity, 'link-entity').length) partial.add('view link-entity');
  return merged;
}

const withoutODataTypes = (value) => {
  if (Array.isArray(value)) return value.map(withoutODataTypes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '@odata.type')
      .map(([key, item]) => [key, withoutODataTypes(item)]),
  );
};

function attributeEntries(table, fetch, fields, primary, lcid) {
  const entity = descendant(fetch, 'entity');
  return elements(entity, 'attribute').map((node) => {
    const name = String(node.attrs.name ?? '').toLowerCase();
    const field = fields?.[name] ?? {};
    const known = primary?.Attributes?.find((item) => item.LogicalName === name);
    const type = field.columnMetadata?.type ?? field.dataverseType ?? field.type ?? 'nvarchar';
    return {
      id: { rawguid: known?.MetadataId ?? null },
      logicalname: name,
      entitylogicalname: table,
      type: { Value: attributeTypeDisplayName(String(type).toLowerCase()) ?? 'StringType', ExtensionData: {} },
      sourcetype: 0,
      displayname:
        known?.DisplayName?.UserLocalizedLabel?.Label ?? field.columnMetadata?.labels?.[lcid] ?? field.label ?? name,
      requiredlevel: 0,
      issecured: field.columnMetadata?.isSecured ?? false,
      isvalidforcreate: true,
      isvalidforupdate: true,
      isvalidforread: true,
      attributeof: null,
      haschanged: false,
      issortableenabled: {
        Value: false,
        CanBeChanged: true,
        ManagedPropertyLogicalName: 'canmodifyissortablesettings',
        ExtensionData: {},
      },
      inheritsfrom: null,
      imemode: 0,
      maxlength: 0,
      minvalue: 0,
      maxvalue: 0,
      precision: 0,
      precisionsource: 0,
      format: 0,
      behavior: 0,
      defaultformvalue: 0,
      defaultvalue: false,
      isbasecurrency: true,
      islocalizable: true,
    };
  });
}

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const rawValue = (value) =>
  value && typeof value === 'object' ? (value.value ?? value.id ?? value.Id ?? null) : value;

/** Data (the platform's entity records) and DataJson rows of the aggregate result. */
function chartRows(rows, { table, typeCode, columns }) {
  const data = [];
  const json = [];
  for (const row of rows) {
    const attributes = [];
    const formatted = [];
    const entry = { RowId: `{${ZERO_ID}}`, RowType: String(typeCode) };
    for (const { alias, name, measure } of columns) {
      if (!Object.hasOwn(row, alias)) continue;
      const value = rawValue(row[alias]);
      const label = row[`${alias}${FORMATTED}`];
      attributes.push({
        Key: alias,
        Value: { AttributeLogicalName: name, EntityLogicalName: table, Value: value, ExtensionData: {} },
      });
      if (measure && typeof value === 'number') formatted.push({ Key: alias, Value: label ?? String(value) });
      else if (label != null) formatted.push({ Key: alias, Value: String(label) });
      entry[alias] = measure && typeof value === 'number' ? value.toFixed(2) : String(label ?? value ?? '');
      entry[`${alias}_Value`] = value;
    }
    data.push({
      LogicalName: table,
      Id: ZERO_ID,
      Attributes: attributes,
      EntityState: null,
      FormattedValues: formatted,
      RelatedEntities: [],
      RowVersion: null,
      KeyAttributes: [],
      HasLazyFileAttribute: false,
      LazyFileAttributeKey: null,
      LazyFileAttributeValue: null,
      LazyFileSizeAttributeKey: null,
      LazyFileSizeAttributeValue: 0,
      ExtensionData: {},
    });
    json.push(entry);
  }
  return { data, json };
}

const DENIED = Object.freeze({ ChartDefinition: '', EntityPermissionDenied: true });

/**
 * The service answer: { status, body } (body a JSON value). `chart`: an inventory chart record with its `chart` facts;
 * `view`: the solution view; `canRead(table)`: the visitor's table read grant; `fetchXml(xml)`: the secured read;
 * `metadata`: the solution table metadata; `entityMetadata(table)`: RetrieveEntity metadata or null.
 */
export async function chartBuilderAnswer({
  chartId,
  viewId,
  charts,
  views,
  metadata,
  canRead,
  fetchXml,
  entityMetadata,
  typeCode,
  lcid = 1033,
  diagnostic = () => {},
}) {
  const chart = charts.find((record) => record.id && record.id === canonical(chartId) && record.chart);
  const view = views.find((record) => canonical(record.id) === canonical(viewId));
  if (!chart || !view) {
    diagnostic({
      code: 'PORTAL_CHART_NOT_FOUND',
      severity: 'warning',
      message: `The chart service found no exported ${chart ? 'view' : 'chart'} '${chart ? viewId : chartId}'.`,
    });
    return {
      status: 404,
      body: { error: { code: 'PORTAL_CHART_NOT_FOUND', message: 'The chart or view is not exported.' } },
    };
  }
  const { entity: table, description, dataDescription, presentationDescription } = chart.chart;
  if (!canRead(table)) return { status: 200, body: DENIED };
  const definition = parseXmlDocument(dataDescription, { root: 'datadefinition' });
  const chartFetch = descendant(definition, 'fetch');
  const viewFetch = parseXmlDocument(view.fetchXml, { root: 'fetch' });
  const partial = new Set();
  const merged = mergedFetch(chartFetch, viewFetch, partial);
  const query = queryModel(merged, { chart: true, partial });
  const viewWithId = structuredClone(viewFetch);
  viewWithId.attrs = { ...viewWithId.attrs, savedqueryid: canonical(view.id) };
  const viewModel = queryModel(viewFetch, { chart: false, partial });
  const mergedXml = writeFetchXml(merged);
  const result = await fetchXml(mergedXml);
  const rows = result?.entities ?? result?.value ?? [];
  const fields = metadata?.entities?.[table]?.fields ?? {};
  const columns = elements(descendant(merged, 'entity'), 'attribute').map((node) => ({
    alias: node.attrs.alias ?? node.attrs.name,
    name: node.attrs.name,
    measure: node.attrs.aggregate != null,
  }));
  const code = typeCode ?? objectTypeCode(table);
  const { data, json } = chartRows(rows, { table, typeCode: code, columns });
  if (partial.size)
    diagnostic({
      code: 'PORTAL_CHART_QUERY_MODEL_PARTIAL',
      severity: 'info',
      component: 'chart',
      message: `The chart query object leaves ${[...partial].join(', ')} unmapped (null); FetchXml and the chart data are complete.`,
    });
  const tableInfo = metadata?.entities?.[table] ?? {};
  const primary = withoutODataTypes(entityMetadata?.(table) ?? null);
  const entityRecord = [
    {
      Id: primary?.MetadataId ?? null,
      LogicalName: table,
      DisplayName: primary?.DisplayName?.UserLocalizedLabel?.Label ?? tableInfo.label ?? table,
      PluralName:
        primary?.DisplayCollectionName?.UserLocalizedLabel?.Label ??
        tableInfo.collectionLabel ??
        tableInfo.label ??
        table,
      ObjectTypeCode: primary?.ObjectTypeCode ?? code,
      PrimaryIdAttribute: tableInfo.primaryIdAttribute ?? `${table}id`,
      PrimaryNameAttribute: tableInfo.primaryNameAttribute ?? null,
      EntityColor: null,
    },
  ];
  const attributes = attributeEntries(table, merged, fields, primary, lcid);
  const categories = elements(descendant(definition, 'categorycollection'), 'category').map((category) => ({
    Alias: category.attrs.alias ?? null,
    MeasureCollections: elements(category, 'measurecollection').map((collection) => ({
      Measures: elements(collection, 'measure').map((measure) => ({ Alias: measure.attrs.alias ?? null })),
    })),
  }));
  return {
    status: 200,
    body: {
      AttributeMetadata: attributes,
      AttributeMetadataSerialized: JSON.stringify(attributes),
      ChartDefinition: {
        DataDescription: { FetchCollection: [query], CategoryCollection: categories },
        DataDescriptionXml: dataDescription,
        Description: description ?? null,
        Fetch: query,
        Id: chart.id,
        Name: chart.name,
        PresentationDescriptionXml: presentationDescription ?? null,
        PrimaryEntityMetadata: primary,
        PrimaryEntityTypeCode: table,
      },
      OuterQuery: { Query: writeFetchXml(chartFetch), ExtensionData: null },
      Data: data,
      DataJson: DATA_PREFIX + JSON.stringify(json),
      EntityMetadata: entityRecord,
      EntityMetadataSerialized: JSON.stringify(entityRecord),
      EntityPermissionDenied: false,
      EntityPermissionsEnabled: true,
      Id: randomUUID().replaceAll('-', ''),
      Query: query,
      FetchXml: mergedXml,
      ResourceManagerStringOverrides: STRING_OVERRIDES,
      ResourceManagerStringOverridesSerialized: JSON.stringify(STRING_OVERRIDES),
      ViewDefinition: {
        Fetch: viewModel,
        FetchXml: writeFetchXml(viewWithId, { indent: false }),
        Id: canonical(view.id),
        LayoutXml: view.layoutXml ?? null,
        Name: view.name ?? null,
        ReturnedTypeCode: table,
      },
    },
  };
}
