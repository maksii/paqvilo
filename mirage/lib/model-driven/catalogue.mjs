import { copyPlainGraph, plainDataObject } from '../state-clone.mjs';
import { compileForm, parseRibbonCommands, dashboardPage, customPageResolution } from './solution.mjs';
import { powerPagesProvider } from './providers.mjs';
import { controlDescriptor } from './control-descriptors.mjs';
import { child, parseSolutionXml, pickLabel } from '../solution-xml.mjs';
import { sourceRecordId } from '../source-record-id.mjs';
import { setImmediate } from 'node:timers/promises';
import { webResourcePage } from './client-runtime.mjs';
import path from 'node:path';
import { createModelDrivenMetadataIndex } from '../../../lense/model-driven-metadata.mjs';
import { modelDrivenKey, modelDrivenControlKey } from './provenance-registry.mjs';

/** Model-driven features Mirage inventories but does not host, as capability records (name, level, reason, code). */
export const MODEL_DRIVEN_CAPABILITY_RECORDS = Object.freeze([
  Object.freeze({
    name: 'model-driven:offline',
    kind: 'host-surface',
    component: 'model-driven',
    level: 'behaviour',
    code: 'MD_OFFLINE',
    operations: [],
    reason:
      "An app with a Solution mobile offline profile can go offline per staff session: the profile's rows download as the staff user, Xrm.WebApi.offline reads and writes that copy, and going online replays the queued writes through the Web API with conflict detection from the organization setting. The device is simulated; profile filters the simulator cannot evaluate keep a model-driven:offline/<profile> requirement row.",
  }),
  Object.freeze({
    name: 'model-driven:custom-page',
    kind: 'host-surface',
    component: 'model-driven',
    level: 'behaviour',
    code: 'MD_NAV_CUSTOM_PAGE',
    operations: [],
    reason:
      "Custom pages (SiteMap pages and navigateTo with pageType custom) start their canvas app in the headless canvas host as the staff user: App.OnStart and the start screen's OnVisible run with recordId and entityName as Param values, and the shell shows the evaluated screen data. The page is not rendered (canvas:rendering); a page that is not one of the app's own canvas app components (AppModuleComponent type 300) with a canvas app in the canvas host is listed disabled with the failed check, and navigateTo rejects it with CustomPageNotFound.",
  }),
  Object.freeze({
    name: 'model-driven:dashboard',
    kind: 'host-surface',
    component: 'model-driven',
    level: 'behaviour',
    code: 'MD_NAV_DASHBOARD',
    operations: [],
    reason:
      'Solution dashboards (SiteMap pages and navigateTo with pageType dashboard) render their lists over the view query engine as the staff user; charts, web resources, IFRAMEs and other components are listed on the page as unsupported and keep a model-driven:dashboard requirement row.',
  }),
]);

const friendly = (name) =>
  String(name)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
// An app's dashboards: those its SiteMap opens, plus its SystemForm components (type 60, shared with forms); an app
// that names none of the Solution dashboards gets them all (the same rule the shell applies to forms and views).
const appDashboards = (app, dashboards) => {
  const ids = new Set(
    (app.components ?? []).filter((component) => component.type === 60).map((component) => component.id),
  );
  const opened = new Set(
    (app.navigation ?? [])
      .flatMap((area) => area.groups.flatMap((group) => group.items))
      .map((item) => item.dashboard)
      .filter(Boolean),
  );
  const named = dashboards.filter((dashboard) => ids.has(dashboard.id));
  return dashboards.filter((dashboard) => opened.has(dashboard.id) || (named.length ? ids.has(dashboard.id) : true));
};

function shownFile(projectRoot, file) {
  return projectRoot && file && path.isAbsolute(file) ? path.relative(projectRoot, file).replaceAll('\\', '/') : file;
}

