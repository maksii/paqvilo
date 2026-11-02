import path from 'node:path';
import { createHash } from 'node:crypto';
import { solutionContentFingerprint, solutionLayerFiles } from './solution-content-fingerprint.mjs';
import { InvalidAssembly, inspectAssembly } from './clr-assembly-reader.mjs';
import { decodeXml, portalField as field } from './importer.mjs';
import {
  parseSolutionXml,
  descendants,
  child,
  childText as text,
  label,
  pickLabel,
  serializeXml as serialize,
} from './solution-xml.mjs';
import { scanSolutionSources, buildSolutionSchema, tableFields } from './solution-schema.mjs';
import { mapLimit } from './solution-cache.mjs';
import { importSolutionPlugins, resolvePluginSourceFiles } from './exported-plugins.mjs';
import { matchingSystemForms, portalFormEligible } from './system-form-selection.mjs';
import { advancedFormGraph } from './advanced-form-graph.mjs';

export { parseSolutionXml };

const chooseLazily = (condition, yes, no) => {
  if (condition()) return yes();
  return no();
};
const norm = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const FORM_PARSER_ID = 'metadata-form@7';
// Systemform control classes: web resource and subgrid (sub-grid) controls.
const WEB_RESOURCE_CLASS = '9fdf5f91-88b1-47f4-ad53-c11efc01a01d';
const SUBGRID_CLASS = 'e7a81278-8635-4d9e-8d4d-59480b391c5b';
const VIEW_PARSER_ID = 'metadata-view@2';
const IO_CONCURRENCY = 24;

/** Systemform documents plus the tables/views they depend on (quick views, subgrids, lookups). */
function parseFormDocument(xml, entity, file, lcid) {
  const document = parseSolutionXml(xml);
  const forms = [];
  const sourceTypes = new Map();
  const visit = (node, enclosingType) => {
    const type = node.name === 'forms' ? node.attrs.type : enclosingType;
    if (node.name === 'systemform' && type !== undefined) sourceTypes.set(node, type);
    for (const nested of node.children ?? []) visit(nested, type);
  };
  visit(document, undefined);
  // A solution export groups systemforms by type under FormXml/<group>/ (main, card, quick,
  // quickcreate ...); a document without a declared type takes its group as the form type.
  const groupType = /(?:^|[\\/])FormXml[\\/]([^\\/]+)[\\/][^\\/]+\.xml$/i.exec(String(file ?? ''))?.[1];
  for (const systemform of document.name === 'systemform' ? [document] : descendants(document, 'systemform')) {
    const form = child(systemform, 'form');
    if (!form) continue;
    const declaredType = text(systemform, 'type');
    const systemFormType = /^\d+$/.test(declaredType ?? '') ? Number(declaredType) : undefined;
    forms.push({
      id: norm(text(systemform, 'formid') ?? path.basename(file, '.xml')),
      entity,
      ...chooseLazily(
        () => sourceTypes.has(systemform),
        () => ({ formType: sourceTypes.get(systemform) }),
        () => (groupType ? { formType: groupType } : {}),
      ),
      ...(systemFormType !== undefined ? { systemFormType } : {}),
      name: label(child(systemform, 'LocalizedNames'), lcid) ?? '',
      xml: serialize(form),
      file,
      active: text(systemform, 'FormActivationState') !== '0',
    });
  }
  return {
    forms,
    viewRefs: [...xml.matchAll(/<DefaultViewId>\s*([^<]+)<\/DefaultViewId>/gi)].map((m) => norm(m[1])), // NOSONAR: regex kept: linear on bounded input, a rewrite would change matches
    entityRefs: [
      ...xml.matchAll(/QuickFormId\s+entityname=(?:"|&quot;)([^"&]+)|<TargetEntityType>([^<]+)<\/TargetEntityType>/gi),
    ].map((m) => norm(m[1] ?? m[2])),
  };
}

function parseViewDocument(xml, entity, file, lcid) {
  const document = parseSolutionXml(xml);
  const views = [];
  for (const view of document.name === 'savedquery' ? [document] : descendants(document, 'savedquery')) {
    const fetch = descendants(child(view, 'fetchxml'), 'fetch')[0];
    const layout = child(view, 'layoutxml');
    views.push({
      id: norm(text(view, 'savedqueryid') ?? path.basename(file, '.xml')),
      entity,
      name: label(child(view, 'LocalizedNames'), lcid) ?? '',
      queryType: Number(text(view, 'querytype')) || 0,
      isDefault: text(view, 'isdefault') === '1',
      fetchXml: fetch ? serialize(fetch) : decodeXml(child(view, 'fetchxml')?.text.trim() ?? ''),
      // Layout cells marked ishidden="1" are not grid columns (e.g. the Contacts Lookup View hides fax, address1_name, address1_fax).
      fields: descendants(layout, 'cell')
        .filter((c) => c.attrs.ishidden !== '1')
        .map((c) => ({
          name: c.attrs.name,
          width: Number(c.attrs.width) || undefined,
          // A cell without a width is a zero-width column; disableSorting="1" disables its sort
          // (e.g. the Contact form ActionCards grid).
          ...(c.attrs.width == null ? { widthless: true } : {}),
          ...(c.attrs.disableSorting === '1' ? { sortDisabled: true } : {}),
        })),
      file,
    });
  }
  return { views };
}

