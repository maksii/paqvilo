// An independent disk inventory: a mapper cannot prove coverage using only its own output.
// No source bodies or credentials are returned, and no portal requests are made.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { isSourceFile } from './portal-model.mjs';
import { Resolver } from './resolver.mjs';
import { inspectComponentJson } from './audit-json.mjs';

const CODE_FILE = /\.(?:[cm]?js|css|html?)$/i;
const CODE_FIELD = /(?:javascript|stylesheet|(?:^|_)css$|(?:^|_)html$|customcss|customscript)/i;
const MARKUP = /<(?:[a-z][\w:-]*)(?:\s[^<>]*|\s*\/?)>|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/i;
const SKIP = new Set(['.git', '.paqvilo', 'node_modules']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const normalize = (file) => file.replace(/\\/g, '/');
const SOURCE_FIELDS = new Set(['adx_copy', 'adx_summary', 'adx_source', 'adx_value', 'copy', 'summary', 'source', 'value']);

// Recognize standard content fields even when empty. Unknown nonempty HTML/code fields
// remain gaps until a handler or a precise deployment-only classification is supplied.
function languageOf(key, value, context) {
  if (/javascript|customscript/i.test(key)) return 'javascript';
  if (/stylesheet|(?:^|_)css$|customcss/i.test(key)) return 'css';
  if (/(?:^|_)html$/i.test(key) || MARKUP.test(value)) return 'html';
  if (SOURCE_FIELDS.has(key) && /(?:webpage|webtemplate|contentsnippet|type:(?:2|7|8))\b/i.test(context)) return 'html';
  return null;
}

function strings(value, visit, parts = [], ancestors = new Set()) {
  if (typeof value === 'string') { visit(parts, value); return; }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) strings(item, visit, [...parts, key], ancestors);
  ancestors.delete(value);
}

// Visit the syntax tree rather than converting YAML to an object: duplicate keys must
// not silently overwrite earlier code fields in the inventory. They remain diagnostics.
function yamlStrings(node, document, visit, parts = [], ancestors = new Set()) {
  if (!node || ancestors.has(node)) return;
  if (YAML.isScalar(node)) { if (typeof node.value === 'string') visit(parts, node.value); return; }
  ancestors.add(node);
  if (YAML.isAlias(node)) yamlStrings(node.resolve(document), document, visit, parts, ancestors);
  else if (YAML.isSeq(node)) node.items.forEach((item, index) => yamlStrings(item, document, visit, [...parts, String(index)], ancestors));
  else if (YAML.isMap(node)) {
    const seen = new Map();
    for (const pair of node.items) {
      const key = String(pair.key?.value ?? '');
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      yamlStrings(pair.value, document, visit, [...parts, occurrence ? `${key}[duplicate:${occurrence}]` : key], ancestors);
    }
  }
  ancestors.delete(node);
}

