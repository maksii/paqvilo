import { compileForm, parseRibbonCommands } from '../mirage/lib/model-driven/solution.mjs';
import { redactText } from './agent-server.mjs';

const MAX_ITEMS = 200;
const MAX_BYTES = 256 * 1024;
const clean = (value) => redactText(value, 500);
const norm = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

const FORM_TYPES = {
  0: 'dashboard',
  2: 'main',
  5: 'mobile',
  6: 'quick view',
  7: 'quick create',
  11: 'card',
  12: 'main (interactive)',
};
const VIEW_TYPES = { 0: 'public', 1: 'advanced find', 2: 'associated', 4: 'quick find', 64: 'lookup' };
// A form control as Lense names it: a bound column, a subgrid, a code component (PCF), a web resource or another native control.
const WEB_RESOURCE_CLASS = '9fdf5f91-88b1-47f4-ad53-c11efc01a01d',
  QUICK_VIEW_CLASS = '5c5600e0-1d6e-4205-a272-be80da87fd42';
function controlOf(field) {
  const classId = norm(field.sourceControl?.classId);
  const kind = field.subgrid
    ? 'subgrid'
    : field.pcf
      ? 'pcf'
      : classId === WEB_RESOURCE_CLASS
        ? 'web-resource'
        : classId === QUICK_VIEW_CLASS
          ? 'quick-view'
          : field.name
            ? 'field'
            : 'other';
  return {
    kind,
    name: clean(field.name ?? ''),
    id: clean(field.sourceControl?.id),
    label: clean(field.label),
    ...(field.pcf ? { pcf: { name: clean(field.pcf.name) } } : {}),
    ...(field.subgrid
      ? {
          subgrid: {
            entity: clean(field.subgrid.entity),
            view: norm(field.subgrid.view),
            relationship: clean(field.subgrid.relationship),
          },
        }
      : {}),
  };
}

/**
 * Data-only provenance from the same Solution facts Mirage builds its model-driven apps from: tables with their typed
 * columns and Entity.xml source, forms by type with their bound controls and subgrids, views, apps and their navigation,
 * and ribbon commands. Everything is bounded (items and bytes) before it reaches the page.
 */
