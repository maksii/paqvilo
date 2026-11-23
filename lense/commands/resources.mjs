// Offline resource discovery for editors and agents. No source bodies, browser, or output files.
import fs from 'node:fs';
import path from 'node:path';
import { PortalModel, inlineKindOf, isSourceFile, createSourceReader } from '../portal-model.mjs';
import { GitBaseline } from '../git.mjs';
import { Resolver } from '../resolver.mjs';
import { pageKey } from '../html-rewriter.mjs';

export const RESOURCE_KINDS = [
  'page',
  'web-file',
  'page-js',
  'page-css',
  'page-copy',
  'page-summary',
  'basic-form-js',
  'advanced-form-step-js',
  'list-js',
  'web-template',
  'content-snippet',
  'metadata-markup',
  'route',
];
const compare = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};
const routeStrategy = (rule) => {
  if (rule.passthrough) return 'passthrough';
  return rule.dir ? 'directory-route' : 'file-route';
};
const previewReason = (source, readable, pageResolved) => {
  if (!readable) return 'Source is missing or outside the extract';
  if (!pageResolved) return 'The page URL cannot be resolved from metadata';
  if (source.mode === 'markup')
    return 'Only supported literal changes can be patched; runtime matching and Liquid require separate validation.';
  return 'Inline content is matched against the rendered page; eligibility does not prove it appears there.';
};
const byId = (a, b) => compare(a.id, b.id);
const invalidArgument = (message) => Object.assign(new Error(message), { code: 'invalid_argument' });
const normalizePath = (file) => file.replaceAll('\\', '/');

/**
 * The resources the page inspection (the Inspect report's static model: templates, snippets, forms, lists, web files,
 * settings) lists for the --page filter, as a path set; resources whose files it names are used by that page.
 */
function inspectionFiles(report) {
  const files = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 8 || files.size >= 5000) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const key of ['sourceFile', 'file', 'metadataSource'])
      if (typeof value[key] === 'string') files.add(path.resolve(value[key]).toLowerCase());
    for (const [key, child] of Object.entries(value)) if (key !== 'portalSources') visit(child, depth + 1);
  };
  visit(report, 0);
  return { has: (file) => Boolean(file) && files.has(path.resolve(file).toLowerCase()), size: files.size };
}

function inspectedOn(context, files) {
  return context.inspected && context.inspectedPage && files.some((file) => context.inspected.has(file))
    ? { inspectedPageUrls: [context.inspectedPage] }
    : {};
}

function optionalInlineFields(source) {
  return {
    ...(source.fieldPath
      ? { fieldPath: source.fieldPath, ...(source.jsonPath ? { jsonPath: source.jsonPath } : {}) }
      : {}),
    ...(source.componentId != null ? { componentId: source.componentId } : {}),
    ...(source.recordId ? { recordId: source.recordId, recordIdField: source.recordIdField } : {}),
    ...(source.lcid != null ? { lcid: source.lcid } : {}),
  };
}

function inlineMetadata(source, model, cfg) {
  const def = inlineKindOf(source.file);
  let metadata = null;
  if (source.extract) metadata = source.file;
  else if (def) metadata = source.file.slice(0, -def.suffix.length) + def.suffix.replace(/\.[^.]+\.[^.]+$/, '.yml');
  const metadataPaths =
    metadata && (source.extract || model.currentYaml.has(metadata)) && isSourceFile(cfg.sourceDir, metadata)
      ? [metadata]
      : [];
  return { metadata, metadataPaths };
}

function inlinePreview(source, readable, renders, configured, pageResolved, cfg, { baseline, changed }) {
  return {
    strategy: source.mode === 'block' ? 'inline-block' : 'baseline-patch',
    supported: readable && renders,
    enabled: configured,
    eligible:
      configured &&
      readable &&
      renders &&
      (source.mode === 'markup' || cfg.site.scope === 'changed'
        ? baseline.available && changed.has(source.file)
        : true),
    reason: previewReason(source, readable, pageResolved),
  };
}

function addInlineSource(source, context) {
  const { filters, model } = context;
  if (filters.kinds.length && !filters.kinds.includes(source.kind)) return;
  const knownPages = source.pageUrl ? [source.pageUrl] : (source.usedOn ?? []);
  if (
    filters.page &&
    !knownPages.some((url) => pageKey(url, model) === filters.page) &&
    !context.inspected?.has(source.file)
  )
    return;
  if (filters.changed && !context.changedAt(source.file)) return;
  appendInlineResource(source, knownPages, context);
}

