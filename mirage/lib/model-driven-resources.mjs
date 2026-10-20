import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readLocalFile } from '../../lense/local-file.mjs';
import { readSolutionAssetEntries, solutionAssetName } from './dataverse-solution-assets.mjs';
import { importCodeComponents } from './code-components.mjs';
import { parseSolutionXml, descendants, childText, child, serializeXml } from './solution-xml.mjs';
import { parseAppActionCommand } from './model-driven/solution.mjs';

const limit = 8 * 1024 * 1024;
const mime = name => /\.css$/i.test(name) ? 'text/css; charset=utf-8' : /\.js$/i.test(name) ? 'text/javascript; charset=utf-8' : null;
const token = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const inside = (root, file) => { const rel = path.relative(root, file); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

async function layerEntries(layer) {
  if (layer.type === 'zip') return readSolutionAssetEntries(await readLocalFile(layer.dir, { maxBytes: 128 * 1024 * 1024 }));
  const result = [];
  if (layer.type !== 'directory') return result;
  const root = await fs.realpath(layer.dir);
  async function visit(dir, top = false) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (result.length >= 10000) throw new Error('Solution client assets exceed 10000 entries.');
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!top || /^(?:webresources|entities|other|appactions)$/i.test(entry.name)) await visit(file);
      } else if (entry.isFile()) {
        const name = path.relative(root, file).replaceAll('\\', '/');
        if (!/^(?:webresources\/|appactions\/.*\/appaction\.xml$|(?:other\/)?customizations\.xml$|entities\/.*ribbondiff\.xml$)/i.test(name)) continue;
        const real = await fs.realpath(file);
        if (!inside(root, real)) throw new Error('Solution client asset escapes its root.');
        result.push({ name, data: await readLocalFile(file, { root, maxBytes: limit }), file });
      }
    }
  }
  await visit(root, true);
  return result;
}