export function modelDrivenInspectionCatalogue(imported) {
  const forms = new Map(),
    commands = new Map(),
    tables = new Map(),
    views = new Map(),
    apps = new Map();
  let bytes = 0,
    remaining = 1000,
    inspectedForms = 0,
    inspectedRibbons = 0,
    inspectedCommands = 0,
    truncated = false;
  const consume = (rows) => {
    const count = Math.min(rows.length, MAX_ITEMS, remaining);
    remaining -= count;
    if (count < rows.length) truncated = true;
    return rows.slice(0, count);
  };
  const admit = (collection, key, value) => {
    const size = Buffer.byteLength(JSON.stringify(value)),
      previous = collection.get(key);
    const available = MAX_BYTES - bytes + (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0);
    if ((!collection.has(key) && collection.size >= MAX_ITEMS) || size > available) {
      truncated = true;
      return;
    }
    bytes += size - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0);
    collection.set(key, value);
  };
  const metadata = imported.metadata ?? {};
  const entities = metadata.entities ?? {};
  // Forms come from the metadata when the import read it (typed columns), else from the scanned documents (tests, older callers).
  const formDefinitions =
    metadata.forms ??
    (imported.layers ?? []).flatMap((layer) =>
      (layer.documents ?? []).flatMap((doc) =>
        (doc.facts?.appComponents?.forms ?? []).map((form) => ({ ...form, file: form.file ?? doc.file })),
      ),
    );
  for (const form of formDefinitions) {
    if (++inspectedForms > MAX_ITEMS) {
      truncated = true;
      continue;
    }
    if ((forms.size >= MAX_ITEMS && !forms.has(norm(form.id))) || !form.xml || form.xml.length > 2 * 1024 * 1024) {
      truncated = true;
      continue;
    }
    try {
      const compiled = compileForm(form, entities[form.entity]?.fields ?? {});
      if (!compiled) continue;
      const controls = [];
      for (const tab of compiled.tabs)
        for (const section of tab.sections)
          for (const field of section.fields) {
            if (field.spacer) continue;
            if (remaining < 1 || controls.length >= MAX_ITEMS) {
              truncated = true;
              break;
            }
            remaining--;
            controls.push(controlOf(field));
          }
      const type = form.formType ?? FORM_TYPES[form.systemFormType] ?? 'main';
      admit(forms, norm(form.id), {
        id: norm(form.id),
        entity: clean(form.entity),
        name: clean(form.name),
        type: clean(type),
        source: clean(form.file ?? form.source),
        libraries: consume(compiled.libraries).map(clean),
        events: consume(compiled.clientEvents).map((event) => ({
          name: clean(event.name),
          attribute: clean(event.attribute),
          active: event.active,
          handlers: consume(event.handlers).map((handler) => ({
            library: clean(handler.library),
            functionName: clean(handler.functionName),
            enabled: handler.enabled,
          })),
        })),
        controls,
      });
    } catch {
      /* Import diagnostics already identify malformed Solution components. */
    }
  }
  // Tables a form, view or app uses come first, so the bound keeps the ones the apps show.
  const used = new Set(
    [...forms.values()]
      .flatMap((form) => [form.entity, ...form.controls.map((control) => control.subgrid?.entity)])
      .filter(Boolean),
  );
  for (const app of imported.apps ?? [])
    for (const area of app.navigation ?? [])
      for (const group of area.groups ?? [])
        for (const item of group.items ?? []) if (item.entity) used.add(item.entity);
  const tableOrder = Object.keys(entities).sort(
    (a, b) => Number(used.has(b)) - Number(used.has(a)) || a.localeCompare(b),
  );
  for (const logicalName of tableOrder) {
    const entity = entities[logicalName],
      fields = Object.values(entity.fields ?? {});
    const columns = consume(fields).map((field) => ({
      name: clean(field.name),
      label: clean(field.label),
      type: clean(field.dataverseType ?? field.type),
      ...(field.requiredLevel && field.requiredLevel !== 'none' ? { required: clean(field.requiredLevel) } : {}),
      ...(field.maxLength ? { maxLength: field.maxLength } : {}),
      ...(field.targets?.length ? { targets: field.targets.slice(0, 8).map(clean) } : {}),
      ...(field.isPrimaryId ? { primaryId: true } : {}),
      ...(field.isPrimaryName ? { primaryName: true } : {}),
      source: clean(field.source),
    }));
    admit(tables, logicalName, {
      logicalName: clean(logicalName),
      label: clean(entity.label),
      collectionLabel: clean(entity.collectionLabel),
      entitySet: clean(entity.entitySet),
      primaryId: clean(entity.primaryIdAttribute),
      primaryName: clean(entity.primaryNameAttribute),
      source: clean(entity.sources?.[0]),
      fieldCount: fields.length,
      columns,
    });
  }
  for (const view of metadata.views ?? []) {
    if (views.size >= MAX_ITEMS) {
      truncated = true;
      break;
    }
    admit(views, norm(view.id), {
      id: norm(view.id),
      entity: clean(view.entity),
      name: clean(view.name),
      type: clean(VIEW_TYPES[view.queryType] ?? `query type ${view.queryType}`),
      isDefault: Boolean(view.isDefault),
      columns: consume(view.fields ?? []).map((field) => clean(field.name)),
      source: clean(view.file),
    });
  }
  for (const app of imported.apps ?? []) {
    const navigation = (app.navigation ?? []).flatMap((area) =>
      (area.groups ?? []).flatMap((group) =>
        (group.items ?? []).map((item) => ({
          title: clean(item.title),
          entity: clean(item.entity),
          area: clean(area.title),
        })),
      ),
    );
    admit(apps, app.uniqueName ?? app.id, {
      id: norm(app.id),
      uniqueName: clean(app.uniqueName),
      name: clean(app.name),
      source: clean(app.sourceFile),
      navigation: consume(navigation),
    });
  }
  const command = (entry) => {
    if (++inspectedCommands > MAX_ITEMS) {
      truncated = true;
      return;
    }
    admit(commands, `${entry.entity}:${entry.id}`, {
      id: clean(entry.id),
      entity: clean(entry.entity),
      label: clean(entry.label),
      supported: entry.supported,
      source: clean(entry.source),
      locations: (entry.locations ?? []).slice(0, 4).map(clean),
      nativeControlIds: (entry.nativeControlIds ?? []).slice(0, 4).map((value) => redactText(value, 1200)),
      actions: consume(entry.actions ?? []).map((action) => ({
        library: clean(action.library),
        functionName: clean(action.functionName),
      })),
    });
  };
  for (const document of imported.ribbonDocuments ?? []) {
    if (inspectedCommands >= MAX_ITEMS) {
      truncated = true;
      break;
    }
    if (++inspectedRibbons > MAX_ITEMS) {
      truncated = true;
      continue;
    }
    if (document.xml?.length > 2 * 1024 * 1024) {
      truncated = true;
      continue;
    }
    try {
      for (const entry of parseRibbonCommands(document.xml))
        command({ ...entry, entity: document.entity, source: document.source });
    } catch {
      /* Preserve the other declared sources if a ribbon cannot be inspected. */
    }
  }
  for (const entry of imported.appActions ?? []) command(entry);
  return {
    forms: [...forms.values()],
    tables: [...tables.values()],
    views: [...views.values()],
    apps: [...apps.values()],
    commands: [...commands.values()],
    solutionCount: imported.layers?.length ?? 0,
    limits: { maxItems: MAX_ITEMS, maxBytes: MAX_BYTES, maxDetails: 1000, truncated },
  };
}

