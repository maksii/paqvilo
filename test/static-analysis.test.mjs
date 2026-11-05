// @test-kind contract: Paqvilo-owned deterministic offline analysis, bounded coverage and record locations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDirSync } from './fixture.mjs';
import { analyzeProject, analysisRules, validateAnalysisPolicy } from '../lense/analysis/index.mjs';
import { ANALYSIS_LIMITS, collectAnalysisSources } from '../lense/analysis/inventory.mjs';

function project(t, files = {}) {
  const root = tempDirSync('paq-analysis-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return root;
}

function component(type, content, metadata = '') {
  return `<powerpagecomponent powerpagecomponentid="00000000-0000-0000-0000-000000000001">\n<powerpagecomponenttype>${type}</powerpagecomponenttype>\n${metadata}\n<content><![CDATA[${JSON.stringify(content)}]]></content>\n</powerpagecomponent>`;
}

test('analysis exposes stable rule identities and validates every failure threshold', (t) => {
  const root = project(t, { 'body.html': '<img>' });
  assert.equal(new Set(analysisRules.map(({ id }) => id)).size, analysisRules.length);
  for (const value of ['none', 'error', 'warning', 'hint']) assert.equal(validateAnalysisPolicy(value), value);
  for (const value of ['', 'ERROR', 'false', null, undefined, {}, '__proto__']) {
    assert.throws(() => validateAnalysisPolicy(value), /--fail-on/);
  }
  assert.equal(analyzeProject(root, { failOn: 'error' }).ready, true);
  assert.equal(analyzeProject(root, { failOn: 'hint' }).ready, false);
  assert.equal(analyzeProject(root, { failOn: 'none' }).ready, true);
  const sources = analyzeProject(root).sources;
  for (const source of sources) assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.ok(sources.some((source) => source.repository === 'microsoft/power-cat-skills'));
  assert.ok(sources.some((source) => source.repository === 'microsoft/power-platform-skills'));
});

test('analysis limits reject unbounded, unknown and invalid caller values', (t) => {
  const root = project(t, { 'body.html': '<p>review</p>' });
  assert.deepEqual(analyzeProject(root).coverage.limits, ANALYSIS_LIMITS);
  for (const key of Object.keys(ANALYSIS_LIMITS)) {
    for (const value of [0, -1, 0.5, NaN, Infinity, '1', null, ANALYSIS_LIMITS[key] + 1]) {
      assert.throws(() => analyzeProject(root, { limits: { [key]: value } }), /Invalid static analysis limit/);
    }
    assert.equal(analyzeProject(root, { limits: { [key]: 1 } }).coverage.limits[key], 1);
  }
  assert.throws(() => analyzeProject(root, { limits: { unexpected: 1 } }), /Invalid static analysis limit/);
});

test('empty and unsupported source trees cannot produce a complete clean assessment', (t) => {
  for (const files of [{}, { 'export.json': '{"unknownExport":true}' }]) {
    const report = analyzeProject(project(t, files));
    assert.equal(report.complete, false);
    assert.equal(report.ready, false);
    assert.equal(report.coverage.files, 0);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.coverage.skipped, [{ file: '.', reason: 'no-supported-sources' }]);
  }
});

test('repeated review has deterministic identities, canonical relative locations and source digest', (t) => {
  const root = project(t, { 'b.html': '<p>text</p>\n<img>', 'a.html': '<img>\n<img alt="">' });
  const first = analyzeProject(root);
  assert.deepEqual(analyzeProject(root), first);
  assert.equal(first.complete, true);
  assert.deepEqual(
    first.findings.map(({ file, line, column }) => ({ file, line, column })),
    [
      { file: 'a.html', line: 1, column: 1 },
      { file: 'b.html', line: 2, column: 1 },
    ],
  );
  assert.ok(first.findings.every(({ id }) => /^[a-f0-9]{24}$/.test(id)));
  assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(root, 'b.html'), '<p>changed</p>\n<img>');
  const changed = analyzeProject(root);
  assert.notEqual(changed.sourceDigest, first.sourceDigest);
  assert.deepEqual(changed.findings, first.findings);
});

