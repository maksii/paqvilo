import { createHash } from 'node:crypto';
const TOKEN_FIELD = 'base64secureconfiguration';
const isProtectedField = (field) =>
  typeof field === 'string' &&
  (field.toLowerCase() === TOKEN_FIELD ||
    field.toLowerCase() === 'x-ms-form-session-id' ||
    /(?:^|[$_])attachfile_hiddenfield_instanceid$/i.test(field.replace(/%24/gi, '$')));
/** Scan complete JSON strings once so escaped quotes never become repeated candidate starts. */
function jsonStringEnd(text, start) {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text[cursor] === '"') return cursor + 1;
    cursor++;
  }
  return -1;
}

function redactJsonCandidate(text, state) {
  const keyStart = state.cursor,
    keyEnd = jsonStringEnd(text, state.cursor);
  if (keyEnd < 0) return false;
  state.cursor = keyEnd;
  let colon = keyEnd;
  while (/\s/.test(text[colon] ?? '') && colon < text.length) colon++;
  if (text[colon] !== ':') return true;
  let key;
  try {
    key = JSON.parse(text.slice(keyStart, keyEnd));
  } catch {
    return true;
  }
  if (!isProtectedField(key)) return true;
  let valueStart = colon + 1;
  while (/\s/.test(text[valueStart] ?? '') && valueStart < text.length) valueStart++;
  if (text[valueStart] !== '"') return true;
  const valueEnd = jsonStringEnd(text, valueStart);
  if (valueEnd < 0) throw new Error('Capture signed control field has an incomplete JSON string.');
  if (text.slice(valueStart + 1, valueEnd - 1) !== '{token}') {
    state.parts.push(text.slice(state.last, valueStart + 1), '{token}');
    state.last = valueEnd - 1;
  }
  state.cursor = valueEnd;
  return true;
}

function redactJsonControlFields(text) {
  const state = { parts: [], cursor: 0, last: 0 };
  while (state.cursor < text.length) {
    if (text[state.cursor] !== '"') {
      state.cursor++;
      continue;
    }
    if (!redactJsonCandidate(text, state)) break;
  }
  if (!state.parts.length) return text;
  state.parts.push(text.slice(state.last));
  return state.parts.join('');
}
/** Multipart header lines are visited once; missing blank separators cannot restart a suffix scan. */
function multipartHeaderIsProtected(line) {
  const marker = line.toLowerCase().lastIndexOf('name=');
  const quoted = marker < 0 ? '' : line.slice(marker + 5);
  return (
    quoted.length >= 2 &&
    ['"', "'"].includes(quoted[0]) &&
    quoted.at(-1) === quoted[0] &&
    isProtectedField(quoted.slice(1, -1))
  );
}

function multipartLineState(text, state, newline, cursor, contentEnd, line) {
  if (state.body) {
    if (line !== '{token}') {
      state.parts.push(text.slice(state.last, cursor), '{token}');
      state.last = contentEnd;
    }
    state.body = false;
  } else if (state.pending && !line.length) {
    state.pending = false;
    state.body = true;
  } else {
    if (line.includes('\r')) state.pending = false;
    if (newline >= 0 && multipartHeaderIsProtected(line)) state.pending = true;
  }
}

function redactMultipartControlFields(text) {
  const state = { parts: [], cursor: 0, last: 0, pending: false, body: false };
  while (state.cursor < text.length) {
    const newline = text.indexOf('\n', state.cursor);
    const lineEnd = newline < 0 ? text.length : newline;
    const contentEnd = lineEnd > state.cursor && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = text.slice(state.cursor, contentEnd);
    multipartLineState(text, state, newline, state.cursor, contentEnd, line);
    if (newline < 0) break;
    state.cursor = newline + 1;
  }
  const { cursor, body, parts } = state;
  let { last } = state;
  if (body && cursor === text.length) {
    parts.push(text.slice(last), '{token}');
    last = text.length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(last));
  return parts.join('');
}

