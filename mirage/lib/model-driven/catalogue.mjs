import { compileForm } from './solution.mjs';
import { powerPagesProvider } from './providers.mjs';
import { controlDescriptor } from './control-descriptors.mjs';
import { pickLabel } from '../solution-xml.mjs';

const friendly = name => String(name).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
export function solutionApps(scan, { lcid = 1033 } = {}) {
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
  const navigation = areas => (areas ?? []).map(area => ({ ...area, title: pickLabel(area.titleLabels, lcid) ?? area.title,
    groups: area.groups.map(group => ({ ...group, title: pickLabel(group.titleLabels, lcid) ?? group.title,
      items: group.items.map(item => ({ ...item, title: pickLabel(item.titleLabels, lcid) ?? item.title })) })) }));
  return [...apps.values()].map(app => ({ ...app, name: pickLabel(app.nameLabels, lcid) ?? app.name, navigation: navigation(app.navigation) }));
}

/** Stable JSON contract consumed by the shell and future control/command registries. */
export function appCatalogue({ portal, metadata = {}, mappings = {}, providers = portal ? [powerPagesProvider(portal, metadata)] : [], defaultApp: selectedDefault } = {}) {
  const tables = Object.assign({}, ...providers.filter(Boolean).map(provider => structuredClone(provider.tables ?? {})));
  for (const [entity, mapping] of Object.entries(mappings)) {
    if (tables[entity]) continue;
    const exported = metadata.entities?.[entity];
    tables[entity] = { entity, label: exported?.collectionLabel ?? friendly(entity), singular: exported?.label ?? friendly(entity),
      idColumn: mapping.idColumn ?? `${entity}id`, nameColumn: mapping.nameColumn ?? exported?.primaryNameAttribute ?? mapping.idColumn ?? `${entity}id`,
      fields: { ...(mapping.fieldMetadata ?? mapping.fields), ...exported?.fields }, source: exported ? 'solution' : 'local-mapping', projected: false };
  }
  for (const table of Object.values(tables)) {
    table.fields = Object.fromEntries(Object.entries(table.fields).map(([name, field]) => [name, typeof field === 'object' && field ? { name, ...field } : { name, label: friendly(name), type: 'text', dataverseType: field }]));
    for (const field of Object.values(table.fields)) { field.control = controlDescriptor(field); field.type = field.control.type; }
    table.fields[table.idColumn] ??= { name: table.idColumn, label: 'ID', type: 'text', isPrimaryId: true, validForCreate: false, validForUpdate: false };
    table.fields[table.nameColumn] ??= { name: table.nameColumn, label: 'Name', type: 'text' };
    const forms = (metadata.forms ?? []).filter(form => form.entity === table.entity && form.active !== false && (form.systemFormType === undefined || form.systemFormType === 2) && (!form.formType || form.formType === 'main'));
    table.forms = forms.map(form => compileForm(form, table.fields, metadata.lcid)).filter(Boolean);
    if (!table.forms.length) table.forms = [{ id: 'generated', name: 'Information', source: 'generated', tabs: [{ id: 'general', label: 'General', visible: true, sections: [{ label: '', fields: Object.values(table.fields).filter(field => !field.isPrimaryId).map(field => ({ name: field.name, label: field.label, supported: true, visible: true })) }] }] }];
    table.views = (metadata.views ?? []).filter(view => view.entity === table.entity && view.queryType === 0).map(view => ({ id: view.id, name: view.name, isDefault: view.isDefault, fields: view.fields, fetchXml: view.fetchXml, source: 'solution' }));
    if (!table.views.length) table.views = [{ id: 'active', name: `Active ${table.label}`, isDefault: true, source: 'generated', state: 0 }, { id: 'all', name: `All ${table.label}`, source: 'generated' }, { id: 'inactive', name: `Inactive ${table.label}`, source: 'generated', state: 1 }];
    for (const view of table.views) view.fields ??= [table.nameColumn, ...Object.keys(table.fields).filter(name => ![table.nameColumn, table.idColumn].includes(name)).slice(0, 5)].map(name => ({ name, width: 180 }));
  }
  const imported = structuredClone(metadata.modelDrivenApps ?? []);
  const apps = [];
  for (const builtin of providers.filter(Boolean).flatMap(provider => provider.apps ?? [])) {
    const override = imported.find(app => app.id === builtin.id || app.uniqueName?.toLowerCase() === builtin.uniqueName?.toLowerCase());
    apps.push(override ? { ...builtin, ...override, navigation: override.navigation?.length ? override.navigation : builtin.navigation } : structuredClone(builtin));
  }
  for (const app of imported) if (!apps.some(existing => existing.id === app.id || existing.uniqueName && existing.uniqueName === app.uniqueName)) apps.push(app);
  const providerDefault = providers.find(provider => provider?.defaultApp)?.defaultApp;
  const defaultApp = selectedDefault ? apps.find(app => app.id?.toLowerCase() === selectedDefault.toLowerCase())
    : apps.find(app => app.id === providerDefault) ?? apps[0];
  if (selectedDefault && !defaultApp) throw new Error(`Default application '${selectedDefault}' is not imported.`);
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
  return { version: 1, defaultApp: defaultApp?.id ?? null, apps, tables,
    capabilities: { localCrud: true, views: true, search: true, filters: true, columns: true, solutionNavigation: true, relatedSubgrids: true,
      scripts: false, businessProcessFlows: false, customControls: false, reports: false, powerBi: false, flows: false, globalSearch: false, advancedFind: false, classicSettings: false } };
}
