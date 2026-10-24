// Solution component inventory: Solution components that Paqvilo reads, lists and dates, but does not host or execute.
// Data only: every function here is pure and its results are JSON-serialisable (they are cached per source file).
//
// Component type codes follow the solutioncomponent ComponentType choices:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent#componenttype-choicesoptions
// (Role 20, Workflow 29, Report 31, Email Template 36, Saved Query Visualization 59, System Form 60, Web Resource 61,
// Custom Control 66, Field Security Profile 70, Canvas App 300, Connector 371, Environment Variable Definition 380).
// Components that are rows of solution-aware tables without a fixed code in that list (connection references, app
// actions, cloud flows' YAML folder, bots, bot components, plug-in packages) carry componentType null.
// Folder layouts: classic SolutionPackager (https://learn.microsoft.com/power-platform/alm/solution-packager-tool) and the
// YAML source-control format (https://learn.microsoft.com/power-platform/alm/solution-source-control-yaml-format).
// The canvas app `document` column is limited to 32768 KB
// (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/canvasapp), so a larger .msapp is
// listed by name and size only.
import YAML from 'yaml';
import { parseSolutionXml, serializeXml } from './solution-xml.mjs';
import { yamlNode } from './solution-yaml.mjs';
import { readCanvasSource, canvasInventoryRecord } from './canvas-source.mjs';
import { compileOpenApi, compileConnector } from './custom-connector.mjs';
import { dotnetSdk, SDK_MISSING } from './custom-connector-script.mjs';
import { modernFlowFacts } from './flow-yaml.mjs';

export const CANVAS_MSAPP_LIMIT = 32 * 1024 * 1024;
const TEXT_LIMIT = 16 * 1024 * 1024;

const ANY = /./;
const DATA = /\.(?:xml|json|ya?ml)$/i;
/**
 * One row per component kind. `folders`: Solution folder names (classic and YAML, matched case-insensitively);
 * `files`: which files of such a folder describe the component; `name`: 'folder' names a nested file after its first
 * sub-folder, 'file' after the file. `level`: 'inventory' (listed, not hosted) or 'behaviour' (executed elsewhere; the
 * row is only listed). `code`: the once-per-layer diagnostic for inventory-level rows.
 */
