import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { componentIdentity, componentContent } from '../../lense/portal-model.mjs';
import { portalField, effectiveSnippetRecords } from './importer.mjs';
import { createModelDrivenMetadataIndex } from '../../lense/model-driven-metadata.mjs';
import { readLocalFileSync, realLocalPath } from '../../lense/local-file.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const configurationGuards = new WeakMap();
const trustedProfileFiles = new WeakMap();
const norm = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const suffixes = {
  source: 'source.html',
  copy: 'copy.html',
  summary: 'summary.html',
  value: 'value.html',
  customcss: 'custom_css.css',
  customjavascript: 'custom_javascript.js',
};
const renderedFields = [
  ...Object.keys(suffixes),
  'name',
  'title',
  'description',
  'label',
  'instructions',
  'question',
  'validationregularexpressionerrormessage',
];
const localizedValues = (value) => {
  // Only a JSON array can be localized; skip parsing (and throwing on) markup.
  if (!/^[ \t\n\r]*\[/.test(value)) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.some((entry) => entry && Number.isSafeInteger(Number(entry.LCID)))
      ? parsed
      : null;
  } catch {
    return null;
  }
};

function sourceFieldOrigin(record, field, portal, fieldBodies) {
  if (Object.hasOwn(record?._fieldOrigins ?? {}, field)) return record._fieldOrigins[field];
  const profileFile = record?._profileSourceFiles?.[field],
    file = profileFile ?? record?._file;
  const value = Object.hasOwn(record?._profileFields ?? {}, field)
    ? record._profileFields[field]
    : portalField(record ?? {}, field);
  if (
    !profileFile &&
    !Object.hasOwn(record?._profileFields ?? {}, field) &&
    file &&
    /\.ya?ml$/i.test(file) &&
    suffixes[field]
  ) {
    const sidecar = file.replace(/\.ya?ml$/i, '.' + suffixes[field]);
    if (!fieldBodies.has(sidecar)) {
      try {
        // Most fields have no sidecar: one stat instead of a failing guarded read.
        fieldBodies.set(
          sidecar,
          fs.existsSync(sidecar)
            ? readLocalFileSync(sidecar, { root: portal.sourceDir, maxBytes: 8 * 1024 * 1024, encoding: 'utf8' })
            : null,
        );
      } catch {
        fieldBodies.set(sidecar, null);
      }
    }
    const body = fieldBodies.get(sidecar);
    if (body) return { value: body, file: sidecar, sidecar: true };
  }
  return { value, file, sidecar: false };
}

function addPortalSource(context, record, field, text, extra = {}) {
  if (typeof text !== 'string' || !record?.id) return null;
  const { portal, profileId, lcid, sources, records, identityDiagnostics } = context;
  const languageId =
    norm(portalField(record, 'contentsnippetlanguageid') ?? portalField(record, 'webpagelanguageid')) || null;
  const selectedProfile = extra.profileId ?? (record._profileSourceFiles?.[field] ? record._deploymentProfile : null);
  const origin = sourceFieldOrigin(record, field, portal, context.fieldBodies);
  const localized = origin.sidecar ? null : localizedValues(origin.value);
  if (localized && extra.lcid === undefined) {
    const selected = localized.findIndex((entry) => Number(entry?.LCID) === Number(lcid));
    const index = Math.max(0, selected);
    extra = { ...extra, lcid: Number(localized[index].LCID), jsonPath: [index, 'Value'] };
    if (text === origin.value) text = localized[index].Value;
  }
  if (typeof text !== 'string') return null;
  const selectedIdentityProfile = selectedProfile ?? profileId ?? null;
  const key = JSON.stringify([
    hash(String(portal.sourceDir ?? 'memory')),
    record.kind,
    norm(record.id),
    field,
    languageId,
    selectedIdentityProfile,
    extra.layer ?? null,
    extra.lcid ?? null,
  ]);
  const sourceFile = origin.file;
  const ref = {
    id: hash(key),
    key,
    kind: record.kind,
    recordId: norm(record.id),
    fieldPath: [field],
    languageId,
    profileId: selectedIdentityProfile,
    layer: extra.layer ?? null,
    contentRevision: hash(text),
    region: { start: 0, end: text.length, line: 1, column: 1 },
    file: sourceFile ?? null,
    sourceDir: portal.sourceDir,
    text,
    name: record.name ?? '',
    ...extra,
  };
  trustProfileSource(ref, selectedProfile, portal, sourceFile);
  reportDuplicateSource(ref, field, sources.get(ref.id), identityDiagnostics);
  sources.set(ref.id, ref);
  if (ref.lcid !== undefined) records.set(`${norm(record.id)}:${field}:lcid:${ref.lcid}`, ref);
  if (extra.lcid === undefined || Number(extra.lcid) === Number(lcid) || !records.has(`${norm(record.id)}:${field}`))
    records.set(`${norm(record.id)}:${field}`, ref);
  return ref;
}

