// @test-kind tooling: inventory command-line selection and caller-named client wrappers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryWebApi } from '../webapi-inventory.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// A site's own Web API client object is named by the caller (--client-wrapper); the inventory has
// no built-in project wrapper.
test('client wrapper calls count as requests only for the wrappers the caller names', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-inventory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_name: Inventory\nadx_websiteid: site',
    'web-pages/home/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html':
      "<script>App.WebApi._get('/_api/contacts?$select=fullname'); App.WebApi.post('/_api/contacts', {}); Other.Api._delete('/_api/contacts(1)'); AppXWebApi._patch('/_api/x');</script>",
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const methods = async (clientWrappers) =>
    (await inventoryWebApi(dir, { clientWrappers })).supportMatrix
      .filter((row) => row.feature.startsWith('method.'))
      .map((row) => [row.feature, row.uses]);
  assert.deepEqual(await methods([]), []);
  // The name is literal: App.WebApi does not match AppXWebApi.
  assert.deepEqual(await methods(['App.WebApi']), [
    ['method.GET', 1],
    ['method.POST', 1],
  ]);
  assert.deepEqual(await methods(['App.WebApi', 'Other.Api']), [
    ['method.DELETE', 1],
    ['method.GET', 1],
    ['method.POST', 1],
  ]);
});

// Like the other catalogue commands, the inventory reads paqvilo.config.yml in the working
// directory and its defaultSite when neither --portal nor --config/--site is given.
test('webapi-inventory without selection options uses the working-directory catalogue', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-inventory-cwd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'portal', 'web-pages'), { recursive: true });
  await fs.writeFile(path.join(dir, 'portal', 'website.yml'), 'adx_name: Inventory\nadx_websiteid: site');
  const script = fileURLToPath(new URL('../webapi-inventory.mjs', import.meta.url));
  const run = (args = ['--json']) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^No catalogue: .*paqvilo\.config\.yml does not exist\./);
  await fs.writeFile(
    path.join(dir, 'paqvilo.config.yml'),
    'defaultSite: s\nsites:\n  s:\n    source: portal\n    defaultEnv: local\n    environments:\n      local: http://127.0.0.1:8787\n',
  );
  const found = run();
  assert.equal(found.status, 0, found.stdout);
  assert.equal(path.resolve(JSON.parse(found.stdout).portalRoot), path.resolve(dir, 'portal'));
});
