// OData $batch for the simulated Dataverse Web API. Parses multipart/mixed
// batch requests and runs each embedded request through a caller-supplied
// dispatch function, so the router stays the single place that answers requests.
import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";

const MAX_REQUESTS = 1000;
const JSON_TYPE = "application/json; odata.metadata=minimal; odata.streaming=true";
const FRAME_CODE = "0x80048d19";
const REFERENCE_CODE = "0x80040203";
const FRAME_ERROR = "Stream was not readable.";
const ROLLBACK = Symbol("rollback");
// Matches "name@odata.bind": "$1" and "name@odata.id": "$1" values; group 3 is the Content-ID.
const REFERENCE = /("[^"\n]*@odata\.(bind|id)"\s*:\s*)"\$([^"/\s]+)"/g;

export const reasonPhrase = (status) => STATUS_CODES[status] ?? "Unknown";

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: "InvalidBatch", details: { innerCode: FRAME_CODE } });
}

function boundaryOf(contentType) {
  const match = /^multipart\/mixed\s*;\s*boundary=(?:"([^"]+)"|([^;\s"]+))/i.exec(contentType ?? "");
  if (!match) throw invalid("Batch boundary is missing or invalid.");
  return match[1] ?? match[2];
}

// Splits on CRLF-delimited boundary lines and returns the text after each delimiter line.
function sections(text, boundary) {
  const chunks = `\r\n${text}`.split(`\r\n--${boundary}`);
  const out = [];
  for (const chunk of chunks.slice(1)) {
    const eol = chunk.indexOf("\r\n");
    const line = eol < 0 ? chunk : chunk.slice(0, eol);
    if (line.trimEnd() === "--") return out; // closing delimiter; epilogue ignored
    if (eol < 0 || line.trim() !== "") throw invalid(FRAME_ERROR);
    out.push(chunk.slice(eol + 2));
  }
  throw invalid(FRAME_ERROR); // no closing delimiter, or no delimiter matching the boundary
}

// Reads "Name: value" lines up to the first blank line (CRLF or LF); returns lowercased headers and the rest.
function readHeaders(text) {
  const headers = {};
  let i = 0;
  while (i < text.length) {
    let end = text.indexOf("\n", i);
    if (end < 0) end = text.length;
    const line = text.slice(i, end).replace(/\r$/, "");
    i = end + 1;
    if (line === "") return { headers, rest: text.slice(i) };
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, rest: "" };
}

// Parses one embedded HTTP request: request line, headers, then the raw body.
function httpRequest(text) {
  const end = text.indexOf("\n");
  const start = (end < 0 ? text : text.slice(0, end)).replace(/\r$/, "").trim();
  const match = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/\d(?:\.\d)?)?$/.exec(start);
  if (!match) throw invalid(FRAME_ERROR);
  const { headers, rest } = readHeaders(end < 0 ? "" : text.slice(end + 1));
  return { method: match[1].toUpperCase(), url: match[2], headers, body: rest === "" ? undefined : rest };
}

// A section is either a changeset (multipart/mixed) or a request, optionally preceded by MIME headers.
function parseSection(section, inChangeset) {
  const mime = /^[A-Za-z][\w-]*:/.test(section) ? readHeaders(section) : { headers: {}, rest: section };
  const type = mime.headers["content-type"] ?? "";
  if (/^multipart\/mixed/i.test(type)) {
    if (inChangeset) throw invalid("Nested change sets are not allowed.");
    const boundary = boundaryOf(type);
    return { kind: "changeset", boundary, requests: sections(mime.rest, boundary).map((s) => parseSection(s, true)) };
  }
  const request = httpRequest(mime.rest);
  if (inChangeset && request.method === "GET") throw invalid("GET requests are not allowed inside change sets.");
  const contentId = mime.headers["content-id"];
  return { kind: "request", ...(contentId ? { contentId } : {}), ...request };
}

export function parseBatch(contentType, rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
  const boundary = boundaryOf(contentType);
  const parts = sections(text, boundary).map((s) => parseSection(s, false));
  const count = parts.reduce((n, part) => n + (part.kind === "changeset" ? part.requests.length : 1), 0);
  if (count > MAX_REQUESTS) throw invalid(`The batch contains more than ${MAX_REQUESTS} requests.`);
  return { boundary, parts };
}

const headerOf = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
const pathOf = (url) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
const badReference = (contentId) => ({
  status: 400,
  headers: {},
  body: { error: { code: REFERENCE_CODE, message: `Content-ID Reference: '$${contentId}' does not exist in the batch context.` } },
});