function trustProfileSource(ref, selectedProfile, portal, sourceFile) {
  if (!selectedProfile || !portal.deploymentProfileFile || !sourceFile) return;
  if (path.resolve(sourceFile) === path.resolve(portal.deploymentProfileFile))
    trustedProfileFiles.set(ref, path.resolve(portal.deploymentProfileFile));
}

function reportDuplicateSource(ref, field, previous, identityDiagnostics) {
  if (
    previous?.ambiguous ||
    (previous &&
      (previous.file !== ref.file || (ref.lcid !== undefined && previous.jsonPath?.[0] !== ref.jsonPath?.[0])))
  ) {
    ref.ambiguous = true;
    identityDiagnostics.push({
      kind: 'source-identity',
      recordId: ref.recordId,
      field,
      reason: 'duplicate-source-identity',
    });
  }
}

function indexPortalRecords(portal, fieldOrigin, add) {
  for (const record of portal.records ?? []) indexPortalRecord(record, fieldOrigin, add);
}

function indexPortalRecord(record, fieldOrigin, add) {
  const configurationKind = {
    basicform: 'basic-form',
    advancedform: 'advanced-form',
    advancedformstep: 'advanced-form-step',
    list: 'list',
    pagetemplate: 'page-template',
  }[record.kind];
  if (configurationKind) {
    const text = JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('_'))));
    const ref = add(record, '$record', text, {
      componentKey: `${configurationKind}:${norm(record.id)}`,
      relationship: 'definition',
      semanticConfiguration: true,
      ...(record._deploymentProfile ? { profileId: record._deploymentProfile } : {}),
    });
    if (ref)
      configurationGuards.set(ref, {
        sourceRevision: record._sourceRevision,
        profiles: record._profileRevisions ?? {},
        unbacked: Object.keys(record._profileFields ?? {}).some((field) => !record._profileSourceFiles?.[field]),
      });
  }
  for (const field of renderedFields) addRenderedField(record, field, fieldOrigin, add);
}

function addRenderedField(record, field, fieldOrigin, add) {
  const origin = fieldOrigin(record, field),
    value = origin.value;
  if (typeof value !== 'string') return;
  const relation =
    record.kind === 'advancedformstep' && ['title', 'name'].includes(field)
      ? { componentKey: 'advanced-form-step:' + norm(record.id), relationship: 'label' }
      : {};
  const localized = origin.sidecar ? null : localizedValues(value);
  if (localized)
    localized.forEach((entry, index) =>
      add(record, field, entry.Value, { ...relation, lcid: Number(entry.LCID), jsonPath: [index, 'Value'] }),
    );
  else add(record, field, value, relation);
}

function indexTemplates(portal, add, templates) {
  for (const template of new Set(Object.values(portal.templates ?? {}))) {
    const ref = add(template.metadata ?? { kind: 'webtemplate', ...template }, 'source', template.source);
    if (!ref) continue;
    templates.set(norm(template.id), ref);
    templates.set(String(template.name).toLowerCase(), ref);
  }
}

