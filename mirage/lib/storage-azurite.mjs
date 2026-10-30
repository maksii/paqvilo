// Azurite storage provider: the storage contract over the Azure Blob REST API with native fetch and Shared Key
// authorization (node:crypto). Loopback endpoints only; Paqvilo never starts Azurite. The account key lives in this
// module's closure only: never in descriptors, state, diagnostics, errors or /_sim payloads.
// Blob REST reference: https://learn.microsoft.com/rest/api/storageservices/blob-service-rest-api; Azurite differences:
// https://learn.microsoft.com/azure/storage/common/storage-use-azurite#differences-between-azurite-and-azure-storage
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ProviderError, STORAGE_OPERATIONS, validateKey } from './storage-provider.mjs';
import { isLoopbackUrl, loopbackFetch } from './dataverse-webhooks.mjs';
import { clockFunction, systemClock } from './runtime-clock.mjs';
import { tracedFetch } from './trace-hosts.mjs';

/** x-ms-version pinned for every request and the SAS `sv` (listed in "Previous Azure Storage service versions"). */
export const BLOB_API_VERSION = '2021-08-06';
// The documented Azurite well-known account (storage-connect-azurite): a public test credential, not a secret.
const DEVELOPMENT = Object.freeze({
  accountName: 'devstoreaccount1',
  blobEndpoint: 'http://127.0.0.1:10000/devstoreaccount1',
  accountKey: 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
});
// ponytail: an upload is buffered one 4 MiB block at a time; raise BLOCK_SIZE (Put Block accepts up to 4000 MiB from 2019-12-12) if throughput matters.
const BLOCK_SIZE = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Learn: metadata names follow C# identifier rules (ASCII letters, digits, underscore; not starting with a digit).
const METADATA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const START_HINT = 'Start it outside Paqvilo, for example: npx azurite --location .paqvilo/azurite';

const NOTES = Object.freeze([
  `Blob REST over native fetch with Shared Key authorization, x-ms-version ${BLOB_API_VERSION}; loopback endpoints only. The account key stays in memory, never in state, diagnostics or /_sim payloads.`,
  'One container per storage id (providers.storage.<id>.container, default paqvilo), created on first write.',
  'Uploads above 4 MiB are staged with Put Block and committed with Put Block List; metadata names come back lower-case; commit() reports no sha256.',
  'sas() returns a service SAS (sr=b) signed with the account key that addresses the Azurite endpoint directly.',
  'Azurite supports Blob, Queue and Table (Table in preview); it does not support Azure Files or Data Lake Storage Gen2.',
  'Error status codes align with Azure Storage; error messages can differ.',
  'No scale or performance guarantee; not for large numbers of connected clients.',
  'Default Blob endpoint http://127.0.0.1:10000/<account>; Paqvilo never starts Azurite (start: external).',
]);
const descriptorOf = (id, level) =>
  Object.freeze({
    id,
    name: 'storage:azurite',
    kind: 'azurite',
    version: '1',
    level,
    operations: Object.freeze([...STORAGE_OPERATIONS]),
    requires: Object.freeze(['external-process:azurite', 'secret:connectionString']),
    principal: 'connection',
    stateOwner: 'external',
    lifecycle: 'external-process',
    fidelity: Object.freeze({ notes: NOTES }),
  });
/** The kind's capability record before configuration: contract. An instance with a usable connection string is behaviour. */
export const azuriteDescriptor = descriptorOf('azurite', 'contract');

/**
 * Parses an Azure Storage connection string: `UseDevelopmentStorage=true` (the Azurite well-known account) or the explicit
 * `AccountName=…;AccountKey=…;BlobEndpoint=…` form. Returns { accountName, accountKey, blobEndpoint } or { error: { message,
 * diagnostic } }; messages name `source` (where it is configured), never the value or a non-loopback host.
 */
