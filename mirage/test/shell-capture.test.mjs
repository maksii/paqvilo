import test from 'node:test';
import assert from 'node:assert/strict';
import { registerShellConventions } from '../lib/extensions.mjs';
// A neutral footer logo container class (packs declare their own).
registerShellConventions('test', { footerLogoClass: 'site-footer-logos' });
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssetCache } from '../lib/asset-cache.mjs';
import { capturePortalShell, extractShellReferences } from '../lib/shell-capture.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const origin = 'https://portal.example.test',
  cdn = 'https://content.powerapps.com';
const htmlResponse = (html) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(html),
});
const page = (head, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test('Bootstrap 5 postpreform bundles are retained as native runtime resources', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-v5-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = '/resource/powerappsportal/dist/postpreform.BootstrapV5.bundle-abcdef.js';
  const live = livePage(page('<link rel="stylesheet" href="/platform.css">', `<script src="${script}"></script>`), {
    '/platform.css': { type: 'text/css', body: 'body{}' },
    [script]: { type: 'text/javascript', body: 'window.jQuery.timeago=function(){};' },
  });
  const cache = await new AssetCache({ directory: join(directory, 'cache'), origin }).init();
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.ok(
    report.captured.some((row) => row.path === script),
    JSON.stringify(report),
  );
});

test('external jQuery and local CSS external dependencies remain visible without blocking platform capture', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-external-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'local.css');
  await writeFile(file, '@font-face{src:url("https://fonts.example.test/font.woff2")}');
  const live = livePage(
    page(
      '<link rel="stylesheet" href="/platform.css"><link rel="stylesheet" href="/local.css"><script src="https://scripts.example.test/jquery-3.7.1.min.js"></script>',
    ),
    {
      '/platform.css': { type: 'text/css', body: 'body{}' },
    },
  );
  const cache = await new AssetCache({ directory: join(directory, 'cache'), origin }).init();
  const report = await capturePortalShell(cache, live, {
    path: '/workspace/',
    portal: { webFiles: [{ url: '/local.css', file }] },
  });
  assert.equal(report.ready, true);
  assert.equal(report.complete, true);
  assert.equal(report.shellProfile.platformStyles.mode, 'captured');
  assert.ok(report.diagnostics.some((item) => item.code === 'SHELL_EXTERNAL_JQUERY'));
  assert.ok(
    report.diagnostics.some((item) => item.code === 'SHELL_EXTERNAL_LOCAL_DEPENDENCY' && item.path === '/font.woff2'),
  );
  assert.deepEqual(
    live.calls.map((item) => item.path),
    ['/workspace/', '/platform.css'],
  );
});

test('CSS relative URLs resolve identically with single, double and no quotes', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-quotes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = livePage(page('<link rel="stylesheet" href="/css/style.css"><script src="/jquery.js"></script>'), {
    '/css/style.css': {
      type: 'text/css',
      body: 'a{background:url(images/icon.png)}b{background:url(\'images/icon.png\')}c{background:url("images/icon.png")}',
    },
    '/css/images/icon.png': { type: 'image/png', body: 'synthetic' },
    '/jquery.js': { type: 'text/javascript', body: 'window.jQuery={};' },
  });
  const cache = await new AssetCache({ directory, origin }).init();
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.captured.filter((item) => item.path.endsWith('.png')).map((item) => item.path),
    ['/css/images/icon.png'],
  );
  assert.equal(live.calls.filter((item) => item.path === '/css/images/icon.png').length, 1);
});

test('optional third-party shell failures do not prevent applying captured platform styles', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-optional-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = livePage(
    page(
      '<link rel="stylesheet" href="/platform.css"><script src="/jquery.js"></script><link rel="stylesheet" href="https://optional.example.test/theme.css">',
    ),
    {
      '/platform.css': { type: 'text/css', body: 'body{}' },
      '/jquery.js': { type: 'text/javascript', body: 'window.jQuery={};' },
    },
  );
  const cache = await new AssetCache({ directory, origin }).init();
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.equal(report.ready, true);
  assert.equal(report.complete, false);
  assert.equal(report.shellProfile.platformStyles.mode, 'captured');
  assert.ok(report.failures.some((item) => item.optional && item.code === 'SHELL_RESOURCE_ORIGIN'));
});

test('stylesheet capture accepts a loaded jQuery library with an authored filename', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-library-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = livePage(page('<link rel="stylesheet" href="/style.css"><script src="/project-library.js"></script>'), {
    '/style.css': { type: 'text/css', body: 'body{}' },
  });
  const evaluated = [];
  live.context.pages = () => [
    {
      url: () => origin + '/workspace/',
      evaluate: async (fn) => {
        evaluated.push(fn);
        return '3.6.2';
      },
    },
  ];
  const cache = await new AssetCache({ directory, origin }).init();
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.equal(report.complete, true);
  assert.equal(report.ready, true);
  assert.equal(evaluated.length, 1);
  assert.ok(report.diagnostics.some((item) => item.code === 'SHELL_JQUERY_OBSERVED' && item.version === '3.6.2'));
  assert.ok(!report.failures.some((item) => item.code === 'SHELL_JQUERY_MISSING'));
});

