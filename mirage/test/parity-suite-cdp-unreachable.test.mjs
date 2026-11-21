// @test-kind contract: parity-suite's --cdp connection refuses an endpoint nothing answers with the one line every tool's --cdp prints
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openCdpTabDriver } from '../parity-suite.mjs';
import { CDP_CONNECT_FAILURE } from '../lib/live.mjs';

test('a --cdp endpoint nothing answers is the shared one-line refusal, never "fetch failed"', async () => {
  // A loopback port that was just released: nothing answers there.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cdpUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(openCdpTabDriver({ cdpUrl, origin: 'https://portal.invalid/' }), (error) => {
    assert.equal(error.message, CDP_CONNECT_FAILURE);
    assert.equal(error.code, 'LIVE_BRIDGE');
    assert.ok(error.cause, 'the fetch failure is kept as the cause');
    return true;
  });
});