export function parseConnectionString(text, source = 'the connection string') {
  const parts = new Map();
  for (const part of String(text ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) parts.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  const invalid = (message, diagnostic = 'PROVIDER_CONNECTION_STRING_INVALID') => ({ error: { message, diagnostic } });
  if (/^true$/i.test(parts.get('usedevelopmentstorage') ?? '')) {
    if (parts.has('developmentstorageproxyuri'))
      return invalid(`DevelopmentStorageProxyUri in ${source} is not supported.`);
    return { ...DEVELOPMENT };
  }
  const blobEndpoint = parts.get('blobendpoint');
  if (!blobEndpoint) return invalid(`The connection string in ${source} names no BlobEndpoint.`);
  let url;
  try {
    url = new URL(blobEndpoint);
  } catch {
    return invalid(`BlobEndpoint in ${source} is not a URL.`, 'PROVIDER_ENDPOINT_INVALID');
  }
  if (!isLoopbackUrl(url.href))
    return invalid(`BlobEndpoint in ${source} is not loopback; live storage is refused.`, 'PROVIDER_NOT_LOOPBACK');
  if (url.search || url.hash || url.username || url.password)
    return invalid(`BlobEndpoint in ${source} must not carry a query or credentials.`, 'PROVIDER_ENDPOINT_INVALID');
  const accountName = parts.get('accountname'),
    accountKey = parts.get('accountkey');
  if (!accountName || !/^[A-Za-z0-9-]{1,64}$/.test(accountName))
    return invalid(`AccountName in ${source} is missing or invalid.`);
  if (!accountKey || !BASE64.test(accountKey)) return invalid(`AccountKey in ${source} is missing or not base64.`);
  return { accountName, accountKey, blobEndpoint: url.href.replace(/\/+$/, '') };
}

// Shared Key (Blob, 2009-09-19 and later): the standard headers in this order, values only, one line each.
const SIGNED_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-md5',
  'content-type',
  'date',
  'if-modified-since',
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'range',
];
/**
 * The Shared Key StringToSign of a Blob request (authorize-with-shared-key): VERB, the standard header values (Content-Length
 * empty when zero, 2015-02-21 and later), CanonicalizedHeaders (x-ms-* lower-cased, sorted, linear whitespace folded) and
 * CanonicalizedResource (/<account><encoded URI path>, then each lower-cased query name sorted as \nname:value, values
 * URL-decoded and sorted, comma-joined). Against an emulator the account appears twice, as Learn notes.
 */
export function sharedKeyStringToSign({ method, url, headers = {}, accountName }) {
  const h = new Headers(headers);
  const standard = SIGNED_HEADERS.map((name) => {
    const value = h.get(name) ?? '';
    return name === 'content-length' && value === '0' ? '' : value;
  });
  // Array.prototype.sort compares UTF-16 code units: ordinal (ASCII) order for header names, as the spec's lexicographic sort.
  // The service's comparer for names with '_' or '-' next to letters (ordinal vs culture order) is not known.
  const canonicalHeaders = [...h.keys()]
    .filter((name) => name.startsWith('x-ms-'))
    .sort()
    .map((name) => `${name}:${h.get(name).replace(/\s+/g, ' ').trim()}\n`)
    .join('');
  const target = new URL(url);
  const params = new Map();
  for (const [name, value] of target.searchParams)
    params.set(name.toLowerCase(), [...(params.get(name.toLowerCase()) ?? []), value]);
  const query = [...params.keys()]
    .sort()
    .map((name) => `\n${name}:${params.get(name).sort().join(',')}`)
    .join('');
  return `${[method.toUpperCase(), ...standard].join('\n')}\n${canonicalHeaders}/${accountName}${target.pathname}${query}`;
}
const hmac = (accountKey, text) =>
  createHmac('sha256', Buffer.from(accountKey, 'base64')).update(text, 'utf8').digest('base64');

const decodeXml = (text) =>
  text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]);
