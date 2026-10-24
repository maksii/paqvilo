import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { pageTemplateKind } from '../lib/importer.mjs';
import { resolvePageResources } from '../lib/page-resources.mjs';
import { webFileHeaders, platformResourceHeaders, notModified } from '../lib/response-headers.mjs';

function portal(type, source = 'WEB_TEMPLATE_SELECTED', mime = 'text/html') {
  return {
    website: {},
    settings: {},
    snippets: {},
    records: [],
    webFiles: [],
    weblinks: {},
    sitemarkers: {},
    pages: [
      {
        id: 'page',
        name: 'Invented page',
        title: 'Invented page',
        url: '/',
        pageTemplateId: 'layout',
        html: 'COPY_SELECTED',
        metadata: {},
      },
    ],
    pageTemplates: [
      {
        id: 'layout',
        name: 'Invented layout',
        webTemplateId: 'template',
        rewriteUrl: '~/Pages/FullPage.aspx',
        useHeaderFooter: false,
        metadata: { mspp_type: type },
      },
    ],
    templates: {
      template: { id: 'template', name: 'Unused or selected source', source, metadata: { mimetype: mime } },
    },
  };
}

test('explicit Rewrite selects the page copy and WebForms layout despite a populated web-template reference', async () => {
  const rewrite = portal(756150000);
  const rendered = await createPortalRenderer(rewrite).renderPage('/');
  assert.equal(rendered.status, 200);
  assert.equal(rendered.isDocument, true);
  assert.match(rendered.html, /COPY_SELECTED/);
  assert.match(rendered.html, /<form[^>]+id="content_form"/);
  assert.doesNotMatch(rendered.html, /WEB_TEMPLATE_SELECTED/);
  const resources = resolvePageResources(rewrite, rewrite.pages[0]);
  assert.equal(
    resources.webTemplates.some((row) => row.id === 'template'),
    false,
  );
  assert.equal(
    resources.unresolved.some((row) => row.kind === 'web-template' && row.via === 'page-template'),
    false,
  );
  assert.equal((await createPortalRenderer(portal(756150001)).renderPage('/')).html, 'WEB_TEMPLATE_SELECTED');
  assert.equal(pageTemplateKind({ webTemplateId: 'template', metadata: {} }), 'web-template');
  assert.equal(pageTemplateKind({ rewriteUrl: '~/Pages/FullPage.aspx', metadata: {} }), 'rewrite');
});

test('observed no-header response CRLF appends without trimming authored endings or corrupting JSON', async () => {
  for (const [mime, source] of [
    ['text/html', '<b>β</b>'],
    ['text/plain', 'β <>&'],
    ['application/json', '{"value":"β"}'],
  ]) {
    for (const ending of ['', '\n', '\r\n']) {
      const site = portal(756150001, source + ending, mime);
      assert.equal((await createPortalRenderer(site).renderPage('/')).html, source + ending);
      site.observed = { webTemplateResponseNewline: 'crlf', evidence: 'invented/response-bytes.json' };
      const rendered = await createPortalRenderer(site).renderPage('/');
      assert.equal(rendered.html, source + ending + '\r\n');
      assert.equal(rendered.contentType, mime + '; charset=utf-8');
      if (mime === 'application/json') assert.deepEqual(JSON.parse(rendered.html), { value: 'β' });
    }
  }
});

test('Rewrite expects a physical ASP.NET page rather than a populated portal route', async () => {
  const site = portal(756150000);
  site.pageTemplates[0].rewriteUrl = '~/known-portal-route/';
  const rendered = await createPortalRenderer(site).renderPage('/');
  assert.equal(rendered.status, 500);
  assert.match(rendered.html, /did not return an IHttpHandler/);
  assert.equal(rendered.diagnostics[0].code, 'INVALID_REWRITE_HANDLER');
  assert.doesNotMatch(rendered.html, /WEB_TEMPLATE_SELECTED|COPY_SELECTED/);
  site.pageTemplates[0].metadata.mspp_type = 756150001;
  assert.equal((await createPortalRenderer(site).renderPage('/')).html, 'WEB_TEMPLATE_SELECTED');
});

test('source MIME observation preserves text and binary media types and existing charset parameters', () => {
  for (const contentType of ['text/plain', 'image/png', 'application/octet-stream', 'text/plain; charset=iso-8859-1']) {
    const options = {
      body: Buffer.from([0, 255, 13, 10]),
      contentType,
      fileName: 'invented.bin',
      modified: '2026-01-01T00:00:00Z',
    };
    const source = webFileHeaders({ ...options, mimeCharset: 'source' });
    assert.equal(source['content-type'], contentType);
    assert.equal(source.etag, webFileHeaders(options).etag);
    assert.equal(source['content-disposition'], webFileHeaders(options)['content-disposition']);
  }
  assert.equal(
    webFileHeaders({ body: Buffer.alloc(0), contentType: 'image/png', fileName: 'invented.png' })['content-type'],
    'image/png; charset=utf-8',
  );
});

test('platform static files carry the local equivalent file time as Last-Modified and answer a matching conditional request', () => {
  const modified = Date.UTC(2026, 9, 6, 17, 43, 10);
  const headers = platformResourceHeaders('static', {
    pathname: '/xrm-adx/js/crmentityformview.js',
    body: 'x',
    contentType: 'application/javascript; charset=utf-8',
    modified,
  });
  assert.equal(headers['last-modified'], 'Tue, 06 Oct 2026 17:43:10 GMT');
  assert.equal(platformResourceHeaders('axd', { modified })['last-modified'], 'Tue, 06 Oct 2026 17:43:10 GMT');
  assert.equal(notModified({ 'if-none-match': headers.etag }, headers), true);
  assert.equal(notModified({ 'if-modified-since': 'Tue, 06 Oct 2026 17:43:10 GMT' }, headers), true);
  assert.equal(notModified({ 'if-modified-since': 'Mon, 05 Oct 2026 00:00:00 GMT' }, headers), false);
  // Without a file time the runtime start stays the fallback.
  assert.notEqual(platformResourceHeaders('static', { body: 'x' })['last-modified'], headers['last-modified']);
});
