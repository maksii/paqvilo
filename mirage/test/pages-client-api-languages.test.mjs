// $pages.languages.getAll lists the site's active website languages: the host passes them into the page's client object.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test("a two-language site lists both languages in the client object's activeLanguages", async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pages-languages-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml':
      'adx_websiteid: 77777777-7777-4777-8777-777777777721\nadx_name: Example\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
    'websitelanguage.yml':
      '- adx_websitelanguageid: lang-en\n  adx_name: English\n  adx_languagecode: en-US\n- adx_websitelanguageid: lang-fr\n  adx_name: French\n  adx_languagecode: fr-FR',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    initial: { version: 1, simulator: { mode: 'local', pageMode: 'local', live: { origin: null }, endpoints: [] } },
    watch: false,
  });
  ownedFixture(t).add(() => app.close());
  const html = await (await fetch(`${app.url}/`)).text();
  assert.match(html, /"activeLanguages":\["en-US","fr-FR"\]/);
});
