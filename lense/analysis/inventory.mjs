// Bounded, read-only source inventory. No project modules, commands or URLs are executed.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { readLocalFileSync, realLocalPath } from '../local-file.mjs';
import { componentPayload, componentContentSpan, componentIdentity, componentEnvelope } from '../portal-model.mjs';
import { COMPONENT_KINDS } from '../../mirage/lib/portal-component-types.mjs';
import { readSolutionAssetEntries, SOLUTION_ASSET_LIMITS } from '../../mirage/lib/dataverse-solution-assets.mjs';

export const ANALYSIS_LIMITS = Object.freeze({
  roots: 128,
  files: 10000,
  directories: 10000,
  entries: 100000,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
});
function analysisLimits(overrides = {}) {
  const limits = { ...ANALYSIS_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Object.hasOwn(ANALYSIS_LIMITS, key) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > ANALYSIS_LIMITS[key]
    )
      throw new Error('Invalid static analysis limit');
  }
  return limits;
}
const privateNames = new Set(['node_modules', '.git', '.paqvilo', '.portalconfig', 'deployment-profiles']);
const outputNames = new Set(['dist', 'build', 'out', 'coverage', 'artifacts', 'logs', 'metrics', 'tmp']);
// These folders hold authored records whose names the author chooses.
const sourceContentFolders = new Set([
  'web-pages',
  'web-templates',
  'content-snippets',
  'web-files',
  'basic-forms',
  'advanced-forms',
  'lists',
  'page-templates',
  '.powerpages-site',
  'webresources',
]);
const recordName =
  /(?:^|\.)(website|sitesetting|webrole|tablepermission|entitypermission|webpage|webtemplate|contentsnippet|basicform|list|advancedformstep)\.ya?ml$/i;
const rendered = {
  source: 'html',
  copy: 'html',
  summary: 'html',
  value: 'html',
  customjavascript: 'js',
  customcss: 'css',
};
const suffix = {
  source: 'source.html',
  copy: 'copy.html',
  summary: 'summary.html',
  value: 'value.html',
  customjavascript: 'custom_javascript.js',
  customcss: 'custom_css.css',
};
const canonical = (key) =>
  String(key)
    .toLowerCase()
    .replace(/^(?:adx_|mspp_)/, '');
function normalizeFields(fields) {
  const pairs = Object.entries(fields).map(([key, value]) => [canonical(key), value]);
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) throw new Error('Ambiguous canonical fields');
  return Object.fromEntries(pairs);
}
const position = (counter, offset) => {
  const value = counter.linePos(offset ?? 0);
  return { line: value.line, column: value.col };
};

function addRecord(state, node, fields, kind, file, counter) {
  if (state.records.length >= state.limits.files) {
    skip(state, file, 'record-count-limit');
    return;
  }
  if (!YAML.isMap(node)) throw new Error('Expected record mapping');
  const locations = {};
  for (const pair of node.items) locations[canonical(pair.key?.value)] = position(counter, pair.key?.range?.[0]);
  state.records.push({
    kind,
    file,
    fields: normalizeFields(fields),
    fieldLocations: locations,
    ...position(counter, node.range?.[0]),
    exactLocation: true,
  });
}

function parseYaml(state, text, file, kind) {
  const counter = new YAML.LineCounter();
  const document = YAML.parseDocument(text, { lineCounter: counter, uniqueKeys: true });
  if (document.errors.length) {
    for (const error of document.errors) state.syntax.push({ file, ...position(counter, error.pos?.[0]) });
    state.complete = false;
    return;
  }
  // Alias expansion can hide identities and produce cycles; the analysis contract leaves it unresolved.
  const data = document.toJS({ maxAliasCount: 0 });
  if (YAML.isSeq(document.contents)) {
    if (document.contents.items.some((node) => !YAML.isMap(node))) throw new Error('Expected record mappings');
    document.contents.items.forEach((node, index) => addRecord(state, node, data[index], kind, file, counter));
  } else addRecord(state, document.contents, data, kind, file, counter);
}

