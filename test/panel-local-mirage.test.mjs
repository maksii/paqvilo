// @test-kind contract: Paqvilo's own panel data marks a Lense target served by the site's own local Mirage, so Local/Online is not offered there
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { enablePanel, servedByLocalMirage } from '../lense/panel.mjs';
import { compareWebFile, withoutSourceMapComments } from '../lense/online.mjs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { createFixture, SITE } from './fixture.mjs';
import { fakeBrowser } from './fake-browser.mjs';

const fx = createFixture();
const panels = [];
after(() => {
  panels.forEach((panel) => panel.dispose());
  fx.cleanup();
});

test("lense dev against the loopback port of the site's own Mirage is a local Mirage; other targets are not", () => {
  const target = (origin, port) => ({ origin, mirageConfig: port === undefined ? null : { port } });
  // `lense dev --site demo-portal --env local` where the catalogue gives the site's Mirage port 8787.
  assert.equal(servedByLocalMirage(target('http://127.0.0.1:8787', 8787)), true);
  assert.equal(servedByLocalMirage(target('http://localhost:8787', 8787)), true);
  assert.equal(servedByLocalMirage(target('http://[::1]:8787', 8787)), true);
  // `mirage dev` itself.
  assert.equal(servedByLocalMirage({ mirage: true, origin: 'http://127.0.0.1:1' }), true);
  // Another loopback server, a remote environment on the same port.
  assert.equal(servedByLocalMirage(target('http://127.0.0.1:8788', 8787)), false);
  assert.equal(servedByLocalMirage(target('https://portal.example.com:8787', 8787)), false);
  // A site without a Mirage port runs its Mirage on the default port 8787 (lense/commands/mirage.mjs DEFAULT_PORT).
  assert.equal(servedByLocalMirage(target('http://127.0.0.1:8787')), true, 'the default Mirage port counts');
  assert.equal(servedByLocalMirage({ origin: 'http://localhost:8787', mirageConfig: {} }), true);
  assert.equal(servedByLocalMirage(target('http://127.0.0.1:8788')), false);
  assert.equal(servedByLocalMirage(target('http://127.0.0.1', 80)), true, 'the default port counts');
  assert.equal(servedByLocalMirage(target('not a url', 8787)), false);
});

/** A dev loop with one tab, and a way to call its panel API as the page does. */
async function setup(origin, online = {}) {
  const b = fakeBrowser(online);
  const tab = b.openTab(`${origin}/`);
  const session = new OverlaySession({
    origin,
    sourceDir: fx.dir,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'invented',
    envName: 'local',
  });
  const panel = enablePanel(b.context, session, { open: async () => null });
  panels.push(panel);
  await panel.ready;
  await interceptOrigin(b.context, origin, session.route);
  const { token } = panel.stateFor(tab.page);
  // The answer is sent through the tab's DevTools session: wait for that send.
  const send = tab.cdp.send;
  const waiting = new Map();
  tab.cdp.send = async (method, params) => {
    const result = await send(method, params);
    if (method.startsWith('Fetch.')) waiting.get(params?.requestId)?.();
    return result;
  };
  let n = 0;
  const call = async (name, body) => {
    const id = `api${++n}`;
    const answered = new Promise((resolve) => waiting.set(id, resolve));
    tab.pause(id, `${origin}/__paqvilo/api/${name}`, {
      type: 'Fetch',
      method: 'POST',
      headers: { 'x-paqvilo-token': token },
      postData: JSON.stringify(body ?? {}),
    });
    await answered;
    const [answer] = b.answers(id);
    return JSON.parse(Buffer.from(answer.body, 'base64').toString());
  };
  return { tab, session, panel, call };
}

test('in front of the site’s local Mirage the panel says so and the mode API refuses Online, not Local', async () => {
  const { tab, session, panel, call } = await setup('http://127.0.0.1:8787');
  assert.equal(panel.stateFor(tab.page).localSimulation, true, 'the panel data carries localSimulation');
  const refused = await call('mode', { online: true });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /local Mirage serves your sources here/);
  assert.equal(session.bypass, false, 'nothing switched');
  // Started with --no-overrides: turning the overrides back on is still possible.
  session.bypass = true;
  assert.deepEqual(await call('mode', { online: false }), { ok: true });
  assert.equal(session.bypass, false);
});

test('a remote environment offers both modes', async () => {
  const { tab, panel, call } = await setup('https://portal.example.com');
  assert.equal(panel.stateFor(tab.page).localSimulation, false);
  assert.deepEqual(await call('mode', { online: true }), { ok: true });
  assert.equal(panel.stateFor(tab.page).online, true);
});

test('the Mirage tab is remembered like every other tab, so a navigation keeps it', async () => {
  const { tab, panel, call } = await setup('https://portal.example.com');
  for (const tabName of ['mirage', 'tweaks', 'runtime']) {
    assert.deepEqual(await call('ui', { tab: tabName, open: true }), { ok: true });
    assert.equal(panel.stateFor(tab.page).ui.tab, tabName, tabName);
  }
});

// @test-kind contract: a served copy that differs from the local file only by a source-map comment is the same file
test('a source-map comment in the served copy is no difference, in the differs flag and in the comparison', async (t) => {
  assert.equal(withoutSourceMapComments('a{}\n/*# sourceMappingURL=a.css.map */\n'), 'a{}\n');
  assert.equal(withoutSourceMapComments('x();\n//# sourceMappingURL=x.js.map'), 'x();');
  const prose = 'x(); // sourceMappingURL is mentioned here';
  assert.equal(withoutSourceMapComments(prose), prose);
  // The differs flag of Overrides: the served copy carries the comment the local file has not.
  const server = http.createServer((request, response) =>
    response
      .writeHead(200, { 'content-type': 'text/javascript' })
      .end(
        request.url === '/changed.js'
          ? 'console.log("other");\n'
          : 'console.log("app");\n//# sourceMappingURL=app.js.map\n',
      ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const served = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(fx.dir, 'web-files/app.js');
  assert.equal((await compareWebFile(served, { url: '/app.js', file })).state, 'same');
  assert.equal((await compareWebFile(served, { url: '/changed.js', file })).state, 'different');
  // The comparison view: no changed line, and the copy is called what it is: "served" in front of a local Mirage.
  const origin = 'http://127.0.0.1:8787';
  const { call } = await setup(origin, {
    [`${origin}/scripts/app.js`]: { body: 'console.log("app");\n/*# sourceMappingURL=app.js.map */\n' },
  });
  const diff = await call('diff', { rel: 'web-files/app.js', url: '/scripts/app.js' });
  assert.equal(diff.ok, true);
  assert.equal(diff.against, 'served');
  assert.deepEqual(diff.lines, []);
});

// @test-kind contract: the footer counts what is laid over the site, so a paused web file leaves the count
test('pausing a web file override takes it out of the footer count, and resuming puts it back', async () => {
  const { tab, panel, call } = await setup('https://portal.example.com');
  const before = panel.stateFor(tab.page).stats.webFiles;
  assert.ok(before > 0);
  assert.deepEqual(await call('toggle', { rel: 'web-files/app.js', off: true }), { ok: true });
  assert.equal(panel.stateFor(tab.page).stats.webFiles, before - 1);
  assert.deepEqual(await call('toggle', { rel: 'web-files/app.js', off: false }), { ok: true });
  assert.equal(panel.stateFor(tab.page).stats.webFiles, before);
});