export const INVENTORY_FOLDERS = Object.freeze([
  { component: 'canvasapp', componentType: 300, folders: ['canvasapps'], files: /\.msapp$|\.meta\.xml$/i, name: 'folder', level: 'inventory', code: 'SOLUTION_CANVAS_INVENTORY', reason: 'CANVAS_HOST_NOT_IMPLEMENTED' },
  { component: 'connector', componentType: 371, folders: ['connectors'], files: /\.(?:xml|json|ya?ml|csx)$/i, name: 'folder', level: 'inventory', code: 'SOLUTION_CONNECTOR_INVENTORY', reason: 'CONNECTOR_DEFINITION_INVENTORY_ONLY' },
  { component: 'connectionreference', componentType: null, folders: ['connectionreferences'], files: DATA, name: 'folder', level: 'behaviour', code: null, reason: null },
  { component: 'environmentvariable', componentType: 380, folders: [], files: null, name: 'folder', level: 'behaviour', code: null, reason: null },
  { component: 'businessprocessflow', componentType: 29, folders: [], files: null, name: 'file', level: 'inventory', code: 'SOLUTION_BPF_INVENTORY', reason: 'BPF_NOT_EXECUTED' },
  { component: 'dashboard', componentType: 60, folders: ['dashboards'], files: DATA, name: 'file', level: 'inventory', code: 'SOLUTION_DASHBOARD_INVENTORY', reason: 'DASHBOARD_NOT_RENDERED' },
  { component: 'chart', componentType: 59, folders: ['visualizations'], files: DATA, name: 'file', level: 'inventory', code: 'SOLUTION_CHART_INVENTORY', reason: 'CHART_NOT_RENDERED' },
  { component: 'customcontrol', componentType: 66, folders: ['controls'], files: /^controlmanifest\.xml(?:\.data\.xml)?$/i, name: 'folder', level: 'behaviour', code: null, reason: null },
  { component: 'webresource', componentType: 61, folders: [], files: null, name: 'file', level: 'inventory', code: 'SOLUTION_WEBRESOURCE_INVENTORY', reason: 'MODEL_WEBRESOURCE_INVENTORY_ONLY' },
  { component: 'appaction', componentType: null, folders: ['appactions'], files: /^appaction\.(?:xml|ya?ml)$/i, name: 'folder', level: 'behaviour', code: 'SOLUTION_APPACTION_INVENTORY', reason: 'MD_COMMAND_POWERFX' },
  { component: 'modernflow', componentType: 29, folders: ['modernflows'], files: ANY, name: 'folder', level: 'inventory', code: 'SOLUTION_MODERNFLOW_INVENTORY', reason: 'MODERNFLOW_YAML_NOT_IMPORTED' },
  // Roles and field security profiles are imported into the security tables (dataverse-security.mjs importSolutionSecurity).
  { component: 'role', componentType: 20, folders: ['roles'], files: DATA, name: 'file', level: 'behaviour', code: null, reason: null },
  { component: 'fieldsecurityprofile', componentType: 70, folders: ['fieldsecurityprofiles'], files: DATA, name: 'file', level: 'behaviour', code: null, reason: null },
  { component: 'report', componentType: 31, folders: ['reports'], files: /\.xml$/i, name: 'file', level: 'inventory', code: 'SOLUTION_COMPONENT_INVENTORY', reason: 'REPORT_NOT_RENDERED' },
  { component: 'template', componentType: 36, folders: ['templates'], files: DATA, name: 'file', level: 'inventory', code: 'SOLUTION_COMPONENT_INVENTORY', reason: 'TEMPLATE_NOT_RENDERED' },
  { component: 'bot', componentType: null, folders: ['bots'], files: ANY, name: 'folder', level: 'inventory', code: 'SOLUTION_COMPONENT_INVENTORY', reason: 'BOT_NOT_HOSTED' },
  { component: 'botcomponent', componentType: null, folders: ['botcomponents'], files: ANY, name: 'folder', level: 'inventory', code: 'SOLUTION_COMPONENT_INVENTORY', reason: 'BOT_NOT_HOSTED' },
  { component: 'pluginpackage', componentType: null, folders: ['pluginpackages'], files: ANY, name: 'folder', level: 'inventory', code: 'SOLUTION_COMPONENT_INVENTORY', reason: 'PLUGIN_PACKAGE_NOT_LOADED' },
  // The SolutionPackager folder name of mobile offline profiles (component type 161) is a guess.
  // Mobile offline profiles drive the model-driven host's offline sessions (model-driven/offline.mjs).
  { component: 'mobileofflineprofile', componentType: 161, folders: ['mobileofflineprofiles'], files: DATA, name: 'file', level: 'behaviour', code: null, reason: null },
].map(Object.freeze));

const BY_COMPONENT = new Map(INVENTORY_FOLDERS.map(row => [row.component, row]));
const BY_FOLDER = new Map(INVENTORY_FOLDERS.flatMap(row => row.folders.map(folder => [folder, row])));
/** Top-level inventory folder names, for the Solution tree walker. */
export const INVENTORY_TREE_DIRS = Object.freeze([...BY_FOLDER.keys()].filter(folder => folder !== 'visualizations'));
/** Component names by solutioncomponent type code (codes shared by several kinds are omitted). */
export const COMPONENT_BY_TYPE = Object.freeze({ 1: 'table', 20: 'role', 31: 'report', 36: 'template', 59: 'chart', 60: 'dashboard', 61: 'webresource', 66: 'customcontrol', 70: 'fieldsecurityprofile', 161: 'mobileofflineprofile', 300: 'canvasapp', 371: 'connector', 380: 'environmentvariable' });
const WEBRESOURCE_INVENTORY_TYPES = new Set([1, 4, 9, 10, 12]); // HTML, XML, XSL, ICO, RESX

const guid = value => value == null || value === '' ? null : String(value).replace(/[{}]/g, '').toLowerCase();
const stem = file => file.replace(/(?:\.rdl)?(?:\.data)?\.(?:meta\.xml|xml|json|ya?ml|msapp|rdl)$/i, '')
  .replace(/_(?:documenturi|backgroundimageuri|openapidefinition|connectionparameters|policytemplateinstances|iconblob|additionaluris\d*(?:_identity)?)$/i, '');

