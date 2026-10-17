import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-site-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, 'checkout');
  fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/build-site.mjs'), path.join(checkout, 'scripts/build-site.mjs'));
  fs.cpSync(path.join(root, 'site'), path.join(checkout, 'site'), { recursive: true });
  fs.cpSync(path.join(root, 'docs/assets'), path.join(checkout, 'docs/assets'), { recursive: true });
  const run = () => spawnSync(process.execPath, [path.join(checkout, 'scripts/build-site.mjs')], {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  return { directory, checkout, run };
}

test('site builds replace stale output and retain only deliberate public files', (t) => {
  const { checkout, run } = fixture(t);
  const output = path.join(checkout, 'dist/pages');
  fs.mkdirSync(path.join(output, 'obsolete'), { recursive: true });
  fs.writeFileSync(path.join(output, 'obsolete/private.txt'), 'stale generated output');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(output, 'obsolete')), false);
  assert.deepEqual(fs.readdirSync(output).sort(), ['.nojekyll', 'assets', 'coverage.html', 'index.html', 'style.css']);
  assert.deepEqual(fs.readdirSync(path.join(output, 'assets')).sort(), ['lense-visual.png', 'mirage-visual.png', 'overview.svg']);
});

for (const redirected of ['dist', 'dist/pages']) {
  test(`site build refuses a redirected ${redirected} directory`, (t) => {
    const { directory, checkout, run } = fixture(t);
    const external = path.join(directory, 'unrelated');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'unrelated data');
    const link = path.join(checkout, redirected);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must (?:stay|be a generated directory) inside this checkout/);
    assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'unrelated data');
    assert.equal(fs.existsSync(path.join(external, 'index.html')), false);
  });
}
