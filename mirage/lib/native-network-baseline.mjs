import { createHash } from "node:crypto";
import { sourceFingerprint } from "./evidence.mjs";
import { resolveRichTextConfiguration } from "./richtext-config.mjs";

const fontPath = "/uclient/resources/styles/CRMMDL2.woff";
const skinPath =
  "/webresources/msdyn_/RichTextEditorControl/libs/ckeditor_latest/skins/superowa/editor.css";
const sha = /^[a-f\d]{64}$/;
const hash = (body) => createHash("sha256").update(body).digest("hex");
const bindings = new WeakMap();
const diagnostic = (code, message) => ({ code, message });
const declaresFont = (body) =>
  /url\(\s*['"]?\/uclient\/resources\/styles\/CRMMDL2\.woff['"]?\s*\)/i.test(
    body.toString("utf8"),
  );
const exactPath = (value, localOrigin) =>
  value === fontPath ||
  (typeof value === "string" && value === localOrigin + fontPath);

/** Validate an explicit observation against currently active local bytes, not a guessed deployment. */
export async function validateNativeNetworkBaseline(options) {
  const { report, portal, cache, localOrigin } = options ?? {},
    diagnostics = [];
  const result = { valid: false, diagnostics, observation: null };
  bindings.set(result, options);
  const fail = (code, message) => {
    diagnostics.push(diagnostic(code, message));
    return result;
  };
  try {
    if (
      !report ||
      report.version !== 1 ||
      report.fingerprintKind !== "export-file-bytes" ||
      report.sourceUnchanged !== true ||
      !sha.test(report.sourceFingerprint ?? "") ||
      report.sourceFingerprintAfter !== report.sourceFingerprint ||
      !Number.isFinite(Date.parse(report.observedAt)) ||
      report.errors?.length ||
      !Array.isArray(report.errors)
    )
      return fail(
        "NATIVE_BASELINE_INVALID",
        "Native observation schema, stable source fingerprint, time, or clean page-error evidence is invalid.",
      );
    const origin = new URL(report.origin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== report.origin ||
      cache?.origin !== report.origin ||
      !localOrigin ||
      new URL(localOrigin).origin !== localOrigin
    )
      return fail(
        "NATIVE_BASELINE_ORIGIN",
        "Native/cache/local origins do not match the explicitly configured observation.",
      );
    if (
      !portal?.sourceDir ||
      (await sourceFingerprint(portal.sourceDir)) !== report.sourceFingerprint
    )
      return fail(
        "NATIVE_BASELINE_SOURCE_CHANGED",
        "The portal export no longer matches the observed source fingerprint.",
      );
    if (
      !Array.isArray(report.fontResponses) ||
      !report.fontResponses.length ||
      report.fontResponses.length > 100 ||
      report.fontResponses.some(
        (item) =>
          item.path !== fontPath ||
          item.method !== "GET" ||
          item.status !== 404,
      )
    )
      return fail(
        "NATIVE_BASELINE_HTTP",
        "Only explicit native static font GET/404 responses can establish this baseline.",
      );
    const config = report.configuration;
    if (
      !config ||
      !sha.test(config.sha256 ?? "") ||
      !sha.test(config.sourceSha256 ?? "") ||
      !/^\/_webresource\/[A-Za-z0-9_]+\.js$/.test(config.observedPath ?? "")
    )
      return fail(
        "NATIVE_BASELINE_CONFIG_INVALID",
        "The native static configuration provenance is invalid.",
      );
    const configured =
      typeof options.activeConfigurations === "function"
        ? await options.activeConfigurations()
        : options.activeConfigurations;
    if (!Array.isArray(configured))
      return fail(
        "NATIVE_BASELINE_CONFIG_INACTIVE",
        "No active source-bound rich-text JSON configuration is supplied.",
      );
    const matches = configured.filter(
      (item) =>
        item?.origin === report.origin &&
        item.observedPath === config.observedPath &&
        item.sha256 === config.sha256 &&
        item.sourceSha256 === config.sourceSha256,
    );
    if (matches.length !== 1)
      return fail(
        "NATIVE_BASELINE_CONFIG_INACTIVE",
        "The observed configuration is not uniquely active with the same source/captured hashes.",
      );
    const resource = (portal.webFiles ?? []).find(
      (item) => item.url === matches[0].url,
    );
    if (!resource)
      return fail(
        "NATIVE_BASELINE_CONFIG_INACTIVE",
        "The mapped exported configuration resource is missing.",
      );
    const resolved = await resolveRichTextConfiguration(
      portal,
      resource,
      configured,
      { cache, origin: report.origin },
    );
    if (!resolved.body || hash(resolved.body) !== config.sha256)
      return fail(
        "NATIVE_BASELINE_CONFIG_CHANGED",
        "The active source-bound configuration is stale, changed, or missing cached bytes.",
      );
    if (
      !Array.isArray(report.linkedCSS) ||
      !report.linkedCSS.length ||
      report.linkedCSS.length > 32
    )
      return fail(
        "NATIVE_BASELINE_CSS_INVALID",
        "Observed native stylesheet provenance is missing or unbounded.",
      );
    let declared = 0;
    const seen = new Set();
    for (const item of report.linkedCSS) {
      if (
        seen.has(item.path) ||
        item.status !== 200 ||
        !sha.test(item.sha256 ?? "") ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 1 ||
        typeof item.declaresFont !== "boolean" ||
        !(
          item.path === skinPath ||
          /^\/_pcfwebresource\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
            item.path,
          )
        )
      )
        return fail(
          "NATIVE_BASELINE_CSS_INVALID",
          "Only distinct observed editor/PCF stylesheet hashes can support the font baseline.",
        );
      seen.add(item.path);
      const asset = await cache.get(item.path, { origin: report.origin });
      if (
        !asset ||
        asset.headers?.["content-type"]?.split(";")[0] !== "text/css" ||
        asset.body.length !== item.bytes ||
        hash(asset.body) !== item.sha256 ||
        declaresFont(asset.body) !== item.declaresFont
      )
        return fail(
          "NATIVE_BASELINE_CSS_CHANGED",
          "A linked native stylesheet is missing, changed, or no longer declares the observed font dependency.",
        );
      if (item.declaresFont) declared++;
    }
    if (!declared)
      return fail(
        "NATIVE_BASELINE_CSS_INVALID",
        "No matching observed stylesheet declares the exact font dependency.",
      );
    const nativeCodes = new Set();
    if (
      report.networkFailures !== undefined &&
      !Array.isArray(report.networkFailures)
    )
      return fail(
        "NATIVE_BASELINE_NETWORK_INVALID",
        "Native failed-request evidence must be an array.",
      );
    for (const item of report.networkFailures ?? []) {
      const response = report.fontResponses.find(
        (response) => response.requestKey === item.requestKey,
      );
      if (
        item.path !== fontPath ||
        item.method !== "GET" ||
        item.status !== 404 ||
        item.correlatedResponse !== true ||
        !item.requestKey ||
        !response ||
        item.errorText !== "net::ERR_ABORTED"
      )
        return fail(
          "NATIVE_BASELINE_NETWORK_INVALID",
          "A native failed request lacks exact same-request GET/404 evidence or a supported observed error code.",
        );
      nativeCodes.add(item.errorText);
    }
    result.valid = true;
    result.observation = {
      observedAt: report.observedAt,
      origin: report.origin,
      path: fontPath,
      method: "GET",
      status: 404,
      sourceFingerprint: report.sourceFingerprint,
      configurationSha256: config.sha256,
      stylesheetHashes: report.linkedCSS.map((item) => ({
        path: item.path,
        sha256: item.sha256,
      })),
      networkErrorCodes: [...nativeCodes],
    };
    return result;
  } catch {
    return fail(
      "NATIVE_BASELINE_VALIDATION_FAILED",
      "Native baseline validation could not verify current source, configuration, or cached static bytes.",
    );
  }
}

