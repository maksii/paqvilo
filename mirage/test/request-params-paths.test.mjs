// @test-kind contract: request.params on the account page and on the quick view document carries the request's cookies and never the runtime's own cookies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { authCookieName } from '../lib/auth-session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const WEBSITE = '5b1c2d3e-0000-4000-8000-00000000d00d';
const WIDGET = '5b1c2d3e-0000-4000-8000-00000000f00d';
const PARAMS = '{% for pair in request.params %}[{{ pair[0] | escape }}={{ pair[1] | escape }}]{% endfor %}';

const files = {
  'website.yml': `adx_name: Params site\nadx_websiteid: ${WEBSITE}\nadx_defaultlanguage: lang-en\nadx_website_language: 1033`,
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
  'web-pages/login/Login.webpage.yml':
    'adx_webpageid: login\nadx_name: Login\nadx_partialurl: login\nadx_parentpageid: home\nadx_pagetemplateid: main',
  'web-pages/login/Login.webpage.copy.html': `<p id="account">${PARAMS}</p>`,
  'sitemarker.yml': '- adx_sitemarkerid: m-login\n  adx_name: Login\n  adx_pageid: login',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '<p id="home">home</p>',
  'content-snippets/Head.contentsnippet.yml': 'adx_contentsnippetid: head\nadx_name: Head/Bottom',
  'content-snippets/Head.contentsnippet.value.html': `<meta id="layout" data-theme="{{ request.params.theme }}" content="${PARAMS}">`,
};

const quickSchema = {
  formName: 'Widget quick view',
  entity: 'widget',
  fields: [{ name: 'title', label: 'Title' }],
  layout: [
    {
      name: 'quick',
      label: 'quick',
      showLabel: true,
      columns: [{ width: '100%', sections: [{ name: 'quick', label: 'quick', rows: [[{ name: 'title' }]] }] }],
    },
  ],
};

async function portalFixture(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'request-params-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const quickCell = {
    type: 'quickform',
    id: 'Details',
    entity: 'widget',
    label: 'Widget quick view',
    schema: quickSchema,
  };
  const host = {
    entity: 'widget',
    fields: quickSchema.fields,
    layout: [
      {
        name: 'main',
        label: 'main',
        showLabel: true,
        columns: [{ width: '100%', sections: [{ name: 'main', label: 'main', rows: [[quickCell]] }] }],
      },
    ],
  };
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    port: 0,
    watch: false,
    initial: {
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid', fields: { title: { dataverseType: 'nvarchar' } } },
      },
      tables: { widget: [{ widgetid: WIDGET, title: 'Invented widget' }] },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: { host },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

test('the account page request.params carries the request cookies and not the runtime session cookie', async (t) => {
  const app = await portalFixture(t);
  const sessionName = authCookieName(new URL(app.url).port);
  const cookie = `theme=dark; ${sessionName}=session-secret-4c2e`;
  const page = await (await fetch(app.url + '/SignIn', { headers: { cookie } })).text();
  assert.match(page, /\[theme=dark\]/);
  assert.equal(page.includes(sessionName), false, 'the runtime session cookie is not a parameter');
  assert.equal(page.includes('session-secret-4c2e'), false, 'the runtime session value is not a parameter');
});

test('the quick view document layout carries the request cookies and not the runtime session cookie', async (t) => {
  const app = await portalFixture(t);
  const sessionName = authCookieName(new URL(app.url).port);
  const cookie = `theme=dark; ${sessionName}=session-secret-4c2e`;
  const url = `${app.url}/_portal/quickform-template-path/${WEBSITE}?entityname=widget&controlid=Details&entityid=${WIDGET}`;
  const page = await (await fetch(url, { headers: { cookie } })).text();
  assert.match(page, /data-theme="dark"/);
  assert.match(page, /\[theme=dark\]/);
  assert.equal(page.includes(sessionName), false, 'the runtime session cookie is not a parameter');
});