test('a shell without an observed jQuery provider cannot be applied', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-no-library-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = livePage(page('<link rel="stylesheet" href="/style.css">'), {
    '/style.css': { type: 'text/css', body: 'body{}' },
  });
  const cache = await new AssetCache({ directory, origin }).init();
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.equal(report.ready, false);
  assert.ok(report.failures.some((item) => item.code === 'SHELL_JQUERY_MISSING' && item.blocking));
});

test('UTF-16 PAC stylesheet attachments capture their browser font dependencies', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-utf16-'));
  try {
    const file = join(directory, 'bootstrap.css');
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('@font-face{src:url("fonts/icons.woff2")}', 'utf16le')]),
    );
    const live = livePage(page('<link rel="stylesheet" href="/bootstrap.css"><script src="/jquery.min.js"></script>'), {
      '/jquery.min.js': {
        type: 'text/javascript',
        body: 'window.jQuery={};',
      },
      '/fonts/icons.woff2': { type: 'font/woff2', body: 'font fixture' },
    });
    const cache = await new AssetCache({
      directory: join(directory, 'assets'),
      origin,
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
      portal: { webFiles: [{ url: '/bootstrap.css', file }] },
    });
    assert.equal(result.complete, true);
    assert.ok(result.captured.some((item) => item.path === '/fonts/icons.woff2'));
    assert.equal((await cache.get('/fonts/icons.woff2', { origin })).body.toString(), 'font fixture');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed Moment dependency keeps its native phase before page content', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-moment-'));
  try {
    const moment = '/resource/powerappsportal/dist/preform.moment_2_29_4.bundle-example.js';
    const live = livePage(
      page(
        '<link rel="stylesheet" href="/style.css"><script src="/jquery.js"></script>',
        `<script src="${moment}"></script>`,
      ),
      {
        '/style.css': { type: 'text/css', body: 'body{}' },
        '/jquery.js': { type: 'text/javascript', body: 'window.jQuery={};' },
        [moment]: {
          type: 'text/javascript',
          body: 'window.moment=function(){};',
        },
      },
    );
    const cache = await new AssetCache({
      directory: join(directory, 'cache'),
      origin,
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.beforeContentScripts, [moment]);
    assert.ok(result.captured.some((item) => item.path === moment));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('GUID-addressed PCF resources cache only verified static script or stylesheet responses', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-pcf-cache-'));
  try {
    const css = '/_pcfwebresource/11111111-1111-1111-1111-111111111111';
    const js = '/_pcfwebresource/22222222-2222-2222-2222-222222222222';
    const bad = '/_pcfwebresource/33333333-3333-3333-3333-333333333333';
    const live = livePage('', {
      [css]: { type: 'text/css', body: '.editor{}' },
      [js]: { type: 'application/x-javascript', body: 'window.editor={};' },
      [bad]: { type: 'text/html', body: '<html>Sign in</html>' },
    });
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await cache.capture([css, js, bad, '/_pcfwebresource/not-a-guid', '/arbitrary.pcf'], live);
    assert.equal(result.captured.length, 2);
    assert.equal(result.failures.length, 3);
    const reopened = await new AssetCache({ directory, origin }).init();
    assert.equal((await reopened.get(css, { origin })).body.toString(), '.editor{}');
    assert.equal((await reopened.get(js, { origin })).body.toString(), 'window.editor={};');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
function livePage(html, assets = {}) {
  const calls = [];
  return {
    origin,
    context: {},
    calls,
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === '/workspace/') return htmlResponse(html);
      const asset = assets[path];
      return asset
        ? {
            status: 200,
            headers: { 'content-type': asset.type },
            body: Buffer.from(asset.body),
          }
        : {
            status: 404,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from('Missing'),
          };
    },
  };
}

test('observed extensionless managed styles require CSS bytes and retain capture bounds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pp-shell-pcf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const style = '/_pcfwebresource/11111111-1111-1111-1111-111111111111?v=2&locale=en';
  const cache = await new AssetCache({ directory, origin }).init();
  const capture = async (href, asset) => {
    const live = livePage(
      page(
        `<link rel="stylesheet" href="${href}"><link rel="stylesheet" href="${href}"><script src="/jquery.js"></script>`,
      ),
      { [href]: asset, '/jquery.js': { type: 'application/javascript', body: 'window.jQuery={};' } },
    );
    return { report: await capturePortalShell(cache, live, { path: '/workspace/' }), live };
  };
  const { report, live } = await capture(style, {
    type: 'text/css; charset=utf-8',
    body: '.editor{color:blue}',
  });
  assert.equal(report.ready, true);
  assert.deepEqual(report.shellProfile.stylesheets, [style]);
  assert.equal(live.calls.filter((call) => call.path === style).length, 1);
  assert.equal((await cache.get(style)).body.toString(), '.editor{color:blue}');
  for (const type of ['text/html', 'application/javascript', 'application/json']) {
    const rejected = await capture(style, {
      type,
      body: type === 'text/html' ? '<html>Wrong</html>' : 'window.bad=1;',
    });
    assert.equal(rejected.report.ready, false, type);
    assert.equal(rejected.report.failures.filter((failure) => failure.blocking).length, 1, 'duplicates fetch once');
    assert.equal(rejected.report.failures[0].code, 'ASSET_CONTENT_TYPE');
    assert.equal(
      (await cache.get(style)).body.toString(),
      '.editor{color:blue}',
      'failed replacement retains verified bytes',
    );
  }
  const missing = await capture(style, undefined);
  assert.equal(missing.report.failures[0].code, 'NATIVE_ASSET_HTTP');
  assert.equal(missing.report.failures[0].originStatus, 404);
  assert.deepEqual(missing.report.shellProfile.stylesheets, []);
  const large = await capture(style, { type: 'text/css', body: 'a'.repeat(20 * 1024 * 1024 + 1) });
  assert.equal(large.report.ready, false);
  assert.equal((await cache.get(style)).body.toString(), '.editor{color:blue}');
  for (const href of [
    '/_pcfwebresource/not-a-guid',
    style + '&access_token=DO_NOT_LOG',
    'https://user:DO_NOT_LOG@portal.example.test' + style,
    'https://outside.example.test' + style,
  ]) {
    const rejected = await capture(href, { type: 'text/css', body: 'body{}' });
    assert.ok(rejected.report.failures.length, href.split('?')[0]);
    assert.equal(rejected.live.calls.length, 2, 'only the document and jQuery are fetched');
    assert.ok(!JSON.stringify(rejected.report).includes('DO_NOT_LOG'));
  }
});

test('a failed shell refresh retains previous asset bytes and the on-disk manifest, including valid siblings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pp-shell-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const style = '/_pcfwebresource/11111111-1111-1111-1111-111111111111';
  const cache = await new AssetCache({ directory, origin }).init();
  const first = livePage(page(`<link rel="stylesheet" href="${style}"><script src="/jquery.js"></script>`), {
    [style]: { type: 'text/css', body: 'body{color:blue}' },
    '/jquery.js': { type: 'application/javascript', body: 'window.jQuery={revision:1};' },
  });
  assert.equal((await capturePortalShell(cache, first, { path: '/workspace/' })).ready, true);
  const manifest = await readFile(join(directory, 'manifest.json'));
  const failed = livePage(
    page(
      `<link rel="stylesheet" href="${style}"><script src="/jquery.js"></script><link rel="stylesheet" href="/bad.css?access_token=DO_NOT_LOG">`,
    ),
    {
      [style]: { type: 'text/css', body: 'body{color:red}' },
      '/jquery.js': { type: 'application/javascript', body: 'window.jQuery={revision:2};' },
    },
  );
  assert.equal((await capturePortalShell(cache, failed, { path: '/workspace/' })).ready, false);
  assert.equal((await cache.get(style)).body.toString(), 'body{color:blue}');
  assert.equal((await cache.get('/jquery.js')).body.toString(), 'window.jQuery={revision:1};');
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifest);
  const reopened = await new AssetCache({ directory, origin }).init();
  assert.equal((await reopened.get(style)).body.toString(), 'body{color:blue}');
});

