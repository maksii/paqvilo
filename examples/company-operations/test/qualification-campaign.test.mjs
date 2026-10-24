import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  configurationCampaignDomain,
  compareConfigurationCell,
  runNativeConfigurationCampaign,
  recoverNativeConfigurationCampaign,
  validateLiquidNoReadReceipt,
} from '../portal-security/qualification-campaign.mjs';
import {
  scopeHierarchyVariantCases,
  materializeScopeHierarchyVariant,
} from '../portal-security/qualification-domain.mjs';
import { buildBlueprint } from '../portal-security/blueprint.mjs';
import { stable } from '../portal-harness/core.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const id = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const witnesses = Object.fromEntries(
  ['nativeConfiguration', 'nativeMemberships', 'nativeFixtures', 'nativeSettings', 'nativeTemplates'].map(
    (name, index) => [name, String(index).repeat(64)],
  ),
);
const configuration = { inputHash: 'a'.repeat(64), nativeWitnesses: witnesses, roles: [], query: { table: 'asset' } };
const cell = { id: 'invented:read:liquid', operation: 'read', lane: 'liquid' };
function envelopes() {
  const context = {
    Stage: 10,
    executionOrder: 100,
    Depth: 1,
    PrimaryEntityName: 'asset',
    extensions: { context2: { observed: true, values: { IsPortalsClientCall: true, PortalsContactId: id(1) } } },
  };
  const payload = JSON.stringify({
    operationId: id(6),
    artifact: 'incoming',
    context,
    content: { query: { xml: '<fetch><entity name="asset"><attribute name="assetid" /></entity></fetch>' } },
  });
  const native = {
    cellId: cell.id,
    inputHash: configuration.inputHash,
    controllerContactId: id(1),
    membershipRoleIds: [id(2)],
    nativeWitnesses: witnesses,
    cacheActions: ['clearConfig', 'clearCache'].map((name) => ({ name, status: 'completed' })),
    snapshotReceipt: {
      sourceStable: true,
      registrationStable: true,
      settingsStable: true,
      membershipsStable: true,
      allRegionsVerified: true,
      dataStable: true,
      onlyDeclaredTargetChanges: true,
    },
    history: { operationId: id(6), summarySha256: 'c'.repeat(64) },
    completePages: true,
    pages: [
      {
        page: 1,
        fragment: 1,
        rows: [{ assetid: id(3) }],
        wire: { status: 200, mime: 'application/json', body: '{"value":[]}' },
        effectiveXml: '<fetch><entity name="asset" /></fetch>',
      },
    ],
    backendEvents: [
      {
        pqvd_eventkey: 'event',
        pqvd_partnumber: 1,
        pqvd_partcount: 1,
        pqvd_payloadhash: sha(payload),
        pqvd_payloadtext: payload,
      },
    ],
  };
  return { native, local: structuredClone(native) };
}
const compare = (native, local, currentCell = cell) =>
  compareConfigurationCell(configuration, currentCell, native, local, {
    desiredRoleIds: [id(2)],
    actorContactId: id(1),
  });

test('source-bound cell comparison checks exact HTTP/backend/context equality and detects source, actor or artifact drift', () => {
  const { native, local } = envelopes();
  assert.equal(compare(native, local).verdict, 'equal');
  const changed = structuredClone(local);
  changed.pages[0].wire.body = '{"value":[1]}';
  assert.equal(compare(native, changed).verdict, 'different');
  const missing = structuredClone(native);
  delete missing.nativeWitnesses.nativeConfiguration;
  assert.equal(compare(missing, local).verdict, 'unqualified');
  const foreign = structuredClone(native);
  foreign.membershipRoleIds = [id(9)];
  assert.ok(compare(foreign, local).gaps.includes('role-subset-binding'));
  const corrupt = structuredClone(native);
  corrupt.backendEvents[0].pqvd_payloadtext += ' ';
  assert.ok(compare(corrupt, local).gaps.includes('plugin-parts-integrity'));
});

