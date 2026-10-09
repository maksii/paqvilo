// Exercises the real verify command against disposable loopback fixtures, never a catalogue site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import verify, { diagnosticSnapshot } from '../lense/commands/verify.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { createFixture, HOME_ID, SITE } from '../test/fixture.mjs';

const PAGE_JS = 'window.fixturePage = "original";\n';
const PAGE_CSS = '.fixture-page { color: rgb(10, 20, 30); }\n';
const FORM_JS = 'window.fixtureForm = "original";\n';
const ADVANCED_JS = 'window.fixtureAdvancedStep = "original";\n';
const LIST_JS = 'window.fixtureList = "original";\n';
const TEMPLATE = '<header id="fixture-header">Fixture header content</header>\n';
const UNUSED_TEMPLATE = '{% if request.params.id %}\n<div class="fixture-shared-container">\n<p>Conditional content that is absent from the fixture page</p>\n</div>\n{% endif %}\n';
const SNIPPET = 'All fixture content remains isolated on this computer.';
const WEB_JS = 'window.fixtureWebFile = "original";\nqueueMicrotask(() => { if (window.__paqviloVerifyJs) console.error("fixture-post-edit-console-observation"); });\n';
const WEB_CSS = '.fixture-web { color: rgb(40, 50, 60); }\n';
const IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>';
const CSS_URL = '/theme space.css';
const IMAGE_URL = '/Badge mark.svg';
const CONFIGURATION_SNIPPET = 'a11b2222-c333-4444-5555-666666666666';
const JS_URL = '/scripts/app.js';
const escapeXml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function component(dir, id, type, name, content, attachment) {
  const rel = `powerpagecomponents/${id}/powerpagecomponent.xml`;
  write(dir, rel, `<powerpagecomponent powerpagecomponentid="${id}">\n<content>${escapeXml(JSON.stringify(content))}</content>\n<name>${escapeXml(name)}</name>\n<powerpagecomponenttype>${type}</powerpagecomponenttype>\n${attachment ? `<filecontent mimetype="${attachment.mime}">${escapeXml(attachment.name)}</filecontent>\n` : ''}</powerpagecomponent>`);
  if (attachment) write(dir, `powerpagecomponents/${id}/filecontent/${attachment.name}`, attachment.text);
}

