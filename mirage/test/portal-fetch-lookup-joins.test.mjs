// @test-kind contract: signed-in Liquid and portal FetchXML keep lookup labels and scoped joins usable
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { signInHeaders } from '../testing/session.mjs';

const id = (n) => `00100000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const site = id(1);
const visitor = id(2);
const foreign = id(3);
const reader = 'Reader';
const signedIn = { roles: [reader] };
const permission = (entity, scope, extra = {}) => ({
  id: entity,
  entity,
  scope,
  roles: [reader],
  operations: ['read'],
  ...extra,
});

function fetchTag(name, source, primaryKey, label) {
  return (
    `{% fetchxml ${name} %}${source}{% endfetchxml %}<section id="${name}">` +
    `{% for row in ${name}.results.entities %}{{ row.${primaryKey} }}={{ row.${label} }};{% endfor %}</section>`
  );
}

function extract(html, section) {
  const match = new RegExp(`<section id="${section}">([^<]*)</section>`).exec(html);
  assert.ok(match, section);
  return match[1]
    .split(';')
    .filter(Boolean)
    .map((pair) => {
      const [key, label] = pair.split('=');
      return [key, label || null];
    })
    .sort();
}

async function startPortal(t, { template, webApi, mappings, tables, permissions, observed = {} }) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-fetch-lookup-'));
  const owned = ownedFixture(t);
  owned.remove(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, 'site');
  await fs.mkdir(sourceDir);
  const settings = Object.entries(webApi).flatMap(([entity, fields]) => [
    `- adx_name: Webapi/${entity}/enabled\n  adx_value: "true"`,
    `- adx_name: Webapi/${entity}/fields\n  adx_value: "${fields}"`,
  ]);
  const files = {
    'website.yml': `adx_websiteid: ${site}\nadx_name: FetchXML fixture`,
    'home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: page',
    'home.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: template',
    'home.webtemplate.yml': 'adx_webtemplateid: template\nadx_name: Home',
    'home.webtemplate.source.html': template,
    'sitesetting.yml': [...settings, '- adx_name: Webapi/error/innererror\n  adx_value: "true"'].join('\n'),
  };
  await Promise.all(Object.entries(files).map(([file, value]) => fs.writeFile(path.join(sourceDir, file), value)));
  const app = await createSimulator({
    sourceDir,
    watch: false,
    projectRoot: directory,
    observed: {
      tablePermissionQueryPipeline: 'native-classic',
      evidence: 'Invented FetchXML fixture for portal entry points and permission-query joins',
      ...observed,
    },
    initial: {
      mappings,
      tables: {
        contact: [
          { contactid: visitor, fullname: 'Visitor' },
          { contactid: foreign, fullname: 'Foreign' },
          ...(tables.contact ?? []),
        ],
        ...Object.fromEntries(Object.entries(tables).filter(([entity]) => entity !== 'contact')),
      },
      permissions,
      settings: { permissionMode: 'enforce', fetchColumnValidation: 'strict' },
      simulator: { permissionSource: 'configured' },
    },
  });
  owned.add(() => app.close());
  const headers = signInHeaders(app, visitor, signedIn);
  return {
    app,
    headers,
    get: (suffix) => fetch(app.url + suffix, { headers }),
    fetchXml: (entitySet, source) =>
      fetch(`${app.url}/_api/${entitySet}?fetchXml=${encodeURIComponent(source)}`, { headers }),
  };
}

const rootCondition = (attribute, operator, value) =>
  `<condition attribute="${attribute}" operator="${operator}" value="${value}"/>`;

function cardQuery(condition, column = 'categoryidname') {
  return `<fetch><entity name="card"><attribute name="cardid"/><attribute name="${column}"/><filter>${condition}</filter></entity></fetch>`;
}

test('configured lookup display names follow the current related primary name under portal row permissions', async (t) => {
  const selectedTarget = id(10);
  const otherTarget = id(11);
  const card = id(12);
  const hidden = id(13);
  const otherCard = id(14);
  const missingTarget = id(15);
  const nullLookup = id(16);
  const nullName = id(17);
  const condition = rootCondition('categoryidname', 'eq', 'Entry Alpha');
  const renamed = rootCondition('categoryidname', 'like', 'Entry Updated%');
  const missing = '<condition attribute="categoryidname" operator="null"/>';
  const suffix = cardQuery(rootCondition('sortyominame', 'eq', 'Entry Alpha'), 'sortyominame');
  const polymorphic = cardQuery(rootCondition('subjectidname', 'eq', 'Reference Label'), 'subjectidname');
  const category = { entity: 'contact', from: 'categoryid', to: 'contactid', many: false };
  const fixture = await startPortal(t, {
    template: [
      fetchTag('selectedTarget', cardQuery(condition), 'cardid', 'categoryidname'),
      fetchTag('renamed', cardQuery(renamed), 'cardid', 'categoryidname'),
      fetchTag('missing', cardQuery(missing), 'cardid', 'categoryidname'),
      fetchTag('suffix', suffix, 'cardid', 'sortyominame'),
      fetchTag('polymorphic', polymorphic, 'cardid', 'subjectidname'),
    ].join(''),
    webApi: { card: 'categoryid,categoryidname,sortyominame,subjectidname,titlename' },
    mappings: {
      contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
      reference: { entitySet: 'references', idColumn: 'referenceid', nameColumn: 'title' },
      card: {
        entitySet: 'cards',
        idColumn: 'cardid',
        schemaComplete: true,
        fields: {
          categoryid: { dataverseType: 'lookup' },
          sortyomi: { dataverseType: 'lookup', target: 'contact' },
          subjectid: { dataverseType: 'lookup', targets: ['contact', 'reference'] },
          unlistedid: { dataverseType: 'lookup', targets: ['contact'] },
          viewerid: { dataverseType: 'lookup' },
          title: { dataverseType: 'nvarchar' },
        },
        relationships: { category },
      },
    },
    tables: {
      contact: [
        { contactid: selectedTarget, fullname: 'Entry Alpha' },
        { contactid: otherTarget, fullname: 'Entry Beta' },
        { contactid: id(91), fullname: null, name: 'Unrelated fallback' },
      ],
      reference: [{ referenceid: selectedTarget, title: 'Stored reference title' }],
      card: [
        { cardid: card, viewerid: visitor, categoryid: { id: selectedTarget, logical_name: 'contact', name: 'Stale' } },
        { cardid: hidden, viewerid: foreign, categoryid: selectedTarget },
        {
          cardid: otherCard,
          viewerid: visitor,
          categoryid: otherTarget,
          sortyomi: selectedTarget,
          _subjectid_value: selectedTarget,
          '_subjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'reference',
        },
        {
          cardid: missingTarget,
          viewerid: visitor,
          categoryid: { id: id(90), logical_name: 'contact', name: 'Deleted category' },
        },
        { cardid: nullLookup, viewerid: visitor, categoryid: null },
        { cardid: nullName, viewerid: visitor, categoryid: id(91) },
      ],
    },
    permissions: [permission('card', 'contact', { field: 'viewerid', operations: ['read', 'update'] })],
  });
  fixture.app.store.setComputedColumns('reference-title', {
    columnsOf: (entity) => (entity === 'reference' ? ['title'] : []),
    compute: () => 'Reference Label',
  });
  const api = async (cond, column) => {
    const response = await fixture.fetchXml('cards', cardQuery(cond, column));
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).value.map((row) => [row.cardid, row.categoryidname ?? null]).sort();
  };
  const page = async () => {
    const response = await fixture.get('/');
    assert.equal(response.status, 200);
    return response.text();
  };
  const initial = await page();
  assert.deepEqual(extract(initial, 'selectedTarget'), [[card, 'Entry Alpha']]);
  assert.deepEqual(extract(initial, 'renamed'), []);
  assert.deepEqual(extract(initial, 'suffix'), [[otherCard, 'Entry Alpha']]);
  assert.deepEqual(extract(initial, 'polymorphic'), [[otherCard, 'Reference Label']]);
  const withoutDisplayNames = [
    [missingTarget, null],
    [nullLookup, null],
    [nullName, null],
  ];
  assert.deepEqual(extract(initial, 'missing'), withoutDisplayNames);
  assert.deepEqual(await api(condition), [[card, 'Entry Alpha']]);
  assert.deepEqual(await api(rootCondition('categoryid', 'eq', selectedTarget)), [[card, 'Entry Alpha']]);
  assert.deepEqual(await api(missing), withoutDisplayNames);
  const sorting = await fixture.fetchXml('cards', suffix);
  assert.equal(sorting.status, 200, await sorting.clone().text());
  assert.deepEqual(
    (await sorting.json()).value.map((row) => [row.cardid, row.sortyominame]),
    [[otherCard, 'Entry Alpha']],
  );
  const annotation = await fixture.fetchXml('cards', polymorphic);
  assert.equal(annotation.status, 200, await annotation.clone().text());
  assert.deepEqual(
    (await annotation.json()).value.map((row) => [row.cardid, row.subjectidname]),
    [[otherCard, 'Reference Label']],
  );

  await fixture.app.store.update('contact', selectedTarget, { fullname: 'Entry Updated' }, { admin: true });
  const after = await page();
  assert.deepEqual(extract(after, 'selectedTarget'), []);
  assert.deepEqual(extract(after, 'renamed'), [[card, 'Entry Updated']]);
  assert.deepEqual(await api(condition), []);
  assert.deepEqual(await api(renamed), [[card, 'Entry Updated']]);
  assert.deepEqual(await api(rootCondition('cardid', 'eq', hidden)), []);

  for (const [column, status, code] of [
    ['unlistedidname', 403, '90040101'],
    ['titlename', 400, '90040100'],
  ]) {
    const response = await fixture.fetchXml('cards', cardQuery(rootCondition(column, 'eq', 'Entry Alpha'), column));
    assert.equal(response.status, status, await response.clone().text());
    assert.equal((await response.json()).error.code, code);
  }
  const write = await fetch(`${fixture.app.url}/_api/cards(${card})`, {
    method: 'PATCH',
    headers: {
      ...fixture.headers,
      'content-type': 'application/json',
      __RequestVerificationToken: fixture.app.portalToken,
    },
    body: JSON.stringify({ categoryidname: 'Invented override' }),
  });
  assert.equal(write.status, 400, await write.text());
  assert.deepEqual(await api(renamed), [[card, 'Entry Updated']]);
});

test('a scalar OData read keeps its stored values when the portal translates it to FetchXML', async (t) => {
  const card = id(21);
  const fixture = await startPortal(t, {
    template: '',
    webApi: { card: 'cardid,categoryidname' },
    mappings: {
      card: {
        entitySet: 'cards',
        idColumn: 'cardid',
        fields: { categoryid: { dataverseType: 'lookup', target: 'contact' } },
      },
    },
    tables: { card: [{ cardid: card, categoryid: visitor, categoryidname: 'Stored text' }] },
    permissions: [permission('card', 'global')],
    observed: { odataPermissionQueryPipeline: 'native-classic' },
  });
  const odata = await fixture.get('/_api/cards?$select=cardid,categoryidname');
  assert.equal(odata.status, 200, await odata.clone().text());
  assert.deepEqual(
    (await odata.json()).value.map((row) => [row.cardid, row.categoryidname]),
    [[card, 'Stored text']],
  );

  const xml =
    '<fetch><entity name="card"><attribute name="cardid"/><attribute name="categoryidname"/></entity></fetch>';
  const fetchXml = await fixture.fetchXml('cards', xml);
  assert.equal(fetchXml.status, 200, await fetchXml.clone().text());
  assert.deepEqual(
    (await fetchXml.json()).value.map((row) => [row.cardid, row.categoryidname]),
    [[card, 'Visitor']],
  );
});

const allowedGroup = id(100);
const foreignGroup = id(101);
const sampleGroups = (count) =>
  Array.from({ length: count }, (_, index) => ({
    samplegroupid: id(index + 100),
    readerid: index <= 1 ? foreign : visitor,
    sharedid: index === 1 ? foreign : visitor,
    groupreaderid: index === 1 ? foreign : visitor,
  }));

const labels = Array.from({ length: 501 }, (_, index) => ({
  tagid: id(1000 + index),
  category: 'shared',
  label: `Tag ${index}`,
}));

const joinShapes = {
  entry:
    '<link-entity name="tag" from="category" to="category" alias="vocab" link-type="outer"><attribute name="label" alias="taglabel"/></link-entity>',
  enrollment:
    '<link-entity name="participant" from="participantid" to="participantid" alias="person" link-type="outer">' +
    '<link-entity name="participanttag" from="participantid" to="participantid" alias="taglink" intersect="true" link-type="outer">' +
    '<link-entity name="tag" from="tagid" to="tagid" alias="vocab" link-type="outer"><attribute name="label" alias="taglabel"/></link-entity>' +
    '</link-entity></link-entity>',
};

function joinedQuery(entity, filter = '') {
  return (
    `<fetch><entity name="${entity}"><attribute name="${entity}id"/>` +
    (filter ? `<filter type="and">${filter}</filter>` : '') +
    joinShapes[entity] +
    '</entity></fetch>'
  );
}

function joinFixture(count) {
  const groups = sampleGroups(count);
  const participant = id(2000);
  const entry = groups.map(({ samplegroupid }, index) => ({
    entryid: id(3000 + index),
    samplegroupid,
    selectedgroupid: allowedGroup,
    category: 'shared',
  }));
  entry.push({ entryid: id(4000), samplegroupid: allowedGroup, selectedgroupid: allowedGroup, category: 'missing' });
  const enrollment = groups.map(({ samplegroupid }, index) => ({
    enrollmentid: id(5000 + index),
    samplegroupid,
    selectedgroupid: allowedGroup,
    participantid: participant,
  }));
  enrollment.push({
    enrollmentid: id(6000),
    samplegroupid: allowedGroup,
    selectedgroupid: allowedGroup,
    participantid: null,
  });
  const participanttag = labels.map(({ tagid }, index) => ({
    participanttagid: id(7000 + index),
    participantid: participant,
    tagid,
  }));
  const roots = Object.keys(joinShapes);
  const paths = ['readerid', 'sharedid', 'groupreaderid'];
  const lookup = { dataverseType: 'lookup' };
  const rootFields = { samplegroupid: lookup, selectedgroupid: lookup };
  const fields = {
    entry: { ...rootFields, category: { dataverseType: 'nvarchar' } },
    enrollment: { ...rootFields, participantid: lookup },
    tag: { category: { dataverseType: 'nvarchar' }, label: { dataverseType: 'nvarchar' } },
    participanttag: { participantid: lookup, tagid: lookup },
    samplegroup: Object.fromEntries(paths.map((field) => [field, lookup])),
    participant: {},
  };
  const mappings = Object.fromEntries(
    Object.entries(fields).map(([entity, definitions]) => [
      entity,
      { entitySet: entity + 's', idColumn: entity + 'id', fields: definitions, schemaComplete: true },
    ]),
  );
  mappings.participant.relationships = {
    tags: {
      entity: 'tag',
      from: 'participantid',
      to: 'tagid',
      many: true,
      intersect: { entity: 'participanttag', from: 'participantid', to: 'tagid' },
    },
  };
  const permissions = [
    ...paths.map((field) => permission('samplegroup', 'contact', { id: field, field })),
    ...roots.flatMap((entity) =>
      paths.map((field) =>
        permission(entity, 'parent', {
          id: `${entity}-${field}`,
          parentPermissionId: field,
          relationship: { entity: 'samplegroup', from: 'samplegroupid', to: 'samplegroupid' },
        }),
      ),
    ),
    ...['tag', 'participant'].map((entity) => permission(entity, 'global')),
  ];
  const content = {
    webApi: Object.fromEntries(
      ['entry', 'enrollment', 'tag', 'participant'].map((entity) => [
        entity,
        [entity + 'id', ...Object.keys(fields[entity])].join(','),
      ]),
    ),
    mappings,
    tables: {
      samplegroup: groups,
      entry,
      enrollment,
      participant: [{ participantid: participant }],
      participanttag,
      tag: labels,
    },
    permissions,
  };
  const categoryLabels = (row) => labels.filter((label) => label.category === row.category);
  const participantLabels = (row) => {
    const ids = new Set(
      participanttag.filter((edge) => edge.participantid === row.participantid).map((edge) => edge.tagid),
    );
    return labels.filter((label) => ids.has(label.tagid));
  };
  const oracle = (entity, key) =>
    content.tables[entity]
      .filter(
        (row) =>
          row.samplegroupid === key &&
          groups.some((group) => group.samplegroupid === key && paths.some((field) => group[field] === visitor)),
      )
      .flatMap((row) => {
        const matches = entity === 'entry' ? categoryLabels(row) : participantLabels(row);
        return (matches.length ? matches : [{ label: null }]).map(({ label }) => [row[entity + 'id'], label]);
      })
      .sort();
  return { ...content, oracle };
}

for (const count of [3, 515])
  test(`restricts ordinary and N:N outer joins to the caller's group among ${count} groups`, async (t) => {
    const { oracle, ...fixture } = joinFixture(count);
    const scoped = (groupId) => `<filter type="and">${rootCondition('samplegroupid', 'eq', groupId)}</filter>`;
    const rootAlternatives =
      `<filter type="or">${rootCondition('samplegroupid', 'eq', allowedGroup)}` +
      `${rootCondition('samplegroupid', 'eq', foreignGroup)}</filter>`;
    const rootComparison = (entity) =>
      `<condition attribute="samplegroupid" operator="eq" valueof="${entity}.selectedgroupid"/>`;
    const template = Object.keys(joinShapes)
      .flatMap((entity) =>
        [scoped(allowedGroup), scoped(foreignGroup), rootAlternatives, rootComparison(entity)].map((filter, index) =>
          fetchTag(entity + index, joinedQuery(entity, filter), entity + 'id', 'taglabel'),
        ),
      )
      .join('');
    const portal = await startPortal(t, { template, ...fixture });
    const apiRows = async (entity, filter) => {
      const response = await portal.fetchXml(entity + 's', joinedQuery(entity, filter));
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).value.map((row) => [row[entity + 'id'], row.taglabel ?? null]).sort();
    };
    const response = await portal.get('/');
    assert.equal(response.status, 200, await response.clone().text());
    const html = await response.text();
    for (const entity of Object.keys(joinShapes)) {
      await t.test(entity, async () => {
        const expected = oracle(entity, allowedGroup);
        assert.equal(expected.length, 502);
        assert.deepEqual(extract(html, entity + '0'), expected);
        assert.deepEqual(await apiRows(entity, scoped(allowedGroup)), expected);
        assert.deepEqual(extract(html, entity + '1'), []);
        assert.deepEqual(await apiRows(entity, scoped(foreignGroup)), []);
        assert.deepEqual(extract(html, entity + '2'), expected);
        assert.deepEqual(await apiRows(entity, rootAlternatives), expected);
        assert.deepEqual(extract(html, entity + '3'), expected);
        assert.deepEqual(await apiRows(entity, rootComparison(entity)), expected);
        if (count > 3) {
          const oversized = await portal.fetchXml(entity + 's', joinedQuery(entity));
          assert.equal(oversized.status, 400, await oversized.clone().text());
          const { error } = await oversized.json();
          assert.equal(error.code, '9004010D');
          assert.match(error.innererror.message, /250000 intermediate rows/);
        } else {
          // A caller filter below OR cannot run alone before the outer links.
          const aliasNull = '<condition entityname="vocab" attribute="tagid" operator="null"/>';
          const disjunction = `<filter type="or">${rootCondition('samplegroupid', 'eq', id(102))}${aliasNull}</filter>`;
          const expectedOr = [...oracle(entity, id(102)), ...expected.filter(([, label]) => label == null)].sort();
          assert.deepEqual(await apiRows(entity, disjunction), expectedOr);
        }
      });
    }
  });
