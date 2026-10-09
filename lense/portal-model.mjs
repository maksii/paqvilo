// Reads a `pac paportal download` extract from disk and builds an index of everything that can be
// overridden locally: web files (URL -> file) and inline sources (page/form/list JS & CSS, templates).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const MIME_BY_EXT = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

export function mimeFor(fileName, fallback) {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] || fallback || 'application/octet-stream';
}

/** A portal source must still be a regular file in the extract when it is read. */
export function isSourceFile(sourceDir, file) {
  return sourceFileStat(sourceDir, file) !== null;
}

// Resolving every metadata file and the extract root through realpath dominated index reloads
// (two realpath calls per file). Reuse directories only within one synchronous index load.
// Keeping them across loads/requests is unsafe: an ancestor can become a junction while a
// descendant retains the same inode. Reads outside indexing always resolve fresh paths.
const MAX_REAL_DIRECTORIES = 8192;
let realDirectories = null;

function realDirectory(dir) {
  const cached = realDirectories?.get(dir);
  if (cached) return cached;
  const real = fs.realpathSync.native(dir);
  if (realDirectories && realDirectories.size < MAX_REAL_DIRECTORIES) realDirectories.set(dir, real);
  return real;
}

/** Real path and stat of `file`; a symbolic link or junction is followed explicitly. */
function realFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { real: fs.realpathSync.native(file), stat: fs.statSync(file) };
  return { real: path.join(realDirectory(path.dirname(file)), path.basename(file)), stat };
}

const inside = (root, real) => {
  const relative = path.relative(root, real);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function sourceFileStat(sourceDir, file) {
  try {
    const { real, stat } = realFile(file);
    if (!inside(realDirectory(sourceDir), real)) return null;
    return stat.isFile() ? stat : null;
  } catch { return null; }
}

function parseYaml(text, allowSequence = false) {
  try {
    const value = YAML.parse(text) ?? {};
    return value && typeof value === 'object' && (allowSequence || !Array.isArray(value)) ? value : { __error: 'expected a YAML mapping' };
  } catch (err) {
    return { __error: `cannot read YAML: ${err.message.split('\n')[0]}` };
  }
}

function readYaml(file, allowSequence = false) {
  try { return parseYaml(fs.readFileSync(file, 'utf8'), allowSequence); }
  catch (err) { return { __error: `cannot read YAML: ${err.message.split('\n')[0]}` }; }
}

const fileStamp = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return out; throw err; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function walkAsync(roots) {
  const directories = [...roots];
  const files = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, roots.length) }, async () => {
    while (next < directories.length) {
      const dir = directories[next++];
      let entries;
      try {
        if ((await fs.promises.lstat(dir)).isSymbolicLink()) continue;
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch { continue; /* the synchronous load reports unreadable directories */ }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) directories.push(file);
        else if (entry.isFile()) files.push(file);
      }
    }
  }));
  return files;
}

async function sourceFileStatAsync(sourceDir, file) {
  try {
    const [root, resolved, stat] = await Promise.all([fs.promises.realpath(sourceDir), fs.promises.realpath(file), fs.promises.stat(file)]);
    const relative = path.relative(root, resolved);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && stat.isFile() ? stat : null;
  } catch { return null; }
}

/** Portal URLs are case-insensitive; this is the lookup key for a URL path. */
export function urlKey(urlPath) {
  let p = urlPath;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    /* keep raw */
  }
  p = p.toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function joinUrl(parentPath, partial) {
  const clean = String(partial ?? '').replace(/^\/+|\/+$/g, '');
  const base = parentPath.endsWith('/') ? parentPath : parentPath + '/';
  return clean ? base + clean : parentPath;
}

// The kinds of inline (non web-file) sources the extract holds. `block` sources are emitted by the
// portal verbatim inside one <script>/<style> element; `markup` sources are Liquid/HTML that the
// portal renders, so only their literal parts can be patched locally.
const INLINE_KINDS = [
  { kind: 'page-js', dir: 'web-pages', suffix: '.webpage.custom_javascript.js', mode: 'block', tag: 'script' },
  { kind: 'page-css', dir: 'web-pages', suffix: '.webpage.custom_css.css', mode: 'block', tag: 'style' },
  { kind: 'page-copy', dir: 'web-pages', suffix: '.webpage.copy.html', mode: 'markup' },
  { kind: 'page-summary', dir: 'web-pages', suffix: '.webpage.summary.html', mode: 'markup' },
  { kind: 'basic-form-js', dir: 'basic-forms', suffix: '.basicform.custom_javascript.js', mode: 'block', tag: 'script' },
  { kind: 'advanced-form-step-js', dir: 'advanced-forms', suffix: '.advancedformstep.custom_javascript.js', mode: 'block', tag: 'script' },
  { kind: 'list-js', dir: 'lists', suffix: '.list.custom_javascript.js', mode: 'block', tag: 'script' },
  { kind: 'web-template', dir: 'web-templates', suffix: '.webtemplate.source.html', mode: 'markup' },
  { kind: 'content-snippet', dir: 'content-snippets', suffix: '.contentsnippet.value.html', mode: 'markup' },
];

