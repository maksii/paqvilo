// Source-only inspection for a live Lense tab. No runtime, data pack or live request is started.
import fs from 'node:fs/promises';
import path from 'node:path';
import { importPortal, portalField } from '../mirage/lib/importer.mjs';
import { importSolutionMetadata } from '../mirage/lib/solution-metadata.mjs';
import { loadProjectConfig } from '../mirage/lib/project-config.mjs';
import { inspectPage } from '../mirage/lib/page-resources.mjs';
import { buildPermissionModel } from '../mirage/lib/permissions.mjs';
import { importCodeComponents } from '../mirage/lib/code-components.mjs';

const norm = (value) => String(value?.id ?? value ?? '').replace(/[{}]/g, '').toLowerCase();
const unique = (rows, key) => [...new Map(rows.map((row) => [key(row), row])).values()];
const inside = (root, file) => { const rel = path.relative(root, file); return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

/** Only configured roots are used. An unrelated project default never replaces this site. */
export async function inspectionSources(cfg) {
  const configured = cfg.mirageConfig ?? {};
  const sourceDir = await fs.realpath(cfg.sourceDir);
  let roots = cfg.mirageSourceRoots?.filter((root) => path.resolve(root).toLowerCase() !== path.resolve(cfg.sourceDir).toLowerCase()) ?? configured.solutionRoots ?? [], order = configured.solutionOrder ?? 'derived';
  let lcid = 1033, observed = configured.observed, dataModel = configured.dataModel;
  const diagnostics = [];
  if (configured.project) {
    try {
      const project = await loadProjectConfig(configured.project);
      const portal = project.portals.find((entry) => entry.sourceDir.toLowerCase() === sourceDir.toLowerCase());
      if (!portal) throw new Error('The configured project does not select this portal source.');
      roots = portal.solutionRoots;
      order = project.solutionOrder;
      lcid = project.lcid;
      observed = portal.observed ?? observed;
      dataModel = portal.dataModel ?? dataModel;
    } catch (error) { diagnostics.push({ code: 'INSPECT_PROJECT_UNAVAILABLE', reason: error.message }); }
  }
  const selected = [];
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory');
      selected.push(real);
    } catch { diagnostics.push({ code: 'INSPECT_SOLUTION_UNAVAILABLE', reason: `Configured Solution source is unavailable: ${root}` }); }
  }
  return { sourceDir, roots: unique(selected.map((root) => ({ root })), (row) => row.root).map((row) => row.root), order, lcid, observed, dataModel, diagnostics };
}

