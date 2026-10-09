import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { validateLivePath } from "./live.mjs";

const fail = (message, status = 400, code = "ASSET_CAPTURE") =>
  Object.assign(new Error(message), { status, code });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mediaType = (value) =>
  String(value ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
const credentialKey =
  /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|authorization|cookie|api[_-]?key|__requestverificationtoken|code|sig|signature|credential)$/i;
const platformCdn = "https://content.powerapps.com";
const officeFontPrefix = "/__sim-static/office-fonts/";
const crmFontSource = "/resource/powerappsportal/fonts/CRMMDL2.woff";
const crmFontTarget = "/uclient/resources/styles/CRMMDL2.woff";
export function officeFontPath(value) {
  const url = new URL(value);
  if (
    !["https://res-1.cdn.office.net", "https://res.cdn.office.net"].includes(
      url.origin,
    ) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/files\/fabric-cdn-prod_[\d.]+\/assets\/(?:fonts|icons)\/[\w./-]+\.(?:woff2?|ttf)$/i.test(
      url.pathname,
    ) ||
    url.pathname.includes("..")
  )
    throw fail(
      "Office capture is confined to versioned public Fluent UI font files.",
    );
  return officeFontPrefix + url.hostname + url.pathname;
}
const types = {
  ".pcf": [
    "text/css",
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
  ],
  ".js": [
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "text/ecmascript",
  ],
  ".mjs": [
    "application/javascript",
    "text/javascript",
    "application/ecmascript",
  ],
  ".css": ["text/css"],
  ".json": ["application/json"],
  ".svg": ["image/svg+xml"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
  ".woff": [
    "font/woff",
    "application/font-woff",
    "application/x-font-woff",
    "application/octet-stream",
  ],
  ".woff2": [
    "font/woff2",
    "application/font-woff2",
    "application/octet-stream",
  ],
  ".ttf": [
    "font/ttf",
    "application/x-font-ttf",
    "application/font-sfnt",
    "application/octet-stream",
  ],
  ".otf": [
    "font/otf",
    "application/x-font-opentype",
    "application/font-sfnt",
    "application/octet-stream",
  ],
  ".eot": ["application/vnd.ms-fontobject", "application/octet-stream"],
  ".map": ["application/json", "application/octet-stream"],
};
function safeOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw fail("Asset capture requires a configured HTTPS portal origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw fail(
      "Asset capture origin must be an HTTPS origin without credentials or a path.",
    );
  return url.origin;
}
export const isResourceManagerPath = (value) =>
  /^\/_portal\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/Resources\/ResourceManager$/i.test(
    value,
  );
export const isPcfWebResourcePath = (value) =>
  /^\/_pcfwebresource\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
    value,
  );