test('missing backend events, SDK CRUD and unverified cleanup never earn native permission coverage', () => {
  const { native, local } = envelopes();
  const empty = structuredClone(native);
  empty.backendEvents = [];
  assert.equal(compare(empty, { ...local, backendEvents: [] }).verdict, 'unqualified');
  const mutation = { ...cell, operation: 'write', lane: 'webapi' };
  assert.ok(compare(native, local, mutation).gaps.includes('mutation-cleanup-readback'));
  native.cleanupReceipt = { verified: true, snapshotSha256: 'd'.repeat(64) };
  native.sdkFixtureExecution = true;
  assert.ok(compare(native, local, mutation).gaps.includes('sdk-not-portal-crud'));
  const denied = structuredClone(empty);
  denied.identityReceipt = { serverVerified: true, contactId: id(1) };
  denied.pages[0].wire = { status: 403, body: '{"error":{"code":"90040120"}}' };
  assert.equal(compare(denied, structuredClone(denied)).verdict, 'equal');
  denied.pages[0].wire.body = '{"error":{"code":"90040107"}}';
  assert.equal(compare(denied, structuredClone(denied)).verdict, 'unqualified');
});

test('Liquid empty/no-SDK needs independently recomputed empty roots, real fixture, native flags and same-root positive controls', () => {
  const { native } = envelopes();
  native.backendEvents = [];
  native.pages[0].rows = [];
  native.identityReceipt = { serverVerified: true, contactId: id(1) };
  const raw = [
    { powerpagecomponentid: id(2), powerpagecomponenttype: 11, statecode: 0, content: '{}' },
    {
      powerpagecomponentid: id(9),
      powerpagecomponenttype: 18,
      statecode: 0,
      content: JSON.stringify({ entitylogicalname: 'asset', read: false, adx_entitypermission_webrole: [id(2)] }),
    },
  ];
  const fixture = { assetid: id(3) },
    rawHash = sha(stable(raw));
  const current = { ...configuration, sourceHashes: { schema: 'e'.repeat(64) } };
  native.noReadReceipt = {
    table: 'asset',
    components: raw,
    rawConfigSha256: rawHash,
    afterRawConfigSha256: rawHash,
    schemaSha256: current.sourceHashes.schema,
    membershipSnapshotSha256: 'b'.repeat(64),
    afterMembershipSnapshotSha256: 'b'.repeat(64),
    actorRoleIds: [id(2)],
    portalContactId: id(1),
    rootCandidateIds: [],
    nativeFlags: Object.fromEntries(
      ['before', 'after'].map((side) => [
        side,
        { permission_granted: false, global_permission_granted: false, rules_exist: true },
      ]),
    ),
    ownedFixture: {
      primaryId: 'assetid',
      nativeRow: fixture,
      localRow: fixture,
      nativeRowSha256: sha(stable(fixture)),
      localRowSha256: sha(stable(fixture)),
    },
    positiveControl: {
      table: 'asset',
      fullActiveRetrieveMultipleObserverProfile: true,
      artifactSha256: 'a'.repeat(64),
      observerProfileSha256: 'f'.repeat(64),
      observedStages: [10, 20, 40],
    },
  };
  const local = structuredClone(native);
  assert.equal(validateLiquidNoReadReceipt(current, native, local).verified, true);
  assert.equal(
    compareConfigurationCell(current, cell, native, local, { desiredRoleIds: [id(2)], actorContactId: id(1) }).verdict,
    'equal',
  );
  native.noReadReceipt.nativeFlags.after.rules_exist = false;
  assert.equal(validateLiquidNoReadReceipt(current, native, local).verified, false);
  native.noReadReceipt.nativeFlags.after.rules_exist = true;
  native.noReadReceipt.components[1].content = JSON.stringify({
    entitylogicalname: 'asset',
    read: true,
    adx_entitypermission_webrole: [id(2)],
  });
  native.noReadReceipt.rawConfigSha256 = native.noReadReceipt.afterRawConfigSha256 = sha(
    stable(native.noReadReceipt.components),
  );
  assert.ok(validateLiquidNoReadReceipt(current, native, local).gaps.includes('no-read-root-candidates-not-empty'));
  native.noReadReceipt.components[1].content = JSON.stringify({
    entitylogicalname: 'asset',
    read: true,
    adx_entitypermission_webrole: [],
    parententitypermission: id(8),
  });
  native.noReadReceipt.rawConfigSha256 = native.noReadReceipt.afterRawConfigSha256 = sha(
    stable(native.noReadReceipt.components),
  );
  assert.ok(validateLiquidNoReadReceipt(current, native, local).gaps.includes('no-read-unresolved-parent-hypothesis'));
});

