import path from 'node:path';
import fs from 'node:fs';
import { recordedStamp } from '../../lense/file-cache.mjs';
import { normalizePortalPath, portalField, pageTemplateKind, effectiveSnippetRecords } from './importer.mjs';
import { stripLiquidLiteralBlocks } from './liquid-source.mjs';

const id = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const asArray = (value) => {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};
const unique = (items, key = (item) => JSON.stringify(item)) => {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};
const builtinTemplates = new Set([
  'page copy',
  'snippet',
  'entity_list',
  'entity_form',
  'poll',
  'ad',
  'side_navigation',
]);
const recordDescriptor = (record, kind, name, fieldPath) => ({
  kind,
  name: String(name ?? ''),
  sourceFile: record?._file ?? null,
  file: record?._file ?? null,
  relativePath: record?._file ? path.basename(record._file) : null,
  recordId: record?.id ?? null,
  fieldPath: fieldPath ?? null,
});
const sourceFile = (record, suffix) => {
  if (!record?._file) return null;
  if (record._file.toLowerCase().endsWith('powerpagecomponent.xml')) return record._file;
  const body = record._file.replace(/\.ya?ml$/i, `.${suffix}`);
  return fs.existsSync(body) ? body : record._file;
};
const field = (record, name, fallback = null) => portalField(record ?? {}, name, fallback);
const lookup = (rows, value) => {
  const key = id(value);
  if (!key) return null;
  return rows.find((row) => id(row.id) === key) ?? null;
};
const expression = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function componentReference(args, keys) {
  const values = new Map();
  for (const match of args.matchAll(/\b(\w+)\s*:\s*('[^']*'|"[^"]*"|[^\s,]+)/g)) {
    const value = match[2],
      quoted = value.startsWith("'") || value.startsWith('"');
    values.set(match[1].toLowerCase(), { reference: quoted ? value.slice(1, -1) : value.replace(/-?%}$/, ''), quoted });
  }
  const value = keys.map((key) => values.get(key)).find(Boolean);
  return { reference: value?.reference, dynamic: Boolean(value && !value.quoted && !guid.test(value.reference)) };
}

function addStaticReference(collection, unresolved, value, type, text) {
  if (value) collection.push(value);
  else unresolved.push({ kind: type, expression: text, reason: 'Reference is dynamic or has no literal name.' });
}

