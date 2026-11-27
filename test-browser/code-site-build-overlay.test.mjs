// @test-kind unproven: the Lense line merge of a local landing page over the document a deployed code site serves, with a Mirage code site standing in for the hosted one (Mirage serves it as hosted session F5 captured, captures code-site-serve-a..d); the merge itself is a local model
// Lense in front of a deployed code site, with a different local build: the build's files answer their addresses, and
// on a client route the local landing page is laid over the deployed one the portal served, keeping what the portal
// added (its client context, isSpaSite included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createSimulator } from '../mirage/server.mjs';
import { proxiedOverlay } from './helpers/proxied-overlay.mjs';
import { watchSources } from '../lense/commands/dev.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/code-site/.powerpages-site/', import.meta.url));
const CONFIG = JSON.stringify({
  siteName: 'Invented code site',
  compiledPath: 'dist',
  defaultLandingPage: 'index.html',
});
const DEPLOYED_ENTRY = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '<title>Compiled app</title>',
  '<script src="/app.js"></script>',
  '</head>',
  '<body>',
  '<main>Compiled app</main>',
  '</body>',
  '</html>',
  '',
].join('\n');
const LOCAL_ENTRY = DEPLOYED_ENTRY.replace(
  '<main>Compiled app</main>\n',
  '<main>Compiled app</main>\n<p id="local-build">Local build</p>\n',
);

/** A code-site project: the export (with the deployed landing page as its web file when `exported`) and a build. */
function project(root, { entry, app, exported }) {
  const site = path.join(root, '.powerpages-site');
  fs.cpSync(FIXTURE, site, { recursive: true });
  fs.writeFileSync(path.join(root, 'powerpages.config.json'), CONFIG);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), entry);
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), app);
  if (exported) {
    const folder = path.join(site, 'web-files', 'index.html');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'index.html'), DEPLOYED_ENTRY);
    fs.writeFileSync(
      path.join(folder, 'index.html.webfile.yml'),
      [
        'annotationid: 5c0de51e-0000-4000-8000-000000000072',
        'filename: index.html',
        'id: 5c0de51e-0000-4000-8000-000000000070',
        'mimetype: text/html',
        'name: index.html',
        'objectid: 5c0de51e-0000-4000-8000-000000000070',
        'objecttypecode: adx_webfile',
        'parentpageid: 5c0de51e-0000-4000-8000-000000000010',
        'partialurl: index.html',
        'publishingstateid: 5c0de51e-0000-4000-8000-000000000006',
        '',
      ].join('\n'),
    );
  }
  return site;
}

/** A loopback "portal": every request is answered by a Mirage code site serving the deployed build. */
async function deployedPortal(t, work) {
  const deployed = path.join(work, 'deployed');
  project(deployed, { entry: DEPLOYED_ENTRY, app: 'window.syntheticApp = "deployed build";', exported: true });
  const app = await createSimulator({ sourceDir: deployed, watch: false, requirePortalSource: true });
  t.after(() => app.close());
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      requests.push(new URL(request.url, 'http://127.0.0.1').pathname);
      const upstream = await fetch(app.url + request.url, { redirect: 'manual' });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502).end('loopback deployed code site failed');
    }
  });
  return { server, requests };
}

test('a local build answers its files and its landing page is laid over the deployed one on a client route', async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-build-overlay-')));
  const { server, requests } = await deployedPortal(t, work);
  const site = project(path.join(work, 'local'), {
    entry: LOCAL_ENTRY,
    app: 'window.syntheticApp = "local build";',
    exported: true,
  });
  const { origin, page, faults } = await proxiedOverlay(t, server, {
    work,
    session: { sourceDir: site, siteName: 'code-site-test' },
  });
  const response = await page.goto(origin + '/reports/calendar/', { waitUntil: 'load' });
  assert.equal(response.status(), 200);
  assert.equal(await page.locator('#local-build').textContent(), 'Local build');
  assert.equal(await page.evaluate(() => window.syntheticApp), 'local build');
  // What the portal added to the deployed landing page is still there.
  assert.equal(await page.evaluate(() => window.Microsoft.Dynamic365.Portal.isSpaSite), 'True');
  assert.ok(requests.includes('/reports/calendar/'), 'the route itself is asked from the portal');
  assert.ok(!requests.includes('/app.js'), 'the local build answered its own file');
  // The landing page's own address is a file of the build.
  const direct = await page.goto(origin + '/index.html', { waitUntil: 'load' });
  assert.equal(await direct.text(), LOCAL_ENTRY);
  assert.ok(!requests.includes('/index.html'), 'the local build answered its landing page address');
  assert.deepEqual(faults, []);
});

