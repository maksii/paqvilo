import fs from "node:fs/promises";
import { parse } from "parse5";
import { validateLivePath } from "./live.mjs";
import { officeFontPath } from "./asset-cache.mjs";
import {
  captureRichTextConfiguration,
  findRichTextResource,
} from "./richtext-config.mjs";

const base = "/webresources/msdyn_/RichTextEditorControl/",
  editor = base + "libs/ckeditor_latest/";
const crmIconFont = "/uclient/resources/styles/CRMMDL2.woff";
const guid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const controlName = "MscrmControls.RichTextEditor.RichTextEditorControl";
const error = (code, message, path) => ({
  code,
  message,
  ...(path ? { path } : {}),
});
const crmFontFaceBlocks = (body) =>
  [...String(body ?? "").matchAll(/@font-face\s*\{([^}]*)\}/gi)]
    .map((match) => match[1])
    .filter(
      (block) =>
        /font-family\s*:\s*["']?CRMMDL2["']?\s*;/i.test(block) &&
        /url\(\s*["']?\/uclient\/resources\/styles\/CRMMDL2\.woff["']?\s*\)/i.test(
          block,
        ),
    );
const crmGlyphCodepoints = (body) => {
  const result = new Set();
  for (const match of String(body ?? "").matchAll(/[^{}]*\{([^{}]*)\}/g)) {
    const declarations = match[1];
    if (!/font-family\s*:[^;]*["']?CRMMDL2["']?/i.test(declarations))
      continue;
    for (const content of declarations.matchAll(/content\s*:\s*["']([^"']*)["']/gi))
      for (const escape of content[1].matchAll(/\\([\da-f]{1,6})\s?/gi))
        result.add(Number.parseInt(escape[1], 16));
  }
  return [...result].sort((a, b) => a - b);
};
const list = (value) =>
  String(value ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const safeResource = (path) => {
  validateLivePath(path);
  const url = new URL(path, "https://local.invalid");
  if (
    [...url.searchParams.keys()].some((key) =>
      /token|secret|cookie|password|credential|signature|authorization/i.test(
        key,
      ),
    )
  )
    throw new Error("Static resource URLs cannot contain credentials.");
  return (
    path === crmIconFont ||
    path.startsWith(base) ||
    (/^\/_pcfwebresource\/[\da-f-]{36}$/.test(url.pathname) &&
      guid.test(url.pathname.split("/").at(-1))) ||
    /^\/resource\/powerappsportal\/dist\/(?:pcf[\w.-]*|client-telemetry(?:-wrapper)?\.bundle-[\da-f]+)\.(?:js|css)$/.test(
      url.pathname,
    )
  );
};
function localResource(value, portalOrigin) {
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (
      !["https://content.powerapps.com", portalOrigin].includes(url.origin) ||
      url.username ||
      url.password
    )
      throw new Error("Unapproved public resource origin.");
    value = url.pathname + url.search;
  }
  if (
    !safeResource(value) ||
    /^\/resource\/powerappsportal\/dist\/pcf-loader[\w.-]*\.js/.test(value)
  )
    return null;
  return value;
}
function orderedScripts(paths) {
  const weight = (path) =>
    path.includes("client-telemetry-wrapper")
      ? 1
      : path.includes("client-telemetry")
        ? 0
        : path.includes("pcf-dependency")
          ? 2
          : /\/pcf\.bundle/.test(path)
            ? 3
            : path.includes("pcf-extended")
              ? 4
              : path.startsWith("/_pcfwebresource/")
                ? 5
                : 6;
  return [...new Set(paths)].sort((a, b) => weight(a) - weight(b));
}

/** Read resource names only from existing same-origin pages; never navigate or read controls. */
export async function observeManagedResources(live) {
  const resources = [],
    scripts = [],
    stylesheets = [],
    fonts = [],
    diagnostics = [];
  const pages = (live.context?.pages?.() ?? []).filter((page) => {
    try {
      return new URL(page.url()).origin === new URL(live.origin).origin;
    } catch {
      return false;
    }
  });
  if (pages.length > 20)
    diagnostics.push(
      error(
        "RICHTEXT_OBSERVATION_TRUNCATED",
        "Static resource observation is limited to the 20 most recent existing portal pages.",
      ),
    );
  for (const page of pages.slice(-20)) {
    try {
      if (new URL(page.url()).origin !== new URL(live.origin).origin) continue;
      const names = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .slice(-2000)
          .map((entry) => ({ name: entry.name, type: entry.initiatorType })),
      );
      for (const entry of names) {
        const name = typeof entry === "string" ? entry : entry.name;
        try {
          const path = localResource(name, live.origin);
          if (path) {
            resources.push(path);
            if (entry.type === "script" || /\.js(?:\?|$)/.test(path))
              scripts.push(path);
            if (entry.type === "link" || /\.css(?:\?|$)/.test(path))
              stylesheets.push(path);
          }
        } catch {}
        try {
          officeFontPath(name);
          fonts.push(name);
        } catch {}
      }
    } catch {
      diagnostics.push(
        error(
          "RICHTEXT_OBSERVATION_UNAVAILABLE",
          "An existing portal page could not expose its static resource timing entries.",
        ),
      );
    }
  }
  if (new Set(resources).size > 200 || new Set(fonts).size > 200)
    diagnostics.push(
      error(
        "RICHTEXT_OBSERVATION_TRUNCATED",
        "Observed static dependency names exceed the 200-resource capture bound; additional dependencies remain unverified.",
      ),
    );
  return {
    resources: [...new Set(resources)].slice(0, 200),
    scripts: [...new Set(scripts)].slice(0, 200),
    stylesheets: [...new Set(stylesheets)].slice(0, 200),
    fonts: [...new Set(fonts)].slice(0, 200),
    diagnostics,
  };
}
const fieldsIn = (schemas) => {
  const fields = [],
    seen = new Set();
  let nodes = 0;
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (++nodes > 20000)
      throw new Error("Rich text schema traversal exceeded its bound.");
    if (value.richText) fields.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(schemas);
  return fields;
};

/** Extract static PCF definitions only; controlcontext and record values are never copied. */
export function extractManagedRichTextControls(html) {
  const manifests = new Map(),
    scripts = [],
    stylesheets = [],
    diagnostics = [];
  const visit = (node) => {
    const attrs = Object.fromEntries(
      (node.attrs ?? []).map((attr) => [attr.name, attr.value]),
    );
    if (attrs["data-pcf-control"]) {
      try {
        if (attrs["data-pcf-control"].length > 1024 * 1024)
          throw new Error("PCF static manifest exceeds the capture bound.");
        const manifest = JSON.parse(attrs["data-pcf-control"]);
        if (manifest.Name === controlName) {
          if (
            !Array.isArray(manifest.Properties) ||
            !Array.isArray(manifest.Resources)
          )
            throw new Error("PCF manifest properties/resources are missing.");
          if (
            manifest.ControlProperties ||
            manifest.value ||
            manifest.AuthConfigPropertiesGroups?.length ||
            manifest.DataConnectors?.length
          )
            throw new Error(
              "PCF definition contains instance/authentication data.",
            );
          const previous = manifests.get(manifest.Name);
          // Later fields can omit already loaded resources; keep the first full definition.
          if (!previous) manifests.set(manifest.Name, manifest);
        }
      } catch (cause) {
        diagnostics.push(error("RICHTEXT_MANIFEST_INVALID", cause.message));
      }
    }
    const resource =
      node.tagName === "script"
        ? attrs.src
        : node.tagName === "link" &&
            attrs.rel?.split(/\s+/).includes("stylesheet")
          ? attrs.href
          : null;
    if (resource) {
      try {
        const local = localResource(resource);
        // The local renderer initializes managed controls itself after vendor scripts.
        if (local)
          (node.tagName === "script" ? scripts : stylesheets).push(local);
      } catch {}
    }
    if (node.tagName !== "template")
      for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(String(html ?? "")));
  // Native vendor GUID tags defer execution; framework bundles export React first.
  const ordered = orderedScripts(scripts);
  return {
    managedControls: Object.fromEntries(
      [...manifests].map(([name, manifest]) => [
        name,
        {
          manifest,
          scripts: orderedScripts([
            ...ordered,
            ...manifest.Resources.filter(
              (resource) => resource.Type === 0 && guid.test(resource.Path),
            ).map((resource) => "/_pcfwebresource/" + resource.Path),
          ]),
          stylesheets: [
            ...new Set([
              ...stylesheets,
              ...manifest.Resources.filter(
                (resource) => resource.Type === 1 && guid.test(resource.Path),
              ).map((resource) => "/_pcfwebresource/" + resource.Path),
            ]),
          ],
        },
      ]),
    ),
    diagnostics,
  };
}

/** Bounded static capture for configured rich text controls. No scripts are evaluated. */
export async function captureRichTextAssets(
  cache,
  live,
  {
    schemas = {},
    portal = {},
    html = "",
    managedControls = {},
    observedResources = [],
    managedControlPath,
    captureConfigurations = false,
  } = {},
) {
  const captured = [],
    failures = [],
    diagnostics = [],
    fields = fieldsIn(schemas),
    result = {
      required: fields.length > 0,
      complete: false,
      assetsComplete: false,
      nativeReady: false,
      captured,
      failures,
      diagnostics,
      nativeAssetFailures: [],
      assetFallbacks: [],
      managedControls: {},
    };
  if (!fields.length)
    return {
      ...result,
      complete: true,
      assetsComplete: true,
      nativeReady: true,
      skipped: "NO_RICH_TEXT_FIELDS",
    };
  if (!cache)
    return {
      ...result,
      skipped: "ASSET_CACHE_UNAVAILABLE",
      failures: [
        error(
          "RICHTEXT_CACHE_REQUIRED",
          "Rich text capture requires a persisted asset cache.",
        ),
      ],
    };
  if (live.status?.().connected === false)
    return {
      ...result,
      skipped: "LIVE_DISCONNECTED",
      failures: [
        error(
          "RICHTEXT_LIVE_DISCONNECTED",
          "Connect the intended portal browser before capturing rich text assets.",
        ),
      ],
    };
  if (managedControlPath) {
    try {
      validateLivePath(managedControlPath);
      if (
        [...new URL(managedControlPath, live.origin).searchParams.keys()].some(
          (key) =>
            /token|secret|cookie|password|credential|signature/i.test(key),
        )
      )
        throw new Error(
          "Managed control capture paths cannot contain credential parameters.",
        );
      const response = await live.request(managedControlPath, {
          method: "GET",
        }),
        bytes = response.body;
      if (
        response.status !== 200 ||
        !String(response.headers?.["content-type"]).includes("text/html") ||
        bytes.length > 5 * 1024 * 1024
      )
        throw new Error(
          "The selected managed control page must return bounded HTML with HTTP 200.",
        );
      const selected = extractManagedRichTextControls(bytes.toString("utf8"));
      if (!Object.keys(selected.managedControls).length)
        diagnostics.push(
          error(
            "RICHTEXT_MANAGED_MANIFEST_MISSING",
            "The explicitly selected page contained no supported static managed rich text manifest.",
          ),
        );
      html += "\n" + bytes.toString("utf8");
    } catch (cause) {
      failures.push(error("RICHTEXT_MANAGED_PAGE_FAILED", cause.message));
    }
  }
  const observed = await observeManagedResources(live);
  diagnostics.push(...observed.diagnostics);
  const extracted = extractManagedRichTextControls(html);
  diagnostics.push(...extracted.diagnostics);
  result.managedControls = { ...managedControls, ...extracted.managedControls };
  for (const definition of Object.values(result.managedControls)) {
    definition.scripts = orderedScripts([
      ...(definition.scripts ?? []),
      ...observed.scripts,
    ]);
    definition.stylesheets = [
      ...new Set([...(definition.stylesheets ?? []), ...observed.stylesheets]),
    ];
  }
  const seen = new Set(),
    bodies = new Map();
  const capture = async (paths) => {
    const planned = [];
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        if (!safeResource(path))
          throw new Error(
            "Only configured managed rich text, PCF GUID, or observed PCF bundle paths can be captured.",
          );
        if (seen.size > 200)
          throw new Error("Rich text static dependency count exceeds 200.");
        planned.push(path);
      } catch (cause) {
        failures.push(
          error(
            "RICHTEXT_RESOURCE_EXCLUDED",
            cause.message,
            "<excluded rich text resource>",
          ),
        );
      }
    }
    for (let start = 0; start < planned.length; start += 50) {
      const paths = planned.slice(start, start + 50),
        publicPaths = paths.filter((path) => path.startsWith("/resource/")),
        portalPaths = paths.filter((path) => !path.startsWith("/resource/"));
      for (const [batch, isPublic] of [
        [portalPaths, false],
        [publicPaths, true],
      ])
        if (batch.length) {
          try {
            const report = isPublic
              ? await cache.capturePublic(batch, { portalOrigin: live.origin })
              : await cache.capture(batch, live);
            captured.push(...report.captured);
            failures.push(...report.failures);
          } catch (cause) {
            for (const path of batch)
              failures.push(
                error(
                  cause.code ?? "RICHTEXT_CAPTURE_FAILED",
                  cause.message,
                  path,
                ),
              );
          }
        }
      for (const path of paths)
        try {
          const asset = await cache.get(path, { origin: live.origin });
          if (asset) bodies.set(path, asset.body);
        } catch (cause) {
          failures.push(
            error(
              cause.code ?? "RICHTEXT_CACHE_READ_FAILED",
              cause.message,
              path,
            ),
          );
        }
    }
  };
  await capture([
    base + "RTEGlobalConfiguration.json",
    editor + "ckeditor.js",
    editor + "contents.css",
  ]);
  let globalConfiguration = {};
  try {
    const bytes = bodies.get(base + "RTEGlobalConfiguration.json");
    if (!bytes)
      throw new Error("Managed rich text global configuration is unavailable.");
    if (bytes.length > 256 * 1024)
      throw new Error("Managed rich text configuration is too large.");
    globalConfiguration = JSON.parse(bytes);
  } catch (cause) {
    failures.push(
      error(
        "RICHTEXT_CONFIG_INVALID",
        cause.message,
        base + "RTEGlobalConfiguration.json",
      ),
    );
  }
  const configurations = [],
    configurationBaselines = new Map();
  for (const field of fields) {
    const configUrl = field.richText?.configUrl;
    let configuration = field.richText?.configuration ?? {};
    if (configUrl) {
      let resource;
      try {
        resource = findRichTextResource(portal, configUrl);
        if (resource) {
          if (captureConfigurations) {
            let capturedConfig = configurationBaselines.get(resource.url);
            if (!capturedConfig) {
              capturedConfig = await captureRichTextConfiguration(cache, live, {
                portal,
                resource,
                configUrl,
              });
              configurationBaselines.set(resource.url, capturedConfig);
              captured.push(...capturedConfig.captured);
              failures.push(...capturedConfig.failures);
            }
            if (!capturedConfig.configuration)
              throw new Error("Observed mapped rich text JSON capture failed.");
            configuration = capturedConfig.configuration;
          } else
            configuration = JSON.parse(
              await fs.readFile(resource.file, "utf8"),
            );
        } else {
          await capture([configUrl]);
          const body = bodies.get(configUrl);
          if (!body)
            throw new Error("Configured rich text JSON is unavailable.");
          configuration = JSON.parse(body);
        }
      } catch (cause) {
        failures.push(
          error(
            "RICHTEXT_CONFIG_INVALID",
            cause.message,
            resource
              ? "source-owned configuration"
              : "<configured rich text resource>",
          ),
        );
      }
    }
    configurations.push({
      ...globalConfiguration.defaultSupportedProps,
      ...configuration.defaultSupportedProps,
    });
  }
  result.configurationBaselines = [...configurationBaselines.values()]
    .map((entry) => entry.baseline)
    .filter(Boolean);
  const library = bodies.get(editor + "ckeditor.js")?.toString("utf8") ?? "",
    bundled = new Set(
      [...library.matchAll(/CKEDITOR\.plugins\.add\(\s*["']([\w-]+)["']/g)].map(
        (match) => match[1],
      ),
    );
  const plugins = new Set([
    "a11yshortcuts",
    "accessibilityhelp",
    "collapser",
    "rteplaceholder",
    "filetools",
    "superimage",
    "iframerestrictor",
    "userpersonalization",
    "stickystyles",
    "copilotrefinement",
  ]);
  const skins = new Set(["superowa"]);
  for (const configuration of configurations) {
    if (configuration.skin) {
      if (!/^[\w-]+$/.test(configuration.skin))
        failures.push(
          error(
            "RICHTEXT_CONFIG_UNSUPPORTED",
            "Rich text skin must use a managed resource name.",
          ),
        );
      else skins.add(configuration.skin);
    }
    for (const plugin of list(configuration.extraPlugins))
      if (!/^[\w-]+$/.test(plugin))
        failures.push(
          error(
            "RICHTEXT_CONFIG_UNSUPPORTED",
            "Rich text plugin names cannot contain paths or URLs.",
          ),
        );
      else if (!bundled.has(plugin)) plugins.add(plugin);
  }
  if (plugins.size > 64)
    failures.push(
      error(
        "RICHTEXT_CONFIG_UNSUPPORTED",
        "Rich text configuration requests more than 64 plugins.",
      ),
    );
  const paths = [editor + "plugins/icons.png"];
  const timestamp = /\btimestamp\s*:\s*["']([\w-]{1,40})["']/.exec(
    library,
  )?.[1];
  if (timestamp) paths.push(editor + "plugins/icons.png?t=" + timestamp);
  for (const skin of skins)
    paths.push(
      editor + `skins/${skin}/skin.js`,
      editor + `skins/${skin}/editor.css`,
      editor + `skins/${skin}/icons_hidpi.png`,
    );
  for (const plugin of [...plugins].slice(0, 64))
    paths.push(editor + `plugins/${plugin}/plugin.js`);
  for (const path of [
    "plugins/tableselection/styles/tableselection.css",
    "plugins/superimage/lang/en.js",
    "plugins/userpersonalization/lang/en.js",
    "plugins/copilotrefinement/lang/en.js",
    "plugins/dialog/styles/dialog.css",
    "plugins/copyformatting/styles/copyformatting.css",
    "plugins/copilotrefinement/styles/copilotrefinement.css",
  ])
    paths.push(editor + path);
  paths.push(...observedResources);
  for (const definition of Object.values(result.managedControls)) {
    paths.push(
      ...(definition.scripts ?? []),
      ...(definition.stylesheets ?? []),
    );
    for (const resource of definition.manifest?.Resources ?? [])
      if (
        [0, 1].includes(resource.Type) &&
        typeof resource.Path === "string" &&
        guid.test(resource.Path)
      )
        paths.push("/_pcfwebresource/" + resource.Path);
  }
  await capture(paths);
  // The native editor skin and Type1 PCF styles reference this same-origin font.
  // Capture it only when an actual captured stylesheet declares the dependency.
  const stylePaths = [
    editor + "contents.css",
    ...[...skins].map((skin) => editor + `skins/${skin}/editor.css`),
    ...Object.values(result.managedControls).flatMap((definition) => [
      ...(definition.stylesheets ?? []),
      ...(definition.manifest?.Resources ?? [])
        .filter((resource) => resource.Type === 1 && guid.test(resource.Path))
        .map((resource) => "/_pcfwebresource/" + resource.Path),
    ]),
  ];
  const fontStyles = stylePaths
    .map((path) => ({ path, body: bodies.get(path)?.toString("utf8") ?? "" }))
    .filter(({ body }) => crmFontFaceBlocks(body).length > 0);
  result.cssDependencies = fontStyles.length ? [crmIconFont] : [];
  if (result.cssDependencies.length) {
    const codepoints = [
      ...new Set(fontStyles.flatMap(({ body }) => crmGlyphCodepoints(body))),
    ].sort((a, b) => a - b);
    try {
      const native = await cache.capture([crmIconFont], live);
      captured.push(...native.captured);
      if (!native.captured.some((item) => item.path === crmIconFont)) {
        const observedMissing = native.failures.filter(
          (item) =>
            item.path === crmIconFont &&
            item.code === "ASSET_HTTP" &&
            /HTTP 404\b/.test(item.message ?? ""),
        );
        if (observedMissing.length) {
          result.nativeAssetFailures.push(...observedMissing);
          const fallback = await cache.capturePublicAlias(
            {
              sourcePath: "/resource/powerappsportal/fonts/CRMMDL2.woff",
              targetPath: crmIconFont,
              requiredCodepoints: codepoints,
            },
            { portalOrigin: live.origin },
          );
          captured.push(...fallback.captured);
          failures.push(
            ...native.failures.filter((item) => !observedMissing.includes(item)),
            ...fallback.failures,
          );
          const alias = fallback.captured.find(
            (item) => item.path === crmIconFont && item.fallback,
          );
          if (alias) {
            result.assetFallbacks.push(alias.fallback);
            diagnostics.push(
              error(
                "RICHTEXT_NATIVE_FONT_FALLBACK",
                "The native CRM font returned HTTP 404. A named Microsoft public CDN font with verified CSS glyph coverage is cached for local use; this fallback does not establish native font byte or visual parity.",
                crmIconFont,
              ),
            );
          }
        } else failures.push(...native.failures);
      }
    } catch (cause) {
      failures.push(
        error("RICHTEXT_FONT_CAPTURE_FAILED", cause.message, crmIconFont),
      );
    }
  }
  // Managed PCF vendor bundles register languages before CKEditor initializes.
  // A supported-language list in the core library is not a separate language file.
  const languageScripts = [
    editor + "ckeditor.js",
    ...Object.values(result.managedControls).flatMap(
      (definition) => definition.scripts ?? [],
    ),
  ];
  const bundledLanguages = new Set();
  for (const path of languageScripts) {
    const script = bodies.get(path)?.toString("utf8") ?? "";
    for (const match of script.matchAll(
      /CKEDITOR\s*\.\s*lang\s*(?:\[\s*['"]([a-z]{2}(?:-[a-z]{2})?)['"]\s*\]|\.\s*([a-z]{2}(?:-[a-z]{2})?))\s*=\s*\{/gi,
    ))
      bundledLanguages.add((match[1] ?? match[2]).toLowerCase());
  }
  result.bundledLanguages = [...bundledLanguages].sort();
  if (observed.fonts.length) {
    try {
      const report = await cache.captureOfficeFonts(observed.fonts, {
        portalOrigin: live.origin,
      });
      captured.push(...report.captured);
      failures.push(...report.failures);
      const settings = {},
        bases = { fontBaseUrl: new Set(), iconBaseUrl: new Set() };
      for (const font of observed.fonts) {
        const local = officeFontPath(font),
          match = /^(.*\/assets\/)(fonts|icons)\//.exec(local);
        if (match)
          bases[match[2] === "fonts" ? "fontBaseUrl" : "iconBaseUrl"].add(
            match[2] === "fonts" ? match[1].slice(0, -1) : match[1] + "icons/",
          );
      }
      for (const [key, values] of Object.entries(bases))
        if (values.size === 1) settings[key] = [...values][0];
        else if (values.size > 1)
          diagnostics.push(
            error(
              "RICHTEXT_FONT_BASE_AMBIGUOUS",
              `Existing portal pages expose multiple ${key} versions; no base override was inferred.`,
            ),
          );
      for (const definition of Object.values(result.managedControls))
        definition.fabricConfig = { ...definition.fabricConfig, ...settings };
    } catch (cause) {
      failures.push(error("RICHTEXT_FONT_CAPTURE_FAILED", cause.message));
    }
  } else if (Object.keys(result.managedControls).length)
    diagnostics.push(
      error(
        "RICHTEXT_OFFICE_FONTS_UNOBSERVED",
        "No approved Office fonts were observed in existing connected portal pages; no new font bases were inferred. Readiness can use previously captured fonts only from this portal origin.",
      ),
    );
  if (!Object.keys(result.managedControls).length)
    diagnostics.push(
      error(
        "RICHTEXT_MANAGED_MANIFEST_MISSING",
        "No observed native PCF manifest was supplied; captured CKEditor assets support the adapter, not proof of native managed control parity.",
      ),
    );
  result.assetsComplete = failures.length === 0;
  const available = [
    ...captured,
    ...(cache.manifest?.().assets ?? []).filter(
      (asset) => asset.origin === live.origin,
    ),
  ].map((asset) => asset.path);
  const definitions = Object.values(result.managedControls);
  result.nativeReady =
    result.assetsComplete &&
    result.assetFallbacks.length === 0 &&
    !diagnostics.some((diagnostic) =>
      [
        "RICHTEXT_OBSERVATION_TRUNCATED",
        "RICHTEXT_FONT_BASE_AMBIGUOUS",
        "RICHTEXT_MANIFEST_INVALID",
      ].includes(diagnostic.code),
    ) &&
    definitions.length > 0 &&
    definitions.every((definition) => {
      const scripts = definition.scripts ?? [],
        resources = definition.manifest?.Resources ?? [],
        fabric = definition.fabricConfig ?? {};
      const frameworks = [
        "client-telemetry.bundle-",
        "client-telemetry-wrapper.bundle-",
        "pcf-dependency.bundle-",
        "pcf.bundle-",
        "pcf-extended.bundle-",
      ].every((name) => scripts.some((path) => path.includes("/" + name)));
      const vendors =
        resources.some(
          (resource) => resource.Type === 0 && guid.test(resource.Path),
        ) &&
        resources.some(
          (resource) => resource.Type === 1 && guid.test(resource.Path),
        );
      const fonts =
        typeof fabric.fontBaseUrl === "string" &&
        available.some((path) =>
          path.startsWith(fabric.fontBaseUrl + "/fonts/"),
        );
      const icons =
        typeof fabric.iconBaseUrl === "string" &&
        available.some((path) => path.startsWith(fabric.iconBaseUrl));
      return frameworks && vendors && fonts && icons;
    });
  if (!result.nativeReady)
    diagnostics.push(
      error(
        "RICHTEXT_NATIVE_NOT_READY",
        "Native rich text requires the observed static manifest, captured telemetry/framework/vendor resources, and captured font/icon bases. Asset capture alone does not establish native readiness.",
      ),
    );
  result.complete = result.nativeReady;
  return result;
}
