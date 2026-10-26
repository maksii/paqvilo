// Hierarchy query operators for portal callers: a Liquid fetchxml `under` condition and a portal Web API $filter with
// Microsoft.Dynamics.CRM.Under resolve through the organization's hierarchy module (the host query scope). A table that is
// not hierarchical keeps the documented refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const id = (n) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const ROOT = id(41),
  BRANCH = id(42),
  LEAF = id(43),
  OTHER = id(44);

const files = {
  'website.yml':
    'adx_name: Invented Hierarchy\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html':
    `{% fetchxml nodes %}<fetch><entity name="x_node"><attribute name="x_name"/><order attribute="x_name"/>` +
    `<filter><condition attribute="x_nodeid" operator="under" value="${ROOT}"/></filter></entity></fetch>{% endfetchxml %}` +
    `<p id="under">{% for row in nodes.results.entities %}{{ row.x_name }};{% endfor %}</p>`,
  'sitesetting.yml': [
    'Webapi/x_node/enabled: "true"',
    'Webapi/x_node/fields: "x_name,x_nodeid,x_parentid"',
    'Webapi/x_plain/enabled: "true"',
    'Webapi/x_plain/fields: "x_name,x_plainid"',
  ]
    .map((line, index) => {
      const [name, value] = line.split(': ');
      return `- adx_sitesettingid: 5e000000-0000-4000-8000-0000000000${40 + index}\n  adx_name: ${name}\n  adx_value: ${value}`;
    })
    .join('\n'),
};

const initial = {
  version: 1,
  mappings: {
    x_node: {
      logicalName: 'x_node',
      entitySet: 'x_nodes',
      idColumn: 'x_nodeid',
      nameColumn: 'x_name',
      relationships: {
        x_parentid: { entity: 'x_node', from: 'x_parentid', to: 'x_nodeid', many: false, hierarchical: true },
      },
      fields: { x_name: { dataverseType: 'nvarchar' }, x_parentid: { dataverseType: 'uniqueidentifier' } },
    },
    x_plain: {
      logicalName: 'x_plain',
      entitySet: 'x_plains',
      idColumn: 'x_plainid',
      nameColumn: 'x_name',
      fields: { x_name: { dataverseType: 'nvarchar' } },
    },
  },
  tables: {
    x_node: [
      { x_nodeid: ROOT, x_name: 'Invented root', x_parentid: null },
      { x_nodeid: BRANCH, x_name: 'Invented branch', x_parentid: ROOT },
      { x_nodeid: LEAF, x_name: 'Invented leaf', x_parentid: BRANCH },
      { x_nodeid: OTHER, x_name: 'Invented other', x_parentid: null },
    ],
    x_plain: [{ x_plainid: id(45), x_name: 'Invented plain' }],
  },
  permissions: [],
  settings: { permissionMode: 'permissive' },
  simulator: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
};

async function portalFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-hierarchy-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const sim = await createSimulator({
    sourceDir: dir,
    port: 0,
    watch: false,
    initial,
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test('a Liquid fetchxml under condition and a portal Web API Under filter select the records under a root', async (t) => {
  const sim = await portalFixture(t);
  const page = await fetch(sim.url + '/');
  const html = await page.text();
  assert.equal(page.status, 200, html);
  assert.match(html, /id="under">Invented branch;Invented leaf;<\/p>/);

  const filter = encodeURIComponent(`Microsoft.Dynamics.CRM.Under(PropertyName='x_nodeid',PropertyValue='${ROOT}')`);
  const response = await fetch(`${sim.url}/_api/x_nodes?$select=x_name&$orderby=x_name&$filter=${filter}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.value.map((row) => row.x_name),
    ['Invented branch', 'Invented leaf'],
  );

  // A table without a hierarchical relationship keeps the refusal (the portal answers its generic 400 envelope).
  const plain = encodeURIComponent(`Microsoft.Dynamics.CRM.Under(PropertyName='x_plainid',PropertyValue='${id(45)}')`);
  const refused = await fetch(`${sim.url}/_api/x_plains?$filter=${plain}`);
  const error = await refused.json();
  assert.equal(refused.status, 400, JSON.stringify(error));
  assert.equal(error.error.code, '9004010A', 'the portal envelope of a refused query');
});
