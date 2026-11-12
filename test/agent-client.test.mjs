// @test-kind contract: agent client argument mapping, deadlines and response handling designed by Paqvilo
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import agent, { agentRequest, listAgentSessions, readDiscovery } from '../lense/commands/agent.mjs';
import { tempDir } from './fixture.mjs';

async function fixture(t, handler) {
  const dir = await tempDir('pp-agent-client-');
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const discovery = {
    schemaVersion: 1,
    id: 'fixture-session',
    token: 'secret'.repeat(8),
    endpoint: `http://127.0.0.1:${server.address().port}`,
    site: 'fixture',
    environment: 'local',
    pid: process.pid,
  };
  const file = path.join(dir, 'agents', 'fixture.json');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(discovery));
  return { dir, discovery, file };
}

// @test-kind security: the agent sends no credential to an external or credentialed endpoint
test('agent discovery rejects external/credentialed/malformed endpoints before sending credentials', async (t) => {
  let requests = 0;
  const fx = await fixture(t, (_req, res) => {
    requests++;
    res.end('{}');
  });
  assert.equal((await readDiscovery(fx.file)).id, fx.discovery.id);
  for (const endpoint of [
    'https://127.0.0.1:8080',
    'http://example.test:8080',
    'http://user@127.0.0.1:8080',
    'http://127.0.0.1:8080/path',
    'http://127.0.0.1:8080/?secret=1',
  ]) {
    await fs.writeFile(fx.file, JSON.stringify({ ...fx.discovery, endpoint }));
    await assert.rejects(readDiscovery(fx.file), /Invalid/);
  }
  assert.equal(requests, 0);
});

// @test-kind security: the agent never follows a redirect with its bearer token
test('agent never follows redirects carrying its bearer token', async (t) => {
  let redirected = false;
  const fx = await fixture(t, (req, res) => {
    if (req.url === '/v1/session') res.writeHead(302, { location: '/secret-sink' }).end();
    else {
      redirected = true;
      res.end('{}');
    }
  });
  await assert.rejects(agentRequest(fx.discovery, '/v1/session'), /Cannot reach/);
  assert.equal(redirected, false);
});

// @test-kind security: discovery never prints a token
test('session discovery probes identity, labels invalid files, and never prints tokens', async (t) => {
  const authorizations = [];
  const fx = await fixture(t, (req, res) => {
    authorizations.push(req.headers.authorization);
    res.end(JSON.stringify({ schemaVersion: 1, id: 'fixture-session' }));
  });
  await fs.writeFile(path.join(fx.dir, 'agents', 'bad.json'), 'not json');
  const report = await listAgentSessions(fx.dir);
  assert.deepEqual(authorizations, [`Bearer ${'secret'.repeat(8)}`]);
  assert.deepEqual(
    report.sessions.map((session) => [session.id, session.reachable]),
    [['fixture-session', true]],
  );
  assert.equal(report.invalidFiles.length, 1);
  assert.match(JSON.stringify(report.invalidFiles[0]), /bad\.json/);
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
  console.log = (line) => {
    result = JSON.parse(line);
  };
  try {
    assert.equal(await agent(null, { session: fx.file, 'page-id': '1', output }, ['screenshot']), 0);
  } finally {
    console.log = log;
  }
  const relative = path.relative(process.cwd(), output);
  const displayPath = (path.isAbsolute(relative) ? path.basename(output) : relative).replaceAll('\\', '/');
  assert.equal(result.path, displayPath);
  assert.deepEqual(result.writesFiles, [displayPath]);
  assert.deepEqual(await fs.readFile(output), png);
  await assert.rejects(agent(null, { session: fx.file, 'page-id': '1', output }, ['screenshot']), (error) => {
    const reported = /already exists: (.+)\. Existing files/.exec(error.message)?.[1];
    const relative = path.relative(process.cwd(), output);
    return (
      error.code === 'invalid_argument' &&
      reported === (path.isAbsolute(relative) ? path.basename(output) : relative).replaceAll('\\', '/') &&
      !path.isAbsolute(reported)
    );
  });
});

