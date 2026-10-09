import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateLivePath } from "./live.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const prefix = "/__sim-static/observed-stylesheets/";
const fail = (code, message) =>
  Object.assign(new Error(message), { code, status: 422 });
async function sourceBytes(portal, resource) {
  const root = await fs.realpath(portal.sourceDir),
    file = await fs.realpath(resource.file),
    relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw fail(
      "OBSERVED_STYLESHEET_SOURCE_ESCAPE",
      "Stylesheet source escaped the imported portal export.",
    );
  if (!resource.url?.endsWith(".css") || !file.toLowerCase().endsWith(".css"))
    throw fail(
      "OBSERVED_STYLESHEET_TYPE",
      "Only mapped static CSS files can have a stylesheet observation.",
    );
  return {
    bytes: await fs.readFile(file),
    relative: relative.replaceAll("\\", "/"),
  };
}
/** Explicit static stylesheet observations; this never captures templates or executable scripts. */
export async function captureObservedStylesheets(
  cache,
  live,
  { portal, paths } = {},
) {
  if (!cache || !live?.origin || !live.context || cache.origin !== live.origin)
    throw fail(
      "OBSERVED_STYLESHEET_DISCONNECTED",
      "Stylesheet observation requires the matching connected portal and cache.",
    );
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 32 ||
    paths.some((p) => typeof p !== "string")
  )
    throw fail(
      "OBSERVED_STYLESHEET_PATHS",
      "Select one to 32 mapped stylesheet paths.",
    );
  const baselines = [],
    captured = [],
    failures = [],
    diagnostics = [];
  for (const requested of [...new Set(paths)])
    try {
      validateLivePath(requested);
      if (/[?#]/.test(requested))
        throw fail(
          "OBSERVED_STYLESHEET_PATH",
          "Observed stylesheet paths cannot contain queries or fragments.",
        );
      const resources = portal.webFiles.filter(
        (file) => file.url === requested,
      );
      if (resources.length !== 1)
        throw fail(
          "OBSERVED_STYLESHEET_MAPPING",
          "The path must resolve to one exported stylesheet.",
        );
      const resource = resources[0],
        source = await sourceBytes(portal, resource),
        sourceSha256 = hash(source.bytes),
        cachePath =
          prefix +
          hash(live.origin + "\n" + resource.url + "\n" + sourceSha256) +
          ".css";
      let observedMime;
      const bridge = {
        origin: live.origin,
        request: async (p) => {
          if (p !== cachePath)
            throw fail(
              "OBSERVED_STYLESHEET_CAPTURE_ESCAPE",
              "Stylesheet capture escaped its exact mapped path.",
            );
          const response = await live.request(requested, { method: "GET" });
          observedMime = response.headers?.["content-type"] ?? "";
          if (response.status !== 200)
            throw fail(
              "OBSERVED_STYLESHEET_HTTP",
              "Native stylesheet did not return HTTP 200.",
            );
          if (!/^text\/css(?:;|$)/i.test(observedMime))
            throw fail(
              "OBSERVED_STYLESHEET_MIME",
              "Native stylesheet response must use CSS MIME.",
            );
          return { ...response, headers: { "content-type": observedMime } };
        },
      };
      const report = await cache.capture([cachePath], bridge);
      captured.push(...report.captured);
      if (report.failures.length) {
        failures.push(
          ...report.failures.map((item) => ({ ...item, path: requested })),
        );
        continue;
      }
      const asset = await cache.get(cachePath, { origin: live.origin });
      if (!asset)
        throw fail(
          "OBSERVED_STYLESHEET_CACHE",
          "Captured stylesheet is unavailable.",
        );
      const baseline = {
        version: 1,
        kind: "observed-stylesheet",
        path: resource.url,
        sourceFile: source.relative,
        sourceSha256,
        sha256: hash(asset.body),
        cachePath,
        origin: live.origin,
        contentType: observedMime,
        bytes: asset.body.length,
        capturedAt: new Date().toISOString(),
      };
      baselines.push(baseline);
      if (baseline.sha256 !== sourceSha256)
        diagnostics.push({
          code: "OBSERVED_STYLESHEET_VERSION_DIFFERENCE",
          path: resource.url,
          sourceSha256,
          observedSha256: baseline.sha256,
          message:
            "Observed native stylesheet bytes differ from exported source. This is a deployment observation, not deployed commit identification.",
        });
    } catch (error) {
      failures.push({
        path: requested,
        code: error.code ?? "OBSERVED_STYLESHEET_CAPTURE",
        message: error.code ? error.message : "Stylesheet observation failed.",
      });
    }
  return {
    baselines,
    captured,
    failures,
    diagnostics,
    complete: failures.length === 0,
  };
}
/** Edited source wins. Captured bytes require exact source, cache, origin and MIME checks. */
export async function resolveObservedStylesheet(
  portal,
  resource,
  baselines,
  { cache, origin } = {},
) {
  if (!resource.url?.endsWith(".css")) return { state: "source" };
  const diagnostic = (code, message, state) => ({
    state,
    diagnostic: { code, message, path: resource.url },
  });
  if (baselines !== undefined && !Array.isArray(baselines))
    return diagnostic(
      "OBSERVED_STYLESHEET_PROFILE_INVALID",
      "Stylesheet observations must be an array; editable source remains active.",
      "invalid",
    );
  const entries = (baselines ?? []).filter(
    (item) => item?.path === resource.url,
  );
  if (!entries.length) return { state: "source" };
  if (entries.length !== 1)
    return diagnostic(
      "OBSERVED_STYLESHEET_AMBIGUOUS",
      "Multiple observations map to this stylesheet; editable source remains active.",
      "ambiguous",
    );
  const baseline = entries[0];
  if (baseline.origin !== origin || cache?.origin !== origin)
    return diagnostic(
      "OBSERVED_STYLESHEET_ORIGIN_CHANGED",
      "Stylesheet observation belongs to a different portal origin; editable source remains active.",
      "origin-changed",
    );
  const source = await sourceBytes(portal, resource);
  if (hash(source.bytes) !== baseline.sourceSha256)
    return diagnostic(
      "OBSERVED_STYLESHEET_SOURCE_CHANGED",
      "Stylesheet observation is stale after a source edit; edited local bytes are active.",
      "source-edited",
    );
  if (
    baseline.version !== 1 ||
    baseline.kind !== "observed-stylesheet" ||
    baseline.sourceFile !== source.relative ||
    !new RegExp("^" + prefix + "[a-f\\d]{64}\\.css$").test(
      baseline.cachePath ?? "",
    ) ||
    !/^[a-f\d]{64}$/.test(baseline.sha256 ?? "") ||
    !/^text\/css(?:;\s*charset=[\w-]+)?$/i.test(baseline.contentType ?? "")
  )
    return diagnostic(
      "OBSERVED_STYLESHEET_PROFILE_INVALID",
      "Stylesheet observation has invalid provenance; editable source remains active.",
      "invalid",
    );
  let asset;
  try {
    asset = await cache.get(baseline.cachePath, { origin });
  } catch {
    return diagnostic(
      "OBSERVED_STYLESHEET_CACHE_CHANGED",
      "Captured stylesheet failed its integrity check; editable source remains active.",
      "cache-unavailable",
    );
  }
  if (
    !asset ||
    !/^text\/css(?:;|$)/i.test(asset.headers?.["content-type"] ?? "") ||
    hash(asset.body) !== baseline.sha256 ||
    asset.body.length !== baseline.bytes
  )
    return diagnostic(
      "OBSERVED_STYLESHEET_CACHE_CHANGED",
      "Captured stylesheet is missing or changed; editable source remains active.",
      "cache-unavailable",
    );
  return {
    state: "observed",
    body: asset.body,
    baseline,
    contentType: baseline.contentType,
  };
}