/**
 * `{ kind: 'inventory', component, componentName }` for a file inside an inventory folder, else null. `parts` are the
 * path segments; `lower` the same segments in lower case. Charts sit below `Entities/<table>/Visualizations/`.
 */
export function classifyInventoryPath(parts, lower) {
  for (let index = 0; index < lower.length - 1; index++) {
    const row = BY_FOLDER.get(lower[index]);
    if (!row || (row.component === 'chart' && lower[index - 2] !== 'entities')) continue;
    const file = parts.at(-1);
    if (!row.files.test(file)) return null;
    const nested = index + 2 < parts.length;
    const componentName = nested && row.name === 'folder' ? parts[index + 1] : stem(file);
    return componentName ? { kind: 'inventory', component: row.component, componentName } : null;
  }
  return null;
}

// Learn solution-source-control-yaml-format: security roles and field security profiles are stored as XML internally and
// converted to YAML, so a YAML role or profile file is read through yamlNode into the same element the XML parser reads.
const SECURITY_YAML_ROOTS = { role: 'Role', fieldsecurityprofile: 'FieldSecurityProfile' };
const UNREAD_SECURITY = { role: { field: 'privileges', reason: 'ROLE_NOT_IMPORTED' }, fieldsecurityprofile: { field: 'permissions', reason: 'FIELD_SECURITY_NOT_IMPORTED' } };
/** An inventory record. `level`/`reason` default to the component's table row. */
export function inventoryRecord({ component, id = null, name, version = null, solution = null, layer = null, source = null, format = null,
  dependencies = [], level, reason, ...extra }) {
  const row = BY_COMPONENT.get(component);
  if (!row) throw new TypeError(`Unknown inventory component ${component}.`);
  // A role or profile whose definition could not be read (an unreadable file) stays inventory: nothing is seeded.
  const unread = UNREAD_SECURITY[component];
  if (unread && !Array.isArray(extra[unread.field]) && level === undefined) ({ level, reason } = { level: 'inventory', reason: reason === undefined ? unread.reason : reason });
  return { component, componentType: row.componentType, id: guid(id), name: String(name ?? ''), version: version ?? null, solution, layer, source, format,
    dependencies, level: level ?? row.level, reason: reason === undefined ? row.reason : reason, ...extra };
}

// Attribute or child-element text, matched case-insensitively.
function value(node, ...names) {
  for (const name of names) {
    const key = name.toLowerCase();
    for (const [attribute, text] of Object.entries(node.attrs ?? {})) if (attribute.toLowerCase() === key && text !== '') return text;
    const found = node.children?.find(item => item.name.toLowerCase() === key);
    if (found && found.text.trim() !== '') return found.text.trim();
  }
  return undefined;
}
const labelOf = node => {
  const stack = [...(node.children ?? [])];
  while (stack.length) {
    const item = stack.shift();
    if (/^(?:localizedname|label|displayname)$/i.test(item.name) && item.attrs.description) return item.attrs.description;
    stack.push(...(item.children ?? []));
  }
  return undefined;
};
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const connectorName = id => id ? String(id).split('/').filter(Boolean).at(-1) : null;

// Canvas app ConnectionReferences / DatabaseReferences JSON columns → dependencies.
function canvasDependencies(node) {
  const dependencies = [];
  for (const reference of Object.values(json(value(node, 'ConnectionReferences')) ?? {})) {
    if (reference?.connectionReferenceLogicalName) dependencies.push({ component: 'connectionreference', name: reference.connectionReferenceLogicalName });
    else if (reference?.id) dependencies.push({ component: 'connector', name: connectorName(reference.id) });
  }
  for (const database of Object.values(json(value(node, 'DatabaseReferences')) ?? {}))
    for (const source of Object.values(database?.dataSources ?? {}))
      if (source?.logicalName) dependencies.push({ component: 'table', name: String(source.logicalName).toLowerCase() });
  return dependencies;
}

function appActionFormulas(node) {
  return ['onclickeventformula', 'visibilityformula'].flatMap(property => {
    const text = value(node, property);
    return text ? [{ property, text }] : [];
  });
}

