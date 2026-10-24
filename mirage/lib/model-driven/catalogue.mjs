import { compileForm, parseRibbonCommands, dashboardPage, customPageResolution } from './solution.mjs';
import { powerPagesProvider } from './providers.mjs';
import { controlDescriptor } from './control-descriptors.mjs';
import { pickLabel } from '../solution-xml.mjs';
import { sourceRecordId } from '../source-record-id.mjs';
import { setImmediate } from 'node:timers/promises';
import { webResourcePage } from './client-runtime.mjs';
import path from 'node:path';

/** Model-driven features Mirage inventories but does not host, as capability records (name, level, reason, code). */
export const MODEL_DRIVEN_CAPABILITY_RECORDS = Object.freeze([
  Object.freeze({ name: 'model-driven:offline', kind: 'host-surface', component: 'model-driven', level: 'behaviour', code: 'MD_OFFLINE', operations: [],
    reason: 'An app with a Solution mobile offline profile can go offline per staff session: the profile\'s rows download as the staff user, Xrm.WebApi.offline reads and writes that copy, and going online replays the queued writes through the Web API with conflict detection from the organization setting. The device is simulated; profile filters the simulator cannot evaluate keep a model-driven:offline/<profile> requirement row.' }),
  Object.freeze({ name: 'model-driven:custom-page', kind: 'host-surface', component: 'model-driven', level: 'behaviour', code: 'MD_NAV_CUSTOM_PAGE', operations: [],
    reason: 'Custom pages (SiteMap pages and navigateTo with pageType custom) start their canvas app in the headless canvas host as the staff user: App.OnStart and the start screen\'s OnVisible run with recordId and entityName as Param values, and the shell shows the evaluated screen data. The page is not rendered (canvas:rendering); a page that is not one of the app\'s own canvas app components (AppModuleComponent type 300) with a canvas app in the canvas host is listed disabled with the failed check, and navigateTo rejects it with CustomPageNotFound.' }),
  Object.freeze({ name: 'model-driven:dashboard', kind: 'host-surface', component: 'model-driven', level: 'behaviour', code: 'MD_NAV_DASHBOARD', operations: [],
    reason: 'Solution dashboards (SiteMap pages and navigateTo with pageType dashboard) render their lists over the view query engine as the staff user; charts, web resources, IFRAMEs and other components are listed on the page as unsupported and keep a model-driven:dashboard requirement row.' }),
]);

const friendly = name => String(name).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
// An app's dashboards: those its SiteMap opens, plus its SystemForm components (type 60, shared with forms); an app
// that names none of the Solution dashboards gets them all (the same rule the shell applies to forms and views).
const appDashboards = (app, dashboards) => {
  const ids = new Set((app.components ?? []).filter(component => component.type === 60).map(component => component.id));
  const opened = new Set((app.navigation ?? []).flatMap(area => area.groups.flatMap(group => group.items)).map(item => item.dashboard).filter(Boolean));
  const named = dashboards.filter(dashboard => ids.has(dashboard.id));
  return dashboards.filter(dashboard => opened.has(dashboard.id) || (named.length ? ids.has(dashboard.id) : true));
};
export function solutionApps(scan, { lcid = 1033, projectRoot = null } = {}) {
  const shown = file => (projectRoot && file && path.isAbsolute(file) ? path.relative(projectRoot, file).replaceAll('\\', '/') : file);
  const apps = new Map(), maps = [], dashboards = new Map(), profiles = new Map();
  for (const layer of scan.layers ?? []) for (const document of layer.documents ?? []) {
    // Mobile offline profiles (component type 161, solution-inventory.mjs): a later layer replaces a profile.
    for (const record of document.facts.inventory ?? []) if (record.component === 'mobileofflineprofile' && Array.isArray(record.items))
      profiles.set(record.id ?? record.name.toLowerCase(), { id: record.id, name: record.name, items: record.items, sourceFile: shown(document.file) });
    for (const app of document.facts.apps ?? []) {
      const key = app.uniqueName ?? app.id;
      apps.set(key, { ...apps.get(key), ...app, id: app.id || sourceRecordId('appmodule', app.uniqueName),
        idSource: app.id ? 'exported' : 'derived-local', source: 'solution', sourceFile: shown(document.file) });
    }
    maps.push(...document.facts.appMaps ?? []);
    for (const dashboard of document.facts.dashboards ?? []) dashboards.set(dashboard.id, { ...dashboard, sourceFile: shown(document.file) });
  }
  for (const app of apps.values()) {
    const map = maps.findLast(map => map.uniqueName && app.uniqueName && map.uniqueName.toLowerCase() === app.uniqueName.toLowerCase() || map.appId && map.appId === app.id
      || map.uniqueName && app.components?.some(component => component.type === 62 && component.entity === map.uniqueName.toLowerCase()));
    if (map) app.navigation = map.navigation;
  }
  const navigation = areas => (areas ?? []).map(area => ({ ...area, title: pickLabel(area.titleLabels, lcid) ?? area.title,
    groups: area.groups.map(group => ({ ...group, title: pickLabel(group.titleLabels, lcid) ?? group.title,
      items: group.items.map(item => ({ ...item, title: pickLabel(item.titleLabels, lcid) ?? item.title })) })) }));
  return [...apps.values()].map(app => ({ ...app, name: pickLabel(app.nameLabels, lcid) ?? app.name, description: pickLabel(app.descriptionLabels, lcid) ?? app.description, navigation: navigation(app.navigation),
    dashboards: appDashboards(app, [...dashboards.values()]),
    // The profiles the app names (AppModuleComponent type 161 by id or schema name); an app without one cannot go offline.
    offlineProfiles: [...profiles.values()].filter(profile => (app.components ?? []).some(component => component.type === 161
      && (component.id && component.id === profile.id || component.entity && component.entity === profile.name.toLowerCase()))) }));
}

