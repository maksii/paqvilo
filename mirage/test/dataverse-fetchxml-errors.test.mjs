import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
// @test-kind unproven: Local FetchXML error models; repeated native guarantees have individual protected regions below.
// FetchXML errors on the Dataverse Web API path (?fetchXml=): malformed XML, a missing entity name,
// an unknown condition operator and a column the metadata lacks answer the native codes and text.
// The portal's FetchXML keeps its own rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createRecordHandlers } from '../lib/dataverse-records.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const WIDGET = '00000000-0000-4000-8000-000000000101';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [{ objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
};
const text = { dataverseType: 'nvarchar' };

// complete: the table's metadata is the whole schema (an absent column is unknown); otherwise it is incomplete
// and an absent column with no stored row is only unverified.
function fixtureState(complete) {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'contoso_name',
    ...(complete ? { schemaComplete: true } : {}),
    fields: { contoso_name: text, contoso_price: { dataverseType: 'money' } },
    relationships: {},
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, contoso_name: 'Alpha', contoso_price: 3 }];
  return state;
}

async function setup(complete) {
  const store = new DataStore({ state: fixtureState(complete) });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const handlers = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes,
  });
  const admin = principals.byObjectId(ADMIN_OID);
  // identity.dataverse marks the Dataverse caller, as lib/dataverse-api.mjs builds it.
  const send = (path) => {
    const url = new URL(path, ORIGIN);
    return handlers.handle({
      method: 'GET',
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers: {},
      user: admin,
      caller: admin,
      identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid, dataverse: {} },
      requestId: 'test',
    });
  };
  return { store, send };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

const fetchPath = (xml) => `/api/data/${VERSION}/contoso_widgets?fetchXml=${encodeURIComponent(xml)}`;

