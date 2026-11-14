#!/usr/bin/env node
// Builds mirage/lib/dataverse-standard-tables.json from the Microsoft Learn Dataverse table
// reference (MicrosoftDocs/powerapps-docs at a pinned commit). Facts only: names, types, option
// labels, ownership and relationships. Description prose is never read. Maintainer-run: main()
// fetches the pages into an ignored cache; the parser and builder are pure and tests never fetch.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_COMMIT = 'c3a8c43bfabbbbf1b6dd018fbb37bce6f6b7cd59';
export const LICENCE = 'CC-BY-4.0';
export const EXCLUDED_PREFIXES = ['adx_', 'msa_', 'msdyn_', 'mspp_', 'msdynce_', 'msft_', 'msfp_'];
const REPO = 'MicrosoftDocs/powerapps-docs';
const PAGE_DIR = 'powerapps-docs/developer/data-platform/reference/entities/';
const LEARN_URL = 'https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/';
const LCID = '1033';

export const TABLES = [
  'account',
  'contact',
  'customeraddress',
  'activitypointer',
  'activityparty',
  'task',
  'email',
  'phonecall',
  'appointment',
  'letter',
  'fax',
  'recurringappointmentmaster',
  'socialactivity',
  'annotation',
  'queue',
  'queueitem',
  'connection',
  'connectionrole',
  'post',
  'socialprofile',
  'template',
  'mailbox',
  'sharepointsite',
  'sharepointdocumentlocation',
  'knowledgearticle',
  'category',
  'subject',
  'organization',
  'businessunit',
  'systemuser',
  'team',
  'role',
  'position',
  'transactioncurrency',
  'privilege',
  'roleprivileges',
  'principalobjectaccess',
  'principalobjectattributeaccess',
  'fieldsecurityprofile',
  'fieldpermission',
  'teamtemplate',
  'savedquery',
  'userquery',
  'solution',
  'publisher',
  'webresource',
  'environmentvariabledefinition',
  'environmentvariablevalue',
  'asyncoperation',
  'bulkdeleteoperation',
  'bulkdeletefailure',
  'backgroundoperation',
  'audit',
  'duplicaterule',
  'duplicaterulecondition',
  'customapi',
  'customapirequestparameter',
  'customapiresponseproperty',
  // plug-in registration and processes
  'pluginassembly',
  'plugintype',
  'sdkmessage',
  'sdkmessagefilter',
  'sdkmessageprocessingstep',
  'sdkmessageprocessingstepimage',
  'sdkmessageprocessingstepsecureconfig',
  'serviceendpoint',
  'pluginpackage',
  'plugintracelog',
  'workflow',
  'workflowlog',
  'processsession',
  'appnotification',
  // further platform tables of the native base environment
  'calendar',
  'calendarrule',
  'appmodule',
  'appmodulecomponent',
  'import',
  'importfile',
  'importmap',
  'importlog',
  'recyclebinconfig',
  'retentionconfig',
  'mailboxtrackingfolder',
  'kbarticle',
  'timezonedefinition',
  'timezonerule',
  'timezonelocalizedname',
  'report',
  'savedqueryvisualization',
  'dependency',
  'solutioncomponent',
  'activitymimeattachment',
  'systemform',
  'theme',
  'fxexpression',
  'maskingrule',
  'attributemaskingrule',
  'deleteditemreference',
  'connectioninstance',
  'recurrencerule',
  'postcomment',
  'postfollow',
  'postregarding',
  'mobileofflineprofile',
  'mobileofflineprofileitem',
  'mobileofflineprofileitemassociation',
  'mobileofflineprofileitemfilter',
  'delegatedauthorization',
  'privilegecheckerrun',
  'privilegecheckerlog',
  'knowledgearticleviews',
  'languagelocale',
  'certificatecredential',
  'processstage',
  'reportcategory',
  'newprocess',
  'translationprocess',
  'expiredprocess',
  'virtualentitymetadata',
  'columnmapping',
  'picklistmapping',
  'lookupmapping',
  'ownermapping',
  'importentitymapping',
  'transformationmapping',
  'transformationparametermapping',
  'retaineddataexcel',
  'duplicaterecord',
  'workqueue',
  'workqueueitem',
  'sourcecontrolconfiguration',
  'sourcecontrolbranchconfiguration',
  'sourcecontrolcomponent',
  'sourcecontrolcomponentpayload',
  'githubappconfig',
  'featurecontrolsetting',
  'card',
  'goal',
  'metric',
  'rollupfield',
  'goalrollupquery',
  'flowsession',
  'flowmachine',
  'flowmachinegroup',
  'flowmachinenetwork',
  'flowmachineimage',
  'flowmachineimageversion',
  'desktopflowmodule',
  'desktopflowbinary',
  'flowcredentialapplication',
  'flowgroup',
  'flowtrigger',
  'flowrun',
  'credential',
  'connectionreference',
  'businessprocess',
  'bot',
  'botcomponent',
  'botcomponentcollection',
  'chat',
  'sharedworkspace',
];