test('agent request times out and removes reserved screenshot after invalid server output', async (t) => {
  const fx = await fixture(t, (req, res) => {
    if (req.url.endsWith('screenshot')) res.writeHead(200, { 'content-type': 'text/plain' }).end('not a png');
  });
  await assert.rejects(
    agentRequest(fx.discovery, '/v1/session', { timeout: 100 }),
    (error) => error.code === 'request_timeout' && error.status === 504,
  );
  const output = path.join(fx.dir, 'bad.png');
  await assert.rejects(agent(null, { session: fx.file, 'page-id': '1', output }, ['screenshot']), /invalid PNG/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('screenshot success reports catalogue-relative paths and preserves outside outputs', async (t) => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const fx = await fixture(t, (_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
  const config = path.join(fx.dir, 'project', 'catalogue.yml');
  for (const [output, expected] of [
    [path.join(fx.dir, 'project', 'evidence', 'new.png'), 'evidence/new.png'],
    [path.join(fx.dir, 'outside.png'), '../outside.png'],
  ]) {
    const log = console.log;
    let result;
    console.log = (line) => {
      result = JSON.parse(line);
    };
    try {
      await agent(null, { config, session: fx.file, 'page-id': '1', output }, ['screenshot']);
    } finally {
      console.log = log;
    }
    assert.equal(result.path, expected);
    assert.deepEqual(result.writesFiles, [expected]);
    assert.doesNotMatch(result.path, /[\\:]/);
    assert.deepEqual(await fs.readFile(output), png);
  }
});

test('agent minimum deadline leaves a fixed response margin and missing sessions have a stable code', async (t) => {
  const bodies = [];
  const fx = await fixture(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      // The server answers at once: the mapping under test is the timeoutMs the client sends, not elapsed time.
      res
        .writeHead(504, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: 'action_timeout', message: 'The browser navigation timed out' } }));
    });
  });
  const navigate = (timeout) => agent(null, { session: fx.file, 'page-id': '1', path: '/slow', timeout }, ['navigate']);
  const actionTimeout = (error) => error.code === 'action_timeout' && error.status === 504;
  // --timeout 2000 is the minimum: the server's action deadline is a fixed 1000 ms below the client's own.
  await assert.rejects(navigate('2000'), actionTimeout);
  assert.deepEqual(
    bodies.map((value) => value.timeoutMs),
    [1000],
  );
  await assert.rejects(navigate('10000'), actionTimeout);
  assert.deepEqual(
    bodies.map((value) => value.timeoutMs),
    [1000, 9000],
  );
  // Below the minimum the CLI refuses the argument before any request is sent.
  await assert.rejects(navigate('150'), (error) => error.code === 'invalid_argument');
  assert.equal(bodies.length, 2, 'a refused --timeout never reaches the server');
  // The printed result of the CLI keeps the exit status and the action_timeout code.
  const { code, output } = await runAgentNavigate(fx.file, ['--timeout', '120000']);
  const printed = JSON.parse(output);
  assert.equal(code, 1);
  assert.equal(printed.error.code, 'action_timeout');
  assert.equal(printed.error.status, 504);
  assert.equal(bodies.length, 3);
  await fs.rm(fx.file);
  await assert.rejects(
    agent(null, { session: fx.file }, ['status']),
    (error) => error.code === 'session_not_found' && error.status === 404,
  );
});

test('agent rejects JSON scalars and arrays instead of leaking client TypeErrors', async (t) => {
  let payload = 'null';
  const fx = await fixture(t, (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(payload));
  for (const body of ['null', '[]', '"unexpected"', 'false']) {
    payload = body;
    await assert.rejects(agentRequest(fx.discovery, '/v1/session'), /invalid JSON: expected an object/);
  }
});

// A loopback server for a session; the handler decides whether it ever answers.
async function loopbackServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('agent sessions bounds each probe by --timeout: a silent session is unreachable, an answering one reachable', async (t) => {
  const root = await tempDir('pp-agent-sessions-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const silent = await loopbackServer(t, () => {});
  const answering = await loopbackServer(t, (_req, res) =>
    res.end(JSON.stringify({ schemaVersion: 1, id: 'answering-session' })),
  );
  const agents = path.join(root, '.paqvilo', 'agents');
  await fs.mkdir(agents, { recursive: true });
  for (const [id, endpoint] of [
    ['silent-session', silent],
    ['answering-session', answering],
  ]) {
    const discovery = {
      schemaVersion: 1,
      id,
      token: 'secret'.repeat(8),
      endpoint,
      site: 'fixture',
      environment: 'local',
      pid: process.pid,
    };
    await fs.writeFile(path.join(agents, `${id}.json`), JSON.stringify(discovery));
  }
  const config = path.join(root, 'paqvilo.config.yml');
  const log = console.log;
  let report;
  console.log = (line) => {
    report = JSON.parse(line);
  };
  try {
    assert.equal(await agent(null, { config, timeout: '2000' }, ['sessions']), 0);
  } finally {
    console.log = log;
  }
  assert.deepEqual(Object.fromEntries(report.sessions.map((session) => [session.id, session.reachable])), {
    'silent-session': false,
    'answering-session': true,
  });
  await assert.rejects(
    agent(null, { config, timeout: '150' }, ['sessions']),
    (error) =>
      error.code === 'invalid_argument' && /--timeout must be an integer between 2000 and 120000/.test(error.message),
  );
});

// Runs the real CLI against the fixture session, as a person would, and returns its exit code and printed output.
function runAgentNavigate(file, extraArgs) {
  const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
  const args = [cli, 'agent', 'navigate', '--session', file, '--page-id', '1', '--path', '/never', ...extraArgs];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('agent CLI sends its --timeout minus one second as the browser deadline and prints the server action_timeout', async (t) => {
  const requests = [];
  const fx = await fixture(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res
        .writeHead(504, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code: 'action_timeout', message: 'The browser navigation timed out' } }));
    });
  });
  const { code, output } = await runAgentNavigate(fx.file, ['--timeout', '10000']);
  assert.deepEqual(requests, [{ url: '/v1/pages/1/navigate', body: { url: '/never', timeoutMs: 9000 } }]);
  const printed = JSON.parse(output);
  assert.equal(code, 1);
  assert.equal(printed.action, 'navigate');
  assert.equal(printed.error.code, 'action_timeout');
  assert.equal(printed.error.status, 504);
});

test('agent CLI reports request_timeout after its own abort when the server never answers', async (t) => {
  const requests = [];
  // The server holds every response, so the only outcome is the client's own abort at --timeout.
  const fx = await fixture(t, (req) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => requests.push({ url: req.url, body: JSON.parse(body) }));
  });
  const { code, output } = await runAgentNavigate(fx.file, ['--timeout', '2000']);
  assert.deepEqual(requests, [{ url: '/v1/pages/1/navigate', body: { url: '/never', timeoutMs: 1000 } }]);
  const printed = JSON.parse(output);
  assert.equal(code, 1);
  assert.equal(printed.error.code, 'request_timeout');
  assert.equal(printed.error.status, 504);
});
