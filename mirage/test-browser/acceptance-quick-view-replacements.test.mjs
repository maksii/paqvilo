// @test-kind contract: local acceptance only reconciles the compatibility startup refresh of the same bound quick view.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAcceptance } from '../acceptance-api.mjs';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { ACCEPTANCE_HANG_GUARD_MS, loopbackServer } from './shared-browser.mjs';

const QUICK = '/_portal/quickform-template-path/32eeeaff-0aad-4dc4-badf-10c44e08a015';
const VIEW =
  'entityid=9f7deb25-501b-423d-908a-735e594e1788&entityname=publisher&entityprimarykeyname=publisherid&formname=Publisher&controlid=publisher-view';
const INITIAL = QUICK + '?' + VIEW + '&isprofilepage=false&lang=en-US';
const BOOTSTRAP_3 = QUICK + '?' + VIEW.replace('formname=Publisher', 'formname=Sample%20Publisher');
const COMPAT = '/xrm-adx/js/crmentityformview.js';
const STATE = {
  config: { mode: 'local', pageMode: 'local', endpoints: [] },
  status: { sourceFingerprint: 'book-fixture', implementationFingerprint: 'book-fixture' },
};

async function simulatorBook(t, directory, gates) {
  const sourceDir = path.join(directory, 'portal');
  const siteId = QUICK.split('/').at(-1);
  const bookid = 'a3507571-94ee-44f7-bfbd-40a0ca384c67';
  const pressid = '9f7deb25-501b-423d-908a-735e594e1788';
  const files = {
    'website.yml': `adx_websiteid: ${siteId}\nadx_name: Sample Books`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<main>{% entityform name: "Book editor" %}</main>',
    'Details.basicform.yml':
      'adx_entityformid: details\nadx_name: Book editor\nadx_entityname: book\nadx_mode: 100000001',
    'sitesetting.yml': '- adx_sitesettingid: bs5\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
  await fs.mkdir(sourceDir);
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(sourceDir, name), body);
  const layout = (rows) => [{ name: 'tab', columns: [{ sections: [{ name: 'details', rows }] }] }];
  const fields = [
    { name: 'note', type: 'text', label: 'Note' },
    { name: 'publisherid', type: 'lookup', label: 'Publisher', lookupTargets: ['press'] },
  ];
  const quick = {
    id: 'publisher-view',
    type: 'quickform',
    lookup: 'publisherid',
    entity: 'press',
    schema: { formName: 'Publisher details', fields: [{ name: 'name' }], layout: layout([[{ name: 'name' }]]) },
  };
  const app = await createSimulator({
    sourceDir,
    port: 0,
    watch: false,
    initial: {
      mappings: {
        book: {
          idColumn: 'bookid',
          relationships: {
            book_publisher: { entity: 'press', from: 'publisherid', to: 'pressid', many: false },
          },
        },
        press: { idColumn: 'pressid', nameColumn: 'name' },
      },
      tables: {
        book: [{ bookid, note: 'Original note', publisherid: { id: pressid, logical_name: 'press' } }],
        press: [{ pressid, name: 'Sample Publisher' }],
      },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        endpoints: [],
        externalAssets: false,
        componentSchemas: {
          details: { entity: 'book', fields, layout: layout([...fields.map(({ name }) => [{ name }]), [quick]]) },
        },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  app.server.prependListener('request', (request, response) => {
    const url = new URL(request.url, app.url);
    const parent = new URL(request.headers.referer ?? app.url);
    const gate = parent.pathname === '/' && gates.get(parent.searchParams.get('visit'));
    if (!gate) return;
    if (url.pathname === QUICK && url.searchParams.has('isprofilepage')) gate.resolve();
    if (url.pathname === `/_portal/${siteId}/Layout/GetAntiForgeryToken`) {
      const end = response.end.bind(response);
      response.end = (...args) => {
        void gate.promise.then(() => end(...args));
        return response;
      };
    }
  });
  return { app, bookid };
}

test('the exported basic form keeps passing after the actual simulator quick view and shell token reissue', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-portal-quick-view-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const gates = new Map([
    ['open', Promise.withResolvers()],
    ['reopen', Promise.withResolvers()],
  ]);
  const { app, bookid } = await simulatorBook(t, directory, gates);
  const publisher = { action: 'value', frame: '#publisher-view', selector: '#name', value: 'Sample Publisher' };
  const result = await runAcceptance({
    localUrl: app.url,
    outputDir: path.join(directory, 'evidence'),
    timeout: ACCEPTANCE_HANG_GUARD_MS,
    flows: [
      {
        name: 'Edit a book',
        steps: [
          { action: 'navigate', path: `/?id=${bookid}&visit=open` },
          publisher,
          { action: 'fill', selector: '#note', value: 'Saved note' },
          { action: 'click', selector: '#UpdateButton' },
          { action: 'waitRecord', entity: 'book', fields: { note: 'Saved note' } },
          { action: 'navigate', path: `/?id=${bookid}&visit=reopen` },
          { action: 'value', selector: '#note', value: 'Saved note' },
          publisher,
        ],
      },
    ],
  });
  assert.equal(result.passed, true, JSON.stringify(result));
  const flow = result.flows[0];
  assert.equal(flow.quickViewReplacements.length, 2);
  for (const proof of flow.quickViewReplacements) {
    assert.equal(proof.status, null);
    assert.equal(proof.replacement.status, 200);
    assert.match(proof.replacement.compatibilitySha256, /^[a-f\d]{64}$/);
    assert.notEqual(proof.loaderId, proof.replacement.loaderId);
  }
});

function bookForm(variant, saved) {
  const source = variant === 'bs3' ? BOOTSTRAP_3 : INITIAL;
  const frameSource = variant === 'mutation' ? '' : `src="${source.replaceAll('&', '&amp;')}"`;
  const mutating =
    variant === 'mutation'
      ? `<form id="mutating" action="${INITIAL.replaceAll('&', '&amp;')}" method="post" target="publisher-view"></form><script>document.querySelector('#mutating').submit()</script>`
      : '';
  const onReady =
    {
      record: "document.querySelector('#publisherid').value = '3a7bec3e-53ca-42fb-b212-bbb4ecfea776';",
      entity: "document.querySelector('iframe').dataset.entityname = 'imprint';",
      form: "document.querySelector('iframe').dataset.formname = 'Other Publisher';",
      control: "document.querySelector('iframe').dataset.controlid = 'different-control';",
      frame: `let frame = document.querySelector('iframe'); let copy = frame.cloneNode(); copy.className = ''; copy.src = '${QUICK}?${VIEW}'; frame.replaceWith(copy);`,
      missing: "document.querySelector('iframe').remove();",
      unrelated: "fetch('/network-reset').catch(() => {});",
      arbitrary: "let frame = document.querySelector('iframe'); frame.className = ''; frame.src = '/intermediate';",
    }[variant] ?? '';
  return `<!doctype html>
    <form method="post" action="/save"><label>Note <input name="note" value="${saved}"></label><button>Save</button></form>
    <script>
      let initial;
      const initialStreaming = new Promise(resolve => { initial = resolve; });
      window.initialReady = () => { ${onReady} initial(); };
      window.shell = {getTokenDeferred() {
        const token = fetch('/shell-token');
        return {always(callback) { void ${variant === 'no-headers' ? 'token' : 'Promise.all([token, initialStreaming])'}.then(callback); return this; }};
      }};
    </script>
    <script src="${COMPAT}"></script>
    <input id="publisherid" type="hidden" value="9f7deb25-501b-423d-908a-735e594e1788">
    <iframe class="quickform" name="publisher-view" id="publisher-view" data-controlid="publisher-view"
      data-formname="${variant === 'bs3' ? 'Sample Publisher' : 'Publisher'}"
      ${variant === 'bs3' ? 'data-entityname="publisher" data-entityprimarykeyname="publisherid"' : ''}
      data-path="${QUICK}" data-lookup-element="publisherid" ${frameSource}></iframe>${mutating}`;
}

async function serveBooks(t) {
  const compat = await fs.readFile(new URL('../lib/crmentityformview-compat.js', import.meta.url));
  const firstUnanswered = Promise.withResolvers();
  let bs3Visit = 0;
  let note = '';
  return loopbackServer(t, async (req, res) => {
    const url = new URL(req.url, 'http://book-fixture.invalid');
    const variant = new URL(req.headers.referer ?? 'http://book-fixture.invalid').pathname.split('/').at(-1);
    if (url.pathname.startsWith('/__sim/api/'))
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(STATE));
    if (url.pathname === COMPAT) {
      const authored = `
        function refreshQuickView() { document.querySelector('iframe').setAttribute('src', '${QUICK}?${VIEW}'); }
        function refreshQuickViews() { refreshQuickView(); }
        function refreshBound() { refreshQuickViews(); }
        void initialStreaming.then(refreshBound);
      `;
      return res
        .writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
        .end(variant === 'authored' ? authored : compat);
    }
    if (url.pathname === '/network-reset') return res.destroy();
    if (url.pathname === '/shell-token') {
      if (variant === 'no-headers') await firstUnanswered.promise;
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    }
    if (url.pathname === '/save' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      note = new URLSearchParams(Buffer.concat(chunks).toString()).get('note');
      return res.writeHead(303, { location: '/book/matching' }).end();
    }
    if (url.pathname.startsWith('/book/'))
      return res.writeHead(200, { 'content-type': 'text/html' }).end(bookForm(url.pathname.split('/').at(-1), note));
    if (url.pathname === '/intermediate')
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(`<!doctype html><script>frameElement.src = '${QUICK}?${VIEW}';</script>`);
    if (url.pathname !== QUICK) return res.writeHead(404).end();
    if (url.searchParams.has('isprofilepage') || (variant === 'bs3' && ++bs3Visit === 1)) {
      if (variant === 'no-headers') return firstUnanswered.resolve();
      res.writeHead(variant === 'initial-error' ? 503 : 200, { 'content-type': 'text/html' });
      // This first document has received headers and committed, but the stream stays open until
      // the parent receives the gate from the parser and the bound startup refresh abandons it.
      res.write('<!doctype html><script>parent.initialReady();</script>');
      return;
    }
    if (variant === 'interrupted') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<!doctype html>', () => res.destroy());
      return;
    }
    return res
      .writeHead(variant === 'replacement-error' ? 503 : 200, { 'content-type': 'text/html' })
      .end('<!doctype html><p id="publisher">Sample Publisher</p>');
  });
}