export const isAspNetResourcePath = (value) => {
  try {
    const url = new URL(value, "https://local.invalid");
    return (
      /^\/(?:WebResource|ScriptResource)\.axd$/.test(url.pathname) &&
      !url.hash &&
      [...url.searchParams.keys()].length === 2 &&
      url.searchParams.getAll("d").length === 1 &&
      url.searchParams.getAll("t").length === 1 &&
      /^[A-Za-z0-9_-]{16,2048}$/.test(url.searchParams.get("d")) &&
      /^[A-Za-z0-9_-]{1,32}$/.test(url.searchParams.get("t"))
    );
  } catch {
    return false;
  }
};
function checkedAspNetObservation(value) {
  if (
    !value ||
    !/^[\da-f]{64}$/.test(value.htmlSha256 ?? "") ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    throw fail(
      "ASP.NET resources require an observed native HTML script reference.",
      400,
      "ASSET_AXD_OBSERVATION",
    );
  validateLivePath(value.pagePath);
  if (value.pagePath.includes("?"))
    throw fail(
      "ASP.NET page provenance must omit request query data.",
      400,
      "ASSET_AXD_OBSERVATION",
    );
  return {
    pagePath: value.pagePath,
    htmlSha256: value.htmlSha256,
    observedAt: value.observedAt,
  };
}
function assetPath(value) {
  validateLivePath(value);
  const parsed = new URL(value, "https://local.invalid");
  for (const [key] of parsed.searchParams)
    if (credentialKey.test(key))
      throw fail(
        "Credential or authorization query parameters cannot be cached.",
      );
  if (/\.axd$/i.test(parsed.pathname) && !isAspNetResourcePath(value))
    throw fail(
      "ASP.NET resource URLs allow only exact WebResource/ScriptResource paths with one opaque d and t parameter.",
      400,
      "ASSET_AXD_QUERY",
    );
  const ext = isAspNetResourcePath(value)
    ? ".js"
    : isResourceManagerPath(parsed.pathname)
      ? ".js"
      : isPcfWebResourcePath(parsed.pathname)
        ? ".pcf"
        : path.posix.extname(parsed.pathname).toLowerCase();
  if (!types[ext] || (ext === ".pcf" && !isPcfWebResourcePath(parsed.pathname)))
    throw fail(
      "Only static script, style, font, image, source-map and known platform ResourceManager asset paths may be captured.",
    );
  return { key: parsed.pathname + parsed.search, extension: ext };
}
const failurePath = (value) =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.includes("@")
    ? value.split("?")[0].slice(0, 300)
    : "<invalid asset path>";
function verifyAsset(bytes, type, extension, { observedEmpty = false } = {}) {
  const contentType = mediaType(type);
  if (!types[extension]?.includes(contentType))
    throw fail(
      "Asset content type does not match its static resource extension.",
      502,
      "ASSET_CONTENT_TYPE",
    );
  const prefix = bytes
    .subarray(0, 1024)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^<(?:!doctype\s+html|html|head|body|form|input)\b/i.test(prefix))
    throw fail(
      "The asset response contains an HTML or sign-in document and was not cached.",
      401,
      "ASSET_SIGN_IN",
    );
  if (!bytes.length && !observedEmpty)
    throw fail("Empty assets cannot be captured.", 502, "ASSET_EMPTY");
  if (bytes.length > 20 * 1024 * 1024)
    throw fail(
      "Static asset exceeds the 20 MiB cache limit.",
      413,
      "ASSET_TOO_LARGE",
    );
  if (
    [".js", ".mjs", ".css", ".json", ".map", ".pcf"].includes(extension) &&
    /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|__requestverificationtoken|authorization)["']?\s*[:=]\s*["'](?:Bearer\s+)?[^"'\s]{12,}["']/i.test(
      bytes.toString("utf8"),
    )
  )
    throw fail(
      "Static response appears to contain embedded credential values and was not cached.",
      400,
      "ASSET_CREDENTIAL_CONTENT",
    );
  return contentType;
}

function woffTables(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "wOFF" || bytes.length < 44)
    throw fail("Microsoft CDN CRM font is not a valid WOFF asset.", 502, "ASSET_FONT_FORMAT");
  const count = bytes.readUInt16BE(12), tables = new Map();
  if (!count || count > 256 || 44 + count * 20 > bytes.length)
    throw fail("Microsoft CDN CRM font has an invalid WOFF table directory.", 502, "ASSET_FONT_FORMAT");
  for (let index = 0; index < count; index++) {
    const offset = 44 + index * 20, tag = bytes.toString("ascii", offset, offset + 4),
      start = bytes.readUInt32BE(offset + 4), compressed = bytes.readUInt32BE(offset + 8),
      length = bytes.readUInt32BE(offset + 12);
    if (start + compressed > bytes.length || length > 16 * 1024 * 1024)
      throw fail("Microsoft CDN CRM font has an invalid WOFF table range.", 502, "ASSET_FONT_FORMAT");
    const raw = bytes.subarray(start, start + compressed);
    tables.set(tag, compressed === length ? raw : inflateSync(raw));
  }
  return tables;
}

function decodeName(bytes, platform) {
  if (platform === 0 || platform === 3) {
    const value = Buffer.from(bytes);
    if (value.length % 2) return "";
    for (let index = 0; index < value.length; index += 2) {
      const first = value[index]; value[index] = value[index + 1]; value[index + 1] = first;
    }
    return value.toString("utf16le");
  }
  return bytes.toString("latin1");
}