// Tables whose msdyn_ columns and relationships the generator keeps (curated add-on tables). Every other msdyn_ table stays excluded.
export const PREFIXED_TABLES = [
  'msdyn_aimodel',
  'msdyn_aiconfiguration',
  'msdyn_aitemplate',
  'msdyn_aibfeedbackloop',
  'msdyn_pminferredtask',
  'msdyn_pmrecording',
];

// Tables the add-on families read as solution components (their rows are seeded by the add-on modules).
export const COMPONENTS_FOR_ADDONS = ['flowrun', 'credential', 'connectionreference', 'businessprocess', 'chat'];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_ROOT = path.join(ROOT, '.paqvilo', 'standard-tables-cache');
const DEFAULT_OUT = path.join(ROOT, 'mirage', 'lib', 'dataverse-standard-tables.json');

const TYPES = {
  String: 'nvarchar',
  Memo: 'memo',
  Integer: 'int',
  BigInt: 'bigint',
  Double: 'float',
  Decimal: 'decimal',
  Money: 'money',
  Boolean: 'bit',
  DateTime: 'datetime',
  Lookup: 'lookup',
  Customer: 'customer',
  Owner: 'owner',
  Picklist: 'picklist',
  State: 'state',
  Status: 'status',
  EntityName: 'entityname',
  Uniqueidentifier: 'uniqueidentifier',
  PartyList: 'partylist',
  ManagedProperty: 'managedproperty',
  Image: 'image',
  File: 'file',
  MultiSelectPicklist: 'multiselectpicklist',
};
const OPTION_TYPES = new Set(['picklist', 'bit', 'state', 'status']);
const RELATIONSHIP_SECTIONS = new Set(['many-to-one', 'one-to-many', 'many-to-many']);
const SECTIONS = {
  Properties: 'properties',
  'Writable columns/attributes': 'writable',
  'Read-only columns/attributes': 'readonly',
  'Many-to-One relationships': 'many-to-one',
  'One-to-Many relationships': 'one-to-many',
  'Many-to-Many relationships': 'many-to-many',
};

const plain = (value) => (value === undefined ? '' : String(value).replaceAll('**', '').replaceAll('`', '').trim());
const lower = (value) => plain(value).toLowerCase();
const label = (value) => (plain(value) ? { [LCID]: plain(value) } : undefined);
const excluded = (name) => EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
const flag = (value) => {
  if (plain(value) === 'True') return true;
  return plain(value) === 'False' ? false : undefined;
};
const numberOrUndefined = (value) => (plain(value) === '' ? undefined : Number(plain(value)));
const sortObject = (object) =>
  Object.fromEntries(
    Object.keys(object)
      .sort() // NOSONAR: preserve default coercion and UTF-16 sort order
      .map((key) => [key, object[key]]),
  );

// Learn "details" cells: Label: **X**<br />DefaultStatus: 1<br />InvariantName: `X`
function details(text) {
  const out = {};
  for (const part of String(text).split('<br />')) {
    const prefix = /^\s*([A-Za-z]+):/.exec(part);
    const value = prefix && /^(.*)$/.exec(part.slice(prefix[0].length).trim());
    if (value) out[prefix[1]] = plain(value[1]);
  }
  return out;
}

// Learn "CascadeConfiguration" cell: Archive: `NoCascade`<br />Assign: `Cascade`<br />...
function cascadeOf(text) {
  if (!plain(text)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(details(text))) out[key[0].toLowerCase() + key.slice(1)] = value;
  return out;
}

