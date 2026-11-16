// @test-kind security: only typed loopback fixture diagnostics and ordinary PNGs survive teardown; private state, bearer tokens and substituted sources never enter published evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { preserveVerifyFixtureEvidence } from '../test-browser/helpers/verify-evidence.mjs';
import { collectSyntheticEvidence } from '../scripts/collect-evidence.mjs';

const filename = '2026-11-16T21-04-52-604Z-ppvfd346b12.json';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const privateMarker = 'invented-credential-canary-never-publish';
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-verify-evidence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureRoot = path.join(root, 'fixture');
  const reports = path.join(fixtureRoot, 'state', 'verify');
  const outputRoot = path.join(root, 'state');
  fs.mkdirSync(reports, { recursive: true });
  const report = {
    schemaVersion: 1,
    site: 'classic',
    environment: 'loopback-only',
    url: 'http://127.0.0.1:1234/?state=private',
    token: privateMarker,
    cookies: privateMarker,
    passed: false,
    error: 'invented loopback failure',
    checks: [{ name: 'load', ok: false, detail: 'Bearer ' + privateMarker }],
    diagnostics: {
      afterEdits: {
        problems: [
          {
            type: 'request',
            text: 'Bearer ' + privateMarker,
            where: 'http://127.0.0.1:1234/?token=private',
            authorization: privateMarker,
          },
        ],
      },
    },
  };
  const reportFile = path.join(reports, filename);
  fs.writeFileSync(reportFile, JSON.stringify(report));
  fs.writeFileSync(path.join(reports, filename.replace('.json', '.png')), png);
  fs.writeFileSync(path.join(reports, 'discovery.json'), privateMarker);
  fs.writeFileSync(path.join(fixtureRoot, 'Cookies'), privateMarker);
  return { root, fixtureRoot, reports, outputRoot, reportFile, report };
}

test('preserves sanitized diagnostic and screenshot while excluding discovery and browser state', (t) => {
  const fx = fixture(t);
  const files = preserveVerifyFixtureEvidence(fx);
  assert.equal(files.length, 2);
  const diagnostic = JSON.parse(fs.readFileSync(files.find((file) => file.endsWith('.json'))));
  assert.equal(diagnostic.synthetic, true);
  assert.equal(diagnostic.url, 'http://127.0.0.1:1234/');
  assert.equal(diagnostic.error, 'invented loopback failure');
  assert.equal(JSON.stringify(diagnostic).includes(privateMarker), false);
  assert.equal('token' in diagnostic, false);
  assert.equal('cookies' in diagnostic, false);
  assert.deepEqual(fs.readFileSync(files.find((file) => file.endsWith('.png'))), png);
  const collected = collectSyntheticEvidence(fx.outputRoot);
  assert.equal(collected.files.length, 2);
  assert.ok(
    collected.files.every((file) => /^verify-fixtures\/[a-f0-9]{32}-(diagnostic\.json|failure\.png)$/.test(file)),
  );
  assert.equal(fs.readFileSync(path.join(fx.reports, 'discovery.json'), 'utf8'), privateMarker);
});

