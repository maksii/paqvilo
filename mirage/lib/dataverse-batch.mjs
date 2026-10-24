// OData $batch for the simulated Dataverse Web API. Parses multipart/mixed
// batch requests and runs each embedded request through a caller-supplied
// dispatch function, so the router stays the single place that answers requests.
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { parseExactJson, stringifyExactJson } from './exact-numeric.mjs';

const MAX_REQUESTS = 1000;
const JSON_TYPE = 'application/json; odata.metadata=minimal; odata.streaming=true';
const FRAME_CODE = '0x80048d19';
const REFERENCE_CODE = '0x80040203';
const FRAME_ERROR = 'Stream was not readable.';
// The native wording after "InnerException" is a guess.
const JSON_BATCH =
  "Error identified in Payload provided by the user for Entity :''  ---->  InnerException : Batch content must be multipart/mixed.";
const MAX_URL = 65536; // assumed to count the path and query only, not the absolute URL
const URL_CODE = '0x80060888';
const ROLLBACK = Symbol('rollback');
// Matches "name@odata.bind": "$1" and "name@odata.id": "$1" values; group 3 is the Content-ID.
const REFERENCE = /("[^"\n]*@odata\.(bind|id)"\s*:\s*)"\$([^"/\s]+)"/g;

export const reasonPhrase = (status) => STATUS_CODES[status] ?? 'Unknown';

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'InvalidBatch', details: { innerCode: FRAME_CODE } });
}

function boundaryOf(contentType) {
  const match = /^multipart\/mixed\s*;\s*boundary=(?:"([^"]+)"|([^;\s"]+))/i.exec(contentType ?? '');
  if (!match) throw invalid('Batch boundary is missing or invalid.');
  return match[1] ?? match[2];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A line that reads as the delimiter of another multipart body (RFC 2046 bchars, optional close). Its text is never executed.