test('asset publication waits for acceptance, rolls back failed state publication and serializes other captures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pp-asset-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = await new AssetCache({ directory, origin }).init();
  const bridge = livePage('', {
    '/one.css': { type: 'text/css', body: 'a{color:blue}' },
    '/two.css': { type: 'text/css', body: 'b{}' },
  });
  await cache.capture(['/one.css'], bridge);
  const before = await readFile(join(directory, 'manifest.json'));
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const pending = cache.transaction(
    async (staged) => {
      await staged.capture(['/one.css'], livePage('', { '/one.css': { type: 'text/css', body: 'a{color:red}' } }));
      entered.resolve();
      await release.promise;
      return { ready: true };
    },
    {
      publish: () => {
        throw Error('Invented state persistence failure');
      },
    },
  );
  await entered.promise;
  assert.equal((await cache.get('/one.css')).body.toString(), 'a{color:blue}', 'pending bytes are invisible');
  let secondFinished = false;
  const secondEntered = Promise.withResolvers(),
    secondRelease = Promise.withResolvers();
  t.after(() => secondRelease.resolve());
  const second = cache
    .transaction(async (staged) => {
      secondEntered.resolve();
      await secondRelease.promise;
      return staged.capture(['/two.css'], bridge);
    })
    .then(() => {
      secondFinished = true;
    });
  assert.equal(secondFinished, false);
  release.resolve();
  await assert.rejects(pending, /Invented state persistence failure/);
  await secondEntered.promise;
  assert.deepEqual(
    await readFile(join(directory, 'manifest.json')),
    before,
    'The exact prior manifest is durable before the next capture publishes',
  );
  assert.equal(
    (await readdir(directory)).filter((file) => file.startsWith('staging-')).length,
    1,
    'Only the independently held second capture retains a staging directory',
  );
  secondRelease.resolve();
  await second;
  assert.equal((await cache.get('/one.css')).body.toString(), 'a{color:blue}');
  assert.equal(
    (await new AssetCache({ directory, origin }).init()).entries[Object.keys(cache.entries)[0]].sha256,
    cache.entries[Object.keys(cache.entries)[0]].sha256,
  );
  assert.equal((await cache.get('/two.css')).body.toString(), 'b{}');
});

