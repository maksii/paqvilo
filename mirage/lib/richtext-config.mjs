import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { portalField } from "./importer.mjs";
import { validateLivePath } from "./live.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const diagnostic = (code, message) => ({ code, message });
const failure = (code, message) =>
  Object.assign(new Error(message), { code, status: 422 });
const prefix = "/__sim-static/richtext-config/";
const topKeys = new Set([
  "defaultSupportedProps",
  "disableDefaultImageProcessing",
  "disableImages",
  "imageEntity",
  "attachmentEntity",
  "readonly",
  "readOnly",
  "disableFileUploads",
]);

/** This accepts inert configuration JSON, never executable web-resource scripts. */
export function validateRichTextConfiguration(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > 256 * 1024)
    throw failure(
      "RICHTEXT_CONFIG_INVALID",
      "Rich text JSON must be nonempty and bounded to 256 KiB.",
    );
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw failure(
      "RICHTEXT_CONFIG_INVALID",
      "The rich text response must contain JSON only, without script wrappers.",
    );
  }
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    !value.defaultSupportedProps ||
    Array.isArray(value.defaultSupportedProps) ||
    typeof value.defaultSupportedProps !== "object" ||
    Object.keys(value).some((key) => !topKeys.has(key))
  )
    throw failure(
      "RICHTEXT_CONFIG_INVALID",
      "The response is not a supported static rich text configuration object.",
    );
  let nodes = 0;
  const visit = (item, depth = 0) => {
    if (++nodes > 10000 || depth > 12)
      throw failure(
        "RICHTEXT_CONFIG_INVALID",
        "Rich text configuration structure exceeds its bound.",
      );
    if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        if (
          ["__proto__", "prototype", "constructor"].includes(key) ||
          /token|password|secret|authorization|cookie|credential/i.test(key)
        )
          throw failure(
            "RICHTEXT_CONFIG_CREDENTIAL",
            "Rich text configuration cannot contain credential fields.",
          );
        visit(child, depth + 1);
      }
    if (
      typeof item === "string" &&
      (/Bearer\s+\S+/i.test(item) ||
        /^(?:javascript|data:text\/html):/i.test(item) ||
        /[?&](?:access_token|secret|token|password)=/i.test(item))
    )
      throw failure(
        "RICHTEXT_CONFIG_CREDENTIAL",
        "Rich text configuration contains active or credential content.",
      );
  };
  visit(value);
  return value;
}

export function findRichTextResource(portal, configUrl) {
  const basename = String(configUrl ?? "")
    .split("/")
    .at(-1)
    ?.toLowerCase();
  if (!basename) return undefined;
  const matches = (portal.webFiles ?? []).filter(
    (file) =>
      file.name?.toLowerCase() === basename ||
      String(portalField(file.metadata ?? {}, "filename", "")).toLowerCase() ===
        basename ||
      file.url?.split("/").at(-1)?.toLowerCase() === basename,
  );
  if (matches.length > 1)
    throw failure(
      "RICHTEXT_CONFIG_MAPPING_AMBIGUOUS",
      "The configured rich text web resource resolves to multiple exported files.",
    );
  return matches[0];
}

function sourcePath(portal, resource) {
  const relative = path.relative(
    syncFs.realpathSync(portal.sourceDir ?? path.dirname(resource.file)),
    syncFs.realpathSync(resource.file),
  );
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw failure(
      "RICHTEXT_CONFIG_SOURCE_ESCAPE",
      "Rich text source must remain inside the portal export.",
    );
  return relative.replaceAll("\\", "/");
}

/** Capture one mapped static deployment observation; source files are never written. */
export async function captureRichTextConfiguration(
  cache,
  live,
  { portal, resource, configUrl },
) {
  const relative = sourcePath(portal, resource),
    source = await fs.readFile(resource.file);
  validateRichTextConfiguration(source);
  const filename = String(
    portalField(resource.metadata ?? {}, "filename", "") ||
      configUrl?.split("/").at(-1) ||
      resource.name,
  ).toLowerCase();
  if (!/^[\w.-]+\.js$/.test(filename))
    throw failure(
      "RICHTEXT_CONFIG_INVALID",
      "Observed rich text configuration must map to a discovered JSON web-resource filename.",
    );
  const sourceSha256 = hash(source),
    observedPath = "/_webresource/" + filename;
  validateLivePath(observedPath);
  const cachePath = prefix + hash(resource.url + "\n" + sourceSha256) + ".json";
  let observedMime, configuration;
  const bridge = {
    origin: live.origin,
    request: async (requested) => {
      if (requested !== cachePath)
        throw failure(
          "RICHTEXT_CONFIG_CAPTURE_ESCAPE",
          "Rich text capture escaped its exact mapped resource.",
        );
      const response = await live.request(observedPath, { method: "GET" });
      if (response.status !== 200)
        throw failure(
          "RICHTEXT_CONFIG_HTTP",
          "Observed rich text configuration did not return HTTP 200.",
        );
      observedMime = String(response.headers?.["content-type"] ?? "");
      if (
        !/^(?:application\/json|application\/javascript|text\/javascript|application\/x-javascript)(?:;|$)/i.test(
          observedMime,
        )
      )
        throw failure(
          "RICHTEXT_CONFIG_MIME",
          "Observed rich text configuration did not use JSON or JavaScript MIME.",
        );
      configuration = validateRichTextConfiguration(response.body);
      // The dedicated cache namespace serves validated JSON, regardless of the native .js MIME.
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: response.body,
      };
    },
  };
  const report = await cache.capture([cachePath], bridge);
  if (report.failures.length)
    return { captured: report.captured, failures: report.failures };
  const entry = report.captured[0],
    baseline = {
      version: 1,
      kind: "rich-text-json",
      url: resource.url,
      sourceFile: relative,
      sourceSha256,
      sha256: entry.sha256,
      cachePath,
      observedPath,
      origin: live.origin,
      observedContentType: observedMime,
      capturedAt: entry.capturedAt,
    };
  return { baseline, configuration, captured: report.captured, failures: [] };
}