// Rendered literal fields; localized JSON values are extracted individually, preserving LCIDs
// and other configuration. Structural, localization and association edits still need deployment.
const YAML_MARKUP_KINDS = [
  { dir: 'weblink-sets', suffix: '.weblinkset.yml', fields: ['adx_copy'] },
  { dir: 'weblink-sets', suffix: '.weblinkset.weblink.yml', fields: ['adx_description', 'adx_name'] },
  { dir: 'polls', suffix: '.poll.yml', fields: ['adx_question'] },
  { dir: 'basic-forms', suffix: '.basicform.yml', fields: ['adx_instructions'] },
  { dir: 'basic-forms', suffix: '.basicformmetadata.yml', fields: ['adx_description', 'adx_label', 'adx_validationregularexpressionerrormessage'] },
  { dir: 'advanced-forms', suffix: '.advancedformmetadata.yml', fields: ['adx_description', 'adx_label', 'adx_validationregularexpressionerrormessage'] },
];
// The same fields in a .powerpages-site (short-key) export: unprefixed keys, one web link per file.
const SHORT_KEY_MARKUP_KINDS = [
  { dir: 'weblink-sets', suffix: '.weblinkset.yml', fields: ['copy'] },
  { dir: 'weblink-sets', suffix: '.weblink.yml', fields: ['description', 'name'] },
  { dir: 'polls', suffix: '.poll.yml', fields: ['question'] },
  { dir: 'basic-forms', suffix: '.basicform.yml', fields: ['instructions'] },
  { dir: 'basic-forms', suffix: '.basicformmetadata.yml', fields: ['description', 'label', 'validationregularexpressionerrormessage'] },
  { dir: 'advanced-forms', suffix: '.advancedformmetadata.yml', fields: ['description', 'label', 'validationregularexpressionerrormessage'] },
];
// A field of a YAML record: adx_<name> in PAC YAML, <name> in a .powerpages-site export, which
// keeps record IDs in id:.
const yamlValue = (record, name) => record?.[`adx_${name}`] ?? record?.[name];
const yamlId = (record, kind) => record?.[`adx_${kind}id`] ?? record?.id;
const atPath = (content, keys) => keys.reduce((value, key) => value?.[key], content);
const setPath = (content, keys, value) => {
  const parent = atPath(content, keys.slice(0, -1));
  if (parent && typeof parent === 'object') Object.defineProperty(parent, keys.at(-1), { value, enumerable: true, configurable: true, writable: true });
};
function markupValues(value) {
  if (typeof value !== 'string') return [];
  if (/^\s*\[/.test(value)) {
    try {
      const localized = JSON.parse(value);
      if (Array.isArray(localized)) return localized.flatMap((entry, index) => typeof entry?.Value === 'string' ? [{ jsonPath: [index, 'Value'], lcid: entry.LCID }] : []);
    } catch { return []; }
  }
  return [{}];
}
const yamlField = (source) => (raw) => {
  const content = parseYaml(raw, true);
  if (content.__error) return null;
  if (source.recordId && atPath(content, [...source.fieldPath.slice(0, -1), source.recordIdField]) !== source.recordId) return null;
  let value = atPath(content, source.fieldPath);
  if (source.jsonPath) {
    try {
      const localized = JSON.parse(value);
      if (source.lcid != null && atPath(localized, [...source.jsonPath.slice(0, -1), 'LCID']) !== source.lcid) return null;
      value = atPath(localized, source.jsonPath);
    } catch { return null; }
  }
  return value == null ? '' : typeof value === 'string' ? value : null;
};

// Remove only text leaves supported by a discovered source. A record move, LCID change or
// non-text value remains visible in the comparison instead of being mistaken for an HTML edit.
function stripPreviewFields(before, after, sources) {
  for (const source of sources) {
    const keys = source.fieldPath ?? [source.field];
    if (source.recordId && (atPath(before, [...keys.slice(0, -1), source.recordIdField]) !== source.recordId || atPath(after, [...keys.slice(0, -1), source.recordIdField]) !== source.recordId)) continue;
    const oldValue = atPath(before, keys);
    const newValue = atPath(after, keys);
    if (source.jsonPath) {
      try {
        const oldJSON = JSON.parse(oldValue);
        const newJSON = JSON.parse(newValue);
        const lcidKeys = [...source.jsonPath.slice(0, -1), 'LCID'];
        if (source.lcid != null && (atPath(oldJSON, lcidKeys) !== source.lcid || atPath(newJSON, lcidKeys) !== source.lcid)) continue;
        if (typeof atPath(oldJSON, source.jsonPath) !== 'string' || typeof atPath(newJSON, source.jsonPath) !== 'string') continue;
        setPath(oldJSON, source.jsonPath, '');
        setPath(newJSON, source.jsonPath, '');
        setPath(before, keys, stableValue(oldJSON));
        setPath(after, keys, stableValue(newJSON));
      } catch { /* malformed localized configuration is not previewable */ }
    } else {
      if ((oldValue != null && typeof oldValue !== 'string') || (newValue != null && typeof newValue !== 'string')) continue;
      setPath(before, keys, '');
      setPath(after, keys, '');
    }
  }
}

export function inlineKindOf(file) {
  const norm = file.replace(/\\/g, '/');
  return INLINE_KINDS.find((k) => norm.includes(`/${k.dir}/`) && norm.endsWith(k.suffix));
}

/**
 * How the sources of a portal are laid out on disk:
 *   'classic'  - `pac paportal download` of a standard data model site (web-files/, web-pages/ ...)
 *   'enhanced' - an unpacked solution of an enhanced data model site (powerpagecomponents/<id>/...)
 *   null       - not a portal extract (including the layouts unsupportedSourceLayout() names)
 */
export function detectFormat(dir) {
  if (!dir) return null;
  const isDir = (name) => {
    try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch { return false; }
  };
  if (isDir('web-files') || isDir('web-pages')) return unsupportedSourceLayout(dir) ? null : 'classic';
  if (isDir('powerpagecomponents')) return 'enhanced';
  return null;
}

const UNSUPPORTED_LAYOUTS = {
  'enhanced-yaml': 'PAC YAML with mspp_ keys',
  'code-site-project': 'a code-site project folder whose .powerpages-site/ folder holds short-key YAML',
};

/**
 * The folder that holds a portal's records: a code-site project's .powerpages-site/ folder (a
 * short-key export), else the folder itself. The Mirage resolves it the same way
 * (mirage/lib/source-dialect.mjs portalSourceDir).
 */
export function portalSourceDir(dir) {
  if (!dir) return dir;
  const site = path.join(dir, '.powerpages-site');
  const isDir = (folder) => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } };
  if (isDir(path.join(dir, 'web-pages')) || isDir(path.join(dir, 'web-files')) || isDir(path.join(dir, 'powerpagecomponents'))) return dir;
  return isDir(site) && yamlKeyStyle(site) === 'short' ? site : dir;
}

/**
 * The key style of a YAML export, from website.yml (or a few records when it is missing):
 * 'adx' (PAC YAML), 'mspp', 'short' (.powerpages-site: unprefixed keys and id:) or null.
 */