const ELEMENTS = {
  canvasapp: { containers: ['canvasapps'], record: node => inventoryRecord({ component: 'canvasapp', id: value(node, 'CanvasAppId', 'id'), name: value(node, 'Name'),
    version: value(node, 'AppVersion'), displayName: value(node, 'DisplayName'), dependencies: canvasDependencies(node) }) },
  connector: { containers: ['connectors'], record: node => inventoryRecord({ component: 'connector', id: value(node, 'connectorid'),
    name: value(node, 'name', 'connectorinternalid', 'displayname'), displayName: value(node, 'displayname') }) },
  connectionreference: { containers: ['connectionreferences'], record: node => {
    const connectorId = value(node, 'connectorid');
    return inventoryRecord({ component: 'connectionreference', id: value(node, 'connectionreferenceid'),
      name: value(node, 'connectionreferencelogicalname'), displayName: value(node, 'connectionreferencedisplayname'), connectorId: connectorId ?? null,
      dependencies: connectorId ? [{ component: 'connector', name: connectorName(connectorId) }] : [] });
  } },
  workflow: { containers: ['workflows'], record: node => value(node, 'Category') === '4' ? inventoryRecord({ component: 'businessprocessflow',
    id: value(node, 'WorkflowId'), name: value(node, 'Name', 'UniqueName'),
    dependencies: value(node, 'PrimaryEntity') ? [{ component: 'table', name: value(node, 'PrimaryEntity').toLowerCase() }] : [] }) : null },
  dashboard: { containers: ['dashboards'], record: node => inventoryRecord({ component: 'dashboard', id: value(node, 'FormId', 'formid'),
    name: labelOf(node) ?? value(node, 'FormId', 'formid'),
    dependencies: collect(node) }) },
  visualization: { containers: ['visualizations', 'savedqueryvisualizations'], record: node => inventoryRecord({ component: 'chart',
    id: value(node, 'savedqueryvisualizationid'), name: labelOf(node) ?? value(node, 'name', 'savedqueryvisualizationid'),
    dependencies: value(node, 'primaryentitytypecode') ? [{ component: 'table', name: value(node, 'primaryentitytypecode').toLowerCase() }] : [] }) },
  webresource: { containers: ['webresources'], record: node => WEBRESOURCE_INVENTORY_TYPES.has(Number(value(node, 'WebResourceType')))
    ? inventoryRecord({ component: 'webresource', id: value(node, 'WebResourceId'), name: value(node, 'Name'), webResourceType: Number(value(node, 'WebResourceType')) }) : null },
  appaction: { containers: ['appactions'], record: node => {
    const formulas = appActionFormulas(node);
    return inventoryRecord({ component: 'appaction', id: value(node, 'appactionid'), name: value(node, 'uniquename', 'name'), formulas,
      ...(formulas.length ? { level: 'inventory' } : { reason: null }) });
  } },
  fieldsecurityprofile: { containers: ['fieldsecurityprofiles'], record: node => inventoryRecord({ component: 'fieldsecurityprofile',
    id: value(node, 'fieldsecurityprofileid'), name: value(node, 'name'), permissions: fieldPermissionsOf(node) }) },
  role: { containers: ['roles'], record: node => inventoryRecord({ component: 'role', id: value(node, 'id', 'roleid'), name: value(node, 'name'),
    privileges: rolePrivilegesOf(node) }) },
  report: { containers: ['reports'], record: node => inventoryRecord({ component: 'report', id: value(node, 'ReportId'), name: value(node, 'Name', 'FileName') }) },
  template: { containers: ['templates', 'emailtemplates'], record: node => inventoryRecord({ component: 'template', id: value(node, 'templateid'), name: value(node, 'title', 'name') }) },
  mobileofflineprofile: { containers: ['mobileofflineprofiles'], record: node => inventoryRecord({ component: 'mobileofflineprofile', id: value(node, 'MobileOfflineProfileId'), name: value(node, 'Name'),
    items: offlineProfileItems(node) }) },
};

