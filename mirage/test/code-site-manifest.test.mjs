// @test-kind security: a code-site manifest is confined to its admitted root and read from the validated descriptor.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCodeSite } from '../lib/code-site.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-code-site-manifest-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function buildAt(dir, siteName) {
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.writeFile(path.join(dir, 'dist', 'index.html'), '<main>Invented app</main>');
  await fs.writeFile(
    path.join(dir, 'powerpages.config.json'),
    JSON.stringify({ siteName, compiledPath: 'dist', defaultLandingPage: 'index.html' }),
  );
}

test('a path redirected after manifest admission cannot substitute another file', async (t) => {
  const base = await fixture(t);
  const project = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await buildAt(project, 'Admitted project');
  await buildAt(outside, 'Different project');
  const manifestFile = path.join(project, 'powerpages.config.json');
  const open = fs.open;
  let replaced = false;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === manifestFile && !replaced) {
      replaced = true;
      await fs.rename(project, path.join(base, 'original'));
      await fs.symlink(outside, project, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return open(file, ...args);
  });

  const diagnostics = [];
  const app = await readCodeSite(project, diagnostics);
  assert.equal(replaced, true, 'the path changed between admission and descriptor open');
  assert.equal(app.entryFile, null);
  assert.equal(diagnostics[0].code, 'CODE_SITE_COMPILED_UNAVAILABLE');
  assert.match(diagnostics[0].message, /changed before reading/);
});

// @test-kind contract: absent source config remains optional and an oversized present manifest is diagnosed.
test('an absent manifest differs from a manifest that exceeds the read limit', async (t) => {
  const project = await fixture(t);
  const diagnostics = [];
  assert.equal(await readCodeSite(project, diagnostics), null);
  assert.deepEqual(diagnostics, []);
  await fs.writeFile(path.join(project, 'powerpages.config.json'), ' '.repeat(64 * 1024 + 1));
  assert.equal((await readCodeSite(project, diagnostics)).entryFile, null);
  assert.match(diagnostics[0].message, /exceeds its read limit/);
});
