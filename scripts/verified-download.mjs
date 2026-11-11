import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

async function fetchArchive(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      if (attempt === 3) throw new Error('Archive download failed: network or timeout after 3 attempts.');
      await delay(attempt * 250);
      continue;
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    if (!transientStatuses.has(response.status) || attempt === 3)
      throw new Error(`Archive download failed: HTTP ${response.status} (attempt ${attempt}).`);
    await delay(attempt * 250);
  }
}

// Callers pin both the upstream URL and SHA-256. Publish only complete, verified archives.
export async function downloadVerifiedArchive(url, file, expected, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Expected a SHA-256 pin and a positive archive byte limit.');
  const response = await fetchArchive(url);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Archive download exceeds its byte limit.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('Archive download exceeds its byte limit.');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
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