const xmlValue = (xml, tag) => {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]) : null;
};
const iso = (text) => {
  const time = Date.parse(text ?? '');
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
// List Blobs may return <Etag> without quotes while the ETag header is quoted; quoting both keeps them comparable.
const quoted = (etag) => (etag && !etag.startsWith('"') ? `"${etag}"` : etag);
const sasTime = (time) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * createAzuriteStorage({ id, settings: { connectionString: 'env:NAME', container }, env, clock }) → storage provider.
 * The connection string is read from `env` once, here; a missing, invalid or non-loopback one leaves an instance at level
 * contract whose operations answer Unavailable with the reason and whose preflight() reports it. ponytail: restart the host
 * to pick up a changed connection string.
 */
export function createAzuriteStorage({
  id = 'azurite',
  settings = {},
  env = process.env,
  clock = systemClock,
  // The runtime's trace store, or a function answering it (read per request): each Blob request is an http-out span.
  traces = null,
} = {}) {
  const now = clockFunction(clock);
  const container = settings.container ?? 'paqvilo';
  const variable = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(settings.connectionString ?? '')?.[1] ?? null;
  const raw = variable ? env?.[variable] : null;
  const config = !variable
    ? {
        error: {
          message: `Storage provider '${id}' needs connectionString env:NAME.`,
          diagnostic: 'PROVIDER_CONNECTION_STRING_INVALID',
        },
      }
    : !raw
      ? { error: { message: `Environment variable ${variable} is not set.`, diagnostic: 'PROVIDER_SECRET_MISSING' } }
      : parseConnectionString(raw, variable);
  const { accountName, accountKey, blobEndpoint } = config.error ? {} : config;
  const shown = blobEndpoint ?? '';
  // Every request is bounded: providers.storage.<id>.timeoutMs (default 30 s) until the response headers arrive.
  const requestTimeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let closed = false,
    containerReady = null;
  // Last observed endpoint state for the host graph (health()): null until a request or preflight ran.
  let health = config.error
    ? { ready: false, reason: config.error.message }
    : { ready: null, reason: 'Not contacted yet.' };

  const fail = (code, message, diagnostic) => new ProviderError(code, message, { provider: id, diagnostic });
  // The endpoint of a usable connection string; every URL is built through it, so an unusable one answers Unavailable first.
  const endpoint = () => {
    if (config.error) throw fail('Unavailable', config.error.message, config.error.diagnostic);
    return blobEndpoint;
  };
  const blobUrl = (key, query) => {
    const url = new URL(`${endpoint()}/${container}/${key.split('/').map(encodeURIComponent).join('/')}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url.href;
  };

  // One authorized request. x-ms-date is wall time (the service rejects a request older than 15 minutes), not the runtime clock.
  async function send(method, url, { headers = {}, body, signal, timeoutMs } = {}) {
    if (closed) throw fail('Unavailable', `Storage provider '${id}' is closed.`);
    endpoint();
    const all = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': BLOB_API_VERSION, ...headers };
    const signed = { ...all, 'content-length': body?.length ? String(body.length) : '' };
    all.authorization = `SharedKey ${accountName}:${hmac(accountKey, sharedKeyStringToSign({ method, url, headers: signed, accountName }))}`;
    // The timer bounds the wait for response headers only, so a long streamed download is not cut off.
    const limit = timeoutMs ?? requestTimeoutMs,
      timer = new AbortController();
    const timeout = setTimeout(
      () => timer.abort(new DOMException(`no answer within ${limit} ms`, 'TimeoutError')),
      limit,
    );
    try {
      // Each Blob request is an http-out span of the current trace (D-R3-5): blob bytes are never captured, the span names
      // the provider, container and size. The forwarded trace headers are not x-ms-* headers, so the signature is unchanged.
      const response = await tracedFetch(typeof traces === 'function' ? traces() : traces, {
        module: 'storage',
        operation: method.toLowerCase(),
        url,
        init: { method, headers: all, body, signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal },
        capture: 'none',
        attributes: { provider: id, container, ...(body?.length ? { bytes: body.length } : {}) },
        fetch: loopbackFetch,
      });
      health =
        response.status === 401 || response.status === 403
          ? {
              ready: false,
              reason: `Azurite refused the account key (${response.status} ${response.headers.get('x-ms-error-code') ?? 'no error code'}).`,
            }
          : { ready: true, reason: null };
      return response;
    } catch (error) {
      if (signal?.aborted) throw error;
      const refused =
        error?.code === 'InvalidRequest'
          ? fail(
              'Unavailable',
              `BlobEndpoint in ${variable} does not resolve to loopback; live storage is refused.`,
              'PROVIDER_NOT_LOOPBACK',
            )
          : Object.assign(
              fail(
                'Unavailable',
                `Azurite is not reachable at ${shown} (${
                  timer.signal.aborted
                    ? `no answer within ${limit} ms`
                    : (error?.cause?.code ?? error?.code ?? 'connection failed')
                }). ${START_HINT}`,
                'PROVIDER_UNREACHABLE',
              ),
              { cause: error },
            );
      health = { ready: false, reason: refused.message };
      throw refused;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Azure error code (x-ms-error-code, 2017-07-29 and later, else the <Code> element) → ProviderError. One mapping for every operation.
  async function failure(response, operation, { ifMatch, ifNoneMatch, blockList = false } = {}) {
    const text = response.headers.get('x-ms-error-code') ? '' : await response.text().catch(() => '');
    await response.body?.cancel().catch(() => {});
    const azure = response.headers.get('x-ms-error-code') ?? xmlValue(text, 'Code') ?? `Http${response.status}`;
    const message = `Azure Blob ${operation} answered ${response.status} ${azure}.`;
    const status = response.status;
    // Learn: an unmet If-None-Match on a write is 412; a create-only write (If-None-Match: *) is the contract's Conflict.
    // Azurite may answer 412 ConditionNotMet or 409 BlobAlreadyExists for Put Blob with If-None-Match: *; both are Conflict.
    if ((status === 412 || azure === 'BlobAlreadyExists') && ifNoneMatch === '*')
      return fail('Conflict', message, azure);
    if (status === 412) return fail('PreconditionFailed', message, azure);
    // A conditional write on a missing blob fails its condition (the contract), whatever 404 the service gives.
    if (status === 404) return fail(ifMatch !== undefined ? 'PreconditionFailed' : 'NotFound', message, azure);
    if (status === 409) return fail('Conflict', message, azure);
    if (status === 416) return fail('InvalidRange', message, azure);
    if (status === 401 || status === 403) return fail('Unauthorized', message, azure);
    if (status === 413) return fail('TooLarge', message, azure);
    // Learn (Put Block List): a listed block that was not staged is 400 InvalidBlockList.
    if (status === 400 && blockList && azure === 'InvalidBlockList')
      return fail('NotFound', `${message} A committed block was not staged for this key.`, azure);
    if (status === 400) return fail('Unsupported', message, azure);
    return fail('Unavailable', message, azure);
  }

  const ensureContainer = () =>
    (containerReady ??= (async () => {
      const response = await send('PUT', `${endpoint()}/${container}?restype=container`);
      await response.body?.cancel().catch(() => {});
      if (response.status !== 201 && response.headers.get('x-ms-error-code') !== 'ContainerAlreadyExists')
        throw await failure(response, 'Create Container');
    })().catch((error) => {
      containerReady = null;
      throw error;
    }));

  const conditions = ({ ifMatch, ifNoneMatch } = {}) => ({
    ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}),
    ...(ifNoneMatch !== undefined ? { 'if-none-match': ifNoneMatch } : {}),
  });
  const metadataHeaders = (metadata = {}) => {
    const headers = {};
    for (const [name, value] of Object.entries(metadata ?? {})) {
      if (!METADATA_NAME.test(name) || typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value))
        throw fail('InvalidKey', 'Blob metadata names must be C# identifiers and values printable ASCII.');
      headers[`x-ms-meta-${name}`] = value;
    }
    return headers;
  };
  const meta = (key, headers, size = Number(headers.get('content-length') ?? 0)) => ({
    key,
    size,
    etag: quoted(headers.get('etag')),
    lastModified: iso(headers.get('last-modified')),
    contentType: headers.get('content-type') ?? 'application/octet-stream',
    metadata: Object.fromEntries(
      [...headers].filter(([name]) => name.startsWith('x-ms-meta-')).map(([name, value]) => [name.slice(10), value]),
    ),
  });
  // Block ids: base64 of a SHA-256 so every id of a blob has the same length (Learn: Put Block).
  const blockIdOf = (text) => createHash('sha256').update(text).digest('base64');
  const chunksOf = (body) => {
    const chunks = Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string' ? [body] : body;
    if (
      !chunks ||
      (typeof chunks[Symbol.asyncIterator] !== 'function' && typeof chunks[Symbol.iterator] !== 'function')
    )
      throw fail('InvalidKey', 'Storage body must be a Buffer or an AsyncIterable of Buffers.');
    return chunks;
  };
  // A write: request() sends it (re-signed per attempt). A container removed after it was created (Azurite restarted
  // in memory) answers 404 ContainerNotFound: the container is created again and the write retried once.
  const write = async (request, statuses, operation, options) => {
    let response = await request();
    if (response.status === 404 && response.headers.get('x-ms-error-code') === 'ContainerNotFound') {
      await response.body?.cancel().catch(() => {});
      containerReady = null;
      await ensureContainer();
      response = await request();
    }
    if (!statuses.includes(response.status)) throw await failure(response, operation, options);
    await response.body?.cancel().catch(() => {});
    return response;
  };
  const putBlock = (key, blockId, data, signal) =>
    write(
      () => send('PUT', blobUrl(key, { comp: 'block', blockid: blockId }), { body: data, signal }),
      [201],
      'Put Block',
    );
  const putBlockList = async (key, blockIds, options) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds.map((blockId) => `<Latest>${blockId}</Latest>`).join('')}</BlockList>`;
    const headers = {
      'content-type': 'application/xml',
      'x-ms-blob-content-type': options.contentType ?? 'application/octet-stream',
      ...metadataHeaders(options.metadata),
      ...conditions(options),
    };
    await write(
      () =>
        send('PUT', blobUrl(key, { comp: 'blocklist' }), { headers, body: Buffer.from(xml), signal: options.signal }),
      [201],
      'Put Block List',
      { ...options, blockList: true },
    );
  };

  async function head(key) {
    const response = await send('HEAD', blobUrl(key));
    if (response.status === 404) return null;
    if (response.status !== 200) throw await failure(response, 'Get Blob Properties');
    return meta(key, response.headers);
  }

  const provider = {
    descriptor: descriptorOf(id, config.error ? 'contract' : 'behaviour'),

    async put(key, body, options = {}) {
      key = validateKey(key, id);
      const chunks = chunksOf(body);
      metadataHeaders(options.metadata);
      await ensureContainer();
      if (options.blockId !== undefined) {
        if (typeof options.blockId !== 'string' || !options.blockId || options.blockId.length > 1024)
          throw fail('InvalidKey', 'Block id must be a non-empty string up to 1024 characters.');
        const parts = [];
        for await (const part of chunks) parts.push(Buffer.from(part)); // copies: a producer may reuse its buffer
        const data = Buffer.concat(parts);
        await putBlock(key, blockIdOf(`block:${options.blockId}`), data, options.signal);
        return { key, blockId: options.blockId, size: data.length };
      }
      const hash = createHash('sha256'),
        staged = [],
        upload = randomUUID();
      let pending = [],
        pendingBytes = 0,
        size = 0;
      // Stages exactly BLOCK_SIZE bytes (the remainder stays pending); `all` stages whatever is left as the last block.
      const stage = async (all = false) => {
        const data = Buffer.concat(pending);
        const block = all ? data : data.subarray(0, BLOCK_SIZE);
        const blockId = blockIdOf(`put:${upload}:${staged.length}`);
        await putBlock(key, blockId, block, options.signal);
        staged.push(blockId);
        pending = block.length < data.length ? [data.subarray(block.length)] : [];
        pendingBytes = data.length - block.length;
      };
      for await (const part of chunks) {
        options.signal?.throwIfAborted();
        const chunk = Buffer.from(part); // copies: a producer may reuse its buffer
        hash.update(chunk);
        size += chunk.length;
        pending.push(chunk);
        pendingBytes += chunk.length;
        while (pendingBytes > BLOCK_SIZE) await stage();
      }
      const contentType = options.contentType ?? 'application/octet-stream';
      if (!staged.length) {
        const headers = {
          'x-ms-blob-type': 'BlockBlob',
          'content-type': contentType,
          ...metadataHeaders(options.metadata),
          ...conditions(options),
        };
        const data = Buffer.concat(pending);
        const response = await write(
          () => send('PUT', blobUrl(key), { headers, body: data, signal: options.signal }),
          [201],
          'Put Blob',
          options,
        );
        return {
          key,
          size,
          sha256: hash.digest('hex'),
          etag: quoted(response.headers.get('etag')),
          lastModified: iso(response.headers.get('last-modified')),
          contentType,
          metadata: { ...(options.metadata ?? {}) },
        };
      }
      if (pendingBytes) await stage(true);
      await putBlockList(key, staged, { ...options, contentType });
      return { ...(await head(key)), sha256: hash.digest('hex') };
    },

    async commit(key, blockIds, options = {}) {
      key = validateKey(key, id);
      if (
        !Array.isArray(blockIds) ||
        !blockIds.length ||
        blockIds.some((blockId) => typeof blockId !== 'string' || !blockId)
      )
        throw fail('InvalidKey', 'commit needs a non-empty block id list.');
      await ensureContainer();
      await putBlockList(
        key,
        blockIds.map((blockId) => blockIdOf(`block:${blockId}`)),
        options,
      );
      const result = await head(key);
      if (!result) throw fail('NotFound', 'Committed blob is not readable.');
      return result;
    },

    async get(key, { range, ifNoneMatch, signal } = {}) {
      key = validateKey(key, id);
      const headers = ifNoneMatch !== undefined ? { 'if-none-match': ifNoneMatch } : {};
      if (range) {
        const start = range.start ?? 0,
          end = range.end;
        if (!Number.isInteger(start) || start < 0 || (end !== undefined && (!Number.isInteger(end) || end < start)))
          throw fail('InvalidRange', 'Requested range is not satisfiable.');
        headers['x-ms-range'] = `bytes=${start}-${end ?? ''}`;
      }
      const response = await send('GET', blobUrl(key), { headers, signal });
      if (response.status === 304) {
        await response.body?.cancel().catch(() => {});
        const current = await head(key);
        if (!current) throw fail('NotFound', 'Storage object does not exist.', 'BlobNotFound');
        return { ...current, notModified: true, body: null };
      }
      if (response.status !== 200 && response.status !== 206) throw await failure(response, 'Get Blob');
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const result = meta(key, response.headers, match ? Number(match[3]) : contentLength);
      const body = response.body ?? (async function* () {})();
      return {
        ...result,
        body,
        range: range ? { start: Number(match?.[1] ?? 0), end: Number(match?.[2] ?? contentLength - 1) } : null,
        contentLength,
      };
    },

    head(key) {
      return head(validateKey(key, id));
    },

    async delete(key, { ifMatch } = {}) {
      key = validateKey(key, id);
      const response = await send('DELETE', blobUrl(key), { headers: conditions({ ifMatch }) });
      if (response.status === 202) {
        await response.body?.cancel().catch(() => {});
        return true;
      }
      if (response.status === 404 && ifMatch === undefined) {
        await response.body?.cancel().catch(() => {});
        return false;
      }
      throw await failure(response, 'Delete Blob', { ifMatch });
    },

    async list(prefix = '', { pageSize = 1000, continuation } = {}) {
      if (prefix) prefix = validateKey(prefix, id, { prefix: true });
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000)
        throw fail('InvalidKey', 'pageSize must be an integer from 1 to 5000.');
      if (continuation != null && (typeof continuation !== 'string' || continuation.length > 1024))
        throw fail('InvalidKey', 'Continuation token is invalid.');
      const url = new URL(`${endpoint()}/${container}`);
      for (const [name, value] of Object.entries({
        restype: 'container',
        comp: 'list',
        prefix,
        maxresults: String(pageSize),
        ...(continuation ? { marker: continuation } : {}),
      }))
        if (value !== '') url.searchParams.set(name, value);
      const response = await send('GET', url.href);
      if (response.status === 404 && response.headers.get('x-ms-error-code') === 'ContainerNotFound') {
        await response.body?.cancel().catch(() => {});
        return { items: [], continuation: null };
      }
      if (response.status !== 200) throw await failure(response, 'List Blobs');
      const xml = await response.text();
      const items = [...xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)].map(([, blob]) => ({
        key: xmlValue(blob, 'Name'),
        size: Number(xmlValue(blob, 'Content-Length') ?? 0),
        etag: quoted(xmlValue(blob, 'Etag')),
        lastModified: iso(xmlValue(blob, 'Last-Modified')),
      }));
      return { items, continuation: xmlValue(xml, 'NextMarker') || null };
    },

    async sas(key, { permission = 'r', expiresOn } = {}) {
      key = validateKey(key, id);
      if (!['r', 'w', 'rw'].includes(permission)) throw fail('InvalidKey', "SAS permission must be 'r', 'w' or 'rw'.");
      endpoint();
      const se = sasTime(expiresOn ?? now() + 3600_000);
      const sig = hmac(accountKey, serviceSasStringToSign({ sp: permission, se, accountName, container, key }));
      return `${blobUrl(key)}?${new URLSearchParams({ sv: BLOB_API_VERSION, sr: 'b', sp: permission, se, sig })}`;
    },

    /** Server side of sas(): returns { key, permission, expiresOn } or throws Unauthorized. */
    verifySas(url, { permission } = {}) {
      const denied = () => fail('Unauthorized', 'Shared access signature is invalid or expired.');
      if (config.error) throw denied();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw denied();
      }
      const base = `${blobEndpoint}/${container}/`;
      if (!`${parsed.origin}${parsed.pathname}`.startsWith(base)) throw denied();
      let key;
      try {
        key = validateKey(
          `${parsed.origin}${parsed.pathname}`.slice(base.length).split('/').map(decodeURIComponent).join('/'),
          id,
        );
      } catch {
        throw denied();
      }
      const q = (name) => parsed.searchParams.get(name) ?? '';
      if (q('sv') !== BLOB_API_VERSION || q('sr') !== 'b') throw denied();
      const expected = Buffer.from(
          hmac(accountKey, serviceSasStringToSign({ sp: q('sp'), se: q('se'), accountName, container, key })),
        ),
        given = Buffer.from(q('sig'));
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw denied();
      const expiry = Date.parse(q('se'));
      if (!Number.isFinite(expiry) || expiry <= now()) throw denied();
      if (permission && ![...permission].every((p) => q('sp').includes(p))) throw denied();
      return { key, permission: q('sp'), expiresOn: q('se') };
    },

    // Readiness: an authorized List Containers (2 s) answers 200 with its EnumerationResults body (any other loopback process
    // that answers 200 is not a Blob endpoint), else the reason (never the key).
    async preflight() {
      if (closed) return { ready: false, reason: 'The provider is closed.' };
      if (config.error) return { ready: false, reason: config.error.message };
      const result = await (async () => {
        try {
          const response = await send('GET', `${endpoint()}?comp=list&maxresults=1`, { timeoutMs: 2000 });
          if (response.status === 200) {
            if ((await response.text()).includes('<EnumerationResults')) return { ready: true };
            return {
              ready: false,
              reason: `The process at ${shown} answered List Containers without EnumerationResults; it is not a Blob endpoint.`,
            };
          }
          await response.body?.cancel().catch(() => {});
          return {
            ready: false,
            reason: `Azurite refused List Containers at ${shown} (${response.status} ${response.headers.get('x-ms-error-code') ?? 'no error code'}).`,
          };
        } catch (error) {
          return { ready: false, reason: error.message };
        }
      })();
      health = { ready: result.ready, reason: result.reason ?? null };
      return result;
    },

    /** Last observed endpoint state { ready: true | false | null (not contacted yet), reason } for the host graph. Never the key. */
    health() {
      return closed ? { ready: false, reason: 'The provider is closed.' } : { ...health };
    },

    async close() {
      closed = true;
    },
  };
  return provider;
}
/** Pack-factory shaped alias of createAzuriteStorage. */
export const create = createAzuriteStorage;

