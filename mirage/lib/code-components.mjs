import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from '../../lense/local-file.mjs';
import { orderedMap } from '../../lense/async-map.mjs';
import { createHash } from 'node:crypto';
import { parseSolutionXml, descendants, childText } from './solution-xml.mjs';
import { portalLanguage } from './portal-languages.mjs';
import { pcfAdmission } from './model-driven/pcf-runtime.mjs';

/** The one PCF admission rule of the Power Pages and model-driven hosts (control type, dataset, platform libraries). */
export { pcfAdmission };

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const json = (value) => JSON.stringify(value).replaceAll('<', String.raw`\u003c`);
const contained = (root, file) => {
  const rel = path.relative(root, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
const pcfTypes = {
  nvarchar: 'SingleLine.Text',
  ntext: 'Multiple',
  uniqueidentifier: 'SingleLine.Text',
  primarykey: 'SingleLine.Text',
  int: 'Whole.None',
  integer: 'Whole.None',
  bigint: 'Whole.None',
  decimal: 'Decimal',
  float: 'FP',
  money: 'Currency',
  datetime: 'DateAndTime.DateAndTime',
  bit: 'TwoOptions',
  picklist: 'OptionSet',
  state: 'OptionSet',
  status: 'OptionSet',
  multiselectpicklist: 'MultiSelectOptionSet',
  lookup: 'Lookup.Simple',
  owner: 'Lookup.Simple',
};

// Classic SDK bundles start with an optional block-comment header and a single
// uninitialized var. Advance monotonically: repeating comments/whitespace in a
// regular expression can revisit the same resource prefix many times.
function classicExportGlobal(source) {
  let offset = 0;
  const whitespace = () => {
    const start = offset;
    while (offset < source.length && /\s/.test(source[offset])) offset++;
    return offset > start;
  };
  for (;;) {
    whitespace();
    if (!source.startsWith('/*', offset)) break;
    const end = source.indexOf('*/', offset + 2);
    if (end < 0) return undefined;
    offset = end + 2;
  }
  if (!source.startsWith('var', offset)) return undefined;
  offset += 3;
  if (!whitespace() || !/[A-Za-z_$]/.test(source[offset] ?? '')) return undefined;
  const start = offset++;
  while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset])) offset++;
  const name = source.slice(start, offset);
  whitespace();
  return source[offset] === ';' ? name : undefined;
}

// Declaration eligibility is a Power Pages contract, independent of whether a
// local facade implements the requested API. Keep source attributes untouched.
function featureEligibility(features = []) {
  return features.map((feature) => {
    const requiredValue = typeof feature.required === 'string' ? feature.required.trim() : feature.required;
    const required = requiredValue === 'true' || requiredValue === '1';
    const valid =
      typeof feature.name === 'string' &&
      Boolean(feature.name.trim()) &&
      ['true', 'false', '1', '0'].includes(requiredValue);
    let hostApiAvailable;
    if (feature.name === 'WebAPI') hostApiAvailable = true;
    else if (feature.name === 'Utility' || /^(?:Device|device)\./.test(feature.name ?? '')) hostApiAvailable = false;
    else hostApiAvailable = null;
    let reason = {};
    if (!valid) reason = { reason: 'PCF_FEATURE_DECLARATION_INVALID' };
    else if (required) reason = { reason: 'PCF_PORTAL_REQUIRED_FEATURE_UNSUPPORTED' };
    return {
      ...feature,
      hostApiAvailable,
      eligible: valid && !required,
      ...reason,
    };
  });
}

/* NOSONAR: mixed return values are part of the contract */ function languageLcid(language) {
  if (Number.isInteger(Number(language?.lcid)) && Number(language.lcid) > 0) return Number(language.lcid);
  return portalLanguage({ name: language?.code })?.lcid ?? null;
}

function localizedResourceGroups(resources) {
  const groups = new Map();
  for (const resource of resources) {
    if (!resource.lcid) continue;
    if (!groups.has(resource.group)) groups.set(resource.group, []);
    groups.get(resource.group).push(resource);
  }
  return groups;
}

