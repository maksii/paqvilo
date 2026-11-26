import fs from 'node:fs/promises';
import { adapterEnabled } from './local-overrides.mjs';
import { hasPlatformBundles } from './platform-manifest.mjs';
import { documentAnchors, insertAt, scriptMarker } from './document-injection.mjs';

function strings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, output);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (['source', 'value', 'content', 'html', 'javascript', 'script'].includes(key.toLowerCase()))
        strings(item, output);
      else if (typeof item === 'string') output.push(item);
      else if (item && typeof item === 'object') strings(item, output);
    }
  return output;
}

/** jQuery core builds (jquery.js, jquery.min.js, jquery-3.6.0.min.js, jquery.slim.js),
 * not jQuery plugins such as jquery-ui or jquery.validate. */
export const JQUERY_CORE_SCRIPT = Object.freeze({ test: (value) => coreScript(value, 'jquery', ['min', 'slim']) });
/** Bootstrap core and bundle builds, including platform files with hashed names
 * (/resource/powerappsportal/dist/bootstrap.bundle-<hash>.js), but not Bootstrap
 * plugins such as bootstrap-datetimepicker. */
export const BOOTSTRAP_CORE_SCRIPT = Object.freeze({
  test: (value) => coreScript(value, 'bootstrap', ['bundle', 'min']),
});

