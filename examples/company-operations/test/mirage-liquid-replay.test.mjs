import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from 'paqvilo/mirage/lib/data.mjs';
import { createLiquidReplayClient, parseLiquidReplayResponse } from '../portal-harness/mirage-liquid-replay.mjs';
import { validateNativeWireWitness, replayNativeReadBatch } from '../plugins/mirage-runtime.mjs';

const id = '10000000-0000-0000-0000-000000000001';
const source = `{% capture authored %}<fetch returntotalrecordcount="true"><entity name="widget"><attribute name="widgetid"/><attribute name="kind"/><attribute name="note"/></entity></fetch>{% endcapture %}{% fetchxml q %}{{ authored }}{% endfetchxml %}<co-test-response operation-id="{{ operation.id }}" contact-id="{{ user.id }}" case-id="R01" dataset-version="{{ dataset_version }}" outcome="success"><roles>{% for role in user.roles %}<role>{{ role | xml_escape }}</role>{% endfor %}</roles><records>{% for r in q.results.entities %}<record><field name="widgetid" null="false">{{ r.widgetid.id | default: r.widgetid | xml_escape }}</field><field name="kind" null="false">{{ r.kind.value | xml_escape }}</field><field name="note" null="{% if r.note == nil %}true{% else %}false{% endif %}">{{ r.note | xml_escape }}</field></record>{% endfor %}</records><paging more="{{ q.results.more_records }}"/><diagnostics><authored-fetchxml>{{ authored | xml_escape }}</authored-fetchxml><effective-fetchxml>{{ q.xml | xml_escape }}</effective-fetchxml></diagnostics></co-test-response>`;