function indexPageScripts(portal, add) {
  for (const component of [...(portal.forms ?? []), ...(portal.lists ?? [])])
    add(component.metadata, 'customjavascript', component.js);
  for (const step of (portal.records ?? []).filter((record) => record.kind === 'advancedformstep'))
    add(step, 'customjavascript', step.customJavascript);
  for (const page of portal.pages ?? [])
    for (const variant of [page, ...Object.values(page.translations ?? {})]) {
      const record = variant.metadata ?? page.metadata;
      for (const [property, field] of [
        ['html', 'copy'],
        ['css', 'customcss'],
        ['js', 'customjavascript'],
        ['summary', 'summary'],
      ])
        add(record, field, variant[property]);
    }
}

function indexSnippets(portal, language, fieldOrigin, add, records, snippets) {
  const effectiveSnippets = effectiveSnippetRecords(portal.records ?? [], language);
  for (const record of (portal.records ?? []).filter((r) => r.kind === 'contentsnippet')) {
    const value = fieldOrigin(record, 'value').value;
    const ref = add(record, 'value', typeof value === 'string' ? value : '');
    if (!ref) continue;
    const selected = add(record, 'value', ref.text);
    if (effectiveSnippets.get(String(record.name).toLowerCase()) !== record) continue;
    snippets.set(String(record.name).toLowerCase(), selected);
    if (record._originalName) snippets.set(record._originalName.toLowerCase(), selected);
  }
  for (const [name, record] of effectiveSnippets) snippets.set(name, records.get(`${norm(record.id)}:value`));
  return effectiveSnippets;
}

function indexComponentSchemas(metadata, add) {
  for (const [name, schema] of Object.entries(metadata.componentSchemas ?? {})) {
    if (!schema || typeof schema !== 'object') continue;
    const record = { kind: 'component', id: schema.id ?? name, name, _file: schema.file ?? schema.sourceFile };
    if (typeof schema.xml === 'string') add(record, 'definition', schema.xml);
  }
}

function indexWebFiles(portal, add) {
  const diagnostics = [];
  for (const resource of portal.webFiles ?? []) {
    if (!indexableWebFile(resource)) continue;
    try {
      const bytes = readLocalFileSync(resource.file, { root: portal.sourceDir, maxBytes: 8 * 1024 * 1024 });
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      add(
        resource.metadata ?? { id: resource.id, kind: 'webfile', name: resource.name, _file: resource.file },
        '$content',
        text,
        {
          file: resource.file,
          kind: 'webfile',
          componentKey: `web-file:${norm(resource.id)}`,
          relationship: 'implementation',
          rawBytes: true,
          url: resource.url,
        },
      );
    } catch {
      diagnostics.push({
        kind: 'resource',
        recordId: norm(resource.id),
        reason: 'resource-unreadable-or-over-limit',
      });
    }
  }
  return diagnostics;
}

function indexableWebFile(resource) {
  return Boolean(
    resource.file &&
    resource.id &&
    (/\.(?:[cm]?js|css|html?|svg|json|xml|txt)$/i.test(resource.file) ||
      /^(?:text\/|application\/(?:javascript|ecmascript|json|xml)|image\/svg\+xml)/i.test(resource.mimeType ?? '')),
  );
}

function portalSourceRevision(sourceRevision, portal, profileId, sources) {
  return (
    sourceRevision ??
    hash(
      JSON.stringify([
        portal.deploymentProfile ?? profileId ?? null,
        [...sources.values()]
          .filter((source) => source.kind !== 'component')
          .map((s) => s.key + ':' + s.contentRevision)
          .sort((left, right) => Number(left > right) - Number(left < right)),
        (portal.records ?? [])
          .map((record) => Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('_'))))
          .sort((a, b) => (String(a.kind) + String(a.id) < String(b.kind) + String(b.id) ? -1 : 1)),
      ]),
    )
  );
}

function updateSourceEditorRefs(sources, revision, portal) {
  const editorCache = new Map();
  for (const source of sources.values()) {
    source.sourceRevision = revision;
    const target = sourceEditorTarget(source, source.region, editorCache);
    if (target)
      source.ref = target.externalProfile
        ? '_profiles/' + hash(target.file).slice(0, 24) + '/' + path.basename(target.file)
        : path.relative(portal.sourceDir, target.file).replaceAll('\\', '/');
  }
}

