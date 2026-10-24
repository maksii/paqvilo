import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Callers pin both the upstream URL and SHA-256. Publish only complete, verified archives.
export async function downloadVerifiedArchive(url, file, expected, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Expected a SHA-256 pin and a positive archive byte limit.');
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Archive download failed or exceeds its byte limit.');
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
