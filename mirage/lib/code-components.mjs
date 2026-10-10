import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseSolutionXml, descendants, childText } from './solution-xml.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const canonical = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const contained = (root, file) => { const rel = path.relative(root, file); return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const pcfTypes = { nvarchar: 'SingleLine.Text', ntext: 'Multiple', uniqueidentifier: 'SingleLine.Text', primarykey: 'SingleLine.Text', int: 'Whole.None', integer: 'Whole.None', bigint: 'Whole.None', decimal: 'Decimal', float: 'FP', money: 'Currency', datetime: 'DateAndTime.DateAndTime', bit: 'TwoOptions', picklist: 'OptionSet', state: 'OptionSet', status: 'OptionSet', multiselectpicklist: 'MultiSelectOptionSet', lookup: 'Lookup.Simple', owner: 'Lookup.Simple' };

/** Import standard controls and serve only resource paths explicitly declared in the manifest. */
export async function importCodeComponents(layers = []) {
  const controls = new Map(), assets = new Map(), diagnostics = [];
  for (const layer of layers) {
    if (!layer.dir) continue;
    const parent = await fs.realpath(path.join(layer.dir, 'Controls')).catch(() => null);
    if (!parent) continue;
    for (const name of await fs.readdir(parent)) {
      const root = await fs.realpath(path.join(parent, name)).catch(() => null);
      if (!root || !contained(parent, root) || !(await fs.stat(root)).isDirectory()) continue;
      const manifestFile = path.join(root, 'ControlManifest.xml');
      try {
        if (!contained(root, await fs.realpath(manifestFile)) || (await fs.stat(manifestFile)).size > 1024 * 1024) continue;
        const manifest = await fs.readFile(manifestFile, 'utf8');
        const control = descendants(parseSolutionXml(manifest), 'control')[0];
        if (!control) continue;
        const metadataFile = await fs.realpath(path.join(root, 'ControlManifest.xml.data.xml'));
        if (!contained(root, metadataFile) || (await fs.stat(metadataFile)).size > 1024 * 1024) continue;
        const metadata = await fs.readFile(metadataFile, 'utf8');
        const schemaName = childText(parseSolutionXml(metadata), 'Name');
        if (!schemaName || !/^[\w.]+$/.test(schemaName)) continue;
        const token = createHash('sha256').update(root).update(manifest).digest('hex').slice(0, 24);
        const digest = createHash('sha256').update(manifest);
        const resources = [], strings = {}, libraries = [], declaredAssets = new Map();
        for (const resource of descendants(control, 'resources')[0]?.children ?? []) {
          if (resource.name === 'platform-library') { libraries.push({ ...resource.attrs }); continue; }
          const relative = resource.attrs.path;
          if (!['code', 'css', 'resx', 'img'].includes(resource.name)) continue;
          if (!relative || /[\\?#]/.test(relative)) throw new Error('Declared PCF resource has an invalid path');
          const file = await fs.realpath(path.resolve(root, relative)).catch(() => null);
          if (!file || !contained(root, file) || (await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('Declared PCF resource is missing, outside its control, or exceeds 8 MiB');
          const url = `/__sim-static/pcf/${token}/${relative.split('/').map(encodeURIComponent).join('/')}`;
          digest.update(relative).update(await fs.readFile(file));
          declaredAssets.set(url, { file, root, kind: resource.name });
          resources.push({ kind: resource.name, path: relative, url, order: Number(resource.attrs.order) || 0 });
          if (resource.name === 'resx') {
            for (const entry of descendants(parseSolutionXml(await fs.readFile(file, 'utf8')), 'data')) strings[entry.attrs.name] = childText(entry, 'value') ?? '';
          }
        }
        if (!resources.some(resource => resource.kind === 'code')) throw new Error('PCF manifest does not declare an executable code resource');
        const typeGroups = Object.fromEntries(descendants(control, 'type-group').map(group => [group.attrs.name, group.children.filter(node => node.name === 'type').map(node => node.text.trim())]));
        controls.set(schemaName, { schemaName, constructor: `${control.attrs.namespace}.${control.attrs.constructor}`, type: control.attrs['control-type'], dataset: descendants(control, 'data-set').length > 0, datasets: descendants(control, 'data-set').map(node => ({ ...node.attrs })), properties: descendants(control, 'property').map(property => ({ ...property.attrs, types: typeGroups[property.attrs['of-type-group']] })), libraries, resources: resources.sort((a,b) => a.order - b.order), strings, file: manifestFile, fingerprint: digest.digest('hex') });
        for (const [url, asset] of declaredAssets) assets.set(url, asset);
      } catch (cause) {
        if (cause.code !== 'ENOENT') diagnostics.push({ code: 'PCF_IMPORT_FAILED', file: manifestFile, message: cause.message });
      }
    }
  }
  return { controls, assets, diagnostics };
}

export function renderCodeComponent({ name, args = {}, portal, catalog, identity, mappings = {}, metadata = {}, language, nativeBinding, diagnostic }) {
  const schema = [...catalog.controls.keys()].find(schema => canonical(schema) === canonical(name)) ?? portal.observed?.codeComponents?.[canonical(name)];
  const control = schema && catalog.controls.get(schema);
  const unsupported = message => {
    diagnostic?.({ code: 'PCF_HOST_UNSUPPORTED', name, schema, message });
    return `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
  };
  if (!schema) return unsupported(/^[{]?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}[}]?$/i.test(String(name))
    ? `Code component ${name} requires an observed GUID-to-control mapping and solution sources.`
    : `Code component ${name} was not found in the selected solution sources.`);
  if (!control) return unsupported(`Code component ${schema} was not found in the selected solution sources.`);
  if (control.type !== 'standard') return unsupported(`Code component ${schema} requires a React host and its declared platform libraries. The local host currently supports standard controls.`);
  if (control.libraries?.length) return unsupported(`Code component ${schema} requires platform libraries (${control.libraries.map(item => item.name + ' ' + item.version).join(', ')}). These libraries are not supplied by the local host.`);
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
  const selectedLanguage = language ?? portal.language ?? (portal.websiteLanguages ?? []).find(language => language.isDefault);
  const value = { ...control, datasets, file: undefined, args, nativeBinding, language: selectedLanguage ? { code: selectedLanguage.code, lcid: selectedLanguage.lcid, isRTL: /^(ar|fa|he|ur)(-|$)/i.test(selectedLanguage.code ?? '') } : null, identity: { id: identity?.id ?? identity?.contactId ?? null, roles: identity?.roles ?? [] }, mappings: Object.fromEntries(Object.entries(mappings).map(([name, mapping]) => [name, { entitySet: mapping.entitySet, idColumn: mapping.idColumn }])), id };
  return `<script src="/__sim-static/pcf-host.js"></script><div data-mirage-component="codecomponent" data-pcf-schema="${escape(schema)}" aria-busy="true"></div><script>window.__paqviloPcf.mount(${json(value)}, document.currentScript.previousElementSibling);</script>`;
}