/** Portal tables whose solution metadata the runtime needs (forms, lists, steps, Web API, grants). */
export function portalMetadataEntities(portal) {
  return [
    ...new Set(
      [...(portal.forms ?? []), ...(portal.lists ?? [])]
        .map((f) => f.entityName)
        .concat(
          (portal.records ?? [])
            .filter((r) => r.kind === 'advancedformstep')
            .map((r) => field(r, 'targetentitylogicalname', field(r, 'entityname'))),
        )
        .concat(
          (portal.records ?? [])
            .filter((r) => r.kind === 'tablepermission' && Number(field(r, 'statecode', 0)) !== 1)
            .map((r) => field(r, 'entitylogicalname')),
        )
        .concat(
          Object.entries(portal.settings ?? {})
            .filter(
              ([name, value]) =>
                /^Webapi\/[a-z][a-z0-9_]*\/(?:enabled|UseFieldsFromView)$/i.test(name) &&
                String(value).toLowerCase() === 'true',
            )
            .map(([name]) => name.split('/')[1]),
        )
        .filter(Boolean)
        .map((name) => String(name).toLowerCase()),
    ),
  ];
}

async function parseSolutionMetadataFile(file, scan, lcid, diagnostics) {
  if (file.parsed) return file.parsed;
  try {
    const parser = file.kind === 'form' ? parseFormDocument : parseViewDocument;
    const { value, hash } = await scan.cache.parse(
      file.path,
      (file.kind === 'form' ? FORM_PARSER_ID : VIEW_PARSER_ID) + ':' + lcid,
      (xml) => parser(xml, file.entity, file.path, lcid),
      { stamp: file.stamp },
    );
    file.hash = hash;
    file.parsed = value;
  } catch (error) {
    file.parsed = { forms: [], views: [], viewRefs: [], entityRefs: [] };
    diagnostics.push({ code: 'SOLUTION_METADATA_PARSE_ERROR', file: file.path, message: error.message });
  }
  return file.parsed;
}

async function expandFormDependencies(names, files, parse) {
  const viewEntities = new Map(
    files.filter((file) => file.kind === 'view').map((file) => [norm(path.basename(file.path, '.xml')), file.entity]),
  );
  const inspected = new Set();
  let expanded;
  do {
    expanded = false;
    const pending = files.filter((file) => file.kind === 'form' && names.has(file.entity) && !inspected.has(file));
    await mapLimit(pending, IO_CONCURRENCY, parse);
    for (const file of pending) {
      inspected.add(file);
      if (addFormReferences(file, viewEntities, names)) expanded = true;
    }
  } while (expanded);
}

function addFormReferences(file, viewEntities, names) {
  let expanded = false;
  for (const viewId of file.parsed.viewRefs ?? []) {
    const entity = viewEntities.get(viewId);
    if (entity && !names.has(entity)) {
      names.add(entity);
      expanded = true;
    }
  }
  for (const entity of file.parsed.entityRefs ?? [])
    if (!names.has(entity)) {
      names.add(entity);
      expanded = true;
    }
  return expanded;
}

function collectEmbeddedComponents(document, names, lcid, forms, views, fingerprint) {
  const components = document.facts.appComponents;
  for (const form of components?.forms ?? [])
    if (!names || names.has(form.entity))
      forms.push({ ...form, name: pickLabel(form.nameLabels, lcid) ?? form.name, file: document.file });
  for (const view of components?.views ?? [])
    if (!names || names.has(view.entity))
      views.push({ ...view, name: pickLabel(view.nameLabels, lcid) ?? view.name, file: document.file });
  if (
    components?.forms?.length ||
    components?.views?.length ||
    document.facts.apps?.length ||
    document.facts.appMaps?.length
  )
    fingerprint.update(document.hash ?? '');
}

function collectParsedLayerComponents(layerIndex, candidates, forms, views) {
  for (const file of candidates) {
    if (file.layerIndex !== layerIndex) continue;
    if (file.kind === 'form') forms.push(...file.parsed.forms);
    else if (file.kind === 'view') views.push(...file.parsed.views);
  }
}

function collectSolutionComponents(scan, candidates, names, lcid, fingerprint) {
  const forms = [];
  const views = [];
  // Rows are collected layer by layer: embedded components, then that layer's parsed FormXml/SavedQueries files.
  // The dedupe below keeps the last row, so the later selected layer wins whichever way it carries the component.
  for (const [layerIndex, layer] of scan.layers.entries()) {
    for (const document of layer.documents) collectEmbeddedComponents(document, names, lcid, forms, views, fingerprint);
    collectParsedLayerComponents(layerIndex, candidates, forms, views);
  }
  return { forms, views };
}

function collectEntityTables(schema, names, lcid, diagnostics) {
  const tables = {};
  for (const [name, table] of Object.entries(schema.tables)) {
    if (names && !names.has(name)) continue;
    if (!table.layers?.length && table.origin !== 'dataverse-reference') continue;
    tables[name] = {
      entity: name,
      label: table.labels?.[String(lcid)] ?? Object.values(table.labels ?? {})[0],
      collectionLabel: table.collectionLabels?.[String(lcid)] ?? Object.values(table.collectionLabels ?? {})[0],
      fields: tableFields(schema, name, { lcid, diagnostics }),
      sources: [...table.sources],
      entitySet: table.entitySet,
      entitySetSource: table.entitySetSource,
      ownership: table.ownership,
      tableType: table.tableType,
      grid: table.grid,
      dataSourceId: table.dataSourceId,
      dataProviderId: table.dataProviderId,
      changeTrackingEnabled: table.changeTrackingEnabled,
      isOptimisticConcurrencyEnabled: table.isOptimisticConcurrencyEnabled,
      primaryIdAttribute: table.primaryIdAttribute,
      primaryNameAttribute: table.primaryNameAttribute,
      schemaComplete: table.schemaComplete,
      completeness: table.completeness,
    };
  }
  return tables;
}

