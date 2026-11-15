// @test-kind contract+security: one diagnosed ECONNRESET recovery for idempotent configuration; uncertain creates are never replayed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectRuntime } from '../testing.mjs';
import { simulatorFixture } from './fixtures/source-site.mjs';

const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
test('configuration assignments recover once before send or after commit and preserve a bounded diagnostic', async () => {
  for (const afterCommit of [false, true]) {
    let assignments = 0,
      calls = 0;
    const client = await connectRuntime({
      origin: 'http://127.0.0.1:11942',
      fetchImpl: async (url) => {
        if (url.endsWith('/apply')) {
          calls++;
          if (afterCommit || calls > 1) assignments++;
          if (calls === 1) throw reset();
          return Response.json({ applied: 'invented' });
        }
        return Response.json({ csrf: 'invented' });
      },
    });
    assert.deepEqual(await client.applyExperiment('invented'), { applied: 'invented' });
    assert.equal(calls, 2);
    assert.equal(assignments, afterCommit ? 2 : 1);
    assert.deepEqual(client.transportDiagnostics(), [
      { code: 'RUNTIME_CONFIGURATION_RETRY', cause: 'ECONNRESET', attempt: 1 },
    ]);
  }
});

test('configuration recovery is bounded and other errors and uncertain mutation responses propagate', async () => {
  for (const kind of ['reset', 'refused', 'http', 'create']) {
    let calls = 0;
    const client = await connectRuntime({
      origin: 'http://127.0.0.1:11942',
      fetchImpl: async (url, init) => {
        if (init.method === 'POST') {
          calls++;
          if (kind === 'http') return Response.json({ error: { message: 'refused' } }, { status: 503 });
          if (kind === 'refused') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
          throw reset();
        }
        return Response.json({ csrf: 'invented' });
      },
    });
    await assert.rejects(
      kind === 'create' ? client.saveExperiment({ name: 'invented' }) : client.applyExperiment('invented'),
    );
    assert.equal(calls, kind === 'reset' ? 2 : 1);
    assert.equal(client.transportDiagnostics().length, kind === 'reset' ? 1 : 0);
  }
});

test('a retained real runtime client resumes a lost snippet assignment by reading its committed identity after preset replacement', async (t) => {
  const sim = await simulatorFixture(t, {
    prefix: 'paq-config-recovery-',
    watch: false,
    files: { 'website.yml': 'adx_websiteid: invented\nadx_name: Invented' },
    packs: [
      {
        id: 'invented-large',
        name: 'Invented large',
        description: 'Synthetic state replacement',
        matches: () => true,
        presets: () => ({
          'invented-large': {
            name: 'Invented large',
            description: 'Synthetic rows',
            load: () => ({
              mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid' } },
              tables: {
                x_item: Array.from({ length: 4000 }, (_, i) => ({ x_itemid: String(i), x_name: 'Invented row ' + i })),
              },
            }),
          },
        }),
      },
    ],
  });
  let dropped = false,
    creates = 0;
  const client = await connectRuntime({
    origin: sim.url,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (url.endsWith('/portal-snippets') && init.method === 'POST') {
        creates++;
        if (!dropped) {
          dropped = true;
          await response.text();
          throw reset();
        }
      }
      return response;
    },
  });
  await sim.applyPreset('invented-large');
  await client.setSnippet('Invented assignment', '<p>Committed value</p>');
  assert.equal(creates, 1, 'the recovery reads and updates the committed snippet instead of creating it again');
  assert.equal(sim.store.tableRows('x_item').length, 4000);
  const state = await client.state({ summary: true });
  assert.ok(JSON.stringify(state).includes('Committed value'));
  assert.equal(client.transportDiagnostics().length, 1);
});
