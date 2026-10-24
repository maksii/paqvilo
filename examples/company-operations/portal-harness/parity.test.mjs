import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  queryFingerprint,
  capturedQueries,
  compareLane,
  compareRuns,
  coverageLedger,
  normalizeQuerySentinels,
} from './parity.mjs';
import { replayStore, replayLane } from './replay.mjs';
import { createWebApiFormatter, NAVIGATION } from 'paqvilo/mirage/lib/webapi-format.mjs';

const xml = `<fetch distinct="true"><entity name="widget"><attribute name="widgetid"/><filter type="and"><condition attribute="name" operator="ne" value="CO-OP:11111111-1111-4111-8111-111111111111"/></filter><link-entity name="contact" from="contactid" to="owner" alias="generated_alias_contact_0" link-type="outer"/><filter type="or" hint="union"><condition entityname="generated_alias_contact_0" attribute="contactid" operator="eq" value="22222222-2222-4222-8222-222222222222"/></filter></entity></fetch>`;
const artifact = (query = xml) => {
  const payload = JSON.stringify({
    spanId: 'span',
    artifact: 'QueryIncoming',
    context: { Stage: 10, executionOrder: 1 },
    content: { query: { type: 'FetchExpression', xml: query }, linkCount: 1 },
  });
  return {
    pqvd_spanid: 'span',
    pqvd_artifacttype: 'QueryIncoming',
    pqvd_stage: 10,
    pqvd_executionorder: 1,
    pqvd_partnumber: 1,
    pqvd_partcount: 1,
    pqvd_payloadtext: payload,
    pqvd_payloadhash: createHash('sha256').update(payload).digest('hex'),
  };
};
const lane = () => ({
  engine: 'liquid',
  outcome: 'success',
  complete: true,
  rows: [{ id: 'one' }, { id: 'one' }, { id: 'two' }],
  pages: [
    {
      page: 1,
      fragment: 1,
      httpStatus: 200,
      authoredFetchXml: xml,
      effectiveFetchXml: xml,
      backendEvents: [artifact()],
    },
  ],
});
const run = () => ({
  datasetVersion: 'invented-1',
  manifestHash: 'manifest',
  sourceHash: 'source',
  contactId: '22222222-2222-4222-8222-222222222222',
  roles: ['IT', 'HR'],
  configuration: { permissionSnapshotHash: 'graph', membershipSnapshotHash: 'memberships', dataSnapshotHash: 'data' },
  evidenceQualification: {
    nativeConfigurationVerified: true,
    nativeMembershipsVerified: true,
    nativeDataVerified: true,
    nativeCacheQualified: true,
  },
  pairs: [
    {
      caseId: 'invented-case',
      liquid: lane(),
      webapi: { ...lane(), engine: 'webapi', pages: [{ ...lane().pages[0], effectiveFetchXml: null }] },
    },
  ],
});

test('query fingerprints preserve access predicates, hints, join type and generated alias references', () => {
  const base = queryFingerprint(xml);
  const formatting = queryFingerprint(
    xml
      .replaceAll('generated_alias_contact_0', 'generated_alias_contact_41')
      .replace('distinct="true"', "distinct='true'")
      .replace(/></g, '>\n<'),
  );
  assert.equal(base.structuralHash, formatting.structuralHash);
  assert.notEqual(base.exactHash, formatting.exactHash);
  assert.notEqual(base.sentinelNormalizedByteHash, formatting.sentinelNormalizedByteHash);
  assert.equal(base.linkCount, 1);
  for (const changed of [
    xml.replace('outer', 'inner'),
    xml.replace('hint="union"', ''),
    xml.replace('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'),
    xml.replace('entityname="generated_alias_contact_0"', 'entityname="unbound"'),
  ])
    assert.notEqual(base.structuralHash, queryFingerprint(changed).structuralHash);
  assert.equal(
    base.structuralHash,
    queryFingerprint(
      xml.replace('CO-OP:11111111-1111-4111-8111-111111111111', 'CO-OP:44444444-4444-4444-8444-444444444444'),
    ).structuralHash,
  );
  assert.equal(
    base.sentinelNormalizedByteHash,
    queryFingerprint(
      xml.replace('CO-OP:11111111-1111-4111-8111-111111111111', 'CO-OP:44444444-4444-4444-8444-444444444444'),
    ).sentinelNormalizedByteHash,
  );
  assert.equal(
    normalizeQuerySentinels('<value>prefix CO-OP:11111111-1111-4111-8111-111111111111</value>'),
    '<value>prefix CO-OP:11111111-1111-4111-8111-111111111111</value>',
  );
  const values =
    '<fetch><entity name="widget"><filter><condition attribute="name" operator="in"><value> x </value></condition></filter></entity></fetch>';
  assert.notEqual(
    queryFingerprint(values).structuralHash,
    queryFingerprint(values.replace('> x <', '>x<')).structuralHash,
  );
});