function profileStatus(portal, resource, baseline, origin) {
  if (
    !baseline ||
    baseline.version !== 1 ||
    baseline.kind !== "rich-text-json" ||
    baseline.url !== resource.url ||
    baseline.sourceFile !== sourcePath(portal, resource) ||
    !/^\/[\w/-]+\.json$/.test(baseline.cachePath ?? "") ||
    !baseline.cachePath.startsWith(prefix) ||
    !/^[\da-f]{64}$/.test(baseline.sha256 ?? "")
  )
    return {
      status: "invalid",
      diagnostic: diagnostic(
        "RICHTEXT_CONFIG_BASELINE_INVALID",
        "The observed rich text configuration baseline has invalid mapping or provenance.",
      ),
    };
  if (baseline.origin !== origin)
    return {
      status: "stale",
      diagnostic: diagnostic(
        "RICHTEXT_CONFIG_ORIGIN_CHANGED",
        "Observed rich text configuration belongs to another configured portal origin.",
      ),
    };
  const source = syncFs.readFileSync(resource.file);
  if (hash(source) !== baseline.sourceSha256)
    return {
      status: "stale",
      diagnostic: diagnostic(
        "RICHTEXT_CONFIG_SOURCE_CHANGED",
        "Observed rich text JSON is stale after an exported configuration edit; edited local source wins.",
      ),
    };
  try {
    validateRichTextConfiguration(source);
  } catch {
    return {
      status: "invalid",
      diagnostic: diagnostic(
        "RICHTEXT_CONFIG_BASELINE_INVALID",
        "Observed JSON baselines can bind only exported static rich text JSON, never arbitrary scripts.",
      ),
    };
  }
  return { status: "eligible" };
}

export function richTextConfigurationStatus(portal, baselines = [], origin) {
  if (!Array.isArray(baselines))
    return [
      {
        status: "invalid",
        diagnostic: diagnostic(
          "RICHTEXT_CONFIG_BASELINE_INVALID",
          "Observed rich text configuration baselines must be an array.",
        ),
      },
    ];
  return baselines.map((baseline) => {
    if (!baseline || typeof baseline !== "object")
      return {
        status: "invalid",
        diagnostic: diagnostic(
          "RICHTEXT_CONFIG_BASELINE_INVALID",
          "Observed rich text configuration provenance must be an object.",
        ),
      };
    const resource = (portal.webFiles ?? []).find(
      (file) => file.url === baseline.url,
    );
    try {
      return {
        ...baseline,
        ...(resource
          ? profileStatus(portal, resource, baseline, origin)
          : {
              status: "stale",
              diagnostic: diagnostic(
                "RICHTEXT_CONFIG_SOURCE_MISSING",
                "The observed rich text source resource no longer exists in this export.",
              ),
            }),
      };
    } catch {
      return {
        ...baseline,
        status: "stale",
        diagnostic: diagnostic(
          "RICHTEXT_CONFIG_SOURCE_MISSING",
          "The observed rich text source file is unavailable.",
        ),
      };
    }
  });
}

/** An edited source always takes precedence; only exact validated source-bound bytes are served. */
export async function resolveRichTextConfiguration(
  portal,
  resource,
  baselines,
  { cache, origin },
) {
  if (baselines !== undefined && !Array.isArray(baselines))
    return {
      diagnostic: diagnostic(
        "RICHTEXT_CONFIG_BASELINE_INVALID",
        "Observed rich text configuration baselines must be an array.",
      ),
    };
  const baseline = (baselines ?? []).find(
    (entry) => entry?.url === resource.url,
  );
  if (!baseline) return {};
  let status;
  try {
    status = profileStatus(portal, resource, baseline, origin);
  } catch {
    return {
      diagnostic: diagnostic(
        "RICHTEXT_CONFIG_SOURCE_MISSING",
        "Observed rich text configuration source is unavailable.",
      ),
    };
  }
  if (status.status !== "eligible") return { diagnostic: status.diagnostic };
  try {
    const cached = await cache?.get(baseline.cachePath, {
      origin: baseline.origin,
    });
    if (!cached || hash(cached.body) !== baseline.sha256)
      throw new Error("Captured rich text JSON is missing or changed.");
    validateRichTextConfiguration(cached.body);
    return {
      body: cached.body,
      configuration: JSON.parse(
        cached.body.toString("utf8").replace(/^\uFEFF/, ""),
      ),
      baseline,
    };
  } catch {
    return {
      diagnostic: diagnostic(
        "RICHTEXT_CONFIG_CACHE_INVALID",
        "Captured rich text JSON failed its integrity check; local source wins.",
      ),
    };
  }
}