function choiceBody(type, block, name, complain) {
  // Learn may document a Boolean without True/False label rows, or a picklist with an empty
  // Choices/Options table (environment-specific values). Those are kept as Learn states them.
  if (type === 'bit') {
    return {
      options: [
        { value: 0, labels: label(block.rows['False Label']) },
        { value: 1, labels: label(block.rows['True Label']) },
      ],
    };
  }
  if (block.choices.length === 0 && !block.choicesSeen) {
    complain(`${name}: ${type} has no Choices/Options heading`);
    return null;
  }
  if (type === 'picklist') {
    return { options: block.choices.map((choice) => ({ value: choice.value, labels: label(choice.text) })) };
  }
  if (type === 'state') {
    return {
      states: block.choices.map((choice) => {
        const d = details(choice.text);
        return {
          value: choice.value,
          labels: label(d.Label),
          defaultStatus: numberOrUndefined(d.DefaultStatus),
          invariantName: d.InvariantName || undefined,
        };
      }),
    };
  }
  return {
    statuses: block.choices.map((choice) => {
      const d = details(choice.text);
      return { value: choice.value, labels: label(d.Label), state: numberOrUndefined(d.State) };
    }),
  };
}

function processEntityHeading(line, state, complain) {
  let h2 = null;
  if (line.startsWith('## ')) {
    const body = line.slice(3);
    const content = body.trimEnd();
    const lineEnd = body.search(/[\r\n\u2028\u2029]/);
    if (body.length && lineEnd !== 0 && (lineEnd < 0 || content.length <= lineEnd)) h2 = [line, content || body[0]];
  }
  if (h2) {
    state.section = SECTIONS[h2[1]] ?? null;
    state.block = null;
    state.choicesOf = null;
    return true;
  }
  const h3 = /^### <a name="[^"]*"><\/a>\s*(\S+)\s*$/.exec(line);
  if (h3) {
    state.block =
      state.section && state.section !== 'properties'
        ? { schemaName: h3[1], section: state.section, rows: {}, choices: [] }
        : null;
    if (state.block) state.blocks.push(state.block);
    state.choicesOf = null;
    return true;
  }
  const h4 = /^#### (\S+) Choices\/Options\s*$/.exec(line);
  if (!h4) return false;
  state.choicesOf = state.block?.schemaName === h4[1] ? state.block : null;
  if (!state.choicesOf) complain(`choices heading ${h4[1]} does not follow its column`);
  else state.choicesOf.choicesSeen = true;
  return true;
}

function processEntityRow(line, state) {
  const row = /^\|(.*)\|\s*$/.exec(line);
  if (!row?.[1].includes('|')) return;
  const cut = row[1].indexOf('|');
  const key = plain(row[1].slice(0, cut));
  const value = row[1].slice(cut + 1).trim();
  if (state.choicesOf) {
    if (/^-?\d+$/.test(key)) state.choicesOf.choices.push({ value: Number(key), text: value });
    return;
  }
  if (state.section === 'properties') state.props[key] = value;
  else if (state.block) state.block.rows[key] = value;
}

function parseEntityMarkdown(markdown, complain) {
  const state = { props: {}, blocks: [], section: null, block: null, choicesOf: null };
  for (const line of String(markdown).split(/\r?\n/)) {
    if (processEntityHeading(line, state, complain)) continue;
    const see = /^See \[([^\s\]]+) /.exec(line);
    if (see && state.block?.section === 'many-to-many') state.block.otherEntity = see[1];
    processEntityRow(line, state);
  }
  return state;
}

function addNumericAttributeFields(attr, name, rows, complain) {
  for (const [source, target] of [
    ['MaxLength', 'maxLength'],
    ['MinValue', 'minValue'],
    ['MaxValue', 'maxValue'],
    ['Precision', 'precision'],
    ['PrecisionSource', 'precisionSource'],
  ]) {
    const text = plain(rows[source]);
    if (!text) continue;
    // PrecisionSource reads "2 (Entity.Attribute)": only the leading integer is the value.
    const value = source === 'PrecisionSource' ? Number.parseInt(text, 10) : Number(text);
    if (!Number.isFinite(value)) {
      complain(`${name}: ${source} ${text} is not a number`);
      continue;
    }
    // 64-bit integer limits (BigInt min/max) exceed the safe integer range, so they stay exact as text.
    attr[target] = /^-?\d+$/.test(text) && !Number.isSafeInteger(value) ? text : value;
  }
}

