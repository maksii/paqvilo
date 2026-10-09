import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixture, SITE } from './fixture.mjs';
import map, { buildMapping, toMarkdown } from '../lense/commands/map.mjs';
import { OverlaySession } from '../lense/session.mjs';
import status, { comparisonExitCode } from '../lense/commands/status.mjs';
import { describeStatus } from '../lense/online.mjs';

const fx = createFixture();
after(() => fx.cleanup());
const cfg = { siteName: 'test', envName: 'dev', origin: 'https://portal.example', sourceDir: fx.dir, stateDir: path.join(fx.dir, '.paqvilo'), site: structuredClone(SITE) };

test('report labels distinguish redirects, authentication and forbidden responses', () => {
  assert.equal(describeStatus(302), 'redirect (HTTP 302)');
  assert.equal(describeStatus(401), 'authentication required');
  assert.equal(describeStatus(403), 'forbidden');
  assert.equal(comparisonExitCode([{ state: 'different' }, { state: 'not online (local only)' }]), 0);
  assert.equal(comparisonExitCode([{ state: 'same' }, { state: 'unreachable' }]), 1);
});

test('mapping markdown displays filenames and metadata as text without breaking tables', () => {
  const markdown = toMarkdown({ site: 'site', environment: 'dev', source: '/local', origin: cfg.origin, scope: 'all', checked: true,
    webFiles: [{ url: '/a|b.js', local: 'a[link](url)<img>.js', problem: 'bad\nrow', online: 'unreachable', onlineError: '<error>' }],
    inline: [{ kind: 'page-js', local: 'a`b.js', technique: 'replace block', usedOn: ['/a|b', '/two'], empty: false }],
    routes: [{ url: '/**', dir: 'a|b' }], needsDeploy: [{ rel: 'a', reason: '<script>' }], warnings: ['<div>'] });
  assert.match(markdown, /a&#124;b\.js/);
  assert.match(markdown, /&#60;img&#62;/);
  assert.doesNotMatch(markdown, /<img>|<script>|<div>/);
  assert.match(markdown, /bad<br>row/);
  assert.match(markdown, /## Explicit routes/);
  assert.match(markdown, /a&#96;b\.js/);
});

test('status JSON signals incomplete network comparisons and keeps per-file diagnostics', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (text) => output.push(text));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline test failure'); });
  assert.equal(await status(cfg, { json: true }), 1);
  const rows = JSON.parse(output[0]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.state === 'unreachable' && row.detail === 'offline test failure'));
});

test('map check reports access failures without calling them authentication or losing the report', async (t) => {
  const output = [];
  t.mock.method(console, 'log', (text) => output.push(text));
  t.mock.method(globalThis, 'fetch', async () => new Response('restricted network', { status: 403 }));
  assert.equal(await map(cfg, { check: true, json: true }), 1);
  const mapping = JSON.parse(output[0]);
  assert.ok(mapping.webFiles.filter((row) => row.url).every((row) => row.online === 'forbidden'));
  assert.ok(fs.existsSync(path.join(cfg.stateDir, 'mapping-test-dev.md')));
});

test('offline mapping performs no request and missing online assets are valid comparison results', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  assert.equal(await map(cfg, { json: true }), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await status(cfg, { json: true }), 0);
});

test('mapping retains disabled kinds with an explicit enabled flag', () => {
  const site = structuredClone(SITE);
  site.markup.enabled = false;
  site.inline.kinds = ['page-js'];
  const mapping = buildMapping(new OverlaySession({ ...cfg, site }));
  assert.ok(mapping.inline.some((item) => item.kind === 'web-template' && item.enabled === false));
  assert.ok(mapping.inline.some((item) => item.kind === 'page-css' && item.enabled === false));
  assert.ok(mapping.inline.some((item) => item.kind === 'page-js' && item.enabled));
});