function collectSolutionDocument(document, state, projectRoot) {
  for (const record of document.facts.inventory ?? [])
    if (record.component === 'mobileofflineprofile' && Array.isArray(record.items))
      state.profiles.set(record.id ?? record.name.toLowerCase(), {
        id: record.id,
        name: record.name,
        items: record.items,
        sourceFile: shownFile(projectRoot, document.file),
      });
  for (const app of document.facts.apps ?? []) {
    const key = app.uniqueName ?? app.id;
    state.apps.set(key, {
      ...state.apps.get(key),
      ...app,
      id: app.id || sourceRecordId('appmodule', app.uniqueName),
      idSource: app.id ? 'exported' : 'derived-local',
      source: 'solution',
      sourceFile: shownFile(projectRoot, document.file),
      sourceIdentityFile: document.file,
    });
  }
  state.maps.push(
    ...(document.facts.appMaps ?? []).map((map) => ({
      ...map,
      sourceFile: shownFile(projectRoot, document.file),
      sourceIdentityFile: document.file,
    })),
  );
  for (const dashboard of document.facts.dashboards ?? [])
    state.dashboards.set(dashboard.id, {
      ...dashboard,
      sourceFile: shownFile(projectRoot, document.file),
      sourceIdentityFile: document.file,
    });
}

function componentMatchesMap(app, map) {
  return app.components?.some(
    (component) => component.type === 62 && component.entity === map.uniqueName.toLowerCase(),
  );
}

function mapMatchesApp(app, map) {
  return (
    (map.uniqueName && app.uniqueName && map.uniqueName.toLowerCase() === app.uniqueName.toLowerCase()) ||
    (map.appId && map.appId === app.id) ||
    (map.uniqueName && componentMatchesMap(app, map))
  );
}

function profilesForApp(app, profiles) {
  return [...profiles.values()].filter((profile) =>
    (app.components ?? []).some(
      (component) =>
        component.type === 161 &&
        ((component.id && component.id === profile.id) ||
          (component.entity && component.entity === profile.name.toLowerCase())),
    ),
  );
}

function localizedNavigation(areas, lcid) {
  return (areas ?? []).map((area) => ({
    ...area,
    title: pickLabel(area.titleLabels, lcid) ?? area.title,
    groups: area.groups.map((group) => ({
      ...group,
      title: pickLabel(group.titleLabels, lcid) ?? group.title,
      items: group.items.map((item) => ({ ...item, title: pickLabel(item.titleLabels, lcid) ?? item.title })),
    })),
  }));
}

function localizedApp(app, lcid, state) {
  return {
    ...app,
    name: pickLabel(app.nameLabels, lcid) ?? app.name,
    description: pickLabel(app.descriptionLabels, lcid) ?? app.description,
    navigation: localizedNavigation(app.navigation, lcid),
    dashboards: appDashboards(app, [...state.dashboards.values()]),
    // The profiles the app names (AppModuleComponent type 161 by id or schema name); an app without one cannot go offline.
    offlineProfiles: profilesForApp(app, state.profiles),
  };
}

export function solutionApps(scan, { lcid = 1033, projectRoot = null } = {}) {
  const state = { apps: new Map(), maps: [], dashboards: new Map(), profiles: new Map() };
  for (const layer of scan.layers ?? [])
    for (const document of layer.documents ?? []) collectSolutionDocument(document, state, projectRoot);
  for (const app of state.apps.values()) {
    const map = state.maps.findLast((candidate) => mapMatchesApp(app, candidate));
    if (map) {
      app.navigation = map.navigation;
      app.navigationSourceFile = map.sourceFile;
      app.navigationIdentityFile = map.sourceIdentityFile;
    }
  }
  return [...state.apps.values()].map((app) => localizedApp(app, lcid, state));
}

// Parsed commands per ribbon document object, reused while its XML and the language stay the same.
const ribbonCache = new WeakMap();
const ribbonCommands = (document, lcid) => {
  const cached = ribbonCache.get(document);
  if (cached?.xml === document.xml && cached.lcid === lcid) return cached.commands;
  const commands = parseRibbonCommands(document.xml, { lcid });
  ribbonCache.set(document, { xml: document.xml, lcid, commands });
  return commands;
};
// Items grouped by their entity once, in source order: a per-table filter over every form and view is O(tables × items).
const byEntity = (items) => {
  const grouped = new Map();
  for (const item of items ?? []) {
    const list = grouped.get(item.entity);
    if (list) list.push(item);
    else grouped.set(item.entity, [item]);
  }
  return grouped;
};
const NONE = Object.freeze([]);