function addOptionalAttributeFields(attr, type, rows) {
  const formatCell = type === 'nvarchar' || type === 'memo' ? (rows.FormatName ?? rows.Format) : rows.Format;
  if (plain(formatCell)) attr.format = lower(formatCell);
  if (plain(rows.ImeMode)) attr.imeMode = lower(rows.ImeMode);
  if (plain(rows.IsLocalizable)) attr.isLocalizable = flag(rows.IsLocalizable);
  if (plain(rows.DateTimeBehavior)) attr.dateTimeBehavior = plain(rows.DateTimeBehavior);
  if (plain(rows.Targets))
    attr.targets = plain(rows.Targets)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  if (type === 'bit' && plain(rows.DefaultValue)) attr.appDefaultValue = flag(rows.DefaultValue) ? '1' : '0';
  if (
    ['picklist', 'state', 'status'].includes(type) &&
    plain(rows.DefaultFormValue) &&
    plain(rows.DefaultFormValue) !== '-1'
  ) {
    attr.appDefaultValue = plain(rows.DefaultFormValue);
  }
}

function addAttributeOptionSet(attr, logical, name, type, column, optionSets, complain) {
  if (!OPTION_TYPES.has(type)) return;
  const local = `${logical}_${name}`;
  const setName = plain(column.rows.GlobalChoiceName) || local;
  const body = choiceBody(type, column, name, complain);
  if (!body) return;
  const isGlobal = setName !== local;
  const set = { type, isGlobal, ...body };
  attr.optionSetName = setName;
  if (isGlobal) optionSets[setName] = { name: setName, ...set };
  else attr.optionSet = set;
}

function parseEntityAttribute(logical, table, column, keepPrefixed, optionSets, complain) {
  const r = column.rows;
  const name = plain(r.LogicalName);
  if (!name) {
    complain(`column ${column.schemaName} has no LogicalName`);
    return { excluded: false };
  }
  if (excluded(name) && !keepPrefixed) return { excluded: true };
  const learnType = plain(r.Type);
  if (!Object.hasOwn(TYPES, learnType)) {
    complain(`${name}: unmapped Type ${learnType}`);
    return { excluded: false };
  }
  let type = TYPES[learnType];
  if (type === 'uniqueidentifier' && name === table.primaryIdAttribute) type = 'primarykey';
  const writable = column.section === 'writable';
  const attr = {
    name,
    schemaName: column.schemaName,
    type,
    requiredLevel: lower(r.RequiredLevel) || undefined,
    validForCreate: writable,
    validForUpdate: writable,
    validForRead: plain(r.IsValidForRead) === 'True',
    labels: label(r.DisplayName),
  };
  addNumericAttributeFields(attr, name, r, complain);
  addOptionalAttributeFields(attr, type, r);
  addAttributeOptionSet(attr, logical, name, type, column, optionSets, complain);
  return { name, attr, excluded: false };
}

function parseEntityRelationship(item, logical) {
  const r = item.rows;
  if (item.section === 'many-to-one')
    return {
      kind: 'many-to-one',
      schemaName: item.schemaName,
      referencingEntity: logical,
      referencedEntity: plain(r.ReferencedEntity),
      referencedAttribute: plain(r.ReferencedAttribute),
      referencingAttribute: plain(r.ReferencingAttribute),
      referencingNavigation: plain(r.ReferencingEntityNavigationPropertyName),
      isHierarchical: flag(r.IsHierarchical),
      cascade: cascadeOf(r.CascadeConfiguration),
    };
  if (item.section === 'one-to-many')
    return {
      kind: 'one-to-many',
      schemaName: item.schemaName,
      referencedEntity: logical,
      referencingEntity: plain(r.ReferencingEntity),
      referencingAttribute: plain(r.ReferencingAttribute),
      referencedNavigation: plain(r.ReferencedEntityNavigationPropertyName),
    };
  // A self-referencing block has Entity1/Entity2 rows. Otherwise the block names its other table
  // with a See link; a definition-only block (no link) adds nothing here, the linking pages do.
  const selfReferencing = r.Entity1IntersectAttribute !== undefined;
  let sides;
  if (selfReferencing)
    sides = {
      entity1: {
        intersectAttribute: plain(r.Entity1IntersectAttribute),
        navigation: plain(r.Entity1NavigationPropertyName),
      },
      entity2: {
        intersectAttribute: plain(r.Entity2IntersectAttribute),
        navigation: plain(r.Entity2NavigationPropertyName),
      },
    };
  else if (item.otherEntity)
    sides = {
      [logical]: {
        intersectAttribute: plain(r.IntersectAttribute),
        navigation: plain(r.NavigationPropertyName),
      },
    };
  let entities;
  if (selfReferencing) entities = [logical, logical];
  else if (item.otherEntity) entities = [logical, item.otherEntity].sort(); // NOSONAR: preserve default coercion and UTF-16 sort order
  return {
    kind: 'many-to-many',
    schemaName: item.schemaName,
    intersectEntity: plain(r.IntersectEntityName),
    entities,
    sides,
  };
}

