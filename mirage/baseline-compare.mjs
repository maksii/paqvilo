// Baseline comparison: field-by-field differences between a live capture folder and a Mirage
// capture folder (requests, responses, DOM, elements), classified against a reviewed allowlist.
// A second independent live capture, when present, proves which differences are live-run
// variance. No normalisation hides a difference: every delta is listed, allowed or not.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse, defaultTreeAdapter as adapter } from 'parse5';

const sha = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};

/** Allowlist entries: { id, scope: request|response|dom|element|console, pattern, field, reason, proof, evidence, value? }.
 * `value` (optional regex) narrows the entry to deltas whose live or Mirage value matches it. */
export async function loadAllowlist(file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.entries))
    throw new Error('Allowlist version 1 with entries is required.');
  for (const entry of data.entries) {
    for (const key of ['id', 'scope', 'pattern', 'field', 'reason', 'proof', 'evidence'])
      if (typeof entry[key] !== 'string' || !entry[key])
        throw new Error(`Allowlist entry ${entry.id ?? '?'} lacks ${key}.`);
    if (!['request', 'response', 'dom', 'element', 'console'].includes(entry.scope))
      throw new Error(`Allowlist entry ${entry.id} has an unknown scope.`);
    if (!['live-run-variance', 'platform-generated'].includes(entry.proof))
      throw new Error(`Allowlist entry ${entry.id} needs proof live-run-variance or platform-generated.`);
    entry.regex = new RegExp(entry.pattern);
    entry.fieldRegex = new RegExp(entry.field);
    if (entry.value !== undefined) {
      if (typeof entry.value !== 'string' || !entry.value)
        throw new Error(`Allowlist entry ${entry.id} has an empty value pattern.`);
      entry.valueRegex = new RegExp(entry.value);
    }
  }
  return data;
}

// A same-origin frame's elements are keyed "frame(<path>) <selector>": an entry about an element applies inside a frame
// document as on the page, so element entries also match the selector without its frame prefix.
const FRAME_PREFIX = /^frame\([^)]*\) /;
function allowed(delta, allowlist) {
  const inFrame =
    delta.scope === 'element' && FRAME_PREFIX.test(delta.location) ? delta.location.replace(FRAME_PREFIX, '') : null;
  for (const entry of allowlist.entries ?? []) {
    if (
      entry.scope !== delta.scope ||
      !(entry.regex.test(delta.location) || (inFrame !== null && entry.regex.test(inFrame))) ||
      !entry.fieldRegex.test(delta.field)
    )
      continue;
    if (
      entry.valueRegex &&
      !entry.valueRegex.test(String(delta.live ?? '')) &&
      !entry.valueRegex.test(String(delta.mirage ?? ''))
    )
      continue;
    return entry.id;
  }
  return null;
}

const delta = (scope, location, field, live, mirage, extra = {}) => ({
  scope,
  location,
  field,
  live,
  mirage,
  signature: sha(
    `${scope}|${field}|${typeof live}|${typeof mirage}|${String(live).slice(0, 40)}|${String(mirage).slice(0, 40)}`,
  ),
  ...extra,
});

// Grid data records list their `Attributes` in storage order, which differs from record to record on a
// live portal; those arrays are compared by attribute `Name`, every other array keeps its order.
function namedAttributes(value) {
  if (Array.isArray(value)) return value.map(namedAttributes);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const named =
      key === 'Attributes' &&
      Array.isArray(item) &&
      item.length &&
      item.every((entry) => entry && typeof entry === 'object' && typeof entry.Name === 'string');
    out[key] = named
      ? Object.fromEntries(
          [...item].sort((x, y) => x.Name.localeCompare(y.Name)).map((entry) => [entry.Name, namedAttributes(entry)]),
        )
      : namedAttributes(item);
  }
  return out;
}

