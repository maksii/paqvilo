import { compileForm } from './solution.mjs';
import { defaultManagementApp, powerPagesTables } from './power-pages.mjs';

const friendly = name => String(name).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const scalarTypes = new Set(['nvarchar', 'ntext', 'string', 'memo', 'bit', 'boolean', 'picklist', 'state', 'status', 'int', 'integer', 'bigint', 'decimal', 'double', 'float', 'money', 'datetime', 'date', 'lookup', 'customer', 'owner', 'primarykey', 'uniqueidentifier', 'entityname', 'json']);
export function solutionApps(scan) {
  const apps = new Map(), maps = [];
  for (const layer of scan.layers ?? []) for (const document of layer.documents ?? []) {
    for (const app of document.facts.apps ?? []) {
      const key = app.uniqueName ?? app.id;
      apps.set(key, { ...apps.get(key), ...app, source: 'solution', sourceFile: document.file });
    }
    maps.push(...document.facts.appMaps ?? []);
  }
  for (const app of apps.values()) {
    const map = maps.findLast(map => map.uniqueName === app.uniqueName || map.appId && map.appId === app.id);
    if (map) app.navigation = map.navigation;
  }
  return [...apps.values()];
}

/** Stable JSON contract consumed by the shell and future control/command registries. */
export function appCatalogue({ portal, metadata = {}, mappings = {} }) {
  const tables = powerPagesTables(portal, metadata);
  for (const [entity, mapping] of Object.entries(mappings)) {
    if (tables[entity]) continue;
    const exported = metadata.entities?.[entity];
    tables[entity] = { entity, label: exported?.collectionLabel ?? friendly(entity), singular: exported?.label ?? friendly(entity),
      idColumn: mapping.idColumn ?? `${entity}id`, nameColumn: mapping.nameColumn ?? exported?.primaryNameAttribute ?? mapping.idColumn ?? `${entity}id`,
      fields: { ...(mapping.fieldMetadata ?? mapping.fields), ...exported?.fields }, source: exported ? 'solution' : 'local-mapping', projected: false };
  }
  for (const table of Object.values(tables)) {
    table.fields = Object.fromEntries(Object.entries(table.fields).map(([name, field]) => [name, typeof field === 'object' && field ? { name, ...field } : { name, label: friendly(name), type: 'text', dataverseType: field }]));
    for (const field of Object.values(table.fields)) if (field.dataverseType && !scalarTypes.has(field.dataverseType)) field.type = 'unsupported';
    table.fields[table.idColumn] ??= { name: table.idColumn, label: 'ID', type: 'text', isPrimaryId: true, validForCreate: false, validForUpdate: false };
    table.fields[table.nameColumn] ??= { name: table.nameColumn, label: 'Name', type: 'text' };
    const forms = (metadata.forms ?? []).filter(form => form.entity === table.entity && form.active !== false && (form.systemFormType === undefined || form.systemFormType === 2) && (!form.formType || form.formType === 'main'));
    table.forms = forms.map(form => compileForm(form, table.fields, metadata.lcid)).filter(Boolean);
    if (!table.forms.length) table.forms = [{ id: 'generated', name: 'Information', source: 'generated', tabs: [{ id: 'general', label: 'General', visible: true, sections: [{ label: '', fields: Object.values(table.fields).filter(field => !field.isPrimaryId).map(field => ({ name: field.name, label: field.label, supported: true, visible: true })) }] }] }];
    table.views = (metadata.views ?? []).filter(view => view.entity === table.entity && view.queryType === 0).map(view => ({ id: view.id, name: view.name, isDefault: view.isDefault, fields: view.fields, fetchXml: view.fetchXml, source: 'solution' }));
    if (!table.views.length) table.views = [{ id: 'active', name: `Active ${table.label}`, isDefault: true, source: 'generated', state: 0 }, { id: 'all', name: `All ${table.label}`, source: 'generated' }, { id: 'inactive', name: `Inactive ${table.label}`, source: 'generated', state: 1 }];
    for (const view of table.views) view.fields ??= [table.nameColumn, ...Object.keys(table.fields).filter(name => ![table.nameColumn, table.idColumn].includes(name)).slice(0, 5)].map(name => ({ name, width: 180 }));
  }
  const builtin = defaultManagementApp(portal);
  const imported = structuredClone(metadata.modelDrivenApps ?? []);
  const management = imported.find(app => app.uniqueName?.toLowerCase() === builtin.uniqueName.toLowerCase());
  const defaultApp = management ? { ...builtin, ...management, navigation: management.navigation?.length ? management.navigation : builtin.navigation } : builtin;
  const apps = [defaultApp, ...imported.filter(app => app !== management)];
  for (const app of apps) {
    if (!app.navigation?.length) {
      const names = app.components?.filter(component => component.type === 1).map(component => component.entity).filter(Boolean) ?? [];
      app.navigation = [{ id: 'main', title: app.name ?? app.uniqueName, groups: [{ id: 'tables', title: 'Tables', items: names.map(entity => ({ id: entity, entity, title: tables[entity]?.label ?? entity, supported: Boolean(tables[entity]) })) }] }];
    }
    for (const area of app.navigation) for (const group of area.groups) for (const item of group.items) {
      if (item.entity && !tables[item.entity]) { item.supported = false; item.reason = 'This table has no imported metadata or local mapping.'; }
      item.title ??= tables[item.entity]?.label ?? item.entity ?? item.id;
    }
  }
  return { version: 1, defaultApp: defaultApp.id, apps, tables,
    capabilities: { localCrud: true, views: true, search: true, filters: true, columns: true, solutionNavigation: true, relatedSubgrids: true,
      scripts: false, businessProcessFlows: false, customControls: false, reports: false, powerBi: false, flows: false, globalSearch: false, advancedFind: false, classicSettings: false } };
}
