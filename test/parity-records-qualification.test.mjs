// @test-kind tooling: Invented records guards bind live fixture values and retained proofs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { format } from 'prettier';
import { createRecordsSixFixture } from './fixtures/parity-records-six-fixture.mjs';
import {
  describeParitySource,
  parityHash,
  qualifyParityManifest,
  writeParityQualification,
} from '../scripts/qualify-parity.mjs';

test('six preserved guards reject missing, moved and live-mutated fixture markers', async () => {
  const f = createRecordsSixFixture();
  try {
    const report = qualifyParityManifest(f.manifest, { root: f.root, readBaseline: () => f.baseline });
    assert.deepEqual(report.pending, []);
    assert.equal(report.newOriginalDefinitions, 0);
    assert.equal(report.changes[0].bindings.length, 6);
    for (const [index, binding] of report.changes[0].bindings.entries()) {
      assert.deepEqual(
        binding.originalAssertions,
        f.manifest.files[0].guarantees[index].tests[0].assertions.map((item) => item.sha256),
      );
      assert.deepEqual(binding.proofs, f.manifest.files[0].guarantees[index].proofs);
    }
    writeParityQualification(report, { root: f.root });
    const file = path.join(f.root, 'sample.test.mjs');
    const guarded = await format(fs.readFileSync(file, 'utf8'), { parser: 'babel', singleQuote: true });
    fs.writeFileSync(file, guarded);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (...args) =>
      spawnSync(process.execPath, [...args, '--test', file], { cwd: f.root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(run('--test-name-pattern=case-|parity source bindings').status, 0);
    const row = describeParitySource(guarded).registrations.find((item) => item.title === 'case-1');
    const markerNode = row.callback.body.body.find(
      (statement) =>
        statement.type === 'ExpressionStatement' &&
        statement.expression?.callee?.name === '__paqRecordsFixtureLiterals',
    );
    assert.ok(markerNode);
    const marker = guarded.slice(...markerNode.range);
    for (const edited of [guarded.replace(marker, ''), guarded.replace(marker, `${marker}\n${marker}`)]) {
      assert.notEqual(edited, guarded);
      fs.writeFileSync(file, edited);
      const result = run('--test-name-pattern=parity source bindings');
      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /invalid-records-fixture-marker|changed-(original-body|module-context|isolation-registrations)/u,
      );
    }
    fs.writeFileSync(file, guarded);
    for (const mode of ['value', 'accessor']) {
      const result = run(`--test-name-pattern=mutator-${mode}|case-|parity source bindings`);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /changed-records-fixture-input/u);
    }
  } finally {
    f.cleanup();
  }
});

test('records fixture migration rejects authored background scheduling', () => {
  const f = createRecordsSixFixture();
  try {
    const before = f.baseline.replace(
      "test('uuid-sibling'",
      "test('scheduled', () => { setTimeout(() => {}, 0); }); test('uuid-sibling'",
    );
    const current = f.current.replace(
      "test('uuid-sibling'",
      "test('scheduled', () => { setTimeout(() => {}, 0); }); test('uuid-sibling'",
    );
    f.manifest.files[0].baselineSha256 = parityHash(before);
    f.manifest.files[0].currentSha256 = parityHash(current);
    fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), current);
    const report = qualifyParityManifest(f.manifest, { root: f.root, readBaseline: () => before });
    assert.equal(report.pending[0].reason, 'unsupported-records-async-scheduling');
  } finally {
    f.cleanup();
  }
});
