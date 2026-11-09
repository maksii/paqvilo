// @test-kind tooling: Invented query bridge values exercise lexical and typed evidence binding only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assertQueryAuthorityProcess,
  queryPackageArchiveMember,
  verifyQueryMessageBridgeCase,
} from '../scripts/parity-query-message-bridge.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => hash(JSON.stringify(value));
test('package versions and runtime profiles require their exact official archive members', () => {
  assert.equal(queryPackageArchiveMember('Microsoft.OData.Core', '8.3.0'), 'lib/net8.0/Microsoft.OData.Core.dll');
  assert.equal(
    queryPackageArchiveMember('Microsoft.OData.Core', '7.20.0'),
    'lib/netcoreapp3.1/Microsoft.OData.Core.dll',
  );
  assert.equal(
    queryPackageArchiveMember('Microsoft.OData.Edm', '7.20.0'),
    'lib/netstandard2.0/Microsoft.OData.Edm.dll',
  );
  assert.equal(
    queryPackageArchiveMember('Microsoft.OData.Core', '7.20.0', 'windows-netframework'),
    'lib/net45/Microsoft.OData.Core.dll',
  );
  assert.throws(() => queryPackageArchiveMember('Microsoft.OData.Core', '8.3.0', 'windows-netframework'));
  assert.throws(() => queryPackageArchiveMember('Microsoft.OData.Core', '7.20.1'));
  assert.throws(() => queryPackageArchiveMember('Microsoft.OData.Core', '7.20.0', 'unknown'));
});
test('Windows process identity and Linux isolation evidence cannot be substituted', () => {
  const windows = {
    runtimeKind: 'windows-netframework',
    namespace: { runtimeKind: 'windows-netframework' },
    receipt: { runtimeKind: 'windows-netframework' },
    run: { processId: 42, launcherPid: 42 },
    recorded: { processId: 42, launcherPid: 42, runtime: '.NET Framework 4.8.1' },
    parsed: { processId: 42, runtime: '.NET Framework 4.8.1' },
    stderr: '',
  };
  assert.doesNotThrow(() => assertQueryAuthorityProcess(windows));
  for (const bad of [
    { ...windows, parsed: { ...windows.parsed, processId: 43 } },
    { ...windows, parsed: { ...windows.parsed, runtime: '.NET 10.0' } },
    { ...windows, parsed: { ...windows.parsed, runtime: '.NET Framework 4.80' } },
    { ...windows, stderr: 'error' },
    { ...windows, namespace: {} },
  ])
    assert.throws(() => assertQueryAuthorityProcess(bad));
  const linux = {
    runtimeKind: undefined,
    namespace: {},
    receipt: {},
    run: { linuxPid: 42, launcherPid: 41 },
    recorded: { linuxPid: 42, launcherPid: 41 },
    parsed: {},
    stderr:
      'HOST_PID=42\nUid: 65534 65534 65534 65534\nCapEff: 0000000000000000\nCapPrm: 0000000000000000\nCapAmb: 0000000000000000\n',
  };
  assert.doesNotThrow(() => assertQueryAuthorityProcess(linux));
  assert.throws(() =>
    assertQueryAuthorityProcess({
      ...linux,
      stderr: linux.stderr.replace('CapEff: 0000000000000000', 'CapEff: 0000000000000001'),
    }),
  );
});
function invented() {
  const expected = { option: '$filter', value: 'x eq', status: 400, message: "Error at position 4 in 'x eq'." };
  const predicted = "Error at position 7 in 'yyyy eq'.";
  const replacements = [{ original: 'x', native: 'yyyy', start: 0, end: 1, type: 'Edm.Int32' }];
  const offsetEvidence = [
    {
      originalOffset: 4,
      proposedNativeOffset: 7,
      sourceLength: 4,
      nativeLength: 7,
      originalCharacter: null,
      nativeCharacter: null,
      originalAtEnd: true,
      nativeAtEnd: true,
    },
  ];
  const roles = { mappedOption: '$filter', mappedValue: 'yyyy eq', replacements, offsetEvidence };
  const response = { error: { code: '0x1', message: predicted } },
    request = {
      caseIndex: 0,
      method: 'GET',
      relativePath: 'widgets?$select=id&$filter=yyyy+eq',
      sourceQuery: '$select=id&$filter=yyyy+eq',
    };
  const ref = (value, sha256 = 'a'.repeat(64)) => ({ value, sha256 });
  const native = Array.from({ length: 2 }, () => ({
    receipt: ref({}),
    provenance: ref({}),
    metadata: ref({}),
    csdl: ref({}),
    rows: [
      {
        caseIndex: 0,
        request: ref(request),
        response: ref(response),
        truncated: false,
        status: 400,
        code: '0x1',
        message: predicted,
      },
    ],
  }));
  const capture = () => ({
    runSha256: 'a'.repeat(64),
    provenanceSha256: 'a'.repeat(64),
    metadataSha256: 'a'.repeat(64),
    csdlSha256: 'a'.repeat(64),
    cases: [
      {
        caseIndex: 0,
        sourceRoles: structuredClone(roles),
        requestSha256: 'a'.repeat(64),
        responseBodySha256: 'a'.repeat(64),
        predictedNativeMessage: predicted,
        facts: { message: predicted },
        originalSdkMessages: [expected.message, expected.message],
        adaptedSdkMessages: [predicted, predicted],
      },
    ],
  });
  const xml =
    '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"><EntityContainer><EntitySet Name="widgets" EntityType="N.widget" /></EntityContainer><EntityType Name="widget"><Key><PropertyRef Name="id" /></Key><Property Name="id" Type="Edm.Guid" /><Property Name="yyyy" Type="Edm.Int32" /></EntityType></Schema></edmx:DataServices></edmx:Edmx>';
  const sdk = (index, value, message) => ({
    index,
    option: '$filter',
    value,
    outcome: 'exception',
    exceptionType: 'Microsoft.OData.ODataException',
    message,
  });
  return {
    expected,
    capsule: { captures: [capture(), capture()] },
    authority: {
      certificate: {
        cases: [
          {
            caseIndex: 0,
            source: { option: '$filter', value: 'x eq', expectedStatus: 400, expectedMessage: expected.message },
            candidate: {
              value: 'yyyy eq',
              relativePath: 'widgets?$select=id&$filter=yyyy+eq',
              query: '$select=id&$filter=yyyy+eq',
              replacements,
            },
            offsetEvidence,
            predictedMessage: predicted,
          },
        ],
      },
      independentMap: {
        cases: [
          {
            caseIndex: 0,
            sourceTupleSha256: digest(['$filter', 'x eq', 400, expected.message]),
            sourceValueSha256: hash('x eq'),
            adaptedValueSha256: hash('yyyy eq'),
            sourceOffset: 4,
            adaptedOffset: 7,
            originalMessageSha256: hash(expected.message),
            adaptedMessageSha256: hash(predicted),
            roles: [{ source: 'x', native: 'yyyy', type: 'Edm.Int32' }],
          },
        ],
      },
      bridge: { comparisons: [{ caseIndex: 0, source: expected }], native },
      csdl: [xml, xml],
      readRef: (item) => Buffer.from(JSON.stringify(item.value)),
      original: [[sdk(1, 'x eq', expected.message)], [sdk(1, 'x eq', expected.message)]],
      adapted: [[sdk(0, 'yyyy eq', predicted)], [sdk(0, 'yyyy eq', predicted)]],
    },
  };
}
test('message bridge checks typed field, coordinate, SDK and native result links', () => {
  const fixture = invented(),
    run = () =>
      verifyQueryMessageBridgeCase(fixture.authority, fixture.capsule, 0, fixture.expected, { x: 'Edm.Int32' });
  assert.equal(run(), true);
  for (const mutate of [
    (x) => {
      x.authority.original[1][0].message = 'changed';
    },
    (x) => {
      x.authority.adapted[1][0].message = 'changed';
    },
    (x) => {
      x.capsule.captures[0].cases[0].sourceRoles.offsetEvidence[0].proposedNativeOffset = 6;
    },
    (x) => {
      x.authority.csdl[0] = x.authority.csdl[0].replace('Edm.Int32', 'Edm.String');
    },
    (x) => {
      x.authority.bridge.native[0].rows[0].response.value.error.message = 'changed';
    },
  ]) {
    const bad = invented();
    mutate(bad);
    assert.throws(
      () => verifyQueryMessageBridgeCase(bad.authority, bad.capsule, 0, bad.expected, { x: 'Edm.Int32' }),
      /invalid-query-message-bridge/,
    );
  }
});

