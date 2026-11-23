// @test-kind contract: on a live portal page every element gets an answer from X-ray: its own source tag, the Liquid code that generated it, the web file or portal file it loads, the portal's page shell, or the identified element it stands in; a form post with a file is read at its response and never sent twice
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { overlayPanel } from './helpers/overlay-panel.mjs';
import { createFixture } from '../test/fixture.mjs';

const COPY = 'web-pages/home/content-pages/Home.en-US.webpage.copy.html';
const LAYOUT = 'web-templates/layout/Layout.webtemplate.source.html';
const layoutSource = [
  '<main id="content" class="wrapper">',
  "  <div class=\"page-copy\">{% editable page 'adx_copy' type: 'html' %}</div>",
  '  <ul class="links" id="links">{% for link in links %}<li><a href="{{ link.url }}">{{ link.name }}</a></li>{% endfor %}</ul>',
  '  <form id="upload" method="post" enctype="multipart/form-data" action="/"><input type="file" name="attachment"><button id="send" type="submit">Send</button></form>',
  '</main>',
  '',
].join('\n');
const copySource = [
  '<section class="intro" id="intro">',
  '  <h1 class="headline">Invented portal</h1>',
  '  <img src="/Logo.svg" alt="Invented logo" class="logo">',
  '  <p class="lead">Welcome, {{ user.fullname }}</p>',
  '</section>',
  '',
].join('\n');
// What the portal answers: the templates rendered, in the page shell the portal adds around them.
const served = (note = '') =>
  [
    '<!DOCTYPE html>',
    '<html lang="en-US"><head><title>Home</title>',
    '<script src="/resource/powerappsportal/dist/app.bundle-1a2b3c4d5e.js"></script>',
    '</head><body>',
    '<div id="offline" class="shell-bar">' + note + '</div>',
    '<main id="content" class="wrapper">',
    '  <div class="page-copy"><div class="xrm-editable-html xrm-attribute"><div class="xrm-attribute-value">' +
      copySource.replace('{{ user.fullname }}', 'Ada Lovelace') +
      '</div></div></div>',
    '  <ul class="links" id="links"><li><a href="/one/">One</a></li><li><a href="/two/">Two</a></li></ul>',
    '  <form id="upload" method="post" enctype="multipart/form-data" action="/"><input type="file" name="attachment"><button id="send" type="submit">Send</button></form>',
    '</main>',
    '<script src="/runtime.js"></script>',
    '</body></html>',
    '',
  ].join('\n');