test('failed manifest persistence leaves no new blobs, entries or staging directories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pp-shell-manifest-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = await new AssetCache({ directory, origin }).init();
  const live = livePage('', { '/one.css': { type: 'text/css', body: 'a{}' } });
  await cache.capture(['/one.css'], live);
  const files = (await readdir(directory)).sort(),
    manifest = await readFile(join(directory, 'manifest.json'));
  cache.save = async () => {
    throw Error('Invented manifest failure');
  };
  await assert.rejects(
    cache.transaction((staged) =>
      staged.capture(['/one.css'], livePage('', { '/one.css': { type: 'text/css', body: 'a{color:red}' } })),
    ),
    /Invented manifest failure/,
  );
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifest);
  assert.deepEqual((await readdir(directory)).sort(), files);
  assert.equal((await cache.get('/one.css')).body.toString(), 'a{}');
});

test('shell styles retain media and repeated cascade placements while origin collisions roll back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pp-shell-cascade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = await new AssetCache({ directory, origin }).init();
  const live = livePage(
    page(
      '<link rel="stylesheet" href="/a.css" media="screen"><link rel="stylesheet" href="/b.css"><link rel="stylesheet" href="/a.css" media="print"><link rel="stylesheet" href="/a.css" media="screen"><script src="/jquery.js"></script>',
    ),
    {
      '/a.css': { type: 'text/css', body: 'a{}' },
      '/b.css': { type: 'text/css', body: 'b{}' },
      '/jquery.js': { type: 'text/javascript', body: 'window.jQuery={};' },
    },
  );
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.equal(report.ready, true);
  assert.deepEqual(report.shellProfile.stylesheets, [
    { href: '/a.css', media: 'screen' },
    '/b.css',
    { href: '/a.css', media: 'print' },
    { href: '/a.css', media: 'screen' },
  ]);
  assert.equal(live.calls.filter((item) => item.path === '/a.css').length, 1);
  const before = await readFile(join(directory, 'manifest.json'));
  const collision = '/resource/powerappsportal/collision.css';
  const conflicting = livePage(
    page(
      `<link rel="stylesheet" href="${collision}"><link rel="stylesheet" href="${cdn + collision}"><script src="/jquery.js"></script>`,
    ),
    {
      [collision]: { type: 'text/css', body: 'a{color:red}' },
      '/jquery.js': { type: 'text/javascript', body: 'window.jQuery={};' },
    },
  );
  const rejected = await capturePortalShell(cache, conflicting, { path: '/workspace/' });
  assert.equal(rejected.ready, false);
  assert.ok(rejected.failures.some((item) => item.code === 'SHELL_RESOURCE_COLLISION' && item.blocking));
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), before);
});

