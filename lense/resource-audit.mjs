// An independent disk inventory: a mapper cannot prove coverage using only its own output.
// No source bodies or credentials are returned, and no portal requests are made.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isSourceFile, isEnhancedSiteMetadata } from './portal-model.mjs';
import { Resolver } from './resolver.mjs';
import { inspectComponentJson } from './audit-json.mjs';
import { hasDelimitedText } from '../mirage/lib/text-scanning.mjs';

const CODE_FILE = /\.(?:[cm]?js|css|html?)$/i;
const CODE_FIELD = /(?:javascript|stylesheet|(?:^|_)css$|(?:^|_)html$|customcss|customscript)/i;
const MARKUP = /<(?:[a-z][\w:-]*)(?:\s[^<>]*|\/?)>/i;
const SKIP = new Set(['.git', '.paqvilo', 'node_modules']);
const compare = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};
const normalize = (file) => file.replaceAll('\\', '/');
const SOURCE_FIELDS = new Set([
  'adx_copy',
  'adx_summary',
  'adx_source',
  'adx_value',
  'copy',
  'summary',
  'source',
  'value',
]);

// Recognize standard content fields even when empty. Unknown nonempty HTML/code fields
// remain gaps until a handler or a precise deployment-only classification is supplied.
function languageOf(key, value, context) {
  if (/javascript|customscript/i.test(key)) return 'javascript';
  if (/stylesheet|(?:^|_)css$|customcss/i.test(key)) return 'css';
  if (
    /(?:^|_)html$/i.test(key) ||
    MARKUP.test(value) ||
    hasDelimitedText(value, '{%', '%}') ||
    hasDelimitedText(value, '{{', '}}')
  )
    return 'html';
  if (SOURCE_FIELDS.has(key) && /(?:webpage|webtemplate|contentsnippet|type:[278])\b/i.test(context)) return 'html';
  return null;
}

function strings(value, visit, parts = [], ancestors = new Set()) {
  if (typeof value === 'string') {
    visit(parts, value);
    return;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) strings(item, visit, [...parts, key], ancestors);
  ancestors.delete(value);
}

// Visit the syntax tree rather than converting YAML to an object: duplicate keys must
// not silently overwrite earlier code fields in the inventory. They remain diagnostics.
function yamlStrings(node, document, visit, parts = [], ancestors = new Set()) {
  if (!node || ancestors.has(node)) return;
  if (YAML.isScalar(node)) {
    if (typeof node.value === 'string') visit(parts, node.value);
    return;
  }
  ancestors.add(node);
  if (YAML.isAlias(node)) yamlStrings(node.resolve(document), document, visit, parts, ancestors);
  else if (YAML.isSeq(node))
    node.items.forEach((item, index) => yamlStrings(item, document, visit, [...parts, String(index)], ancestors));
  else if (YAML.isMap(node)) {
    const seen = new Map();
    for (const pair of node.items) {
      const key = String(pair.key?.value ?? '');
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      yamlStrings(
        pair.value,
        document,
        visit,
        [...parts, occurrence ? `${key}[duplicate:${occurrence}]` : key],
        ancestors,
      );
    }
  }
  ancestors.delete(node);
}

