// @test-kind tooling: the browser fixtures' module graph follows every form of relative import
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleGraph } from '../test-browser/shared-browser.mjs';

test('the module graph follows static, side-effect, re-export, dynamic and double-quoted relative imports and ignores bare ones', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-graph-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'nested'));
  await fs.writeFile(
    path.join(dir, 'entry.mjs'),
    "import a from './a.mjs';\nimport './side.mjs';\nexport * from \"./re.mjs\";\nexport const load = () => import('./nested/dyn.mjs');\nimport fs from 'node:fs';\n",
  );
  for (const file of ['a.mjs', 'side.mjs', 're.mjs']) await fs.writeFile(path.join(dir, file), 'export default 1;\n');
  await fs.writeFile(path.join(dir, 'nested', 'dyn.mjs'), "import up from '../a.mjs';\n");

  const entryFile = path.join(dir, 'entry.mjs');
  const modules = await moduleGraph(pathToFileURL(entryFile), '/assets/entry.mjs');

  assert.deepEqual(
    [...modules.keys()].toSorted((x, y) => x.localeCompare(y)),
    ['/assets/a.mjs', '/assets/entry.mjs', '/assets/nested/dyn.mjs', '/assets/re.mjs', '/assets/side.mjs'],
  );
  assert.equal(modules.get('/assets/entry.mjs').href, pathToFileURL(entryFile).href);
  assert.equal(modules.get('/assets/nested/dyn.mjs').href, pathToFileURL(path.join(dir, 'nested', 'dyn.mjs')).href);
});