test('acceptance retains both loader IDs for a committed quick-view replacement during edit, save and reopen', async (t) => {
  const outputDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-quick-acceptance-'));
  ownedFixture(t).remove(() => fs.rm(outputDir, { recursive: true, force: true }));
  const { origin: localUrl } = await serveBooks(t);
  const result = await runAcceptance({
    localUrl,
    outputDir,
    timeout: ACCEPTANCE_HANG_GUARD_MS,
    flows: [
      {
        name: 'Book note',
        steps: [
          { action: 'navigate', path: '/book/matching' },
          { action: 'text', frame: '#publisher-view', selector: '#publisher', value: 'Sample Publisher' },
          { action: 'fill', selector: 'input[name=note]', value: 'Saved note' },
          { action: 'click', selector: 'button' },
          { action: 'navigate', path: '/book/matching' },
          { action: 'value', selector: 'input[name=note]', value: 'Saved note' },
          { action: 'text', frame: '#publisher-view', selector: '#publisher', value: 'Sample Publisher' },
        ],
      },
      ...[
        'bs3',
        'no-headers',
        'unrelated',
        'record',
        'entity',
        'control',
        'form',
        'frame',
        'missing',
        'arbitrary',
        'authored',
        'initial-error',
        'replacement-error',
        'interrupted',
        'mutation',
      ].map((variant) => ({
        name: variant,
        steps: [
          { action: 'navigate', path: '/book/' + variant },
          { action: 'visible', selector: 'button' },
        ],
      })),
    ],
  });
  const [matching, bootstrap3, noHeaders, unrelated, ...refused] = result.flows;
  assert.equal(matching.passed, true, JSON.stringify(matching));
  assert.ok(matching.quickViewReplacements.length >= 2);
  const { records, frameEvents } = JSON.parse(await fs.readFile(matching.browserNetworkFile, 'utf8'));
  for (const proof of matching.quickViewReplacements) {
    assert.equal(proof.control, 'publisher-view');
    assert.notEqual(proof.loaderId, proof.replacement.loaderId);
    assert.ok(
      matching.failedRequests.some((failure) => failure.requestKey === proof.requestKey && failure.status === 200),
    );
    assert.ok(records.some((row) => row.requestId === proof.requestId && row.loaderId === proof.loaderId));
    assert.ok(
      frameEvents.some(
        (row) =>
          row.event === 'frameNavigated' &&
          row.loaderId === proof.replacement.loaderId &&
          row.frameId === proof.frameId,
      ),
    );
  }
  for (const flow of [bootstrap3, noHeaders]) {
    assert.equal(flow.passed, true, JSON.stringify(flow));
    assert.equal(flow.quickViewReplacements.length, 1);
  }
  assert.equal(bootstrap3.quickViewReplacements[0].form, 'Sample Publisher');
  assert.equal(noHeaders.quickViewReplacements[0].status, null);
  assert.equal(unrelated.passed, false);
  assert.equal(unrelated.quickViewReplacements.length, 1);
  assert.match(unrelated.error, /failedRequests/);
  assert.ok(unrelated.failedRequests.some(({ url }) => new URL(url).pathname === '/network-reset'));
  for (const flow of refused) {
    assert.equal(flow.passed, false, flow.name);
    assert.ok(
      flow.steps.every(({ passed }) => passed),
      JSON.stringify(flow),
    );
    assert.equal(flow.quickViewReplacements, undefined, flow.name);
    assert.match(flow.error, /Runtime observations failed:.*failedRequests/);
  }
  const mutation = refused.find(({ name }) => name === 'mutation');
  assert.ok(mutation.failedRequests.some(({ method, status }) => method === 'POST' && status === 200));
});
