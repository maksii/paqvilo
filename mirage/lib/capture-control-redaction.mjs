import { createHash } from "node:crypto";
const TOKEN_FIELD = "base64secureconfiguration";
/** Exact server-issued signed control field only; unrelated base64 assets remain byte-for-byte. */
export function redactSecureConfigurationTokens(text) {
  return String(text ?? "")
    .replace(
      /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*")/g,
      (raw, key, separator) => {
        try {
          return JSON.parse(key).toLowerCase() === TOKEN_FIELD
            ? key + separator + '"{token}"'
            : raw;
        } catch {
          return raw;
        }
      },
    )
    .replace(
      /((?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;)base64SecureConfiguration(?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;)\s*:\s*(?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;))(?:[A-Za-z0-9+/_=%.-]|\\(?:[/\\]|u[0-9a-f]{4}))+/gi,
      "$1{token}",
    )
    .replace(
      /(\bbase64SecureConfiguration\s*:\s*\\{0,2}["'])(?:[A-Za-z0-9+/_=%.-]|\\(?:[/\\]|u[0-9a-f]{4}))+/gi,
      "$1{token}",
    )
    .replace(/((?:^|[?&])base64SecureConfiguration=)[^&\s]*/gi, "$1{token}")
    .replace(
      /(\bname=["']base64SecureConfiguration["']\r?\n(?:[^\r\n]+\r?\n)*\r?\n)[^\r\n]*/gi,
      "$1{token}",
    )
    .replace(/<input\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag) => {
      const attrs = [
        ...tag.matchAll(
          /\s+(name|value)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi,
        ),
      ];
      if (
        !attrs.some(
          (m) =>
            m[1].toLowerCase() === "name" &&
            (m[2] ?? m[3] ?? m[4]).toLowerCase() === TOKEN_FIELD,
        )
      )
        return tag;
      return tag.replace(
        /(\s+value\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'<>`]+)/gi,
        (raw, prefix) => prefix + '"{token}"',
      );
    });
}
export function redactCapabilityEvidence(value) {
  if (typeof value === "string") return redactSecureConfigurationTokens(value);
  if (Array.isArray(value)) return value.map(redactCapabilityEvidence);
  if (value && typeof value === "object") {
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key.toLowerCase() === TOKEN_FIELD
          ? "{token}"
          : key === "screenshot" || key === "bodyHashInput"
            ? item
            : redactCapabilityEvidence(item),
      ]),
    );
    if (typeof value.body === "string" && result.body !== value.body) {
      delete result.bodyHashInput;
      result.bodyHashProvenance = "redacted-text-sha256";
      if (Object.hasOwn(value, "bodySha256"))
        result.bodySha256 = createHash("sha256")
          .update(result.body)
          .digest("hex");
    }
    return result;
  }
  return value;
}

export function redactCapabilityDiffEvidence(value) {
  const sanitized = redactCapabilityEvidence(value);
  function visit(item) {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    const result = Object.fromEntries(
      Object.entries(item).map(([key, v]) => [key, visit(v)]),
    );
    if (
      typeof item.field === "string" &&
      /(?:^|[./])base64SecureConfiguration$/i.test(item.field)
    ) {
      for (const key of ["live", "mirage"])
        if (typeof item[key] === "string") result[key] = "{token}";
    }
    return result;
  }
  return visit(sanitized);
}

const LIMIT = 4 * 1024 * 1024;
const LAYOUT_ATTRIBUTE = "data-view-layouts";
const jsonObject = (text) => {
  const value = JSON.parse(text);
  return value !== null && typeof value === "object";
};

/** Only the server's declared layout envelope is decoded; arbitrary base64 payloads are never inspected. */
export function redactLayoutAttributeValue(attribute, value) {
  if (
    String(attribute).toLowerCase() !== LAYOUT_ATTRIBUTE ||
    typeof value !== "string" ||
    !value
  )
    return value;
  if (value.length > LIMIT)
    throw new Error("Capture layout exceeds the redaction size bound.");
  if (/^\s*[\[{]/.test(value)) {
    if (!jsonObject(value))
      throw new Error("Capture layout is not a structured JSON value.");
    return redactSecureConfigurationTokens(value);
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value))
    throw new Error("Capture layout has an invalid base64 envelope.");
  const canonical = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .replace(/=+$/, "");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== canonical)
    throw new Error("Capture layout has a noncanonical base64 envelope.");
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Capture layout is not UTF-8 JSON.");
  }
  try {
    if (!jsonObject(decoded)) throw new Error();
  } catch {
    throw new Error("Capture layout is not structured JSON.");
  }
  const redacted = redactSecureConfigurationTokens(decoded);
  if (redacted === decoded) return value;
  let encoded = Buffer.from(redacted, "utf8").toString(
    /[-_]/.test(value) ? "base64url" : "base64",
  );
  if (!value.endsWith("=")) encoded = encoded.replace(/=+$/, "");
  else while (encoded.length % 4) encoded += "=";
  return encoded;
}

/** HTML bodies may be nested in escaped JSON strings or carry entity-quoted attributes. */
export function redactEncodedLayoutTokens(text) {
  return String(text ?? "")
    .replace(
      /((?<![\w:-])data-view-layouts\s*=\s*)((?:\\{0,2}["'])|&quot;|&#0*34;|&#x0*22;)([\s\S]*?)\2/gi,
      (_match, prefix, quote, value) =>
        prefix +
        quote +
        redactLayoutAttributeValue(LAYOUT_ATTRIBUTE, value) +
        quote,
    )
    .replace(
      /((?<![\w:-])data-view-layouts\s*=\s*)([^\s"'`<>&\\]+)(?=[\s>])/gi,
      (_match, prefix, value) =>
        prefix + redactLayoutAttributeValue(LAYOUT_ATTRIBUTE, value),
    );
}

/** Element inventories also store layout values directly under an exact attribute-map key. */
export function redactEncodedLayoutEvidence(value) {
  if (typeof value === "string") return redactEncodedLayoutTokens(value);
  if (Array.isArray(value)) return value.map(redactEncodedLayoutEvidence);
  if (value && typeof value === "object") {
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key.toLowerCase() === LAYOUT_ATTRIBUTE
          ? redactLayoutAttributeValue(key, item)
          : key === "screenshot" || key === "bodyHashInput"
            ? item
            : redactEncodedLayoutEvidence(item),
      ]),
    );
    if (
      typeof value.field === "string" &&
      /(?:^|[./])data-view-layouts$/i.test(value.field)
    ) {
      for (const key of ["live", "mirage"])
        if (typeof value[key] === "string")
          result[key] = redactLayoutAttributeValue(
            LAYOUT_ATTRIBUTE,
            value[key],
          );
    }
    if (typeof value.body === "string" && result.body !== value.body) {
      delete result.bodyHashInput;
      result.bodyHashProvenance = "redacted-text-sha256";
      if (Object.hasOwn(value, "bodySha256"))
        result.bodySha256 = createHash("sha256")
          .update(result.body)
          .digest("hex");
    }
    return result;
  }
  return value;
}

/** Scrub signed control tokens before capture serialization, including declared layout envelopes. */
export const redactCaptureControlEvidence = (value) =>
  redactEncodedLayoutEvidence(redactCapabilityEvidence(value));
export const redactCaptureControlText = (text) =>
  redactEncodedLayoutTokens(redactSecureConfigurationTokens(text));