function woffNames(table) {
  if (!table || table.length < 6) return {};
  const format = table.readUInt16BE(0), count = table.readUInt16BE(2), base = table.readUInt16BE(4);
  if (format !== 0 || count > 2048 || 6 + count * 12 > table.length)
    throw fail("Microsoft CDN CRM font name table is invalid.", 502, "ASSET_FONT_FORMAT");
  const names = new Map();
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 12, platform = table.readUInt16BE(offset),
      nameId = table.readUInt16BE(offset + 6), length = table.readUInt16BE(offset + 8),
      start = base + table.readUInt16BE(offset + 10);
    if (![1, 6].includes(nameId) || start + length > table.length) continue;
    const value = decodeName(table.subarray(start, start + length), platform).trim();
    if (value && !names.has(nameId)) names.set(nameId, value);
  }
  return { family: names.get(1), postScriptName: names.get(6) };
}

function cmapCovers(table, codepoints) {
  if (!table || table.length < 4) return false;
  const count = table.readUInt16BE(2);
  if (count > 128 || 4 + count * 8 > table.length) return false;
  const subtables = [];
  for (let index = 0; index < count; index++) {
    const offset = 4 + index * 8, start = table.readUInt32BE(offset + 4);
    if (start + 2 <= table.length) subtables.push(table.subarray(start));
  }
  return codepoints.every((codepoint) => subtables.some((subtable) => {
    const format = subtable.readUInt16BE(0);
    if (format === 12 && subtable.length >= 16) {
      const groups = subtable.readUInt32BE(12);
      if (groups > 100000 || 16 + groups * 12 > subtable.length) return false;
      for (let index = 0; index < groups; index++) {
        const offset = 16 + index * 12, first = subtable.readUInt32BE(offset),
          last = subtable.readUInt32BE(offset + 4), glyph = subtable.readUInt32BE(offset + 8);
        if (first <= codepoint && codepoint <= last) return glyph + codepoint - first !== 0;
      }
      return false;
    }
    if (format !== 4 || codepoint > 0xffff || subtable.length < 16) return false;
    const segments = subtable.readUInt16BE(6) / 2, endBase = 14,
      startBase = endBase + segments * 2 + 2,
      deltaBase = startBase + segments * 2,
      rangeBase = deltaBase + segments * 2;
    if (!segments || rangeBase + segments * 2 > subtable.length) return false;
    for (let index = 0; index < segments; index++) {
      const end = subtable.readUInt16BE(endBase + index * 2);
      if (codepoint > end) continue;
      const first = subtable.readUInt16BE(startBase + index * 2);
      if (codepoint < first) return false;
      const delta = subtable.readInt16BE(deltaBase + index * 2),
        range = subtable.readUInt16BE(rangeBase + index * 2);
      if (!range) return (codepoint + delta) & 0xffff ? true : false;
      const glyphOffset = rangeBase + index * 2 + range + 2 * (codepoint - first);
      return glyphOffset + 2 <= subtable.length && subtable.readUInt16BE(glyphOffset) !== 0;
    }
    return false;
  }));
}

function crmFontMetadata(bytes, requiredCodepoints) {
  const tables = woffTables(bytes), names = woffNames(tables.get("name"));
  if (names.family !== "CRM MDL2 Assets" || names.postScriptName !== "CRMMDL2Assets")
    throw fail("Microsoft CDN WOFF name table is not the expected CRM MDL2 asset font.", 502, "ASSET_FONT_FAMILY");
  if (requiredCodepoints.length && !cmapCovers(tables.get("cmap"), requiredCodepoints))
    throw fail("Microsoft CDN CRM font does not cover every glyph codepoint referenced by captured CSS.", 502, "ASSET_FONT_GLYPH_COVERAGE");
  return { cssFamily: "CRMMDL2", fontFamily: names.family, postScriptName: names.postScriptName, requiredCodepoints };
}

