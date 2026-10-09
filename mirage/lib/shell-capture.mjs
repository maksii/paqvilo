import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateLivePath } from "./live.mjs";
import { isResourceManagerPath, isAspNetResourcePath } from "./asset-cache.mjs";
import { parse } from "parse5";
import { footerLogoClasses } from "./extensions.mjs";
import {
  observedFooterLogos,
  observedFooterLayout,
} from "./footer-capture.mjs";
import { observedHeaderNotifications } from "./header-notification-capture.mjs";
import { observedPageCopyLayout } from "./observed-pagecopy-layout.mjs";

const cdn = "https://content.powerapps.com";
const fail = (message, status = 400, code = "SHELL_CAPTURE") =>
  Object.assign(new Error(message), { status, code });
const decode = (value) =>
  String(value).replace(
    /&(?:amp|quot|apos|lt|gt);|&#(?:x[\da-f]+|\d+);/gi,
    (item) => {
      const named = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      };
      if (named[item.toLowerCase()]) return named[item.toLowerCase()];
      try {
        return String.fromCodePoint(
          Number.parseInt(
            item.slice(item[2].toLowerCase() === "x" ? 3 : 2, -1),
            item[2].toLowerCase() === "x" ? 16 : 10,
          ),
        );
      } catch {
        return item;
      }
    },
  );
const safePath = (value) =>
  typeof value === "string" && value.startsWith("/")
    ? value.split("?")[0].slice(0, 300)
    : "<excluded shell resource>";

// Parse inertly with browser HTML rules, including malformed unquoted attributes.
// Template contents, comments, and raw script/style text are never resource nodes.
export function extractShellReferences(html) {
  const document = parse(html, {
      sourceCodeLocationInfo: true,
      scriptingEnabled: true,
    }),
    result = [];
  function visit(node, inHead = false) {
    if (node.tagName === "head") inHead = true;
    else if (node.tagName === "body") inHead = false;
    const attrs = Object.fromEntries(
      (node.attrs ?? []).map((a) => [a.name, a.value]),
    );
    let ref;
    if (node.tagName === "base" && attrs.href)
      ref = { kind: "base", value: attrs.href };
    else if (
      node.tagName === "link" &&
      attrs.rel?.toLowerCase().split(/\s+/).includes("stylesheet")
    )
      ref = { kind: "style", value: attrs.href, media: attrs.media };
    else if (node.tagName === "script" && attrs.src)
      ref = {
        kind: "script",
        value: attrs.src,
        position: inHead ? "headScripts" : "bodyScripts",
        defer: Object.hasOwn(attrs, "defer"),
        async: Object.hasOwn(attrs, "async"),
        type: attrs.type,
      };
    if (ref)
      result.push({
        ...ref,
        offset: node.sourceCodeLocation?.startOffset ?? Infinity,
      });
    for (const child of node.childNodes ?? []) visit(child, inHead);
  }
  visit(document);
  return result
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, ...ref }) => ref);
}
const references = extractShellReferences;

function signInDocument(html, pagePath) {
  if (/(?:^|\/)(?:signin|login)(?:\/|$)/i.test(pagePath.split("?")[0]))
    return true;
  const head = html
    .split(/<body\b/i)[0]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const title = decode(
    /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] ?? "",
  ).trim();
  return /^(?:sign\s*in|log\s*in|login)\b/i.test(title);
}

function resolveResource(value, base, origin) {
  if (typeof value !== "string" || !value)
    throw fail("Observed shell resource has no URL.");
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw fail("Observed shell resource has an invalid URL.");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !["https:"].includes(url.protocol)
  )
    throw fail(
      "Shell resources must use HTTPS without credentials or fragments.",
      400,
      "SHELL_RESOURCE_ORIGIN",
    );
  if (
    url.origin !== origin &&
    (url.origin !== cdn ||
      !url.pathname.startsWith("/resource/powerappsportal/"))
  )
    throw fail(
      "Shell resource is outside the portal and allowed Microsoft platform CDN prefix.",
      400,
      "SHELL_RESOURCE_ORIGIN",
    );
  const path = url.pathname + url.search;
  validateLivePath(path);
  for (const key of url.searchParams.keys())
    if (
      /^(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|client[_-]?secret|__requestverificationtoken|code|sig|signature|api[_-]?key)$/i.test(
        key,
      )
    )
      throw fail(
        "Shell resources cannot include credential query parameters.",
        400,
        "SHELL_RESOURCE_CREDENTIAL",
      );
  return { path, sourceOrigin: url.origin, url: url.href };
}
const field = (record, key) =>
  record?.[key] ?? record?.["adx_" + key] ?? record?.["mspp_" + key];
