import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from '../../lense/local-file.mjs';

const CONFIG = 'powerpages.config.json';
const MAX_CONFIG_BYTES = 64 * 1024;

function inside(root, file) {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function localPath(root, value, field) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || path.win32.isAbsolute(value))
    throw new Error(`${field} must be a relative path.`);
  const resolved = path.resolve(root, value);
  if (!inside(root, resolved)) throw new Error(`${field} must stay inside its parent directory.`);
  return resolved;
}

async function readManifest(configFile, project) {
  try {
    return await readLocalFile(configFile, { root: project, maxBytes: MAX_CONFIG_BYTES, encoding: 'utf8' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A missing optional manifest and an unreadable link have different diagnostics.
    try {
      await fs.lstat(configFile);
    } catch (error_) {
      if (error_.code === 'ENOENT') return null;
      throw error_;
    }
    throw error;
  }
}

export async function readCodeSite(sourceDir, diagnostics) {
  const project = path.basename(sourceDir).toLowerCase() === '.powerpages-site' ? path.dirname(sourceDir) : sourceDir;
  const configFile = path.join(project, CONFIG);
  try {
    const manifest = await readManifest(configFile, project);
    if (manifest === null) return null;
    const options = JSON.parse(manifest.replace(/^\uFEFF/, ''));
    const compiledDir = await fs.realpath(localPath(project, options?.compiledPath, 'compiledPath'));
    if (!inside(project, compiledDir) || !(await fs.stat(compiledDir)).isDirectory())
      throw new Error('compiledPath must name a build output directory inside the code-site project.');
    const landing = localPath(compiledDir, options.defaultLandingPage, 'defaultLandingPage');
    const entryFile = await fs.realpath(landing);
    if (!inside(compiledDir, entryFile) || !/\.html?$/i.test(landing) || !(await fs.stat(entryFile)).isFile())
      throw new Error('defaultLandingPage must name a compiled HTML file.');
    return {
      configFile,
      compiledDir,
      entryFile,
      entryPath: '/' + path.relative(compiledDir, landing).split(path.sep).map(encodeURIComponent).join('/'),
      siteName: typeof options.siteName === 'string' ? options.siteName.trim() : '',
    };
  } catch (error) {
    diagnostics.push({
      code: 'CODE_SITE_COMPILED_UNAVAILABLE',
      file: configFile,
      message: error.code
        ? `Compiled Power Pages site configuration could not be read (${error.code}).`
        : error.message,
    });
    return { configFile, compiledDir: null, entryFile: null, entryPath: null };
  }
}

const MAX_LANDING_BYTES = 8 * 1024 * 1024;
const MAX_FOLDER_PAGES = 500;

/** The build's folders below `directory` (relative parts), without dot or platform (_) folders and without links. */
async function buildFolders(directory, parts = [], found = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return found;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= MAX_FOLDER_PAGES) break;
    if (!entry.isDirectory() || /^[._]/.test(entry.name)) continue;
    found.push([...parts, entry.name]);
    await buildFolders(path.join(directory, entry.name), [...parts, entry.name], found);
  }
  return found;
}

/**
 * The pages of a code site as pac pages upload-code-site stores the local build (hosted session F5): the landing page
 * is the copy of the Home page (every language), as literal source text of the landing file, and each build folder is a
 * web page under its parent folder's page, with the Home page's page template and an empty copy. A folder that the
 * export already has a page for keeps that page. Changes `pages` in place.
 */
