import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function assertCorpusProof(bytes, evidence, expectedHash) {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
  assert.notEqual(evidence.runs[0].processId, evidence.runs[1].processId);
  assert.deepEqual(evidence.runs[0].results, evidence.runs[1].results);
  assert.deepEqual(
    evidence.input.map((r) => r.expression),
    evidence.runs[0].results.map((r) => r.expression),
  );
}
