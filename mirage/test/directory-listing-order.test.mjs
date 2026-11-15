// @test-kind contract: directory listing order differs between file systems and operating systems; what Mirage imports from a folder follows name order, not listing order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { importPortal } from '../lib/importer.mjs';
import { buildSiteTables } from '../lib/site-tables.mjs';
import { readDuplicateRuleSolution } from '../lib/dataverse-duplicates.mjs';
import { makeTemporaryDirectory, ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';

// Every directory listing comes back in reverse until the test ends: the order another file system may give.
function reverseListings(t) {
  const { readdir } = fs.promises,
    { readdirSync } = fs;
  fs.promises.readdir = async (...args) => (await readdir(...args)).reverse();
  fs.readdirSync = (...args) => readdirSync(...args).reverse();
  syncBuiltinESMExports();
  t.after(() => {
    fs.promises.readdir = readdir;
    fs.readdirSync = readdirSync;
    syncBuiltinESMExports();
  });
}

async function folder(t, prefix, files) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  for (const [name, text] of Object.entries(files)) {
    await fs.promises.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.promises.writeFile(path.join(directory, name), text);
  }
  return directory;
}

test('imported portal components keep name order whatever the listing order', async (t) => {
  const component = (id) =>
    `<powerpagecomponent powerpagecomponentid="${id}"><content>{"value":"${id}"}</content><name>${id}</name><powerpagecomponenttype>9</powerpagecomponenttype><statecode>0</statecode><statuscode>1</statuscode></powerpagecomponent>`;
  const directory = await folder(
    t,
    'pp-listing-order-',
    Object.fromEntries(
      ['ab', 'a_b', 'c'].map((id) => [`powerpagecomponents/${id}/powerpagecomponent.xml`, component(id)]),
    ),
  );
  const ids = async () =>
    buildSiteTables(await importPortal(directory), { tables: {}, mappings: {} }).tables.powerpagecomponent.rows.map(
      (row) => row.powerpagecomponentid,
    );
  const listed = await ids();
  assert.deepEqual(listed, ['a_b', 'ab', 'c'], 'code-unit name order');
  reverseListings(t);
  assert.deepEqual(await ids(), listed);
});

test('duplicate rules read from a Solution keep folder name order whatever the listing order', async (t) => {
  const rule = (name) =>
    `<duplicaterule uniquename="${name}"><baseentityname>widget</baseentityname><matchingentityname>widget</matchingentityname><name>${name}</name></duplicaterule>`;
  const directory = await folder(
    t,
    'dv-listing-order-',
    Object.fromEntries(['rule_a', 'Rule_b', 'rule_c'].map((name) => [`${name}/duplicaterule.xml`, rule(name)])),
  );
  const names = async () => (await readDuplicateRuleSolution(directory)).duplicaterule.map((row) => row.name);
  const listed = await names();
  assert.deepEqual(listed, ['Rule_b', 'rule_a', 'rule_c'], 'code-unit folder order');
  reverseListings(t);
  assert.deepEqual(await names(), listed);
});