/** Preserve every raw failure; revalidate bindings immediately before comparing them. */
export async function classifyNativeNetworkFailures(failures, validated) {
  const options = bindings.get(validated),
    validation = options
      ? await validateNativeNetworkBaseline(options)
      : {
          valid: false,
          diagnostics: [
            diagnostic(
              "NATIVE_BASELINE_UNVALIDATED",
              "A module-validated native baseline is required.",
            ),
          ],
        };
  const rawFailures = Array.isArray(failures) ? failures : [],
    expectedNativeFailures = [],
    unexpectedFailures = [];
  for (const failure of rawFailures) {
    let expected =
      validation.valid &&
      failure &&
      failure.method === "GET" &&
      failure.status === 404 &&
      exactPath(failure.path ?? failure.url, options.localOrigin);
    if (expected && failure.kind === "network") {
      const response = failure.correlatedResponse;
      expected =
        typeof failure.requestKey === "string" &&
        failure.requestKey.length > 0 &&
        response &&
        response.requestKey === failure.requestKey &&
        response.method === "GET" &&
        response.status === 404 &&
        exactPath(response.path ?? response.url, options.localOrigin) &&
        validation.observation.networkErrorCodes.includes(
          failure.errorText ?? failure.failure,
        );
    } else
      expected =
        expected &&
        failure.kind === "http" &&
        !failure.failure &&
        !failure.errorText;
    if (expected)
      expectedNativeFailures.push({
        failure,
        classification: "observed-native-static-failure",
        observation: validation.observation,
      });
    else unexpectedFailures.push(failure);
  }
  return {
    rawFailures,
    expectedNativeFailures,
    unexpectedFailures,
    validation,
  };
}
