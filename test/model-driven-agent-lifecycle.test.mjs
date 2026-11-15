// @test-kind contract: the model-driven agent API belongs to one target origin for the life of its identity, and a sign-in redirect only detaches its inspector state.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { startAgentServer } from '../lense/agent-server.mjs';
import { modelDrivenTargetSessions } from '../lense/model-driven-targets.mjs';
import { readDiscovery } from '../lense/commands/agent.mjs';
import { cleanupModelDrivenSession, closeModelDrivenResources, closeStartup } from '../lense/commands/model-driven.mjs';
import * as modelDrivenCommand from '../lense/commands/model-driven.mjs';
import { tempDirSync } from './fixture.mjs';
import { captureConsoleOutput, openLatch } from './helpers/mirage-session-doubles.mjs';

const targets = [
  {
    id: 'target',
    origin: 'http://127.0.0.1:9101',
    startPath: '/main.aspx',
    siteName: 'invented-site',
    envName: 'alpha',
  },
  { id: 'other', origin: 'http://127.0.0.1:9103', startPath: '/main.aspx', siteName: 'other-site', envName: 'beta' },
];
const [target, other] = targets;
const signIn = 'http://127.0.0.1:9102/signin?flow=invented';
const imported = {
  assets: new Map([['x.js', { name: 'x.js', data: Buffer.from('1'), mime: 'text/javascript' }]]),
  resources: [{ name: 'x.js' }],
  diagnostics: [],
};

