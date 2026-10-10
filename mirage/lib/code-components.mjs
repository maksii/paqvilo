import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseSolutionXml, descendants, childText } from './solution-xml.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const canonical = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
const contained = (root, file) => { const rel = path.relative(root, file); return Boolean(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

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
        const resources = [], strings = {}, declaredAssets = new Map();
        for (const resource of descendants(control, 'resources')[0]?.children ?? []) {
          const relative = resource.attrs.path;
          if (!relative || !['code', 'css', 'resx', 'img'].includes(resource.name) || /[\\?#]/.test(relative)) continue;
          const file = await fs.realpath(path.resolve(root, relative)).catch(() => null);
          if (!file || !contained(root, file) || (await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('Declared PCF resource is missing, outside its control, or exceeds 8 MiB');
          const url = `/__sim-static/pcf/${token}/${relative.split('/').map(encodeURIComponent).join('/')}`;
          digest.update(relative).update(await fs.readFile(file));
          declaredAssets.set(url, { file, root, kind: resource.name });
          resources.push({ kind: resource.name, url, order: Number(resource.attrs.order) || 0 });
          if (resource.name === 'resx') {
            for (const entry of descendants(parseSolutionXml(await fs.readFile(file, 'utf8')), 'data')) strings[entry.attrs.name] = childText(entry, 'value') ?? '';
          }
        }
        controls.set(schemaName, { schemaName, constructor: `${control.attrs.namespace}.${control.attrs.constructor}`, type: control.attrs['control-type'], dataset: descendants(control, 'data-set').length > 0, properties: descendants(control, 'property').map(property => ({ ...property.attrs })), resources: resources.sort((a,b) => a.order - b.order), strings, file: manifestFile, fingerprint: digest.digest('hex') });
        for (const [url, asset] of declaredAssets) assets.set(url, asset);
      } catch (cause) {
        if (cause.code !== 'ENOENT') diagnostics.push({ code: 'PCF_IMPORT_FAILED', file: manifestFile, message: cause.message });
      }
    }
  }
  return { controls, assets, diagnostics };
}

export function renderCodeComponent({ name, args = {}, portal, catalog, identity, mappings = {}, diagnostic }) {
  const schema = portal.observed?.codeComponents?.[canonical(name)];
  const control = schema && catalog.controls.get(schema);
  const unsupported = message => {
    diagnostic?.({ code: 'PCF_HOST_UNSUPPORTED', name, schema, message });
    return `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
  };
  if (!schema) return unsupported(`Code component ${name} requires an observed GUID-to-control mapping and solution sources.`);
  if (!control) return unsupported(`Code component ${schema} was not found in the selected solution sources.`);
  if (control.type !== 'standard' || control.dataset) return unsupported(`Code component ${schema} requires a host feature this local standard-control adapter does not support.`);
  const id = `pcf-${createHash('sha256').update(schema).update(json(args)).digest('hex').slice(0, 16)}`;
  const value = { ...control, file: undefined, args, identity: { id: identity?.id ?? identity?.contactId ?? null, roles: identity?.roles ?? [] }, mappings: Object.fromEntries(Object.entries(mappings).map(([name, mapping]) => [name, { entitySet: mapping.entitySet, idColumn: mapping.idColumn }])), id };
  return `<div id="${id}" data-mirage-component="codecomponent" data-pcf-schema="${escape(schema)}" aria-busy="true"></div><script src="/__sim-static/pcf-host.js"></script><script>window.__paqviloPcf.mount(${json(value)});</script>`;
}