test('recorded backend parts must have valid checksums, order, count and stage binding', () => {
  assert.equal(capturedQueries([artifact()]).queries.length, 1);
  assert.equal(capturedQueries([artifact()], { operationId: 'bound-operation' }).errors[0].kind, 'operation-binding');
  const tampered = artifact();
  tampered.pqvd_payloadtext += ' ';
  assert.equal(capturedQueries([tampered]).errors[0].kind, 'checksum');
  const missing = artifact();
  missing.pqvd_partcount = 2;
  assert.equal(capturedQueries([missing]).errors[0].kind, 'parts');
  const wrongStage = artifact();
  wrongStage.pqvd_stage = 20;
  assert.equal(capturedQueries([wrongStage]).errors[0].kind, 'context-binding');
  const wrongOrder = artifact();
  wrongOrder.pqvd_executionorder = 2;
  assert.equal(capturedQueries([wrongOrder]).errors[0].kind, 'artifact-order-binding');
  const wrongArtifact = artifact();
  wrongArtifact.pqvd_artifacttype = 'Other';
  assert.equal(capturedQueries([wrongArtifact]).errors[0].kind, 'artifact-order-binding');
  const part = artifact(),
    body = part.pqvd_payloadtext,
    mid = Math.floor(body.length / 2);
  const chunks = [body.slice(0, mid), body.slice(mid)].map((text, index) => ({
    ...part,
    pqvd_partnumber: index + 1,
    pqvd_partcount: 2,
    pqvd_payloadtext: text,
  }));
  assert.equal(capturedQueries(chunks.reverse()).queries.length, 1);
  assert.equal(capturedQueries([chunks[0], chunks[0]]).errors[0].kind, 'parts');
  const corrupted = structuredClone(chunks);
  corrupted[0].pqvd_payloadtext += ' ';
  assert.equal(capturedQueries(corrupted).errors[0].kind, 'checksum');
});

test('lane parity preserves duplicate rows and never qualifies missing backend captures', () => {
  const a = lane(),
    b = lane();
  b.rows.reverse();
  assert.equal(compareLane(a, b).verdict, 'equal');
  b.rows.pop();
  assert.equal(compareLane(a, b).verdict, 'different');
  const absent = lane();
  absent.pages[0].backendEvents = [];
  assert.equal(compareLane(a, absent).verdict, 'unqualified');
  const missingRows = lane();
  delete missingRows.rows;
  assert.equal(compareLane(a, missingRows).verdict, 'unqualified');
  const changed = lane();
  changed.pages[0].backendEvents = [artifact(xml.replace('outer', 'inner'))];
  assert.equal(compareLane(a, changed).verdict, 'different');
  const duplicate = lane();
  duplicate.pages.push(structuredClone(duplicate.pages[0]));
  assert.equal(compareLane(a, duplicate).verdict, 'different');
  const denied = { ...lane(), outcome: 'failed', complete: false, rows: [] };
  assert.equal(compareLane(denied, denied).verdict, 'unqualified');
});

