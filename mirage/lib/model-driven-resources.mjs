import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readLocalFile } from '../../lense/local-file.mjs';
import { readSolutionAssetEntries, solutionAssetName, SOLUTION_ASSET_LIMITS } from './dataverse-solution-assets.mjs';
import { importCodeComponents } from './code-components.mjs';
import { parseSolutionXml, descendants, childText, child, serializeXml } from './solution-xml.mjs';
import { parseAppActionCommand } from './model-driven/solution.mjs';

const limit = 8 * 1024 * 1024;
const mime = (name) =>
  /\.css$/i.test(name) ? 'text/css; charset=utf-8' : /\.js$/i.test(name) ? 'text/javascript; charset=utf-8' : null;
const token = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const readEntry = async (entry) => entry.data ?? entry.load();
// Diagnostics name paths as `<Solution layer>/<path inside it>`, never as local absolute paths.
function projectPath(value, roots) {
  if (typeof value !== 'string' || !(path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value))) return value;
  for (const root of roots)
    for (const dir of root.dirs)
      if (inside(dir, value)) return `${root.label}/${path.relative(dir, value).replaceAll('\\', '/')}`;
  return path.basename(value);
}
const projectText = (text, roots) =>
  text.replace(
    /(^|[\s'"(=])((?:[a-z]:)?[\\/][^\s'"`()<>|]+)/gi,
    (match, lead, value) => lead + projectPath(value, roots),
  );
function projectDiagnostic(entry, roots) {
  const safe = { ...entry };
  for (const key of ['source', 'file', 'sourceFile'])
    if (typeof safe[key] === 'string') safe[key] = projectPath(safe[key], roots);
  if (typeof safe.message === 'string') safe.message = projectText(safe.message, roots);
  return safe;
}

function importBudget(requested = {}) {
  const ceilings = {
    bytes: SOLUTION_ASSET_LIMITS.totalBytes,
    entries: SOLUTION_ASSET_LIMITS.entries,
    layers: SOLUTION_ASSET_LIMITS.layers,
  };
  const remaining = { ...ceilings };
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(value) || value < 1 || value > ceilings[key])
      throw new Error(`Invalid Solution client import limit ${key}.`);
    remaining[key] = value;
  }
  return {
    remaining,
    take(key, count) {
      if (count > remaining[key]) {
        const error = new Error(`Solution client assets exceed the aggregate ${key} limit.`);
        error.code = 'MODEL_CLIENT_IMPORT_LIMIT';
        throw error;
      }
      remaining[key] -= count;
    },
  };
}

async function readBudgetedFile(file, root, budget, maximum = limit) {
  const size = (await fs.stat(file)).size;
  budget.take('bytes', size);
  const data = await readLocalFile(file, { root, maxBytes: Math.min(maximum, limit, size) });
  // A file can grow between stat and open; readLocalFile enforces the admitted size.
  return data;
}

async function layerEntries(layer, budget) {
  if (layer.type === 'zip') {
    const entries = readSolutionAssetEntries(
      await readLocalFile(layer.dir, { maxBytes: SOLUTION_ASSET_LIMITS.archiveBytes }),
      { totalBytes: Math.max(1, budget.remaining.bytes), entries: Math.max(1, budget.remaining.entries) },
    );
    budget.take('entries', entries.length);
    budget.take(
      'bytes',
      entries.reduce((sum, entry) => sum + entry.data.length, 0),
    );
    return entries;
  }
  const result = [];
  if (layer.type !== 'directory') return result;
  const root = await fs.realpath(layer.dir);
  async function visit(dir, top = false) {
    for await (const entry of await fs.opendir(dir)) {
      budget.take('entries', 1);
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!top || /^(?:webresources|entities|other|appactions|controls)$/i.test(entry.name)) await visit(file);
      } else if (entry.isFile()) {
        const name = path.relative(root, file).replaceAll('\\', '/');
        if (
          !/^(?:webresources\/|appactions\/.*\/appaction\.xml$|(?:other\/)?customizations\.xml$|entities\/.*ribbondiff\.xml$)/i.test(
            name,
          )
        )
          continue;
        const real = await fs.realpath(file);
        if (!inside(root, real)) throw new Error('Solution client asset escapes its root.');
        // Index physical names first. Binary images and unrelated WebResources do
        // not enter memory; only metadata and declared JS/CSS assets are read.
        const indexed = { name, file };
        indexed.load = async () => (indexed.data ??= await readBudgetedFile(file, root, budget));
        result.push(indexed);
      }
    }
  }
  await visit(root, true);
  return result;
}

