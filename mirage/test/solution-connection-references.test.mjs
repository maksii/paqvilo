import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importSolutionData, applySolutionData, solutionSeedRows } from '../lib/solution-data.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CUSTOMIZATIONS = `<ImportExportXml><Entities/><connectionreferences>
<connectionreference connectionreferencelogicalname="x_boundref"><connectionreferencedisplayname>Bound reference</connectionreferencedisplayname><connectorid>/providers/Microsoft.PowerApps/apis/shared_fxsolution</connectorid></connectionreference>
<connectionreference connectionreferencelogicalname="x_unboundref"><connectionreferencedisplayname>Unbound reference</connectionreferencedisplayname><connectorid>/providers/Microsoft.PowerApps/apis/shared_fxother</connectorid></connectionreference>
</connectionreferences></ImportExportXml>`;

async function solution(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'solution-connrefs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries({
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedReferences</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Other/Customizations.xml': CUSTOMIZATIONS,
  })) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return importSolutionData([root]);
}
const empty = () => ({ mappings: {}, tables: {}, simulator: {} });
const row = (state, name) =>
  state.tables.connectionreference.find((item) => item.connectionreferencelogicalname === name);

test('Solution connection references are seeded as unbound rows with a diagnostic each', async (t) => {
  const data = await solution(t);
  assert.deepEqual(
    data.connectionReferences.map((reference) => [reference.logicalName, reference.displayName, reference.connectorId]),
    [
      ['x_boundref', 'Bound reference', '/providers/Microsoft.PowerApps/apis/shared_fxsolution'],
      ['x_unboundref', 'Unbound reference', '/providers/Microsoft.PowerApps/apis/shared_fxother'],
    ],
  );
  const state = applySolutionData(empty(), data);
  assert.equal(state.mappings.connectionreference.idColumn, 'connectionreferenceid');
  assert.equal(state.tables.connectionreference.length, 2);
  assert.deepEqual(
    { ...row(state, 'x_unboundref'), connectionreferenceid: undefined },
    {
      connectionreferenceid: undefined,
      connectionreferencelogicalname: 'x_unboundref',
      connectionreferencedisplayname: 'Unbound reference',
      connectionid: null,
      connectorid: '/providers/Microsoft.PowerApps/apis/shared_fxother',
      statecode: 0,
      statuscode: 1,
    },
  );
  const unbound = state.simulator.importDiagnostics
    .filter((item) => item.code === 'SOLUTION_CONNREF_UNBOUND')
    .map((item) => item.logicalName);
  assert.deepEqual(unbound, ['x_boundref', 'x_unboundref']);
});

test('a deployment-profile binding wins for the connection id and clears its unbound diagnostic', async (t) => {
  const data = await solution(t);
  const bindings = [
    {
      logicalName: 'X_BoundRef',
      connectionId: 'fx-connection-1',
      connectorId: '/providers/Microsoft.PowerApps/apis/shared_fxprofile',
    },
    {
      logicalName: 'x_profileonly',
      connectionId: 'fx-connection-2',
      connectorId: '/providers/Microsoft.PowerApps/apis/shared_fxprofile',
    },
  ];
  const state = applySolutionData(empty(), data, { connectionReferences: bindings });
  assert.equal(state.tables.connectionreference.length, 3);
  const bound = row(state, 'X_BoundRef');
  assert.equal(bound.connectionid, 'fx-connection-1');
  assert.equal(bound.connectorid, '/providers/Microsoft.PowerApps/apis/shared_fxprofile');
  assert.equal(bound.connectionreferencedisplayname, 'Bound reference');
  assert.equal(row(state, 'x_profileonly').connectionid, 'fx-connection-2');
  assert.deepEqual(
    state.simulator.importDiagnostics
      .filter((item) => item.code === 'SOLUTION_CONNREF_UNBOUND')
      .map((item) => item.logicalName),
    ['x_unboundref'],
  );

  // Unbinding on a later import clears the stale connection id instead of keeping it.
  const rebound = applySolutionData(state, data);
  assert.equal(row(rebound, 'x_boundref').connectionid, null);
  assert.equal(rebound.tables.connectionreference.length, 2);
  assert.equal(row(rebound, 'x_profileonly'), undefined);
});

test('profile-only references keep their seeded shape', () => {
  assert.deepEqual(
    solutionSeedRows(
      {},
      { connectionReferences: [{ logicalName: 'x_only', connectionId: 'c', connectorId: 'k' }] },
    ).connectionreference.map((item) => [item.connectionid, item.connectorid]),
    [['c', 'k']],
  );
});
