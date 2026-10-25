import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  scriptSourceBody,
  scriptResourceProof,
  scriptResourceProofFromSourceRefs,
} from '../lense/script-source-evidence.mjs';

test('script proof is tied to the exact response snapshot, preserving original-byte mode and BOM mapping', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-script-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'owned.js');
  const bytes = Buffer.from('\uFEFFconst label="🟢";\r\ndocument.createElement("button");\r\n');
  fs.writeFileSync(file, bytes);
  const rawHash = createHash('sha256').update(bytes).digest('hex');
  const source = {
    id: 'script-field',
    key: 'script-field',
    kind: 'webfile',
    ref: 'web-files/owned.js',
    file,
    sourceRevision: 'source-a',
    contentRevision: rawHash,
  };
  let refs = [source];
  const inspector = {
    sourceIndexFor: async () => ({ sourceRevision: 'source-a', sources: new Map(refs.map((ref) => [ref.id, ref])) }),
  };
  const body = scriptSourceBody(bytes, file, { sourceMaps: false });
  assert.equal(body, bytes);
  const proof = await scriptResourceProof(inspector, file, body);
  assert.equal(proof.sourceRefs[0].contentRevision, rawHash);
  assert.equal(proof.scriptProofs[0].mappings[0].sourceStart, 1);
  assert.equal(
    proof.scriptProofs[0].generatedHash,
    createHash('sha256').update(bytes.toString('utf8').slice(1)).digest('hex'),
  );
  assert.equal(proof.scriptProofs[0].lineStarts[1], bytes.toString('utf8').slice(1).indexOf('document'));
  assert.equal(proof.sourceRefs[0].file, undefined, 'private filesystem location stays backend-only');
  refs = [{ ...source, contentRevision: 'changed-after-response-snapshot' }];
  assert.equal(
    await scriptResourceProof(inspector, file, body),
    null,
    'a second current file snapshot cannot relabel served bytes',
  );
  refs = [source, { ...source, id: 'different-record', key: 'different-record' }];
  assert.equal(
    await scriptResourceProof(inspector, file, body),
    null,
    'identical bodies sharing a physical file do not choose a semantic record',
  );
});

test('mapped scripts retain actual body hash while source maps and unmappable lines remain separate', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-script-bounds-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, code, sourceMaps] of [
    ['mapped.js', 'window.x=1;\n', true],
    ['many-lines.js', '\n'.repeat(17000), false],
  ]) {
    const file = path.join(directory, name),
      bytes = Buffer.from(code);
    fs.writeFileSync(file, bytes);
    const source = {
      id: name,
      key: name,
      ref: name,
      file,
      sourceRevision: 'source-a',
      contentRevision: createHash('sha256').update(bytes).digest('hex'),
    };
    const body = scriptSourceBody(bytes, file, { sourceMaps });
    const proof = await scriptResourceProof(
      { sourceIndexFor: async () => ({ sourceRevision: 'source-a', sources: new Map([[name, source]]) }) },
      file,
      body,
    );
    assert.equal(proof.scriptProofs[0].generatedHash, createHash('sha256').update(body.toString()).digest('hex'));
    if (sourceMaps) assert.match(body.toString(), /sourceMappingURL=/);
    else {
      assert.equal(proof.scriptProofs[0].lineStarts.length, 16384);
      assert.equal(proof.complete, false);
      assert.equal(proof.scriptProofs[0].linesTruncated, true);
    }
  }
});

test('final response trailers retain original implementation identity, while rewritten code cannot reuse linear source offsets', () => {
  const raw = Buffer.from('document.createElement("button");'),
    revision = 'invented-revision';
  const ref = {
    id: 'resource:invented',
    key: 'resource:invented:$content',
    ref: 'WebResources/invented.js',
    sourceRevision: revision,
    contentRevision: createHash('sha256').update(raw).digest('hex'),
  };
  const response = Buffer.concat([raw, Buffer.from('\n//# sourceURL=paqvilo-tool://invented-resource\n')]);
  const body = scriptSourceBody(raw, 'invented.js', { responseBody: response, sourceMaps: false });
  const proof = scriptResourceProofFromSourceRefs([ref], body, revision);
  assert.equal(proof.scriptProofs[0].generatedHash, createHash('sha256').update(response).digest('hex'));
  assert.equal(proof.scriptProofs[0].mappings[0].generatedEnd, raw.length);
  const rewritten = scriptSourceBody(raw, 'invented.js', {
    responseBody: Buffer.from('void 0;' + raw),
    sourceMaps: false,
  });
  assert.equal(scriptResourceProofFromSourceRefs([ref], rewritten, revision), null);
});
