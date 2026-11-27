// @test-kind contract: verification reports and helpers produce the designed evidence, messages and failure states.
import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import verify, {
  diagnosticSnapshot,
  compareDiagnostics,
  assessVerification,
  verificationPageBlocks,
} from '../lense/commands/verify.mjs';
import * as verifyModule from '../lense/commands/verify.mjs';
import { PortalModel } from '../lense/portal-model.mjs';
import { createFixture, HOME_ID, SITE } from './fixture.mjs';

test('signed-in verification launches the selected external child profile without a credential export', async (t) => {
  // The browser identity is under test, not the inline baseline: a plain export needs no Git repository.
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const stateDir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'pp-verify-external-profile-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const sourceDir = fixture.dir;
  const userDataDir = path.join(stateDir, 'browser');
  fs.mkdirSync(path.join(userDataDir, 'Profile 2'), { recursive: true });
  const cfg = {
    configDir: stateDir,
    stateDir,
    sourceDir,
    siteName: 'fixture',
    envName: 'local',
    origin: 'http://127.0.0.1:1',
    site: structuredClone(SITE),
    browser: { channel: 'msedge', userDataDir, profileDirectory: 'Profile 2', profileDir: 'profiles' },
  };
  let launched = false;
  t.mock.method(chromium, 'launchPersistentContext', async (root, options) => {
    launched = true;
    assert.equal(root, userDataDir);
    assert.ok(options.args.includes('--profile-directory=Profile 2'));
    throw new Error('intentional stop after checking browser identity');
  });
  const output = [];
  t.mock.method(console, 'log', (line) => output.push(line));
  t.mock.method(console, 'error', () => {});
  assert.equal(await verify(cfg, { json: true, 'signed-in': true }), 1);
  assert.equal(launched, true);
  const report = JSON.parse(output[0]);
  assert.match(report.error, /intentional stop/);
  assert.equal(report.cleanup.temporarySourceRemoved, true);
  assert.equal(fs.existsSync(`${userDataDir}.session.json`), false);
});

const checks = [{ name: 'web file (CSS)', ok: true }];
function diagnostics(before = {}, after = {}) {
  return { comparison: compareDiagnostics(diagnosticSnapshot(before), diagnosticSnapshot(after)) };
}

test('strict verification accepts existing problems but rejects newly observed runtime or patch failures', () => {
  const existing = { problems: [{ type: 'error', text: 'known issue' }] };
  assert.equal(assessVerification(checks, diagnostics(existing, existing), true).passed, true);
  const added = { ...existing, notes: [{ rel: 'template.html', reason: 'ambiguous anchor' }] };
  assert.equal(assessVerification(checks, diagnostics(existing, added), false).passed, true);
  const strict = assessVerification(checks, diagnostics(existing, added), true);
  assert.equal(strict.passed, false);
  assert.equal(strict.newObservations, 1);
  assert.equal(assessVerification(checks, diagnostics({}, existing), true).passed, false);
});

test('strict verification cannot pass missing/truncated diagnostics or no exercised resources', () => {
  assert.equal(assessVerification(checks, {}, true).passed, false);
  const problems = Array.from({ length: 201 }, (_, i) => ({ type: 'error', text: String(i) }));
  assert.equal(assessVerification(checks, diagnostics({ problems }, { problems }), true).passed, false);
  assert.equal(assessVerification([{ name: 'page loads', ok: true }], diagnostics(), true).passed, false);
  const partial = assessVerification([...checks, { name: 'form custom JS', ok: null }], diagnostics(), true);
  assert.equal(partial.passed, true);
  assert.equal(partial.coverage, 'partial');
  assert.deepEqual(partial.counts, { passed: 1, failed: 0, skipped: 1 });
  assert.equal(assessVerification([...checks, { name: 'broken CSS', ok: false }], diagnostics(), true).passed, false);
});

test('strict mode treats truncated diagnostic text as incomplete even when prefixes match', () => {
  const before = { problems: [{ type: 'error', text: 'x'.repeat(1000) + 'old' }] };
  const after = { problems: [{ type: 'error', text: 'x'.repeat(1000) + 'new' }] };
  const comparison = diagnostics(before, after);
  assert.equal(comparison.comparison.problems.incomplete, true);
  assert.equal(assessVerification(checks, comparison, true).passed, false);
  assert.equal(assessVerification(checks, comparison, false).passed, true);
});