function parseComponent(state, text, file) {
  if (state.records.length >= state.limits.files) {
    skip(state, file, 'record-count-limit');
    return;
  }
  const payload = componentPayload(text);
  const fields = payload.value;
  const span = componentContentSpan(text);
  const envelope = componentEnvelope(text);
  const kind = COMPONENT_KINDS[Number(envelope?.powerpagecomponenttype)];
  if (!envelope) {
    state.syntax.push({ file, line: 1, column: 1 });
    state.complete = false;
    return;
  }
  if (!kind) {
    skip(state, file, 'unsupported-component-type');
    return;
  }
  if (!fields) {
    if (payload.status === 'invalid') {
      state.syntax.push({ file, line: 1, column: 1 });
      state.complete = false;
      return;
    }
    state.incomplete.push({ file, line: 1, column: 1 });
    skip(state, file, `component-payload-${payload.status}`);
    return;
  }
  const start = span.contentStart;
  const before = text.slice(0, start).split('\n');
  const normalized = normalizeFields(fields);
  normalized.name ??= envelope.name;
  normalized.id = componentIdentity(text) ?? normalized.id;
  const statecode = envelope.statecode?.trim();
  if (statecode !== undefined) normalized.statecode = statecode;
  normalized.websiteid ??= envelope.powerpagesiteid?.trim() ?? envelope.websiteid?.trim();
  state.records.push({
    kind,
    file,
    fields: normalized,
    fieldLocations: {},
    line: before.length,
    column: before.at(-1).length + 1,
    exactLocation: false,
  });
}

function classify(file, platform = false) {
  const name = path.basename(file);
  const record = recordName.exec(name)?.[1].toLowerCase();
  if (record) return { record: record === 'entitypermission' ? 'tablepermission' : record };
  if (name.toLowerCase() === 'powerpagecomponent.xml') return { component: true };
  const extension = path.extname(name).toLowerCase();
  if (platform && ['yarn.lock', 'bun.lock', 'bun.lockb', 'Podfile'].includes(name)) return { platform: true };
  if (['.html', '.htm', '.liquid'].includes(extension)) return { kind: 'html' };
  if (extension === '.css') return { kind: 'css' };
  if (['.js', '.mjs', '.cjs'].includes(extension)) return { kind: 'js' };
  if (platform && ['.msapp', '.zip', '.ppmplugin'].includes(extension)) return { archive: true };
  if (
    platform &&
    [
      '.json',
      '.xml',
      '.resx',
      '.yaml',
      '.yml',
      '.ts',
      '.tsx',
      '.jsx',
      '.http',
      '.rest',
      '.pcfproj',
      '.csproj',
      '.props',
      '.targets',
      '.cs',
      '.kt',
      '.kts',
      '.gradle',
      '.m',
      '.h',
      '.swift',
    ].includes(extension)
  )
    return { platform: true };
  return null;
}

function skip(state, file, reason) {
  state.complete = false;
  state.gaps++;
  // The file budget also bounds diagnostic output, even for a huge ignored/unreadable tree.
  if (state.skipped.length < state.limits.files) state.skipped.push({ file, reason });
}

/** Editors write a UTF-8 byte order mark; it is not content, so analysis reads the text after it. */
export function stripByteOrderMark(text) {
  return text.startsWith(String.fromCodePoint(0xfeff)) ? text.slice(1) : text;
}

function addSourceBytes(state, bytes, file, type, relativeFile = file, archiveDepth = 0, rootId = state.rootId) {
  state.stats.bytes += bytes.length;
  state.stats.files++;
  state.digest.update(file).update('\0').update(bytes).update('\0');
  if (type.archive) {
    const container = {
      file,
      relativeFile,
      rootId,
      text: '',
      archive: true,
      archiveInspected: false,
      nativeManifestPresent: false,
    };
    state.inputs.push(container);
    return readArchive(state, bytes, file, archiveDepth, rootId, container);
  }
  const text = stripByteOrderMark(bytes.toString('utf8'));
  state.inputs.push({ file, relativeFile, rootId, text, line: 1, column: 1, exactLocation: true });
  const first = state.records.length;
  try {
    if (type.record) parseYaml(state, text, file, type.record);
    else if (type.component) parseComponent(state, text, file);
    else if (type.kind) state.units.push({ file, text, kind: type.kind, line: 1, column: 1, exactLocation: true });
  } finally {
    for (let index = first; index < state.records.length; index++) state.records[index].rootId = rootId;
  }
}