function prepareTableDefinition(table, metadata, mappings, lazy) {
  const exported = metadata.entities?.[table.entity];
  if (exported?.collectionLabel != null) table.label = exported.collectionLabel;
  if (exported?.label != null) table.singular = exported.label;
  if (exported?.grid) table.grid = structuredClone(exported.grid);
  const mapping = mappings[table.entity];
  if (mapping?.entitySet) table.entitySet = mapping.entitySet;
  if (mapping?.relationships && !lazy) table.relationships = copyPlainGraph(mapping.relationships);
  if (!lazy) decorateTableFields(table);
  table.fields[table.idColumn] ??= {
    name: table.idColumn,
    label: 'ID',
    type: 'text',
    isPrimaryId: true,
    validForCreate: false,
    validForUpdate: false,
  };
  table.fields[table.nameColumn] ??= { name: table.nameColumn, label: 'Name', type: 'text' };
}

function decorateTableFields(table) {
  table.fields = Object.fromEntries(
    Object.entries(table.fields).map(([name, field]) => [
      name,
      typeof field === 'object' && field
        ? { name, label: friendly(name), ...field }
        : { name, label: friendly(name), dataverseType: field },
    ]),
  );
  for (const field of Object.values(table.fields)) {
    field.control = controlDescriptor(field);
    field.type = field.control.type;
    const mask = String(field.columnMetadata?.displayMask ?? '').trim();
    if (field.columnMetadata?.isLogical === true || mask)
      field.validForGrid = field.columnMetadata?.isLogical !== true && /(?:^|\|)\s*ValidForGrid\s*(?:\||$)/i.test(mask);
  }
}

function prepareTableFormsAndCommands(table, metadata, lazy, formsOf, ribbonsOf, actionsOf) {
  const forms = (lazy ? NONE : (formsOf.get(table.entity) ?? NONE)).filter(
    (form) =>
      form.active !== false &&
      (form.systemFormType === undefined || form.systemFormType === 2) &&
      (!form.formType || form.formType === 'main'),
  );
  table.forms = forms.map((form) => compileForm(form, table.fields, metadata.lcid)).filter(Boolean);
  table.commands = (ribbonsOf.get(table.entity) ?? NONE).flatMap((document) => ribbonCommands(document, metadata.lcid));
  table.commands.push(...(actionsOf.get(table.entity) ?? NONE));
  table.commands = [...new Map(table.commands.map((command) => [command.id, command])).values()];
  if (!table.forms.length && !lazy) table.forms = [generatedForm(table.fields)];
}

function generatedForm(fields) {
  return {
    id: 'generated',
    name: 'Information',
    source: 'generated',
    tabs: [
      {
        id: 'general',
        label: 'General',
        visible: true,
        sections: [
          {
            label: '',
            fields: Object.values(fields)
              .filter((field) => !field.isPrimaryId)
              .map((field) => ({ name: field.name, label: field.label, supported: true, visible: true })),
          },
        ],
      },
    ],
  };
}

// A condition is a find column under a filter marked isquickfindfields="1", or when it is marked itself.
function quickFindAttributes(node, flagged = false) {
  return node.children.flatMap((item) => {
    if (item.name === 'condition') return flagged || item.attrs.isquickfindfields === '1' ? [item.attrs.attribute] : [];
    if (item.name !== 'filter') return [];
    return quickFindAttributes(item, flagged || item.attrs.isquickfindfields === '1');
  });
}

function quickFindColumnsOf(view, table) {
  const entity = child(parseSolutionXml(view.fetchXml, { recover: true }), 'entity');
  if (!entity) return [];
  return [...new Set(quickFindAttributes(entity))].filter((name) => Object.hasOwn(table.fields, name));
}

