import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { startGate, clientCredentialsToken } from '../test-sdk/harness.mjs';
import { ownedFixture, drainFixture } from '../testing/owned-fixture.mjs';

const PREFIX = 'PAQVILO_SDK_GATE_SECRET_';

test('concurrent SDK gates keep independent credentials and preserve inherited environment settings', async (t) => {
  const legacy = 'PAQVILO_SDK_GATE_SECRET',
    previous = process.env[legacy];
  const before = new Set(Object.keys(process.env));
  const created = () => Object.keys(process.env).filter((key) => key.startsWith(PREFIX) && !before.has(key));
  const gates = [];
  ownedFixture(t).add(() =>
    drainFixture([
      ...gates.map((gate) => () => gate.close()),
      () => {
        for (const key of created()) delete process.env[key];
        if (previous === undefined) delete process.env[legacy];
        else process.env[legacy] = previous;
      },
    ]),
  );
  process.env[legacy] = 'invented inherited SDK fixture setting';
  const results = await Promise.allSettled(
    [0, 1].map(async () => {
      const gate = await startGate();
      gates.push(gate);
      return gate;
    }),
  );
  assert.equal(
    results.every((result) => result.status === 'fulfilled'),
    true,
  );
  const tokens = await Promise.all(gates.map((gate) => clientCredentialsToken(gate)));
  assert.equal(
    tokens.every((token) => typeof token === 'string' && token.length > 10),
    true,
  );
  assert.equal(
    process.env[legacy] === 'invented inherited SDK fixture setting',
    true,
    'startup preserves inherited settings',
  );
  assert.deepEqual(created(), [], 'per-call secrets are not retained after startup');
});

test('SDK gate startup releases its per-call secret when a listener rejects the bind', async (t) => {
  const before = new Set(Object.keys(process.env));
  const server = net.createServer();
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await assert.rejects(startGate({ port: server.address().port }), { code: 'EADDRINUSE' });
  assert.deepEqual(
    Object.keys(process.env).filter((key) => key.startsWith(PREFIX) && !before.has(key)),
    [],
  );
});

test('concurrent TLS SDK gates own stable CA files until their own close', async (t) => {
  const gates = [];
  ownedFixture(t).add(() => drainFixture(gates.map((gate) => () => gate.close())));
  const results = await Promise.allSettled(
    [0, 1].map(async () => {
      const gate = await startGate({ tls: true });
      gates.push(gate);
      return gate;
    }),
  );
  assert.ok(results.every((result) => result.status === 'fulfilled'));
  assert.notEqual(gates[0].caFile, gates[1].caFile, 'each gate owns its trust file');
  for (const gate of gates) {
    assert.ok((await fs.readFile(gate.caFile, 'utf8')).includes(gate.caPem));
    await new Promise((resolve, reject) => {
      const request = https.get(gate.tlsOrigin + '/api/data/v9.2/', { ca: gate.caPem }, (response) => {
        response.resume();
        response.once('end', resolve);
      });
      request.once('error', reject);
    });
  }
  await gates[0].close();
  await assert.rejects(fs.stat(gates[0].caFile), { code: 'ENOENT' });
  assert.ok((await fs.readFile(gates[1].caFile, 'utf8')).includes(gates[1].caPem));
});