function canonicalBody(body, contentType = '') {
  if (body === null || body === undefined) return null;
  const text = String(body);
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      return { kind: 'json', value: namedAttributes(JSON.parse(text)) };
    } catch {
      /* not JSON */
    }
  }
  // Multipart postbacks (forms with a file control): the boundary is random per browser, so the parts are compared as
  // fields like an urlencoded form; a file part compares as its name, type and byte length.
  const boundary = /multipart\/form-data;\s*boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (boundary) {
    const fields = {};
    for (const part of text.split(`--${boundary}`)) {
      const split = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
      if (split < 0) continue;
      const head = part.slice(0, split);
      const content = part
        .slice(split)
        .replace(/^\r?\n\r?\n/, '')
        .replace(/\r?\n$/, '');
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      if (name === undefined) continue;
      const file = /filename="([^"]*)"/i.exec(head);
      // Server state and anti-forgery fields are tokens, as the capture redacts them in urlencoded bodies.
      const token = /^(?:__RequestVerificationToken|__VIEWSTATE(?:GENERATOR)?|__EVENTVALIDATION|__CMSCsrfToken)$/.test(
        name,
      );
      const value = file
        ? `file:${file[1]}:${/content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? ''}:${content.length}`
        : token
          ? '{token}'
          : content;
      (fields[name] ??= []).push(value);
    }
    return {
      kind: 'form',
      value: Object.fromEntries(
        Object.keys(fields)
          .sort()
          .map((key) => [key, fields[key]]),
      ),
    };
  }
  if (
    /x-www-form-urlencoded/i.test(contentType) ||
    (!text.includes('<') && /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(text))
  ) {
    const params = new URLSearchParams(text);
    return {
      kind: 'form',
      value: Object.fromEntries([...params.keys()].sort().map((key) => [key, params.getAll(key)])),
    };
  }
  return { kind: 'text', value: text };
}

function diffValue(scope, location, field, a, b, out, depth = 0) {
  if (depth > 12) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]).values())
      diffValue(scope, location, `${field}.${key}`, a[key], b[key], out, depth + 1);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(delta(scope, location, `${field}.length`, a.length, b.length));
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      diffValue(scope, location, `${field}[${i}]`, a[i], b[i], out, depth + 1);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b))
    out.push(delta(scope, location, field, a === undefined ? '(absent)' : a, b === undefined ? '(absent)' : b));
}

function requestKey(request) {
  return `${request.method} ${request.url.replace(/\?.*$/, '')}`;
}

/** Align two request sequences in order, then compare each aligned pair field by field. */
// The multipart boundary is random per browser: it is compared as a token (the parts are compared by canonicalBody).
const withoutDiagnostics = (headers) =>
  Object.fromEntries(
    Object.entries(headers ?? {})
      .filter(([name]) => !/^x-sim-/i.test(name))
      .map(([name, value]) => [
        name,
        /^content-type$/i.test(name)
          ? String(value).replace(/(multipart\/form-data;\s*boundary=)("?)[^";]+\2/i, '$1$2{boundary}$2')
          : value,
      ]),
  );

export function compareRequests(live = [], mirage = []) {
  const out = [];
  const keysA = live.map(requestKey);
  const keysB = mirage.map(requestKey);
  // Longest common subsequence alignment keeps order significant.
  const dp = Array.from({ length: keysA.length + 1 }, () => new Uint16Array(keysB.length + 1));
  for (let i = keysA.length - 1; i >= 0; i--)
    for (let j = keysB.length - 1; j >= 0; j--)
      dp[i][j] = keysA[i] === keysB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < keysA.length && j < keysB.length) {
    if (keysA[i] === keysB[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(delta('request', `#${live[i].seq} ${keysA[i]}`, 'presence', 'present', '(absent)', { position: i }));
      i++;
    } else {
      out.push(delta('request', `#${mirage[j].seq} ${keysB[j]}`, 'presence', '(absent)', 'present', { position: j }));
      j++;
    }
  }
  for (; i < keysA.length; i++)
    out.push(delta('request', `#${live[i].seq} ${keysA[i]}`, 'presence', 'present', '(absent)', { position: i }));
  for (; j < keysB.length; j++)
    out.push(delta('request', `#${mirage[j].seq} ${keysB[j]}`, 'presence', '(absent)', 'present', { position: j }));
  for (const [a, b] of pairs) {
    const A = live[a];
    const B = mirage[b];
    const location = `#${A.seq}/${B.seq} ${keysA[a]}`;
    if (A.url !== B.url) out.push(delta('request', location, 'query', A.url, B.url));
    if (A.resourceType !== B.resourceType)
      out.push(delta('request', location, 'resourceType', A.resourceType, B.resourceType));
    diffValue('request', location, 'headers', withoutDiagnostics(A.headers), withoutDiagnostics(B.headers), out);
    const bodyA = canonicalBody(A.body, A.headers?.['content-type']);
    const bodyB = canonicalBody(B.body, B.headers?.['content-type']);
    if ((bodyA?.kind ?? null) !== (bodyB?.kind ?? null))
      out.push(delta('request', location, 'body.kind', bodyA?.kind ?? null, bodyB?.kind ?? null));
    else if (bodyA) diffValue('request', location, 'body', bodyA.value, bodyB.value, out);
    const ra = A.response ?? {};
    const rb = B.response ?? {};
    if (ra.status !== rb.status) out.push(delta('response', location, 'status', ra.status ?? null, rb.status ?? null));
    // A local runtime's own diagnostic headers (x-sim-*) are instrumentation, not rendered behaviour.
    diffValue('response', location, 'headers', withoutDiagnostics(ra.headers), withoutDiagnostics(rb.headers), out);
    const typeA = ra.headers?.['content-type'] ?? '';
    if (ra.body !== undefined || rb.body !== undefined) {
      if (/text\/html/i.test(typeA) && ra.body && rb.body)
        diffDom(parse(ra.body), parse(rb.body), out, `${location} body`);
      else {
        const ca = canonicalBody(ra.body, typeA);
        const cb = canonicalBody(rb.body, rb.headers?.['content-type'] ?? '');
        if ((ca?.kind ?? null) !== (cb?.kind ?? null))
          out.push(delta('response', location, 'body.kind', ca?.kind ?? null, cb?.kind ?? null));
        else if (ca) diffValue('response', location, 'body', ca.value, cb.value, out);
      }
    }
    if (ra.body === null && rb.body === null && (ra.bodySha256 !== rb.bodySha256 || ra.bodyBytes !== rb.bodyBytes))
      out.push(
        delta(
          'response',
          location,
          'body.bytes',
          `${ra.bodyBytes}:${ra.bodySha256?.slice(0, 12)}`,
          `${rb.bodyBytes}:${rb.bodySha256?.slice(0, 12)}`,
        ),
      );
  }
  return out;
}

