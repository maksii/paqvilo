import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from '../../lense/local-file.mjs';
import { createHash } from 'node:crypto';
import { parseSolutionXml, descendants, childText } from './solution-xml.mjs';
import { portalLanguage } from './portal-languages.mjs';
import { pcfAdmission } from './model-driven/pcf-runtime.mjs';

/** The one PCF admission rule of the Power Pages and model-driven hosts (control type, dataset, platform libraries). */
export { pcfAdmission };

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const canonical = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const contained = (root, file) => { const rel = path.relative(root, file); return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const pcfTypes = { nvarchar: 'SingleLine.Text', ntext: 'Multiple', uniqueidentifier: 'SingleLine.Text', primarykey: 'SingleLine.Text', int: 'Whole.None', integer: 'Whole.None', bigint: 'Whole.None', decimal: 'Decimal', float: 'FP', money: 'Currency', datetime: 'DateAndTime.DateAndTime', bit: 'TwoOptions', picklist: 'OptionSet', state: 'OptionSet', status: 'OptionSet', multiselectpicklist: 'MultiSelectOptionSet', lookup: 'Lookup.Simple', owner: 'Lookup.Simple' };

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
  return features.map(feature => {
    const requiredValue = typeof feature.required === 'string' ? feature.required.trim() : feature.required;
    const required = requiredValue === 'true' || requiredValue === '1';
    const valid = typeof feature.name === 'string' && Boolean(feature.name.trim()) && ['true', 'false', '1', '0'].includes(requiredValue);
    const hostApiAvailable = feature.name === 'WebAPI' ? true
      : feature.name === 'Utility' || /^(?:Device|device)\./.test(feature.name ?? '') ? false : null;
    return { ...feature, hostApiAvailable, eligible: valid && !required,
      ...(!valid ? { reason: 'PCF_FEATURE_DECLARATION_INVALID' } : required ? { reason: 'PCF_PORTAL_REQUIRED_FEATURE_UNSUPPORTED' } : {}) };
  });
}

function languageLcid(language) {
  if (Number.isInteger(Number(language?.lcid)) && Number(language.lcid) > 0) return Number(language.lcid);
  return portalLanguage({ name: language?.code })?.lcid ?? null;
}

function localizedStrings(control, selectedLanguage, defaultLanguage, diagnostic) {
  if (!control.stringResources) return { strings: control.strings ?? {}, localization: null };
  const selectedLcid = languageLcid(selectedLanguage), defaultLcid = languageLcid(defaultLanguage);
  const strings = Object.create(null), selectedResources = [], ambiguousKeys = new Set();
  const groups = new Map();
  for (const resource of control.stringResources) {
    if (!resource.lcid) continue;
    if (!groups.has(resource.group)) groups.set(resource.group, []);
    groups.get(resource.group).push(resource);
  }
  for (const [group, variants] of groups) {
    let candidates = variants.filter(resource => resource.lcid === selectedLcid);
    let selection = 'selected-language';
    if (!candidates.length && defaultLcid) { candidates = variants.filter(resource => resource.lcid === defaultLcid); selection = 'website-default-language'; }
    if (candidates.length !== 1) {
      diagnostic?.({ code: candidates.length ? 'PCF_RESOURCE_LANGUAGE_AMBIGUOUS' : 'PCF_RESOURCE_LANGUAGE_UNRESOLVED', group, selectedLcid, defaultLcid, paths: candidates.map(resource => resource.path) });
      continue;
    }
    const resource = candidates[0];
    if (selection === 'website-default-language') diagnostic?.({ code: 'PCF_RESOURCE_LANGUAGE_FALLBACK', group, selectedLcid, selectedResourceLcid: resource.lcid, policy: 'exported-website-default', nativeQualified: false });
    selectedResources.push({ path: resource.path, lcid: resource.lcid, selection, attributes: resource.attributes });
    for (const [key, value] of Object.entries(resource.strings)) {
      if (Object.hasOwn(strings, key)) ambiguousKeys.add(key);
      else strings[key] = value;
    }
  }
  for (const key of ambiguousKeys) { delete strings[key]; diagnostic?.({ code: 'PCF_RESOURCE_KEY_AMBIGUOUS', key }); }
  return { strings, localization: { selectedLcid, defaultLcid, resources: selectedResources } };
}