function appendInlineResource(source, knownPages, context) {
  const { model, cfg, baseline, changed, relative, textOf, resources } = context;
  const { metadata, metadataPaths } = inlineMetadata(source, model, cfg);
  const kinds = source.mode === 'block' ? cfg.site.inline : cfg.site.markup;
  const configured = Boolean(kinds?.enabled && kinds.kinds.includes(source.kind));
  const pageResolved = !source.kind.startsWith('page-') || source.pageUrl !== null;
  const readable = isSourceFile(cfg.sourceDir, source.file);
  const content = readable ? textOf(source) : null;
  const exists = source.exists ?? content !== null;
  const rootShadowed = source.renders === false;
  const renders = pageResolved && !rootShadowed && exists;
  const resource = {
    id: `source:${source.kind}:${source.rel}`,
    kind: source.kind,
    name:
      source.label ??
      model.currentYaml.get(metadata)?.adx_name ??
      (model.shortKey ? model.currentYaml.get(metadata)?.name : undefined) ??
      path.basename(source.file),
    exists,
    empty: content === null ? null : !content.trim(),
    renders,
    path: source.file,
    sourceDir: cfg.sourceDir,
    relativePath: relative(source.file),
    metadataPaths,
    field: source.field ?? null,
    format: source.format ?? (source.extract ? 'xml' : 'text'),
    ...optionalInlineFields(source),
    url: null,
    relatedPageUrls: [...new Set(knownPages)].sort(compare),
    changed: context.changedAt(source.file),
    ...inspectedOn(context, [source.file]),
    preview: inlinePreview(source, readable, renders, configured, pageResolved, cfg, { baseline, changed }),
  };
  resources.push(resource);
  relateResource(
    context.relationships,
    context.pagesByUrl,
    context.pageResources,
    resource,
    knownPages,
    source.pageUrl ? 'belongs-to-page' : 'configured-on-page',
    metadataPaths,
  );
}

function appendWebFileResource(file, context) {
  const { model, relative, resolver, baseline, changed, resources } = context;
  const effective = file.url ? resolver.resolve(file.url) : null;
  const resource = {
    id: `web-file:${relative(file.yml)}`,
    kind: 'web-file',
    name: file.name ?? relative(file.file) ?? relative(file.yml),
    recordId: file.id ?? null,
    path: file.file,
    relativePath: relative(file.file),
    metadataPaths: [file.yml],
    field: null,
    url: file.url,
    relatedPageUrls: model.pagePath(file.parentPageId) ? [model.pagePath(file.parentPageId)] : [],
    changed: baseline.available ? changed(file.file) || changed(file.yml) : null,
    ...inspectedOn(context, [file.file, file.yml]),
    preview: {
      strategy: 'local-response',
      supported: Boolean(file.file && file.url && !file.problem),
      selected: Boolean(file.file && effective?.file === file.file),
      effectivePath: effective?.file ?? null,
      via: effective?.via ?? null,
      reason: file.problem ?? null,
    },
  };
  resources.push(resource);
  relateResource(
    context.relationships,
    context.pagesByUrl,
    context.pageResources,
    resource,
    resource.relatedPageUrls,
    'parent-page',
    resource.metadataPaths,
  );
}

function relateResource(relationships, pagesByUrl, pageResources, resource, urls, kind, metadataPaths) {
  for (const url of urls)
    for (const targetId of pagesByUrl.get(pageKey(url)) ?? [])
      relationships.push({
        sourceId: resource.id,
        targetId,
        kind,
        evidence: {
          type: 'extract-metadata',
          paths: [...new Set([...metadataPaths, ...pageResources.get(targetId).metadataPaths])].sort(compare),
        },
      });
}

function relativeResourcePath(cfg, file) {
  return file ? normalizePath(path.relative(cfg.sourceDir, file)) : null;
}

function changedResourceAt(cfg, baseline, changed, file) {
  if (!baseline.available) return null;
  if (!file) return false;
  const rel = path.relative(cfg.sourceDir, file);
  // The Git snapshot is deliberately scoped to the extract, including when an explicit route serves a file from elsewhere.
  // Absence from that snapshot does not prove it clean.
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return changed.has(file);
}