const IGNORED_TAGS = new Set(['#comment']);
const nodePath = (parents) => parents.join('>');
const elementKey = (node, index) =>
  `${node.tagName}${node.attrs?.find((a) => a.name === 'id')?.value ? '#' + node.attrs.find((a) => a.name === 'id').value : `:nth(${index})`}`;

function childElements(node) {
  return (adapter.getChildNodes(node) ?? []).filter(
    (child) =>
      !IGNORED_TAGS.has(child.nodeName) &&
      child.nodeName !== '#documentType' &&
      !(child.nodeName === '#text' && !child.value.trim()) &&
      !(adapter.isElementNode(child) && child.tagName === 'script' && !isJsonScript(child)) &&
      !isPanel(child),
  );
}
const isJsonScript = (node) => node.attrs?.some((a) => a.name === 'type' && /json/i.test(a.value));
const isPanel = (node) =>
  adapter.isElementNode(node) &&
  node.attrs?.some((a) => (a.name === 'id' && a.value === 'paqvilo-panel') || a.name.startsWith('data-paqvilo'));
const textOf = (node) =>
  adapter.isTextNode(node)
    ? node.value.replace(/\s+/g, ' ').trim()
    : (adapter.getChildNodes(node)?.map(textOf).join('') ?? '');

/** Structural DOM comparison: tag, attributes (class as ordered list), text of leaf nodes, child order. */
// The hosted React/Fluent bundles inject <style data-merge-styles|data-load-themed-styles|data-fela-type> elements into the
// live head at run time; they are client-side platform artefacts and would shift every positional head delta.
const INJECTED_STYLE = /^data-(?:merge-styles|load-themed-styles|fela-type)$/;
export function withoutInjectedStyles(node) {
  const children = adapter.getChildNodes(node) ?? [];
  for (const child of [...children]) {
    if (
      adapter.isElementNode(child) &&
      adapter.getTagName(child) === 'style' &&
      adapter.getAttrList(child).some((attr) => INJECTED_STYLE.test(attr.name))
    )
      adapter.detachNode(child);
    else if (adapter.getChildNodes(child)?.length) withoutInjectedStyles(child);
  }
  return node;
}

