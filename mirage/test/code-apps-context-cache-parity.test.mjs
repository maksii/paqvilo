// @test-kind observation: two official @microsoft/power-apps 1.5.0 runs in fixtures/code-apps-context-cache-official.json (raw sha256 a1e83e58...) bind the resolved-context cache probe; they prove SDK caching only, not native host fields or transport, and the authored bridge response is typed in this test rather than recorded, so it is not a replay case.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { configure, getContext } from '../lib/code-apps-client.js';
import { captureCodeAppContextCacheContract } from '../testing/code-apps-contract.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const bytes = fs.readFileSync(new URL('./fixtures/code-apps-context-cache-official.json', import.meta.url));

const evidence = JSON.parse(bytes);

test.before(() => {
  assert.equal(sha256(bytes), '7da08c77ae071d62f4e18d9b20385cb8623bb612c04b8265026fa56251d85695');
  assert.equal(sha256(captureCodeAppContextCacheContract.toString()), evidence.probeFunctionSha256);
});

test('resolved context preserves object identity and client-side query mutations like the official SDK', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ app: { queryParams: { authored: 'fixture' } } }), {
      headers: { 'x-sim-csrf': 'invented-token' },
    });
  };
  configure({ app: 'invented-context-probe' });
  assert.deepEqual(await captureCodeAppContextCacheContract({ getContext }), evidence.rows);
  assert.equal(calls, evidence.hostCalls.length);
  assert.deepEqual((await getContext()).app.queryParams, { authored: 'fixture' });
});