/** Attribute offsets advance monotonically, including whitespace before an unrelated boolean attribute. */
/* NOSONAR */ function inputAttribute(tag, cursor, limit) {
  const nameStart = cursor;
  while (cursor < limit && !/[\s=/>]/.test(tag[cursor])) cursor++;
  if (cursor === nameStart) return { cursor: cursor + 1 };
  const name = tag.slice(nameStart, cursor).toLowerCase();
  while (cursor < limit && /\s/.test(tag[cursor])) cursor++;
  if (tag[cursor] !== '=') return { cursor };
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
  return { cursor, attribute: { name, value, start, end: cursor } };
}

function inputAttributes(tag, limit) {
  const attributes = [];
  let cursor = 6;
  while (cursor < limit) {
    while (cursor < limit && /\s/.test(tag[cursor])) cursor++;
    if (cursor >= limit) break;
    const parsed = inputAttribute(tag, cursor, limit);
    cursor = parsed.cursor;
    if (parsed.attribute) attributes.push(parsed.attribute);
  }
  return attributes;
}

function redactInputValueAttributes(tag, attributes) {
  const parts = [];
  let last = 0;
  for (const attribute of attributes)
    if (attribute.name === 'value') {
      parts.push(tag.slice(last, attribute.start), '"{token}"');
      last = attribute.end;
    }
  if (!parts.length) return tag;
  parts.push(tag.slice(last));
  return parts.join('');
}

function redactHtmlInputTag(tag) {
  const attributes = inputAttributes(tag, tag.length - 1);
  if (!attributes.some((attribute) => ['name', 'id'].includes(attribute.name) && isProtectedField(attribute.value)))
    return tag;
  return redactInputValueAttributes(tag, attributes);
}

function redactHtmlControlInputs(text) {
  return text.replace(/<input\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, redactHtmlInputTag);
}