export function yamlKeyStyle(dir) {
  if (!dir) return null;
  const exists = (file, directory) => {
    try { const stat = fs.statSync(file); return directory ? stat.isDirectory() : stat.isFile(); } catch { return false; }
  };
  const keysOf = (file) => {
    try {
      return [...fs.readFileSync(file, 'utf8').slice(0, 64 * 1024).matchAll(/^(?:- )?([A-Za-z_]\w*):/gm)].map((m) => m[1].toLowerCase());
    } catch { return []; }
  };
  if (exists(path.join(dir, 'powerpagecomponents'), true)) return null;
  let keys = ['website.yml', 'website.yaml'].map((name) => path.join(dir, name)).filter((file) => exists(file, false)).flatMap(keysOf);
  if (!keys.length) {
    const sample = [];
    const visit = (folder, depth) => {
      if (sample.length >= 5 || depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (sample.length >= 5) return;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (/\.(?:webpage|webtemplate|sitesetting|contentsnippet|webfile)\.ya?ml$/i.test(entry.name)) sample.push(file);
      }
    };
    for (const name of ['web-pages', 'web-templates', 'site-settings', 'content-snippets', 'web-files']) visit(path.join(dir, name), 0);
    keys = sample.flatMap(keysOf);
  }
  const relationship = new Set(['adx_entitypermission_webrole', 'adx_webpageaccesscontrolrule_webrole', 'adx_websiteaccess_webrole']);
  if (keys.some((key) => key.startsWith('adx_') && !relationship.has(key))) return 'adx';
  if (keys.some((key) => key.startsWith('mspp_'))) return 'mspp';
  if (keys.includes('id')) return 'short';
  return null;
}

/**
 * A source layout the toolkit cannot treat as a portal: { dialect, label }, else null. PAC YAML
 * with adx_ keys, .powerpages-site short-key YAML and unpacked Solutions are portals; the
 * Mirage names the same layouts (mirage/lib/source-dialect.mjs, ECOSYSTEM-REVIEW.md X1).
 */
export function unsupportedSourceLayout(dir) {
  if (!dir) return null;
  const exists = (file, directory) => {
    try { const stat = fs.statSync(file); return directory ? stat.isDirectory() : stat.isFile(); } catch { return false; }
  };
  const result = (dialect) => ({ dialect, label: UNSUPPORTED_LAYOUTS[dialect] });
  if (exists(path.join(dir, 'powerpagecomponents'), true)) return null;
  if (yamlKeyStyle(dir) === 'mspp') return result('enhanced-yaml');
  if (!exists(path.join(dir, 'web-pages'), true) && !exists(path.join(dir, 'web-files'), true) && exists(path.join(dir, '.powerpages-site'), true) && portalSourceDir(dir) === dir) return result('code-site-project');
  return null;
}

/**
 * Text of an inline source. Most are plain files; in the enhanced format the text is a field of
 * the component's XML, taken out by `src.extract`.
 * @param {{file: string, extract?: (raw: string) => string|null}} src
 * @param {string|null} [raw] content of src.file when the caller has it already (a baseline version)
 * @returns {string|null} null when the file is missing or cannot be read
 */