function rootPageId(model, id) {
  id = String(id ?? '').toLowerCase();
  const seen = new Set();
  while (model.pageAlias.has(id) && !seen.has(id)) {
    seen.add(id);
    id = model.pageAlias.get(id);
  }
  return id;
}

function appendPageResource(page, context) {
  const {
    cfg,
    model,
    baseline,
    changed,
    pageMetadata,
    pageComponents,
    resources,
    pageResources,
    pagesByUrl,
    relationships,
  } = context;
  const url = model.pagePath(page.id);
  const metadataPaths = (
    model.format === 'enhanced' ? [path.join(page.dir, 'powerpagecomponent.xml')] : (pageMetadata.get(page.id) ?? [])
  )
    .filter((file) => isSourceFile(cfg.sourceDir, file))
    .sort(compare);
  const resource = {
    id: `page:${page.id}`,
    kind: 'page',
    name: page.name ?? page.id,
    recordId: page.id,
    path: null,
    relativePath: null,
    directory: page.dir,
    metadataPaths,
    field: null,
    url,
    relatedPageUrls: url ? [url] : [],
    configuredComponentIds: [...(pageComponents.get(page.id) ?? [])].sort(compare),
    ...inspectedOn(context, metadataPaths),
    changed: baseline.available ? metadataPaths.some((file) => changed(file)) : null,
    preview: {
      strategy: 'portal-page',
      supported: false,
      reason:
        'Page records and server configuration require deployment; edit the related source resources for local previews.',
    },
  };
  resources.push(resource);
  pageResources.set(resource.id, resource);
  if (url) {
    const key = pageKey(url);
    if (!pagesByUrl.has(key)) pagesByUrl.set(key, []);
    pagesByUrl.get(key).push(resource.id);
  }
  if (page.parentId && model.pages.has(rootPageId(model, page.parentId)))
    relationships.push({
      sourceId: resource.id,
      targetId: `page:${rootPageId(model, page.parentId)}`,
      kind: 'parent-page',
      evidence: { type: 'extract-metadata', paths: metadataPaths },
    });
}

function indexPageMetadata(model, pageMetadata) {
  if (model.format !== 'classic') return;
  for (const [file, metadata] of model.currentYaml) {
    // PAC YAML pages carry adx_webpageid; .powerpages-site pages keep their ID in id:.
    const pageId =
      metadata.adx_webpageid ?? (model.shortKey && file.endsWith('.webpage.yml') ? metadata.id : undefined);
    if (!pageId) continue;
    const id = rootPageId(model, pageId);
    if (!pageMetadata.has(id)) pageMetadata.set(id, []);
    pageMetadata.get(id).push(file);
  }
}

function indexPageComponents(model, pageComponents) {
  for (const [componentId, pageIds] of model.componentPages)
    for (const pageId of pageIds) {
      const id = rootPageId(model, pageId);
      if (!pageComponents.has(id)) pageComponents.set(id, new Set());
      pageComponents.get(id).add(componentId);
    }
}

function appendRouteResource(index, rule, context) {
  const { cfg, relative, changed, resources } = context;
  const target = rule.file ?? rule.dir;
  const file = target ? path.resolve(cfg.sourceDir, target) : null;
  let exists = null;
  if (file) {
    try {
      const stat = fs.statSync(file);
      exists = rule.file ? stat.isFile() : stat.isDirectory();
    } catch {
      exists = false;
    }
  }
  resources.push({
    id: `route:${index}`,
    kind: 'route',
    name: rule.url,
    path: rule.file ? file : null,
    relativePath: rule.file ? relative(file) : null,
    directory: rule.dir ? file : null,
    metadataPaths: [cfg.configFile].filter(Boolean),
    field: null,
    url: null,
    pattern: rule.url,
    relatedPageUrls: [],
    changed: rule.file ? changed(file) : null,
    preview: {
      strategy: routeStrategy(rule),
      exists,
      precedence: index,
      reason: 'Routes are evaluated in configuration order before automatic web-file mappings.',
    },
  });
}

function addPageResources(model, context) {
  for (const page of model.pages.values()) appendPageResource(page, context);
}

function addWebFileResources(model, context) {
  for (const file of model.webFiles) appendWebFileResource(file, context);
}

