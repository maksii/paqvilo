// Same-size rewrites inside one file-time tick keep every stat field. Freezing the times every stat call
// reports (tick) reproduces that on any file system, so these regressions fail deterministically without the
// racy-window rule (lense/file-cache.mjs recordedStamp); `settled` proves unchanged files are still reused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SolutionFileCache, sourceDirectoryDigest } from '../lib/solution-cache.mjs';
import { sourceFingerprint } from '../lib/evidence.mjs';
import { solutionContentFingerprint } from '../lib/solution-content-fingerprint.mjs';
import { inspectPage } from '../lib/page-resources.mjs';
import { freezeFileTimes as tick, freezeSettledFileTimes as settled } from './support/file-times.mjs';

const countReads = (t) => {
  const reads = [],
    read = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', (file, ...args) => (reads.push(file), read(file, ...args)));
  return reads;
};

function directory(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-racy-stamps-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const write = (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { dir, write };
}

test('parsed-file cache parses a same-size rewrite made in the tick of the cached parse', async (t) => {
  const { write } = directory(t);
  const file = write('Entity.xml', '<alpha/>');
  tick(t);
  const cache = new SolutionFileCache();
  const parse = () => cache.parse(file, 'text@1', (text) => text);
  assert.equal((await parse()).value, '<alpha/>');
  write('Entity.xml', '<omega/>');
  const { value, cached } = await parse();
  assert.deepEqual({ value, cached }, { value: '<omega/>', cached: false });
});

test('parsed-file cache reuses a settled file without reading it again', async (t) => {
  const { write } = directory(t);
  const file = write('Entity.xml', '<alpha/>');
  settled(t);
  const cache = new SolutionFileCache();
  await cache.parse(file, 'text@1', (text) => text);
  const reads = countReads(t);
  assert.equal((await cache.parse(file, 'text@1', (text) => text)).cached, true);
  assert.deepEqual(reads, []);
});

test('source directory digest follows a same-size rewrite made in the tick of the previous digest', async (t) => {
  const { dir, write } = directory(t);
  write('web-files/app.js', 'alpha();');
  tick(t);
  const before = await sourceDirectoryDigest(dir);
  write('web-files/app.js', 'omega();');
  const after = await sourceDirectoryDigest(dir);
  assert.notEqual(after, before);
  assert.equal(after, await sourceFingerprint(dir));
});

test('source directory digest of a settled tree compares stats without reading content', async (t) => {
  const { dir, write } = directory(t);
  write('web-files/app.js', 'alpha();');
  settled(t);
  const digest = await sourceDirectoryDigest(dir);
  const reads = countReads(t);
  assert.equal(await sourceDirectoryDigest(dir), digest);
  assert.deepEqual(reads, []);
});

test('Solution content fingerprint follows a same-size side-file rewrite made in the tick of the previous hash', (t) => {
  const { dir, write } = directory(t);
  write('webresources/fixture_script.js', 'alpha();');
  tick(t);
  const layers = [{ type: 'directory', dir, solution: { uniqueName: 'Invented', version: '1.0.0.0' } }];
  const before = solutionContentFingerprint(layers);
  write('webresources/fixture_script.js', 'omega();');
  assert.notEqual(solutionContentFingerprint(layers), before);
});

test('page inspection reads a same-size table display-name rewrite made in the tick of the previous inspection', (t) => {
  const { dir, write } = directory(t);
  const entity = (label) =>
    `<Entity><Name LocalizedName="${label}">fixture_item</Name><EntityInfo><entity Name="fixture_item"/></EntityInfo></Entity>`;
  const file = write('Entities/fixture_item/Entity.xml', entity('Alpha'));
  tick(t);
  const portal = {
    sourceDir: dir,
    pages: [
      {
        id: 'page-1',
        name: 'Items',
        url: '/items/',
        html: '{% fetchxml rows %}<fetch><entity name="fixture_item"><attribute name="fixture_name"/></entity></fetch>{% endfetchxml %}',
        js: '',
        css: '',
        metadata: { id: 'page-1' },
      },
    ],
  };
  const displayName = () =>
    inspectPage(portal, '/items/', {
      solutionMetadata: { entities: { fixture_item: { sources: [file], fields: {} } } },
    }).tables.find((table) => table.logicalName === 'fixture_item')?.displayName;
  assert.equal(displayName(), 'Alpha');
  write('Entities/fixture_item/Entity.xml', entity('Omega'));
  assert.equal(displayName(), 'Omega');
});
