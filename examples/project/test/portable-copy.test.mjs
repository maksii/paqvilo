// @test-kind contract: a project copied by mirage demo runs without the toolkit checkout beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const MARKDOWN_LINK = /\]\(([^)\s]+)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.paqvilo', 'bin', 'obj', 'out', 'coverage']);

async function filesWithExtension(directory, extension) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory())
        return SKIPPED_DIRECTORIES.has(entry.name) ? [] : filesWithExtension(entryPath, extension);
      return entry.isFile() && entryPath.endsWith(extension) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

function insideProject(target) {
  return target === projectRoot || target.startsWith(projectRoot + path.sep);
}

async function escapingImports(file) {
  const source = await fs.readFile(file, 'utf8');
  const escapes = [];
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    if (!specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), specifier);
    if (!insideProject(target)) escapes.push(`${path.relative(projectRoot, file)} -> ${specifier}`);
  }
  return escapes;
}

async function brokenLinks(file) {
  const source = await fs.readFile(file, 'utf8');
  const broken = [];
  for (const [, link] of source.matchAll(MARKDOWN_LINK)) {
    if (link.startsWith('#') || SCHEME.test(link)) continue;
    const target = path.resolve(path.dirname(file), link.split(/[#?]/)[0]);
    const exists = await fs.stat(target).then(
      () => true,
      () => false,
    );
    if (!exists || !insideProject(target)) broken.push(`${path.relative(projectRoot, file)} -> ${link}`);
  }
  return broken;
}

test('no example module imports a relative path outside the project folder', async () => {
  const files = await filesWithExtension(projectRoot, '.mjs');
  assert.ok(files.length > 0);
  const escapes = (await Promise.all(files.map(escapingImports))).flat();
  assert.deepEqual(escapes, []);
});

test('every relative link in the example markdown resolves to a file inside the copied project', async () => {
  const files = await filesWithExtension(projectRoot, '.md');
  assert.ok(files.length > 0);
  const broken = (await Promise.all(files.map(brokenLinks))).flat();
  assert.deepEqual(broken, []);
});
