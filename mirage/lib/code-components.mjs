import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from '../../lense/local-file.mjs';
import { orderedMap } from '../../lense/async-map.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { parseSolutionXml, descendants, childText } from './solution-xml.mjs';
import { portalLanguage } from './portal-languages.mjs';
import { pcfAdmission } from './model-driven/pcf-runtime.mjs';
import { readSolutionAssetEntries, SOLUTION_ASSET_LIMITS } from './dataverse-solution-assets.mjs';
import { PCF_RESOURCE_LIMIT } from './pcf-sources.mjs';
import { webApiFetchPolicy, webApiPolicy } from './webapi-policy.mjs';
import { attributeMetadata, attributeTypeDisplayName, attributeTypeNumber } from './attribute-metadata.mjs';
import { nativeFieldAdmission, nativeFieldRefusal, nativeStaticValue } from './pcf-field-host.mjs';

/** The one PCF admission rule of the Power Pages and model-driven hosts (control type, dataset, platform libraries). */
export { pcfAdmission };
/** The local PCF host script each rendered code component loads before its host element. */
export const PCF_HOST_SCRIPT = '/__sim-static/pcf-host.js';

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
// Liquid decimals (NetDecimal) carry BigInt parts, which JSON cannot write: they are written as text.
const jsonItem = (key, item) => (typeof item === 'bigint' ? item.toString() : item);
const json = (value) => JSON.stringify(value, jsonItem).replaceAll('<', String.raw`\u003c`);
/**
 * The canonical form of a code component GUID reference (lower case, hyphenated, without braces), or null when the value
 * is no GUID. A tag may name the control's id braced or without hyphens; observed mappings use this form as their key.
 */
export function codeComponentGuid(value) {
  const match = /^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i.exec(
    String(value ?? ''),
  );
  return match ? match.slice(1).join('-').toLowerCase() : null;
}
const contained = (root, file) => {
  const rel = path.relative(root, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
// The dataset column dataType of each attribute type, as a Power Pages list and subgrid report it (captured,
// Columns): float is Decimal, money Money, memo
// SingleLine.Text, and lookup, customer and multi-select columns keep their lower-case attribute type names. Owner,
// party list, file, image, unique identifier and big integer columns were not in the capture: they
// follow the same rule (owner, partylist) or keep the manifest type names.
const pcfTypes = {
  nvarchar: 'SingleLine.Text',
  string: 'SingleLine.Text',
  ntext: 'SingleLine.Text',
  memo: 'SingleLine.Text',
  uniqueidentifier: 'SingleLine.Text',
  primarykey: 'SingleLine.Text',
  int: 'Whole.None',
  integer: 'Whole.None',
  bigint: 'Whole.None',
  decimal: 'Decimal',
  float: 'Decimal',
  double: 'Decimal',
  money: 'Money',
  datetime: 'DateAndTime.DateAndTime',
  bit: 'TwoOptions',
  boolean: 'TwoOptions',
  picklist: 'OptionSet',
  state: 'OptionSet',
  status: 'OptionSet',
  multiselectpicklist: 'multiselectpicklist',
  lookup: 'lookup',
  customer: 'customer',
  owner: 'owner',
  partylist: 'partylist',
  file: 'File',
  image: 'Image',
};
// Column formats that select a narrower type of the same attribute type: email (captured) and the other text formats
// and whole-number formats by their manifest type names (not captured).
const pcfTextFormats = {
  email: 'SingleLine.Email',
  phone: 'SingleLine.Phone',
  textarea: 'SingleLine.TextArea',
  tickersymbol: 'SingleLine.Ticker',
  url: 'SingleLine.URL',
};
const pcfWholeFormats = { duration: 'Whole.Duration', language: 'Whole.Language', timezone: 'Whole.TimeZone' };
/** The dataset dataType of an exported column: its attribute type, narrowed by its format (a date-format column is DateOnly whatever its behaviour). */
function pcfDataType(field) {
  const type = String(field?.dataverseType ?? '').toLowerCase(),
    format = String(field?.format ?? '').toLowerCase();
  if (type === 'nvarchar' && pcfTextFormats[format]) return pcfTextFormats[format];
  if (['int', 'integer'].includes(type) && pcfWholeFormats[format]) return pcfWholeFormats[format];
  if (type === 'datetime' && (format === 'date' || field.dateTimeBehavior === 'DateOnly'))
    return 'DateAndTime.DateOnly';
  return pcfTypes[type];
}

// Native form fields bind by the native control kind (platform.mjs nativeControlKind) refined by the exported column
// format and date behaviour that nativeBinding.attributes carry, as manifest property types. These are not the dataset
// column dataTypes of pcfTypes above (a dataset reports float as Decimal and money as Money; a field property is FP or
// Currency).
const NATIVE_TEXT_FORMATS = {
  email: 'SingleLine.Email',
  phone: 'SingleLine.Phone',
  url: 'SingleLine.URL',
  tickersymbol: 'SingleLine.Ticker',
  textarea: 'SingleLine.TextArea',
};
const NATIVE_WHOLE_FORMATS = { duration: 'Whole.Duration', timezone: 'Whole.TimeZone', language: 'Whole.Language' };
const NATIVE_CONTROL_TYPES = {
  email: 'SingleLine.Email',
  textarea: 'Multiple',
  decimal: 'Decimal',
  double: 'FP',
  money: 'Currency',
  boolean: 'TwoOptions',
  picklist: 'OptionSet',
  state: 'OptionSet',
  status: 'OptionSet',
  multiselect: 'MultiSelectOptionSet',
  lookup: 'Lookup.Simple',
  file: 'File',
  image: 'Image',
};

const NATIVE_LOOKUP_TYPES = { customer: 'Lookup.Customer', owner: 'Lookup.Owner', partylist: 'Lookup.PartyList' };

/** The PCF property type a native form column binds as, or null when the control kind is unknown. `column` carries
 * the exported Dataverse type and, for a date column, whether the native box is date-only (platform.mjs
 * nativeDateOnly); without them the exported Format and Behavior decide. */
export function nativeColumnPcfType(control, attributes = {}, column = {}) {
  const format = String(attributes?.Format ?? '').toLowerCase();
  const dataverseType = String(column?.dataverseType ?? '').toLowerCase();
  if (NATIVE_LOOKUP_TYPES[dataverseType]) return NATIVE_LOOKUP_TYPES[dataverseType];
  if (control === 'textarea') {
    // A multiline text (memo/ntext) column is Multiple whatever its Format; a single line of text with the text area
    // format is SingleLine.TextArea.
    if (/^(memo|ntext)$/.test(dataverseType)) return 'Multiple';
    if (dataverseType === 'nvarchar' || format === 'textarea') return 'SingleLine.TextArea';
    return 'Multiple';
  }
  if (control === 'text') return NATIVE_TEXT_FORMATS[format] ?? 'SingleLine.Text';
  if (control === 'integer') return NATIVE_WHOLE_FORMATS[format] ?? 'Whole.None';
  if (control === 'datetime') {
    const dateOnly =
      typeof column?.dateOnly === 'boolean'
        ? column.dateOnly
        : /^(date|dateonly)$/.test(format) || attributes?.Behavior === 2;
    return dateOnly ? 'DateAndTime.DateOnly' : 'DateAndTime.DateAndTime';
  }
  return NATIVE_CONTROL_TYPES[control] ?? null;
}

// Manifest property usages a FormXml column binding may target. A binding to an input property mounts the control
// (captured): that input gets no value.
const NATIVE_BINDABLE_USAGES = new Set(['bound', 'input']);

function pcfTypeFamily(type) {
  const value = String(type ?? '');
  if (/^SingleLine\./.test(value) || value === 'Multiple') return 'text';
  if (/^Whole\./.test(value) || ['Decimal', 'FP', 'Currency'].includes(value)) return 'number';
  if (/^DateAndTime\./.test(value)) return 'date';
  if (/^Lookup\./.test(value)) return 'lookup';
  return value;
}

/** Resolves the property types of a native field binding as the Power Pages host does: an of-type property keeps its
 * type and a type-group property takes the first type of its group, whatever the column and the exported FormXml type
 * (captured: Currency on a phone column). The control mounts; a
 * FormXml type or column type the resolved type does not match is answered as a warning, since the platform then
 * hands the control a value it cannot convert (a number type on text is NaN with an error). */
function nativeBindingTypes(control, nativeBinding, schema) {
  const columnType = nativeColumnPcfType(nativeBinding.control, nativeBinding.attributes, nativeBinding.column);
  const propertyTypes = {};
  const warnings = [];
  for (const name of nativeBinding.properties) {
    const property = control.properties.find((candidate) => candidate.name === name);
    const exported = nativeBinding.propertyTypes?.[name];
    const type = property['of-type'] || property.types?.[0];
    if (!type)
      return {
        error: `Code component ${schema} property ${name} has an empty type-group ${property['of-type-group'] ?? '(none)'}.`,
        reason: 'PCF_NATIVE_TYPE_AMBIGUOUS',
        property: name,
      };
    propertyTypes[name] = type;
    if (exported && exported !== type)
      warnings.push({
        property: name,
        message: `Code component ${schema} property ${name} is exported as ${exported}, but the Power Pages host binds it as ${type}, the ${property['of-type'] ? 'declared type' : 'first type of its type-group'}.`,
      });
    if (columnType && pcfTypeFamily(type) !== pcfTypeFamily(columnType))
      warnings.push({
        property: name,
        message: `Code component ${schema} property ${name} is bound as ${type} to native field ${nativeBinding.id}, a ${columnType} column; the control receives a value it cannot convert.`,
      });
  }
  return { binding: { ...nativeBinding, propertyTypes }, warnings };
}

// Classic SDK bundles start with an optional block-comment header and a single
// uninitialized var. Advance monotonically: repeating comments/whitespace in a
// regular expression can revisit the same resource prefix many times.
function classicExportGlobal(source) {
  let offset = 0;
  const whitespace = () => {
    const start = offset;
    while (offset < source.length && /\s/.test(source[offset])) offset++;
    return offset > start;
  };
  for (;;) {
    whitespace();
    if (!source.startsWith('/*', offset)) break;
    const end = source.indexOf('*/', offset + 2);
    if (end < 0) return undefined;
    offset = end + 2;
  }
  if (!source.startsWith('var', offset)) return undefined;
  offset += 3;
  if (!whitespace() || !/[A-Za-z_$]/.test(source[offset] ?? '')) return undefined;
  const start = offset++;
  while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset])) offset++;
  const name = source.slice(start, offset);
  whitespace();
  return source[offset] === ';' ? name : undefined;
}

// Declaration eligibility is a Power Pages contract, independent of whether a
// local facade implements the requested API. Keep source attributes untouched.
function featureEligibility(features = []) {
  return features.map((feature) => {
    const requiredValue = typeof feature.required === 'string' ? feature.required.trim() : feature.required;
    const required = requiredValue === 'true' || requiredValue === '1';
    const valid =
      typeof feature.name === 'string' &&
      Boolean(feature.name.trim()) &&
      ['true', 'false', '1', '0'].includes(requiredValue);
    let hostApiAvailable;
    if (feature.name === 'WebAPI') hostApiAvailable = true;
    else if (feature.name === 'Utility' || /^(?:Device|device)\./.test(feature.name ?? '')) hostApiAvailable = false;
    else hostApiAvailable = null;
    let reason = {};
    if (!valid) reason = { reason: 'PCF_FEATURE_DECLARATION_INVALID' };
    else if (required) reason = { reason: 'PCF_PORTAL_REQUIRED_FEATURE_UNSUPPORTED' };
    return {
      ...feature,
      hostApiAvailable,
      eligible: valid && !required,
      ...reason,
    };
  });
}

/* NOSONAR: mixed return values are part of the contract */ function languageLcid(language) {
  if (Number.isInteger(Number(language?.lcid)) && Number(language.lcid) > 0) return Number(language.lcid);
  return portalLanguage({ name: language?.code })?.lcid ?? null;
}