function metadataReason(rel, key) {
  if (/^deployment-profiles\//i.test(rel))
    return 'Environment-specific deployment-profile override; the overlay does not apply deployment transformations.';
  if (key === 'notetext' && /\.webfile\.ya?ml$/i.test(rel))
    return 'Attachment annotation metadata, not the web-file response body.';
  if (/^(?:adx_)?(?:filter_definition|subgrid_settings|settings)$/i.test(key))
    return 'Serialized server-interpreted configuration; changing its rendering or queries requires deployment.';
  return null;
}

function addAuditEntry(state, file, field, extra = {}) {
  const rel = state.relative(file);
  const suffix = field ? `#${field}` : '';
  const id = `${rel}${suffix}`;
  const existing = state.entries.get(id);
  if (existing) {
    Object.assign(existing, extra);
    return existing;
  }
  const item = {
    id,
    relativePath: rel,
    field: field ?? null,
    kind: null,
    language: null,
    empty: null,
    status: 'gap',
    reason: 'No resource handler recognized this source.',
    ...extra,
  };
  state.entries.set(id, item);
  return item;
}
function readAuditSource(state, file) {
  try {
    if (!isSourceFile(state.root, file))
      throw Object.assign(new Error('Source path is unsafe.'), { code: 'UNSAFE_SOURCE' });
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    state.errors.push({
      relativePath: state.relative(file),
      reason: `Cannot read source: ${err.code ?? 'read failure'}`,
    });
    return null;
  }
}
function walkAuditDirectory(dir, state) {
  let children;
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    state.errors.push({
      relativePath: state.relative(dir),
      reason: `Cannot inventory directory: ${err.code ?? 'read failure'}`,
    });
    return;
  }
  for (const child of children.sort((a, b) => compare(a.name, b.name))) {
    const file = path.join(dir, child.name);
    if (child.isSymbolicLink()) {
      state.excluded.push({
        relativePath: state.relative(file),
        reason: 'Symbolic links and junctions are not traversed.',
      });
      continue;
    }
    if (child.isDirectory()) {
      if (SKIP.has(child.name)) {
        state.excluded.push({
          relativePath: state.relative(file),
          reason: 'Tool state or dependencies, not portal export content.',
        });
        continue;
      }
      walkAuditDirectory(file, state);
    } else if (child.isFile()) state.files.push(file);
  }
}
function parseAuditYamlFile(file, rel, state) {
  const raw = readAuditSource(state, file);
  if (raw === null) return null;
  const document = YAML.parseDocument(raw);
  const fatal = document.errors.filter((error) => error.code !== 'DUPLICATE_KEY');
  if (fatal.length) {
    state.errors.push({ relativePath: rel, reason: 'Cannot parse YAML; fields were not inventoried.' });
    return null;
  }
  for (const error of document.errors)
    state.diagnostics.push({
      relativePath: rel,
      code: error.code,
      reason: 'Duplicate YAML key; every occurrence was inventoried, but deployment interpretation is ambiguous.',
    });
  const inactive = YAML.isMap(document.contents) && Number(document.get('statecode')) === 1;
  return { document, record: undefined, context: rel, inactive };
}
function parseAuditComponentFile(file, rel, state) {
  const raw = readAuditSource(state, file);
  if (raw === null) return null;
  const context = `type:${/<powerpagecomponenttype>\s*(\d+)\s*</.exec(raw)?.[1] ?? '?'}`;
  // Metadata-only components can legitimately have no <content> (e.g. page templates).
  if (!/<content\b/i.test(raw) && !/^type:(?:2|3|7|8|15|17|20)$/.test(context)) return null;
  const inspected = inspectComponentJson(raw);
  for (const diagnostic of inspected.diagnostics) state.errors.push({ relativePath: rel, ...diagnostic });
  const record = inspected.value;
  if (!record) return null;
  const inactive = /<statecode>\s*1\s*<\/statecode>/.test(raw);
  return { document: undefined, record, context, inactive };
}
function parseAuditStructuredFile(file, rel, state) {
  let source;
  if (/\.ya?ml$/i.test(file)) source = parseAuditYamlFile(file, rel, state);
  else if (/^powerpagecomponents\/[^/]+\/powerpagecomponent\.xml$/i.test(rel))
    source = parseAuditComponentFile(file, rel, state);
  else return null;
  if (!source) return null;
  state.metadata.set(file, { inactive: source.inactive });
  return { ...source, rel };
}
function auditValueIsInactive(parts, state, source) {
  return (
    source.inactive ||
    Boolean(
      source.document &&
      parts.some((_part, index) => {
        const prefix = parts.slice(0, index);
        return (
          Number(source.document.getIn([...prefix, 'statecode'])) === 1 ||
          ['adx_entityform', 'adx_webform', 'entityform', 'webform'].some((formKey) =>
            state.model.inactiveForms?.has(String(source.document.getIn([...prefix, formKey]) ?? '').toLowerCase()),
          )
        );
      }),
    )
  );
}
function nestedAuditStrings(parts, value, inheritedReason, depth, state, source) {
  let count = 0;
  try {
    const nested = JSON.parse(value);
    if (!nested || typeof nested !== 'object') return { count: 0, reason: inheritedReason };
    if (depth >= 16) {
      state.errors.push({
        relativePath: source.rel,
        reason: 'Serialized JSON nesting limit reached; inventory is incomplete.',
      });
      return { count: 0, reason: inheritedReason, stopped: true };
    }
    const nestedDocument = YAML.parseDocument(value);
    for (const error of nestedDocument.errors)
      state.diagnostics.push({
        relativePath: source.rel,
        code: error.code,
        reason: 'Duplicate serialized JSON key; every occurrence was inventoried, but its interpretation is ambiguous.',
      });
    yamlStrings(nestedDocument.contents, nestedDocument, (keys, text) => {
      count += visitAuditValue([...parts, ...keys], text, state, source, inheritedReason, depth + 1);
    });
    return {
      count,
      reason:
        inheritedReason ??
        'Serialized metadata container; literal text values are inventoried separately from server configuration.',
    };
  } catch {
    /* not JSON: retain as a candidate, never silently ignore it */
    return { count, reason: inheritedReason };
  }
}
function visitAuditValue(parts, value, state, source, inheritedReason = null, depth = 0) {
  const key = parts.at(-1) ?? '';
  const language = languageOf(key, value, source.context);
  let reason = inheritedReason ?? metadataReason(source.rel, key);
  const entryInactive = auditValueIsInactive(parts, state, source);
  let nestedCount = 0;
  // Localized metadata is a serialized JSON array. Inventory its literal strings
  // independently; the container's LCIDs and server settings still need deployment.
  if (/^\s*[[{]/.test(value)) {
    const nested = nestedAuditStrings(parts, value, reason, depth, state, source);
    if (nested.stopped) return 0;
    nestedCount = nested.count;
    reason = nested.reason;
  }
  if (!nestedCount && (!language || (!value.trim() && !CODE_FIELD.test(key) && !SOURCE_FIELDS.has(key)))) return 0;
  addAuditEntry(state, source.file, parts.join('.'), {
    language: language ?? 'container',
    empty: !value.trim(),
    ...(reason ? { status: 'deployment', reason } : {}),
    ...(entryInactive ? { status: 'inactive', reason: 'Inactive portal record is not rendered.' } : {}),
  });
  return nestedCount + 1;
}
function scanAuditFile(file, state) {
  const rel = state.relative(file);
  if (isEnhancedSiteMetadata(rel)) {
    const raw = readAuditSource(state, file);
    addAuditEntry(state, file, null, {
      kind: 'site-metadata',
      empty: raw === null ? null : !raw.trim(),
      status: 'deployment',
      reason:
        'Enhanced site and language configuration document; the overlay cannot apply its fields. This file classification does not attest field parsing or runtime behavior.',
    });
    return;
  }
  if (CODE_FILE.test(file)) {
    const text = readAuditSource(state, file);
    let language = 'html';
    if (/\.[cm]?js$/i.test(file)) language = 'javascript';
    else if (/\.css$/i.test(file)) language = 'css';
    addAuditEntry(state, file, null, { language, empty: text === null ? null : !text.trim() });
  }
  const source = parseAuditStructuredFile(file, rel, state);
  if (!source) return;
  source.file = file;
  if (source.document)
    yamlStrings(source.document.contents, source.document, (parts, value) =>
      visitAuditValue(parts, value, state, source),
    );
  else strings(source.record, (parts, value) => visitAuditValue(parts, value, state, source));
}
function applyInactiveEntries(state) {
  const inactiveSources = new Set((state.model.inactiveSources ?? []).map((source) => source.file));
  for (const item of state.entries.values()) {
    const file = path.join(state.root, item.relativePath);
    let mirage = null;
    if (/[\\/]web-files[\\/]/.test(file)) mirage = `${file}.webfile.yml`;
    else if (/\.[^./\\]+\.[^./\\]+$/.test(file)) mirage = file.replace(/\.[^./\\]+\.[^./\\]+$/, '.yml');
    if (
      ((!item.field || state.model.format === 'enhanced') && inactiveSources.has(file)) ||
      state.metadata.get(mirage)?.inactive
    )
      Object.assign(item, {
        status: 'inactive',
        reason: 'Inactive portal record or inactive language root is not rendered.',
      });
  }
}
/* NOSONAR: single-pass routine, splitting it would change shared state */ function applyInlineSources(state, site) {
  for (const source of state.model.inlineSources) {
    const file = source.file;
    const field = source.fieldPath
      ? [...source.fieldPath, ...(source.jsonPath ?? [])].join('.')
      : (source.field ?? null);
    // The enhanced mapper also offers absent/empty optional fields for future edits.
    // They are capabilities, not additional code occurrences found on disk.
    if (field && !state.entries.has(`${state.relative(file)}#${field}`)) continue;
    const item = addAuditEntry(state, file, field, { kind: source.kind });
    const supported = isSourceFile(state.root, file) && (!source.kind.startsWith('page-') || source.pageUrl != null);
    const settings = source.mode === 'block' ? site.inline : site.markup;
    let reason = 'Source is missing, unsafe, or its page URL cannot be resolved.';
    if (supported && source.mode === 'block')
      reason = 'Inline block handler; rendered-page matching still requires verification.';
    else if (supported) reason = 'Literal baseline patch handler; Liquid execution and runtime matching remain online.';
    Object.assign(item, {
      status: supported ? 'mapped' : 'blocked',
      reason,
      strategy: source.mode === 'block' ? 'inline-block' : 'baseline-patch',
      enabled: Boolean(settings?.enabled && settings.kinds.includes(source.kind)),
      pageUrl: source.pageUrl ?? null,
    });
  }
}
function applyWebFiles(state, resolver) {
  for (const resource of state.model.webFiles) {
    const file = resource.file ?? resource.yml;
    const item = addAuditEntry(state, file, resource.file ? null : '$attachment', {
      kind: 'web-file',
      url: resource.url,
    });
    const supported = Boolean(
      resource.file && resource.url && !resource.problem && isSourceFile(state.root, resource.file),
    );
    const reason =
      resource.problem ??
      (supported
        ? 'Local web-file response handler; request coverage still requires verification.'
        : 'Missing or unsafe content file or unresolved URL.');
    item.mappings ??= [];
    item.mappings.push({ metadataPath: state.relative(resource.yml), url: resource.url, supported, reason });
    const blocked = item.mappings.some((mapping) => !mapping.supported);
    Object.assign(item, {
      status: blocked ? 'blocked' : 'mapped',
      reason: blocked ? item.mappings.find((mapping) => !mapping.supported).reason : reason,
      strategy: 'local-response',
      enabled: Boolean(resource.file && resource.url && resolver.resolve(resource.url)?.file === resource.file),
    });
  }
}
function explicitRouteUrl(rule, root, file) {
  if (rule.passthrough) return null;
  let url = null;
  if (rule.file && path.resolve(root, rule.file) === file && !/[?*]/.test(rule.url)) url = rule.url;
  if (rule.dir) {
    const routeRoot = path.resolve(root, rule.dir);
    const rel = path.relative(routeRoot, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const wildcard = rule.url.search(/[?*]/);
    const prefix = rule.url.slice(0, rule.url.lastIndexOf('/', wildcard < 0 ? rule.url.length : wildcard) + 1);
    url = prefix + normalize(rel).split('/').map(encodeURIComponent).join('/');
  }
  return url;
}
function applyExplicitRoutes(state, site, resolver) {
  for (const item of state.entries.values()) {
    if (item.status !== 'gap' || item.field) continue;
    const file = path.resolve(state.root, item.relativePath);
    for (const rule of site.routes ?? []) {
      const url = explicitRouteUrl(rule, state.root, file);
      if (url && resolver.resolve(url)?.file === file) {
        Object.assign(item, {
          status: 'mapped',
          reason: 'Explicit route serves this source; request coverage still requires verification.',
          kind: 'route',
          strategy: 'local-response',
          url,
          enabled: true,
        });
        break;
      }
    }
    if (item.status === 'gap' && /^web-files\//i.test(item.relativePath))
      Object.assign(item, {
        status: 'blocked',
        reason: 'Payload has no active web-file metadata or explicit route; its URL cannot safely be inferred.',
      });
    // Server logic code (.powerpages-site server-logic/<name>/<name>.js) runs on the Power Pages server,
    // never in a page response: the overlay cannot apply it and changes need deployment.
    if (item.status === 'gap' && /^server-logics?\//i.test(item.relativePath))
      Object.assign(item, {
        status: 'deployment',
        reason:
          'Server logic runs on the Power Pages server; changes require deployment. Mirage provides separately configured local operation models.',
      });
  }
}
function auditTotals(resources) {
  const count = (status) => resources.filter((item) => item.status === status).length;
  return {
    resources: resources.length,
    mapped: count('mapped'),
    blocked: count('blocked'),
    inactive: count('inactive'),
    deployment: count('deployment'),
    gaps: count('gap'),
    disabled: resources.filter((item) => item.status === 'mapped' && !item.enabled).length,
  };
}

/** Inventory every code file, web-file record and code-bearing YAML/component field. */
export function auditResources(model, site) {
  const root = model.sourceDir;
  const state = {
    model,
    root,
    relative: (file) => normalize(path.relative(root, file)),
    entries: new Map(),
    errors: [],
    diagnostics: [],
    excluded: [],
    files: [],
    metadata: new Map(),
  };
  walkAuditDirectory(root, state);

  for (const file of state.files) scanAuditFile(file, state);

  // Content can be inactive because its language root is inactive, even if the content
  // record itself is active. The mapper exposes this explicit metadata relationship.
  applyInactiveEntries(state);

  // Ignore user selection when measuring mapping capability; report it independently.
  const resolver = new Resolver(model, { ...site, scope: 'all' });
  applyInlineSources(state, site);
  applyWebFiles(state, resolver);

  // Explicit routes may intentionally map a payload that has no export metadata. Resolve
  // the derived URL through normal precedence/exclusion rules before counting it.
  applyExplicitRoutes(state, site, resolver);

  const resources = [...state.entries.values()].sort((a, b) => compare(a.id, b.id));
  const totals = auditTotals(resources);
  const active = totals.mapped + totals.blocked + totals.gaps;
  let accountedPercent = 100;
  if (resources.length) accountedPercent = ((resources.length - totals.gaps) / resources.length) * 100;
  const mappedPercent = active ? (totals.mapped / active) * 100 : 100;
  return {
    schemaVersion: 1,
    offline: true,
    writesFiles: [],
    format: model.format,
    sourceDir: root,
    scannedFiles: state.files.length,
    totals,
    coverage: {
      inventoryComplete: state.errors.length === 0,
      accountedPercent: state.errors.length ? null : accountedPercent,
      mappedPercent: state.errors.length ? null : mappedPercent,
      complete:
        state.errors.length === 0 && state.diagnostics.length === 0 && totals.gaps === 0 && totals.blocked === 0,
      runtimeVerified: false,
    },
    scope:
      'All regular files under the extract, JavaScript/CSS/HTML file extensions, code-bearing YAML/component JSON fields, and all indexed web-file payloads. Inline script/style elements remain part of their containing HTML source. Mapping is independent of configured kind filters, exclusions and changed scope; enabled reports configuration only.',
    excluded: state.excluded,
    errors: state.errors,
    diagnostics: state.diagnostics,
    warnings: [...model.warnings].sort(compare),
    resources,
  };
}
