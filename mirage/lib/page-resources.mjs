import path from "node:path";
import fs from "node:fs";
import { normalizePortalPath, portalField } from "./importer.mjs";

const id = (value) =>
  String(value?.id ?? value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
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
  "page copy", "snippet", "entity_list", "entity_form", "poll", "ad", "side_navigation",
]);
const recordDescriptor = (record, kind, name, fieldPath) => ({
  kind,
  name: String(name ?? ""),
  sourceFile: record?._file ?? null,
  file: record?._file ?? null,
  relativePath: record?._file ? path.basename(record._file) : null,
  recordId: record?.id ?? null,
  fieldPath: fieldPath ?? null,
});
const sourceFile = (record, suffix) => {
  if (!record?._file) return null;
  if (record._file.toLowerCase().endsWith("powerpagecomponent.xml"))
    return record._file;
  const body = record._file.replace(/\.ya?ml$/i, `.${suffix}`);
  return fs.existsSync(body) ? body : record._file;
};
const field = (record, name, fallback = null) =>
  portalField(record ?? {}, name, fallback);
const lookup = (rows, value) => {
  const key = id(value);
  if (!key) return null;
  return rows.find((row) => id(row.id) === key) ?? null;
};
const expression = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);

function extractReferences(source) {
  const templates = [], snippets = [], settings = [], forms = [], lists = [], views = [];
  const unresolved = [], usages = [];
  const addStatic = (collection, value, type, text) => {
    if (value) collection.push(value);
    else unresolved.push({ kind: type, expression: text, reason: "Reference is dynamic or has no literal name." });
  };
  const tagRegex = /{%[-]?\s*(?:include|render|extends|layout)\s+(?:'([^']+)'|"([^"]+)")[^%]*%}/gi;
  for (const match of source.matchAll(tagRegex)) {
    addStatic(templates, match[1] ?? match[2], "web-template", match[0]);
    usages.push({ kind: "include", reference: match[1] ?? match[2], expression: expression(match[0]) });
  }
  for (const match of source.matchAll(/{%[-]?\s*(?:include|render|extends|layout)\s+[^%]*%}/gi))
    if (!/^\{%[-]?\s*(?:include|render|extends|layout)\s+(?:'[^']+'|"[^"]+")[^%]*%}$/.test(match[0])) {
      unresolved.push({ kind: "web-template", expression: match[0], reason: "Template reference is dynamic and cannot be resolved statically." });
      usages.push({ kind: "include", reference: null, expression: expression(match[0]) });
    }
  for (const match of source.matchAll(/snippets\s*(?:\[\s*(['"])(.*?)\1\s*\]|\.([\w.-]+))/gi)) {
    snippets.push(match[2] ?? match[3]);
    usages.push({ kind: "snippet", reference: match[2] ?? match[3], expression: expression(match[0]) });
  }
  for (const match of source.matchAll(/snippets\s*\[([^\]]+)\]/gi))
    if (!/^\s*(['"])[\s\S]*\1\s*$/.test(match[1])) {
      unresolved.push({ kind: "content-snippet", expression: match[0], reason: "Snippet key is dynamic and cannot be resolved statically." });
      usages.push({ kind: "snippet", reference: null, expression: expression(match[0]) });
    }
  for (const match of source.matchAll(/{%[-]?\s*editable\s+([\w.]+)\b[^%]*%}/gi)) {
    const target = match[1].toLowerCase();
    if (target === "snippets") {
      const literal = /\bsnippets\s+(?:'([^']+)'|"([^"]+)")/i.exec(match[0]);
      if (literal) addStatic(snippets, literal[1] ?? literal[2], "content-snippet", match[0]);
      else unresolved.push({ kind: "content-snippet", expression: match[0], reason: "Editable snippet name is dynamic and cannot be resolved statically." });
      usages.push({ kind: "editable", reference: literal ? literal[1] ?? literal[2] : null, target: "snippet", expression: expression(match[0]) });
    } else {
      const attribute = /^[\w.]+\s+(?:'([^']+)'|"([^"]+)")/i.exec(match[0].replace(/^{%[-]?\s*editable\s+/i, ""));
      usages.push({ kind: "editable", reference: attribute ? attribute[1] ?? attribute[2] : null, target: match[1], expression: expression(match[0]) });
    }
  }
  for (const match of source.matchAll(/settings\s*(?:\[\s*(['"])(.*?)\1\s*\]|\.([\w./-]+))/gi))
    settings.push(match[2] ?? match[3]);
  const component = /{%[-]?\s*(entityform|entitylist|webform|entityview)\b([^%]*)%}/gi;
  for (const match of source.matchAll(component)) {
    const kind = match[1].toLowerCase();
    const value = /\b(?:id|key|name)\s*:\s*(?:'([^']+)'|"([^"]+)"|([\w.-]+))/i.exec(match[2]);
    const list = kind === "entitylist" ? lists : kind === "entityview" ? views : forms;
    const reference = value?.[1] ?? value?.[2] ?? value?.[3];
    const dynamic = Boolean(reference && !value?.[1] && !value?.[2] && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(reference));
    if (dynamic)
      unresolved.push({ kind, expression: match[0], reason: "Component reference uses a Liquid variable and cannot be resolved statically." });
    else addStatic(list, reference, kind, match[0]);
    usages.push({ kind, reference: dynamic ? null : reference ?? null, expression: expression(match[0]) });
  }
  const xml = /<fetch\b[\s\S]*?<\/fetch>/gi;
  const tables = new Map();
  for (const match of source.matchAll(xml)) {
    const query = match[0];
    const entityStack = [];
    const queryTables = [];
    const token = /<entity\b([^>]*)>|<link-entity\b([^>]*)>|<attribute\b([^>]*)>|<\/entity\s*>|<\/link-entity\s*>/gi;
    for (const item of query.matchAll(token)) {
      if (/^<\/(?:entity|link-entity)/i.test(item[0])) { entityStack.pop(); continue; }
      const attrs = item[1] ?? item[2] ?? item[3] ?? "";
      const entity = /\bname\s*=\s*(['"])(.*?)\1/i.exec(attrs)?.[2];
      if (/^<entity/i.test(item[0]) || /^<link-entity/i.test(item[0])) {
        const current = entity?.toLowerCase() ?? null;
        entityStack.push(current);
        if (current && !tables.has(current)) tables.set(current, new Set());
        if (current) queryTables.push(current);
      } else {
        const column = /\bname\s*=\s*(['"])(.*?)\1/i.exec(attrs)?.[2];
        const current = entityStack.at(-1);
        if (current && column) tables.get(current).add(column);
      }
    }
    if (!/<entity\b/i.test(query)) unresolved.push({ kind: "fetchxml-table", expression: query.slice(0, 120), reason: "FetchXML entity name could not be resolved statically." });
    usages.push({ kind: "fetchxml", reference: queryTables[0] ?? null, tables: [...new Set(queryTables)], expression: expression(query) });
  }
  return { templates, snippets, settings, forms, lists, views, tables, unresolved, usages };
}

/** Resolve the static imported runtime graph for a portal route without rendering or writing. */
export function resolvePageResources(portal, route, { solutionMetadata = {} } = {}) {
  const normalized = normalizePortalPath(route);
  const page = (portal.pages ?? []).find((candidate) => normalizePortalPath(candidate.url) === normalized);
  if (!page) return { path: normalized, page: null, pageTemplate: null, webTemplates: [], snippets: [], siteSettings: [], forms: [], views: [], tables: [], columns: [], components: [], usages: [], dependencies: [], unresolved: [{ kind: "page", expression: normalized, reason: "No imported page matches this route." }] };

  const dependencies = [], unresolved = [], webTemplates = [], snippets = [], siteSettings = [], forms = [], views = [], tables = [], columns = [], components = [], usages = [];
  const add = (collection, descriptor) => {
    if (!descriptor) return;
    collection.push(descriptor);
    dependencies.push(descriptor);
  };
  const pageRecord = page.metadata;
  const pageDescriptor = {
    ...recordDescriptor(pageRecord, "page", page.title || page.name, "copy"),
    id: page.id,
    url: page.url,
    sourceFile: sourceFile(pageRecord, "copy.html") ?? pageRecord?._file ?? null,
    file: sourceFile(pageRecord, "copy.html") ?? pageRecord?._file ?? null,
  };
  add(components, pageDescriptor);

  const pageTemplate = lookup(portal.pageTemplates ?? [], page.pageTemplateId);
  if (page.pageTemplateId && !pageTemplate)
    unresolved.push({ kind: "page-template", expression: page.pageTemplateId, reason: "The page template ID is absent from the imported portal." });
  if (pageTemplate)
    add(components, { ...recordDescriptor(pageTemplate.metadata, "page-template", pageTemplate.name, "pagetemplate"), id: pageTemplate.id, webTemplateId: pageTemplate.webTemplateId });

  // Every scanned source keeps its owner so inspections can present include chains.
  const queue = [];
  const templateRows = unique(Object.values(portal.templates ?? {}), (item) => id(item.id));
  const addTemplate = (reference, via, owner) => {
    const found = templateRows.find((item) => id(item.id) === id(reference) || item.name === reference);
    if (!found) {
      unresolved.push({ kind: "web-template", expression: reference, via, ...(owner ? { owner } : {}), reason: "No imported web template matches this static reference." });
      return;
    }
    const existing = webTemplates.find((item) => id(item.id) === id(found.id));
    if (existing) {
      if (owner && !existing.includedBy.includes(owner)) existing.includedBy.push(owner);
      return;
    }
    const descriptor = { ...recordDescriptor(found.metadata, "web-template", found.name, "source"), id: found.id, via, includedBy: owner ? [owner] : [], sourceFile: sourceFile(found.metadata, "source.html") ?? found.metadata?._file ?? null, file: sourceFile(found.metadata, "source.html") ?? found.metadata?._file ?? null };
    add(webTemplates, descriptor);
    queue.push({ text: found.source ?? "", owner: `web-template:${id(found.id)}` });
  };
  if (pageTemplate?.webTemplateId) addTemplate(pageTemplate.webTemplateId, "page-template", `page-template:${id(pageTemplate.id)}`);
  else if (pageTemplate) unresolved.push({ kind: "web-template", expression: pageTemplate.name, via: "page-template", reason: "Page template has no resolved web-template ID." });

  const sources = [{ text: page.html ?? "", owner: "page" }, { text: page.js ?? "", owner: "page" }, { text: page.css ?? "", owner: "page" }];
  const seenSources = new Set();
  const references = { templates: [], snippets: [], settings: [], forms: [], lists: [], views: [], tables: new Map() };
  const addSnippet = (reference, via = "Liquid snippet", owner = null) => {
    const key = String(reference ?? "");
    const record = (portal.records ?? []).find((item) => item.kind === "contentsnippet" && item.name?.toLowerCase() === key.toLowerCase());
    if (!record) {
      unresolved.push({ kind: "content-snippet", expression: key, via, ...(owner ? { owner } : {}), reason: "No imported content snippet matches this static reference." });
      return;
    }
    const existing = snippets.find((item) => item.name === record.name);
    if (existing) {
      if (owner && !existing.usedBy.includes(owner)) existing.usedBy.push(owner);
      return;
    }
    const descriptor = { ...recordDescriptor(record, "content-snippet", record.name, "value"), usedBy: owner ? [owner] : [] };
    descriptor.sourceFile = sourceFile(record, "value.html") ?? record._file;
    descriptor.file = descriptor.sourceFile;
    add(snippets, descriptor);
    sources.push({ text: portal.snippets?.[record.name] ?? "", owner: `content-snippet:${record.name}` });
  };
  if (pageTemplate?.useHeaderFooter !== false) {
    const headerId = field(portal.website, "headerwebtemplateid");
    const footerId = field(portal.website, "footerwebtemplateid");
    if (headerId) addTemplate(headerId, "website header", "website-header");
    if (footerId) addTemplate(footerId, "website footer", "website-footer");
    for (const name of ["Head/Bottom", "Browser Title Suffix"]) {
      references.snippets.push(name);
      addSnippet(name, "rendered page shell", "page-shell");
    }
  }
  if (page.formId) references.forms.push(page.formId);
  if (page.advancedFormId) references.forms.push(page.advancedFormId);
  if (page.listId) references.lists.push(page.listId);
  const scanSource = ({ text, owner }) => {
    const key = `${owner}\u0000${text}`;
    if (seenSources.has(key)) return;
    seenSources.add(key);
    const refs = extractReferences(text);
    references.templates.push(...refs.templates);
    references.snippets.push(...refs.snippets);
    references.settings.push(...refs.settings);
    references.forms.push(...refs.forms);
    references.lists.push(...refs.lists);
    references.views.push(...refs.views);
    for (const usage of refs.usages) usages.push({ ...usage, owner });
    for (const reference of refs.snippets) addSnippet(reference, "Liquid snippet", owner);
    refs.unresolved.forEach((item) => unresolved.push({ ...item, owner }));
    for (const [entity, fields] of refs.tables) {
      if (!references.tables.has(entity)) references.tables.set(entity, new Set());
      fields.forEach((name) => references.tables.get(entity).add(name));
    }
    for (const ref of refs.templates)
      if (!builtinTemplates.has(ref.toLowerCase())) addTemplate(ref, "Liquid include/layout", owner);
  };
  let scanned = 0;
  const drain = () => {
    for (; scanned < sources.length || queue.length; scanned++) {
      if (scanned >= sources.length) sources.push(queue.shift());
      while (queue.length) sources.push(queue.shift());
      scanSource(sources[scanned]);
    }
  };
  drain();

  const entityNames = new Set(references.tables.keys());
  for (const ref of references.forms) {
    const component = [...(portal.forms ?? []), ...(portal.advancedForms ?? [])].find((item) => id(item.id) === id(ref) || item.name?.toLowerCase() === String(ref).toLowerCase());
    if (!component) { unresolved.push({ kind: "form", expression: ref, reason: "No imported form matches this static reference." }); continue; }
    if (forms.some((item) => id(item.id) === id(component.id))) continue;
    forms.push(component);
    const advanced = component.metadata?.kind === "advancedform";
    const owner = `${advanced ? "advanced-form" : "basic-form"}:${id(component.id)}`;
    if (component.js) sources.push({ text: component.js, owner });
    if (component.entityName) entityNames.add(component.entityName.toLowerCase());
    const schema = solutionMetadata.componentSchemas?.[component.id] ?? solutionMetadata.componentSchemas?.[component.name];
    for (const item of schema?.fields ?? []) if (component.entityName && item.name)
      columns.push({ entity: component.entityName.toLowerCase(), name: item.name, sourceFile: item.source ?? solutionMetadata.entities?.[component.entityName.toLowerCase()]?.sources?.[0] ?? null, fieldPath: item.name });
    for (const step of schema?.steps ?? []) {
      if (step.entity) entityNames.add(step.entity.toLowerCase());
      for (const item of step.fields ?? []) if (step.entity && item.name)
        columns.push({ entity: step.entity.toLowerCase(), name: item.name, sourceFile: solutionMetadata.entities?.[step.entity.toLowerCase()]?.sources?.[0] ?? null, fieldPath: item.name });
    }
    for (const step of (portal.records ?? []).filter((record) => record.kind === "advancedformstep" && id(field(record, "webform")) === id(component.id))) {
      const entity = field(step, "targetentitylogicalname", field(step, "entityname"));
      if (entity) entityNames.add(String(entity).toLowerCase());
    }
    const descriptor = recordDescriptor(component.metadata, advanced ? "advanced-form" : "basic-form", component.name, "customjavascript");
    descriptor.sourceFile = sourceFile(component.metadata, "custom_javascript.js") ?? component.metadata?._file ?? null;
    descriptor.file = descriptor.sourceFile;
    add(components, descriptor);
    if (advanced) {
      for (const step of (portal.records ?? []).filter((record) => record.kind === "advancedformstep" && id(field(record, "webform")) === id(component.id))) {
        const stepFile = sourceFile(step, "custom_javascript.js") ?? step._file ?? null;
        if (step.customJavascript) sources.push({ text: step.customJavascript, owner: `advanced-form-step:${id(step.id)}` });
        add(components, { ...recordDescriptor(step, "advanced-form-step", step.name, "customjavascript"), sourceFile: stepFile, file: stepFile });
      }
    }
  }
  for (const ref of references.lists) {
    const component = (portal.lists ?? []).find((item) => id(item.id) === id(ref) || item.name?.toLowerCase() === String(ref).toLowerCase());
    if (!component) { unresolved.push({ kind: "list", expression: ref, reason: "No imported list matches this static reference." }); continue; }
    if (components.some((item) => item.kind === "list" && id(item.recordId) === id(component.id))) continue;
    if (component.js) sources.push({ text: component.js, owner: `list:${id(component.id)}` });
    if (component.entityName) entityNames.add(component.entityName.toLowerCase());
    add(components, { ...recordDescriptor(component.metadata, "list", component.name, "customjavascript"), entity: component.entityName ?? null, sourceFile: sourceFile(component.metadata, "custom_javascript.js") ?? component.metadata?._file ?? null, file: sourceFile(component.metadata, "custom_javascript.js") ?? component.metadata?._file ?? null });
    for (const viewId of [field(component.metadata, "view"), ...asArray(field(component.metadata, "views"))]) {
      const value = viewId && typeof viewId === "object" ? viewId.id ?? viewId.value : viewId;
      if (value) references.views.push(String(value));
    }
  }
  drain();
  const settingNames = new Set(references.settings);
  for (const entity of references.tables.keys()) entityNames.add(entity);
  for (const reference of unique(references.views)) {
    const view = (solutionMetadata.views ?? []).find((item) => id(item.id) === id(reference) || item.name === reference);
    if (!view) { unresolved.push({ kind: "view", expression: reference, reason: "View source is absent from imported solution metadata." }); continue; }
    if (views.some((item) => id(item.id) === id(view.id))) continue;
    views.push(view);
    entityNames.add(view.entity.toLowerCase());
    add(components, { kind: "view", name: view.name, id: view.id, entity: view.entity, sourceFile: view.file, file: view.file, relativePath: view.file ? path.basename(view.file) : null, recordId: view.id, fieldPath: "fetchXml" });
    (view.fields ?? []).forEach((item) => {
      const column = solutionMetadata.entities?.[view.entity]?.fields?.[item.name];
      columns.push({ entity: view.entity, name: item.name, width: item.width, source: column?.source, sourceFile: column?.source, recordId: view.id, fieldPath: "layoutxml" });
    });
  }
  for (const [entity, selected] of references.tables) {
    entityNames.add(entity);
    selected.forEach((name) => columns.push({ entity, name, sourceFile: solutionMetadata.entities?.[entity]?.sources?.[0] ?? null, fieldPath: name }));
  }
  for (const entity of entityNames) {
    const metadata = solutionMetadata.entities?.[entity];
    const descriptor = { kind: "table", name: entity, logicalName: entity, sourceFile: metadata?.sources?.[0] ?? null, file: metadata?.sources?.[0] ?? null, sourceFiles: metadata?.sources ?? [], columns: Object.keys(metadata?.fields ?? {}).filter((name) => columns.some((column) => column.entity === entity && column.name === name)) };
    add(tables, descriptor);
    if (!metadata) unresolved.push({ kind: "table", expression: entity, reason: "No imported solution table metadata matches this dependency." });
  }
  const tableNames = new Set([...entityNames]);
  for (const name of Object.keys(portal.settings ?? {}))
    if (/^webapi\//i.test(name) && tableNames.has(name.split("/")[1].toLowerCase())) settingNames.add(name);
  for (const name of settingNames) {
    const record = (portal.records ?? []).find((item) => item.kind === "sitesetting" && item.name === name);
    if (!record) { unresolved.push({ kind: "site-setting", expression: name, reason: "No imported site setting matches this static reference." }); continue; }
    add(siteSettings, recordDescriptor(record, "site-setting", record.name, "value"));
  }
  const allColumns = unique(columns, (item) => `${item.entity}/${item.name}`);
  for (const descriptor of [...dependencies, ...forms, ...views, ...columns, ...tables, pageDescriptor, ...(pageTemplate ? [pageTemplate] : [])]) {
    if (descriptor.sourceFile && portal.sourceDir)
      descriptor.relativePath = path.relative(portal.sourceDir, descriptor.sourceFile);
  }
  const resolvedPageTemplate = pageTemplate
    ? { ...recordDescriptor(pageTemplate.metadata, "page-template", pageTemplate.name, "pagetemplate"), id: pageTemplate.id, webTemplateId: pageTemplate.webTemplateId, useHeaderFooter: pageTemplate.useHeaderFooter !== false }
    : null;
  if (resolvedPageTemplate?.sourceFile && portal.sourceDir)
    resolvedPageTemplate.relativePath = path.relative(portal.sourceDir, resolvedPageTemplate.sourceFile);
  const relative = (file) => (file && portal.sourceDir ? path.relative(portal.sourceDir, file) : null);
  return {
    path: normalized,
    sourceRoots: [...new Set([portal.sourceDir, ...(solutionMetadata.roots ?? [])].filter(Boolean))],
    page: pageDescriptor,
    pageTemplate: resolvedPageTemplate,
    webTemplates,
    snippets,
    siteSettings,
    forms: unique(forms, (item) => id(item.id)).map((item) => {
      const schema = solutionMetadata.componentSchemas?.[item.id] ?? solutionMetadata.componentSchemas?.[item.name];
      const sourceSteps = (portal.records ?? []).filter((record) => record.kind === "advancedformstep" && id(field(record, "webform")) === id(item.id));
      const steps = unique([
        ...sourceSteps.map((step) => ({ id: step.id, name: step.name, entity: field(step, "targetentitylogicalname", field(step, "entityname")) ?? null, formName: field(step, "formname") ?? null, mode: field(step, "mode", null), sourceFile: sourceFile(step, "custom_javascript.js") ?? step._file ?? null })),
        ...(schema?.steps ?? []).map((step) => ({ id: step.stepId, name: step.title ?? null, entity: step.entity ?? null, formName: step.formName ?? null, mode: step.mode ?? null, sourceFile: step.metadata?._file ?? null })),
      ], (step) => id(step.id));
      const source = item.metadata?._file ?? null;
      const advanced = item.metadata?.kind === "advancedform";
      return {
        id: item.id,
        name: item.name,
        kind: advanced ? "advanced-form" : "basic-form",
        entity: item.entityName ?? steps.find((step) => step.entity)?.entity ?? null,
        formName: item.formName ?? schema?.formName ?? null,
        mode: item.mode ?? schema?.mode ?? null,
        steps: steps.map((step) => {
          const stepSchema = solutionMetadata.componentSchemas?.[step.id];
          return { ...step, formXml: stepSchema?.sourceFile ? { id: stepSchema.formId ?? null, name: stepSchema.formName ?? null, sourceFile: stepSchema.sourceFile } : null, relativePath: relative(step.sourceFile) };
        }),
        formXml: schema?.sourceFile && !advanced ? { id: schema.formId ?? null, name: schema.formName ?? null, sourceFile: schema.sourceFile } : null,
        sourceFile: source,
        relativePath: relative(source),
        recordId: item.id,
      };
    }),
    views: unique(views, (item) => id(item.id)).map((item) => ({ id: item.id, name: item.name, entity: item.entity, sourceFile: item.file, relativePath: relative(item.file), fields: item.fields ?? [] })),
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
    try { stat = fs.statSync(file); } catch { continue; }
    const cached = displayNameCache.get(file);
    let value = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size ? cached.value : undefined;
    if (value === undefined) {
      value = null;
      try {
        const xml = fs.readFileSync(file, "utf8");
        const block = /<LocalizedNames>([\s\S]*?)<\/LocalizedNames>/.exec(xml)?.[1] ?? "";
        value = /<LocalizedName\b[^>]*\bdescription="([^"]*)"[^>]*\blanguagecode="1033"/i.exec(block)?.[1]
          ?? /<LocalizedName\b[^>]*\bdescription="([^"]*)"/i.exec(block)?.[1]
          ?? /<Name\b[^>]*\bLocalizedName="([^"]*)"/.exec(xml.slice(0, 4096))?.[1]
          ?? null;
      } catch { value = null; }
      displayNameCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    }
    if (value) name = value;
  }
  return name;
}

const rightLabel = (right) => ({ 1: "Grant change", 2: "Restrict read" })[right] ?? "Unresolved right";
const scopeLabel = (scope) => ({ 1: "All content", 2: "Exclude direct child web files" })[scope] ?? "Unresolved scope";
const truth = (value) => value === true || value === 1 || (typeof value === "string" && value.toLowerCase() === "true");
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
  const roles = new Map((portal.records ?? []).filter((record) => record.kind === "webrole" && Number(field(record, "statecode", 0)) !== 1).map((record) => [id(record.id), record.name]));
  const identityRoleIds = new Set((identity?.roleIds ?? []).map(id));
  const identityRoles = new Set(identity?.roles ?? []);
  return (portal.records ?? [])
    .filter((record) => record.kind === "webpageaccesscontrolrule" && Number(field(record, "statecode", 0)) !== 1)
    .map((record) => {
      const root = id(field(record, "webpageid"));
      const owner = ancestors.find((candidate) => id(candidate.id) === root);
      if (!owner) return null;
      const associated = field(record, "webpageaccesscontrolrule_webrole", []);
      const roleIds = asArray(associated).map((value) => id(typeof value === "object" ? value.id ?? value.adx_webroleid ?? value.mspp_webroleid : value)).filter(Boolean);
      const right = Number(field(record, "right"));
      const scope = Number(field(record, "scope", 1));
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
        matches: roleIds.some((roleId) => roles.has(roleId) && (identity?.roleSource === "memberships" ? identityRoleIds.has(roleId) : identityRoleIds.has(roleId) || identityRoles.has(roles.get(roleId)))),
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
  const active = (record) => Number(field(record, "statecode", 0)) !== 1;
  const sets = new Map(records.filter((record) => record.kind === "weblinkset").map((record) => [id(record.id), record]));
  const weblinks = records
    .filter((record) => record.kind === "weblink" && active(record) && id(field(record, "pageid")) === pageId)
    .map((record) => {
      const set = sets.get(id(field(record, "weblinksetid")));
      return { id: record.id, name: record.name, set: set?.name ?? null, setId: set?.id ?? null, displayOrder: Number(field(record, "displayorder", 0)), sourceFile: record._file ?? null };
    })
    .sort((a, b) => String(a.set).localeCompare(String(b.set)) || a.displayOrder - b.displayOrder);
  const sitemarkers = records
    .filter((record) => record.kind === "sitemarker" && active(record) && id(field(record, "pageid")) === pageId)
    .map((record) => ({ id: record.id, name: record.name, sourceFile: record._file ?? null }));
  const pagePath = normalizePortalPath(page.url);
  const redirects = [
    ...records.filter((record) => record.kind === "redirect" && active(record) && (id(field(record, "webpageid")) === pageId || (field(record, "redirecturl") && normalizePortalPath(String(field(record, "redirecturl"))) === pagePath))),
    ...(Array.isArray(portal.redirects) ? portal.redirects.filter((item) => id(item.pageId ?? item.webPageId) === pageId || (item.redirectUrl && normalizePortalPath(item.redirectUrl) === pagePath)) : []),
  ].map((item) => ({
    id: item.id,
    name: item.name ?? null,
    inboundUrl: item.inboundUrl ?? field(item, "inboundurl"),
    statusCode: Number(item.statusCode ?? field(item, "statuscode", 302)) || null,
    sourceFile: item._file ?? item.file ?? item.sourceFile ?? null,
  }));
  const shortcuts = (portal.shortcuts ?? [])
    .filter((shortcut) => id(shortcut.targetPageId) === pageId)
    .map((shortcut) => ({ id: shortcut.id, name: shortcut.name, title: shortcut.title, sourceFile: shortcut.metadata?._file ?? null }));
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
  const templatesByOwner = byOwner(report.webTemplates, "includedBy");
  const snippetsByOwner = byOwner(report.snippets, "usedBy");
  const visited = new Set();
  const descend = (owner, depth) => {
    for (const template of templatesByOwner.get(owner) ?? []) {
      const key = `web-template:${id(template.id)}`;
      const repeated = visited.has(key);
      rows.push({ depth, kind: "web-template", name: template.name, id: template.id, via: template.via, sourceFile: template.sourceFile, relativePath: template.relativePath, fieldPath: template.fieldPath ?? null, repeated });
      if (repeated) continue;
      visited.add(key);
      descend(key, depth + 1);
    }
    for (const snippet of snippetsByOwner.get(owner) ?? []) {
      const key = `content-snippet:${snippet.name}`;
      const repeated = visited.has(key);
      rows.push({ depth, kind: "content-snippet", name: snippet.name, sourceFile: snippet.sourceFile, relativePath: snippet.relativePath, fieldPath: snippet.fieldPath ?? null, repeated });
      if (repeated) continue;
      visited.add(key);
      descend(key, depth + 1);
    }
  };
  if (report.pageTemplate) {
    rows.push({ depth: 0, kind: "page-template", name: report.pageTemplate.name, id: report.pageTemplate.id, sourceFile: report.pageTemplate.sourceFile, relativePath: report.pageTemplate.relativePath });
    descend(`page-template:${id(report.pageTemplate.id)}`, 1);
  }
  for (const [owner, label] of [["website-header", "Website header"], ["website-footer", "Website footer"], ["page-shell", "Rendered page shell"], ["page", "Page copy, JavaScript and CSS"]]) {
    if (!templatesByOwner.has(owner) && !snippetsByOwner.has(owner)) continue;
    rows.push({ depth: 0, kind: "root", name: label, owner });
    descend(owner, 1);
  }
  for (const component of report.components.filter((item) => ["basic-form", "advanced-form", "advanced-form-step", "list"].includes(item.kind))) {
    const owner = `${component.kind}:${id(component.recordId)}`;
    if (!templatesByOwner.has(owner) && !snippetsByOwner.has(owner)) continue;
    rows.push({ depth: 0, kind: "root", name: `${component.name} (${component.kind.replace(/-/g, " ")} JavaScript)`, owner, sourceFile: component.sourceFile, relativePath: component.relativePath });
    descend(owner, 1);
  }
  return rows;
}

/**
 * Inspect a route for development tools: the static dependency graph plus the current
 * persona's runtime view (page access, table permissions), effective local values and
 * metadata that points at the page. Reads local files only; renders and writes nothing.
 */
export function inspectPage(portal, route, {
  solutionMetadata = {},
  sourcePortal = portal,
  overrides = {},
  identity = null,
  access = null,
  mapping = () => null,
  tablePermissions = () => null,
} = {}) {
  const report = resolvePageResources(portal, route, { solutionMetadata });
  const page = (portal.pages ?? []).find((candidate) => normalizePortalPath(candidate.url) === report.path);
  if (!page) return { ...report, templateChain: [], related: { weblinks: [], sitemarkers: [], redirects: [], shortcuts: [] } };
  const publishingStateId = id(field(page.metadata, "publishingstateid"));
  const publishingState = publishingStateId
    ? (portal.records ?? []).find((record) => record.kind === "publishingstate" && id(record.id) === publishingStateId)
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
      ? { id: publishingStateId, name: publishingState?.name ?? null, visible: publishingState ? truth(field(publishingState, "isvisible", true)) : null, resolved: Boolean(publishingState) }
      : null,
    access: {
      ...(accessResult ? { allowed: accessResult.allowed, status: accessResult.status, code: accessResult.code ?? null, reason: accessResult.reason ?? null, ruleIds: accessResult.ruleIds ?? [], diagnostics: accessResult.diagnostics ?? [] } : {}),
      rules: pageAccessRules(portal, page, identity ?? {}, overrides),
    },
  };
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
  for (const column of report.columns) {
    const metadata = solutionMetadata.entities?.[column.entity]?.fields?.[column.name];
    if (!metadata) { column.resolved = false; continue; }
    Object.assign(column, {
      resolved: true,
      label: metadata.label ?? null,
      type: metadata.dataverseType ?? metadata.type ?? null,
      required: Boolean(metadata.required),
      maxLength: metadata.maxLength ?? null,
      optionSetName: metadata.optionSetName ?? null,
      optionCount: Array.isArray(metadata.options) ? metadata.options.length : 0,
      options: Array.isArray(metadata.options) ? metadata.options.slice(0, 12).map((option) => ({ value: option.value, label: option.label })) : [],
    });
  }
  for (const snippet of report.snippets) {
    const name = snippet.name;
    snippet.value = preview(portal.snippets?.[name]);
    snippet.sourceValue = preview(sourcePortal.snippets?.[name]);
    snippet.overridden = Object.hasOwn(overrides.snippets ?? {}, name);
    snippet.deleted = !Object.hasOwn(portal.snippets ?? {}, name);
  }
  for (const setting of report.siteSettings) {
    const name = setting.name;
    setting.value = preview(portal.settings?.[name], 400);
    setting.sourceValue = preview(sourcePortal.settings?.[name], 400);
    setting.overridden = Object.hasOwn(overrides.settings ?? {}, name);
    setting.deleted = !Object.hasOwn(portal.settings ?? {}, name);
  }
  return { ...report, templateChain: templateChain(report), related: relatedMetadata(portal, page) };
}
