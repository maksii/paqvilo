// @test-kind tooling: malformed authored placeholders remain inventory text without repeated delimiter backtracking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventoryWebApi } from '../webapi-inventory.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('Web API inventory accepts a long unmatched Liquid output in an authored URL', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-inventory-delimiters-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_name: Invented\nadx_websiteid: invented');
  await fs.mkdir(path.join(dir, 'web-templates'));
  await fs.writeFile(
    path.join(dir, 'web-templates/Invented.webtemplate.yml'),
    'adx_webtemplateid: invented\nadx_name: Invented',
  );
  await fs.writeFile(
    path.join(dir, 'web-templates/Invented.webtemplate.source.html'),
    "<script>fetch('/_api/contacts?$filter=" + '{{'.repeat(100_000) + "');</script>",
  );
  const report = await inventoryWebApi(dir);
  assert.ok(report.sourceCount > 0);
  assert.ok(report.supportMatrix.some((row) => row.feature === 'route.collection'));
});