test('refuses a substituted FIFO without blocking on an absent writer', { skip: process.platform === 'win32' }, (t) => {
  const fx = fixture(t);
  fs.unlinkSync(fx.reportFile);
  const fifo = spawnSync('mkfifo', [fx.reportFile], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stdout + fifo.stderr);
  const helper = pathToFileURL(path.resolve('test-browser/helpers/verify-evidence.mjs')).href;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { preserveVerifyFixtureEvidence } from ${JSON.stringify(helper)}; try { preserveVerifyFixtureEvidence(${JSON.stringify({ fixtureRoot: fx.fixtureRoot, outputRoot: fx.outputRoot })}); process.exitCode = 2; } catch (error) { if (!/owned ordinary file/.test(error.message)) throw error; }`,
    ],
    { encoding: 'utf8', windowsHide: true, env, timeout: 10000 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(fs.existsSync(fx.outputRoot), false);
});

test('publishing another fixture never overwrites previously retained evidence', (t) => {
  const fx = fixture(t);
  const first = preserveVerifyFixtureEvidence(fx);
  const before = first.map((file) => fs.readFileSync(file));
  const second = preserveVerifyFixtureEvidence(fx);
  assert.equal(new Set([...first, ...second]).size, 4);
  for (let index = 0; index < first.length; index++) assert.deepEqual(fs.readFileSync(first[index]), before[index]);
});

test('refuses a source report substituted with a private hardlink', (t) => {
  const fx = fixture(t);
  const outside = path.join(fx.root, 'private.json');
  fs.writeFileSync(outside, JSON.stringify(fx.report));
  fs.unlinkSync(fx.reportFile);
  fs.linkSync(outside, fx.reportFile);
  assert.throws(() => preserveVerifyFixtureEvidence(fx), /owned ordinary file/);
  assert.equal(fs.existsSync(fx.outputRoot), false);
});

test('refuses a report replaced after its descriptor opens without reading or publishing its bytes', (t) => {
  const fx = fixture(t);
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  let descriptor;
  let replaced = false;
  let readReport = false;
  fs.openSync = function (file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (file === fx.reportFile && !replaced) {
      replaced = true;
      descriptor = fd;
      fs.renameSync(fx.reportFile, path.join(fx.reports, 'original-report.json'));
      fs.writeFileSync(fx.reportFile, JSON.stringify({ ...fx.report, error: privateMarker }));
    }
    return fd;
  };
  fs.readFileSync = function (file, ...args) {
    if (file === descriptor) readReport = true;
    return originalRead.call(this, file, ...args);
  };
  try {
    assert.throws(() => preserveVerifyFixtureEvidence(fx), /owned ordinary file/);
  } finally {
    fs.openSync = originalOpen;
    fs.readFileSync = originalRead;
  }
  assert.equal(replaced, true, 'the substitution occurred after the source descriptor opened');
  assert.equal(readReport, false, 'unqualified source bytes must not be read');
  assert.equal(fs.existsSync(fx.outputRoot), false);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' }, 'rejected source descriptors must close');
});

test('refuses non-loopback diagnostics before publication', (t) => {
  const fx = fixture(t);
  fs.writeFileSync(fx.reportFile, JSON.stringify({ ...fx.report, url: 'https://example.invalid/?token=private' }));
  assert.throws(() => preserveVerifyFixtureEvidence(fx), /Only synthetic loopback/);
  assert.equal(fs.existsSync(fx.outputRoot), false);
});

test('malformed diagnostic errors never repeat private input bytes', (t) => {
  const fx = fixture(t);
  fs.writeFileSync(fx.reportFile, `{${privateMarker}`);
  assert.throws(
    () => preserveVerifyFixtureEvidence(fx),
    (error) => {
      assert.equal(error.message, 'Malformed owned verification diagnostic');
      assert.equal(error.stack.includes(privateMarker), false);
      return true;
    },
  );
});

// @test-kind tooling: a deliberately failed child test proves its teardown retains approved diagnostics before removing its fixture.
test('a failing test publishes diagnostic evidence before its owned fixture is deleted', (t) => {
  const fx = fixture(t);
  const child = path.join(fx.root, 'failing.test.mjs');
  const helper = pathToFileURL(path.resolve('test-browser/helpers/verify-evidence.mjs')).href;
  fs.writeFileSync(
    child,
    `// @test-kind tooling: deliberate fixture failure.\nimport test from 'node:test'; import fs from 'node:fs'; import { preserveVerifyFixtureEvidence } from ${JSON.stringify(helper)};\ntest('deliberate fixture failure', (t) => { t.after(() => { preserveVerifyFixtureEvidence(${JSON.stringify({ fixtureRoot: fx.fixtureRoot, outputRoot: fx.outputRoot })}); fs.rmSync(${JSON.stringify(fx.fixtureRoot)}, { recursive: true, force: true }); }); throw new Error('deliberate fixture failure'); });\n`,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const result = spawnSync(process.execPath, ['--test', child], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.existsSync(fx.fixtureRoot), false);
  const diagnosticFiles = fs
    .readdirSync(path.join(fx.outputRoot, 'verify-fixtures'))
    .filter((file) => file.endsWith('.json'));
  assert.equal(diagnosticFiles.length, 1);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(fx.outputRoot, 'verify-fixtures', diagnosticFiles[0])));
  assert.equal(diagnostic.error, 'invented loopback failure');
  assert.ok(fs.existsSync(path.join(fx.outputRoot, 'verify-fixtures', diagnostic.screenshot)));
});

// @test-kind tooling: protocol-gated late writers prove a timed-out fixture remains available until the child settles and lab-style recovery runs.
for (const existingReport of [false, true]) {
  test(`timeout retains ${existingReport ? 'unfinished fixture with an earlier report' : 'fixture without its final report'} for post-child recovery`, (t) => {
    const fx = fixture(t);
    if (!existingReport) for (const file of fs.readdirSync(fx.reports)) fs.unlinkSync(path.join(fx.reports, file));
    const child = path.join(fx.root, 'timeout.test.mjs');
    const proof = path.join(fx.root, 'late-write.json');
    const helper = new URL('../test-browser/helpers/verify-evidence.mjs', import.meta.url).href;
    const owner = new URL('../mirage/testing/owned-fixture.mjs', import.meta.url).href;
    fs.writeFileSync(
      child,
      `// @test-kind tooling: a timeout releases the controlled late diagnostic writer after teardown.\nimport test from 'node:test'; import fs from 'node:fs'; import { ownedFixture } from ${JSON.stringify(owner)}; import { finalizeVerifyFixtureEvidence } from ${JSON.stringify(helper)};\nconst gate=Promise.withResolvers();\ntest('controlled late verification', {timeout:30}, async(t)=>{const keep=setInterval(()=>{},1000); ownedFixture(t).add(()=>{try {const evidence=finalizeVerifyFixtureEvidence(${JSON.stringify({ fixtureRoot: fx.fixtureRoot, outputRoot: fx.outputRoot })},t.signal); if(evidence.canRemove) fs.rmSync(${JSON.stringify(fx.fixtureRoot)},{recursive:true,force:true});} finally {gate.resolve();}}); await gate.promise; try{fs.writeFileSync(${JSON.stringify(fx.reportFile)},${JSON.stringify(JSON.stringify({ ...fx.report, error: 'late verification diagnostic' }))});fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({written:true}));}catch(error){fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({written:false,code:error.code}));}finally{clearInterval(keep);}});\n`,
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
    const result = spawnSync(process.execPath, ['--test', child], { encoding: 'utf8', windowsHide: true, env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(proof)), { written: true });
    assert.equal(fs.existsSync(fx.fixtureRoot), true);
    const files = preserveVerifyFixtureEvidence(fx);
    const retained = files.filter((file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(file)));
    assert.ok(retained.some((report) => report.error === 'late verification diagnostic'));
    fs.rmSync(fx.fixtureRoot, { recursive: true, force: true });
    assert.ok(files.every((file) => fs.existsSync(file)));
  });
}