function componentSourceKeys(metadata, pcf) {
  const componentKeys = [];
  for (const [entity, table] of Object.entries(metadata.entities ?? {})) {
    componentKeys.push(`table:${entity}`);
    for (const field of Object.keys(table.fields ?? {})) componentKeys.push(`column:${entity}:${field}`);
  }
  for (const form of metadata.forms ?? []) componentKeys.push(`form:${norm(form.id)}`);
  for (const view of metadata.views ?? []) componentKeys.push(`view:${norm(view.id)}`);
  for (const control of pcf?.controls ?? []) componentKeys.push('pcf:' + control.name.toLowerCase());
  return componentKeys;
}

function collectSnapshotReferences(value, depth, references) {
  if (!value || typeof value !== 'object' || depth > 10) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotReferences(item, depth + 1, references);
    return;
  }
  collectSnapshotFields(value, references);
  for (const [key, child] of Object.entries(value))
    if (key !== 'portalSources') collectSnapshotReferences(child, depth + 1, references);
}

function collectSnapshotFields(value, { files, ids, componentKeys, refIds }) {
  for (const key of ['file', 'sourceFile', 'path'])
    if (typeof value[key] === 'string') files.add(value[key].toLowerCase());
  for (const key of ['id', 'recordId', 'formId', 'viewId', 'systemFormId'])
    if (typeof value[key] === 'string') ids.add(norm(value[key]));
  if (value.componentKey) componentKeys.add(value.componentKey);
  if (typeof value.schemaName === 'string') componentKeys.add('pcf:' + value.schemaName.toLowerCase());
  if (value.sourceRefId) refIds.add(value.sourceRefId);
  if (typeof value.logicalName === 'string') componentKeys.add('table:' + norm(value.logicalName));
  if (value.entity && (value.field ?? value.name))
    componentKeys.add(`column:${norm(value.entity)}:${norm(value.field ?? value.name)}`);
}

function addFormSourceRefs(ids, refIds, sources, metadataIndex, portal) {
  for (const id of ids) {
    const key = 'form:' + id;
    if (!metadataIndex.component(key)) continue;
    for (const ref of metadataIndex.sourceRefsForForm(key)) {
      sources.set(ref.id, { ...ref, file: ref.ref, sourceDir: portal.sourceDir });
      refIds.add(ref.id);
    }
  }
}

function sourceFileRecords(sources) {
  const fileRecords = new Map();
  for (const source of sources.values())
    if (source.file) {
      const key = source.file.toLowerCase();
      if (!fileRecords.has(key)) fileRecords.set(key, new Set());
      fileRecords.get(key).add(source.recordId ?? source.id);
    }
  return fileRecords;
}

function includeSnapshotSource(source, report, refIds, componentKeys, ids, files, fileRecords) {
  if (!report || refIds.has(source.id)) return true;
  if (source.componentKey?.startsWith('column:')) return componentKeys.has(source.componentKey);
  return (
    componentKeys.has(source.componentKey) ||
    ids.has(source.recordId) ||
    (source.file && files.has(source.file.toLowerCase()) && fileRecords.get(source.file.toLowerCase()).size === 1)
  );
}

function portalSourceSnapshot({ report, sources, metadataIndex, portal }) {
  const files = new Set(),
    ids = new Set(),
    componentKeys = new Set(),
    refIds = new Set();
  if (report) collectSnapshotReferences(report, 0, { files, ids, componentKeys, refIds });
  if (report) addFormSourceRefs(ids, refIds, sources, metadataIndex, portal);
  const fileRecords = sourceFileRecords(sources);
  return [...sources.values()]
    .filter((source) => !source.ambiguous)
    .filter((source) => includeSnapshotSource(source, report, refIds, componentKeys, ids, files, fileRecords))
    .map(({ text: _text, file, sourceDir: _root, ...ref }) => ({ ...ref, ...(file ? { sourceFile: file } : {}) }));
}