function prepareTableViews(table, viewsOf) {
  const views = viewsOf.get(table.entity) ?? NONE;
  const quickFind = views.find((view) => view.queryType === 4 && view.fetchXml);
  const quickFindColumns = quickFind ? quickFindColumnsOf(quickFind, table) : [];
  if (quickFindColumns.length) table.quickFindColumns = quickFindColumns;
  table.views = views
    .filter((view) => view.queryType === 0)
    .map((view) => ({
      id: view.id,
      name: view.name,
      isDefault: view.isDefault,
      fields: view.fields,
      fetchXml: view.fetchXml,
      source: 'solution',
    }));
  table.lookupViews = views
    .filter((view) => view.queryType === 64)
    .map((view) => ({
      id: view.id,
      name: view.name,
      isDefault: view.isDefault,
      fields: view.fields,
      fetchXml: view.fetchXml,
      source: 'solution',
    }));
  if (!table.views.length)
    table.views = [
      { id: 'active', name: `Active ${table.label}`, isDefault: true, source: 'generated', state: 0 },
      { id: 'all', name: `All ${table.label}`, source: 'generated' },
      { id: 'inactive', name: `Inactive ${table.label}`, source: 'generated', state: 1 },
    ];
  for (const definitions of [table.views, table.lookupViews])
    definitions.sort(
      (left, right) =>
        Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)) ||
        String(left.name ?? left.id).localeCompare(String(right.name ?? right.id), undefined, {
          sensitivity: 'base',
          numeric: true,
        }),
    );
  for (const view of [...table.views, ...table.lookupViews])
    view.fields ??= [
      table.nameColumn,
      ...Object.keys(table.fields)
        .filter((name) => ![table.nameColumn, table.idColumn].includes(name))
        .slice(0, 5),
    ].map((name) => ({ name, width: 180 }));
}

function collectSectionSourceKeys(form, section, sourceKeys) {
  sourceKeys.push(
    modelDrivenKey('section', `${form.id}:${section.sourceStructure?.id ?? section.name ?? section.column}`),
  );
  for (const cell of section.fields ?? []) {
    if (cell.spacer) continue;
    sourceKeys.push(modelDrivenControlKey(form.id, cell.sourceControl ?? cell.name));
    if (cell.pcf) sourceKeys.push(modelDrivenKey('pcf', cell.pcf.name));
  }
}

function collectFormSourceKeys(form, sourceKeys) {
  sourceKeys.push(modelDrivenKey('form', form.id));
  for (const tab of form.tabs ?? []) {
    sourceKeys.push(modelDrivenKey('tab', `${form.id}:${tab.id}`));
    for (const section of tab.sections ?? []) collectSectionSourceKeys(form, section, sourceKeys);
  }
  for (const control of form.regionControls ?? [])
    sourceKeys.push(modelDrivenControlKey(form.id, control.sourceControl ?? control.id, control.region));
}

function tableSourceKeys(table, lazy) {
  const sourceKeys = lazy
    ? []
    : [
        modelDrivenKey('table', table.entity),
        ...Object.keys(table.fields).map((name) => modelDrivenKey('column', `${table.entity}:${name}`)),
        ...[...table.views, ...table.lookupViews].map((view) => modelDrivenKey('view', view.id)),
        ...table.commands.map((command) => modelDrivenKey('command', `${table.entity}:${command.id}`)),
      ];
  for (const form of table.forms) collectFormSourceKeys(form, sourceKeys);
  return sourceKeys;
}

function compileCatalogueTable(table, context) {
  const { metadata, mappings, lazy, formsOf, ribbonsOf, actionsOf, viewsOf, provenanceIndex } = context;
  prepareTableDefinition(table, metadata, mappings, lazy);
  prepareTableFormsAndCommands(table, metadata, lazy, formsOf, ribbonsOf, actionsOf);
  prepareTableViews(table, viewsOf);
  const sourceKeys = tableSourceKeys(table, lazy);
  table.provenanceRefs = lazy ? [] : provenanceIndex.sourceRefsFor(sourceKeys);
}

function findAppOverride(imported, builtin) {
  return imported.find(
    (app) => app.id === builtin.id || app.uniqueName?.toLowerCase() === builtin.uniqueName?.toLowerCase(),
  );
}

function isImportedApp(apps, app) {
  return apps.some(
    (existing) => existing.id === app.id || (existing.uniqueName && existing.uniqueName === app.uniqueName),
  );
}