function localizedResourceGroups(resources) {
  const groups = new Map();
  for (const resource of resources) {
    if (!resource.lcid) continue;
    if (!groups.has(resource.group)) groups.set(resource.group, []);
    groups.get(resource.group).push(resource);
  }
  return groups;
}

// One language per control: the selected language when any of its RESX groups has it, else the website default language
// when any has that. Groups never resolve to different languages; a group without the control's language contributes nothing.
function controlLanguage(groups, selectedLcid, defaultLcid) {
  const has = (lcid) =>
    Boolean(lcid) && [...groups.values()].some((variants) => variants.some((item) => item.lcid === lcid));
  if (has(selectedLcid)) return { lcid: selectedLcid, selection: 'selected-language' };
  if (has(defaultLcid)) return { lcid: defaultLcid, selection: 'website-default-language' };
  return null;
}

function localizedResourceCandidate(group, variants, language, { selectedLcid, defaultLcid }, diagnostic) {
  const candidates = language ? variants.filter((resource) => resource.lcid === language.lcid) : [];
  if (candidates.length !== 1) {
    diagnostic?.({
      code: candidates.length ? 'PCF_RESOURCE_LANGUAGE_AMBIGUOUS' : 'PCF_RESOURCE_LANGUAGE_UNRESOLVED',
      group,
      selectedLcid,
      defaultLcid,
      ...(language ? { controlLcid: language.lcid } : {}),
      paths: candidates.map((resource) => resource.path),
    });
    return null;
  }
  return { resource: candidates[0], selection: language.selection };
}

function mergeLocalizedEntries(strings, ambiguousKeys, resource) {
  for (const [key, value] of Object.entries(resource.strings)) {
    if (Object.hasOwn(strings, key)) ambiguousKeys.add(key);
    else strings[key] = value;
  }
}

function localizedStrings(control, selectedLanguage, defaultLanguage, diagnostic) {
  if (!control.stringResources) return { strings: control.strings ?? {}, localization: null };
  const selectedLcid = languageLcid(selectedLanguage),
    defaultLcid = languageLcid(defaultLanguage);
  const strings = Object.create(null),
    selectedResources = [],
    ambiguousKeys = new Set();
  const groups = localizedResourceGroups(control.stringResources);
  const language = controlLanguage(groups, selectedLcid, defaultLcid);
  if (language?.selection === 'website-default-language')
    diagnostic?.({
      code: 'PCF_RESOURCE_LANGUAGE_FALLBACK',
      groups: [...groups.keys()],
      selectedLcid,
      selectedResourceLcid: language.lcid,
      policy: 'exported-website-default',
      nativeQualified: false,
    });
  for (const [group, variants] of groups) {
    const selected = localizedResourceCandidate(group, variants, language, { selectedLcid, defaultLcid }, diagnostic);
    if (!selected) continue;
    const { resource, selection } = selected;
    selectedResources.push({ path: resource.path, lcid: resource.lcid, selection, attributes: resource.attributes });
    mergeLocalizedEntries(strings, ambiguousKeys, resource);
  }
  for (const key of ambiguousKeys) {
    delete strings[key];
    diagnostic?.({ code: 'PCF_RESOURCE_KEY_AMBIGUOUS', key });
  }
  return {
    strings,
    localization: { selectedLcid, defaultLcid, lcid: language?.lcid ?? null, resources: selectedResources },
  };
}

function componentDatasetView(dataset, binding, metadata) {
  const candidates = (metadata.views ?? []).filter(
    (view) => canonical(view.id) === canonical(binding) || canonical(view.name) === canonical(binding),
  );
  if (candidates.length > 1)
    return { error: `Dataset ${dataset.name} matches multiple exported views. Bind its exported view ID.` };
  const view = candidates[0];
  return { view, entity: view?.entity ?? canonical(binding) };
}

const datasetName = /^[a-z_][a-z\d_]*$/i;
/** An own property of a plain metadata object (never an Object.prototype member such as constructor). */
const own = (object, key) => (object != null && Object.hasOwn(object, key) ? object[key] : undefined);

/** The client facts of an exported column: label, attribute type, dataset dataType, lookup targets, date behaviour. */
function datasetField(field) {
  return {
    label: field.label,
    dataverseType: field.dataverseType,
    dataType: pcfDataType(field),
    targets: field.targets,
    ...(field.dateTimeBehavior ? { dateTimeBehavior: field.dateTimeBehavior } : {}),
  };
}

/**
 * The portal Web API as the current visitor sees it: `webApi` is `{ store, portal }`, the portal carrying the request
 * identity (`webApiIdentity`) as the Web API handler builds it. Table policies are cached; a table the Web API does not
 * serve answers `{ error }`. Only the local Liquid dataset binding (pcf.liquidDatasetBinding "view") reads through it.
 */
function datasetWebApi(webApi) {
  if (!webApi?.store || !webApi.portal) return null;
  const portal = webApi.store.portalAuthorization?.webApiPortal(webApi.portal) ?? webApi.portal;
  const policies = new Map();
  return {
    policy(entity) {
      if (!policies.has(entity))
        try {
          policies.set(entity, { policy: webApiPolicy(portal, webApi.store, entity) });
        } catch (error) {
          policies.set(entity, { error });
        }
      return policies.get(entity);
    },
    fetch: (xml, root) => webApiFetchPolicy(portal, webApi.store, xml, root),
  };
}

/**
 * The exported tables a dataset can link to (its lookup targets and the view's link-entities) that have an exact Web
 * API mapping, with their columns' client facts. With the visitor's Web API access (local Liquid binding), only tables
 * it serves and columns it lets the visitor read are described.
 */
function componentDatasetTables(fields, links, { metadata, mappings, access }) {
  const names = new Set([
    ...Object.values(fields).flatMap((field) => field.targets ?? []),
    ...links.map((link) => link.name),
  ]);
  const tables = Object.create(null);
  for (const name of names) {
    const table = own(metadata.entities, name),
      mapping = own(mappings, name);
    if (!table || !mapping?.entitySet || !mapping?.idColumn) continue;
    const policy = access?.policy(name);
    if (policy?.error) continue;
    tables[name] = {
      idColumn: mapping.idColumn,
      fields: Object.fromEntries(
        Object.entries(table.fields ?? {})
          .filter(([key]) => !policy || policy.policy.allowed(key))
          .map(([key, field]) => [key, datasetField(field)]),
      ),
    };
  }
  return tables;
}

/** The view FetchXML facts a dataset needs: its link-entity aliases and its primary-table sort order. */
function componentDatasetFetch(dataset, view) {
  if (!view?.fetchXml) return { links: [], sorting: [] };
  let fetch;
  try {
    fetch = parseSolutionXml(view.fetchXml);
  } catch {
    return { error: `Dataset ${dataset.name} has malformed exported FetchXML.` };
  }
  if (
    fetch.attrs.aggregate === 'true' ||
    fetch.attrs.top != null ||
    descendants(fetch, 'attribute').some((node) => node.attrs.alias)
  )
    return { error: `Dataset ${dataset.name} requires unsupported aggregate, top-limited, or aliased view semantics.` };
  const entity = (fetch.children ?? []).find((node) => node.name === 'entity');
  const links = descendants(fetch, 'link-entity')
    .filter((node) => datasetName.test(node.attrs.alias ?? '') && datasetName.test(node.attrs.name ?? ''))
    .map((node) => ({ alias: node.attrs.alias, name: node.attrs.name }));
  // The view's own order (0 ascending, 1 descending): the initial sorting of the local Liquid binding.
  const sorting = (entity?.children ?? [])
    .filter((node) => node.name === 'order' && datasetName.test(node.attrs.attribute ?? '') && !node.attrs.entityname)
    .map((node) => ({ name: node.attrs.attribute, sortDirection: node.attrs.descending === 'true' ? 1 : 0 }));
  return { links, sorting };
}

/**
 * The exported definition a layout cell names: a primary-table column or `alias.column` of a view link-entity, with
 * its table, attribute and display name ("Email (Contact)" for a link-entity column).
 */
function datasetCellField(cell, { entity, fields, mapping, links, metadata }) {
  const [alias, column, extra] = String(cell.name ?? '').split('.');
  if (column === undefined) {
    if (!datasetName.test(alias)) return null;
    const field = own(fields, alias) ?? (alias === mapping.idColumn ? {} : null);
    return field && { field, table: entity, attribute: alias, displayName: field.label ?? alias };
  }
  if (extra !== undefined || !datasetName.test(column)) return null;
  const link = links.find((entry) => entry.alias === alias);
  const table = link && own(metadata.entities, link.name);
  const field = table && own(table.fields, column);
  return field
    ? {
        field,
        table: link.name,
        attribute: column,
        displayName: `${field.label ?? column} (${table.label ?? link.name})`,
      }
    : null;
}

/**
 * A column's AttributeMetadata (as the grid service echoes it); without exported column facts, the compact shape the
 * native grid layout uses.
 */
function columnAttributes(table, attribute, field, primaryName) {
  const type = String(field?.dataverseType ?? 'nvarchar').toLowerCase();
  return (
    attributeMetadata(table, attribute, field, { primaryName }) ?? {
      LogicalName: attribute,
      EntityLogicalName: table,
      AttributeType: attributeTypeNumber(type),
      AttributeTypeName: { Value: attributeTypeDisplayName(type) },
      IsPrimaryName: attribute === primaryName,
      IsPrimaryId: type === 'primarykey',
      DisplayName: { UserLocalizedLabel: { Label: field?.label ?? attribute, LanguageCode: 1033 } },
    }
  );
}

/** The property-set columns of a data-set: no view column, the property-set name as display name and alias, order -1. */
function propertySetColumns(dataset) {
  return (dataset.propertySets ?? []).map((set) => ({
    name: null,
    displayName: set.name,
    dataType: set['of-type'] ?? 'SingleLine.Text',
    alias: set.name,
    order: -1,
    visualSizeFactor: 1,
  }));
}

/**
 * The dataset's columns as the platform reports them: the property-set columns, then the view layout (or every
 * readable exported column but the primary key without a view) with `name`, `displayName`, `dataType`, `alias`,
 * `order` (layout position from 1), `visualSizeFactor` 1 and the column's AttributeMetadata under `attributes`. A cell
 * naming a column of a view link-entity (alias.column) resolves through that link's exported table. A cell that
 * resolves to no exported column is left out and reported; it does not refuse the component.
 */
function componentDatasetColumns(dataset, { view, entity, fields, mapping, nameColumn, links, metadata, diagnostic }) {
  const cells = view?.fields?.length
    ? view.fields
    : Object.keys(fields)
        .filter((name) => fields[name].validForRead !== false && name !== mapping.idColumn)
        .map((name) => ({ name }));
  const columns = propertySetColumns(dataset);
  let order = 0;
  for (const cell of cells) {
    const resolved = datasetCellField(cell, { entity, fields, mapping, links, metadata });
    if (!resolved) {
      diagnostic?.({
        code: 'PCF_DATASET_COLUMN_SKIPPED',
        severity: 'warning',
        dataset: dataset.name,
        view: view?.id,
        column: cell.name,
        message: `Dataset ${dataset.name} leaves out view column ${cell.name}: it is not an exported column of the view's table or of one of its link-entities.`,
      });
      continue;
    }
    const { field, table, attribute, displayName } = resolved;
    const primaryName = table === entity ? nameColumn : own(metadata.entities, table)?.primaryNameAttribute;
    columns.push({
      name: cell.name,
      displayName,
      dataType: pcfDataType(field) ?? 'unknown',
      alias: cell.name,
      order: ++order,
      visualSizeFactor: 1,
      attributes: columnAttributes(table, attribute, field, primaryName),
    });
  }
  return columns;
}

/** The site setting a portal Web API refusal names. */
function webApiSettingOf(error, table) {
  if (error?.code === 'WebApiTableNotEnabled') return `Webapi/${table}/enabled = true`;
  if (error?.details?.attribute) return `Webapi/${table}/fields listing ${error.details.attribute}`;
  return `Webapi/${table}/enabled and Webapi/${table}/fields`;
}

