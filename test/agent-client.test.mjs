import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import agent, { agentRequest, listAgentSessions, readDiscovery } from '../lense/commands/agent.mjs';

async function fixture(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-agent-client-'));
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  const discovery = { schemaVersion: 1, id: 'fixture-session', token: 'secret'.repeat(8), endpoint: `http://127.0.0.1:${server.address().port}`, site: 'fixture', environment: 'local', pid: process.pid };
  const file = path.join(dir, 'agents', 'fixture.json');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(discovery));
  return { dir, discovery, file };
}

test('agent discovery rejects external/credentialed/malformed endpoints before sending credentials', async (t) => {
  let requests = 0;
  const fx = await fixture(t, (_req, res) => { requests++; res.end('{}'); });
  assert.equal((await readDiscovery(fx.file)).id, fx.discovery.id);
  for (const endpoint of ['https://127.0.0.1:8080', 'http://example.test:8080', 'http://user@127.0.0.1:8080', 'http://127.0.0.1:8080/path', 'http://127.0.0.1:8080/?secret=1']) {
    await fs.writeFile(fx.file, JSON.stringify({ ...fx.discovery, endpoint }));
    await assert.rejects(readDiscovery(fx.file), /Invalid/);
  }
  assert.equal(requests, 0);
});

test('agent never follows redirects carrying its bearer token', async (t) => {
  let redirected = false;
  const fx = await fixture(t, (req, res) => {
    if (req.url === '/v1/session') res.writeHead(302, { location: '/secret-sink' }).end();
    else { redirected = true; res.end('{}'); }
  });
  await assert.rejects(agentRequest(fx.discovery, '/v1/session'), /Cannot reach/);
  assert.equal(redirected, false);
});

test('session discovery probes identity, labels invalid files, and never prints tokens', async (t) => {
  const fx = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${'secret'.repeat(8)}`);
    res.end(JSON.stringify({ schemaVersion: 1, id: 'fixture-session' }));
  });
  await fs.writeFile(path.join(fx.dir, 'agents', 'bad.json'), 'not json');
  const report = await listAgentSessions(fx.dir);
  assert.equal(report.sessions[0].reachable, true);
  assert.equal(report.invalidFiles.length, 1);
  assert.ok(!JSON.stringify(report).includes(fx.discovery.token));
});

test('client enforces operation-specific arguments and writes PNG evidence without overwriting existing files', async (t) => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const fx = await fixture(t, (req, res) => {
    assert.equal(req.url, '/v1/pages/page1/screenshot');
    assert.equal(req.method, 'POST');
    res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  });
  await assert.rejects(agent(null, { session: fx.file, selector: 'body' }, ['pages']), /not supported/);
  await assert.rejects(agent(null, { session: fx.file }, ['screenshot']), /page-id/);
  const output = path.join(fx.dir, 'proof.png');
  const log = console.log;
  let result;
  console.log = (line) => { result = JSON.parse(line); };
  try { assert.equal(await agent(null, { session: fx.file, 'page-id': 'page1', output }, ['screenshot']), 0); }
  finally { console.log = log; }
  assert.equal(result.path, output);
  assert.deepEqual(await fs.readFile(output), png);
  await assert.rejects(agent(null, { session: fx.file, 'page-id': 'page1', output }, ['screenshot']), /EEXIST/);
});

test('agent request times out and removes reserved screenshot after invalid server output', async (t) => {
  const fx = await fixture(t, (req, res) => {
    if (req.url.endsWith('screenshot')) res.writeHead(200, { 'content-type': 'text/plain' }).end('not a png');
  });
  await assert.rejects(agentRequest(fx.discovery, '/v1/session', { timeout: 100 }), /timed out/);
  const output = path.join(fx.dir, 'bad.png');
  await assert.rejects(agent(null, { session: fx.file, 'page-id': 'page1', output }, ['screenshot']), /invalid PNG/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});
