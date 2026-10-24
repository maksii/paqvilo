// Inert solution payloads. The archive supplies metadata and opaque bytes, never
// executable application code. Component codes follow the solutioncomponent table:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solutioncomponent
import { randomUUID, createHash } from 'node:crypto';
import { parseSolutionXml, child, childText, descendants, labelsOf, pickLabel, serializeXml } from './solution-xml.mjs';
import { sourceRecordId } from './source-record-id.mjs';

const lower = value => String(value ?? '').toLowerCase();
const guid = value => lower(value).replace(/[{}]/g, '');
const validId = value => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
const nodes = (root, name) => root.name === name ? [root] : descendants(root, name);
const value = (node, ...names) => names.map(name => childText(node, name) ?? node.attrs?.[name]).find(v => v !== undefined);
const xmlOf = node => node ? node.children.length ? node.children.map(serializeXml).join('') : node.text.trim() : '';
export const PAYLOAD_COMPONENTS = Object.freeze({ systemform: 60, savedquery: 26, workflow: 29, sitemap: 62, appmodule: 80, webresource: 61, key: 14 });
// SiteMap is not in the pinned standard catalogue. Public table identity:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/sitemap
const SITEMAP = { entitySet: 'sitemaps', primaryIdAttribute: 'sitemapid', ownershipType: 'OrganizationOwned', tableType: 'Standard' };

export function ensureSolutionComponentMapping(state, component, definitionOf) {
  const table = component.logical, definition = definitionOf?.(table) ?? (table === 'sitemap' ? SITEMAP : null);
  const existing = state.mappings[table];
  if (!definition && !existing) throw new Error(`A public table definition is required for ${table}.`);
  const idColumn = definition?.primaryIdAttribute ?? existing.idColumn;
  const mapping = state.mappings[table] ??= {
    logicalName: table, entitySet: definition.entitySet, idColumn, nameColumn: definition.primaryNameAttribute,
    ownership: definition.ownershipType, tableType: definition.tableType,
    dataverseOnly: true, userConfigured: true, relationships: {},
    fields: Object.fromEntries(Object.entries(definition.attributes ?? {}).map(([name, field]) => [name, { dataverseType: field.type }])),
  };
  mapping.ownership ??= definition?.ownershipType;
  mapping.fields ??= {};
  mapping.fields[idColumn] ??= { dataverseType: 'uniqueidentifier' };
  for (const [name, value] of Object.entries(component.row)) mapping.fields[name] ??= { dataverseType: /(?:xml|xaml)$/.test(name) ? 'memo' : typeof value === 'boolean' ? 'bit' : typeof value === 'number' ? 'int' : 'nvarchar' };
  return mapping;
}

