// @test-kind contract: `lense resources --page` lists what the static page inspection lists (templates, snippets, web files), keeping its JSON fields; invented fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import resources from '../lense/commands/resources.mjs';
import { createFixture, SITE, ABOUT_ID } from './fixture.mjs';

test('C31: --page lists the templates, snippets and web files the page inspection finds, with their page relationship', async (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write(
    'page-templates/About.pagetemplate.yml',
    'adx_pagetemplateid: about-template\nadx_name: About template\nadx_webtemplateid: about-layout\nadx_usewebsiteheaderandfooter: false\n',
  );
  fx.write('web-templates/about/About.webtemplate.yml', 'adx_webtemplateid: about-layout\nadx_name: About layout\n');
  fx.write(
    'web-templates/about/About.webtemplate.source.html',
    "{% include 'Header' %}<p>{{ snippets['Promo'] }}</p><img src=\"/Logo.svg\">",
  );
  fx.write(
    'web-pages/about/About.webpage.yml',
    `adx_webpageid: ${ABOUT_ID}\nadx_partialurl: about-us\nadx_parentpageid: 00000000-0000-0000-0000-000000000001\nadx_pagetemplateid: about-template\n`,
  );
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const cfg = {
    siteName: 'test',
    envName: 'local',
    origin: 'https://portal.invalid',
    sourceDir: fx.dir,
    configFile: path.join(fx.dir, 'catalogue.yml'),
    site: SITE,
  };
  assert.equal(await resources(cfg, { page: '/about-us/', json: true, limit: '500' }), 0);
  const report = JSON.parse(lines.join('\n'));
  const byKind = (kind) => report.resources.filter((row) => row.kind === kind).map((row) => row.name);
  assert.ok(byKind('web-template').includes('About layout'));
  assert.ok(byKind('web-template').includes('Header'));
  assert.ok(byKind('content-snippet').includes('Promo'));
  assert.equal(byKind('content-snippet').includes('Footer/Text'), false, 'an unused snippet stays out');
  assert.ok(byKind('web-file').includes('Site Logo'));
  const header = report.resources.find((row) => row.kind === 'web-template' && row.name === 'Header');
  const about = report.resources.find((row) => row.id === `page:${ABOUT_ID}`);
  assert.deepEqual(header.inspectedPageUrls, [about.url], 'the page record URL, as relatedPageUrls carry it');
  assert.ok(
    report.relationships.some(
      (edge) => edge.sourceId === header.id && edge.targetId === `page:${ABOUT_ID}` && edge.kind === 'used-by-page',
    ),
  );
  for (const field of ['schemaVersion', 'resources', 'relationships', 'pagination', 'relationshipScope'])
    assert.ok(Object.hasOwn(report, field), field);
  assert.equal(report.pageInspection.page.id, ABOUT_ID);
});