function mergeCatalogueApps(providers, imported) {
  const apps = [];
  for (const builtin of providers.filter(Boolean).flatMap((provider) => provider.apps ?? [])) {
    const override = findAppOverride(imported, builtin);
    apps.push(
      override
        ? {
            ...builtin,
            ...override,
            navigation: override.navigation?.length ? override.navigation : builtin.navigation,
          }
        : structuredClone(builtin),
    );
  }
  for (const app of imported) if (!isImportedApp(apps, app)) apps.push(app);
  return apps;
}

function selectDefaultApp(apps, providers, selectedDefault) {
  const providerDefault = providers.find((provider) => provider?.defaultApp)?.defaultApp;
  const defaultApp = selectedDefault
    ? apps.find((app) => app.id?.toLowerCase() === selectedDefault.toLowerCase())
    : (apps.find((app) => app.id === providerDefault) ?? apps[0]);
  if (selectedDefault && !defaultApp) throw new Error(`Default application '${selectedDefault}' is not imported.`);
  return defaultApp;
}

function resolveCustomNavigation(app, item, canvasApps) {
  if (item.kind !== 'custom') return;
  const resolved = customPageResolution(app, item.page, canvasApps);
  item.supported = resolved.supported;
  if (resolved.reason) item.reason = resolved.reason;
  else delete item.reason;
}

function resolveDashboardNavigation(app, item) {
  if (item.kind !== 'dashboard') return;
  const dashboard = item.dashboard
    ? app.dashboards.find((candidate) => candidate.id === item.dashboard)
    : app.dashboards[0];
  if (!dashboard) return;
  item.dashboard = dashboard.id;
  item.supported = true;
  delete item.reason;
  item.title ??= dashboard.name;
}

function resolveNavigationResource(item, clientExtensions) {
  if (item.kind !== 'webresource') return;
  const page = webResourcePage(clientExtensions, item.webresource);
  if (page.url) item.url = page.url;
  else {
    item.supported = false;
    item.reason = page.reason;
  }
}

function navigationDestination(item, tables) {
  return item.entity && Object.hasOwn(tables, item.entity) ? tables[item.entity] : undefined;
}

function resolveDestinationErrors(item, destination) {
  if (item.entity && !destination) {
    item.supported = false;
    item.reason = 'This table has no imported metadata or local mapping.';
  }
}

function resolveViewError(item, destination) {
  if (item.view && !destination?.views.some((view) => view.id === item.view)) {
    item.supported = false;
    item.reason = 'This page selects a view that is not imported for its table.';
  }
}

function navigationApplication(app, item, apps) {
  if (!item.applicationId) return app;
  const targetApp = apps.find(
    (candidate) => candidate.idSource !== 'derived-local' && candidate.id?.toLowerCase() === item.applicationId,
  );
  if (targetApp) {
    item.targetApplicationId = targetApp.id;
    return targetApp;
  }
  // A missing native AppModuleId produces a synthetic local ID. Its native
  // URL ID cannot prove a mismatch; retain the owning app's local context.
  if (app.idSource === 'exported') {
    item.supported = false;
    item.reason = 'This page selects an application that is not imported.';
  }
  return app;
}

function resolveScopedView(item, destination, viewApplication) {
  if (!item.view || !destination?.views.some((view) => view.id === item.view)) return;
  const ids = new Set(
    (viewApplication.components ?? [])
      .filter((component) => component.type === 26)
      .map((component) =>
        String(component.id ?? '')
          .replace(/[{}]/g, '')
          .toLowerCase(),
      ),
  );
  const scoped = destination.views.filter((view) => ids.has(String(view.id).replace(/[{}]/g, '').toLowerCase()));
  if (scoped.length && !scoped.some((view) => view.id === item.view)) {
    item.supported = false;
    item.reason = 'This page selects a view that is not available to its imported application.';
  }
}

function prepareNavigationItem(app, item, tables, apps, clientExtensions, canvasApps) {
  resolveCustomNavigation(app, item, canvasApps);
  resolveDashboardNavigation(app, item);
  const destination = navigationDestination(item, tables);
  resolveDestinationErrors(item, destination);
  resolveNavigationResource(item, clientExtensions);
  resolveViewError(item, destination);
  const viewApplication = navigationApplication(app, item, apps);
  resolveScopedView(item, destination, viewApplication);
  item.title ??= destination?.label ?? item.entity ?? item.id;
}