// @test-kind security: local analysis excludes discovery/dependency state and never executes project code.
test('source digest and byte budgets bind original bytes even when UTF-8 decoding is lossy', (t) => {
  const root = project(t, { 'body.html': Buffer.from([0xff]) });
  const first = analyzeProject(root);
  fs.writeFileSync(path.join(root, 'body.html'), Buffer.from([0xfe]));
  const second = analyzeProject(root);
  assert.notEqual(first.sourceDigest, second.sourceDigest);
  assert.equal(first.coverage.bytes, 1);
  assert.equal(second.coverage.bytes, 1);
});

test('hidden state, deployment profiles and dependencies are excluded while code sites are inventoried', (t) => {
  const secret = 'analysis-canary-private-discovery-value';
  const root = project(t, {
    '.paqvilo/discovery.json': secret,
    '.paqvilo/poison.sitesetting.yml': '[ malformed',
    '.git/poison.html': '<img>',
    'node_modules/package/poison.html': '<img>',
    'deployment-profiles/poison.sitesetting.yml': '[ malformed',
    '.powerpages-site/body.html': '<img>',
    'project.mjs': 'throw new Error("analysis must never execute project modules");',
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, true);
  assert.equal(report.coverage.files, 2);
  assert.deepEqual(
    report.findings.map(({ file }) => file),
    ['.powerpages-site/body.html'],
  );
  assert.equal(JSON.stringify(report).includes(secret), false);
  fs.writeFileSync(path.join(root, '.paqvilo/discovery.json'), 'different secret');
  assert.deepEqual(analyzeProject(root), report);
});

// @test-kind security: symbolic links never expose files or names outside the selected source root.
test('directory junctions are skipped without reading or listing their targets', (t) => {
  const outside = project(t, { 'outside-private-name.html': '<img>' });
  const root = project(t, { 'inside.html': '<img alt="">' });
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = analyzeProject(root);
  assert.equal(report.complete, false);
  assert.equal(report.ready, false);
  assert.equal(report.coverage.files, 1);
  assert.deepEqual(report.coverage.skipped, [{ file: 'linked', reason: 'symbolic-link' }]);
  assert.equal(JSON.stringify(report).includes('outside-private-name'), false);
  assert.deepEqual(report.findings, []);
});

// @test-kind security: revalidate queued directory identity after opening before enumerating names.
test('a directory replaced at the open boundary cannot reveal an external inventory', (t) => {
  const outside = project(t, { 'outside-private-name.html': '<img>' });
  const root = project(t, { 'queued/inside.html': '<img alt="">' });
  const queued = path.join(root, 'queued');
  const open = fs.opendirSync;
  let swapped = false;
  t.mock.method(fs, 'opendirSync', function (directory, ...options) {
    if (directory === queued && !swapped) {
      fs.renameSync(queued, path.join(root, '.original'));
      fs.symlinkSync(outside, queued, process.platform === 'win32' ? 'junction' : 'dir');
      swapped = true;
    }
    return Reflect.apply(open, fs, [directory, ...options]);
  });
  const report = analyzeProject(root);
  assert.equal(swapped, true);
  assert.equal(report.complete, false);
  assert.equal(report.ready, false);
  assert.equal(report.coverage.files, 0);
  assert.equal(JSON.stringify(report).includes('outside-private-name'), false);
  assert.deepEqual(report.coverage.skipped, [
    { file: 'queued', reason: 'unreadable-directory' },
    { file: '.', reason: 'no-supported-sources' },
  ]);
});

// @test-kind security: parser failures must not copy source values into JSON diagnostics.
test('invalid YAML and enhanced JSON report incomplete analysis without echoing parser source', (t) => {
  const canary = 'analysis-canary-do-not-log-this-secret';
  const root = project(t, {
    'invalid.sitesetting.yml': `adx_name: Invalid\nadx_value: [${canary}\n`,
    'powerpagecomponent.xml': `<powerpagecomponent><powerpagecomponenttype>9</powerpagecomponenttype><content>{"value":"${canary}"</content></powerpagecomponent>`,
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, false);
  assert.equal(report.ready, false);
  assert.equal(report.findings.length, 2);
  assert.ok(report.findings.every(({ ruleId }) => ruleId === 'PAQ-SOURCE-001'));
  assert.equal(JSON.stringify(report).includes(canary), false);
  assert.deepEqual(report.coverage.notPerformed.includes('live-authorization'), true);
});

// @test-kind security: secret-bearing settings produce fixed messages, never values or source excerpts.
test('literal secrets and unresolved environment values remain absent from findings', (t) => {
  const canary = 'analysis-canary-inline-provider-secret';
  const root = project(t, {
    'secret.sitesetting.yml': `adx_name: Authentication/OpenIdConnect/Example/ClientSecret\nadx_value: ${canary}\nadx_sitesettingid: ${canary}\n`,
    'env.sitesetting.yml': 'adx_name: Webapi/error/innererror\nadx_value: true\nadx_source: 1\n',
  });
  const report = analyzeProject(root);
  assert.ok(report.findings.some(({ ruleId }) => ruleId === 'PP-SEC-003'));
  assert.equal(
    report.findings.some(({ ruleId }) => ruleId === 'PP-SEC-001'),
    false,
  );
  assert.equal(JSON.stringify(report).includes(canary), false);
});

test('aggregate YAML records keep distinct canonical field locations and duplicate settings unresolved', (t) => {
  const root = project(t, {
    'sitesetting.yml':
      '- adx_name: Webapi/error/innererror\n  adx_value: false\n- adx_name: Site/EnableDefaultHtmlEncoding\n  adx_value: false\n- adx_name: Webapi/error/innererror\n  adx_value: true\n',
  });
  const inventory = collectAnalysisSources(root);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.records.length, 3);
  assert.deepEqual(
    inventory.records.map(({ fieldLocations }) => fieldLocations.value),
    [
      { line: 2, column: 3 },
      { line: 4, column: 3 },
      { line: 6, column: 3 },
    ],
  );
  const report = analyzeProject(root);
  assert.ok(report.findings.some(({ ruleId }) => ruleId === 'PP-CONFIG-001'));
  assert.equal(
    report.findings.some(({ ruleId }) => ruleId === 'PP-SEC-001'),
    false,
  );
  const encoding = report.findings.find(({ ruleId }) => ruleId === 'PP-SEC-002');
  assert.equal(encoding.file, 'sitesetting.yml');
  assert.equal(encoding.line, 4);
  assert.equal(encoding.column, 3);
  assert.equal(encoding.exactLocation, true);
});

test('the same setting name on explicitly different sites is not a duplicate', (t) => {
  const root = project(t, {
    'sitesetting.yml':
      '- adx_name: Webapi/error/innererror\n  adx_value: true\n  adx_websiteid: 11111111-1111-1111-1111-111111111111\n- mspp_name: Webapi/error/innererror\n  mspp_value: false\n  mspp_websiteid: 22222222-2222-2222-2222-222222222222\n',
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.findings.map(({ ruleId }) => ruleId),
    ['PP-SEC-001'],
  );
});

test('enhanced XML retains top-level identity, name and active state with short content fields', (t) => {
  const root = project(t, {
    'active/powerpagecomponent.xml': component(
      9,
      { value: 'true' },
      '<name>Webapi/error/innererror</name>\n<statecode>0</statecode>',
    ),
    'inactive/powerpagecomponent.xml': component(
      9,
      { value: 'false' },
      '<name>Site/EnableDefaultHtmlEncoding</name>\n<statecode>1</statecode>',
    ),
    'template/powerpagecomponent.xml': component(8, { source: '<img>' }, '<name>Invented template</name>'),
  });
  const inventory = collectAnalysisSources(root);
  const active = inventory.records.find(({ file }) => file.startsWith('active/'));
  assert.equal(active.fields.name, 'Webapi/error/innererror');
  assert.equal(String(active.fields.statecode), '0');
  assert.equal(active.fields.id, '00000000-0000-0000-0000-000000000001');
  const report = analyzeProject(root);
  assert.ok(report.findings.some(({ ruleId }) => ruleId === 'PP-SEC-001'));
  assert.equal(
    report.findings.some(({ ruleId }) => ruleId === 'PP-SEC-002'),
    false,
  );
  const image = report.findings.find(({ ruleId }) => ruleId === 'content.image-alt');
  assert.equal(image.file, 'template/powerpagecomponent.xml');
  assert.equal(image.field, 'source');
  assert.equal(image.exactLocation, false);
  assert.equal(image.recordId, '00000000-0000-0000-0000-000000000001');
});

// @test-kind security: component envelope metadata cannot come from comments or CDATA content and masking cannot synthesize tags
test('enhanced metadata uses real envelope elements without deleting or interpreting literal sections', (t) => {
  const root = project(t, {
    'powerpagecomponents/one/powerpagecomponent.xml': component(
      9,
      { value: '*' },
      '<!-- <name>Webapi/sample/fields</name> --><name><![CDATA[Safe/<name>Webapi/sample/fields</name>]]></name>',
    ),
    'powerpagecomponents/two/powerpagecomponent.xml': component(
      8,
      { source: '<powerpagecomponenttype>9</powerpagecomponenttype><name>Webapi/sample/fields</name>' },
      '<name>Template</name>',
    ),
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, true);
  assert.equal(report.counts.error, 0);
  assert.ok(!report.findings.some((finding) => finding.ruleId.startsWith('PP-API-')));
});

// @test-kind security: ambiguous or malformed envelope metadata cannot establish configuration facts; future component choices remain explicitly unsupported
test('ambiguous enhanced envelope fields fail closed while unknown component types remain unsupported', (t) => {
  for (const metadata of ['<name>One</name><name>Two</name>', '<name>One</statecode>']) {
    const root = project(t, {
      'powerpagecomponents/one/powerpagecomponent.xml': component(9, { value: '*' }, metadata),
    });
    const report = analyzeProject(root);
    assert.equal(report.ready, false);
    assert.equal(report.complete, false);
    assert.ok(report.findings.some((finding) => finding.ruleId === 'PAQ-SOURCE-001'));
    assert.ok(!report.findings.some((finding) => finding.ruleId.startsWith('PP-API-')));
  }
  const future = analyzeProject(
    project(t, { 'powerpagecomponents/future/powerpagecomponent.xml': component(999, {}) }),
  );
  assert.equal(future.complete, false);
  assert.deepEqual(future.findings, []);
  assert.deepEqual(future.coverage.skipped, [
    { file: 'powerpagecomponents/future/powerpagecomponent.xml', reason: 'unsupported-component-type' },
  ]);
});

test('YAML aliases and non-record sequences cannot silently count as complete metadata', (t) => {
  const root = project(t, {
    'alias.sitesetting.yml': 'adx_name: &name Webapi/error/innererror\nadx_value: *name\n',
    'scalar.webrole.yml': '- not-a-record\n',
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, false);
  assert.equal(report.ready, false);
  assert.equal(report.coverage.skipped.length, 2);
  assert.deepEqual(report.findings, []);
  assert.equal(analyzeProject(root, { failOn: 'none' }).ready, true);
});

test('sidecar content supersedes an embedded copy without duplicate findings', (t) => {
  const root = project(t, {
    'example.webtemplate.yml': 'adx_name: Example\nadx_source: "<img>"\n',
    'example.webtemplate.source.html': '<img>',
  });
  const report = analyzeProject(root);
  assert.equal(report.coverage.contentUnits, 1);
  assert.deepEqual(
    report.findings.map(({ file }) => file),
    ['example.webtemplate.source.html'],
  );
});

test('canonical field collisions cannot silently choose a setting value', (t) => {
  const root = project(t, {
    'collision.sitesetting.yml': 'adx_name: Webapi/error/innererror\nadx_value: false\nmspp_value: true\n',
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, false);
  assert.equal(report.ready, false);
  assert.equal(
    report.findings.some(({ ruleId }) => ruleId === 'PP-SEC-001'),
    false,
  );
  assert.deepEqual(report.coverage.skipped, [
    { file: 'collision.sitesetting.yml', reason: 'unreadable-or-unsupported-source' },
  ]);
});

test('record and embedded-unit budgets also bound aggregate metadata files', (t) => {
  const records = project(t, {
    'sitesetting.yml': '- adx_name: Invented/One\n  adx_value: one\n- adx_name: Invented/Two\n  adx_value: two\n',
  });
  const aggregate = analyzeProject(records, { limits: { files: 1 } });
  assert.equal(aggregate.coverage.records, 1);
  assert.equal(aggregate.complete, false);
  assert.ok(aggregate.coverage.skipped.some(({ reason }) => reason === 'record-count-limit'));
  const content = project(t, { 'page.webpage.yml': 'adx_copy: "<img>"\nadx_summary: "<img>"\n' });
  const embedded = analyzeProject(content, { limits: { files: 1 } });
  assert.equal(embedded.coverage.contentUnits, 1);
  assert.equal(embedded.complete, false);
  assert.ok(embedded.coverage.skipped.some(({ reason }) => reason === 'content-unit-limit'));
});

test('file and byte budgets leave explicit incomplete coverage instead of a clean assessment', (t) => {
  const root = project(t, { 'a.html': '<img alt="">', 'b.html': '<img alt="">' });
  const files = analyzeProject(root, { limits: { files: 1 } });
  assert.equal(files.coverage.files, 1);
  assert.equal(files.complete, false);
  assert.equal(files.ready, false);
  assert.ok(files.coverage.skipped.some(({ reason }) => reason === 'file-count-limit'));
  const oversized = analyzeProject(root, { limits: { fileBytes: 1 } });
  assert.equal(oversized.coverage.files, 0);
  assert.equal(oversized.complete, false);
  assert.deepEqual(oversized.coverage.skipped, [
    { file: 'a.html', reason: 'file-size-limit' },
    { file: 'b.html', reason: 'file-size-limit' },
    { file: '.', reason: 'no-supported-sources' },
  ]);
  const total = analyzeProject(root, { limits: { totalBytes: 13 } });
  assert.equal(total.coverage.files, 1);
  assert.equal(total.complete, false);
  assert.ok(total.coverage.skipped.some(({ reason }) => reason === 'total-size-limit'));
});

test('entry, directory and finding budgets cap work and disclose truncation', (t) => {
  const root = project(t, { 'a/body.html': '<img>', 'b/body.html': '<img>', 'c/body.html': '<img>' });
  const entries = analyzeProject(root, { limits: { entries: 1 } });
  assert.equal(entries.complete, false);
  assert.ok(entries.coverage.entries <= 2);
  assert.ok(entries.coverage.skipped.some(({ reason }) => reason === 'entry-count-limit'));
  const directories = analyzeProject(root, { limits: { directories: 1 } });
  assert.equal(directories.complete, false);
  assert.equal(directories.coverage.files, 0);
  assert.ok(directories.coverage.skipped.some(({ reason }) => reason === 'directory-limit'));
  const manyFindings = project(t, { 'body.html': '<img>\n<img>\n<img>' });
  const findings = analyzeProject(manyFindings, { limits: { files: 1 } });
  assert.equal(findings.findings.length, 1);
  assert.equal(findings.coverage.findingsTruncated, true);
  assert.equal(findings.complete, false);
  assert.equal(findings.ready, false);
});