// Runs one request. $n references resolve against entities created earlier in the same changeset.
async function execute(request, { dispatch, origin }, refs) {
  let url = request.url;
  const head = /^\$([^/?]+)/.exec(url);
  if (head) {
    const target = refs.get(head[1]);
    if (!target) return badReference(head[1]);
    url = target + url.slice(head[0].length);
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
      return `${prefix}"${kind === "bind" ? pathOf(target) : target}"`;
    });
    if (missing !== undefined) return badReference(missing);
  }
  try {
    return await dispatch({ method: request.method, url: new URL(url, origin).href, headers: request.headers, body });
  } catch (error) {
    return { status: error.status ?? 500, body: { error: { code: error.code ?? "InternalError", message: error.message } } };
  }
}

async function runChangeset(changeset, context) {
  const refs = new Map();
  const responses = [];
  const run = async () => {
    for (const request of changeset.requests) {
      const response = await execute(request, context, refs);
      responses.push({ request, response });
      if (response.status >= 400) throw ROLLBACK;
      const entity = headerOf(response.headers, "odata-entityid");
      if (request.contentId && entity) refs.set(request.contentId, entity);
    }
  };
  try {
    // ponytail: without a dispatch.transaction hook, writes made before a failing changeset item persist.
    if (context.dispatch.transaction) await context.dispatch.transaction(run);
    else await run();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return { responses, failure: responses.find(({ response }) => response.status >= 400) };
}

const mimeLines = (contentId) => [
  "Content-Type: application/http",
  "Content-Transfer-Encoding: binary",
  ...(contentId ? [`Content-ID: ${contentId}`] : []),
];

const partOf = (boundary, mime, content) => `--${boundary}\r\n${mime.map((line) => `${line}\r\n`).join("")}\r\n${content}\r\n`;

function httpBlock(response, requestId) {
  const headers = new Map();
  const set = (name, value) => headers.set(name.toLowerCase(), [name, String(value)]);
  for (const [name, value] of Object.entries(response.headers ?? {})) if (value !== undefined && value !== null) set(name, value);
  const body = response.body ?? undefined;
  const text = body === undefined || typeof body === "string" ? body : JSON.stringify(body);
  if (text && !headers.has("content-type")) set("Content-Type", JSON_TYPE);
  if (!headers.has("odata-version")) set("OData-Version", "4.0");
  const entity = headers.get("odata-entityid")?.[1];
  if (response.status === 204 && entity && !headers.has("location")) set("Location", entity);
  if (response.status >= 400 && !headers.has("req_id")) set("REQ_ID", requestId);
  const lines = [`HTTP/1.1 ${response.status} ${reasonPhrase(response.status)}`, ...[...headers.values()].map(([n, v]) => `${n}: ${v}`)];
  return `${lines.join("\r\n")}\r\n\r\n${text ?? ""}`;
}

function changesetPart(boundary, responses, requestId) {
  const inner = `changesetresponse_${randomUUID()}`;
  const parts = responses.map(({ request, response }) => partOf(inner, mimeLines(request.contentId), httpBlock(response, requestId))).join("");
  return partOf(boundary, [`Content-Type: multipart/mixed; boundary=${inner}`], `${parts}--${inner}--\r\n`);
}

function result(boundary, status, blocks) {
  return {
    status,
    headers: { "content-type": `multipart/mixed; boundary=${boundary}`, "OData-Version": "4.0" },
    body: `${blocks.join("")}--${boundary}--\r\n`,
  };
}

export async function executeBatch(parsed, { dispatch, origin, continueOnError = false, requestId } = {}) {
  const reqId = requestId ?? randomUUID();
  const boundary = `batchresponse_${randomUUID()}`;
  const context = { dispatch, origin };
  const blocks = [];
  for (const part of parsed.parts) {
    if (part.kind === "request") {
      const response = await execute(part, context, new Map());
      const block = partOf(boundary, mimeLines(part.contentId), httpBlock(response, reqId));
      if (response.status >= 400 && !continueOnError) return result(boundary, response.status, [block]);
      blocks.push(block);
    } else {
      const { responses, failure } = await runChangeset(part, context);
      if (failure && !continueOnError) {
        const { request, response } = failure;
        return result(boundary, response.status, [partOf(boundary, mimeLines(request.contentId), httpBlock(response, reqId))]);
      }
      blocks.push(changesetPart(boundary, responses, reqId));
    }
  }
  return result(boundary, 200, blocks);
}
