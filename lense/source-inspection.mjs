// Source-only inspection for a live Lense tab. No runtime, data pack or live request is started.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readLocalFile } from './local-file.mjs';
import { importPortal, portalField, normalizePortalPath, effectiveSnippetRecords } from '../mirage/lib/importer.mjs';
import { importSolutionMetadata, portalMetadataEntities } from '../mirage/lib/solution-metadata.mjs';
import { loadProjectConfig } from '../mirage/lib/project-config.mjs';
import { inspectPage } from '../mirage/lib/page-resources.mjs';
import { stripLiquidLiteralBlocks } from '../mirage/lib/liquid-source.mjs';
import { buildPermissionModel } from '../mirage/lib/permissions.mjs';
import { importCodeComponents } from '../mirage/lib/code-components.mjs';
import { elementSourceHints, scriptSourceHints } from './element-provenance.mjs';
import { assetKind } from '../mirage/lib/asset-type.mjs';
import { SolutionFileCache, fileStamp, mapLimit } from '../mirage/lib/solution-cache.mjs';
import { resolvePluginSourcePath } from '../mirage/lib/exported-plugins.mjs';
import { buildPortalSourceIndex, sourceEditorTarget } from '../mirage/lib/portal-source-index.mjs';
import { loadDeploymentProfiles } from '../mirage/lib/deployment-profiles.mjs';
import { definitionQuery } from './definition-query.mjs';

// Keep the browser entry point serializable, with owned dependencies embedded.
export const inspectRenderedPage = new Function(
  `return function inspectRenderedPage(){const definitionQuery=(${definitionQuery.toString()}); return (${inspectRenderedPageImpl.toString()})();};`,
)();

const norm = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
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
  const value = source.sourceFile
    ? inside(portal.sourceDir, source.sourceFile)
      ? path.relative(portal.sourceDir, source.sourceFile).replaceAll('\\', '/')
      : path.basename(source.sourceFile)
    : String(source.name ?? 'Source')
        .replaceAll('\\', '/')
        .split('/')
        .pop();
  return value;
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
  files.sort();
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
const hintTokens = (hint) =>
  hint.matchKind === 'id'
    ? ['id:' + hint.domId]
    : hint.matchKind === 'class'
      ? (hint.classes ?? []).map((name) => 'class:' + hint.tag + ':' + name)
      : Object.entries(hint.attributes ?? {}).map(
          ([name, value]) => 'attribute:' + hint.tag + ':' + name + ':' + value,
        );