function readArchive(state, bytes, file, depth, rootId, container) {
  if (depth >= 3) return skip(state, file, 'archive-depth-limit');
  try {
    const available = state.limits.totalBytes - state.stats.bytes;
    if (available < 1) return skip(state, file, 'total-size-limit');
    const remainingEntries = state.limits.entries - state.stats.entries;
    if (remainingEntries < 1) return skip(state, file, 'entry-count-limit');
    const entries = readSolutionAssetEntries(bytes, {
      archiveBytes: state.limits.fileBytes,
      entryBytes: state.limits.fileBytes,
      totalBytes: available,
      entries: Math.min(remainingEntries, SOLUTION_ASSET_LIMITS.entries),
      onEntry: (name) => {
        state.stats.entries++;
        if (name === 'manifest.json') container.nativeManifestPresent = true;
      },
      include: (name) => Boolean(classify(name, true)) && !excludedArchiveEntry(name),
    });
    container.archiveInspected = true;
    for (const entry of entries) {
      const name = `${file}!/${entry.name}`;
      const type = classify(entry.name, true);
      if (++state.stats.candidates > state.limits.files) {
        skip(state, file, 'file-count-limit');
        break;
      }
      addSourceBytes(state, entry.data, name, type, entry.name, depth + 1, `${rootId}!${file}`);
    }
  } catch {
    skip(state, file, 'unreadable-or-unsupported-archive');
  }
}

function readSource(state, root, absolute, file, type, relativeFile) {
  try {
    if (state.seenFiles.has(absolute)) return;
    const size = fs.lstatSync(absolute).size;
    if (size > state.limits.fileBytes) return skip(state, file, 'file-size-limit');
    if (state.stats.bytes + size > state.limits.totalBytes) return skip(state, file, 'total-size-limit');
    const bytes = readLocalFileSync(absolute, {
      root,
      maxBytes: state.limits.fileBytes,
      expectedRealPath: absolute,
    });
    if (state.stats.bytes + bytes.length > state.limits.totalBytes) return skip(state, file, 'total-size-limit');
    state.seenFiles.add(absolute);
    addSourceBytes(state, bytes, file, type, relativeFile);
  } catch {
    skip(state, file, 'unreadable-or-unsupported-source');
  }
}

