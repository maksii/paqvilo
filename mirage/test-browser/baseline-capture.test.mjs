import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { captureScenario } from '../baseline-capture.mjs';
import { compareScenario } from '../baseline-compare.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { closeServer } from './shared-browser.mjs';

test(
  'baseline capture records, guards writes, redacts tokens and compares captures',
  { timeout: 180_000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-baseline-capture-'));
    ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
    const tokens = [];
    let variant = false;
    let posts = 0;
    const head = '<!doctype html><html><head><title>Fixture</title><link rel="icon" href="data:,"></head><body>';
    const server = http.createServer((req, res) => {
      res.sendDate = false;
      const html = (body, headers = {}) =>
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers })
          .end(head + body + '</body></html>');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/form' && req.method === 'GET') {
        const token = randomBytes(16).toString('hex');
        tokens.push(token);
        return html(`<h1 class="${variant ? 'title wide' : 'title'}">${variant ? 'Edit item' : 'New item'}</h1>
<form method="post" action="/form"><input type="hidden" name="__RequestVerificationToken" value="${token}">
<input id="title" name="title" required><input id="locked" name="locked" value="fixed" disabled>
<p id="hint" style="display:none">hidden hint</p><button id="save" type="submit">Save</button></form>
<ul id="items"></ul><a id="leave" href="/signin">Sign in</a>
<script>fetch("/api/items").then((r) => r.json()).then((d) => { document.getElementById("items").innerHTML = d.items.map((i) => "<li>" + i.name + "</li>").join(""); });</script>`);
      }
      if (url.pathname === '/form' && req.method === 'POST') {
        posts++;
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () =>
          html(`<p id="saved">Saved ${new URLSearchParams(Buffer.concat(chunks).toString()).get('title')}</p>`, {
            'set-cookie': 'fixture-session=s3cr3tvalue; Path=/',
          }),
        );
        return;
      }
      if (url.pathname === '/api/items') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            items: [{ name: variant ? 'Second' : 'First' }],
            __RequestVerificationToken: tokens.at(-1),
          }),
        );
      }
      if (url.pathname === '/signin') return html('<form id="loginForm"><input name="user"></form>');
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    // Browser keep-alive sockets would hold close() open; the capture contexts are closed by then.
    ownedFixture(t).add(() => closeServer(server));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    ownedFixture(t).add(() => browser.close());

    const matrix = { settle: { quietMs: 300 }, writeScope: { paths: ['^/form$'] } };
    const capture = async (name, scenario, options = {}) => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const outDir = path.join(directory, name);
        const meta = await captureScenario(
          page,
          { id: name, ...scenario },
          { origin, outDir, side: name, matrix, ...options },
        );
        return {
          meta,
          outDir,
          read: (file) => fs.readFile(path.join(outDir, file), 'utf8'),
          json: async (file) => JSON.parse(await fs.readFile(path.join(outDir, file), 'utf8')),
        };
      } finally {
        await context.close();
      }
    };
    const read = {
      steps: [{ goto: '/form' }, { wait: { selector: '#items li' } }],
      expect: { present: ['#title'], text: ['First'], urlPattern: '^/form$' },
    };

    // (a) read scenario
    const a = await capture('read', read);
    assert.equal(a.meta.status, 'captured', a.meta.problems.join('; '));
    assert.deepEqual(a.meta.blockedWrites, []);
    const requests = await a.json('requests.json');
    assert.deepEqual(
      requests.map((r) => `${r.seq} ${r.method} ${r.path} ${r.response?.status}`),
      ['1 GET /form 200', '2 GET /api/items 200'],
    );
    assert.match(requests[0].response.body, /<form method="post"/);
    assert.deepEqual(JSON.parse(requests[1].response.body), {
      items: [{ name: 'First' }],
      __RequestVerificationToken: '{token}',
    });
    const elements = await a.json('elements.json');
    const element = (id) => elements.find((item) => item.attributes.id === id);
    assert.equal(element('title').required, true);
    assert.equal(element('title').visible, true);
    assert.equal(element('locked').disabled, true);
    assert.equal(element('hint').visible, false);
    assert.equal(elements.find((item) => item.attributes.name === '__RequestVerificationToken').value, '{token}');
    const dom = await a.read('dom.html');
    assert.match(dom, /name="__RequestVerificationToken" value="\{token\}"/);
    assert.match(dom, /<li>First<\/li>/);
    const evidence = dom + (await a.read('requests.json')) + (await a.read('elements.json'));
    for (const token of tokens) assert.ok(!evidence.includes(token), 'token written to evidence');
    assert.ok((await fs.stat(path.join(a.outDir, 'screenshot.png'))).size > 0);
    assert.equal((await a.json('meta.json')).status, 'captured');
    assert.equal(a.meta.title, 'Fixture');

    // (b) write scenario without permission: the POST is aborted and listed
    const write = {
      steps: [{ goto: '/form' }, { fill: '#title', value: 'Hello' }, { click: '#save' }],
      expect: { present: ['#saved'] },
    };
    const b = await capture('write-blocked', write, { allowWrites: false });
    assert.equal(posts, 0);
    assert.deepEqual(b.meta.blockedWrites, [{ method: 'POST', path: '/form' }]);
    assert.equal(b.meta.status, 'failed');
    assert.ok(b.meta.problems.includes('expected element missing: #saved'), b.meta.problems.join('; '));
    const blocked = (await b.json('requests.json')).find((r) => r.method === 'POST');
    assert.equal(blocked.response.status, 0);

    // (c) write scenario inside the write scope
    const c = await capture('write-allowed', write, { allowWrites: true });
    assert.equal(posts, 1);
    assert.equal(c.meta.status, 'captured', c.meta.problems.join('; '));
    assert.deepEqual(c.meta.blockedWrites, []);
    const post = (await c.json('requests.json')).find((r) => r.method === 'POST');
    assert.equal(post.body, '__RequestVerificationToken={token}&title=Hello');
    assert.equal(post.response.status, 200);
    assert.ok(!(await c.read('requests.json')).includes('s3cr3tvalue'), 'cookie value written to evidence');
    assert.match(await c.read('dom.html'), /Saved Hello/);

    // (d) missing expected element, (e) step error, (f) sign-in marker
    const d = await capture('missing', { steps: [{ goto: '/form' }], expect: { present: ['#nope'] } });
    assert.equal(d.meta.status, 'failed');
    assert.deepEqual(d.meta.problems, ['expected element missing: #nope']);
    const e = await capture('step-error', { steps: [{ goto: '/form' }, { click: '#absent', timeout: 500 }] });
    assert.equal(e.meta.status, 'error');
    assert.match(e.meta.problems[0], /#absent/);
    const f = await capture('sign-in', {
      steps: [{ goto: '/form' }, { click: '#leave' }, { wait: { url: '^/signin' } }],
    });
    assert.equal(f.meta.status, 'failed');
    assert.ok(f.meta.problems.includes('sign-in marker present: form#loginForm'), f.meta.problems.join('; '));

    // compare: same page twice passes, a modified copy fails with the expected signatures
    const none = { entries: [] };
    const again = await capture('read-again', read);
    const same = await compareScenario({
      scenario: { id: 'read' },
      liveDir: a.outDir,
      mirageDir: again.outDir,
      allowlist: none,
    });
    assert.equal(same.verdict, 'PASS', JSON.stringify(same.deltas.slice(0, 5)));
    variant = true;
    const modified = await capture('read-modified', { ...read, expect: {} });
    const diff = await compareScenario({
      scenario: { id: 'read' },
      liveDir: a.outDir,
      mirageDir: modified.outDir,
      allowlist: none,
    });
    assert.equal(diff.verdict, 'FAIL');
    const has = (scope, field, live, mirage) =>
      diff.deltas.some(
        (item) => item.scope === scope && item.field === field && item.live === live && item.mirage === mirage,
      );
    assert.ok(has('dom', 'class', 'title', 'title wide'), 'class delta');
    assert.ok(has('dom', 'text', 'New item', 'Edit item'), 'text delta');
    assert.ok(has('response', 'body.items[0].name', 'First', 'Second'), 'api body delta');
    assert.ok(has('element', 'classes', 'title', 'title wide'), 'element delta');
    assert.ok(diff.signatures.every((group) => !group.allowed));
  },
);