/** Effective exported identities. Paths and array positions are locators, never record identity. */
export function buildPortalSourceIndex({
  portal,
  metadata = {},
  codeCatalogue,
  sourceRevision,
  languageId,
  profileId,
} = {}) {
  const sources = new Map(),
    records = new Map(),
    snippets = new Map(),
    templates = new Map();
  const identityDiagnostics = [];
  const language = norm(
    languageId ?? portal.selectedLanguageId ?? portalField(portal.website ?? {}, 'defaultlanguage'),
  );
  const lcid = portal.selectedLcid ?? 1033;
  const fieldBodies = new Map();
  const addContext = { portal, profileId, lcid, sources, records, identityDiagnostics, fieldBodies };
  const fieldOrigin = (record, field) => sourceFieldOrigin(record, field, portal, fieldBodies);
  const add = (record, field, text, extra = {}) => addPortalSource(addContext, record, field, text, extra);
  indexPortalRecords(portal, fieldOrigin, add);
  indexTemplates(portal, add, templates);
  indexPageScripts(portal, add);
  const effectiveSnippets = indexSnippets(portal, language, fieldOrigin, add, records, snippets);
  indexComponentSchemas(metadata, add);
  const resourceDiagnostics = indexWebFiles(portal, add);
  const revision = portalSourceRevision(sourceRevision, portal, profileId, sources);
  updateSourceEditorRefs(sources, revision, portal);
  const pcf = codeCatalogue
    ? {
        controls: [...codeCatalogue.controls].map(([name, control]) => ({
          ...control,
          name,
          resources: {
            code: (control.resources ?? [])
              .filter((resource) => resource.kind === 'code')
              .map((resource) => resource.url),
            css: (control.resources ?? [])
              .filter((resource) => resource.kind === 'css')
              .map((resource) => resource.url),
          },
        })),
      }
    : undefined;
  const metadataIndex = createModelDrivenMetadataIndex(
    { metadata, pcf, assets: codeCatalogue?.assets },
    { sourceRevision: revision },
  );
  const componentKeys = componentSourceKeys(metadata, pcf);
  for (const ref of metadataIndex.sourceRefsFor(componentKeys))
    sources.set(ref.id, { ...ref, file: ref.ref, sourceDir: portal.sourceDir });
  return {
    sourceRevision: revision,
    sources,
    records,
    snippets,
    templates,
    metadataIndex,
    languageId: language,
    snippet(name) {
      const record = effectiveSnippets.resolve(name);
      return record ? (records.get(`${norm(record.id)}:value`) ?? null) : null;
    },
    source(record, field, selection = {}) {
      return (
        records.get(`${norm(record?.id)}:${field}` + (selection.lcid === undefined ? '' : `:lcid:${selection.lcid}`)) ??
        null
      );
    },
    snapshot(report = null) {
      return portalSourceSnapshot({ report, sources, metadataIndex, portal });
    },
    diagnostics: [...identityDiagnostics, ...resourceDiagnostics],
    portal,
    metadata,
  };
}

// One index build resolves each root/file once. Windows realpath costs one
// lstat per path component, and a JSON-array export shares one file per row.
const realpathCaches = new WeakMap();
const cachedRealpath = (value, cache) => {
  if (!cache) return realLocalPath(value);
  let paths = realpathCaches.get(cache);
  if (!paths) {
    paths = new Map();
    realpathCaches.set(cache, paths);
  }
  if (!paths.has(value)) paths.set(value, realLocalPath(value));
  return paths.get(value);
};

// Line of `offset` (CRLF, CR and LF each end one line) and the position of the
// last line-break character before it. Breaks are indexed once per snapshot
// text, so every row of a shared export file costs a binary search, not a rescan.
const textPosition = (snapshot, text, offset) => {
  const key = text === snapshot.bytes ? 'rawBreaks' : 'normalizedBreaks';
  const breaks = (snapshot[key] ??= Array.from(text.matchAll(/\r\n|\r|\n/g), (match) => [
    match.index,
    match.index + match[0].length,
  ]));
  let low = 0,
    high = breaks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (breaks[middle][0] < offset) low = middle + 1;
    else high = middle;
  }
  return { line: low + 1, last: low ? Math.min(breaks[low - 1][1], offset) - 1 : -1 };
};