/** Cache same-origin static bytes only; authentication stays in the browser. */
export class AssetCache {
  constructor({ directory, origin = null, fetchImpl = globalThis.fetch } = {}) {
    if (!directory) throw fail("Asset cache requires a local directory.");
    this.directory = path.resolve(directory);
    this.origin = origin ? safeOrigin(origin) : null;
    this.entries = {};
    this.queue = Promise.resolve();
    this.fetchImpl = fetchImpl;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(this.directory, "manifest.json"), "utf8"),
      );
      if (value.version !== 1 || !Array.isArray(value.assets))
        throw fail("Invalid static asset cache manifest.", 500);
      for (const item of value.assets) {
        const checked = assetPath(item.path);
        const origin = safeOrigin(item.origin);
        if (
          !/^[\da-f]{64}$/.test(item.sha256) ||
          !types[checked.extension]?.includes(mediaType(item.contentType)) ||
          !Number.isSafeInteger(item.bytes) ||
          item.bytes < 0
        )
          throw fail("Invalid static asset cache metadata.", 500);
        const finalPath = assetPath(item.finalPath ?? item.path).key;
        let fallback;
        if (item.fallback !== undefined) {
          const value = item.fallback;
          if (
            item.path !== crmFontTarget ||
            item.finalPath !== crmFontSource ||
            item.sourceOrigin !== platformCdn ||
            value?.kind !== "microsoft-public-cdn-font" ||
            value?.sourcePath !== crmFontSource ||
            value?.cssFamily !== "CRMMDL2" ||
            value?.fontFamily !== "CRM MDL2 Assets" ||
            value?.postScriptName !== "CRMMDL2Assets" ||
            !Array.isArray(value.requiredCodepoints) ||
            value.requiredCodepoints.length > 256 ||
            value.requiredCodepoints.some(
              (codepoint) =>
                !Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff,
            )
          )
            throw fail("Invalid Microsoft CRM font fallback provenance.", 500, "ASSET_FONT_PROVENANCE");
          fallback = {
            kind: value.kind,
            sourcePath: value.sourcePath,
            cssFamily: value.cssFamily,
            fontFamily: value.fontFamily,
            postScriptName: value.postScriptName,
            requiredCodepoints: [...value.requiredCodepoints],
          };
        }
        const aspNetObservation = isAspNetResourcePath(item.path)
          ? checkedAspNetObservation(item.aspNetObservation)
          : null;
        if (
          aspNetObservation &&
          (finalPath !== checked.key ||
            (item.sourceOrigin && item.sourceOrigin !== origin))
        )
          throw fail(
            "Invalid ASP.NET resource provenance.",
            500,
            "ASSET_AXD_OBSERVATION",
          );
        if (
          item.sourceOrigin &&
          item.sourceOrigin !== origin &&
          item.sourceOrigin !== platformCdn &&
          !(
            [
              "https://res-1.cdn.office.net",
              "https://res.cdn.office.net",
            ].includes(item.sourceOrigin) &&
            item.path.startsWith(
              officeFontPrefix + new URL(item.sourceOrigin).hostname + "/",
            ) &&
            officeFontPath(
              item.sourceOrigin +
                item.path.slice(
                  (officeFontPrefix + new URL(item.sourceOrigin).hostname)
                    .length,
                ),
            ) === item.path
          )
        )
          throw fail("Invalid asset source origin.", 500);
        this.entries[hash(origin + checked.key)] = {
          path: checked.key,
          origin,
          finalPath,
          ...(item.sourceOrigin ? { sourceOrigin: item.sourceOrigin } : {}),
          ...(fallback ? { fallback } : {}),
          contentType: mediaType(item.contentType),
          bytes: item.bytes,
          sha256: item.sha256,
          capturedAt: item.capturedAt,
          ...(aspNetObservation ? { aspNetObservation } : {}),
          ...(item.observedEmpty === true
            ? {
                observedEmpty: true,
                contentTypeInferred: item.contentTypeInferred === true,
                diagnostic: "ASSET_OBSERVED_EMPTY",
              }
            : {}),
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }
  manifest() {
    return {
      version: 1,
      assets: Object.values(this.entries).map((item) => structuredClone(item)),
    };
  }
  async save() {
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    await fs.writeFile(
      temporary,
      JSON.stringify(this.manifest(), null, 2) + "\n",
    );
    await fs.rename(temporary, path.join(this.directory, "manifest.json"));
  }
  async capture(paths, bridge, { observedAspNetScripts } = {}) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 100)
      throw fail("Provide between 1 and 100 static asset paths.");
    const origin = safeOrigin(bridge?.origin);
    if (this.origin && origin !== this.origin)
      throw fail(
        "Connected portal origin differs from the asset cache origin.",
      );
    const run = this.queue.then(async () => {
      const captured = [],
        failures = [];
      for (const value of [...new Set(paths)]) {
        try {
          const requested = assetPath(value);
          const aspNet = isAspNetResourcePath(value);
          const aspNetObservation = aspNet
            ? checkedAspNetObservation(observedAspNetScripts)
            : null;
          if (
            aspNet &&
            (!observedAspNetScripts.paths?.includes(requested.key) ||
              (bridge.sourceOrigin && bridge.sourceOrigin !== origin))
          )
            throw fail(
              "ASP.NET resource was not observed as a same-origin native script.",
              400,
              "ASSET_AXD_OBSERVATION",
            );
          let target = requested.key,
            response,
            redirects = 0;
          while (true) {
            if (bridge.origin !== origin)
              throw fail("Portal origin changed during capture.");
            response = await bridge.request(target, { method: "GET" });
            if (response.status >= 300 && response.status < 400) {
              if (++redirects > 5)
                throw fail(
                  "Static asset redirect limit exceeded.",
                  502,
                  "ASSET_REDIRECT",
                );
              const location = response.headers?.location;
              if (!location)
                throw fail(
                  "Static asset redirect has no location.",
                  502,
                  "ASSET_REDIRECT",
                );
              let next;
              try {
                next = new URL(location, origin + target);
              } catch {
                throw fail(
                  "Static asset redirect is invalid.",
                  502,
                  "ASSET_REDIRECT",
                );
              }
              if (
                next.origin !== origin ||
                next.username ||
                next.password ||
                next.hash
              )
                throw fail(
                  "Static asset redirect escaped its portal origin.",
                  400,
                  "ASSET_REDIRECT",
                );
              target = assetPath(next.pathname + next.search).key;
              if (aspNet && target !== requested.key)
                throw fail(
                  "Opaque ASP.NET resource redirects cannot change the observed URL.",
                  400,
                  "ASSET_REDIRECT",
                );
              continue;
            }
            break;
          }
          if (response.status !== 200)
            throw fail(
              `Static asset capture returned HTTP ${response.status}.`,
              response.status >= 400 ? response.status : 502,
              "ASSET_HTTP",
            );
          const bytes = Buffer.from(response.body);
          const observedEmpty =
            !aspNet &&
            bytes.length === 0 &&
            [".js", ".mjs"].includes(requested.extension);
          const inferred =
            observedEmpty &&
            (!response.headers?.["content-type"] ||
              mediaType(response.headers["content-type"]) ===
                "application/octet-stream");
          const contentType = verifyAsset(
            bytes,
            inferred
              ? types[requested.extension][0]
              : response.headers?.["content-type"],
            requested.extension,
            { observedEmpty },
          );
          const sha256 = hash(bytes);
          const entry = {
            origin,
            path: requested.key,
            finalPath: target,
            ...(bridge.sourceOrigin
              ? { sourceOrigin: bridge.sourceOrigin }
              : {}),
            contentType,
            bytes: bytes.length,
            sha256,
            capturedAt: new Date().toISOString(),
            ...(aspNetObservation ? { aspNetObservation } : {}),
            ...(observedEmpty
              ? {
                  observedEmpty: true,
                  contentTypeInferred: inferred,
                  diagnostic: "ASSET_OBSERVED_EMPTY",
                }
              : {}),
          };
          const file = path.join(this.directory, sha256 + ".bin");
          await fs.writeFile(file, bytes);
          this.entries[hash(origin + requested.key)] = entry;
          captured.push(structuredClone(entry));
        } catch (error) {
          failures.push({
            path: failurePath(value),
            code: error.code ?? "ASSET_CAPTURE",
            message:
              error.code === "LIVE_BRIDGE"
                ? error.message
                : error.code?.startsWith("ASSET_")
                  ? error.message
                  : "Static asset capture failed.",
          });
        }
      }
      if (captured.length) await this.save();
      return { captured, failures };
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async captureOfficeFonts(urls, { portalOrigin = this.origin } = {}) {
    if (!Array.isArray(urls) || urls.length > 200)
      throw fail("Provide up to 200 observed Office font URLs.");
    const captured = [],
      failures = [];
    for (const value of [...new Set(urls)]) {
      const key = officeFontPath(value),
        source = new URL(value);
      const bridge = {
        origin: safeOrigin(portalOrigin),
        sourceOrigin: source.origin,
        request: async (requested) => {
          if (requested !== key)
            throw fail("Office font capture escaped its observed path.");
          const response = await this.fetchImpl(source.href, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers: { accept: "*/*" },
            signal: AbortSignal.timeout(30000),
          });
          if (
            (response.status >= 300 && response.status < 400) ||
            (response.url && response.url !== source.href)
          )
            throw fail(
              "Office font redirects are not followed.",
              400,
              "ASSET_REDIRECT",
            );
          return {
            status: response.status,
            headers: {
              "content-type": response.headers.get("content-type") ?? "",
            },
            body: Buffer.from(await response.arrayBuffer()),
          };
        },
      };
      const report = await this.capture([key], bridge);
      captured.push(...report.captured);
      failures.push(...report.failures);
    }
    return { captured, failures };
  }
  async capturePublic(
    paths,
    { portalOrigin = this.origin, recursive = true } = {},
  ) {
    const origin = safeOrigin(portalOrigin);
    for (const value of paths ?? [])
      if (!assetPath(value).key.startsWith("/resource/powerappsportal/"))
        throw fail(
          "Public capture is confined to Microsoft Power Pages static platform resources.",
        );
    const request = async (pathname) => {
      const requested = assetPath(pathname);
      if (!requested.key.startsWith("/resource/powerappsportal/"))
        throw fail(
          "Public capture escaped the Power Pages resource prefix.",
          400,
          "ASSET_REDIRECT",
        );
      let response;
      try {
        response = await this.fetchImpl(platformCdn + requested.key, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: { accept: "*/*" },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw fail(
          "Public Power Pages static asset request failed or timed out.",
          502,
          "ASSET_HTTP",
        );
      }
      const headers = {
        "content-type": response.headers.get("content-type") ?? "",
      };
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        let target;
        try {
          target = new URL(location, platformCdn + requested.key);
        } catch {
          throw fail(
            "Public static asset redirect is invalid.",
            502,
            "ASSET_REDIRECT",
          );
        }
        if (
          target.origin !== platformCdn ||
          target.username ||
          target.password ||
          target.hash
        )
          throw fail(
            "Public static asset redirect escaped Microsoft platform CDN.",
            400,
            "ASSET_REDIRECT",
          );
        headers.location = assetPath(target.pathname + target.search).key;
      }
      if (response.url && new URL(response.url).origin !== platformCdn)
        throw fail(
          "Public static response escaped Microsoft platform CDN.",
          400,
          "ASSET_REDIRECT",
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers, body: bytes };
    };
    const bridge = { origin, sourceOrigin: platformCdn, request };
    const captured = [],
      failures = [];
    const seen = new Set();
    let pending = [...new Set(paths)];
    while (pending.length) {
      if (seen.size + pending.length > 200)
        throw fail(
          "Public static dependency capture exceeds 200 assets.",
          413,
          "ASSET_DEPENDENCY_LIMIT",
        );
      for (const value of pending) seen.add(value);
      const result = await this.capture(pending, bridge);
      captured.push(...result.captured);
      failures.push(...result.failures);
      const next = [];
      if (recursive)
        for (const item of result.captured.filter(
          (item) => item.contentType === "text/css",
        )) {
          const cached = await this.get(item.path, { origin });
          const css = cached.body.toString("utf8");
          const values = [
            ...[
              ...css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi),
            ].map((m) => (m[2] ?? m[3]).trim()),
            ...[...css.matchAll(/@import\s+(["'])(.*?)\1/gi)].map((m) => m[2]),
          ];
          for (const value of values) {
            if (!value || value.startsWith("data:") || value.startsWith("#"))
              continue;
            try {
              const target = new URL(value, platformCdn + item.finalPath);
              if (
                target.origin !== platformCdn ||
                !target.pathname.startsWith("/resource/powerappsportal/")
              )
                throw fail(
                  "CSS dependency is outside the allowed Microsoft platform CDN prefix.",
                  400,
                  "ASSET_DEPENDENCY_ORIGIN",
                );
              target.hash = "";
              const key = assetPath(target.pathname + target.search).key;
              if (!seen.has(key) && !next.includes(key)) next.push(key);
            } catch (error) {
              failures.push({
                path: item.path,
                code: error.code ?? "ASSET_DEPENDENCY",
                message: error.code?.startsWith("ASSET_")
                  ? error.message
                  : "CSS dependency could not be captured.",
              });
            }
          }
        }
      pending = next;
    }
    return { captured, failures };
  }
  /**
   * Capture the published Microsoft CRM MDL2 font and map it to the one
   * observed native portal URL that currently returns 404. This is an
   * explicit deterministic local fallback, not a claim of native byte parity.
   */
  async capturePublicAlias(
    { sourcePath, targetPath, requiredCodepoints = [] } = {},
    { portalOrigin = this.origin } = {},
  ) {
    if (sourcePath !== crmFontSource || targetPath !== crmFontTarget)
      throw fail("Only the observed CRM MDL2 native font path can use a public fallback.", 400, "ASSET_FONT_ALIAS");
    if (
      !Array.isArray(requiredCodepoints) ||
      requiredCodepoints.length > 256 ||
      requiredCodepoints.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 0x10ffff,
      )
    )
      throw fail("CRM font glyph requirements must be bounded Unicode codepoints.", 400, "ASSET_FONT_GLYPH_COVERAGE");
    const origin = safeOrigin(portalOrigin), report = await this.capturePublic(
      [sourcePath],
      { portalOrigin: origin, recursive: false },
    );
    if (report.failures.length) return report;
    const capturedSource = report.captured[0];
    try {
      const bytes = await fs.readFile(path.join(this.directory, capturedSource.sha256 + ".bin"));
      const metadata = crmFontMetadata(bytes, requiredCodepoints),
        fallback = {
          kind: "microsoft-public-cdn-font",
          sourcePath,
          ...metadata,
        };
      const alias = {
        ...capturedSource,
        path: targetPath,
        finalPath: sourcePath,
        sourceOrigin: platformCdn,
        fallback,
      };
      this.entries[hash(origin + targetPath)] = alias;
      await this.save();
      report.captured.push(structuredClone(alias));
      return report;
    } catch (error) {
      report.failures.push({
        path: sourcePath,
        code: error.code ?? "ASSET_FONT_FORMAT",
        message: error.code?.startsWith("ASSET_") ? error.message : "Microsoft CRM font metadata could not be verified.",
      });
      return report;
    }
  }
  async get(value, { origin = this.origin } = {}) {
    validateLivePath(value);
    if (!origin) return null;
    const parsed = new URL(value, "https://local.invalid");
    if (
      !isResourceManagerPath(parsed.pathname) &&
      !isPcfWebResourcePath(parsed.pathname) &&
      !/\.axd$/i.test(parsed.pathname) &&
      !types[path.posix.extname(parsed.pathname).toLowerCase()]
    )
      return null;
    const requested = assetPath(value);
    let entry = this.entries[hash(safeOrigin(origin) + requested.key)];
    if (!entry && parsed.searchParams.has("_")) {
      const values = parsed.searchParams.getAll("_");
      if (values.length === 1 && /^\d{1,30}$/.test(values[0])) {
        const stable = new URL(parsed.href);
        stable.searchParams.delete("_");
        entry =
          this.entries[
            hash(safeOrigin(origin) + stable.pathname + stable.search)
          ];
      }
    }
    if (!entry) return null;
    const file = path.join(this.directory, entry.sha256 + ".bin");
    let bytes;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (hash(bytes) !== entry.sha256)
      throw fail(
        "Cached static asset failed its integrity check.",
        500,
        "ASSET_INTEGRITY",
      );
    verifyAsset(bytes, entry.contentType, requested.extension, {
      observedEmpty: entry.observedEmpty === true,
    });
    return {
      status: 200,
      headers: {
        "content-type": entry.contentType,
        "cache-control": "no-cache",
        "x-sim-asset-sha256": entry.sha256,
        ...(entry.fallback
          ? { "x-sim-asset-fallback": entry.fallback.kind }
          : {}),
      },
      body: bytes,
    };
  }
  async clear() {
    const run = this.queue.then(async () => {
      this.entries = {};
      await this.save();
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