/** Exact server-issued signed control field only; unrelated base64 assets remain byte-for-byte. */
export function redactSecureConfigurationTokens(text) {
  const redacted = redactJsonControlFields(String(text ?? ''))
    .replace(
      /((?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;)(?:base64SecureConfiguration|x-ms-form-session-id|(?:[^"'<>\s]*?(?:\$|%24|_))?AttachFile_HiddenField_InstanceId)(?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;)\s*:\s*(?:\\{0,2}["']|&quot;|&#0*34;|&#x0*22;))(?:[a-z0-9+/_=%.-]|\\(?:[/\\]|u[0-9a-f]{4}))+/gi, // NOSONAR: regex kept: a rewrite would change matches or captures
      '$1{token}',
    )
    .replace(
      /(\b(?:base64SecureConfiguration|x-ms-form-session-id|AttachFile_HiddenField_InstanceId)\s*:\s*\\{0,2}["'])(?:[a-z0-9+/_=%.-]|\\(?:[/\\]|u[0-9a-f]{4}))+/gi,
      '$1{token}',
    )
    .replace(/(^|[?&])([^=&\s]+)=([^&\s]*)/g, (match, separator, name) /* NOSONAR */ =>
      isProtectedField(name) ? separator + name + '={token}' : match,);
  return redactHtmlControlInputs(redactMultipartControlFields(redacted));
}
function redactCapabilityEvidenceBase(value) {
  if (typeof value === 'string') return redactSecureConfigurationTokens(value);
  if (Array.isArray(value)) return value.map(redactCapabilityEvidenceBase);
  if (value && typeof value === 'object') return redactCapabilityEvidenceObject(value);
  return value;
}

function redactCapabilityEvidenceObject(value) {
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (isProtectedField(key)) return [key, '{token}'];
      if (key === 'screenshot' || key === 'bodyHashInput') return [key, item];
      return [key, redactCapabilityEvidenceBase(item)];
    }),
  );
  if (['name', 'id'].some((key) => isProtectedField(value[key]))) {
    if (Object.hasOwn(value, 'value')) result.value = '{token}';
    if (Object.hasOwn(value, 'defaultValue')) result.defaultValue = '{token}';
  }
  if (typeof value.body === 'string' && result.body !== value.body) {
    delete result.bodyHashInput;
    result.bodyHashProvenance = 'redacted-text-sha256';
    if (Object.hasOwn(value, 'bodySha256')) result.bodySha256 = createHash('sha256').update(result.body).digest('hex');
  }
  return result;
}

const CSP_HEADERS = new Set(['content-security-policy', 'content-security-policy-report-only']);
const cspHeader = (name) => typeof name === 'string' && CSP_HEADERS.has(name.toLowerCase());
function redactCspPolicy(value, collect) {
  return String(value).replace(/('|&apos;|&#0*39;|&#x0*27;)nonce-([a-z0-9+/_=-]+)\1/gi, (_match, quote, nonce) => {
    collect?.(nonce);
    return quote + 'nonce-{token}' + quote;
  });
}
/** Walk HTML tags and attributes once. Only actual nonce attributes and declared CSP meta policies are protected. */
function readHtmlNonceAttribute(text, at) {
  const nameStart = at;
  while (at < text.length && !/[\s=<>/]/.test(text[at])) at++;
  if (at === nameStart) return { at: at + 1 };
  const name = text.slice(nameStart, at).toLowerCase();
  while (/\s/.test(text[at] ?? '')) at++;
  if (text[at] !== '=') return { at };
  at++;
  while (/\s/.test(text[at] ?? '')) at++;
  const quote = ['"', "'"].includes(text[at]) ? text[at++] : '';
  const valueStart = at;
  if (quote) {
    const end = text.indexOf(quote, at);
    if (end < 0) return { at: text.length, incomplete: true };
    at = end;
  } else while (at < text.length && !/[\s<>]/.test(text[at])) at++;
  const attribute = { name, start: valueStart, end: at, value: text.slice(valueStart, at) };
  if (quote) at++;
  return { at, attribute };
}

function readHtmlNonceTag(text, start) {
  let at = start + 1;
  const tagStart = at;
  while (/[A-Za-z0-9:_-]/.test(text[at] ?? '')) at++;
  const tag = text.slice(tagStart, at).toLowerCase(),
    attributes = [];
  let finished = false;
  while (at < text.length) {
    while (/\s/.test(text[at] ?? '')) at++;
    if (text[at] === '>') {
      at++;
      finished = true;
      break;
    }
    if (text[at] === '<') break;
    if (text[at] === '/') {
      at++;
      continue;
    }
    const parsed = readHtmlNonceAttribute(text, at);
    at = parsed.at;
    if (parsed.attribute) attributes.push(parsed.attribute);
    if (parsed.incomplete) break;
  }
  return { tag, attributes, at, finished };
}

function advanceRawHtmlText(text, lower, tag, at) {
  if (!['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(tag))
    return at;
  let close = lower.indexOf('</' + tag, at);
  while (close >= 0 && !/[\s/>]/.test(text[close + tag.length + 2] ?? '>'))
    close = lower.indexOf('</' + tag, close + 2);
  return close < 0 ? text.length : close;
}

function addHtmlNoncePatches(tag, attributes, collect, patches) {
  const metaCsp = tag === 'meta' && attributes.some((a) => a.name === 'http-equiv' && cspHeader(a.value));
  for (const attribute of attributes) {
    if (attribute.name === 'nonce') collect?.(attribute.value);
    let value = attribute.value;
    if (attribute.name === 'nonce') value = '{token}';
    else if (metaCsp && attribute.name === 'content') value = redactCspPolicy(attribute.value, collect);
    if (value !== attribute.value) patches.push({ start: attribute.start, end: attribute.end, value });
  }
}

function redactHtmlNonceAttributes(text, collect) {
  const patches = [],
    lower = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start < 0) break;
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (!/[A-Za-z]/.test(text[start + 1] ?? '')) {
      cursor = start + 1;
      continue;
    }
    const parsed = readHtmlNonceTag(text, start);
    cursor = Math.max(start + 1, parsed.at);
    if (!parsed.finished) continue;
    cursor = advanceRawHtmlText(text, lower, parsed.tag, parsed.at);
    addHtmlNoncePatches(parsed.tag, parsed.attributes, collect, patches);
  }
  if (!patches.length) return text;
  let result = '',
    last = 0;
  for (const patch of patches) {
    result += text.slice(last, patch.start) + patch.value;
    last = patch.end;
  }
  return result + text.slice(last);
}
function jsonStringSpan(text, start) {
  let end = start + 1;
  while (end < text.length) {
    if (text[end] === '\\') {
      end += 2;
      continue;
    }
    if (text[end++] === '"') {
      try {
        return { end, value: JSON.parse(text.slice(start, end)) };
      } catch {
        return { end };
      }
    }
  }
  return null;
}
/** Decode complete JSON strings once so escaped HTML and explicitly named policy headers are covered. */
/* NOSONAR */ function redactCspJsonCandidate(text, state, depth, collect) {
  const start = state.cursor,
    span = jsonStringSpan(text, start);
  if (!span) return false;
  const end = (state.cursor = span.end),
    decoded = span.value;
  if (decoded === undefined) return true;
  let next = end;
  while (next < text.length && /\s/.test(text[next])) next++;
  if (text[next] === ':' && cspHeader(decoded)) {
    next++;
    while (next < text.length && /\s/.test(text[next])) next++;
    if (text[next] !== '"') return true;
    const valueStart = next,
      policySpan = jsonStringSpan(text, next);
    if (!policySpan) return false;
    next = policySpan.end;
    const policy = policySpan.value;
    if (policy === undefined) {
      state.cursor = next;
      return true;
    }
    const replacement = redactCspPolicy(policy, collect);
    if (replacement !== policy) {
      state.parts.push(text.slice(state.last, valueStart), JSON.stringify(replacement));
      state.last = next;
    }
    state.cursor = next;
  } else if (decoded.includes('<') || /content-security-policy/i.test(decoded)) {
    const replacement = redactCspNonceText(decoded, depth + 1, collect);
    if (replacement !== decoded) {
      state.parts.push(text.slice(state.last, start), JSON.stringify(replacement));
      state.last = end;
    }
  }
  return true;
}

function redactCspNonceText(value, depth = 0, collect) {
  const text = redactHtmlNonceAttributes(String(value), collect);
  if (depth >= 4 || /^\s*</.test(text)) return text;
  const state = { cursor: 0, last: 0, parts: [] };
  while (state.cursor < text.length) {
    if (text[state.cursor] !== '"') {
      state.cursor++;
      continue;
    }
    if (!redactCspJsonCandidate(text, state, depth, collect)) break;
  }
  if (!state.parts.length) return text;
  state.parts.push(text.slice(state.last));
  return state.parts.join('');
}
function redactCspNonceEvidenceBase(value, collect) {
  if (typeof value === 'string') return redactCspNonceText(value, 0, collect);
  if (Array.isArray(value)) return value.map((item) => redactCspNonceEvidenceBase(item, collect));
  if (!value || typeof value !== 'object') return value;
  return redactCspNonceEvidenceObject(value, collect);
}

function redactCspNonceEvidenceObject(value, collect) {
  const element = ['tag', 'tagName', 'nodeName'].some(
    (key) => typeof value[key] === 'string' && /^[a-z][a-z0-9:_-]*$/i.test(value[key]),
  );
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => redactCspEvidenceEntry(key, item, collect)),
  );
  redactCspElementAttributes(result, element, collect);
  redactCspFieldValues(value, result, collect);
  redactCspEvidenceBody(value, result);
  return result;
}

function redactCspEvidenceEntry(key, item, collect) {
  if (key === 'screenshot' || key === 'bodyHashInput') return [key, item];
  if (cspHeader(key) && typeof item === 'string') return [key, redactCspPolicy(item, collect)];
  return [key, redactCspNonceEvidenceBase(item, collect)];
}

/* NOSONAR */ function redactCspElementAttributes(result, element, collect) {
  if (element)
    for (const key of ['attributes', 'attrs'])
      if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        for (const attribute of Object.keys(result[key]))
          if (attribute.toLowerCase() === 'nonce') {
            collect?.(result[key][attribute]);
            result[key][attribute] = '{token}';
          }
      }
}

