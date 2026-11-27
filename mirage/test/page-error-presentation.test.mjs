// @test-kind observation: hosted session F3 (two runs, summary-F3.md PAGE-03c) captured the generic error page for every server exception of a page request; invented sites replay it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'parse5';
import { observedPageErrorResponse } from '../lib/page-error-presentation.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory, assertTemporaryDirectory } from '../testing/owned-fixture.mjs';

const observed = { pageErrorPresentation: 'generic-error', evidence: 'invented-loopback/error-structure.json' };
const failure = { status: 500, code: 'PAGE_QUERY_REQUEST_VALIDATION', message: 'invented diagnostic detail' };
const options = { method: 'GET', error: failure, observed };
function elements(document, tag) {
  const found = [];
  function visit(node) {
    if (node.tagName === tag) found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(document);
  return found;
}
const text = (node) => (node.childNodes ?? []).map((child) => child.value ?? text(child)).join('');

test('the evidenced error structure uses a fresh local UUID and finite visible content', () => {
  const first = observedPageErrorResponse(options),
    second = observedPageErrorResponse(options);
  assert.equal(first.status, 500);
  assert.equal(first.headers['content-type'], 'text/html; charset=utf-8');
  const document = parse(first.body),
    headings = elements(document, 'h1');
  assert.equal(text(elements(document, 'title')[0]), "We're sorry, but something went wrong (500)");
  assert.equal(
    text(headings[0]),
    "We're sorry, but something went wrong. Please try again, and if this persists, contact the website administrator.",
  );
  assert.match(text(headings[1]), /^Error ID # \[[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\]$/);
  assert.notEqual(first.body, second.body);
  // Hosted session F3: the dialog shows no exception text; the only script is the DevTools server log.
  const dialog = elements(document, 'div')[0];
  assert.deepEqual(
    dialog.attrs.map(({ name, value }) => [name, value]),
    [
      ['class', 'dialog'],
      ['role', 'main'],
    ],
  );
  assert.equal(first.body.includes('A potentially dangerous'), false);
  const scripts = elements(document, 'script');
  assert.equal(scripts.length, 1);
  assert.match(text(scripts[0]), /updateDevToolRuntime/);
  assert.equal(first.body.includes(failure.message), false);
});

test('unobserved methods, statuses and the default retain diagnostics; every 500 exception class is presented', () => {
  for (const method of ['HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])
    assert.equal(observedPageErrorResponse({ ...options, method }), null);
  for (const error of [{ ...failure, status: 400 }, {}, null])
    assert.equal(observedPageErrorResponse({ ...options, error }), null);
  assert.equal(observedPageErrorResponse({ ...options, error: { ...failure, code: 'OTHER_ERROR' } }).status, 500);
  for (const observed of [undefined, {}, { pageErrorPresentation: 'diagnostic' }])
    assert.equal(observedPageErrorResponse({ ...options, observed }), null);
  assert.equal(observedPageErrorResponse({ ...options, error: { statusCode: 500, code: failure.code } }).status, 500);
});

// @test-kind contract: the observed configuration schema accepts only evidenced, known choices.
test('the presentation mode requires site evidence and a known choice', () => {
  assert.equal(observedConfig(observed).pageErrorPresentation, 'generic-error');
  assert.throws(() => observedConfig({ pageErrorPresentation: 'generic-error' }), /evidence/);
  assert.throws(() => observedConfig({ ...observed, pageErrorPresentation: 'all-errors' }), /pageErrorPresentation/);
  assert.equal(observedConfig({ ...observed, customErrors: 'disabled' }).customErrors, 'disabled');
  assert.throws(() => observedConfig({ ...observed, customErrors: 'off' }), /customErrors/);
});

test('Mirage leaves ordinary pages unchanged and presents every page server exception in the selected mode', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-page-presentation-'));
  ownedFixture(t).remove(async () => {
    const physical = await assertTemporaryDirectory(directory, { directChild: true });
    await fs.rm(physical, { recursive: true, force: true });
  });
  const files = {
    'website.yml': 'adx_websiteid: invented-error-site\nadx_name: Invented error site',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<p>Ordinary page</p>',
  };
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source);
  }
  const app = await createSimulator({
    sourceDir: directory,
    stateFile: path.join(directory, 'state.json'),
    port: 0,
    watch: false,
    observed: { ...observed, siteMarkerRedirect: 'null-reference' },
  });
  ownedFixture(t).add(() => app.close());
  const page = await fetch(app.url + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ordinary page/);
  app.portal.redirects.push({ inboundUrl: 'missing-marker', siteMarkerId: 'invented-absent-marker' });
  const response = await fetch(app.url + '/missing-marker', { redirect: 'manual' });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /<h1>Error ID # \[[0-9a-f-]{36}\]<\/h1>/);
  assert.doesNotMatch(body, /Portal simulation diagnostic|Object reference not set/);
  // The legacy CMS file browser is a server exception too; the other legacy CMS routes answer Page Not Found.
  const browser = await fetch(app.url + '/_services/portal/invented-error-site/elFinder/connector?working=x');
  assert.equal(browser.status, 500);
  assert.match(await browser.text(), /Error ID # \[/);
  for (const target of ['/_services/cms', '/_services/portal/invented-error-site/__templates/all/x'])
    assert.equal((await fetch(app.url + target, { redirect: 'manual' })).status, 404, target);
  // A page whose rewrite URL has no handler renders the same page with the DevTools server log.
  app.portal.pageTemplates[0].rewriteUrl = '~/invented-route/';
  app.portal.pageTemplates[0].webTemplateId = null;
  app.portal.pageTemplates[0].metadata = { adx_type: 756150000 };
  const failed = await fetch(app.url + '/');
  assert.equal(failed.status, 500);
  const failedBody = await failed.text();
  assert.match(failedBody, /Error ID # \[/);
  assert.match(failedBody, /"MessageCode": "RTGE01"/);
});
