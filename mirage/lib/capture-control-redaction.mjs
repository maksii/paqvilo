import { createHash } from "node:crypto";
const TOKEN_FIELD = "base64secureconfiguration";
const isProtectedField = (field) =>
  typeof field === "string" &&
  (field.toLowerCase() === TOKEN_FIELD ||
    field.toLowerCase() === "x-ms-form-session-id" ||
    /(?:^|[$_])attachfile_hiddenfield_instanceid$/i.test(
      field.replace(/%24/gi, "$"),
    ));
/** Scan complete JSON strings once so escaped quotes never become repeated candidate starts. */
function redactJsonControlFields(text) {
  const stringEnd = (start) => {
    let cursor = start + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '"') return cursor + 1;
      cursor++;
    }
    return -1;
  };
  const parts = [];
  let cursor = 0,
    last = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '"') {
      cursor++;
      continue;
    }
    const keyStart = cursor,
      keyEnd = stringEnd(cursor);
    if (keyEnd < 0) break;
    cursor = keyEnd;
    let colon = keyEnd;
    while (/\s/.test(text[colon] ?? "") && colon < text.length) colon++;
    if (text[colon] !== ":") continue;
    let key;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      continue;
    }
    if (!isProtectedField(key)) continue;
    let valueStart = colon + 1;
    while (/\s/.test(text[valueStart] ?? "") && valueStart < text.length)
      valueStart++;
    if (text[valueStart] !== '"') continue;
    const valueEnd = stringEnd(valueStart);
    if (valueEnd < 0)
      throw Error(
        "Capture signed control field has an incomplete JSON string.",
      );
    if (text.slice(valueStart + 1, valueEnd - 1) !== "{token}") {
      parts.push(text.slice(last, valueStart + 1), "{token}");
      last = valueEnd - 1;
    }
    cursor = valueEnd;
  }
  if (!parts.length) return text;
  parts.push(text.slice(last));
  return parts.join("");
}
/** Multipart header lines are visited once; missing blank separators cannot restart a suffix scan. */
function redactMultipartControlFields(text) {
  const parts = [];
  let cursor = 0,
    last = 0,
    pending = false,
    body = false;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? text.length : newline;
    const contentEnd =
      lineEnd > cursor && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    const line = text.slice(cursor, contentEnd);
    if (body) {
      if (line !== "{token}") {
        parts.push(text.slice(last, cursor), "{token}");
        last = contentEnd;
      }
      body = false;
    } else if (pending && !line.length) {
      pending = false;
      body = true;
    } else {
      if (line.includes("\r")) pending = false;
      if (newline >= 0) {
        const marker = line.toLowerCase().lastIndexOf("name=");
        const quoted = marker < 0 ? "" : line.slice(marker + 5);
        if (
          quoted.length >= 2 &&
          ['"', "'"].includes(quoted[0]) &&
          quoted.at(-1) === quoted[0] &&
          isProtectedField(quoted.slice(1, -1))
        )
          pending = true;
      }
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  if (body && cursor === text.length) {
    parts.push(text.slice(last), "{token}");
    last = text.length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(last));
  return parts.join("");
}

/** Attribute offsets advance monotonically, including whitespace before an unrelated boolean attribute. */
function redactHtmlControlInputs(text) {
  return text.replace(/<input\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const attributes = [];
    const limit = tag.length - 1;
    let cursor = 6;
    while (cursor < limit) {
      while (cursor < limit && /\s/.test(tag[cursor])) cursor++;
      if (cursor >= limit) break;
      const nameStart = cursor;
      while (cursor < limit && !/[\s=/>]/.test(tag[cursor])) cursor++;
      if (cursor === nameStart) {
        cursor++;
        continue;
      }
      const name = tag.slice(nameStart, cursor).toLowerCase();
      while (cursor < limit && /\s/.test(tag[cursor])) cursor++;
      if (tag[cursor] !== "=") continue;
      cursor++;
      while (cursor < limit && /\s/.test(tag[cursor])) cursor++;
      const start = cursor;
      let value;
      if (tag[cursor] === '"' || tag[cursor] === "'") {
        const quote = tag[cursor++],
          valueStart = cursor;
        while (cursor < limit && tag[cursor] !== quote) cursor++;
        value = tag.slice(valueStart, cursor);
        if (cursor < limit) cursor++;
      } else {
        const valueStart = cursor;
        while (cursor < limit && !/\s/.test(tag[cursor])) cursor++;
        value = tag.slice(valueStart, cursor);
      }
      attributes.push({ name, value, start, end: cursor });
    }
    if (
      !attributes.some(
        (attribute) =>
          ["name", "id"].includes(attribute.name) &&
          isProtectedField(attribute.value),
      )
    )
      return tag;
    const parts = [];
    let last = 0;
    for (const attribute of attributes)
      if (attribute.name === "value") {
        parts.push(tag.slice(last, attribute.start), '"{token}"');
        last = attribute.end;
      }
    if (!parts.length) return tag;
    parts.push(tag.slice(last));
    return parts.join("");
  });
}

/** Exact server-issued signed control field only; unrelated base64 assets remain byte-for-byte. */
export function redactSecureConfigurationTokens(text) {
  const redacted = redactJsonControlFields(String(text ?? ""))
    .replace(
      /((?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;)(?:base64SecureConfiguration|x-ms-form-session-id|(?:[^"'<>\s]*?(?:\$|%24|_))?AttachFile_HiddenField_InstanceId)(?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;)\s*:\s*(?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;))(?:[A-Za-z0-9+/_=%.-]|\\(?:[/\\]|u[0-9a-f]{4}))+/gi,
      "$1{token}",
    )
    .replace(
      /(\b(?:base64SecureConfiguration|x-ms-form-session-id|AttachFile_HiddenField_InstanceId)\s*:\s*\\{0,2}["'])(?:[A-Za-z0-9+/_=%.-]|\\(?:[/\\]|u[0-9a-f]{4}))+/gi,
      "$1{token}",
    )
    .replace(/(^|[?&])([^=&\s]+)=([^&\s]*)/g, (match, separator, name) =>
      isProtectedField(name) ? separator + name + "={token}" : match,
    );
  return redactHtmlControlInputs(redactMultipartControlFields(redacted));
}
export function redactCapabilityEvidence(value) {
  if (typeof value === "string") return redactSecureConfigurationTokens(value);
  if (Array.isArray(value)) return value.map(redactCapabilityEvidence);
  if (value && typeof value === "object") {
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isProtectedField(key)
          ? "{token}"
          : key === "screenshot" || key === "bodyHashInput"
            ? item
            : redactCapabilityEvidence(item),
      ]),
    );
    if (["name", "id"].some((key) => isProtectedField(value[key]))) {
      if (Object.hasOwn(value, "value")) result.value = "{token}";
      if (Object.hasOwn(value, "defaultValue")) result.defaultValue = "{token}";
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
      isProtectedField(item.field.split(/[./]/).at(-1))
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
