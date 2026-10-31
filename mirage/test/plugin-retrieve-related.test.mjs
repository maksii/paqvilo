// @test-kind parity: native and native-r2 relationsReads (GET with $expand of a one-to-many navigation: Retrieve 10/20/40 RelatedEntitiesQuery '<schema>.Referenced' FetchExpression of the nested $select, Retrieve/40 BusinessEntity.RelatedEntities collection with its paging cookie)
// The plug-in view of a Web API Retrieve that expands a collection navigation. Invented tables and ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';
import { objectTypeCode } from '../lib/dataverse-metadata.mjs';

const parent = '20000000-0000-0000-0000-0000000000e1',
  first = '20000000-0000-0000-0000-0000000000e2',
  second = '20000000-0000-0000-0000-0000000000e3',
  user = '10000000-0000-0000-0000-000000000001';
const step = (n, stage) => ({
  id: `30000000-0000-0000-0000-0000000000${n}`,
  enabled: true,
  entity: 'x_folder',
  message: 'Retrieve',
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.RetrieveRecorder',
  assemblyId: 'invented',
});

// The one-to-many relationship between folders and their pages, as each side declares it.
const relationship = (entity, many) => ({
  schemaName: 'x_folder_pages',
  entity,
  from: 'x_folderid',
  to: 'x_folderid',
  many,
  partner: many ? 'x_folderid' : 'x_folder_pages',
});

async function fixture(t) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_folder: {
        logicalName: 'x_folder',
        entitySet: 'x_folders',
        idColumn: 'x_folderid',
        relationships: { x_folder_pages: relationship('x_page', true) },
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
      x_page: {
        logicalName: 'x_page',
        entitySet: 'x_pages',
        idColumn: 'x_pageid',
        relationships: { x_folderid: relationship('x_folder', false) },
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_rank: { dataverseType: 'int' },
          x_folderid: { dataverseType: 'lookup', targets: ['x_folder'] },
        },
      },
    },
    tables: {
      x_folder: [{ x_folderid: parent, x_name: 'Parent' }],
      x_page: [
        { x_pageid: first, x_name: 'First child', x_folderid: { id: parent, logical_name: 'x_folder' } },
        { x_pageid: second, x_name: 'Second child', x_folderid: { id: parent, logical_name: 'x_folder' } },
      ],
    },
    extension: { name: 'retrieve-related-probe', install: () => {} },
  });
  const steps = [step(10, 10), step(20, 20), step(40, 40)];
  const handlers = new Map([[steps[0].typeName, () => {}]]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  // The Retrieve pipeline's holder at each stage (a JavaScript handler sees decoded values only).
  const seen = [],
    pipeline = f.store.pluginPipeline;
  f.store.pluginPipeline = (context) => {
    if (context.operation === 'retrieve' && context.holder)
      seen.push({ stage: context.stage, holder: structuredClone(context.holder) });
    return pipeline(context);
  };
  return { ...f, seen };
}

const fetchText =
  '<fetch distinct="false" useraworderby="false" no-lock="false" mapping="logical" page="1" count="5000">' +
  '<entity name="x_page"><attribute name="x_name" /></entity></fetch>';

test('a Web API Retrieve with $expand hands its steps the RelatedEntitiesQuery and the related collection', async (t) => {
  const f = await fixture(t);
  const read = await f.request('GET', `/x_folders(${parent})?$select=x_name&$expand=x_folder_pages($select=x_name)`);
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual(
    f.seen.map((entry) => entry.stage),
    [10, 20, 40],
  );
  for (const entry of f.seen)
    assert.deepEqual(entry.holder.relatedEntitiesQuery, {
      $type: 'RelationshipQueryCollection',
      values: [
        {
          relationship: { $type: 'Relationship', schemaName: 'x_folder_pages', primaryEntityRole: 'Referenced' },
          query: { $type: 'FetchExpression', query: fetchText },
        },
      ],
    });
  const related = f.seen.at(-1).holder.entity.relatedEntities;
  assert.equal(related.length, 1);
  assert.deepEqual(related[0].relationship, {
    $type: 'Relationship',
    schemaName: 'x_folder_pages',
    primaryEntityRole: 'Referenced',
  });
  const collection = related[0].entities;
  assert.equal(collection.entityName, 'x_page');
  assert.equal(collection.moreRecords, false);
  assert.deepEqual(
    collection.entities.map((entity) => [entity.id, Object.keys(entity.attributes).sort()]),
    [
      [first, ['x_name', 'x_pageid']],
      [second, ['x_name', 'x_pageid']],
    ],
  );
  assert.equal(
    collection.pagingCookie,
    `<cookie page="1" parentEntityId="${parent}" parentAttributeName="x_folderid" parentEntityObjectTypeCode="${objectTypeCode('x_folder')}">` +
      `<x_pageid last="{${second.toUpperCase()}}" first="{${first.toUpperCase()}}" /></cookie>`,
  );
  // The HTTP answer is unchanged by the plug-in view.
  assert.deepEqual(
    (await read.json()).x_folder_pages.map((child) => child.x_name),
    ['First child', 'Second child'],
  );
});

test('the CLR Retrieve context carries the frame RelatedEntitiesQuery, else an empty one', async (t) => {
  const { store } = await contractModuleFixture(t, {
    mappings: { x_folder: { logicalName: 'x_folder', entitySet: 'x_folders', idColumn: 'x_folderid', fields: {} } },
    tables: { x_folder: [{ x_folderid: parent }] },
    extension: { name: 'retrieve-related-clr', install: () => {} },
  });
  const runtime = {
    descriptor: {
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      serviceProfile: { userId: user, evidence: 'Invented related query', grants: [] },
    },
  };
  const query = {
    $type: 'RelationshipQueryCollection',
    values: [
      {
        relationship: { $type: 'Relationship', schemaName: 'x_folder_pages', primaryEntityRole: 'Referenced' },
        query: { $type: 'FetchExpression', query: fetchText },
      },
    ],
  };
  const inputs = (frame) =>
    clrContext({
      runtime,
      store,
      step: { id: '30000000-0000-0000-0000-000000000099', images: [], contract: { mode: 0 } },
      entity: 'x_folder',
      operation: 'retrieve',
      stage: 20,
      target: {},
      record: { x_folderid: parent },
      previous: null,
      frame,
      depth: 1,
    }).inputParameters.values.RelatedEntitiesQuery;
  assert.deepEqual(inputs({ columns: { allColumns: true, columns: [] }, relatedEntitiesQuery: query }), query);
  assert.deepEqual(inputs({ columns: { allColumns: true, columns: [] } }), {
    $type: 'RelationshipQueryCollection',
    values: [],
  });
});
