import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import verify, { diagnosticSnapshot, compareDiagnostics, assessVerification } from '../lense/commands/verify.mjs';
import { createFixture, SITE } from './fixture.mjs';

test('signed-in verification launches the selected external child profile without a credential export', async (t) => {
  const fixture = createFixture();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-verify-external-profile-'));
  t.after(() => { fixture.cleanup(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const userDataDir = path.join(stateDir, 'browser');
  fs.mkdirSync(path.join(userDataDir, 'Profile 2'), { recursive: true });
  const cfg = { configDir: stateDir, stateDir, sourceDir: fixture.dir, siteName: 'fixture', envName: 'local',
    origin: 'http://127.0.0.1:1', site: structuredClone(SITE),
    browser: { channel: 'msedge', userDataDir, profileDirectory: 'Profile 2', profileDir: 'profiles' } };
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

test('JSON verification emits one final failure report when temporary cleanup also fails', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-verify-cleanup-report-'));
  const remove = fs.rmSync;
  let temporary;
  t.after(() => { if (temporary) remove(temporary, { recursive: true, force: true }); remove(stateDir, { recursive: true, force: true }); });
  t.mock.method(fs, 'rmSync', (file, options) => {
    if (path.basename(file).startsWith('paqvilo-verify-')) { temporary = file; throw new Error('fixture cleanup failure'); }
    return remove(file, options);
  });
  const output = [];
  t.mock.method(console, 'log', (line) => output.push(line));
  t.mock.method(console, 'error', () => {});
  const cfg = { stateDir, siteName: 'fixture', envName: 'local', origin: 'https://portal.invalid', sourceDir: path.join(stateDir, 'missing-extract'), site: { startPath: '/' } };
  assert.equal(await verify(cfg, { json: true }), 1);
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.passed, false);
  assert.equal(report.cleanup.temporarySourceRemoved, false);
  assert.match(report.cleanup.errors[0], /fixture cleanup failure/);
  assert.match(report.error, /Cleanup incomplete/);
  assert.deepEqual(JSON.parse(fs.readFileSync(report.evidence.report, 'utf8')), report);
});