const FOREIGN_DELIMITER = /(^|\r?\n)--[0-9A-Za-z'()+_,\-./:=? ]+?(?:--)?[ \t]*(?=\r?\n|$)/;

// Splits on delimiter lines that match this boundary exactly (CRLF, the boundary, optional "--", padding, CRLF).
// A longer boundary that starts with this one is content, not a delimiter. Returns the text after each delimiter line.
// Only payload items that use the batch identifier are executed; a batch with none succeeds with nothing run.
function sections(text, boundary) {
  const framed = `\r\n${text}`;
  const delimiter = new RegExp(`\\r\\n--${escapeRegExp(boundary)}(--)?[ \\t]*(?=\\r\\n|$)`, 'g');
  const found = [...framed.matchAll(delimiter)];
  if (found.length === 0) {
    if (framed.includes(`\r\n--${boundary}`)) throw invalid(FRAME_ERROR); // declared delimiter without valid CRLF framing
    if (framed.includes('\r\n--')) return []; // parts for another boundary only: skipped, batch answers 200
    throw invalid(FRAME_ERROR); // no CRLF framing at all
  }
  const out = [];
  for (let i = 0; i < found.length - 1; i++) {
    if (found[i][1]) return out; // closing delimiter; epilogue ignored
    out.push(framed.slice(found[i].index + found[i][0].length + 2, found[i + 1].index));
  }
  if (found.at(-1)[1]) return out;
  throw invalid(FRAME_ERROR); // no closing delimiter
}

// ponytail: a request body with a line that starts with "--" is cut there. JSON bodies cannot have such a line.
// Ceiling: a raw text or binary body with such a line loses its tail. Upgrade if such bodies are needed.
const withoutForeignParts = (text) => {
  const cut = FOREIGN_DELIMITER.exec(text);
  return cut ? text.slice(0, cut.index) : text;
};

// Reads "Name: value" lines up to the first blank line (CRLF or LF); returns lowercased headers and the rest.
function readHeaders(text) {
  const headers = {};
  let i = 0;
  while (i < text.length) {
    let end = text.indexOf('\n', i);
    if (end < 0) end = text.length;
    const line = text.slice(i, end).replace(/\r$/, '');
    i = end + 1;
    if (line === '') return { headers, rest: text.slice(i) };
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, rest: '' };
}

// Parses one embedded HTTP request: request line, headers, then the raw body.
function httpRequest(text) {
  const end = text.indexOf('\n');
  const start = (end < 0 ? text : text.slice(0, end)).replace(/\r$/, '').trim();
  const match = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?$/.exec(start);
  if (!match) throw invalid(FRAME_ERROR);
  const { headers, rest } = readHeaders(end < 0 ? '' : text.slice(end + 1));
  return { method: match[1].toUpperCase(), url: match[2], headers, body: rest === '' ? undefined : rest };
}

// A section is either a changeset (multipart/mixed) or a request, optionally preceded by MIME headers.
function parseSection(section, inChangeset) {
  const mime = /^[A-Za-z][\w-]*:/.test(section) ? readHeaders(section) : { headers: {}, rest: section };
  const type = mime.headers['content-type'] ?? '';
  if (/^multipart\/mixed/i.test(type)) {
    if (inChangeset) throw invalid('Nested change sets are not allowed.');
    const boundary = boundaryOf(type);
    return { kind: 'changeset', boundary, requests: sections(mime.rest, boundary).map((s) => parseSection(s, true)) };
  }
  const request = httpRequest(withoutForeignParts(mime.rest));
  if (inChangeset && request.method === 'GET') throw invalid('GET requests are not allowed inside change sets.');
  const contentId = mime.headers['content-id'];
  return { kind: 'request', ...(contentId ? { contentId } : {}), ...request };
}

// JSON batch: {"requests":[{id,method,url,headers?,body?,atomicityGroup?,dependsOn?}]}. Native answers 200 in the multipart form,
// so the items run through the same dispatch as multipart parts. Items run in dependsOn order (array order otherwise).
// Consecutive members of an atomicityGroup remain one changeset after dependency ordering.
// Dependencies on any member constrain the complete transaction, never an individual commit.
// The JSON form is not documented; the messages for malformed JSON and unknown dependsOn or cycles are guesses.
function jsonItem(item) {
  if (!item || typeof item !== 'object' || typeof item.method !== 'string' || typeof item.url !== 'string')
    throw invalid(JSON_BATCH);
  const headers = {};
  for (const [name, value] of Object.entries(item.headers ?? {})) headers[name.toLowerCase()] = String(value);
  let body = item.body ?? undefined;
  if (body !== undefined && typeof body !== 'string') {
    body = stringifyExactJson(body);
    headers['content-type'] ??= 'application/json';
  }
  return {
    kind: 'request',
    method: item.method.toUpperCase(),
    url: item.url,
    headers,
    body,
    ...(item.id !== undefined ? { refId: String(item.id) } : {}),
    group: item.atomicityGroup == null ? null : String(item.atomicityGroup),
    dependsOn: [item.dependsOn ?? []].flat().map(String),
  };
}

function orderJson(items) {
  const ids = items.map((item) => item.refId).filter((id) => id !== undefined);
  if (new Set(ids).size !== ids.length) throw invalid('The batch contains a duplicate request id.'); // native message not known
  for (const item of items) {
    const missing = item.dependsOn.find((dep) => !ids.includes(dep));
    if (missing !== undefined) throw invalid(`The batch request depends on '${missing}', which is not in the batch.`); // native message not known
  }
  const units = [],
    groups = new Map(),
    owners = new Map();
  for (const item of items) {
    let unit = item.group === null ? null : groups.get(item.group);
    if (unit && unit !== units.at(-1)) throw invalid('Atomicity group members must be consecutive.');
    if (!unit) {
      unit = { items: [] };
      units.push(unit);
      if (item.group !== null) groups.set(item.group, unit);
    }
    unit.items.push(item);
    if (item.refId !== undefined) owners.set(item.refId, unit);
  }
  const ordered = [],
    completed = new Set();
  let pending = units;
  while (pending.length) {
    const unit = pending.find((unit) =>
      unit.items.every((item) =>
        item.dependsOn.every((dep) => owners.get(dep) === unit || completed.has(owners.get(dep))),
      ),
    );
    if (!unit) throw invalid('The batch dependsOn ordering contains a cycle.');
    const done = new Set();
    let members = unit.items;
    while (members.length) {
      const next = members.find((item) => item.dependsOn.every((dep) => owners.get(dep) !== unit || done.has(dep)));
      if (!next) throw invalid('The batch dependsOn ordering contains a cycle.');
      ordered.push(next);
      if (next.refId !== undefined) done.add(next.refId);
      members = members.filter((item) => item !== next);
    }
    completed.add(unit);
    pending = pending.filter((item) => item !== unit);
  }
  return ordered;
}

function parseJsonBatch(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  let payload;
  try {
    payload = parseExactJson(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalid(JSON_BATCH);
  }
  if (!Array.isArray(payload?.requests)) throw invalid(JSON_BATCH);
  const parts = [];
  let open = null; // the changeset of the current run of one atomicityGroup
  for (const { group, dependsOn, ...request } of orderJson(payload.requests.map(jsonItem))) {
    if (group === null) {
      parts.push(request);
      open = null;
      continue;
    }
    if (request.method === 'GET') throw invalid('GET requests are not allowed inside change sets.');
    if (open?.group === group) open.changeset.requests.push(request);
    else {
      open = { group, changeset: { kind: 'changeset', requests: [request] } };
      parts.push(open.changeset);
    }
  }
  return parts;
}

export function parseBatch(contentType, rawBody) {
  const checked = (parsed) => {
    const count = parsed.parts.reduce((n, part) => n + (part.kind === 'changeset' ? part.requests.length : 1), 0);
    if (count > MAX_REQUESTS) throw invalid(`The batch contains more than ${MAX_REQUESTS} requests.`);
    return parsed;
  };
  if (/^application\/json/i.test(contentType ?? ''))
    return checked({ boundary: null, json: true, parts: parseJsonBatch(rawBody) });
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const boundary = boundaryOf(contentType);
  return checked({ boundary, parts: sections(text, boundary).map((s) => parseSection(s, false)) });
}

const headerOf = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
const pathOf = (url) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
const badReference = (contentId) => ({
  status: 400,
  headers: {},
  body: {
    error: {
      code: REFERENCE_CODE,
      message: `Content-ID Reference: '$${contentId}' does not exist in the batch context.`,
    },
  },
});

// Runs one request. $n references resolve against entities created earlier in the same changeset.
// Relative URLs (JSON batches: "WhoAmI") resolve against the service root, which is base; absolute paths against origin.
async function execute(request, { dispatch, origin, base }, refs) {
  let url = request.url;
  const head = /^\$([^/?]+)/.exec(url);
  if (head) {
    const target = refs.get(head[1]);
    if (!target) return badReference(head[1]);
    url = target + url.slice(head[0].length);
  }
  if (url.length > MAX_URL) {
    return { status: 400, body: { error: { code: URL_CODE, message: 'Invalid URI: The Uri string is too long.' } } };
  }
  let body = request.body;
  if (body !== undefined) {
    let missing;
    body = body.replace(REFERENCE, (match, prefix, kind, contentId) => {
      const target = refs.get(contentId);
      if (!target) {
        missing ??= contentId;
        return match;
      }
      return `${prefix}"${kind === 'bind' ? pathOf(target) : target}"`;
    });
    if (missing !== undefined) return badReference(missing);
  }
  try {
    return await dispatch({
      method: request.method,
      url: new URL(url, base ?? origin).href,
      headers: request.headers,
      body,
    });
  } catch (error) {
    return {
      status: error.status ?? 500,
      body: { error: { code: error.code ?? 'InternalError', message: error.message } },
    };
  }
}

// A created entity is referenced as $<Content-ID>, or $<id> for a JSON batch item.
const remember = (refs, request, response) => {
  const key = request.contentId ?? request.refId;
  const entity = headerOf(response.headers, 'odata-entityid');
  if (key && entity) refs.set(key, entity);
};

// batchRefs: references the batch has committed so far. A rolled-back changeset publishes none of its own.
async function runChangeset(changeset, context, batchRefs = new Map()) {
  const responses = [];
  const refs = new Map(batchRefs);
  const run = async () => {
    for (const request of changeset.requests) {
      const response = await execute(request, context, refs);
      responses.push({ request, response });
      if (response.status >= 400) throw ROLLBACK;
      remember(refs, request, response);
    }
  };
  try {
    // ponytail: without a dispatch.transaction hook, writes made before a failing changeset item persist.
    if (context.dispatch.transaction) await context.dispatch.transaction(run);
    else await run();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  const failure = responses.find(({ response }) => response.status >= 400);
  if (!failure) for (const [key, entity] of refs) batchRefs.set(key, entity);
  return { responses, failure };
}

const mimeLines = (contentId) => [
  'Content-Type: application/http',
  'Content-Transfer-Encoding: binary',
  ...(contentId ? [`Content-ID: ${contentId}`] : []),
];

const partOf = (boundary, mime, content) =>
  `--${boundary}\r\n${mime.map((line) => `${line}\r\n`).join('')}\r\n${content}\r\n`;

// Envelope headers that a top-level answer carries but a native batch part does not: the service request ids and dop
// hint, expires, Allow, Public, the transport headers and CORS. REQ_ID is not here: the dispatch supplies it on entity-engine errors only.
const PART_ENVELOPE =
  /^(x-ms-|expires$|allow$|public$|strict-transport-security$|access-control-|connection$|keep-alive$|set-cookie$)/i;
// The JSON type a native multipart part carries; a JSON batch answers with streaming too.
const PART_JSON_TYPE = 'application/json; odata.metadata=minimal';

function httpBlock(response, { json = false } = {}) {
  const headers = new Map();
  const set = (name, value) => headers.set(name.toLowerCase(), [name, String(value)]);
  // A native error part carries no Cache-Control; the no-cache pair is for reads.
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    if (value === undefined || value === null || PART_ENVELOPE.test(name)) continue;
    if (response.status >= 400 && /^cache-control$/i.test(name)) continue;
    set(name, value);
  }
  const body = response.body ?? undefined;
  const text = body === undefined || typeof body === 'string' ? body : stringifyExactJson(body);
  if (text && !headers.has('content-type')) set('Content-Type', json ? JSON_TYPE : PART_JSON_TYPE);
  if (!headers.has('odata-version')) set('OData-Version', '4.0');
  if (response.status < 400) {
    // Native answers each successful part with nosniff. An entity read (one with an ETag) also carries the no-cache pair
    // (seen on record reads only; other entity responses are assumed alike); a WhoAmI part carries neither.
    if (!headers.has('x-content-type-options')) set('X-Content-Type-Options', 'nosniff');
    if (headers.has('etag')) {
      if (!headers.has('cache-control')) set('Cache-Control', 'no-cache');
      if (!headers.has('pragma')) set('Pragma', 'no-cache');
    }
  }
  const entity = headers.get('odata-entityid')?.[1];
  if (response.status === 204 && entity && !headers.has('location')) set('Location', entity);
  const lines = [
    `HTTP/1.1 ${response.status} ${reasonPhrase(response.status)}`,
    ...[...headers.values()].map(([n, v]) => `${n}: ${v}`),
  ];
  return `${lines.join('\r\n')}\r\n\r\n${text ?? ''}`;
}

function changesetPart(boundary, responses, json) {
  const inner = `changesetresponse_${randomUUID()}`;
  const parts = responses
    .map(({ request, response }) => partOf(inner, mimeLines(request.contentId), httpBlock(response, { json })))
    .join('');
  return partOf(boundary, [`Content-Type: multipart/mixed; boundary=${inner}`], `${parts}--${inner}--\r\n`);
}

function result(boundary, status, blocks) {
  // Native: a failed batch answers nosniff on the outer response too.
  const nosniff = status >= 400 ? { 'x-content-type-options': 'nosniff' } : {};
  return {
    status,
    headers: { 'content-type': `multipart/mixed; boundary=${boundary}`, 'OData-Version': '4.0', ...nosniff },
    body: `${blocks.join('')}--${boundary}--\r\n`,
  };
}

export async function executeBatch(parsed, { dispatch, origin, base, continueOnError = false } = {}) {
  const boundary = `batchresponse_${randomUUID()}`;
  const context = { dispatch, origin, base };
  const json = parsed.json === true;
  // A JSON batch shares its references across items; a multipart part scopes them to its own changeset.
  const shared = new Map();
  const blocks = [];
  // Without continue-on-error the batch stops at the first failing part and keeps the parts that already ran, as natively.
  for (const part of parsed.parts) {
    const refs = parsed.json ? shared : new Map();
    if (part.kind === 'request') {
      const response = await execute(part, context, refs);
      remember(refs, part, response);
      // Native echoes Content-ID only inside a changeset: a top-level part answers without one.
      const block = partOf(boundary, mimeLines(), httpBlock(response, { json }));
      blocks.push(block);
      if (response.status >= 400 && !continueOnError) return result(boundary, response.status, blocks);
    } else {
      const { responses, failure } = await runChangeset(part, context, refs);
      // A failed changeset answers as a changeset part holding the failing response (rollback), Content-ID kept.
      if (failure && !continueOnError)
        return result(boundary, failure.response.status, [...blocks, changesetPart(boundary, [failure], json)]);
      blocks.push(changesetPart(boundary, responses, json));
    }
  }
  return result(boundary, 200, blocks);
}