export async function codeSiteUploadPages(site, pages, diagnostics) {
  const home = pages.find((page) => page.url === '/');
  if (!home) return;
  let landing;
  try {
    landing = await readLocalFile(site.entryFile, {
      root: site.compiledDir,
      maxBytes: MAX_LANDING_BYTES,
      encoding: 'utf8',
    });
  } catch (error) {
    diagnostics.push({
      code: 'CODE_SITE_COMPILED_UNAVAILABLE',
      file: site.entryFile,
      message: `The compiled landing page could not be read (${error.code ?? error.message}).`,
    });
    return;
  }
  const origin = { value: landing, file: site.entryFile, sidecar: true };
  for (const variant of [home, ...Object.values(home.translations ?? {})]) {
    variant.html = landing;
    const record = variant.metadata ?? home.metadata;
    // In place: the language content page record shares this object with its page's merged metadata.
    if (record) {
      record._fieldOrigins ??= {};
      record._fieldOrigins.copy = origin;
    }
  }
  const byUrl = new Map(pages.map((page) => [page.url.toLowerCase(), page]));
  for (const parts of await buildFolders(site.compiledDir)) {
    const url = '/' + parts.map(encodeURIComponent).join('/') + '/';
    if (byUrl.has(url.toLowerCase())) continue;
    const parentUrl = parts.length > 1 ? '/' + parts.slice(0, -1).map(encodeURIComponent).join('/') + '/' : '/';
    const parent = byUrl.get(parentUrl.toLowerCase()) ?? home;
    const name = parts.at(-1);
    const id = `local-code-site-folder:${parts.join('/').toLowerCase()}`;
    const page = {
      id,
      name,
      title: name,
      url,
      parentId: parent.id,
      pageTemplateId: home.pageTemplateId ?? null,
      html: '',
      metadata: { id, name, partialurl: name, parentpageid: parent.id, pagetemplateid: home.pageTemplateId ?? null },
      translations: {},
    };
    pages.push(page);
    byUrl.set(url.toLowerCase(), page);
  }
}