/** Import standard controls and serve only resource paths explicitly declared in the manifest. */
export async function importCodeComponents(layers = [], { readFile = readLocalFile } = {}) {
  const controls = new Map(), assets = new Map(), diagnostics = [];
  let unresolvedIdentity = false;
  const forget = name => {
    const previous = controls.get(name);
    for (const resource of previous?.resources ?? []) assets.delete(resource.url);
    controls.delete(name);
  };
  for (const layer of layers) {
    if (!layer.dir) continue;
    if (layer.type && layer.type !== 'directory') continue;
    const layerRoot = await fs.realpath(layer.dir).catch(() => null);
    const parent = await fs.realpath(path.join(layer.dir, 'Controls')).catch(() => null);
    if (!parent || !layerRoot || !contained(layerRoot, parent)) continue;
    for (const name of await fs.readdir(parent)) {
      const root = await fs.realpath(path.join(parent, name)).catch(() => null);
      if (!root || !contained(parent, root) || !(await fs.stat(root)).isDirectory()) continue;
      const manifestFile = path.join(root, 'ControlManifest.xml');
      const identityFile = path.join(root, 'ControlManifest.xml.data.xml');
      if (!await fs.stat(manifestFile).catch(() => null) && !await fs.stat(identityFile).catch(() => null)) continue;
      let identified = false;
      try {
        const metadataFile = await fs.realpath(identityFile);
        if (!contained(root, metadataFile) || (await fs.stat(metadataFile)).size > 1024 * 1024) throw new Error('PCF identity metadata is outside its control or exceeds 1 MiB');
        const metadata = await readFile(metadataFile, { root, maxBytes: 1024 * 1024, encoding: 'utf8' });
        const schemaName = childText(parseSolutionXml(metadata), 'Name');
        if (!schemaName || !/^[\w.]+$/.test(schemaName)) throw new Error('PCF identity metadata has no valid exported Name');
        identified = true;
        // A declaration supersedes the earlier control even when its manifest or
        // dependencies cannot be loaded. Never reactivate an older executable.
        forget(schemaName);
        if (!contained(root, await fs.realpath(manifestFile)) || (await fs.stat(manifestFile)).size > 1024 * 1024) throw new Error('PCF manifest is outside its control or exceeds 1 MiB');
        const manifest = await readFile(manifestFile, { root, maxBytes: 1024 * 1024, encoding: 'utf8' });
        const control = descendants(parseSolutionXml(manifest), 'control')[0];
        if (!control) throw new Error('PCF manifest has no control declaration');
        const token = createHash('sha256').update(root).update(manifest).digest('hex').slice(0, 24);
        const digest = createHash('sha256').update(manifest);
        const resources = [], stringResources = [], libraries = [], declaredAssets = new Map();
        for (const resource of descendants(control, 'resources')[0]?.children ?? []) {
          if (resource.name === 'platform-library') { libraries.push({ ...resource.attrs }); continue; }
          const relative = resource.attrs.path;
          if (!['code', 'css', 'resx', 'img'].includes(resource.name)) continue;
          if (!relative || /[\\?#]/.test(relative)) throw new Error('Declared PCF resource has an invalid path');
          const file = await fs.realpath(path.resolve(root, relative)).catch(() => null);
          if (!file || !contained(root, file) || (await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('Declared PCF resource is missing, outside its control, or exceeds 8 MiB');
          const url = `/__sim-static/pcf/${token}/${relative.split('/').map(encodeURIComponent).join('/')}`;
          const body = await readFile(file, { root, maxBytes: 8 * 1024 * 1024 });
          digest.update(relative).update(body);
          declaredAssets.set(url, { file, root, kind: resource.name });
          // SDK bundles can export their constructor through a classic script
          // module rather than a namespace or registerControl call. Bind only
          // a declaration from this exact declared resource, never scan globals.
          const exportGlobal = resource.name === 'code' ? classicExportGlobal(body.toString('utf8')) : undefined;
          resources.push({ kind: resource.name, path: relative, url, order: Number(resource.attrs.order) || 0, attributes: { ...resource.attrs }, ...(exportGlobal ? { exportGlobal } : {}) });
          if (resource.name === 'resx') {
            const document = parseSolutionXml(body.toString('utf8'));
            const entries = descendants(document, 'data');
            const strings = Object.create(null), duplicates = new Set();
            for (const entry of entries) {
              const key = entry.attrs.name;
              if (!key) { diagnostics.push({ code: 'PCF_RESOURCE_KEY_UNRESOLVED', file, message: 'RESX data entry has no name.' }); continue; }
              if (Object.hasOwn(strings, key)) duplicates.add(key);
              else strings[key] = entry.children.find(node => node.name === 'value')?.text ?? '';
            }
            for (const key of duplicates) { delete strings[key]; diagnostics.push({ code: 'PCF_RESOURCE_KEY_AMBIGUOUS', file, key, message: 'RESX resource contains duplicate named data entries.' }); }
            const locale = /^(.*)\.(\d+)\.resx$/i.exec(relative);
            const lcid = locale && Number.isSafeInteger(Number(locale[2])) && Number(locale[2]) > 0 ? Number(locale[2]) : null;
            stringResources.push({ path: relative, group: locale?.[1] ?? relative, lcid, attributes: { ...resource.attrs }, document, entries, strings });
            if (!lcid) diagnostics.push({ code: 'PCF_RESOURCE_LANGUAGE_UNRESOLVED', file, message: 'RESX resource has no documented positive LCID filename suffix.' });
          }
        }
        if (!resources.some(resource => resource.kind === 'code')) throw new Error('PCF manifest does not declare an executable code resource');
        const typeGroups = Object.fromEntries(descendants(control, 'type-group').map(group => [group.attrs.name, group.children.filter(node => node.name === 'type').map(node => node.text.trim())]));
        const features = (control.children ?? []).filter(node => node.name === 'feature-usage').flatMap(node => node.children.filter(child => child.name === 'uses-feature').map(child => ({ ...child.attrs })));
        controls.set(schemaName, { schemaName, constructor: `${control.attrs.namespace}.${control.attrs.constructor}`, type: control.attrs['control-type'], dataset: descendants(control, 'data-set').length > 0, datasets: descendants(control, 'data-set').map(node => ({ ...node.attrs })), properties: descendants(control, 'property').map(property => ({ ...property.attrs, types: typeGroups[property.attrs['of-type-group']] })), features, libraries, resources: resources.sort((a,b) => a.order - b.order), strings: {}, stringResources, file: manifestFile, fingerprint: digest.digest('hex') });
        for (const [url, asset] of declaredAssets) assets.set(url, asset);
      } catch (cause) {
        if (cause.code === 'MODEL_CLIENT_IMPORT_LIMIT') throw cause;
        if (!identified) unresolvedIdentity = true;
        diagnostics.push({ code: identified ? 'PCF_IMPORT_FAILED' : 'PCF_IDENTITY_UNRESOLVED', file: manifestFile, message: cause.message });
      }
    }
  }
  // An unreadable identity could supersede any earlier control. The independent
  // WebResource catalogue remains usable, but no PCF fallback is safe to serve.
  if (unresolvedIdentity) { controls.clear(); assets.clear(); }
  return { controls, assets, diagnostics };
}

export function renderCodeComponent({ name, args = {}, portal, catalog, identity, mappings = {}, metadata = {}, language, nativeBinding, diagnostic }) {
  const schema = [...catalog.controls.keys()].find(schema => canonical(schema) === canonical(name)) ?? portal.observed?.codeComponents?.[canonical(name)];
  const control = schema && catalog.controls.get(schema);
  const unsupported = (message, details = {}) => {
    diagnostic?.({ code: 'PCF_HOST_UNSUPPORTED', name, schema, message, ...details });
    return `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
  };
  if (!schema) return unsupported(/^[{]?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}[}]?$/i.test(String(name))
    ? `Code component ${name} requires an observed GUID-to-control mapping and solution sources.`
    : `Code component ${name} was not found in the selected solution sources.`);
  if (!control) return unsupported(`Code component ${schema} was not found in the selected solution sources.`);
  const features = featureEligibility(control.features);
  if (features.some(feature => !feature.eligible)) return unsupported(`Code component ${schema} has feature declarations that are not eligible for the Power Pages host.`, { reason: 'PCF_FEATURE_DECLARATIONS_UNSUPPORTED', features });
  // The Power Pages host supplies no platform libraries: virtual (React) components answer PCF_VIRTUAL_UNSUPPORTED.
  const admission = pcfAdmission({ ...control, name: schema });
  if (!admission.admitted) return unsupported(admission.reason, { reason: admission.code });
  if (nativeBinding) {
    const properties = nativeBinding.properties;
    if (control.dataset || typeof nativeBinding.id !== 'string' || !nativeBinding.id || !Array.isArray(properties) || !properties.length || properties.some(name => !control.properties.some(property => property.name === name && property.usage === 'bound'))) return unsupported(`Code component ${schema} has no valid single-field native binding to its declared bound properties. Input-only and dataset properties cannot save this field.`);
  }
  const datasets = [];
  for (const dataset of control.datasets ?? []) {
    const binding = args[dataset.name] ?? args[dataset.name.toLowerCase()];
    if (typeof binding !== 'string' || !binding.trim()) return unsupported(`Code component ${schema} requires a dataset binding to an exported table and view: set the ${dataset.name} tag argument to an exported view ID or table logical name.`);
    const candidates = (metadata.views ?? []).filter(view => canonical(view.id) === canonical(binding) || canonical(view.name) === canonical(binding));
    if (candidates.length > 1) return unsupported(`Dataset ${dataset.name} matches multiple exported views. Bind its exported view ID.`);
    const view = candidates[0], entity = view?.entity ?? canonical(binding);
    const table = metadata.entities?.[entity], mapping = mappings[entity];
    if (!table || !mapping?.entitySet || !mapping?.idColumn) return unsupported(`Dataset ${dataset.name} has no exported table definition and exact Web API mapping for ${entity}.`);
    const fields = table.fields ?? {};
    const names = view?.fields?.length ? view.fields.map(field => field.name) : Object.keys(fields).filter(name => fields[name].validForRead !== false);
    if (!names.includes(mapping.idColumn)) names.unshift(mapping.idColumn);
    if (!names.length || !names.every(name => /^[a-z_][a-z\d_]*$/i.test(name) && (fields[name] || name === mapping.idColumn))) return unsupported(`Dataset ${dataset.name} has an aliased or unresolved column binding. Only exported columns of its primary table are supported.`);
    if (view?.fetchXml) {
      try {
        const fetch = parseSolutionXml(view.fetchXml);
        if (fetch.attrs.aggregate === 'true' || fetch.attrs.top != null || descendants(fetch, 'attribute').some(node => node.attrs.alias)) return unsupported(`Dataset ${dataset.name} requires unsupported aggregate, top-limited, or aliased view semantics.`);
      } catch { return unsupported(`Dataset ${dataset.name} has malformed exported FetchXML.`); }
    }
    const columns = names.map((name, order) => ({ name, displayName: fields[name]?.label ?? name, dataType: pcfTypes[fields[name]?.dataverseType] ?? 'unknown', order, visualSizeFactor: view?.fields?.find(field => field.name === name)?.width ?? 100, targets: fields[name]?.targets }));
    datasets.push({ name: dataset.name, entity, entitySet: mapping.entitySet, idColumn: mapping.idColumn, nameColumn: mapping.nameColumn ?? table.primaryNameAttribute, viewId: view?.id ?? null, viewName: view?.name ?? entity, columns, fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, { label: field.label, dataverseType: field.dataverseType, dataType: pcfTypes[field.dataverseType], targets: field.targets }])), fetchXml: view?.fetchXml || `<fetch><entity name="${escape(entity)}">${names.map(name => `<attribute name="${escape(name)}"/>`).join('')}</entity></fetch>` });
  }
  const id = `pcf-${createHash('sha256').update(schema).update(json(args)).digest('hex').slice(0, 16)}`;
  const defaultLanguage = (portal.websiteLanguages ?? []).find(language => language.isDefault);
  const selectedLanguage = language ?? portal.language ?? defaultLanguage;
  const localized = localizedStrings(control, selectedLanguage, defaultLanguage, entry => diagnostic?.({ ...entry, name, schema }));
  const value = { ...control, ...localized, stringResources: undefined, datasets, file: undefined, args, nativeBinding, language: selectedLanguage ? { code: selectedLanguage.code, lcid: languageLcid(selectedLanguage), isRTL: /^(ar|fa|he|ur)(-|$)/i.test(selectedLanguage.code ?? '') } : null, identity: { id: identity?.id ?? identity?.contactId ?? null, roles: identity?.roles ?? [] }, mappings: Object.fromEntries(Object.entries(mappings).map(([name, mapping]) => [name, { entitySet: mapping.entitySet, idColumn: mapping.idColumn }])), id };
  return `<script src="/__sim-static/pcf-host.js"></script><div data-mirage-component="codecomponent" data-pcf-schema="${escape(schema)}" aria-busy="true"></div><script>window.__paqviloPcf.mount(${json(value)}, document.currentScript.previousElementSibling);</script>`;
}