/**
 * The first refusal the visitor's portal Web API gives the dataset's query (its FetchXML, layout columns and the
 * columns the client adds), or null.
 */
function datasetWebApiRefusal(access, { entity, fetchXml, columns, links }) {
  try {
    access.fetch(fetchXml, entity);
    for (const column of columns) {
      if (column.name == null) continue;
      const [alias, name] = column.name.split('.');
      if (name === undefined) access.policy(entity).policy?.assert(alias);
      else {
        const link = links.find((entry) => entry.alias === alias);
        const target = link && access.policy(link.name);
        if (target?.error) throw target.error;
        target?.policy.assert(name);
      }
    }
    const primary = access.policy(entity);
    if (primary.error) throw primary.error;
    return null;
  } catch (error) {
    return error;
  }
}

/** The table and view parts every bound dataset shares; or `{ error }`. */
function boundDataset(dataset, { viewBinding, metadata, mappings, diagnostic, access }) {
  const selectedView = componentDatasetView(dataset, viewBinding, metadata);
  if (selectedView.error) return { error: selectedView.error };
  const { view, entity } = selectedView;
  const table = own(metadata.entities, entity),
    mapping = own(mappings, entity);
  if (!table || !mapping?.entitySet || !mapping?.idColumn)
    return {
      error: `Dataset ${dataset.name} has no exported table definition and exact Web API mapping for ${entity}.`,
    };
  const fields = table.fields ?? {};
  const fetch = componentDatasetFetch(dataset, view);
  if (fetch.error) return { error: fetch.error };
  const { links, sorting } = fetch;
  const nameColumn = mapping.nameColumn ?? table.primaryNameAttribute;
  const columns = componentDatasetColumns(dataset, {
    view,
    entity,
    fields,
    mapping,
    nameColumn,
    links,
    metadata,
    diagnostic,
  });
  return {
    view,
    entity,
    mapping,
    links,
    sorting,
    nameColumn,
    columns,
    dataset: {
      name: dataset.name,
      entity,
      entitySet: mapping.entitySet,
      idColumn: mapping.idColumn,
      nameColumn,
      viewId: view?.id ?? null,
      viewName: view?.name ?? entity,
      columns,
      links,
      tables: componentDatasetTables(fields, links, { metadata, mappings, access }),
      ...(dataset.propertySets?.length ? { propertySets: dataset.propertySets } : {}),
      fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, datasetField(field)])),
    },
  };
}

/**
 * A list's or subgrid's data set: rows through the native grid service of its kind (entity-grid-data.json for a list,
 * entity-subgrid-data.json for a subgrid) with the grid's signed configuration,
 * sorted first by the table's primary name column as the platform sorts both hosts.
 */
function nativeComponentDataset(dataset, { metadata, mappings, nativeDataset, diagnostic }) {
  const bound = boundDataset(dataset, { viewBinding: nativeDataset.viewId, metadata, mappings, diagnostic });
  if (bound.error) return bound;
  return {
    dataset: {
      ...bound.dataset,
      transport: 'grid',
      kind: nativeDataset.kind,
      service: nativeDataset.service,
      update: nativeDataset.update,
      secure: nativeDataset.secure,
      // A subgrid's parent form record (platform.mjs subgrid gate; reported as mode.contextInfo).
      ...(nativeDataset.context ? { context: nativeDataset.context } : {}),
      sorting: datasetName.test(bound.nameColumn ?? '') ? [{ name: bound.nameColumn, sortDirection: 0 }] : [],
    },
  };
}

/** A data set the host binds to nothing: the Liquid tag's data sets, and a list's or subgrid's other data sets. */
function unboundComponentDataset(dataset, transport, extra = {}) {
  return {
    dataset: {
      name: dataset.name,
      transport,
      columns: propertySetColumns(dataset),
      sorting: [],
      ...(dataset.propertySets?.length ? { propertySets: dataset.propertySets } : {}),
      ...extra,
    },
  };
}

/**
 * The local Liquid dataset binding (pcf.liquidDatasetBinding "view"): the tag argument names an exported view or
 * table and rows are read through the portal Web API. The platform has no such binding.
 */
function liquidComponentDataset(dataset, { args, metadata, mappings, schema, diagnostic, access }) {
  const binding = args[dataset.name] ?? args[dataset.name.toLowerCase()];
  if (typeof binding !== 'string' || !binding.trim())
    return {
      error: `Code component ${schema} requires a dataset binding to an exported table and view: set the ${dataset.name} tag argument to an exported view ID or table logical name.`,
    };
  const bound = boundDataset(dataset, { viewBinding: binding, metadata, mappings, diagnostic, access });
  if (bound.error) return bound;
  const { view, entity, mapping, links, columns, nameColumn } = bound;
  const viewColumns = columns.filter((column) => column.name != null);
  // The primary key is always queried (records are keyed by it) but is a column only when the layout shows it.
  const queried = [...new Set([mapping.idColumn, ...viewColumns.map((column) => column.name)])];
  const attributeXml = (name) => `<attribute name="${escape(name)}"/>`;
  const fetchXml =
    view?.fetchXml || `<fetch><entity name="${escape(entity)}">${queried.map(attributeXml).join('')}</entity></fetch>`;
  const refusal = access ? datasetWebApiRefusal(access, { entity, fetchXml, columns, links }) : null;
  if (refusal) {
    const refused = refusal.details?.table ?? entity;
    diagnostic?.({
      code: 'PCF_DATASET_WEBAPI_REQUIRED',
      severity: 'warning',
      dataset: dataset.name,
      entity: refused,
      message: `Dataset ${dataset.name} reads ${entity} through the portal Web API and needs site setting ${webApiSettingOf(refusal, refused)}: ${refusal.message}`,
    });
  }
  // The record name is queried only when the layout shows it or the visitor may read it through the Web API.
  const queryNameColumn =
    datasetName.test(nameColumn ?? '') &&
    (viewColumns.some((column) => column.name === nameColumn) ||
      Boolean(access?.policy(entity).policy?.allowed(nameColumn)));
  return {
    dataset: { ...bound.dataset, transport: 'webapi', sorting: bound.sorting, queryNameColumn, fetchXml },
  };
}

const admittedFiles = new WeakMap();
// Declared resource kinds the catalogue admits and serves. `dependency` names another control and carries no file;
// `platform-library` is a host library. Any other child of <resources> is reported, never silently dropped.
const resourceKinds = new Set(['code', 'css', 'resx', 'img', 'html']);
const MANIFEST = 'ControlManifest.xml';
const IDENTITY = 'ControlManifest.xml.data.xml';
const METADATA_LIMIT = 1024 * 1024;
// Files a declared code or style resource refers to by a relative URL (a source map, a font or an image in its CSS).
// They are served from the same control folder when they exist, never anything else.
const SIBLING = /\.(?:map|png|jpe?g|gif|svg|webp|ico|bmp|woff2?|ttf|otf|eot)$/i;
const mib = (bytes) => `${Math.round((bytes / 1024 / 1024) * 100) / 100} MiB`;
const attempt = async (task) => {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error };
  }
};

/** Bytes that a catalogue import retained for its controls (`retainBytes`), handed once to the caller that asked for them. */
export function takeAdmittedFiles(controls) {
  const admitted = admittedFiles.get(controls) ?? new Map();
  admittedFiles.delete(controls);
  return admitted;
}

// A control folder on disk. `locate` resolves a control-relative path to a regular file inside the folder, or null.
/**
 * A control-relative resource path as a normalized `a/b.ext`, or null. Decided on the text alone, before any file system
 * call: a backslash (a UNC or Windows path), a colon (drive or scheme), `?`, `#`, a control character, a leading slash
 * or a path that leaves the control folder is refused, so no lookup ever reaches another folder, share or host.
 */
export function controlRelativePath(value) {
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex -- control bytes are refused in untrusted manifest and style text.
  if (!text || /[\\:?#\x00-\x1f]/.test(text) || text.startsWith('/')) return null;
  const normalized = path.posix.normalize(text);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized))
    return null;
  return normalized;
}

function directorySource(root, readFile) {
  return {
    root,
    async locate(relative) {
      const safe = controlRelativePath(relative);
      if (!safe) return null;
      // Lexical containment first; the real path is resolved only for a candidate inside the folder (symlinks, junctions).
      const candidate = path.resolve(root, ...safe.split('/'));
      if (!contained(root, candidate) || path.win32.isAbsolute(safe)) return null;
      const file = await fs.realpath(candidate).catch(() => null);
      if (!file || !contained(root, file)) return null;
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      return { file, size: stat.size, read: (maxBytes) => readFile(file, { root, maxBytes }) };
    },
  };
}

// A control folder inside a Solution ZIP: `entries` maps lower-case control-relative names to inflated entries.
function archiveSource(archive, entries) {
  return {
    root: null,
    archive,
    async locate(relative) {
      const normalized = controlRelativePath(relative);
      if (!normalized) return null;
      const entry = entries.get(normalized.toLowerCase());
      if (!entry) return null;
      return {
        file: `${archive}#${entry.name}`,
        archived: true,
        data: entry.data,
        size: entry.data.length,
        read: async () => entry.data,
      };
    },
  };
}

async function readMetadata(source, name, admitted, failure) {
  const located = await source.locate(name);
  if (!located || located.size > METADATA_LIMIT) throw new Error(failure);
  const bytes = await located.read(METADATA_LIMIT);
  admitted.set(located.file, bytes);
  return { located, bytes };
}

const validSchemaName = (name) => typeof name === 'string' && /^[\w.]+$/.test(name);

async function readIdentity(source, admitted, admittedAs) {
  const located = await source.locate(IDENTITY);
  if (!located || located.size > METADATA_LIMIT)
    throw new Error('PCF identity metadata is missing, outside its control or exceeds 1 MiB');
  const bytes = await located.read(METADATA_LIMIT);
  const schemaName = childText(parseSolutionXml(bytes.toString('utf8')), 'Name');
  if (!validSchemaName(schemaName)) throw new Error('PCF identity metadata has no valid exported Name');
  admitted.set(admittedAs ?? located.file, bytes);
  return { schemaName, file: admittedAs ?? located.file };
}

function stringResourceOf({ file, relative, resource, body, diagnostics }) {
  const document = parseSolutionXml(body.toString('utf8'));
  const entries = descendants(document, 'data');
  const strings = Object.create(null),
    duplicates = new Set();
  for (const entry of entries) {
    const key = entry.attrs.name;
    if (!key) {
      diagnostics.push({ code: 'PCF_RESOURCE_KEY_UNRESOLVED', file, message: 'RESX data entry has no name.' });
      continue;
    }
    if (Object.hasOwn(strings, key)) duplicates.add(key);
    else strings[key] = entry.children.find((node) => node.name === 'value')?.text ?? '';
  }
  for (const key of duplicates) {
    delete strings[key];
    diagnostics.push({
      code: 'PCF_RESOURCE_KEY_AMBIGUOUS',
      file,
      key,
      message: 'RESX resource contains duplicate named data entries.',
    });
  }
  const locale = /^(.*)\.(\d+)\.resx$/i.exec(relative);
  const lcid = locale && Number.isSafeInteger(Number(locale[2])) && Number(locale[2]) > 0 ? Number(locale[2]) : null;
  if (!lcid)
    diagnostics.push({
      code: 'PCF_RESOURCE_LANGUAGE_UNRESOLVED',
      file,
      message: 'RESX resource has no documented positive LCID filename suffix.',
    });
  return {
    path: relative,
    group: locale?.[1] ?? relative,
    lcid,
    attributes: { ...resource.attrs },
    document,
    entries,
    strings,
  };
}