function fallbackNavigation(app, tables) {
  const names =
    app.components
      ?.filter((component) => component.type === 1)
      .map((component) => component.entity)
      .filter(Boolean) ?? [];
  return [
    {
      id: 'main',
      title: app.name ?? app.uniqueName,
      groups: [
        {
          id: 'tables',
          title: 'Tables',
          items: names.map((entity) => ({
            id: entity,
            entity,
            title: tables[entity]?.label ?? entity,
            supported: Boolean(tables[entity]),
          })),
        },
      ],
    },
  ];
}

function prepareAppNavigation(app, tables, apps, clientExtensions, canvasApps) {
  if (!app.navigation?.length) app.navigation = fallbackNavigation(app, tables);
  for (const area of app.navigation)
    for (const group of area.groups)
      for (const item of group.items) prepareNavigationItem(app, item, tables, apps, clientExtensions, canvasApps);
}

function prepareCatalogueApp(app, tables, apps, clientExtensions, canvasApps) {
  const image =
    app.iconResourceId &&
    clientExtensions?.resources?.find((resource) => resource.type === 'image' && resource.id === app.iconResourceId);
  if (image) app.iconUrl = image.url;
  app.dashboards = (app.dashboards ?? []).map((dashboard) => dashboardPage(dashboard, tables));
  // The app's own custom pages (type-300 components), resolved once: SiteMap entries and navigateTo use the same answer.
  app.customPages = Object.fromEntries(
    (app.components ?? [])
      .filter((component) => component.type === 300 && component.entity)
      .map((component) => [component.entity, customPageResolution(app, component.entity, canvasApps)]),
  );
  prepareAppNavigation(app, tables, apps, clientExtensions, canvasApps);
}

function lazyProviderInput(provider, name) {
  return {
    id: provider.id,
    apps: [],
    tables: Object.hasOwn(provider.tables ?? {}, name) ? { [name]: provider.tables[name] } : {},
  };
}

function lazyMetadataInput(name, sources) {
  const { metadata, formsOf, viewsOf, ribbonsOf, actionsOf } = sources;
  return {
    lcid: metadata.lcid,
    entities: Object.hasOwn(metadata.entities ?? {}, name) ? { [name]: metadata.entities[name] } : {},
    forms: formsOf.get(name) ?? [],
    views: viewsOf.get(name) ?? [],
    modelDrivenRibbonDocuments: ribbonsOf.get(name) ?? [],
    modelDrivenAppActions: actionsOf.get(name) ?? [],
    modelDrivenApps: [],
  };
}

function lazyTableInput(name, sources) {
  const { providers, mappings } = sources;
  return {
    rootProvenance: false,
    providers: providers.filter(Boolean).map((provider) => lazyProviderInput(provider, name)),
    mappings: Object.hasOwn(mappings, name) ? { [name]: mappings[name] } : {},
    metadata: lazyMetadataInput(name, sources),
  };
}

function prepareLazyCatalogue({
  result,
  tables,
  providers,
  mappings,
  metadata,
  formsOf,
  viewsOf,
  ribbonsOf,
  actionsOf,
  settings,
  clientExtensions,
  canvasApps,
}) {
  const index = tables,
    bodies = {},
    cached = new Map(),
    recent = new Map();
  const compilationContext = {
    clientExtensions,
    settings: {
      timeZoneOffsetMinutes: settings.timeZoneOffsetMinutes,
      formattedValueTimeZone: settings.formattedValueTimeZone,
    },
    canvasApps,
    sourceRevisions: metadata.sourceRevisions,
  };
  const tableSources = { providers, mappings, metadata, formsOf, viewsOf, ribbonsOf, actionsOf };
  const tableInput = (name) => lazyTableInput(name, tableSources);
  // The lightweight index retains every table and navigation item. A table
  // body is compiled on first access, including data/lookup access; a complete
  // API response still enumerates and compiles every body cooperatively.
  for (const name of Object.keys(index))
    Object.defineProperty(bodies, name, {
      enumerable: true,
      configurable: true,
      get() {
        // Retain identity while a caller holds the body, without retaining all
        // compiled forms after a complete streamed catalogue has passed. The
        // few most recent bodies stay strongly held across garbage collection.
        let value = recent.get(name) ?? cached.get(name)?.deref();
        if (!value) {
          value = compileTable(tableInput(name), compilationContext, name);
          cached.set(name, new WeakRef(value));
        }
        recent.delete(name);
        recent.set(name, value);
        if (recent.size > RECENT_BODIES) recent.delete(recent.keys().next().value);
        return value;
      },
    });
  Object.defineProperty(result, 'tableIndex', { value: index });
  Object.defineProperty(result, 'tableInput', { value: tableInput });
  Object.defineProperty(result, 'compilationContext', { value: compilationContext });
  result.tables = bodies;
}