// Scan the basename once. Version components may contain dots, so a repeated
// regular expression with a dot-containing version alternative backtracks exponentially.
function coreScript(value, library, words) {
  const pathname = String(value).split(/[?#]/, 1)[0];
  const name = pathname.slice(pathname.lastIndexOf('/') + 1).toLowerCase();
  if (!name.startsWith(library) || !name.endsWith('.js')) return false;
  const suffix = name.slice(library.length, -3);
  return validCoreScriptSuffix(suffix, library, words);
}

/* NOSONAR */ function validCoreScriptSuffix(suffix, library, words) {
  let index = 0;
  while (index < suffix.length) {
    const separator = suffix[index++];
    if (separator !== '.' && separator !== '-') return false;
    const start = index;
    while (index < suffix.length && /[\w.]/.test(suffix[index])) index++;
    const chunk = suffix.slice(start, index);
    if (!chunk) return false;
    // A numeric version can consume the remaining dot-separated suffix. Named
    // modifiers and hashed Bootstrap builds are checked component by component.
    if (/^\d/.test(chunk) || (library === 'bootstrap' && /^v\d/.test(chunk))) continue;
    const parts = chunk.split('.');
    if (!validCoreScriptParts(parts, library, words)) return false;
    if (separator === '-' && words.includes(parts[0]) && library === 'bootstrap') return false;
  }
  return true;
}

function validCoreScriptParts(parts, library, words) {
  let version = false;
  return parts.every((part) => {
    if (version) return /^\w*$/.test(part);
    if (/^\d/.test(part) || (library === 'bootstrap' && /^v\d/.test(part))) {
      version = true;
      return true;
    }
    return words.includes(part) || (library === 'bootstrap' && /^[a-f0-9]{6,}$/.test(part));
  });
}
const scriptSources = (html) =>
  [...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);

/** Find browser globals used by exported code so clean local runs can supply
 * small, named compatibility assets only when the source needs them. */
export async function discoverSourceDependencies(portal) {
  const files = (portal.webFiles ?? []).filter(
    (file) => /\.m?js(?:$|\?)/i.test(file.url ?? '') || /javascript/i.test(file.mimeType ?? ''),
  );
  const authored = [];
  for (const file of files) {
    if (
      /(?:^|\/)jquery(?:[-.]|$)/i.test(file.url ?? '') ||
      /(?:^|\/)moment(?:[-.]|$)/i.test(file.url ?? '') ||
      /datetimepicker/i.test(file.url ?? '')
    )
      continue;
    try {
      const body = await fs.readFile(file.file, 'utf8');
      authored.push(body);
    } catch {
      // The normal resource index reports missing files. A missing optional
      // source file must not prevent the rest of the portal from starting.
    }
  }
  authored.push(
    ...strings(portal.templates),
    ...strings(portal.snippets),
    ...strings(portal.snippetTranslations),
    ...(portal.pages ?? []).flatMap((page) => [
      page.html,
      page.js,
      ...Object.values(page.translations ?? {}).flatMap((variant) => [variant.html, variant.js]),
    ]),
    ...(portal.forms ?? []).map((form) => form.js),
    ...(portal.lists ?? []).map((list) => list.js),
    ...strings(
      (portal.records ?? [])
        .filter((record) => record.kind === 'advancedformstep')
        .map((record) => record.customJavascript),
    ),
  );
  const source = authored.join('\n');
  const urls = (portal.webFiles ?? []).map((file) => file.url ?? '');
  const routableUrls = (portal.webFiles ?? [])
    .filter(
      (file) =>
        !file.metadata ||
        Object.keys(file.metadata).some((key) => /^(adx_|mspp_)?parentpageid$/i.test(key) && file.metadata[key]),
    )
    .map((file) => file.url ?? '');
  const has = (pattern) => urls.some((url) => pattern.test(url));
  return {
    jquery: /\bjQuery\b|\$\s*\(|\$\s*\.|\bwindow\s*\.\s*jQuery\b/.test(source),
    moment: /\b(?:window\s*\.\s*)?moment\s*[(.,]/.test(source),
    dateTimePicker: /\.\s*datetimepicker\s*\(/i.test(source),
    bootstrapPlugins:
      /\.\s*(?:tooltip|popover|modal|dropdown|tab|collapse)\s*\(/i.test(source) ||
      /data-toggle=["'](?:modal|dropdown|tab|collapse)["']/i.test(source),
    jqueryUiDialog: /\.\s*dialog\s*\(/i.test(source),
    // The platform's Date extensions: Date.prototype.format and the Datejs Date.parse.
    dateFormat:
      /* NOSONAR */ /\bnew\s+Date\s*\([^)]*\)\s*\.\s*format\s*\(|\bDate\.prototype\.format\b|\bDate\s*\.\s*(?:parse|today)\s*\(/i.test(
        source,
      ),
    footerSpacing: /<footer\b|\brole\s*=\s*["']contentinfo["']/i.test(source),
    sourceBootstrap: has(BOOTSTRAP_CORE_SCRIPT),
    bootstrapSourcePath: urls.find((url) => BOOTSTRAP_CORE_SCRIPT.test(url)),
    // A jQuery core build only: jquery-ui.css or jquery.validate.js cannot stand in for the
    // platform's jQuery. A web file without a parent page is not routable, so the local
    // equivalent of the platform library is used instead (platform manifest).
    sourceJquery: has(JQUERY_CORE_SCRIPT),
    sourceMoment: has(/(?:^|\/)moment(?:[-.][\w.-]*)?\.js(?:[?#]|$)/i),
    sourceDateTimePicker: has(/datetimepicker/i),
    jquerySourcePath: routableUrls.find((url) => JQUERY_CORE_SCRIPT.test(url)),
    momentSourcePath: routableUrls.find((url) => /(?:^|\/)moment(?:[-.][\w.-]*)?\.js(?:[?#]|$)/i.test(url)),
    dateTimePickerSourcePath: urls.find((url) => /datetimepicker/i.test(url)),
  };
}

export function runtimeDependencyPaths(dependencies, configuredScripts = []) {
  const paths = [];
  const candidates = [
    [dependencies.dateFormat, /date[-_.]?format/i, '/__sim-static/vendor/date-format-compat.js'],
    [dependencies.moment, /moment(?:[-.]|$)/i, dependencies.momentSourcePath ?? '/__sim-static/vendor/moment.min.js'],
    [dependencies.jquery, JQUERY_CORE_SCRIPT, dependencies.jquerySourcePath ?? '/__sim-static/vendor/jquery.min.js'],
  ];
  for (const [required, pattern, localPath] of candidates) {
    if (
      required &&
      !configuredScripts.some((entry) => pattern.test(typeof entry === 'string' ? entry : (entry?.src ?? '')))
    )
      paths.push(localPath);
  }
  return paths.filter((src) => adapterEnabled(src.slice(src.lastIndexOf('/') + 1), dependencies.compat));
}

/** HTML documents are the only responses that receive local runtime assets. Template
 * output without a document shell (JSON, HTML fragments for jQuery .load) is served
 * verbatim by the portal and must stay byte-identical. */
export const isHtmlDocument = (html) => /<(?:!doctype|html|head|body)\b/i.test(String(html ?? ''));

/**
 * Put source-detected fallback libraries before authored page/form scripts: after the head start tag, else before the
 * first script, else before the body end tag, else after the body start tag (the document's real elements,
 * lib/document-injection.mjs). `injectedScripts` is the response's injected-script marker under a nonce policy.
 */
export function injectRuntimeDependencies(html, dependencies, configuredScripts = [], { injectedScripts = null } = {}) {
  if (!isHtmlDocument(html)) return html;
  // Documents with the platform bundles get jQuery, moment and Datejs from them.
  if (hasPlatformBundles(html)) return html;
  const existing = [...configuredScripts];
  for (const match of String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi))
    existing.push(match[2]);
  const paths = runtimeDependencyPaths(dependencies, existing);
  if (!paths.length) return html;
  const mark = scriptMarker(injectedScripts);
  const tags = paths.map((src) => `<script${mark} src="${src}"></script>`).join('');
  const anchors = documentAnchors(html, { scripts: true });
  const at = [anchors.headStart, anchors.firstScript, anchors.bodyEnd, anchors.bodyStart].find((offset) => offset >= 0);
  return at === undefined ? html : insertAt(html, at, tags);
}

export function runtimeCompatibilityPaths(dependencies, configuredScripts = []) {
  const paths = [];
  const hasConfigured = (pattern) =>
    configuredScripts.some((entry) => pattern.test(typeof entry === 'string' ? entry : (entry?.src ?? '')));
  if (dependencies.sourceDateTimePicker && !hasConfigured(/datetimepicker/i))
    paths.push(dependencies.dateTimePickerSourcePath);
  else if (dependencies.dateTimePicker && !hasConfigured(/datetimepicker/i))
    paths.push('/__sim-static/vendor/datetimepicker-compat.js');
  if (dependencies.sourceBootstrap && !hasConfigured(BOOTSTRAP_CORE_SCRIPT))
    paths.push(dependencies.bootstrapSourcePath);
  else if (dependencies.bootstrapPlugins && !hasConfigured(BOOTSTRAP_CORE_SCRIPT))
    paths.push('/__sim-static/vendor/bootstrap-plugins-compat.js');
  // A document that includes jQuery UI keeps its own dialog widget.
  if (dependencies.jqueryUiDialog && !hasConfigured(/(?:^|\/)jquery[.-]?ui(?:[.-][\w.]*)?\.js(?:[?#]|$)/i))
    paths.push('/__sim-static/vendor/jqueryui-dialog-compat.js');
  return paths.filter((src) => adapterEnabled(src.slice(src.lastIndexOf('/') + 1), dependencies.compat));
}

/** Add each compatibility adapter once, after the last jQuery core include.
 * Power Pages templates may include jQuery more than once and a later copy
 * replaces $.fn plugins; the adapters re-attach themselves to a replaced jQuery,
 * so they are never repeated. A document that already references Bootstrap
 * (any core, bundle or hashed platform build) keeps its own plugins. */
export function injectRuntimeCompatibility(html, dependencies, configuredScripts = [], options = {}) {
  const edits = runtimeCompatibilityEdits(html, dependencies, configuredScripts, options);
  if (!edits.length) return html;
  let output = '',
    cursor = 0;
  for (const edit of edits) {
    output += html.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + html.slice(cursor);
}

/**
 * The insertions injectRuntimeCompatibility makes, in document order and in the coordinates of `html`
 * ({ start, end: start, text }), so a caller that tracks render provenance can apply them precisely. The anchors are
 * the document's real elements (a jQuery include that is a script element, the body end tag), never the same text in
 * an attribute value. `injectedScripts` is the response's injected-script marker under a nonce policy.
 */
export function runtimeCompatibilityEdits(html, dependencies, configuredScripts = [], { injectedScripts = null } = {}) {
  if (!isHtmlDocument(html)) return [];
  // The platform bundles' local equivalents include these adapters (lib/platform-manifest.mjs).
  if (hasPlatformBundles(html)) return [];
  // Idempotent: the renderer and the HTTP layer may both prepare the same document.
  const sources = scriptSources(html);
  const present = new Set(sources);
  const paths = runtimeCompatibilityPaths(dependencies, [...configuredScripts, ...sources]).filter(
    (src) => src && !present.has(src),
  );
  const edits = [];
  const mark = scriptMarker(injectedScripts);
  let anchors = null;
  const documentAnchorsOnce = () => (anchors ??= documentAnchors(html, { scripts: true }));
  if (paths.length) {
    const includes = [
      ...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>\s*<\/script>/gi),
    ].filter((match) => JQUERY_CORE_SCRIPT.test(match[2]));
    const last = includes.findLast((match) => documentAnchorsOnce().scriptStarts.has(match.index));
    if (last) {
      const at = last.index + last[0].length;
      edits.push({ start: at, end: at, text: paths.map((src) => `<script${mark} src="${src}"></script>`).join('') });
    }
  }
  // Inline page templates can contain a semantic footer even when source
  // dependency scanning only sees external files and shared metadata.
  if (
    dependencies.compat?.footerSpacing !== false &&
    (dependencies.footerSpacing || /<footer\b|\brole\s*=\s*["']contentinfo["']/i.test(html)) &&
    !present.has('/__sim-static/vendor/footer-spacing-compat.js')
  ) {
    // The inserted adapters contain no closing body tag: the body end tag of the document is the same.
    const closingBody = documentAnchorsOnce().bodyEnd;
    if (closingBody >= 0)
      edits.push({
        start: closingBody,
        end: closingBody,
        text: `<script${mark} src="/__sim-static/vendor/footer-spacing-compat.js"></script>`,
      });
  }
  return edits.sort((a, b) => a.start - b.start);
}