// Reads one Learn entity page. Returns the table facts, its attributes, its option sets (global
// sets only; local sets are inline on the attribute), its relationship blocks as read from this
// page, and problems. Excluded-prefix columns are dropped and counted, not reported as problems.
export function parseEntityPage(markdown, logical, { prefixedTables = PREFIXED_TABLES } = {}) {
  const keepPrefixed = prefixedTables.includes(logical);
  const problems = [];
  const complain = (message) => problems.push(`${logical}: ${message}`);
  const { props, blocks } = parseEntityMarkdown(markdown, complain);
  const p = {};
  for (const [key, value] of Object.entries(props)) p[key] = plain(value);
  for (const key of [
    'LogicalName',
    'SchemaName',
    'EntitySetName',
    'PrimaryIdAttribute',
    'OwnershipType',
    'TableType',
  ]) {
    if (!p[key]) complain(`Properties has no ${key}`);
  }
  if (p.LogicalName && p.LogicalName !== logical)
    complain(`LogicalName ${p.LogicalName} differs from the requested table`);
  const table = {
    logicalName: logical,
    schemaName: p.SchemaName,
    entitySet: p.EntitySetName,
    logicalCollectionName: p.LogicalCollectionName,
    primaryIdAttribute: p.PrimaryIdAttribute,
    primaryNameAttribute: p.PrimaryNameAttribute,
    ownershipType: p.OwnershipType,
    tableType: p.TableType,
    labels: label(p.DisplayName),
    collectionLabels: label(p.DisplayCollectionName),
  };

  const attributes = {};
  const optionSets = {};
  let excludedColumns = 0;
  for (const column of blocks.filter((item) => item.section === 'writable' || item.section === 'readonly')) {
    const parsed = parseEntityAttribute(logical, table, column, keepPrefixed, optionSets, complain);
    if (parsed.excluded) excludedColumns++;
    else if (parsed.attr) attributes[parsed.name] = parsed.attr;
  }

  const relationships = [];
  for (const item of blocks.filter((entry) => RELATIONSHIP_SECTIONS.has(entry.section)))
    relationships.push(parseEntityRelationship(item, logical));
  return { table, attributes, optionSets, relationships, excludedColumns, problems };
}

// Merges one page's relationship block into the pending map. A many-to-one block (on the
// referencing table) and a one-to-many block (on the referenced table) describe the same
// relationship, so the fields from both pages are combined by SchemaName.
function mergeRelationship(pending, rel, problems) {
  const type = rel.kind === 'many-to-many' ? 'many-to-many' : 'one-to-many';
  const entry = pending.get(rel.schemaName) ?? { schemaName: rel.schemaName, type };
  let fields;
  if (rel.kind === 'many-to-one')
    fields = {
      referencingEntity: rel.referencingEntity,
      referencedEntity: rel.referencedEntity,
      referencedAttribute: rel.referencedAttribute,
      referencingAttribute: rel.referencingAttribute,
      referencingNavigation: rel.referencingNavigation,
      isHierarchical: rel.isHierarchical,
      cascade: rel.cascade,
    };
  else if (rel.kind === 'one-to-many')
    fields = {
      referencedEntity: rel.referencedEntity,
      referencingEntity: rel.referencingEntity,
      referencingAttribute: rel.referencingAttribute,
      referencedNavigation: rel.referencedNavigation,
    };
  else fields = { entities: rel.entities, intersectEntity: rel.intersectEntity };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    if (entry[key] !== undefined && JSON.stringify(entry[key]) !== JSON.stringify(value)) {
      problems.push(
        `${rel.schemaName}: ${key} differs between pages (${JSON.stringify(entry[key])} vs ${JSON.stringify(value)})`,
      );
    } else {
      entry[key] = value;
    }
  }
  // Each side of a many-to-many keeps its own intersect column and navigation name.
  if (rel.sides) entry.sides = { ...entry.sides, ...rel.sides };
  pending.set(rel.schemaName, entry);
}