function collectTemplateReferences(source, exportedTemplateNames, templates, lists, unresolved, usages) {
  const tagRegex = /{%-?\s*(?:include|render|extends|layout)\s+(?:'([^']+)'|"([^"]+)")[^%]*%}/gi;
  for (const match of source.matchAll(tagRegex)) {
    addStaticReference(templates, unresolved, match[1] ?? match[2], 'web-template', match[0]);
    usages.push({ kind: 'include', reference: match[1] ?? match[2], expression: expression(match[0]) });
    if (
      (match[1] ?? match[2]).toLowerCase() === 'entity_list' &&
      !exportedTemplateNames.has('entity_list') &&
      /^\{%-?\s*include\b/i.test(match[0])
    ) {
      const args = match[0].replace(/^\{%-?\s*include\s+(?:'[^']+'|"[^"]+")/i, '');
      const { reference, dynamic } = componentReference(args, ['key']);
      if (dynamic)
        unresolved.push({
          kind: 'entitylist',
          expression: match[0],
          reason: 'Built-in list key uses a Liquid variable and cannot be resolved statically.',
        });
      else addStaticReference(lists, unresolved, reference, 'entitylist', match[0]);
      usages.push({
        kind: 'entitylist',
        reference: dynamic ? null : (reference ?? null),
        expression: expression(match[0]),
        via: 'built-in entity_list',
      });
    }
  }
}

function collectDynamicTemplateReferences(source, unresolved, usages) {
  /* NOSONAR */ for (const match of source.matchAll(/{%-?\s*(?:include|render|extends|layout)\s[^%]*%}/gi))
    if (!/^\{%-?\s*(?:include|render|extends|layout)\s+(?:'[^']+'|"[^"]+")[^%]*%}$/.test(match[0])) {
      unresolved.push({
        kind: 'web-template',
        expression: match[0],
        reason: 'Template reference is dynamic and cannot be resolved statically.',
      });
      usages.push({ kind: 'include', reference: null, expression: expression(match[0]) });
    }
}

// Find candidate closers once, instead of rescanning the suffix for every
// unterminated quoted lookup. The old dot in the value did not cross line breaks.
function* literalReferences(source, candidates) {
  const closers = { "'": [], '"': [] };
  for (const match of source.matchAll(/(['"])\s*\]/g))
    closers[match[1]].push({ start: match.index, end: match.index + match[0].length });
  const lineBreaks = [...source.matchAll(/[\r\n\u2028\u2029]/g)].map((match) => match.index);
  const firstAtOrAfter = (items, position, key = (value) => value) => {
    let low = 0,
      high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (key(items[middle]) < position) low = middle + 1;
      else high = middle;
    }
    return items[low];
  };
  for (let match; (match = candidates.exec(source));) {
    // NOSONAR: preserve cursor and state initialization order
    if (match[2] !== undefined) {
      yield { text: match[0], reference: match[2] };
      continue;
    }
    const start = candidates.lastIndex;
    const close = firstAtOrAfter(closers[match[1]], start, (item) => item.start);
    const lineBreak = firstAtOrAfter(lineBreaks, start);
    if (!close || (lineBreak !== undefined && close.start > lineBreak)) {
      candidates.lastIndex = match.index + 1;
      continue;
    }
    candidates.lastIndex = close.end;
    yield { text: source.slice(match.index, close.end), reference: source.slice(start, close.start) };
  }
}

function collectSnippetReferences(source, snippets, usages) {
  for (const match of literalReferences(source, /snippets\s*(?:\[\s*(['"])|\.([\w.-]+))/gi)) {
    snippets.push(match.reference);
    usages.push({ kind: 'snippet', reference: match.reference, expression: expression(match.text) });
  }
}

function collectDynamicSnippetReferences(source, unresolved, usages) {
  // A match must end at a closing bracket. Excluding the unmatched suffix also
  // prevents each opening bracket in that suffix from rescanning the rest.
  const bracketedSource = source.slice(0, source.lastIndexOf(']') + 1);
  for (const match of bracketedSource.matchAll(/snippets\s*\[([^\]]+)\]/gi))
    if (!/^\s*(['"])[\s\S]*\1\s*$/.test(match[1])) {
      unresolved.push({
        kind: 'content-snippet',
        expression: match[0],
        reason: 'Snippet key is dynamic and cannot be resolved statically.',
      });
      usages.push({ kind: 'snippet', reference: null, expression: expression(match[0]) });
    }
}

function collectEditableReferences(source, snippets, unresolved, usages) {
  for (const match of source.matchAll(/{%-?\s*editable\s+([\w.]+)\b[^%]*%}/gi)) {
    const target = match[1].toLowerCase();
    if (target === 'snippets') {
      const literal = /\bsnippets\s+(?:'([^']+)'|"([^"]+)")/i.exec(match[0]);
      if (literal) addStaticReference(snippets, unresolved, literal[1] ?? literal[2], 'content-snippet', match[0]);
      else
        unresolved.push({
          kind: 'content-snippet',
          expression: match[0],
          reason: 'Editable snippet name is dynamic and cannot be resolved statically.',
        });
      usages.push({
        kind: 'editable',
        reference: literal ? (literal[1] ?? literal[2]) : null,
        target: 'snippet',
        expression: expression(match[0]),
      });
    } else {
      const attribute = /^[\w.]+\s+(?:'([^']+)'|"([^"]+)")/i.exec(match[0].replace(/^{%-?\s*editable\s+/i, ''));
      usages.push({
        kind: 'editable',
        reference: attribute ? (attribute[1] ?? attribute[2]) : null,
        target: match[1],
        expression: expression(match[0]),
      });
    }
  }
}

function collectSettingsReferences(source, settings) {
  for (const match of literalReferences(source, /settings\s*(?:\[\s*(['"])|\.([\w./-]+))/gi))
    settings.push(match.reference);
}

function collectComponentReferences(source, forms, lists, views, unresolved, usages) {
  const component = /{%-?\s*(entityform|entitylist|webform|entityview)\b([^%]*)%}/gi;
  for (const match of source.matchAll(component)) {
    const kind = match[1].toLowerCase();
    let list = forms;
    if (kind === 'entitylist') list = lists;
    else if (kind === 'entityview') list = views;
    const { reference, dynamic } = componentReference(match[2], ['id', 'key', 'name']);
    if (dynamic)
      unresolved.push({
        kind,
        expression: match[0],
        reason: 'Component reference uses a Liquid variable and cannot be resolved statically.',
      });
    else addStaticReference(list, unresolved, reference, kind, match[0]);
    usages.push({ kind, reference: dynamic ? null : (reference ?? null), expression: expression(match[0]) });
  }
}

function consumeFetchToken(item, entityStack, tables, queryTables) {
  if (/^<\/(?:entity|link-entity)/i.test(item[0])) {
    entityStack.pop();
    return;
  }
  const attrs = item[1] ?? item[2] ?? item[3] ?? '';
  const entity = /\bname\s*=\s*(['"])(.*?)\1/i.exec(attrs)?.[2];
  if (/^<entity/i.test(item[0]) || /^<link-entity/i.test(item[0])) {
    const current = entity?.toLowerCase() ?? null;
    entityStack.push(current);
    if (current && !tables.has(current)) tables.set(current, new Set());
    if (current) queryTables.push(current);
    return;
  }
  const column = /\bname\s*=\s*(['"])(.*?)\1/i.exec(attrs)?.[2];
  const current = entityStack.at(-1);
  if (current && column) tables.get(current).add(column);
}

function collectFetchReferences(source, tables, unresolved, usages) {
  const xml = /<fetch\b[\s\S]*?<\/fetch>/gi;
  for (const match of source.matchAll(xml)) {
    const query = match[0];
    const entityStack = [];
    const queryTables = [];
    const token = /<entity\b([^>]*)>|<link-entity\b([^>]*)>|<attribute\b([^>]*)>|<\/entity\s*>|<\/link-entity\s*>/gi;
    for (const item of query.matchAll(token)) consumeFetchToken(item, entityStack, tables, queryTables);
    if (!/<entity\b/i.test(query))
      unresolved.push({
        kind: 'fetchxml-table',
        expression: query.slice(0, 120),
        reason: 'FetchXML entity name could not be resolved statically.',
      });
    usages.push({
      kind: 'fetchxml',
      reference: queryTables[0] ?? null,
      tables: [...new Set(queryTables)],
      expression: expression(query),
    });
  }
}

function extractReferences(source, exportedTemplateNames = new Set()) {
  source = stripLiquidLiteralBlocks(source);
  const templates = [],
    snippets = [],
    settings = [],
    forms = [],
    lists = [],
    views = [];
  const unresolved = [],
    usages = [],
    tables = new Map();
  collectTemplateReferences(source, exportedTemplateNames, templates, lists, unresolved, usages);
  collectDynamicTemplateReferences(source, unresolved, usages);
  collectSnippetReferences(source, snippets, usages);
  collectDynamicSnippetReferences(source, unresolved, usages);
  collectEditableReferences(source, snippets, unresolved, usages);
  collectSettingsReferences(source, settings);
  collectComponentReferences(source, forms, lists, views, unresolved, usages);
  collectFetchReferences(source, tables, unresolved, usages);
  return { templates, snippets, settings, forms, lists, views, tables, unresolved, usages };
}

function addPageTemplate(reference, via, owner, context) {
  const { templateRows, unresolved, webTemplates, dependencies, queue } = context;
  const found = templateRows.find(
    (item) => id(item.id) === id(reference) || item.name?.toLowerCase() === String(reference).toLowerCase(),
  );
  if (!found) {
    unresolved.push({
      kind: 'web-template',
      expression: reference,
      via,
      ...(owner ? { owner } : {}),
      reason: 'No imported web template matches this static reference.',
    });
    return;
  }
  const existing = webTemplates.find((item) => id(item.id) === id(found.id));
  if (existing) {
    if (owner && !existing.includedBy.includes(owner)) existing.includedBy.push(owner);
    return;
  }
  const descriptor = {
    ...recordDescriptor(found.metadata, 'web-template', found.name, 'source'),
    id: found.id,
    via,
    includedBy: owner ? [owner] : [],
    sourceFile: sourceFile(found.metadata, 'source.html') ?? found.metadata?._file ?? null,
    file: sourceFile(found.metadata, 'source.html') ?? found.metadata?._file ?? null,
  };
  webTemplates.push(descriptor);
  dependencies.push(descriptor);
  queue.push({ text: found.source ?? '', owner: `web-template:${id(found.id)}` });
}

function addPageSnippet(reference, via, owner, context) {
  const { snippetRecords, unresolved, snippets, dependencies, sources, portal } = context;
  const key = String(reference ?? '');
  const record = snippetRecords.resolve(key);
  if (!record) {
    unresolved.push({
      kind: 'content-snippet',
      expression: key,
      via,
      ...(owner ? { owner } : {}),
      reason: 'No imported content snippet matches this static reference.',
    });
    return;
  }
  const existing = snippets.find((item) => item.name === record.name);
  if (existing) {
    if (owner && !existing.usedBy.includes(owner)) existing.usedBy.push(owner);
    return;
  }
  const descriptor = {
    ...recordDescriptor(record, 'content-snippet', record.name, 'value'),
    usedBy: owner ? [owner] : [],
  };
  descriptor.sourceFile = sourceFile(record, 'value.html') ?? record._file;
  descriptor.file = descriptor.sourceFile;
  snippets.push(descriptor);
  dependencies.push(descriptor);
  sources.push({ text: portal.snippets?.[record.name] ?? '', owner: `content-snippet:${record.name}` });
}

function addPageTemplateReference(pageTemplate, unresolved, context) {
  if (pageTemplateKind(pageTemplate) === 'rewrite') return;
  if (pageTemplate?.webTemplateId)
    addPageTemplate(pageTemplate.webTemplateId, 'page-template', `page-template:${id(pageTemplate.id)}`, context);
  else if (pageTemplate)
    unresolved.push({
      kind: 'web-template',
      expression: pageTemplate.name,
      via: 'page-template',
      reason: 'Page template has no resolved web-template ID.',
    });
}

function addPageShellReferences(pageTemplate, portal, references, context) {
  if (pageTemplateKind(pageTemplate) !== 'rewrite' && pageTemplate?.useHeaderFooter === false) return;
  const headerId = field(portal.website, 'headerwebtemplateid');
  const footerId = field(portal.website, 'footerwebtemplateid');
  if (headerId) addPageTemplate(headerId, 'website header', 'website-header', context);
  if (footerId) addPageTemplate(footerId, 'website footer', 'website-footer', context);
  for (const name of ['Head/Bottom', 'Browser Title Suffix']) {
    references.snippets.push(name);
    addPageSnippet(name, 'rendered page shell', 'page-shell', context);
  }
}

function addPageComponentReferences(page, references) {
  if (page.formId) references.forms.push(page.formId);
  if (page.advancedFormId) references.forms.push(page.advancedFormId);
  if (page.listId) references.lists.push(page.listId);
}

function scanPageResourceSource(source, context) {
  const { seenSources, templateRows, references, usages, unresolved } = context;
  const { text, owner } = source;
  const key = `${owner}\u0000${text}`;
  if (seenSources.has(key)) return;
  seenSources.add(key);
  const refs = extractReferences(text, new Set(templateRows.map((item) => item.name?.toLowerCase())));
  references.templates.push(...refs.templates);
  references.snippets.push(...refs.snippets);
  references.settings.push(...refs.settings);
  references.forms.push(...refs.forms);
  references.lists.push(...refs.lists);
  references.views.push(...refs.views);
  for (const usage of refs.usages) usages.push({ ...usage, owner });
  for (const reference of refs.snippets) addPageSnippet(reference, 'Liquid snippet', owner, context);
  refs.unresolved.forEach((item) => unresolved.push({ ...item, owner }));
  for (const [entity, fields] of refs.tables) {
    if (!references.tables.has(entity)) references.tables.set(entity, new Set());
    fields.forEach((name) => references.tables.get(entity).add(name));
  }
  for (const ref of refs.templates)
    if (
      !builtinTemplates.has(ref.toLowerCase()) ||
      templateRows.some((item) => item.name?.toLowerCase() === ref.toLowerCase())
    )
      addPageTemplate(ref, 'Liquid include/layout', owner, context);
}

function appendSchemaColumns(component, schema, solutionMetadata, entityNames, columns) {
  for (const item of schema?.fields ?? [])
    if (component.entityName && item.name)
      columns.push({
        entity: component.entityName.toLowerCase(),
        name: item.name,
        sourceFile:
          item.source ?? solutionMetadata.entities?.[component.entityName.toLowerCase()]?.sources?.[0] ?? null,
        fieldPath: item.name,
      });
  for (const step of schema?.steps ?? []) {
    if (step.entity) entityNames.add(step.entity.toLowerCase());
    for (const item of step.fields ?? [])
      if (step.entity && item.name)
        columns.push({
          entity: step.entity.toLowerCase(),
          name: item.name,
          sourceFile: solutionMetadata.entities?.[step.entity.toLowerCase()]?.sources?.[0] ?? null,
          fieldPath: item.name,
        });
  }
}

function appendRecordStepEntities(portal, component, entityNames) {
  for (const step of (portal.records ?? []).filter(
    (record) => record.kind === 'advancedformstep' && id(field(record, 'webform')) === id(component.id),
  )) {
    const entity = field(step, 'targetentitylogicalname', field(step, 'entityname'));
    if (entity) entityNames.add(String(entity).toLowerCase());
  }
}

function appendAdvancedFormSteps(portal, component, sources, components, dependencies) {
  for (const step of (portal.records ?? []).filter(
    (record) => record.kind === 'advancedformstep' && id(field(record, 'webform')) === id(component.id),
  )) {
    const stepFile = sourceFile(step, 'custom_javascript.js') ?? step._file ?? null;
    if (step.customJavascript)
      sources.push({ text: step.customJavascript, owner: `advanced-form-step:${id(step.id)}` });
    const descriptor = {
      ...recordDescriptor(step, 'advanced-form-step', step.name, 'customjavascript'),
      sourceFile: stepFile,
      file: stepFile,
    };
    components.push(descriptor);
    dependencies.push(descriptor);
  }
}

function resolveFormReference(ref, context) {
  const { portal, solutionMetadata, unresolved, forms, components, columns, entityNames, sources, dependencies } =
    context;
  const component = [...(portal.forms ?? []), ...(portal.advancedForms ?? [])].find(
    (item) => id(item.id) === id(ref) || item.name?.toLowerCase() === String(ref).toLowerCase(),
  );
  if (!component) {
    unresolved.push({ kind: 'form', expression: ref, reason: 'No imported form matches this static reference.' });
    return;
  }
  if (forms.some((item) => id(item.id) === id(component.id))) return;
  forms.push(component);
  const advanced = component.metadata?.kind === 'advancedform';
  const owner = `${advanced ? 'advanced-form' : 'basic-form'}:${id(component.id)}`;
  if (component.js) sources.push({ text: component.js, owner });
  if (component.entityName) entityNames.add(component.entityName.toLowerCase());
  const schema =
    solutionMetadata.componentSchemas?.[component.id] ?? solutionMetadata.componentSchemas?.[component.name];
  appendSchemaColumns(component, schema, solutionMetadata, entityNames, columns);
  appendRecordStepEntities(portal, component, entityNames);
  const descriptor = recordDescriptor(
    component.metadata,
    advanced ? 'advanced-form' : 'basic-form',
    component.name,
    'customjavascript',
  );
  descriptor.sourceFile = sourceFile(component.metadata, 'custom_javascript.js') ?? component.metadata?._file ?? null;
  descriptor.file = descriptor.sourceFile;
  components.push(descriptor);
  dependencies.push(descriptor);
  if (advanced) appendAdvancedFormSteps(portal, component, sources, components, dependencies);
}

/* NOSONAR */ function resolveListReference(ref, context) {
  const { portal, unresolved, components, entityNames, sources, references, dependencies } = context;
  const component = (portal.lists ?? []).find(
    (item) => id(item.id) === id(ref) || item.name?.toLowerCase() === String(ref).toLowerCase(),
  );
  if (!component) {
    unresolved.push({ kind: 'list', expression: ref, reason: 'No imported list matches this static reference.' });
    return;
  }
  if (components.some((item) => item.kind === 'list' && id(item.recordId) === id(component.id))) return;
  if (component.js) sources.push({ text: component.js, owner: `list:${id(component.id)}` });
  if (component.entityName) entityNames.add(component.entityName.toLowerCase());
  const descriptor = {
    ...recordDescriptor(component.metadata, 'list', component.name, 'customjavascript'),
    entity: component.entityName ?? null,
    sourceFile: sourceFile(component.metadata, 'custom_javascript.js') ?? component.metadata?._file ?? null,
    file: sourceFile(component.metadata, 'custom_javascript.js') ?? component.metadata?._file ?? null,
  };
  components.push(descriptor);
  dependencies.push(descriptor);
  const viewValues = [];
  for (let value of [field(component.metadata, 'view'), field(component.metadata, 'views')]) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
      }
    }
    viewValues.push(...asArray(value?.Views ?? value?.views ?? value));
  }
  for (const viewId of viewValues) {
    const value =
      viewId && typeof viewId === 'object' ? (viewId.ViewId ?? viewId.viewId ?? viewId.id ?? viewId.value) : viewId;
    if (value) references.views.push(String(value));
  }
}

function resolveViewReference(reference, context) {
  const { solutionMetadata, unresolved, views, components, entityNames, columns, dependencies } = context;
  const view = (solutionMetadata.views ?? []).find((item) => id(item.id) === id(reference) || item.name === reference);
  if (!view) {
    unresolved.push({
      kind: 'view',
      expression: reference,
      reason: 'View source is absent from imported solution metadata.',
    });
    return;
  }
  if (views.some((item) => id(item.id) === id(view.id))) return;
  views.push(view);
  entityNames.add(view.entity.toLowerCase());
  const descriptor = {
    kind: 'view',
    name: view.name,
    id: view.id,
    entity: view.entity,
    sourceFile: view.file,
    file: view.file,
    relativePath: view.file ? path.basename(view.file) : null,
    recordId: view.id,
    fieldPath: 'fetchXml',
  };
  components.push(descriptor);
  dependencies.push(descriptor);
  (view.fields ?? []).forEach((item) => {
    const column = solutionMetadata.entities?.[view.entity]?.fields?.[item.name];
    columns.push({
      entity: view.entity,
      name: item.name,
      width: item.width,
      source: column?.source,
      sourceFile: column?.source,
      recordId: view.id,
      fieldPath: 'layoutxml',
    });
  });
}

function appendTableColumns(references, columns, entityNames, solutionMetadata) {
  for (const [entity, selected] of references.tables) {
    entityNames.add(entity);
    selected.forEach((name) =>
      columns.push({
        entity,
        name,
        sourceFile: solutionMetadata.entities?.[entity]?.sources?.[0] ?? null,
        fieldPath: name,
      }),
    );
  }
}

function addTableDescriptors(entityNames, solutionMetadata, tables, columns, unresolved, dependencies) {
  for (const entity of entityNames) {
    const metadata = solutionMetadata.entities?.[entity];
    const descriptor = {
      kind: 'table',
      name: entity,
      logicalName: entity,
      sourceFile: metadata?.sources?.[0] ?? null,
      file: metadata?.sources?.[0] ?? null,
      sourceFiles: metadata?.sources ?? [],
      columns: Object.keys(metadata?.fields ?? {}).filter((name) =>
        columns.some((column) => column.entity === entity && column.name === name),
      ),
    };
    tables.push(descriptor);
    dependencies.push(descriptor);
    if (!metadata)
      unresolved.push({
        kind: 'table',
        expression: entity,
        reason: 'No imported solution table metadata matches this dependency.',
      });
  }
}

function resolveSettingReferences(settingNames, tableNames, portal, unresolved, siteSettings, dependencies) {
  for (const name of Object.keys(portal.settings ?? {}))
    if (/^webapi\//i.test(name) && tableNames.has(name.split('/')[1].toLowerCase())) settingNames.add(name);
  for (const name of settingNames) {
    const record = (portal.records ?? []).find((item) => item.kind === 'sitesetting' && item.name === name);
    if (!record) {
      unresolved.push({
        kind: 'site-setting',
        expression: name,
        reason: 'No imported site setting matches this static reference.',
      });
      continue;
    }
    const descriptor = recordDescriptor(record, 'site-setting', record.name, 'value');
    siteSettings.push(descriptor);
    dependencies.push(descriptor);
  }
}

function drainPageSources(sources, queue, context) {
  let scanned = 0;
  for (; scanned < sources.length || queue.length; scanned++) {
    if (scanned >= sources.length) sources.push(queue.shift());
    while (queue.length) sources.push(queue.shift());
    scanPageResourceSource(sources[scanned], context);
  }
}

function makeRelativeSource(portal, file) {
  return file && portal.sourceDir ? path.relative(portal.sourceDir, file) : null;
}

function applyResourceRelativePaths(descriptors, portal) {
  for (const descriptor of descriptors)
    if (descriptor.sourceFile && portal.sourceDir)
      descriptor.relativePath = path.relative(portal.sourceDir, descriptor.sourceFile);
}

function describeFormResource(item, portal, solutionMetadata) {
  const relative = (file) => makeRelativeSource(portal, file);
  const schema = solutionMetadata.componentSchemas?.[item.id] ?? solutionMetadata.componentSchemas?.[item.name];
  const sourceSteps = (portal.records ?? []).filter(
    (record) => record.kind === 'advancedformstep' && id(field(record, 'webform')) === id(item.id),
  );
  const steps = unique(
    [
      ...sourceSteps.map((step) => ({
        id: step.id,
        name: step.name,
        entity: field(step, 'targetentitylogicalname', field(step, 'entityname')) ?? null,
        formName: field(step, 'formname') ?? null,
        mode: field(step, 'mode', null),
        sourceFile: sourceFile(step, 'custom_javascript.js') ?? step._file ?? null,
      })),
      ...(schema?.steps ?? []).map((step) => ({
        id: step.stepId,
        name: step.title ?? null,
        entity: step.entity ?? null,
        formName: step.formName ?? null,
        mode: step.mode ?? null,
        sourceFile: step.metadata?._file ?? null,
      })),
    ],
    (step) => id(step.id),
  );
  const source = item.metadata?._file ?? null;
  const advanced = item.metadata?.kind === 'advancedform';
  return {
    id: item.id,
    name: item.name,
    kind: advanced ? 'advanced-form' : 'basic-form',
    entity: item.entityName ?? steps.find((step) => step.entity)?.entity ?? null,
    formName: item.formName ?? schema?.formName ?? null,
    mode: item.mode ?? schema?.mode ?? null,
    steps: steps.map((step) => {
      const stepSchema = solutionMetadata.componentSchemas?.[step.id];
      return {
        ...step,
        formXml: stepSchema?.sourceFile
          ? { id: stepSchema.formId ?? null, name: stepSchema.formName ?? null, sourceFile: stepSchema.sourceFile }
          : null,
        relativePath: relative(step.sourceFile),
      };
    }),
    formXml:
      schema?.sourceFile && !advanced
        ? { id: schema.formId ?? null, name: schema.formName ?? null, sourceFile: schema.sourceFile }
        : null,
    sourceFile: source,
    relativePath: relative(source),
    recordId: item.id,
  };
}

function describeViewResource(item, portal) {
  return {
    id: item.id,
    name: item.name,
    entity: item.entity,
    sourceFile: item.file,
    relativePath: makeRelativeSource(portal, item.file),
    fields: item.fields ?? [],
  };
}

/** Resolve the static imported runtime graph for a portal route without rendering or writing. */
export function resolvePageResources(portal, route, { solutionMetadata = {} } = {}) {
  const normalized = normalizePortalPath(route);
  let page = (portal.pages ?? []).find((candidate) => normalizePortalPath(candidate.url) === normalized);
  const missingPage = !page;
  page ??= { id: null, url: normalized, html: '', js: '', css: '' };

  const dependencies = [],
    unresolved = missingPage
      ? [{ kind: 'page', expression: normalized, reason: 'No imported page matches this route.' }]
      : [],
    webTemplates = [],
    snippets = [],
    siteSettings = [],
    forms = [],
    views = [],
    tables = [],
    columns = [],
    components = [],
    usages = [];
  const add = (collection, descriptor) => {
    if (!descriptor) return;
    collection.push(descriptor);
    dependencies.push(descriptor);
  };
  const pageRecord = page.metadata;
  const pageDescriptor = {
    ...recordDescriptor(pageRecord, 'page', page.title || page.name, 'copy'),
    id: page.id,
    url: page.url,
    sourceFile: sourceFile(pageRecord, 'copy.html') ?? pageRecord?._file ?? null,
    file: sourceFile(pageRecord, 'copy.html') ?? pageRecord?._file ?? null,
  };
  if (!missingPage) add(components, pageDescriptor);

  const pageTemplate = lookup(portal.pageTemplates ?? [], page.pageTemplateId);
  if (page.pageTemplateId && !pageTemplate)
    unresolved.push({
      kind: 'page-template',
      expression: page.pageTemplateId,
      reason: 'The page template ID is absent from the imported portal.',
    });
  if (pageTemplate)
    add(components, {
      ...recordDescriptor(pageTemplate.metadata, 'page-template', pageTemplate.name, 'pagetemplate'),
      id: pageTemplate.id,
      webTemplateId: pageTemplate.webTemplateId,
    });

  // Every scanned source keeps its owner so inspections can present include chains.
  const queue = [];
  const templateRows = unique(Object.values(portal.templates ?? {}), (item) => id(item.id));
  const graphContext = {
    portal,
    solutionMetadata,
    dependencies,
    unresolved,
    webTemplates,
    snippets,
    views,
    queue,
    templateRows,
  };
  addPageTemplateReference(pageTemplate, unresolved, graphContext);

  const sources = [
    { text: page.html ?? '', owner: 'page' },
    { text: page.js ?? '', owner: 'page' },
    { text: page.css ?? '', owner: 'page' },
  ];
  const references = { templates: [], snippets: [], settings: [], forms: [], lists: [], views: [], tables: new Map() };
  const snippetRecords = effectiveSnippetRecords(
    portal.records ?? [],
    portal.selectedLanguageId ?? field(portal.website ?? {}, 'defaultlanguage'),
  );
  Object.assign(graphContext, {
    snippetRecords,
    sources,
    references,
    usages,
    seenSources: new Set(),
  });
  addPageShellReferences(pageTemplate, portal, references, graphContext);
  addPageComponentReferences(page, references);
  drainPageSources(sources, queue, graphContext);

  const entityNames = new Set(references.tables.keys());
  Object.assign(graphContext, { forms, components, columns, entityNames });
  for (const ref of references.forms) resolveFormReference(ref, graphContext);
  for (const ref of references.lists) resolveListReference(ref, graphContext);
  drainPageSources(sources, queue, graphContext);
  const settingNames = new Set(references.settings);
  for (const entity of references.tables.keys()) entityNames.add(entity);
  for (const reference of unique(references.views)) resolveViewReference(reference, graphContext);
  appendTableColumns(references, columns, entityNames, solutionMetadata);
  addTableDescriptors(entityNames, solutionMetadata, tables, columns, unresolved, dependencies);
  const tableNames = new Set(entityNames);
  resolveSettingReferences(settingNames, tableNames, portal, unresolved, siteSettings, dependencies);
  const allColumns = unique(columns, (item) => `${item.entity}/${item.name}`);
  applyResourceRelativePaths(
    [
      ...dependencies,
      ...forms,
      ...views,
      ...columns,
      ...tables,
      pageDescriptor,
      ...(pageTemplate ? [pageTemplate] : []),
    ],
    portal,
  );
  const resolvedPageTemplate = pageTemplate
    ? {
        ...recordDescriptor(pageTemplate.metadata, 'page-template', pageTemplate.name, 'pagetemplate'),
        id: pageTemplate.id,
        webTemplateId: pageTemplate.webTemplateId,
        useHeaderFooter: pageTemplate.useHeaderFooter !== false,
      }
    : null;
  if (resolvedPageTemplate?.sourceFile && portal.sourceDir)
    resolvedPageTemplate.relativePath = path.relative(portal.sourceDir, resolvedPageTemplate.sourceFile);
  return {
    path: normalized,
    sourceRoots: [...new Set([portal.sourceDir, ...(solutionMetadata.roots ?? [])].filter(Boolean))],
    page: missingPage ? null : pageDescriptor,
    pageTemplate: resolvedPageTemplate,
    webTemplates,
    snippets,
    siteSettings,
    forms: unique(forms, (item) => id(item.id)).map((item) => describeFormResource(item, portal, solutionMetadata)),
    views: unique(views, (item) => id(item.id)).map((item) => describeViewResource(item, portal)),
    tables,
    columns: allColumns,
    components,
    usages: unique(usages, (item) => `${item.owner}/${item.kind}/${item.expression}`),
    dependencies: unique(dependencies, (item) => `${item.kind}/${item.recordId ?? item.sourceFile}/${item.fieldPath}`),
    unresolved: unique(unresolved),
  };
}

const displayNameCache = new Map();
/** Entity display name from its Solution XML: entity-level LocalizedNames, else the Name label. */
function tableDisplayName(files = []) {
  let name = null;
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = displayNameCache.get(file);
    let value = cached?.stamp === stamp ? cached.value : undefined;
    if (value === undefined) {
      try {
        const xml = fs.readFileSync(file, 'utf8');
        const block = /<LocalizedNames>([\s\S]*?)<\/LocalizedNames>/.exec(xml)?.[1] ?? '';
        value =
          /<LocalizedName\b[^>]*\bdescription="([^"]*)"[^>]*\blanguagecode="1033"/i.exec(block)?.[1] ??
          /<LocalizedName\b[^>]*\bdescription="([^"]*)"/i.exec(block)?.[1] ??
          /<Name\b[^>]*\bLocalizedName="([^"]*)"/.exec(xml.slice(0, 4096))?.[1] ??
          null;
      } catch {
        value = null;
      }
      displayNameCache.set(file, { stamp: recordedStamp(stat, stamp), value });
    }
    if (value) name = value;
  }
  return name;
}

const rightLabel = (right) => ({ 1: 'Grant change', 2: 'Restrict read' })[right] ?? 'Unresolved right';
const scopeLabel = (scope) => ({ 1: 'All content', 2: 'Exclude direct child web files' })[scope] ?? 'Unresolved scope';
const truth = (value) => value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
const preview = (value, limit = 280) => {
  if (value == null) return null;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

function ancestorPages(portal, page) {
  const chain = [];
  const seen = new Set();
  let current = page;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parentId = current.parentId;
    current = (portal.pages ?? []).find((candidate) => candidate.id === parentId);
  }
  return chain;
}

/** Page access rules on the page branch with role names and the current persona's match. */
export function pageAccessRules(portal, page, identity = {}, overrides = {}) {
  const ancestors = ancestorPages(portal, page);
  const roles = new Map(
    (portal.records ?? [])
      .filter((record) => record.kind === 'webrole' && Number(field(record, 'statecode', 0)) !== 1)
      .map((record) => [id(record.id), record.name]),
  );
  const identityRoleIds = new Set((identity?.roleIds ?? []).map(id));
  const identityRoles = new Set(identity?.roles ?? []);
  return (portal.records ?? [])
    .filter((record) => record.kind === 'webpageaccesscontrolrule' && Number(field(record, 'statecode', 0)) !== 1)
    .map((record) => {
      const root = id(field(record, 'webpageid'));
      const owner = ancestors.find((candidate) => id(candidate.id) === root);
      if (!owner) return null;
      const associated = field(record, 'webpageaccesscontrolrule_webrole', []);
      const roleIds = asArray(associated)
        .map((value) =>
          id(typeof value === 'object' ? (value.id ?? value.adx_webroleid ?? value.mspp_webroleid) : value),
        )
        .filter(Boolean);
      const right = Number(field(record, 'right'));
      const scope = Number(field(record, 'scope', 1));
      return {
        id: record.id,
        name: record.name || record.id,
        right,
        rightLabel: rightLabel(right),
        scope,
        scopeLabel: scopeLabel(scope),
        roles: roleIds.map((roleId) => ({ id: roleId, name: roles.get(roleId) ?? null, resolved: roles.has(roleId) })),
        page: { id: owner.id, name: owner.name, url: owner.url },
        inherited: id(owner.id) !== id(page.id),
        matches: roleIds.some(
          (roleId) =>
            roles.has(roleId) &&
            (identity?.roleSource === 'memberships'
              ? identityRoleIds.has(roleId)
              : identityRoleIds.has(roleId) || identityRoles.has(roles.get(roleId))),
        ),
        overridden: Object.hasOwn(overrides.accessRules ?? {}, record.id),
        sourceFile: record._file ?? null,
      };
    })
    .filter(Boolean);
}

/** Records that point at a page: web links, site markers, redirects and shortcuts. */
function relatedMetadata(portal, page) {
  const pageId = id(page.id);
  const records = portal.records ?? [];
  const active = (record) => Number(field(record, 'statecode', 0)) !== 1;
  const sets = new Map(
    records.filter((record) => record.kind === 'weblinkset').map((record) => [id(record.id), record]),
  );
  const weblinks = records
    .filter((record) => record.kind === 'weblink' && active(record) && id(field(record, 'pageid')) === pageId)
    .map((record) => {
      const set = sets.get(id(field(record, 'weblinksetid')));
      return {
        id: record.id,
        name: record.name,
        set: set?.name ?? null,
        setId: set?.id ?? null,
        displayOrder: Number(field(record, 'displayorder', 0)),
        sourceFile: record._file ?? null,
      };
    })
    .sort((a, b) => String(a.set).localeCompare(String(b.set)) || a.displayOrder - b.displayOrder);
  const sitemarkers = records
    .filter((record) => record.kind === 'sitemarker' && active(record) && id(field(record, 'pageid')) === pageId)
    .map((record) => ({ id: record.id, name: record.name, sourceFile: record._file ?? null }));
  const pagePath = normalizePortalPath(page.url);
  const redirects = [
    ...records.filter(
      (record) =>
        record.kind === 'redirect' &&
        active(record) &&
        (id(field(record, 'webpageid')) === pageId ||
          (field(record, 'redirecturl') && normalizePortalPath(String(field(record, 'redirecturl'))) === pagePath)),
    ),
    ...(Array.isArray(portal.redirects)
      ? portal.redirects.filter(
          (item) =>
            id(item.pageId ?? item.webPageId) === pageId ||
            (item.redirectUrl && normalizePortalPath(item.redirectUrl) === pagePath),
        )
      : []),
  ].map((item) => ({
    id: item.id,
    name: item.name ?? null,
    inboundUrl: item.inboundUrl ?? field(item, 'inboundurl'),
    statusCode: Number(item.statusCode ?? field(item, 'statuscode', 302)) || null,
    sourceFile: item._file ?? item.file ?? item.sourceFile ?? null,
  }));
  const shortcuts = (portal.shortcuts ?? [])
    .filter((shortcut) => id(shortcut.targetPageId) === pageId)
    .map((shortcut) => ({
      id: shortcut.id,
      name: shortcut.name,
      title: shortcut.title,
      sourceFile: shortcut.metadata?._file ?? null,
    }));
  return { weblinks, sitemarkers, redirects: unique(redirects, (item) => id(item.id)), shortcuts };
}

/** Ordered include chain from page-template, header/footer, shell and page-copy roots. */
function templateChain(report) {
  const rows = [];
  const byOwner = (items, key) => {
    const map = new Map();
    for (const item of items)
      for (const owner of item[key] ?? []) {
        if (!map.has(owner)) map.set(owner, []);
        map.get(owner).push(item);
      }
    return map;
  };
  const templatesByOwner = byOwner(report.webTemplates, 'includedBy');
  const snippetsByOwner = byOwner(report.snippets, 'usedBy');
  const visited = new Set();
  const descend = (owner, depth) => {
    for (const template of templatesByOwner.get(owner) ?? []) {
      const key = `web-template:${id(template.id)}`;
      const repeated = visited.has(key);
      rows.push({
        depth,
        kind: 'web-template',
        name: template.name,
        id: template.id,
        via: template.via,
        sourceFile: template.sourceFile,
        relativePath: template.relativePath,
        fieldPath: template.fieldPath ?? null,
        repeated,
      });
      if (repeated) continue;
      visited.add(key);
      descend(key, depth + 1);
    }
    for (const snippet of snippetsByOwner.get(owner) ?? []) {
      const key = `content-snippet:${snippet.name}`;
      const repeated = visited.has(key);
      rows.push({
        depth,
        kind: 'content-snippet',
        name: snippet.name,
        sourceFile: snippet.sourceFile,
        relativePath: snippet.relativePath,
        fieldPath: snippet.fieldPath ?? null,
        repeated,
      });
      if (repeated) continue;
      visited.add(key);
      descend(key, depth + 1);
    }
  };
  if (report.pageTemplate) {
    rows.push({
      depth: 0,
      kind: 'page-template',
      name: report.pageTemplate.name,
      id: report.pageTemplate.id,
      sourceFile: report.pageTemplate.sourceFile,
      relativePath: report.pageTemplate.relativePath,
    });
    descend(`page-template:${id(report.pageTemplate.id)}`, 1);
  }
  for (const [owner, label] of [
    ['website-header', 'Website header'],
    ['website-footer', 'Website footer'],
    ['page-shell', 'Rendered page shell'],
    ['page', 'Page copy, JavaScript and CSS'],
  ]) {
    if (!templatesByOwner.has(owner) && !snippetsByOwner.has(owner)) continue;
    rows.push({ depth: 0, kind: 'root', name: label, owner });
    descend(owner, 1);
  }
  for (const component of report.components.filter((item) =>
    ['basic-form', 'advanced-form', 'advanced-form-step', 'list'].includes(item.kind),
  )) {
    const owner = `${component.kind}:${id(component.recordId)}`;
    if (!templatesByOwner.has(owner) && !snippetsByOwner.has(owner)) continue;
    rows.push({
      depth: 0,
      kind: 'root',
      name: `${component.name} (${component.kind.replaceAll('-', ' ')} JavaScript)`,
      owner,
      sourceFile: component.sourceFile,
      relativePath: component.relativePath,
    });
    descend(owner, 1);
  }
  return rows;
}

function applyTableInspection(report, solutionMetadata, mapping, tablePermissions) {
  for (const table of report.tables) {
    const metadata = solutionMetadata.entities?.[table.logicalName];
    const mapped = mapping(table.logicalName);
    table.displayName = tableDisplayName(metadata?.sources ?? []);
    table.entitySet = mapped?.entitySet ?? null;
    table.entitySetInferred = mapped ? Boolean(mapped.entitySetInferred) : null;
    table.idColumn = mapped?.idColumn ?? null;
    table.nameColumn = mapped?.nameColumn ?? null;
    table.mapped = Boolean(mapped);
    table.fieldCount = Object.keys(metadata?.fields ?? {}).length;
    table.permissions = tablePermissions(table.logicalName);
  }
}

function applyColumnInspection(report, solutionMetadata) {
  for (const column of report.columns) {
    const metadata = solutionMetadata.entities?.[column.entity]?.fields?.[column.name];
    if (!metadata) {
      column.resolved = false;
      continue;
    }
    Object.assign(column, {
      resolved: true,
      label: metadata.label ?? null,
      type: metadata.dataverseType ?? metadata.type ?? null,
      required: Boolean(metadata.required),
      maxLength: metadata.maxLength ?? null,
      optionSetName: metadata.optionSetName ?? null,
      optionCount: Array.isArray(metadata.options) ? metadata.options.length : 0,
      options: Array.isArray(metadata.options)
        ? metadata.options.slice(0, 12).map((option) => ({ value: option.value, label: option.label }))
        : [],
    });
  }
}

function applySnippetInspection(report, portal, sourcePortal, overrides) {
  for (const snippet of report.snippets) {
    const name = snippet.name;
    snippet.value = preview(portal.snippets?.[name]);
    snippet.sourceValue = preview(sourcePortal.snippets?.[name]);
    snippet.overridden = Object.hasOwn(overrides.snippets ?? {}, name);
    snippet.deleted = !Object.hasOwn(portal.snippets ?? {}, name);
  }
}

function applySettingInspection(report, portal, sourcePortal, overrides) {
  // A setting bound to a Secret environment variable is classified by name: inspection never prints the bound value.
  const secretNames = new Set(portal.secretSettingNames ?? []);
  for (const setting of report.siteSettings) {
    const name = setting.name;
    const secret = secretNames.has(name);
    setting.value = secret ? '[secret]' : preview(portal.settings?.[name], 400);
    setting.sourceValue = secret ? '[secret]' : preview(sourcePortal.settings?.[name], 400);
    if (secret) setting.secret = true;
    setting.overridden = Object.hasOwn(overrides.settings ?? {}, name);
    setting.deleted = !Object.hasOwn(portal.settings ?? {}, name);
  }
}

/**
 * Inspect a route for development tools: the static dependency graph plus the current
 * persona's runtime view (page access, table permissions), effective local values and
 * metadata that points at the page. Reads local files only; renders and writes nothing.
 */
export function inspectPage(
  portal,
  route,
  {
    solutionMetadata = {},
    sourcePortal = portal,
    overrides = {},
    identity = null,
    access = null,
    mapping = () => null,
    tablePermissions = () => null,
  } = {},
) {
  const report = resolvePageResources(portal, route, { solutionMetadata });
  const page = (portal.pages ?? []).find((candidate) => normalizePortalPath(candidate.url) === report.path);
  if (!page)
    return { ...report, templateChain: [], related: { weblinks: [], sitemarkers: [], redirects: [], shortcuts: [] } };
  const publishingStateId = id(field(page.metadata, 'publishingstateid'));
  const publishingState = publishingStateId
    ? (portal.records ?? []).find((record) => record.kind === 'publishingstate' && id(record.id) === publishingStateId)
    : null;
  const parent = (portal.pages ?? []).find((candidate) => candidate.id === page.parentId);
  const accessResult = access ? access(page) : null;
  report.page = {
    ...report.page,
    title: page.title ?? null,
    pageName: page.name ?? null,
    parent: parent ? { id: parent.id, name: parent.name, url: parent.url } : null,
    pageTemplateName: report.pageTemplate?.name ?? null,
    publishingState: publishingStateId
      ? {
          id: publishingStateId,
          name: publishingState?.name ?? null,
          visible: publishingState ? truth(field(publishingState, 'isvisible', true)) : null,
          resolved: Boolean(publishingState),
        }
      : null,
    access: {
      ...(accessResult
        ? {
            allowed: accessResult.allowed,
            status: accessResult.status,
            code: accessResult.code ?? null,
            reason: accessResult.reason ?? null,
            ruleIds: accessResult.ruleIds ?? [],
            diagnostics: accessResult.diagnostics ?? [],
          }
        : {}),
      rules: pageAccessRules(portal, page, identity ?? {}, overrides),
    },
  };
  applyTableInspection(report, solutionMetadata, mapping, tablePermissions);
  applyColumnInspection(report, solutionMetadata);
  applySnippetInspection(report, portal, sourcePortal, overrides);
  applySettingInspection(report, portal, sourcePortal, overrides);
  return { ...report, templateChain: templateChain(report), related: relatedMetadata(portal, page) };
}
