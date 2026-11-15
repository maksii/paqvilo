// A standard table seeded for the Dataverse API stays invisible to the portal Web API: a known table that the site has
// not enabled answers 404 9004010C, as in Power Pages, while a set that names no table answers 400.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('seeded standard, plug-in and process tables are not enabled on the portal Web API', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-dataverse-standard-portal-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'website.yml'), 'adx_websiteid: site\nadx_name: Standard portal\n');
  await fs.writeFile(
    path.join(directory, 'home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
  );
  const app = await createSimulator({ sourceDir: directory, watch: false, dataverse: { enabled: true } });
  ownedFixture(t).add(() => app.close());
  assert.ok(app.state().dataverse.enabled);
  const read = async (set) => {
    const response = await fetch(`${app.url}/_api/${set}`, { headers: { accept: 'application/json' } });
    return { status: response.status, error: (await response.json()).error };
  };
  for (const [set, table] of [
    ['accounts', 'account'],
    ['workflows', 'workflow'],
    ['pluginassemblies', 'pluginassembly'],
  ]) {
    const { status, error } = await read(set);
    assert.equal(status, 404, set);
    assert.equal(error.code, '9004010C', set);
    assert.match(error.message, new RegExp(`segment '?${table}`), set);
  }
  assert.equal(
    (await read('invented_nothings')).status,
    400,
    'a set that names no table is not the not-enabled answer',
  );
});
