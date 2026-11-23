// Source-only inspection for a live Lense tab. No runtime, data pack or live request is started.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readLocalFile } from './local-file.mjs';
import {
  importPortal,
  portalField,
  normalizePortalPath,
  effectiveSnippetRecords,
  pageTemplateKind,
} from '../mirage/lib/importer.mjs';
import { importSolutionMetadata, portalMetadataEntities } from '../mirage/lib/solution-metadata.mjs';
import { loadProjectConfig } from '../mirage/lib/project-config.mjs';
import { inspectPage } from '../mirage/lib/page-resources.mjs';
import { stripLiquidLiteralBlocks } from '../mirage/lib/liquid-source.mjs';
import { buildPermissionModel } from '../mirage/lib/permissions.mjs';
import { importCodeComponents } from '../mirage/lib/code-components.mjs';
import { elementSourceHints, scriptSourceHints } from './element-provenance.mjs';
import { PCF_RESOURCE_PATH, PCF_REFUSALS } from './pcf-resources.mjs';

// Web API roots that route to a server logic or a cloud flow instead of a table's entity set.
const NON_TABLE_API_SEGMENTS = new Set(['cloudflow', 'serverlogics']);
const isEntitySetSegment = (value) => /^[a-z]\w*$/i.test(value) && !NON_TABLE_API_SEGMENTS.has(value.toLowerCase());
import { assetKind } from '../mirage/lib/asset-type.mjs';
import { SolutionFileCache, fileStamp, mapLimit } from '../mirage/lib/solution-cache.mjs';
import { resolvePluginSourcePath } from '../mirage/lib/exported-plugins.mjs';
import { buildPortalSourceIndex, sourceEditorTarget } from '../mirage/lib/portal-source-index.mjs';
import { loadDeploymentProfiles } from '../mirage/lib/deployment-profiles.mjs';
import { definitionQuery } from './definition-query.mjs';
import { moduleImportMatches } from '../mirage/lib/text-scanning.mjs';
import { contentStylesheetFiles } from '../mirage/lib/liquid.mjs';
import { discoverSolutionRoots } from '../mirage/lib/solution-roots.mjs';

// Keep the browser entry point serializable, with owned dependencies embedded.
/* NOSONAR */ export const inspectRenderedPage = new Function(
  `return function inspectRenderedPage(){const definitionQuery=(${definitionQuery.toString()}); return (${inspectRenderedPageImpl.toString()})();};`,
)();

const SERVER_LOGIC_ROUTE = /^\/_api\/serverlogics\//i;
const REQUEST_PATH_LIMIT = 500,
  REQUEST_PATH_LENGTH = 512;
const ENTITY_SET_ROUTE = /^\/_api\/([a-z]\w*)(?:\(|\/|$)/i;
const routePathname = (url) => (URL.canParse(url) ? new URL(url).pathname : '');
// The page's resource-timing buffer stops recording once it holds 250 entries, so the session's own request events are the
// complete source for the routes it requested.
const unionOf = (fromPage, recorded) => [...new Set([...(fromPage ?? []), ...recorded])];

const withoutHash = (url) => String(url).split('#')[0];
const sameOrigin = (url, documentUrl) =>
  URL.canParse(url) && URL.canParse(documentUrl) && new URL(url).origin === new URL(documentUrl).origin;

/**
 * Records the Web API routes a page requests, from the session's own request events, so the evidence does not
 * depend on the page's resource-timing buffer. `merge` adds them to what the page itself reported.
 */
export function createApiRouteObserver() {
  const apiSets = new Set();
  const serverLogicPaths = new Set();
  // Every same-origin request path (web files, server logic, cloud-flow endpoints), so the inspection can mark the
  // export records they resolve to as requested. Pathnames only: query values and fragments are never kept.
  const requestPaths = new Set();
  // The last navigation the main frame requested, without its fragment. Its commit
  // replaces the document whose routes are kept.
  let documentRequest = null;
  return {
    record(url, documentUrl) {
      if (!sameOrigin(url, documentUrl)) return;
      const route = routePathname(url);
      if (SERVER_LOGIC_ROUTE.test(route)) serverLogicPaths.add(route);
      const match = ENTITY_SET_ROUTE.exec(route);
      if (match) apiSets.add(match[1]);
      if (route && route.length <= REQUEST_PATH_LENGTH && requestPaths.size < REQUEST_PATH_LIMIT)
        requestPaths.add(route);
    },
    navigationRequested(url) {
      documentRequest = withoutHash(url);
    },
    committed(url) {
      if (documentRequest !== withoutHash(url)) return;
      documentRequest = null;
      apiSets.clear();
      serverLogicPaths.clear();
      requestPaths.clear();
    },
    merge(rendered) {
      let merged = { ...rendered, apiSets: unionOf(rendered.apiSets, apiSets) };
      const logicPaths = unionOf(rendered.serverLogicPaths, serverLogicPaths);
      if (logicPaths.length) merged = { ...merged, serverLogicPaths: logicPaths };
      const paths = unionOf(rendered.requestPaths, requestPaths).slice(0, REQUEST_PATH_LIMIT);
      return paths.length ? { ...merged, requestPaths: paths } : merged;
    },
  };
}

const norm = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
// Solution metadata keys component schemas by record ID only (solution-metadata.mjs): a name is not unique across
// basic forms and lists, so a name lookup could join a form to a same-named list's view.
const componentSchema = (metadata, id) => (id ? metadata.componentSchemas?.[id] : undefined);
// Keep a synchronous final check for callers that await browser selection
// validation after the asynchronous import. Do not serialize this capability.
const editorAdmission = (read) => {
  const admission = read();
  if (admission.state === 'exact')
    Object.defineProperty(admission, 'revalidate', {
      value: () => {
        const current = read();
        return current.state === 'exact' ? current : { ...current, state: 'stale' };
      },
    });
  return admission;
};
const unique = (rows, key) => [...new Map(rows.map((row) => [key(row), row])).values()];
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const MARKUP_SOURCE_LIMIT = 1024 * 1024,
  OMITTED_SOURCE_NAME_LIMIT = 10;
const displaySource = (portal, source) => {
  if (!source.sourceFile)
    return String(source.name ?? 'Source')
      .replaceAll('\\', '/')
      .split('/')
      .pop();
  if (!inside(portal.sourceDir, source.sourceFile)) return path.basename(source.sourceFile);
  return path.relative(portal.sourceDir, source.sourceFile).replaceAll('\\', '/');
};
const exportIndexes = new WeakMap();
const provenanceIndexes = new WeakMap();
const provenanceIndex = (portal, metadata, codeCatalogue) => {
  let cached = provenanceIndexes.get(portal);
  codeCatalogue ??= cached?.codeCatalogue;
  if (!cached || cached.metadata !== metadata || cached.codeCatalogue !== codeCatalogue) {
    cached = { metadata, codeCatalogue, index: buildPortalSourceIndex({ portal, metadata, codeCatalogue }) };
    provenanceIndexes.set(portal, cached);
  }
  return cached.index;
};
const hintIdentity = (index, record, field, selected = null) => {
  const ref = selected ?? index.source(record, field);
  return {
    recordId: ref?.recordId ?? norm(record?.id),
    fieldPath: ref?.fieldPath ?? [field],
    languageId: ref?.languageId ?? null,
    profileId: ref?.profileId ?? null,
    ...(ref
      ? {
          sourceRefId: ref.id,
          sourceKey: ref.key,
          sourceRevision: ref.sourceRevision,
          contentRevision: ref.contentRevision,
          ...(ref.lcid !== undefined ? { lcid: ref.lcid, jsonPath: ref.jsonPath } : {}),
        }
      : {}),
  };
};
const bodyFile = (record, suffix) => {
  const file = record?._file;
  if (!file) return null;
  if (/powerpagecomponent\.xml$/i.test(file)) return file;
  const sidecar = file.replace(/\.ya?ml$/i, '.' + suffix);
  return existsSync(sidecar) ? sidecar : file;
};
// Match the imported-file cache's change detection without reading every asset body.
async function inspectionDirectoryStamp(root) {
  const files = [],
    skip = new Set(['.git', '.portalconfig', 'node_modules', '.paqvilo']);
  let directories = [root];
  while (directories.length) {
    const next = [];
    await mapLimit(directories, 32, async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || skip.has(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) next.push(file);
        else if (entry.isFile()) files.push(file);
      }
    });
    directories = next;
  }
  files.sort(/* NOSONAR: preserve default string coercion */);
  return mapLimit(files, 64, async (file) => [path.relative(root, file), (await fileStamp(file)).stamp]);
}
async function mappedPluginStamps(sources) {
  return mapLimit(Object.entries(sources.observed?.pluginSources ?? {}), 24, async ([typeName, mapping]) => {
    try {
      const file = await resolvePluginSourcePath(mapping, sources.sourceDir);
      return [typeName, file, (await fileStamp(file)).stamp];
    } catch (error) {
      // Missing/invalid mappings stay diagnostics. Remember the outcome so a
      // missing file recreated later invalidates the report without a root walk.
      return [typeName, { unavailable: error.code ?? error.message }];
    }
  });
}
const hintTokens = (hint) => {
  if (hint.matchKind === 'id') return ['id:' + hint.domId];
  if (hint.matchKind === 'class') return (hint.classes ?? []).map((name) => 'class:' + hint.tag + ':' + name);
  return Object.entries(hint.attributes ?? {}).map(
    ([name, value]) => 'attribute:' + hint.tag + ':' + name + ':' + value,
  );
};
const markupKey = (source) => JSON.stringify([source.kind, source.sourceFile, source.recordId ?? source.id ?? '']);

function cachedSourceHints(body, source, key, previous, relatedIndexes) {
  let old = previous?.hintsBySource.get(key);
  if (old?.body !== body)
    for (const related of relatedIndexes) {
      const entry = related.hintsBySource.get(key);
      if (entry && entry.body === body) {
        old = entry;
        break;
      }
    }
  return old && old.body === body
    ? old.hints.map((hint) => ({ ...hint, ...source }))
    : elementSourceHints(body, source);
}

function addIndexedHints(source, hints, byToken, frequencies) {
  for (const hint of hints) {
    if (source.kind !== 'page')
      for (const token of hintTokens(hint)) {
        let rows = byToken.get(token);
        if (!rows) {
          rows = [];
          byToken.set(token, rows);
        }
        rows.push(hint);
      }
    if (hint.matchKind === 'class') {
      let files = frequencies.get(hint.selector);
      if (!files) {
        files = new Set();
        frequencies.set(hint.selector, files);
      }
      files.add(source.sourceFile + '#' + source.id);
    }
  }
}

function indexMarkupSource(body, source, options) {
  const { portal, previous, relatedIndexes, hintsBySource, byToken, frequencies, omittedSources, state } = options;
  if (String(body ?? '').length > MARKUP_SOURCE_LIMIT) {
    state.markupOmittedSourceCount++;
    if (omittedSources.length < OMITTED_SOURCE_NAME_LIMIT) {
      const name = displaySource(portal, source);
      omittedSources.push(name.length > 240 ? name.slice(0, 237) + '...' : name);
    }
    return;
  }
  const key = markupKey(source);
  const hints = cachedSourceHints(body, source, key, previous, relatedIndexes);
  hintsBySource.set(key, { body, hints });
  addIndexedHints(source, hints, byToken, frequencies);
}

function indexedForms(portal, metadata) {
  return [...(portal.forms ?? []), ...(portal.advancedForms ?? [])].map((form) => {
    const schema = componentSchema(metadata, form.id),
      advanced = form.metadata?.kind === 'advancedform';
    const formLayouts = advanced ? formLayoutsForSchema(schema) : [];
    return {
      id: form.id,
      name: form.name,
      kind: advanced ? 'advanced-form' : 'basic-form',
      entity: form.entityName ?? schema?.entity,
      ...(advanced
        ? {
            formLayouts,
            configuredEntities: [
              ...new Set(
                [form.entityName, schema?.entity, ...(schema?.steps ?? []).map((step) => step.entity)]
                  .filter((entity) => typeof entity === 'string' && /^[a-z][a-z0-9_]*$/i.test(entity))
                  .map((entity) => entity.toLowerCase()),
              ),
            ],
          }
        : {}),
      sourceFile: form.metadata?._file,
      formXml:
        !advanced && schema?.sourceFile
          ? { id: schema.formId, name: schema.formName, sourceFile: schema.sourceFile }
          : null,
      pageReferenced: false,
    };
  });
}

function formLayoutsForSchema(schema) {
  const formLayouts = [];
  const collectLayouts = (current, depth = 0) => {
    if (!current || depth > 5) return;
    if (current.formId && current.entity && !formLayouts.some((layout) => norm(layout.id) === norm(current.formId)))
      formLayouts.push({
        id: current.formId,
        entity: current.entity.toLowerCase(),
        name: current.formName,
        sourceFile: current.sourceFile,
      });
    for (const step of current.steps ?? []) collectLayouts(step, depth + 1);
  };
  collectLayouts(schema);
  return formLayouts;
}

const LAYOUT_TAB_LIMIT = 100,
  LAYOUT_SECTION_LIMIT = 100;
/**
 * The tabs and sections of each FormXml the report names, as `[{ name: <tab>, sections: [<section name>] }]`, from the
 * compiled form structure of the Solution metadata index (lense/model-driven-metadata.mjs formStructure). The node
 * observer then proves a rendered tab or section by its FormXml name. Rows are copied, never written into the cached
 * export index the component index rows come from.
 */
function layoutOfStructure(structure) {
  const tabs = new Map();
  for (const item of structure) {
    if (item?.kind === 'tab' && typeof item.name === 'string' && tabs.size < LAYOUT_TAB_LIMIT && !tabs.has(item.name))
      tabs.set(item.name, { name: item.name, sections: [] });
    const tab = item?.kind === 'section' && tabs.get(item.tab);
    if (tab && typeof item.name === 'string' && tab.sections.length < LAYOUT_SECTION_LIMIT)
      tab.sections.push(item.name);
  }
  return tabs.size ? [...tabs.values()] : null;
}

function attachFormLayouts(report, metadataIndex) {
  if (typeof metadataIndex?.formStructure !== 'function') return;
  const layouts = new Map();
  const layoutOf = (id) => {
    const key = 'form:' + norm(id);
    if (!norm(id)) return null;
    if (!layouts.has(key)) {
      let structure = [];
      try {
        structure = metadataIndex.formStructure(key) ?? [];
      } catch {
        /* A form whose FormXml does not compile has no layout to prove its tabs by. */
      }
      layouts.set(key, layoutOfStructure(structure));
    }
    return layouts.get(key);
  };
  const withLayout = (row) => {
    const layout = row && layoutOf(row.id);
    return layout ? { ...row, layout } : row;
  };
  for (const form of [...(report.forms ?? []), ...(report.componentIndex?.forms ?? [])]) {
    if (form.formXml) form.formXml = withLayout(form.formXml);
    if (Array.isArray(form.formLayouts)) form.formLayouts = form.formLayouts.map(withLayout);
  }
}

function addMetadataForms(forms, metadata) {
  for (const form of metadata.forms ?? [])
    if (!forms.some((item) => norm(item.id) === norm(form.id)))
      forms.push({
        id: form.id,
        name: form.name,
        entity: form.entity,
        kind: 'FormXml',
        sourceFile: form.file,
        pageReferenced: false,
      });
}

function exportIndex(portal, metadata, indexStore = null) {
  let index = exportIndexes.get(portal);
  if (index?.metadata === metadata) return index;
  const language = norm(
    portal.selectedLanguageId ?? portal.language?.id ?? portalField(portal.website, 'defaultlanguage'),
  );
  const provenance = provenanceIndex(portal, metadata);
  const previous = indexStore?.get(language),
    relatedIndexes = [...(indexStore?.values() ?? [])].filter((value) => value !== previous),
    hintsBySource = new Map();
  const sourceFiles = new Map(),
    sourceFile = (record, suffix) => {
      const key = record?._file + '#' + suffix;
      if (!sourceFiles.has(key)) sourceFiles.set(key, bodyFile(record, suffix));
      return sourceFiles.get(key);
    };
  const snippets = effectiveSnippetRecords(portal.records ?? [], language);
  const sources = [
    ...(portal.pages ?? []).map((page) => ({
      body: page.html,
      id: page.id,
      ...hintIdentity(provenance, page.metadata, 'copy'),
      sourceFile: provenance.source(page.metadata, 'copy')?.file ?? sourceFile(page.metadata, 'copy.html'),
      kind: 'page',
      name: page.name,
    })),
    ...[...new Set(Object.values(portal.templates ?? {}))].map((template) => ({
      body: template.source,
      id: template.id,
      ...hintIdentity(provenance, template.metadata, 'source'),
      sourceFile: provenance.source(template.metadata, 'source')?.file ?? sourceFile(template.metadata, 'source.html'),
      kind: 'template',
      name: template.name,
    })),
    ...snippets.records().map((row) => ({
      body: portal.snippets?.[row.name],
      id: row.id,
      ...hintIdentity(provenance, row, 'value'),
      sourceFile: provenance.source(row, 'value')?.file ?? sourceFile(row, 'value.html'),
      kind: 'snippet',
      name: row.name,
    })),
  ];
  const frequencies = new Map();
  const byToken = new Map(),
    markupOmittedSources = [];
  const state = { markupOmittedSourceCount: 0 };
  for (const { body, ...source } of sources)
    indexMarkupSource(body, source, {
      portal,
      previous,
      relatedIndexes,
      hintsBySource,
      byToken,
      frequencies,
      omittedSources: markupOmittedSources,
      state,
    });
  const forms = indexedForms(portal, metadata);
  // Quick-view documents can identify a system form directly, independently
  // of an opener's include graph or a basic-form record.
  addMetadataForms(forms, metadata);
  const lists = (portal.lists ?? []).map((list) => ({
    id: list.id,
    recordId: list.id,
    name: list.name,
    kind: 'list',
    entity: list.entityName,
    sourceFile: list.metadata?._file,
    pageReferenced: false,
    evidenceLabel: 'List in your sources; not used by this page',
    ...listInspectionBindings(list, portal),
  }));
  index = {
    metadata,
    byToken,
    hintsBySource,
    markupOmittedSourceCount: state.markupOmittedSourceCount,
    markupOmittedSources,
    classFrequencies: Object.fromEntries([...frequencies].map(([selector, files]) => [selector, files.size])),
    forms,
    lists,
  };
  exportIndexes.set(portal, index);
  if (indexStore) {
    indexStore.set(language, index);
    // Reuse matching sources before discarding a removed/default-less language.
    const languages = new Set([
      norm(portalField(portal.website, 'defaultlanguage')),
      ...(portal.websiteLanguages ?? []).map((row) => norm(row.id)),
    ]);
    for (const key of indexStore.keys()) if (!languages.has(key)) indexStore.delete(key);
  }
  return index;
}

