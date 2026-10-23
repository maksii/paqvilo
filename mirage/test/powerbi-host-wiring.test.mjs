import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

async function host(t, embed) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'powerbi-host-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: 77777777-7777-4777-8777-777777777793\nadx_name: Invented fixture host',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: page',
    'Page.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: content',
    'Content.webtemplate.yml': 'adx_webtemplateid: content\nadx_name: Content',
    'Content.webtemplate.source.html': "{% powerbi path: 'invented-report', roles: 'Viewer' %}",
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const sim = await createSimulator({ sourceDir: root, stateFile: path.join(root, 'state.json'), watch: false, port: 0,
    observed: { powerBiOutput: 'empty', evidence: 'Invented empty-output capture' },
    packs: [{ id: 'invented-service-fixture', name: 'Invented fixture', description: 'Loopback host wiring regression', matches: () => true, presets: () => ({}), serviceFixtures: { powerBi: { embed } } }],
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test('HTTP Liquid rendering uses the explicitly registered trusted service fixture', async t => {
  const calls = [];
  const sim = await host(t, input => { calls.push(input.args); return { html: '<strong id="local-report">Invented local report</strong>' }; });
  const response = await fetch(sim.url), html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes('<strong id="local-report">Invented local report</strong>'));
  assert.doesNotMatch(html, /paqvilo-powerbi-placeholder/);
  assert.deepEqual(calls, [{ path: 'invented-report', roles: 'Viewer' }]);
});

test('an ordinary fixture returning a rejected promise cannot terminate the HTTP host', async t => {
  const sim = await host(t, () => Promise.reject(new Error('Invented asynchronous fixture failure')));
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(sim.url), html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /powerBi\.embed must synchronously return/);
    await new Promise(resolve => setImmediate(resolve));
    const status = await fetch(sim.url + '/_sim/api/status');
    assert.equal(status.status, 200);
  }
});
