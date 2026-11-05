// Bounded, read-only source inventory. No project modules, commands or URLs are executed.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { readLocalFileSync, realLocalPath } from '../local-file.mjs';
import { componentContent, componentContentSpan, componentIdentity, componentEnvelope } from '../portal-model.mjs';
import { COMPONENT_KINDS } from '../../mirage/lib/portal-component-types.mjs';

export const ANALYSIS_LIMITS = Object.freeze({
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
const ignored = new Set([
  'node_modules',
  '.git',
  '.paqvilo',
  '.portalconfig',
  'deployment-profiles',
  'dist',
  'build',
  'out',
  'coverage',
  'artifacts',
  'logs',
  'metrics',
  'tmp',
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
  const fields = componentContent(text);
  const span = componentContentSpan(text);
  const envelope = componentEnvelope(text);
  const kind = COMPONENT_KINDS[Number(envelope?.powerpagecomponenttype)];
  if (!fields || !envelope) {
    state.syntax.push({ file, line: 1, column: 1 });
    state.complete = false;
    return;
  }
  if (!kind) {
    skip(state, file, 'unsupported-component-type');
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

function classify(file) {
  const name = path.basename(file);
  const record = recordName.exec(name)?.[1].toLowerCase();
  if (record) return { record: record === 'entitypermission' ? 'tablepermission' : record };
  if (name.toLowerCase() === 'powerpagecomponent.xml') return { component: true };
  const extension = path.extname(name).toLowerCase();
  if (['.html', '.htm', '.liquid'].includes(extension)) return { kind: 'html' };
  if (extension === '.css') return { kind: 'css' };
  if (['.js', '.mjs'].includes(extension)) return { kind: 'js' };
  return null;
}

function skip(state, file, reason) {
  state.complete = false;
  // The file budget also bounds diagnostic output, even for a huge ignored/unreadable tree.
  if (state.skipped.length < state.limits.files) state.skipped.push({ file, reason });
}

function readSource(state, root, absolute, file, type) {
  try {
    const size = fs.lstatSync(absolute).size;
    if (size > state.limits.fileBytes) return skip(state, file, 'file-size-limit');
    if (state.stats.bytes + size > state.limits.totalBytes) return skip(state, file, 'total-size-limit');
    const bytes = readLocalFileSync(absolute, {
      root,
      maxBytes: state.limits.fileBytes,
      expectedRealPath: absolute,
    });
    const text = bytes.toString('utf8');
    state.stats.bytes += bytes.length;
    state.stats.files++;
    state.digest.update(file).update('\0').update(bytes).update('\0');
    if (type.record) parseYaml(state, text, file, type.record);
    else if (type.component) parseComponent(state, text, file);
    else state.units.push({ file, text, kind: type.kind, line: 1, column: 1, exactLocation: true });
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
    for (let entry; (entry = handle.readSync());) {
      if (++state.stats.entries > state.limits.entries) {
        skip(state, path.relative(root, directory).replaceAll('\\', '/') || '.', 'entry-count-limit');
        break;
      }
      entries.push(entry);
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

function inspectEntry(state, root, directory, pending, entry) {
  if (ignored.has(entry.name.toLowerCase()) || (entry.name.startsWith('.') && entry.name !== '.powerpages-site'))
    return true;
  const absolute = path.join(directory, entry.name);
  const file = path.relative(root, absolute).replaceAll('\\', '/');
  if (entry.isSymbolicLink()) {
    skip(state, file, 'symbolic-link');
    return true;
  }
  if (entry.isDirectory()) {
    if (++state.stats.directories > state.limits.directories) {
      skip(state, file, 'directory-limit');
      return false;
    }
    pending.push(absolute);
    return true;
  }
  if (!entry.isFile()) return true;
  const type = classify(file);
  if (!type) return true;
  if (++state.stats.candidates > state.limits.files) {
    skip(state, file, 'file-count-limit');
    return false;
  }
  readSource(state, root, absolute, file, type);
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

/** Completeness is relative to the documented source kinds and budgets, never a security verdict. */
export function collectAnalysisSources(sourceDir, overrides) {
  const limits = analysisLimits(overrides);
  const root = fs.realpathSync.native(path.resolve(sourceDir));
  const state = {
    records: [],
    units: [],
    syntax: [],
    skipped: [],
    complete: true,
    stats: { candidates: 0, files: 0, directories: 1, entries: 0, bytes: 0 },
    limits,
    digest: createHash('sha256'),
  };
  const pending = [root];
  while (
    pending.length &&
    state.stats.candidates <= limits.files &&
    state.stats.directories <= limits.directories &&
    state.stats.entries <= limits.entries
  )
    inspectDirectory(state, root, pending.pop(), pending);
  addEmbeddedUnits(state);
  if (!state.stats.files) skip(state, '.', 'no-supported-sources');
  state.sourceDigest = state.digest.digest('hex');
  delete state.digest;
  return state;
}