function listInspectionActions(settings) {
  return [
    ...(Array.isArray(settings?.ViewActions) ? settings.ViewActions : []),
    ...(Array.isArray(settings?.ItemActions) ? settings.ItemActions : []),
  ].filter(
    (action) =>
      action &&
      ['CrmEntityFormView-CreateAction', 'CrmEntityFormView-EditAction', 'CrmEntityFormView-DetailsAction'].includes(
        action.Type,
      ),
  );
}

function parseListViewSetting(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function appendListViewIds(value, viewIds) {
  const values = value?.Views ?? value?.views ?? value;
  let viewValues = [];
  if (Array.isArray(values)) viewValues = values;
  else if (values) viewValues = [values];
  for (const view of viewValues) {
    const id = typeof view === 'object' ? (view.ViewId ?? view.viewId ?? view.id ?? view.value) : view;
    if (id) viewIds.push(String(id));
  }
}

function listInspectionViewIds(list) {
  const viewIds = [];
  for (const value of [portalField(list.metadata ?? {}, 'view'), portalField(list.metadata ?? {}, 'views')])
    appendListViewIds(parseListViewSetting(value), viewIds);
  return [...new Set(viewIds)];
}

// The target an action opens (native-services.mjs actionTarget): its TargetType, else a form when it names one, else
// a web page, else a URL. 0 form, 1 web page, 2 URL.
function actionTargetType(action) {
  if (action.TargetType == null || action.TargetType === '') {
    if (action.EntityFormId) return 0;
    if (action.RedirectWebpageId) return 1;
    return action.RedirectUrl ? 2 : 0;
  }
  return Number(action.TargetType);
}

const RELATION_LIMIT = 100;
// A relation to a web page: the page record when the export has it, else an unresolved reference.
function pageRelation(kind, pageId, owner, portal, extra = {}) {
  const id = norm(pageId);
  if (!id) return null;
  const page = (portal?.pages ?? []).find((row) => norm(row.id) === id);
  return {
    kind,
    pageId: id,
    name: page?.name ?? null,
    url: page?.url ?? null,
    sourceFile: page?.metadata?._file ?? null,
    resolved: Boolean(page),
    owner,
    ...extra,
  };
}

/**
 * What a list or subgrid action leads to: the web page or URL it redirects to and the workflow it runs. The form an
 * action opens stays on the action row (formId). Workflow identity is read from Workflow.Id or WorkflowId.
 */
function actionRelations(action, owner, portal) {
  const name = String(action?.Type ?? 'action').replace('CrmEntityFormView-', '');
  const via = `${owner} ${name}`;
  const target = actionTargetType(action);
  const relations = [];
  if (target === 1 && action.RedirectWebpageId)
    relations.push(pageRelation('action-page', action.RedirectWebpageId, via, portal, { action: name }));
  if (target === 2 && action.RedirectUrl)
    relations.push({ kind: 'action-url', url: String(action.RedirectUrl).slice(0, 2048), owner: via, action: name });
  const workflow = action.Workflow?.Id ?? action.Workflow?.id ?? action.WorkflowId;
  if (/WorkflowAction$/.test(String(action?.Type ?? '')))
    relations.push({
      kind: 'workflow',
      workflowId: workflow ? norm(workflow) : null,
      name: action.Workflow?.Name ?? null,
      owner: via,
      action: name,
      resolved: false,
    });
  return relations.filter(Boolean);
}

function listInspectionBindings(list, portal = null) {
  let settings;
  try {
    settings = JSON.parse(portalField(list.metadata ?? {}, 'settings', '{}'));
  } catch {
    settings = {};
  }
  const actions = listInspectionActions(settings);
  const allActions = [
    ...(Array.isArray(settings?.ViewActions) ? settings.ViewActions : []),
    ...(Array.isArray(settings?.ItemActions) ? settings.ItemActions : []),
  ].filter((action) => action && typeof action === 'object');
  const relations = [
    pageRelation('details-page', portalField(list.metadata ?? {}, 'webpagefordetailsview'), list.name, portal),
    pageRelation('create-page', portalField(list.metadata ?? {}, 'webpageforcreate'), list.name, portal),
    ...allActions.flatMap((action) => actionRelations(action, list.name, portal)),
  ]
    .filter(Boolean)
    .slice(0, RELATION_LIMIT);
  return {
    viewIds: listInspectionViewIds(list),
    actions: actions.map((action) => ({
      name: action.Type.replace('CrmEntityFormView-', ''),
      formId: action.EntityFormId && actionTargetType(action) === 0 ? norm(action.EntityFormId) : null,
      targetType: action.TargetType ?? null,
      targetPageId: actionTargetType(action) === 1 && action.RedirectWebpageId ? norm(action.RedirectWebpageId) : null,
      targetUrl: actionTargetType(action) === 2 && action.RedirectUrl ? String(action.RedirectUrl) : null,
      conditional: Boolean(action.FilterCriteria),
      evidence: 'exported-action',
    })),
    relations,
  };
}
const indexedMarkupHints = (body, source, index) => {
  const entry = index.hintsBySource.get(markupKey(source));
  if (!entry || entry.body !== body) return elementSourceHints(body, source);
  // Index rows own only these four source fields. Rebind richer page/report
  // descriptors and clone hint ancestry so callers cannot mutate the index.
  return entry.hints.map(({ id, name, kind, sourceFile, ...hint }) => ({ ...structuredClone(hint), ...source }));
};

/**
 * The lookup key of a web-file address, as the runtime serves web files (mirage/server.mjs: normalizePortalPath):
 * case-insensitive, percent-decoded, without query, fragment, trailing slash or an application-relative `~/`.
 */
function webFileKey(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return normalizePortalPath(value.replace(/^~(?=\/)/, '').split(/[?#]/, 1)[0] || '/');
  } catch {
    return null;
  }
}

const ASSET_REFERENCE_LIMIT = 2000;
// Resolve declared browser resources against their browser URL, never a source directory. Returns web-file keys.
function assetPaths(text, basePath) {
  const values = [];
  const source = String(text ?? '');
  const patterns = [
    /\b(?:src|href|poster)\s*=\s*['"]([^'"]+)['"]/gi,
    /\burl\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi,
    /@import\s+['"]([^'"]+)['"]/gi,
    null, // Static imports use a monotone scanner below; preserve this pattern's position in the result order.
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gi,
    // Literal script requests: fetch, jQuery requests, new URL and an options object's url.
    /\bfetch\(\s*['"`]([^'"`$]+)['"`]/gi,
    /(?:\$|\bjQuery)\.(?:get|getJSON|getScript|post|ajax)\(\s*['"`]([^'"`$]+)['"`]/g,
    /\bnew\s+URL\(\s*['"`]([^'"`$]+)['"`]/g,
    /\burl\s*:\s*['"`]([^'"`$]+)['"`]/g,
  ];
  const add = (reference) => {
    if (!reference || reference.includes('{{') || reference.startsWith('#') || values.length >= ASSET_REFERENCE_LIMIT)
      return;
    try {
      const url = new URL(reference.replace(/^~(?=\/)/, ''), new URL(basePath, 'http://inspect.invalid')); // NOSONAR: reserved or loopback placeholder host, not a real transport
      if (url.origin === 'http://inspect.invalid') values.push(webFileKey(url.pathname)); // NOSONAR: reserved or loopback placeholder host, not a real transport
    } catch {
      /* Optional inspection or cleanup failure must not interrupt the owning operation. */
    }
  };
  for (const pattern of patterns)
    for (const match of pattern ? source.matchAll(pattern) : moduleImportMatches(source)) add(match[1]);
  // srcset lists candidates separated by commas, each a URL and an optional descriptor.
  for (const match of source.matchAll(/\bsrcset\s*=\s*(['"])([^'"]+)\1/gi))
    for (const candidate of match[2].split(',').slice(0, 20)) add(candidate.trim().split(/\s+/)[0]);
  return values.filter(Boolean);
}

/** The Solution roots that are directories, as real paths; each one that is not is reported in `diagnostics`. */
async function existingSolutionRoots(roots, diagnostics) {
  const selected = [];
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory');
      selected.push(real);
    } catch {
      diagnostics.push({
        code: 'INSPECT_SOLUTION_UNAVAILABLE',
        reason: `Solution source folder not found: ${root}`,
      });
    }
  }
  return selected;
}

/**
 * Solution roots by the rule `mirage dev` applies (lense/commands/mirage.mjs launchSolutionRoots): the roots a running
 * Mirage runtime reported, else the configured project's, else configured solutionRoots, else unpacked Solutions
 * discovered next to the portal's repository. An unrelated project default never replaces this site. The selection
 * and its reason are returned as `selection`, so a report never shows an empty Solution set silently.
 */
export async function inspectionSources(cfg) {
  const configured = cfg.mirageConfig ?? {};
  const sourceDir = await fs.realpath(cfg.sourceDir);
  let rule = 'none';
  let roots = [],
    order = configured.solutionOrder ?? 'derived';
  if (Array.isArray(cfg.mirageSourceRoots)) {
    roots = cfg.mirageSourceRoots.filter(
      (root) => path.resolve(root).toLowerCase() !== path.resolve(cfg.sourceDir).toLowerCase(),
    );
    rule = 'mirage-runtime';
  } else if (Array.isArray(configured.solutionRoots)) {
    roots = configured.solutionRoots;
    rule = 'configured';
  }
  let lcid = 1033,
    observed = configured.observed,
    dataModel = configured.dataModel;
  let deploymentProfile = configured.deploymentProfile ?? null,
    deploymentProfiles = configured.deploymentProfiles;
  const diagnostics = [];
  if (configured.project) {
    try {
      const project = await loadProjectConfig(configured.project);
      const portal = project.portals.find((entry) => entry.sourceDir.toLowerCase() === sourceDir.toLowerCase());
      if (!portal) throw new Error('The configured project does not select this portal source.');
      roots = portal.solutionRoots;
      rule = 'project';
      order = project.solutionOrder;
      lcid = project.lcid;
      observed = portal.observed ?? observed;
      dataModel = portal.dataModel ?? dataModel;
      deploymentProfile = portal.deploymentProfile ?? deploymentProfile;
      deploymentProfiles = portal.deploymentProfiles ?? deploymentProfiles;
    } catch (error) {
      diagnostics.push({ code: 'INSPECT_PROJECT_UNAVAILABLE', reason: error.message });
    }
  }
  if (rule === 'none') {
    roots = await discoverSolutionRoots(sourceDir).catch(() => []);
    if (roots.length) {
      rule = 'sibling-discovery';
      diagnostics.push({
        code: 'INSPECT_SOLUTION_ROOTS_DISCOVERED',
        severity: 'info',
        reason: `No Solution sources are configured; using ${roots.length} unpacked Solution folder(s) found next to the portal repository, as mirage dev does.`,
      });
    }
  }
  const activeProfile = deploymentProfiles ? await loadDeploymentProfiles(deploymentProfiles) : null;
  const selected = await existingSolutionRoots(roots, diagnostics);
  return {
    sourceDir,
    roots: unique(
      selected.map((root) => ({ root })),
      (row) => row.root,
    ).map((row) => row.root),
    order,
    lcid,
    observed,
    dataModel,
    deploymentProfile: activeProfile?.profile ?? deploymentProfile,
    deploymentProfileFile: activeProfile?.pagesFile ?? null,
    diagnostics,
    selection: {
      rule,
      reason: {
        'mirage-runtime': 'The Solution roots of the running Mirage runtime.',
        project: 'The Solution roots of the configured project.',
        configured: 'The configured mirage.solutionRoots.',
        'sibling-discovery': 'No Solution sources are configured; unpacked Solutions next to the portal repository.',
        none: 'No Solution sources are configured and none were found next to the portal repository.',
      }[rule],
    },
  };
}

/** Fixed, bounded DOM read. Do not collect text, field values or credentials.
 * Read only form/table definition hints from frame addresses, never row parameters. */
/* NOSONAR: single-pass routine, splitting it would change shared state */ function inspectRenderedPageImpl() {
  const own = (node) => !node.closest('#paqvilo-panel, #paqvilo-handle, #paqvilo-xray');
  const definitionContext = (address, base) => {
    try {
      const url = new URL(address, base);
      if (url.origin !== location.origin) return {};
      const params = definitionQuery(url);
      const declarations = (keys) =>
        params.filter(([key, value]) => keys.includes(key) && value).map(([, value]) => value);
      const forms = declarations(['entityformid', 'formid']),
        tables = declarations(['entityname', 'tablename', 'etn', 'typename']);
      const normalize = (value) => value.replace(/[{}]/g, '').toLowerCase();
      const formConflict = new Set(forms.map(normalize)).size > 1;
      const tableConflict = new Set(tables.map(normalize)).size > 1;
      const repeatedFormConflict = ['entityformid', 'formid'].some(
        (key) => new Set(declarations([key]).map(normalize)).size > 1,
      );
      const conflict = formConflict || tableConflict;
      return {
        formId: conflict ? '' : (forms[0] ?? ''),
        entity: tableConflict ? '' : (tables[0] ?? ''),
        conflict,
        // A DOM-only read cannot establish whether the two definition keys name
        // one exported basic form and its FormXml. Defer only that exact case.
        ...(formConflict && !tableConflict && !repeatedFormConflict
          ? {
              aliasCandidates: [...new Map(forms.map((id) => [normalize(id), id])).values()]
                .slice(0, 2)
                .map((id) => id.slice(0, 160)),
            }
          : {}),
      };
    } catch {
      return {};
    }
  };
  const pathname = (value) => {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin ? url.pathname : null;
    } catch {
      return null;
    }
  };
  const assets = [],
    controls = [];
  let controlsSeen = 0;
  const controlSelector =
    'input:not([type=hidden]):not([type=password]),select,textarea,[data-entityname],[data-entity],[data-formid],[data-viewid],[data-listid],[data-form-layout],[data-pcf-schema],table[data-paqvilo-table],[id^=EntityList],.entity-grid[data-selected-view],iframe';
  const addControl = (node) => {
    let layout = {};
    try {
      layout = JSON.parse(node.getAttribute('data-form-layout') ?? '{}'); // NOSONAR: reads attributes of observed DOM, dataset would differ
    } catch {
      /* Optional inspection or cleanup failure must not interrupt the owning operation. */
    }
    let frameAddress = node.getAttribute('src');
    if (node.localName === 'iframe')
      try {
        const current = node.contentDocument?.URL;
        if (current && /^https?:/i.test(current)) frameAddress = current;
      } catch {
        /* Inaccessible frames remain boundaries. */
      }
    const frameContext = node.localName === 'iframe' ? definitionContext(frameAddress, node.ownerDocument.baseURI) : {};
    return {
      tag: node.tagName.toLowerCase(),
      id: (node.getAttribute('id') ?? '').slice(0, 160),
      name: (node.getAttribute('name') ?? '').slice(0, 160),
      type: (node.getAttribute('type') ?? '').slice(0, 40),
      entity: String(
        /* NOSONAR: reads attributes of observed DOM, dataset would differ */ node.getAttribute('data-entityname') ??
          /* NOSONAR: reads attributes of observed DOM, dataset would differ */ node.getAttribute('data-entity') ??
          layout.EntityName ??
          frameContext.entity ??
          '',
      ).slice(0, 160),
      formId: String(node.getAttribute('data-formid') ?? layout.Id ?? frameContext.formId ?? '').slice(0, 160), // NOSONAR: reads attributes of observed DOM, dataset would differ
      ...(frameContext.conflict ? { definitionConflict: true } : {}),
      ...(frameContext.aliasCandidates ? { definitionAliasCandidates: frameContext.aliasCandidates } : {}),
      viewId: (node.getAttribute('data-viewid') ?? node.getAttribute('data-selected-view') ?? '').slice(0, 160), // NOSONAR: reads attributes of observed DOM, dataset would differ
      listId: (
        node.getAttribute('data-listid') ?? // NOSONAR: reads attributes of observed DOM, dataset would differ
        /^EntityList(?:Control_)?([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:$|_)/i.exec(
          node.id,
        )?.[1] ??
        ''
      ).slice(0, 160),
      gridId: node.classList.contains('entity-grid') ? (node.closest('.subgrid[id]')?.id ?? '').slice(0, 160) : '',
      ...(node.localName === 'table' && node.hasAttribute('data-paqvilo-table') // NOSONAR: reads attributes of observed DOM, dataset would differ
        ? { gridTable: (node.getAttribute('data-paqvilo-table') ?? '').slice(0, 160) } // NOSONAR: reads attributes of observed DOM, dataset would differ
        : {}),
      controlId: (node.getAttribute('data-controlid') ?? '').slice(0, 160), // NOSONAR: reads attributes of observed DOM, dataset would differ
      schemaName: (node.getAttribute('data-pcf-schema') ?? '').slice(0, 160), // NOSONAR: reads attributes of observed DOM, dataset would differ
      nativeField: (node.closest('[data-pcf-native-field]')?.getAttribute('data-pcf-native-field') ?? '').slice(0, 160), // NOSONAR: reads attributes of observed DOM, dataset would differ
    };
  };
  const apiSets = [
    ...new Set(
      performance
        .getEntriesByType('resource')
        .slice(-300)
        .flatMap((entry) => {
          const route = pathname(entry.name);
          const match = route && /^\/_api\/([a-z]\w*)(?:\(|\/|$)/i.exec(route);
          return match ? [match[1]] : [];
        }),
    ),
  ];
  const serverLogicPaths = [
    ...new Set(
      performance
        .getEntriesByType('resource')
        .slice(-300)
        .map((entry) => pathname(entry.name))
        .filter((route) => route && /^\/_api\/serverlogics\//i.test(route)),
    ),
  ];
  const attributes = [
    'for',
    'data-entityname',
    'data-formid',
    'data-viewid',
    'data-listid',
    'data-fieldname',
    'data-field',
    'data-attribute',
  ];
  const shapeSelector = '[id],[class],' + attributes.map((name) => '[' + name + ']').join(',');
  const elements = [],
    pending = [...document.children].reverse();
  const visited = new WeakSet();
  // Resolve the active component before unrelated controls consume the bounded scan.
  try {
    const selected = document.getElementById('paqvilo-xray')?.__px?.selectedNode?.();
    if (selected?.isConnected && selected.ownerDocument.defaultView.location.origin === location.origin) {
      let boundary = selected;
      while (boundary?.ownerDocument === selected.ownerDocument) {
        if (
          boundary.matches?.(
            '[data-formid],[data-form-layout],[data-viewid],[data-selected-view],[data-listid],table[data-paqvilo-table],table[data-paqvilo-grid],[id^=EntityFormControl],[id^=WebFormControl]',
          )
        )
          break;
        boundary = boundary.assignedSlot ?? boundary.parentElement ?? boundary.getRootNode?.()?.host;
      }
      pending.push(boundary ?? selected.ownerDocument.documentElement);
      if (boundary?.matches('table[data-paqvilo-grid]')) {
        const id = boundary.getAttribute('data-paqvilo-grid'); // NOSONAR: reads attributes of observed DOM, dataset would differ
        const targets = id ? [...boundary.getRootNode().querySelectorAll('#' + CSS.escape(id))] : [];
        if (targets.length === 1 && targets[0].matches('table[data-paqvilo-table]') && own(targets[0]))
          pending.push(targets[0]);
      }
    }
  } catch {
    /* An inaccessible or changing selection cannot widen the scan. */
  }
  let scanned = 0,
    traversalTruncated = false,
    assetsTruncated = false,
    shapeOverflow = false;
  // Visit each light/open-shadow element once; slots' assigned light children
  // are already in the light tree. Never enter the inspector's own shadow roots.
  while (pending.length && scanned < 8000) {
    const node = pending.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    if (!own(node)) continue;
    scanned++;
    if (node.matches(shapeSelector)) {
      if (elements.length < 2000) elements.push(node);
      else shapeOverflow = true;
    }
    if (node.matches('script[src],link[href],img[src]')) {
      const raw = node.getAttribute('src') ?? node.getAttribute('href');
      try {
        const url = new URL(raw, node.ownerDocument.baseURI);
        if (url.origin !== location.origin) {
          /* Another site's file is not a source of this portal. */
        } else if (assets.length < 300) assets.push({ kind: node.localName, path: url.pathname });
        else assetsTruncated = true;
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    }
    if (node.matches(controlSelector)) {
      controlsSeen++;
      if (controls.length < 300) {
        const control = addControl(node);
        if (!control.formId) {
          const context = definitionContext(node.ownerDocument.URL);
          if (context.conflict) control.definitionConflict = true;
          if (context.aliasCandidates) control.definitionAliasCandidates = context.aliasCandidates;
          control.formId = String(context.formId ?? '').slice(0, 160);
          control.entity ||= String(context.entity ?? '').slice(0, 160);
        }
        controls.push(control);
      }
    }
    if (node.localName === 'iframe')
      try {
        const inner = node.contentDocument;
        if (inner?.documentElement) pending.push(inner.documentElement);
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    for (const children of [node.shadowRoot?.children ?? [], node.children]) {
      const count = Math.min(children.length, 8000 - scanned - pending.length);
      if (count < children.length) traversalTruncated = true;
      for (let index = count - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
  const shapeTruncated = shapeOverflow || traversalTruncated || pending.length > 0;
  const ids = elements
    .filter((node) => node.hasAttribute('id'))
    .map((node) => node.id)
    // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
    .filter((id) => id.length <= 160 && !/[\s?=&/{}%\x00-\x08\x0e-\x1f\x7f]/.test(id));
  const tokens = new Set();
  let tokenTruncated = false;
  const addToken = (token) => {
    if (tokens.size >= 8000 && !tokens.has(token)) {
      tokenTruncated = true;
      return false;
    }
    tokens.add(token);
    return true;
  };
  const idSet = new Set(ids);
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  const staticValue = (value) => value && value.length <= 160 && !/[{}%\x00-\x1f\x7f]/.test(value);
  shapeLoop: for (const node of elements.slice(0, 2000)) {
    if (idSet.has(node.id) && !addToken('id:' + node.id)) break;
    for (const name of node.classList)
      if (staticValue(name) && !addToken('class:' + node.localName + ':' + name)) break shapeLoop;
    for (const name of attributes) {
      const value = node.getAttribute(name);
      if (
        staticValue(value) &&
        /^[a-zA-Z0-9_{}-]+$/.test(value) &&
        !addToken('attribute:' + node.localName + ':' + name + ':' + value)
      )
        break shapeLoop;
    }
  }
  // Same-origin request paths only (never query values), so web files, server logic and cloud flows can be marked requested.
  const requestPaths = [
    ...new Set(
      performance
        .getEntriesByType('resource')
        .slice(-300)
        .map((entry) => pathname(entry.name))
        .filter((route) => route && route.length <= 512),
    ),
  ];
  // The multistep step the platform declares: the stepid key of the page address, and per multistep form control
  // (WebFormControl_<form id>) the position of the active progress indicator entry. No text or field value is read.
  let stepIds = [];
  try {
    stepIds = definitionQuery(new URL(location.href), { step: true })
      .filter(([key]) => key === 'stepid')
      .map(([, value]) => value.slice(0, 160))
      .slice(0, 4);
  } catch {
    /* An unreadable address declares no step. */
  }
  const multistep = [
    ...(typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[id^="WebFormControl_"]') : []),
  ]
    .filter((node) => /^WebFormControl_[0-9a-f]{32}$/i.test(node.id) && own(node))
    .slice(0, 10)
    .map((node) => {
      const indicator = document.getElementById(node.id + '_ProgressIndicator');
      const items = indicator ? [...indicator.querySelectorAll('li.list-group-item')] : [];
      let stepIndex = items.findIndex((item) => item.classList.contains('active'));
      if (stepIndex < 0 && indicator) {
        const number = indicator.querySelector('.number:not(.total)')?.textContent?.trim() ?? '';
        stepIndex = /^\d{1,3}$/.test(number) ? Number(number) - 1 : -1;
      }
      return { formControlId: node.id.slice('WebFormControl_'.length), stepIndex: stepIndex >= 0 ? stepIndex : null };
    });
  return {
    assets,
    controls,
    apiSets,
    ...(serverLogicPaths.length ? { serverLogicPaths } : {}),
    ...(requestPaths.length ? { requestPaths } : {}),
    ...(stepIds.length ? { stepIds } : {}),
    ...(multistep.length ? { multistep } : {}),
    ids,
    markupTokens: [...tokens],
    truncated: controlsSeen > 300 || shapeTruncated || tokenTruncated,
    ...(assetsTruncated ? { assetsTruncated } : {}),
  };
}

const pageSources = (portal, page) => {
  const record = page?.metadata;
  if (!record?._file) return [];
  const component = /powerpagecomponent\.xml$/i.test(record._file);
  return [
    { name: 'Page metadata', fieldPath: null, sourceFile: record._file },
    ...[
      ['Page copy', 'copy', 'copy.html'],
      ['Page JavaScript', 'customjavascript', 'custom_javascript.js'],
      ['Page CSS', 'customcss', 'custom_css.css'],
      ['Page summary', 'summary', 'summary.html'],
    ].map(([name, fieldPath, suffix]) => ({
      name,
      fieldPath,
      sourceFile: component ? record._file : record._file.replace(/\.ya?ml$/i, `.${suffix}`),
    })),
  ];
};

// A server logic is referenced by its call route or its Liquid tag. The name must end at a word boundary
// (route) or at its closing quote (tag), so a longer name that starts with it is a different logic.
function serverLogicEvidence(name, { body, observedRoutes }) {
  if (!name) return null;
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const route = new RegExp(String.raw`/_api/serverlogics/${escaped}(?!\w)`, 'i');
  if (route.test(observedRoutes)) return 'observed-request';
  const tag = new RegExp(String.raw`\{%-?\s*serverlogic\s+name\s*:\s*['"]${escaped}['"]`, 'i');
  return route.test(body) || tag.test(body) ? 'static-reference' : null;
}

function serverLogicReferences(serverLogics, context) {
  return serverLogics.flatMap((row) => {
    const evidence = serverLogicEvidence(row.name, context);
    return evidence ? [{ ...row, sourceFile: row.file, kind: 'server-logic', evidence }] : [];
  });
}

/** Follow only exported native component bindings, with provenance for conditional/modal sources. */
function addConfiguredListActionForms(actions, list, addForm) {
  for (const action of actions)
    if (
      action.EntityFormId &&
      (action.TargetType == null || action.TargetType === '' || Number(action.TargetType) === 0)
    )
      addForm(action.EntityFormId, `${list.name} ${action.Type ?? 'action'}`, 'configured-list-modal-form');
}

function inspectConfiguredListForms(report, portal, addForm) {
  for (const component of report.components ?? []) {
    if (component.kind !== 'list') continue;
    const list = portal.lists.find((row) => norm(row.id) === norm(component.recordId ?? component.id));
    let settings;
    try {
      settings = JSON.parse(portalField(list?.metadata, 'settings', '{}'));
    } catch {
      continue;
    }
    addConfiguredListActionForms(settings?.ViewActions ?? [], list, addForm);
    addConfiguredListActionForms(settings?.ItemActions ?? [], list, addForm);
  }
}

function inspectRenderedViews(rendered, addView) {
  for (const observed of rendered.controls ?? [])
    if (observed.viewId)
      addView(
        observed.viewId,
        observed.entity || null,
        observed.gridId || observed.id || 'Rendered native grid',
        'rendered-view-id',
      );
}

function addNativeCodeBinding(report, current, form, field, component, { definition, rendered, portal }) {
  const owner = `${form.name}.${field.name ?? field.id}`;
  if (
    report.nativeCodeBindings.some(
      (row) => row.owner === owner && row.name === component.name && row.formFactor === component.formFactor,
    )
  )
    return;
  const settings = portal.records.filter(
    (record) =>
      ['basicformmetadata', 'advancedformmetadata'].includes(record.kind) &&
      Number(portalField(record, 'statecode', 0)) !== 1 &&
      Number(portalField(record, 'type')) === 100000000 &&
      portalField(record, 'attributelogicalname') === field.name &&
      (current.stepId
        ? norm(portalField(record, 'webformstep')) === norm(current.stepId)
        : norm(portalField(record, 'entityform')) === norm(definition?.id)),
  );
  const style = settings.length === 1 ? Number(portalField(settings[0], 'controlstyle')) : null;
  const observed = (rendered.controls ?? []).some(
    (row) => norm(row.schemaName) === norm(component.name) && (!row.nativeField || row.nativeField === field.name),
  );
  let enablement = 'not-enabled';
  if (settings.length > 1) enablement = 'ambiguous';
  else if (style === 756150001) enablement = 'configured';
  report.nativeCodeBindings.push({
    ...component,
    owner,
    entity: current.entity,
    field: field.name ?? null,
    formId: form.id,
    formSourceFile: component.sourceFile ?? current.sourceFile,
    selectedDesktop: field.codeComponent === component,
    enablement,
    metadataSources: settings.map((record) => ({ name: 'Code component settings', sourceFile: record._file })),
    evidence: observed ? 'rendered-and-form-source' : 'form-source',
  });
}

function inspectFormCodeBindings(current, cells, context) {
  const { report, form, definition, rendered, portal } = context;
  for (const field of [...(current.fields ?? []), ...cells])
    for (const component of field.codeComponents ?? [])
      addNativeCodeBinding(report, current, form, field, component, { definition, rendered, portal });
}

function appendSubgridSettingsActions(settings, component, owner, record, addForm, portal) {
  for (const action of [
    ...(Array.isArray(settings?.ViewActions) ? settings.ViewActions : []),
    ...(Array.isArray(settings?.ItemActions) ? settings.ItemActions : []),
  ]) {
    if (!action || typeof action !== 'object') continue;
    if (component.relations.length < RELATION_LIMIT)
      component.relations.push(
        ...actionRelations(action, owner, portal)
          .map((row) => ({ ...row, metadataSource: record._file ?? null }))
          .slice(0, RELATION_LIMIT - component.relations.length),
      );
    if (
      !['CrmEntityFormView-CreateAction', 'CrmEntityFormView-EditAction', 'CrmEntityFormView-DetailsAction'].includes(
        action.Type,
      )
    )
      continue;
    const modal = action.EntityFormId && actionTargetType(action) === 0;
    const formSource = modal
      ? addForm(
          action.EntityFormId,
          `${owner} ${action.Type.replace('CrmEntityFormView-', '')}`,
          'configured-modal-form',
        )
      : null;
    component.actions.push({
      name: action.Type.replace('CrmEntityFormView-', ''),
      formName: formSource?.name ?? null,
      formId: modal ? norm(action.EntityFormId) : null,
      sourceFile: formSource?.sourceFile ?? record._file,
      conditional: Boolean(action.FilterCriteria),
      targetType: action.TargetType ?? null,
      evidence: 'exported-action',
    });
  }
}

function processSubgridRecord(record, cell, component, owner, addForm, report, portal) {
  component.metadataSources.push({ name: 'Subgrid action settings', sourceFile: record._file });
  let settings;
  try {
    const value = portalField(record, 'subgrid_settings', '{}');
    settings = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    report.unresolved.push({
      kind: 'subgrid-settings',
      expression: cell.id,
      owner,
      reason: 'The subgrid settings JSON is invalid.',
    });
    return;
  }
  appendSubgridSettingsActions(settings, component, owner, record, addForm, portal);
}

function processSubgridActions(current, cell, component, owner, context) {
  const { report, definition, portal, addView, addForm } = context;
  addView(cell.viewId, cell.entity, owner, 'subgrid-view');
  const records = portal.records.filter(
    (row) =>
      ['basicformmetadata', 'advancedformmetadata'].includes(row.kind) &&
      Number(portalField(row, 'statecode', 0)) !== 1 &&
      portalField(row, 'subgrid_name') === cell.id &&
      (current.stepId
        ? norm(portalField(row, 'webformstep')) === norm(current.stepId)
        : norm(portalField(row, 'entityform')) === norm(definition?.id)),
  );
  if (records.length > 1)
    report.unresolved.push({
      kind: 'subgrid-settings',
      expression: cell.id,
      owner,
      reason: 'Several settings records configure this subgrid; which actions show is unclear.',
    });
  for (const record of records) processSubgridRecord(record, cell, component, owner, addForm, report, portal);
}

function processLookupCell(current, cell, context) {
  const { report, form, addEntity, addView } = context;
  const targets = Array.isArray(cell.targets)
    ? [...new Set(cell.targets.filter((name) => typeof name === 'string' && /^[a-z][a-z0-9_]*$/i.test(name)))]
        .map((name) => name.toLowerCase())
        .slice(0, 8)
    : [];
  if (cell.lookupViewId || targets.length)
    report.nativeComponents.push({
      kind: 'lookup',
      id: cell.id ?? cell.name,
      name: cell.label ?? cell.name,
      formId: form.id,
      owner: form.name + '.' + (cell.name ?? cell.id),
      sourceFile: current.sourceFile,
      viewId: cell.lookupViewId || null,
      // The tables the lookup column targets (Solution relationship metadata).
      targets,
      // FormXml names no DefaultViewId: the lookup dialog uses each target table's default lookup view, resolved
      // after every table is known (resolveDefaultLookupViews).
      ...(cell.lookupViewId ? {} : { viewSource: 'table-default' }),
    });
  if (cell.lookupViewId)
    addView(cell.lookupViewId, cell.lookupView?.entity, `${form.name}.${cell.id} lookup`, 'lookup-view');
  for (const target of cell.lookupViewId ? [] : targets) addEntity(target, 'lookup-target');
}

function processNativeFormCell(current, cell, depth, context) {
  const { report, form, rendered, addEntity } = context;
  if (!['subgrid', 'quickform', 'notes'].includes(cell.type)) {
    processLookupCell(current, cell, context);
    return;
  }
  const owner = `${form.name}.${cell.id}`;
  const observed = (rendered.controls ?? []).some((row) => row.gridId === cell.id || row.controlId === cell.id);
  const component = {
    formId: form.id,
    kind: cell.type,
    id: cell.id,
    name: cell.label ?? cell.id,
    entity: cell.entity ?? (cell.type === 'notes' ? 'annotation' : null),
    relationship: cell.relationship ?? null,
    lookup: cell.lookup ?? null,
    owner,
    sourceFile: current.sourceFile,
    evidence: observed ? 'rendered-control-id' : 'form-source',
    viewId: cell.viewId ?? null,
    hidden: Boolean(cell.hidden),
    actions: [],
    relations: [],
    metadataSources: [],
  };
  report.nativeComponents.push(component);
  addEntity(component.entity);
  if (cell.type === 'quickform') {
    if (cell.schema) {
      component.ownerFormXmlId = current.formId;
      component.targetFormId = cell.schema.formId;
      component.formName = cell.schema.formName;
      component.sourceFile = cell.schema.sourceFile;
      walkFormSchema(cell.schema, depth + 1, context);
    } else
      report.unresolved.push({
        kind: 'quick-form',
        expression: cell.id,
        owner,
        reason: 'Quick view form not found in your Solution sources.',
      });
  }
  if (cell.type === 'subgrid') processSubgridActions(current, cell, component, owner, context);
}

function walkFormSchema(current, depth, context) {
  if (!current || depth > 5) return;
  context.addFields(current.entity, current.fields, context.form.evidence ?? 'form-source');
  for (const step of current.steps ?? []) walkFormSchema(step, depth + 1, context);
  const cells =
    current.layout?.flatMap((tab) =>
      tab.columns.flatMap((column) => column.sections.flatMap((section) => section.rows.flat())),
    ) ?? [];
  inspectFormCodeBindings(current, cells, context);
  for (const cell of cells) processNativeFormCell(current, cell, depth, context);
}

// A table row added during enrichment. Its metadata state, Webapi/<table>/* settings and unresolved entry are
// derived once every table is known (finalizeInspectionTables).
function addInspectionEntity(context, entity, evidence = 'form-dependency') {
  const { report, metadata } = context;
  if (!entity || report.tables.some((row) => row.logicalName === entity)) return;
  const table = metadata.entities?.[entity];
  report.tables.push({
    kind: 'table',
    name: entity,
    logicalName: entity,
    sourceFile: table?.sources?.[0],
    sourceFiles: table?.sources ?? [],
    fieldCount: Object.keys(table?.fields ?? {}).length,
    evidence,
  });
}

function addInspectionFields(context, entity, fields, evidence) {
  const { report, metadata } = context;
  addInspectionEntity(context, entity);
  for (const item of fields ?? []) {
    if (!item.name || report.columns.some((row) => row.entity === entity && row.name === item.name)) continue;
    const field = metadata.entities?.[entity]?.fields?.[item.name];
    report.columns.push({
      entity,
      name: item.name,
      sourceFile: field?.source ?? metadata.entities?.[entity]?.sources?.[0],
      resolved: Boolean(field),
      label: field?.label ?? item.label,
      type: field?.dataverseType ?? field?.type ?? item.type,
      required: Boolean(field?.required),
      evidence,
    });
  }
}

function addInspectionView(context, reference, entity, owner, evidence) {
  const { report, metadata } = context;
  if (!reference) return null;
  const view = metadata.views?.find((row) => norm(row.id) === norm(reference) && (!entity || row.entity === entity));
  if (!view) {
    report.unresolved.push({
      kind: 'view',
      expression: reference,
      owner,
      reason: 'The form uses a view that is not in your Solution sources.',
    });
    return null;
  }
  let item = report.views.find((row) => norm(row.id) === norm(view.id));
  if (!item) {
    item = {
      id: view.id,
      name: view.name,
      entity: view.entity,
      sourceFile: view.file,
      fields: view.fields ?? [],
      evidence,
    };
    report.views.push(item);
  }
  if (evidence === 'rendered-view-id') item.evidence = evidence;
  item.usedBy ??= [];
  item.usedBy.push(owner);
  addInspectionFields(context, view.entity, view.fields, evidence);
  return view;
}

function addInspectionForm(context, reference, owner, evidence) {
  const { report, portal, metadata, queue } = context;
  const definition = portal.forms.find((row) => norm(row.id) === norm(reference));
  if (!definition) {
    report.unresolved.push({
      kind: 'modal-form',
      expression: reference,
      owner,
      reason: 'The action opens a basic form that is not in your portal sources.',
    });
    return null;
  }
  let item = report.forms.find((row) => norm(row.id) === norm(definition.id));
  if (!item) {
    const schema = componentSchema(metadata, definition.id);
    item = {
      id: definition.id,
      name: definition.name,
      kind: 'basic-form',
      entity: definition.entityName,
      formName: definition.formName,
      mode: definition.mode,
      sourceFile: definition.metadata?._file,
      formXml: schema?.sourceFile ? { id: schema.formId, name: schema.formName, sourceFile: schema.sourceFile } : null,
      evidence,
    };
    report.forms.push(item);
    queue.push(item);
  }
  item.usedBy ??= [];
  item.usedBy.push(owner);
  return item;
}

function inspectFormDependencies(report, portal, metadata, rendered) {
  const queue = [...(report.forms ?? [])];
  const visited = new Set();
  report.nativeComponents = [];
  report.nativeCodeBindings = [];
  const context = { report, portal, metadata, rendered, queue };
  context.addEntity = (entity, evidence) => addInspectionEntity(context, entity, evidence);
  context.addFields = (entity, fields, evidence) => addInspectionFields(context, entity, fields, evidence);
  context.addView = (reference, entity, owner, evidence) =>
    addInspectionView(context, reference, entity, owner, evidence);
  context.addForm = (reference, owner, evidence) => addInspectionForm(context, reference, owner, evidence);
  inspectConfiguredListForms(report, portal, context.addForm);
  inspectRenderedViews(rendered, context.addView);
  for (let index = 0; index < queue.length && index < 80; index++) {
    const form = queue[index];
    if (visited.has(norm(form.id))) continue;
    visited.add(norm(form.id));
    const definition = [...portal.forms, ...(portal.advancedForms ?? [])].find((row) => norm(row.id) === norm(form.id));
    const schema = componentSchema(metadata, form.id);
    if (!schema) continue;
    const walkContext = { ...context, form, definition };
    walkFormSchema(schema, 0, walkContext);
  }
}

function componentLiteral(text) {
  const value = /^\s*(?:'([^']+)'|"([^"]+)"|([^\s,]+))/.exec(text);
  const name = value?.[1] ?? value?.[2] ?? value?.[3] ?? '';
  return {
    name,
    dynamic:
      !value || Boolean(value[3] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)),
  };
}

function appendCodeDatasetReport(report, entity, view, table, item) {
  if (!report.tables.some((entry) => entry.logicalName === entity))
    report.tables.push({
      kind: 'table',
      name: entity,
      logicalName: entity,
      sourceFile: table.sources?.[0],
      sourceFiles: table.sources ?? [],
      fieldCount: Object.keys(table.fields ?? {}).length,
      evidence: 'code-component-dataset',
    });
  if (view && !report.views.some((entry) => norm(entry.id) === norm(view.id)))
    report.views.push({
      id: view.id,
      name: view.name,
      entity,
      sourceFile: view.file,
      fields: view.fields,
      evidence: 'code-component-dataset',
    });
  for (const field of item.fields)
    if (field.name && !report.columns.some((entry) => entry.entity === entity && entry.name === field.name)) {
      const definition = table.fields?.[field.name];
      report.columns.push({
        entity,
        name: field.name,
        sourceFile: definition?.source ?? table.sources?.[0],
        resolved: Boolean(definition),
        label: definition?.label,
        type: definition?.dataverseType ?? definition?.type,
        evidence: 'code-component-dataset',
      });
    }
}

function inspectMarkupDataset(match, dataset, schemaName, row, report, metadata) {
  const escapedName = dataset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // NOSONAR: escaping is intentional
  const argument = new RegExp(String.raw`\b${escapedName}\s*:\s*`, 'i').exec(match[1]);
  const binding = componentLiteral(argument ? match[1].slice(argument.index + argument[0].length) : '');
  const item = {
    name: dataset.name,
    binding: binding.name,
    evidence: binding.dynamic ? 'dynamic-reference' : 'static-reference',
    resolved: false,
  };
  row.datasets.push(item);
  if (binding.dynamic) {
    report.unresolved.push({
      kind: 'code-component-dataset',
      expression: binding.name || dataset.name,
      owner: schemaName,
      reason: 'The dataset has no fixed table or view.',
    });
    return item;
  }
  const views = (metadata.views ?? []).filter(
    (view) => norm(view.id) === norm(binding.name) || norm(view.name) === norm(binding.name),
  );
  const view = views.length === 1 ? views[0] : null;
  const entity = view?.entity ?? (views.length ? null : norm(binding.name));
  const table = entity && metadata.entities?.[entity];
  if (!table) {
    report.unresolved.push({
      kind: 'code-component-dataset',
      expression: binding.name,
      owner: schemaName,
      reason:
        views.length > 1
          ? 'Multiple exported views match this name; use the exact view ID.'
          : 'Dataset table or view not found in your Solution sources.',
    });
    return item;
  }
  Object.assign(item, {
    resolved: true,
    entity,
    viewId: view?.id ?? null,
    viewName: view?.name ?? null,
    sourceFile: view?.file ?? table.sources?.[0],
    fields: view?.fields?.length ? view.fields : Object.keys(table.fields ?? {}).map((name) => ({ name })),
  });
  appendCodeDatasetReport(report, entity, view, table, item);
  return item;
}

function inspectMarkupCodeReference(match, context) {
  const { report, metadata, observed, catalogue } = context;
  const nameParameter = /\bname\s*:\s*/i.exec(match[1]);
  const { name, dynamic } = componentLiteral(
    nameParameter ? match[1].slice(nameParameter.index + nameParameter[0].length) : '',
  );
  const direct = !dynamic && [...(catalogue?.controls.keys() ?? [])].find((key) => norm(key) === norm(name));
  const schemaName = dynamic ? null : (direct ?? observed?.codeComponents?.[norm(name)] ?? null);
  let bindingKind = 'unknown';
  if (direct) bindingKind = 'declared-schema-name';
  else if (schemaName) bindingKind = 'observed-component-mapping';
  const row = {
    name,
    dynamic,
    schemaName,
    expression: match[0],
    evidence: dynamic ? 'dynamic-reference' : 'static-reference',
    binding: bindingKind,
  };
  const control = catalogue?.controls.get(schemaName);
  if (!control) {
    let reason = 'No code component in your Solution sources matches this name.';
    if (dynamic) reason = 'The code component name is set at run time, so it cannot be matched to a file.';
    else if (schemaName) reason = 'Code component manifest not found in your Solution sources.';
    report.unresolved.push({ kind: 'code-component', expression: row.expression, reason });
    return row;
  }
  Object.assign(row, {
    sourceFile: control.file,
    resources: control.resources.map((resource) => ({
      name: resource.kind,
      url: resource.url,
      sourceFile: catalogue.assets.get(resource.url)?.file,
    })),
    properties: control.properties,
    datasets: [],
  });
  for (const dataset of control.datasets ?? []) inspectMarkupDataset(match, dataset, schemaName, row, report, metadata);
  return row;
}

function appendNativeDatasetBinding(name, parameter, binding, row, report, metadata) {
  const view =
    parameter.viewId &&
    metadata.views?.find(
      (item) => norm(item.id) === norm(parameter.viewId) && (!parameter.entity || item.entity === parameter.entity),
    );
  if (!view) {
    report.unresolved.push({
      kind: 'native-code-component-dataset',
      expression: parameter.viewId ?? name,
      owner: binding.owner,
      reason: 'The dataset view is missing or bound to another table in your Solution sources.',
    });
    return;
  }
  row.datasets ??= [];
  row.datasets.push({
    name,
    binding: parameter.viewId,
    entity: view.entity,
    viewId: view.id,
    viewName: view.name,
    sourceFile: view.file,
    fields: view.fields,
    resolved: true,
    evidence: 'form-source',
  });
  if (!report.views.some((item) => norm(item.id) === norm(view.id)))
    report.views.push({
      id: view.id,
      name: view.name,
      entity: view.entity,
      sourceFile: view.file,
      fields: view.fields,
      evidence: 'native-code-component-dataset',
    });
  const table = metadata.entities?.[view.entity];
  if (!report.tables.some((item) => item.logicalName === view.entity))
    report.tables.push({
      kind: 'table',
      name: view.entity,
      logicalName: view.entity,
      sourceFile: table?.sources?.[0],
      sourceFiles: table?.sources ?? [],
      evidence: 'native-code-component-dataset',
    });
  for (const column of view.fields ?? [])
    if (column.name && !report.columns.some((item) => item.entity === view.entity && item.name === column.name)) {
      const field = table?.fields?.[column.name];
      report.columns.push({
        entity: view.entity,
        name: column.name,
        sourceFile: field?.source ?? table?.sources?.[0],
        resolved: Boolean(field),
        label: field?.label,
        type: field?.dataverseType ?? field?.type,
        evidence: 'native-code-component-dataset',
      });
    }
}

function inspectNativeBindingParameter(name, parameter, binding, row, report, metadata) {
  if (parameter.kind === 'unresolved')
    report.unresolved.push({
      kind: 'native-code-component-property',
      expression: name,
      owner: binding.owner,
      reason: parameter.reason ?? 'This property binding could not be matched to a column.',
    });
  if (parameter.kind === 'binding') {
    const table = metadata.entities?.[binding.entity],
      field = table?.fields?.[parameter.column];
    if (!report.columns.some((item) => item.entity === binding.entity && item.name === parameter.column))
      report.columns.push({
        entity: binding.entity,
        name: parameter.column,
        sourceFile: field?.source ?? table?.sources?.[0],
        resolved: Boolean(field),
        label: field?.label,
        type: field?.dataverseType ?? field?.type,
        evidence: 'native-code-component-binding',
      });
  }
  if (parameter.kind === 'dataset') appendNativeDatasetBinding(name, parameter, binding, row, report, metadata);
}

function inspectNativeCodeBinding(binding, context) {
  const { report, metadata, observed, catalogue } = context;
  const schemaName =
    [...(catalogue?.controls.keys() ?? [])].find((key) => norm(key) === norm(binding.name)) ??
    observed?.codeComponents?.[norm(binding.name)] ??
    null;
  const control = catalogue?.controls.get(schemaName);
  const row = {
    ...binding,
    schemaName,
    expression: `${binding.owner} · FormXml factor ${binding.formFactor ?? 'unknown'}`,
    binding: 'native-formxml',
    properties: control?.properties ?? [],
    sourceFile: control?.file ?? binding.formSourceFile,
    formSource: { name: binding.owner, sourceFile: binding.formSourceFile },
    resources:
      control?.resources.map((resource) => ({
        name: resource.kind,
        url: resource.url,
        sourceFile: catalogue.assets.get(resource.url)?.file,
      })) ?? [],
  };
  report.codeComponents.push(row);
  if (!control)
    report.unresolved.push({
      kind: 'native-code-component',
      expression: binding.name,
      owner: binding.owner,
      reason: 'Custom control manifest not found in your Solution sources.',
    });
  if (binding.enablement === 'ambiguous')
    report.unresolved.push({
      kind: 'native-code-component-settings',
      expression: binding.field,
      owner: binding.owner,
      reason: 'Several column settings configure this control; it is unclear whether the portal enables it.',
    });
  for (const [name, parameter] of Object.entries(binding.parameters ?? []))
    inspectNativeBindingParameter(name, parameter, binding, row, report, metadata);
}

const LIQUID_TAG_LENGTH = 8192;
/**
 * Liquid tags of one name, each scanned to its closing `%}` outside quoted strings, so an argument such as
 * width:'50%' does not end the tag. A quote left open within the length bound falls back to the first `%}`.
 * Returns regex-like matches: [0] the tag, [1] its arguments. Local scanner until mirage/lib/liquid-source.mjs
 * exports the shared quote-aware one.
 */
/** Where the tag whose opener ends at `start` closes (`%}` outside quotes), or the first `%}`; -1 when none. */
function liquidTagEnd(text, start) {
  const bound = Math.min(text.length, start + LIQUID_TAG_LENGTH);
  let quote = null;
  for (let index = start; index < bound - 1; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '%' && text[index + 1] === '}') return index;
  }
  return text.indexOf('%}', start);
}

function liquidTags(text, name, limit = 500) {
  const rows = [];
  const opener = new RegExp(String.raw`\{%-?\s*${name}\b`, 'gi');
  for (let match = opener.exec(text); match && rows.length < limit; match = opener.exec(text)) {
    const start = opener.lastIndex;
    const close = liquidTagEnd(text, start);
    if (close < 0) break;
    rows.push(Object.assign([text.slice(match.index, close + 2), text.slice(start, close)], { index: match.index }));
    opener.lastIndex = close + 2;
  }
  return rows;
}

function inspectCodeComponents(report, body, metadata, observed, catalogue) {
  const context = { report, metadata, observed, catalogue };
  report.codeComponents = unique(
    liquidTags(body, 'codecomponent').map((match) => inspectMarkupCodeReference(match, context)),
    (row) => row.expression,
  );
  for (const binding of report.nativeCodeBindings ?? []) inspectNativeCodeBinding(binding, context);
}

const PCF_ASSET_KINDS = { code: 'script', css: 'stylesheet' };
function pcfAssetRow(catalogue, control, resource, url, evidence) {
  return {
    name: `${control.schemaName}/${resource.path}`,
    url,
    kind: PCF_ASSET_KINDS[resource.kind] ?? resource.kind,
    mimeType: null,
    sourceFile: catalogue.assets.get(resource.url)?.file,
    evidence,
    componentKey: 'pcf:' + control.schemaName.toLowerCase(),
    schemaName: control.schemaName,
    resourceKind: resource.kind,
    resourcePath: resource.path,
    manifestFile: control.file,
  };
}

function pcfControlNamed(catalogue, name) {
  return typeof name === 'string'
    ? [...(catalogue?.controls?.values() ?? [])].find((item) => item.schemaName.toLowerCase() === name.toLowerCase())
    : null;
}

function pcfUnresolvedRow(item) {
  return {
    kind: 'pcf-resource',
    expression: item.url,
    owner: typeof item.control === 'string' ? item.control : undefined,
    reason: PCF_REFUSALS[item.refused] ?? PCF_REFUSALS['pcf-control-not-in-sources'],
  };
}

/**
 * The code component resources the page loads, as asset rows X-ray matches its `<script src>` and `<link href>`
 * elements to. On a live portal, `rendered.pcfResources` names the `/_pcfwebresource/<guid>` addresses the session
 * joined from the page's declarations (lense/pcf-resources.mjs); each is joined again here to this catalogue, so only a
 * manifest-declared file of the named control is reported. In front of Mirage, the resources of the page's code
 * components are its own `/__sim-static/pcf/` addresses.
 */
function appendCodeComponentAssets(report, rendered, catalogue, live) {
  report.assets ??= [];
  const known = new Set(report.assets.map((row) => String(row.url).toLowerCase()));
  const requested = new Set(
    [...(rendered.requestPaths ?? []).slice(0, REQUEST_PATH_LIMIT), ...(rendered.assets ?? []).map((row) => row.path)]
      .filter((value) => typeof value === 'string')
      .map((value) => value.split(/[?#]/)[0].toLowerCase()),
  );
  const add = (row) => {
    const key = row.url.toLowerCase();
    if (known.has(key) || report.assets.length >= 1000) return;
    known.add(key);
    report.assets.push({ ...row, ...(requested.has(key) ? { observed: 'requested' } : {}) });
  };
  for (const item of (rendered.pcfResources ?? []).slice(0, 500)) {
    if (!item || typeof item.url !== 'string' || !PCF_RESOURCE_PATH.test(item.url)) continue;
    const control = pcfControlNamed(catalogue, item.control);
    const resource =
      !item.refused && control?.resources.find((entry) => entry.kind === item.kind && entry.path === item.path);
    if (!resource || !catalogue.assets.get(resource.url)?.file) {
      report.unresolved.push(pcfUnresolvedRow(item));
      continue;
    }
    add(pcfAssetRow(catalogue, control, resource, item.url, 'pcf-declaration'));
  }
  if (live) return;
  for (const component of report.codeComponents ?? []) {
    const control = pcfControlNamed(catalogue, component.schemaName);
    for (const resource of control?.resources ?? [])
      if (resource.url && catalogue.assets.get(resource.url)?.file)
        add(pcfAssetRow(catalogue, control, resource, resource.url, 'code-component'));
  }
}

const activeRecord = (record) => Number(portalField(record, 'statecode', 0)) !== 1;
const stepRecordsOf = (portal, formId) =>
  (portal.records ?? []).filter(
    (record) =>
      record.kind === 'advancedformstep' &&
      activeRecord(record) &&
      norm(portalField(record, 'webform')) === norm(formId),
  );

/**
 * The stylesheets the platform layout links for the page (mirage/lib/liquid.mjs contentStylesheetFiles, the rule the
 * runtime renders with). Only pages whose template renders the site layout link them.
 */
function platformLinkedStylesheets(report, portal, page) {
  if (!page) return { files: [], snippet: null };
  const template = (portal.pageTemplates ?? []).find((row) => norm(row.id) === norm(page.pageTemplateId));
  if (template && pageTemplateKind(template) !== 'rewrite' && template.useHeaderFooter === false)
    return { files: [], snippet: null };
  const selected = contentStylesheetFiles(portal, page);
  const files = [selected.bootstrapFile, ...selected.content].filter((file) => file?.url).slice(0, 100);
  return { files, snippet: selected.bootstrapSnippet != null ? bootstrapSnippetRow(portal) : null };
}

function bootstrapSnippetRow(portal) {
  const record = effectiveSnippetRecords(
    portal.records ?? [],
    portal.selectedLanguageId ?? portalField(portal.website ?? {}, 'defaultlanguage'),
  ).resolve('Head/Bootstrap');
  return {
    kind: 'content-snippet',
    name: 'Head/Bootstrap',
    sourceFile: bodyFile(record, 'value.html') ?? record?._file ?? null,
    file: bodyFile(record, 'value.html') ?? record?._file ?? null,
    recordId: record?.id ?? null,
    fieldPath: 'value',
    usedBy: ['page-shell'],
    evidence: 'platform-linked-stylesheet',
  };
}

const WEB_API_REFERENCE_LIMIT = 200;
function scanWebApiBody(row, literal, dynamic) {
  const text = stripLiquidLiteralBlocks(row.text);
  for (const match of text.matchAll(/\/_api\/(\w*)(?:(['"])\s*\+|\$\{)?/g)) {
    const segment = match[1];
    // A string that ends right after the segment and is concatenated, or a template expression, builds the
    // address at run time: '/_api/' + set, '/_api/x_' + suffix, `/_api/${set}`. A complete set name followed by
    // concatenated keys ('/_api/x_items(' ...) is still literal; segment lets the caller tell the two apart.
    const built = match[0].length > segment.length + 6;
    if (built) {
      if (NON_TABLE_API_SEGMENTS.has(segment.toLowerCase()) || dynamic.length >= WEB_API_REFERENCE_LIMIT) continue;
      const expression = text
        .slice(Math.max(0, match.index - 40), match.index + match[0].length + 40)
        .replace(/\s+/g, ' ')
        .trim();
      if (!dynamic.some((item) => item.sourceFile === row.sourceFile && item.expression === expression))
        dynamic.push({ name: row.name, sourceFile: row.sourceFile ?? null, expression, segment });
    } else if (isEntitySetSegment(segment) && !literal.has(segment) && literal.size < WEB_API_REFERENCE_LIMIT)
      literal.set(segment, row.name);
  }
}

/**
 * Web API addresses in the scanned bodies: literal entity sets (name -> first body naming it) and addresses built at
 * run time ('/_api/' + name, `/_api/${name}`), each with the body that builds it.
 */
function webApiReferences(namedBodies) {
  const literal = new Map(),
    dynamic = [];
  for (const row of namedBodies) scanWebApiBody(row, literal, dynamic);
  return { literal, dynamic };
}

/**
 * The table an entity set names: loaded (metadata.entities), defined by the selected Solution sources but not loaded
 * (not-requested), matched only by a pluralized guess (pluralized-only), or absent from the sources.
 */
function entitySetTable(name, metadata) {
  const declared = ([, table]) => table.entitySet === name && table.entitySetSource !== 'pluralized';
  const loaded = Object.entries(metadata.entities ?? {}).find(declared);
  if (loaded) return { logicalName: loaded[0], state: 'loaded' };
  const listed = Object.entries(metadata.tableCatalog ?? {}).find(declared);
  if (listed) return { logicalName: listed[0], state: 'not-requested' };
  const guessed = Object.entries({ ...metadata.tableCatalog, ...metadata.entities }).find(
    ([, table]) => table.entitySet === name,
  );
  return { logicalName: null, state: guessed ? 'pluralized-only' : 'absent', guess: guessed?.[0] ?? null };
}

function entitySetReason(resolved, metadata) {
  if (!(metadata.roots ?? []).length) return 'No Solution sources are selected, so the entity set cannot be mapped.';
  if (resolved.state === 'pluralized-only')
    return `Only a pluralized guess of table ${resolved.guess} matches; the Solution sources declare no entity set name for it.`;
  if (resolved.state === 'not-requested')
    return 'The table is in the selected Solution sources but its definition was not loaded.';
  return 'No table in the selected Solution sources has this entity set name.';
}

function resolveDefaultLookupView(report, metadata, row, entity) {
  const candidates = (metadata.views ?? []).filter((view) => view.entity === entity && view.queryType === 64);
  const view = candidates.find((item) => item.isDefault) ?? (candidates.length === 1 ? candidates[0] : null);
  if (!view) {
    if (metadata.entities?.[entity]) {
      const reason =
        candidates.length > 1
          ? 'Several lookup views of this table are in the Solution sources and none is marked default.'
          : 'The lookup uses the default lookup view of this table; the Solution sources do not contain it.';
      report.unresolved.push({ kind: 'lookup-view', expression: entity, owner: row.owner, reason });
    }
    return;
  }
  row.defaultViews.push({ entity, viewId: view.id, name: view.name, sourceFile: view.file, tableDefault: true });
  let item = report.views.find((existing) => norm(existing.id) === norm(view.id));
  if (!item) {
    item = {
      id: view.id,
      name: view.name,
      entity: view.entity,
      sourceFile: view.file,
      fields: view.fields ?? [],
      evidence: 'lookup-default-view',
    };
    report.views.push(item);
  }
  item.usedBy ??= [];
  if (!item.usedBy.includes(`${row.owner} lookup`)) item.usedBy.push(`${row.owner} lookup`);
}

/**
 * A lookup without DefaultViewId opens the target table's default lookup view (savedquery querytype 64; the one
 * marked default when there are several). Each lookup row lists the view per target as `defaultViews`.
 */
function resolveDefaultLookupViews(report, metadata) {
  for (const row of report.nativeComponents ?? []) {
    if (row.kind !== 'lookup' || row.viewSource !== 'table-default') continue;
    row.defaultViews = [];
    for (const entity of row.targets ?? []) resolveDefaultLookupView(report, metadata, row, entity);
  }
}

function applyTableDefinition(table, definition) {
  table.sourceFile ??= definition.sources?.[0] ?? null;
  if (!table.sourceFiles?.length) table.sourceFiles = definition.sources ?? [];
  if (!table.fieldCount) table.fieldCount = Object.keys(definition.fields ?? {}).length;
  if (table.file === null) table.file = table.sourceFile;
  table.metadataState = 'loaded';
}

function markTableMetadata(report, metadata) {
  const loaded = new Set();
  for (const table of report.tables) {
    const definition = metadata.entities?.[table.logicalName];
    if (definition) {
      loaded.add(table.logicalName);
      applyTableDefinition(table, definition);
    } else
      table.metadataState = metadata.tableCatalog?.[table.logicalName] ? 'not-requested' : 'not-in-solution-sources';
  }
  return loaded;
}

function missingTableReason(table, metadata) {
  if (!(metadata.roots ?? []).length) return 'No Solution sources are selected, so the table has no definition.';
  return table.metadataState === 'not-requested'
    ? 'The table is in the selected Solution sources but its definition was not loaded.'
    : 'The table is not in the selected Solution sources.';
}

function reportMissingTables(report, metadata, loaded, tableRows) {
  report.unresolved = report.unresolved.filter(
    (row) => row.kind !== 'table' || !tableRows.has(row.expression) || !loaded.has(row.expression),
  );
  for (const table of report.tables) {
    if (loaded.has(table.logicalName)) continue;
    const existing = report.unresolved.find((row) => row.kind === 'table' && row.expression === table.logicalName);
    if (existing) {
      existing.reason = missingTableReason(table, metadata);
      existing.metadataState = table.metadataState;
    } else
      report.unresolved.push({
        kind: 'table',
        expression: table.logicalName,
        reason: missingTableReason(table, metadata),
        metadataState: table.metadataState,
      });
  }
}

function addWebApiTableSettings(report, portal, tableRows) {
  report.siteSettings ??= [];
  const secret = new Set(portal.secretSettingNames ?? []);
  const listed = new Set(report.siteSettings.map((row) => String(row.name).toLowerCase()));
  for (const record of portal.records ?? []) {
    if (record.kind !== 'sitesetting' || report.siteSettings.length >= 500) continue;
    const name = String(record.name ?? '');
    const table = /^webapi\/([^/]+)\//i.exec(name)?.[1]?.toLowerCase();
    if (!table || !tableRows.has(table) || listed.has(name.toLowerCase())) continue;
    listed.add(name.toLowerCase());
    const value = portal.settings?.[name];
    report.siteSettings.push({
      kind: 'site-setting',
      name,
      sourceFile: record._file ?? null,
      file: record._file ?? null,
      relativePath: record._file && portal.sourceDir ? path.relative(portal.sourceDir, record._file) : null,
      recordId: record.id ?? null,
      fieldPath: 'value',
      ...(secret.has(name)
        ? { value: '[secret]', secret: true }
        : { value: value == null ? null : String(value).slice(0, 400) }),
      evidence: 'web-api-table-setting',
    });
  }
}

/**
 * Once every table is known: each table's metadata state (loaded, not-requested: the selected sources define it but it
 * was not loaded, not-in-solution-sources), one unresolved entry per table without metadata, and the
 * Webapi/<table>/* site settings of every table, including tables found after the static report.
 */
function finalizeInspectionTables(report, portal, metadata) {
  const loaded = markTableMetadata(report, metadata);
  for (const column of report.columns)
    if (loaded.has(column.entity) && !column.sourceFile)
      column.sourceFile =
        metadata.entities[column.entity].fields?.[column.name]?.source ?? metadata.entities[column.entity].sources?.[0];
  const tableRows = new Map(report.tables.map((table) => [table.logicalName, table]));
  reportMissingTables(report, metadata, loaded, tableRows);
  addWebApiTableSettings(report, portal, tableRows);
}

/** The exported web role records that the page's permission rules and page access rules name, with their files. */
function webRoleSources(portal, report, provenance) {
  const users = new Map();
  const use = (roleId, owner) => {
    const key = norm(roleId);
    if (!key) return;
    if (!users.has(key)) users.set(key, new Set());
    if (users.get(key).size < 50) users.get(key).add(owner);
  };
  for (const rule of report.permissionRules ?? []) for (const roleId of rule.roleIds ?? []) use(roleId, rule.name);
  for (const rule of report.page?.access?.rules ?? []) for (const role of rule.roles ?? []) use(role.id, rule.name);
  const records = new Map(
    (portal.records ?? []).filter((record) => record.kind === 'webrole').map((record) => [norm(record.id), record]),
  );
  return [...users].slice(0, 200).map(([roleId, owners]) => {
    const record = records.get(roleId);
    // The role's record is a source of the shared index ($record, mirage/lib/portal-source-index.mjs): the row opens
    // that record where the index locates it.
    const ref = record ? provenance?.source(record, '$record') : null;
    return {
      kind: 'web-role',
      id: roleId,
      recordId: roleId,
      name: record?.name ?? null,
      sourceFile: ref?.file ?? record?._file ?? null,
      resolved: Boolean(record),
      active: record ? activeRecord(record) : null,
      usedBy: [...owners],
      ...(ref ? { ...hintIdentity(provenance, record, '$record', ref), componentKey: ref.componentKey } : {}),
    };
  });
}

// Solution metadata diagnostics about joining a form or list to its FormXml/view (solution-metadata.mjs).
const COMPONENT_DIAGNOSTICS = new Set([
  'SYSTEMFORM_UNRESOLVED',
  'SYSTEMFORM_NAME_AMBIGUOUS',
  'SYSTEMFORM_INELIGIBLE_TYPE',
  'SYSTEMFORM_TAB_FALLBACK',
  'SYSTEMFORM_MAPPING_ERROR',
  'SYSTEMVIEW_UNRESOLVED',
  'ADVANCEDFORM_UNRESOLVED',
  'ADVANCEDFORM_STEP_UNRESOLVED',
  'ADVANCEDFORM_STEP_MAPPING_ERROR',
  'ADVANCEDFORM_STEP_REFERENCE_UNRESOLVED',
  'ADVANCEDFORM_SHARED_STEP_REFERENCE',
  'SOLUTION_LAYER_VARIANTS',
]);

function diagnosticOwner(diagnostic, components, layouts) {
  if (diagnostic.code === 'SOLUTION_LAYER_VARIANTS') return layouts.get(norm(diagnostic.id));
  return (
    components.get(norm(diagnostic.id)) ??
    components.get(norm(diagnostic.form)) ??
    components.get(norm(diagnostic.from))
  );
}

function diagnosticComponentKind(diagnostic) {
  if (diagnostic.kind === 'view') return 'view';
  return diagnostic.kind === 'form' ? 'form-xml' : null;
}

/** The page's own forms, steps and lists by normalized id, with what a diagnostic about them names. */
function metadataComponents(report) {
  const components = new Map();
  const add = (id, row) => {
    if (id && !components.has(norm(id))) components.set(norm(id), row);
  };
  for (const form of report.forms ?? []) {
    add(form.id, { componentKind: form.kind ?? 'basic-form', name: form.name, sourceFile: form.sourceFile });
    for (const step of form.steps ?? [])
      add(step.id, { componentKind: 'advanced-form-step', name: step.name, sourceFile: step.sourceFile });
  }
  for (const component of report.components ?? [])
    if (component.kind === 'list')
      add(component.recordId ?? component.id, {
        componentKind: 'list',
        name: component.name,
        sourceFile: component.sourceFile,
      });
  return components;
}

/** The failed or ambiguous form/list joins of the page's own components, as unresolved rows with their identity. */
function componentMetadataDiagnostics(report, metadata) {
  const components = metadataComponents(report);
  const layouts = new Map();
  for (const form of report.forms ?? []) if (form.formXml?.id) layouts.set(norm(form.formXml.id), form);
  for (const view of report.views ?? []) if (view.id) layouts.set(norm(view.id), view);
  let added = 0;
  for (const diagnostic of metadata.diagnostics ?? []) {
    if (!COMPONENT_DIAGNOSTICS.has(diagnostic.code) || added >= 200) continue;
    const owner = diagnosticOwner(diagnostic, components, layouts);
    if (!owner) continue;
    added++;
    report.unresolved.push({
      kind: diagnostic.code === 'SOLUTION_LAYER_VARIANTS' ? 'solution-layer' : 'component-metadata',
      code: diagnostic.code,
      expression: owner.name ?? diagnostic.id,
      componentId: norm(diagnostic.id),
      componentKind: owner.componentKind ?? diagnosticComponentKind(diagnostic),
      sourceFile: diagnostic.selected ?? diagnostic.sourceFile ?? owner.sourceFile ?? null,
      reason: diagnostic.message ?? diagnostic.code,
      ...(Array.isArray(diagnostic.candidates) ? { candidates: diagnostic.candidates.slice(0, 10) } : {}),
    });
  }
}

// adx_type of basic-form and multistep-form metadata rows, as the runtime reads them (mirage/lib/platform.mjs:
// attribute, section, tab, subgrid, notes). Purchase (100000004) and timeline (100000006) follow the documented choice.
const FORM_METADATA_TYPES = {
  100000000: 'attribute',
  100000001: 'section',
  100000002: 'tab',
  100000003: 'subgrid',
  100000004: 'purchase',
  100000005: 'notes',
  100000006: 'timeline',
};
const FORM_METADATA_LIMIT = 200,
  // Forms whose records are scanned (the dependency walk follows at most 80 forms as well).
  COMPONENT_SCAN_LIMIT = 80;

const FORM_METADATA_TARGETS = {
  100000000: 'attributelogicalname',
  100000001: 'sectionname',
  100000002: 'tabname',
  100000003: 'subgrid_name',
};
// The field a row of this type configures, else the first target field the row carries.
const formMetadataTarget = (record, type) =>
  [FORM_METADATA_TARGETS[type], 'attributelogicalname', 'subgrid_name', 'sectionname', 'tabname']
    .filter(Boolean)
    .map((name) => portalField(record, name))
    .find((value) => value != null && value !== '') ?? null;

// Every active metadata row of a basic form (entityform) or a multistep step (webformstep), with its type and target.
function formMetadataRows(portal, ownerField, ownerId) {
  return (portal.records ?? [])
    .filter(
      (record) =>
        ['basicformmetadata', 'advancedformmetadata'].includes(record.kind) &&
        activeRecord(record) &&
        norm(portalField(record, ownerField)) === norm(ownerId),
    )
    .slice(0, FORM_METADATA_LIMIT)
    .map((record) => {
      const type = Number(portalField(record, 'type'));
      return {
        id: norm(record.id),
        type: FORM_METADATA_TYPES[type] ?? (Number.isFinite(type) ? `type-${type}` : 'unknown'),
        typeCode: Number.isFinite(type) ? type : null,
        target: formMetadataTarget(record, type),
        sourceFile: record._file ?? null,
      };
    });
}

// Where a basic form or a step sends the visitor after it succeeds: its redirect web page or URL.
function redirectRelations(record, owner, portal) {
  const relations = [];
  const page = pageRelation('redirect-page', portalField(record ?? {}, 'redirectwebpage'), owner, portal);
  if (page) relations.push(page);
  const url = portalField(record ?? {}, 'redirecturl');
  if (typeof url === 'string' && url) relations.push({ kind: 'redirect-url', url: url.slice(0, 2048), owner });
  return relations;
}

/** Target pages, redirects and metadata rows of every resolved form and step (lists carry theirs from bindings). */
function attachAdvancedFormRelations(form, portal) {
  form.relations = [];
  const steps = stepRecordsOf(portal, form.id);
  const rows = new Map(steps.map((step) => [norm(step.id), step]));
  form.steps ??= [];
  for (const step of form.steps) {
    const record = rows.get(norm(step.id));
    if (!record) continue;
    step.metadataRows = formMetadataRows(portal, 'webformstep', record.id);
    step.relations = redirectRelations(record, `${form.name} ${record.name ?? 'step'}`, portal);
    form.relations.push(...step.relations);
  }
}

function attachBasicFormRelations(form, definition, portal) {
  form.metadataRows = formMetadataRows(portal, 'entityform', definition.id);
  // On success 756150001 redirects; the redirect fields of any other outcome are not followed by the platform.
  const onSuccess = Number(portalField(definition.metadata ?? {}, 'onsuccess') ?? 756150000);
  form.relations = onSuccess === 756150001 ? redirectRelations(definition.metadata, form.name, portal) : [];
  form.onSuccess = onSuccess === 756150001 ? 'redirect' : 'message';
}

function reportUnresolvedTargetPages(report, relations, reason) {
  for (const relation of relations)
    if (relation.kind.endsWith('-page') && !relation.resolved)
      report.unresolved.push({ kind: 'target-page', expression: relation.pageId, owner: relation.owner, reason });
}

/** Target pages, redirects and metadata rows of every resolved form and step (lists carry theirs from bindings). */
function attachComponentRelations(report, portal) {
  for (const form of (report.forms ?? []).slice(0, COMPONENT_SCAN_LIMIT)) {
    const definition = [...(portal.forms ?? []), ...(portal.advancedForms ?? [])].find(
      (row) => norm(row.id) === norm(form.id),
    );
    if (!definition) continue;
    const advanced = definition.metadata?.kind === 'advancedform' || form.kind === 'advanced-form';
    if (advanced) attachAdvancedFormRelations(form, portal);
    else attachBasicFormRelations(form, definition, portal);
    reportUnresolvedTargetPages(
      report,
      form.relations,
      'The form redirects to a web page that is not in your portal sources.',
    );
  }
  for (const component of report.components ?? [])
    reportUnresolvedTargetPages(
      report,
      component.kind === 'list' ? (component.relations ?? []) : [],
      'The list action or setting opens a web page that is not in your portal sources.',
    );
}

/** The custom JavaScript of every resolved form, multistep step and list: it runs on the page too. */
function componentScriptBodies(report, portal) {
  const rows = [];
  const seen = new Set();
  const add = (text, name, record) => {
    const sourceFile = bodyFile(record, 'custom_javascript.js');
    const key = `${sourceFile}#${norm(record?.id)}`;
    if (typeof text !== 'string' || !text || seen.has(key) || rows.length >= 200) return;
    seen.add(key);
    rows.push({ text, name, sourceFile });
  };
  for (const form of (report.forms ?? []).slice(0, COMPONENT_SCAN_LIMIT)) {
    const definition = [...(portal.forms ?? []), ...(portal.advancedForms ?? [])].find(
      (row) => norm(row.id) === norm(form.id),
    );
    if (definition) add(definition.js, `${definition.name} JavaScript`, definition.metadata);
    for (const step of stepRecordsOf(portal, form.id))
      add(step.customJavascript, `${step.name ?? 'Step'} JavaScript`, step);
  }
  for (const component of report.components ?? []) {
    if (component.kind !== 'list') continue;
    const list = (portal.lists ?? []).find((row) => norm(row.id) === norm(component.recordId ?? component.id));
    if (list) add(list.js, `${list.name} JavaScript`, list.metadata);
  }
  return rows;
}

/** The step the progress indicator shows: the start step followed `stepIndex` next-step links (a condition ends it). */
function progressIndicatorStep(form, portal, byId, stepIndex) {
  const definition = (portal.advancedForms ?? []).find((row) => norm(row.id) === norm(form.id));
  let step = byId.get(norm(portalField(definition?.metadata ?? {}, 'startstep')));
  const visited = new Set();
  for (let index = 0; step && index < stepIndex && !visited.has(norm(step.id)); index++) {
    visited.add(norm(step.id));
    step =
      Number(portalField(step, 'type', 100000001)) === 100000000 ? null : byId.get(norm(portalField(step, 'nextstep')));
  }
  return step && Number(portalField(step, 'type', 100000001)) !== 100000000 ? step : null;
}

function markRenderedStep(form, portal, rendered, observedSteps) {
  const compact = norm(form.id).replaceAll('-', '');
  const observedForm = observedSteps.find((row) => norm(row.formControlId).replaceAll('-', '') === compact) ?? null;
  const steps = stepRecordsOf(portal, form.id);
  const byId = new Map(steps.map((step) => [norm(step.id), step]));
  const declared = [...new Set([...(observedForm?.stepIds ?? []), ...(rendered.stepIds ?? [])].map(norm))].filter(
    (id) => byId.has(id),
  );
  let current = null,
    evidence = null;
  if (declared.length === 1) {
    current = byId.get(declared[0]);
    evidence = 'page-address-stepid';
  } else if (!declared.length && Number.isSafeInteger(observedForm?.stepIndex) && observedForm.stepIndex >= 0) {
    // Follow the start step's next-step chain; a condition step makes the position ambiguous.
    const step = progressIndicatorStep(form, portal, byId, observedForm.stepIndex);
    if (step) {
      current = step;
      evidence = 'progress-indicator';
    }
  }
  form.currentStep = current
    ? { id: norm(current.id), name: current.name ?? null, evidence }
    : { state: 'unknown', ...(declared.length > 1 ? { reason: 'The page declares several steps.' } : {}) };
  for (const step of form.steps ?? []) if (current && norm(step.id) === norm(current.id)) step.current = true;
}

/**
 * The multistep step the page shows: the `stepid` the platform puts in the page address, else the active entry of
 * the progress indicator when the step chain to it is linear. Each advanced form row gets `currentStep`
 * ({ id, name, evidence } or { state: 'unknown' }) and its matching step `current: true`.
 */
function markRenderedSteps(report, portal, rendered) {
  const observedSteps = Array.isArray(rendered.multistep) ? rendered.multistep.slice(0, 10) : [];
  for (const form of (report.forms ?? []).slice(0, COMPONENT_SCAN_LIMIT))
    if (form.kind === 'advanced-form') markRenderedStep(form, portal, rendered, observedSteps);
}

/** Enrich a shared report with source provenance and observed DOM, never a live access verdict. */
/* NOSONAR: single-pass routine, splitting it would change shared state */ export async function enrichInspection(
  report,
  portal,
  {
    metadata = {},
    rendered = {},
    live = false,
    observed = null,
    codeCatalogue = null,
    sourceIndexStore = null,
    // async (logicalNames) => metadata with those Solution tables loaded too, or null; see createSourceInspector.
    loadTables = null,
  } = {},
) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new TypeError('Source inspection requires a page report object.');
  report.tables ??= [];
  report.columns ??= [];
  report.views ??= [];
  report.forms ??= [];
  report.unresolved ??= [];
  report.evidence = {
    mode: live ? 'live-sources' : 'local-runtime',
    rendered: 'Observed controls and same-origin asset paths. Field values and request query values are excluded.',
    identity: live
      ? 'Live web-role membership and effective record access are not available from the export.'
      : 'Local session and configured permission evaluation.',
    solutions: (metadata.roots ?? []).length,
  };
  const page = portal.pages.find((entry) => norm(entry.id) === norm(report.page?.id));
  // Build the shared source index with this catalogue first: the export index
  // and the caller's final snapshot then reuse it instead of building it twice.
  const provenance = provenanceIndex(portal, metadata, codeCatalogue);
  const whole = exportIndex(portal, metadata, sourceIndexStore);
  report.componentIndex = {
    forms: whole.forms.map((form) => ({ ...form, formXml: form.formXml ? { ...form.formXml } : null })),
    lists: whole.lists.map((list) => ({ ...list })),
  };
  rendered = {
    ...rendered,
    controls: (rendered.controls ?? []).map((control) => {
      if (!control.definitionConflict || !Array.isArray(control.definitionAliasCandidates)) return control;
      const matches = whole.forms.filter(
        (form) =>
          control.definitionAliasCandidates.length === 2 &&
          control.definitionAliasCandidates.every((id) =>
            [form.id, form.formXml?.id].some((candidate) => norm(candidate) === norm(id)),
          ) &&
          (!control.formId || [form.id, form.formXml?.id].some((id) => norm(id) === norm(control.formId))) &&
          (!control.entity || norm(form.entity) === norm(control.entity)),
      );
      return matches.length === 1 ? { ...control, definitionConflict: false, formId: matches[0].id } : control;
    }),
  };
  if (report.page && page) {
    report.page.entityFormId = page.formId ?? portalField(page.metadata ?? {}, 'entityform') ?? null;
    // The multistep form the page renders (adx_webform): the page-bound #WebFormControl wrapper carries no form ID.
    report.page.webFormId = page.advancedFormId ?? portalField(page.metadata ?? {}, 'webform') ?? null;
    report.page.listId = page.listId ?? portalField(page.metadata ?? {}, 'entitylist') ?? null;
  }
  report.pageSources = [];
  for (const source of pageSources(portal, page)) {
    try {
      if ((await fs.stat(source.sourceFile)).isFile()) report.pageSources.push(source);
    } catch {
      /* Optional inspection or cleanup failure must not interrupt the owning operation. */
    }
  }
  if (page?.metadata?._file) {
    const root = portal.records.find((record) => record.kind === 'webpage' && norm(record.id) === norm(page.id));
    if (root?._file && root._file !== page.metadata._file) {
      for (const source of report.pageSources) source.name = source.name.replace(/^Page /, 'Language page ');
      report.pageSources.unshift({ name: 'Root page metadata', sourceFile: root._file });
    }
  }
  // Runtime component IDs can resolve a dynamic Liquid reference without guessing its value.
  for (const control of rendered.controls ?? []) {
    if (control.definitionConflict) continue;
    const form = control.formId && portal.forms.find((row) => norm(row.id) === norm(control.formId));
    const existing = form && (report.forms ?? []).find((row) => norm(row.id) === norm(form.id));
    if (existing) existing.evidence = 'rendered-component-id';
    if (form && !(report.forms ?? []).some((row) => norm(row.id) === norm(form.id))) {
      const schema = componentSchema(metadata, form.id);
      report.forms ??= [];
      report.forms.push({
        id: form.id,
        name: form.name,
        kind: 'basic-form',
        entity: form.entityName,
        mode: form.mode,
        formName: form.formName,
        sourceFile: form.metadata?._file,
        formXml: schema?.sourceFile
          ? { id: schema.formId, name: schema.formName, sourceFile: schema.sourceFile }
          : null,
        evidence: 'rendered-component-id',
      });
      for (const field of schema?.fields ?? [])
        if (
          field.name &&
          !(report.columns ?? []).some((row) => row.entity === form.entityName && row.name === field.name)
        ) {
          report.columns ??= [];
          report.columns.push({
            entity: form.entityName,
            name: field.name,
            sourceFile: field.source ?? metadata.entities?.[form.entityName]?.sources?.[0],
            resolved: true,
            type: field.type,
            label: field.label,
          });
        }
    }
    const list =
      control.listId &&
      portal.lists.find((row) => norm(row.id).replaceAll('-', '') === norm(control.listId).replaceAll('-', ''));
    if (list && !(report.components ?? []).some((row) => norm(row.recordId) === norm(list.id))) {
      report.components ??= [];
      report.components.push({
        kind: 'list',
        recordId: list.id,
        name: list.name,
        entity: list.entityName,
        sourceFile: list.metadata?._file,
        evidence: 'rendered-component-id',
      });
    }
    const view = control.viewId && metadata.views?.find((row) => norm(row.id) === norm(control.viewId));
    if (view && !(report.views ?? []).some((row) => norm(row.id) === norm(view.id))) {
      report.views ??= [];
      report.views.push({
        id: view.id,
        name: view.name,
        entity: view.entity,
        sourceFile: view.file,
        fields: view.fields,
        evidence: 'rendered-component-id',
      });
    }
    for (const entity of [
      form?.entityName,
      list?.entityName,
      view?.entity,
      control.entity && metadata.entities?.[control.entity] ? control.entity : null,
    ].filter(Boolean)) {
      if (!(report.tables ?? []).some((row) => row.logicalName === entity)) {
        const table = metadata.entities?.[entity];
        report.tables ??= [];
        report.tables.push({
          kind: 'table',
          logicalName: entity,
          name: entity,
          sourceFile: table?.sources?.[0],
          sourceFiles: table?.sources ?? [],
          fieldCount: Object.keys(table?.fields ?? {}).length,
          evidence: 'rendered-component-id',
        });
      }
    }
  }
  for (const component of report.components ?? [])
    if (component.kind === 'list') {
      const definition = portal.lists.find((row) => norm(row.id) === norm(component.recordId ?? component.id));
      if (!definition) continue;
      if (component.sourceFile && component.sourceFile !== definition.metadata?._file)
        component.customization = { name: 'List custom JavaScript', sourceFile: component.sourceFile };
      component.sourceFile = definition.metadata?._file ?? component.sourceFile;
      component.fieldPath = null;
      Object.assign(component, listInspectionBindings(definition, portal));
      for (const viewId of component.viewIds) {
        const view = metadata.views?.find(
          (row) => norm(row.id) === norm(viewId) && (!component.entity || row.entity === component.entity),
        );
        if (!view) continue;
        if (!(report.views ?? []).some((row) => norm(row.id) === norm(view.id))) {
          report.views ??= [];
          report.views.push({
            id: view.id,
            name: view.name,
            entity: view.entity,
            sourceFile: view.file,
            fields: view.fields ?? [],
            evidence: 'list-view',
          });
        }
        for (const column of view.fields ?? [])
          if (
            column.name &&
            !(report.columns ?? []).some((row) => row.entity === view.entity && row.name === column.name)
          ) {
            const field = metadata.entities?.[view.entity]?.fields?.[column.name];
            report.columns ??= [];
            report.columns.push({
              entity: view.entity,
              name: column.name,
              sourceFile: field?.source ?? metadata.entities?.[view.entity]?.sources?.[0],
              resolved: Boolean(field),
              label: field?.label,
              type: field?.dataverseType ?? field?.type,
              evidence: 'list-view',
            });
          }
      }
    }
  inspectFormDependencies(report, portal, metadata, rendered);
  attachComponentRelations(report, portal);
  // Every scanned body keeps its name and file, so a dynamic Web API construction can name where it is.
  const namedBodies = [
    { text: page?.html, name: 'Page copy', sourceFile: bodyFile(page?.metadata, 'copy.html') },
    { text: page?.js, name: 'Page JavaScript', sourceFile: bodyFile(page?.metadata, 'custom_javascript.js') },
    { text: page?.css, name: 'Page CSS', sourceFile: bodyFile(page?.metadata, 'custom_css.css') },
    ...(report.webTemplates ?? []).map((row) => ({
      text: portal.templates?.[row.name]?.source,
      name: row.name,
      sourceFile: row.sourceFile ?? null,
    })),
    ...(report.snippets ?? []).map((row) => ({
      text: portal.snippets?.[row.name],
      name: row.name,
      sourceFile: row.sourceFile ?? null,
    })),
    // The custom JavaScript of every resolved form, multistep form step and list runs on the page as well.
    ...componentScriptBodies(report, portal),
  ].filter((row) => typeof row.text === 'string' && row.text);
  const sourceBodies = namedBodies.map((row) => row.text);
  const markup = [
    ...report.pageSources
      .filter((row) => row.fieldPath === 'copy')
      .map((row) => ({ body: page?.html, ...row, ...hintIdentity(provenance, page?.metadata, 'copy'), kind: 'page' })),
    ...(report.webTemplates ?? []).map((row) => ({
      ...row,
      body: portal.templates?.[row.name]?.source,
      kind: 'template',
      ...hintIdentity(provenance, portal.templates?.[row.name]?.metadata, 'source'),
    })),
    ...(report.snippets ?? []).map((row) => ({
      ...row,
      body: portal.snippets?.[row.name],
      kind: 'snippet',
      ...hintIdentity(provenance, null, 'value', provenance.snippet(row.name)),
    })),
  ];
  report.elementSources = markup.flatMap(({ body, ...source }) => indexedMarkupHints(body, source, whole));
  const referenced = new Set(
    report.elementSources.map((item) => item.sourceFile + '#' + (item.recordId ?? item.id ?? '') + '#' + item.selector),
  );
  const candidates = new Set();
  let candidateTruncated = false;
  // Prefer direct identities over a broad class bucket regardless of DOM order.
  const tokens = (rendered.markupTokens ?? []).slice(0, 8000),
    rank = (token) => {
      if (token.startsWith('id:')) return 0;
      return token.startsWith('attribute:') ? 1 : 2;
    };
  tokens.sort((a, b) => rank(a) - rank(b));
  candidateLoop: for (const token of tokens)
    for (const item of whole.byToken.get(token) ?? []) {
      if (
        referenced.has(item.sourceFile + '#' + (item.recordId ?? item.id ?? '') + '#' + item.selector) ||
        candidates.has(item)
      )
        continue;
      if (candidates.size >= 1200) {
        candidateTruncated = true;
        break candidateLoop;
      }
      candidates.add(item);
    }
  report.elementSources.push(...[...candidates].map((item) => structuredClone(item)));
  report.elementSourceFrequencies = Object.fromEntries(
    report.elementSources
      .filter((item) => item.matchKind === 'class')
      .map((item) => [item.selector, whole.classFrequencies[item.selector] ?? 1]),
  );
  let scriptTruncated = false;
  const scriptTruncatedSources = [];
  const appendScriptHints = (body, source) => {
    const hints = scriptSourceHints(body, source, { ids: rendered.ids ?? [] });
    if (hints.truncated) {
      scriptTruncated = true;
      scriptTruncatedSources.push(displaySource(portal, source));
    }
    report.elementSources.push(...hints);
  };
  for (const source of report.pageSources.filter((row) => row.fieldPath === 'customjavascript'))
    appendScriptHints(page?.js, {
      ...source,
      kind: 'script',
      ...hintIdentity(provenance, page?.metadata, 'customjavascript'),
    });
  // Relative references resolve against the address the browser requested (its trailing slash and language prefix
  // included), else the page's own URL; the lower-cased, slash-stripped report path is a lookup key, not a base.
  const browserBase = report.requestPath ?? page?.url ?? report.path ?? '/';
  const referencedPaths = new Set(sourceBodies.flatMap((text) => assetPaths(text, browserBase)));
  const observedPaths = new Set((rendered.assets ?? []).map((row) => webFileKey(row.path)).filter(Boolean));
  const requestedPaths = new Set(
    (rendered.requestPaths ?? []).slice(0, REQUEST_PATH_LIMIT).map(webFileKey).filter(Boolean),
  );
  // Stylesheets the platform layout links for this page without any markup naming them (shared runtime rule).
  const platformLinked = platformLinkedStylesheets(report, portal, page);
  const linkedKeys = new Set(platformLinked.files.map((file) => webFileKey(file.url)));
  const matchedFiles = new Map();
  const fileKeys = new Map(
    (portal.webFiles ?? []).filter((file) => file.url).map((file) => [file, webFileKey(file.url)]),
  );
  const assetEvidence = (key) => {
    if (observedPaths.has(key)) return 'rendered-asset';
    if (linkedKeys.has(key) && !referencedPaths.has(key)) return 'platform-linked-stylesheet';
    return 'static-reference';
  };
  // Follow only exported assets. Reads stay bounded; no URL is fetched.
  const pendingFiles = () =>
    (portal.webFiles ?? []).filter((file) => {
      const key = fileKeys.get(file);
      return (
        key &&
        !matchedFiles.has(file.url) &&
        (observedPaths.has(key) || referencedPaths.has(key) || requestedPaths.has(key) || linkedKeys.has(key))
      );
    });
  let webFilesTruncated = false,
    roundsTruncated = false;
  for (let round = 0; round < 8; round++) {
    const pending = pendingFiles();
    if (!pending.length) break;
    for (const file of pending) {
      matchedFiles.set(file.url, file);
      if (!['script', 'stylesheet'].includes(assetKind(file.mimeType, file.file))) continue;
      if (matchedFiles.size > 100) {
        webFilesTruncated = true;
        continue;
      }
      try {
        const real = await fs.realpath(file.file);
        if (inside(portal.sourceDir, real) && (await fs.stat(real)).size <= 1024 * 1024) {
          const text = await readLocalFile(real, { root: portal.sourceDir, maxBytes: 1024 * 1024, encoding: 'utf8' });
          if (assetKind(file.mimeType, file.file) === 'script')
            appendScriptHints(text, {
              name: file.name ?? file.url,
              sourceFile: real,
              kind: 'script',
              ...hintIdentity(provenance, file.metadata, '$content'),
            });
          sourceBodies.push(text);
          namedBodies.push({ text, name: file.name ?? file.url, sourceFile: real });
          for (const route of assetPaths(text, file.url)) referencedPaths.add(route);
        }
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    }
    // The eighth level still named web files: they are not followed.
    if (round === 7 && pendingFiles().length) roundsTruncated = true;
  }
  report.inputLimits = {
    ...report.inputLimits,
    assetsTruncated: Boolean(rendered.assetsTruncated),
    webFilesTruncated,
    roundsTruncated,
  };
  const body = sourceBodies.map(stripLiquidLiteralBlocks).join('\n'); // NOSONAR: preserve callback identity and iteration arguments
  report.assets = [...matchedFiles.values()].map((file) => {
    const key = fileKeys.get(file);
    return {
      name: file.name ?? file.url,
      url: file.url,
      kind: assetKind(file.mimeType, file.file),
      mimeType: file.mimeType ?? null,
      sourceFile: file.file,
      metadataSource: file.metadata?._file,
      evidence: assetEvidence(key),
      // requested: the browser session requested this path (live request observer); otherwise not observed here.
      ...(observedPaths.has(key) || requestedPaths.has(key) ? { observed: 'requested' } : {}),
      ...hintIdentity(provenance, file.metadata, '$content'),
    };
  });
  if (platformLinked.snippet && !(report.snippets ?? []).some((row) => row.name === platformLinked.snippet.name)) {
    report.snippets ??= [];
    report.snippets.push(platformLinked.snippet);
  }
  // The complete export index can be incomplete even when an omitted source is
  // unreferenced. Report its bounded summary without attributing it to a node.
  report.elementSourceLimits = {
    sourceBytes: MARKUP_SOURCE_LIMIT,
    total: report.elementSources.length,
    renderedCandidates: 1200,
    candidateTruncated,
    renderedTruncated: Boolean(rendered.truncated),
    markupIndexComplete: whole.markupOmittedSourceCount === 0,
    markupOmittedSourceCount: whole.markupOmittedSourceCount,
    markupOmittedSources: [...whole.markupOmittedSources],
    markupOmittedSourceNameLimit: OMITTED_SOURCE_NAME_LIMIT,
    markupOmittedSourcesTruncated: whole.markupOmittedSourceCount > whole.markupOmittedSources.length,
    scriptHintsPerSource: 120,
    scriptTruncated,
    scriptTruncatedSources,
    truncated:
      scriptTruncated || candidateTruncated || Boolean(rendered.truncated) || whole.markupOmittedSourceCount > 0,
  };
  // Literal Web API entity sets resolve only through selected Solution definitions (EntitySetName, else the logical
  // collection name). A set built at run time is named as a dynamic reference with its file, never guessed.
  const observedApiSets = new Set((rendered.apiSets ?? []).filter(isEntitySetSegment));
  const scannedApi = webApiReferences(namedBodies);
  // A built address whose literal part is a complete entity set ('/_api/x_items(' + id + ')') names that set.
  const completeSet = (segment) =>
    isEntitySetSegment(segment) && ['loaded', 'not-requested'].includes(entitySetTable(segment, metadata).state);
  for (const reference of scannedApi.dynamic)
    if (completeSet(reference.segment) && !scannedApi.literal.has(reference.segment))
      scannedApi.literal.set(reference.segment, reference.name);
  const apiSets = unique(
    [...scannedApi.literal.keys()].map((name) => ({ name })).concat([...observedApiSets].map((name) => ({ name }))),
    (row) => row.name,
  );
  for (const reference of scannedApi.dynamic)
    if (!completeSet(reference.segment))
      report.unresolved.push({
        kind: 'web-api-dynamic',
        expression: reference.expression,
        owner: reference.name,
        sourceFile: reference.sourceFile,
        reason: 'The Web API address is built at run time, so its table cannot be named from the source.',
      });
  // Tables reached only through Liquid, the Web API or a lookup are loaded from the selected Solution sources on demand.
  const wanted = new Set();
  for (const { name } of apiSets) {
    const resolved = entitySetTable(name, metadata);
    if (resolved.state === 'not-requested') wanted.add(resolved.logicalName);
  }
  for (const table of report.tables)
    if (!metadata.entities?.[table.logicalName] && metadata.tableCatalog?.[table.logicalName])
      wanted.add(table.logicalName);
  if (wanted.size && loadTables) {
    const loaded = await loadTables([...wanted].slice(0, 100)).catch(() => null);
    if (loaded?.entities) metadata = loaded;
  }
  const addTableColumns = (entity, evidence) => {
    const table = metadata.entities?.[entity];
    for (const [column, field] of Object.entries(table?.fields ?? {}))
      if (!report.columns.some((row) => row.entity === entity && row.name === column))
        report.columns.push({
          entity,
          name: column,
          label: field.label,
          type: field.dataverseType ?? field.type,
          required: Boolean(field.required),
          sourceFile: field.source ?? table.sources?.[0],
          resolved: true,
          evidence,
        });
  };
  report.apiReferences = apiSets.map(({ name }) => {
    const resolved = entitySetTable(name, metadata);
    const table = resolved.state === 'loaded' ? metadata.entities[resolved.logicalName] : null;
    if (table && !report.tables.some((row) => row.logicalName === resolved.logicalName))
      report.tables.push({
        kind: 'table',
        logicalName: resolved.logicalName,
        name: resolved.logicalName,
        entitySet: name,
        sourceFile: table.sources?.[0],
        sourceFiles: table.sources ?? [],
        fieldCount: Object.keys(table.fields ?? {}).length,
        evidence: 'web-api-source',
      });
    if (table) addTableColumns(resolved.logicalName, 'web-api-table-candidate');
    else
      report.unresolved.push({
        kind: 'web-api-entity-set',
        expression: name,
        owner: scannedApi.literal.get(name) ?? (observedApiSets.has(name) ? 'Observed request' : null),
        reason: entitySetReason(resolved, metadata),
      });
    return {
      name,
      entity: table ? resolved.logicalName : null,
      sourceFile: table?.sources?.[0] ?? null,
      evidence: observedApiSets.has(name) ? 'observed-api-request' : 'static-reference',
      ...(observedApiSets.has(name) ? { observed: 'requested' } : {}),
    };
  });
  resolveDefaultLookupViews(report, metadata);
  // A rendered custom grid may declare a table without issuing a Web API
  // request or sharing its enclosing form's table. Load that table's exported
  // definitions as context; the node observer separately verifies ownership.
  for (const entity of new Set((rendered.controls ?? []).map((row) => row.gridTable?.toLowerCase()))) {
    if (!/^[a-z][a-z0-9_]*$/.test(entity ?? '') || !metadata.entities?.[entity]) continue;
    const table = metadata.entities[entity];
    if (!report.tables.some((row) => row.logicalName === entity)) {
      report.tables.push({
        kind: 'table',
        logicalName: entity,
        name: entity,
        sourceFile: table.sources?.[0],
        sourceFiles: table.sources ?? [],
        fieldCount: Object.keys(table.fields ?? {}).length,
        evidence: 'rendered-grid-declaration',
      });
    }
    addTableColumns(entity, 'declared-grid-table-candidate');
  }
  inspectCodeComponents(report, body, metadata, observed, codeCatalogue);
  appendCodeComponentAssets(report, rendered, codeCatalogue, live);
  attachFormLayouts(report, provenance.metadataIndex);
  // Every table is known now: derive each one's metadata state, unresolved entry and Webapi/<table>/* settings.
  finalizeInspectionTables(report, portal, metadata);
  const permissionState = { tables: {}, mappings: {}, permissions: [], settings: {}, simulator: {} };
  const permissions = buildPermissionModel(portal, permissionState, {
    source: 'exported',
    relationships: metadata.relationships ?? {},
  }).permissions;
  const needed = new Set((report.tables ?? []).map((row) => row.logicalName));
  const byPermission = new Map(permissions.map((row) => [row.id, row]));
  for (const row of permissions.filter((row) => needed.has(row.entity))) {
    let parent = row;
    const seen = new Set();
    while (parent?.parentPermissionId && !seen.has(parent.id)) {
      seen.add(parent.id);
      parent = byPermission.get(parent.parentPermissionId);
      if (parent?.entity) needed.add(parent.entity);
    }
  }
  report.permissionRules = permissions
    .filter((row) => needed.has(row.entity))
    .map((row) => ({
      id: row.id,
      name: row.name,
      entity: row.entity,
      scope: row.scope,
      operations: row.operations,
      roles: row.roles,
      roleIds: row.roleIds ?? [],
      relationshipName: row.relationshipName,
      parentPermissionId: row.parentPermissionId,
      sourceFile: row.provenance?.file,
      evidence: 'exported-rule',
      effective: live ? 'unknown' : 'local-session',
    }));
  report.webRoles = webRoleSources(portal, report, provenance);
  if (live) {
    for (const row of report.page?.access?.rules ?? []) {
      row.matches = null;
      row.effective = 'unknown';
    }
    for (const table of report.tables ?? []) {
      const entity = metadata.entities?.[table.logicalName];
      table.entitySet = entity?.entitySetName ?? entity?.entitySet ?? null;
      table.entitySetInferred = entity?.entitySetSource === 'pluralized';
      table.idColumn = entity?.primaryIdAttribute ?? null;
      table.nameColumn = entity?.primaryNameAttribute ?? null;
      table.permissions = {
        mode: 'exported',
        effective: 'unknown',
        operations: {},
        rules: report.permissionRules.filter((row) => row.entity === table.logicalName),
      };
    }
  }
  report.renderedControls = unique(rendered.controls ?? [], (row) => JSON.stringify(row)).map((row) => {
    if (row.definitionConflict)
      return { ...row, sourceFile: null, field: null, candidates: [], evidence: 'rendered-conflict' };
    const candidates = (report.columns ?? []).filter(
      (column) => (column.name === row.id || column.name === row.name) && (!row.entity || column.entity === row.entity),
    );
    const field = candidates.length === 1 ? candidates[0] : null;
    const component = (report.forms ?? []).find((form) => norm(form.id) === norm(row.formId) && row.formId);
    return {
      ...row,
      sourceFile: field?.sourceFile ?? component?.sourceFile ?? null,
      field: field ? `${field.entity}.${field.name}` : null,
      candidates: candidates.map((item) => `${item.entity}.${item.name}`),
      evidence: field || component ? 'rendered-and-source' : 'rendered-unmapped',
    };
  });
  const pluginStepDescription = (step) => {
    let mode = 'unknown execution mode';
    if (step.mode === 0) mode = 'synchronous';
    else if (step.mode === 1) mode = 'asynchronous';
    const inputs = step.filteringAttributes.length ? ` · input attributes: ${step.filteringAttributes.join(', ')}` : '';
    return `${step.entity} ${step.message ?? 'Unknown message'} · ${step.stageName} · rank ${step.rank ?? 'unknown'} · ${mode}${inputs} · ${step.enabled ? 'export enabled' : 'export disabled'} · live execution unknown`;
  };
  const requestedFlow = (row) => Boolean(row.path && requestedPaths.has(webFileKey(row.path)));
  report.logic = [
    ...serverLogicReferences(portal.serverLogics ?? [], {
      body,
      observedRoutes: (rendered.serverLogicPaths ?? []).join('\n'),
    }).map((row) => (row.evidence === 'observed-request' ? { ...row, observed: 'requested' } : row)),
    ...(portal.cloudFlows ?? [])
      .filter(
        (row) =>
          (row.path && body.includes(row.path)) ||
          (row.processId && body.toLowerCase().includes(row.processId.toLowerCase())) ||
          requestedFlow(row),
      )
      .map((row) => ({
        ...row,
        sourceFile: portal.records.find((record) => norm(record.id) === norm(row.id))?._file,
        kind: 'cloud-flow',
        evidence: requestedFlow(row) ? 'observed-request' : 'static-reference',
        ...(requestedFlow(row) ? { observed: 'requested' } : {}),
      })),
    ...(metadata.plugins?.steps ?? [])
      .filter((step) => needed.has(step.entity))
      .map((step) => ({
        ...step,
        kind: 'plugin-step',
        evidence: 'exported-table-registration',
        effective: 'unknown',
        description: pluginStepDescription(step),
        sources: [
          { name: step.typeName ?? 'Unresolved plugin type', kind: 'plugin-type', sourceFile: step.typeSourceFile },
          {
            name: step.assemblyName ?? 'Unresolved plugin assembly',
            kind: 'plugin-assembly',
            sourceFile: step.assemblySourceFile,
          },
          ...(step.codeSourceFile
            ? [
                {
                  name: step.typeName,
                  kind: 'plugin-code',
                  sourceFile: step.codeSourceFile,
                  evidence: step.codeSourceEvidence,
                },
              ]
            : []),
        ],
      })),
  ];
  report.pluginInventory = {
    assemblies: metadata.plugins?.assemblies?.length ?? 0,
    types: metadata.plugins?.types?.length ?? 0,
    steps: metadata.plugins?.steps?.length ?? 0,
    applicable: report.logic.filter((item) => item.kind === 'plugin-step').length,
    effective: 'unknown',
  };
  componentMetadataDiagnostics(report, metadata);
  markRenderedSteps(report, portal, rendered);
  report.unresolved = unique(report.unresolved ?? [], (row) => JSON.stringify(row));
  return report;
}

export function createSourceInspector(cfg) {
  let loading = null;
  // Exported tables admitted from rendered declared grids, by language. A source reload (an edit, or a stamp too
  // recent to prove the sources unchanged) re-admits them, so an Open source check after it still finds them.
  const admittedTables = new Map();
  const fileCache = new SolutionFileCache();
  // Retain only current exported source indexes, one per currently configured
  // language. Their already-indexed hints survive global LRU eviction and refresh.
  const sourceIndexStore = new Map();
  let reports = new Map(),
    reportBytes = 0;
  const counters = { reportHits: 0, enrichments: 0, reloads: 0, unchangedRefreshes: 0 };
  const fingerprint = async (sources) =>
    JSON.stringify([
      sources,
      ...(await Promise.all([
        Promise.all([sources.sourceDir, ...sources.roots].map(inspectionDirectoryStamp)),
        mappedPluginStamps(sources),
        sources.deploymentProfileFile ? fileStamp(sources.deploymentProfileFile) : null,
      ])),
    ]);
  const remember = async (key, compute) => {
    key = createHash('sha256').update(key).digest('hex');
    const generation = reports,
      cached = reports.get(key);
    if (cached) {
      counters.reportHits++;
      reports.delete(key);
      reports.set(key, cached);
      return structuredClone(await cached.result);
    }
    const entry = { bytes: 0, result: Promise.resolve().then(compute) };
    reports.set(key, entry);
    try {
      const result = await entry.result;
      if (generation === reports && reports.get(key) === entry) {
        entry.bytes = JSON.stringify(result).length * 2;
        reportBytes += entry.bytes;
        while (reports.size > 16 || reportBytes > 32 * 1024 * 1024) {
          const oldest = reports.keys().next().value;
          reportBytes -= reports.get(oldest).bytes;
          reports.delete(oldest);
        }
      }
      return structuredClone(result);
    } catch (error) {
      if (generation === reports && reports.get(key) === entry) reports.delete(key);
      throw error;
    }
  };
  const load = () =>
    (loading ??= (async () => {
      const sources = await inspectionSources(cfg);
      counters.reloads++;
      const variants = new Map();
      const variant = async (language = null) => {
        const key = language?.id ?? '';
        if (!variants.has(key))
          variants.set(
            key,
            (async () => {
              const lcid = language?.lcid ?? sources.lcid;
              const imported = await importPortal(sources.sourceDir, {
                cache: fileCache,
                lcid,
                ...(language ? { languageId: language.id } : {}),
                ...(sources.dataModel ? { dataModel: sources.dataModel } : {}),
                ...(sources.deploymentProfile ? { deploymentProfile: sources.deploymentProfile } : {}),
                ...(sources.deploymentProfileFile ? { deploymentProfileFile: sources.deploymentProfileFile } : {}),
              });
              const portal = imported;
              const metadata = sources.roots.length
                ? await importSolutionMetadata(sources.roots, {
                    cache: fileCache,
                    portal,
                    lcid,
                    order: sources.order,
                    observed: sources.observed,
                  })
                : {};
              const codeCatalogue = await importCodeComponents(metadata.layers ?? []);
              return { portal, metadata, codeCatalogue };
            })(),
          );
        return variants.get(key);
      };
      // Capture before importing: an edit during import must force the next refresh,
      // never label an older parsed body with the newer file's stamp.
      const signature = await fingerprint(sources);
      const initial = await variant();
      const select = async (route, rendered = {}) => {
        const pathname = String(route ?? '/').split(/[?#]/)[0];
        const prefix = pathname.split('/')[1];
        const direct = initial.portal.pages.some(
          (page) => normalizePortalPath(page.url) === normalizePortalPath(pathname),
        );
        const language =
          !direct && initial.portal.websiteLanguages?.find((row) => row.code?.toLowerCase() === prefix?.toLowerCase());
        const selected = language ? await variant(language) : initial;
        const admitted = admittedTables.get(language?.id ?? '') ?? new Set();
        const declared = [
          ...new Set([
            ...admitted,
            ...(rendered.controls ?? []).slice(0, 300).map((row) => row.gridTable?.toLowerCase()),
          ]),
        ].filter((name) => typeof name === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(name));
        if (sources.roots.length && declared.some((name) => !selected.metadata.entities?.[name]))
          await admit(selected, language, declared);
        return {
          ...selected,
          language,
          route: language ? pathname.slice(prefix.length + 1) || '/' : pathname,
          requestPath: pathname,
          // Load further exported tables the enrichment finds (Liquid, Web API, lookups) into this language's catalogue.
          loadTables: (names) => admit(selected, language, names),
        };
      };
      // Serialize admissions so concurrent selections cannot replace each
      // other's newly admitted definitions. Keep only exported tables, not
      // arbitrary page declarations, in the language's current catalogue.
      const admit = async (selected, language, names) => {
        if (!sources.roots.length) return null;
        const admitted = admittedTables.get(language?.id ?? '') ?? new Set();
        const wanted = names.filter((name) => typeof name === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(name));
        const admission = (selected.admission ?? Promise.resolve())
          .catch(() => {})
          .then(async () => {
            const missing = [];
            for (const name of wanted) if (!selected.metadata.entities?.[name]) missing.push(name);
            if (!missing.length || admitted.size >= 300) return;
            const metadata = await importSolutionMetadata(sources.roots, {
              cache: fileCache,
              portal: selected.portal,
              entities: [
                ...new Set([
                  ...portalMetadataEntities(selected.portal),
                  ...Object.keys(selected.metadata.entities ?? {}),
                  ...missing,
                ]),
              ],
              lcid: language?.lcid ?? sources.lcid,
              order: sources.order,
              observed: sources.observed,
            });
            let hasAdmittedEntity = false;
            for (const name of missing)
              if (metadata.entities?.[name]) {
                hasAdmittedEntity = true;
                break;
              }
            if (!hasAdmittedEntity) return;
            for (const name of missing) if (metadata.entities?.[name] && admitted.size < 300) admitted.add(name);
            admittedTables.set(language?.id ?? '', admitted);
            selected.metadata = metadata;
            reports = new Map();
            reportBytes = 0;
          });
        selected.admission = admission;
        try {
          await admission;
        } finally {
          if (selected.admission === admission) selected.admission = null;
        }
        return selected.metadata;
      };
      return { sources, select, signature };
    })().catch((error) => {
      loading = null;
      throw error;
    }));
  return {
    invalidate() {
      const previous = loading;
      if (!previous) return;
      loading = previous
        .then(async (current) => {
          const sources = await inspectionSources(cfg);
          if ((await fingerprint(sources)) === current.signature) {
            counters.unchangedRefreshes++;
            return current;
          }
          reports = new Map();
          reportBytes = 0;
          loading = null;
          return load();
        })
        .catch((error) => {
          loading = null;
          reports = new Map();
          reportBytes = 0;
          throw error;
        });
      // Source-watch events can invalidate while no inspector is awaiting a report.
      // Keep the rejection available to an awaiting reader without an unhandled promise.
      void loading.catch(() => {});
    },
    stats() {
      return {
        ...counters,
        sourceFiles: { ...fileCache.stats },
        reports: reports.size,
        reportBytes,
        indexedLanguages: sourceIndexStore.size,
        indexedSources: [...sourceIndexStore.values()].reduce((sum, index) => sum + index.hintsBySource.size, 0),
      };
    },
    async pluginSourceRoots(route) {
      const { select } = await load();
      return (await select(route)).metadata.plugins?.sourceRoots ?? [];
    },
    /**
     * The code component catalogue of the page's selection (mirage/lib/code-components.mjs importCodeComponents: only
     * manifest-declared files inside each control folder) and the Solution roots it was read from.
     */
    async codeComponents(route = '/') {
      const { select, sources } = await load();
      const selected = await select(route);
      return { catalogue: selected.codeCatalogue, roots: sources.roots, sourceDir: sources.sourceDir };
    },
    async sourceIndexFor(route = '/', selection = null) {
      const { select, sources } = await load();
      const selected = await select(route);
      let { portal, metadata } = selected;
      const { language } = selected;
      if (
        selection &&
        ((selection.deploymentProfile ?? null) !== (portal.deploymentProfile ?? null) ||
          (selection.deploymentProfileFile &&
            path.resolve(selection.deploymentProfileFile) !== path.resolve(sources.deploymentProfileFile ?? '')))
      ) {
        portal = await importPortal(sources.sourceDir, {
          cache: fileCache,
          lcid: language?.lcid ?? sources.lcid,
          ...(language ? { languageId: language.id } : {}),
          ...(sources.dataModel ? { dataModel: sources.dataModel } : {}),
          ...(selection.deploymentProfile ? { deploymentProfile: selection.deploymentProfile } : {}),
          ...(selection.deploymentProfileFile ? { deploymentProfileFile: selection.deploymentProfileFile } : {}),
        });
        metadata = sources.roots.length
          ? await importSolutionMetadata(sources.roots, {
              cache: fileCache,
              portal,
              lcid: language?.lcid ?? sources.lcid,
              order: sources.order,
              observed: sources.observed,
            })
          : {};
      }
      return provenanceIndex(portal, metadata, selected.codeCatalogue);
    },
    async lookupSource({
      sourceKey,
      sourceRevision,
      contentRevision,
      region,
      route = '/',
      selection = null,
      portalProfile = selection,
    } = {}) {
      // Editor links must re-import current identities, never trust a stale file+array ordinal.
      this.invalidate();
      const index = await this.sourceIndexFor(route, portalProfile);
      const matches = [...index.sources.values()].filter(
        (source) => source.key === sourceKey || source.id === sourceKey,
      );
      if (!matches.length && typeof sourceKey === 'string' && sourceKey.startsWith('model-source:')) {
        return editorAdmission(() => {
          const admitted = index.metadataIndex.resolveOpen({ sourceKey, sourceRevision, contentRevision });
          if (admitted.ok)
            return {
              state: 'exact',
              sourceRef: admitted.sourceRef,
              editorTarget: {
                file: admitted.file,
                line: admitted.line ?? 1,
                column: admitted.column ?? 1,
                mapped: admitted.locationAvailable,
              },
            };
          return { state: /stale|changed/.test(admitted.reason) ? 'stale' : 'unavailable', reason: admitted.reason };
        });
      }
      if (!matches.length) return { state: 'unavailable', reason: 'source-identity-missing' };
      if (matches.length !== 1) return { state: 'conflicting', reason: 'source-identity-ambiguous' };
      const source = matches[0];
      if (source.ambiguous) return { state: 'conflicting', reason: 'duplicate-source-identity' };
      const { text: _text, file: _file, sourceDir: _root, ...sourceRef } = source; // NOSONAR: binding is excluded from the rest object or is a placeholder
      if (sourceRevision !== index.sourceRevision || contentRevision !== source.contentRevision)
        return { state: 'stale', reason: 'source-revision-changed', replacement: sourceRef };
      if (source.id.startsWith('model-source:')) {
        return editorAdmission(() => {
          const admission = index.metadataIndex.resolveOpen({
            sourceKey: source.id,
            sourceRevision,
            contentRevision,
            componentKey: source.componentKey,
            placementKey: source.placementKey,
          });
          return admission.ok
            ? {
                state: 'exact',
                sourceRef,
                editorTarget: {
                  file: admission.file,
                  line: admission.line ?? 1,
                  column: admission.column ?? 1,
                  mapped: admission.locationAvailable,
                },
              }
            : { state: 'stale', reason: admission.reason };
        });
      }
      if (
        region &&
        (!Number.isSafeInteger(region.start) ||
          !Number.isSafeInteger(region.end) ||
          region.start < 0 ||
          region.end < region.start ||
          region.end > source.text.length)
      )
        return { state: 'unavailable', reason: 'source-region-invalid' };
      return editorAdmission(() => {
        const editorTarget = sourceEditorTarget(source, region);
        return editorTarget
          ? { state: 'exact', sourceRef, editorTarget }
          : { state: 'unavailable', reason: 'source-file-not-admitted' };
      });
    },
    async enrich(report, rendered = {}) {
      if (!report || typeof report !== 'object' || Array.isArray(report))
        throw new TypeError('Source inspection requires a page report object.');
      const { sources, select } = await load();
      const route = report.requestPath ?? report.path;
      const selected = await select(route, rendered);
      const { codeCatalogue } = selected;
      const index = await this.sourceIndexFor(route, report.portalProfile);
      const { portal, metadata } = index;
      const enriched = await remember('enrich:' + JSON.stringify([report, rendered]), async () => {
        counters.enrichments++;
        const result = await enrichInspection(structuredClone(report), portal, {
          metadata,
          rendered,
          observed: sources.observed,
          codeCatalogue,
          sourceIndexStore,
          // A deployment-profile import has its own metadata; on-demand tables load only into the selected catalogue.
          loadTables: metadata === selected.metadata ? selected.loadTables : null,
        });
        // The same source-selection diagnostics as inspect, so the Mirage path is not silent about them either.
        result.sourceSelection = { ...sources.selection, roots: sources.roots };
        result.unresolved.push(...sources.diagnostics.map((row) => ({ kind: 'configuration', ...row })));
        result.unresolved = unique(result.unresolved, (row) => JSON.stringify(row));
        return result;
      });
      // These are current export refs, independent of the immutable refs observed
      // when a response was rendered or fulfilled. Preserve the trusted profile.
      enriched.portalSources = index.snapshot(enriched);
      enriched.sourceRevision = index.sourceRevision;
      return Object.assign(report, enriched);
    },
    async inspect(route, rendered = {}) {
      const { sources, select } = await load();
      const selected = await select(route, rendered);
      return remember('inspect:' + JSON.stringify([route, rendered]), async () => {
        const { portal, metadata, codeCatalogue, language, route: sourceRoute, requestPath } = selected;
        const report = inspectPage(portal, sourceRoute, { solutionMetadata: metadata });
        report.requestPath = requestPath;
        if (language) report.language = { id: language.id, code: language.code, lcid: language.lcid };
        counters.enrichments++;
        await enrichInspection(report, portal, {
          metadata,
          rendered,
          live: true,
          observed: sources.observed,
          codeCatalogue,
          sourceIndexStore,
          loadTables: selected.loadTables,
        });
        const index = provenanceIndex(portal, metadata, codeCatalogue);
        report.portalSources = index.snapshot(report);
        report.sourceRevision = index.sourceRevision;
        report.sourceSelection = { ...sources.selection, roots: sources.roots };
        report.unresolved.push(...sources.diagnostics.map((row) => ({ kind: 'configuration', ...row })));
        return {
          report,
          roots: [sources.sourceDir, ...sources.roots, ...(metadata.plugins?.sourceRoots ?? [])],
          status: {
            site: cfg.siteName,
            format: portal.format,
            sourceDir: sources.sourceDir,
            diagnostics: { total: report.unresolved.length },
            solutionRoots: sources.roots,
          },
        };
      });
    },
  };
}
