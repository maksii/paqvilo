// @test-kind compatibility: Microsoft Learn (Dataverse Liquid tags): entityform and webform tags are available only in content rendered inside a web template-based page template; inside a Rewrite-based page template they render nothing, and only a single entityform or webform tag is rendered per page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const COPY = "<p>Before the form</p>{% entityform name: 'Other' %}";
const ATTACHED = 'a1000000-0000-4000-8000-000000000001';
const OTHER = 'a1000000-0000-4000-8000-000000000002';

async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'rewrite-page-form-tags-'));
  const files = {
    'website.yml': 'adx_websiteid: fixture-site\nadx_name: Invented rewrite forms',
    'Home.webpage.yml':
      'adx_webpageid: 0e000000-0000-4000-8000-000000000001\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: 0f000000-0000-4000-8000-000000000001',
    'Rewrite.webpage.yml': `adx_webpageid: 0e000000-0000-4000-8000-000000000002\nadx_name: Rewrite\nadx_partialurl: rewrite\nadx_parentpageid: 0e000000-0000-4000-8000-000000000001\nadx_pagetemplateid: 0f000000-0000-4000-8000-000000000002\nadx_entityform: ${ATTACHED}`,
    'Rewrite.webpage.copy.html': COPY,
    'Web.webpage.yml':
      'adx_webpageid: 0e000000-0000-4000-8000-000000000003\nadx_name: Web\nadx_partialurl: web\nadx_parentpageid: 0e000000-0000-4000-8000-000000000001\nadx_pagetemplateid: 0f000000-0000-4000-8000-000000000003',
    'Web.webpage.copy.html': COPY,
    'Home.pagetemplate.yml':
      'adx_pagetemplateid: 0f000000-0000-4000-8000-000000000001\nadx_name: Home template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Rewrite.pagetemplate.yml':
      'adx_pagetemplateid: 0f000000-0000-4000-8000-000000000002\nadx_name: Rewrite template\nadx_rewriteurl: ~/Pages/Page.aspx',
    'Web.pagetemplate.yml':
      'adx_pagetemplateid: 0f000000-0000-4000-8000-000000000003\nadx_name: Web template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': "<!doctype html><html><body>{% include 'Page Copy' %}</body></html>",
    'Attached.basicform.yml': `adx_entityformid: ${ATTACHED}\nadx_name: Attached\nadx_mode: 100000000`,
    'Other.basicform.yml': `adx_entityformid: ${OTHER}\nadx_name: Other\nadx_mode: 100000000`,
  };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const fields = [{ name: 'title', label: 'Title', required: true }];
  const app = await createSimulator({
    sourceDir: root,
    projectRoot: root,
    watch: false,
    initial: {
      mappings: {
        sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { title: { dataverseType: 'nvarchar' } } },
      },
      tables: { sample: [{ sampleid: 'first-row', title: 'First' }] },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: {
          [ATTACHED]: { entity: 'sample', mode: 100000000, fields },
          [OTHER]: { entity: 'sample', mode: 100000000, fields },
        },
      },
    },
  });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

// The rendered form carries its form id in its form configuration.
const formMarker = (id) => `"formId":"${id}"`;

test('a rewrite-based page renders its attached form and not a Liquid form tag in its copy', async (t) => {
  const app = await fixture(t);
  const html = await (await fetch(app.url + '/rewrite/')).text();
  assert.ok(html.includes('<p>Before the form</p>'));
  assert.ok(html.includes(formMarker(ATTACHED)));
  assert.ok(!html.includes(formMarker(OTHER)));
});

test('a web template-based page renders the first Liquid form tag of its copy', async (t) => {
  const app = await fixture(t);
  const html = await (await fetch(app.url + '/web/')).text();
  assert.ok(html.includes(formMarker(OTHER)));
  assert.ok(!html.includes(formMarker(ATTACHED)));
});
