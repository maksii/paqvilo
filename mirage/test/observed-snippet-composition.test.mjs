// @test-kind contract: Paqvilo's own snippet composition capture and resolution over invented snippets and fake pages
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  observedSnippetComposition,
  resolveSnippetComposition as resolve,
  captureObservedSnippetComposition,
} from '../lib/observed-snippet-composition.mjs';
const resolveSnippetComposition = (snippets, key, profiles) =>
  resolve(snippets, key, profiles, { origin: 'https://portal.example' });
const snippets = {
  empty: '<div class="empty"><p>Use filters</p></div>',
  action:
    '<button id="create" style="display:none;" title="Create"><svg width="20" height="20"><path d="M1 1"/></svg>Create</button>',
};
const capture = () =>
  observedSnippetComposition({
    snippets,
    parentName: 'empty',
    childName: 'action',
    observedMarkup: '<div class="empty"><p>Use filters</p>' + snippets.action.replace('display:none;', '') + '</div>',
    origin: 'https://portal.example',
    pagePath: '/owned/',
  });
test('observed composition uses existing exported action with its original hidden gate and source edits win', () => {
  const profile = capture();
  assert.doesNotMatch(JSON.stringify(profile), /<button|<div/);
  const result = resolveSnippetComposition(snippets, 'empty', [profile]);
  assert.match(result.source, /style="display:none;"/);
  assert.match(result.source, /<\/button><\/div>$/);
  assert.equal(
    resolveSnippetComposition({ ...snippets, action: snippets.action + ' ' }, 'empty', [profile]).diagnostic.code,
    'SNIPPET_COMPOSITION_SOURCE_CHANGED',
  );
  assert.equal(
    resolveSnippetComposition({ ...snippets, empty: '<div>Edited</div>' }, 'empty', [profile]).source,
    '<div>Edited</div>',
  );
  assert.throws(
    () => resolveSnippetComposition(snippets, 'empty', [{ ...profile, observedShapeSha256: 'bad' }]),
    /integrity/,
  );
});
test('unexpected native text/actions or executable source actions never create a composition', () => {
  assert.throws(
    () =>
      observedSnippetComposition({
        snippets,
        parentName: 'empty',
        childName: 'action',
        observedMarkup: '<div class="empty"><p>PRIVATE</p>' + snippets.action + '</div>',
      }),
    /differs/,
  );
  assert.throws(
    () =>
      observedSnippetComposition({
        snippets: {
          ...snippets,
          action: snippets.action.replace('title="Create"', 'onclick="save()"'),
        },
        parentName: 'empty',
        childName: 'action',
        observedMarkup: '<div/>',
      }),
    /unsupported/,
  );
});
test('native capture reads a page only and origin changes restore unmodified source', async () => {
  let reads = 0;
  const body = '<html><body><div class="empty"><p>Use filters</p>' + snippets.action + '</div></body></html>';
  const live = {
    context: {},
    origin: 'https://portal.example',
    request: async (path, options) => {
      reads++;
      assert.equal(options.method, 'GET');
      return { status: 200, headers: { 'content-type': 'text/html' }, body };
    },
  };
  const report = await captureObservedSnippetComposition(live, {
    portal: { snippets },
    path: '/owned/',
    parentName: 'empty',
    childName: 'action',
  });
  assert.equal(reads, 1);
  assert.equal(
    resolve(snippets, 'empty', [report.profile], {
      origin: 'https://other.example',
    }).diagnostic.code,
    'SNIPPET_COMPOSITION_ORIGIN_CHANGED',
  );
  assert.doesNotMatch(JSON.stringify(report), /<html|<p>|<button/);
  await assert.rejects(
    captureObservedSnippetComposition(live, {
      portal: { snippets },
      path: '/_api/items',
      parentName: 'empty',
      childName: 'action',
    }),
    /portal page/,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    captureObservedSnippetComposition({ ...live, context: null }, { portal: { snippets }, path: '/owned/' }),
    /connected/,
  );
});
test('dynamic native composition observation blocks every mutation and closes only its owned page', async () => {
  let route,
    closed = false,
    aborted = false;
  const page = {
    route: async (_pattern, callback) => (route = callback),
    goto: async () =>
      route({
        request: () => ({
          method: () => 'PATCH',
          url: () => 'https://portal.example/_api/contacts(id)',
        }),
        abort: () => (aborted = true),
        continue: () => assert.fail('Native write allowed'),
      }),
    locator: (selector) => {
      assert.match(selector, /div\[class="empty"\] > \[id="create"\]/);
      return {
        waitFor: async () => {},
        evaluate: async () => snippets.empty.replace('</div>', snippets.action + '</div>'),
      };
    },
    url: () => 'https://portal.example/owned/',
    close: async () => (closed = true),
  };
  const live = {
    origin: 'https://portal.example',
    context: { serviceWorkers: () => [], newPage: async () => page },
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: snippets.empty,
    }),
  };
  const result = await captureObservedSnippetComposition(live, {
    portal: { snippets },
    path: '/owned/',
    parentName: 'empty',
    childName: 'action',
  });
  assert.equal(result.observation.provider, 'native-browser-dom');
  assert.equal(aborted, true);
  assert.equal(closed, true);
  assert.deepEqual(result.observation.blockedRequests, [{ method: 'PATCH', path: '/_api/contacts(id)' }]);
  await assert.rejects(
    captureObservedSnippetComposition(
      {
        ...live,
        context: {
          ...live.context,
          serviceWorkers: () => [{ url: () => 'https://portal.example/sw.js' }],
        },
      },
      {
        portal: { snippets },
        path: '/owned/',
        parentName: 'empty',
        childName: 'action',
      },
    ),
    /service worker/,
  );
});