async function startLifecycle(t) {
  const stateDir = tempDirSync('model-driven-agent-lifecycle-');
  ownedFixture(t).remove(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let address = `${target.origin}${target.startPath}`;
  const frame = { url: () => address };
  const page = Object.assign(new EventEmitter(), {
    url: () => address,
    isClosed: () => false,
    mainFrame: () => frame,
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const browser = {
    closed: false,
    close: async () => {
      browser.closed = true;
    },
  };
  let resolveStop;
  const stopped = new Promise((resolve) => {
    resolveStop = resolve;
  });
  const agents = [];
  // The owning command opens one agent per target it activates.
  const openAgent = async (item) => {
    const session = Object.assign(new EventEmitter(), {
      cfg: {
        stateDir,
        origin: item.origin,
        siteName: item.siteName,
        envName: item.envName,
        sourceDir: stateDir,
        agent: { enabled: true },
      },
      rel: String,
    });
    const agent = await startAgentServer({
      session,
      context,
      stop: () => resolveStop(),
      runtime: { watching: true, debugPort: null },
      options: { deferred: true, ownsPage: (candidate) => candidate === page },
    });
    agents.push(agent);
    return agent;
  };
  ownedFixture(t).add(async () => {
    for (const agent of agents) await agent.close();
  });
  const counts = { closes: 0 };
  const sessions = modelDrivenTargetSessions({
    targets,
    initial: target,
    imported,
    mappings: new Map(targets.map((item) => [item.id, []])),
    openAgent,
    createInspector: async (active) => ({
      refresh() {},
      persistentState: () => ({}),
      close: async () => {
        counts.closes++;
      },
      agentState: {
        origin: active.target.origin,
        sessionState: () => ({
          kind: 'model-driven',
          overlay: { revision: 1 },
          inspection: { context: null, observedAt: null, pending: false },
        }),
        pageState: () => ({ kind: 'model-driven', overlay: { revision: 1 } }),
      },
    }),
  });
  const navigate = (url) => {
    address = url;
    page.emit('framenavigated', frame);
  };
  return { agents, browser, context, counts, frame, navigate, page, sessions, stopped };
}

const request = (endpoint, token, route, body) =>
  fetch(endpoint + route, {
    redirect: 'error',
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (endpoint, token, route) => (await request(endpoint, token, route)).json();
// A refused connection (closed server) and an unauthorised answer both count as refused.
const refused = (endpoint, token) =>
  request(endpoint, token, '/v1/session').then(
    (response) => response.status !== 200,
    () => true,
  );

test('a sign-in redirect suspends the agent API while its discovery id, token and file stay the same', async (t) => {
  const fx = await startLifecycle(t);
  const { sessions } = fx;

  await sessions.activate(target.origin);
  const agent = fx.agents[0];
  const printedFile = agent.discoveryFile;
  const discovery = await readDiscovery(printedFile);
  const session = () => json(agent.endpoint, discovery.token, '/v1/session');
  const attached = await session();
  assert.equal(attached.id, discovery.id);
  assert.equal(attached.inspection.suspended, false);
  assert.equal(attached.pages.length, 1);

  // The owner's onNavigation handler reacts to the owned tab leaving the target origin.
  fx.navigate(signIn);
  await sessions.suspend();
  assert.equal(fx.counts.closes, 1, 'the inspector is retired');
  assert.equal(fs.existsSync(printedFile), true, 'the printed discovery file survives the redirect');
  const suspended = await session();
  assert.equal(suspended.inspection.suspended, true);
  assert.equal(suspended.inspection.reason, 'non-target-origin');
  assert.deepEqual(suspended.pages, []);
  assert.equal(suspended.access.externalTabCount, 1);
  const needsInspector = await request(agent.endpoint, discovery.token, '/v1/pages/1/state');
  assert.equal(needsInspector.status, 409);
  assert.equal((await needsInspector.json()).error.code, 'session_suspended');
  assert.equal((await request(agent.endpoint, discovery.token, '/v1/pages/1/dom', {})).status, 409);
  assert.equal((await request(agent.endpoint, discovery.token, '/v1/pages/1/navigate', { url: '/next' })).status, 409);

  fx.navigate(`${target.origin}${target.startPath}`);
  await sessions.activate(target.origin);
  const resumed = await session();
  assert.equal(resumed.id, discovery.id, 'resuming keeps the discovery id');
  assert.equal(resumed.inspection.suspended, false);
  assert.equal(resumed.pages.length, 1);
  assert.equal((await request(agent.endpoint, discovery.token, '/v1/pages/1/state')).status, 200);
  const resumedDiscovery = await readDiscovery(printedFile);
  assert.equal(resumedDiscovery.id, discovery.id);
  assert.equal(resumedDiscovery.token, discovery.token);

  fx.navigate(signIn);
  await sessions.suspend();
  assert.equal((await request(agent.endpoint, discovery.token, '/v1/stop', {})).status, 200);
  await fx.stopped;
  // The command releases its owned resources in this order when stop resolves: targets (which close the agent), then the browser.
  await sessions.close();
  await fx.browser.close();
  assert.equal(fx.browser.closed, true);
  assert.equal(fs.existsSync(printedFile), false, 'stop removes the discovery file');
});

test('a return to the target origin records page-entered-origin and lists the document request, never page-left-origin', async (t) => {
  const fx = await startLifecycle(t);
  const { sessions, page, frame } = fx;
  const documentUrl = `${target.origin}${target.startPath}`;

  await sessions.activate(target.origin);
  const agent = fx.agents[0];
  const discovery = await readDiscovery(agent.discoveryFile);
  fx.navigate(signIn);
  await sessions.suspend();
  const mark = (await json(agent.endpoint, discovery.token, '/v1/events')).latestSequence;

  // The owned tab's document request reaches the server before the inspector can reattach.
  page.emit('request', {
    isNavigationRequest: () => true,
    frame: () => frame,
    url: () => documentUrl,
    method: () => 'GET',
    resourceType: () => 'document',
  });
  fx.navigate(documentUrl);
  const returned = (await json(agent.endpoint, discovery.token, `/v1/events?after=${mark}`)).events;
  assert.deepEqual(
    returned.map((event) => event.type),
    ['request', 'page-entered-origin'],
    'the return is one request and one entered-origin event',
  );
  assert.equal(returned[0].documentId, returned[1].documentId);
  assert.equal(returned[1].url, documentUrl);

  await sessions.activate(target.origin);
  const later = (await json(agent.endpoint, discovery.token, `/v1/events?after=${mark}`)).events.map(
    (event) => event.type,
  );
  assert.equal(later.includes('page-left-origin'), false, 'a page back on the target is never reported as left');
  assert.equal(later.includes('navigation'), false, 'the return is not also reported as an ordinary navigation');
});

// @test-kind security: a switch to another target origin must retire the old agent identity so its token and file stop working.
test('a switch through a sign-in page retires the old agent identity and opens a new one for the other origin', async (t) => {
  const fx = await startLifecycle(t);
  const { sessions } = fx;

  await sessions.activate(target.origin);
  const old = fx.agents[0];
  const oldFile = old.discoveryFile;
  const oldDiscovery = await readDiscovery(oldFile);
  assert.equal((await json(old.endpoint, oldDiscovery.token, '/v1/session')).session.portalOrigin, target.origin);

  fx.navigate(signIn);
  await sessions.suspend();
  fx.navigate(`${other.origin}${other.startPath}`);
  await sessions.activate(other.origin);

  assert.equal(fx.agents.length, 2, 'the other origin gets its own agent identity');
  assert.equal(fs.existsSync(oldFile), false, 'the retired agent removes its discovery file');
  assert.equal(await refused(oldDiscovery.endpoint, oldDiscovery.token), true, 'the old token is refused');

  const next = fx.agents[1];
  const nextDiscovery = await readDiscovery(next.discoveryFile);
  assert.equal(fs.existsSync(next.discoveryFile), true, 'the new discovery path is printed and exists');
  assert.notEqual(nextDiscovery.id, oldDiscovery.id, 'a new identity has a new id');
  assert.notEqual(nextDiscovery.token, oldDiscovery.token, 'a new identity has a new token');
  assert.equal(nextDiscovery.portalOrigin, other.origin);
  assert.equal(nextDiscovery.site, other.siteName);
  assert.equal(nextDiscovery.environment, other.envName);
  assert.equal(await refused(next.endpoint, oldDiscovery.token), true, 'the old token is refused by the new identity');
  assert.equal((await json(next.endpoint, nextDiscovery.token, '/v1/session')).inspection.suspended, false);

  await sessions.close();
  assert.equal(fs.existsSync(next.discoveryFile), false, 'closing the session removes the current discovery file');
});

// @test-kind security: returning to the same target origin must keep the agent identity, token and discovery file unchanged.
test('leaving the target for a sign-in page and returning keeps the same agent identity and token', async (t) => {
  const fx = await startLifecycle(t);
  const { sessions } = fx;

  await sessions.activate(target.origin);
  const before = await readDiscovery(fx.agents[0].discoveryFile);
  fx.navigate(signIn);
  await sessions.suspend();
  fx.navigate(`${target.origin}${target.startPath}`);
  await sessions.activate(target.origin);

  assert.equal(fx.agents.length, 1, 'the same target origin does not open another agent');
  const after = await readDiscovery(fx.agents[0].discoveryFile);
  assert.equal(after.id, before.id);
  assert.equal(after.token, before.token);
  assert.equal(after.endpoint, before.endpoint);
  assert.equal((await json(after.endpoint, before.token, '/v1/session')).inspection.suspended, false);
});

test('an agent refuses an inspector state for another origin', async (t) => {
  const fx = await startLifecycle(t);
  await fx.sessions.activate(target.origin);
  const agent = fx.agents[0];
  assert.throws(
    () => agent.setInspector({ origin: other.origin, sessionState: () => ({}), pageState: () => ({}) }),
    /one target origin/,
  );
  await fx.sessions.close();
});

// The departure notice reads the tab's URL and the lines it prints; the target and sign-in origins are the fakes above.
function departureNotice(lines) {
  return modelDrivenCommand.createTargetDepartureNotice({
    origin: target.origin,
    targetOrigins: targets.map((item) => item.origin),
    log: (line) => lines.push(line),
  });
}

test('leaving the target for a sign-in page prints one waiting line with the host only', () => {
  const lines = [];
  const notice = departureNotice(lines);
  notice.observe(new URL(`${signIn}&code=secret&state=x#frag`));
  assert.deepEqual(lines, [
    `waiting: the app tab left ${target.origin} for 127.0.0.1 (sign-in or redirect); local overlays resume when it returns`,
  ]);
  for (const secret of ['code', 'secret', 'state', 'frag', '?']) assert.equal(lines[0].includes(secret), false);
});

test('further identity-provider hops while away print nothing', () => {
  const lines = [];
  const notice = departureNotice(lines);
  notice.observe(new URL(signIn));
  notice.observe(new URL('http://localhost:9104/authorize?state=x'));
  notice.observe(new URL('https://localhost:9105/callback?code=secret'));
  assert.equal(lines.length, 1);
});

test('returning to the target origin prints one resumed line, and a second departure prints a new waiting line', () => {
  const lines = [];
  const notice = departureNotice(lines);
  notice.observe(new URL(signIn));
  notice.observe(new URL(`${target.origin}${target.startPath}`));
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `resumed on ${target.origin}`);
  notice.observe(new URL(signIn));
  assert.equal(lines.length, 3);
  assert.match(
    lines[2],
    /^waiting: the app tab left http:\/\/127\.0\.0\.1:9101 for 127\.0\.0\.1 \(sign-in or redirect\)/,
  );
});

test('a departure to a non-http page names another page instead of an address', () => {
  const lines = [];
  departureNotice(lines).observe(new URL('about:blank'));
  assert.deepEqual(lines, [
    `waiting: the app tab left ${target.origin} for another page (sign-in or redirect); local overlays resume when it returns`,
  ]);
});

test('a repeated stop signal while model-driven resources close is absorbed until the close settles', async () => {
  const noop = () => {};
  process.on('SIGINT', noop);
  process.on('SIGTERM', noop);
  const { output, restore } = captureConsoleOutput();
  const agentsClosing = openLatch();
  const agentsReleased = openLatch();
  let agentCloses = 0;
  try {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const errors = [];
    const steps = [
      async () => {},
      async () => {
        agentCloses++;
        agentsClosing.open();
        await agentsReleased.promise;
      },
      async () => {},
    ];
    const run = closeModelDrivenResources(steps, (error) => errors.push(error));
    await agentsClosing.promise;
    process.emit('SIGINT');
    process.emit('SIGTERM');
    assert.ok(process.listenerCount('SIGINT') > before, 'the close must keep a SIGINT listener while it is pending');
    assert.equal(agentCloses, 1);
    agentsReleased.open();
    assert.deepEqual(await run, []);
    assert.deepEqual(errors, []);
    assert.equal(agentCloses, 1);
    assert.deepEqual(output.errors, ['stopping…']);
    assert.equal(process.listenerCount('SIGINT'), before);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  } finally {
    agentsReleased.open();
    restore();
    process.off('SIGINT', noop);
    process.off('SIGTERM', noop);
  }
});

test('a repeated stop signal while a startup-timed-out model-driven session closes is absorbed until the browser closes', async () => {
  const noop = () => {};
  process.on('SIGINT', noop);
  process.on('SIGTERM', noop);
  const { output, restore } = captureConsoleOutput();
  const browserClosing = openLatch();
  const browserReleased = openLatch();
  const calls = [];
  const errors = [];
  let pageClosed = false;
  try {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const run = cleanupModelDrivenSession(
      {
        startupTimedOut: true,
        page: {
          isClosed: () => pageClosed,
          close: async () => {
            calls.push('page');
            pageClosed = true;
          },
        },
        attached: false,
        targetSessions: {
          close: async () => {
            calls.push('agents');
          },
        },
        close: async () => {
          calls.push('browser');
          browserClosing.open();
          await browserReleased.promise;
        },
      },
      (error) => errors.push(error),
    );
    await browserClosing.promise;
    process.emit('SIGINT');
    process.emit('SIGTERM');
    assert.ok(process.listenerCount('SIGINT') > before, 'the close must keep a SIGINT listener while it is pending');
    browserReleased.open();
    assert.deepEqual(await run, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, ['page', 'agents', 'browser']);
    assert.deepEqual(output.errors, ['stopping…']);
    assert.equal(process.listenerCount('SIGINT'), before);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  } finally {
    browserReleased.open();
    restore();
    process.off('SIGINT', noop);
    process.off('SIGTERM', noop);
  }
});

test('a start-up closes its deadline and progress only after late work has settled', async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const deadline = {
    settled: () => {
      events.push('settled-asked');
      return gate;
    },
    close: () => events.push('deadline-closed'),
  };
  const progress = { close: () => events.push('progress-closed') };
  const closing = closeStartup(deadline, progress);
  assert.deepEqual(events, ['settled-asked']);
  release();
  await closing;
  assert.deepEqual(events, ['settled-asked', 'deadline-closed', 'progress-closed']);
});

test('a command without a start-up deadline closes nothing and does not throw', async () => {
  assert.equal(await closeStartup(null, null), undefined);
});
