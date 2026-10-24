// Test-only loopback fake of the Azure Blob REST subset the azurite provider uses, with real Shared Key verification.
// It is written from the Learn pages independently of storage-azurite.mjs, so a signing mistake on either side fails a test:
//   Shared Key: https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key
//   Conditional headers: https://learn.microsoft.com/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations
//   Put Block List: https://learn.microsoft.com/rest/api/storageservices/put-block-list
//   Error codes: https://learn.microsoft.com/rest/api/storageservices/blob-service-error-codes
// Path-style addressing only (http://127.0.0.1:<port>/<account>/<container>/<blob>), as Azurite's IP-style URLs.
// Not a production server: no leases, snapshots, tiers, page or append blobs.
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Invented test key (base64), never a real account key.
export const FAKE_ACCOUNT_KEY = Buffer.from('fx-invented-azurite-fake-key-0001').toString('base64');

const STANDARD = [
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
const escapeXml = (text) =>
  String(text).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );

/** Starts the fake; returns { blobEndpoint, connectionString, accountName, requests, containers, close() }. */
export async function startAzuriteFake({
  accountName = 'devstoreaccount1',
  accountKey = FAKE_ACCOUNT_KEY,
  now = () => Date.now(),
} = {}) {
  const containers = new Map(); // name → Map(blobName → { data, etag, lastModified, contentType, metadata, uncommitted: Map })
  const requests = [];
  let sequence = 0;
  const etag = () => `"0x8D${(++sequence).toString(16).toUpperCase().padStart(12, '0')}"`;

  function stringToSign(request, rawPath, query) {
    const lines = [request.method];
    for (const name of STANDARD) {
      const value = request.headers[name] ?? '';
      lines.push(name === 'content-length' && value === '0' ? '' : value);
    }
    let text = `${lines.join('\n')}\n`;
    for (const name of Object.keys(request.headers)
      .filter((n) => n.startsWith('x-ms-'))
      .sort())
      text += `${name}:${String(request.headers[name])
        .replace(/[ \t\r\n]+/g, ' ')
        .trim()}\n`;
    text += `/${accountName}${rawPath}`;
    const grouped = new Map();
    for (const [name, value] of query) {
      const key = name.toLowerCase();
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(value);
    }
    for (const name of [...grouped.keys()].sort()) text += `\n${name}:${grouped.get(name).sort().join(',')}`;
    return text;
  }
  const sign = (text) => createHmac('sha256', Buffer.from(accountKey, 'base64')).update(text, 'utf8').digest('base64');
  const same = (a, b) => {
    const x = Buffer.from(a),
      y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  function authorized(request, rawPath, query, blobPath) {
    const header = request.headers.authorization;
    if (header) {
      const match = /^SharedKey ([^:]+):(.+)$/.exec(header);
      if (!match || match[1] !== accountName || !request.headers['x-ms-version']) return false;
      const date = Date.parse(request.headers['x-ms-date'] ?? request.headers.date ?? '');
      if (!Number.isFinite(date) || Math.abs(now() - date) > 15 * 60_000) return false; // Learn: no older than 15 minutes
      return same(sign(stringToSign(request, rawPath, query)), match[2]);
    }
    // Service SAS (sr=b, read) for GET blob only.
    const q = Object.fromEntries(query);
    if (request.method !== 'GET' || !q.sig || q.sr !== 'b' || !blobPath || !q.sp?.includes('r')) return false;
    if (!(Date.parse(q.se) > now())) return false;
    const fields = [
      q.sp,
      q.st ?? '',
      q.se,
      `/blob/${accountName}/${blobPath}`,
      q.si ?? '',
      q.sip ?? '',
      q.spr ?? '',
      q.sv,
      q.sr,
      q.sst ?? '',
      q.ses ?? '',
      q.rscc ?? '',
      q.rscd ?? '',
      q.rsce ?? '',
      q.rscl ?? '',
      q.rsct ?? '',
    ];
    return same(sign(fields.join('\n')), q.sig);
  }

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const [rawPath, rawQuery = ''] = request.url.split('?');
    const query = [...new URLSearchParams(rawQuery)];
    const q = Object.fromEntries(query);
    const segments = rawPath.split('/').slice(1).map(decodeURIComponent);
    requests.push({
      method: request.method,
      path: rawPath,
      query: Object.keys(q).sort(),
      version: request.headers['x-ms-version'] ?? null,
    });
    const send = (status, headers = {}, payload) => {
      response.writeHead(status, { 'x-ms-version': request.headers['x-ms-version'] ?? '', ...headers });
      response.end(request.method === 'HEAD' ? undefined : payload);
    };
    const error = (status, code) =>
      send(
        status,
        { 'x-ms-error-code': code, 'content-type': 'application/xml' },
        `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      );

    if (segments[0] !== accountName) return error(400, 'InvalidUri');
    const [, containerName, ...blobParts] = segments;
    const blobName = blobParts.join('/');
    if (!authorized(request, rawPath, query, containerName && blobName ? `${containerName}/${blobName}` : null))
      return error(403, 'AuthenticationFailed');

    // List Containers
    if (!containerName) {
      if (request.method === 'GET' && q.comp === 'list') {
        const names = [...containers.keys()].sort().slice(0, Number(q.maxresults ?? 5000));
        return send(
          200,
          { 'content-type': 'application/xml' },
          `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Containers>${names.map((n) => `<Container><Name>${escapeXml(n)}</Name></Container>`).join('')}</Containers><NextMarker/></EnumerationResults>`,
        );
      }
      return error(400, 'UnsupportedHttpVerb');
    }
    const container = containers.get(containerName);
    if (!blobName && q.restype === 'container') {
      if (request.method === 'PUT') {
        if (container) return error(409, 'ContainerAlreadyExists');
        containers.set(containerName, new Map());
        return send(201, { etag: etag() });
      }
      if (request.method === 'GET' && q.comp === 'list') {
        if (!container) return error(404, 'ContainerNotFound');
        const max = Number(q.maxresults ?? 5000);
        const names = [...container.keys()]
          .filter((n) => container.get(n).data && n.startsWith(q.prefix ?? '') && (!q.marker || n >= q.marker))
          .sort();
        const page = names.slice(0, max);
        const items = page
          .map((n) => {
            const b = container.get(n);
            return `<Blob><Name>${escapeXml(n)}</Name><Properties><Last-Modified>${b.lastModified}</Last-Modified><Etag>${b.etag.replaceAll('"', '')}</Etag><Content-Length>${b.data.length}</Content-Length><Content-Type>${escapeXml(b.contentType)}</Content-Type></Properties></Blob>`;
          })
          .join('');
        const next = names.length > max ? names[max] : '';
        return send(
          200,
          { 'content-type': 'application/xml' },
          `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${items}</Blobs><NextMarker>${escapeXml(next)}</NextMarker></EnumerationResults>`,
        );
      }
      return error(400, 'UnsupportedHttpVerb');
    }
    if (!container) return error(404, 'ContainerNotFound');
    const blob = container.get(blobName);
    const committed = blob?.data ? blob : null;
    const ifMatch = request.headers['if-match'],
      ifNoneMatch = request.headers['if-none-match'];
    const metadata = () =>
      Object.fromEntries(Object.entries(request.headers).filter(([n]) => n.startsWith('x-ms-meta-')));
    const props = (b) => ({
      etag: b.etag,
      'last-modified': b.lastModified,
      'content-type': b.contentType,
      ...b.metadata,
    });
    // Learn: an unmet If-Match or If-None-Match on a write is 412 ConditionNotMet.
    const writeConditionFails = () =>
      (ifMatch !== undefined && (!committed || (ifMatch !== '*' && ifMatch !== committed.etag))) ||
      (ifNoneMatch !== undefined && committed && (ifNoneMatch === '*' || ifNoneMatch === committed.etag));
    const commit = (data, contentType, meta) => {
      container.set(blobName, {
        data,
        etag: etag(),
        lastModified: new Date(now()).toUTCString(),
        contentType: contentType || 'application/octet-stream',
        metadata: meta,
        uncommitted: new Map(),
      });
      return send(201, { etag: container.get(blobName).etag, 'last-modified': container.get(blobName).lastModified });
    };

    if (request.method === 'PUT' && q.comp === 'block') {
      const id = q.blockid;
      if (!id || !/^[A-Za-z0-9+/]+={0,2}$/.test(id)) return error(400, 'InvalidBlockId');
      const target = blob ?? { data: null, uncommitted: new Map() };
      const lengths = new Set([...target.uncommitted.keys()].map((k) => k.length));
      if (lengths.size && !lengths.has(id.length)) return error(400, 'InvalidBlobOrBlock'); // Learn: same length per blob
      target.uncommitted.set(id, body);
      container.set(blobName, target);
      return send(201);
    }
    if (request.method === 'PUT' && q.comp === 'blocklist') {
      if (writeConditionFails()) return error(412, 'ConditionNotMet');
      const ids = [...body.toString('utf8').matchAll(/<(Latest|Uncommitted|Committed)>([^<]*)<\/\1>/g)].map(
        ([, , id]) => id,
      );
      const parts = [];
      for (const id of ids) {
        const part = blob?.uncommitted?.get(id) ?? blob?.committedBlocks?.get(id);
        if (!part) return error(400, 'InvalidBlockList');
        parts.push(part);
      }
      const committedBlocks = new Map(ids.map((id) => [id, blob.uncommitted.get(id) ?? blob.committedBlocks.get(id)]));
      commit(Buffer.concat(parts), request.headers['x-ms-blob-content-type'], metadata());
      container.get(blobName).committedBlocks = committedBlocks;
      return undefined;
    }
    if (request.method === 'PUT') {
      if (request.headers['x-ms-blob-type'] !== 'BlockBlob') return error(400, 'MissingRequiredHeader');
      if (writeConditionFails()) return error(412, 'ConditionNotMet');
      return commit(body, request.headers['content-type'], metadata());
    }
    if (request.method === 'DELETE') {
      if (!committed) return error(404, 'BlobNotFound');
      if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== committed.etag) return error(412, 'ConditionNotMet');
      container.delete(blobName);
      return send(202);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!committed) return error(404, 'BlobNotFound');
      if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== committed.etag) return error(412, 'ConditionNotMet');
      if (ifNoneMatch !== undefined && (ifNoneMatch === '*' || ifNoneMatch === committed.etag))
        return send(304, { etag: committed.etag });
      const size = committed.data.length;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers['x-ms-range'] ?? '');
      if (request.method === 'GET' && range) {
        const start = Number(range[1]),
          end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
        if (start >= size || end < start) return error(416, 'InvalidRange');
        const slice = committed.data.subarray(start, end + 1);
        return send(
          206,
          { ...props(committed), 'content-length': slice.length, 'content-range': `bytes ${start}-${end}/${size}` },
          slice,
        );
      }
      return send(200, { ...props(committed), 'content-length': size }, committed.data);
    }
    return error(400, 'UnsupportedHttpVerb');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const blobEndpoint = `http://127.0.0.1:${server.address().port}/${accountName}`;
  return {
    blobEndpoint,
    accountName,
    requests,
    containers,
    connectionString: (key = accountKey) =>
      `DefaultEndpointsProtocol=http;AccountName=${accountName};AccountKey=${key};BlobEndpoint=${blobEndpoint};`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
