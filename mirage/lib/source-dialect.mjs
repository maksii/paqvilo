import fs from 'node:fs';
import path from 'node:path';

/**
 * The layout ("dialect") of a portal source folder, from cheap evidence on disk. The
 * Mirage imports five of them; the others are named so that a source the importer
 * cannot read fails loudly instead of importing as an empty portal.
 *
 * - "standard-yaml": PAC YAML with adx_ keys (website.yml adx_websiteid). PAC 2.13.1
 *   pac pages download writes adx_ keys for both data models: an enhanced data model site
 *   (--modelVersion 2 or Enhanced) also downloads with adx_ keys, and its website.yml can
 *   carry adx_enhancedauthorization (hosted session F5).
 * - "enhanced-solution": an unpacked Solution with powerpagecomponents/<id>/powerpagecomponent.xml.
 * - "short-key-yaml": .powerpages-site YAML with unprefixed keys (id:, isroot, parentpageid),
 *   written by code sites (pac pages download-code-site) and, per Microsoft's Power Pages
 *   plugin, by current pac pages download. Imported like standard YAML: IDs from id:,
 *   content-pages/<language>/, one folder per web file and language codes from
 *   .portalconfig/*.portallanguage.yml.
 * - "code-site-project": a code-site project folder with its .powerpages-site/ records,
 *   or a project with powerpages.config.json that can be served from its compiled output.
 * - "enhanced-yaml": YAML records with mspp_ keys, read as the enhanced data model. PAC 2.13.1
 *   does not write this layout (its enhanced data model downloads keep adx_ keys); the reader
 *   stays for existing sources in it.
 * - "solution-without-site": an unpacked Solution (Other/Solution.xml) without site components.
 * - "unknown": none of the above.
 */
const IMPORTED_DIALECTS = Object.freeze([
  'standard-yaml',
  'enhanced-yaml',
  'enhanced-solution',
  'short-key-yaml',
  'code-site-project',
]);

const LABELS = {
  'standard-yaml': 'PAC YAML with adx_ keys',
  'enhanced-solution': 'an unpacked Solution with powerpagecomponents/ (enhanced data model)',
  'enhanced-yaml': 'portal YAML with mspp_ keys (a layout PAC 2.13.1 does not write)',
  'short-key-yaml':
    '.powerpages-site short-key YAML (keys such as id:, isroot and parentpageid, written by code sites and current pac pages download)',
  'code-site-project': 'a Power Pages code-site project',
  'solution-without-site': 'an unpacked Solution without Power Pages site components (no powerpagecomponents/)',
  unknown: 'no recognized portal layout (no website.yml, web-pages/, web-files/ or powerpagecomponents/)',
};

const YAML_STYLES = {
  adx: { dialect: 'standard-yaml', keys: 'adx_ keys' },
  mspp: { dialect: 'enhanced-yaml', keys: 'mspp_ keys' },
  short: { dialect: 'short-key-yaml', keys: 'id: and unprefixed keys' },
};

const isDirectory = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Top-level YAML keys of a file (a cheap scan; values are not parsed). */
function yamlKeys(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, 64 * 1024);
    return [...text.matchAll(/^(?:- )?([A-Za-z_]\w*):/gm)].map((match) => match[1].toLowerCase());
  } catch {
    return [];
  }
}

/** The key style of YAML records: "adx", "mspp", "short" or null. */
function keyStyle(keys) {
  if (
    keys.some(
      (key) =>
        key.startsWith('adx_') &&
        key !== 'adx_entitypermission_webrole' &&
        key !== 'adx_webpageaccesscontrolrule_webrole' &&
        key !== 'adx_websiteaccess_webrole',
    )
  )
    return 'adx';
  if (keys.some((key) => key.startsWith('mspp_'))) return 'mspp';
  if (keys.includes('id')) return 'short';
  return null;
}