function addInlineResources(model, context) {
  for (const source of model.inlineSources) addInlineSource(source, context);
}

function addRouteResources(cfg, context) {
  for (const [index, rule] of (cfg.site.routes ?? []).entries()) appendRouteResource(index, rule, context);
}

function matchesResource(resource, filters, needle) {
  return (
    (!filters.kinds.length || filters.kinds.includes(resource.kind)) &&
    (!filters.page ||
      resource.relatedPageUrls.some((url) => pageKey(url) === filters.page) ||
      (resource.inspectedPageUrls ?? []).some((url) => pageKey(url) === filters.page)) &&
    (!filters.changed || resource.changed) &&
    (!needle ||
      [resource.id, resource.name, resource.relativePath, resource.url, resource.pattern, ...resource.relatedPageUrls]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)))
  );
}

function integer(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max ||
    (name === '--limit' && Number(value) < 1)
  )
    throw invalidArgument(`${name} must be an integer from ${name === '--limit' ? 1 : 0} to ${max}`);
  return Number(value);
}

export function resourceFilters(args = {}) {
  const limit = integer(args.limit, 100, '--limit', 500);

  const kinds = args.kind === undefined ? [] : [args.kind].flat();
  for (const kind of kinds)
    if (!RESOURCE_KINDS.includes(kind))
      throw invalidArgument(`Unknown resource kind "${kind}". Supported: ${RESOURCE_KINDS.join(', ')}`);
  if (
    args.page !== undefined &&
    (typeof args.page !== 'string' ||
      !args.page.startsWith('/') ||
      args.page.startsWith('//') ||
      // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
      /[\\?#\x00-\x1f]/.test(args.page))
  )
    throw invalidArgument('--page must be a same-origin URL path without a query or fragment');
  return {
    page: args.page === undefined ? null : pageKey(args.page),
    kinds: [...new Set(kinds)].sort(compare),
    search: args.search?.trim() ?? '',
    changed: Boolean(args.changed),
    offset: integer(args.offset, 0, '--offset'),
    limit,
  };
}

/** Resources the static page inspection lists are used by the inspected page's records. */
function addInspectedPageRelationships(resources, relationships, pagesByUrl, page) {
  for (const resource of resources) {
    if (!resource.inspectedPageUrls || resource.kind === 'page') continue;
    for (const targetId of pagesByUrl.get(page) ?? [])
      relationships.push({
        sourceId: resource.id,
        targetId,
        kind: 'used-by-page',
        evidence: { type: 'static-page-inspection', paths: [] },
      });
  }
}

function summarizePageInspection(pageInspection, page) {
  return {
    path: pageInspection.requestPath ?? pageInspection.path ?? page,
    page: pageInspection.page ? { id: pageInspection.page.id ?? null, url: pageInspection.page.url ?? null } : null,
    unresolved: (pageInspection.unresolved ?? []).length,
  };
}

/** Describe only relationships established by the existing portal model, not inferred runtime use. */
export function describeResources(
  cfg,
  model,
  baseline,
  changed,
  filters = resourceFilters(),
  { pageInspection = null } = {},
) {
  filters = { ...filters, page: filters.page == null ? null : pageKey(filters.page, model) };
  // The static page inspection of --page (resources() computes it): resources it lists are used by that page.
  const inspected = filters.page && pageInspection ? inspectionFiles(pageInspection) : null;
  const inspection = inspected ? { inspected, inspectedPage: filters.page } : {};
  if (filters.changed && !baseline.available)
    throw new Error('Cannot select changed resources: the requested Git baseline is unavailable');
  const relative = (file) => relativeResourcePath(cfg, file);
  const changedAt = (file) => changedResourceAt(cfg, baseline, changed, file);
  const resolver = new Resolver(model, cfg.site, { changed: cfg.site.scope === 'changed' ? changed : null });
  const textOf = createSourceReader(model);
  const resources = [];
  const relationships = [];
  const pagesByUrl = new Map();
  const pageResources = new Map();
  const pageMetadata = new Map();
  indexPageMetadata(model, pageMetadata);
  const pageComponents = new Map();
  indexPageComponents(model, pageComponents);
  addPageResources(model, {
    ...inspection,
    cfg,
    model,
    baseline,
    changed: changedAt,
    pageMetadata,
    pageComponents,
    resources,
    pageResources,
    pagesByUrl,
    relationships,
  });
  const relationshipContext = { relationships, pagesByUrl, pageResources };
  // Related page URLs are the page records' own URLs (trailing slash kept), not the filter key.
  if (inspected)
    inspection.inspectedPage =
      [...pageResources.values()].find((row) => row.url && pageKey(row.url) === filters.page)?.url ?? filters.page;
  addWebFileResources(model, {
    ...relationshipContext,
    ...inspection,
    model,
    relative,
    resolver,
    baseline,
    changed: changedAt,
    resources,
  });
  addInlineResources(model, {
    ...relationshipContext,
    ...inspection,
    filters,
    model,
    cfg,
    baseline,
    changed,
    changedAt,
    relative,
    textOf,
    resources,
  });
  addRouteResources(cfg, { cfg, relative, changed: changedAt, resources });
  addInspectedPageRelationships(resources, relationships, pagesByUrl, filters.page);
  resources.sort(byId);
  relationships.sort((a, b) =>
    compare(`${a.sourceId}\0${a.targetId}\0${a.kind}`, `${b.sourceId}\0${b.targetId}\0${b.kind}`),
  );
  const needle = filters.search.toLowerCase();
  const matching = resources.filter((resource) => matchesResource(resource, filters, needle));
  const selected = matching.slice(filters.offset, filters.offset + filters.limit);
  const selectedIds = new Set(selected.map((resource) => resource.id));
  return {
    schemaVersion: 1,
    command: 'resources',
    ok: true,
    offline: true,
    writesFiles: [],
    site: cfg.siteName,
    environment: cfg.envName,
    origin: cfg.origin,
    sourceDir: cfg.sourceDir,
    format: model.format,
    scope: cfg.site.scope,
    baseline: {
      requested: baseline.spec,
      commit: baseline.available ? baseline.commit : null,
      available: baseline.available,
      error: baseline.error ?? null,
    },
    filters,
    pagination: {
      total: matching.length,
      offset: filters.offset,
      limit: filters.limit,
      returned: selected.length,
      nextOffset: filters.offset + selected.length < matching.length ? filters.offset + selected.length : null,
    },
    resources: selected,
    relationships: relationships.filter((edge) => selectedIds.has(edge.sourceId)),
    relationshipScope: inspected
      ? 'Indexed page hierarchy, configured form/list usage and the static page inspection of --page (the Inspect report: templates, snippets, forms, lists, web files and settings). Runtime requests and dynamic dependencies are not inferred.'
      : 'Indexed page hierarchy and configured form/list usage only. Runtime requests, Liquid includes, template inheritance and dynamic dependencies are not inferred.',
    ...(pageInspection && filters.page
      ? { pageInspection: summarizePageInspection(pageInspection, filters.page) }
      : {}),
    diagnostics: { warnings: [...model.warnings].sort(compare) },
  };
}

export default async function resources(cfg, args) {
  const filters = resourceFilters(args);
  const model = await PortalModel.create(cfg.sourceDir);
  const baseline = new GitBaseline(cfg.sourceDir, cfg.site.markup.baseline);
  const changed = await baseline.changedFilesAsync({ refreshRef: false });
  // --page uses the same static page inspection as the Inspect report (offline: sources only, nothing rendered).
  const pageInspection = filters.page
    ? (await (await import('../source-inspection.mjs')).createSourceInspector(cfg).inspect(args.page)).report
    : null;
  const report = describeResources(cfg, model, baseline, changed, filters, { pageInspection });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.site} @ ${report.environment}: ${report.pagination.total} matching resources (offline)`);
    for (const resource of report.resources) {
      const fieldSuffix = resource.field ? ` #${resource.field}` : '';
      console.log(
        `${resource.kind.padEnd(22)} ${resource.url ?? resource.pattern ?? resource.relatedPageUrls.join(', ')}  ${resource.relativePath ?? resource.directory ?? ''}${fieldSuffix}\n  ${resource.id}`,
      );
    }
    if (report.pagination.nextOffset !== null)
      console.log(`More results: --offset ${report.pagination.nextOffset} --limit ${filters.limit}`);
    if (!baseline.available) console.log(`WARNING: ${baseline.error}`);
    for (const warning of report.diagnostics.warnings) console.log(`WARNING: ${warning}`);
    console.log(report.relationshipScope);
  }
  return 0;
}