/** A route admits files from the configured build only; neither dotfiles nor platform paths are app assets. */
function requestParts(pathname) {
  if (!pathname.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const parts = decoded.slice(1).split('/');
  if (parts.at(-1) === '') parts.pop();
  if (
    parts[0]?.startsWith('_') ||
    parts.some(
      (item) =>
        !item ||
        item.startsWith('.') ||
        /[\\:]/.test(item) ||
        [...item].some((char) => char <= '\u001f' || char === '\u007f'),
    )
  )
    return null;
  return parts;
}

/**
 * The entry of `directory` that `name` names: the exact name, else the one entry that equals it ignoring case (hosted
 * code-site paths are case-insensitive, session F5), else null.
 */
async function caseInsensitiveEntry(directory, name) {
  try {
    await fs.lstat(path.join(directory, name));
    return name;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
  const matches = entries.filter((entry) => entry.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The build file a request path names, { file, caseVariant }, or null. The landing page is a file like any other (the
 * upload stores it as a web file too). Names match ignoring case; `caseVariant` is true when the request spelled the
 * file's path in another case (it is served with other caching, session F5).
 */
export async function resolveCompiledCodeSiteFile(site, pathname) {
  const parts = requestParts(pathname);
  if (!parts?.length || pathname.endsWith('/')) return null;
  let requested = site.compiledDir;
  for (const part of parts) {
    const entry = await caseInsensitiveEntry(requested, part);
    if (entry === null) return null;
    requested = path.join(requested, entry);
  }
  try {
    const file = await fs.realpath(requested);
    // The resolved path is checked again: a link or a Windows 8.3 short name (ENV~1) can reach a dotfile.
    if (
      !inside(site.compiledDir, file) ||
      path
        .relative(site.compiledDir, file)
        .split(path.sep)
        .some((part) => part.startsWith('.')) ||
      !(await fs.stat(file)).isFile()
    )
      return null;
    const asked = parts.join('/'),
      found = path.relative(site.compiledDir, file).split(path.sep).join('/');
    return { file, caseVariant: found !== asked && found.toLowerCase() === asked.toLowerCase() };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

/** The build file a request path names (resolveCompiledCodeSiteFile), or null. */
export async function compiledCodeSiteAsset(site, pathname) {
  return (await resolveCompiledCodeSiteFile(site, pathname))?.file ?? null;
}

// The extensions of static file types: a missing build file with one of them answers 404 on a hosted code site
// (/missing.css, /missing.png, /assets/missing.js in session F5), while a path with any other extension (/main.html
// without such a file, /route.with.dot) or none is an application route.
const STATIC_FILE_EXTENSIONS = new Set(
  'js mjs css map json wasm webmanifest txt svg png jpg jpeg gif ico webp avif woff woff2 ttf otf eot pdf'
    .split(' ')
    .map((extension) => `.${extension}`),
);
const staticFileType = (name) => STATIC_FILE_EXTENSIONS.has(path.extname(String(name ?? '')).toLowerCase());

/** True when a request path is an application route of a code site: a page path, not a static file type. */
export function codeSiteNavigation(site, pathname) {
  const parts = requestParts(pathname);
  return parts !== null && !staticFileType(parts.at(-1));
}

/** True when a request path names a static file type (a missing one answers 404 on a hosted code site). */
export function codeSiteMissingFile(site, pathname) {
  const parts = requestParts(pathname);
  return Boolean(parts?.length) && !pathname.endsWith('/') && staticFileType(parts.at(-1));
}

/**
 * The 404 document a hosted code site answered for a missing static file (session F5, runs a and c; other requests of
 * the same runs got an 86-byte body without a content type).
 */
export const CODE_SITE_MISSING_FILE_DOCUMENT = [
  '<html lang="en-US">',
  '<head>',
  '\t<meta name="viewport" content="width=device-width, initial-scale=1.0">',
  '\t<style>',
  '\t\t.h1 {',
  '\t\t\tfont-family: Segoe UI;',
  '\t\t\tfont-style: normal;',
  '\t\t\tfont-weight: 600;',
  '\t\t\tfont-size: 28px;',
  '\t\t\tline-height: 37px;',
  '\t\t\ttext-align: center;',
  '\t\t\tcolor: #000000;',
  '\t\t\tmargin: 0 auto;',
  '\t\t\tmargin-bottom: 7px;',
  '\t\t}',
  '',
  '\t\tp {',
  '\t\t\tfont-family: Segoe UI;',
  '\t\t\tfont-style: normal;',
  '\t\t\tfont-weight: normal;',
  '\t\t\tfont-size: 14px;',
  '\t\t\tline-height: 19px;',
  '\t\t\ttext-align: center;',
  '\t\t\tcolor: #000000;',
  '\t\t\tmargin: 0 auto;',
  '\t\t}',
  '',
  '\t\tbody {',
  '\t\t\tbackground: #fff;',
  '\t\t\tdisplay: flex;',
  '\t\t\talign-items: flex-end;',
  '\t\t\tjustify-content: center;',
  '\t\t\tflex-wrap: wrap;',
  '\t\t\tmargin-top: auto;',
  '\t\t\theight: 100%;',
  '\t\t\tmargin-left: 0;',
  '\t\t\tmargin-right: 0;',
  '\t\t}',
  '',
  '\t\t.pot {',
  '\t\t\ttext-align: center;',
  '\t\t\twidth: 100%;',
  '\t\t}',
  '',
  '\t\t\t.pot img {',
  '\t\t\t\twidth: 100%;',
  '\t\t\t\theight: auto;',
  '\t\t\t\tmax-width: 100%;',
  '\t\t\t}',
  '',
  '\t\tp {',
  '\t\t\tmargin: 0px',
  '\t\t}',
  '',
  '\t\t.main {',
  '\t\t\ttext-align: center;',
  '\t\t}',
  '',
  '\t\tul {',
  '\t\t\ttext-align: center;',
  '\t\t\tdisplay: inline-block;',
  '\t\t\tmargin-left: -30px;',
  '\t\t}',
  '',
  '\t\t\tul li {',
  '\t\t\t\ttext-align: left;',
  '\t\t\t}',
  '\t</style>',
  '\t<title>Page Not Found</title>',
  '</head>',
  '<body>',
  '\t<div class="main" aria-live="polite">',
  '\t\t<h1 class="h1">Page Not Found</h1>',
  "\t\t<p>We're sorry, but the page you were trying to view doesn't exist.</p>",
  '\t\t<p>It looks like this was the result of either:</p>',
  '\t\t<ul>',
  '\t\t\t<li>a mistyped address</li>',
  '\t\t\t<li>an out-of-date link</li>',
  '\t\t</ul>',
  '\t</div>',
  '\t<div class="pot">',
  '\t\t<img src="~/img/pot.png" role="presentation" />',
  '\t</div>',
  '</body>',
  '</html>',
  '',
].join('\r\n');
