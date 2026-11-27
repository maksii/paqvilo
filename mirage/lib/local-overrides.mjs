import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { documentAnchors, insertAt, scriptMarker } from './document-injection.mjs';

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
      throw new Error(`mirage.${label} must be an object`); // NOSONAR: stringification is intentional here
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

/**
 * The project's local head assets (mirage.head) after the document's head tag. With a render `provenance` (the proof
 * of a finalized document, lib/render-provenance.mjs), every inserted element is bound to the project file it loads:
 * component kind `local-head`, key `local-head:<project-relative path>`, that file as its source ref. The binding stamp
 * (data-paqvilo-source) is the only difference from the unproved document. The assets go after the document's real
 * head start tag (lib/document-injection.mjs); a document without one gets none. `injectedScripts` is the response's
 * injected-script marker under a nonce policy.
 */
export function injectLocalHead(html, overrides, provenance = null, { injectedScripts = null } = {}) {
  if (!/<head\b/i.test(html) || !overrides.assets.length) return html;
  const missing = overrides.assets.filter((asset) => !html.includes(`"${asset.url}"`));
  if (!missing.length) return html;
  const head = documentAnchors(html).headStart;
  if (head < 0) return html;
  const mark = scriptMarker(injectedScripts);
  const stamp = (asset, index) => {
    if (!provenance?.proofId) return '';
    const id = `${provenance.proofId}:local-head:${index}`;
    const binding = localHeadBinding(asset, id, provenance.sourceRevision);
    if (!binding) return '';
    provenance.bindings.push(binding.binding);
    if (!provenance.sourceRefs.some((ref) => ref.id === binding.ref.id)) provenance.sourceRefs.push(binding.ref);
    return ` data-paqvilo-source="${id}"`;
  };
  const tags = missing
    .map((asset, index) =>
      asset.kind === 'scripts'
        ? `<script${mark} data-sim-local-only="head" src="${asset.url}"${stamp(asset, index)}></script>`
        : `<link data-sim-local-only="head" rel="stylesheet" href="${asset.url}"${stamp(asset, index)}>`,
    )
    .join('');
  return insertAt(html, head, tags);
}

/** The platform binding of one local head element and the source ref of the project file it loads. */
function localHeadBinding(asset, id, sourceRevision) {
  let bytes;
  try {
    bytes = fs.readFileSync(asset.file);
  } catch {
    return null;
  }
  const relative = path.relative(asset.root, asset.file).replaceAll('\\', '/');
  const key = `local-head:${relative}`;
  const text = bytes.toString('utf8');
  const ref = {
    id: 'local-head:' + createHash('sha256').update(key).digest('hex').slice(0, 32),
    key,
    sourceKey: key,
    kind: 'local-head',
    componentKey: key,
    relationship: 'implementation',
    // The project file, relative to the project root (not the portal source directory).
    ref: relative,
    sourceRoot: 'project',
    name: path.basename(asset.file),
    sourceRevision,
    contentRevision: createHash('sha256').update(bytes).digest('hex'),
    region: { start: 0, end: text.length, line: 1, column: 1 },
  };
  return {
    ref,
    binding: {
      id,
      tag: asset.kind === 'scripts' ? 'script' : 'link',
      attributes: [],
      mapping: 'platform',
      component: { kind: 'local-head', key, name: relative },
      sourceRefIds: [ref.id],
    },
  };
}
