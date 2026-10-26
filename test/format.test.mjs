import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as prettier from 'prettier';
import { formatProject } from '../scripts/format.mjs';
import { tempDir } from './fixture.mjs';

test('atomic formatting retains CLI ignores and configuration and is idempotent', async (t) => {
  const root = await tempDir('paqvilo-format-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.prettierrc.json'), '{"singleQuote":true,"tabWidth":4}\n');
  await fs.writeFile(path.join(root, '.prettierignore'), '.paqvilo/\nignored.mjs\n');
  await fs.writeFile(path.join(root, '.editorconfig'), 'root = true\n[*]\nend_of_line = crlf\n');
  const source = 'const result={name:"Invented",values:[1,2]};\n';
  const target = path.join(root, 'source.mjs');
  await fs.writeFile(target, source);
  await fs.writeFile(path.join(root, 'ignored.mjs'), source);
  await fs.mkdir(path.join(root, '.paqvilo'));
  const ignored = path.join(root, '.paqvilo', 'private.mjs');
  await fs.writeFile(ignored, source);
  const expected = await prettier.format(source, {
    ...(await prettier.resolveConfig(target, { editorconfig: true })),
    filepath: target,
  });
  await formatProject(root);
  assert.equal(await fs.readFile(target, 'utf8'), expected);
  assert.equal(await fs.readFile(path.join(root, 'ignored.mjs'), 'utf8'), source);
  assert.equal(await fs.readFile(ignored, 'utf8'), source);
  assert.equal(await formatProject(root), 0);
  assert.deepEqual(await fs.readdir(path.join(root, '.paqvilo', 'format')), []);
});

test(
  'atomic formatting preserves permissions even under a restrictive umask',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await tempDir('paqvilo-format-mode-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'source.mjs');
    await fs.writeFile(target, 'const value={x:1};\n');
    await fs.chmod(target, 0o755);
    const previous = process.umask(0o077);
    try {
      await formatProject(root);
    } finally {
      process.umask(previous);
    }
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
  },
);

test('formatting preserves a concurrent source save instead of overwriting it', async (t) => {
  const root = await tempDir('paqvilo-format-concurrent-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'source.mjs');
  await fs.writeFile(target, 'const value={x:1};\n');
  const chmod = fsSync.chmodSync;
  t.mock.method(fsSync, 'chmodSync', (file, mode) => {
    // Model an editor save while the formatter prepares its replacement.
    if (file.startsWith(path.join(root, '.paqvilo', 'format'))) fsSync.writeFileSync(target, '// concurrent save\n');
    return chmod(file, mode);
  });
  await assert.rejects(formatProject(root), /Source changed while formatting/);
  assert.equal(await fs.readFile(target, 'utf8'), '// concurrent save\n');
  assert.deepEqual(await fs.readdir(path.join(root, '.paqvilo', 'format')), []);
});