export function sourceText(src, raw) {
  let text = raw;
  if (text === undefined) {
    if (src.sourceDir && !isSourceFile(src.sourceDir, src.file)) return null;
    try {
      text = fs.readFileSync(src.file, 'utf8');
    } catch {
      return null;
    }
  }
  if (text == null) return null;
  text = text.replace(/^﻿/, '');
  return src.extract ? src.extract(text) : text;
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const xmlUnescape = (s) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (_, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : XML_ENTITIES[name.toLowerCase()],
  );

/** Real element body boundaries; closing-tag text in CDATA/comments is never an element. */
export function componentContentSpan(xml, fromIndex = 0) {
  const opening = /<!--|<!\[CDATA\[|<content\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  opening.lastIndex = fromIndex;
  let open;
  while ((open = opening.exec(xml))) {
    if (open[0].startsWith('<content')) break;
    const marker = open[0] === '<!--' ? '-->' : ']]>';
    const end = xml.indexOf(marker, opening.lastIndex);
    if (end < 0) return null;
    opening.lastIndex = end + marker.length;
  }
  if (!open) return null;
  const closing = /<!--|<!\[CDATA\[|<\/content\s*>/g;
  closing.lastIndex = opening.lastIndex;
  for (let close; (close = closing.exec(xml));) {
    if (close[0].startsWith('</content')) return { openStart: open.index, contentStart: opening.lastIndex, contentEnd: close.index, closeEnd: closing.lastIndex };
    const marker = close[0] === '<!--' ? '-->' : ']]>';
    const end = xml.indexOf(marker, closing.lastIndex);
    if (end < 0) return null;
    closing.lastIndex = end + marker.length;
  }
  return null;
}

function xmlText(raw) {
  const sections = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let result = '';
  let from = 0;
  for (let section; (section = sections.exec(raw));) {
    result += xmlUnescape(raw.slice(from, section.index));
    if (section[1] !== undefined) result += section[1];
    from = sections.lastIndex;
  }
  return result + xmlUnescape(raw.slice(from));
}

/** The JSON held in <content> of a powerpagecomponent.xml, or null. */
export function componentContent(xml) {
  const span = componentContentSpan(xml);
  if (!span || componentContentSpan(xml, span.closeEnd)) return null;
  try {
    const value = JSON.parse(xmlText(xml.slice(span.contentStart, span.contentEnd)));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Reader for one field of a component, usable as `extract` of an inline source. */
const componentField = (field) => (xml) => {
  const content = componentContent(xml);
  if (!content) return null;
  const value = content[field];
  return typeof value === 'string' ? value : '';
};

// powerpagecomponenttype values of the enhanced data model that matter here
const COMPONENT = { WEB_PAGE: 2, WEB_FILE: 3, WEB_LINK_SET: 4, WEB_LINK: 5, CONTENT_SNIPPET: 7, WEB_TEMPLATE: 8, BASIC_FORM: 15, BASIC_FORM_METADATA: 16, LIST: 17, ADVANCED_FORM: 19, ADVANCED_FORM_STEP: 20, ADVANCED_FORM_METADATA: 21 };
const PREVIEW_FIELDS = new Map([
  [COMPONENT.WEB_PAGE, ['customjavascript', 'customcss', 'copy', 'summary']],
  [COMPONENT.CONTENT_SNIPPET, ['value']],
  [COMPONENT.WEB_TEMPLATE, ['source']],
  [COMPONENT.BASIC_FORM, ['customjavascript']],
  [COMPONENT.LIST, ['customjavascript']],
  [COMPONENT.ADVANCED_FORM_STEP, ['customjavascript']],
]);
const COMPONENT_MARKUP_FIELDS = new Map([
  [COMPONENT.WEB_LINK_SET, ['copy']],
  [COMPONENT.WEB_LINK, ['description']],
  [COMPONENT.BASIC_FORM, ['instructions']],
  [COMPONENT.BASIC_FORM_METADATA, ['description', 'label', 'validationregularexpressionerrormessage']],
  [COMPONENT.ADVANCED_FORM_METADATA, ['description', 'label', 'validationregularexpressionerrormessage']],
]);
const CLASSIC_METADATA = /(?:^(?:website|websiteaccess|webrole|webpagerule|urlhistory|forumthreadtype|sitesetting|sitemarker|publishingstate|websitelanguage|tag|adplacement|shortcut|redirect|ad)\.yml$|(?:^|\/)[^/]+\.(?:webpage|webfile|contentsnippet|webtemplate|basicform|basicformmetadata|advancedform|advancedformstep|advancedformmetadata|list|pagetemplate|tablepermission|entitypermission|columnpermissionprofile|columnpermission|weblink|weblinkset|poll|pollplacement|polloption|forum|forumpermission|forumaccesspermission|webrole|webpagelanguage|websitelanguage|sitemarker|sitesetting|publishingstate|webpageaccesscontrolrule|websiteaccess|redirect|shortcut|deployment|botconsumer|cloudflowconsumer|serverlogic|uxcomponent|pollplacement|adplacement|publishingstatetransitionrule|portallanguage|sourcefile)\.yml$)/i;
/** Portal metadata filenames, excluding unrelated YAML/XML notes in the checkout. */
export const isPortalMetadata = (relative) => CLASSIC_METADATA.test(relative.replace(/\\/g, '/')) || /^powerpagecomponents\/[^/]+\/powerpagecomponent\.xml$/i.test(relative.replace(/\\/g, '/'));
const stableValue = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

export class PortalModel {
  /**
   * @param {string} sourceDir absolute path of the extract
   */
  constructor(sourceDir, { yamlCache, xmlCache } = {}) {
    this.sourceDir = path.resolve(sourceDir);
    this.yamlCache = yamlCache ?? new Map();
    this.xmlCache = xmlCache ?? new Map();
    this.warnings = [];
    this.load();
  }

  /** Bounded metadata prefetch avoids serial disk reads during production startup. */
  static async create(sourceDir) {
    sourceDir = path.resolve(sourceDir);
    const enhanced = detectFormat(sourceDir) === 'enhanced';
    const roots = enhanced ? ['powerpagecomponents'] : [...new Set(['web-files', ...INLINE_KINDS.map((kind) => kind.dir), ...YAML_MARKUP_KINDS.map((kind) => kind.dir)])];
    const candidates = await walkAsync(roots.map((dir) => path.join(sourceDir, dir)));
    const files = enhanced
      ? candidates.filter((file) => path.basename(file) === 'powerpagecomponent.xml')
      : [path.join(sourceDir, 'website.yml'), ...candidates.filter((file) => /\.(?:webpage|webfile|basicform|basicformmetadata|list|advancedform|advancedformstep|advancedformmetadata|webtemplate|contentsnippet|weblinkset|weblink|poll)\.yml$/.test(file))];
    const cache = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++];
        const before = await sourceFileStatAsync(sourceDir, file);
        if (!before) continue;
        let text;
        try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
        const after = await sourceFileStatAsync(sourceDir, file);
        if (!after || fileStamp(before) !== fileStamp(after)) continue;
        cache.set(file, enhanced ? { stamp: fileStamp(after), text } : { stamp: fileStamp(after), value: parseYaml(text, /\.(?:basicformmetadata|advancedformmetadata|weblink)\.yml$/.test(file)) });
      }
    }));
    // The regular load re-enumerates directories and revalidates every cached file, covering
    // additions, atomic saves and link replacements that happened while prefetch was running.
    return new PortalModel(sourceDir, enhanced ? { xmlCache: cache } : { yamlCache: cache });
  }

  load() {
    const previous = realDirectories;
    realDirectories = new Map();
    try { this.#load(); } finally { realDirectories = previous; }
  }

  #load() {
    this.warnings = [];
    this.format = detectFormat(this.sourceDir);
    this.pagePathCache = new Map();
    /** content page id -> root page id (enhanced format) */
    this.pageAlias = new Map();
    this.componentPages = new Map();
    this.pageByDir = new Map();
    this.inventory = new Map();
    this.fileInventory = new Set();
    this.currentYaml = new Map();
    this.duplicateWebFileUrls = new Set();
    /** root pages that are inactive: their language copies are not served either */
    this.inactivePages = new Set();
    this.inactiveForms = new Set();
    this.inactiveSteps = new Set();
    this.stepForms = new Map();
    this.inactiveSources = [];
    if (this.format === 'enhanced') {
      this.#loadEnhanced();
      this.yamlCache.clear();
      return;
    }
    this.xmlCache.clear();
    // A .powerpages-site export keeps PAC folders and side files with unprefixed keys and id:.
    this.shortKey = yamlKeyStyle(this.sourceDir) === 'short';
    this.website = this.#readYaml(path.join(this.sourceDir, 'website.yml'));
    this.#loadPages();
    this.#loadWebFiles();
    this.#loadInlineSources();
    for (const file of this.yamlCache.keys()) {
      if (!this.currentYaml.has(file)) this.yamlCache.delete(file);
    }
  }

  #files(dir) {
    if (!this.inventory.has(dir)) {
      const files = walk(dir);
      this.inventory.set(dir, files);
      for (const file of files) this.fileInventory.add(file);
    }
    return this.inventory.get(dir);
  }

  #readYaml(file, allowSequence = false) {
    if (this.currentYaml.has(file)) return this.currentYaml.get(file);
    let value;
    try {
      const stat = sourceFileStat(this.sourceDir, file);
      if (!stat) throw new Error('metadata is missing or outside the extract');
      const stamp = fileStamp(stat);
      const cached = this.yamlCache.get(file);
      value = cached?.stamp === stamp ? cached.value : readYaml(file, allowSequence);
      this.yamlCache.set(file, { stamp, value });
    } catch (err) {
      value = { __error: err.message };
      this.yamlCache.delete(file);
    }
    if (value.__error) this.warnings.push(`${path.relative(this.sourceDir, file)}: ${value.__error}`);
    this.currentYaml.set(file, value);
    return value;
  }

  #indexPageComponents(pageId, components) {
    for (const component of components.filter(Boolean)) {
      const id = String(component).toLowerCase();
      if (!this.componentPages.has(id)) this.componentPages.set(id, new Set());
      this.componentPages.get(id).add(pageId);
    }
  }

  #loadEnhanced() {
    this.website = {};
    this.pages = new Map();
    this.webFiles = [];
    this.webFileByUrl = new Map();
    this.inlineSources = [];
    const base = path.join(this.sourceDir, 'powerpagecomponents');
    const components = [];
    const seenFiles = new Set();
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const file = path.join(dir, 'powerpagecomponent.xml');
      let xml;
      try {
        const stat = sourceFileStat(this.sourceDir, file);
        if (!stat) {
          this.warnings.push(`powerpagecomponents/${entry.name}/powerpagecomponent.xml: component is missing or outside the extract`);
          continue;
        }
        seenFiles.add(file);
        const stamp = fileStamp(stat);
        const cached = this.xmlCache.get(file);
        xml = cached?.stamp === stamp ? cached.text : fs.readFileSync(file, 'utf8');
        this.xmlCache.set(file, { stamp, text: xml });
      } catch {
        continue;
      }
      const type = Number(/<powerpagecomponenttype>\s*(\d+)\s*</.exec(xml)?.[1]);
      if (!Object.values(COMPONENT).includes(type)) continue;
      if (/<statecode>\s*1\s*<\/statecode>/.test(xml)) {
        if (type === COMPONENT.WEB_PAGE) this.inactivePages.add((/powerpagecomponentid="([^"]+)"/.exec(xml)?.[1] ?? entry.name).toLowerCase());
        if ([COMPONENT.BASIC_FORM, COMPONENT.ADVANCED_FORM].includes(type)) this.inactiveForms.add((/powerpagecomponentid="([^"]+)"/.exec(xml)?.[1] ?? entry.name).toLowerCase());
        if (type === COMPONENT.ADVANCED_FORM_STEP) this.inactiveSteps.add((/powerpagecomponentid="([^"]+)"/.exec(xml)?.[1] ?? entry.name).toLowerCase());
        continue;
      }
      const attachment = /<filecontent\b([^>]*)>([\s\S]*?)<\/filecontent>/.exec(xml);
      const content = componentContent(xml);
      if (!content) this.warnings.push(`powerpagecomponents/${entry.name}/powerpagecomponent.xml: <content> is not a JSON object`);
      const decode = (value) => {
        try { return xmlUnescape(value); }
        catch {
          this.warnings.push(`powerpagecomponents/${entry.name}/powerpagecomponent.xml: invalid XML character entity`);
          return value;
        }
      };
      components.push({
        id: (/powerpagecomponentid="([^"]+)"/.exec(xml)?.[1] ?? entry.name).toLowerCase(),
        type,
        name: decode(/<name>([\s\S]*?)<\/name>/.exec(xml)?.[1] ?? ''),
        content: content ?? {},
        dir,
        file,
        rel: `powerpagecomponents/${entry.name}/powerpagecomponent.xml`,
        attachment: attachment ? { mimeType: /\bmimetype="([^"]*)"/.exec(attachment[1])?.[1] ?? null, name: decode(attachment[2]).trim() } : null,
      });
    }
    for (const file of this.xmlCache.keys()) {
      if (!seenFiles.has(file)) this.xmlCache.delete(file);
    }
    for (const c of components) {
      if (c.type === COMPONENT.ADVANCED_FORM_STEP && c.content.webform) this.stepForms.set(c.id, String(c.content.webform).toLowerCase());
    }

    // pages: the URL tree lives on root pages; a language copy points at its root
    for (const c of components) {
      if (c.type !== COMPONENT.WEB_PAGE) continue;
      const root = c.content.rootwebpageid ? String(c.content.rootwebpageid).toLowerCase() : null;
      this.#indexPageComponents(c.id, [c.content.entityform, c.content.webform, c.content.entitylist]);
      if (c.content.isroot === false && root) {
        this.pageAlias.set(c.id, root);
        continue;
      }
      this.pages.set(c.id, {
        id: c.id,
        partialUrl: String(c.content.partialurl ?? ''),
        parentId: c.content.parentpageid ? String(c.content.parentpageid).toLowerCase() : null,
        name: c.name,
        dir: c.dir,
        components: [c.content.entityform, c.content.webform, c.content.entitylist].filter(Boolean).map((id) => String(id).toLowerCase()),
      });
    }
    for (const page of this.pages.values()) {
      if (this.pagePath(page.id) == null) this.warnings.push(`${path.relative(this.sourceDir, page.dir).replace(/\\/g, '/')}: missing parent page or a cycle in the page hierarchy`);
    }

    for (const c of components) {
      if (c.type === COMPONENT.WEB_FILE) {
        const parentPath = this.pagePath(c.content.parentpageid);
        const attachmentRoot = path.join(c.dir, 'filecontent');
        const file = c.attachment?.name ? path.resolve(attachmentRoot, c.attachment.name) : null;
        let contentFile = null;
        if (file) {
          try {
            if (inside(realDirectory(attachmentRoot), realFile(file).real) && isSourceFile(this.sourceDir, file)) contentFile = file;
          } catch { /* missing or unsafe attachment */ }
        }
        const entry = {
          id: c.id,
          name: c.name,
          yml: c.file,
          file: contentFile,
          partialUrl: c.content.partialurl,
          parentPageId: c.content.parentpageid ?? null,
          url: parentPath == null || c.content.partialurl == null ? null : joinUrl(parentPath, c.content.partialurl),
          mimeType: c.attachment?.mimeType ?? null,
          problem: null,
        };
        if (!entry.file) entry.problem = 'no regular content file safely inside filecontent/';
        else if (entry.url == null) entry.problem = 'no parent page, cannot build the URL';
        this.#addWebFile(entry, `${c.rel} (${c.name})`);
      } else {
        const stepId = String(c.content.webformstep ?? '').toLowerCase();
        const formId = c.content.entityform ?? c.content.webform ?? this.stepForms.get(stepId);
        if ([COMPONENT.BASIC_FORM_METADATA, COMPONENT.ADVANCED_FORM_METADATA, COMPONENT.ADVANCED_FORM_STEP].includes(c.type) && (this.inactiveSteps.has(stepId) || this.inactiveForms.has(String(formId ?? '').toLowerCase()))) {
          this.inactiveSources.push({ file: c.file, rel: c.rel });
          continue;
        }
        for (const field of COMPONENT_MARKUP_FIELDS.get(c.type) ?? []) {
          for (const value of markupValues(c.content[field])) {
            const source = {
              kind: 'metadata-markup', mode: 'markup', tag: null,
              file: c.file, sourceDir: this.sourceDir,
              rel: `${c.rel}#${field}${value.jsonPath ? '.' + value.jsonPath.join('.') : ''}`,
              label: `${c.name} (${field})`, field, fieldPath: [field], ...value,
              pageUrl: null, usedOn: this.pagesShowing(c.type === COMPONENT.BASIC_FORM ? c.id : formId),
            };
            source.extract = (xml) => {
              const content = componentContent(xml);
              if (!content) return null;
              let text = content[field];
              if (source.jsonPath) {
                try {
                  const localized = JSON.parse(text);
                  if (source.lcid != null && atPath(localized, [...source.jsonPath.slice(0, -1), 'LCID']) !== source.lcid) return null;
                  text = atPath(localized, source.jsonPath);
                } catch { return null; }
              }
              return text == null ? '' : typeof text === 'string' ? text : null;
            };
            this.inlineSources.push(source);
          }
        }
        if ([COMPONENT.WEB_LINK_SET, COMPONENT.WEB_LINK, COMPONENT.BASIC_FORM_METADATA, COMPONENT.ADVANCED_FORM_METADATA].includes(c.type)) continue;
        // The form record supplies configuration and associations; its steps hold the JS.
        if (c.type === COMPONENT.ADVANCED_FORM) continue;
        // The language copy of an inactive root page is never rendered: its fields are no sources.
        if (c.type === COMPONENT.WEB_PAGE && c.content.isroot === false && this.inactivePages.has(String(c.content.rootwebpageid ?? '').toLowerCase())) {
          this.inactiveSources.push({ file: c.file, rel: c.rel });
          continue;
        }
        const fields =
          c.type === COMPONENT.WEB_PAGE
            ? [['page-js', 'customjavascript', 'block', 'script'], ['page-css', 'customcss', 'block', 'style'], ['page-copy', 'copy', 'markup'], ['page-summary', 'summary', 'markup']]
            : c.type === COMPONENT.WEB_TEMPLATE
              ? [['web-template', 'source', 'markup']]
              : c.type === COMPONENT.BASIC_FORM
                ? [['basic-form-js', 'customjavascript', 'block', 'script']]
                : c.type === COMPONENT.LIST
                  ? [['list-js', 'customjavascript', 'block', 'script']]
                  : c.type === COMPONENT.ADVANCED_FORM_STEP
                    ? [['advanced-form-step-js', 'customjavascript', 'block', 'script']]
                    : [['content-snippet', 'value', 'markup']];
        for (const [kind, field, mode, tag] of fields) {
          this.inlineSources.push({
            kind,
            mode,
            tag: tag ?? null,
            file: c.file,
            sourceDir: this.sourceDir,
            // several sources share one XML file; the field keeps them apart
            rel: `${c.rel}#${field}`,
            label: `${c.name} (${field})`,
            field,
            extract: componentField(field),
            pageUrl: c.type === COMPONENT.WEB_PAGE ? this.pagePath(c.id) : null,
            usedOn: c.type === COMPONENT.BASIC_FORM || c.type === COMPONENT.LIST ? this.pagesShowing(c.id) : c.type === COMPONENT.ADVANCED_FORM_STEP ? this.pagesShowing(c.content.webform) : [],
            snippetName: c.type === COMPONENT.CONTENT_SNIPPET ? c.name : undefined,
          });
        }
      }
    }
    this.webFiles.sort((a, b) => String(a.url).localeCompare(String(b.url)));
  }

  /** Registers a web file under its URL, or records why it cannot be served. */
  #addWebFile(entry, label) {
    this.webFiles.push(entry);
    if (entry.problem) {
      this.warnings.push(`${label}: ${entry.problem}`);
      return;
    }
    const key = urlKey(entry.url);
    const existing = this.webFileByUrl.get(key);
    if (existing || this.duplicateWebFileUrls.has(key)) {
      entry.problem = `duplicate URL ${entry.url}; ambiguous local overrides are disabled`;
      if (existing) existing.problem = entry.problem;
      this.duplicateWebFileUrls.add(key);
      this.webFileByUrl.delete(key);
      this.warnings.push(`${label}: ${entry.problem}`);
      return;
    }
    this.webFileByUrl.set(key, entry);
  }

  #loadPages() {
    /** @type {Map<string, {id:string, partialUrl:string, parentId:string|null, name:string, dir:string, isRoot:boolean}>} */
    this.pages = new Map();
    const pagesDir = path.join(this.sourceDir, 'web-pages');
    for (const file of this.#files(pagesDir)) {
      if (!file.endsWith('.webpage.yml')) continue;
      const y = this.#readYaml(file);
      if (!yamlId(y, 'webpage')) continue;
      const id = String(yamlId(y, 'webpage')).toLowerCase();
      if (Number(y.statecode) === 1) {
        this.inactivePages.add(id);
        continue;
      }
      const components = [yamlValue(y, 'entityform'), yamlValue(y, 'webform'), yamlValue(y, 'entitylist')].filter(Boolean).map((value) => String(value).toLowerCase());
      this.#indexPageComponents(id, components);
      const rootId = yamlValue(y, 'rootwebpageid') ? String(yamlValue(y, 'rootwebpageid')).toLowerCase() : null;
      if (rootId && rootId !== id) {
        this.pageAlias.set(id, rootId);
        continue;
      }
      // A language record lacking its root cannot establish a separate URL tree.
      if (path.basename(path.dirname(file)) === 'content-pages' || path.basename(path.dirname(path.dirname(file))) === 'content-pages') {
        this.warnings.push(`${path.relative(this.sourceDir, file)}: language page has no root page`);
        continue;
      }
      this.pages.set(id, {
        id,
        partialUrl: String(yamlValue(y, 'partialurl') ?? ''),
        parentId: yamlValue(y, 'parentpageid') ? String(yamlValue(y, 'parentpageid')).toLowerCase() : null,
        name: yamlValue(y, 'name'),
        dir: path.dirname(file),
        // the form / list the page is configured to show
        components,
      });
      this.pageByDir.set(path.dirname(file), id);
    }
    this.pagePathCache = new Map();
    for (const page of this.pages.values()) {
      if (this.pagePath(page.id) == null) this.warnings.push(`web-pages/${path.basename(page.dir)}: missing parent page or a cycle in the page hierarchy`);
    }
  }

  /** URL paths of the pages configured to show the form / list with this id. */
  pagesShowing(componentId) {
    if (!componentId) return [];
    const id = String(componentId).toLowerCase();
    const out = new Set();
    for (const pageId of this.componentPages.get(id) ?? []) {
      const p = this.pagePath(pageId);
      if (p) out.add(p);
    }
    return [...out].sort();
  }

  /** Full URL path of a web page ("/" for home), or null when the parent chain is broken. */
  pagePath(pageId, seen = new Set()) {
    if (!pageId) return null;
    const given = String(pageId).toLowerCase();
    if (this.pageAlias.has(given)) {
      if (seen.has(given)) return null;
      seen.add(given);
      return this.pagePath(this.pageAlias.get(given), seen);
    }
    const id = given;
    if (this.pagePathCache.has(id)) return this.pagePathCache.get(id);
    const page = this.pages.get(id);
    if (!page || seen.has(id)) return null;
    seen.add(id);
    let result;
    if (!page.parentId) {
      result = joinUrl('/', page.partialUrl);
    } else {
      const parentPath = this.pagePath(page.parentId, seen);
      result = parentPath == null ? null : joinUrl(parentPath, page.partialUrl);
    }
    this.pagePathCache.set(id, result);
    return result;
  }

  #loadWebFiles() {
    /** @type {Array<object>} */
    this.webFiles = [];
    /** @type {Map<string, object>} */
    this.webFileByUrl = new Map();
    const dir = path.join(this.sourceDir, 'web-files');
    if (!fs.existsSync(dir)) return;
    // PAC YAML keeps every web file in web-files/; a .powerpages-site export gives each one a folder.
    const folders = [dir, ...(this.shortKey ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name)) : [])];
    for (const folder of folders) {
      const names = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
      const nameSet = new Set(names);
      for (const name of names) {
        if (!name.endsWith('.webfile.yml')) continue;
        const ymlFile = path.join(folder, name);
        const y = this.#readYaml(ymlFile);
        if (Number(y.statecode) === 1) continue;
        const base = name.slice(0, -'.webfile.yml'.length);
        // pac writes the attachment next to the yml: normally under the yml's base name, otherwise
        // under the annotation's original file name
        const candidates = [base, y.filename, yamlValue(y, 'name')].filter(Boolean).map(String);
        const contentName = candidates.find((c) => nameSet.has(c) && !c.endsWith('.webfile.yml'));
        const parentPath = this.pagePath(yamlValue(y, 'parentpageid'));
        const partialUrl = yamlValue(y, 'partialurl');
        const entry = {
          id: yamlId(y, 'webfile'),
          name: yamlValue(y, 'name'),
          yml: ymlFile,
          file: contentName ? path.join(folder, contentName) : null,
          partialUrl,
          parentPageId: yamlValue(y, 'parentpageid') ?? null,
          url: parentPath == null || partialUrl == null ? null : joinUrl(parentPath, partialUrl),
          mimeType: y.mimetype,
          problem: null,
        };
        if (!entry.file) entry.problem = 'no content file on disk next to the .webfile.yml';
        else if (entry.url == null) entry.problem = 'parent page not found in web-pages/, cannot build the URL';
        this.#addWebFile(entry, path.relative(this.sourceDir, ymlFile).replace(/\\/g, '/'));
      }
    }
    this.webFiles.sort((a, b) => String(a.url).localeCompare(String(b.url)));
  }

  #loadInlineSources() {
    /** @type {Array<object>} */
    this.inlineSources = [];
    for (const dir of ['basic-forms', 'advanced-forms']) {
      for (const file of this.#files(path.join(this.sourceDir, dir))) {
        if (file.endsWith('.advancedformstep.yml')) {
          const metadata = this.#readYaml(file);
          const id = yamlId(metadata, 'webformstep') ? String(yamlId(metadata, 'webformstep')).toLowerCase() : null;
          if (id && yamlValue(metadata, 'webform')) this.stepForms.set(id, String(yamlValue(metadata, 'webform')).toLowerCase());
          if (id && Number(metadata.statecode) === 1) this.inactiveSteps.add(id);
          continue;
        }
        if (!/\.(?:basicform|advancedform)\.yml$/.test(file)) continue;
        const metadata = this.#readYaml(file);
        const id = file.endsWith('.basicform.yml') ? yamlId(metadata, 'entityform') : yamlId(metadata, 'webform');
        if (Number(metadata.statecode) === 1 && id) this.inactiveForms.add(String(id).toLowerCase());
      }
    }
    for (const def of INLINE_KINDS) {
      const dir = path.join(this.sourceDir, def.dir);
      for (const file of this.#files(dir)) {
        if (!file.endsWith(def.suffix)) continue;
        const metadataFile = file.slice(0, -def.suffix.length) + def.suffix.replace(/\.[^.]+\.[^.]+$/, '.yml');
        const metadata = this.fileInventory.has(metadataFile) ? this.#readYaml(metadataFile) : {};
        if (metadata.__error || Number(metadata.statecode) === 1) continue;
        // A language copy whose root page is inactive is not rendered online either.
        if (def.dir === 'web-pages' && this.inactivePages.has(String(yamlValue(metadata, 'rootwebpageid') ?? '').toLowerCase())) {
          this.inactiveSources.push({ file, rel: path.relative(this.sourceDir, file).replace(/\\/g, '/') });
          continue;
        }
        const entry = {
          kind: def.kind,
          mode: def.mode,
          tag: def.tag ?? null,
          file,
          sourceDir: this.sourceDir,
          rel: path.relative(this.sourceDir, file).replace(/\\/g, '/'),
          // the one page a page-* source belongs to
          pageUrl: null,
          // pages configured to show a form/list source. Only a hint: forms are also placed with
          // Liquid ({% entityform %}) and opened in modals, which the page configuration does not show.
          usedOn: [],
        };
        if (def.dir === 'web-pages') entry.pageUrl = this.#pageUrlForFile(file);
        else if (def.kind === 'basic-form-js') {
          entry.usedOn = this.pagesShowing(yamlId(metadata, 'entityform'));
        } else if (def.kind === 'list-js') {
          entry.usedOn = this.pagesShowing(yamlId(metadata, 'entitylist'));
        } else if (def.kind === 'advanced-form-step-js') {
          // The relationship is authoritative, including steps exported outside the usual folder.
          let formId = yamlValue(metadata, 'webform');
          // <form>/advanced-form-steps/<step>/<Step>.advancedformstep.custom_javascript.js
          const formDir = path.resolve(path.dirname(file), '..', '..');
          const formYml = fs.existsSync(formDir) ? fs.readdirSync(formDir).find((n) => n.endsWith('.advancedform.yml')) : null;
          if (!formId && formYml) formId = yamlId(this.#readYaml(path.join(formDir, formYml)), 'webform');
          if (this.inactiveForms.has(String(formId ?? '').toLowerCase())) {
            this.inactiveSources.push({ file, rel: entry.rel });
            continue;
          }
          entry.usedOn = this.pagesShowing(formId);
        } else if (def.kind === 'content-snippet') {
          entry.snippetName = yamlValue(metadata, 'name');
        }
        this.inlineSources.push(entry);
      }
    }
    for (const def of this.shortKey ? SHORT_KEY_MARKUP_KINDS : YAML_MARKUP_KINDS) {
      for (const file of this.#files(path.join(this.sourceDir, def.dir))) {
        if (!file.endsWith(def.suffix)) continue;
        const metadata = this.#readYaml(file, true);
        if (metadata.__error) continue;
        const rel = path.relative(this.sourceDir, file).replace(/\\/g, '/');
        for (const [index, record] of (Array.isArray(metadata) ? metadata.entries() : [[null, metadata]])) {
          if (!record || typeof record !== 'object' || Number(record.statecode) === 1) continue;
          const stepId = String(yamlValue(record, 'webformstep') ?? '').toLowerCase();
          const formId = yamlValue(record, 'entityform') ?? yamlValue(record, 'webform') ?? this.stepForms.get(stepId);
          if (this.inactiveSteps.has(stepId) || this.inactiveForms.has(String(formId ?? '').toLowerCase())) {
            this.inactiveSources.push({ file, rel });
            continue;
          }
          const recordIdField = ['adx_entityformmetadataid', 'adx_webformmetadataid', 'adx_weblinkid', 'adx_pollid', 'adx_entityformid', 'adx_weblinksetid', 'id'].find((key) => record[key] != null);
          for (const field of def.fields) {
            for (const value of markupValues(record[field])) {
              const fieldPath = index === null ? [field] : [index, field];
              const source = {
                kind: 'metadata-markup', mode: 'markup', tag: null,
                file, sourceDir: this.sourceDir,
                rel: `${rel}#${fieldPath.join('.')}${value.jsonPath ? '.' + value.jsonPath.join('.') : ''}`,
                label: `${yamlValue(record, 'name') ?? yamlValue(record, 'attributelogicalname') ?? path.basename(file)} (${field})`,
                format: 'yaml', field, fieldPath, ...value,
                recordId: index !== null && recordIdField ? record[recordIdField] : undefined,
                recordIdField: index !== null ? recordIdField : undefined,
                pageUrl: null, usedOn: this.pagesShowing(formId),
              };
              source.extract = yamlField(source);
              this.inlineSources.push(source);
            }
          }
        }
      }
    }
  }

  #pageUrlForFile(file) {
    const def = inlineKindOf(file);
    const meta = def ? file.slice(0, -def.suffix.length) + '.webpage.yml' : null;
    if (meta && this.currentYaml.has(meta)) {
      const id = yamlId(this.currentYaml.get(meta), 'webpage');
      if (id) return this.pagePath(id);
    }
    let dir = path.dirname(file);
    if (path.basename(path.dirname(dir)) === 'content-pages') dir = path.dirname(path.dirname(dir));
    else if (path.basename(dir) === 'content-pages') dir = path.dirname(dir);
    return this.pagePath(this.pageByDir.get(dir));
  }

  /** Changes the overlay cannot render: portal configuration, record creation/deletion and schema. */
  deploymentChanges(baseline, changed) {
    const files = [...changed].map((file) => ({ file, rel: path.relative(this.sourceDir, file).replace(/\\/g, '/') })).filter(({ rel }) => this.format === 'enhanced' ? /^powerpagecomponents\/[^/]+\/powerpagecomponent\.xml$/i.test(rel) : CLASSIC_METADATA.test(rel) && !rel.startsWith('../'));
    baseline.preload?.(files.map(({ file }) => file));
    const changes = [];
    if (this.format === 'classic') {
      const indexed = new Set(this.inlineSources.map((source) => source.file));
      for (const file of changed) {
        if (!inlineKindOf(file) || indexed.has(file)) continue;
        const rel = path.relative(this.sourceDir, file).replace(/\\/g, '/');
        if (!rel.startsWith('../')) changes.push({ rel, reason: 'source is deleted or belongs to an inactive/unindexed portal record; metadata or deployment must be corrected before it can be previewed' });
      }
    }
    for (const { file, rel } of files) {
      const before = baseline.show(file);
      let after = null;
      try { if (isSourceFile(this.sourceDir, file)) after = fs.readFileSync(file, 'utf8'); } catch { /* deleted metadata */ }
      if (before === after) continue;
      if (before === null || after === null) {
        changes.push({ rel, reason: `${after === null ? 'deleted' : 'new'} portal metadata requires deployment; the overlay cannot create or delete portal records` });
        continue;
      }
      if (this.format !== 'enhanced') {
        let equal = false;
        try {
          const oldContent = YAML.parse(before);
          const newContent = YAML.parse(after);
          const preview = this.inlineSources.filter((source) => source.file === file && source.format === 'yaml');
          stripPreviewFields(oldContent, newContent, preview);
          equal = stableValue(oldContent) === stableValue(newContent);
        } catch { /* broken edit is actionable */ }
        if (!equal) changes.push({ rel, reason: 'portal metadata changed; URLs, permissions and server-side configuration require deployment' });
        continue;
      }
      const oldContent = componentContent(before);
      const newContent = componentContent(after);
      if (!oldContent || !newContent) {
        if (!this.inlineSources.some((source) => source.file === file)) changes.push({ rel, reason: 'component metadata cannot be compared because its <content> is not a JSON object' });
        continue;
      }
      const type = Number(/<powerpagecomponenttype>\s*(\d+)\s*</.exec(after)?.[1]);
      const inactive = /<statecode>\s*1\s*<\/statecode>/.test(after);
      const preview = new Set(inactive ? [] : PREVIEW_FIELDS.get(type) ?? []);
      if (!inactive) stripPreviewFields(oldContent, newContent, this.inlineSources.filter((source) => source.file === file && source.kind === 'metadata-markup'));
      const changedFields = [...new Set([...Object.keys(oldContent), ...Object.keys(newContent)])].filter((key) => !preview.has(key) && stableValue(oldContent[key]) !== stableValue(newContent[key]));
      const outer = (xml) => {
        const span = componentContentSpan(xml);
        return (span ? xml.slice(0, span.contentStart) + xml.slice(span.contentEnd) : xml).replace(/>\s+</g, '><').trim();
      };
      if (changedFields.length || outer(before) !== outer(after)) {
        changes.push({ rel, reason: `component metadata changed${changedFields.length ? ` (${changedFields.join(', ')})` : ''}; these fields require deployment` });
      }
    }
    return changes;
  }

  /** Looks up the local web file that backs an online URL path. */
  findWebFile(urlPath) {
    return this.webFileByUrl.get(urlKey(urlPath)) ?? null;
  }
}