function collectStandardPages(pages, prefixedTables, tables, optionSets, pending, problems, stats) {
  for (const logical of Object.keys(pages)./* NOSONAR */ sort()) {
    // NOSONAR: preserve default coercion and UTF-16 sort order
    const parsed = parseEntityPage(pages[logical], logical, { prefixedTables });
    problems.push(...parsed.problems);
    tables[logical] = { ...parsed.table, attributes: sortObject(parsed.attributes) };
    stats.excludedColumns += parsed.excludedColumns;
    for (const [name, set] of Object.entries(parsed.optionSets)) {
      if (optionSets[name] && JSON.stringify(optionSets[name]) !== JSON.stringify(set)) {
        problems.push(`${logical}: global option set ${name} differs between tables`);
      } else {
        optionSets[name] = set;
      }
    }
    for (const rel of parsed.relationships) mergeRelationship(pending, rel, problems);
  }
}

function reconcileLocalOptionSets(tables, optionSets, problems) {
  for (const table of Object.values(tables)) {
    for (const attr of Object.values(table.attributes)) {
      if (!attr.optionSet || !optionSets[attr.optionSetName]) continue;
      const { isGlobal: _local, ...local } = attr.optionSet; // NOSONAR: binding is excluded from the rest object or is a placeholder
      const { name: _name, isGlobal: _global, ...global } = optionSets[attr.optionSetName]; // NOSONAR: binding is excluded from the rest object or is a placeholder
      if (JSON.stringify(local) === JSON.stringify(global)) delete attr.optionSet;
      else problems.push(`${table.logicalName}: ${attr.name} option set differs from global ${attr.optionSetName}`);
    }
  }
}

function relationshipSurvives(name, rel, pages, tables, prefixedTables, problems) {
  const ends = rel.type === 'many-to-many' ? (rel.entities ?? []) : [rel.referencingEntity, rel.referencedEntity];
  if (ends.length === 0 || !ends.every((end) => end && Object.hasOwn(pages, end))) return false;
  const sideNames = Object.values(rel.sides ?? {}).flatMap((side) => [side.intersectAttribute, side.navigation]);
  const names = [
    ...ends,
    rel.referencingAttribute,
    rel.referencedAttribute,
    rel.referencingNavigation,
    rel.referencedNavigation,
    ...sideNames,
  ].filter(Boolean);
  // A prefixed name is kept only for an allow-listed end whose referencing column survived the parse.
  if (names.some(excluded)) {
    const referencing = tables[rel.referencingEntity]?.attributes ?? {};
    const throughAllowed =
      ends.some((end) => prefixedTables.includes(end)) &&
      Boolean(rel.referencingAttribute && referencing[rel.referencingAttribute]);
    if (!throughAllowed) return false;
  }
  if (
    rel.type === 'one-to-many' &&
    !(rel.referencingAttribute && rel.referencedAttribute && rel.referencingNavigation && rel.referencedNavigation)
  ) {
    problems.push(`${name}: one-to-many relationship is incomplete`);
    return false;
  }
  return true;
}

function collectStandardRelationships(pending, pages, tables, prefixedTables, problems, stats) {
  const relationships = {};
  for (const name of [...pending.keys()]./* NOSONAR */ sort()) {
    // NOSONAR: preserve default coercion and UTF-16 sort order
    const rel = pending.get(name);
    if (!relationshipSurvives(name, rel, pages, tables, prefixedTables, problems)) continue;
    relationships[name] = rel;
    stats.relationships += 1;
    if (rel.type === 'one-to-many') stats.oneToManyRelationships += 1;
    else stats.manyToManyRelationships += 1;
  }
  return relationships;
}

function countStandardFacts(tables, optionSets, stats) {
  stats.tables = Object.keys(tables).length;
  stats.globalOptionSets = Object.keys(optionSets).length;
  for (const table of Object.values(tables)) {
    for (const attr of Object.values(table.attributes)) {
      stats.columns += 1;
      const set = attr.optionSet;
      if (set) stats.localOptionSets += 1;
      if (set) stats.optionValues += (set.options ?? set.states ?? set.statuses ?? []).length;
    }
  }
  for (const set of Object.values(optionSets))
    stats.optionValues += (set.options ?? set.states ?? set.statuses ?? []).length;
}