/** Fixed, read-only metadata inspection. Never reads attributes' values or record IDs. */
export function inspectModelDrivenContext(origin) {
  if (location.origin !== origin) return null;
  const safe = (operation) => {
    try {
      return operation();
    } catch {
      return undefined;
    }
  };
  const guid = (value) =>
    typeof value === 'string' && /^[{]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[}]?$/i.test(value)
      ? value.replace(/[{}]/g, '').toLowerCase()
      : undefined;
  const logical = (value) => (typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/i.test(value) ? value : undefined);
  const globalContext = safe(() => window.Xrm?.Utility?.getGlobalContext());
  const form = safe(() => window.Xrm?.Page),
    item = safe(() => form?.ui?.formSelector?.getCurrentItem());
  const query = new URLSearchParams(location.search);
  const pageType = query.get('pagetype');
  const user = safe(() => globalContext?.userSettings);
  const roleCount = safe(() => user?.roles?.getLength()),
    formType = safe(() => form?.ui?.getFormType());
  // The page type and table come from the native page context, else from the address (pagetype, etn); a list page has no form.
  const page = safe(() => window.Xrm?.Utility?.getPageContext?.()?.input);
  const type = ['entityrecord', 'entitylist'].includes(page?.pageType)
    ? page.pageType
    : ['entityrecord', 'entitylist'].includes(pageType)
      ? pageType
      : undefined;
  const onForm = type !== 'entitylist';
  return {
    appId: guid(query.get('appid')),
    pageType: type,
    entity: logical(
      page?.entityName ?? (onForm ? safe(() => form?.data?.entity?.getEntityName()) : undefined) ?? query.get('etn'),
    ),
    formId: onForm ? (guid(safe(() => item?.getId())) ?? guid(query.get('formid'))) : undefined,
    viewId: type === 'entitylist' ? guid(page?.viewId ?? query.get('viewid')) : undefined,
    formType: onForm && Number.isInteger(formType) && formType >= 0 && formType <= 20 ? formType : undefined,
    identity: {
      available: Boolean(user),
      userId: guid(safe(() => user?.userId)),
      roleCount: Number.isSafeInteger(roleCount) && roleCount >= 0 ? Math.min(roleCount, 10000) : undefined,
    },
    frameBoundary: false,
  };
}