/** Fixed, bounded DOM read. Do not collect text, values, credentials or query parameters. */
export function inspectRenderedPage() {
  const own = (node) => !node.closest('#paqvilo-panel, #paqvilo-handle');
  const pathname = (value) => {
    try { const url = new URL(value, location.href); return url.origin === location.origin ? url.pathname : null; } catch { return null; }
  };
  const assets = [...document.querySelectorAll('script[src],link[href],img[src]')].filter(own).slice(0, 300).map((node) => ({ kind: node.tagName.toLowerCase(), path: pathname(node.getAttribute('src') ?? node.getAttribute('href')) })).filter((row) => row.path);
  const controls = [...document.querySelectorAll('input:not([type=hidden]):not([type=password]),select,textarea,[data-entityname],[data-entity],[data-formid],[data-viewid],[data-listid],[data-form-layout],.entity-grid[data-selected-view],iframe.quickform[data-controlid]')].filter(own).slice(0, 300).map((node) => {
    let layout = {};
    try { layout = JSON.parse(node.getAttribute('data-form-layout') ?? '{}'); } catch {}
    return {
    tag: node.tagName.toLowerCase(), id: node.id.slice(0, 160), name: (node.getAttribute('name') ?? '').slice(0, 160), type: (node.getAttribute('type') ?? '').slice(0, 40),
    entity: String(node.getAttribute('data-entityname') ?? node.getAttribute('data-entity') ?? layout.EntityName ?? '').slice(0, 160),
    formId: String(node.getAttribute('data-formid') ?? layout.Id ?? '').slice(0, 160), viewId: (node.getAttribute('data-viewid') ?? node.getAttribute('data-selected-view') ?? '').slice(0, 160), listId: (node.getAttribute('data-listid') ?? '').slice(0, 160),
    gridId: node.classList.contains('entity-grid') ? (node.closest('.subgrid[id]')?.id ?? '').slice(0, 160) : '', controlId: (node.getAttribute('data-controlid') ?? '').slice(0, 160),
  }; });
  const apiSets = [...new Set(performance.getEntriesByType('resource').slice(-300).flatMap((entry) => {
    const route = pathname(entry.name);
    const match = route && /^\/_api\/([a-z][\w]*)(?:\(|\/|$)/i.exec(route);
    return match ? [match[1]] : [];
  }))];
  return { assets, controls, apiSets, truncated: document.querySelectorAll('input,select,textarea').length > 300 };
}

const pageSources = (portal, page) => {
  const record = page?.metadata;
  if (!record?._file) return [];
  const component = /powerpagecomponent\.xml$/i.test(record._file);
  return [
    { name: 'Page metadata', fieldPath: null, sourceFile: record._file },
    ...[['Page copy', 'copy', 'copy.html'], ['Page JavaScript', 'customjavascript', 'custom_javascript.js'], ['Page CSS', 'customcss', 'custom_css.css'], ['Page summary', 'summary', 'summary.html']].map(([name, fieldPath, suffix]) => ({ name, fieldPath, sourceFile: component ? record._file : record._file.replace(/\.ya?ml$/i, `.${suffix}`) })),
  ];
};

/** Follow only exported native component bindings, with provenance for conditional/modal sources. */
function inspectFormDependencies(report, portal, metadata, rendered) {
  const queue = [...(report.forms ?? [])];
  const visited = new Set();
  report.nativeComponents = [];
  const addEntity = (entity) => {
    if (!entity || report.tables.some((row) => row.logicalName === entity)) return;
    const table = metadata.entities?.[entity];
    report.tables.push({ kind: 'table', name: entity, logicalName: entity, sourceFile: table?.sources?.[0], sourceFiles: table?.sources ?? [], fieldCount: Object.keys(table?.fields ?? {}).length, evidence: 'form-dependency' });
  };
  const addFields = (entity, fields, evidence) => {
    addEntity(entity);
    for (const item of fields ?? []) {
      if (!item.name || report.columns.some((row) => row.entity === entity && row.name === item.name)) continue;
      const field = metadata.entities?.[entity]?.fields?.[item.name];
      report.columns.push({ entity, name: item.name, sourceFile: field?.source ?? metadata.entities?.[entity]?.sources?.[0], resolved: Boolean(field), label: field?.label ?? item.label, type: field?.dataverseType ?? field?.type ?? item.type, required: Boolean(field?.required), evidence });
    }
  };
  const addView = (reference, entity, owner, evidence) => {
    if (!reference) return null;
    const view = metadata.views?.find((row) => norm(row.id) === norm(reference) && (!entity || row.entity === entity));
    if (!view) {
      report.unresolved.push({ kind: 'view', expression: reference, owner, reason: 'The form references a view absent from selected Solution sources.' });
      return null;
    }
    let item = report.views.find((row) => norm(row.id) === norm(view.id));
    if (!item) report.views.push((item = { id: view.id, name: view.name, entity: view.entity, sourceFile: view.file, fields: view.fields ?? [], evidence }));
    if (evidence === 'rendered-view-id') item.evidence = evidence;
    (item.usedBy ??= []).push(owner);
    addFields(view.entity, view.fields, evidence);
    return view;
  };
  const addForm = (reference, owner, evidence) => {
    const definition = portal.forms.find((row) => norm(row.id) === norm(reference));
    if (!definition) {
      report.unresolved.push({ kind: 'modal-form', expression: reference, owner, reason: 'The action references a basic form absent from the portal export.' });
      return null;
    }
    let item = report.forms.find((row) => norm(row.id) === norm(definition.id));
    if (!item) {
      const schema = metadata.componentSchemas?.[definition.id] ?? metadata.componentSchemas?.[definition.name];
      item = { id: definition.id, name: definition.name, kind: 'basic-form', entity: definition.entityName, formName: definition.formName, mode: definition.mode, sourceFile: definition.metadata?._file, formXml: schema?.sourceFile ? { id: schema.formId, name: schema.formName, sourceFile: schema.sourceFile } : null, evidence };
      report.forms.push(item); queue.push(item);
    }
    (item.usedBy ??= []).push(owner);
    return item;
  };
  for (const observed of rendered.controls ?? []) if (observed.viewId) addView(observed.viewId, observed.entity || null, observed.gridId || observed.id || 'Rendered native grid', 'rendered-view-id');
  for (let index = 0; index < queue.length && index < 80; index++) {
    const form = queue[index];
    if (visited.has(norm(form.id))) continue;
    visited.add(norm(form.id));
    const definition = [...portal.forms, ...(portal.advancedForms ?? [])].find((row) => norm(row.id) === norm(form.id));
    const schema = metadata.componentSchemas?.[form.id] ?? metadata.componentSchemas?.[form.name];
    if (!schema) continue;
    const walk = (current, depth = 0) => {
      if (!current || depth > 5) return;
      addFields(current.entity, current.fields, form.evidence ?? 'form-source');
      for (const step of current.steps ?? []) walk(step, depth + 1);
      for (const cell of current.layout?.flatMap((tab) => tab.columns.flatMap((column) => column.sections.flatMap((section) => section.rows.flat()))) ?? []) {
        if (!['subgrid', 'quickform', 'notes'].includes(cell.type)) {
          if (cell.lookupViewId) addView(cell.lookupViewId, cell.lookupView?.entity, `${form.name}.${cell.id} lookup`, 'lookup-view');
          continue;
        }
        const owner = `${form.name}.${cell.id}`;
        const observed = (rendered.controls ?? []).find((row) => row.gridId === cell.id || row.controlId === cell.id);
        const component = { kind: cell.type, id: cell.id, name: cell.label ?? cell.id, entity: cell.entity ?? (cell.type === 'notes' ? 'annotation' : null), relationship: cell.relationship ?? null, lookup: cell.lookup ?? null, owner, sourceFile: current.sourceFile, evidence: observed ? 'rendered-control-id' : 'form-source', viewId: cell.viewId ?? null, hidden: Boolean(cell.hidden), actions: [], metadataSources: [] };
        report.nativeComponents.push(component);
        addEntity(component.entity);
        if (cell.type === 'quickform') {
          if (cell.schema) {
            component.formName = cell.schema.formName;
            component.sourceFile = cell.schema.sourceFile;
            walk(cell.schema, depth + 1);
          } else report.unresolved.push({ kind: 'quick-form', expression: cell.id, owner, reason: 'The quick view form is absent from selected Solution sources.' });
        }
        if (cell.type !== 'subgrid') continue;
        addView(cell.viewId, cell.entity, owner, 'subgrid-view');
        const records = portal.records.filter((row) => ['basicformmetadata', 'advancedformmetadata'].includes(row.kind) && Number(portalField(row, 'statecode', 0)) !== 1 && portalField(row, 'subgrid_name') === cell.id && (current.stepId ? norm(portalField(row, 'webformstep')) === norm(current.stepId) : norm(portalField(row, 'entityform')) === norm(definition?.id)));
        if (records.length > 1) report.unresolved.push({ kind: 'subgrid-settings', expression: cell.id, owner, reason: 'Multiple exported metadata records configure this subgrid; action visibility and precedence are unknown.' });
        for (const record of records) {
          component.metadataSources.push({ name: 'Subgrid action settings', sourceFile: record._file });
          let settings;
          try {
            const value = portalField(record, 'subgrid_settings', '{}');
            settings = typeof value === 'string' ? JSON.parse(value) : value;
          } catch { report.unresolved.push({ kind: 'subgrid-settings', expression: cell.id, owner, reason: 'Exported subgrid settings JSON is malformed.' }); continue; }
          for (const action of [...(Array.isArray(settings?.ViewActions) ? settings.ViewActions : []), ...(Array.isArray(settings?.ItemActions) ? settings.ItemActions : [])]) {
            if (!['CrmEntityFormView-CreateAction', 'CrmEntityFormView-EditAction', 'CrmEntityFormView-DetailsAction'].includes(action.Type)) continue;
            const modal = action.EntityFormId && (action.TargetType == null || action.TargetType === '' || Number(action.TargetType) === 0);
            const formSource = modal ? addForm(action.EntityFormId, `${owner} ${action.Type.replace('CrmEntityFormView-', '')}`, 'configured-modal-form') : null;
            component.actions.push({ name: action.Type.replace('CrmEntityFormView-', ''), formName: formSource?.name ?? null, formId: modal ? norm(action.EntityFormId) : null, sourceFile: formSource?.sourceFile ?? record._file, conditional: Boolean(action.FilterCriteria), targetType: action.TargetType ?? null, evidence: 'exported-action' });
          }
        }
      }
    };
    walk(schema);
  }
}

/** Enrich a shared report with source provenance and observed DOM, never a live access verdict. */
export async function enrichInspection(report, portal, { metadata = {}, rendered = {}, live = false, observed = null, codeCatalogue = null } = {}) {
  report.evidence = {
    mode: live ? 'live-sources' : 'local-runtime',
    source: 'Static references from the selected local export. Conditional branches may not be rendered.',
    rendered: 'Observed controls and same-origin asset paths. Field values and request query values are excluded.',
    identity: live ? 'Live web-role membership and effective record access are not available from the export.' : 'Local session and configured permission evaluation.',
    solutions: (metadata.roots ?? []).length,
  };
  const page = portal.pages.find((entry) => norm(entry.id) === norm(report.page?.id));
  report.pageSources = [];
  for (const source of pageSources(portal, page)) {
    try { if ((await fs.stat(source.sourceFile)).isFile()) report.pageSources.push(source); } catch {}
  }
  if (page?.metadata?._file) {
    const root = portal.records.find((record) => record.kind === 'webpage' && norm(record.id) === norm(page.id));
    if (root?._file && root._file !== page.metadata._file) report.pageSources.unshift({ name: 'Root page metadata', sourceFile: root._file });
  }
  // Runtime component IDs can resolve a dynamic Liquid reference without guessing its value.
  for (const control of rendered.controls ?? []) {
    const form = control.formId && portal.forms.find((row) => norm(row.id) === norm(control.formId));
    const existing = form && (report.forms ?? []).find((row) => norm(row.id) === norm(form.id));
    if (existing) existing.evidence = 'rendered-component-id';
    if (form && !(report.forms ?? []).some((row) => norm(row.id) === norm(form.id))) {
      const schema = metadata.componentSchemas?.[form.id] ?? metadata.componentSchemas?.[form.name];
      (report.forms ??= []).push({ id: form.id, name: form.name, kind: 'basic-form', entity: form.entityName, mode: form.mode, formName: form.formName, sourceFile: form.metadata?._file, formXml: schema?.sourceFile ? { name: schema.formName, sourceFile: schema.sourceFile } : null, evidence: 'rendered-component-id' });
      for (const field of schema?.fields ?? []) if (field.name && !(report.columns ?? []).some((row) => row.entity === form.entityName && row.name === field.name)) (report.columns ??= []).push({ entity: form.entityName, name: field.name, sourceFile: field.source ?? metadata.entities?.[form.entityName]?.sources?.[0], resolved: true, type: field.type, label: field.label });
    }
    const list = control.listId && portal.lists.find((row) => norm(row.id) === norm(control.listId));
    if (list && !(report.components ?? []).some((row) => norm(row.recordId) === norm(list.id))) (report.components ??= []).push({ kind: 'list', recordId: list.id, name: list.name, entity: list.entityName, sourceFile: list.metadata?._file, evidence: 'rendered-component-id' });
    const view = control.viewId && metadata.views?.find((row) => norm(row.id) === norm(control.viewId));
    if (view && !(report.views ?? []).some((row) => norm(row.id) === norm(view.id))) (report.views ??= []).push({ id: view.id, name: view.name, entity: view.entity, sourceFile: view.file, fields: view.fields, evidence: 'rendered-component-id' });
    for (const entity of [form?.entityName, list?.entityName, view?.entity, control.entity && metadata.entities?.[control.entity] ? control.entity : null].filter(Boolean)) {
      if (!(report.tables ?? []).some((row) => row.logicalName === entity)) {
        const table = metadata.entities?.[entity];
        (report.tables ??= []).push({ kind: 'table', logicalName: entity, name: entity, sourceFile: table?.sources?.[0], sourceFiles: table?.sources ?? [], fieldCount: Object.keys(table?.fields ?? {}).length, evidence: 'rendered-component-id' });
      }
    }
  }
  inspectFormDependencies(report, portal, metadata, rendered);
  const sourceBodies = [page?.html, page?.js, page?.css, ...(report.webTemplates ?? []).map((row) => portal.templates?.[row.name]?.source), ...(report.snippets ?? []).map((row) => portal.snippets?.[row.name])].filter(Boolean);
  const observedPaths = new Set((rendered.assets ?? []).map((row) => row.path));
  const matchedFiles = new Map();
  // Follow only exported assets. Reads stay bounded; no URL is fetched.
  for (let round = 0; round < 8; round++) {
    const body = sourceBodies.join('\n');
    const pending = (portal.webFiles ?? []).filter((file) => file.url && !matchedFiles.has(file.url) && (observedPaths.has(file.url) || body.includes(file.url)));
    if (!pending.length) break;
    for (const file of pending) {
      matchedFiles.set(file.url, file);
      if (!/\.(?:m?js|css)$/i.test(file.file ?? '') || matchedFiles.size > 100) continue;
      try {
        const real = await fs.realpath(file.file);
        if (inside(portal.sourceDir, real) && (await fs.stat(real)).size <= 1024 * 1024) sourceBodies.push(await fs.readFile(real, 'utf8'));
      } catch {}
    }
  }
  const body = sourceBodies.join('\n');
  report.assets = [...matchedFiles.values()].map((file) => ({ name: file.name ?? file.url, url: file.url, sourceFile: file.file, metadataSource: file.metadata?._file, evidence: observedPaths.has(file.url) ? 'rendered-asset' : 'static-reference' }));
  // Literal Web API entity sets resolve only through selected Solution definitions.
  // Dynamic expressions stay unknown rather than assuming an English plural table name.
  const observedApiSets = new Set((rendered.apiSets ?? []).filter((value) => /^[a-z][\w]*$/i.test(value)));
  const apiSets = unique([...body.matchAll(/\/_api\/([a-z][\w]*)\b/gi)].map((match) => ({ name: match[1] })).concat([...observedApiSets].map((name) => ({ name }))), (row) => row.name);
  report.apiReferences = apiSets.map(({ name }) => {
    const entity = Object.entries(metadata.entities ?? {}).find(([, table]) => table.entitySet === name && table.entitySetSource !== 'pluralized');
    if (entity && !(report.tables ?? []).some((row) => row.logicalName === entity[0])) {
      const [logicalName, table] = entity;
      (report.tables ??= []).push({ kind: 'table', logicalName, name: logicalName, entitySet: name, sourceFile: table.sources?.[0], sourceFiles: table.sources ?? [], fieldCount: Object.keys(table.fields ?? {}).length, evidence: 'web-api-source' });
    }
    return { name, entity: entity?.[0] ?? null, sourceFile: entity?.[1].sources?.[0] ?? null, evidence: observedApiSets.has(name) ? 'observed-api-request' : 'static-reference' };
  });
  const permissionState = { tables: {}, mappings: {}, permissions: [], settings: {}, simulator: {} };
  const permissions = buildPermissionModel(portal, permissionState, { source: 'exported', relationships: metadata.relationships ?? {} }).permissions;
  const needed = new Set((report.tables ?? []).map((row) => row.logicalName));
  const byPermission = new Map(permissions.map((row) => [row.id, row]));
  for (const row of permissions.filter((row) => needed.has(row.entity))) {
    let parent = row;
    const seen = new Set();
    while (parent?.parentPermissionId && !seen.has(parent.id)) {
      seen.add(parent.id); parent = byPermission.get(parent.parentPermissionId);
      if (parent?.entity) needed.add(parent.entity);
    }
  }
  report.permissionRules = permissions.filter((row) => needed.has(row.entity)).map((row) => ({
    id: row.id, name: row.name, entity: row.entity, scope: row.scope, operations: row.operations, roles: row.roles,
    relationshipName: row.relationshipName, parentPermissionId: row.parentPermissionId, sourceFile: row.provenance?.file,
    evidence: 'exported-rule', effective: live ? 'unknown' : 'local-session',
  }));
  if (live) {
    for (const row of report.page?.access?.rules ?? []) { row.matches = null; row.effective = 'unknown'; }
    for (const table of report.tables ?? []) {
      const entity = metadata.entities?.[table.logicalName];
      table.entitySet = entity?.entitySetName ?? entity?.entitySet ?? null;
      table.entitySetInferred = entity?.entitySetSource === 'pluralized';
      table.idColumn = entity?.primaryIdAttribute ?? null;
      table.nameColumn = entity?.primaryNameAttribute ?? null;
      table.permissions = { mode: 'exported', effective: 'unknown', operations: {}, rules: report.permissionRules.filter((row) => row.entity === table.logicalName) };
    }
  }
  report.renderedControls = unique(rendered.controls ?? [], (row) => JSON.stringify(row)).map((row) => {
    const candidates = (report.columns ?? []).filter((column) => (column.name === row.id || column.name === row.name) && (!row.entity || column.entity === row.entity));
    const field = candidates.length === 1 ? candidates[0] : null;
    const component = (report.forms ?? []).find((form) => norm(form.id) === norm(row.formId) && row.formId);
    return { ...row, sourceFile: field?.sourceFile ?? component?.sourceFile ?? null, field: field ? `${field.entity}.${field.name}` : null, candidates: candidates.map((item) => `${item.entity}.${item.name}`), evidence: field || component ? 'rendered-and-source' : 'rendered-unmapped' };
  });
  report.logic = [
    ...(portal.serverLogics ?? []).filter((row) => body.includes(row.name)).map((row) => ({ ...row, sourceFile: row.file, kind: 'server-logic', evidence: 'static-reference' })),
    ...(portal.cloudFlows ?? []).filter((row) => row.path && body.includes(row.path) || row.processId && body.toLowerCase().includes(row.processId.toLowerCase())).map((row) => ({ ...row, sourceFile: portal.records.find((record) => norm(record.id) === norm(row.id))?._file, kind: 'cloud-flow', evidence: 'static-reference' })),
  ];
  report.codeComponents = unique([...body.matchAll(/{%[-]?\s*codecomponent\b([^%]*)%}/gi)].map((match) => {
    const parameter = /\bname\s*:\s*(?:'([^']+)'|"([^"]+)"|([^\s,]+))/i.exec(match[1]);
    const name = parameter?.[1] ?? parameter?.[2] ?? parameter?.[3] ?? '';
    const dynamic = !parameter || Boolean(parameter[3] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name));
    return { name, dynamic, schemaName: dynamic ? null : observed?.codeComponents?.[norm(name)] ?? null, expression: match[0], evidence: dynamic ? 'dynamic-reference' : 'static-reference' };
  }), (row) => row.expression);
  report.unresolved ??= [];
  for (const row of report.codeComponents) {
    const control = codeCatalogue?.controls.get(row.schemaName);
    if (control) Object.assign(row, { sourceFile: control.file, resources: control.resources.map((resource) => ({ name: resource.kind, url: resource.url, sourceFile: codeCatalogue.assets.get(resource.url)?.file })), properties: control.properties });
    else report.unresolved.push({ kind: 'code-component', expression: row.expression, reason: row.dynamic ? 'Code component name is dynamic and cannot be resolved from a static export.' : row.schemaName ? 'The configured code component manifest is absent from selected Solution sources.' : 'No observed component ID to Solution schema mapping is configured.' });
  }
  return report;
}