function embeddedReferences(portal, pagePath, origin) {
  const emitted = new Set(),
    seen = new Set();
  const selected = (portal?.pages ?? []).find(
    (p) =>
      p.url?.replace(/\/$/, "").toLowerCase() ===
      pagePath.split("?")[0].replace(/\/$/, "").toLowerCase(),
  );
  const template = (portal?.pageTemplates ?? []).find(
    (t) => t.id === selected?.pageTemplateId,
  );
  const sources = [
    selected?.html,
    portal?.snippets?.["Head/Bottom"],
    portal?.templates?.[template?.webTemplateId]?.source,
    portal?.templates?.[field(portal?.website, "headerwebtemplateid")]?.source,
    portal?.templates?.[field(portal?.website, "footerwebtemplateid")]?.source,
  ];
  function visit(source) {
    if (typeof source !== "string" || seen.has(source)) return;
    seen.add(source);
    for (const ref of references(source)) {
      if (ref.kind === "base") continue;
      try {
        emitted.add(resolveResource(ref.value, origin + pagePath, origin).path);
      } catch {
        /* Dynamic Liquid URLs are resolved by the local renderer. */
      }
    }
    for (const match of source.matchAll(/{%[-\s]*include\s+["']([^"']+)["']/g))
      visit(
        portal?.templates?.[match[1]]?.source ?? portal?.snippets?.[match[1]],
      );
  }
  for (const source of sources) visit(source);
  return emitted;
}
const runtimeScript = (path) => {
  const pathname = new URL(path, "https://local.invalid").pathname;
  return (
    isAspNetResourcePath(path) ||
    isResourceManagerPath(pathname) ||
    /^\/resource\/powerappsportal\/dist\/preform\.moment_[\w.-]+\.js$/i.test(
      pathname,
    ) ||
    /^\/resource\/powerappsportal\/dist\/(?:postpreform\.bundle-|default-\d+\.moment_)[\w.-]+\.js$/i.test(
      pathname,
    ) ||
    /(?:^|\/)(?:jquery(?:[-.]|$)|bootstrap(?:[-.]|$))/i.test(pathname)
  );
};
const cssDependencies = (css) => [
  ...[...css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi)].map((m) =>
    (m[2] ?? m[3]).trim(),
  ),
  ...[...css.matchAll(/@import\s+(["'])(.*?)\1/gi)].map((m) => m[2]),
];

// PAC preserves attachment bytes. Some exported stylesheets use a UTF-16 BOM,
// which browsers decode correctly but a UTF-8-only dependency scan would miss.
const cssText = (bytes) => {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
};

/** Capture only opaque script resources declared by one read-only native HTML response. */
export async function capturePortalAspNetResources(cache, live, { path } = {}) {
  validateLivePath(path);
  if (!cache || !live?.context || !live.origin || cache.origin !== live.origin)
    throw fail(
      "ASP.NET capture requires the matching connected portal and cache.",
      409,
    );
  const response = await live.request(path, { method: "GET" });
  if (
    response.status !== 200 ||
    !/^text\/html(?:;|$)/i.test(response.headers?.["content-type"] ?? "")
  )
    throw fail("ASP.NET capture requires a successful native HTML page.", 502);
  const html = response.body.toString("utf8");
  if (signInDocument(html, path))
    throw fail(
      "Complete portal sign-in before capturing native script resources.",
      401,
    );
  const scripts = [];
  for (const ref of references(html).filter((ref) => ref.kind === "script")) {
    let candidate;
    try {
      candidate = new URL(ref.value, live.origin + path);
    } catch {
      continue;
    }
    if (!/\.axd$/i.test(candidate.pathname)) continue;
    const resource = resolveResource(
      ref.value,
      live.origin + path,
      live.origin,
    );
    if (
      resource.sourceOrigin !== live.origin ||
      !isAspNetResourcePath(resource.path)
    )
      throw fail(
        "Native ASP.NET script resource has an invalid origin or query.",
        400,
        "SHELL_ASPNET_RESOURCE",
      );
    if (
      ref.async ||
      ref.defer ||
      (ref.type &&
        !["text/javascript", "application/javascript"].includes(
          ref.type.toLowerCase(),
        ))
    )
      throw fail(
        "Native ASP.NET script execution attributes require explicit support.",
        400,
        "SHELL_ASPNET_ATTRIBUTES",
      );
    scripts.push(resource.path);
  }
  if (!scripts.length)
    throw fail(
      "No native ASP.NET script resources were observed.",
      422,
      "SHELL_ASPNET_MISSING",
    );
  const observedAspNetScripts = {
    pagePath: path.split("?")[0],
    htmlSha256: createHash("sha256").update(response.body).digest("hex"),
    observedAt: new Date().toISOString(),
    paths: scripts,
  };
  const report = await cache.capture(scripts, live, { observedAspNetScripts });
  return {
    ...report,
    bodyScripts: [...new Set(scripts)],
    observation: {
      pagePath: path.split("?")[0],
      htmlSha256: observedAspNetScripts.htmlSha256,
      observedAt: observedAspNetScripts.observedAt,
    },
    complete: report.failures.length === 0,
  };
}

/**
 * Read one observed live page (by default the site home page, "/") and persist only static shell
 * resources, never HTML or inline code.
 */
export async function capturePortalShell(
  cache,
  live,
  { path = "/", portal, onObservedHtml } = {},
) {
  validateLivePath(path);
  if (!cache || !live?.origin || !live.context)
    throw fail(
      "Shell capture requires a persisted cache and connected live portal browser.",
      409,
    );
  const origin = live.origin;
  if (cache.origin && cache.origin !== origin)
    throw fail(
      "Shell capture portal origin differs from the cache origin.",
      409,
    );
  const response = await live.request(path, { method: "GET" });
  if (response.status !== 200)
    throw fail(
      `Observed portal page returned HTTP ${response.status}; shell resources were not captured.`,
      response.status >= 400 ? response.status : 502,
    );
  if (!/^text\/html(?:;|$)/i.test(response.headers?.["content-type"] ?? ""))
    throw fail("Shell capture requires an HTML portal page.", 502);
  const html = response.body.toString("utf8");
  if (signInDocument(html, path))
    throw fail(
      "Complete portal sign-in before capturing shell resources.",
      401,
    );
  // The callback may extract static control metadata; raw HTML is not persisted.
  if (onObservedHtml) await onObservedHtml(html);
  const observedAspNetScripts = {
    pagePath: path.split("?")[0],
    htmlSha256: createHash("sha256").update(response.body).digest("hex"),
    observedAt: new Date().toISOString(),
    paths: references(html)
      .filter((ref) => ref.kind === "script")
      .map((ref) => {
        try {
          const item = resolveResource(ref.value, origin + path, origin);
          return item.sourceOrigin === origin && isAspNetResourcePath(item.path)
            ? item.path
            : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  };
  const shellProfile = {
      stylesheets: [],
      headScripts: [],
      bodyScripts: [],
      beforeContentScripts: [],
      afterFooterScripts: [],
    },
    captured = [],
    failures = [],
    diagnostics = [];
  const owned = new Map(
      (portal?.webFiles ?? []).map((f) => [f.url.split("?")[0], f]),
    ),
    embedded = new Set(
      [...embeddedReferences(portal, path, origin)].map((p) => p.split("?")[0]),
    ),
    seen = new Set(),
    pending = [],
    required = new Set();
  for (const record of portal?.records ?? [])
    if (record.kind === "webfile") {
      const parentId = field(record, "parentpageid"),
        partial = field(record, "partialurl");
      const parent = parentId
        ? (portal.pages ?? []).find((page) => page.id === parentId)?.url
        : "/";
      if (parent && partial) {
        const resourcePath = parent.replace(/\/$/, "") + "/" + partial;
        if (!owned.has(resourcePath))
          owned.set(resourcePath, {
            url: resourcePath,
            file: null,
            metadata: record,
          });
      }
    }
  let base = origin + path,
    hasJquery = false,
    hasStyles = false;
  const issue = (resource, error) =>
    failures.push({
      path: safePath(resource),
      code: error.code ?? "SHELL_CAPTURE",
      message: error.code
        ? error.message
        : "Shell resource could not be captured.",
    });
  const footer =
    portal?.templates?.[field(portal?.website, "footerwebtemplateid")];
  const header =
    portal?.templates?.[field(portal?.website, "headerwebtemplateid")];
  // Exported form scripts may request a metadata-only web file after the page
  // loads. Capture literal getScript dependencies without executing any source
  // or adding business scripts to the managed shell's execution order.
  const scripts = [
    ...(portal?.forms ?? []),
    ...(portal?.lists ?? []),
    ...(portal?.pages ?? []),
  ]
    .map((item) => item.js)
    .concat(
      (portal?.records ?? []).map((record) => record.customJavascript),
      Object.values(portal?.templates ?? {}).map((template) => template.source),
    );
  for (const script of scripts)
    if (typeof script === "string")
      for (const match of script.matchAll(
        /\.getScript\(\s*(["'])([^"'\r\n]+)\1/g,
      )) {
        try {
          const resource = resolveResource(match[2], origin + path, origin);
          const exported = owned.get(resource.path.split("?")[0]);
          if (
            resource.sourceOrigin !== origin ||
            !exported ||
            !resource.path.split("?")[0].endsWith(".js")
          )
            continue;
          let available = false;
          if (exported.file)
            try {
              await fs.access(exported.file);
              available = true;
            } catch {}
          if (!available) {
            required.add(resource.sourceOrigin + resource.path);
            pending.push(resource);
          }
        } catch {
          /* Dynamic/non-static calls are left to the exported source and diagnostics. */
        }
      }
  const logoClass = footerLogoClasses().find(
    (name) => footer?.source?.includes(name) && html.includes(name),
  );
  if (
    logoClass &&
    footer?.source?.includes(logoClass) &&
    html.includes(logoClass)
  ) {
    try {
      let layout;
      // This one intrinsic graphics rule is bound to the editable mapped CSS;
      // shell capture never replaces a stylesheet with deployed source bytes.
      for (const stylesheet of portal?.webFiles ?? []) {
        if (!stylesheet.file || !stylesheet.url.endsWith(".css")) continue;
        let sourceCss;
        try {
          sourceCss = await fs.readFile(stylesheet.file, "utf8");
        } catch {
          continue;
        }
        if (!sourceCss.includes(`.${logoClass}`)) continue;
        const observed = await live.request(stylesheet.url, { method: "GET" });
        if (
          observed.status !== 200 ||
          !/^text\/css(?:;|$)/i.test(observed.headers?.["content-type"] ?? "")
        ) {
          diagnostics.push({
            code: "FOOTER_LAYOUT_OBSERVATION_UNAVAILABLE",
            path: stylesheet.url,
            message:
              "Native footer stylesheet sizing could not be observed; editable local CSS remains active.",
          });
          continue;
        }
        const candidate = observedFooterLayout({
          path: stylesheet.url,
          sourceCss,
          observedCss: observed.body.toString("utf8"),
        });
        if (candidate) {
          if (layout)
            throw fail(
              "Multiple native stylesheets define the footer sizing observation.",
              422,
              "FOOTER_LAYOUT_AMBIGUOUS",
            );
          layout = candidate;
        }
      }
      shellProfile.footerLogos = observedFooterLogos(html, {
        footerSource: footer.source,
        origin,
        path,
        layout,
      });
      const fragment = parse(shellProfile.footerLogos.markup);
      const visitImages = (node) => {
        if (node.tagName === "img") {
          const src = node.attrs?.find((a) => a.name === "src")?.value;
          if (src) {
            const image = resolveResource(src, origin + path, origin);
            required.add(image.sourceOrigin + image.path);
            pending.push(image);
          }
        }
        for (const child of node.childNodes ?? []) visitImages(child);
      };
      visitImages(fragment);
    } catch (error) {
      issue(path, error);
    }
  }
  if (header?.source) {
    try {
      const notificationPresentation = observedHeaderNotifications(html, {
        headerSource: header.source,
        origin,
        path,
      });
      if (notificationPresentation)
        shellProfile.headerNotifications = notificationPresentation;
    } catch (error) {
      issue(path, error);
    }
  }
  try {
    const layout = observedPageCopyLayout(html, { portal, path, origin });
    if (layout) shellProfile.pageCopyLayouts = [layout];
  } catch (error) {
    issue(path, error);
  }
  for (const ref of references(html)) {
    if (ref.kind === "base") {
      try {
        const candidate = new URL(ref.value, base);
        if (
          candidate.origin !== origin ||
          candidate.username ||
          candidate.password
        )
          throw fail(
            "Observed base URL escaped the portal origin.",
            400,
            "SHELL_BASE_ORIGIN",
          );
        base = candidate.href;
      } catch (error) {
        issue(path, error);
      }
      continue;
    }
    let resource;
    try {
      resource = resolveResource(ref.value, base, origin);
    } catch (error) {
      issue(ref.value, error);
      continue;
    }
    const exportedScript =
      ref.kind === "script" &&
      resource.sourceOrigin === origin &&
      embedded.has(resource.path.split("?")[0]);
    if (
      ref.kind === "script" &&
      !runtimeScript(resource.path) &&
      !exportedScript
    ) {
      const platform = new URL(resource.url).pathname.startsWith(
        "/resource/powerappsportal/",
      );
      diagnostics.push({
        code: platform
          ? "SHELL_PLATFORM_SCRIPT_EXCLUDED"
          : "SHELL_BUSINESS_SCRIPT_EXCLUDED",
        path: safePath(resource.path),
        message: platform
          ? "Managed runtime dependency is not included by this supported shell profile; no runtime parity is implied."
          : "The observed application script was not added to the platform shell; exported templates control its inclusion.",
      });
      continue;
    }
    if (
      (ref.kind === "script" &&
        !isResourceManagerPath(new URL(resource.url).pathname) &&
        !isAspNetResourcePath(resource.path) &&
        !/\.m?js$/i.test(new URL(resource.url).pathname)) ||
      (ref.kind === "style" && !/\.css$/i.test(new URL(resource.url).pathname))
    ) {
      issue(
        resource.path,
        fail(
          "Observed shell reference is not a static script or stylesheet.",
          400,
          "SHELL_RESOURCE_TYPE",
        ),
      );
      continue;
    }
    if (ref.kind === "style") hasStyles = true;
    else if (
      /(?:^|\/)jquery(?:-[\d.]+)?(?:\.min)?\.js$/i.test(
        new URL(resource.url).pathname,
      )
    )
      hasJquery = true;
    if (seen.has(resource.path)) continue;
    seen.add(resource.path);
    if (!embedded.has(resource.path.split("?")[0])) {
      // Native Power Pages emits these managed body dependencies at the content
      // boundaries. Keep their phase instead of moving every body script ahead
      // of the exported footer and its authored script references.
      const key =
        ref.kind === "style"
          ? "stylesheets"
          : ref.position === "headScripts"
            ? "headScripts"
            : /(?:^|\/)(?:bootstrap(?:[-.]|$)|postpreform\.bundle-|default-\d+\.moment_)/i.test(
                  new URL(resource.url).pathname,
                )
              ? "afterFooterScripts"
              : /(?:^|\/)(?:jquery(?:[-.]|$)|preform\.moment_)/i.test(
                    new URL(resource.url).pathname,
                  )
                ? "beforeContentScripts"
                : "bodyScripts";
      const attributes =
        ref.kind === "style"
          ? ref.media
            ? { href: resource.path, media: ref.media }
            : resource.path
          : ref.defer || ref.async || ref.type
            ? {
                src: resource.path,
                ...(ref.defer ? { defer: true } : {}),
                ...(ref.async ? { async: true } : {}),
                ...(ref.type ? { type: ref.type } : {}),
              }
            : resource.path;
      shellProfile[key].push(attributes);
    } else
      diagnostics.push({
        code: "SHELL_LOCAL_SOURCE_REFERENCE",
        path: safePath(resource.path),
        message:
          "The exported template already emits this reference; the shell profile omits its duplicate.",
      });
    if (
      ref.type &&
      !["text/javascript", "application/javascript", "module"].includes(
        ref.type.toLowerCase(),
      )
    )
      issue(
        resource.path,
        fail(
          "Observed script has an unsupported executable type.",
          400,
          "SHELL_RESOURCE_ATTRIBUTES",
        ),
      );
    if (owned.has(resource.path.split("?")[0]))
      diagnostics.push({
        code: "SHELL_LOCAL_SOURCE_ASSET",
        path: safePath(resource.path),
        message: "The local exported asset supplies these bytes.",
      });
    required.add(resource.sourceOrigin + resource.path);
    pending.push(resource);
  }
  if (!hasStyles)
    issue(
      path,
      fail(
        "No shell stylesheet references were observed.",
        422,
        "SHELL_STYLES_MISSING",
      ),
    );
  const dependencySeen = new Set();
  while (pending.length) {
    const resource = pending.shift();
    const identity = resource.sourceOrigin + resource.path;
    if (dependencySeen.has(identity)) continue;
    dependencySeen.add(identity);
    if (dependencySeen.size > 200) {
      issue(
        resource.path,
        fail(
          "Shell static dependency capture exceeds 200 assets.",
          413,
          "SHELL_DEPENDENCY_LIMIT",
        ),
      );
      break;
    }
    let css = null;
    let local =
      resource.sourceOrigin === origin
        ? owned.get(resource.path.split("?")[0])
        : null;
    // PAC may export a web-file record without its attachment. Metadata alone
    // cannot supply bytes; capture the observed static URL in that case.
    if (local) {
      try {
        if (!local.file) local = null;
        else await fs.access(local.file);
      } catch {
        local = null;
      }
    }
    if (local) {
      if (/\.css$/i.test(new URL(resource.url).pathname) && local.file)
        try {
          css = cssText(await fs.readFile(local.file));
        } catch {
          issue(
            resource.path,
            fail(
              "Local exported stylesheet could not be read.",
              404,
              "SHELL_LOCAL_FILE_MISSING",
            ),
          );
        }
    } else {
      const result =
        resource.sourceOrigin === cdn
          ? await cache.capturePublic([resource.path], {
              portalOrigin: origin,
              recursive: false,
            })
          : await cache.capture([resource.path], live, {
              observedAspNetScripts,
            });
      captured.push(...result.captured);
      failures.push(
        ...result.failures.map((failure) => ({
          ...failure,
          dependency: !required.has(identity),
        })),
      );
      if (result.captured.some((item) => item.contentType === "text/css"))
        css = cssText((await cache.get(resource.path, { origin })).body);
    }
    if (css != null)
      for (const value of cssDependencies(css)) {
        if (!value || value.startsWith("data:") || value.startsWith("#"))
          continue;
        try {
          const target = new URL(value, resource.url);
          target.hash = "";
          const dependency = resolveResource(target.href, resource.url, origin);
          pending.push(dependency);
        } catch (error) {
          issue(resource.path, error);
        }
      }
  }
  if (!hasJquery)
    issue(
      path,
      fail(
        "No jQuery shell reference or verified ResourceManager jQuery library was observed.",
        422,
        "SHELL_JQUERY_MISSING",
      ),
    );
  return {
    shellProfile,
    captured,
    failures,
    diagnostics,
    pagePath: path.split("?")[0],
    complete: failures.length === 0,
    // CSS files can name obsolete fallback fonts/images that the selected
    // browser never requests. Keep every failure visible, while permitting a
    // profile whose directly observed scripts/styles/images were all captured.
    ready: failures.every((failure) => failure.dependency === true),
  };
}
