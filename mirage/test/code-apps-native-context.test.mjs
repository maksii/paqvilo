// @test-kind parity: two independent published native Code Apps player loads on 2026-11-08; typed context relationships and authored query fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createCodeAppsHandler } from '../lib/code-apps-http.mjs';
import { configure, getContext } from '../lib/code-apps-client.js';
import { captureCodeAppContextContract, captureCodeAppContextCacheContract } from '../testing/code-apps-contract.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
// @parity-evidence: two fresh published-host context captures agree on all 13 typed context/query rows and four cache rows; serialized probes and raw capture hashes are bound in the fixture.
const bytes = fs.readFileSync(new URL('./fixtures/code-apps-context-native.json', import.meta.url));
assert.equal(hash(bytes), '9ba4e056aca60036e840d81bfe8cf65abece4a5ce529f111994fac17aac81b3b');
const evidence = JSON.parse(bytes);
assert.equal(hash(captureCodeAppContextContract.toString()), evidence.probeFunctionSha256);
assert.equal(hash(captureCodeAppContextCacheContract.toString()), evidence.cacheProbeFunctionSha256);

test('local context reproduces native required fields, authored query decoding and cache relationships', async (t) => {
  const originalLocation = globalThis.location;
  t.after(() => {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  });
  const userId = '11111111-1111-4111-8111-111111111111';
  const appId = '22222222-2222-4222-8222-222222222222';
  const environmentId = '33333333-3333-4333-8333-333333333333';
  const handler = createCodeAppsHandler({
    apps: () => [{ name: 'invented', appId, environmentId, appSettings: {}, connectionReferences: [] }],
    sessions: { resolve: () => ({ kind: 'staff', principalId: userId }) },
    user: () => ({
      systemuserid: userId,
      fullname: 'Invented User',
      azureactivedirectoryobjectid: '44444444-4444-4444-8444-444444444444',
      domainname: 'invented@example.test',
    }),
    organization: {
      organizationId: '55555555-5555-4555-8555-555555555555',
      tenantId: '66666666-6666-4666-8666-666666666666',
      origin: 'http://127.0.0.1',
    },
    csrf: () => 'invented-csrf',
  });
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    requests++;
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const search =
    '?' +
    new URLSearchParams([
      ['_paqvilo_literal', 'authored + & ='],
      ['_paqvilo_empty', ''],
      ['_paqvilo_unicode', 'invented Łódź'],
      ['_paqvilo_repeat', 'first'],
      ['_paqvilo_repeat', 'last'],
    ]);
  globalThis.location = { origin, href: origin + '/_apps/code/invented/' + search, search };
  configure({ app: 'invented', origin });
  assert.deepEqual(
    await captureCodeAppContextContract(
      { getContext },
      {
        appId,
        environmentId,
        queryKeys: ['_paqvilo_literal', '_paqvilo_empty', '_paqvilo_unicode', '_paqvilo_repeat'],
      },
    ),
    evidence.rows,
  );
  assert.deepEqual(await captureCodeAppContextCacheContract({ getContext }), evidence.cache);
  assert.equal(requests, 1);
});