function readDirectoryEntries(state, root, directory) {
  const entries = [];
  let handle;
  try {
    if (realLocalPath(directory) !== directory) throw new Error('Directory changed');
    handle = fs.opendirSync(directory);
    if (realLocalPath(directory) !== directory) throw new Error('Directory changed at open');
    let entry = handle.readSync();
    while (entry) {
      if (++state.stats.entries > state.limits.entries) {
        skip(state, path.relative(root, directory).replaceAll('\\', '/') || '.', 'entry-count-limit');
        break;
      }
      entries.push(entry);
      entry = handle.readSync();
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  } catch {
    skip(state, path.relative(root, directory).replaceAll('\\', '/') || '.', 'unreadable-directory');
    return null;
  } finally {
    handle?.closeSync();
  }
  return entries;
}

function insideSourceContent(root, directory) {
  const folders = [path.basename(root), ...path.relative(root, directory).split(/[\\/]/)];
  return folders.some((folder) => sourceContentFolders.has(folder.toLowerCase()));
}
function excludedArchiveEntry(name) {
  const parts = name.split('/');
  return parts.some((part, index) => {
    const lower = part.toLowerCase();
    if (privateNames.has(lower) || (part.startsWith('.') && part !== '.powerpages-site')) return true;
    return (
      outputNames.has(lower) && !parts.slice(0, index).some((folder) => sourceContentFolders.has(folder.toLowerCase()))
    );
  });
}

function inspectEntry(state, root, directory, pending, entry) {
  const name = entry.name.toLowerCase();
  if (privateNames.has(name) || (entry.name.startsWith('.') && entry.name !== '.powerpages-site')) return true;
  if (outputNames.has(name) && !insideSourceContent(root, directory)) return true;
  const absolute = path.join(directory, entry.name);
  const relativeFile = path.relative(root, absolute).replaceAll('\\', '/');
  const file = state.prefix + relativeFile;
  if (entry.isSymbolicLink()) {
    skip(state, file, 'symbolic-link');
    return true;
  }
  if (nestedSelectedRoot(state, absolute)) return true;
  if (entry.isDirectory()) {
    if (++state.stats.directories > state.limits.directories) {
      skip(state, file, 'directory-limit');
      return false;
    }
    pending.push(absolute);
    return true;
  }
  if (!entry.isFile()) return true;
  if (state.seenFiles.has(absolute)) return true;
  const type = classify(file, state.platform);
  if (!type) return true;
  if (++state.stats.candidates > state.limits.files) {
    skip(state, file, 'file-count-limit');
    return false;
  }
  readSource(state, root, absolute, file, type, relativeFile);
  return true;
}

function inspectDirectory(state, root, directory, pending) {
  const entries = readDirectoryEntries(state, root, directory);
  if (!entries) return;
  for (const entry of entries) {
    if (!inspectEntry(state, root, directory, pending, entry)) return;
  }
}

function embeddedUnit(record, field, kind, files) {
  // A setting's value is configuration, never executable markup.
  if (field === 'value' && record.kind !== 'contentsnippet') return null;
  const text = record.fields[field];
  if (typeof text !== 'string' || !text) return null;
  const sidecar = record.file.replace(/\.ya?ml$/i, '.' + suffix[field]);
  if (files.has(sidecar)) return null;
  return {
    file: record.file,
    text,
    kind,
    field,
    recordId: record.fields.id ?? record.fields[`${record.kind}id`],
    ...(record.fieldLocations[field] ?? { line: record.line, column: record.column }),
    exactLocation: false,
  };
}

function addEmbeddedUnits(state) {
  const files = new Set(state.units.map((unit) => unit.file));
  for (const record of state.records) {
    if (Number(record.fields.statecode ?? 0) === 1) continue;
    for (const [field, kind] of Object.entries(rendered)) {
      const unit = embeddedUnit(record, field, kind, files);
      if (!unit) continue;
      if (state.units.length >= state.limits.files) {
        skip(state, record.file, 'content-unit-limit');
        return;
      }
      state.units.push(unit);
    }
  }
}

/** Configured roots share one inventory budget; no project modules or source programs are loaded. */
export function collectAnalysisInputs(roots, overrides, { platform = true } = {}) {
  const limits = analysisLimits(overrides);
  const state = {
    inputs: [],
    records: [],
    units: [],
    syntax: [],
    incomplete: [],
    skipped: [],
    complete: true,
    gaps: 0,
    stats: { candidates: 0, files: 0, directories: 0, entries: 0, bytes: 0 },
    limits,
    platform,
    roots: [],
    seenFiles: new Set(),
    digest: createHash('sha256'),
  };
  if (!Array.isArray(roots)) throw new Error('Static analysis roots must be an array');
  const selectedRoots = roots.slice(0, limits.roots);
  if (new Set(selectedRoots.map((root) => root?.id)).size !== selectedRoots.length)
    throw new Error('Static analysis source root identities must be unique');
  const reals = selectedRoots.map((root) => {
    try {
      return fs.realpathSync.native(path.resolve(root.path));
    } catch {
      return null;
    }
  });
  state.rootPaths = new Set(reals.filter(Boolean));
  state.labelBase = roots.length > 1 ? commonDirectory(reals.map((real) => (real ? dirOf(real) : null))) : null;
  for (const [index, selected] of roots.entries()) {
    if (index >= limits.roots) {
      skip(state, '.', 'root-count-limit');
      break;
    }
    inspectRoot(state, selected, roots.length > 1, reals[index]);
  }
  addEmbeddedUnits(state);
  if (!state.stats.files) skip(state, '.', 'no-supported-sources');
  state.sourceDigest = state.digest.digest('hex');
  delete state.digest;
  delete state.seenFiles;
  delete state.rootId;
  delete state.prefix;
  delete state.rootPaths;
  delete state.labelBase;
  delete state.currentRoot;
  delete state.platform;
  delete state.gaps;
  return state;
}

function inspectRoot(state, selected, multiple, real) {
  const id = selected?.id;
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(id) || typeof selected.path !== 'string')
    throw new Error('Invalid static analysis source root');
  state.rootId = id;
  state.currentRoot = real;
  state.prefix = multiple ? rootPrefix(state.labelBase, real, id) : '';
  const rootInfo = { id, kind: selected.kind ?? 'source', complete: true };
  state.roots.push(rootInfo);
  const skippedBefore = state.gaps;
  try {
    const requested = path.resolve(selected.path);
    if (excludedRoot(requested, isFileRoot(requested))) {
      skip(state, id, 'ignored-root');
    } else {
      const root = fs.realpathSync.native(requested);
      inspectResolvedRoot(state, root, id);
    }
  } catch {
    skip(state, id, 'unreadable-source-root');
  }
  rootInfo.complete = skippedBefore === state.gaps;
}