test('observed shell capture preserves order, source assets and safe platform resources without persisting page or inline data', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-'));
  try {
    const localCss = join(directory, 'local.css');
    await writeFile(localCss, 'body{background:url(/local.png)}');
    const localJs = join(directory, 'jquery.js'),
      localPng = join(directory, 'local.png');
    await writeFile(localJs, 'window.syntheticJquery=true;');
    await writeFile(localPng, Buffer.from([1, 2, 3]));
    const html = page(
      '<link rel="stylesheet" href="/bootstrap.min.css"><link href="https://content.powerapps.com/resource/powerappsportal/dist/preform.css" rel="stylesheet"><link rel="stylesheet" href="/theme.css?version=1&amp;locale=en"><script src="/jquery-3.3.1.min.js"></script><script>const secret="INLINE_TOKEN_DO_NOT_SAVE"; const fake="<link rel=stylesheet href=/fake.css>";</script>',
      '<script src="/source-business.js"></script><script src="https://content.powerapps.com/resource/powerappsportal/dist/bootstrap.bundle.js" defer></script><input name="__RequestVerificationToken" value="PAGE_TOKEN_DO_NOT_SAVE">',
    );
    const live = livePage(html);
    const fetched = [];
    const cache = await new AssetCache({
      directory: join(directory, 'cache'),
      origin,
      fetchImpl: async (url, options) => {
        fetched.push({ url, options });
        return url.endsWith('.css')
          ? new Response('@font-face{src:url(../fonts/font.woff)}', {
              headers: { 'content-type': 'text/css' },
            })
          : url.endsWith('.woff')
            ? new Response(new Uint8Array([1, 2, 3]), {
                headers: { 'content-type': 'font/woff' },
              })
            : new Response('window.bootstrapExample=true;', {
                headers: { 'content-type': 'application/javascript' },
              });
      },
    }).init();
    const portal = {
      webFiles: [
        { url: '/bootstrap.min.css', file: localCss },
        { url: '/theme.css', file: localCss },
        { url: '/jquery-3.3.1.min.js', file: localJs },
        { url: '/local.png', file: localPng },
      ],
      templates: {},
      snippets: {},
    };
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
      portal,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.stylesheets, [
      '/bootstrap.min.css',
      '/resource/powerappsportal/dist/preform.css',
      '/theme.css?version=1&locale=en',
    ]);
    assert.deepEqual(result.shellProfile.headScripts, ['/jquery-3.3.1.min.js']);
    assert.deepEqual(result.shellProfile.afterFooterScripts, [
      {
        src: '/resource/powerappsportal/dist/bootstrap.bundle.js',
        defer: true,
      },
    ]);
    assert.equal(result.captured.length, 3);
    assert.deepEqual(live.calls, [{ path: '/workspace/', options: { method: 'GET' } }]);
    assert.equal(
      fetched.every((c) => c.options.credentials === 'omit'),
      true,
    );
    assert.equal(
      result.diagnostics.some((d) => d.code === 'SHELL_BUSINESS_SCRIPT_EXCLUDED'),
      true,
    );
    const manifest = await readFile(join(directory, 'cache', 'manifest.json'), 'utf8');
    for (const secret of ['INLINE_TOKEN_DO_NOT_SAVE', 'PAGE_TOKEN_DO_NOT_SAVE', 'source-business.js', 'fake.css'])
      assert.equal(manifest.includes(secret), false);
    assert.equal(
      fetched.some((c) => !c.url.startsWith(cdn + '/resource/powerappsportal/')),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shell capture excludes exported template references and follows same-origin CSS font dependencies', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-'));
  try {
    const html = page(
      '<link href="/platform.css" rel="stylesheet" media="screen"><script src="/jquery.min.js"></script>',
      '<script src="/bootstrap.bundle.js" async type="module"></script>',
    );
    const live = livePage(html, {
      '/platform.css': {
        type: 'text/css',
        body: '@font-face{src:url(/font.woff?#iefix)}',
      },
      '/font.woff': { type: 'font/woff', body: Buffer.from([3, 4]) },
      '/jquery.min.js': {
        type: 'application/javascript',
        body: 'window.localjQuery=true;',
      },
      '/bootstrap.bundle.js': {
        type: 'application/javascript',
        body: 'window.localBootstrap=true;',
      },
    });
    const cache = await new AssetCache({ directory, origin }).init();
    const portal = {
      snippets: { 'Head/Bottom': '<script src="/jquery.min.js"></script>' },
      templates: {},
    };
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
      portal,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.stylesheets, [{ href: '/platform.css', media: 'screen' }]);
    assert.deepEqual(result.shellProfile.headScripts, []);
    assert.deepEqual(result.shellProfile.afterFooterScripts, [
      { src: '/bootstrap.bundle.js', async: true, type: 'module' },
    ]);
    assert.equal(
      result.captured.some((a) => a.path === '/font.woff?'),
      false,
    );
    assert.equal(
      result.captured.some((a) => a.path === '/font.woff'),
      true,
    );
    assert.equal(
      result.diagnostics.some((d) => d.code === 'SHELL_LOCAL_SOURCE_REFERENCE'),
      true,
    );
    assert.equal(
      live.calls.every((c) => c.options.method === 'GET'),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing, non-static, credential and cross-origin shell resources produce explicit failures without fetching excluded URLs', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-'));
  try {
    const html = page(
      '<link rel="stylesheet" href="/missing.css"><link rel="stylesheet" href="/style-endpoint"><link rel="stylesheet" href="https://other.test/style.css"><script src="/jquery.min.js?access_token=SECRET_VALUE"></script><script src="https://content.powerapps.com/elsewhere/bootstrap.js"></script>',
    );
    const live = livePage(html);
    const cache = await new AssetCache({
      directory,
      origin,
      fetchImpl: () => {
        throw new Error('CDN fetch must not occur');
      },
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
    });
    assert.equal(result.complete, false);
    assert.equal(
      result.failures.some((f) => f.code === 'NATIVE_ASSET_HTTP' && !f.blocking),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === 'SHELL_RESOURCE_TYPE'),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === 'SHELL_RESOURCE_ORIGIN'),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === 'SHELL_RESOURCE_CREDENTIAL'),
      true,
    );
    assert.equal(
      result.failures.some((f) => f.code === 'SHELL_JQUERY_MISSING' && f.blocking),
      true,
    );
    assert.equal(JSON.stringify(result).includes('SECRET_VALUE'), false);
    assert.deepEqual(
      live.calls.map((c) => c.path),
      ['/workspace/', '/missing.css'],
    );
    assert.equal(cache.manifest().assets.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shell capture rejects disconnected browsers, non-HTML responses and sign-in pages before any static capture', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-'));
  try {
    const cache = await new AssetCache({ directory, origin }).init();
    await assert.rejects(capturePortalShell(cache, { origin }, { path: '/workspace/' }), (e) => e.status === 409);
    const live = livePage(
      '<html><head><title>Sign in</title></head><body><form action="/SignIn"><input type="password"></form></body></html>',
    );
    await assert.rejects(capturePortalShell(cache, live, { path: '/workspace/' }), (e) => e.status === 401);
    const jsonLive = {
      origin,
      context: {},
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}'),
      }),
    };
    await assert.rejects(capturePortalShell(cache, jsonLive, { path: '/workspace/' }), (e) => e.status === 502);
    await assert.rejects(capturePortalShell(cache, live, { path: '/../workspace/' }), (e) => e.status === 400);
    assert.equal(cache.manifest().assets.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('password markup in source scripts or hidden portal controls does not mark an observed business page as sign-in', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-'));
  try {
    const html = page(
      '<title>Workspace</title><link href="/theme.css" rel="stylesheet"><script src="/jquery.min.js"></script><script>const literal="<title>Sign in</title><input type=password>";</script>',
      '<div hidden><input type="password" id="portal-managed-control"></div>',
    );
    const live = livePage(html, {
      '/theme.css': { type: 'text/css', body: 'body{color:black}' },
      '/jquery.min.js': {
        type: 'application/javascript',
        body: 'window.jqueryExample=true;',
      },
    });
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
    });
    assert.equal(result.complete, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('known platform ResourceManager label dictionaries are captured as JavaScript without a jQuery assumption', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-'));
  try {
    const manager = '/_portal/11111111-1111-1111-1111-111111111111/Resources/ResourceManager';
    const live = livePage(
      page(
        `<script src="${manager}?version=123"></script><link href="/theme.css" rel="stylesheet"><script src="/scripts/jquery.min.js"></script>`,
      ),
      {
        [manager + '?version=123']: {
          type: 'application/javascript',
          body: 'window.ResourceManager={label:"Synthetic label"};',
        },
        '/theme.css': { type: 'text/css', body: 'body{color:black}' },
        '/scripts/jquery.min.js': {
          type: 'application/javascript',
          body: 'window.syntheticJquery=true;',
        },
      },
    );
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.shellProfile.headScripts, [manager + '?version=123', '/scripts/jquery.min.js']);
    const restored = await new AssetCache({ directory, origin }).init();
    assert.match((await restored.get(manager + '?version=123')).body.toString(), /ResourceManager/);
    assert.equal(await restored.get('/_portal/other/Resources/ResourceManager'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTML browser parsing handles unquoted apostrophes without swallowing following runtime references', () => {
  const html = page(
    '<link rel="stylesheet" href="/theme.css">',
    '<a href=/account title=User\'s>Account</a><script src="/scripts/jquery.min.js" type="text/javascript"></script><script src="/xrm-adx/js/jquery-ui-1.11.4.min.js"></script><!--<script src="/comment.js"></script>--><template><script src="/inert.js"></script></template><script>const fake="<script src=/literal.js>";</script>',
  );
  const refs = extractShellReferences(html);
  assert.deepEqual(
    refs.filter((r) => r.kind === 'script').map((r) => r.value),
    ['/scripts/jquery.min.js', '/xrm-adx/js/jquery-ui-1.11.4.min.js'],
  );
  assert.equal(
    refs.filter((r) => r.kind === 'script').every((r) => r.position === 'bodyScripts'),
    true,
  );
});

test('excluded managed platform scripts are identified without claiming their source is exported business code', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-'));
  try {
    const live = livePage(
      page(
        '<link href="/theme.css" rel="stylesheet"><script src="/jquery.min.js"></script>',
        '<script src="https://content.powerapps.com/resource/powerappsportal/dist/pcf.bundle.js"></script>',
      ),
      {
        '/theme.css': { type: 'text/css', body: 'body{color:black}' },
        '/jquery.min.js': {
          type: 'application/javascript',
          body: 'window.jqueryExample=true;',
        },
      },
    );
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
    });
    const excluded = result.diagnostics.find((d) => d.code === 'SHELL_PLATFORM_SCRIPT_EXCLUDED');
    assert.ok(excluded);
    assert.match(excluded.message, /no runtime parity/);
    assert.equal(
      result.diagnostics.some((d) => d.code === 'SHELL_BUSINESS_SCRIPT_EXCLUDED'),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('metadata-only exported scripts are captured and CSS dependency failures remain explicit on a ready shell', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-metadata-'));
  try {
    const html = page(
      '<link rel="stylesheet" href="/theme.css"><script src="/jquery.min.js"></script><script src="/exported.js"></script>',
    );
    const live = livePage(html, {
      '/theme.css': {
        type: 'text/css',
        body: '@font-face{font-family:unused;src:url(/obsolete.woff)}',
      },
      '/jquery.min.js': {
        type: 'text/javascript',
        body: 'window.syntheticJquery=true;',
      },
      '/exported.js': {
        type: 'text/javascript',
        body: 'window.syntheticBusiness=true;',
      },
      '/scripts/deferred.js': {
        type: 'text/javascript',
        body: 'window.syntheticDeferred=true;',
      },
    });
    const portal = {
      webFiles: [{ url: '/jquery.min.js' }, { url: '/exported.js' }],
      snippets: { 'Head/Bottom': '<script src="/exported.js"></script>' },
      pages: [{ id: 'scripts', url: '/scripts/' }],
      records: [
        {
          kind: 'webfile',
          adx_partialurl: 'deferred.js',
          adx_parentpageid: 'scripts',
        },
      ],
      forms: [{ js: '$.getScript("/scripts/deferred.js", function() {});' }],
    };
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
      portal,
    });
    assert.equal(result.ready, true);
    assert.equal(result.complete, true);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].path, '/obsolete.woff');
    assert.equal(result.failures[0].dependency, true);
    assert.equal(result.failures[0].code, 'NATIVE_ASSET_HTTP');
    assert.equal(result.failures[0].originStatus, 404);
    assert.equal(result.failures[0].nativeOriginFailed, true);
    assert.ok(await cache.get('/jquery.min.js'));
    assert.ok(await cache.get('/exported.js'));
    assert.ok(await cache.get('/scripts/deferred.js'));
    assert.equal(result.shellProfile.headScripts.includes('/exported.js'), false);
    const missing = livePage(html, {
      '/theme.css': { type: 'text/css', body: 'body{}' },
      '/exported.js': {
        type: 'text/javascript',
        body: 'window.syntheticBusiness=true;',
      },
    });
    const failed = await capturePortalShell(cache, missing, {
      path: '/workspace/',
      portal,
    });
    assert.equal(failed.ready, false);
    assert.ok(failed.failures.some((f) => f.path === '/jquery.min.js' && f.dependency === false));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shell capture binds observed footer sizing and notification presentation without native item content', async () => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-static-widgets-'));
  try {
    const sourceCss = '.site-footer-logos svg {max-height:5rem}',
      file = join(directory, 'theme.css');
    await writeFile(file, sourceCss);
    const footer = '<footer><section class="site-footer-logos"><svg><path d="M0 0"/></svg></section></footer>';
    const header = '<header><ul><li class="userProfileHolder">Local identity</li></ul></header>';
    const widget =
      '<li class="userProfileHolder"><a href="#"><svg width="14" height="16"><path d="M1 1"/></svg><span class="notificationsCount" style="font-size:12px">3</span></a><ul class="alerts-dropdown"><li>PRIVATE NATIVE CONTENT</li></ul></li>';
    const live = livePage(
      page('<link rel="stylesheet" href="/theme.css"><script src="/jquery.js"></script>', footer + widget),
      {
        '/theme.css': {
          type: 'text/css',
          body: '.site-footer-logos svg {width:auto;max-height:5rem}',
        },
        '/jquery.js': { type: 'text/javascript', body: 'window.jQuery={};' },
      },
    );
    const cache = await new AssetCache({
      directory: join(directory, 'cache'),
      origin,
    }).init();
    const result = await capturePortalShell(cache, live, {
      path: '/workspace/',
      portal: {
        website: {
          adx_footerwebtemplateid: 'footer',
          adx_headerwebtemplateid: 'header',
        },
        templates: { footer: { source: footer }, header: { source: header } },
        webFiles: [{ url: '/theme.css', file }],
      },
    });
    assert.equal(result.complete, true);
    assert.equal(result.shellProfile.footerLogos.layout.svgWidth, 'auto');
    assert.ok(result.shellProfile.headerNotifications);
    assert.doesNotMatch(JSON.stringify(result.shellProfile), /PRIVATE|Local identity/);
    assert.equal(await cache.get('/theme.css', { origin }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const variant of ['', '.BootstrapV5'])
  test(`captured preform${variant} supplies jQuery without a standalone script`, async (t) => {
    const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-preform-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bundle = `/resource/powerappsportal/dist/preform${variant}.moment_2_29_4.bundle-abcdef.js`;
    const manager = '/_portal/11111111-1111-1111-1111-111111111111/Resources/ResourceManager';
    const source = variant ? cdn + bundle : bundle;
    const live = livePage(
      page(
        `<link rel="stylesheet" href="/style.css"><script src="${manager}"></script>`,
        `<script src="${source}"></script>`,
      ),
      {
        '/style.css': { type: 'text/css', body: 'body{}' },
        [manager]: { type: 'application/javascript', body: 'window.ResourceManager={label:"Synthetic"};' },
        [bundle]: {
          type: 'application/javascript',
          body: '(function(e){e.jQuery=e.$={fn:{jquery:"3.6.2"}}})(window);',
        },
      },
    );
    const cache = await new AssetCache({
      directory,
      origin,
      fetchImpl: async (url) => {
        assert.equal(url, cdn + bundle);
        return {
          status: 200,
          headers: { get: () => 'application/javascript' },
          arrayBuffer: async () => Buffer.from('window.jQuery=window.$={fn:{jquery:"3.6.2"}};'),
        };
      },
    }).init();
    const report = await capturePortalShell(cache, live, { path: '/workspace/' });
    assert.equal(report.ready, true);
    assert.equal(report.complete, true);
    assert.equal(report.shellProfile.jquery.source, bundle);
    assert.equal(report.shellProfile.jquery.kind, 'captured');
    assert.equal(report.shellProfile.jquery.sourceOrigin, variant ? cdn : origin);
    assert.match(report.shellProfile.jquery.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.shellProfile.beforeContentScripts, [bundle]);
    assert.ok(!report.failures.some((item) => item.code === 'SHELL_JQUERY_MISSING'));
  });

test('native unusable CSS and literal encoded-quote dependencies do not block; excluded URLs explain their host', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-unusable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = '/css/%22images%2Ficon.png%22';
  const live = livePage(
    page(
      '<link rel="stylesheet" href="/bad.css"><link rel="stylesheet" href="/css/style.css"><script src="/jquery.js"></script><link rel="stylesheet" href="https://content.powerapps.com/outside/theme.css?sig=DO_NOT_LOG"><script src="https://user:DO_NOT_LOG@excluded.example.test/script.js"></script>',
    ),
    {
      '/bad.css': { type: 'text/html', body: '<html><title>Not a stylesheet</title></html>' },
      '/css/style.css': { type: 'text/css', body: 'a{background:url(%22images%2Ficon.png%22)}' },
      '/jquery.js': { type: 'application/javascript', body: 'window.jQuery={};' },
    },
  );
  const cache = await new AssetCache({ directory, origin }).init();
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.equal(report.ready, false);
  assert.ok(
    report.failures.find((f) => f.path === '/bad.css' && f.code === 'NATIVE_ASSET_CONTENT_TYPE' && !f.blocking),
  );
  assert.ok(
    report.failures.find(
      (f) => f.path === image && f.code === 'NATIVE_ASSET_HTTP' && !f.blocking && f.originStatus === 404,
    ),
  );
  assert.ok(live.calls.some((call) => call.path === image));
  assert.ok(
    report.failures.find((f) => f.host === 'content.powerapps.com' && f.reason === 'disallowed origin' && f.blocking),
  );
  assert.ok(
    report.failures.find((f) => f.host === 'excluded.example.test' && f.reason === 'credentials' && f.blocking),
  );
  assert.ok(report.failures[0].blocking);
  assert.ok(!JSON.stringify(report).includes('DO_NOT_LOG'));
  assert.ok(!report.shellProfile.stylesheets.includes('/bad.css'));
  assert.equal(await cache.get('/bad.css'), null);
  const harmless = livePage(
    page(
      '<link rel="stylesheet" href="/bad.css"><link rel="stylesheet" href="/css/style.css"><script src="/jquery.js"></script>',
    ),
    {
      '/bad.css': { type: 'text/html', body: '<html>Not CSS</html>' },
      '/css/style.css': { type: 'text/css', body: 'a{background:url(%22images%2Ficon.png%22)}' },
      '/jquery.js': { type: 'application/javascript', body: 'window.jQuery={};' },
    },
  );
  const accepted = await capturePortalShell(cache, harmless, { path: '/workspace/' });
  assert.equal(accepted.ready, true);
  assert.equal(accepted.complete, true);
  assert.equal(accepted.shellProfile.platformStyles.mode, 'captured');
});

test('an unusable stylesheet version does not remove a captured sibling version', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'pp-shell-versions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = livePage(
    page(
      '<link rel="stylesheet" href="/theme.css?v=good"><link rel="stylesheet" href="/theme.css?v=bad"><script src="/jquery.js"></script>',
    ),
    {
      '/theme.css?v=good': { type: 'text/css', body: 'body{}' },
      '/theme.css?v=bad': { type: 'text/html', body: '<html>Not CSS</html>' },
      '/jquery.js': { type: 'application/javascript', body: 'window.jQuery={};' },
    },
  );
  const cache = await new AssetCache({ directory, origin }).init();
  const report = await capturePortalShell(cache, live, { path: '/workspace/' });
  assert.equal(report.ready, true);
  assert.deepEqual(report.shellProfile.stylesheets, ['/theme.css?v=good']);
  assert.ok(await cache.get('/theme.css?v=good'));
  assert.equal(await cache.get('/theme.css?v=bad'), null);
});
