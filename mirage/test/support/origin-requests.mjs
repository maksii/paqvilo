// Fixture folders, simulators and raw HTTP requests for the suites that drive the origin gates and listeners.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../../testing/owned-fixture.mjs';

// Creates an empty temporary directory named from prefix, removed after t. Resolves to its path.
export async function makeFixtureDirectory(t, prefix) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Writes each file of files (relative path to body) under dir, creating the folders it needs.
export async function writeFixtureFiles(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
}

// The initial state of a local simulator with no tables, permissions or endpoints.
export function emptyLocalState() {
  return {
    version: 1,
    mappings: {},
    tables: {},
    permissions: [],
    simulator: {
      mode: 'local',
      pageMode: 'local',
      permissionSource: 'configured',
      live: { allowWrites: false },
      endpoints: [],
    },
  };
}

// Starts a local simulator on dir with the initial state, closed after t. Resolves to the simulator.
export async function startLocalSimulator(t, dir, initial) {
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    port: 0,
    watch: false,
    initial,
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

// Starts a dry-run simulator on the solution folder under root with the given config, closed after t.
export async function startDryRunSimulator(t, root, config) {
  const sim = await createSimulator({
    ...config,
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

// Raw requests keep the exact Host, Origin and Sec-Fetch-* headers a case names; fetch adds or drops some of them.
// An event stream never ends: its answer is taken as soon as its status and headers arrive, with an empty body, then
// the connection is dropped. Every other answer is read to its end. A JSON body is sent with its content type.
export function send(origin, { method = 'GET', target = '/', headers = {}, body = undefined } = {}) {
  const url = new URL(origin);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const sent = payload === undefined ? headers : { 'content-type': 'application/json', ...headers };
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, method, path: target, headers: sent },
      (response) => {
        const contentType = response.headers['content-type'] ?? '';
        const chunks = [];
        const finish = (text) => {
          const json = /json/.test(contentType) && text ? JSON.parse(text) : null;
          resolve({ status: response.statusCode, headers: response.headers, text, json });
          request.destroy();
        };
        if (/event-stream/.test(contentType)) {
          finish('');
          return;
        }
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}
