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
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
   * @returns {{file: string, via: string} | null}
   */
  resolve(urlPath) {
    let decoded = urlPath;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      /* keep raw */
    }

    if (/[\0\r\n]/.test(decoded)) return null;
    for (const { rule, re, prefixEnd } of this.routes) {
      const m = re.exec(decoded);
      if (!m) continue;
      if (rule.passthrough) return null;
      let file = null;
      if (rule.file) file = path.resolve(this.model.sourceDir, rule.file);
      else if (rule.dir) {
        // Preserve literal suffixes (e.g. *.js) and nested segments after the fixed URL prefix.
        const rest = decoded.slice(prefixEnd + 1);
        const root = path.resolve(this.model.sourceDir, rule.dir);
        file = path.resolve(root, rest);
        // Resolve junctions/symlinks as well as lexical traversal; a request cannot leave its route.
        try {
          if (!isInside(root, file) || !isInside(fs.realpathSync.native(root), fs.realpathSync.native(file))) file = null;
        } catch { file = null; }
      }
      if (file && isFile(file)) return this.inScope(file) ? { file, via: `route ${rule.url}` } : null;
      // rule matched but nothing on disk: fall through to the automatic mapping
    }

    if (this.site.webFiles?.enabled === false) return null;
    if (this.excludes.some((re) => re.test(decoded))) return null;
    // urlKey decodes once itself. Passing decoded here would conflate %252E and %2E.
    const webFile = this.model.webFileByUrl.get(urlKey(urlPath));
    if (!webFile || !webFile.file) return null;
    if (!this.inScope(webFile.file)) return null;
    if (!isSourceFile(this.model.sourceDir, webFile.file)) return null;
    return { file: webFile.file, via: 'web-file' };
  }
}