const ansiTimeout = () =>
  Object.assign(new Error('\u001b[2mlocator.waitFor: Timeout 10000ms exceeded.\u001b[22m'), { name: 'TimeoutError' });
const servedPage = (body, url) => ({
  context: {},
  origin: 'https://portal.example',
  request: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body, url }),
});
// @test-kind contract: page-independent snippet preconditions fail with their reason before any portal request.
test('Liquid snippets are refused with the composition reason before any request or browser work', async () => {
  let reads = 0,
    pages = 0;
  const live = {
    origin: 'https://portal.example',
    context: { serviceWorkers: () => [], newPage: async () => (pages++, assert.fail('browser used')) },
    request: async () => (reads++, { status: 200, headers: { 'content-type': 'text/html' }, body: '<html/>' }),
  };
  await assert.rejects(
    captureObservedSnippetComposition(live, {
      portal: { snippets: { ...snippets, empty: '<div class="empty">{{ user.fullname }}</div>' } },
      path: '/owned/',
      parentName: 'empty',
      childName: 'action',
    }),
    (error) => error.code === 'SNIPPET_COMPOSITION_INVALID' && /static exported snippets/.test(error.message),
  );
  assert.deepEqual([reads, pages], [0, 0]);
});
// @test-kind contract: a browser timeout keeps the served-HTML reasons and never forwards raw Playwright text.
test('a dynamic observation timeout reports the collected reasons without raw browser text', async () => {
  let closed = false;
  const page = {
    route: async () => {},
    goto: async () => {},
    locator: () => ({ waitFor: async () => Promise.reject(ansiTimeout()), evaluate: async () => '' }),
    url: () => 'https://portal.example/owned/',
    close: async () => (closed = true),
  };
  const body = '<html><body><div class="empty"><p>Other text</p>' + snippets.action + '</div></body></html>';
  const live = {
    ...servedPage(body),
    context: { serviceWorkers: () => [], newPage: async () => page },
  };
  await assert.rejects(
    captureObservedSnippetComposition(live, {
      portal: { snippets },
      path: '/owned/',
      parentName: 'empty',
      childName: 'action',
    }),
    (error) =>
      error.code === 'SNIPPET_COMPOSITION_INVALID' &&
      /did not render the parent snippet/.test(error.message) &&
      /differs beyond the existing exported action/.test(error.message) &&
      !error.message.includes(String.fromCodePoint(27)) &&
      !/Timeout 10000ms|locator\./.test(error.message),
  );
  assert.equal(closed, true);
});
// @test-kind contract: a 200 HTML sign-in page is not observed as portal content.
test('a served sign-in page is refused as the composition page', async () => {
  await assert.rejects(
    captureObservedSnippetComposition(servedPage('<html><body></body></html>', 'https://portal.example/SignIn'), {
      portal: { snippets },
      path: '/SignIn',
      parentName: 'empty',
      childName: 'action',
    }),
    (error) => error.code === 'SNIPPET_COMPOSITION_INVALID' && /sign-in page/.test(error.message),
  );
});
// @test-kind contract: a snippet name missing from the local sources is named, not reported as a Liquid snippet.
test('a missing exported snippet is named before any request', async () => {
  await assert.rejects(
    captureObservedSnippetComposition(servedPage('<html/>'), {
      portal: { snippets },
      path: '/owned/',
      parentName: 'empty',
      childName: 'Absent/Child',
    }),
    (error) =>
      error.code === 'SNIPPET_COMPOSITION_INVALID' && /Absent\/Child is not in the local sources/.test(error.message),
  );
});
