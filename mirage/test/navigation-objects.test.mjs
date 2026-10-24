import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPortal } from '../lib/importer.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';

const guid = (n) => `a6cce910-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture(t, model, setFields = {}, sidecar = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-navigation-objects-'));
  t.after(async () => {
    assert(root.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const key = (name) => (model === 'standard' ? 'adx_' : '') + name;
  const record = (values) => Object.fromEntries(Object.entries(values).map(([name, value]) => [key(name), value]));
  const files = {
    'website.yml': record({ websiteid: guid(1), name: 'Invented navigation fixture' }),
    'web-pages/home/Home.webpage.yml': record({ webpageid: guid(10), name: 'Home', partialurl: '/' }),
    'web-pages/guide/Guide.webpage.yml': record({
      webpageid: guid(11),
      name: 'Guide',
      parentpageid: guid(10),
      partialurl: 'guide',
    }),
    'web-pages/guidelines/Guidelines.webpage.yml': record({
      webpageid: guid(12),
      name: 'Guidelines',
      parentpageid: guid(10),
      partialurl: 'guidelines',
    }),
    'web-pages/chapter/Chapter.webpage.yml': record({
      webpageid: guid(13),
      name: 'Chapter',
      parentpageid: guid(11),
      partialurl: 'chapter',
    }),
    'weblink-sets/nav/Nav.weblinkset.yml': record({ weblinksetid: guid(20), name: 'ExampleMenu', ...setFields }),
    'weblink-sets/nav/Nav.weblink.yml': [
      record({ weblinkid: guid(21), name: 'Guide link', weblinksetid: guid(20), pageid: guid(11), displayorder: 1 }),
      record({ weblinkid: guid(22), name: 'Home link', weblinksetid: guid(20), pageid: guid(10), displayorder: 2 }),
      record({
        weblinkid: guid(23),
        name: 'External link',
        weblinksetid: guid(20),
        externalurl: 'https://example.invalid/guide/',
        displayorder: 3,
      }),
    ],
  };
  for (const [file, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify(value));
  }
  if (sidecar != null) await fs.writeFile(path.join(root, 'weblink-sets/nav/Nav.weblinkset.copy.html'), sidecar);
  const portal = await importPortal(root, { dataModel: model });
  const renderer = createPortalRenderer(portal);
  const render = async (source, url = '/') => {
    const page = portal.pages.find((p) => p.url === new URL(url, 'http://localhost').pathname);
    assert(page, 'test page must exist');
    return renderer.renderString(source, renderer.contextForPage(page, url));
  };
  return { portal, renderer, render, key };
}

for (const model of ['standard', 'enhanced']) {
  test(`${model} navigation set retains title, copy and typed logical attributes by name and ID`, async (t) => {
    const { portal, render, key } = await fixture(t, model, {
      title: 'Useful links',
      copy: 'Read the guide',
      createdon: '2024-02-03T04:05:06Z',
      versionnumber: 23,
    });
    const set = portal.weblinkSets[0];
    assert.equal(set.title, 'Useful links');
    assert.equal(set.copy, 'Read the guide');
    assert.equal(set.metadata[key('versionnumber')], 23);
    assert.equal(set.metadata[key('weblinksetid')], guid(20));
    for (const selector of ['ExampleMenu', guid(20)]) {
      assert.equal(
        await render(
          `{{ weblinks['${selector}'].title }}|{{ weblinks['${selector}'].copy }}|{{ weblinks['${selector}'].${key('createdon')} | date: 'yyyy-MM-dd' }}|{{ weblinks['${selector}'].${key('versionnumber')} }}|{{ weblinks['${selector}'].id }}`,
        ),
        `Useful links|Read the guide|2024-02-03|23|${guid(20)}`,
      );
    }
  });

  test(`${model} optional set title/copy retain absent and explicit empty values`, async (t) => {
    const absent = await fixture(t, model);
    assert.equal(absent.portal.weblinkSets[0].title, null);
    assert.equal(absent.portal.weblinkSets[0].copy, null);
    assert.equal(await absent.render("{{ weblinks['ExampleMenu'].title }}|{{ weblinks['ExampleMenu'].copy }}"), '|');
    const empty = await fixture(t, model, { title: '', copy: '' });
    assert.equal(empty.portal.weblinkSets[0].title, '');
    assert.equal(empty.portal.weblinkSets[0].copy, '');
    const explicitNull = await fixture(t, model, { title: null, copy: null });
    assert.equal(explicitNull.portal.weblinkSets[0].title, null);
    assert.equal(explicitNull.portal.weblinkSets[0].copy, null);
    assert.equal(explicitNull.portal.weblinkSets[0].metadata[explicitNull.key('copy')], null);
  });

  test(`${model} set content selects the requested LCID without modifying raw localization`, async (t) => {
    const title = JSON.stringify([
      { LCID: 1033, Value: 'Useful links' },
      { LCID: 1036, Value: 'Liens utiles' },
    ]);
    const { portal } = await fixture(t, model, { title });
    const imported = await importPortal(portal.sourceDir, { dataModel: model, lcid: 1036 });
    assert.equal(imported.weblinkSets[0].title, 'Liens utiles');
    assert.equal(imported.weblinkSets[0].metadata[model === 'standard' ? 'adx_title' : 'title'], title);
  });

  test(`${model} sitemap flags follow page ancestry rather than matching URL prefixes`, async (t) => {
    const { render } = await fixture(t, model);
    const flags =
      "{% for link in weblinks['ExampleMenu'].weblinks %}{{ link.is_sitemap_current }}/{{ link.is_sitemap_ancestor }};{% endfor %}";
    assert.equal(await render(flags, '/guidelines/'), 'false/false;false/true;false/false;');
    assert.equal(await render(flags, '/guide/'), 'true/false;false/true;false/false;');
    assert.equal(await render(flags, '/guide/chapter/'), 'false/true;false/true;false/false;');
    assert.equal(await render(flags, '/guide/chapter/?ordinary=value'), 'false/true;false/true;false/false;');
    assert.equal(await render(flags, '/'), 'false/false;true/false;false/false;');
  });
}

test('standard navigation set separate copy source takes precedence over inline copy', async (t) => {
  const { portal, render } = await fixture(t, 'standard', { copy: 'Inline copy' }, 'Separate source copy');
  assert.equal(portal.weblinkSets[0].copy, 'Separate source copy');
  assert.equal(portal.weblinkSets[0].metadata.adx_copy, 'Inline copy');
  assert.equal(await render("{{ weblinks['ExampleMenu'].copy }}"), 'Separate source copy');
});
