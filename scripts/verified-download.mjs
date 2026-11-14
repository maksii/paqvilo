import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const transientStatuses = new Set([408, 500, 502, 503, 504]);
const throttleStatuses = new Set([403, 429]);
const maxAttempts = 3;
const maxThrottleWaitMs = 60_000;
const tokenOrigin = 'https://api.github.com';

// Retry waits use the global timer, so the same timer functions drive the idle limit and the waits.
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// A transfer failure that may be retried: a network error, or a stream that produced no bytes for the idle limit.
class TransferFailure extends Error {
  constructor(stalled) {
    super('transfer failed');
    this.stalled = stalled;
  }
}

// Exceeding the byte limit is a property of the archive, so it is never retried.
class ByteLimitError extends Error {
  constructor() {
    super('Archive download exceeds its byte limit.');
  }
}

// The timer restarts on every response header and body chunk; a transfer is cut only when it goes idle.
function idleWatch(idleTimeoutMs) {
  const controller = new AbortController();
  let timer;
  let stalled = false;
  const watch = {
    signal: controller.signal,
    isStalled: () => stalled,
    touch() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, idleTimeoutMs);
    },
    stop: () => clearTimeout(timer),
  };
  watch.touch();
  return watch;
}

async function readBody(body, maxBytes, watch) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    watch.touch();
    size += chunk.byteLength;
    if (size > maxBytes) throw new ByteLimitError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

// The token goes only to the API origin; fetch drops it on the cross-origin redirect to the asset host.
const sendsToken = (url, token) => Boolean(token) && new URL(url).origin === tokenOrigin;

// Resolves to { bytes } for a complete body or { status, host, headers } for an HTTP error response.
async function attemptDownload(url, { idleTimeoutMs, maxBytes, fetchImpl, token }) {
  const watch = idleWatch(idleTimeoutMs);
  try {
    const headers = { accept: 'application/octet-stream' };
    if (sendsToken(url, token)) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, { headers, signal: watch.signal });
    watch.touch();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, host: new URL(response.url || url).host, headers: response.headers };
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new ByteLimitError();
    }
    return { bytes: await readBody(response.body, maxBytes, watch) };
  } catch (error) {
    if (error instanceof ByteLimitError) throw error;
    throw new TransferFailure(watch.isStalled());
  } finally {
    watch.stop();
  }
}

function transferFailureMessage(url, failure, options, attempts) {
  if (failure.stalled)
    return `Archive download stalled from ${new URL(url).host}: no bytes for ${options.idleTimeoutMs / 1000} s after ${attempts} attempts.`;
  return `Archive download failed: network or timeout after ${attempts} attempts.`;
}

// For a 403 or 429: a retry-after of whole seconds is honoured; an exhausted primary limit (x-ratelimit-remaining 0)
// waits until x-ratelimit-reset; a 429 with neither waits one minute; any other 403 is a refusal and fails at once.
function throttleWaitMs(status, headers) {
  if (!throttleStatuses.has(status)) return undefined;
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const reset = headers.get('x-ratelimit-reset');
  if (headers.get('x-ratelimit-remaining') === '0' && /^\d+$/.test(reset ?? '')) {
    // The reset is epoch seconds on the server's clock; the response's date is that clock, the local one only without it.
    const served = Date.parse(headers.get('date') ?? '');
    return Math.max(0, Number(reset) * 1000 - (Number.isNaN(served) ? Date.now() : served));
  }
  return status === 429 ? 60_000 : undefined;
}

function throttleMessage({ host, status, headers }, waitMs, attempt) {
  const named = ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']
    .map((name) => `${name}=${headers.get(name) ?? 'absent'}`)
    .join(', ');
  const reason =
    waitMs > maxThrottleWaitMs
      ? `the requested wait of ${Math.ceil(waitMs / 1000)} s exceeds the ${maxThrottleWaitMs / 1000} s bound`
      : `still throttled after ${attempt} attempts`;
  return `Archive download throttled by ${host}: HTTP ${status} (${named}); ${reason}.`;
}

// The wait before the next attempt after an HTTP error response; throws when that response ends the download.
function httpRetryWait(outcome, attempt) {
  const throttle = throttleWaitMs(outcome.status, outcome.headers);
  if (throttle !== undefined) {
    if (throttle > maxThrottleWaitMs || attempt === maxAttempts)
      throw new Error(throttleMessage(outcome, throttle, attempt));
    return throttle;
  }
  if (!transientStatuses.has(outcome.status) || attempt === maxAttempts)
    throw new Error(`Archive download failed from ${outcome.host}: HTTP ${outcome.status} (attempt ${attempt}).`);
  return attempt * 250;
}

async function fetchArchive(url, options) {
  let attempt = 1;
  while (attempt <= maxAttempts) {
    let outcome;
    try {
      outcome = await attemptDownload(url, options);
    } catch (error) {
      if (!(error instanceof TransferFailure)) throw error;
      if (attempt === maxAttempts)
        throw new Error(transferFailureMessage(url, error, options, attempt), { cause: error });
      await wait(attempt * 250);
      attempt++;
      continue;
    }
    if (outcome.bytes) return outcome.bytes;
    if (outcome.status === 401 && sendsToken(url, options.token)) {
      // An expired or revoked token: release assets are public, so the same attempt is repeated once without it.
      options = { ...options, token: undefined };
      continue;
    }
    await wait(httpRetryWait(outcome, attempt));
    attempt++;
  }
  throw new Error('Archive download failed: no attempts were made.');
}

// Callers pin both the upstream URL and SHA-256. Publish only complete, verified archives.
export async function downloadVerifiedArchive(
  url,
  file,
  expected,
  { maxBytes = 64 * 1024 * 1024, idleTimeoutMs = 60_000, fetchImpl = fetch, token } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Expected a SHA-256 pin and a positive archive byte limit.');
  // A timer delay above 2^31 - 1 ms fires after 1 ms, so every attempt would read as stalled.
  const idleTimeoutValid = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 && idleTimeoutMs <= 2_147_483_647;
  if (!idleTimeoutValid) throw new Error('Expected an idle timeout from 1 to 2147483647 milliseconds.');
  if (token !== undefined && (typeof token !== 'string' || token === ''))
    throw new Error('Expected a non-empty token string.');
  const bytes = await fetchArchive(url, { idleTimeoutMs, maxBytes, fetchImpl, token });
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Archive digest mismatch; no unverified content was saved.');
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    // Rename replaces a competing link itself, never the file that link points to.
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Keeps `file` when its SHA-256 matches the pin; otherwise removes it and downloads a verified copy once.
export async function ensureVerifiedArchive(url, file, expected, options) {
  if (fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected) return;
  fs.rmSync(file, { force: true });
  console.log(`Downloading ${path.basename(file)} from ${new URL(url).host}.`);
  await downloadVerifiedArchive(url, file, expected, options);
}