// Descendant elements named `name` (case-insensitive), depth first.
function descendantsNamed(node, name) {
  const found = [];
  const visit = item => { for (const next of item.children ?? []) { if (next.name.toLowerCase() === name) found.push(next); visit(next); } };
  visit(node);
  return found;
}
// <RolePrivileges><RolePrivilege name="prvReadx_item" level="Global" /> -> [{ name, depth }] (depth Basic, Local, Deep or Global).
function rolePrivilegesOf(node) {
  return descendantsNamed(node, 'roleprivilege').map(item => ({ name: value(item, 'name') ?? '', depth: value(item, 'level', 'depth') ?? '' }))
    .filter(item => item.name);
}
// <MobileOfflineProfileItem> columns (Learn entities/mobileofflineprofileitem and mobileofflineprofileitemassociation):
// -> [{ entity, distribution, filter, ownedByMe, ownedByMyTeam, ownedByMyBusinessUnit, syncIntervalMinutes, relationships }].
// The exported element layout (column-named child elements, associations nested in the item) is a guess.
function offlineProfileItems(node) {
  const flag = text => /^(?:1|true)$/i.test(String(text ?? ''));
  return descendantsNamed(node, 'mobileofflineprofileitem').map(item => {
    const filterNode = item.children.find(entry => entry.name.toLowerCase() === 'profileitementityfilter');
    const nested = filterNode?.children.find(entry => ['fetch', 'filter'].includes(entry.name));
    const interval = Number(value(item, 'SyncIntervalInMinutes'));
    return { entity: String(value(item, 'SelectedEntityTypeCode') ?? '').toLowerCase(), distribution: Number(value(item, 'RecordDistributionCriteria') ?? 0),
      filter: nested ? serializeXml(nested) : value(item, 'ProfileItemEntityFilter') ?? null,
      ownedByMe: flag(value(item, 'RecordsOwnedByMe')), ownedByMyTeam: flag(value(item, 'RecordsOwnedByMyTeam')), ownedByMyBusinessUnit: flag(value(item, 'RecordsOwnedByMyBusinessUnit')),
      syncIntervalMinutes: Number.isInteger(interval) && interval >= 5 && interval <= 1440 ? interval : null,
      relationships: descendantsNamed(item, 'mobileofflineprofileitemassociation').map(entry => value(entry, 'SelectedRelationShipsSchema', 'RelationshipName')).filter(Boolean) };
  }).filter(item => item.entity);
}
// <FieldPermissions><FieldPermission entityname attributelogicalname canread cancreate canupdate canreadunmasked /> (4 Allowed, 0 Not Allowed).
function fieldPermissionsOf(node) {
  const number = text => (text === undefined ? 0 : Number(text) || 0);
  return descendantsNamed(node, 'fieldpermission').map(item => ({
    id: guid(value(item, 'fieldpermissionid')), entity: String(value(item, 'entityname') ?? '').toLowerCase(),
    attribute: String(value(item, 'attributelogicalname') ?? '').toLowerCase(),
    canread: number(value(item, 'canread')), cancreate: number(value(item, 'cancreate')), canupdate: number(value(item, 'canupdate')),
    canreadunmasked: number(value(item, 'canreadunmasked')),
  })).filter(item => item.entity && item.attribute);
}

/**
 * The security definitions of a Solution source: `{ securityRoles: [{ id, name, solution, managed, privileges }],
 * fieldSecurityProfiles: [{ id, name, solution, managed, permissions }] }` from inventory records (role and
 * fieldsecurityprofile). A later layer replaces a role's privilege set and a profile's permissions (Learn
 * how-managed-solutions-merged, "Replace behavior for custom security roles"). `managed` names the managed layers
 * (a Set of solution unique names, lower case) when the caller knows them.
 */
export function securityDefinitions(records = [], { managed = new Set() } = {}) {
  const roles = new Map(), profiles = new Map();
  const ordered = [...records].sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
  for (const record of ordered) {
    const base = { id: record.id ?? null, name: record.name, solution: record.solution ?? null, managed: managed.has(String(record.solution ?? '').toLowerCase()) };
    if (record.component === 'role' && Array.isArray(record.privileges)) roles.set(record.name.toLowerCase(), { ...base, privileges: record.privileges });
    if (record.component === 'fieldsecurityprofile' && Array.isArray(record.permissions)) profiles.set(record.name.toLowerCase(), { ...base, permissions: record.permissions });
  }
  return { securityRoles: [...roles.values()], fieldSecurityProfiles: [...profiles.values()] };
}