const QUERY_ERRORS = [
  ['malformed FetchXML answers Invalid XML before any entity is read', '<fetch><entity', 'Invalid XML.', '0x80040201'],
  [
    'FetchXML without an entity answers the missing entity name',
    '<fetch/>',
    'Entity Name was not specified in FetchXml String.',
    '0x80041102',
  ],
  [
    'an unknown condition operator answers the native operator code and text',
    '<fetch><entity name="contoso_widget"><filter><condition attribute="contoso_name" operator="nonexistent" value="x"/></filter></entity></fetch>',
    'Unknown Condition Operator: nonexistent',
    '0x80041120',
  ],
];
for (const [name, xml, message, innerCode] of QUERY_ERRORS) {
  // @test-kind parity: Repeated native1071 captures prove malformed XML, missing entity and unknown operator400 codes/messages for these three existing cases.
  // @parity-evidence: dataverse-existing-http-guarantees.json binds fetchxml.invalid-xml/empty/unknown-operator in both raw native cohorts; the existing case universe and proof bytes are checksum-protected here.
  test(name, async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-fetchxml-errors.test.mjs:104:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '3522cb06c486f6651b9a2fe4f9d87cad06d6aafbcb0cb65721eae514bf1f9ee5',
        originalAssertions: ['832b34c759476b12d771ed740074018e9f5b49efe4d5b9e2b6a3563e0b5ecd4b'],
        originalBodyAstSha256: 'c70f729c1fa08deeebed20df4e46eecc6b46238a51fe7971372bfbc362da36d2',
        originalGuardHashes: [],
        retainedUniverseAssertions: ['fbf7f61962d35719b6542fe780e0290b9c546df01e3f62899a386f6e97644ccf'],
        moduleContextAstSha256: '9b6696664aa89d767f73bdfc153dc8f34a40b4753b1853c69b4de573f8797e8e',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit runtime implementation exercised by these Dataverse behavior assertions; source may evolve as bugs are corrected.',
          },
          {
            source: '../lib/dataverse-security.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit runtime implementation exercised by these Dataverse behavior assertions; source may evolve as bugs are corrected.',
          },
          {
            source: '../lib/dataverse-records.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit runtime implementation exercised by these Dataverse behavior assertions; source may evolve as bugs are corrected.',
          },
          {
            source: '../lib/dataverse-odata.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit runtime implementation exercised by these Dataverse behavior assertions; source may evolve as bugs are corrected.',
          },
          {
            source: '../lib/dataverse-changes.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit runtime implementation exercised by these Dataverse behavior assertions; source may evolve as bugs are corrected.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [
          {
            name: 'QUERY_ERRORS',
            ownerTitle: null,
            initializerAstSha256: 'da47cbe68e307fcad7dbfd69d0916b9521333788092ac52ed8bcf4493e296946',
          },
        ],
        loopHeaders: ['51bc7aa9bb69191fd14453d3634b42ff1de6567017ab911b5105138ba7bc1e48'],
        caseUniverse: {
          count: 3,
          cases: [
            'malformed FetchXML answers Invalid XML before any entity is read',
            'FetchXML without an entity answers the missing entity name',
            'an unknown condition operator answers the native operator code and text',
          ],
          casesSha256: '0a67f9446c3f717adec6876e47dbdc658c7f3faf508d513de540ad2eaaf5d291',
          sourceBindings: [
            {
              name: 'QUERY_ERRORS',
              ownerTitle: null,
              initializerAstSha256: 'da47cbe68e307fcad7dbfd69d0916b9521333788092ac52ed8bcf4493e296946',
            },
          ],
          ancestorLoops: [{ headerAstSha256: '51bc7aa9bb69191fd14453d3634b42ff1de6567017ab911b5105138ba7bc1e48' }],
          caseBindings: [
            {
              name: 'malformed FetchXML answers Invalid XML before any entity is read',
              xml: '<fetch><entity',
              message: 'Invalid XML.',
              innerCode: '0x80040201',
            },
            {
              name: 'FetchXML without an entity answers the missing entity name',
              xml: '<fetch/>',
              message: 'Entity Name was not specified in FetchXml String.',
              innerCode: '0x80041102',
            },
            {
              name: 'an unknown condition operator answers the native operator code and text',
              xml: '<fetch><entity name="contoso_widget"><filter><condition attribute="contoso_name" operator="nonexistent" value="x"/></filter></entity></fetch>',
              message: 'Unknown Condition Operator: nonexistent',
              innerCode: '0x80041120',
            },
          ],
        },
        caseFacts: [
          { caseIndex: 0, assertionIndex: 0, factIds: ['proof0-case14'] },
          { caseIndex: 1, assertionIndex: 0, factIds: ['proof0-case15'] },
          { caseIndex: 2, assertionIndex: 0, factIds: ['proof0-case16'] },
        ],
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-http-guarantees.json',
            sha256: 'f45b9e460cbc1a9080f6432385ccc7072915a1bb4c4c44a944ba33ce7ecd54a7',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case0',
                pointer: '/captures/0/cases/0/facts',
                sha256: '8397a278759b68b0171c64b040d6151e2f8a77bbf9b4dfd0fdfda7a811d5fb91',
                replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
              },
              {
                id: 'proof0-case1',
                pointer: '/captures/0/cases/1/facts',
                sha256: '51d409e886a0effa2793790a223da8d7f0fb6c2c50229ff94f1e6c9c7758212d',
                replicatedPointers: ['/captures/0/cases/1/facts', '/captures/1/cases/1/facts'],
              },
              {
                id: 'proof0-case2',
                pointer: '/captures/0/cases/2/facts',
                sha256: '12946ec9c193d81b7ced6845676370a96e78567e9e3129c676352036bc9928f5',
                replicatedPointers: ['/captures/0/cases/2/facts', '/captures/1/cases/2/facts'],
              },
              {
                id: 'proof0-case3',
                pointer: '/captures/0/cases/3/facts',
                sha256: 'ced00be7c556646ad8a3918d28fd32106a0e21e3f4d17a03d01ea99311945568',
                replicatedPointers: ['/captures/0/cases/3/facts', '/captures/1/cases/3/facts'],
              },
              {
                id: 'proof0-case4',
                pointer: '/captures/0/cases/4/facts',
                sha256: '98ca278fd20bb4f3b6557fba8100a8d1a8178686ff687e312fa4429447fce552',
                replicatedPointers: ['/captures/0/cases/4/facts', '/captures/1/cases/4/facts'],
              },
              {
                id: 'proof0-case5',
                pointer: '/captures/0/cases/5/facts',
                sha256: 'd73a697e77ee8f4091cdfdd62e0c602a5e030d4e081338859f9a695b0421168a',
                replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
              },
              {
                id: 'proof0-case6',
                pointer: '/captures/0/cases/6/facts',
                sha256: 'e5b236f9ca30ab1866ba811c46e111af1d3c39b4586172dbfb856fbc3a812ab4',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
              {
                id: 'proof0-case7',
                pointer: '/captures/0/cases/7/facts',
                sha256: '059dd93736a1ac435b18852bdb1cba0fef1c8d27eb739be658c91757813fe676',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
              {
                id: 'proof0-case8',
                pointer: '/captures/0/cases/8/facts',
                sha256: '275133b618f52c43ba8ba6247e8fb59e8830ebbdf850ce3c548e8f1d48e3bfce',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'proof0-case9',
                pointer: '/captures/0/cases/9/facts',
                sha256: '21676470015851f37ca3abbb9394fecd9d70e01fc44772eff8910ab162fdfaec',
                replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
              },
              {
                id: 'proof0-case10',
                pointer: '/captures/0/cases/10/facts',
                sha256: '92d9cd19d1001db1900c3a9d0ea9c0e4e5d487752b6e43348b3a5a4228606438',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'proof0-case11',
                pointer: '/captures/0/cases/11/facts',
                sha256: '6d29c7e6ef5c0d661062d6b4fb870dacb68264b6ef625882abc426f04f237688',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
              {
                id: 'proof0-case12',
                pointer: '/captures/0/cases/12/facts',
                sha256: 'f05458d5338677c9f22b99a2293ead7ab36d9c03ea126669b5a798a693855ce7',
                replicatedPointers: ['/captures/0/cases/12/facts', '/captures/1/cases/12/facts'],
              },
              {
                id: 'proof0-case13',
                pointer: '/captures/0/cases/13/facts',
                sha256: '7185ae3a68dbdb0c5b5261d6b875293d09719c81de495d83f46dba926c42e485',
                replicatedPointers: ['/captures/0/cases/13/facts', '/captures/1/cases/13/facts'],
              },
              {
                id: 'proof0-case14',
                pointer: '/captures/0/cases/14/facts',
                sha256: 'cdd199c5ba3e1482cec85f3ee9281e3e6eb54864f38d53ea9801abb876d130f9',
                replicatedPointers: ['/captures/0/cases/14/facts', '/captures/1/cases/14/facts'],
              },
              {
                id: 'proof0-case15',
                pointer: '/captures/0/cases/15/facts',
                sha256: 'e8ec30dfb1897f9278d1e05cbff86debd8b6662c0ddd5265800639cd380c30c5',
                replicatedPointers: ['/captures/0/cases/15/facts', '/captures/1/cases/15/facts'],
              },
              {
                id: 'proof0-case16',
                pointer: '/captures/0/cases/16/facts',
                sha256: '9a8e14b46a37ae2a9469d8286b7e568a7d3c3afdd5ebff912f180cb2269050e0',
                replicatedPointers: ['/captures/0/cases/16/facts', '/captures/1/cases/16/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-http-guarantees.json', import.meta.url)))
        .digest('hex'),
      'f45b9e460cbc1a9080f6432385ccc7072915a1bb4c4c44a944ba33ce7ecd54a7',
    );
    assert.equal(
      createHash('sha256').update(JSON.stringify(QUERY_ERRORS)).digest('hex'),
      '1e5ee95de283a9b5c5cc4fcc4a3c12b81521f9659cf0331d2b3044cba93d1ae1',
    );
    const t = await setup(true);
    const error = await failure(t.send(fetchPath(xml)));
    assert.deepEqual([error.status, error.message, error.details.innerCode], [400, message, innerCode]);
  });
}

