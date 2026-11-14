import { setTimeout as delay } from 'node:timers/promises';
import { environmentOrigin, tokenProvider } from './connection.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const READ_RETRY_STATUSES = new Set([429, 503]);
const MAX_READ_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;

// Retry-After is in seconds; without a usable value the wait doubles from one second on each attempt.
function readRetryWaitMs(retryAfter, attempt) {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  return Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

function requestHeaders(token, body, solution, mergeLabels, prefer, ifMatch, ifNoneMatch) {
  const headers = {
    Accept: 'application/json',
    'OData-Version': '4.0',
    'OData-MaxVersion': '4.0',
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (solution) headers['MSCRM.SolutionUniqueName'] = solution;
  if (mergeLabels) headers['MSCRM.MergeLabels'] = 'true';
  for (const [name, value] of [
    ['Prefer', prefer],
    ['If-Match', ifMatch],
    ['If-None-Match', ifNoneMatch],
  ]) {
    if (value !== undefined) {
      if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid Dataverse request header.');
      headers[name] = value;
    }
  }
  return headers;
}

// Shared with connection.mjs: only loopback origins may stand in for production hosts, and only when a caller allows it.
export function isLoopbackOrigin(value) {
  const url = value instanceof URL ? value : new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && LOOPBACK_HOSTS.has(url.hostname);
}

// The request timeout is combined with the caller's signal, so either one aborts the fetch.
function fetchSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

export class DataverseClient {
  constructor({
    environmentUrl,
    token,
    fetchImpl = fetch,
    allowLoopback = false,
    timeoutMs = 30_000,
    mutationTimeoutMs = 180_000,
    signal,
    sleep = (ms, waitSignal) => delay(ms, undefined, { signal: waitSignal }),
  }) {
    const url = new URL(environmentUrl);
    const testOrigin = allowLoopback && url.protocol === 'http:' && isLoopbackOrigin(url);
    this.origin = testOrigin ? url.origin : environmentOrigin(environmentUrl);
    this.base = `${this.origin}/api/data/v9.2/`;
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.mutationTimeoutMs = mutationTimeoutMs;
    this.signal = signal;
    this.sleep = sleep;
  }

  url(relative) {
    const url = new URL(relative, this.base);
    if (
      url.origin !== this.origin ||
      !url.pathname.startsWith('/api/data/v9.2/') ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Dataverse request/continuation escaped the configured API origin.');
    return url.href;
  }

  // Only reads are retried: a throttled or unavailable mutation may already have been applied.
  async request(relative, options = {}) {
    const method = options.method ?? 'GET',
      signal = options.signal ?? this.signal;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(relative, { ...options, signal });
      } catch (error) {
        if (method !== 'GET' || !READ_RETRY_STATUSES.has(error.status) || attempt >= MAX_READ_RETRIES) throw error;
        await this.waitBeforeRetry(readRetryWaitMs(error.retryAfter, attempt), signal);
      }
    }
  }

  // An abort ends the wait with the caller's reason rather than the timer library's AbortError.
  async waitBeforeRetry(ms, signal) {
    try {
      await this.sleep(ms, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
  }

  async send(relative, { method = 'GET', body, solution, prefer, ifMatch, ifNoneMatch, mergeLabels, signal } = {}) {
    const url = this.url(relative);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const responseFailure = () =>
      Object.assign(
        new Error(
          method === 'GET'
            ? 'Dataverse read failed (network/timeout or invalid response); response withheld.'
            : 'Dataverse mutation outcome is unknown (network/timeout or invalid response). Reconcile before retrying.',
        ),
        { code: method === 'GET' ? 'READ_FAILED' : 'UNKNOWN_COMMIT' },
      );
    const headers = requestHeaders(await this.token(), body, solution, mergeLabels, prefer, ifMatch, ifNoneMatch);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        redirect: 'error',
        signal: fetchSignal(method === 'GET' ? this.timeoutMs : this.mutationTimeoutMs, signal),
      });
    } catch {
      throw responseFailure();
    }
    if (!response.ok) {
      const error = new Error(`Dataverse ${method} failed (HTTP ${response.status}); server body withheld.`);
      error.status = response.status;
      error.code = 'DATAVERSE_HTTP_ERROR';
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    let data;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      // A 2xx header does not make an interrupted mutation response retryable.
      throw responseFailure();
    }
    return { data, status: response.status, entityId: response.headers.get('odata-entityid') };
  }

  async get(relative) {
    return (await this.request(relative)).data;
  }
  async optional(relative) {
    try {
      return await this.get(relative);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
  async list(relative) {
    const rows = [],
      visited = new Set();
    let next = relative;
    while (next) {
      const url = this.url(next);
      if (visited.has(url) || visited.size >= 1000) throw new Error('Invalid or excessive Dataverse pagination.');
      visited.add(url);
      const page = await this.get(url);
      if (!Array.isArray(page?.value)) throw new Error('Expected a Dataverse collection.');
      rows.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return rows;
  }

  async verify(expectedOrganisationId) {
    const who = await this.get('WhoAmI');
    if (expectedOrganisationId && who.OrganizationId?.toLowerCase() !== expectedOrganisationId.toLowerCase())
      throw new Error('Connected organisation differs from the saved connection.');
    return {
      environmentUrl: this.origin,
      organisationId: who.OrganizationId,
      applicationUserId: who.UserId,
      businessUnitId: who.BusinessUnitId,
    };
  }
}

export function connectedClient(connection, { allowLoopback = false } = {}) {
  return new DataverseClient({
    environmentUrl: connection.environmentUrl,
    token: tokenProvider(connection, { allowLoopback }),
    allowLoopback,
  });
}

export function metadataId(result) {
  const id = result.data?.MetadataId ?? result.data?.id;
  if (id) return id;
  const match = result.entityId?.match(/\(([0-9a-f-]{36})\)$/i);
  if (!match) throw new Error('Creation acknowledged without a component ID. Reconcile metadata before retrying.');
  return match[1].toLowerCase();
}