function redactCspFieldValues(value, result, collect) {
  if (typeof value.field === 'string' && cspHeader(value.field.split(/[./]/).at(-1)))
    for (const key of ['live', 'mirage'])
      if (typeof value[key] === 'string') result[key] = redactCspPolicy(value[key], collect);
}

function redactCspEvidenceBody(value, result) {
  if (typeof value.body === 'string' && result.body !== value.body) {
    delete result.bodyHashInput;
    result.bodyHashProvenance = 'redacted-text-sha256';
    if (Object.hasOwn(value, 'bodySha256')) result.bodySha256 = createHash('sha256').update(result.body).digest('hex');
  }
}

/** A finite in-memory set comes only from declared policy/HTML nonce contexts.
 * Long complete base64 tokens may have exact copies elsewhere in this capture;
 * ordinary nonce-named business fields and short/common strings are untouched. */
function redactCspNonceEvidence(value) {
  const nonces = new Set();
  const sanitized = redactCspNonceEvidenceBase(value, (nonce) => {
    if (typeof nonce !== 'string' || nonce.length < 16 || !/^[A-Za-z0-9+/_=-]+$/.test(nonce)) return;
    if (nonce.length > 4096 || (!nonces.has(nonce) && nonces.size >= 256))
      throw new Error('Declared CSP nonce protection exceeds its bound.');
    nonces.add(nonce);
  });
  if (!nonces.size) return sanitized;
  const token = (text) =>
    text
      .replace(/('|&apos;|&#0*39;|&#x0*27;)nonce-([a-z0-9+/_=-]+)\1/gi, (all, quote, nonce) =>
        nonces.has(nonce) ? quote + 'nonce-{token}' + quote : all,
      )
      .replace(/[A-Za-z0-9+/_=-]{16,}/g, (candidate) => (nonces.has(candidate) ? '{token}' : candidate));
  function text(value) {
    let cursor = 0,
      last = 0;
    const parts = [];
    while (cursor < value.length) {
      if (value[cursor] !== '"') {
        cursor++;
        continue;
      }
      const start = cursor,
        span = jsonStringSpan(value, start);
      if (!span) break;
      cursor = span.end;
      const decoded = span.value;
      if (decoded === undefined) continue;
      const replacement = token(decoded);
      if (replacement !== decoded) {
        parts.push(value.slice(last, start), JSON.stringify(replacement));
        last = cursor;
      }
    }
    if (parts.length) {
      parts.push(value.slice(last));
      value = parts.join('');
    }
    return token(value);
  }
  function visit(item) {
    if (typeof item === 'string') return text(item);
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    const result = Object.fromEntries(
      Object.entries(item).map(([key, child]) => [
        key,
        key === 'screenshot' || key === 'bodyHashInput' ? child : visit(child),
      ]),
    );
    if (typeof item.body === 'string' && result.body !== item.body) {
      delete result.bodyHashInput;
      result.bodyHashProvenance = 'redacted-text-sha256';
      if (Object.hasOwn(item, 'bodySha256')) result.bodySha256 = createHash('sha256').update(result.body).digest('hex');
    }
    return result;
  }
  return visit(sanitized);
}
export function redactCapabilityEvidence(value) {
  return redactCapabilityEvidenceBase(redactCspNonceEvidence(value));
}
export function redactCapabilityDiffEvidence(value) {
  const sanitized = redactCapabilityEvidence(value);
  function visit(item) {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    const result = Object.fromEntries(Object.entries(item).map(([key, v]) => [key, visit(v)]));
    if (typeof item.field === 'string' && isProtectedField(item.field.split(/[./]/).at(-1))) {
      for (const key of ['live', 'mirage']) if (typeof item[key] === 'string') result[key] = '{token}';
    }
    return result;
  }
  return visit(sanitized);
}

const LIMIT = 4 * 1024 * 1024;
const LAYOUT_ATTRIBUTE = 'data-view-layouts';
function stripBase64Padding(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === '=') end--;
  return value.slice(0, end);
}
const jsonObject = (text) => {
  const value = JSON.parse(text);
  return value !== null && typeof value === 'object';
};

