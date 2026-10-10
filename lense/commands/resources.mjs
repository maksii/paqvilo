// Offline resource discovery for editors and agents. No source bodies, browser, or output files.
import fs from 'node:fs';
import path from 'node:path';
import { PortalModel, inlineKindOf, isSourceFile } from '../portal-model.mjs';
import { GitBaseline } from '../git.mjs';
import { Resolver } from '../resolver.mjs';
import { pageKey } from '../html-rewriter.mjs';

export const RESOURCE_KINDS = ['page', 'web-file', 'page-js', 'page-css', 'page-copy', 'page-summary', 'basic-form-js', 'advanced-form-step-js', 'list-js', 'web-template', 'content-snippet', 'metadata-markup', 'route'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const byId = (a, b) => compare(a.id, b.id);
const normalizePath = (file) => file.replace(/\\/g, '/');

function integer(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(`${name} must be an integer from 0 to ${max}`);
  return Number(value);
}

export function resourceFilters(args = {}) {
  const limit = integer(args.limit, 100, '--limit', 500);
  if (!limit) throw new Error('--limit must be between 1 and 500');
  const kinds = args.kind === undefined ? [] : [args.kind].flat();
  for (const kind of kinds) if (!RESOURCE_KINDS.includes(kind)) throw new Error(`Unknown resource kind "${kind}". Supported: ${RESOURCE_KINDS.join(', ')}`);
  if (args.page !== undefined && (typeof args.page !== 'string' || !args.page.startsWith('/') || args.page.startsWith('//') || /[\\?#\x00-\x1f]/.test(args.page))) throw new Error('--page must be a same-origin URL path without a query or fragment');
  return { page: args.page === undefined ? null : pageKey(args.page), kinds: [...new Set(kinds)].sort(compare), search: args.search?.trim() ?? '', changed: Boolean(args.changed), offset: integer(args.offset, 0, '--offset'), limit };
}

/** Describe only relationships established by the existing portal model, not inferred runtime use. */
export function describeResources(cfg, model, baseline, changed, filters = resourceFilters()) {
  filters = { ...filters, page: filters.page == null ? null : pageKey(filters.page, model) };
  if (filters.changed && !baseline.available) throw new Error('Cannot select changed resources: the requested Git baseline is unavailable');
  const relative = (file) => file ? normalizePath(path.relative(cfg.sourceDir, file)) : null;
  const changedAt = (file) => {
    if (!baseline.available) return null;
    if (!file) return false;
    const rel = path.relative(cfg.sourceDir, file);
    // The Git snapshot is deliberately scoped to the extract, including when an explicit
    // route serves a file from elsewhere. Absence from that snapshot does not prove it clean.
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    return changed.has(file);
  };
  const resolver = new Resolver(model, cfg.site, { changed: cfg.site.scope === 'changed' ? changed : null });
  const resources = [];
  const relationships = [];
  const pagesByUrl = new Map();
  const pageResources = new Map();
  const pageMetadata = new Map();
  const rootId = (id) => {
    id = String(id ?? '').toLowerCase();
    const seen = new Set();
    while (model.pageAlias.has(id) && !seen.has(id)) { seen.add(id); id = model.pageAlias.get(id); }
    return id;
  };
  if (model.format === 'classic') for (const [file, metadata] of model.currentYaml) {
    // PAC YAML pages carry adx_webpageid; .powerpages-site pages keep their ID in id:.
    const pageId = metadata.adx_webpageid ?? (model.shortKey && file.endsWith('.webpage.yml') ? metadata.id : undefined);
    if (!pageId) continue;
    const id = rootId(pageId);
    if (!pageMetadata.has(id)) pageMetadata.set(id, []);
    pageMetadata.get(id).push(file);
  }
  const pageComponents = new Map();
  for (const [componentId, pageIds] of model.componentPages) for (const pageId of pageIds) {
    const id = rootId(pageId);
    if (!pageComponents.has(id)) pageComponents.set(id, new Set());
    pageComponents.get(id).add(componentId);
  }
  for (const page of model.pages.values()) {
    const url = model.pagePath(page.id);
    const metadataPaths = (model.format === 'enhanced' ? [path.join(page.dir, 'powerpagecomponent.xml')] : pageMetadata.get(page.id) ?? []).filter((file) => isSourceFile(cfg.sourceDir, file)).sort(compare);
    const resource = {
      id: `page:${page.id}`, kind: 'page', name: page.name ?? page.id, recordId: page.id,
      path: null, relativePath: null, directory: page.dir, metadataPaths, field: null, url,
      relatedPageUrls: url ? [url] : [], configuredComponentIds: [...pageComponents.get(page.id) ?? []].sort(compare),
      changed: baseline.available ? metadataPaths.some((file) => changed.has(file)) : null,
      preview: { strategy: 'portal-page', supported: false, reason: 'Page records and server configuration require deployment; edit the related source resources for local previews.' },
    };
    resources.push(resource);
    pageResources.set(resource.id, resource);
    if (url) {
      const key = pageKey(url);
      if (!pagesByUrl.has(key)) pagesByUrl.set(key, []);
      pagesByUrl.get(key).push(resource.id);
    }
    if (page.parentId && model.pages.has(rootId(page.parentId))) relationships.push({ sourceId: resource.id, targetId: `page:${rootId(page.parentId)}`, kind: 'parent-page', evidence: { type: 'extract-metadata', paths: metadataPaths } });
  }
  const relate = (resource, urls, kind, metadataPaths) => {
    for (const url of urls) for (const targetId of pagesByUrl.get(pageKey(url)) ?? []) relationships.push({ sourceId: resource.id, targetId, kind, evidence: { type: 'extract-metadata', paths: [...new Set([...metadataPaths, ...pageResources.get(targetId).metadataPaths])].sort(compare) } });
  };
  for (const file of model.webFiles) {
    const effective = file.url ? resolver.resolve(file.url) : null;
    const resource = {
      id: `web-file:${relative(file.yml)}`, kind: 'web-file', name: file.name ?? relative(file.file) ?? relative(file.yml), recordId: file.id ?? null,
      path: file.file, relativePath: relative(file.file), metadataPaths: [file.yml], field: null, url: file.url,
      relatedPageUrls: model.pagePath(file.parentPageId) ? [model.pagePath(file.parentPageId)] : [],
      changed: baseline.available ? changedAt(file.file) || changedAt(file.yml) : null,
      preview: { strategy: 'local-response', supported: Boolean(file.file && file.url && !file.problem), selected: Boolean(file.file && effective?.file === file.file), effectivePath: effective?.file ?? null, via: effective?.via ?? null, reason: file.problem ?? null },
    };
    resources.push(resource);
    relate(resource, resource.relatedPageUrls, 'parent-page', resource.metadataPaths);
  }
  for (const source of model.inlineSources) {
    const def = inlineKindOf(source.file);
    const metadata = source.extract ? source.file : def ? source.file.slice(0, -def.suffix.length) + def.suffix.replace(/\.[^.]+\.[^.]+$/, '.yml') : null;
    const metadataPaths = metadata && (source.extract || model.currentYaml.has(metadata)) && isSourceFile(cfg.sourceDir, metadata) ? [metadata] : [];
    const kinds = source.mode === 'block' ? cfg.site.inline : cfg.site.markup;
    const configured = Boolean(kinds?.enabled && kinds.kinds.includes(source.kind));
    const pageResolved = !source.kind.startsWith('page-') || source.pageUrl !== null;
    const readable = isSourceFile(cfg.sourceDir, source.file);
    const knownPages = source.pageUrl ? [source.pageUrl] : source.usedOn ?? [];
    const resource = {
      id: `source:${source.kind}:${source.rel}`, kind: source.kind, name: source.label ?? model.currentYaml.get(metadata)?.adx_name ?? (model.shortKey ? model.currentYaml.get(metadata)?.name : undefined) ?? path.basename(source.file),
      path: source.file, sourceDir: cfg.sourceDir, relativePath: relative(source.file), metadataPaths, field: source.field ?? null, format: source.format ?? (source.extract ? 'xml' : 'text'),
      ...(source.fieldPath ? { fieldPath: source.fieldPath, ...(source.jsonPath ? { jsonPath: source.jsonPath } : {}) } : {}),
      ...(source.recordId ? { recordId: source.recordId, recordIdField: source.recordIdField } : {}), ...(source.lcid != null ? { lcid: source.lcid } : {}), url: null,
      relatedPageUrls: [...new Set(knownPages)].sort(compare), changed: changedAt(source.file),
      preview: {
        strategy: source.mode === 'block' ? 'inline-block' : 'baseline-patch', supported: readable && pageResolved,
        enabled: configured, eligible: configured && readable && pageResolved && (source.mode === 'markup' || cfg.site.scope === 'changed' ? baseline.available && changed.has(source.file) : true),
        reason: !readable ? 'Source is missing or outside the extract' : !pageResolved ? 'The page URL cannot be resolved from metadata' : source.mode === 'markup' ? 'Only supported literal changes can be patched; runtime matching and Liquid require separate validation.' : 'Inline content is matched against the rendered page; eligibility does not prove it appears there.',
      },
    };
    resources.push(resource);
    relate(resource, knownPages, source.pageUrl ? 'belongs-to-page' : 'configured-on-page', metadataPaths);
  }
  for (const [index, rule] of (cfg.site.routes ?? []).entries()) {
    const target = rule.file ?? rule.dir;
    const file = target ? path.resolve(cfg.sourceDir, target) : null;
    let exists = null;
    if (file) { try { const stat = fs.statSync(file); exists = rule.file ? stat.isFile() : stat.isDirectory(); } catch { exists = false; } }
    resources.push({ id: `route:${index}`, kind: 'route', name: rule.url, path: rule.file ? file : null, relativePath: rule.file ? relative(file) : null, directory: rule.dir ? file : null, metadataPaths: [cfg.configFile].filter(Boolean), field: null, url: null, pattern: rule.url, relatedPageUrls: [], changed: rule.file ? changedAt(file) : null,
      preview: { strategy: rule.passthrough ? 'passthrough' : rule.dir ? 'directory-route' : 'file-route', exists, precedence: index, reason: 'Routes are evaluated in configuration order before automatic web-file mappings.' } });
  }
  resources.sort(byId);
  relationships.sort((a, b) => compare(`${a.sourceId}\0${a.targetId}\0${a.kind}`, `${b.sourceId}\0${b.targetId}\0${b.kind}`));
  const needle = filters.search.toLowerCase();
  const matching = resources.filter((resource) =>
    (!filters.kinds.length || filters.kinds.includes(resource.kind)) &&
    (!filters.page || resource.relatedPageUrls.some((url) => pageKey(url) === filters.page)) &&
    (!filters.changed || resource.changed) &&
    (!needle || [resource.id, resource.name, resource.relativePath, resource.url, resource.pattern, ...resource.relatedPageUrls].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle))),
  );
  const selected = matching.slice(filters.offset, filters.offset + filters.limit);
  const selectedIds = new Set(selected.map((resource) => resource.id));
  return {
    schemaVersion: 1, command: 'resources', ok: true, offline: true, writesFiles: false,
    site: cfg.siteName, environment: cfg.envName, origin: cfg.origin, sourceDir: cfg.sourceDir, format: model.format, scope: cfg.site.scope,
    baseline: { requested: baseline.spec, commit: baseline.available ? baseline.commit : null, available: baseline.available, error: baseline.error ?? null },
    filters, pagination: { total: matching.length, offset: filters.offset, limit: filters.limit, returned: selected.length, nextOffset: filters.offset + selected.length < matching.length ? filters.offset + selected.length : null },
    resources: selected,
    relationships: relationships.filter((edge) => selectedIds.has(edge.sourceId)),
    relationshipScope: 'Indexed page hierarchy and configured form/list usage only. Runtime requests, Liquid includes, template inheritance and dynamic dependencies are not inferred.',
    diagnostics: { warnings: [...model.warnings].sort(compare) },
  };
}

export default async function resources(cfg, args) {
  const filters = resourceFilters(args);
  const model = await PortalModel.create(cfg.sourceDir);
  const baseline = new GitBaseline(cfg.sourceDir, cfg.site.markup.baseline);
  const changed = await baseline.changedFilesAsync({ refreshRef: false });
  const report = describeResources(cfg, model, baseline, changed, filters);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.site} @ ${report.environment}: ${report.pagination.total} matching resources (offline)`);
    for (const resource of report.resources) console.log(`${resource.kind.padEnd(22)} ${resource.url ?? resource.pattern ?? resource.relatedPageUrls.join(', ')}  ${resource.relativePath ?? resource.directory ?? ''}${resource.field ? ` #${resource.field}` : ''}\n  ${resource.id}`);
    if (report.pagination.nextOffset !== null) console.log(`More results: --offset ${report.pagination.nextOffset} --limit ${filters.limit}`);
    if (!baseline.available) console.log(`WARNING: ${baseline.error}`);
    for (const warning of report.diagnostics.warnings) console.log(`WARNING: ${warning}`);
    console.log(report.relationshipScope);
  }
  return 0;
}
