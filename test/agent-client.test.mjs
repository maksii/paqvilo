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
    assert.equal(req.url, '/v1/pages/1/screenshot');
    assert.equal(req.method, 'POST');
    res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  });
  await assert.rejects(agent(null, { session: fx.file, selector: 'body' }, ['pages']), /not supported/);
  await assert.rejects(agent(null, { session: fx.file }, ['screenshot']), /page-id/);
  const output = path.join(fx.dir, 'proof.png');
  const log = console.log;
  let result;
  console.log = (line) => { result = JSON.parse(line); };
  try { assert.equal(await agent(null, { session: fx.file, 'page-id': '1', output }, ['screenshot']), 0); }
  finally { console.log = log; }
  const relative = path.relative(process.cwd(), output);
  const displayPath = (path.isAbsolute(relative) ? path.basename(output) : relative).replaceAll('\\', '/');
  assert.equal(result.path, displayPath);
  assert.deepEqual(result.writesFiles,[displayPath]);
  assert.deepEqual(await fs.readFile(output), png);
  await assert.rejects(agent(null, { session: fx.file, 'page-id': '1', output }, ['screenshot']), error=>{
    const reported=/already exists: (.+)\. Existing files/.exec(error.message)?.[1];
    const relative=path.relative(process.cwd(),output);
    return error.code==='invalid_argument'&&reported===(path.isAbsolute(relative)?path.basename(output):relative).replaceAll('\\','/')&&!path.isAbsolute(reported);
  });
});

test('agent request times out and removes reserved screenshot after invalid server output', async (t) => {
  const fx = await fixture(t, (req, res) => {
    if (req.url.endsWith('screenshot')) res.writeHead(200, { 'content-type': 'text/plain' }).end('not a png');
  });
  await assert.rejects(agentRequest(fx.discovery, '/v1/session', { timeout: 100 }),error=>error.code==='request_timeout'&&error.status===504);
  const output = path.join(fx.dir, 'bad.png');
  await assert.rejects(agent(null, { session: fx.file, 'page-id': '1', output }, ['screenshot']), /invalid PNG/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('screenshot success reports catalogue-relative paths and preserves outside outputs', async t => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const fx = await fixture(t, (_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
  const config = path.join(fx.dir, 'project', 'catalogue.yml');
  for (const [output, expected] of [[path.join(fx.dir, 'project', 'evidence', 'new.png'), 'evidence/new.png'], [path.join(fx.dir, 'outside.png'), '../outside.png']]) {
    const log = console.log; let result;
    console.log = line => { result = JSON.parse(line); };
    try { await agent(null, { config, session: fx.file, 'page-id': '1', output }, ['screenshot']); }
    finally { console.log = log; }
    assert.equal(result.path, expected); assert.deepEqual(result.writesFiles, [expected]);
    assert.doesNotMatch(result.path, /[\\:]/); assert.deepEqual(await fs.readFile(output), png);
  }
});

test('agent minimum deadline leaves a fixed response margin and missing sessions have a stable code',async t=>{
  const fx=await fixture(t,(req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const value=JSON.parse(body);assert.equal(value.timeoutMs,1000);setTimeout(()=>res.writeHead(504,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'action_timeout',message:'The browser navigation timed out'}})),1050);});
  });
  await assert.rejects(agent(null,{session:fx.file,'page-id':'1',path:'/slow',timeout:'2000'},['navigate']),error=>error.code==='action_timeout'&&error.status===504);
  await assert.rejects(agent(null,{session:fx.file,'page-id':'1',path:'/slow',timeout:'150'},['navigate']),error=>error.code==='invalid_argument');
  await fs.rm(fx.file);
  await assert.rejects(agent(null,{session:fx.file},['status']),error=>error.code==='session_not_found'&&error.status===404);
});

test('agent rejects JSON scalars and arrays instead of leaking client TypeErrors',async t=>{
  let payload='null';
  const fx=await fixture(t,(_req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(payload));
  for(const body of ['null','[]','"unexpected"','false']){
    payload=body;
    await assert.rejects(agentRequest(fx.discovery,'/v1/session'),/invalid JSON: expected an object/);
  }
});