test('CSDL roles cannot be forged through comments, CDATA, declarations or ambiguous XML', () => {
  const original = invented().authority.csdl[0];
  const fakeProperty = '<Property Name="yyyy" Type="Edm.Int32" />';
  for (const forged of [
    original.replace(fakeProperty, `<!-- outer <!-- -->${fakeProperty} -->`),
    original.replace(fakeProperty, `<![CDATA[${fakeProperty}]]>`),
    original.replace('<edmx:Edmx', '<!DOCTYPE x [<!ENTITY forged "x">]><edmx:Edmx'),
    original.replace(fakeProperty, '<Property Name="other" Name="yyyy" Type="Edm.Int32" />'),
    original.replace(fakeProperty, '<Property xmlns="urn:forged" Name="yyyy" Type="Edm.Int32" />'),
    original.replace('EntityType="N.widget"', 'EntityType="Other.widget"'),
    original.replace('<Key>', '<Key><PropertyRef Name="other" />'),
  ]) {
    const fixture = invented();
    fixture.authority.csdl[0] = forged;
    assert.throws(
      () => verifyQueryMessageBridgeCase(fixture.authority, fixture.capsule, 0, fixture.expected, { x: 'Edm.Int32' }),
      /invalid-query-message-bridge/,
    );
  }
  const fixture = invented();
  fixture.authority.csdl[0] = original.replace(
    '<EntityType Name="widget">',
    '<!-- harmless --><EntityType Name="widget">',
  );
  assert.equal(
    verifyQueryMessageBridgeCase(fixture.authority, fixture.capsule, 0, fixture.expected, { x: 'Edm.Int32' }),
    true,
  );
  fixture.authority.csdl[0] = original.replace('Edm.Int32', 'Edm.String');
  assert.throws(
    () => verifyQueryMessageBridgeCase(fixture.authority, fixture.capsule, 0, fixture.expected, { x: 'Edm.Int32' }),
    /invalid-query-message-bridge/,
  );
});
