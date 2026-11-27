// Decides, for an online URL path, which local file (if any) should be served instead.
import fs from 'node:fs';
import path from 'node:path';
import { urlKey, isSourceFile } from './portal-model.mjs';

/** Converts a URL glob (`*` = within a segment, `**` = any depth) to a case-insensitive RegExp. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:(.*)/)?';
          i += 2;
        } else {
          re += '(.*)';
          i++;
        }
      } else {
        re += '([^/]*)';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveRouteFile(model, rule, decoded, prefixEnd) {
  if (rule.file) return path.resolve(model.sourceDir, rule.file);
  if (!rule.dir) return null;
  // Preserve literal suffixes (e.g. *.js) and nested segments after the fixed URL prefix.
  const rest = decoded.slice(prefixEnd + 1);
  const root = path.resolve(model.sourceDir, rule.dir);
  let file = path.resolve(root, rest);
  // Resolve junctions/symlinks as well as lexical traversal; a request cannot leave its route.
  try {
    if (!isInside(root, file) || !isInside(fs.realpathSync.native(root), fs.realpathSync.native(file))) file = null;
  } catch {
    file = null;
  }
  return file;
}

const knownWebFileKey = (model, key) =>
  model.webFileByUrl.has(key) || model.duplicateWebFileUrls?.has(key) || model.inactiveWebFileUrls?.has(key);

/**
 * The web file key of a request path: the path itself, or the path without its first segment when the export's
 * website languages contain that segment as a code and the path itself is no web file. mirage/lib/redirects.mjs
 * languageRoute answers /en-US/theme.css as /theme.css the same way; a segment that is no exported language code
 * (an arbitrary two-letter page slug) stays a segment.
 */
function webFileKey(model, urlPath) {
  const key = urlKey(urlPath);
  if (knownWebFileKey(model, key)) return { key, path: urlPath };
  const match = /^\/([^/]+)(\/.*)$/.exec(urlPath);
  if (!match) return { key, path: urlPath };
  let segment;
  try {
    segment = decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return { key, path: urlPath };
  }
  if (!model.languageCodes?.has(segment)) return { key, path: urlPath };
  return { key: urlKey(match[2]), path: match[2] };
}

function decodedPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Why the automatic web-file mapping serves `urlPath` from disk or not: `{file, via}` when it serves it; `{file,
 * reason}` when the URL is a web file of the export that is not served; null when it is no web file of the export.
 */
function explainWebFile(model, site, excludes, inScope, urlPath, decoded, { document = false } = {}) {
  const { key, path: lookupPath } = webFileKey(model, urlPath);
  const lookupDecoded = lookupPath === urlPath ? decoded : decodedPath(lookupPath);
  // urlKey decodes once itself. Passing decoded here would conflate %252E and %2E.
  const webFile = model.webFileByUrl.get(key);
  if (!webFile) {
    if (model.duplicateWebFileUrls?.has(key)) {
      const first = model.webFiles.find((entry) => entry.file && entry.url && urlKey(entry.url) === key);
      return { file: first?.file ?? null, reason: 'duplicate-url' };
    }
    const inactive = model.inactiveWebFileUrls?.get(key);
    return inactive ? { file: inactive.file ?? null, reason: 'inactive' } : null;
  }
  if (!webFile.file) return { file: null, record: webFile.yml ?? null, reason: 'no-content-file' };
  // A page and a web file at one URL: a path ending with "/" is the page's (mirage/server.mjs pageFirst, the legacy
  // slash rule; no platform capture proves it), and a web file body never answers a document navigation to a page.
  if (model.pagePaths?.has(key) && (document || urlPath.endsWith('/')))
    return { file: webFile.file, reason: 'page-first' };
  if (site.webFiles?.enabled === false) return { file: webFile.file, reason: 'excluded' };
  if (excludes.some((re) => re.test(decoded) || re.test(lookupDecoded)))
    return { file: webFile.file, reason: 'excluded' };
  if (!inScope(webFile.file)) return { file: webFile.file, reason: 'out-of-scope' };
  if (!isSourceFile(model.sourceDir, webFile.file)) return { file: webFile.file, reason: 'outside-export' };
  return { file: webFile.file, via: 'web-file', webFile };
}

export class Resolver {
  /**
   * @param {import('./portal-model.mjs').PortalModel} model
   * @param {import('./config.mjs').SiteConfig} site
   * @param {{changed?: Set<string>|null}} [opts] `changed` restricts overriding to those files (scope 'changed')
   */
  constructor(model, site, opts = {}) {
    this.model = model;
    this.site = site;
    this.changed = opts.changed ? new Set([...opts.changed].map((file) => path.resolve(file))) : null;
    this.routes = (site.routes ?? []).map((rule) => {
      const wildcard = rule.url.search(/[?*]/);
      const prefixEnd = rule.url.lastIndexOf('/', wildcard < 0 ? rule.url.length : wildcard);
      return { rule, re: globToRegExp(rule.url), prefixEnd };
    });
    this.excludes = (site.webFiles?.exclude ?? []).map(globToRegExp);
  }

  inScope(file) {
    return !this.changed || this.changed.has(path.resolve(file));
  }

  /**
   * @param {string} urlPath pathname of the request (no query string)
   * @param {{document?: boolean}} [opts] `document`: a document navigation, which a page URL answers as the page
   * @returns {{file: string, via: string} | null}
   */
  resolve(urlPath, opts = {}) {
    const found = this.explain(urlPath, opts);
    return found?.via ? { file: found.file, via: found.via } : null;
  }

  /**
   * resolve() with the reason when a file of the export answers the URL but is not served. `{file, via}` is served;
   * `{file, reason}` is not: `passthrough-route`, `excluded`, `out-of-scope`, `duplicate-url`, `inactive`,
   * `no-content-file`, `page-first` or `outside-export`; null is no file of the export. `routesOnly` stops after the
   * catalogue routes.
   * @param {string} urlPath
   * @param {{document?: boolean, routesOnly?: boolean}} [opts]
   * @returns {{file: string|null, via?: string, reason?: string, route?: string, record?: string|null, webFile?: object} | null}
   */
  explain(urlPath, { document = false, routesOnly = false } = {}) {
    const decoded = decodedPath(urlPath);

    if (/[\0\r\n]/.test(decoded)) return null;
    for (const { rule, re, prefixEnd } of this.routes) {
      const m = re.exec(decoded);
      if (!m) continue;
      if (rule.passthrough) {
        if (routesOnly) return null;
        const webFile = this.#webFile(urlPath, decoded, document);
        return webFile?.file ? { file: webFile.file, reason: 'passthrough-route', route: rule.url } : null;
      }
      const hit = this.#routeHit(rule, decoded, prefixEnd);
      if (hit) return hit;
      // rule matched but nothing on disk: fall through to the automatic mapping
    }
    if (routesOnly) return null;
    return this.#webFile(urlPath, decoded, document);
  }

  #routeHit(rule, decoded, prefixEnd) {
    const file = resolveRouteFile(this.model, rule, decoded, prefixEnd);
    if (!file || !isFile(file)) return null;
    return this.inScope(file)
      ? { file, via: `route ${rule.url}`, route: rule.url }
      : { file, reason: 'out-of-scope', route: rule.url };
  }

  #webFile(urlPath, decoded, document) {
    return explainWebFile(this.model, this.site, this.excludes, (file) => this.inScope(file), urlPath, decoded, {
      document,
    });
  }
}