const posixTemporaryRoots = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];
// Private names exclude any component after a fixed POSIX temporary prefix, for the requested and canonical path.
// Output names exclude only the components the selection names: the path under the working directory,
// or the root's own name. A file root also names its immediate parent folder.
// TMPDIR is never an exemption: it can itself contain private or generated directories.
function excludedRoot(root, fileRoot) {
  const temporaryRoot =
    process.platform !== 'win32' &&
    posixTemporaryRoots.find((prefix) => root === prefix || root.startsWith(prefix + '/'));
  const sourcePath = temporaryRoot ? root.slice(temporaryRoot.length) : root;
  if (sourcePath.split(/[\\/]/).some((part) => privateNames.has(part.toLowerCase()))) return true;
  const parts = selectedParts(root);
  if (fileRoot) parts.push(path.basename(path.dirname(root)));
  return parts.some((part) => outputNames.has(part.toLowerCase()));
}
function selectedParts(root) {
  const relative = path.relative(process.cwd(), root);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  return inside ? relative.split(/[\\/]/) : [path.basename(root)];
}
function isFileRoot(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
function dirOf(real) {
  return isFileRoot(real) ? path.dirname(real) : real;
}
// The deepest folder that contains every directory, or null when there is none short of a filesystem root.
function commonDirectory(dirs) {
  if (!dirs.length || dirs.some((dir) => dir === null)) return null;
  const inside = (base, dir) => {
    const relative = path.relative(base, dir);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  let base = dirs[0];
  while (!dirs.every((dir) => inside(base, dir))) {
    const up = path.dirname(base);
    if (up === base) return null;
    base = up;
  }
  return path.parse(base).root === base ? null : base;
}
// Several roots label files relative to their common folder; without one, each label starts with the root id.
function rootPrefix(base, real, id) {
  if (!base || !real) return id + '/';
  const relative = path.relative(base, dirOf(real)).replaceAll('\\', '/');
  return relative ? relative + '/' : '';
}
// A selected root nested in another selected root is read only as itself, whatever the order of roots.
// No resolution is needed: each root is walked from its real path and symbolic links are skipped before this check,
// so every absolute path reaching here is already real.
function nestedSelectedRoot(state, absolute) {
  return state.rootPaths.size > 1 && absolute !== state.currentRoot && state.rootPaths.has(absolute);
}
function inspectResolvedRoot(state, root, id) {
  const stat = fs.statSync(root);
  if (excludedRoot(root, stat.isFile())) return skip(state, id, 'ignored-root');
  if (stat.isFile()) return inspectRootFile(state, root, id);
  if (!stat.isDirectory()) return skip(state, id, 'unsupported-source-root');
  if (++state.stats.directories > state.limits.directories) return skip(state, id, 'directory-limit');
  const pending = [root];
  while (
    pending.length &&
    state.stats.candidates <= state.limits.files &&
    state.stats.directories <= state.limits.directories &&
    state.stats.entries <= state.limits.entries
  )
    inspectDirectory(state, root, pending.pop(), pending);
}
function inspectRootFile(state, root, id) {
  const type = classify(root, state.platform);
  const name = path.basename(root);
  if (!type || name.startsWith('.')) return skip(state, id, 'unsupported-source-root');
  if (++state.stats.candidates > state.limits.files) return skip(state, id, 'file-count-limit');
  readSource(state, path.dirname(root), root, state.prefix + name, type, name);
}