for (const complete of [true, false]) {
  test(`a column the metadata lacks is rejected in attribute, condition and order (complete metadata: ${complete})`, async () => {
    const t = await setup(complete);
    const expected =
      "'contoso_widget' entity doesn't contain attribute with Name = 'contoso_nosuch' and NameMapping = 'Logical' (look up attribute by name is case-sensitive).";
    const queries = {
      attribute: '<fetch><entity name="contoso_widget"><attribute name="contoso_nosuch"/></entity></fetch>',
      condition:
        '<fetch><entity name="contoso_widget"><filter><condition attribute="contoso_nosuch" operator="eq" value="x"/></filter></entity></fetch>',
      order:
        '<fetch><entity name="contoso_widget"><attribute name="contoso_name"/><order attribute="contoso_nosuch"/></entity></fetch>',
    };
    for (const [use, xml] of Object.entries(queries)) {
      const error = await failure(t.send(fetchPath(xml)));
      assert.equal(error.status, 400, use);
      assert.equal(error.message, expected, use);
      assert.equal(error.details.innerCode, '0x80041103', use);
    }
  });
}

test('known columns, the id column and system audit columns still run on the Dataverse path', async () => {
  const t = await setup(true);
  const res = await t.send(
    fetchPath(
      '<fetch><entity name="contoso_widget"><attribute name="contoso_name"/><attribute name="createdon"/><order attribute="contoso_price"/></entity></fetch>',
    ),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.value.length, 1);
  assert.equal(res.body.value[0].contoso_name, 'Alpha');
});

test('the portal FetchXML keeps its own operator message and ignores an unverified column', async () => {
  const store = new DataStore({ state: fixtureState(false) });
  const identity = { admin: true };
  const xml =
    '<fetch><entity name="contoso_widget"><attribute name="contoso_name"/><attribute name="contoso_nosuch"/></entity></fetch>';
  const result = store.fetchXml(xml, identity, {});
  assert.equal(result.entities.length, 1);
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ['FETCHXML_COLUMN_UNVERIFIED'],
  );
  const bad = await failure(
    Promise.resolve().then(() =>
      store.fetchXml(
        '<fetch><entity name="contoso_widget"><filter><condition attribute="contoso_name" operator="nonexistent" value="x"/></filter></entity></fetch>',
        identity,
        {},
      ),
    ),
  );
  assert.equal(bad.message, 'Unsupported FetchXML operator nonexistent');
  assert.equal(bad.code, 'UnsupportedQuery');
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings aaa79e8217bcdfe2', () => {
  // @parity-evidence: Tooling-only exposure of the existing source/run/fact/case validator; the same helper and module URL execute once, with every protected binding unchanged.
  assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));
});