function localizedResourceCandidate(group, variants, selectedLcid, defaultLcid, diagnostic) {
  let candidates = variants.filter((resource) => resource.lcid === selectedLcid);
  let selection = 'selected-language';
  if (!candidates.length && defaultLcid) {
    candidates = variants.filter((resource) => resource.lcid === defaultLcid);
    selection = 'website-default-language';
  }
  if (candidates.length !== 1) {
    diagnostic?.({
      code: candidates.length ? 'PCF_RESOURCE_LANGUAGE_AMBIGUOUS' : 'PCF_RESOURCE_LANGUAGE_UNRESOLVED',
      group,
      selectedLcid,
      defaultLcid,
      paths: candidates.map((resource) => resource.path),
    });
    return null;
  }
  const resource = candidates[0];
  if (selection === 'website-default-language')
    diagnostic?.({
      code: 'PCF_RESOURCE_LANGUAGE_FALLBACK',
      group,
      selectedLcid,
      selectedResourceLcid: resource.lcid,
      policy: 'exported-website-default',
      nativeQualified: false,
    });
  return { resource, selection };
}

function mergeLocalizedEntries(strings, ambiguousKeys, resource) {
  for (const [key, value] of Object.entries(resource.strings)) {
    if (Object.hasOwn(strings, key)) ambiguousKeys.add(key);
    else strings[key] = value;
  }
}

function localizedStrings(control, selectedLanguage, defaultLanguage, diagnostic) {
  if (!control.stringResources) return { strings: control.strings ?? {}, localization: null };
  const selectedLcid = languageLcid(selectedLanguage),
    defaultLcid = languageLcid(defaultLanguage);
  const strings = Object.create(null),
    selectedResources = [],
    ambiguousKeys = new Set();
  const groups = localizedResourceGroups(control.stringResources);
  for (const [group, variants] of groups) {
    const selected = localizedResourceCandidate(group, variants, selectedLcid, defaultLcid, diagnostic);
    if (!selected) continue;
    const { resource, selection } = selected;
    selectedResources.push({ path: resource.path, lcid: resource.lcid, selection, attributes: resource.attributes });
    mergeLocalizedEntries(strings, ambiguousKeys, resource);
  }
  for (const key of ambiguousKeys) {
    delete strings[key];
    diagnostic?.({ code: 'PCF_RESOURCE_KEY_AMBIGUOUS', key });
  }
  return { strings, localization: { selectedLcid, defaultLcid, resources: selectedResources } };
}

function componentDatasetView(dataset, binding, metadata) {
  const candidates = (metadata.views ?? []).filter(
    (view) => canonical(view.id) === canonical(binding) || canonical(view.name) === canonical(binding),
  );
  if (candidates.length > 1)
    return { error: `Dataset ${dataset.name} matches multiple exported views. Bind its exported view ID.` };
  const view = candidates[0];
  return { view, entity: view?.entity ?? canonical(binding) };
}

function componentDatasetColumns(dataset, view, fields, mapping) {
  const names = view?.fields?.length
    ? view.fields.map((field) => field.name)
    : Object.keys(fields).filter((name) => fields[name].validForRead !== false);
  if (!names.includes(mapping.idColumn)) names.unshift(mapping.idColumn);
  if (
    !names.length ||
    !names.every((name) => /^[a-z_][a-z\d_]*$/i.test(name) && (fields[name] || name === mapping.idColumn))
  )
    return {
      error: `Dataset ${dataset.name} has an aliased or unresolved column binding. Only exported columns of its primary table are supported.`,
    };
  return { names };
}

function componentDatasetFetchError(dataset, view) {
  if (!view?.fetchXml) return null;
  try {
    const fetch = parseSolutionXml(view.fetchXml);
    if (
      fetch.attrs.aggregate === 'true' ||
      fetch.attrs.top != null ||
      descendants(fetch, 'attribute').some((node) => node.attrs.alias)
    )
      return `Dataset ${dataset.name} requires unsupported aggregate, top-limited, or aliased view semantics.`;
  } catch {
    return `Dataset ${dataset.name} has malformed exported FetchXML.`;
  }
  return null;
}