// View and chart ids a dashboard's FormXml references, once each.
function collect(node) {
  const found = new Map();
  const visit = item => {
    if (/^(?:viewid|visualizationid)$/i.test(item.name) && item.text.trim()) {
      const id = guid(item.text.trim());
      found.set(id, { component: /visualization/i.test(item.name) ? 'chart' : 'view', name: id });
    }
    for (const next of item.children ?? []) visit(next);
  };
  visit(node);
  return [...found.values()];
}

/**
 * Inventory records for the Customizations.xml / Solution.xml / component-file elements below `root` (a parsed
 * solution-xml node). An element counts inside its plural container (`<CanvasApps><CanvasApp>`), or as the document
 * root of a component file. `info.component`/`info.componentName` name the record of a component file without a name.
 */
export function inventoryFacts(root, info = {}) {
  const records = [];
  const visit = (node, parent) => {
    const element = ELEMENTS[node.name.toLowerCase()];
    if (element && (parent === null || element.containers.includes(parent))) {
      const record = element.record(node);
      if (record) {
        if (!record.name && info.componentName) record.name = info.componentName;
        if (record.name) records.push(record);
      }
      return;
    }
    for (const item of node.children ?? []) visit(item, node.name.toLowerCase());
  };
  visit(root, null);
  return records;
}

/** `[{ required, dependent }]` from Solution.xml `<MissingDependencies>` (type/schemaName/id/displayName attributes). */
export function missingDependencies(manifest) {
  const rows = [];
  const visit = node => {
    if (node.name === 'MissingDependency') {
      const side = name => {
        const item = node.children.find(entry => entry.name === name);
        return item ? Object.fromEntries(Object.entries({ type: Number(item.attrs.type), schemaName: item.attrs.schemaName, id: guid(item.attrs.id),
          displayName: item.attrs.displayName, solution: item.attrs.solution }).filter(([, entry]) => entry !== undefined && entry !== null && !Number.isNaN(entry))) : null;
      };
      const required = side('Required');
      if (required) rows.push({ required, dependent: side('Dependent') });
      return;
    }
    for (const item of node.children ?? []) visit(item);
  };
  visit(manifest);
  return rows;
}

// Connector definition files: OpenAPI (swagger 2.0 / openapi 3) operations, connection parameters and policies. The
// compiled parts (custom-connector.mjs: `compiled`, `policyInstances`, `connectionParameters`, `scriptOperations`, `script`)
// let the connector runtime serve the connector at contract level (customConnectorsOf).
function connectorFacts(text, file) {
  if (/\.csx$/i.test(file)) return { script: true };
  const document = json(text);
  if (!document || typeof document !== 'object') return {};
  if (/openapidefinition\.json$|swagger\.json$|openapi\.json$/i.test(file) || document.swagger || document.openapi) {
    const operations = [], extensions = new Set();
    const note = object => { for (const key of Object.keys(object ?? {})) if (key.startsWith('x-ms-')) extensions.add(key); };
    note(document); note(document.info);
    for (const methods of Object.values(document.paths ?? {}))
      for (const operation of Object.values(methods ?? {})) {
        if (!operation || typeof operation !== 'object') continue;
        note(operation);
        if (operation.operationId) operations.push(String(operation.operationId));
      }
    return { openapi: { version: String(document.swagger ?? document.openapi ?? ''), title: document.info?.title ?? null, operations: operations.sort(),
      extensions: [...extensions].sort() }, compiled: compileOpenApi(document) };
  }
  const instances = policy => ({ policies: policy.map(item => item?.templateId).filter(Boolean).sort(),
    policyInstances: policy.filter(item => item && typeof item === 'object').map(item => ({ templateId: item.templateId ?? null, parameters: item.parameters ?? {} })) });
  const parameterTypes = value => Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry && typeof entry === 'object').map(([name, entry]) => [name, String(entry.type ?? '')]));
  if (/policytemplateinstances\.json$/i.test(file) && Array.isArray(document)) return instances(document);
  if (/connectionparameters\.json$/i.test(file)) return { connectionParameters: parameterTypes(document) };
  if (/apiproperties\.json$/i.test(file) && document.properties && typeof document.properties === 'object') {
    const properties = document.properties;
    return { ...(Array.isArray(properties.policyTemplateInstances) ? instances(properties.policyTemplateInstances) : {}),
      ...(properties.connectionParameters ? { connectionParameters: parameterTypes(properties.connectionParameters) } : {}),
      ...(Array.isArray(properties.scriptOperations) ? { scriptOperations: properties.scriptOperations.map(String) } : {}) };
  }
  return {};
}