/** Only selected Solution sources contribute executable code. No remote resolution or fallback. */
export async function importModelDrivenResources(
  layers = [],
  { codeComponents, limits, clientSources, diagnostic = () => {}, projectRoot = null } = {},
) {
  // A resource names its source file relative to the project root when one is given (status payloads never show absolute paths).
  const shown = (file) =>
    projectRoot && path.isAbsolute(file) ? path.relative(projectRoot, file).replaceAll('\\', '/') : file;
  const resources = new Map(),
    assets = new Map(),
    ribbonDocuments = [],
    actionDocuments = [],
    diagnostics = [];
  const budget = importBudget(limits),
    fileReads = new Map();
  // PCF discovery reads manifests and localized/image resources too. Admit every
  // byte before reading, then reuse that exact snapshot when packaging JS/CSS.
  const readFile = async (file, { root, maxBytes = limit, encoding } = {}) => {
    if (!fileReads.has(file)) fileReads.set(file, readBudgetedFile(file, root, budget, maxBytes));
    const data = await fileReads.get(file);
    return encoding ? data.toString(encoding) : data;
  };
  const limited = (error) => error.code === 'MODEL_CLIENT_IMPORT_LIMIT' || error.code === 'ArchiveLimit';
  // Roots are known once the layers are resolved; earlier failures carry only messages.
  let roots = [];
  // Every return path reports its diagnostics once to the caller, with project-relative paths.
  const finish = (result) => {
    const safe = result.diagnostics.map((entry) => projectDiagnostic(entry, roots));
    for (const entry of safe) diagnostic(entry);
    return { ...result, diagnostics: safe };
  };
  const failLimit = (error, source) =>
    finish({
      resources: [],
      pcf: { controls: [] },
      assets: new Map(),
      ribbonDocuments: [],
      appActions: [],
      diagnostics: [...diagnostics, { code: 'MODEL_CLIENT_IMPORT_LIMIT', source, message: error.message }],
    });
  // A clientSources entry named <Library>@<version>.js is a project-supplied PCF platform library
  // (React, ReactDOM, Fluent): served under /_apps/controls/platform/ and never an npm dependency of Mirage.
  const platformLibraries = [];
  if (clientSources !== undefined) {
    const libraryFiles = clientSources.filter((source) => /\.js$/i.test(source));
    for (const file of libraryFiles) {
      const match = /^([A-Za-z][\w.-]*)@(\d+(?:\.\d+){1,3})\.js$/i.exec(path.basename(file));
      try {
        if (!match)
          throw new Error(`Platform library files are named <Library>@<version>.js (${path.basename(file)}).`);
        const real = await fs.realpath(file),
          data = await readBudgetedFile(real, path.dirname(real), budget);
        const url = `/_apps/controls/platform/${token(real)}/${encodeURIComponent(match[1])}.js`;
        assets.set(url, {
          data,
          mime: 'text/javascript; charset=utf-8',
          file: real,
          name: `platform/${match[1]}@${match[2]}`,
        });
        platformLibraries.push({ name: match[1], version: match[2], url, source: shown(real) });
      } catch (error) {
        if (limited(error)) return failLimit(error, file);
        diagnostics.push({ code: 'MODEL_PCF_PLATFORM_LIBRARY_INVALID', source: file, message: error.message });
      }
    }
    clientSources = clientSources.filter((source) => !libraryFiles.includes(source));
    if (!clientSources.length && libraryFiles.length) clientSources = undefined;
  }
  if (clientSources !== undefined) {
    try {
      layers = await Promise.all(
        clientSources.map(async (source) => {
          const dir = await fs.realpath(source),
            stat = await fs.stat(dir);
          if (!stat.isDirectory() && !(stat.isFile() && /\.zip$/i.test(dir)))
            throw new Error('Client sources must be local directories or Solution ZIP files.');
          return { type: stat.isDirectory() ? 'directory' : 'zip', dir };
        }),
      );
      codeComponents = undefined;
    } catch (error) {
      return finish({
        resources: [],
        pcf: { controls: [] },
        assets: new Map(),
        ribbonDocuments: [],
        appActions: [],
        diagnostics: [{ code: 'MODEL_CLIENT_SOURCE_INVALID', message: error.message }],
      });
    }
  }
  roots = await Promise.all(
    layers
      .filter((layer) => layer?.dir)
      .map(async (layer) => ({
        label: path.basename(layer.dir),
        dirs: [layer.dir, await fs.realpath(layer.dir).catch(() => layer.dir)],
      })),
  );
  for (const layer of layers) {
    let entries;
    try {
      budget.take('layers', 1);
      entries = await layerEntries(layer, budget);
    } catch (error) {
      if (limited(error)) return failLimit(error, layer.dir);
      diagnostics.push({ code: 'MODEL_CLIENT_IMPORT_FAILED', source: layer.dir, message: error.message });
      continue;
    }
    const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
    for (const entry of entries.filter((entry) => /^appactions\/.*\/appaction\.xml$/i.test(entry.name))) {
      try {
        actionDocuments.push({
          ...entry,
          data: await readEntry(entry),
          source: entry.file ?? `${layer.dir}!/${entry.name}`,
        });
      } catch (error) {
        if (limited(error)) return failLimit(error, layer.dir);
        diagnostics.push({ code: 'MODEL_APP_ACTION_INVALID', source: entry.name, message: error.message });
      }
    }
    const definitions = [];
    for (const entry of entries.filter((entry) => /\.xml$/i.test(entry.name))) {
      // Restrict XML parsing to the component areas we consume.
      if (!/^(?:webresources\/|(?:other\/)?customizations\.xml$|entities\/.*ribbondiff\.xml$)/i.test(entry.name))
        continue;
      try {
        const xml = (await readEntry(entry)).toString('utf8'),
          tree = parseSolutionXml(xml);
        if (/RibbonDiffXml[\s>]/.test(xml)) {
          const entity = /^entities\/([^/]+)\//i.exec(entry.name)?.[1]?.toLowerCase();
          const source = entry.file ?? `${layer.dir}!/${entry.name}`;
          if (entity) ribbonDocuments.push({ xml, entity, source });
          else
            for (const node of descendants(tree, 'Entity')) {
              const name = childText(node, 'Name') ?? child(node, 'Name')?.attrs.OriginalName;
              for (const ribbon of descendants(node, 'RibbonDiffXml'))
                if (name) ribbonDocuments.push({ xml: serializeXml(ribbon), entity: name.toLowerCase(), source });
            }
        }
        for (const node of tree.name === 'WebResource' ? [tree] : descendants(tree, 'WebResource')) {
          const name = childText(node, 'Name') ?? childText(node, 'name');
          const type = Number(childText(node, 'WebResourceType') ?? childText(node, 'webresourcetype'));
          const file =
            childText(node, 'FileName') ?? childText(node, 'filename') ?? entry.name.replace(/\.data\.xml$/i, '');
          const unpacked =
            /^webresources\//i.test(entry.name) &&
            /\.data\.xml$/i.test(entry.name) &&
            entry.name.replace(/^webresources\//i, '').replace(/\.data\.xml$/i, '') === name
              ? entry.name.replace(/\.data\.xml$/i, '')
              : null;
          const id = childText(node, 'WebResourceId') ?? childText(node, 'webresourceid');
          if (name && [1, 2, 3, 5, 6, 7, 11].includes(type)) definitions.push({ name, type, file, unpacked, id });
        }
      } catch (error) {
        if (limited(error)) return failLimit(error, layer.dir);
        diagnostics.push({ code: 'MODEL_CLIENT_XML_INVALID', source: entry.name, message: error.message });
      }
    }
    for (const definition of definitions) {
      const url = `/_apps/resources/${token(definition.name)}`;
      resources.delete(definition.name);
      assets.delete(url);
      try {
        // PAC's unpacked .data.xml retains the packed FileName. Its paired physical
        // file is authoritative only when the exported Name exactly matches that pair.
        const file = solutionAssetName(definition.file.replace(/^\/(?=WebResources\/)/i, ''));
        const entry =
          byName.get(file.toLowerCase()) ??
          byName.get(`webresources/${file}`.toLowerCase()) ??
          (definition.unpacked && byName.get(definition.unpacked.toLowerCase()));
        if (!entry) throw new Error('Declared WebResource file is missing or oversized.');
        const data = await readEntry(entry);
        if (data.length > limit) throw new Error('Declared WebResource file is missing or oversized.');
        // ponytail: an HTML page is served at its hashed /_apps/resources/ URL, so its relative links to sibling web resources do not resolve; upgrade by serving web resources under their names.
        const imageMime = { 5: 'image/png', 6: 'image/jpeg', 7: 'image/gif', 11: 'image/svg+xml' }[definition.type];
        resources.set(definition.name, {
          name: definition.name,
          id: definition.id?.replace(/[{}]/g, '').toLowerCase(),
          url,
          type: imageMime ? 'image' : definition.type === 3 ? 'script' : definition.type === 1 ? 'page' : 'style',
          source: entry.file ? shown(entry.file) : `${shown(layer.dir)}!/${entry.name}`,
        });
        assets.set(url, {
          data,
          mime:
            imageMime ??
            (definition.type === 3
              ? 'text/javascript; charset=utf-8'
              : definition.type === 1
                ? 'text/html; charset=utf-8'
                : 'text/css; charset=utf-8'),
          ...(imageMime ? { passive: true } : {}),
          file: entry.file,
          name: definition.name,
        });
      } catch (error) {
        if (limited(error)) return failLimit(error, layer.dir);
        diagnostics.push({ code: 'MODEL_WEBRESOURCE_UNRESOLVED', name: definition.name, message: error.message });
      }
    }
  }
  let components;
  try {
    components = codeComponents ?? (await importCodeComponents(layers, { readFile }));
  } catch (error) {
    if (limited(error)) return failLimit(error, 'PCF');
    diagnostics.push({ code: 'MODEL_PCF_IMPORT_FAILED', message: error.message });
    components = { controls: new Map(), assets: new Map(), diagnostics: [] };
  }
  diagnostics.push(...components.diagnostics);
  const controls = [];
  for (const control of components.controls.values()) {
    const urls = { code: [], css: [], exports: [], resx: {} };
    const controlAssets = new Map();
    try {
      budget.take('entries', 1);
      if (control.file) {
        const root = path.dirname(control.file);
        await readFile(control.file, { root, maxBytes: 1024 * 1024 });
        await readFile(path.join(root, 'ControlManifest.xml.data.xml'), { root, maxBytes: 1024 * 1024 });
      }
      for (const resource of control.resources) {
        budget.take('entries', 1);
        const asset = components.assets.get(resource.url);
        if (!asset) continue;
        const url = resource.url.replace('/__sim-static/pcf/', '/_apps/controls/');
        const data = await readFile(asset.file, { root: asset.root });
        if (['code', 'css'].includes(resource.kind)) {
          controlAssets.set(url, {
            data,
            mime:
              mime(resource.path) ??
              (resource.kind === 'code' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'),
            file: asset.file,
            name: `${control.schemaName}/${resource.path}`,
          });
          urls[resource.kind].push(url);
          if (resource.exportGlobal) urls.exports.push(resource.exportGlobal);
        }
      }
      // A deterministic exported fallback; selected language support can layer over this.
      for (const resource of control.stringResources ?? [])
        if (resource.lcid === 1033) Object.assign(urls.resx, resource.strings);
      controls.push({
        name: control.schemaName,
        constructor: control.constructor,
        controlType: control.type,
        datasets: control.datasets,
        properties: control.properties.map((property) => ({
          ...property,
          ofType: property['of-type'] ?? property.types?.[0],
        })),
        features: control.features,
        libraries: control.libraries,
        resources: urls,
      });
      for (const [url, asset] of controlAssets) assets.set(url, asset);
    } catch (error) {
      if (limited(error)) return failLimit(error, control.schemaName);
      diagnostics.push({ code: 'MODEL_PCF_RESOURCE_UNRESOLVED', name: control.schemaName, message: error.message });
    }
  }
  const webresourcesById = new Map(
    [...resources.values()].filter((resource) => resource.id).map((resource) => [resource.id, resource.name]),
  );
  const appActions = actionDocuments.flatMap((entry) => {
    try {
      const command = parseAppActionCommand(entry.data.toString('utf8'), { webresourcesById });
      if (!command) throw new Error('Expected an AppAction definition.');
      return [{ ...command, sourceKind: command.source, source: entry.source }];
    } catch (error) {
      diagnostics.push({ code: 'MODEL_APP_ACTION_INVALID', source: entry.name, message: error.message });
      return [];
    }
  });
  return finish({
    resources: [...resources.values()],
    pcf: { controls, ...(platformLibraries.length ? { platformLibraries } : {}) },
    assets,
    ribbonDocuments,
    appActions,
    diagnostics,
  });
}

export function clientExtensionCatalogue(imported, settings) {
  return {
    trusted: settings.trustedExtensions,
    resources: imported?.resources ?? [],
    pcf: imported?.pcf ?? { controls: [] },
    diagnostics: imported?.diagnostics ?? [],
  };
}