test('all 2251 concrete configurations materialize native components and a bounded query contract within an explicit 181798-cell denominator', async () => {
  const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
  const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
  // Materializing every variant is the slow part, so the per-configuration
  // checks of the grammar and the extra cohorts share this one domain build.
  const domain = configurationCampaignDomain({ schema, catalogue });
  assert.equal(domain.configurationsRequired, 2251);
  assert.equal(domain.denominator, 181798);
  assert.equal(domain.originalGrammarConfigurations, 2117);
  assert.equal(domain.rolelessAncestorConfigurations, 6);
  assert.equal(domain.equipmentLifecycleConfigurations, 128);
  assert.equal(domain.nativeQualifiedCells, 0);
  assert.equal(domain.universalPermissionParity, false);
  const grammar = domain.configurations.slice(0, domain.originalGrammarConfigurations);
  assert.deepEqual(
    grammar.map((configuration) => configuration.variantId),
    [...scopeHierarchyVariantCases()].map((variant) => variant.id),
  );
  assert.equal(
    grammar.reduce((count, configuration) => count + configuration.configurationCells.length, 0),
    177242,
  );
  const allComponentIds = grammar.flatMap((configuration) => configuration.components.map((component) => component.id));
  assert.equal(new Set(allComponentIds).size, allComponentIds.length);
  for (const configuration of domain.configurations) {
    assert.equal(configuration.nativeExecution, false);
    assert.equal(configuration.nativeQualifiedCells, 0);
    assert.equal(configuration.configurationCells.length, configuration.nativeCellsPerRepeat);
    assert.ok(configuration.query.id.length <= 64, 'Operation case IDs fit Dataverse Text(64).');
    const ids = new Set(configuration.components.map((component) => component.id));
    for (const component of configuration.components.filter((component) => component.type === 18)) {
      assert.ok(schema.tables.some((table) => table.name === component.content.entitylogicalname));
      assert.ok(component.content.scope >= 756150000 && component.content.scope <= 756150004);
      assert.ok(component.content.adx_entitypermission_webrole.every((id) => ids.has(id)));
      if (component.content.parententitypermission) assert.ok(ids.has(component.content.parententitypermission));
      if (component.content.scope === 756150002) assert.ok(component.content.accountrelationship);
      if (component.content.scope === 756150004) assert.equal(component.content.entitylogicalname, 'contact');
    }
    const bound = configuration.bindingContract.bindRecordIds(['11111111-2222-4333-8444-555555555555']);
    assert.deepEqual(bound.fixtureBindings, []);
    assert.ok(!bound.fetchXml.includes('{{qualificationRecordIdValues}}'));
    assert.match(bound.fetchXml, /<value>11111111-2222-4333-8444-555555555555<\/value>/);
  }
});

test('native driver refuses base-role freeze and missing execution adapters before any mutation', async () => {
  await assert.rejects(
    runNativeConfigurationCampaign({ allowNativeConfigurationMutation: true, baseRoleCampaignFreezeActive: true }),
    /released base-role freeze/,
  );
  await assert.rejects(
    runNativeConfigurationCampaign({ allowNativeConfigurationMutation: true, baseRoleCampaignFreezeActive: false }),
    /adapter is missing/,
  );
});