function dashboardSourceRefs(dashboard) {
  return [
    modelDrivenKey('dashboard', dashboard.id),
    ...(dashboard.components ?? []).map(
      (component) => `dashboard-${modelDrivenControlKey(dashboard.id, component.sourceControl ?? component.id)}`,
    ),
  ];
}

function appDashboardSourceRefs(app) {
  return (app.dashboards ?? []).flatMap(dashboardSourceRefs);
}

function navigationAreaSourceRefs(app, area) {
  return area.groups.flatMap((group) =>
    group.items.map((item) => modelDrivenKey('navigation', `${app.id ?? app.uniqueName}:${item.id}`)),
  );
}

function appNavigationSourceRefs(app) {
  return [
    modelDrivenKey('app', app.id),
    ...(app.navigation ?? []).flatMap((area) => navigationAreaSourceRefs(app, area)),
  ];
}

function catalogueProvenanceRefs(include, provenanceIndex, clientExtensions, apps) {
  return include
    ? provenanceIndex.sourceRefsFor([
        ...(clientExtensions?.resources ?? []).map((resource) => modelDrivenKey('resource', resource.name)),
        ...apps.flatMap(appDashboardSourceRefs),
        ...apps.flatMap(appNavigationSourceRefs),
      ])
    : [];
}

function catalogueFormatting(settings) {
  return Number.isInteger(settings.timeZoneOffsetMinutes) &&
    Math.abs(settings.timeZoneOffsetMinutes) <= 1440 &&
    !settings.formattedValueTimeZone
    ? { formatting: { timeZoneOffsetMinutes: settings.timeZoneOffsetMinutes } }
    : {};
}

function mergeMappingFields(mapping, fields) {
  for (const name of Object.keys(mapping.fieldMetadata ?? {}))
    if (mapping.fields?.[name] && typeof mapping.fields[name] === 'object')
      fields[name] = { ...mapping.fieldMetadata[name], ...mapping.fields[name] };
}

function mappedTable(entity, mapping, exported, fields) {
  return {
    entity,
    label: exported?.collectionLabel ?? friendly(entity),
    singular: exported?.label ?? friendly(entity),
    idColumn: mapping.idColumn ?? `${entity}id`,
    nameColumn: mapping.nameColumn ?? exported?.primaryNameAttribute ?? mapping.idColumn ?? `${entity}id`,
    fields: plainDataObject(fields, exported?.fields),
    source: exported ? 'solution' : 'local-mapping',
    projected: false,
  };
}

function createCatalogueTables(providers, mappings, metadata) {
  const tables = Object.assign(
    {},
    ...providers.filter(Boolean).map((provider) => copyPlainGraph(provider.tables ?? {})),
  );
  for (const [entity, mapping] of Object.entries(mappings)) {
    if (tables[entity]) continue;
    const exported = metadata.entities?.[entity];
    const fields = plainDataObject(mapping.fields, mapping.fieldMetadata);
    mergeMappingFields(mapping, fields);
    tables[entity] = mappedTable(entity, mapping, exported, fields);
  }
  return tables;
}