/** Only the server's declared layout envelope is decoded; arbitrary base64 payloads are never inspected. */
export function redactLayoutAttributeValue(attribute, value) {
  if (String(attribute).toLowerCase() !== LAYOUT_ATTRIBUTE || typeof value !== 'string' || !value) return value;
  if (value.length > LIMIT) throw new Error('Capture layout exceeds the redaction size bound.');
  if (/^\s*[[{]/.test(value)) return redactStructuredLayout(value);
  return redactBase64Layout(value);
}

function redactStructuredLayout(value) {
  if (!jsonObject(value)) throw new Error('Capture layout is not a structured JSON value.');
  return redactSecureConfigurationTokens(value);
}

function redactBase64Layout(value) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error('Capture layout has an invalid base64 envelope.');
  const canonical = stripBase64Padding(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Buffer.from(value, 'base64');
  if (stripBase64Padding(bytes.toString('base64')) !== canonical)
    throw new Error('Capture layout has a noncanonical base64 envelope.');
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Capture layout is not UTF-8 JSON.');
  }
  try {
    if (!jsonObject(decoded)) throw new Error('Capture layout is not a structured JSON value.');
  } catch {
    throw new Error('Capture layout is not structured JSON.');
  }
  const redacted = redactSecureConfigurationTokens(decoded);
  if (redacted === decoded) return value;
  let encoded = Buffer.from(redacted, 'utf8').toString(/[-_]/.test(value) ? 'base64url' : 'base64');
  if (!value.endsWith('=')) encoded = stripBase64Padding(encoded);
  else while (encoded.length % 4) encoded += '=';
  return encoded;
}

/** HTML bodies may be nested in escaped JSON strings or carry entity-quoted attributes. */
export function redactEncodedLayoutTokens(text) {
  return String(text ?? '')
    .replace(
      /((?<![\w:-])data-view-layouts\s*=\s*)((?:\\{0,2}["'])|&quot;|&#0*34;|&#x0*22;)([\s\S]*?)\2/gi,
      (_match, prefix, quote, value) => prefix + quote + redactLayoutAttributeValue(LAYOUT_ATTRIBUTE, value) + quote,
    )
    .replace(
      /((?<![\w:-])data-view-layouts\s*=\s*)([^\s"'`<>&\\]+)(?=[\s>])/gi,
      (_match, prefix, value) => prefix + redactLayoutAttributeValue(LAYOUT_ATTRIBUTE, value),
    );
}

/** Element inventories also store layout values directly under an exact attribute-map key. */
export function redactEncodedLayoutEvidence(value) {
  if (typeof value === 'string') return redactEncodedLayoutTokens(value);
  if (Array.isArray(value)) return value.map(redactEncodedLayoutEvidence);
  if (value && typeof value === 'object') {
    return redactLayoutEvidenceObject(value);
  }
  return value;
}

function redactLayoutEvidenceObject(value) {
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key.toLowerCase() === LAYOUT_ATTRIBUTE) return [key, redactLayoutAttributeValue(key, item)];
      if (key === 'screenshot' || key === 'bodyHashInput') return [key, item];
      return [key, redactEncodedLayoutEvidence(item)];
    }),
  );
  if (typeof value.field === 'string' && /(?:^|[./])data-view-layouts$/i.test(value.field)) {
    for (const key of ['live', 'mirage'])
      if (typeof value[key] === 'string') result[key] = redactLayoutAttributeValue(LAYOUT_ATTRIBUTE, value[key]);
  }
  if (typeof value.body === 'string' && result.body !== value.body) {
    delete result.bodyHashInput;
    result.bodyHashProvenance = 'redacted-text-sha256';
    if (Object.hasOwn(value, 'bodySha256')) result.bodySha256 = createHash('sha256').update(result.body).digest('hex');
  }
  return result;
}

/** Scrub signed control tokens before capture serialization, including declared layout envelopes. */
export const redactCaptureControlEvidence = (value) => redactEncodedLayoutEvidence(redactCapabilityEvidence(value));
export const redactCaptureControlText = (text) =>
  redactEncodedLayoutTokens(redactSecureConfigurationTokens(redactCspNonceEvidence(text)));
