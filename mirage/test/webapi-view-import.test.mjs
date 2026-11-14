import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { ownedFixture, makeTemporaryDirectory, assertTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('imported Web API view columns combine with explicit fields without exposing related, filter or sort columns', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-api-column-view-'));
  const portal = path.join(directory, 'portal'),
    solution = path.join(directory, 'solution');
  ownedFixture(t).remove(async () => {
    const physical = await assertTemporaryDirectory(directory, { directChild: true });
    await fs.rm(physical, { recursive: true, force: true });
  });
  const attribute = (name, type = 'nvarchar') =>
    `<attribute PhysicalName="${name}"><LogicalName>${name}</LogicalName><Name>${name}</Name><Type>${type}</Type></attribute>`;
  const files = {
    'portal/website.yml': 'adx_websiteid: invented-site\nadx_name: Invented column-view site',
    'portal/settings.sitesetting.yml':
      "- adx_name: Webapi/viewwidget/enabled\n  adx_value: 'true'\n- adx_name: Webapi/viewwidget/fields\n  adx_value: tagline\n- adx_name: Webapi/viewwidget/UseFieldsFromView\n  adx_value: 'true'",
    'solution/Entities/viewwidget/Entity.xml': `<Entity><Name>viewwidget</Name><EntityInfo><entity><attributes>${attribute('viewwidgetid', 'primarykey')}${attribute('title')}${attribute('tagline')}${attribute('groupid', 'lookup')}${attribute('filteronly')}${attribute('sortonly')}${attribute('relatedlabel')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/viewwidget/SavedQueries/{column-view}.xml':
      '<savedqueries><savedquery><savedqueryid>{column-view}</savedqueryid><querytype>0</querytype><layoutxml><grid><row><cell name="title"/><cell name="groupid"/><cell name="g.relatedlabel"/></row></grid></layoutxml><fetchxml><fetch><entity name="viewwidget"><attribute name="title"/><attribute name="groupid"/><attribute name="filteronly"/><attribute name="sortonly"/><filter><condition attribute="filteronly" operator="eq" value="included"/></filter><order attribute="sortonly"/><link-entity name="viewgroup" alias="g" from="viewgroupid" to="groupid"><attribute name="relatedlabel"/></link-entity></entity></fetch></fetchxml><LocalizedNames><LocalizedName description="Power Pages Web API Columns" languagecode="1033"/></LocalizedNames></savedquery></savedqueries>',
  };
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  const metadata = await importSolutionMetadata(solution, {
    portal: { forms: [], lists: [], records: [], settings: { 'Webapi/viewwidget/UseFieldsFromView': 'true' } },
  });
  assert.deepEqual(
    metadata.views[0].fields.map((field) => field.name),
    ['title', 'groupid', 'g.relatedlabel'],
  );
  assert.equal(metadata.entities.viewwidget.fields.groupid.dataverseType, 'lookup');
  const id = '10000000-0000-4000-8000-000000000001',
    groupId = '20000000-0000-4000-8000-000000000002';
  const app = await createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    watch: false,
    initial: {
      mappings: { viewwidget: { entitySet: 'viewwidgets', idColumn: 'viewwidgetid' } },
      tables: {
        viewwidget: [
          {
            viewwidgetid: id,
            title: 'View title',
            tagline: 'Explicit tagline',
            groupid: groupId,
            filteronly: 'included',
            sortonly: 'sort value',
            relatedlabel: 'Hidden primary label',
          },
        ],
      },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identityScope: 'configured',
        identity: { id: 'invented-persona', roles: [] },
        endpoints: [],
        live: {},
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const get = (query) =>
    fetch(app.url + '/_api/viewwidgets?' + new URLSearchParams(query), {
      headers: { __RequestVerificationToken: app.csrf },
    });
  const allowed = await get({ $select: 'title,tagline,_groupid_value' });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const result = (await allowed.json()).value;
  assert.equal(result.length, 1);
  const { '@odata.etag': etag, ...columns } = result[0];
  assert.match(etag, /^W\/"\d+"$/);
  assert.deepEqual(columns, {
    viewwidgetid: id,
    title: 'View title',
    tagline: 'Explicit tagline',
    _groupid_value: groupId,
  });
  for (const query of [
    { $select: 'relatedlabel' },
    { $select: 'filteronly' },
    { $select: 'sortonly' },
    { $select: 'title', $filter: "filteronly eq 'included'" },
    { $select: 'title', $orderby: 'sortonly asc' },
  ]) {
    const denied = await get(query);
    assert.equal(denied.status, 403, JSON.stringify(query));
    assert.equal(denied.headers.get('x-sim-error-code'), 'WebApiFieldNotEnabled');
  }
});