// A YAML/JSON component file: connection-reference fields wherever they sit, flow connection references.
function dataFacts(text, file) {
  const document = /\.json$/i.test(file) ? json(text) : (() => { try { return YAML.parse(text, { maxAliasCount: 100 }); } catch { return null; } })();
  const fields = {};
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    for (const [key, entry] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (typeof entry === 'string' && ['connectionreferencelogicalname', 'connectorid', 'connectionreferencedisplayname', 'connectionreferenceid'].includes(lower)) fields[lower] ??= entry;
      else visit(entry, depth + 1);
    }
  };
  visit(document, 0);
  const references = document?.properties?.connectionReferences;
  const dependencies = references && typeof references === 'object'
    ? Object.values(references).map(item => item?.connection?.connectionReferenceLogicalName).filter(Boolean).map(name => ({ component: 'connectionreference', name })) : [];
  return { fields, dependencies };
}

/**
 * Inventory records of one component file (`info` from classifyInventoryPath). `text` is its UTF-8 content when the
 * file is small enough to read; binary payloads (`.msapp`) are listed by name and size only and never inflated here.
 */
export function inventoryEntry(file, { size = null, text = null, component, componentName } = {}) {
  const name = componentName ?? stem(String(file).split('/').at(-1));
  if (component === 'canvasapp' && /\.msapp$/i.test(file)) return [inventoryRecord({ component, name, msapp: { size } })];
  const yamlRoot = SECURITY_YAML_ROOTS[component], xml = /\.xml$/i.test(file);
  if (text != null && (xml || (yamlRoot && /\.ya?ml$/i.test(file)))) {
    let root;
    try { root = xml ? parseSolutionXml(text, { recover: true }) : yamlNode(text, yamlRoot); } catch { return [inventoryRecord({ component, name, size })]; }
    const records = inventoryFacts(root, { component, componentName: name }).filter(record => record.component === component);
    for (const record of records) record.name ||= name;
    if (component === 'customcontrol') {
      const control = root.name === 'manifest' ? root.children.find(item => item.name === 'control') : null;
      const attribute = key => control && Object.hasOwn(control.attrs, key) ? control.attrs[key] : null;
      return [inventoryRecord({ component, name: attribute('namespace') && attribute('constructor') ? `${attribute('namespace')}.${attribute('constructor')}` : name,
        version: attribute('version'), controlType: attribute('control-type') })];
    }
    return records.length ? records : [inventoryRecord({ component, name })];
  }
  // The C# script text is kept (Learn: at most 1 MB): the connector runtime runs it through the local .NET SDK.
  if (component === 'connector' && /\.csx$/i.test(file)) return [inventoryRecord({ component, name, script: true, ...(text != null ? { scriptText: text } : {}) })];
  const extra = {};
  if (text != null && size <= TEXT_LIMIT) {
    if (component === 'connector') Object.assign(extra, connectorFacts(text, file));
    else if (DATA.test(file)) {
      const { fields, dependencies } = dataFacts(text, file);
      if (dependencies.length) extra.dependencies = dependencies;
      // A modern flow file with its workflow id and/or client data definition (flow-yaml.mjs): together they make it runnable.
      // A file that does not parse carries MODERNFLOW_YAML_INVALID (file and parser line) as an error: never a silent skip.
      if (component === 'modernflow') { const facts = modernFlowFacts(text, file); if (facts.workflowId) extra.flowWorkflowId = true; if (facts.definition) extra.flowDefinition = true; if (facts.invalid) extra.diagnostics = [facts.invalid]; }
      if (component === 'connectionreference') {
        const connectorId = fields.connectorid ?? null;
        Object.assign(extra, { id: fields.connectionreferenceid, displayName: fields.connectionreferencedisplayname, connectorId,
          dependencies: connectorId ? [{ component: 'connector', name: connectorName(connectorId) }] : [] });
        return [inventoryRecord({ component, name: fields.connectionreferencelogicalname ?? name, ...extra })];
      }
    }
  }
  return [inventoryRecord({ component, name, ...extra })];
}