function sourceContainerTarget(source, file, snapshot, text, externalProfile) {
  const located = loadChangedSourceRecord(source, file, snapshot, text);
  if (!located || !matchesChangedSource(source, located.record)) return null;
  const astTarget = yamlAstSourceTarget(source, snapshot, text, located.primary, externalProfile, file);
  return (
    astTarget ?? {
      file,
      line: 1,
      column: 1,
      mapped: false,
      container: true,
      ...(externalProfile ? { externalProfile: true } : {}),
    }
  );
}

function loadChangedSourceRecord(source, file, snapshot, text) {
  const primary =
    {
      basicform: 'entityform',
      basicformmetadata: 'entityformmetadata',
      advancedform: 'webform',
      advancedformstep: 'webformstep',
      advancedformmetadata: 'webformmetadata',
      list: 'entitylist',
      tablepermission: 'entitypermission',
    }[source.kind] ?? source.kind;
  if (/\.(?:ya?ml|json)$/i.test(file)) return loadChangedStructuredRecord(source, file, snapshot, text, primary);
  if (!/\.xml$/i.test(file)) return null;
  if (componentIdentity(text) !== source.recordId) return null;
  return { record: componentContent(text), primary };
}

function loadChangedStructuredRecord(source, file, snapshot, text, primary) {
  let parsed;
  if (/\.json$/i.test(file)) parsed = snapshot.json ??= JSON.parse(text);
  else {
    if (!snapshot.document) snapshot.document = YAML.parseDocument(text, { keepSourceTokens: true });
    if (snapshot.document.errors.length) return null;
    parsed = snapshot.yaml ??= snapshot.document.toJS();
  }
  const profileTable = (key) =>
    [primary, source.kind].includes(
      String(key)
        .replace(/^(?:adx|mspp)_/i, '')
        .toLowerCase(),
    );
  let rows;
  if (Array.isArray(parsed)) rows = parsed;
  else if (source.profileId && !norm(parsed?.id ?? portalField(parsed ?? {}, primary + 'id')))
    rows = Object.entries(parsed ?? {})
      .filter(([key]) => profileTable(key))
      .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
  else rows = [parsed];
  if (!snapshot.rows.has(primary)) snapshot.rows.set(primary, indexStructuredRows(rows, primary));
  const matches = snapshot.rows.get(primary).get(source.recordId) ?? [];
  if (matches.length !== 1) return null;
  return { record: matches[0], primary };
}

function indexStructuredRows(rows, primary) {
  const identities = new Map();
  for (const row of rows)
    if (row && typeof row === 'object') {
      const id = norm(row.id ?? portalField(row, primary + 'id'));
      if (!identities.has(id)) identities.set(id, []);
      identities.get(id).push(row);
    }
  return identities;
}

function matchesChangedSource(source, record) {
  if (!record) return false;
  if (source.languageId) {
    const language = norm(
      portalField(record, source.kind === 'contentsnippet' ? 'contentsnippetlanguageid' : 'webpagelanguageid'),
    );
    if (language !== source.languageId && (!source.profileId || language)) return false;
  }
  if (source.semanticConfiguration) return true;
  let value = portalField(record, source.fieldPath.at(-1));
  if (source.lcid !== undefined) {
    const rows = localizedValues(value)?.filter((entry) => Number(entry?.LCID) === Number(source.lcid));
    if (rows?.length !== 1) return false;
    value = rows[0].Value;
  }
  return typeof value === 'string' && hash(value) === source.contentRevision;
}

function yamlAstSourceTarget(source, snapshot, text, primary, externalProfile, file) {
  if (!snapshot.document) return null;
  snapshot.astRecords ??= new Map();
  if (!snapshot.astRecords.has(primary)) snapshot.astRecords.set(primary, indexYamlRecords(source, snapshot, primary));
  const matches = snapshot.astRecords.get(primary).get(source.recordId) ?? [];
  if (matches.length !== 1) return null;
  const field = source.fieldPath.at(-1);
  const node = source.semanticConfiguration
    ? matches[0]
    : matches[0].items.find((pair) => [field, 'adx_' + field, 'mspp_' + field].includes(pair.key?.value))?.value;
  if (!node?.range) return null;
  const { line, last } = textPosition(snapshot, text, node.range[0]);
  return {
    file,
    line,
    column: node.range[0] - last,
    mapped: false,
    container: true,
    ...(externalProfile ? { externalProfile: true } : {}),
  };
}

