import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { emptyUnmappedLiquidFetchXml, observedLiquidEntityRead } from '../lib/liquid-missing-data.mjs';

const observed = { liquidMissingData: 'empty' };
const xml =
  '<fetch top="1" returntotalrecordcount="true"><entity name="missing_fixture"><attribute name="missing_fixtureid" /></entity></fetch>';
const unknown = () => Object.assign(new Error('Unknown'), { code: 'UnknownEntity', status: 404 });

test('unmapped root preflight is opt-in and precedes unknown-table plan validation only', () => {
  const store = new DataStore({ state: { tables: {}, mappings: {} } });
  const resolveMapping = (name) => store.resolveMapping(name);
  assert.equal(emptyUnmappedLiquidFetchXml(xml, { resolveMapping }), null);
  assert.throws(() => store.fetchXml(xml), /top attribute/);
  assert.deepEqual(emptyUnmappedLiquidFetchXml(xml, { observed, resolveMapping }), {
    entities: [],
    more_records: false,
    entity_name: 'missing_fixture',
    xml,
    permission_granted: false,
    global_permission_granted: false,
    rules_exist: true,
    total_record_count: 0,
  });
});

test('root table lookup follows malformed XML and paging syntax validation', () => {
  const store = new DataStore({ state: { tables: {}, mappings: {} } });
  assert.throws(() => store.fetchXml('<fetch><entity name="missing_fixture"></fetch>'), /Malformed/);
  assert.throws(
    () => store.fetchXml('<fetch count="invalid"><entity name="missing_fixture" /></fetch>'),
    (error) => error.code !== 'UnknownEntity' && /count/.test(error.message),
  );
  assert.throws(
    () => store.fetchXml('<fetch><entity name="missing_fixture" /></fetch>'),
    (error) => error.code === 'UnknownEntity',
  );
});

test('known root invalid queries, missing links, and provider/infrastructure errors remain visible', () => {
  const store = new DataStore({
    state: { tables: { sample: [] }, mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } } },
  });
  const resolveMapping = (name) => store.resolveMapping(name),
    known = xml.replaceAll('missing_fixture', 'sample');
  assert.equal(emptyUnmappedLiquidFetchXml(known, { observed, resolveMapping }), null);
  assert.throws(() => store.fetchXml(known), /top attribute/);
  const linked =
    '<fetch><entity name="sample"><link-entity name="missing_fixture" from="sampleid" to="sampleid" /></entity></fetch>';
  assert.equal(emptyUnmappedLiquidFetchXml(linked, { observed, resolveMapping }), null);
  for (const error of [
    Object.assign(unknown(), { infrastructure: true }),
    Object.assign(new Error('Bridge failed'), { code: 'LIVE_BRIDGE', status: 503 }),
    Object.assign(new Error('Denied'), { code: 'PermissionDenied', status: 403 }),
  ]) {
    assert.throws(
      () =>
        emptyUnmappedLiquidFetchXml(xml, {
          observed,
          resolveMapping() {
            throw error;
          },
        }),
      (thrown) => thrown === error,
    );
  }
});

test('malformed XML cannot be made empty by an unmapped root observation', () => {
  assert.throws(
    () =>
      emptyUnmappedLiquidFetchXml('<fetch><entity name="missing_fixture"></fetch>', {
        observed,
        resolveMapping() {
          throw unknown();
        },
      }),
    /Malformed/,
  );
  let called = false;
  assert.equal(
    emptyUnmappedLiquidFetchXml('<fetch><entity name="one"/><entity name="two"/></fetch>', {
      observed,
      resolveMapping() {
        called = true;
      },
    }),
    null,
  );
  assert.equal(called, false);
});

test('entity lookup converts only the observed UnknownEntity failure to nil', async () => {
  const cause = unknown(),
    read = async () => {
      throw cause;
    };
  await assert.rejects(observedLiquidEntityRead(read), (error) => error === cause);
  assert.equal(await observedLiquidEntityRead(read, observed), null);
  const record = { id: 'synthetic' };
  assert.equal(await observedLiquidEntityRead(async () => record, observed), record);
  for (const error of [
    Object.assign(unknown(), { infrastructure: true }),
    Object.assign(new Error('Denied'), { code: 'PermissionDenied', status: 403 }),
  ])
    await assert.rejects(
      observedLiquidEntityRead(async () => {
        throw error;
      }, observed),
      (thrown) => thrown === error,
    );
});