test('Verify chooses the displayed language’s inline page sources', (t) => {
  const fx = createFixture();
  t.after(fx.cleanup);
  fx.write(
    'web-pages/fixture/Fixture.webpage.yml',
    `adx_webpageid: fixture-root\nadx_partialurl: fixture\nadx_parentpageid: ${HOME_ID}\n`,
  );
  fx.write(
    'websitelanguage.yml',
    '- adx_websitelanguageid: en\n  adx_languagecode: en-US\n- adx_websitelanguageid: fr\n  adx_languagecode: fr-FR\n',
  );
  const files = (locale) => {
    const stem = `web-pages/fixture/content-pages/Fixture.${locale}.webpage`;
    return [`${stem}.custom_css.css`, `${stem}.custom_javascript.js`];
  };
  for (const locale of ['en-US', 'fr-FR']) {
    fx.write(
      `web-pages/fixture/content-pages/Fixture.${locale}.webpage.yml`,
      `adx_webpageid: fixture-${locale}\nadx_rootwebpageid: fixture-root\nadx_partialurl: fixture\n`,
    );
    const [css, js] = files(locale);
    fx.write(css, 'html { color: navy; }\n');
    fx.write(js, `window.fixtureLocale = '${locale}';\n`);
  }
  const model = new PortalModel(fx.dir);
  const selected = (html, url) =>
    verificationPageBlocks(model, html, url)
      .map(({ rel }) => rel)
      .sort();
  assert.deepEqual(selected('<html lang="fr-FR"></html>', '/fixture/'), files('fr-FR'));
  assert.deepEqual(selected('<html lang="en-US"></html>', '/fixture/'), files('en-US'));
  assert.deepEqual(selected('<html></html>', '/fr-FR/fixture/'), files('fr-FR'));
  assert.deepEqual(selected('<html></html>', '/fixture/'), [...files('en-US'), ...files('fr-FR')].sort());
});

test('JSON verification emits one final failure report when temporary cleanup also fails', async (t) => {
  const stateDir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'pp-verify-cleanup-report-'));
  const remove = fs.rmSync;
  const removeAsync = fs.promises.rm;
  let temporary;
  let cleanupAttempts = 0;
  t.after(() => {
    if (temporary) remove(temporary, { recursive: true, force: true });
    remove(stateDir, { recursive: true, force: true });
  });
  t.mock.method(fs.promises, 'rm', async (file, options) => {
    if (path.basename(file).startsWith('paqvilo-verify-')) {
      temporary = file;
      cleanupAttempts++;
      assert.deepEqual(options, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      throw new Error('fixture cleanup failure');
    }
    return removeAsync(file, options);
  });
  const output = [];
  t.mock.method(console, 'log', (line) => output.push(line));
  t.mock.method(console, 'error', () => {});
  const cfg = {
    stateDir,
    siteName: 'fixture',
    envName: 'local',
    origin: 'https://portal.invalid',
    sourceDir: path.join(stateDir, 'missing-extract'),
    site: { startPath: '/' },
  };
  assert.equal(await verify(cfg, { json: true }), 1);
  assert.equal(cleanupAttempts, 1);
  assert.equal(fs.existsSync(temporary), true);
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.passed, false);
  assert.equal(report.cleanup.temporarySourceRemoved, false);
  assert.match(report.cleanup.errors[0], /fixture cleanup failure/);
  assert.match(report.error, /Cleanup incomplete/);
  assert.deepEqual(JSON.parse(fs.readFileSync(report.evidence.report, 'utf8')), report);
});

test('verification matrix deduplicates targets and returns one report with redacted per-page outcomes', async (t) => {
  const stateDir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'pp-verify-targets-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const output = [];
  t.mock.method(console, 'log', (line) => output.push(line));
  t.mock.method(console, 'error', () => {});
  const cfg = {
    stateDir,
    siteName: 'fixture',
    envName: 'local',
    origin: 'https://portal.invalid',
    sourceDir: path.join(stateDir, 'missing-extract'),
    site: { startPath: '/' },
  };
  assert.equal(await verify(cfg, { json: true, 'verify-path': ['/en/', '/fr/?key=INVENTED', '/en/'] }), 1);
  assert.equal(output.length, 1);
  assert.doesNotMatch(output[0], /INVENTED/);
  const report = JSON.parse(output[0]);
  assert.deepEqual(report.paths, ['https://portal.invalid/en/', 'https://portal.invalid/fr/?[redacted]']);
  assert.deepEqual(
    report.reports.map(({ url, passed, cleanup }) => [url, passed, cleanup.temporarySourceRemoved]),
    report.paths.map((url) => [url, false, true]),
  );
  assert.equal(report.writesFiles.length, 2);
  await assert.rejects(
    () => verify(cfg, { 'verify-path': ['/en/', '//another.invalid/'] }),
    /--verify-path must be a same-origin path/,
  );
});

// @test-kind security: a sign-in redirect carries state and nonce values that verification output must not print.
test('verify sign-in message names the page location without query or fragment values', () => {
  const { redactedPageUrl } = verifyModule;
  assert.equal(typeof redactedPageUrl, 'function');
  const shown = redactedPageUrl('https://login.example.test/authorize?state=INVENTED&nonce=N#frag');
  assert.equal(shown, 'https://login.example.test/authorize?[redacted]');
  assert.doesNotMatch(shown, /INVENTED|frag/);
  assert.equal(redactedPageUrl('https://login.example.test/authorize'), 'https://login.example.test/authorize');
  assert.equal(redactedPageUrl('not a url?x=INVENTED'), '[redacted URL]');
});
