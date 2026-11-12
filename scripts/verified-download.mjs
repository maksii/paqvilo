import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const maxAttempts = 3;

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

// Resolves to { bytes } for a complete body or { status } for an HTTP error response.
async function attemptDownload(url, { idleTimeoutMs, maxBytes }) {
  const watch = idleWatch(idleTimeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/octet-stream' }, signal: watch.signal });
    watch.touch();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status };
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

async function fetchArchive(url, options) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let outcome;
    try {
      outcome = await attemptDownload(url, options);
    } catch (error) {
      if (!(error instanceof TransferFailure)) throw error;
      if (attempt === maxAttempts)
        throw new Error(transferFailureMessage(url, error, options, attempt), { cause: error });
      await delay(attempt * 250);
      continue;
    }
    if (outcome.bytes) return outcome.bytes;
    if (!transientStatuses.has(outcome.status) || attempt === maxAttempts)
      throw new Error(`Archive download failed: HTTP ${outcome.status} (attempt ${attempt}).`);
    await delay(attempt * 250);
  }
  throw new Error('Archive download failed: no attempts were made.');
}

// Callers pin both the upstream URL and SHA-256. Publish only complete, verified archives.
export async function downloadVerifiedArchive(
  url,
  file,
  expected,
  { maxBytes = 64 * 1024 * 1024, idleTimeoutMs = 60_000 } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Expected a SHA-256 pin and a positive archive byte limit.');
  if (!(idleTimeoutMs > 0)) throw new Error('Expected a positive idle timeout.');
  const bytes = await fetchArchive(url, { idleTimeoutMs, maxBytes });
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