async function fixture(t, layout, uncommittedInline = false) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-verify-acceptance-'));
  const classic = layout === 'classic' ? createFixture() : null;
  const sourceDir = classic?.dir ?? path.join(work, 'enhanced-source');
  const sourceFiles = [];
  if (classic) {
    for (const [rel, text] of [
      ['web-pages/home/content-pages/Home.en-US.webpage.custom_javascript.js', PAGE_JS],
      ['web-pages/home/content-pages/Home.en-US.webpage.custom_css.css', PAGE_CSS],
      ['basic-forms/contact/Contact.basicform.custom_javascript.js', FORM_JS],
      ['advanced-forms/application/steps/details/Details.advancedformstep.custom_javascript.js', ADVANCED_JS],
      ['lists/records/Records.list.custom_javascript.js', LIST_JS],
      ['web-templates/header/Header.webtemplate.source.html', TEMPLATE],
      ['web-templates/a-unused/Unused.webtemplate.source.html', UNUSED_TEMPLATE],
      ['content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html', SNIPPET],
      ['content-snippets/a-instrumentation/Instrumentation.en-US.contentsnippet.value.html', CONFIGURATION_SNIPPET],
      ['content-snippets/a-instrumentation/Instrumentation.en-US.contentsnippet.yml', 'adx_name: InstrumentationKey\n'],
      ['web-files/app.js', WEB_JS],
      ['web-files/theme space.css', WEB_CSS],
      ['web-files/Badge.svg', IMAGE],
      ['web-files/theme space.css.webfile.yml', `adx_name: theme space.css\nadx_partialurl: theme space.css\nadx_parentpageid: ${HOME_ID}\nfilename: theme space.css\n`],
      ['web-files/Badge.svg.webfile.yml', `adx_name: Badge\nadx_partialurl: Badge mark.svg\nadx_parentpageid: ${HOME_ID}\nfilename: Badge.svg\n`],
    ]) sourceFiles.push([write(sourceDir, rel, text), text]);
  } else {
    component(sourceDir, 'home', 2, 'Home', { isroot: true, partialurl: '/', customjavascript: PAGE_JS, customcss: PAGE_CSS });
    component(sourceDir, 'form', 15, 'Contact form', { customjavascript: FORM_JS, entityname: 'fixture_synthetic' });
    component(sourceDir, 'scripts', 2, 'Scripts', { isroot: true, partialurl: 'scripts', parentpageid: 'home' });
    component(sourceDir, 'template', 8, 'Header', { source: TEMPLATE });
    component(sourceDir, 'a-unused-template', 8, 'Unused conditional template', { source: UNUSED_TEMPLATE });
    component(sourceDir, 'snippet', 7, 'Footer/Text', { value: SNIPPET });
    component(sourceDir, 'a-instrumentation', 7, 'InstrumentationKey', { value: CONFIGURATION_SNIPPET });
    component(sourceDir, 'js', 3, 'App', { partialurl: 'app.js', parentpageid: 'scripts' }, { name: 'app.js', mime: 'application/javascript', text: WEB_JS });
    component(sourceDir, 'css', 3, 'Theme', { partialurl: 'theme space.css', parentpageid: 'home' }, { name: 'theme space.css', mime: 'text/css', text: WEB_CSS });
    component(sourceDir, 'image', 3, 'Badge', { partialurl: 'Badge mark.svg', parentpageid: 'home' }, { name: 'Badge.svg', mime: 'image/svg+xml', text: IMAGE });
    for (const id of ['home', 'form', 'scripts', 'template', 'a-unused-template', 'snippet', 'a-instrumentation', 'js', 'css', 'image']) {
      const file = path.join(sourceDir, 'powerpagecomponents', id, 'powerpagecomponent.xml');
      sourceFiles.push([file, fs.readFileSync(file, 'utf8')]);
    }
  }
  const inlineFile = layout === 'classic' ? path.join(sourceDir, 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css') : path.join(sourceDir, 'powerpagecomponents/home/powerpagecomponent.xml');
  const editCss = (text) => editSource({ file: inlineFile, ...(layout === 'enhanced' ? { field: 'customcss' } : {}) }, () => text);
  if (uncommittedInline) editCss('');
  if (classic) classic.commit();
  else if (uncommittedInline) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: sourceDir, env, stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    git('init', '-q'); git('add', '-A'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-q', '-m', 'online baseline');
  }
  if (uncommittedInline) {
    editCss(PAGE_CSS + 'html { --fixture-working-copy: yes; }\n');
    const jsFile = layout === 'classic' ? path.join(sourceDir, 'web-pages/home/content-pages/Home.en-US.webpage.custom_javascript.js') : inlineFile;
    editSource({ file: jsFile, ...(layout === 'enhanced' ? { field: 'customjavascript' } : {}) }, () => PAGE_JS + 'window.fixtureWorkingInline = "yes";\n');
    for (const entry of sourceFiles) entry[1] = fs.readFileSync(entry[0], 'utf8');
  }
  write(sourceDir, '.git/verify-copy-sentinel', 'original Git data must never be copied');
  write(sourceDir, 'node_modules/verify-copy-sentinel', 'dependencies must never be copied');
  write(sourceDir, '.paqvilo/verify-copy-sentinel', 'state must never be copied');
  const outside = path.join(work, 'outside');
  write(outside, 'private.txt', 'linked files must never be copied');
  fs.symlinkSync(outside, path.join(sourceDir, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const html = `<!doctype html><html><head><title>Verification fixture</title>
<link rel="stylesheet" href="${encodeURI(CSS_URL)}">${uncommittedInline ? '' : `<style>${PAGE_CSS}</style>`}
<script>${PAGE_JS}</script><script src="${JS_URL}"></script>
<script>window.instrumentationKey = "${CONFIGURATION_SNIPPET}"; document.addEventListener('DOMContentLoaded', () => { const display = document.createElement('p'); display.textContent = window.instrumentationKey; document.body.append(display); });</script>
</head><body>
<div class="fixture-shared-container">
${TEMPLATE}<p class="fixture-page fixture-web">Temporary content only</p>
</div>
<img src="${encodeURI(IMAGE_URL)}" alt="Fixture badge">
<script>${FORM_JS}</script>${classic ? `<script>${ADVANCED_JS}</script><script>${LIST_JS}</script>\n` : ''}<footer>${SNIPPET}</footer>
<script>throw new Error("fixture-existing-runtime-error");</script>
</body></html>`;
  const requests = [];
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith('/')) { response.writeHead(403).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    requests.push({ pathname, method: request.method });
    const assets = { [JS_URL]: ['application/javascript', WEB_JS], [CSS_URL]: ['text/css', WEB_CSS], [IMAGE_URL]: ['image/svg+xml', IMAGE] };
    const content = assets[pathname] ?? (pathname === '/' ? ['text/html; charset=utf-8', html] : null);
    if (content) response.writeHead(200, { 'content-type': content[0], 'cache-control': 'no-store' }).end(content[1]);
    else response.writeHead(404).end('fixture only');
  });
  server.on('connect', (_request, socket) => {
    // Chromium may reset a denied background TLS connection before reading our response.
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (classic) {
      fs.unlinkSync(path.join(sourceDir, 'linked-outside'));
      classic.cleanup();
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    work, sourceDir, sourceFiles, requests,
    cfg: {
      sourceDir, origin: `http://127.0.0.1:${server.address().port}`, siteName: layout, envName: 'loopback-only',
      sourceMaps: true, site: structuredClone(SITE), stateDir: path.join(work, 'state'), configDir: work,
      browser: { channel: process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium'), headless: true, bypassCSP: false, profileDir: 'profiles' },
    },
  };
}

function reportFor(cfg) {
  const dir = path.join(cfg.stateDir, 'verify');
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 1);
  return { report: JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8')), screenshot: path.join(dir, names[0].replace(/\.json$/, '.png')) };
}

function assertCopyIsolation(work) {
  const copied = path.join(work, 'source');
  assert.ok(fs.existsSync(path.join(copied, '.git')), 'verify creates its own fresh Git baseline');
  for (const rel of ['.git/verify-copy-sentinel', '.paqvilo', 'node_modules', 'linked-outside']) {
    assert.equal(fs.existsSync(path.join(copied, rel)), false, `${rel} must not enter the verification copy`);
  }
}

for (const layout of ['classic', 'enhanced']) for (const uncommittedInline of [false, true]) {
  test(`verify command exercises ${layout} resources${uncommittedInline ? ' with uncommitted inline CSS/JS and an empty deployed CSS baseline' : ' with structured/strict reporting'} on loopback`, { timeout: 120_000 }, async (t) => {
    const fx = await fixture(t, layout, uncommittedInline);
    const strict = layout === 'classic' && !uncommittedInline;
    if (layout === 'classic') {
      fx.cfg.sourceDir = path.join(fx.work, 'source-root-junction');
      fs.symlinkSync(fx.sourceDir, fx.cfg.sourceDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const launch = chromium.launchPersistentContext;
    let temporaryWork;
    let opened;
    chromium.launchPersistentContext = async function (profileDir, options) {
      temporaryWork = path.dirname(profileDir);
      assertCopyIsolation(temporaryWork);
      opened = await launch.call(this, profileDir, {
        ...options,
        proxy: { server: fx.cfg.origin, bypass: '127.0.0.1,localhost' },
        args: [...options.args, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
      });
      if (uncommittedInline) {
        const close = opened.close.bind(opened);
        opened.close = async (...args) => {
          try {
            const page = opened.pages().find((page) => page.url().startsWith(fx.cfg.origin));
            assert.ok(page, 'verification reached the fixture page');
            assert.deepEqual(await page.evaluate(() => ({ css: getComputedStyle(document.documentElement).getPropertyValue('--fixture-working-copy').trim(), js: window.fixtureWorkingInline })), { css: 'yes', js: 'yes' }, 'selected edits preserve original working-copy content as well as the verification marker');
          } finally { await close(...args); }
        };
      }
      opened.once('close', () => { closed = true; });
      return opened;
    };
    let closed = false;
    const stdout = [];
    const log = console.log;
    if (layout === 'enhanced') console.log = (line) => stdout.push(line);
    try {
      assert.equal(await verify(fx.cfg, { strict, json: layout === 'enhanced' }), strict ? 1 : 0);
    } finally {
      chromium.launchPersistentContext = launch;
      console.log = log;
    }
    const { report, screenshot } = reportFor(fx.cfg);
    assert.equal(report.passed, !strict, 'strict mode fails the newly observed post-edit console error');
    assert.equal(report.inlineBaseline.available, layout === 'classic' || uncommittedInline);
    if (uncommittedInline) {
      assert.equal(report.inlineBaseline.strategy, 'selected-git-reference');
      assert.equal(report.inlineBaseline.seededSources.length, 2);
      assert.equal(report.checks.find((check) => check.name === 'nothing is overridden before any edit').ok, true);
    } else if (layout === 'enhanced') {
      assert.equal(report.inlineBaseline.strategy, 'working-copy');
      assert.match(report.inlineBaseline.fallbackReason, /Cannot read baseline/);
    }
    if (layout === 'enhanced') {
      assert.equal(stdout.length, 1, 'JSON mode writes exactly one JSON document to stdout');
      assert.deepEqual(JSON.parse(stdout[0]), report);
    }
    assert.ok(fs.statSync(screenshot).size > 0);
    const required = ['web file (CSS)', 'web file (JS)', 'web file (image)', 'page custom CSS', 'page custom JS', 'web template', 'content snippet'];
    required.push('basic-form-js');
    if (layout === 'classic') required.push('advanced-form-step-js', 'list-js');
    for (const prefix of required) {
      const check = report.checks.find((entry) => entry.name.startsWith(prefix));
      assert.ok(check, `missing coverage: ${prefix}`);
      assert.equal(check.ok, true, `${prefix}: ${check.detail}`);
    }
    const skipped = report.checks.filter((entry) => entry.ok === null).map((entry) => entry.name);
    assert.deepEqual(skipped, []);
    assert.equal(report.coverage, 'complete');
    const templateCheck = report.checks.find((entry) => entry.name.startsWith('web template'));
    assert.ok(!templateCheck.name.includes('a-unused'), 'generic shared containers never attribute an unused conditional template');
    assert.match(templateCheck.detail, /server-side template execution is not inferred/);
    assert.ok(!report.checks.find((entry) => entry.name.startsWith('content snippet')).name.includes('instrumentation'), 'a configuration GUID occurring only in original JavaScript is never edited, even if JavaScript later prints it in the page');
    assert.ok(report.diagnostics.baseline.problems.some((problem) => problem.type === 'error' && problem.text === 'fixture-existing-runtime-error'));
    assert.ok(report.diagnostics.afterEdits.problems.some((problem) => problem.text === 'fixture-existing-runtime-error'));
    assert.ok(report.diagnostics.comparison.problems.existingCount >= 1);
    assert.ok(!report.diagnostics.comparison.problems.newObservations.some((problem) => problem.text === 'fixture-existing-runtime-error'), 'shifted line numbers do not reclassify a baseline error');
    assert.ok(report.diagnostics.comparison.problems.newObservations.some((problem) => problem.type === 'console' && problem.text === 'fixture-post-edit-console-observation'));
    assert.ok(!JSON.stringify(report.diagnostics).includes('sourceDir'));
    assert.ok(!JSON.stringify(report.diagnostics).includes('"token"'));
    assert.equal(closed, true, 'verify closes its browser');
    assert.equal(fs.existsSync(temporaryWork), false, 'verify deletes its temporary source and profile');
    assert.ok(fx.requests.every((request) => request.method === 'GET'), 'the fixture receives only reads');
    assert.ok(fx.requests.some((request) => request.pathname === CSS_URL));
    assert.ok(fx.requests.some((request) => request.pathname === IMAGE_URL));
    for (const [file, original] of fx.sourceFiles) assert.equal(fs.readFileSync(file, 'utf8'), original, 'the caller source stays unchanged');
    const evidenceDir = new URL('../.paqvilo/extended-round/', import.meta.url);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(new URL(`verify-${layout}-${uncommittedInline ? 'working-copy' : 'baseline'}.json`, evidenceDir), JSON.stringify(report, null, 2));
  });
}

test('verify writes failure evidence and removes its temporary copy when browser setup fails', { timeout: 30_000 }, async (t) => {
  const fx = await fixture(t, 'classic');
  const launch = chromium.launchPersistentContext;
  let temporaryWork;
  chromium.launchPersistentContext = async (profileDir) => {
    temporaryWork = path.dirname(profileDir);
    assertCopyIsolation(temporaryWork);
    throw new Error('deliberate browser setup failure in loopback acceptance');
  };
  const stdout = [];
  const log = console.log;
  console.log = (line) => stdout.push(line);
  try {
    assert.equal(await verify(fx.cfg, { json: true }), 1);
  } finally {
    chromium.launchPersistentContext = launch;
    console.log = log;
  }
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), reportFor(fx.cfg).report);
  assert.equal(reportFor(fx.cfg).report.coverage, 'incomplete');
  assert.equal(reportFor(fx.cfg).report.passed, false);
  assert.match(reportFor(fx.cfg).report.error, /deliberate browser setup failure/);
  assert.equal(reportFor(fx.cfg).report.diagnostics.baseline, null);
  assert.equal(reportFor(fx.cfg).report.diagnostics.afterEdits, null);
  assert.equal(fs.existsSync(temporaryWork), false);
  assert.equal(fx.requests.length, 0);
});

test('diagnostic snapshots copy bounded fields without panel secrets or source bodies', () => {
  const state = {
    token: 'never-save-this-session-token', sourceDir: 'never-save-this-source-dir',
    items: [{ online: 'never-save-this-source-body' }],
    problems: [{ type: 'error', text: 'existing failure', count: 2, where: 'https://user:password@example.test/script.js?secret=token#fragment', line: 7, online: 'never-save-this-source-body' }],
    notes: Array.from({ length: 250 }, (_, i) => ({ rel: `source-${i}`, reason: 'x'.repeat(1200), source: 'never-save-this-source-body' })),
    needsDeploy: [{ rel: 'unresolved-page.js', reason: 'page URL cannot be resolved' }],
  };
  const snapshot = diagnosticSnapshot(state);
  state.problems[0].text = 'mutated later';
  state.needsDeploy[0].reason = 'mutated later';
  assert.equal(snapshot.problems[0].text, 'existing failure');
  assert.equal(snapshot.problems[0].where, 'https://example.test/script.js');
  assert.equal(snapshot.needsDeploy[0].reason, 'page URL cannot be resolved');
  assert.equal(snapshot.notes.length, 200);
  assert.equal(snapshot.notes[0].reason.length, 1000);
  assert.equal(snapshot.counts.notes, 250);
  assert.equal(snapshot.truncated.notes, true);
  assert.ok(!JSON.stringify(snapshot).includes('never-save'));
});

test('verify writes failure evidence and removes a partial copy when copying sources fails', { timeout: 30_000 }, async (t) => {
  const fx = await fixture(t, 'classic');
  const copy = fs.cpSync;
  let temporaryWork;
  fs.cpSync = (_source, target) => {
    temporaryWork = path.dirname(target);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'partial.txt'), 'incomplete copy');
    throw new Error('deliberate copy failure in loopback acceptance');
  };
  try {
    await assert.rejects(verify(fx.cfg, {}), /deliberate copy failure.*\nVerification report:/);
  } finally {
    fs.cpSync = copy;
  }
  assert.equal(reportFor(fx.cfg).report.passed, false);
  assert.match(reportFor(fx.cfg).report.error, /deliberate copy failure/);
  assert.equal(fs.existsSync(temporaryWork), false);
  assert.equal(fx.requests.length, 0);
});
