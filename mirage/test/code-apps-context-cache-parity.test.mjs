// @test-kind parity: official @microsoft/power-apps 1.5.0 resolved-context cache reproduced in two isolated processes; invented bridge inputs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { configure, getContext } from '../lib/code-apps-client.js';
import { captureCodeAppContextCacheContract } from '../testing/code-apps-contract.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// @parity-evidence: two independent official SDK 1.5.0 executions against an authored powerAppsBridge response; exact source, capture and probe hashes in the bound fixture. This proves SDK caching, not native host fields or transport.
const bytes = fs.readFileSync(new URL('./fixtures/code-apps-context-cache-official.json', import.meta.url));
assert.equal(sha256(bytes), '7da08c77ae071d62f4e18d9b20385cb8623bb612c04b8265026fa56251d85695');
const evidence = JSON.parse(bytes);
assert.equal(sha256(captureCodeAppContextCacheContract.toString()), evidence.probeFunctionSha256);

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
