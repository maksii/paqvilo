// The /_sim/ administration page and its assets on both hosts: the shared CSP (runtime-admin.mjs ADMIN_CSP), nosniff,
// text/javascript modules, and 404 for anything outside the admin asset pattern (D1, D10). Invented data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';

const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

// fetch() normalises `..` and `%2e%2e` before sending, so traversal targets go out raw through http.request.
const raw = (base, target) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(base);
  http.request({ hostname, port, path: target }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
});
const REFUSED = ['/_sim/../package.json', '/__sim/../package.json', '/_sim/%2e%2e/package.json', '/__sim/..%2fpackage.json', '/__sim/..%5cpackage.json',
  '/__sim/..\\package.json', '/__sim/%2e%2e%2f%2e%2e%2fpackage.json', '/_sim/x%2F..%2Fy.mjs', '/__sim/APP.mjs', '/_sim/APP.mjs', '/__sim/admin/app.mjs',
  '/__sim/lib/data.mjs', '/__sim/runtime-admin.mjs', '/_sim/con.mjs', '/_sim/nul.css', '/_sim/missing-module.mjs', '/_sim/index.html'];

async function assertHeaders(base) {
  const index = await fetch(`${base}/_sim/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('content-security-policy'), CSP);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  for (const [asset, type] of [['app.mjs', /^text\/javascript/], ['style.css', /^text\/css/], ['persona-search.mjs', /^text\/javascript/]]) {
    const response = await fetch(`${base}/_sim/${asset}`);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get('content-type'), type, asset);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', asset);
  }
  for (const target of REFUSED) assert.equal(await raw(base, target), 404, target);
  assert.equal(await raw(base, '/__sim/app.mjs'), 200, 'the raw helper reaches the asset route');
}

test('Power Pages /_sim/ sends the admin CSP and nosniff; assets resolve by pattern only', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-headers-pp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeFiles(dir, {
    'website.yml': 'adx_name: Invented Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
    'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
    'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<p>Invented</p>',
  });
  const sim = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), port: 0, watch: false,
    initial: { version: 1, mappings: {}, tables: {}, permissions: [], simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [] } } });
  t.after(() => sim.close());
  await assertHeaders(sim.url);
});

test('standalone /_sim/ sends the same CSP and nosniff; assets resolve by pattern only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-headers-sa-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFiles(root, { 'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedHeaders</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>' });
  const sim = await createSimulator({ runtime: { kind: 'dataverse-api' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false,
    simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  t.after(() => sim.close());
  await assertHeaders(sim.url);
});