/**
 * Service SAS StringToSign for a blob (create-service-sas, version 2020-12-06 and later): signedPermissions, signedStart,
 * signedExpiry, canonicalizedResource (/blob/<account>/<container>/<blob>, URL-decoded), signedIdentifier, signedIP,
 * signedProtocol, signedVersion, signedResource, signedSnapshotTime, signedEncryptionScope, rscc, rscd, rsce, rscl, rsct.
 * The 2020-12-06 field list is inferred from Learn's section headings and the user delegation SAS layout; Azurite's
 * acceptance of these SAS URLs is not verified.
 */
function serviceSasStringToSign({ sp, st = '', se, accountName, container, key, sv = BLOB_API_VERSION, sr = 'b' }) {
  return [sp, st, se, `/blob/${accountName}/${container}/${key}`, '', '', '', sv, sr, '', '', '', '', '', '', ''].join(
    '\n',
  );
}

/** Loopback-only reachability probe of a Blob endpoint (no authorization). Any HTTP answer means the process is running. Never throws. */
export async function preflight({ blobEndpoint, timeoutMs = 2000, source = 'the connection string' } = {}) {
  let url;
  try {
    url = new URL(blobEndpoint);
  } catch {
    return {
      reachable: false,
      status: null,
      message: 'Blob endpoint is not a URL.',
      diagnostic: 'PROVIDER_ENDPOINT_INVALID',
    };
  }
  const shown = `${url.protocol}//${url.host}${url.pathname}`; // never the query (it may carry a SAS)
  if (!isLoopbackUrl(url.href))
    // The endpoint comes from a secret connection string: the message names where it is configured, never its host.
    return {
      reachable: false,
      status: null,
      message: `BlobEndpoint in ${source} is not loopback; live storage is refused.`,
      diagnostic: 'PROVIDER_NOT_LOOPBACK',
    };
  url.search = '';
  url.searchParams.set('restype', 'service');
  url.searchParams.set('comp', 'properties');
  try {
    const response = await loopbackFetch(url.href, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return { reachable: true, status: response.status, message: `Azurite answered ${response.status} at ${shown}.` };
  } catch (error) {
    const reason =
      error?.name === 'TimeoutError'
        ? `no answer within ${timeoutMs} ms`
        : (error?.cause?.code ?? error?.code ?? 'connection failed');
    return {
      reachable: false,
      status: null,
      message: `Azurite is not reachable at ${shown} (${reason}). ${START_HINT}`,
      diagnostic: 'PROVIDER_UNREACHABLE',
    };
  }
}