// pages: { logicalName: markdown }. The keys are the table list: a relationship is kept only when
// both of its tables are in it, and no column or navigation has an excluded prefix.
export function buildStandardFile(pages, { commit = DEFAULT_COMMIT, prefixedTables = PREFIXED_TABLES } = {}) {
  const problems = [];
  const tables = {};
  const optionSets = {};
  const pending = new Map();
  const stats = {
    tables: 0,
    columns: 0,
    excludedColumns: 0,
    localOptionSets: 0,
    globalOptionSets: 0,
    optionValues: 0,
    relationships: 0,
    oneToManyRelationships: 0,
    manyToManyRelationships: 0,
  };
  collectStandardPages(pages, prefixedTables, tables, optionSets, pending, problems, stats);

  // A set is global when any table reads it under a name other than its own <table>_<column>.
  // Tables that read the same set locally keep only the name and rely on the top-level copy.
  reconcileLocalOptionSets(tables, optionSets, problems);

  const relationships = collectStandardRelationships(pending, pages, tables, prefixedTables, problems, stats);
  countStandardFacts(tables, optionSets, stats);

  const file = {
    commit,
    source: {
      repo: REPO,
      path: PAGE_DIR,
      url: LEARN_URL,
      excludedPrefixes: EXCLUDED_PREFIXES,
      descriptionsOmitted: true,
      prefixedTables: [...prefixedTables],
    },
    licence: LICENCE,
    tables: sortObject(tables),
    relationships,
    optionSets: sortObject(optionSets),
  };
  return { file, problems, stats };
}

// Reads each page from the commit's cache directory, fetching only the missing ones.
export async function loadPages(commit, { cacheRoot = CACHE_ROOT, fetchFn = fetch, tables = TABLES } = {}) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Reference cache requires a full commit SHA.');
  if (tables.some((name) => !/^[a-z][a-z0-9_]*$/.test(name)))
    throw new Error('Reference table names must be logical identifiers.');
  const dir = path.join(cacheRoot, commit);
  fs.mkdirSync(dir, { recursive: true });
  const pages = {};
  for (const name of tables) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) {
      const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${PAGE_DIR}${name}.md`;
      const response = await fetchFn(url, { redirect: 'error' });
      if (!response.ok) throw new Error(`Fetch failed for ${name}: HTTP ${response.status}`);
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        // Intentional non-executable Markdown cache from a fixed public repository
        // at a validated immutable commit; neither remote data nor names choose an
        // executable path. The parser extracts declarative table facts only.
        fs.writeFileSync(temp, await response.text(), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    pages[name] = fs.readFileSync(file, 'utf8');
  }
  return pages;
}

function parseArgs(argv) {
  const options = { commit: DEFAULT_COMMIT, out: DEFAULT_OUT, check: false, allow: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--commit') options.commit = argv[++i];
    else if (arg === '--out') options.out = path.resolve(argv[++i] ?? '');
    else if (arg === '--allow')
      for (const name of String(argv[++i] ?? '').split(','))
        if (name.trim()) options.allow.add(name.trim());
        else throw new Error(`Unknown argument ${arg}`);
  }
  if (!/^[0-9a-f]{40}$/.test(options.commit)) throw new Error('--commit must be a full commit SHA.');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const pages = await loadPages(options.commit, { tables: [...TABLES, ...PREFIXED_TABLES] });
  const { file, problems, stats } = buildStandardFile(pages, {
    commit: options.commit,
    prefixedTables: PREFIXED_TABLES,
  });
  for (const problem of problems) console.error(problem);
  const blocking = problems.filter((problem) => ![...options.allow].some((table) => problem.startsWith(`${table}: `)));
  if (blocking.length > 0) {
    console.error(`${blocking.length} problem(s) block the file. Fix the parser or list the table with --allow.`);
    return 1;
  }
  const text = `${JSON.stringify(file)}\n`;
  console.log(JSON.stringify(stats));
  if (options.check) {
    const current = fs.existsSync(options.out) ? fs.readFileSync(options.out, 'utf8') : '';
    if (current !== text) {
      console.error(`${options.out} differs from the regenerated file.`);
      return 1;
    }
    console.log(`${options.out} matches the generator output (${text.length} bytes).`);
    return 0;
  }
  fs.writeFileSync(options.out, text);
  console.log(`Wrote ${options.out} (${text.length} bytes).`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  /* NOSONAR: module-level promise chain must not block evaluation */ main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