function resolveComponentDataset(dataset, { args, metadata, mappings, schema }) {
  const failure = (error) => ({ error });
  const binding = args[dataset.name] ?? args[dataset.name.toLowerCase()];
  if (typeof binding !== 'string' || !binding.trim())
    return failure(
      `Code component ${schema} requires a dataset binding to an exported table and view: set the ${dataset.name} tag argument to an exported view ID or table logical name.`,
    );
  const selectedView = componentDatasetView(dataset, binding, metadata);
  if (selectedView.error) return failure(selectedView.error);
  const { view, entity } = selectedView;
  const table = metadata.entities?.[entity],
    mapping = mappings[entity];
  if (!table || !mapping?.entitySet || !mapping?.idColumn)
    return failure(`Dataset ${dataset.name} has no exported table definition and exact Web API mapping for ${entity}.`);
  const fields = table.fields ?? {};
  const selectedColumns = componentDatasetColumns(dataset, view, fields, mapping);
  if (selectedColumns.error) return failure(selectedColumns.error);
  const { names } = selectedColumns;
  const fetchError = componentDatasetFetchError(dataset, view);
  if (fetchError) return failure(fetchError);
  const columns = names.map((name, order) => ({
    name,
    displayName: fields[name]?.label ?? name,
    dataType: pcfTypes[fields[name]?.dataverseType] ?? 'unknown',
    order,
    visualSizeFactor: view?.fields?.find((field) => field.name === name)?.width ?? 100,
    targets: fields[name]?.targets,
  }));
  const attributeXml = (name) => `<attribute name="${escape(name)}"/>`;
  const fetchXmlFor = (entityName) =>
    `<fetch><entity name="${escape(entityName)}">${names.map(attributeXml).join('')}</entity></fetch>`;
  return {
    dataset: {
      name: dataset.name,
      entity,
      entitySet: mapping.entitySet,
      idColumn: mapping.idColumn,
      nameColumn: mapping.nameColumn ?? table.primaryNameAttribute,
      viewId: view?.id ?? null,
      viewName: view?.name ?? entity,
      columns,
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          {
            label: field.label,
            dataverseType: field.dataverseType,
            dataType: pcfTypes[field.dataverseType],
            targets: field.targets,
          },
        ]),
      ),
      fetchXml: view?.fetchXml || fetchXmlFor(entity),
    },
  };
}

const admittedFiles = new WeakMap();
const resourceKinds = new Set(['code', 'css', 'resx', 'img']);
const resourceLimit = 8 * 1024 * 1024;
const attempt = async (task) => {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error };
  }
};

/** Bytes that a catalogue import retained for its controls (`retainBytes`), handed once to the caller that asked for them. */
export function takeAdmittedFiles(controls) {
  const admitted = admittedFiles.get(controls) ?? new Map();
  admittedFiles.delete(controls);
  return admitted;
}

async function readIdentity({ root, identityFile, readFile, admitted }) {
  const metadataFile = await fs.realpath(identityFile);
  if (!contained(root, metadataFile) || (await fs.stat(metadataFile)).size > 1024 * 1024)
    throw new Error('PCF identity metadata is outside its control or exceeds 1 MiB');
  const bytes = await readFile(metadataFile, { root, maxBytes: 1024 * 1024 });
  const schemaName = childText(parseSolutionXml(bytes.toString('utf8')), 'Name');
  if (!schemaName || !/^[\w.]+$/.test(schemaName)) throw new Error('PCF identity metadata has no valid exported Name');
  admitted.set(identityFile, bytes);
  return schemaName;
}

function stringResourceOf({ file, relative, resource, body, diagnostics }) {
  const document = parseSolutionXml(body.toString('utf8'));
  const entries = descendants(document, 'data');
  const strings = Object.create(null),
    duplicates = new Set();
  for (const entry of entries) {
    const key = entry.attrs.name;
    if (!key) {
      diagnostics.push({ code: 'PCF_RESOURCE_KEY_UNRESOLVED', file, message: 'RESX data entry has no name.' });
      continue;
    }
    if (Object.hasOwn(strings, key)) duplicates.add(key);
    else strings[key] = entry.children.find((node) => node.name === 'value')?.text ?? '';
  }
  for (const key of duplicates) {
    delete strings[key];
    diagnostics.push({
      code: 'PCF_RESOURCE_KEY_AMBIGUOUS',
      file,
      key,
      message: 'RESX resource contains duplicate named data entries.',
    });
  }
  const locale = /^(.*)\.(\d+)\.resx$/i.exec(relative);
  const lcid = locale && Number.isSafeInteger(Number(locale[2])) && Number(locale[2]) > 0 ? Number(locale[2]) : null;
  if (!lcid)
    diagnostics.push({
      code: 'PCF_RESOURCE_LANGUAGE_UNRESOLVED',
      file,
      message: 'RESX resource has no documented positive LCID filename suffix.',
    });
  return {
    path: relative,
    group: locale?.[1] ?? relative,
    lcid,
    attributes: { ...resource.attrs },
    document,
    entries,
    strings,
  };
}

