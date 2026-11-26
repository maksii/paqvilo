import fs from 'node:fs/promises';
import { parse } from 'parse5';
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

export async function compiledCodeSiteAsset(site, pathname) {
  const parts = requestParts(pathname);
  if (!parts?.length || pathname.endsWith('/')) return null;
  const requested = path.join(site.compiledDir, ...parts);
  try {
    const file = await fs.realpath(requested);
    // The resolved path is checked again: a link or a Windows 8.3 short name (ENV~1) can reach a dotfile.
    if (
      !inside(site.compiledDir, file) ||
      path
        .relative(site.compiledDir, file)
        .split(path.sep)
        .some((part) => part.startsWith('.')) ||
      file === site.entryFile ||
      !(await fs.stat(file)).isFile()
    )
      return null;
    return file;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
}

export function codeSiteNavigation(site, pathname) {
  const parts = requestParts(pathname);
  return pathname === site.entryPath || (parts !== null && !path.extname(parts.at(-1) ?? ''));
}

function hasAuthoredBase(document) {
  const pending = [document];
  while (pending.length) {
    const node = pending.pop();
    if (
      node.tagName === 'base' &&
      node.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      node.attrs.some(({ name }) => name === 'href')
    )
      return true;
    for (const child of node.childNodes ?? []) pending.push(child);
  }
  return false;
}

export function codeSiteDocument(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  if (hasAuthoredBase(document)) return html;
  const root = document.childNodes.find((node) => node.tagName === 'html');
  const head = root?.childNodes.find((node) => node.tagName === 'head');
  const doctype = document.childNodes.find((node) => node.nodeName === '#documentType');
  const offset =
    head?.sourceCodeLocation?.startTag?.endOffset ??
    root?.sourceCodeLocation?.startTag?.endOffset ??
    doctype?.sourceCodeLocation?.endOffset ??
    0;
  return `${html.slice(0, offset)}<base href="/">${html.slice(offset)}`;
}
