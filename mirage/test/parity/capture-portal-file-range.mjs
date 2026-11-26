/**
 * Convert an original authorized or repeat file-range probe receipt and its
 * synthetic upload bytes to the raw input of scripts/parity-cases.mjs build.
 * Usage: node mirage/test/parity/capture-portal-file-range.mjs RECEIPT SYNTHETIC_FILE OUT
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isEntryPoint } from '../../../lense/entry-point.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function captureDate(file) {
  // The probe writes each receipt with exclusive creation immediately after its browser call.
  // Its schema has no timestamp. Read the UTC date from the original receipt metadata.
  const stat = fs.statSync(file);
  const created = stat.birthtime.toISOString();
  const written = stat.mtime.toISOString();
  assert.equal(created.slice(0, 10), written.slice(0, 10), 'Use the original native receipt with matching UTC dates.');
  return written.slice(0, 10);
}

function readOutput(response, expectedStatus, requestedBytes) {
  assert.equal(response.status, expectedStatus, 'The owned file request must have succeeded.');
  assert.equal(response.bytes, requestedBytes.length, 'Receipt byte count must agree with the synthetic file.');
  assert.equal(response.sha256, sha256(requestedBytes), 'Receipt digest must agree with the synthetic file.');
  assert.equal(response.contentLength, String(response.bytes), 'Receipt Content-Length must match its byte count.');
  assert.ok(response.acceptRanges === null || ['none', 'bytes'].includes(response.acceptRanges));
  assert.ok(response.contentRange === null || /^bytes \d+-\d+\/\d+$/.test(response.contentRange));
  assert.equal(typeof response.hasValidator, 'boolean');

  return {
    status: response.status,
    contentRange: response.contentRange,
    acceptRanges: response.acceptRanges,
    contentLength: response.contentLength,
    hasValidator: response.hasValidator,
    bytes: response.bytes,
    sha256: response.sha256,
  };
}

export function preparePortalFileRangeCapture(receiptFile, syntheticFile) {
  const id = path.basename(receiptFile, '.json');
  assert.match(id, /^file-range-portal-(authorized|repeat)$/, 'Use an original authorized or repeat receipt.');
  const raw = fs.readFileSync(receiptFile);
  const receipt = JSON.parse(raw.toString('utf8'));
  assert.equal(receipt.navigation, 200);
  assert.equal(receipt.hasPortalSignOut, true, 'The host must have admitted a signed-in portal contact.');
  assert.equal(receipt.row?.status, 200);

  const file = fs.readFileSync(syntheticFile);
  const input = {
    fileBase64: file.toString('base64'),
    observed: {
      webApiFileDownload: 'portal-range',
      evidence: 'Authorized and repeated hosted Power Pages browser reads of a synthetic file.',
    },
  };
  // These are the two positive GET requests in both runs of file-range-portal-probe.mjs.
  // The 416 payload and facts present only in the repeat are outside this corpus.
  return {
    capture: { id, capturedAt: captureDate(receiptFile), sha256: sha256(raw) },
    results: [
      { id: 'full', input: { ...input, range: null }, output: readOutput(receipt.full, 200, file) },
      {
        id: 'first-sixteen-bytes',
        input: { ...input, range: 'bytes=0-15' },
        output: readOutput(receipt.range, 206, file.subarray(0, 16)),
      },
    ],
  };
}

if (isEntryPoint(import.meta.url)) {
  const [receipt, syntheticFile, out, ...extra] = process.argv.slice(2);
  if (!receipt || !syntheticFile || !out || extra.length)
    throw new Error('Usage: node mirage/test/parity/capture-portal-file-range.mjs RECEIPT SYNTHETIC_FILE OUT');
  const capture = preparePortalFileRangeCapture(receipt, syntheticFile);
  fs.writeFileSync(out, JSON.stringify(capture, null, 2) + '\n');
}