/** Stable JSON contract consumed by the shell. */
function* catalogueSteps({ portal, metadata = {}, mappings = {}, providers = portal ? [powerPagesProvider(portal, metadata)] : [], defaultApp: selectedDefault, clientExtensions, settings = {}, canvasApps = null } = {}) {
  const tables = Object.assign({}, ...providers.filter(Boolean).map(provider => structuredClone(provider.tables ?? {})));
  for (const [entity, mapping] of Object.entries(mappings)) {
    if (tables[entity]) continue;
    const exported = metadata.entities?.[entity];
    const fields = { ...mapping.fields, ...mapping.fieldMetadata };
    for (const name of Object.keys(mapping.fieldMetadata ?? {})) if (mapping.fields?.[name] && typeof mapping.fields[name] === 'object') fields[name] = { ...mapping.fieldMetadata[name], ...mapping.fields[name] };
    tables[entity] = { entity, label: exported?.collectionLabel ?? friendly(entity), singular: exported?.label ?? friendly(entity),
      idColumn: mapping.idColumn ?? `${entity}id`, nameColumn: mapping.nameColumn ?? exported?.primaryNameAttribute ?? mapping.idColumn ?? `${entity}id`,
      fields: { ...fields, ...exported?.fields }, source: exported ? 'solution' : 'local-mapping', projected: false };
  }
  for (const table of Object.values(tables)) {
    const exported = metadata.entities?.[table.entity];
    if (exported?.collectionLabel != null) table.label = exported.collectionLabel;
    if (exported?.label != null) table.singular = exported.label;
    if (exported?.grid) table.grid = structuredClone(exported.grid);
    const mapping = mappings[table.entity];
    if (mapping?.entitySet) table.entitySet = mapping.entitySet;
    if (mapping?.relationships) table.relationships = structuredClone(mapping.relationships);
    table.fields = Object.fromEntries(Object.entries(table.fields).map(([name, field]) => [name, typeof field === 'object' && field ? { name, label: friendly(name), ...field } : { name, label: friendly(name), dataverseType: field }]));
    for (const field of Object.values(table.fields)) { field.control = controlDescriptor(field); field.type = field.control.type;
      const mask = String(field.columnMetadata?.displayMask ?? '').trim();
      if (field.columnMetadata?.isLogical === true || mask) field.validForGrid = field.columnMetadata?.isLogical !== true && /(?:^|\|)\s*ValidForGrid\s*(?:\||$)/i.test(mask);
    }
    table.fields[table.idColumn] ??= { name: table.idColumn, label: 'ID', type: 'text', isPrimaryId: true, validForCreate: false, validForUpdate: false };
    table.fields[table.nameColumn] ??= { name: table.nameColumn, label: 'Name', type: 'text' };
    const forms = (metadata.forms ?? []).filter(form => form.entity === table.entity && form.active !== false && (form.systemFormType === undefined || form.systemFormType === 2) && (!form.formType || form.formType === 'main'));
    table.forms = forms.map(form => compileForm(form, table.fields, metadata.lcid)).filter(Boolean);
    table.commands = (metadata.modelDrivenRibbonDocuments ?? []).filter(document => document.entity === table.entity)
      .flatMap(document => parseRibbonCommands(document.xml));
    table.commands.push(...(metadata.modelDrivenAppActions ?? []).filter(command => command.entity === table.entity));
    table.commands = [...new Map(table.commands.map(command => [command.id, command])).values()];
    if (!table.forms.length) table.forms = [{ id: 'generated', name: 'Information', source: 'generated', tabs: [{ id: 'general', label: 'General', visible: true, sections: [{ label: '', fields: Object.values(table.fields).filter(field => !field.isPrimaryId).map(field => ({ name: field.name, label: field.label, supported: true, visible: true })) }] }] }];
    table.views = (metadata.views ?? []).filter(view => view.entity === table.entity && view.queryType === 0).map(view => ({ id: view.id, name: view.name, isDefault: view.isDefault, fields: view.fields, fetchXml: view.fetchXml, source: 'solution' }));
    table.lookupViews = (metadata.views ?? []).filter(view => view.entity === table.entity && view.queryType === 64).map(view => ({ id: view.id, name: view.name, isDefault: view.isDefault, fields: view.fields, fetchXml: view.fetchXml, source: 'solution' }));
    if (!table.views.length) table.views = [{ id: 'active', name: `Active ${table.label}`, isDefault: true, source: 'generated', state: 0 }, { id: 'all', name: `All ${table.label}`, source: 'generated' }, { id: 'inactive', name: `Inactive ${table.label}`, source: 'generated', state: 1 }];
    for (const definitions of [table.views, table.lookupViews]) definitions.sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)) || String(left.name ?? left.id).localeCompare(String(right.name ?? right.id), undefined, { sensitivity: 'base', numeric: true }));
    for (const view of [...table.views, ...table.lookupViews]) view.fields ??= [table.nameColumn, ...Object.keys(table.fields).filter(name => ![table.nameColumn, table.idColumn].includes(name)).slice(0, 5)].map(name => ({ name, width: 180 }));
    yield;
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
    const image = app.iconResourceId && clientExtensions?.resources?.find(resource => resource.type === 'image' && resource.id === app.iconResourceId);
    if (image) app.iconUrl = image.url;
    if (!app.navigation?.length) {
      const names = app.components?.filter(component => component.type === 1).map(component => component.entity).filter(Boolean) ?? [];
      app.navigation = [{ id: 'main', title: app.name ?? app.uniqueName, groups: [{ id: 'tables', title: 'Tables', items: names.map(entity => ({ id: entity, entity, title: tables[entity]?.label ?? entity, supported: Boolean(tables[entity]) })) }] }];
    }
    app.dashboards = (app.dashboards ?? []).map(dashboard => dashboardPage(dashboard, tables));
    // The app's own custom pages (type-300 components), resolved once: SiteMap entries and navigateTo use the same answer.
    app.customPages = Object.fromEntries((app.components ?? []).filter(component => component.type === 300 && component.entity)
      .map(component => [component.entity, customPageResolution(app, component.entity, canvasApps)]));
    for (const area of app.navigation) for (const group of area.groups) for (const item of group.items) {
      if (item.kind === 'custom') { const resolved = customPageResolution(app, item.page, canvasApps); item.supported = resolved.supported; if (resolved.reason) item.reason = resolved.reason; else delete item.reason; }
      // A dashboard page opens its definition, or the app's first dashboard when the SubArea names none (a guess at how native picks the default dashboard).
      if (item.kind === 'dashboard') {
        const dashboard = item.dashboard ? app.dashboards.find(candidate => candidate.id === item.dashboard) : app.dashboards[0];
        if (dashboard) { item.dashboard = dashboard.id; item.supported = true; delete item.reason; item.title ??= dashboard.name; }
      }
      const destination = item.entity && Object.hasOwn(tables, item.entity) ? tables[item.entity] : undefined;
      let viewApplication = app;
      if (item.entity && !destination) { item.supported = false; item.reason = 'This table has no imported metadata or local mapping.'; }
      if (item.kind === 'webresource') {
        const page = webResourcePage(clientExtensions, item.webresource);
        if (page.url) item.url = page.url; else { item.supported = false; item.reason = page.reason; }
      }
      if (item.view && !destination?.views.some(view => view.id === item.view)) { item.supported = false; item.reason = 'This page selects a view that is not imported for its table.'; }
      if (item.applicationId) {
        const targetApp = apps.find(candidate => candidate.idSource !== 'derived-local' && candidate.id?.toLowerCase() === item.applicationId);
        if (targetApp) { item.targetApplicationId = targetApp.id; viewApplication = targetApp; }
        // A missing native AppModuleId produces a synthetic local ID. Its native
        // URL ID cannot prove a mismatch; retain the owning app's local context.
        else if (app.idSource === 'exported') { item.supported = false; item.reason = 'This page selects an application that is not imported.'; }
      }
      if (item.view && destination?.views.some(view => view.id === item.view)) {
        const ids = new Set((viewApplication.components ?? []).filter(component => component.type === 26).map(component => String(component.id ?? '').replace(/[{}]/g, '').toLowerCase()));
        const scoped = destination.views.filter(view => ids.has(String(view.id).replace(/[{}]/g, '').toLowerCase()));
        if (scoped.length && !scoped.some(view => view.id === item.view)) { item.supported = false; item.reason = 'This page selects a view that is not available to its imported application.'; }
      }
      item.title ??= destination?.label ?? item.entity ?? item.id;
    }
  }
  return { version: 1, defaultApp: defaultApp?.id ?? null, apps, tables, ...(clientExtensions ? { clientExtensions } : {}), capabilityRecords: MODEL_DRIVEN_CAPABILITY_RECORDS,
    ...(Number.isInteger(settings.timeZoneOffsetMinutes) && Math.abs(settings.timeZoneOffsetMinutes) <= 1440 && !settings.formattedValueTimeZone ? { formatting: { timeZoneOffsetMinutes: settings.timeZoneOffsetMinutes } } : {}),
    capabilities: { localCrud: true, views: true, search: true, filters: true, columns: true, solutionNavigation: true, relatedSubgrids: true,
      scripts: clientExtensions?.trusted === true, businessProcessFlows: false, customControls: clientExtensions?.trusted === true, reports: false, powerBi: false, flows: false, globalSearch: false, advancedFind: false, classicSettings: false,
      webResourcePages: clientExtensions?.trusted === true, dashboards: true, customPages: Array.isArray(canvasApps), offline: true } };
}

/** The catalogue's `canvasApps` option from an organization host: the canvas host's app names, or null when it is disabled. */
export const canvasAppNames = host => (host?.canvas?.enabled ? host.canvasApps().map(app => app.uniqueName) : null);

export function appCatalogue(options) {
  const steps = catalogueSteps(options);
  let current;
  do { current = steps.next(); } while (!current.done);
  return current.value;
}

/** Same complete catalogue contract with cooperative table construction. Hosts
 * retain their serialized read and may cancel a disconnected HTTP consumer. */
export async function appCatalogueAsync(options, { cancelled = () => false } = {}) {
  const steps = catalogueSteps(options);
  let yieldedAt = performance.now();
  while (true) {
    if (cancelled()) throw Object.assign(new Error('Catalogue request was cancelled.'), { status: 499, code: 'ModelDrivenRequestInvalid' });
    const current = steps.next();
    if (current.done) return current.value;
    if (performance.now() - yieldedAt >= 8) { await setImmediate(); yieldedAt = performance.now(); }
  }
}