/** Only selected Solution sources contribute executable code. No remote resolution or fallback. */
export async function importModelDrivenResources(layers = [], { codeComponents } = {}) {
  const resources = new Map(), assets = new Map(), ribbonDocuments = [], actionDocuments = [], diagnostics = [];
  for (const layer of layers) {
    let entries;
    try { entries = await layerEntries(layer); }
    catch (error) { diagnostics.push({ code: 'MODEL_CLIENT_IMPORT_FAILED', source: layer.dir, message: error.message }); continue; }
    const byName = new Map(entries.map(entry => [entry.name.toLowerCase(), entry]));
    actionDocuments.push(...entries.filter(entry => /^appactions\/.*\/appaction\.xml$/i.test(entry.name)));
    const definitions = [];
    for (const entry of entries.filter(entry => /\.xml$/i.test(entry.name))) {
      // Restrict XML parsing to the component areas we consume.
      if (!/^(?:webresources\/|(?:other\/)?customizations\.xml$|entities\/.*ribbondiff\.xml$)/i.test(entry.name)) continue;
      try {
        const xml = entry.data.toString('utf8'), tree = parseSolutionXml(xml);
        if (/RibbonDiffXml[\s>]/.test(xml)) {
          const entity = /^entities\/([^/]+)\//i.exec(entry.name)?.[1]?.toLowerCase();
          const source = entry.file ?? `${layer.dir}!/${entry.name}`;
          if (entity) ribbonDocuments.push({ xml, entity, source });
          else for (const node of descendants(tree, 'Entity')) {
            const name = childText(node, 'Name') ?? child(node, 'Name')?.attrs.OriginalName;
            for (const ribbon of descendants(node, 'RibbonDiffXml')) if (name) ribbonDocuments.push({ xml: serializeXml(ribbon), entity: name.toLowerCase(), source });
          }
        }
        for (const node of tree.name === 'WebResource' ? [tree] : descendants(tree, 'WebResource')) {
          const name = childText(node, 'Name') ?? childText(node, 'name');
          const type = Number(childText(node, 'WebResourceType') ?? childText(node, 'webresourcetype'));
          const file = childText(node, 'FileName') ?? childText(node, 'filename') ?? entry.name.replace(/\.data\.xml$/i, '');
          const unpacked = /^webresources\//i.test(entry.name) && /\.data\.xml$/i.test(entry.name)
            && entry.name.replace(/^webresources\//i, '').replace(/\.data\.xml$/i, '') === name ? entry.name.replace(/\.data\.xml$/i, '') : null;
          const id = childText(node, 'WebResourceId') ?? childText(node, 'webresourceid');
          if (name && [2, 3].includes(type)) definitions.push({ name, type, file, unpacked, id });
        }
      } catch (error) { diagnostics.push({ code: 'MODEL_CLIENT_XML_INVALID', source: entry.name, message: error.message }); }
    }
    for (const definition of definitions) {
      const url = `/_apps/resources/${token(definition.name)}`;
      resources.delete(definition.name); assets.delete(url);
      try {
        // PAC's unpacked .data.xml retains the packed FileName. Its paired physical
        // file is authoritative only when the exported Name exactly matches that pair.
        const file = solutionAssetName(definition.file.replace(/^\/(?=WebResources\/)/i, ''));
        const entry = byName.get(file.toLowerCase()) ?? byName.get(`webresources/${file}`.toLowerCase()) ?? (definition.unpacked && byName.get(definition.unpacked.toLowerCase()));
        if (!entry || entry.data.length > limit) throw new Error('Declared WebResource file is missing or oversized.');
        resources.set(definition.name, { name: definition.name, id: definition.id?.replace(/[{}]/g, '').toLowerCase(), url, type: definition.type === 3 ? 'script' : 'style' });
        assets.set(url, { data: entry.data, mime: definition.type === 3 ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', file: entry.file, name: definition.name });
      } catch (error) { diagnostics.push({ code: 'MODEL_WEBRESOURCE_UNRESOLVED', name: definition.name, message: error.message }); }
    }
  }
  const components = codeComponents ?? await importCodeComponents(layers);
  diagnostics.push(...components.diagnostics);
  const controls = [];
  for (const control of components.controls.values()) {
    const urls = { code: [], css: [], exports: [], resx: {} };
    for (const resource of control.resources) {
      const asset = components.assets.get(resource.url);
      if (!asset) continue;
      const url = resource.url.replace('/__sim-static/pcf/', '/_apps/controls/');
      if (['code', 'css'].includes(resource.kind)) {
        const data = await readLocalFile(asset.file, { root: asset.root, maxBytes: limit });
        assets.set(url, { data, mime: mime(resource.path) ?? (resource.kind === 'code' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'), file: asset.file, name: `${control.schemaName}/${resource.path}` });
        urls[resource.kind].push(url);
        if (resource.exportGlobal) urls.exports.push(resource.exportGlobal);
      }
    }
    // A deterministic exported fallback; selected language support can layer over this.
    for (const resource of control.stringResources ?? []) if (resource.lcid === 1033) Object.assign(urls.resx, resource.strings);
    controls.push({ name: control.schemaName, constructor: control.constructor, controlType: control.type, datasets: control.datasets,
      properties: control.properties.map(property => ({ ...property, ofType: property['of-type'] ?? property.types?.[0] })),
      features: control.features, libraries: control.libraries, resources: urls });
  }
  const webresourcesById = new Map([...resources.values()].filter(resource => resource.id).map(resource => [resource.id, resource.name]));
  const appActions = actionDocuments.flatMap(entry => {
    try { const command = parseAppActionCommand(entry.data.toString('utf8'), { webresourcesById }); if (!command) throw new Error('Expected an AppAction definition.'); return [command]; }
    catch (error) { diagnostics.push({ code: 'MODEL_APP_ACTION_INVALID', source: entry.name, message: error.message }); return []; }
  });
  return { resources: [...resources.values()], pcf: { controls }, assets, ribbonDocuments, appActions, diagnostics };
}

export function clientExtensionCatalogue(imported, settings) {
  return { trusted: settings.trustedExtensions, resources: imported?.resources ?? [], pcf: imported?.pcf ?? { controls: [] }, diagnostics: imported?.diagnostics ?? [] };
}