/** Stable JSON contract consumed by the shell. */
function* catalogueSteps({
  portal,
  metadata = {},
  mappings = {},
  providers = portal ? [powerPagesProvider(portal, metadata)] : [],
  defaultApp: selectedDefault,
  clientExtensions,
  settings = {},
  canvasApps = null,
  lazy = false,
  rootProvenance = true,
} = {}) {
  const provenanceIndex = createModelDrivenMetadataIndex(
    {
      metadata: lazy ? { ...metadata, entities: {}, forms: [], views: [] } : metadata,
      apps: metadata.modelDrivenApps ?? [],
      pcf: clientExtensions?.pcf,
      resources: clientExtensions?.resources,
      ribbonDocuments: metadata.modelDrivenRibbonDocuments ?? [],
      appActions: metadata.modelDrivenAppActions ?? [],
    },
    { sourceRevision: 'render' },
  );
  const formsOf = byEntity(metadata.forms),
    viewsOf = byEntity(metadata.views),
    ribbonsOf = byEntity(metadata.modelDrivenRibbonDocuments),
    actionsOf = byEntity(metadata.modelDrivenAppActions);
  const tables = createCatalogueTables(providers, mappings, metadata);
  const tableContext = { metadata, mappings, lazy, formsOf, ribbonsOf, actionsOf, viewsOf, provenanceIndex };
  for (const table of Object.values(tables)) {
    compileCatalogueTable(table, tableContext);
    yield;
  }
  const imported = structuredClone(metadata.modelDrivenApps ?? []);
  const apps = mergeCatalogueApps(providers, imported);
  const defaultApp = selectDefaultApp(apps, providers, selectedDefault);
  for (const app of apps) prepareCatalogueApp(app, tables, apps, clientExtensions, canvasApps);
  const result = {
    version: 1,
    defaultApp: defaultApp?.id ?? null,
    apps,
    tables,
    provenanceRefs: catalogueProvenanceRefs(rootProvenance, provenanceIndex, clientExtensions, apps),
    ...(clientExtensions ? { clientExtensions } : {}),
    capabilityRecords: MODEL_DRIVEN_CAPABILITY_RECORDS,
    ...catalogueFormatting(settings),
    capabilities: {
      localCrud: true,
      views: true,
      search: true,
      filters: true,
      columns: true,
      solutionNavigation: true,
      relatedSubgrids: true,
      scripts: clientExtensions?.trusted === true,
      businessProcessFlows: false,
      customControls: clientExtensions?.trusted === true,
      reports: false,
      powerBi: false,
      flows: false,
      globalSearch: false,
      advancedFind: false,
      classicSettings: false,
      webResourcePages: clientExtensions?.trusted === true,
      dashboards: true,
      customPages: Array.isArray(canvasApps),
      offline: true,
    },
  };
  if (lazy)
    prepareLazyCatalogue({
      result,
      tables,
      providers,
      mappings,
      metadata,
      formsOf,
      viewsOf,
      ribbonsOf,
      actionsOf,
      settings,
      clientExtensions,
      canvasApps,
    });
  return result;
}

// Strongly held compiled bodies per catalogue: grids, records and lookups reopen the same few tables.
const RECENT_BODIES = 16;

/** One table body of a lazy catalogue from its tableInput and compilationContext. This nested
 * call does not reopen root resources or apps: that would make a complete response O(tables × resources). */
export const compileTable = (input, context, name) =>
  appCatalogue({
    ...input,
    ...context,
    metadata: { ...input.metadata, sourceRevisions: context.sourceRevisions },
  }).tables[name];

/** The catalogue's `canvasApps` option from an organization host: the canvas host's app names, or null when it is disabled. */
export const canvasAppNames = (host) => (host?.canvas?.enabled ? host.canvasApps().map((app) => app.uniqueName) : null);

export function appCatalogue(options) {
  const steps = catalogueSteps(options);
  let current;
  do {
    current = steps.next();
  } while (!current.done);
  return current.value;
}

/** Same complete catalogue contract with cooperative table construction. Hosts
 * retain their serialized read and may cancel a disconnected HTTP consumer. */
export async function appCatalogueAsync(options, { cancelled = () => false } = {}) {
  const steps = catalogueSteps(options);
  let yieldedAt = performance.now();
  while (true) {
    if (cancelled())
      throw Object.assign(new Error('Catalogue request was cancelled.'), {
        status: 499,
        code: 'ModelDrivenRequestInvalid',
      });
    const current = steps.next();
    if (current.done) return current.value;
    if (performance.now() - yieldedAt >= 8) {
      await setImmediate();
      yieldedAt = performance.now();
    }
  }
}
