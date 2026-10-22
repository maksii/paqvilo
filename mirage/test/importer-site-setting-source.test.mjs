// A site setting with an environment variable lookup binds only when adx_source is 1 (Environment variable). A missing
// source keeps the static value (native default 0, unverified against a real export). Invented names and values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPortal } from '../lib/importer.mjs';

test('a site setting with a lookup and no source keeps its static value', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-setting-source-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Source default');
  await fs.writeFile(path.join(dir, 'sitesetting.yml'), [
    '- adx_sitesettingid: s1',
    '  adx_name: Api/NoSource',
    '  adx_value: static-value',
    '  adx_environmentvariable: def-url',
    '- adx_sitesettingid: s2',
    '  adx_name: Api/Bound',
    '  adx_value: static-value',
    '  adx_environmentvariable: def-url',
    '  adx_source: 1',
  ].join('\n'));
  const portal = await importPortal(dir);
  assert.deepEqual(portal.settingEnvironmentVariables, { 'Api/Bound': 'def-url' });
  assert.equal(portal.settings['Api/NoSource'], 'static-value');
});
