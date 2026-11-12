// @test-kind contract: reference enrichment writes Paqvilo's own state format, one normalised row per live record
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { normalizeLiveRecord } from '../lib/live.mjs';
import { enrichReference } from '../enrich-reference.mjs';

const query = '<fetch><entity name="item"><attribute name="name"/></entity></fetch>';
const options = async () => ({
  store: await new DataStore({
    state: {
      mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
      tables: { item: [{ itemid: 'old', name: 'Local' }] },
    },
  }).init(),
  origin: 'https://reference.example',
  plan: [{ entity: 'item', fetchXml: query, pageSize: 1 }],
});

test('enrichment imports complete bounded pages, merges records and records provenance without cookies', async () => {
  const input = await options(),
    queries = [];
  const report = await enrichReference({
    ...input,
    bridge: {
      fetchXml: async (xml) => {
        queries.push(xml);
        return xml.includes('page="1"')
          ? {
              entities: [{ itemid: 'one', name: 'Reference' }],
              more_records: true,
              paging_cookie: '<cookie page="1"/>',
            }
          : { entities: [{ itemid: 'two', name: 'Other' }], more_records: false };
      },
    },
  });
  assert.equal(report.applied, true);
  assert.equal(input.store.snapshot().tables.item.length, 3);
  assert.match(queries[0], /attribute name="itemid"/);
  assert.match(queries[1], /paging-cookie="&lt;cookie/);
  assert.equal(JSON.stringify(report).includes('cookie'), false);
});

test('enrichment saves normalised rows only: no annotation keys and no raw lookup column', async () => {
  const input = await options();
  const mapping = input.store.resolveMapping('item');
  const annotated = {
    '@odata.etag': 'W/"1"',
    itemid: 'annotated',
    name: 'Reference',
    _ownerid_value: 'owner-id',
    '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Owner label',
    '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser',
  };
  await enrichReference({
    ...input,
    bridge: {
      fetchXml: async () => ({ entities: [normalizeLiveRecord(annotated, mapping)], more_records: false }),
    },
  });
  const row = input.store.snapshot().tables.item.find((item) => item.itemid === 'annotated');
  assert.deepEqual(
    Object.keys(row).filter((key) => key.includes('@') || key.startsWith('_')),
    [],
  );
  assert.equal(row.ownerid.id, 'owner-id');
});

test('incomplete/reference errors leave state intact; concurrent changes prevent overwriting local edits', async () => {
  const input = await options(),
    before = input.store.snapshot();
  await assert.rejects(
    enrichReference({
      ...input,
      bridge: { fetchXml: async () => ({ entities: [{ itemid: 'one' }], more_records: true }) },
    }),
    /cookie/,
  );
  assert.deepEqual(input.store.snapshot(), before);
  await assert.rejects(
    enrichReference({
      ...input,
      bridge: {
        fetchXml: async () => {
          await input.store.replaceState({ ...before, tables: { item: [{ itemid: 'new' }] } });
          return { entities: [], more_records: false };
        },
      },
    }),
    /changed/,
  );
  assert.equal(input.store.snapshot().tables.item[0].itemid, 'new');
  await assert.rejects(enrichReference({ ...input, plan: [{ entity: 'item', fetchXml: query, mode: 'bad' }] }), /mode/);
});
