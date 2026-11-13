// @test-kind contract: Paqvilo local runtime shutdown must not wait behind a client that stalls a request body
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import diagnosticsChannel from 'node:diagnostics_channel';
import { createSimulator } from '../server.mjs';
import { readStateFile } from '../lib/state-storage.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { personaFixture } from './fixtures/persona-catalog.mjs';
import { calledFrom } from './support/timer-origin.mjs';

async function fixture(t, options = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-runtime-shutdown-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented shutdown',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Secure.webpage.yml': 'adx_webpageid: secure\nadx_name: Secure\nadx_partialurl: secure\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<!doctype html><html><body><h1>Invented shutdown</h1></body></html>',
  };
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(dir, file), body);
  const app = await createSimulator({
    ...options,
    sourceDir: dir,
    port: 0,
    watch: false,
    projectRoot: dir,
    stateFile: path.join(dir, 'state.json'),
    initial: {
      settings: { permissionMode: 'permissive' },
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
      tables: { contact: [{ contactid: 'person', fullname: 'Invented person' }] },
      simulator: { mode: 'local', pageMode: 'local', endpoints: [], identity: { id: 'person', roles: [] } },
    },
  });
  ownedFixture(t).add(() => app.close());
  return { app, stateFile: path.join(dir, 'state.json') };
}

test('shutdown ends a request whose body stopped arriving instead of waiting for the client', async (t) => {
  const { app } = await fixture(t, { shutdownBodyIdleMs: 50 });
  const { hostname, port } = new URL(app.url);
  const socket = net.connect({ host: hostname, port: Number(port) });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const received = once(app.server, 'request'),
    closed = once(socket, 'close');
  socket.write(
    `POST /secure/ HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\n` +
      `Content-Length: 1000\r\n__RequestVerificationToken: ${app.csrf}\r\n\r\n{`,
  );
  await received;
  await app.close();
  await closed;
  assert.equal(socket.destroyed, true);
});

test('shutdown lets an accepted request with its complete body finish before close resolves', async (t) => {
  const { app, stateFile } = await fixture(t);
  let release, enter;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    entered = new Promise((resolve) => {
      enter = resolve;
    }),
    save = app.store.save.bind(app.store);
  app.store.save = async (...args) => {
    enter();
    await gate;
    return save(...args);
  };
  const request = fetch(app.url + '/__sim/api/records/contacts/person', {
    method: 'PATCH',
    headers: { 'x-sim-csrf': app.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ fullname: 'Saved during shutdown' }),
  });
  await entered;
  const closing = app.close();
  release();
  const completed = await request;
  assert.equal(completed.status, 200, await completed.text());
  await closing;
  assert.equal((await readStateFile(stateFile)).tables.contact[0].fullname, 'Saved during shutdown');
});

function readHead(socket) {
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk.toString('latin1');
      if (!text.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      resolve(text);
    };
    socket.on('data', onData);
  });
}

test('shutdown keeps draining a body the client finishes inside the idle guard', async (t) => {
  const { app } = await fixture(t, { shutdownBodyIdleMs: 60_000 });
  const { hostname, port } = new URL(app.url);
  const socket = net.connect({ host: hostname, port: Number(port) });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const received = once(app.server, 'request');
  socket.write(
    `POST /secure/ HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\n` +
      `Content-Length: 1000\r\n__RequestVerificationToken: ${app.csrf}\r\n\r\n{`,
  );
  await received;
  const closing = app.close();
  socket.write('a'.repeat(999));
  const head = await readHead(socket);
  assert.equal(socket.destroyed, false);
  assert.match(head, /^HTTP\/1\.1 \d{3}/);
  assert.doesNotMatch(head, /^HTTP\/1\.1 503/);
  await closing;
  socket.destroy();
});

test('a persona runtime ends a stalled request body at its parent runtime idle bound when the parent closes', async (t) => {
  const { app, call } = await personaFixture(t, { shutdownBodyIdleMs: 50 });
  // person-2 opens its own persona runtime (an isolated context), which the parent runtime closes with its own close.
  const { response, value: persona } = await call('/personas/launch', 'POST', { personaKey: 'person-2' });
  assert.equal(response.status, 200, JSON.stringify(persona));
  assert.equal(persona.isolated, true);
  const { hostname, port } = new URL(persona.origin);
  const socket = net.connect({ host: hostname, port: Number(port) });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  // The persona runtime's own server is not reachable from here: its request is recognised by the client port.
  const received = Promise.withResolvers();
  const started = ({ request }) => {
    if (request.socket.remotePort === socket.localPort) received.resolve();
  };
  diagnosticsChannel.subscribe('http.server.request.start', started);
  t.after(() => diagnosticsChannel.unsubscribe('http.server.request.start', started));
  socket.write(
    `POST / HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\n` +
      `Content-Length: 1000\r\n\r\n{`,
  );
  await received.promise;
  const server = new URL('../server.mjs', import.meta.url).href,
    originalSetTimeout = setTimeout,
    bounds = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (calledFrom(server, import.meta.url)) bounds.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  });
  await app.close();
  await closed;
  assert.equal(socket.destroyed, true);
  assert.ok(bounds.includes(50), 'the stalled body is guarded by the parent runtime bound');
  assert.ok(!bounds.includes(30_000), 'no request is guarded by the default bound');
});
