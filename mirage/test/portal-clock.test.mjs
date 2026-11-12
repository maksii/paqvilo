// @test-kind contract: the portal reads its current time from the runtime clock for page Liquid, web file release dates and on-save date values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const WEBSITE = '5b1c2d3e-0000-4000-8000-00000000c10c';
const CLOCK_AT = Date.parse('2031-05-05T10:00:00Z');

const layout = [
  {
    name: 'main',
    label: 'main',
    showLabel: true,
    columns: [
      {
        width: '100%',
        sections: [{ name: 'main', label: 'main', rows: [[{ name: 'title' }], [{ name: 'stamp' }]] }],
      },
    ],
  },
];

const files = {
  'website.yml': `adx_name: Clock site\nadx_websiteid: ${WEBSITE}\nadx_defaultlanguage: lang-en\nadx_website_language: 1033`,
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': `<p id="now">{{ now | date: 'yyyy-MM-dd' }}</p>{% entityform name: "Create widget" %}`,
  'web-files/released.txt.webfile.yml':
    'adx_webfileid: released\nadx_name: released.txt\nadx_partialurl: released.txt\nadx_parentpageid: home\nreleasedate: 2030-01-01T00:00:00Z\nfilename: released.txt\nmimetype: text/plain',
  'web-files/released.txt': 'released body',
  'web-files/later.txt.webfile.yml':
    'adx_webfileid: later\nadx_name: later.txt\nadx_partialurl: later.txt\nadx_parentpageid: home\nreleasedate: 2032-01-01T00:00:00Z\nfilename: later.txt\nmimetype: text/plain',
  'web-files/later.txt': 'later body',
  'Widget.basicform.yml':
    'adx_entityformid: create\nadx_name: Create widget\nadx_entityname: widget\nadx_mode: 100000000',
  'Widget.basicform.basicformmetadata.yml':
    'adx_entityform: create\nadx_type: 100000000\nadx_attributelogicalname: stamp\nadx_setvalueonsave: true\nadx_onsavetype: 100000001',
};

const fields = [
  { name: 'title', label: 'Title' },
  { name: 'stamp', label: 'Stamp' },
];

async function portalFixture(t, overrides = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-clock-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries({ ...files, ...overrides })) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  const initial = {
    mappings: {
      widget: {
        entitySet: 'widgets',
        idColumn: 'widgetid',
        fields: { title: { dataverseType: 'nvarchar' }, stamp: { dataverseType: 'datetime' } },
      },
    },
    tables: { widget: [] },
    permissions: [],
    settings: { permissionMode: 'permissive' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { roles: [] },
      live: {},
      endpoints: [],
      componentSchemas: {
        create: { entity: 'widget', fields, layout },
      },
    },
  };
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    clock: fixedClock(CLOCK_AT),
    initial,
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

async function insertWidget(app, page) {
  const ids = nativeFormControlIds('entityform', 'create');
  const viewState = /name="__VIEWSTATE" id="__VIEWSTATE" value="([^"]*)"/.exec(page)[1];
  const saved = await fetch(app.url + '/', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['__RequestVerificationToken', app.csrf],
      ['__EVENTTARGET', ids.buttons + 'InsertButton'],
      ['__EVENTARGUMENT', ''],
      ['__VIEWSTATE', viewState],
      [ids.names + 'title', 'Invented widget'],
    ]),
  });
  assert.equal(saved.status, 200);
  const [row] = app.store.snapshot().tables.widget;
  assert.ok(row, 'the form saved a widget');
  assert.equal(String(row.stamp).slice(0, 10), '2031-05-05');
}

test('a page renders the runtime clock date for now', async (t) => {
  const app = await portalFixture(t);
  const html = await (await fetch(app.url + '/')).text();
  assert.match(html, /<p id="now">2031-05-05<\/p>/);
});

test('web file release dates are judged on the runtime clock', async (t) => {
  const app = await portalFixture(t);
  const released = await fetch(app.url + '/released.txt');
  assert.equal(released.status, 200);
  assert.equal(await released.text(), 'released body');
  const later = await fetch(app.url + '/later.txt');
  assert.notEqual(await later.text(), 'later body');
});

test('an on-save date column stores the runtime clock date', async (t) => {
  const app = await portalFixture(t);
  await insertWidget(app, await (await fetch(app.url + '/')).text());
});

test('a web file not yet released answers 404 with the same response as an unknown path', async (t) => {
  const app = await portalFixture(t);
  const later = await fetch(app.url + '/later.txt');
  const unknown = await fetch(app.url + '/no-such-file.txt');
  assert.equal(later.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(await later.text(), (await unknown.text()).replace('/no-such-file.txt', '/later.txt'));
});

// @test-kind contract: a form date prepopulated with the current date reads the runtime clock, the same clock the on-save value uses.
test('a prepopulated form date shows the runtime clock day and the on-save date stores that day', async (t) => {
  const app = await portalFixture(t, {
    'web-templates/Main.webtemplate.source.html': '{% entityform name: "Create widget" %}',
    'Widget.basicform.basicformmetadata.yml': `adx_entityform: create
adx_type: 100000000
adx_attributelogicalname: stamp
adx_prepopulatetype: 100000001
adx_setvalueonsave: true
adx_onsavetype: 100000001`,
  });
  const first = await (await fetch(app.url + '/')).text();
  assert.ok(first.includes('2031-05-05'), 'the prepopulated date is the runtime clock day');
  await insertWidget(app, first);
});
