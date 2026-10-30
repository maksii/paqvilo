// @test-kind parity: native dev-environment plug-in recorder corpus 2026-10-30, replayed by the local recorder harness: reads (a Web API collection GET hands RetrieveMultiple a paged FetchExpression of the client's selection and a first/last paging cookie), crud and upsert (the platform's existence read: no IncludeAnnotations, empty paging cookie)
// @parity-evidence: native recorder captures 2026-10-30 readAsync (native and native-r2); the fixture lines changed only to register the asynchronous Retrieve step of the new test
// Read message inputs and outputs as RetrieveMultiple steps see them. Invented table and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';

const id = '20000000-0000-0000-0000-0000000000d1';
const other = '20000000-0000-0000-0000-0000000000d2';
const step = (n, stage, message = 'RetrieveMultiple', mode = 0) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Reader',
  assemblyId: 'invented',
});

async function fixture(t, edit = () => {}, steps = [step(1, 20), step(2, 40)]) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_rank: { dataverseType: 'int' } },
      },
    },
    tables: {
      x_item: [
        { x_itemid: id, x_name: 'First', x_rank: 1 },
        { x_itemid: other, x_name: 'Second', x_rank: 2 },
      ],
    },
    extension: { name: 'read-input-probe', install: () => {} },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Reader',
      ({ context }) => {
        seen.push({
          stage: context.Stage,
          at: `${context.MessageName}/${context.Stage}/${context.Mode}`,
          target: context.InputParameters.Target ?? null,
          query: structuredClone(context.InputParameters.Query),
        });
        edit(context);
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  // The PostOperation collection as the pipeline hands it to steps (a handler sees only its entities).
  const cookies = [],
    pipeline = f.store.pluginPipeline;
  f.store.pluginPipeline = (context) => {
    if (context.stage === 40 && context.collection) cookies.push(context.collection.pagingCookie);
    return pipeline(context);
  };
  return { ...f, seen, cookies, backend };
}

test('a Web API collection GET hands its steps the selection as a paged FetchExpression with a paging cookie', async (t) => {
  const f = await fixture(t);
  const read = await f.request('GET', `/x_items?$select=x_name&$filter=x_itemid eq ${id}`);
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual(
    (await read.json()).value.map((row) => row.x_name),
    ['First'],
  );
  const braced = `{${id.toUpperCase()}}`;
  for (const entry of f.seen)
    assert.deepEqual(entry.query, {
      $type: 'FetchExpression',
      query:
        '<fetch distinct="false" useraworderby="true" no-lock="false" mapping="logical" page="1" count="5000">' +
        '<entity name="x_item"><attribute name="x_name" /><filter type="and">' +
        `<condition attribute="x_itemid" operator="eq" value="${braced}" /></filter></entity></fetch>`,
    });
  assert.deepEqual(f.cookies, [`<cookie page="1"><x_itemid last="${braced}" first="${braced}" /></cookie>`]);
});

// @test-kind unproven: a PreOperation step's FetchXML edit narrows the Web API answer; no native capture of an edited query
test('a PreOperation edit of the FetchExpression narrows what the Web API answers', async (t) => {
  const f = await fixture(t, (context) => {
    if (context.Stage === 20)
      context.InputParameters.Query = {
        ...context.InputParameters.Query,
        query: context.InputParameters.Query.query.replace(
          '</entity>',
          '<filter type="and"><condition attribute="x_rank" operator="eq" value="2" /></filter></entity>',
        ),
      };
  });
  const read = await f.request('GET', '/x_items?$select=x_name');
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual(
    (await read.json()).value.map((row) => row.x_name),
    ['Second'],
  );
});

test("the platform's existence read has an empty paging cookie", async (t) => {
  const f = await fixture(t);
  const upserted = await f.request('PATCH', `/x_items(${id})`, { x_name: 'Renamed' });
  assert(upserted.status < 300, await upserted.text());
  const end = f.seen.find((entry) => entry.stage === 40);
  assert.equal(end.query.$type, 'QueryExpression');
  assert.deepEqual(f.cookies, ['']);
});

test("the platform's own read carries the app-module inputs and no IncludeAnnotations", async (t) => {
  const f = await fixture(t);
  const caller = '10000000-0000-0000-0000-0000000000d9';
  const runtime = {
    descriptor: {
      context: { executionUserId: caller, initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
      serviceProfile: { userId: caller, evidence: 'Invented internal read', grants: [] },
    },
  };
  const inputsOf = (initialFrame) => {
    const record = { x_itemid: '00000000-0000-0000-0000-000000000000' };
    const frame = runPluginPhase({
      items: [],
      handlers: new Map(),
      store: f.store,
      entity: 'x_item',
      operation: 'retrievemultiple',
      stage: 10,
      query: { $type: 'FetchExpression', query: '<fetch><entity name="x_item" /></fetch>' },
      record,
      identity: {},
      ...(initialFrame ? { initialFrame } : {}),
    });
    const step = { id: '30000000-0000-0000-0000-0000000000d9', name: 'Invented read', images: [], contract: {} };
    const answer = clrContext({
      runtime,
      store: f.store,
      step,
      entity: 'x_item',
      operation: 'retrievemultiple',
      stage: 10,
      record,
      frame,
      depth: 1,
    });
    return Object.keys(answer.inputParameters.values).sort();
  };
  assert.deepEqual(inputsOf({ internalRead: true }), ['AppModuleId', 'IsAppModuleContext', 'Query']);
  assert.deepEqual(inputsOf(), ['AppModuleId', 'IncludeAnnotations', 'IsAppModuleContext', 'Query']);
});

// @test-kind parity: native recorder captures 2026-10-30 readAsync (native and native-r2): an asynchronous Retrieve step runs once per GET of a kept row, after the read
test('an asynchronous Retrieve step runs once after a single-row GET', async (t) => {
  const f = await fixture(t, () => {}, [step(3, 40, 'Retrieve', 1)]);
  const read = await f.request('GET', `/x_items(${id})?$select=x_name`);
  assert.equal(read.status, 200, await read.text());
  await f.backend.settle();
  assert.deepEqual(
    f.seen.map((entry) => entry.at),
    ['Retrieve/40/1'],
  );
  assert.equal(String(f.seen[0].target?.id ?? f.seen[0].target).toLowerCase(), id);
});