test('same-configuration comparison validates all actor, source, dataset and case prerequisites', () => {
  const baseline = run(),
    same = run();
  same.roles.reverse();
  assert.equal(compareRuns(baseline, same).verdict, 'equal');
  for (const field of ['contactId', 'datasetVersion', 'manifestHash', 'sourceHash', 'configuration', 'roles']) {
    const other = run();
    other[field] = field === 'configuration' ? { permissionHash: 'other' } : field === 'roles' ? ['IT'] : 'other';
    assert.equal(compareRuns(baseline, other).verdict, 'unqualified');
    assert.ok(compareRuns(baseline, other).prerequisiteFailures.includes(field));
  }
  const extra = run();
  extra.pairs.push({ ...extra.pairs[0], caseId: 'extra' });
  assert.equal(compareRuns(baseline, extra).verdict, 'unqualified');
  assert.equal(compareRuns({ ...baseline, pairs: [] }, { ...same, pairs: [] }).verdict, 'unqualified');
  const unverified = run();
  delete unverified.evidenceQualification;
  assert.equal(compareRuns(baseline, unverified).verdict, 'unqualified');
  const missingSnapshot = run();
  delete missingSnapshot.configuration.membershipSnapshotHash;
  assert.ok(compareRuns(baseline, missingSnapshot).prerequisiteFailures.includes('membershipSnapshotHash'));
});

test('role ledger reports observed subsets only, with a finite honest denominator', () => {
  const ledger = coverageLedger(
    [run(), { ...run(), roles: ['IT'] }, { ...run(), roles: [] }, { ...run(), roles: ['IT'], contactId: null }],
    ['IT', 'HR'],
  );
  assert.equal(ledger.possibleSubsets, '4');
  assert.equal(ledger.observedSubsets, 3);
  assert.equal(ledger.unobservedSubsets, '1');
  assert.equal(ledger.nativeCoverageComplete, false);
  assert.equal(ledger.excludedRuns, 1);
  assert.throws(() => coverageLedger([], ['IT', 'IT']), /Invalid/);
  assert.equal(
    coverageLedger(
      [run(), { ...run(), roles: ['IT'] }, { ...run(), roles: ['HR'] }, { ...run(), roles: [] }],
      ['IT', 'HR'],
    ).nativeCoverageComplete,
    false,
  );
});

function replayFixture(roles = ['Reader']) {
  const contactId = '22222222-2222-4222-8222-222222222222';
  const otherId = '33333333-3333-4333-8333-333333333333';
  return {
    contactId,
    roles,
    schema: {
      tables: ['account', 'contact', 'widget'].map((name) => ({ name, entitySetName: name + 's', columns: [] })),
      relationships: [
        { name: 'contact_widgets', kind: 'oneToMany', parent: 'contact', child: 'widget', lookup: { name: 'owner' } },
      ],
    },
    catalogue: {
      records: [
        { key: 'actor', id: contactId, table: 'contact', fields: {} },
        { key: 'other', id: otherId, table: 'contact', fields: {} },
        { key: 'own', id: 'owned', table: 'widget', fields: {}, refs: { owner: 'actor' } },
        { key: 'foreign', id: 'foreign', table: 'widget', fields: {}, refs: { owner: 'other' } },
      ],
      associations: [],
    },
    nativeComponents: [
      { powerpagecomponentid: 'reader-role', powerpagecomponenttype: 11, name: 'Reader', statecode: 0, content: '{}' },
      { powerpagecomponentid: 'writer-role', powerpagecomponenttype: 11, name: 'Writer', statecode: 0, content: '{}' },
      {
        powerpagecomponentid: 'observer-role',
        powerpagecomponenttype: 11,
        name: 'Observer',
        statecode: 0,
        content: '{}',
      },
      ...[
        ['reader', true, false],
        ['writer', false, true],
        ['observer', true, false],
      ].map(([name, read, write]) => ({
        powerpagecomponentid: name + '-permission',
        powerpagecomponenttype: 18,
        name,
        statecode: 0,
        content: JSON.stringify({
          entitylogicalname: 'widget',
          scope: 756150001,
          contactrelationship: 'contact_widgets',
          read,
          write,
          adx_entitypermission_webrole: [name + '-role'],
        }),
      })),
    ],
  };
}