/** Source-defined records; an app without an exported GUID uses its stable local identity. */
export function solutionDocumentComponents(xml, { name = '', entityDir, entity: enclosingEntity, lcid = 1033 } = {}) {
  const root = typeof xml === 'string' ? parseSolutionXml(xml) : xml;
  const out = [];
  const add = (kind, id, row, entity, labels) => {
    id = guid(id);
    if (!validId(id)) return;
    out.push({ kind, id, type: PAYLOAD_COMPONENTS[kind], logical: kind, name: id, entity, ...(labels ? { labels } : {}), row: { ...row, [kind === 'systemform' ? 'formid' : `${kind}id`]: id } });
  };
  const title = node => pickLabel(labelsOf(child(node, 'LocalizedNames')), lcid) ?? value(node, 'Name', 'name') ?? '';
  for (const node of [...nodes(root, 'AppModule'), ...nodes(root, 'appmodule')]) {
    const appName = value(node, 'UniqueName', 'uniquename');
    const appId = guid(value(node, 'AppModuleId', 'appmoduleid')) || (appName ? sourceRecordId('appmodule', appName) : '');
    add('appmodule', appId, { uniquename: value(node, 'UniqueName', 'uniquename'), name: title(node), appmodulexml: serializeXml(node),
      ...(validId(guid(value(node, 'AppModuleIdUnique', 'appmoduleidunique'))) ? { appmoduleidunique: guid(value(node, 'AppModuleIdUnique', 'appmoduleidunique')) } : {}) }, undefined, labelsOf(child(node, 'LocalizedNames')));
    const app = out.findLast(component => component.kind === 'appmodule' && component.id === appId);
    if (app) app.members = [...descendants(node, 'AppModuleComponent'), ...descendants(node, 'appmodulecomponent')].map(member => ({
      type: Number(member.attrs.type ?? member.attrs.componenttype), objectId: guid(member.attrs.id ?? member.attrs.objectid),
      entity: lower(member.attrs.schemaName ?? member.attrs.logicalname),
      id: guid(member.attrs.appmodulecomponentid ?? value(member, 'AppModuleComponentId')),
    }));
  }
  for (const node of nodes(root, 'AppModuleSiteMap')) {
    const mapName = value(node, 'AppModuleUniqueName', 'SiteMapUniqueName', 'UniqueName');
    add('sitemap', value(node, 'SiteMapId', 'SiteMapIdUnique', 'sitemapid') || (mapName ? sourceRecordId('sitemap', mapName) : ''),
      { sitemapxml: serializeXml(node), appmoduleuniquename: mapName, appmoduleid: guid(value(node, 'AppModuleId')), name: title(node) }, undefined, labelsOf(child(node, 'LocalizedNames')));
  }
  const entities = nodes(root, 'Entity');
  const containers = entities.length ? entities.map(node => ({ node, entity: lower(value(child(child(node, 'EntityInfo'), 'entity') ?? node, 'Name') || child(node, 'Name')?.attrs.OriginalName || childText(node, 'Name')) }))
    : [{ node: root, entity: lower(enclosingEntity ?? entityDir ?? /(?:^|\/)Entities\/([^/]+)\//i.exec(name)?.[1]) }];
  for (const { node: container, entity } of containers) {
    for (const node of nodes(container, 'systemform')) add('systemform', value(node, 'formid', 'FormId'), {
      formid: guid(value(node, 'formid', 'FormId')), name: title(node), objecttypecode: entity, formxml: child(node, 'form') ? serializeXml(child(node, 'form')) : childText(node, 'formxml'),
      type: Number(value(node, 'type') ?? 2), formactivationstate: Number(value(node, 'FormActivationState') ?? 1),
    }, entity, labelsOf(child(node, 'LocalizedNames')));
    for (const node of nodes(container, 'savedquery')) add('savedquery', value(node, 'savedqueryid'), {
      name: title(node), returnedtypecode: entity, fetchxml: xmlOf(child(node, 'fetchxml')), layoutxml: xmlOf(child(node, 'layoutxml')),
      querytype: Number(value(node, 'querytype') ?? 0), isdefault: value(node, 'isdefault') === '1',
    }, entity, labelsOf(child(node, 'LocalizedNames')));
  }
  for (const node of [...nodes(root, 'Workflow'), ...nodes(root, 'workflow')]) add('workflow', value(node, 'WorkflowId', 'workflowid'), {
    name: title(node), primaryentity: lower(value(node, 'PrimaryEntity', 'primaryentity')), xaml: xmlOf(child(node, 'Xaml') ?? child(node, 'xaml')),
    category: Number(value(node, 'Category', 'category') ?? 0), type: Number(value(node, 'Type', 'type') ?? 1),
    // Imported definitions are preserved. Activation/execution still uses the
    // supported workflow interpreter; arbitrary opaque XAML is not executable.
    statecode: 0, statuscode: 1,
  }, undefined, labelsOf(child(node, 'LocalizedNames')));
  for (const node of [...nodes(root, 'WebResource'), ...nodes(root, 'webresource')]) add('webresource', value(node, 'WebResourceId', 'webresourceid'), {
    name: value(node, 'Name', 'name'), displayname: value(node, 'DisplayName', 'displayname'), webresourcetype: Number(value(node, 'WebResourceType', 'webresourcetype') ?? 0),
  });
  return out;
}

export function payloadComponentsOf(state) {
  return Object.values(state.dataverse?.solutionPayloads ?? {}).map(item => item.component).filter(component => component.type !== undefined);
}

// App membership row IDs are local RFC 4122 v5 identifiers, not claimed native
// installation IDs. Object references retain exported IDs as private provenance.
const memberId = (namespace, name) => {
  const bytes = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 0x0f | 0x50; bytes[8] = bytes[8] & 0x3f | 0x80;
  return bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
};
export function withSolutionAppMembers(components, state, entityId) {
  const out = [...components], referenceTables = { 26: 'savedquery', 29: 'workflow', 60: 'systemform', 62: 'sitemap', 61: 'webresource' };
  const componentIds = new Set(), siteMaps = new Map(), tableIds = new Map();
  for (const component of components) {
    componentIds.add(`${component.logical}/${component.id}`);
    if (component.kind === 'sitemap') {
      const name = lower(component.row.appmoduleuniquename);
      if (!siteMaps.has(name)) siteMaps.set(name, component.id);
    }
  }
  const hasRow = (table, id) => {
    if (!tableIds.has(table)) tableIds.set(table, new Set((state.tables?.[table] ?? []).map(row => guid(row[table === 'systemform' ? 'formid' : `${table}id`]))));
    return tableIds.get(table).has(id);
  };
  for (const app of components.filter(component => component.kind === 'appmodule')) {
    const appUnique = app.row.appmoduleidunique ?? app.id;
    for (const member of app.members ?? []) {
      let objectId = member.objectId;
      if (member.type === 1) {
        if (!member.entity || !Object.hasOwn(state.mappings ?? {}, member.entity)) continue;
        objectId = entityId?.(member.entity, state) ?? objectId;
      } else {
        const table = referenceTables[member.type];
        if (member.type === 62 && !validId(objectId) && member.entity)
          objectId = siteMaps.get(member.entity);
        if (!table || !validId(objectId)) continue;
        const present = componentIds.has(`${table}/${objectId}`) || hasRow(table, objectId);
        if (!present) continue;
      }
      if (!validId(objectId)) continue;
      const id = validId(member.id) ? member.id : memberId(appUnique, `${member.type}:${objectId}`);
      out.push({ kind: 'appmodulecomponent', logical: 'appmodulecomponent', name: id, id, appId: app.id, sourceObjectId: member.objectId,
        row: { appmodulecomponentid: id, appmoduleidunique: appUnique, objectid: objectId, componenttype: member.type } });
    }
  }
  return out;
}

/** Capture the prior row once, then maintain per-solution definitions for restore. */
export function applySolutionPayloads(state, solutionId, components, { overwrite = false, definitionOf, entityId } = {}) {
  const bag = ((state.dataverse ??= {}).solutionPayloads ??= {});
  const membership = (state.tables.solutioncomponent ??= []);
  const origin = (state.dataverse.componentOrigin ??= {});
  for (const component of withSolutionAppMembers(components, state, entityId)) {
    const id = lower(component.id), table = component.logical;
    const mapping = ensureSolutionComponentMapping(state, component, definitionOf);
    const idColumn = mapping.idColumn;
    const rows = (state.tables[table] ??= []);
    let row = rows.find(row => guid(row[idColumn]) === id);
    const record = (bag[id] ??= { component: { ...component, row: undefined }, baseRow: row ? structuredClone(row) : null, layers: [] });
    record.layers = record.layers.filter(layer => lower(layer.solutionId) !== lower(solutionId));
    record.layers.push({ solutionId, row: { ...component.row, [idColumn]: id }, active: !row || overwrite || !record.baseRow });
    const layer = record.layers.at(-1);
    if (layer.active) {
      if (row) Object.assign(row, layer.row); else rows.push(structuredClone(layer.row));
    }
    if (!row && !origin[id]) origin[id] = solutionId;
    if (component.type !== undefined && !membership.some(row => lower(row.solutionid) === lower(solutionId) && lower(row.objectid) === id && row.componenttype === component.type))
      membership.push({ solutioncomponentid: randomUUID(), solutionid: solutionId, objectid: id, componenttype: component.type, rootcomponentbehavior: 0, ismetadata: true });
  }
}

export function removeSolutionPayloads(state, solutionIds) {
  const removed = new Set([...solutionIds].map(lower));
  const bag = state.dataverse?.solutionPayloads ?? {};
  for (const [id, record] of Object.entries(bag)) {
    if (!record.layers.some(layer => removed.has(lower(layer.solutionId)))) continue;
    record.layers = record.layers.filter(layer => !removed.has(lower(layer.solutionId)));
    const table = record.component.logical, idColumn = table === 'systemform' ? 'formid' : `${table}id`;
    const rows = (state.tables[table] ??= []), index = rows.findIndex(row => guid(row[idColumn]) === id);
    const restored = record.layers.findLast(layer => layer.active)?.row ?? record.baseRow;
    if (index >= 0) rows.splice(index, 1, ...(restored ? [structuredClone(restored)] : []));
    else if (restored) rows.push(structuredClone(restored));
    if (!record.layers.length) delete bag[id];
    if (removed.has(lower(state.dataverse.componentOrigin?.[id]))) {
      if (record.layers.length) state.dataverse.componentOrigin[id] = record.layers[0].solutionId;
      else delete state.dataverse.componentOrigin[id];
    }
  }
}

export function reassignSolutionPayloads(state, sourceIds, targetId) {
  const ids = new Set([...sourceIds].map(lower));
  for (const record of Object.values(state.dataverse?.solutionPayloads ?? {}))
    for (const layer of record.layers) if (ids.has(lower(layer.solutionId))) layer.solutionId = targetId;
  for (const [id, owner] of Object.entries(state.dataverse?.componentOrigin ?? {})) if (ids.has(lower(owner))) state.dataverse.componentOrigin[id] = targetId;
}

// XML component merge preserves opaque siblings and original column metadata.
// Singleton containers merge recursively; identified components merge by exported
// name/GUID. This is a metadata merge, never a string concatenate of XML roots.
const nodeKey = node => {
  const names = { Entity: ['Name', 'LogicalName'], attribute: ['LogicalName', 'Name'], EntityKey: ['LogicalName', 'Name'], systemform: ['formid'], savedquery: ['savedqueryid'], Workflow: ['WorkflowId'], AppModule: ['AppModuleId', 'UniqueName'] };
  const id = (node.name === 'Entity' ? child(child(node, 'EntityInfo'), 'entity')?.attrs.Name : undefined)
    ?? (names[node.name] ?? []).map(name => value(node, name)).find(Boolean)
    ?? node.attrs.Name ?? node.attrs.name ?? node.attrs.id ?? node.attrs.Id
    ?? node.attrs.languagecode ?? node.attrs.value;
  return `${node.name}|${lower(id)}`;
};
export function mergeSolutionXml(earlier, later) {
  const out = structuredClone(earlier);
  Object.assign(out.attrs, later.attrs);
  if (later.text.trim()) out.text = later.text;
  if (!later.children.length && later.text.trim()) out.children = [];
  for (const node of later.children) {
    const key = nodeKey(node), index = out.children.findIndex(old => nodeKey(old) === key);
    if (index < 0) out.children.push(structuredClone(node));
    else out.children[index] = mergeSolutionXml(out.children[index], node);
  }
  return out;
}

const putText = (node, name, text) => {
  if (text === undefined || text === null) return;
  const current = child(node, name), replacement = { name, attrs: {}, text: String(text), children: [] };
  if (current) node.children[node.children.indexOf(current)] = replacement;
  else node.children.push(replacement);
};
const putXml = (node, name, text, { inner = false } = {}) => {
  if (!text) return;
  const parsed = parseSolutionXml(text), current = child(node, name);
  const replacement = inner ? { name, attrs: {}, text: '', children: [parsed] } : parsed;
  if (current) node.children[node.children.indexOf(current)] = replacement;
  else node.children.push(replacement);
};

function reflectAppMembers(node, app, state) {
  const appUnique = guid(app.appmoduleidunique ?? app.appmoduleid);
  const rows = (state.tables?.appmodulecomponent ?? []).filter(row => guid(row.appmoduleidunique) === appUnique);
  const container = child(node, 'AppModuleComponents') ?? child(node, 'appmodulecomponents') ?? { name: 'AppModuleComponents', attrs: {}, children: [], text: '' };
  const references = container.children.filter(node => /^(?:AppModuleComponent|appmodulecomponent)$/.test(node.name));
  const refType = ref => Number(ref.attrs.type ?? ref.attrs.componenttype);
  const refId = ref => guid(ref.attrs.id ?? ref.attrs.objectid);
  const refEntity = ref => lower(ref.attrs.schemaName ?? ref.attrs.logicalname);
  const organization = guid(state.dataverse?.organizationId);
  const canonicalEntityId = entity => validId(organization) && Object.hasOwn(state.mappings ?? {}, entity) ? memberId(organization, `entity:${entity}`) : null;
  const matches = (ref, row) => refType(ref) === Number(row.componenttype) && (refId(ref) === guid(row.objectid)
    || refType(ref) === 1 && refEntity(ref) && canonicalEntityId(refEntity(ref)) === guid(row.objectid));
  const known = ref => {
    if (refType(ref) === 1) return Boolean(refEntity(ref) && Object.hasOwn(state.mappings ?? {}, refEntity(ref)));
    const table = { 26: 'savedquery', 29: 'workflow', 60: 'systemform', 61: 'webresource', 62: 'sitemap' }[refType(ref)];
    const id = refId(ref);
    return Boolean(table && (state.dataverse?.solutionPayloads?.[id] || state.dataverse?.sourceSolutionComponents?.baseline?.[`${table}/${id}`]
      || state.tables?.[table]?.some(row => guid(row[table === 'systemform' ? 'formid' : `${table}id`]) === id)));
  };
  // Unsupported references retain their original declaration. Only supported,
  // resolved membership is reconstructed; other XML siblings stay untouched.
  container.children = container.children.filter(node => !references.includes(node) || !known(node) && !rows.some(row => matches(node, row)));
  for (const row of rows) {
    const original = references.find(ref => matches(ref, row));
    const ref = original ? structuredClone(original) : { name: 'AppModuleComponent', attrs: { type: String(row.componenttype), id: guid(row.objectid) }, children: [], text: '' };
    if (!original && Number(row.componenttype) === 1) {
      const entity = Object.keys(state.mappings ?? {}).find(entity => canonicalEntityId(entity) === guid(row.objectid));
      if (entity) ref.attrs.schemaName = entity;
    }
    container.children.push(ref);
  }
  if (!node.children.includes(container)) node.children.push(container);
}

/** Export the current metadata record values while retaining opaque XML siblings. */
export function reflectSolutionPayloadRows(root, state) {
  const bag = state.dataverse?.solutionPayloads ?? {};
  const visit = source => {
    let node = structuredClone(source);
    const shape = {
      systemform: ['systemform', 'formid'], savedquery: ['savedquery', 'savedqueryid'],
      AppModule: ['appmodule', 'AppModuleId'], appmodule: ['appmodule', 'appmoduleid'],
      AppModuleSiteMap: ['sitemap', 'SiteMapId'], Workflow: ['workflow', 'WorkflowId'], workflow: ['workflow', 'workflowid'],
    }[node.name];
    if (shape) {
      const [table, idName] = shape, key = guid(value(node, idName));
      if (bag[key]) {
        const row = state.tables?.[table]?.find(row => guid(row[table === 'systemform' ? 'formid' : `${table}id`]) === key);
        if (!row) return null;
        if (table === 'appmodule' && row.appmodulexml) node = parseSolutionXml(row.appmodulexml);
        if (table === 'appmodule') reflectAppMembers(node, row, state);
        if (table === 'sitemap' && row.sitemapxml) node = parseSolutionXml(row.sitemapxml);
        if (row.name !== undefined) {
          const localized = child(node, 'LocalizedNames');
          if (localized) {
            for (const label of localized.children) if (label.attrs.description !== undefined) label.attrs.description = row.name;
          } else putText(node, 'Name', row.name);
          if (node.attrs.Name !== undefined) node.attrs.Name = row.name;
        }
        if (table === 'systemform') { putXml(node, 'form', row.formxml); putText(node, 'type', row.type); putText(node, 'FormActivationState', row.formactivationstate); }
        if (table === 'savedquery') {
          putXml(node, 'fetchxml', row.fetchxml, { inner: true });
          putXml(node, 'layoutxml', row.layoutxml, { inner: true });
          putText(node, 'querytype', row.querytype); putText(node, 'isdefault', row.isdefault ? 1 : 0);
        }
        if (table === 'workflow') putText(node, 'Xaml', row.xaml);
      }
    }
    node.children = node.children.map(visit).filter(Boolean);
    return node;
  };
  return visit(root);
}

/** Fold packed/unpacked schema payloads into current schema, retaining assets. */
export function mergeSolutionCustomizationEntries(entries, generatedXml, state) {
  let root = { name: 'ImportExportXml', attrs: {}, children: [], text: '' };
  const retained = new Map();
  for (const entry of entries) {
    const schema = /(?:^|\/)(?:customizations\.xml|Entities\/[^/]+\/Entity\.xml|OptionSets\/[^/]+\.xml|Relationships\/[^/]+\.xml)$/i.test(entry.name);
    if (!schema) {
      if (/(?:^|\/)(?:Entities\/.*(?:FormXml|SavedQueries)\/.*|AppModules\/.*|AppModuleSiteMaps\/.*|Workflows\/.*)\.xml$/i.test(entry.name)) {
        const source = reflectSolutionPayloadRows(parseSolutionXml(entry.data.toString('utf8')), state);
        if (source) retained.set(lower(entry.name), { ...entry, data: Buffer.from(serializeXml(source)) });
      } else retained.set(lower(entry.name), entry);
      continue;
    }
    const source = parseSolutionXml(entry.data.toString('utf8'));
    let doc = source;
    if (source.name === 'Entity') doc = { name: 'ImportExportXml', attrs: {}, text: '', children: [{ name: 'Entities', attrs: {}, text: '', children: [source] }] };
    if (source.name === 'optionset') doc = { name: 'ImportExportXml', attrs: {}, text: '', children: [{ name: 'optionsets', attrs: {}, text: '', children: [source] }] };
    if (source.name === 'EntityRelationship') doc = { name: 'ImportExportXml', attrs: {}, text: '', children: [{ name: 'EntityRelationships', attrs: {}, text: '', children: [source] }] };
    root = mergeSolutionXml(root, doc);
  }
  root = mergeSolutionXml(root, parseSolutionXml(generatedXml));
  const entities = child(root, 'Entities');
  if (entities) entities.children = entities.children.filter(node => {
    const header = child(child(node, 'EntityInfo'), 'entity');
    const logical = lower(header?.attrs.Name ?? childText(node, 'Name'));
    const mapping = state.mappings?.[logical];
    if (!mapping) return false;
    const attributes = child(header, 'attributes');
    if (attributes) attributes.children = attributes.children.filter(a => mapping.fields?.[lower(value(a, 'LogicalName', 'Name'))]);
    const keys = child(header, 'EntityKeys');
    if (keys) keys.children = keys.children.filter(key => (mapping.alternateKeys ?? []).some(current => lower(current.name) === lower(value(key, 'LogicalName', 'Name'))));
    return true;
  });
  return [...retained.values(), { name: 'customizations.xml', data: Buffer.from(serializeXml(reflectSolutionPayloadRows(root, state))) }];
}