function indexYamlRecords(source, snapshot, primary) {
  const maps = new Map();
  const scopedProfile =
    source.profileId && !norm(snapshot.yaml?.id ?? portalField(snapshot.yaml ?? {}, primary + 'id'));
  const roots = scopedProfile
    ? (snapshot.document.contents?.items ?? [])
        .filter((pair) => yamlProfileTable(pair.key?.value, primary, source.kind))
        .map((pair) => pair.value)
    : [snapshot.document];
  for (const root of roots)
    YAML.visit(root, {
      Map(_key, node) {
        const pair = node.items.find((pair) =>
          ['id', primary + 'id', 'adx_' + primary + 'id', 'mspp_' + primary + 'id'].includes(pair.key?.value),
        );
        const id = norm(pair?.value?.value);
        if (!id) return;
        if (!maps.has(id)) maps.set(id, []);
        maps.get(id).push(node);
      },
    });
  return maps;
}

function yamlProfileTable(key, primary, kind) {
  return [primary, kind].includes(
    String(key)
      .replace(/^(?:adx|mspp)_/i, '')
      .toLowerCase(),
  );
}

function configurationRevisionMatches(source, rawRevision) {
  const guard = configurationGuards.get(source);
  if (!guard?.sourceRevision || guard.unbacked || rawRevision !== guard.sourceRevision) return false;
  for (const [profile, revision] of Object.entries(guard.profiles))
    if (hash(readLocalFileSync(profile, { maxBytes: 8 * 1024 * 1024, encoding: 'utf8' })) !== revision) return false;
  return true;
}

function sourceSnapshotText(snapshot, source, bytes, rawRevision) {
  let text;
  if (source.rawBytes || rawRevision === source.contentRevision) text = bytes;
  else {
    if (snapshot.normalizedText == null) snapshot.normalizedText = bytes.replace(/^\uFEFF/, '');
    text = snapshot.normalizedText;
  }
  let revision;
  if (text === bytes) revision = rawRevision;
  else {
    if (snapshot.normalizedRevision == null) snapshot.normalizedRevision = hash(text);
    revision = snapshot.normalizedRevision;
  }
  return { text, revision };
}

/** Recompute a physical location only for an actual unchanged standalone source file. */
export function sourceEditorTarget(source, region = source.region, cache = null) {
  if (!source.file || !source.sourceDir) return null;
  try {
    const root = cachedRealpath(source.sourceDir, cache),
      file = cachedRealpath(source.file, cache);
    const relative = path.relative(root, file);
    const outside = !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
    const externalProfile = outside && trustedProfileFiles.get(source) === file;
    if (outside && !externalProfile) return null;
    let snapshot = cache?.get(file);
    if (!snapshot) {
      snapshot = {
        bytes: readLocalFileSync(file, {
          root: externalProfile ? path.dirname(file) : root,
          maxBytes: 8 * 1024 * 1024,
          encoding: 'utf8',
        }),
        rows: new Map(),
      };
      cache?.set(file, snapshot);
    }
    const bytes = snapshot.bytes;
    const rawRevision = (snapshot.rawRevision ??= hash(bytes));
    if (source.semanticConfiguration && !configurationRevisionMatches(source, rawRevision)) return null;
    const { text, revision } = sourceSnapshotText(snapshot, source, bytes, rawRevision);
    if (revision !== source.contentRevision)
      return sourceContainerTarget(source, file, snapshot, text, externalProfile);
    const start = Math.min(text.length, Math.max(0, region?.start ?? 0));
    const { line, last } = textPosition(snapshot, text, start);
    return {
      file,
      line,
      column: Math.max(1, start - last - (line === 1 && text.startsWith('\uFEFF') ? 1 : 0)),
      mapped: true,
      ...(externalProfile ? { externalProfile: true } : {}),
    };
  } catch {
    return null;
  }
}