function metadataReason(rel, key) {
  if (/^deployment-profiles\//i.test(rel)) return 'Environment-specific deployment-profile override; the overlay does not apply deployment transformations.';
  if (key === 'notetext' && /\.webfile\.ya?ml$/i.test(rel)) return 'Attachment annotation metadata, not the web-file response body.';
  if (/^(?:adx_)?(?:filter_definition|subgrid_settings|settings)$/i.test(key)) return 'Serialized server-interpreted configuration; changing its rendering or queries requires deployment.';
  return null;
}

/** Inventory every code file, web-file record and code-bearing YAML/component field. */
export function auditResources(model, site) {
  const root = model.sourceDir;
  const relative = (file) => normalize(path.relative(root, file));
  const entries = new Map();
  const errors = [];
  const diagnostics = [];
  const excluded = [];
  const files = [];
  const metadata = new Map();
  const add = (file, field, extra = {}) => {
    const rel = relative(file);
    const id = `${rel}${field ? `#${field}` : ''}`;
    const existing = entries.get(id);
    if (existing) { Object.assign(existing, extra); return existing; }
    const item = { id, relativePath: rel, field: field ?? null, kind: null, language: null, empty: null, status: 'gap', reason: 'No resource handler recognized this source.', ...extra };
    entries.set(id, item);
    return item;
  };
  const walk = (dir) => {
    let children;
    try { children = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (err) { errors.push({ relativePath: relative(dir), reason: `Cannot inventory directory: ${err.code ?? 'read failure'}` }); return; }
    for (const child of children.sort((a, b) => compare(a.name, b.name))) {
      const file = path.join(dir, child.name);
      if (child.isSymbolicLink()) { excluded.push({ relativePath: relative(file), reason: 'Symbolic links and junctions are not traversed.' }); continue; }
      if (child.isDirectory()) {
        if (SKIP.has(child.name)) { excluded.push({ relativePath: relative(file), reason: 'Tool state or dependencies, not portal export content.' }); continue; }
        walk(file);
      } else if (child.isFile()) files.push(file);
    }
  };
  walk(root);
  const read = (file) => {
    try {
      if (!isSourceFile(root, file)) throw Object.assign(new Error(), { code: 'UNSAFE_SOURCE' });
      return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) { errors.push({ relativePath: relative(file), reason: `Cannot read source: ${err.code ?? 'read failure'}` }); return null; }
  };

  for (const file of files) {
    const rel = relative(file);
    if (CODE_FILE.test(file)) {
      const text = read(file);
      add(file, null, { language: /\.[cm]?js$/i.test(file) ? 'javascript' : /\.css$/i.test(file) ? 'css' : 'html', empty: text === null ? null : !text.trim() });
    }
    let record;
    let document;
    let context = rel;
    let inactive = false;
    if (/\.ya?ml$/i.test(file)) {
      const raw = read(file);
      if (raw === null) continue;
      document = YAML.parseDocument(raw);
      const fatal = document.errors.filter((error) => error.code !== 'DUPLICATE_KEY');
      if (fatal.length) { errors.push({ relativePath: rel, reason: 'Cannot parse YAML; fields were not inventoried.' }); continue; }
      for (const error of document.errors) diagnostics.push({ relativePath: rel, code: error.code, reason: 'Duplicate YAML key; every occurrence was inventoried, but deployment interpretation is ambiguous.' });
      inactive = YAML.isMap(document.contents) && Number(document.get('statecode')) === 1;
    } else if (/^powerpagecomponents\/[^/]+\/powerpagecomponent\.xml$/i.test(rel)) {
      const raw = read(file);
      if (raw === null) continue;
      context = `type:${/<powerpagecomponenttype>\s*(\d+)\s*</.exec(raw)?.[1] ?? '?'}`;
      // Metadata-only components can legitimately have no <content> (e.g. page templates).
      if (!/<content\b/i.test(raw) && !/^type:(?:2|3|7|8|15|17|20)$/.test(context)) continue;
      const inspected = inspectComponentJson(raw);
      for (const diagnostic of inspected.diagnostics) errors.push({ relativePath: rel, ...diagnostic });
      record = inspected.value;
      if (!record) continue;
      inactive = /<statecode>\s*1\s*<\/statecode>/.test(raw);
    } else continue;
    metadata.set(file, { inactive });
    const visit = (parts, value, inheritedReason = null, depth = 0) => {
      const key = parts.at(-1) ?? '';
      const language = languageOf(key, value, context);
      let reason = inheritedReason ?? metadataReason(rel, key);
      const entryInactive = inactive || Boolean(document && parts.some((_part, index) => {
        const prefix = parts.slice(0, index);
        return Number(document.getIn([...prefix, 'statecode'])) === 1 || ['adx_entityform', 'adx_webform', 'entityform', 'webform'].some((key) => model.inactiveForms?.has(String(document.getIn([...prefix, key]) ?? '').toLowerCase()));
      }));
      let nestedCount = 0;
      // Localized metadata is a serialized JSON array. Inventory its literal strings
      // independently; the container's LCIDs and server settings still need deployment.
      if (/^\s*[\[{]/.test(value)) {
        try {
          const nested = JSON.parse(value);
          if (nested && typeof nested === 'object') {
            if (depth >= 16) { errors.push({ relativePath: rel, reason: 'Serialized JSON nesting limit reached; inventory is incomplete.' }); return 0; }
            const nestedDocument = YAML.parseDocument(value);
            for (const error of nestedDocument.errors) diagnostics.push({ relativePath: rel, code: error.code, reason: 'Duplicate serialized JSON key; every occurrence was inventoried, but its interpretation is ambiguous.' });
            yamlStrings(nestedDocument.contents, nestedDocument, (keys, text) => { nestedCount += visit([...parts, ...keys], text, reason, depth + 1); });
            reason ??= 'Serialized metadata container; literal text values are inventoried separately from server configuration.';
          }
        } catch { /* not JSON: retain as a candidate, never silently ignore it */ }
      }
      if (!nestedCount && (!language || (!value.trim() && !CODE_FIELD.test(key) && !SOURCE_FIELDS.has(key)))) return 0;
      add(file, parts.join('.'), { language: language ?? 'container', empty: !value.trim(), ...(reason ? { status: 'deployment', reason } : {}), ...(entryInactive ? { status: 'inactive', reason: 'Inactive portal record is not rendered.' } : {}) });
      return nestedCount + 1;
    };
    if (document) yamlStrings(document.contents, document, visit);
    else strings(record, visit);
  }

  // Content can be inactive because its language root is inactive, even if the content
  // record itself is active. The mapper exposes this explicit metadata relationship.
  const inactiveSources = new Set((model.inactiveSources ?? []).map((source) => source.file));
  for (const item of entries.values()) {
    const file = path.join(root, item.relativePath);
    const mirage = /\.[^.]+\.[^.]+$/.test(file) ? file.replace(/\.[^.]+\.[^.]+$/, '.yml') : null;
    if ((!item.field || model.format === 'enhanced') && inactiveSources.has(file) || metadata.get(mirage)?.inactive) Object.assign(item, { status: 'inactive', reason: 'Inactive portal record or inactive language root is not rendered.' });
  }

  // Ignore user selection when measuring mapping capability; report it independently.
  const resolver = new Resolver(model, { ...site, scope: 'all' });
  for (const source of model.inlineSources) {
    const file = source.file;
    const field = source.fieldPath ? [...source.fieldPath, ...source.jsonPath ?? []].join('.') : source.field ?? null;
    // The enhanced mapper also offers absent/empty optional fields for future edits.
    // They are capabilities, not additional code occurrences found on disk.
    if (field && !entries.has(`${relative(file)}#${field}`)) continue;
    const item = add(file, field, { kind: source.kind });
    const supported = isSourceFile(root, file) && (!source.kind.startsWith('page-') || source.pageUrl != null);
    const settings = source.mode === 'block' ? site.inline : site.markup;
    Object.assign(item, {
      status: supported ? 'mapped' : 'blocked',
      reason: supported ? source.mode === 'block' ? 'Inline block handler; rendered-page matching still requires verification.' : 'Literal baseline patch handler; Liquid execution and runtime matching remain online.' : 'Source is missing, unsafe, or its page URL cannot be resolved.',
      strategy: source.mode === 'block' ? 'inline-block' : 'baseline-patch',
      enabled: Boolean(settings?.enabled && settings.kinds.includes(source.kind)), pageUrl: source.pageUrl ?? null,
    });
  }
  for (const resource of model.webFiles) {
    const file = resource.file ?? resource.yml;
    const item = add(file, resource.file ? null : '$attachment', { kind: 'web-file', url: resource.url });
    const supported = Boolean(resource.file && resource.url && !resource.problem && isSourceFile(root, resource.file));
    const reason = resource.problem ?? (supported ? 'Local web-file response handler; request coverage still requires verification.' : 'Missing or unsafe content file or unresolved URL.');
    (item.mappings ??= []).push({ metadataPath: relative(resource.yml), url: resource.url, supported, reason });
    const blocked = item.mappings.some((mapping) => !mapping.supported);
    Object.assign(item, { status: blocked ? 'blocked' : 'mapped', reason: blocked ? item.mappings.find((mapping) => !mapping.supported).reason : reason, strategy: 'local-response', enabled: Boolean(resource.file && resource.url && resolver.resolve(resource.url)?.file === resource.file) });
  }

  // Explicit routes may intentionally map a payload that has no export metadata. Resolve
  // the derived URL through normal precedence/exclusion rules before counting it.
  for (const item of entries.values()) {
    if (item.status !== 'gap' || item.field) continue;
    const file = path.resolve(root, item.relativePath);
    for (const rule of site.routes ?? []) {
      if (rule.passthrough) continue;
      let url = null;
      if (rule.file && path.resolve(root, rule.file) === file && !/[?*]/.test(rule.url)) url = rule.url;
      if (rule.dir) {
        const routeRoot = path.resolve(root, rule.dir);
        const rel = path.relative(routeRoot, file);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const wildcard = rule.url.search(/[?*]/);
        const prefix = rule.url.slice(0, rule.url.lastIndexOf('/', wildcard < 0 ? rule.url.length : wildcard) + 1);
        url = prefix + normalize(rel).split('/').map(encodeURIComponent).join('/');
      }
      if (url && resolver.resolve(url)?.file === file) { Object.assign(item, { status: 'mapped', reason: 'Explicit route serves this source; request coverage still requires verification.', kind: 'route', strategy: 'local-response', url, enabled: true }); break; }
    }
    if (item.status === 'gap' && /^web-files\//i.test(item.relativePath)) Object.assign(item, { status: 'blocked', reason: 'Payload has no active web-file metadata or explicit route; its URL cannot safely be inferred.' });
    // Server logic code (.powerpages-site server-logic/<name>/<name>.js) runs on the Power Pages server,
    // never in a page response: the overlay cannot apply it and changes need deployment.
    if (item.status === 'gap' && /^server-logics?\//i.test(item.relativePath)) Object.assign(item, { status: 'deployment', reason: 'Server logic runs on the Power Pages server; changes require deployment. Mirage provides separately configured local operation models.' });
  }

  const resources = [...entries.values()].sort((a, b) => compare(a.id, b.id));
  const count = (status) => resources.filter((item) => item.status === status).length;
  const totals = { resources: resources.length, mapped: count('mapped'), blocked: count('blocked'), inactive: count('inactive'), deployment: count('deployment'), gaps: count('gap'), disabled: resources.filter((item) => item.status === 'mapped' && !item.enabled).length };
  const active = totals.mapped + totals.blocked + totals.gaps;
  return {
    schemaVersion: 1, offline: true, writesFiles: false, format: model.format, sourceDir: root,
    scannedFiles: files.length, totals,
    coverage: { inventoryComplete: errors.length === 0, accountedPercent: errors.length ? null : resources.length ? (resources.length - totals.gaps) / resources.length * 100 : 100, mappedPercent: errors.length ? null : active ? totals.mapped / active * 100 : 100, complete: errors.length === 0 && diagnostics.length === 0 && totals.gaps === 0 && totals.blocked === 0, runtimeVerified: false },
    scope: 'All regular files under the extract, JavaScript/CSS/HTML file extensions, code-bearing YAML/component JSON fields, and all indexed web-file payloads. Inline script/style elements remain part of their containing HTML source. Mapping is independent of configured kind filters, exclusions and changed scope; enabled reports configuration only.',
    excluded, errors, diagnostics, warnings: [...model.warnings].sort(compare), resources,
  };
}