/** Connection reference facts (`{ logicalName, displayName, connectorId }`) among inventory records. */
export const connectionReferenceFacts = records => records.filter(record => record.component === 'connectionreference' && record.name)
  .map(record => Object.fromEntries(Object.entries({ logicalName: record.name, displayName: record.displayName, connectorId: record.connectorId, id: record.id })
    .filter(([, entry]) => entry != null)));

/**
 * One record per component and name in a layer: later facts fill fields earlier ones left empty, dependencies are
 * united (a classic canvas app is described by Customizations.xml, its .meta.xml and its .msapp).
 */
export function mergeInventory(records) {
  const merged = new Map();
  for (const record of records) {
    const key = `${record.component}:${record.name.toLowerCase()}`;
    const current = merged.get(key);
    if (!current) { merged.set(key, { ...record, dependencies: [...record.dependencies] }); continue; }
    for (const [field, entry] of Object.entries(record)) if (field !== 'dependencies' && (current[field] == null || current[field] === '')) current[field] = entry;
    // A role file's privileges and a profile's permissions complete an empty declaration of the same component.
    for (const field of ['privileges', 'permissions']) if (Array.isArray(record[field]) && record[field].length && !current[field]?.length) current[field] = record[field];
    if (record.level === 'inventory') current.level = 'inventory';
    for (const dependency of record.dependencies)
      if (!current.dependencies.some(item => item.component === dependency.component && item.name === dependency.name)) current.dependencies.push(dependency);
    if (record.canvas) current.canvas = record.canvas;
  }
  // A modern flow whose files carry its workflow id and definition is imported into the flow interpreter (flow-yaml.mjs).
  for (const record of merged.values()) if (record.component === 'modernflow' && record.flowWorkflowId && record.flowDefinition)
    Object.assign(record, { level: 'behaviour', reason: 'MODERNFLOW_YAML_IMPORTED' });
  // A connector with an OpenAPI definition is compiled (custom-connector.mjs): without diagnostics it runs at contract; a
  // blocking diagnostic (unsupported policy, auth, script) is attached as an error, so its preflight row names it. A C# script
  // without the .NET SDK on PATH is that gap (CONNECTOR_SCRIPT_SDK_MISSING): its operations refuse until the SDK is installed.
  for (const record of merged.values()) if (record.component === 'connector' && record.compiled) {
    const { blocked, diagnostics, script } = compileConnector(record);
    const sdk = script && !dotnetSdk() ? { code: SDK_MISSING, message: 'The connector runs C# custom code (script.csx); install the .NET SDK (dotnet on PATH) to run it locally.' } : null;
    if (!diagnostics.length && !sdk) Object.assign(record, { level: 'contract', reason: 'CONNECTOR_COMPILED_CONTRACT' });
    else if (blocked ?? sdk) record.diagnostics = [...(record.diagnostics ?? []), { ...(blocked ?? sdk), severity: 'error' }];
  }
  return [...merged.values()];
}

/** Diagnostic code of an inventory-level component kind (once per kind per layer). */
export const inventoryCode = component => BY_COMPONENT.get(component)?.code ?? 'SOLUTION_COMPONENT_INVENTORY';

/**
 * The canvas record of an `.msapp` payload: canvas-source.mjs parses its Src/*.pa.yaml (screens, components, data
 * sources, formula text; nothing is evaluated). Above CANVAS_MSAPP_LIMIT only the name and size are listed.
 */
export async function canvasMsappRecord(bytes, { name, size = bytes?.length ?? null } = {}) {
  if (!bytes || size > CANVAS_MSAPP_LIMIT)
    return inventoryRecord({ component: 'canvasapp', name, msapp: { size }, diagnostics: [{ code: 'SOLUTION_CANVAS_MSAPP_TOO_LARGE', message: `The .msapp exceeds ${CANVAS_MSAPP_LIMIT} bytes; it is listed by name and size only.` }] });
  const source = await readCanvasSource({ msapp: bytes, name });
  const record = canvasInventoryRecord(source);
  return { ...inventoryRecord({ ...record, id: null }), msapp: { size }, canvas: { schemaVersion: source.app.schemaVersion,
    screens: source.screens.map(screen => screen.name), components: source.components.map(component => component.name), dataSources: source.dataSources,
    formulas: source.formulas, diagnostics: source.diagnostics } };
}