test('without the deployed landing page in the export the portal page is shown and the reason is noted', async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-build-overlay-')));
  const { server } = await deployedPortal(t, work);
  const site = project(path.join(work, 'local'), {
    entry: LOCAL_ENTRY,
    app: 'window.syntheticApp = "local build";',
    exported: false,
  });
  const { origin, page, session, faults } = await proxiedOverlay(t, server, {
    work,
    session: { sourceDir: site, siteName: 'code-site-test' },
  });
  const notes = [];
  session.on('hit', (hit) => notes.push(...(hit.notes ?? [])));
  await page.goto(origin + '/reports/calendar/', { waitUntil: 'load' });
  assert.equal(await page.locator('#local-build').count(), 0);
  assert.equal(await page.evaluate(() => window.syntheticApp), 'local build');
  assert.ok(
    notes.some((note) => note.rel === '../dist/index.html' && /no web file at \/index\.html/.test(note.reason)),
    JSON.stringify(notes),
  );
  assert.deepEqual(faults, []);
});

test('a rebuild reloads the tab with the new build, and a first build of a missing build folder is picked up', async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-build-overlay-')));
  const { server } = await deployedPortal(t, work);
  const root = path.join(work, 'local');
  const site = project(root, { entry: LOCAL_ENTRY, app: 'window.syntheticApp = "local build";', exported: true });
  const { origin, page, session, faults } = await proxiedOverlay(t, server, {
    work,
    session: { sourceDir: site, siteName: 'code-site-test' },
  });
  await page.goto(origin + '/reports/calendar/', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.syntheticApp), 'local build');
  const watcher = watchSources(session, page.context(), { log: () => {}, gitWatch: false });
  t.after(() => watcher.close());
  await watcher.ready;
  // A rebuilt file of the build reloads the tab, which then runs the new build.
  const rebuilt = once(session, 'refreshed');
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'window.syntheticApp = "rebuilt";');
  assert.equal((await rebuilt)[0].how, 'reload');
  await page.waitForFunction(() => window.syntheticApp === 'rebuilt');
  // A rebuilt landing page is laid over the portal's root page again.
  const entry = once(session, 'refreshed');
  fs.writeFileSync(
    path.join(root, 'dist', 'index.html'),
    LOCAL_ENTRY.replace('<p id="local-build">Local build</p>', '<p id="local-build">Rebuilt landing page</p>'),
  );
  assert.equal((await entry)[0].how, 'reload');
  await page.waitForFunction(() => document.getElementById('local-build')?.textContent === 'Rebuilt landing page');
  // A configuration that names a build folder not built yet: its first build is watched and overlaid.
  const configured = once(session, 'refreshed');
  fs.writeFileSync(
    path.join(root, 'powerpages.config.json'),
    JSON.stringify({ siteName: 'Invented code site', compiledPath: 'build', defaultLandingPage: 'index.html' }),
  );
  await configured;
  // The first build appears at once (a finished folder moved into place), as a build tool's output folder does.
  const staged = path.join(work, 'staged-build');
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, 'index.html'), LOCAL_ENTRY);
  fs.writeFileSync(path.join(staged, 'app.js'), 'window.syntheticApp = "first build";');
  const firstBuild = once(session, 'refreshed');
  fs.renameSync(staged, path.join(root, 'build'));
  assert.equal((await firstBuild)[0].how, 'reload');
  await page.waitForFunction(() => window.syntheticApp === 'first build');
  // Only the configuration that named a build folder not built yet was reported, once.
  assert.deepEqual(
    faults.filter((fault) => !/^Code site build not overlaid: /.test(fault)),
    [],
  );
});