/** A few record files under a folder, for the key style when website.yml is missing. */
function sampleRecords(dir, limit = 5) {
  const found = [];
  const visit = (folder, depth) => {
    if (found.length >= limit || depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    // Code-unit order: the sample is the first records found, and listing order differs between file systems.
    for (const entry of entries.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name))) {
      if (found.length >= limit) return;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (/\.(?:webpage|webtemplate|sitesetting|contentsnippet|webfile)\.ya?ml$/i.test(entry.name))
        found.push(file);
    }
  };
  for (const name of ['web-pages', 'web-templates', 'site-settings', 'content-snippets', 'web-files'])
    visit(path.join(dir, name), 0);
  return found;
}

/** { dialect, label, imported, evidence } for a portal source folder. */
export function detectSourceDialect(dir) {
  const result = (dialect, evidence) => ({
    dialect,
    label: LABELS[dialect],
    imported: IMPORTED_DIALECTS.includes(dialect),
    evidence,
  });
  if (!dir || !isDirectory(dir)) return result('unknown', 'the folder does not exist');
  if (isDirectory(path.join(dir, 'powerpagecomponents'))) return result('enhanced-solution', 'powerpagecomponents/');
  const website = ['website.yml', 'website.yaml'].map((name) => path.join(dir, name)).find(isFile);
  const style = keyStyle(website ? yamlKeys(website) : sampleRecords(dir).flatMap(yamlKeys));
  if (style) {
    const { dialect, keys } = YAML_STYLES[style];
    return result(dialect, `${website ? 'website.yml' : 'records'} with ${keys}`);
  }
  if (path.basename(dir).toLowerCase() === '.powerpages-site')
    return result('short-key-yaml', 'a .powerpages-site folder');
  if (isDirectory(path.join(dir, '.powerpages-site'))) return result('code-site-project', '.powerpages-site/');
  if (isFile(path.join(dir, 'powerpages.config.json'))) return result('code-site-project', 'powerpages.config.json');
  if (isFile(path.join(dir, 'Other', 'Solution.xml')))
    return result('solution-without-site', 'Other/Solution.xml without powerpagecomponents/');
  return result('unknown', 'no website.yml, portal records or powerpagecomponents/');
}

/** Thrown when a source is not a portal the runtime can serve (zero recognised pages). */
export class PortalSourceError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PortalSourceError';
    this.code = 'PORTAL_SOURCE_EMPTY';
    Object.assign(this, details);
  }
}

/** The diagnostic message for a source with zero recognised pages. */
export function unrecognisedSourceMessage(sourceDir, dialect, { pageRecords = 0 } = {}) {
  let advice;
  if (dialect.imported) {
    if (pageRecords)
      advice = `It has ${pageRecords} web page record${pageRecords === 1 ? '' : 's'}, but none could be identified as a page.`;
    else advice = 'It has no web pages.';
  } else
    advice =
      'Point it at the folder that contains website.yml (a PAC YAML or .powerpages-site export), or at an unpacked Solution with powerpagecomponents/.';
  return `No portal pages were recognized in ${sourceDir}. Detected layout: ${dialect.label}. ${advice}`;
}

/**
 * Refuse a source with zero recognised pages (serve, inspect, bootstrap-report): throws a
 * PortalSourceError naming the detected layout. `portal` is an importPortal() result.
 */
export function assertPortalSource(portal) {
  if ((portal?.pages ?? []).length) return portal;
  const dialect = portal?.source?.dialect ? portal.source : detectSourceDialect(portal?.sourceDir);
  const pageRecords = (portal?.records ?? []).filter((record) => record.kind === 'webpage').length;
  throw new PortalSourceError(unrecognisedSourceMessage(portal?.sourceDir, dialect, { pageRecords }), {
    dialect: dialect.dialect,
    sourceDir: portal?.sourceDir ?? null,
    pageRecords,
  });
}

/**
 * The folder that holds a portal's records: a code-site project's .powerpages-site/ folder, else
 * the folder itself. Serve, inspect and the importer read the same folder.
 */
export function portalSourceDir(dir) {
  if (!dir) return dir;
  const nested = path.join(dir, '.powerpages-site');
  return detectSourceDialect(dir).dialect === 'code-site-project' && isDirectory(nested) ? nested : dir;
}