export function diffDom(a, b, out, root = 'dom') {
  const walk = (x, y, parents, index) => {
    const location = `${root} ${nodePath(parents)}`;
    if (adapter.isTextNode(x) || adapter.isTextNode(y)) {
      const tx = adapter.isTextNode(x) ? x.value.replace(/\s+/g, ' ').trim() : `<${x.tagName}>`;
      const ty = adapter.isTextNode(y) ? y.value.replace(/\s+/g, ' ').trim() : `<${y.tagName}>`;
      if (tx !== ty) out.push(delta('dom', location, 'text', tx.slice(0, 400), ty.slice(0, 400)));
      return;
    }
    if (x.tagName !== y.tagName) {
      out.push(delta('dom', location, 'tag', x.tagName, y.tagName));
      return;
    }
    const attrsA = Object.fromEntries(
      (x.attrs ?? []).filter((a) => a.name !== 'nonce' && a.name !== 'style').map((a) => [a.name, a.value]),
    );
    const attrsB = Object.fromEntries(
      (y.attrs ?? []).filter((a) => a.name !== 'nonce' && a.name !== 'style').map((a) => [a.name, a.value]),
    );
    const here = `${location}>${elementKey(x, index)}`.replace(/^dom >/, 'dom ');
    for (const name of new Set([...Object.keys(attrsA), ...Object.keys(attrsB)])) {
      if (name === 'class') {
        const ca = (attrsA.class ?? '').split(/\s+/).filter(Boolean).join(' ');
        const cb = (attrsB.class ?? '').split(/\s+/).filter(Boolean).join(' ');
        if (ca !== cb) out.push(delta('dom', here, 'class', ca, cb));
      } else if (attrsA[name] !== attrsB[name])
        out.push(delta('dom', here, `attr.${name}`, attrsA[name] ?? '(absent)', attrsB[name] ?? '(absent)'));
    }
    const styleA =
      (x.attrs ?? [])
        .find((a) => a.name === 'style')
        ?.value?.replace(/\s+/g, '')
        .replace(/;$/, '') ?? '';
    const styleB =
      (y.attrs ?? [])
        .find((a) => a.name === 'style')
        ?.value?.replace(/\s+/g, '')
        .replace(/;$/, '') ?? '';
    if (styleA !== styleB) out.push(delta('dom', here, 'attr.style', styleA, styleB));
    if (['script', 'style'].includes(x.tagName)) {
      const sa = textOf(x);
      const sb = textOf(y);
      if (sa !== sb)
        out.push(delta('dom', here, 'content', sa.slice(0, 300), sb.slice(0, 300), { contentSha: [sha(sa), sha(sb)] }));
      return;
    }
    const ka = childElements(x);
    const kb = childElements(y);
    if (ka.length !== kb.length) out.push(delta('dom', here, 'children.length', ka.length, kb.length));
    const next = [...parents, elementKey(x, index)];
    for (let k = 0; k < Math.min(ka.length, kb.length); k++) walk(ka[k], kb[k], next, k);
  };
  const ra = childElements(a).find((n) => adapter.isElementNode(n)) ?? a;
  const rb = childElements(b).find((n) => adapter.isElementNode(n)) ?? b;
  walk(ra, rb, [], 0);
  return out;
}

/** Same-origin frame documents (frames.json, keyed by frame path): presence per path, then the DOM walk under "frame <path>". */
export function diffFrames(live = {}, mirage = {}, out = []) {
  for (const key of new Set([...Object.keys(live), ...Object.keys(mirage)])) {
    if (!(key in mirage) || !(key in live))
      out.push(
        delta(
          'dom',
          'frame ' + key,
          'presence',
          key in live ? 'present' : '(absent)',
          key in mirage ? 'present' : '(absent)',
        ),
      );
    else
      diffDom(withoutInjectedStyles(parse(live[key])), withoutInjectedStyles(parse(mirage[key])), out, 'frame ' + key);
  }
  return out;
}

export function compareElements(live = [], mirage = [], out = []) {
  const byKey = (items) => new Map(items.map((item) => [item.selector, item]));
  const A = byKey(live);
  const B = byKey(mirage);
  for (const [selector, a] of A) {
    const b = B.get(selector);
    if (!b) {
      out.push(delta('element', selector, 'presence', 'present', '(absent)'));
      continue;
    }
    for (const field of ['tag', 'visible', 'disabled', 'readonly', 'required', 'value'])
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field]))
        out.push(delta('element', selector, field, a[field] ?? '(absent)', b[field] ?? '(absent)'));
    if (a.classes.join(' ') !== b.classes.join(' '))
      out.push(delta('element', selector, 'classes', a.classes.join(' '), b.classes.join(' ')));
    diffValue('element', selector, 'attributes', a.attributes, b.attributes, out);
  }
  for (const selector of B.keys())
    if (!A.has(selector)) out.push(delta('element', selector, 'presence', '(absent)', 'present'));
  return out;
}

export function compareConsole(live, mirage, out = []) {
  const norm = (entries) =>
    (entries?.console ?? []).filter((e) => ['error', 'warning'].includes(e.type)).map((e) => `${e.type}: ${e.text}`);
  const a = norm(live);
  const b = norm(mirage);
  for (const line of a) if (!b.includes(line)) out.push(delta('console', 'console', 'entry', line, '(absent)'));
  for (const line of b) if (!a.includes(line)) out.push(delta('console', 'console', 'entry', '(absent)', line));
  for (const line of live?.pageErrors ?? [])
    if (!(mirage?.pageErrors ?? []).includes(line)) out.push(delta('console', 'pageErrors', 'entry', line, '(absent)'));
  for (const line of mirage?.pageErrors ?? [])
    if (!(live?.pageErrors ?? []).includes(line)) out.push(delta('console', 'pageErrors', 'entry', '(absent)', line));
  return out;
}

