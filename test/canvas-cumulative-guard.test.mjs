// @test-kind tooling: cumulative Power Fx guards must retain both existing and newly proved assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('coexisting case and scope guards reject source and proof tampering', () => {
  const parent = path.join(root, '.paqvilo');
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, 'powerfx-guard-test-'));
  try {
    fs.cpSync(path.join(root, 'scripts'), path.join(scratch, 'scripts'), { recursive: true });
    fs.cpSync(path.join(root, 'mirage/lib'), path.join(scratch, 'mirage/lib'), { recursive: true });
    fs.cpSync(path.join(root, 'mirage/test/fixtures'), path.join(scratch, 'mirage/test/fixtures'), { recursive: true });
    const file = path.join(scratch, 'mirage/test/power-fx-language.test.mjs');
    const original = fs.readFileSync(path.join(root, 'mirage/test/power-fx-language.test.mjs'), 'utf8');
    const childEnv = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
    const run = (pattern = 'scopes: ThisRecord') =>
      spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {
        cwd: scratch,
        encoding: 'utf8',
        env: childEnv,
      });
    fs.writeFileSync(file, original);
    let result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /scopes: ThisRecord/u);
    result = run('daylight-saving change');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /daylight-saving change/u);
    for (const [before, after] of [
      ['const values = { a: 10, T: [{ a: 1 }, { a: 2 }] };', 'const values = { a: 11, T: [{ a: 1 }, { a: 2 }] };'],
      ['Sum(Filter(T, a > 1), a)', 'Sum(Filter(T, a > 0), a)'],
      [
        "coexistingCaseGuardSha256: '9acffb20f5094f63f03bfe29b018480636ecd63c3655b8f6712ada39c3d664c4'",
        "coexistingCaseGuardSha256: '0000000000000000000000000000000000000000000000000000000000000000'",
      ],
    ]) {
      assert.ok(original.includes(before));
      fs.writeFileSync(file, original.replace(before, after));
      result = run();
      assert.notEqual(result.status, 0, before);
    }
    const oldGuard = "coexistingCaseGuardSha256: '9acffb20f5094f63f03bfe29b018480636ecd63c3655b8f6712ada39c3d664c4'";
    assert.ok(original.includes(oldGuard));
    const index = original.lastIndexOf(oldGuard);
    fs.writeFileSync(
      file,
      original.slice(0, index) +
        oldGuard.replace('9acffb20f5094f63f03bfe29b018480636ecd63c3655b8f6712ada39c3d664c4', '0'.repeat(64)) +
        original.slice(index + oldGuard.length),
    );
    result = run('daylight-saving change');
    assert.notEqual(result.status, 0, 'prior DST guard drift must fail');
    fs.writeFileSync(file, original);
    const proof = path.join(scratch, 'mirage/test/fixtures/power-fx-batch-official-evidence.json');
    fs.appendFileSync(proof, ' ');
    result = run();
    assert.notEqual(result.status, 0, 'prior official proof drift must fail');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