test('frozen Liquid replay executes the real renderer and records selected drop values, nulls and query diagnostics', async () => {
  const store = new DataStore({
    state: {
      mappings: {
        widget: {
          entitySet: 'widgets',
          idColumn: 'widgetid',
          fields: { kind: { type: 'choice', options: { 7: 'Seven' } } },
        },
      },
      tables: { widget: [{ widgetid: id, kind: 7, note: null }] },
      permissions: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const client = createLiquidReplayClient({
    store,
    identity: { admin: true, contactId: id },
    portal: { settings: {} },
    templates: [{ name: 'CO Query R01', source }],
    datasetVersion: 'fixture',
  });
  const response = await client.request({ caseId: 'R01', variant: 'fetchxml', operation: { id } });
  assert.deepEqual(response.page.rows, [{ widgetid: id, kind: '7', note: null }]);
  assert.equal(response.responseBindingVerified, true);
  assert.equal(response.page.operationId, id);
  assert.equal(response.page.more, false);
  assert.equal(response.page.authoredFetchXml, response.page.effectiveFetchXml);
  await assert.rejects(() => client.request({ caseId: 'R02', variant: 'fetchxml', operation: { id } }), /exact frozen/);
  await assert.rejects(() => client.request({ caseId: 'R01', variant: 'odata', operation: { id } }), /no qualified/);
  const denied = createLiquidReplayClient({
    store,
    identity: { contactId: id },
    portal: { settings: {} },
    templates: [{ name: 'CO Query R01', source }],
    datasetVersion: 'fixture',
  });
  assert.deepEqual((await denied.request({ caseId: 'R01', variant: 'fetchxml', operation: { id } })).page.rows, []);
});

test('Liquid response parsing preserves empty string versus null, escapes, and rejects duplicate selected fields', () => {
  const response = parseLiquidReplayResponse(
    '<co-test-response operation-id="x" outcome="success"><records><record><field name="empty" null="false"></field><field name="missing" null="true"></field><field name="text" null="false">A&amp;B</field></record></records><paging more=""/><diagnostics/></co-test-response>',
  );
  assert.deepEqual(response.rows, [{ empty: '', missing: null, text: 'A&B' }]);
  assert.equal(response.more, null);
  assert.throws(
    () =>
      parseLiquidReplayResponse(
        '<co-test-response><records><record><field name="x" null="false"/><field name="x" null="true"/></record></records></co-test-response>',
      ),
    /invalid field/,
  );
  assert.throws(
    () => parseLiquidReplayResponse('<!DOCTYPE root SYSTEM "https://example.invalid"><co-test-response/>'),
    /external/,
  );
});

test('actual wire-source witness binds consumed template bytes, settings, and the complete before/after site source freeze', () => {
  const component = (id, type, name, content) => ({
    powerpagecomponentid: id,
    powerpagecomponenttype: type,
    statecode: 0,
    name,
    content: JSON.stringify(content),
  });
  const before = [
    component('template', 8, 'CO Query R01', { source }),
    component('dispatcher', 8, 'CO Permission Lab Liquid Dispatcher', {
      source: "{% assign dataset_version = 'fixture' %}",
    }),
    component('setting', 9, 'Webapi/widget/enabled', { value: 'true' }),
    component('page', 2, 'Unrendered page', { copy: 'frozen' }),
  ];
  const options = {
    webApiPortal: { settings: { 'Webapi/widget/enabled': 'true' } },
    liquidReplay: {
      templates: [{ name: 'CO Query R01', source }],
      datasetVersion: 'fixture',
      portal: { settings: {} },
    },
  };
  const after = structuredClone(before);
  after.reverse();
  after[0]['@odata.etag'] = 'changed discovery version';
  const proof = validateNativeWireWitness({ before, after }, options);
  assert.equal(proof.verified, true);
  assert.equal(proof.consumed.length, 3);
  after[0].content = JSON.stringify({ copy: 'changed' });
  assert.deepEqual(validateNativeWireWitness({ before, after }, options).reasons, ['siteSourceChanged']);
  assert.ok(
    validateNativeWireWitness(
      { before, after: before },
      {
        ...options,
        liquidReplay: { ...options.liquidReplay, templates: [{ name: 'CO Query R01', source: source + 'changed' }] },
      },
    ).reasons.includes('queryTemplateSource'),
  );
  assert.ok(
    validateNativeWireWitness(
      { before, after: before },
      { ...options, webApiPortal: { settings: { 'Webapi/widget/enabled': 'false' } } },
    ).reasons.includes('webApiSetting'),
  );
  assert.equal(validateNativeWireWitness(undefined, options).verified, false);
});

test('a query that executed with no recorder artifacts cannot qualify as a prebackend denial', async () => {
  const xml = `<fetch returntotalrecordcount="true"><entity name="widget"><attribute name="widgetid"/><filter><condition attribute="name" operator="ne" value="CO-UTC:2026-10-13T00:00:00.000Z"/><condition attribute="name" operator="ne" value="CO-OP:${id}"/></filter></entity></fetch>`;
  const store = new DataStore({
    state: {
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        pqvd_testoperation: { idColumn: 'pqvd_testoperationid' },
        pqvd_pluginevent: { idColumn: 'pqvd_plugineventid' },
      },
      tables: { widget: [], pqvd_testoperation: [], pqvd_pluginevent: [] },
      permissions: [],
      settings: { permissionMode: 'permissive' },
    },
  });
  store.setPluginPipeline(
    () => {},
    () => false,
  );
  const frozenSource = source.replace(/<fetch returntotalrecordcount="true">[\s\S]*?<\/fetch>/, xml);
  const capture = {
    runId: id,
    backendEvents: [],
    results: [],
    requests: [{ caseId: 'R01', variant: 'fetchxml', lane: 'liquid', operationId: id, authoredFetchXml: xml }],
    liquidPages: [
      { operationId: id, outcome: 'success', rows: [], more: false, authoredFetchXml: xml, effectiveFetchXml: xml },
    ],
  };
  const pipeline = store.pluginPipeline,
    core = store.fetchXmlCore;
  const proof = await replayNativeReadBatch({
    binding: { receipt: {} },
    store,
    identity: { admin: true, contactId: id },
    capture,
    liquidReplay: {
      portal: { settings: {} },
      templates: [{ name: 'CO Query R01', source: frozenSource }],
      datasetVersion: 'fixture',
    },
  });
  assert.equal(proof.pages[0].liquidExact, true);
  assert.equal(proof.pages[0].localBackendExecutions, 1);
  assert.equal(proof.pages[0].backendAbsenceExact, false);
  assert.equal(proof.pages[0].qualified, false);
  assert.equal(proof.allQualified, false);
  assert.equal(store.pluginPipeline, pipeline);
  assert.equal(store.fetchXmlCore, core);
  const diagnostic = await replayNativeReadBatch({
    binding: { receipt: {} },
    store,
    identity: { admin: true, contactId: id },
    capture,
  });
  assert.equal(diagnostic.pages[0].wireQualified, false);
  assert.equal(diagnostic.pages[0].qualified, false);
});