async function loadCapture(dir) {
  const meta = await readJson(path.join(dir, 'meta.json'));
  if (!meta) return null;
  return {
    meta,
    requests: await readJson(path.join(dir, 'requests.json'), []),
    elements: await readJson(path.join(dir, 'elements.json'), []),
    console: await readJson(path.join(dir, 'console.json'), { console: [], pageErrors: [] }),
    dom: await fs.readFile(path.join(dir, 'dom.html'), 'utf8').catch(() => ''),
    frames: (await readJson(path.join(dir, 'frames.json'), {})) ?? {},
  };
}

// Platform-generated element ids whose value is a per-render GUID or a hosted-bundle instance counter: both sides keep
// the element, only the token is normalised, so a missing element still shows up as a delta.
// Also: ASP.NET control counters in generated control names ($ctl<n>), per-render GUID values of data-content-id
// attributes, and each side's own origin in absolute self links ({origin}).
const GENERATED_IDS = [
  [/PcfControl_[0-9a-f]{32}/g, 'PcfControl_{hex32}'],
  [/UpdMSPicklistControl\d+/g, 'UpdMSPicklistControl{n}'],
  [/\$ctl\d+/g, '$ctl{n}'],
  [/(data-content-id=\\?")[0-9a-f-]{36}/g, '$1{guid}'],
  [/("data-content-id"\s*:\s*")[0-9a-f-]{36}/g, '$1{guid}'],
  [/popoverUpdateButton_[0-9a-f-]{36}/g, 'popoverUpdateButton_{guid}'],
];
const LOOPBACK_ORIGIN = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g;
export const normalizeGeneratedIds = (text, origins = []) => {
  let out = GENERATED_IDS.reduce((acc, [pattern, token]) => acc.replace(pattern, token), text);
  for (const origin of origins) if (origin) out = out.split(origin).join('{origin}');
  return out.replace(LOOPBACK_ORIGIN, '{origin}');
};
// The address composite control's hidden popover container carries a per-render GUID id; only ids of elements
// with that class are tokenised (in document order), plain text and CSS-escaped selector forms alike.
const ADDRESS_CONTAINER = /<div\b[^>]*\baddressCompositeControlContainer\b[^>]*>/g;
export const addressContainerIds = (dom = '') =>
  [...dom.matchAll(ADDRESS_CONTAINER)]
    .map((m) => /\bid="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i.exec(m[0])?.[1])
    .filter(Boolean);
const withoutAddressIds = (text, ids) =>
  ids.reduce((acc, id, n) => {
    const token = `{address-composite-id-${n}}`;
    const out = acc.split(id).join(token);
    // CSS.escape writes a leading digit as \3<digit><space>; elements.json stores the selector JSON-escaped.
    return /^\d/.test(id)
      ? out
          .split(`\\\\3${id[0]} ${id.slice(1)}`)
          .join(token)
          .split(`\\3${id[0]} ${id.slice(1)}`)
          .join(token)
      : out;
  }, text);
const normalizedCapture = (capture, origins = []) => {
  if (!capture) return capture;
  const ids = addressContainerIds(capture.dom ?? '');
  const normalizeJson = (value) =>
    JSON.parse(withoutAddressIds(normalizeGeneratedIds(JSON.stringify(value ?? []), origins), ids));
  const frames = Object.fromEntries(
    Object.entries(capture.frames ?? {}).map(([key, dom]) => {
      const frameIds = addressContainerIds(dom);
      return [key, withoutAddressIds(normalizeGeneratedIds(dom ?? '', origins), frameIds)];
    }),
  );
  return {
    ...capture,
    frames,
    dom: withoutAddressIds(normalizeGeneratedIds(capture.dom ?? '', origins), ids),
    elements: normalizeJson(capture.elements),
    requests: normalizeJson(capture.requests),
  };
};

export async function compareScenario({
  scenario,
  liveDir,
  mirageDir,
  secondDir = null,
  allowlist,
  origins = [],
  changes = [],
}) {
  const live = normalizedCapture(await loadCapture(liveDir), origins);
  const mirage = normalizedCapture(await loadCapture(mirageDir), origins);
  const result = {
    id: scenario.id,
    verdict: 'error',
    counts: { total: 0, allowed: 0, unexplained: 0 },
    deltas: [],
    variance: null,
    signatures: [],
  };
  if (!live || !mirage) {
    result.reason = !live ? 'live capture missing' : 'mirage capture missing';
    return result;
  }
  if (live.meta.status !== 'captured' || mirage.meta.status !== 'captured') {
    result.liveCapturedAt = Date.parse(live.meta.capturedAt ?? '');
    result.reason = `capture not usable as evidence (live: ${live.meta.status}, mirage: ${mirage.meta.status})`;
    result.problems = { live: live.meta.problems, mirage: mirage.meta.problems };
    return result;
  }
  result.liveCapturedAt = Date.parse(live.meta.capturedAt ?? '');
  const deltas = [];
  deltas.push(...compareRequests(live.requests, mirage.requests));
  if (live.meta.finalUrl !== mirage.meta.finalUrl)
    deltas.push(delta('dom', 'finalUrl', 'url', live.meta.finalUrl, mirage.meta.finalUrl));
  if (live.meta.title !== mirage.meta.title)
    deltas.push(delta('dom', 'title', 'text', live.meta.title, mirage.meta.title));
  diffDom(withoutInjectedStyles(parse(live.dom)), withoutInjectedStyles(parse(mirage.dom)), deltas);
  diffFrames(live.frames, mirage.frames, deltas);
  compareElements(live.elements, mirage.elements, deltas);
  compareConsole(live.console, mirage.console, deltas);
  // Live-run variance: the live-vs-live-2 deltas, classified like the Mirage ones, witness the
  // live-run-variance entries they match. Tokens sit in element ids, field names and request
  // indexes, so the proof is per entry within the scenario, not per exact location.
  const entryById = new Map((allowlist.entries ?? []).map((entry) => [entry.id, entry]));
  const isVariance = (id) => entryById.get(id)?.proof === 'live-run-variance';
  let variance = null;
  let witnessed = null;
  if (secondDir) {
    const second = normalizedCapture(await loadCapture(secondDir), origins);
    if (second?.meta.status === 'captured') {
      const between = [];
      between.push(...compareRequests(live.requests, second.requests));
      diffDom(parse(live.dom), parse(second.dom), between);
      diffFrames(live.frames, second.frames, between);
      compareElements(live.elements, second.elements, between);
      variance = new Set(between.map((d) => `${d.scope}|${d.location}|${d.field}`));
      witnessed = new Set(between.map((d) => allowed(d, allowlist)).filter(isVariance));
      result.variance = {
        deltas: between.length,
        folder: path.basename(secondDir),
        entries: [...witnessed].sort(),
        unproven: {},
      };
    }
  }
  for (const item of deltas) {
    if (variance?.has(`${item.scope}|${item.location}|${item.field}`)) item.liveVariance = true;
    item.allowlist = allowed(item, allowlist);
    // A live-run-variance entry explains a delta only when the second live capture witnessed it in this scenario.
    if (item.allowlist && witnessed && isVariance(item.allowlist) && !witnessed.has(item.allowlist)) {
      item.unprovenVariance = item.allowlist;
      item.allowlist = null;
      result.variance.unproven[item.unprovenVariance] = (result.variance.unproven[item.unprovenVariance] ?? 0) + 1;
    }
  }
  // Paired scenario: the live-run-variance entries that explain a Mirage delta here, witnessed or not.
  if (witnessed)
    result.variance.matched = [
      ...new Set(deltas.map((d) => d.allowlist ?? d.unprovenVariance).filter(isVariance)),
    ].sort();
  // Evidence age: a live capture older than a recorded live change shows that change's known effect. Its matching,
  // otherwise unexplained deltas are marked stale (provisionally: finalizeEvidenceChanges checks the change's proof).
  const liveTime = Date.parse(live.meta.capturedAt ?? '');
  for (const change of changes)
    if (Number.isFinite(liveTime) && liveTime < change.staleBeforeTime && change.affectsRegex.test(scenario.id))
      for (const item of deltas)
        if (!item.allowlist && !item.staleEvidence && matchesChange(item, change)) item.staleEvidence = change.id;
  result.deltas = deltas;
  tally(result);
  return result;
}

/** Counts, verdict and signature groups of a compared scenario (stale deltas are neither allowed nor unexplained). */
function tally(result) {
  const deltas = result.deltas;
  result.counts = {
    ...result.counts,
    total: deltas.length,
    allowed: deltas.filter((d) => d.allowlist).length,
    stale: deltas.filter((d) => !d.allowlist && d.staleEvidence).length,
    unexplained: deltas.filter((d) => !d.allowlist && !d.staleEvidence).length,
  };
  // The suite's report keeps counts per scenario, so the variance proof travels with them.
  if (result.variance)
    result.counts.variance = {
      entries: result.variance.entries,
      matched: result.variance.matched ?? [],
      unproven: result.variance.unproven,
    };
  const stale = {};
  for (const item of deltas) if (item.staleEvidence) stale[item.staleEvidence] = (stale[item.staleEvidence] ?? 0) + 1;
  if (Object.keys(stale).length) result.counts.staleEvidence = stale;
  else delete result.counts.staleEvidence;
  result.verdict = deltas.length === 0 ? 'PASS' : result.counts.unexplained === 0 ? 'ALLOWED' : 'FAIL';
  const groups = new Map();
  for (const item of deltas) {
    const key = `${item.scope}:${item.field.replace(/\[\d+\]/g, '[n]').replace(/\.\d+/g, '.n')}:${item.signature}`;
    const group = groups.get(key) ?? {
      signature: key,
      scope: item.scope,
      field: item.field,
      count: 0,
      allowed: Boolean(item.allowlist),
      ...(item.staleEvidence ? { stale: item.staleEvidence } : {}),
      example: {
        location: item.location,
        live: String(item.live).slice(0, 120),
        mirage: String(item.mirage).slice(0, 120),
      },
    };
    group.count++;
    groups.set(key, group);
  }
  result.signatures = [...groups.values()].sort((a, b) => b.count - a.count);
  return result;
}

const matchesChange = (item, change) =>
  change.signatures.some(
    (s) =>
      s.scope === item.scope &&
      s.fieldRegex.test(item.field) &&
      s.locationRegex.test(item.location) &&
      (!s.liveRegex || s.liveRegex.test(String(item.live ?? ''))) &&
      (!s.mirageRegex || s.mirageRegex.test(String(item.mirage ?? ''))),
  );

/** Evidence changes: { version: 1, changes: [{ id, since, staleBefore?, affects, signatures: [{ scope, field, location, live?, mirage? }], proof: [scenario ids], reason }] }.
 * A change records a live change made after some live captures were taken: older captures show its known effect. */
export async function loadEvidenceChanges(file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.changes))
    throw new Error('Evidence changes version 1 with changes is required.');
  for (const change of data.changes) {
    for (const key of ['id', 'since', 'affects', 'reason'])
      if (typeof change[key] !== 'string' || !change[key])
        throw new Error(`Evidence change ${change.id ?? '?'} lacks ${key}.`);
    change.sinceTime = Date.parse(change.since);
    if (!Number.isFinite(change.sinceTime))
      throw new Error(`Evidence change ${change.id} has an invalid since instant.`);
    // staleBefore (optional, default since): a change that reaches pages through a per-page output cache lands on
    // each page later than its write; captures older than staleBefore may still show the previous state.
    change.staleBeforeTime = change.staleBefore === undefined ? change.sinceTime : Date.parse(change.staleBefore);
    if (!Number.isFinite(change.staleBeforeTime) || change.staleBeforeTime < change.sinceTime)
      throw new Error(`Evidence change ${change.id} has an invalid staleBefore instant (must not precede since).`);
    if (!Array.isArray(change.proof) || !change.proof.length)
      throw new Error(`Evidence change ${change.id} needs proof scenario ids.`);
    if (!Array.isArray(change.signatures) || !change.signatures.length)
      throw new Error(`Evidence change ${change.id} needs signatures.`);
    change.affectsRegex = new RegExp(change.affects);
    for (const s of change.signatures) {
      if (!['request', 'response', 'dom', 'element', 'console'].includes(s.scope))
        throw new Error(`Evidence change ${change.id} has a signature with an unknown scope.`);
      s.fieldRegex = new RegExp(s.field ?? '.*');
      s.locationRegex = new RegExp(s.location ?? '.*');
      if (s.live !== undefined) s.liveRegex = new RegExp(s.live);
      if (s.mirage !== undefined) s.mirageRegex = new RegExp(s.mirage);
    }
  }
  return data;
}

/** After every scenario is compared: a change is accepted only when each proof scenario's live capture postdates
 * `since` and shows no unexplained delta of its signatures. A rejected change's stale deltas fall back to unexplained.
 * Returns the per-change summary for the report. */
export function finalizeEvidenceChanges(results, changes = []) {
  const byId = new Map(results.map((result) => [result.id, result]));
  const summary = {};
  for (const change of changes) {
    const proof = change.proof.map((id) => {
      const result = byId.get(id);
      if (!result) return { id, state: 'missing' };
      if (!Number.isFinite(result.liveCapturedAt) || result.liveCapturedAt < change.sinceTime)
        return { id, state: 'older than since' };
      if (result.verdict === 'error') return { id, state: 'not comparable' };
      return result.deltas.some((d) => !d.allowlist && matchesChange(d, change))
        ? { id, state: 'still shows the signature' }
        : { id, state: 'ok' };
    });
    const accepted = proof.every((p) => p.state === 'ok');
    let deltas = 0;
    const scenarios = new Set();
    for (const result of results)
      for (const item of result.deltas ?? []) {
        if (item.staleEvidence !== change.id) continue;
        if (accepted) {
          deltas++;
          scenarios.add(result.id);
        } else {
          delete item.staleEvidence;
          item.rejectedStaleEvidence = change.id;
        }
      }
    if (!accepted)
      for (const result of results)
        if (result.deltas?.some((d) => d.rejectedStaleEvidence === change.id)) tally(result);
    summary[change.id] = {
      status: accepted ? 'accepted' : 'rejected',
      since: change.since,
      scenarios: scenarios.size,
      deltas,
      proof,
      reason: change.reason,
    };
  }
  return summary;
}

export function summarize(report) {
  const totals = { pass: 0, allowed: 0, fail: 0, error: 0 };
  const bySignature = new Map();
  // Per live-run-variance entry over the paired scenarios: where it explains a Mirage delta, where
  // live-2 witnessed it, and the deltas (and scenarios) left unproven.
  const variance = {};
  const stat = (id) => (variance[id] ??= { paired: 0, witnessed: 0, unprovenScenarios: 0, unprovenDeltas: 0 });
  for (const scenario of report.scenarios) {
    const proof = scenario.counts?.variance;
    if (proof) {
      for (const id of proof.matched) stat(id).paired++;
      for (const id of proof.entries) stat(id).witnessed++;
      for (const [id, n] of Object.entries(proof.unproven)) {
        stat(id).unprovenScenarios++;
        stat(id).unprovenDeltas += n;
      }
    }
    totals[
      scenario.verdict === 'PASS'
        ? 'pass'
        : scenario.verdict === 'ALLOWED'
          ? 'allowed'
          : scenario.verdict === 'FAIL'
            ? 'fail'
            : 'error'
    ]++;
    for (const group of scenario.signatures ?? []) {
      const entry = bySignature.get(group.signature) ?? { ...group, scenarios: 0, count: 0 };
      entry.scenarios++;
      entry.count += group.count;
      bySignature.set(group.signature, entry);
    }
  }
  return {
    totals,
    variance,
    bySignature: [...bySignature.values()].sort((a, b) =>
      a.allowed === b.allowed ? b.count - a.count : a.allowed ? 1 : -1,
    ),
  };
}

export function summaryMarkdown(report) {
  const lines = [
    `# Baseline comparison ${report.generatedAt}`,
    '',
    `PASS ${report.totals.pass} · ALLOWED ${report.totals.allowed} · FAIL ${report.totals.fail} · ERROR ${report.totals.error}`,
    '',
    '| Scenario | Verdict | Deltas | Allowed | Unexplained |',
    '| --- | --- | ---: | ---: | ---: |',
  ];
  for (const scenario of report.scenarios)
    lines.push(
      `| ${scenario.id} | ${scenario.verdict} | ${scenario.counts.total} | ${scenario.counts.allowed} | ${scenario.counts.unexplained} |`,
    );
  const changes = Object.entries(report.evidenceChanges ?? {});
  if (changes.length) {
    lines.push(
      '',
      '## Evidence age (live captures older than a recorded live change)',
      '',
      '| Change | Status | Since | Scenarios | Stale deltas | Proof |',
      '| --- | --- | --- | ---: | ---: | --- |',
    );
    for (const [id, c] of changes)
      lines.push(
        `| ${id} | ${c.status} | ${c.since} | ${c.scenarios} | ${c.deltas} | ${c.proof.map((p) => `${p.id}: ${p.state}`).join('; ')} |`,
      );
  }
  const variance = Object.entries(report.variance ?? {});
  if (variance.length) {
    lines.push(
      '',
      '## Live-run variance proof (paired scenarios)',
      '',
      '| Entry | Paired | Witnessed | Unproven scenarios | Unproven deltas |',
      '| --- | ---: | ---: | ---: | ---: |',
    );
    for (const [id, v] of variance.sort(([a], [b]) => a.localeCompare(b)))
      lines.push(`| ${id} | ${v.paired} | ${v.witnessed} | ${v.unprovenScenarios} | ${v.unprovenDeltas} |`);
  }
  lines.push(
    '',
    '## Distinct differences (unexplained first)',
    '',
    '| Signature | Scope | Field | Scenarios | Count | Allowed | Example |',
    '| --- | --- | --- | ---: | ---: | --- | --- |',
  );
  for (const group of report.bySignature.slice(0, 200))
    lines.push(
      `| ${group.signature.slice(-12)} | ${group.scope} | ${group.field} | ${group.scenarios} | ${group.count} | ${group.allowed ? 'yes' : 'no'} | ${group.example.location.slice(0, 80)}: ${JSON.stringify(group.example.live).slice(0, 60)} vs ${JSON.stringify(group.example.mirage).slice(0, 60)} |`,
    );
  return lines.join('\n') + '\n';
}