function dedupeMetadataRows(rows, kind, diagnostics) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.entity}/${row.id}`;
    const before = map.get(key);
    // One source file read both as an embedded component and as a parsed file is not a layer variant.
    if (
      before &&
      before.file !== row.file &&
      (kind === 'form' ? before.xml !== row.xml : before.fetchXml !== row.fetchXml)
    )
      diagnostics.push({
        code: 'SOLUTION_LAYER_VARIANTS',
        kind,
        id: row.id,
        entity: row.entity,
        selected: row.file,
        previous: before.file,
        message:
          'Multiple source layers provide this component; the last selected root and source file wins. This does not identify the deployed layer.',
      });
    map.set(key, row);
  }
  return [...map.values()];
}

function notesCell(cell, control, lcid) {
  return {
    type: 'notes',
    id: control.attrs.id,
    label: label(child(cell, 'labels'), lcid) || 'Notes',
    showLabel: cell.attrs.showlabel !== 'false',
    hidden: cell.attrs.visible === 'false',
    colspan: Number(cell.attrs.colspan) || 1,
    rowspan: Number(cell.attrs.rowspan) || 1,
  };
}

function webResourceCell(cell, control, parameters, lcid) {
  return {
    type: 'webresource',
    id: control.attrs.id,
    url: text(parameters, 'Url'),
    scrolling: text(parameters, 'Scrolling') || 'auto',
    border: text(parameters, 'Border') === 'true',
    label: label(child(cell, 'labels'), lcid),
    showLabel: cell.attrs.showlabel !== 'false',
    colspan: Number(cell.attrs.colspan) || 1,
    rowspan: Number(cell.attrs.rowspan) || 1,
  };
}

function subgridCell(cell, control, parameters, context) {
  const { metadata, lcid, componentBindings } = context;
  const entity = norm(text(parameters, 'TargetEntityType'));
  const viewId = norm(text(parameters, 'ViewId'));
  const view = metadata.views.find((candidate) => candidate.entity === entity && candidate.id === viewId);
  return {
    type: 'subgrid',
    id: control.attrs.id,
    entity,
    viewId,
    relationship: text(parameters, 'RelationshipName'),
    searchEnabled: text(parameters, 'EnableQuickFind') === 'true',
    recordsPerPage: Number(text(parameters, 'RecordsPerPage')) || undefined,
    ...componentBindings(control),
    fields: (view?.fields ?? []).map((field) => ({
      ...metadata.entities[entity]?.fields[field.name],
      ...field,
    })),
    fetchXml: view?.fetchXml,
    label: label(child(cell, 'labels'), lcid),
    // A hidden label leaves the subgrid heading empty.
    ...(cell.attrs.showlabel === 'false' ? { showLabel: false } : {}),
    colspan: Number(cell.attrs.colspan) || 1,
    rowspan: Number(cell.attrs.rowspan) || 1,
  };
}

function quickFormCell(cell, control, quickForms, context) {
  const { metadata, lcid, dependencyDepth } = context;
  const reference = descendants(parseSolutionXml(quickForms), 'QuickFormId')[0];
  const quickForm = metadata.forms.find(
    (candidate) => candidate.id === norm(reference?.text) && candidate.entity === norm(reference?.attrs.entityname),
  );
  return {
    type: 'quickform',
    id: control.attrs.id,
    lookup: norm(control.attrs.datafieldname),
    entity: norm(reference?.attrs.entityname),
    schema: quickForm
      ? formSchema(
          quickForm,
          {
            name: label(child(cell, 'labels'), lcid) ?? quickForm.name,
            mode: 100000002,
            metadata: {},
          },
          metadata,
          dependencyDepth + 1,
        )
      : null,
    label: label(child(cell, 'labels'), lcid),
    colspan: Number(cell.attrs.colspan) || 1,
  };
}

function fieldCell(cell, control, parameters, context, fields) {
  const { metadata, lcid, componentBindings, richTextControls, known } = context;
  const name = norm(control.attrs.datafieldname);
  const lookupViewId = norm(text(parameters, 'DefaultViewId'));
  const lookupView = metadata.views.find((view) => view.id === lookupViewId);
  const controlDefinition = {
    ...known[name],
    name,
    id: control.attrs.id ?? name,
    label: label(child(cell, 'labels'), lcid) ?? known[name]?.label ?? name,
    // Form XML read-only; column create/update validity (validForCreate/validForUpdate)
    // applies to the mode the form renders in (an inactive record renders read-only).
    readOnly: control.attrs.disabled === 'true',
    hidden: cell.attrs.visible === 'false',
    showLabel: cell.attrs.showlabel !== 'false',
    controlClassId: norm(control.attrs.classid),
    ...componentBindings(control),
    ...(richTextControls.has(norm(control.attrs.uniqueid))
      ? {
          richText: richTextControls.get(norm(control.attrs.uniqueid)),
        }
      : {}),
    lookupViewId,
    ...(lookupView
      ? {
          lookupView: {
            id: lookupView.id,
            entity: lookupView.entity,
            fetchXml: lookupView.fetchXml,
            fields: lookupView.fields,
            sourceFile: lookupView.file,
          },
        }
      : {}),
    colspan: Number(cell.attrs.colspan) || 1,
    rowspan: Number(cell.attrs.rowspan) || 1,
  };
  fields.push(controlDefinition);
  return controlDefinition;
}

function buildFormCell(cell, context, fields) {
  const { lcid } = context;
  const control = child(cell, 'control');
  const parameters = child(control, 'parameters');
  if (
    norm(control?.attrs.classid) === '06375649-c143-495e-a496-c962e5b4488e' ||
    control?.attrs.indicationOfNotes === 'true'
  )
    return notesCell(cell, control, lcid);
  if (norm(control?.attrs.classid) === WEB_RESOURCE_CLASS) return webResourceCell(cell, control, parameters, lcid);
  const datasetControl = Boolean(text(parameters, 'TargetEntityType') && text(parameters, 'ViewId'));
  if (control?.attrs.indicationOfSubgrid === 'true' || norm(control?.attrs.classid) === SUBGRID_CLASS || datasetControl)
    return subgridCell(cell, control, parameters, context);
  const quickForms = text(parameters, 'QuickForms');
  if (quickForms) return quickFormCell(cell, control, quickForms, context);
  if (!control?.attrs.datafieldname)
    return {
      spacer: true,
      colspan: Number(cell.attrs.colspan) || 1,
      rowspan: Number(cell.attrs.rowspan) || 1,
    };
  return fieldCell(cell, control, parameters, context, fields);
}

function buildFormSection(section, context, fields) {
  if (section.attrs.visible === 'false') return { name: section.attrs.name, hidden: true, rows: [] };
  const rows = [];
  for (const row of child(section, 'rows')?.children ?? []) {
    const cells = [];
    for (const cell of row.children) cells.push(buildFormCell(cell, context, fields));
    rows.push(cells);
  }
  return {
    name: section.attrs.name,
    label: label(child(section, 'labels'), context.lcid),
    showLabel: section.attrs.showlabel === 'true',
    columnWidths: /^1{1,4}$/.test(section.attrs.columns ?? '')
      ? [...section.attrs.columns].map(() => 100 / section.attrs.columns.length)
      : undefined,
    rows,
  };
}

function buildFormTab(tab, context, fields) {
  const columns = [];
  for (const column of child(tab, 'columns')?.children ?? []) {
    const sections = [];
    for (const section of child(column, 'sections')?.children ?? [])
      sections.push(buildFormSection(section, context, fields));
    columns.push({ width: column.attrs.width, sections });
  }
  return {
    name: tab.attrs.name,
    label: label(child(tab, 'labels'), context.lcid),
    showLabel: tab.attrs.showlabel === 'true',
    columns,
  };
}

function customControlBinding(parameter, value, type) {
  if (parameter.name === 'data-set')
    return {
      kind: 'dataset',
      viewId: norm(text(parameter, 'ViewId')) || null,
      entity: norm(text(parameter, 'TargetEntityType')) || null,
      xml: serialize(parameter),
    };
  if (parameter.attrs.static === 'true') return { kind: 'static', value, type };
  if (!parameter.children.length && /^[a-z_][a-z\d_]*$/i.test(value))
    return { kind: 'binding', column: norm(value), type };
  return { kind: 'unresolved', value, type, xml: serialize(parameter) };
}

function customControlVariants(description, form) {
  const variants = [];
  for (const control of descendants(description, 'customControl')) {
    if (!control.attrs.name) continue;
    const parameters = Object.create(null);
    for (const parameter of child(control, 'parameters')?.children ?? []) {
      const key = parameter.name === 'data-set' ? parameter.attrs.name : parameter.name;
      if (!key) continue;
      const value = parameter.text.trim();
      const type = parameter.attrs.type;
      const binding = customControlBinding(parameter, value, type);
      parameters[key] = Object.hasOwn(parameters, key)
        ? { kind: 'unresolved', reason: 'Duplicate exported property binding' }
        : binding;
    }
    variants.push({
      name: control.attrs.name,
      id: norm(control.attrs.id) || null,
      formFactor: control.attrs.formFactor ?? null,
      parameters,
      boundAttributes: [
        ...new Set(
          Object.values(parameters)
            .filter((value) => value.kind === 'binding')
            .map((value) => value.column),
        ),
      ],
      sourceFile: form.file,
      controlId: norm(description.attrs.forControl),
    });
  }
  return [norm(description.attrs.forControl), variants];
}

function componentBindingsFor(customControls, control) {
  const variants = customControls.get(norm(control?.attrs.uniqueid)) ?? customControls.get(norm(control?.attrs.id));
  if (!variants?.length) return {};
  const codeComponent = variants.find(
    (component) =>
      component.formFactor === '0' && component.name !== 'MscrmControls.RichTextEditor.RichTextEditorControl',
  );
  return { codeComponents: variants, ...(codeComponent ? { codeComponent } : {}) };
}

function richTextControlsOf(tree) {
  return new Map(
    descendants(tree, 'controlDescription').flatMap((description) => {
      const custom = descendants(description, 'customControl').find(
        (control) => control.attrs.name === 'MscrmControls.RichTextEditor.RichTextEditorControl',
      );
      return custom
        ? [
            [
              norm(description.attrs.forControl),
              {
                name: custom.attrs.name,
                configUrl: text(child(custom, 'parameters'), 'configUrl') ?? null,
              },
            ],
          ]
        : [];
    }),
  );
}

function selectFormTabs(tree, definition, lcid) {
  const selectedTab = norm(field(definition.metadata, 'tabname'));
  const tabs = descendants(tree, 'tab');
  // Legacy tab selection: no tab name renders
  // every visible tab; otherwise the first tab whose name matches, else the first whose
  // label matches, else the first visible tab.
  const visibleTab = tabs.find((tab) => tab.attrs.visible === undefined || tab.attrs.visible === 'true');
  let tabSelection = null;
  let chosen = tabs;
  if (selectedTab) {
    const byName = tabs.find((tab) => norm(tab.attrs.name) === selectedTab || norm(tab.attrs.id) === selectedTab);
    const byLabel = byName ? null : tabs.find((tab) => norm(label(child(tab, 'labels'), lcid)) === selectedTab);
    const tab = byName ?? byLabel ?? visibleTab ?? null;
    tabSelection = {
      requested: field(definition.metadata, 'tabname'),
      matched: chooseLazily(
        () => byName,
        () => 'name',
        () =>
          chooseLazily(
            () => byLabel,
            () => 'label',
            () => (tab ? 'first-visible' : 'none'),
          ),
      ),
      tab: tab?.attrs.name ?? null,
    };
    chosen = tab ? [tab] : [];
  }
  return { chosen, tabSelection };
}

/**
 * Discover unpacked solution forms/views and table columns for portal tables.
 * Roots may be repositories, solution trees or a common parent; the shared scan
 * orders layers and caches parsed files (see solution-schema.mjs).
 */
export async function importSolutionMetadata(
  roots,
  { entities, portal, lcid = 1033, scan, schema, cache, cacheFile, order = 'explicit', observed } = {},
) {
  if (portal && !entities) entities = portalMetadataEntities(portal);
  roots = Array.isArray(roots) ? roots : [roots];
  scan ??= await scanSolutionSources(roots, { cache, cacheFile, order });
  schema ??= buildSolutionSchema(scan, { lcid });
  const names = entities?.length ? new Set(entities.map(norm)) : null;
  const diagnostics = [];
  const fingerprint = createHash('sha256');
  const files = scan.layers.flatMap((layer, layerIndex) =>
    layer.files
      .filter((file) => ['entity', 'form', 'view'].includes(file.kind))
      .map((file) => ({ ...file, entity: norm(file.entityDir), layerIndex })),
  );
  const parse = (file) => parseSolutionMetadataFile(file, scan, lcid, diagnostics);
  // Follow form dependencies into other tables (quick views and subgrids).
  // A portal's basic forms alone do not describe its complete solution inputs.
  if (names) await expandFormDependencies(names, files, parse);
  const candidates = files.filter((file) => !names || names.has(file.entity));
  await mapLimit(
    candidates.filter((f) => f.kind !== 'entity'),
    IO_CONCURRENCY,
    parse,
  );
  const { forms, views } = collectSolutionComponents(scan, candidates, names, lcid, fingerprint);
  const entityDocs = new Map(scan.layers.flatMap((layer) => layer.documents.map((doc) => [doc.file, doc.hash])));
  for (const file of candidates) {
    fingerprint
      .update(file.path)
      .update('\0')
      .update(file.hash ?? entityDocs.get(file.path) ?? '')
      .update('\0');
  }
  // Table columns come from the merged schema; only tables with exported definitions are listed.
  const tables = collectEntityTables(schema, names, lcid, diagnostics);
  const plugins = await resolvePluginSourceFiles(
    attachSolutionAssemblyContent(
      importSolutionPlugins(scan.layers, {
        sdkMessages: observed?.sdkMessages,
        businessLogicOwnership: observed?.businessLogicOwnership,
      }),
      scan.layers,
    ),
    observed?.pluginSources,
    portal?.sourceDir,
  );
  fingerprint.update(plugins.fingerprint);
  diagnostics.push(...plugins.diagnostics);
  const metadata = {
    lcid,
    // Hashes belong to the bytes actually parsed, not a later filesystem read.
    // Inspection/render provenance can detect edits between import and use.
    sourceRevisions: Object.fromEntries(
      [
        ...scan.layers.flatMap((layer) => layer.documents.map((document) => [document.file, document.hash])),
        ...candidates.map((file) => [file.path, file.hash ?? entityDocs.get(file.path)]),
      ].filter(([, revision]) => typeof revision === 'string'),
    ),
    roots: scan.inputs.filter((input) => !['missing', 'unsupported'].includes(input.type)).map((input) => input.input),
    layers: schema.layers,
    entities: tables,
    forms: dedupeMetadataRows(forms, 'form', diagnostics),
    views: dedupeMetadataRows(views, 'view', diagnostics),
    sourceComponents: [
      ...new Map(
        scan.layers
          .flatMap((layer) => layer.documents.flatMap((document) => document.facts.recordComponents ?? []))
          .map((component) => [
            `${component.kind}/${component.id}`,
            { ...component, row: { ...component.row, name: pickLabel(component.labels, lcid) ?? component.row.name } },
          ]),
      ).values(),
    ],
    plugins,
    diagnostics,
    filesRead: candidates.length,
    fingerprint: fingerprint.digest('hex'),
    contentFingerprint: solutionContentFingerprint(scan.layers, { lcid, files: candidates, cache: scan.cache }),
  };
  if (portal) {
    const applied = applySolutionMetadata(portal, metadata);
    return {
      ...metadata,
      ...applied,
      summary: {
        sources: metadata.roots,
        layers: schema.layers.length,
        filesRead: metadata.filesRead,
        forms: metadata.forms.length,
        views: metadata.views.length,
        resolved: applied.counts,
        unresolved: applied.diagnostics.filter((d) =>
          /UNRESOLVED|MAPPING_ERROR|SYSTEMFORM_INELIGIBLE_TYPE/.test(d.code),
        ).length,
      },
    };
  }
  return metadata;
}

function formSchema(form, definition, metadata, dependencyDepth = 0) {
  if (dependencyDepth > 8) throw new Error('Quick form dependency nesting exceeds eight levels');
  const tree = parseSolutionXml(form.xml),
    lcid = metadata.lcid ?? 1033;
  const customControls = new Map(
    descendants(tree, 'controlDescription').map((description) => customControlVariants(description, form)),
  );
  const componentBindings = (control) => componentBindingsFor(customControls, control);
  const richTextControls = richTextControlsOf(tree);
  const { chosen, tabSelection } = selectFormTabs(tree, definition, lcid);
  const fields = [];
  const layout = [];
  const known = metadata.entities[form.entity]?.fields ?? {};
  const context = { metadata, lcid, componentBindings, richTextControls, dependencyDepth, known };
  for (const tab of chosen) {
    // Native portal controls omit systemform tabs explicitly marked invisible.
    // Their repeated bindings must not become extra required browser controls.
    if (tab.attrs.visible === 'false') continue;
    layout.push(buildFormTab(tab, context, fields));
  }
  return {
    entity: form.entity,
    title: definition.name,
    formId: form.id,
    formName: form.name,
    fields,
    layout,
    source: 'unpacked-systemform',
    sourceFile: form.file,
    mode: definition.mode,
    ...(tabSelection ? { tabSelection } : {}),
  };
}

/**
 * The schema of the systemform a form definition selects (entity and form name, or form id), by
 * the same selection resolve() applies: matching systemforms of an eligible type (Main), the
 * first one. Null when none matches. Used for definitions that are not exported basic forms, such
 * as a multistep step's reference read-only form.
 */
export function systemFormSchemaFor(definition, metadata) {
  if (!definition || !Array.isArray(metadata?.forms)) return null;
  const choices = matchingSystemForms(definition, metadata.forms).filter(portalFormEligible);
  return choices.length ? formSchema(choices[0], definition, metadata) : null;
}

function withSaveFields(schema, definition, portal, metadata) {
  const onSaveFields = (portal.records ?? [])
    .filter(
      (row) =>
        ['basicformmetadata', 'advancedformmetadata'].includes(row.kind) &&
        field(row, 'setvalueonsave', false) === true &&
        (norm(field(row, 'entityform')) === norm(definition.id) ||
          norm(field(row, 'webformstep')) === norm(definition.id)),
    )
    .map((row) => {
      const name = norm(field(row, 'attributelogicalname')),
        attribute = metadata.entities[schema.entity]?.fields[name];
      if (!attribute) throw new Error(`On-save attribute '${name}' is absent in the imported table metadata`);
      return { ...attribute, name };
    });
  const associationName = norm(
    field(
      definition.metadata,
      'targetentityportaluserlookupattribute',
      field(definition.metadata, 'portaluserlookupattribute'),
    ),
  );
  let currentUserAssociationField;
  if (field(definition.metadata, 'associatecurrentportaluser', false) === true && associationName) {
    const attribute = metadata.entities[schema.entity]?.fields[associationName];
    if (!attribute)
      throw new Error(
        `Current-user association attribute '${associationName}' is absent in the imported table metadata`,
      );
    currentUserAssociationField = { ...attribute, name: associationName };
  }
  return {
    ...schema,
    onSaveFields,
    ...(currentUserAssociationField ? { currentUserAssociationField } : {}),
  };
}

function resolveSystemForm(definition, portal, metadata, diagnostics) {
  const matches = matchingSystemForms(definition, metadata.forms);
  const choices = matches.filter(portalFormEligible);
  if (matches.length && !choices.length)
    diagnostics.push({
      code: 'SYSTEMFORM_INELIGIBLE_TYPE',
      id: definition.id,
      entity: definition.entityName,
      candidates: matches.map(({ id, formType, systemFormType, file }) => ({
        formId: id,
        formType,
        systemFormType,
        sourceFile: file,
      })),
      message: 'Matching exported forms have a declared non-Main type; no portal form layout is selected.',
    });
  if (!choices.length) return null;
  // Legacy form selection: the first systemform
  // with the name. Dataverse retrieval order is not observable locally; layer and file
  // order stand in for it and the other candidates are reported.
  if (choices.length > 1)
    diagnostics.push({
      code: 'SYSTEMFORM_NAME_AMBIGUOUS',
      id: definition.id,
      entity: definition.entityName,
      name: definition.formName,
      formId: choices[0].id,
      sourceFile: choices[0].file,
      candidates: choices.map((choice) => ({ formId: choice.id, sourceFile: choice.file })),
      message: `${choices.length} active systemforms are named ${definition.formName}; the first (${choices[0].id}) is used. Set the form ID on the basic form to choose another.`,
    });
  const schema = formSchema(choices[0], definition, metadata);
  if (schema.tabSelection && !['name', 'label'].includes(schema.tabSelection.matched))
    diagnostics.push({
      code: 'SYSTEMFORM_TAB_FALLBACK',
      id: definition.id,
      formId: schema.formId,
      requested: schema.tabSelection.requested,
      tab: schema.tabSelection.tab,
      message: schema.tabSelection.tab
        ? `No tab of ${schema.formName} is named or labelled '${schema.tabSelection.requested}'; the first visible tab '${schema.tabSelection.tab}' is rendered.`
        : `No tab of ${schema.formName} is named or labelled '${schema.tabSelection.requested}' and the form has no visible tab.`,
    });
  return withSaveFields(schema, definition, portal, metadata);
}

function mapPortalForms(portal, componentSchemas, diagnostics, resolve) {
  for (const definition of portal.forms) {
    try {
      const diagnosticStart = diagnostics.length;
      const schema = resolve(definition);
      if (schema) {
        componentSchemas[definition.id] = schema;
        componentSchemas[definition.name] = schema;
      } else if (!diagnostics.slice(diagnosticStart).some((item) => item.code === 'SYSTEMFORM_INELIGIBLE_TYPE'))
        diagnostics.push({
          code: 'SYSTEMFORM_UNRESOLVED',
          id: definition.id,
          entity: definition.entityName,
          name: definition.formName,
          message: 'No matching systemform exists in the selected solution sources',
        });
    } catch (error) {
      diagnostics.push({ code: 'SYSTEMFORM_MAPPING_ERROR', id: definition.id, message: error.message });
    }
  }
}

function mapPortalLists(portal, metadata, componentSchemas, diagnostics) {
  for (const list of portal.lists) {
    const viewId = norm(field(list.metadata, 'view'));
    const view = metadata.views.find(
      (candidate) => candidate.entity === norm(list.entityName) && candidate.id === viewId,
    );
    if (view) {
      const schema = {
        entity: view.entity,
        title: list.name,
        viewId: view.id,
        fetchXml: view.fetchXml,
        fields: view.fields.map((item) => ({
          ...metadata.entities[view.entity]?.fields[item.name],
          ...item,
        })),
        source: 'unpacked-savedquery',
        sourceFile: view.file,
      };
      componentSchemas[list.id] = schema;
      componentSchemas[list.name] = schema;
    } else
      diagnostics.push({
        code: 'SYSTEMVIEW_UNRESOLVED',
        id: list.id,
        viewId,
        entity: list.entityName,
        message: 'No matching savedquery exists in the selected solution sources',
      });
  }
}

function conditionStep(step) {
  return {
    stepId: step.id,
    type: 'condition',
    condition: field(step, 'condition'),
    nextStepId: norm(field(step, 'nextstep')),
    conditionDefaultNextStepId: norm(field(step, 'conditiondefaultnextstep')),
    js: step.customJavascript,
    metadata: step,
  };
}

function redirectStep(step, portal) {
  const target = portal.pages.find((page) => page.id === norm(field(step, 'redirectwebpage')));
  const redirectUrl = target?.url ?? field(step, 'redirecturl');
  if (!redirectUrl) throw new Error('Redirect step has no resolvable exported target page or URL');
  return {
    stepId: step.id,
    type: 'redirect',
    redirectUrl,
    appendRecordId: field(step, 'redirecturlappendentityidquerystring', false),
    recordQueryName: field(step, 'redirecturlquerystringname'),
    js: step.customJavascript,
    metadata: step,
  };
}

function loadFormStep(step, form, metadata, diagnostics, resolve) {
  const definition = {
    id: step.id,
    name: step.name,
    entityName: field(step, 'targetentitylogicalname', field(step, 'entityname')),
    formName: field(step, 'formname'),
    // PAC omits default-valued columns; the platform default is Insert.
    mode: field(step, 'mode', 100000000),
    metadata: step,
  };
  const diagnosticStart = diagnostics.length;
  const schema = resolve(definition);
  if (schema) {
    schema.stepId = step.id;
    schema.nextStepId = norm(field(step, 'nextstep'));
    schema.js = step.customJavascript;
    schema.metadata = step;
    return schema;
  }
  if (!diagnostics.slice(diagnosticStart).some((item) => item.code === 'SYSTEMFORM_INELIGIBLE_TYPE'))
    diagnostics.push({
      code: 'ADVANCEDFORM_STEP_UNRESOLVED',
      id: step.id,
      form: form.id,
      entity: definition.entityName,
      formName: definition.formName,
      message: 'The exported load step has no matching eligible Dataverse systemform layout.',
    });
  return null;
}

function mapAdvancedStep(step, form, portal, metadata, diagnostics, { componentSchemas, resolve, schemas }) {
  try {
    const type = Number(field(step, 'type', 100000001));
    if (type === 100000000) {
      const schema = conditionStep(step);
      schemas.push(schema);
      componentSchemas[step.id] = schema;
      return;
    }
    if (type === 100000003) {
      schemas.push(redirectStep(step, portal));
      componentSchemas[step.id] = schemas.at(-1);
      return;
    }
    if (![100000001, 100000002].includes(type))
      throw new Error(`Exported multistep type '${type}' is unsupported; it is not a Load Form or Load Tab.`);
    const schema = loadFormStep(step, form, metadata, diagnostics, resolve);
    if (!schema) return;
    schemas.push(schema);
    componentSchemas[step.id] = schema;
  } catch (error) {
    diagnostics.push({ code: 'ADVANCEDFORM_STEP_MAPPING_ERROR', id: step.id, message: error.message });
  }
}

function mapAdvancedForms(portal, metadata, componentSchemas, diagnostics, resolve) {
  for (const form of portal.advancedForms ?? []) {
    const graph = advancedFormGraph(form, portal.records);
    diagnostics.push(...graph.diagnostics);
    const schemas = [];
    for (const step of graph.steps)
      mapAdvancedStep(step, form, portal, metadata, diagnostics, { componentSchemas, resolve, schemas });
    const start = graph.initialStepId;
    const schema = schemas.find((item) => norm(item.stepId) === start);
    if (schema)
      componentSchemas[form.id] = {
        ...schema,
        steps: schemas,
        initialStepId: start,
      };
    else
      diagnostics.push({
        code: 'ADVANCEDFORM_UNRESOLVED',
        id: form.id,
        initialStepId: start || null,
        mappedStepIds: schemas.map((step) => step.stepId),
        message:
          'The declared initial step has no mapped layout in the selected solution sources; another step is not selected instead',
      });
  }
}

export function applySolutionMetadata(portal, metadata) {
  const componentSchemas = {};
  const diagnostics = [...metadata.diagnostics];
  const resolve = (definition) => resolveSystemForm(definition, portal, metadata, diagnostics);
  mapPortalForms(portal, componentSchemas, diagnostics, resolve);
  mapPortalLists(portal, metadata, componentSchemas, diagnostics);
  mapAdvancedForms(portal, metadata, componentSchemas, diagnostics, resolve);
  return {
    componentSchemas,
    diagnostics,
    counts: {
      forms: portal.forms.filter((f) => componentSchemas[f.id]).length,
      formsTotal: portal.forms.length,
      lists: portal.lists.filter((f) => componentSchemas[f.id]).length,
      listsTotal: portal.lists.length,
      advancedForms: (portal.advancedForms ?? []).filter((f) => componentSchemas[f.id]).length,
      solutionForms: metadata.forms.length,
      solutionViews: metadata.views.length,
      entities: Object.keys(metadata.entities).length,
    },
  };
}

// An exported plug-in assembly's bytes: the Solution's PluginAssemblies/<name>-<id>/<name>.dll (its FileName), read from the
// layer that exports the registration (directory or ZIP), its identity checked against the exported name and version. The
// bytes become the assembly row's content, so its steps run them like uploaded content (native n3-solution: an imported
// Solution's steps run). An export without the file (a Power Pages export carries no .dll) or with other bytes is a
// diagnostic and its steps stay placeholders. The side-file hashes of solutionContentFingerprint already cover the files.
const ASSEMBLY_LIMIT = 16 * 1024 * 1024;
function attachSolutionAssemblyContent(plugins, layers) {
  const digest = createHash('sha256').update(plugins.fingerprint ?? '');
  const filesOf = new Map();
  const layerFiles = (layer) => {
    if (!filesOf.has(layer))
      filesOf.set(
        layer,
        new Map(solutionLayerFiles(layer, /^pluginassemblies$/i).map((entry) => [entry.name.toLowerCase(), entry])),
      );
    return filesOf.get(layer);
  };
  const report = (assembly, code, message) =>
    plugins.diagnostics.push({ code, assemblyId: assembly.id, sourceFile: assembly.sourceFile ?? null, message });
  for (const assembly of plugins.assemblies ?? []) {
    const name = String(assembly.binaryPath ?? '')
      .replaceAll('\\', '/')
      .replace(/^\/+/, '');
    if (!name) continue;
    const key = name.toLowerCase();
    const owner = layers.find((layer) => layer.documents?.some((document) => document.file === assembly.sourceFile));
    const entry = (owner ? [owner] : [...layers].reverse()).map((layer) => layerFiles(layer).get(key)).find(Boolean);
    if (!entry) {
      report(
        assembly,
        'PLUGIN_ASSEMBLY_CONTENT_MISSING',
        `The exported assembly file ${name} is not in the Solution source; its steps need uploaded content or a trusted descriptor to run.`,
      );
      continue;
    }
    let bytes, facts;
    try {
      bytes = entry.read(ASSEMBLY_LIMIT);
      facts = inspectAssembly(bytes);
    } catch (error) {
      const reason = error instanceof InvalidAssembly ? 'is not a .NET assembly' : `cannot be read (${error.message})`;
      report(assembly, 'PLUGIN_ASSEMBLY_CONTENT_INVALID', `The exported assembly file ${name} ${reason}.`);
      continue;
    }
    if (
      String(facts.name).toLowerCase() !== String(assembly.name).toLowerCase() ||
      (assembly.version && facts.version !== assembly.version)
    ) {
      report(
        assembly,
        'PLUGIN_ASSEMBLY_CONTENT_INVALID',
        `The exported assembly file ${name} is ${facts.name} ${facts.version}, not the registered ${assembly.name} ${assembly.version ?? ''}.`.trimEnd(),
      );
      continue;
    }
    assembly.content = Buffer.from(bytes).toString('base64');
    digest.update(assembly.id).update(bytes);
  }
  plugins.fingerprint = digest.digest('hex');
  return plugins;
}
