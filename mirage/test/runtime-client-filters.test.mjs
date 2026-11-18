// @test-kind contract: Paqvilo public testing client and admin routes: a trace or log filter outside its documented range is refused with the route's code and parameter, never ignored (docs/public-api.md, mirage/docs/tracing.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { connectRuntime } from '../testing.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

test('the runtime client refuses a bad trace limit, a short trace id prefix and an unknown log type', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-client-filters-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented filters\n');
  const sim = await createSimulator({ sourceDir: dir, watch: false });
  ownedFixture(t).add(() => sim.close());
  const client = await connectRuntime({ origin: sim.url });
  for (const [call, code, parameter] of [
    [() => client.trace.query({ limit: -5 }), 'InvalidTraceFilter', 'limit'],
    [() => client.trace.spans({ limit: 0 }), 'InvalidTraceFilter', 'limit'],
    [() => client.trace.query({ traceId: 'abc' }), 'InvalidTraceFilter', 'traceId'],
    [() => client.logs({ type: 'nope' }), 'InvalidLogFilter', 'type'],
  ])
    await assert.rejects(call(), { status: 400, code, parameter });
  // The same rules answer in process.
  assert.throws(() => sim.trace.query({ traceId: 'abc' }), { code: 'InvalidTraceFilter', parameter: 'traceId' });
  // Valid values still read.
  assert.ok(Array.isArray((await client.trace.query({ traceId: 'abcdef01' })).items));
  assert.ok(Array.isArray((await client.logs({ type: ['startup', 'reload'] })).items));
});