const markupKey = (source) => JSON.stringify([source.kind, source.sourceFile, source.recordId ?? source.id ?? '']);
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
  let markupOmittedSourceCount = 0;
  for (const { body, ...source } of sources) {
    if (String(body ?? '').length > MARKUP_SOURCE_LIMIT) {
      markupOmittedSourceCount++;
      if (markupOmittedSources.length < OMITTED_SOURCE_NAME_LIMIT) {
        const name = displaySource(portal, source);
        markupOmittedSources.push(name.length > 240 ? name.slice(0, 237) + '...' : name);
      }
      continue;
    }
    const key = markupKey(source);
    let old = previous?.hintsBySource.get(key);
    if (old?.body !== body)
      for (const related of relatedIndexes) {
        const entry = related.hintsBySource.get(key);
        if (entry && entry.body === body) {
          old = entry;
          break;
        }
      }
    const hints =
      old && old.body === body ? old.hints.map((hint) => ({ ...hint, ...source })) : elementSourceHints(body, source);
    hintsBySource.set(key, { body, hints });
    for (const hint of hints) {
      if (source.kind !== 'page')
        for (const token of hintTokens(hint)) {
          let rows = byToken.get(token);
          if (!rows) byToken.set(token, (rows = []));
          rows.push(hint);
        }
      if (hint.matchKind === 'class') {
        let files = frequencies.get(hint.selector);
        if (!files) frequencies.set(hint.selector, (files = new Set()));
        files.add(source.sourceFile + '#' + source.id);
      }
    }
  }
  const forms = [...(portal.forms ?? []), ...(portal.advancedForms ?? [])].map((form) => {
    const schema = metadata.componentSchemas?.[form.id] ?? metadata.componentSchemas?.[form.name],
      advanced = form.metadata?.kind === 'advancedform';
    return {
      id: form.id,
      name: form.name,
      kind: advanced ? 'advanced-form' : 'basic-form',
      entity: form.entityName ?? schema?.entity,
      ...(advanced
        ? {
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
  // Quick-view documents can identify a system form directly, independently
  // of an opener's include graph or a basic-form record.
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
  const lists = (portal.lists ?? []).map((list) => ({
    id: list.id,
    recordId: list.id,
    name: list.name,
    kind: 'list',
    entity: list.entityName,
    sourceFile: list.metadata?._file,
    pageReferenced: false,
    evidenceLabel: 'Exported list; not referenced by this page’s sources',
  }));
  index = {
    metadata,
    byToken,
    hintsBySource,
    markupOmittedSourceCount,
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
const indexedMarkupHints = (body, source, index) => {
  const entry = index.hintsBySource.get(markupKey(source));
  if (!entry || entry.body !== body) return elementSourceHints(body, source);
  // Index rows own only these four source fields. Rebind richer page/report
  // descriptors and clone hint ancestry so callers cannot mutate the index.
  return entry.hints.map(({ id, name, kind, sourceFile, ...hint }) => ({ ...structuredClone(hint), ...source }));
};

// Resolve declared browser resources against their browser URL, never a source directory.
function assetPaths(text, basePath) {
  const values = [];
  const patterns = [
    /\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi,
    /\burl\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi,
    /@import\s+['"]([^'"]+)['"]/gi,
    /\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/gi,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gi,
  ];
  for (const pattern of patterns)
    for (const match of String(text ?? '').matchAll(pattern)) {
      try {
        if (!match[1] || match[1].includes('{{') || match[1].startsWith('#')) continue;
        const url = new URL(match[1], new URL(basePath, 'http://inspect.invalid'));
        if (url.origin === 'http://inspect.invalid') values.push(decodeURIComponent(url.pathname));
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    }
  return values;
}

/** Only configured roots are used. An unrelated project default never replaces this site. */
export async function inspectionSources(cfg) {
  const configured = cfg.mirageConfig ?? {};
  const sourceDir = await fs.realpath(cfg.sourceDir);
  let roots =
      cfg.mirageSourceRoots?.filter(
        (root) => path.resolve(root).toLowerCase() !== path.resolve(cfg.sourceDir).toLowerCase(),
      ) ??
      configured.solutionRoots ??
      [],
    order = configured.solutionOrder ?? 'derived';
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
  const selected = [];
  const activeProfile = deploymentProfiles ? await loadDeploymentProfiles(deploymentProfiles) : null;
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory');
      selected.push(real);
    } catch {
      diagnostics.push({
        code: 'INSPECT_SOLUTION_UNAVAILABLE',
        reason: `Configured Solution source is unavailable: ${root}`,
      });
    }
  }
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
  };
}

/** Fixed, bounded DOM read. Do not collect text, field values or credentials.
 * Read only form/table definition hints from frame addresses, never row parameters. */
function inspectRenderedPageImpl() {
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
      layout = JSON.parse(node.getAttribute('data-form-layout') ?? '{}');
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
      id: node.id.slice(0, 160),
      name: (node.getAttribute('name') ?? '').slice(0, 160),
      type: (node.getAttribute('type') ?? '').slice(0, 40),
      entity: String(
        node.getAttribute('data-entityname') ??
          node.getAttribute('data-entity') ??
          layout.EntityName ??
          frameContext.entity ??
          '',
      ).slice(0, 160),
      formId: String(node.getAttribute('data-formid') ?? layout.Id ?? frameContext.formId ?? '').slice(0, 160),
      ...(frameContext.conflict ? { definitionConflict: true } : {}),
      ...(frameContext.aliasCandidates ? { definitionAliasCandidates: frameContext.aliasCandidates } : {}),
      viewId: (node.getAttribute('data-viewid') ?? node.getAttribute('data-selected-view') ?? '').slice(0, 160),
      listId: (
        node.getAttribute('data-listid') ??
        /^EntityList(?:Control_)?([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:$|_)/i.exec(
          node.id,
        )?.[1] ??
        ''
      ).slice(0, 160),
      gridId: node.classList.contains('entity-grid') ? (node.closest('.subgrid[id]')?.id ?? '').slice(0, 160) : '',
      ...(node.localName === 'table' && node.hasAttribute('data-paqvilo-table')
        ? { gridTable: (node.getAttribute('data-paqvilo-table') ?? '').slice(0, 160) }
        : {}),
      controlId: (node.getAttribute('data-controlid') ?? '').slice(0, 160),
      schemaName: (node.getAttribute('data-pcf-schema') ?? '').slice(0, 160),
      nativeField: (node.closest('[data-pcf-native-field]')?.getAttribute('data-pcf-native-field') ?? '').slice(0, 160),
    };
  };
  const apiSets = [
    ...new Set(
      performance
        .getEntriesByType('resource')
        .slice(-300)
        .flatMap((entry) => {
          const route = pathname(entry.name);
          const match = route && /^\/_api\/([a-z][\w]*)(?:\(|\/|$)/i.exec(route);
          return match ? [match[1]] : [];
        }),
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
        const id = boundary.getAttribute('data-paqvilo-grid');
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
    if (node.matches('script[src],link[href],img[src]') && assets.length < 300) {
      const raw = node.getAttribute('src') ?? node.getAttribute('href');
      try {
        const url = new URL(raw, node.ownerDocument.baseURI);
        if (url.origin === location.origin) assets.push({ kind: node.localName, path: url.pathname });
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
    .filter((id) => id.length <= 160 && !/[\s?=&/{}%\x00-\x1f\x7f]/.test(id));
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
  return {
    assets,
    controls,
    apiSets,
    ids,
    markupTokens: [...tokens],
    truncated: controlsSeen > 300 || shapeTruncated || tokenTruncated,
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

/** Follow only exported native component bindings, with provenance for conditional/modal sources. */
function inspectFormDependencies(report, portal, metadata, rendered) {
  const queue = [...(report.forms ?? [])];
  const visited = new Set();
  report.nativeComponents = [];
  report.nativeCodeBindings = [];
  const addEntity = (entity) => {
    if (!entity || report.tables.some((row) => row.logicalName === entity)) return;
    const table = metadata.entities?.[entity];
    report.tables.push({
      kind: 'table',
      name: entity,
      logicalName: entity,
      sourceFile: table?.sources?.[0],
      sourceFiles: table?.sources ?? [],
      fieldCount: Object.keys(table?.fields ?? {}).length,
      evidence: 'form-dependency',
    });
  };
  const addFields = (entity, fields, evidence) => {
    addEntity(entity);
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
  };
  const addView = (reference, entity, owner, evidence) => {
    if (!reference) return null;
    const view = metadata.views?.find((row) => norm(row.id) === norm(reference) && (!entity || row.entity === entity));
    if (!view) {
      report.unresolved.push({
        kind: 'view',
        expression: reference,
        owner,
        reason: 'The form references a view absent from selected Solution sources.',
      });
      return null;
    }
    let item = report.views.find((row) => norm(row.id) === norm(view.id));
    if (!item)
      report.views.push(
        (item = {
          id: view.id,
          name: view.name,
          entity: view.entity,
          sourceFile: view.file,
          fields: view.fields ?? [],
          evidence,
        }),
      );
    if (evidence === 'rendered-view-id') item.evidence = evidence;
    (item.usedBy ??= []).push(owner);
    addFields(view.entity, view.fields, evidence);
    return view;
  };
  const addForm = (reference, owner, evidence) => {
    const definition = portal.forms.find((row) => norm(row.id) === norm(reference));
    if (!definition) {
      report.unresolved.push({
        kind: 'modal-form',
        expression: reference,
        owner,
        reason: 'The action references a basic form absent from the portal export.',
      });
      return null;
    }
    let item = report.forms.find((row) => norm(row.id) === norm(definition.id));
    if (!item) {
      const schema = metadata.componentSchemas?.[definition.id] ?? metadata.componentSchemas?.[definition.name];
      item = {
        id: definition.id,
        name: definition.name,
        kind: 'basic-form',
        entity: definition.entityName,
        formName: definition.formName,
        mode: definition.mode,
        sourceFile: definition.metadata?._file,
        formXml: schema?.sourceFile
          ? { id: schema.formId, name: schema.formName, sourceFile: schema.sourceFile }
          : null,
        evidence,
      };
      report.forms.push(item);
      queue.push(item);
    }
    (item.usedBy ??= []).push(owner);
    return item;
  };
  for (const component of report.components ?? []) {
    if (component.kind !== 'list') continue;
    const list = portal.lists.find((row) => norm(row.id) === norm(component.recordId ?? component.id));
    let settings;
    try {
      settings = JSON.parse(portalField(list?.metadata, 'settings', '{}'));
    } catch {
      continue;
    }
    for (const action of settings?.ViewActions ?? []) {
      if (
        action.EntityFormId &&
        (action.TargetType == null || action.TargetType === '' || Number(action.TargetType) === 0)
      )
        addForm(action.EntityFormId, `${list.name} ${action.Type ?? 'action'}`, 'configured-list-modal-form');
    }
    for (const action of settings?.ItemActions ?? []) {
      if (
        action.EntityFormId &&
        (action.TargetType == null || action.TargetType === '' || Number(action.TargetType) === 0)
      )
        addForm(action.EntityFormId, `${list.name} ${action.Type ?? 'action'}`, 'configured-list-modal-form');
    }
  }
  for (const observed of rendered.controls ?? [])
    if (observed.viewId)
      addView(
        observed.viewId,
        observed.entity || null,
        observed.gridId || observed.id || 'Rendered native grid',
        'rendered-view-id',
      );
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
      const cells =
        current.layout?.flatMap((tab) =>
          tab.columns.flatMap((column) => column.sections.flatMap((section) => section.rows.flat())),
        ) ?? [];
      for (const field of [...(current.fields ?? []), ...cells])
        for (const component of field.codeComponents ?? []) {
          const owner = `${form.name}.${field.name ?? field.id}`;
          if (
            report.nativeCodeBindings.some(
              (row) => row.owner === owner && row.name === component.name && row.formFactor === component.formFactor,
            )
          )
            continue;
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
            (row) =>
              norm(row.schemaName) === norm(component.name) && (!row.nativeField || row.nativeField === field.name),
          );
          report.nativeCodeBindings.push({
            ...component,
            owner,
            entity: current.entity,
            field: field.name ?? null,
            formId: form.id,
            formSourceFile: component.sourceFile ?? current.sourceFile,
            selectedDesktop: field.codeComponent === component,
            enablement: settings.length > 1 ? 'ambiguous' : style === 756150001 ? 'configured' : 'not-enabled',
            metadataSources: settings.map((record) => ({ name: 'Code component settings', sourceFile: record._file })),
            evidence: observed ? 'rendered-and-form-source' : 'form-source',
          });
        }
      for (const cell of cells) {
        if (!['subgrid', 'quickform', 'notes'].includes(cell.type)) {
          if (cell.lookupViewId)
            report.nativeComponents.push({
              kind: 'lookup',
              id: cell.id ?? cell.name,
              name: cell.label ?? cell.name,
              formId: form.id,
              owner: form.name + '.' + (cell.name ?? cell.id),
              sourceFile: current.sourceFile,
              viewId: cell.lookupViewId,
            });
          if (cell.lookupViewId)
            addView(cell.lookupViewId, cell.lookupView?.entity, `${form.name}.${cell.id} lookup`, 'lookup-view');
          continue;
        }
        const owner = `${form.name}.${cell.id}`;
        const observed = (rendered.controls ?? []).find((row) => row.gridId === cell.id || row.controlId === cell.id);
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
            walk(cell.schema, depth + 1);
          } else
            report.unresolved.push({
              kind: 'quick-form',
              expression: cell.id,
              owner,
              reason: 'The quick view form is absent from selected Solution sources.',
            });
        }
        if (cell.type !== 'subgrid') continue;
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
            reason:
              'Multiple exported metadata records configure this subgrid; action visibility and precedence are unknown.',
          });
        for (const record of records) {
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
              reason: 'Exported subgrid settings JSON is malformed.',
            });
            continue;
          }
          for (const action of [
            ...(Array.isArray(settings?.ViewActions) ? settings.ViewActions : []),
            ...(Array.isArray(settings?.ItemActions) ? settings.ItemActions : []),
          ]) {
            if (
              ![
                'CrmEntityFormView-CreateAction',
                'CrmEntityFormView-EditAction',
                'CrmEntityFormView-DetailsAction',
              ].includes(action.Type)
            )
              continue;
            const modal =
              action.EntityFormId &&
              (action.TargetType == null || action.TargetType === '' || Number(action.TargetType) === 0);
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
      }
    };
    walk(schema);
  }
}

function inspectCodeComponents(report, body, metadata, observed, catalogue) {
  const literal = (text) => {
    const value = /^\s*(?:'([^']+)'|"([^"]+)"|([^\s,]+))/.exec(text);
    const name = value?.[1] ?? value?.[2] ?? value?.[3] ?? '';
    return {
      name,
      dynamic:
        !value || Boolean(value[3] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)),
    };
  };
  report.codeComponents = unique(
    [...body.matchAll(/{%[-]?\s*codecomponent\b([^%]*)%}/gi)].map((match) => {
      const nameParameter = /\bname\s*:\s*/i.exec(match[1]);
      const { name, dynamic } = literal(
        nameParameter ? match[1].slice(nameParameter.index + nameParameter[0].length) : '',
      );
      const direct = !dynamic && [...(catalogue?.controls.keys() ?? [])].find((key) => norm(key) === norm(name));
      const schemaName = dynamic ? null : (direct ?? observed?.codeComponents?.[norm(name)] ?? null);
      const row = {
        name,
        dynamic,
        schemaName,
        expression: match[0],
        evidence: dynamic ? 'dynamic-reference' : 'static-reference',
        binding: direct ? 'declared-schema-name' : schemaName ? 'observed-component-mapping' : 'unknown',
      };
      const control = catalogue?.controls.get(schemaName);
      if (!control) {
        report.unresolved.push({
          kind: 'code-component',
          expression: row.expression,
          reason: dynamic
            ? 'Code component name is dynamic and cannot be resolved from a static export.'
            : schemaName
              ? 'The code component manifest is absent from selected Solution sources.'
              : 'No exact Solution schema name or observed component mapping resolves this reference.',
        });
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
      for (const dataset of control.datasets ?? []) {
        const argument = new RegExp(`\\b${dataset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i').exec(
          match[1],
        );
        const binding = literal(argument ? match[1].slice(argument.index + argument[0].length) : '');
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
            reason: 'Dataset binding is missing or dynamic; no exported table or view is inferred.',
          });
          continue;
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
                : 'The dataset table or view is absent from selected Solution sources.',
          });
          continue;
        }
        Object.assign(item, {
          resolved: true,
          entity,
          viewId: view?.id ?? null,
          viewName: view?.name ?? null,
          sourceFile: view?.file ?? table.sources?.[0],
          fields: view?.fields?.length ? view.fields : Object.keys(table.fields ?? {}).map((name) => ({ name })),
        });
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
      return row;
    }),
    (row) => row.expression,
  );
  for (const binding of report.nativeCodeBindings ?? []) {
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
        reason: 'The FormXml custom control manifest is absent from selected Solution sources.',
      });
    if (binding.enablement === 'ambiguous')
      report.unresolved.push({
        kind: 'native-code-component-settings',
        expression: binding.field,
        owner: binding.owner,
        reason: 'Multiple attribute metadata records configure this control; portal enablement is ambiguous.',
      });
    for (const [name, parameter] of Object.entries(binding.parameters ?? {})) {
      if (parameter.kind === 'unresolved')
        report.unresolved.push({
          kind: 'native-code-component-property',
          expression: name,
          owner: binding.owner,
          reason: parameter.reason ?? 'The exported native property binding cannot be resolved.',
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
      if (parameter.kind === 'dataset') {
        const view =
          parameter.viewId &&
          metadata.views?.find(
            (item) =>
              norm(item.id) === norm(parameter.viewId) && (!parameter.entity || item.entity === parameter.entity),
          );
        if (view) {
          (row.datasets ??= []).push({
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
            if (
              column.name &&
              !report.columns.some((item) => item.entity === view.entity && item.name === column.name)
            ) {
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
        } else
          report.unresolved.push({
            kind: 'native-code-component-dataset',
            expression: parameter.viewId ?? name,
            owner: binding.owner,
            reason:
              'The exported native dataset view is absent or its table binding does not match selected Solution sources.',
          });
      }
    }
  }
}

/** Enrich a shared report with source provenance and observed DOM, never a live access verdict. */
export async function enrichInspection(
  report,
  portal,
  { metadata = {}, rendered = {}, live = false, observed = null, codeCatalogue = null, sourceIndexStore = null } = {},
) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new TypeError('Source inspection requires a page report object.');
  report.evidence = {
    mode: live ? 'live-sources' : 'local-runtime',
    source: 'Static references from the selected local export. Conditional branches may not be rendered.',
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
      const schema = metadata.componentSchemas?.[form.id] ?? metadata.componentSchemas?.[form.name];
      (report.forms ??= []).push({
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
        )
          (report.columns ??= []).push({
            entity: form.entityName,
            name: field.name,
            sourceFile: field.source ?? metadata.entities?.[form.entityName]?.sources?.[0],
            resolved: true,
            type: field.type,
            label: field.label,
          });
    }
    const list =
      control.listId &&
      portal.lists.find((row) => norm(row.id).replace(/-/g, '') === norm(control.listId).replace(/-/g, ''));
    if (list && !(report.components ?? []).some((row) => norm(row.recordId) === norm(list.id)))
      (report.components ??= []).push({
        kind: 'list',
        recordId: list.id,
        name: list.name,
        entity: list.entityName,
        sourceFile: list.metadata?._file,
        evidence: 'rendered-component-id',
      });
    const view = control.viewId && metadata.views?.find((row) => norm(row.id) === norm(control.viewId));
    if (view && !(report.views ?? []).some((row) => norm(row.id) === norm(view.id)))
      (report.views ??= []).push({
        id: view.id,
        name: view.name,
        entity: view.entity,
        sourceFile: view.file,
        fields: view.fields,
        evidence: 'rendered-component-id',
      });
    for (const entity of [
      form?.entityName,
      list?.entityName,
      view?.entity,
      control.entity && metadata.entities?.[control.entity] ? control.entity : null,
    ].filter(Boolean)) {
      if (!(report.tables ?? []).some((row) => row.logicalName === entity)) {
        const table = metadata.entities?.[entity];
        (report.tables ??= []).push({
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
      const viewIds = [];
      for (let value of [
        portalField(definition.metadata ?? {}, 'view'),
        portalField(definition.metadata ?? {}, 'views'),
      ]) {
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch {
            value = value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
          }
        }
        const values = value?.Views ?? value?.views ?? value;
        for (const view of Array.isArray(values) ? values : values ? [values] : []) {
          const id = typeof view === 'object' ? (view.ViewId ?? view.viewId ?? view.id ?? view.value) : view;
          if (id) viewIds.push(String(id));
        }
      }
      component.viewIds = [...new Set(viewIds)];
      for (const viewId of component.viewIds) {
        const view = metadata.views?.find(
          (row) => norm(row.id) === norm(viewId) && (!component.entity || row.entity === component.entity),
        );
        if (!view) continue;
        if (!(report.views ?? []).some((row) => norm(row.id) === norm(view.id)))
          (report.views ??= []).push({
            id: view.id,
            name: view.name,
            entity: view.entity,
            sourceFile: view.file,
            fields: view.fields ?? [],
            evidence: 'list-view',
          });
        for (const column of view.fields ?? [])
          if (
            column.name &&
            !(report.columns ?? []).some((row) => row.entity === view.entity && row.name === column.name)
          ) {
            const field = metadata.entities?.[view.entity]?.fields?.[column.name];
            (report.columns ??= []).push({
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
  const sourceBodies = [
    page?.html,
    page?.js,
    page?.css,
    ...(report.webTemplates ?? []).map((row) => portal.templates?.[row.name]?.source),
    ...(report.snippets ?? []).map((row) => portal.snippets?.[row.name]),
  ].filter(Boolean);
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
    rank = (token) => (token.startsWith('id:') ? 0 : token.startsWith('attribute:') ? 1 : 2);
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
  const browserBase = report.requestPath ?? report.path ?? page?.url ?? '/';
  const referencedPaths = new Set(sourceBodies.flatMap((text) => assetPaths(text, browserBase)));
  const observedPaths = new Set((rendered.assets ?? []).map((row) => row.path));
  const matchedFiles = new Map();
  // Follow only exported assets. Reads stay bounded; no URL is fetched.
  for (let round = 0; round < 8; round++) {
    const pending = (portal.webFiles ?? []).filter(
      (file) =>
        file.url && !matchedFiles.has(file.url) && (observedPaths.has(file.url) || referencedPaths.has(file.url)),
    );
    if (!pending.length) break;
    for (const file of pending) {
      matchedFiles.set(file.url, file);
      if (!['script', 'stylesheet'].includes(assetKind(file.mimeType, file.file)) || matchedFiles.size > 100) continue;
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
          for (const route of assetPaths(text, file.url)) referencedPaths.add(route);
        }
      } catch {
        /* Optional inspection or cleanup failure must not interrupt the owning operation. */
      }
    }
  }
  const body = sourceBodies.map(stripLiquidLiteralBlocks).join('\n');
  report.assets = [...matchedFiles.values()].map((file) => ({
    name: file.name ?? file.url,
    url: file.url,
    kind: assetKind(file.mimeType, file.file),
    mimeType: file.mimeType ?? null,
    sourceFile: file.file,
    metadataSource: file.metadata?._file,
    evidence: observedPaths.has(file.url) ? 'rendered-asset' : 'static-reference',
    ...hintIdentity(provenance, file.metadata, '$content'),
  }));
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
  // Literal Web API entity sets resolve only through selected Solution definitions.
  // Dynamic expressions stay unknown rather than assuming an English plural table name.
  const observedApiSets = new Set((rendered.apiSets ?? []).filter((value) => /^[a-z][\w]*$/i.test(value)));
  const apiSets = unique(
    [...body.matchAll(/\/_api\/([a-z][\w]*)\b/gi)]
      .map((match) => ({ name: match[1] }))
      .concat([...observedApiSets].map((name) => ({ name }))),
    (row) => row.name,
  );
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
    const entity = Object.entries(metadata.entities ?? {}).find(
      ([, table]) => table.entitySet === name && table.entitySetSource !== 'pluralized',
    );
    if (entity && !(report.tables ?? []).some((row) => row.logicalName === entity[0])) {
      const [logicalName, table] = entity;
      (report.tables ??= []).push({
        kind: 'table',
        logicalName,
        name: logicalName,
        entitySet: name,
        sourceFile: table.sources?.[0],
        sourceFiles: table.sources ?? [],
        fieldCount: Object.keys(table.fields ?? {}).length,
        evidence: 'web-api-source',
      });
    }
    if (entity) addTableColumns(entity[0], 'web-api-table-candidate');
    return {
      name,
      entity: entity?.[0] ?? null,
      sourceFile: entity?.[1].sources?.[0] ?? null,
      evidence: observedApiSets.has(name) ? 'observed-api-request' : 'static-reference',
    };
  });
  // A rendered custom grid may declare a table without issuing a Web API
  // request or sharing its enclosing form's table. Load that table's exported
  // definitions as context; the node observer separately verifies ownership.
  for (const entity of new Set((rendered.controls ?? []).map((row) => row.gridTable?.toLowerCase()))) {
    if (!/^[a-z][a-z0-9_]*$/.test(entity ?? '') || !metadata.entities?.[entity]) continue;
    const table = metadata.entities[entity];
    if (!(report.tables ?? []).some((row) => row.logicalName === entity))
      (report.tables ??= []).push({
        kind: 'table',
        logicalName: entity,
        name: entity,
        sourceFile: table.sources?.[0],
        sourceFiles: table.sources ?? [],
        fieldCount: Object.keys(table.fields ?? {}).length,
        evidence: 'rendered-grid-declaration',
      });
    addTableColumns(entity, 'declared-grid-table-candidate');
  }
  inspectCodeComponents(report, body, metadata, observed, codeCatalogue);
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
      relationshipName: row.relationshipName,
      parentPermissionId: row.parentPermissionId,
      sourceFile: row.provenance?.file,
      evidence: 'exported-rule',
      effective: live ? 'unknown' : 'local-session',
    }));
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
  report.logic = [
    ...(portal.serverLogics ?? [])
      .filter((row) => body.includes(row.name))
      .map((row) => ({ ...row, sourceFile: row.file, kind: 'server-logic', evidence: 'static-reference' })),
    ...(portal.cloudFlows ?? [])
      .filter(
        (row) =>
          (row.path && body.includes(row.path)) ||
          (row.processId && body.toLowerCase().includes(row.processId.toLowerCase())),
      )
      .map((row) => ({
        ...row,
        sourceFile: portal.records.find((record) => norm(record.id) === norm(row.id))?._file,
        kind: 'cloud-flow',
        evidence: 'static-reference',
      })),
    ...(metadata.plugins?.steps ?? [])
      .filter((step) => needed.has(step.entity))
      .map((step) => ({
        ...step,
        kind: 'plugin-step',
        evidence: 'exported-table-registration',
        effective: 'unknown',
        description: `${step.entity} ${step.message ?? 'Unknown message'} · ${step.stageName} · rank ${step.rank ?? 'unknown'} · ${step.mode === 0 ? 'synchronous' : step.mode === 1 ? 'asynchronous' : 'unknown execution mode'}${step.filteringAttributes.length ? ` · input attributes: ${step.filteringAttributes.join(', ')}` : ''} · ${step.enabled ? 'export enabled' : 'export disabled'} · live execution unknown`,
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
  report.unresolved = unique(report.unresolved ?? [], (row) => JSON.stringify(row));
  return report;
}

export function createSourceInspector(cfg) {
  let loading = null;
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
        const declared = [
          ...new Set((rendered.controls ?? []).slice(0, 300).map((row) => row.gridTable?.toLowerCase())),
        ].filter((name) => typeof name === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(name));
        if (sources.roots.length && declared.some((name) => !selected.metadata.entities?.[name])) {
          // Serialize admissions so concurrent selections cannot replace each
          // other's newly admitted definitions. Keep only exported tables, not
          // arbitrary page declarations, in the language's current catalogue.
          const admission = (selected.admission ?? Promise.resolve())
            .catch(() => {})
            .then(async () => {
              const missing = declared.filter((name) => !selected.metadata.entities?.[name]);
              if (!missing.length) return;
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
              if (!missing.some((name) => metadata.entities?.[name])) return;
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
        }
        return {
          ...selected,
          language,
          route: language ? pathname.slice(prefix.length + 1) || '/' : pathname,
          requestPath: pathname,
        };
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
      const { text: _text, file: _file, sourceDir: _root, ...sourceRef } = source;
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
      const { codeCatalogue } = await select(route, rendered);
      const index = await this.sourceIndexFor(route, report.portalProfile);
      const { portal, metadata } = index;
      const enriched = await remember('enrich:' + JSON.stringify([report, rendered]), () => {
        counters.enrichments++;
        return enrichInspection(structuredClone(report), portal, {
          metadata,
          rendered,
          observed: sources.observed,
          codeCatalogue,
          sourceIndexStore,
        });
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
        });
        const index = provenanceIndex(portal, metadata, codeCatalogue);
        report.portalSources = index.snapshot(report);
        report.sourceRevision = index.sourceRevision;
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
