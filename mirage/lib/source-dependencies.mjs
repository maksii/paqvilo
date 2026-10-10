import fs from "node:fs/promises";
import { hasPlatformBundles } from "./platform-manifest.mjs";

function strings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value))
    for (const item of value) strings(item, output);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (["source", "value", "content", "html", "javascript", "script"].includes(key.toLowerCase()))
        strings(item, output);
      else if (typeof item === "string") output.push(item);
      else if (item && typeof item === "object") strings(item, output);
    }
  return output;
}

/** jQuery core builds (jquery.js, jquery.min.js, jquery-3.6.0.min.js, jquery.slim.js),
 * not jQuery plugins such as jquery-ui or jquery.validate. */
export const JQUERY_CORE_SCRIPT = /(?:^|\/)jquery(?:[.-](?:\d[\w.]*|min|slim))*\.js(?:[?#]|$)/i;
/** Bootstrap core and bundle builds, including platform files with hashed names
 * (/resource/powerappsportal/dist/bootstrap.bundle-<hash>.js), but not Bootstrap
 * plugins such as bootstrap-datetimepicker. */
export const BOOTSTRAP_CORE_SCRIPT = /(?:^|\/)bootstrap(?:\.bundle|\.min|[.-](?:v?\d[\w.]*|[a-f0-9]{6,}))*\.js(?:[?#]|$)/i;
const scriptSources = (html) => [...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);

/** Find browser globals used by exported code so clean local runs can supply
 * small, named compatibility assets only when the source needs them. */
export async function discoverSourceDependencies(portal) {
  const files = (portal.webFiles ?? []).filter((file) =>
    /\.m?js(?:$|\?)/i.test(file.url ?? "") ||
    /javascript/i.test(file.mimeType ?? ""),
  );
  const authored = [];
  for (const file of files) {
    if (/(?:^|\/)jquery(?:[-.]|$)/i.test(file.url ?? "") ||
        /(?:^|\/)moment(?:[-.]|$)/i.test(file.url ?? "") ||
        /datetimepicker/i.test(file.url ?? ""))
      continue;
    try {
      const body = await fs.readFile(file.file, "utf8");
      authored.push(body);
    } catch {
      // The normal resource index reports missing files. A missing optional
      // source file must not prevent the rest of the portal from starting.
    }
  }
  authored.push(
    ...strings(portal.templates),
    ...strings(portal.snippets),
    ...(portal.pages ?? []).flatMap((page) => [page.html, page.js]),
    ...(portal.forms ?? []).map((form) => form.js),
    ...(portal.lists ?? []).map((list) => list.js),
    ...strings((portal.records ?? [])
      .filter((record) => record.kind === "advancedformstep")
      .map((record) => record.customJavascript)),
  );
  const source = authored.join("\n");
  const urls = (portal.webFiles ?? []).map((file) => file.url ?? "");
  const routableUrls = (portal.webFiles ?? [])
    .filter((file) => !file.metadata || Object.keys(file.metadata).some((key) => /^(adx_|mspp_)?parentpageid$/i.test(key) && file.metadata[key]))
    .map((file) => file.url ?? "");
  const has = (pattern) => urls.some((url) => pattern.test(url));
  return {
    jquery: /\bjQuery\b|\$\s*\(|\$\s*\.|\bwindow\s*\.\s*jQuery\b/.test(source),
    moment: /\b(?:window\s*\.\s*)?moment\s*(?:\(|\.|,)/.test(source),
    dateTimePicker: /\.\s*datetimepicker\s*\(/i.test(source),
    bootstrapPlugins: /\.\s*(?:tooltip|popover|modal|dropdown|tab|collapse)\s*\(/i.test(source) || /data-toggle=["'](?:modal|dropdown|tab|collapse)["']/i.test(source),
    jqueryUiDialog: /\.\s*dialog\s*\(/i.test(source),
    // The platform's Date extensions: Date.prototype.format and the Datejs Date.parse.
    dateFormat: /\bnew\s+Date\s*\([^)]*\)\s*\.\s*format\s*\(|\bDate\.prototype\.format\b|\bDate\s*\.\s*(?:parse|today)\s*\(/i.test(source),
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
    [dependencies.dateFormat, /date[-_.]?format/i, "/__sim-static/vendor/date-format-compat.js"],
    [dependencies.moment, /moment(?:[-.]|$)/i, dependencies.momentSourcePath ?? "/__sim-static/vendor/moment.min.js"],
    [dependencies.jquery, JQUERY_CORE_SCRIPT, dependencies.jquerySourcePath ?? "/__sim-static/vendor/jquery.min.js"],
  ];
  for (const [required, pattern, localPath] of candidates) {
    if (
      required &&
      !configuredScripts.some((entry) =>
        pattern.test(typeof entry === "string" ? entry : (entry?.src ?? "")),
      )
    )
      paths.push(localPath);
  }
  return paths;
}

/** HTML documents are the only responses that receive local runtime assets. Template
 * output without a document shell (JSON, HTML fragments for jQuery .load) is served
 * verbatim by the portal and must stay byte-identical. */
export const isHtmlDocument = (html) => /<(?:!doctype|html|head|body)\b/i.test(String(html ?? ""));

/** Put source-detected fallback libraries before authored page/form scripts. */
export function injectRuntimeDependencies(html, dependencies, configuredScripts = []) {
  if (!isHtmlDocument(html)) return html;
  // Documents with the platform bundles get jQuery, moment and Datejs from them.
  if (hasPlatformBundles(html)) return html;
  const existing = [...configuredScripts];
  for (const match of String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi))
    existing.push(match[2]);
  const paths = runtimeDependencyPaths(dependencies, existing);
  if (!paths.length) return html;
  const tags = paths.map((src) => `<script src="${src}"></script>`).join("");
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${tags}${html.slice(at)}`;
  }
  const firstScript = /<script\b/i.exec(html);
  if (firstScript) return `${html.slice(0, firstScript.index)}${tags}${html.slice(firstScript.index)}`;
  const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
  if (bodyEnd >= 0) return `${html.slice(0, bodyEnd)}${tags}${html.slice(bodyEnd)}`;
  const bodyStart = /<body\b[^>]*>/i.exec(html);
  if (bodyStart) {
    const at = bodyStart.index + bodyStart[0].length;
    return `${html.slice(0, at)}${tags}${html.slice(at)}`;
  }
  return html;
}

export function runtimeCompatibilityPaths(dependencies, configuredScripts = []) {
  const paths = [];
  const hasConfigured = (pattern) => configuredScripts.some((entry) => pattern.test(typeof entry === "string" ? entry : (entry?.src ?? "")));
  if (dependencies.sourceDateTimePicker && !hasConfigured(/datetimepicker/i)) paths.push(dependencies.dateTimePickerSourcePath);
  else if (dependencies.dateTimePicker && !hasConfigured(/datetimepicker/i)) paths.push("/__sim-static/vendor/datetimepicker-compat.js");
  if (dependencies.sourceBootstrap && !hasConfigured(BOOTSTRAP_CORE_SCRIPT)) paths.push(dependencies.bootstrapSourcePath);
  else if (dependencies.bootstrapPlugins && !hasConfigured(BOOTSTRAP_CORE_SCRIPT)) paths.push("/__sim-static/vendor/bootstrap-plugins-compat.js");
  // A document that includes jQuery UI keeps its own dialog widget.
  if (dependencies.jqueryUiDialog && !hasConfigured(/(?:^|\/)jquery[.-]?ui(?:[.-][\w.]*)?\.js(?:[?#]|$)/i)) paths.push("/__sim-static/vendor/jqueryui-dialog-compat.js");
  return paths;
}

/** Add each compatibility adapter once, after the last jQuery core include.
 * Power Pages templates may include jQuery more than once and a later copy
 * replaces $.fn plugins; the adapters re-attach themselves to a replaced jQuery,
 * so they are never repeated. A document that already references Bootstrap
 * (any core, bundle or hashed platform build) keeps its own plugins. */
export function injectRuntimeCompatibility(html, dependencies, configuredScripts = []) {
  if (!isHtmlDocument(html)) return html;
  // The platform bundles' local equivalents include these adapters (lib/platform-manifest.mjs).
  if (hasPlatformBundles(html)) return html;
  // Idempotent: the renderer and the HTTP layer may both prepare the same document.
  const sources = scriptSources(html);
  const present = new Set(sources);
  const paths = runtimeCompatibilityPaths(dependencies, [...configuredScripts, ...sources]).filter((src) => src && !present.has(src));
  let output = html;
  if (paths.length) {
    const includes = [...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>\s*<\/script>/gi)].filter((match) => JQUERY_CORE_SCRIPT.test(match[2]));
    const last = includes.at(-1);
    if (last) {
      const at = last.index + last[0].length;
      output = `${html.slice(0, at)}${paths.map((src) => `<script src="${src}"></script>`).join("")}${html.slice(at)}`;
    }
  }
  // Inline page templates can contain a semantic footer even when source
  // dependency scanning only sees external files and shared metadata.
  if (
    (dependencies.footerSpacing || /<footer\b|\brole\s*=\s*["']contentinfo["']/i.test(output)) &&
    !present.has("/__sim-static/vendor/footer-spacing-compat.js")
  ) {
    const closingBody = output.toLowerCase().lastIndexOf("</body>");
    if (closingBody >= 0)
      output = `${output.slice(0, closingBody)}<script src="/__sim-static/vendor/footer-spacing-compat.js"></script>${output.slice(closingBody)}`;
  }
  return output;
}