// Phase one: every path and containment check of a declared resource, without reading its body.
async function checkResource(source, resource, limit) {
  const relative = resource.attrs.path;
  if (!relative || /[\\?#]/.test(relative)) throw new Error('Declared PCF resource has an invalid path');
  const located = await source.locate(relative);
  if (!located) throw new Error(`Declared PCF resource is missing or outside its control: ${relative}`);
  if (located.size > limit) {
    const error = new Error(
      `Declared PCF resource ${relative} is ${mib(located.size)}, above the ${mib(limit)} limit (pcf.maxResourceBytes).`,
    );
    error.details = { reason: 'PCF_RESOURCE_TOO_LARGE', path: relative, size: located.size, limit };
    throw error;
  }
  return located;
}

const resourceUrl = (token, relative) =>
  `/__sim-static/pcf/${token}/${relative.split('/').map(encodeURIComponent).join('/')}`;
const assetOf = (located, source, extra) => ({
  ...(located.archived ? { archive: source.archive, data: located.data } : { file: located.file, root: source.root }),
  ...extra,
});

// The URL of the leftmost sourceMappingURL comment that ends the body (only whitespace or a closing */ after it).
// A failed candidate resumes the search one character later, as a regular expression search would.
function trailingSourceMap(text) {
  const comment = /[#@]\s*sourceMappingURL=([^\s'"*]+)/g;
  for (let match = comment.exec(text); match; match = comment.exec(text)) {
    const tail = text.slice(match.index + match[0].length).trim();
    if (tail === '' || tail === '*/') return match[1];
    comment.lastIndex = match.index + 1;
  }
  return null;
}

// Relative URLs a code or style body refers to: CSS url(...) and a trailing sourceMappingURL comment.
function referencedSiblings(kind, relative, body) {
  const text = body.toString('utf8');
  const found = new Set();
  if (kind === 'css') for (const match of text.matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi)) found.add(match[2]);
  const map = trailingSourceMap(text);
  if (map) found.add(map);
  found.add(`${relative.split('/').at(-1)}.map`);
  const base = path.posix.dirname(relative);
  const siblings = [];
  for (const url of found) {
    // A query or fragment (font.woff2?v=1, font.eot#iefix) names the same file; the path left is checked as text, raw and
    // decoded: a scheme, drive, backslash, UNC or absolute reference is never resolved.
    const raw = url.split(/[?#]/)[0];
    const decoded = decodeURIComponentSafe(raw);
    // eslint-disable-next-line no-control-regex -- control bytes are refused in untrusted style text.
    if (!raw || !decoded || [raw, decoded].some((text) => /[\\:?#\x00-\x1f]/.test(text) || text.startsWith('/')))
      continue;
    const joined = controlRelativePath(base === '.' ? decoded : `${base}/${decoded}`);
    if (joined && SIBLING.test(joined)) siblings.push(joined);
  }
  return siblings;
}
function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function siblingAssets({ source, token, resources, bodies, limit, declaredAssets }) {
  const siblings = new Map();
  for (const [index, resource] of resources.entries()) {
    if (!['code', 'css'].includes(resource.kind)) continue;
    for (const relative of referencedSiblings(resource.kind, resource.path, bodies[index])) {
      const url = resourceUrl(token, relative);
      if (declaredAssets.has(url) || siblings.has(url)) continue;
      const located = await source.locate(relative).catch(() => null);
      if (!located || located.size > limit) continue;
      siblings.set(
        url,
        assetOf(located, source, {
          kind: 'sibling',
          path: relative,
          ...(limit === PCF_RESOURCE_LIMIT ? {} : { maxBytes: limit }),
        }),
      );
    }
  }
  return siblings;
}

// Checks run for every declaration; bodies are read only up to the first failed check, as the serial reading did.
// The fold then applies declaration order, so the first failure decides the error and the diagnostics before it.
async function readDeclaredResources({ source, token, declared, admitted, digest, diagnostics, limit }) {
  const checks = await orderedMap(declared, 16, (resource) => attempt(() => checkResource(source, resource, limit)));
  const failed = checks.findIndex((check) => !check.ok);
  const readable = checks.slice(0, failed < 0 ? checks.length : failed);
  const bodies = await orderedMap(readable, 16, (check) => attempt(() => check.value.read(limit)));
  const resources = [],
    stringResources = [],
    declaredAssets = new Map(),
    bodyList = [];
  for (const [index, resource] of declared.entries()) {
    if (!checks[index].ok) throw checks[index].error;
    if (!bodies[index].ok) throw bodies[index].error;
    const located = checks[index].value;
    const body = bodies[index].value;
    const relative = resource.attrs.path;
    const url = resourceUrl(token, relative);
    digest.update(relative).update(body);
    declaredAssets.set(
      url,
      assetOf(located, source, {
        kind: resource.name,
        contentRevision: createHash('sha256').update(body).digest('hex'),
        ...(limit === PCF_RESOURCE_LIMIT ? {} : { maxBytes: limit }),
      }),
    );
    admitted.set(located.file, body);
    // SDK bundles can export their constructor through a classic script
    // module rather than a namespace or registerControl call. Bind only
    // a declaration from this exact declared resource, never scan globals.
    const exportGlobal = resource.name === 'code' ? classicExportGlobal(body.toString('utf8')) : undefined;
    resources.push({
      kind: resource.name,
      path: relative,
      url,
      order: Number(resource.attrs.order) || 0,
      attributes: { ...resource.attrs },
      ...(exportGlobal ? { exportGlobal } : {}),
    });
    bodyList.push(body);
    if (resource.name === 'resx')
      stringResources.push(stringResourceOf({ file: located.file, relative, resource, body, diagnostics }));
  }
  const siblings = await siblingAssets({ source, token, resources, bodies: bodyList, limit, declaredAssets });
  return { resources, stringResources, declaredAssets, siblings };
}

const enumValues = (property) =>
  (property.children ?? [])
    .filter((node) => node.name === 'value')
    .map((node) => ({
      name: node.attrs.name ?? null,
      value: (node.text ?? '').trim(),
      displayNameKey: node.attrs['display-name-key'] ?? null,
    }));

function controlProperties(control) {
  const typeGroups = Object.fromEntries(
    descendants(control, 'type-group').map((group) => [
      group.attrs.name,
      group.children.filter((node) => node.name === 'type').map((node) => node.text.trim()),
    ]),
  );
  // Only the control's own <property> declarations: a data-set's property-set is a dataset column, not a parameter.
  return (control.children ?? [])
    .filter((node) => node.name === 'property')
    .map((property) => {
      const values = enumValues(property);
      return {
        ...property.attrs,
        types: typeGroups[property.attrs['of-type-group']],
        ...(values.length ? { values } : {}),
      };
    });
}

// Manifest facts a host reads besides properties and resources (manifest schema reference: control, property-dependencies,
// common-property, external-service-usage). Attributes are kept as exported.
function controlFacts(control) {
  const children = control.children ?? [];
  const external = children.find((node) => node.name === 'external-service-usage');
  return {
    version: control.attrs.version ?? null,
    apiVersion: control.attrs['api-version'] ?? null,
    displayNameKey: control.attrs['display-name-key'] ?? null,
    descriptionKey: control.attrs['description-key'] ?? null,
    propertyDependencies: children
      .filter((node) => node.name === 'property-dependencies')
      .flatMap((node) => node.children.filter((child) => child.name === 'property-dependency'))
      .map((node) => ({ ...node.attrs })),
    commonProperties: children.filter((node) => node.name === 'common-property').map((node) => ({ ...node.attrs })),
    externalServiceUsage: external
      ? {
          enabled: external.attrs.enabled ?? null,
          domains: external.children.filter((node) => node.name === 'domain').map((node) => node.text.trim()),
        }
      : null,
  };
}

async function readManifest(source, admitted) {
  const { located, bytes } = await readMetadata(
    source,
    MANIFEST,
    admitted,
    'PCF manifest is missing, outside its control or exceeds 1 MiB',
  );
  const manifest = bytes.toString('utf8');
  const control = descendants(parseSolutionXml(manifest), 'control')[0];
  if (!control) throw new Error('PCF manifest has no control declaration');
  return { manifest, control, file: located.file };
}

async function controlRecord({ source, schemaName, identityFile, manifest, admitted, diagnostics, limit }) {
  const { control } = manifest;
  const token = createHash('sha256')
    .update(source.root ?? source.archive)
    .update(manifest.manifest)
    .digest('hex')
    .slice(0, 24);
  const digest = createHash('sha256').update(manifest.manifest);
  const libraries = [],
    dependencies = [],
    declared = [];
  for (const resource of descendants(control, 'resources')[0]?.children ?? []) {
    if (resource.name === 'platform-library') libraries.push({ ...resource.attrs });
    else if (resource.name === 'dependency')
      dependencies.push({
        type: resource.attrs.type ?? null,
        name: resource.attrs.name ?? null,
        order: resource.attrs.order ?? null,
        loadType: resource.attrs['load-type'] ?? null,
      });
    else if (resourceKinds.has(resource.name)) declared.push(resource);
    else
      diagnostics.push({
        code: 'PCF_RESOURCE_KIND_UNSUPPORTED',
        file: manifest.file,
        kind: resource.name,
        message: `PCF manifest declares a <${resource.name}> resource that no local host reads.`,
      });
  }
  const { resources, stringResources, declaredAssets, siblings } = await readDeclaredResources({
    source,
    token,
    declared,
    admitted,
    digest,
    diagnostics,
    limit,
  });
  if (!resources.some((resource) => resource.kind === 'code'))
    throw new Error('PCF manifest does not declare an executable code resource');
  const record = {
    schemaName,
    constructor: `${control.attrs.namespace}.${control.attrs.constructor}`,
    type: control.attrs['control-type'],
    ...controlFacts(control),
    dataset: descendants(control, 'data-set').length > 0,
    datasets: descendants(control, 'data-set').map((node) => {
      // A data-set's property-set children declare the columns the control expects to be configured.
      const propertySets = (node.children ?? [])
        .filter((child) => child.name === 'property-set')
        .map((child) => ({ ...child.attrs }));
      return { ...node.attrs, ...(propertySets.length ? { propertySets } : {}) };
    }),
    properties: controlProperties(control),
    events: (control.children ?? []).filter((node) => node.name === 'event').map((node) => ({ ...node.attrs })),
    features: (control.children ?? [])
      .filter((node) => node.name === 'feature-usage')
      .flatMap((node) =>
        node.children.filter((child) => child.name === 'uses-feature').map((child) => ({ ...child.attrs })),
      ),
    libraries,
    dependencies,
    resources: resources.sort((a, b) => a.order - b.order), // NOSONAR: retain in-place receiver mutation and ordering
    strings: {},
    stringResources,
    file: source.archive ? undefined : manifest.file,
    identityFile: source.archive ? undefined : identityFile,
    ...(source.archive ? { archive: { file: source.archive, entry: manifest.file.split('#').at(-1) } } : {}),
    sourceAssets: [...declaredAssets].map(([url, asset]) => ({
      url,
      file: asset.file,
      contentRevision: asset.contentRevision,
    })),
    sourceContentRevision: createHash('sha256').update(manifest.manifest).digest('hex'),
    fingerprint: digest.digest('hex'),
  };
  return { control: record, assets: new Map([...declaredAssets, ...siblings]) };
}

// The schema name of a pcf-scripts build output control: publisher prefix, underscore, namespace.constructor (the
// name `pac solution` and `pac pcf push` give the customcontrol). Only a declared prefix names it.
function buildSchemaName(control, prefix) {
  const { namespace, constructor } = control.attrs;
  const name = namespace && constructor ? `${prefix}_${namespace}.${constructor}` : null;
  if (!validSchemaName(name))
    throw new Error('PCF build output manifest has no valid namespace and constructor to name its control');
  return name;
}

// The schema name a control supersedes, from its archive naming, its build manifest or its identity file. A build
// output without an identity file is named by its manifest, which `read` keeps so it is read once (and is the
// evidence when the name is invalid).
async function identifyControl(source, naming, state, read) {
  if (naming.kind === 'archive') {
    if (!naming.schemaName) throw new Error('PCF control has no CustomControl declaration in customizations.xml');
    state.supersedes = naming.schemaName;
  } else if (naming.kind === 'build' && !(await source.locate(IDENTITY))) {
    read.manifest = await readManifest(source, state.admitted);
    read.manifestFile = read.manifest.file;
    state.supersedes = buildSchemaName(read.manifest.control, naming.publisherPrefix);
  } else {
    const identity = await readIdentity(source, state.admitted, path.join(source.root, IDENTITY));
    state.supersedes = identity.schemaName;
    read.identityFile = identity.file;
  }
}

// The collision evidence of a control without a readable identity: its folder and its manifest constructor.
async function unresolvedControl({ source, folder, naming }, read) {
  const evidence = read.manifest ?? (await attempt(() => readManifest(source, new Map()))).value;
  const { namespace, constructor: name } = evidence?.control.attrs ?? {};
  const constructor = namespace && name ? `${namespace}.${name}` : null;
  const prefix = naming.kind === 'build' ? naming.publisherPrefix : null;
  return { folder: folder.name, constructor, prefix, file: read.manifestFile };
}

// Read stage for one control. It pushes nothing shared: the fold applies the returned state in control-name order.
async function readControl({ source, folder, naming, limit }) {
  const state = { supersedes: null, identified: false, diagnostics: [], admitted: new Map(), folder };
  const read = {
    manifest: null,
    manifestFile: source.archive ? `${source.archive}#${folder.entry}/${MANIFEST}` : path.join(source.root, MANIFEST),
    identityFile: null,
  };
  try {
    await identifyControl(source, naming, state, read);
    state.identified = true;
    read.manifest ??= await readManifest(source, state.admitted);
    read.manifestFile = read.manifest.file;
    const result = await controlRecord({
      source,
      schemaName: state.supersedes,
      identityFile: read.identityFile,
      manifest: read.manifest,
      admitted: state.admitted,
      diagnostics: state.diagnostics,
      limit,
    });
    return { ...state, ...result };
  } catch (error) {
    if (error.code === 'MODEL_CLIENT_IMPORT_LIMIT') return { fatal: error };
    state.diagnostics.push({
      code: state.identified ? 'PCF_IMPORT_FAILED' : 'PCF_IDENTITY_UNRESOLVED',
      file: read.manifestFile,
      message: error.message,
      ...error.details,
    });
    if (state.identified) return state;
    return { ...state, unresolved: await unresolvedControl({ source, folder, naming }, read) };
  }
}

const byCodeUnit = (a, b) => Number(a > b) - Number(a < b);

async function directorySlot({ parent, name, readFile, naming, limit }) {
  const root = await fs.realpath(path.join(parent, name)).catch(() => null);
  if (!root || !contained(parent, root) || !(await fs.stat(root)).isDirectory()) return null;
  const has = async (file) => Boolean(await fs.stat(path.join(root, file)).catch(() => null));
  // A build output folder that holds files but no manifest yet (a rebuild in progress) is a control without identity.
  const empty = async () => !(await fs.readdir(root)).length;
  if (!(await has(MANIFEST)) && (naming.kind === 'build' ? await empty() : !(await has(IDENTITY)))) return null;
  return readControl({ source: directorySource(root, readFile), folder: { name }, naming, limit });
}

// A layer's control folders: <layer>/Controls (any letter case) of an unpacked Solution, only the folders a YAML
// solution lists, the archive's Controls entries, or every folder of a pcf-scripts build output.
async function controlFolderParents(layer) {
  const layerRoot = await fs.realpath(layer.dir).catch(() => null);
  if (!layerRoot) return [];
  if (layer.type === 'pcf-build') return [layerRoot];
  const entries = await fs.readdir(layerRoot, { withFileTypes: true }).catch(() => []);
  const parents = [];
  for (const entry of entries
    .filter((item) => /^controls$/i.test(item.name))
    .sort((a, b) => byCodeUnit(a.name, b.name))) {
    const parent = await fs.realpath(path.join(layerRoot, entry.name)).catch(() => null);
    if (parent && contained(layerRoot, parent) && (await fs.stat(parent)).isDirectory()) parents.push(parent);
  }
  return parents;
}

// A YAML solution holds only the component folders its solutioncomponents.yml lists (the scan keeps their files).
function yamlMembers(layer) {
  if (layer.format !== 'yaml' || !Array.isArray(layer.files)) return null;
  return new Set(
    layer.files
      .map((file) => /^controls\/([^/]+)\//i.exec(String(file.relative ?? ''))?.[1])
      .filter(Boolean)
      .map((name) => name.toLowerCase()),
  );
}

async function directorySlots(layer, { readFile, limit }) {
  const naming =
    layer.type === 'pcf-build' ? { kind: 'build', publisherPrefix: layer.publisherPrefix } : { kind: 'exported' };
  const members = yamlMembers(layer);
  const slots = [];
  for (const parent of await controlFolderParents(layer)) {
    // Code-unit order, not the file system listing order: a later control supersedes an earlier one.
    const names = (await fs.readdir(parent))
      .filter((name) => !members || members.has(name.toLowerCase()))
      .sort(byCodeUnit);
    for (const name of names) slots.push(() => directorySlot({ parent, name, readFile, naming, limit }));
  }
  return slots;
}

// Solution ZIP: Controls/<folder>/... entries, named by the CustomControl declarations of customizations.xml (the
// node SolutionPackager writes to ControlManifest.xml.data.xml when it unpacks).
async function archiveSlots(layer, { readFile, limit }) {
  const bytes = await readFile(layer.dir, { maxBytes: SOLUTION_ASSET_LIMITS.archiveBytes });
  const entries = readSolutionAssetEntries(bytes, {
    include: (name) => /^controls\//i.test(name) || /^customizations\.xml$/i.test(name),
  });
  const names = new Map();
  const customizations = entries.find((entry) => /^customizations\.xml$/i.test(entry.name));
  if (customizations)
    for (const node of descendants(parseSolutionXml(customizations.data.toString('utf8')), 'CustomControl')) {
      const name = childText(node, 'Name');
      const folder = /^\/?controls\/([^/]+)\//i.exec(childText(node, 'FileName') ?? '')?.[1];
      if (folder && validSchemaName(name)) names.set(folder.toLowerCase(), name);
    }
  const folders = new Map();
  for (const entry of entries) {
    const match = /^(controls\/([^/]+))\/(.+)$/i.exec(entry.name);
    if (!match || entry.name.endsWith('/')) continue;
    const key = match[2];
    if (!folders.has(key)) folders.set(key, { entry: match[1], files: new Map() });
    folders.get(key).files.set(match[3].toLowerCase(), entry);
  }
  return [...folders.keys()].sort(byCodeUnit).map((name) => () => {
    const folder = folders.get(name);
    if (!folder.files.has(MANIFEST.toLowerCase())) return null;
    return readControl({
      source: archiveSource(layer.dir, folder.files),
      folder: { name, entry: folder.entry },
      naming: { kind: 'archive', schemaName: names.get(name.toLowerCase()) },
      limit,
    });
  });
}

async function layerSlots(layer, options, diagnostics) {
  if (!layer?.dir) return [];
  if (layer.type === 'zip') {
    const read = await attempt(() => archiveSlots(layer, options));
    if (read.ok) return read.value;
    if (read.error.code === 'MODEL_CLIENT_IMPORT_LIMIT') throw read.error;
    diagnostics.push({ code: 'PCF_ARCHIVE_UNREADABLE', file: layer.dir, message: read.error.message });
    return [];
  }
  if (layer.type && !['directory', 'pcf-build'].includes(layer.type)) return [];
  if (layer.type === 'pcf-build' && !/^[a-z][a-z\d]{1,7}$/i.test(layer.publisherPrefix ?? ''))
    throw new TypeError('A pcf-build layer needs its publisher prefix');
  return directorySlots(layer, options);
}

const collides = (unresolved, name, control) =>
  canonical(name) === canonical(unresolved.folder) ||
  (unresolved.constructor && canonical(control.constructor) === canonical(unresolved.constructor));

// The earlier controls a control without a readable identity could supersede: those of its folder name or constructor.
// A build output (pcf-scripts names the folder after the constructor) also matches <prefix>_<namespace>.<folder>; with
// neither a constructor nor such a match, any earlier control of its publisher prefix could be the one it replaces.
function shadowedControls(unresolved, controls) {
  const direct = [...controls].filter(([name, control]) => collides(unresolved, name, control)).map(([name]) => name);
  if (!unresolved.prefix) return direct;
  const prefix = `${unresolved.prefix.toLowerCase()}_`;
  const ofPrefix = [...controls.keys()].filter((name) => name.toLowerCase().startsWith(prefix));
  const folder = `.${unresolved.folder.toLowerCase()}`;
  const found = [...new Set([...direct, ...ofPrefix.filter((name) => name.toLowerCase().endsWith(folder))])];
  return found.length || unresolved.constructor ? found : ofPrefix;
}

/**
 * Import standard controls and serve only resource paths explicitly declared in the manifest (plus the source maps,
 * fonts and images those declared files refer to inside the same control folder). Layers are unpacked Solution
 * directories (`Controls/<Name>` with `ControlManifest.xml.data.xml`), YAML solutions (their listed control folders),
 * Solution ZIPs (`type: 'zip'`) and pcf-scripts build outputs (`type: 'pcf-build'`, `publisherPrefix`), in order: a later
 * control supersedes an earlier one of the same name.
 */
/* NOSONAR: preserve asynchronous lifecycle and concurrent operation ordering */ export async function importCodeComponents(
  layers = [],
  { readFile = readLocalFile, retainBytes = false, maxResourceBytes = PCF_RESOURCE_LIMIT } = {},
) {
  const controls = new Map(),
    assets = new Map(),
    diagnostics = [],
    admitted = new Map(),
    owned = new Map();
  const forget = (name) => {
    const previous = controls.get(name);
    for (const url of previous ? (owned.get(name)?.urls ?? []) : []) assets.delete(url);
    for (const file of owned.get(name)?.files ?? []) admitted.delete(file);
    owned.delete(name);
    controls.delete(name);
  };
  // Applied in control-name order, so a declaration still supersedes the earlier control even when its manifest fails.
  const apply = (result) => {
    if (result.fatal) throw result.fatal;
    if (result.supersedes) forget(result.supersedes);
    diagnostics.push(...result.diagnostics);
    // A control without a readable identity could have superseded an earlier control of its folder name or of its
    // constructor: that control is withdrawn too (never served as a fallback) and named. Unrelated controls stay.
    if (result.unresolved)
      for (const name of shadowedControls(result.unresolved, controls)) {
        forget(name);
        diagnostics.push({
          code: 'PCF_IDENTITY_SHADOWED',
          file: result.unresolved.file,
          name,
          message: `Code component ${name} is withdrawn: the later control folder ${result.unresolved.folder} has no readable identity and could supersede it.`,
        });
      }
    if (!result.control) return;
    controls.set(result.control.schemaName, result.control);
    owned.set(result.control.schemaName, {
      urls: [...result.assets.keys()],
      files: retainBytes ? [...result.admitted.keys()] : [],
    });
    for (const [url, asset] of result.assets) assets.set(url, asset);
    if (retainBytes) for (const [file, bytes] of result.admitted) admitted.set(file, bytes);
  };
  const options = { readFile, limit: maxResourceBytes };
  for (const layer of layers) {
    const slots = await layerSlots(layer, options, diagnostics);
    // Every control settles before the fold, so a failed read never leaves another read pending.
    const outcomes = await orderedMap(slots, 8, (slot) => attempt(slot));
    for (const outcome of outcomes) {
      if (!outcome.ok) throw outcome.error;
      if (outcome.value) apply(outcome.value);
    }
  }
  if (retainBytes) admittedFiles.set(controls, admitted);
  return { controls, assets, diagnostics };
}

/** Whether a native field binding names the control's declared bound properties of a non-dataset control. */
function validNativeBinding(control, nativeBinding) {
  const properties = nativeBinding.properties;
  return !(
    control.dataset ||
    typeof nativeBinding.id !== 'string' ||
    !nativeBinding.id ||
    !Array.isArray(properties) ||
    !properties.length ||
    properties.some(
      (name) =>
        !control.properties.some((property) => property.name === name && NATIVE_BINDABLE_USAGES.has(property.usage)),
    )
  );
}

// The notice of a Liquid-hosted control with data sets: bound locally through the "view" setting, or unbound.
function liquidDatasetNotice(schema, liquidDatasetBinding) {
  if (liquidDatasetBinding === 'view')
    return {
      code: 'PCF_LIQUID_DATASET_LOCAL',
      severity: 'warning',
      message: `Code component ${schema} binds its data sets to tag arguments through the local pcf.liquidDatasetBinding "view" setting; the Power Pages Liquid tag binds no data set.`,
    };
  return {
    code: 'PCF_LIQUID_DATASET_UNBOUND',
    severity: 'info',
    message: `Code component ${schema} is hosted by the Liquid tag, which binds no data set: its data sets have no view and no rows, as on Power Pages. Set pcf.liquidDatasetBinding to "view" for a local-only view binding.`,
  };
}

// One data set of a native host: the bound one reads its view; the other posts the same grid (an empty sort, no
// search) and shows no rows.
function nativeHostDataset(dataset, isBound, { metadata, mappings, nativeDataset, diagnostic, schema }) {
  if (!isBound)
    return unboundComponentDataset(dataset, 'empty', {
      entity: nativeDataset.entity,
      service: nativeDataset.service,
      secure: nativeDataset.secure,
      pageSize: nativeDataset.pageSize,
    });
  const result = nativeComponentDataset(dataset, { metadata, mappings, nativeDataset, diagnostic });
  if (result.error) return result;
  if (result.dataset.entity !== nativeDataset.entity)
    return { error: `Code component ${schema} has a native dataset view for a different table.` };
  result.dataset.pageSize = nativeDataset.pageSize;
  return result;
}

function resolveComponentDataset(dataset, isBound, options) {
  const { args, metadata, mappings, schema, nativeDataset, access, liquidDatasetBinding, diagnostic } = options;
  if (nativeDataset) return nativeHostDataset(dataset, isBound, options);
  if (liquidDatasetBinding === 'view')
    return liquidComponentDataset(dataset, { args, metadata, mappings, schema, diagnostic, access });
  return unboundComponentDataset(dataset, 'none');
}

/**
 * The control's resolved datasets; or the first error. A list or subgrid binds its view to one data set (the
 * subgrid's FormXml data-set, else the first, which the platform marks IsDefault) and hands the others no rows; the
 * Liquid tag binds none unless the local pcf.liquidDatasetBinding "view" setting asks for the explicit view binding.
 * A data set other than the first reports its updatedProperties with its name as prefix (second_dataset).
 */
function resolveCodeComponentDatasets(
  control,
  { args, metadata, mappings, schema, nativeDataset, access, liquidDatasetBinding, diagnostic },
) {
  const datasets = [];
  const bound = nativeDataset?.property ?? control.datasets?.[0]?.name;
  if (!nativeDataset && control.datasets?.length) diagnostic?.(liquidDatasetNotice(schema, liquidDatasetBinding));
  const options = { args, metadata, mappings, schema, nativeDataset, access, liquidDatasetBinding, diagnostic };
  for (const [index, dataset] of (control.datasets ?? []).entries()) {
    const result = resolveComponentDataset(dataset, dataset.name === bound, options);
    if (result.error) return { error: result.error };
    if (index) result.dataset.prefix = dataset.name + '_';
    datasets.push(result.dataset);
  }
  return { datasets };
}

/** The user language the PCF host reports for the selected website language. */
function codeComponentLanguage(language) {
  return language
    ? {
        code: language.code,
        lcid: languageLcid(language),
        isRTL: /^(ar|fa|he|ur)(-|$)/i.test(language.code ?? ''),
      }
    : null;
}

/**
 * Every reason the Power Pages host refuses a control before it binds data, in render order: ineligible feature
 * declarations, then the shared admission (control type, platform libraries) with the Power Pages remedy. Each entry is
 * `{ code, message, details }`; the source graph lists them all, render answers the first.
 */
export function portalPcfRefusals(
  control,
  name = control?.schemaName ?? control?.name,
  { platformLibraries = [] } = {},
) {
  const refusals = [];
  const features = featureEligibility(control.features);
  if (features.some((feature) => !feature.eligible))
    refusals.push({
      code: 'PCF_FEATURE_DECLARATIONS_UNSUPPORTED',
      message: `Code component ${name} has feature declarations that are not eligible for the Power Pages host.`,
      details: { features },
    });
  const admission = pcfAdmission({ ...control, name }, { host: 'power-pages', platformLibraries });
  if (!admission.admitted) refusals.push({ code: admission.code, message: admission.reason, details: {} });
  return refusals;
}

// Render notices that do not refuse the control: dependencies the local host does not load, required parameters without a
// value, and Web API use without any imported table mapping (the client would fail at its first call).
function reportPortalPcfNotices({
  control,
  platformLibraries = [],
  schema,
  args,
  mappings,
  nativeBinding,
  nativeDataset,
  diagnostic,
}) {
  for (const library of control.libraries ?? []) {
    const served = platformLibraries.find((item) => item.name.toLowerCase() === String(library.name).toLowerCase());
    if (served && served.version !== library.version)
      diagnostic({
        code: 'PCF_PLATFORM_LIBRARY_VERSION',
        severity: 'info',
        library: library.name,
        message: `Code component ${schema} declares ${library.name} ${library.version}; the page provides ${served.version}, as Power Pages provides one version to every control.`,
      });
  }
  for (const dependency of control.dependencies ?? []) {
    const loadType = dependency.loadType ? ` (load-type ${dependency.loadType})` : '';
    diagnostic({
      code: 'PCF_DEPENDENCY_NOT_LOADED',
      dependency,
      message: `Code component ${schema} declares a ${dependency.type ?? 'untyped'} dependency on ${dependency.name}${loadType}, which the local Power Pages host does not load.`,
    });
  }
  if (!nativeBinding && !nativeDataset) {
    const missing = (control.properties ?? []).filter(
      (property) =>
        ['true', '1'].includes(String(property.required).trim()) &&
        ['input', 'bound'].includes(property.usage) &&
        property['default-value'] === undefined &&
        args[property.name] === undefined,
    );
    if (missing.length)
      diagnostic({
        code: 'PCF_REQUIRED_PROPERTY_MISSING',
        severity: 'info',
        properties: missing.map((property) => property.name),
        message: `Code component ${schema} has required properties without a tag argument or default: ${missing.map((property) => property.name).join(', ')}.`,
      });
  }
  if ((control.features ?? []).some((feature) => feature.name === 'WebAPI') && !Object.keys(mappings ?? {}).length)
    diagnostic({
      code: 'PCF_WEBAPI_MAPPING_MISSING',
      message: `Code component ${schema} uses the Web API, but no table has an imported Web API mapping: its calls fail until the selected Solutions export the tables it reads.`,
    });
}

// The manifest type a tag argument is read as: its of-type, or the single type of its type group.
const propertyType = (property) => property['of-type'] ?? (property.types?.length === 1 ? property.types[0] : null);

const WALL_CLOCK_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const WALL_CLOCK_TIME = /^[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/i;
const WALL_CLOCK_ZONE = /^\s*(?:Z|[+-]\d{2}:?\d{2})?$/i;

// [year, month, day, hour, minute, second] of `YYYY-MM-DD[( |T)HH:mm[:ss[.fff]]][ ][Z|+hh:mm]`, unset parts undefined.
function wallClockParts(text) {
  const date = WALL_CLOCK_DATE.exec(text);
  if (!date) return null;
  let rest = text.slice(date[0].length);
  const time = WALL_CLOCK_TIME.exec(rest);
  if (time) rest = rest.slice(time[0].length);
  if (!WALL_CLOCK_ZONE.test(rest)) return null;
  return [date[1], date[2], date[3], time?.[1], time?.[2], time?.[3]];
}

// A wall-clock date and time as the live server writes it into ControlProperties: `YYYY-MM-DDTHH:mm:ss`, a trailing Z
// dropped (live: '2026-03-15T14:05:09Z' -> "2026-03-15T14:05:09", '2026-03-15' -> "2026-03-15T00:00:00",
// '2026-03-15 14:05' -> "2026-03-15T14:05:00"). Unobserved: a +hh:mm offset is dropped like Z; other spellings dropped.
function wallClock(text) {
  const match = wallClockParts(text);
  if (!match) return undefined;
  const [year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  )
    return undefined;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

// .NET Int32, the range a Whole property holds (unproven: the live drop of an out-of-range value is not observed).
const INT32 = [-2147483648, 2147483647];
// A plain decimal number: digits with an optional fraction, no exponent, hexadecimal, binary or Infinity spelling.
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

// A Liquid argument value as text: strings, numbers (including Liquid decimals) and Booleans; null for nil; undefined
// for a drop, array or object without its own text.
function argumentText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  // An array is written as its .NET type name (a split result -> "System.String[]").
  if (Array.isArray(value)) return value.every((item) => typeof item === 'string') ? 'System.String[]' : undefined;
  if (typeof value.toString !== 'function' || value.toString === Object.prototype.toString) return undefined;
  return String(value);
}

// A Whole argument: an Int32 integer, else dropped.
function wholeProperty(trimmed) {
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const whole = Number(trimmed);
  return whole >= INT32[0] && whole <= INT32[1] ? whole : undefined;
}

const cultureSeparators = new Map();
// The group and decimal separators of a page culture (Intl); en-US for no culture or one Intl does not know.
function numberSeparators(culture) {
  const name = culture || 'en-US';
  if (!cultureSeparators.has(name)) {
    let separators = { group: ',', decimal: '.' };
    try {
      const parts = new Intl.NumberFormat(name).formatToParts(12345.6);
      separators = {
        group: parts.find((part) => part.type === 'group')?.value ?? ',',
        decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
      };
    } catch {
      // An unknown culture name keeps the en-US separators.
    }
    cultureSeparators.set(name, separators);
  }
  return cultureSeparators.get(name);
}

// Number text read with a page culture as the server reads it: group separators in the integer part are skipped and
// the culture's decimal separator marks the fraction (de-DE '1.25' -> '125', captured). The plain decimal text of the
// number, or undefined when it is none.
function cultureNumberText(trimmed, { group, decimal }) {
  const [whole, ...fraction] = trimmed.split(decimal);
  if (fraction.length > 1) return undefined;
  const digits = /^\s$/u.test(group) ? whole.replaceAll(/\s/gu, '') : whole.split(group).join('');
  const text = fraction.length ? digits + '.' + fraction[0] : digits;
  return DECIMAL_TEXT.test(text) ? text : undefined;
}

// FP, Currency and Decimal arguments. A culture whose decimal separator is '.' keeps the en-US rules: Decimal is always
// dropped, FP and Currency are the plain decimal text as given. Another culture reads the text with its separators:
// Decimal is the number, FP and Currency its text (captured for de-DE only).
function numberProperty(type, trimmed, culture) {
  const separators = numberSeparators(culture);
  const decimal = /^Decimal$/i.test(type);
  if (separators.decimal === '.') return decimal || !DECIMAL_TEXT.test(trimmed) ? undefined : trimmed;
  const text = cultureNumberText(trimmed, separators);
  if (text === undefined) return undefined;
  return decimal ? Number(text) : text;
}

function twoOptionsProperty(value, trimmed) {
  if (value === true || trimmed === 'true') return true;
  // Unobserved: false and 'false' (round 2 observed only that 1 and 'maybe' are dropped).
  if (value === false || trimmed === 'false') return false;
  return undefined;
}

/**
 * A tag argument as the live server writes it into `ControlProperties`, or undefined when the server drops it: SingleLine/Multiple and Enum/OptionSet text as given (an Enum
 * value need not be declared); Whole an integer ('1.5' dropped); Decimal, FP and Currency read with the page culture
 * `culture` (en-US when omitted: Decimal always dropped, FP and Currency the number as text; de-DE: '12.5' -> 125 and
 * '1.25' -> '125'); TwoOptions true/'true' (1 and 'maybe' dropped; false/'false' are passed as false, which is not
 * observed); DateOnly and DateAndTime the wall-clock text. A nil variable is dropped.
 */
export function liquidControlProperty(type, value, culture) {
  const text = argumentText(value);
  if (text == null) return undefined;
  const trimmed = text.trim();
  if (/^Whole\./i.test(type)) return wholeProperty(trimmed);
  if (/^(?:Decimal|FP|Currency)$/i.test(type)) return numberProperty(type, trimmed, culture);
  if (/^TwoOptions$/i.test(type)) return twoOptionsProperty(value, trimmed);
  if (/^DateAndTime\./i.test(type)) return wallClock(trimmed);
  return text;
}

// The ControlProperties of a Liquid tag: only arguments whose key is a manifest input or bound property name, matched
// case-sensitively (live: `textvalue:` does not reach `textValue`); other arguments are ignored as the server ignores
// them. Each dropped or unmatched argument gets a diagnostic so a developer sees why a value is missing.
function liquidControlProperties({ control, schema, args, culture, diagnostic }) {
  const properties = new Map(
    (control.properties ?? [])
      .filter((property) => ['input', 'bound'].includes(property.usage))
      .map((property) => [property.name, property]),
  );
  const datasets = new Set((control.datasets ?? []).map((dataset) => dataset.name));
  const result = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.toLowerCase() === 'name' || datasets.has(key)) continue;
    const property = properties.get(key);
    if (!property) {
      const near = [...properties.keys()].find((name) => name.toLowerCase() === key.toLowerCase());
      diagnostic({
        code: 'PCF_ARGUMENT_IGNORED',
        argument: key,
        message: near
          ? `Code component ${schema} argument ${key} is ignored: argument names match property ${near} case-sensitively, as on Power Pages.`
          : `Code component ${schema} has no input property ${key}; the argument is ignored, as on Power Pages.`,
      });
      continue;
    }
    const type = propertyType(property);
    const coerced = liquidControlProperty(type ?? '', value, culture);
    if (coerced === undefined)
      diagnostic({
        code: 'PCF_ARGUMENT_DROPPED',
        property: key,
        type,
        message: `Code component ${schema} argument ${key} is dropped: Power Pages passes no ${type} value for it.`,
      });
    else result[key] = coerced;
  }
  // A required input without an argument is written empty and the control still renders.
  for (const [name, property] of properties)
    if (
      ['true', '1'].includes(String(property.required).trim()) &&
      property['default-value'] === undefined &&
      args[name] === undefined &&
      !(name in result)
    )
      result[name] = '';
  return result;
}

const IMPORT_CAUSES = new Set(['PCF_IMPORT_FAILED', 'PCF_IDENTITY_UNRESOLVED', 'PCF_IDENTITY_SHADOWED']);
// The import diagnostic of a control by its name or its folder (`<folder>/ControlManifest.xml`, also inside a ZIP).
const importCause = (catalog, wanted) =>
  (catalog.diagnostics ?? []).find(
    (entry) =>
      IMPORT_CAUSES.has(entry.code) &&
      (canonical(entry.name) === canonical(wanted) ||
        canonical(
          String(entry.file ?? '')
            .split(/[\\/#]/)
            .at(-2),
        ) === canonical(wanted)),
  );

/** The page render state a Liquid tag passes on its arguments (liquid.mjs): what the page already loaded. */
export const PCF_PAGE_STATE = Symbol.for('paqvilo.pcf.pageState');

/**
 * The script elements of the platform libraries (pcf.platformLibraries) for one host: all of them, in order, the first
 * time a page asks (`pageState`, one object per page render), nothing after that; without a page state, always. A field
 * host that writes its own markup calls this before its first bundle script.
 */
export function pcfPlatformScripts(libraries = [], pageState = null) {
  if (!libraries.length || pageState?.pcfPlatformScripts) return '';
  if (pageState) pageState.pcfPlatformScripts = true;
  return libraries.map((library) => `<script type="text/javascript" src="${escape(library.url)}"></script>`).join('');
}

/** A tag render that ends the rest of its template, as the Power Pages Liquid host does (liquid.mjs catches it). */
export function liquidRenderHalt(code, message, details = {}) {
  return Object.assign(new Error(message), { liquidHalt: true, code, ...details });
}

/**
 * The `/_pcfwebresource/<guid>` id Mirage gives one served code component resource: a fixed GUID derived from its
 * local address (the live id is the Dataverse web resource id, which an export does not carry).
 */
function pcfWebResourceGuid(url) {
  const hex = createHash('sha256').update(`paqvilo-pcf:${url}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const webResourceIndex = new WeakMap();
/** The local asset key (`/__sim-static/pcf/...`) a `/_pcfwebresource/<guid>` address names in `catalog`, or null. */
export function pcfWebResourceAsset(catalog, guid) {
  let index = webResourceIndex.get(catalog.assets);
  if (!index) {
    index = new Map([...catalog.assets.keys()].map((key) => [pcfWebResourceGuid(key), key]));
    webResourceIndex.set(catalog.assets, index);
  }
  return index.get(String(guid).toLowerCase()) ?? null;
}

// The live attribute encoding of the host span: quotes, ampersands, angle brackets, apostrophes
// and spaces as character references.
const encodeAttribute = (value) =>
  String(value).replace(
    /[&<>"' ]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', ' ': '&#32;' })[c],
  );

// The live Liquid host markup: a Container
// span holding the bundle script, the PcfControlConfig span (data-pcf-control, pcf-controlcontext) and the ControlView
// div the control renders into, all named by a fresh GUID per render. Mirage mounts its host on the ControlView div.
// Kept from the live configuration: every top-level key, the resource entries of the code (Type 0), styles (Type 1) and
// strings (Type 2) with their web resource ids, the ManifestTemplate identity and the property declarations; the other
// Type 3 blobs (ManifestPropertyTypes, PowerAppsControlInfo, FormattingData, LocalizedStrings) are not written.
function liquidHostMarkup({ schema, control, value, controlProperties, strings }) {
  const id = randomUUID();
  const stamp = (resource) => Number.parseInt(createHash('sha256').update(resource.url).digest('hex').slice(0, 10), 16);
  const entry = (Type, Path, LoadingOrder, IsControlSpecific = true) => ({
    Type,
    Path,
    ModifiedPath: '',
    LoadingOrder,
    IsControlSpecific,
  });
  const ofKind = (kind) => control.resources.filter((resource) => resource.kind === kind);
  const config = {
    SubscribedFunctionalities: {},
    DataConnectors: [],
    AuthConfigPropertiesGroups: [],
    Resources: [
      entry(2, null, 0),
      entry(
        3,
        JSON.stringify({
          Id: 'ManifestTemplate',
          Data: {
            ConstructorName: control.constructor,
            CustomControlId: control.constructor,
            IsVirtual: control.type === 'virtual',
          },
        }),
        1,
        false,
      ),
      ...ofKind('resx').map((resource) => entry(2, pcfWebResourceGuid(resource.url), 3)),
      ...ofKind('code').map((resource) => entry(0, pcfWebResourceGuid(resource.url), 4)),
      ...ofKind('css').map((resource) => entry(1, pcfWebResourceGuid(resource.url), 4)),
    ],
    DataSets: [],
    Properties: (control.properties ?? []).map((property) => ({
      Name: property.name,
      DisplayName: strings[property['display-name-key']] ?? property['display-name-key'] ?? property.name,
      Description: strings[property['description-key']] ?? property['description-key'] ?? '',
      DefaultValue: property['default-value'] ?? '',
      Required: ['true', '1'].includes(String(property.required)),
    })),
    IncludedProperties: [],
    PropertyDependencies: [],
    Events: [],
    CommonEvents: [],
    Conversions: [],
    Name: schema,
    IsCdnControl: false,
  };
  const context = {
    UniqueId: `${id}_ControlView`,
    ControlId: id,
    GridDataControlId: null,
    ControlName: schema,
    ControlProperties: controlProperties,
    IsDisabled: false,
    PcfControlHiddenValueId: id,
    PcfDynamicProperyName: null,
  };
  // The page loads the bundle from its native address; Mirage's host then finds it loaded (nativeUrl) instead of
  // loading it a second time.
  const scripts = ofKind('code').map((resource) => {
    const src = `/_pcfwebresource/${pcfWebResourceGuid(resource.url)}?${stamp(resource)}`;
    const item = value.resources.find((candidate) => candidate.url === resource.url);
    if (item) item.nativeUrl = src;
    return `<script type="text/javascript" src="${src}"></script>`;
  });
  return {
    id,
    open: `<span id="${id}_Container" class="flexbox">${scripts.join('')}<span id="PcfControlConfig_${id}" data-pcf-control="${encodeAttribute(JSON.stringify(config))}" pcf-controlcontext="${encodeAttribute(JSON.stringify(context))}"></span>`,
    view: `<div id="${id}_ControlView" class="flexbox" data-mirage-component="codecomponent" data-pcf-schema="${escape(schema)}" aria-busy="true">`,
    close: '</div></span>',
  };
}

/**
 * The answer for a render whose control is not in the catalogue: an inline refusal, or for a Liquid tag the halt that
 * ends the rest of its template.
 */
function unresolvedCodeComponent({ name, schema, catalog, liquidTag, diagnostic, unsupported }) {
  // A Liquid tag whose control is not found renders nothing and ends the rest of its template on Power Pages: the diagnostic says why, the halt does what the live page does.
  const missing = (message, details = {}) => {
    // A Pages.* name is a Microsoft control the environment provides and no export holds (Pages.CardGallery renders
    // a host live): the local host reports it without ending the page. Only that namespace is evidenced.
    const platformControl = /^Pages\./i.test(String(name ?? ''));
    if (!liquidTag || platformControl) return unsupported(message, details);
    // A bare name without a namespace (name:Widget) is read as literal too, which no capture has observed.
    const undotted = name != null && !codeComponentGuid(name) && !String(name).includes('.');
    diagnostic?.({
      code: 'PCF_LIQUID_CONTROL_NOT_FOUND',
      name,
      schema,
      message: `${message} Power Pages renders nothing for this tag and ends the rest of the template there.${undotted ? ' (A name without a namespace is read as a literal name; that form was not observed live.)' : ''}`,
      ...(undotted ? { unobserved: 'undotted-name' } : {}),
      ...details,
    });
    throw liquidRenderHalt('PCF_LIQUID_CONTROL_NOT_FOUND', message);
  };
  // A control that the catalogue import refused or withdrew names that cause instead of "not found".
  const notFound = (wanted) => {
    const cause = importCause(catalog, wanted);
    return cause
      ? missing(`Code component ${wanted} was not imported: ${cause.message}`, { importCode: cause.code })
      : missing(`Code component ${wanted} was not found in the selected solution sources.`);
  };
  if (name == null || name === '')
    return missing('The codecomponent tag names no control: its name argument has no value.');
  if (!schema)
    return codeComponentGuid(name)
      ? missing(`Code component ${name} requires an observed GUID-to-control mapping and solution sources.`)
      : notFound(name);
  return notFound(schema);
}

/**
 * Admits a native field binding as the Power Pages form host does (captured), or answers
 * `{ error, details }`: the binding names declared bound or input properties of a non-dataset control, the column type
 * is admitted, the property types resolve, and every static FormXml input converts. Type mismatches are warnings.
 */
function admitNativeBinding(control, nativeBinding, { schema, name, args, diagnostic, onNativeRefused }) {
  if (!validNativeBinding(control, nativeBinding))
    return {
      error: `Code component ${schema} has no valid native binding to its declared bound or input properties. Dataset properties cannot host this field.`,
    };
  const exported = nativeBinding.properties;
  const column = nativeBinding.column?.logicalName ?? nativeBinding.id;
  const { admitted, typeCode } = nativeFieldAdmission(nativeBinding.control, nativeBinding.column?.dataverseType);
  if (!admitted)
    return {
      error: `Code component ${schema}: ${nativeFieldRefusal(typeCode ?? 'Unknown', nativeBinding.context?.label ?? column, column)}`,
      details: { reason: 'PCF_NATIVE_TYPE_UNSUPPORTED', field: nativeBinding.id },
    };
  // The host's dynamic property (PcfDynamicProperyName) is the bound property the FormXml binds to the column. A
  // binding to an input property leaves the host without one: that input and the manifest's bound properties get no
  // value, and the bound properties carry the column's attributes (captured).
  const bound = exported.filter(
    (property) => control.properties.find((candidate) => candidate.name === property)?.usage === 'bound',
  );
  const columnProperties = bound.length
    ? bound
    : control.properties.filter((property) => property.usage === 'bound').map((property) => property.name);
  const typed = nativeBindingTypes(control, { ...nativeBinding, properties: columnProperties }, schema);
  if (typed.error)
    return {
      error: typed.error,
      details: {
        reason: typed.reason,
        field: nativeBinding.id,
        ...(typed.property ? { property: typed.property } : {}),
      },
    };
  for (const warning of typed.warnings)
    diagnostic?.({
      code: 'PCF_NATIVE_TYPE_MISMATCH',
      severity: 'warning',
      name,
      schema,
      field: nativeBinding.id,
      ...warning,
    });
  const statics = nativeStaticInputs(control, args, { schema, field: nativeBinding.id, onNativeRefused });
  if (statics.error) return statics;
  return { binding: { ...typed.binding, properties: bound, columnProperties }, statics: statics.values };
}

/** Static FormXml inputs, converted by the host; a value it cannot convert refuses the whole control. */
function nativeStaticInputs(control, args, { schema, field, onNativeRefused }) {
  const values = {};
  for (const property of control.properties) {
    if (property.usage === 'bound' || !Object.hasOwn(args, property.name)) continue;
    const type = property['of-type'] || property.types?.[0];
    const converted = nativeStaticValue(args[property.name], type);
    if (converted.refused) {
      onNativeRefused?.({ reason: 'PCF_NATIVE_STATIC_UNCONVERTIBLE', property: property.name });
      return {
        error: `Code component ${schema} static input ${property.name} has the value "${args[property.name]}", which the Power Pages host cannot convert to ${type}; it refuses the control ("an unknown problem").`,
        details: { reason: 'PCF_NATIVE_STATIC_UNCONVERTIBLE', field, property: property.name },
      };
    }
    values[property.name] = converted.value;
  }
  return { values };
}

/** Whether a list or subgrid binding names a data set the control declares (any, without a FormXml data-set name). */
function nativeDatasetMatches(control, nativeDataset) {
  if (!control.datasets?.length) return false;
  return !nativeDataset.property || control.datasets.some((dataset) => dataset.name === nativeDataset.property);
}

/** The rendered control id: keyed by the control, its arguments and its native dataset binding. */
function codeComponentId(schema, args, nativeDataset) {
  const hash = createHash('sha256').update(schema).update(json(args));
  if (nativeDataset) hash.update(json(nativeDataset));
  return `pcf-${hash.digest('hex').slice(0, 16)}`;
}

/** The saved control state id: keyed by the control's configuration and native field, not by its bound values. */
function codeComponentStateId({ control, schema, args, nativeBinding, stateScope, nativeDataset }) {
  const bound = new Set(
    control.properties.filter((property) => property.usage === 'bound').map((item) => item.name.toLowerCase()),
  );
  const stateHash = createHash('sha256')
    .update(schema)
    .update(json(Object.fromEntries(Object.entries(args).filter(([name]) => !bound.has(name.toLowerCase())))))
    .update(json(nativeBinding?.id ?? null))
    .update(json(stateScope ?? null));
  if (nativeDataset) stateHash.update(json(nativeDataset));
  return `pcf-state-${stateHash.digest('hex').slice(0, 16)}`;
}

/** The live Liquid host structure of a rendered control, then Mirage's mount of its ControlView div. */
function renderLiquidHost({
  prefix,
  schema,
  control,
  value,
  strings,
  platformLibraries,
  pageState,
  component,
  mount,
  onRendered,
}) {
  const host = liquidHostMarkup({
    schema,
    control,
    value,
    controlProperties: value.args,
    strings,
  });
  // The platform libraries run before the first bundle of the page, as the live page-level bundles do: a bundle
  // built with React as an external reads window.React when it loads.
  const platform = pcfPlatformScripts(platformLibraries, pageState);
  const containerStart = prefix.length + platform.length;
  const viewStart = containerStart + host.open.length;
  const mountStart = viewStart + host.view.length + host.close.length;
  onRendered?.({
    start: containerStart,
    end: containerStart + `<span id="${host.id}_Container" class="flexbox">`.length,
    tag: 'span',
    component,
    attributes: [{ name: 'id', value: `${host.id}_Container` }],
  });
  onRendered?.({
    start: viewStart,
    end: viewStart + host.view.length,
    tag: 'div',
    component,
    attributes: [{ name: 'data-pcf-schema', value: schema }],
  });
  onRendered?.({ start: mountStart, end: mountStart + '<script>'.length, tag: 'script', component, attributes: [] });
  // The live structure, then Mirage's mount of the ControlView div (the last child of the Container span).
  return (
    prefix +
    platform +
    host.open +
    host.view +
    host.close +
    mount('document.currentScript.previousElementSibling.lastElementChild')
  );
}

/**
 * The Power Pages host kind: a basic/multistep form field, a form subgrid (nativeDataset.context: the parent form
 * record { entityTypeName, entityId }), an entity list (a native dataset without a record) or a Liquid tag.
 */
function codeComponentHost(nativeBinding, nativeDataset) {
  let host = 'liquid';
  if (nativeBinding) host = 'field';
  else if (nativeDataset) host = nativeDataset.context ? 'subgrid' : 'list';
  return {
    host,
    datasetContext: nativeDataset?.context
      ? { entityTypeName: nativeDataset.context.entityTypeName ?? null, entityId: nativeDataset.context.entityId ?? '' }
      : null,
  };
}

export function renderCodeComponent({
  name,
  args = {},
  portal,
  catalog,
  mappings = {},
  metadata = {},
  language,
  nativeBinding: exportedBinding,
  nativeDataset,
  stateScope,
  liquidTag = false,
  platformLibraries = [],
  pageState = args?.[PCF_PAGE_STATE] ?? null,
  webApi,
  // The local pcf.liquidDatasetBinding setting: "none" (default, as Power Pages) or "view" (explicit local binding).
  liquidDatasetBinding = 'none',
  diagnostic,
  onRendered,
  onNativeBinding,
  onNativeRefused,
}) {
  let nativeBinding = exportedBinding;
  let mountArgs = args,
    nativeStatics = {};
  const schema =
    [...catalog.controls.keys()].find((schema) => canonical(schema) === canonical(name)) ??
    portal.observed?.codeComponents?.[codeComponentGuid(name) ?? canonical(name)];
  const control = schema && catalog.controls.get(schema);
  const unsupported = (message, details = {}) => {
    diagnostic?.({ code: 'PCF_HOST_UNSUPPORTED', name, schema, message, ...details });
    if (nativeDataset) return null;
    return `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
  };
  if (name == null || name === '' || !control)
    return unresolvedCodeComponent({ name, schema, catalog, liquidTag, diagnostic, unsupported });
  const [refusal] = portalPcfRefusals(control, schema, { platformLibraries });
  if (refusal) return unsupported(refusal.message, { reason: refusal.code, ...refusal.details });
  reportPortalPcfNotices({
    control,
    platformLibraries,
    schema,
    args,
    mappings,
    nativeBinding,
    nativeDataset,
    diagnostic: (entry) => diagnostic?.({ name, schema, ...entry }),
  });
  if (nativeDataset && !nativeDatasetMatches(control, nativeDataset))
    return unsupported(`Code component ${schema} requires a matching exported native dataset property.`);
  if (nativeBinding) {
    const admitted = admitNativeBinding(control, nativeBinding, { schema, name, args, diagnostic, onNativeRefused });
    if (admitted.error) return unsupported(admitted.error, admitted.details);
    nativeBinding = admitted.binding;
    mountArgs = { ...args, ...admitted.statics };
    nativeStatics = admitted.statics;
  }
  const { datasets, error } = resolveCodeComponentDatasets(control, {
    args,
    metadata,
    mappings,
    schema,
    nativeDataset,
    access: liquidDatasetBinding === 'view' ? datasetWebApi(webApi) : null,
    liquidDatasetBinding,
    diagnostic: (entry) => diagnostic?.({ ...entry, name, schema }),
  });
  if (error) return unsupported(error);
  const id = codeComponentId(schema, args, nativeDataset);
  const stateId = codeComponentStateId({ control, schema, args, nativeBinding, stateScope, nativeDataset });
  const defaultLanguage = (portal.websiteLanguages ?? []).find((language) => language.isDefault);
  const selectedLanguage = language ?? portal.language ?? defaultLanguage;
  const localized = localizedStrings(control, selectedLanguage, defaultLanguage, (entry) =>
    diagnostic?.({ ...entry, name, schema }),
  );
  const controlLanguage = codeComponentLanguage(selectedLanguage);
  const value = {
    ...control,
    ...localized,
    stringResources: undefined,
    datasets,
    file: undefined,
    sourceAssets: undefined,
    // A Liquid tag passes the client exactly the live ControlProperties (case-sensitive names, server-coerced values).
    args: liquidTag
      ? liquidControlProperties({
          control,
          schema,
          args,
          // The server parses numbers with the page culture (captured on de-DE).
          culture: controlLanguage?.code,
          diagnostic: (entry) => diagnostic?.({ name, schema, ...entry }),
        })
      : mountArgs,
    ...(liquidTag ? { resources: control.resources.map((resource) => ({ ...resource })) } : {}),
    ...codeComponentHost(nativeBinding, nativeDataset),
    nativeBinding,
    // Every page with a code component has the platform libraries (live: also for controls that declare none).
    platformLibraries: platformLibraries.map(({ name, version, url }) => ({ name, version, url })),
    language: controlLanguage,
    // The Power Pages host reports no user (userId and userName null, securityRoles []), so the payload carries no
    // identity. The website languages name formatting.formatLanguage.
    languages: (portal.websiteLanguages ?? [])
      .map((item) => ({ code: item.code ?? null, lcid: languageLcid(item) }))
      .filter((item) => item.code && item.lcid),
    mappings: Object.fromEntries(
      Object.entries(mappings).map(([name, mapping]) => [
        name,
        { entitySet: mapping.entitySet, idColumn: mapping.idColumn },
      ]),
    ),
    id,
    stateId,
  };
  if (nativeBinding) onNativeBinding?.(nativeBinding, nativeStatics);
  const prefix = `<script src="${PCF_HOST_SCRIPT}"></script>`;
  const component = { kind: 'pcf', key: 'pcf:' + schema.toLowerCase(), name: schema };
  onRendered?.({
    start: 0,
    end: prefix.length - '</script>'.length,
    tag: 'script',
    component,
    attributes: [{ name: 'src', value: PCF_HOST_SCRIPT }],
  });
  // When the host script did not run, the container reports that outcome instead of waiting for ever.
  const mount = (target) =>
    `<script>if(window.__paqviloPcf)window.__paqviloPcf.mount(${json(value)}, ${target});` +
    `else{const c=${target};c.setAttribute('aria-busy','false');c.setAttribute('role','alert');` +
    `c.dataset.pcfError='true';c.textContent='The code component host script did not load.';}</script>`;
  if (liquidTag)
    return renderLiquidHost({
      prefix,
      schema,
      control,
      value,
      strings: localized.strings,
      platformLibraries,
      pageState,
      component,
      mount,
      onRendered,
    });
  const opening = `<div data-mirage-component="codecomponent" data-pcf-schema="${escape(schema)}" aria-busy="true">`;
  // The host element and the two scripts that load and mount it all belong to the code component.
  const mountStart = prefix.length + opening.length + '</div>'.length;
  onRendered?.({
    start: prefix.length,
    end: prefix.length + opening.length,
    tag: 'div',
    component,
    attributes: [{ name: 'data-pcf-schema', value: schema }],
  });
  onRendered?.({ start: mountStart, end: mountStart + '<script>'.length, tag: 'script', component, attributes: [] });
  return prefix + opening + '</div>' + mount('document.currentScript.previousElementSibling');
}
