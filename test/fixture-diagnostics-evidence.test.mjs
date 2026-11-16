// @test-kind security: registered loopback fixtures retain typed evidence across teardown while private state, credentials, substituted files and live observations are excluded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  FIXTURE_DIAGNOSTIC_MARKER,
  registerFixtureDiagnostics,
  finalizeFixtureDiagnostics,
  recoverFixtureDiagnostics,
} from '../test-browser/helpers/fixture-diagnostics.mjs';
import { collectSyntheticEvidence } from '../scripts/collect-evidence.mjs';

const privateMarker = 'invented-private-fixture-canary';
const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
const origin = 'http://127.0.0.1:12345';

function fixture(t, { kind = 'model-driven', written = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-fixture-diagnostics-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureRoot = path.join(root, 'fixture');
  const outputRoot = path.join(root, 'published');
  fs.mkdirSync(fixtureRoot);
  const registration = registerFixtureDiagnostics({
    fixtureRoot,
    outputRoot,
    kind,
    origin,
    reportRoots: kind === 'model-driven' ? ['report.json'] : ['evidence', 'failed-evidence'],
  });
  const directory = kind === 'model-driven' ? fixtureRoot : path.join(fixtureRoot, 'evidence', '2026-11-17T001234567Z');
  fs.mkdirSync(directory, { recursive: true });
  const reportFile = path.join(directory, 'report.json');
  const privateFiles = ['discovery.json', 'Cookies', 'source-body.txt', 'raw-headers.json'].map((name) =>
    path.join(directory, name),
  );
  for (const file of privateFiles) fs.writeFileSync(file, privateMarker);
  const report =
    kind === 'model-driven'
      ? {
          schemaVersion: 1,
          kind: 'model-driven-overlay',
          origin,
          revision: 4,
          applied: 3,
          currentRevisionApplied: 2,
          token: privateMarker,
          cookies: privateMarker,
          writesFiles: [privateMarker],
          resources: [
            {
              name: 'invented.js',
              mime: 'text/javascript',
              paths: ['/WebResources/invented.js?token=' + privateMarker],
              applied: 3,
              headers: privateMarker,
              body: privateMarker,
              sourceAttribution: { state: 'observed', reason: 'Bearer ' + privateMarker },
            },
          ],
          diagnostics: [{ code: 'INVENTED', reason: 'token=' + privateMarker }],
        }
      : {
          sourceFingerprint: 'fixture',
          implementationFingerprint: 'fixture',
          passed: false,
          token: privateMarker,
          flows: [
            {
              name: 'Invented local flow',
              mode: 'local',
              passed: false,
              finalUrl: origin + '/?token=' + privateMarker,
              error: 'Bearer ' + privateMarker,
              steps: [{ action: 'click', passed: true, headers: privateMarker, body: privateMarker }],
              failedRequests: [
                { method: 'PATCH', url: origin + '/save?token=' + privateMarker, status: 500, headers: privateMarker },
              ],
              pendingRequests: [{ method: 'GET', url: origin + '/never?token=' + privateMarker }],
              pageErrors: ['Bearer ' + privateMarker],
              consoleErrors: ['token=' + privateMarker],
              screenshots: [
                path.join(directory, '1-Invented-local-flow-failure.png'),
                path.join(directory, 'named-step.png'),
              ],
            },
          ],
        };
  if (kind === 'acceptance') {
    for (const file of report.flows[0].screenshots) fs.writeFileSync(file, png);
    fs.writeFileSync(
      path.join(directory, '1-request-audit.json'),
      JSON.stringify({
        items: [
          {
            method: 'GET',
            path: '/rows?token=' + privateMarker,
            status: 200,
            headers: privateMarker,
            body: privateMarker,
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(directory, '1-browser-network.json'),
      JSON.stringify({
        records: [
          {
            method: 'GET',
            path: '/rows?token=' + privateMarker,
            status: 200,
            headers: privateMarker,
            postData: privateMarker,
          },
        ],
        frameEvents: [{ event: 'frameNavigated', headers: privateMarker }],
      }),
    );
  }
  if (written) fs.writeFileSync(reportFile, JSON.stringify(report));
  return { root, fixtureRoot, outputRoot, registration, directory, reportFile, report, privateFiles };
}

function diagnostics(files) {
  return files
    .filter((file) => file.endsWith('-diagnostic.json'))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
}

for (const kind of ['model-driven', 'acceptance'])
  test(`${kind} evidence survives fixture deletion without opening private adjacent files`, (t) => {
    const fx = fixture(t, { kind });
    const originalOpen = fs.openSync;
    const originalRead = fs.readFileSync;
    const openedPrivate = [];
    const inspect = (file) => {
      if (typeof file === 'string' && fx.privateFiles.includes(file)) {
        openedPrivate.push(file);
        throw new Error('Private fixture input must never be opened');
      }
    };
    fs.openSync = function (file, ...args) {
      inspect(file);
      return originalOpen.call(this, file, ...args);
    };
    fs.readFileSync = function (file, ...args) {
      inspect(file);
      return originalRead.call(this, file, ...args);
    };
    let result;
    try {
      result = finalizeFixtureDiagnostics(fx.registration);
    } finally {
      fs.openSync = originalOpen;
      fs.readFileSync = originalRead;
    }
    assert.deepEqual(openedPrivate, []);
    assert.equal(result.canRemove, true);
    assert.equal(result.reports, 1);
    fs.rmSync(fx.fixtureRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(fx.fixtureRoot), false);
    const [diagnostic] = diagnostics(result.files);
    assert.equal(diagnostic.complete, true);
    assert.equal(diagnostic.reportWritten, true);
    assert.equal(diagnostic.producer, kind);
    assert.equal(JSON.stringify(diagnostic).includes(privateMarker), false);
    assert.deepEqual(fs.readdirSync(fx.outputRoot), ['fixture-diagnostics']);
    assert.deepEqual(
      fs.readdirSync(path.join(fx.outputRoot, 'fixture-diagnostics')).sort(),
      result.files.map((file) => path.basename(file)).sort(),
      'only the declared typed diagnostic and PNG outputs are published',
    );
    if (kind === 'model-driven') {
      assert.equal(diagnostic.report.applied, 3);
      assert.equal(diagnostic.report.revision, 4);
      assert.deepEqual(diagnostic.report.resources[0].paths, ['/WebResources/invented.js']);
    } else {
      assert.equal(diagnostic.report.flows[0].pendingRequests[0].url, origin + '/never');
      assert.equal(diagnostic.report.flows[0].audit.items[0].path, '/rows');
      assert.equal(diagnostic.report.flows[0].network.records[0].path, '/rows');
      assert.deepEqual(
        diagnostic.screenshots.map((image) => image.stage),
        ['failure', 'step'],
      );
      for (const image of result.files.filter((file) => file.endsWith('.png')))
        assert.deepEqual(fs.readFileSync(image), png);
    }
    const collected = collectSyntheticEvidence(fx.outputRoot);
    assert.equal(collected.files.length, result.files.length);
    assert.ok(
      collected.files.every((file) => /^fixture-diagnostics\/[a-f0-9]{32}-(diagnostic\.json|failure\.png)$/.test(file)),
    );
  });

test('an unwritten report is explicitly incomplete and does not block settled fixture cleanup', (t) => {
  const fx = fixture(t, { written: false });
  const result = finalizeFixtureDiagnostics(fx.registration);
  assert.equal(result.canRemove, true);
  assert.equal(result.reports, 0);
  fs.rmSync(fx.fixtureRoot, { recursive: true, force: true });
  const [diagnostic] = diagnostics(result.files);
  assert.equal(diagnostic.complete, false);
  assert.equal(diagnostic.reportWritten, false);
  assert.equal(diagnostic.report, null);
  assert.equal(diagnostic.missingReason, 'report-not-written');
});

for (const changed of ['report', 'marker', 'screenshot'])
  test(`a substituted ${changed} hardlink is refused before publication`, (t) => {
    const fx = fixture(t, { kind: changed === 'screenshot' ? 'acceptance' : 'model-driven' });
    if (changed === 'screenshot') {
      fx.report.flows[0].screenshots = [path.join(fx.directory, 'named-step.png')];
      fs.writeFileSync(fx.reportFile, JSON.stringify(fx.report));
    }
    const file =
      changed === 'marker'
        ? path.join(fx.fixtureRoot, FIXTURE_DIAGNOSTIC_MARKER)
        : changed === 'screenshot'
          ? fx.report.flows[0].screenshots[0]
          : fx.reportFile;
    const outside = path.join(fx.root, 'private-link-target');
    fs.copyFileSync(file, outside);
    fs.unlinkSync(file);
    fs.linkSync(outside, file);
    assert.throws(() => recoverFixtureDiagnostics(fx.registration), /owned ordinary file/);
    assert.equal(fs.existsSync(fx.outputRoot), false);
  });

test('a substituted acceptance output directory symlink cannot expose a private tree', (t) => {
  const fx = fixture(t, { kind: 'acceptance' });
  const outside = path.join(fx.root, 'private-tree');
  const evidence = path.join(fx.fixtureRoot, 'evidence');
  fs.renameSync(evidence, outside);
  fs.symlinkSync(outside, evidence, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => recoverFixtureDiagnostics(fx.registration), /ordinary directory|escaped/);
  assert.equal(fs.existsSync(fx.outputRoot), false);
});

for (const changed of ['live-mode', 'foreign-origin', 'escaped-screenshot', 'discovery-screenshot'])
  test(`refuses ${changed} acceptance evidence without publishing it`, (t) => {
    const fx = fixture(t, { kind: 'acceptance' });
    if (changed === 'live-mode') fx.report.flows[0].mode = 'live';
    if (changed === 'foreign-origin') fx.report.flows[0].finalUrl = 'https://example.invalid/';
    if (changed === 'escaped-screenshot') fx.report.flows[0].screenshots = [path.join(fx.root, 'private.png')];
    if (changed === 'discovery-screenshot') fx.report.flows[0].screenshots = [fx.privateFiles[0]];
    fs.writeFileSync(fx.reportFile, JSON.stringify(fx.report));
    assert.throws(
      () => recoverFixtureDiagnostics(fx.registration),
      /local synthetic|registered origin|screenshot escaped/,
    );
    assert.equal(fs.existsSync(fx.outputRoot), false);
  });

test('registration refuses escaping roots and credentialed or non-loopback origins', (t) => {
  const fx = fixture(t);
  for (const reportRoots of [['../private'], ['report.json', 'discovery.json']])
    assert.throws(() => registerFixtureDiagnostics({ ...fx.registration, reportRoots }), /Unapproved/);
  for (const invalid of [
    'https://example.invalid',
    origin + '/?token=' + privateMarker,
    'http://user:password@127.0.0.1:12345',
  ])
    assert.throws(() => registerFixtureDiagnostics({ ...fx.registration, origin: invalid }), /loopback origin/);
  assert.equal(fs.existsSync(fx.outputRoot), false);
});

test('recovery refuses unregistered fixtures and markers with unapproved fields', (t) => {
  const fx = fixture(t);
  const file = path.join(fx.fixtureRoot, FIXTURE_DIAGNOSTIC_MARKER);
  const marker = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...marker, discovery: 'discovery.json' }));
  assert.throws(() => recoverFixtureDiagnostics(fx.registration), /Invalid synthetic fixture registration/);
  fs.unlinkSync(file);
  assert.throws(() => recoverFixtureDiagnostics(fx.registration), { code: 'ENOENT' });
  assert.equal(fs.existsSync(fx.outputRoot), false);
});

test('retained typed diagnostics explicitly report list and text truncation', (t) => {
  const fx = fixture(t);
  fx.report.resources = Array.from({ length: 205 }, (_, index) => ({
    name: index === 0 ? 'x'.repeat(4100) : `invented-${index}.js`,
    paths: Array.from({ length: 52 }, (_, item) => `/invented/${item}`),
  }));
  fs.writeFileSync(fx.reportFile, JSON.stringify(fx.report));
  const [diagnostic] = diagnostics(recoverFixtureDiagnostics(fx.registration).files);
  assert.deepEqual(diagnostic.report.collectionLimits.resources, { total: 205, retained: 200, truncated: true });
  assert.deepEqual(diagnostic.report.resources[0].pathsLimit, { total: 52, retained: 50, truncated: true });
  assert.deepEqual(diagnostic.report.resources[0].truncatedFields, ['name']);
});

test('a timed-out owner retains its fixture until a gated late producer is recovered after child exit', (t) => {
  const fx = fixture(t, { written: false });
  const proof = path.join(fx.root, 'late-producer.json');
  const child = path.join(fx.root, 'late-producer.test.mjs');
  const helper = pathToFileURL(path.resolve('test-browser/helpers/fixture-diagnostics.mjs')).href;
  const owner = pathToFileURL(path.resolve('mirage/testing/owned-fixture.mjs')).href;
  fs.writeFileSync(
    child,
    `// @test-kind tooling: the intentional timeout releases the late producer only after fixture teardown.\nimport test from 'node:test'; import fs from 'node:fs'; import { ownedFixture } from ${JSON.stringify(owner)}; import { finalizeFixtureDiagnostics } from ${JSON.stringify(helper)};\nconst gate=Promise.withResolvers(); test('controlled late producer',{timeout:30},async(t)=>{const keep=setInterval(()=>{},1000);ownedFixture(t).remove(()=>{try{const result=finalizeFixtureDiagnostics(${JSON.stringify(fx.registration)},t.signal);if(result.canRemove)fs.rmSync(${JSON.stringify(fx.fixtureRoot)},{recursive:true,force:true});fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({canRemove:result.canRemove}));}finally{gate.resolve();}});await gate.promise;try{fs.writeFileSync(${JSON.stringify(fx.reportFile)},${JSON.stringify(JSON.stringify(fx.report))});}finally{clearInterval(keep);}});\n`,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const result = spawnSync(process.execPath, ['--test', child], {
    encoding: 'utf8',
    windowsHide: true,
    env,
    timeout: 10000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(proof)).canRemove, false);
  assert.equal(fs.existsSync(fx.fixtureRoot), true);
  const recovered = recoverFixtureDiagnostics(fx.registration);
  fs.rmSync(fx.fixtureRoot, { recursive: true, force: true });
  const [diagnostic] = diagnostics(recovered.files);
  assert.equal(diagnostic.complete, true);
  assert.equal(diagnostic.reportWritten, true);
  assert.equal(diagnostic.report.applied, 3);
  assert.equal(JSON.stringify(diagnostic).includes(privateMarker), false);
});