test('bounded loopback fixture executes actual lease, archives repeated cells, restores and resumes without overwriting', async () => {
  const schema = JSON.parse(await readFile(new URL('../dataverse/manifest.json', import.meta.url)));
  const catalogue = JSON.parse(await readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
  const blueprint = buildBlueprint(schema, catalogue),
    runner = blueprint.roles.find((role) => role.code === 'TESTRUNNER');
  const variant = [...scopeHierarchyVariantCases()].find(
    (value) =>
      value.family === 'root-scope' &&
      value.parameters.scope === 'Contact' &&
      value.parameters.roleDefault === 'explicit',
  );
  const materialized = materializeScopeHierarchyVariant(variant, { schema, catalogue });
  // Two read cells in a deliberately unfinished local fixture, not native
  // evidence for the original full role/CRUD domain.
  const current = {
    ...materialized,
    roleMaskCount: 1,
    configurationCells: materialized.configurationCells.filter(
      (value) => value.roleMask === 0 && value.operation === 'read',
    ),
  };
  const domain = {
    kind: 'invented-loopback-driver-test',
    domainHash: 'd'.repeat(64),
    configurations: [current],
    denominator: materialized.configurationCells.length,
  };
  const records = new Map(),
    membership = new Set([runner.id]),
    writes = [];
  let version = 0;
  const etag = () => `W/"${++version}"`,
    actor = { contactid: id(1), _parentcustomerid_value: id(4), '@odata.etag': etag() };
  const client = {
    verify: async () => {},
    optional: async (route) => structuredClone(records.get(route.match(/\(([^)]+)\)/)?.[1]) ?? null),
    get: async (route) =>
      route.startsWith('powerpagesites(')
        ? { datamodelversion: '2.0', enhancedauthorization: 0 }
        : route.startsWith('contacts(')
          ? structuredClone(actor)
          : structuredClone(records.get(route.match(/\(([^)]+)\)/)[1])),
    list: async (route) =>
      route.startsWith('contacts(')
        ? [...membership].map((powerpagecomponentid) => ({ powerpagecomponentid }))
        : [...records.values()].map((value) => structuredClone(value)),
    request: async (route, options) => {
      writes.push({ route, method: options.method });
      if (route.startsWith('contacts(')) {
        if (options.method === 'DELETE') membership.delete(route.match(/contact\(([^)]+)\)\/\$ref/)[1]);
        else membership.add(options.body['@odata.id'].match(/\(([^)]+)\)/)[1]);
      } else if (options.method === 'POST') {
        const body = options.body;
        records.set(body.powerpagecomponentid, { ...body, _powerpagesiteid_value: id(3), '@odata.etag': etag() });
      } else {
        const recordId = route.match(/\(([^)]+)\)/)[1];
        if (options.method === 'DELETE') records.delete(recordId);
        else Object.assign(records.get(recordId), options.body, { '@odata.etag': etag() });
      }
    },
    url: (route) => 'https://fixture.invalid/' + route,
  };
  const bindings = {
    actorContactId: id(1),
    nativeDataVerified: true,
    nativeFixtureSnapshotHash: 'e'.repeat(64),
    regionRecordIds: Object.fromEntries(current.requiredRegions.map((region, index) => [region, [id(10 + index)]])),
  };
  let captures = 0;
  const adapters = {
    assertExclusiveNativeWriter: async () => {},
    provisionFixtures: async () => {},
    verifyFixtures: async () => bindings,
    prepareCell: async () => {},
    recoverFixtures: async () => {},
    cleanupFixtures: async () => ({ verified: true, allRegionsRestored: true, snapshotSha256: 'e'.repeat(64) }),
    clearPortalCaches: async () => ({
      actions: ['clearConfig', 'clearCache'].map((name) => ({ name, status: 'completed' })),
    }),
    readSourceWitnesses: async () => witnesses,
    collectNativeCell: async ({ cell, configuration, expectedRoleIds, cache }) => {
      captures++;
      return {
        cellId: cell.id,
        inputHash: configuration.inputHash,
        controllerContactId: id(1),
        membershipRoleIds: expectedRoleIds,
        nativeWitnesses: witnesses,
        cacheActions: cache.actions,
        snapshotReceipt: {
          sourceStable: true,
          registrationStable: true,
          settingsStable: true,
          membershipsStable: true,
          allRegionsVerified: true,
          dataStable: true,
        },
        history: { operationId: id(6), summarySha256: 'c'.repeat(64) },
        completePages: true,
        backendEvents: [],
        identityReceipt: { serverVerified: true, contactId: id(1) },
        pages: [{ page: 1, fragment: 1, rows: [], wire: { status: 403, body: '{"error":{"code":"90040120"}}' } }],
      };
    },
    replayNativeCell: async ({ native }) => structuredClone(native),
  };
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'configuration-driver-')),
    directory = path.join(temporary, '.paqvilo');
  const options = {
    directory,
    domain,
    client,
    adapters,
    blueprint,
    schema,
    catalogue,
    organisationId: id(2),
    siteId: id(3),
    actorContactId: id(1),
    resolvedIds: Object.fromEntries(catalogue.records.map((record, index) => [record.key, id(100 + index)])),
    allowNativeConfigurationMutation: true,
    baseRoleCampaignFreezeActive: false,
  };
  try {
    const first = await runNativeConfigurationCampaign(options);
    assert.equal(captures, 4);
    assert.equal(first.collectedConfigurations, 1);
    assert.equal(first.qualification, 'incomplete');
    assert.equal(records.size, 0);
    assert.deepEqual([...membership], [runner.id]);
    assert.ok(writes.some((value) => value.method === 'POST'));
    assert.ok(writes.some((value) => value.method === 'DELETE'));
    const second = await runNativeConfigurationCampaign(options);
    assert.equal(captures, 4);
    assert.equal(second.domainHash, first.domainHash);
    const journal = JSON.parse(await readFile(path.join(directory, 'campaign.json')));
    const artifact = journal.entries[0].cells[0];
    await writeFile(artifact.file, '{}');
    await assert.rejects(runNativeConfigurationCampaign(options), /artifact changed/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('power-cut recovery retains foreign locks and verifies cleanup/cache receipts before releasing its own lock', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qualification-campaign-'));
  const directory = path.join(temporary, '.paqvilo');
  await mkdir(directory);
  const domainHash = 'f'.repeat(64),
    journal = {
      domainHash,
      nativeQualifiedCells: 0,
      entries: [{ variantId: 'invented', directory, state: 'provisioning', leaseFiles: [] }],
    };
  const calls = [],
    adapters = {
      assertExclusiveNativeWriter: async () => calls.push('exclusive'),
      recoverFixtures: async () => calls.push('recover'),
      cleanupFixtures: async () => ({ verified: true, allRegionsRestored: true, snapshotSha256: 'e'.repeat(64) }),
      clearPortalCaches: async () => ({
        actions: ['clearConfig', 'clearCache'].map((name) => ({ name, status: 'completed' })),
      }),
    };
  try {
    await writeFile(path.join(directory, 'campaign.json'), JSON.stringify(journal));
    await writeFile(
      path.join(directory, 'writer.lock'),
      JSON.stringify({ domainHash: 'a'.repeat(64), leaseId: id(8) }),
    );
    await assert.rejects(recoverNativeConfigurationCampaign({ directory, domainHash, adapters }), /ownership mismatch/);
    await access(path.join(directory, 'writer.lock'));
    assert.deepEqual(calls, ['exclusive']);
    await writeFile(path.join(directory, 'writer.lock'), JSON.stringify({ domainHash, leaseId: id(8) }));
    adapters.cleanupFixtures = async () => ({ verified: true });
    await assert.rejects(
      recoverNativeConfigurationCampaign({ directory, domainHash, adapters }),
      /all-region native readback/,
    );
    await access(path.join(directory, 'writer.lock'));
    adapters.cleanupFixtures = async () => ({
      verified: true,
      allRegionsRestored: true,
      snapshotSha256: 'e'.repeat(64),
    });
    const result = await recoverNativeConfigurationCampaign({ directory, domainHash, adapters });
    assert.equal(result.baselineRestored, true);
    assert.equal(result.nativeQualifiedCells, 0);
    await assert.rejects(access(path.join(directory, 'writer.lock')));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
