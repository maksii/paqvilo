import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { persistNativeReadHistory } from '../portal-harness/native-history.mjs';
import { decodeArtifact } from '../portal-harness/core.mjs';
const plan = { id: 'invented', pageSize: 10, fields: [{ name: 'widgetid', source: 'widgetid', type: 'guid' }] },
  manifest = { choices: { pqvd_runstate: { Completed: 1 } } };
function clientFor() {
  const rows = {
    op: { _pqvd_runid_value: 'run', '@odata.etag': 'version' },
    run: { _pqvd_runnercontactid_value: 'actor', '@odata.etag': 'version' },
  };
  const key = (endpoint) => (endpoint.startsWith('pqvd_testruns') ? 'run' : 'op');
  return {
    rows,
    client: {
      get: async (endpoint) => ({ ...rows[key(endpoint)] }),
      request: async (endpoint, opts) => {
        assert.equal(opts.ifMatch, 'version');
        Object.assign(rows[key(endpoint)], opts.body);
      },
    },
  };
}
test('native history preserves exact bytes, typed rows, operation ownership and finished run index', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-history-')),
    capture = {
      runId: 'run',
      actorRoles: ['Reader'],
      requests: [{ operationId: 'op', caseId: 'invented', lane: 'webapi', page: 1, authoredFetchXml: '<fetch/>' }],
      results: [{ operationId: 'op', lane: 'webapi', status: 200, body: '{"value":[{"widgetid":"one"}]}' }],
      liquidPages: [],
      backendEvents: [],
      qualification: { snapshotComparison: { stable: true }, registrationSha256: 'registered', sourcesStable: true },
    },
    { rows, client } = clientFor();
  try {
    const report = await persistNativeReadHistory(client, {
      capture,
      intents: [{ id: 'op', plan, lane: 'webapi', operation: { _pqvd_runnercontactid_value: 'actor' } }],
      manifest,
      journalFile: path.join(dir, 'history.json'),
    });
    assert.equal(report.operations, 1);
    assert.equal(await decodeArtifact(rows.op.pqvd_authoredquery), '<fetch/>');
    const summary = JSON.parse(await decodeArtifact(rows.op.pqvd_clientsummary));
    assert.deepEqual(summary.rows, [{ widgetid: 'one' }]);
    assert.deepEqual(summary.roles, ['Reader']);
    assert.equal(rows.run.pqvd_runstate, 1);
    const index = JSON.parse(rows.run.pqvd_summaryjson);
    assert.equal(index.operations[0].operationId, 'op');
    assert.equal(index.parityQualification, 'pending-exact-Mirage-replay');
    rows.op._pqvd_runid_value = 'foreign';
    await assert.rejects(
      persistNativeReadHistory(client, {
        capture,
        intents: [{ id: 'op', plan, lane: 'webapi', operation: {} }],
        manifest,
        journalFile: path.join(dir, 'foreign.json'),
      }),
      /ownership\/version/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('XML-only history never invents successful empty retrieval results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-history-')),
    capture = {
      runId: 'run',
      actorRoles: ['Reader'],
      requests: [{ operationId: 'op', caseId: 'invented', lane: 'liquid', authoredFetchXml: '<fetch/>' }],
      results: [],
      liquidPages: [{ operationId: 'op', outcome: 'results-not-requested', rows: [], effectiveFetchXml: '<fetch/>' }],
      backendEvents: [],
      qualification: { snapshotComparison: { stable: true }, registrationSha256: 'registered', sourcesStable: true },
    },
    { rows, client } = clientFor();
  try {
    await persistNativeReadHistory(client, {
      capture,
      intents: [{ id: 'op', plan, lane: 'liquid', operation: { _pqvd_runnercontactid_value: 'actor' } }],
      manifest,
      journalFile: path.join(dir, 'history.json'),
    });
    const summary = JSON.parse(await decodeArtifact(rows.op.pqvd_clientsummary));
    assert.equal(summary.executionRequested, false);
    assert.equal(summary.rows, null);
    assert.equal(summary.count, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('native history preserves exact unsafe numeric wire tokens and flat platform errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-history-')),
    numericPlan = {
      id: 'invented',
      pageSize: 10,
      fields: [
        { name: 'counter', source: 'counter', type: 'integer' },
        { name: 'amount', source: 'amount', type: 'decimal', precision: 4 },
      ],
    },
    wire =
      '{"value":[{"counter":9007199254740993,"amount":9007199254740993.0001}],"error":{"code":"outer","cdscode":"native-code","innererror":{"cdscode":"wrong-code"}}}',
    capture = {
      runId: 'run',
      actorRoles: ['Reader'],
      requests: [{ operationId: 'op', caseId: 'invented', lane: 'webapi', authoredFetchXml: '<fetch/>' }],
      results: [{ operationId: 'op', lane: 'webapi', status: 200, body: wire }],
      liquidPages: [],
      backendEvents: [],
      qualification: { snapshotComparison: { stable: true }, registrationSha256: 'registered', sourcesStable: true },
    },
    { rows, client } = clientFor();
  try {
    await persistNativeReadHistory(client, {
      capture,
      intents: [{ id: 'op', plan: numericPlan, lane: 'webapi', operation: { _pqvd_runnercontactid_value: 'actor' } }],
      manifest,
      journalFile: path.join(dir, 'history.json'),
    });
    const summary = JSON.parse(await decodeArtifact(rows.op.pqvd_clientsummary));
    assert.equal(summary.rows[0].counter, '9007199254740993');
    assert.equal(summary.rows[0].amount, '9007199254740993.0001');
    assert.equal(summary.platformCode, 'native-code');
    assert.equal(await decodeArtifact(summary.wireResponse.body), wire);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
