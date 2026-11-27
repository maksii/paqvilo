// @test-kind contract: the /page-resources administration report adds the observed facts of the session's last render and the request address; Paqvilo's own design with invented loopback fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const FILES = {
  'website.yml': 'adx_websiteid: site\nadx_name: Observed render fixture',
  'websitelanguage.yml':
    '- adx_websitelanguageid: lang-en\n  adx_name: English\n  adx_languagecode: en-US\n- adx_websitelanguageid: lang-fr\n  adx_name: French\n  adx_languagecode: fr-FR',
  'sitesetting.yml':
    '- adx_sitesettingid: s1\n  adx_name: MultiLanguage/DisplayLanguageCodeInURL\n  adx_value: true\n- adx_sitesettingid: s2\n  adx_name: Template/Chosen\n  adx_value: Chosen',
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'web-pages/home/Home.webpage.copy.html': '<p>Home</p>',
  'web-pages/other/Other.webpage.yml':
    'adx_webpageid: other\nadx_name: Other\nadx_partialurl: other\nadx_parentpageid: home\nadx_pagetemplateid: main',
  'web-pages/other/Other.webpage.copy.html': "<p>Other</p>{% entityform name: 'Sample entry' %}",
  'basic-forms/Entry.basicform.yml':
    'adx_entityformid: a1000000-0000-4000-8000-000000000001\nadx_name: Sample entry\nadx_entityname: sample\nadx_mode: 100000000',
  'basic-forms/Unused.basicform.yml':
    'adx_entityformid: a1000000-0000-4000-8000-000000000002\nadx_name: Unused entry\nadx_entityname: sample\nadx_mode: 100000000',
  'page-templates/Main.pagetemplate.yml':
    'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html':
    "<!doctype html><html><body>{% assign chosen = settings['Template/Chosen'] %}{% include chosen %}{% if false %}{% include 'Never' %}{% endif %}{% include 'Page Copy' %}</body></html>",
  'web-templates/Chosen.webtemplate.yml': 'adx_webtemplateid: chosen\nadx_name: Chosen',
  'web-templates/Chosen.webtemplate.source.html': '<aside id="chosen">Chosen</aside>',
  'web-templates/Never.webtemplate.yml': 'adx_webtemplateid: never\nadx_name: Never',
  'web-templates/Never.webtemplate.source.html': '<aside>Never</aside>',
};

async function setup(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-observed-render-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const fields = [{ name: 'title', label: 'Title' }];
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state', 'state.json'),
    watch: false,
    initial: {
      mappings: {
        sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { title: { dataverseType: 'nvarchar' } } },
      },
      tables: { sample: [] },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: { 'a1000000-0000-4000-8000-000000000001': { entity: 'sample', mode: 100000000, fields } },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const call = async (route, cookie) => {
    const response = await fetch(app.url + route, {
      headers: { 'x-sim-csrf': app.csrf, ...(cookie ? { cookie } : {}) },
      redirect: 'manual',
    });
    const text = await response.text();
    return { status: response.status, text, json: text.startsWith('{') ? JSON.parse(text) : null, response };
  };
  return { app, call };
}

test('C9 and C10: a language-prefixed address inspects the page served in that language and keeps the requested path', async (t) => {
  const { call } = await setup(t);
  const report = (await call('/__sim/api/page-resources?path=' + encodeURIComponent('/fr-FR/Other/'))).json;
  assert.equal(report.page?.id, 'other');
  assert.equal(report.route?.language?.code, 'fr-FR', 'the page is inspected in the language the address serves');
  assert.equal(report.requestPath, '/fr-FR/Other/');
});

test('C27: the report marks the templates the session last render of that address ran, including a dynamic include', async (t) => {
  const { call } = await setup(t);
  const before = (await call('/__sim/api/page-resources?path=/other/')).json;
  assert.equal(before.observedRender.state, 'unknown');
  assert.ok(before.webTemplates.every((row) => row.observed === 'unknown'));
  const page = await call('/other/');
  assert.equal(page.status, 200);
  const cookie = page.response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie, 'the page answer sets the visitor cookie of the session');
  const report = (await call('/__sim/api/page-resources?path=/other/', cookie)).json;
  assert.equal(report.observedRender.state, 'observed');
  assert.equal(report.observedRender.renderedPage.id, 'other');
  const observed = Object.fromEntries(report.webTemplates.map((row) => [row.name, row.observed]));
  assert.equal(observed.Main, 'rendered');
  assert.equal(observed.Never, 'not-rendered', 'a statically listed include inside a false branch did not run');
  const listed = report.webTemplates.some((row) => row.name === 'Chosen');
  assert.ok(
    listed
      ? observed.Chosen === 'rendered'
      : report.observedRender.additionalSources.some((row) => row.name === 'Chosen'),
    'the include resolved at run time is reported as rendered',
  );
  assert.equal(report.page.observed, 'rendered');
  const form = report.forms.find((row) => row.id === 'a1000000-0000-4000-8000-000000000001');
  assert.equal(form?.observed, 'rendered', 'the entityform tag the render ran is the observed form');
  const other = (await call('/__sim/api/page-resources?path=/', cookie)).json;
  assert.equal(other.observedRender.state, 'unknown', 'a render of another address is not this address');
});