export function createSourceInspector(cfg) {
  let loading = null;
  const load = () => loading ??= (async () => {
    const sources = await inspectionSources(cfg);
    const portal = await importPortal(sources.sourceDir, { lcid: sources.lcid, ...(sources.dataModel ? { dataModel: sources.dataModel } : {}) });
    const metadata = sources.roots.length ? await importSolutionMetadata(sources.roots, { portal, lcid: sources.lcid, order: sources.order }) : {};
    const codeCatalogue = await importCodeComponents(metadata.layers ?? []);
    return { sources, portal, metadata, codeCatalogue };
  })().catch((error) => { loading = null; throw error; });
  return {
    invalidate() { loading = null; },
    async enrich(report, rendered = {}) {
      const { sources, portal, metadata, codeCatalogue } = await load();
      return enrichInspection(report, portal, { metadata, rendered, observed: sources.observed, codeCatalogue });
    },
    async inspect(route, rendered = {}) {
      const { sources, portal, metadata, codeCatalogue } = await load();
      const report = inspectPage(portal, route, { solutionMetadata: metadata });
      await enrichInspection(report, portal, { metadata, rendered, live: true, observed: sources.observed, codeCatalogue });
      report.unresolved.push(...sources.diagnostics.map((row) => ({ kind: 'configuration', ...row })));
      return { report, roots: [sources.sourceDir, ...sources.roots], status: { site: cfg.siteName, format: portal.format, sourceDir: sources.sourceDir, diagnostics: { total: report.unresolved.length }, solutionRoots: sources.roots } };
    },
  };
}