// Phase one: every path and containment check of a declared resource, without reading its body.
async function checkResource(root, resource) {
  const relative = resource.attrs.path;
  if (!relative || /[\\?#]/.test(relative)) throw new Error('Declared PCF resource has an invalid path');
  const file = await fs.realpath(path.resolve(root, relative)).catch(() => null);
  if (!file || !contained(root, file) || (await fs.stat(file)).size > resourceLimit)
    throw new Error('Declared PCF resource is missing, outside its control, or exceeds 8 MiB');
  return file;
}

// Checks run for every declaration; bodies are read only up to the first failed check, as the serial reading did.
// The fold then applies declaration order, so the first failure decides the error and the diagnostics before it.
async function readDeclaredResources({ root, token, declared, readFile, admitted, digest, diagnostics }) {
  const checks = await orderedMap(declared, 16, (resource) => attempt(() => checkResource(root, resource)));
  const failed = checks.findIndex((check) => !check.ok);
  const readable = checks.slice(0, failed < 0 ? checks.length : failed);
  const bodies = await orderedMap(readable, 16, (check) =>
    attempt(() => readFile(check.value, { root, maxBytes: resourceLimit })),
  );
  const resources = [],
    stringResources = [],
    declaredAssets = new Map();
  for (const [index, resource] of declared.entries()) {
    if (!checks[index].ok) throw checks[index].error;
    if (!bodies[index].ok) throw bodies[index].error;
    const file = checks[index].value;
    const body = bodies[index].value;
    const relative = resource.attrs.path;
    const url = `/__sim-static/pcf/${token}/${relative.split('/').map(encodeURIComponent).join('/')}`;
    digest.update(relative).update(body);
    declaredAssets.set(url, {
      file,
      root,
      kind: resource.name,
      contentRevision: createHash('sha256').update(body).digest('hex'),
    });
    admitted.set(file, body);
    // SDK bundles can export their constructor through a classic script
    // module rather than a namespace or registerControl call. Bind only
    // a declaration from this exact declared resource, never scan globals.
    const exportGlobal = resource.name === 'code' ? classicExportGlobal(body.toString('utf8')) : undefined;
    resources.push({
      kind: resource.name,
      path: relative,
      url,
      order: Number(resource.attrs.order) || 0,
      attributes: { ...resource.attrs },
      ...(exportGlobal ? { exportGlobal } : {}),
    });
    if (resource.name === 'resx')
      stringResources.push(stringResourceOf({ file, relative, resource, body, diagnostics }));
  }
  return { resources, stringResources, declaredAssets };
}

function controlProperties(control) {
  const typeGroups = Object.fromEntries(
    descendants(control, 'type-group').map((group) => [
      group.attrs.name,
      group.children.filter((node) => node.name === 'type').map((node) => node.text.trim()),
    ]),
  );
  return descendants(control, 'property').map((property) => ({
    ...property.attrs,
    types: typeGroups[property.attrs['of-type-group']],
  }));
}

async function readManifestControl({ root, manifestFile, readFile, schemaName, admitted, diagnostics }) {
  if (!contained(root, await fs.realpath(manifestFile)) || (await fs.stat(manifestFile)).size > 1024 * 1024)
    throw new Error('PCF manifest is outside its control or exceeds 1 MiB');
  const bytes = await readFile(manifestFile, { root, maxBytes: 1024 * 1024 });
  const manifest = bytes.toString('utf8');
  admitted.set(manifestFile, bytes);
  const control = descendants(parseSolutionXml(manifest), 'control')[0];
  if (!control) throw new Error('PCF manifest has no control declaration');
  const token = createHash('sha256').update(root).update(manifest).digest('hex').slice(0, 24);
  const digest = createHash('sha256').update(manifest);
  const libraries = [],
    declared = [];
  for (const resource of descendants(control, 'resources')[0]?.children ?? []) {
    if (resource.name === 'platform-library') libraries.push({ ...resource.attrs });
    else if (resourceKinds.has(resource.name)) declared.push(resource);
  }
  const { resources, stringResources, declaredAssets } = await readDeclaredResources({
    root,
    token,
    declared,
    readFile,
    admitted,
    digest,
    diagnostics,
  });
  if (!resources.some((resource) => resource.kind === 'code'))
    throw new Error('PCF manifest does not declare an executable code resource');
  const record = {
    schemaName,
    constructor: `${control.attrs.namespace}.${control.attrs.constructor}`,
    type: control.attrs['control-type'],
    dataset: descendants(control, 'data-set').length > 0,
    datasets: descendants(control, 'data-set').map((node) => ({ ...node.attrs })),
    properties: controlProperties(control),
    events: (control.children ?? []).filter((node) => node.name === 'event').map((node) => ({ ...node.attrs })),
    features: (control.children ?? [])
      .filter((node) => node.name === 'feature-usage')
      .flatMap((node) =>
        node.children.filter((child) => child.name === 'uses-feature').map((child) => ({ ...child.attrs })),
      ),
    libraries,
    resources: resources.sort((a, b) => a.order - b.order), // NOSONAR: retain in-place receiver mutation and ordering
    strings: {},
    stringResources,
    file: manifestFile,
    sourceAssets: [...declaredAssets].map(([url, asset]) => ({
      url,
      file: asset.file,
      contentRevision: asset.contentRevision,
    })),
    sourceContentRevision: createHash('sha256').update(manifest).digest('hex'),
    fingerprint: digest.digest('hex'),
  };
  return { control: record, assets: declaredAssets };
}

// Read stage for one control. It pushes nothing shared: the fold applies the returned state in readdir order.
async function readControl({ root, manifestFile, identityFile, readFile }) {
  const state = { supersedes: null, identified: false, diagnostics: [], admitted: new Map() };
  try {
    state.supersedes = await readIdentity({ root, identityFile, readFile, admitted: state.admitted });
    state.identified = true;
    const manifest = await readManifestControl({
      root,
      manifestFile,
      readFile,
      schemaName: state.supersedes,
      admitted: state.admitted,
      diagnostics: state.diagnostics,
    });
    return { ...state, ...manifest };
  } catch (error) {
    if (error.code === 'MODEL_CLIENT_IMPORT_LIMIT') return { fatal: error };
    state.diagnostics.push({
      code: state.identified ? 'PCF_IMPORT_FAILED' : 'PCF_IDENTITY_UNRESOLVED',
      file: manifestFile,
      message: error.message,
    });
    return { ...state, unresolved: !state.identified };
  }
}

async function readControlSlot({ parent, name, readFile }) {
  const root = await fs.realpath(path.join(parent, name)).catch(() => null);
  if (!root || !contained(parent, root) || !(await fs.stat(root)).isDirectory()) return null;
  const manifestFile = path.join(root, 'ControlManifest.xml');
  const identityFile = path.join(root, 'ControlManifest.xml.data.xml');
  if (!(await fs.stat(manifestFile).catch(() => null)) && !(await fs.stat(identityFile).catch(() => null))) return null;
  return readControl({ root, manifestFile, identityFile, readFile });
}

/** Import standard controls and serve only resource paths explicitly declared in the manifest. */
/* NOSONAR: preserve asynchronous lifecycle and concurrent operation ordering */ export async function importCodeComponents(
  layers = [],
  { readFile = readLocalFile, retainBytes = false } = {},
) {
  const controls = new Map(),
    assets = new Map(),
    diagnostics = [],
    admitted = new Map();
  let unresolvedIdentity = false;
  const forget = (name) => {
    const previous = controls.get(name);
    for (const resource of previous?.resources ?? []) assets.delete(resource.url);
    controls.delete(name);
  };
  // Applied in readdir order, so a declaration still supersedes the earlier control even when its manifest fails.
  const apply = (result) => {
    if (result.fatal) throw result.fatal;
    if (result.supersedes) forget(result.supersedes);
    diagnostics.push(...result.diagnostics);
    if (result.unresolved) unresolvedIdentity = true;
    if (!result.control) return;
    controls.set(result.control.schemaName, result.control);
    for (const [url, asset] of result.assets) assets.set(url, asset);
    if (retainBytes) for (const [file, bytes] of result.admitted) admitted.set(file, bytes);
  };
  for (const layer of layers) {
    if (!layer.dir) continue;
    if (layer.type && layer.type !== 'directory') continue;
    const layerRoot = await fs.realpath(layer.dir).catch(() => null);
    const parent = await fs.realpath(path.join(layer.dir, 'Controls')).catch(() => null);
    if (!parent || !layerRoot || !contained(layerRoot, parent)) continue;
    const names = await fs.readdir(parent);
    // Every control settles before the fold, so a failed read never leaves another read pending.
    const outcomes = await orderedMap(names, 8, (name) => attempt(() => readControlSlot({ parent, name, readFile })));
    for (const outcome of outcomes) {
      if (!outcome.ok) throw outcome.error;
      if (outcome.value) apply(outcome.value);
    }
  }
  // An unreadable identity could supersede any earlier control. The independent
  // WebResource catalogue remains usable, but no PCF fallback is safe to serve.
  if (unresolvedIdentity) {
    controls.clear();
    assets.clear();
    admitted.clear();
  }
  if (retainBytes) admittedFiles.set(controls, admitted);
  return { controls, assets, diagnostics };
}

export function renderCodeComponent({
  name,
  args = {},
  portal,
  catalog,
  identity,
  mappings = {},
  metadata = {},
  language,
  nativeBinding,
  diagnostic,
  onRendered,
}) {
  const schema =
    [...catalog.controls.keys()].find((schema) => canonical(schema) === canonical(name)) ??
    portal.observed?.codeComponents?.[canonical(name)];
  const control = schema && catalog.controls.get(schema);
  const unsupported = (message, details = {}) => {
    diagnostic?.({ code: 'PCF_HOST_UNSUPPORTED', name, schema, message, ...details });
    return `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
  };
  if (!schema)
    return unsupported(
      /^\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/i.test(String(name))
        ? `Code component ${name} requires an observed GUID-to-control mapping and solution sources.`
        : `Code component ${name} was not found in the selected solution sources.`,
    );
  if (!control) return unsupported(`Code component ${schema} was not found in the selected solution sources.`);
  const features = featureEligibility(control.features);
  if (features.some((feature) => !feature.eligible))
    return unsupported(
      `Code component ${schema} has feature declarations that are not eligible for the Power Pages host.`,
      { reason: 'PCF_FEATURE_DECLARATIONS_UNSUPPORTED', features },
    );
  // The Power Pages host supplies no platform libraries: virtual (React) components answer PCF_VIRTUAL_UNSUPPORTED.
  const admission = pcfAdmission({ ...control, name: schema });
  if (!admission.admitted) return unsupported(admission.reason, { reason: admission.code });
  if (nativeBinding) {
    const properties = nativeBinding.properties;
    if (
      control.dataset ||
      typeof nativeBinding.id !== 'string' ||
      !nativeBinding.id ||
      !Array.isArray(properties) ||
      !properties.length ||
      properties.some(
        (name) => !control.properties.some((property) => property.name === name && property.usage === 'bound'),
      )
    )
      return unsupported(
        `Code component ${schema} has no valid single-field native binding to its declared bound properties. Input-only and dataset properties cannot save this field.`,
      );
  }
  const datasets = [];
  for (const dataset of control.datasets ?? []) {
    const result = resolveComponentDataset(dataset, { args, metadata, mappings, schema });
    if (result.error) return unsupported(result.error);
    datasets.push(result.dataset);
  }
  const id = `pcf-${createHash('sha256').update(schema).update(json(args)).digest('hex').slice(0, 16)}`;
  const defaultLanguage = (portal.websiteLanguages ?? []).find((language) => language.isDefault);
  const selectedLanguage = language ?? portal.language ?? defaultLanguage;
  const localized = localizedStrings(control, selectedLanguage, defaultLanguage, (entry) =>
    diagnostic?.({ ...entry, name, schema }),
  );
  const value = {
    ...control,
    ...localized,
    stringResources: undefined,
    datasets,
    file: undefined,
    sourceAssets: undefined,
    args,
    nativeBinding,
    language: selectedLanguage
      ? {
          code: selectedLanguage.code,
          lcid: languageLcid(selectedLanguage),
          isRTL: /^(ar|fa|he|ur)(-|$)/i.test(selectedLanguage.code ?? ''),
        }
      : null,
    identity: { id: identity?.id ?? identity?.contactId ?? null, roles: identity?.roles ?? [] },
    mappings: Object.fromEntries(
      Object.entries(mappings).map(([name, mapping]) => [
        name,
        { entitySet: mapping.entitySet, idColumn: mapping.idColumn },
      ]),
    ),
    id,
  };
  const prefix = '<script src="/__sim-static/pcf-host.js"></script>';
  const opening = `<div data-mirage-component="codecomponent" data-pcf-schema="${escape(schema)}" aria-busy="true">`;
  onRendered?.({
    start: prefix.length,
    end: prefix.length + opening.length,
    tag: 'div',
    component: { kind: 'pcf', key: 'pcf:' + schema.toLowerCase(), name: schema },
    attributes: [{ name: 'data-pcf-schema', value: schema }],
  });
  return (
    prefix +
    opening +
    `</div><script>window.__paqviloPcf.mount(${json(value)}, document.currentScript.previousElementSibling);</script>`
  );
}