test('every element of a served portal page is identified, and a file upload is overlaid without being sent twice', async (t) => {
  const fx = createFixture();
  fx.write(
    'web-templates/layout/Layout.webtemplate.yml',
    'adx_name: Layout\nadx_webtemplateid: 00000000-0000-0000-0000-00000000aa01\n',
  );
  fx.write(LAYOUT, layoutSource);
  fx.write(COPY, copySource);
  fx.commit();
  const posts = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    if (pathname === '/runtime.js')
      return response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(
          "const made = document.createElement('div'); made.id = 'made'; made.append(document.createElement('span')); document.getElementById('content').append(made);",
        );
    if (pathname.startsWith('/resource/powerappsportal/'))
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.portalRuntime = true;');
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    if (request.method === 'POST') {
      let size = 0;
      request.on('data', (chunk) => (size += chunk.length));
      request.on('end', () => {
        posts.push(size);
        response.writeHead(200, { 'content-type': 'text/html' }).end(served('saved'));
      });
      return undefined;
    }
    return response.writeHead(200, { 'content-type': 'text/html' }).end(served());
  });
  const { origin, session, page, panel, errors } = await overlayPanel(t, fx, () => listenOwnedServer(t, server));

  // What X-ray answers for the elements a test names, in plain data.
  const answers = () =>
    page.evaluate(() => {
      const xray = globalThis.__paqviloXrayUi;
      const answer = (node) => {
        const found = xray.identify(node);
        const exact = found.evidence.source.refs.find((ref) => ref.status === 'exact');
        return {
          title: found.title,
          owner: found.evidence.owner.status === 'exact' ? found.evidence.owner.component.kind : null,
          ownerName: found.evidence.owner.component?.name ?? null,
          source: exact
            ? { file: exact.ref.replaceAll('\\', '/'), line: exact.region?.line, how: exact.evidenceLabel }
            : null,
          contained: found.contained,
          inside: found.evidence.enclosing.filter((row) => row.status === 'exact').map((row) => row.component.kind),
        };
      };
      const one = (selector) => answer(document.querySelector(selector));
      return {
        html: one('html'),
        shell: one('#offline'),
        runtime: one('script[src^="/resource/"]'),
        layout: one('#content'),
        wrapper: one('.xrm-editable-html'),
        headline: one('h1.headline'),
        logo: one('img.logo'),
        items: [...document.querySelectorAll('#links > li')].map(answer),
        links: [...document.querySelectorAll('#links a')].map(answer),
        made: one('#made'),
        madeChild: one('#made > span'),
        note: document.getElementById('offline').textContent,
      };
    });
  // The page is identified once its inspection report is in and the proof of this document is published.
  const identified = async () => {
    await page.waitForFunction(() => typeof globalThis.__paqviloXrayUi?.coverage === 'function');
    const coverage = await panel.coverageFor(page);
    await page.waitForFunction(
      () =>
        globalThis.__paqviloXrayUi.identify(document.querySelector('h1.headline')).evidence.source.status === 'exact' &&
        document.getElementById('made'),
    );
    return coverage.available ? panel.coverageFor(page) : coverage;
  };

  await page.goto(origin + '/', { waitUntil: 'load' });
  const coverage = await identified();
  const first = await answers();
  const literal = 'Found at this place in the served page';
  assert.deepEqual(first.headline.source, { file: COPY, line: 2, how: literal });
  assert.deepEqual(first.layout.source, { file: LAYOUT, line: 1, how: literal });
  assert.deepEqual(
    first.wrapper.source,
    { file: LAYOUT, line: 2, how: 'Generated by the editable tag' },
    'the wrapper the editable tag writes is named by that tag',
  );
  assert.deepEqual(
    first.items.map((item) => item.source),
    [
      { file: LAYOUT, line: 3, how: literal },
      { file: LAYOUT, line: 3, how: literal },
    ],
    'each item of the loop is the loop body',
  );
  assert.deepEqual(
    first.links.map((item) => item.source?.file),
    [LAYOUT, LAYOUT],
    'a tag with an output in it is the template tag',
  );
  assert.deepEqual([first.logo.owner, first.logo.ownerName, first.logo.source?.file], ['web-file', 'Site Logo', COPY]);
  assert.deepEqual([first.runtime.owner, first.runtime.ownerName], ['platform-asset', 'app.bundle.js']);
  assert.equal(first.shell.owner, 'platform-shell');
  assert.equal(first.html.owner, 'platform-shell');
  assert.deepEqual(
    [first.made.contained, first.made.inside.includes('markup'), first.made.title],
    [true, true, 'Inside Layout · main · div'],
    'an element a script made is named by the identified element it stands in',
  );
  assert.equal(first.madeChild.contained, true);
  assert.deepEqual(
    coverage.counts.none + coverage.counts.likely + coverage.counts.conflict,
    0,
    JSON.stringify(coverage),
  );
  assert.equal(coverage.counts.direct + coverage.counts.contained, coverage.total);
  assert.ok(coverage.counts.contained >= 2 && coverage.kinds['platform-shell'] > 0 && coverage.kinds['web-file'] === 1);

  // A form post with a file: the browser sends it once; its answer is the portal's page and is identified the same.
  await page.setInputFiles('#upload input[type=file]', {
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('invented'),
  });
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#send')]);
  await identified();
  const second = await answers();
  assert.equal(second.note, 'saved', 'the page after the post is the answer of that post');
  assert.equal(posts.length, 1, 'the upload reached the portal once');
  assert.ok(posts[0] > 0);
  assert.deepEqual(second.headline.source, { file: COPY, line: 2, how: literal });
  assert.equal(second.made.contained, true);
  const requests = session.requestSummary(page);
  assert.deepEqual(
    requests.items.filter((item) => item.method === 'POST').map((item) => [item.class, item.reason]),
    [['document', undefined]],
    'the posted page is a document of the portal like any other',
  );
  assert.deepEqual(errors, []);
});
