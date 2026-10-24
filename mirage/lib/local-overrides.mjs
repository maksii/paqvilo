import fs from 'node:fs';
import path from 'node:path';

const COMPAT_ADAPTERS = Object.freeze({
  footerSpacing: 'footer-spacing-compat.js',
  dateFormat: 'date-format-compat.js',
  dateTimePicker: 'datetimepicker-compat.js',
  bootstrapPlugins: 'bootstrap-plugins-compat.js',
  jqueryUiDialog: 'jqueryui-dialog-compat.js',
  jqueryUiWidgets: 'jqueryui-widgets-compat.js',
  blockUi: 'jquery-blockui-compat.js',
  entityGrid: 'entity-grid-compat.js',
  platformApp: 'platform-app-compat.js',
  webForms: 'webforms-compat.js',
});

export function validateLocalOverrides({ compat = {}, head = {} } = {}) {
  for (const [label, value] of [
    ['compat', compat],
    ['head', head],
  ])
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`mirage.${label} must be an object`);
  for (const [name, value] of Object.entries(compat))
    if (!Object.hasOwn(COMPAT_ADAPTERS, name) || typeof value !== 'boolean')
      throw new Error(`Unknown adapter or non-boolean mirage.compat.${name}`);
  for (const [name, entries] of Object.entries(head)) {
    if (
      !['stylesheets', 'scripts'].includes(name) ||
      !Array.isArray(entries) ||
      entries.some((entry) => typeof entry !== 'string' || !entry.trim())
    )
      throw new Error(`mirage.head.${name} must be an array of project file paths`);
  }
  return { compat: { ...compat }, head };
}

/** Explicit project files only; symlinks cannot escape the catalogue directory. */
export function resolveLocalOverrides(options = {}, projectRoot = process.cwd()) {
  const { compat, head } = validateLocalOverrides(options);
  const assets = [],
    root = fs.realpathSync(projectRoot);
  for (const [kind, paths] of Object.entries(head))
    for (const name of paths) {
      let file;
      try {
        file = fs.realpathSync(path.resolve(root, name));
      } catch (error) {
        throw new Error(`Local head asset ${name} cannot be read (${error.code ?? 'error'})`, { cause: error });
      }
      const relative = path.relative(root, file);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !fs.statSync(file).isFile()
      )
        throw new Error('Local head assets must stay inside the project');
      const extension = kind === 'scripts' ? '.js' : '.css';
      if (path.extname(file).toLowerCase() !== extension) throw new Error(`Local ${kind} must be ${extension} files`);
      assets.push({ kind, file, root, url: `/_sim-local/head/${assets.length}${extension}` });
    }
  return { compat, assets };
}

export function adapterEnabled(file, compat = {}) {
  return !Object.entries(COMPAT_ADAPTERS).some(
    ([name, source]) => compat[name] === false && source === file.split('#')[0],
  );
}

export function injectLocalHead(html, overrides) {
  if (!/<head\b/i.test(html) || !overrides.assets.length) return html;
  const tags = overrides.assets
    .filter((asset) => !html.includes(`"${asset.url}"`))
    .map((asset) =>
      asset.kind === 'scripts'
        ? `<script data-sim-local-only="head" src="${asset.url}"></script>`
        : `<link data-sim-local-only="head" rel="stylesheet" href="${asset.url}">`,
    )
    .join('');
  return html.replace(/<head\b[^>]*>/i, (tag) => tag + tags);
}