test('replay lookup navigation is explicit native metadata while permission schema identity remains unchanged', () => {
  const source = replayFixture(),
    row = {
      SchemaName: 'contact_widgets',
      ReferencingEntity: 'widget',
      ReferencedEntity: 'contact',
      ReferencingAttribute: 'owner',
      ReferencedAttribute: 'contactid',
      ReferencingEntityNavigationPropertyName: 'actualOwnerNavigation',
    };
  const { store, identity } = replayStore({ ...source, nativeRelationships: { widget: [row] } });
  assert.equal(store.state.relationships.contact_widgets.referencingAttribute, 'owner');
  assert.equal(store.resolveMapping('widget').relationships.contact_widgets.many, undefined);
  assert.equal(store.resolveMapping('widget').relationships.actualOwnerNavigation.many, false);
  const record = store.tableRows('widget')[0],
    actual = createWebApiFormatter({ store, identity }).formatEntity(record, store.resolveMapping('widget'));
  assert.equal(actual['_owner_value' + NAVIGATION], 'actualOwnerNavigation');
  const absent = replayStore(source),
    without = createWebApiFormatter(absent).formatEntity(
      absent.store.tableRows('widget')[0],
      absent.store.resolveMapping('widget'),
    );
  assert.equal(
    without['_owner_value' + NAVIGATION],
    undefined,
    'A relationship schema name cannot invent its wire navigation name.',
  );
  assert.throws(() => replayStore({ ...source, nativeRelationships: { widget: [row, row] } }), /ambiguous/);
  const conflict = structuredClone(source);
  conflict.schema.relationships[0].referencingNavigationProperty = 'declaredOther';
  assert.throws(() => replayStore({ ...conflict, nativeRelationships: { widget: [row] } }), /differs/);
});

test('explicit native source replay unions mixed read/write roles while isolating foreign records for all eight subsets', () => {
  const roles = ['Reader', 'Writer', 'Observer'];
  for (let mask = 0; mask < 8; mask++) {
    const selected = roles.filter((role, index) => mask & (1 << index));
    const { store, identity, diagnostics } = replayStore(replayFixture(selected));
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      store.rows('widget', identity).map((row) => row.widgetid),
      selected.some((role) => role !== 'Writer') ? ['owned'] : [],
    );
    const row = store.tableRows('widget').find((row) => row.widgetid === 'owned');
    assert.equal(store.allowed('widget', 'update', row, identity), selected.includes('Writer'));
    assert.equal(
      store.allowed(
        'widget',
        'update',
        store.tableRows('widget').find((row) => row.widgetid === 'foreign'),
        identity,
      ),
      false,
    );
  }
});

test('replay preserves authored error-response intent without generating fake backend captures', () => {
  const environment = replayStore(replayFixture());
  const authored = '<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>';
  const body = `<co-test-response><diagnostics><authored-fetchxml>${authored.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</authored-fetchxml></diagnostics></co-test-response>`;
  const result = replayLane(
    { engine: 'liquid', pages: [{ body, page: 1 }] },
    { table: 'widget', primaryId: 'widgetid', fields: [{ name: 'widgetid', source: 'widgetid', type: 'string' }] },
    environment,
  );
  assert.equal(result.pages[0].authoredFetchXml, authored);
  assert.deepEqual(result.pages[0].backendEvents, []);
  assert.equal(result.queryComparisons[0].verdict, 'unqualified');
  assert.equal(result.rows[0].widgetid, 'owned');
});
